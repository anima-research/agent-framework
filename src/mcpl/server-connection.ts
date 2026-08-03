/**
 * McplServerConnection — manages a single JSON-RPC 2.0 connection to an MCPL server.
 *
 * Connects over a pluggable {@link McplTransport} (a spawned stdio child OR a
 * WebSocket), performs the MCP initialize handshake with MCPL capability
 * negotiation, and provides typed methods for all outbound MCPL messages plus
 * EventEmitter events for inbound messages. The handshake, message routing, and
 * every send path are transport-agnostic — they operate on NDJSON lines, so
 * stdio and WebSocket behave identically above the transport seam.
 */

import { EventEmitter } from 'node:events';

import { openTransport, type McplTransport, type TransportCloseInfo } from './transport.js';
import { maskNegotiatedCapabilities } from './capability-mask.js';
import { CapabilityGrant, expandAdvertisementShorthand } from './capability-grant.js';
import { CAPABILITY_DISABLED } from './errors.js';

import type {
  McplServerConfig,
  McplCapabilities,
  McplHostCapabilities,
  JsonRpcRequest,
  JsonRpcResponse,
  BeforeInferenceParams,
  BeforeInferenceResult,
  AfterInferenceParams,
  AfterInferenceResult,
  FeatureSetsUpdateParams,
  FeatureSetsUpdateResult,
  InferenceChunkParams,
  InferenceLifecycleParams,
  StateRollbackParams,
  StateRollbackResult,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsAcknowledgeParams,
  ChannelsAcknowledgeResult,
  ChannelsListResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
  McpToolDefinition,
  McpToolCallResult,
} from './types.js';

import { McplMethod } from './types.js';

/** Timeout for the initialize handshake in milliseconds.
 *  Spring Boot + JDA servers can take 5-10s to boot, so 30s is safe. */
const INITIALIZE_TIMEOUT_MS = 30_000;

/** Default per-request timeout in milliseconds (see McplServerConfig.requestTimeoutMs).
 *  A live-but-wedged server (accepts requests, never answers, never closes its
 *  transport) would otherwise freeze the awaiting agent turn forever — no
 *  endTurn, no further wakes, zero errors anywhere. 60s is generous for real
 *  tool work while still bounding the hang. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** MCP protocol version used in the initialize handshake. */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Represents a pending JSON-RPC request awaiting a response.
 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  /** Per-request timeout timer; cleared on response/close/timeout. */
  timer?: ReturnType<typeof setTimeout>;
}

interface RequestOptions {
  /** Override the connection-wide timeout for this request only. */
  timeoutMs?: number;
  /** Surface a late response even when it carries no checkpoint state. */
  surfaceOrphanedResponse?: boolean;
}

/**
 * McplServerConnection manages a single JSON-RPC 2.0 connection to an
 * MCPL server over stdio. Use the static `connect()` factory to create
 * and initialize a connection.
 *
 * Events emitted:
 * - `'push-event'`        — Server sent `push/event`
 * - `'inference-request'`  — Server sent `inference/request`
 * - `'scope-elevate'`      — Server sent `scope/elevate`
 * - `'channels-register'`  — Server sent `channels/register`
 * - `'channels-changed'`   — Server sent `channels/changed`
 * - `'channels-incoming'`  — Server sent `channels/incoming`
 * - `'error'`              — Connection-level error
 * - `'close'`              — Connection closed
 * - `'connect-failed'`     — Initial connect failed; background retry scheduled
 * - `'reconnect-failed'`   — A background reconnect attempt failed; next retry scheduled
 * - `'reconnect'`          — Background reconnect succeeded
 */
export class McplServerConnection extends EventEmitter {
  /** Unique server identifier from config. */
  readonly id: string;

  /** MCPL capabilities negotiated during the initialize handshake — after
   *  host-side capability scoping (enabledCapabilities/disabledCapabilities)
   *  — or null if the server does not support MCPL. */
  capabilities: McplCapabilities | null;

  /** Dotted paths of advertised capabilities the host config masked at the
   *  last handshake (empty when no scoping is configured). Inbound methods
   *  gated by a masked capability are rejected in setupMessageRouting. */
  droppedCapabilities: ReadonlySet<string> = new Set();

  /** OUTER standard MCP capabilities.tools was present at handshake (§5.1 —
   *  the sole source of the `tools` capability path). */
  mcpToolsAdvertised = false;

  /** Host-owned per-server authority for host/command (config
   *  allowHostCommands, default false). No capability path exists and the
   *  grant cannot confer it — server params never decide admin authority. */
  allowHostCommands = false;

  /**
   * The effective capability grant (§5.4) — the sole authorization
   * allowlist for this connection. Starts EMPTY: until the initial policy
   * exchange completes (§5.3) nothing is granted and every privileged
   * inbound method is rejected. The framework computes the grant from the
   * masked advertisement and activates it via establishGrant() only after
   * the featureSets/update Request is answered (expansion activates on
   * receipt, §6.7); revocations re-call establishGrant() BEFORE the
   * corresponding Request is sent (reduction applies first, §6.7).
   */
  grant: CapabilityGrant = CapabilityGrant.empty();

  /** True once the §5.3 initial policy Request has been answered. */
  policyEstablished = false;

  /**
   * Activate (or replace) the effective grant. Ordering is the caller's
   * contract per §6.7: call BEFORE sending a reducing featureSets/update,
   * AFTER the receipt for an expanding one.
   */
  establishGrant(grant: CapabilityGrant): void {
    this.grant = grant;
    this.policyEstablished = true;
  }

  /** The active transport (stdio child or WebSocket). Null for a disconnected
   *  stub awaiting its first background reconnect. */
  private transport: McplTransport | null;

  /** Whether the connection currently has a live transport. False for closed
   *  connections and disconnected reconnect-stubs awaiting a retry. */
  get isConnected(): boolean {
    return !this.closed && this.transport !== null;
  }

  private nextRequestId = 1;
  private pendingRequests = new Map<string | number, PendingRequest>();
  /** Metadata retained after selected request deadlines so a late response is
   * observable even though its original promise has already been rejected. */
  private orphanedRequests = new Map<string | number, { method: string }>();
  private closed = false;

  /** Per-request timeout in ms (0 disables). See McplServerConfig.requestTimeoutMs. */
  private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

  // Event buffering: control-plane traffic can be released independently from
  // inference-bearing data-plane traffic. This lets a server finish its own
  // registration (and answer host tools/call requests) while startup/reconnect
  // reconciliation keeps agent wakes behind a durable barrier.
  private controlPlaneReady = false;
  private dataPlaneReady = false;
  private bufferedEvents: Array<{ event: string; args: unknown[] }> = [];

  // Reconnect state (adapted from Anarchid/agent-framework@mcpl-module-proto)
  private config: McplServerConfig | null = null;
  private hostCapabilities: McplHostCapabilities | null = null;
  private reconnectEnabled = false;
  private reconnectIntervalMs = 5000;
  private reconnectMaxIntervalMs = 300_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed connect attempts since the last successful handshake.
   *  Drives the exponential backoff and is reported on reconnect events. */
  private reconnectAttempts = 0;

  /** Whether a background reconnect loop will revive this connection after a
   *  drop. False once close() has been called (explicit close stops retrying). */
  get willReconnect(): boolean {
    return this.reconnectEnabled;
  }

  /**
   * Private constructor. Use `McplServerConnection.connect()` instead.
   */
  private constructor(
    id: string,
    capabilities: McplCapabilities | null,
    transport: McplTransport | null,
  ) {
    super();
    this.id = id;
    this.capabilities = capabilities;
    this.transport = transport;

    // Skip setup for disconnected stubs (transport is null).
    if (transport) {
      this.wireTransport(transport);
    }
  }

  // ==========================================================================
  // Event buffering
  // ==========================================================================

  /**
   * Mark the connection as ready — flushes any events that arrived between
   * construction (when setupMessageRouting starts emitting) and now (when
   * the caller has attached listeners via wireMcplEvents).
   */
  ready(): void {
    this.controlPlaneReady = true;
    this.dataPlaneReady = true;
    const pending = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const { event, args } of pending) {
      // Re-enter the gate for every buffered item. A control handler (notably
      // tools/list_changed) may install a newer data-plane barrier while this
      // snapshot is being flushed; later data items must observe that pause.
      this.emit(event, ...args);
    }
  }

  /**
   * Release only server-establishment and lifecycle/control traffic. Responses
   * to host requests are never event-buffered, so tools/list and tools/call
   * responses remain live as well. Inference-bearing requests stay queued in
   * their original relative order until {@link ready} is called.
   */
  readyControlPlane(): void {
    this.controlPlaneReady = true;
    const pending = this.bufferedEvents;
    this.bufferedEvents = [];
    for (const item of pending) {
      // Re-enter the ADMISSION gate (this.emit), never super.emit: control
      // events include channels-register/changed, which are grant-gated —
      // the old direct flush bypassed positive-grant enforcement entirely
      // (PR #79 review blocker 3). Data-plane items re-buffer in order via
      // the same call, since dataPlaneReady is still false.
      this.emit(item.event, ...item.args);
    }
  }

  /**
   * Close the data plane synchronously while leaving an already-released
   * control plane live. Used before reconnect adoption and list-change
   * reconciliation so no new inference event can beat barrier installation.
   */
  pauseDataPlane(): void {
    this.dataPlaneReady = false;
  }

  /**
   * Override emit to buffer server→host events until the corresponding plane
   * is ready. Lifecycle events always pass through so reconnect can install a
   * new data-plane gate before the fresh transport is exposed.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const name = typeof event === 'string' ? event : '';
    if (
      McplServerConnection.isLifecycleEvent(name)
      || (McplServerConnection.isControlPlaneEvent(name)
        ? this.controlPlaneReady
        : this.dataPlaneReady)
    ) {
      // Positive-grant admission (§5.4/§14.1), at the single choke-point
      // every path shares: live routing AND buffer flushes re-enter here, so
      // an event buffered while the connection was staged is authorized
      // against the grant current at ADMISSION — by which time the §5.3
      // policy exchange has settled. Rejecting earlier (at line receipt)
      // answered staged traffic with -32002 before the grant existed, which
      // both bounced conforming servers' startup pushes and made a FAILED
      // startup observable to the server (a response where the ledger said
      // nothing was released).
      // host/command: host-owned authority, not a capability — no §6.2 path
      // exists and none is invented here. Default DENY; only the operator's
      // config confers it (PR #79 review blocker 9: any server could
      // request undo/hide/unstick).
      if (name === 'host-command' && !this.allowHostCommands) {
        const responder = args[1] as { respondError?: (code: number, message: string, data?: unknown) => void } | undefined;
        if (responder?.respondError) {
          responder.respondError(CAPABILITY_DISABLED, 'host/command requires host-owned authority (McplServerConfig.allowHostCommands)', {});
        } else {
          console.error(`[mcpl] ${this.id}: discarded host/command — allowHostCommands not set`);
        }
        return true;
      }
      const requiredCap = McplServerConnection.EVENT_TO_REQUIRED_CAPABILITY[name];
      if (requiredCap && !this.grant.has(requiredCap)) {
        const phase = this.policyEstablished ? 'not in the effective grant' : 'initial policy not yet established (§5.3)';
        const responder = args[1] as { respondError?: (code: number, message: string, data?: unknown) => void } | undefined;
        if (responder?.respondError) {
          responder.respondError(CAPABILITY_DISABLED, `${name} rejected: capability "${requiredCap}" ${phase}`, { capability: requiredCap });
        } else {
          console.error(`[mcpl] ${this.id}: discarded ${name} — "${requiredCap}" ${phase}`);
        }
        return true;
      }
      return super.emit(event, ...args);
    }
    this.bufferedEvents.push({ event: name, args });
    return true;
  }

  /** Event-name form of METHOD_TO_REQUIRED_CAPABILITY, for admission-time
   *  enforcement in emit(). */
  private static readonly EVENT_TO_REQUIRED_CAPABILITY: Record<string, string> = {
    'push-event': 'pushEvents',
    'inference-request': 'inferenceRequest',
    'model-info': 'modelInfo',
    'channels-register': 'channels.register',
    'channels-changed': 'channels.register',
    'channels-incoming': 'channels.incoming',
    'channels-list': 'channels.register',
  };

  private static isControlPlaneEvent(event: string): boolean {
    return event === 'stderr'
      || event === 'scope-elevate'
      || event === 'channels-register'
      || event === 'channels-changed'
      || event === 'tools-list-changed'
      || event === 'connect-failed'
      || event === 'reconnect-failed'
      || event === 'orphaned-response';
  }

  private static isLifecycleEvent(event: string): boolean {
    return event === 'close'
      || event === 'error'
      || event === 'reconnect';
  }

  // ==========================================================================
  // Static factory
  // ==========================================================================

  /**
   * Open the transport, perform the MCP initialize handshake with MCPL
   * capability negotiation, and return a ready-to-use connection.
   *
   * Works over stdio (spawned child) or WebSocket, selected by `config` (see
   * {@link openTransport}). Throws if the transport can't be opened, the server
   * closes/errors before the handshake, or the handshake times out.
   */
  static async connect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    const { transport, capabilities, droppedCapabilities, mcpToolsAdvertised } = await McplServerConnection.handshake(config, hostCapabilities);

    const connection = new McplServerConnection(config.id, capabilities, transport);
    connection.droppedCapabilities = droppedCapabilities;
    connection.mcpToolsAdvertised = mcpToolsAdvertised;
    connection.allowHostCommands = config.allowHostCommands === true;
    connection.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // Store config for reconnection
    if (config.reconnect) {
      connection.config = config;
      connection.hostCapabilities = hostCapabilities;
      connection.reconnectEnabled = true;
      connection.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;
      connection.reconnectMaxIntervalMs = config.reconnectMaxIntervalMs ?? 300_000;
    }

    return connection;
  }

  /**
   * Open a fresh transport and run the MCP/MCPL initialize handshake over it,
   * returning the connected transport plus the negotiated capabilities. Shared
   * by {@link connect} and {@link attemptReconnect} so both transports handshake
   * identically. On any failure the transport is closed so a spawned child /
   * open socket never leaks.
   */
  private static async handshake(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<{ transport: McplTransport; capabilities: McplCapabilities | null; droppedCapabilities: ReadonlySet<string>; mcpToolsAdvertised: boolean }> {
    const transport = await openTransport(config);

    try {
      const initId = 0; // use id=0 for the handshake
      const initRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'initialize',
        id: initId,
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { experimental: { mcpl: hostCapabilities } },
          clientInfo: { name: 'agent-framework', version: '1.0.0' },
        },
      };

      // Await the initialize response, racing an early transport close/error and
      // a timeout. All three paths clean up their listeners.
      const { mcpl: rawCapabilities, mcpToolsAdvertised } = await new Promise<{ mcpl: McplCapabilities | null; mcpToolsAdvertised: boolean }>((resolve, reject) => {
        const cleanup = () => {
          transport.off('line', onLine);
          transport.off('close', onClose);
          transport.off('error', onError);
          clearTimeout(timer);
        };
        const onLine = (line: string) => {
          let msg: JsonRpcResponse;
          try {
            msg = JSON.parse(line) as JsonRpcResponse;
          } catch {
            return; // Ignore non-JSON lines (e.g. logback output from Java servers)
          }
          if (msg.id !== initId) return;
          cleanup();
          if (msg.error) {
            reject(new Error(`MCPL server "${config.id}" initialize error: ${msg.error.message}`));
            return;
          }
          const result = msg.result as Record<string, unknown> | undefined;
          const caps = result?.capabilities as Record<string, unknown> | undefined;
          const experimental = caps?.experimental as Record<string, unknown> | undefined;
          // §5.1: `tools` capability is the OUTER standard MCP member — the
          // experimental manifest cannot mint it. Carried alongside so the
          // grant can join it into §6.4 derivation.
          resolve({
            mcpl: (experimental?.mcpl as McplCapabilities) ?? null,
            mcpToolsAdvertised: caps?.tools !== undefined,
          });
        };
        const onClose = (info: TransportCloseInfo) => {
          cleanup();
          reject(new Error(`MCPL server "${config.id}" transport closed before handshake completed (${info.reason ?? 'unknown'})`));
        };
        const onError = (err: Error) => {
          cleanup();
          reject(new Error(`MCPL server "${config.id}" transport error during handshake: ${err.message}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`MCPL server "${config.id}" initialize handshake timed out`));
        }, INITIALIZE_TIMEOUT_MS);

        transport.on('line', onLine);
        transport.on('close', onClose);
        transport.on('error', onError);
        transport.writeLine(JSON.stringify(initRequest));
      });

      // Send `initialized` notification (no id)
      transport.writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

      // §5.1 boolean shorthand expands to explicit leaves BEFORE the config
      // mask runs, so sub-leaf policy is addressable — `channels: true` with
      // `disabledCapabilities: ['channels.streaming']` must actually drop
      // streaming (PR #79 review blocker 1).
      const capabilities = expandAdvertisementShorthand(rawCapabilities);
      // Host-side capability scoping: intersect the server's advertisement
      // with config policy so a masked capability behaves exactly as if it
      // had never been advertised (hooks, streaming, queries all read this).
      const { capabilities: scoped, dropped } = maskNegotiatedCapabilities(capabilities, config);
      if (dropped.length > 0) {
        console.error(`MCPL server "${config.id}" capabilities masked by host config: ${dropped.join(', ')}`);
      }

      return { transport, capabilities: scoped, droppedCapabilities: new Set(dropped), mcpToolsAdvertised };
    } catch (err) {
      // Never leak the child / socket if the handshake fails.
      await transport.close().catch(() => { /* best effort */ });
      throw err;
    }
  }

  /**
   * Connect with reconnect support.
   * When `config.reconnect` is true and the initial connection fails,
   * resolves immediately with null capabilities and retries in the background.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  static async connectWithReconnect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    try {
      return await McplServerConnection.connect(config, hostCapabilities);
    } catch (error) {
      if (!config.reconnect) {
        throw error;
      }

      // Non-blocking start: create a disconnected stub that will reconnect in background
      console.error(`MCPL server "${config.id}" initial connect failed, will retry:`, (error as Error).message);
      const stub = McplServerConnection.createDisconnectedStub(config, hostCapabilities);
      // Surface the initial failure. The event is buffered by the emit()
      // override until the host wires listeners and calls ready(), so it is
      // not lost in the window before wireMcplEvents runs.
      stub.emit('connect-failed', { error: (error as Error).message, attempt: 0 });
      return stub;
    }
  }

  /**
   * Create a disconnected stub connection that will reconnect in the background.
   * Used when initial connect fails and reconnect is enabled.
   * @internal
   */
  private static createDisconnectedStub(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): McplServerConnection {
    // Null transport — the stub is closed until its first background reconnect.
    const stub = new McplServerConnection(config.id, null, null);
    stub.closed = true;
    stub.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    stub.config = config;
    stub.hostCapabilities = hostCapabilities;
    stub.reconnectEnabled = true;
    stub.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;
    stub.reconnectMaxIntervalMs = config.reconnectMaxIntervalMs ?? 300_000;
    stub.reconnectAttempts = 1; // the initial connect already failed

    // Schedule background reconnect
    stub.scheduleReconnect();

    return stub;
  }

  // ==========================================================================
  // Outbound requests (return Promises)
  // ==========================================================================

  /** Send `context/beforeInference` and await result. */
  sendBeforeInference(params: BeforeInferenceParams): Promise<BeforeInferenceResult> {
    return this.sendRequest(McplMethod.BeforeInference, params as unknown as Record<string, unknown>) as Promise<BeforeInferenceResult>;
  }

  /**
   * Send `context/afterInference`.
   * When `blocking` is true, sends as a request and awaits the result.
   * When `blocking` is false (or omitted), sends as a notification.
   */
  sendAfterInference(params: AfterInferenceParams, blocking?: boolean): Promise<AfterInferenceResult | void> {
    if (blocking) {
      return this.sendRequest(McplMethod.AfterInference, params as unknown as Record<string, unknown>) as Promise<AfterInferenceResult>;
    }
    this.sendNotification(McplMethod.AfterInference, params as unknown as Record<string, unknown>);
    return Promise.resolve();
  }

  /** Send `featureSets/update` as a Notification. §6.7: valid ONLY for
   *  purely descriptive metadata that does not alter the grant. Any grant
   *  change — including the §5.3 initial policy — MUST use the Request form
   *  below. */
  sendFeatureSetsUpdate(params: FeatureSetsUpdateParams): void {
    this.sendNotification(McplMethod.FeatureSetsUpdate, params as unknown as Record<string, unknown>);
  }

  /**
   * Send `featureSets/update` as a Request (§5.3, §6.7) and await the
   * degradation receipt. A short timeout, distinct from tool-call timeouts:
   * a pre-0.5 server treats the Request as a notification and never
   * answers, and per §6.7 an unanswered expansion simply does not activate
   * — the caller leaves the grant empty and the connection MCP-only.
   */
  sendFeatureSetsUpdateRequest(
    params: FeatureSetsUpdateParams,
    timeoutMs = 15_000,
  ): Promise<FeatureSetsUpdateResult> {
    return this.sendRequest(
      McplMethod.FeatureSetsUpdate,
      params as unknown as Record<string, unknown>,
      { timeoutMs },
    ) as Promise<FeatureSetsUpdateResult>;
  }

  /** Send `inference/chunk` notification. */
  sendInferenceChunk(params: InferenceChunkParams): void {
    this.sendNotification(McplMethod.InferenceChunk, params as unknown as Record<string, unknown>);
  }

  /** Send `inference/lifecycle` notification (§10.5). Best-effort. */
  sendInferenceLifecycle(params: InferenceLifecycleParams): void {
    this.sendNotification(McplMethod.InferenceLifecycle, params as unknown as Record<string, unknown>);
  }

  /** Send `state/rollback` request and await result. */
  sendStateRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    return this.sendRequest(McplMethod.StateRollback, params as unknown as Record<string, unknown>) as Promise<StateRollbackResult>;
  }

  /** Send `channels/open` request and await result. */
  sendChannelsOpen(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    return this.sendRequest(McplMethod.ChannelsOpen, params as unknown as Record<string, unknown>) as Promise<ChannelsOpenResult>;
  }

  /** Send `channels/close` request and await result. */
  sendChannelsClose(params: ChannelsCloseParams): Promise<ChannelsCloseResult> {
    return this.sendRequest(McplMethod.ChannelsClose, params as unknown as Record<string, unknown>) as Promise<ChannelsCloseResult>;
  }

  /** Send `channels/acknowledge` request and await result. */
  sendChannelsAcknowledge(params: ChannelsAcknowledgeParams): Promise<ChannelsAcknowledgeResult> {
    return this.sendRequest(
      McplMethod.ChannelsAcknowledge,
      params as unknown as Record<string, unknown>,
    ) as Promise<ChannelsAcknowledgeResult>;
  }

  /** Send `channels/list` request and await result. */
  sendChannelsList(): Promise<ChannelsListResult> {
    return this.sendRequest(McplMethod.ChannelsList, {}) as Promise<ChannelsListResult>;
  }

  /**
   * Send `channels/publish`.
   * May be sent as a request (if an ACK is desired) or notification.
   * When `params.stream` is true, sends as a notification (no ACK).
   */
  sendChannelsPublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult | void> {
    if (params.stream) {
      this.sendNotification(McplMethod.ChannelsPublish, params as unknown as Record<string, unknown>);
      return Promise.resolve();
    }
    return this.sendRequest(McplMethod.ChannelsPublish, params as unknown as Record<string, unknown>) as Promise<ChannelsPublishResult>;
  }

  /** Send `channels/outgoing/chunk` notification. */
  sendChannelsOutgoingChunk(params: ChannelsOutgoingChunkParams): void {
    this.sendNotification(McplMethod.ChannelsOutgoingChunk, params as unknown as Record<string, unknown>);
  }

  /** Send `channels/outgoing/complete` notification. */
  sendChannelsOutgoingComplete(params: ChannelsOutgoingCompleteParams): void {
    this.sendNotification(McplMethod.ChannelsOutgoingComplete, params as unknown as Record<string, unknown>);
  }

  /** Send `channels/typing` notification (best-effort).
   *  `metadata` is opaque routing hints for the server — e.g. Zulip uses
   *  `topic` to target a specific thread; other servers ignore what they don't
   *  recognize. Typically sourced from the most recent incoming message's
   *  metadata on the same channel.
   *  `op` defaults to 'start'; pass 'stop' to clear an active indicator
   *  immediately rather than waiting for server-side auto-expire. */
  sendChannelsTyping(
    channelId: string,
    metadata?: Record<string, unknown>,
    op: 'start' | 'stop' = 'start',
  ): void {
    const params: Record<string, unknown> = { channelId, op };
    if (metadata) params.metadata = metadata;
    this.sendNotification(McplMethod.ChannelsTyping, params);
  }

  // ==========================================================================
  // Standard MCP methods
  // ==========================================================================

  /** Send `tools/list` and return the server's tool definitions. */
  sendToolsList(): Promise<{ tools: McpToolDefinition[] }> {
    return this.sendRequest('tools/list', {}) as Promise<{ tools: McpToolDefinition[] }>;
  }

  /** Send `tools/call` and return the result. Optionally includes state/checkpoint for stateful tools. */
  sendToolsCall(
    name: string,
    args: Record<string, unknown>,
    stateParams?: { state?: unknown; checkpoint?: string },
  ): Promise<McpToolCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (stateParams?.state !== undefined) params.state = stateParams.state;
    if (stateParams?.checkpoint !== undefined) params.checkpoint = stateParams.checkpoint;
    return this.sendRequest('tools/call', params) as Promise<McpToolCallResult>;
  }

  /**
   * Send a tools/call with a mandatory request-local deadline. This is used by
   * durable external-side-effect accounting, whose safety bound must remain in
   * force even when the server's general requestTimeoutMs is configured as 0.
   */
  sendToolsCallWithDeadline(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpToolCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    const mandatoryTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(1, Math.floor(timeoutMs))
      : 1;
    return this.sendRequest('tools/call', params, {
      timeoutMs: mandatoryTimeoutMs,
      surfaceOrphanedResponse: true,
    }) as Promise<McpToolCallResult>;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Close the connection: disable reconnect, kill the child process, and clean up resources. */
  async close(): Promise<void> {
    // Disable reconnect before closing — explicit close means stop retrying
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.closed) {
      return;
    }
    this.closed = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`Connection to MCPL server "${this.id}" closed while awaiting response for ${pending.method} (id=${id})`));
    }
    this.pendingRequests.clear();
    this.orphanedRequests.clear();

    // Tear down the transport (kills the child / closes the socket). The
    // transport's own 'close' event is short-circuited by `this.closed` in
    // setupLifecycle, so this is the single source of the connection 'close'.
    if (this.transport) {
      await this.transport.close();
    }

    this.emit('close');
  }

  /**
   * Tear down a live transport after an awareness-accounting failure without
   * disabling configured auto-reconnect. The normal transport close handler
   * rejects requests, emits lifecycle state, and schedules the next bounded
   * reconnect attempt. With reconnect disabled this leaves the server closed.
   */
  async reconnectAfterFailure(): Promise<void> {
    this.pauseDataPlane();
    if (this.closed) {
      this.scheduleReconnect();
      return;
    }
    if (this.transport) {
      await this.transport.close();
      return;
    }
    this.closed = true;
    this.emit('close');
    this.scheduleReconnect();
  }

  /**
   * Schedule a background reconnection attempt.
   *
   * Delay grows exponentially with consecutive failures (base
   * `reconnectIntervalMs`, doubling per failure, capped at
   * `reconnectMaxIntervalMs`) with ±25% jitter so a fleet of servers that
   * died together doesn't thundering-herd the same instant. The counter
   * resets on a successful handshake, so a later disconnect starts over at
   * the base interval.
   */
  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;

    const exponent = Math.max(0, Math.min(this.reconnectAttempts - 1, 30));
    const uncapped = this.reconnectIntervalMs * 2 ** exponent;
    const capped = Math.min(uncapped, this.reconnectMaxIntervalMs);
    const delay = capped * (0.75 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect();
    }, delay);
  }

  /**
   * Attempt to reconnect by opening a fresh transport and performing the
   * handshake, then adopting that transport in place. Unlike the previous
   * approach this builds no throwaway connection instance, so there are no
   * leaked listeners on a dead object.
   */
  private async attemptReconnect(): Promise<void> {
    if (!this.reconnectEnabled || !this.config || !this.hostCapabilities) return;

    // Ordinal of this attempt: 0 was the initial connect, so the Nth retry
    // reports attempt N (reconnectAttempts counts failures so far).
    const attempt = Math.max(1, this.reconnectAttempts);

    try {
      const { transport, capabilities, droppedCapabilities, mcpToolsAdvertised } = await McplServerConnection.handshake(
        this.config,
        this.hostCapabilities,
      );

      // Close the data plane before the new transport can emit. The reconnect
      // lifecycle event bypasses buffering; its framework listener installs the
      // awareness barrier synchronously, then releases control traffic needed
      // to establish the server while data remains held.
      this.pauseDataPlane();
      this.transport = transport;
      this.capabilities = capabilities;
      this.droppedCapabilities = droppedCapabilities;
      this.mcpToolsAdvertised = mcpToolsAdvertised;
      this.allowHostCommands = this.config?.allowHostCommands === true;
      this.closed = false;
      this.nextRequestId = 1;
      this.pendingRequests.clear();
      this.wireTransport(transport);

      console.error(`MCPL server "${this.id}" reconnected successfully`);
      this.reconnectAttempts = 0;
      this.emit('reconnect', { attempts: attempt });
    } catch (error) {
      console.error(`MCPL server "${this.id}" reconnect failed:`, (error as Error).message);
      this.reconnectAttempts = attempt + 1;
      this.emit('reconnect-failed', { error: (error as Error).message, attempt });
      this.scheduleReconnect();
    }
  }

  // ==========================================================================
  // Private: message sending
  // ==========================================================================

  /**
   * Send a JSON-RPC request and return a promise that resolves with the result
   * or rejects with a JSON-RPC error.
   *
   * Every request carries a timeout (default 60s, configurable via
   * McplServerConfig.requestTimeoutMs, 0 disables): a live-but-stuck server
   * that accepts a request and never answers rejects the pending promise with
   * a descriptive error instead of freezing the caller forever. For tools/call
   * the framework maps the rejection to an isError tool_result, so a hung tool
   * surfaces as a normal tool error and the turn completes.
   */
  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot send request: connection to "${this.id}" is closed`));
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      id,
      params,
    };

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, method };
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          if (options.surfaceOrphanedResponse) {
            this.orphanedRequests.set(id, { method });
          }
          reject(new Error(
            `MCPL server "${this.id}" did not respond to ${method} (id=${id}) ` +
            `within ${timeoutMs}ms — the server may be hung. The response ` +
            `outcome is unknown: the request was abandoned locally but was not ` +
            `cancelled, so the tool may still have completed server-side; verify ` +
            `state before retrying; a blind retry of a stateful/side-effecting ` +
            `tool may duplicate it.`,
          ));
        }, timeoutMs);
        // Don't hold the event loop open for the watchdog alone.
        pending.timer.unref?.();
      }
      this.pendingRequests.set(id, pending);
      this.transport!.writeLine(JSON.stringify(request));
    });
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response expected).
   */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }

    const notification: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.transport?.writeLine(JSON.stringify(notification));
  }

  // ==========================================================================
  // Private: inbound message routing
  // ==========================================================================

  /**
   * Map from JSON-RPC method name to the EventEmitter event name.
   */
  private static readonly METHOD_TO_EVENT: Record<string, string> = {
    [McplMethod.PushEvent]: 'push-event',
    [McplMethod.InferenceRequest]: 'inference-request',
    [McplMethod.ScopeElevate]: 'scope-elevate',
    [McplMethod.ChannelsRegister]: 'channels-register',
    [McplMethod.ChannelsChanged]: 'channels-changed',
    [McplMethod.ChannelsIncoming]: 'channels-incoming',
    // §6.6/§12: a request bearing an id MUST get a result or an error —
    // neither of these had an entry, so callers hung forever (AUDIT-001
    // item 4, which also poisoned the audit's own usage evidence).
    [McplMethod.ModelInfo]: 'model-info',
    [McplMethod.ChannelsList]: 'channels-list',
    'notifications/tools/list_changed': 'tools-list-changed',
    // Host-level admin commands initiated from a surface (e.g. a Discord
    // slash command). Params: { command, ... }; host responds with a
    // command-specific result object.
    'host/command': 'host-command',
  };

  /**
   * Inbound (server-initiated) method → required capability path, per SPEC
   * §14.1's table plus the non-channel privileged methods. **Positive-grant
   * enforcement** (§5.4): the method is admitted only when the effective
   * grant contains the named path — absence is denial, and before the
   * initial policy exchange completes the grant is empty, so everything
   * privileged is rejected (§5.3).
   *
   * This replaces the earlier `droppedCapabilities` deny-list check, which
   * could only deny what had been advertised-then-masked: a server that
   * never advertised a capability at all was never denied. (Adjudicated in
   * review of PR #75; the mask itself is retained as the config-policy
   * layer feeding the grant.)
   *
   * Channel methods key on their specific sub-capabilities, not the bare
   * `channels` parent — a bare parent grants nothing (§5.4).
   */
  private static readonly METHOD_TO_REQUIRED_CAPABILITY: Record<string, string> = {
    [McplMethod.PushEvent]: 'pushEvents',
    [McplMethod.InferenceRequest]: 'inferenceRequest',
    [McplMethod.ModelInfo]: 'modelInfo',
    [McplMethod.ChannelsRegister]: 'channels.register',
    [McplMethod.ChannelsChanged]: 'channels.register',
    [McplMethod.ChannelsIncoming]: 'channels.incoming',
    [McplMethod.ChannelsList]: 'channels.register',
  };

  /**
   * Bind all transport-level handlers (inbound routing, lifecycle, stderr) to a
   * transport. Called from the constructor and again from attemptReconnect when
   * a new transport is adopted.
   */
  private wireTransport(transport: McplTransport): void {
    this.setupMessageRouting(transport);
    this.setupLifecycle(transport);
    // Surface transport diagnostics (stdio child stderr) as 'stderr' events,
    // preserving the `{ line }` payload existing consumers expect.
    transport.on('stderr', (line: string) => this.emit('stderr', { line }));
  }

  /**
   * Wire up the transport's line stream to route incoming JSON-RPC messages.
   */
  private setupMessageRouting(transport: McplTransport): void {
    transport.on('line', (line: string) => {
      let msg: JsonRpcRequest | JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        // Ignore non-JSON lines
        return;
      }

      // Is this a response to one of our outbound requests?
      if ('id' in msg && msg.id != null && !('method' in msg)) {
        this.handleResponse(msg as JsonRpcResponse);
        return;
      }

      // It is an inbound request or notification from the server
      const request = msg as JsonRpcRequest;
      const eventName = McplServerConnection.METHOD_TO_EVENT[request.method];

      // §7 is removed in 0.5.0: scope/elevate is no longer a method. Answer
      // rather than hang (§6.6 — a method that will never be answered MUST
      // return an error).
      // featureSets/changed is REMOVED in 0.5.0 (§6.7 — it carried a
      // server-authored change payload, the self-attestation defect; the
      // need is met by §17's host-diffed manifest fetch). It was still
      // routed, control-plane classified, and mutating declarations — a
      // live ungated self-attestation path (PR #79 review blocker 4).
      if (request.method === McplMethod.FeatureSetsChanged) {
        if (request.id != null) {
          this.sendErrorResponse(request.id, -32601, 'featureSets/changed removed in MCPL 0.5.0 (superseded by mcpl/manifestChanged, SPEC §17)');
        } else {
          console.error(`[mcpl] ${this.id}: discarded featureSets/changed — removed in 0.5.0 (§6.7/§17)`);
        }
        return;
      }

      if (request.method === McplMethod.ScopeElevate) {
        if (request.id != null) {
          this.sendErrorResponse(request.id, -32601, 'scope/elevate removed in MCPL 0.5.0 (SPEC §7)');
        }
        return;
      }

      // Positive-grant enforcement (§5.4, §14.1) happens at ADMISSION, in
      // the emit() override below — the one choke-point that live routing
      // and staged-buffer flushes share. See the comment there for why
      // rejecting here, at line receipt, was wrong for staged connections.

      if (eventName) {
        // Emit the typed event with params and (for requests) a respond callback
        if (request.id != null) {
          // Server expects a response — provide a respond helper
          this.emit(eventName, request.params, {
            id: request.id,
            respond: (result: unknown) => this.sendResponse(request.id!, result),
            respondError: (code: number, message: string, data?: unknown) =>
              this.sendErrorResponse(request.id!, code, message, data),
          });
        } else {
          // Notification — no response expected
          this.emit(eventName, request.params);
        }
      }
    });
  }

  /**
   * Handle a JSON-RPC response by resolving/rejecting the corresponding pending request.
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      // Orphaned response — the request already timed out (or was settled) and
      // was removed from pendingRequests. A late STATEFUL result must be
      // surfaced because dropping it silently diverges the checkpoint tree.
      // Selected side-effecting calls are also surfaced even without state so
      // their outcome-unknown receipt remains visible. We cannot safely
      // re-inject either result because the original dispatch context is gone.
      const orphaned = this.orphanedRequests.get(response.id);
      this.orphanedRequests.delete(response.id);
      const result = response.result;
      if (result && typeof result === 'object') {
        const r = result as { state?: unknown; checkpoint?: unknown };
        if (orphaned || r.state !== undefined || r.checkpoint !== undefined) {
          this.emit('orphaned-response', {
            id: response.id,
            method: orphaned?.method,
            hadState: r.state !== undefined,
            hadCheckpoint: r.checkpoint !== undefined,
          });
        }
      } else if (orphaned) {
        this.emit('orphaned-response', {
          id: response.id,
          method: orphaned.method,
          hadState: false,
          hadCheckpoint: false,
        });
      }
      return; // Orphaned response — ignore
    }

    this.pendingRequests.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new Error(`MCPL server "${this.id}" returned error for ${pending.method}: [${response.error.code}] ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Send a successful JSON-RPC response back to the server.
   */
  private sendResponse(id: string | number, result: unknown): void {
    if (this.closed) return;
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.transport?.writeLine(JSON.stringify(response));
  }

  /**
   * Send a JSON-RPC error response back to the server.
   */
  private sendErrorResponse(id: string | number, code: number, message: string, data?: unknown): void {
    if (this.closed) return;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    this.transport?.writeLine(JSON.stringify(response));
  }

  // ==========================================================================
  // Private: lifecycle
  // ==========================================================================

  /**
   * Set up transport error/close handlers. An unexpected transport close
   * (child exit or WebSocket drop) rejects in-flight requests, emits 'close',
   * and — when enabled — schedules a background reconnect.
   */
  private setupLifecycle(transport: McplTransport): void {
    transport.on('error', (err: Error) => {
      this.emit('error', new Error(`MCPL server "${this.id}" transport error: ${err.message}`));
    });

    transport.on('close', (info: TransportCloseInfo) => {
      if (!this.closed) {
        this.closed = true;

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(
            new Error(
              `MCPL server "${this.id}" disconnected unexpectedly (code=${info.code ?? 'n/a'}, signal=${info.signal ?? 'n/a'}, reason=${info.reason ?? 'unknown'}) while awaiting ${pending.method} (id=${id})`,
            ),
          );
        }
        this.pendingRequests.clear();
        this.orphanedRequests.clear();

        this.emit('close', info.code ?? null, info.signal ?? null);

        // Schedule reconnect if enabled (unexpected disconnect triggers auto-reconnect)
        if (this.reconnectEnabled) {
          this.scheduleReconnect();
        }
      }
    });
  }
}
