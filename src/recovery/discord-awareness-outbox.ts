import { existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal, type AppendOptions } from '../record-journal.js';

/**
 * Discord awareness marks: a reaction (💤 by default) that an operator may
 * choose to place on Discord messages a surgery removed from a resident's
 * context, so the people who wrote them can see the resident no longer has
 * them in view.
 *
 * Marks are an explicit publication choice, separate from the surgery itself
 * (`DiscordAwarenessMarks`, default `none`). Once requested, they are
 * one-shot: branch moves and restarts never derive new operations from branch
 * state; an operator retracts, cancels or releases explicitly.
 *
 * The ledger is an append-only journal of what was asked and what was
 * answered, never a model of what is on Discord. Each operation is recorded
 * as `requested`, then `dispatching` (written before the request can leave),
 * then an outcome. A request that was dispatched and never answered stays
 * `unknown` for good: a later retry's confirmation does not resolve it, and a
 * later opposite operation discloses it.
 *
 * Operations are keyed by (MCPL server id, channel, message, emoji). The
 * server id is the configured route to a bot, not the bot's identity: if the
 * route is re-pointed at another bot, retained operations act as that bot,
 * and nothing here can detect it.
 *
 * The journal lives in the Chronicle store as typed records (RecordJournal):
 * it survives branch switches, rollbacks, `deleteBranch` and a killed
 * process, and lives and dies with its store. Each append is one record
 * holding a group of journal records that apply together. A record that
 * asserts a branch change (an activation after a switch or redaction, or a
 * batch recorded after an in-place change) is appended only after that
 * state is synced, so it can never outlive it.
 */

export const DEFAULT_DISCORD_AWARENESS_EMOJI = '💤';

/**
 * Bound text that came from elsewhere (a Discord error body, a filesystem
 * error) before it is journaled, logged or returned in a receipt: the journal
 * is kept for the store's life, and a server's error text has no length limit
 * of its own. Head and tail are kept, with the omitted length stated;
 * a cut never splits a surrogate pair.
 */
export function boundDiscordAwarenessText(text: string, max = 500): string {
  if (text.length <= max) return text;
  const tailLength = Math.min(100, Math.floor(max / 4));
  let head = text.slice(0, max - tailLength - 40);
  let tail = text.slice(text.length - tailLength);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head} … [${text.length - head.length - tail.length} chars omitted] … ${tail}`;
}

/**
 * Where a pre-journal awareness ledger (the JSON file earlier releases kept
 * under a store) is found, to import once.
 */
/**
 * A Discord answer that the reaction can never succeed: the message or
 * channel is gone or inaccessible. Retrying cannot help.
 */
export function isPermanentDiscordReactionFailure(message: string): boolean {
  return /unknown message|unknown channel|missing access|missing permissions|missing permission|cannot access|channel .* not found|message .* not found/i
    .test(message);
}

/** AF's own refusal to write a request on a closed connection. */
const PRE_WRITE_REFUSAL = /^Cannot send request:/;

export function defaultDiscordAwarenessOutboxPath(storePath: string): string {
  return join(storePath, 'recovery', LEGACY_LEDGER_NAME);
}

/** The pre-journal (version 1 and 2) ledger file name, imported once. */
const LEGACY_LEDGER_NAME = 'discord-awareness-outbox.json';

export interface DiscordAwarenessRef {
  serverId: string;
  channelId: string;
  messageId: string;
}

/** Which removed messages a publication choice covers. */
export type DiscordAwarenessScope = 'addressed' | 'all';

/**
 * An operator's publication choice for one surgery. `none`, the default,
 * keeps the surgery local. With `refs`, the choice authorizes exactly those
 * refs (as a preview showed them): the surgery marks only the ones it
 * actually removes, and never widens the set. Without `refs`, the scope is
 * evaluated when the surgery applies; that form is for an immediate act whose
 * choice and application are the same moment.
 */
export type DiscordAwarenessMarks =
  | 'none'
  | { scope: DiscordAwarenessScope; refs?: DiscordAwarenessRef[] };

export type DiscordAwarenessAction = 'add' | 'remove';

export interface DiscordSuppressionInterval {
  fromId: string;
  toId: string;
}

export interface DiscordAwarenessReleaseAction extends DiscordAwarenessRef {
  action: DiscordAwarenessAction;
  /** Earlier attempts recorded for this ref before it was held (legacy import). */
  priorAttempts?: number;
  /** The last error recorded for this ref before it was held, verbatim. */
  priorError?: string;
}

/** One surgery's request, as recorded when the surgery prepared it. */
export interface DiscordAwarenessBatchRecord {
  id: string;
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  /** `none` for a suppression journal with no marks; `legacy` for imports. */
  scope: 'none' | DiscordAwarenessScope | 'legacy';
  /** The refs this batch requests marks on (authorized ∩ removed). */
  refs: DiscordAwarenessRef[];
  /** Removed addressable messages this batch leaves unmarked. */
  unmarked?: number;
  /** Authorized refs the surgery did not remove. */
  notRemoved?: number;
  /**
   * `target-branch`: startup activates the batch only if its target is
   * exactly the active branch (the surgery crashed after switching).
   * `explicit`: only the surgery (or startup's resume of its intervals) does.
   */
  activationPolicy?: 'target-branch' | 'explicit';
  /** Idempotent interval operations used to resume an interrupted suppression. */
  suppressionIntervals?: DiscordSuppressionInterval[];
}

/** A surgery's request, as it prepares a batch. */
export interface DiscordAwarenessPrepareInput {
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  refs: DiscordAwarenessRef[];
  scope: DiscordAwarenessBatchRecord['scope'];
  emoji?: string;
  activationPolicy?: 'target-branch' | 'explicit';
  suppressionIntervals?: DiscordSuppressionInterval[];
  unmarked?: number;
  notRemoved?: number;
}

/**
 * What the journal will do with a batch whose body change has landed:
 * - `queued`: it is active, its requests recorded;
 * - `not-scheduled`: none of its marks will be sent (it was retired, or
 *   never recorded);
 * - `unresolved`: neither could be established; a later startup that can
 *   read the batch may activate it.
 */
export type DiscordAwarenessSettlement =
  | { status: 'queued'; queued: number }
  | { status: 'not-scheduled'; error: string }
  | { status: 'unresolved'; error: string };

export type DiscordAwarenessBatchStatus = 'prepared' | 'active' | 'held' | 'discarded';

export interface DiscordAwarenessBatch extends DiscordAwarenessBatchRecord {
  status: DiscordAwarenessBatchStatus;
  /** A suppression whose body is recorded complete (by its activation, or by
   *  a later startup's resume). */
  suppressionComplete?: boolean;
  /** Journal position of the surgery's marks choice (its prepare): the
   *  authorization of the adds its activation requests. */
  authorization?: number;
  /** Journal position of the operator's release: the authorization of the
   *  requests the release queues. */
  releaseAuthorization?: number;
  held?: { reason: string; at: number; releaseActions: DiscordAwarenessReleaseAction[] };
  cancelled?: { at: number; by?: string };
  released?: { at: number; by?: string };
}

export type DiscordAwarenessOutcome = 'confirmed' | 'failed' | 'not-sent' | 'unknown';

export interface DiscordAwarenessAttempt {
  attempt: number;
  /** One id per request on the wire; operations sharing a dispatch share it. */
  dispatchId?: string;
  dispatchedAt: number;
  /** Absent while the request is on the wire in this process. */
  outcome?: DiscordAwarenessOutcome;
  /** For `failed`: Discord's refusal is final for this request. */
  permanent?: boolean;
  outcomeAt?: number;
  error?: string;
}

export interface DiscordAwarenessOpCause {
  kind: 'batch' | 'retract' | 'release' | 'import';
  batchId?: string;
  requestId?: string;
}

export type DiscordAwarenessOpStatus =
  | 'requested'
  | 'dispatching'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export interface DiscordAwarenessOp {
  opId: string;
  key: DiscordAwarenessRef & { emoji: string };
  action: DiscordAwarenessAction;
  cause: DiscordAwarenessOpCause;
  /**
   * Journal position of the act that authorized this request: a surgery's
   * marks choice (its prepare, even when activation comes later), a retract,
   * or a release. Between opposite requests for one reaction, the later
   * authorization wins, whenever each request was created.
   */
  authorization: number;
  requestedAt: number;
  attempts: DiscordAwarenessAttempt[];
  cancelled?: { at: number; reason: 'batch-cancelled' | 'request-cancelled' | 'superseded' | 'imported' };
}

/** One dispatch: the head operation for a reaction key, plus any consecutive
 *  pending operations with the same action that share it. */
export interface DiscordAwarenessDispatch {
  key: DiscordAwarenessRef & { emoji: string };
  action: DiscordAwarenessAction;
  opIds: string[];
}

/** Receipt for cancel(). Nothing is ever removed from Discord by a cancel. */
export interface DiscordAwarenessCancelReceipt {
  /** The batch id or retract request id that was cancelled. */
  target: string;
  kind: 'batch' | 'retract';
  /** Requests that will now never be sent (for a batch not yet activated,
   *  every mark it would have requested). */
  cancelled: number;
  /** Held release actions dropped (a held batch was cancelled). */
  heldDropped: number;
  /** Operations on the wire right now: they may still land. */
  inFlight: number;
  /** Operations whose outcome is unknown: they may have landed. */
  unknown: number;
  /** Operations Discord already confirmed (cancel does not undo them). */
  confirmed: number;
  /** Requests of this batch or retract whose outcome is unresolved (on the
   *  wire or unknown), counted per request sent and including earlier
   *  attempts of operations whose last attempt was answered: any may land. */
  unresolvedAttempts: number;
  /** Imported (pre-journal) attempts on this batch whose outcome the old
   *  ledger does not establish: any may have landed. */
  legacyOutcomesUnrecorded: number;
}

/** Receipt for retract(). */
export interface DiscordAwarenessRetractReceipt {
  requestId: string;
  /** Removals queued: one per selected reaction key, whatever history says. */
  removalsQueued: number;
  /** Add requests for those keys that had not been sent, now superseded. */
  addsSuperseded: number;
  /** Keys whose earlier add attempts are unresolved (on the wire or unknown):
   *  such an add may land after this removal. */
  keysWithUnresolvedAdds: number;
  /** Unresolved earlier add requests on those keys (one per request sent,
   *  however many batches' operations it carried). */
  unresolvedAddAttempts: number;
  /** Keys whose imported (pre-journal) history leaves attempt outcomes
   *  unrecorded: any of those may have had an effect. */
  keysWithLegacyUncertainty: number;
}

/**
 * What a pre-journal ledger recorded about one batch ref, kept as facts. It
 * is evidence for operators and receipts, never a claim about what is on
 * Discord now, and it never causes a dispatch.
 */
export interface DiscordAwarenessLegacyEvidence {
  batchId: string;
  key: DiscordAwarenessRef & { emoji: string };
  /** Attempts the old ledger counted (it kept only the last one's details). */
  attempts: number;
  lastAction: DiscordAwarenessAction;
  /**
   * The last attempt's outcome, as far as the old writer's fields establish
   * it: it recorded a success by clearing `lastError` and a failure by
   * setting it, and nothing else touched that field. `confirmed`: no error
   * after an attempt. `not-sent`: AF refused before writing the request.
   * `refused`: Discord answered that the message or channel is gone or
   * inaccessible. `unrecorded`: any other error, so the request may have
   * landed.
   */
  lastOutcome: 'confirmed' | 'not-sent' | 'refused' | 'unrecorded';
  /**
   * The old writer's reconciliation state at shutdown (`deliveryStatus`):
   * whether its cached belief about the marker matched what it then wanted.
   * Branch reconciliation rewrote it without any request, so it says
   * nothing about any attempt's outcome.
   */
  oldDeliveryStatus: 'pending' | 'applied' | 'permanent-failure';
  lastError?: string;
  /** What the last error was: AF's refusal before writing a request, a
   *  Discord answer (message/channel gone or inaccessible), or anything else. */
  lastErrorKind?: 'pre-write-refusal' | 'discord-answer' | 'other';
  /** Recorded attempts whose outcome the old ledger does not establish:
   *  every attempt before the last (only the last one's details were kept),
   *  and the last when its outcome is `unrecorded`. */
  outcomesUnrecorded: number;
}

export interface DiscordAwarenessReleaseReceipt {
  batchId: string;
  addsQueued: number;
  removalsQueued: number;
}

/** Per-batch view for operators: what was asked and what is known. */
export interface DiscordAwarenessBatchView {
  kind: 'batch';
  id: string;
  status: DiscordAwarenessBatchStatus;
  scope: DiscordAwarenessBatchRecord['scope'];
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  refs: number;
  unmarked?: number;
  notRemoved?: number;
  held?: { reason: string; at: number; releaseActions: number };
  cancelled?: { at: number; by?: string };
  released?: { at: number; by?: string };
  /** Counts over the add operations this batch requested, by status. */
  adds: Record<DiscordAwarenessOpStatus, number>;
  /** Removals requested (by any retract) on this batch's refs, by status. */
  removals: Record<DiscordAwarenessOpStatus, number>;
  /** Requests on this batch's refs whose outcome is unknown or on the wire. */
  unresolvedAttempts: number;
  /** What a pre-journal ledger recorded about this batch's refs, if imported. */
  legacy?: {
    entries: number;
    /** Refs whose last recorded action was an add the old ledger saw applied. */
    lastAddConfirmed: number;
    /** Refs whose last recorded action was a removal it saw applied. */
    lastRemoveConfirmed: number;
    /** Recorded attempts whose outcome the old ledger does not establish. */
    outcomesUnrecorded: number;
  };
}

/** One retract request: the removals it queued and what became of them. */
export interface DiscordAwarenessRetractView {
  kind: 'retract';
  /** The retract's request id (what cancel takes). */
  id: string;
  /** The batch it retracted, or `all`. */
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  removals: Record<DiscordAwarenessOpStatus, number>;
  /** Removal requests whose outcome is unknown or on the wire. */
  unresolvedAttempts: number;
}

export type DiscordAwarenessView = DiscordAwarenessBatchView | DiscordAwarenessRetractView;

/** Extract Discord addressing metadata without reading message content. */
export interface DiscordMessageMetadataCarrier {
  metadata?: Record<string, unknown>;
}

export function extractDiscordAwarenessRefs(
  messages: DiscordMessageMetadataCarrier[],
  forcedServerId?: string,
): DiscordAwarenessRef[] {
  const refs = new Map<string, DiscordAwarenessRef>();
  for (const message of messages) {
    const ref = discordRef(message, forcedServerId);
    if (ref) refs.set(refKey(ref), ref);
  }
  return [...refs.values()];
}

/**
 * Select the refs a publication choice covers among removed messages.
 * `addressed` means the message carried the MCPL `chat:addressed` tag (a
 * mention, a reply to the bot, or a DM, as the server classified it); the
 * same signal the framework uses for loci and wakes. With `marks.refs`, only
 * those refs are eligible as well.
 */
export function selectDiscordAwarenessRefs(
  messages: DiscordMessageMetadataCarrier[],
  marks: DiscordAwarenessMarks,
  forcedServerId?: string,
): { refs: DiscordAwarenessRef[]; addressable: number; unmarked: number; notRemoved: number } {
  const addressable = new Map<string, { ref: DiscordAwarenessRef; addressed: boolean }>();
  for (const message of messages) {
    const ref = discordRef(message, forcedServerId);
    if (!ref) continue;
    const key = refKey(ref);
    const addressed = isAddressed(message);
    const existing = addressable.get(key);
    addressable.set(key, { ref, addressed: addressed || existing?.addressed === true });
  }
  if (marks === 'none') {
    return { refs: [], addressable: addressable.size, unmarked: addressable.size, notRemoved: 0 };
  }
  const authorized = marks.refs ? new Set(marks.refs.map(refKey)) : null;
  const refs: DiscordAwarenessRef[] = [];
  for (const [key, candidate] of addressable) {
    if (marks.scope === 'addressed' && !candidate.addressed) continue;
    if (authorized && !authorized.has(key)) continue;
    refs.push(candidate.ref);
  }
  const notRemoved = authorized
    ? [...authorized].filter((key) => !addressable.has(key)).length
    : 0;
  return { refs, addressable: addressable.size, unmarked: addressable.size - refs.length, notRemoved };
}

function discordRef(message: DiscordMessageMetadataCarrier, forcedServerId?: string): DiscordAwarenessRef | null {
  const metadata = message.metadata ?? {};
  const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : '';
  const messageId = typeof metadata.messageId === 'string' ? metadata.messageId : '';
  const metadataServerId = typeof metadata.serverId === 'string' ? metadata.serverId : '';
  const serverId = forcedServerId ?? metadataServerId;
  if (!channelId || !messageId || !serverId) return null;
  const isDiscord = serverId.toLowerCase().includes('discord') || channelId.startsWith('discord:');
  if (!isDiscord) return null;
  return { serverId, channelId, messageId };
}

function isAddressed(message: DiscordMessageMetadataCarrier): boolean {
  const tags = message.metadata?.tags;
  return Array.isArray(tags) && tags.includes('chat:addressed');
}

// ---------------------------------------------------------------------------
// Journal records
// ---------------------------------------------------------------------------

type JournalRecord =
  | { t: 'batch'; at: number; batch: DiscordAwarenessBatchRecord }
  | { t: 'activated'; at: number; batchId: string }
  /** An imported ledger's `active`: a historical fact about its marks, never
   *  a certificate that a suppression's body completed. */
  | { t: 'legacy-activated'; at: number; batchId: string }
  | { t: 'discarded'; at: number; batchId: string }
  | { t: 'held'; at: number; batchId: string; reason: string; releaseActions: DiscordAwarenessReleaseAction[] }
  | { t: 'released'; at: number; batchId: string; by?: string }
  | { t: 'cancelled'; at: number; batchId: string; by?: string }
  | {
      t: 'requested';
      at: number;
      opId: string;
      key: DiscordAwarenessRef & { emoji: string };
      action: DiscordAwarenessAction;
      cause: DiscordAwarenessOpCause;
    }
  | { t: 'op-cancelled'; at: number; opId: string; reason: 'batch-cancelled' | 'request-cancelled' | 'superseded' | 'imported' }
  | { t: 'dispatching'; at: number; opId: string; attempt: number; dispatchId?: string }
  | {
      t: 'outcome';
      at: number;
      opId: string;
      attempt: number;
      outcome: DiscordAwarenessOutcome;
      permanent?: boolean;
      error?: string;
    }
  | { t: 'retract'; at: number; requestId: string; target: string; by?: string }
  | { t: 'request-cancelled'; at: number; requestId: string; by?: string }
  | { t: 'suppression-complete'; at: number; batchId: string }
  | { t: 'legacy-evidence'; at: number; evidence: DiscordAwarenessLegacyEvidence }
  | { t: 'import-complete'; at: number; source: 'v2'; sha256: string };

/** One journal entry (one Chronicle record): records that apply together. */
interface JournalEntryGroup {
  records: JournalRecord[];
}

/**
 * The reduced state as a checkpoint stores it. This journal writes no
 * checkpoints. Its reduced state keeps every request and every attempt,
 * because receipts, `operations()` and authorization order read that
 * history, so a snapshot of it copies all of it, and copying it every N
 * entries grows the store quadratically with the marks ever requested.
 * Rather than keep a separate summary of that history, opening replays every
 * entry. A journal an earlier build of this journal checkpointed is still
 * read from its latest checkpoint, which is where RecordJournal.load()
 * starts.
 */
interface JournalSnapshot {
  batches: DiscordAwarenessBatch[];
  ops: DiscordAwarenessOp[];
  legacy: DiscordAwarenessLegacyEvidence[];
  retracts?: RetractRequest[];
  importedSources: string[];
  position?: number;
}

export const DISCORD_AWARENESS_RECORD_TYPE = 'af:discord-awareness';

interface JournalState {
  batches: Map<string, DiscordAwarenessBatch>;
  /** Operations in request order. */
  ops: Map<string, DiscordAwarenessOp>;
  /** Imported pre-journal evidence, by reaction key. */
  legacy: Map<string, DiscordAwarenessLegacyEvidence[]>;
  /** Retract requests, by request id. */
  retracts: Map<string, RetractRequest>;
  importedSources: Set<string>;
  /** Records applied so far: each record's journal position. */
  position: number;
}

interface RetractRequest {
  requestId: string;
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  /** Journal position of the retract: its removals' authorization. */
  authorization: number;
}

/**
 * The durable awareness-mark ledger: an append-only journal of typed records
 * in the store, and the operations reduced from it. One instance per store is
 * the journal's only writer (RecordJournal's single-writer rule): the running
 * framework, or the offline CLI while the host is stopped.
 */
export class DiscordAwarenessOutbox {
  private readonly journal: RecordJournal<JournalEntryGroup, JournalSnapshot>;
  private readonly legacyPath?: string;
  /** Reduced state; rebuilt from the journal when null. */
  private state: JournalState | null = null;
  /** Operations dispatched by this process and still awaiting an outcome. */
  private readonly inFlight = new Set<string>();

  /**
   * @param store the Chronicle store the journal lives in.
   * @param opts.legacyPath a pre-journal JSON ledger to import once, if present.
   */
  constructor(store: JsStore, opts: { legacyPath?: string } = {}) {
    this.journal = new RecordJournal(store, { type: DISCORD_AWARENESS_RECORD_TYPE });
    if (opts.legacyPath) this.legacyPath = opts.legacyPath;
  }

  // -- surgery side -----------------------------------------------------------

  /**
   * Record a surgery's request before its branch switch. Returns null when it
   * carries neither marks nor a suppression journal. A prepared batch never
   * delivers: activate() (or startup's crash completion) does.
   */
  prepare(input: DiscordAwarenessPrepareInput): DiscordAwarenessBatch | null {
    const batch = batchRecord(input);
    if (!batch) return null;
    // Durable before the surgery's switch, so startup can crash-complete it.
    this.append([{ t: 'batch', at: batch.createdAt, batch }], { durable: true });
    return { ...structuredClone(batch), status: 'prepared' };
  }

  /**
   * Marks for a body change already applied on `branch` (an in-place hide, a
   * turn undo): a batch for exactly that branch, recorded and activated in
   * one call, with what the journal will do (as settleActivation reports
   * it). Its record asserts the change before it, so it is written only
   * after that change is synced: a crash can never keep the batch and lose
   * the change. A batch left prepared by a crash between its two records is
   * for exactly this branch, which startup completes. If writing it fails,
   * the journal is read back, so the result follows what it holds: a batch
   * that is not there is `not-scheduled` (nothing was recorded); one that is
   * there is settled like any prepared batch (activated, else retired, else
   * `unresolved`); and if the journal can't be read back, `unresolved`, since
   * the batch may be there. Returns null when there is nothing to mark.
   * Never throws.
   */
  settleApplied(
    input: Omit<DiscordAwarenessPrepareInput, 'sourceBranch' | 'targetBranch' | 'activationPolicy' | 'suppressionIntervals'>
      & { branch: string },
  ): { batchId: string; marks: number; settled: DiscordAwarenessSettlement } | null {
    const { branch, ...rest } = input;
    const batch = batchRecord({ ...rest, sourceBranch: branch, targetBranch: branch, activationPolicy: 'explicit' });
    if (!batch) return null;
    const settle = (settled: DiscordAwarenessSettlement) => ({ batchId: batch.id, marks: batch.refs.length, settled });
    try {
      this.load();
    } catch (error) {
      // Nothing is written to a journal that can't be read.
      return settle({ status: 'not-scheduled', error: `the journal could not be read: ${errorText(error)}` });
    }
    try {
      this.append([{ t: 'batch', at: batch.createdAt, batch }], { afterCommittedState: true, durable: true });
    } catch (error) {
      const detail = `recording the batch failed: ${errorText(error)}`;
      let landed: boolean;
      try {
        landed = this.load().batches.has(batch.id);
      } catch (readError) {
        return settle({ status: 'unresolved', error: `${detail}; reading the journal back also failed: ${errorText(readError)}` });
      }
      if (!landed) return settle({ status: 'not-scheduled', error: detail });
      // It reached the store: carry out the choice it records, like any
      // prepared batch, and report what that settles.
      const settled = this.settleActivation(batch.id);
      return settle(settled.status === 'queued' ? settled : { ...settled, error: `${detail}; ${settled.error}` });
    }
    return settle(this.settleActivation(batch.id));
  }

  /**
   * Activate a prepared batch after its body change landed: one `add` request
   * per ref, durable before this returns. Activation completes the surgery's
   * earlier choice; it is not a new one, so an add for a reaction that a
   * later act (a retract, or another batch's request) already decided is
   * recorded superseded and never sent. Returns how many were queued.
   */
  activate(batchId: string): number {
    const state = this.load();
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch not found: ${batchId}`);
    if (batch.status === 'active') return 0;
    if (batch.status !== 'prepared') {
      throw new Error(`Discord awareness batch ${batchId} is ${batch.status}, not prepared`);
    }
    if (batch.cancelled) {
      // An operator cancelled it while its surgery was still running.
      throw new Error(`Discord awareness batch ${batchId} was cancelled before activation`);
    }
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'activated', at, batchId }];
    const requested = this.requestRecords(state, batch.refs.map((ref) => ({ ...ref, action: 'add' as const })), batch.emoji, {
      kind: 'batch',
      batchId,
    }, at, batch.authorization);
    records.push(...requested);
    // The activation asserts the body change just committed (the switch, or
    // the last redaction): sync that first, so a crash can never leave marks
    // active for a change the store lost.
    this.append(records, { afterCommittedState: true, durable: true });
    return liveRequests(requested);
  }

  /**
   * Activate a batch after its body change landed, and if that cannot be
   * recorded, retire it instead, so that what the caller reports is what
   * the journal will do:
   * - `queued`: the batch is active (including when the activation landed
   *   but its durability barrier failed: startup would crash-complete it);
   * - `not-scheduled`: it was retired; none of its marks will be sent;
   * - `unresolved`: neither could be recorded; a later startup that can read
   *   the batch may activate it.
   * Never throws.
   */
  settleActivation(batchId: string): DiscordAwarenessSettlement {
    let detail: string;
    try {
      return { status: 'queued', queued: this.activate(batchId) };
    } catch (error) {
      detail = boundDiscordAwarenessText(error instanceof Error ? error.message : String(error));
    }
    try {
      const state = this.load();
      const current = state.batches.get(batchId);
      if (current?.status === 'active') {
        // The activation landed but its barrier failed: report what it queued.
        const queued = [...state.ops.values()]
          .filter((op) => op.cause.kind === 'batch' && op.cause.batchId === batchId && !op.cancelled).length;
        return { status: 'queued', queued };
      }
      if (this.discard(batchId)) return { status: 'not-scheduled', error: detail };
    } catch (error) {
      detail += `; retiring it also failed: ${boundDiscordAwarenessText(error instanceof Error ? error.message : String(error))}`;
    }
    return { status: 'unresolved', error: detail };
  }

  /**
   * Retire a batch whose surgery did not complete. Only a prepared batch can
   * be discarded; returns false when nothing was retired.
   */
  discard(batchId: string): boolean {
    const batch = this.load().batches.get(batchId);
    if (!batch || batch.status !== 'prepared') return false;
    // Retiring a batch retires its obligations (marks and any body resume):
    // the branch state its surgery left (a restored source, or a completed
    // body) is synced first, and the record is durable, so a crash can never
    // keep the retirement while losing the state it relies on.
    this.append([{ t: 'discarded', at: Date.now(), batchId }], { afterCommittedState: true, durable: true });
    return true;
  }

  /**
   * Suppressions whose body may still need resuming on the active branch:
   * explicit batches with intervals whose target is exactly that branch and
   * whose body was never recorded complete. Body recovery is independent of
   * the marks: a prepared batch is crash-completed (resume, then activate);
   * any other, held, released or cancelled, has only its body resumed.
   * A batch its own surgery retired (discarded) is not resumed. Branch
   * ancestry is never consulted.
   */
  preparedSuppressionsForBranch(branchName: string): DiscordAwarenessBatch[] {
    return [...this.load().batches.values()]
      .filter((batch) => batch.status !== 'discarded'
        && !batch.suppressionComplete
        && batch.activationPolicy === 'explicit'
        && !!batch.suppressionIntervals?.length
        && batch.targetBranch === branchName)
      .map((batch) => structuredClone(batch));
  }

  /** Record that a suppression's body was completed by a resume that did not
   *  activate its marks (they were held, released or cancelled). */
  recordSuppressionComplete(batchId: string): void {
    // Certifies the redactions just made: only after they are synced.
    this.append([{ t: 'suppression-complete', at: Date.now(), batchId }], { afterCommittedState: true, durable: true });
  }

  /**
   * Startup reconciliation, run once before any delivery. It derives nothing
   * from branch ancestry:
   * - an attempt left `dispatching` by a previous process is recorded
   *   `unknown` (it may have reached Discord);
   * - a prepared batch whose target is exactly the active branch completes
   *   its crash window (activated), except a suppression, whose resume
   *   completes its body first;
   * - any other prepared batch is held for an operator;
   * - a batch an operator cancelled while it was prepared stays as it is.
   */
  recoverAtStartup(activeBranchName: string): { activated: string[]; held: string[]; unknownAttempts: number } {
    const state = this.load();
    const at = Date.now();
    const records: JournalRecord[] = [];
    let unknownAttempts = 0;
    for (const op of state.ops.values()) {
      for (const attempt of op.attempts) {
        if (attempt.outcome !== undefined) continue;
        records.push({
          t: 'outcome',
          at,
          opId: op.opId,
          attempt: attempt.attempt,
          outcome: 'unknown',
          error: 'the previous process ended before an outcome was recorded',
        });
        unknownAttempts++;
      }
    }
    const activated: string[] = [];
    const held: string[] = [];
    for (const batch of state.batches.values()) {
      if (batch.status !== 'prepared' || batch.cancelled) continue;
      const suppression = (batch.activationPolicy ?? 'target-branch') === 'explicit'
        && !!batch.suppressionIntervals?.length;
      if (batch.targetBranch === activeBranchName) {
        if (suppression) continue; // resumePreparedDiscordSuppressions completes it

        records.push({ t: 'activated', at, batchId: batch.id });
        records.push(...this.requestRecords(
          state,
          batch.refs.map((ref) => ({ ...ref, action: 'add' as const })),
          batch.emoji,
          { kind: 'batch', batchId: batch.id },
          at,
          batch.authorization,
        ));
        activated.push(batch.id);
      } else {
        records.push({
          t: 'held',
          at,
          batchId: batch.id,
          reason: suppression
            ? `its suppression on ${batch.targetBranch} was interrupted; the body resumes when that branch is active at startup, the marks only on release`
            : `its surgery was interrupted before the switch to ${batch.targetBranch} was confirmed`,
          releaseActions: batch.refs.map((ref) => ({ ...ref, action: 'add' })),
        });
        held.push(batch.id);
      }
    }
    // A crash-completion activation asserts the target's state like any
    // activation: the store's current state is synced before it is recorded
    // (the store may be caller-supplied and already open), and a failed sync
    // records nothing.
    if (records.length > 0) this.append(records, { afterCommittedState: activated.length > 0, durable: true });
    return { activated, held, unknownAttempts };
  }

  // -- operator controls ------------------------------------------------------

  /**
   * Stop all future dispatch and retry of a batch's requests: unsent ones,
   * ones on the wire (their outcome is still recorded when it comes), and
   * ones whose outcome is unknown. A held batch's release actions are
   * dropped. Nothing is ever removed from Discord by a cancel: the receipt
   * reports what may already have landed, and retract removes it.
   */
  cancel(target: string, by?: string): DiscordAwarenessCancelReceipt {
    const state = this.load();
    if (state.retracts.has(target)) return this.cancelRetract(state, target, by);
    const batchId = target;
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch or retract request not found: ${target}`);
    const receipt: DiscordAwarenessCancelReceipt = {
      target: batchId,
      kind: 'batch',
      // A prepared batch (its surgery still running, or its bookkeeping
      // unresolved) has no requests yet: every one of its marks is stopped.
      cancelled: batch.status === 'prepared' && !batch.cancelled ? batch.refs.length : 0,
      heldDropped: batch.held?.releaseActions.length ?? 0,
      inFlight: 0,
      unknown: 0,
      confirmed: 0,
      // Every request the batch itself made: its adds, and any removals its
      // release queued.
      unresolvedAttempts: unresolvedDispatches(
        [...state.ops.values()].filter((op) => op.cause.batchId === batchId),
        (op, attempt) => this.attemptUnresolved(op, attempt),
      ),
      legacyOutcomesUnrecorded: [...state.legacy.values()].flat()
        .filter((evidence) => evidence.batchId === batchId)
        .reduce((sum, evidence) => sum + evidence.outcomesUnrecorded, 0),
    };
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'cancelled', at, batchId, ...(by ? { by } : {}) }];
    const ops = [...state.ops.values()].filter((op) => op.cause.batchId === batchId);
    records.push(...this.stopRequests(ops, receipt, at, 'batch-cancelled', !!batch.cancelled));
    // A repeated cancel writes nothing; its receipt is still today's history.
    if (!batch.cancelled) this.append(records, { durable: true });
    return receipt;
  }

  /**
   * Count what history says about these requests into a cancel receipt, and
   * return the records that stop the ones still able to go out (none when
   * the group was already cancelled). History is counted whatever each
   * request's cancel state: an attempt on the wire or unanswered may land
   * after any cancel, and a confirmation is a fact about Discord.
   */
  private stopRequests(
    ops: DiscordAwarenessOp[],
    receipt: DiscordAwarenessCancelReceipt,
    at: number,
    reason: 'batch-cancelled' | 'request-cancelled',
    alreadyCancelled: boolean,
  ): JournalRecord[] {
    const records: JournalRecord[] = [];
    for (const op of ops) {
      const last = op.attempts.at(-1);
      if (last?.outcome === 'confirmed') {
        receipt.confirmed++;
        continue;
      }
      if (last && last.outcome === undefined) {
        if (this.inFlight.has(op.opId)) receipt.inFlight++;
        else receipt.unknown++;
      } else if (last?.outcome === 'unknown') {
        receipt.unknown++;
      }
      if (alreadyCancelled || op.cancelled) continue;
      const status = this.opStatus(op);
      if (status !== 'requested' && status !== 'dispatching' && status !== 'unknown') continue;
      if (status === 'requested') receipt.cancelled++;
      records.push({ t: 'op-cancelled', at, opId: op.opId, reason });
    }
    return records;
  }

  /** Stop a retract's removals that are still due; nothing sent is undone. */
  private cancelRetract(state: JournalState, requestId: string, by?: string): DiscordAwarenessCancelReceipt {
    const retract = state.retracts.get(requestId)!;
    const ops = [...state.ops.values()].filter((op) => op.cause.requestId === requestId);
    const receipt: DiscordAwarenessCancelReceipt = {
      target: requestId,
      kind: 'retract',
      cancelled: 0,
      heldDropped: 0,
      inFlight: 0,
      unknown: 0,
      confirmed: 0,
      unresolvedAttempts: unresolvedDispatches(ops, (op, attempt) => this.attemptUnresolved(op, attempt)),
      legacyOutcomesUnrecorded: 0,
    };
    const at = Date.now();
    const records: JournalRecord[] = [{ t: 'request-cancelled', at, requestId, ...(by ? { by } : {}) }];
    records.push(...this.stopRequests(ops, receipt, at, 'request-cancelled', !!retract.cancelled));
    if (!retract.cancelled) this.append(records, { durable: true });
    return receipt;
  }

  /**
   * Remove this bot's mark (through the configured route) from a batch's refs,
   * or (`all`) from every key of every batch its own surgery did not retire,
   * whether prepared, held or active, every key an add was requested for, and
   * every key an imported ledger recorded. A reaction is one per (route,
   * message, emoji), whichever batches asked for it, so this acts across
   * batches. A removal is queued for every selected key, whatever history
   * says: history can't establish what is on Discord now, and removing an
   * absent reaction does nothing. It is the latest authorization for those
   * keys: adds not yet ended are superseded, and adds an earlier choice
   * requests later (a prepared batch's activation) are recorded superseded.
   * The receipt reports history only: requests whose outcome is unresolved,
   * and imported history that leaves outcomes unrecorded, any of which may
   * land or have landed.
   */
  retract(target: string | 'all', by?: string): DiscordAwarenessRetractReceipt {
    const state = this.load();
    let candidateKeys: Array<DiscordAwarenessRef & { emoji: string }>;
    if (target === 'all') {
      candidateKeys = uniqueKeys([
        ...[...state.batches.values()]
          .filter((batch) => batch.status !== 'discarded')
          .flatMap((batch) => batch.refs.map((ref) => ({ ...ref, emoji: batch.emoji }))),
        ...[...state.ops.values()].filter((op) => op.action === 'add').map((op) => op.key),
        ...[...state.legacy.values()].flat().map((evidence) => evidence.key),
      ]);
    } else {
      const batch = state.batches.get(target);
      if (!batch) throw new Error(`Discord awareness batch not found: ${target}`);
      candidateKeys = uniqueKeys(batch.refs.map((ref) => ({ ...ref, emoji: batch.emoji })));
    }
    const requestId = randomUUID();
    const at = Date.now();
    const receipt: DiscordAwarenessRetractReceipt = {
      requestId,
      removalsQueued: 0,
      addsSuperseded: 0,
      keysWithUnresolvedAdds: 0,
      unresolvedAddAttempts: 0,
      keysWithLegacyUncertainty: 0,
    };
    const records: JournalRecord[] = [{ t: 'retract', at, requestId, target, ...(by ? { by } : {}) }];
    const toRemove: Array<DiscordAwarenessRef & { emoji: string; action: DiscordAwarenessAction }> = [];
    for (const key of candidateKeys) {
      const adds = this.opsForKey(state, key).filter((op) => op.action === 'add');
      const unresolved = unresolvedDispatches(adds, (op, attempt) => this.attemptUnresolved(op, attempt));
      if (unresolved > 0) {
        receipt.keysWithUnresolvedAdds++;
        receipt.unresolvedAddAttempts += unresolved;
      }
      if ((state.legacy.get(markKey(key)) ?? []).some((evidence) => evidence.outcomesUnrecorded > 0)) {
        receipt.keysWithLegacyUncertainty++;
      }
      toRemove.push({ ...key, action: 'remove' });
    }
    const requested = this.requestRecords(state, toRemove, undefined, { kind: 'retract', requestId }, at);
    receipt.addsSuperseded = requested.filter((record) => record.t === 'op-cancelled').length;
    receipt.removalsQueued = requested.filter((record) => record.t === 'requested').length;
    records.push(...requested);
    this.append(records, { durable: true });
    return receipt;
  }

  /** Release a held batch: queue its recorded release actions, explicitly. */
  release(batchId: string, by?: string): DiscordAwarenessReleaseReceipt {
    const state = this.load();
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error(`Discord awareness batch not found: ${batchId}`);
    if (batch.status !== 'held' || !batch.held) {
      throw new Error(`Discord awareness batch ${batchId} is ${batch.status}, not held`);
    }
    const at = Date.now();
    const actions = batch.held.releaseActions;
    const records: JournalRecord[] = [{ t: 'released', at, batchId, ...(by ? { by } : {}) }];
    records.push(...this.requestRecords(state, actions.map((action) => ({ ...action })), batch.emoji, {
      kind: 'release',
      batchId,
    }, at));
    this.append(records, { durable: true });
    return {
      batchId,
      addsQueued: actions.filter((action) => action.action === 'add').length,
      removalsQueued: actions.filter((action) => action.action === 'remove').length,
    };
  }

  // -- delivery ---------------------------------------------------------------

  /**
   * The next dispatch for each reaction key that has work and nothing on the
   * wire. A key's operations go out in request order; consecutive requested
   * operations with the same action share one dispatch. An `unknown`
   * operation is retried only while it is still the newest live operation
   * for its key.
   */
  pendingDispatches(serverId?: string): DiscordAwarenessDispatch[] {
    const state = this.load();
    const byKey = new Map<string, DiscordAwarenessOp[]>();
    for (const op of state.ops.values()) {
      if (serverId !== undefined && op.key.serverId !== serverId) continue;
      const key = markKey(op.key);
      const list = byKey.get(key);
      if (list) list.push(op);
      else byKey.set(key, [op]);
    }
    const dispatches: Array<DiscordAwarenessDispatch & { order: number }> = [];
    for (const ops of byKey.values()) {
      const head = this.headDispatch(ops);
      if (head) dispatches.push(head);
    }
    return dispatches
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...dispatch }) => dispatch);
  }

  /**
   * Choose a server's next due dispatch and write it ahead, in one step:
   * eligibility is computed from the journal as it is now, so a cancel or
   * retract made while an earlier request was on the wire is never
   * overridden by an older list. `skip` excludes dispatches already tried
   * in this pass. Returns null when nothing is due.
   */
  claimDispatch(
    serverId: string,
    skip: (dispatch: DiscordAwarenessDispatch) => boolean = () => false,
  ): { dispatch: DiscordAwarenessDispatch; attempts: Array<{ opId: string; attempt: number }> } | null {
    for (const dispatch of this.pendingDispatches(serverId)) {
      if (skip(dispatch)) continue;
      const attempts = this.recordDispatching(dispatch);
      if (attempts.length > 0) return { dispatch, attempts };
    }
    return null;
  }

  /**
   * Write-ahead: record that a dispatch is about to leave the host. A
   * dispatch computed earlier is narrowed to the operations still due for its
   * key now; when none remain, nothing is written and no attempts are
   * returned (do not send).
   */
  recordDispatching(dispatch: DiscordAwarenessDispatch): Array<{ opId: string; attempt: number }> {
    const state = this.load();
    const current = this.headDispatch(this.opsForKey(state, dispatch.key));
    if (!current || current.action !== dispatch.action) return [];
    const opIds = dispatch.opIds.filter((opId) => current.opIds.includes(opId));
    if (opIds.length === 0) return [];
    const at = Date.now();
    const dispatchId = randomUUID();
    const attempts = opIds.map((opId) => ({ opId, attempt: state.ops.get(opId)!.attempts.length + 1 }));
    this.append(
      attempts.map(({ opId, attempt }) => ({ t: 'dispatching' as const, at, opId, attempt, dispatchId })),
      { durable: true },
    );
    for (const { opId } of attempts) this.inFlight.add(opId);
    return attempts;
  }

  /** The due dispatch for one key's operations (in request order), if any. */
  private headDispatch(ops: DiscordAwarenessOp[]): (DiscordAwarenessDispatch & { order: number }) | null {
    // One request per reaction key on the wire at a time, including a
    // cancelled one still awaiting its outcome: opposite actions must not
    // overtake each other.
    if (ops.some((op) => op.attempts.length > 0 && op.attempts.at(-1)!.outcome === undefined
      && this.inFlight.has(op.opId))) return null;
    const live = ops.filter((op) => !op.cancelled);
    let head: DiscordAwarenessOp | undefined;
    for (let index = 0; index < live.length; index++) {
      const op = live[index];
      const status = this.opStatus(op);
      if (status === 'requested') { head = op; break; }
      if (status === 'unknown' && index === live.length - 1) { head = op; break; }
    }
    if (!head) return null;
    const opIds = [head.opId];
    for (let index = live.indexOf(head) + 1; index < live.length; index++) {
      const next = live[index];
      if (next.action !== head.action || this.opStatus(next) !== 'requested') break;
      opIds.push(next.opId);
    }
    return { key: { ...head.key }, action: head.action, opIds, order: head.requestedAt };
  }

  /** Record the outcome of a dispatch's attempts. */
  recordOutcome(
    attempts: Array<{ opId: string; attempt: number }>,
    outcome: DiscordAwarenessOutcome,
    detail: { permanent?: boolean; error?: string } = {},
  ): void {
    const at = Date.now();
    const error = detail.error !== undefined ? boundDiscordAwarenessText(detail.error) : undefined;
    try {
      this.append(attempts.map(({ opId, attempt }) => ({
        t: 'outcome' as const,
        at,
        opId,
        attempt,
        outcome,
        ...(outcome === 'failed' && detail.permanent ? { permanent: true } : {}),
        ...(error !== undefined ? { error } : {}),
      })));
    } finally {
      for (const { opId } of attempts) this.inFlight.delete(opId);
    }
  }

  // -- views ------------------------------------------------------------------

  batches(): DiscordAwarenessBatch[] {
    return [...this.load().batches.values()].map((batch) => structuredClone(batch));
  }

  operations(): DiscordAwarenessOp[] {
    const state = this.load();
    return [...state.ops.values()].map((op) => structuredClone(op));
  }

  /** Status of an operation as this process can know it. */
  operationStatus(op: DiscordAwarenessOp): DiscordAwarenessOpStatus {
    return this.opStatus(op);
  }

  view(): DiscordAwarenessView[] {
    const state = this.load();
    const views: DiscordAwarenessView[] = [];
    for (const batch of state.batches.values()) {
      if (batch.status === 'discarded') continue;
      const keys = new Set(batch.refs.map((ref) => markKey({ ...ref, emoji: batch.emoji })));
      const adds = emptyCounts();
      const removals = emptyCounts();
      const onKeys: DiscordAwarenessOp[] = [];
      for (const op of state.ops.values()) {
        if (!keys.has(markKey(op.key))) continue;
        onKeys.push(op);
        if (op.action === 'add' && op.cause.batchId === batch.id) adds[this.opStatus(op)]++;
        if (op.action === 'remove') removals[this.opStatus(op)]++;
      }
      const unresolvedAttempts = unresolvedDispatches(onKeys, (op, attempt) => this.attemptUnresolved(op, attempt));
      const evidence = [...state.legacy.values()].flat().filter((entry) => entry.batchId === batch.id);
      views.push({
        kind: 'batch',
        id: batch.id,
        status: batch.status,
        scope: batch.scope,
        agentName: batch.agentName,
        sourceBranch: batch.sourceBranch,
        targetBranch: batch.targetBranch,
        emoji: batch.emoji,
        createdAt: batch.createdAt,
        refs: batch.refs.length,
        ...(batch.unmarked !== undefined ? { unmarked: batch.unmarked } : {}),
        ...(batch.notRemoved !== undefined ? { notRemoved: batch.notRemoved } : {}),
        ...(batch.held
          ? { held: { reason: batch.held.reason, at: batch.held.at, releaseActions: batch.held.releaseActions.length } }
          : {}),
        ...(batch.cancelled ? { cancelled: batch.cancelled } : {}),
        ...(batch.released ? { released: batch.released } : {}),
        adds,
        removals,
        unresolvedAttempts,
        ...(evidence.length > 0
          ? {
              legacy: {
                entries: evidence.length,
                lastAddConfirmed: evidence.filter((entry) => entry.lastAction === 'add' && entry.lastOutcome === 'confirmed').length,
                lastRemoveConfirmed: evidence.filter((entry) => entry.lastAction === 'remove' && entry.lastOutcome === 'confirmed').length,
                outcomesUnrecorded: evidence.reduce((sum, entry) => sum + entry.outcomesUnrecorded, 0),
              },
            }
          : {}),
      });
    }
    for (const retract of state.retracts.values()) {
      const ops = [...state.ops.values()].filter((op) => op.cause.requestId === retract.requestId);
      const removals = emptyCounts();
      for (const op of ops) removals[this.opStatus(op)]++;
      views.push({
        kind: 'retract',
        id: retract.requestId,
        target: retract.target,
        at: retract.at,
        ...(retract.by ? { by: retract.by } : {}),
        ...(retract.cancelled ? { cancelled: retract.cancelled } : {}),
        removals,
        unresolvedAttempts: unresolvedDispatches(ops, (op, attempt) => this.attemptUnresolved(op, attempt)),
      });
    }
    return views;
  }

  // -- internals --------------------------------------------------------------

  private opStatus(op: DiscordAwarenessOp): DiscordAwarenessOpStatus {
    const last = op.attempts.at(-1);
    // A confirmation is a fact about Discord, even for a request cancelled
    // while it was on the wire.
    if (last?.outcome === 'confirmed') return 'confirmed';
    if (op.cancelled) return 'cancelled';
    if (!last) return 'requested';
    if (last.outcome === undefined) return this.inFlight.has(op.opId) ? 'dispatching' : 'unknown';
    if (last.outcome === 'unknown') return 'unknown';
    if (last.outcome === 'not-sent') return 'requested';
    return last.permanent ? 'failed' : 'requested';
  }

  /**
   * An attempt that may have reached Discord without an answer: `unknown`,
   * or still without an outcome (on the wire in this process, or left by a
   * previous process before recoverAtStartup recorded it unknown).
   */
  private attemptUnresolved(_op: DiscordAwarenessOp, attempt: DiscordAwarenessAttempt): boolean {
    return attempt.outcome === 'unknown' || attempt.outcome === undefined;
  }

  private opsForKey(state: JournalState, key: DiscordAwarenessRef & { emoji: string }): DiscordAwarenessOp[] {
    const wanted = markKey(key);
    return [...state.ops.values()].filter((op) => markKey(op.key) === wanted);
  }

  /**
   * Records for new requests, ordered by authorization: between opposite
   * requests for one key, the later authorization wins, whenever each
   * request was created. `authorization` is the journal position of the act
   * the requests carry out (a prepared batch's choice, when its activation
   * comes later); left out, they are a new act, later than everything
   * recorded (a retract, a release).
   * - Each older-authorized opposite request that has not ended (due, on
   *   the wire, or unknown) has its future retries retired. Its attempts
   *   stay as history (an unresolved one is still disclosed), and a request
   *   on the wire still settles before anything else for that key is sent.
   * - A request with an opposite request authorized after it, in any state,
   *   even cancelled, is recorded superseded and never sent: cancelling the
   *   later act stops it without reviving what it decided against.
   */
  private requestRecords(
    state: JournalState,
    requests: Array<DiscordAwarenessRef & { action: DiscordAwarenessAction; emoji?: string }>,
    emoji: string | undefined,
    cause: DiscordAwarenessOpCause,
    at: number,
    authorization: number = Number.POSITIVE_INFINITY,
  ): JournalRecord[] {
    const records: JournalRecord[] = [];
    const superseded = new Set<string>();
    for (const request of requests) {
      const key = {
        serverId: request.serverId,
        channelId: request.channelId,
        messageId: request.messageId,
        emoji: request.emoji ?? emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
      };
      const opposite = this.opsForKey(state, key).filter((op) => op.action !== request.action);
      const opId = randomUUID();
      records.push({ t: 'requested', at, opId, key, action: request.action, cause });
      if (opposite.some((op) => op.authorization > authorization)) {
        records.push({ t: 'op-cancelled', at, opId, reason: 'superseded' });
        continue;
      }
      for (const op of opposite) {
        if (superseded.has(op.opId) || op.cancelled || op.authorization >= authorization) continue;
        const status = this.opStatus(op);
        if (status !== 'requested' && status !== 'dispatching' && status !== 'unknown') continue;
        records.push({ t: 'op-cancelled', at, opId: op.opId, reason: 'superseded' });
        superseded.add(op.opId);
      }
    }
    return records;
  }

  /**
   * The reduced state, rebuilt from the journal when there is none yet or an
   * earlier write left the journal unreconciled (RecordJournal then requires
   * a reload before writing again): every entry is replayed, after an
   * earlier build's checkpoint if there is one (see JournalSnapshot). The
   * first load also imports a pre-journal ledger, once.
   */
  private load(): JournalState {
    if (this.state && !this.journal.needsReconcile) return this.state;
    const { snapshot, entries } = this.journal.load();
    const state = snapshot ? restoreState(snapshot) : emptyState();
    for (const { id, entry } of entries) {
      if (!entry || !Array.isArray(entry.records)) {
        throw new Error(`Corrupt Discord awareness journal entry ${id}`);
      }
      applyRecords(state, entry.records);
    }
    this.state = state;
    this.importLegacyLedger(state);
    return state;
  }

  /** Import a pre-journal ledger beside the store once (by hash), then rename it. */
  private importLegacyLedger(state: JournalState): void {
    if (!this.legacyPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.legacyPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(
        `Could not read Discord awareness ledger ${this.legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (!state.importedSources.has(sha256)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid Discord awareness ledger ${this.legacyPath}`);
      }
      this.append(importLegacy(parsed, this.legacyPath, sha256), { durable: true });
    }
    // Imported (now or by an earlier process that stopped before renaming):
    // the file is inert; move it out of the way.
    if (!existsSync(this.legacyPath)) return;
    try {
      renameSync(this.legacyPath, `${this.legacyPath}.migrated-v2`);
    } catch (error) {
      console.error(
        `[discord-awareness] imported ${basename(this.legacyPath)} but could not rename it: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Append one group of records as one journal entry and apply it. A failed
   * append leaves the state to be rebuilt from the journal: whether it was
   * written is unknown, and the next operation reloads before writing.
   */
  private append(records: JournalRecord[], opts: AppendOptions = {}): void {
    if (records.length === 0) return;
    const state = this.load();
    try {
      this.journal.append({ records }, opts);
    } catch (error) {
      this.state = null;
      throw error;
    }
    applyRecords(state, records);
  }
}

// ---------------------------------------------------------------------------
// Fold and legacy import
// ---------------------------------------------------------------------------

function emptyState(): JournalState {
  return { batches: new Map(), ops: new Map(), legacy: new Map(), retracts: new Map(), importedSources: new Set(), position: 0 };
}

/** Requests in these records that are not recorded superseded with them. */
function liveRequests(records: JournalRecord[]): number {
  const cancelled = new Set(records.filter((record) => record.t === 'op-cancelled').map((record) => (record as { opId: string }).opId));
  return records.filter((record) => record.t === 'requested' && !cancelled.has(record.opId)).length;
}

/** The state an earlier build's checkpoint recorded (see JournalSnapshot). */
function restoreState(snapshot: JournalSnapshot): JournalState {
  const state: JournalState = {
    batches: new Map(snapshot.batches.map((batch) => [batch.id, structuredClone(batch)])),
    ops: new Map(snapshot.ops.map((op) => [op.opId, structuredClone(op)])),
    legacy: new Map(),
    retracts: new Map((snapshot.retracts ?? []).map((retract) => [retract.requestId, structuredClone(retract)])),
    importedSources: new Set(snapshot.importedSources),
    position: snapshot.position ?? 0,
  };
  for (const evidence of snapshot.legacy ?? []) addLegacyEvidence(state, structuredClone(evidence));
  return state;
}

function addLegacyEvidence(state: JournalState, evidence: DiscordAwarenessLegacyEvidence): void {
  const key = markKey(evidence.key);
  const list = state.legacy.get(key);
  if (list) list.push(evidence);
  else state.legacy.set(key, [evidence]);
}

/** Apply one entry's records, in order, to the reduced state. Each record
 *  takes the next journal position. */
function applyRecords(state: JournalState, records: JournalRecord[]): void {
  for (const record of records) {
    const position = ++state.position;
    switch (record.t) {
      case 'batch':
        if (!state.batches.has(record.batch.id)) {
          state.batches.set(record.batch.id, { ...structuredClone(record.batch), status: 'prepared', authorization: position });
        }
        break;
      case 'activated': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status !== 'discarded') {
          batch.status = 'active';
          // Only a surgery (or its resume) activates a suppression, after its
          // last redaction synced: activation records the body complete.
          // Release does not, and neither does an imported `active`.
          if (batch.suppressionIntervals?.length) batch.suppressionComplete = true;
        }
        break;
      }
      case 'legacy-activated': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status !== 'discarded') batch.status = 'active';
        break;
      }
      case 'discarded': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status === 'prepared') batch.status = 'discarded';
        break;
      }
      case 'held': {
        const batch = state.batches.get(record.batchId);
        if (batch && !batch.cancelled) {
          batch.status = 'held';
          batch.held = { reason: record.reason, at: record.at, releaseActions: structuredClone(record.releaseActions) };
        }
        break;
      }
      case 'released': {
        const batch = state.batches.get(record.batchId);
        if (batch && batch.status === 'held') {
          batch.status = 'active';
          delete batch.held;
          batch.released = { at: record.at, ...(record.by ? { by: record.by } : {}) };
          batch.releaseAuthorization = position;
        }
        break;
      }
      case 'cancelled': {
        const batch = state.batches.get(record.batchId);
        if (batch && !batch.cancelled) {
          if (batch.status === 'held') {
            batch.status = 'active';
            delete batch.held;
          }
          batch.cancelled = { at: record.at, ...(record.by ? { by: record.by } : {}) };
        }
        break;
      }
      case 'requested':
        if (!state.ops.has(record.opId)) {
          state.ops.set(record.opId, {
            opId: record.opId,
            key: { ...record.key },
            action: record.action,
            cause: { ...record.cause },
            authorization: authorizationOf(state, record.cause) ?? position,
            requestedAt: record.at,
            attempts: [],
          });
        }
        break;
      case 'op-cancelled': {
        const op = state.ops.get(record.opId);
        if (op && !op.cancelled) op.cancelled = { at: record.at, reason: record.reason };
        break;
      }
      case 'dispatching': {
        const op = state.ops.get(record.opId);
        if (op && !op.attempts.some((attempt) => attempt.attempt === record.attempt)) {
          op.attempts.push({
            attempt: record.attempt,
            ...(record.dispatchId ? { dispatchId: record.dispatchId } : {}),
            dispatchedAt: record.at,
          });
        }
        break;
      }
      case 'outcome': {
        const op = state.ops.get(record.opId);
        const attempt = op?.attempts.find((candidate) => candidate.attempt === record.attempt);
        if (attempt && attempt.outcome === undefined) {
          attempt.outcome = record.outcome;
          attempt.outcomeAt = record.at;
          if (record.permanent) attempt.permanent = true;
          if (record.error !== undefined) attempt.error = record.error;
        }
        break;
      }
      case 'suppression-complete': {
        const batch = state.batches.get(record.batchId);
        if (batch) batch.suppressionComplete = true;
        break;
      }
      case 'legacy-evidence':
        addLegacyEvidence(state, structuredClone(record.evidence));
        break;
      case 'retract':
        if (!state.retracts.has(record.requestId)) {
          state.retracts.set(record.requestId, {
            requestId: record.requestId,
            target: record.target,
            at: record.at,
            ...(record.by ? { by: record.by } : {}),
            authorization: position,
          });
        }
        break;
      case 'request-cancelled': {
        const retract = state.retracts.get(record.requestId);
        if (retract && !retract.cancelled) {
          retract.cancelled = { at: record.at, ...(record.by ? { by: record.by } : {}) };
        }
        break;
      }
      case 'import-complete':
        state.importedSources.add(record.sha256);
        break;
      default:
        break;
    }
  }
}

/** The journal position of the act a request carries out. */
function authorizationOf(state: JournalState, cause: DiscordAwarenessOpCause): number | undefined {
  if (cause.kind === 'batch' && cause.batchId) return state.batches.get(cause.batchId)?.authorization;
  if (cause.kind === 'release' && cause.batchId) return state.batches.get(cause.batchId)?.releaseAuthorization;
  if (cause.kind === 'retract' && cause.requestId) return state.retracts.get(cause.requestId)?.authorization;
  return undefined;
}

interface LegacyEntry extends DiscordAwarenessRef {
  desired?: boolean;
  markerPresent?: boolean;
  deliveryStatus?: 'pending' | 'applied' | 'permanent-failure';
  attempts?: number;
  lastAction?: DiscordAwarenessAction;
  lastAttemptAt?: number;
  lastError?: string;
}

interface LegacyBatch {
  id: string;
  status: 'prepared' | 'active' | 'pending';
  agentName: string;
  sourceBranch: string;
  targetBranch: string;
  emoji: string;
  createdAt: number;
  refs: LegacyEntry[];
  activationPolicy?: 'target-branch' | 'explicit';
  suppressionIntervals?: DiscordSuppressionInterval[];
}

/**
 * Translate a version 1 or 2 ledger into journal records, ending with an
 * `import-complete` record carrying the file's hash. Batches keep their ids.
 * What the old ledger recorded about each ref is kept as legacy evidence:
 * facts (attempt count, last action, status and error), never synthesized
 * attempts and never a judgment about what is on Discord. Pending work, and
 * batches still prepared, are held for an operator: they were queued before
 * marks were an explicit choice. Nothing imported is ever dispatched.
 */
function importLegacy(parsed: unknown, path: string, sha256: string): JournalRecord[] {
  const document = parsed as { version?: unknown; batches?: unknown };
  if (!document || (document.version !== 1 && document.version !== 2) || !Array.isArray(document.batches)) {
    throw new Error(`Invalid Discord awareness ledger ${path}`);
  }
  const at = Date.now();
  const records: JournalRecord[] = [];
  for (const raw of document.batches as LegacyBatch[]) {
    if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.refs)) {
      throw new Error(`Invalid Discord awareness ledger ${path}`);
    }
    const legacyActive = raw.status === 'active' || raw.status === 'pending';
    const refs = raw.refs.map((entry) => ({
      serverId: entry.serverId,
      channelId: entry.channelId,
      messageId: entry.messageId,
    }));
    records.push({
      t: 'batch',
      at: raw.createdAt,
      batch: {
        id: raw.id,
        agentName: raw.agentName,
        sourceBranch: raw.sourceBranch,
        targetBranch: raw.targetBranch,
        emoji: raw.emoji,
        createdAt: raw.createdAt,
        scope: 'legacy',
        refs,
        ...(raw.activationPolicy ? { activationPolicy: raw.activationPolicy } : {}),
        ...(raw.suppressionIntervals?.length ? { suppressionIntervals: raw.suppressionIntervals } : {}),
      },
    });
    // Its marks were active. That is history, not proof of a suppression's
    // body: the old ledger could record activation before the redactions
    // were synced, so a startup on the target still verifies and resumes
    // the intervals before recording the body complete.
    if (legacyActive) records.push({ t: 'legacy-activated', at: raw.createdAt, batchId: raw.id });
    const releaseActions: DiscordAwarenessReleaseAction[] = [];
    for (const entry of raw.refs) {
      const key = { serverId: entry.serverId, channelId: entry.channelId, messageId: entry.messageId, emoji: raw.emoji };
      // v1 entries carry no delivery state: an active v1 batch was all pending.
      const status = entry.deliveryStatus ?? (raw.status === 'pending' ? 'pending' : 'applied');
      const desired = entry.desired ?? raw.status === 'pending';
      if (!legacyActive || status === 'pending') {
        if (!legacyActive || desired || entry.markerPresent) {
          releaseActions.push({
            ...key,
            action: desired || !legacyActive ? 'add' : 'remove',
            ...(entry.attempts ? { priorAttempts: entry.attempts } : {}),
            ...(entry.lastError ? { priorError: boundDiscordAwarenessText(entry.lastError) } : {}),
          });
        }
      }
      if (entry.attempts && entry.attempts > 0 && entry.lastAction) {
        records.push({ t: 'legacy-evidence', at, evidence: legacyEvidence(raw.id, key, entry, status) });
      }
    }
    if (releaseActions.length > 0) {
      records.push({
        t: 'held',
        at,
        batchId: raw.id,
        reason: legacyActive
          ? 'queued by an earlier release, before marks were an explicit choice'
          : 'prepared by an earlier release, before marks were an explicit choice',
        releaseActions,
      });
    }
  }
  records.push({ t: 'import-complete', at, source: 'v2', sha256 });
  return records;
}

/**
 * The facts a v2 entry recorded about its attempts, and what they leave open.
 * Only `lastError` speaks to the last attempt's outcome (the old writer
 * cleared it on success and set it on failure); `deliveryStatus` was its
 * reconciliation state, rewritten by branch switches without any request,
 * and is kept as that and nothing more.
 */
function legacyEvidence(
  batchId: string,
  key: DiscordAwarenessRef & { emoji: string },
  entry: LegacyEntry,
  oldDeliveryStatus: 'pending' | 'applied' | 'permanent-failure',
): DiscordAwarenessLegacyEvidence {
  const attempts = entry.attempts!;
  const lastError = entry.lastError;
  const lastErrorKind = lastError === undefined ? undefined
    : PRE_WRITE_REFUSAL.test(lastError) ? 'pre-write-refusal'
    : isPermanentDiscordReactionFailure(lastError) ? 'discord-answer'
    : 'other';
  const lastOutcome = lastErrorKind === undefined ? 'confirmed'
    : lastErrorKind === 'pre-write-refusal' ? 'not-sent'
    : lastErrorKind === 'discord-answer' ? 'refused'
    : 'unrecorded';
  return {
    batchId,
    key: { ...key },
    attempts,
    lastAction: entry.lastAction!,
    lastOutcome,
    oldDeliveryStatus,
    ...(lastError !== undefined ? { lastError: boundDiscordAwarenessText(lastError) } : {}),
    ...(lastErrorKind ? { lastErrorKind } : {}),
    outcomesUnrecorded: (attempts - 1) + (lastOutcome === 'unrecorded' ? 1 : 0),
  };
}

/** A new batch's record, or null when it carries neither marks nor a
 *  suppression journal. */
function batchRecord(input: DiscordAwarenessPrepareInput): DiscordAwarenessBatchRecord | null {
  const refs = dedupeRefs(input.refs);
  if (refs.length === 0 && !input.suppressionIntervals?.length) return null;
  return {
    id: randomUUID(),
    agentName: input.agentName,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    emoji: input.emoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
    createdAt: Date.now(),
    scope: input.scope,
    refs,
    ...(input.unmarked ? { unmarked: input.unmarked } : {}),
    ...(input.notRemoved ? { notRemoved: input.notRemoved } : {}),
    activationPolicy: input.activationPolicy ?? 'target-branch',
    ...(input.suppressionIntervals?.length
      ? { suppressionIntervals: input.suppressionIntervals.map((interval) => ({ ...interval })) }
      : {}),
  };
}

function errorText(error: unknown): string {
  return boundDiscordAwarenessText(error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function dedupeRefs(refs: DiscordAwarenessRef[]): DiscordAwarenessRef[] {
  const deduped = new Map<string, DiscordAwarenessRef>();
  for (const ref of refs) {
    if (!ref.serverId || !ref.channelId || !ref.messageId) continue;
    deduped.set(refKey(ref), { serverId: ref.serverId, channelId: ref.channelId, messageId: ref.messageId });
  }
  return [...deduped.values()];
}

function uniqueKeys(keys: Array<DiscordAwarenessRef & { emoji: string }>): Array<DiscordAwarenessRef & { emoji: string }> {
  const unique = new Map<string, DiscordAwarenessRef & { emoji: string }>();
  for (const key of keys) unique.set(markKey(key), key);
  return [...unique.values()];
}

function refKey(ref: DiscordAwarenessRef): string {
  return `${ref.serverId}\0${ref.channelId}\0${ref.messageId}`;
}

function markKey(key: DiscordAwarenessRef & { emoji: string }): string {
  return `${key.emoji}\0${refKey(key)}`;
}

/** Unresolved requests among these operations' attempts, one per dispatch. */
function unresolvedDispatches(
  ops: DiscordAwarenessOp[],
  unresolved: (op: DiscordAwarenessOp, attempt: DiscordAwarenessAttempt) => boolean,
): number {
  const dispatches = new Set<string>();
  for (const op of ops) {
    for (const attempt of op.attempts) {
      if (unresolved(op, attempt)) dispatches.add(attempt.dispatchId ?? `${op.opId}#${attempt.attempt}`);
    }
  }
  return dispatches.size;
}

function emptyCounts(): Record<DiscordAwarenessOpStatus, number> {
  return { requested: 0, dispatching: 0, confirmed: 0, failed: 0, unknown: 0, cancelled: 0 };
}
