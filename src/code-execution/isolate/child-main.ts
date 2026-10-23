/**
 * The child's process: reads the parent's frames on stdin, writes its own on
 * fd 3, runs the script with the engine, and exits. Spawned by the parent with
 * the parent's own runtime (`process.execPath`), Node's or Bun's.
 *
 * The channel is the one way that works the same under both runtimes, as
 * probes under Bun 1.4.3, Node 24.19.0 and Node 20.20.2 showed: a socket on
 * another fd reads nothing under Bun, and a file stream on one leaves Node's
 * exit waiting on a blocked read. The child writes with `writeSync`, since its slots run while
 * the engine is mid-call, and output has to reach the parent while a guest
 * computes without queuing in memory.
 *
 * `runChildProcess` takes the engine loader so a test can spawn a child whose
 * engine is a stand-in; the entry the parent spawns in production passes the
 * engine's binding.
 */

import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { EngineError, MAX_MEMORY_BYTES } from '../engine.js';
import { runChild, type ChildIo, type LoadEngine } from './child.js';
import { encodeFrame, FrameDecoder, RESULT_FRAME_OVERHEAD } from './frames.js';
import { MAX_CHILD_FRAME_BYTES, type ParentMessage, type StartMessage } from './protocol.js';

const TO_PARENT_FD = 3;

/**
 * The largest frame the child takes from its parent: a result as large as the
 * largest memory can be given (a third of it, as the parent bounds a result),
 * with its header. The parent is trusted; this only bounds a broken one.
 */
const MAX_PARENT_FRAME_BYTES = Math.floor(MAX_MEMORY_BYTES / 3) + RESULT_FRAME_OVERHEAD;

/** A shared buffer to wait on, so a full pipe is retried after a short sleep without the event loop. */
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Write all of `buf` to `fd`, synchronously, waiting a moment when the pipe is full. */
function writeAll(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw err;
      Atomics.wait(sleeper, 0, 0, 1);
    }
  }
}

/** The parent's frames, as messages, from the child's stdin. The parent's frames are trusted: a bad one ends the child. */
function parentFrames(): () => Promise<ParentMessage | null> {
  const decoder = new FrameDecoder(MAX_PARENT_FRAME_BYTES, true);
  const queue: ParentMessage[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const stream = process.stdin;
  stream.on('data', (chunk) => {
    try {
      for (const value of decoder.push(chunk as Buffer)) queue.push(value as ParentMessage);
    } catch (err) {
      failure = err as Error;
    }
    wake?.();
  });
  const finish = () => {
    ended = true;
    wake?.();
  };
  stream.on('end', finish);
  stream.on('error', (err) => {
    failure = err;
    finish();
  });
  return async () => {
    for (;;) {
      if (failure) throw failure;
      const next = queue.shift();
      if (next) return next;
      if (ended) return null;
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });
    }
  };
}

export async function runChildProcess(loadEngine: LoadEngine): Promise<number> {
  const next = parentFrames();
  const first = await next();
  if (first === null) return 0;
  if (first.t !== 'start') throw new Error('the first frame from the parent was not a start');
  const start = first as StartMessage;
  const io: ChildIo = {
    next,
    // Against the parent's cap, so the two can't drift apart.
    send: (message) => writeAll(TO_PARENT_FD, encodeFrame(message, MAX_CHILD_FRAME_BYTES)),
    now: () => performance.now(),
    // On Linux and macOS an orphan is reparented, so its parent's pid isn't
    // the one the start named once its parent has gone, even if that went
    // before this ran. Windows keeps the pid, so an orphan isn't seen there.
    parentGone: () => process.ppid !== start.parentPid,
    orphaned: () => process.exit(0),
  };
  await runChild(io, start, loadEngine);
  return 0;
}

/**
 * The child's process as the parent spawns it: run the script, and exit. An
 * engine that fails, rather than the script, ends the child with its reason
 * on one line of stderr, which the parent puts in the crash it reports; any
 * other throw is a fault here, and its stack goes there instead.
 */
export function childMain(loadEngine: LoadEngine): void {
  runChildProcess(loadEngine).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Written at once: a write to a pipe is asynchronous on macOS, and the exit would drop it.
      try {
        writeSync(2, err instanceof EngineError ? `${err.message}\n` : `${err instanceof Error ? err.stack : String(err)}\n`);
      } catch {
        // The parent learns of the crash from the exit either way.
      }
      process.exit(1);
    },
  );
}
