/**
 * FocusCoordinator — a bounded, agent-chosen attention narrowing.
 *
 * While focused, the resident receives traffic from exactly ONE channel.
 * Everything else (other channels, DMs) is HELD: stored in the shared slot
 * with an ingestion-time stamp (`metadata.focusHeld = { epochId }`) that the
 * residents' viewFilter excludes permanently, and never woken on. Addressed
 * messages (mentions, replies, DMs) get one deterministic host-authored
 * autoreply per (channel, author) per epoch so the mention-er knows the
 * resident saw nothing. Focus ends by agent tool, by operator, or when its
 * deadline elapses; ending delivers the held backlog per channel — the
 * newest `backlogCap` messages raw, the rest pointed at the resident's
 * history/backscroll tools.
 *
 * Sibling of the tune-out coordinator (#77): same stamp-and-filter
 * exclusion, same lifecycle-log durability, same deadline pattern — but
 * per-resident rather than per-channel, no subconscious, and an inverted
 * predicate (hold all but one instead of divert one).
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
  /** Master switch: exposes the `focus` tool to the primary resident. */
  enabled: boolean;
  /** Duration when the tool call names none (default 1800 s). */
  defaultDurationSeconds?: number;
  /** Hard ceiling on a single focus epoch (default 14400 s = 4 h). */
  maxDurationSeconds?: number;
  /** Per-channel raw backlog delivered at unfocus (default 20). */
  defaultBacklogCap?: number;
  /** Ceiling on backlogCap (default 200). */
  maxBacklogCap?: number;
  /** Post an automatic reply to addressed messages while focused (default true). */
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
} as const;

export const DEFAULT_AUTOREPLY =
  '[Automatic reply] {name} is in focus mode for about {remaining} more ' +
  '(until ~{until}). Your message has been held and will be read when focus ends.';

export const FOCUS_TOOL_NAME = 'focus';

export function buildFocusToolDefinition(cfg: FocusConfig): ToolDefinition {
  const defaultDuration = cfg.defaultDurationSeconds ?? FOCUS_DEFAULTS.defaultDurationSeconds;
  const maxDuration = cfg.maxDurationSeconds ?? FOCUS_DEFAULTS.maxDurationSeconds;
  const defaultCap = cfg.defaultBacklogCap ?? FOCUS_DEFAULTS.defaultBacklogCap;
  return {
    name: FOCUS_TOOL_NAME,
    description:
      'Narrow your attention to ONE channel for a bounded time. While focused, ' +
      'only that channel reaches you; every other channel and DM is held (stored, ' +
      'not shown, no wake). People who address you elsewhere get an automatic ' +
      'reply saying you are in focus mode. Focus ends by itself at the deadline, ' +
      'or on mode "end"; either way each held channel\'s newest messages are ' +
      'delivered (capped per channel) and the rest stay reachable through your ' +
      'history/backscroll tools. Mode "check" shows what is being held without ' +
      'ending focus. Calling "enter" while already focused re-targets: the new ' +
      'channel\'s held backlog is delivered and the deadline resets.',
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
        durationSeconds: {
          type: 'number',
          description:
            `enter: how long to stay focused (default ${defaultDuration}, ` +
            `min ${FOCUS_DEFAULTS.minDurationSeconds}, max ${maxDuration}).`,
        },
        backlogCap: {
          type: 'number',
          description:
            `enter: newest messages delivered raw PER CHANNEL when focus ends ` +
            `(default ${defaultCap}). Older ones are counted and left to history tools.`,
        },
        limit: {
          type: 'number',
          description: 'check with channelId: how many newest held messages to show (default: backlogCap).',
        },
      },
    },
  };
}

export interface FocusFrameworkHooks {
  /** Deliver a message into the residents' shared window (turn-alive safe). */
  addMessage: (
    participant: string,
    content: ContentBlock[],
    metadata?: Record<string, unknown>,
  ) => string;
  /** Queue an inference request for an agent. */
  requestInference: (agentName: string, reason: string, source: string) => void;
  /** The primary resident's registry name. */
  primaryName: () => string | null;
  /** Read the primary's stored messages (shared slot, unfiltered). */
  getStoredMessages: () => StoredMessage[];
  /** Current chronicle head sequence. */
  currentSequence: () => number;
  /** Human label for a channel, when known. */
  channelLabel: (serverId: string, channelId: string) => string | undefined;
  /** Post host-authored text into a channel. */
  publish: (channelId: string, text: string) => Promise<{ success: boolean; error?: string }>;
  /** The resident's IANA zone for wall-clock rendering. */
  timeZone: () => string;
  /** Tool names the resident can currently call (for the backscroll hint). */
  availableToolNames: () => string[];
  /** True when per-channel conversation routing is active (focus unsupported). */
  isForkRouted: () => boolean;
  /** Focus state changed — the framework refreshes the gate hold predicate. */
  onFocusChanged: (state: FocusParams | null) => void;
  emitTrace: (event: { type: string; [key: string]: unknown }) => void;
}

interface HeldStamp {
  epochId: string;
  /** Set on the message that triggered the autoreply for its (channel, author). */
  autoReplied?: true;
}

export class FocusCoordinator {
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** (channelId\0authorId) pairs already auto-replied in the active epoch. */
  private autoReplied = new Set<string>();
  /** Held-message tallies for the active epoch (rebuilt from the store at resume). */
  private heldCount = 0;
  private addressedCount = 0;

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

  /** Re-arm (or immediately end) a persisted focus after a process restart. */
  resume(): void {
    const state = this.getState();
    if (!state) return;
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

  private rebuildTallies(state: FocusParams): void {
    this.autoReplied.clear();
    this.heldCount = 0;
    this.addressedCount = 0;
    for (const m of this.heldMessages(state.epochId)) {
      this.heldCount++;
      const md = m.metadata as Record<string, unknown> | undefined;
      const tags = md?.tags;
      if (Array.isArray(tags) && tags.includes('chat:addressed')) this.addressedCount++;
      const stamp = md?.focusHeld as HeldStamp | undefined;
      if (stamp?.autoReplied) {
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
    opts: { durationSeconds?: number; backlogCap?: number },
    source: string,
  ): { ok: true; params: FocusParams; retargeted: boolean } | { ok: false; error: string } {
    if (this.hooks.isForkRouted()) {
      return { ok: false, error: 'focus is not available under per-channel conversation routing' };
    }
    const entry = this.channelRegistry.listChannelsRaw().find((e) => e.descriptor.id === channelId);
    if (!entry) {
      return { ok: false, error: `unknown channel: ${channelId}` };
    }
    const now = Date.now();
    const maxDuration = this.config.maxDurationSeconds ?? FOCUS_DEFAULTS.maxDurationSeconds;
    const requested = opts.durationSeconds ?? this.config.defaultDurationSeconds ?? FOCUS_DEFAULTS.defaultDurationSeconds;
    const durationSeconds = Math.min(maxDuration, Math.max(FOCUS_DEFAULTS.minDurationSeconds, Math.floor(requested)));
    const maxCap = this.config.maxBacklogCap ?? FOCUS_DEFAULTS.maxBacklogCap;

    const current = this.getState();
    if (current) {
      // Re-target: the new channel's held backlog is what the resident is
      // walking into — deliver it now; the old focus channel becomes held
      // from here on. Same epoch: stamps stay valid, tallies carry over.
      const requestedCap = opts.backlogCap ?? current.backlogCap;
      const backlogCap = Math.min(maxCap, Math.max(0, Math.floor(requestedCap)));
      const released = { ...(current.released ?? {}) };
      const pending = this.heldMessages(current.epochId)
        .filter((m) => channelIdOf(m) === channelId && !this.isReleased(current, m));
      let dumpText = '';
      if (pending.length > 0) {
        released[channelId] = pending[pending.length - 1]!.sequence;
        dumpText = '\n\n' + this.renderChannelDump(entry.serverId, channelId, pending, backlogCap);
      }
      const params: FocusParams = {
        ...current,
        serverId: entry.serverId,
        channelId,
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
          `[Focus re-targeted: ${oldLabel} → ${this.labelFor(entry.serverId, channelId)}, ` +
          `until ~${this.untilText(params.expiresAtMs)}. ${oldLabel} is now held.` +
          `${pending.length > 0 ? ` ${pending.length} held message${pending.length === 1 ? '' : 's'} from the new channel:` : ''}]` +
          dumpText }],
        { system: true, kind: 'focus-retarget', channelId, epochId: params.epochId },
      );
      this.hooks.emitTrace({ type: 'focus:retargeted', from: current.channelId, to: channelId, epochId: params.epochId });
      return { ok: true, params, retargeted: true };
    }

    const requestedCap = opts.backlogCap ?? this.config.defaultBacklogCap ?? FOCUS_DEFAULTS.defaultBacklogCap;
    const params: FocusParams = {
      epochId: randomUUID(),
      serverId: entry.serverId,
      channelId,
      startedAtMs: now,
      startedAtSequence: this.hooks.currentSequence(),
      expiresAtMs: now + durationSeconds * 1000,
      backlogCap: Math.min(maxCap, Math.max(0, Math.floor(requestedCap))),
    };
    this.channelRegistry.setFocus(params, source);
    this.autoReplied.clear();
    this.heldCount = 0;
    this.addressedCount = 0;
    this.armExpiry(params);
    this.hooks.onFocusChanged(params);
    this.hooks.emitTrace({ type: 'focus:entered', channelId, epochId: params.epochId, expiresAtMs: params.expiresAtMs });
    return { ok: true, params, retargeted: false };
  }

  /**
   * End focus: durable flip, per-channel backlog dumps (newest `backlogCap`
   * raw, remainder counted + pointed at history tools), lifecycle notice,
   * one wake for the resident.
   */
  end(source: string, reason: string): { ok: true; held: number } | { ok: false; error: string } {
    const state = this.getState();
    if (!state) return { ok: false, error: 'not in focus mode' };
    this.channelRegistry.setFocus(null, source);
    this.clearExpiry();
    this.hooks.onFocusChanged(null);

    const byChannel = new Map<string, StoredMessage[]>();
    let held = 0;
    for (const m of this.heldMessages(state.epochId)) {
      if (this.isReleased(state, m)) continue;
      const ch = channelIdOf(m) ?? '(unknown channel)';
      const list = byChannel.get(ch) ?? [];
      list.push(m);
      byChannel.set(ch, list);
      held++;
    }

    const minutes = Math.max(1, Math.round((Date.now() - state.startedAtMs) / 60_000));
    const focusLabel = this.labelFor(state.serverId, state.channelId);
    const header =
      `[Focus ended — ${reason}. You were focused on ${focusLabel} for ~${minutes}m. ` +
      (held === 0
        ? 'Nothing was held.]'
        : `${held} message${held === 1 ? '' : 's'} held across ${byChannel.size} channel${byChannel.size === 1 ? '' : 's'}` +
          `${this.addressedCount > 0 ? `; ${this.addressedCount} addressed you and got the automatic reply` : ''}.]`);

    const dumps: string[] = [];
    // Most recently active channel last, so the freshest context is nearest
    // the resident's next turn.
    const ordered = [...byChannel.entries()].sort(
      (a, b) => a[1][a[1].length - 1]!.sequence - b[1][b[1].length - 1]!.sequence,
    );
    for (const [channelId, messages] of ordered) {
      const serverId = serverIdOf(messages[0]) ?? state.serverId;
      dumps.push(this.renderChannelDump(serverId, channelId, messages, state.backlogCap));
    }
    const truncatedAny = ordered.some(([, ms]) => ms.length > state.backlogCap);
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
      addressed: this.addressedCount,
    });
    this.autoReplied.clear();
    this.heldCount = 0;
    this.addressedCount = 0;
    return { ok: true, held };
  }

  // ==========================================================================
  // Ingestion: hold, stamp, autoreply
  // ==========================================================================

  /**
   * Consulted by the framework for every incoming channel/DM message BEFORE
   * storage. Null = not focused, or this IS the focus channel (proceed
   * normally). Otherwise the caller stamps `metadata.focusHeld` with the
   * returned object, stores the message, and wakes nobody.
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
    if (channelId === state.channelId) return null;

    this.heldCount++;
    const addressed = Array.isArray(tags) && tags.includes('chat:addressed');
    const stamp: HeldStamp = { epochId: state.epochId };
    if (!addressed) return stamp;

    this.addressedCount++;
    if (this.config.autoReply === false) return stamp;
    const key = this.replyKey(channelId, author?.id);
    if (key && this.autoReplied.has(key)) return stamp;
    if (key) this.autoReplied.add(key);
    stamp.autoReplied = true;
    void this.sendAutoReply(state, serverId, channelId, messageId);
    return stamp;
  }

  private replyKey(channelId: string, authorId: string | undefined | null): string | null {
    if (!channelId) return null;
    return `${channelId}\0${authorId ?? ''}`;
  }

  private async sendAutoReply(state: FocusParams, serverId: string, channelId: string, messageId: string): Promise<void> {
    const template = this.config.autoReplyTemplate ?? DEFAULT_AUTOREPLY;
    const remainingMin = Math.max(1, Math.round((state.expiresAtMs - Date.now()) / 60_000));
    const text = template
      .replaceAll('{name}', this.hooks.primaryName() ?? 'The agent')
      .replaceAll('{until}', this.untilText(state.expiresAtMs))
      .replaceAll('{remaining}', `${remainingMin}m`)
      .replaceAll('{channel}', this.labelFor(state.serverId, state.channelId));
    try {
      const result = await this.hooks.publish(channelId, text);
      if (!result.success) {
        this.hooks.emitTrace({ type: 'focus:autoreply-failed', serverId, channelId, messageId, error: result.error });
      } else {
        this.hooks.emitTrace({ type: 'focus:autoreply', serverId, channelId, messageId });
      }
    } catch (err) {
      this.hooks.emitTrace({ type: 'focus:autoreply-failed', serverId, channelId, messageId, error: (err as Error).message });
    }
  }

  // ==========================================================================
  // Check (status + peek)
  // ==========================================================================

  status(): {
    focused: boolean;
    channelId?: string;
    channel?: string;
    expiresAt?: string;
    remainingSeconds?: number;
    backlogCap?: number;
    held?: Array<{ channelId: string; channel: string; messages: number; addressed: number; latest: string }>;
  } {
    const state = this.getState();
    if (!state) return { focused: false };
    const byChannel = new Map<string, { serverId: string; messages: number; addressed: number; latest: string }>();
    for (const m of this.heldMessages(state.epochId)) {
      if (this.isReleased(state, m)) continue;
      const ch = channelIdOf(m) ?? '(unknown channel)';
      const entry = byChannel.get(ch) ?? { serverId: serverIdOf(m) ?? state.serverId, messages: 0, addressed: 0, latest: '' };
      entry.messages++;
      const tags = (m.metadata as Record<string, unknown> | undefined)?.tags;
      if (Array.isArray(tags) && tags.includes('chat:addressed')) entry.addressed++;
      entry.latest = this.clock(m.timestamp.getTime());
      byChannel.set(ch, entry);
    }
    return {
      focused: true,
      channelId: state.channelId,
      channel: this.labelFor(state.serverId, state.channelId),
      expiresAt: this.untilText(state.expiresAtMs),
      remainingSeconds: Math.max(0, Math.round((state.expiresAtMs - Date.now()) / 1000)),
      backlogCap: state.backlogCap,
      held: [...byChannel.entries()].map(([channelId, e]) => ({
        channelId,
        channel: this.labelFor(e.serverId, channelId),
        messages: e.messages,
        addressed: e.addressed,
        latest: e.latest,
      })),
    };
  }

  /** Newest `limit` held messages of one channel, rendered — without releasing them. */
  peek(channelId: string, limit?: number): { ok: true; text: string; total: number } | { ok: false; error: string } {
    const state = this.getState();
    if (!state) return { ok: false, error: 'not in focus mode' };
    const messages = this.heldMessages(state.epochId)
      .filter((m) => channelIdOf(m) === channelId && !this.isReleased(state, m));
    const serverId = serverIdOf(messages[0]) ?? state.serverId;
    const cap = Math.max(0, Math.floor(limit ?? state.backlogCap));
    return { ok: true, total: messages.length, text: this.renderChannelDump(serverId, channelId, messages, cap) };
  }

  // ==========================================================================
  // Tool dispatch (resident)
  // ==========================================================================

  handleTool(input: Record<string, unknown>): { success: boolean; data?: unknown; error?: string; isError?: boolean } {
    const mode = typeof input.mode === 'string' ? input.mode : 'enter';
    switch (mode) {
      case 'enter': {
        const channelId = String(input.channelId ?? '');
        if (!channelId) return { success: false, error: 'channelId is required to enter focus', isError: false };
        const r = this.enter(channelId, {
          durationSeconds: numberOrUndefined(input.durationSeconds),
          backlogCap: numberOrUndefined(input.backlogCap),
        }, 'agent-tool');
        if (!r.ok) return { success: false, error: r.error, isError: false };
        return {
          success: true,
          data: {
            focused: r.params.channelId,
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
        const p = this.peek(channelId, numberOrUndefined(input.limit));
        if (!p.ok) return { success: false, error: p.error, isError: false };
        return { success: true, data: { ...status, held: status.held?.filter((h) => h.channelId === channelId), peek: p.text } };
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

  private heldMessages(epochId: string): StoredMessage[] {
    return this.hooks.getStoredMessages().filter(
      (m) => (m.metadata as { focusHeld?: HeldStamp } | undefined)?.focusHeld?.epochId === epochId,
    );
  }

  private isReleased(state: FocusParams, m: StoredMessage): boolean {
    const ch = channelIdOf(m);
    if (!ch) return false;
    const through = state.released?.[ch];
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

  private renderChannelDump(serverId: string, channelId: string, messages: StoredMessage[], cap: number): string {
    const shown = cap > 0 ? messages.slice(-cap) : [];
    const truncated = messages.length - shown.length;
    const lines = shown.map((m) => {
      const md = m.metadata as Record<string, unknown> | undefined;
      const author = (md?.author as { name?: string } | undefined)?.name
        ?? (typeof md?.authorName === 'string' && md.authorName ? md.authorName : undefined)
        ?? m.participant;
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return `[${this.clock(m.timestamp.getTime())}] ${author}: ${text}`;
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

function channelIdOf(m: StoredMessage): string | undefined {
  const v = (m.metadata as Record<string, unknown> | undefined)?.channelId;
  return typeof v === 'string' && v ? v : undefined;
}

function serverIdOf(m: StoredMessage | undefined): string | undefined {
  const v = (m?.metadata as Record<string, unknown> | undefined)?.serverId;
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
