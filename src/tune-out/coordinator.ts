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
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ChannelRegistry, TuneOutParams } from '../mcpl/channel-registry.js';
import type { McplServerRegistry } from '../mcpl/server-registry.js';
import { CapabilityGrant } from '../mcpl/capability-grant.js';
import { armAfter, armAt } from '../deadline-timer.js';

/** Defaults for tune_out tool params. */
export const TUNE_OUT_DEFAULTS = {
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
} as const;

/** Coalescing window for wake invocations: a mention storm becomes one
 *  subconscious turn, and max-wakes counts invocations, not messages. */
const WAKE_COALESCE_MS = 2_000;

/** How long after an end time whose cancel threw the cancel is tried again. */
const EXPIRY_RETRY_MS = 60_000;

/** Ends a backlog line cut to fit in one of the residents' messages. */
const CUT_MARK = " [cut to fit; the whole message is in the channel's history]";

/**
 * tune_out's refusal of a channel already tuned out: its settings, then what
 * its transport is now where the repeat tried to open it again (`transport`,
 * from the framework's dispatch), then how to change the settings.
 */
export function alreadyTunedOutText(channelId: string, p: TuneOutParams, transport?: string): string {
  // A duration so long its end is past what a Date can hold has no time to show.
  const expires = p.expiresAtMs !== undefined ? new Date(p.expiresAtMs) : undefined;
  const until = expires && Number.isFinite(expires.getTime())
    ? `, until ${expires.toISOString().replace(/\.\d+Z$/, 'Z')}`
    : '';
  // A thrown error's words may end without a stop.
  const now = transport === undefined ? '' : /[.!?]$/.test(transport) ? `${transport} ` : `${transport}. `;
  return `Nothing changed${transport !== undefined ? ' in the tune-out' : ''}: ${JSON.stringify(channelId)} is already `
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
  /** The subconscious's registry/participant name. */
  subconsciousName: () => string | null;
  /** The primary resident's registry name. */
  primaryName: () => string | null;
  /** Read the primary's stored messages (shared slot, unfiltered). */
  getStoredMessages: () => StoredMessage[];
  /**
   * Messages admitted for the primary but not yet in its store (deferred
   * while a turn was alive), oldest first. A cancel reads them too, so a
   * message held mid-turn is in the backlog it belongs to (#232 gap 7).
   */
  getDeferredMessages?: () => Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>;
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
  isForkBound: (channelId: string) => boolean;
  /** Gate privileged-users list (#77: privileged authors wake, like mentions). */
  isPrivilegedAuthor: (authorId: string | null | undefined) => boolean;
  /** speak_in_channel master switch (recipe-side, canary-gated). */
  allowChannelSpeech: () => boolean;
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

  constructor(
    private readonly channelRegistry: ChannelRegistry,
    private readonly serverRegistry: McplServerRegistry,
    private readonly hooks: TuneOutFrameworkHooks,
  ) {}

  private key(serverId: string, channelId: string): string {
    return `${serverId}\0${channelId}`;
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
    if (oldestAnchor !== null) {
      this.hooks.setSubconsciousAnchor(oldestAnchor);
    }
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

  enter(
    serverId: string,
    channelId: string,
    opts: { cadenceSeconds?: number; backlogCap?: number; maxWakes?: number; durationSeconds?: number },
    source: string,
  ): { ok: true; params: TuneOutParams } | { ok: false; error: string; alreadyTunedOut?: true } {
    if (!this.hooks.subconsciousName()) {
      return {
        ok: false,
        error: 'Nothing was tuned out: this host has no subconscious resident to watch a channel, so tune_out '
          + "isn't available here, and calling it again won't change that. If you need channels diverted, ask "
          + 'whoever runs this host.',
      };
    }
    if (this.hooks.isForkBound(channelId)) {
      return {
        ok: false,
        error: `Nothing changed: a conversation is bound to ${JSON.stringify(channelId)}, so its messages go to that `
          + "conversation, and tune_out won't divert a channel while one is. Calling tune_out on it again won't change "
          + 'that until the conversation ends, which happens only once the channel has been quiet for a while. Tune '
          + 'out a different channel, or ask whoever runs this host if this one should be diverted.',
      };
    }
    const current = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (current) return { ok: false, error: alreadyTunedOutText(channelId, current.params), alreadyTunedOut: true };
    // A tool's input reaches here as the model wrote it, and the store can't
    // keep a NaN or an Infinity: its append would throw after the registry
    // had marked the channel tuned out. So each option is read as a number
    // before anything changes, a numeric string included, as the sleep tool
    // reads its seconds; null counts as left out. A value that gives no
    // finite number is refused.
    const leftOut = {
      durationSeconds: 'to stay tuned out until you cancel',
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    } as const;
    const given: Partial<Record<keyof typeof leftOut, number>> = {};
    for (const name of Object.keys(leftOut) as Array<keyof typeof leftOut>) {
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
            + `and it was ${got}. Leave it out ${leftOut[name]}.`,
        };
      }
      given[name] = n;
    }
    const expiresAtMs = given.durationSeconds === undefined
      ? undefined
      : Date.now() + Math.max(60, given.durationSeconds) * 1000;
    if (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs)) {
      return {
        ok: false,
        error: `Nothing was tuned out: durationSeconds ${given.durationSeconds} is longer than an end time can be kept. `
          + `Leave it out ${leftOut.durationSeconds}.`,
      };
    }
    const params: TuneOutParams = {
      epochId: randomUUID(),
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
    // A tune-out can end in the registry without cancel (a send into the
    // channel or a close sets its state there), leaving its timers armed:
    // clear them, so none of them acts on this one.
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
    this.startCadence(serverId, channelId, params.cadenceSeconds);
    this.hooks.emitTrace({ type: 'tune-out:entered', serverId, channelId, epochId: params.epochId });
    return { ok: true, params };
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
  ): { ok: true } | { ok: false; error: string } {
    const ended = this.channelRegistry.cancelTuneOut(serverId, channelId, 'open', source);
    if (!ended) {
      // Its reader is the resident's tune_out: cancel_tuneout finds the channel first.
      return { ok: false, error: this.notTunedOut(channelId, 'you') };
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
      (m.metadata as { author?: { name?: string } } | undefined)?.author?.name ?? m.participant;
    const lineOf = (m: Pick<StoredMessage, 'participant' | 'content' | 'metadata'>): string => {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return `${authorOf(m)}: ${text}`;
    };
    const lifecycle = `[Tune-out: ${channelId} cancelled — ${reason}, ${ended.wakeCount} wake${ended.wakeCount === 1 ? '' : 's'}]`;
    const render = (lines: string[], truncated: number): string => {
      const attrs = [
        `channel="${channelId}"`,
        `messages=${backlog.length}`,
        ...(truncated > 0 ? [`truncated=${truncated} (oldest; fetch_history covers the rest)`] : []),
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
      const head = prefixOf(lines.at(-1) ?? '', room - frameShowing(1) - CUT_MARK.length);
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
    // The subconscious's own words, under its own name, verbatim.
    const subName = this.hooks.subconsciousName();
    if (subconsciousNote && subName) {
      this.hooks.addMessage(
        subName,
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
        [{ type: 'text', text: `[Tune-out cancelled: ${channelId} — ${reason}.${truncNote}${heldNote}]` }],
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
      this.hooks.requestInference(subName, `tune-out cancelled: ${channelId}`, 'tune-out');
    }
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
    const state = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (!state) return null;

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
    if (gatePass && (addressed || privileged)) {
      this.scheduleWakeInvocation(serverId, channelId);
    }
    return { epochId: state.params.epochId };
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
        this.invokeSubconscious(serverId, channelId, 'wake', entry?.count ?? 1);
      } catch (err) {
        this.timerFailed('wake', serverId, channelId, err);
      }
    }, WAKE_COALESCE_MS);
    this.pendingWakes.set(key, { count: 1, timer });
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
    if (!subName) return;
    const key = this.key(serverId, channelId);

    const notice = trigger === 'wake'
      ? `[Tune-out wake: ${channelId} — ${count} addressed message${count === 1 ? '' : 's'}]`
      : `[Tune-out cadence: ${channelId} — ${count} diverted message${count === 1 ? '' : 's'} since your last look]`;
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: notice }],
      { system: true, kind: `tune-out-${trigger}`, channelId },
      subName,
    );
    this.hooks.requestInference(subName, `tune-out ${trigger}: ${channelId}`, 'tune-out');
    // Counted from here only once the turn has been asked for, so a turn that
    // throws leaves its messages for the next period's turn.
    this.divertedSinceInvocation.set(key, 0);
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
        if (!subName) return { success: false, error: 'subconscious not configured', isError: true };
        // Verbatim, under its own participant name, into the resident's window.
        this.hooks.addMessage(subName, [{ type: 'text', text }], {
          kind: 'subconscious-summary',
          channelId,
        });
        return { success: true, data: { delivered: true } };
      }
      case 'cancel_tuneout': {
        const channelId = String(input.channelId ?? '');
        const located = this.findByChannel(channelId);
        if (!located) return { success: false, error: this.notTunedOut(channelId, 'the resident'), isError: true };
        const note = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined;
        const result = this.cancel(located.serverId, channelId, 'subconscious', 'subconscious judgment', note);
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
        return this.channelRegistry.publishForAgent(channelId, text, this.hooks.subconsciousName() ?? 'Subconscious');
      }
      default:
        return { success: false, error: `unknown subconscious tool: ${name}`, isError: true };
    }
  }

  /**
   * A cancel of a channel that isn't tuned out: which channels are, so the
   * next call can name one, and how a tune-out ends without one. `backlogTo`
   * names the resident as the message's reader knows it: "you" to the
   * resident, "the resident" to the subconscious. It speaks of connected
   * channels because listActive reads the registered ones: removing a server
   * drops its channels and keeps their tune-outs, so a tune-out there is in
   * neither this list nor findByChannel's lookup, and the text claims nothing
   * about it.
   */
  private notTunedOut(channelId: string, backlogTo: 'you' | 'the resident'): string {
    const active = this.listActive().map((e) => JSON.stringify(e.channelId));
    const opening = active.length === 0
      ? 'no connected channel is tuned out now.'
      : `no connected channel ${JSON.stringify(channelId)} is tuned out. Connected channels tuned out now: `
        + `${active.join(', ')}.`;
    return `Nothing was cancelled: ${opening} A tune-out also ends by itself when its duration runs out, or at the `
      + `first wake past its wake budget, and its backlog goes to ${backlogTo} then.`;
  }

  private findByChannel(channelId: string): { serverId: string } | null {
    for (const entry of this.listActive()) {
      if (entry.channelId === channelId) return { serverId: entry.serverId };
    }
    return null;
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
