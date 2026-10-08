/**
 * Operator-change admission: the framework resolves each of its own operator
 * mutations to an absolute change and hands it to the host's gate
 * (FrameworkConfig.operatorChangeGate), which stages it and answers with a
 * receipt. Nothing mutates then. There is one way to apply a staged change:
 * AgentFramework.applyResolvedOperatorChange, under a held safe-boundary
 * lease, whenever the host finds it eligible.
 *
 * A change is resolved once. Application revalidates it against stable
 * identity (the active branch, the settings it was resolved from) and
 * applies exactly what was resolved, never the relative command again: a
 * change that no longer holds is refused as `stale` and the host restages it.
 */
import type { OperatorRequester, SurgeryMarkerReceipt } from './operator-log.js';

/** The host's receipt for a staged change, shown to whoever asked: the
 *  change is accepted and queued, not applied. */
export interface OperatorChangeReceipt {
  id: string;
  text: string;
}

/** Settings an agent_settings action touches, by snapshot key. null = unset. */
export type RuntimeSettingsValues = Partial<
  Record<'contextBudgetTokens' | 'tailTokens' | 'transitionPaceTokens' | 'sameRoundThinkTextPolicy', number | string | null>
>;

interface ResolvedOperatorChangeBase {
  /** The framework's id for this resolution. */
  id: string;
  agent: string;
  /** Where the change came from: an operator's host/command, an operator
   *  acting through the agent's own tools (puppet), or a module. */
  surface: 'host-command' | 'puppet' | 'host';
  requester?: OperatorRequester;
  /** Epoch ms. */
  resolvedAt: number;
  /** The active branch when resolved: the stable identity application
   *  checks. Appending messages (a notice, an answer) doesn't change it. */
  sourceBranch: string;
  /** The store it was resolved in (AgentFramework's store identity). Branch
   *  names and message ids mean something only within one store, so a
   *  change is refused anywhere else, a replacement store included. */
  storeId: string;
}

/** agent_settings update / reset / cancel, from an operator or a module. */
export interface ResolvedSettingsChange extends ResolvedOperatorChangeBase {
  kind: 'agent-settings';
  /** The agent_settings input as given. */
  input: Record<string, unknown>;
  /** The touched core settings when resolved (getRuntimeSettings). */
  from: RuntimeSettingsValues;
  /** The concrete values the action leaves them at (Agent.previewRuntimeSettingsTarget).
   *  Application applies the action only if it still produces exactly these. */
  target: RuntimeSettingsValues;
  /** Host-managed (extension) keys the input touches: their values when
   *  resolved, and the values the change leaves them at, from each owner's
   *  preview (AgentSettingsExtension.preview). Application checks both. */
  extensions?: { from: Record<string, unknown>; target: Record<string, unknown> };
}

/** set_tool_visibility / set_tool_description, from an operator or a module. */
export interface ResolvedPresentationChange extends ResolvedOperatorChangeBase {
  kind: 'tool-presentation';
  tool: 'set_tool_visibility' | 'set_tool_description';
  input: Record<string, unknown>;
  /** The targeted tool's presentation entry when resolved. */
  from: { name: string; visible: boolean; description: string };
  /** The entry as the edit leaves it, resolved at staging exactly as the
   *  presentation resolves (ToolPresentation.previewEdit): a description
   *  reset shows the wording it exposes, the component default or else the
   *  installed description. Application applies the edit only if it still
   *  leaves exactly this. */
  target: { name: string; visible: boolean; description: string };
}

/** host/command undo by turns: the exact turn checkpoints it undoes. */
export interface ResolvedUndoTurnsChange extends ResolvedOperatorChangeBase {
  kind: 'undo-turns';
  /** Turns asked for. `checkpoints` holds fewer when history is shorter. */
  requestedTurns: number;
  /** The checkpoints it undoes, newest first. Application makes one cut at
   *  the oldest one's sequenceBefore, onto a branch named for this change. */
  checkpoints: Array<{ turnIndex: number; sequenceBefore: number; branchName: string }>;
  /** How many messages followed the cut point when the change was resolved
   *  (staged). The cut also removes what arrives later, so the applied
   *  receipt's `messagesRemoved` minus this is how many arrived after it was
   *  staged, less any of these removed in place meanwhile (by a hide or an
   *  unstick step, for instance). */
  messagesAfter: number;
  /** The operator's awareness-marks choice, frozen at staging to the refs
   *  the cut would have removed then. The cut can also reach messages that
   *  arrive later; application marks only the frozen refs it actually
   *  removed, reports later removals as unmarked, and never widens the set. */
  marks: FrozenMarks;
  /** The MCPL server the command came from: marks whose message names no
   *  server are routed through it. */
  serverId?: string;
}

/**
 * host/command unstick, planned in full at staging: exchanges shed
 * newest-first, one per step, re-running the agent after each, until it
 * stops refusing or the plan is spent. The plan walks back from the tail as
 * it stood at staging and names every exchange that may go, so whoever is
 * asked approves a known range; nothing that arrives later is ever chosen.
 * The host drives it: applyResolvedOperatorChange per step under a lease,
 * rerunUnstick between steps outside any lease. AF keeps the durable record
 * (getUnstickOperation) in a store-bound, branch-independent journal.
 */
export interface ResolvedUnstickChange extends ResolvedOperatorChangeBase {
  kind: 'unstick';
  /** The operator's cap (1 to 10); `plan` is shorter when history runs out. */
  cap: number;
  /** Step k sheds exactly plan[k-1]'s messages, newest exchange first. Each
   *  message carries a fingerprint of its content, so an edit in place
   *  makes the step stale rather than shedding something not approved. */
  plan: Array<{ step: number; messageIds: string[]; fingerprints: string[] }>;
}

/** An operator's awareness-marks choice frozen at staging: 'none', or a
 *  scope with exactly the refs the change would have removed then. With
 *  refs, staging records the choice in the awareness journal (a staged
 *  batch), whose position is its authorization for life. */
export type FrozenMarks =
  | 'none'
  | { scope: 'addressed' | 'all'; refs: Array<{ serverId: string; channelId: string; messageId: string }> };

/** host/command hide: a redaction in place, on the source branch. */
export interface ResolvedHideChange extends ResolvedOperatorChangeBase {
  kind: 'hide';
  /** The Discord message ids the operator named. */
  fromMessageId: string;
  toMessageId?: string;
  /** The messages it hides, oldest first: exactly these, each only while
   *  its content is unchanged. */
  messages: Array<{ id: string; fingerprint: string }>;
  /** Frozen to the refs among those messages. */
  marks: FrozenMarks;
  /** The MCPL server the command came from (marks without a server route there). */
  serverId?: string;
}

/** host/command undo by messages: a branch cut at the message that becomes
 *  the tail. Like undo-turns, the cut also takes messages that arrive after
 *  staging; marks cover only the refs frozen here. */
export interface ResolvedUndoMessagesChange extends ResolvedOperatorChangeBase {
  kind: 'undo-messages';
  requestedMessages: number;
  /** The message that becomes the tail (the end of its body group), with its
   *  content fingerprint. */
  tail: { id: string; fingerprint: string };
  /** How many messages followed the tail when the change was resolved
   *  (staged). The cut also removes what arrives later, so the applied
   *  receipt's `messagesRemoved` minus this is how many arrived after it was
   *  staged, less any of these removed in place meanwhile (by a hide or an
   *  unstick step, for instance). */
  messagesAfter: number;
  /** Frozen to the refs among the messages that followed it at staging. */
  marks: FrozenMarks;
  /** The MCPL server the command came from (marks without a server route there). */
  serverId?: string;
}

export type ResolvedOperatorChange =
  | ResolvedSettingsChange
  | ResolvedPresentationChange
  | ResolvedUndoTurnsChange
  | ResolvedUnstickChange
  | ResolvedHideChange
  | ResolvedUndoMessagesChange;

/** What one application attempt's body change will do, captured under its
 *  lease before the change. A committed attempt's outcome is established
 *  from exactly this, never by rereading a branch later. */
export interface OperatorChangeEvidence {
  /** The branch the body lands on: a cut's destination, or the hidden
   *  messages' own branch. A cut's destination is created by its attempt
   *  alone (a name that already exists is refused before it begins). */
  target: string;
  /** The branch the change was resolved on. */
  source: string;
  /** The source branch's head when the attempt began. */
  sourceHead: number;
  /** A hide's exact messages, with their fingerprints. */
  ids?: Array<{ id: string; fingerprint: string }>;
  /** Messages the body change removes. */
  removed: number;
  /** Its marks facts: the frozen refs it removes (`refs`), the addressable
   *  removals it leaves unmarked, and the frozen refs it doesn't remove. */
  marks: { scope: 'none' | 'addressed' | 'all'; refs: Array<{ serverId: string; channelId: string; messageId: string }>; unmarked: number; notRemoved: number };
  /** Whether staging recorded a publication choice to activate. */
  staged: boolean;
  requester?: OperatorRequester;
}

/** A gated body change's established outcome: recorded once, immutable. */
export interface OperatorChangeOutcome {
  /** The attempt it established. */
  n: number;
  at: number;
  removed: number;
  /** The awareness receipt: the staged choice's activation, or none. */
  markers: SurgeryMarkerReceipt;
}

/** The body record of one gated operator change (journal operator/changes). */
export interface OperatorChangeRecord {
  changeId: string;
  kind: ResolvedOperatorChange['kind'];
  agent: string;
  /** Application attempts, in order, each with its evidence. `failed` is set
   *  (with the error) when the framework saw the attempt fail. `resolution`
   *  is an operator's attestation about an attempt whose result was never
   *  recorded: kept as such, never made to look like a framework record. */
  attempts: Array<{
    n: number;
    at: number;
    evidence: OperatorChangeEvidence;
    failed?: string;
    resolution?: OperatorChangeResolution;
  }>;
  /** The attempt whose cut switched to its destination: recorded right
   *  after the switch, so it proves the cut whatever is active later. */
  switched?: number;
  outcome?: OperatorChangeOutcome;
  /** Its bookkeeping (the operator-log record) is done. */
  completed?: true;
  /** The host dropped it before it applied; its staged choice was discarded. */
  dropped?: { at: number };
  /** Read-time only, never journaled: the latest attempt has neither its
   *  switch nor its failure recorded (and this process didn't see it), so
   *  whether it applied is unknown, whatever its destination's state. It is
   *  held until resolveOperatorChange records an operator's verdict. */
  unresolved?: { n: number; target: string };
}

/** One step of an unstick operation, as journaled: `intent` before its shed
 *  (with exactly what it will remove), `shed` once it is done. */
export interface UnstickStepRecord {
  step: number;
  status: 'intent' | 'shed';
  messageIds: string[];
}

/** One re-run of an unstick operation, as journaled. `launched` is written
 *  durably before the inference is queued. An attempt still `launched` when
 *  no process is running it was interrupted: its outcome is unknown, and it
 *  is never relaunched. */
export interface UnstickAttemptRecord {
  step: number;
  status: 'launched' | 'completed';
  outcome?: 'responded' | 'refused' | 'failed';
  category?: string;
  error?: string;
}

/** The durable record of an unstick operation (getUnstickOperation). */
export interface UnstickOperationRecord {
  operationId: string;
  agent: string;
  steps: UnstickStepRecord[];
  attempts: UnstickAttemptRecord[];
}

/** What rerunUnstick reports for a step's attempt. `interrupted`: launched,
 *  but no outcome was recorded and no process is running it; it may not have
 *  started, or may have finished without a receipt. */
export type UnstickAttemptOutcome =
  | { step: number; status: 'completed'; outcome: 'responded' | 'refused' | 'failed'; category?: string; error?: string }
  | { step: number; status: 'interrupted' };

/** What applyResolvedOperatorChange did. */
export type AppliedOperatorChange =
  | { kind: 'agent-settings'; result: unknown }
  | { kind: 'tool-presentation'; result: unknown }
  | {
      kind: 'hide';
      /** Messages its established outcome removed. */
      hidden: number;
      /** Established earlier: nothing was removed by this call. */
      alreadyApplied?: true;
      markers: SurgeryMarkerReceipt;
    }
  | {
      kind: 'undo-messages';
      requested: number;
      /** Messages the cut removed, later arrivals included (compare the
       *  change's `messagesAfter`). */
      messagesRemoved: number;
      fromBranch: string;
      toBranch: string;
      alreadyApplied?: true;
      markers: SurgeryMarkerReceipt;
    }
  | {
      kind: 'undo-turns';
      requested: number;
      undone: number;
      /** Messages the cut removed, later arrivals included (compare the
       *  change's `messagesAfter`). */
      messagesRemoved: number;
      fromBranch: string;
      toBranch: string;
      /** The cut had already been applied (the active branch is its
       *  destination): nothing changed this time. */
      alreadyApplied?: true;
      /** The awareness receipt of its established outcome. */
      markers: SurgeryMarkerReceipt;
    }
  | {
      kind: 'unstick';
      step: number;
      /** What this step removed (its planned exchange). */
      shedIds: string[];
      /** The step was already journaled as shed: nothing changed this time. */
      alreadyApplied?: true;
    };

/** The self-change kind a tool call is, when it mutates the agent's own body:
 *  agent_settings update/reset/cancel, or a tool-presentation edit. */
export function selfChangeKind(tool: string, input: unknown): 'agent-settings' | 'tool-presentation' | null {
  if (tool === 'agent_settings') {
    const action = (input as { action?: unknown } | null | undefined)?.action;
    return action === 'update' || action === 'reset' || action === 'cancel' ? 'agent-settings' : null;
  }
  if (tool === 'set_tool_visibility' || tool === 'set_tool_description') return 'tool-presentation';
  return null;
}

/** Order-independent structural equality for tool inputs and settings values. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}


/** An operator's verdict on one attempt whose result was never recorded:
 *  `committed` attests that it applied; `not-committed` that it did not,
 *  abandoning it. Neither authorizes new work: a fresh attempt is the host's
 *  decision on its next retry. */
export interface OperatorChangeResolution {
  verdict: 'committed' | 'not-committed';
  reason: string;
  requester?: OperatorRequester;
  at: number;
  /** Given through a running framework under its lease, or with the host
   *  stopped through agent-framework-recover. */
  via: 'live' | 'offline';
}

/** An operator/changes journal entry. */
export type OperatorChangesEntry =
  | { kind: 'attempt'; changeId: string; changeKind: OperatorChangeRecord['kind']; agent: string; n: number; at: number; evidence: OperatorChangeEvidence }
  | { kind: 'switched'; changeId: string; n: number }
  | { kind: 'failed'; changeId: string; n: number; error: string }
  | { kind: 'resolved'; changeId: string; n: number; resolution: OperatorChangeResolution }
  | { kind: 'outcome'; changeId: string; outcome: OperatorChangeOutcome }
  | { kind: 'completed'; changeId: string }
  | { kind: 'dropped'; changeId: string; changeKind: OperatorChangeRecord['kind']; agent: string; at: number };
export type OperatorChangesSnapshot = Record<string, OperatorChangeRecord>;
export const OPERATOR_CHANGES_JOURNAL = 'operator/changes';

/** Fold one operator/changes entry in. An outcome, and an attempt's
 *  resolution, are immutable: the first recorded stands. */
export function reduceOperatorChangesEntry(records: Map<string, OperatorChangeRecord>, entry: OperatorChangesEntry): void {
  if (entry.kind === 'attempt' || entry.kind === 'dropped') {
    const record = records.get(entry.changeId)
      ?? { changeId: entry.changeId, kind: entry.changeKind, agent: entry.agent, attempts: [] };
    if (entry.kind === 'attempt') {
      if (!record.attempts.some((a) => a.n === entry.n)) record.attempts.push({ n: entry.n, at: entry.at, evidence: entry.evidence });
    } else {
      record.dropped ??= { at: entry.at };
    }
    records.set(entry.changeId, record);
    return;
  }
  const record = records.get(entry.changeId);
  if (!record) return;
  if (entry.kind === 'switched') record.switched = entry.n;
  else if (entry.kind === 'failed' || entry.kind === 'resolved') {
    const attempt = record.attempts.find((a) => a.n === entry.n);
    if (attempt && entry.kind === 'failed') attempt.failed ??= entry.error;
    if (attempt && entry.kind === 'resolved') attempt.resolution ??= entry.resolution;
  } else if (entry.kind === 'outcome') record.outcome ??= entry.outcome;
  else record.completed = true;
}

/**
 * What decides a cut attempt: a framework record (its switch, its failure),
 * an operator's resolution, or what the running process itself saw (`seen`).
 * Nothing else, so missing evidence is never read as success: an attempt
 * with none of these is `unresolved`, whatever its destination's state.
 */
export function cutAttemptDisposition(
  record: OperatorChangeRecord,
  attempt: OperatorChangeRecord['attempts'][number],
  seen?: 'committed' | 'failed',
): 'committed' | 'not-committed' | 'unresolved' {
  if (record.switched === attempt.n || attempt.resolution?.verdict === 'committed' || seen === 'committed') return 'committed';
  if (attempt.failed !== undefined || attempt.resolution?.verdict === 'not-committed' || seen === 'failed') return 'not-committed';
  return 'unresolved';
}

/** What resolveOperatorChange (or agent-framework-recover --operator-change
 *  resolve) did, step by step, and what remains. */
export interface OperatorChangeResolutionReceipt {
  changeId: string;
  attempt: number;
  /** The attestation as recorded. */
  recorded: OperatorChangeResolution;
  /** The source restored, when a not-committed attempt's destination was the
   *  active body and restoring it succeeded. A failed restoration is named
   *  in `remaining` instead. */
  restored?: string;
  /** When the change settles from here. */
  settlement: string;
  /** Anything this didn't repair. */
  remaining?: string;
}

/** What restoreOperatorChangeSource did: the source of an abandoned
 *  attempt whose destination was still the active body. */
export interface OperatorChangeRestorationReceipt {
  changeId: string;
  attempt: number;
  /** The source restored, when restoring it succeeded. */
  restored?: string;
  /** What still needs repair when it didn't: the destination stays active
   *  and traffic stays held. */
  remaining?: string;
}

const CHANGE_KINDS = new Set(['agent-settings', 'tool-presentation', 'undo-turns', 'unstick', 'hide', 'undo-messages']);
/** The kinds whose application is journaled as attempts: the cuts and hide. */
const CUT_KINDS = new Set(['undo-turns', 'undo-messages']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function malformed(what: string): never {
  throw new Error(`malformed operator/changes ${what}`);
}

/** An attempt's evidence, checked as its kind's recovery consumes it. */
function checkEvidence(e: unknown, where: string, kind: string): void {
  if (!isObject(e)) malformed(`${where}: evidence`);
  if (!isText(e.target) || !isText(e.source) || !isCount(e.sourceHead) || !isCount(e.removed) || typeof e.staged !== 'boolean') {
    malformed(`${where}: evidence fields`);
  }
  const marks = e.marks;
  if (!isObject(marks) || !['none', 'addressed', 'all'].includes(marks.scope as string) || !Array.isArray(marks.refs)
    || !isCount(marks.unmarked) || !isCount(marks.notRemoved)) malformed(`${where}: marks facts`);
  if (!marks.refs.every((r) => isObject(r) && isText(r.serverId) && isText(r.channelId) && isText(r.messageId))) {
    malformed(`${where}: a marks ref`);
  }
  if (kind === 'hide') {
    // Recovery removes exactly these: missing ids must never read as an
    // empty removal. (Empty is valid when none of them remained to hide.)
    if (!Array.isArray(e.ids) || !e.ids.every((i) => isObject(i) && isText(i.id) && isText(i.fingerprint))) {
      malformed(`${where}: a hide's ids`);
    }
    if (e.removed !== e.ids.length) malformed(`${where}: a hide removes exactly its ids`);
    if (e.target !== e.source) malformed(`${where}: a hide stays on its branch`);
  } else if (e.ids !== undefined) {
    malformed(`${where}: a cut records no hide ids`);
  }
}

function checkResolution(r: unknown, where: string): void {
  if (!isObject(r) || (r.verdict !== 'committed' && r.verdict !== 'not-committed') || !isText(r.reason) || !isCount(r.at)
    || (r.via !== 'live' && r.via !== 'offline')) malformed(`${where}: resolution`);
}

/** The awareness receipt an outcome hands back, by status. */
function checkMarkers(m: unknown, where: string): void {
  if (!isObject(m) || !['none', 'addressed', 'all'].includes(m.scope as string) || !isCount(m.unmarked) || !isCount(m.notRemoved)) {
    malformed(`${where}: markers facts`);
  }
  const ok = m.status === 'none' ? m.queued === 0
    : m.status === 'queued' ? isCount(m.queued) && isText(m.batchId)
    : m.status === 'not-scheduled' ? m.queued === 0 && typeof m.error === 'string'
    : m.status === 'unresolved' ? m.queued === 0 && isText(m.batchId) && typeof m.error === 'string'
    : false;
  if (!ok) malformed(`${where}: markers receipt`);
}

function checkOutcome(o: unknown, where: string): void {
  if (!isObject(o) || !isCount(o.n) || !isCount(o.at) || !isCount(o.removed)) malformed(`${where}: outcome`);
  checkMarkers(o.markers, `${where} outcome`);
}

/** A whole record, as reduced: its fields, each attempt's evidence by the
 *  record's kind, and its references to its own attempts. */
function checkRecord(r: unknown, id: string): asserts r is OperatorChangeRecord {
  const where = `record ${id}`;
  if (!isObject(r) || r.changeId !== id || !CHANGE_KINDS.has(r.kind as string) || !isText(r.agent) || !Array.isArray(r.attempts)) {
    malformed(where);
  }
  const kind = r.kind as string;
  if (r.attempts.length > 0 && !CUT_KINDS.has(kind) && kind !== 'hide') malformed(`${where}: a ${kind} records no attempts`);
  const ns = new Set<number>();
  for (const a of r.attempts) {
    if (!isObject(a) || !isCount(a.n) || !isCount(a.at) || ns.has(a.n)) malformed(`${where}: attempt`);
    ns.add(a.n);
    checkEvidence(a.evidence, `${where} attempt ${a.n}`, kind);
    if (a.failed !== undefined && typeof a.failed !== 'string') malformed(`${where} attempt ${a.n}: failed`);
    if (a.resolution !== undefined) {
      if (!CUT_KINDS.has(kind)) malformed(`${where} attempt ${a.n}: only a cut is resolved`);
      checkResolution(a.resolution, `${where} attempt ${a.n}`);
    }
  }
  if (r.switched !== undefined && !(CUT_KINDS.has(kind) && isCount(r.switched) && ns.has(r.switched))) malformed(`${where}: switched`);
  if (r.outcome !== undefined) {
    checkOutcome(r.outcome, where);
    if ((r.attempts.length > 0 || CUT_KINDS.has(kind) || kind === 'hide') && !ns.has((r.outcome as { n: number }).n)) {
      malformed(`${where}: its outcome names no attempt of its own`);
    }
  }
  if (r.completed !== undefined && r.completed !== true) malformed(`${where}: completed`);
  if (r.dropped !== undefined && !(isObject(r.dropped) && isCount(r.dropped.at))) malformed(`${where}: dropped`);
}

/** One entry, checked before it's folded in: its own shape, and that it
 *  refers to a change (and attempt) the ledger already holds. */
function checkEntry(e: unknown, records: Map<string, OperatorChangeRecord>): asserts e is OperatorChangesEntry {
  if (!isObject(e) || !isText(e.changeId)) malformed('entry');
  const where = `${String(e.kind)} entry for ${e.changeId}`;
  const record = records.get(e.changeId);
  const hasAttempt = (n: unknown) => !!record && record.attempts.some((a) => a.n === n);
  switch (e.kind) {
    case 'attempt':
      if (!(CUT_KINDS.has(e.changeKind as string) || e.changeKind === 'hide') || !isText(e.agent) || !isCount(e.n) || !isCount(e.at)) malformed(where);
      if (record && record.kind !== e.changeKind) malformed(`${where}: its kind differs from its change's`);
      checkEvidence(e.evidence, where, e.changeKind as string);
      return;
    case 'switched':
      if (!isCount(e.n) || !hasAttempt(e.n)) malformed(where);
      return;
    case 'failed':
      if (!isCount(e.n) || typeof e.error !== 'string' || !hasAttempt(e.n)) malformed(where);
      return;
    case 'resolved':
      if (!isCount(e.n) || !hasAttempt(e.n)) malformed(where);
      checkResolution(e.resolution, where);
      return;
    case 'outcome':
      if (!record) malformed(`${where}: no such change`);
      checkOutcome(e.outcome, where);
      return;
    case 'completed':
      if (!record) malformed(`${where}: no such change`);
      return;
    case 'dropped':
      if (!CHANGE_KINDS.has(e.changeKind as string) || !isText(e.agent) || !isCount(e.at)) malformed(where);
      if (record && record.kind !== e.changeKind) malformed(`${where}: its kind differs from its change's`);
      return;
    default:
      malformed(where);
  }
}

/**
 * Read an operator/changes journal into its records. Anything parseable that
 * can't be interpreted as this ledger is refused, exactly as unreadable
 * bytes are: a checkpoint whose snapshot isn't a record map (a null one
 * included, since it still covers the entries it skips), or a record or
 * entry missing what its kind requires.
 */
export function readOperatorChanges(load: { snapshot: unknown; entries: Array<{ entry: unknown }>; checkpointed: boolean }): Map<string, OperatorChangeRecord> {
  const records = new Map<string, OperatorChangeRecord>();
  if (load.checkpointed) {
    const snapshot = load.snapshot;
    if (!isObject(snapshot)) throw new Error('malformed operator/changes checkpoint: its snapshot is not a record map');
    for (const [id, record] of Object.entries(snapshot)) {
      checkRecord(record, id);
      records.set(id, structuredClone(record));
    }
  }
  for (const { entry } of load.entries) {
    checkEntry(entry, records);
    reduceOperatorChangesEntry(records, entry);
  }
  // The ledger as recovery will read it: every record whole, by its kind.
  for (const [id, record] of records) checkRecord(record, id);
  return records;
}
