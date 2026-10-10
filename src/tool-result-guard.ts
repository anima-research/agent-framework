import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedMessage, ToolResult } from '@animalabs/membrane';
import type { CompletedToolCall } from './types/index.js';
import { isStateExistsError } from './module-registry.js';

export const TOOL_RESULT_GUARD_NOTICE = 'Tool result withheld by the guard. The tool has already executed.';
export const TOOL_RESULT_GUARD_AUDIT_STATE = 'framework/tool-result-guard';

/** Where a withheld result's original was written: a workspace path, the
 *  path a write to it failed at, or null when there is no writable workspace. */
export type WithheldSpill = { path: string; error?: string } | null;

/** Writes one withheld original as a workspace file (the framework's
 *  tool-results spill). It reports a failed write rather than throwing. */
export type WithheldSpiller = (label: string, text: string) => Promise<WithheldSpill>;

/** What a host gives a guard for its withheld results: where originals are
 *  written, and where each annotation is registered, so the host's stop can
 *  wait for it even after the agent itself was disposed. */
export interface WithheldHost {
  spill: WithheldSpiller;
  track(annotation: Promise<void>): void;
}

/**
 * The stub a withheld result settles to: #159's neutral notice, then where
 * the original is. It names no refusal and no category (#159 keeps those in
 * operational logs), only the place, so reading it back is the agent's
 * deliberate choice (agent-framework #277).
 */
export function withheldResultNotice(spill: WithheldSpill, auditDurable: boolean): string {
  const audit = auditDurable
    ? `the guard's audit record (${TOOL_RESULT_GUARD_AUDIT_STATE}), for an operator`
    : `the guard's audit record (${TOOL_RESULT_GUARD_AUDIT_STATE}), for an operator, though saving that record had failed when this was written`;
  if (spill && spill.error === undefined) {
    return `${TOOL_RESULT_GUARD_NOTICE} Its full result is in workspace file ${spill.path}.`;
  }
  if (spill) {
    return `${TOOL_RESULT_GUARD_NOTICE} Writing its full result to workspace file ${spill.path} failed (${spill.error}), ` +
      `so it is kept only in ${audit}.`;
  }
  return `${TOOL_RESULT_GUARD_NOTICE} Its full result is kept in ${audit}.`;
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

  constructor(
    private readonly agentName: string,
    private readonly cm: ContextManager,
    private readonly configured = false,
  ) {}

  get enabled(): boolean { return this.override ?? this.configured; }
  setHost(host: WithheldHost | undefined): void { this.host = host; }
  /** Settles once every withheld stub settled so far names where its
   *  original is (or that edit was given up). A request is compiled only
   *  after this, so no request carries a stub that is still being written. */
  whenAnnotated(): Promise<void> { return this.annotating ?? Promise.resolve(); }
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
      chars -= TOOL_RESULT_GUARD_NOTICE.length;
    }
    return Math.max(0, Math.ceil(chars / 4) + images * 1600);
  }

  /** Ordered storage work, separate from batches awaiting a provider verdict.
   * A failed acceptance edit retains both the payload and its compression
   * hold here; it can never re-arm refusal handling or tool submission. */
  private unrecorded: AuditOperation[] = [];

  /** Retry edits and audit writes before a new activation, audit write,
   * maintenance pass, or shutdown. A failed operation stays at the head. */
  flushUnrecorded(): void {
    while (this.unrecorded.length > 0) {
      const operation = this.unrecorded[0];
      try {
        if (operation.admission) {
          const { messageId, content, expected, branch } = operation.admission;
          const sameBranch = this.cm.currentBranch().name === branch;
          const current = sameBranch ? this.cm.getMessage(messageId) : null;
          // A retry must not undo an operator's later edit/removal/rollback.
          // Reapplying our own payload is safe if an earlier edit wrote the
          // message and then failed while propagating to context entries.
          // Chronicle normalizes object-key order and drops undefined fields.
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
        this.write(operation.record);
        this.unrecorded.shift();
      } finally {
        if (!operation.admission) this.releaseOperationHold(operation);
      }
    }
  }

  private append(record: Record<string, unknown>): void {
    const stamped = { agentName: this.agentName, timestamp: Date.now(), ...record };
    this.unrecorded.push({ record: stamped });
    this.flushUnrecorded();
  }

  private write(record: Record<string, unknown>): void {
    const store = this.cm.getStore();
    if (!this.registered) {
      try {
        store.registerState({ id: TOOL_RESULT_GUARD_AUDIT_STATE, strategy: 'append_log' });
      } catch (error) {
        if (!isStateExistsError(error)) throw error;
      }
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

  storeResults(
    content: ContentBlock[],
    wireResults: ToolResult[],
    originals: CompletedToolCall[],
    metadata?: MessageMetadata,
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
    const withheld: ContentBlock[] = content.map((block) => block.type === 'tool_result'
      ? { type: 'tool_result', toolUseId: block.toolUseId, content: TOOL_RESULT_GUARD_NOTICE, isError: block.isError }
      : block);
    // Compression hold (CM >= 0.12): placed BEFORE onNewMessage fires, so no
    // chunk is ever summarized from the placeholder; released after the
    // settlement edit. Holds are in-memory only — a reopened manager has none,
    // which is correct since a reopened guard has no pending batch.
    const messageId = this.cm.addMessage('user', withheld, metadata, undefined, { holdCompression: true });
    this.pending = { id, messageId, content, withheld, wireResults,
      branch: this.cm.currentBranch().name, submitted: false, durable: false };
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
      ? { ...result, content: TOOL_RESULT_GUARD_NOTICE } : result);
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
   * A withheld batch's hold passes to its annotation instead, so no summary
   * is made of a stub that doesn't yet say where its original went. */
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
   * is (agent-framework #277): written to the workspace when a writable mount
   * takes it, else kept in the audit record. Its own unedited placeholder is
   * the only thing it edits: an operator's later edit, removal or rollback
   * stands. It releases the compression hold when done, whatever happened.
   */
  private annotate(pending: PendingBatch): void {
    const previous = this.annotating ?? Promise.resolve();
    const run = previous.then(async () => {
      try {
        const date = new Date().toISOString().slice(0, 10);
        const spills = new Map<string, WithheldSpill>();
        for (const block of pending.content) {
          if (block.type !== 'tool_result') continue;
          const original = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          let spill: WithheldSpill = null;
          if (this.host) {
            try {
              spill = await this.host.spill(`${date}-withheld-${block.toolUseId}`, original);
            } catch (error) {
              console.error(`[tool-result-guard] agent=${this.agentName} could not spill withheld result ` +
                `${block.toolUseId}:`, error);
            }
          }
          spills.set(block.toolUseId, spill);
        }
        const annotated: ContentBlock[] = pending.withheld.map((block) => block.type === 'tool_result'
          && spills.has(block.toolUseId)
          ? { ...block, content: withheldResultNotice(spills.get(block.toolUseId)!, pending.durable) }
          : block);
        const sameBranch = this.cm.currentBranch().name === pending.branch;
        const current = sameBranch ? this.cm.getMessage(pending.messageId) : null;
        const unedited = current !== null && current !== undefined
          && isDeepStrictEqual(current.content, JSON.parse(JSON.stringify(pending.withheld)));
        if (unedited) this.cm.editMessage(pending.messageId, annotated);
        this.append({
          type: 'annotated', batchId: pending.id, messageId: pending.messageId,
          results: [...spills].map(([toolUseId, spill]) => ({
            toolUseId, ...(spill ? { path: spill.path } : {}), ...(spill?.error !== undefined ? { error: spill.error } : {}),
          })),
          ...(unedited ? {} : { historyUpdate: 'superseded' }),
        });
      } catch (error) {
        console.error(`[tool-result-guard] agent=${this.agentName} could not annotate withheld results:`, error);
      } finally {
        // Never rejects: a compile and stop() wait on this chain.
        try {
          this.releaseHold(pending.messageId);
        } catch (error) {
          console.error(`[tool-result-guard] agent=${this.agentName} could not release a withheld batch's hold:`, error);
        }
      }
    });
    this.annotating = run;
    void run.finally(() => { if (this.annotating === run) this.annotating = undefined; });
    this.host?.track(run);
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
