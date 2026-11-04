/**
 * code_execution's engine binding: QuickJS-ng compiled to WebAssembly (`quickjs.wasm`, built by
 * `engine/build.sh` from the quickjs-ng release it pins and `engine/interface.c`), loaded into the child
 * process that runs one script.
 *
 * The guest reaches nothing outside JavaScript except three of the slots the child fills: a host
 * call, the interrupt check and output. The fourth, supervision, the guest can't reach: the engine
 * calls it at each interrupt check. Only text crosses them: a tool's name and its arguments as
 * JSON, output, and each result's JSON on the way back in. The module's memory is made here, with
 * the maximum the child is given, so that maximum bounds everything the guest holds.
 */
import { readFile } from 'node:fs/promises';
import { randomFillSync } from 'node:crypto';

/** What the child sets once, before any script code runs. */
export interface EngineLimits {
  /**
   * The linear memory's maximum, the guest's budget: a whole number of 64 KiB pages, from
   * `MIN_MEMORY_BYTES` to `MAX_MEMORY_BYTES`. The engine's own stack and data take its first ~1.1 MiB, and
   * QuickJS's allocation limit sits a margin below the rest, so that a script reaching it gets a
   * catchable out-of-memory error rather than a failed allocation inside the engine.
   */
  memoryMaxBytes: number;
  /** QuickJS's stack limit, at most `MAX_STACK_BYTES`; `DEFAULT_STACK_BYTES` when left out. */
  maxStackBytes?: number;
}

/**
 * The four imports, as slots the child fills. Each is called synchronously from inside the
 * engine, so none may await, and none may call back into the engine: a call into it from a slot
 * throws an `EngineError`. A slot that throws ends the run: the call in progress throws that
 * error, wrapped as an `EngineError`, and no slot is called again but `supervise()`.
 */
export interface EngineSlots {
  /**
   * The guest called `__host(name, argsJson)`, which returned a pending promise to the guest.
   * `callId` names that promise for `settle`. Ids are the engine's, 1, 2, 3 and on.
   */
  hostCall(callId: number, name: string, argsJson: string): void;
  /**
   * Called while the guest runs, every few thousand of its operations. Return true to stop it for
   * good: the engine doesn't ask again, the call in progress answers `interrupted`, and so does
   * every call after, with two exceptions. A stop in the jobs that reading the script's ending
   * queued, after the ending was read whole, lets that call answer the ending, and the calls after
   * it answer `interrupted`. And a run answered `failed` stays so, a stop while its exception is
   * read included; a throw as the run starts is the script's own ending, answered `rejected`, which
   * a stop while it's read turns into `interrupted`, as for any rejection.
   */
  interrupt(): boolean;
  /**
   * Called at every interrupt check, before `interrupt()` is asked, and after it has said stop or a
   * slot has failed, when it's asked no more: the child's watch over its own process, such as its
   * parent going, which no stop or failure ends, since a script can keep a stop from landing. It
   * returns nothing: a stop it calls for comes through `interrupt()`. One that throws ends the run
   * as any slot's failure, and is still called at the checks after.
   */
  supervise(): void;
  /** The guest called `__output(stream, text)`: stream 1 is out, 2 is err. */
  output(stream: 1 | 2, text: string): void;
}

/** How a call into the guest left it. */
export type RunState =
  /** The queue is empty and the script hasn't settled: it awaits a call, or a promise nothing settles. */
  | { kind: 'pending' }
  /**
   * The script settled. `json` is JSON.stringify of its value, undefined when that gives none. It's
   * taken once: every later answer of this state carries the same text.
   */
  | { kind: 'fulfilled'; json: string | undefined }
  /**
   * The prelude or the script threw, or its value couldn't be stringified (a BigInt, a cycle).
   * The fields are what was thrown: an Error's name, message and stack. A thrown value with no
   * message of its own has name `''`, and as its message an object's JSON, or else its string
   * form; a Symbol, which has none here, leaves the message `''`.
   */
  | { kind: 'rejected'; name: string; message: string; stack?: string }
  /**
   * Once the script was running, an exception escaped its promises and ended the run, even after
   * its own ending: a callback it gave `queueMicrotask` or a `FinalizationRegistry` threw, or a job
   * failed in the engine itself; or the engine couldn't settle a call. The fields are the
   * exception's, read as the engine reads a `rejected` one (an Error's name, message and stack; a
   * value with no message of its own, its JSON or string form), less any part a stop cut off while
   * it was read: a stop ends the read, and nothing after it is read. Every later call answers
   * the same, a stop after it included, and no later result reaches the script.
   */
  | { kind: 'failed'; name: string; message: string; stack?: string }
  /** `interrupt()` returned true while it ran. */
  | { kind: 'interrupted' };

/**
 * What `settle` answers: the run's state; `unfit` when the guest couldn't take the result, for
 * want of memory to copy it in or of memory or stack to parse it, and the call took the child's
 * own error instead; and `dropped` when neither was handed over, because the run had been stopped
 * or had failed before this settle (`interrupted` or `failed`), or the call of the promise's
 * resolve or reject function was stopped or failed before it ran. Without `dropped`, that function
 * ran with the result or the child's error, and the script's own code runs with it: a `then`
 * getter it put on Object.prototype, which can reject the promise instead, and its continuations.
 * A stop or failure in that code, or in the jobs after, leaves it handed over. The two are never
 * both set.
 */
export type SettleState = RunState & { unfit?: true; dropped?: true };

export interface Engine {
  /**
   * Evaluates the prelude as a global script, then the script as global code with top-level
   * await, then runs pending jobs until none is left, the guest is interrupted or the run fails.
   * The script's value is that of its last expression statement. Called once.
   */
  start(prelude: string, script: string, filename: string): RunState;
  /**
   * Settles call `callId`, then runs pending jobs as `start` does. With `ok`, the call's promise
   * resolves to the parsed JSON; otherwise it rejects with it, and the prelude makes an Error of
   * it. A result the guest can't take, for want of memory to copy it in or of memory or stack to
   * parse it, nested deeper than `MAX_RESULT_DEPTH`, or not JSON, rejects it with `unfitJson`
   * parsed, the child's own error (`ResultTooLarge`), and the answer has `unfit: true`: the call
   * took effect, and an error at its await would read as a failed call. Allowed after `fulfilled`,
   * for calls still in flight when a script returned. Throws for an id that isn't pending.
   *
   * Once a call has answered the script's ending, later calls answer it again, unless something
   * came after it: a stop answers `interrupted`, a slot's failure throws, and an exception that
   * escapes the script's promises answers `failed`. One that escapes the jobs reading the ending
   * queued is answered by the call that read it, in the ending's place.
   */
  settle(callId: number, ok: boolean, json: string | Uint8Array, unfitJson: string): SettleState;
  /** Frees the engine's runtime, unless the module trapped, which leaves it as it is. Nothing may be called after it. */
  dispose(): void;
}

/** The engine failed, rather than the script: a slot threw, the engine crashed, or it was misused. */
export class EngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineError';
  }
}

const PAGE = 65536;
/** The link-time stack, at the start of linear memory (engine/build.sh). */
const LINK_STACK_BYTES = 1024 * 1024;
export const MIN_MEMORY_BYTES = 4 * 1024 * 1024;
/**
 * 2 GiB, so that every address in linear memory fits the signed 32-bit numbers the module's
 * pointers arrive as, and no conversion is needed where the host reads them.
 */
export const MAX_MEMORY_BYTES = 2048 * 1024 * 1024;
/**
 * The most QuickJS's stack limit may be, and its default. QuickJS measures its stack in the
 * module's linear memory, but each level of a script's recursion through calls also takes the
 * host's own stack, two to three times as much in the 31 ways to recurse that were measured, and
 * under Node that stack is about 984 KiB. Recursing through a getter, a proxy trap or a built-in
 * that calls back (map, toString, for...of), the host's stack ran out first, crashing the engine,
 * once QuickJS's limit passed about 320 KiB. At this limit, QuickJS's catchable RangeError comes
 * first in each of the 31, with about two fifths of the host's stack to spare. Bun's stack is
 * larger, and the same limit holds there, so recursion through calls ends the same way on either.
 *
 * Recursion in C that the check barely sees isn't held to it, and under Node crashes the run, the
 * host's stack running out: a script's text nesting function expressions 300 deep or brackets 700
 * deep (the parser), a chain of 3,000 iterator helpers, and the script's own data nested about
 * 5,000 deep in JSON.stringify (4,000 with V8's optimizing tier alone), as a call's arguments
 * are, or about 8,000 deep in JSON.parse (5,000; see MAX_RESULT_DEPTH). Under Bun, whose stack
 * is larger, QuickJS's check ends JSON's recursion first, with a RangeError the script can catch,
 * from about 15,000 deep, though a parse nested 22,000 deep still runs Bun's stack out. Each
 * iterator helper's next calls the one before directly, past QuickJS's checks, so under Bun a
 * chain of 30,000 runs the module's own 1 MiB stack out instead, and the module traps: the stack
 * sits first in its memory, so an overflow wraps below address 0 to past the memory's end.
 */
export const MAX_STACK_BYTES = 192 * 1024;
export const DEFAULT_STACK_BYTES = MAX_STACK_BYTES;
/**
 * The deepest nesting of arrays and objects a result may have. QuickJS's stack check measures the
 * module's own stack, which the C recursion of JSON's parse and stringify barely uses, so under
 * Node a parse nested about 8,000 deep (5,000 with V8's optimizing tier alone) overflows the
 * host's stack first, and the engine crashes (under Bun, QuickJS's check comes first). A deeper
 * result is unfit, since the call took effect. A script's own data isn't held to this, and nested
 * thousands deep, it can crash its own run (see MAX_STACK_BYTES).
 */
export const MAX_RESULT_DEPTH = 2000;
/** The most of the engine's own stdio a crash's message keeps. */
const DIAGNOSTICS_CHARS = 4096;
/**
 * The longest ending text the binding decodes, in UTF-8 bytes: V8's longest string, 2^29 - 24
 * characters (Node's `buffer.constants.MAX_STRING_LENGTH`), which a text of this many bytes can't
 * exceed. Node can't decode a longer one. Bun's longest string is 2^31 - 1, and the same bound
 * holds there, so a script ends the same way on either. A longer text is answered with a
 * RangeError that gives its length: `rejected` for the script's own ending, its value's or what it
 * threw, and `failed` for an exception that ended the run.
 */
const MAX_ENDING_BYTES = 2 ** 29 - 24;

// interface.c's states and failures.
const PENDING = 0, FULFILLED = 1, REJECTED = 2, INTERRUPTED = 3, HOST_FAILED = 4, FAILED = 5;
const UNFIT = 16, DROPPED = 32;
const MISUSE = -1, NO_MEMORY = -2, UNKNOWN_CALL = -3;

interface Exports {
  _initialize(): void;
  engine_init(memoryLimit: number, stackSize: number): number;
  engine_start(prelude: number, preludeLen: number, script: number, scriptLen: number, filename: number): number;
  engine_settle(id: number, ok: number, json: number, jsonLen: number, unfit: number, unfitLen: number): number;
  engine_result(): number;
  engine_state(): number;
  engine_alloc(size: number): number;
  engine_free(ptr: number): void;
  engine_dispose(): void;
}

/**
 * The part of the WebAssembly API this file uses. The repository's `lib` has no DOM, which is
 * where TypeScript declares WebAssembly, and Node and Bun both provide it at runtime.
 */
interface Wasm {
  Memory: new (descriptor: { initial: number; maximum: number }) => { readonly buffer: ArrayBuffer };
  compile(bytes: Uint8Array): Promise<object>;
  instantiate(module: object, imports: Record<string, Record<string, unknown>>): Promise<{ exports: Record<string, unknown> }>;
}
const Wasm = (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

let compiled: Promise<object> | undefined;

/** The committed module, compiled once per process. */
function engineModule(): Promise<object> {
  compiled ??= readFile(new URL('./quickjs.wasm', import.meta.url)).then((bytes) => Wasm.compile(bytes));
  return compiled;
}

/** Whether JSON text nests arrays and objects deeper than `limit`. */
function nestsDeeper(json: string | Uint8Array, limit: number): boolean {
  // The characters that count are ASCII, so UTF-8 bytes and UTF-16 code units read alike.
  const at = typeof json === 'string' ? (i: number) => json.charCodeAt(i) : (i: number) => json[i];
  let depth = 0, inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = at(i);
    if (inString) {
      if (c === 0x5c) i++; // a backslash escapes the next character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > limit) return true;
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return false;
}

/** QuickJS's allocation limit for a given linear maximum: the stack and data, then a margin. */
function quickjsMemoryLimit(memoryMaxBytes: number): number {
  return memoryMaxBytes - LINK_STACK_BYTES - 1024 * 1024 - Math.floor(memoryMaxBytes / 32);
}

/** Instantiates the committed module with these limits and slots. One instance per child. */
export async function loadEngine(limits: EngineLimits, slots: EngineSlots): Promise<Engine> {
  const { memoryMaxBytes } = limits;
  const stackBytes = limits.maxStackBytes ?? DEFAULT_STACK_BYTES;
  if (!Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes % PAGE !== 0 ||
      memoryMaxBytes < MIN_MEMORY_BYTES || memoryMaxBytes > MAX_MEMORY_BYTES) {
    throw new RangeError(`memoryMaxBytes must be a whole number of 64 KiB pages from ${MIN_MEMORY_BYTES} to ${MAX_MEMORY_BYTES}, not ${memoryMaxBytes}`);
  }
  if (!Number.isSafeInteger(stackBytes) || stackBytes < 16 * 1024 || stackBytes > MAX_STACK_BYTES) {
    throw new RangeError(`maxStackBytes must be from 16384 to ${MAX_STACK_BYTES}, not ${stackBytes}`);
  }

  const memory = new Wasm.Memory({ initial: Math.ceil((LINK_STACK_BYTES + 2 * PAGE) / PAGE), maximum: memoryMaxBytes / PAGE });
  // ignoreBOM, so text that starts with U+FEFF keeps it.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const encoder = new TextEncoder();
  /** Whether a slot threw, and what: a slot may throw anything, undefined included. */
  let slotFailed = false;
  let slotError: unknown;
  let broken: EngineError | undefined;
  /** What the engine wrote before it crashed. */
  let diagnostics = '';
  /** A call into the module is in progress, so a slot is the only thing that can call again. */
  let busy = false;
  /** interrupt() has returned true: the guest is stopped for good. */
  let stopped = false;
  /** The module trapped, so its state may be anything, and it isn't called again. */
  let crashed = false;

  /**
   * A view of the module's memory. A corrupted guest could pass any pointer, and the view's own
   * bounds check throws a RangeError for one outside the memory, which ends the run as a slot's
   * failure. Made at each read, since a growing memory replaces its buffer.
   */
  const bytes = (ptr: number, len: number): Uint8Array => new Uint8Array(memory.buffer, ptr, len);
  const text = (ptr: number, len: number) => decoder.decode(bytes(ptr, len));
  /** Runs a slot. A throw is kept, and the engine told the slot failed. */
  const guard = (fn: () => void): number => {
    if (slotFailed) return 1;
    try {
      fn();
      return 0;
    } catch (err) {
      slotFailed = true;
      slotError = err;
      return 1;
    }
  };

  const EBADF = 8, EINVAL = 28, ESPIPE = 70;
  const env = {
    memory,
    host_call: (id: number, name: number, nameLen: number, args: number, argsLen: number) =>
      guard(() => slots.hostCall(id >>> 0, text(name, nameLen), text(args, argsLen))),
    // Once a slot has failed, this stops the guest at its next check.
    host_interrupt: () => {
      if (slotFailed) return 1;
      try {
        if (!slots.interrupt()) return 0;
        stopped = true;
        return 1;
      } catch (err) {
        slotFailed = true;
        slotError = err;
        return 1;
      }
    },
    host_output: (stream: number, ptr: number, len: number) =>
      guard(() => slots.output(stream === 2 ? 2 : 1, text(ptr, len))),
    // Not an ordinary slot: a slot's failure doesn't end it, so a guest that keeps its stop from
    // landing is still watched.
    host_supervise: () => {
      try {
        slots.supervise();
      } catch (err) {
        if (!slotFailed) {
          slotFailed = true;
          slotError = err;
        }
      }
    },
  };
  // The few WASI calls libc makes: the clocks (the real-time one for Date.now and the seed QuickJS
  // gives Math.random, the monotonic one for performance.now), four random bytes libc asks for
  // once as the module loads, and stdio, which only the engine's own diagnostics reach (an
  // assertion's message before it traps).
  const wasi = {
    clock_time_get: (id: number, _precision: bigint, out: number) => {
      let ns: bigint;
      if (id === 0) ns = BigInt(Date.now()) * 1_000_000n;
      else if (id >= 1 && id <= 3) ns = process.hrtime.bigint();
      else return EINVAL;
      new DataView(memory.buffer).setBigUint64(bytes(out, 8).byteOffset, ns, true);
      return 0;
    },
    random_get: (ptr: number, len: number) => {
      randomFillSync(bytes(ptr, len));
      return 0;
    },
    fd_write: (fd: number, iovs: number, iovsLen: number, written: number) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const view = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = view.getUint32(bytes(iovs + i * 8, 8).byteOffset, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        // Kept to DIAGNOSTICS_CHARS in all, clipped before decoding: each byte is at most a char.
        const room = DIAGNOSTICS_CHARS - diagnostics.length;
        if (room > 0) diagnostics += text(base, Math.min(len, room));
        total += len;
      }
      view.setUint32(bytes(written, 4).byteOffset, total, true);
      return 0;
    },
    fd_fdstat_get: (fd: number, out: number) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const b = bytes(out, 24);
      b.fill(0);
      b[0] = 2; // a character device, so stdio writes unbuffered lines
      return 0;
    },
    fd_seek: (fd: number) => (fd === 1 || fd === 2 ? ESPIPE : EBADF),
    fd_close: () => EBADF,
  };

  const instance = await Wasm.instantiate(await engineModule(), { env, wasi_snapshot_preview1: wasi });
  const ex = instance.exports as unknown as Exports;

  /**
   * Calls into the module. A trap leaves the engine broken, and every later call throws its error.
   * One made from inside a slot, while another is in progress, is refused: the two would share the
   * module's state.
   */
  const call = <T>(what: string, fn: () => T): T => {
    if (broken) throw broken;
    if (busy) throw new EngineError(`${what} was called from inside one of the engine's slots, which may not call back into it`);
    busy = true;
    let out: T;
    try {
      out = fn();
    } catch (err) {
      if (err instanceof EngineError) throw err;
      // A trap, or an exception in reading what the module returned, which it only throws when the
      // module returned something it couldn't have made whole: either way the module can't be
      // taken as whole, so dispose() leaves it as it is.
      crashed = true;
      // A slot that failed first is why: the guest ran on, refused, until the module trapped.
      if (slotFailed) return slotFailure(what);
      const why = diagnostics.trim();
      broken = new EngineError(`the engine crashed in ${what}: ${describe(err)}${why ? ` (${why})` : ''}`, { cause: err });
      throw broken;
    } finally {
      busy = false;
    }
    return out;
  };
  /** A thrown value as text, for a message: it may have no string form, or one that throws. */
  const describe = (err: unknown): string => {
    try {
      return String(err instanceof Error ? err.message : err);
    } catch {
      return 'a value with no string form';
    }
  };
  /** Copies text, or UTF-8 bytes, into the module with the NUL its C expects. The caller frees it, or hands it to engine_settle, which does. */
  const put = (value: string | Uint8Array): { ptr: number; len: number } => {
    const len = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;
    const ptr = ex.engine_alloc(len + 1);
    if (ptr === 0) return { ptr: 0, len };
    const dst = new Uint8Array(memory.buffer, ptr, len + 1);
    if (typeof value === 'string') encoder.encodeInto(value, dst);
    else dst.set(value);
    dst[len] = 0;
    return { ptr, len };
  };
  /** The ending's text, or its length alone when it's too long to decode, or nothing when the module couldn't make it. */
  const result = (): { kind: number; text: string } | { kind: number; tooLong: number } | undefined => {
    const ptr = ex.engine_result();
    if (ptr === 0) return undefined;
    const view = new DataView(memory.buffer);
    const kind = view.getUint32(ptr, true);
    const len = view.getUint32(ptr + 4, true);
    if (len > MAX_ENDING_BYTES) {
      ex.engine_free(ptr);
      return { kind, tooLong: len };
    }
    const out = decoder.decode(new Uint8Array(memory.buffer, ptr + 8, len));
    ex.engine_free(ptr);
    return { kind, text: out };
  };
  const errorState = (json: string, kind: 'rejected' | 'failed'): RunState => {
    const e = JSON.parse(json) as { name?: string; message?: string; stack?: string };
    const state: { kind: 'rejected' | 'failed'; name: string; message: string; stack?: string } =
      { kind, name: e.name ?? '', message: e.message ?? '' };
    if (typeof e.stack === 'string') state.stack = e.stack;
    return state;
  };
  /** What an ending that can't be read out is answered with, by what it is. */
  const unread = {
    [FULFILLED]: {
      memory: 'out of memory while serializing the script\'s return value; return less, or let go of data the script no longer needs',
      long: (n: number) => `the script's return value comes to ${n} bytes as text, more than the ${MAX_ENDING_BYTES} the engine reads back; return less`,
    },
    [REJECTED]: {
      memory: 'out of memory while reading what the script threw; throw something smaller, such as an Error with a shorter message, or let go of data the script no longer needs',
      long: (n: number) => `what the script threw comes to ${n} bytes as text, more than the ${MAX_ENDING_BYTES} the engine reads back; throw something smaller`,
    },
    [FAILED]: {
      memory: 'out of memory while reading the exception that ended the run; let go of data the script no longer needs, and if a callback given to queueMicrotask or a FinalizationRegistry threw it, throw something smaller or catch it there',
      long: (n: number) => `the exception that ended the run comes to ${n} bytes as text, more than the ${MAX_ENDING_BYTES} the engine reads back; if a callback given to queueMicrotask or a FinalizationRegistry threw it, throw something smaller or catch it there`,
    },
  } as const;
  /**
   * Each ending as it was first read. Reading one serializes the script's value or error in the
   * guest, which can run the script's own code (a toJSON, a getter), and every settle after the
   * script has ended answers that ending again: read once, that code runs once.
   */
  const endings = new Map<number, RunState>();
  /** The run ended because a slot threw. */
  const slotFailure = (what: string): never => {
    broken = new EngineError(`a slot threw during ${what}: ${describe(slotError)}`, { cause: slotError });
    throw broken;
  };
  /** Reads a state code into a RunState, or throws for the engine's own failures. */
  const toState = (code: number, what: string): RunState => {
    switch (code) {
      case PENDING:
        return { kind: 'pending' };
      case INTERRUPTED:
        // A slot's failure stops the guest through the interrupt, so this can be that failure.
        if (slotFailed) return slotFailure(what);
        return { kind: 'interrupted' };
      case FULFILLED:
      case REJECTED:
      case FAILED: {
        // Each kept under its own code, so a failure after the script's own ending is read anew.
        const known = endings.get(code);
        if (known) return { ...known };
        const r = result();
        // Reading runs the interrupt slot, which can throw, or stop the guest. A stop that lands
        // while the script's own ending is read leaves none to give (the module returns nothing),
        // so this call answers as any call does in which that happens. One that lands in the jobs
        // the read queued comes after a whole ending, which this call answers. An exception
        // escaping those jobs ends the run after its ending, and is what this call answers. An
        // exception that ended the run is read with the parts a stop cut off left out.
        if (slotFailed) return slotFailure(what);
        if (code !== FAILED) {
          if (ex.engine_state() === FAILED) return toState(FAILED, what);
          if (!r && stopped) return { kind: 'interrupted' };
        }
        const kind = code === FAILED ? 'failed' : 'rejected';
        const state: RunState = !r ? { kind, name: 'InternalError', message: unread[code].memory }
          : 'tooLong' in r ? { kind, name: 'RangeError', message: unread[code].long(r.tooLong) }
          : r.kind === 0 ? { kind: 'fulfilled', json: undefined }
          : r.kind === 1 ? { kind: 'fulfilled', json: r.text }
          : errorState(r.text, kind);
        endings.set(code, state);
        return { ...state };
      }
      case HOST_FAILED:
        return slotFailure(what);
      case UNKNOWN_CALL:
        throw new EngineError(`${what}: no pending call with that id`);
      case NO_MEMORY:
        broken = new EngineError(`${what}: the engine ran out of memory for its own state`);
        throw broken;
      case MISUSE:
      default:
        throw new EngineError(`${what}: the engine refused the call (${code})`);
    }
  };

  call('initialization', () => ex._initialize());
  const init = call('initialization', () => ex.engine_init(quickjsMemoryLimit(memoryMaxBytes), stackBytes));
  if (init !== 0) throw new EngineError(`the engine couldn't initialize (${init})`);

  let started = false;
  let disposed = false;
  const live = (what: string) => {
    if (disposed) throw new EngineError(`${what} after dispose()`);
  };

  return {
    start(prelude, script, filename) {
      live('start()');
      if (broken) throw broken;
      if (started) throw new EngineError('start() was already called');
      started = true;
      return call('start()', () => {
        const p = put(prelude), s = put(script), f = put(filename);
        try {
          if (!p.ptr || !s.ptr || !f.ptr) return { kind: 'rejected', name: 'InternalError', message: 'out of memory while loading the script' } as RunState;
          return toState(ex.engine_start(p.ptr, p.len, s.ptr, s.len, f.ptr), 'start()');
        } finally {
          for (const b of [p, s, f]) if (b.ptr) ex.engine_free(b.ptr);
        }
      });
    },
    settle(callId, ok, json, unfitJson) {
      live('settle()');
      if (broken) throw broken;
      if (!started) throw new EngineError('settle() before start()');
      if (callId >>> 0 !== callId) throw new EngineError(`settle(): ${callId} isn't a call id`);
      return call('settle()', () => {
        // The small error first, so a result that takes the last of the memory leaves it room,
        // and once more if refused: the refusal opens the allocator's headroom, which it fits in.
        // A copy the module can't make room for goes as a null pointer, and so does a result
        // nested too deeply to parse. The module frees both copies, each as soon as it's parsed.
        let u = put(unfitJson);
        if (!u.ptr) u = put(unfitJson);
        const j = nestsDeeper(json, MAX_RESULT_DEPTH) ? { ptr: 0, len: 0 } : put(json);
        const code = ex.engine_settle(callId, ok ? 1 : 0, j.ptr, j.len, u.ptr, u.len);
        if (code < 0) return toState(code, 'settle()');
        const state: SettleState = toState(code & ~(UNFIT | DROPPED), 'settle()');
        if (code & UNFIT) state.unfit = true;
        if (code & DROPPED) state.dropped = true;
        return state;
      });
    },
    dispose() {
      if (disposed) return;
      // Refused from inside a slot, it isn't marked done, so it can be made again.
      if (busy) throw new EngineError('dispose() was called from inside one of the engine\'s slots, which may not call back into it');
      // A module whose call ended in an exception, a trap or otherwise, may have stopped anywhere,
      // so it's left as it is. One that ended for a slot's failure, or for want of memory for its
      // own state, is whole, and frees its runtime.
      if (!crashed) {
        busy = true;
        try {
          ex.engine_dispose();
        } catch (err) {
          crashed = true;
          disposed = true;
          broken = new EngineError(`the engine crashed in dispose(): ${describe(err)}`, { cause: err });
          throw broken;
        } finally {
          busy = false;
        }
      }
      disposed = true;
    },
  };
}
