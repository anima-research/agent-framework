/**
 * The isolate end to end on the real engine: a child spawned on this test's
 * own runtime, Node's or Bun's, running QuickJS in WebAssembly. Each runtime
 * runs these: a spawn and a script that calls a tool, a stop through the stop
 * file reaching a spinning guest, and the memory limit.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_ENTRY, maxResultBytes, ScriptRun, type ScriptRunOptions, type ToolAnswer } from '../src/code-execution/isolate/runner.js';

// The entry the framework runs, which is the file beside the runner with its own extension.
const CHILD = CHILD_ENTRY;

test('the entry the runner names is a file that exists, so the runtime runs it and not a file it maps the name to', () => {
  // Under Bun, a .js path mapped to the .ts beside it runs as `bun run` would, with npm_* variables and a PATH in the child's environment.
  assert.ok(existsSync(CHILD_ENTRY), CHILD_ENTRY);
});
const TOOLS = [{ name: 'echo', description: 'Echoes its arguments.', inputSchema: { type: 'object' } }];

const answer = (value: unknown): ToolAnswer => ({
  ok: true,
  json: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false }),
  isError: false,
});

function run(over: Partial<ScriptRunOptions> = {}): ScriptRun {
  return new ScriptRun({
    childEntry: CHILD,
    memoryMaxBytes: 16 * 1024 * 1024,
    output: { headChars: 8000, tailChars: 8000 },
    flushMs: 50,
    lifetimeMs: 60_000,
    toolCallTimeoutMs: 60_000,
    stopGraceMs: 5_000,
    wakeMinIntervalMs: 0,
    maxWakes: 100,
    onToolCall: async (_name, args) => answer(JSON.parse(args)),
    onWake: async () => ({ ok: true, json: 'null' }),
    ...over,
  });
}

test('a script on the engine calls tools together, prints, and returns its value', async () => {
  const r = run();
  r.start(
    `const [a, b] = await Promise.all([tools.echo({ n: 1 }), tools.echo({ n: 2 })]);
     console.log('sum', a.structuredContent.n + b.structuredContent.n);
     text(ALL_TOOLS.map((t) => t.name + ':' + t.inputSchema.type).join());
     return { isError: a.isError, n: b.structuredContent.n };`,
    TOOLS,
  );
  const snap = await r.wait(20_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '{"isError":false,"n":2}' });
  assert.equal(snap.output, 'sum 3\necho:object\n');
  assert.equal(snap.calls.answered, 2);
  await r.exited;
});

test("a script's error on the engine names its own line, not the prelude's", async () => {
  const r = run();
  r.start(`const x = 1;\nnull.boom;`, TOOLS);
  const snap = await r.wait(20_000);
  assert.equal(snap.ending?.how, 'failed');
  const ending = snap.ending as { error: { name: string; message: string; stack?: string } };
  assert.equal(ending.error.name, 'TypeError');
  const frames = (ending.error.stack ?? '').split('\n');
  assert.ok(frames.length > 0 && frames.every((line) => /^ {4}at .*\(script:\d+:\d+\)$/.test(line)), ending.error.stack);
  assert.ok(frames.some((line) => /\(script:2:\d+\)$/.test(line)), ending.error.stack);
  await r.exited;
});

test('the stop file reaches a spinning guest on the engine, and its output so far comes back', async () => {
  const r = run();
  r.start(`text('spinning'); for (;;) {}`, TOOLS);
  // The guest's output is flushed from its interrupt checks while it spins.
  const deadline = Date.now() + 20_000;
  while (r.snapshot().output !== 'spinning\n') {
    assert.ok(Date.now() < deadline, 'the output while it spins');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snap = await r.stop('limit');
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'limit' });
  assert.equal(snap.output, 'spinning\n');
  await r.exited;
});

// A script that keeps QuickJS from taking a stop: each TypeError's stack runs
// the hook, which spins until a stop lands in it, and QuickJS drops that stop,
// putting back the TypeError, which the loop catches.
const DROPS_EVERY_STOP = `text('spinning');\nError.prepareStackTrace = () => { for (;;) {} };\nfor (;;) { try { null.x; } catch {} }`;

test("a stop that a script's stack hook keeps QuickJS from taking ends the run at the stop's grace, its process killed", async () => {
  const r = run({ stopGraceMs: 1_000 });
  r.start(DROPS_EVERY_STOP, TOOLS);
  const deadline = performance.now() + 20_000;
  while (r.snapshot().output !== 'spinning\n') {
    assert.ok(performance.now() < deadline, 'the output while it spins');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const asked = performance.now();
  const snap = await r.stop('limit');
  const took = performance.now() - asked;
  assert.deepEqual(snap.ending, { how: 'stopped', reason: 'limit', short: true });
  // Killed at the grace: not before it, since the stop never landed, and not
  // long after it, with room for a loaded host.
  assert.ok(took >= 950, `ended ${took} ms after the stop, before its 1 s grace`);
  assert.ok(took < 6_000, `ended ${took} ms after the stop`);
  await r.exited;
});

/**
 * The child the runner starts, under a parent that names itself, running a script whose stack hook
 * keeps QuickJS from taking any stop: it says it's running, from inside its run, and then, if
 * `stopFirst`, the parent asks it to stop and it runs on; then its parent goes. Nothing tells the
 * child but its parent pid changing, and no one is left to kill it.
 */
async function orphanEnds(stopFirst: boolean): Promise<void> {
  const parentEntry = fileURLToPath(new URL(`./helpers/orphan-parent-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'af-orphan-'));
  const message = { t: 'start', script: DROPS_EVERY_STOP, tools: TOOLS, memoryMaxBytes: 16 * 1024 * 1024, stopFile: join(dir, 'stop'), flushMs: 0, maxWakes: 100 };
  const parent = spawn(process.execPath, [parentEntry, CHILD], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CHILD_DIR: dir, START: JSON.stringify(message) } });
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
    // Gone, or a zombie its new parent hasn't reaped yet, which ps marks Z.
    const alive = () => {
      try { process.kill(childPid, 0); } catch { return false; }
      try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' }).trim().startsWith('Z'); } catch {
        try { process.kill(childPid, 0); return true; } catch { return false; }
      }
    };
    assert.equal(alive(), true, 'the child is running');
    if (stopFirst) {
      // The stop file, as the parent makes it: the guest takes the stop and keeps it from landing.
      writeFileSync(join(dir, 'stop'), '');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(alive(), true, 'the guest runs on past its stop');
    }
    parent.kill('SIGKILL');
    const deadline = performance.now() + 10_000;
    while (alive() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(), false, 'the orphaned child ended');
  } finally {
    parent.kill('SIGKILL');
    if (childPid) try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an orphan whose script's stack hook keeps QuickJS from taking a stop ends its process", () => orphanEnds(false));

test('an orphan whose script keeps a stop it took before its parent went from landing ends its process', () => orphanEnds(true));

test("the orphan tests' parent exits 1 at once, saying so, when its child exits before its first output", async () => {
  const parentEntry = fileURLToPath(new URL(`./helpers/orphan-parent-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'af-orphan-early-'));
  const entry = join(dir, 'exits-at-once.mjs');
  writeFileSync(entry, 'process.exit(3);\n');
  const parent = spawn(process.execPath, [parentEntry, entry], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHILD_DIR: dir, START: '{}' } });
  const hang = setTimeout(() => parent.kill('SIGKILL'), 10_000);
  try {
    let out = '';
    let err = '';
    parent.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    parent.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => parent.on('close', (c, s) => resolve([c, s])));
    assert.deepEqual({ code, signal }, { code: 1, signal: null }, 'the parent ended on its own, with code 1, not killed at the 10 s bound');
    assert.equal(out, '');
    assert.equal(err, 'the child exited before its first output: code 3, signal null\n');
  } finally {
    clearTimeout(hang);
    parent.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a script that fills its memory gets a catchable out-of-memory error, and the child lives on', async () => {
  const r = run();
  r.start(
    `const kept = [];
     try { for (;;) kept.push({ i: kept.length, s: 'x'.repeat(64) }); }
     catch (e) { kept.length = 0; return [e.name, e.message]; }`,
    TOOLS,
  );
  const snap = await r.wait(30_000);
  assert.equal(snap.ending?.how, 'finished', JSON.stringify(snap.ending));
  const [name, message] = JSON.parse((snap.ending as { value: string }).value) as [string, string];
  assert.equal(name, 'InternalError');
  assert.match(message, /out of memory/);
  await r.exited;
});

test("an answer the script couldn't receive says whether the call took effect, and a refusal stays one in the record", async () => {
  const r = run({
    onToolCall: async (_name, args) => (JSON.parse(args).refuse
      // A refusal whose text isn't valid JSON, which no host sends, can't reach the script.
      ? { ok: false, json: '{"name": "ToolRefused", "message": ' }
      : { ok: true, json: '{"content": [', isError: false }),
  });
  r.start(`const out = []; for (const refuse of [false, true]) { try { await tools.echo({ refuse }); } catch (e) { out.push([e.name, /not valid JSON/.test(e.message), /the call took effect/.test(e.message), /the host's answer, \\d+ bytes, couldn't be received by this script whole/.test(e.message)]); } } return out;`, TOOLS);
  const snap = await r.wait(30_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '[["ResultTooLarge",true,true,false],["ResultTooLarge",true,false,true]]' });
  assert.equal(snap.calls.refused, 1, 'the refusal is still counted as one');
  assert.deepEqual(snap.calls.named, [{ tool: 'echo', args: '{"refuse":false}', state: 'too-large' }]);
  await r.exited;
});

test("a result within the bound that doesn't fit the guest's memory reaches the script as ResultTooLarge, and is named", async () => {
  // 16 MiB of memory bounds a result at about 5.3 MiB, but small objects need
  // more room to parse than their JSON takes:
  // about 4.5 MiB of them doesn't fit.
  const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: 100_000 + i, name: `item-${i}`, ok: true }));
  const json = JSON.stringify({ content: [], structuredContent: rows, isError: false });
  assert.ok(Buffer.byteLength(json) < maxResultBytes(16 * 1024 * 1024), 'within the bound, so the parent sends it');
  const r = run({ onToolCall: async () => ({ ok: true, json, isError: false }) });
  r.start(`try { await tools.echo({ big: true }); return 'fit'; } catch (e) { return [e.name, /couldn't be received by this script: it was too large for its memory, nested deeper than 2000 levels, or not valid JSON; the call took effect/.test(e.message), e.bytes > 4000000]; }`, TOOLS);
  const snap = await r.wait(30_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["ResultTooLarge",true,true]' });
  assert.deepEqual(snap.calls.named, [{ tool: 'echo', args: '{"big":true}', state: 'too-large' }]);
  assert.equal(snap.calls.answered, 0);
  await r.exited;
});

test('a result over the bound is refused before it is sent, as ResultTooLarge, and is named', async () => {
  const json = JSON.stringify({ content: [], structuredContent: 'x'.repeat(6 * 1024 * 1024), isError: false });
  const r = run({ onToolCall: async () => ({ ok: true, json, isError: false }) });
  r.start(`try { await tools.echo({}); return 'fit'; } catch (e) { return [e.name, /is too large for this script's memory/.test(e.message)]; }`, TOOLS);
  const snap = await r.wait(30_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["ResultTooLarge",true]' });
  assert.deepEqual(snap.calls.named, [{ tool: 'echo', args: '{}', state: 'too-large' }]);
  await r.exited;
});

test("on the engine, arguments past a call's bytes are refused before a frame is built, and the script goes on", async () => {
  const r = run({ memoryMaxBytes: 64 * 1024 * 1024 });
  // 3 MiB of quotes: 6,291,464 bytes of arguments once stringified, past the 4 MiB a call takes.
  r.start(`try { await tools.echo({ s: '"'.repeat(3 * 1024 * 1024) }); } catch (e) { return [e.name, e.bytes]; }`, TOOLS);
  const snap = await r.wait(60_000);
  assert.equal(snap.ending?.how, 'finished', JSON.stringify(snap.ending));
  const [name, bytes] = JSON.parse((snap.ending as { value: string }).value) as [string, number];
  assert.equal(name, 'ArgumentsTooLarge');
  assert.equal(bytes, 6 * 1024 * 1024 + 8);
  assert.equal(snap.calls.made, 0);
  await r.exited;
});

test("a script's syntax error on the engine names its own line", async () => {
  const r = run();
  r.start(`const x = 1;\nlet y = ;`, TOOLS);
  const snap = await r.wait(20_000);
  assert.equal(snap.ending?.how, 'failed');
  const ending = snap.ending as { error: { name: string; message: string; stack?: string } };
  assert.equal(ending.error.name, 'SyntaxError');
  assert.match(ending.error.stack ?? '', /script:2:/);
  assert.doesNotMatch(ending.error.stack ?? '', /<input>|<prelude>/);
  await r.exited;
});

test('a thrown value that is no Error fails the script with its JSON as the message', async () => {
  const r = run();
  r.start(`throw { why: 'this failure should stay visible' };`, TOOLS);
  const snap = await r.wait(20_000);
  assert.deepEqual(snap.ending, { how: 'failed', error: { name: '', message: '{"why":"this failure should stay visible"}' } });
  await r.exited;
});

test("a returned value's toJSON runs once, however many answers come after the return", async () => {
  const r = run();
  r.start(
    `let n = 0;
     const value = { toJSON() { n += 1; text('serialized ' + n); return { n }; } };
     tools.echo({ a: 1 });
     tools.echo({ b: 2 });
     return value;`,
    TOOLS,
  );
  const snap = await r.wait(20_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '{"n":1}' });
  assert.equal(snap.output, 'serialized 1\n');
  await r.exited;
});

test("a tool's schema keeps a __proto__ key as a key in ALL_TOOLS", async () => {
  const r = run();
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"path":{"type":"string"}}}') as unknown;
  r.start(`return Object.keys(ALL_TOOLS[0].inputSchema.properties);`, [{ name: 'echo', description: 'Echoes.', inputSchema: schema }]);
  const snap = await r.wait(20_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["__proto__","path"]' });
  await r.exited;
});

test('past its cap a wake is refused in the script, and never reaches the host', async () => {
  let woke = 0;
  const r = run({ maxWakes: 2, onWake: async () => { woke += 1; return { ok: true, json: 'null' }; } });
  r.start(`await wake_agent(1); await wake_agent(2); try { await wake_agent(3); } catch (e) { return [e.name, e.message]; }`, TOOLS);
  const snap = await r.wait(20_000);
  assert.deepEqual(snap.ending, {
    how: 'finished',
    value: JSON.stringify(['WakeRefused', "wake limit reached: 2 per script, set by the host's maxWakesPerScript; nothing was sent, and every later wake_agent() in this script is refused the same way. A new script can wake its agent again."]),
  });
  assert.equal(woke, 2);
  await r.exited;
});

test("a script's mistakes with its tools read plainly: no tools at all, or arguments that aren't JSON", async () => {
  const none = run();
  none.start(`try { tools.anything; } catch (e) { return e.message; }`, []);
  const a = await none.wait(20_000);
  assert.match((a.ending as { value: string }).value, /is not one of your tools\. You have no tools\. Nothing was sent\./);
  await none.exited;
  const cyclic = run();
  cyclic.start(`const a = {}; a.self = a; try { await tools.echo(a); } catch (e) { return e.message; }`, TOOLS);
  const b = await cyclic.wait(20_000);
  const message = JSON.parse((b.ending as { value: string }).value) as string;
  assert.match(message, /^echo's arguments aren't JSON \(.+\); nothing was sent$/);
  assert.doesNotMatch(message, /\n|TypeError: /);
  await cyclic.exited;
});

test('a result nested deeper than the engine takes reaches the script as ResultTooLarge, and the call took effect', async () => {
  let deep = '1';
  for (let i = 0; i < 2_100; i++) deep = `[${deep}]`;
  const json = JSON.stringify({ content: [{ type: 'text', text: 'deep' }], structuredContent: JSON.parse(deep), isError: false });
  const r = run({ onToolCall: async () => ({ ok: true, json, isError: false }) });
  r.start(`try { await tools.echo({}); return 'received'; } catch (e) { return [e.name, /nested deeper than 2000 levels/.test(e.message)]; }`, TOOLS);
  const snap = await r.wait(30_000);
  assert.deepEqual(snap.ending, { how: 'finished', value: '["ResultTooLarge",true]' });
  assert.deepEqual(snap.calls.named, [{ tool: 'echo', args: '{}', state: 'too-large' }]);
  await r.exited;
});

test("a return value JSON can't hold comes back saying so, with its string form if it has one", async () => {
  for (const [script, said] of [
    ['return 10n;', "JSON can't hold the returned value, so this is its string form: 10"],
    ['return () => 1;', "JSON can't hold the returned value, so this is its string form: () => 1"],
    ['const a = {}; a.self = a; return a;', "JSON can't hold the returned value, so this is its string form: [object Object]"],
    ['return { toJSON() { throw new Error("no"); }, toString() { throw new Error("no"); } };', "JSON can't hold the returned value, and it has no string form"],
  ] as const) {
    const r = run();
    r.start(script, TOOLS);
    const snap = await r.wait(20_000);
    assert.deepEqual(snap.ending, { how: 'finished', value: JSON.stringify(said) }, script);
    await r.exited;
  }
});

test("a failure that escaped the script's promises reads as a thrown one does: the script's own frames, its lines as written", async () => {
  const stackOf = async (code: string) => {
    const r = run();
    r.start(code, TOOLS);
    const snap = await r.wait(20_000);
    await r.exited;
    assert.equal(snap.ending?.how, 'failed', JSON.stringify(snap.ending));
    return snap.ending?.how === 'failed' ? snap.ending.error : undefined;
  };
  // Thrown by the script itself, through the prelude, at its line 3.
  const thrown = await stackOf(`const a = 1;\nfunction f() {\n  throw new Error('here');\n}\nf();`);
  // Thrown by a microtask's callback, which escapes the script's promises (the engine's failed), at its line 3.
  const escaped = await stackOf(`const a = 1;\nqueueMicrotask(function f() {\n  throw new Error('here');\n});\nawait tools.echo({});`);
  // The ending's stack is the script's frames alone (GuestError.stack).
  const framesOf = (error: { stack?: string } | undefined): string[] => {
    const frames = (error?.stack ?? '').split('\n');
    assert.ok(frames.length > 0 && frames.every((line) => /^ {4}at .*\(script:\d+:\d+\)$/.test(line)), error?.stack);
    return frames;
  };
  for (const error of [thrown, escaped]) {
    assert.equal(error?.name, 'Error');
    assert.equal(error?.message, 'here');
    // Only the script's own frames, each numbered as written, f's first.
    assert.match(framesOf(error)[0]!, /^ {4}at f \(script:3:\d+\)$/, error?.stack);
  }
  // The escaped one was called by the engine's job queue, which has no frame of the script's.
  assert.equal(framesOf(escaped).length, 1, escaped?.stack);
  // One Error, thrown by the script and again by a job that escapes its
  // promises: its stack is QuickJS's own both times, frames only, so the
  // escaped failure's frames are the script's, and a line of its message that
  // reads like a frame stays in the message, given once.
  const twice = await stackOf(`const e = new Error('boom\\n    at note (script:9:1)');\nqueueMicrotask(() => queueMicrotask(() => { throw e; }));\nthrow e;`);
  assert.equal(twice?.message, 'boom\n    at note (script:9:1)');
  assert.match(framesOf(twice)[0]!, /^ {4}at anonymous \(script:1:\d+\)$/, twice?.stack);
  assert.doesNotMatch(twice?.stack ?? '', /note/);
  // A frozen Error: its frames are put the same way.
  const frozen = await stackOf(`const a = 1;\nfunction f() {\n  throw Object.freeze(new Error('cold'));\n}\nf();`);
  assert.equal(frozen?.message, 'cold');
  assert.match(framesOf(frozen)[0]!, /^ {4}at f \(script:3:\d+\)$/, frozen?.stack);
  // A message cut for its length, ending in a line that reads like a frame, and a name cut likewise: the frames are the script's own.
  const long = await stackOf(`const e = new Error('x'.repeat(9000) + '\\n    at evil (script:9:1)');\ne.name = 'N'.repeat(300);\nfunction f() { throw e; }\nf();`);
  assert.match(long?.message ?? '', /characters dropped here/);
  assert.match(framesOf(long)[0]!, /^ {4}at anonymous \(script:1:\d+\)$/, long?.stack);
  assert.doesNotMatch(long?.stack ?? '', /evil/);
  // A name whose getter answers differently at each read, its message's last line shaped as a frame: the frames are still the script's own.
  const unstable = await stackOf(`const e = new Error('first\\n    at note (script:9:1)');\nlet n = 0;\nObject.defineProperty(e, 'name', { get() { return ++n === 1 ? 'Old' : 'New'; } });\nthrow e;`);
  assert.deepEqual(framesOf(unstable).length, 1, unstable?.stack);
  assert.match(framesOf(unstable)[0]!, /^ {4}at anonymous \(script:1:\d+\)$/, unstable?.stack);
  // A name set to undefined, which the engine leaves out.
  const unnamed = await stackOf(`const e = new Error('bad <input>:4');\ne.name = undefined;\nthrow e;`);
  assert.equal(unnamed?.name, '');
  assert.deepEqual(framesOf(unnamed).length, 1, unnamed?.stack);
  assert.match(framesOf(unnamed)[0]!, /^ {4}at anonymous \(script:1:\d+\)$/, unnamed?.stack);
  // A function whose name holds a line break, called between two others: its frame, split, is left out, and the throw's and
  // the caller's stay. One whose name starts with a space is kept.
  const split = await stackOf(`function fail() { throw new Error('boom'); }\nconst o = { ['outer\\nlabel']() { fail(); }, [' run']() { o['outer\\nlabel'](); } };\no[' run']();`);
  assert.deepEqual(framesOf(split).map((line) => line.replace(/:\d+\)$/, ')')), ['    at fail (script:1)', '    at  run (script:2)', '    at anonymous (script:3)'], split?.stack);
  // Code the script compiles at run time is named <input> as the script is: a frame in an eval'd string reads at the
  // string's line less two, one in a Function constructor's body at the body's own line, plus one for each line break in
  // its parameters, and the script's own frame below.
  const lineOf = (line: string) => Number(/script:(\d+):\d+\)$/.exec(line)![1]);
  const evald = await stackOf(`eval('1;\\n2;\\n3;\\nthrow new Error("in eval");');`);
  assert.deepEqual(framesOf(evald).map(lineOf), [2, 1], evald?.stack);
  const built = await stackOf(`new Function('1;\\n2;\\nthrow new Error("in fn");')();`);
  assert.deepEqual(framesOf(built).map(lineOf), [3, 1], built?.stack);
  const params = await stackOf(`new Function('a,\\nb', 'throw new Error("in fn");')();`);
  assert.deepEqual(framesOf(params).map(lineOf), [2, 1], params?.stack);
});

test("inside the script, a logged Error leads with its head and keeps only the script's frames, its message's lines given once", async () => {
  const r = run();
  // A stack the script set, opening with the error's head, whose message has a line that reads like a frame, then a line shaped as a frame of no place of
  // the script's and one of QuickJS's: only the last is a frame.
  r.start([
    `const e = new Error('first\\n    at note (script:8:1)');`,
    `e.stack = 'Error: first\\n    at note (script:8:1)\\n    at g (script:9:1)\\n    at h (<input>:12:3)';`,
    'console.log(e);',
    // One whose stack is its head alone, a frame-like line of its message included.
    `const only = new Error('only\\n    at note (script:7:1)');`,
    `only.stack = 'Error: only\\n    at note (script:7:1)';`,
    'console.log(only);',
    // One the script made, whose stack is QuickJS's own: the script's frame alone, not the prelude's that called it.
    `console.log(new Error('logged'));`,
    // One whose stack opens with another head: only the line shaped as a frame of the script's is one, not its old message's frame-shaped line.
    `const other = new Error('mine');`,
    `other.stack = 'Other: theirs\\n    at note (script:9:1)\\nlast\\n    at h (<input>:12:3)';`,
    'console.log(other);',
    // One whose stack, after its head, has a line that names the script's source but isn't shaped as a frame: not a frame.
    `const plain = new Error('x');`,
    `plain.stack = 'Error: x\\nsee <input>:3\\n    at h (<input>:12:3)';`,
    'console.log(plain);',
    // One QuickJS made, thrown through a function whose name holds a line break: that frame, split, is left out, and the
    // frames below and above it stay.
    `function fail() { throw new Error('split'); }`,
    `const o = { ['outer\\nlabel']() { try { fail(); } catch (e) { console.log(e); } }, [' run']() { o['outer\\nlabel'](); } };`,
    `o[' run']();`,
  ].join('\n'), TOOLS);
  const snap = await r.wait(20_000);
  await r.exited;
  assert.equal(snap.ending?.how, 'finished', JSON.stringify(snap.ending));
  assert.match(snap.output, /^Error: first\n {4}at note \(script:8:1\)\n {4}at h \(script:10:3\)\nError: only\n {4}at note \(script:7:1\)\nError: logged\n {4}at anonymous \(script:7:\d+\)\nError: mine\n {4}at h \(script:10:3\)\nError: x\n {4}at h \(script:10:3\)\nError: split\n {4}at fail \(script:14:\d+\)\n {4}at  run \(script:15:\d+\)\n {4}at anonymous \(script:16:\d+\)\n?$/);
});
