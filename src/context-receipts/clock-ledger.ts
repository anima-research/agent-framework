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
 */

import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from '../record-journal.js';

export const CLOCK_RECORD = 'agent-framework/channel-clocks';

/** Minimum entries between checkpoints. */
const CHECKPOINT_EVERY = 4000;
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
  /** True while a ledger write failure is unresolved. */
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

export class ChannelClockLedger {
  private readonly journal: RecordJournal<ClockEntry, Snapshot>;
  private state: Snapshot = emptySnapshot();
  /** Set while a write failure is unresolved: when it began and why. */
  private pendingGap: { from: number; reason: string } | null = null;
  private started = false;
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

  /** Load, report an unclean previous run, and record this run's start. */
  start(): void {
    this.reload();
    const at = this.now();
    if (this.state.openRun !== null) {
      this.writeGap({ from: this.state.lastAt ?? this.state.openRun, to: at, reason: 'unclean-stop' });
    }
    this.write({ k: 'start', at });
    this.started = true;
  }

  /**
   * Record a clean stop: any outstanding gap first, then the stop marker,
   * then a checkpoint. If the gap can't be written, no stop marker is
   * written either, so the next start reports the interval as unclean.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
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
    // Eligibility is decided on reconciled state: an earlier append that
    // failed after landing may already hold this very delivery.
    if (!this.reconcile()) return false;
    if (this.deliveredSets.get(agent)?.has(versionDigest(ver))) return false;
    return this.write({ k: 'dlv', at, agent, ch, src, ver, branch });
  }

  /** A partial copy of `ver` reached `agent` before any complete one. */
  partial(agent: string, ch: ChannelRef, src: SourceRef, ver: VersionRef, branch: BranchStamp, why: string[], at = this.now()): boolean {
    if (!this.reconcile()) return false;
    const digest = versionDigest(ver);
    if (this.deliveredSets.get(agent)?.has(digest) || this.partialSets.get(agent)?.has(digest)) return false;
    return this.write({ k: 'part', at, agent, ch, src, ver, branch, why });
  }

  /** Whether `agent` already has a complete delivery of `ver`. */
  isDelivered(agent: string, ver: VersionRef): boolean {
    return this.deliveredSets.get(agent)?.has(versionDigest(ver)) ?? false;
  }

  /** The clocks of the given channels for one resident. */
  clocksFor(agent: string, channels: Array<Pick<ChannelRef, 'binding' | 'channelId'>>): Map<string, ChannelClocks> {
    const a = this.state.agents[agent];
    const out = new Map<string, ChannelClocks>();
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
   * landed. False when that replay itself fails; the caller then records
   * nothing, and the open coverage gap covers it.
   */
  private reconcile(): boolean {
    if (!this.journal.needsReconcile) return true;
    try {
      this.reload();
      return true;
    } catch (err) {
      console.error('[receipts] clock ledger could not reconcile after a failed write:', err);
      return false;
    }
  }

  private reload(): void {
    const { snapshot, entries } = this.journal.load();
    this.state = snapshot && snapshot.v === 2 ? snapshot : emptySnapshot();
    this.deliveredSets = new Map();
    this.partialSets = new Map();
    for (const [agent, sets] of Object.entries(this.state.seen ?? {})) {
      this.deliveredSets.set(agent, unpack(sets.delivered));
      this.partialSets.set(agent, unpack(sets.partial));
    }
    this.state.seen = {};
    for (const { entry } of entries) this.reduce(entry);
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
   */
  private write(entry: ClockEntry): boolean {
    if (this.pendingGap && entry.k !== 'gap') {
      if (!this.flushPendingGap(this.now())) return false;
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

  /** Reconcile after a failure, then record the gap. */
  private flushPendingGap(to: number): boolean {
    const gap = this.pendingGap!;
    try {
      if (this.journal.needsReconcile) this.reload();
      this.journal.append({ k: 'gap', at: to, from: gap.from, to, reason: gap.reason }, { durable: true });
    } catch (err) {
      console.error('[receipts] coverage gap could not be recorded:', err);
      return false;
    }
    this.reduce({ k: 'gap', at: to, from: gap.from, to, reason: gap.reason });
    this.pendingGap = null;
    return true;
  }

  private writeGap(gap: { from: number; to: number; reason: string }): void {
    this.write({ k: 'gap', at: gap.to, ...gap });
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
