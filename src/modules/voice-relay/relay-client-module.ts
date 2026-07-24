/**
 * RelayClientModule — the outbound half of voice integration.
 *
 * Connects framework agents TO an external melodeus TTS relay, holding the
 * same kind of connection the relay's existing bots do (the "ChapterX"
 * bots the relay was originally built to serve): dials `{url}/bot` as a
 * WebSocket client, authenticates as one bot identity, and streams the
 * agent's turn up the socket as relay messages (activation_start /
 * block_start / chunk / block_complete / activation_end, translated from
 * inference:* traces by InferenceTraceBridge). Interruptions arriving from
 * the relay are mapped to `framework.abortInference(agentName, { reason,
 * keepText })`, so an interrupted agent's context and posted message keep
 * the words the voice client reported spoken (reports are as precise as the
 * client's own audio accounting — some clients count text dispatched to
 * TTS, not audio actually played).
 *
 * Usage:
 *   const relay = new RelayClientModule({ url, botId, token });
 *   relay.bind(framework);   // REQUIRED for interruptions: without it,
 *                            // outbound streaming still works but relay
 *                            // interruptions are dropped with a warning
 *   await framework.addModule(relay);
 *
 * One module instance = one bot identity on the relay (matching the relay's
 * one-bot-per-connection model). By default an instance streams EVERY
 * channel-bearing agent in the process under its one identity; a host
 * voicing several agents under distinct relay identities registers several
 * instances, each scoped to its own agents with `agents`. If a second
 * connection authenticates with the same botId, the relay closes this one
 * with "Replaced by new connection" — treated as fatal (no reconnect),
 * because two instances sharing an identity would otherwise evict each
 * other forever.
 *
 * Interruption addressing: an interruption names a channel; it aborts the
 * agent last seen streaming there — unless that agent has meanwhile moved
 * on to a turn somewhere else (another channel, or a channel-less run), in
 * which case the report describes the earlier, finished turn and is
 * dropped. A channel we never streamed to is dropped. An interruption with
 * no channel at all is accepted only when exactly one channel is tracked
 * (nothing else it could mean). Before aborting, the reported spokenText
 * must prefix-match the current utterance's streamed text — voice lags
 * text, so a report that does not match describes an EARLIER utterance and
 * must not cut off the new turn. Voice clients differ in what they report
 * (melodeus resets its spoken-text accumulator at every block_start; the
 * iOS client accumulates the whole activation), so a match against either
 * window is accepted, and characters clients normalize away (whitespace,
 * narrator `*` markup) are ignored. A non-empty report while the current
 * utterance has voiced nothing yet is stale by the same logic. Reports
 * without spokenText are allowed through: absence of evidence is not
 * staleness. Deployment note: iOS prefixes "<name> says:" to speech from
 * bots with no configured voice — that prefix fails verification, so give
 * this bot a voice entry in the relay config (or disable announcements)
 * for interruptions to land.
 *
 * Delivery semantics mirror the relay's: no queueing — messages produced
 * while the socket is down are dropped (the relay drops for disconnected
 * consumers too). Reconnects use exponential backoff and re-authenticate;
 * the backoff resets only after a connection has stayed authenticated for a
 * stability window, so an auth-then-drop loop cannot hammer the relay. The
 * relay heartbeats every connection every ~2s; when nothing at all arrives
 * for heartbeatTimeoutMs the link is presumed half-open and torn down so
 * the reconnect path can recover it.
 */

import WebSocket from 'ws';

import type { AgentFramework } from '../../framework.js';
import type { TraceEvent } from '../../types/trace.js';
import type { ModuleContext, Module, ProcessState, EventResponse } from '../../types/module.js';
import type { ProcessEvent, ToolCall, ToolResult, ToolDefinition } from '../../types/events.js';
import type { BotStreamMessage, RelayLogger } from './types.js';
import { InferenceTraceBridge, type TraceBridge } from './trace-bridge.js';
import { isWhitespaceInsensitivePrefix } from '../../prose-segments.js';

export interface RelayClientModuleConfig {
  /** Relay base URL, e.g. "ws://localhost:8800" — "/bot" is appended. */
  url: string;
  /** Bot identity on the relay (must be authorized by the relay's BOT_TOKENS). */
  botId: string;
  token: string;
  /** Display identity stamped on outgoing relay messages (defaults to botId).
   *  Supply a real Discord user id here if Discord-side features (mention
   *  resolution) should work; a framework agent has none of its own. */
  userId?: string;
  username?: string;
  /** Only stream (and address interruptions for) these agents. Default: all
   *  agents in the process. Set this when several instances with distinct
   *  bot identities run in one process, each voicing its own agents. */
  agents?: string[];
  /** First reconnect delay; doubles per attempt. Default 1000ms. */
  reconnectInitialMs?: number;
  /** Backoff cap. Default 30000ms. */
  reconnectMaxMs?: number;
  /** How long a connection must stay authenticated before the backoff
   *  resets to its initial value. Default 10000ms. */
  backoffResetAfterMs?: number;
  /** Tear the connection down (and reconnect) when NOTHING has arrived for
   *  this long — the relay heartbeats every ~2s, so silence means a
   *  half-open link that would otherwise swallow turns until the OS
   *  timeout. Default 8000ms; 0 disables. */
  heartbeatTimeoutMs?: number;
  logger?: RelayLogger;
}

/** Default logger: console-backed for info and above (RelayLogger's
 *  documented default), so the permanent failure modes — auth rejection,
 *  the replaced-connection stop — are visible without configuration.
 *  debug is dropped (per-message noise); inject a logger to capture it. */
const consoleLogger: RelayLogger = {
  debug() {},
  info(msg, data) {
    console.log(`[relay-client] ${msg}`, data ?? '');
  },
  warn(msg, data) {
    console.warn(`[relay-client] ${msg}`, data ?? '');
  },
  error(msg, data) {
    console.error(`[relay-client] ${msg}`, data ?? '');
  },
};

/** Upper bound on remembered channels (interruption addressing + spoken-text
 *  matching). Insertion-ordered; the oldest entry is evicted first. 256 is
 *  far above any real deployment's simultaneous voice channels — the bound
 *  exists so a long-lived process touching many channels cannot grow the
 *  maps without limit. */
const MAX_TRACKED_CHANNELS = 256;

/** Inbound frame cap. Everything the relay legitimately sends a bot —
 *  auth_ok, heartbeats, interruptions — is tiny; ws's 100 MiB default would
 *  let a misbehaving relay force huge single allocations. */
const MAX_INBOUND_PAYLOAD_BYTES = 1024 * 1024;

/** Outbound send-buffer cap. Messages are best-effort already (dropped when
 *  the socket is down), so a relay that stops reading must not grow the
 *  buffer without bound either — past this, drop instead of enqueueing. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;

  private bridge: TraceBridge | null = null;
  private unsubscribeTracker: (() => void) | null = null;

  /** Agents this instance streams; null = all agents in the process. */
  private readonly agentSet: Set<string> | null;

  /**
   * channelId → agentName of the last agent seen streaming there. Entries
   * deliberately survive the turn's end: a voice interruption can arrive
   * moments after our terminal trace (speech lags text), and abortInference
   * no-ops safely on an idle agent while the name still resolves. Bounded at
   * MAX_TRACKED_CHANNELS, oldest evicted first.
   */
  private readonly activeAgentByChannel = new Map<string, string>();

  /**
   * agentName → channel of the turn the agent is streaming RIGHT NOW (null
   * for a channel-less run; set on inference:started, cleared on the
   * terminal traces). Guards interruption addressing: a late report for a
   * channel the agent already left must not abort the unrelated turn it is
   * running elsewhere.
   */
  private readonly activeChannelByAgent = new Map<string, string | null>();

  /**
   * channelId → visible text sent to the relay for the current utterance,
   * tracked over two windows: `block` (since the channel's last
   * block_start) and `activation` (since its last activation_start).
   * Interruptions must prefix-match one of them or be dropped as stale —
   * melodeus reports spokenText per block, the iOS client per activation.
   * Only messages actually sent count — text dropped while the socket was
   * down never reached a client. Pruned together with activeAgentByChannel.
   */
  private readonly streamedText = new Map<string, { activation: string; block: string }>();

  constructor(config: RelayClientModuleConfig) {
    this.config = config;
    this.logger = config.logger ?? consoleLogger;
    this.name = `relay-client:${config.botId}`;
    this.reconnectDelayMs = config.reconnectInitialMs ?? 1000;
    this.agentSet = config.agents ? new Set(config.agents) : null;
  }

  /** Wire the framework handle (HealthModule pattern; store not needed). */
  bind(framework: AgentFramework): void {
    this.framework = framework;
  }

  // ── Module lifecycle ─────────────────────────────────────────────────────

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.shouldRun = true;
    // A restarted module begins at the backoff floor, not wherever a
    // previous incarnation's failures left it.
    this.reconnectDelayMs = this.config.reconnectInitialMs ?? 1000;

    // Interruption addressing: remember which agent last streamed per
    // channel, and which channel each agent is streaming right now.
    // Subscribed BEFORE the bridge so tracking is in place by the time the
    // bridge's messages for the same trace reach sendToRelay (whose
    // spoken-text accumulation is gated on the channel being tracked).
    this.unsubscribeTracker = ctx.onTrace((event: TraceEvent) => {
      const agentName = (event as { agentName?: string }).agentName;
      if (!agentName || (this.agentSet && !this.agentSet.has(agentName))) return;
      if (event.type === 'inference:started') {
        if (event.channelId) this.trackChannel(event.channelId, agentName);
        this.activeChannelByAgent.set(agentName, event.channelId ?? null);
      } else if (
        event.type === 'inference:completed' ||
        event.type === 'inference:turn_ended' ||
        event.type === 'inference:aborted' ||
        event.type === 'inference:failed' ||
        event.type === 'inference:exhausted'
      ) {
        this.activeChannelByAgent.delete(agentName);
      }
    });

    // Identity is overridden to THIS connection's bot: the relay rejects any
    // message whose botId differs from the identity the connection
    // authenticated as.
    this.bridge = new InferenceTraceBridge(
      (msg) => this.sendToRelay(msg),
      () => ({
        botId: this.config.botId,
        userId: this.config.userId ?? this.config.botId,
        username: this.config.username ?? this.config.botId,
      }),
      this.logger,
      this.agentSet ? (name) => this.agentSet!.has(name) : undefined,
    );
    this.bridge.start(ctx);

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
    this.stopWatchdog();
    this.teardownSubscriptions();
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'module stopped');
    else ws?.terminate();
  }

  /** Unsubscribe from the trace bus and drop the tracking maps. Shared by
   *  stop() and the fatal replaced-connection path: a permanently-down
   *  module must not keep translating every turn into sends that go
   *  nowhere. */
  private teardownSubscriptions(): void {
    this.bridge?.stop();
    this.bridge = null;
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
    this.activeAgentByChannel.clear();
    this.activeChannelByAgent.clear();
    this.streamedText.clear();
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
      this.streamedText.delete(oldest);
    }
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private connect(): void {
    if (!this.shouldRun) return;

    const url = `${this.config.url.replace(/\/$/, '')}/bot`;
    this.logger.info('Relay client connecting', { url, botId: this.config.botId });
    // handshakeTimeout: the watchdog only arms on 'open', so a host that
    // accepts TCP but stalls the WebSocket upgrade would otherwise hang the
    // module in CONNECTING forever (ws has no default handshake deadline).
    const ws = new WebSocket(url, {
      maxPayload: MAX_INBOUND_PAYLOAD_BYTES,
      handshakeTimeout: 10_000,
    });
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
      this.lastInboundAt = Date.now();
      this.startWatchdog(ws);
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      // Any inbound frame proves the link is alive, malformed or not.
      this.lastInboundAt = Date.now();
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          this.logger.warn('Relay client: non-object message dropped');
          return;
        }
        msg = parsed as Record<string, unknown>;
      } catch {
        this.logger.warn('Relay client: non-JSON message dropped');
        return;
      }
      // Contained: handleMessage reaches framework code (abortInference);
      // a throw there must not escape the socket listener and kill the
      // process.
      try {
        this.handleMessage(msg);
      } catch (error) {
        this.logger.error('Relay client: message handling failed', {
          type: msg.type,
          error: String(error),
        });
      }
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      this.stopWatchdog();
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
        this.teardownSubscriptions();
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
    // ±20% jitter: several instances dropped by one relay restart must not
    // re-dial in lockstep.
    const delay = Math.round(this.reconnectDelayMs * (0.8 + Math.random() * 0.4));
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

  /** Presume the link dead when nothing has arrived for heartbeatTimeoutMs
   *  (the relay heartbeats every connection every ~2s) and terminate it, so
   *  the normal 'close' → reconnect path recovers a half-open TCP link —
   *  or a server that accepted the socket but never answers — instead of
   *  streaming into the void until the OS timeout. */
  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    const timeoutMs = this.config.heartbeatTimeoutMs ?? 8_000;
    if (timeoutMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      if (this.ws !== ws) {
        this.stopWatchdog();
        return;
      }
      if (Date.now() - this.lastInboundAt > timeoutMs) {
        this.logger.warn('Relay link presumed dead (nothing received within the heartbeat timeout)', {
          timeoutMs,
        });
        this.stopWatchdog();
        ws.terminate(); // 'close' follows and schedules the reconnect
      }
    }, Math.max(250, Math.min(timeoutMs / 2, 2_000)));
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'auth_ok': {
        if (this.authed) return; // duplicate; must not re-arm the stability timer
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
        // authed is dropped defensively in case a nonconforming relay keeps
        // the socket open — streaming into an unauthenticated connection
        // would be silently discarded server-side.
        this.authed = false;
        this.logger.error('Relay client auth rejected', { error: msg.error });
        return;

      case 'heartbeat':
        return;

      case 'interruption': {
        const channelId = typeof msg.channelId === 'string' ? msg.channelId : undefined;
        const spokenText = typeof msg.spokenText === 'string' ? msg.spokenText : '';
        // Protocol enum; anything else is coerced so an arbitrary string
        // cannot flow into traces and logs verbatim.
        const reason =
          msg.reason === 'manual' || msg.reason === 'timeout' ? msg.reason : 'user_speech';
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

    // A late report can outlive its turn (speech lags text): the channel
    // still resolves the agent, but if that agent is now mid-turn somewhere
    // ELSE — another channel, or a channel-less run — the report describes
    // the earlier, finished turn, and aborting would kill the unrelated one.
    const activeChannel = this.activeChannelByAgent.get(agentName);
    if (activeChannel !== undefined && matchChannel && activeChannel !== matchChannel) {
      this.logger.warn('Interruption for a finished turn dropped (agent is now active elsewhere)', {
        channelId: matchChannel,
        agentName,
        activeChannel: activeChannel ?? '(channel-less)',
      });
      return;
    }

    // Staleness guard: the client voices a prefix of what we streamed, so a
    // spokenText that does not prefix-match the current utterance describes
    // an EARLIER utterance (its report raced the next turn) and must not
    // abort the new one. Clients differ in their report window — melodeus
    // resets per block_start, the iOS client accumulates the whole
    // activation — so a match against either window is accepted. Empty
    // spokenText carries no staleness evidence and is allowed. An empty
    // accumulator (nothing streamed yet on this connection — module
    // restart, or the turn is still inside a thinking/tool block) cannot
    // convict either, but then the report is UNVERIFIABLE: the abort goes
    // through WITHOUT keepText, because text we cannot match against what
    // we actually streamed must never be committed as words the agent said.
    let verifiedSpokenText: string | undefined;
    if (spokenText) {
      const streamed = matchChannel ? this.streamedText.get(matchChannel) : undefined;
      if (streamed && (streamed.activation.length > 0 || streamed.block.length > 0)) {
        if (
          !isWhitespaceInsensitivePrefix(spokenText, streamed.block) &&
          !isWhitespaceInsensitivePrefix(spokenText, streamed.activation)
        ) {
          this.logger.warn('Stale interruption dropped (spokenText does not match the current utterance)', {
            channelId: matchChannel,
            agentName,
            spokenChars: spokenText.length,
            streamedChars: streamed.activation.length,
          });
          return;
        }
        verifiedSpokenText = spokenText;
      } else if (streamed) {
        // Entry present but both windows empty: we SAW this utterance's
        // activation_start on this connection and streamed no visible text
        // yet (thinking / pre-first-token). Real clients never report
        // non-empty spokenText for an utterance that voiced nothing, so
        // this report describes the PREVIOUS utterance (voice lag) and must
        // not cut off the new turn.
        this.logger.warn('Stale interruption dropped (current utterance has voiced nothing yet)', {
          channelId: matchChannel,
          agentName,
          spokenChars: spokenText.length,
        });
        return;
      } else {
        // No entry at all: we connected mid-turn (or the channel was
        // evicted), so the report is genuinely unverifiable. The abort goes
        // through, but text we cannot match against what we streamed must
        // never be committed as words the agent said.
        this.logger.warn('Interruption spokenText unverifiable (nothing streamed on this connection) — aborting without keepText', {
          channelId: matchChannel,
          agentName,
          spokenChars: spokenText.length,
        });
      }
    }

    const aborted = this.framework.abortInference(agentName, {
      reason,
      keepText: verifiedSpokenText,
    });
    this.logger.info('Interruption relayed to framework', {
      agentName,
      channelId,
      aborted,
      spokenChars: spokenText.length,
    });
  }

  /** Send one message to the relay; drop it if the socket is down or its
   *  send buffer is full (delivery is best-effort by design). */
  private sendToRelay(msg: BotStreamMessage): void {
    const ws = this.ws;
    if (!this.authed || !ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.debug('Relay message dropped (relay not connected)', { type: msg.type });
      return;
    }
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.logger.debug('Relay message dropped (send buffer full)', {
        type: msg.type,
        buffered: ws.bufferedAmount,
      });
      return;
    }
    ws.send(JSON.stringify(msg));

    // Track what a voice client could have voiced from the current
    // utterance (the staleness guard's reference), over both report windows
    // — see streamedText. Only visible chunk text counts: thinking and tool
    // content is never voiced. Gated on the channel still being tracked so
    // a channel evicted mid-flight cannot re-enter this map and escape the
    // shared MAX_TRACKED_CHANNELS bound (the tracker subscribes before the
    // bridge, so on a fresh turn tracking is already in place here).
    if (!this.activeAgentByChannel.has(msg.channelId)) return;
    if (msg.type === 'activation_start') {
      this.streamedText.set(msg.channelId, { activation: '', block: '' });
    } else if (msg.type === 'block_start') {
      const entry = this.streamedText.get(msg.channelId);
      if (entry) entry.block = '';
      else this.streamedText.set(msg.channelId, { activation: '', block: '' });
    } else if (msg.type === 'chunk' && msg.visible) {
      // Missing entry = we connected mid-turn; both windows start at the
      // first chunk that actually traversed this connection.
      const entry = this.streamedText.get(msg.channelId) ?? { activation: '', block: '' };
      entry.activation += msg.text;
      entry.block += msg.text;
      this.streamedText.set(msg.channelId, entry);
    }
  }
}
