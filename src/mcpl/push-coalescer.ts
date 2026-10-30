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
import { classifyBlock, isInlineContradiction } from './references.js';
import { isVisiblyEmptyContent } from './visible-content.js';

export const PUSH_COALESCING_SUPPORT = {
  pushEvents: true, channelsIncoming: true, deferred: true, channelScopedPush: true,
  retryWindowMs: 3_600_000,
} as const;

export const COALESCE_OUTCOMES = ['first', 'replaced', 'appended', 'retracted', 'noted', 'consumed'] as const;
export type CoalesceOutcome = typeof COALESCE_OUTCOMES[number];

class CancelledRender extends Error {}

export class CoalesceError extends Error {
  /** Set on a failure that came after the occurrence's effects: it was
   *  admitted, and only its acknowledgement failed (acknowledge). A lane
   *  must not answer it as not admitted. */
  readonly admitted: boolean;
  constructor(readonly field: string, message: string, readonly code = -32602, options: { admitted?: true } = {}) {
    super(message);
    this.name = 'CoalesceError';
    this.admitted = options.admitted === true;
  }
}

/**
 * How the host names a coalesce rejection, from the code the wire answered
 * with. `coalesce-failed` is the host's own failure: -32000 (coalescing
 * unavailable, the host stopping, or an acceptance it couldn't make durable)
 * and -32603 (an internal error). `coalesce-invalid` is every other answer,
 * the sender's: -32602 for a malformed item, -32017 or -32023 for a channel
 * that isn't permitted or isn't registered.
 */
export function coalesceRejectionReason(answered: number): 'coalesce-failed' | 'coalesce-invalid' {
  return answered === -32000 || answered === -32603 ? 'coalesce-failed' : 'coalesce-invalid';
}

/** Content with nothing model-visible (see visible-content.ts): -32602. */
export class EmptyContentError extends CoalesceError {
  readonly reason = 'empty-content';
  constructor(field = 'payload.content') {
    super(field, 'content has no visible content: send at least one non-text block or non-whitespace text');
    this.name = 'EmptyContentError';
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
  /** Set by the coalescer when the delivery is the agent's first view of
   *  the subject: a plain occurrence that replaces one that was the agent's
   *  first view (its `initial` birth, or a replacement so marked) and that
   *  the agent may never have been shown (CoalescerHost.isUnshown), or the
   *  first delivery of a batch that opened on a first view (its render, or
   *  a plain occurrence that drops it). No other path sets it. */
  firstView?: boolean;
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
  notices: DeferredNotice[];
  dropped: number;
  /** Every notice folded into the batch, a dropped one included, and a
   *  plain occurrence a notice displaced unread (Occupant.ambient), was
   *  tagged `chat:ambient` (RFC-001), so its render asks nothing of the agent
   *  (CoalescerHost.wakeToRead). Snapshots carry it. A batch restored
   *  without it, from a snapshot written before it existed or from an
   *  acceptance receipt, which doesn't carry it, reads as not all ambient:
   *  the side that keeps a wake. */
  allAmbient?: true;
  /** Set on a batch restored from a snapshot whose render may have started. */
  noRender?: boolean;
  /** The batch opened on the agent's first view of its subject: a fresh
   *  `initial` birth, or a first-view occupant it displaced that nothing had
   *  shown. Its first delivery is a first view too, while nothing of the
   *  subject has been read since and no other version of it is placed. It is
   *  cleared when the subject's first view ends while the batch is pending
   *  or rendering (occupantLeaves). */
  firstView?: true;
}

interface Rendering<E> {
  batch: DeferredBatch<E>;
  cancelled: boolean;
  done: Promise<void>;
  /** Set once the render (or its fallback) was delivered as content. */
  materialized?: boolean;
}

/** What an assembly did, per subject, for the turn being assembled. */
export interface AssemblyResult {
  /** Subjects this assembly finished with: it waited on their render to
   *  completion, freeze() declined them for this agent, or they were among
   *  the turn's causes and their batch was gone or another assembly's. */
  settled: Set<string>;
  /** Of those, the subjects whose render or fallback this assembly delivered
   *  where its compile reads it, as content the turn reads as its own. A
   *  settled subject that is not here gave the turn nothing new of its own to
   *  read: empty or blank render (§5.2), cancelled, revoked before the render
   *  or at its response, a render-start that could not be made durable (the
   *  batch then waits for its recovery wake), a batch whose audience doesn't
   *  include the agent, a render placed in a deferred queue (another
   *  agent's, or this agent's own behind a write held there), a render
   *  another assembly froze (its compile may show it, as that request's), or
   *  a cause whose batch was withdrawn, displaced or consumed by another
   *  request. */
  materialized: Set<string>;
}

/** What holds a subject's single slot (§3.2). A render describes what changed
 *  since the server's previous render (§5.2), so the renders before it that
 *  are still unread stay where they were placed, and the newest carries them
 *  as `before` (§3.3, vector 49). A plain occurrence displaces the run and a
 *  retraction removes it (§6), newest first (removeOccupant). */
interface Occupant {
  eventId: string;
  placement: CoalescingPlacement;
  /** A materialized batch (its result or its fallback), which later renders build on. */
  rendered?: true;
  /** This occupant was the agent's first view of the subject when it was
   *  placed, as `firstView` defines it. It hands that view on only while
   *  nothing of the subject has been read and nothing of its run may have
   *  been shown (occupantLeaves). Unknown counts as not one. A plain
   *  occurrence can carry it, and of a run's renders only the oldest, since a
   *  render that joins a run finds a version placed. In memory only: a
   *  snapshot's occupant comes back as read. */
  firstView?: true;
  /** A plain occurrence its server tagged `chat:ambient`. A notice that
   *  displaces it unread stands its batch's render in its place, so that
   *  render is all ambient only if this was (DeferredBatch.allAmbient). In
   *  memory only, as `firstView`: a snapshot's occupant comes back as read,
   *  and only an unread one is displaced. */
  ambient?: true;
  /** The run's earlier renders, oldest first, each placed ahead of this one. */
  before?: Array<Omit<Occupant, 'before'>>;
}

/** An occupant's `ambient` mark, for a plain occurrence its server tagged
 *  `chat:ambient`. */
function ambientOccupant(occurrence: { tags?: string[] }): { ambient?: true } {
  return occurrence.tags?.includes('chat:ambient') === true ? { ambient: true } : {};
}

/** The occupant holding a run's renders, given oldest first: the newest,
 *  carrying the rest as `before`. */
function runOf(members: Array<Omit<Occupant, 'before'>>): Occupant | undefined {
  if (members.length === 0) return undefined;
  const newest = members[members.length - 1];
  return members.length > 1 ? { ...newest, before: members.slice(0, -1) } : newest;
}

interface SubjectState<E> {
  history: 'none' | 'some' | 'unknown';
  occupant?: Occupant;
  batch?: DeferredBatch<E>;
  rendering?: Rendering<E>;
  consumedEventId?: string;
  identity?: CoalescedOccurrence['identity'];
  /** Agent that received the last delivery; replacements and notices follow it. */
  audienceAgent?: string;
  /** The agent's first view of the subject has ended: an occupant that may
   *  have been shown left it without handing a first view on
   *  (occupantLeaves, endFirstView). No later batch or birth of the subject
   *  is a first view while the coalescer keeps this record. An idle
   *  subject's record can be evicted (prune), and an `initial` occurrence
   *  after that starts the subject afresh. */
  firstViewEnded?: true;
  touchedAt: number;
}

interface ReceiptEntry {
  result: PushEventResult;
  at: number;
  committed: boolean;
  firstView?: true;
  /** Set while the receipt's record isn't written (recordReceipt failed):
   *  what a rewrite keeps from the admission. The rest of the record is the
   *  subject's state when it's written. */
  unwritten?: { subject: string; born?: SubjectState<unknown>['history'] };
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
    /** The subject's first view has ended (SubjectState.firstViewEnded). A
     *  snapshot written before this field existed has none and reads as not
     *  ended. So after an upgrade, a subject whose first view had ended
     *  without a read is granted a first view again. Until the agent is shown
     *  or reads a version of it, each delivery that would mark a first view (a
     *  render, or a plain occurrence that replaces an unread version or a
     *  pending notice) carries a spurious `firstView`. */
    firstViewEnded?: true;
    /** `firstView` only on a batch that wasn't rendering: one that was may
     *  have been shown. */
    batch?: { latest: CoalescedOccurrence<unknown>; notices: DeferredNotice[]; dropped: number; rendering?: boolean; firstView?: true; allAmbient?: true };
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
  /** The subject's first view had ended by this acceptance
   *  (SubjectState.firstViewEnded), or by the time a retry wrote the record,
   *  so a crash before the snapshot flush can't forget the end. A record
   *  written before this field existed has none and reads as not ended, as a
   *  snapshot does. */
  firstViewEnded?: true;
  /** The subject's pending batch AFTER this acceptance: the accepted work
   *  itself (so a crash before the snapshot flush cannot lose it while keeping
   *  the receipt that suppresses its retry), or `null` when the acceptance
   *  left no batch — a retraction or plain replacement must be recoverable
   *  too. Records replay in order, so the last one per subject wins. A
   *  record a retry writes (its first write failed) takes the batch the
   *  subject has then, a rendering one included. */
  batch: { latest: CoalescedOccurrence<unknown>; notices: DeferredNotice[]; dropped: number } | null;
}

export interface CoalescerHost<E> {
  /** True iff the placement still exists and, as far as the host can tell,
   *  no model request has included it. */
  isUnread(placement: CoalescingPlacement): boolean;
  /** True iff nothing may have shown the placement to the agent: it is still
   *  in the deferred queue and known not to be stored already, or it is
   *  stored where no committing compile has begun to assemble it and no tool
   *  boundary has injected past it. Unlike
   *  isUnread, a compile counts from its start: a doubt counts as shown. */
  isUnshown(placement: CoalescingPlacement): boolean;
  /** False when the unread occurrence could not be removed (it may still be read). */
  remove(placement: CoalescingPlacement): boolean;
  /** Ordinary delivery of the event; undefined when routing delivered nowhere.
   *  A replacement is delivered as a fresh message after the unread prior was
   *  removed: it lands where a fresh event lands (§4.1 allows either place). */
  deliver(occurrence: CoalescedOccurrence<E>, materialized?: McplContentBlock[], assemblingFor?: string): Promise<CoalescingPlacement | undefined>;
  /** Queue a wake for a batch that has no model-visible content yet. */
  wakeForBatch(occurrence: CoalescedOccurrence<E>): Promise<void>;
  /** Queue an ordinary push wake for `agent`, under the batch's own wake
   *  policy, to read a render of the batch placed in its deferred queue that
   *  no request consumed, at `deferredId`. It carries no subject, so the
   *  subject's other wakes, and later withdrawals of them, leave it.
   *  `allAmbient`: every notice the render stands for was tagged
   *  `chat:ambient` (DeferredBatch.allAmbient), so the wake is marked
   *  ambient. */
  wakeToRead(occurrence: CoalescedOccurrence<E>, agent: string, deferredId?: string, allAmbient?: boolean): Promise<void>;
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
   *  on failure, which fails that answer: the receipt is kept unwritten, and
   *  the producer's retry writes it again rather than admitting it again. */
  recordReceipt?(record: CoalescingReceiptRecord): void;
  /** One call per ADMITTED occurrence (never for a producer retry the receipt
   *  deduplicates), after its effects, whether or not its receipt could be
   *  written. Observation only: a throw is contained here and never fails the
   *  acceptance. */
  accepted?(occurrence: CoalescedOccurrence<E>): void;
  /** Make every write so far DURABLE (an fsync; the coalescer requests each
   *  commit under its lock, so no two acceptances share one).
   *  Awaited before an acceptance is acknowledged and before push/render is
   *  issued: a kill after either boundary must find the receipt, the
   *  accepted work, and the render-start on disk. Rejects on failure. */
  commit?(): Promise<void>;
  /** Recovery: is this occurrence's content in a context (its durable
   *  delivery identity — subject + eventId in message metadata — is found
   *  there)? A published occurrence is read from recovery on (the watermark
   *  restarts at the head), whatever a stale record says about its history. */
  wasPublished?(subject: string, eventId: string): boolean;
  now?(): number;
}

export interface CoalescerOptions {
  retryWindowMs?: number;
  /** Base delay before re-waking a batch whose render-start commit failed
   *  (doubles per attempt, capped at 60× base). Default 1 s. */
  recoveryBackoffMs?: number;
  maxSubjects?: number;
  maxNotices?: number;
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

/**
 * Validate wire content before it is stored, rendered or converted.
 *
 * Its shape and its visible emptiness, nothing else. An incoming coalesced
 * occurrence reaches context through the converter an uncoalesced message
 * goes through: a plain occurrence the moment it is admitted (the coalescer
 * only remembers where it landed), a deferred one when its render settles or
 * falls back to it. Its content must be an array of objects. A block the
 * converter can't render (a video, an unknown type, an image with neither
 * uri nor data) becomes a placeholder, as it does uncoalesced, and so does a
 * malformed one, since the converter takes any object without throwing: a
 * type, data, mimeType or uri that isn't a string counts as absent, and a
 * text block whose text isn't a string shows as its own placeholder, which
 * counts as no text where MCPL content is admitted: here, on the wire blocks,
 * and at the uncoalesced boundaries, through isVisiblyEmptyConversion. The
 * framework's backstops read converted content with isVisiblyEmptyContent,
 * which would count the placeholder as text, but they see only content one of
 * those checks has passed. The uncoalesced
 * lane doesn't check the array:
 * there a member that isn't an object becomes the untyped placeholder, and a
 * null member or content that isn't an array throws in conversion
 * (agent-framework#297 brings that lane to this rule).
 * Nor does the uncoalesced path set a byte budget on content:
 * an inline image is admitted here as it is there (agent-framework#266: a
 * 1 MiB serialized-content budget here dropped every coalesced message
 * carrying a screenshot). A deferred occurrence's content is held, until then,
 * in the coalescer's state and its persisted snapshot and receipts.
 *
 * A render result, which the host delivers in the occurrence's place, gets
 * these checks, as RFC-006 §5.2 gives it every check a pushed payload gets,
 * and one more (`checkBlockShapes`): each block must be one the converter
 * shows as itself or as a reference stub, not as a placeholder. A malformed
 * render falls back to the occurrence's own content; a pushed payload has
 * nothing to fall back to, and gets its placeholders.
 *
 * Visibly-empty content is refused unless `allowEmpty`: an admitted
 * occurrence with nothing to show would wake the model with no visible cause.
 * Empty is legitimate only where the RFC gives it a meaning — a retraction
 * with nothing to announce (§6) and a render result that says nothing
 * happened (§5.2) — and for the silent-heartbeat marker.
 */
export function validateCoalescedContent(
  content: unknown,
  options: { allowEmpty?: boolean; checkBlockShapes?: boolean } = {},
): asserts content is McplContentBlock[] {
  if (!Array.isArray(content)) throw new CoalesceError('payload.content', 'content must be an array');
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new CoalesceError('payload.content', 'invalid content block');
    if (options.checkBlockShapes && !showsAsItself(b)) throw new CoalesceError('payload.content', 'invalid content block');
  }
  if (!options.allowEmpty && isVisiblyEmptyContent(content)) throw new EmptyContentError();
}

/**
 * Whether the converter (`convertBlock` in convert-block.ts, which every lane
 * uses) shows a block as itself, its text or its image or
 * audio source (for MCP's embedded resource, its contents'), or as a
 * reference stub, and not as a placeholder: an
 * unrecognized block, a no-data or no-media-type one, withheld inline data,
 * or a text block whose text isn't a string. This follows its branches in
 * their order.
 */
function showsAsItself(b: Record<string, unknown>): boolean {
  if (b.type === 'text') return typeof b.text === 'string';
  if (b.type === 'resource' || b.type === 'resource_link') {
    const c = classifyBlock(b);
    // MCP's embedded resource shows as the block its contents make.
    if (c.kind === 'embedded') return c.contents.kind === 'block' && showsAsItself(c.contents.block);
    return c.kind === 'reference';
  }
  if (b.type !== 'image' && b.type !== 'audio') return false;
  if (isInlineContradiction(b)) return false;
  if (isFilledString(b.uri) && b.disposition !== undefined) return classifyBlock(b).kind === 'reference';
  if (isFilledString(b.data) && isFilledString(b.mimeType)) return true;
  return b.type === 'image' && isFilledString(b.uri);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
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
   *  acknowledgement until a commit succeeds. `firstView`: the admission it
   *  records handed its occurrence to the host's delivery marked as the
   *  agent's first view (`firstView`), whether or not the host placed
   *  it, so a retry answered from it says so too. Kept in memory only: a
   *  receipt restored from a snapshot or the crash-window bridge reads as no
   *  first view. */
  private readonly receipts = new Map<string, ReceiptEntry>();
  /** Set by a delivery that carries `firstView`. admit() clears it before
   *  an admission's effects and reads it after them; every delivery runs
   *  under the lock, so between the two it is that admission's alone. */
  private deliveredFirstView = false;
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
    for (const s of this.subjects.values()) if (s.batch) n++;
    return n;
  }

  /** §10.7: a server handling push/render must not issue inference/request —
   *  including a render whose batch was cancelled while the RPC is outstanding. */
  isRendering(serverId: string): boolean {
    return (this.rendersInFlight.get(serverId) ?? 0) > 0;
  }

  /** The host's delivery, noting one that carries `firstView` for the
   *  receipt of the admission it belongs to (deliveredFirstView). */
  private deliver(...args: Parameters<CoalescerHost<E>['deliver']>): ReturnType<CoalescerHost<E>['deliver']> {
    if (args[0].firstView) this.deliveredFirstView = true;
    return this.host.deliver(...args);
  }

  receipt(serverId: string, binding: string, eventId: string): PushEventResult | undefined {
    const entry = this.receiptEntry(coalescingReceiptKey(serverId, binding, eventId));
    return entry && structuredClone(entry.result);
  }

  /** Whether the admission this receipt records delivered its occurrence as
   *  the agent's first view: for the host's own bookkeeping, such as the
   *  channel registry's reply anchor, and never part of the wire result. */
  receiptFirstView(serverId: string, binding: string, eventId: string): boolean {
    return this.receiptEntry(coalescingReceiptKey(serverId, binding, eventId))?.firstView === true;
  }

  private receiptEntry(key: string): ReceiptEntry | undefined {
    const entry = this.receipts.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.retryWindowMs) { this.receipts.delete(key); return undefined; }
    return entry;
  }

  /** Acknowledge a receipt: durable first. A receipt whose record couldn't be
   *  written is written now, and one whose commit failed is committed now (no
   *  effects are repeated); if either fails again, so does the
   *  acknowledgement, and the producer retries once more. */
  private async acknowledge(key: string, entry: ReceiptEntry, subject: string, eventId: string): Promise<PushEventResult> {
    if (entry.unwritten) {
      try {
        this.recordReceipt(key, entry, entry.unwritten);
      } catch (error) {
        this.host.audit({ kind: 'persist-failed', subject, eventId, error: String(error) });
        throw new CoalesceError('eventId', 'host could not persist the acceptance; retry', -32000, { admitted: true });
      }
      delete entry.unwritten;
    }
    if (!entry.committed) {
      try {
        await this.host.commit?.();
        entry.committed = true;
      } catch (error) {
        this.host.audit({ kind: 'persist-failed', subject, eventId, error: String(error) });
        throw new CoalesceError('eventId', 'host could not make the acceptance durable; retry', -32000, { admitted: true });
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
   * and delete cannot overtake one another.
   */
  accept(occurrence: CoalescedOccurrence<E>): Promise<PushEventResult> {
    return this.locked(() => this.admit(occurrence));
  }

  private async admit(occurrence: CoalescedOccurrence<E>): Promise<PushEventResult> {
    const duplicate = this.receiptEntry(coalescingReceiptKey(occurrence.serverId, occurrence.binding, occurrence.eventId));
    // A retry of an occurrence admitted before the stop is refused too, but
    // as one admitted: its effects are in, so no lane may say it wasn't.
    if (this.suspended) throw new CoalesceError('serverId', 'host is stopping', -32000, duplicate ? { admitted: true } : {});
    const subject = coalescingSubjectKey(occurrence.serverId, occurrence.binding, occurrence.scope, occurrence.key);
    if (duplicate) {
      // A producer retrying acknowledged work is also a chance to notice a
      // batch left asleep by a failed freeze: wake it now, without effects.
      const state = this.subjects.get(subject);
      if (state?.batch && !state.rendering) { this.disarmRecovery(subject); await this.host.wakeForBatch(state.batch.latest); }
      return this.acknowledge(coalescingReceiptKey(occurrence.serverId, occurrence.binding, occurrence.eventId), duplicate, subject, occurrence.eventId);
    }
    const born = this.subjects.has(subject) ? undefined : (occurrence.initial && !occurrence.retract ? 'none' as const : 'unknown' as const);
    const state = this.subjectFor(subject, occurrence);
    const occupantUnread = this.refreshOccupant(state);
    // A notice leaves an unread render in place (acceptDeferred): neither
    // displaced nor found consumed, it isn't the prior (§3.3).
    const occupantPrior = occurrence.deferred && state.occupant?.rendered ? undefined : state.occupant?.eventId;
    const priorEventId = occupantPrior ?? state.batch?.latest.eventId ?? state.rendering?.batch.latest.eventId ?? state.consumedEventId;
    this.host.audit({ kind: 'received', subject, eventId: occurrence.eventId, retract: occurrence.retract, deferred: occurrence.deferred });

    let outcome: CoalesceOutcome;
    this.deliveredFirstView = false;
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
    // The effects are done, so the receipt is kept whatever its record's
    // write does: a retry is answered from it, never admitted again (RFC-006
    // §3.1). Its record is written and made durable before an acknowledgement
    // (acknowledge), by this answer or a retry's. While this process lives,
    // the in-memory receipt deduplicates a retry, which writes or commits
    // what failed. The snapshot carries it too, so a later save and commit
    // keep it across a restart; a kill before either leaves nothing of it,
    // and the retry is a fresh acceptance.
    const entry: ReceiptEntry = {
      result: structuredClone(result), at: this.now(), committed: false, unwritten: { subject, ...(born ? { born } : {}) },
      ...(this.deliveredFirstView ? { firstView: true as const } : {}),
    };
    this.receipts.set(receiptKey, entry);
    try {
      this.host.accepted?.(occurrence);
    } catch (error) {
      this.host.audit({ kind: 'accepted-observer-failed', subject, eventId: occurrence.eventId, error: String(error) });
    }
    this.prune();
    this.persist();
    return this.acknowledge(receiptKey, entry, subject, occurrence.eventId);
  }

  /** Write a receipt's record: what the admission fixed (`fixed`), with the
   *  subject's first-view end and pending batch as they are now. A record
   *  written by a retry follows any written since its admission, and records
   *  replay in order, so it carries the batch the subject has now, not the
   *  one it had then. That includes a batch whose render has started, which
   *  the render-start snapshot holds too: a `null` would clear it at a
   *  restore, and a crash before the render's content is stored would lose
   *  the accepted work. (At an admission no batch is rendering without a
   *  pending one: a plain occurrence or a retraction cancels the render, and
   *  a deferred notice opens a batch.) Throws when the host's write does. */
  private recordReceipt(key: string, entry: ReceiptEntry, fixed: { subject: string; born?: SubjectState<unknown>['history'] }): void {
    const state = this.subjects.get(fixed.subject);
    const batch = state?.batch ?? state?.rendering?.batch;
    this.host.recordReceipt?.({
      // A birth is the subject's only while the coalescer still holds it: one
      // evicted since its admission is untracked, `unknown` (prune).
      key, result: entry.result, at: entry.at, subject: fixed.subject, ...(fixed.born && state ? { born: fixed.born } : {}),
      ...(state?.firstViewEnded ? { firstViewEnded: true as const } : {}),
      batch: batch ? structuredClone({ latest: batch.latest as CoalescedOccurrence<unknown>, notices: batch.notices, dropped: batch.dropped }) : null,
    });
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

  /**
   * Re-check the occupant against the host, member by member: a member the
   * host counts as read, or that is gone (isUnread is false either way),
   * becomes history, and the run keeps the members still unread. Returns
   * whether any are.
   */
  private refreshOccupant(state: SubjectState<E>): boolean {
    const occupant = state.occupant;
    if (!occupant) return false;
    const { before = [], ...newest } = occupant;
    const members = [...before, newest];
    const unread = members.filter((member) => this.host.isUnread(member.placement));
    if (unread.length === members.length) return true;
    state.history = 'some';
    state.consumedEventId = members.filter((member) => !unread.includes(member)).at(-1)!.eventId;
    state.occupant = runOf(unread);
    return unread.length > 0;
  }

  /**
   * Remove the occupant and the run it builds on, newest first, auditing each
   * as `kind`. Every member is unread: refreshOccupant has just run, under the
   * lock. The host's removal may still refuse one, such as a held write the
   * host can't tell isn't already stored. A member the host
   * can't remove may be read, so the walk stops there, leaving it and the
   * renders it builds on, and the history becomes `unknown`.
   * Returns false then. It doesn't touch `state.occupant`, which still names
   * the members it removed: each caller clears it, so what the walk left is
   * history from then on, as an occupant whose removal failed always was.
   */
  private removeOccupant(subject: string, state: SubjectState<E>, kind: 'removed' | 'displaced'): boolean {
    const occupant = state.occupant!;
    for (const member of [occupant, ...[...(occupant.before ?? [])].reverse()]) {
      this.host.audit({ kind, subject, eventId: member.eventId });
      if (!this.host.remove(member.placement)) {
        // Still in context and possibly about to be read.
        this.host.audit({ kind: 'remove-failed', subject, eventId: member.eventId });
        state.history = 'unknown';
        state.consumedEventId = member.eventId;
        return false;
      }
    }
    return true;
  }

  /**
   * An unread occupant leaves the subject: a notice or a plain occurrence
   * displaces it, or a retraction withdraws it, with any run of renders it
   * carries. Returns whether it was a first view that nothing may have shown
   * (isUnshown), which a replacement carries on: for a run, its oldest render
   * carries the mark, and no render of it may have been shown. Nor may
   * anything of the subject have been read: a member a request has read, or
   * that is gone, leaves the run before this (refreshOccupant), and only the
   * subject's history still says so. Any other occupant may have been seen,
   * and this is the last point where the host can say so, since the removal
   * takes its placements: the subject's first view ends here (endFirstView).
   */
  private occupantLeaves(state: SubjectState<E>, occupant: Occupant): boolean {
    const { before = [], ...newest } = occupant;
    const members = [...before, newest];
    if (state.history === 'none' && members[0].firstView === true && members.every((member) => this.host.isUnshown(member.placement))) return true;
    this.endFirstView(state);
    return false;
  }

  /** The subject's first view ends: for a batch pending or rendering, whose
   *  first delivery would come after it, and for every later batch and
   *  birth (firstViewEnded). */
  private endFirstView(state: SubjectState<E>): void {
    state.firstViewEnded = true;
    if (state.batch) delete state.batch.firstView;
    if (state.rendering) delete state.rendering.batch.firstView;
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
      if (this.suspended || this.subjects.get(subject) !== state || !state.batch || state.rendering) return;
      // Authority and wake policy are the host's, re-evaluated at fire time.
      if (!this.host.authorized(state.batch.latest)) return;
      this.host.audit({ kind: 'recovery-wake', subject, eventId: state.batch.latest.eventId, attempt, delayMs: delay });
      void this.host.wakeForBatch(state.batch.latest).catch(() => { /* audited by the host */ });
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
      // Asked of the whole run before the walk takes its placements.
      this.occupantLeaves(state, state.occupant);
      // Whatever the walk leaves may be read, and the history it sets says so (§6).
      this.removeOccupant(subject, state, 'removed');
    }
    state.occupant = undefined;
    this.dropBatches(subject, state);
    this.host.cancelWake(subject);
    state.consumedEventId = undefined;
    if (state.history === 'none') return 'retracted';
    // An empty notice — or one with only blank text, which would reach the
    // model as an empty message — is pure withdrawal: append nothing.
    if (isVisiblyEmptyContent(occurrence.content)) return 'consumed';
    // The notice is an ordinary occurrence: it rides the normal delivery path
    // (tags → gate policy → wake) and is consumed like any message — in the
    // context that read a version, never a new one (§3.2).
    const placement = await this.deliver({ ...occurrence, deliverTo: state.audienceAgent });
    if (placement) {
      state.occupant = { eventId: occurrence.eventId, placement, ...ambientOccupant(occurrence) };
      state.audienceAgent = placement.agent;
    }
    return 'noted';
  }

  private async acceptPlain(subject: string, state: SubjectState<E>, occurrence: CoalescedOccurrence<E>, occupantUnread: boolean): Promise<CoalesceOutcome> {
    // A batch this occurrence drops delivered nothing, so when it opened on
    // the agent's first view, this occurrence takes that view.
    const batchFirstView = (state.batch ?? state.rendering?.batch)?.firstView === true;
    const hadBatch = this.dropBatches(subject, state);
    if (occupantUnread && state.occupant) {
      const prior = state.occupant;
      // The replacement is the agent's first view only when the run it
      // displaces held one and nothing may have shown any of it to the agent.
      // Otherwise the subject's first view ends here (occupantLeaves).
      const firstView = this.occupantLeaves(state, prior);
      // A plain occurrence is a complete snapshot (rule 6): it displaces the run.
      if (this.removeOccupant(subject, state, 'displaced')) {
        this.host.cancelWake(subject);
        // The replacement follows the prior delivery's audience (§3.2).
        const placement = await this.deliver({
          ...occurrence, deliverTo: prior.placement.agent,
          ...(firstView ? { firstView: true } : {}),
        });
        state.occupant = placement ? { eventId: occurrence.eventId, placement, ...(firstView ? { firstView: true as const } : {}), ...ambientOccupant(occurrence) } : undefined;
        if (placement) state.audienceAgent = placement.agent;
        return 'replaced';
      }
      // The walk stopped: what it left may be read. Append, as for consumed.
      state.occupant = undefined;
    }
    if (hadBatch) this.host.cancelWake(subject);
    const outcome: CoalesceOutcome = hadBatch ? 'replaced' : state.consumedEventId || state.history !== 'none' ? 'appended' : 'first';
    // The subject's `initial` birth is the agent's first view of it unless
    // that view has ended, and so is an occurrence that takes a first-view
    // batch's place (a batch's own first view ends with the subject's).
    const firstView = hadBatch ? batchFirstView && state.history === 'none' : outcome === 'first' && !state.firstViewEnded;
    const placement = await this.deliver(hadBatch && firstView ? { ...occurrence, firstView: true } : occurrence);
    state.occupant = placement ? { eventId: occurrence.eventId, placement, ...(firstView ? { firstView: true as const } : {}), ...ambientOccupant(occurrence) } : undefined;
    if (placement) state.audienceAgent = placement.agent;
    return outcome;
  }

  private async acceptDeferred(subject: string, state: SubjectState<E>, occurrence: CoalescedOccurrence<E>, occupantUnread: boolean): Promise<CoalesceOutcome> {
    let outcome: CoalesceOutcome = 'first';
    // Whether a batch this notice opens is the agent's first view of the
    // subject: nothing of it read, its first view not ended, no run of
    // renders placed (the run holds the first view, and the batch's render
    // joins it), and a first-view occupant this notice displaces that nothing
    // has shown (occupantLeaves, which otherwise ends the first view for the
    // batches already open too). A render still under way is weighed when a
    // batch's first delivery is.
    let firstView = state.history === 'none' && !state.firstViewEnded;
    // Whether every notice the batch's render stands for was tagged
    // `chat:ambient` (DeferredBatch.allAmbient): this one, and a plain
    // occurrence it displaces unread, whose place the render takes.
    let ambient = occurrence.tags?.includes('chat:ambient') === true;
    if (occupantUnread && state.occupant?.rendered) {
      // An unread render is a delta the next render builds on (§5.2), not a
      // plain occurrence: it stays, and the batch follows its agent (§3.2), so
      // the next render reaches the context that holds it (§3.3, vector 49).
      occurrence = { ...occurrence, deliverTo: state.occupant.placement.agent };
      firstView = false;
    } else if (occupantUnread && state.occupant) {
      // §5.1: a notice displaces an unread plain occurrence and opens a batch
      // — in the audience that held the plain occurrence (§3.2).
      if (!this.occupantLeaves(state, state.occupant)) firstView = false;
      if (state.occupant.ambient !== true) ambient = false;
      this.host.audit({ kind: 'displaced', subject, eventId: state.occupant.eventId });
      if (this.host.remove(state.occupant.placement)) {
        outcome = 'replaced';
        occurrence = { ...occurrence, deliverTo: state.occupant.placement.agent };
      } else { this.host.audit({ kind: 'remove-failed', subject, eventId: state.occupant.eventId }); state.history = 'unknown'; firstView = false; }
      this.host.cancelWake(subject);
      state.occupant = undefined;
    } else if (state.batch?.latest.deliverTo) {
      // Later notices stay in the batch's audience.
      occurrence = { ...occurrence, deliverTo: state.batch.latest.deliverTo };
    }
    const notice: DeferredNotice = { eventId: occurrence.eventId, timestamp: occurrence.timestamp, ...(occurrence.data !== undefined ? { data: structuredClone(occurrence.data) } : {}) };
    if (state.batch) {
      state.batch.notices.push(notice);
      if (state.batch.notices.length > this.maxNotices) { state.batch.notices.shift(); state.batch.dropped++; }
      state.batch.latest = occurrence;
      if (!ambient) delete state.batch.allAmbient;
      outcome = 'replaced';
    } else {
      // Rule 1: a notice during a render opens a NEW batch ("first").
      state.batch = { latest: occurrence, notices: [notice], dropped: 0, ...(firstView ? { firstView: true as const } : {}), ...(ambient ? { allAmbient: true as const } : {}) };
    }
    await this.host.wakeForBatch(occurrence);
    return outcome;
  }

  // ---------------------------------------------------------------------------
  // Assembly (deferred batches only — plain content is already in context)
  // ---------------------------------------------------------------------------

  /**
   * Render and materialize every pending batch whose audience includes
   * `agentName`. Called by the host at a turn's assembly boundary, before the
   * compile. Bounded by the host's render timeout; a failed or late render
   * materializes the admitted fallback (§5.3). Reports which subjects
   * settled and which of them gave the turn content, so the host can tell a
   * turn whose only causes gave it nothing to read.
   *
   * `causes` are the subjects whose batch wakes started the turn. A batch has
   * one consumer, the request it was frozen for (§5.2: the materialized
   * occurrence is consumed by that request). So a cause whose batch is gone
   * by now settles and gives the turn nothing, and an assembly that joins
   * another's render waits for it, so its compile shows the content, without
   * taking it as its own.
   */
  async assemble(agentName: string, causes: readonly string[] = []): Promise<AssemblyResult> {
    const result: AssemblyResult = { settled: new Set(), materialized: new Set() };
    if (this.suspended) return result;
    const work: Promise<void>[] = [];
    const wanted = new Set(causes);
    for (const subject of new Set([...this.subjects.keys(), ...causes])) {
      // The handle is wrapped: a bare promise returned through `locked` would
      // be flattened by `then`, holding the lock until the render settled —
      // and the settlement itself needs the lock.
      const started = await this.locked(() => this.freeze(subject, agentName, wanted.has(subject)));
      if (started === 'declined') result.settled.add(subject);
      else if (started) {
        work.push(started.done.then(() => {
          result.settled.add(subject);
          // A render another assembly froze is that request's to read.
          if (started.rendering.materialized && !started.joined) result.materialized.add(subject);
        }));
      }
    }
    await Promise.all(work);
    this.persist();
    return result;
  }

  /**
   * Render and materialize one subject's pending batch for `agentName` now,
   * outside a turn's assembly: a batch whose wake a hold keeps back, stored
   * as it renders (held, as a plain push under the hold is), so whoever reads
   * held traffic sees it and the turn after the hold doesn't take it again.
   * A batch that opened while another render ran is rendered once that
   * render settles. Resolves whether it materialized.
   */
  async materializeNow(agentName: string, subject: string): Promise<boolean> {
    for (;;) {
      if (this.suspended) return false;
      const started = await this.locked(() => this.freeze(subject, agentName));
      if (!started || started === 'declined') return false;
      await started.done;
      this.persist();
      if (!started.joined) return started.rendering.materialized === true;
    }
  }

  /**
   * Under the lock: decide whether `subject`'s batch renders for `agentName`,
   * freeze it, make the render-start durable, re-check authority, and start
   * the RPC. Returns the render's completion, which an assembly that joins
   * the render waits for too (`joined`: vector 25, one render). Returns
   * 'declined' when the turn being assembled gets nothing of the batch: the
   * agent isn't in its audience, whether or not another assembly is
   * rendering it (the batch is left as it is); authority was revoked before
   * the render could start (the batch is dropped); the render-start could not
   * be made durable (the batch is kept for its recovery wake); or, for one of
   * the turn's causes (`cause`), the batch is gone. Returns undefined when
   * the batch was not this assembly's to decide on: there is none and it
   * wasn't a cause, the subject moved on during the audience lookup, or the
   * host is stopping.
   */
  private async freeze(subject: string, agentName: string, cause = false): Promise<{ done: Promise<void>; rendering: Rendering<E>; joined?: true } | 'declined' | undefined> {
    if (this.suspended) return undefined;
    const state = this.subjects.get(subject);
    // The batch whose wake started this turn is gone: a retraction or a
    // displacement withdrew it after the wake was dispatched, or another
    // request consumed it, the batch's one consumption, as the freeze's
    // withdrawal of the other queued wakes already makes it. Whatever replaced
    // it is read through its own delivery and wake. (A retry of a turn that
    // read its batch comes back without the marks of a batch wake, so it
    // never reaches here as a cause: beginAgentTurn.)
    if (!state || (!state.batch && !state.rendering)) return cause ? 'declined' : undefined;
    if (state.rendering) {
      // Another assembly froze this batch, and the request it assembles
      // consumes it. An assembly in its audience waits for that render, so
      // its compile shows the content (vector 25), but the content isn't its
      // own to read, cause or not; unless this agent isn't in its audience,
      // as below.
      const rendering = state.rendering;
      const audience = await this.host.audience(rendering.batch.latest);
      if (state.rendering !== rendering) return undefined;
      if (!audience.includes(agentName)) return 'declined';
      return { done: rendering.done, rendering, joined: true };
    }
    const batch = state.batch;
    if (!batch) return undefined;
    // The audience lookup may spawn a fork. Under the lock no admission can
    // move the subject on meanwhile; the identity check guards the host.
    const audience = await this.host.audience(batch.latest);
    if (state.batch !== batch || state.rendering) return undefined;
    // Not this agent's batch, or no longer: an agent woken for it can have left
    // its audience since. This turn has nothing of it to show. The batch stays
    // pending; nothing here wakes its current audience.
    if (!audience.includes(agentName)) return 'declined';
    state.batch = undefined;
    this.host.cancelWake(subject);
    if (!this.host.authorized(batch.latest)) {
      this.host.audit({ kind: 'revoked', subject, eventId: batch.latest.eventId });
      return 'declined';
    }
    const rendering: Rendering<E> = { batch, cancelled: false, done: Promise.resolve() };
    state.rendering = rendering;
    // The render-start boundary is recoverable BEFORE the RPC: a restart
    // then takes the fallback instead of asking the server a second time.
    try {
      if (this.host.saveNow) this.host.saveNow(this.snapshot()); else this.persist();
      await this.host.commit?.();
    } catch (error) {
      this.host.audit({ kind: 'persist-failed', subject, eventId: batch.latest.eventId, error: String(error) });
      state.rendering = undefined;
      batch.noRender = true; // cannot prove a render never started → fallback
      state.batch = batch;
      // The wake was withdrawn above; acknowledged work must not sleep until
      // unrelated traffic happens by. Re-wake with backoff, so a persistent
      // storage outage does not become a tight loop of model turns.
      this.scheduleRecovery(subject, state);
      return 'declined';
    }
    this.clearRecovery(subject);
    if (this.suspended) { state.rendering = undefined; state.batch = batch; return undefined; }
    // Authority (grant, registration, binding) is re-checked immediately
    // before dispatch: a server id reassigned to another endpoint during the
    // commit must not receive this batch's notices.
    if (!this.host.authorized(batch.latest)) {
      this.host.audit({ kind: 'revoked', subject, eventId: batch.latest.eventId });
      state.rendering = undefined;
      return 'declined';
    }
    rendering.done = this.render(subject, state, rendering, agentName);
    return { done: rendering.done, rendering };
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
        // §5.2: an empty result is legitimate ("nothing happened"); each
        // block must be well formed.
        else validateCoalescedContent(result?.content, { allowEmpty: true, checkBlockShapes: true });
        if (rendering.cancelled) throw new CancelledRender();
        content = result.content;
        timestamp = typeof result.timestamp === 'string' ? result.timestamp : new Date().toISOString();
        source = 'render';
      } catch (error) {
        if (!(error instanceof CancelledRender)) {
          // The occurrence's own content is delivered instead; the host names
          // the failure where operators look (a console line, not only this
          // audit record).
          this.host.audit({
            kind: 'render-failed', subject, serverId: occurrence.serverId, eventId: occurrence.eventId,
            ...(error instanceof CoalesceError ? { field: error.field } : {}),
            error: String(error),
          });
        }
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
        const empty = isVisiblyEmptyContent(content);
        this.host.audit({ kind: 'rendered', subject, eventId: occurrence.eventId, source, empty });
        if (empty) return; // §5.2: nothing happened (blank text included)
        // A render describes what changed since the server's previous render
        // (§5.2), so the renders before it stay where they are, and this one
        // joins their run after them (§3.3, vector 49). Any a request has
        // read by then, refreshOccupant drops at its next look. The batch's
        // first delivery is the agent's first view while nothing of the
        // subject has been read and no other version of it is placed, so only
        // a run's oldest render can be one.
        const run = state.occupant?.rendered ? state.occupant : undefined;
        const firstView = batch.firstView === true && state.history === 'none' && !state.occupant;
        const placement = await this.deliver({ ...occurrence, timestamp, content, ...(firstView ? { firstView: true } : {}) }, content, assemblingFor);
        if (placement?.deferredId) {
          // Landed in a deferred queue: another agent's, whose turn is alive,
          // or the assembling agent's own, behind a write held there (the
          // host's bypassDeferralFor), or after its assembly ended, as any
          // write during its turn. Still unread
          // there, so it stays replaceable and withdrawable. The turn being
          // assembled doesn't read it, so it isn't materialized for that turn,
          // and no request has consumed it. The freeze withdrew the queue's
          // agent's wake for this batch; give it an ordinary wake, as any
          // delivery during its turn has, beside any wakes a newer batch has,
          // so that its next turn reads the content (the wake starts no turn
          // once a request that carried it is answered and, if the wake
          // carries a channel and the batch wasn't all ambient, the agent has
          // published there since, or once it's removed).
          // The run's renders keep their own records, whatever else an
          // occupant carries, a first view's mark included.
          let before: Occupant['before'];
          if (run) { const { before: earlier, ...member } = run; before = [...(earlier ?? []), member]; }
          state.occupant = { eventId: occurrence.eventId, placement, rendered: true, ...(firstView ? { firstView: true as const } : {}), ...(before ? { before } : {}) };
          // A batch opened while this render was under way (§5.4 rule 1)
          // follows the run's agent from here, wakes included, as a later
          // notice's does (acceptDeferred), so the run stays in one context.
          if (state.batch && !state.batch.latest.deliverTo) {
            state.batch.latest = { ...state.batch.latest, deliverTo: placement.agent };
            await this.host.wakeForBatch(state.batch.latest);
          }
          state.audienceAgent = placement.agent;
          await this.host.wakeToRead(occurrence, placement.agent, placement.deferredId, batch.allAmbient === true);
          return;
        }
        // The materialized occurrence is consumed by the request being
        // assembled, and becomes history with the run placed ahead of it.
        rendering.materialized = true;
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
        ...(s.firstViewEnded ? { firstViewEnded: true as const } : {}),
        touchedAt: now,
      };
      if (s.batch) {
        // An interrupted render is not replayed (§3.2): a batch that was
        // RENDERING keeps its fallback; a batch that was only pending renders
        // normally at the next assembly.
        state.batch = {
          latest: s.batch.latest as CoalescedOccurrence<E>, notices: s.batch.notices, dropped: s.batch.dropped,
          ...(s.batch.rendering ? { noRender: true } : s.batch.firstView ? { firstView: true as const } : {}),
          ...(s.batch.allAmbient ? { allAmbient: true as const } : {}),
        };
      }
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
      const batch = state.batch;
      if (!batch?.noRender) continue;
      if (this.host.wasPublished(subject, batch.latest.eventId)) {
        state.batch = undefined;
        state.history = 'some';
        state.consumedEventId = batch.latest.eventId;
      }
    }
  }

  /** Apply receipts written since the last snapshot (crash-window bridge). */
  restoreReceipts(records: CoalescingReceiptRecord[]): void {
    const now = this.now();
    for (const r of records) {
      const fresh = now - r.at <= this.retryWindowMs;
      if (fresh) {
        this.receipts.set(r.key, { result: r.result, at: r.at, committed: true });
        if (r.born && !this.subjects.has(r.subject)) this.subjects.set(r.subject, { history: r.born, touchedAt: now });
      }
      // A first view's end is a fact about the subject, which holds while the
      // coalescer keeps it, not about the receipt, whose retry window says
      // nothing about it. So a record that carries it ends the subject's
      // first view whatever its age, for a batch the snapshot brought back
      // too. A subject this restore doesn't hold yet existed when the record
      // was written and may have been shown, so it comes back with that end
      // and an unknown history.
      if (r.firstViewEnded) {
        const ended = this.subjects.get(r.subject);
        if (ended) this.endFirstView(ended);
        else this.subjects.set(r.subject, { history: 'unknown', touchedAt: now, firstViewEnded: true });
      }
      if (!fresh) continue;
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
      // replacement that cleared it. Its render may have started before the
      // record was written (a retry's record) or after, and the snapshot
      // cannot say whether it ran: take the fallback.
      const state = this.subjects.get(r.subject) ?? { history: 'unknown' as const, touchedAt: now };
      state.batch = r.batch
        ? { latest: r.batch.latest as CoalescedOccurrence<E>, notices: r.batch.notices, dropped: r.batch.dropped, noRender: true }
        : undefined;
      this.subjects.set(r.subject, state);
    }
    this.settlePublished();
  }

  snapshot(): CoalescingSnapshot {
    return {
      version: 1,
      receipts: [...this.receipts].map(([key, { result, at }]): [string, { result: PushEventResult; at: number }] => [key, { result, at }]),
      subjects: [...this.subjects].map(([subject, s]) => ({
        subject, history: s.history, consumedEventId: s.consumedEventId, identity: s.identity,
        ...(s.audienceAgent ? { audienceAgent: s.audienceAgent } : {}),
        ...(s.firstViewEnded ? { firstViewEnded: true as const } : {}),
        // restore() reads only these. After a restart nothing of the subject
        // is tracked as unread, a run included: its history counts as read.
        ...(s.occupant ? { occupant: { eventId: s.occupant.eventId, placement: s.occupant.placement } } : {}),
        ...(s.batch ? { batch: { latest: s.batch.latest as CoalescedOccurrence<unknown>, notices: s.batch.notices, dropped: s.batch.dropped, ...(s.batch.noRender ? { rendering: true } : s.batch.firstView ? { firstView: true as const } : {}), ...(s.batch.allAmbient ? { allAmbient: true as const } : {}) } }
          : s.rendering ? { batch: { latest: s.rendering.batch.latest as CoalescedOccurrence<unknown>, notices: s.rendering.batch.notices, dropped: s.rendering.batch.dropped, rendering: true, ...(s.rendering.batch.allAmbient ? { allAmbient: true as const } : {}) } }
          : {}),
      })),
    };
  }

  /** Batches whose wake should be re-queued after a restart (their fallback is pending). */
  pendingBatchOccurrences(): CoalescedOccurrence<E>[] {
    return [...this.subjects.values()].flatMap(s => s.batch ? [s.batch.latest] : []);
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
    const idle = [...this.subjects].filter(([, s]) => !s.occupant && !s.batch && !s.rendering).sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [key] of idle.slice(0, Math.max(0, this.subjects.size - this.maxSubjects))) this.subjects.delete(key);
  }
}
