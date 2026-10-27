/**
 * GateScript — runs an agent-authored `gate.js` decision function on a worker
 * thread, synchronously from the gate's perspective, with a hard timeout.
 *
 * The agent is trusted (shell + fs already), so this is a robustness seatbelt,
 * not a security sandbox: a script that throws falls through to the declarative
 * policies (and the error is surfaced via status()); a script that hangs is
 * timed out (Atomics.wait), the wedged worker is terminated and respawned, and
 * the event falls through — so a bad rule can't brick the agent's own attention.
 *
 * Sync model: the main thread posts the event then blocks in Atomics.wait until
 * the worker writes the result into shared memory (or the timeout elapses).
 * Node permits Atomics.wait on the main thread, so evaluate() stays synchronous
 * and the rest of the EventGate is unchanged.
 */
import { Worker } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GateBehavior, GateEventInfo } from './types.js';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'gate-script-worker.js');
const SAB_SIZE = 16_384;
const RELOAD_THROTTLE_MS = 1000;

export interface GateScriptStatus {
  active: boolean;
  ready: boolean;
  path: string;
  runs: number;
  errors: number;
  timeouts: number;
  lastError: string | null;
}

interface ScriptResult {
  behavior?: GateBehavior | null;
  error?: string;
}

export class GateScript {
  private worker?: Worker;
  private readonly sab = new SharedArrayBuffer(SAB_SIZE);
  private readonly ctrl = new Int32Array(this.sab, 0, 2);
  private readonly data = new Uint8Array(this.sab, 8);
  private readonly dec = new TextDecoder();
  private mtime = 0;
  private lastCheck = 0;
  private active = false;
  private ready = false;
  private lastError: string | null = null;
  private runs = 0;
  private errors = 0;
  private timeouts = 0;

  constructor(
    private readonly scriptPath: string,
    private readonly timeoutMs = 50,
    private readonly now: () => number = Date.now,
  ) {
    this.reloadIfChanged();
  }

  /** Hot-reload: (re)spawn the worker when gate.js appears or changes; stop it
   *  when the file is removed. Throttled like the gate's config reload. */
  private reloadIfChanged(): void {
    const t = this.now();
    if (this.lastCheck !== 0 && t - this.lastCheck < RELOAD_THROTTLE_MS) return;
    this.lastCheck = t;
    if (!existsSync(this.scriptPath)) {
      if (this.active) this.stop();
      return;
    }
    let m = 0;
    try {
      m = statSync(this.scriptPath).mtimeMs;
    } catch {
      return;
    }
    if (this.active && m === this.mtime) return;
    this.mtime = m;
    this.spawn();
  }

  private spawn(): void {
    this.stop();
    try {
      const w = new Worker(WORKER_PATH, {
        workerData: { scriptPath: this.scriptPath, sab: this.sab },
      });
      w.on('message', (m: { type?: string; error?: string | null }) => {
        if (m?.type === 'ready') {
          this.ready = true; // load finished (with or without a load error)
          if (m.error) this.lastError = m.error;
        }
      });
      w.on('error', (e) => {
        this.lastError = e.message;
      });
      w.unref(); // never keep the process alive on the gate script's account
      this.worker = w;
      this.active = true;
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.active = false;
    }
  }

  private stop(): void {
    if (this.worker) {
      void this.worker.terminate().catch(() => {});
      this.worker = undefined;
    }
    this.active = false;
    this.ready = false;
  }

  /**
   * Evaluate the script for one event.
   *  - returns a GateBehavior → the script decided
   *  - returns null → fall through to the declarative policies
   *  - returns undefined → script inactive / errored / timed out (fall through)
   */
  evaluate(event: GateEventInfo): GateBehavior | null | undefined {
    this.reloadIfChanged();
    // Inactive, or the worker hasn't finished importing gate.js yet → fall
    // through (don't time-out/respawn during a cold start).
    if (!this.active || !this.worker || !this.ready) return undefined;

    Atomics.store(this.ctrl, 0, 0);
    try {
      this.worker.postMessage({ type: 'eval', event });
    } catch (e) {
      this.lastError = (e as Error).message;
      return undefined;
    }

    const r = Atomics.wait(this.ctrl, 0, 0, this.timeoutMs);
    this.runs++;
    if (r === 'timed-out') {
      this.timeouts++;
      this.lastError = `gate.js timed out (>${this.timeoutMs}ms) — terminated and restarted`;
      this.spawn(); // kill the wedged worker, fresh one for next time
      return undefined;
    }

    const len = Atomics.load(this.ctrl, 1);
    let parsed: ScriptResult;
    try {
      parsed = JSON.parse(this.dec.decode(this.data.subarray(0, len))) as ScriptResult;
    } catch {
      this.errors++;
      this.lastError = 'gate.js produced an unreadable result';
      return undefined;
    }
    if (parsed.error) {
      this.errors++;
      this.lastError = parsed.error;
      return undefined;
    }
    return parsed.behavior ?? null;
  }

  status(): GateScriptStatus {
    return {
      active: this.active,
      ready: this.ready,
      path: this.scriptPath,
      runs: this.runs,
      errors: this.errors,
      timeouts: this.timeouts,
      lastError: this.lastError,
    };
  }

  dispose(): void {
    this.stop();
  }
}
