/**
 * PyRunner — subprocess lifecycle + protocol driver for the client-side
 * programmatic tool calling (`code_execution`) runtime.
 *
 * One runner per agent. The interpreter is spawned lazily on first exec,
 * persists between execs (script globals survive — container-reuse
 * semantics), and is reclaimed after an idle period, mirroring the managed
 * runtime's ~5-minute container reclaim.
 *
 * This is a ROBUSTNESS boundary, not a security sandbox — same doctrine as
 * GateScript: the agent already has broader host access through its tools.
 * What this class guarantees is liveness: a wedged or runaway script cannot
 * hang the agent turn (cancel + SIGINT -> grace -> SIGKILL -> respawn) and a crashed
 * interpreter surfaces as a tool result, never as an unhandled rejection.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { PYTHON_RUNTIME_SOURCE } from './runtime-py.js';

export interface InjectedTool {
  /** Python identifier the tool is bound to (sanitized, `--` -> `__`). */
  pyName: string;
  /** Exact framework tool name, sent back on tool_call ops. */
  toolName: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  returnCode: number;
  /** Set when the host killed the script (deadline / abort / crash). */
  aborted?: boolean;
  /** Background execs: rolling tail of interleaved stdout+stderr (for the
   *  crash/finish envelope; the full journal is in the log file). */
  tail?: string;
}

/** Per-exec options for background (daemon) scripts. */
export interface BackgroundExecOptions {
  /** Absolute path for the line-buffered stdout+stderr journal (null: tail only). */
  logPath: string | null;
  /**
   * Called on each wake_agent() from the script. Resolve with null to ack
   * (deliver), or an error string to refuse (raises RuntimeError in-script).
   * May resolve late — rate limiting backpressures inside wake_agent().
   */
  onWake: (line: number, payload: unknown) => Promise<string | null>;
  /** Overrides the runner's scriptTimeoutMs (background lifetime). */
  lifetimeMs: number;
}

/** Resolves inner tool calls. Must never reject — map errors to strings. */
export type ScriptToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export interface PyRunnerOptions {
  pythonPath?: string;
  /** Per-tool-call timeout surfaced as TimeoutError inside the script. */
  toolCallTimeoutMs?: number;
  /** Whole-script deadline; exceeded -> cancel, grace, kill. */
  scriptTimeoutMs?: number;
  /** How long a script gets to stop after its deadline before the interpreter is killed (default 10s). */
  cancelGraceMs?: number;
  /** Idle interpreter reclaim (state lost), mirroring container reclaim. */
  idleReclaimMs?: number;
  onToolCall: ScriptToolCallHandler;
  /** Log prefix, typically the agent name. */
  label?: string;
}

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 270_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_RECLAIM_MS = 300_000;
const CANCEL_GRACE_MS = 10_000;
/** After the deadline, SIGINT is repeated at this interval until the script reports or is killed. */
const INTERRUPT_REPEAT_MS = 200;

/** The longest delay Node's timers honour (~24.8 days); a longer one fires after ~1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A time limit for a message: "45s", "10 min", "2.5 h". */
export function formatLimit(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 7_200_000) return `${Math.round(ms / 6_000) / 10} min`;
  return `${Math.round(ms / 360_000) / 10} h`;
}

interface PendingExec {
  id: string;
  resolve: (result: ExecResult) => void;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  /** Repeats the deadline SIGINT (see interruptChild). */
  interruptTimer?: ReturnType<typeof setInterval>;
  settled: boolean;
  /** Set once the deadline fired: the result then says the script ran out of time. */
  deadlineMs: number | null;
}

export class PyRunner {
  private readonly pythonPath: string;
  private readonly toolCallTimeoutMs: number;
  private readonly scriptTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly idleReclaimMs: number;
  private readonly onToolCall: ScriptToolCallHandler;
  private readonly label: string;

  private onWake: ((line: number, payload: unknown) => Promise<string | null>) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private childReady: Promise<void> | null = null;
  private reader: Interface | null = null;
  private runtimeDir: string | null = null;
  private pending: PendingExec | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private execCounter = 0;
  private disposed = false;
  /** An exec has passed the busy check but is still awaiting the interpreter. */
  private starting = false;

  constructor(options: PyRunnerOptions) {
    this.pythonPath = options.pythonPath ?? 'python3';
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.scriptTimeoutMs = options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.idleReclaimMs = options.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS;
    this.onToolCall = options.onToolCall;
    this.label = options.label ?? 'pytc';
  }

  get busy(): boolean {
    return this.pending !== null || this.starting;
  }

  /**
   * Run one script. Tools are (re-)injected before every exec so the
   * interpreter always reflects the current tool surface (list_changed etc.).
   * Never rejects: every failure mode resolves to an ExecResult.
   *
   * With `background` options the exec is a daemon: output journals to the
   * log file, wake_agent() is available in-script, and the deadline is the
   * background lifetime. A background runner should be DEDICATED to that one
   * script (the framework creates one per background script).
   *
   * `opts.deadlineMs` replaces the runner's scriptTimeoutMs for this exec (a
   * per-call time limit); a background exec uses its `lifetimeMs` instead.
   */
  async exec(
    code: string,
    tools: InjectedTool[],
    background?: BackgroundExecOptions,
    opts?: { deadlineMs?: number },
  ): Promise<ExecResult> {
    if (this.disposed) {
      return { stdout: '', stderr: 'code_execution runner disposed', returnCode: 1, aborted: true };
    }
    if (this.busy) {
      return {
        stdout: '',
        stderr: 'RuntimeError: another code_execution script is already running for this agent',
        returnCode: 1,
        aborted: true,
      };
    }
    this.clearIdleTimer();

    this.starting = true; // claimed before the await: a same-tick second exec must see it
    try {
      await this.ensureChild();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.reclaim('spawn-failed');
      return {
        stdout: '',
        stderr: `Failed to start python runtime (${this.pythonPath}): ${message}`,
        returnCode: 1,
        aborted: true,
      };
    } finally {
      this.starting = false; // `pending` is set below, with no await in between
    }

    const execId = `e${++this.execCounter}`;
    // Clamped: a deadline past Node's timer range would fire at once instead of never.
    const deadlineMs = Math.min(MAX_TIMER_MS, background?.lifetimeMs ?? opts?.deadlineMs ?? this.scriptTimeoutMs);
    this.onWake = background?.onWake ?? null;
    const result = await new Promise<ExecResult>((resolve) => {
      const pending: PendingExec = {
        id: execId,
        resolve,
        deadlineTimer: null,
        killTimer: null,
        settled: false,
        deadlineMs: null,
      };
      this.pending = pending;

      pending.deadlineTimer = setTimeout(() => {
        pending.deadlineMs = deadlineMs;
        // Deadline: ask politely first (script sees CancelledError and its
        // exec_result still flows back), then kill on unresponsiveness.
        this.send({ op: 'cancel', id: execId, reason: 'deadline' });
        // The cancel lands only when the script awaits. Blocking code (time.sleep, a
        // busy loop, a blocking read) never does, so interrupt it as well: the runtime
        // raises KeyboardInterrupt in the script's own code, or schedules the
        // cancellation of a script that is waiting. Repeated, because a waiting script
        // can resume into blocking code before that cancellation runs; the runtime
        // ignores the repeats once the script was interrupted or cancelled.
        this.interruptChild();
        pending.interruptTimer = setInterval(() => this.interruptChild(), INTERRUPT_REPEAT_MS);
        pending.killTimer = setTimeout(() => {
          pending.deadlineMs = null; // this message already says why
          this.settlePending({
            stdout: '',
            stderr:
              `script stopped: it reached its ${formatLimit(deadlineMs)} time limit and did not respond, ` +
              'so it was killed and the interpreter restarted (variables from earlier scripts are gone)',
            returnCode: 1,
            aborted: true,
          });
          this.reclaim('deadline-kill');
        }, this.cancelGraceMs);
      }, deadlineMs);
      // A day-scale background deadline must not hold the process open.
      if (background) pending.deadlineTimer.unref?.();

      this.send({
        op: 'init',
        tools: tools.map((t) => ({ py_name: t.pyName, tool_name: t.toolName })),
        call_timeout_s: Math.round(this.toolCallTimeoutMs / 1000),
        ...(background
          ? { background: true, log_path: background.logPath ?? null }
          : {}),
      });
      this.send({ op: 'exec', id: execId, code });
    });

    this.onWake = null;
    if (!background) this.armIdleTimer();
    return result;
  }

  /**
   * Abort a running script (turn cancelled, agent reset/stopped). The
   * interpreter is reclaimed: after an abort its state is suspect (a script
   * died midway), and the next exec gets a fresh one.
   */
  abort(reason: string): void {
    if (!this.pending) return;
    this.send({ op: 'cancel', id: this.pending.id, reason });
    this.settlePending({
      stdout: '',
      stderr: `script aborted by host: ${reason}`,
      returnCode: 1,
      aborted: true,
    });
    this.reclaim(`abort: ${reason}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending) {
      this.settlePending({
        stdout: '',
        stderr: 'code_execution runner disposed',
        returnCode: 1,
        aborted: true,
      });
    }
    this.reclaim('dispose');
  }

  // -------------------------------------------------------------------------

  private async ensureChild(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.childReady ?? Promise.resolve();
    }
    this.teardownChild();

    this.runtimeDir = mkdtempSync(join(tmpdir(), 'af-pytc-'));
    const runtimePath = join(this.runtimeDir, 'runtime.py');
    writeFileSync(runtimePath, PYTHON_RUNTIME_SOURCE, 'utf8');

    const child = spawn(this.pythonPath, [runtimePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Outside an exec, python stderr is runtime diagnostics (crash
      // tracebacks etc.) — surface them in host logs.
      console.error(`[pytc:${this.label}] ${chunk.trimEnd()}`);
    });

    child.on('error', (err) => {
      // Spawn failure lands here (e.g. python3 missing); readiness rejects.
      console.error(`[pytc:${this.label}] python process error: ${err.message}`);
    });

    child.on('exit', (exitCode, signal) => {
      if (this.pending) {
        this.settlePending({
          stdout: '',
          stderr: `python runtime exited unexpectedly (code=${exitCode}, signal=${signal ?? 'none'})`,
          returnCode: 1,
          aborted: true,
        });
      }
      if (this.child === child) {
        this.teardownChild();
      }
    });

    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.handleLine(line, child));

    this.childReady = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onExit = () => {
        cleanup();
        reject(new Error('python runtime exited before becoming ready'));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('python runtime did not become ready within 15s'));
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timeout);
        this.readyResolver = null;
        child.off('exit', onExit);
        child.off('error', onError);
      };
      this.readyResolver = onReady;
      child.on('exit', onExit);
      child.on('error', onError);
    });
    return this.childReady;
  }

  private readyResolver: (() => void) | null = null;

  private handleLine(line: string, child: ChildProcessWithoutNullStreams): void {
    let msg: { op?: string; id?: string; name?: string; args?: unknown; stdout?: string; stderr?: string; return_code?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[pytc:${this.label}] non-protocol stdout line: ${line.slice(0, 200)}`);
      return;
    }

    switch (msg.op) {
      case 'ready':
        this.readyResolver?.();
        return;

      case 'tool_call': {
        const callId = msg.id;
        const toolName = msg.name;
        if (!callId || !toolName) return;
        const args =
          msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)
            ? (msg.args as Record<string, unknown>)
            : {};
        this.onToolCall(toolName, args)
          .catch((err) => `Error: ${err instanceof Error ? err.message : String(err)}`)
          .then((result) => {
            this.reply(child, { op: 'tool_result', id: callId, result }, `result of ${toolName} call ${callId}`);
          });
        return;
      }

      case 'wake': {
        const wakeId = msg.id;
        if (!wakeId) return;
        const line = typeof (msg as { line?: unknown }).line === 'number'
          ? (msg as { line: number }).line
          : -1;
        const payload = (msg as { payload?: unknown }).payload;
        const handler = this.onWake;
        const refuse = handler
          ? handler(line, payload).catch((err: unknown) =>
              `wake handler failed: ${err instanceof Error ? err.message : String(err)}`)
          : Promise.resolve('this script is not allowed to wake the agent');
        void refuse.then((error) => {
          this.reply(child, { op: 'wake_ack', id: wakeId, ...(error ? { error } : {}) }, `ack of wake ${wakeId}`);
        });
        return;
      }

      case 'exec_result': {
        if (this.pending && msg.id === this.pending.id) {
          this.settlePending({
            stdout: msg.stdout ?? '',
            stderr: msg.stderr ?? '',
            returnCode: typeof msg.return_code === 'number' ? msg.return_code : 1,
            ...(typeof (msg as { tail?: unknown }).tail === 'string'
              ? { tail: (msg as { tail: string }).tail }
              : {}),
          });
        }
        return;
      }

      default:
        console.error(`[pytc:${this.label}] unknown protocol op: ${String(msg.op)}`);
    }
  }

  private settlePending(result: ExecResult): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    // Say why the script stopped: the in-script cancellation only reads "cancelled by host".
    // Only a script that ended unsuccessfully was stopped: one that caught the cancellation
    // and finished its work returns 0, and must not read as stopped.
    if (pending.deadlineMs !== null && result.returnCode !== 0) {
      const note = `script stopped: it reached its ${formatLimit(pending.deadlineMs)} time limit\n`;
      // A background script reports its output tail, so the note goes there too.
      result = { ...result, stderr: result.stderr + note, ...(result.tail !== undefined ? { tail: result.tail + note } : {}) };
    }
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    if (pending.killTimer) clearTimeout(pending.killTimer);
    if (pending.interruptTimer) clearInterval(pending.interruptTimer);
    this.pending = null;
    pending.resolve(result);
  }

  /**
   * Answer the interpreter that asked. Call and wake ids restart in every
   * interpreter, so an answer that outlives its interpreter (the script was
   * aborted, killed or crashed, or the interpreter reclaimed) would resolve
   * the same id in the one that replaced it, inside another script: drop it.
   */
  private reply(child: ChildProcessWithoutNullStreams, msg: unknown, what: string): void {
    if (child !== this.child) {
      console.error(`[pytc:${this.label}] dropped late ${what}: the interpreter that asked for it is gone`);
      return;
    }
    this.send(msg);
  }

  private send(obj: unknown): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    try {
      child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      console.error(
        `[pytc:${this.label}] protocol write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * SIGINT the interpreter: blocking code in the running script raises
   * KeyboardInterrupt. Not on Windows, where Node's kill() ends the process
   * outright; there the cancel op and the kill grace remain.
   * process.kill rather than child.kill, which would mark the child `killed`:
   * a killed child gets no more protocol messages and is respawned on the
   * next exec, losing the interpreter state this keeps.
   */
  private interruptChild(): void {
    const child = this.child;
    if (process.platform === 'win32' || !child || child.exitCode !== null || child.killed) return;
    if (child.pid === undefined) return;
    try {
      process.kill(child.pid, 'SIGINT');
    } catch {
      // already gone: the exit handler settles the exec
    }
  }

  /** Kill interpreter + clean temp dir. State is lost (by design). */
  private reclaim(reason: string): void {
    if (this.child) {
      console.error(`[pytc:${this.label}] reclaiming python interpreter (${reason})`);
    }
    this.teardownChild();
    this.clearIdleTimer();
  }

  private teardownChild(): void {
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      this.childReady = null;
      this.readyResolver = null;
      child.removeAllListeners('exit');
      try {
        child.stdin.end();
      } catch {
        // stream may already be destroyed
      }
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }
    if (this.runtimeDir) {
      try {
        rmSync(this.runtimeDir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best-effort
      }
      this.runtimeDir = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleReclaimMs <= 0 || !this.child) return;
    this.idleTimer = setTimeout(() => {
      if (!this.pending) this.reclaim('idle');
    }, this.idleReclaimMs);
    // Do not hold the process open just to reclaim an idle interpreter.
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * Map framework tool names to python identifiers: `--` (the framework's
 * prefix separator) becomes `__`, and every remaining character that is not
 * valid in a python identifier becomes `_` (fleet reality: module and server
 * ids contain single hyphens — `mcpl-admin`, `dog-events` — found live on
 * the first canary run, 2026-07-26). A leading digit gets a `_` prefix.
 *
 * Names that sanitize to nothing, or that collide after sanitization, are
 * skipped loudly — a skipped tool is unreachable from scripts (the
 * exact-name tools[...] dict is built from this same list).
 */
export function buildInjectedTools(
  toolNames: string[],
  log: (message: string) => void = (m) => console.error(m),
): InjectedTool[] {
  const seen = new Map<string, string>();
  const injected: InjectedTool[] = [];
  for (const toolName of toolNames) {
    let pyName = toolName.replace(/--/g, '__').replace(/[^A-Za-z0-9_]/g, '_');
    if (/^[0-9]/.test(pyName)) pyName = '_' + pyName;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pyName)) {
      log(`[pytc] tool '${toolName}' skipped: cannot derive a python identifier`);
      continue;
    }
    const existing = seen.get(pyName);
    if (existing) {
      log(`[pytc] tool '${toolName}' skipped: python name '${pyName}' collides with '${existing}'`);
      continue;
    }
    seen.set(pyName, toolName);
    injected.push({ pyName, toolName });
  }
  return injected;
}
