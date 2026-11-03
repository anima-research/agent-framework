/**
 * SuppressScripts — the agent's own logic for its suppress rules
 * (`suppress.script`): a function `(event, state) => boolean` the rule's
 * events are passed to, true hiding the event. `state` is the rule's own
 * JSON object, which the script reads and changes as it likes, so a rule can
 * hide what it has seen before, count, or keep a window of its own. The
 * framework keeps each rule's state between events and across restarts, in
 * `suppress-state.json` beside gate.json, and starts it afresh when the
 * rule's script changes or the rule is removed.
 *
 * The scripts run on one worker thread, called synchronously from the gate
 * (Atomics.wait) with a timeout, as gate.js is (gate-script.ts): a robustness
 * boundary for code the agent wrote, not a security sandbox. Every failure
 * shows the event: a script that throws, times out, isn't a function, or
 * leaves a state that can't be kept. Its state then stays as it was, and the
 * failure is counted and named in gate_status. A script that times out has
 * its worker terminated and started again.
 *
 * The worker starts with the first rule that has a script, so a gate with
 * none runs no thread.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'suppress-script-worker.js');
/** The most a rule's state may hold, as JSON (bytes). */
export const MAX_SUPPRESS_STATE_BYTES = 64 * 1024;
/** Room for an answer: the state, and the rest of the answer around it. */
const SAB_SIZE = 8 + 2 * MAX_SUPPRESS_STATE_BYTES + 16_384;
/** How long one event's call may take before the script is stopped and the event shown (ms). */
export const DEFAULT_SUPPRESS_SCRIPT_TIMEOUT_MS = 50;
/** How long compiling the scripts may take, the worker's start included (ms). */
const LOAD_TIMEOUT_MS = 3_000;
/** How soon after a state changes it's written to disk (ms). */
const SAVE_DELAY_MS = 2_000;

/** What a script is given for each event. */
export interface SuppressScriptEvent {
  eventType: string;
  source: string;
  channel?: string;
  author?: string;
  tags: string[];
  /** The event's text. */
  text: string;
  /** When the event arrived (ms since the epoch). */
  at: number;
  /** The event's metadata, as JSON. */
  metadata: Record<string, unknown>;
}

/** How a rule's script has run, for gate_status. */
export interface SuppressScriptStatus {
  loaded: boolean;
  runs: number;
  hidden: number;
  errors: number;
  timeouts: number;
  lastError: string | null;
  /** Its state's size as JSON (bytes). */
  stateBytes: number;
}

interface RuleScript {
  script: string;
  hash: string;
  state: Record<string, unknown>;
  loaded: boolean;
  runs: number;
  hidden: number;
  errors: number;
  timeouts: number;
  lastError: string | null;
}

interface SavedStates {
  version: 1;
  rules: Record<string, { script: string; state: Record<string, unknown> }>;
}

const hashOf = (script: string): string => createHash('sha256').update(script).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class SuppressScripts {
  /** The worker and its own shared buffer: a worker stopped after a timeout may still write to the buffer it had. */
  private channel?: { worker: Worker; ctrl: Int32Array; data: Uint8Array };
  private readonly dec = new TextDecoder();
  private readonly rules = new Map<string, RuleScript>();
  /** States read from disk, by rule, kept until the rule with that script is synced. */
  private saved: SavedStates['rules'] = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly opts: { statePath?: string; timeoutMs?: number } = {}) {
    if (opts.statePath && existsSync(opts.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(opts.statePath, 'utf-8')) as Partial<SavedStates>;
        if (raw?.version === 1 && raw.rules && typeof raw.rules === 'object') this.saved = raw.rules;
      } catch (error) {
        console.error(`[gate] suppress-rule states in ${opts.statePath} can't be read, so every rule's state starts afresh:`, error);
      }
    }
  }

  private get timeoutMs(): number { return this.opts.timeoutMs ?? DEFAULT_SUPPRESS_SCRIPT_TIMEOUT_MS; }

  /**
   * Bring the scripts in step with the rules in force: compile new and
   * changed ones, drop removed ones. A rule keeps its state while its script
   * is the same text; a new or changed script starts from `{}`, or from the
   * state saved for that very script before a restart.
   */
  sync(rules: ReadonlyArray<{ name: string; script?: string }>): void {
    if (this.disposed) return;
    const wanted = new Map(rules.filter((r): r is { name: string; script: string } => typeof r.script === 'string').map((r) => [r.name, r.script]));
    let changed = false;
    for (const name of [...this.rules.keys()]) {
      if (wanted.get(name) !== this.rules.get(name)!.script) { this.rules.delete(name); changed = true; }
    }
    for (const [name, script] of wanted) {
      if (this.rules.has(name)) continue;
      const hash = hashOf(script);
      const saved = this.saved[name];
      this.rules.set(name, {
        script, hash, state: saved && saved.script === hash ? saved.state : {}, loaded: false,
        runs: 0, hidden: 0, errors: 0, timeouts: 0, lastError: null,
      });
      changed = true;
    }
    if (!changed) return;
    this.saved = {};
    this.scheduleSave();
    if (this.rules.size === 0) { this.stopWorker(); return; }
    this.load();
  }

  /** Forget a rule's script and state (a rule removed or redefined); the next sync compiles it afresh. */
  forget(name: string): void {
    if (this.rules.delete(name)) this.scheduleSave();
  }

  /**
   * Whether `script` compiles to a function, run on the worker: an error's
   * text, or null. For wake_add_rule, before it saves a rule.
   */
  check(script: string): string | null {
    const answer = this.call({ type: 'check', script }, LOAD_TIMEOUT_MS);
    if ('timeout' in answer) return `compiling it took over ${LOAD_TIMEOUT_MS / 1000} s`;
    return typeof answer.error === 'string' ? answer.error : null;
  }

  /**
   * Run a rule's script for one event. `commit` keeps the state it leaves;
   * without it (a probe) the state is as before. Undefined when the rule has
   * no script; `{ error }` when the event is to be shown because the script
   * failed.
   */
  run(name: string, event: SuppressScriptEvent, commit: boolean): { hide: boolean } | { error: string } | undefined {
    const rule = this.rules.get(name);
    if (!rule) return undefined;
    if (!rule.loaded) return { error: rule.lastError ?? 'the script is not loaded' };
    const answer = this.call({ type: 'eval', name, event, state: rule.state }, this.timeoutMs);
    if (!commit) {
      if ('timeout' in answer) return { error: `it took over ${this.timeoutMs} ms` };
      return typeof answer.error === 'string' ? { error: answer.error } : { hide: answer.hide === true };
    }
    rule.runs++;
    if ('timeout' in answer) {
      rule.timeouts++;
      rule.lastError = `it took over ${this.timeoutMs} ms, so it was stopped and the event shown`;
      return { error: rule.lastError };
    }
    if (typeof answer.error === 'string') {
      rule.errors++;
      rule.lastError = answer.error;
      return { error: answer.error };
    }
    const next = answer.state && typeof answer.state === 'object' && !Array.isArray(answer.state) ? answer.state as Record<string, unknown> : {};
    if (JSON.stringify(next) !== JSON.stringify(rule.state)) {
      rule.state = next;
      this.scheduleSave();
    }
    const hide = answer.hide === true;
    if (hide) rule.hidden++;
    return { hide };
  }

  status(name: string): SuppressScriptStatus | undefined {
    const rule = this.rules.get(name);
    if (!rule) return undefined;
    return {
      loaded: rule.loaded, runs: rule.runs, hidden: rule.hidden, errors: rule.errors, timeouts: rule.timeouts,
      lastError: rule.lastError, stateBytes: Buffer.byteLength(JSON.stringify(rule.state)),
    };
  }

  /** A rule's state as its script left it (a copy). */
  stateOf(name: string): Record<string, unknown> | undefined {
    const rule = this.rules.get(name);
    return rule ? structuredClone(rule.state) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    this.stopWorker();
  }

  /** Write the states now, if a write is due. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private load(): void {
    const answer = this.call({ type: 'load', rules: [...this.rules].map(([name, r]) => ({ name, script: r.script })) }, LOAD_TIMEOUT_MS);
    const errors = !('timeout' in answer) && answer.errors && typeof answer.errors === 'object' ? answer.errors as Record<string, string> : {};
    for (const [name, rule] of this.rules) {
      if ('timeout' in answer) {
        rule.loaded = false;
        rule.lastError = `loading the scripts took over ${LOAD_TIMEOUT_MS / 1000} s`;
      } else if (errors[name] !== undefined) {
        rule.loaded = false;
        rule.lastError = `it doesn't compile: ${errors[name]}`;
      } else {
        rule.loaded = true;
      }
    }
  }

  /** One message to the worker, waited for: its answer, or a timeout, after which the worker is started again. */
  private call(msg: Record<string, unknown>, timeoutMs: number): Record<string, unknown> | { timeout: true } {
    if (this.disposed) return { error: 'the gate is stopped' };
    const channel = this.ensureWorker();
    if (!channel) return { error: 'the script worker could not start' };
    const { worker, ctrl, data } = channel;
    Atomics.store(ctrl, 0, 0);
    try {
      worker.postMessage(msg);
    } catch (e) {
      return { error: message(e) };
    }
    if (Atomics.wait(ctrl, 0, 0, timeoutMs) === 'timed-out') {
      this.stopWorker();
      // The scripts the worker held are loaded again, on a fresh worker, for the events after.
      if (msg.type === 'eval') this.load();
      else for (const rule of this.rules.values()) rule.loaded = false;
      return { timeout: true };
    }
    const length = Atomics.load(ctrl, 1);
    try {
      return JSON.parse(this.dec.decode(data.slice(0, length))) as Record<string, unknown>;
    } catch {
      return { error: 'the script worker gave an unreadable answer' };
    }
  }

  private ensureWorker(): { worker: Worker; ctrl: Int32Array; data: Uint8Array } | undefined {
    if (this.channel) return this.channel;
    try {
      const sab = new SharedArrayBuffer(SAB_SIZE);
      const worker = new Worker(WORKER_PATH, { workerData: { sab, maxStateBytes: MAX_SUPPRESS_STATE_BYTES } });
      worker.on('error', (e) => { console.error('[gate] the suppress-script worker failed:', e); });
      worker.unref();
      this.channel = { worker, ctrl: new Int32Array(sab, 0, 2), data: new Uint8Array(sab, 8) };
      return this.channel;
    } catch (error) {
      console.error('[gate] the suppress-script worker could not start:', error);
      return undefined;
    }
  }

  private stopWorker(): void {
    if (!this.channel) return;
    void this.channel.worker.terminate().catch(() => {});
    this.channel = undefined;
  }

  private scheduleSave(): void {
    if (!this.opts.statePath || this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const path = this.opts.statePath;
    if (!path) return;
    const out: SavedStates = { version: 1, rules: {} };
    for (const [name, rule] of this.rules) out.rules[name] = { script: rule.hash, state: rule.state };
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(out, null, 2)}\n`);
      renameSync(temp, path);
    } catch (error) {
      console.error(`[gate] suppress-rule states couldn't be written to ${path}; they're kept in memory:`, error);
    }
  }
}
