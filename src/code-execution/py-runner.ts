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
 *
 * The protocol runs on the interpreter's fds 3 (host -> py) and 4 (py -> host);
 * its fd 0 is /dev/null, and the host reads its fds 1 and 2 itself (see
 * OutputStream), so what a script and the commands it runs write to them
 * reaches the host whatever then happens to the interpreter.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildChildEnv } from '../mcpl/transport.js';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { boundedErrorMessage } from '../error-message.js';
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
  /** Absolute path for the stdout+stderr journal, which the runner appends to as the output arrives (null: tail only). */
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

/**
 * An inner tool call's result as the script gets it. `text` is the string
 * its await returns, and the runner sets `.is_error` on that string from
 * `isError`. With `structuredJson`, `text` is the JSON object a structured
 * result reaches a script as, in any of its forms, and `.structured` reads
 * its `structuredContent`, None for a form that holds none, such as one past
 * the size cap; without it, `.structured` is None.
 */
export interface ScriptToolResult {
  text: string;
  isError: boolean;
  structuredJson?: boolean;
}

/**
 * Resolves inner tool calls. Must never reject — map errors to results; a
 * rejection reaches the script as an `Error: …` result. A plain string is
 * the result's text with nothing said about it, so the script's
 * `.is_error` and `.structured` are None.
 */
export type ScriptToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string | ScriptToolResult>;

export interface PyRunnerOptions {
  /** Python to spawn (default 'python3'). A wrapper must pass fds 3 and 4 on, where the protocol runs (see CodeExecutionConfig). */
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
  /** Variables for the interpreter beyond what it inherits, such as
   *  PYTHONPATH or a venv's. It inherits only what stdio MCPL children do
   *  (CHILD_ENV_ALLOWLIST and LC_*, CA bundles and proxy variables among
   *  them, and a proxy URL can carry credentials), then these, then
   *  PYTHONUNBUFFERED and PYTHONIOENCODING, which the runner sets last.
   *  Like the allowlist, this limits what the model's code inherits, not
   *  what a process running as the same user can read. */
  env?: Record<string, string>;
  /** Pass the host's whole environment instead of the allowlist, as before
   *  `env` existed. That hands every host variable, provider keys included,
   *  to the model's code and to every subprocess a script starts; listing
   *  what scripts need in `env` is the safer route. */
  inheritEnv?: boolean;
}

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 270_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_RECLAIM_MS = 300_000;
const CANCEL_GRACE_MS = 10_000;
/** After the deadline, SIGINT is repeated at this interval until the script reports or is killed. */
const INTERRUPT_REPEAT_MS = 200;
/** Each of a script's stdout and stderr is kept up to this many characters in its result. */
const OUTPUT_CAP_CHARS = 2_000_000;
/** A background script's journal stops growing past this many bytes. */
const LOG_FILE_CAP_BYTES = 50_000_000;
/** How much of a background script's output its result keeps, for the envelope that tells the agent how it ended. */
const TAIL_CHARS = 4000;
/**
 * How long an interpreter that exited unexpectedly gets for the last of what it
 * wrote, its output and its messages, to arrive when something still holds its
 * pipes open, such as a command its script left running; otherwise their end
 * says it has all arrived.
 */
const EXIT_OUTPUT_GRACE_MS = 200;
/** How long a message failing to reach an interpreter waits for the interpreter's own exit before the host ends it as one that stopped reading. */
const UNREACHABLE_GRACE_MS = 200;
/** How much of what an interpreter wrote before it failed to start, or crashed, goes into the message and the host's log, and how much of each piece of output with no script running goes into the log. */
const LAST_WORDS_CHARS = 2000;
/**
 * How much of the host's log a pipe's output takes while no script of its
 * interpreter runs, from the start of its last exec, or its own start: lines
 * of up to 65,536 characters in all, counted as UTF-16 code units, each piece
 * cut at LAST_WORDS_CHARS, enough to see what a command a script left running
 * is doing. The rest is dropped.
 */
const IDLE_LOG_CHARS = 65_536;
/**
 * How fast the host reads the pipes of an interpreter it has torn down, which
 * a command a script left running may still hold. It goes on reading, so such
 * a command isn't ended by a broken pipe, and one writing far under this, as a
 * dev server's log does, never waits; one that writes without end slows to
 * this, rather than costing the host a core for as long as it runs. A live
 * interpreter's pipes are read at full speed, so what such a command writes
 * between scripts is read as it's written, and the idle reclaim bounds how
 * long that lasts, unless a host turns the reclaim off.
 */
const IDLE_READ_BYTES_PER_SECOND = 1_048_576;
/** The runtime's exit when the host's channel, fds 3 and 4, didn't reach it: the host's configuration, which calling again doesn't change. 78 is sysexits' EX_CONFIG, which Python itself never exits with. */
const HOST_CHANNEL_MISSING_EXIT = 78;
/**
 * The runtime's exit when it ends itself (runtime-py.ts _fatal), after a line
 * that, when a script took one of its fds, says which. Read with that line, so
 * a script that prints such a line and ends any other way isn't taken for it.
 */
const RUNTIME_FATAL_EXIT = 70;

/** The longest delay Node's timers honour (~24.8 days); a longer one fires after ~1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A time limit for a message: "45s", "10 min", "2.5 h". */
export function formatLimit(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 7_200_000) return `${Math.round(ms / 6_000) / 10} min`;
  return `${Math.round(ms / 360_000) / 10} h`;
}

/** `line` after `text`, on a line of its own: a text that doesn't end with a newline gets one first. */
function onItsOwnLine(text: string, line: string): string {
  return (text === '' || text.endsWith('\n') ? text : `${text}\n`) + line;
}

/** Add a line of the runner's own to a background script's journal, on a line of its own. */
function writeLine(journal: Journal, line: string): void {
  journal.write(`${journal.tail === '' || journal.tail.endsWith('\n') ? '' : '\n'}${line}\n`);
}

/** Whether the child is still running: not exited, not ended by a signal, and not killed by us. */
function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

/**
 * All of `text` at the end of the file: a write the kernel cuts short, as at a
 * file-size limit, goes on from where it stopped, and one that fails throws.
 */
function writeAll(fd: number, text: string): void {
  const data = Buffer.from(text);
  for (let at = 0; at < data.length; ) {
    const n = writeSync(fd, data, at);
    // POSIX has a regular file take at least a byte of a write or fail it; a
    // write that took none would otherwise hold the host's event loop here.
    if (n === 0) throw new Error('the file took none of a write');
    at += n;
  }
}

/**
 * A background script's journal: the log file the agent can read with its own
 * tools while the script runs, and the tail its result carries. It's written
 * synchronously, from the host's event loop, so a workspace whose writes block
 * holds the host while they do.
 */
class Journal {
  private fd: number | null = null;
  private written = 0;
  private capped = false;
  tail = '';

  constructor(
    path: string | null,
    private readonly log: (text: string) => void,
  ) {
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.fd = openSync(path, 'a');
    } catch (err) {
      log(`cannot open log file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  write(text: string): void {
    if (text === '') return;
    this.tail = (this.tail + text).slice(-TAIL_CHARS);
    if (this.fd === null || this.capped) return;
    const bytes = Buffer.byteLength(text);
    try {
      if (this.written + bytes > LOG_FILE_CAP_BYTES) {
        this.capped = true;
        writeAll(this.fd, `\n[log capped at ${LOG_FILE_CAP_BYTES} bytes]\n`);
      } else {
        writeAll(this.fd, text);
        this.written += bytes;
      }
    } catch (err) {
      // A journal that can't be written to still keeps its tail.
      this.log(`cannot write the log file any more: ${err instanceof Error ? err.message : String(err)}`);
      this.close();
    }
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // already gone
    }
    this.fd = null;
  }
}

const NOTHING = Buffer.alloc(0);

/** The first n UTF-16 code units of s, short of a surrogate pair the cut would split. */
function cutWhole(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * One of the interpreter's output pipes, its fd 1 or fd 2, as the host reads it.
 * While an exec runs, what arrives before that exec's end mark is the exec's:
 * kept for its result, up to OUTPUT_CAP_CHARS, or written to a background
 * script's journal. The mark itself is cut out. What arrives while no exec of
 * its interpreter runs, such as what a command a script left running writes,
 * goes to the host's log as it arrives, both while the interpreter lives and
 * after it has ended, up to IDLE_LOG_CHARS between scripts; once the runner
 * has torn the interpreter down, it's read at IDLE_READ_BYTES_PER_SECOND at
 * most (retire).
 */
export class OutputStream {
  /** Every process holding the pipe has closed it, so nothing more will come. */
  ended = false;
  /** The running exec's mark has arrived, so all of its output on this pipe has. */
  marked = false;
  /** The end of what arrived while no exec ran: an interpreter that failed to start says why here. */
  lastIdle = '';
  /** Whether lastIdle lost its beginning to the LAST_WORDS_CHARS cut. */
  lastIdleCut = false;
  private mark: Buffer | null = null;
  /** The end of a chunk that could be the start of a mark the next chunk completes. */
  private carry: Buffer = NOTHING;
  private readonly decoder = new StringDecoder('utf8');
  private text = '';
  private truncated = false;
  private journal: Journal | null = null;
  private onEnd: (() => void)[] = [];
  /** How many characters of log lines output with no script running has taken since this pipe's last exec began: IDLE_LOG_CHARS at most. */
  private idleLogged = 0;
  /** Set once the runner has torn its interpreter down: nothing reads this pipe for an exec again. */
  private retired = false;
  /** The wait that holds a retired pipe back (slow). */
  private resumer: ReturnType<typeof setTimeout> | null = null;
  /** Bytes read since the last wait was set, which the next one charges (slow). */
  private owed = 0;

  constructor(
    private readonly name: 'stdout' | 'stderr',
    private readonly pipe: Readable,
    private readonly log: (text: string) => void,
    private readonly onMarked: () => void,
  ) {
    pipe.on('data', (chunk: Buffer) => this.push(chunk));
    const ended = () => {
      if (this.ended) return;
      this.ended = true;
      for (const fn of this.onEnd.splice(0)) fn();
    };
    pipe.on('end', ended);
    pipe.on('close', ended);
    pipe.on('error', (err) => {
      log(`reading the python runtime's ${name} failed: ${err.message}`);
      ended();
    });
  }

  /** Begin an exec's share of the pipe, which its mark ends. */
  begin(mark: Buffer, journal: Journal | null): void {
    // A character that output with no script running left half-written is
    // that output's, not this exec's.
    this.logIdle(this.decoder.end());
    // The stretch with no script running that follows this exec logs a share
    // of its own.
    this.idleLogged = 0;
    this.mark = mark;
    this.marked = false;
    this.journal = journal;
    this.text = '';
    this.truncated = false;
  }

  /** The exec's share as it stands, with a note if it was cut at the cap; what arrives next goes to the log. */
  take(): string {
    if (this.mark !== null) {
      // Settled before its mark came (a kill, an abort or a crash): what arrived counts.
      this.keep(this.carry);
      this.carry = NOTHING;
      this.keep(this.decoder.end());
    }
    const text = this.text + (this.truncated ? `\n[${this.name} truncated at ${OUTPUT_CAP_CHARS} chars]` : '');
    this.mark = null;
    this.journal = null;
    this.text = '';
    this.truncated = false;
    return text;
  }

  /** Run fn once the pipe has ended (at once if it has). */
  whenEnded(fn: () => void): void {
    if (this.ended) fn();
    else this.onEnd.push(fn);
  }

  private push(chunk: Buffer): void {
    let bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = NOTHING;
    if (this.mark !== null) {
      const at = bytes.indexOf(this.mark);
      if (at < 0) {
        // Hold back only an end that could be the mark's start, so a
        // background script's journal keeps up with its output.
        const hold = markStartAtEnd(bytes, this.mark);
        this.keep(bytes.subarray(0, bytes.length - hold));
        this.carry = bytes.subarray(bytes.length - hold);
        return;
      }
      this.keep(bytes.subarray(0, at));
      this.keep(this.decoder.end());
      bytes = bytes.subarray(at + this.mark.length);
      this.mark = null;
      this.marked = true;
      this.onMarked();
    }
    if (bytes.length > 0) {
      const text = this.decoder.write(bytes);
      const idle = this.lastIdle + text;
      if (idle.length > LAST_WORDS_CHARS) {
        this.lastIdleCut = true;
        // A cut between a surrogate pair's halves would leave its low half, which reads as U+FFFD.
        const kept = idle.slice(-LAST_WORDS_CHARS);
        this.lastIdle = /^[\uDC00-\uDFFF]/.test(kept) ? kept.slice(1) : kept;
      } else {
        this.lastIdle = idle;
      }
      this.logIdle(text);
      if (this.retired) this.slow(bytes.length);
    }
  }

  /** The runner has torn its interpreter down: read what still comes at IDLE_READ_BYTES_PER_SECOND at most. */
  retire(): void {
    this.retired = true;
  }

  /**
   * Log output that arrived while no exec of this pipe's interpreter ran, each
   * piece up to LAST_WORDS_CHARS, in lines of IDLE_LOG_CHARS in all since the
   * pipe's last exec began, the last cut to fit. Each line is charged its
   * whole length, so many small writes can't take more of the log.
   */
  private logIdle(text: string): void {
    const shown = text.trimEnd();
    if (this.idleLogged >= IDLE_LOG_CHARS || shown.trim() === '') return;
    const head = `${this.name} while its interpreter runs no script: `;
    const kept = cutWhole(shown, LAST_WORDS_CHARS);
    const piece = kept.length < shown.length ? `${kept} [… ${shown.length - kept.length} more characters]` : shown;
    const fits = IDLE_LOG_CHARS - this.idleLogged - head.length;
    if (fits > 0) {
      const line = head + cutWhole(piece, fits);
      this.idleLogged += line.length;
      this.log(line);
    }
    if (fits <= piece.length) {
      this.idleLogged = IDLE_LOG_CHARS;
      this.log(`${head}past ${IDLE_LOG_CHARS} characters of the log, so the host drops what follows while its interpreter runs no script`);
    }
  }

  /**
   * Hold the pipe back for as long as these bytes take at
   * IDLE_READ_BYTES_PER_SECOND, then read on. Something else can resume the
   * pipe during a wait, as Node does with a child's stdio when the child
   * exits, so each piece holds it back again, and what came during a wait
   * waits its own time once that wait ends.
   */
  private slow(bytes: number): void {
    this.pipe.pause();
    this.owed += bytes;
    if (this.resumer === null) this.wait();
  }

  private wait(): void {
    const ms = Math.ceil((this.owed * 1000) / IDLE_READ_BYTES_PER_SECOND);
    this.owed = 0;
    this.resumer = setTimeout(() => {
      this.resumer = null;
      if (this.owed > 0) this.wait();
      else this.pipe.resume();
    }, ms);
    // A command left running doesn't keep the host's process alive.
    this.resumer.unref();
  }

  /** Keep what arrived for the running exec. */
  private keep(part: Buffer | string): void {
    const text = typeof part === 'string' ? part : this.decoder.write(part);
    if (text === '') return;
    if (this.journal) {
      this.journal.write(text);
      return;
    }
    if (this.truncated) return;
    const room = OUTPUT_CAP_CHARS - this.text.length;
    if (text.length <= room) {
      this.text += text;
      return;
    }
    this.text += text.slice(0, room);
    this.truncated = true;
  }
}

/** How many bytes at the end of `bytes` could be the start of `mark`. */
function markStartAtEnd(bytes: Buffer, mark: Buffer): number {
  for (let n = Math.min(bytes.length, mark.length - 1); n > 0; n--) {
    if (bytes.subarray(bytes.length - n).equals(mark.subarray(0, n))) return n;
  }
  return 0;
}

/** Run fn once the readable has ended (at once if it has). */
function whenReadableEnded(stream: Readable, fn: () => void): void {
  if (stream.readableEnded || stream.destroyed) {
    fn();
    return;
  }
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    fn();
  };
  stream.once('end', once);
  stream.once('close', once);
}

/**
 * Run fn once an exited interpreter's output pipes and its messages' pipe have
 * all ended, which says the last of what it wrote has arrived, or else after
 * EXIT_OUTPUT_GRACE_MS, if something, such as a command its script left
 * running, still holds them, and one more round of the event loop's reads, so
 * what had already arrived is read first even when the host's loop was busy
 * past the grace.
 */
function afterOutputEnds(stdout: OutputStream, stderr: OutputStream, messages: Readable | null, fn: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fn();
  };
  const timer = setTimeout(() => setImmediate(finish), EXIT_OUTPUT_GRACE_MS);
  stdout.whenEnded(() => stderr.whenEnded(() => (messages ? whenReadableEnded(messages, finish) : finish())));
}

/**
 * What a script stopped at its time limit is told after why: that the tool
 * calls it made keep their effects, and whether a longer limit can help,
 * which only the deployment's ceiling for its kind of script can say. A
 * foreground script at its ceiling is offered background mode too, when its
 * caller passes `backgroundCeilingMs` (the framework does for an agent that
 * could start a background script as the script starts) and a background
 * script may run longer.
 */
function limitRemedy(limitMs: number, ceilingMs: number | undefined, background: boolean, backgroundCeilingMs?: number): string {
  const effects = 'Tool calls it had already made keep their effects, so check them before running it again.';
  if (ceilingMs === undefined) return effects;
  if (limitMs < ceilingMs) return `${effects} To give it longer, ${background ? 'start it with' : 'pass'} time_limit_ms up to ${ceilingMs} (${formatLimit(ceilingMs)}).`;
  if (background) return `${effects} ${formatLimit(limitMs)} is the longest a background script runs here; starting it again runs it from the top.`;
  const inBackground = backgroundCeilingMs !== undefined && backgroundCeilingMs > limitMs
    ? `, or run it with background: true, where a script can run up to ${formatLimit(backgroundCeilingMs)}` : '';
  return `${effects} ${formatLimit(limitMs)} is the longest a script can run here, so split the work across shorter scripts${inBackground}.`;
}

/**
 * Why a script didn't run when its interpreter didn't start. A spawn that
 * found nothing it could run (ENOENT, EACCES) fails the same way until the
 * host changes, so that one says code_execution can't run here rather than
 * to try again. A failure before the spawn, while creating or writing the
 * runtime's files, is about those files rather than the interpreter, and
 * keeps Node's own text, which names the path for an open or a mkdtemp. An
 * interpreter that exits as it starts passes on up to the last LAST_WORDS_CHARS
 * of what it wrote to stderr, from the end, where a traceback says what failed,
 * and with "…" where they're cut; when the runtime itself exits so because
 * the host's channel didn't reach it (HOST_CHANNEL_MISSING_EXIT), its own
 * words say who must act and that calling again fails the same way, so they
 * end the text.
 */
function startFailure(pythonPath: string, err: unknown): string {
  const { code, syscall, exitCode, said } = (err ?? {}) as { code?: unknown; syscall?: unknown; exitCode?: unknown; said?: unknown };
  const spawning = typeof syscall === 'string' && syscall.startsWith('spawn');
  if (spawning && (code === 'ENOENT' || code === 'EACCES')) {
    const until = code === 'ENOENT' ? 'installs it or points this host at one' : 'makes it executable or points this host at another';
    return `script didn't run: this host can't start its Python interpreter, ${pythonPath} (${code}), so code_execution can't run scripts here until whoever runs this host ${until}. Calling it again before then fails the same way.`;
  }
  if (typeof syscall === 'string' && !spawning) {
    return `script didn't run: this host couldn't create or write the files its Python runtime starts from (${boundedErrorMessage(err)}), so none of the script ran. Run it again; if it fails the same way, ask whoever runs this host.`;
  }
  const wrote = typeof said === 'string' ? said : '';
  // The runtime's own words say who must act, and that calling again fails the same way.
  if (exitCode === HOST_CHANNEL_MISSING_EXIT && wrote !== '') {
    return `script didn't run: the Python interpreter, ${pythonPath}, exited as it started, saying: ${wrote}`;
  }
  const why = typeof code === 'string' ? `couldn't be started (${code})` : boundedErrorMessage(err);
  return `script didn't run: the Python interpreter, ${pythonPath}, ${why}, so none of the script ran. Run it again; if it fails the same way, ask whoever runs this host.`
    + (wrote === '' ? '' : ` It wrote to stderr: ${wrote}`);
}

/** Why a script stopped when its interpreter stopped reading the host's messages, so that the host ended it. */
function stoppedReading(background: boolean): string {
  return "script stopped: the Python interpreter stopped reading the host's messages, so the host ended it and the rest of the script didn't run"
    + `${background ? '' : ', and variables from earlier scripts are gone'}. Tool calls it had already made keep their effects, `
    + 'so check them before you run it again in a new interpreter. If it stops the same way, check whether the script closes, '
    + "shuts down or replaces file descriptor 3, where the host's messages arrive; if not, ask whoever runs this host.";
}

/** The signals faulthandler writes a traceback for (runtime-py.ts), which a crash ends a process with. */
const CRASH_SIGNALS: ReadonlySet<string> = new Set(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL']);

/** How faulthandler's traceback for a crash's signal begins. */
const CRASH_TRACEBACK = 'Fatal Python error: ';

/**
 * Why a script stopped when its interpreter exited under it, and what running it
 * again does; or, when the script's result came before the exit (ended), that
 * the script ran to its end and what of its output the exit may have cost.
 */
function interpreterExit(exitCode: number | null, signal: NodeJS.Signals | null, background: boolean, said = '', ended = false): string {
  const how = signal ? `was ended by ${signal}` : `exited with code ${exitCode}`;
  // The runtime ends itself (_fatal) with code 70 after a line saying which of its fds a script took,
  // or shut down the socket under. The line reaches the host unless the script took both the runtime's
  // copy of fd 2 and fd 2 itself, or shut down the socket under them, and it's read from what the result
  // keeps, which past a stream's cap or a journal's tail lacks it.
  const taken = exitCode === RUNTIME_FATAL_EXIT ? fdTakenFromRuntime(said) : null;
  // After a crash's signal, faulthandler's traceback shows the call that crashed, in native code or the
  // script's own os.abort(), when it reached what the result keeps: a script can disable faulthandler,
  // and a stream's cap or a journal's tail can lose it. Its first words are looked for anywhere, not
  // only at a line's start: faulthandler doesn't start a line, so after output that didn't end one,
  // such as a progress bar's, they follow on that line. SIGKILL is the out-of-memory killer's; any
  // other signal, the script can send itself.
  const check = taken
    ? `check whether the script closes, shuts down or replaces ${taken}, as the runtime's line above says`
    : signal && CRASH_SIGNALS.has(signal)
      ? said.includes(CRASH_TRACEBACK)
        ? 'check the traceback above for the call that crashed in native code, such as an extension module the script uses'
        : 'check whether native code the script calls crashes, such as an extension module it uses'
      : `check whether the script itself ends the process, for example ${
        signal === 'SIGKILL' ? 'by using too much memory' : signal ? 'with os.kill()' : 'with os._exit()'}`;
  const gone = background ? '' : ', and variables from earlier scripts are gone';
  if (ended) {
    return `script ended, but the Python interpreter ${how} before all of its output reached the host, so some of it may be missing${gone}. `
      + `If it happens again, ${check}; if not, ask whoever runs this host.`;
  }
  return `script stopped: the Python interpreter ${how} while it ran, so the rest of the script didn't run${gone}. `
    + 'Tool calls it had already made keep their effects, so check them before you run it again in a new interpreter. '
    + `If it stops the same way, ${check}; if not, ask whoever runs this host.`;
}

/** The file descriptor the runtime's last line of its own says a script took from it (runtime-py.ts _lost), if it says so. */
function fdTakenFromRuntime(said: string): string | null {
  let taken: string | null = null;
  for (const m of said.matchAll(/\[pytc-runtime\] [^\n]*: a script closed, shut down or replaced ((?:the runtime's copy of )?fd \d)[^\n]*; exiting/g)) {
    taken = m[1];
  }
  return taken;
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
  /** The longest limit this exec could have had (exec's opts): whether a longer one would help. */
  ceilingMs: number | undefined;
  /** For a foreground exec, the longest a background script may run (exec's opts): whether background mode would help. */
  backgroundCeilingMs: number | undefined;
  /** A background exec has its interpreter to itself, so no earlier script's state is lost with it. */
  background: boolean;
  /** Set once the script went to the interpreter. Before that, the exec is
   *  waiting for the interpreter to start, and an interpreter that exits then
   *  failed to start (see exec). */
  sent: boolean;
  /** A background exec's journal, which its output goes to instead of its result. */
  journal: Journal | null;
  /** The script's return code, once the interpreter has reported it; the exec
   *  settles when its output's end marks have arrived too. */
  returnCode: number | null;
  /** Set when the host settled the exec itself (stopPending), rather than its result and marks. */
  stopped?: true;
}

/** Interpreters started in this process, by every runner: each one's number. */
let interpretersStarted = 0;

/**
 * The interpreter to spawn. A bare name is looked up on PATH. A path with a
 * separator is resolved against the host's working directory, where it
 * resolved before the interpreter got a working directory of its own: spawn
 * would resolve it against the runtime directory instead.
 */
function spawnablePath(pythonPath: string): string {
  const hasSeparator = pythonPath.includes('/') || (process.platform === 'win32' && pythonPath.includes('\\'));
  return hasSeparator ? resolve(pythonPath) : pythonPath;
}

export class PyRunner {
  private readonly pythonPath: string;
  private readonly toolCallTimeoutMs: number;
  private readonly scriptTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly idleReclaimMs: number;
  private readonly onToolCall: ScriptToolCallHandler;
  private readonly label: string;
  private readonly envOptions: { env?: Record<string, string>; inheritEnv?: boolean };

  private onWake: ((line: number, payload: unknown) => Promise<string | null>) | null = null;
  private child: ChildProcess | null = null;
  private childReady: Promise<void> | null = null;
  /** The interpreter's fd 3, where the host's messages go. */
  private protoIn: Writable | null = null;
  /** Ends the interpreter whose fd 3 a message couldn't reach (see ensureChild). */
  private unreachable: ((why: string) => void) | null = null;
  /** Reads the interpreter's messages from its fd 4. */
  private reader: Interface | null = null;
  /** The interpreter's stdout and stderr, as the host reads them. */
  private out: OutputStream | null = null;
  private err: OutputStream | null = null;
  private runtimeDir: string | null = null;
  private pending: PendingExec | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private execCounter = 0;
  /** The number of this runner's latest interpreter (interpretersStarted). */
  private interpreterNumber = 0;
  private disposed = false;

  constructor(options: PyRunnerOptions) {
    this.pythonPath = options.pythonPath ?? 'python3';
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.scriptTimeoutMs = options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.idleReclaimMs = options.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS;
    this.onToolCall = options.onToolCall;
    this.label = options.label ?? 'pytc';
    // The interpreter runs model-authored code: the same env discipline as an
    // MCPL connector child (#175), for a child that deserves it more. Stored
    // as options, not a snapshot — the env is rebuilt at every spawn so a
    // respawn after idle reclaim sees current host values, as the old
    // per-spawn `{ ...process.env }` did.
    this.envOptions = { env: options.env, inheritEnv: options.inheritEnv };
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * The live interpreter, whose state (variables, imports, functions) the
   * scripts run in it share: a number no other interpreter in this process
   * has had, from any runner, or null while none is running, before the
   * first script or once it was reclaimed, killed or has exited.
   */
  get interpreter(): number | null {
    return this.child && this.child.exitCode === null && !this.child.killed ? this.interpreterNumber : null;
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
   * `opts.ceilingMs` is the longest limit the deployment allows this kind of
   * script: a script stopped at its limit is offered a longer one only below
   * it. Without it, the stop doesn't say whether a longer limit would help.
   * `opts.backgroundCeilingMs`, for a foreground exec, is the longest a
   * background script may run: one stopped at its ceiling is offered
   * background mode when that is longer.
   */
  async exec(
    code: string,
    tools: InjectedTool[],
    background?: BackgroundExecOptions,
    opts?: { deadlineMs?: number; ceilingMs?: number; backgroundCeilingMs?: number },
  ): Promise<ExecResult> {
    if (this.disposed) {
      return { stdout: '', stderr: 'code_execution runner disposed', returnCode: 1, aborted: true };
    }
    if (this.busy) {
      return {
        stdout: '',
        stderr: "script didn't run: another code_execution script of yours is already running, and they run one at a time. "
          + 'Run this one again once that one has finished, or combine the two into one script.',
        returnCode: 1,
        aborted: true,
      };
    }
    this.clearIdleTimer();

    // The exec claims the runner before the await: a same-tick second exec
    // sees it busy, and abort() or dispose() while the interpreter starts
    // settles this exec, whose script then never runs.
    let resolveResult!: (result: ExecResult) => void;
    const settled = new Promise<ExecResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending: PendingExec = {
      id: `e${++this.execCounter}`,
      resolve: resolveResult,
      deadlineTimer: null,
      killTimer: null,
      settled: false,
      deadlineMs: null,
      ceilingMs: opts?.ceilingMs,
      backgroundCeilingMs: opts?.backgroundCeilingMs,
      background: background !== undefined,
      sent: false,
      journal: null,
      returnCode: null,
    };
    this.pending = pending;
    try {
      await this.ensureChild();
    } catch (err) {
      // Settled already when an abort or dispose reclaimed the interpreter
      // as it started; another exec may have claimed the runner since.
      if (!pending.settled) {
        this.settlePending({
          stdout: '',
          stderr: startFailure(this.pythonPath, err),
          returnCode: 1,
          aborted: true,
        });
        this.reclaim('spawn-failed');
      }
      return settled;
    }
    if (pending.settled) return settled;

    const execId = pending.id;
    // Clamped: a deadline past Node's timer range would fire at once instead of never.
    const deadlineMs = Math.min(MAX_TIMER_MS, background?.lifetimeMs ?? opts?.deadlineMs ?? this.scriptTimeoutMs);
    this.onWake = background?.onWake ?? null;
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
        this.stopPending(
          `script stopped: it reached its ${formatLimit(deadlineMs)} time limit and did not respond, so it was killed` +
            (pending.background ? '. ' : ' and the interpreter restarted (variables from earlier scripts are gone). ') +
            limitRemedy(deadlineMs, pending.ceilingMs, pending.background, pending.backgroundCeilingMs),
        );
        this.reclaim('deadline-kill');
      }, this.cancelGraceMs);
    }, deadlineMs);
    // A day-scale background deadline must not hold the process open.
    if (background) pending.deadlineTimer.unref?.();

    // What the script writes, up to its mark, is this exec's: a background
    // script's goes to its journal.
    const mark = Buffer.from(`\x1epytc-end-${randomBytes(16).toString('hex')}\x1e`);
    pending.journal = background ? new Journal(background.logPath, (text) => this.log(text)) : null;
    this.out?.begin(mark, pending.journal);
    this.err?.begin(mark, pending.journal);
    pending.sent = true;
    this.send({
      op: 'init',
      tools: tools.map((t) => ({ py_name: t.pyName, tool_name: t.toolName })),
      call_timeout_s: Math.round(this.toolCallTimeoutMs / 1000),
      ...(background ? { background: true } : {}),
    });
    this.send({ op: 'exec', id: execId, code, mark: mark.toString('utf8') });

    const result = await settled;

    this.onWake = null;
    if (!background) this.armIdleTimer();
    return result;
  }

  /**
   * Abort the runner's script (its turn ended or is reset to run again, or the
   * agent was reset or stopped), whether it's running or still waiting for its
   * interpreter to start; a waiting script then never runs. The exec settles
   * at once, and the interpreter is reclaimed, a starting one too: after an
   * abort its state is suspect (a script died midway), and the next exec gets
   * a fresh one.
   */
  abort(reason: string): void {
    if (!this.pending) return;
    this.send({ op: 'cancel', id: this.pending.id, reason });
    this.stopPending(`script aborted by host: ${reason}`);
    this.reclaim(`abort: ${reason}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPending('code_execution runner disposed');
    this.reclaim('dispose');
  }

  // -------------------------------------------------------------------------

  private async ensureChild(): Promise<void> {
    if (this.child && alive(this.child)) {
      return this.childReady ?? Promise.resolve();
    }
    this.teardownChild();

    // Absolute, since the interpreter runs in it: from a relative TMPDIR,
    // runtime.py's path would otherwise resolve against the directory itself.
    this.runtimeDir = resolve(mkdtempSync(join(tmpdir(), 'af-pytc-')));
    const runtimePath = join(this.runtimeDir, 'runtime.py');
    writeFileSync(runtimePath, PYTHON_RUNTIME_SOURCE, 'utf8');

    const child = spawn(spawnablePath(this.pythonPath), [runtimePath], {
      // fd 0 is /dev/null, the host reads fds 1 and 2, and the protocol has 3 and 4.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      // The runtime directory, not the host's working directory: a script's
      // relative paths land here, and go at teardown, rather than beside the
      // host's .env and data. An absolute path still reaches the host's files.
      cwd: this.runtimeDir,
      // Set last, over a declared env. The host reads fds 1 and 2 as UTF-8.
      // The runtime's channel and a script's writers say UTF-8 themselves
      // (runtime-py.ts), but other Python writing there takes its encoding and
      // buffering from these: the interpreter's sys.stdout and sys.stderr
      // between scripts, which a thread a script left running prints through,
      // and any Python a script starts. So what it writes reaches the host as
      // it's written, and in UTF-8, where Python before 3.15 on Windows writes
      // a pipe in the ANSI code page unless told otherwise; a PYTHONUTF8 in
      // the host process's own environment reaches the interpreter only with
      // inheritEnv: true or declared in env.
      env: { ...buildChildEnv(this.envOptions), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    this.interpreterNumber = ++interpretersStarted;
    const protoIn = child.stdio[3] as Writable;
    const protoOut = child.stdio[4] as Readable;
    this.protoIn = protoIn;
    const stdout = new OutputStream('stdout', child.stdout as Readable, (text) => this.log(text), () => this.settleIfComplete(child));
    const stderr = new OutputStream('stderr', child.stderr as Readable, (text) => this.log(text), () => this.settleIfComplete(child));
    this.out = stdout;
    this.err = stderr;
    protoOut.on('error', (e) => this.log(`reading the python runtime's messages failed: ${e.message}`));

    // An interpreter that no longer reads the host's messages, as after a
    // script closes file descriptor 3, could go on running, and every later
    // message to it is lost: its exec would wait out its time limit. So when
    // a message can't reach it, it's ended, and its exit settles the exec. Such
    // a write fails after write() returns: the pipe refuses it, or has already
    // ended, its far end closed. Its error, which with no listener would be
    // thrown as an uncaught exception, is heard here too. An interpreter that
    // died on its own breaks the pipe the same way, as by dying with a message
    // unread, and its exit can be seen after the break: so the kill waits
    // UNREACHABLE_GRACE_MS and one more round of reads, and an interpreter that
    // exited by then is left to its own exit, which says what happened.
    let inputFailed = false;
    let killing = false;
    const unreachable = (why: string) => {
      // One the host has torn down already ended its pipe on purpose.
      if (child !== this.child || killing) return;
      this.log(`messages to the python runtime failed: ${why}`);
      killing = true;
      setTimeout(
        () =>
          setImmediate(() => {
            if (child === this.child && alive(child) && child.pid !== undefined) {
              inputFailed = true;
              child.kill('SIGKILL');
            }
          }),
        UNREACHABLE_GRACE_MS,
      );
    };
    this.unreachable = unreachable;
    protoIn.on('error', (e) => unreachable(e.message));

    child.on('error', (err) => {
      // Spawn failure lands here (e.g. python3 missing); readiness rejects.
      console.error(`[pytc:${this.label}] python process error: ${err.message}`);
    });

    child.on('exit', (exitCode, signal) => {
      // An exec still waiting for the interpreter is settled by exec, as a
      // runtime that failed to start.
      const pending = this.pending;
      if (!pending?.sent) {
        // One still starting is reported by its exec, as a failed start.
        if (!pending && this.child === child) {
          this.log(`python runtime exited while no script ran (code=${exitCode}, signal=${signal ?? 'none'}); the next script starts a new one`);
        }
        if (this.child === child) this.teardownChild();
        return;
      }
      const killedDeaf = inputFailed && signal === 'SIGKILL';
      // Why, from what arrived: the runtime's own exit names the fd it lost in its last line.
      const why = (said: string) =>
        killedDeaf
          ? stoppedReading(pending.background)
          : interpreterExit(exitCode, signal, pending.background, said, pending.returnCode !== null);
      // The host's log keeps the short form, with the exit's own code and signal.
      const logged = killedDeaf
        ? "python runtime stopped reading the host's messages, so it was killed"
        : `python runtime exited unexpectedly (code=${exitCode}, signal=${signal ?? 'none'})`;
      // What it wrote last, such as a fatal error's own text or an exec's
      // result, is already on its way through its pipes: settle once they've
      // ended, or after a short grace while a command it started still holds
      // them.
      afterOutputEnds(stdout, stderr, protoOut, () => {
        if (this.pending === pending) {
          const last = this.stopPending(why).trim();
          // A background script's last output is its journal's, both streams.
          const what = pending.journal ? 'the last it wrote' : 'the last it wrote to stderr';
          this.log(last ? `${logged}; ${what}: ${last.slice(-LAST_WORDS_CHARS)}` : logged);
        } else if (!pending.stopped) {
          // Its script's result and marks, already on their way, settled the
          // exec while the host waited: it exited as its script ended, whether
          // or not a next exec has replaced it since.
          this.log(`python runtime exited as its script ended (code=${exitCode}, signal=${signal ?? 'none'}); the next script starts a new one`);
        }
        if (this.child === child) this.teardownChild();
      });
    });

    this.reader = createInterface({ input: protoOut });
    this.reader.on('line', (line) => this.handleLine(line, child));
    // readline passes its input's error on to the interface, where with no
    // listener it would be thrown as an uncaught exception and end the host.
    // protoOut's own listener above logs it.
    this.reader.on('error', () => {});

    this.childReady = new Promise<void>((resolve, reject) => {
      let over = false;
      const finish = (outcome: () => void) => {
        if (over) return;
        over = true;
        clearTimeout(timeout);
        // Another interpreter may have started since this one exited.
        if (this.readyResolver === onReady) this.readyResolver = null;
        if (this.readyFailer === onError) this.readyFailer = null;
        child.off('exit', onExit);
        child.off('error', onError);
        outcome();
      };
      const onReady = () => finish(resolve);
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        // Why it ended, such as a traceback, is on its way through its stderr.
        // Its messages' pipe doesn't matter here, and the exit's teardown has
        // stopped reading it. A tail that lost its beginning says so.
        afterOutputEnds(stdout, stderr, null, () => {
          const tail = stderr.lastIdle.trim();
          const said = tail !== '' && stderr.lastIdleCut ? `…${tail}` : tail;
          const how = signal ? `was ended by ${signal} as it started` : 'exited as it started';
          finish(() => reject(Object.assign(new Error(how), { exitCode, said })));
        });
      };
      const onError = (e: Error) => finish(() => reject(e));
      const timeout = setTimeout(() => finish(() => reject(new Error("didn't start within 15 seconds"))), 15_000);
      this.readyResolver = onReady;
      this.readyFailer = onError;
      child.on('exit', onExit);
      child.on('error', onError);
    });
    return this.childReady;
  }

  private log(text: string): void {
    console.error(`[pytc:${this.label}] ${text}`);
  }

  private readyResolver: (() => void) | null = null;
  /** Fails the readiness of an interpreter that is still starting (see reclaim). */
  private readyFailer: ((err: Error) => void) | null = null;

  private handleLine(line: string, child: ChildProcess): void {
    let msg: { op?: string; id?: string; name?: string; args?: unknown; return_code?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`non-protocol line from the python runtime: ${line.slice(0, 200)}`);
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
          .catch((err): ScriptToolResult => ({
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }))
          .then((result) => {
            // Only an object is a ScriptToolResult. Anything else a handler
            // resolves with, a string or a value its type rules out, is sent
            // as it is, so the call is still answered.
            const reply = typeof result === 'object' && result !== null
              ? {
                op: 'tool_result',
                id: callId,
                result: result.text,
                is_error: result.isError,
                ...(result.structuredJson ? { structured_json: true } : {}),
              }
              : { op: 'tool_result', id: callId, result };
            this.reply(child, reply, `result of ${toolName} call ${callId}`);
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
        const pending = this.pending;
        if (pending && msg.id === pending.id && pending.returnCode === null) {
          pending.returnCode = typeof msg.return_code === 'number' ? msg.return_code : 1;
          this.settleIfComplete(child);
        }
        return;
      }

      default:
        this.log(`unknown protocol op: ${String(msg.op)}`);
    }
  }

  /**
   * Settle the running exec once its script has reported and the end marks
   * of both its output pipes have arrived, which says all of its output has.
   */
  private settleIfComplete(child: ChildProcess): void {
    const pending = this.pending;
    if (child !== this.child || !pending || pending.returnCode === null) return;
    if (!this.out?.marked || !this.err?.marked) return;
    const stdout = this.out.take();
    const stderr = this.err.take();
    const journal = pending.journal;
    if (journal) {
      this.settlePending({ stdout: '', stderr: '', returnCode: pending.returnCode, tail: journal.tail });
    } else {
      this.settlePending({ stdout, stderr, returnCode: pending.returnCode });
    }
  }

  /**
   * Settle the running exec now: what its script wrote so far, as far as it
   * has reached the host, then `why` it stopped, on a line of its own. Output
   * still in the pipes goes to the host's log. A script that reported before
   * its interpreter ended keeps its own return code. Returns what the script
   * wrote to stderr (a background script's tail), for the host's log.
   */
  private stopPending(reason: string | ((said: string) => string)): string {
    const pending = this.pending;
    if (!pending || pending.settled) return '';
    pending.stopped = true;
    const stdout = this.out?.take() ?? '';
    const stderr = this.err?.take() ?? '';
    const returnCode = pending.returnCode ?? 1;
    const journal = pending.journal;
    // The runtime's own lines are in a background script's journal. A foreground
    // script's are in its stderr, unless it pointed fd 2 at stdout's pipe and took
    // the runtime's copy of fd 2 (runtime-py.ts _diag): stderr goes last, as the
    // one the runtime writes to first, since the last line that names a fd counts.
    const why = typeof reason === 'string' ? reason : reason(journal ? journal.tail : `${stdout}\n${stderr}`);
    if (journal) {
      const tail = journal.tail;
      // The journal says why too: in its file, which the agent reads with its
      // own tools, when it has one that hasn't reached its cap or failed a
      // write, and in its tail, which the result carries.
      writeLine(journal, why);
      this.settlePending({ stdout: '', stderr: why, returnCode, aborted: true, tail: journal.tail });
      return tail;
    }
    this.settlePending({ stdout, stderr: onItsOwnLine(stderr, why), returnCode, aborted: true });
    return stderr;
  }

  private settlePending(result: ExecResult): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    // Say why the script stopped: the in-script cancellation only reads "cancelled by host".
    // Only a script that ended unsuccessfully was stopped: one that caught the cancellation
    // and finished its work returns 0, and must not read as stopped.
    if (pending.deadlineMs !== null && result.returnCode !== 0) {
      const note = `script stopped: it reached its ${formatLimit(pending.deadlineMs)} time limit. `
        + `${limitRemedy(pending.deadlineMs, pending.ceilingMs, pending.background, pending.backgroundCeilingMs)}\n`;
      // On a line of its own: a script's output, and the runner's own texts, such as an
      // interpreter's exit, can end without a newline.
      result = { ...result, stderr: onItsOwnLine(result.stderr, note) };
      // A background script's journal says so too: in its file, when it has one,
      // and in its tail, which is the result's.
      if (pending.journal) {
        writeLine(pending.journal, note.trimEnd());
        result = { ...result, tail: pending.journal.tail };
      }
    }
    // Only now: what the stop wrote above is the journal's last.
    pending.journal?.close();
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
  private reply(child: ChildProcess, msg: unknown, what: string): void {
    if (child !== this.child) {
      this.log(`dropped late ${what}: the interpreter that asked for it is gone`);
      return;
    }
    this.send(msg);
  }

  private send(obj: unknown): void {
    const child = this.child;
    const input = this.protoIn;
    const unreachable = this.unreachable;
    if (!child || !input || !alive(child)) return;
    try {
      input.write(JSON.stringify(obj) + '\n', (err) => {
        if (err) unreachable?.(err.message);
      });
    } catch (err) {
      this.log(`protocol write failed: ${err instanceof Error ? err.message : String(err)}`);
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
    if (process.platform === 'win32' || !child || !alive(child)) return;
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
      this.log(`reclaiming python interpreter (${reason})`);
    }
    // An interpreter killed as it starts never says it's ready: fail its
    // readiness now, so an exec waiting on it returns at once rather than at
    // the 15 s timeout. Here rather than in teardownChild, which an
    // interpreter's own exit also runs, so that one still reads "exited as
    // it started".
    this.readyFailer?.(new Error(`python runtime reclaimed (${reason}) before it was ready`));
    this.teardownChild();
    this.clearIdleTimer();
  }

  private teardownChild(): void {
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    const child = this.child;
    if (child) {
      const input = this.protoIn;
      this.child = null;
      this.childReady = null;
      this.readyResolver = null;
      this.readyFailer = null;
      this.protoIn = null;
      this.unreachable = null;
      // Its output pipes stay read, into the host's log, until whatever still
      // holds them, such as a command its script left running, closes them:
      // breaking them under such a command could end it. They're read slower
      // from now on, since nothing reads them for an exec again.
      this.out?.retire();
      this.err?.retire();
      this.out = null;
      this.err = null;
      child.removeAllListeners('exit');
      try {
        input?.end();
      } catch {
        // stream may already be destroyed
      }
      // A child whose spawn failed has no pid, and its exitCode stays null
      // until Node's 'error' for it, a tick later. A kill() in that tick, as
      // from an abort or dispose on the tick exec was called, signals no
      // child of ours but whatever pid Node's handle held: the host's own
      // process group on Node 20.20.2, another process's pid on 24.19.
      if (alive(child) && child.pid !== undefined) {
        child.kill('SIGKILL');
      }
    }
    const dir = this.runtimeDir;
    this.runtimeDir = null;
    if (dir) {
      const remove = (): void => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp cleanup is best-effort
        }
      };
      // The directory is the interpreter's working directory, which Windows
      // won't remove while the process lives, so there it goes once the
      // process has. Elsewhere it goes now, so a host that exits right after
      // this doesn't leave it behind. A child that never started has no exit
      // to wait for.
      const running = child !== null && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      if (running && process.platform === 'win32') child.once('exit', remove);
      else remove();
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
