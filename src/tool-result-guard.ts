import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedMessage, ToolResult } from '@animalabs/membrane';
import type { CompletedToolCall } from './types/index.js';
import { ensureStateRegistered } from './module-registry.js';
import { classifyBlock } from './mcpl/references.js';
import { resultClaimsOf, rfc005TextOf, toolResultDataToHistoryString } from './tool-result-history.js';
import { safeSlice } from './safe-slice.js';

export const TOOL_RESULT_GUARD_NOTICE = 'Tool result withheld by the guard. The tool has already executed.';
export type WithheldNoticeKind = 'ran' | 'refused' | 'error';
const GUARD_NOTICES: Record<WithheldNoticeKind, string> = {
  ran: TOOL_RESULT_GUARD_NOTICE,
  refused: "Tool result withheld by the guard. The tool didn't run.",
  error: "Tool result withheld by the guard. The call returned an error, and this notice can't say whether the tool ran.",
};
const noticeKind = (result: CompletedToolCall['result'] | undefined): WithheldNoticeKind =>
  result?.refused === true ? 'refused' : result?.isError === true ? 'error' : 'ran';
export const TOOL_RESULT_GUARD_AUDIT_STATE = 'framework/tool-result-guard';

/** Where a withheld result's original went: a workspace path; the path a
 *  write to it failed at (`error`); the path a write was still under way to
 *  when the host stopped waiting for it (`unfinished`); no write, because the
 *  workspace isn't answering (`workspace_unanswered`: an earlier write is
 *  still under way past the host's deadline) or because the workspace had
 *  left the stub's branch when the file would have been committed
 *  (`branch_changed`), or because the batch used its deadline before this
 *  write could start (`batch_deadline`); or null when no file is written at all (no writable
 *  mount without an include, or the host is stopping). */
export type WithheldSpill =
  | { path: string; error?: string; unfinished?: true }
  | { skipped: 'workspace_unanswered' | 'branch_changed' | 'batch_deadline' }
  | null;

/**
 * Writes one withheld original as a workspace file, using what remains of
 * the batch's absolute deadline. A write still running then is unfinished.
 * Once a write reaches that deadline, later spills are workspace_unanswered
 * until all overdue writes settle. Other batches can start before that gate
 * closes. An exhausted batch starts no write (batch_deadline).
 * The tree entry lands on branch or the write is declined (branch_changed).
 * The mount's disk directory is shared across branches.
 */
export type WithheldSpiller = (label: string, text: string, branch: string, deadline: number) => Promise<WithheldSpill>;

/** What a host gives a guard for its withheld results: where originals are
 *  written, where each annotation is registered, so the host's stop can
 *  wait for it even after the agent itself was disposed, and where the
 *  guard says whether it has work left. */
export interface WithheldHost {
  spill: WithheldSpiller;
  /** Absolute deadline for one batch (Date.now() time), taken when the batch is queued. */
  deadline(): number;
  track(annotation: Promise<void>): void;
  /** Whether the guard is idle (see ToolResultGuard.idle), told after each
   *  change that can alter it: when an annotation starts or ends, and after
   *  each pass over the storage queue. A host keeps a guard that isn't idle
   *  within reach for retries, whatever has become of its agent, and lets
   *  an idle one go. */
  idle(idle: boolean): void;
}

/**
 * The stub a withheld result settles to: #159's neutral notice for its
 * `kind` (a result that isn't an error, a refused call's, or another error's),
 * then where the original is, then, for an error whose original is in a file
 * known written, a line telling the agent to read it, then, when its tool
 * marked any, the fields kept from its result (`kept`, from
 * keptWhenWithheld). It names no refusal and no
 * category (#159 keeps those in operational logs), so reading the rest back
 * is the agent's deliberate choice (agent-framework #277). The place holds
 * the result as stored, which for one over the inline cap is its capped
 * text, whose own note names the file with the whole output; so the stub
 * says "its result", not its full result. A failed write's own error text
 * stays in the audit record and the logs, not here. The audit record is
 * said to keep the original only when it was saved: a staged record whose
 * save failed is still queued in memory, and a restart before its retry
 * loses it.
 */
export function withheldResultNotice(spill: WithheldSpill, auditDurable: boolean, kept?: string, kind: WithheldNoticeKind = 'ran'): string {
  const audit = `the guard's audit record (${TOOL_RESULT_GUARD_AUDIT_STATE}), for an operator`;
  const keptIn = (only: string) => auditDurable
    ? `is kept ${only}in ${audit}`
    : `went ${only}to ${audit}, though saving that record had failed when the result arrived`;
  const place = !spill || 'skipped' in spill
    ? `Its result ${keptIn('')}.`
    : spill.unfinished
      ? `Its result was still being written to workspace file ${spill.path} when this note was made; ` +
        `if that file is missing, it ${keptIn('')}.`
      : spill.error === undefined
        ? `Its result is in workspace file ${spill.path}.`
        : `Writing its result to workspace file ${spill.path} failed, so it ${keptIn('only ')}.`;
  const readable = kind === 'error' && !!spill && 'path' in spill && spill.error === undefined && !spill.unfinished;
  const readFirst = readable ? ' Read it before calling again.' : '';
  const fields = kept === undefined ? '' : ` Kept from its result: ${kept}`;
  return `${GUARD_NOTICES[kind]} ${place}${readFirst}${fields}`;
}

/**
 * What a withheld result's stub keeps of it: the fields of its data that its
 * tool marked as saying what it acted on (ToolResult.keepWhenWithheld), in
 * the order marked, serialized as a stored result is. Past `maxChars`, the
 * inline cap or less (storeResults' keptCap), they're cut, with a note that
 * says so and where the whole result is, since a later field can then be cut
 * away entirely. Undefined when it keeps nothing, as for a failed result
 * (agent-framework #277), one whose claims can't be read whole
 * (resultClaimsOf), or one whose data is MCP's embedded resource, whose
 * fields can't be kept apart from its contents or its uri. A write's file
 * list is evidence of what it did, rarely what drew a refusal, and keeping it
 * is what shows a clobbered file when the receipt is withheld.
 */
export function keptWhenWithheld(result: CompletedToolCall['result'], maxChars: number | undefined): string | undefined {
  const { data, keepWhenWithheld: keys } = result;
  if (!result.success || result.isError || !keys?.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  // MCP's embedded resource is its contents: shown as text, it's the very
  // body the guard withheld, and a field picked out of it, such as
  // `resource`, is data that shows its uri. So it keeps nothing.
  if (classifyBlock(data).kind === 'embedded') return undefined;
  const fields = data as Record<string, unknown>;
  const kept = Object.fromEntries(keys.filter((key) => Object.hasOwn(fields, key)).map((key) => [key, fields[key]]));
  if (Object.keys(kept).length === 0) return undefined;
  // Data that RFC-005 shows as text, such as a reference's stub, keeps that
  // text: picked out of it, a kept uri would lose the type that makes it a
  // reference, and be written out of the stub that hides it.
  // The kept fields are shown as the whole result claims (resultClaimsOf), so
  // a never elsewhere in it still withholds a kept link's uri. Where a value
  // stops that walk, such as a getter that throws, which the audit's JSON
  // doesn't read, what the rest claims is unknown, and nothing is kept.
  const claims = resultClaimsOf(fields);
  if (claims === null) return undefined;
  const whole = rfc005TextOf(fields) ?? toolResultDataToHistoryString(kept, undefined, { claims });
  if (!maxChars || whole.length <= maxChars) return whole;
  // Never half a surrogate pair: the stub goes to the provider as text, so
  // the cut can be one character short of the cap.
  const head = safeSlice(whole, 0, maxChars);
  return `${head} [cut: ${head.length} of these fields' ${whole.length} ` +
    'characters; the whole result is where this note says]';
}

interface PendingBatch {
  id: string;
  messageId: MessageId;
  content: ContentBlock[];
  withheld: ContentBlock[];
  branch: string;
  wireResults: ToolResult[];
  submitted: boolean;
  /** False when the audit sync failed: originals then never go on the wire. */
  durable: boolean;
  /** What each result's stub keeps if the batch is withheld, by its index in
   *  content: the fields its tool marked (keptWhenWithheld). */
  kept: Map<number, string>;
  notices: Map<string, WithheldNoticeKind>;
}

interface AuditOperation {
  record: Record<string, unknown>;
  /** Acceptance must finish this edit before its outcome can be recorded. */
  admission?: { messageId: MessageId; content: ContentBlock[]; expected: ContentBlock[]; branch: string };
  /** Retained while an acceptance edit needs retrying, not for audit-only retries. */
  heldMessageId?: MessageId;
}

/**
 * Admission of newly returned tool output to durable model-facing memory.
 *
 * Raw output is appended to a separate Chronicle audit slot BEFORE the
 * placeholder enters the context manager. In particular, onNewMessage and
 * speculative compression never see unaccepted output. Acceptance edits the
 * placeholder through CM's versioned edit API; withholding only appends an
 * audit event. Neither operation erases the original output or its blobs.
 */
export class ToolResultGuard {
  private pending: PendingBatch | undefined;
  private registered = false;
  private override: boolean | undefined;
  /** True until a recovery produces a clean response/new tool round. */
  recovering = false;
  /** Writes withheld originals where the agent can read them; without it,
   *  a stub names only the audit record. */
  private host: WithheldHost | undefined;
  /** Annotations of withheld stubs, chained in settlement order. */
  private annotating: Promise<void> | undefined;
  /** Annotations started so far, so a read can tell one began during it. */
  private annotationsStarted = 0;

  constructor(
    private readonly agentName: string,
    private readonly cm: ContextManager,
    private readonly configured = false,
  ) {}

  get enabled(): boolean { return this.override ?? this.configured; }
  setHost(host: WithheldHost | undefined): void { this.host = host; }
  /** Settles once every annotation started so far has finished: each of
   *  those stubs has been edited to say where its original is, or its edit
   *  failed and waits in the storage queue, retried in order until it lands
   *  or an operator's change supersedes it (until then the stub is the bare
   *  notice, kept out of summaries by its compression hold, and the audit
   *  record names the place). It never rejects. Each batch has one deadline
   *  for all its workspace writes; queued batches are annotated in order.
   *  A request may carry an unfinished-write notice once that deadline passes. */
  whenAnnotated(): Promise<void> { return this.annotating ?? Promise.resolve(); }

  /**
   * Runs `read` (a compile of the context) once no withheld stub is still
   * being annotated, and again if an annotation began while it ran, since a
   * settlement can land during the compile's own awaits, such as a previous
   * frame's teardown abandoning its batch. The framework's sent-request
   * compiles go through it: the agent's activations, its direct
   * API calls and their refusal retry, and a conversation fork's seed from its
   * template. A request preview doesn't, so it never waits on a
   * workspace write.
   *
   * Before `read`, a stub edit that failed gets another try with the rest of
   * the storage queue; a store that is still failing then compiles the bare
   * notice, which its hold keeps out of summaries.
   */
  async afterAnnotations<T>(read: () => Promise<T>): Promise<T> {
    for (;;) {
      // Counted before the wait, so an annotation that starts while this one
      // is awaited is waited for too.
      const started = this.annotationsStarted;
      await this.whenAnnotated();
      if (this.annotationsStarted !== started) continue;
      try {
        this.flushUnrecorded();
      } catch (error) {
        console.error(`[tool-result-guard] agent=${this.agentName} storage retry before a compile failed:`, error);
      }
      const result = await read();
      if (this.annotationsStarted === started) return result;
    }
  }

  /** No annotation is running and no storage work is queued: nothing of this
   *  guard is left for a host to wait on or retry. */
  get idle(): boolean { return this.annotating === undefined && this.unrecorded.length === 0; }
  setOverride(value: boolean | undefined): void { this.override = value; }
  get settingOverride(): boolean | undefined { return this.override; }
  get hasPending(): boolean { return this.pending !== undefined; }
  /** True only once the pending batch's originals were actually put on the
   * wire. Guard effects (retry suppression, refusal claim, prose buffering)
   * are scoped to this state; a merely staged batch never claims a refusal. */
  get hasSubmittedPending(): boolean { return this.pending?.submitted === true; }

  /** Extra input tokens the pending batch costs on the wire beyond the
   * placeholder the strategy selected against (chars/4 + flat per image,
   * the same heuristic as the physical-window projection). Compilation
   * reserves this so substituting originals cannot exceed the budget. */
  get pendingWireReserveTokens(): number {
    const pending = this.pending;
    if (!pending) return 0;
    let chars = 0;
    let images = 0;
    for (const result of pending.wireResults) {
      if (typeof result.content === 'string') chars += result.content.length;
      else for (const block of result.content as ContentBlock[]) {
        if (block.type === 'image') images += 1;
        else chars += JSON.stringify(block).length;
      }
      chars -= GUARD_NOTICES[pending.notices.get(result.toolUseId) ?? 'ran'].length;
    }
    return Math.max(0, Math.ceil(chars / 4) + images * 1600);
  }

  /** Ordered storage work, separate from batches awaiting a provider verdict.
   * A failed acceptance edit retains both the payload and its compression
   * hold here; it can never re-arm refusal handling or tool submission.
   * Any failed head, including an audit-only record, blocks later queued
   * edits and their holds until that operation succeeds. */
  private unrecorded: AuditOperation[] = [];

  /** Retry edits and audit writes before a new activation, a compile of a
   * request that is sent (afterAnnotations), an audit write, a maintenance
   * pass, or shutdown. A failed operation stays at the head. */
  flushUnrecorded(): void {
    try {
      while (this.unrecorded.length > 0) {
        const operation = this.unrecorded[0];
        try {
          this.applyEdit(operation);
          this.write(operation.record);
          this.unrecorded.shift();
        } finally {
          if (!operation.admission) this.releaseOperationHold(operation);
        }
      }
    } finally {
      this.host?.idle(this.idle);
    }
  }

  /** Make an operation's history edit, if it still has one: once it is made,
   *  or superseded by an operator's change, only its record is left to
   *  write, and its hold can go. */
  private applyEdit(operation: AuditOperation): void {
    if (!operation.admission) return;
    const { messageId, content, expected, branch } = operation.admission;
    const sameBranch = this.cm.currentBranch().name === branch;
    const current = sameBranch ? this.cm.getMessage(messageId) : null;
    // A retry must not undo an operator's later edit/removal/rollback.
    // Reapplying our own payload is safe if an earlier edit wrote the
    // message and then failed while propagating to context entries.
    // Chronicle drops undefined fields.
    if (!sameBranch || !current ||
      (!isDeepStrictEqual(current.content, JSON.parse(JSON.stringify(expected)))
        && !isDeepStrictEqual(current.content, JSON.parse(JSON.stringify(content))))) {
      operation.record.historyUpdate = 'superseded';
    } else {
      this.cm.editMessage(messageId, content);
    }
    // An audit-only retry must not repeat an edit that already succeeded.
    operation.admission = undefined;
  }

  private append(record: Record<string, unknown>): void {
    const stamped = { agentName: this.agentName, timestamp: Date.now(), ...record };
    this.unrecorded.push({ record: stamped });
    this.flushUnrecorded();
  }

  private write(record: Record<string, unknown>): void {
    const store = this.cm.getStore();
    if (!this.registered) {
      ensureStateRegistered(store, { id: TOOL_RESULT_GUARD_AUDIT_STATE, strategy: 'append_log' });
      this.registered = true;
    }
    store.appendToStateJson(TOOL_RESULT_GUARD_AUDIT_STATE, record);
  }

  private archive(value: unknown): unknown {
    const json = JSON.stringify(value);
    // Match inference-log storage: large payloads (especially images and
    // pre-spill output) must not be copied into every append-log snapshot.
    return json.length > 10_000
      ? { blobId: this.cm.getStore().storeBlob(Buffer.from(json), 'application/json') }
      : JSON.parse(json);
  }

  /** `keptCap` is where what a stub keeps of a withheld result is cut: the
   *  cap the caller stored `content` under, less the stub's notice room where
   *  its message's bound sets it (toolResultShare, tool-image-ledger.ts). */
  storeResults(
    content: ContentBlock[],
    wireResults: ToolResult[],
    originals: CompletedToolCall[],
    metadata: MessageMetadata | undefined,
    /** Where what a stub keeps is cut. */
    keptCap: number | undefined,
  ): MessageId {
    if (!this.enabled) return this.cm.addMessage('user', content, metadata);
    if (this.pending) {
      // Idempotent for the same not-yet-submitted batch: a caller that
      // retries after a failure between staging and submission (e.g. a
      // transient compile error on the direct Agent API) must not wedge.
      const same = !this.pending.submitted
        && this.pending.wireResults.map((r) => r.toolUseId).join('\0')
          === wireResults.map((r) => r.toolUseId).join('\0');
      if (same) return this.pending.messageId;
      throw new Error('Tool result guard already has a pending batch');
    }
    const id = randomUUID();
    // Includes full pre-truncation/error/image payloads, not just the wire
    // preview. This slot is audit data, never a context/compression source.
    const staged = { type: 'staged', batchId: id,
      originals: this.archive(originals), content: this.archive(content), wireResults: this.archive(wireResults) };
    try {
      this.append(staged);
    } catch (error) {
      // Keep the original in the retry queue, but let the tool loop continue
      // with a placeholder if the audit cannot become durable below.
      console.error(`[tool-result-guard] agent=${this.agentName} staged audit write queued:`, error);
    }
    const results = new Map(originals.map((call) => [call.id, call.result]));
    const notices = new Map([...results].map(([id, result]) => [id, noticeKind(result)]));
    const withheld: ContentBlock[] = content.map((block) => block.type === 'tool_result'
      ? { type: 'tool_result', toolUseId: block.toolUseId, content: GUARD_NOTICES[notices.get(block.toolUseId) ?? 'ran'], isError: block.isError }
      : block);
    // What each stub keeps if the batch is withheld, matched to its tool's
    // result by tool use id, keyed by index as the stubs and files are.
    const kept = new Map<number, string>();
    for (const [index, block] of content.entries()) {
      const result = block.type === 'tool_result' ? results.get(block.toolUseId) : undefined;
      const text = result ? keptWhenWithheld(result, keptCap) : undefined;
      if (text !== undefined) kept.set(index, text);
    }
    // Compression hold (CM >= 0.12): placed BEFORE onNewMessage fires, so no
    // chunk is ever summarized from the placeholder; released after the
    // settlement edit. Holds are in-memory only — a reopened manager has none,
    // which is correct since a reopened guard has no pending batch.
    const messageId = this.cm.addMessage('user', withheld, metadata, undefined, { holdCompression: true });
    this.pending = { id, messageId, content, withheld, wireResults,
      branch: this.cm.currentBranch().name, submitted: false, durable: false, kept, notices };
    // Durability barrier: the audit must reach Chronicle's chain heads before
    // the originals can go to a provider. On a failed sync the batch fails
    // CLOSED: the placeholders go on the wire instead (the turn continues,
    // nothing is stranded), and the batch later settles as unsubmitted.
    try {
      // A linked-append failure follows the same fail-closed path as a sync
      // failure. Throwing here would strand the stream awaiting its results.
      this.append({ type: 'linked', batchId: id, messageId });
      this.cm.getStore().sync();
      this.pending.durable = true;
    } catch (error) {
      console.error(`[tool-result-guard] agent=${this.agentName} audit persistence failed; ` +
        'submitting placeholders instead of originals:', error);
    }
    return messageId;
  }

  /** Results for a live continuation (provideToolResults). Marks the batch
   * submitted and returns the originals only when the audit is durable;
   * otherwise returns placeholder results and leaves it unsubmitted. */
  submissionResults(results: ToolResult[]): ToolResult[] {
    const pending = this.pending;
    if (!pending) return results;
    if (pending.durable) { pending.submitted = true; return results; }
    const ids = new Set(pending.wireResults.map((result) => result.toolUseId));
    return results.map((result) => ids.has(result.toolUseId)
      ? { ...result, content: GUARD_NOTICES[pending.notices.get(result.toolUseId) ?? 'ran'] } : result);
  }

  /** The stream carrying this batch ended without a clean round (abort or
   * exhausted errors). Settle conservatively — an interrupted submission
   * does not establish acceptance — so a later turn neither resubmits the
   * originals nor attributes its own refusal to this batch. */
  abandon(reason: string): void {
    const pending = this.pending;
    this.recovering = false;
    if (!pending) return;
    this.settle(pending, { type: 'withheld', reason, submitted: pending.submitted }, false);
  }


  /** A budget/error restart compiles placeholders; restore pending output
   * only in this provider request, never in the strategy's view. */
  prepareRequest(messages: NormalizedMessage[], recordSubmission = false): NormalizedMessage[] {
    const pending = this.pending;
    if (!pending || !pending.durable) return messages;
    const byId = new Map(pending.wireResults.map((result) => [result.toolUseId, result]));
    const present = new Set(messages.flatMap((message) => message.content
      .filter((block) => block.type === 'tool_result' && byId.has(block.toolUseId))
      .map((block) => (block as ContentBlock & { toolUseId: string }).toolUseId)));
    // A strategy may have folded the entire exchange away. Do not release
    // content that was never submitted. Its originals remain in the audit.
    const submitted = present.size === byId.size;
    if (recordSubmission) pending.submitted = submitted;
    if (!submitted) return messages;
    return messages.map((message) => ({ ...message, content: message.content.map((block) => {
      const result = block.type === 'tool_result' ? byId.get(block.toolUseId) : undefined;
      return result ? { type: 'tool_result', toolUseId: result.toolUseId, content: result.content, isError: result.isError } : block;
    }) }));
  }

  /** The turn ended (endTurn/skip_reply) before the batch was submitted:
   * nothing was refused, so admit it exactly as an unguarded agent would.
   * Leaving it pending would turn it into a permanent withheld notice on
   * restart and disable ordinary refusal handling on the next turn. */
  settleTurnEnded(): void {
    const pending = this.pending;
    if (!pending) return;
    this.settle(pending, pending.durable
      ? { type: 'accepted', reason: 'turn_ended' }
      : { type: 'withheld', reason: 'audit_not_durable' }, pending.durable);
  }

  /** A refusal arrived while the pending batch was never on the wire (the
   * strategy omitted the exchange). The guard cannot have caused it: record
   * the batch as withheld, clear it, and let ordinary refusal handling run.
   * Returns true when it settled such a batch. */
  settleUnsubmitted(category: string): boolean {
    const pending = this.pending;
    if (!pending || pending.submitted) return false;
    this.settle(pending, { type: 'withheld', reason: 'unsubmitted', category }, false);
    return true;
  }

  /** A clean physical response accepts precisely the last submitted batch. */
  accept(): void {
    const pending = this.pending;
    this.recovering = false;
    if (!pending) return;
    this.settle(pending, pending.submitted
      ? { type: 'accepted' } : { type: 'withheld', reason: 'unsubmitted' }, pending.submitted);
  }

  /** At most one recovery per batch; no scanning/deleting older history. */
  withhold(category: string): string[] | null {
    const pending = this.pending;
    if (!pending?.submitted) return null;
    const ids = pending.wireResults.map((result) => result.toolUseId);
    // Even a failed outcome-log write must never re-arm rejected output for
    // a later submission. Its originals were archived before admission.
    this.recovering = true;
    this.settle(pending, { type: 'withheld', toolUseIds: ids, category }, false);
    return ids;
  }

  /** Transfer ownership from provider admission to an ordered storage job.
   * Failure retains the accepted payload and its hold until the edit succeeds.
   * A withheld batch's hold passes to its annotation instead, and from there
   * to its stub's edit, so no summary is made of a stub that doesn't yet say
   * where its original went. */
  private settle(pending: PendingBatch, record: Record<string, unknown>, admit: boolean): void {
    this.pending = undefined;
    const operation: AuditOperation = {
      record: { agentName: this.agentName, timestamp: Date.now(), ...record,
        batchId: pending.id, messageId: pending.messageId, sourceBranch: pending.branch },
      ...(admit ? { admission: { messageId: pending.messageId, content: pending.content,
        expected: pending.withheld, branch: pending.branch } } : {}),
      heldMessageId: admit ? pending.messageId : undefined,
    };
    if (!admit) this.annotate(pending);
    this.unrecorded.push(operation);
    try {
      this.flushUnrecorded();
    } catch (error) {
      console.error(`[tool-result-guard] agent=${this.agentName} settlement queued for retry:`, error);
    } finally {
      if (!operation.admission) this.releaseOperationHold(operation);
    }
  }

  /**
   * Turn a withheld batch's notices into stubs that say where each original
   * is (agent-framework #277): written to the workspace when it has a
   * writable mount without an include, not configured direct, to take it, else kept in the audit
   * record. A stub also keeps the file
   * lists its tool marked. Its own unedited placeholder is
   * the only thing it edits: an operator's later edit, removal or rollback
   * stands.
   *
   * Where each original went is queued first, on its own ('annotated'), so
   * a stub edit that fails can't take the record of a written file with it.
   * The edit is then made at once, so no storage work queued ahead of it
   * holds it, not even that record if its write is failing, and its record
   * ('stub_updated') is written in order after the others. An
   * edit that fails joins the ordered storage queue like an admission's, with
   * the batch's compression hold: retried before the next activation, compile,
   * maintenance pass or stop until it lands or an operator's change supersedes
   * it. Until then the stub is the bare notice, which the hold keeps out of
   * summaries, and the audit record names the file.
   */
  private annotate(pending: PendingBatch): void {
    const previous = this.annotating ?? Promise.resolve();
    this.annotationsStarted += 1;
    // The batch's deadline runs from when it's queued, not from when the
    // batches ahead of it finish, so a request waiting on a chain of batches
    // waits at most one deadline past the latest one's arrival.
    let deadline = Infinity;
    try { deadline = this.host?.deadline() ?? Infinity; } catch { /* the spill then takes its own deadline, rather than losing the record */ }
    const run = previous.then(async () => {
      // Set once the stub's edit is queued with the hold: the queue releases
      // it when the edit lands or is superseded.
      let holdQueued = false;
      try {
        const date = new Date().toISOString().slice(0, 10);
        // A file is named by its batch and its place in the batch, ahead of
        // anything the writer may cut or substitute: results of one batch
        // never share a file, and results of two batches share one only if 48
        // random bits of their batch ids agree. The tool use id after them is
        // for whoever lists the directory.
        const batch = pending.id.replace(/-/g, '').slice(0, 12);
        // Keyed by the result's index in the batch, which the stub and the
        // original share.
        const spills = new Map<number, WithheldSpill>();
        // A spill that threw, by index: its error, for the record.
        const thrown = new Map<number, string>();
        // Set once the branch has changed: no more is written.
        let branchLeft = false;
        let deadlineSpent = false;
        for (const [index, block] of pending.content.entries()) {
          if (block.type !== 'tool_result') continue;
          // Once the store has left the batch's branch (a rollback, an undo, a
          // host's switch), write no more. This result and every later one is
          // skipped, and its original stays in the audit record. Nothing
          // yields from here to the edit's own branch check, so while the
          // store is away the stub stays as it is. A write already under way
          // when the branch changes is refused before its tree entry is set,
          // since it names the batch's branch. Once set, that entry stays on
          // its branch; its disk copy uses the mount's shared directory.
          if (branchLeft || this.cm.currentBranch().name !== pending.branch) {
            branchLeft = true;
            spills.set(index, { skipped: 'branch_changed' });
            continue;
          }
          // The result as stored. Both paths that store a tool result store
          // its text; content stored as blocks would be written as their JSON.
          const original = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          let spill: WithheldSpill = null;
          if (this.host) {
            try {
              spill = await this.host.spill(`${date}-withheld-${batch}-${index}-${block.toolUseId}`, original, pending.branch, deadline);
            } catch (error) {
              // The host reports a failed write rather than throwing; a throw
              // is recorded all the same, without a path.
              thrown.set(index, (error instanceof Error ? error.message : String(error)).slice(0, 200));
              console.error(`[tool-result-guard] agent=${this.agentName} could not spill withheld result ` +
                `${block.toolUseId}:`, error);
            }
          }
          // Declined where it would have committed, since the workspace had
          // left the batch's branch. Nothing was written, and no more are, as
          // for the results the branch check above stops. If the branch is
          // back by the edit, as after an undo and a redo, the stubs of this
          // result and the later ones name the audit record.
          if (spill && 'skipped' in spill && spill.skipped === 'branch_changed') branchLeft = true;
          // A batch that used its deadline is said once, here, where the
          // batch is known; the host returns the skip without a line.
          if (spill && 'skipped' in spill && spill.skipped === 'batch_deadline' && !deadlineSpent) {
            deadlineSpent = true;
            console.error(`[tool-result-guard] agent=${this.agentName} batch=${pending.id} used its deadline before all its originals were written; the rest name the audit record (batch_deadline)`);
          }
          spills.set(index, spill);
        }
        const annotated: ContentBlock[] = pending.withheld.map((block, index) => block.type === 'tool_result'
          ? { ...block, content: withheldResultNotice(spills.get(index) ?? null, pending.durable, pending.kept.get(index), pending.notices.get(block.toolUseId)) }
          : block);
        try {
          this.append({
            type: 'annotated', batchId: pending.id, messageId: pending.messageId, sourceBranch: pending.branch,
            results: pending.content.flatMap((block, index): Array<Record<string, string | true>> => {
              if (block.type !== 'tool_result') return [];
              if (thrown.has(index)) return [{ toolUseId: block.toolUseId, error: thrown.get(index)! }];
              const spill = spills.get(index) ?? null;
              // No file was written: no writable mount without an include
              // that isn't configured direct, or the framework was stopping.
              if (spill === null) return [{ toolUseId: block.toolUseId, skipped: 'no_workspace_file' }];
              if ('skipped' in spill) return [{ toolUseId: block.toolUseId, skipped: spill.skipped }];
              return [{ toolUseId: block.toolUseId, path: spill.path,
                ...(spill.error !== undefined ? { error: spill.error } : {}),
                ...(spill.unfinished ? { unfinished: true as const } : {}) }];
            }),
          });
        } catch (error) {
          // It stays queued and is retried in order with the storage work
          // ahead of it; the stub's record is written after it.
          console.error(`[tool-result-guard] agent=${this.agentName} batch=${pending.id} annotation record queued for retry:`, error);
        }
        const stub: AuditOperation = {
          record: { agentName: this.agentName, timestamp: Date.now(), type: 'stub_updated',
            batchId: pending.id, messageId: pending.messageId, sourceBranch: pending.branch },
          admission: { messageId: pending.messageId, content: annotated, expected: pending.withheld, branch: pending.branch },
          heldMessageId: pending.messageId,
        };
        try {
          this.applyEdit(stub);
        } catch (error) {
          console.error(`[tool-result-guard] agent=${this.agentName} batch=${pending.id} stub edit queued for retry:`, error);
        }
        this.unrecorded.push(stub);
        holdQueued = true;
        try {
          // A made edit's hold goes now, whatever storage work is still
          // queued ahead of its record.
          if (!stub.admission) this.releaseOperationHold(stub);
          this.flushUnrecorded();
        } catch (error) {
          console.error(`[tool-result-guard] agent=${this.agentName} batch=${pending.id} stub's storage work queued for retry:`, error);
        }
      } catch (error) {
        console.error(`[tool-result-guard] agent=${this.agentName} batch=${pending.id} could not annotate withheld results:`, error);
      } finally {
        // Never rejects: a compile and stop() wait on this chain. With no
        // stub edit queued, nothing else holds the batch.
        if (!holdQueued) {
          try {
            this.releaseHold(pending.messageId);
          } catch (error) {
            console.error(`[tool-result-guard] agent=${this.agentName} could not release a withheld batch's hold:`, error);
          }
        }
      }
    });
    this.annotating = run;
    void run.finally(() => {
      if (this.annotating === run) this.annotating = undefined;
      this.host?.idle(this.idle);
    });
    this.host?.track(run);
    this.host?.idle(false);
  }

  private releaseOperationHold(operation: AuditOperation): void {
    if (operation.heldMessageId !== undefined) {
      this.releaseHold(operation.heldMessageId);
      operation.heldMessageId = undefined;
    }
  }

  private releaseHold(messageId: MessageId): void {
    this.cm.releaseCompression([messageId]);
  }
}
