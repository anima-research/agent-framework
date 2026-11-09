/**
 * The isolate's runner with real child processes, on the stand-in engine: the call
 * record, the yield, each ending, a child that breaks the protocol, and the
 * host's child capacity. The child runs on this test's own runtime.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildCapacity, MAX_CALLS_IN_FLIGHT, ScriptRun, type CallAnswer, type ScriptRunOptions } from '../src/code-execution/isolate/runner.js';
import { MAX_CHILD_FRAME_BYTES } from '../src/code-execution/isolate/protocol.js';
import { CUT_MARK_CHARS, NAME_CHARS, VALUE_CHARS } from '../src/code-execution/isolate/render.js';

// With this file's own extension, as the runner names its entry, so the runtime runs a file that exists.
const EXT = extname(fileURLToPath(import.meta.url));
const FAKE_CHILD = fileURLToPath(new URL(`./helpers/fake-child-entry${EXT}`, import.meta.url));
const BAD_CHILD = fileURLToPath(new URL(`./helpers/bad-child-entry${EXT}`, import.meta.url));

const TOOLS = [{ name: 'echo', description: 'Echoes.' }, { name: 'slow', description: 'Answers when told.' }];

const result = (text: string, isError = false): CallAnswer & { isError: boolean } => ({
  ok: true,
  json: JSON.stringify({ content: [{ type: 'text', text }], structuredContent: null, isError }),
  isError,
});

const LONGER_THAN_ANY_START_MS = 60_000;
const NEVER_FIRES_IN_A_TEST_MS = 2 * LONGER_THAN_ANY_START_MS;

function run(over: Partial<ScriptRunOptions> = {}): ScriptRun {
  return new ScriptRun({
    childEntry: FAKE_CHILD,
    memoryMaxBytes: 64 * 1024 * 1024,
    output: { headChars: 1000, tailChars: 1000 },
    flushMs: 20,
    lifetimeMs: NEVER_FIRES_IN_A_TEST_MS,
    toolCallTimeoutMs: NEVER_FIRES_IN_A_TEST_MS,
    stopGraceMs: 2_000,
    wakeMinIntervalMs: 0,
    maxWakes: 100,
    onToolCall: async (name, args) => result(`${name} ${args}`),
    onWake: async () => ({ ok: true, json: 'null' }),
    ...over,
  });
}

test('a script that calls tools finishes with its value, its output, and each call answered', async () => {
  const r = run();
  r.start(`const a = await tools.echo({ n: 1 }); text(a.content[0].text); return 'done';`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '"done"' });
  assert.equal(snap.output, 'echo {"n":1}\n');
  assert.deepEqual(snap.calls, { made: 1, answered: 1, failed: 0, refused: 0, unsent: 0, running: 0, waiting: 0, named: [], more: {} });
  await r.exited;
});

/** Wait for a condition, failing after a bound no child's start reaches rather than hanging the run. */
const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + LONGER_THAN_ANY_START_MS;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('past its bound a run yields its output so far and keeps running, and a later wait gets its end', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let called = false;
  const r = run({ onToolCall: async (name, args) => { if (name === 'slow') { called = true; await gate; } return result(`${name} ${args}`); } });
  r.start(`text('before'); await tools.slow({}); text('after'); return 1;`, TOOLS);
  // The child goes idle on its call, flushing what the guest wrote first.
  await until(() => called && r.snapshot().output === 'before\n', 'the call and the output before it');
  const first = await r.wait(0);
  assert.equal(first.ending, null);
  assert.equal(first.output, 'before\n');
  assert.deepEqual(first.calls, { made: 1, answered: 0, failed: 0, refused: 0, unsent: 0, running: 1, waiting: 0, named: [], more: {} });
  release();
  const second = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(second.ending, { how: 'finished', value: '1' });
  assert.equal(second.output, 'before\nafter\n');
  await r.exited;
});

test("the agent's stop ends an idle run as stopped, and the call it was waiting on is uncertain", async () => {
  let called = false;
  const r = run({ onToolCall: () => { called = true; return new Promise(() => {}); } });
  r.start(`await tools.slow({});`, TOOLS);
  // The stop comes once the call is out, however slow the child was to start: one asked earlier refuses it.
  await until(() => called, 'the call');
  const snap = await r.stop('agent');
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'agent' });
  assert.deepEqual(snap.calls, { made: 1, answered: 0, failed: 0, refused: 0, unsent: 0, running: 0, waiting: 0, named: [{ tool: 'slow', args: '{}', state: 'uncertain' }], more: {} });
  await r.exited;
});

test('a computing run is stopped through the stop file, with its output so far', async () => {
  const r = run();
  r.start(`text('spinning'); for (;;) __tick();`, TOOLS);
  // The guest's output is flushed from its interrupt checks while it computes.
  await until(() => r.snapshot().output === 'spinning\n', 'the output while it computes');
  const snap = await r.stop('limit');
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'limit' });
  assert.equal(snap.output, 'spinning\n');
  await r.exited;
});

test('a run still going at its limit is stopped there', async () => {
  const r = run({ lifetimeMs: 300, stopGraceMs: LONGER_THAN_ANY_START_MS });
  r.start(`for (;;) __tick();`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'limit' });
  await r.exited;
});

test("a guest that never reaches the interrupt is ended after the stop's grace, and its ending says so", async () => {
  const r = run({ lifetimeMs: 200, stopGraceMs: 20 });
  r.start(`text('stuck'); for (;;) {}`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'stopped');
  assert.equal((snap.ending as { short?: boolean }).short, true);
  await r.exited;
});

test('a refusal and a failed result are recorded as such, and the script sees each', async () => {
  const r = run({
    onToolCall: async (name) => name === 'echo'
      ? { ok: false, json: JSON.stringify({ name: 'ToolRefused', message: 'echo is not yours now; nothing was sent' }) }
      : result('it broke', true),
  });
  r.start(`let refused; try { await tools.echo({}); } catch (e) { refused = e.message; } const f = await tools.slow({}); return [refused, f.isError];`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["echo is not yours now; nothing was sent",true]' });
  assert.deepEqual([snap.calls.refused, snap.calls.failed], [1, 1]);
  await r.exited;
});

test('a call with no answer within its timeout rejects in the script, and is recorded as timed out', async () => {
  const r = run({ toolCallTimeoutMs: 20, onToolCall: () => new Promise(() => {}) });
  r.start(`try { await tools.slow({}); } catch (e) { return [e.name, /may still take effect/.test(e.message)]; }`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["TimeoutError",true]' });
  assert.deepEqual(snap.calls, { made: 1, answered: 0, failed: 0, refused: 0, unsent: 0, running: 0, waiting: 0, named: [{ tool: 'slow', args: '{}', state: 'timed-out' }], more: {} });
  await r.exited;
});

for (const how of ['garbage', 'not-a-message', 'result-kind', 'empty'] as const) {
  test(`a child that breaks the protocol (${how}) ends its run as crashed`, async () => {
    const r = run({ childEntry: BAD_CHILD, childArgs: [how] });
    r.start('return 1;', TOOLS);
    const snap = await r.wait(LONGER_THAN_ANY_START_MS);
    assert.equal(snap.ending?.how, 'crashed');
    assert.match((snap.ending as { detail: string }).detail, /sent the host a message it couldn't read/);
    await r.exited;
  });
}

test("a stop's reason is the one the parent asked, whatever the child says", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['stopped-as-agent'], stopGraceMs: LONGER_THAN_ANY_START_MS });
  r.start('return 1;', TOOLS);
  const snap = await r.stop('limit', 'it reached its limit');
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'limit', why: 'it reached its limit' });
  await r.exited;
});

test('a child that says the script stopped when no stop was asked crashes its run', async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['stopped-unasked'] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /no stop was asked/);
  await r.exited;
});

test("a run whose process exited before its ending came holds no child once it ends", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['late-end'], stopGraceMs: LONGER_THAN_ANY_START_MS });
  r.start('return 1;', TOOLS);
  await r.exited;
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '"late"' });
  assert.equal((r as unknown as { child: unknown }).child, null);
});

test("a child whose fd 3 stays open after its process exits crashes its run once the stop's grace has passed", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['held-fd3'], stopGraceMs: 20 });
  r.start('return 1;', TOOLS);
  const exited = await Promise.race([r.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), LONGER_THAN_ANY_START_MS).unref())]);
  assert.equal(exited, true, 'its process exited');
  const snap = await r.wait(5_000);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /exited with code 0 before the script ended/);
  await r.exited;
});

test("arguments past a call's bytes or values are refused in the child, nothing sent, and a large file's text still fits", async () => {
  const calls: number[] = [];
  const r = run({ onToolCall: async (_name, args) => { calls.push(args.length); return result('ok'); } });
  r.start(
    `const out = [];
     // 3 MiB of quotes: 6 MiB of JSON once escaped, past the 4 MiB a call takes.
     try { await tools.echo({ s: '"'.repeat(3 * 1024 * 1024) }); } catch (e) { out.push(e.name, /nothing was sent/.test(e.message)); }
     try { await tools.echo({ a: Array.from({ length: 100001 }, () => 0) }); } catch (e) { out.push(e.name, /100,000 values/.test(e.message)); }
     await tools.echo({ content: 'x'.repeat(4 * 1024 * 1024 - 100) });
     return out;`,
    TOOLS,
  );
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["ArgumentsTooLarge",true,"ArgumentsTooLarge",true]' });
  assert.equal(calls.length, 1, 'only the file-sized call went out');
  assert.equal(snap.calls.made, 1);
  await r.exited;
});

test('results reach a computing child one frame at a time, the rest held as the results they are', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024);
  let answered = 0;
  const r = run({ onToolCall: async () => { answered += 1; return result(big); } });
  const internals = r as unknown as { child: { stdin: { writableLength: number } } | null; resultQueue: unknown[] };
  const gateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
  const gate = join(gateDir, 'go');
  // Four calls go out, and the guest computes, reading no answer, until the test makes the gate.
  r.start(`const ps = [1, 2, 3, 4].map(() => tools.echo({})); while (!__exists(${JSON.stringify(gate)})) __tick(); return (await Promise.all(ps)).map((x) => x.content[0].text.length);`, TOOLS);
  // All four answered: a frame went to the pipe, and the others wait as results until it drains.
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && (answered < 4 || internals.resultQueue.length < 2);) await new Promise((res) => setTimeout(res, 10));
  assert.equal(answered, 4);
  assert.ok(internals.resultQueue.length >= 2, `${internals.resultQueue.length} results waited while a frame was in the pipe`);
  // At most one frame in the pipe's buffer (Node's writableLength; Bun reads 0).
  assert.ok((internals.child?.stdin.writableLength ?? 0) <= big.length + 1024, `the pipe held ${internals.child?.stdin.writableLength} bytes`);
  writeFileSync(gate, '');
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: JSON.stringify([big.length, big.length, big.length, big.length]) });
  await r.exited;
  rmSync(gateDir, { recursive: true, force: true });
});

test('a run that ends with results waiting for the child drops them', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024);
  const r = run({ onToolCall: async () => result(big) });
  const internals = r as unknown as { resultQueue: unknown[] };
  r.start(`const ps = [1, 2, 3, 4].map(() => tools.echo({})); for (;;) __tick();`, TOOLS);
  await until(() => internals.resultQueue.length >= 2, 'results waiting for the child');
  const snap = await r.stop('agent');
  assert.equal(snap.ending?.how, 'stopped');
  assert.equal(internals.resultQueue.length, 0);
  await r.exited;
});

test(`at most ${MAX_CALLS_IN_FLIGHT} calls are in flight at once, and one past it waits for a place, never refused`, async () => {
  let inFlight = 0;
  let most = 0;
  // The first calls are held until as many as may be out at once have come,
  // so the most at once is the bound itself, however the child is scheduled.
  const first: Array<() => void> = [];
  let filled = false;
  const r = run({
    onToolCall: async () => {
      most = Math.max(most, ++inFlight);
      if (!filled) {
        await new Promise<void>((resolve) => {
          first.push(resolve);
          if (first.length === MAX_CALLS_IN_FLIGHT) {
            filled = true;
            for (const go of first.splice(0)) go();
          }
        });
      }
      inFlight -= 1;
      return result('ok');
    },
  });
  r.start(`return (await Promise.all(Array.from({ length: 40 }, () => tools.echo({})))).length;`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '40' });
  assert.equal(most, MAX_CALLS_IN_FLIGHT);
  assert.equal(snap.calls.answered, 40);
  await r.exited;
});

/** A bridge that holds each call until the test lets it answer, counting how many it holds at once. */
function holdingBridge() {
  const held: Array<() => void> = [];
  const bridge = { held, inBridge: 0, most: 0, calls: 0 };
  const onToolCall = async (name: string, args: string): Promise<CallAnswer> => {
    bridge.calls += 1;
    bridge.most = Math.max(bridge.most, ++bridge.inBridge);
    if (JSON.parse(args).hold) await new Promise<void>((resolve) => held.push(resolve));
    bridge.inBridge -= 1;
    return result(`${name} ${args}`);
  };
  return { bridge, onToolCall };
}

// Each of the first 16 times out in the script while the bridge still holds it.
const SIXTEEN_TIME_OUT = `const names = await Promise.all(Array.from({ length: ${MAX_CALLS_IN_FLIGHT} }, (_, i) => tools.slow({ hold: true, i }).then(() => 'answered', (e) => e.name)));`;

test(`the host holds at most ${MAX_CALLS_IN_FLIGHT} calls, timed-out ones included: one past them waits, and goes out once one ends`, async () => {
  const { bridge, onToolCall } = holdingBridge();
  const r = run({ toolCallTimeoutMs: 1_500, onToolCall });
  r.start(`${SIXTEEN_TIME_OUT} const late = await tools.echo({ late: true }); return [names.every((n) => n === 'TimeoutError'), late.content[0].text];`, TOOLS);
  // All sixteen timed out in the script, so its places are free, and the next call waits for the host.
  await until(() => r.snapshot().calls.waiting === 1, 'the next call to wait for room in the host');
  assert.equal(bridge.inBridge, MAX_CALLS_IN_FLIGHT);
  bridge.held.shift()!();
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '[true,"echo {\\"late\\":true}"]' });
  assert.equal(bridge.most, MAX_CALLS_IN_FLIGHT);
  assert.equal(bridge.calls, MAX_CALLS_IN_FLIGHT + 1);
  while (bridge.held.length) bridge.held.shift()!();
  await r.exited;
});

test('a call that waits for room in the host past its timeout is told it was never sent, and the record counts it so', async () => {
  const { bridge, onToolCall } = holdingBridge();
  const r = run({ toolCallTimeoutMs: 50, onToolCall });
  r.start(`${SIXTEEN_TIME_OUT} try { await tools.echo({ late: true }); return 'sent'; } catch (e) { return [e.name, e.message]; }`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'finished');
  const [name, message] = JSON.parse((snap.ending as { value: string }).value) as [string, string];
  assert.equal(name, 'TimeoutError');
  assert.match(message, /^echo was never sent: 16 of this script's earlier calls were still running in the host, timed-out ones included, and its turn didn't come within 50 ms, so nothing was done; calling it again may go through once one of them gets its result, though a call whose tool the host stopped waiting for stays counted until this script ends, and a new script starts with none$/);
  assert.equal(bridge.calls, MAX_CALLS_IN_FLIGHT, 'the late call never reached the bridge');
  assert.equal(snap.calls.made, MAX_CALLS_IN_FLIGHT + 1);
  assert.equal(snap.calls.unsent, 1);
  assert.equal(snap.calls.refused, 0, 'a call that waited for room was not refused');
  while (bridge.held.length) bridge.held.shift()!();
  await r.exited;
});

test('a call waiting for room in the host when its script is stopped is never sent', async () => {
  const { bridge, onToolCall } = holdingBridge();
  const r = run({ toolCallTimeoutMs: 1_000, onToolCall });
  r.start(`${SIXTEEN_TIME_OUT} await tools.echo({ late: true });`, TOOLS);
  await until(() => r.snapshot().calls.waiting === 1, 'the next call to wait for room in the host');
  const snap = await r.stop('agent');
  assert.equal(snap.calls.waiting, 0);
  // The script made it, and nothing was done: the record says so.
  assert.equal(snap.calls.made, MAX_CALLS_IN_FLIGHT + 1);
  assert.equal(snap.calls.unsent, 1);
  while (bridge.held.length) bridge.held.shift()!();
  await new Promise((res) => setImmediate(res));
  assert.equal(bridge.calls, MAX_CALLS_IN_FLIGHT, 'the waiting call never reached the bridge');
  await r.exited;
});

test('a call waiting for room in the host when a stop is asked is refused once a place frees, and never sent', async () => {
  const { bridge, onToolCall } = holdingBridge();
  const r = run({ toolCallTimeoutMs: 1_000, onToolCall });
  r.start(`${SIXTEEN_TIME_OUT} await tools.echo({ late: true });`, TOOLS);
  await until(() => r.snapshot().calls.waiting === 1, 'the next call to wait for room in the host');
  const stopped = r.stop('agent');
  // A place frees after the stop was asked, before the script has ended.
  bridge.held.shift()!();
  const snap = await stopped;
  assert.equal(bridge.calls, MAX_CALLS_IN_FLIGHT, 'the waiting call never reached the bridge');
  assert.equal(snap.calls.refused, 1);
  while (bridge.held.length) bridge.held.shift()!();
  await r.exited;
});

test('wake_agent() takes no place among the calls in flight', async () => {
  let held = 0;
  let woke = false;
  const r = run({
    onToolCall: async () => { held += 1; return new Promise<never>(() => {}); },
    onWake: async () => { woke = true; return { ok: true, json: 'null' }; },
  });
  // Every place is held by a call that never answers, and the wake still goes through.
  r.start(`const ps = Array.from({ length: ${MAX_CALLS_IN_FLIGHT} }, () => tools.slow({})); await wake_agent({ n: 1 }); await Promise.all(ps);`, TOOLS);
  await until(() => woke, 'the wake');
  assert.equal(held, MAX_CALLS_IN_FLIGHT);
  await r.stop('agent');
  await r.exited;
});

test('a call waiting in the script for a place when its script is stopped is never sent', async () => {
  let dispatched = 0;
  const r = run({ onToolCall: async () => { dispatched += 1; return new Promise<never>(() => {}); } });
  r.start(`await Promise.all(Array.from({ length: ${MAX_CALLS_IN_FLIGHT + 4} }, () => tools.slow({})));`, TOOLS);
  const deadline = Date.now() + LONGER_THAN_ANY_START_MS;
  while (dispatched < MAX_CALLS_IN_FLIGHT && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const snap = await r.stop('agent');
  assert.equal(dispatched, MAX_CALLS_IN_FLIGHT);
  assert.equal(snap.calls.made, MAX_CALLS_IN_FLIGHT);
  assert.equal(snap.calls.named.length + Object.values(snap.calls.more).reduce((a, b) => a + b, 0), MAX_CALLS_IN_FLIGHT, 'each sent call is uncertain');
  await r.exited;
});

test('a child that exits without saying how the script ended crashes the run, with its stderr', async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['silent-exit'] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /exited with code 3 .*something to say on its way out/s);
  await r.exited;
});

test("the host's capacity counts children until each exits", () => {
  const capacity = new ChildCapacity(2);
  assert.equal(capacity.take(), true);
  assert.equal(capacity.take(), true);
  assert.equal(capacity.take(), false);
  capacity.release();
  assert.equal(capacity.running, 1);
  assert.equal(capacity.take(), true);
});

test('a result too large for the script is refused before it is sent, naming its size, and recorded as too large', async () => {
  // A third of 3 MiB is 1 MiB: a result of 2 MiB can't be held.
  const r = run({ memoryMaxBytes: 3 * 1024 * 1024, onToolCall: async () => result('x'.repeat(2 * 1024 * 1024)) });
  r.start(`try { await tools.echo({}); } catch (e) { return [e.name, e.bytes > 2000000, /took effect/.test(e.message)]; }`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["ResultTooLarge",true,true]' });
  assert.deepEqual(snap.calls, { made: 1, answered: 0, failed: 0, refused: 0, unsent: 0, running: 0, waiting: 0, named: [{ tool: 'echo', args: '{}', state: 'too-large' }], more: {} });
  await r.exited;
});

test('a child whose runtime cannot start crashes its run, and its place is freed', async () => {
  const r = run({ execPath: '/nonexistent/runtime-for-a-test' });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /^its process could not run: /);
  await r.exited;
});

test(`a child that sends more than ${MAX_CALLS_IN_FLIGHT} calls at once crashes its run, saying why`, async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['seventeen-calls'], onToolCall: () => new Promise(() => {}) });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, new RegExp(`more than ${MAX_CALLS_IN_FLIGHT} calls at once`));
  await r.exited;
});

for (const [how, detail] of [
  ['undeclared-call', /a call to "nope", which isn't one of the script's tools/],
  ['reused-id', /call 1 was named twice/],
  ['unanswered-seen', /had the answer to call 5, which the host never sent/],
  ['seen-pending', /had the answer to call 1, which the host never sent/],
  ['wakes-past-cap', /more than 2 wakes/],
  ['cut-frame', /the stream ended inside a frame/],
  ['huge-out', new RegExp(`characters of output in one frame, past the 65,536 it sends at most`)],
  ['many-values-frame', /a frame held more than 32 values/],
  ['args-past-caps', /a call to echo whose arguments pass their caps of 4 MiB and 100,000 values, which the script refuses itself/],
  ['wake-past-payload', /a wake of 65,539 bytes, past the 64 KiB the script refuses itself/],
] as const) {
  test(`a child that breaks the protocol (${how}) crashes its run, saying how`, async () => {
    const r = run({ childEntry: BAD_CHILD, childArgs: [how], maxWakes: 2, onToolCall: () => new Promise(() => {}) });
    r.start('return 1;', TOOLS);
    const snap = await r.wait(LONGER_THAN_ANY_START_MS);
    assert.equal(snap.ending?.how, 'crashed', JSON.stringify(snap.ending));
    assert.match((snap.ending as { detail: string }).detail, detail);
    await r.exited;
  });
}

test("a failure's name, message and stack from a child are cut in the parent, whatever length the child sends", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['long-failure'] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'failed', JSON.stringify(snap.ending).slice(0, 200));
  const { error } = snap.ending as { error: { name: string; message: string; stack?: string } };
  for (const [part, text, max] of [['name', error.name, NAME_CHARS], ['message', error.message, VALUE_CHARS], ['stack', error.stack ?? '', VALUE_CHARS]] as const) {
    assert.match(text, /characters dropped here/, `the ${part} was cut`);
    assert.ok(text.length < max + 2 * CUT_MARK_CHARS, `the ${part} is ${text.length} characters`);
  }
  await r.exited;
});

test('a wake still waiting for its spacing when its run crashes is never sent, and the ending lets it go', async () => {
  let wakes = 0;
  const r = run({ wakeMinIntervalMs: NEVER_FIRES_IN_A_TEST_MS, onWake: async () => (wakes += 1, { ok: true, json: 'null' }) });
  const internals = r as unknown as { child: { kill(signal: string): boolean }; wakeWaiters: Set<unknown> };
  r.start(`await wake_agent(1); await wake_agent(2);`, TOOLS);
  await until(() => wakes === 1 && internals.wakeWaiters.size === 1, 'the second wake to wait for its spacing');
  // Its process dies, as one killed from outside would.
  internals.child.kill('SIGKILL');
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.equal(internals.wakeWaiters.size, 0, 'the ending let the waiting wake go');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wakes, 1, 'the waiting wake was never sent');
  await r.exited;
});

test("a child that says how its script ended and doesn't exit is ended after the stop's grace", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['finished-then-hold'], stopGraceMs: 20 });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '1' });
  const exited = await Promise.race([r.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), LONGER_THAN_ANY_START_MS).unref())]);
  assert.equal(exited, true, 'its process was ended');
});

test("a crash's detail has the stderr that comes after its process exits", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['late-stderr'], stopGraceMs: LONGER_THAN_ANY_START_MS });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /words that came late/);
  await r.exited;
});

test("the child gets nothing of the host's environment, with a .env file where the host runs", async () => {
  // Bun reads a .env file from the directory a process starts in: the child starts in its own.
  const hostDir = mkdtempSync(join(tmpdir(), 'af-host-'));
  writeFileSync(join(hostDir, '.env'), 'FROM_THE_HOSTS_DOTENV=1\n');
  const was = process.cwd();
  process.chdir(hostDir);
  try {
    const r = run({ childEntry: BAD_CHILD, childArgs: ['env'] });
    r.start('return 1;', TOOLS);
    const snap = await r.wait(LONGER_THAN_ANY_START_MS);
    assert.equal(snap.ending?.how, 'crashed');
    const detail = (snap.ending as { detail: string }).detail;
    const names = /exited with code 3 before the script ended: (\[.*\])$/.exec(detail);
    assert.ok(names, detail);
    // On macOS a Node child that was given no environment still has
    // __CF_USER_TEXT_ENCODING, which, by our reading, the system sets in the
    // child itself (CI's macOS jobs show the child with it, and Bun's child
    // there without it), so that one name is allowed there.
    const own = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];
    assert.deepEqual((JSON.parse(names[1]!) as string[]).filter((name) => !own.includes(name)), []);
    await r.exited;
  } finally {
    process.chdir(was);
    rmSync(hostDir, { recursive: true, force: true });
  }
});

test('a call that comes after a stop was asked is not dispatched', async () => {
  let dispatched = 0;
  const r = run({ childEntry: BAD_CHILD, childArgs: ['call-after-stop'], stopGraceMs: LONGER_THAN_ANY_START_MS, onToolCall: async () => { dispatched += 1; return result('ok'); } });
  r.start('return 1;', TOOLS);
  const snap = await r.stop('agent');
  assert.equal(snap.ending?.how, 'stopped');
  assert.equal(dispatched, 0);
  // It reached the parent, which refused it, and the record counts the refusal, unseen at the ending.
  assert.equal(snap.calls.refused, 1);
  assert.deepEqual(snap.calls.named, []);
  await r.exited;
});

test('at a stop, an answer the script never read is named in the record', async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['no-seen-then-stop'] });
  const internals = r as unknown as { delivered: Map<number, unknown> };
  r.start('return 1;', TOOLS);
  await until(() => internals.delivered.size === 1, 'the answer sent');
  const snap = await r.stop('agent');
  assert.deepEqual(snap.calls.named, [{ tool: 'echo', args: '{}', state: 'unseen' }]);
  await r.exited;
});

test('a bridge that rejects answers the call as a failure that may have taken effect', async () => {
  const r = run({ onToolCall: async () => { throw new Error('the dispatcher fell over'); } });
  r.start(`const r = await tools.echo({}); return [r.isError, r.content[0].text];`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'finished');
  const [isError, text] = JSON.parse((snap.ending as { value: string }).value) as [boolean, string];
  assert.equal(isError, true);
  assert.match(text, /echo failed in the host: the dispatcher fell over; it may have taken effect/);
  await r.exited;
});

test('a too-large answer waiting to be seen keeps only its brief', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const answerChars = 2 * 1024 * 1024;
  const r = run({ memoryMaxBytes: 3 * 1024 * 1024, onToolCall: async () => { await hold; return result('y'.repeat(answerChars)); } });
  const internals = r as unknown as { delivered: Map<number, { brief: string }> };
  const gateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
  const gate = join(gateDir, 'go');
  // The guest computes until the gate opens, so the answer stays sent and unseen meanwhile.
  r.start(`const p = tools.echo({}); while (!__exists(${JSON.stringify(gate)})) __tick(); try { await p; } catch (e) { return e.name; }`, TOOLS);
  release();
  await until(() => internals.delivered.size === 1, 'the answer sent and not yet seen');
  assert.ok([...internals.delivered.values()][0]!.brief.length <= answerChars / 1024, 'only its start is kept, not the answer whole');
  writeFileSync(gate, '');
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  rmSync(gateDir, { recursive: true, force: true });
  assert.deepEqual(snap.ending, { how: 'finished', value: '"ResultTooLarge"' });
  await r.exited;
});

test('an ended run holds no call ids, places or answers', async () => {
  const r = run({ onToolCall: () => new Promise(() => {}) });
  const internals = r as unknown as { pendingIds: Set<number>; answeredIds: Set<number>; inFlight: Set<number> };
  r.start(`await Promise.all([tools.slow({}), tools.slow({})]);`, TOOLS);
  await until(() => internals.inFlight.size === 2, 'two calls in flight');
  await r.stop('agent');
  assert.deepEqual([internals.pendingIds.size, internals.answeredIds.size, internals.inFlight.size], [0, 0, 0]);
  await r.exited;
});

test('an answered call the script never saw is cleared when its run ends', async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['no-seen-then-stop'] });
  const internals = r as unknown as { answeredIds: Set<number> };
  r.start('return 1;', TOOLS);
  await until(() => internals.answeredIds.size === 1, 'the answer written');
  await r.stop('agent');
  assert.equal(internals.answeredIds.size, 0);
  await r.exited;
});

test("a child's cut of a long value, and the count it gives, pass the parent's bound as they are", async () => {
  const r = run();
  r.start(`return 'v'.repeat(20000);`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'finished');
  // Its JSON is 20,002 characters, of which the child keeps 8,000.
  assert.match((snap.ending as { value: string }).value, /\[… 12002 characters dropped here …\]/);
});

test("a seen for an answer the parent hasn't written yet crashes the run", async () => {
  const gateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
  const gate = join(gateDir, 'go');
  const r = run({ childEntry: BAD_CHILD, childArgs: ['seen-queued', gate], onToolCall: async () => result('z'.repeat(2 * 1024 * 1024)) });
  const internals = r as unknown as { resultQueue: unknown[] };
  r.start('return 1;', TOOLS);
  // The child reads none of its answers, so the second waits in the parent's queue.
  await until(() => internals.resultQueue.length === 1, 'the second answer queued');
  writeFileSync(gate, '');
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /had the answer to call 2, which the host never sent/);
  rmSync(gateDir, { recursive: true, force: true });
  await r.exited;
});

test('an id named again after its answer came and before it was seen crashes the run', async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['reuse-after-answer'] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /call 1 was named twice/);
  await r.exited;
});

test("a frame cut off by the stop's own kill ends the run as stopped, not as a broken protocol", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['half-frame-on-stop'], stopGraceMs: 2_000 });
  r.start('return 1;', TOOLS);
  // Its listener is on once it has said so, so the stop reaches it and it writes half a frame.
  await until(() => r.snapshot().output.includes('ready'), 'the child to be ready');
  const snap = await r.stop('agent');
  // It took the stop and wrote its half frame before the grace's kill.
  assert.match(snap.output, /cutting/);
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'agent', short: true });
  await r.exited;
});

test("the run's end lets go a wake waiting behind another's delivery", async () => {
  const r = run({ onWake: () => new Promise(() => {}) });
  const internals = r as unknown as { wakeChain: Promise<void> };
  r.start(`wake_agent(1); wake_agent(2); await new Promise(() => {});`, TOOLS);
  // Waiting behind the first's delivery, the second is among the calls waiting.
  await until(() => r.snapshot().calls.made === 2 && r.snapshot().calls.waiting === 1, 'two wakes, the second waiting behind the first');
  const snap = await r.stop('agent');
  // The chain settles once the second wake has gone or won't, so it settles only if the end let it go.
  const settled = await Promise.race([internals.wakeChain.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), LONGER_THAN_ANY_START_MS).unref())]);
  assert.equal(settled, true);
  // The second never went out, and the record counts it so.
  assert.equal(snap.calls.made, 2);
  assert.equal(snap.calls.unsent, 1);
  await r.exited;
});

test('only the wakes the host delivered count as delivered: one it refused does not', async () => {
  const r = run({
    onWake: async (payload) => (JSON.parse(payload) === 1
      ? { ok: true, json: 'null' }
      : { ok: false, json: JSON.stringify({ name: 'WakeRefused', message: "the wake couldn't be delivered" }) }),
  });
  r.start(`await wake_agent(1); try { await wake_agent(2); } catch (e) { return e.name; }`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '"WakeRefused"' });
  assert.equal(r.wakesDelivered, 1);
  await r.exited;
  // Nor does one whose delivery failed in the host, answered as a failure that may have taken effect.
  const failing = run({ onWake: async () => { throw new Error('the wake handler broke'); } });
  failing.start(`try { await wake_agent(1); } catch (e) { return e.name; }`, TOOLS);
  const failed = await failing.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(failed.ending?.how, 'finished', JSON.stringify(failed.ending));
  assert.equal(failing.wakesDelivered, 0);
  await failing.exited;
});

test("a wake's spacing counts from when the wake before it was delivered", async () => {
  const delivered: Array<{ n: number; start: number; end: number }> = [];
  const r = run({
    wakeMinIntervalMs: 50,
    onWake: async (_payload, n) => {
      const start = performance.now();
      // The first delivery takes longer than the spacing.
      if (n === 1) await new Promise((resolve) => setTimeout(resolve, 100));
      delivered.push({ n, start, end: performance.now() });
      return { ok: true, json: 'null' };
    },
  });
  r.start(`await Promise.all([wake_agent(1), wake_agent(2)]); return 'done';`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '"done"' });
  const [first, second] = delivered;
  assert.ok(second!.start - first!.end >= 40, `the second came ${Math.round(second!.start - first!.end)} ms after the first's delivery`);
  await r.exited;
});

test('with a relative TMPDIR, a computing script still sees its stop file', async () => {
  const relative = `af-reltmp-${process.pid}-${Date.now()}`;
  mkdirSync(relative);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = relative;
  try {
    const r = run();
    r.start(`text('spinning'); for (;;) __tick();`, TOOLS);
    await until(() => r.snapshot().output === 'spinning\n', 'the output while it computes');
    const snap = await r.stop('agent');
    // Stopped by the stop file, not ended by the grace's kill.
    assert.deepEqual(snap.ending, { how: 'stopped', reason: 'agent' });
    await r.exited;
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    rmSync(relative, { recursive: true, force: true });
  }
});

test("a stop asked after the process exited isn't its ending's cause", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['exit-holding-fd3'], stopGraceMs: 20 });
  r.start('return 1;', TOOLS);
  await r.exited;
  assert.equal(r.snapshot().ending, null, 'fd 3 is still held open');
  const stopped = r.stop('agent');
  // The process had gone before the stop was asked: the stop isn't its ending's cause.
  const ending = (await stopped).ending;
  assert.equal(ending?.how, 'crashed');
  assert.match((ending as { detail: string }).detail, /exited with code 0 before the script ended/);
});

for (const [how, why] of [['wakes-then-ignore-stop', 'once a stop was asked'], ['wake-then-exit-on-gate', 'once its process exited']] as const) {
  test(`a wake whose turn comes ${why} is never sent, and the record counts it so`, async () => {
    const sent: number[] = [];
    const gateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
    const gate = join(gateDir, 'go');
    const fd3Gate = join(gateDir, 'let-fd3-go');
    const r = run({
      childEntry: BAD_CHILD,
      childArgs: how === 'wake-then-exit-on-gate' ? [how, gate, fd3Gate] : [how],
      // The turn comes when the test lets it, once the stop is asked or the
      // exit has landed: after its exit, fd 3 stays held until the test
      // writes the second gate file, and the run waits for fd 3 to end.
      wakeMinIntervalMs: NEVER_FIRES_IN_A_TEST_MS,
      stopGraceMs: how === 'wake-then-exit-on-gate' ? LONGER_THAN_ANY_START_MS : 20,
      onWake: async (_payload, n) => { sent.push(n); return { ok: true, json: 'null' }; },
    });
    const internals = r as unknown as { wakeWaiters: Set<() => void> };
    r.start('return 1;', TOOLS);
    // The second wake is waiting out its spacing before the stop, or the exit, comes.
    await until(() => sent.length === 1 && internals.wakeWaiters.size === 1, 'the second wake waiting for its turn');
    if (how === 'wakes-then-ignore-stop') void r.stop('agent');
    else {
      writeFileSync(gate, '');
      await r.exited;
    }
    // Its turn comes now, while the run hasn't yet ended.
    assert.equal(r.snapshot().ending, null, 'the run had not ended when the turn came');
    for (const release of [...internals.wakeWaiters]) release();
    await new Promise((res) => setImmediate(res));
    assert.equal(r.snapshot().ending, null, 'the run had not ended when the turn passed');
    if (how === 'wake-then-exit-on-gate') writeFileSync(fd3Gate, '');
    const snap = await r.wait(LONGER_THAN_ANY_START_MS);
    assert.deepEqual(sent, [1]);
    assert.equal(snap.calls.made, 2);
    assert.equal(snap.calls.unsent, 1);
    // Only the wake that went out is among the script's wakes delivered.
    assert.equal(r.wakesDelivered, 1);
    assert.equal(snap.ending?.how, how === 'wakes-then-ignore-stop' ? 'stopped' : 'crashed');
    rmSync(gateDir, { recursive: true, force: true });
    await r.exited;
  });
}

test('a wake waiting for its turn when its run crashes is never sent, and the record counts it so', async () => {
  const sent: number[] = [];
  const gateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
  const gate = join(gateDir, 'go');
  const r = run({
    childEntry: BAD_CHILD,
    childArgs: ['wakes-then-garbage-on-gate', gate],
    // Its turn never comes within the test: only the run's end lets it go.
    wakeMinIntervalMs: NEVER_FIRES_IN_A_TEST_MS,
    onWake: async (_payload, n) => { sent.push(n); return { ok: true, json: 'null' }; },
  });
  const internals = r as unknown as { wakeWaiters: Set<unknown>; processExited: boolean };
  r.start('return 1;', TOOLS);
  await until(() => sent.length === 1 && internals.wakeWaiters.size === 1, 'the second wake waiting for its turn');
  // The crash ends the run while the wake waits, the child still alive: the end lets the wake go at once.
  writeFileSync(gate, '');
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.equal(internals.wakeWaiters.size, 0, 'the end let the waiting wake go');
  await r.exited;
  assert.deepEqual(sent, [1], 'the waiting wake never went out');
  assert.equal(snap.calls.made, 2);
  assert.equal(snap.calls.unsent, 1);
  assert.equal(r.wakesDelivered, 1);
  rmSync(gateDir, { recursive: true, force: true });
});

test("a timed-out call's late answer is recorded with its start, and not sent", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const r = run({
    toolCallTimeoutMs: 100,
    onToolCall: async (_name, args) => {
      if (!args.includes('first')) return new Promise<never>(() => {});
      await hold;
      return result('the late answer');
    },
  });
  // The script keeps going after the timeout, so it's running when the late answer comes.
  r.start(`try { await tools.slow({ first: true }); } catch (e) { text(e.name); } for (;;) { try { await tools.slow({}); } catch {} }`, TOOLS);
  await until(() => r.snapshot().output === 'TimeoutError\n', 'the timeout in the script');
  release();
  await until(() => r.snapshot().calls.named[0]?.state === 'timed-out-answered', 'the late answer recorded');
  const snap = await r.stop('agent');
  // The first call named is the one whose answer came late; the loop's calls after it are named too.
  assert.deepEqual([snap.calls.named[0]!.tool, snap.calls.named[0]!.args, snap.calls.named[0]!.state], ['slow', '{"first":true}', 'timed-out-answered']);
  assert.match(snap.calls.named[0]!.answer ?? '', /the late answer/);
  await r.exited;
});

for (const [kind, over, script] of [
  ['refused', { onToolCall: async () => ({ ok: false, json: JSON.stringify({ name: 'ToolRefused', message: 'no' }) }) }, `tools.echo({})`],
  ['too large', { memoryMaxBytes: 3 * 1024 * 1024, onToolCall: async () => result('z'.repeat(2 * 1024 * 1024)) }, `tools.echo({})`],
  ['timed out', { toolCallTimeoutMs: 50, onToolCall: () => new Promise(() => {}) }, `tools.slow({})`],
] as const) {
  test(`a place frees once the script has a ${kind} answer, so ${MAX_CALLS_IN_FLIGHT * 2} such calls all get one`, async () => {
    const r = run(over as Partial<ScriptRunOptions>);
    r.start(`const settled = await Promise.allSettled(Array.from({ length: ${MAX_CALLS_IN_FLIGHT * 2} }, () => ${script})); return settled.length;`, TOOLS);
    const snap = await r.wait(LONGER_THAN_ANY_START_MS);
    assert.deepEqual(snap.ending, { how: 'finished', value: String(MAX_CALLS_IN_FLIGHT * 2) });
    // Timed out, the first 16 are still held in the host, whose tools never
    // answer, so the other 16 wait there past their timeouts and are told
    // they were never sent.
    assert.equal(snap.calls.unsent, kind === 'timed out' ? MAX_CALLS_IN_FLIGHT : 0);
    await r.exited;
  });
}

test('a wake waiting for its turn when its script is stopped is never sent, and the record counts it so', async () => {
  const sent: number[] = [];
  const r = run({ wakeMinIntervalMs: NEVER_FIRES_IN_A_TEST_MS, onWake: async (_payload, n) => { sent.push(n); return { ok: true, json: 'null' }; } });
  const internals = r as unknown as { wakeWaiters: Set<unknown> };
  r.start(`await wake_agent({ n: 1 }); await wake_agent({ n: 2 });`, TOOLS);
  await until(() => sent.length === 1 && internals.wakeWaiters.size === 1, 'the second wake waiting out the spacing');
  const snap = await r.stop('agent');
  assert.deepEqual(sent, [1]);
  assert.equal(snap.calls.made, 2);
  assert.equal(snap.calls.unsent, 1, 'the waiting wake is counted never sent');
  assert.deepEqual(snap.calls.named, []);
  assert.equal(r.wakesDelivered, 1);
  await r.exited;
});

test("a start frame too long to send starts nothing, and the run's exit resolves at once", async () => {
  const r = run();
  // The script alone passes the 64 MiB a frame can take.
  assert.throws(() => r.start('x'.repeat(65 * 1024 * 1024), TOOLS), /64|frame/);
  await r.exited;
  assert.equal((r as unknown as { child: unknown }).child, null);
});

test("a call id named again once its TimeoutError was seen takes a place of its own: the host still holds at most 16", async () => {
  const { bridge, onToolCall } = holdingBridge();
  const r = run({ childEntry: BAD_CHILD, childArgs: ['reuse-timed-out-id'], toolCallTimeoutMs: 20, onToolCall });
  r.start('return 1;', TOOLS);
  // Sixteen held under one id, and the next ones never sent.
  await until(() => bridge.inBridge === MAX_CALLS_IN_FLIGHT, 'sixteen held');
  await until(() => r.snapshot().calls.unsent >= 2, 'later ones told they were never sent');
  assert.equal(bridge.most, MAX_CALLS_IN_FLIGHT);
  await r.stop('agent');
  while (bridge.held.length) bridge.held.shift()!();
  await r.exited;
});

test("a call the bridge answered for, with no result from the host, keeps its place until the run ends", async () => {
  let calls = 0;
  const r = run({
    toolCallTimeoutMs: 200,
    // The bridge's own answer when no result came, which says the tool may
    // still run. It comes before the script's timeout here, which still
    // gives the script its TimeoutError.
    onToolCall: async () => {
      calls += 1;
      await new Promise((res) => setTimeout(res, 50));
      return { ...result('no result'), held: true };
    },
  });
  // Had the answers freed the places, the seventeenth would go out at once.
  r.start(`const all = await Promise.all(Array.from({ length: ${MAX_CALLS_IN_FLIGHT} }, () => tools.slow({}).then(() => 'answered', (e) => e.name)));
    try { await tools.echo({}); return 'sent'; } catch (e) { return [all.every((n) => n === 'TimeoutError'), e.name, /was never sent/.test(e.message)]; }`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '[true,"TimeoutError",true]' });
  assert.equal(calls, MAX_CALLS_IN_FLIGHT, 'the seventeenth never reached the bridge');
  // The sixteen stay timed out in the record: no answer came for them.
  assert.equal(snap.calls.answered + snap.calls.failed, 0);
  await r.exited;
});

test("a held answer that comes after the script's TimeoutError changes nothing: the call stays timed out, and keeps its place", async () => {
  let heldCame = false;
  let releaseWake!: () => void;
  const wakeGate = new Promise<void>((res) => (releaseWake = res));
  const r = run({
    toolCallTimeoutMs: 20,
    // As the bridge's safety timer does: its answer comes after the script's own timeout.
    onToolCall: async () => {
      await until(() => r.snapshot().calls.named[0]?.state === 'timed-out', "the script's own timeout");
      heldCame = true;
      return { ...result('no result'), held: true };
    },
    // A wake, which has no timeout, keeps the run going while the record is read.
    onWake: async () => {
      await wakeGate;
      return { ok: true, json: 'null' };
    },
  });
  const internals = r as unknown as { hostCalls: number };
  r.start(`const t = await tools.slow({}).then(() => 'answered', (e) => e.name); await wake_agent('hold'); return t;`, TOOLS);
  await until(() => heldCame, 'the held answer to come');
  await new Promise((res) => setImmediate(res));
  // Still timed out in the record, and its place kept.
  const calls = r.snapshot().calls;
  assert.equal(calls.answered + calls.failed, 0);
  assert.deepEqual(calls.named.map((c) => [c.tool, c.state]), [['slow', 'timed-out']]);
  assert.equal(internals.hostCalls, 1);
  releaseWake();
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '"TimeoutError"' });
  assert.deepEqual(snap.calls.named.map((c) => [c.tool, c.state]), [['slow', 'timed-out']]);
  await r.exited;
});

test("wakes sent after a stop count against the cap, so a child that keeps sending them crashes its run", async () => {
  let woke = 0;
  const r = run({ childEntry: BAD_CHILD, childArgs: ['wakes-after-stop', '5'], maxWakes: 3, onWake: async () => { woke += 1; return { ok: true, json: 'null' }; } });
  r.start('return 1;', TOOLS);
  await until(() => r.snapshot().output.includes('ready'), 'the child to be ready');
  const snap = await r.stop('agent');
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /more than 3 wakes, the most a script may send/);
  assert.equal(woke, 0);
  await r.exited;
});

test('a wake first received after a stop is refused, and the record counts it', async () => {
  let woke = 0;
  const r = run({ childEntry: BAD_CHILD, childArgs: ['wakes-after-stop', '1'], stopGraceMs: LONGER_THAN_ANY_START_MS, onWake: async () => { woke += 1; return { ok: true, json: 'null' }; } });
  r.start('return 1;', TOOLS);
  await until(() => r.snapshot().output.includes('ready'), 'the child to be ready');
  const snap = await r.stop('agent');
  assert.equal(snap.ending?.how, 'stopped');
  assert.equal(snap.calls.refused, 1);
  assert.equal(woke, 0);
  // Refused, it never went out: the script's wakes delivered count none.
  assert.equal(r.wakesDelivered, 0);
  await r.exited;
});

test("once its process has exited, nothing a script asks goes out: a call waiting for room, or one read after the exit", async () => {
  const { bridge, onToolCall } = holdingBridge();
  const gateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
  const gate = join(gateDir, 'go');
  const r = run({ childEntry: BAD_CHILD, childArgs: ['calls-then-exit-on-gate', gate], toolCallTimeoutMs: 3_000, onToolCall });
  r.start('return 1;', TOOLS);
  // Its own timeout is 3 s away: the exit and the freed place both come well before it.
  await until(() => r.snapshot().calls.waiting === 1, 'the seventeenth to wait for room');
  writeFileSync(gate, '');
  await r.exited;
  // Its own timeout is seconds away: it still waits as the exit lands.
  assert.equal(r.snapshot().calls.waiting, 1, 'the seventeenth still waiting when the exit landed');
  // A place frees after the exit, while fd 3 is still open.
  bridge.held.shift()!();
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(bridge.calls, MAX_CALLS_IN_FLIGHT, 'the waiting call never reached the bridge');
  assert.equal(snap.ending?.how, 'crashed');
  assert.equal(snap.calls.unsent, 1);
  while (bridge.held.length) bridge.held.shift()!();
  rmSync(gateDir, { recursive: true, force: true });

  // A call frame written to fd 3 after the child has gone, by a process
  // holding it, once the runner has seen the exit: the record counts it as
  // never sent, which shows the runner read it.
  let late = 0;
  const lateDir = mkdtempSync(join(tmpdir(), 'af-gate-'));
  const lateGate = join(lateDir, 'go');
  const r2 = run({ childEntry: BAD_CHILD, childArgs: ['late-call', lateGate], stopGraceMs: LONGER_THAN_ANY_START_MS, onToolCall: async () => { late += 1; return result('x'); } });
  r2.start('return 1;', TOOLS);
  await r2.exited;
  writeFileSync(lateGate, '');
  const snap2 = await r2.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap2.ending?.how, 'crashed');
  assert.equal(late, 0);
  assert.equal(snap2.calls.made, 1);
  assert.equal(snap2.calls.unsent, 1);
  rmSync(lateDir, { recursive: true, force: true });
});

for (const withBrief of [true, false]) {
  test(`a refusal too long for the script's memory is still a refusal: its start reaches the script, ${withBrief ? 'from its brief' : 'from its JSON when it has no brief'}, and the record counts it so`, async () => {
    const text = `Policy denied: ${'no '.repeat(800_000)}`;
    const r = run({
      memoryMaxBytes: 4 * 1024 * 1024,
      onToolCall: async () => ({ ok: false, json: JSON.stringify({ name: 'ToolRefused', message: text, tool: 'echo' }), ...(withBrief ? { brief: text } : {}) }),
    });
    r.start(`try { await tools.echo({}); return 'ran'; } catch (e) { return [e.name, e.message.length < 3000, e.message.startsWith('Policy denied: no no'), /so only its start is here; nothing was done\\)$/.test(e.message)]; }`, TOOLS);
    const snap = await r.wait(LONGER_THAN_ANY_START_MS);
    assert.deepEqual(snap.ending, { how: 'finished', value: '["ToolRefused",true,true,true]' });
    assert.equal(snap.calls.refused, 1);
    assert.deepEqual(snap.calls.named, []);
    await r.exited;
  });
}

test('a process that never started holds no child once its run has crashed', async () => {
  const r = run({ execPath: '/nonexistent/af-node' });
  const internals = r as unknown as { child: unknown };
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  // The cause is named, under Bun too, where spawn can return before its error comes.
  assert.match((snap.ending as { detail: string }).detail, /could not run: .*ENOENT/);
  assert.equal(internals.child, null);
  await r.exited;
});

test('a call handed a place keeps it while it runs, and the first call waiting is the one handed it', async () => {
  const held: Array<{ i: unknown; go: () => void }> = [];
  let inBridge = 0;
  let most = 0;
  const r = run({
    toolCallTimeoutMs: 1_000,
    onToolCall: async (_name, args) => {
      most = Math.max(most, ++inBridge);
      await new Promise<void>((go) => held.push({ i: JSON.parse(args).i, go }));
      inBridge -= 1;
      return result('ok');
    },
  });
  const internals = r as unknown as { hostCalls: number };
  r.start(`${SIXTEEN_TIME_OUT} const a = tools.slow({ i: 'a' }).catch(() => {}); const b = tools.slow({ i: 'b' }).catch(() => {}); await Promise.all([a, b]);`, TOOLS);
  await until(() => r.snapshot().calls.waiting === 2, 'a and b waiting for room');
  // The record counts the two waiting among the calls the script made.
  assert.equal(r.snapshot().calls.made, MAX_CALLS_IN_FLIGHT + 2);
  held.shift()!.go();
  // The first waiting, a, went out and holds the place; b still waits.
  await until(() => held.length === MAX_CALLS_IN_FLIGHT && held[held.length - 1]!.i === 'a', 'a in the bridge');
  assert.equal(most, MAX_CALLS_IN_FLIGHT);
  // a's place was taken for it: the host still counts 16, so no fresh call could go out beside it.
  assert.equal(internals.hostCalls, MAX_CALLS_IN_FLIGHT);
  assert.equal(r.snapshot().calls.waiting, 1);
  await r.stop('agent');
  while (held.length) held.shift()!.go();
  await r.exited;
});

test("a wake's spacing runs on a monotonic clock: the wall clock stepped back an hour doesn't hold it", async (t) => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  let wakes = 0;
  const r = run({
    wakeMinIntervalMs: 20,
    onWake: async () => {
      wakes += 1;
      return { ok: true, json: 'null' };
    },
    // Made between the two wakes, after the first's delivery set when the next
    // may go and before the second asks: the wall clock goes back an hour, so a
    // turn timed by it would hold the second wake an hour.
    onToolCall: async (name, args) => {
      offset = -3_600_000;
      return result(`${name} ${args}`);
    },
  });
  r.start(`await wake_agent(1); await tools.echo({}); await wake_agent(2); return 'done';`, TOOLS);
  // 20 ms of spacing against an hour: the run's own wait tells them apart.
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: '"done"' });
  assert.equal(wakes, 2);
  await r.exited;
});

test("a child's finished value far past what a return shows is bounded by the parent", async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['long-value'] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'finished');
  const value = (snap.ending as { value: string }).value;
  assert.ok(value.length < VALUE_CHARS + 2 * CUT_MARK_CHARS, `the value is ${value.length} characters`);
  assert.match(value, /characters dropped here/);
  await r.exited;
});

test("an honest child's cut failure passes the parent as it is, with the child's own count", async () => {
  const r = run();
  r.start(`throw new Error('m'.repeat(20000));`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'failed');
  // The child keeps 8,000 of the message's 20,000: its marker counts the 12,000 dropped.
  assert.match((snap.ending as { error: { message: string } }).error.message, /\[… 12000 characters dropped here …\]/);
  await r.exited;
});

test("a child's call with one string past the argument bytes, and few values, crashes the run", async () => {
  let calls = 0;
  const r = run({ childEntry: BAD_CHILD, childArgs: ['big-arg-string'], onToolCall: async () => { calls += 1; return result('x'); } });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, /whose arguments pass their caps of 4 MiB and 100,000 values/);
  assert.equal(calls, 0);
  await r.exited;
});

test("a child's frame longer than the longest a child sends, 25 MiB, crashes the run before its body is kept", async () => {
  assert.equal(MAX_CHILD_FRAME_BYTES, 25 * 1024 * 1024, 'six bytes for each of 4 MiB of arguments, and 1 MiB more');
  const r = run({ childEntry: BAD_CHILD, childArgs: ['oversized-frame', String(MAX_CHILD_FRAME_BYTES)] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.equal(snap.ending?.how, 'crashed');
  assert.match((snap.ending as { detail: string }).detail, new RegExp(`announced ${MAX_CHILD_FRAME_BYTES + 1} bytes, more than the ${MAX_CHILD_FRAME_BYTES} the protocol allows`));
  await r.exited;
});

test("a sent call's timeout is said exactly, a fraction of a second included", async () => {
  const r = run({ toolCallTimeoutMs: 1_100, onToolCall: () => new Promise(() => {}) });
  r.start(`try { await tools.slow({}); return 'answered'; } catch (e) { return e.message; }`, TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  assert.deepEqual(snap.ending, { how: 'finished', value: JSON.stringify('slow was sent, and no answer came within 1.1 s; it may still take effect') });
  await r.exited;
});

test('a frame of exactly the longest a child sends is read', async () => {
  const r = run({ childEntry: BAD_CHILD, childArgs: ['frame-at-cap', String(MAX_CHILD_FRAME_BYTES)] });
  r.start('return 1;', TOOLS);
  const snap = await r.wait(LONGER_THAN_ANY_START_MS);
  // Read and taken as output, cut to what a return shows; then the child says it finished.
  assert.equal(snap.ending?.how, 'finished', JSON.stringify(snap.ending));
  await r.exited;
});
