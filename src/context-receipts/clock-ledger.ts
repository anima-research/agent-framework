/**
 * Per-channel receipt clocks (shelf-354): when this host last accepted an
 * item from a channel (received), and when a provider round that stood last
 * carried a channel's new raw body, complete, to a given resident (delivered).
 *
 * The ledger is a RecordJournal of Chronicle typed records, so it is
 * unbranched: a delivery stays delivered across `/undo` (lived time), and
 * each entry names the branch it happened on. It travels with its store, and
 * tracking is scoped per store and per resident: a store switch begins a
 * separate history. One ledger serves every agent of a store, because the
 * journal has one writer per record type.
 *
 * Entries:
 *  - `start` / `stop`: tracking began / stopped cleanly. A start with no stop
 *    after it means the previous run ended uncleanly; the next start reports
 *    that interval as a coverage gap.
 *  - `gap`: an interval in which observations may be missing (unclean stop, a
 *    failed ledger write). A gap is written before the stop marker, and a
 *    failed gap write leaves the stop marker unwritten.
 *  - `recv`: one host acceptance of a channel item (shared by all residents).
 *  - `dlv`: a resident's first complete delivery of one source version.
 *  - `part`: a resident's first partial exposure to a version not yet
 *    delivered complete.
 *
 * Deduplication is exact and persistent. A version is delivered at most
 * once per resident, however long ago it was accepted. Every delivered (and
 * partially exposed) version is remembered by the SHA-256 of its canonical
 * identity ([basis, key]), and the full sets ride in each checkpoint as one
 * packed base64 string.
 * Re-presenting a delivered version (an unfold, a replay, every later round)
 * never moves a clock, and a version that has never reached the resident
 * counts when it first does, at any age. Checkpoints grow with the sets, so
 * their interval grows too (a quarter of the remembered keys, at least 4000
 * entries), which keeps total checkpoint storage linear in deliveries.
 *
 * A journal that can't be read (a failed or damaged read, or a checkpoint
 * this version doesn't write, at start or while reconciling) stops neither
 * the host nor delivery: the ledger becomes unreadable. A read is all or
 * nothing, and nothing is written or checkpointed until a whole read
 * succeeds, so no partial or empty state can cover entries that weren't read,
 * even when the read fails inside recovery itself (a write that landed but
 * reported failure makes the next write read the journal again). Meanwhile
 * channel_list reports the open gap, and no clocks at all until the journal
 * has been read once. The read is retried on use, at most every 30 s, and
 * once more at stop. When it succeeds, tracking resumes from the whole
 * journal, dedup sets and coverage included, and the unreadable interval is
 * recorded as a gap. A run whose journal never becomes readable writes
 * nothing, so a later run can't show that interval as a gap: recording it
 * would mean appending to a journal no one could read.
 */

import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from '../record-journal.js';

export const CLOCK_RECORD = 'agent-framework/channel-clocks';

/** Minimum entries between checkpoints. */
const CHECKPOINT_EVERY = 4000;
/** How long an unreadable journal waits before the next read attempt. */
const READ_RETRY_MS = 30_000;
/** Coverage gaps listed with the clocks (most recent). */
const GAPS_KEPT = 20;

/** A channel as the clocks key it: its RFC-006 binding and canonical id. */
export interface ChannelRef {
  binding: string;
  channelId: string;
  serverId: string;
}

/** What identifies the source item an observation is about. */
export interface SourceRef {
  /** Platform message id, when the adapter supplied one. */
  messageId?: string;
  /** The adapter's own timestamp, verbatim. */
  sourceTimestamp?: string;
  /** Host acceptance time (epoch ms). */
  acceptedAt: number;
  eventId?: string;
  /** The stored copy that was presented (deliveries only). */
  storeMessageId?: string;
}

/**
 * The identity of one source version, and the basis it rests on:
 *  - `event`: the producer's eventId, where the lane guarantees stable
 *    retries and distinct versions (MCPL push/event, RFC-006 coalescing);
 *  - `message-digest`: platform message id plus the digest of the source body
 *    as it was delivered, recorded at ingestion before any decoration or
 *    sharding (for an unsharded copy stored before that record, its stored
 *    body). A revision restoring earlier bytes of the same message counts as
 *    that earlier version;
 *  - `stored-copy`: the stored message itself, when its source body can't be
 *    recovered: no platform message id, or a body stored in shards before
 *    ingestion recorded digests, even with a platform message id. Identity
 *    unknown: a replay of the same source item can't be recognized.
 * Whatever the basis, a copy edited after ingestion keeps its identity but
 * can't establish delivery (evidence copyFidelity): it is a partial exposure.
 * A copy whose fidelity can't be checked (stored before ingestion recorded
 * digests) confirms nothing and stays unconfirmed.
 */
export interface VersionRef {
  basis: 'event' | 'message-digest' | 'stored-copy';
  key: string;
}

export interface BranchStamp {
  id: string;
  name: string;
}

type ClockEntry =
  | { k: 'start'; at: number }
  | { k: 'stop'; at: number }
  | { k: 'gap'; at: number; from: number; to: number; reason: string }
  | { k: 'recv'; at: number; ch: ChannelRef; src: SourceRef; lane: string }
  | { k: 'dlv'; at: number; agent: string; ch: ChannelRef; src: SourceRef; ver: VersionRef; branch: BranchStamp }
  | { k: 'part'; at: number; agent: string; ch: ChannelRef; src: SourceRef; ver: VersionRef; branch: BranchStamp; why: string[] };

interface ClockStamp {
  at: number;
  src: SourceRef;
}

interface DeliveryStamp extends ClockStamp {
  basis: VersionRef['basis'];
  branch: BranchStamp;
}

interface PartialStamp extends ClockStamp {
  why: string[];
}

/** One resident's clocks, by channel key. */
interface AgentState {
  delivered: Record<string, DeliveryStamp>;
  partial: Record<string, PartialStamp>;
}

/** A resident's persisted dedup sets: packed 32-byte version digests, base64. */
interface PackedSets {
  delivered: string;
  partial: string;
}

interface Snapshot {
  v: 2;
  trackingSince: number | null;
  channels: Record<string, { ch: ChannelRef; received: ClockStamp }>;
  agents: Record<string, AgentState>;
  /** Exact dedup sets per resident (rebuilt into memory at load). */
  seen: Record<string, PackedSets>;
  gaps: Array<{ from: number; to: number; reason: string }>;
  /** Start time of a run with no stop recorded yet. */
  openRun: number | null;
  /** Time of the latest entry (any kind). */
  lastAt: number | null;
}

/** One channel's clocks as a resident sees them. */
export interface ChannelClocks {
  lastReceivedAt: number | null;
  received?: SourceRef;
  lastDeliveredAt: number | null;
  delivered?: SourceRef & { basis: VersionRef['basis']; branch: BranchStamp };
  lastPartialAt: number | null;
  partial?: SourceRef & { missing: string[] };
}

export interface ClockScope {
  storeId: string;
  agent: string;
  trackingSince: number | null;
  /** Recent intervals in which observations may be missing. */
  gaps: Array<{ from: number; to: number; reason: string }>;
  /** True while a gap is still open: a ledger write failed, or the journal can't be read. */
  degraded: boolean;
}

/**
 * A channel's key in the ledger. Persisted keys are JSON arrays: unambiguous
 * whatever the ids contain, and free of NUL bytes, which Chronicle refuses.
 */
export function channelKey(ch: Pick<ChannelRef, 'binding' | 'channelId'>): string {
  return JSON.stringify([ch.binding, ch.channelId]);
}


/** A version's identity: the SHA-256 of [basis, key], as 64 hex characters. */
function versionDigest(ver: VersionRef): string {
  return createHash('sha256').update(JSON.stringify([ver.basis, ver.key])).digest('hex');
}

function pack(set: ReadonlySet<string>): string {
  return Buffer.from([...set].join(''), 'hex').toString('base64');
}

function unpack(packed: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!packed) return out;
  const hex = Buffer.from(packed, 'base64').toString('hex');
  for (let i = 0; i + 64 <= hex.length; i += 64) out.add(hex.slice(i, i + 64));
  return out;
}

function emptyAgent(): AgentState {
  return { delivered: {}, partial: {} };
}

function emptySnapshot(): Snapshot {
  return { v: 2, trackingSince: null, channels: {}, agents: {}, seen: {}, gaps: [], openRun: null, lastAt: null };
}

/**
 * A checkpoint's state, as this version writes it. Anything else (another
 * version's checkpoint, or one damaged into other valid JSON) makes the
 * journal unreadable rather than starting from an empty state, which the
 * next checkpoint would make permanent.
 */
function checkedSnapshot(value: unknown): Snapshot {
  const s = value as Partial<Snapshot> | null;
  const isObject = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
  const isTime = (x: unknown) => x === null || typeof x === 'number';
  if (!isObject(s) || s!.v !== 2 || !isObject(s!.channels) || !isObject(s!.agents) || !Array.isArray(s!.gaps)
    || !isTime(s!.trackingSince) || !isTime(s!.openRun) || !isTime(s!.lastAt)) {
    throw new Error('clock ledger checkpoint is not a snapshot this version reads');
  }
  return s as Snapshot;
}

export class ChannelClockLedger {
  private readonly journal: RecordJournal<ClockEntry, Snapshot>;
  private state: Snapshot = emptySnapshot();
  /** Set while a gap is open (a write failed, or the journal can't be read): when it began and why. */
  private pendingGap: { from: number; reason: string } | null = null;
  /** Between start() and stop(). */
  private started = false;
  /** When start() was called: where this run begins. */
  private runStartedAt = 0;
  /** This run's start has been recorded (or attempted): the journal was read after start(). */
  private runBegun = false;
  /** This run's start marker is still to be written: it precedes the run's other entries. */
  private startPending = false;
  /** The journal has been read whole at least once, so memory holds its clocks. */
  private hasRead = false;
  /** Set while the journal can't be read: when the next attempt is due. Nothing is written meanwhile. */
  private unreadable: { retryAt: number } | null = null;
  /** Inside batch(): the store has been synced for this batch's writes. */
  private batch: { synced: boolean } | null = null;

  private readonly checkpointEvery: number;
  /** Exact dedup sets per resident: delivered and partially exposed version digests. */
  private deliveredSets = new Map<string, Set<string>>();
  private partialSets = new Map<string, Set<string>>();

  constructor(
    private readonly store: JsStore,
    readonly storeId: string,
    private readonly now: () => number = Date.now,
    limits: { checkpointEvery?: number } = {},
  ) {
    this.journal = new RecordJournal<ClockEntry, Snapshot>(store, { type: CLOCK_RECORD });
    this.checkpointEvery = limits.checkpointEvery ?? CHECKPOINT_EVERY;
  }

  /**
   * Begin this run: read the journal, report an unclean previous run, and
   * record this run's start. Never throws: a journal that can't be read
   * leaves tracking unavailable, and the run begins when a retried read
   * succeeds (readable()).
   */
  start(): void {
    this.started = true;
    this.runStartedAt = this.now();
    if (this.read()) this.beginRun();
  }

  /**
   * Record a clean stop: any outstanding gap first, then the stop marker,
   * then a checkpoint. If the gap can't be written, no stop marker is
   * written either, so the next start reports the interval as unclean. A
   * journal still unreadable after one last attempt gets nothing written.
   */
  stop(): void {
    if (!this.started) return;
    if (this.unreadable) this.unreadable.retryAt = this.now();
    const readable = this.readable();
    this.started = false;
    if (!readable) return;
    const at = this.now();
    if (this.pendingGap) {
      if (!this.flushPendingGap(at)) return;
    }
    if (!this.write({ k: 'stop', at })) return;
    try {
      this.journal.checkpoint(this.snapshot(), { durable: true });
    } catch (err) {
      console.error('[receipts] clock checkpoint at stop failed:', err);
    }
  }

  /**
   * Run `fn`, whose deliveries and partial exposures all name stored state
   * committed before it began: the store syncs once, before the first such
   * write, instead of once per entry.
   */
  withCommittedState<T>(fn: () => T): T {
    const outer = this.batch;
    this.batch = outer ?? { synced: false };
    try {
      return fn();
    } finally {
      this.batch = outer;
    }
  }

  /** One host acceptance of a channel item. */
  received(ch: ChannelRef, src: SourceRef, lane: string): void {
    this.write({ k: 'recv', at: src.acceptedAt, ch, src, lane });
  }

  /**
   * A complete body of `ver` reached `agent` in a round that stood. Returns
   * true when it was a first delivery (the clock moved).
   */
  delivered(agent: string, ch: ChannelRef, src: SourceRef, ver: VersionRef, branch: BranchStamp, at = this.now()): boolean {
    // Eligibility is decided on state read whole and reconciled: an earlier
    // append that failed after landing may already hold this very delivery.
    if (!this.readable() || !this.reconcile()) return false;
    if (this.deliveredSets.get(agent)?.has(versionDigest(ver))) return false;
    return this.write({ k: 'dlv', at, agent, ch, src, ver, branch });
  }

  /** A partial copy of `ver` reached `agent` before any complete one. */
  partial(agent: string, ch: ChannelRef, src: SourceRef, ver: VersionRef, branch: BranchStamp, why: string[], at = this.now()): boolean {
    if (!this.readable() || !this.reconcile()) return false;
    const digest = versionDigest(ver);
    if (this.deliveredSets.get(agent)?.has(digest) || this.partialSets.get(agent)?.has(digest)) return false;
    return this.write({ k: 'part', at, agent, ch, src, ver, branch, why });
  }

  /** Whether `agent` already has a complete delivery of `ver`. */
  isDelivered(agent: string, ver: VersionRef): boolean {
    return this.deliveredSets.get(agent)?.has(versionDigest(ver)) ?? false;
  }

  /**
   * The clocks of the given channels for one resident; none at all until the
   * journal has been read (the scope's open gap says why).
   */
  clocksFor(agent: string, channels: Array<Pick<ChannelRef, 'binding' | 'channelId'>>): Map<string, ChannelClocks> {
    this.readable();
    const out = new Map<string, ChannelClocks>();
    if (!this.hasRead) return out;
    const a = this.state.agents[agent];
    for (const ch of channels) {
      const key = channelKey(ch);
      const recv = this.state.channels[key]?.received;
      const dlv = a?.delivered[key];
      const part = a?.partial[key];
      out.set(key, {
        lastReceivedAt: recv?.at ?? null,
        ...(recv ? { received: recv.src } : {}),
        lastDeliveredAt: dlv?.at ?? null,
        ...(dlv ? { delivered: { ...dlv.src, basis: dlv.basis, branch: dlv.branch } } : {}),
        lastPartialAt: part?.at ?? null,
        ...(part ? { partial: { ...part.src, missing: part.why } } : {}),
      });
    }
    return out;
  }

  scope(agent: string): ClockScope {
    this.readable();
    return {
      storeId: this.storeId,
      agent,
      trackingSince: this.state.trackingSince,
      gaps: [...this.state.gaps, ...(this.pendingGap ? [{ from: this.pendingGap.from, to: this.now(), reason: `${this.pendingGap.reason} (ongoing)` }] : [])],
      degraded: this.pendingGap !== null,
    };
  }

  // --------------------------------------------------------------------------

  /**
   * Bring memory in line with the journal after an ambiguous write (one that
   * failed after reaching the store): replay it, so decisions see whatever
   * landed. False when that replay fails, or while the journal can't be
   * read; the caller then records nothing, and the open coverage gap covers
   * it.
   */
  private reconcile(): boolean {
    return this.unreadable === null && (!this.journal.needsReconcile || this.read());
  }

  /**
   * Read the whole journal into memory, all or nothing. On failure memory
   * keeps what it held, the ledger becomes unreadable (nothing is written or
   * checkpointed until a later read succeeds, though the journal may already
   * have advanced past entries never reduced), and a coverage gap opens.
   */
  private read(): boolean {
    const held = { state: this.state, delivered: this.deliveredSets, partial: this.partialSets };
    try {
      const { snapshot, entries } = this.journal.load();
      this.state = snapshot === null ? emptySnapshot() : checkedSnapshot(snapshot);
      this.deliveredSets = new Map();
      this.partialSets = new Map();
      for (const [agent, sets] of Object.entries(this.state.seen ?? {})) {
        this.deliveredSets.set(agent, unpack(sets.delivered));
        this.partialSets.set(agent, unpack(sets.partial));
      }
      this.state.seen = {};
      for (const { entry } of entries) this.reduce(entry);
    } catch (err) {
      this.state = held.state;
      this.deliveredSets = held.delivered;
      this.partialSets = held.partial;
      const at = this.now();
      console.error(`[receipts] channel clock ledger could not be read; retrying in ${READ_RETRY_MS / 1000} s:`, err);
      this.unreadable = { retryAt: at + READ_RETRY_MS };
      if (!this.pendingGap) this.pendingGap = { from: at, reason: 'ledger-unreadable' };
      return false;
    }
    this.unreadable = null;
    this.hasRead = true;
    return true;
  }

  /**
   * Whether memory holds the journal as read whole. While it can't be read,
   * a due attempt (on use, at most every READ_RETRY_MS) reads it again, and
   * a run whose start waited on the read begins once it succeeds. Beginning
   * writes, and a write that fails ambiguously makes the next one read again,
   * which can fail too: so the answer is the state after beginning.
   */
  private readable(): boolean {
    if (!this.unreadable) return true;
    if (this.now() < this.unreadable.retryAt) return false;
    if (!this.read()) return false;
    if (this.started && !this.runBegun) this.beginRun();
    return this.unreadable === null;
  }

  /**
   * This run's start, once the journal has been read: an unclean previous
   * run's interval as a gap, up to where this run began, then the start
   * marker. A read that only succeeded after start() left its interval open
   * as a pending gap, which the marker's write records first; before
   * tracking ever began there was nothing to miss. A gap that can't be
   * written yet widens the one left open, and a marker that can't be written
   * yet is retried before the run's next entry, so neither interval is lost.
   */
  private beginRun(): void {
    this.runBegun = true;
    if (this.state.openRun !== null) {
      const from = this.state.lastAt ?? this.state.openRun;
      if (!this.writeGap({ from, to: this.runStartedAt, reason: 'unclean-stop' }) && this.pendingGap) {
        this.pendingGap.from = Math.min(this.pendingGap.from, from);
      }
    }
    if (this.state.trackingSince === null && this.pendingGap?.reason === 'ledger-unreadable') this.pendingGap = null;
    this.startPending = true;
    this.recordStart();
  }

  /**
   * Write the pending start marker, stamped when it is written. If an
   * earlier attempt landed but reported failure, the journal holds two
   * markers for the run, which reduce like one: the later opens the run.
   */
  private recordStart(): boolean {
    if (!this.write({ k: 'start', at: this.now() })) return false;
    this.startPending = false;
    return true;
  }

  /** The reduced state with the dedup sets packed in, for a checkpoint. */
  private snapshot(): Snapshot {
    const seen: Record<string, PackedSets> = {};
    const agents = new Set([...this.deliveredSets.keys(), ...this.partialSets.keys()]);
    for (const agent of agents) {
      seen[agent] = { delivered: pack(this.deliveredSets.get(agent) ?? new Set()), partial: pack(this.partialSets.get(agent) ?? new Set()) };
    }
    return { ...this.state, seen };
  }

  private rememberedKeys(): number {
    let n = 0;
    for (const set of this.deliveredSets.values()) n += set.size;
    for (const set of this.partialSets.values()) n += set.size;
    return n;
  }

  /**
   * Append one entry and reduce it. A failure opens a coverage gap that
   * channel_list reports and the next successful write records; it never
   * reaches the caller, because delivery must not depend on bookkeeping.
   * Nothing is appended while the journal can't be read.
   */
  private write(entry: ClockEntry): boolean {
    if (!this.readable()) return false;
    if (this.pendingGap && entry.k !== 'gap') {
      if (!this.flushPendingGap(this.now())) return false;
    }
    if (this.startPending && entry.k !== 'gap' && entry.k !== 'start') {
      if (!this.recordStart()) return false;
    }
    const assertsState = entry.k === 'dlv' || entry.k === 'part';
    // Tracking markers and gaps decide what the next start may claim about
    // this run, so they're on stable storage before the run goes on.
    const durable = entry.k === 'start' || entry.k === 'stop' || entry.k === 'gap';
    try {
      if (assertsState && this.batch) {
        if (!this.batch.synced) {
          this.store.sync();
          this.batch.synced = true;
        }
        this.journal.append(entry);
      } else {
        this.journal.append(entry, { ...(assertsState ? { afterCommittedState: true } : {}), ...(durable ? { durable: true } : {}) });
      }
    } catch (err) {
      this.noteFailure(err);
      return false;
    }
    this.reduce(entry);
    if (this.journal.entriesSinceCheckpoint >= Math.max(this.checkpointEvery, Math.floor(this.rememberedKeys() / 4))) {
      try {
        this.journal.checkpoint(this.snapshot());
      } catch (err) {
        this.noteFailure(err);
      }
    }
    return true;
  }

  private noteFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[receipts] channel clock ledger write failed: ${message}`);
    if (!this.pendingGap) this.pendingGap = { from: this.now(), reason: 'ledger-write-failed' };
  }

  /**
   * Reconcile after a failure, then record the gap. An earlier attempt that
   * landed but reported failure is in the reconciled journal already, so
   * only the time since it is recorded.
   */
  private flushPendingGap(to: number): boolean {
    const gap = this.pendingGap!;
    if (!this.reconcile()) return false;
    const landed = this.state.gaps.at(-1);
    if (landed && landed.reason === gap.reason && landed.from === gap.from) {
      if (landed.to >= to) {
        this.pendingGap = null;
        return true;
      }
      gap.from = landed.to;
    }
    try {
      this.journal.append({ k: 'gap', at: to, from: gap.from, to, reason: gap.reason }, { durable: true });
    } catch (err) {
      console.error('[receipts] coverage gap could not be recorded:', err);
      return false;
    }
    this.reduce({ k: 'gap', at: to, from: gap.from, to, reason: gap.reason });
    this.pendingGap = null;
    return true;
  }

  private writeGap(gap: { from: number; to: number; reason: string }): boolean {
    return this.write({ k: 'gap', at: gap.to, ...gap });
  }

  private agent(name: string): AgentState {
    let a = this.state.agents[name];
    if (!a) {
      a = emptyAgent();
      this.state.agents[name] = a;
    }
    return a;
  }

  private reduce(entry: ClockEntry): void {
    const s = this.state;
    s.lastAt = Math.max(s.lastAt ?? 0, entry.at);
    switch (entry.k) {
      case 'start':
        if (s.trackingSince === null) s.trackingSince = entry.at;
        s.openRun = entry.at;
        break;
      case 'stop':
        s.openRun = null;
        break;
      case 'gap':
        s.gaps.push({ from: entry.from, to: entry.to, reason: entry.reason });
        if (s.gaps.length > GAPS_KEPT) s.gaps.splice(0, s.gaps.length - GAPS_KEPT);
        break;
      case 'recv': {
        const key = channelKey(entry.ch);
        const prev = s.channels[key];
        if (!prev || entry.at >= prev.received.at) {
          s.channels[key] = { ch: entry.ch, received: { at: entry.at, src: entry.src } };
        }
        break;
      }
      case 'dlv': {
        const a = this.agent(entry.agent);
        const key = channelKey(entry.ch);
        const prev = a.delivered[key];
        if (!prev || entry.at >= prev.at) {
          a.delivered[key] = { at: entry.at, src: entry.src, basis: entry.ver.basis, branch: entry.branch };
        }
        const digest = versionDigest(entry.ver);
        let set = this.deliveredSets.get(entry.agent);
        if (!set) this.deliveredSets.set(entry.agent, (set = new Set()));
        set.add(digest);
        // Delivered whole supersedes any partial exposure of the same version.
        this.partialSets.get(entry.agent)?.delete(digest);
        break;
      }
      case 'part': {
        const a = this.agent(entry.agent);
        const key = channelKey(entry.ch);
        const prev = a.partial[key];
        if (!prev || entry.at >= prev.at) {
          a.partial[key] = { at: entry.at, src: entry.src, why: entry.why };
        }
        let set = this.partialSets.get(entry.agent);
        if (!set) this.partialSets.set(entry.agent, (set = new Set()));
        set.add(versionDigest(entry.ver));
        break;
      }
    }
  }
}
