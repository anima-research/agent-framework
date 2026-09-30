/** RFC-006 feature-set push profile. Pending content never enters a context manager:
 * compression, forks, and tool continuations can only see materialized history.
 * All state transitions are synchronous; only deferred rendering yields. */
import type { McplContentBlock, PushEventParams, PushEventResult } from './types.js';

export const PUSH_COALESCING_SUPPORT = {
  pushEvents: true, deferred: true, channelsIncoming: false, channelScopedPush: false,
} as const;

export interface CoalescedPush {
  /** Host-only recovery marker: never read from wire params or origin. */
  recovered?: boolean;
  serverId: string;
  epoch: string;
  audience: string;
  params: PushEventParams;
}
export interface PushRenderParams {
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
interface Subject {
  history: 'none' | 'some' | 'unknown';
  consumedEventId?: string;
  slot?: Slot;
  rendering?: Rendering;
  wakeQueued: boolean;
}
export interface CoalescingSnapshot {
  version: 1;
  /** Recovery is append-only: fallbacks, never replay of a source-backed render. */
  pending: CoalescedPush[];
}
export interface CoalescerOptions {
  authorized(push: CoalescedPush): boolean;
  render(push: CoalescedPush, params: PushRenderParams): Promise<PushRenderResult>;
  /** Evaluate host policy and queue at most one wake; false may mean a gate timer. */
  wake(push: CoalescedPush, subject: string): boolean;
  cancelWake(subject: string): void;
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

export class PushCoalescer {
  private subjects = new Map<string, Subject>();
  private receipts = new Map<string, PushEventResult>();
  private uncertain = false;
  private activeRenders = new Map<string, number>();
  private suspended = false;
  constructor(private readonly options: CoalescerOptions) { this.uncertain = options.historyUnknown ?? false; }

  isRendering(serverId: string): boolean { return (this.activeRenders.get(serverId) ?? 0) > 0; }

  restore(pending: CoalescedPush[]): void {
    this.uncertain = true;
    for (const original of pending) {
      const push = { ...structuredClone(original), recovered: true };
      // Recovery appends fallbacks conservatively, without re-rendering or
      // pretending we know whether a previous model consumed this subject.
      const key = JSON.stringify(['recovered', push.serverId, push.epoch, push.params.eventId, push.audience]);
      this.subjects.set(key, { history: 'unknown', wakeQueued: false, slot: { push, dropped: 0 } });
    }
    this.save();
  }

  wakeRecovered(): void {
    for (const [key, s] of this.subjects) {
      if (s.slot?.push.recovered && !s.wakeQueued && this.options.authorized(s.slot.push)) {
        s.wakeQueued = this.options.wake(s.slot.push, key);
      }
    }
  }

  accept(push: CoalescedPush): PushEventResult {
    if (this.suspended) throw new CoalesceError('serverId', 'host is stopping', -32000);
    const { params } = push;
    const c = params.coalesce;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new CoalesceError('coalesce', 'coalesce must be an object');
    if (typeof c.key !== 'string' || !Buffer.byteLength(c.key) || Buffer.byteLength(c.key) > 256) {
      throw new CoalesceError('coalesce.key', 'key must be 1..256 UTF-8 bytes');
    }
    if (c.channelId !== undefined) throw new CoalesceError('coalesce.channelId', 'channelScopedPush is not supported');
    for (const field of ['deferred', 'retract'] as const) {
      if (c[field] !== undefined && typeof c[field] !== 'boolean') throw new CoalesceError(`coalesce.${field}`, 'expected boolean');
    }
    if (c.deferred && c.retract) throw new CoalesceError('coalesce', 'deferred and retract are exclusive');
    if (c.data !== undefined && !c.deferred) throw new CoalesceError('coalesce.data', 'data requires deferred');
    if (c.data !== undefined && Buffer.byteLength(JSON.stringify(c.data)) > 4096) throw new CoalesceError('coalesce.data', 'data exceeds 4 KiB');
    if (typeof params.eventId !== 'string' || !params.eventId) throw new CoalesceError('eventId', 'eventId is required');
    if (typeof params.timestamp !== 'string') throw new CoalesceError('timestamp', 'timestamp is required');
    validateCoalescedContent(params.payload?.content, this.options.maxContentBytes);
    if (!this.options.authorized(push)) throw new CoalesceError('featureSet', 'push is no longer authorized', -32002);
    const dedup = JSON.stringify([push.serverId, push.epoch, params.eventId]);
    const receipt = this.receipts.get(dedup);
    if (receipt) return structuredClone(receipt);
    const key = JSON.stringify([push.serverId, push.epoch, params.featureSet, c.key]);
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
    const sameAudience = !prior || prior.push.audience === push.audience;
    if (c.retract || !c.deferred) {
      this.cancelRender(s);
      if (prior) this.options.audit({ kind: 'displaced', subject: key, push: prior.push });
      s.slot = undefined; // supersedes BOTH rendering and newer pending batch
      if (c.retract) {
        s.consumedEventId = undefined;
        outcome = s.history === 'none' ? 'retracted' : params.payload.content.length ? 'noted' : 'consumed';
        if (outcome === 'noted' && sameAudience) s.slot = { push, dropped: 0 };
      } else {
        outcome = prior ? 'replaced' : s.consumedEventId || s.history === 'unknown' ? 'appended' : 'first';
        if (sameAudience) s.slot = { push, dropped: 0 };
      }
    } else {
      const pending = s.slot;
      outcome = pending ? 'replaced' : 'first';
      if (pending) this.options.audit({ kind: pending.notices ? 'folded' : 'displaced', subject: key, push: pending.push });
      if (sameAudience) {
        const notices = pending?.notices ?? [];
        notices.push({ eventId: params.eventId, timestamp: params.timestamp, ...(c.data !== undefined ? { data: structuredClone(c.data) } : {}) });
        let dropped = pending?.dropped ?? 0;
        if (notices.length > 64) { notices.shift(); dropped++; }
        s.slot = { push, notices, dropped };
      } else s.slot = undefined;
    }
    const result: PushEventResult = { accepted: true, coalesce: { outcome, ...(priorId ? { priorEventId: priorId } : {}) } };
    this.receipts.set(dedup, result);
    if (this.receipts.size > 4096) this.receipts.delete(this.receipts.keys().next().value!);
    this.save();
    if (s.slot && !s.wakeQueued) s.wakeQueued = this.options.wake(s.slot.push, key);
    if (!s.slot && !s.rendering) { s.wakeQueued = false; this.options.cancelWake(key); }
    return structuredClone(result);
  }

  /** Await only batches present at this assembly. Then publish and seal synchronously,
   * before context compilation can expose content to any model or compressor. */
  async assemble(audience: string, publish: (push: CoalescedPush) => void): Promise<void> {
    if (this.suspended) return;
    const selected = [...this.subjects].filter(([, s]) => (s.slot ?? s.rendering?.slot)?.push.audience === audience);
    await Promise.all(selected.map(async ([key, s]) => {
      if (s.rendering) { await s.rendering.done; return; }
      if (!s.slot?.notices) return;
      const slot = s.slot;
      s.slot = undefined;
      s.wakeQueued = false;
      this.options.cancelWake(key);
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
      this.options.cancelWake(key);
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
      const params: PushRenderParams = { featureSet: push.params.featureSet, key: push.params.coalesce!.key,
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
    this.options.save({ version: 1, pending: structuredClone(pending) });
  }

  /** A new transport cannot mutate an old epoch's pending work. */
  disconnect(serverId: string): void {
    if (this.suspended) return;
    for (const [key, s] of this.subjects) {
      if ((s.slot ?? s.rendering?.slot)?.push.serverId !== serverId) continue;
      this.options.audit({ kind: 'disconnected', subject: key, push: (s.slot ?? s.rendering?.slot)?.push });
      this.cancelRender(s);
      s.slot = undefined;
      s.history = 'unknown';
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
