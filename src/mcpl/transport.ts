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
import { WITHHELD_TEXT, describeCredentialError, maskedError, noteDialSent, redactServerText, redactUrl, resolveServerBinding, serverTextRedactor, urlAsDialed, type Redaction } from './protocol-family.js';
import { assertBooleanSetting } from '../config-checks.js';
import { logDetail } from './log-value.js';

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
 *  - `'unreaped'` `(failure: Error)`        a stdio child whose pipe failed
 *    outlived SIGKILL too: the transport stays open, owning the child, and
 *    close() retries the reap (never WS)
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

  /** The server's id from its config, so a line the transport logs names it.
   *  The stdio and WebSocket transports always give it; a test's stand-in
   *  transport may leave it out. */
  protected constructor(protected readonly serverId?: string) {
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

  /**
   * {@link stderrTail} as an error a host gets carries it: the same
   * characters, redacted with `redact`. The stream's last
   * {@link STDERR_WINDOW_CHARS} are redacted together and the tail is taken
   * from where it begins in them, so a credential that begins before the
   * tail and reaches into it is matched whole and replaced whole
   * ({@link Redaction}'s `from`). That holds for a credential of up to
   * 14,336 characters, the window less the tail: a longer one that began
   * before the window can't be matched, and the tail keeps what it holds of
   * it. '' for a transport that has no diagnostic stream.
   */
  stderrTailRedacted(_redact: Redaction): string {
    return '';
  }

  /**
   * The error a stdio child's stdin or stdout failed with, once one has. The
   * transport is ending the child then, and stays open until it exits, but
   * writes nothing more to it: writeLine drops each line, and both engines
   * refuse a request as not sent. Undefined while writes go out, and always
   * for a transport that has no pipes.
   */
  get pipeFailure(): Error | undefined {
    return undefined;
  }

  /**
   * Resolves once the server's diagnostic stream has ended or closed, so that
   * {@link stderrTail} holds what arrived on it, or once `ms` have passed while
   * it hasn't. At once for a transport that has none.
   */
  stderrEnded(_ms: number): Promise<void> {
    return Promise.resolve();
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

  /**
   * Report a transport error: to the 'error' listeners if there are any, else
   * as a log line. EventEmitter throws an 'error' that nothing listens for,
   * and a transport reports its errors from I/O callbacks, where nothing
   * catches that throw, so it would end the process. A transport has no
   * listener from its creation until the handshake attaches one, and a
   * WebSocket server that sends a malformed frame with its upgrade response
   * makes ws raise an 'error' in that window.
   */
  protected reportError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else {
      const server = this.serverId === undefined ? '' : `${this.serverId}: `;
      console.error(`[mcpl] ${server}a ${this.kind} transport error, with nothing listening for it: ${logDetail(err.message)}`);
    }
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
  // USERNAME is Windows' USER, which Python's getpass.getuser() reads there.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
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

/** The most of a stdio child's stderr that {@link McplTransport.stderrTail} gives. */
export const STDERR_TAIL_CHARS = 2_048;

/** The most of a stdio child's stderr a transport keeps, for
 *  {@link McplTransport.stderrTail} and
 *  {@link McplTransport.stderrTailRedacted}: eight tails, so a credential of
 *  up to 14,336 characters that reaches into the tail, a private key's PEM
 *  of 8,192 bits (about 6,500 characters) included, is whole in it. */
export const STDERR_WINDOW_CHARS = 8 * STDERR_TAIL_CHARS;

/** A redaction that replaces nothing: the raw tail. */
const unredacted: Redaction = (text, from = 0) => String(text).slice(from);

/**
 * How long a refusal at a stdio child's exit waits for the child's stderr to
 * end, so that its `stderrTail` holds what the child wrote. Node can emit a
 * child's `exit` before it has read the last of the child's stderr. When the
 * child held the stream alone, the stream ends with it, and the wait is short.
 * The bound binds when another process still holds the stream, such as one the
 * server started that inherited it, or when the host's loop stalls past it
 * before reading an end that is waiting. The tail then holds what had arrived.
 * A process that keeps the stream open, such as one the server started and
 * left running, holds the refusal up by the bound, a fifth of the reconnect's
 * default first interval.
 */
export const STDERR_END_WAIT_MS = 1_000;

export class StdioTransport extends McplTransport {
  readonly kind = 'stdio' as const;
  /** The first error on the child's stdin or stdout, named in the close reason. */
  private pipeError: Error | undefined;
  /** The stream's last STDERR_WINDOW_CHARS, raw. */
  private stderrWindow = '';
  /** True once the child's stderr has ended or closed. */
  private stderrDone = false;

  override get stderrTail(): string {
    return this.stderrTailRedacted(unredacted);
  }

  override stderrTailRedacted(redact: Redaction): string {
    // A child that wrote nothing has no tail, whatever its redaction.
    if (this.stderrWindow === '') return '';
    // The tail begins at its raw place in the window, so a redaction that
    // shortens the window can't move its edge back toward the window's own
    // cut. Something before the tail was dropped whenever the window is
    // longer than the tail, which it always is once the window was cut.
    const from = Math.max(0, this.stderrWindow.length - STDERR_TAIL_CHARS);
    const cut = from > 0;
    let kept = redact(this.stderrWindow, from);
    // A cut between a surrogate pair's halves drops the low half too.
    if (cut && /^[\uDC00-\uDFFF]/.test(kept)) kept = kept.slice(1);
    return (cut ? '…' : '') + kept;
  }

  override get pipeFailure(): Error | undefined {
    return this.pipeError;
  }

  override stderrEnded(ms: number): Promise<void> {
    const stderr = this.child.stderr;
    if (!stderr || this.stderrDone) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        stderr.off('end', done);
        stderr.off('close', done);
        resolve();
      };
      // Added after the constructor's listeners, so the tail already holds the
      // stream's last characters when these run.
      stderr.once('end', done);
      stderr.once('close', done);
      timer = setTimeout(done, ms);
    });
  }

  private constructor(
    private readonly child: ChildProcess,
    private readonly rl: ReadlineInterface,
    /** The server this child serves, named in its stderr lines and in what
     *  its reaping reports. */
    serverId: string,
  ) {
    super(serverId);

    this.rl.on('line', (line: string) => this.pushLine(line));

    // Stitch stderr chunks into whole lines (a chunk can split a line, and a
    // character's bytes), and keep the stream's last characters for
    // stderrTail.
    let carry = '';
    const decoder = new StringDecoder('utf8');
    const received = (text: string) => {
      const window = this.stderrWindow + text;
      this.stderrWindow = window.slice(-STDERR_WINDOW_CHARS);
      const lines = (carry + text).split('\n');
      carry = lines.pop() ?? '';
      for (const l of lines) if (l.length > 0) this.pushStderr(l);
    };
    this.child.stderr?.on('data', (chunk: Buffer) => received(decoder.write(chunk)));
    // A last line with no newline is complete once the stream ends.
    this.child.stderr?.on('end', () => {
      received(decoder.end());
      if (carry.length > 0) this.pushStderr(carry);
      this.stderrDone = true;
    });
    // A stream destroyed by an error closes without ending: nothing more comes.
    this.child.stderr?.on('close', () => { this.stderrDone = true; });

    this.child.on('error', (err) => this.reportError(err));
    // The child's stdin and stdout carry the protocol, so after an error on
    // either, a write's EPIPE or a read error, this transport can't reach the
    // child even if it's still running. The handler ends the child as close()
    // does, SIGTERM and then SIGKILL, in the one attempt close() shares, and
    // the exit's close names the error, so the connection handles it as any
    // other exit. The close is the report: no 'error' is emitted, nothing is
    // thrown, and nothing more is written meanwhile (pipeFailure). The first
    // error starts that one attempt, and a later one, from either pipe, adds
    // nothing to it. A child that outlives SIGKILL too stays this
    // transport's: 'unreaped' says so, unless the host is closing it, whose
    // close() reports the failure itself. A child that stops reading without
    // closing its stdin raises no error: the writes are buffered, and only
    // request timeouts bound it (McplServerConfig.requestTimeoutMs). Under
    // Bun a child that closes its stdin isn't reported either: Bun emits no
    // 'error' for the writes to it (checked on 1.3.10, 1.4.3 and 1.4.4's
    // canary), so request timeouts are its only bound too.
    const endOnPipeError = (err: Error) => {
      if (this.pipeError) return;
      this.pipeError = err;
      void this.terminate().catch((failure: unknown) => {
        if (!this.closed) this.emit('unreaped', failure instanceof Error ? failure : new Error(String(failure)));
      });
    };
    this.child.stdin?.on('error', endOnPipeError);
    // On the stream itself, since close() closes readline, which takes its own
    // listener off the stream. While readline is open, its listener, which
    // came first, re-emits the error on the interface, where an empty
    // listener absorbs that copy.
    this.child.stdout?.on('error', endOnPipeError);
    this.rl.on('error', () => { /* readline's copy of a stdout error, handled above */ });
    // stderr carries diagnostics only: a read error on it is reported, to the
    // listeners or else in the log, and never thrown. It ends nothing once
    // the connection is wired; during a handshake the listener is the
    // handshake's, which fails it.
    this.child.stderr?.on('error', (err) => this.reportError(err));
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
    // Node's error for a launch that failed reaches the host, and its words
    // and its other properties (`spawnargs`, `path`) can repeat a credential
    // the configuration holds. So it's handed on as its name and redacted
    // words (maskedError), with its code, which says what failed. What
    // spawn() refuses at once is one of the configuration's own arguments or
    // options, which Node quotes after " Received", cut to 128 characters: a
    // credential across that cut couldn't be matched, so the words stop
    // before the quote, still saying which value Node refused and why.
    const failed = (err: NodeJS.ErrnoException, refusedAtOnce: boolean): Error => {
      const redact = serverTextRedactor(config).now();
      const message = err instanceof Error ? err.message : String(err);
      const words = refusedAtOnce ? message.split(' Received')[0] : message;
      const shown = Object.assign(new Error(words), { name: err instanceof Error ? err.name : 'Error' });
      const cause = Object.assign(maskedError(shown, redact), err.code === undefined ? {} : { code: err.code });
      return new Error(`MCPL server "${config.id}" could not be started: ${redact(words)}`, { cause });
    };
    // The child's environment is read first, outside that: a configuration
    // whose `env` can't be read throws the framework's own error, such as
    // its awareness ledger's, which the framework acts on: its startup ends
    // on it, and a reconnect reports it.
    const env = buildChildEnv(config);
    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (error) {
      throw failed(error as NodeJS.ErrnoException, true);
    }
    // Node reports a failed spawn (a command that doesn't exist, say) as an
    // 'error' on a tick after spawn() returns, and no 'exit' follows. It is
    // settled here, where it is listened for. A caller that listens only once
    // this resolves, as the handshake does, would be too late when reached
    // from a timer callback, as a reconnect is: Node runs that tick before the
    // caller's promise continuation, and throws an 'error' nothing listens for.
    await new Promise<void>((resolve, reject) => {
      const fail = (err: NodeJS.ErrnoException) => reject(failed(err, false));
      child.once('error', fail);
      child.once('spawn', () => {
        child.off('error', fail);
        resolve();
      });
    });
    const rl = createInterface({ input: child.stdout! });
    return new StdioTransport(child, rl, config.id);
  }

  writeLine(json: string): void {
    // Nothing more goes to a child whose stdin or stdout has failed: this
    // transport is ending it.
    if (this.pipeError) return;
    // stdin may be gone if the child died between the closed-check and here.
    this.child.stdin?.write(json + '\n');
  }

  private closing: Promise<void> | null = null;

  /**
   * Close and reap: resolves once the child has actually exited, not merely
   * been signalled (`child.killed` is true as soon as a signal is sent). A
   * child that outlives SIGTERM by {@link STDIO_EXIT_GRACE_MS} gets SIGKILL.
   * If it still hasn't exited after that bound again, close rejects: an
   * explicit cleanup failure, rather than waiting forever or claiming an
   * exit that wasn't seen. Calls share one attempt, and so does a pipe
   * failure that is already ending the child; a later call succeeds if the
   * child has exited since.
   */
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.reap();
      return this.closing;
    }
    // A later call re-checks a failed verdict: a child that has exited since
    // is reaped now. No new signals are sent.
    return this.closing.catch((error: unknown) => {
      if (this.exited()) return;
      throw error;
    });
  }

  private async reap(): Promise<void> {
    this.markClosed({ reason: 'closed by host' });
    this.rl.close();
    await this.terminate();
  }

  /** Whether the child has exited, or never started (a spawn error). */
  private exited(): boolean {
    return this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private terminating: Promise<void> | null = null;

  /**
   * End the child: SIGTERM, then SIGKILL once it has outlived SIGTERM by
   * {@link STDIO_EXIT_GRACE_MS}. Resolves once it has exited; rejects if it
   * still hasn't that long after SIGKILL. close() and a pipe failure share
   * one attempt, so no second signal or timer goes out. A failed attempt is
   * re-checked, not repeated: a child that has exited since resolves it.
   */
  private terminate(): Promise<void> {
    this.terminating ??= this.escalate();
    return this.terminating.catch((error: unknown) => {
      if (this.exited()) return;
      throw error;
    });
  }

  private async escalate(): Promise<void> {
    const child = this.child;
    if (this.exited()) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const exitWithin = (ms: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    child.kill('SIGTERM');
    if (await exitWithin(STDIO_EXIT_GRACE_MS)) return;
    const named = `stdio child ${child.pid} of MCP server "${this.serverId}"`;
    console.error(`[mcpl] ${named} ignored SIGTERM for ${STDIO_EXIT_GRACE_MS}ms — sending SIGKILL`);
    child.kill('SIGKILL');
    if (await exitWithin(STDIO_EXIT_GRACE_MS)) return;
    throw new Error(
      `${named} did not exit within ${STDIO_EXIT_GRACE_MS}ms of SIGKILL; it could not be reaped`,
    );
  }
}

/** How long a stdio child gets to exit after SIGTERM, and again after SIGKILL. */
const STDIO_EXIT_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** Timeout for the WebSocket to reach OPEN before we give up (ms). */
const WS_OPEN_TIMEOUT_MS = 15_000;

/** `work`, or `signal`'s reason once it aborts, whichever comes first. The
 *  listener comes off the signal when `work` settles, so a long-lived signal,
 *  such as a reconnect loop's, doesn't gather one per dial. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class WebSocketTransport extends McplTransport {
  readonly kind = 'websocket' as const;

  private constructor(private readonly ws: WebSocket, config: McplServerConfig, dialed: string) {
    const serverId = config.id;
    super(serverId);

    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // MCPL frames are UTF-8 JSON text. A frame MAY contain multiple
      // newline-delimited messages or a trailing newline; split defensively.
      const text = isBinary ? (data as Buffer).toString('utf8') : String(data);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.pushLine(trimmed);
      }
    });

    // The client's text can quote the url as dialed (Bun's does): reported
    // masked, as a new error with no cause (clientErrorText).
    this.ws.on('error', (err: Error) => this.reportError(new Error(clientErrorText(err, config, dialed))));
    this.ws.on('close', (code: number, reason: Buffer) => {
      const text = reason?.toString('utf8');
      this.markClosed(text ? { code, reason: text, reasonFromPeer: true } : { code, reason: 'websocket closed' });
    });
  }

  /**
   * Dial `config.url` and resolve once the socket is OPEN. Appends `?token=`
   * when `config.token` is set. Rejects on connect error / timeout (and tears
   * the socket down) so a failed dial never leaks an open handle. `signal`
   * ends a dial whose connection is closed meanwhile, at once, rather than
   * at the open timeout.
   */
  static async open(config: McplServerConfig, signal?: AbortSignal): Promise<WebSocketTransport> {
    // Resolve the per-dial credential first: the provider runs on every
    // connect AND reconnect, so rotation happens at the transport layer and
    // nothing above it ever holds a credential.
    let token: string | null = config.token ?? null;
    const abandoned = (): Error =>
      new Error(`MCPL server "${config.id}" WebSocket connect abandoned: the connection was closed (${redactUrl(config.url)})`);
    if (config.accessProvider) {
      if (signal?.aborted) throw abandoned();
      try {
        // A dial whose connection is closed meanwhile stops waiting for the
        // provider; whatever the provider does later is ignored.
        const provided = Promise.resolve(config.accessProvider());
        provided.catch(() => { /* a late failure after the dial was abandoned */ });
        token = (signal ? await raceAbort(provided, signal) : await provided) ?? token;
      } catch (err) {
        if (signal?.aborted) throw abandoned();
        // Fall back to the static token (if any) rather than failing the dial
        // outright — the server will refuse a stale credential loudly anyway.
        // The provider's own text may quote the credential, so it isn't logged.
        console.error(
          `[mcpl] server "${config.id}": access provider failed (${describeCredentialError(err)}) — dialing with configured fallback`,
        );
      }
    }
    const url = buildWebSocketUrl(config, token);
    // A provider's token is in this url, and the query may be re-encoded:
    // the server's text is recorded with what the dial sent, the token in
    // each form a token is replaced in.
    noteDialSent(config, { url, token: token ?? undefined });
    // Error strings travel: traces, logs, tool results the model reads. They
    // get the endpoint, never the credential.
    const redacted = redactUrl(config.url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      throw new Error(`MCPL server "${config.id}" WebSocket connect failed: ${clientErrorText(err, config, url)} (${redacted})`);
    }

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
      const abandon = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners();
        ws.on('error', swallowLateErrors);
        try { ws.terminate(); } catch { /* already gone */ }
        reject(error);
      };
      const timer = setTimeout(() => {
        abandon(new Error(`MCPL server "${config.id}" WebSocket connect timed out after ${WS_OPEN_TIMEOUT_MS}ms (${redacted})`));
      }, WS_OPEN_TIMEOUT_MS);
      const onAbort = (): void => {
        abandon(new Error(`MCPL server "${config.id}" WebSocket connect abandoned: the connection was closed (${redacted})`));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      ws.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners('error'); // the instance re-attaches its own handlers
        resolve(new WebSocketTransport(ws, config, url));
      });

      ws.once('error', (err: Error) => {
        abandon(new Error(`MCPL server "${config.id}" WebSocket connect failed: ${clientErrorText(err, config, url)} (${redacted})`));
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

/** A ws:// or wss:// url in a WebSocket client's text, to the next space or
 *  quote: brackets (an IPv6 host) and parentheses can be part of one. */
const WS_URL_IN_TEXT = /\bwss?:\/\/[^\s"'<>`]+/gi;

/**
 * A WebSocket client's error text (an Error under Node's ws, an ErrorEvent
 * under Bun's), as the transport's own errors carry it: a failed dial's, and
 * one after the socket opened. A client can quote the url as dialed: under
 * Bun 1.3.13 and 1.4.3 a refused or unreachable dial's message holds it
 * whole, its user, password, path and query, and the token, a static one or
 * an access provider's. In order, so a credential is replaced while it's
 * whole: the url as dialed and as configured, wherever they occur, are
 * shown as {@link redactUrl} shows them; then the strings the configuration
 * and its dials know to be credentials (the dial has noted what it sent by
 * now) are replaced, in their encoded and decoded forms
 * ({@link redactServerText}); then any other ws(s) url left is shown as
 * {@link redactUrl} shows it. The caller makes a new error of it with no
 * `cause`, so the client's own error, message and stack, isn't reachable.
 * A configuration that can't be read withholds the text
 * ({@link WITHHELD_TEXT}) rather than throw: this runs in a socket's
 * 'error' listener, where a throw has nowhere to go.
 */
export function clientErrorText(err: unknown, config: McplServerConfig, dialed: string): string {
  // Bun's ws emits an ErrorEvent, not an Error, its text in `message` too.
  try {
    const said = (err as { message?: unknown } | null)?.message;
    let text = typeof said === 'string' ? said : String(err);
    const configured = config.url;
    const shown = redactUrl(configured);
    for (const url of [dialed, configured]) {
      if (url) text = text.split(url).join(shown);
    }
    text = redactServerText(text, config);
    return text.replace(WS_URL_IN_TEXT, (found) => redactUrl(found));
  } catch {
    return WITHHELD_TEXT;
  }
}

/**
 * Build the dial URL: validate it's a ws(s):// URL the ws library will dial,
 * which refuses one with a fragment, and append the auth token as a `token`
 * query param when provided (preserving any existing query).
 */
export function buildWebSocketUrl(config: McplServerConfig, tokenOverride?: string | null): string {
  if (!config.url) {
    throw new Error(`MCPL server "${config.id}": websocket transport requires "url" (none provided)`);
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    // Not echoed: a url that doesn't parse can't be redacted.
    throw new Error(`MCPL server "${config.id}": invalid WebSocket url (it isn't shown, since it may carry a credential)`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(
      `MCPL server "${config.id}": websocket url must be ws:// or wss://, got "${parsed.protocol}"`,
    );
  }
  if (parsed.hash) {
    throw new Error(`MCPL server "${config.id}": websocket url must not have a fragment, got "${parsed.hash}"`);
  }
  const token = tokenOverride !== undefined ? tokenOverride : config.token;
  return urlAsDialed(parsed, token).toString();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** True when the config selects the WebSocket transport, as
 *  {@link resolveServerBinding} decides it; false for any other transport and
 *  for a configuration it refuses. */
export function isWebSocketTransport(config: McplServerConfig): boolean {
  try {
    return resolveServerBinding(config).transport === 'websocket';
  } catch {
    return false;
  }
}

/** Whether a server's binding dials it, over WebSocket or HTTP. False for a
 *  stdio launch, and for a configuration whose binding can't be resolved,
 *  which the family check refuses. */
function dialsNetwork(config: McplServerConfig): boolean {
  try {
    return resolveServerBinding(config).transport !== 'stdio';
  } catch {
    return false;
  }
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
 * network server, WebSocket or HTTP, never reads it. The error names the
 * server, the setting and the value's kind, not the value, which could be a
 * secret pasted into the wrong field.
 */
export function assertServerConfigBooleans(config: McplServerConfig): void {
  for (const [setting, whatTrueDoes] of Object.entries(SERVER_CONFIG_BOOLEANS) as Array<[BooleanSetting, string]>) {
    if (setting === 'inheritEnv' && dialsNetwork(config)) continue;
    assertBooleanSetting(`MCPL server "${config.id}" ${setting}`, config[setting], whatTrueDoes);
  }
}

/**
 * Open the legacy transport `config` selects, as {@link resolveServerBinding}
 * decides it: stdio for a `command`, MCPL's WebSocket binding for a ws(s)://
 * url. A configuration it refuses, or one for the modern family (an http(s)
 * url, or `protocol: 'modern'`), throws before anything is spawned or dialed.
 * The returned transport is connected at the byte level but has NOT
 * performed the MCPL handshake.
 */
export async function openTransport(config: McplServerConfig, signal?: AbortSignal): Promise<McplTransport> {
  const binding = resolveServerBinding(config);
  if (binding.family !== 'legacy') {
    throw new Error(`MCP server "${config.id}" is configured for modern MCP; the legacy transports can't open it`);
  }
  return binding.transport === 'websocket' ? WebSocketTransport.open(config, signal) : StdioTransport.spawn(config);
}
