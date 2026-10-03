/**
 * FocusCoordinator — a bounded, agent-chosen attention narrowing.
 *
 * While focused, the resident receives traffic from exactly ONE channel
 * (identity = (serverId, channelId), as in the registry). Everything else
 * with a channel identity (other channels, DMs) is HELD: stored in the
 * shared slot with an ingestion-time stamp (`metadata.focusHeld = { epochId }`)
 * that the residents' viewFilter excludes permanently, never woken on, and
 * never injected into a live turn. Addressed messages (mentions, replies,
 * DMs) in channels the resident is open in get one deterministic
 * host-authored autoreply per (channel, author) per epoch so the mention-er
 * knows the resident saw nothing. Focus ends by agent tool, by operator,
 * or when its deadline elapses; ending delivers the held backlog per
 * channel — the newest `backlogCap` messages raw, the rest pointed at the
 * resident's history/backscroll tools.
 *
 * Scope, stated plainly: the hold is host-wide — it narrows the shared
 * window every resident on this host reads (the subconscious reads
 * unfiltered). Events with no channel identity (heartbeats, non-chat
 * pushes) pass. Channels under tune-out (#77) stay with the subconscious
 * and are neither held nor auto-replied here.
 *
 * Sibling of the tune-out coordinator: same stamp-and-filter exclusion,
 * same lifecycle-log durability, same deadline pattern — but per-resident
 * rather than per-channel, no subconscious, and an inverted predicate.
 *
 * Voice doctrine: host-authored framing is bracket-styled system text
 * (`[Focus …]`, `<focus-backlog …>`), never voiced as the resident. The
 * in-channel autoreply is explicitly marked as automatic.
 */

import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ChannelRegistry, FocusParams } from '../mcpl/channel-registry.js';
import type { ToolDefinition } from '../types/index.js';
import { formatZonedTime } from '../timezone.js';

/** Configuration for focus mode (FrameworkConfig.focus). */
export interface FocusConfig {
  /**
   * Master switch: exposes the `focus` tool to the primary resident. The
   * coordinator itself runs whenever a channel subsystem exists, so a focus
   * epoch persisted before the switch was turned off still ends (and
   * delivers its backlog) at the next boot instead of stranding its held
   * messages behind the view filter.
   */
  enabled: boolean;
  /** Duration when the tool call names none (default 1800 s). */
  defaultDurationSeconds?: number;
  /** Hard ceiling on a single focus epoch (default 14400 s = 4 h; floored
   *  at 60 s, capped at 7 days; integers). */
  maxDurationSeconds?: number;
  /** Per-channel raw backlog delivered at unfocus (default 20). */
  defaultBacklogCap?: number;
  /** Ceiling on backlogCap (default 200; integer ≥ 0). */
  maxBacklogCap?: number;
  /** Post an automatic reply to addressed messages while focused (default
   *  true). Replies go only into channels the resident is open in and into
   *  DMs — never into a channel the resident chose to stay out of. */
  autoReply?: boolean;
  /**
   * Autoreply text. Placeholders: `{name}` (resident), `{until}` (local
   * wall-clock deadline), `{remaining}` (e.g. "25m"), `{channel}` (focus
   * channel label). Default: see DEFAULT_AUTOREPLY.
   */
  autoReplyTemplate?: string;
}

export const FOCUS_DEFAULTS = {
  defaultDurationSeconds: 1800,
  maxDurationSeconds: 14_400,
  defaultBacklogCap: 20,
  maxBacklogCap: 200,
  minDurationSeconds: 60,
  /** Absolute ceiling on any configured maximum: a week. */
  hardMaxDurationSeconds: 7 * 24 * 3600,
} as const;

export const DEFAULT_AUTOREPLY =
  '[Automatic reply] {name} is in focus mode for about {remaining} more ' +
  '(until ~{until}). Your message has been held and will be read when focus ends.';

export const FOCUS_TOOL_NAME = 'focus';

/**
 * Effective limits from a config: every maximum is an integer, the duration
 * maximum is floored at the 60 s minimum and capped at a week, and each
 * default is clamped into its range — so a recipe cannot configure an epoch
 * the tool description says cannot exist, or a fractional cap that
 * `slice(-0.5)` would turn into "deliver everything".
 */
export function resolveFocusLimits(cfg: FocusConfig): {
  minDuration: number; maxDuration: number; defaultDuration: number;
  maxCap: number; defaultCap: number;
} {
  const int = (v: number | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  const minDuration = FOCUS_DEFAULTS.minDurationSeconds;
  const maxDuration = Math.min(
    FOCUS_DEFAULTS.hardMaxDurationSeconds,
    Math.max(minDuration, int(cfg.maxDurationSeconds, FOCUS_DEFAULTS.maxDurationSeconds)),
  );
  const defaultDuration = Math.min(maxDuration, Math.max(minDuration, int(cfg.defaultDurationSeconds, FOCUS_DEFAULTS.defaultDurationSeconds)));
  const maxCap = Math.max(0, int(cfg.maxBacklogCap, FOCUS_DEFAULTS.maxBacklogCap));
  const defaultCap = Math.min(maxCap, Math.max(0, int(cfg.defaultBacklogCap, FOCUS_DEFAULTS.defaultBacklogCap)));
  return { minDuration, maxDuration, defaultDuration, maxCap, defaultCap };
}

export function buildFocusToolDefinition(cfg: FocusConfig): ToolDefinition {
  const limits = resolveFocusLimits(cfg);
  return {
    name: FOCUS_TOOL_NAME,
    description:
      'Narrow your attention to ONE channel for a bounded time. While focused, ' +
      'only that channel reaches you; every other channel and DM is held (stored, ' +
      'not shown, no wake). People who address you in a channel you are open in ' +
      'get an automatic reply saying you are in focus mode. Focus ends by itself ' +
      'at the deadline, or on mode "end"; either way each held channel\'s newest ' +
      'messages are delivered (capped per channel) and the rest stay reachable ' +
      'through your history/backscroll tools. Mode "check" shows what is being ' +
      'held without ending focus. Calling "enter" while already focused ' +
      're-targets: the new channel\'s held backlog is delivered and the deadline ' +
      'resets. Not held: events without a channel (heartbeats, non-chat ' +
      'notifications) and channels you have tuned out (those stay with your ' +
      'subconscious).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['enter', 'check', 'end'],
          description: 'Default: enter.',
        },
        channelId: {
          type: 'string',
          description:
            'enter: the channel to focus on (required). check: limit the ' +
            'report to one held channel and show its held messages.',
        },
        serverId: {
          type: 'string',
          description: 'enter: disambiguates a channelId registered by more than one server.',
        },
        durationSeconds: {
          type: 'number',
          description:
            `enter: how long to stay focused (default ${limits.defaultDuration}, ` +
            `min ${limits.minDuration}, max ${limits.maxDuration}).`,
        },
        backlogCap: {
          type: 'number',
          description:
            `enter: newest messages delivered raw PER CHANNEL when focus ends ` +
            `(default ${limits.defaultCap}, max ${limits.maxCap}). Older ones are counted and left to history tools.`,
        },
        limit: {
          type: 'number',
          description: 'check with channelId: how many newest held messages to show (default: backlogCap).',
        },
      },
    },
  };
}

/** A message bound for the primary's window that has not landed in the store yet. */
export interface DeferredMessageView {
  participant: string;
  content: ContentBlock[];
  metadata?: Record<string, unknown>;
}

export interface FocusFrameworkHooks {
  /** Deliver a message into the residents' shared window (turn-alive safe).
   *  `deferred` = parked until the next turn boundary. */
  addMessage: (
    participant: string,
    content: ContentBlock[],
    metadata?: Record<string, unknown>,
  ) => { id: string; deferred: boolean };
  /** Queue an inference request for an agent. */
  requestInference: (agentName: string, reason: string, source: string) => void;
  /** The primary resident's registry name. */
  primaryName: () => string | null;
  /** Read the primary's stored messages (shared slot, unfiltered). */
  getStoredMessages: () => StoredMessage[];
  /** Messages for the primary still parked in the deferred queue (a held
   *  message that arrived mid-turn lives here until the turn boundary). */
  getDeferredMessages: () => DeferredMessageView[];
  /** Current chronicle head sequence. */
  currentSequence: () => number;
  /** Human label for a channel, when known. */
  channelLabel: (serverId: string, channelId: string) => string | undefined;
  /** Post host-authored text into a channel, server-qualified. */
  publish: (serverId: string, channelId: string, text: string) => Promise<{ success: boolean; error?: string }>;
  /** May the host speak into this channel on the resident's behalf? Open
   *  channels and DMs yes; a channel the resident stays out of, no. */
  canAutoReplyInto: (serverId: string, channelId: string) => boolean;
  /** Is the channel under an active tune-out (#77)? */
  isTunedOut: (serverId: string, channelId: string) => boolean;
  /** The resident's IANA zone for wall-clock rendering. */
  timeZone: () => string;
  /** Tool names the resident can currently call (for the backscroll hint). */
  availableToolNames: () => string[];
  /** True when per-channel conversation routing is active (focus unsupported). */
  isForkRouted: () => boolean;
  /** Focus state changed — the framework refreshes locus + gate hold. */
  onFocusChanged: (state: FocusParams | null) => void;
  emitTrace: (event: { type: string; [key: string]: unknown }) => void;
}

interface HeldStamp {
  epochId: string;
  /** Set on the message whose arrival triggered an autoreply attempt for
   *  its (channel, author). Optimistic: recorded at send time, so after a
   *  restart a reply that failed to publish is not retried for that pair. */
  autoReplied?: true;
}

/** A held message as the dump sees it: stored, or still deferred. */
interface HeldMessage {
  sequence: number;
  participant: string;
  content: ContentBlock[];
  metadata?: Record<string, unknown>;
  timestamp: Date;
  deferred: boolean;
}

const DUMP_KINDS = new Set(['focus-end', 'focus-retarget']);

export class FocusCoordinator {
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** (channelId\0authorId) pairs already auto-replied in the active epoch. */
  private autoReplied = new Set<string>();
  /** Held-message tallies for the active epoch (rebuilt from the store at resume). */
  private heldCount = 0;
  private addressedCount = 0;
  /** Autoreplies that actually published in the active epoch. */
  private repliedCount = 0;

  constructor(
    private readonly channelRegistry: ChannelRegistry,
    private readonly config: FocusConfig,
    private readonly hooks: FocusFrameworkHooks,
  ) {}

  // ==========================================================================
  // State
  // ==========================================================================

  getState(): FocusParams | null {
    return this.channelRegistry.getFocus();
  }

  isFocused(): boolean {
    return this.getState() !== null;
  }

  /**
   * After a process restart: re-arm a live epoch, end one whose deadline
   * passed or that the configuration can no longer serve, and re-wake the
   * resident if an end-of-focus dump was restored into the deferred queue
   * (its wake was in-memory and died with the old process).
   */
  resume(): void {
    const state = this.getState();
    if (!state) {
      if (this.hasDeferredDump()) {
        const primary = this.hooks.primaryName();
        if (primary) this.hooks.requestInference(primary, 'focus backlog restored after restart', 'focus');
      }
      return;
    }
    if (!this.config.enabled) {
      this.end('config', 'focus is disabled in the configuration');
      return;
    }
    if (this.hooks.isForkRouted()) {
      this.end('config', 'per-channel conversation routing is active');
      return;
    }
    if (state.expiresAtMs <= Date.now()) {
      // The deadline passed while the host was down: the resident gets the
      // backlog on the schedule they committed to, not whenever we restarted.
      this.end('duration', 'deadline elapsed while the host was down');
      return;
    }
    this.rebuildTallies(state);
    this.armExpiry(state);
    this.hooks.onFocusChanged(state);
  }

  private hasDeferredDump(): boolean {
    return this.hooks.getDeferredMessages().some((m) => {
      const kind = m.metadata?.kind;
      return typeof kind === 'string' && DUMP_KINDS.has(kind);
    });
  }

  private rebuildTallies(state: FocusParams): void {
    this.autoReplied.clear();
    this.heldCount = 0;
    this.addressedCount = 0;
    this.repliedCount = 0;
    for (const m of this.heldMessages(state.epochId)) {
      this.heldCount++;
      const md = m.metadata;
      const tags = md?.tags;
      if (Array.isArray(tags) && tags.includes('chat:addressed')) this.addressedCount++;
      const stamp = md?.focusHeld as HeldStamp | undefined;
      if (stamp?.autoReplied) {
        this.repliedCount++;
        const key = this.replyKey(String(md?.channelId ?? ''), authorIdOf(md));
        if (key) this.autoReplied.add(key);
      }
    }
  }

  private armExpiry(state: FocusParams): void {
    this.clearExpiry();
    // Node timers overflow past 2^31-1 ms; durations are capped far below
    // that, but a corrupted record must not wrap into an immediate fire.
    const remaining = Math.min(Math.max(0, state.expiresAtMs - Date.now()), 0x7fff_ffff);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.end('duration', 'deadline reached');
    }, remaining);
  }

  private clearExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  // ==========================================================================
  // Enter / re-target / end
  // ==========================================================================

  enter(
    channelId: string,
    opts: { durationSeconds?: number; backlogCap?: number; serverId?: string },
    source: string,
  ): { ok: true; params: FocusParams; retargeted: boolean } | { ok: false; error: string } {
    if (!this.config.enabled) {
      return { ok: false, error: 'focus is disabled in the configuration' };
    }
    if (this.hooks.isForkRouted()) {
      return { ok: false, error: 'focus is not available under per-channel conversation routing' };
    }
    const resolved = this.channelRegistry.resolveChannel(channelId, opts.serverId);
    if (!resolved.entry) {
      return { ok: false, error: resolved.error ?? `unknown channel: ${channelId}` };
    }
    const target = resolved.entry;
    if (this.hooks.isTunedOut(target.serverId, target.channelId)) {
      return {
        ok: false,
        error:
          `channel ${channelId} is tuned out — its traffic goes to your subconscious, so focusing on it ` +
          `would deliver nothing. Cancel the tune-out first (tune_out with mode: 'cancel').`,
      };
    }
    const now = Date.now();
    const limits = resolveFocusLimits(this.config);
    const requested = opts.durationSeconds ?? limits.defaultDuration;
    const durationSeconds = Math.min(limits.maxDuration, Math.max(limits.minDuration, Math.floor(requested)));

    const current = this.getState();
    if (current) {
      // Re-target: the new channel's held backlog is what the resident is
      // walking into — deliver it now; the old focus channel becomes held
      // from here on. Same epoch: stamps stay valid, tallies carry over.
      // Only STORED messages release early: one still deferred behind the
      // current turn has no sequence to watermark against, so it arrives at
      // unfocus with the rest.
      const requestedCap = opts.backlogCap ?? current.backlogCap;
      const backlogCap = Math.min(limits.maxCap, Math.max(0, Math.floor(requestedCap)));
      const released = { ...(current.released ?? {}) };
      const pending = this.heldMessages(current.epochId)
        .filter((m) => !m.deferred && serverIdOf(m) === target.serverId && channelIdOf(m) === target.channelId
          && !this.isReleased(current, m));
      let dumpText = '';
      if (pending.length > 0) {
        released[this.releaseKey(target.serverId, target.channelId)] = pending[pending.length - 1]!.sequence;
        dumpText = '\n\n' + this.renderChannelDump(target.serverId, target.channelId, pending, backlogCap);
        if (pending.length > backlogCap) {
          const hint = this.backscrollHint(backlogCap);
          if (hint) dumpText += '\n\n' + hint;
        }
      }
      const params: FocusParams = {
        ...current,
        serverId: target.serverId,
        channelId: target.channelId,
        backlogCap,
        expiresAtMs: now + durationSeconds * 1000,
        released,
      };
      this.channelRegistry.setFocus(params, source);
      this.armExpiry(params);
      this.hooks.onFocusChanged(params);
      const oldLabel = this.labelFor(current.serverId, current.channelId);
      this.hooks.addMessage(
        'user',
        [{ type: 'text', text:
          `[Focus re-targeted: ${oldLabel} → ${this.labelFor(target.serverId, target.channelId)}, ` +
          `until ~${this.untilText(params.expiresAtMs)}. ${oldLabel} is now held.` +
          `${pending.length > 0 ? ` ${pending.length} held message${pending.length === 1 ? '' : 's'} from the new channel:` : ''}]` +
          dumpText }],
        { system: true, kind: 'focus-retarget', channelId: target.channelId, epochId: params.epochId },
      );
      this.hooks.emitTrace({ type: 'focus:retargeted', from: current.channelId, to: target.channelId, epochId: params.epochId });
      return { ok: true, params, retargeted: true };
    }

    const requestedCap = opts.backlogCap ?? limits.defaultCap;
    const params: FocusParams = {
      epochId: randomUUID(),
      serverId: target.serverId,
      channelId: target.channelId,
      startedAtMs: now,
      startedAtSequence: this.hooks.currentSequence(),
      expiresAtMs: now + durationSeconds * 1000,
      backlogCap: Math.min(limits.maxCap, Math.max(0, Math.floor(requestedCap))),
    };
    this.channelRegistry.setFocus(params, source);
    this.autoReplied.clear();
    this.heldCount = 0;
    this.addressedCount = 0;
    this.repliedCount = 0;
    this.armExpiry(params);
    this.hooks.onFocusChanged(params);
    this.hooks.emitTrace({ type: 'focus:entered', serverId: target.serverId, channelId: target.channelId, epochId: params.epochId, expiresAtMs: params.expiresAtMs });
    return { ok: true, params, retargeted: false };
  }

  /**
   * End focus: durable flip, per-channel backlog dumps (newest `backlogCap`
   * raw, remainder counted + pointed at history tools), lifecycle notice,
   * one wake for the resident. Held messages still deferred behind the
   * current turn are included — they are held traffic too.
   */
  end(source: string, reason: string): { ok: true; held: number } | { ok: false; error: string } {
    const state = this.getState();
    if (!state) return { ok: false, error: 'not in focus mode' };
    this.channelRegistry.setFocus(null, source);
    this.clearExpiry();
    this.hooks.onFocusChanged(null);

    const byChannel = new Map<string, { serverId: string; channelId: string; messages: HeldMessage[] }>();
    let held = 0;
    for (const m of this.heldMessages(state.epochId)) {
      if (this.isReleased(state, m)) continue;
      const serverId = serverIdOf(m) ?? state.serverId;
      const channelId = channelIdOf(m) ?? '(unknown channel)';
      const key = this.releaseKey(serverId, channelId);
      const entry = byChannel.get(key) ?? { serverId, channelId, messages: [] };
      entry.messages.push(m);
      byChannel.set(key, entry);
      held++;
    }

    const minutes = Math.max(1, Math.round((Date.now() - state.startedAtMs) / 60_000));
    const focusLabel = this.labelFor(state.serverId, state.channelId);
    const addressedNote = this.addressedCount === 0
      ? ''
      : `; ${this.addressedCount} addressed you` +
        (this.repliedCount > 0
          ? ` (${this.repliedCount === this.addressedCount ? 'all' : this.repliedCount} got the automatic reply)`
          : ' (no automatic reply was sent)');
    const header =
      `[Focus ended — ${reason}. You were focused on ${focusLabel} for ~${minutes}m. ` +
      (held === 0
        ? 'Nothing was held.]'
        : `${held} message${held === 1 ? '' : 's'} held across ${byChannel.size} channel${byChannel.size === 1 ? '' : 's'}${addressedNote}.]`);

    const dumps: string[] = [];
    // Most recently active channel last, so the freshest context is nearest
    // the resident's next turn.
    const ordered = [...byChannel.values()].sort(
      (a, b) => a.messages[a.messages.length - 1]!.sequence - b.messages[b.messages.length - 1]!.sequence,
    );
    for (const { serverId, channelId, messages } of ordered) {
      dumps.push(this.renderChannelDump(serverId, channelId, messages, state.backlogCap));
    }
    const truncatedAny = ordered.some((c) => c.messages.length > state.backlogCap);
    const hint = truncatedAny ? this.backscrollHint(state.backlogCap) : null;

    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: [header, ...dumps, ...(hint ? [hint] : [])].join('\n\n') }],
      { system: true, kind: 'focus-end', epochId: state.epochId, channelId: state.channelId },
    );
    const primary = this.hooks.primaryName();
    if (primary) {
      this.hooks.requestInference(primary, `focus ended (${reason})`, 'focus');
    }
    this.hooks.emitTrace({
      type: 'focus:ended', epochId: state.epochId, channelId: state.channelId, reason, held,
      addressed: this.addressedCount, replied: this.repliedCount,
    });
    this.autoReplied.clear();
    this.heldCount = 0;
    this.addressedCount = 0;
    this.repliedCount = 0;
    return { ok: true, held };
  }

  // ==========================================================================
  // Ingestion: hold, stamp, autoreply
  // ==========================================================================

  /**
   * Consulted by the framework for every incoming channel/DM message BEFORE
   * storage. Null = not focused, or this IS the focus channel (same server,
   * same channel — proceed normally). Otherwise the caller stamps
   * `metadata.focusHeld` with the returned object, stores the message, and
   * wakes nobody.
   */
  onIncoming(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    author: { id?: string; name?: string } | undefined,
  ): HeldStamp | null {
    const state = this.getState();
    if (!state) return null;
    if (serverId === state.serverId && channelId === state.channelId) return null;

    this.heldCount++;
    const addressed = Array.isArray(tags) && tags.includes('chat:addressed');
    const stamp: HeldStamp = { epochId: state.epochId };
    if (!addressed) return stamp;

    this.addressedCount++;
    if (this.config.autoReply === false) return stamp;
    // Where the host may speak: channels the resident is open in, and DMs.
    // A mention in a channel the resident stays out of is held and counted,
    // reply-less — before focus it produced an invitation the resident
    // decided on; the host must not answer in a room they chose not to join.
    if (!this.hooks.canAutoReplyInto(serverId, channelId)) return stamp;
    const key = this.replyKey(channelId, author?.id);
    if (key && this.autoReplied.has(key)) return stamp;
    if (key) this.autoReplied.add(key);
    stamp.autoReplied = true;
    void this.sendAutoReply(state, serverId, channelId, messageId, key);
    return stamp;
  }

  private replyKey(channelId: string, authorId: string | undefined | null): string | null {
    if (!channelId) return null;
    return `${channelId}\0${authorId ?? ''}`;
  }

  private async sendAutoReply(
    state: FocusParams, serverId: string, channelId: string, messageId: string, key: string | null,
  ): Promise<void> {
    const template = this.config.autoReplyTemplate ?? DEFAULT_AUTOREPLY;
    const remainingMin = Math.max(1, Math.round((state.expiresAtMs - Date.now()) / 60_000));
    const text = template
      .replaceAll('{name}', this.hooks.primaryName() ?? 'The agent')
      .replaceAll('{until}', this.untilText(state.expiresAtMs))
      .replaceAll('{remaining}', `${remainingMin}m`)
      .replaceAll('{channel}', this.labelFor(state.serverId, state.channelId));
    let failure: string | undefined;
    try {
      const result = await this.hooks.publish(serverId, channelId, text);
      if (!result.success) failure = result.error ?? 'publish failed';
    } catch (err) {
      failure = (err as Error).message;
    }
    if (failure !== undefined) {
      // Release the (channel, author) allowance so the next addressed
      // message from them retries rather than staying silent all epoch.
      if (key) this.autoReplied.delete(key);
      this.hooks.emitTrace({ type: 'focus:autoreply-failed', serverId, channelId, messageId, error: failure });
      return;
    }
    this.repliedCount++;
    this.hooks.emitTrace({ type: 'focus:autoreply', serverId, channelId, messageId });
  }

  // ==========================================================================
  // Check (status + peek)
  // ==========================================================================

  status(): {
    focused: boolean;
    channelId?: string;
    serverId?: string;
    channel?: string;
    expiresAt?: string;
    remainingSeconds?: number;
    backlogCap?: number;
    held?: Array<{ channelId: string; serverId: string; channel: string; messages: number; addressed: number; latest: string }>;
  } {
    const state = this.getState();
    if (!state) return { focused: false };
    const byChannel = new Map<string, { serverId: string; channelId: string; messages: number; addressed: number; latest: string }>();
    for (const m of this.heldMessages(state.epochId)) {
      if (this.isReleased(state, m)) continue;
      const serverId = serverIdOf(m) ?? state.serverId;
      const channelId = channelIdOf(m) ?? '(unknown channel)';
      const key = this.releaseKey(serverId, channelId);
      const entry = byChannel.get(key) ?? { serverId, channelId, messages: 0, addressed: 0, latest: '' };
      entry.messages++;
      const tags = m.metadata?.tags;
      if (Array.isArray(tags) && tags.includes('chat:addressed')) entry.addressed++;
      entry.latest = this.clock(m.timestamp.getTime());
      byChannel.set(key, entry);
    }
    return {
      focused: true,
      channelId: state.channelId,
      serverId: state.serverId,
      channel: this.labelFor(state.serverId, state.channelId),
      expiresAt: this.untilText(state.expiresAtMs),
      remainingSeconds: Math.max(0, Math.round((state.expiresAtMs - Date.now()) / 1000)),
      backlogCap: state.backlogCap,
      held: [...byChannel.values()].map((e) => ({
        channelId: e.channelId,
        serverId: e.serverId,
        channel: this.labelFor(e.serverId, e.channelId),
        messages: e.messages,
        addressed: e.addressed,
        latest: e.latest,
      })),
    };
  }

  /** Newest `limit` held messages of one channel, rendered — without releasing them. */
  peek(channelId: string, limit?: number, serverId?: string): { ok: true; text: string; total: number } | { ok: false; error: string } {
    const state = this.getState();
    if (!state) return { ok: false, error: 'not in focus mode' };
    const messages = this.heldMessages(state.epochId)
      .filter((m) => channelIdOf(m) === channelId && (!serverId || serverIdOf(m) === serverId) && !this.isReleased(state, m));
    const sid = serverId ?? serverIdOf(messages[0]) ?? state.serverId;
    const cap = Math.max(0, Math.floor(limit ?? state.backlogCap));
    return { ok: true, total: messages.length, text: this.renderChannelDump(sid, channelId, messages, cap) };
  }

  // ==========================================================================
  // Tool dispatch (resident)
  // ==========================================================================

  handleTool(input: Record<string, unknown>): { success: boolean; data?: unknown; error?: string; isError?: boolean } {
    const mode = typeof input.mode === 'string' ? input.mode : 'enter';
    const serverId = typeof input.serverId === 'string' && input.serverId ? input.serverId : undefined;
    switch (mode) {
      case 'enter': {
        const channelId = String(input.channelId ?? '');
        if (!channelId) return { success: false, error: 'channelId is required to enter focus', isError: false };
        const r = this.enter(channelId, {
          durationSeconds: numberOrUndefined(input.durationSeconds),
          backlogCap: numberOrUndefined(input.backlogCap),
          serverId,
        }, 'agent-tool');
        if (!r.ok) return { success: false, error: r.error, isError: false };
        return {
          success: true,
          data: {
            focused: r.params.channelId,
            serverId: r.params.serverId,
            channel: this.labelFor(r.params.serverId, r.params.channelId),
            until: this.untilText(r.params.expiresAtMs),
            backlogCap: r.params.backlogCap,
            ...(r.retargeted ? { retargeted: true } : {}),
          },
        };
      }
      case 'check': {
        const status = this.status();
        if (!status.focused) return { success: true, data: status };
        const channelId = typeof input.channelId === 'string' && input.channelId ? input.channelId : undefined;
        if (!channelId) return { success: true, data: status };
        const p = this.peek(channelId, numberOrUndefined(input.limit), serverId);
        if (!p.ok) return { success: false, error: p.error, isError: false };
        return {
          success: true,
          data: {
            ...status,
            held: status.held?.filter((h) => h.channelId === channelId && (!serverId || h.serverId === serverId)),
            peek: p.text,
          },
        };
      }
      case 'end': {
        const r = this.end('agent-tool', 'ended by you');
        return r.ok
          ? { success: true, data: { ended: true, held: r.held } }
          : { success: false, error: r.error, isError: false };
      }
      default:
        return { success: false, error: `unknown focus mode: ${mode}`, isError: false };
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** Every message stamped with this epoch: stored ones in store order, then
   *  the ones still deferred behind the current turn (in queue order). */
  private heldMessages(epochId: string): HeldMessage[] {
    const stampedWith = (md: Record<string, unknown> | undefined): boolean =>
      (md?.focusHeld as HeldStamp | undefined)?.epochId === epochId;
    const stored: HeldMessage[] = this.hooks.getStoredMessages()
      .filter((m) => stampedWith(m.metadata as Record<string, unknown> | undefined))
      .map((m) => ({
        sequence: m.sequence, participant: m.participant, content: m.content,
        metadata: m.metadata as Record<string, unknown> | undefined, timestamp: m.timestamp, deferred: false,
      }));
    const base = stored.length > 0 ? stored[stored.length - 1]!.sequence : this.hooks.currentSequence();
    const deferred: HeldMessage[] = this.hooks.getDeferredMessages()
      .filter((m) => stampedWith(m.metadata))
      .map((m, i) => ({
        sequence: base + 1 + i, participant: m.participant, content: m.content,
        metadata: m.metadata, timestamp: new Date(), deferred: true,
      }));
    return [...stored, ...deferred];
  }

  private releaseKey(serverId: string, channelId: string): string {
    return `${serverId}\u0000${channelId}`;
  }

  private isReleased(state: FocusParams, m: HeldMessage): boolean {
    if (m.deferred) return false;
    const ch = channelIdOf(m);
    if (!ch) return false;
    const released = state.released ?? {};
    // Keys are server-qualified; a record from before qualification used the
    // bare channel id — honour both so an in-flight epoch keeps its watermarks.
    const through = released[this.releaseKey(serverIdOf(m) ?? state.serverId, ch)] ?? released[ch];
    return through !== undefined && m.sequence <= through;
  }

  /** "18:40 America/Los_Angeles" — for deadlines the reader must act on. */
  private untilText(ms: number): string {
    const tz = this.hooks.timeZone();
    return `${formatZonedTime(ms, tz)} ${tz}`;
  }

  /** "18:40" — per-line stamps inside a dump (zone given once on the block). */
  private clock(ms: number): string {
    return formatZonedTime(ms, this.hooks.timeZone());
  }

  private labelFor(serverId: string, channelId: string): string {
    const label = this.hooks.channelLabel(serverId, channelId);
    return label ? `#${label} (${channelId})` : channelId;
  }

  private renderChannelDump(serverId: string, channelId: string, messages: HeldMessage[], cap: number): string {
    const shown = cap > 0 ? messages.slice(-cap) : [];
    const truncated = messages.length - shown.length;
    const lines = shown.map((m) => {
      const md = m.metadata;
      const author = (md?.author as { name?: string } | undefined)?.name
        ?? (typeof md?.authorName === 'string' && md.authorName ? md.authorName : undefined)
        ?? m.participant;
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      // Non-text blocks (images, audio, documents) are not re-delivered raw;
      // name them so a media-only message is not an empty line and a mixed
      // one does not silently lose its attachment.
      const extras = new Map<string, number>();
      for (const b of m.content) {
        if (b.type !== 'text') extras.set(b.type, (extras.get(b.type) ?? 0) + 1);
      }
      const extraNote = [...extras.entries()].map(([t, n]) => `[+${n} ${t}${n === 1 ? '' : 's'}]`).join(' ');
      const stamp = m.deferred ? 'arrived mid-turn' : this.clock(m.timestamp.getTime());
      return `[${stamp}] ${author}: ${[text, extraNote].filter(Boolean).join(' ')}`;
    });
    const attrs = [
      `channel="${this.labelFor(serverId, channelId)}"`,
      `messages=${messages.length}`,
      `tz="${this.hooks.timeZone()}"`,
      ...(truncated > 0 ? [`truncated=${truncated} (oldest, not shown)`] : []),
    ];
    return `<focus-backlog ${attrs.join(' ')}>\n${lines.join('\n')}\n</focus-backlog>`;
  }

  /** Name only tools the resident actually has (tune-out's dump pointed at a
   *  fetch_history most residents lack). */
  private backscrollHint(cap: number): string | null {
    const tools = new Set(this.hooks.availableToolNames());
    const options: string[] = [];
    if (tools.has('history--extract')) options.push(`history--extract {channelId, limit}`);
    if (tools.has('channel_open')) options.push(`channel_open {channelId, backscroll}`);
    for (const t of tools) if (t.endsWith('fetch_history')) options.push(`${t} {channelId, limit}`);
    if (options.length === 0) return null;
    return `[Held messages above the per-channel cap of ${cap} are in your history: ${options.join(' · ')}]`;
  }

  /** Stop timers (framework shutdown). */
  stop(): void {
    this.clearExpiry();
  }
}

function channelIdOf(m: HeldMessage): string | undefined {
  const v = m.metadata?.channelId;
  return typeof v === 'string' && v ? v : undefined;
}

function serverIdOf(m: HeldMessage | undefined): string | undefined {
  const v = m?.metadata?.serverId;
  return typeof v === 'string' && v ? v : undefined;
}

function authorIdOf(md: Record<string, unknown> | undefined): string | undefined {
  const author = md?.author as { id?: unknown } | undefined;
  if (author && author.id != null) return String(author.id);
  if (md?.authorId != null) return String(md.authorId);
  return undefined;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
