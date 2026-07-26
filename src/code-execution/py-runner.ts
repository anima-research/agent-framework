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
 * hang the agent turn (cancel -> grace -> SIGKILL -> respawn) and a crashed
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

interface PendingExec {
  id: string;
  resolve: (result: ExecResult) => void;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export class PyRunner {
  private readonly pythonPath: string;
  private readonly toolCallTimeoutMs: number;
  private readonly scriptTimeoutMs: number;
  private readonly idleReclaimMs: number;
  private readonly onToolCall: ScriptToolCallHandler;
  private readonly label: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private childReady: Promise<void> | null = null;
  private reader: Interface | null = null;
  private runtimeDir: string | null = null;
  private pending: PendingExec | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private execCounter = 0;
  private disposed = false;

  constructor(options: PyRunnerOptions) {
    this.pythonPath = options.pythonPath ?? 'python3';
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.scriptTimeoutMs = options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    this.idleReclaimMs = options.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS;
    this.onToolCall = options.onToolCall;
    this.label = options.label ?? 'pytc';
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * Run one script. Tools are (re-)injected before every exec so the
   * interpreter always reflects the current tool surface (list_changed etc.).
   * Never rejects: every failure mode resolves to an ExecResult.
   */
  async exec(code: string, tools: InjectedTool[]): Promise<ExecResult> {
    if (this.disposed) {
      return { stdout: '', stderr: 'code_execution runner disposed', returnCode: 1, aborted: true };
    }
    if (this.pending) {
      return {
        stdout: '',
        stderr: 'RuntimeError: another code_execution script is already running for this agent',
        returnCode: 1,
        aborted: true,
      };
    }
    this.clearIdleTimer();

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
    }

    const execId = `e${++this.execCounter}`;
    const result = await new Promise<ExecResult>((resolve) => {
      const pending: PendingExec = {
        id: execId,
        resolve,
        deadlineTimer: null,
        killTimer: null,
        settled: false,
      };
      this.pending = pending;

      pending.deadlineTimer = setTimeout(() => {
        // Deadline: ask politely first (script sees CancelledError and its
        // exec_result still flows back), then kill on unresponsiveness.
        this.send({ op: 'cancel', id: execId, reason: 'deadline' });
        pending.killTimer = setTimeout(() => {
          this.settlePending({
            stdout: '',
            stderr: `script killed after exceeding ${Math.round(this.scriptTimeoutMs / 1000)}s deadline`,
            returnCode: 1,
            aborted: true,
          });
          this.reclaim('deadline-kill');
        }, CANCEL_GRACE_MS);
      }, this.scriptTimeoutMs);

      this.send({
        op: 'init',
        tools: tools.map((t) => ({ py_name: t.pyName, tool_name: t.toolName })),
        call_timeout_s: Math.round(this.toolCallTimeoutMs / 1000),
      });
      this.send({ op: 'exec', id: execId, code });
    });

    this.armIdleTimer();
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
    this.reader.on('line', (line) => this.handleLine(line));

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

  private handleLine(line: string): void {
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
            this.send({ op: 'tool_result', id: callId, result });
          });
        return;
      }

      case 'exec_result': {
        if (this.pending && msg.id === this.pending.id) {
          this.settlePending({
            stdout: msg.stdout ?? '',
            stderr: msg.stderr ?? '',
            returnCode: typeof msg.return_code === 'number' ? msg.return_code : 1,
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
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    if (pending.killTimer) clearTimeout(pending.killTimer);
    this.pending = null;
    pending.resolve(result);
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
