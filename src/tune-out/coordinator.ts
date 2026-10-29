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
import { authorLine, authorNamed, beginsWithAuthorLine } from '../author-presentation.js';
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
  const author = authorNamed(m.metadata) ?? m.participant;
  const parts = m.content.map((b: ContentBlock) =>
    b.type === 'text' ? (b as Extract<ContentBlock, { type: 'text' }>).text : `[${b.type}]`,
  );
  const line = parts.filter((p) => p.length > 0).join(' ');
  const firstText = m.content.find((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')?.text;
  return firstText !== undefined && beginsWithAuthorLine(author, firstText) ? line : authorLine(author, line);
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
 * What `subconscious/<primary>/window-starts` keeps (`{ v: 1, starts,
 * inForce? }`): each active tune-out's window start as an index ordinal, by
 * epoch id, and the ordinal the window start is set to now (`inForce`),
 * which may be a cancelled tune-out's while another stays active, since a
 * cancel leaves the start where it was.
 */
interface WindowStartsState {
  starts: Record<string, number>;
  inForce?: number;
}

export function cancelWaitsNote(what: string, noteDropped = false): string {
  return 'Not cancelled yet: an operator\'s change to the store is in progress, or a context the cancel writes to '
    + 'refuses writes until the host re-initializes it, so the cancel waits until that is over. Cancelling again '
    + 'doesn\'t end the wait sooner, and how long it lasts isn\'t known here. '
    + `${what} stays in force until then, and what it held is delivered when it ends. If the host stops before then, `
    + 'the cancel is lost and it is still in force after the restart, unless its end time has passed by then.'
    + (noteDropped ? ' Your note isn\'t delivered with it: the cancel already waiting carries a note of its own.' : '');
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
  /**
   * Read the primary's stored messages (shared slot, unfiltered). A held
   * message is stored as it arrives, even during the resident's turn, so
   * this is every message an epoch holds (#232 gap 7), but for those a live
   * surgery's hold keeps in memory (getSurgeryHeldMessages).
   */
  getStoredMessages: () => StoredMessage[];
  /**
   * The writes for the primary's store that a live surgery's hold keeps in
   * memory, in arrival order: made while the operator's switch is awaited,
   * and stored, in that order, only at its release. A tune-out that ends
   * during the hold has its held messages among them, which its dump lists
   * and a check counts as it does the stored ones (#232 gap 7). Left out,
   * none are.
   */
  getSurgeryHeldMessages?: () => Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>;
  /**
   * Make what was just delivered durable: a release flips durable epoch
   * state, so its dump must survive a crash in the same window (#232 gap 6).
   */
  commitDeliveries?: () => void;
  /**
   * Whether a write the coordinator made now would be kept in memory rather
   * than stored: a live surgery's hold, or a context manager of the primary
   * or the subconscious refusing its work until a switch re-initializes it.
   * A cancel then waits (deferCancel), the tune-out still in force, until
   * the framework says the writes are stored again (runDeferredCancels), so
   * the release is in the store before the epoch's end is recorded. Left
   * out, never.
   */
  writesHeld?: () => boolean;
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
   * (subconsciousWindowFixed). `others` are the other active tune-outs'
   * starts whose ordinal isn't kept yet, which the framework fixes and
   * reports the same way without moving the window to them.
   */
  setSubconsciousAnchor: (start: SubconsciousWindowStart, others?: readonly SubconsciousWindowStart[]) => void;
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
   * `reader: 'forks'`: held messages a reader fork was handed but never read,
   * per epoch and channel, by id: its derive failed, or its run threw before
   * it reported (readerFailed). The next invocation is handed them again,
   * cursor or no. Cleared with the cursor.
   */
  private readerReturned = new Map<string, Set<string>>();
  /**
   * `reader: 'forks'`: the late forks derived for an ended epoch's messages
   * (readerFailed), so that a late fork's own failure derives no other.
   */
  private lateForks = new WeakSet<object>();
  /** The all-except scope's durable record, cached (undefined = not read yet). */
  private scopeCache: AllExceptState | null | undefined;
  /** The epoch whose release this process delivered and whose hold is not yet recorded as cleared. */
  private scopeReleased: string | undefined;
  /**
   * Cancels asked for while the framework keeps writes in memory
   * (writesHeld), by channel key, the all-except hold's under SCOPE_KEY:
   * each runs as it was asked, with a note a later cancel gave it
   * (deferCancel), once the writes are stored again (runDeferredCancels).
   * In memory: a restart before then finds the tune-out still in force,
   * and an end time that passed cancels it at once (resumeActiveEpochs).
   */
  private readonly deferredCancels = new Map<string, {
    run: (note: string | undefined, noteAuthor: string | undefined) => void;
    note?: string;
    noteAuthor?: string;
  }>();
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
    for (const map of [this.readerCursor, this.readerReturned]) {
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

  /**
   * Every message of the primary's store, in arrival order: those stored,
   * then those a live surgery's hold keeps in memory until its release
   * (getSurgeryHeldMessages). What a dump lists and a check counts, so a
   * tune-out that ends during the hold still has what it held then. A
   * reader is handed stored rows only (getStoredMessages): those the hold
   * keeps have no id until stored, and the dump has them.
   */
  private residentMessages(): Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> {
    const stored = this.hooks.getStoredMessages();
    let kept: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> = [];
    try {
      kept = this.hooks.getSurgeryHeldMessages?.() ?? [];
    } catch (err) {
      console.error('[tune-out] could not read the writes a surgery holds in memory, so the stored messages alone are read:', err);
    }
    return kept.length > 0 ? [...stored, ...kept] : stored;
  }

  private quotedShown(serverId: string, channelId: string): string {
    return this.channelRegistry.quotedShown({ serverId, channelId });
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
    this.anchorSubconscious('resume');
    // What each held channel's reader hasn't looked at was counted in
    // memory, so it is counted again from the held rows: without it, a
    // channel held across the restart gets no cadence look until something
    // new arrives. Every held message is stored as it arrives (#291), so the
    // stored rows are all of them.
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
   *
   * A cancel leaves the start where it was while another tune-out stays
   * active too, so the subconscious's report on the one cancelled still has
   * what it held, and the start in force is kept (`inForce`). At a resume
   * that start is set again rather than the oldest active tune-out's, which
   * is later than it once the oldest was cancelled: so the window is the
   * same across a restart. An enter sets the oldest active tune-out's, as it
   * always has. The other active tune-outs whose start isn't kept yet go
   * with it, for the framework to fix as soon as each can be.
   */
  private anchorSubconscious(occasion: 'enter' | 'resume' = 'enter'): void {
    const active = this.activeStarts();
    if (active.length === 0) return;
    const sequence = Math.min(...active.map((e) => e.sequence));
    const epochIds = active.filter((e) => e.sequence === sequence).map((e) => e.epochId);
    const kept = this.ordinalsKept();
    const state: WindowStartsState = kept ? this.readWindowState() : { starts: {} };
    let ordinal = epochIds.map((id) => state.starts[id]).find((o) => o !== undefined);
    // At a resume, the start in force before the restart (a cancelled
    // tune-out's, say), and never past the oldest active one's own start
    // where one is kept.
    if (occasion === 'resume' && state.inForce !== undefined) {
      ordinal = ordinal === undefined ? state.inForce : Math.min(ordinal, state.inForce);
    }
    // The start in force from now: this ordinal, or, while the start waits
    // to be fixed, none until the fix reports it (subconsciousWindowFixed).
    if (kept && state.inForce !== ordinal) {
      const { inForce: _was, ...rest } = state;
      this.writeWindowState(ordinal !== undefined ? { ...rest, inForce: ordinal } : rest);
    }
    const others: SubconsciousWindowStart[] = [];
    if (kept) {
      const bySequence = new Map<number, string[]>();
      for (const e of active) {
        if (e.sequence === sequence || state.starts[e.epochId] !== undefined) continue;
        bySequence.set(e.sequence, [...(bySequence.get(e.sequence) ?? []), e.epochId]);
      }
      for (const [at, ids] of bySequence) others.push({ sequence: at, epochIds: ids });
    }
    this.hooks.setSubconsciousAnchor({ sequence, ...(ordinal !== undefined ? { ordinal } : {}), epochIds }, others);
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
   * store's branch now, and the start in force (`inForce`: the ordinal the
   * window start was last set to while a tune-out is active), which a
   * restart sets again (anchorSubconscious). A state that can't be read, or
   * isn't this format (`{ v: 1, starts, inForce? }`), reads as none kept,
   * and is written over at the next fix, with a line saying so. A state an
   * earlier version kept, with no `inForce`, reads as one with none in
   * force, and a restart sets the oldest active tune-out's start, as that
   * version did.
   */
  private readWindowState(): WindowStartsState {
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.windowStartsStateId);
    } catch (err) {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) can't be read, so none is kept:`, err);
      return { starts: {} };
    }
    if (raw == null) return { starts: {} };
    const state = raw as { v?: unknown; starts?: unknown; inForce?: unknown };
    if (state.v !== 1 || !state.starts || typeof state.starts !== 'object') {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) aren't in a form this version reads, so none is kept; the next fix writes over them`);
      return { starts: {} };
    }
    const isOrdinal = (o: unknown): o is number => typeof o === 'number' && Number.isInteger(o) && o >= 0;
    const starts: Record<string, number> = {};
    for (const [epochId, ordinal] of Object.entries(state.starts as Record<string, unknown>)) {
      if (isOrdinal(ordinal)) starts[epochId] = ordinal;
    }
    return { starts, ...(isOrdinal(state.inForce) ? { inForce: state.inForce } : {}) };
  }

  /** Keep `state`, answering whether it was written; a write that fails is logged, and the anchor the strategy holds stays as it is. */
  private writeWindowState(state: WindowStartsState): boolean {
    try {
      this.channelRegistry.writeCoordinatorState(this.windowStartsStateId, {
        v: 1,
        starts: state.starts,
        ...(state.inForce !== undefined ? { inForce: state.inForce } : {}),
      });
      return true;
    } catch (err) {
      console.error(`[tune-out] the subconscious's window starts (${this.windowStartsStateId}) couldn't be written, so a restart fixes them again:`, err);
      return false;
    }
  }

  /**
   * The framework fixed the subconscious's window start for `epochIds` at
   * `ordinal` (its index ordinal, #291): kept for each of them still active,
   * so a later anchor (another tune-out's enter, a restart) sets that
   * ordinal again rather than converting the tune-out's sequence anew, and
   * kept as the start in force while any tune-out is active, which a
   * restart sets again (anchorSubconscious), when it is the start in force
   * (`inForce`; another active tune-out's start fixed beside it isn't).
   * Answers whether it is kept, so that the anchor tries again at its next
   * presentation when it isn't.
   */
  subconsciousWindowFixed(epochIds: readonly string[], ordinal: number, inForce = true): boolean {
    if (!this.ordinalsKept()) return true;
    const active = new Set(this.activeStarts().map((e) => e.epochId));
    const state = this.readWindowState();
    let changed = false;
    for (const epochId of epochIds) {
      if (!active.has(epochId) || state.starts[epochId] === ordinal) continue;
      state.starts[epochId] = ordinal;
      changed = true;
    }
    // The window starts there now, whether or not the tune-outs it was fixed
    // for are active still (one cancelled before its start was fixed leaves
    // it in force, as any cancel does), while any tune-out is.
    if (inForce && active.size > 0 && state.inForce !== ordinal) {
      state.inForce = ordinal;
      changed = true;
    }
    return changed ? this.writeWindowState(state) : true;
  }

  /**
   * An ended tune-out's window start goes, and, once none is active, the
   * start in force with it: the next enter sets its own.
   */
  private forgetWindowStart(epochId: string): void {
    if (!this.ordinalsKept()) return;
    const state = this.readWindowState();
    const noneActive = this.activeStarts().length === 0;
    if (!(epochId in state.starts) && !(noneActive && state.inForce !== undefined)) return;
    delete state.starts[epochId];
    if (noneActive) delete state.inForce;
    this.writeWindowState(state);
  }

  /** The window starts of tune-outs no longer active go. */
  private pruneWindowStarts(): void {
    if (!this.ordinalsKept()) return;
    const state = this.readWindowState();
    const active = new Set(this.activeStarts().map((e) => e.epochId));
    const stale = Object.keys(state.starts).filter((epochId) => !active.has(epochId));
    // With none active, no start is in force for the resume to set again.
    const staleInForce = active.size === 0 && state.inForce !== undefined;
    if (stale.length === 0 && !staleInForce) return;
    for (const epochId of stale) delete state.starts[epochId];
    if (staleInForce) delete state.inForce;
    this.writeWindowState(state);
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
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
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
    this.anchorSubconscious();

    this.divertedSinceInvocation.set(this.key(serverId, channelId), 0);
    if (this.readerAvailable()) this.startCadence(serverId, channelId, params.cadenceSeconds);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId, channelId, epochId: params.epochId, reader: this.readerAvailable(),
    });
    return { ok: true, params };
  }

  /** Whether the framework keeps writes in memory now (writesHeld); a hook that throws counts as not. */
  private writesHeldNow(): boolean {
    try {
      return this.hooks.writesHeld?.() === true;
    } catch (err) {
      console.error('[tune-out] could not ask whether writes are held in memory, so a cancel goes on:', err);
      return false;
    }
  }

  /**
   * Keep a cancel asked for while writes are kept in memory, for
   * runDeferredCancels, with its note. The first one asked for a hold
   * stands, with its reason and source. A later one for the same hold (an
   * end time's retry, a wake past the budget, an agent's cancel) adds
   * nothing, except a note: the waiting cancel takes it, with its author,
   * when it has none, and otherwise the later note is dropped, with a log
   * line, and this answers 'note-dropped' so its caller can be told.
   */
  private deferCancel(
    key: string,
    what: string,
    run: (note: string | undefined, noteAuthor: string | undefined) => void,
    note: string | undefined,
    noteAuthor: string | undefined,
  ): 'waits' | 'note-dropped' {
    const waiting = this.deferredCancels.get(key);
    if (!waiting) {
      this.deferredCancels.set(key, { run, ...(note !== undefined ? { note } : {}), ...(noteAuthor !== undefined ? { noteAuthor } : {}) });
      console.error(`[tune-out] the cancel of ${what} waits until the store takes writes again (an operator's change to it is in progress, or a context it writes to refuses writes until it is re-initialized), so that its release is stored before the tune-out's end is recorded`);
      return 'waits';
    }
    if (note === undefined) return 'waits';
    if (waiting.note === undefined) {
      waiting.note = note;
      if (noteAuthor !== undefined) waiting.noteAuthor = noteAuthor;
      return 'waits';
    }
    console.error(`[tune-out] a later cancel of ${what} is dropped with its note: the cancel already waiting carries a note of its own`);
    return 'note-dropped';
  }

  /**
   * Run the cancels asked for while writes were kept in memory (deferCancel),
   * in the order asked, now that the framework stores them again: it calls
   * this once a surgery's release has stored what its hold kept, or told of
   * what it couldn't store. One whose writes are
   * still held waits on; one whose hold has ended meanwhile ends nothing.
   * Never throws.
   */
  runDeferredCancels(): void {
    if (this.deferredCancels.size === 0 || this.writesHeldNow()) return;
    const runs = [...this.deferredCancels.values()];
    this.deferredCancels.clear();
    for (const { run, note, noteAuthor } of runs) {
      try {
        run(note, noteAuthor);
      } catch (err) {
        console.error('[tune-out] a cancel asked for while writes were held in memory failed when it ran:', err);
      }
    }
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
   * synthesized here. While the framework keeps writes in memory
   * (writesHeld: a surgery's hold, a manager refusing its work), nothing
   * ends yet: the cancel waits, the tune-out in force, and runs once the
   * writes are stored (runDeferredCancels), so its release is stored
   * before its end is recorded. It answers `deferred` then.
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
  ): { ok: true; deferred?: true; noteDropped?: true } | { ok: false; error: string } {
    if (this.channelRegistry.getTuneOutState(serverId, channelId) && this.writesHeldNow()) {
      const kept = this.deferCancel(this.key(serverId, channelId), `${this.shown(serverId, channelId)} (${reason})`,
        (note, author) => { this.cancel(serverId, channelId, source, reason, note, author, nextState); },
        subconsciousNote, noteAuthor);
      return { ok: true, deferred: true, ...(kept === 'note-dropped' ? { noteDropped: true as const } : {}) };
    }
    const ended = this.channelRegistry.cancelTuneOut(serverId, channelId, nextState, source);
    if (!ended) {
      // Its reader is the resident's tune_out: cancel_tuneout finds the channel first.
      return { ok: false, error: this.notTunedOut(this.quotedShown(serverId, channelId), 'you') };
    }
    this.clearTimers(serverId, channelId);
    this.divertedSinceInvocation.delete(this.key(serverId, channelId));

    // Backlog: every message held under this epoch, in store order, which
    // is arrival order: a held message is stored as it arrives (#291), but
    // while a surgery holds the store, which keeps it in memory until its
    // release, after every stored one (residentMessages).
    const epochId = ended.params.epochId;
    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const backlog: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> =
      this.residentMessages().filter(ofEpoch);
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
    // The epoch is already ended durably; the release must be as durable. It
    // is stored, not kept in memory: a cancel made while the framework keeps
    // writes in memory waits until it stores them again (deferCancel).
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
        [{ type: 'text', text: `[${NOTICE_TAG.tuneOutCancelled}: ${this.shown(serverId, channelId)} — ${reason}.${truncNote}${unseenNote}]` }],
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
      const unread = this.unhandedBacklog(this.handOffKey(epochId, serverId, channelId), stored).length;
      if (!selfCancel || unread > 0) {
        const truncNote = truncated > 0
          ? ` ${truncated} of ${backlog.length} diverted messages, the oldest, weren't delivered raw to the resident.`
          : '';
        const lateNote = selfCancel
          ? ` ${unread === 1 ? 'This message' : `These ${unread} messages`} arrived after the reader that cancelled was handed its own.`
          : '';
        this.invokeReaderFork(serverId, channelId, epochId, 'cancel', `[${NOTICE_TAG.tuneOutCancelled}: ${name} — ${reason}.${truncNote}${lateNote}]`, stored);
      }
    }
    this.dropHandOffs(epochId);
    this.dropLooks(epochId);
    this.forgetWindowStart(epochId);
    // Where the all-except hold still holds the channel, its own messages
    // there that its reader hasn't looked at are counted again, as the
    // channel's own tune-out's count stood in for theirs.
    this.rebuildTally(serverId, channelId);
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
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
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
    this.anchorSubconscious();
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
    for (const m of this.residentMessages()) {
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
   * While the framework keeps writes in memory it waits, as cancel does.
   */
  cancelAllExcept(
    source: string,
    reason: string,
    note?: string,
    noteAuthor?: string,
  ): { ok: true; deferred?: true; noteDropped?: true } | { ok: false; error: string } {
    const scope = this.getAllExcept();
    if (!scope) return { ok: false, error: 'no all-except hold is active' };
    // As a channel's cancel: while writes are kept in memory, the release
    // would be, and writeScope(null) below is on disk at once.
    if (this.writesHeldNow()) {
      const kept = this.deferCancel(TuneOutCoordinator.SCOPE_KEY, `the all-except hold (${reason})`,
        (waitingNote, author) => { this.cancelAllExcept(source, reason, waitingNote, author); },
        note, noteAuthor);
      return { ok: true, deferred: true, ...(kept === 'note-dropped' ? { noteDropped: true as const } : {}) };
    }
    const { epochId, except, backlogCap } = scope.params;

    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    // Stored, and kept by a surgery's hold until its release (residentMessages).
    const all = this.residentMessages().filter(ofEpoch);
    const byChannel = new Map<string, { serverId: string; channelId: string; backlog: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> }>();
    for (const m of all) {
      const meta = m.metadata as { channelId?: string; serverId?: string } | undefined;
      const serverId = meta?.serverId ?? '';
      const channelId = meta?.channelId ?? '(unknown channel)';
      const k = this.key(serverId, channelId);
      const entry = byChannel.get(k) ?? { serverId, channelId, backlog: [] };
      entry.backlog.push(m);
      byChannel.set(k, entry);
    }
    const historyTool = this.hooks.historyTool?.() ?? null;
    const dumps = [...byChannel.values()].map(({ serverId, channelId, backlog }) => {
      // Floored here too: a hold stored before entry floored its cap can hold
      // a fraction.
      const cap = Math.floor(backlogCap);
      const shown = cap > 0 ? backlog.slice(-cap) : [];
      const truncated = backlog.length - shown.length;
      const attrs = [
        `channel=${quotedValue(this.shown(serverId, channelId))}`,
        `messages=${backlog.length}`,
        ...(truncated > 0 ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`] : []),
      ];
      return `<tuned-out-backlog ${attrs.join(' ')}>\n${shown.map(renderHeldLine).join('\n')}\n</tuned-out-backlog>`;
    });
    const summary = byChannel.size === 0
      ? 'Nothing was held.'
      : `${all.length} message${all.length === 1 ? '' : 's'} held in ${byChannel.size} channel${byChannel.size === 1 ? '' : 's'}.`;
    if (this.scopeReleased !== epochId) {
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: `[${NOTICE_TAG.tuneOut}: all channels except ${this.shown(except.serverId, except.channelId)} released — ${reason}, ${scope.wakeCount} wake${scope.wakeCount === 1 ? '' : 's'}]\n\n${summary}${dumps.length > 0 ? '\n\n' + dumps.join('\n\n') : ''}` }],
        { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: except.channelId, epochId },
      );
      this.hooks.commitDeliveries?.();
      this.scopeReleased = epochId;
    }
    // The release is recorded before the hold is: a failure past this point
    // leaves the hold in force with its release already delivered. A retry in
    // this process records only the hold's end; a restart between the two
    // delivers the release again, where the other order lost it outright.
    this.writeScope(null);
    this.scopeReleased = undefined;
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
      // One last look per channel with messages no fork was handed. That
      // holds for a reader's own release too: the reader that released read one channel's
      // messages, and every other channel's would otherwise reach no reader.
      // A channel is its server and id here, as the readers' bookkeeping is.
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
        if (this.unhandedBacklog(this.handOffKey(epochId, serverId, channelId), stored).length > 0) {
          this.invokeReaderFork(serverId, channelId, epochId, 'cancel', notice, stored);
        }
      }
    }
    for (const key of this.divertedSinceInvocation.keys()) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (!this.channelRegistry.getTuneOutState(serverId, channelId)) this.divertedSinceInvocation.delete(key);
    }
    this.dropHandOffs(epochId);
    this.dropLooks(epochId);
    this.forgetWindowStart(epochId);
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId: except.serverId, channelId: except.channelId, epochId, scope: 'all-except', reason, wakeCount: scope.wakeCount });
    this.announce(except, epochId, 'released', `[${NOTICE_TAG.focus}: ${primary ?? 'the resident'} released — ${reason}.]`);
    return { ok: true };
  }

  /** What is held right now — per-channel epochs and the scope — without releasing. */
  check(opts: { peek?: { serverId?: string; channelId: string }; peekLimit?: number } = {}): TuneOutCheck {
    // Stored, and kept by a surgery's hold until its release (residentMessages).
    const stored = this.residentMessages();
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
      for (const { serverId, channelId, count } of this.scopeHeldCounts(scope.params.epochId).values()) held[this.shown(serverId, channelId)] = count;
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
      ? `[${NOTICE_TAG.tuneOutWake}: ${shown} — ${count} addressed message${count === 1 ? '' : 's'}]`
      : `[${NOTICE_TAG.tuneOutCadence}: ${shown} — ${count} diverted message${count === 1 ? '' : 's'} since your last look]`;
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
      // fork with nothing new to read. A held message a surgery's hold, or a
      // manager waiting for its recovery, keeps in memory wasn't handed: it
      // isn't stored yet. It still counts, so the first cadence period after
      // it is stored hands it.
      this.divertedSinceInvocation.set(key, this.keptInMemory(inChannel));
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

  /** How many of the writes the framework keeps in memory (getSurgeryHeldMessages) `keep` keeps; 0 where they can't be read. */
  private keptInMemory(keep: (m: Pick<StoredMessage, 'metadata'>) => boolean): number {
    try {
      return (this.hooks.getSurgeryHeldMessages?.() ?? []).filter(keep).length;
    } catch (err) {
      console.error('[tune-out] could not read the writes a surgery holds in memory, so none is counted:', err);
      return 0;
    }
  }

  /**
   * Count again, from the held messages (all stored, #291), those the reader
   * of the epoch holding this channel now hasn't looked at: for reader
   * forks, those no fork was handed; for the persistent subconscious, those
   * held since its last look (lastLooks). Nothing holding the channel leaves
   * no count.
   */
  private rebuildTally(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const hold = this.holdFor(serverId, channelId);
    if (!hold || !this.readerAvailable()) {
      this.divertedSinceInvocation.delete(key);
      return;
    }
    const ofChannel = inChannelOf(serverId, channelId);
    const inEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === hold.epochId && ofChannel(m);
    const rows = this.hooks.getStoredMessages().filter(inEpoch);
    let count: number;
    if (this.forkReader) {
      count = this.unhandedBacklog(this.handOffKey(hold.epochId, serverId, channelId), rows).length;
    } else {
      const mark = this.lastLooks()?.[hold.epochId]?.[key];
      count = mark === undefined ? rows.length : rows.filter((m) => m.sequence > mark).length;
    }
    this.divertedSinceInvocation.set(key, count);
  }

  private get lastLooksStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/last-looks`;
  }

  /**
   * The stored last looks. Where they can't be read, none: every held row
   * counts, and nothing is cached, so the next read tries again. Nor is
   * anything written back over the stored record then (markLook, dropLooks,
   * pruneLooks), which would erase the other epochs' and channels' looks.
   */
  private lastLooks(): Record<string, Record<string, number>> | undefined {
    if (this.lastLooksCache !== undefined) return this.lastLooksCache;
    let raw: unknown;
    try {
      raw = this.channelRegistry.readCoordinatorState(this.lastLooksStateId);
    } catch (error) {
      console.error(`[tune-out] the subconscious's last looks (${this.lastLooksStateId}) could not be read:`, error);
      return undefined;
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
    if (!looks) return;
    this.writeLooks({ ...looks, [epochId]: { ...looks[epochId], [this.key(serverId, channelId)]: this.hooks.currentSequence() } });
  }

  /** An ended epoch's last looks go with it. */
  private dropLooks(epochId: string): void {
    if (this.hooks.subconsciousName() == null) return;
    const looks = this.lastLooks();
    if (!looks || !(epochId in looks)) return;
    const { [epochId]: _ended, ...rest } = looks;
    this.writeLooks(rest);
  }

  /** At boot: the last looks of epochs no longer active go. */
  private pruneLooks(): void {
    if (this.hooks.subconsciousName() == null) return;
    const looks = this.lastLooks();
    if (!looks) return;
    const active = new Set(this.listActive().map((e) => e.params.epochId));
    const scope = this.getAllExcept();
    if (scope) active.add(scope.params.epochId);
    const kept = Object.fromEntries(Object.entries(looks).filter(([epochId]) => active.has(epochId)));
    if (Object.keys(kept).length !== Object.keys(looks).length) this.writeLooks(kept);
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
    const key = this.handOffKey(epochId, serverId, channelId);
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
   * first: those past the epoch's cursor for the channel, plus those a
   * failed fork returned.
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
   * messages is still active, they go back to that epoch's backlog for the
   * channel, and its next invocation for the channel is handed them: the
   * scope's while the scope is active, though the channel's own tune-out
   * has taken the channel meanwhile, and a channel's own tune-out's while it
   * holds the channel. Once the epoch has ended, its cancel's last fork was
   * handed only what no fork had been, so a fork still running then is the
   * only reader its messages had: one late fork is handed them instead
   * (lateFork). Returns how many went back or to the late fork.
   */
  readerFailed(invocation: Pick<ReaderInvocation, 'serverId' | 'channelId' | 'epochId' | 'backlog'>): number {
    const { serverId, channelId, epochId } = invocation;
    const active = this.getAllExcept()?.params.epochId === epochId
      || this.channelRegistry.getTuneOutState(serverId, channelId)?.params.epochId === epochId;
    if (!active) return this.lateFork(invocation);
    const key = this.handOffKey(epochId, serverId, channelId);
    const returned = this.readerReturned.get(key) ?? new Set<string>();
    for (const m of invocation.backlog) returned.add(m.id);
    const count = invocation.backlog.length;
    if (count > 0) {
      this.readerReturned.set(key, returned);
      // They count again toward the next cadence look of the epoch holding
      // the channel, which hands them back. Where another epoch holds it
      // now, they're counted again when the channel comes back to theirs
      // (rebuildTally), and its release hands them in any case.
      const tally = this.key(serverId, channelId);
      if (this.holdFor(serverId, channelId)?.epochId === epochId) {
        this.divertedSinceInvocation.set(tally, (this.divertedSinceInvocation.get(tally) ?? 0) + count);
      }
    }
    return count;
  }

  /**
   * A fork that failed after its epoch ended: one late fork is handed what it
   * was, with a notice saying a reader handed them failed after the tune-out
   * ended. Every held message is stored as it arrives (#291), so what it was
   * handed is what the late fork is. A late fork's own failure derives no
   * other, so a reader that keeps failing costs one more fork, not a chain
   * of them. Returns how many the late fork was handed.
   */
  private lateFork(invocation: Pick<ReaderInvocation, 'serverId' | 'channelId' | 'epochId' | 'backlog'>): number {
    if (!this.hooks.invokeReader || this.lateForks.has(invocation)) return 0;
    const { serverId, channelId, epochId } = invocation;
    const backlog = [...invocation.backlog].sort((a, b) => a.sequence - b.sequence);
    const count = backlog.length;
    if (count === 0) return 0;
    const these = count === 1 ? 'This message was' : `These ${count} messages were`;
    const notice = `[${NOTICE_TAG.tuneOutCancelled}: ${this.shown(serverId, channelId)} — ${these} handed to a reader that `
      + `failed after the tune-out ended, so no reader has read ${count === 1 ? 'it' : 'them'} yet.]`;
    const entries = Object.entries(this.readDispositions());
    const late: ReaderInvocation = {
      serverId,
      channelId,
      epochId,
      trigger: 'cancel',
      notice,
      backlog,
      dispositions: entries.length > 0 ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : null,
    };
    this.lateForks.add(late);
    this.hooks.invokeReader(late);
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
    /** A reader fork, with the epoch it was derived to read, if any: it ends and posts only through that epoch's
     *  hold (forkRefusal). The persistent subconscious, which reads every epoch, passes none. */
    fork?: { epochId?: string },
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
          const scope = this.getAllExcept();
          const refused = fork && scope
            ? this.forkRefusal(fork, { epochId: scope.params.epochId }, 'cancel', "the all-except hold isn't the hold you were started to read")
            : undefined;
          if (refused) return { success: false, error: refused, isError: true };
          const result = this.cancelAllExcept('subconscious', 'subconscious judgment', note, caller);
          if (!result.ok) return { success: false, error: result.error, isError: true };
          return result.deferred
            ? { success: true, data: { waiting: true, scope: 'all-except', note: cancelWaitsNote('The all-except hold', result.noteDropped === true) } }
            : { success: true, data: { cancelled: true, scope: 'all-except' } };
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
        const held = this.channelRegistry.getTuneOutState(channel.serverId, channel.channelId)!;
        const refused = fork && this.forkRefusal(fork, { epochId: held.params.epochId }, 'cancel',
          `the tune-out on ${this.quotedShown(channel.serverId, channel.channelId)} isn't the hold you were started to read`);
        if (refused) return { success: false, error: refused, isError: true };
        const result = this.cancel(channel.serverId, channel.channelId, 'subconscious', 'subconscious judgment', note, caller);
        if (!result.ok) return { success: false, error: result.error, isError: true };
        return result.deferred
          ? { success: true, data: { waiting: true, note: cancelWaitsNote('The tune-out', result.noteDropped === true) } }
          : { success: true, data: { cancelled: true } };
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
        if (fork) {
          const named = mine ? [mine.channel] : this.channelRegistry.channelsNamed(channelId);
          const at = named.length === 1 ? named[0] : undefined;
          const hold = at ? this.holdFor(at.serverId, at.channelId) : null;
          const shown = at ? this.quotedShown(at.serverId, at.channelId) : JSON.stringify(channelId);
          const refused = (at || fork.epochId === undefined) && this.forkRefusal(fork, hold, 'speech', hold
            ? `${shown} is held by a hold other than the one you were started to read`
            : `${shown} isn't held now`);
          if (refused) return { success: false, error: refused, isError: true };
        }
        return this.channelRegistry.publishForAgent(mine ? mine.channel : channelId, text, this.hooks.subconsciousName() ?? caller ?? 'Subconscious');
      }
      default:
        return { success: false, error: `unknown subconscious tool: ${name}`, isError: true };
    }
  }

  /**
   * Why a reader fork may not act through `hold` (the epoch holding what its
   * call names, or null): a fork ends and posts only through the hold of the
   * epoch it was derived to read, and one derived for none acts through no
   * hold. Undefined where the hold is its own. `why` says, for the fork, how
   * what its call names isn't its own hold; its reports stay open to it.
   */
  private forkRefusal(
    fork: { epochId?: string },
    hold: { epochId: string } | null,
    act: 'cancel' | 'speech',
    why: string,
  ): string | undefined {
    if (fork.epochId !== undefined && hold?.epochId === fork.epochId) return undefined;
    const nothing = act === 'cancel' ? 'Nothing was cancelled' : 'Nothing was posted';
    const report = `Your report can say what you would ${act === 'cancel' ? 'judge of it' : 'have posted'}, and the resident reads it.`;
    if (fork.epochId === undefined) {
      return `${nothing}: you weren't started to read a tune-out, so there's no hold you can `
        + `${act === 'cancel' ? 'end' : 'post through'}. ${report}`;
    }
    const rule = act === 'cancel' ? 'a reader ends only its own' : 'a reader posts only into a channel its own hold holds';
    return `${nothing}: ${why}, and ${rule}. ${report}`;
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
    // A cancel still waiting for held writes ends nothing: the tune-out stays
    // in force on disk, for the next boot.
    this.deferredCancels.clear();
    for (const timer of this.cadenceTimers.values()) clearTimeout(timer);
    this.cadenceTimers.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const { timer } of this.pendingWakes.values()) clearTimeout(timer);
    this.pendingWakes.clear();
  }
}
