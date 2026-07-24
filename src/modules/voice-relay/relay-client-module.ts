/**
 * RelayClientModule — the outbound half of voice integration.
 *
 * Connects framework agents TO an external melodeus TTS relay, exactly as
 * ChapterX bots do: dials `{url}/bot` as a WebSocket client, authenticates
 * as one bot identity, and streams the agent's turn up the socket as relay
 * messages (activation_start / block_start / chunk / block_complete /
 * activation_end, translated from inference:* traces by
 * InferenceTraceBridge). Interruptions arriving from the relay are mapped to
 * `framework.abortInference(agentName, { reason, keepText })`, so an
 * interrupted agent's context and posted message keep exactly the words a
 * voice client actually spoke.
 *
 * One module instance = one bot identity on the relay (matching ChapterX:
 * one bot per connection). A host voicing several agents under distinct
 * relay identities registers several instances. If a second connection
 * authenticates with the same botId, the relay closes this one with
 * "Replaced by new connection" — treated as fatal (no reconnect), because
 * two instances sharing an identity would otherwise evict each other
 * forever.
 *
 * Interruption addressing: an interruption names a channel; it aborts the
 * agent last seen streaming there. A channel we never streamed to is
 * dropped. An interruption with no channel at all is accepted only when
 * exactly one agent is tracked (nothing else it could mean). Before
 * aborting, the reported spokenText must prefix-match the text streamed
 * since that channel's last block_start — voice lags text, so a report that
 * does not match the current utterance describes an EARLIER one and must
 * not cut off the new turn. Reports without spokenText are allowed through:
 * absence of evidence is not staleness.
 *
 * Delivery semantics mirror the relay's: no queueing — messages produced
 * while the socket is down are dropped (the relay drops for disconnected
 * consumers too). Reconnects use exponential backoff and re-authenticate;
 * the backoff resets only after a connection has stayed authenticated for a
 * stability window, so an auth-then-drop loop cannot hammer the relay.
 */

import WebSocket from 'ws';

import type { AgentFramework } from '../../framework.js';
import type { TraceEvent } from '../../types/trace.js';
import type { ModuleContext, Module, ProcessState, EventResponse } from '../../types/module.js';
import type { ProcessEvent, ToolCall, ToolResult, ToolDefinition } from '../../types/events.js';
import type { RelayLogger, RelayToVoiceClientMessage } from './types.js';
import { InferenceTraceBridge, type TraceBridge } from './trace-bridge.js';
import { isWhitespaceInsensitivePrefix } from '../../prose-segments.js';

export interface RelayClientModuleConfig {
  /** Relay base URL, e.g. "ws://localhost:8800" — "/bot" is appended. */
  url: string;
  /** Bot identity on the relay (must be authorized by the relay's BOT_TOKENS). */
  botId: string;
  token: string;
  /** Display identity stamped on outgoing relay messages (defaults to botId). */
  userId?: string;
  username?: string;
  /** First reconnect delay; doubles per attempt. Default 1000ms. */
  reconnectInitialMs?: number;
  /** Backoff cap. Default 30000ms. */
  reconnectMaxMs?: number;
  /** How long a connection must stay authenticated before the backoff
   *  resets to its initial value. Default 10000ms. */
  backoffResetAfterMs?: number;
  logger?: RelayLogger;
}

const noopLogger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Upper bound on remembered channels (interruption addressing + spoken-text
 *  matching). Insertion-ordered; the oldest entry is evicted first. 256 is
 *  far above any real deployment's simultaneous voice channels — the bound
 *  exists so a long-lived process touching many channels cannot grow the
 *  maps without limit. */
const MAX_TRACKED_CHANNELS = 256;

export class RelayClientModule implements Module {
  readonly name: string;

  private readonly config: RelayClientModuleConfig;
  private readonly logger: RelayLogger;

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;

  private ws: WebSocket | null = null;
  private authed = false;
  private shouldRun = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  private bridge: TraceBridge | null = null;
  private unsubscribeTracker: (() => void) | null = null;

  /**
   * channelId → agentName of the last agent seen streaming there. Entries
   * deliberately survive the turn's end: a voice interruption can arrive
   * moments after our terminal trace (speech lags text), and abortInference
   * no-ops safely on an idle agent while the name still resolves. Bounded at
   * MAX_TRACKED_CHANNELS, oldest evicted first.
   */
  private readonly activeAgentByChannel = new Map<string, string>();

  /**
   * channelId → visible text sent to the relay since that channel's last
   * block_start (reset again on activation_start). This is what a voice
   * client could have voiced from the current utterance; interruptions must
   * prefix-match it or be dropped as stale. Only messages actually sent
   * count — text dropped while the socket was down never reached a client.
   * Pruned together with activeAgentByChannel.
   */
  private readonly streamedBlockText = new Map<string, string>();

  constructor(config: RelayClientModuleConfig) {
    this.config = config;
    this.logger = config.logger ?? noopLogger;
    this.name = `relay-client:${config.botId}`;
    this.reconnectDelayMs = config.reconnectInitialMs ?? 1000;
  }

  /** Wire the framework handle (HealthModule pattern; store not needed). */
  bind(framework: AgentFramework): void {
    this.framework = framework;
  }

  // ── Module lifecycle ─────────────────────────────────────────────────────

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.shouldRun = true;

    // Identity is overridden to THIS connection's bot: the relay rejects any
    // message whose botId differs from the identity the connection
    // authenticated as.
    this.bridge = new InferenceTraceBridge(
      (_channelId, msg) => this.sendToRelay(msg),
      () => ({
        botId: this.config.botId,
        userId: this.config.userId ?? this.config.botId,
        username: this.config.username ?? this.config.botId,
      }),
      this.logger,
    );
    this.bridge.start(ctx);

    // Interruption addressing: remember which agent last streamed per channel.
    this.unsubscribeTracker = ctx.onTrace((event: TraceEvent) => {
      if (event.type === 'inference:started' && event.channelId) {
        this.trackChannel(event.channelId, event.agentName);
      }
    });

    this.connect();
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.bridge?.stop();
    this.bridge = null;
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
    this.activeAgentByChannel.clear();
    this.streamedBlockText.clear();
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'module stopped');
    else ws?.terminate();
  }

  getTools(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'relay-client has no tools', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** @internal exposed for tests */
  get isConnected(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** @internal exposed for tests */
  get trackedChannelCount(): number {
    return this.activeAgentByChannel.size;
  }

  /** @internal exposed for tests */
  get currentReconnectDelayMs(): number {
    return this.reconnectDelayMs;
  }

  // ── Channel tracking ─────────────────────────────────────────────────────

  private trackChannel(channelId: string, agentName: string): void {
    // Delete-then-set moves a re-seen channel to the back of the insertion
    // order, so eviction removes the genuinely least-recently-streamed one.
    this.activeAgentByChannel.delete(channelId);
    this.activeAgentByChannel.set(channelId, agentName);
    while (this.activeAgentByChannel.size > MAX_TRACKED_CHANNELS) {
      const oldest = this.activeAgentByChannel.keys().next().value as string;
      this.activeAgentByChannel.delete(oldest);
      this.streamedBlockText.delete(oldest);
    }
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private connect(): void {
    if (!this.shouldRun) return;

    const url = `${this.config.url.replace(/\/$/, '')}/bot`;
    this.logger.info('Relay client connecting', { url, botId: this.config.botId });
    const ws = new WebSocket(url);
    this.ws = ws;
    this.authed = false;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      const auth: Record<string, unknown> = {
        type: 'auth',
        botId: this.config.botId,
        token: this.config.token,
      };
      if (this.config.userId) auth.userId = this.config.userId;
      if (this.config.username) auth.username = this.config.username;
      ws.send(JSON.stringify(auth));
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        this.logger.warn('Relay client: non-JSON message dropped');
        return;
      }
      this.handleMessage(msg);
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      if (!this.shouldRun) return;
      const reasonText = reason.toString();
      if (code === 1000 && /replaced/i.test(reasonText)) {
        // The relay replaced this connection: another client authenticated
        // with the same botId. Reconnecting would evict THAT client, which
        // would reconnect and evict us — forever. Stay down; a duplicate
        // identity is a configuration error, not an outage.
        this.logger.error(
          'Relay replaced this connection — another client is using the same bot identity; not reconnecting',
          { botId: this.config.botId, reason: reasonText },
        );
        this.shouldRun = false;
        return;
      }
      this.logger.warn('Relay client disconnected', { code, reason: reasonText });
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      if (this.ws !== ws) return;
      this.logger.warn('Relay client socket error', { error: String(error) });
      // 'close' follows and drives the reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.config.reconnectMaxMs ?? 30_000,
    );
    this.logger.info('Relay client reconnecting', { inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'auth_ok': {
        this.authed = true;
        this.logger.info('Relay client authenticated', { botId: this.config.botId });
        // Reset the backoff only after the connection proves stable. An
        // immediate reset would let an auth-then-drop loop retry at the
        // floor forever, defeating the backoff.
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          if (this.isConnected) {
            this.reconnectDelayMs = this.config.reconnectInitialMs ?? 1000;
          }
        }, this.config.backoffResetAfterMs ?? 10_000);
        return;
      }

      case 'auth_error':
        // Bad credentials won't heal by retrying fast; keep the backoff
        // growing (the relay closes the socket after this, driving 'close').
        this.logger.error('Relay client auth rejected', { error: msg.error });
        return;

      case 'heartbeat':
        return;

      case 'interruption': {
        const channelId = typeof msg.channelId === 'string' ? msg.channelId : undefined;
        const spokenText = typeof msg.spokenText === 'string' ? msg.spokenText : '';
        const reason = typeof msg.reason === 'string' ? msg.reason : 'user_speech';
        this.handleInterruption(channelId, spokenText, reason);
        return;
      }

      default:
        this.logger.debug('Relay client: unhandled message type', { type: msg.type });
    }
  }

  private handleInterruption(channelId: string | undefined, spokenText: string, reason: string): void {
    if (!this.framework) {
      this.logger.warn('Interruption received but framework not bound — dropped');
      return;
    }

    // Resolve the target agent. A named channel must be one we streamed to;
    // guessing on an unknown channel could abort an unrelated agent. Only a
    // channel-LESS interruption may fall back to the single tracked agent —
    // with one candidate there is nothing else it could mean.
    let agentName: string | undefined;
    let matchChannel = channelId;
    if (channelId) {
      agentName = this.activeAgentByChannel.get(channelId);
      if (!agentName) {
        this.logger.warn('Interruption for unknown channel dropped', { channelId });
        return;
      }
    } else if (this.activeAgentByChannel.size === 1) {
      const [only] = this.activeAgentByChannel.entries();
      matchChannel = only[0];
      agentName = only[1];
    }
    if (!agentName) {
      this.logger.warn('Interruption without channel and no single candidate — dropped', {
        trackedChannels: this.activeAgentByChannel.size,
      });
      return;
    }

    // Staleness guard: the client voices a prefix of what we streamed, so a
    // spokenText that does not prefix-match the current utterance describes
    // an EARLIER utterance (its report raced the next turn) and must not
    // abort the new one. Empty spokenText carries no staleness evidence and
    // is allowed. An empty accumulator (nothing streamed yet on this
    // connection) likewise cannot convict — module restarts lose it.
    if (spokenText) {
      const streamed = matchChannel ? this.streamedBlockText.get(matchChannel) ?? '' : '';
      if (streamed && !isWhitespaceInsensitivePrefix(spokenText, streamed)) {
        this.logger.warn('Stale interruption dropped (spokenText does not match the current utterance)', {
          channelId: matchChannel,
          agentName,
          spokenChars: spokenText.length,
          streamedChars: streamed.length,
        });
        return;
      }
    }

    const aborted = this.framework.abortInference(agentName, {
      reason,
      keepText: spokenText || undefined,
    });
    this.logger.info('Interruption relayed to framework', {
      agentName,
      channelId,
      aborted,
      spokenChars: spokenText.length,
    });
  }

  /** Send one message to the relay; drop it if the socket is down. */
  private sendToRelay(msg: RelayToVoiceClientMessage): void {
    const ws = this.ws;
    if (!this.authed || !ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.debug('Relay message dropped (relay not connected)', { type: msg.type });
      return;
    }
    ws.send(JSON.stringify(msg));

    // Track what a voice client could have voiced from the current
    // utterance (the staleness guard's reference). Reset at utterance
    // boundaries; accumulate only visible chunk text — thinking and tool
    // content is never voiced.
    if (msg.type === 'activation_start' || msg.type === 'block_start') {
      this.streamedBlockText.set(msg.channelId, '');
    } else if (msg.type === 'chunk' && msg.visible) {
      this.streamedBlockText.set(
        msg.channelId,
        (this.streamedBlockText.get(msg.channelId) ?? '') + msg.text,
      );
    }
  }
}
