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
import WebSocket from 'ws';

import type { McplServerConfig } from './types.js';

/** Why/how a transport closed. `code`/`signal` are populated for stdio child
 *  exits; `reason` carries a WebSocket close reason or an error message. */
export interface TransportCloseInfo {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
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

export class StdioTransport extends McplTransport {
  readonly kind = 'stdio' as const;

  private constructor(
    private readonly child: ChildProcess,
    private readonly rl: ReadlineInterface,
  ) {
    super();

    this.rl.on('line', (line: string) => this.pushLine(line));

    // Stitch stderr chunks into whole lines (a chunk can split a line).
    let carry = '';
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = carry + chunk.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const l of lines) if (l.length > 0) this.pushStderr(l);
    });

    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code, signal) =>
      this.markClosed({ code, signal, reason: 'child process exited' }),
    );
  }

  /**
   * Spawn `config.command` and return a ready stdio transport. Rejects if the
   * command is missing (a config bug) or the process fails to spawn.
   */
  static spawn(config: McplServerConfig): StdioTransport {
    if (!config.command) {
      throw new Error(
        `MCPL server "${config.id}": stdio transport requires "command" (none provided)`,
      );
    }
    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
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
      if (!this.child || this.child.exitCode !== null || this.child.killed) {
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
    this.ws.on('close', (code: number, reason: Buffer) =>
      this.markClosed({ code, reason: reason?.toString('utf8') || 'websocket closed' }),
    );
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
    if (config.tokenProvider) {
      try {
        token = (await config.tokenProvider()) ?? token;
      } catch (err) {
        // Fall back to the static token (if any) rather than failing the dial
        // outright — the server will refuse a stale credential loudly anyway.
        console.error(
          `[mcpl] server "${config.id}": credential provider failed (${err instanceof Error ? err.message : err}) — dialing with static token`,
        );
      }
    }
    const url = buildWebSocketUrl(config, token);
    // Error strings travel: traces, logs, tool results the model reads. They
    // get the endpoint, never the credential.
    const redacted = buildWebSocketUrl({ ...config, token: undefined }, null);
    const ws = new WebSocket(url);

    return new Promise<WebSocketTransport>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners();
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
