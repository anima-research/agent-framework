/**
 * A script's child: one process per script, which runs it in the engine and
 * answers the engine's four imports. It takes its start from the parent's
 * first frame, sends each tool call to the parent and settles it with the
 * parent's answer, flushes the output in bounded batches, and reports how the
 * script ended. A crash it can't report: the parent sees that the child ended
 * without saying how.
 *
 * Stopping: the parent creates the stop file and sends a stop frame. A
 * computing guest's interrupt import sees the file, checked at most every few
 * milliseconds, so a stop reaches a spinning guest without its event loop; an
 * idle guest's child reads the frame. Why the stop was asked is the parent's
 * to say, so the child reports only that the script stopped.
 */

import { existsSync } from 'node:fs';
import { MAX_RESULT_DEPTH, type Engine, type EngineLimits, type EngineSlots, type RunState, type SettleState } from '../engine.js';
import { argumentsRefusal, MAX_CALLS_IN_FLIGHT, RESULT_TOO_LARGE, wakeLimitRefusal, wakeRefusal } from './protocol.js';
import { OutputBatch } from './output.js';
import { bounded, glimpse, NAME_CHARS, VALUE_CHARS } from './render.js';
import { preludeSource, scriptCall, scriptFrames, WAKE_CALL_NAME } from './prelude.js';
import type { ParentMessage, StartMessage } from './protocol.js';

/** How often, at most, the interrupt import looks for the stop file. */
export const STOP_CHECK_MS = 3;

/**
 * The filename of the one line that starts the script, `await __run(...)`.
 * The script's own frames carry `<input>`, the source name QuickJS gives the
 * async function it's compiled into (SCRIPT_LINE_OFFSET).
 */
const SCRIPT_FILENAME = 'script.js';

export type LoadEngine = (limits: EngineLimits, slots: EngineSlots) => Promise<Engine>;

export interface ChildIo {
  /** The parent's frames, in order, each already decoded; done when the parent closes its end. */
  next(): Promise<ParentMessage | null>;
  /**
   * Send one message now, synchronously: the engine may be mid-call. A message
   * too long for a frame throws its FrameError, and nothing is sent.
   */
  send(message: unknown): void;
  /** Milliseconds from some fixed point. */
  now(): number;
  /** Whether the parent has gone, so no one is left to stop the script or read its ending. */
  parentGone?(): boolean;
  /**
   * End the child's process at once, its parent having gone: nothing it does
   * reaches anyone, its unsent output included, and nothing is left to kill
   * it if its guest keeps a stop from ending it. The child looks for its
   * parent at the engine's interrupt checks, at most once a stop check
   * (`STOP_CHECK_MS`), after a stop as before one. Without this, the child
   * stops its guest instead.
   */
  orphaned?(): never;
}

/** The value's JSON from the engine's JSON of the prelude's text: a string, so one parse gives it, and anything else is given as it came. */
function valueJson(json: string): string {
  try {
    const text: unknown = JSON.parse(json);
    return typeof text === 'string' ? text : json;
  } catch {
    return json;
  }
}

/** Run the script `start` names to its end. Resolves once its ending is sent, or when the parent closes the channel. */
export async function runChild(io: ChildIo, start: StartMessage, loadEngine: LoadEngine): Promise<void> {
  const batch = new OutputBatch();
  /** The calls the guest waits on, by id: their tools' names. */
  const outstanding = new Map<number, string>();
  /** Calls answered here, without going out: their arguments were too large to send. */
  const local: { id: number; json: string }[] = [];
  /**
   * While a result settles, the calls the guest's jobs make are held, and go
   * out after that result's `seen`, which says whether the result fit: the
   * parent then frees the answered call's place before it counts the next.
   * A result the engine drops reaches no script code, and what code QuickJS
   * still runs as the stop lands, a stack hook building the stop's error,
   * can't make a call, since the engine refuses `__host` once stopped: its
   * settle holds none.
   */
  let held: unknown[] | null = null;
  /** Wakes sent, which the script's cap counts. */
  let wakesSent = 0;
  let stopped = false;
  let lastFlush = io.now();
  let lastStopCheck = -Infinity;
  let lastParentCheck = -Infinity;
  /** Its parent has been seen gone, so the child has ended its process, or stopped its guest. */
  let orphan = false;

  const flush = (): void => {
    lastFlush = io.now();
    for (const text of batch.flush()) io.send({ t: 'out', text });
  };

  const slots: EngineSlots = {
    hostCall(callId, name, argsJson) {
      outstanding.set(callId, name);
      // What the host won't take is refused here, before a frame is built,
      // and by the parent again, since the child is untrusted. A call that
      // passes always fits a frame, which carries its arguments escaped, at
      // most six bytes for each of theirs.
      const wake = name === WAKE_CALL_NAME;
      // A wake past the script's cap is refused too, after its size, so one
      // refused for its size uses none of the script's wakes.
      const refusal = wake
        ? (wakeRefusal(argsJson) ?? (wakesSent >= start.maxWakes ? wakeLimitRefusal(start.maxWakes) : null))
        : argumentsRefusal(name, argsJson);
      if (refusal) {
        // The slot can't settle the call from inside the engine: it's answered
        // as soon as the engine returns.
        local.push({ id: callId, json: JSON.stringify(refusal) });
        return;
      }
      if (wake) wakesSent += 1;
      // What the script wrote before the call reaches the host before it does.
      if (batch.unflushed > 0) flush();
      const call = { t: 'call', id: callId, name, args: argsJson };
      // A wake takes no place among the calls in flight, so it needn't wait for a seen.
      if (held === null || wake) io.send(call);
      else if (held.length < MAX_CALLS_IN_FLIGHT) held.push(call);
      else {
        // A guest held to the prelude has at most that many calls out. One
        // that makes more, its promises replaced, would have them held
        // without bound: the rest go out at once, which the parent takes as
        // the protocol break it is, and the guest is stopped.
        stopped = true;
        io.send(call);
      }
    },
    interrupt() {
      const t = io.now();
      if (!stopped && t - lastStopCheck >= STOP_CHECK_MS) {
        lastStopCheck = t;
        stopped = existsSync(start.stopFile);
      }
      if (batch.unflushed > 0 && t - lastFlush >= start.flushMs) flush();
      return stopped;
    },
    supervise() {
      // A guest that computes doesn't let the child see its parent go, so
      // that's checked at the engine's interrupt checks, at most once a stop
      // check, a stop's included: a guest can keep a stop from ending it,
      // since QuickJS drops a stop it takes inside a stack hook or an
      // iterator's return, and only the parent kills a child that runs on.
      // The engine calls this first, so an orphan ends its process at once
      // rather than stop its guest. Output waiting to be sent goes with the
      // process: the parent that would read it is gone, and a write to it
      // could fail or block.
      const t = io.now();
      if (orphan || t - lastParentCheck < STOP_CHECK_MS) return;
      lastParentCheck = t;
      if (!io.parentGone?.()) return;
      orphan = true;
      io.orphaned?.();
      stopped = true;
    },
    output(_stream, text) {
      if (batch.write(text) || io.now() - lastFlush >= start.flushMs) flush();
    },
  };

  const engine: Engine = await loadEngine(
    { memoryMaxBytes: start.memoryMaxBytes, ...(start.maxStackBytes === undefined ? {} : { maxStackBytes: start.maxStackBytes }) },
    slots,
  );
  // The loop's own failure, if one is leaving it: dispose()'s, after it, is the lesser news.
  let failing = false;
  try {
    // The script's own ending: the first terminal state. Calls still in flight
    // when it ends are waited for, so each outcome reaches the record, and their
    // later states don't change how the script ended: a stop then ends the
    // wait, and the script's own ending is what's reported. A failure once the
    // script ran (`failed`: an exception escaped its promises) ends the run at
    // once, past an ending it kept: the engine takes nothing more.
    const terminal = (s: RunState) => s.kind === 'fulfilled' || s.kind === 'rejected';
    let ending = { kind: 'pending' } as RunState;
    let interrupted = false;
    const after = (next: RunState): void => {
      if (next.kind === 'interrupted') interrupted = true;
      if (next.kind === 'failed' || !terminal(ending)) ending = next;
    };
    const over = (): boolean => interrupted || ending.kind === 'failed';
    const settleLocal = (): void => {
      while (local.length > 0 && !over()) {
        const { id, json } = local.shift()!;
        outstanding.delete(id);
        after(engine.settle(id, false, json, json));
      }
    };
    after(engine.start(preludeSource(start.tools), scriptCall(start.script), SCRIPT_FILENAME));
    settleLocal();
    for (;;) {
      if (over() || stopped || outstanding.size === 0) {
        flush();
        // The value, or a failure's message and stack, cut as a return shows
        // them, so the ending's frame always fits whatever the script made.
        if (ending.kind === 'fulfilled') {
          // The prelude's run resolves to its value's JSON text, which the engine
          // gives as a JSON string: one layer off is the value's JSON.
          io.send(ending.json === undefined ? { t: 'end', how: 'finished' } : { t: 'end', how: 'finished', value: bounded(valueJson(ending.json), VALUE_CHARS) });
        } else if (ending.kind === 'rejected' || ending.kind === 'failed') {
          // The script's frames go apart from the name and message, each cut
          // on its own, so a cut never breaks which is which. Every failure's
          // stack is QuickJS's own, or one the script set, and is put as the
          // agent reads it here (scriptFrames), whether the script threw it or
          // it escaped the script's promises, and cut as it's read: the frames
          // go as scriptFrames gives them, cut once.
          const frames = ending.stack ? scriptFrames(ending.stack, VALUE_CHARS) : '';
          io.send({
            t: 'end',
            how: 'failed',
            error: {
              name: bounded(ending.name, NAME_CHARS),
              message: bounded(ending.message, VALUE_CHARS),
              ...(frames ? { stack: frames } : {}),
            },
          });
        } else if (interrupted || stopped) {
          io.send({ t: 'end', how: 'stopped' });
        } else {
          io.send({
            t: 'end',
            how: 'failed',
            stalled: true,
            error: {
              name: 'Error',
              message: 'The script is waiting on a promise that nothing can settle: no tool call is pending, and there are no timers here.',
            },
          });
        }
        return;
      }
      // The guest is idle until a call is answered: send its output so far.
      flush();
      const message = await io.next();
      if (message === null) return; // the parent is gone, and with it anyone to tell
      if (message.t === 'stop') {
        stopped = true;
        continue;
      }
      if (message.t !== 'result' || !outstanding.has(message.id)) continue;
      const name = outstanding.get(message.id)!;
      outstanding.delete(message.id);
      // A result the guest can't take, too large for its memory, nested too
      // deep or not parsed, reaches the script as ResultTooLarge, made here,
      // and the parent hears it wasn't seen. An answer that isn't ok is an
      // error the host gave in the result's place, such as a refusal.
      // The call as the script wrote it: a wake is wake_agent.
      const called = name === WAKE_CALL_NAME ? 'wake_agent' : name;
      // An error the host gave in the result's place keeps its name, such as
      // a refusal's, and its message's start: whether the call ran is in
      // them, read here, outside the guest.
      const unfit = message.ok
        ? JSON.stringify({
          name: RESULT_TOO_LARGE,
          message: `${called}'s result, ${message.json.length} bytes, couldn't be received by this script: it was ${unfitWhy(true)}; ` +
            'the call took effect, and none of its result reached the script. Calling it again would do the call again, its effect included, and likely bring the same result, so if the call only reads, ask the tool for less if it can',
          bytes: message.json.length,
        })
        : unfitAnswer(called, message.json);
      held = [];
      let state: SettleState;
      let calls: unknown[];
      try {
        state = engine.settle(message.id, message.ok, message.json, unfit);
      } finally {
        calls = held;
        held = null;
      }
      // A result that reached the script freed its call's place, as the
      // prelude has it, and its seen says so. One that never reached it
      // (`dropped`) has no seen: the script never had it, so the prelude
      // never freed its place, and what code QuickJS still runs as the stop
      // lands can't reach the host, since the engine refuses `__host` once
      // stopped. The run's end counts the answer as one the script didn't
      // read (Gladys-2592, room-203 #159239, #162129).
      if (!state.dropped) io.send(state.unfit ? { t: 'seen', id: message.id, unfit: true } : { t: 'seen', id: message.id });
      for (const call of calls) io.send(call);
      after(state);
      settleLocal();
    }
  } catch (err) {
    failing = true;
    throw err;
  } finally {
    try {
      engine.dispose();
    } catch (err) {
      if (!failing) throw err;
    }
  }
}

/** An error the host gave in a result's place, which the guest couldn't take: its name and its message's start, read in the child. */
function unfitAnswer(tool: string, json: Uint8Array): string {
  let name = RESULT_TOO_LARGE;
  let message = '';
  let parsed = false;
  try {
    const answer = JSON.parse(new TextDecoder().decode(json)) as { name?: unknown; message?: unknown };
    parsed = true;
    if (typeof answer.name === 'string' && answer.name) name = bounded(answer.name, NAME_CHARS);
    if (typeof answer.message === 'string') message = glimpse(answer.message, UNFIT_GLIMPSE_CHARS);
  } catch {
    // Not readable here either: only its size and the tool are known.
  }
  return JSON.stringify({
    name,
    message: `${message ? `${message} ` : `${tool}'s answer `}(the host's answer, ${json.length} bytes, couldn't be received by this script whole: it was ${unfitWhy(!parsed)})`,
    bytes: json.length,
  });
}

/** Why the guest couldn't take an answer: what the engine refuses, less what the child has ruled out. */
function unfitWhy(couldBeJson: boolean): string {
  return couldBeJson
    ? `too large for its memory, nested deeper than ${MAX_RESULT_DEPTH} levels, or not valid JSON`
    : `too large for its memory, or nested deeper than ${MAX_RESULT_DEPTH} levels`;
}

/** How much of an unfit answer's message reaches the script. */
const UNFIT_GLIMPSE_CHARS = 2000;
