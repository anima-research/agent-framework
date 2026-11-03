/**
 * code_execution's engine binding (src/code-execution/engine.ts) against fake slots: what a
 * script gets back, how calls settle, how runs end, and the limits that hold the guest. The
 * module is the committed src/code-execution/quickjs.wasm, which engine/build.sh rebuilds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEngine, EngineError, MAX_MEMORY_BYTES, MAX_RESULT_DEPTH, MAX_STACK_BYTES, MIN_MEMORY_BYTES,
} from '../src/code-execution/engine.js';
import type { Engine, EngineLimits, EngineSlots, RunState } from '../src/code-execution/engine.js';

const MiB = 1024 * 1024;
/** The child's own error for a result that doesn't fit, as settle's last argument. */
const UNFIT = '{"name":"ResultTooLarge","message":"too large"}';

/** A prelude like the child's, cut down: tools by name, and an Error made of a failed call's fields. */
const PRELUDE = `
globalThis.tool = async (name, args) => {
  try {
    return await __host(name, JSON.stringify(args ?? {}));
  } catch (e) {
    if (e && typeof e === 'object' && !(e instanceof Error)) throw Object.assign(new Error(e.message), e, { name: e.name });
    throw e;
  }
};
globalThis.print = (...parts) => __output(1, parts.join(' ') + '\\n');
`;

interface Recorded {
  calls: Array<{ id: number; name: string; args: string }>;
  output: Array<[1 | 2, string]>;
}

async function engine(over: Partial<EngineSlots> = {}, limits: Partial<EngineLimits> = {}): Promise<{ e: Engine; rec: Recorded }> {
  const rec: Recorded = { calls: [], output: [] };
  const slots: EngineSlots = {
    hostCall: (id, name, args) => { rec.calls.push({ id, name, args }); },
    interrupt: () => false,
    supervise: () => {},
    output: (stream, text) => { rec.output.push([stream, text]); },
    ...over,
  };
  const e = await loadEngine({ memoryMaxBytes: 32 * MiB, ...limits }, slots);
  return { e, rec };
}

function fulfilled(s: RunState): unknown {
  assert.equal(s.kind, 'fulfilled', `expected fulfilled, got ${JSON.stringify(s)}`);
  const json = (s as { json: string | undefined }).json;
  return json === undefined ? undefined : JSON.parse(json);
}

interface Imports { env: { memory: { buffer: ArrayBuffer } }; wasi_snapshot_preview1: { fd_write(fd: number, iovs: number, iovsLen: number, written: number): number } }
type Exports = Record<string, (...args: number[]) => number>;
interface WasmApi {
  instantiate(module: object, imports: Imports): Promise<{ exports: Exports }>;
  RuntimeError: new (message: string) => Error;
}
const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

/**
 * An engine on the real module with some of its exports replaced, for what the module can't be
 * made to do on cue: `wrap` gets the real exports and the imports, and returns the replacements.
 */
async function engineAround(wrap: (ex: Exports, imports: Imports) => Exports, over: Partial<EngineSlots> = {}, limits: Partial<EngineLimits> = {}) {
  const instantiate = wasm.instantiate;
  wasm.instantiate = async (module, imports) => {
    const { exports } = await instantiate.call(wasm, module, imports);
    return { exports: { ...exports, ...wrap(exports, imports) } };
  };
  try {
    return await engine(over, limits);
  } finally {
    wasm.instantiate = instantiate;
  }
}

/**
 * Fills the guest's memory from the host's side, through the module's own allocator, to within
 * `room` bytes of its soft limit, with the headroom closed, and returns the block that holds it.
 * The largest block that fits is found by trying sizes; a try that's refused opens the headroom,
 * and a byte allocated and freed far below the limit closes it again.
 */
function fillToSoftLimit(ex: Exports, room: number): number {
  const fits = (n: number) => {
    const p = ex.engine_alloc(n);
    if (p) ex.engine_free(p);
    else ex.engine_free(ex.engine_alloc(1));
    return p !== 0;
  };
  let lo = 0, hi = MAX_MEMORY_BYTES;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const hold = ex.engine_alloc(Math.max(1, lo - room));
  assert.ok(hold, 'the block that fills memory fits');
  return hold;
}

test('a script\'s value is its last expression statement\'s, as JSON', async () => {
  const { e } = await engine();
  assert.deepEqual(fulfilled(e.start(PRELUDE, '1 + 2; ({ a: [1, "two"], b: null })', 's.js')), { a: [1, 'two'], b: null });
  e.dispose();
});

test('a script whose value JSON leaves out is fulfilled with no json', async () => {
  const { e } = await engine();
  assert.deepEqual(e.start(PRELUDE, 'undefined', 's.js'), { kind: 'fulfilled', json: undefined });
  e.dispose();
});

test('a call the script awaits is pending until settled, then gets the parsed JSON', async () => {
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, 'const r = await tool("lookup", { q: "café 🌱" }); [r.answer, typeof r]', 's.js');
  assert.deepEqual(s, { kind: 'pending' });
  assert.deepEqual(rec.calls, [{ id: 1, name: 'lookup', args: '{"q":"café 🌱"}' }]);
  assert.deepEqual(fulfilled(e.settle(1, true, '{"answer":"ünï 🌱"}', UNFIT)), ['ünï 🌱', 'object']);
  e.dispose();
});

test('settle takes the result as UTF-8 bytes as well as text', async () => {
  const { e } = await engine();
  e.start(PRELUDE, '(await tool("t")).v', 's.js');
  assert.equal(fulfilled(e.settle(1, true, new TextEncoder().encode('{"v":"bytes ✓"}'), UNFIT)), 'bytes ✓');
  e.dispose();
});

test('calls in flight settle in any order, each to its own promise', async () => {
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, 'await Promise.all([tool("a"), tool("b"), tool("c")])', 's.js');
  assert.equal(s.kind, 'pending');
  assert.deepEqual(rec.calls.map((c) => [c.id, c.name]), [[1, 'a'], [2, 'b'], [3, 'c']]);
  assert.equal(e.settle(3, true, '"C"', UNFIT).kind, 'pending');
  assert.equal(e.settle(1, true, '"A"', UNFIT).kind, 'pending');
  assert.deepEqual(fulfilled(e.settle(2, true, '"B"', UNFIT)), ['A', 'B', 'C']);
  e.dispose();
});

test('a failed call rejects with its fields, and the prelude makes an Error of them', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'try { await tool("t"); "no throw" } catch (err) { [err instanceof Error, err.name, err.message, err.code] }', 's.js');
  assert.deepEqual(fulfilled(e.settle(1, false, '{"name":"ToolRefused","message":"not on this agent\'s list","code":7}', UNFIT)),
    [true, 'ToolRefused', 'not on this agent\'s list', 7]);
  e.dispose();
});

test('a result the guest can\'t parse, nested too deeply or not JSON, rejects the call with the child\'s own error', async () => {
  // The call took effect either way, and a RangeError or SyntaxError at its await, or a crash,
  // would read as a failed call. The binding refuses a result nested past MAX_RESULT_DEPTH before
  // the guest parses it, since under Node a parse nested about 8,000 deep overflows the host's
  // stack before QuickJS's own check sees it. One that isn't JSON fails the guest's parse.
  const nested = (depth: number) => `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;
  const objects = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
  for (const [shape, json, unfit] of [
    ['nested to the limit', nested(MAX_RESULT_DEPTH), false],
    ['nested past the limit', nested(MAX_RESULT_DEPTH + 1), true],
    ['objects nested past the limit', objects(MAX_RESULT_DEPTH + 1), true],
    ['nested past the host\'s stack', nested(200_000), true],
    ['many containers, none deep', `[${'[],'.repeat(MAX_RESULT_DEPTH * 2)}{}]`, false],
    // The escaped quote comes first, so a scan that ended the string there would count the rest.
    ['brackets inside a string, after an escaped quote', `["\\"${'['.repeat(MAX_RESULT_DEPTH + 1)}"]`, false],
    ['not JSON', '{"unterminated": ', true],
  ] as const) {
    const { e } = await engine();
    e.start(PRELUDE, 'try { await tool("t"); "took it" } catch (err) { err.name }', 's.js');
    const s = e.settle(1, true, json, UNFIT);
    assert.equal(s.unfit, unfit ? true : undefined, shape);
    assert.equal(fulfilled(s), unfit ? 'ResultTooLarge' : 'took it', shape);
    e.dispose();
  }
});

test('settling an id that isn\'t pending throws, and leaves the run as it was', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await tool("t")', 's.js');
  assert.throws(() => e.settle(9, true, '1', UNFIT), EngineError);
  // Not a whole id: the module would read 1.5 as call 1.
  assert.throws(() => e.settle(1.5, true, '1', UNFIT), EngineError);
  assert.equal(fulfilled(e.settle(1, true, '1', UNFIT)), 1);
  assert.throws(() => e.settle(1, true, '1', UNFIT), /no pending call/);
  e.dispose();
});

test('a call still in flight when the script returns can settle after it', async () => {
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, 'globalThis.late = tool("slow").then((v) => print("late", v)); "returned"', 's.js');
  assert.equal(fulfilled(s), 'returned');
  assert.equal(rec.calls.length, 1);
  assert.equal(fulfilled(e.settle(1, true, '"done"', UNFIT)), 'returned');
  assert.deepEqual(rec.output, [[1, 'late done\n']]);
  e.dispose();
});

test('a thrown Error is rejected with its name, message and stack', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, 'function f() { throw new TypeError("bad input") }\nf()', 'job.js');
  assert.equal(s.kind, 'rejected');
  const r = s as Extract<RunState, { kind: 'rejected' }>;
  assert.equal(r.name, 'TypeError');
  assert.equal(r.message, 'bad input');
  assert.match(r.stack ?? '', /job\.js/);
  e.dispose();
});

test('a thrown non-Error value is rejected with name \'\' and its string as the message', async () => {
  const { e } = await engine();
  assert.deepEqual(e.start(PRELUDE, 'await 0; throw "just text"', 's.js'), { kind: 'rejected', name: '', message: 'just text' });
  e.dispose();
});

test('a thrown object with no message is rejected with its JSON as the message', async () => {
  const { e } = await engine();
  assert.deepEqual(e.start(PRELUDE, 'throw { why: "this failure should remain visible" }', 's.js'),
    { kind: 'rejected', name: '', message: '{"why":"this failure should remain visible"}' });
  e.dispose();
});

test('a script\'s value is serialized once, however many calls settle after it returns', async () => {
  // Serializing runs the script's own code, here a toJSON that counts its runs, and every settle
  // after the script returned answers its ending again.
  const { e } = await engine();
  const s = e.start(PRELUDE, 'let n = 0; tool("a"); tool("b"); tool("c"); ({ toJSON() { n++; return { n }; } })', 's.js');
  assert.deepEqual(fulfilled(s), { n: 1 });
  // What a call answers is the caller's own, read just now or kept: changing it doesn't change the
  // next answer.
  (s as { json?: string }).json = 'changed by the caller';
  const kept = e.settle(1, true, '1', UNFIT);
  assert.deepEqual(fulfilled(kept), { n: 1 });
  (kept as { json?: string }).json = 'changed by the caller';
  assert.deepEqual(fulfilled(e.settle(2, true, '2', UNFIT)), { n: 1 });
  assert.deepEqual(fulfilled(e.settle(3, true, '3', UNFIT)), { n: 1 });
  e.dispose();
});

test('a rejection after an await is the script\'s rejection', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await tool("t"); throw new RangeError("after")', 's.js');
  const s = e.settle(1, true, 'null', UNFIT);
  assert.equal(s.kind, 'rejected');
  assert.equal((s as { name: string }).name, 'RangeError');
  e.dispose();
});

test('a syntax error in the script, or a throw in the prelude, is rejected', async () => {
  const a = await engine();
  const s = a.e.start(PRELUDE, 'let = ;', 's.js');
  assert.equal(s.kind, 'rejected');
  assert.equal((s as { name: string }).name, 'SyntaxError');
  a.e.dispose();
  const b = await engine();
  const p = b.e.start('throw new Error("prelude broke")', '1', 's.js') as Extract<RunState, { kind: 'rejected' }>;
  assert.deepEqual([p.kind, p.name, p.message], ['rejected', 'Error', 'prelude broke']);
  assert.match(p.stack ?? '', /<prelude>/);
  b.e.dispose();
});

test('a value JSON can\'t hold is rejected with the stringify error', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, '10n', 's.js');
  assert.equal(s.kind, 'rejected');
  assert.equal((s as { name: string }).name, 'TypeError');
  e.dispose();
});

test('output reaches the output slot with its stream', async () => {
  const { e, rec } = await engine();
  e.start(PRELUDE, 'print("out", 1); __output(2, "err ✓"); __output(1, "\\uFEFFkept"); 0', 's.js');
  assert.deepEqual(rec.output, [[1, 'out 1\n'], [2, 'err ✓'], [1, '\uFEFFkept']]);
  e.dispose();
});

test('the interrupt stops a spinning script for good', async () => {
  let checks = 0;
  const { e } = await engine({ interrupt: () => ++checks > 3 });
  assert.deepEqual(e.start(PRELUDE, 'for (;;) {}', 's.js'), { kind: 'interrupted' });
  e.dispose();
});

test('the script\'s code that QuickJS runs after a stop can\'t reach the host', async () => {
  // A stop throws an error, and building its backtrace converts Error.stackTraceLimit and calls
  // Error.prepareStackTrace: here a valueOf and a prepareStackTrace that try a call and output.
  // The slot says stop once only, as the script spins.
  let checks = 0;
  const { e, rec } = await engine({ interrupt: () => ++checks === 3 });
  const hooks = `const attempt = (fn) => { try { fn() } catch {} };
    Error.stackTraceLimit = { valueOf() { attempt(() => __host("from the limit", "{}")); return 10; } };
    Error.prepareStackTrace = () => { attempt(() => __host("from the hook", "{}")); attempt(() => __output(1, "from the hook")); return ""; };
    for (;;) {}`;
  assert.deepEqual(e.start(PRELUDE, hooks, 's.js'), { kind: 'interrupted' });
  assert.deepEqual([rec.calls, rec.output], [[], []]);
  e.dispose();
});

test('a stop that lands in the script\'s stack hook holds, though QuickJS puts back the error it was building', async () => {
  // The slot's one stop lands in the hook, which counts to 3,000,000. QuickJS then throws away the
  // hook's error and puts back the TypeError whose backtrace it was building, which the script
  // catches and goes on from: its next check stops it, without asking the slot again, and its call
  // in between is refused. (The refusal's error runs the hook again, which a stop that didn't hold
  // would let count to the end.)
  let checks = 0;
  const { e, rec } = await engine({ interrupt: () => ++checks === 101 });
  const s = e.start(PRELUDE, `Error.prepareStackTrace = () => { for (let i = 0; i < 3e6; i++) {} };
    try { null.x } catch {}
    try { __host("after the stop", "{}") } catch {}
    for (let i = 0; i < 1e6; i++) {}
    "went on"`, 's.js');
  assert.deepEqual(s, { kind: 'interrupted' });
  assert.equal(checks, 101, 'the slot was asked again after it said stop');
  assert.deepEqual(rec.calls, []);
  e.dispose();
});

test('supervision runs at every check, after a stop and after a slot fails, though interrupt() is asked no more', async () => {
  // The stack hook keeps each stop from landing for a while, so the guest runs on after it.
  const hook = `Error.prepareStackTrace = () => { for (let i = 0; i < 3e6; i++) {} };
    for (let k = 0; k < 5; k++) { try { null.x } catch {} }
    "went on"`;
  let checks = 0;
  let afterStop = 0;
  const a = await engine({ interrupt: () => ++checks === 101, supervise: () => { if (checks >= 101) afterStop += 1; } });
  assert.deepEqual(a.e.start(PRELUDE, hook, 's.js'), { kind: 'interrupted' });
  assert.equal(checks, 101, 'interrupt() was asked no more once it said stop');
  assert.ok(afterStop > 1, `supervised ${afterStop} times after the stop`);
  a.e.dispose();
  // A slot's failure stops the guest at its next check, and supervision goes on all the same.
  let failed = false;
  let afterFailure = 0;
  const b = await engine({
    output: () => { failed = true; throw new Error('the output pipe is gone'); },
    supervise: () => { if (failed) afterFailure += 1; },
  });
  assert.throws(() => b.e.start(PRELUDE, `try { __output(1, "x") } catch {}\n${hook}`, 's.js'), EngineError);
  assert.ok(afterFailure > 1, `supervised ${afterFailure} times after the failure`);
  b.e.dispose();
});

test("a supervise() that throws ends the run as a slot's failure, and a failure before it stays the run's", async () => {
  const watch = new Error('the watch failed');
  // Were a throw not the run's failure, these interrupts would stop the guest, so the test fails rather than spins.
  // And it's a slot's failure, not a crash: a throw that escaped the binding would end the run with the same cause.
  const slotFailed = (cause: Error) => (err: unknown) => err instanceof EngineError && err.cause === cause && err.message.startsWith('a slot threw');
  let n = 0, checks = 0;
  const a = await engine({ supervise: () => { if (++n === 50) throw watch; }, interrupt: () => ++checks > 1000 });
  assert.throws(() => a.e.start(PRELUDE, 'for (;;) {}', 's.js'), slotFailed(watch));
  a.e.dispose();
  // An output failure first: a later supervise() that throws doesn't take its place.
  const pipe = new Error('the output pipe is gone');
  let failed = false, thrownAfter = 0;
  checks = 0;
  const b = await engine({
    output: () => { failed = true; throw pipe; },
    supervise: () => { if (failed) { thrownAfter++; throw watch; } },
    interrupt: () => ++checks > 1000,
  });
  assert.throws(() => b.e.start(PRELUDE, 'try { __output(1, "x") } catch {}\nfor (;;) {}', 's.js'), slotFailed(pipe));
  assert.ok(thrownAfter > 0, `supervise() threw ${thrownAfter} times after the output failure`);
  b.e.dispose();
});

test('the interrupt reaches a script spinning in jobs, and later settles answer interrupted, their results dropped', async () => {
  let stop = false;
  const { e } = await engine({ interrupt: () => stop }, { memoryMaxBytes: 8 * MiB });
  e.start(PRELUDE, 'tool("u"); const v = await tool("t"); for (;;) { await 0 }', 's.js');
  stop = true;
  assert.deepEqual(e.settle(2, true, '1', UNFIT), { kind: 'interrupted' });
  // A settle after that does nothing for the stopped run: its result is dropped, and one too large
  // for its memory isn't even read, so it isn't reported unfit.
  assert.deepEqual(e.settle(1, true, JSON.stringify('x'.repeat(12 * MiB)), UNFIT), { kind: 'interrupted', dropped: true });
  e.dispose();
});

test('a slot that throws ends the run with an EngineError, and the engine refuses calls after', async () => {
  // A script that catches the failure and calls again in the same run doesn't reach the slot a
  // second time, so nothing more goes out once the run has failed. The calls are direct, as the
  // child's prelude makes them: an awaited call's rejection comes in a job, which never runs.
  let calls = 0;
  const { e } = await engine({ hostCall: () => { calls++; throw new Error('the bridge is broken'); } });
  assert.throws(() => e.start(PRELUDE, 'try { __host("a", "{}") } catch {}\n__host("b", "{}")', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the bridge is broken/.test(err.message));
  assert.equal(calls, 1);
  assert.throws(() => e.settle(1, true, '1', UNFIT), EngineError);
  e.dispose();
  const out = await engine({ output: () => { throw new Error('the output pipe is gone'); } });
  assert.throws(() => out.e.start(PRELUDE, 'try { print("x") } catch {}\n1', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the output pipe is gone/.test(err.message));
  out.e.dispose();
});

test('a slot failure is an EngineError, not a stop, when the interrupt is what ends the run', async () => {
  // The interrupt slot itself throwing, while the script runs or while its ending is read, and a
  // failure the script caught before the interrupt check that stops it: each ends the run with
  // that failure.
  for (const script of ['for (;;) {}', 'throw Object.defineProperty({}, "message", { get() { for (;;) {} } })']) {
    // It throws only well into the spin, so that in the second script, it's the getter's.
    let checks = 0;
    const { e } = await engine({ interrupt: () => { if (++checks > 100) throw new Error('the stop file is unreadable'); return false; } });
    assert.throws(() => e.start(PRELUDE, script, 's.js'), (err: unknown) =>
      err instanceof EngineError && /the stop file is unreadable/.test(err.message), script);
    e.dispose();
  }
  // If the failure didn't stop the guest, this interrupt would, so the test fails rather than spins.
  let checks = 0;
  const b = await engine({ output: () => { throw new Error('the output pipe is gone'); }, interrupt: () => ++checks > 1000 });
  assert.throws(() => b.e.start(PRELUDE, 'try { print("x") } catch {}\nfor (;;) {}', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the output pipe is gone/.test(err.message));
  b.e.dispose();
});

test('a slot that throws undefined still ends the run, and no slot but supervise() is called after it', async () => {
  let calls = 0, checks = 0, checksAtFailure = -1, supervisedAfter = 0;
  const { e } = await engine({
    hostCall: () => { calls++; checksAtFailure = checks; throw undefined; },
    interrupt: () => ++checks > 1000,
    supervise: () => { if (calls > 0) supervisedAfter++; },
  });
  assert.throws(() => e.start(PRELUDE, 'try { __host("a", "{}") } catch {}\ntry { __host("b", "{}") } catch {}\nfor (;;) {}', 's.js'), EngineError);
  assert.deepEqual([calls, checks], [1, checksAtFailure]);
  assert.ok(supervisedAfter > 0, `supervise() was called ${supervisedAfter} times after the failure`);
  e.dispose();
});

test('a slot that calls back into the engine ends the run with an EngineError', async () => {
  let self: Engine | undefined;
  const { e } = await engine({ hostCall: (id) => { self!.settle(id, true, '1', UNFIT); } });
  self = e;
  assert.throws(() => e.start(PRELUDE, 'await tool("t")', 's.js'), (err: unknown) =>
    err instanceof EngineError && /settle\(\) was called from inside one of the engine's slots/.test(err.message));
  e.dispose();
});

test('the script\'s code that runs while its ending is read, and the jobs it queues, can\'t reach the host', async () => {
  // A getter on what the script threw runs after its ending is fixed: the call it tries and its
  // output are refused, and so are a job's it queues, which runs before the read returns rather
  // than at a later settle. The script's continuation of its call in flight, which isn't part of
  // the read, prints what the job met.
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, `const queued = [];
    const attempt = (into, what, fn) => { try { fn(); into.push(what + " went"); } catch { into.push(what + " refused"); } };
    tool("in flight").then(() => __output(1, queued.join(", ")));
    const tried = [];
    throw Object.defineProperty({}, "message", { get() {
      attempt(tried, "call", () => __host("late", "{}"));
      attempt(tried, "output", () => __output(1, "late"));
      Promise.resolve().then(() => {
        attempt(queued, "queued call", () => __host("queued", "{}"));
        attempt(queued, "queued output", () => __output(1, "queued"));
      });
      return tried.join(", ");
    } })`, 's.js');
  assert.deepEqual(s, { kind: 'rejected', name: '', message: 'call refused, output refused' });
  e.settle(1, true, '1', UNFIT);
  assert.deepEqual([rec.calls.map((c) => c.name), rec.output],
    [['in flight'], [[1, 'queued call refused, queued output refused']]]);
  e.dispose();
});

test('what a thrown object holds is read as text, and a part that can\'t be read is left out', async () => {
  for (const [script, name, message, stack] of [
    ['throw { name: 7, message: 42 }', '7', '42', false],
    ['throw Object.defineProperty(new TypeError("readable"), "stack", { get() { throw 1 } })', 'TypeError', 'readable', false],
    // A message that can't be read is told by the object's JSON, and with no JSON, its string form.
    ['throw Object.defineProperty({ why: 1 }, "message", { get() { throw 1 } })', '', '{"why":1}', false],
    ['throw { big: 1n, toString() { return "told by its string form" } }', '', 'told by its string form', false],
    // A message that's there but has no string form is left out, with no stand-in for it.
    ['throw Object.assign(new Error(), { message: Symbol("m") })', 'Error', '', true],
    // A Symbol thrown bare has none either: its conversion's TypeError, whose backtrace runs the
    // script's stack hook, is left out with what the hook gave.
    ['Error.prepareStackTrace = () => "hooked"; throw Symbol("bare")', '', '', false],
    // A toJSON the script puts on Object.prototype doesn't reach the engine's own record of it.
    ['Object.prototype.toJSON = () => { throw new Error("not this") }; throw new RangeError("this")', 'RangeError', 'this', true],
  ] as const) {
    const { e } = await engine();
    const s = e.start(PRELUDE, script, 's.js') as Extract<RunState, { kind: 'rejected' }>;
    assert.deepEqual([s.kind, s.name, s.message, typeof s.stack === 'string'], ['rejected', name, message, stack], script);
    e.dispose();
  }
});

test('a slot that throws a value with no string form, or an Error whose message has none, still ends the run with an EngineError', async () => {
  const symbolic = Object.assign(new Error(), { message: Symbol('m') });
  for (const [thrown, text] of [
    [{ toString() { throw new Error('no string form'); } }, /a value with no string form/],
    [symbolic, /Symbol\(m\)/],
  ] as const) {
    const { e } = await engine({ hostCall: () => { throw thrown; } });
    let failure: unknown;
    assert.throws(() => e.start(PRELUDE, '__host("a", "{}")', 's.js'), (err: unknown) => {
      failure = err;
      return err instanceof EngineError && err.cause === thrown && text.test(err.message);
    });
    assert.throws(() => e.settle(1, true, '1', UNFIT), (err: unknown) => err === failure);
    e.dispose();
  }
});

test('after a slot\'s failure, every later call throws that failure, and a dispose() refused from a slot can be made again', async () => {
  let self: Engine | undefined;
  const { e } = await engine({ hostCall: () => { self!.dispose(); } });
  self = e;
  let failure: unknown;
  assert.throws(() => e.start(PRELUDE, 'await tool("t")', 's.js'), (err: unknown) => {
    failure = err;
    return err instanceof EngineError && /dispose\(\) was called from inside one of the engine's slots/.test(err.message);
  });
  // Not "after dispose()", "already called" or a bad id's own error, but the slot's failure.
  assert.throws(() => e.start(PRELUDE, '1', 's.js'), (err: unknown) => err === failure);
  assert.throws(() => e.settle(1, true, '1', UNFIT), (err: unknown) => err === failure);
  assert.throws(() => e.settle(1.5, true, '1', UNFIT), (err: unknown) => err === failure);
  e.dispose();
  assert.throws(() => e.settle(1, true, '1', UNFIT), /after dispose/);
});

test('a module trap after a slot\'s failure the script caught reports the slot\'s failure', async () => {
  // The toJSON's output fails and is caught, and then the next element, nested past the host's
  // stack, makes JSON.stringify trap.
  const { e } = await engine({ output: () => { throw new Error('the output pipe is gone'); } });
  const script = 'let deep = []; for (let i = 0; i < 100000; i++) deep = [deep];\nJSON.stringify([{ toJSON() { try { print("x") } catch {} return 1 } }, deep])';
  assert.throws(() => e.start(PRELUDE, script, 's.js'), (err: unknown) =>
    err instanceof EngineError && /^a slot threw during start\(\): the output pipe is gone$/.test(err.message));
  e.dispose();
});

test('an ending the module can\'t read out is answered as out of memory, and that answer is kept', async () => {
  // The module can't allocate the ending's text the first time it's read, which can't be made to
  // happen on cue; the binding mustn't read it again, which would run the script's serializing
  // code again and could answer differently. A run that failed stays failed, and its later
  // results are dropped.
  for (const [script, kind, message] of [
    ['tool("a"); tool("b"); ({ ok: true })', 'rejected', 'out of memory while serializing the script\'s return value; return less, or let go of data the script no longer needs'],
    ['tool("a"); tool("b"); throw new Error("x")', 'rejected', 'out of memory while reading what the script threw; throw something smaller, such as an Error with a shorter message, or let go of data the script no longer needs'],
    ['tool("a"); tool("b"); queueMicrotask(() => { throw new TypeError("x") }); 1', 'failed', 'out of memory while reading the exception that ended the run; let go of data the script no longer needs, and if a callback given to queueMicrotask or a FinalizationRegistry threw it, throw something smaller or catch it there'],
  ] as const) {
    let reads = 0;
    const { e } = await engineAround((ex) => ({ engine_result: () => (++reads === 1 ? 0 : ex.engine_result()) }));
    const expected = { kind, name: 'InternalError', message };
    const later = kind === 'failed' ? { ...expected, dropped: true } : expected;
    assert.deepEqual(e.start(PRELUDE, script, 's.js'), expected, script);
    assert.deepEqual(e.settle(1, true, '1', UNFIT), later, script);
    assert.deepEqual(e.settle(2, true, '2', UNFIT), later, script);
    assert.equal(reads, 1, script);
    e.dispose();
  }
});

test('an ending longer than the binding can decode is answered with its length, not a crash', async () => {
  // The module's buffer here claims a text past V8's longest string; a real one needs a budget
  // of gigabytes. The buffer is freed all the same.
  for (const [script, length, kind, message] of [
    ['({ ok: true })', 600_000_000, 'rejected', 'the script\'s return value comes to 600000000 bytes as text, more than the 536870888 the engine reads back; return less'],
    ['throw new Error("x")', 600_000_000, 'rejected', 'what the script threw comes to 600000000 bytes as text, more than the 536870888 the engine reads back; throw something smaller'],
    ['queueMicrotask(() => { throw new TypeError("x") }); 1', 600_000_000, 'failed', 'the exception that ended the run comes to 600000000 bytes as text, more than the 536870888 the engine reads back; if a callback given to queueMicrotask or a FinalizationRegistry threw it, throw something smaller or catch it there'],
    // One byte past the bound is refused too.
    ['({ ok: true })', 536_870_889, 'rejected', 'the script\'s return value comes to 536870889 bytes as text, more than the 536870888 the engine reads back; return less'],
  ] as const) {
    let ptr = 0;
    const freed: number[] = [];
    const { e } = await engineAround((ex, imports) => ({
      engine_result: () => {
        ptr = ex.engine_alloc(8);
        const view = new DataView(imports.env.memory.buffer);
        view.setUint32(ptr, 1, true);
        view.setUint32(ptr + 4, length, true);
        return ptr;
      },
      engine_free: (p) => { freed.push(p); return ex.engine_free(p); },
    }));
    assert.deepEqual(e.start(PRELUDE, script, 's.js'), { kind, name: 'RangeError', message }, script);
    assert.ok(ptr !== 0 && freed.includes(ptr), `${script}: the buffer is freed`);
    e.dispose();
  }
});

test('a stop while an ending is read answers interrupted, as every later call does', async () => {
  // The read runs the script's own toJSON, which spins until the stop.
  let checks = 0;
  const { e } = await engine({ interrupt: () => ++checks > 100 });
  assert.deepEqual(e.start(PRELUDE, 'tool("a"); ({ toJSON() { for (;;) {} } })', 's.js'), { kind: 'interrupted' });
  assert.deepEqual(e.settle(1, true, '1', UNFIT), { kind: 'interrupted', dropped: true });
  e.dispose();
});

test('a slot that fails in the jobs a read queued ends the run with its EngineError, not the ending', async () => {
  let checks = 0;
  const { e } = await engine({ interrupt: () => { if (++checks > 100) throw new Error('the stop check failed'); return false; } });
  assert.throws(() => e.start(PRELUDE, 'tool("a"); ({ toJSON() { Promise.resolve().then(() => { for (;;) {} }); return 1 } })', 's.js'),
    (err: unknown) => err instanceof EngineError && /the stop check failed/.test(err.message));
  e.dispose();
});

test('an exception that escapes the script\'s promises ends the run as failed, which a kept rejection doesn\'t hide, and drops later results', async () => {
  // A callback given to queueMicrotask runs as a job that passes its throw on.
  const a = await engine();
  const s = a.e.start(PRELUDE, 'const first = tool("a"); tool("b"); first.then(() => queueMicrotask(() => { throw new TypeError("late") })); throw new Error("own")', 's.js');
  assert.deepEqual([s.kind, (s as { message?: string }).message], ['rejected', 'own']);
  // The result reached the script, whose code then queued the callback that threw.
  const failed = a.e.settle(1, true, '1', UNFIT);
  assert.deepEqual([failed.kind, (failed as { name?: string }).name, (failed as { message?: string }).message, failed.dropped],
    ['failed', 'TypeError', 'late', undefined]);
  // The run is over, so the next result never reaches the script.
  const later = a.e.settle(2, true, '2', UNFIT);
  assert.deepEqual([later.kind, (later as { message?: string }).message, later.dropped], ['failed', 'late', true]);
  a.e.dispose();
  // Thrown in the same turn as the script's return, it ends the run before the value is read.
  const b = await engine();
  const t = b.e.start(PRELUDE, 'queueMicrotask(() => { throw new RangeError("after") }); 1', 's.js');
  assert.deepEqual([t.kind, (t as { name?: string }).name, (t as { message?: string }).message], ['failed', 'RangeError', 'after']);
  b.e.dispose();
});

test('an exception that escapes the jobs reading the ending queued ends the run as failed, in the ending\'s place', async () => {
  // With no call left to settle, the call that read the ending is the only answer the run gets.
  const a = await engine();
  const s = a.e.start(PRELUDE, '({ toJSON() { queueMicrotask(() => { throw new TypeError("in the read") }); return 1 } })', 's.js');
  assert.deepEqual([s.kind, (s as { name?: string }).name, (s as { message?: string }).message], ['failed', 'TypeError', 'in the read']);
  a.e.dispose();
  // The same for what the script threw, read through a getter.
  const b = await engine();
  const t = b.e.start(PRELUDE, 'throw { get message() { queueMicrotask(() => { throw new RangeError("read") }); return "own" } }', 's.js');
  assert.deepEqual([t.kind, (t as { name?: string }).name, (t as { message?: string }).message], ['failed', 'RangeError', 'read']);
  b.e.dispose();
});

test('a stop while the exception that ended the run is read leaves the run failed, with the parts it cut off left out', async () => {
  // The thrown object's name getter spins until the stop; its message is plain data. The run's
  // own ending, kept first, doesn't stand: the failure came after it.
  const thrower = 'queueMicrotask(() => { throw { get name() { for (;;) {} }, message: "m" } })';
  let checks = 0;
  const a = await engine({ interrupt: () => ++checks > 100 });
  assert.equal(fulfilled(a.e.start(PRELUDE, `tool("a"); tool("b").then(() => ${thrower}); 1`, 's.js')), 1);
  assert.deepEqual(a.e.settle(2, true, '2', UNFIT), { kind: 'failed', name: '', message: 'm' });
  // Every later call answers it too, though the guest is stopped.
  assert.deepEqual(a.e.settle(1, true, '1', UNFIT), { kind: 'failed', name: '', message: 'm', dropped: true });
  a.e.dispose();
  // Read out not at all (the module here gives nothing back), it's still the failure.
  checks = 0;
  const b = await engineAround((ex) => ({ engine_result: () => { ex.engine_free(ex.engine_result()); return 0; } }), { interrupt: () => ++checks > 100 });
  const t = b.e.start(PRELUDE, `${thrower}; 1`, 's.js');
  assert.deepEqual([t.kind, (t as { name?: string }).name], ['failed', 'InternalError']);
  b.e.dispose();
});

test('a stop ends a failure\'s read: nothing after it is read, a part or a part\'s string form', async () => {
  // The interrupt slot says stop once only. The thrown object's message, read first, spins until
  // then; its name getter would give "made up" at once, and isn't run. In the second, the message
  // is read, and the name is an object whose toString spins until the stop: the name's string form
  // isn't made, and the stack getter, which would give "late", isn't run.
  let checks = 0;
  const a = await engine({ interrupt: () => ++checks === 101 });
  const s = a.e.start(PRELUDE, 'queueMicrotask(() => { throw { get message() { for (;;) {} }, get name() { return "made up" } } }); 1', 's.js');
  assert.deepEqual(s, { kind: 'failed', name: '', message: '' });
  assert.equal(checks, 101);
  a.e.dispose();
  checks = 0;
  const b = await engine({ interrupt: () => ++checks > 100 });
  const t = b.e.start(PRELUDE, 'queueMicrotask(() => { throw { message: "m", name: { toString() { for (;;) {} } }, get stack() { return "late" } } }); 1', 's.js');
  assert.deepEqual(t, { kind: 'failed', name: '', message: 'm' });
  assert.ok(checks > 100, 'the stop came while the name was made a string');
  b.e.dispose();
});

test('a part whose read or string form ends after a stop QuickJS dropped is left out', async () => {
  // The slot says stop once, as the name's getter, or its toString, spins in a stack hook, where
  // QuickJS drops the stop and puts back the TypeError it was building: the code goes on and gives
  // "late" after the stop, or throws, and neither is kept, the throw's exception freed. The message,
  // read before the stop, is.
  const late = `Error.prepareStackTrace = () => { for (let i = 0; i < 3e6; i++) {} };
      try { null.x } catch {}
      return "late";`;
  const lateThrow = late.replace('return "late";', 'throw { late: 1 };');
  for (const name of [`get name() { ${late} }`, `name: { toString() { ${late} } }`, `get name() { ${lateThrow} }`, `name: { toString() { ${lateThrow} } }`]) {
    let checks = 0;
    const { e } = await engine({ interrupt: () => ++checks === 101 });
    const s = e.start(PRELUDE, `queueMicrotask(() => { throw { message: "m", ${name} } }); 1`, 's.js');
    assert.deepEqual(s, { kind: 'failed', name: '', message: 'm' }, name);
    assert.equal(checks, 101, `${name}: the stop came while the name was read`);
    e.dispose();
  }
});

test("a stack that isn't a string is left out, its string form never made, and a string stack is kept", async () => {
  // The continuation of the call in flight, which isn't part of the read, says how many times the
  // stack's string form was made while the ending was read.
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, `let made = 0;
    tool("in flight").then(() => __output(1, "made " + made));
    throw { message: "m", stack: { toString() { made += 1; return "made up"; } } }`, 's.js');
  assert.deepEqual(s, { kind: 'rejected', name: '', message: 'm' });
  e.settle(1, true, '1', UNFIT);
  assert.deepEqual(rec.output, [[1, 'made 0']]);
  e.dispose();
  const b = await engine();
  assert.deepEqual(b.e.start(PRELUDE, 'throw { message: "m", stack: "plain" }', 's.js'), { kind: 'rejected', name: '', message: 'm', stack: 'plain' });
  b.e.dispose();
});

test('a call or output tried while the ending is read is refused in words that say the host is closed to it', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, `throw Object.defineProperty({}, "message", { get() {
      const why = [];
      try { __host("late", "{}") } catch (err) { why.push(err.message) }
      try { __output(1, "late") } catch (err) { why.push(err.message) }
      return why.join(" | ");
    } })`, 's.js');
  assert.deepEqual(s, { kind: 'rejected', name: '', message: "the script's calls no longer reach the host | the script's output no longer reaches the host" });
  e.dispose();
});

test('each part read before a stop keeps its string form, a number\'s or an object\'s', async () => {
  // The slot says stop once only, as the name getter spins. The message, read first, isn't a
  // string: its string form is made before the name is read.
  for (const [message, made] of [['42', '42'], ['{ toString() { return "made" } }', 'made']] as const) {
    let checks = 0;
    const { e } = await engine({ interrupt: () => ++checks === 101 });
    const s = e.start(PRELUDE, `queueMicrotask(() => { throw { message: ${message}, get name() { for (;;) {} } } }); 1`, 's.js');
    assert.deepEqual(s, { kind: 'failed', name: '', message: made }, message);
    assert.equal(checks, 101);
    e.dispose();
  }
});

test('a stack is left out once a stop has come, though it\'s plain data', async () => {
  let checks = 0;
  const { e } = await engine({ interrupt: () => ++checks === 101 });
  const s = e.start(PRELUDE, 'queueMicrotask(() => { throw { get message() { for (;;) {} }, stack: "late" } }); 1', 's.js');
  assert.deepEqual(s, { kind: 'failed', name: '', message: '' });
  e.dispose();
});

test('once a stop has come, a failure with no message gets no stand-in for one', async () => {
  // Each thrown object has no message. Without the stop, the engine would tell it by its JSON or
  // its string form; here the first a non-enumerable name getter ends at the stop (its JSON would
  // be {"code":5}), and the second's toJSON does (its toString would give "made up").
  for (const thrown of [
    'Object.defineProperty({ code: 5 }, "name", { get() { for (;;) {} } })',
    '{ toJSON() { for (;;) {} }, toString() { return "made up" } }',
  ]) {
    let checks = 0;
    const { e } = await engine({ interrupt: () => ++checks > 100 });
    const s = e.start(PRELUDE, `queueMicrotask(() => { throw ${thrown} }); 1`, 's.js');
    assert.deepEqual(s, { kind: 'failed', name: '', message: '' }, thrown);
    assert.ok(checks > 100, `${thrown}: the stop came while it was read`);
    e.dispose();
  }
});

test('a stand-in for a missing message that ends after a stop QuickJS dropped is left out', async () => {
  // As for a part read late: the slot says stop once, as the toJSON, or the toString, spins in a
  // stack hook, where QuickJS drops the stop, so the code goes on and gives "late" after it, or throws.
  const late = `Error.prepareStackTrace = () => { for (let i = 0; i < 3e6; i++) {} };
      try { null.x } catch {}
      return "late";`;
  const lateThrow = late.replace('return "late";', 'throw { late: 1 };');
  for (const thrown of [
    `{ code: 5, toJSON() { ${late} } }`, `{ toJSON() { return undefined }, toString() { ${late} } }`,
    `{ code: 5, toJSON() { ${lateThrow} } }`, `{ toJSON() { return undefined }, toString() { ${lateThrow} } }`,
  ]) {
    let checks = 0;
    const { e } = await engine({ interrupt: () => ++checks === 101 });
    const s = e.start(PRELUDE, `queueMicrotask(() => { throw ${thrown} }); 1`, 's.js');
    assert.deepEqual(s, { kind: 'failed', name: '', message: '' }, thrown);
    assert.equal(checks, 101, `${thrown}: the stop came while the stand-in was made`);
    e.dispose();
  }
});

test('a stop while a throw at the start is read stays a stop, which later calls answer without reading it again', async () => {
  // The prelude makes a call, then throws an object whose message getter spins until the stop:
  // the script's own ending, cut off by a stop, as a rejection's would be.
  let checks = 0, reads = 0;
  const { e } = await engineAround((ex) => ({ engine_result: () => { reads++; return ex.engine_result(); } }), { interrupt: () => ++checks > 100 });
  const prelude = '__host("a", "{}"); throw { get message() { for (;;) {} } };';
  assert.deepEqual(e.start(prelude, '1', 's.js'), { kind: 'interrupted' });
  assert.deepEqual(e.settle(1, true, '1', UNFIT), { kind: 'interrupted', dropped: true });
  assert.equal(reads, 1, 'the ending was read again');
  e.dispose();
});

test('a settle whose resolve call is stopped on its way in is dropped, and the stop isn\'t taken for a failure', async () => {
  // QuickJS asks the interrupt slot at its first check and then once in 10,000, and makes a check
  // on the way into each call. A script making k calls to an empty function before it awaits call
  // 2 puts the next asking at a place set by k: the largest k whose start asks no more than with
  // none puts it on the first check the settle makes, the one on the way into the promise's
  // resolve function.
  // If the asking falls on the settle with no calls at all, one more check before them moves it
  // 10,000 checks on, so that there's a k - 1 to try.
  let before = '';
  const script = (k: number) => `const f = () => {}; tool("a"); ${before}${'f();'.repeat(k)} const v = await tool("b"); print("ran"); v`;
  async function askedInStart(k: number) {
    let asked = 0;
    const { e } = await engine({ interrupt: () => { asked++; return false; } });
    e.start(PRELUDE, script(k), 's.js');
    e.dispose();
    return asked;
  }
  async function largestQuiet() {
    const none = await askedInStart(0);
    let lo = 0, hi = 20_000;
    assert.ok((await askedInStart(hi)) > none);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((await askedInStart(mid)) > none) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  let lo = await largestQuiet();
  if (lo === 0) {
    before = 'f();';
    lo = await largestQuiet();
  }
  assert.ok(lo > 0, `k = ${lo}`);
  async function settledStopped(k: number) {
    let stop = false;
    const { e, rec } = await engine({ interrupt: () => stop });
    e.start(PRELUDE, script(k), 's.js');
    stop = true;
    const s = e.settle(2, true, '2', UNFIT);
    e.dispose();
    return { s, ran: rec.output.length > 0 };
  }
  assert.deepEqual(await settledStopped(lo), { s: { kind: 'interrupted', dropped: true }, ran: false });
  // One call fewer, the asking falls just after the resolve function ran: the result is handed over.
  const after = await settledStopped(lo - 1);
  assert.equal(after.s.dropped, undefined, JSON.stringify(after));
});

test('a result that reaches a stopped run is dropped', async () => {
  let stop = false;
  const { e } = await engine({ interrupt: () => stop });
  e.start(PRELUDE, 'tool("a"); await tool("b"); for (;;) {}', 's.js');
  stop = true;
  // The second result reaches the script, which spins until the stop.
  assert.deepEqual(e.settle(2, true, '2', UNFIT), { kind: 'interrupted' });
  assert.deepEqual(e.settle(1, true, '1', UNFIT), { kind: 'interrupted', dropped: true });
  e.dispose();
});

test('a stop in the jobs a read queued comes after a whole ending, which that call answers; later calls answer interrupted', async () => {
  let checks = 0;
  const { e } = await engine({ interrupt: () => ++checks > 100 });
  const s = e.start(PRELUDE, 'tool("a"); ({ toJSON() { Promise.resolve().then(() => { for (;;) {} }); return 1 } })', 's.js');
  assert.deepEqual(fulfilled(s), 1);
  assert.deepEqual(e.settle(1, true, '1', UNFIT), { kind: 'interrupted', dropped: true });
  e.dispose();
});

test('a result too large to copy in still gets the child\'s own error when the guest sits at the soft limit', async () => {
  // The guest is filled to within 16 bytes of the soft limit, so the first copy of the small error
  // is refused for real, which opens the allocator's headroom, and the second copy goes there.
  // Without it, the call would reject at its await with an out-of-memory error, or a bare null.
  let ex!: Exports;
  const copies: number[] = [];
  const { e } = await engineAround((real) => {
    ex = real;
    return { engine_alloc: (n) => { const p = real.engine_alloc(n); copies.push(p); return p; } };
  }, {}, { memoryMaxBytes: 8 * MiB });
  e.start(PRELUDE, 'try { await tool("big"); "fit" } catch (err) { err && err.name }', 's.js');
  fillToSoftLimit(ex, 16);
  copies.length = 0;
  const s = e.settle(1, true, JSON.stringify({ data: 'x'.repeat(MiB) }), UNFIT);
  // The error's first copy was refused, its second made, and the result's refused.
  assert.deepEqual(copies.map((p) => p !== 0), [false, true, false]);
  assert.equal(s.unfit, true);
  assert.equal(fulfilled(s), 'ResultTooLarge');
  e.dispose();
});

test('a result\'s copy is freed once it\'s parsed, so the script\'s code after the call has its memory back', async () => {
  // After a 2 MiB result, a script filling memory in 64 KiB steps gets as many steps as after a
  // tiny one, less the 32 the parsed string holds; a copy still held would take 32 more.
  async function steps(result: string) {
    const { e } = await engine({}, { memoryMaxBytes: 16 * MiB });
    e.start(PRELUDE, 'const r = await tool("t"); const keep = []; try { for (;;) keep.push("y".repeat(65536)) } catch {} [keep.length, r.length]', 's.js');
    const [n] = fulfilled(e.settle(1, true, result, UNFIT)) as [number, number];
    e.dispose();
    return n;
  }
  const tiny = await steps(JSON.stringify('z'));
  const big = await steps(JSON.stringify('z'.repeat(2 * MiB)));
  assert.ok(tiny - big < 48, `${tiny} steps after a tiny result, ${big} after a 2 MiB one`);
});

test('the child\'s error\'s copy is freed once it\'s parsed, so the script\'s code after the call has its memory back', async () => {
  // A result nested too deeply is unfit, and the call gets the child's error, here with a 2 MiB
  // message. A script filling memory in 64 KiB steps after it gets as many steps as after a small
  // one, less the 32 the message holds; a copy still held would take 32 more.
  const deep = '['.repeat(MAX_RESULT_DEPTH + 1) + ']'.repeat(MAX_RESULT_DEPTH + 1);
  async function steps(message: string) {
    const { e } = await engine({}, { memoryMaxBytes: 16 * MiB });
    e.start(PRELUDE, 'let m; try { await tool("t") } catch (err) { m = err.message } const keep = []; try { for (;;) keep.push("y".repeat(65536)) } catch {} [keep.length, m.length]', 's.js');
    const s = e.settle(1, true, deep, JSON.stringify({ name: 'ResultTooLarge', message }));
    assert.equal(s.unfit, true);
    const [n, length] = fulfilled(s) as [number, number];
    assert.equal(length, message.length);
    e.dispose();
    return n;
  }
  const small = await steps('z');
  const big = await steps('z'.repeat(2 * MiB));
  assert.ok(small - big < 48, `${small} steps after a small error, ${big} after a 2 MiB one`);
});

test('settling calls frees both copies, whether the result reaches the script or no call has its id', async () => {
  // Measured through the module's allocator, as the largest block that fits: either copy kept on
  // each of 1,000 settles, with a 1 KiB result and a 1 KiB error, would take 1 MiB or more.
  let ex!: Exports;
  const { e } = await engineAround((real) => { ex = real; return {}; }, {}, { memoryMaxBytes: 16 * MiB });
  const largest = () => {
    let lo = 0, hi = MAX_MEMORY_BYTES;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const p = ex.engine_alloc(mid);
      if (p) { ex.engine_free(p); lo = mid; } else { ex.engine_free(ex.engine_alloc(1)); hi = mid; }
    }
    return lo;
  };
  e.start(PRELUDE, 'for (;;) await tool("t")', 's.js');
  const result = JSON.stringify('r'.repeat(1024));
  const unfit = JSON.stringify({ name: 'ResultTooLarge', message: 'u'.repeat(1024) });
  let id = 1;
  for (let i = 0; i < 200; i++) e.settle(id++, true, result, unfit);
  const before = largest();
  for (let i = 0; i < 1000; i++) e.settle(id++, true, result, unfit);
  for (let i = 0; i < 1000; i++) assert.throws(() => e.settle(1_000_000 + i, true, result, unfit), /no pending call/);
  const after = largest();
  assert.ok(before - after < 64 * 1024, `${before - after} bytes less room after 2,000 settles`);
  e.dispose();
});

test('an ending of exactly MAX_ENDING_BYTES is read, not refused', async () => {
  // The module's buffer here only claims that length, so reading it fails, which a refusal wouldn't.
  // What the module returned can't be read, so dispose() leaves the module as it is.
  let disposals = 0;
  const { e } = await engineAround((ex, imports) => ({
    engine_result: () => {
      const ptr = ex.engine_alloc(8);
      const view = new DataView(imports.env.memory.buffer);
      view.setUint32(ptr, 1, true);
      view.setUint32(ptr + 4, 536_870_888, true);
      return ptr;
    },
    engine_dispose: () => { disposals++; ex.engine_dispose(); return 0; },
  }));
  assert.throws(() => e.start(PRELUDE, '1', 's.js'), (err: unknown) => err instanceof EngineError && /the engine crashed/.test(err.message));
  e.dispose();
  assert.equal(disposals, 0);
});

test('a dispose() that traps throws an EngineError, and the engine is disposed all the same', async () => {
  const { e } = await engineAround(() => ({ engine_dispose: () => { throw new wasm.RuntimeError('unreachable'); } }));
  assert.equal(fulfilled(e.start(PRELUDE, '1', 's.js')), 1);
  assert.throws(() => e.dispose(), (err: unknown) => err instanceof EngineError && /^the engine crashed in dispose\(\): unreachable$/.test(err.message));
  assert.throws(() => e.settle(1, true, '1', UNFIT), /after dispose/);
  assert.doesNotThrow(() => e.dispose());
});

test('dispose frees the runtime after a slot\'s failure, but leaves a module that trapped as it is', async () => {
  let disposals = 0;
  const counting = (ex: Exports): Exports => ({ engine_dispose: () => { disposals++; return ex.engine_dispose(); } });
  const a = await engineAround(counting, { hostCall: () => { throw new Error('gone'); } });
  assert.throws(() => a.e.start(PRELUDE, '__host("a", "{}")', 's.js'), EngineError);
  a.e.dispose();
  assert.equal(disposals, 1);
  const b = await engineAround((ex) => ({ ...counting(ex), engine_start: () => { throw new wasm.RuntimeError('unreachable'); } }));
  assert.throws(() => b.e.start(PRELUDE, '1', 's.js'), /the engine crashed/);
  b.e.dispose();
  assert.equal(disposals, 1);
});

test('a script too large to copy into the guest\'s memory is rejected, not an engine failure', async () => {
  const { e } = await engine({}, { memoryMaxBytes: MIN_MEMORY_BYTES });
  assert.deepEqual(e.start(PRELUDE, `/*${'x'.repeat(3 * MiB)}*/ 1`, 's.js'),
    { kind: 'rejected', name: 'InternalError', message: 'out of memory while loading the script' });
  e.dispose();
});

test('a trap in the module throws an EngineError with the first 4,096 characters the engine wrote, and the engine stays broken', async () => {
  // An assertion in QuickJS writes its message to stderr, then traps. This stands in for one,
  // around the real module: its engine_start writes 3,000 As and then 3,000 Bs, then traps.
  const { e } = await engineAround((ex, imports) => ({
    engine_start: () => {
      for (const [byte, n] of [[0x41, 3000], [0x42, 3000]]) {
        const text = ex.engine_alloc(n), iov = ex.engine_alloc(8), written = ex.engine_alloc(4);
        new Uint8Array(imports.env.memory.buffer, text, n).fill(byte);
        const view = new DataView(imports.env.memory.buffer);
        view.setUint32(iov, text, true);
        view.setUint32(iov + 4, n, true);
        imports.wasi_snapshot_preview1.fd_write(2, iov, 1, written);
      }
      throw new wasm.RuntimeError('unreachable');
    },
  }));
  let crash: unknown;
  assert.throws(() => e.start(PRELUDE, '1', 's.js'), (err: unknown) => {
    crash = err;
    return err instanceof EngineError && /^the engine crashed in start\(\): unreachable \(A{3000}B{1096}\)$/.test(err.message);
  });
  assert.throws(() => e.settle(1, true, '1', UNFIT), (err: unknown) => err === crash);
  e.dispose();
});

test('the guest has JavaScript and the three slots, and nothing that reaches the host', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, `
    const names = ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Bun', 'Deno', 'std', 'os', 'scriptArgs', 'setTimeout', 'Worker', 'WebAssembly'];
    let imported;
    try { await import('node:fs'); imported = 'loaded'; } catch (err) { imported = err.name; }
    ({ present: names.filter((n) => typeof globalThis[n] !== 'undefined'), imported,
       now: Date.now() > 1.7e12, random: Math.random() < 1, regexp: /a(b)/.exec('ab')[1] })`, 's.js');
  // No module loader: an import fails, whatever it names.
  assert.deepEqual(fulfilled(s), { present: [], imported: 'ReferenceError', now: true, random: true, regexp: 'b' });
  e.dispose();
});

test('the guest reads the host\'s clocks: Date.now, and a performance.now that advances', async () => {
  const { e } = await engine();
  const v = fulfilled(e.start(PRELUDE, `
    const t0 = performance.now();
    for (let i = 0; i < 2e6 && performance.now() - t0 < 5; i++);
    [Date.now(), performance.now() - t0 >= 5]`, 's.js')) as [number, boolean];
  // Within a minute of the host's wall clock, which may step either way meanwhile.
  assert.ok(Math.abs(v[0] - Date.now()) < 60_000, `Date.now() in the guest was ${v[0]}, and ${Date.now()} here`);
  assert.equal(v[1], true);
  e.dispose();
});

test('a script reaching the memory limit gets a catchable out-of-memory error, and goes on', async () => {
  for (const [shape, grow] of [
    ['large arrays', 'a.push(new Array(100000).fill(1))'],
    ['small objects', 'a.push({ n: a.length, s: "x" + a.length })'],
    // repeat, not +: QuickJS-ng joins strings as ropes, which double to its length limit without
    // the memory.
    ['a doubling string', 'a[0] = (a[0] ?? "x").repeat(2)'],
  ]) {
    const { e } = await engine({}, { memoryMaxBytes: 16 * MiB });
    const s = e.start(PRELUDE, `
      let a = [], caught;
      try { for (;;) ${grow}; } catch (err) { caught = err === null ? 'null' : [err.name, err.message]; }
      a = null;
      ({ caught, after: [1, 2, 3].map((n) => n * 2).join(',') })`, 's.js');
    const v = fulfilled(s) as { caught: unknown; after: string };
    assert.deepEqual(v.after, '2,4,6', shape);
    assert.ok(Array.isArray(v.caught), `${shape}: caught ${JSON.stringify(v.caught)}`);
    assert.deepEqual(v.caught, ['InternalError', 'out of memory'], shape);
    e.dispose();
  }
});

test('a result too large for the guest\'s memory rejects the call with the child\'s own error', async () => {
  // Too large to copy in at all, and small enough to copy but too large once parsed: many small
  // objects take several times their JSON's size. Neither may reach the script as an out of
  // memory at the call's await, which would read as a failed call that the script might repeat,
  // though the call took effect: the call rejects with the child's ResultTooLarge, and settle
  // says so.
  const one = '{"id":123456,"name":"item-123456","ok":true}';
  for (const [shape, memoryMaxBytes, json] of [
    ['a long string', 8 * MiB, JSON.stringify({ data: 'x'.repeat(12 * MiB) })],
    ['small objects', 32 * MiB, `[${Array(Math.floor((8 * MiB) / one.length)).fill(one).join(',')}]`],
  ] as const) {
    const { e } = await engine({}, { memoryMaxBytes });
    e.start(PRELUDE, 'try { await tool("big"); "fit" } catch (err) { err === null ? "null" : [err.name, err.bytes] }', 's.js');
    const s = e.settle(1, true, json, `{"name":"ResultTooLarge","message":"too large","bytes":${json.length}}`);
    assert.equal(s.unfit, true, shape);
    assert.deepEqual(fulfilled(s), ['ResultTooLarge', json.length], shape);
    e.dispose();
  }
});

test('a result counts against the limit while its call settles, so a script that fills memory then gets a catchable error', async () => {
  // The result's copy is allocated within the guest's limit, beside the value parsed from it,
  // until it's freed after the parse. A script that fills memory afterwards meets the limit's
  // refusal and catches a real error; in the incident this test came from, with the copy outside
  // the limit, it caught a bare null.
  const { e } = await engine({}, { memoryMaxBytes: 32 * MiB });
  e.start(PRELUDE, 'const r = await tool("big"); let a = [], caught; try { for (;;) a.push({ n: a.length }); } catch (err) { caught = err === null ? "null" : err.message; } a = null; [r.length, caught]', 's.js');
  assert.deepEqual(fulfilled(e.settle(1, true, JSON.stringify('x'.repeat(6 * MiB)), UNFIT)), [6 * MiB, 'out of memory']);
  e.dispose();
});

test('a result that fits, beside one that didn\'t, settles as usual', async () => {
  const { e } = await engine({}, { memoryMaxBytes: 8 * MiB });
  e.start(PRELUDE, 'const a = tool("big"), b = tool("small"); [await a.catch((err) => err.name), await b]', 's.js');
  const big = e.settle(1, true, JSON.stringify({ data: 'x'.repeat(12 * MiB) }), UNFIT);
  assert.deepEqual(big, { kind: 'pending', unfit: true });
  const small = e.settle(2, true, '"ok"', UNFIT);
  assert.equal(small.unfit, undefined);
  assert.deepEqual(fulfilled(small), ['ResultTooLarge', 'ok']);
  e.dispose();
});

test('deep recursion throws a catchable RangeError at the stack limit, which maxStackBytes sets', async () => {
  const depths: number[] = [];
  for (const maxStackBytes of [64 * 1024, undefined]) {
    const { e } = await engine({}, { maxStackBytes });
    const s = e.start(PRELUDE, 'let depth = 0; function f() { depth++; return f() + 1 }\ntry { f() } catch (err) { [err.name, err.message, depth] }', 's.js');
    const [name, message, depth] = fulfilled(s) as [string, string, number];
    assert.deepEqual([name, message], ['RangeError', 'Maximum call stack size exceeded'], String(maxStackBytes));
    depths.push(depth);
    e.dispose();
  }
  // 64 KiB is a third of the default's 192 KiB.
  assert.ok(depths[0] * 2 < depths[1], `depths ${depths.join(' and ')}`);
});

test('recursion through getters, proxy traps and built-ins that call back gets the catchable RangeError at the most stack allowed, not a crash', async () => {
  // Each level also takes the host's own stack, two to three times what QuickJS's check counts,
  // so a limit too high lets the host's stack run out first and crash the engine.
  const shapes: Record<string, string> = {
    plain: 'function f() { depth++; return f() + 1 } f()',
    getter: 'const o = { get x() { depth++; return o.x + 1 } }; o.x',
    toString: 'const o = { toString() { depth++; return String(o) } }; String(o)',
    map: 'function g() { depth++; return [0].map(g)[0] + 1 } g()',
    ownKeys: 'const p = new Proxy({}, { ownKeys() { depth++; return Object.keys(p) } }); Object.keys(p)',
    forOf: 'const it = { [Symbol.iterator]() { depth++; for (const x of it) {} return { next: () => ({ done: true }) } } }; for (const x of it) {}',
    toJSON: 'const o = { toJSON() { depth++; return JSON.stringify(o) } }; JSON.stringify(o)',
    generator: 'function* gen() { depth++; yield* gen() } [...gen()]',
  };
  for (const [shape, body] of Object.entries(shapes)) {
    const { e } = await engine({}, { maxStackBytes: MAX_STACK_BYTES });
    const s = e.start(PRELUDE, `let depth = 0;\ntry { ${body} } catch (err) { [err.name, err.message, depth] }`, 's.js');
    const [name, message, depth] = fulfilled(s) as [string, string, number];
    assert.deepEqual([name, message], ['RangeError', 'Maximum call stack size exceeded'], shape);
    assert.ok(depth > 50, `${shape}: ${depth}`);
    e.dispose();
  }
});

test('limits outside their range are refused before anything loads', async () => {
  const slots: EngineSlots = { hostCall: () => {}, interrupt: () => false, supervise: () => {}, output: () => {} };
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB + 1 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: MIN_MEMORY_BYTES - 65536 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: MAX_MEMORY_BYTES + 65536 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: MAX_STACK_BYTES + 1 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: 8 * 1024 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: 64 * 1024 + 0.5 }, slots), RangeError);
});

test('both ends of the memory range load and run', async () => {
  // At the least, a call settles and the limit gives a catchable error; at the most, the guest
  // holds an array larger than any other test's whole budget.
  const least = await engine({}, { memoryMaxBytes: MIN_MEMORY_BYTES });
  least.e.start(PRELUDE, 'const r = await tool("t"); let a = [], caught; try { for (;;) a.push({ n: a.length }); } catch (err) { caught = err.message; } a = null; [r, caught]', 's.js');
  assert.deepEqual(fulfilled(least.e.settle(1, true, '"ok"', UNFIT)), ['ok', 'out of memory']);
  least.e.dispose();
  const most = await engine({}, { memoryMaxBytes: MAX_MEMORY_BYTES });
  most.e.start(PRELUDE, 'const r = await tool("t"); [r, new Uint8Array(192 * 1024 * 1024).length]', 's.js');
  assert.deepEqual(fulfilled(most.e.settle(1, true, '"ok"', UNFIT)), ['ok', 192 * MiB]);
  most.e.dispose();
});

test('dispose frees a runtime with calls still pending, and nothing is allowed after it', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await Promise.all([tool("a"), tool("b")])', 's.js');
  e.dispose();
  assert.throws(() => e.settle(1, true, '1', UNFIT), /after dispose/);
});
