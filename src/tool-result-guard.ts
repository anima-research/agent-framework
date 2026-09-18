import { randomUUID } from 'node:crypto';
import type { ContextManager, MessageId } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedMessage, ToolResult } from '@animalabs/membrane';
import type { CompletedToolCall } from './types/index.js';
import { isStateExistsError } from './module-registry.js';

export const TOOL_RESULT_GUARD_NOTICE = 'Tool result withheld by the guard. The tool has already executed.';
export const TOOL_RESULT_GUARD_AUDIT_STATE = 'framework/tool-result-guard';

interface PendingBatch {
  id: string;
  messageId: MessageId;
  content: ContentBlock[];
  wireResults: ToolResult[];
  submitted: boolean;
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

  constructor(
    private readonly agentName: string,
    private readonly cm: ContextManager,
    private readonly configured = false,
  ) {}

  get enabled(): boolean { return this.override ?? this.configured; }
  setOverride(value: boolean | undefined): void { this.override = value; }
  get settingOverride(): boolean | undefined { return this.override; }
  get hasPending(): boolean { return this.pending !== undefined; }

  private append(record: Record<string, unknown>): void {
    const store = this.cm.getStore();
    if (!this.registered) {
      try {
        store.registerState({ id: TOOL_RESULT_GUARD_AUDIT_STATE, strategy: 'append_log' });
      } catch (error) {
        if (!isStateExistsError(error)) throw error;
      }
      this.registered = true;
    }
    store.appendToStateJson(TOOL_RESULT_GUARD_AUDIT_STATE, {
      agentName: this.agentName, timestamp: Date.now(), ...record,
    });
  }

  private archive(value: unknown): unknown {
    const json = JSON.stringify(value);
    // Match inference-log storage: large payloads (especially images and
    // pre-spill output) must not be copied into every append-log snapshot.
    return json.length > 10_000
      ? { blobId: this.cm.getStore().storeBlob(Buffer.from(json), 'application/json') }
      : JSON.parse(json);
  }

  storeResults(content: ContentBlock[], wireResults: ToolResult[], originals: CompletedToolCall[]): MessageId {
    if (!this.enabled) return this.cm.addMessage('user', content);
    if (this.pending) throw new Error('Tool result guard already has a pending batch');
    const id = randomUUID();
    // Includes full pre-truncation/error/image payloads, not just the wire
    // preview. This slot is audit data, never a context/compression source.
    this.append({ type: 'staged', batchId: id,
      originals: this.archive(originals), content: this.archive(content), wireResults: this.archive(wireResults) });
    const withheld: ContentBlock[] = content.map((block) => block.type === 'tool_result'
      ? { type: 'tool_result', toolUseId: block.toolUseId, content: TOOL_RESULT_GUARD_NOTICE, isError: block.isError }
      : block);
    const messageId = this.cm.addMessage('user', withheld);
    this.pending = { id, messageId, content, wireResults, submitted: false };
    this.append({ type: 'linked', batchId: id, messageId });
    return messageId;
  }

  /** Live continuation submitted directly through provideToolResults. */
  markSubmitted(): void { if (this.pending) this.pending.submitted = true; }

  /** A budget/error restart compiles placeholders; restore pending output
   * only in this provider request, never in the strategy's view. */
  prepareRequest(messages: NormalizedMessage[], recordSubmission = false): NormalizedMessage[] {
    const pending = this.pending;
    if (!pending) return messages;
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

  /** A clean physical response accepts precisely the last submitted batch. */
  accept(): void {
    const pending = this.pending;
    if (pending) {
      this.append({ type: pending.submitted ? 'accepted' : 'withheld', batchId: pending.id, messageId: pending.messageId });
      if (pending.submitted) this.cm.editMessage(pending.messageId, pending.content);
      this.pending = undefined;
    }
    this.recovering = false;
  }

  /** At most one recovery per batch; no scanning/deleting older history. */
  withhold(category: string): string[] | null {
    const pending = this.pending;
    if (!pending?.submitted) return null;
    const ids = pending.wireResults.map((result) => result.toolUseId);
    // Even a failed outcome-log write must never re-arm rejected output for
    // a later submission. Its originals were archived before admission.
    this.pending = undefined;
    this.recovering = true;
    this.append({ type: 'withheld', batchId: pending.id, messageId: pending.messageId, toolUseIds: ids, category });
    return ids;
  }
}
