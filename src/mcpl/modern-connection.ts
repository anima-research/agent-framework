/**
 * ModernMcpConnection: a server reached through the official SDK client, over
 * stdio at MCP 2026-07-28, or over Streamable HTTP at the revision negotiated
 * at each connect: 2026-07-28 when the server offers it, and otherwise
 * 2025-11-25, 2025-06-18 or 2025-03-26.
 *
 * Responsibilities divide like this. The SDK owns the wire: negotiation
 * (`server/discover`, falling back to `initialize` over HTTP), the per-request
 * `_meta` envelope, `resultType`, continuation of `input_required` results,
 * cancellation, list-change subscriptions (2026-07-28) and notifications
 * (2025), and the HTTP binding's headers, session id, auth retry and
 * header-mismatch handling. This class owns what Connectome decides:
 * - **stdio** runs through Connectome's own spawner, so the child gets the
 *   same env allowlist, `inheritEnv` and stderr surfacing as a legacy server,
 *   and it starts once per connect. The SDK's own stdio transport starts a
 *   throwaway second copy for discovery.
 * - **HTTP credentials** come from `token`/`accessProvider`: a cached bearer
 *   token, re-resolved once when the server answers 401.
 * - **One deadline per tool call** (`requestTimeoutMs`, always positive)
 *   bounds every leg of the call and the pauses between them. At the
 *   deadline the SDK requests cancellation of a leg in flight; between
 *   continuation rounds nothing is in flight. Either way the outcome is
 *   unknown. Calls are never replayed. The protocol has no cancel for a
 *   call paused at `input_required`, so whatever the server holds for it,
 *   beyond the `requestState` it gave this client, stays until the server
 *   lets it go.
 * - **Request outcomes from the wire.** A failed call is classified by what
 *   crossed Connectome's transport boundary, never by the error's class. The
 *   SDK raises the same error classes locally (an invalid outputSchema before
 *   dispatch, output validation after a successful result) as it does for
 *   server answers. A call's answer is the server's final one: an
 *   `input_required` answer asks for another round, so a call that ends
 *   after one has no answer. On a 2025 revision every result is final.
 * - **Lifetime.** On a lost transport the connection restarts with the same
 *   backoff settings as legacy, when `reconnect` is set, once the lost
 *   launch is reaped, so a second child never runs beside the first. A
 *   stdio child that stays alive but silently stops reading its stdin is
 *   no loss the pipes show: each call's deadline is the only bound on it.
 *   A server that shares no revision with this client is a configuration
 *   verdict, as for legacy (`McplProtocolVersionError`): it is never
 *   retried. List-change awareness is kept while the connection lives: on
 *   2026-07-28, a subscription the server advertises but that didn't open,
 *   or that ended, is reopened; on a 2025 revision, the session's standalone
 *   stream, which carries its list changes, is opened and reopened while the
 *   session lives, with a session id or without, unless the server answers
 *   its first open with a status that won't pass (`mayPass`), such as a 405,
 *   which offers no stream. Each connect is a generation, so a superseded
 *   client never touches a newer one. `close()` owns a connect in flight
 *   too.
 * - **A 2025 session over HTTP** ends when the server answers 404 to a
 *   request that carried its id, but for the standalone stream's first open,
 *   or stops serving its revision (a 400 carrying -32022) or its streams (a
 *   405 to a GET for one it had served), as a server upgraded to the SDK's
 *   2026 handler does (`sessionEnded`). A new connect starts at once if the
 *   old session had served a request ('close', then 'reconnect'), and
 *   negotiates afresh, unless it lived less than a base interval, as did the
 *   last one restarted that way; otherwise the end is a failed connect. A
 *   request's stream the server cut is resumed for as long as the request
 *   lives. Closing a generation DELETEs a session the server holds by its
 *   id, a failed connect's included.
 *
 * Nothing here is MCPL: a modern server has no grant, no planes and no
 * server→host requests. The framework uses this connection only through its
 * tool paths, and the MCPL machinery never sees it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

import {
  Client,
  InsufficientScopeError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  parseJSONRPCMessage,
  type AuthProvider,
  type CallToolResult,
  type FetchLike,
  type JSONRPCMessage,
  type McpSubscription,
  type MessageExtraInfo,
  type ReconnectionScheduler,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client';

import { HeldStderr, STDERR_END_WAIT_MS, StdioTransport, type McplTransport, type TransportCloseInfo } from './transport.js';
import { McplProtocolVersionError, McplRequestError, McplUnreapedLaunchError, stderrTailOf, withStderr } from './server-connection.js';
import { LEGACY_MCP_PROTOCOL_VERSION, MAX_TIMER_MS, MODERN_HTTP_PROTOCOL_VERSIONS, MODERN_MCP_PROTOCOL_VERSION, checkServerConfig, describeCredentialError, logDroppedLine, maskedError, noteDialSent, redactServerText, redactedData, serverTextRedactor, type ServerTextRedactor } from './protocol-family.js';
import type { McplServerConfig, McpToolDefinition } from './types.js';
import { boundedForLog } from './errors.js';
import { logDetail, logValue, logValueRedacted, loggedCode } from './log-value.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Bound on each request of establishing the connection (`server/discover`,
 *  and over HTTP `initialize`), like the legacy engine's initialize timeout. */
const CONNECT_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 3_000;
const HTTP_2025_REVISIONS: ReadonlySet<string> = new Set(MODERN_HTTP_PROTOCOL_VERSIONS.filter((version) => version !== MODERN_MCP_PROTOCOL_VERSION));
/** StreamableHTTPClientTransport's default `maxRetries`. */
const SDK_STREAM_RETRIES = 2;
const SESSION_END = {
  ended: 'ended its session (HTTP 404)',
  revision: "refused its session's revision (HTTP 400, -32022)",
  stream: "stopped serving its session's streams (HTTP 405)",
} as const;
/**
 * An answer to the standalone stream's first open that may pass, so it is
 * tried again (see `firstOpen`): a timeout (408), a stream the server still
 * holds for this session from a try whose answer never reached us (409), a
 * rate limit (429), or a server error, except 501 and 505, which say this
 * server never will.
 */
const mayPass = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || (status >= 500 && status !== 501 && status !== 505);
/**
 * The reason a call whose stream was lost fails with (see WireRecord's
 * `cancel`). An SdkError, so the SDK passes it on as it is, where it reads
 * any other abort reason as a timeout.
 */
const lostStream = (): SdkError =>
  new SdkError(SdkErrorCode.ConnectionClosed, 'the stream that would carry its answer ended, and could not be resumed');
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
 * What crossed Connectome's transport boundary for one logical request: were
 * any of its requests handed to the transport, and how did the server answer
 * the most recent one? A logical call can take several legs: a
 * header-mismatch retry, or the rounds of an `input_required` continuation.
 * Only an error or a `complete` result is the server's final answer.
 * `input-required` asks for another round, and a result of any other type,
 * or of none (`unrecognized`), doesn't say the call finished. On a 2025
 * revision, whose results carry no type, every result is final.
 */
interface WireRecord {
  readonly method: string;
  handedOff: boolean;
  currentId?: string | number;
  /** The current leg's answer. */
  answer: 'none' | 'error' | 'complete' | 'input-required' | 'unrecognized';
  error?: { code: number; message: string; data?: unknown };
  /** An earlier leg's answer asked for another round (or wasn't a complete
   *  result): the server may have acted on the call, whatever a later leg
   *  meets. A new leg's send never clears it. */
  continued: boolean;
  /** Read at the HTTP layer (`observedFetch`), since ending the session
   *  closes the client, which can fail the call before the transport's own
   *  error reaches it: `ended` for a 404, `revision` for a 400 carrying
   *  -32022. */
  sessionEnded?: 'ended' | 'revision';
  /**
   * The call's own abort, given to the SDK, which cancels the call when it
   * fires: at the call's deadline, or as soon as the stream that would carry
   * the current leg's answer ends unanswered and can't be resumed (see
   * ObservedTransport's `send`). Either way the call reports `no-response`.
   */
  readonly cancel: AbortController;
}

class NotWrittenError extends Error {
  readonly stdioStopped: boolean;
  constructor(message: string, stdioStopped = false) {
    super(message);
    this.name = 'NotWrittenError';
    this.stdioStopped = stdioStopped;
  }
}

/**
 * The logical request a send belongs to. The SDK hands each request to the
 * transport inside the caller's async chain, so the scope reaches `send` and
 * the request's POST (see observedFetch). Anything else started on that chain
 * carries the scope too: a session's end queued from a call's fetch restarts
 * the session inside that call's scope, the new session's requests included.
 * So a POST's scope alone doesn't make it that call's: its body's id must be
 * the call's current leg.
 */
const wireScope = new AsyncLocalStorage<WireRecord>();

interface NegotiationEvidence {
  listed?: { versions: string[]; code?: number; data?: unknown };
  initialize?: { version: string | null } | { refused: true };
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : undefined;

/** A send in flight, its transport, and what that transport reported
 *  meanwhile, held until the send settles (ObservedTransport.send). A
 *  scope that names no transport, a notification's or a settled send's,
 *  holds nothing. */
const sendScope = new AsyncLocalStorage<{ wire: ObservedTransport | null; held: Error[] }>();

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
  private readonly negotiating = new Map<string | number, string>();
  readonly negotiation: NegotiationEvidence = {};
  private established = false;
  private finalResults = false;
  answered = false;
  /**
   * Streamable HTTP stops a request's stream when the request's signal fires,
   * and stops resuming it. The SDK gives a request such a signal only on
   * 2026-07-28 over HTTP, and never cancels an unanswered `initialize`. The
   * stdio transport ignores it.
   */
  private readonly aborts = new Map<string | number, AbortController>();

  /**
   * @param beforeClose runs at each close before the inner transport closes,
   * while it can still send: an HTTP session's DELETE. The SDK closes the
   * transport through this boundary when a handshake fails, before the error
   * reaches the connection.
   */
  constructor(private readonly inner: Transport, private readonly beforeClose?: () => Promise<void>) {}

  establish(era: 'modern' | 'legacy'): void {
    this.established = true;
    this.finalResults = era === 'legacy';
  }

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
      if (typeof message === 'object' && message !== null && 'id' in message && ('result' in message || 'error' in message)) {
        this.noteNegotiation(message);
        if (message.id !== undefined) this.aborts.delete(message.id);
        if (this.established) this.answered = true;
      }
      // An answer to a request in scope is handed to the SDK inside that
      // request's scope. The SDK drives an input_required continuation from
      // this very callback, outside the caller's async chain, and the next
      // leg's send must still be recorded against the right call.
      const record = this.observe(message);
      if (record) wireScope.run(record, () => this.onmessage?.(message, extra));
      else this.onmessage?.(message, extra);
    };
    // An error this transport reports while one of its sends is in flight
    // waits for that send to settle: the SDK's HTTP send reports a failure
    // here and then throws it, and whoever sent it reports what it throws
    // (#556). Anything else is reported at once, another transport's report
    // made in a send's async context too.
    this.inner.onerror = (error) => {
      const sending = sendScope.getStore();
      if (sending?.wire === this) sending.held.push(error);
      else this.onerror?.(error);
    };
    this.inner.onclose = () => this.onclose?.();
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ('method' in message && 'id' in message && (message.method === 'server/discover' || message.method === 'initialize')) {
      this.negotiating.set(message.id, message.method);
    }
    if ('method' in message && message.method === 'notifications/cancelled') {
      // The request is over for the SDK, which rejected it as it cancelled:
      // its stream stops now, whatever becomes of this notification's POST.
      const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof id === 'string' || typeof id === 'number') {
        this.aborts.get(id)?.abort();
        this.aborts.delete(id);
      }
    }
    if ('method' in message && !('id' in message)) {
      // A notification's sender can swallow what its send throws (the SDK's
      // listen teardown does), so what its transport reports is reported at
      // once, whatever send it was made in.
      await sendScope.run({ wire: null, held: [] }, () => this.inner.send(message, options));
      return;
    }
    const record = wireScope.getStore();
    let undo: (() => void) | undefined;
    if (record && 'method' in message && 'id' in message && message.method === record.method) {
      // Every transport writes a message as JSON, so one JSON can't write (a
      // BigInt, a cycle) never leaves this host: it's refused here, before
      // it's marked handed off (#556).
      JSON.stringify(message);
      const prior = { handedOff: record.handedOff, currentId: record.currentId, answer: record.answer, error: record.error, sessionEnded: record.sessionEnded };
      // Handed off from here on: past this point nothing proves it unsent,
      // unless the transport says it wrote nothing.
      record.handedOff = true;
      record.currentId = message.id;
      record.answer = 'none';
      record.error = undefined;
      record.sessionEnded = undefined;
      this.awaiting.set(message.id, record);
      undo = () => {
        this.awaiting.delete(message.id);
        Object.assign(record, prior);
      };
    }
    let sendOptions = options;
    if ('method' in message && 'id' in message && options?.requestSignal === undefined) {
      const abort = new AbortController();
      this.aborts.set(message.id, abort);
      sendOptions = { ...options, requestSignal: abort.signal };
    }
    if (undo && record && 'id' in message && sendOptions?.onRequestStreamEnd === undefined) {
      // The transport calls this once the stream that would carry this leg's
      // answer is over: after the answer, or without it, when the stream
      // can't be resumed. That is a stream that ended with no event id to
      // resume from, a resume answered 405 or with no body, or the
      // transport's retries spent (two on 2026-07-28; on 2025 it has no
      // limit). Unanswered, the call is lost, so it fails now rather than at
      // its deadline. A 2026-07-28 listen brings its own.
      const leg = message.id;
      sendOptions = {
        ...sendOptions,
        onRequestStreamEnd: () => {
          if (record.currentId === leg && record.answer === 'none') record.cancel.abort(lostStream());
        },
      };
    }
    // A request's or a response's sender reports what its send throws: a
    // call through its outcome, the connect through its failure, the SDK
    // through its own report. So what the transport reports meanwhile is held
    // here, and the failure the send threw isn't reported a second time (#556).
    const sending: { wire: ObservedTransport | null; held: Error[] } = { wire: this, held: [] };
    let thrown: unknown;
    try {
      await sendScope.run(sending, () => this.inner.send(message, sendOptions));
    } catch (error) {
      thrown = error;
      // Refused before any write: this leg never reached the server, so the
      // record is as it was before it. Any other throw (an HTTP send can fail
      // after part of the request went out) leaves it handed off.
      if (error instanceof NotWrittenError) undo?.();
      // The SDK settles a request whose send failed itself: nothing cancels it.
      if ('method' in message && 'id' in message) this.aborts.delete(message.id);
      throw error;
    } finally {
      // Settled: what was held goes on, but for the failure the send threw,
      // and the scope lets go of this transport, which work the send started
      // still carries.
      const { held } = sending;
      sending.wire = null;
      sending.held = [];
      for (const error of held) if (error !== thrown) this.onerror?.(error);
    }
  }

  async close(): Promise<void> {
    await this.beforeClose?.();
    await this.inner.close();
  }

  /** Drop a finished request's legs from `awaiting`, unanswered legs
   *  included. (Its abort, over HTTP, goes as `aborts` says.) */
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
      const result = (message as { result?: unknown }).result;
      const type = typeof result === 'object' && result !== null ? (result as { resultType?: unknown }).resultType : undefined;
      record.answer = this.finalResults || type === 'complete' ? 'complete' : type === 'input_required' ? 'input-required' : 'unrecognized';
      if (record.answer !== 'complete') record.continued = true;
    }
    return record;
  }

  private noteNegotiation(message: JSONRPCMessage): void {
    const id = (message as { id: string | number }).id;
    const step = this.negotiating.get(id);
    if (step === undefined) return;
    this.negotiating.delete(id);
    if ('error' in message) {
      if (step === 'initialize') {
        this.negotiation.initialize = { refused: true };
        return;
      }
      const { code, data } = message.error as { code: number; data?: unknown };
      const versions = code === -32022 ? stringList((data as { supported?: unknown } | undefined)?.supported) : undefined;
      if (versions) this.negotiation.listed = { versions, code, data };
      return;
    }
    const result = (message as { result?: unknown }).result as Record<string, unknown> | null | undefined;
    if (step === 'initialize') {
      const version = result?.protocolVersion;
      this.negotiation.initialize = { version: typeof version === 'string' ? version : null };
    } else {
      const versions = stringList(result?.supportedVersions);
      if (versions) this.negotiation.listed = { versions };
    }
  }
}

/**
 * The diagnostic for a line that is JSON but not a JSON-RPC message: the
 * line's first 200 characters, after the configuration's credentials are
 * replaced, so a credential across the cut can't leave its first part.
 */
export function malformedLineDiagnostic(
  config: McplServerConfig,
  text: string,
  error: unknown,
  recorded: (text: unknown) => string = serverTextRedactor(config),
): string {
  // The parser's message can quote the line, so it's redacted too.
  const shown = recorded(text);
  const why = recorded(error instanceof Error ? error.message.split('\n')[0] : error);
  return `MCP server "${config.id}" sent a malformed JSON-RPC message (${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}): ${why}`;
}

/**
 * SDK `Transport` over Connectome's stdio spawner. Framing is the same
 * newline-delimited JSON-RPC as legacy. Lines that are not JSON are dropped,
 * and the first three on a connection that aren't blank are logged by their
 * length, as the legacy engine does. Because this is a custom transport, the
 * SDK runs `server/discover` on this very process instead of starting a
 * throwaway copy, and cancels with `notifications/cancelled`, which is the
 * stdio binding's mechanism.
 */
class SpawnerStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private line: McplTransport | null = null;
  /** How the child ended, once its line has closed: the line's reason, and
   *  the child's exit code or signal. */
  closeInfo: TransportCloseInfo | undefined;
  /** The spawn start() awaits, so a close() made meanwhile closes its child. */
  private spawning: Promise<McplTransport> | null = null;

  /** Built once for the transport: every malformed line uses it. */
  private readonly recorded: (text: unknown) => string;

  constructor(
    private readonly config: McplServerConfig,
    private readonly onStderr: (line: string) => void,
    private readonly onUnreaped: (reason: string, failure: Error) => void,
  ) {
    this.recorded = serverTextRedactor(config);
  }

  async start(): Promise<void> {
    // A command that can't be spawned rejects here, with its spawn error, so
    // the connect fails with it rather than waiting out its discover probe.
    this.spawning = StdioTransport.spawn(this.config);
    const line = await this.spawning;
    this.line = line;
    line.on('line', (text: string) => {
      // A line that isn't JSON is dropped, and the first three on a
      // connection that aren't blank are logged by their length, as the
      // legacy engine does. A line that is JSON but not a JSON-RPC message
      // (`null`, an array, a bare value) is a diagnostic. It must never reach
      // a handler that assumes the shape: thrown from this callback, it would
      // end the host.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        logDroppedLine(this.config.id, text, 'unparsed', line);
        return;
      }
      let message: JSONRPCMessage;
      try {
        message = parseJSONRPCMessage(parsed);
      } catch (error) {
        this.onerror?.(new Error(malformedLineDiagnostic(this.config, text, error, this.recorded)));
        return;
      }
      this.onmessage?.(message);
    });
    line.on('stderr', (text: string) => this.onStderr(text));
    line.on('error', (error: Error) => this.onerror?.(error));
    line.on('close', (info: TransportCloseInfo) => {
      this.closeInfo = info;
      this.onclose?.();
    });
    line.on('unreaped', (failure: Error) => this.onUnreaped(`this host stopped using the server's stdio (${line.stdioStopCause?.message ?? 'an error'})`, failure));
  }

  get stdioStopCause(): Error | undefined {
    return this.line?.stdioStopCause;
  }

  /** The last of the child's stderr, redacted, once the stream has ended or
   *  STDERR_END_WAIT_MS has passed, as the legacy handshake waits before it
   *  refuses; '' when there's no child or it wrote nothing. */
  async stderrTail(): Promise<string> {
    const line = this.line;
    if (!line) return '';
    await line.stderrEnded(STDERR_END_WAIT_MS);
    return line.stderrTailRedacted(serverTextRedactor(this.config)).trimEnd();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.line || this.line.closed) throw new NotWrittenError(`MCP server "${this.config.id}" stdio transport is closed`);
    const stopped = this.stdioStopCause;
    if (stopped) throw new NotWrittenError(`MCP server "${this.config.id}": this host stopped using the server's stdio (${stopped.message})`, true);
    this.line.writeLine(JSON.stringify(message));
  }

  async close(): Promise<void> {
    // A close() during the spawn closes the child it yields. start()
    // awaited the spawn first, so the line is wired by then, and its close
    // ends what the SDK has in flight, as it does after the spawn.
    if (!this.line && this.spawning) await this.spawning.catch(() => null);
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
        if (fresh) {
          // Sent in the Authorization header: the server's text is recorded
          // with it replaced.
          noteDialSent(config, { token: fresh });
          return fresh;
        }
      } catch (error) {
        // Same fallback as the WebSocket dial: use the static token, and let
        // the server refuse a stale credential loudly. The provider's own
        // text may quote the credential, so it isn't logged.
        console.error(
          `[mcp] server "${config.id}": access provider failed (${describeCredentialError(error)}) — using configured fallback`,
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

/** What an HTTP connection's own requests showed at the HTTP layer, which the
 *  transport doesn't report (see `observedFetch`). */
interface HttpObservations {
  readonly transport: StreamableHTTPClientTransport;
  /** The options object the transport keeps and reads at each stream retry. */
  readonly reconnection: { initialReconnectionDelay: number; maxReconnectionDelay: number; reconnectionDelayGrowFactor: number; maxRetries: number };
  ended: boolean;
  deleting?: Promise<void>;
  streamOpened: boolean;
  /**
   * The signal the standalone stream's GETs carry: the transport's own,
   * taken from its first open, the first GET without `Last-Event-ID`. A
   * request stream's resume carries another, its request's signal combined
   * with the transport's, so this tells the two apart, with `Last-Event-ID`
   * or without it.
   */
  standaloneSignal?: AbortSignal | null;
}

/** One connect generation's client and the boundary it talks through. */
interface Session {
  readonly generation: number;
  readonly client: Client;
  readonly wire: ObservedTransport;
  readonly http?: HttpObservations;
  /** Its stdio transport, under `wire`; null over HTTP. */
  readonly stdio: SpawnerStdioTransport | null;
  /** Its transport has closed, whether or not the session was adopted yet. */
  lost: boolean;
}

function bodyId(body: unknown): string | number | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const id = (JSON.parse(body) as { id?: unknown } | null)?.id;
    return typeof id === 'string' || typeof id === 'number' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON-RPC error -32022 (unsupported protocol version) that a 400
 *  carries, read from a copy so the SDK still reads the body itself. */
async function revisionRefusal(response: Response): Promise<{ code: number; message: string; data?: unknown } | undefined> {
  try {
    const error = (await response.clone().json() as { error?: { code?: unknown; message?: unknown; data?: unknown } } | null)?.error;
    if (error?.code !== -32022) return undefined;
    return { code: -32022, message: typeof error.message === 'string' ? error.message : '', ...(error.data !== undefined ? { data: error.data } : {}) };
  } catch {
    return undefined;
  }
}

const joinVersions = (versions: readonly string[], conjunction: 'or' | 'and'): string =>
  versions.length < 2 ? versions.join('') : `${versions.slice(0, -1).join(', ')} ${conjunction} ${versions[versions.length - 1]}`;

export class ModernMcpConnection extends EventEmitter {
  readonly id: string;
  readonly family = 'modern' as const;
  readonly transportKind: 'stdio' | 'http';
  /** The revision the last connect established (over HTTP, the one it
   *  negotiated); null before any has. */
  protocolVersion: string | null = null;

  private session: Session | null = null;
  /** A connect in flight, owned so `close()` can end it. */
  private opening: { session: Session; done: Promise<void> } | null = null;
  private generation = 0;
  private closedByHost = false;
  private reconnectEnabled: boolean;
  private readonly reconnectIntervalMs: number;
  private readonly reconnectMaxIntervalMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private restarting = false;
  private adoptedAt = 0;
  private youngRestartFree = true;
  private stopped = false;
  /** At most one pending reopen, and only ever for the current generation. */
  private relisten: { generation: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private relistenAttempts = 0;
  /**
   * Generations whose cleanup could not confirm their child exited. While any
   * is held, no replacement is started: launching another would orphan the
   * first. close() retries them and reports what still fails.
   */
  private unreaped: Array<{ session: Session; failure: Error }> = [];
  /** A lost session's reap in flight: the reconnect follows it, and
   *  close() waits for it. */
  private losing: { session: Session; done: Promise<void> } | null = null;
  private readonly heldStderr = new HeldStderr();
  private redactor?: ServerTextRedactor;

  /** The server's text with its configuration's credentials replaced, for
   *  the errors this connection hands its caller and its records. */
  private get recorded(): ServerTextRedactor {
    return (this.redactor ??= serverTextRedactor(this.config));
  }

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
      if (this.listenerCount('error') === 1) console.error(`[mcp] ${this.id}: ${redactServerText(error.message, this.config)}`);
    });
    this.on('newListener', (event: string | symbol) => {
      if (event !== 'stderr' || this.heldStderr.empty) return;
      const pending = this.heldStderr.take();
      // After the listener is added (newListener fires just before).
      queueMicrotask(() => { for (const line of pending) this.emit('stderr', { line }); });
    });
  }

  private deliverStderr(line: string): void {
    if (this.listenerCount('stderr') > 0) {
      this.emit('stderr', { line });
      return;
    }
    this.heldStderr.hold(line);
  }

  /** The per-call deadline: `requestTimeoutMs`, validated positive. */
  get requestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get isConnected(): boolean {
    return this.session !== null;
  }

  /** Whether a lost connection will be re-established in the background:
   *  with `reconnect` set, or while a new session starts in place of one the
   *  server ended. */
  get willReconnect(): boolean {
    return (this.reconnectEnabled || this.restarting) && !this.closedByHost && this.unreaped.length === 0;
  }

  /**
   * Stop reconnecting, as the legacy engine's does, leaving the live session
   * open. A session the server ends from then on isn't restarted either (see
   * {@link sessionEnded}), and a reconnect or restart still connecting
   * doesn't come up: its new session is closed.
   * @internal For the framework's stop(); not a host API.
   */
  stopReconnecting(): void {
    this.reconnectEnabled = false;
    this.stopped = true;
  }

  /** Whether close() has been called: closed for good, or closing. A
   *  connection lost on its own is not closed in this sense. */
  get isClosed(): boolean {
    return this.closedByHost;
  }

  /** Whether a child this connection launched couldn't be confirmed exited.
   *  While it's true the connection owns that child, so whatever registered
   *  it keeps its id held; close() retries the reap. It's settled only once
   *  a reap has finished: while a lost session's reap or a close runs, it
   *  may not read true yet, so read it once lossReaped() or close() has
   *  settled. */
  get holdsUnreapedChild(): boolean {
    return this.unreaped.length > 0;
  }

  /** The reap of a session lost on its own, settled once it's done, whether
   *  or not it confirmed the child exited (holdsUnreapedChild says which);
   *  settled at once when no such reap is running. */
  lossReaped(): Promise<void> {
    return this.losing?.done ?? Promise.resolve();
  }

  /** A failed generation's cleanup couldn't reap its child: keep owning it,
   *  and halt reconnecting until close() settles it. It's reported as an
   *  'error' at once, unless the caller reports it later itself. */
  private holdUnreaped(session: Session, failure: Error, report = true): void {
    if (this.unreaped.some((held) => held.session === session)) return;
    this.unreaped.push({ session, failure });
    if (report) this.reportUnreaped(failure);
  }

  private reportUnreaped(failure: Error): void {
    this.emit('error', new Error(
      `MCP server "${this.id}": ${failure.message}. Not starting another launch while it may still be running; close the connection to retry the reap.`,
    ));
  }

  /** The halt, as a permanent failure for the reconnect events. */
  private unreapedFailure(): string | null {
    const held = this.unreaped[0];
    if (!held) return null;
    const halted = this.reconnectEnabled ? '; reconnecting is halted' : '';
    return `the previous launch could not be reaped (${held.failure.message})${halted}`;
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

  /** The first connect, shared by every call to start(). */
  private starting: Promise<void> | null = null;

  /**
   * The first connect. Without `reconnect` a failure throws. With it, the
   * connection keeps retrying in the background, as the legacy engine's
   * stub does, and reports `connect-failed`, unless the failed launch
   * couldn't be reaped: no retry can come then, so it throws too. A
   * connection closed before or during its first connect resolves
   * unconnected. A connection starts once:
   * later calls return the first call's promise, so a second session never
   * opens beside the first.
   */
  start(): Promise<void> {
    return (this.starting ??= this.firstConnect());
  }

  private async firstConnect(): Promise<void> {
    try {
      await this.open();
    } catch (error) {
      if (this.closedByHost) return;
      // No common revision is a configuration fact, not an outage: a retry
      // would restart the server to hear the same answer.
      if (error instanceof McplProtocolVersionError) {
        this.reconnectEnabled = false;
        throw error;
      }
      // Any other failure is the SDK's or the transport's: it goes on as its
      // words alone, redacted, since its message can quote the url and its
      // other properties, such as Bun's fetch error's `path` or a wrapper's
      // `cause`, can carry it whole (maskedError). The protocol refusal
      // above was built from redacted words.
      const masked = maskedError(error, this.recorded);
      const stderrTail = stderrTailOf(error);
      if (stderrTail !== undefined) Object.assign(masked, { stderrTail });
      // A launch that couldn't be reaped halts reconnecting, so no retry
      // will come: the first connect fails, as one without reconnect does.
      if (!this.reconnectEnabled || this.holdsUnreapedChild) throw masked;
      console.error(`MCP server "${this.id}" initial connect failed, will retry: ${masked.message}${withStderr(masked, this.recorded)}`);
      this.reconnectAttempts = 1;
      this.emit('connect-failed', { error: (error as Error).message, ...(stderrTail === undefined ? {} : { stderrTail }), attempt: 0 });
      this.scheduleReconnect();
    }
  }

  /**
   * {@link create} and {@link start} in one step. A first connect that fails
   * and whose cleanup couldn't confirm its child exited throws
   * {@link McplUnreapedLaunchError}, whose connection owns that launch, as
   * the legacy engine's connect does: its close() retries the reap.
   */
  static async connect(config: McplServerConfig): Promise<ModernMcpConnection> {
    const connection = ModernMcpConnection.create(config);
    try {
      await connection.start();
    } catch (error) {
      const held = connection.unreaped[0];
      if (held) throw new McplUnreapedLaunchError(connection, error instanceof Error ? error : new Error(String(error)), held.failure);
      throw error;
    }
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
    // A new generation's subscription has failed nothing yet: its first
    // reopen backs off from the base interval, not from the previous
    // generation's failures.
    this.relistenAttempts = 0;
    let session!: Session;
    let http: HttpObservations | undefined;
    let stdio: SpawnerStdioTransport | null = null;
    let inner: Transport;
    if (this.transportKind === 'stdio') {
      stdio = new SpawnerStdioTransport(
        this.config,
        (line) => { if (this.isCurrent(generation)) this.deliverStderr(line); },
        (reason, failure) => { if (this.isCurrent(generation)) this.handleLost(generation, reason, failure); },
      );
      inner = stdio;
    } else {
      // The transport's own backoff is zeroed, so the delay it hands
      // `streamRetry` is the server's retry hint alone, and `streamRetry`
      // applies the connection's backoff. The retry limit is set once the
      // era settles (see establish): the transport keeps this object and
      // reads `maxRetries` from it at each retry.
      const reconnection = { initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1, maxRetries: Infinity };
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url!), {
        authProvider: bearerAuth(this.config),
        fetch: this.observedFetch(() => session),
        reconnectionOptions: reconnection,
        reconnectionScheduler: this.streamRetry,
      });
      http = { transport, reconnection, streamOpened: false, ended: false };
      inner = transport;
    }
    const wire = new ObservedTransport(inner, http ? () => ModernMcpConnection.endSession(session) : undefined);

    const client = new Client(
      { name: 'agent-framework', version: '1.0.0' },
      {
        ...(this.transportKind === 'http'
          ? { versionNegotiation: { mode: 'auto' as const }, supportedProtocolVersions: [...MODERN_HTTP_PROTOCOL_VERSIONS] }
          : { versionNegotiation: { mode: { pin: MODERN_MCP_PROTOCOL_VERSION } } }),
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
    session = { generation, client, wire, stdio, http, lost: false };
    client.onerror = (error: Error) => {
      // The SDK reports late responses to deadline-abandoned calls here
      // ("unknown message ID"), and a list-change subscription it could not
      // open at connect, among other out-of-band errors. They are emitted as
      // this connection's 'error', so they reach the host's error listeners
      // (and are logged when there are none). They never change a call's
      // outcome, which was already reported.
      if (this.isCurrent(generation)) this.emit('error', error);
    };
    client.onclose = () => {
      // Marked before the session is adopted too: a close during the connect
      // makes it a failed connect (see establish).
      session.lost = true;
      // Over stdio, how its child ended, as legacy's loss carries it.
      const ended = session.stdio?.closeInfo;
      if (this.isCurrent(generation)) this.handleLost(generation, ended?.reason ?? 'transport closed', undefined, ended);
    };

    // `done` settles only once this connect's own cleanup has finished, on
    // every path: close() waits on it, and must not resolve while that
    // cleanup could still find a child it can't reap.
    let settle!: () => void;
    this.opening = { session, done: new Promise<void>((resolve) => { settle = resolve; }) };
    try {
      await this.establish(session);
    } finally {
      if (this.opening?.session === session) this.opening = null;
      settle();
    }
  }

  /** `error` carrying the session's stderr tail as `stderrTail`, as a
   *  legacy connect's failure does, when the child wrote any. */
  private static async withStderrTail(session: Session, error: unknown): Promise<unknown> {
    const tail = await session.stdio?.stderrTail();
    return tail && error instanceof Error ? Object.assign(error, { stderrTail: tail }) : error;
  }

  /** Connect one generation's client, and adopt it if it's still current. */
  private async establish(session: Session): Promise<void> {
    try {
      await session.client.connect(session.wire, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      const failure = await ModernMcpConnection.closeSession(session);
      if (failure) this.holdUnreaped(session, failure);
      throw await ModernMcpConnection.withStderrTail(session, this.versionVerdict(error, session.wire.negotiation) ?? error);
    }
    if (!this.isCurrent(session.generation) || this.stopped) {
      // Superseded or closed while connecting, or a reconnect or restart
      // still connecting when stopReconnecting() came: this generation never
      // serves.
      const failure = await ModernMcpConnection.closeSession(session);
      if (failure) this.holdUnreaped(session, failure);
      return;
    }
    // The transport closed while the client connected, such as a child that
    // exited at the connect-time list-change subscribe, or this host stopped
    // using the child's stdio, such as after that subscribe's write met
    // EPIPE: the SDK reports the subscribe's failure only as an error, and
    // resolves the connect anyway (R1-2). Adopted, the session would read as
    // connected with nothing it can write to behind it, and from a child that
    // outlived SIGKILL, whose 'unreaped' came while there was no session to
    // lose, no later close would come to reconnect it. So the connect failed:
    // its close reaps the child, and a child it can't reap is held. The
    // stop's cause is named whether or not the child has exited by now.
    const stopped = session.stdio?.stdioStopCause;
    if (session.lost || stopped) {
      const failure = await ModernMcpConnection.closeSession(session);
      if (failure) this.holdUnreaped(session, failure);
      throw await ModernMcpConnection.withStderrTail(session, new Error(stopped
        ? `MCP server "${this.id}": this host stopped using the server's stdio while connecting (${stopped.message})`
        : `MCP server "${this.id}" closed its connection while connecting`));
    }
    const era = session.client.getProtocolEra() ?? 'modern';
    session.wire.establish(era);
    if (session.http && era === 'modern') session.http.reconnection.maxRetries = SDK_STREAM_RETRIES;
    if (this.opening?.session === session) this.opening = null;
    this.session = session;
    this.adoptedAt = performance.now();
    this.protocolVersion = session.client.getNegotiatedProtocolVersion() ?? null;
    if (!session.http || era === 'modern') this.reconnectAttempts = 0;
    // On a 2025 revision list changes arrive unsolicited, on the session's
    // standalone stream: there's no subscription to keep.
    if (era === 'modern') this.keepListening(session, session.client.autoOpenedSubscription);
  }

  /**
   * This client and the server couldn't negotiate a revision: a configuration
   * verdict, as for the legacy engine, in the same type, so every reader
   * treats both engines alike. Retrying can't change it.
   */
  private versionVerdict(error: unknown, evidence: NegotiationEvidence = {}): McplProtocolVersionError | null {
    const offered = this.transportKind === 'http' ? MODERN_HTTP_PROTOCOL_VERSIONS : [MODERN_MCP_PROTOCOL_VERSION];
    // The server's words and data, redacted before they're bounded or kept:
    // the error goes to the host. One build for all of them, so a
    // configuration that can't be read is read once.
    const redact = this.recorded.now();
    // Legacy MCP is reached over stdio or WebSocket. A stdio server's
    // family is its configuration's choice; an http(s) url is modern by its
    // scheme, so there is nothing to reconfigure on it.
    const legacyHint = (supported: readonly string[] | null): string => !supported?.includes(LEGACY_MCP_PROTOCOL_VERSION)
      ? ''
      : this.transportKind === 'stdio'
        ? ` It speaks legacy MCP: configure it without protocol: 'modern'.`
        : ` It speaks legacy MCP (${LEGACY_MCP_PROTOCOL_VERSION}), which this client reaches over stdio or WebSocket (ws://, wss://), not http(s).`;
    const rejected = (refused: readonly string[], supported: string[] | null, why: string, code?: number, data?: unknown, note = '') => new McplProtocolVersionError(
      `MCP server "${this.id}" does not support MCP ${boundedForLog(redact(joinVersions(refused, 'or')))}` +
        (supported ? ` (it supports: ${boundedForLog(redact(supported.join(', '))) || 'none listed'}).` : ` (${boundedForLog(why)}).`) +
        note + legacyHint(supported),
      'rejected',
      null,
      supported,
      code,
      data,
      offered[0],
      offered,
    );
    if (error instanceof UnsupportedProtocolVersionError) {
      // The SDK's own refusal ends negotiation, whatever else the server's
      // list names. Over HTTP it raises one for a -32022 whose list names a
      // revision from 2026-07-28 on that this client doesn't speak, or for a
      // second refusal of the one it asked for, and tries no initialize
      // after either, even when the list also names a 2025 revision this
      // client offers.
      const code = (error as { code?: unknown }).code;
      const data = redactedData((error as { data?: unknown }).data, redact);
      const supported = stringList((data as { supported?: unknown } | undefined)?.supported) ?? null;
      const requested = (data as { requested?: unknown } | undefined)?.requested;
      const asked = typeof requested === 'string' ? requested : MODERN_MCP_PROTOCOL_VERSION;
      const shared = supported?.filter((version) => version !== asked && offered.includes(version)) ?? [];
      const note = shared.length > 0
        ? ` It lists ${joinVersions(shared, 'and')}, which this client also speaks, but the SDK negotiates no further after this refusal.`
        : '';
      return rejected([asked], supported, redact(error.message), code === undefined ? undefined : Number(code), data, note);
    }
    const { initialize, listed } = evidence;
    const accepted = offered.filter((version) => version !== MODERN_MCP_PROTOCOL_VERSION);
    if (initialize && 'version' in initialize && (initialize.version === null || !accepted.includes(initialize.version))) {
      const version = initialize.version === null ? null : redact(initialize.version);
      const named = version === null ? 'without naming a protocol revision' : `with MCP ${boundedForLog(version)}`;
      const where = initialize.version === LEGACY_MCP_PROTOCOL_VERSION
        ? ', which this client reaches over stdio or WebSocket (ws://, wss://), not http(s)'
        : initialize.version === MODERN_MCP_PROTOCOL_VERSION ? ', which this client negotiates through server/discover, not initialize' : '';
      return new McplProtocolVersionError(
        `MCP server "${this.id}" answered initialize ${named}${where}. Over http(s) this client's initialize accepts ${joinVersions(accepted, 'or')}.`,
        'mismatch',
        version,
        null,
        undefined,
        undefined,
        offered[0],
        offered,
      );
    }
    const nothingElse = this.transportKind === 'stdio' || (initialize !== undefined && 'refused' in initialize);
    if (listed && nothingElse && !listed.versions.some((version) => offered.includes(version))) {
      return rejected(offered, listed.versions.map((version) => redact(version)), '', listed.code, redactedData(listed.data, redact));
    }
    return null;
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

  /**
   * The HTTP transport's fetch, observed for one session. It observes a
   * 2025 connection's requests: those carrying a 2025 revision in
   * `MCP-Protocol-Version`, which the SDK sends on each request after
   * `initialize`, with a session id or without one (the id is optional). The
   * handshake's own requests and a 2026-07-28 connection's pass through. The
   * transport reports these HTTP outcomes only as errors, or not at all:
   * - A 404 to a request that carried the session's id: the server has ended
   *   the session. A POST's 404 is also that request's answer: the server
   *   refused it without running it. That's marked on the leg's record (its
   *   body's id names the leg) before anything else runs, since ending the
   *   session closes its client, which can fail the call before the
   *   transport's own 404 error reaches it.
   * - The standalone stream's first open, the one GET without
   *   `Last-Event-ID` before that stream has opened, is the exception. Its
   *   404 can also mean the server has no GET route at all, which a server
   *   that routes only POST answers, and reading it as the session's end
   *   would make such a server unreachable. It ends nothing: the SDK reports
   *   it as an error and opens no stream, as it does for any refusal of that
   *   open but a 405, which it takes quietly, and a 401, which its credential
   *   refresh tries once more. A session that really ended
   *   meets the 404 on its next POST, such as the framework's relist after
   *   the connect. The SDK never retries this open, so {@link firstOpen}
   *   does, on a failure that may pass.
   * - A 400 carrying the JSON-RPC error -32022 (unsupported protocol
   *   version), to any request: the server no longer serves this revision,
   *   as the SDK's 2026 handler answers a 2025 request when it refuses
   *   legacy traffic (`legacy: 'reject'`). The connection negotiates again,
   *   and settles on 2026-07-28 when the server offers it. A POST's refusal
   *   is that request's answer, a JSON-RPC error, as the SDK reads such a 400
   *   on 2026-07-28: marked on its record as a 404 is.
   * - A 405 to a GET for one of the session's streams that the server had
   *   served: the standalone stream opening again after it had opened, or a
   *   request's stream resumed, which the server gave an event id. The server
   *   no longer serves this session a stream, as the SDK's 2026 handler
   *   answers a 2025 session it now serves statelessly, or refuses. The
   *   connection negotiates again. A first open's 405 says only that the
   *   server offers no stream, so it changes nothing. Each of these three,
   *   the 404, the -32022 and the 405, marks the session ended at once
   *   (`http.ended`), so it gets no DELETE: the server has let it go.
   * - The standalone stream opening again, after it had opened, without
   *   `Last-Event-ID`: it couldn't ask for what it missed, whether because
   *   the server's events carry no ids or because the stream that dropped
   *   had carried none (the SDK keeps a stream's last id only for that
   *   stream). See {@link streamReopened}. A GET that carries one resumes a
   *   stream, the standalone one or a request's, and the server replays
   *   what that stream missed.
   * - A standalone resume the server refuses with 400, as one does for an
   *   event id it no longer holds: retrying the same id can't succeed, and
   *   the SDK would retry it for the session's life. The stream opens again
   *   without the id instead, which is a reopen that missed what came between.
   *   A request stream's resume refused that way is left to the SDK: it is
   *   retried until its request's answer arrives on it, or its deadline
   *   cancels it (see ObservedTransport's `aborts`).
   */
  private observedFetch(sessionOf: () => Session): FetchLike {
    return async (url, init) => {
      const headers = new Headers(init?.headers);
      const revision = headers.get('mcp-protocol-version');
      if (revision === null || !HTTP_2025_REVISIONS.has(revision)) return fetch(url, init);
      const session = sessionOf();
      const http = session.http!;
      const method = (init?.method ?? 'GET').toUpperCase();
      const resuming = headers.has('last-event-id');
      if (method === 'GET' && !resuming && http.standaloneSignal === undefined) http.standaloneSignal = init?.signal ?? null;
      const standalone = method === 'GET' && (init?.signal ?? null) === http.standaloneSignal;
      const firstOpen = standalone && !http.streamOpened;
      let response = firstOpen ? await this.firstOpen(session, url, init) : await fetch(url, init);
      let refusal = response.status === 400 ? await revisionRefusal(response) : undefined;
      let replayed = resuming;
      if (!refusal && resuming && standalone && response.status === 400) {
        await response.body?.cancel().catch(() => {});
        headers.delete('last-event-id');
        response = await fetch(url, { ...init, headers });
        replayed = false;
        refusal = response.status === 400 ? await revisionRefusal(response) : undefined;
      }
      if (refusal) {
        const record = method === 'POST' ? wireScope.getStore() : undefined;
        if (record?.currentId !== undefined && bodyId(init?.body) === record.currentId) {
          record.answer = 'error';
          record.error = refusal;
          record.sessionEnded = 'revision';
        }
        http.ended = true;
        queueMicrotask(() => this.sessionEnded(session, 'revision'));
        return response;
      }
      if (response.status === 404 && !firstOpen && headers.has('mcp-session-id')) {
        const record = method === 'POST' ? wireScope.getStore() : undefined;
        if (record?.currentId !== undefined && bodyId(init?.body) === record.currentId) record.sessionEnded = 'ended';
        http.ended = true;
        queueMicrotask(() => this.sessionEnded(session, 'ended'));
      } else if (method === 'GET' && response.status === 405 && (standalone ? http.streamOpened : resuming)) {
        http.ended = true;
        queueMicrotask(() => this.sessionEnded(session, 'stream'));
      } else if (standalone && response.ok) {
        if (!http.streamOpened || !replayed) queueMicrotask(() => this.streamReopened(session));
        http.streamOpened = true;
      }
      return response;
    };
  }

  /** The SDK makes the standalone stream's first open once, and never
   *  retries it. */
  private async firstOpen(session: Session, url: string | URL, init: RequestInit | undefined): Promise<Response> {
    for (let failures = 1; ; failures++) {
      if (failures > 1 && !this.isCurrent(session.generation)) {
        throw new Error(`MCP server "${this.id}": the list-change stream's first open was not tried again, since the connection no longer uses this session`);
      }
      let failure: string;
      try {
        const response = await fetch(url, init);
        if (!mayPass(response.status)) return response;
        await response.body?.cancel().catch(() => {});
        failure = `HTTP ${response.status}`;
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        failure = (error as Error).message;
      }
      if (this.isCurrent(session.generation) && !session.http!.ended) {
        this.emit('error', new Error(`MCP server "${this.id}" did not open its list-change stream (${redactServerText(failure, this.config)}); trying again`));
      }
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', aborted);
          resolve();
        }, this.backoffDelay(failures));
        timer.unref?.();
        const aborted = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  /**
   * The HTTP transport's scheduler for trying a stream again, for both
   * streams it retries: the standalone stream and a request's stream the
   * server closed after a priming event (2025-11-25). The server's `retry`
   * hint is respected, as the spec requires. `hinted` is the server's hint
   * alone, or 0, since the transport's own backoff is zeroed.
   */
  private readonly streamRetry: ReconnectionScheduler = (reconnect, hinted, attempt) => {
    const wait = attempt === 0 && hinted > 0 ? hinted : Math.max(hinted, this.backoffDelay(attempt + 1));
    const timer = setTimeout(reconnect, Math.min(wait, MAX_TIMER_MS));
    timer.unref?.();
    return () => clearTimeout(timer);
  };

  /** The spec has a client whose session met a 404 start a new one. */
  private sessionEnded(session: Session, cause: keyof typeof SESSION_END): void {
    if (this.session !== session || !this.isCurrent(session.generation)) return;
    this.session = null;
    void ModernMcpConnection.closeSession(session);
    if (this.stopped) {
      this.emit('close', { reason: `the server ${SESSION_END[cause]}` });
      return;
    }
    const lived = performance.now() - this.adoptedAt >= this.reconnectIntervalMs;
    if (session.wire.answered && (lived || this.youngRestartFree)) {
      this.youngRestartFree = lived;
      this.reconnectAttempts = 0;
      this.restarting = true;
      this.emit('close', { reason: `the server ${SESSION_END[cause]}; a new one is starting` });
      void this.restartSession(cause);
      return;
    }
    const attempt = Math.max(1, this.reconnectAttempts);
    this.reconnectAttempts = attempt + 1;
    const when = session.wire.answered
      ? `less than ${this.reconnectIntervalMs} ms after the session started`
      : 'before the session answered a request';
    this.emit('reconnect-failed', { error: `MCP server "${this.id}" ${SESSION_END[cause]} ${when}`, attempt });
    this.emit('close', { reason: `the server ${SESSION_END[cause]} ${when}` });
    this.scheduleReconnect();
  }

  private async restartSession(cause: keyof typeof SESSION_END): Promise<void> {
    try {
      await this.open();
    } catch (error) {
      this.restarting = false;
      if (this.closedByHost) return;
      const permanent = error instanceof McplProtocolVersionError;
      const reconnecting = this.reconnectEnabled;
      if (permanent) this.reconnectEnabled = false;
      this.reconnectAttempts = 2;
      this.emit('reconnect-failed', { error: (error as Error).message, attempt: 1, ...(permanent ? { permanent: true } : {}) });
      if (!reconnecting) this.emit('close', { reason: `the server ${SESSION_END[cause]}, and a new one could not start` });
      this.scheduleReconnect();
      return;
    }
    this.restarting = false;
    if (!this.session) return;
    console.error(`MCP server "${this.id}" ${SESSION_END[cause]}; a new one started`);
    this.emit('reconnect', { attempts: 1 });
  }

  private streamReopened(session: Session): void {
    if (this.session !== session || !this.isCurrent(session.generation)) return;
    if (!session.client.getServerCapabilities()?.tools?.listChanged) return;
    this.emit('tools-list-changed');
  }

  /** The transport went away (child exit, or a closed HTTP client). */
  private handleLost(generation: number, reason: string, unreaped?: Error, ended?: TransportCloseInfo): void {
    const session = this.session;
    if (session?.generation !== generation) return;
    this.session = null;
    this.cancelRelisten();
    // Reap before any reconnect, so a second child never runs beside the
    // first. A transport usually closes once its child has exited, but a
    // loss read from a failed pipe can come while the child still runs
    // (R1-1). A launch that can't be reaped halts reconnecting, as a failed
    // reconnect's does, and is a permanent failure, as that one is: no
    // later attempt will come. The reap starts, and is recorded, before
    // 'close' is emitted, so a listener that throws can't skip it.
    const permanent = () => this.emit('reconnect-failed', { error: `${reason}; ${this.unreapedFailure()}`, attempt: Math.max(1, this.reconnectAttempts), permanent: true });
    const done = ModernMcpConnection.closeSession(session).then((failure) => {
      if (this.losing?.session === session) this.losing = null;
      // A close() the host made meanwhile reports the failure itself.
      if (unreaped) {
        // Held as the loss was handled, whatever the reap found now.
        if (!this.closedByHost) permanent();
        return;
      }
      if (failure) {
        this.holdUnreaped(session, failure);
        if (!this.closedByHost) permanent();
      } else if (this.willReconnect) this.scheduleReconnect();
    });
    this.losing = { session, done };
    // A launch already known unreaped is held now, before 'close', so the
    // calls the reap's close ends, which classify their failure only once
    // this returns, and any made meanwhile, read that this host won't
    // reconnect, as the legacy engine has it (#540's review, R1-1). It's
    // reported after 'close', which is where the other route reports a hold
    // too, whatever the 'close' listeners do, so a listener that throws can
    // skip neither 'close' nor the report.
    if (unreaped) this.holdUnreaped(session, unreaped, false);
    try {
      this.emit('close', { reason, code: ended?.code ?? null, signal: ended?.signal ?? null, pipeFailed: ended?.pipeFailed === true });
    } finally {
      if (unreaped) this.reportUnreaped(unreaped);
    }
  }

  /** The legacy engine's backoff: doubling from the base interval, capped,
   *  with ±25% jitter, and never past the timer limit (a longer delay would
   *  fire at once, turning the backoff into a tight loop). */
  private backoffDelay(failures: number): number {
    const exponent = Math.max(0, Math.min(failures - 1, 30));
    const capped = Math.min(this.reconnectIntervalMs * 2 ** exponent, this.reconnectMaxIntervalMs);
    return Math.min(capped * (0.75 + Math.random() * 0.5), MAX_TIMER_MS);
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
      const stderrTail = stderrTailOf(error);
      const failed = (message: string, permanent?: true) => this.emit('reconnect-failed', {
        error: message,
        ...(stderrTail === undefined ? {} : { stderrTail }),
        attempt,
        ...(permanent ? { permanent } : {}),
      });
      const halted = this.unreapedFailure();
      if (halted) {
        failed(`${(error as Error).message}; ${halted}`, true);
        return;
      }
      // No common revision: every further attempt would hear the same
      // answer. Stop; only the configuration can fix it.
      if (error instanceof McplProtocolVersionError) {
        this.reconnectEnabled = false;
        failed(error.message, true);
        return;
      }
      failed((error as Error).message);
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
    const { tools } = await this.request('tools/list', 'tools/list', (client, signal) =>
      client.listTools(undefined, {
        cacheMode: 'refresh',
        timeout: LIST_TIMEOUT_MS,
        signal,
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
   * before dispatch (an auth refresh, or a header-mismatch relist). That
   * signal also fires when the call's stream is lost (WireRecord's `cancel`).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ModernToolCallResult> {
    const timeoutMs = this.requestTimeoutMs;
    const result = await this.request('tools/call', `tools/call ${logValue(name)}`, (client, signal) =>
      client.callTool(
        { name, arguments: args },
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal },
      ), timeoutMs);
    return {
      content: result.content ?? [],
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
      ...('structuredContent' in result ? { structuredContent: result.structuredContent } : {}),
      ...(result._meta !== undefined ? { _meta: result._meta as Record<string, unknown> } : {}),
    };
  }

  /** Run one logical request in a wire scope, and classify its failure by
   *  what that scope saw. `what` names the request in the host's log: its
   *  method, and a tool call's tool as a log field. */
  private async request<T>(method: string, what: string, run: (client: Client, signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const session = this.session;
    if (!session) {
      // Connectome refuses before anything reaches the SDK: provably not
      // sent. In the agent's words, as the legacy engine's request on a
      // closed connection: after this host's own close, only that holds;
      // otherwise the connection is closed, and whether this host is
      // reconnecting says what works from there.
      throw new McplRequestError(
        this.closedByHost
          ? `The request wasn't sent: this host closed its connection to the "${this.id}" server, so nothing ran. ` +
            'If calling it again fails, ask whoever runs this host.'
          : `The request wasn't sent: the connection to the "${this.id}" server is closed, so nothing ran. ${this.retryText()}`,
        'not-sent',
      );
    }
    const record: WireRecord = { method, handedOff: false, answer: 'none', continued: false, cancel: new AbortController() };
    // The deadline aborts with its own reason, a timeout, which the SDK reads
    // as one.
    const deadline = AbortSignal.timeout(timeoutMs);
    const atDeadline = () => record.cancel.abort(deadline.reason);
    deadline.addEventListener('abort', atDeadline, { once: true });
    try {
      return await wireScope.run(record, () => run(session.client, record.cancel.signal));
    } catch (error) {
      throw this.requestFailure(what, record, error, timeoutMs, session.lost);
    } finally {
      deadline.removeEventListener('abort', atDeadline);
      session.wire.forget(record);
    }
  }

  /**
   * Close one generation: the transport first (during discovery the SDK
   * hasn't attached it yet, so only closing it ends the probe), then the
   * client. The transport's close is the reaping verdict, and its failure is
   * returned, never swallowed. It never rejects, which lossReaped() and the
   * framework's unguarded wait on it rely on.
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

  /**
   * End an HTTP session on the server (a DELETE), as the spec asks of a
   * client that no longer needs it. It runs before the inner transport
   * closes, since that close would abort it. When a connect fails after its
   * `initialize` was answered, the SDK closes the transport itself before
   * the error reaches `establish`. The transport sends nothing for a session
   * without an id, and the SDK reports a DELETE's failure through the
   * transport's onerror.
   */
  private static endSession(session: Session): Promise<void> {
    const http = session.http;
    if (!http || http.ended) return Promise.resolve();
    http.deleting ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        http.transport.terminateSession().catch(() => { /* the server expires it */ }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, DELETE_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
    })();
    return http.deleting;
  }

  /** The close in flight, which later calls wait behind. */
  private closing: Promise<void> | null = null;

  /** Set when the host closes a live session; cleared, with the one
   *  'close', by the close that confirms its teardown. */
  private closeIncomplete = false;

  /**
   * Close for good: no reconnect, no reopened subscription, no connect left
   * in flight. Awaits the in-flight connect's end, and rejects while a child
   * can't be confirmed exited: with that failure itself, the transport's
   * own error, or an AggregateError when there are several, as the MCPL
   * engine does. Calls queue behind the one in flight, so none resolves
   * while teardown is still pending. A call after a failed close re-checks
   * what wasn't reaped. 'close' is emitted once, when the teardown of a
   * session the host closed while live completes, not on a failed close.
   */
  close(): Promise<void> {
    // Closed from this call on: a connect or start() in the same turn sees
    // it, and launches nothing.
    this.closedByHost = true;
    const previous = this.closing;
    const next = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => this.closeStep());
    this.closing = next;
    return next;
  }

  private async closeStep(): Promise<void> {
    this.closedByHost = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancelRelisten();
    const opening = this.opening;
    const losing = this.losing;
    const session = this.session;
    this.session = null;
    if (session) this.closeIncomplete = true;
    // Every generation this connection still owns: a connect in flight, the
    // live one, a lost one still being reaped, and any a failed cleanup
    // couldn't reap.
    const targets: Session[] = [];
    if (opening) targets.push(opening.session);
    if (session) targets.push(session);
    if (losing) targets.push(losing.session);
    for (const held of this.unreaped) if (!targets.includes(held.session)) targets.push(held.session);
    this.unreaped = [];
    const failures: Error[] = [];
    for (const target of targets) {
      // Closing the transport ends a probe in flight too: its connect then
      // rejects and its own cleanup runs (sharing this verdict).
      const failure = await ModernMcpConnection.closeSession(target);
      if (failure) {
        failures.push(failure);
        if (!this.unreaped.some((held) => held.session === target)) this.unreaped.push({ session: target, failure });
      }
    }
    // The connect's own cleanup, and a lost session's reap, close their
    // generation again, after the close above; each `done` settles once it
    // has. A child that either cleanup couldn't reap is this close's failure
    // too.
    for (const pending of [opening, losing]) {
      if (!pending) continue;
      await pending.done;
      for (const held of this.unreaped) if (!failures.includes(held.failure)) failures.push(held.failure);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `MCP server "${this.id}" did not close cleanly: ${failures.map((f) => f.message).join('; ')}`);
    }
    if (this.closeIncomplete) {
      this.closeIncomplete = false;
      this.emit('close', { reason: 'closed by host' });
    }
  }

  /** What works from here after a request that didn't run, by whether this
   *  host is reconnecting to the server, in the legacy engine's words. */
  private retryText(): string {
    return this.willReconnect
      ? 'This host is reconnecting to it; try again later.'
      : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host.";
  }

  /**
   * Map a failure onto the request-outcome contract by what crossed the
   * transport boundary for this request, claiming no more than that shows.
   * The rules apply in this order. The call's answer is the server's final
   * one: an error or a `complete` result.
   * - nothing handed to the transport: `not-sent`, whatever was raised (a
   *   pre-dispatch validation, a signal already aborted, no transport, a
   *   message JSON can't write, a send Connectome's stdio line refused
   *   before writing);
   * - the most recent leg answered with a JSON-RPC error: `error-response`
   *   with that error's data;
   * - the most recent leg answered with a complete result: the server
   *   finished, but what it returned can't be used (output validation).
   *   That's a plain error, not a request outcome;
   * - the most recent leg answered without finishing the call: `no-response`,
   *   since the server may have acted on what it received. An
   *   `input_required` answer asks for another round, and the call can end
   *   before that round is sent: at the deadline, when the connection is
   *   gone, or when this client can't go on (input it can't supply, the
   *   rounds cap). Nothing is in flight then, so nothing is cancelled. A
   *   result of a type this client doesn't recognize ends the call where it
   *   is;
   * - an HTTP refusal of the current leg: `error-response`, the status in
   *   `data.httpStatus` (the server answered at the HTTP layer, outside the
   *   JSON-RPC code space). That's a 401 or 403, or a 404 to a POST from a
   *   server that had ended the session (`sessionEnded`, read at the HTTP
   *   layer, whatever error the call then met as its session closed). After
   *   an earlier leg asked for another round it is `no-response` instead:
   *   the server may already have acted on the call;
   * - handed off and unanswered: `no-response`, and the outcome is unknown.
   *   At the deadline, cancellation was requested, and so it was when the
   *   stream that would carry the answer ended unresumed (WireRecord's
   *   `cancel`).
   *
   * The message is the agent's, in the legacy engine's words where it has
   * words for the same outcome (#506), and in their shape where it hasn't:
   * what happened, whether anything took effect, and what works from there.
   * A request this host's close cut off, and one whose connection closed
   * under it (`lost`), read as the legacy engine's do. The method, the tool,
   * the JSON-RPC code, the HTTP status, the deadline in milliseconds and the
   * SDK's or transport's words are the operator's, so they go to one log
   * line, the server's text redacted. Where the effect is in doubt, a tool
   * call's message says to check it before trying again, and a listing's that
   * listing changes nothing on the server, so trying again is safe.
   */
  private requestFailure(what: string, record: WireRecord, error: unknown, timeoutMs?: number, lost = false): Error {
    const server = `the "${this.id}" server`;
    const Server = `The "${this.id}" server`;
    // One build of the redactor for all of this failure's texts, so a
    // configuration that can't be read is read once.
    const redact = this.recorded.now();
    const message = redact(error instanceof Error ? error.message : String(error));
    const log = (line: string) => console.error(`MCP server "${this.id}" ${line}`);
    const listing = record.method === 'tools/list';
    // What a failure whose effect is in doubt says: for a tool call, that the
    // effect is unknown and to check it; for a listing, that it's safe to ask
    // again.
    const unknown = (said: string) => listing
      ? `${said}. Listing changes nothing on the server, so it's safe to try again.`
      : `${said}, so whether the request took effect is unknown. Check its effect before trying again.`;
    if (!record.handedOff) {
      log(`${what} not sent: ${logDetail(message)}`);
      const stdioStopped = error instanceof NotWrittenError && error.stdioStopped;
      return new McplRequestError(
        stdioStopped
          ? `The request wasn't sent: this host can no longer write to ${server}, so nothing ran. ${this.retryText()}`
          // Before the wire, the cause can pass (the stdio line closing as
          // the connection is lost) or stay (a tool's outputSchema the SDK
          // can't compile), so the message claims neither.
          : `The request wasn't sent: this host couldn't send it to ${server}, so nothing ran. If calling it again fails, ask whoever runs this host.`,
        'not-sent',
      );
    }
    if (record.answer === 'error' && record.error) {
      const { code, message: wireMessage, data } = record.error;
      // The log is a record of the server's text, so the code (loggedCode)
      // and the message are redacted there, whatever JSON values they are,
      // as every other line this connection writes is.
      log(`answered ${what} with error ${loggedCode(code, redact)}: ${logValueRedacted(wireMessage, redact)}`);
      if (record.sessionEnded === 'revision') {
        return new McplRequestError(
          `${Server} refused this session's revision, so the request didn't run. ${this.retryText()}`,
          'error-response',
          redactedData(data, redact),
        );
      }
      // The server's own words, redacted and then bounded as errors.ts says,
      // since they're in an error the caller gets (redactServerText's
      // scope), and its data's strings redacted too. It's trimmed after it's
      // redacted, so a credential that ends in a space is whole when it's
      // matched. Only a string is words: a message of any other JSON value
      // reads as none.
      const said = typeof wireMessage === 'string' ? boundedForLog(redact(wireMessage).trim()) : '';
      return new McplRequestError(
        said ? `${Server} answered with an error: ${said}` : unknown(`${Server} answered with an error without saying what went wrong`),
        'error-response',
        redactedData(data, redact),
      );
    }
    if (record.answer === 'complete') {
      log(`answered ${what} with a result this host can't use: ${logDetail(message)}`);
      return new Error(unknown(`${Server} answered, but not in a form this host can read`));
    }
    const deadline = error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
    const within = deadline && timeoutMs ? ` within ${timeoutMs}ms` : '';
    if (record.answer === 'input-required' || record.answer === 'unrecognized') {
      const reason = /[.!?]$/.test(message) ? message : `${message}.`;
      log(record.answer === 'unrecognized'
        ? `did not finish ${what}${within}: its answer was not a complete result: ${logDetail(reason)}`
        : deadline
          ? `did not finish ${what}${within}: it asked for another round (input_required), and the deadline passed before that round was sent`
          : `did not finish ${what}: it asked for another round (input_required), and the call ended before that round was sent: ${logDetail(reason)}`);
      return new McplRequestError(
        unknown(record.answer === 'unrecognized'
          ? `${Server}'s answer wasn't a complete result`
          : `${Server} didn't finish the request: it asked for more from this host, and ${deadline ? 'the time ran out' : 'the call ended'} before this host sent it`),
        'no-response',
      );
    }
    // An HTTP refusal: the session's end, read at the HTTP layer, or the
    // credential's, 401 or 403, however the SDK raised it. It raises a plain
    // 403 under another code than its step-up limit's, and an
    // insufficient_scope 403 as InsufficientScopeError when no OAuth provider
    // is configured. A 403 can refuse a valid credential that lacks
    // permission, so the message says the server refused this host access.
    const refusedWith = record.sessionEnded === 'ended'
      ? 404
      : error instanceof SdkHttpError && (error.status === 401 || error.status === 403)
        ? error.status
        : error instanceof InsufficientScopeError ? 403 : null;
    if (refusedWith !== null) {
      const why = refusedWith === 404 ? "the server had ended this connection's session" : logDetail(message);
      if (record.continued) {
        log(`refused a later round of ${what}: HTTP ${refusedWith} (${why})`);
        return new McplRequestError(
          listing
            ? unknown(`${Server} refused this host access partway through the request, after asking for more`)
            : `${Server} refused this host access partway through the request, after asking for more, so whether it took effect is unknown. ` +
              'Check its effect before trying again; if calling it again fails, ask whoever runs this host.',
          'no-response',
        );
      }
      if (refusedWith === 404) {
        log(`refused ${what}: HTTP 404 (${why})`);
        return new McplRequestError(
          `${Server} had ended this connection's session, so the request didn't run. ${this.retryText()}`,
          'error-response',
          { httpStatus: 404 },
        );
      }
      log(`refused ${what}: HTTP ${refusedWith} (${why})`);
      // The response body (the SDK's `text`) is the server's text and can
      // echo the request's url, so it's left out of the data; the status stays.
      const { text: _body, ...data } = (error instanceof SdkHttpError && error.data && typeof error.data === 'object' ? error.data : {}) as Record<string, unknown>;
      const redacted = redactedData(data, redact);
      return new McplRequestError(
        `${Server} refused this host access, so the request didn't run. If you need it, ask whoever runs this host.`,
        'error-response',
        // The status is this host's own, so it's added after the server's
        // data is redacted, and it stays when a configuration that can't be
        // read withholds that data.
        { ...(redacted !== null && typeof redacted === 'object' ? redacted : {}), httpStatus: refusedWith },
      );
    }
    if (deadline) {
      log(`didn't answer ${what}${within}; cancellation requested`);
      const seconds = timeoutMs ? timeoutMs / 1000 : null;
      const late = seconds === null ? `${Server} didn't answer in time` : `${Server} didn't answer within ${seconds} second${seconds === 1 ? '' : 's'}`;
      return new McplRequestError(
        listing
          ? `${late}, and this host asked it to cancel. Listing changes nothing on the server, so it's safe to try again.`
          : `${late}, so whether the request took effect is unknown: this host asked it to cancel, and it may still complete on the server. ` +
            'Check its effect before trying again, since repeating something that changes state may do it twice.',
        'no-response',
      );
    }
    // Anything else after the request went out. An HTTP status other than
    // 401/403 is only in the SDK's error, not its message, so the log names it.
    log(`${what} failed${error instanceof SdkHttpError ? ` with HTTP ${error.status}` : ''}: ${logDetail(message)}`);
    if (this.closedByHost) {
      // This host's close cut it off: the legacy engine's words.
      return new McplRequestError(unknown(`${Server} didn't answer before this host closed its connection`), 'no-response');
    }
    if (lost) {
      // The connection closed under it: the legacy engine's words, with
      // whether this host is reconnecting.
      return new McplRequestError(
        listing
          ? unknown(`The connection to ${server} closed before it answered`)
          : `The connection to ${server} closed before it answered, so whether the request took effect is unknown. ` +
            (this.willReconnect
              ? 'Check its effect before trying again; this host is reconnecting to it.'
              : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host."),
        'no-response',
      );
    }
    // The connection may still stand, as after an HTTP error with no JSON-RPC
    // answer, so the message says nothing of reconnecting.
    return new McplRequestError(
      listing
        ? `The request to ${server} failed before an answer came back. Listing changes nothing on the server, so it's safe to try again.`
        : `The request to ${server} failed before an answer came back, so whether it took effect is unknown. Check its effect before trying again.`,
      'no-response',
    );
  }
}
