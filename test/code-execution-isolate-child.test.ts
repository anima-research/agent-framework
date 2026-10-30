/**
 * The isolate's child, in process, on the stand-in engine: what it sends for each
 * way a script can end, how it settles calls, how it bounds and flushes output,
 * and how a stop reaches it idle or computing.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild, STOP_CHECK_MS, type ChildIo } from '../src/code-execution/isolate/child.js';
import type { ParentMessage, StartMessage } from '../src/code-execution/isolate/protocol.js';
import { loadFakeEngine } from './helpers/fake-engine.js';
import type { Engine, EngineSlots, RunState, SettleState } from '../src/code-execution/engine.js';
import { MAX_BATCH_CHARS } from '../src/code-execution/isolate/output.js';
import { encodeFrame, FrameDecoder } from '../src/code-execution/isolate/frames.js';
import { bounded, NAME_CHARS, VALUE_CHARS } from '../src/code-execution/isolate/render.js';
import { SCRIPT_FRAME, SCRIPT_LINE_OFFSET, SCRIPT_PLACE, scriptFrames, WAKE_CALL_NAME } from '../src/code-execution/isolate/prelude.js';

type Sent = Record<string, unknown>;

/** A value's JSON as the bytes a result frame carries. */
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

/** A child's channel in memory: its sends, a queue of parent frames, and a clock that moves 1 ms a read. */
function channel(answer?: (call: Sent, push: (m: ParentMessage) => void) => void) {
  const sent: Sent[] = [];
  const queue: ParentMessage[] = [];
  let waiter: (() => void) | null = null;
  let t = 0;
  const push = (m: ParentMessage) => {
    queue.push(m);
    waiter?.();
  };
  const io: ChildIo = {
    async next() {
      while (queue.length === 0) await new Promise<void>((r) => (waiter = r));
      return queue.shift()!;
    },
    send(message) {
      // As the child's process sends it: a message too long for a frame throws, and nothing is sent.
      const frame = encodeFrame(message);
      const m = JSON.parse(frame.subarray(5).toString('utf8')) as Sent;
      sent.push(m);
      if (m.t === 'call' && answer) queueMicrotask(() => answer(m, push));
    },
    now: () => (t += 1),
  };
  return { io, sent, push };
}

function start(script: string, over: Partial<StartMessage> = {}): StartMessage {
  return {
    t: 'start',
    script,
    tools: [
      { name: 'echo', description: 'Echoes its arguments.' },
      { name: 'workspace--read', description: 'Reads a file.' },
    ],
    memoryMaxBytes: 64 * 1024 * 1024,
    stopFile: join(tmpdir(), `no-stop-${process.pid}-${Math.random()}`),
    flushMs: 1_000_000,
    maxWakes: 100,
    parentPid: process.pid,
    ...over,
  } as StartMessage;
}

const ends = (sent: Sent[]) => sent.filter((m) => m.t === 'end');
const output = (sent: Sent[]) => ({ head: sent.filter((m) => m.t === 'out').map((m) => m.text as string).join('') });

const echo = (call: Sent, push: (m: ParentMessage) => void) =>
  push({ t: 'result', id: call.id as number, ok: true, json: bytes({ content: [{ type: 'text', text: call.args }], structuredContent: null, isError: false }) });

test('a script that calls a tool, prints and returns finishes with its value and its output', async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`const r = await tools.echo({ n: 1 }); text(r.content[0].text); return { got: r.isError };`), loadFakeEngine);
  assert.deepEqual(sent.filter((m) => m.t === 'call').map((m) => [m.name, m.args]), [['echo', '{"n":1}']]);
  assert.equal(output(sent).head, '{"n":1}\n');
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '{"got":false}' }]);
});

test('a script that throws fails with the error, and its output so far is sent first', async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`text('before'); throw new RangeError('no such page');`), loadFakeEngine);
  const last = sent.at(-1)!;
  assert.equal(last.how, 'failed');
  assert.equal((last.error as Sent).name, 'RangeError');
  assert.equal((last.error as Sent).message, 'no such page');
  assert.equal(output(sent).head, 'before\n');
  assert.ok(sent.findIndex((m) => m.t === 'out') < sent.findIndex((m) => m.t === 'end'));
});

test('a refusal before dispatch reaches the script as an Error with its fields', async () => {
  const { io, sent } = channel((call, push) =>
    push({ t: 'result', id: call.id as number, ok: false, json: bytes({ name: 'ToolRefused', message: 'not allowed now; nothing was sent', code: 'not_allowed' }) }));
  await runChild(io, start(`try { await tools.echo({}); } catch (e) { return [e instanceof Error, e.name, e.message, e.code]; }`), loadFakeEngine);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '[true,"ToolRefused","not allowed now; nothing was sent","not_allowed"]' }]);
});

test('a name that is not a tool throws at once, naming the close match, and sends nothing', async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`try { tools['workspace-read']; } catch (e) { return e.message; }`), loadFakeEngine);
  assert.equal(sent.filter((m) => m.t === 'call').length, 0);
  const value = JSON.parse(ends(sent)[0]!.value as string) as string;
  assert.match(value, /is not one of your tools\. Did you mean tools\["workspace--read"\]\? Nothing was sent\./);
});

test('a script waiting on a promise nothing can settle fails at once, as stalled', async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`await new Promise(() => {});`), loadFakeEngine);
  const end = ends(sent)[0]!;
  assert.equal(end.how, 'failed');
  assert.equal(end.stalled, true);
});

test('a script that returns with a call in flight ends only once that call is answered', async () => {
  let held: Sent | null = null;
  const { io, sent, push } = channel((call) => { held = call; });
  const done = runChild(io, start(`tools.echo({ late: true }).then((r) => text('answered')); return 'returned';`), loadFakeEngine);
  // Once the call is out, the guest has returned and waits on it.
  for (let i = 0; i < 500 && held === null; i++) await new Promise((r) => setTimeout(r, 2));
  assert.notEqual(held, null, 'the call went out');
  await new Promise((r) => setImmediate(r));
  assert.equal(ends(sent).length, 0, 'not ended while the call is in flight');
  push({ t: 'result', id: held!.id as number, ok: true, json: Buffer.from('{"content":[],"structuredContent":null,"isError":false}') });
  await done;
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '"returned"' }]);
  assert.equal(output(sent).head, 'answered\n');
});

test('a stop frame ends an idle script as stopped', async () => {
  const { io, sent, push } = channel(() => {});
  const done = runChild(io, start(`await tools.echo({});`), loadFakeEngine);
  await new Promise((r) => setTimeout(r, 5));
  push({ t: 'stop' });
  await done;
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'stopped' }]);
});

test('the stop file stops a spinning guest as soon as it exists, empty as the parent makes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolate-stop-'));
  try {
    const stopFile = join(dir, 'stop');
    const { io, sent } = channel(echo);
    let ticks = 0;
    // Bounded, so a stop the guest never sees fails the test rather than hanging it.
    await runChild(io, start(`text('spinning'); for (let i = 0; i < 1e6; i++) __tick(); return 'never stopped';`, { stopFile }), async (limits, slots) =>
      loadFakeEngine(limits, {
        ...slots,
        interrupt() {
          if (++ticks === 20) writeFileSync(stopFile, '');
          return slots.interrupt();
        },
      }));
    assert.deepEqual(ends(sent), [{ t: 'end', how: 'stopped' }]);
    assert.equal(output(sent).head, 'spinning\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a call whose arguments pass a call's bytes or values is answered in the child, and nothing is sent", async () => {
  const { io, sent } = channel(echo);
  await runChild(
    io,
    start(
      `const out = [];
       try { await tools.echo({ big: 'x'.repeat(4 * 1024 * 1024) }); } catch (e) { out.push(e.name, e.bytes > 4 * 1024 * 1024, /nothing was sent/.test(e.message)); }
       try { await tools.echo({ many: Array.from({ length: 100001 }, () => 1) }); } catch (e) { out.push(e.name); }
       try { await wake_agent({ long: 'w'.repeat(65 * 1024) }); } catch (e) { out.push(e.name, /64 KiB|65536/.test(e.message)); }
       return out;`,
    ),
    loadFakeEngine,
  );
  assert.equal(sent.filter((m) => m.t === 'call').length, 0);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '["ArgumentsTooLarge",true,true,"ArgumentsTooLarge","WakeRefused",true]' }]);
});

test("while a result settles, the calls the guest's jobs make go out after its seen", async () => {
  const { io, sent } = channel(echo);
  // Each answer's continuation makes the next call, inside the settle that delivers the answer.
  await runChild(io, start(`await tools.echo({ n: 1 }); await tools.echo({ n: 2 }); return 'done';`), loadFakeEngine);
  const order = sent.filter((m) => m.t === 'call' || m.t === 'seen').map((m) => `${m.t} ${m.id}`);
  assert.deepEqual(order, ['call 1', 'seen 1', 'call 2', 'seen 2']);
});

test("the ending's value, or a failure's name, message and stack, goes out cut to what a return shows", async () => {
  const value = channel(echo);
  await runChild(value.io, start(`return 'v'.repeat(20000);`), loadFakeEngine);
  const finished = ends(value.sent)[0]!;
  assert.ok((finished.value as string).length < 8200, `the value went out at ${(finished.value as string).length} characters`);
  assert.match(finished.value as string, /characters dropped here/);
  const failure = channel(echo);
  await runChild(failure.io, start(`const e = new Error('m'.repeat(20000)); e.name = 'N'.repeat(20000); throw e;`), loadFakeEngine);
  const failed = ends(failure.sent)[0]! as { error: { name: string; message: string; stack?: string } };
  assert.ok(failed.error.message.length < 8200);
  assert.match(failed.error.message, /characters dropped here/);
  // A name is a word: it keeps far less, so the message and the frames keep the room.
  assert.ok(failed.error.name.length < 300, `the name went out at ${failed.error.name.length} characters`);
  // The frames go apart from the name and message, put as the agent reads them and cut on their own, as many as a deep recursion leaves.
  const deep = channel(echo);
  const frames = Array.from({ length: 2_000 }, (_, i) => `    at f (<input>:${i + 3}:5)`).join('\n');
  await runChild(deep.io, start('ignored'), scriptedEngine([], { kind: 'failed', name: 'N'.repeat(500), message: 'Maximum call stack size exceeded', stack: frames }, () => ({ kind: 'pending' })));
  const recursed = ends(deep.sent)[0]! as { error: { name: string; message: string; stack?: string } };
  // Cut once, so the count dropped is the frames' own, not a first cut's marker.
  assert.equal(recursed.error.stack, bounded(scriptFrames(frames), VALUE_CHARS));
  assert.ok(recursed.error.stack !== undefined && recursed.error.stack.length < 8200, `the frames went out at ${recursed.error.stack?.length} characters`);
  assert.match(recursed.error.stack!, /^ {4}at f \(script:1:5\)\n/);
  assert.match(recursed.error.stack!, /characters dropped here/);
  assert.match(recursed.error.stack!, / {4}at f \(script:2000:5\)$/);
});

test('a spinning guest whose io has no orphaned hook stops once its parent has gone', async () => {
  // child-main's io ends the process instead (orphaned), which the tests of a child process below run.
  const { io, sent } = channel(echo);
  let checks = 0;
  io.parentGone = () => ++checks > 3;
  await runChild(io, start(`text('spinning'); for (let i = 0; i < 1e6; i++) __tick(); return 'never stopped';`), loadFakeEngine);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'stopped' }]);
});

test('the child looks for its parent at most once a stop check, however often the engine checks', async () => {
  const { io, sent } = channel(echo);
  // The clock stands still, so every check after the first falls within one stop check.
  io.now = () => 0;
  let looks = 0;
  io.parentGone = () => { looks += 1; return false; };
  await runChild(io, start(`for (let i = 0; i < 1e4; i++) __tick(); return 'ran';`), loadFakeEngine);
  assert.equal(looks, 1);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '"ran"' }]);
});

test('an orphan ends before it sends the output waiting to go, when the two fall due at one check', async () => {
  const { io, sent } = channel(echo);
  // The clock stands still through the first check, its look for the parent
  // and then its interrupt, and jumps past flushMs for the next: at that
  // check, the parent is gone and the output written before it is due, and
  // the parent is looked for first.
  let looks = 0;
  let readsAfterFirstLook = 0;
  io.now = () => (looks === 0 || ++readsAfterFirstLook <= 1 ? 0 : 100);
  let sentBeforeOrphaned: string[] | undefined;
  io.parentGone = () => ++looks > 1;
  io.orphaned = (() => {
    sentBeforeOrphaned = sent.map((m) => m.t as string);
  }) as () => never;
  await runChild(io, start(`text('pending'); for (let i = 0; i < 1e6; i++) __tick(); return 'never stopped';`, { flushMs: 10 }), loadFakeEngine);
  assert.deepEqual(sentBeforeOrphaned, [], 'nothing went out before the orphan ended');
  // This io's orphaned returns, so the guest is stopped, and the output then goes with the ending.
  assert.deepEqual(sent.map((m) => m.t), ['out', 'end']);
});

test('an orphan whose guest runs on past a stop it took before its parent went still ends its process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolate-stop-'));
  try {
    const stopFile = join(dir, 'stop');
    writeFileSync(stopFile, '');
    const { io, sent } = channel(echo);
    // Each look a stop check apart. The guest has its stop at once and keeps it from ending it, as
    // a script can keep QuickJS from taking one; its parent goes only after that.
    let clock = 0;
    io.now = () => (clock += STOP_CHECK_MS);
    let looks = 0;
    io.parentGone = () => ++looks > 20;
    let orphaned = 0;
    io.orphaned = (() => { orphaned += 1; }) as () => never;
    await runChild(io, start(`for (let i = 0; i < 1e5; i++) { try { __tick() } catch {} } return 'ran on';`, { stopFile }), loadFakeEngine);
    assert.ok(looks > 20, `the child looked for its parent ${looks} times, its stop taken`);
    assert.equal(orphaned, 1);
    assert.deepEqual(ends(sent), [{ t: 'end', how: 'stopped' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orphan whose stop file is there too ends its process rather than stop its guest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolate-stop-'));
  try {
    const stopFile = join(dir, 'stop');
    writeFileSync(stopFile, '');
    const { io, sent } = channel(echo);
    io.parentGone = () => true;
    let orphaned = 0;
    io.orphaned = (() => { orphaned += 1; }) as () => never;
    await runChild(io, start(`for (let i = 0; i < 1e6; i++) __tick(); return 'never stopped';`, { stopFile }), loadFakeEngine);
    // A guest can keep a stop from ending it, and with its parent gone nothing would kill it.
    assert.equal(orphaned, 1);
    assert.deepEqual(ends(sent), [{ t: 'end', how: 'stopped' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a printing loop is flushed in bounded batches, and every character arrives', async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`for (let i = 0; i < 20000; i++) text('line ' + i);`), loadFakeEngine);
  const outs = sent.filter((m) => m.t === 'out').map((m) => m.text as string);
  assert.ok(outs.length > 1, 'more than one batch');
  assert.ok(outs.every((t) => t.length <= MAX_BATCH_CHARS), 'no batch past the bound');
  assert.equal(outs.join(''), Array.from({ length: 20000 }, (_, i) => `line ${i}\n`).join(''));
});

test('a stop after the script has returned ends the wait for its calls, and the script ends as it did', async () => {
  const { io, sent, push } = channel(() => {});
  const done = runChild(io, start(`tools.echo({ late: true }); return 'returned';`), loadFakeEngine);
  for (let i = 0; i < 500 && !sent.some((m) => m.t === 'call'); i++) await new Promise((r) => setTimeout(r, 2));
  push({ t: 'stop' });
  await done;
  // Its own ending came first: the stop cut only the wait for the call in flight.
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '"returned"' }]);
});

test('output written before a call reaches the parent before the call does', async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`text('before'); await tools.echo({}); return 1;`), loadFakeEngine);
  const order = sent.filter((m) => m.t === 'out' || m.t === 'call').map((m) => m.t);
  assert.deepEqual(order, ['out', 'call']);
});

test("a wake made while a result settles goes out at once, ahead of that result's seen", async () => {
  const { io, sent } = channel(echo);
  await runChild(io, start(`await tools.echo({}); wake_agent('working'); for (let i = 0; i < 1e5; i++) __tick(); return 1;`), loadFakeEngine);
  const order = sent.filter((m) => m.t === 'call' || m.t === 'seen').map((m) => `${m.t} ${m.name ?? m.id}`);
  // The wake takes no place among the calls in flight, so nothing holds it for the seen.
  assert.deepEqual(order, ['call echo', 'call (wake_agent)', 'seen 1', 'seen 2']);
});

test('a wake refused for its size uses none of the script\'s wakes', async () => {
  const { io, sent } = channel((call, push) => push({ t: 'result', id: call.id as number, ok: true, json: bytes(null) }));
  await runChild(io, start(
    `let first; try { await wake_agent('x'.repeat(70000)); } catch (e) { first = e.name; } await wake_agent('small'); try { await wake_agent('one more'); } catch (e) { return [first, e.name, /wake limit reached: 1 per script/.test(e.message)]; }`,
    { maxWakes: 1 },
  ), loadFakeEngine);
  assert.deepEqual(sent.filter((m) => m.t === 'call').map((m) => m.args), ['"small"']);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '["WakeRefused","WakeRefused",true]' }]);
});

test("a child whose start names a parent that isn't its parent ends its process, as an orphan does", async () => {
  const entry = fileURLToPath(new URL(`./helpers/fake-child-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'af-orphan-'));
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'], cwd: dir, env: {} });
  try {
    const frames: Sent[] = [];
    const decoder = new FrameDecoder();
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => { for (const v of decoder.push(chunk)) frames.push(v as Sent); });
    // Its parent is this process, but the start names another: what a child whose parent died before it read its start sees.
    child.stdin!.write(encodeFrame(start(`for (;;) __tick();`, { stopFile: join(dir, 'stop'), parentPid: process.pid + 100_000 })));
    // fd 3's last data can come after the exit, so both are waited for.
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const drained = new Promise<void>((resolve) => (child.stdio[3] as NodeJS.ReadableStream).on('end', () => resolve()));
    let bound: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      Promise.all([exited, drained]).then(([c]) => c),
      new Promise<'spinning'>((resolve) => (bound = setTimeout(() => resolve('spinning'), 10_000))),
    ]);
    clearTimeout(bound);
    // An orphan has no one to report to: it ends its process at once.
    assert.equal(code, 0, 'the child ended');
    assert.deepEqual(frames.filter((m) => m.t === 'end'), []);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop that interrupts a call's continuation after the script returned leaves the script's ending as it was", async () => {
  const { io, sent } = channel(echo);
  let checks = 0;
  // The parent goes once the continuation spins: the interrupt stops the guest.
  io.parentGone = () => ++checks > 3;
  // Its rejection is caught, so the stand-in under Bun, which reports a guest's unhandled rejection, has none to report.
  await runChild(io, start(`tools.echo({}).then(() => { for (;;) __tick(); }).catch(() => {}); return 'returned';`), loadFakeEngine);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'finished', value: '"returned"' }]);
});

test('a spinning child whose parent is killed stops, orphaned for real', async () => {
  const ext = extname(fileURLToPath(import.meta.url));
  const childEntry = fileURLToPath(new URL(`./helpers/fake-child-entry${ext}`, import.meta.url));
  const parentEntry = fileURLToPath(new URL(`./helpers/orphan-parent-entry${ext}`, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'af-orphan-'));
  // It says it's running, from inside its run, and spins: its parent goes only after that.
  const { parentPid: _unused, ...message } = start(`text('spinning'); for (;;) __tick();`, { stopFile: join(dir, 'stop'), flushMs: 0 }) as unknown as Record<string, unknown>;
  const parent = spawn(process.execPath, [parentEntry, childEntry], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CHILD_DIR: dir, START: JSON.stringify(message) } });
  let childPid = 0;
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      let out = '';
      parent.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('\n')) resolve(Number(out.trim()));
      });
      parent.on('exit', (code) => reject(new Error(`the parent exited (code ${code}) before its child's first output`)));
    });
    // Gone, or a zombie its new parent hasn't reaped yet, which ps marks Z on Linux and macOS alike.
    const alive = () => {
      try { process.kill(childPid, 0); } catch { return false; }
      // Where ps can't say (no ps, as on Windows, or the process reaped since
      // the signal's answer), the signal is asked again.
      try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' }).trim().startsWith('Z'); } catch {
        try { process.kill(childPid, 0); return true; } catch { return false; }
      }
    };
    assert.equal(alive(), true, 'the child is running');
    // Its parent goes; nothing tells the child but its parent pid changing.
    parent.kill('SIGKILL');
    const deadline = Date.now() + 10_000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(), false, 'the orphaned child stopped');
  } finally {
    parent.kill('SIGKILL');
    if (childPid) try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An engine standing in for QuickJS's answers: start makes the calls named and answers `started`; each settle answers from `settled`. */
function scriptedEngine(calls: string[], started: RunState, settled: (id: number) => SettleState) {
  return async (_limits: unknown, slots: EngineSlots): Promise<Engine> => ({
    start() {
      calls.forEach((name, i) => slots.hostCall(i + 1, name, '{}'));
      return started;
    },
    settle: (id: number) => settled(id),
    dispose() {},
  }) as unknown as Engine;
}

test("a failure after the script's ending was kept ends the run as failed, at once", async () => {
  const { io, sent } = channel(echo);
  // The script returned with a call out; that call's result runs a callback that throws.
  await runChild(io, start('ignored'), scriptedEngine(['echo'], { kind: 'fulfilled', json: '1' }, () => ({ kind: 'failed', name: 'Error', message: 'late', stack: '    at cb (<input>:4:3)\n    at <native>' })));
  assert.deepEqual(sent.filter((m) => m.t === 'seen').map((m) => m.id), [1], 'the result reached the script');
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'failed', error: { name: 'Error', message: 'late', stack: '    at cb (script:2:3)' } }]);
});

test("a result that never reached the script has no seen, and a failure ends the run without waiting for the calls still out", async () => {
  // Only the first call is answered: a child that waited for the second would never end.
  const { io, sent } = channel((call, push) => { if (call.id === 1) echo(call, push); });
  const running = runChild(io, start('ignored'), scriptedEngine(['echo', 'echo'], { kind: 'pending' }, () => ({ kind: 'failed', name: 'InternalError', message: 'out of memory', dropped: true })));
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('the child kept waiting for the call still out')), 5_000))]);
  assert.deepEqual(sent.filter((m) => m.t === 'seen'), [], 'the script never read it, and the run is over');
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'failed', error: { name: 'InternalError', message: 'out of memory' } }]);
});

/** An engine standing in for QuickJS, each of whose parts a test sets. */
function stubEngine(parts: { start?: (slots: EngineSlots) => RunState; settle?: (id: number, ok: boolean, json: unknown, unfit: string, slots: EngineSlots) => SettleState; dispose?: () => void }) {
  return async (_limits: unknown, slots: EngineSlots): Promise<Engine> => ({
    start: () => (parts.start ? parts.start(slots) : { kind: 'pending' }),
    settle: (id: number, ok: boolean, json: unknown, unfit: string) => (parts.settle ? parts.settle(id, ok, json, unfit, slots) : { kind: 'pending' }),
    dispose: () => parts.dispose?.(),
  }) as unknown as Engine;
}

test("a failure in the run stands over dispose()'s, and dispose()'s alone is thrown", async () => {
  const loop = channel();
  await assert.rejects(
    runChild(loop.io, start('ignored'), stubEngine({ start: () => { throw new Error('the loop failed'); }, dispose: () => { throw new Error('dispose failed'); } })),
    /the loop failed/,
  );
  const clean = channel();
  await assert.rejects(
    runChild(clean.io, start('ignored'), stubEngine({ start: () => ({ kind: 'fulfilled', json: '1' }), dispose: () => { throw new Error('dispose failed'); } })),
    /dispose failed/,
  );
});

test('a run that fails at its start ends as failed', async () => {
  const { io, sent } = channel();
  await runChild(io, start('ignored'), stubEngine({ start: () => ({ kind: 'failed', name: 'Error', message: 'at once' }) }));
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'failed', error: { name: 'Error', message: 'at once' } }]);
});

test("a failure in a call answered in the child ends the run, and settles no more of them", async () => {
  const { io, sent } = channel();
  let settles = 0;
  // Two wakes past a cap of 0, answered in the child, the first's settle failing.
  await runChild(io, start('ignored', { maxWakes: 0 }), stubEngine({
    start: (slots) => { slots.hostCall(1, '(wake_agent)', '1'); slots.hostCall(2, '(wake_agent)', '2'); return { kind: 'pending' }; },
    settle: () => { settles += 1; return { kind: 'failed', name: 'Error', message: 'in a job' }; },
  }));
  assert.equal(settles, 1);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'failed', error: { name: 'Error', message: 'in a job' } }]);
});

test("an answer in a result's place the script can't take keeps its name and its message's start", async () => {
  let unfitGiven = '';
  const refusal = JSON.stringify({ name: 'ToolRefused', message: `not allowed: ${'no '.repeat(5_000)}`, tool: 'echo' });
  const { io } = channel((call, push) => push({ t: 'result', id: call.id as number, ok: false, json: Buffer.from(refusal) }));
  await runChild(io, start('ignored'), stubEngine({
    start: (slots) => { slots.hostCall(1, 'echo', '{}'); return { kind: 'pending' }; },
    settle: (_id, _ok, _json, unfit) => { unfitGiven = unfit; return { kind: 'fulfilled', json: '1', unfit: true }; },
  }));
  const given = JSON.parse(unfitGiven) as { name: string; message: string; bytes: number };
  assert.equal(given.name, 'ToolRefused');
  assert.match(given.message, /^not allowed: no no/);
  assert.ok(given.message.length < 2_400, `${given.message.length} characters`);
  assert.match(given.message, /couldn't be received by this script whole: it was too large for its memory, or nested deeper than 2000 levels\)$/);
  assert.equal(given.bytes, Buffer.byteLength(refusal));
});

test("an unfit answer's name is held to a name's bound, and a wake's is named as the script wrote it", async () => {
  const given: string[] = [];
  const answer = JSON.stringify({ name: 'N'.repeat(5_000), message: 'refused' });
  const { io } = channel((call, push) => push({ t: 'result', id: call.id as number, ok: call.name === WAKE_CALL_NAME, json: Buffer.from(call.name === WAKE_CALL_NAME ? '[' : answer) }));
  await runChild(io, start('ignored'), stubEngine({
    start: (slots) => { slots.hostCall(1, 'echo', '{}'); slots.hostCall(2, WAKE_CALL_NAME, '1'); return { kind: 'pending' }; },
    settle: (_id, _ok, _json, unfit) => { given.push(unfit); return given.length === 2 ? { kind: 'fulfilled', json: '1', unfit: true } : { kind: 'pending', unfit: true }; },
  }));
  const [refused, wake] = given.map((g) => JSON.parse(g) as { name: string; message: string; bytes: number });
  assert.equal(refused!.name, bounded('N'.repeat(5_000), NAME_CHARS));
  assert.equal(refused!.bytes, Buffer.byteLength(answer));
  assert.match(wake!.message, /^wake_agent's result, 1 bytes, couldn't be received by this script: .*Calling it again would do the call again, its effect included, and likely bring the same result, so if the call only reads, ask the tool for less if it can$/);
});

test('a guest that makes more calls than it may have out while a result settles has the rest sent at once, and is stopped', async () => {
  const { io, sent } = channel((call, push) => { if (call.id === 1) echo(call, push); });
  await runChild(io, start('ignored'), stubEngine({
    start: (slots) => { slots.hostCall(1, 'echo', '{}'); return { kind: 'pending' }; },
    // While the result settles, the guest's jobs call 20 times more.
    settle: (_id, _ok, _json, _unfit, slots) => {
      for (let i = 2; i <= 21; i++) slots.hostCall(i, 'echo', '{}');
      return { kind: 'pending' };
    },
  }));
  const order = sent.filter((m) => m.t === 'call' || m.t === 'seen').map((m) => (m.t === 'seen' ? 'seen' : m.id));
  // The four past the 16 held went out at once; the seen, then the 16 held.
  assert.deepEqual(order.slice(0, 6), [1, 18, 19, 20, 21, 'seen']);
  assert.equal(order.length, 1 + 4 + 1 + 16);
  assert.deepEqual(ends(sent), [{ t: 'end', how: 'stopped' }]);
});

test("a failure's frames are the script's own, numbered as written: the lines of its stack shaped as QuickJS writes them", () => {
  const raw = [
    '    at f (<input>:5:11)',
    '    at <anonymous> (<input>:7:1)',
    '    at run (<prelude>:250:20)',
    '    at <native>',
    '    at <eval> (script.js:1:7)',
    '',
  ].join('\n');
  // QuickJS's own stack: frames only, ending in a newline.
  assert.equal(scriptFrames(raw), '    at f (script:3:11)\n    at <anonymous> (script:5:1)');
  // A line before the script's first is its first, and a syntax error's place has no parentheses.
  assert.equal(scriptFrames('    at f (<input>:1:2)\n    at <input>:4:9'), '    at f (script:1:2)\n    at script:2:9');
  // No frame of the script's: none.
  assert.equal(scriptFrames('    at <native>'), '');
  assert.equal(scriptFrames(''), '');
  // A stack the script set, opening as V8's do: its head, a line of its message shaped as a frame, and a line naming the
  // script's source are no frames. Only a line shaped as QuickJS writes one of the script's frames is.
  assert.equal(scriptFrames('Error: see <input>:4\n    at note (script:9:1)\nsee <input>:3\n    at f (<input>:5:5)'), '    at f (script:3:5)');
  // A function's name with a line break splits its frame, which is left out, and no other is; one with leading spaces is kept.
  assert.equal(
    scriptFrames('    at fail (<input>:3:20)\n    at outer\nlabel (<input>:4:30)\n    at  run (<input>:5:1)\n    at anonymous (<input>:6:1)'),
    '    at fail (script:1:20)\n    at  run (script:3:1)\n    at anonymous (script:4:1)',
  );
  // A name that holds a place of the script's: only the place at the line's end is renumbered.
  assert.equal(scriptFrames('    at x <input>:9:9 (<input>:5:5)'), '    at x <input>:9:9 (script:3:5)');
  // A line whose place of the script's isn't at its end isn't a frame.
  assert.equal(scriptFrames('    at f (<input>:5:5) and more'), '');
  // Nor is one that doesn't open with the spaces and `at` a frame opens with, though it holds one after its start.
  assert.equal(scriptFrames('Error: boom    at f (<input>:5:5)\nboom at <input>:6:1'), '');
  // A name may hold a carriage return, U+2028 or U+2029: only a line feed splits a frame.
  assert.equal(
    scriptFrames('    at a\rb (<input>:5:1)\n    at c\u2028d (<input>:6:2)\n    at e\u2029f (<input>:7:3)'),
    '    at a\rb (script:3:1)\n    at c\u2028d (script:4:2)\n    at e\u2029f (script:5:3)',
  );
  // Cut as they're read, as bounded cuts them: a stack the script set can be any length, as many lines as characters.
  const long = Array.from({ length: 3_000 }, (_, i) => `    at f${i} (<input>:${i + 3}:5)`).join('\nnot a frame\n');
  const expected = bounded(scriptFrames(long), 8_000);
  assert.equal(scriptFrames(long, 8_000), expected);
  assert.equal(scriptFrames(long, 1_000_000), scriptFrames(long));
  assert.equal(scriptFrames('\n'.repeat(2_000_000), 8_000), '');
  // A line at a time, the stack never split whole: it can hold more lines than an array can hold elements (Alfred-2570's
  // run crashed V8 at 140 million).
  const split = String.prototype.split;
  (String.prototype as { split: unknown }).split = () => { throw new Error('scriptFrames split the whole stack'); };
  try {
    assert.equal(scriptFrames(long, 8_000), expected);
  } finally {
    String.prototype.split = split;
  }
  // One frame longer than the cut: its head and its end, the place renumbered.
  const wide = `    at ${'n'.repeat(50_000)} (<input>:7:3)`;
  assert.equal(scriptFrames(wide, 8_000), bounded(`    at ${'n'.repeat(50_000)} (script:5:3)`, 8_000));
});

test("the frames read from a whole stack are the rule's, line by line, and their cut is bounded's", () => {
  // The rule as the guest's copy applies it, a line at a time (errorText).
  const rule = (stack: string): string => stack.split('\n')
    .filter((line) => SCRIPT_FRAME.test(line))
    .map((line) => line.replace(SCRIPT_PLACE, (_m, n: string, rest: string) => `script:${Math.max(1, Number(n) - SCRIPT_LINE_OFFSET)}${rest}`))
    .join('\n');
  // mulberry32, whose 32-bit steps lose nothing in a JavaScript number.
  let seed = 11;
  const next = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const pick = <T>(items: readonly T[]): T => items[next(items.length)]!;
  // Lines near a frame's shape and in it: its spaces, `at`, a name of any characters but a line feed (surrogates, lone
  // halves, carriage returns and line separators among them, and a place of its own), a place whose line has up to
  // eleven digits, and what may close it or follow it.
  const space = [' ', '    ', '\t', '\u00a0', '\u2028', '', '  \r'];
  const name = ['f', '', '<anonymous>', 'a\rb', 'c\u2028d', '\u{1F600}', '\ud800', 'x <input>:9:9', 'at', ' '];
  const digitsOf = (n: number) => Array.from({ length: n }, () => String(next(10))).join('');
  const line = (): string => {
    const lead = pick(space) + pick(space);
    const head = pick(['at ', 'at\t', 'at\u00a0', 'at\u2028', 'at', 'At ', '']);
    const place = `<input>:${digitsOf(1 + next(11))}:${digitsOf(next(3))}`;
    const open = pick(['(', '']);
    const close = open ? pick([')', '', ') and more']) : pick(['', ')']);
    return lead + head + pick(name) + (open ? ` ${open}` : ' ') + place + close;
  };
  for (let round = 0; round < 400; round++) {
    const lines = Array.from({ length: next(25) }, () => (next(6) === 0 ? pick(['', 'not a frame', '\r']) : line()));
    const stack = lines.join('\n') + pick(['', '\n']);
    const max = next(5) === 0 ? Infinity : next(200);
    const expected = rule(stack);
    assert.equal(scriptFrames(stack), expected, JSON.stringify(stack));
    assert.equal(scriptFrames(stack, max), max === Infinity ? expected : bounded(expected, max), JSON.stringify({ stack, max }));
  }
  // A text exactly the cut's length is kept whole, and one character more is cut.
  const one = scriptFrames('    at f (<input>:3:1)');
  assert.equal(scriptFrames('    at f (<input>:3:1)', one.length), one);
  assert.match(scriptFrames('    at f (<input>:3:1)', one.length - 1), /characters dropped here/);
  // A line of eleven digits is no line of QuickJS's, so its frame isn't one.
  assert.equal(scriptFrames('    at f (<input>:12345678901:1)\n    at g (<input>:1234567890:1)'), '    at g (script:1234567888:1)');
});
