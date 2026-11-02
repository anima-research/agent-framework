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

import { openTransport, STDERR_END_WAIT_MS, type McplTransport, type TransportCloseInfo } from './transport.js';
import { maskNegotiatedCapabilities } from './capability-mask.js';
import { CapabilityGrant, expandAdvertisementShorthand } from './capability-grant.js';
import { CAPABILITY_DISABLED, boundedForLog, describeCause } from './errors.js';
import { logDetail, logValue, logValueRedacted, loggedCode } from './log-value.js';
import {
  LEGACY_MCP_PROTOCOL_VERSION,
  MODERN_MCP_PROTOCOL_VERSION,
  checkServerConfig,
  logDroppedLine,
  redactServerText,
  redactedData,
  serverTextRedactor,
  type ServerTextRedactor,
} from './protocol-family.js';

import type {
  McplServerConfig,
  McplCapabilities,
  McplHostCapabilities,
  JsonRpcRequest,
  JsonRpcResponse,
  BeforeInferenceParams,
  BeforeInferenceResult,
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
import type { ToolLifecycleParams, ToolObserveRule } from './tool-lifecycle.js';

/**
 * Payload of the connection `'close'` event (third argument; the first two
 * stay `(code, signal)` for existing listeners). Lets a host see WHY the
 * link went down — in particular a WebSocket close code such as 4001 from
 * a server that refused or expired the credential — so it can refresh what
 * `accessProvider` will hand the next dial instead of replaying it.
 */
export interface McplConnectionCloseInfo {
  /** Transport kind that closed; null when the connection never had one
   *  (a disconnected stub torn down before its first reconnect). */
  transport: McplTransport['kind'] | null;
  /** WebSocket close code (e.g. 4001) or stdio child exit code; null when unknown. */
  code: number | null;
  /** Signal that ended a stdio child; null otherwise. */
  signal: NodeJS.Signals | null;
  /** WebSocket close reason, or a short description of the cause. */
  reason?: string;
  /** True when `reason` is the peer's own text, a WebSocket server's close
   *  reason, rather than the transport's or the host's words. */
  reasonFromPeer?: boolean;
  /** True when the stdio transport ended the child itself, after a pipe
   *  error or a line on its stdout longer than the bound. */
  pipeFailed?: boolean;
  /** True when the host closed the link (`close()` / `reconnectAfterFailure()`),
   *  false when the transport dropped unexpectedly. */
  byHost: boolean;
}

/** Timeout for the initialize handshake in milliseconds.
 *  Spring Boot + JDA servers can take 5-10s to boot, so 30s is safe. */
const INITIALIZE_TIMEOUT_MS = 30_000;

/** How many errors down a `cause` chain stderrTailOf looks. */
const STDERR_TAIL_CAUSE_LINKS = 8;

/** A failed connect's `stderrTail`, the last of the server's stderr that its
 *  handshake's error keeps, when there is one: the error's own, or the
 *  nearest one in its `cause` chain, since a launch that couldn't be reaped
 *  (McplUnreapedLaunchError) and the framework's refusals wrap the
 *  handshake's error. It looks at most STDERR_TAIL_CAUSE_LINKS causes down,
 *  so a chain that loops ends. */
export function stderrTailOf(error: unknown): string | undefined {
  let at = error;
  for (let link = 0; link <= STDERR_TAIL_CAUSE_LINKS && typeof at === 'object' && at !== null; link++) {
    const { stderrTail, cause } = at as { stderrTail?: unknown; cause?: unknown };
    if (typeof stderrTail === 'string' && stderrTail !== '') return stderrTail;
    at = cause;
  }
  return undefined;
}

/** For the host's own log line about a failed connect: the server's stderr
 *  that the error, or the nearest error it wraps, keeps as `stderrTail`
 *  (stderrTailOf), with the server's credentials taken out by `redact` (its
 *  redactServerText), one marked line per line of it, each through
 *  log-value, since it's the server's text. '' when there's none. */
export function withStderr(error: unknown, redact: (text: string) => string): string {
  const tail = stderrTailOf(error);
  if (tail === undefined) return '';
  return '. The last of its stderr:' + redact(tail).split('\n').map((line) => `\n  stderr: ${logDetail(line)}`).join('');
}

/** A transport close's reason, as the host's log and the handshake's error
 *  give it: the transport's own words. A WebSocket peer's close reason is the
 *  server's text (`reasonFromPeer`), so they give the words the transport uses
 *  for a close without one, as `mcpl:server-closed` leaves that text out. A
 *  WebSocket close's code, a number, says what the server meant (4001: a
 *  refused credential), with or without a reason, so each gives it too: the
 *  log line for a close with requests pending has `code=`, and the
 *  handshake's error adds it for any WebSocket close, since a close before the
 *  handshake completes reaches no 'close' event. A stdio child's exit reads
 *  as before. */
function closeReasonText(info: TransportCloseInfo): string {
  if (info.reasonFromPeer) return 'websocket closed';
  return info.reason ?? 'unknown';
}

/** Default per-request timeout in milliseconds (see McplServerConfig.requestTimeoutMs).
 *  A live-but-wedged server (accepts requests, never answers, never closes its
 *  transport) would otherwise freeze the awaiting agent turn forever — no
 *  endTurn, no further wakes, zero errors anywhere. 60s is generous for real
 *  tool work while still bounding the hang. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** MCP protocol version used in the initialize handshake: the only revision
 *  this legacy engine offers or accepts. */
const MCP_PROTOCOL_VERSION = LEGACY_MCP_PROTOCOL_VERSION;

/** JSON-RPC code for an unsupported protocol version (MCP 2026-07-28 §basic,
 *  the code a modern-only server answers our `initialize` with). */
const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

/** Upper bound on `tools/list` pages, against a server whose cursors never
 *  end. Generous: real inventories fit in a handful of pages. */
const MAX_TOOL_LIST_PAGES = 100;

/**
 * The server and this engine have no protocol revision in common, so the
 * connection was never established. This is a protocol-negotiation fact, not
 * a request outcome. Retrying cannot change it: each engine offers one
 * revision, and only configuration can fix the mismatch. A connection that
 * gets this error does not schedule reconnects. The legacy engine and the
 * modern one (ModernMcpConnection, whose pinned revision the server refused)
 * both throw it, so its readers treat them alike.
 *
 * - `rejected`: the server refused the offered revision: the legacy engine's
 *   `initialize` answered with error -32022, or a modern server's discovery
 *   or error naming no common revision. `supported` is the server's own list,
 *   when it gave one.
 * - `mismatch`: the server answered the legacy engine's `initialize` with a
 *   revision other than 2024-11-05, or with none.
 */
export class McplProtocolVersionError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'mismatch',
    /** Revision the server answered with (`mismatch`; null when it gave
     *  none), redacted as the server's words are. */
    readonly returned: string | null,
    /** Revisions the server says it supports (`rejected`, when stated). */
    readonly supported: readonly string[] | null,
    /** The JSON-RPC error's code, and its data with each string in it
     *  redacted (`rejected`). */
    readonly code?: number,
    readonly data?: unknown,
    /** The revision this client offered: the legacy engine's, unless a
     *  modern connection's. */
    readonly offered: string = MCP_PROTOCOL_VERSION,
  ) {
    super(message);
    this.name = 'McplProtocolVersionError';
  }
}

function protocolVersionRejection(config: McplServerConfig, error: { code: number; message: string; data?: unknown }): McplProtocolVersionError {
  const id = config.id;
  // The server's words and data, redacted before they're bounded or kept:
  // the error goes to the host. One build for all of them, so a
  // configuration that can't be read is read once.
  const redact = serverTextRedactor(config).now();
  const data = redactedData(error.data, redact) as { supported?: unknown } | undefined;
  const supported = Array.isArray(data?.supported) && data.supported.every((v) => typeof v === 'string')
    ? (data.supported as string[])
    : null;
  const modernHint = supported?.includes(MODERN_MCP_PROTOCOL_VERSION)
    ? ` It speaks modern MCP: configure it with protocol: 'modern' (stdio) or reach it over http(s).`
    : '';
  return new McplProtocolVersionError(
    `MCPL server "${id}" does not support MCP ${MCP_PROTOCOL_VERSION}` +
      // The server's message can be any JSON value, so it's read without
      // throwing (describeCause), and redacted, then bounded, as the
      // initialize error is.
      (supported ? ` (it supports: ${boundedForLog(supported.join(', ')) || 'none listed'}).` : ` (${boundedForLog(redact(describeCause(error.message)))}).`) +
      modernHint,
    'rejected',
    null,
    supported,
    error.code,
    data,
  );
}

const errorOf = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/**
 * The RFC-014 members of a server's advertisement (`toolHints`, `toolsets`,
 * `surface`), read from it as the server sent it. They are declarations, not
 * §6.2 capabilities: the host's capability mask, which reads every member as
 * a capability, never applies to them. Null when the server advertised none
 * of them, or no MCPL at all.
 */
export function toolsetDeclarationsOf(advertised: unknown): Record<string, unknown> | null {
  if (advertised === null || typeof advertised !== 'object' || Array.isArray(advertised)) return null;
  const { toolHints, toolsets, surface } = advertised as Record<string, unknown>;
  if (toolHints === undefined && toolsets === undefined && surface === undefined) return null;
  return {
    ...(toolHints !== undefined ? { toolHints } : {}),
    ...(toolsets !== undefined ? { toolsets } : {}),
    ...(surface !== undefined ? { surface } : {}),
  };
}

/** What the RFC-014 read tap is handed as the connection reads a message
 *  that can carry hint changes (see McplServerConnection.setReadTap). */
export type HintRead =
  /** A response to a request that can carry hints (RFC-014 §6.1 carrier 1),
   *  or a `tools/list`'s whole inventory (§4.1), its pages joined by
   *  sendToolsList, `straddled` when its pages carry different revs.
   *  `awaited`: whoever sent it still waits for it; false for a
   *  result that arrives after its timeout. A JSON-RPC error carries no state
   *  and isn't tapped. */
  | { kind: 'result'; method: string; params: Record<string, unknown>; result: unknown; awaited: boolean; straddled?: boolean }
  /** A push/event (carrier 2), as read, before the plane gate or the grant
   *  admit or refuse it. */
  | { kind: 'push'; params: unknown }
  /** A standalone tools/hints (carrier 3). */
  | { kind: 'hints'; params: unknown };

/** Requests whose results can carry hint state, remembered for a late answer (RFC-014 §6.1). */
const HINTED_METHODS: ReadonlySet<string> = new Set(['tools/call', 'toolsets/open', 'toolsets/close', 'toolsets/list']);

function hintedParams(method: string, params: Record<string, unknown>): { toolset?: string; instance?: string } {
  if (method !== 'toolsets/open' && method !== 'toolsets/close') return {};
  return {
    ...(typeof params.toolset === 'string' ? { toolset: params.toolset } : {}),
    ...(typeof params.instance === 'string' ? { instance: params.instance } : {}),
  };
}

/**
 * A handshake that failed, and whose cleanup couldn't confirm that the child
 * exited. The transport goes to whoever owns the launch.
 */
class HandshakeCleanupError extends Error {
  constructor(
    readonly failure: Error,
    readonly cleanup: Error,
    readonly transport: McplTransport,
  ) {
    super(`${failure.message}; its cleanup also failed: ${cleanup.message}`, { cause: failure });
    this.name = 'HandshakeCleanupError';
  }
}

/**
 * A connect that failed, and whose cleanup couldn't confirm that the child
 * exited: it may still be running. `connection` owns that launch, closed and
 * not reconnecting. Its close() retries the reap and resolves once the exit
 * is confirmed, so the caller can still clean up, and should start nothing
 * else for this server until then. connect() and connectWithReconnect()
 * throw this, and the modern engine's ModernMcpConnection.connect() too.
 * `cause` is the connect's own failure. `connection` isn't enumerable, so
 * printing the error doesn't print the connection's configuration, its
 * credentials included.
 */
export class McplUnreapedLaunchError<Connection extends { close(): Promise<void> } = McplServerConnection> extends Error {
  declare readonly connection: Connection;

  constructor(
    connection: Connection,
    failure: Error,
    /** The cleanup's own failure: the child it couldn't confirm exited. */
    readonly cleanup: Error,
  ) {
    super(`${failure.message}; its cleanup also failed: ${cleanup.message}`, { cause: failure });
    Object.defineProperty(this, 'connection', { value: connection, enumerable: false });
    this.name = 'McplUnreapedLaunchError';
  }
}

/**
 * Why a request to an MCPL server produced no result, as far as the host can
 * know it. Messages are unchanged from plain errors; the `outcome` makes the
 * difference between "never left the host" and "left, and no answer came
 * back" a fact a caller can act on instead of a string to match:
 * - `not-sent`: the request was refused before anything was written (the
 *   connection was already closed);
 * - `error-response`: the server answered with a JSON-RPC error (it may have
 *   acted before failing; the error alone does not say);
 * - `no-response`: the request was handed to the transport and no answer
 *   came back (timeout, or the connection closed while awaiting). It does
 *   not prove the request reached the server — the transport can decline or
 *   drop a write — only that the host can no longer say it didn't.
 */
export class McplRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not-sent' | 'error-response' | 'no-response',
    /** The JSON-RPC error's `data`, when the server supplied one (e.g. which
     *  parts of a multi-part send were posted), with each string in it
     *  redacted (redactedData): a host hands it on. */
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McplRequestError';
  }
}

/**
 * Represents a pending JSON-RPC request awaiting a response.
 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  onRead?: (result: unknown) => void;
  /** Per-request timeout timer; cleared on response/close/timeout. */
  timer?: ReturnType<typeof setTimeout>;
}

interface RequestOptions {
  /** Override the connection-wide timeout for this request only. */
  timeoutMs?: number;
  /** Surface a late response even when it carries no checkpoint state. */
  surfaceOrphanedResponse?: boolean;
  /** Called with a successful result as its response is read, before
   *  anything read after it and before the request's promise settles. */
  onRead?: (result: unknown) => void;
}

/** A server→host message held while its plane is closed. `kept`: it came on
 *  a transport that is gone, and the boundary kept it (keepAcrossBoundary). */
interface HeldItem {
  event: string;
  args: unknown[];
  kept?: true;
}

/** A request's method for a log line, whatever the server sent there. */
function describeMethod(method: unknown): string {
  return typeof method === 'string'
    ? `method ${logValue(method)}`
    : `a method of type ${method === null ? 'null' : typeof method}`;
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
 * - `'close'`              — Connection closed: `(code, signal, info: McplConnectionCloseInfo)`
 * - `'connect-failed'`     — Initial connect failed; background retry scheduled:
 *   `{ error, stderrTail?, attempt }`
 * - `'reconnect-failed'`   — A background reconnect attempt failed; next retry scheduled:
 *   `{ error, stderrTail?, attempt }`. `stderrTail` is the last of the
 *   server's stderr when its handshake failed by its transport closing, a
 *   transport error or its timeout and it had written any; `error` never
 *   carries it.
 * - `'reconnect'`          — Background reconnect succeeded. The new transport
 *                            starts with an empty grant and both planes
 *                            closed, as at initial connect: whoever owns the
 *                            connection runs the §5.3 policy exchange again,
 *                            then opens the planes (the framework's listener
 *                            does).
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

  /** The MCP revision established by the last successful handshake (always
   *  2024-11-05 for this engine), or null before the first one. */
  protocolVersion: string | null = null;

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
   * RFC-007 §6: the server's `tools/observe` filter — interest, never
   * authority (it only narrows what the grant allows). Null = no filter in
   * force, which means every granted call is reported with METADATA ONLY
   * (§5.1). Per connection epoch: discarded on reconnect and whenever
   * `toolLifecycle.observe` leaves the grant (§6.5).
   */
  toolObserveFilter: ToolObserveRule[] | null = null;

  /** Increments at every transport boundary. RFC-007 terminals go only to
   *  the epoch their opening went to, never across a reconnect. */
  transportEpoch = 0;

  private transportEnded = new AbortController();

  /**
   * RFC-014: the server's `toolHints`, `toolsets` and `surface` members as it
   * advertised them at the last handshake (toolsetDeclarationsOf), or null.
   * Read by the host's toolset controller; they grant nothing.
   */
  toolsetDeclarations: Record<string, unknown> | null = null;

  /**
   * RFC-014 §6.1: hint changes apply as each message carrying them is read,
   * in rev order (arrival order on stdio and WebSocket), whatever becomes of
   * the message: a push the plane holds or the grant refuses, a result its
   * caller stopped waiting for. The tap sees every such message of the
   * current transport, synchronously, before anything routes it; a late
   * answer's request is remembered past its timeout (hintedRequests, while
   * no more than 1,000 hinted requests await an answer) so its hints still
   * apply. Null (the default) taps nothing, and the connection
   * behaves as it always has.
   */
  private readTap: ((read: HintRead, epoch: number) => void) | null = null;
  /** The hinted requests sent on this transport, by id, kept past a timeout
   *  so a late result is still tapped: each one's method, and an open's or
   *  close's toolset and instance, which are all the read of its result
   *  uses; never a call's arguments. Bounded. Cleared at each boundary,
   *  since the next transport numbers its requests afresh. */
  private hintedRequests = new Map<string | number, { method: string; params: { toolset?: string; instance?: string } }>();

  /** Install (or, with null, remove) the RFC-014 read tap (see readTap). */
  setReadTap(tap: ((read: HintRead, epoch: number) => void) | null): void {
    this.readTap = tap;
    if (!tap) this.hintedRequests.clear();
  }

  /** Hand a read to the tap, contained: a tap that throws is logged, and the
   *  message goes on its way as if there were none. */
  private tap(read: HintRead): void {
    if (!this.readTap) return;
    try {
      this.readTap(read, this.transportEpoch);
    } catch (error) {
      console.error(`[mcpl] ${this.id}: the tool-hints tap failed: ${logDetail(describeCause(error))}`);
    }
  }

  /**
   * §17 manifest tracking (host side of RFC-003): what this host actually
   * fetched and acted on — never the server's announcement log (§17.10:
   * those are different facts). Read by the legibility surface.
   */
  manifestState: {
    /** revision of the last VALIDATED fetched manifest (server-authored,
     *  untrusted, equality-only) — null until a §17.4 fetch succeeds. */
    lastValidatedRevision: string | null;
    lastFetchedAt: number | null;
    /** epoch ms of the last §6.7 receipt that activated a grant change. */
    lastNegotiatedAt: number | null;
  } = { lastValidatedRevision: null, lastFetchedAt: null, lastNegotiatedAt: null };

  /**
   * Activate (or replace) the effective grant. Ordering is the caller's
   * contract per §6.7: call BEFORE sending a reducing featureSets/update,
   * AFTER the receipt for an expanding one.
   */
  establishGrant(grant: CapabilityGrant): void {
    this.grant = grant;
    this.policyEstablished = true;
    // RFC-007 §6.5: revoking observe discards the filter; the server sends
    // it again if the capability is granted later.
    if (!grant.has('toolLifecycle.observe')) this.toolObserveFilter = null;
  }

  /** A §5.3 grant belongs to one initialized transport epoch. Reconnecting
   * performs a fresh initialize handshake, so authority from the dead epoch
   * must be revoked before the replacement transport is exposed. */
  private resetPolicyForTransportBoundary(): void {
    this.grant = CapabilityGrant.empty();
    this.policyEstablished = false;
    this.transportEpoch++;
    this.transportEnded.abort();
    this.transportEnded = new AbortController();
    // What the server sent that is still held came on the transport that is
    // now gone. What it said about its own process is dropped: its requests
    // wait on answers that can no longer reach whoever asked (an inference
    // request, a host/command), and its announcements describe a process
    // that is gone (a tools/observe filter, a channel registration), so the
    // next one announces its own. What it reported about the world is kept: a
    // channel's incoming messages and its pushes, which the next process
    // doesn't send again when its bridge records them as forwarded first, as
    // discord-mcpl does with its watermark. They are admitted at the flush
    // against the next transport's grant, like anything held, and an answer
    // to one is never written to the next transport (sameTransport); a
    // connection closed for good, with no next transport, drops them. The
    // host's own reports about the transport stay too: its lifecycle
    // (connect-failed, reconnect-failed), the server's stderr, and
    // orphaned-response audits.
    this.replaceHeld(this.keepAcrossBoundary(this.bufferedEvents));
    // The next transport numbers its requests afresh (RFC-014's tap).
    this.hintedRequests.clear();
    // RFC-007 §6.5: a filter is per connection epoch — after a reconnect the
    // server sends it again, and until then receives metadata only.
    this.toolObserveFilter = null;
    // §17 tracking is per-epoch for the same reason the grant is: these are
    // facts about what THIS host fetched/negotiated on THIS initialized
    // transport, and a fresh initialize starts a fresh manifest history
    // (Sol, PR #84 review — they previously survived into the new epoch).
    this.manifestState = { lastValidatedRevision: null, lastFetchedAt: null, lastNegotiatedAt: null };
  }

  /** What of these held items a transport boundary keeps (see
   *  resetPolicyForTransportBoundary), in order, each marked `kept`; the
   *  rest is logged and dropped. A connection closed for good has no next
   *  transport whose grant could admit what the server reported about the
   *  world, so that is dropped too. */
  private keepAcrossBoundary(held: HeldItem[]): HeldItem[] {
    const forGood = this.closedForGood;
    const drops = (item: HeldItem) => McplServerConnection.PROCESS_EVENTS.has(item.event)
      || (forGood && McplServerConnection.WORLD_EVENTS.has(item.event));
    const kept = held.filter((item) => !drops(item));
    if (kept.length < held.length) {
      // Named by event, with a count, so a dropped request a server was
      // waiting on, which no answer will now reach, can be told apart.
      const counts = new Map<string, number>();
      for (const item of held) if (drops(item)) counts.set(item.event, (counts.get(item.event) ?? 0) + 1);
      const what = [...counts].map(([event, count]) => `${count} ${logValue(event)}`).join(', ');
      console.error(
        `[mcpl] ${this.id}: dropped ${held.length - kept.length} held message(s) from a transport that closed` +
        `${forGood ? ', with no transport to come' : ''}: ${what}`,
      );
    }
    return kept.map((item) => ({ ...item, kept: true as const }));
  }

  /** Hold these items in place of what is held, with heldRequests and
   *  keptRequests counting the requests among them: a boundary keeps some of
   *  what was held, a flush that crosses one holds the rest of its snapshot
   *  again, and a flush starts from nothing held. Notifications need no cap
   *  here: hold caps them kept or not, and what this is given never has more
   *  than was held. */
  private replaceHeld(items: HeldItem[]): void {
    // The kept bound holds here too: boundaries that come with no flush
    // between them each keep what the next transport held, so it's checked
    // where they're joined. The earliest kept are kept, as at hold.
    let kept = 0;
    let past = 0;
    this.bufferedEvents = items.filter((item) => {
      if (item.kept !== true || !McplServerConnection.hasResponder(item)) return true;
      if (kept < McplServerConnection.MAX_HELD_REQUESTS) { kept++; return true; }
      past++;
      return false;
    });
    this.heldRequests = this.bufferedEvents.filter((item) => !item.kept && McplServerConnection.hasResponder(item)).length;
    this.keptRequests = kept;
    if (past > 0) {
      this.droppedKeptRequests += past;
      console.error(
        `[mcpl] ${this.id}: kept-request bound (${McplServerConnection.MAX_HELD_REQUESTS}) — ` +
        `dropped ${past} request(s) a closed transport left`,
      );
    }
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
  private orphanedRequests = new Map<string | number, {
    method: string;
    renderParams?: { featureSet: string; key: string; eventId: string; channelId?: string };
  }>();
  private closed = false;
  /** Set by `reconnectAfterFailure()` before it closes a live transport, so
   *  the transport close handler reports that teardown as `byHost: true`. */
  private hostCloseRequested = false;
  /** Set by `close()`: this host has stopped the connection, as a removal and
   *  a restart both do, so a request after it can't say whether the server
   *  comes back. */
  private closedByThisHost = false;
  /** The host's close attempt: in flight, or done. A failed one is cleared,
   *  so the next close() tries again. */
  private closePromise: Promise<void> | null = null;
  /** The host closed this connection while it was live, and its teardown
   *  hasn't completed yet: 'close' is emitted once it has. */
  private closeIncomplete = false;

  /** Per-request timeout in ms (0 disables). See McplServerConfig.requestTimeoutMs. */
  private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  /** The deadline a channels/publish or channels/open request keeps when
   *  requestTimeoutMs is 0 (see sendChannelsPublish). */
  private publishDeadlineMs = DEFAULT_REQUEST_TIMEOUT_MS;

  // Event buffering: control-plane traffic can be released independently from
  // inference-bearing data-plane traffic. This lets a server finish its own
  // registration (and answer host tools/call requests) while its data plane
  // stays held, as through a quiesce.
  private controlPlaneReady = false;
  private dataPlaneReady = false;
  private bufferedEvents: HeldItem[] = [];
  /** How many of bufferedEvents are server→host requests, each holding a
   *  responder its server waits on. Every change to bufferedEvents keeps it. */
  private heldRequests = 0;
  /** How many of bufferedEvents are requests a transport boundary kept:
   *  incoming messages and pushes whose transport has closed. No server waits
   *  on them, since their answers can't reach it (sameTransport), so they
   *  stay out of the held-request budget, which bounds what a live server
   *  waits on: a dead process's backlog must not refuse the next process's
   *  registration. They have their own bound at the same size, past which a
   *  kept request is dropped and logged, there being no one to refuse. */
  private keptRequests = 0;
  /** Kept requests dropped at their bound since the planes last opened
   *  (ready()), so the first of each run of drops is logged. */
  private droppedKeptRequests = 0;
  /** Cap on held notifications (responder-less events) during a plane pause
   *  (issue #122), counted apart from requests: past it, the oldest held
   *  notification is dropped. */
  private static readonly MAX_HELD_NOTIFICATIONS = 1000;
  /** Budget of held requests during a plane pause (#387), counted apart from
   *  notifications: past it, a request is refused at once, never dropped. It
   *  bounds a server that pipelines requests without waiting for answers. A
   *  server that doesn't send a refused request again loses it (discord-mcpl
   *  doesn't), so the budget sits far above the notifications' cap, to leave
   *  a busy server's long pause room. Requests a transport boundary kept are
   *  counted apart from it (keptRequests), with a bound of the same size past
   *  which they're dropped, since no server waits on them. */
  private static readonly MAX_HELD_REQUESTS = 10_000;
  private droppedBufferedEvents = 0;
  /** Requests refused at the budget since the planes last opened (ready()),
   *  so each pause's first refusal is logged. */
  private refusedHeldRequests = 0;

  // Reconnect state (adapted from Anarchid/agent-framework@mcpl-module-proto)
  private config: McplServerConfig | null = null;
  /** The redactor of the server's text for `config`, made at its first error
   *  answer, by when `config` is set, and kept: a framework-launched child's
   *  `env` is a getter that reads the awareness ledger, so a redactor built
   *  per answer would read it per answer (#540's review, R1-2). An answer
   *  takes one build of it for its words, data and log line (`now()`), so
   *  it reads the ledger at most once. It builds again only after a build
   *  that failed, which withholds that answer's text, or once a dial notes
   *  something new (serverTextRedactor). */
  private redactor: ServerTextRedactor | null = null;
  private hostCapabilities: McplHostCapabilities | null = null;
  private reconnectEnabled = false;
  private reconnectIntervalMs = 5000;
  private reconnectMaxIntervalMs = 300_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed connect attempts since the last successful handshake.
   *  Drives the exponential backoff and is reported on reconnect events. */
  private reconnectAttempts = 0;
  /** The reconnect attempt in flight, so close() can abort it and wait for
   *  its cleanup. */
  private reconnecting: { abort: AbortController; done: Promise<void> } | null = null;
  /**
   * Launches whose cleanup couldn't confirm that the child exited. While any
   * is held, reconnecting is halted, since another launch could run beside
   * one that's still alive. close() retries their reap.
   */
  private unreaped: Array<{ transport: McplTransport; failure: Error }> = [];

  /** Whether a background reconnect loop will revive this connection after a
   *  drop. False once close() has been called (explicit close stops retrying),
   *  after a protocol-version verdict, and while a launch is unreaped. */
  get willReconnect(): boolean {
    return this.reconnectEnabled;
  }

  /**
   * Stop reconnecting, closing nothing: a retry already scheduled starts
   * nothing when its timer fires, none is scheduled after, and an attempt
   * under way is aborted, as close() aborts it, so one still waiting on its
   * access provider never dials and a child it spawned is reaped. The host's
   * stop() does this first, so nothing is launched or dialed while it shuts
   * down; close() clears the timer.
   * @internal For the framework's stop(); not a host API.
   */
  stopReconnecting(): void {
    this.reconnectEnabled = false;
    this.reconnecting?.abort.abort();
  }

  /** Whether a child this connection launched couldn't be confirmed exited.
   *  While it's true the connection owns that child, so whatever registered
   *  it keeps its id held; close() retries the reap. */
  get holdsUnreapedChild(): boolean {
    return this.unreaped.length > 0;
  }

  /** Closed with no reconnect to come: after close(), whether or not its
   *  transport close succeeded, or a drop with reconnect off. A connection
   *  between retries keeps reconnectEnabled, so it isn't closed for good. */
  private get closedForGood(): boolean {
    return this.closed && !this.reconnectEnabled;
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
   *
   * Once the connection is closed for good it readies nothing. Its policy was
   * reset when it closed, so what the server sent that needs a grant would be
   * refused, and a closed connection sends no response, so nothing it held
   * could be answered. It delivers only its own reports of how it ended (see
   * {@link deliverOwnReports}). A connection between retries isn't closed for
   * good: what it held, such as a reconnect stub's connect-failed, reaches
   * its listeners as it does any connection's, except the incoming messages
   * and pushes a transport boundary kept, which wait for the next
   * transport's grant (see {@link flushHeld}).
   */
  ready(): void {
    if (this.closedForGood) {
      this.deliverOwnReports();
      return;
    }
    this.controlPlaneReady = true;
    this.dataPlaneReady = true;
    const pending = this.bufferedEvents;
    this.replaceHeld([]);
    // The cap's drops are counted per pause: this flush ends one, so its line
    // reports that pause's drops, and the next pause counts (and logs) its own.
    const dropped = this.droppedBufferedEvents;
    this.droppedBufferedEvents = 0;
    this.refusedHeldRequests = 0;
    this.droppedKeptRequests = 0;
    if (pending.length > 200) {
      console.error(
        `[mcpl] ${this.id}: flushing ${pending.length} buffered event(s) synchronously ` +
        `(long pause backlog${dropped > 0 ? `; ${dropped} dropped at cap` : ''})`,
      );
    }
    // Re-enter the gate for every buffered item. A control handler (a
    // host/command quiesce, say) may pause the data plane while this
    // snapshot is being flushed; later data items must observe that pause.
    this.flushHeld(pending);
  }

  /**
   * Re-emit a held snapshot through the admission gate (this.emit), inside
   * the containment boundary every inbound event shares
   * (dispatchInboundEvent), in admission order (admissionOrder). A transport
   * boundary crossed during the flush (a listener that closes the connection,
   * say) leaves the rest of the snapshot to the boundary rule, as if it had
   * still been held: what the server said about its own process is dropped,
   * and the rest is held again, after whatever this flush held.
   *
   * Between transports, the incoming messages and pushes a boundary kept
   * stay held for the next transport's grant: admitted now, they would meet
   * the empty grant the boundary left, with no transport to answer on. The
   * host's own reports about the transport (a stub's connect-failed, say)
   * need no grant and go on.
   */
  private flushHeld(snapshot: HeldItem[]): void {
    const waits = (item: HeldItem) => item.kept === true && McplServerConnection.WORLD_EVENTS.has(item.event);
    let pending = snapshot;
    if (!this.isConnected && snapshot.some(waits)) {
      this.replaceHeld([...this.bufferedEvents, ...snapshot.filter(waits)]);
      pending = snapshot.filter((item) => !waits(item));
    }
    const ordered = McplServerConnection.admissionOrder(pending);
    const epoch = this.transportEpoch;
    for (let index = 0; index < ordered.length; index++) {
      if (this.transportEpoch !== epoch) {
        this.replaceHeld([...this.bufferedEvents, ...this.keepAcrossBoundary(ordered.slice(index))]);
        return;
      }
      const { event, args, kept } = ordered[index]!;
      // What it can't admit yet is held again, as the admission gate would
      // hold it, with what a boundary kept still marked as kept.
      if (kept && !this.planeReadyFor(event)) this.hold(event, args, kept);
      else this.dispatchInboundEvent(event, ...args);
    }
  }

  /** Whether the plane an event belongs to is open (lifecycle events always
   *  pass), as the admission gate (emit) decides it. */
  private planeReadyFor(event: string): boolean {
    return McplServerConnection.isLifecycleEvent(event)
      || (McplServerConnection.isControlPlaneEvent(event) ? this.controlPlaneReady : this.dataPlaneReady);
  }

  /**
   * The order a flush admits a held snapshot in: as it was held, except that
   * when it holds items a transport boundary kept, the current transport's
   * channel registrations (`channels-register`, `channels-changed`) go
   * first, each unless it names a channel that something the transport sent
   * before it, and that stays where it was held, also names (below). The
   * registry refuses a message for a channel it doesn't know
   * (§14.5). It keeps a server's channels across a reconnect, but a
   * registration the old process sent that was still held at the boundary
   * was dropped with it (keepAcrossBoundary), so the next process registers
   * that channel anew, behind what was kept: a kept message for it admitted
   * first would be refused, and lost, since a bridge that recorded it as
   * forwarded doesn't send it again.
   * Nothing else moves, so a snapshot with nothing kept is flushed as it was
   * held. A registration also passes whatever its own transport sent before
   * it, which a server that announces its channels first, as a bridge does,
   * never has. A removal stays where it was held, with whatever else it adds
   * or updates, as everything does that isn't a registration. A registration
   * that names a channel which an earlier removal, or an earlier registration
   * that stays, names stays where it was held too, so the writes to one
   * channel keep their order: a channel's removal and its re-registration,
   * and two registrations or updates of it. In a flush that opens both
   * planes, what the transport sent before a removal is admitted before it,
   * its messages for that channel included. A flush that opens only the control
   * plane, as during a quiesce, admits the control traffic, a removal
   * included, and holds the data plane's again until that plane opens, as
   * live traffic is during a quiesce: a message held for a channel a removal
   * took is then refused as the data plane opens.
   */
  private static admissionOrder(pending: HeldItem[]): HeldItem[] {
    if (!pending.some((item) => item.kept)) return pending;
    const registrations = new Set<HeldItem>();
    // The channels named so far by a removal or registration that stays
    // where it was held.
    const staying = new Set<string>();
    for (const item of pending) {
      if (item.kept) continue;
      if (item.event !== 'channels-register' && item.event !== 'channels-changed') continue;
      const removes = McplServerConnection.removedChannelIds(item);
      const registers = McplServerConnection.registeredChannelIds(item);
      if (removes.length === 0 && !registers.some((id) => staying.has(id))) {
        registrations.add(item);
        continue;
      }
      for (const id of [...removes, ...registers]) staying.add(id);
    }
    if (registrations.size === 0) return pending;
    return [...registrations, ...pending.filter((item) => !registrations.has(item))];
  }

  /** The channels a held `channels-changed` removes. The registry takes any
   *  entry of `removed` as a channel id, by its string form, so a number
   *  removes the channel of its digits; an object is left out here, since
   *  its string form can throw. */
  private static removedChannelIds(item: HeldItem): string[] {
    if (item.event !== 'channels-changed') return [];
    const params = item.args[0] as { removed?: unknown } | null | undefined;
    return Array.isArray(params?.removed)
      ? params.removed.filter((id) => typeof id !== 'object' || id === null).map((id) => String(id))
      : [];
  }

  /** The channels a held `channels-register` registers, or a held
   *  `channels-changed` adds or updates. */
  private static registeredChannelIds(item: HeldItem): string[] {
    const params = item.args[0] as { channels?: unknown; added?: unknown; updated?: unknown } | null | undefined;
    const lists = item.event === 'channels-register' ? [params?.channels] : [params?.added, params?.updated];
    return lists.flatMap((list) => (Array.isArray(list) ? list : []))
      .map((channel) => (channel as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /**
   * Release only server-establishment and lifecycle/control traffic. Responses
   * to host requests are never event-buffered, so tools/list and tools/call
   * responses remain live as well. Inference-bearing requests stay queued in
   * their original relative order until {@link ready} is called. Like
   * {@link ready}, once the connection is closed for good it delivers only
   * its own reports of how it ended.
   */
  readyControlPlane(): void {
    if (this.closedForGood) {
      this.deliverOwnReports();
      return;
    }
    this.controlPlaneReady = true;
    const pending = this.bufferedEvents;
    this.replaceHeld([]);
    // Re-enter the ADMISSION gate (this.emit), never super.emit: control
    // events include channels-register/changed, which are grant-gated —
    // the old direct flush bypassed positive-grant enforcement entirely
    // (PR #79 review blocker 3). Data-plane items re-buffer in order via
    // the same call, since dataPlaneReady is still false.
    this.flushHeld(pending);
  }

  /**
   * A connection closed for good still says how it ended. Its own buffered
   * connect-failed and reconnect-failed, such as the permanent failure of a
   * launch held as unreaped before the first gate released it, are the
   * framework's records of it: they need no grant, and its listeners act on
   * them (a trace, and for a permanent failure an alert and its tools leaving
   * the list). What the server sent stays held.
   */
  private deliverOwnReports(): void {
    const own = (item: { event: string }) => item.event === 'connect-failed' || item.event === 'reconnect-failed';
    const reports = this.bufferedEvents.filter(own);
    if (reports.length === 0) return;
    // The host's own reports have no responder, so the request counts stand.
    this.bufferedEvents = this.bufferedEvents.filter((item) => !own(item));
    for (const { event, args } of reports) super.emit(event, ...args);
  }

  /**
   * Close the data plane synchronously while leaving an already-released
   * control plane live. Used by quiesce, and by reconnectAfterFailure before
   * its teardown. A reconnect closes both planes instead.
   */
  pauseDataPlane(): void {
    this.dataPlaneReady = false;
  }

  /**
   * Override emit to buffer server→host events until the corresponding plane
   * is ready. Lifecycle events always pass through so the reconnect listener
   * runs before the fresh transport's buffered traffic is released.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const name = typeof event === 'string' ? event : '';
    if (this.planeReadyFor(name)) {
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
          console.error(`[mcpl] ${this.id}: discarded ${logValue(name)} — "${requiredCap}" ${phase}`);
        }
        return true;
      }
      // §6.6: a request that will never be answered MUST get an error. A
      // request whose event nothing on this host listens for would never be.
      const request = args[1] as {
        respond?: (result: unknown) => void;
        respondError?: (code: number, message: string, data?: unknown) => void;
      } | undefined;
      if (typeof request?.respondError === 'function' && this.listenerCount(event) === 0) {
        request.respondError(-32601, 'Method not found');
        console.error(`[mcpl] ${this.id}: answered -32601 to ${logValue(name)}, which nothing on this host handles`);
        return true;
      }
      // mcpl/manifestChanged (§17.3) and tools/list_changed are notifications.
      // Sent as a request, either is answered with an empty result as it's
      // admitted, and passed on as the notification is, with no responder:
      // the host acts on it the same way, so the answer doesn't depend on what
      // the refresh does, and it's written before any request the refresh
      // sends. This is where live routing and buffer flushes meet, so a request
      // held while its plane is closed is answered only when it's let through,
      // never by a startup that fails first.
      if ((name === 'manifest-changed' || name === 'tools-list-changed') && typeof request?.respond === 'function') {
        request.respond({});
        return super.emit(event, args[0]);
      }
      return super.emit(event, ...args);
    }
    return this.hold(name, args);
  }

  /**
   * Hold an event until its plane opens, `kept` when a transport boundary
   * keeps it for the next transport's grant (afterBoundary).
   */
  private hold(name: string, args: unknown[], kept?: true): true {
    // Held until the plane opens. A long pause (a quiesce, say) on a busy or a
    // runaway server would otherwise grow this array without bound, so
    // requests and notifications each have a bound, counted apart. A request
    // holds a responder its server waits on, and dropping it would strand that
    // call, so past MAX_HELD_REQUESTS (#387) it's refused at once with -32000,
    // the code of the host's other transient refusals, and its server can send
    // it again. A notification has no one to tell, so past
    // MAX_HELD_NOTIFICATIONS (issue #122) the oldest held notification is
    // dropped to make room. A request a closed transport left (`kept`) has
    // no server waiting on it, so it's counted apart, as keptRequests, and
    // dropped past its own bound. A flush takes the whole buffer and zeroes
    // its counts, so what it holds again was admitted within these bounds
    // and stays within them.
    const responder = args[1] as { respond?: unknown; respondError?: (code: number, message: string) => void } | undefined;
    const isRequest = McplServerConnection.hasResponder({ args });
    if (isRequest && kept) {
      // A request a closed transport left (keptRequests): no server waits on
      // it, so past its own bound it's dropped, with nobody to refuse.
      if (this.keptRequests >= McplServerConnection.MAX_HELD_REQUESTS) {
        this.droppedKeptRequests++;
        if (this.droppedKeptRequests % 100 === 1) {
          console.error(
            `[mcpl] ${this.id}: kept-request bound (${McplServerConnection.MAX_HELD_REQUESTS}) — ` +
            `dropped ${this.droppedKeptRequests} request(s) a closed transport left`,
          );
        }
        return true;
      }
      this.bufferedEvents.push({ event: name, args, kept });
      this.keptRequests++;
      return true;
    }
    if (isRequest && this.heldRequests >= McplServerConnection.MAX_HELD_REQUESTS) {
      this.refusedHeldRequests++;
      if (this.refusedHeldRequests % 100 === 1) {
        console.error(
          `[mcpl] ${this.id}: held-request budget (${McplServerConnection.MAX_HELD_REQUESTS}) — ` +
          `refused ${this.refusedHeldRequests} request(s) with -32000 while the plane is paused`,
        );
      }
      responder?.respondError?.(
        -32000,
        `the host is busy: ${McplServerConnection.MAX_HELD_REQUESTS} of this server's requests are already waiting; send this one again later`,
      );
      return true;
    }
    if (!isRequest && this.bufferedEvents.length - this.heldRequests - this.keptRequests >= McplServerConnection.MAX_HELD_NOTIFICATIONS) {
      this.droppedBufferedEvents++;
      if (this.droppedBufferedEvents % 100 === 1) {
        console.error(
          `[mcpl] ${this.id}: buffered-event cap (${McplServerConnection.MAX_HELD_NOTIFICATIONS}) — ` +
          `dropped ${this.droppedBufferedEvents} responder-less event(s) while the plane is paused`,
        );
      }
      const oldest = this.bufferedEvents.findIndex((item) => !McplServerConnection.hasResponder(item));
      if (oldest >= 0) this.bufferedEvents.splice(oldest, 1);
    }
    this.bufferedEvents.push(kept ? { event: name, args, kept } : { event: name, args });
    if (isRequest) this.heldRequests++;
    return true;
  }

  /** A buffered server→host request: it carries a responder its server waits on. */
  private static hasResponder(item: { args: unknown[] }): boolean {
    const responder = item.args[1] as { respond?: unknown } | undefined;
    return typeof responder?.respond === 'function';
  }

  /** Events routed from a server's transport that report the world, which
   *  the next process doesn't send again when its bridge records them as
   *  forwarded first: kept at a transport boundary while held. */
  private static readonly WORLD_EVENTS: ReadonlySet<string> = new Set(['channels-incoming', 'push-event']);

  /** Events routed from a server's transport that speak for its process, not
   *  the world: dropped at a transport boundary while held. */
  private static get PROCESS_EVENTS(): ReadonlySet<string> {
    return new Set(Object.values(McplServerConnection.METHOD_TO_EVENT)
      .filter((event) => !McplServerConnection.WORLD_EVENTS.has(event)));
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
    // RFC-007 §4.1: tools/observe is accepted only under toolLifecycle.observe
    // (-32002 otherwise, including before the §5.3 policy exchange).
    'tools-observe': 'toolLifecycle.observe',
  };

  private static isControlPlaneEvent(event: string): boolean {
    return event === 'stderr'
      || event === 'scope-elevate'
      || event === 'channels-register'
      || event === 'channels-changed'
      || event === 'tools-list-changed'
      // RFC-007: a filter is policy-shaped and only narrows; applying it
      // while the data plane is paused can only reduce what is sent.
      || event === 'tools-observe'
      || event === 'connect-failed'
      || event === 'reconnect-failed'
      || event === 'orphaned-response'
      // host/command is OPERATOR traffic, not agent-wake traffic: it must
      // stay deliverable while the data plane is paused, or a quiesced host
      // could never receive the `resume` that lifts the pause (issue #122 —
      // the command would buffer behind the very gate it is meant to open).
      // The allowHostCommands authority check lives on the emit pass path
      // below, so promotion does not widen who may issue commands.
      || event === 'host-command';
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
   * {@link openTransport}). Throws if the configuration can't be used (before
   * anything is spawned or dialed), the transport can't be opened, the server
   * closes/errors before the handshake, or the handshake times out. If the
   * failed launch's cleanup can't confirm its child exited, it throws
   * {@link McplUnreapedLaunchError}, whose connection owns that launch.
   */
  static async connect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
    signal?: AbortSignal,
  ): Promise<McplServerConnection> {
    McplServerConnection.checkConfig(config);
    return McplServerConnection.connectChecked(config, hostCapabilities, signal);
  }

  /** {@link connect}, for a configuration its caller has already checked
   *  (and warned about) once. `signal` ends the connect at once, its launch
   *  reaped as for any failed handshake: its caller's stop() or a
   *  disconnect of its id. */
  private static async connectChecked(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
    signal?: AbortSignal,
  ): Promise<McplServerConnection> {
    let established: Awaited<ReturnType<typeof McplServerConnection.handshake>>;
    try {
      established = await McplServerConnection.handshake(config, hostCapabilities, signal);
    } catch (error) {
      if (!(error instanceof HandshakeCleanupError)) throw error;
      // The launch may still be running. A connection owns it, closed and
      // halted, so the caller can retry the reap by closing it.
      const owner = McplServerConnection.createDisconnectedStub(config, hostCapabilities);
      owner.holdUnreaped(error.transport, error.cleanup);
      throw new McplUnreapedLaunchError(owner, error.failure, error.cleanup);
    }
    const { transport, capabilities, droppedCapabilities, mcpToolsAdvertised, protocolVersion, toolsetDeclarations } = established;

    const connection = new McplServerConnection(config.id, capabilities, transport);
    connection.toolsetDeclarations = toolsetDeclarations;
    connection.droppedCapabilities = droppedCapabilities;
    connection.mcpToolsAdvertised = mcpToolsAdvertised;
    connection.protocolVersion = protocolVersion;
    connection.allowHostCommands = config.allowHostCommands === true;
    connection.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // Its configuration, which a reconnect reads and every log line of the
    // server's text redacts with. Only `true` turns reconnect on, as at
    // every other reader of it.
    connection.config = config;
    if (config.reconnect === true) {
      connection.hostCapabilities = hostCapabilities;
      connection.reconnectEnabled = true;
      connection.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;
      connection.reconnectMaxIntervalMs = config.reconnectMaxIntervalMs ?? 300_000;
    }

    return connection;
  }

  /**
   * This engine's configuration check, made before anything is spawned or
   * dialed: every problem {@link checkServerConfig} finds, the same check the
   * framework applies, and the modern family, which belongs to
   * ModernMcpConnection (an http(s) url is never dialed as a WebSocket).
   * Every configuration that worked before still passes but the one
   * serverConfigProblems names.
   */
  private static checkConfig(config: McplServerConfig): void {
    const { family } = checkServerConfig(config);
    if (family === 'modern') {
      throw new Error(
        `MCP server "${config.id}" is configured for modern MCP (${MODERN_MCP_PROTOCOL_VERSION}); ` +
        `McplServerConnection speaks the legacy family (${MCP_PROTOCOL_VERSION} + MCPL) only`,
      );
    }
  }

  /**
   * Open a fresh transport and run the MCP/MCPL initialize handshake over it,
   * returning the connected transport plus the negotiated capabilities. Shared
   * by {@link connect} and {@link attemptReconnect} so both transports handshake
   * identically. On any failure the transport is closed so a spawned child /
   * open socket never leaks. If that close can't confirm the child exited,
   * the failure is a {@link HandshakeCleanupError} carrying the transport, so
   * the caller keeps owning it. `signal` ends a handshake whose connection is
   * closed meanwhile: it cuts a WebSocket dial short, is checked once the
   * transport is open, and races the initialize answer.
   */
  private static async handshake(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
    signal?: AbortSignal,
  ): Promise<{ transport: McplTransport; capabilities: McplCapabilities | null; droppedCapabilities: ReadonlySet<string>; mcpToolsAdvertised: boolean; protocolVersion: string; toolsetDeclarations: Record<string, unknown> | null }> {
    const closedWhileConnecting = () => new Error(`MCPL server "${config.id}" was closed while connecting`);
    if (signal?.aborted) throw closedWhileConnecting();
    let transport: McplTransport;
    try {
      transport = await openTransport(config, signal);
    } catch (error) {
      if (signal?.aborted) throw closedWhileConnecting();
      throw error;
    }
    // Once the handshake stops listening for 'error', this logs what the
    // transport reports, until the handshake hands the transport on, or for
    // good if the handshake fails. EventEmitter throws an 'error' that has no
    // listener, and from an I/O callback nothing catches it. A malformed
    // WebSocket frame that arrives with the initialize response, or while a
    // failed handshake's close() runs, is such an error.
    const logAfterSettled = (err: Error) => {
      console.error(`[mcpl] ${config.id}: transport error after the handshake settled: ${redactServerText(err.message, config)}`);
    };

    try {
      if (signal?.aborted) throw closedWhileConnecting();
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

      // When the transport fails, the end of the server's stderr often says
      // why, such as a missing token or a crash at startup. It goes on the
      // error as `stderrTail`, never into the message: an error's message
      // travels to traces and tool results, and a server's stderr is its own
      // text, which can hold a credential.
      const failed = (failure: string): Error & { stderrTail?: string } => {
        // It goes to the host too, so it's redacted, from a window of the
        // stream longer than the tail, so a credential the tail's cut
        // would split is whole when it's matched (stderrTailRedacted).
        const tail = transport.stderrTailRedacted(serverTextRedactor(config)).trimEnd();
        return Object.assign(new Error(failure), tail ? { stderrTail: tail } : {});
      };

      // Await the initialize response, racing an early transport close/error,
      // a timeout and the owner's close. Every path cleans up its listeners.
      const { mcpl: rawCapabilities, mcpToolsAdvertised, protocolVersion } = await new Promise<{ mcpl: McplCapabilities | null; mcpToolsAdvertised: boolean; protocolVersion: string }>((resolve, reject) => {
        const cleanup = () => {
          transport.off('line', onLine);
          transport.off('close', onClose);
          transport.off('error', onError);
          signal?.removeEventListener('abort', onAbort);
          transport.on('error', logAfterSettled);
          clearTimeout(timer);
        };
        const onAbort = () => {
          cleanup();
          reject(closedWhileConnecting());
        };
        const onLine = (line: string) => {
          const msg = messageFromLine(config.id, line, transport) as JsonRpcResponse | undefined;
          if (!msg) return;
          // A request or a notification from the server is never the
          // initialize response, whatever its id: a server's own ids can start
          // at 0, this handshake's. MCP lets a server ping before
          // initialization completes, and the ping gets its empty result, as
          // on a connected transport. Anything else it sends now is ignored.
          if ('method' in msg) {
            const request = msg as unknown as JsonRpcRequest;
            if (request.method === 'ping' && request.id != null) {
              transport.writeLine(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
            }
            return;
          }
          if (msg.id !== initId) return;
          cleanup();
          if (msg.error) {
            // describeCause rather than the template's own conversion: the
            // server's `message` can be any JSON value, and one that has no
            // primitive form, such as {"toString":1}, would throw out of this
            // listener after cleanup() has cleared the timeout: an uncaught
            // exception, which ends a host that doesn't catch them, and a
            // handshake left to wait forever. It's the server's text in an
            // error the host gets, so it's redacted, then bounded as
            // errors.ts says: a cut or a replaced character first would
            // leave part of a credential the redactor can't match.
            reject(msg.error.code === UNSUPPORTED_PROTOCOL_VERSION_CODE
              ? protocolVersionRejection(config, msg.error)
              : new Error(`MCPL server "${config.id}" initialize error: ${boundedForLog(redactServerText(describeCause(msg.error.message), config))}`));
            return;
          }
          const result = msg.result as Record<string, unknown> | undefined;
          // The server's answer is the established revision. This engine
          // implements exactly one, so any other answer (or none) means the
          // two sides never agreed on what they're speaking.
          const answered = typeof result?.protocolVersion === 'string' ? result.protocolVersion : null;
          if (answered !== MCP_PROTOCOL_VERSION) {
            // The server's words go to the host, so they're redacted.
            const returned = answered === null ? null : redactServerText(answered, config);
            reject(new McplProtocolVersionError(
              `MCPL server "${config.id}" answered initialize with protocolVersion ` +
                `${returned === null ? '(none)' : boundedForLog(JSON.stringify(returned))}; this client's legacy engine speaks only ${MCP_PROTOCOL_VERSION}`,
              'mismatch',
              returned,
              null,
            ));
            return;
          }
          const caps = result?.capabilities as Record<string, unknown> | undefined;
          const experimental = caps?.experimental as Record<string, unknown> | undefined;
          // §5.1: `tools` capability is the OUTER standard MCP member — the
          // experimental manifest cannot mint it. Carried alongside so the
          // grant can join it into §6.4 derivation.
          resolve({
            mcpl: (experimental?.mcpl as McplCapabilities) ?? null,
            mcpToolsAdvertised: caps?.tools !== undefined,
            protocolVersion: answered,
          });
        };
        const onClose = (info: TransportCloseInfo) => {
          cleanup();
          const code = transport.kind === 'websocket' && typeof info.code === 'number' ? `, code ${info.code}` : '';
          const failure = `MCPL server "${config.id}" transport closed before handshake completed (${closeReasonText(info)}${code})`;
          // The close comes at a stdio child's exit, which Node can emit before
          // it has read the last of the child's stderr, or when the host closes
          // the transport, which then ends the child. The tail is taken once
          // stderr has ended, waiting at most STDERR_END_WAIT_MS. A WebSocket
          // transport has no stderr to wait for.
          void transport.stderrEnded(STDERR_END_WAIT_MS).then(() => reject(failed(failure)));
        };
        const onError = (err: Error) => {
          cleanup();
          reject(failed(`MCPL server "${config.id}" transport error during handshake: ${err.message}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(failed(`MCPL server "${config.id}" initialize handshake timed out`));
        }, INITIALIZE_TIMEOUT_MS);

        signal?.addEventListener('abort', onAbort, { once: true });
        transport.on('line', onLine);
        transport.on('close', onClose);
        transport.on('error', onError);
        transport.writeLine(JSON.stringify(initRequest));
      });

      // The transport has stopped using the child's stdio before the
      // handshake could hand it on, such as when this host's answer to a ping
      // the server sent met EPIPE. Nothing more is written to the child then,
      // so the connection couldn't serve. It's read here, once the answer has
      // passed its own checks, rather than as the answer arrives: a write's
      // EPIPE is reported only once the callback that wrote it has returned,
      // so a ping and the answer read in one callback would pass a check made
      // there. A child that outlived SIGKILL may already have said so with
      // nothing listening (the transport's 'unreaped' is wired only once the
      // handshake hands it on). So the handshake fails, and its cleanup holds
      // the launch if it can't reap the child. A failure of the write below
      // is reported only once the caller has wired the transport, so it
      // reaches the connection as a loss, like any later one.
      const stopCause = transport.stdioStopCause;
      if (stopCause) throw failed(`MCPL server "${config.id}": this host stopped using the server's stdio during the handshake (${stopCause.message})`);

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
        console.error(`MCPL server "${config.id}" capabilities masked by host config: ${dropped.map(logValue).join(', ')}`);
      }

      // The caller wires the transport, or keeps it for close() with a
      // listener of its own, in the continuation of this return, before any
      // I/O callback can emit.
      transport.off('error', logAfterSettled);
      return {
        transport, capabilities: scoped, droppedCapabilities: new Set(dropped), mcpToolsAdvertised, protocolVersion,
        toolsetDeclarations: toolsetDeclarationsOf(rawCapabilities),
      };
    } catch (err) {
      // Never leak the child / socket if the handshake fails. A cleanup that
      // can't confirm the child exited is part of the failure, never
      // swallowed: the launch may still be running, so the caller keeps it.
      try {
        await transport.close();
      } catch (cleanup) {
        throw new HandshakeCleanupError(errorOf(err), errorOf(cleanup), transport);
      }
      throw err;
    }
  }

  /**
   * Connect with reconnect support.
   * When `config.reconnect` is true and the initial connection fails,
   * resolves immediately with null capabilities and retries in the background.
   * A configuration this engine can't use, or a protocol-version verdict,
   * still throws: retrying can't change either. So does a failed launch that
   * can't be reaped, as in {@link connect}: no retry starts beside a child
   * that may still be running, and the {@link McplUnreapedLaunchError}
   * carries the connection that owns it, whose close() retries the reap.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  static async connectWithReconnect(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
    signal?: AbortSignal,
  ): Promise<McplServerConnection> {
    // Outside the retry path below: a configuration error is never retried.
    McplServerConnection.checkConfig(config);
    try {
      return await McplServerConnection.connectChecked(config, hostCapabilities, signal);
    } catch (error) {
      // No common protocol revision is a configuration fact, not an outage:
      // a retry stub would restart the server forever for nothing. A connect
      // its caller ended (stop(), or a disconnect of its id) isn't retried
      // either, nor is a launch that couldn't be reaped.
      if (config.reconnect !== true || error instanceof McplProtocolVersionError || error instanceof McplUnreapedLaunchError || signal?.aborted) {
        throw error;
      }

      // Surface the initial failure. The event is buffered by the emit()
      // override until the host wires listeners and calls ready(), so it is
      // not lost in the window before wireMcplEvents runs.
      // Non-blocking start: create a disconnected stub that will reconnect in background
      console.error(`MCPL server "${config.id}" initial connect failed, will retry: ${redactServerText((error as Error).message, config)}${withStderr(error, (text) => redactServerText(text, config))}`);
      const stub = McplServerConnection.createDisconnectedStub(config, hostCapabilities);
      const stderrTail = stderrTailOf(error);
      stub.emit('connect-failed', { error: (error as Error).message, ...(stderrTail ? { stderrTail } : {}), attempt: 0 });
      stub.scheduleReconnect();
      return stub;
    }
  }

  /**
   * Create a disconnected stub connection, for a failed initial connect: one
   * that will reconnect in the background (its caller schedules that), or one
   * that owns a launch that couldn't be reaped.
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
    stub.reconnectEnabled = config.reconnect === true;
    stub.reconnectIntervalMs = config.reconnectIntervalMs ?? 5000;
    stub.reconnectMaxIntervalMs = config.reconnectMaxIntervalMs ?? 300_000;
    stub.reconnectAttempts = 1; // the initial connect already failed
    return stub;
  }

  /**
   * Keep a launch whose cleanup couldn't confirm its child exited, and halt
   * reconnecting: another launch could run beside one that's still alive.
   * close() retries the reap.
   */
  private holdUnreaped(transport: McplTransport, failure: Error): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.unreaped.some((held) => held.transport === transport)) this.unreaped.push({ transport, failure });
  }

  /** The halt, as a reconnect event's failure text. */
  private unreapedFailure(): string {
    const held = this.unreaped[0];
    return `the previous launch could not be reaped (${held?.failure.message ?? 'unknown'}); reconnecting is halted`;
  }

  // ==========================================================================
  // Outbound requests (return Promises)
  // ==========================================================================

  /** Send `context/beforeInference` and await result. */
  sendBeforeInference(params: BeforeInferenceParams): Promise<BeforeInferenceResult> {
    return this.sendRequest(McplMethod.BeforeInference, params as unknown as Record<string, unknown>) as Promise<BeforeInferenceResult>;
  }

  /** RFC-006 deferred push rendering; its own timeout bounds context assembly. */
  sendPushRender(params: import('./push-coalescer.js').PushRenderParams): Promise<import('./push-coalescer.js').PushRenderResult> {
    return this.sendRequest('push/render', params as unknown as Record<string, unknown>, { timeoutMs: 5000, surfaceOrphanedResponse: true }) as Promise<import('./push-coalescer.js').PushRenderResult>;
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

  /** Send `inference/chunk` notification, on the transport `epoch` names: a
   *  chunk of a request from a transport that has closed goes nowhere, as
   *  that request's answer does. */
  sendInferenceChunk(params: InferenceChunkParams, epoch = this.transportEpoch): void {
    if (epoch !== this.transportEpoch) return;
    this.sendNotification(McplMethod.InferenceChunk, params as unknown as Record<string, unknown>);
  }

  /** Send `inference/lifecycle` notification (§10.5). Best-effort. */
  sendInferenceLifecycle(params: InferenceLifecycleParams): void {
    this.sendNotification(McplMethod.InferenceLifecycle, params as unknown as Record<string, unknown>);
  }

  /** Send `tools/lifecycle` notification (RFC-007). Best-effort. The
   *  caller (ToolLifecycleEmitter) has already applied grant, narrowing,
   *  class exclusions and this connection's filter. */
  sendToolLifecycle(params: ToolLifecycleParams): void {
    this.sendNotification(McplMethod.ToolsLifecycle, params as unknown as Record<string, unknown>);
  }

  /**
   * Fetch the server's complete current manifest (§17.4) — the
   * experimental.mcpl object in the same shape initialize carries, never a
   * delta. The fetched CONTENT is authoritative for every decision; the
   * revision is only the cheap path (§17.1).
   */
  sendManifestRequest(timeoutMs = 15_000): Promise<McplCapabilities | null> {
    return this.sendRequest(McplMethod.Manifest, {}, { timeoutMs }) as Promise<McplCapabilities | null>;
  }

  /** Send `state/rollback` request and await result. */
  sendStateRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    return this.sendRequest(McplMethod.StateRollback, params as unknown as Record<string, unknown>) as Promise<StateRollbackResult>;
  }

  /** Send `channels/open` request and await result. It keeps a deadline as
   *  channels/publish does: a delivery can open a closed channel before it
   *  publishes, so an open that is never answered would hold the delivery,
   *  and the turn that waits for it, for good. */
  sendChannelsOpen(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    const timeoutMs = this.requestTimeoutMs > 0 ? this.requestTimeoutMs : this.publishDeadlineMs;
    return this.sendRequest(McplMethod.ChannelsOpen, params as unknown as Record<string, unknown>, { timeoutMs }) as Promise<ChannelsOpenResult>;
  }

  /** Send `channels/close` request and await result. It keeps a deadline as
   *  channels/open does: a delivery waits for a channel's queued lifecycle
   *  work, closes included, so a close that is never answered would hold the
   *  delivery, and the turn that waits for it, for good. */
  sendChannelsClose(params: ChannelsCloseParams): Promise<ChannelsCloseResult> {
    const timeoutMs = this.requestTimeoutMs > 0 ? this.requestTimeoutMs : this.publishDeadlineMs;
    return this.sendRequest(McplMethod.ChannelsClose, params as unknown as Record<string, unknown>, { timeoutMs }) as Promise<ChannelsCloseResult>;
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
   *
   * A request always has a deadline: the server's requestTimeoutMs, or
   * publishDeadlineMs when that is 0 (disabled). A publish is a side effect
   * whose outcome the resident is told and a held draft's attempt records,
   * so one that is never answered would hold both open for good. Its expiry
   * is a no-response, which the caller reads as unknown.
   */
  sendChannelsPublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult | void> {
    if (params.stream) {
      this.sendNotification(McplMethod.ChannelsPublish, params as unknown as Record<string, unknown>);
      return Promise.resolve();
    }
    const timeoutMs = this.requestTimeoutMs > 0 ? this.requestTimeoutMs : this.publishDeadlineMs;
    return this.sendRequest(McplMethod.ChannelsPublish, params as unknown as Record<string, unknown>, { timeoutMs }) as Promise<ChannelsPublishResult>;
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

  /**
   * Send `tools/list` and return the server's complete tool inventory,
   * following `nextCursor` across pages (2024-11-05 pagination). Cursors are
   * opaque strings, `''` included: only an absent or null `nextCursor` ends
   * the inventory (a null one is how some servers say "no more", and main
   * read it as a complete page). A page that isn't well formed (no `tools` array, a cursor
   * that isn't a string), or cursors that don't terminate (a repeat, or more
   * than {@link MAX_TOOL_LIST_PAGES} pages), are errors, never a partial or
   * empty inventory published as complete. The read tap (RFC-014) is handed
   * the complete inventory once, with the last page's `_meta`, as the last
   * page's response is read, before anything read after it; a list that
   * fails or times out hands it nothing. It's `straddled` when its pages
   * carry different `mcpl/rev`s.
   */
  async sendToolsList(): Promise<{ tools: McpToolDefinition[] }> {
    const tools: McpToolDefinition[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let first: Record<string, unknown> | undefined;
    const read: McpToolDefinition[] = [];
    const revs = new Set<unknown>();
    const onRead = (result: unknown) => {
      if (!result || typeof result !== 'object' || !Array.isArray((result as { tools?: unknown }).tools)) return;
      const r = result as { tools: McpToolDefinition[]; nextCursor?: unknown; _meta?: unknown };
      for (const t of r.tools) read.push(t);
      const rev = (r._meta as Record<string, unknown> | undefined)?.['mcpl/rev'];
      if (typeof rev === 'number') revs.add(rev);
      if (r.nextCursor !== undefined && r.nextCursor !== null) return;
      this.tap({
        kind: 'result', method: 'tools/list', params: {}, ...(revs.size > 1 ? { straddled: true } : {}),
        result: { tools: read, ...(r._meta !== undefined ? { _meta: r._meta } : {}) }, awaited: true,
      });
    };
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = await this.sendRequest('tools/list', cursor === undefined ? {} : { cursor }, { onRead }) as Record<string, unknown> | null;
      const malformed = (why: string) =>
        new Error(`MCPL server "${this.id}" sent a malformed tools/list page ${page + 1}: ${why}`);
      if (!result || typeof result !== 'object' || !Array.isArray(result.tools)) {
        throw malformed('no tools array');
      }
      first ??= result;
      for (const t of result.tools as McpToolDefinition[]) tools.push(t);
      if (result.nextCursor === undefined || result.nextCursor === null) {
        // The first page's other fields are kept as they came, so a
        // single-page answer is returned exactly as before.
        const { nextCursor: _done, ...rest } = first as { nextCursor?: unknown };
        return { ...rest, tools };
      }
      if (typeof result.nextCursor !== 'string') {
        // The cursor is the server's, so it's redacted, then bounded.
        throw malformed(`nextCursor must be a string, got ${boundedForLog(redactServerText(JSON.stringify(result.nextCursor), this.config ?? {}))}`);
      }
      if (seen.has(result.nextCursor)) {
        throw new Error(`MCPL server "${this.id}" repeated tools/list cursor ${boundedForLog(redactServerText(JSON.stringify(result.nextCursor), this.config ?? {}))}`);
      }
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`MCPL server "${this.id}" tools/list did not finish within ${MAX_TOOL_LIST_PAGES} pages`);
  }

  /** Send `tools/call` and return the result. Optionally includes
   *  state/checkpoint for stateful tools, and `_meta` (RFC-014 §5.5: the
   *  instance a call is for rides in `_meta["mcpl/instance"]`). */
  sendToolsCall(
    name: string,
    args: Record<string, unknown>,
    stateParams?: { state?: unknown; checkpoint?: string },
    meta?: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (stateParams?.state !== undefined) params.state = stateParams.state;
    if (stateParams?.checkpoint !== undefined) params.checkpoint = stateParams.checkpoint;
    if (meta !== undefined) params._meta = meta;
    return this.sendRequest('tools/call', params) as Promise<McpToolCallResult>;
  }

  /** RFC-014 §5.2 `toolsets/open` (Host → Server). The server's refusal
   *  rejects, as any error answer does. */
  sendToolsetsOpen(params: { toolset: string; instance?: string; options?: Record<string, unknown> }, timeoutMs?: number): Promise<Record<string, unknown> | null> {
    return this.sendRequest('toolsets/open', { ...params }, timeoutMs === undefined ? {} : { timeoutMs }) as Promise<Record<string, unknown> | null>;
  }

  /** RFC-014 §5.2 `toolsets/close` (Host → Server). */
  sendToolsetsClose(params: { toolset: string; instance?: string }, timeoutMs?: number): Promise<Record<string, unknown> | null> {
    return this.sendRequest('toolsets/close', { ...params }, timeoutMs === undefined ? {} : { timeoutMs }) as Promise<Record<string, unknown> | null>;
  }

  /** RFC-014 §5.3 `toolsets/list` (Host → Server): what the principal has
   *  open, and the full hint state of its dynamic tools. */
  sendToolsetsList(timeoutMs?: number): Promise<Record<string, unknown> | null> {
    return this.sendRequest('toolsets/list', {}, timeoutMs === undefined ? {} : { timeoutMs }) as Promise<Record<string, unknown> | null>;
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

  /** The requests still waiting for an answer, for the operator's log line
   *  when the connection goes: their methods and ids. */
  private unansweredRequests(): string {
    const list = [...this.pendingRequests].map(([id, pending]) => `${pending.method} (id=${id})`).join(', ');
    return `${this.pendingRequests.size} request(s) unanswered: ${list}`;
  }

  /**
   * Close the connection for good: disable reconnect, kill the child
   * process, and clean up resources. At once, as before, reconnecting stops
   * and pending requests fail; a reconnect handshake in flight is aborted.
   *
   * Calls share one attempt: while it is pending, and once it has
   * succeeded, close() returns it. The attempt waits for the aborted
   * reconnect's own cleanup, closes the transport (its close is the reaping
   * verdict) and retries each launch an earlier cleanup couldn't reap. It
   * rejects while any child can't be confirmed exited, with that failure
   * itself, or an AggregateError when there are several. A failed attempt is
   * cleared, so the next close() retries what it couldn't reap. 'close' is
   * emitted once, when the teardown of a connection the host closed while
   * live completes.
   */
  close(): Promise<void> {
    // Disable reconnect before closing — explicit close means stop retrying
    this.reconnectEnabled = false;
    this.closedByThisHost = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting?.abort.abort();
    if (this.closePromise) return this.closePromise;

    if (!this.closed) {
      this.closed = true;
      this.closeIncomplete = true;
      this.resetPolicyForTransportBoundary();

      // Reject all pending requests. Each message is the whole of what an
      // agent reads for a tools/call, and what follows a channel tool's own
      // words ("Failed to publish to channel: …") for the requests a channel
      // tool makes, so it names no method; the log line does. It doesn't say
      // whether this host reconnects: a restart closes the connection and then
      // connects again.
      if (this.pendingRequests.size > 0) {
        console.error(`MCPL server "${this.id}": this host closed its connection with ${this.unansweredRequests()}`);
      }
      for (const pending of this.pendingRequests.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new McplRequestError(
          `The "${this.id}" server didn't answer before this host closed its connection, so whether the request took effect is unknown. ` +
          'Check its effect before trying again.',
          'no-response',
        ));
      }
      this.pendingRequests.clear();
      this.orphanedRequests.clear();
    }

    const attempt = this.closeStep(this.transport, this.unreaped.map((held) => held.transport));
    this.closePromise = attempt;
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = null;
    });
    return attempt;
  }

  /** One close attempt. `heldBefore` are the launches earlier cleanups
   *  couldn't reap, which it retries. */
  private async closeStep(transport: McplTransport | null, heldBefore: McplTransport[]): Promise<void> {
    // An aborted reconnect cleans up its own launch, holding it if it can't.
    // That cleanup was this attempt's try at it, so its failure is this
    // attempt's, not retried here.
    await this.reconnecting?.done;
    const heldMeanwhile = this.unreaped.filter((held) => !heldBefore.includes(held.transport));
    const failures: Error[] = heldMeanwhile.map((held) => held.failure);
    const targets: McplTransport[] = [];
    for (const target of [transport, ...heldBefore]) {
      if (target && !targets.includes(target) && !heldMeanwhile.some((held) => held.transport === target)) targets.push(target);
    }
    for (const target of targets) {
      try {
        // Kills the child / closes the socket.
        await target.close();
        this.unreaped = this.unreaped.filter((held) => held.transport !== target);
      } catch (error) {
        const failure = errorOf(error);
        failures.push(failure);
        if (!this.unreaped.some((held) => held.transport === target)) this.unreaped.push({ transport: target, failure });
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `MCPL server "${this.id}" did not close cleanly: ${failures.map((f) => f.message).join('; ')}`);
    }
    // The transport's own 'close' event is short-circuited by `this.closed`
    // in setupLifecycle, so this is the single source of the connection
    // 'close' when the host tears down a live transport.
    if (this.closeIncomplete) {
      this.closeIncomplete = false;
      this.emit('close', null, null, this.closeInfoByHost());
    }
  }

  /**
   * Tear down a live transport after an awareness-accounting failure without
   * disabling configured auto-reconnect. The normal transport close handler
   * rejects requests, emits lifecycle state, and schedules the next bounded
   * reconnect attempt. With reconnect disabled the recycle ends the
   * connection for good, as close() does: 'close' comes once the child's
   * exit is confirmed, and a child it can't reap stays owned, holding the id.
   */
  async reconnectAfterFailure(): Promise<void> {
    this.pauseDataPlane();
    if (!this.reconnectEnabled) {
      await this.close();
      return;
    }
    if (this.closed) {
      this.scheduleReconnect();
      return;
    }
    if (this.transport) {
      this.hostCloseRequested = true;
      await this.transport.close();
      return;
    }
    this.closed = true;
    this.emit('close', null, null, this.closeInfoByHost());
    this.scheduleReconnect();
  }

  /** 'close' payload for a host-initiated teardown (no transport close code). */
  private closeInfoByHost(): McplConnectionCloseInfo {
    return {
      transport: this.transport?.kind ?? null,
      code: null,
      signal: null,
      reason: 'closed by host',
      byHost: true,
    };
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
   * leaked listeners on a dead object. The attempt is close()'s to abort,
   * and it settles only once its own launch is adopted, failed or cleaned up.
   * One attempt at a time: a request that arrives while one is in flight (a
   * recycle, say) starts nothing, since that attempt either adopts its
   * launch or schedules the next retry itself. A second attempt would take
   * close()'s ownership of the first (Iris-1827, room-293 #55410).
   */
  private async attemptReconnect(): Promise<void> {
    // A queued recovery timer may outlive an earlier successful handshake:
    // only a connection that is down reconnects, so it never replaces a live
    // transport.
    if (this.reconnecting || !this.closed || !this.reconnectEnabled || !this.config || !this.hostCapabilities) return;
    const abort = new AbortController();
    const done = this.reconnectOnce(this.config, this.hostCapabilities, abort.signal);
    this.reconnecting = { abort, done };
    await done;
    if (this.reconnecting?.done === done) this.reconnecting = null;
  }

  /** One reconnect attempt. It never rejects: each outcome is an event, a
   *  scheduled retry, or a launch held as unreaped. */
  private async reconnectOnce(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
    signal: AbortSignal,
  ): Promise<void> {
    // Ordinal of this attempt: 0 was the initial connect, so the Nth retry
    // reports attempt N (reconnectAttempts counts failures so far).
    const attempt = Math.max(1, this.reconnectAttempts);

    // The previous launch must be gone before another starts. A transport
    // the host closed itself (reconnectAfterFailure) may still be reaping its
    // child; one whose child already exited resolves at once.
    const previous = this.transport;
    if (previous) {
      try {
        await previous.close();
      } catch (error) {
        this.holdUnreaped(previous, errorOf(error));
        if (!signal.aborted) this.emit('reconnect-failed', { error: this.unreapedFailure(), attempt, permanent: true });
        return;
      }
    }
    if (signal.aborted) return;

    let established: Awaited<ReturnType<typeof McplServerConnection.handshake>>;
    try {
      established = await McplServerConnection.handshake(config, hostCapabilities, signal);
    } catch (error) {
      const unreaped = error instanceof HandshakeCleanupError;
      if (unreaped) this.holdUnreaped(error.transport, error.cleanup);
      // Closed by the host meanwhile: not a failed attempt.
      if (signal.aborted) return;
      const failure = unreaped ? error.failure : errorOf(error);
      const redact = (text: string) => redactServerText(text, this.config ?? {});
      console.error(`MCPL server "${this.id}" reconnect failed: ${redact(failure.message)}${withStderr(failure, redact)}`);
      this.reconnectAttempts = attempt + 1;
      // No common protocol revision: every further attempt would restart the
      // server to hear the same answer. Stop retrying; the configuration is
      // what has to change. A launch that couldn't be reaped halts retrying
      // for good: close() can confirm its exit, but close() is terminal, so
      // nothing resumes this connection. Every other failure keeps the
      // backoff loop.
      if (error instanceof McplProtocolVersionError) this.reconnectEnabled = false;
      const permanent = unreaped || error instanceof McplProtocolVersionError;
      const message = unreaped ? `${failure.message}; ${this.unreapedFailure()}` : failure.message;
      const stderrTail = stderrTailOf(failure);
      this.emit('reconnect-failed', { error: message, ...(stderrTail ? { stderrTail } : {}), attempt, ...(permanent ? { permanent: true } : {}) });
      if (!permanent) this.scheduleReconnect();
      return;
    }
    const { transport, capabilities, droppedCapabilities, mcpToolsAdvertised, protocolVersion, toolsetDeclarations } = established;

    if (signal.aborted) {
      // Closed by the host while the handshake finished: this launch never
      // serves. close() is waiting on this attempt, so it hears the verdict.
      // The transport isn't wired, and the handshake has taken its own
      // listeners off, so an error it reports while it closes, such as a
      // malformed frame from a WebSocket server, is logged here rather than
      // thrown where nothing catches it.
      transport.on('error', (err: Error) => {
        console.error(`[mcpl] ${this.id}: a transport closed before it served reported an error: ${redactServerText(err.message, config)}`);
      });
      await transport.close().catch((error: unknown) => this.holdUnreaped(transport, errorOf(error)));
      return;
    }

    // Close both planes before the new transport can emit, as at initial
    // connect: its traffic is admitted against the grant, which this
    // boundary resets, so control traffic too (a server's channels/register
    // right after initialize) must wait for the new grant rather than be
    // refused against the empty one. The reconnect lifecycle event bypasses
    // buffering; its framework listener re-establishes the grant (§5.3
    // policy responses are never buffered), and then opens the planes.
    this.controlPlaneReady = false;
    this.dataPlaneReady = false;
    this.resetPolicyForTransportBoundary();
    this.transport = transport;
    this.capabilities = capabilities;
    this.toolsetDeclarations = toolsetDeclarations;
    this.droppedCapabilities = droppedCapabilities;
    this.mcpToolsAdvertised = mcpToolsAdvertised;
    this.protocolVersion = protocolVersion;
    this.allowHostCommands = this.config?.allowHostCommands === true;
    this.closed = false;
    this.nextRequestId = 1;
    this.pendingRequests.clear();
    this.wireTransport(transport);

    console.error(`MCPL server "${this.id}" reconnected successfully`);
    this.reconnectAttempts = 0;
    this.emit('reconnect', { attempts: attempt });
  }

  // ==========================================================================
  // Private: message sending
  // ==========================================================================

  /**
   * A request refused before anything is kept for it, as `error`, with its
   * operator's line logged after the refusal: a host logger that throws then
   * loses that line, and can't turn the refusal into a throw from the call.
   */
  private static refused(error: McplRequestError, line: string): Promise<never> {
    return new Promise((_, reject) => {
      reject(error);
      console.error(line);
    });
  }

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
      // After this host's own close, which a restart makes before connecting
      // again and a removal makes for good, only that this host closed it
      // holds, and one next step holds for both: calling again reaches the
      // restarted server, or fails where it's gone.
      return Promise.reject(new McplRequestError(this.closedByThisHost
        ? `The request wasn't sent: this host closed its connection to the "${this.id}" server, so nothing ran. ` +
          'If calling it again fails, ask whoever runs this host.'
        : `The request wasn't sent: the connection to the "${this.id}" server is closed, so nothing ran. ` +
          (this.willReconnect
            ? 'This host is reconnecting to it; try again later.'
            : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host."),
        'not-sent',
      ));
    }
    const stopCause = this.transport?.stdioStopCause;
    if (stopCause) {
      return McplServerConnection.refused(
        new McplRequestError(
          `The request wasn't sent: this host can no longer write to the "${this.id}" server, so nothing ran. ` +
            (this.willReconnect
              ? 'This host is reconnecting to it; try again later.'
              : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host."),
          'not-sent',
        ),
        `MCPL server "${this.id}": ${method} not sent, since this host stopped using the server's stdio (${logDetail(stopCause.message)})`,
      );
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      id,
      params,
    };
    // A request JSON can't write (a BigInt, a cycle) never leaves this host,
    // and calling again fails the same way, so it's refused before anything
    // is kept for it, in the modern engine's words (#556). The method, id and
    // the serializer's words are the operator's.
    let line: string;
    try {
      line = JSON.stringify(request);
    } catch (err) {
      return McplServerConnection.refused(
        new McplRequestError(
          `The request wasn't sent: this host couldn't send it to the "${this.id}" server, so nothing ran. ` +
            'If calling it again fails, ask whoever runs this host.',
          'not-sent',
        ),
        `MCPL server "${this.id}": ${method} (id=${id}) not sent, since it can't be written as JSON: ${logDetail(err instanceof Error ? err.message : err)}`,
      );
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, method, ...(options.onRead ? { onRead: options.onRead } : {}) };
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          if (options.surfaceOrphanedResponse) {
            this.orphanedRequests.set(id, {
              method,
              ...(method === 'push/render'
                ? {
                  renderParams: {
                    featureSet: params.featureSet as string,
                    key: params.key as string,
                    eventId: params.eventId as string,
                    ...(typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
                  },
                }
                : {}),
            });
            if (this.orphanedRequests.size > 4096) this.orphanedRequests.delete(this.orphanedRequests.keys().next().value!);
          }
          // The method and id are the operator's, so they go to the log.
          console.error(
            `MCPL server "${this.id}" did not respond to ${method} (id=${id}) within ${timeoutMs}ms; ` +
            'the request was abandoned here, not cancelled',
          );
          const seconds = timeoutMs / 1000;
          reject(new McplRequestError(
            `The "${this.id}" server didn't answer within ${seconds} second${seconds === 1 ? '' : 's'}, ` +
            'so whether the request took effect is unknown: ' +
            'it was abandoned here, not cancelled, and may still complete on the server. ' +
            'Check its effect before trying again, since repeating something that changes state may do it twice.',
            'no-response',
          ));
        }, timeoutMs);
        // Don't hold the event loop open for the watchdog alone.
        pending.timer.unref?.();
      }
      this.pendingRequests.set(id, pending);
      // RFC-014: a request whose result can carry hints is remembered past
      // its timeout, so a late result's hints still apply (readTap).
      if (this.readTap && HINTED_METHODS.has(method)) {
        this.hintedRequests.set(id, { method, params: hintedParams(method, params) });
        if (this.hintedRequests.size > 1000) this.hintedRequests.delete(this.hintedRequests.keys().next().value!);
      }
      try {
        this.transport!.writeLine(line);
      } catch (err) {
        // A synchronous write rejection sent no request. Remove its pending
        // state and watchdog before reporting that it is safe to retry. The
        // method, id and the transport's words are the operator's, logged
        // after the refusal, as refused() logs.
        this.pendingRequests.delete(id);
        this.hintedRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new McplRequestError(
          `The request wasn't sent: this host couldn't write it to the "${this.id}" server, so nothing ran. Try again later.`,
          'not-sent',
        ));
        console.error(
          `MCPL server "${this.id}": writing ${method} (id=${id}) failed: ${logDetail(err instanceof Error ? err.message : err)}`,
        );
      }
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
    // §17.3: deliberately UNGATED (not in EVENT_TO_REQUIRED_CAPABILITY) —
    // announcing conveys no authority, and gating it would silence exactly
    // the servers whose grants just narrowed. The cost is the host's
    // re-fetch, which the framework rate-limits (§17.8).
    [McplMethod.ManifestChanged]: 'manifest-changed',
    [McplMethod.ChannelsList]: 'channels-list',
    'notifications/tools/list_changed': 'tools-list-changed',
    [McplMethod.ToolsObserve]: 'tools-observe',
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
    [McplMethod.ToolsObserve]: 'toolLifecycle.observe',
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
    // Through the same containment boundary as every inbound event, so a
    // stderr listener that throws is reported, not thrown into the transport.
    transport.on('stderr', (line: string) => this.dispatchInboundEvent('stderr', { line }));
  }

  /**
   * Wire up the transport's line stream to route incoming JSON-RPC messages.
   */
  private setupMessageRouting(transport: McplTransport): void {
    // The boundary this transport serves within: a line read once it has
    // passed is the dead process's (afterBoundary).
    const epoch = this.transportEpoch;
    transport.on('line', (line: string) => {
      const msg = messageFromLine(this.id, line, transport) as JsonRpcRequest | JsonRpcResponse | undefined;
      if (!msg) return;
      try {
        this.dispatchMessage(msg, epoch);
      } catch (error) {
        const request = msg as { method?: unknown; id?: unknown };
        this.reportInboundFailure(error, {
          ...(typeof request.method === 'string' ? { event: request.method } : {}),
          ...(typeof request.id === 'string' || typeof request.id === 'number' ? { requestId: request.id } : {}),
        });
      }
    });
  }

  /** Contain synchronous dispatch failures; async RPC handlers own their promises. */
  private dispatchMessage(msg: JsonRpcRequest | JsonRpcResponse, epoch: number): void {
    // Is this a response to one of our outbound requests?
    if ('id' in msg && msg.id != null && !('method' in msg)) {
      const late = epoch !== this.transportEpoch;
      // RFC-014: its hints apply as it's read, whether or not anyone still
      // waits for it. A dead transport's revs are its own, so a response
      // read after its boundary is never tapped.
      if (!late) this.tapResponse(msg as JsonRpcResponse);
      this.handleResponse(msg as JsonRpcResponse, late);
      return;
    }

    // It is an inbound request or notification from the server
    const request = msg as JsonRpcRequest;

    // Read after its transport's boundary, it is the dead process's: the
    // boundary's rule applies (afterBoundary).
    if (epoch !== this.transportEpoch) {
      this.afterBoundary(request, epoch);
      return;
    }

    // MCP's ping, which either side may send: its receiver answers promptly
    // with an empty result. It's answered as it arrives, before admission and
    // buffering, since it asks only whether the connection is alive, and a
    // paused plane mustn't hold that answer. A ping sent as a notification
    // has nothing to answer. The handshake answers one too.
    if (request.method === 'ping') {
      if (request.id != null) this.sendResponse(request.id, {});
      return;
    }

    // RFC-014 §6.1: a push's hints apply as it's read, before the plane gate
    // holds it or the grant refuses it. A standalone tools/hints is consumed
    // here when a tap listens (it needs no grant), and answered if it came as
    // a request; with no tap it stays a method this host doesn't handle.
    if (request.method === 'push/event') this.tap({ kind: 'push', params: request.params });
    else if (request.method === 'tools/hints' && this.readTap) {
      this.tap({ kind: 'hints', params: request.params });
      if (request.id != null) this.sendResponse(request.id, {});
      return;
    }

    const eventName = typeof request.method === 'string' && Object.hasOwn(McplServerConnection.METHOD_TO_EVENT, request.method)
      ? McplServerConnection.METHOD_TO_EVENT[request.method] : undefined;

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

    if (!eventName) {
      // §6.6: a request that will never be answered MUST get an error, so a
      // request (it has an id) whose method isn't a string, or isn't one this
      // host handles, is answered -32601. A notification nobody handles is
      // ignored, as JSON-RPC asks.
      if (request.id != null) {
        this.sendErrorResponse(request.id, -32601, 'Method not found');
        console.error(`[mcpl] ${this.id}: answered -32601 to a request for ${describeMethod(request.method)}, which this host doesn't handle`);
      }
      return;
    }

    // Emit the typed event with params and (for requests) a respond callback
    if (request.id != null) {
      // Server expects a response — provide a respond helper
      this.dispatchInboundEvent(eventName, request.params, this.responderFor(request.id, epoch));
    } else {
      // Notification — no response expected
      this.dispatchInboundEvent(eventName, request.params);
    }
  }

  /**
   * A request's responder, bound to the transport it came on (`epoch`): an
   * answer, or a streamed inference's chunk, sent after that transport has
   * closed reaches nothing, never a server that didn't ask it.
   */
  private responderFor(id: string | number, epoch: number) {
    return {
      id,
      signal: epoch === this.transportEpoch ? this.transportEnded.signal : AbortSignal.abort(),
      respond: (result: unknown) => this.sendResponse(id, result, epoch),
      respondError: (code: number, message: string, data?: unknown) =>
        this.sendErrorResponse(id, code, message, data, epoch),
      sendChunk: (params: InferenceChunkParams) => this.sendInferenceChunk(params, epoch),
    };
  }

  /**
   * A request or notification read from a transport after its boundary has
   * passed: the boundary's rule (resetPolicyForTransportBoundary). An
   * incoming message or push is held as kept, for the next transport's
   * grant, and any other is dropped and logged. (A response read then goes to
   * handleResponse, flagged late.) A stdio
   * server's transport closes on the child's 'exit', when its stdout may
   * still be open, as it is while a process the server started holds it, and
   * it is read until the next reconnect attempt closes its reader. No
   * transport serves meanwhile, so what is held waits for the next grant
   * (flushHeld). A connection closed for good, which won't reconnect, reads
   * it while its writer lives, with no grant to come, so it drops and logs
   * all of it; hold's bounds cap what any other keeps.
   */
  private afterBoundary(request: JsonRpcRequest, epoch: number): void {
    const event = typeof request.method === 'string' && Object.hasOwn(McplServerConnection.METHOD_TO_EVENT, request.method)
      ? McplServerConnection.METHOD_TO_EVENT[request.method] : undefined;
    if (this.closedForGood || event === undefined || !McplServerConnection.WORLD_EVENTS.has(event)) {
      console.error(
        `[mcpl] ${this.id}: dropped a message read after its transport closed` +
        `${this.closedForGood ? ', with no transport to come' : ''}: ${describeMethod(request.method)}`,
      );
      return;
    }
    this.hold(event, request.id != null ? [request.params, this.responderFor(request.id, epoch)] : [request.params], true);
  }

  /** Live delivery and delayed plane flushes share the same containment boundary. */
  private dispatchInboundEvent(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (error) {
      const requestId = (args[1] as { id?: unknown } | undefined)?.id;
      this.reportInboundFailure(error, {
        event,
        ...(typeof requestId === 'string' || typeof requestId === 'number' ? { requestId } : {}),
      });
    }
  }

  /** Report a failure the containment boundary caught, naming the event (or
   *  method) and request it was dispatching, and what failed. The message is
   *  what the framework's 'error' listener traces. */
  private reportInboundFailure(cause: unknown, context: { event?: string; requestId?: string | number } = {}): void {
    const where = (show: (text: string) => string): string => (context.event === undefined ? '' : ` for ${show(context.event)}`) +
      (context.requestId === undefined ? '' : ` (request ${show(String(context.requestId))})`);
    // The error's message is what the 'error' listener traces, as text a
    // reader parses, so it is bounded rather than escaped (boundedForLog);
    // the log line prints the same through log-value.
    const error = new Error(`MCPL server "${this.id}" inbound dispatch failed${where(boundedForLog)}: ${boundedForLog(describeCause(cause))}`, { cause });
    console.error(`[mcpl] ${this.id}: inbound dispatch failed${where(logValue)}: ${logDetail(describeCause(cause))}`);
    this.emitToErrorListeners(error);
  }

  /**
   * Give an error to the connection's 'error' listeners, and say whether it
   * has any. EventEmitter throws an 'error' that nothing listens for, and
   * from a transport's callback, where these errors arise, nothing catches
   * that throw, so it ends the process. A bare connection has no listener:
   * the class is exported, and a probe, a playtest or a harness often attaches
   * none. So with no listener, the error is the caller's to log, unless it
   * already has. A listener that throws is caught and logged, with the error
   * it was handling.
   */
  private emitToErrorListeners(error: Error): boolean {
    if (this.listenerCount('error') === 0) return false;
    try { this.emit('error', error); }
    catch (listenerError) {
      console.error(
        `[mcpl] ${this.id}: an 'error' listener failed: ${logDetail(describeCause(listenerError))}` +
          `, handling ${logDetail(error.message)}`,
      );
    }
    return true;
  }

  /** Tap a response to a hinted request (RFC-014): its result's hints, or a
   *  list's statement, apply now, awaited or not. */
  private tapResponse(response: JsonRpcResponse): void {
    if (!this.readTap) return;
    const sent = this.hintedRequests.get(response.id);
    if (!sent) return;
    this.hintedRequests.delete(response.id);
    const result = response.result;
    if (response.error || result === null || typeof result !== 'object' || Array.isArray(result)) return;
    this.tap({ kind: 'result', method: sent.method, params: sent.params, result, awaited: this.pendingRequests.has(response.id) });
  }

  /**
   * Handle a JSON-RPC response by resolving/rejecting the corresponding pending request.
   */
  private handleResponse(response: JsonRpcResponse, late = false): void {
    // One read after its transport's boundary answers a request the close
    // ended. It's matched against none of this connection's request records,
    // since the next transport numbers its requests afresh, and goes the way
    // of any late answer: a stateful one is surfaced as an orphaned response.
    const pending = late ? undefined : this.pendingRequests.get(response.id);
    if (!pending) {
      // Orphaned response — the request already timed out (or was settled) and
      // was removed from pendingRequests. A late STATEFUL result must be
      // surfaced because dropping it silently diverges the checkpoint tree.
      // Selected side-effecting calls are also surfaced even without state so
      // their outcome-unknown receipt remains visible. We cannot safely
      // re-inject either result because the original dispatch context is gone.
      const orphaned = late ? undefined : this.orphanedRequests.get(response.id);
      if (!late) this.orphanedRequests.delete(response.id);
      // A push/render answered after its timeout (RFC-006 §5.3) is reported
      // with the render's featureSet, key, eventId and, for a channel-scoped
      // subject, channelId, kept from its request when the timeout fired, so
      // its discarded answer can be recorded beside its batch's other
      // coalescing records (§11). It is only reported: the fallback the
      // timeout materialized stands (§5.4 rule 3). A late JSON-RPC error is
      // passed on as `error`, so its record can be told from a late result's,
      // and so is one beside a result, which JSON-RPC forbids: the live path
      // rejects such an answer as an error.
      const render = orphaned?.renderParams ?? {};
      const failure = response.error ? { error: { code: response.error.code, message: response.error.message } } : {};
      const result = response.result;
      if (result && typeof result === 'object') {
        const r = result as { state?: unknown; checkpoint?: unknown };
        if (orphaned || r.state !== undefined || r.checkpoint !== undefined) {
          this.emit('orphaned-response', {
            id: response.id,
            method: orphaned?.method,
            hadState: r.state !== undefined,
            hadCheckpoint: r.checkpoint !== undefined,
            ...render,
            ...failure,
          });
        }
      } else if (orphaned) {
        this.emit('orphaned-response', {
          id: response.id,
          method: orphaned.method,
          hadState: false,
          hadCheckpoint: false,
          ...render,
          ...failure,
        });
      }
      return; // Orphaned response — ignore
    }

    this.pendingRequests.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (response.error) {
      // The server's own words, after a word on whose they are, redacted and
      // then bounded as errors.ts says, since they're the server's text in
      // an error the caller gets (redactServerText's scope), and its data's
      // strings redacted too. It's trimmed after it's redacted, so a
      // credential that ends in a space is whole when it's matched. Only a
      // string is words: a message of any other JSON value reads as none.
      // The method and id are the operator's, so they go to the log, and the
      // code (loggedCode) and the message, whatever JSON values they are, go
      // there redacted (logValueRedacted), as every other line this
      // connection writes is.
      const redact = (this.redactor ??= serverTextRedactor(this.config ?? {})).now();
      const said = typeof response.error.message === 'string' ? boundedForLog(redact(response.error.message).trim()) : '';
      // The call is settled before its log line: its entry is gone and its
      // timer cleared, so nothing else would settle it, and a host's logger
      // can throw. The dispatch's containment reports such a throw. (A
      // configuration that can't be read withholds the message rather than
      // throw: redactServerText.)
      pending.reject(new McplRequestError(
        said
          ? `The "${this.id}" server answered with an error: ${said}`
          : `The "${this.id}" server answered with an error without saying what went wrong, so whether the request took effect is unknown. ` +
            'Check its effect before trying again.',
        'error-response',
        redactedData((response.error as { data?: unknown }).data, redact),
      ));
      console.error(
        `MCPL server "${this.id}" answered ${pending.method} (id=${response.id}) with error ${loggedCode(response.error.code, redact)}: ` +
        logValueRedacted(response.error.message, redact),
      );
    } else {
      try {
        pending.onRead?.(response.result);
      } catch (error) {
        console.error(`MCPL server "${this.id}": reading ${pending.method}'s result failed: ${logDetail(describeCause(error))}`);
      }
      pending.resolve(response.result);
    }
  }

  /**
   * Send a successful JSON-RPC response back to the server.
   */
  private sendResponse(id: string | number, result: unknown, epoch = this.transportEpoch): void {
    // A closed connection's epoch is past every request's, so a refusal
    // while it is closed is logged too.
    if (!this.sameTransport(id, epoch) || this.closed) return;
    const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.transport?.writeLine(JSON.stringify(response));
  }

  /** Whether a response to a request received on `epoch` may go out now.
   *  The id is the server's, so it's logged as a field; `answer`, which the
   *  caller has formatted for the log, ends the line. */
  private sameTransport(id: string | number, epoch: number, answer?: string): boolean {
    if (epoch === this.transportEpoch) return true;
    console.error(
      `[mcpl] ${this.id}: not answering request ${logValue(id)}: the transport it came on has closed${answer ? `, with ${answer}` : ''}`,
    );
    return false;
  }

  /**
   * Send a JSON-RPC error response back to the server.
   */
  private sendErrorResponse(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
    epoch = this.transportEpoch,
  ): void {
    // A refusal that can't be answered still says what it refused: a held
    // message admitted under the next transport's grant is refused here.
    if (!this.sameTransport(id, epoch, `error ${code} ${logDetail(message)}`) || this.closed) return;
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
    this.hostCloseRequested = false;
    transport.on('error', (err: Error) => {
      const error = new Error(`MCPL server "${this.id}" transport error: ${err.message}`);
      if (!this.emitToErrorListeners(error)) console.error(`[mcpl] ${this.id}: transport error: ${logDetail(err.message)}`);
    });

    const lost = (info: TransportCloseInfo) => {
      if (!this.closed) {
        this.closed = true;
        this.resetPolicyForTransportBoundary();
        // A teardown the host asked for via reconnectAfterFailure() arrives
        // here too; it's reported as such below.
        const byHost = this.hostCloseRequested;
        this.hostCloseRequested = false;

        // Reject all pending requests. The words hold whether the server
        // dropped or this host closed the transport to recover; how it closed
        // is the operator's, so it goes to the log, not into the messages.
        if (this.pendingRequests.size > 0) {
          // Whatever the host asked for, the close's own details are kept, so
          // a drop that races a recycle loses nothing.
          const how = `${byHost ? 'closed by this host, ' : ''}` +
            `code=${info.code ?? 'n/a'}, signal=${info.signal ?? 'n/a'}, reason=${closeReasonText(info)}`;
          console.error(`MCPL server "${this.id}" disconnected (${how}) with ${this.unansweredRequests()}`);
        }
        for (const pending of this.pendingRequests.values()) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(
            new McplRequestError(
              `The connection to the "${this.id}" server closed before it answered, so whether the request took effect is unknown. ` +
              (this.reconnectEnabled
                ? 'Check its effect before trying again; this host is reconnecting to it.'
                : "This host won't reconnect to it on its own. If you need it, ask whoever runs this host."),
              'no-response',
            ),
          );
        }
        this.pendingRequests.clear();
        this.orphanedRequests.clear();

        // Forward the transport's close info so listeners can tell a server
        // that refused the credential (WebSocket 4001) from a crash, and act
        // before the reconnect below redials.
        const closeInfo: McplConnectionCloseInfo = {
          transport: transport.kind,
          code: info.code ?? null,
          signal: info.signal ?? null,
          reason: info.reason ?? (byHost ? 'closed by host' : undefined),
          ...(info.reasonFromPeer ? { reasonFromPeer: true } : {}),
          ...(info.pipeFailed ? { pipeFailed: true } : {}),
          byHost,
        };
        this.emit('close', closeInfo.code, closeInfo.signal, closeInfo);

        // Schedule reconnect if enabled (unexpected disconnect triggers auto-reconnect)
        if (this.reconnectEnabled) {
          this.scheduleReconnect();
        }
      }
    };
    transport.on('close', lost);
    transport.on('unreaped', (failure: Error) => {
      if (this.closed || this.transport !== transport) return;
      this.holdUnreaped(transport, failure);
      lost({ reason: `this host stopped using the server's stdio (${transport.stdioStopCause?.message ?? 'an error'}), and the server's process outlived SIGKILL` });
      this.emit('reconnect-failed', { error: this.unreapedFailure(), attempt: Math.max(1, this.reconnectAttempts), permanent: true });
    });
  }
}

function messageFromLine(serverId: string, line: string, transport: McplTransport): object | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    logDroppedLine(serverId, line, 'unparsed', transport);
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    logDroppedLine(serverId, line, 'not-object', transport);
    return undefined;
  }
  return value;
}
