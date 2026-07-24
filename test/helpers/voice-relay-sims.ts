/**
 * Voice-relay test helpers: a recording WebSocket wrapper, a voice-client
 * simulator speaking the v2 /tts protocol, shared fixture config, and a
 * spawner that runs the reference melodeus-tts-relay for end-to-end tests.
 *
 * (Trimmed from the full WebSocket conformance harness: the bot simulator,
 * fixture runner, and transcript comparator live on the voice-relay-module
 * branch alongside the server-side module they exercise.)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// ── Wire-level socket with transcript recording ────────────────────────────

export class SimSocket {
  readonly ws: WebSocket;
  readonly transcript: Array<Record<string, unknown>> = [];
  heartbeats = 0;
  private queue: Array<Record<string, unknown>> = [];
  private waiters: Array<(msg: Record<string, unknown>) => void> = [];
  readonly closeInfo: Promise<{ code: number; reason: string }>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'heartbeat') {
        this.heartbeats++;
        return;
      }
      this.transcript.push(msg);
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
    this.closeInfo = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  async opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for message (transcript so far: ${JSON.stringify(this.transcript)})`)),
        timeoutMs,
      );
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  /** Wait a quiet window; returns the number of unexpected queued messages. */
  async settle(ms = 200): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.queue.length;
  }

  /** Drain anything queued (used before diffing full transcripts). */
  drain(): void {
    this.queue.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

// ── Voice client simulator (v2 client protocol) ────────────────────────────

export interface ClientAuthOpts {
  clientId: string;
  token: string;
  username?: string;
}

export class VoiceClientSim {
  sock!: SimSocket;
  constructor(private baseUrl: string) {}

  async connect(): Promise<void> {
    this.sock = new SimSocket(`${this.baseUrl}/tts`);
    await this.sock.opened();
  }

  async auth(opts: ClientAuthOpts): Promise<Record<string, unknown>> {
    const msg: Record<string, unknown> = { type: 'auth', clientId: opts.clientId, token: opts.token };
    if (opts.username !== undefined) msg.username = opts.username;
    this.sock.send(msg);
    return this.sock.next();
  }

  /**
   * Subscribe and collect the reply burst: `subscribed`, then any of
   * `members`/`config` in server order, until `config` arrives (the relay
   * ends the burst with config).
   */
  async subscribe(channels: string[]): Promise<Record<string, unknown>[]> {
    this.sock.send({ type: 'subscribe', channels });
    const burst: Record<string, unknown>[] = [];
    for (;;) {
      const msg = await this.sock.next();
      burst.push(msg);
      if (msg.type === 'config') break;
      if (burst.length > 8) throw new Error(`subscribe burst never ended: ${JSON.stringify(burst)}`);
    }
    return burst;
  }

  send(msg: Record<string, unknown>): void {
    this.sock.send(msg);
  }

  next(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.sock.next(timeoutMs);
  }

  close(): void {
    this.sock.close();
  }
}

// ── Shared fixtures: tokens, user account, relay config ────────────────────
export const TOKENS = {
  bot: 'bot-secret',
  client: 'client-secret',
};

/**
 * Write the reference relay's fixture config. Returns the file path.
 * (Client auth uses the BOT_TOKENS/TTS_CLIENT_TOKENS env pools, not this
 * file; the config only feeds the relay's voice routing.)
 */
export function writeRelayConfig(dir: string): string {
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      relay_config: {
        elevenLabsKey: 'sk_conformance',
        ttsModel: 'eleven_multilingual_v2',
        voices: {
          Opus45: { voiceId: 'V-opus', discordName: 'Opus 4.5', enabled: true },
        },
        mentionMode: 'default',
        defaultBot: 'Opus45',
      },
    }),
  );
  return path;
}

// ── Reference relay spawner ─────────────────────────────────────────────────

export interface ReferenceRelay {
  url: string;
  httpUrl: string;
  stop: () => Promise<void>;
}

export function referenceRelayDir(): string {
  const home = process.env.HOME;
  return (
    process.env.VOICE_RELAY_REFERENCE_DIR ??
    (home ? join(home, 'hot', 'melodeus-tts-relay') : '')
  );
}

/** Null if the reference repo or its node_modules are absent. */
export function referenceRelayAvailable(): string | null {
  const dir = referenceRelayDir();
  if (!dir) return null;
  if (!existsSync(join(dir, 'src', 'index.ts'))) return null;
  if (!existsSync(join(dir, 'node_modules', 'ws'))) return null;
  if (!existsSync(join(dir, 'node_modules', '.bin', 'tsx'))) return null;
  return dir;
}

export async function spawnReferenceRelay(configFile: string): Promise<ReferenceRelay> {
  const dir = referenceRelayAvailable();
  if (!dir) throw new Error('reference relay unavailable');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 21000 + Math.floor(Math.random() * 8000);
    const child: ChildProcess = spawn(
      join(dir, 'node_modules', '.bin', 'tsx'),
      ['src/index.ts'],
      {
        cwd: dir,
        env: {
          ...process.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          BOT_TOKENS: TOKENS.bot,
          TTS_CLIENT_TOKENS: TOKENS.client,
          CONFIG_FILE: configFile,
          LOG_LEVEL: 'error',
          // No DISCORD_BOT_TOKEN: the relay runs gateway/webhook-less —
          // pure streaming fan-out, all these tests need.
          DISCORD_BOT_TOKEN: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    const httpUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    let up = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (up) {
      return {
        url: `ws://127.0.0.1:${port}`,
        httpUrl,
        stop: async () => {
          child.kill('SIGTERM');
          await Promise.race([
            new Promise((r) => child.once('exit', r)),
            new Promise((r) => setTimeout(r, 2500)),
          ]);
          if (child.exitCode === null) child.kill('SIGKILL');
        },
      };
    }
    child.kill('SIGKILL');
    lastError = new Error(
      `reference relay failed to start on port ${port} (exit=${child.exitCode}): ${stderr.slice(0, 500)}`,
    );
  }
  throw lastError ?? new Error('reference relay failed to start');
}
