/**
 * ModernMcpConnection: a server that speaks modern MCP (2026-07-28), reached
 * over stdio or Streamable HTTP through the official SDK client.
 *
 * Responsibilities divide like this. The SDK owns the modern wire:
 * `server/discover`, the per-request `_meta` envelope, `resultType`,
 * continuation of `input_required` results, cancellation, list-change
 * subscriptions, and the HTTP binding's headers, auth retry and
 * header-mismatch handling. This class owns what Connectome decides:
 * - **stdio** runs through Connectome's own spawner, so the child gets the
 *   same env allowlist, `inheritEnv` and stderr surfacing as a legacy server,
 *   and it starts once per connect. The SDK's own stdio transport starts a
 *   throwaway second copy for discovery.
 * - **HTTP credentials** come from `token`/`accessProvider`: a cached bearer
 *   token, re-resolved once when the server answers 401.
 * - **One deadline per tool call** (`requestTimeoutMs`, always positive)
 *   bounds every leg of the call. At the deadline the SDK requests
 *   cancellation and the outcome is unknown. Calls are never replayed.
 * - **Lifetime.** On a lost transport the connection restarts with the same
 *   backoff settings as legacy, when `reconnect` is set. A lost list-change
 *   stream is reopened while the connection lives. Each connect is a
 *   generation, so a superseded client can never touch a newer one.
 *
 * Nothing here is MCPL: a modern server has no grant, no planes and no
 * server→host requests. The framework uses this connection only through its
 * tool paths, and the MCPL machinery never sees it.
 */
import { EventEmitter } from 'node:events';

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type CallToolResult,
  type JSONRPCMessage,
  type McpSubscription,
  type Transport,
} from '@modelcontextprotocol/client';

import { StdioTransport, type McplTransport } from './transport.js';
import { McplRequestError } from './server-connection.js';
import { MODERN_MCP_PROTOCOL_VERSION, checkServerConfig } from './protocol-family.js';
import type { McplServerConfig, McpToolDefinition } from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Bound on establishing the connection (`server/discover`), like the legacy
 *  engine's initialize timeout. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Inventory listing has its own bound: it is host work, not a resident's call. */
const LIST_TIMEOUT_MS = 30_000;

/** A modern tool result as the framework consumes it. `structuredContent` is
 *  kept by presence: `false`, `0` and `null` are values, not absence. */
export interface ModernToolCallResult {
  content: CallToolResult['content'];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

/**
 * SDK `Transport` over Connectome's stdio spawner. Framing is the same
 * newline-delimited JSON-RPC as legacy. Lines that are not JSON are ignored,
 * as the legacy engine ignores them. Because this is a custom transport, the
 * SDK runs `server/discover` on this very process instead of starting a
 * throwaway copy, and cancels with `notifications/cancelled`, which is the
 * stdio binding's mechanism.
 */
class SpawnerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private line: McplTransport | null = null;

  constructor(
    private readonly config: McplServerConfig,
    private readonly onStderr: (line: string) => void,
  ) {}

  async start(): Promise<void> {
    const line = StdioTransport.spawn(this.config);
    this.line = line;
    line.on('line', (text: string) => {
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(text) as JSONRPCMessage;
      } catch {
        return;
      }
      this.onmessage?.(message);
    });
    line.on('stderr', (text: string) => this.onStderr(text));
    line.on('error', (error: Error) => this.onerror?.(error));
    line.on('close', () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.line || this.line.closed) throw new Error(`MCP server "${this.config.id}" stdio transport is closed`);
    this.line.writeLine(JSON.stringify(message));
  }

  async close(): Promise<void> {
    await this.line?.close();
  }
}

/** Connectome's credential plumbing as the SDK's minimal bearer seam: a
 *  cached token, fetched on first use and once again after a 401. */
function bearerAuth(config: McplServerConfig): AuthProvider | undefined {
  const provider = config.accessProvider;
  if (!provider && !config.token) return undefined;
  let cached: string | undefined;
  const resolve = async (): Promise<string | undefined> => {
    if (provider) {
      try {
        const fresh = await provider();
        if (fresh) return fresh;
      } catch (error) {
        // Same fallback as the WebSocket dial: use the static token, and let
        // the server refuse a stale credential loudly.
        console.error(
          `[mcp] server "${config.id}": access provider failed (${error instanceof Error ? error.message : error}) — using configured fallback`,
        );
      }
    }
    return config.token;
  };
  return {
    token: async () => (cached ??= await resolve()),
    onUnauthorized: async () => {
      cached = await resolve();
    },
  };
}

export class ModernMcpConnection extends EventEmitter {
  readonly id: string;
  readonly family = 'modern' as const;
  readonly transportKind: 'stdio' | 'http';
  /** The pinned revision, once a connect has established it; null before. */
  protocolVersion: string | null = null;

  private client: Client | null = null;
  private connected = false;
  private generation = 0;
  private closedByHost = false;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectIntervalMs: number;
  private readonly reconnectMaxIntervalMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private relistenTimer: ReturnType<typeof setTimeout> | null = null;
  private relistenAttempts = 0;

  private constructor(private readonly config: McplServerConfig) {
    super();
    this.id = config.id;
    const binding = checkServerConfig(config);
    if (binding.family !== 'modern') {
      throw new Error(`MCP server "${config.id}" is not configured for modern MCP; it belongs to McplServerConnection`);
    }
    this.transportKind = binding.transport === 'http' ? 'http' : 'stdio';
    this.reconnectEnabled = config.reconnect === true;
    this.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;
    this.reconnectMaxIntervalMs = config.reconnectMaxIntervalMs ?? 300_000;
    // An 'error' with no listener would throw out of an SDK callback and take
    // the host down; out-of-band errors here are diagnostics, never fatal.
    this.on('error', (error: Error) => {
      if (this.listenerCount('error') === 1) console.error(`[mcp] ${this.id}: ${error.message}`);
    });
  }

  /** The per-call deadline: `requestTimeoutMs`, validated positive. */
  get requestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Whether a lost connection will be re-established in the background. */
  get willReconnect(): boolean {
    return this.reconnectEnabled && !this.closedByHost;
  }

  /**
   * Connect, or with `reconnect` set, return a connection that keeps
   * retrying in the background when the first attempt fails (the legacy
   * engine's contract). Configuration errors always throw.
   */
  static async connect(config: McplServerConfig): Promise<ModernMcpConnection> {
    const connection = new ModernMcpConnection(config);
    try {
      await connection.open();
    } catch (error) {
      if (!connection.reconnectEnabled) throw error;
      console.error(`MCP server "${config.id}" initial connect failed, will retry:`, (error as Error).message);
      connection.reconnectAttempts = 1;
      // A macrotask, so the caller has wired its listeners (synchronously,
      // right after this resolves) before the event fires.
      setImmediate(() => connection.emit('connect-failed', { error: (error as Error).message, attempt: 0 }));
      connection.scheduleReconnect();
    }
    return connection;
  }

  /** One connect generation: a fresh client and transport. */
  private async open(): Promise<void> {
    const generation = ++this.generation;
    const live = () => generation === this.generation && !this.closedByHost;

    const transport: Transport = this.transportKind === 'stdio'
      ? new SpawnerStdioTransport(this.config, (line) => { if (live()) this.emit('stderr', { line }); })
      : new StreamableHTTPClientTransport(new URL(this.config.url!), { authProvider: bearerAuth(this.config) });

    const client = new Client(
      { name: 'agent-framework', version: '1.0.0' },
      {
        versionNegotiation: { mode: { pin: MODERN_MCP_PROTOCOL_VERSION } },
        // Nothing advertised: this client supplies no sampling, elicitation
        // or roots, so a conforming server cannot require them.
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => { if (live()) this.emit('tools-list-changed'); },
          },
        },
      },
    );
    client.onerror = (error: Error) => {
      // The SDK reports late responses to deadline-abandoned calls here
      // ("unknown message ID"), among other out-of-band errors. They are
      // logged, never delivered: the call's outcome was already reported.
      if (live()) this.emit('error', error);
    };
    client.onclose = () => {
      if (live()) this.handleLost('transport closed');
    };

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    if (!live()) {
      await client.close().catch(() => {});
      return;
    }
    this.client = client;
    this.connected = true;
    this.protocolVersion = MODERN_MCP_PROTOCOL_VERSION;
    this.reconnectAttempts = 0;
    this.watchSubscription(client.autoOpenedSubscription, generation);
  }

  /**
   * Keep list-change awareness while the connection lives. The SDK opens the
   * subscription at connect when the server advertises tool list changes.
   * When the subscription ends without our asking, it is reopened with
   * backoff, and the inventory is refreshed once it's back, since changes
   * may have been missed in between. A transport loss is the reconnect
   * path's job, not this one's.
   */
  private watchSubscription(subscription: McpSubscription | undefined, generation: number): void {
    if (!subscription) return;
    void subscription.closed.then((reason) => {
      if (reason === 'local' || generation !== this.generation || this.closedByHost || !this.connected) return;
      this.scheduleRelisten(generation);
    });
  }

  private scheduleRelisten(generation: number): void {
    if (this.relistenTimer) return;
    const delay = this.backoffDelay(this.relistenAttempts);
    this.relistenTimer = setTimeout(() => {
      this.relistenTimer = null;
      void this.relisten(generation);
    }, delay);
    this.relistenTimer.unref?.();
  }

  private async relisten(generation: number): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation || this.closedByHost || !this.connected) return;
    try {
      const subscription = await client.listen({ toolsListChanged: true }, { timeout: CONNECT_TIMEOUT_MS });
      if (generation !== this.generation || this.closedByHost) {
        await subscription.close().catch(() => {});
        return;
      }
      this.relistenAttempts = 0;
      this.watchSubscription(subscription, generation);
      this.emit('tools-list-changed');
    } catch (error) {
      this.relistenAttempts++;
      this.emit('error', new Error(`MCP server "${this.id}" could not reopen its list-change subscription: ${(error as Error).message}`));
      this.scheduleRelisten(generation);
    }
  }

  /** The transport went away (child exit, or a closed HTTP client). */
  private handleLost(reason: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.client = null;
    this.emit('close', { reason });
    if (this.willReconnect) this.scheduleReconnect();
  }

  /** The legacy engine's backoff: doubling from the base interval, capped,
   *  with ±25% jitter. */
  private backoffDelay(failures: number): number {
    const exponent = Math.max(0, Math.min(failures - 1, 30));
    const capped = Math.min(this.reconnectIntervalMs * 2 ** exponent, this.reconnectMaxIntervalMs);
    return capped * (0.75 + Math.random() * 0.5);
  }

  private scheduleReconnect(): void {
    if (!this.willReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, this.backoffDelay(this.reconnectAttempts));
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.willReconnect || this.connected) return;
    const attempt = Math.max(1, this.reconnectAttempts);
    try {
      await this.open();
      if (!this.connected) return;
      console.error(`MCP server "${this.id}" reconnected`);
      this.emit('reconnect', { attempts: attempt });
    } catch (error) {
      this.reconnectAttempts = attempt + 1;
      this.emit('reconnect-failed', { error: (error as Error).message, attempt });
      this.scheduleReconnect();
    }
  }

  /** The server's complete tool inventory (the SDK follows every page). */
  async listTools(): Promise<McpToolDefinition[]> {
    const client = this.requireClient('tools/list');
    try {
      const { tools } = await client.listTools(undefined, { cacheMode: 'refresh', timeout: LIST_TIMEOUT_MS });
      return tools.map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        ...(tool._meta !== undefined ? { _meta: tool._meta as Record<string, unknown> } : {}),
      }));
    } catch (error) {
      throw this.requestFailure('tools/list', error);
    }
  }

  /**
   * Call a tool within the configured deadline. One budget covers the whole
   * logical call: the SDK's per-leg timer and its `maxTotalTimeout` across
   * continuation rounds, and an abort signal around any retry the SDK makes
   * before dispatch (an auth refresh, or a header-mismatch relist).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ModernToolCallResult> {
    const client = this.requireClient('tools/call');
    const timeoutMs = this.requestTimeoutMs;
    try {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) },
      );
      return {
        content: result.content ?? [],
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...('structuredContent' in result ? { structuredContent: result.structuredContent } : {}),
        ...(result._meta !== undefined ? { _meta: result._meta as Record<string, unknown> } : {}),
      };
    } catch (error) {
      throw this.requestFailure(`tools/call "${name}"`, error, timeoutMs);
    }
  }

  /** Close for good: no reconnect, no reopened subscription. */
  async close(): Promise<void> {
    this.closedByHost = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.relistenTimer) clearTimeout(this.relistenTimer);
    this.reconnectTimer = null;
    this.relistenTimer = null;
    const client = this.client;
    const wasConnected = this.connected;
    this.client = null;
    this.connected = false;
    if (client) await client.close().catch(() => {});
    if (wasConnected) this.emit('close', { reason: 'closed by host' });
  }

  /** Connectome refuses before anything reaches the SDK: provably not sent. */
  private requireClient(method: string): Client {
    if (!this.client || !this.connected) {
      throw new McplRequestError(`Cannot send ${method}: connection to "${this.id}" is not established`, 'not-sent');
    }
    return this.client;
  }

  /**
   * Map an SDK failure onto the request-outcome contract, claiming no more
   * than the failure establishes:
   * - `error-response`: the server answered with an error. That is a
   *   JSON-RPC error, or an HTTP auth refusal, which carries the status as
   *   its code.
   * - `no-response`: everything after hand-off that proves nothing about
   *   delivery, including the deadline, where cancellation was requested and
   *   the outcome is unknown.
   * A call the server answered with a result Connectome can't use (it fails
   * validation, or needs input this client can't supply) is a plain error:
   * the server did act, so no request outcome applies.
   */
  private requestFailure(what: string, error: unknown, timeoutMs?: number): Error {
    const prefix = `MCP server "${this.id}"`;
    if (error instanceof ProtocolError) {
      return new McplRequestError(`${prefix} returned error for ${what}: [${error.code}] ${error.message}`, 'error-response', error.code, error.data);
    }
    if (error instanceof SdkHttpError && (error.code === SdkErrorCode.ClientHttpAuthentication || error.code === SdkErrorCode.ClientHttpForbidden)) {
      return new McplRequestError(`${prefix} refused ${what}: HTTP ${error.status} (${error.message})`, 'error-response', error.status, error.data);
    }
    if (error instanceof SdkError) {
      switch (error.code) {
        case SdkErrorCode.RequestTimeout:
          return new McplRequestError(
            `${prefix} did not answer ${what}${timeoutMs ? ` within ${timeoutMs}ms` : ''}. Cancellation was requested; ` +
              `the outcome is unknown: the tool may still complete server-side. Verify state before retrying; ` +
              `a blind retry of a side-effecting tool may duplicate it.`,
            'no-response',
          );
        case SdkErrorCode.InvalidResult:
        case SdkErrorCode.UnsupportedResultType:
        case SdkErrorCode.InputRequiredRoundsExceeded:
        case SdkErrorCode.CapabilityNotSupported:
          return new Error(`${prefix} answered ${what}, but the result can't be used: ${error.message}`);
        default:
          return new McplRequestError(`${prefix} ${what} failed: ${error.message}`, 'no-response');
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return new McplRequestError(`${prefix} ${what} failed: ${message}`, 'no-response');
  }
}
