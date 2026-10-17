/**
 * McplTransport — the byte-level seam under McplServerConnection.
 *
 * An MCPL connection is newline-delimited JSON-RPC over a duplex stream. The
 * only things the connection needs from its underlying transport are: write a
 * line, receive lines, surface diagnostics/errors, and know when it closed. By
 * abstracting exactly that, the handshake, message routing, and every send path
 * stay transport-agnostic and run IDENTICALLY over a spawned stdio child or a
 * WebSocket — which is the whole point of network MCPL.
 *
 * Two implementations:
 *  - StdioTransport      — spawns `config.command` and speaks over stdin/stdout;
 *                          child stderr is surfaced as 'stderr' lines.
 *  - WebSocketTransport  — dials `config.url` (ws:// or wss://) with the `ws`
 *                          library, appending `?token=` when `config.token` is
 *                          set; each WS text frame is one JSON-RPC line.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';

import type { McplServerConfig } from './types.js';

/** Why/how a transport closed. `code`/`signal` are populated for stdio child
 *  exits; `reason` carries a WebSocket close reason or an error message. */
export interface TransportCloseInfo {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
  /** True when `reason` is the peer's own text, a WebSocket server's close
   *  reason, rather than the transport's words. */
  reasonFromPeer?: boolean;
}

/**
 * A line-oriented duplex transport to an MCPL server.
 *
 * Events:
 *  - `'line'`   `(line: string)`            one inbound NDJSON line (no newline)
 *  - `'stderr'` `(line: string)`            diagnostic line (stdio child stderr; never WS)
 *  - `'error'`  `(err: Error)`              transport-level error
 *  - `'close'`  `(info: TransportCloseInfo)` transport closed (once)
 *
 * Inbound `'line'`/`'stderr'` events are buffered until the first matching
 * listener attaches (and re-buffered whenever there are none), so no message is
 * lost across the handshake→routing handoff regardless of attach timing.
 */
export abstract class McplTransport extends EventEmitter {
  abstract readonly kind: 'stdio' | 'websocket';

  private _closed = false;
  private lineBuffer: string[] = [];
  private stderrBuffer: string[] = [];

  protected constructor() {
    super();
    // Flush buffered inbound lines the moment a consumer subscribes.
    this.on('newListener', (event) => {
      if (event === 'line' && this.lineBuffer.length > 0) {
        const pending = this.lineBuffer;
        this.lineBuffer = [];
        queueMicrotask(() => { for (const l of pending) this.emit('line', l); });
      } else if (event === 'stderr' && this.stderrBuffer.length > 0) {
        const pending = this.stderrBuffer;
        this.stderrBuffer = [];
        queueMicrotask(() => { for (const l of pending) this.emit('stderr', l); });
      }
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  /**
   * The last of what the server wrote to its diagnostic stream: at most its
   * last {@link STDERR_TAIL_CHARS} UTF-16 code units, never opening inside a
   * surrogate pair, after a '…' when earlier ones were dropped. A stdio
   * child's stderr, and '' for a transport that has none.
   */
  get stderrTail(): string {
    return '';
  }

  /** Deliver an inbound line, buffering it if nobody is listening yet. */
  protected pushLine(line: string): void {
    if (this.listenerCount('line') > 0) this.emit('line', line);
    else this.lineBuffer.push(line);
  }

  /** Deliver a diagnostic line, buffering it if nobody is listening yet. */
  protected pushStderr(line: string): void {
    if (this.listenerCount('stderr') > 0) this.emit('stderr', line);
    else this.stderrBuffer.push(line);
  }

  /** Emit 'close' exactly once. */
  protected markClosed(info: TransportCloseInfo): void {
    if (this._closed) return;
    this._closed = true;
    this.emit('close', info);
  }

  /** Write one JSON-RPC message as an NDJSON line. */
  abstract writeLine(json: string): void;

  /** Close the transport and release resources. Resolves once fully closed. */
  abstract close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

/**
 * Host variables a stdio child gets by default: just enough for an ordinary
 * process to run (find binaries, a home dir, temp dir, locale, TLS roots,
 * network proxies, a display for GUI helpers). Everything else in the host env — notably API
 * keys and bot tokens — is NOT passed on; a server that needs a variable must
 * declare it in its `env` (recipes can `${VAR}`-substitute from .env), or set
 * `inheritEnv: true` to get the whole host env as before. Proxy URLs may include
 * credentials. This limits accidental inheritance, not access by a hostile
 * same-user child process; it is not a process isolation boundary.
 */
export const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  '__CF_USER_TEXT_ENCODING',
  // Windows equivalents, harmless elsewhere.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
];

/** Environment for a stdio child: allowlisted host vars (+ LC_*), then the
 *  server's declared `env` on top. Windows names merge case-insensitively;
 *  POSIX names remain case-sensitive. `inheritEnv: true` restores full inheritance,
 *  and only `true` does: a direct caller can pass any value, unchecked. */
export function buildChildEnv(
  config: Pick<McplServerConfig, 'env' | 'inheritEnv'>,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const win = platform === 'win32';
  const inherit = config.inheritEnv === true;
  const env: NodeJS.ProcessEnv = inherit ? { ...hostEnv } : {};
  if (!inherit) {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value === undefined) continue;
      // Windows commonly enumerates Path/SystemRoot rather than PATH/SYSTEMROOT.
      const probe = win ? key.toUpperCase() : key;
      if (CHILD_ENV_ALLOWLIST.includes(probe) || probe.startsWith('LC_')) env[key] = value;
    }
  }
  if (!win) return { ...env, ...config.env };

  // Windows spawn folds environment names case-insensitively and may choose
  // an earlier host spelling over a differently cased declared override.
  // Select Node's first lexicographic spelling within each source, then layer
  // declared values (including '') over host values. Source precedence and
  // duplicate-name resolution are separate decisions.
  const merged: NodeJS.ProcessEnv = {};
  const spellings = new Map<string, string>();
  for (const source of [env, config.env ?? {}]) {
    const seen = new Set<string>();
    for (const key of Object.keys(source).sort()) {
      const canonical = key.toUpperCase();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const previous = spellings.get(canonical);
      if (previous !== undefined && previous !== key) delete merged[previous];
      merged[key] = source[key];
      spellings.set(canonical, key);
    }
  }
  return merged;
}

/** The most of a stdio child's stderr a transport keeps for {@link McplTransport.stderrTail}. */
export const STDERR_TAIL_CHARS = 2_048;

export class StdioTransport extends McplTransport {
  readonly kind = 'stdio' as const;
  /** The first error on the child's stdin or stdout, named in the close reason. */
  private pipeError: Error | undefined;
  private stderrEnd = '';
  private stderrCut = false;

  override get stderrTail(): string {
    return (this.stderrCut ? '…' : '') + this.stderrEnd;
  }

  private constructor(
    private readonly child: ChildProcess,
    private readonly rl: ReadlineInterface,
  ) {
    super();

    this.rl.on('line', (line: string) => this.pushLine(line));

    // Stitch stderr chunks into whole lines (a chunk can split a line, and a
    // character's bytes), and keep the stream's last characters for
    // stderrTail.
    let carry = '';
    const decoder = new StringDecoder('utf8');
    const received = (text: string) => {
      const end = this.stderrEnd + text;
      this.stderrCut ||= end.length > STDERR_TAIL_CHARS;
      let kept = end.slice(-STDERR_TAIL_CHARS);
      // A cut between a surrogate pair's halves drops the low half too.
      if (/^[\uDC00-\uDFFF]/.test(kept) && end.length > STDERR_TAIL_CHARS) kept = kept.slice(1);
      this.stderrEnd = kept;
      const lines = (carry + text).split('\n');
      carry = lines.pop() ?? '';
      for (const l of lines) if (l.length > 0) this.pushStderr(l);
    };
    this.child.stderr?.on('data', (chunk: Buffer) => received(decoder.write(chunk)));
    // A last line with no newline is complete once the stream ends.
    this.child.stderr?.on('end', () => {
      received(decoder.end());
      if (carry.length > 0) this.pushStderr(carry);
    });

    this.child.on('error', (err) => this.emit('error', err));
    // The child's stdin and stdout carry the protocol, so after an error on
    // either, a write's EPIPE or a read error, this transport can't reach the
    // child even if it's still running. The handler sends a running child
    // SIGTERM, and the exit's close names the error, so the connection handles
    // it as any other exit. The close is the report: no 'error' is emitted,
    // nothing is thrown. Nothing here escalates to SIGKILL, so a child that
    // ignores SIGTERM keeps running, unreported. A child that stops reading
    // without closing its stdin raises no error: the writes are buffered, and
    // only request timeouts bound it (McplServerConfig.requestTimeoutMs).
    const endOnPipeError = (err: Error) => {
      this.pipeError ??= err;
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    };
    this.child.stdin?.on('error', endOnPipeError);
    // On the stream itself, since close() closes readline, which takes its own
    // listener off the stream. While readline is open, its listener, which
    // came first, re-emits the error on the interface, where an empty
    // listener absorbs that copy.
    this.child.stdout?.on('error', endOnPipeError);
    this.rl.on('error', () => { /* readline's copy of a stdout error, handled above */ });
    // stderr carries diagnostics only: a read error on it is reported if
    // anyone listens and never thrown. It ends nothing once the connection
    // is wired; during a handshake the listener is the handshake's, which
    // fails it.
    this.child.stderr?.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    this.child.on('exit', (code, signal) => this.markClosed({
      code,
      signal,
      reason: this.pipeError ? `child process exited, and its pipe failed with ${this.pipeError.message}` : 'child process exited',
    }));
  }

  /**
   * Spawn `config.command` and resolve with a ready stdio transport once the
   * child has spawned. Rejects if the command is missing (a config bug) or the
   * process fails to spawn.
   */
  static async spawn(config: McplServerConfig): Promise<StdioTransport> {
    if (!config.command) {
      throw new Error(
        `MCPL server "${config.id}": stdio transport requires "command" (none provided)`,
      );
    }
    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(config),
    });
    // Node reports a failed spawn (a command that doesn't exist, say) as an
    // 'error' on a tick after spawn() returns, and no 'exit' follows. It is
    // settled here, where it is listened for. A caller that listens only once
    // this resolves, as the handshake does, would be too late when reached
    // from a timer callback, as a reconnect is: Node runs that tick before the
    // caller's promise continuation, and throws an 'error' nothing listens for.
    await new Promise<void>((resolve, reject) => {
      const failed = (err: Error) => {
        reject(new Error(`MCPL server "${config.id}" could not be started: ${err.message}`, { cause: err }));
      };
      child.once('error', failed);
      child.once('spawn', () => {
        child.off('error', failed);
        resolve();
      });
    });
    const rl = createInterface({ input: child.stdout! });
    return new StdioTransport(child, rl);
  }

  writeLine(json: string): void {
    // stdin may be gone if the child died between the closed-check and here.
    this.child.stdin?.write(json + '\n');
  }

  async close(): Promise<void> {
    this.markClosed({ reason: 'closed by host' });
    this.rl.close();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    await new Promise<void>((resolve) => {
      // Once Node has seen a child exit, it has its exitCode set, or its
      // signalCode when a signal ended it, and its 'exit' event has fired. A
      // signal that didn't come through kill() (an OOM kill, a crash) leaves
      // `killed` false. A child that has exited but isn't reaped yet still
      // takes the kill() above, which sets `killed`.
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null || this.child.killed) {
        resolve();
      } else {
        this.child.once('exit', () => resolve());
      }
    });
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** Timeout for the WebSocket to reach OPEN before we give up (ms). */
const WS_OPEN_TIMEOUT_MS = 15_000;

export class WebSocketTransport extends McplTransport {
  readonly kind = 'websocket' as const;

  private constructor(private readonly ws: WebSocket) {
    super();

    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // MCPL frames are UTF-8 JSON text. A frame MAY contain multiple
      // newline-delimited messages or a trailing newline; split defensively.
      const text = isBinary ? (data as Buffer).toString('utf8') : String(data);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.pushLine(trimmed);
      }
    });

    this.ws.on('error', (err: Error) => this.emit('error', err));
    this.ws.on('close', (code: number, reason: Buffer) => {
      const text = reason?.toString('utf8');
      this.markClosed(text ? { code, reason: text, reasonFromPeer: true } : { code, reason: 'websocket closed' });
    });
  }

  /**
   * Dial `config.url` and resolve once the socket is OPEN. Appends `?token=`
   * when `config.token` is set. Rejects on connect error / timeout (and tears
   * the socket down) so a failed dial never leaks an open handle.
   */
  static async open(config: McplServerConfig): Promise<WebSocketTransport> {
    // Resolve the per-dial credential first: the provider runs on every
    // connect AND reconnect, so rotation happens at the transport layer and
    // nothing above it ever holds a credential.
    let token: string | null = config.token ?? null;
    if (config.accessProvider) {
      try {
        token = (await config.accessProvider()) ?? token;
      } catch (err) {
        // Fall back to the static token (if any) rather than failing the dial
        // outright — the server will refuse a stale credential loudly anyway.
        console.error(
          `[mcpl] server "${config.id}": access provider failed (${err instanceof Error ? err.message : err}) — dialing with configured fallback`,
        );
      }
    }
    const url = buildWebSocketUrl(config, token);
    // Error strings travel: traces, logs, tool results the model reads. They
    // get the endpoint, never the credential.
    const redacted = buildWebSocketUrl({ ...config, token: undefined }, null);
    const ws = new WebSocket(url);

    // A failed dial can emit 'error' MORE THAN ONCE on the raw socket (seen
    // live 2026-08-03: an HTTP 502 upgrade-reject emits the "Expected 101"
    // error and then a teardown error). WebSocket is an EventEmitter, so any
    // 'error' with no listener throws at the top level and KILLS THE WHOLE
    // AGENT PROCESS — a crashloop, since the dial happens at boot. Every
    // settle path below must therefore leave a swallow listener behind; a
    // remote server being down must never be able to take the host down.
    const swallowLateErrors = () => { /* settled; retry loop owns recovery */ };

    return new Promise<WebSocketTransport>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners();
        ws.on('error', swallowLateErrors);
        try { ws.terminate(); } catch { /* already gone */ }
        reject(new Error(`MCPL server "${config.id}" WebSocket connect timed out after ${WS_OPEN_TIMEOUT_MS}ms (${redacted})`));
      }, WS_OPEN_TIMEOUT_MS);

      ws.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners('error'); // the instance re-attaches its own handlers
        resolve(new WebSocketTransport(ws));
      });

      ws.once('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on('error', swallowLateErrors);
        try { ws.terminate(); } catch { /* already gone */ }
        reject(new Error(`MCPL server "${config.id}" WebSocket connect failed: ${err.message} (${redacted})`));
      });
    });
  }

  writeLine(json: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  async close(): Promise<void> {
    this.markClosed({ reason: 'closed by host' });
    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
      try {
        this.ws.close();
      } catch {
        try { this.ws.terminate(); } catch { /* already gone */ }
        resolve();
      }
    });
  }
}

/**
 * Build the dial URL: validate it's a ws(s):// URL and append the auth token as
 * a `token` query param when provided (preserving any existing query).
 */
export function buildWebSocketUrl(config: McplServerConfig, tokenOverride?: string | null): string {
  if (!config.url) {
    throw new Error(`MCPL server "${config.id}": websocket transport requires "url" (none provided)`);
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new Error(`MCPL server "${config.id}": invalid WebSocket url "${config.url}"`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(
      `MCPL server "${config.id}": websocket url must be ws:// or wss://, got "${parsed.protocol}"`,
    );
  }
  const token = tokenOverride !== undefined ? tokenOverride : config.token;
  if (token) {
    parsed.searchParams.set('token', token);
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** True when the config selects the WebSocket transport (explicit `transport`,
 *  or a `url` with no `command`). */
export function isWebSocketTransport(config: McplServerConfig): boolean {
  if (config.transport === 'websocket') return true;
  if (config.transport === 'stdio') return false;
  return Boolean(config.url) && !config.command;
}

/** The settings of McplServerConfig whose type is boolean. */
type BooleanSetting = {
  [K in keyof McplServerConfig]-?: NonNullable<McplServerConfig[K]> extends boolean ? K : never;
}[keyof McplServerConfig];

/** What `true` does for each boolean setting, as its refusal says it. A
 *  boolean setting added to McplServerConfig doesn't compile until it has
 *  an entry here, so the check below covers it too. */
const SERVER_CONFIG_BOOLEANS: Record<BooleanSetting, string> = {
  inheritEnv: 'true passes the server the host\'s whole environment, and false or leaving it out passes only the allowlisted and LC_* host variables',
  reconnect: 'true retries in the background when the server can\'t be reached or its connection drops, and false or leaving it out doesn\'t',
  allowHostCommands: 'true lets the server run the host\'s admin commands, such as undo, hide, unstick and quiesce, and false or leaving it out refuses them',
};

/**
 * Refuse a server config whose `inheritEnv`, `reconnect` or `allowHostCommands`
 * holds anything but true or false. A config read from JSON can carry a quoted
 * "false" where the type says boolean, and every reader of these settings takes
 * only `true` as on, so the quotes would hide what the value does. null counts
 * as not set, so a generated config that writes an unset setting as null
 * keeps working. `inheritEnv` is checked only for a stdio server, since a
 * WebSocket server never reads it. The error names the server, the setting
 * and the value's kind, not the value, which could be a secret pasted into
 * the wrong field.
 */
export function assertServerConfigBooleans(config: McplServerConfig): void {
  for (const [setting, whatTrueDoes] of Object.entries(SERVER_CONFIG_BOOLEANS) as Array<[BooleanSetting, string]>) {
    if (setting === 'inheritEnv' && isWebSocketTransport(config)) continue;
    const value: unknown = config[setting];
    if (value === undefined || value === null || typeof value === 'boolean') continue;
    const wanted = typeof value === 'string' ? 'true or false, unquoted,' : 'true or false,';
    throw new Error(`MCPL server "${config.id}" ${setting} must be ${wanted} not ${kindOf(value)}: ${whatTrueDoes}`);
  }
}

/** The kind of a value that isn't undefined, null or a boolean, as a refusal
 *  names it in place of the value. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  if (prototype === null || prototype === Object.prototype) return 'an object';
  const name = prototype.constructor?.name;
  if (!name) return 'an object that isn\'t plain';
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/**
 * Open the transport selected by `config` (WebSocket when `transport` is
 * 'websocket' or a bare `url` is given; stdio otherwise). The returned transport
 * is connected at the byte level but has NOT performed the MCPL handshake.
 */
export async function openTransport(config: McplServerConfig): Promise<McplTransport> {
  if (isWebSocketTransport(config)) {
    return WebSocketTransport.open(config);
  }
  return StdioTransport.spawn(config);
}
