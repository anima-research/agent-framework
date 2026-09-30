/** RFC-006 event coalescing. Both delivery lanes share this state machine. Pending content never enters a context manager:
 * compression, forks, and tool continuations can only see materialized history.
 * All state transitions are synchronous; only deferred rendering yields. */
import type { McplContentBlock, PushEventParams, PushEventResult, ChannelIncomingMessage } from './types.js';

export const PUSH_COALESCING_SUPPORT = {
  pushEvents: true, deferred: true, channelsIncoming: true, channelScopedPush: true,
} as const;

export interface CoalescedPush {
  /** Host-only recovery marker: never read from wire params or origin. */
  recovered?: boolean;
  serverId: string;
  /** Host-owned configured binding; changes when the endpoint/command is reassigned. */
  binding?: string;
  epoch: string;
  audience: string;
  params: PushEventParams;
  channelMessage?: ChannelIncomingMessage;
  /** Host-resolved delivery, independent of the untrusted coalescing scope. */
  routing?: {
    channelId?: string; messageId?: string; author?: { id: string; name: string };
    threadId?: string; metadata?: Record<string, unknown>;
    targetAgents: string[]; triggerAllowed?: boolean; generation?: number;
  };
}
export interface PushRenderParams {
  channelId?: string;
  featureSet: string;
  key: string;
  eventId: string;
  notices: Array<{ eventId: string; timestamp: string; data?: unknown }>;
  dropped: number;
}
export interface PushRenderResult { content: McplContentBlock[]; timestamp?: string }
interface Slot {
  push: CoalescedPush;
  notices?: PushRenderParams['notices'];
  dropped: number;
}
interface Rendering {
  slot: Slot;
  cancelled: boolean;
  cancel: () => void;
  done: Promise<void>;
}
type MessageIdentity = Pick<NonNullable<CoalescedPush['routing']>, 'messageId' | 'author' | 'threadId'>;
interface Subject {
  identity?: MessageIdentity;
  history: 'none' | 'some' | 'unknown';
  consumedEventId?: string;
  slot?: Slot;
  rendering?: Rendering;
  wakeQueued: boolean;
}
export interface CoalescingSnapshot {
  version: 1 | 2;
  receipt?: [string, PushEventResult];
  history?: Array<{ key: string; history: Subject['history']; consumedEventId?: string; identity?: MessageIdentity }>;
  /** Pending fallbacks remain replaceable after recovery; old renders are not replayed. */
  pending: CoalescedPush[];
}
export interface CoalescerOptions {
  authorized(push: CoalescedPush): boolean;
  available?(push: CoalescedPush): boolean;
  lookupReceipt?(key: string): PushEventResult | undefined;
  recordReceipt?(key: string, result: PushEventResult): void;
  render(push: CoalescedPush, params: PushRenderParams): Promise<PushRenderResult>;
  /** Evaluate host policy and queue at most one wake; false may mean a gate timer. */
  wake(push: CoalescedPush, subject: string): boolean;
  cancelWake(subject: string, consumed?: boolean): void;
  audit(record: Record<string, unknown>): void;
  save(snapshot: CoalescingSnapshot): void;
  timeoutMs?: number;
  maxSubjects?: number;
  maxContentBytes?: number;
  historyUnknown?: boolean;
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

/** A configured server binding survives transport reconnects. Epoch gates authority,
 * not subject or occurrence identity. Channel scope is NEVER inferred from origin. */
export function coalescingChannel(push: CoalescedPush): string | undefined {
  return push.channelMessage?.channelId ?? push.params.coalesce?.channelId;
}
export function coalescingSubject(push: CoalescedPush): string {
  const channel = coalescingChannel(push);
  return JSON.stringify([push.serverId, push.binding ?? '', channel === undefined ? 'featureSet' : 'channel',
    channel ?? push.params.featureSet, push.params.coalesce!.key]);
}

export class PushCoalescer {
  private subjects = new Map<string, Subject>();
  private receipts = new Map<string, PushEventResult>();
  private uncertain = false;
  private lastReceipt?: [string, PushEventResult];
  private activeRenders = new Map<string, number>();
  private suspended = false;
  constructor(private readonly options: CoalescerOptions) { this.uncertain = options.historyUnknown ?? false; }

  isRendering(serverId: string): boolean { return (this.activeRenders.get(serverId) ?? 0) > 0; }

  restore(snapshot: CoalescingSnapshot | CoalescedPush[]): void {
    this.uncertain = true;
    if (!Array.isArray(snapshot)) {
      if (snapshot.receipt) {
        this.lastReceipt = snapshot.receipt;
        this.receipts.set(...snapshot.receipt);
        this.options.recordReceipt?.(...snapshot.receipt);
      }
      for (const { key, history, consumedEventId, identity } of snapshot.history ?? []) {
        this.subjects.set(key, { history, consumedEventId, identity, wakeQueued: false });
      }
    }
    for (const original of Array.isArray(snapshot) ? snapshot : snapshot.pending) {
      const push = { ...structuredClone(original), recovered: true };
      const key = coalescingSubject(push);
      const state = this.subjects.get(key) ?? { history: 'unknown' as const, wakeQueued: false };
      // A frozen batch and its newer pending batch are both unread. Recovery keeps
      // the latest self-contained fallback, without replaying either render.
      state.slot = { push, dropped: 0 };
      this.subjects.set(key, state);
    }
    this.save();
  }

  canAssemble(audience: string): boolean {
    return this.pendingPushes().some(push => push.audience === audience &&
      (this.options.available?.(push) ?? true) && this.options.authorized(push));
  }

  pendingPushes(): CoalescedPush[] { return [...this.subjects.values()].flatMap(s => s.slot ? [s.slot.push] : []); }

  pending(subject: string): CoalescedPush | undefined {
    return this.subjects.get(subject)?.slot?.push;
  }

  identity(subject: string): MessageIdentity | undefined {
    const state = this.subjects.get(subject);
    const routing = (state?.slot ?? state?.rendering?.slot)?.push.routing;
    return routing ? { messageId: routing.messageId, author: routing.author, threadId: routing.threadId } : state?.identity;
  }

  occurrence(subject: string): string | undefined {
    const state = this.subjects.get(subject);
    return (state?.slot ?? state?.rendering?.slot)?.push.params.eventId ?? state?.consumedEventId;
  }

  receipt(push: CoalescedPush): PushEventResult | undefined {
    const key = JSON.stringify([push.serverId, push.binding ?? '', push.params.eventId]);
    const result = this.receipts.get(key) ?? this.options.lookupReceipt?.(key);
    return result && structuredClone(result);
  }

  wakeRecovered(): void {
    if (this.suspended) return;
    for (const [key, s] of this.subjects) {
      if (s.slot?.push.recovered && !s.wakeQueued && this.options.authorized(s.slot.push)) {
        s.wakeQueued = this.options.wake(s.slot.push, key);
      }
    }
  }

  validate(push: CoalescedPush): void {
    if (this.suspended) throw new CoalesceError('serverId', 'host is stopping', -32000);
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
    if (!this.options.authorized(push)) throw new CoalesceError('featureSet', 'push is no longer authorized', -32002);
  }

  accept(push: CoalescedPush): PushEventResult {
    if (this.suspended) throw new CoalesceError('serverId', 'host is stopping', -32000);
    this.validate(push);
    const { params } = push;
    const c = params.coalesce!;
    const receipt = this.receipt(push);
    if (receipt) return receipt;
    const dedup = JSON.stringify([push.serverId, push.binding ?? '', params.eventId]);
    const key = coalescingSubject(push);
    let s = this.subjects.get(key);
    if (!s) {
      while (this.subjects.size >= (this.options.maxSubjects ?? 128)) {
        const idle = [...this.subjects].find(([, v]) => !v.slot && !v.rendering);
        if (!idle) throw new CoalesceError('coalesce.key', 'host pending-subject limit reached', -32000);
        this.subjects.delete(idle[0]);
        this.uncertain = true;
      }
      s = { history: this.uncertain || c.retract ? 'unknown' : 'none', wakeQueued: false };
      this.subjects.set(key, s);
    }
    // Snapshot wire objects: later caller mutation must not alter admitted content.
    push = structuredClone(push);
    this.options.audit({ kind: 'received', subject: key, push });
    const prior = s.slot ?? s.rendering?.slot;
    const priorId = prior?.push.params.eventId ?? s.consumedEventId;
    let outcome: NonNullable<PushEventResult['coalesce']>['outcome'];
    // This profile has one recipient. A replacement cannot move into a different
    // agent/branch even when the operator changes the current primary or branch.
    const sameAudience = !prior || prior.push.audience === push.audience &&
      JSON.stringify(prior.push.routing?.metadata?.tuneOut ?? null) === JSON.stringify(push.routing?.metadata?.tuneOut ?? null);
    if (c.retract || !c.deferred) {
      this.cancelRender(s);
      if (prior) this.options.audit({ kind: 'displaced', subject: key, push: prior.push });
      s.slot = undefined; // supersedes BOTH rendering and newer pending batch
      if (c.retract) {
        s.consumedEventId = undefined;
        outcome = s.history === 'none' ? 'retracted' : params.payload.content.length ? 'noted' : 'consumed';
        if (outcome === 'noted' && sameAudience && push.audience) s.slot = { push, dropped: 0 };
      } else {
        outcome = prior ? 'replaced' : s.consumedEventId || s.history === 'unknown' ? 'appended' : 'first';
        if (sameAudience && push.audience) s.slot = { push, dropped: 0 };
      }
    } else {
      const pending = s.slot;
      outcome = pending ? 'replaced' : 'first';
      if (pending) this.options.audit({ kind: pending.notices ? 'folded' : 'displaced', subject: key, push: pending.push });
      if (sameAudience && push.audience) {
        const notices = pending?.notices ?? [];
        notices.push({ eventId: params.eventId, timestamp: params.timestamp, ...(c.data !== undefined ? { data: structuredClone(c.data) } : {}) });
        let dropped = pending?.dropped ?? 0;
        if (notices.length > 64) { notices.shift(); dropped++; }
        s.slot = { push, notices, dropped };
      } else s.slot = undefined;
    }
    if (push.routing && coalescingChannel(push)) {
      s.identity = { messageId: push.routing.messageId, author: push.routing.author, threadId: push.routing.threadId };
    }
    const result: PushEventResult = { accepted: true, coalesce: { outcome, ...(priorId ? { priorEventId: priorId } : {}) } };
    this.lastReceipt = [dedup, result];
    this.receipts.set(dedup, result);
    if (this.receipts.size > 4096) this.receipts.delete(this.receipts.keys().next().value!);
    this.save();
    this.options.recordReceipt?.(dedup, result);
    if (s.slot) s.wakeQueued = this.options.wake(s.slot.push, key);
    if (!s.slot && !s.rendering) { s.wakeQueued = false; this.options.cancelWake(key); }
    return structuredClone(result);
  }

  /** Await only batches present at this assembly. Then publish and seal synchronously,
   * before context compilation can expose content to any model or compressor. */
  async assemble(audience: string, publish: (push: CoalescedPush) => void): Promise<void> {
    if (this.suspended) return;
    const selected = [...this.subjects].filter(([, s]) => { const push = (s.slot ?? s.rendering?.slot)?.push; return push?.audience === audience && (this.options.available?.(push) ?? true); });
    await Promise.all(selected.map(async ([key, s]) => {
      if (s.rendering) { await s.rendering.done; return; }
      if (!s.slot?.notices) return;
      const slot = s.slot;
      s.slot = undefined;
      s.wakeQueued = false;
      this.options.cancelWake(key, true);
      let cancel!: () => void;
      const cancelled = new Promise<'cancelled'>(resolve => { cancel = () => resolve('cancelled'); });
      const rendering: Rendering = { slot, cancel, cancelled: false, done: Promise.resolve() };
      s.rendering = rendering;
      rendering.done = this.render(key, s, rendering, cancelled, publish);
      this.save();
      await rendering.done;
    }));
    if (this.suspended) return;
    for (const [key, s] of selected) {
      const slot = s.slot;
      if (!slot || slot.notices || slot.push.audience !== audience) continue;
      if (!(this.options.available?.(slot.push) ?? true)) continue;
      if (!this.options.authorized(slot.push)) {
        this.options.audit({ kind: 'revoked', subject: key, push: slot.push });
      } else {
        publish(slot.push);
        s.history = 'some';
        s.consumedEventId = slot.push.params.eventId;
        this.options.audit({ kind: 'consumed', subject: key, eventId: slot.push.params.eventId });
      }
      s.slot = undefined;
      s.wakeQueued = false;
      this.options.cancelWake(key, true);
    }
    this.save();
  }

  private async render(key: string, s: Subject, r: Rendering, cancelled: Promise<'cancelled'>, publish: (push: CoalescedPush) => void): Promise<void> {
    const push = r.slot.push;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const count = this.activeRenders.get(push.serverId) ?? 0;
    this.activeRenders.set(push.serverId, count + 1);
    try {
      if (!this.options.authorized(push)) return;
      const params: PushRenderParams = { featureSet: push.params.featureSet, ...(coalescingChannel(push) ? { channelId: coalescingChannel(push) } : {}), key: push.params.coalesce!.key,
        eventId: push.params.eventId, notices: r.slot.notices!, dropped: r.slot.dropped };
      const request = Promise.resolve().then(() => this.options.render(push, structuredClone(params)))
        .then(result => {
          if (!this.suspended && (finished || r.cancelled)) this.options.audit({ kind: 'late-render', subject: key, result });
          return { result };
        }, error => ({ error: String(error) }));
      const response = await Promise.race([request, cancelled,
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.options.timeoutMs ?? 5000); })]);
      finished = true;
      if (r.cancelled || response === 'cancelled') return;
      if (!this.options.authorized(push)) { this.options.audit({ kind: 'revoked', subject: key, push }); return; }
      let content = push.params.payload.content;
      let timestamp = push.params.timestamp;
      if (typeof response === 'object' && 'result' in response) {
        try {
          validateCoalescedContent(response.result.content, this.options.maxContentBytes);
          content = response.result.content;
          timestamp = typeof response.result.timestamp === 'string' ? response.result.timestamp : new Date().toISOString();
        } catch { /* Invalid render content uses the admitted fallback. */ }
      }
      this.options.audit({ kind: 'rendered', subject: key, response, fallback: push.params.payload.content, content });
      if (!content.length) return;
      const materialized = { ...push, params: { ...push.params, timestamp, payload: { content: structuredClone(content) } } };
      // Publication and consumption are one synchronous assembly step. A newer
      // pending batch is untouched and remains for the next assembly.
      publish(materialized);
      s.history = 'some';
      s.consumedEventId = push.params.eventId;
      this.options.audit({ kind: 'consumed', subject: key, eventId: push.params.eventId });
    } finally {
      finished = true;
      clearTimeout(timer);
      const remaining = (this.activeRenders.get(push.serverId) ?? 1) - 1;
      if (remaining > 0) this.activeRenders.set(push.serverId, remaining);
      else this.activeRenders.delete(push.serverId);
      if (s.rendering === r) s.rendering = undefined;
      this.save();
    }
  }

  private cancelRender(s: Subject): void {
    if (s.rendering) {
      if (!this.suspended) this.options.audit({ kind: 'render-cancelled', push: s.rendering.slot.push });
      s.rendering.cancelled = true;
      s.rendering.cancel();
      s.rendering = undefined;
    }
  }
  private save(): void {
    if (this.suspended) return;
    const pending: CoalescedPush[] = [];
    for (const s of this.subjects.values()) {
      if (s.rendering) pending.push(s.rendering.slot.push);
      if (s.slot) pending.push(s.slot.push);
    }
    this.options.save({ version: 2, receipt: this.lastReceipt, pending: structuredClone(pending), history: [...this.subjects].map(([key, s]) => ({key, history: s.history, consumedEventId: s.consumedEventId, identity: s.identity})) });
  }

  /** Transport loss cancels rendering but preserves acknowledged unread work. The
   * next initialized connection must reauthorize it before delivery or replacement. */
  disconnect(serverId: string): void {
    if (this.suspended) return;
    for (const [key, s] of this.subjects) {
      const slot = s.slot ?? s.rendering?.slot;
      if (slot?.push.serverId !== serverId) continue;
      this.options.audit({ kind: 'disconnected', subject: key, push: slot.push });
      this.cancelRender(s);
      s.slot = { push: { ...slot.push, recovered: true }, dropped: 0 };
      s.wakeQueued = false;
      this.options.cancelWake(key);
    }
    this.save();
  }

  /** Clean shutdown preserves the same pending fallbacks as a crash snapshot. */
  suspend(): void {
    this.save();
    this.suspended = true;
    for (const [key, s] of this.subjects) {
      this.cancelRender(s);
      this.options.cancelWake(key);
    }
  }
}
