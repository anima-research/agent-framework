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

import { NOTICE_TAG } from '../notice-tags.js';
import { cutToFit, quotedValue, suppliedValue } from '../supplied-text.js';
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
 * A name the line adds is a value someone supplied, kept to one line with
 * its notice openings marked (authorLine), as main's dump writes it.
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
  /** Held messages not yet handed to any reader fork, oldest first. */
  backlog: StoredMessage[];
  /**
   * Held messages not yet handed to any reader fork that are still queued
   * behind the resident's turn (admitted, not yet stored), oldest first.
   * They come after `backlog` in arrival order. A reader is most useful
   * while the resident is busy, which is exactly when its traffic is here
   * rather than in the store.
   */
  queued: QueuedHeldMessage[];
  /** Standing dispositions, as text, or null when there are none. */
  dispositions: string | null;
}

/**
 * A held message admitted for the resident but not yet in its store: it was
 * deferred while a turn was alive. `writeId` is the deferred write's durable
 * id, which the stored row carries as `metadata.deferredWriteId` once it
 * lands.
 */
export type QueuedHeldMessage = Pick<StoredMessage, 'participant' | 'content' | 'metadata'> & {
  writeId: string;
  /** When the framework first held the write, in ms since the epoch. */
  heldAt?: number;
};

/** The deferred write a stored row landed from, when it came through the queue. */
function writeIdOf(m: Pick<StoredMessage, 'metadata'>): string | undefined {
  const writeId = (m.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId;
  return typeof writeId === 'string' ? writeId : undefined;
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
const CUT_MARK = ` [${NOTICE_TAG.cutToFit}; the whole message is in the channel's history]`;

/**
 * tune_out's refusal of a channel already tuned out: its settings, then what
 * its transport is now where the repeat tried to open it again (`transport`,
 * from the framework's dispatch), then how to change the settings.
 */
export function alreadyTunedOutText(quoted: string, p: TuneOutParams, transport?: string): string {
  // A duration so long its end is past what a Date can hold has no time to show.
  const expires = p.expiresAtMs !== undefined ? new Date(p.expiresAtMs) : undefined;
  const until = expires && Number.isFinite(expires.getTime())
    ? `, until ${expires.toISOString().replace(/\.\d+Z$/, 'Z')}`
    : '';
  // A thrown error's words may end without a stop.
  const now = transport === undefined ? '' : /[.!?]$/.test(transport) ? `${transport} ` : `${transport}. `;
  return `Nothing changed${transport !== undefined ? ' in the tune-out' : ''}: ${quoted} is already `
    + `tuned out, with cadenceSeconds ${p.cadenceSeconds}, backlogCap ${p.backlogCap} and maxWakes ${p.maxWakes}${until}. `
    + now
    + 'To change those, cancel it first with tune_out mode "cancel", which delivers its backlog to you now, then call '
    + 'tune_out again with the new settings.';
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
  /** Read the primary's stored messages (shared slot, unfiltered). */
  getStoredMessages: () => StoredMessage[];
  /**
   * Messages admitted for the primary but not yet in its store (deferred
   * while a turn was alive), oldest first. A cancel reads them too, so a
   * message held mid-turn is in the backlog it belongs to (#232 gap 7).
   */
  getDeferredMessages?: () => Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'> & { writeId?: string; heldAt?: number }>;
  /**
   * Make what was just delivered durable, including anything the delivery
   * left in the deferred queue: a release flips durable epoch state, so its
   * dump must survive a crash in the same window (#232 gap 6).
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
  /** Move the subconscious window anchor (never forward past active epochs). */
  setSubconsciousAnchor: (sequence: number) => void;
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
  /**
   * Held messages the channel's reader hasn't looked at, per channel key:
   * what makes a cadence period worth a look. Counted up as messages are
   * held and back to zero at each look; rebuilt from the held rows where
   * memory can't know it (rebuildTally): after a restart, and when a
   * channel's own tune-out ends while the all-except hold still holds it.
   * A failed reader fork's messages count again (readerFailed).
   */
  private divertedSinceInvocation = new Map<string, number>();
  /**
   * The persistent subconscious's last look at each held channel, per epoch:
   * the store's sequence when the look was asked for. Durable, so that after
   * a restart its next look counts only what was held since (rebuildTally).
   * Reader forks need none: what they were handed is in memory, and after a
   * restart the first fork of an epoch is handed all it has held.
   */
  private lastLooksCache: Record<string, Record<string, number>> | undefined;
  /**
   * `reader: 'forks'`: the highest sequence of a held message already
   * handed to a reader fork, per epoch and channel (handOffKey). Each held
   * message is delivered to exactly one fork. A channel the all-except hold
   * holds can be taken by a tune-out of its own and given back, and each
   * epoch's readers read that epoch's messages, so what one epoch's readers
   * were handed never moves or clears the other's. In-memory: after a
   * restart the first fork of an epoch is handed everything the epoch has
   * held, which is the right side to err on.
   */
  private readerCursor = new Map<string, number>();
  /**
   * `reader: 'forks'`: the deferred writes handed to a reader fork while
   * still queued, per epoch and channel. Each lands in the store later as a row
   * stamped with the same id (`metadata.deferredWriteId`), past the cursor;
   * that row is not handed again. Cleared with the cursor.
   */
  private readerHandedWrites = new Map<string, Set<string>>();
  /**
   * `reader: 'forks'`: held messages a reader fork was handed but never read,
   * per epoch and channel: its derive failed, or its run threw before it reported
   * (readerFailed). The next invocation is handed them again, cursor or no:
   * stored rows by id, and by write id those that were queued when handed
   * (stored or still queued now). Cleared with the cursor.
   */
  private readerReturned = new Map<string, { ids: Set<string>; writeIds: Set<string> }>();
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

  /** The readers' hand-off bookkeeping's key: one epoch's reading of one channel. */
  private handOffKey(epochId: string, serverId: string, channelId: string): string {
    return `${epochId}\0${serverId}\0${channelId}`;
  }

  /** An ended epoch's hand-off bookkeeping goes with it, every channel's. */
  private dropHandOffs(epochId: string): void {
    for (const map of [this.readerCursor, this.readerHandedWrites, this.readerReturned]) {
      for (const key of map.keys()) if (key.startsWith(`${epochId}\0`)) map.delete(key);
    }
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

  private quotedShown(serverId: string, channelId: string): string {
    return this.channelRegistry.quotedShown({ serverId, channelId });
  }

  /** Restart cadence + expiry timers and re-anchor after a process restart. */
  resumeActiveEpochs(): void {
    let oldestAnchor: number | null = null;
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
      if (oldestAnchor === null || params.startedAtSequence < oldestAnchor) {
        oldestAnchor = params.startedAtSequence;
      }
    }
    const scope = this.getAllExcept();
    if (scope) {
      if (scope.params.expiresAtMs <= Date.now()) {
        this.cancelAllExcept('duration', 'duration elapsed');
      } else {
        this.armScopeTimers(scope.params);
        if (oldestAnchor === null || scope.params.startedAtSequence < oldestAnchor) {
          oldestAnchor = scope.params.startedAtSequence;
        }
      }
    }
    if (oldestAnchor !== null) {
      this.hooks.setSubconsciousAnchor(oldestAnchor);
    }
    // What each held channel's reader hasn't looked at was counted in
    // memory, so it is counted again from the held rows: without it, a
    // channel held across the restart gets no cadence look until something
    // new arrives.
    const held = new Set<string>();
    for (const m of this.hooks.getStoredMessages()) {
      const meta = m.metadata as { tuneOut?: { epochId?: string }; serverId?: string; channelId?: string } | undefined;
      const epochId = meta?.tuneOut?.epochId;
      if (!meta || !epochId || !meta.channelId) continue;
      const key = this.key(meta.serverId ?? '', meta.channelId);
      if (!held.has(key) && this.holdFor(meta.serverId ?? '', meta.channelId)?.epochId === epochId) held.add(key);
    }
    for (const key of held) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      this.rebuildTally(serverId, channelId);
    }
    this.pruneLooks();
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
        error: `Nothing changed: a conversation is bound to ${this.quotedShown(serverId, channelId)}, so its messages go to that `
          + "conversation, and tune_out won't divert a channel while one is. Calling tune_out on it again won't change "
          + 'that until the conversation ends, which happens only once the channel has been quiet for a while. Tune '
          + 'out a different channel, or ask whoever runs this host if this one should be diverted.',
      };
    }
    const current = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (current) return { ok: false, error: alreadyTunedOutText(this.quotedShown(serverId, channelId), current.params), alreadyTunedOut: true };
    const scope = this.getAllExcept();
    if (scope && scope.params.except.serverId === serverId && scope.params.except.channelId === channelId) {
      return { ok: false, error: `channel ${this.quotedShown(serverId, channelId)} is the excepted channel of the active all-except hold; cancel that first` };
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
    const oldest = this.listActive().reduce(
      (min, e) => Math.min(min, e.params.startedAtSequence),
      params.startedAtSequence,
    );
    this.hooks.setSubconsciousAnchor(oldest);

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
      return { ok: false, error: this.notTunedOut(this.quotedShown(serverId, channelId), 'you') };
    }
    this.clearTimers(serverId, channelId);
    this.divertedSinceInvocation.delete(this.key(serverId, channelId));

    // Backlog: every message held under this epoch. The stored ones come in
    // store order, then those still in the deferred queue (held mid-turn,
    // not yet written), oldest first. That's arrival order, except when a
    // held message stays queued while a later one is stored: a store write
    // refused at a turn-start flush leaves it queued, and that turn's
    // assembly can then store later coalesced messages directly.
    const epochId = ended.params.epochId;
    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const held = (this.hooks.getDeferredMessages?.() ?? []).filter(ofEpoch);
    const backlog: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> = [
      ...this.hooks.getStoredMessages().filter(ofEpoch),
      ...held,
    ];
    // Whole messages: a cap below one shows none, where slice(-0.5) would
    // start at 0 and take them all.
    const cap = Math.floor(ended.params.backlogCap);
    const authorOf = (m: Pick<StoredMessage, 'participant' | 'metadata'>): string =>
      suppliedValue((m.metadata as { author?: { name?: string } } | undefined)?.author?.name ?? m.participant);
    // A line names its author as the resident knows them and marks what a
    // text line can't carry (`[image]`), so the dump says what it leaves out.
    const lineOf = renderHeldLine;
    // The tool the truncation note names (#232 gap 11): the one the resident
    // has, when the host says; main's `fetch_history` where no host says.
    const historyTool = this.hooks.historyTool ? this.hooks.historyTool() : 'fetch_history';
    // The channel as the resident and the subconscious are shown it.
    const name = this.shown(serverId, channelId);
    const lifecycle = `[${NOTICE_TAG.tuneOut}: ${name} cancelled — ${reason}, ${ended.wakeCount} wake${ended.wakeCount === 1 ? '' : 's'}]`;
    const render = (lines: string[], truncated: number): string => {
      const attrs = [
        `channel=${this.quotedShown(serverId, channelId)}`,
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
    let newestCut = false;
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
      const head = cutToFit(lines.at(-1) ?? '', room - frameShowing(1) - CUT_MARK.length);
      if (kept === 0 && head !== '') {
        lines = [head + CUT_MARK];
        shown = shown.slice(-1);
        newestCut = true;
      } else {
        lines = lines.slice(lines.length - kept);
        shown = shown.slice(shown.length - kept);
      }
    }
    const truncated = backlog.length - shown.length;
    // The held messages the dump leaves out, the oldest of them. The
    // subconscious's report covers what the dump leaves out, but its view
    // holds stored rows only, so these go to it with its notice below. So does
    // a held message the dump shows but can't give whole: one whose image or
    // audio its text lines drop, or the newest, cut to fit.
    const heldLeftOut = held.slice(0, Math.max(0, held.length - shown.length));
    const heldForReport = [
      ...heldLeftOut,
      ...held.slice(heldLeftOut.length).filter((m) =>
        m.content.some((b) => b.type !== 'text') || (newestCut && m === shown[0])),
    ];

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
    // messages out, its summary is what covers them. The held messages the
    // dump can't give the resident whole follow the notice, each a row of its
    // own with its own content, as its view can't have them until they're
    // stored. A cancel the subconscious makes itself gets the notice and the
    // turn when some do, since it wrote its note before it could see them,
    // and when it wrote no note and the dump left any message out, since
    // nothing else then covers it. Otherwise its note speaks for what it saw.
    const selfCancel = source === 'subconscious';
    if (subName && (!selfCancel || heldForReport.length > 0 || (!subconsciousNote && truncated > 0))) {
      const truncNote = truncated > 0
        ? ` ${truncated} of ${backlog.length} diverted messages, the oldest, weren't delivered raw to the resident.`
        : '';
      const heldNote = heldForReport.length > 0
        ? ` Still held at the cancel, so your view may not have them yet: the ${heldForReport.length} message${heldForReport.length === 1 ? '' : 's'} after this one.`
        : '';
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: `[${NOTICE_TAG.tuneOutCancelled}: ${this.shown(serverId, channelId)} — ${reason}.${truncNote}${heldNote}]` }],
        { system: true, kind: 'tune-out-cancel-report', channelId },
        subName,
      );
      // Each held message is a row of its own, so a per-message cap cuts each
      // one on its own, its author's label included, not the batch's newest.
      for (const m of heldForReport) {
        this.hooks.addMessage(
          'user',
          [{ type: 'text', text: `${authorOf(m)}:` }, ...m.content],
          { system: true, kind: 'tune-out-cancel-held', channelId },
          subName,
        );
      }
      this.hooks.requestInference(subName, `tune-out cancelled: ${name}`, 'tune-out');
    } else if (!subName && this.forkReader) {
      // Forks are the reader: one last fork for the epoch, handed what no
      // fork has been handed yet, stored or still queued behind the
      // resident's turn, plus the cancel notice; its report follows the dump.
      // Once the epoch ends, a message still queued lands in the store
      // view-filtered, where nothing else reads it, so it goes to this fork
      // now. On a reader's own cancel, the reader has read what it was
      // handed, so a fork follows only when messages arrived after that.
      const stored = this.hooks.getStoredMessages().filter(ofEpoch);
      const queued = this.queuedHeld(ofEpoch);
      const rest = this.unhandedBacklog(this.handOffKey(epochId, serverId, channelId), stored, queued);
      const unread = rest.backlog.length + rest.queued.length;
      if (!selfCancel || unread > 0) {
        const truncNote = truncated > 0
          ? ` ${truncated} of ${backlog.length} diverted messages, the oldest, weren't delivered raw to the resident.`
          : '';
        const lateNote = selfCancel
          ? ` ${unread === 1 ? 'This message' : `These ${unread} messages`} arrived after the reader that cancelled was handed its own.`
          : '';
        this.invokeReaderFork(serverId, channelId, epochId, 'cancel', `[${NOTICE_TAG.tuneOutCancelled}: ${name} — ${reason}.${truncNote}${lateNote}]`, stored, queued);
      }
    }
    this.dropHandOffs(epochId);
    this.dropLooks(epochId);
    // Where the all-except hold still holds the channel, its own messages
    // there that its reader hasn't looked at are counted again, as the
    // channel's own tune-out's count stood in for theirs.
    this.rebuildTally(serverId, channelId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId, channelId, epochId, reason, wakeCount: ended.wakeCount });
    return { ok: true };
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
    // A record that can't be read, or isn't a hold's, is not taken for no
    // hold: the error goes to the caller and nothing is cached, so the next
    // read tries again. At create() that refuses the start, as an
    // unreadable registry does.
    const raw = this.channelRegistry.readCoordinatorState(this.scopeStateId) as AllExceptState | null;
    if (raw !== null && raw !== undefined && !(typeof raw === 'object' && raw.params && typeof raw.params.epochId === 'string')) {
      throw new Error(`the all-except hold's stored record (${this.scopeStateId}) is not a hold's record; it was left as it is`);
    }
    this.scopeCache = raw ?? null;
    return this.scopeCache;
  }

  private writeScope(state: AllExceptState | null): void {
    // Durable first: a write that fails leaves memory as the store has it.
    this.channelRegistry.writeCoordinatorState(this.scopeStateId, state);
    this.scopeCache = state;
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
      // Whole messages, as a channel's cap is counted: a cap below one shows
      // none, where slice(-0.5) would take them all.
      backlogCap: Math.max(0, Math.floor(given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap)),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      startedAtMs: read.now,
      expiresAtMs,
      source,
    };
    this.writeScope({ params, wakeCount: 0 });
    const oldest = this.listActive().reduce((min, e) => Math.min(min, e.params.startedAtSequence), params.startedAtSequence);
    this.hooks.setSubconsciousAnchor(oldest);
    this.armScopeTimers(params);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId: except.serverId, channelId: except.channelId, epochId: params.epochId,
      scope: 'all-except', reader: this.readerAvailable(), expiresAtMs: params.expiresAtMs,
    });
    const minutes = Math.max(1, Math.round((params.expiresAtMs - params.startedAtMs) / 60_000));
    const until = new Date(params.expiresAtMs).toISOString().slice(11, 16);
    this.announce(except, params.epochId, 'entered',
      `[${NOTICE_TAG.focus}: ${this.hooks.primaryName() ?? 'the resident'} is here for ${minutes} min, until ${until} UTC; other channels are held meanwhile.]`);
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
    // As a channel's timers: the next turn is armed before this one's work,
    // and a throw is reported (timerFailed) rather than left to end the host.
    const { serverId: exceptServer, channelId: exceptChannel } = params.except;
    const holdExpiry = (timer: ReturnType<typeof setTimeout>): void => { this.expiryTimers.set(key, timer); };
    const end = (): void => {
      try {
        holdExpiry(setTimeout(end, EXPIRY_RETRY_MS));
        if (!this.cancelAllExcept('duration', 'duration elapsed').ok) this.clearScopeTimers();
      } catch (err) {
        this.timerFailed('expiry', exceptServer, exceptChannel, err);
      }
    };
    armAt(params.expiresAtMs, holdExpiry, end);
    if (!this.readerAvailable()) return;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      try {
        const scope = this.getAllExcept();
        if (!scope) return;
        armAfter(params.cadenceSeconds * 1000, hold, tick);
        // One look per held channel with new traffic since the last look.
        for (const [channelKey, diverted] of this.divertedSinceInvocation) {
          if (diverted <= 0) continue;
          const [serverId, channelId] = channelKey.split('\0') as [string, string];
          if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue; // a per-channel epoch's own cadence
          this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
        }
      } catch (err) {
        this.timerFailed('cadence', exceptServer, exceptChannel, err);
      }
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
    const all = [...this.hooks.getStoredMessages(), ...(this.hooks.getDeferredMessages?.() ?? [])];
    for (const m of all) {
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
    const { epochId, except, backlogCap } = scope.params;

    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const all = [...this.hooks.getStoredMessages().filter(ofEpoch), ...(this.hooks.getDeferredMessages?.() ?? []).filter(ofEpoch)];
    const byChannel = new Map<string, Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>>();
    for (const m of all) {
      const channelId = (m.metadata as { channelId?: string } | undefined)?.channelId ?? '(unknown channel)';
      byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), m]);
    }
    const historyTool = this.hooks.historyTool?.() ?? null;
    const dumps = [...byChannel.entries()].map(([channelId, backlog]) => {
      // Floored here too: a hold stored before entry floored its cap can hold
      // a fraction.
      const cap = Math.floor(backlogCap);
      const shown = cap > 0 ? backlog.slice(-cap) : [];
      const truncated = backlog.length - shown.length;
      const attrs = [
        `channel=${quotedValue(channelId)}`,
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
      [{ type: 'text', text: `[${NOTICE_TAG.tuneOut}: all channels except ${this.shown(except.serverId, except.channelId)} released — ${reason}, ${scope.wakeCount} wake${scope.wakeCount === 1 ? '' : 's'}]\n\n${summary}${dumps.length > 0 ? '\n\n' + dumps.join('\n\n') : ''}` }],
      { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: except.channelId, epochId },
    );
    this.hooks.commitDeliveries?.();
    // The release is recorded before the hold is: a failure past this point
    // leaves the hold in force with its release already delivered, which a
    // retry repeats, where the other order lost the release outright.
    this.writeScope(null);
    this.clearScopeTimers();
    for (const [key, pending] of this.pendingWakes) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue;
      clearTimeout(pending.timer);
      this.pendingWakes.delete(key);
    }
    const subName = this.hooks.subconsciousName();
    if (note && subName) {
      this.hooks.addMessage(subName, [{ type: 'text', text: note }], { kind: 'subconscious-note', epochId });
    } else if (note && noteAuthor && this.hooks.deliverFromReader) {
      this.hooks.deliverFromReader(noteAuthor, [{ type: 'text', text: note }], { kind: 'subconscious-note', epochId });
    }
    const primary = this.hooks.primaryName();
    if (primary) this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    const notice = `[${NOTICE_TAG.tuneOutCancelled}: all channels except ${this.shown(except.serverId, except.channelId)} — ${reason}.]`;
    if (source !== 'subconscious' && subName) {
      this.hooks.addMessage('user', [{ type: 'text', text: notice }], { system: true, kind: 'tune-out-cancel-report', scope: 'all-except' }, subName);
      this.hooks.requestInference(subName, 'tune-out cancelled: all-except', 'tune-out');
    } else if (!subName && this.forkReader) {
      // One last look per channel with messages no fork was handed, stored or
      // still queued behind the resident's turn. That holds for a reader's
      // own release too: the reader that released read one channel's
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
        const queued = this.queuedHeld(inChannel);
        const rest = this.unhandedBacklog(this.handOffKey(epochId, serverId, channelId), stored, queued);
        if (rest.backlog.length + rest.queued.length > 0) {
          this.invokeReaderFork(serverId, channelId, epochId, 'cancel', notice, stored, queued);
        }
      }
    }
    for (const key of this.divertedSinceInvocation.keys()) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (!this.channelRegistry.getTuneOutState(serverId, channelId)) this.divertedSinceInvocation.delete(key);
    }
    this.dropHandOffs(epochId);
    this.dropLooks(epochId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId: except.serverId, channelId: except.channelId, epochId, scope: 'all-except', reason, wakeCount: scope.wakeCount });
    this.announce(except, epochId, 'released', `[${NOTICE_TAG.focus}: ${primary ?? 'the resident'} released — ${reason}.]`);
    return { ok: true };
  }

  /** What is held right now — per-channel epochs and the scope — without releasing. */
  check(opts: { peek?: { serverId?: string; channelId: string }; peekLimit?: number } = {}): TuneOutCheck {
    const stored = this.hooks.getStoredMessages();
    const deferred = this.hooks.getDeferredMessages?.() ?? [];
    const countOf = (epochId: string) => [...stored, ...deferred].filter(
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
      const lines = [...stored, ...deferred]
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
   * inference request. The merged view supplies the actual traffic.
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
      ? `[${NOTICE_TAG.tuneOutWake}: ${shown} — ${count} addressed message${count === 1 ? '' : 's'}]`
      : `[${NOTICE_TAG.tuneOutCadence}: ${shown} — ${count} diverted message${count === 1 ? '' : 's'} since your last look]`;
    if (!subName) {
      const hold = this.holdFor(serverId, channelId);
      if (!hold) return;
      const ofChannel = inChannelOf(serverId, channelId);
      const inChannel = (m: Pick<StoredMessage, 'metadata'>): boolean =>
        (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === hold.epochId && ofChannel(m);
      // Stored and still-queued alike: while the resident's turn runs, what
      // arrives waits in the deferred queue, and that is the traffic a reader
      // is there for.
      this.invokeReaderFork(
        serverId,
        channelId,
        hold.epochId,
        trigger,
        notice,
        this.hooks.getStoredMessages().filter(inChannel),
        this.queuedHeld(inChannel),
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
    const epochId = this.holdFor(serverId, channelId)?.epochId;
    if (epochId) this.markLook(epochId, serverId, channelId);
  }

  /**
   * Count again, from the held rows, the messages the reader of the epoch
   * holding this channel now hasn't looked at: for reader forks, those no
   * fork was handed; for the persistent subconscious, those held since its
   * last look (lastLooks). Nothing holding the channel leaves no count.
   */
  private rebuildTally(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const hold = this.holdFor(serverId, channelId);
    if (!hold || !this.readerAvailable()) {
      this.divertedSinceInvocation.delete(key);
      return;
    }
    const ofChannel = inChannelOf(serverId, channelId);
    const rows = this.hooks.getStoredMessages().filter((m) =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === hold.epochId && ofChannel(m));
    let count: number;
    if (this.forkReader) {
      count = this.unhandedBacklog(this.handOffKey(hold.epochId, serverId, channelId), rows, []).backlog.length;
    } else {
      const mark = this.lastLooks()[hold.epochId]?.[key];
      count = mark === undefined ? rows.length : rows.filter((m) => m.sequence > mark).length;
    }
    this.divertedSinceInvocation.set(key, count);
  }

  private get lastLooksStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/last-looks`;
  }

  /** The stored last looks; none where they can't be read, so every held row counts. */
  private lastLooks(): Record<string, Record<string, number>> {
    if (this.lastLooksCache !== undefined) return this.lastLooksCache;
    let raw: unknown = null;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.lastLooksStateId);
    } catch (error) {
      console.error(`[tune-out] the subconscious's last looks (${this.lastLooksStateId}) could not be read:`, error);
    }
    const looks: Record<string, Record<string, number>> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [epochId, channels] of Object.entries(raw as Record<string, unknown>)) {
        if (!channels || typeof channels !== 'object' || Array.isArray(channels)) continue;
        const marks = Object.entries(channels as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number');
        if (marks.length > 0) looks[epochId] = Object.fromEntries(marks);
      }
    }
    this.lastLooksCache = looks;
    return looks;
  }

  private writeLooks(looks: Record<string, Record<string, number>>): void {
    this.lastLooksCache = looks;
    try {
      this.channelRegistry.writeCoordinatorState(this.lastLooksStateId, looks);
    } catch (error) {
      // The look itself stands. After a restart, this look's messages would
      // count as unseen at the next one.
      console.error(`[tune-out] the subconscious's last looks (${this.lastLooksStateId}) could not be stored:`, error);
    }
  }

  private markLook(epochId: string, serverId: string, channelId: string): void {
    const looks = this.lastLooks();
    this.writeLooks({ ...looks, [epochId]: { ...looks[epochId], [this.key(serverId, channelId)]: this.hooks.currentSequence() } });
  }

  /** An ended epoch's last looks go with it. */
  private dropLooks(epochId: string): void {
    if (this.hooks.subconsciousName() == null) return;
    const looks = this.lastLooks();
    if (!(epochId in looks)) return;
    const { [epochId]: _ended, ...rest } = looks;
    this.writeLooks(rest);
  }

  /** At boot: the last looks of epochs no longer active go. */
  private pruneLooks(): void {
    if (this.hooks.subconsciousName() == null) return;
    const looks = this.lastLooks();
    const active = new Set(this.listActive().map((e) => e.params.epochId));
    const scope = this.getAllExcept();
    if (scope) active.add(scope.params.epochId);
    const kept = Object.fromEntries(Object.entries(looks).filter(([epochId]) => active.has(epochId)));
    if (Object.keys(kept).length !== Object.keys(looks).length) this.writeLooks(kept);
  }

  /**
   * `reader: 'forks'`: hand the framework one invocation. The backlog is
   * the epoch's held messages not yet handed to any fork — each is
   * delivered to exactly one reader — stored ones first, then those still
   * queued behind the resident's turn, plus the standing dispositions. A
   * cadence look with nothing new is skipped. True when a fork was asked for.
   */
  private invokeReaderFork(
    serverId: string,
    channelId: string,
    epochId: string,
    trigger: ReaderInvocation['trigger'],
    notice: string,
    epochBacklog: StoredMessage[],
    epochQueued: QueuedHeldMessage[] = [],
  ): boolean {
    if (!this.hooks.invokeReader) return false;
    const key = this.handOffKey(epochId, serverId, channelId);
    const { backlog, queued } = this.unhandedBacklog(key, epochBacklog, epochQueued);
    if (trigger === 'cadence' && backlog.length === 0 && queued.length === 0) return false;
    // The cursor only moves forward: a returned row handed again can be
    // behind it.
    const cursor = Math.max(this.readerCursor.get(key) ?? -1, ...backlog.map((m) => m.sequence));
    if (backlog.length > 0) this.readerCursor.set(key, cursor);
    const handed = this.readerHandedWrites.get(key) ?? new Set<string>();
    for (const m of queued) handed.add(m.writeId);
    // A handed write whose row has landed behind the cursor can no longer be
    // handed by sequence, so its id has done its work.
    for (const m of epochBacklog) {
      const writeId = writeIdOf(m);
      if (writeId !== undefined && m.sequence <= cursor) handed.delete(writeId);
    }
    if (handed.size > 0) this.readerHandedWrites.set(key, handed);
    else this.readerHandedWrites.delete(key);
    const returned = this.readerReturned.get(key);
    if (returned) {
      for (const m of backlog) {
        returned.ids.delete(m.id);
        const writeId = writeIdOf(m);
        if (writeId !== undefined) returned.writeIds.delete(writeId);
      }
      for (const m of queued) returned.writeIds.delete(m.writeId);
      if (returned.ids.size === 0 && returned.writeIds.size === 0) this.readerReturned.delete(key);
    }
    const entries = Object.entries(this.readDispositions());
    this.hooks.invokeReader({
      serverId,
      channelId,
      epochId,
      trigger,
      notice,
      backlog,
      queued,
      dispositions: entries.length > 0 ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : null,
    });
    return true;
  }

  /**
   * What no reader fork has read yet, of the given held messages: the stored
   * ones past the epoch's cursor for the channel, less those a fork was handed while they
   * were still queued, plus those a failed fork returned, oldest first; then
   * the queued ones no fork was handed, or a failed fork returned.
   */
  private unhandedBacklog(
    key: string,
    stored: StoredMessage[],
    queued: QueuedHeldMessage[],
  ): { backlog: StoredMessage[]; queued: QueuedHeldMessage[] } {
    const cursor = this.readerCursor.get(key) ?? -1;
    const handed = this.readerHandedWrites.get(key);
    const returned = this.readerReturned.get(key);
    const wasReturned = (id: string | undefined, writeId: string | undefined): boolean =>
      returned !== undefined && ((id !== undefined && returned.ids.has(id)) || (writeId !== undefined && returned.writeIds.has(writeId)));
    const unread = (m: StoredMessage): boolean => {
      const writeId = writeIdOf(m);
      if (wasReturned(m.id, writeId)) return true;
      return m.sequence > cursor && !(handed !== undefined && writeId !== undefined && handed.has(writeId));
    };
    return {
      backlog: stored.filter(unread).sort((a, b) => a.sequence - b.sequence),
      queued: queued.filter((m) => !handed?.has(m.writeId) || wasReturned(undefined, m.writeId)),
    };
  }

  /**
   * A reader fork that never read what it was handed: its derive failed, or
   * its run threw before it reported. While the epoch that held the
   * messages still holds the channel, they go back to its backlog, and the
   * next invocation for the channel is handed them. Returns how many went
   * back (0 once the epoch has ended: its cancel had its own last fork).
   */
  readerFailed(invocation: Pick<ReaderInvocation, 'serverId' | 'channelId' | 'epochId' | 'backlog' | 'queued'>): number {
    const { serverId, channelId, epochId } = invocation;
    if (this.holdFor(serverId, channelId)?.epochId !== epochId) return 0;
    const key = this.handOffKey(epochId, serverId, channelId);
    const returned = this.readerReturned.get(key) ?? { ids: new Set<string>(), writeIds: new Set<string>() };
    for (const m of invocation.backlog) returned.ids.add(m.id);
    for (const m of invocation.queued) returned.writeIds.add(m.writeId);
    const count = invocation.backlog.length + invocation.queued.length;
    if (count > 0) {
      this.readerReturned.set(key, returned);
      // They count again toward the next cadence look, which hands them back.
      const tally = this.key(serverId, channelId);
      this.divertedSinceInvocation.set(tally, (this.divertedSinceInvocation.get(tally) ?? 0) + count);
    }
    return count;
  }

  /**
   * The held messages still queued behind the resident's turn that `keep`
   * keeps, oldest first, with their write ids. One the host gives no id for
   * is left to reach a reader once it is stored: without the id, its stored
   * row couldn't be told from a message no reader has had.
   */
  private queuedHeld(keep: (m: Pick<StoredMessage, 'metadata'>) => boolean): QueuedHeldMessage[] {
    return (this.hooks.getDeferredMessages?.() ?? [])
      .filter((m): m is QueuedHeldMessage => typeof m.writeId === 'string' && keep(m));
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
        text: `[${NOTICE_TAG.standingDispositions}]\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
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
        const note = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined;
        const endScope = (): { success: boolean; data?: unknown; error?: string; isError?: boolean } => {
          const result = this.cancelAllExcept('subconscious', 'subconscious judgment', note, caller);
          return result.ok
            ? { success: true, data: { cancelled: true, scope: 'all-except' } }
            : { success: false, error: result.error, isError: true };
        };
        // A call naming the all-except scope ends that hold outright, as the
        // tool describes it and as the resident's tune_out cancel does: the
        // channel it names, tuned out on its own or not, doesn't turn it
        // into that channel's cancel, and with no hold it ends nothing.
        if (input.scope === 'all-except') return endScope();
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
        if (!channel || !this.channelRegistry.getTuneOutState(channel.serverId, channel.channelId)) {
          // The reader keeps its latitude over the all-except hold too: a
          // channel it holds (or the scope named as the channel) ends the
          // scope. A call naming the scope "channel" ends only a channel's
          // own tune-out, so on a channel only the scope holds it ends
          // nothing.
          const scope = this.getAllExcept();
          const heldByScope = scope && (name === 'all-except'
            || (channel !== undefined && this.holdFor(channel.serverId, channel.channelId)?.epochId === scope.params.epochId));
          if (!heldByScope) return { success: false, error: refusal ?? this.notTunedOut(JSON.stringify(name), 'the resident'), isError: true };
          if (input.scope === 'channel') {
            const shown = channel ? this.quotedShown(channel.serverId, channel.channelId) : JSON.stringify(name);
            return {
              success: false,
              error: `Nothing was cancelled: ${shown} isn't tuned out on its own, and scope "channel" ends only a channel's own `
                + 'tune-out. The all-except hold holds it, and calling cancel_tuneout with scope "all-except" ends that hold.',
              isError: true,
            };
          }
          return endScope();
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
   * A cancel of a channel that isn't tuned out, by the name, quoted, the caller gave
   * or knows it by: which channels are, so the next call can name one, and
   * how a tune-out ends without one. `backlogTo`
   * names the resident as the message's reader knows it: "you" to the
   * resident, "the resident" to the subconscious. It speaks of connected
   * channels because listActive reads the registered ones: removing a server
   * drops its channels and keeps their tune-outs, so a tune-out there is in
   * neither this list nor the name's lookup (channelsNamed, which reads the
   * registered channels too), and the text claims nothing about it.
   */
  private notTunedOut(quoted: string, backlogTo: 'you' | 'the resident'): string {
    const active = this.listActive().map((e) => this.quotedShown(e.serverId, e.channelId));
    const opening = active.length === 0
      ? 'no connected channel is tuned out now.'
      : `no connected channel ${quoted} is tuned out. Connected channels tuned out now: `
        + `${active.join(', ')}.`;
    return `Nothing was cancelled: ${opening} A tune-out also ends by itself when its duration runs out, or at the `
      + `first wake past its wake budget, and its backlog goes to ${backlogTo} then.`;
  }

  /**
   * The reader ended, not the framework: its turns stop (cadence and
   * coalescing wakes), and every hold keeps its end time, which releases it
   * to the resident with no reader.
   */
  stopReader(): void {
    for (const timer of this.cadenceTimers.values()) clearTimeout(timer);
    this.cadenceTimers.clear();
    for (const { timer } of this.pendingWakes.values()) clearTimeout(timer);
    this.pendingWakes.clear();
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
