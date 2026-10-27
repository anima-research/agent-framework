/**
 * A stand-in for the engine binding, on `node:vm`, for testing the host's side
 * of the isolate without the engine. It keeps the binding's contract: the
 * four slots, `start` and `settle` answering a RunState once their jobs have
 * run, and a stop through `interrupt()`, with `supervise()` at every check. It's no boundary, and its interrupt
 * is cooperative: a guest that spins calls `__tick()` in its loop, which asks
 * `interrupt()` as the real engine's handler would. `__crash()` ends the
 * child's process, as a crash would, and `__exists(path)` lets a test hold a
 * computing guest until it makes a file.
 */

import { existsSync } from 'node:fs';
import vm from 'node:vm';
import type { Engine, EngineSlots, RunState } from '../../src/code-execution/engine.js';
import type { LoadEngine } from '../../src/code-execution/isolate/child.js';

const HOST_SIDE = `
globalThis.__state = { kind: 'pending' };
const __pending = new Map();
globalThis.__host = (name, json) => {
  const id = __hostCall(name, json);
  return new Promise((resolve, reject) => { __pending.set(id, { resolve, reject }); });
};
globalThis.__output = (stream, text) => __outputCall(stream, text);
globalThis.__tick = () => { if (__interruptCall()) throw new Error('interrupted'); };
globalThis.__crash = () => __crashCall();
globalThis.__exists = (path) => __existsCall(path);
globalThis.__settle = (id, ok, json) => {
  const entry = __pending.get(id);
  if (!entry) throw new Error('no pending call ' + id);
  __pending.delete(id);
  const value = JSON.parse(json);
  if (ok) entry.resolve(value); else entry.reject(value);
};
`;

export const loadFakeEngine: LoadEngine = async (_limits, slots: EngineSlots): Promise<Engine> => {
  let nextId = 1;
  let interrupted = false;
  const context = vm.createContext(
    {
      __hostCall: (name: string, json: string) => {
        const id = nextId++;
        slots.hostCall(id, name, json);
        return id;
      },
      __outputCall: (stream: 1 | 2, text: string) => slots.output(stream === 2 ? 2 : 1, String(text)),
      // As the real engine's interrupt check: supervision first, at every check, and once it
      // has a stop, interrupt() is asked no more.
      __interruptCall: () => {
        slots.supervise();
        if (!interrupted && slots.interrupt()) interrupted = true;
        return interrupted;
      },
      // The child's process ending mid-script, as a crash of the real engine would.
      __crashCall: () => process.exit(7),
      // Whether a file exists, so a test can hold a computing guest until it says so.
      __existsCall: (path: string) => existsSync(String(path)),
    },
    { microtaskMode: 'afterEvaluate' },
  );
  vm.runInContext(HOST_SIDE, context);

  const state = (): RunState => {
    if (interrupted) return { kind: 'interrupted' };
    const s = (context as { __state: RunState }).__state;
    return { ...s };
  };

  return {
    start(prelude, script) {
      try {
        vm.runInContext(prelude, context, { filename: '<prelude>' });
        // vm scripts have no top-level await: the line runs inside an async arrow, whose settling sets __state.
        vm.runInContext(
          `(async () => { ${script.replace(/^await /, 'return await ')} })().then(
            (v) => { globalThis.__state = { kind: 'fulfilled', json: v === undefined ? undefined : JSON.stringify(v) }; },
            (e) => { globalThis.__state = { kind: 'rejected', name: e instanceof Error ? String(e.name) : '', message: e instanceof Error ? String(e.message) : String(e), stack: e instanceof Error ? e.stack : undefined }; });`,
          context,
          { filename: 'script.js' },
        );
      } catch (e) {
        if (!interrupted) {
          const err = e as Error;
          (context as { __state: RunState }).__state = { kind: 'rejected', name: err.name ?? '', message: err.message ?? String(e) };
        }
      }
      return state();
    },
    settle(callId, ok, json) {
      const text = typeof json === 'string' ? json : Buffer.from(json.buffer, json.byteOffset, json.byteLength).toString('utf8');
      vm.runInContext(`__settle(${callId}, ${ok}, ${JSON.stringify(text)})`, context);
      return state();
    },
    dispose() {},
  };
};
