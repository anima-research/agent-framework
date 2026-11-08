/**
 * Worker that runs agents' suppress-rule scripts (`suppress.script`, see
 * suppress-scripts.ts).
 *
 * As with gate.js, the agent is trusted (it has shell and filesystem
 * already), so this is a robustness boundary, not a security sandbox: on a
 * thread of its own, a script that loops or hangs is timed out by the main
 * thread (Atomics.wait) instead of freezing the agent's event loop.
 *
 * Protocol: the parent posts one message at a time and blocks in
 * Atomics.wait until this worker writes the JSON answer into the shared
 * buffer and flips the control word.
 *   - `{ type: 'reset' }` drops every script held: `{}`.
 *   - `{ type: 'load', name, script }` compiles one script (an expression
 *     that evaluates to a function) and keeps it under the rule's name:
 *     `{ error? }`.
 *   - `{ type: 'check', script }` compiles one without keeping it: `{ error? }`.
 *   - `{ type: 'eval', name, event, state }` calls the rule's function with
 *     the event and the state, and answers `{ hide, state }`: the state as
 *     the script left it, and `hide` true only where the script returned
 *     true. A script may be async.
 */
import { parentPort, workerData } from 'node:worker_threads';

interface WorkerData {
  sab: SharedArrayBuffer;
  maxStateBytes: number;
}
const { sab, maxStateBytes } = workerData as WorkerData;
const ctrl = new Int32Array(sab, 0, 2); // [0]=status (0 pending, 1 done), [1]=answer byte length
const data = new Uint8Array(sab, 8);
const enc = new TextEncoder();

type SuppressFn = (event: unknown, state: Record<string, unknown>) => unknown;
const fns = new Map<string, SuppressFn>();

function answer(obj: unknown): void {
  let bytes = enc.encode(JSON.stringify(obj));
  if (bytes.length > data.length) bytes = enc.encode(JSON.stringify({ error: 'the answer was too large to pass back' }));
  data.set(bytes);
  Atomics.store(ctrl, 1, bytes.length);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function compile(script: string): SuppressFn {
  // An expression, as `(event, state) => …` or `function (event, state) { … }`.
  const made = new Function(`"use strict";\nreturn (${script}\n);`)() as unknown;
  if (typeof made !== 'function') throw new Error(`the script is ${made === null ? 'null' : typeof made}, not a function such as (event, state) => false`);
  return made as SuppressFn;
}

parentPort?.on('message', (msg: { type?: string; script?: string; name?: string; event?: unknown; state?: unknown }) => {
  if (msg?.type === 'reset') {
    fns.clear();
    answer({});
    return;
  }
  if (msg?.type === 'load') {
    const name = msg.name ?? '';
    try { fns.set(name, compile(msg.script ?? '')); answer({}); } catch (e) { fns.delete(name); answer({ error: message(e) }); }
    return;
  }
  if (msg?.type === 'check') {
    try { compile(msg.script ?? ''); answer({}); } catch (e) { answer({ error: message(e) }); }
    return;
  }
  if (msg?.type !== 'eval') return;
  void (async () => {
    const fn = fns.get(msg.name ?? '');
    if (!fn) return answer({ error: 'the script is not loaded' });
    const state = (msg.state && typeof msg.state === 'object' && !Array.isArray(msg.state) ? msg.state : {}) as Record<string, unknown>;
    try {
      let hide = fn(msg.event, state);
      if (hide && typeof (hide as { then?: unknown }).then === 'function') hide = await hide;
      let kept: string;
      try { kept = JSON.stringify(state); } catch (e) { return answer({ error: `its state can't be kept as JSON: ${message(e)}` }); }
      if (kept === undefined || enc.encode(kept).length > maxStateBytes) {
        return answer({ error: `its state is over the ${maxStateBytes.toLocaleString('en-US')} bytes it may keep` });
      }
      // Only true hides: anything else, a truthy string included, shows the event.
      answer({ hide: hide === true, state: JSON.parse(kept) });
    } catch (e) {
      answer({ error: message(e) });
    }
  })();
});
