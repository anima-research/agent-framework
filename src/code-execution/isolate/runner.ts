/**
 * The parent's side of one script: its child process, the calls it makes, its
 * output, and how it ends. One `ScriptRun` per script, and one child per run,
 * which ends with it, so nothing a script held stays after it.
 *
 * Every frame from the child is decoded and checked before the parent acts on
 * it, since the child is untrusted. A frame that breaks the protocol, a child
 * that exits without saying how the script ended, or one that doesn't stop
 * when asked, ends the run as crashed. A tool call goes to `onToolCall`, the
 * bridge to the framework's dispatcher, and its outcome goes into the run's
 * call record at dispatch, as running until it's answered.
 *
 * What the host holds for a script is bounded: at most MAX_CALLS_IN_FLIGHT of
 * its calls wait for answers at once, and at most MAX_CALLS_IN_FLIGHT are out
 * in the host, timed-out ones whose tools still run included, with any past
 * those waiting here as their text. Each call's arguments are within
 * MAX_ARGUMENT_BYTES and MAX_ARGUMENT_VALUES, and each answer is at most
 * `maxResultBytes`. Answers wait for the child as their frames, written while
 * its stdin takes them and after its 'drain' once it hasn't, so each is held
 * once, in bytes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { encodeFrame, encodeResultFrame, FrameDecoder, FrameError, RESULT_FRAME_OVERHEAD } from './frames.js';
import { MAX_BATCH_CHARS, WindowOutput, type OutputBounds, type OutputWindow } from './output.js';
import { WAKE_CALL_NAME, type PreludeTool } from './prelude.js';
import { CallLog, callBrief, type CallEntry, type CallOutcome, type CallSummary } from './calls.js';
import {
  argumentsRefusal,
  capText,
  MAX_CHILD_FRAME_BYTES,
  decodeChildMessage,
  MAX_ARGUMENT_BYTES,
  MAX_ARGUMENT_VALUES,
  MAX_CALLS_IN_FLIGHT,
  MAX_WAKE_PAYLOAD_BYTES,
  RESULT_TOO_LARGE,
  wakeRefusal,
  type ChildMessage,
  type GuestError,
  type StopReason,
} from './protocol.js';
import { bounded, CUT_MARK_CHARS, formatMs, glimpse, NAME_CHARS, VALUE_CHARS } from './render.js';

/** A call's answer for the guest: `ok` resolves its promise with the parsed JSON, otherwise rejects with it. */
export interface CallAnswer {
  ok: boolean;
  json: string;
}

/** A tool call's answer from the bridge. */
export interface ToolAnswer extends CallAnswer {
  /** The result was marked as an error. */
  isError?: boolean;
  /** The start of what the tool answered, as an agent would read it, for naming a call the script stopped waiting for. */
  brief?: string;
  /**
   * No result came from the host in time, so the bridge answered for it: the
   * tool may still be running, holding its work, or its result was lost, and
   * the host can't tell which. Its place stays taken until the run ends.
   */
  held?: boolean;
}

/** How a script ended. */
export type Ending =
  | { how: 'finished'; value?: string }
  | { how: 'failed'; error: GuestError; stalled?: boolean }
  /** `short` when the child had to be ended, so its output so far may be short. */
  | { how: 'stopped'; reason: StopReason; short?: boolean; why?: string }
  | { how: 'crashed'; detail: string };

/** A run as it stands: its output since the last return, its calls, and its ending once it has one. */
export interface RunSnapshot {
  output: string;
  calls: CallSummary;
  ending: Ending | null;
}

/** How many script children a host runs at once, counted until each child's process has exited. */
export class ChildCapacity {
  private live = 0;
  constructor(readonly max: number) {}
  get running(): number {
    return this.live;
  }
  /** Take a place, or false when the host is full. */
  take(): boolean {
    if (this.live >= this.max) return false;
    this.live += 1;
    return true;
  }
  release(): void {
    this.live = Math.max(0, this.live - 1);
  }
}

/**
 * The child's entry, beside this module and with its extension: `.ts` where
 * the host runs this package's source, as a Bun host does through the
 * package's `bun` export, and `.js` where it runs the build. So the runtime
 * is given a file that exists: given a `.js` path that it maps to the `.ts`
 * beside it, Bun runs it as `bun run` would, with npm_* variables and a PATH
 * of its own in the child's environment.
 */
export const CHILD_ENTRY = fileURLToPath(new URL(`./child-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

export interface ScriptRunOptions {
  /** The child's entry: a script the runtime runs as the child process (CHILD_ENTRY, but for tests). */
  childEntry: string;
  /** Arguments after the entry, if any. */
  childArgs?: readonly string[];
  /** The runtime to run it with: by default the parent's own. */
  execPath?: string;
  memoryMaxBytes: number;
  maxStackBytes?: number;
  output: OutputBounds;
  /** How often, at most, the child flushes output while its guest computes. */
  flushMs: number;
  /** The script's limit: at this age it's stopped, as "stopped at its limit". */
  lifetimeMs: number;
  /** How long a call may go unanswered before the script is told it timed out. */
  toolCallTimeoutMs: number;
  /** How long a stopped child has to report its ending before it's ended. */
  stopGraceMs: number;
  /** The least time between two of the script's wakes: an early one waits for its turn. */
  wakeMinIntervalMs: number;
  /** The most wakes one script may send; past it, a wake is refused. */
  maxWakes: number;
  /** The bridge: dispatch one tool call. Never rejects; a refusal is `ok: false`. */
  onToolCall(name: string, argsJson: string): Promise<ToolAnswer>;
  /** Send `wake_agent(payload)`, the script's `n`th wake, once its turn has come: answers the guest's promise. */
  onWake(payloadJson: string, n: number): Promise<CallAnswer>;
  /** Called once, when the run has an ending. */
  onEnd?(ending: Ending): void;
}

/** The most of a child's stderr kept, for a crash's detail. */
const STDERR_KEEP_CHARS = 4_000;
/**
 * The most values a frame from the child may hold. Its largest, a failure's
 * ending, holds eight, since arguments, output and values travel as strings.
 */
const MAX_CHILD_FRAME_VALUES = 32;
/** How much of a refusal too long for the script's memory reaches it. */
const REFUSAL_GLIMPSE_CHARS = 2000;

/** Remove a run's directory. A failure leaves only an empty directory behind, which mustn't stop the run's ending. */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing else to do: the directory is left.
  }
}

export { MAX_CALLS_IN_FLIGHT };

/**
 * The largest result the parent sends a script: a third of its linear memory,
 * since parsing one takes about three times its size there (a heap run under
 * Bun 1.4.3 and Node 24.19.0). A larger one would fail in the guest anyway,
 * after growing the child past its budget, so it's refused before it's sent,
 * and the script's ResultTooLarge says the call took effect.
 */
export function maxResultBytes(memoryMaxBytes: number): number {
  return Math.max(0, Math.floor(memoryMaxBytes / 3));
}

/** A refusal's own text, from its JSON, for a refusal that came with no brief. */
function refusalText(json: string): string {
  try {
    const message = (JSON.parse(json) as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  } catch {
    // Not a refusal's JSON: its text is what there is.
  }
  return json;
}

export class ScriptRun {
  private child: ChildProcess | null = null;
  private dir: string | null = null;
  private readonly output: WindowOutput;
  private readonly log = new CallLog();
  /** The ids of the guest's calls the child named, reserved until it says the script has their answer. */
  private readonly pendingIds = new Set<number>();
  /** The calls answered and not yet seen: only these may the child say the script has. */
  private readonly answeredIds = new Set<number>();
  /** The script's tools, the only names its calls may have. */
  private toolNames = new Set<string>();
  /** Results sent to the guest and not yet seen: each is counted once the child says the script has it, and whether it fit. */
  private readonly delivered = new Map<number, { entry: CallEntry; outcome: CallOutcome; brief: string }>();
  private ending: Ending | null = null;
  private readonly waiters = new Set<() => void>();
  private stderr = '';
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private processExited = false;
  private stopAsked: { reason: StopReason; why?: string } | null = null;
  /** Each unanswered call's timeout, cleared when it's answered or the run ends. */
  private readonly callTimers = new Set<ReturnType<typeof setTimeout>>();
  /** The calls holding a place among those in flight, by id, until the child says the script has their answer. */
  private readonly inFlight = new Set<number>();
  /**
   * How many calls the bridge holds, until it answers each: a call that timed
   * out in the script, and so left its place there, may still hold its
   * arguments in the host. Counted, not keyed by id, since the child may name
   * a timed-out call's id again once the script has seen its TimeoutError.
   * At most MAX_CALLS_IN_FLIGHT; a call past them waits in `dispatchWaiting`,
   * as its text, until one is answered. One the bridge answered for (`held`)
   * keeps its place until the run ends.
   */
  private hostCalls = 0;
  /** Calls waiting for the bridge to hold fewer: each resolved with true when its turn comes, false when it won't be sent. */
  private readonly dispatchWaiting = new Map<number, (go: boolean) => void>();
  /** Wakes the child has sent, which the cap counts: those refused once a stop was asked included, so a child that ignores the stop is still bounded. */
  private wakeFrames = 0;
  /** Wakes handed to the host to deliver, whatever it answered: a wake's number, which the host is given. */
  private wakes = 0;
  /** Wakes the host delivered, its answer neither a refusal nor a failure. */
  private delivered_wakes = 0;
  /** Wakes waiting for their turn, which the run's end counts as never sent. */
  private wakesWaiting = 0;
  /** When the next wake may go out, on the monotonic clock: the spacing counts from when the last wake's delivery ended. */
  private nextWakeAt = 0;
  /** Settles once the latest wake has gone out, or won't: wakes go out in the order they were made. */
  private wakeChain: Promise<void> = Promise.resolve();
  /** Wakes waiting out the spacing, each released at its time or when the run ends. */
  private readonly wakeWaiters = new Set<() => void>();
  /**
   * Results waiting for the child's stdin to drain, as their frames: each holds
   * its JSON's bytes, which the result bound counts. A result's id becomes one
   * the child may say it has seen once its frame is written.
   */
  private readonly resultQueue: Array<{ id: number; frame: Buffer }> = [];
  private draining = false;
  private exitResolve!: () => void;
  private endedResolve!: () => void;
  /** Resolves when the run ends: a wake waiting behind another's delivery stops waiting then. */
  private readonly endedSignal: Promise<void> = new Promise((resolve) => (this.endedResolve = resolve));
  /** Resolves when the child's process has exited, or at once if it never started. */
  readonly exited: Promise<void> = new Promise((resolve) => (this.exitResolve = resolve));

  constructor(private readonly options: ScriptRunOptions) {
    this.output = new WindowOutput(options.output);
  }

  /**
   * Spawn the child and send it the script. A start frame too long for a frame
   * throws before anything is spawned, with `exited` resolved, so nothing is
   * left running and the place it took frees at once. A child that can't be
   * spawned crashes the run.
   */
  start(script: string, tools: readonly PreludeTool[]): void {
    let dir: string | null = null;
    let startFrame: Buffer;
    try {
      this.toolNames = new Set(tools.map((t) => t.name));
      // Absolute, since the child starts in it: a relative TMPDIR would name
      // the stop file from two different places.
      dir = resolve(mkdtempSync(join(tmpdir(), 'af-script-')));
      startFrame = encodeFrame({
        t: 'start',
        script,
        tools: tools.map((t) => ({ name: t.name, description: t.description, ...(t.inputSchema === undefined ? {} : { inputSchema: t.inputSchema }) })),
        memoryMaxBytes: this.options.memoryMaxBytes,
        ...(this.options.maxStackBytes === undefined ? {} : { maxStackBytes: this.options.maxStackBytes }),
        stopFile: join(dir, 'stop'),
        parentPid: process.pid,
        flushMs: this.options.flushMs,
        maxWakes: this.options.maxWakes,
      });
    } catch (err) {
      if (dir) removeDir(dir);
      this.exitResolve();
      throw err;
    }
    this.dir = dir;
    const runDir = dir;
    // A process that never started never exits: the run crashes, and its place
    // is free now. It counts as exited, so the ending arms no kill and holds no child.
    const neverStarted = (why: unknown): void => {
      this.processExited = true;
      this.crash(`its process could not run: ${why instanceof Error ? why.message : String(why)}`);
      removeDir(runDir);
      this.exitResolve();
    };
    let child: ChildProcess;
    try {
      child = spawn(this.options.execPath ?? process.execPath, [this.options.childEntry, ...(this.options.childArgs ?? [])], {
        // The parent's frames go in on stdin, and the child's come back on fd 3 (child-main.ts says why).
        stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
        // The child is ours and reads nothing from its environment; the guest has none at all.
        env: {},
        // Its own directory, which holds nothing but the stop file: Bun reads a
        // .env file, and its bunfig.toml, from the directory it starts in, so
        // in the host's it would load the host's .env into the child.
        cwd: runDir,
      });
    } catch (err) {
      // Node throws here for some arguments it refuses at once.
      neverStarted(err);
      return;
    }
    // Node emits a spawn's 'error' on a later tick, which this takes. Bun's can
    // come while spawn runs, before this is attached: spawn then throws it into
    // the catch above, or returns with its pipes null, which the check below
    // takes.
    child.on('error', (err) => {
      if (child.pid === undefined) neverStarted(err);
      else this.crash(`its process could not run: ${err.message}`);
    });
    this.child = child;
    const toChild = child.stdin as Writable | null;
    const fromChild = child.stdio[3] as Readable | null;
    if (!toChild || !fromChild) {
      // Bun can return with no pipes and emit the spawn's 'error', which names
      // the cause, just after: a turn of the loop lets it come first.
      setImmediate(() => neverStarted(new Error('its pipes were never opened')));
      return;
    }
    // A child's frames are small flat objects, its arguments and output
    // carried as strings, so one holding more values isn't following the
    // protocol, and is refused before it's parsed.
    const decoder = new FrameDecoder(MAX_CHILD_FRAME_BYTES, false, MAX_CHILD_FRAME_VALUES);
    fromChild.on('data', (chunk: Buffer) => {
      let values: unknown[];
      try {
        values = decoder.push(chunk);
      } catch (err) {
        this.crash(`its process sent the host a message it couldn't read (${(err as FrameError).message})`);
        return;
      }
      for (const value of values) {
        const message = decodeChildMessage(value);
        if ('invalid' in message) {
          this.crash(`its process sent the host a message it couldn't read (${message.invalid})`);
          return;
        }
        this.handle(message);
      }
    });
    // Whether the child said how the script ended is known once its process has
    // exited and fd 3 has ended, so every frame it wrote has been read: Node can
    // emit 'exit' before it has read a child's last frames (1 in 2,700 runs of a
    // probe under Node 20.20.2), and Bun 1.4.3 emits 'close' before an extra
    // pipe like fd 3 has ended. A crash's detail waits for stderr's end too, for
    // the same reason.
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let channelEnded = false;
    let stderrEnded = child.stderr === null;
    const decide = (): void => {
      if (!exit || !channelEnded || !stderrEnded || this.ending !== null) return;
      const how = exit.signal ? `was ended by ${exit.signal}` : `exited with code ${exit.code}`;
      if (this.stopAsked) this.end({ how: 'stopped', reason: this.stopAsked.reason, short: true, ...(this.stopAsked.why ? { why: this.stopAsked.why } : {}) });
      else this.crash(`its process ${how} before the script ended${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
    };
    const channelEnd = (): void => {
      if (channelEnded) return;
      channelEnded = true;
      // A frame cut off at the channel's end can't be read: the child broke off
      // mid-message. Once a stop was asked that's the stop's doing, since the
      // grace's kill can cut a frame, and the run ends as stopped.
      try {
        decoder.end();
      } catch (err) {
        if (!this.stopAsked) this.crash(`its process sent the host a message it couldn't read (${(err as FrameError).message})`);
      }
      decide();
    };
    fromChild.on('end', channelEnd);
    fromChild.on('close', channelEnd);
    fromChild.on('error', () => {});
    toChild.on('error', () => {});
    const stderrEnd = (): void => {
      stderrEnded = true;
      decide();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP_CHARS);
    });
    child.stderr?.on('end', stderrEnd);
    child.stderr?.on('close', stderrEnd);
    child.stderr?.on('error', () => {});
    // The host's place for the child frees when its process exits. fd 3 and
    // stderr have the grace to end after it, which only a process the child
    // left holding them could stretch.
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      this.processExited = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      removeDir(runDir);
      this.exitResolve();
      if (!channelEnded || !stderrEnded) {
        setTimeout(() => {
          // After the next poll, so what the child wrote before it exited is
          // read first, even when this loop was too busy to read it in the grace.
          setImmediate(() => {
            fromChild.destroy();
            child.stderr?.destroy();
            channelEnd();
            stderrEnd();
          });
        }, this.options.stopGraceMs).unref();
      }
      decide();
      if (this.ending !== null) this.release();
    });
    this.write(startFrame);
    this.lifetimeTimer = setTimeout(() => this.stop('limit'), this.options.lifetimeMs);
  }

  /** The run as it stands, its output since the last return included. */
  snapshot(): RunSnapshot {
    // Calls waiting for room in the host, and wakes waiting for their turn, are the script's too.
    return { output: this.output.render(), calls: this.log.summary(this.dispatchWaiting.size + this.wakesWaiting), ending: this.ending };
  }

  /** The output since the last return, as it stands. */
  outputWindow(): OutputWindow {
    return this.output.window();
  }

  /** The output since the last return, starting a fresh stretch from here. */
  takeOutput(): OutputWindow {
    return this.output.take();
  }

  get ended(): boolean {
    return this.ending !== null;
  }

  /** End the child's process now if it's still alive, whatever the run's state. Resolves once it has exited. */
  kill(): Promise<void> {
    if (!this.processExited) this.child?.kill('SIGKILL');
    return this.exited;
  }

  /** The wakes the host delivered to the script's agent: those it answered ok and not as an error. A refused wake isn't one, nor a failed one, though a failure may have taken effect. */
  get wakesDelivered(): number {
    return this.delivered_wakes;
  }

  /** Resolves when the script has ended, or after `ms`, whichever comes first. */
  wait(ms: number): Promise<RunSnapshot> {
    if (this.ending) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.snapshot());
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /**
   * Ask the script to stop: the stop file for a computing guest, a frame for an
   * idle one. If the child hasn't said how it ended within the grace, it's
   * ended, and the ending says its output so far may be short. The reason is
   * the one asked here, whatever the child says.
   */
  stop(reason: StopReason, why?: string): Promise<RunSnapshot> {
    if (this.ending || !this.child) return Promise.resolve(this.snapshot());
    // A process that has exited has no stop to take: its run ends as its last
    // frames say, or as a crash, which a stop asked now mustn't take for its own.
    if (!this.stopAsked && !this.processExited) {
      this.stopAsked = { reason, ...(why ? { why } : {}) };
      try {
        if (this.dir) writeFileSync(join(this.dir, 'stop'), '');
      } catch {
        // The frame below still reaches an idle child, and the grace ends a computing one.
      }
      this.send({ t: 'stop' });
      this.killTimer = setTimeout(() => {
        this.child?.kill('SIGKILL');
      }, this.options.stopGraceMs);
      this.killTimer.unref?.();
    }
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        resolve(this.snapshot());
      };
      if (this.ending) done();
      else this.waiters.add(done);
    });
  }

  private send(message: unknown): void {
    this.write(encodeFrame(message));
  }

  /** A call's result, as a result frame once its turn comes: the JSON's bytes go to the engine as they are. */
  private sendResult(id: number, ok: boolean, json: string): void {
    this.resultQueue.push({ id, frame: encodeResultFrame(id, ok, json, maxResultBytes(this.options.memoryMaxBytes) + RESULT_FRAME_OVERHEAD) });
    this.pump();
  }

  /** Write waiting results, one frame at a time: after a write the pipe didn't take whole, the next waits for 'drain'. */
  private pump(): void {
    const pipe = this.child?.stdin ?? undefined;
    if (!pipe || pipe.destroyed) {
      this.resultQueue.length = 0;
      return;
    }
    while (!this.draining && this.resultQueue.length > 0) {
      const { id, frame } = this.resultQueue.shift()!;
      this.answeredIds.add(id);
      if (!pipe.write(frame)) {
        this.draining = true;
        pipe.once('drain', () => {
          this.draining = false;
          this.pump();
        });
      }
    }
  }

  private write(frame: Buffer): void {
    const pipe = this.child?.stdin ?? undefined;
    if (!pipe || pipe.destroyed) return;
    pipe.write(frame);
  }


  private handle(message: ChildMessage): void {
    if (this.ending && message.t !== 'out') return;
    switch (message.t) {
      case 'out':
        // The child flushes output in pieces of at most a batch.
        if (message.text.length > MAX_BATCH_CHARS) {
          this.crash(`its process sent the host ${message.text.length.toLocaleString('en-US')} characters of output in one frame, past the ${MAX_BATCH_CHARS.toLocaleString('en-US')} it sends at most`);
          return;
        }
        this.output.apply(message.text);
        return;
      case 'call':
        void this.call(message.id, message.name, message.args);
        return;
      case 'seen': {
        // The script has the answer the parent sent, or got ResultTooLarge in
        // its place: the call's id and its place are free. A seen for a call
        // whose answer the parent hasn't written isn't following the protocol.
        if (!this.answeredIds.delete(message.id)) {
          this.crash(`its process said the script had the answer to call ${message.id}, which the host never sent`);
          return;
        }
        this.pendingIds.delete(message.id);
        this.inFlight.delete(message.id);
        const sent = this.delivered.get(message.id);
        if (!sent) return;
        this.delivered.delete(message.id);
        // A refusal stays one though the script couldn't receive it: nothing was done either way.
        this.log.answered(sent.entry, message.unfit && sent.outcome !== 'refused' ? 'too-large' : sent.outcome, sent.brief);
        return;
      }
      case 'end': {
        const { t: _t, ...said } = message;
        // The child cuts the value and a failure's parts as a return shows them.
        // The parent bounds them too, since an ended run is kept for a later
        // wait, with room for the child's cut and its marker, so an honest
        // child's cut, and the count it gives, pass as they are.
        if (said.how === 'finished') {
          this.end(said.value === undefined ? { how: 'finished' } : { how: 'finished', value: bounded(said.value, VALUE_CHARS + CUT_MARK_CHARS) });
          return;
        }
        if (said.how === 'failed') {
          const error = {
            name: bounded(said.error.name, NAME_CHARS + CUT_MARK_CHARS),
            message: bounded(said.error.message, VALUE_CHARS + CUT_MARK_CHARS),
            ...(said.error.stack === undefined ? {} : { stack: bounded(said.error.stack, VALUE_CHARS + CUT_MARK_CHARS) }),
          };
          this.end({ how: 'failed', error, ...(said.stalled ? { stalled: true } : {}) });
          return;
        }
        if (!this.stopAsked) {
          this.crash("its process sent the host a message it couldn't read (the script said it was stopped, and no stop was asked)");
          return;
        }
        this.end({ how: 'stopped', reason: this.stopAsked.reason, ...(this.stopAsked.why ? { why: this.stopAsked.why } : {}) });
        return;
      }
    }
  }

  private async call(id: number, name: string, args: string): Promise<void> {
    const wake = name === WAKE_CALL_NAME;
    // The prelude offers only the script's tools, so a call to another name
    // isn't following it. The name is the child's, bounded by the protocol.
    if (!wake && !this.toolNames.has(name)) {
      this.crash(`its process sent the host a call to ${JSON.stringify(name)}, which isn't one of the script's tools`);
      return;
    }
    if (this.pendingIds.has(id)) {
      this.crash(`its process sent the host a message it couldn't read (call ${id} was named twice)`);
      return;
    }
    this.pendingIds.add(id);
    const tool = wake ? 'wake_agent' : name;
    // Refused here, before anything is sent: the record counts it, and nothing was done.
    const refuse = (refusal: { name: string; message: string }): void => {
      this.delivered.set(id, { entry: this.log.start(tool, args), outcome: 'refused', brief: callBrief(refusal.message) });
      this.answer(id, false, JSON.stringify(refusal));
    };
    let n = 0;
    let wakeSent = (): void => {};
    if (wake) {
      // The child refuses a wake past the cap itself, and counts every wake it
      // sends, one refused here included, so a child that sends more isn't
      // following it. Counted before a stop's refusal, so wakes sent after a
      // stop are bounded too.
      if (this.wakeFrames >= this.options.maxWakes) {
        this.crash(`its process sent the host more than ${this.options.maxWakes} wakes, the most a script may send`);
        return;
      }
      // The child refuses a payload past its cap before a frame is built.
      const tooLarge = wakeRefusal(args);
      if (tooLarge) {
        this.crash(`its process sent the host a wake of ${tooLarge.bytes.toLocaleString('en-US')} bytes, past the ${capText(MAX_WAKE_PAYLOAD_BYTES)} the script refuses itself`);
        return;
      }
      this.wakeFrames += 1;
      const stopping = this.stopRefusal('WakeRefused', tool);
      if (stopping) {
        refuse(stopping);
        return;
      }
      // An early wake waits for its turn rather than being dropped: once the
      // one before it has gone out, and the spacing since that one's delivery
      // has passed. The run's end stops both waits.
      const previous = this.wakeChain;
      this.wakeChain = new Promise<void>((resolve) => (wakeSent = resolve));
      this.wakesWaiting += 1;
      await Promise.race([previous, this.endedSignal]);
      await this.wakeTurn();
      // A wake still waiting for its turn when the script ended, or once a
      // stop was asked or its process exited, is never sent: the ending is the
      // script's last word, and the endings that should wake its agent already
      // do. The record counts it as never sent: the run's end counts those
      // still waiting when it comes, and one dropped before it is counted here.
      // (A call waiting in the script for a place is likewise never sent when a
      // stop or a crash ends it; one whose script returns goes out, since the
      // child waits for every call it made.)
      if (this.ending) {
        wakeSent();
        return;
      }
      this.wakesWaiting -= 1;
      if (this.stopAsked || this.processExited) {
        wakeSent();
        this.log.unsent();
        return;
      }
      this.wakes += 1;
      n = this.wakes;
    } else {
      // The prelude sends at most MAX_CALLS_IN_FLIGHT at once and keeps the
      // rest waiting in the script, so a child that sends more isn't following it.
      if (this.inFlight.size >= MAX_CALLS_IN_FLIGHT) {
        this.crash(`its process sent the host more than ${MAX_CALLS_IN_FLIGHT} calls at once, the most a script may have out`);
        return;
      }
      this.inFlight.add(id);
      // The child refuses arguments past their caps before a frame is built.
      const tooLarge = argumentsRefusal(name, args);
      if (tooLarge) {
        this.crash(
          `its process sent the host a call to ${name} whose arguments pass their caps of ${capText(MAX_ARGUMENT_BYTES)} and ` +
            `${MAX_ARGUMENT_VALUES.toLocaleString('en-US')} values, which the script refuses itself`,
        );
        return;
      }
      const refusal = this.stopRefusal('ToolRefused', tool);
      if (refusal) {
        refuse(refusal);
        return;
      }
    }
    // The guest has its answer: a result, or a TimeoutError in its place.
    let settled = false;
    const settle = (ok: boolean, json: string): void => {
      settled = true;
      this.answer(id, ok, json);
    };
    let entry: CallEntry | null = null;
    // A call's time runs from when the script made it, a wait for room in the host included.
    const timer = wake ? null : setTimeout(() => {
      if (timer) this.callTimers.delete(timer);
      if (settled || this.ending) return;
      const waiting = this.dispatchWaiting.get(id);
      if (waiting) {
        // It never went out: no place in the host came free for it in time.
        this.dispatchWaiting.delete(id);
        waiting(false);
        this.log.unsent();
        settle(false, JSON.stringify({
          name: 'TimeoutError',
          message: `${name} was never sent: ${MAX_CALLS_IN_FLIGHT} of this script's earlier calls were still running in the host, timed-out ones ` +
            `included, and its turn didn't come within ${formatMs(this.options.toolCallTimeoutMs)}, so nothing was done; calling it again may go through once one of them gets its result, ` +
            'though a call whose tool the host stopped waiting for stays counted until this script ends, and a new script starts with none',
        }));
        return;
      }
      if (!entry) return;
      this.log.timedOut(entry);
      settle(false, JSON.stringify({
        name: 'TimeoutError',
        message: `${name} was sent, and no answer came within ${formatMs(this.options.toolCallTimeoutMs)}; it may still take effect`,
      }));
    }, this.options.toolCallTimeoutMs);
    if (timer) this.callTimers.add(timer);
    const clearTimer = (): void => {
      if (!timer) return;
      clearTimeout(timer);
      this.callTimers.delete(timer);
    };
    if (!wake) {
      // Past the calls the host holds, it waits as its text, and its place is
      // taken for it when its turn comes (releasePlace).
      if (this.hostCalls < MAX_CALLS_IN_FLIGHT) this.hostCalls += 1;
      else if (!(await new Promise<boolean>((resolve) => this.dispatchWaiting.set(id, resolve)))) return;
      // Once the run has ended or its process has exited, nothing it asks goes
      // out: a frame the child wrote before it exited can be read after the
      // exit, and a call waiting for room can be given its place after it. The
      // record counts such a call as never sent: the script made it, and
      // nothing was done. A stop asked while it waited refuses it, as it would
      // have refused it then.
      if (this.ending || this.processExited) {
        clearTimer();
        this.releasePlace();
        this.log.unsent();
        return;
      }
      const stopping = this.stopRefusal('ToolRefused', tool);
      if (stopping) {
        clearTimer();
        this.releasePlace();
        refuse(stopping);
        return;
      }
    }
    entry = this.log.start(tool, args);
    let answer: ToolAnswer;
    try {
      answer = wake ? await this.options.onWake(args, n) : await this.options.onToolCall(name, args);
    } catch (err) {
      // The bridge never rejects. One that does is answered as a failure,
      // which may have taken effect, never as an unhandled rejection.
      const text = `${tool} failed in the host: ${err instanceof Error ? err.message : String(err)}; it may have taken effect`;
      answer = { ok: true, isError: true, brief: text, json: JSON.stringify({ content: [{ type: 'text', text }], structuredContent: null, isError: true }) };
    }
    if (wake) {
      this.nextWakeAt = performance.now() + this.options.wakeMinIntervalMs;
      if (answer.ok && !answer.isError) this.delivered_wakes += 1;
      wakeSent();
    } else if (!answer.held) this.releasePlace();
    // No result came, and the bridge answered for it, after the script's own
    // timeout (the bridge waits longer): the call stays as the record had it
    // (timed out, or uncertain at an ending), and its place stays taken. Had
    // the script's timeout not come yet, its timer would still give it one.
    if (answer.held) return;
    clearTimer();
    const bytes = Buffer.byteLength(answer.json, 'utf8');
    const limit = maxResultBytes(this.options.memoryMaxBytes);
    const tooLarge = bytes > limit;
    // A refusal stays one however long its text: nothing was done.
    const outcome: CallOutcome = !answer.ok ? 'refused' : tooLarge ? 'too-large' : answer.isError ? 'failed' : 'answered';
    // Only its start is kept, as a copy: the record names a call by that much.
    const brief = callBrief(answer.brief ?? answer.json);
    if (settled || this.ending) {
      // The script stopped waiting for it, or ended: the record takes the answer as it comes.
      this.log.answered(entry, outcome, brief);
      return;
    }
    this.delivered.set(id, { entry, outcome, brief });
    if (tooLarge) {
      settle(false, JSON.stringify(outcome === 'refused'
        ? {
          name: wake ? 'WakeRefused' : 'ToolRefused',
          message: `${glimpse(answer.brief ?? refusalText(answer.json), REFUSAL_GLIMPSE_CHARS)} (the refusal's text, ${bytes} bytes, is too large for this script's memory, so only its start is here; nothing was done)`,
        }
        : {
          name: RESULT_TOO_LARGE,
          message: `${name}'s result, ${bytes} bytes, is too large for this script's memory; the call took effect, and none of its result reached the script`,
          bytes,
        }));
      return;
    }
    settle(answer.ok, answer.json);
  }

  /**
   * A call no longer holds a place in the host: the bridge answered it, or it
   * won't be sent. The first call waiting for room takes the place, in the
   * same step, so no later call can take it first. Whatever lets a waiting
   * call go takes it off the queue. One given its place once the run has
   * ended or its process has exited isn't sent (the call's own check), and
   * the end lets the calls still waiting go.
   */
  private releasePlace(): void {
    this.hostCalls -= 1;
    const next = this.dispatchWaiting.entries().next();
    if (next.done) return;
    const [nextId, go] = next.value;
    this.dispatchWaiting.delete(nextId);
    this.hostCalls += 1;
    go(true);
  }

  /** An answer to the call the child named `id`, sent once its turn comes. The id stays reserved until the child says the script has it. */
  private answer(id: number, ok: boolean, json: string): void {
    this.sendResult(id, ok, json);
  }

  /** A call or wake that comes once a stop has been asked isn't sent: the script is ending. */
  private stopRefusal(name: 'ToolRefused' | 'WakeRefused', tool: string): { name: string; message: string } | null {
    return this.stopAsked ? { name, message: `${tool}: the script is being stopped, so nothing was sent` } : null;
  }

  /** Resolves once the spacing since the last wake has passed, or at once when the run has ended. */
  private wakeTurn(): Promise<void> {
    const wait = this.nextWakeAt - performance.now();
    if (wait <= 0 || this.ending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const release = (): void => {
        clearTimeout(timer);
        this.wakeWaiters.delete(release);
        resolve();
      };
      const timer = setTimeout(release, wait);
      this.wakeWaiters.add(release);
    });
  }

  /**
   * Once the process has exited and the run has ended, nothing more goes to
   * the child: an ended run kept for a later wait holds none of it. Whichever
   * of the two comes second calls this.
   */
  private release(): void {
    this.child?.stdin?.destroy();
    this.child = null;
  }

  private crash(detail: string): void {
    if (this.ending) return;
    this.end({ how: 'crashed', detail });
    this.child?.kill('SIGKILL');
  }

  private end(ending: Ending): void {
    if (this.ending) return;
    // Results sent and not yet seen were answered, and the script ended
    // before it read them: each is named, a refusal counted. Calls still
    // running may or may not take effect. A stop or a crash can leave either,
    // whatever the ending: a script that had returned or thrown when a stop
    // came ends as it did, with the calls its stop cut the wait for. So can a
    // failure that escaped the script's promises, which ends the run at once,
    // and a result the engine dropped as a stop came, which gets no seen. A
    // TimeoutError the engine dropped so leaves its call named timed-out, as
    // the host's timer had it, with no answer to name. Otherwise the child
    // reports a finish or a failure only once every call it made is settled
    // and seen. The host's count of the calls the bridge holds stays as it
    // is, since those tools may still run: each frees its place as it
    // answers, and one the bridge answered for with no result (held) never
    // does.
    for (const sent of this.delivered.values()) this.log.unseen(sent.entry, sent.outcome);
    this.delivered.clear();
    this.pendingIds.clear();
    this.answeredIds.clear();
    this.inFlight.clear();
    this.log.ended();
    this.ending = ending;
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    // A child exits on its own once it has said how its script ended. One that
    // doesn't, such as one stuck in its cleanup, is ended after the stop's
    // grace, so it can't hold its place or outlive its run.
    if (this.child && !this.processExited && !this.killTimer) {
      this.killTimer = setTimeout(() => this.child?.kill('SIGKILL'), this.options.stopGraceMs);
      this.killTimer.unref?.();
    }
    for (const timer of this.callTimers) clearTimeout(timer);
    this.callTimers.clear();
    // Nothing more goes to the child: waiting results are dropped, and calls
    // waiting for a place go nowhere, so an ended run that's kept for a later
    // wait holds neither.
    this.resultQueue.length = 0;
    for (const release of [...this.wakeWaiters]) release();
    this.endedResolve();
    // Calls waiting for room in the host are never sent, and the record counts
    // them so: the script made them, and nothing was done.
    for (const [waitingId, go] of [...this.dispatchWaiting]) {
      this.dispatchWaiting.delete(waitingId);
      this.log.unsent();
      go(false);
    }
    // So are wakes waiting for their turn: each sees the ending and goes.
    for (; this.wakesWaiting > 0; this.wakesWaiting -= 1) this.log.unsent();
    for (const waiter of [...this.waiters]) waiter();
    if (this.processExited) this.release();
    this.options.onEnd?.(ending);
  }
}
