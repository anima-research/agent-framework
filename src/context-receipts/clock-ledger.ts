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
 * Deduplication. A version is delivered at most once per resident. The
 * ledger remembers recent delivered (and partially exposed) version keys,
 * bounded in count; a version whose acceptance predates that memory's
 * horizon is never counted as a first delivery, so re-presenting very old
 * history (an unfold, a replay) cannot refresh a clock. The horizon is
 * reported with the clocks.
 */

import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from '../record-journal.js';

export const CLOCK_RECORD = 'agent-framework/channel-clocks';

/** Delivered version keys remembered per resident. */
const DELIVERED_MEMORY = 8192;
/** Partially exposed version keys remembered per resident. */
const PARTIAL_MEMORY = 2048;
/** Entries between checkpoints. */
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
 *  - `message-digest`: platform message id plus a digest of the stored body.
 *    A revision restoring earlier bytes of the same message counts as that
 *    earlier version;
 *  - `stored-copy`: the stored message itself. Identity unknown: a replay of
 *    the same source item can't be recognized.
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

/** One resident's dedup memory: hashed version key -> source acceptance time. */
interface Memory {
  keys: Record<string, number>;
  /** Acceptance time below which versions are no longer remembered. */
  horizon: number;
}

interface AgentState {
  delivered: Record<string, DeliveryStamp>;
  partial: Record<string, PartialStamp>;
  dmem: Memory;
  pmem: Memory;
}

interface Snapshot {
  v: 1;
  trackingSince: number | null;
  channels: Record<string, { ch: ChannelRef; received: ClockStamp }>;
  agents: Record<string, AgentState>;
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
  /** Versions accepted before this were not remembered (dedup horizon). */
  dedupHorizon: number | null;
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

function versionHash(ver: VersionRef): string {
  return shortHash(JSON.stringify([ver.basis, ver.key]));
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 16);
}

function emptyAgent(): AgentState {
  return { delivered: {}, partial: {}, dmem: { keys: {}, horizon: 0 }, pmem: { keys: {}, horizon: 0 } };
}

function emptySnapshot(): Snapshot {
  return { v: 1, trackingSince: null, channels: {}, agents: {}, gaps: [], openRun: null, lastAt: null };
}

/**
 * Remember a key. Past 1.25 x `cap`, forget the oldest by acceptance time
 * down to `cap` and raise the horizon to the newest forgotten one, so
 * nothing at or before the horizon can count as new.
 */
function remember(mem: Memory, key: string, acceptedAt: number, cap: number): void {
  mem.keys[key] = acceptedAt;
  const size = Object.keys(mem.keys).length;
  if (size <= Math.floor(cap * 1.25)) return;
  const ordered = Object.entries(mem.keys).sort((a, b) => a[1] - b[1]);
  const drop = ordered.slice(0, size - cap);
  for (const [k] of drop) delete mem.keys[k];
  mem.horizon = Math.max(mem.horizon, drop[drop.length - 1]![1]);
}

function known(mem: Memory, key: string, acceptedAt: number): boolean {
  return key in mem.keys || acceptedAt <= mem.horizon;
}

export class ChannelClockLedger {
  private readonly journal: RecordJournal<ClockEntry, Snapshot>;
  private state: Snapshot = emptySnapshot();
  /** Set while a write failure is unresolved: when it began and why. */
  private pendingGap: { from: number; reason: string } | null = null;
  private started = false;
  /** Inside batch(): the store has been synced for this batch's writes. */
  private batch: { synced: boolean } | null = null;

  private readonly deliveredMemory: number;
  private readonly partialMemory: number;
  private readonly checkpointEvery: number;

  constructor(
    private readonly store: JsStore,
    readonly storeId: string,
    private readonly now: () => number = Date.now,
    limits: { deliveredMemory?: number; partialMemory?: number; checkpointEvery?: number } = {},
  ) {
    this.journal = new RecordJournal<ClockEntry, Snapshot>(store, { type: CLOCK_RECORD });
    this.deliveredMemory = limits.deliveredMemory ?? DELIVERED_MEMORY;
    this.partialMemory = limits.partialMemory ?? PARTIAL_MEMORY;
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
      this.journal.checkpoint(this.state, { durable: true });
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
    const a = this.state.agents[agent];
    const key = versionHash(ver);
    if (a && known(a.dmem, key, src.acceptedAt)) return false;
    return this.write({ k: 'dlv', at, agent, ch, src, ver, branch });
  }

  /** A partial copy of `ver` reached `agent` before any complete one. */
  partial(agent: string, ch: ChannelRef, src: SourceRef, ver: VersionRef, branch: BranchStamp, why: string[], at = this.now()): boolean {
    const a = this.state.agents[agent];
    const key = versionHash(ver);
    if (a && (known(a.dmem, key, src.acceptedAt) || known(a.pmem, key, src.acceptedAt))) return false;
    return this.write({ k: 'part', at, agent, ch, src, ver, branch, why });
  }

  /** Whether `agent` already has a complete delivery of `ver` (or it predates memory). */
  isDelivered(agent: string, ver: VersionRef, acceptedAt: number): boolean {
    const a = this.state.agents[agent];
    if (!a) return false;
    return known(a.dmem, versionHash(ver), acceptedAt);
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
    const a = this.state.agents[agent];
    const horizon = a ? Math.max(a.dmem.horizon, 0) : 0;
    return {
      storeId: this.storeId,
      agent,
      trackingSince: this.state.trackingSince,
      dedupHorizon: horizon > 0 ? horizon : null,
      gaps: [...this.state.gaps, ...(this.pendingGap ? [{ from: this.pendingGap.from, to: this.now(), reason: `${this.pendingGap.reason} (ongoing)` }] : [])],
      degraded: this.pendingGap !== null,
    };
  }

  // --------------------------------------------------------------------------

  private reload(): void {
    const { snapshot, entries } = this.journal.load();
    this.state = snapshot && snapshot.v === 1 ? snapshot : emptySnapshot();
    for (const { entry } of entries) this.reduce(entry);
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
    try {
      if (assertsState && this.batch) {
        if (!this.batch.synced) {
          this.store.sync();
          this.batch.synced = true;
        }
        this.journal.append(entry);
      } else {
        this.journal.append(entry, assertsState ? { afterCommittedState: true } : {});
      }
    } catch (err) {
      this.noteFailure(err);
      return false;
    }
    this.reduce(entry);
    if (this.journal.entriesSinceCheckpoint >= this.checkpointEvery) {
      try {
        this.journal.checkpoint(this.state);
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
      this.journal.append({ k: 'gap', at: to, from: gap.from, to, reason: gap.reason });
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
        remember(a.dmem, versionHash(entry.ver), entry.src.acceptedAt, this.deliveredMemory);
        break;
      }
      case 'part': {
        const a = this.agent(entry.agent);
        const key = channelKey(entry.ch);
        const prev = a.partial[key];
        if (!prev || entry.at >= prev.at) {
          a.partial[key] = { at: entry.at, src: entry.src, why: entry.why };
        }
        remember(a.pmem, versionHash(entry.ver), entry.src.acceptedAt, this.partialMemory);
        break;
      }
    }
  }
}
