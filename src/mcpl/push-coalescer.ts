/**
 * RFC-006 event coalescing (mcpl PR #5, revision 7): replace-if-unread, deferred
 * rendering, and atomic retraction, for both delivery lanes.
 *
 * The design keeps content IN context. A plain occurrence is delivered through
 * the ordinary channel/push path the moment it is admitted, exactly as today;
 * the coalescer only remembers WHERE it landed. A later occurrence of the same
 * subject edits or removes that message in place while it is still unread
 * (above the agent's consumed watermark, not folded by compression), and
 * appends once it has been read. Nothing is staged, journaled or capped: on
 * any uncertainty (restart, branch switch, eviction) the host behaves as an
 * append-only host would, which is what the RFC's principle 4 asks for.
 *
 * Only deferred batches (§5) wait outside context, because a notice has no
 * model-visible content until `push/render` produces it.
 *
 * All host effects go through {@link CoalescerHost}; this class is pure
 * bookkeeping and is unit-tested without a framework.
 */
import type { McplContentBlock, PushEventResult } from './types.js';

export const PUSH_COALESCING_SUPPORT = {
  pushEvents: true, channelsIncoming: true, deferred: true, channelScopedPush: true,
  retryWindowMs: 3_600_000,
} as const;

export const COALESCE_OUTCOMES = ['first', 'replaced', 'appended', 'retracted', 'noted', 'consumed'] as const;
export type CoalesceOutcome = typeof COALESCE_OUTCOMES[number];

class CancelledRender extends Error {}

export class CoalesceError extends Error {
  constructor(readonly field: string, message: string, readonly code = -32602) {
    super(message);
    this.name = 'CoalesceError';
  }
}

/** Where an unread occurrence currently lives. */
export interface CoalescingPlacement {
  agent: string;
  /** Stored message id in that agent's context manager. */
  messageId?: string;
  /** Entry id in the framework's deferred-write queue (turn-alive deferral). */
  deferredId?: string;
}

export interface CoalescingScope { kind: 'featureSet' | 'channel'; id: string }

/** One admitted occurrence, normalized from either lane. */
export interface CoalescedOccurrence<E = unknown> {
  serverId: string;
  /** Host-owned binding identity (§3.2): stable across reconnects to the same
   *  configured peer, different when the id is reassigned to another one. */
  binding: string;
  /** Declaring feature set (push lane), echoed in push/render. */
  featureSet?: string;
  scope: CoalescingScope;
  key: string;
  eventId: string;
  timestamp: string;
  retract: boolean;
  deferred: boolean;
  initial: boolean;
  data?: unknown;
  tags?: string[];
  /** Wire content (fallback for deferred; the notice for retract). */
  content: McplContentBlock[];
  /** Stable platform identity for channel subjects (§3.1). */
  identity?: { messageId?: string; author?: { id: string; name: string }; threadId?: string };
  /** The event the ordinary path would have queued — the host delivers it. */
  event: E;
  /** Set by the coalescer: deliver into this agent only (§3.2 audience may
   *  narrow, never widen — a replacement or notice follows the prior delivery). */
  deliverTo?: string;
}

export interface DeferredNotice { eventId: string; timestamp: string; data?: unknown }

export interface PushRenderParams {
  featureSet: string;
  channelId?: string;
  key: string;
  eventId: string;
  notices: DeferredNotice[];
  dropped: number;
}
export interface PushRenderResult { content: McplContentBlock[]; timestamp?: string }

interface DeferredBatch<E> {
  /** Latest notice; its content is the fallback, its tags/event drive delivery. */
  latest: CoalescedOccurrence<E>;
  /** Undefined: latest drives activity/wake policy (also the legacy format).
   * Null: this batch contains only passive updates. Otherwise retain the
   * latest active occurrence when a passive update changes the content. */
  activation?: CoalescedOccurrence<E> | null;
  notices: DeferredNotice[];
  dropped: number;
  /** Set on a batch restored from a snapshot whose render may have started. */
  noRender?: boolean;
  /** Where a frozen batch would publish; used only to settle recovery. */
  publicationAgent?: string;
}

interface StoredDeferredBatch {
  latest: CoalescedOccurrence<unknown>;
  activation?: CoalescedOccurrence<unknown> | null;
  notices: DeferredNotice[];
  dropped: number;
  rendering?: boolean;
  publicationAgent?: string;
}

interface Rendering<E> {
  batch: DeferredBatch<E>;
  cancelled: boolean;
  recovered?: boolean;
  done: Promise<void>;
}

interface SubjectState<E> {
  history: 'none' | 'some' | 'unknown';
  occupant?: { eventId: string; placement: CoalescingPlacement };
  batch?: DeferredBatch<E>;
  rendering?: Rendering<E>;
  /** Interrupted frozen batches, oldest first, materialized as fallback before
   * the newer pending batch. Further crashes must preserve every survivor. */
  recovered?: DeferredBatch<E>[];
  consumedEventId?: string;
  identity?: CoalescedOccurrence['identity'];
  /** Agent that received the last delivery; replacements and notices follow it. */
  audienceAgent?: string;
  touchedAt: number;
}

export interface CoalescingSnapshot {
  version: 1;
  receipts: Array<[string, { result: PushEventResult; at: number }]>;
  subjects: Array<{
    subject: string;
    history: SubjectState<unknown>['history'];
    consumedEventId?: string;
    identity?: CoalescedOccurrence['identity'];
    occupant?: { eventId: string; placement: CoalescingPlacement };
    audienceAgent?: string;
    batch?: StoredDeferredBatch;
    /** Frozen work concurrent with batch, or additional interrupted batches. */
    frozen?: StoredDeferredBatch[];
  }>;
}
/** One receipt, written synchronously at acceptance (bridges the snapshot throttle). */
export interface CoalescingReceiptRecord {
  key: string;
  result: PushEventResult;
  at: number;
  subject: string;
  /** History the subject was created with, for a subject first seen by this receipt. */
  born?: SubjectState<unknown>['history'];
  /** Resolved identity after this admission, including plain occurrences. */
  identity?: CoalescedOccurrence['identity'];
  /** The subject's pending batch AFTER this acceptance: the accepted work
   *  itself (so a crash before the snapshot flush cannot lose it while keeping
   *  the receipt that suppresses its retry), or `null` when the acceptance
   *  left no batch — a retraction or plain replacement must be recoverable
   *  too. Records replay in order, so the last one per subject wins. */
  batch: StoredDeferredBatch | null;
  /** All frozen work after acceptance; [] also records its cancellation. */
  frozen?: StoredDeferredBatch[];
}

export interface CoalescerHost<E> {
  /** True iff the placement still exists and no model request has included it. */
  isUnread(placement: CoalescingPlacement): boolean;
  /** False when the unread occurrence could not be removed (it may still be read). */
  remove(placement: CoalescingPlacement): boolean;
  /** Ordinary delivery of the event; undefined when routing delivered nowhere.
   *  A replacement is delivered as a fresh message after the unread prior was
   *  removed: it lands where a fresh event lands (§4.1 allows either place).
   *  For deferred materialization, activation names the pending activity
   *  cause, or null for a passive-only batch; content retains its own identity. */
  deliver(occurrence: CoalescedOccurrence<E>, materialized?: McplContentBlock[], assemblingFor?: string, activation?: CoalescedOccurrence<E> | null): Promise<CoalescingPlacement | undefined>;
  /** A passive deferred update changes content but cannot replace the batch's
   * pending activity/wake cause. Re-evaluated for restored legacy batches. */
  isPassive?(occurrence: CoalescedOccurrence<E>): boolean;
  /** Queue a wake for a batch that has no model-visible content yet. */
  wakeForBatch(occurrence: CoalescedOccurrence<E>, preserveExisting?: boolean): Promise<void>;
  /** Withdraw unstarted wakes whose sole cause is this subject. */
  cancelWake(subject: string): void;
  /** The batch's audience still holds the authority it was admitted under. */
  authorized(occurrence: CoalescedOccurrence<E>): boolean;
  /** Agents that read this occurrence's delivery target (may spawn a fork). */
  audience(occurrence: CoalescedOccurrence<E>): Promise<string[]>;
  render(occurrence: CoalescedOccurrence<E>, params: PushRenderParams): Promise<PushRenderResult>;
  audit(record: Record<string, unknown>): void;
  /** Persist (throttled by the host); the thunk builds the snapshot lazily. */
  save(snapshot: () => CoalescingSnapshot): void;
  /** Persist the snapshot NOW (a render is about to start: that boundary must
   *  be recoverable before the RPC is issued, §3.2). Throws on failure. */
  saveNow?(snapshot: CoalescingSnapshot): void;
  /** Persist one receipt now, before the acceptance is acknowledged. Throws
   *  on failure, which fails the acceptance (the producer retries). */
  recordReceipt?(record: CoalescingReceiptRecord): void;
  /** Make every write so far DURABLE (fsync, group-committed by the host).
   *  Awaited before an acceptance is acknowledged and before push/render is
   *  issued: a kill after either boundary must find the receipt, the
   *  accepted work, and the render-start on disk. Rejects on failure. */
  commit?(): Promise<void>;
  /** Recovery: is this occurrence's content in a context (its durable
   *  delivery identity — subject + eventId in message metadata — is found
   *  there)? A published occurrence is read from recovery on (the watermark
   *  restarts at the head), whatever a stale record says about its history. */
  wasPublished?(subject: string, eventId: string, publicationAgent?: string): boolean;
  now?(): number;
}

export interface CoalescerOptions {
  retryWindowMs?: number;
  /** Base delay before re-waking a batch whose render-start commit failed
   *  (doubles per attempt, capped at 60× base). Default 1 s. */
  recoveryBackoffMs?: number;
  maxSubjects?: number;
  maxNotices?: number;
  maxContentBytes?: number;
  maxDataBytes?: number;
}

export function coalescingSubjectKey(serverId: string, binding: string, scope: CoalescingScope, key: string): string {
  return JSON.stringify([serverId, binding, scope.kind, scope.id, key]);
}
export function coalescingReceiptKey(serverId: string, binding: string, eventId: string): string {
  return JSON.stringify([serverId, binding, eventId]);
}
/** Merge identity fields, never letting an absent field erase a known one (§3.1). */
function mergeIdentity(prior: CoalescedOccurrence['identity'], next: CoalescedOccurrence['identity']): CoalescedOccurrence['identity'] {
  const out = { ...prior };
  for (const [k, v] of Object.entries(next ?? {})) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Validate wire content before it is stored, rendered or converted. */
export function validateCoalescedContent(content: unknown, maxBytes = 1024 * 1024): asserts content is McplContentBlock[] {
  if (!Array.isArray(content)) throw new CoalesceError('payload.content', 'content must be an array');
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new CoalesceError('payload.content', 'invalid content block');
    if (b.type === 'text' && typeof b.text === 'string') continue;
    if (b.type === 'resource' && typeof b.uri === 'string') continue;
    if ((b.type === 'image' || b.type === 'audio')
      && (typeof b.uri === 'string' || (typeof b.data === 'string' && typeof b.mimeType === 'string'))) continue;
    throw new CoalesceError('payload.content', 'invalid content block');
  }
  if (Buffer.byteLength(JSON.stringify(content)) > maxBytes) throw new CoalesceError('payload.content', 'content exceeds host byte limit');
}

/** Validate the `coalesce` member of either lane (§13). */
export function validateCoalesceMember(
  c: unknown,
  lane: 'push' | 'channel',
  maxDataBytes = 4096,
): asserts c is NonNullable<import('./types.js').PushEventParams['coalesce']> {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new CoalesceError('coalesce', 'coalesce must be an object');
  const m = c as Record<string, unknown>;
  if (typeof m.key !== 'string' || !Buffer.byteLength(m.key) || Buffer.byteLength(m.key) > 256) {
    throw new CoalesceError('coalesce.key', 'key must be 1..256 UTF-8 bytes');
  }
  for (const field of ['deferred', 'retract', 'initial'] as const) {
    if (m[field] !== undefined && typeof m[field] !== 'boolean') throw new CoalesceError(`coalesce.${field}`, 'expected boolean');
  }
  if (m.channelId !== undefined && (typeof m.channelId !== 'string' || !m.channelId)) {
    throw new CoalesceError('coalesce.channelId', 'channelId must be a non-empty string');
  }
  if (lane === 'channel' && ('channelId' in m || 'deferred' in m)) {
    throw new CoalesceError('coalesce', 'channel messages cannot select scope or deferred mode');
  }
  if (m.deferred && m.retract) throw new CoalesceError('coalesce', 'deferred and retract are exclusive');
  if (m.initial && m.retract) throw new CoalesceError('coalesce', 'initial and retract are exclusive');
  if (m.data !== undefined && !m.deferred) throw new CoalesceError('coalesce.data', 'data requires deferred');
  if (m.data !== undefined && Buffer.byteLength(JSON.stringify(m.data)) > maxDataBytes) {
    throw new CoalesceError('coalesce.data', `data exceeds ${maxDataBytes} bytes`);
  }
}

export class PushCoalescer<E = unknown> {
  private readonly subjects = new Map<string, SubjectState<E>>();
  /** `committed`: the durability barrier succeeded after this receipt was
   *  written. An uncommitted receipt deduplicates effects but is not an
   *  acknowledgement until a commit succeeds. */
  private readonly receipts = new Map<string, { result: PushEventResult; at: number; committed: boolean }>();
  private readonly retryWindowMs: number;
  private readonly maxSubjects: number;
  private readonly maxNotices: number;
  /** Outstanding push/render RPCs per server, including cancelled ones (§10.7). */
  private readonly rendersInFlight = new Map<string, number>();
  /**
   * The ONE critical section. Every state transition — an admission, the
   * freezing of a batch for rendering, the settlement of a render's result —
   * runs under it, awaits included (fork spawn, durability commit, delivery).
   * Only the push/render RPC itself runs outside, so it stays cancellable.
   * An admission therefore never observes a half-done assembly transition,
   * and an assembly never acts on a batch an admission moved on from.
   */
  private serial: Promise<unknown> = Promise.resolve();
  /** Liveness after a failed freeze: a bounded, backed-off re-wake per
   *  subject. `attempt` outlives the armed timer: it counts consecutive
   *  failures and resets only on success or disposal of the pending work. */
  private readonly recovery = new Map<string, { timer?: ReturnType<typeof setTimeout>; attempt: number }>();
  private suspended = false;

  constructor(private readonly host: CoalescerHost<E>, private readonly options: CoalescerOptions = {}) {
    this.retryWindowMs = options.retryWindowMs ?? PUSH_COALESCING_SUPPORT.retryWindowMs;
    this.maxSubjects = options.maxSubjects ?? 4_096;
    this.maxNotices = options.maxNotices ?? 64;
  }

  private now(): number { return this.host.now?.() ?? Date.now(); }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.serial.then(fn, fn);
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---------------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------------

  /** The unread occupant's or batch's placement/identity, for routing continuity. */
  identity(subject: string): CoalescedOccurrence['identity'] | undefined {
    return this.subjects.get(subject)?.identity;
  }

  pendingBatches(): number {
    let n = 0;
    for (const s of this.subjects.values()) n += (s.batch ? 1 : 0) + (s.recovered?.length ?? 0);
    return n;
  }

  /** §10.7: a server handling push/render must not issue inference/request —
   *  including a render whose batch was cancelled while the RPC is outstanding. */
  isRendering(serverId: string): boolean {
    return (this.rendersInFlight.get(serverId) ?? 0) > 0;
  }

  receipt(serverId: string, binding: string, eventId: string): PushEventResult | undefined {
    const entry = this.receiptEntry(coalescingReceiptKey(serverId, binding, eventId));
    return entry && structuredClone(entry.result);
  }

  private receiptEntry(key: string): { result: PushEventResult; at: number; committed: boolean } | undefined {
    const entry = this.receipts.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.retryWindowMs) { this.receipts.delete(key); return undefined; }
    return entry;
  }

  /** Acknowledge a receipt: durable first. A receipt whose commit failed is
   *  committed now (no effects are repeated); if that fails again, so does
   *  the acknowledgement, and the producer retries once more. */
  private async acknowledge(key: string, entry: { result: PushEventResult; at: number; committed: boolean }, subject: string, eventId: string): Promise<PushEventResult> {
    if (!entry.committed) {
      try {
        await this.host.commit?.();
        entry.committed = true;
      } catch (error) {
        this.host.audit({ kind: 'persist-failed', subject, eventId, error: String(error) });
        throw new CoalesceError('eventId', 'host could not make the acceptance durable; retry', -32000);
      }
    }
    return structuredClone(entry.result);
  }

  // ---------------------------------------------------------------------------
  // Admission
  // ---------------------------------------------------------------------------

  /**
   * Admit an occurrence that has already passed the lane's ordinary checks and
   * the coalesce-member validation. Returns the wire result, performing the
   * host effects (replace / remove / deliver) synchronously so a create, edit
   * and delete cannot overtake one another. The optional prepare callback
   * computes host effect flags only after receipt replay is ruled out; it
   * must leave the occurrence's subject and receipt identity unchanged.
   */
  accept(occurrence: CoalescedOccurrence<E>, prepare?: () => void): Promise<PushEventResult> {
    return this.locked(() => this.admit(occurrence, prepare));
  }

  private async admit(occurrence: CoalescedOccurrence<E>, prepare?: () => void): Promise<PushEventResult> {
    if (this.suspended) throw new CoalesceError('serverId', 'host is stopping', -32000);
    const subject = coalescingSubjectKey(occurrence.serverId, occurrence.binding, occurrence.scope, occurrence.key);
    const duplicate = this.receiptEntry(coalescingReceiptKey(occurrence.serverId, occurrence.binding, occurrence.eventId));
    if (duplicate) {
      // A producer retrying acknowledged work is also a chance to notice a
      // batch left asleep by a failed freeze: wake it now, without effects.
      const state = this.subjects.get(subject);
      if (state && (state.batch || state.recovered?.length) && !state.rendering) { this.disarmRecovery(subject); await this.wakeSubject(subject, state); }
      return this.acknowledge(coalescingReceiptKey(occurrence.serverId, occurrence.binding, occurrence.eventId), duplicate, subject, occurrence.eventId);
    }
    // Effectful host policy (for example an EventGate callback) belongs to
    // new admission, never receipt replay against a newer subject identity.
    prepare?.();
    const born = this.subjects.has(subject) ? undefined : (occurrence.initial && !occurrence.retract ? 'none' as const : 'unknown' as const);
    const state = this.subjectFor(subject, occurrence);
    const occupantUnread = this.refreshOccupant(state);
    const priorEventId = state.occupant?.eventId ?? state.batch?.latest.eventId ?? state.rendering?.batch.latest.eventId ?? state.consumedEventId;
    this.host.audit({ kind: 'received', subject, eventId: occurrence.eventId, retract: occurrence.retract, deferred: occurrence.deferred });

    let outcome: CoalesceOutcome;
    if (occurrence.retract) {
      outcome = await this.retract(subject, state, occurrence, occupantUnread);
    } else if (occurrence.deferred) {
      outcome = await this.acceptDeferred(subject, state, occurrence, occupantUnread);
    } else {
      outcome = await this.acceptPlain(subject, state, occurrence, occupantUnread);
    }
    if (occurrence.scope.kind === 'channel' && occurrence.identity && !occurrence.retract) {
      state.identity = mergeIdentity(state.identity, occurrence.identity);
    }
    state.touchedAt = this.now();
    const result: PushEventResult = { accepted: true, coalesce: { outcome, ...(priorEventId ? { priorEventId } : {}) } };
    const receiptKey = coalescingReceiptKey(occurrence.serverId, occurrence.binding, occurrence.eventId);
    const entry = { result: structuredClone(result), at: this.now(), committed: false };
    try {
      this.host.recordReceipt?.({
        key: receiptKey, result: entry.result, at: entry.at, subject, ...(born ? { born } : {}),
        ...(state.identity ? { identity: structuredClone(state.identity) } : {}),
        batch: state.batch ? structuredClone(this.storeBatch(state.batch)) : null,
        frozen: structuredClone(this.frozenBatches(state).map(b => this.storeBatch(b, true))),
      });
    } catch (error) {
      // Not acknowledged: the work would be lost while its receipt suppressed
      // a retry. The producer retries within the window.
      this.host.audit({ kind: 'persist-failed', subject, eventId: occurrence.eventId, error: String(error) });
      throw new CoalesceError('eventId', 'host could not persist the acceptance; retry', -32000);
    }
    this.receipts.set(receiptKey, entry);
    this.prune();
    this.persist();
    // Written but not yet durable: the in-memory receipt deduplicates a retry
    // while this process lives, and the retry commits it (acknowledge); after
    // a kill nothing of it exists and the retry is a fresh acceptance.
    return this.acknowledge(receiptKey, entry, subject, occurrence.eventId);
  }

  private subjectFor(subject: string, occurrence: CoalescedOccurrence<E>): SubjectState<E> {
    let state = this.subjects.get(subject);
    if (!state) {
      // §3.3: an untracked subject is `unknown` unless the producer marks the
      // birth of the subject. A retraction is never a birth.
      state = { history: occurrence.initial && !occurrence.retract ? 'none' : 'unknown', touchedAt: this.now() };
      this.subjects.set(subject, state);
    }
    return state;
  }

  /** Re-check the occupant against the host: consumed occupants become history. */
  private refreshOccupant(state: SubjectState<E>): boolean {
    if (!state.occupant) return false;
    if (this.host.isUnread(state.occupant.placement)) return true;
    state.history = 'some';
    state.consumedEventId = state.occupant.eventId;
    state.occupant = undefined;
    return false;
  }

  private scheduleRecovery(subject: string, state: SubjectState<E>): void {
    const prior = this.recovery.get(subject);
    if (prior?.timer) clearTimeout(prior.timer);
    const attempt = (prior?.attempt ?? 0) + 1;
    const base = this.options.recoveryBackoffMs ?? 1_000;
    const delay = Math.min(base * 2 ** (attempt - 1), base * 60);
    const entry = { attempt } as { timer?: ReturnType<typeof setTimeout>; attempt: number };
    entry.timer = setTimeout(() => {
      // Disarm, but keep the attempt count: a freeze that fails again backs
      // off further. The count resets only on success or disposal.
      if (this.recovery.get(subject) === entry) entry.timer = undefined;
      if (this.suspended || this.subjects.get(subject) !== state || (!state.batch && !state.recovered?.length) || state.rendering) return;
      // Authority and wake policy are the host's, re-evaluated at fire time.
      if (!this.workBatches(state).some(b => this.host.authorized(b.latest))) return;
      this.host.audit({ kind: 'recovery-wake', subject, eventId: this.workBatches(state)[0]?.latest.eventId, attempt, delayMs: delay });
      void this.wakeSubject(subject, state).catch(() => { /* audited by the host */ });
    }, delay);
    (entry.timer as { unref?: () => void }).unref?.();
    this.recovery.set(subject, entry);
  }

  /** Disarm the timer only (a producer retry wakes now; the count stands). */
  private disarmRecovery(subject: string): void {
    const prior = this.recovery.get(subject);
    if (prior?.timer) { clearTimeout(prior.timer); prior.timer = undefined; }
  }

  /** Success or disposal of the pending work: forget the failure series. */
  private clearRecovery(subject: string): void {
    const prior = this.recovery.get(subject);
    if (prior?.timer) clearTimeout(prior.timer);
    this.recovery.delete(subject);
  }

  private dropBatches(subject: string, state: SubjectState<E>): boolean {
    this.clearRecovery(subject);
    let dropped = false;
    if (state.recovered?.length) {
      for (const batch of state.recovered) this.host.audit({ kind: 'displaced', subject, eventId: batch.latest.eventId, batch: true });
      state.recovered = undefined;
      dropped = true;
    }
    if (state.batch) { this.host.audit({ kind: 'displaced', subject, eventId: state.batch.latest.eventId, batch: true }); state.batch = undefined; dropped = true; }
    if (state.rendering) {
      this.host.audit({ kind: 'render-cancelled', subject, eventId: state.rendering.batch.latest.eventId });
      state.rendering.cancelled = true;
      state.rendering = undefined;
      dropped = true;
    }
    return dropped;
  }

  private async retract(subject: string, state: SubjectState<E>, occurrence: CoalescedOccurrence<E>, occupantUnread: boolean): Promise<CoalesceOutcome> {
    if (occupantUnread && state.occupant) {
      this.host.audit({ kind: 'removed', subject, eventId: state.occupant.eventId });
      if (!this.host.remove(state.occupant.placement)) {
        // Still in context and possibly about to be read: say so, append the notice.
        this.host.audit({ kind: 'remove-failed', subject, eventId: state.occupant.eventId });
        state.history = 'unknown';
      }
    }
    state.occupant = undefined;
    this.dropBatches(subject, state);
    this.host.cancelWake(subject);
    state.consumedEventId = undefined;
    if (state.history === 'none') return 'retracted';
    if (!occurrence.content.length) return 'consumed';
    // The notice is an ordinary occurrence: it rides the normal delivery path
    // (tags → gate policy → wake) and is consumed like any message — in the
    // context that read a version, never a new one (§3.2).
    const placement = await this.host.deliver({ ...occurrence, deliverTo: state.audienceAgent });
    if (placement) {
      state.occupant = { eventId: occurrence.eventId, placement };
      state.audienceAgent = placement.agent;
    }
    return 'noted';
  }

  private async acceptPlain(subject: string, state: SubjectState<E>, occurrence: CoalescedOccurrence<E>, occupantUnread: boolean): Promise<CoalesceOutcome> {
    const hadBatch = this.dropBatches(subject, state);
    if (occupantUnread && state.occupant) {
      const prior = state.occupant;
      this.host.audit({ kind: 'displaced', subject, eventId: prior.eventId });
      if (this.host.remove(prior.placement)) {
        this.host.cancelWake(subject);
        // The replacement follows the prior delivery's audience (§3.2).
        const placement = await this.host.deliver({ ...occurrence, deliverTo: prior.placement.agent });
        state.occupant = placement ? { eventId: occurrence.eventId, placement } : undefined;
        if (placement) state.audienceAgent = placement.agent;
        return 'replaced';
      }
      // Could not remove: the prior may still be read. Append, as for consumed.
      this.host.audit({ kind: 'remove-failed', subject, eventId: prior.eventId });
      state.history = 'unknown';
      state.consumedEventId = prior.eventId;
      state.occupant = undefined;
    }
    if (hadBatch) this.host.cancelWake(subject);
    const placement = await this.host.deliver(occurrence);
    state.occupant = placement ? { eventId: occurrence.eventId, placement } : undefined;
    if (placement) state.audienceAgent = placement.agent;
    if (hadBatch) return 'replaced';
    return state.consumedEventId || state.history !== 'none' ? 'appended' : 'first';
  }

  /** Keep content identity separate from the pending activity/wake cause.
   * A later active occurrence replaces the cause, even when it vetoes waking. */
  private activationFor(batch: DeferredBatch<E>): CoalescedOccurrence<E> | null {
    const activation = batch.activation === undefined ? batch.latest : batch.activation;
    return activation && !this.host.isPassive?.(activation) ? activation : null;
  }

  private workBatches(state: SubjectState<E>): DeferredBatch<E>[] {
    return [...(state.recovered ?? []), ...(state.batch ? [state.batch] : [])];
  }

  private frozenBatches(state: SubjectState<E>): DeferredBatch<E>[] {
    return [...(state.rendering ? [state.rendering.batch] : []), ...(state.recovered ?? [])];
  }

  private storeBatch(batch: DeferredBatch<E>, rendering = !!batch.noRender): StoredDeferredBatch {
    return {
      latest: batch.latest as CoalescedOccurrence<unknown>, notices: batch.notices, dropped: batch.dropped,
      ...(batch.activation !== undefined ? { activation: batch.activation as CoalescedOccurrence<unknown> | null } : {}),
      ...(batch.publicationAgent ? { publicationAgent: batch.publicationAgent } : {}),
      ...(rendering ? { rendering: true } : {}),
    };
  }

  private restoreBatch(batch: StoredDeferredBatch, noRender = !!batch.rendering): DeferredBatch<E> {
    return {
      latest: batch.latest as CoalescedOccurrence<E>, notices: batch.notices, dropped: batch.dropped,
      ...(batch.activation !== undefined ? { activation: batch.activation as CoalescedOccurrence<E> | null } : {}),
      ...(batch.publicationAgent ? { publicationAgent: batch.publicationAgent } : {}),
      ...(noRender ? { noRender: true } : {}),
    };
  }

  private async wakeSubject(subject: string, state: SubjectState<E>): Promise<void> {
    this.host.cancelWake(subject);
    for (const batch of this.workBatches(state)) {
      const activation = this.activationFor(batch);
      // Different frozen/pending batches have independent causes. A quiet
      // newer batch must not cancel an older, still-unconsumed obligation.
      if (activation) await this.host.wakeForBatch(activation, true);
    }
  }

  private async acceptDeferred(subject: string, state: SubjectState<E>, occurrence: CoalescedOccurrence<E>, occupantUnread: boolean): Promise<CoalesceOutcome> {
    let outcome: CoalesceOutcome = 'first';
    if (occupantUnread && state.occupant) {
      // §5.1: a notice displaces an unread plain occurrence and opens a batch
      // — in the audience that held the plain occurrence (§3.2).
      this.host.audit({ kind: 'displaced', subject, eventId: state.occupant.eventId });
      if (this.host.remove(state.occupant.placement)) {
        outcome = 'replaced';
        occurrence = { ...occurrence, deliverTo: state.occupant.placement.agent };
      } else { this.host.audit({ kind: 'remove-failed', subject, eventId: state.occupant.eventId }); state.history = 'unknown'; }
      this.host.cancelWake(subject);
      state.occupant = undefined;
    } else if (state.batch?.latest.deliverTo) {
      // Later notices stay in the batch's audience.
      occurrence = { ...occurrence, deliverTo: state.batch.latest.deliverTo };
    }
    const passive = this.host.isPassive?.(occurrence) ?? false;
    const activation = passive ? (state.batch ? this.activationFor(state.batch) : null) : undefined;
    const notice: DeferredNotice = { eventId: occurrence.eventId, timestamp: occurrence.timestamp, ...(occurrence.data !== undefined ? { data: structuredClone(occurrence.data) } : {}) };
    if (state.batch) {
      state.batch.notices.push(notice);
      if (state.batch.notices.length > this.maxNotices) { state.batch.notices.shift(); state.batch.dropped++; }
      state.batch.latest = occurrence;
      state.batch.activation = activation;
      outcome = 'replaced';
    } else {
      // Rule 1: a notice during a render opens a NEW batch ("first").
      state.batch = { latest: occurrence, ...(activation !== undefined ? { activation } : {}), notices: [notice], dropped: 0 };
    }
    await this.wakeSubject(subject, state);
    return outcome;
  }

  // ---------------------------------------------------------------------------
  // Assembly (deferred batches only — plain content is already in context)
  // ---------------------------------------------------------------------------

  /**
   * Render and materialize every pending batch whose audience includes
   * `agentName`. Called by the host at a turn's assembly boundary, before the
   * compile. Bounded by the host's render timeout; a failed or late render
   * materializes the admitted fallback (§5.3).
   */
  async assemble(agentName: string): Promise<void> {
    await Promise.all([...this.subjects.keys()].map(subject => this.assembleSubject(subject, agentName)));
    this.persist();
  }

  private async assembleSubject(subject: string, agentName: string): Promise<void> {
    while (!this.suspended) {
      const started = await this.locked(() => this.freeze(subject, agentName));
      if (!started) return;
      await started.done;
      // Recovery seals older interrupted batches as fallback, then lets the
      // newer pending batch assemble in the same turn. A normal live render
      // still closes only its own batch; arrivals during it await a later turn.
      if (!started.recovered) return;
    }
  }

  private async freeze(subject: string, agentName: string): Promise<{ done: Promise<void>; recovered: boolean } | undefined> {
    const state = this.subjects.get(subject);
    if (!state || this.suspended) return undefined;
    if (state.rendering) {
      const rendering = state.rendering;
      return (await this.host.audience(this.activationFor(rendering.batch) ?? rendering.batch.latest)).includes(agentName) && state.rendering === rendering
        ? { done: rendering.done, recovered: !!rendering.recovered } : undefined;
    }
    const recovered = !!state.recovered?.length;
    const batch = recovered ? state.recovered![0] : state.batch;
    if (!batch) return undefined;
    const audience = await this.host.audience(this.activationFor(batch) ?? batch.latest);
    if (!audience.includes(agentName) || (recovered ? state.recovered?.[0] !== batch : state.batch !== batch) || state.rendering) return undefined;
    if (recovered) state.recovered!.shift();
    else state.batch = undefined;
    this.host.cancelWake(subject);
    if (!this.host.authorized(batch.latest)) {
      this.host.audit({ kind: 'revoked', subject, eventId: batch.latest.eventId });
      return { done: Promise.resolve(), recovered };
    }
    batch.publicationAgent = agentName;
    const rendering: Rendering<E> = { batch, cancelled: false, recovered, done: Promise.resolve() };
    state.rendering = rendering;
    const putBack = () => {
      state.rendering = undefined;
      if (recovered) (state.recovered ??= []).unshift(batch);
      else state.batch = batch;
    };
    try {
      if (this.host.saveNow) this.host.saveNow(this.snapshot()); else this.persist();
      await this.host.commit?.();
    } catch (error) {
      this.host.audit({ kind: 'persist-failed', subject, eventId: batch.latest.eventId, error: String(error) });
      batch.noRender = true;
      putBack();
      this.scheduleRecovery(subject, state);
      return undefined;
    }
    this.clearRecovery(subject);
    if (this.suspended) { putBack(); return undefined; }
    if (!this.host.authorized(batch.latest)) {
      this.host.audit({ kind: 'revoked', subject, eventId: batch.latest.eventId });
      state.rendering = undefined;
      return { done: Promise.resolve(), recovered };
    }
    rendering.done = this.render(subject, state, rendering, agentName);
    return { done: rendering.done, recovered };
  }

  private async render(subject: string, state: SubjectState<E>, rendering: Rendering<E>, assemblingFor: string): Promise<void> {
    const { batch } = rendering;
    const occurrence = batch.latest;
    let content: McplContentBlock[] = occurrence.content;
    let timestamp = occurrence.timestamp;
    let source: 'render' | 'fallback' = 'fallback';
    if (!batch.noRender) {
      const params: PushRenderParams = {
        featureSet: occurrence.featureSet ?? (occurrence.scope.kind === 'featureSet' ? occurrence.scope.id : ''),
        ...(occurrence.scope.kind === 'channel' ? { channelId: occurrence.scope.id } : {}),
        key: occurrence.key, eventId: occurrence.eventId,
        notices: structuredClone(batch.notices), dropped: batch.dropped,
      };
      this.rendersInFlight.set(occurrence.serverId, (this.rendersInFlight.get(occurrence.serverId) ?? 0) + 1);
      try {
        const result = await this.host.render(occurrence, params);
        if (rendering.cancelled) { this.host.audit({ kind: 'late-render', subject, eventId: occurrence.eventId, discarded: true }); }
        else validateCoalescedContent(result?.content, this.options.maxContentBytes);
        if (rendering.cancelled) throw new CancelledRender();
        content = result.content;
        timestamp = typeof result.timestamp === 'string' ? result.timestamp : new Date().toISOString();
        source = 'render';
      } catch (error) {
        if (!(error instanceof CancelledRender)) this.host.audit({ kind: 'render-failed', subject, eventId: occurrence.eventId, error: String(error) });
      } finally {
        const left = (this.rendersInFlight.get(occurrence.serverId) ?? 1) - 1;
        if (left > 0) this.rendersInFlight.set(occurrence.serverId, left); else this.rendersInFlight.delete(occurrence.serverId);
      }
    }
    // Settlement runs under the lock: between the RPC's return and the state
    // update no admission can withdraw or replace what is being published.
    await this.locked(async () => {
      try {
        if (rendering.cancelled || state.rendering !== rendering || this.suspended) return;
        // Rule 4: authority is re-checked at response.
        if (!this.host.authorized(occurrence)) { this.host.audit({ kind: 'revoked', subject, eventId: occurrence.eventId }); return; }
        this.host.audit({ kind: 'rendered', subject, eventId: occurrence.eventId, source, empty: content.length === 0 });
        if (!content.length) return; // §5.2: nothing happened
        const placement = await this.host.deliver({ ...occurrence, timestamp, content }, content, assemblingFor, this.activationFor(batch));
        if (placement?.deferredId) {
          // Landed in another agent's deferred queue (its turn is alive): still
          // unread there, so it stays replaceable and withdrawable.
          state.occupant = { eventId: occurrence.eventId, placement };
          state.audienceAgent = placement.agent;
          return;
        }
        // The materialized occurrence is consumed by the request being assembled.
        state.history = 'some';
        state.consumedEventId = occurrence.eventId;
        state.occupant = undefined;
        if (placement) state.audienceAgent = placement.agent;
      } finally {
        if (state.rendering === rendering) state.rendering = undefined;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  restore(snapshot: CoalescingSnapshot | null | undefined): void {
    if (!snapshot || snapshot.version !== 1) return;
    const now = this.now();
    for (const [key, entry] of snapshot.receipts) {
      if (now - entry.at <= this.retryWindowMs) this.receipts.set(key, { ...entry, committed: true });
    }
    for (const s of snapshot.subjects) {
      const state: SubjectState<E> = {
        // A stored occupant is in context and will be in the next request:
        // it counts as read from here on (the watermark restarts at the head).
        history: s.occupant ? 'some' : s.history,
        consumedEventId: s.occupant?.eventId ?? s.consumedEventId,
        identity: s.identity,
        audienceAgent: s.audienceAgent ?? s.occupant?.placement.agent,
        touchedAt: now,
      };
      // Legacy snapshots put a sole frozen batch in batch with rendering=true.
      // New snapshots also retain concurrent frozen work alongside a pending batch.
      if (s.batch?.rendering) state.recovered = [this.restoreBatch(s.batch, true)];
      else if (s.batch) state.batch = this.restoreBatch(s.batch);
      if (s.frozen?.length) (state.recovered ??= []).push(...s.frozen.map(b => this.restoreBatch(b, true)));
      this.subjects.set(s.subject, state);
    }
    this.settlePublished();
  }

  /**
   * A batch restored as RENDERING may already have been published (its
   * result or fallback is a durable context message; only the completion
   * snapshot was lost). Recovery then marks it consumed instead of
   * delivering the fallback a second time.
   */
  private settlePublished(): void {
    if (!this.host.wasPublished) return;
    for (const [subject, state] of this.subjects) {
      const settled = (batch: DeferredBatch<E>): boolean => {
        if (!this.host.wasPublished!(subject, batch.latest.eventId, batch.publicationAgent)) return false;
        state.history = 'some';
        state.consumedEventId = batch.latest.eventId;
        return true;
      };
      if (state.batch?.noRender && settled(state.batch)) state.batch = undefined;
      if (state.recovered) state.recovered = state.recovered.filter(b => !settled(b));
    }
  }

  /** Apply receipts written since the last snapshot (crash-window bridge). */
  restoreReceipts(records: CoalescingReceiptRecord[]): void {
    const now = this.now();
    for (const r of records) {
      if (now - r.at > this.retryWindowMs) continue;
      this.receipts.set(r.key, { result: r.result, at: r.at, committed: true });
      if (r.born && !this.subjects.has(r.subject)) this.subjects.set(r.subject, { history: r.born, touchedAt: now });
      // A birth fact is not proof the subject is still unread: the plain
      // occurrence this record acknowledged is in context (durable before the
      // record) and counts as read from recovery on, like a snapshot occupant.
      let eventId: string | undefined;
      try { eventId = JSON.parse(r.key)[2]; } catch { /* malformed key: no settlement */ }
      if (eventId && this.host.wasPublished?.(r.subject, eventId)) {
        const state = this.subjects.get(r.subject) ?? { history: 'unknown' as const, touchedAt: now };
        state.history = 'some';
        state.consumedEventId = eventId;
        this.subjects.set(r.subject, state);
      }
      if (r.batch === undefined) continue; // pre-round-3 record: no batch information
      // The subject's batch AFTER that acceptance, newer than the snapshot:
      // the accepted deferred work itself, or null for a withdrawal /
      // replacement that cleared it. It never began rendering before the
      // record was written, but the snapshot cannot say whether it did
      // afterwards: take the fallback.
      const state = this.subjects.get(r.subject) ?? { history: 'unknown' as const, touchedAt: now };
      if (r.identity) state.identity = r.identity;
      else if (r.batch?.latest.identity) state.identity = mergeIdentity(state.identity, r.batch.latest.identity);
      state.batch = r.batch ? this.restoreBatch(r.batch, true) : undefined;
      if (r.frozen !== undefined) state.recovered = r.frozen.map(b => this.restoreBatch(b, true));
      else if (r.batch === null) state.recovered = undefined; // legacy explicit withdrawal/replacement
      this.subjects.set(r.subject, state);
    }
    this.settlePublished();
  }

  snapshot(): CoalescingSnapshot {
    return {
      version: 1,
      receipts: [...this.receipts],
      subjects: [...this.subjects].map(([subject, s]) => {
        const frozen = this.frozenBatches(s).map(b => this.storeBatch(b, true));
        // Preserve the legacy representation for a sole frozen batch.
        const batch = s.batch ? this.storeBatch(s.batch) : frozen.shift();
        return {
          subject, history: s.history, consumedEventId: s.consumedEventId, identity: s.identity,
          ...(s.audienceAgent ? { audienceAgent: s.audienceAgent } : {}),
          ...(s.occupant ? { occupant: s.occupant } : {}),
          ...(batch ? { batch } : {}),
          ...(frozen.length ? { frozen } : {}),
        };
      }),
    };
  }

  /** Every still-pending cause, including interrupted frozen work. */
  pendingBatchOccurrences(): CoalescedOccurrence<E>[] {
    return [...this.subjects.values()].flatMap(s => this.workBatches(s).flatMap(batch => {
      const activation = this.activationFor(batch);
      return activation ? [activation] : [];
    }));
  }

  suspend(): void {
    this.suspended = true;
    for (const subject of [...this.recovery.keys()]) this.clearRecovery(subject);
    for (const [subject, state] of this.subjects) {
      if (state.rendering) { state.rendering.cancelled = true; this.host.audit({ kind: 'render-cancelled', subject, eventId: state.rendering.batch.latest.eventId, reason: 'suspend' }); }
    }
  }

  private persist(): void { this.host.save(() => this.snapshot()); }

  private prune(): void {
    const now = this.now();
    if (this.receipts.size > 4 * this.maxSubjects) {
      for (const [key, entry] of this.receipts) if (now - entry.at > this.retryWindowMs) this.receipts.delete(key);
    }
    if (this.subjects.size <= this.maxSubjects) return;
    // Evict the oldest idle subjects; their history degrades to `unknown`
    // (an untracked subject) which is the conservative outcome (§3.3).
    const idle = [...this.subjects].filter(([, s]) => !s.occupant && !s.batch && !s.rendering && !s.recovered?.length).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key] of idle.slice(0, Math.max(0, this.subjects.size - this.maxSubjects))) this.subjects.delete(key);
  }
}
