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
 * lets the event go on to the rules after the script's (as a script that
 * says show does): a script that throws, times out, isn't a function, or
 * leaves a state that can't be kept. Its state then stays as it was, and the
 * failure is counted and named in gate_status. A timeout stops the worker; a
 * fresh one loads every script again, one at a time, so a script whose own
 * loading hangs is set aside without the others. A script that times out
 * MAX_TIMEOUTS_IN_WINDOW times in its last TIMEOUT_WINDOW runs, probes
 * included, stops being run until its script changes: each timeout blocks the
 * caller's thread for the timeout and a worker's restart, so neither a script
 * that always hangs nor one that hangs now and then goes on costing that. A
 * worker that fails to start or answer is tried again with a later event,
 * each try later than the last, since a try can block for LOAD_TIMEOUT_MS.
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
/** How long compiling one script may take, the worker's start included (ms). */
const LOAD_TIMEOUT_MS = 3_000;
/** Timeouts within a script's last TIMEOUT_WINDOW runs after which it isn't run again until its script changes. */
export const MAX_TIMEOUTS_IN_WINDOW = 3;
export const TIMEOUT_WINDOW = 20;
/** How long after the worker failed to start or answer a later event first tries loading the scripts again (ms); doubled each failed try, up to the most. */
const WORKER_RETRY_MS = 5_000;
const WORKER_RETRY_MAX_MS = 5 * 60_000;
/** How soon after a state changes it's written to disk (ms), and how long a failed write waits to be tried again. */
const SAVE_DELAY_MS = 2_000;
const SAVE_RETRY_MS = 30_000;

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
  /** Present when the script no longer runs until its rule changes: why. */
  disabled?: string;
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
  disabled: string | null;
  runs: number;
  hidden: number;
  errors: number;
  timeouts: number;
  /** Whether each of its last TIMEOUT_WINDOW runs timed out. */
  recentRuns: boolean[];
  lastError: string | null;
}

interface SavedStates {
  version: 1;
  rules: Record<string, { script: string; state: Record<string, unknown> }>;
}

type Answer = Record<string, unknown> | { timeout: true };

const hashOf = (script: string): string => createHash('sha256').update(script).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Saved states as read from disk: entries that aren't a script hash and an object state are skipped and named; a file of another shape throws. */
function readSaved(raw: unknown, path: string): Map<string, { script: string; state: Record<string, unknown> }> {
  const out = new Map<string, { script: string; state: Record<string, unknown> }>();
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.rules)) throw new Error('it holds no version 1 states');
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(raw.rules)) {
    if (isRecord(entry) && typeof entry.script === 'string' && isRecord(entry.state)) out.set(name, { script: entry.script, state: entry.state });
    else skipped.push(name);
  }
  if (skipped.length > 0) console.error(`[gate] suppress-rule states in ${path}: ${skipped.map((n) => JSON.stringify(n)).join(', ')} can't be read, so those rules start afresh`);
  return out;
}

export class SuppressScripts {
  /** The worker and its own shared buffer: a worker stopped after a timeout may still write to the buffer it had. */
  private channel?: { worker: Worker; ctrl: Int32Array; data: Uint8Array };
  private readonly dec = new TextDecoder();
  private readonly rules = new Map<string, RuleScript>();
  /** States read from disk, by rule, kept until the rule with that script is synced or forgotten. */
  private saved = new Map<string, { script: string; state: Record<string, unknown> }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Whether the first sync, with every rule in force, has run: saved states it didn't take are then retired. */
  private synced = false;
  /** When a later event may try loading again, after loading failed for want of a worker (not a script's own error). */
  private workerRetryAt: number | null = null;
  private workerRetryDelay = WORKER_RETRY_MS;

  constructor(private readonly opts: { statePath?: string; timeoutMs?: number } = {}) {
    if (opts.statePath && existsSync(opts.statePath)) {
      try {
        this.saved = readSaved(JSON.parse(readFileSync(opts.statePath, 'utf-8')), opts.statePath);
      } catch (error) {
        // Moved aside, so the next save doesn't write over a file a later release wrote.
        const aside = `${opts.statePath}.unreadable`;
        let moved = '';
        try { renameSync(opts.statePath, aside); moved = ` It's kept as ${aside}.`; } catch { /* the save may yet fail too; the log says what was read */ }
        console.error(`[gate] suppress-rule states in ${opts.statePath} can't be read, so every rule's state starts afresh.${moved}`, error);
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
      const saved = this.saved.get(name);
      this.saved.delete(name);
      this.rules.set(name, {
        script, hash, state: saved && saved.script === hash ? saved.state : {}, loaded: false, disabled: null,
        runs: 0, hidden: 0, errors: 0, timeouts: 0, recentRuns: [], lastError: null,
      });
      changed = true;
    }
    // States saved for rules that weren't in force at the first sync are
    // retired: the rule was removed while the host was down, and one made
    // later under the name starts afresh.
    if (!this.synced) {
      this.synced = true;
      if (this.saved.size > 0) { this.saved.clear(); changed = true; }
    }
    if (!changed) return;
    this.scheduleSave();
    if (this.rules.size === 0) { this.stopWorker(); return; }
    this.load();
  }

  /** Forget a rule's script and state (a rule removed or redefined), a state saved for it before a restart included. */
  forget(name: string): void {
    const had = this.rules.delete(name) || this.saved.delete(name);
    if (had) this.scheduleSave();
    if (this.rules.size === 0) this.stopWorker();
  }

  /**
   * Whether `script` compiles to a function, run on the worker: an error's
   * text, or null. For wake_add_rule, before it saves a rule.
   */
  check(script: string): string | null {
    const answer = this.call({ type: 'check', script }, LOAD_TIMEOUT_MS);
    if ('timeout' in answer) {
      this.load(); // the worker was stopped: the rules' scripts go to a fresh one
      return `compiling it took over ${LOAD_TIMEOUT_MS / 1000} s`;
    }
    // A gate with no scripts runs no thread, this check's included.
    if (this.rules.size === 0) this.stopWorker();
    return typeof answer.error === 'string' ? answer.error : null;
  }

  /**
   * Run a rule's script for one event. `commit` keeps the state it leaves and
   * counts the run; without it (a probe) the state is as before. Undefined
   * when the rule has no script; `{ error }` when the script failed, and the
   * event goes on to the rules after it.
   */
  run(name: string, event: SuppressScriptEvent, commit: boolean): { hide: boolean } | { error: string } | undefined {
    const rule = this.rules.get(name);
    if (!rule) return undefined;
    if (rule.disabled) return { error: rule.disabled };
    // A load that failed for want of a worker is tried again, later each time.
    if (!rule.loaded && this.workerRetryAt !== null && Date.now() >= this.workerRetryAt) this.load();
    if (!rule.loaded) return { error: rule.lastError ?? 'the script is not loaded' };
    const answer = this.call({ type: 'eval', name, event, state: rule.state }, this.timeoutMs);
    if ('timeout' in answer) {
      // The worker was stopped; every script goes to a fresh one. A probe's
      // timeout counts toward setting the script aside too: it costs the same.
      const error = `it took over ${this.timeoutMs} ms, so it was stopped`;
      if (commit) rule.runs++;
      rule.timeouts++;
      rule.lastError = error;
      if (this.noteRun(rule, true) >= MAX_TIMEOUTS_IN_WINDOW) {
        rule.disabled = `it took over ${this.timeoutMs} ms ${MAX_TIMEOUTS_IN_WINDOW} times in its last ${TIMEOUT_WINDOW} runs, so it isn't run again until its script changes`;
        rule.lastError = rule.disabled;
      }
      this.load();
      return { error };
    }
    this.noteRun(rule, false);
    if (!commit) return typeof answer.error === 'string' ? { error: answer.error } : { hide: answer.hide === true };
    rule.runs++;
    if (typeof answer.error === 'string') {
      rule.errors++;
      rule.lastError = answer.error;
      return { error: answer.error };
    }
    const next = isRecord(answer.state) ? answer.state : {};
    if (JSON.stringify(next) !== JSON.stringify(rule.state)) {
      rule.state = next;
      this.scheduleSave();
    }
    const hide = answer.hide === true;
    if (hide) rule.hidden++;
    return { hide };
  }

  /** One run in the rule's recent runs: how many of them timed out. */
  private noteRun(rule: RuleScript, timedOut: boolean): number {
    rule.recentRuns.push(timedOut);
    if (rule.recentRuns.length > TIMEOUT_WINDOW) rule.recentRuns.shift();
    return rule.recentRuns.filter(Boolean).length;
  }

  status(name: string): SuppressScriptStatus | undefined {
    const rule = this.rules.get(name);
    if (!rule) return undefined;
    return {
      loaded: rule.loaded, ...(rule.disabled ? { disabled: rule.disabled } : {}),
      runs: rule.runs, hidden: rule.hidden, errors: rule.errors, timeouts: rule.timeouts,
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

  /**
   * Load every script that isn't set aside into the worker, one at a time,
   * on a clean slate. A script whose loading times out is set aside (it
   * would stop the worker each time), and the rest are loaded again on the
   * fresh worker that follows.
   */
  private load(): void {
    if (this.rules.size === 0) return;
    for (let attempt = 0; attempt <= this.rules.size; attempt++) {
      const reset = this.call({ type: 'reset' }, LOAD_TIMEOUT_MS);
      if ('timeout' in reset || typeof reset.error === 'string') {
        const why = 'timeout' in reset ? `the script worker didn't answer within ${LOAD_TIMEOUT_MS / 1000} s` : reset.error as string;
        for (const rule of this.rules.values()) { rule.loaded = false; rule.lastError = rule.disabled ?? `${why}; it's tried again with a later event`; }
        this.workerRetryAt = Date.now() + this.workerRetryDelay;
        this.workerRetryDelay = Math.min(WORKER_RETRY_MAX_MS, this.workerRetryDelay * 2);
        return;
      }
      this.workerRetryAt = null;
      this.workerRetryDelay = WORKER_RETRY_MS;
      let restarted = false;
      for (const [name, rule] of this.rules) {
        if (rule.disabled) { rule.loaded = false; continue; }
        const answer = this.call({ type: 'load', name, script: rule.script }, LOAD_TIMEOUT_MS);
        if ('timeout' in answer) {
          rule.loaded = false;
          rule.disabled = `compiling it took over ${LOAD_TIMEOUT_MS / 1000} s, so it isn't run until its rule changes`;
          rule.lastError = rule.disabled;
          restarted = true;
          break;
        }
        if (typeof answer.error === 'string') {
          rule.loaded = false;
          rule.lastError = `it doesn't compile: ${answer.error}`;
        } else {
          rule.loaded = true;
        }
      }
      if (!restarted) return;
    }
  }

  /** One message to the worker, waited for: its answer, or a timeout, after which the worker is stopped (the caller loads the scripts again). */
  private call(msg: Record<string, unknown>, timeoutMs: number): Answer {
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
      // A worker that dies on its own (a script's stray asynchronous throw) is
      // no one's timeout: the next run loads the scripts on a fresh one.
      worker.once('exit', () => {
        if (this.channel?.worker !== worker) return;
        this.channel = undefined;
        for (const rule of this.rules.values()) rule.loaded = false;
        this.workerRetryAt = 0;
      });
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

  private scheduleSave(delayMs = SAVE_DELAY_MS): void {
    if (!this.opts.statePath || this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, delayMs);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const path = this.opts.statePath;
    if (!path) return;
    // A null-prototype object, so a rule named "__proto__" is an entry like any other.
    const rules: SavedStates['rules'] = Object.create(null);
    for (const [name, saved] of this.saved) rules[name] = saved;
    for (const [name, rule] of this.rules) rules[name] = { script: rule.hash, state: rule.state };
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`);
      renameSync(temp, path);
    } catch (error) {
      console.error(`[gate] suppress-rule states couldn't be written to ${path}; they're kept in memory and written again shortly:`, error);
      this.scheduleSave(SAVE_RETRY_MS);
    }
  }
}
