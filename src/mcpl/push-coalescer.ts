/** Runtime orchestration for RFC-006. The journal is authoritative; the projection
 * is rebuilt by the same reducer used after every live append. Timers and RPCs are
 * process-local effects, never facts reconstructed from a snapshot. */
import { randomUUID } from 'node:crypto';
import type { McplContentBlock, PushEventResult } from './types.js';
import {
  CoalescingProjection, replayCoalescingJournal, coalescingSubject, coalescingChannel, coalescingReceiptKey,
  type CoalescedPush, type CoalescingJournal, type CoalescingOperation, type CoalescingRecord,
  type PushRenderParams, type PushRenderResult,
} from './coalescing-journal.js';
export { coalescingSubject, coalescingChannel, coalescingReceiptKey } from './coalescing-journal.js';
export type { CoalescedPush, CoalescingJournal, CoalescingRecord, PushRenderParams, PushRenderResult } from './coalescing-journal.js';

export const PUSH_COALESCING_SUPPORT = {
  pushEvents: true, deferred: true, channelsIncoming: true, channelScopedPush: true,
} as const;
export interface CoalescerOptions {
  journal: CoalescingJournal;
  authorized(push: CoalescedPush): boolean;
  available?(push: CoalescedPush): boolean;
  render(push: CoalescedPush, params: PushRenderParams): Promise<PushRenderResult>;
  wake(push: CoalescedPush, subject: string): boolean;
  cancelWake(subject: string, consumed?: boolean): void;
  /** Route late observations to the currently active branch's journal. */
  observeLate?(detail: Record<string, unknown>): void;
  timeoutMs?: number;
  maxSubjects?: number;
  maxContentBytes?: number;
}
type PublishCoalesced = (push: CoalescedPush) => boolean | void;
interface RunningRender {
  id: string;
  subject: string;
  serverId: string;
  cancel(): void;
  done: Promise<void>;
  settled: boolean;
}
export class CoalesceError extends Error {
  constructor(readonly field: string, message: string, readonly code = -32602) { super(message); }
}

/** Validate wire content before it is stored, rendered, or converted. */
export function validateCoalescedContent(content: unknown, maxBytes = 1024 * 1024): asserts content is McplContentBlock[] {
  if (!Array.isArray(content)) throw new CoalesceError('payload.content', 'content must be an array');
  for (const b of content) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new CoalesceError('payload.content', 'invalid content block');
    if (b.type === 'text' && typeof b.text === 'string') continue;
    if (b.type === 'resource' && typeof b.uri === 'string') continue;
    if ((b.type === 'image' || b.type === 'audio') &&
        (typeof b.uri === 'string' || (typeof b.data === 'string' && typeof b.mimeType === 'string'))) continue;
    throw new CoalesceError('payload.content', 'invalid content block');
  }
  if (Buffer.byteLength(JSON.stringify(content)) > maxBytes) throw new CoalesceError('payload.content', 'content exceeds host byte limit');
}

export class PushCoalescer {
  private readonly projection: CoalescingProjection;
  private readonly renders = new Map<string, RunningRender>();
  private readonly queuedWakes = new Set<string>();
  private readonly publicationAttempts = new Set<string>();
  private suspended = false;
  private faulted = false;

  constructor(private readonly options: CoalescerOptions) {
    this.projection = replayCoalescingJournal(options.journal);
    // A prepared effect from a former process may already exist in context.
    for (const id of this.projection.publications.keys()) this.publicationAttempts.add(id);
  }

  /** Observation only: disposable, deterministic projection data for inspection. */
  inspect() {
    return structuredClone({ cursor: this.projection.cursor, uncertain: this.projection.uncertain,
      subjects: [...this.projection.subjects], receipts: [...this.projection.receipts],
      publications: [...this.projection.publications] });
  }

  /** Record the new process/branch boundary explicitly. Replaying the journal alone
   * performs no recovery writes, network requests, context writes, or wakes. */
  recover(branch?: string): void { this.commit({ kind: 'recovered', ...(branch === undefined ? {} : { branch }) }); }
  forgetHistory(): void { this.commit({ kind: 'history-unknown' }); }

  private authorized(push: CoalescedPush): boolean { return this.options.authorized(structuredClone(push)); }
  private available(push: CoalescedPush): boolean { return this.options.available?.(structuredClone(push)) ?? true; }

  private assertActive(): void {
    if (this.suspended) throw new CoalesceError('serverId', 'host is stopping', -32000);
    if (this.faulted) throw new Error('Coalescing journal append failed; rebuild the controller from the journal before continuing');
  }

  private commit(operation: CoalescingOperation): CoalescingRecord {
    this.assertActive();
    const index = this.projection.cursor;
    const record: CoalescingRecord = { version: 1, id: randomUUID(), at: Date.now(), operation: structuredClone(operation) };
    try {
      if (this.options.journal.length() !== index) throw new Error('Coalescing journal changed outside this controller');
      this.options.journal.append(record); // write-ahead and durable BEFORE any effect
      const committed = this.options.journal.read(index);
      if (committed.id !== record.id) throw new Error('Coalescing journal append identity mismatch');
      this.projection.apply(committed, index);
      // Cancellation follows the committed projection, never an independent flag.
      for (const render of this.renders.values()) {
        if (!this.isCurrentRender(render.subject, render.id)) render.cancel();
      }
      return committed;
    } catch (error) {
      // An append may have committed before the storage error. Never retry from a
      // guessed in-memory state; a fresh replay resolves that uncertainty.
      this.faulted = true;
      for (const render of this.renders.values()) render.cancel();
      for (const subject of this.projection.subjects.keys()) this.cancelWake(subject);
      throw error;
    }
  }

  observe(detail: Record<string, unknown>): void {
    if (!this.suspended) this.commit({ kind: 'observed', detail });
  }

  isRendering(serverId: string): boolean {
    return [...this.renders.values()].some(r => r.serverId === serverId && !r.settled);
  }
  private isCurrentRender(subject: string, id: string): boolean {
    return this.projection.subjects.get(subject)?.rendering?.id === id;
  }
  private pendingValue(subject: string): CoalescedPush | undefined {
    const state = this.projection.subjects.get(subject);
    return state?.slot?.push ?? state?.rendering?.slot.push ??
      [...this.projection.publications.values()].find(p => p.subject === subject)?.push;
  }
  pending(subject: string): CoalescedPush | undefined {
    const push = this.pendingValue(subject);
    return push && structuredClone(push);
  }
  pendingPushes(): CoalescedPush[] {
    return [...this.projection.subjects.keys()].flatMap(key => { const push = this.pending(key); return push ? [push] : []; });
  }
  canAssemble(audience: string): boolean {
    return this.pendingPushes().some(push => push.audience === audience &&
      this.available(push) && this.authorized(push));
  }
  identity(subject: string) {
    const state = this.projection.subjects.get(subject);
    const routing = (state?.slot ?? state?.rendering?.slot)?.push.routing;
    return structuredClone(routing
      ? { messageId: routing.messageId, author: routing.author, threadId: routing.threadId }
      : state?.identity);
  }
  occurrence(subject: string): string | undefined {
    const state = this.projection.subjects.get(subject);
    return (state?.slot ?? state?.rendering?.slot)?.push.params.eventId ?? state?.consumedEventId;
  }
  receipt(push: CoalescedPush): PushEventResult | undefined {
    this.assertActive();
    const key = coalescingReceiptKey(push);
    const ref = this.projection.receipts.get(key);
    if (!ref) return undefined;
    // The index stores only a journal position. The receipt itself is read from
    // the authoritative operation, not from a separately persisted lookup table.
    const op = this.options.journal.read(ref.record).operation;
    if (op.kind === 'accepted' && coalescingReceiptKey(op.push) === key) return structuredClone(op.result);
    if (op.kind === 'legacy-import' && ref.imported !== undefined && op.initial.receipts[ref.imported]?.key === key) {
      return structuredClone(op.initial.receipts[ref.imported].result);
    }
    throw new Error('Coalescing receipt projection does not match its journal record');
  }
  wakeRecovered(): void {
    if (this.suspended || this.faulted) return;
    for (const key of this.projection.subjects.keys()) {
      const push = this.pendingValue(key);
      if (push?.recovered && !this.queuedWakes.has(key) && this.authorized(push)) this.wake(key);
    }
  }
  private wake(subject: string): void {
    const push = this.pending(subject);
    if (push && this.options.wake(push, subject)) this.queuedWakes.add(subject);
    else this.queuedWakes.delete(subject);
  }
  private cancelWake(subject: string, consumed = false): void {
    this.queuedWakes.delete(subject);
    this.options.cancelWake(subject, consumed);
  }
  validate(push: CoalescedPush): void {
    this.assertActive();
    const { params } = push;
    const c = params.coalesce;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new CoalesceError('coalesce', 'coalesce must be an object');
    if (typeof c.key !== 'string' || !Buffer.byteLength(c.key) || Buffer.byteLength(c.key) > 256) {
      throw new CoalesceError('coalesce.key', 'key must be 1..256 UTF-8 bytes');
    }
    if (c.channelId !== undefined && (typeof c.channelId !== 'string' || !c.channelId))
      throw new CoalesceError('coalesce.channelId', 'channelId must be non-empty');
    if (push.channelMessage && ('channelId' in c || 'deferred' in c))
      throw new CoalesceError('coalesce', 'channel messages cannot select scope or deferred mode');
    for (const field of ['deferred', 'retract'] as const) {
      if (c[field] !== undefined && typeof c[field] !== 'boolean') throw new CoalesceError(`coalesce.${field}`, 'expected boolean');
    }
    if (c.deferred && c.retract) throw new CoalesceError('coalesce', 'deferred and retract are exclusive');
    if (c.data !== undefined && !c.deferred) throw new CoalesceError('coalesce.data', 'data requires deferred');
    if (c.data !== undefined && Buffer.byteLength(JSON.stringify(c.data)) > 4096) throw new CoalesceError('coalesce.data', 'data exceeds 4 KiB');
    if (typeof params.eventId !== 'string' || !params.eventId) throw new CoalesceError('eventId', 'eventId is required');
    if (typeof params.timestamp !== 'string') throw new CoalesceError('timestamp', 'timestamp is required');
    validateCoalescedContent(params.payload?.content, this.options.maxContentBytes);
    if (coalescingChannel(push) !== undefined && c.retract && !params.payload.content.length)
      throw new CoalesceError('payload.content', 'channel retractions require a deletion notice');
    if (!this.authorized(push)) throw new CoalesceError('featureSet', 'push is no longer authorized', -32002);
  }

  accept(push: CoalescedPush): PushEventResult {
    this.assertActive();
    this.validate(push);
    const duplicate = this.receipt(push);
    if (duplicate) return duplicate;
    const subject = coalescingSubject(push);
    if (!this.projection.subjects.has(subject)) {
      while (this.projection.subjects.size >= (this.options.maxSubjects ?? 128)) {
        const idle = [...this.projection.subjects].find(([key, state]) => !state.slot && !state.rendering &&
          ![...this.projection.publications.values()].some(p => p.subject === key));
        if (!idle) throw new CoalesceError('coalesce.key', 'host pending-subject limit reached', -32000);
        this.commit({ kind: 'forgotten', subject: idle[0] });
      }
    }
    const result = this.projection.resultFor(push);
    this.commit({ kind: 'accepted', push, result });
    if (this.projection.subjects.get(subject)?.slot) this.wake(subject);
    else if (!this.pendingValue(subject)) this.cancelWake(subject);
    return structuredClone(result);
  }

  /** The prepared operation is an irreversible assembly fence and durable outbox
   * intent. Context publication is idempotent; completion is another append. */
  private deliver(audience: string, publish: PublishCoalesced): void {
    for (const publication of [...this.projection.publications.values()]) {
      if (publication.push.audience !== audience || !this.available(publication.push)) continue;
      if (!this.authorized(publication.push)) {
        this.commit({ kind: 'delivered', publication: publication.id, disposition: 'suppressed' });
        this.publicationAttempts.delete(publication.id);
        continue;
      }
      const recovered = publication.push.recovered || this.publicationAttempts.has(publication.id);
      this.publicationAttempts.add(publication.id);
      const published = publish({ ...structuredClone(publication.push), publicationId: publication.id, recovered });
      this.commit({ kind: 'delivered', publication: publication.id, disposition: published === false ? 'suppressed' : 'published' });
      this.publicationAttempts.delete(publication.id);
    }
  }

  async assemble(audience: string, publish: PublishCoalesced): Promise<void> {
    if (this.suspended) return;
    this.assertActive();
    this.deliver(audience, publish);
    const selected = [...this.projection.subjects].filter(([, state]) => {
      const push = (state.slot ?? state.rendering?.slot)?.push;
      return push?.audience === audience && this.available(push);
    }).map(([key]) => key);
    await Promise.all(selected.map(async subject => {
      const state = this.projection.subjects.get(subject)!;
      if (state.rendering) {
        const running = this.renders.get(state.rendering.id);
        if (!running) throw new Error('Unfinished journal render requires recovery before assembly');
        await running.done;
        return;
      }
      if (!state.slot?.notices) return;
      if (!this.authorized(state.slot.push)) {
        this.commit({ kind: 'discarded', subject, target: { slot: state.slot.push.params.eventId }, reason: 'authority' });
        this.cancelWake(subject);
        return;
      }
      const record = this.commit({ kind: 'render-started', subject });
      this.cancelWake(subject, true);
      let cancel!: () => void;
      const cancelled = new Promise<'cancelled'>(resolve => { cancel = () => resolve('cancelled'); });
      const render: RunningRender = { id: record.id, subject, serverId: state.rendering!.slot.push.serverId,
        cancel, done: Promise.resolve(), settled: false };
      this.renders.set(render.id, render);
      render.done = this.runRender(render, cancelled);
      await render.done;
    }));
    if (this.suspended) return;
    this.assertActive();
    for (const subject of selected) {
      const slot = this.projection.subjects.get(subject)?.slot;
      if (!slot || slot.notices || slot.push.audience !== audience || !this.available(slot.push)) continue;
      const target = { slot: slot.push.params.eventId };
      if (this.authorized(slot.push)) this.commit({ kind: 'prepared', subject, target, push: slot.push, source: slot.push.params.coalesce?.deferred ? 'fallback' : 'plain' });
      else this.commit({ kind: 'discarded', subject, target, reason: 'authority' });
      this.cancelWake(subject, true);
    }
    this.deliver(audience, publish);
  }

  private async runRender(render: RunningRender, cancelled: Promise<'cancelled'>): Promise<void> {
    const { subject, id } = render;
    const slot = structuredClone(this.projection.subjects.get(subject)!.rendering!.slot);
    const push = slot.push;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const params: PushRenderParams = { featureSet: push.params.featureSet,
        ...(coalescingChannel(push) ? { channelId: coalescingChannel(push) } : {}), key: push.params.coalesce!.key,
        eventId: push.params.eventId, notices: slot.notices!, dropped: slot.dropped };
      const request = Promise.resolve().then(() => this.options.render(structuredClone(push), params)).then(result => {
        const detail = { kind: render.settled || !this.isCurrentRender(subject, id) ? 'late-render' : 'render-response',
          subject, renderId: id, result };
        if (this.options.observeLate) this.options.observeLate(detail);
        else this.observe(detail);
        return { result };
      }, error => ({ error: String(error) }));
      const response = await Promise.race([request, cancelled,
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.options.timeoutMs ?? 5000); })]);
      render.settled = true;
      if (this.suspended || response === 'cancelled' || !this.isCurrentRender(subject, id)) return;
      this.assertActive();
      const target = { render: id };
      if (!this.authorized(push)) {
        this.commit({ kind: 'discarded', subject, target, reason: 'authority', observation: response });
        return;
      }
      let content = push.params.payload.content;
      let timestamp = push.params.timestamp;
      let source: 'render' | 'fallback' = 'fallback';
      if (typeof response === 'object' && 'result' in response) {
        try {
          validateCoalescedContent(response.result.content, this.options.maxContentBytes);
          content = response.result.content;
          timestamp = typeof response.result.timestamp === 'string' ? response.result.timestamp : new Date().toISOString();
          source = 'render';
        } catch { /* The admitted fallback remains the bounded fail-open content. */ }
      }
      if (!content.length) this.commit({ kind: 'discarded', subject, target, reason: 'empty-render', observation: response });
      else this.commit({ kind: 'prepared', subject, target,
        push: { ...push, params: { ...push.params, timestamp, payload: { content } } }, source, observation: response });
    } finally {
      render.settled = true;
      clearTimeout(timer);
      this.renders.delete(id);
    }
  }

  disconnect(serverId: string): void {
    if (this.suspended) return;
    this.commit({ kind: 'disconnected', serverId });
    for (const subject of this.projection.subjects.keys()) {
      if (this.pendingValue(subject)?.serverId === serverId) this.cancelWake(subject);
    }
  }

  /** Stopping only cancels process-local effects. The next controller replays the
   * unchanged log and appends a recovery decision for unfinished work. */
  suspend(): void {
    this.suspended = true;
    for (const render of this.renders.values()) render.cancel();
    for (const subject of this.projection.subjects.keys()) this.cancelWake(subject);
  }
}
