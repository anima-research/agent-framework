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

/** Defaults for tune_out tool params. */
export const TUNE_OUT_DEFAULTS = {
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
} as const;

/** Coalescing window for wake invocations: a mention storm becomes one
 *  subconscious turn, and max-wakes counts invocations, not messages. */
const WAKE_COALESCE_MS = 2_000;

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
  /** Read accepted primary messages, including writes still deferred by quiesce. */
  getBacklogMessages: () => Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>;
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
  /** Duration-expiry timers (params.expiresAtMs); cleared on any cancel. */
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
    const remaining = Math.max(0, params.expiresAtMs - Date.now());
    this.expiryTimers.set(key, setTimeout(() => {
      this.expiryTimers.delete(key);
      this.cancel(serverId, channelId, 'duration', 'duration elapsed');
    }, remaining));
  }

  private listActive(): Array<{ serverId: string; channelId: string; params: TuneOutParams }> {
    // Registration is transient: a slow/disconnected connector must not hide
    // a durable epoch from deadline recovery or subconscious cancellation.
    return this.channelRegistry.listActiveTuneOuts();
  }

  // ==========================================================================
  // Enter / cancel
  // ==========================================================================

  enter(
    serverId: string,
    channelId: string,
    opts: { cadenceSeconds?: number; backlogCap?: number; maxWakes?: number; durationSeconds?: number },
    source: string,
  ): { ok: true; params: TuneOutParams } | { ok: false; error: string } {
    if (!this.hooks.subconsciousName()) {
      return { ok: false, error: 'tune-out requires the subconscious resident (framework config `subconscious`)' };
    }
    if (this.hooks.isForkBound(channelId)) {
      return { ok: false, error: `channel ${channelId} is bound to a conversation fork; tune-out and fork routing are mutually exclusive` };
    }
    if (this.channelRegistry.getTuneOutState(serverId, channelId)) {
      return { ok: false, error: `channel ${channelId} is already tuned out (cancel first to change params)` };
    }
    const params: TuneOutParams = {
      epochId: randomUUID(),
      cadenceSeconds: Math.max(30, opts.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, opts.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, opts.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      ...(opts.durationSeconds !== undefined
        ? { expiresAtMs: Date.now() + Math.max(60, opts.durationSeconds) * 1000 }
        : {}),
    };
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
      return { ok: false, error: `channel ${channelId} is not tuned out` };
    }
    this.stopCadence(serverId, channelId);
    const expiry = this.expiryTimers.get(this.key(serverId, channelId));
    if (expiry) {
      clearTimeout(expiry);
      this.expiryTimers.delete(this.key(serverId, channelId));
    }
    const pending = this.pendingWakes.get(this.key(serverId, channelId));
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingWakes.delete(this.key(serverId, channelId));
    }
    this.divertedSinceInvocation.delete(this.key(serverId, channelId));

    // Backlog: every message stamped with this epoch, oldest first.
    const epochId = ended.params.epochId;
    const backlog = this.hooks.getBacklogMessages().filter(
      (m) => (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId,
    );
    const cap = ended.params.backlogCap;
    const shown = cap > 0 ? backlog.slice(-cap) : [];
    const truncated = backlog.length - shown.length;

    const lines = shown.map((m) => {
      const author = (m.metadata as { author?: { name?: string } } | undefined)?.author?.name ?? m.participant;
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return `${author}: ${text}`;
    });
    const attrs = [
      `channel="${channelId}"`,
      `messages=${backlog.length}`,
      ...(truncated > 0 ? [`truncated=${truncated} (oldest; fetch_history covers the rest)`] : []),
    ];
    const dump =
      `<tuned-out-backlog ${attrs.join(' ')}>\n${lines.join('\n')}\n</tuned-out-backlog>`;

    // Host-framed system artifacts — never voiced as anyone.
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: `[Tune-out: ${channelId} cancelled — ${reason}, ${ended.wakeCount} wake${ended.wakeCount === 1 ? '' : 's'}]\n\n${dump}` }],
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
    // The subconscious gets one cancel turn of its own (unless it initiated
    // the cancel — its note already carries its words): the issue's cancel
    // shape is dump + a report from the subconscious, and when the cap
    // truncated the raw dump, its summary is what covers the tail.
    if (source !== 'subconscious' && subName) {
      const truncNote = truncated > 0
        ? ` ${truncated} of ${backlog.length} diverted messages were above the cap and not delivered raw.`
        : '';
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text: `[Tune-out cancelled: ${channelId} — ${reason}.${truncNote}]` }],
        { system: true, kind: 'tune-out-cancel-report', channelId },
        subName,
      );
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
    if (gatePass) this.handleAdmittedWake(serverId, channelId, messageId, tags, authorId);
    return { epochId: state.params.epochId };
  }

  /** A debounce has now admitted this event. Its original ingestion already
   * counted/stored it; only the wake and acknowledgement remain. An ended
   * epoch's delayed wake is consumed, never forwarded to the resident or a
   * newer epoch on the same channel. */
  onDeferredWake(
    serverId: string,
    channelId: string,
    epochId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
  ): void {
    if (this.channelRegistry.getTuneOutState(serverId, channelId)?.params.epochId !== epochId) return;
    this.handleAdmittedWake(serverId, channelId, messageId, tags, authorId);
  }

  private handleAdmittedWake(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
  ): void {
    const addressed = Array.isArray(tags) && tags.includes('chat:addressed');
    const privileged = this.hooks.isPrivilegedAuthor(authorId);
    if (addressed && messageId) {
      // The mention-er always gets a deterministic signal, independent of
      // what the subconscious later decides (grant-gated; decline
      // precedent). Gate-suppressed mentions get NO reaction: main would
      // not have signaled either, and reacting would leak the resident's
      // standing mute to its subject.
      void this.acknowledgeSuppressed(serverId, channelId, messageId);
    }
    if (addressed || privileged) {
      this.scheduleWakeInvocation(serverId, channelId);
    }
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
      this.hooks.emitTrace({
        type: 'tune-out:ack-failed',
        serverId,
        channelId,
        error: (err as Error).message,
      });
    }
  }

  // ==========================================================================
  // Subconscious invocation (cadence + coalesced wakes)
  // ==========================================================================

  private startCadence(serverId: string, channelId: string, cadenceSeconds: number): void {
    this.stopCadence(serverId, channelId);
    const key = this.key(serverId, channelId);
    const tick = () => {
      const state = this.channelRegistry.getTuneOutState(serverId, channelId);
      if (!state) return; // cancelled meanwhile
      const diverted = this.divertedSinceInvocation.get(key) ?? 0;
      // An empty period needs no turn at all — skip silently.
      if (diverted > 0) {
        this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
      }
      this.cadenceTimers.set(key, setTimeout(tick, cadenceSeconds * 1000));
    };
    this.cadenceTimers.set(key, setTimeout(tick, cadenceSeconds * 1000));
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
    this.divertedSinceInvocation.set(key, 0);

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
    try {
      const raw = this.channelRegistry.readCoordinatorState(this.dispositionsStateId);
      this.dispositionsCache = (raw && typeof raw === 'object') ? raw as Record<string, string> : {};
    } catch {
      this.dispositionsCache = {};
    }
    return this.dispositionsCache;
  }

  noteDisposition(key: string, text: string): void {
    const dispositions = { ...this.readDispositions() };
    if (text === '') {
      delete dispositions[key];
    } else {
      dispositions[key] = text;
    }
    this.dispositionsCache = dispositions;
    this.channelRegistry.writeCoordinatorState(this.dispositionsStateId, dispositions);
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
        if (!text) return { success: false, error: 'empty summary', isError: false };
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
        if (!located) return { success: false, error: `channel ${channelId} is not tuned out`, isError: false };
        const note = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined;
        const result = this.cancel(located.serverId, channelId, 'subconscious', 'subconscious judgment', note);
        return result.ok
          ? { success: true, data: { cancelled: true } }
          : { success: false, error: result.error, isError: false };
      }
      case 'note_disposition': {
        const key = String(input.key ?? '').trim();
        if (!key) return { success: false, error: 'key required', isError: false };
        this.noteDisposition(key, String(input.text ?? ''));
        return { success: true, data: { noted: key } };
      }
      case 'speak_in_channel': {
        if (!this.hooks.allowChannelSpeech()) {
          return {
            success: false,
            isError: false,
            error: 'channel speech is disabled for the subconscious (recipe: subconscious.allowChannelSpeech)',
          };
        }
        const channelId = String(input.channelId ?? '');
        const text = String(input.text ?? '').trim();
        if (!text) return { success: false, error: 'empty message', isError: false };
        return this.channelRegistry.publishForAgent(channelId, text, this.hooks.subconsciousName() ?? 'Subconscious');
      }
      default:
        return { success: false, error: `unknown subconscious tool: ${name}`, isError: true };
    }
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
