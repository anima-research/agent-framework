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
 * - **Request outcomes from the wire.** A failed call is classified by what
 *   crossed Connectome's transport boundary, never by the error's class. The
 *   SDK raises the same error classes locally (an invalid outputSchema before
 *   dispatch, output validation after a successful result) as it does for
 *   server answers.
 * - **Lifetime.** On a lost transport the connection restarts with the same
 *   backoff settings as legacy, when `reconnect` is set. List-change
 *   awareness is kept while the connection lives: a subscription the server
 *   advertises but that didn't open, or that ended, is reopened. Each connect
 *   is a generation, so a superseded client never touches a newer one.
 *   `close()` owns a connect in flight too.
 *
 * Nothing here is MCPL: a modern server has no grant, no planes and no
 * server→host requests. The framework uses this connection only through its
 * tool paths, and the MCPL machinery never sees it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  parseJSONRPCMessage,
  type AuthProvider,
  type CallToolResult,
  type JSONRPCMessage,
  type McpSubscription,
  type MessageExtraInfo,
  type Transport,
  type TransportSendOptions,
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
/** Startup stderr kept for the first listener. */
const STDERR_BACKLOG_LINES = 200;

/** A modern tool result as the framework consumes it. `structuredContent` is
 *  kept by presence: `false`, `0` and `null` are values, not absence. */
export interface ModernToolCallResult {
  content: CallToolResult['content'];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

/**
 * What crossed Connectome's transport boundary for one logical request: were
 * any of its requests handed to the transport, and how did the server answer
 * the most recent one? A logical call can take several legs: a
 * header-mismatch retry, or the rounds of an `input_required` continuation.
 */
interface WireRecord {
  readonly method: string;
  handedOff: boolean;
  currentId?: string | number;
  answer: 'none' | 'result' | 'error';
  error?: { code: number; message: string; data?: unknown };
}

/** The logical request a send belongs to. The SDK hands each request to the
 *  transport inside the caller's async chain, so the scope reaches `send`. */
const wireScope = new AsyncLocalStorage<WireRecord>();

/**
 * The boundary between the SDK and the actual transport. It records, for the
 * logical request in scope, each request of the observed method that it
 * hands on, and the answer that comes back for it. Everything else passes
 * through untouched: the SDK sees the inner transport's own members.
 */
class ObservedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly awaiting = new Map<string | number, WireRecord>();

  constructor(private readonly inner: Transport) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      // An answer to a request in scope is handed to the SDK inside that
      // request's scope. The SDK drives an input_required continuation from
      // this very callback, outside the caller's async chain, and the next
      // leg's send must still be recorded against the right call.
      const record = this.observe(message);
      if (record) wireScope.run(record, () => this.onmessage?.(message, extra));
      else this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const record = wireScope.getStore();
    if (record && 'method' in message && 'id' in message && message.method === record.method) {
      // Handed off from here on: past this point nothing proves it unsent.
      record.handedOff = true;
      record.currentId = message.id;
      record.answer = 'none';
      record.error = undefined;
      this.awaiting.set(message.id, record);
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  /** Drop a finished request's entries (unanswered legs included). */
  forget(record: WireRecord): void {
    for (const [id, entry] of this.awaiting) if (entry === record) this.awaiting.delete(id);
  }

  /** Record an answer to a request in scope; returns its record when it
   *  answers that record's current leg. */
  private observe(message: JSONRPCMessage): WireRecord | undefined {
    if (typeof message !== 'object' || message === null) return undefined;
    if (!('id' in message) || (!('result' in message) && !('error' in message))) return undefined;
    const record = this.awaiting.get(message.id as string | number);
    if (!record) return undefined;
    this.awaiting.delete(message.id as string | number);
    // A superseded leg's late answer says nothing about the current one.
    if (record.currentId !== message.id) return undefined;
    if ('error' in message) {
      record.answer = 'error';
      record.error = message.error as WireRecord['error'];
    } else {
      record.answer = 'result';
    }
    return record;
  }
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
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private line: McplTransport | null = null;

  constructor(
    private readonly config: McplServerConfig,
    private readonly onStderr: (line: string) => void,
  ) {}

  async start(): Promise<void> {
    const line = StdioTransport.spawn(this.config);
    this.line = line;
    line.on('line', (text: string) => {
      // A line that isn't JSON is ignored, as the legacy engine ignores it.
      // A line that is JSON but not a JSON-RPC message (`null`, an array, a
      // bare value) is a diagnostic. It must never reach a handler that
      // assumes the shape: thrown from this callback, it would end the host.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      let message: JSONRPCMessage;
      try {
        message = parseJSONRPCMessage(parsed);
      } catch (error) {
        this.onerror?.(new Error(
          `MCP server "${this.config.id}" sent a malformed JSON-RPC message (${text.length > 200 ? `${text.slice(0, 200)}…` : text}): ` +
            (error instanceof Error ? error.message.split('\n')[0] : String(error)),
        ));
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

/** One connect generation's client and the boundary it talks through. */
interface Session {
  readonly generation: number;
  readonly client: Client;
  readonly wire: ObservedTransport;
}

export class ModernMcpConnection extends EventEmitter {
  readonly id: string;
  readonly family = 'modern' as const;
  readonly transportKind: 'stdio' | 'http';
  /** The pinned revision, once a connect has established it; null before. */
  protocolVersion: string | null = null;

  private session: Session | null = null;
  /** A connect in flight, owned so `close()` can end it. */
  private opening: { session: Session; done: Promise<void> } | null = null;
  private generation = 0;
  private closedByHost = false;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectIntervalMs: number;
  private readonly reconnectMaxIntervalMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** At most one pending reopen, and only ever for the current generation. */
  private relisten: { generation: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private relistenAttempts = 0;
  /**
   * Generations whose cleanup could not confirm their child exited. While any
   * is held, no replacement is started: launching another would orphan the
   * first. close() retries them and reports what still fails.
   */
  private unreaped: Array<{ session: Session; failure: Error }> = [];
  /** Child stderr from before anyone listens (the caller attaches only once
   *  connect() returns), delivered to the first listener. Bounded: the
   *  newest lines are kept. */
  private stderrBacklog: string[] = [];

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
    this.on('newListener', (event: string | symbol) => {
      if (event !== 'stderr' || this.stderrBacklog.length === 0) return;
      const pending = this.stderrBacklog;
      this.stderrBacklog = [];
      // After the listener is added (newListener fires just before).
      queueMicrotask(() => { for (const line of pending) this.emit('stderr', { line }); });
    });
  }

  private deliverStderr(line: string): void {
    if (this.listenerCount('stderr') > 0) {
      this.emit('stderr', { line });
      return;
    }
    this.stderrBacklog.push(line);
    if (this.stderrBacklog.length > STDERR_BACKLOG_LINES) this.stderrBacklog.shift();
  }

  /** The per-call deadline: `requestTimeoutMs`, validated positive. */
  get requestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get isConnected(): boolean {
    return this.session !== null;
  }

  /** Whether a lost connection will be re-established in the background. */
  get willReconnect(): boolean {
    return this.reconnectEnabled && !this.closedByHost && this.unreaped.length === 0;
  }

  /** A failed generation's cleanup couldn't reap its child: keep owning it,
   *  and halt reconnecting until close() settles it. */
  private holdUnreaped(session: Session, failure: Error): void {
    this.unreaped.push({ session, failure });
    this.emit('error', new Error(
      `MCP server "${this.id}": ${failure.message}. Not starting another launch while it may still be running; close the connection to retry the reap.`,
    ));
  }

  /** The halt, as a permanent failure for the reconnect events. */
  private unreapedFailure(): string | null {
    const held = this.unreaped[0];
    return held ? `the previous launch could not be reaped (${held.failure.message}); reconnecting is halted` : null;
  }

  /**
   * A connection that hasn't started: configuration is validated (and
   * throws), nothing is launched or dialed. An owner can register it, and
   * wire its events, before {@link start}, so a connect in flight is
   * already the owner's to close.
   */
  static create(config: McplServerConfig): ModernMcpConnection {
    return new ModernMcpConnection(config);
  }

  /**
   * The first connect. Without `reconnect` a failure throws. With it, the
   * connection keeps retrying in the background, as the legacy engine's
   * stub does, and reports `connect-failed`. A connection closed before or
   * during its first connect resolves unconnected.
   */
  async start(): Promise<void> {
    try {
      await this.open();
    } catch (error) {
      if (this.closedByHost) return;
      if (!this.reconnectEnabled) throw error;
      const halted = this.unreapedFailure();
      if (halted) {
        this.emit('connect-failed', { error: `${(error as Error).message}; ${halted}`, attempt: 0, permanent: true });
        return;
      }
      console.error(`MCP server "${this.id}" initial connect failed, will retry:`, (error as Error).message);
      this.reconnectAttempts = 1;
      this.emit('connect-failed', { error: (error as Error).message, attempt: 0 });
      this.scheduleReconnect();
    }
  }

  /** {@link create} and {@link start} in one step. */
  static async connect(config: McplServerConfig): Promise<ModernMcpConnection> {
    const connection = ModernMcpConnection.create(config);
    await connection.start();
    return connection;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.closedByHost;
  }

  /** One connect generation: a fresh client over a fresh transport. */
  private async open(): Promise<void> {
    // Closed before this connect began: launch nothing.
    if (this.closedByHost) return;
    const generation = ++this.generation;
    this.cancelRelisten();
    const inner: Transport = this.transportKind === 'stdio'
      ? new SpawnerStdioTransport(this.config, (line) => { if (this.isCurrent(generation)) this.deliverStderr(line); })
      : new StreamableHTTPClientTransport(new URL(this.config.url!), { authProvider: bearerAuth(this.config) });
    const wire = new ObservedTransport(inner);

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
            onChanged: () => { if (this.isCurrent(generation)) this.emit('tools-list-changed'); },
          },
        },
      },
    );
    client.onerror = (error: Error) => {
      // The SDK reports late responses to deadline-abandoned calls here
      // ("unknown message ID"), and a list-change subscription it could not
      // open at connect, among other out-of-band errors. They are logged,
      // never delivered: the call's outcome was already reported.
      if (this.isCurrent(generation)) this.emit('error', error);
    };
    client.onclose = () => {
      if (this.isCurrent(generation)) this.handleLost(generation, 'transport closed');
    };

    const session: Session = { generation, client, wire };
    const done = client.connect(wire, { timeout: CONNECT_TIMEOUT_MS });
    this.opening = { session, done };
    try {
      await done;
    } catch (error) {
      const failure = await ModernMcpConnection.closeSession(session);
      if (failure) this.holdUnreaped(session, failure);
      throw error;
    } finally {
      if (this.opening?.session === session) this.opening = null;
    }
    if (!this.isCurrent(generation)) {
      // Superseded or closed while connecting: this generation never serves.
      const failure = await ModernMcpConnection.closeSession(session);
      if (failure) this.holdUnreaped(session, failure);
      return;
    }
    this.session = session;
    this.protocolVersion = MODERN_MCP_PROTOCOL_VERSION;
    this.reconnectAttempts = 0;
    this.keepListening(session, client.autoOpenedSubscription);
  }

  /**
   * Keep list-change awareness while this generation lives. The SDK opens the
   * subscription at connect when the server advertises tool list changes. If
   * that open failed (the SDK reports it through `onerror` and connects
   * anyway), or the subscription later ends without our asking, it is
   * reopened with backoff. Once it's back the inventory is refreshed, since
   * changes may have been missed. A lost transport is the reconnect path's
   * job, not this one's.
   */
  private keepListening(session: Session, subscription: McpSubscription | undefined): void {
    if (!session.client.getServerCapabilities()?.tools?.listChanged) return;
    if (!subscription) {
      this.scheduleRelisten(session.generation);
      return;
    }
    void subscription.closed.then((reason) => {
      if (reason === 'local' || this.session !== session || !this.isCurrent(session.generation)) return;
      this.scheduleRelisten(session.generation);
    });
  }

  private cancelRelisten(): void {
    if (this.relisten) clearTimeout(this.relisten.timer);
    this.relisten = null;
  }

  private scheduleRelisten(generation: number): void {
    if (!this.isCurrent(generation)) return;
    if (this.relisten?.generation === generation) return;
    this.cancelRelisten();
    const timer = setTimeout(() => {
      if (this.relisten?.timer === timer) this.relisten = null;
      void this.reopenSubscription(generation);
    }, this.backoffDelay(Math.max(1, this.relistenAttempts)));
    timer.unref?.();
    this.relisten = { generation, timer };
  }

  private async reopenSubscription(generation: number): Promise<void> {
    const session = this.session;
    if (!session || session.generation !== generation || !this.isCurrent(generation)) return;
    try {
      const subscription = await session.client.listen({ toolsListChanged: true }, { timeout: CONNECT_TIMEOUT_MS });
      if (this.session !== session || !this.isCurrent(generation)) {
        await subscription.close().catch(() => {});
        return;
      }
      this.relistenAttempts = 0;
      this.keepListening(session, subscription);
      this.emit('tools-list-changed');
    } catch (error) {
      if (this.session !== session || !this.isCurrent(generation)) return;
      this.relistenAttempts++;
      this.emit('error', new Error(`MCP server "${this.id}" could not reopen its list-change subscription: ${(error as Error).message}`));
      this.scheduleRelisten(generation);
    }
  }

  /** The transport went away (child exit, or a closed HTTP client). */
  private handleLost(generation: number, reason: string): void {
    if (this.session?.generation !== generation) return;
    this.session = null;
    this.cancelRelisten();
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
    if (!this.willReconnect || this.session) return;
    const attempt = Math.max(1, this.reconnectAttempts);
    try {
      await this.open();
      if (!this.session) return;
      console.error(`MCP server "${this.id}" reconnected`);
      this.emit('reconnect', { attempts: attempt });
    } catch (error) {
      if (this.closedByHost) return;
      this.reconnectAttempts = attempt + 1;
      const halted = this.unreapedFailure();
      if (halted) {
        this.emit('reconnect-failed', { error: `${(error as Error).message}; ${halted}`, attempt, permanent: true });
        return;
      }
      this.emit('reconnect-failed', { error: (error as Error).message, attempt });
      this.scheduleReconnect();
    }
  }

  /**
   * The server's complete tool inventory. The SDK follows every page; one
   * budget, {@link LIST_TIMEOUT_MS}, bounds the whole walk, not each page.
   * Its failures use the request-outcome contract with `tools/list` as the
   * observed method. A relist the SDK makes inside a tool call is auxiliary
   * to that call, and leaves the call's evidence alone.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    const { tools } = await this.request('tools/list', 'tools/list', (client) =>
      client.listTools(undefined, {
        cacheMode: 'refresh',
        timeout: LIST_TIMEOUT_MS,
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      }), LIST_TIMEOUT_MS);
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool._meta !== undefined ? { _meta: tool._meta as Record<string, unknown> } : {}),
    }));
  }

  /**
   * Call a tool within the configured deadline. One budget covers the whole
   * logical call: the SDK's per-leg timer and its `maxTotalTimeout` across
   * continuation rounds, and an abort signal around any retry the SDK makes
   * before dispatch (an auth refresh, or a header-mismatch relist).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ModernToolCallResult> {
    const timeoutMs = this.requestTimeoutMs;
    const result = await this.request('tools/call', `tools/call "${name}"`, (client) =>
      client.callTool(
        { name, arguments: args },
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) },
      ), timeoutMs);
    return {
      content: result.content ?? [],
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
      ...('structuredContent' in result ? { structuredContent: result.structuredContent } : {}),
      ...(result._meta !== undefined ? { _meta: result._meta as Record<string, unknown> } : {}),
    };
  }

  /** Run one logical request in a wire scope, and classify its failure by
   *  what that scope saw. */
  private async request<T>(method: string, what: string, run: (client: Client) => Promise<T>, timeoutMs?: number): Promise<T> {
    const session = this.session;
    if (!session) {
      // Connectome refuses before anything reaches the SDK: provably not sent.
      throw new McplRequestError(`Cannot send ${what}: connection to "${this.id}" is not established`, 'not-sent');
    }
    const record: WireRecord = { method, handedOff: false, answer: 'none' };
    try {
      return await wireScope.run(record, () => run(session.client));
    } catch (error) {
      throw this.requestFailure(what, record, error, timeoutMs);
    } finally {
      session.wire.forget(record);
    }
  }

  /**
   * Close one generation: the transport first (during discovery the SDK
   * hasn't attached it yet, so only closing it ends the probe), then the
   * client. The transport's close is the reaping verdict, and its failure is
   * returned, never swallowed.
   */
  private static async closeSession(session: Session): Promise<Error | null> {
    let failure: Error | null = null;
    try {
      await session.wire.close();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    await session.client.close().catch(() => { /* SDK teardown; the verdict is the transport's */ });
    return failure;
  }

  /** Close for good: no reconnect, no reopened subscription, no connect left
   *  in flight. Awaits the in-flight connect's end, and rejects if a child
   *  could not be reaped. */
  async close(): Promise<void> {
    this.closedByHost = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancelRelisten();
    const failures: Error[] = [];
    const opening = this.opening;
    if (opening) {
      // Closing the transport ends the probe; the connect then rejects and
      // its own cleanup runs. Wait for that, so nothing outlives close().
      const failure = await ModernMcpConnection.closeSession(opening.session);
      if (failure) failures.push(failure);
      await opening.done.catch(() => {});
    }
    const session = this.session;
    this.session = null;
    if (session) {
      const failure = await ModernMcpConnection.closeSession(session);
      if (failure) failures.push(failure);
      this.emit('close', { reason: 'closed by host' });
    }
    // Generations a failed cleanup couldn't reap: try again, report the rest.
    const held = this.unreaped;
    this.unreaped = [];
    for (const { session: stuck } of held) {
      const failure = await ModernMcpConnection.closeSession(stuck);
      if (failure) failures.push(failure);
    }
    if (failures.length > 0) {
      throw new Error(`MCP server "${this.id}" did not close cleanly: ${failures.map((f) => f.message).join('; ')}`);
    }
  }

  /**
   * Map a failure onto the request-outcome contract by what crossed the
   * transport boundary for this request, claiming no more than that shows:
   * - nothing handed to the transport: `not-sent`, whatever the SDK raised
   *   (a pre-dispatch validation, a signal already aborted, no transport);
   * - an HTTP 401/403 refusal: `error-response`. The server answered, at the
   *   HTTP layer, so the status is in `data.httpStatus` and `code` stays the
   *   JSON-RPC code space's (absent);
   * - the most recent leg answered with a JSON-RPC error: `error-response`
   *   with that error's code and data;
   * - the most recent leg answered with a result: the server acted, but what
   *   it returned can't be used (output validation, input this client can't
   *   supply, a rounds cap). That's a plain error, not a request outcome;
   * - handed off and unanswered: `no-response`. At the deadline, cancellation
   *   was requested and the outcome is unknown.
   */
  private requestFailure(what: string, record: WireRecord, error: unknown, timeoutMs?: number): Error {
    const prefix = `MCP server "${this.id}"`;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SdkHttpError && (error.code === SdkErrorCode.ClientHttpAuthentication || error.code === SdkErrorCode.ClientHttpForbidden)) {
      const data = error.data && typeof error.data === 'object' ? error.data : {};
      return new McplRequestError(`${prefix} refused ${what}: HTTP ${error.status} (${message})`, 'error-response', undefined, { ...data, httpStatus: error.status });
    }
    if (!record.handedOff) {
      return new McplRequestError(`${prefix} ${what} was not sent: ${message}`, 'not-sent');
    }
    if (record.answer === 'error' && record.error) {
      const { code, message: wireMessage, data } = record.error;
      return new McplRequestError(`${prefix} returned error for ${what}: [${code}] ${wireMessage}`, 'error-response', code, data);
    }
    if (record.answer === 'result') {
      return new Error(`${prefix} answered ${what}, but the result can't be used: ${message}`);
    }
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
      return new McplRequestError(
        `${prefix} did not answer ${what}${timeoutMs ? ` within ${timeoutMs}ms` : ''}. Cancellation was requested; ` +
          `the outcome is unknown: the tool may still complete server-side. Verify state before retrying; ` +
          `a blind retry of a side-effecting tool may duplicate it.`,
        'no-response',
      );
    }
    return new McplRequestError(`${prefix} ${what} failed: ${message}`, 'no-response');
  }
}
