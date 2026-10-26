/**
 * TuneOutCoordinator (issue #77) — the host-side machinery between a
 * tuned-out channel and the subconscious resident.
 *
 * Responsibilities: classify diverted traffic (stamp everything, wake on
 * addressed), acknowledge suppressed mentions deterministically, run the
 * per-channel summary cadence, count wakes durably with max-wakes
 * auto-cancel, and deliver the cancel dump.
 *
 * Voice doctrine ("no words in models' mouths"): everything the resident
 * reads from the subconscious is the subconscious's verbatim text under its
 * own participant name. Host-authored framing is system-styled and never
 * voiced: `<tuned-out-backlog …>` wraps raw diverted messages (the
 * <backscroll> precedent), and `[Tune-out: …]` bracket notices carry
 * lifecycle facts (the [Gate: …] precedent).
 */

import { randomUUID } from 'node:crypto';
import { authorLine } from '../author-presentation.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ChannelRef, ChannelRegistry, TuneOutParams } from '../mcpl/channel-registry.js';
import type { McplServerRegistry } from '../mcpl/server-registry.js';
import { CapabilityGrant } from '../mcpl/capability-grant.js';
import { armAfter, armAt } from '../deadline-timer.js';

/** The options a tune-out call can give. */
type TuneOutOption = 'durationSeconds' | 'cadenceSeconds' | 'backlogCap' | 'maxWakes';

/** Defaults for tune_out tool params. */
export const TUNE_OUT_DEFAULTS = {
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
} as const;

/** Coalescing window for wake invocations: a mention storm becomes one
 *  subconscious turn, and max-wakes counts invocations, not messages. */
const WAKE_COALESCE_MS = 2_000;

/**
 * One backlog line: author, then the message's blocks in order — text as
 * is, anything else named by kind (`[image]`, `[document]`), so a release
 * never drops a block silently (#232 gap 4). The author is named once: a
 * server that renders `Name: body` into the text itself is not doubled.
 */
export function renderHeldLine(m: Pick<StoredMessage, 'participant' | 'content' | 'metadata'>): string {
  const author = (m.metadata as { author?: { name?: string } } | undefined)?.author?.name ?? m.participant;
  const parts = m.content.map((b: ContentBlock) =>
    b.type === 'text' ? (b as Extract<ContentBlock, { type: 'text' }>).text : `[${b.type}]`,
  );
  return authorLine(author, parts.filter((p) => p.length > 0).join(' '));
}

/** One reader invocation under `reader: 'forks'` (see SubconsciousConfig). */
export interface ReaderInvocation {
  serverId: string;
  channelId: string;
  epochId: string;
  trigger: 'cadence' | 'wake' | 'cancel';
  /** The host-framed notice for this invocation (bracket style). */
  notice: string;
  /**
   * Held messages not yet handed to any reader fork, oldest first. A held
   * message is stored as it arrives, whatever the resident's turn (#291), so
   * a reader is handed what arrives while the resident is busy, which is
   * when a reader is most useful.
   */
  backlog: StoredMessage[];
  /** Standing dispositions, as text, or null when there are none. */
  dispositions: string | null;
}

/**
 * Where the persistent subconscious's window starts (#291, AF-5): at the
 * oldest active tune-out's start, never forward past one, so a tune-out's
 * reader sees every message it held. `sequence` is where the tune-out
 * started in the record (its startedAtSequence), which places the start
 * while the subconscious's window is the record. Once its window follows the
 * presentation index, the start is a place in that window, an index
 * ordinal, fixed once per tune-out and recorded (`ordinal`;
 * TuneOutCoordinator.subconsciousWindowFixed), since a row stored before
 * the start can be presented after it, and the sequence converted again
 * then gives another window. `epochIds` are the active tune-outs starting
 * there: one, or a channel's and the all-except hold's begun at the same
 * sequence.
 */
export interface SubconsciousWindowStart {
  sequence: number;
  /** The start as the subconscious's index ordinal, once fixed for one of `epochIds`. */
  ordinal?: number;
  epochIds: readonly string[];
}

/**
 * Whether a held message is one of this channel's: by its channel id, and by
 * its server where it records one, since two servers can register the same
 * channel id. A message recording neither is taken as the channel's, as
 * before servers were recorded.
 */
function inChannelOf(serverId: string, channelId: string): (m: Pick<StoredMessage, 'metadata'>) => boolean {
  return (m) => {
    const meta = m.metadata as { channelId?: string; serverId?: string } | undefined;
    return (meta?.channelId ?? channelId) === channelId && (meta?.serverId ?? serverId) === serverId;
  };
}

/**
 * The all-except scope (issue #232 §3.2; focus folded into tune-out): a
 * resident-level policy epoch holding every channel but one, for a bounded
 * time. It covers DMs and channels registered after entry, since the
 * decision is "not the exception" rather than a per-channel state.
 */
export interface AllExceptParams {
  epochId: string;
  except: { serverId: string; channelId: string };
  cadenceSeconds: number;
  /** Per held channel, at release. */
  backlogCap: number;
  /** Reader wakes before the reader is paused (the hold itself stays). */
  maxWakes: number;
  startedAtSequence: number;
  startedAtMs: number;
  /** Mandatory: the scope always ends on its own. */
  expiresAtMs: number;
  source: string;
}

export interface AllExceptState {
  params: AllExceptParams;
  wakeCount: number;
}

/** `check`: what is held right now, without releasing anything. */
export interface TuneOutCheck {
  allExcept: { epochId: string; except: { serverId: string; channelId: string }; expiresAtMs: number; wakeCount: number; held: Record<string, number> } | null;
  channels: Array<{ serverId: string; channelId: string; epochId: string; held: number; expiresAtMs?: number }>;
  /** Up to `peekLimit` newest held lines of the peeked channel, oldest first. */
  peek?: string[];
}

/** How long after an end time whose cancel threw the cancel is tried again. */
const EXPIRY_RETRY_MS = 60_000;

/** Ends a backlog line cut to fit in one of the residents' messages. */
const CUT_MARK = " [cut to fit; the whole message is in the channel's history]";

/**
 * tune_out's refusal of a channel already tuned out: its settings, then what
 * its transport is now where the repeat tried to open it again (`transport`,
 * from the framework's dispatch), then how to change the settings.
 */
export function alreadyTunedOutText(shown: string, p: TuneOutParams, transport?: string): string {
  // A duration so long its end is past what a Date can hold has no time to show.
  const expires = p.expiresAtMs !== undefined ? new Date(p.expiresAtMs) : undefined;
  const until = expires && Number.isFinite(expires.getTime())
    ? `, until ${expires.toISOString().replace(/\.\d+Z$/, 'Z')}`
    : '';
  // A thrown error's words may end without a stop.
  const now = transport === undefined ? '' : /[.!?]$/.test(transport) ? `${transport} ` : `${transport}. `;
  return `Nothing changed${transport !== undefined ? ' in the tune-out' : ''}: ${JSON.stringify(shown)} is already `
    + `tuned out, with cadenceSeconds ${p.cadenceSeconds}, backlogCap ${p.backlogCap} and maxWakes ${p.maxWakes}${until}. `
    + now
    + 'To change those, cancel it first with tune_out mode "cancel", which delivers its backlog to you now, then call '
    + 'tune_out again with the new settings.';
}

/** The first `length` code units of `text`, one fewer where the last would be
 *  the first half of a surrogate pair. */
function prefixOf(text: string, length: number): string {
  const cut = text.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** What a thrown value says, without throwing: an Error's message, or the
 *  value as text, which String() can't give for an object with no prototype. */
function thrownReason(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '(a value that could not be read)';
  }
}

export interface TuneOutFrameworkHooks {
  /** Deliver a message into an agent's window (per-agent seam). */
  addMessage: (
    participant: string,
    content: ContentBlock[],
    metadata?: Record<string, unknown>,
    forAgent?: string,
  ) => string;
  /** Queue an inference request for an agent. */
  requestInference: (agentName: string, reason: string, source: string) => void;
  /** The persistent subconscious's registry/participant name, or null. */
  subconsciousName: () => string | null;
  /**
   * `reader: 'forks'`: derive and run one reader fork. Absent in persistent
   * mode. The framework owns the fork's lifecycle; the coordinator owns the
   * epoch.
   */
  invokeReader?: (invocation: ReaderInvocation) => void;
  /**
   * `reader: 'forks'`: deliver a reader fork's own words to the resident
   * as attributed mail (its name, its incarnation). Absent in persistent
   * mode, where the subconscious writes under its own name directly.
   */
  deliverFromReader?: (reader: string, content: ContentBlock[], metadata: Record<string, unknown>) => void;
  /** The primary resident's registry name. */
  primaryName: () => string | null;
  /**
   * Read the primary's stored messages (shared slot, unfiltered). A held
   * message is stored as it arrives, even during the resident's turn, so
   * this is every message an epoch holds (#232 gap 7).
   */
  getStoredMessages: () => StoredMessage[];
  /**
   * Make what was just delivered durable: a release flips durable epoch
   * state, so its dump must survive a crash in the same window (#232 gap 6).
   */
  commitDeliveries?: () => void;
  /**
   * The history-reading tool the resident actually has (e.g. a server's
   * `fetch_history`), or null. A truncation note names it only when it exists
   * (#232 gap 11).
   */
  historyTool?: () => string | null;
  /**
   * The most characters of text every reader of the residents' shared slot
   * is shown whole in one message: the smallest of their strategies'
   * per-message caps (`maxMessageTokens`) at four characters a token, or
   * undefined when none has such a cap. A cancel's dump is one message in
   * that slot, so it holds as many backlog lines as fit.
   */
  residentMessageChars?: () => number | undefined;
  /** Current chronicle head sequence (window anchor for new epochs). */
  currentSequence: () => number;
  /**
   * Move the subconscious window anchor to `start`, the oldest active
   * tune-out's (never forward past active epochs): by its sequence while
   * the subconscious's window is the record, by its ordinal once that is
   * known, and else by an ordinal the framework fixes for it and reports
   * (subconsciousWindowFixed).
   */
  setSubconsciousAnchor: (start: SubconsciousWindowStart) => void;
  /**
   * Whether the subconscious's window keeps index ordinals (its context
   * manager presents rows, #291), so each tune-out's window start is kept as
   * one (`subconscious/<primary>/window-starts`). Left out, or false, none
   * is kept or read, and the anchor goes by sequence alone.
   */
  subconsciousWindowOrdinals?: () => boolean;
  /**
   * How many of the residents' stored messages `keep` keeps that the
   * persistent subconscious hasn't been shown yet: with the presentation
   * index, those its window doesn't hold; else those stored after its last
   * compile. A cancel the subconscious makes itself gives it a report turn
   * when any of its tune-out's are, since it wrote its note without them.
   * Left out, none are.
   */
  unseenBySubconscious?: (keep: (m: Pick<StoredMessage, 'metadata'>) => boolean) => number;
  /** True when a channel is bound to a conversation-fork agent. */
  isForkBound: (channel: ChannelRef) => boolean;
  /** Gate privileged-users list (#77: privileged authors wake, like mentions). */
  isPrivilegedAuthor: (authorId: string | null | undefined) => boolean;
  /** speak_in_channel master switch (recipe-side, canary-gated). */
  allowChannelSpeech: () => boolean;
  /**
   * Whether a tune-out may hold a channel with no reader at all — a silent
   * hold (issue #232 §3.3), which the host opts into (`tuneOut.enabled`).
   * Left out, or false, a hold with no reader is refused.
   */
  holdWithoutReader?: () => boolean;
  /**
   * Post a line into a channel under the resident's name. Used for the
   * all-except scope's entry and release announcements in the excepted
   * channel (Linn, 2026-10-12: the room should hear the door shut, not
   * discover it). Absent when `tuneOut.announce` is off.
   */
  announce?: (serverId: string, channelId: string, text: string) => Promise<{ success: boolean; error?: string }>;
  emitTrace: (event: { type: string; [key: string]: unknown }) => void;
}

export class TuneOutCoordinator {
  private cadenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each duration's pending timer: a step toward its end time
   *  (params.expiresAtMs), or the retry of an end-time cancel that threw.
   *  stop clears it, cancel does when it finds the tune-out in the registry,
   *  the end time does when its cancel finds the tune-out already ended,
   *  and the channel's next accepted enter does in any case. */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Channels with a wake invocation pending inside the coalescing window. */
  private pendingWakes = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();
  /** Diverted-message tallies since the last subconscious invocation, per channel key. */
  private divertedSinceInvocation = new Map<string, number>();
  /**
   * `reader: 'forks'`: the highest sequence of a held message already
   * handed to a reader fork, per channel key. Each held message is
   * delivered to exactly one fork. In-memory: after a restart the first
   * fork of an epoch is handed everything the epoch has held, which is
   * the right side to err on.
   */
  private readerCursor = new Map<string, number>();
  /**
   * `reader: 'forks'`: held messages a reader fork was handed but never read,
   * per channel key, by id: its derive failed, or its run threw before it
   * reported (readerFailed). The next invocation is handed them again,
   * cursor or no. Cleared with the cursor.
   */
  private readerReturned = new Map<string, Set<string>>();
  /** The all-except scope's durable record, cached (undefined = not read yet). */
  private scopeCache: AllExceptState | null | undefined;
  /** Timer key for the scope's cadence and expiry. */
  private static readonly SCOPE_KEY = '\0all-except';

  constructor(
    private readonly channelRegistry: ChannelRegistry,
    private readonly serverRegistry: McplServerRegistry,
    private readonly hooks: TuneOutFrameworkHooks,
  ) {}

  private key(serverId: string, channelId: string): string {
    return `${serverId}\0${channelId}`;
  }

  /** A reader exists: the persistent subconscious, or forks on demand. */
  private readerAvailable(): boolean {
    return this.hooks.subconsciousName() != null || typeof this.hooks.invokeReader === 'function';
  }

  /** Reader forks are the configured reader. */
  private get forkReader(): boolean {
    return this.hooks.subconsciousName() == null && typeof this.hooks.invokeReader === 'function';
  }

  /** A channel as the resident and the subconscious are shown it
   *  (ChannelRegistry.nameShown): its id, or, where another server registers
   *  the same id, its server-qualified name, which tune_out and
   *  cancel_tuneout take back; or, for a channel no string picks alone, its
   *  id and its server. */
  private shown(serverId: string, channelId: string): string {
    return this.channelRegistry.nameShown({ serverId, channelId });
  }

  /** Restart cadence + expiry timers and re-anchor after a process restart. */
  resumeActiveEpochs(): void {
    for (const { serverId, channelId, params } of this.listActive()) {
      // An epoch whose deadline passed while the process was down cancels
      // immediately — the resident gets their backlog on the schedule they
      // committed to, not whenever the host happened to restart.
      if (params.expiresAtMs !== undefined && params.expiresAtMs <= Date.now()) {
        this.cancel(serverId, channelId, 'duration', 'duration elapsed');
        continue;
      }
      this.startCadence(serverId, channelId, params.cadenceSeconds);
      this.armExpiry(serverId, channelId, params);
    }
    const scope = this.getAllExcept();
    if (scope) {
      if (scope.params.expiresAtMs <= Date.now()) {
        this.cancelAllExcept('duration', 'duration elapsed');
      } else {
        this.armScopeTimers(scope.params);
      }
    }
    // A window start kept for a tune-out that ended while the process was
    // down, its cancel's own forget not written, goes now.
    this.pruneWindowStarts();
    this.anchorSubconscious();
  }

  /** The tune-outs active now, a channel's and the all-except hold, with where each started in the record. */
  private activeStarts(): Array<{ epochId: string; sequence: number }> {
    const starts = this.listActive().map(({ params }) => ({ epochId: params.epochId, sequence: params.startedAtSequence }));
    const scope = this.getAllExcept();
    if (scope) starts.push({ epochId: scope.params.epochId, sequence: scope.params.startedAtSequence });
    return starts;
  }

  /**
   * Set the subconscious's window start to the oldest active tune-out's
   * (setSubconsciousAnchor), with its ordinal when one was fixed for it. The
   * all-except hold counts with the channels' tune-outs, wherever this is
   * called, so a channel's tune-out entered during an older hold leaves the
   * start at the hold's. Nothing when none is active: the anchor stays where
   * it was, as a cancel leaves it.
   */
  private anchorSubconscious(): void {
    const active = this.activeStarts();
    if (active.length === 0) return;
    const sequence = Math.min(...active.map((e) => e.sequence));
    const epochIds = active.filter((e) => e.sequence === sequence).map((e) => e.epochId);
    const starts = this.ordinalsKept() ? this.readWindowStarts() : {};
    const ordinal = epochIds.map((id) => starts[id]).find((o) => o !== undefined);
    this.hooks.setSubconsciousAnchor({ sequence, ...(ordinal !== undefined ? { ordinal } : {}), epochIds });
  }

  // ==========================================================================
  // Window starts (the subconscious's, by ordinal)
  // ==========================================================================

  /** Where each active tune-out's window start is kept, by ordinal: a snapshot state, on each branch its own. */
  private get windowStartsStateId(): string {
    return `subconscious/${this.hooks.primaryName() ?? 'default'}/window-starts`;
  }

  /** Whether the subconscious's window keeps ordinals, so its starts are kept (subconsciousWindowOrdinals). */
  private ordinalsKept(): boolean {
    try {
      return this.hooks.subconsciousName() != null && this.hooks.subconsciousWindowOrdinals?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * Each tune-out's window start as an ordinal, by epoch id, as kept on the
   * store's branch now. A state that can't be read, or isn't this format
   * (`{ v: 1, starts }`), reads as none kept, and is written over at the
   * next fix, with a line saying so.
   */
  private readWindowStarts(): Record<string, number> {
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.windowStartsStateId);
    } catch (err) {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) can't be read, so none is kept:`, err);
      return {};
    }
    if (raw == null) return {};
    const state = raw as { v?: unknown; starts?: unknown };
    if (state.v !== 1 || !state.starts || typeof state.starts !== 'object') {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) aren't in a form this version reads, so none is kept; the next fix writes over them`);
      return {};
    }
    const starts: Record<string, number> = {};
    for (const [epochId, ordinal] of Object.entries(state.starts as Record<string, unknown>)) {
      if (typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 0) starts[epochId] = ordinal;
    }
    return starts;
  }

  /** Keep `starts`; a write that fails is logged, and the anchor the strategy holds stays as it is. */
  private writeWindowStarts(starts: Record<string, number>): void {
    try {
      this.channelRegistry.writeCoordinatorState(this.windowStartsStateId, { v: 1, starts });
    } catch (err) {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) couldn't be written, so a restart fixes them again:`, err);
    }
  }

  /**
   * The framework fixed the subconscious's window start for `epochIds` at
   * `ordinal` (its index ordinal, #291): kept for each of them still active,
   * so a later anchor (another tune-out's enter, a restart) sets that
   * ordinal again rather than converting the tune-out's sequence anew.
   */
  subconsciousWindowFixed(epochIds: readonly string[], ordinal: number): void {
    if (!this.ordinalsKept()) return;
    const active = new Set(this.activeStarts().map((e) => e.epochId));
    const starts = this.readWindowStarts();
    let changed = false;
    for (const epochId of epochIds) {
      if (!active.has(epochId) || starts[epochId] === ordinal) continue;
      starts[epochId] = ordinal;
      changed = true;
    }
    if (changed) this.writeWindowStarts(starts);
  }

  /** An ended tune-out's window start goes. */
  private forgetWindowStart(epochId: string): void {
    if (!this.ordinalsKept()) return;
    const starts = this.readWindowStarts();
    if (!(epochId in starts)) return;
    delete starts[epochId];
    this.writeWindowStarts(starts);
  }

  /** The window starts of tune-outs no longer active go. */
  private pruneWindowStarts(): void {
    if (!this.ordinalsKept()) return;
    const starts = this.readWindowStarts();
    const active = new Set(this.activeStarts().map((e) => e.epochId));
    const stale = Object.keys(starts).filter((epochId) => !active.has(epochId));
    if (stale.length === 0) return;
    for (const epochId of stale) delete starts[epochId];
    this.writeWindowStarts(starts);
  }

  private armExpiry(serverId: string, channelId: string, params: TuneOutParams): void {
    if (params.expiresAtMs === undefined) return;
    const key = this.key(serverId, channelId);
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.expiryTimers.set(key, timer); };
    const end = (): void => {
      try {
        // The retry is armed before the cancel, as the cadence arms its next
        // period before its turn, so a cancel that throws is tried again. A
        // cancel that ends the tune-out clears it with the channel's other
        // timers, and so does finding the tune-out already ended.
        hold(setTimeout(end, EXPIRY_RETRY_MS));
        if (!this.cancel(serverId, channelId, 'duration', 'duration elapsed').ok) {
          this.clearTimers(serverId, channelId);
        }
      } catch (err) {
        this.timerFailed('expiry', serverId, channelId, err);
      }
    };
    armAt(params.expiresAtMs, hold, end);
  }

  /** A timer callback's work threw. Report it on stderr and as a trace rather
   *  than throw it into the event loop, where an uncaught exception ends the
   *  host process. */
  private timerFailed(timer: 'cadence' | 'wake' | 'expiry', serverId: string, channelId: string, err: unknown): void {
    console.error(`[tune-out] the ${timer} timer for ${channelId} on ${serverId} failed:`, err);
    this.hooks.emitTrace({
      type: 'tune-out:timer-failed',
      timer,
      serverId,
      channelId,
      error: thrownReason(err),
    });
  }

  private listActive(): Array<{ serverId: string; channelId: string; params: TuneOutParams }> {
    const active: Array<{ serverId: string; channelId: string; params: TuneOutParams }> = [];
    for (const entry of this.channelRegistry.listChannelsRaw()) {
      const state = this.channelRegistry.getTuneOutState(entry.serverId, entry.descriptor.id);
      if (state) {
        active.push({ serverId: entry.serverId, channelId: entry.descriptor.id, params: state.params });
      }
    }
    return active;
  }

  // ==========================================================================
  // Enter / cancel
  // ==========================================================================

  /**
   * The options a tune-out call gives, read as numbers before anything
   * changes (F76). A tool's input reaches here as the model wrote it, and
   * the store can't keep a NaN or an Infinity: its append would throw after
   * the registry had marked the channel tuned out. So each option is read
   * as a number first, a numeric string included, as the sleep tool reads
   * its seconds; null counts as left out. A value that gives no finite
   * number is refused, naming the option and, where it can be left out,
   * what leaving it out means; so is a duration whose end time is too far
   * off to store. `now` is the clock the end time was counted from. One
   * rule for a channel's tune-out and the all-except hold.
   */
  private readOptions(
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
    leftOut: Record<TuneOutOption, string | null>,
  ): { ok: true; given: Partial<Record<TuneOutOption, number>>; now: number; expiresAtMs: number | undefined } | { ok: false; error: string } {
    const given: Partial<Record<TuneOutOption, number>> = {};
    for (const name of Object.keys(leftOut) as TuneOutOption[]) {
      const value: unknown = opts[name];
      if (value == null) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) {
        const got = typeof value === 'number'
          ? String(value)
          : `${typeof value === 'string' ? 'the string' : 'the value'} ${JSON.stringify(value)}`;
        return {
          ok: false,
          error: `Nothing was tuned out: ${name} must be a finite number${name.endsWith('Seconds') ? ' of seconds' : ''}, `
            + `and it was ${got}.${leftOut[name] ? ` Leave it out ${leftOut[name]}.` : ''}`,
        };
      }
      given[name] = n;
    }
    const now = Date.now();
    const expiresAtMs = given.durationSeconds === undefined
      ? undefined
      : now + Math.max(60, given.durationSeconds) * 1000;
    if (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs)) {
      return {
        ok: false,
        error: `Nothing was tuned out: durationSeconds ${given.durationSeconds} is longer than an end time can be kept.`
          + (leftOut.durationSeconds ? ` Leave it out ${leftOut.durationSeconds}.` : ''),
      };
    }
    return { ok: true, given, now, expiresAtMs };
  }

  enter(
    serverId: string,
    channelId: string,
    opts: { cadenceSeconds?: number; backlogCap?: number; maxWakes?: number; durationSeconds?: number },
    source: string,
  ): { ok: true; params: TuneOutParams } | { ok: false; error: string; alreadyTunedOut?: true } {
    // No reader (issue #232 §3.3): a silent hold, where the host opted into
    // one. Nothing summarizes, nothing wakes, mentions are still
    // acknowledged, the backlog is released on cancel; the resident is told
    // so in the tool result. A host that didn't opt in has no tune_out
    // without a reader.
    if (!this.readerAvailable() && this.hooks.holdWithoutReader?.() !== true) {
      return {
        ok: false,
        error: 'Nothing was tuned out: this host has no subconscious resident to watch a channel, so tune_out '
          + "isn't available here, and calling it again won't change that. If you need channels diverted, ask "
          + 'whoever runs this host.',
      };
    }
    if (this.hooks.isForkBound({ serverId, channelId })) {
      return {
        ok: false,
        error: `Nothing changed: a conversation is bound to ${JSON.stringify(this.shown(serverId, channelId))}, so its messages go to that `
          + "conversation, and tune_out won't divert a channel while one is. Calling tune_out on it again won't change "
          + 'that until the conversation ends, which happens only once the channel has been quiet for a while. Tune '
          + 'out a different channel, or ask whoever runs this host if this one should be diverted.',
      };
    }
    const current = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (current) return { ok: false, error: alreadyTunedOutText(this.shown(serverId, channelId), current.params), alreadyTunedOut: true };
    const scope = this.getAllExcept();
    if (scope && scope.params.except.serverId === serverId && scope.params.except.channelId === channelId) {
      return { ok: false, error: `channel ${channelId} is the excepted channel of the active all-except hold; cancel that first` };
    }
    const read = this.readOptions(opts, {
      durationSeconds: 'to stay tuned out until you cancel',
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    });
    if (!read.ok) return read;
    const { given, expiresAtMs } = read;
    const params: TuneOutParams = {
      epochId: randomUUID(),
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
    // A tune-out that ended in the registry without this coordinator's
    // cancel would have left its timers armed: clear them, so none of them
    // acts on this one.
    this.clearTimers(serverId, channelId);
    this.channelRegistry.enterTuneOut(serverId, channelId, params, source);
    this.armExpiry(serverId, channelId, params);

    // Window anchor: start of the OLDEST active tune-out. Never move the
    // anchor forward here — an older active epoch owns it.
    this.anchorSubconscious();

    this.divertedSinceInvocation.set(this.key(serverId, channelId), 0);
    if (this.readerAvailable()) this.startCadence(serverId, channelId, params.cadenceSeconds);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId, channelId, epochId: params.epochId, reader: this.readerAvailable(),
    });
    return { ok: true, params };
  }

  /** Whether a reader (persistent subconscious or reader forks) attends holds. */
  hasReader(): boolean {
    return this.readerAvailable();
  }

  /**
   * End a tune-out: durable flip, system-framed backlog dump into the
   * resident's window (capped), lifecycle notice, one wake for the
   * resident. `subconsciousNote` is the subconscious's own text (from its
   * cancel_tuneout call) — delivered verbatim under its name, never
   * synthesized here.
   */
  cancel(
    serverId: string,
    channelId: string,
    source: string,
    reason: string,
    subconsciousNote?: string,
    /** `reader: 'forks'`: the reader fork whose note this is. */
    noteAuthor?: string,
    /** The lifecycle state the channel returns to (a tool close ends in 'closed'). */
    nextState: 'open' | 'closed' = 'open',
  ): { ok: true } | { ok: false; error: string } {
    const ended = this.channelRegistry.cancelTuneOut(serverId, channelId, nextState, source);
    if (!ended) {
      // Its reader is the resident's tune_out: cancel_tuneout finds the channel first.
      return { ok: false, error: this.notTunedOut(this.shown(serverId, channelId), 'you') };
    }
    this.clearTimers(serverId, channelId);
    this.divertedSinceInvocation.delete(this.key(serverId, channelId));

    // Backlog: every message held under this epoch, in store order, which
    // is arrival order: a held message is stored as it arrives (#291).
    const epochId = ended.params.epochId;
    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const backlog: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> =
      this.hooks.getStoredMessages().filter(ofEpoch);
    // Whole messages: a cap below one shows none, where slice(-0.5) would
    // start at 0 and take them all.
    const cap = Math.floor(ended.params.backlogCap);
    // A line names its author as the resident knows them and marks what a
    // text line can't carry (`[image]`), so the dump says what it leaves out.
    const lineOf = renderHeldLine;
    // The tool the truncation note names (#232 gap 11): the one the resident
    // has, when the host says; main's `fetch_history` where no host says.
    const historyTool = this.hooks.historyTool ? this.hooks.historyTool() : 'fetch_history';
    // The channel as the resident and the subconscious are shown it.
    const name = this.shown(serverId, channelId);
    const lifecycle = `[Tune-out: ${name} cancelled — ${reason}, ${ended.wakeCount} wake${ended.wakeCount === 1 ? '' : 's'}]`;
    const render = (lines: string[], truncated: number): string => {
      const attrs = [
        `channel="${name}"`,
        `messages=${backlog.length}`,
        ...(truncated > 0
          ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`]
          : []),
      ];
      return `${lifecycle}\n\n<tuned-out-backlog ${attrs.join(' ')}>\n${lines.join('\n')}\n</tuned-out-backlog>`;
    };

    // The dump is one message in the residents' shared slot, so each
    // resident's strategy cuts it as it cuts any message past its per-message
    // cap: context-manager's AutobiographicalStrategy (which connectome-host's
    // FrontdeskStrategy extends) and WindowedPassthroughStrategy count a text
    // block at a token per four characters, rounded up, and keep a message's
    // first cap × 4 characters. Cut there, the dump would lose its newest
    // lines, which would still count as shown. So it holds the newest lines
    // that fit whole in the smallest such room, and those it leaves out, the
    // oldest, count as truncated along with those above backlogCap, so the
    // report is told of them. A newest message too long to fit alone is shown
    // cut to the room left and marked, so the residents still get its head,
    // as they would from a row of its own. When no line fits, whole or cut,
    // the dump shows none; if the room is too small for even that, the
    // residents' strategies cut its frame, the header and tags.
    let shown = cap > 0 ? backlog.slice(-cap) : [];
    let lines = shown.map(lineOf);
    const room = this.hooks.residentMessageChars?.();
    if (room !== undefined && render(lines, backlog.length - shown.length).length > room) {
      // The dump's length with no line, for the count that showing k lines
      // leaves out: truncated= takes that count's digits, and goes at 0. With
      // the newest k lines whole, the dump is that and the lines, with a
      // newline between each two. While a message is left out, each line kept
      // makes it longer, and they don't all fit, so the fit keeps lines from
      // the newest while the next one fits.
      const frameShowing = (k: number): number => render([], backlog.length - k).length;
      let used = 0;
      let kept = 0;
      while (kept < lines.length) {
        const next = used + lines[lines.length - 1 - kept]!.length + (kept > 0 ? 1 : 0);
        if (frameShowing(kept + 1) + next > room) break;
        used = next;
        kept++;
      }
      // What of the newest line's text fits beside the frame and the mark. A
      // cut shows some of it or none: a room under one character, or one
      // that would split a surrogate pair, leaves the head empty.
      const head = prefixOf(lines.at(-1) ?? '', room - frameShowing(1) - CUT_MARK.length);
      if (kept === 0 && head !== '') {
        lines = [head + CUT_MARK];
        shown = shown.slice(-1);
      } else {
        lines = lines.slice(lines.length - kept);
        shown = shown.slice(shown.length - kept);
      }
    }
    const truncated = backlog.length - shown.length;

    // Host-framed system artifacts — never voiced as anyone.
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: render(lines, truncated) }],
      { system: true, kind: 'tune-out-cancel', channelId, epochId },
    );
    // The epoch is already ended durably; the release must be as durable.
    this.hooks.commitDeliveries?.();
    // The subconscious's own words, under its own name, verbatim.
    const subName = this.hooks.subconsciousName();
    if (subconsciousNote && subName) {
      this.hooks.addMessage(
        subName,
        [{ type: 'text', text: subconsciousNote }],
        // With its server: a conversational row whose channel the framework
        // reads (repinChannel), where another server's channel can share the id.
        { kind: 'subconscious-note', channelId, serverId, epochId },
      );
    } else if (subconsciousNote && noteAuthor && this.hooks.deliverFromReader) {
      // A reader fork's note: attributed mail, under the fork's name and
      // incarnation, never the resident's voice.
      this.hooks.deliverFromReader(
        noteAuthor,
        [{ type: 'text', text: subconsciousNote }],
        { kind: 'subconscious-note', channelId, epochId },
      );
    }
    const primary = this.hooks.primaryName();
    if (primary) {
      this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    }
    // The subconscious gets one cancel turn of its own: the issue's cancel
    // shape is dump + a report from the subconscious, and when the dump left
    // messages out, its summary is what covers them. Every held message is
    // stored (#291), so its view has them all, the newest at its next point.
    // A cancel the subconscious makes itself gets the notice and the turn
    // when some of the epoch's messages are ones it hasn't been shown yet
    // (unseenBySubconscious: those that came in during its own turn, say),
    // since it wrote its note before it could see them, and the notice says
    // how many; and when it wrote no note and the dump left any message out,
    // since nothing else then covers it. Otherwise its note speaks for what
    // it saw.
    const selfCancel = source === 'subconscious';
    const unseen = subName && selfCancel ? this.unseenBySubconscious(ofEpoch) : 0;
    if (subName && (!selfCancel || unseen > 0 || (!subconsciousNote && truncated > 0))) {
      const truncNote = truncated > 0
        ? ` ${truncated} of ${backlog.length} diverted messages, the oldest, weren't delivered raw to the resident.`
        : '';
      const unseenNote = unseen > 0
        ? ` ${unseen === 1 ? 'One of its held messages' : `${unseen} of its held messages`} came in after you last looked; your view has ${unseen === 1 ? 'it' : 'them'} now.`
        : '';
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: `[Tune-out cancelled: ${this.shown(serverId, channelId)} — ${reason}.${truncNote}${unseenNote}]` }],
        { system: true, kind: 'tune-out-cancel-report', channelId },
        subName,
      );
      this.hooks.requestInference(subName, `tune-out cancelled: ${name}`, 'tune-out');
    } else if (!subName && this.forkReader) {
      // Forks are the reader: one last fork for the epoch, handed what no
      // fork has been handed yet, plus the cancel notice; its report follows
      // the dump. On a reader's own cancel, the reader has read what it was
      // handed, so a fork follows only when messages arrived after that.
      const stored = this.hooks.getStoredMessages().filter(ofEpoch);
      const unread = this.unhandedBacklog(this.key(serverId, channelId), stored).length;
      if (!selfCancel || unread > 0) {
        const truncNote = truncated > 0
          ? ` ${truncated} of ${backlog.length} diverted messages, the oldest, weren't delivered raw to the resident.`
          : '';
        const lateNote = selfCancel
          ? ` ${unread === 1 ? 'This message' : `These ${unread} messages`} arrived after the reader that cancelled was handed its own.`
          : '';
        this.invokeReaderFork(serverId, channelId, epochId, 'cancel', `[Tune-out cancelled: ${name} — ${reason}.${truncNote}${lateNote}]`, stored);
      }
    }
    this.readerCursor.delete(this.key(serverId, channelId));
    this.readerReturned.delete(this.key(serverId, channelId));
    this.forgetWindowStart(epochId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId, channelId, epochId, reason, wakeCount: ended.wakeCount });
    return { ok: true };
  }

  /** How many stored messages `keep` keeps the subconscious hasn't been shown (the hook's count), 0 where the host can't say. */
  private unseenBySubconscious(keep: (m: Pick<StoredMessage, 'metadata'>) => boolean): number {
    try {
      return this.hooks.unseenBySubconscious?.(keep) ?? 0;
    } catch (err) {
      console.error('[tune-out] could not count the held messages the subconscious has not been shown, so none is counted:', err);
      return 0;
    }
  }

  // ==========================================================================
  // Ingestion: divert, stamp, classify
  // ==========================================================================

  /**
   * Consulted by the framework for every incoming channel message BEFORE
   * storage. Null = channel not tuned out (proceed normally). Otherwise the
   * caller stamps `metadata.tuneOut = { epochId }`, stores the message
   * without waking the residents, and this coordinator has already handled
   * wake bookkeeping (coalesced subconscious invocation, durable count,
   * suppression ack, possible auto-cancel).
   */
  onIncoming(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
    gatePass = true,
  ): { epochId: string } | null {
    const hold = this.holdFor(serverId, channelId);
    if (!hold) return null;
    this.recordHeld(serverId, channelId, messageId, tags, authorId, gatePass);
    return hold;
  }

  /** The epoch holding this channel, or null. Pure: the admission stage's lookup. */
  holdFor(serverId: string, channelId: string): { epochId: string } | null {
    // Precedence: a per-channel epoch keeps its own hold (cadence, budget,
    // stamp); the all-except scope holds whatever else is not the exception.
    const state = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (state) return { epochId: state.params.epochId };
    const scope = this.getAllExcept();
    if (scope && !(scope.params.except.serverId === serverId && scope.params.except.channelId === channelId)) {
      return { epochId: scope.params.epochId };
    }
    return null;
  }

  /** The channel unprefixed speech lands in while an all-except hold is active, with its server, else null. */
  focusChannel(): ChannelRef | null {
    const except = this.getAllExcept()?.params.except;
    return except ? { serverId: except.serverId, channelId: except.channelId } : null;
  }

  // ==========================================================================
  // All-except scope
  // ==========================================================================

  private get scopeStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/all-except`;
  }

  getAllExcept(): AllExceptState | null {
    if (this.scopeCache !== undefined) return this.scopeCache;
    try {
      const raw = this.channelRegistry.readCoordinatorState(this.scopeStateId) as AllExceptState | null;
      this.scopeCache = raw && typeof raw === 'object' && raw.params && typeof raw.params.epochId === 'string' ? raw : null;
    } catch {
      this.scopeCache = null;
    }
    return this.scopeCache;
  }

  private writeScope(state: AllExceptState | null): void {
    this.scopeCache = state;
    this.channelRegistry.writeCoordinatorState(this.scopeStateId, state);
  }

  enterAllExcept(
    except: { serverId: string; channelId: string },
    opts: { cadenceSeconds?: number; backlogCap?: number; maxWakes?: number; durationSeconds?: number },
    source: string,
  ): { ok: true; params: AllExceptParams } | { ok: false; error: string } {
    const read = this.readOptions(opts, {
      durationSeconds: null,
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    });
    if (!read.ok) return read;
    const { given, expiresAtMs } = read;
    if (expiresAtMs === undefined) {
      return { ok: false, error: 'an all-except hold needs `durationSeconds`: it always ends on its own' };
    }
    if (this.getAllExcept()) {
      return { ok: false, error: 'an all-except hold is already active (cancel it first)' };
    }
    if (this.channelRegistry.getTuneOutState(except.serverId, except.channelId)) {
      return { ok: false, error: `channel ${except.channelId} is tuned out; it cannot be the exception` };
    }
    if (this.hooks.isForkBound(except)) {
      return { ok: false, error: `channel ${except.channelId} is bound to a conversation fork` };
    }
    const params: AllExceptParams = {
      epochId: randomUUID(),
      except,
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      startedAtMs: read.now,
      expiresAtMs,
      source,
    };
    this.writeScope({ params, wakeCount: 0 });
    this.anchorSubconscious();
    this.armScopeTimers(params);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId: except.serverId, channelId: except.channelId, epochId: params.epochId,
      scope: 'all-except', reader: this.readerAvailable(), expiresAtMs: params.expiresAtMs,
    });
    const minutes = Math.max(1, Math.round((params.expiresAtMs - params.startedAtMs) / 60_000));
    const until = new Date(params.expiresAtMs).toISOString().slice(11, 16);
    this.announce(except, params.epochId, 'entered',
      `[Focus: ${this.hooks.primaryName() ?? 'the resident'} is here for ${minutes} min, until ${until} UTC; other channels are held meanwhile.]`);
    return { ok: true, params };
  }

  /** Whether entry and release of the all-except scope are announced in the excepted channel. */
  announces(): boolean {
    return typeof this.hooks.announce === 'function';
  }

  /**
   * The excepted channel hears the scope open and close: one bracketed line
   * under the resident's name, posted through the same path as a publish.
   * Fire-and-forget; the outcome is traced, never awaited by the epoch flip.
   */
  private announce(
    target: { serverId: string; channelId: string },
    epochId: string,
    kind: 'entered' | 'released',
    text: string,
  ): void {
    if (!this.hooks.announce) return;
    const base = { serverId: target.serverId, channelId: target.channelId, epochId, kind };
    this.hooks.announce(target.serverId, target.channelId, text).then(
      (r) => this.hooks.emitTrace(r.success
        ? { type: 'tune-out:announced', ...base }
        : { type: 'tune-out:announce-failed', ...base, error: r.error ?? 'publish failed' }),
      (err: unknown) => this.hooks.emitTrace({ type: 'tune-out:announce-failed', ...base, error: (err as Error).message }),
    );
  }

  /** The scope's end time and cadence, on timers no longer than one holds
   *  (deadline-timer), as a channel's tune-out arms its own. */
  private armScopeTimers(params: AllExceptParams): void {
    const key = TuneOutCoordinator.SCOPE_KEY;
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    armAt(params.expiresAtMs, (timer) => { this.expiryTimers.set(key, timer); }, () => {
      this.expiryTimers.delete(key);
      this.cancelAllExcept('duration', 'duration elapsed');
    });
    if (!this.readerAvailable()) return;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      const scope = this.getAllExcept();
      if (!scope) return;
      // One look per held channel with new traffic since the last look.
      for (const [channelKey, diverted] of this.divertedSinceInvocation) {
        if (diverted <= 0) continue;
        const [serverId, channelId] = channelKey.split('\0') as [string, string];
        if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue; // a per-channel epoch's own cadence
        this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
      }
      armAfter(params.cadenceSeconds * 1000, hold, tick);
    };
    armAfter(params.cadenceSeconds * 1000, hold, tick);
  }

  private clearScopeTimers(): void {
    const key = TuneOutCoordinator.SCOPE_KEY;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    this.cadenceTimers.delete(key);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
  }

  /** Channels held by the scope (not by their own epoch) with the count held under it. */
  private scopeHeldCounts(epochId: string): Map<string, { serverId: string; channelId: string; count: number }> {
    const counts = new Map<string, { serverId: string; channelId: string; count: number }>();
    for (const m of this.hooks.getStoredMessages()) {
      const meta = m.metadata as { tuneOut?: { epochId?: string }; channelId?: string; serverId?: string } | undefined;
      if (meta?.tuneOut?.epochId !== epochId) continue;
      const channelId = typeof meta.channelId === 'string' ? meta.channelId : '(unknown channel)';
      const serverId = typeof meta.serverId === 'string' ? meta.serverId : '';
      const k = this.key(serverId, channelId);
      const entry = counts.get(k) ?? { serverId, channelId, count: 0 };
      entry.count += 1;
      counts.set(k, entry);
    }
    return counts;
  }

  /**
   * End the all-except hold: durable flip, one release notice with a
   * per-channel backlog (each capped), the reader's note if any, one wake
   * for the resident, and the reader's own look at what it had not seen.
   */
  cancelAllExcept(
    source: string,
    reason: string,
    note?: string,
    noteAuthor?: string,
  ): { ok: true } | { ok: false; error: string } {
    const scope = this.getAllExcept();
    if (!scope) return { ok: false, error: 'no all-except hold is active' };
    this.writeScope(null);
    this.clearScopeTimers();
    const { epochId, except, backlogCap } = scope.params;
    for (const [key, pending] of this.pendingWakes) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue;
      clearTimeout(pending.timer);
      this.pendingWakes.delete(key);
    }

    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const all = this.hooks.getStoredMessages().filter(ofEpoch);
    const byChannel = new Map<string, Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>>();
    for (const m of all) {
      const channelId = (m.metadata as { channelId?: string } | undefined)?.channelId ?? '(unknown channel)';
      byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), m]);
    }
    const historyTool = this.hooks.historyTool?.() ?? null;
    const dumps = [...byChannel.entries()].map(([channelId, backlog]) => {
      const shown = backlogCap > 0 ? backlog.slice(-backlogCap) : [];
      const truncated = backlog.length - shown.length;
      const attrs = [
        `channel="${channelId}"`,
        `messages=${backlog.length}`,
        ...(truncated > 0 ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`] : []),
      ];
      return `<tuned-out-backlog ${attrs.join(' ')}>\n${shown.map(renderHeldLine).join('\n')}\n</tuned-out-backlog>`;
    });
    const summary = byChannel.size === 0
      ? 'Nothing was held.'
      : `${all.length} message${all.length === 1 ? '' : 's'} held in ${byChannel.size} channel${byChannel.size === 1 ? '' : 's'}.`;
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: `[Tune-out: all channels except ${except.channelId} released — ${reason}, ${scope.wakeCount} wake${scope.wakeCount === 1 ? '' : 's'}]\n\n${summary}${dumps.length > 0 ? '\n\n' + dumps.join('\n\n') : ''}` }],
      { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: except.channelId, epochId },
    );
    this.hooks.commitDeliveries?.();
    const subName = this.hooks.subconsciousName();
    if (note && subName) {
      this.hooks.addMessage(subName, [{ type: 'text', text: note }], { kind: 'subconscious-note', epochId });
    } else if (note && noteAuthor && this.hooks.deliverFromReader) {
      this.hooks.deliverFromReader(noteAuthor, [{ type: 'text', text: note }], { kind: 'subconscious-note', epochId });
    }
    const primary = this.hooks.primaryName();
    if (primary) this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    const notice = `[Tune-out cancelled: all channels except ${except.channelId} — ${reason}.]`;
    if (source !== 'subconscious' && subName) {
      this.hooks.addMessage('user', [{ type: 'text', text: notice }], { system: true, kind: 'tune-out-cancel-report', scope: 'all-except' }, subName);
      this.hooks.requestInference(subName, 'tune-out cancelled: all-except', 'tune-out');
    } else if (!subName && this.forkReader) {
      // One last look per channel with messages no fork was handed. That
      // holds for a reader's own release too: the reader that released read one channel's
      // messages, and every other channel's would otherwise reach no reader.
      // A channel is its server and id here, as the readers' bookkeeping is,
      // where the dump above groups by id.
      const channels = new Map<string, ChannelRef>();
      for (const m of all) {
        const meta = m.metadata as { channelId?: string; serverId?: string } | undefined;
        const ref = { serverId: meta?.serverId ?? '', channelId: meta?.channelId ?? '(unknown channel)' };
        channels.set(this.key(ref.serverId, ref.channelId), ref);
      }
      for (const { serverId, channelId } of channels.values()) {
        const ofChannel = inChannelOf(serverId, channelId);
        const inChannel = (m: Pick<StoredMessage, 'metadata'>): boolean => ofEpoch(m) && ofChannel(m);
        const stored = this.hooks.getStoredMessages().filter(inChannel);
        if (this.unhandedBacklog(this.key(serverId, channelId), stored).length > 0) {
          this.invokeReaderFork(serverId, channelId, epochId, 'cancel', notice, stored);
        }
      }
    }
    for (const key of [...this.divertedSinceInvocation.keys(), ...this.readerCursor.keys(), ...this.readerReturned.keys()]) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (!this.channelRegistry.getTuneOutState(serverId, channelId)) {
        this.divertedSinceInvocation.delete(key);
        this.readerCursor.delete(key);
        this.readerReturned.delete(key);
      }
    }
    this.forgetWindowStart(epochId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId: except.serverId, channelId: except.channelId, epochId, scope: 'all-except', reason, wakeCount: scope.wakeCount });
    this.announce(except, epochId, 'released', `[Focus: ${primary ?? 'the resident'} released — ${reason}.]`);
    return { ok: true };
  }

  /** What is held right now — per-channel epochs and the scope — without releasing. */
  check(opts: { peek?: { serverId?: string; channelId: string }; peekLimit?: number } = {}): TuneOutCheck {
    const stored = this.hooks.getStoredMessages();
    const countOf = (epochId: string) => stored.filter(
      (m) => (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId,
    ).length;
    const channels = this.listActive().map(({ serverId, channelId, params }) => ({
      serverId, channelId, epochId: params.epochId, held: countOf(params.epochId),
      ...(params.expiresAtMs !== undefined ? { expiresAtMs: params.expiresAtMs } : {}),
    }));
    const scope = this.getAllExcept();
    let allExcept: TuneOutCheck['allExcept'] = null;
    if (scope) {
      const held: Record<string, number> = {};
      for (const { channelId, count } of this.scopeHeldCounts(scope.params.epochId).values()) held[channelId] = count;
      allExcept = { epochId: scope.params.epochId, except: scope.params.except, expiresAtMs: scope.params.expiresAtMs, wakeCount: scope.wakeCount, held };
    }
    const result: TuneOutCheck = { allExcept, channels };
    if (opts.peek) {
      const limit = Math.max(1, Math.min(50, opts.peekLimit ?? 5));
      // Only what is held NOW: the channel's own epoch, or the scope's. A
      // released epoch's messages are delivered, not held; showing them here
      // would be a false declaration (first live run, 2026-10-12, finding B).
      const active = new Set<string>();
      for (const e of channels) {
        if (e.channelId === opts.peek.channelId && (!opts.peek.serverId || e.serverId === opts.peek.serverId)) active.add(e.epochId);
      }
      if (scope) active.add(scope.params.epochId);
      const lines = stored
        .filter((m) => {
          const meta = m.metadata as { tuneOut?: { epochId?: string }; channelId?: string; serverId?: string } | undefined;
          return typeof meta?.tuneOut?.epochId === 'string' && active.has(meta.tuneOut.epochId)
            && meta.channelId === opts.peek!.channelId
            && (!opts.peek!.serverId || meta.serverId === opts.peek!.serverId);
        })
        .slice(-limit)
        .map(renderHeldLine);
      result.peek = lines;
    }
    return result;
  }

  /**
   * Bookkeeping for one held message, after admission decided the hold:
   * the cadence tally, the deterministic acknowledgement of a suppressed
   * mention, and the reader wake when the resident's gate would have woken
   * them (`gatePass` is that verdict, probed without side effects).
   */
  recordHeld(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
    gatePass = true,
  ): void {
    const key = this.key(serverId, channelId);
    this.divertedSinceInvocation.set(key, (this.divertedSinceInvocation.get(key) ?? 0) + 1);

    // Wake classification: the resident's wake gate composes as a
    // PRECONDITION (antra, #tuneout-talk: the subconscious is affected BY
    // main's wake gate, it does not replace it) — an event the gate would
    // suppress for the resident (muted author, rate-limit) must not wake
    // the subconscious either; it diverts silently into the backlog and
    // surfaces in cadence summaries. On top of the gate: addressed
    // mentions and gate-privileged authors wake, per the issue.
    const addressed = Array.isArray(tags) && tags.includes('chat:addressed');
    const privileged = this.hooks.isPrivilegedAuthor(authorId);
    if (gatePass && addressed) {
      // The mention-er always gets a deterministic signal, independent of
      // what the subconscious later decides (grant-gated; decline
      // precedent). Gate-suppressed mentions get NO reaction: main would
      // not have signaled either, and reacting would leak the resident's
      // standing mute to its subject.
      void this.acknowledgeSuppressed(serverId, channelId, messageId);
    }
    if (gatePass && (addressed || privileged) && this.readerAvailable()) {
      this.scheduleWakeInvocation(serverId, channelId);
    }
  }

  /** Reader forks that reported through `deliver_summary` (so their trailing prose is not a second report). */
  private readerReports = new Set<string>();

  readerReported(reader: string): boolean {
    return this.readerReports.has(reader);
  }

  forgetReader(reader: string): void {
    this.readerReports.delete(reader);
  }

  private async acknowledgeSuppressed(serverId: string, channelId: string, messageId: string): Promise<void> {
    try {
      const server = this.serverRegistry.getServer(serverId);
      if (!server || !CapabilityGrant.of(server).has('channels.acknowledge')) return;
      await server.sendChannelsAcknowledge({
        channelId,
        messageId,
        intent: 'suppressed-tuned-out',
      });
    } catch (err) {
      console.error(`[tune-out] acknowledging ${messageId} in ${channelId} on ${serverId} failed:`, err);
      this.hooks.emitTrace({
        type: 'tune-out:ack-failed',
        serverId,
        channelId,
        error: thrownReason(err),
      });
    }
  }

  // ==========================================================================
  // Subconscious invocation (cadence + coalesced wakes)
  // ==========================================================================

  private startCadence(serverId: string, channelId: string, cadenceSeconds: number): void {
    this.stopCadence(serverId, channelId);
    const key = this.key(serverId, channelId);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      try {
        const state = this.channelRegistry.getTuneOutState(serverId, channelId);
        if (!state) return; // cancelled meanwhile
        // The next period is armed before this one's turn, so a turn that
        // fails can't end the cadence.
        armAfter(cadenceSeconds * 1000, hold, tick);
        const diverted = this.divertedSinceInvocation.get(key) ?? 0;
        // An empty period needs no turn at all — skip silently.
        if (diverted > 0) {
          this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
        }
      } catch (err) {
        this.timerFailed('cadence', serverId, channelId, err);
      }
    };
    armAfter(cadenceSeconds * 1000, hold, tick);
  }

  /** Clear a channel's tune-out timers: its cadence, its end time and a wake
   *  still coalescing. */
  private clearTimers(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    this.stopCadence(serverId, channelId);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
    const pending = this.pendingWakes.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pendingWakes.delete(key);
  }

  private stopCadence(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const timer = this.cadenceTimers.get(key);
    if (timer) clearTimeout(timer);
    this.cadenceTimers.delete(key);
  }

  private scheduleWakeInvocation(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const pending = this.pendingWakes.get(key);
    if (pending) {
      pending.count++;
      return;
    }
    const timer = setTimeout(() => {
      try {
        const entry = this.pendingWakes.get(key);
        this.pendingWakes.delete(key);
        this.fireWake(serverId, channelId, entry?.count ?? 1);
      } catch (err) {
        this.timerFailed('wake', serverId, channelId, err);
      }
    }, WAKE_COALESCE_MS);
    this.pendingWakes.set(key, { count: 1, timer });
  }

  /** One coalesced wake: counted durably against the epoch that holds the channel. */
  private fireWake(serverId: string, channelId: string, count: number): void {
    if (this.channelRegistry.getTuneOutState(serverId, channelId)) {
      // Count ONE durable wake per coalesced invocation.
      const counted = this.channelRegistry.recordTuneOutWake(serverId, channelId);
      if (!counted) return; // cancelled inside the window
      if (counted.wakeCount > counted.params.maxWakes) {
        this.cancel(
          serverId,
          channelId,
          'tune-out-max-wakes',
          `wake budget exhausted (${counted.params.maxWakes})`,
        );
        return;
      }
      this.invokeSubconscious(serverId, channelId, 'wake', count);
      return;
    }
    const scope = this.getAllExcept();
    if (!scope) return; // released inside the window
    // The all-except scope: exhausting the budget pauses the reader, it does
    // not end the hold (#232 §3.2 — the hold is the resident's bounded
    // commitment; the deadline ends it).
    const wakeCount = scope.wakeCount + 1;
    this.writeScope({ ...scope, wakeCount });
    if (wakeCount > scope.params.maxWakes) {
      this.hooks.emitTrace({
        type: 'tune-out:wake-budget-paused', epochId: scope.params.epochId, scope: 'all-except',
        serverId, channelId, wakeCount, maxWakes: scope.params.maxWakes,
      });
      return;
    }
    this.invokeSubconscious(serverId, channelId, 'wake', count);
  }

  /**
   * One subconscious turn: a system-framed trigger notice (bracket style —
   * what happened, never what to say) plus standing dispositions, then an
   * inference request. Its view supplies the actual traffic: the merged
   * record while its window is the record, and with the presentation index
   * (#291) what its window holds, which takes what it hasn't been shown at
   * the turn's start, the notice included.
   */
  private invokeSubconscious(
    serverId: string,
    channelId: string,
    trigger: 'cadence' | 'wake',
    count: number,
  ): void {
    const subName = this.hooks.subconsciousName();
    if (!subName && !this.forkReader) return;
    const key = this.key(serverId, channelId);

    const shown = this.shown(serverId, channelId);
    const notice = trigger === 'wake'
      ? `[Tune-out wake: ${shown} — ${count} addressed message${count === 1 ? '' : 's'}]`
      : `[Tune-out cadence: ${shown} — ${count} diverted message${count === 1 ? '' : 's'} since your last look]`;
    if (!subName) {
      const hold = this.holdFor(serverId, channelId);
      if (!hold) return;
      const ofChannel = inChannelOf(serverId, channelId);
      const inChannel = (m: Pick<StoredMessage, 'metadata'>): boolean =>
        (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === hold.epochId && ofChannel(m);
      // A held message is stored as it arrives, the resident's turn alive or
      // not, and what arrives while the resident is busy is the traffic a
      // reader is there for.
      this.invokeReaderFork(
        serverId,
        channelId,
        hold.epochId,
        trigger,
        notice,
        this.hooks.getStoredMessages().filter(inChannel),
      );
      // The count restarts once the fork has been handed what was held, as it
      // does below once the subconscious's turn has been asked for. Otherwise
      // every later cadence period still sees this one's count and derives a
      // fork with nothing new to read.
      this.divertedSinceInvocation.set(key, 0);
      return;
    }
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: notice }],
      { system: true, kind: `tune-out-${trigger}`, channelId },
      subName,
    );
    this.hooks.requestInference(subName, `tune-out ${trigger}: ${shown}`, 'tune-out');
    // Counted from here only once the turn has been asked for, so a turn that
    // throws leaves its messages for the next period's turn.
    this.divertedSinceInvocation.set(key, 0);
  }

  /**
   * `reader: 'forks'`: hand the framework one invocation. The backlog is
   * the epoch's held messages not yet handed to any fork — each is
   * delivered to exactly one reader — plus the standing dispositions. A
   * cadence look with nothing new is skipped. True when a fork was asked for.
   */
  private invokeReaderFork(
    serverId: string,
    channelId: string,
    epochId: string,
    trigger: ReaderInvocation['trigger'],
    notice: string,
    epochBacklog: StoredMessage[],
  ): boolean {
    if (!this.hooks.invokeReader) return false;
    const key = this.key(serverId, channelId);
    const backlog = this.unhandedBacklog(key, epochBacklog);
    if (trigger === 'cadence' && backlog.length === 0) return false;
    // The cursor only moves forward: a returned row handed again can be
    // behind it.
    const cursor = Math.max(this.readerCursor.get(key) ?? -1, ...backlog.map((m) => m.sequence));
    if (backlog.length > 0) this.readerCursor.set(key, cursor);
    const returned = this.readerReturned.get(key);
    if (returned) {
      for (const m of backlog) returned.delete(m.id);
      if (returned.size === 0) this.readerReturned.delete(key);
    }
    const entries = Object.entries(this.readDispositions());
    this.hooks.invokeReader({
      serverId,
      channelId,
      epochId,
      trigger,
      notice,
      backlog,
      dispositions: entries.length > 0 ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : null,
    });
    return true;
  }

  /**
   * What no reader fork has read yet, of the given held messages, oldest
   * first: those past the channel's cursor, plus those a failed fork
   * returned.
   */
  private unhandedBacklog(key: string, stored: StoredMessage[]): StoredMessage[] {
    const cursor = this.readerCursor.get(key) ?? -1;
    const returned = this.readerReturned.get(key);
    return stored
      .filter((m) => returned?.has(m.id) || m.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * A reader fork that never read what it was handed: its derive failed, or
   * its run threw before it reported. While the epoch that held the
   * messages still holds the channel, they go back to its backlog, and the
   * next invocation for the channel is handed them. Returns how many went
   * back (0 once the epoch has ended: its cancel had its own last fork).
   */
  readerFailed(invocation: Pick<ReaderInvocation, 'serverId' | 'channelId' | 'epochId' | 'backlog'>): number {
    const { serverId, channelId, epochId } = invocation;
    if (this.holdFor(serverId, channelId)?.epochId !== epochId) return 0;
    const key = this.key(serverId, channelId);
    const returned = this.readerReturned.get(key) ?? new Set<string>();
    for (const m of invocation.backlog) returned.add(m.id);
    const count = invocation.backlog.length;
    if (count > 0) this.readerReturned.set(key, returned);
    return count;
  }

  // ==========================================================================
  // Dispositions (standing notes, snapshot slot)
  // ==========================================================================

  private dispositionsCache: Record<string, string> | null = null;

  private get dispositionsStateId(): string {
    return `subconscious/${this.hooks.primaryName() ?? 'default'}/dispositions`;
  }

  /**
   * The dispositions as a fixed system-position ContextInjection for the
   * subconscious's compiles (antra: deliver changes, never let them wash
   * away — it has no long-term memory, so they must not live in window
   * content). Bytes change only when a disposition changes: KV-friendly.
   * A failed read of the stored map throws, so the compile stops rather than
   * run without them.
   */
  getDispositionsInjection(): {
    namespace: string;
    position: 'system';
    content: Array<{ type: 'text'; text: string }>;
  } | null {
    const dispositions = this.readDispositions();
    const entries = Object.entries(dispositions);
    if (entries.length === 0) return null;
    return {
      namespace: 'dispositions',
      position: 'system',
      content: [{
        type: 'text',
        text: `[Standing dispositions]\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
      }],
    };
  }

  private readDispositions(): Record<string, string> {
    if (this.dispositionsCache) return this.dispositionsCache;
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.dispositionsStateId);
    } catch (error) {
      // A failed read is not an empty map, and nothing is cached, so the next
      // read asks the store again. Taken as empty, it would compile the
      // subconscious without its dispositions until a restart, and the next
      // noteDisposition would write that empty map over the stored one.
      throw new Error(`the stored dispositions (${this.dispositionsStateId}) could not be read: ${thrownReason(error)}`, { cause: error });
    }
    this.dispositionsCache = (raw && typeof raw === 'object') ? raw as Record<string, string> : {};
    return this.dispositionsCache;
  }

  noteDisposition(key: string, text: string): void {
    const dispositions = { ...this.readDispositions() };
    if (text === '') {
      delete dispositions[key];
    } else {
      dispositions[key] = text;
    }
    // Stored before it's cached: a write that fails leaves the cache and the
    // store as they were, so the note is in effect nowhere.
    try {
      this.channelRegistry.writeCoordinatorState(this.dispositionsStateId, dispositions);
    } catch (error) {
      throw new Error(`the dispositions (${this.dispositionsStateId}) could not be stored: ${thrownReason(error)}`, { cause: error });
    }
    this.dispositionsCache = dispositions;
  }

  // ==========================================================================
  // Subconscious tool dispatch
  // ==========================================================================

  async handleSubconsciousTool(
    name: string,
    input: Record<string, unknown>,
    /** The calling turn's own channels, for a call made inside it (the framework's callOwnChannels). */
    own: readonly ChannelRef[] = [],
    /** The calling agent: the persistent subconscious, or a reader fork. */
    caller?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string; isError?: boolean }> {
    switch (name) {
      case 'deliver_summary': {
        const text = String(input.text ?? '').trim();
        const channelId = String(input.channelId ?? '');
        if (!text) {
          return {
            success: false,
            error: 'Nothing was delivered: deliver_summary needs the summary in "text". If there\'s nothing to '
              + "report, don't call it: staying silent is allowed.",
            isError: true,
          };
        }
        const subName = this.hooks.subconsciousName();
        // Verbatim, under its own participant name, into the resident's window
        // (or, from a reader fork, as its attributed mail), tagged with the
        // channel the name means and its server, since the framework reads a
        // conversational row's channel (repinChannel). The name means what it
        // means to every channel tool: inside the calling turn, the id of one
        // of the turn's own channels means that channel, refused where its
        // server no longer registers it or the turn has channels with that id
        // on two servers (ownChannelFor); otherwise a name several registered
        // channels answer to is refused with them (sharedNameRefusalFor). So
        // no row is left for a re-pin to read as another server's channel. A
        // name no registered channel answers to is kept as given, with no
        // server, which a re-pin reads by name when it weighs the row, as it
        // reads any message without its server.
        if (!subName && !(caller && this.hooks.deliverFromReader)) {
          return { success: false, error: 'subconscious not configured', isError: true };
        }
        const mine = this.channelRegistry.ownChannelFor(channelId, own, 'deliver');
        if (mine && 'error' in mine) return { success: false, error: mine.error, isError: true };
        const shared = mine ? undefined : this.channelRegistry.sharedNameRefusalFor(channelId, 'nothing was delivered');
        if (shared) return { success: false, error: shared, isError: true };
        const [named] = mine ? [mine.channel] : this.channelRegistry.channelsNamed(channelId);
        const metadata = {
          kind: 'subconscious-summary',
          ...(named ? { channelId: named.channelId, serverId: named.serverId } : { channelId }),
        };
        if (subName) {
          this.hooks.addMessage(subName, [{ type: 'text', text }], metadata);
          return { success: true, data: { delivered: true } };
        }
        // A reader fork's report: attributed mail under its own name. The fork
        // counts as having reported only once the mail is held: a delivery
        // that throws is an error result to the fork, and its prose is then
        // still delivered as its report when it ends (#546, probe R14).
        this.hooks.deliverFromReader!(caller!, [{ type: 'text', text }], metadata);
        this.readerReports.add(caller!);
        return { success: true, data: { delivered: true } };
      }
      case 'cancel_tuneout': {
        const name = String(input.channelId ?? '');
        const serverId = typeof input.serverId === 'string' && input.serverId ? input.serverId : undefined;
        // The name means what it means to every channel tool, the
        // resident's tune_out included: with a serverId, that server's
        // channel with the id; inside the calling turn, the id of one of the
        // turn's own channels means that channel (ownChannelFor); otherwise a
        // name several registered channels answer to picks none of them
        // (channelsNamed), whichever of them is tuned out, never taken to be
        // the tuned-out one. A name that picks no channel, such a name or one
        // of the turn's own channels that ownChannelFor refuses, is refused,
        // unless the call names the all-except scope, which ends that hold
        // below.
        const mine = serverId ? undefined : this.channelRegistry.ownChannelFor(name, own);
        const refusal = mine && 'error' in mine ? mine.error
          : serverId || mine ? undefined : this.channelRegistry.sharedNameRefusalFor(name);
        const named = serverId ? [{ serverId, channelId: name }]
          : mine && 'channel' in mine ? [mine.channel] : this.channelRegistry.channelsNamed(name);
        const channel = refusal ? undefined : named[0];
        const note = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined;
        if (!channel || !this.channelRegistry.getTuneOutState(channel.serverId, channel.channelId)) {
          // The reader keeps its latitude over the all-except hold too: a
          // channel it holds (or the scope named outright) ends the scope.
          const scope = this.getAllExcept();
          const heldByScope = scope && (input.scope === 'all-except' || name === 'all-except'
            || (channel !== undefined && this.holdFor(channel.serverId, channel.channelId)?.epochId === scope.params.epochId));
          if (!heldByScope) return { success: false, error: refusal ?? this.notTunedOut(name, 'the resident'), isError: true };
          const result = this.cancelAllExcept('subconscious', 'subconscious judgment', note, caller);
          return result.ok
            ? { success: true, data: { cancelled: true, scope: 'all-except' } }
            : { success: false, error: result.error, isError: false };
        }
        const result = this.cancel(channel.serverId, channel.channelId, 'subconscious', 'subconscious judgment', note, caller);
        return result.ok
          ? { success: true, data: { cancelled: true } }
          : { success: false, error: result.error, isError: true };
      }
      case 'note_disposition': {
        const key = String(input.key ?? '').trim();
        if (!key) {
          return {
            success: false,
            error: 'Nothing was recorded: note_disposition needs a "key", a short stable name for the note, such as '
              + '"busy-channels". To delete a note, call it with that note\'s key and an empty "text".',
            isError: true,
          };
        }
        try {
          this.noteDisposition(key, String(input.text ?? ''));
        } catch (error) {
          // For the subconscious first: what became of its note, and that a
          // later call may land. The store's own reason follows, for an operator.
          // The note may set, change or remove a disposition, so what stays in
          // effect is whatever was there before, if anything.
          return {
            success: false,
            isError: true,
            error: `The change to the disposition ${JSON.stringify(key)} wasn't recorded, so the dispositions stay as they were. ` +
              `Noting it again may work once the store can be read and written. The store's error: ${thrownReason(error)}`,
          };
        }
        return { success: true, data: { noted: key } };
      }
      case 'speak_in_channel': {
        if (!this.hooks.allowChannelSpeech()) {
          // The setting's name is the host's, for its log; the subconscious
          // reads what it can do instead.
          console.warn('[tune-out] speak_in_channel refused: FrameworkConfig.subconscious.allowChannelSpeech is off');
          return {
            success: false,
            isError: true,
            error: "Nothing was posted: speak_in_channel is turned off for you in the resident's configuration, and "
              + "calling it again won't change that. The resident can speak there: tell it what's needed with "
              + 'deliver_summary, or, if the channel is tuned out and needs the resident now, end the tune-out with '
              + 'cancel_tuneout.',
          };
        }
        const channelId = String(input.channelId ?? '');
        const text = String(input.text ?? '').trim();
        if (!text) {
          return { success: false, error: 'Nothing was posted: speak_in_channel needs the message in "text".', isError: true };
        }
        // Inside the calling turn, the id of one of the turn's own channels
        // means that channel, as for every channel tool (ownChannelFor).
        const mine = this.channelRegistry.ownChannelFor(channelId, own, 'publish');
        if (mine && 'error' in mine) return { success: false, error: mine.error, isError: true };
        return this.channelRegistry.publishForAgent(mine ? mine.channel : channelId, text, this.hooks.subconsciousName() ?? caller ?? 'Subconscious');
      }
      default:
        return { success: false, error: `unknown subconscious tool: ${name}`, isError: true };
    }
  }

  /**
   * A cancel of a channel that isn't tuned out, by the name the caller gave
   * or knows it by: which channels are, so the next call can name one, and
   * how a tune-out ends without one. `backlogTo`
   * names the resident as the message's reader knows it: "you" to the
   * resident, "the resident" to the subconscious. It speaks of connected
   * channels because listActive reads the registered ones: removing a server
   * drops its channels and keeps their tune-outs, so a tune-out there is in
   * neither this list nor the name's lookup (channelsNamed, which reads the
   * registered channels too), and the text claims nothing about it.
   */
  private notTunedOut(name: string, backlogTo: 'you' | 'the resident'): string {
    const active = this.listActive().map((e) => JSON.stringify(this.shown(e.serverId, e.channelId)));
    const opening = active.length === 0
      ? 'no connected channel is tuned out now.'
      : `no connected channel ${JSON.stringify(name)} is tuned out. Connected channels tuned out now: `
        + `${active.join(', ')}.`;
    return `Nothing was cancelled: ${opening} A tune-out also ends by itself when its duration runs out, or at the `
      + `first wake past its wake budget, and its backlog goes to ${backlogTo} then.`;
  }

  /** Stop all timers (framework shutdown). */
  stop(): void {
    for (const timer of this.cadenceTimers.values()) clearTimeout(timer);
    this.cadenceTimers.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const { timer } of this.pendingWakes.values()) clearTimeout(timer);
    this.pendingWakes.clear();
  }
}
