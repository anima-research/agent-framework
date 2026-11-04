/**
 * The isolate's scripts for one agent, with real children on the stand-in engine:
 * the yield and later waits, each return's own output, stopping, what wakes
 * an agent and what doesn't, the limits on running scripts and children, and
 * wake_agent()'s spacing and cap.
 */

import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildCapacity, type CallAnswer } from '../src/code-execution/isolate/runner.js';
import { AgentScripts, ScriptRefusal, type ScriptCallContext, type ScriptsConfig, type ScriptsHost } from '../src/code-execution/isolate/scripts.js';
import { renderOutput } from '../src/code-execution/isolate/output.js';
import { fireNextYieldAsSet } from './helpers/capture-timers.js';

// With this file's own extension, as the runner names its entry, so the runtime runs a file that exists.
const FAKE_CHILD = fileURLToPath(new URL(`./helpers/fake-child-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
const LINGERING_CHILD = fileURLToPath(new URL(`./helpers/bad-child-finished-then-hold${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

const result = (text: string): CallAnswer & { isError: boolean } => ({
  ok: true,
  json: JSON.stringify({ content: [{ type: 'text', text }], structuredContent: null, isError: false }),
  isError: false,
});

/** Every setup's scripts, stopped once the file's tests are done, so no child outlives them. */
const made: AgentScripts[] = [];
after(async () => {
  for (const scripts of made) await scripts.dispose();
});

const LONGER_THAN_ANY_START_MS = 60_000;
const NEVER_FIRES_IN_A_TEST_MS = 2 * LONGER_THAN_ANY_START_MS;

function setup(over: { host?: Partial<ScriptsHost>; config?: Partial<ScriptsConfig>; capacity?: number } = {}) {
  const wakes: [string, string][] = [];
  const gates = new Map<string, () => void>();
  const contexts = new Map<string, ScriptCallContext | undefined>();
  const host: ScriptsHost = {
    tools: () => [{ name: 'echo', description: 'Echoes.' }, { name: 'slow', description: 'Answers when released.' }],
    dispatch: async (_agent, name, args, ctx) => {
      if (name === 'slow') {
        const key = JSON.parse(args).key ?? 'slow';
        contexts.set(key, ctx);
        await new Promise<void>((resolve) => gates.set(key, resolve));
      }
      return result(`${name} ${args}`);
    },
    wake: async (agent, _scriptId, text) => {
      wakes.push([agent, text]);
    },
    outlivesTurn: () => true,
    ...over.host,
  };
  const config: ScriptsConfig = {
    childEntry: FAKE_CHILD,
    memoryMaxBytes: 64 * 1024 * 1024,
    output: { headChars: 1000, tailChars: 1000 },
    flushMs: 20,
    yieldMs: 300,
    maxYieldMs: LONGER_THAN_ANY_START_MS,
    lifetimeMs: NEVER_FIRES_IN_A_TEST_MS,
    toolCallTimeoutMs: NEVER_FIRES_IN_A_TEST_MS,
    stopGraceMs: 2_000,
    maxRunning: 3,
    keepEnded: 8,
    wakeMinIntervalMs: 0,
    maxWakesPerScript: 100,
    ...over.config,
  };
  const scripts = new AgentScripts(host, config, new ChildCapacity(over.capacity ?? 16));
  made.push(scripts);
  /** Wait until the script's call `key` is waiting in the host. */
  const called = async (key = 'slow') => {
    for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !gates.has(key);) await new Promise((r) => setTimeout(r, 10));
    assert.ok(gates.has(key), `the call ${key} arrived`);
  };
  const release = async (key = 'slow') => {
    await called(key);
    gates.get(key)!();
    gates.delete(key);
  };
  const watching = (key = 'slow') => contexts.get(key)?.watching?.();
  return { scripts, wakes, release, called, watching };
}

test('a script that ends within its bound returns whole', async () => {
  // A bound no child's start reaches, however loaded the host.
  const { scripts } = setup({ config: { yieldMs: LONGER_THAN_ANY_START_MS } });
  const r = await scripts.run('alice', `const a = await tools.echo({ x: 1 }); text(a.content[0].text); return 7;`);
  assert.equal(r.running, false);
  assert.deepEqual(r.ending, { how: 'finished', value: '7' });
  assert.equal(renderOutput(r.output), 'echo {"x":1}\n');
  assert.equal(r.stopsAtTurnEnd, false);
});

test('past its bound a script yields what it wrote, and each wait returns only what came since', async () => {
  const { scripts, release } = setup();
  // Yield at once; its child may not have started yet.
  const first = await scripts.run('alice', `text('one'); await tools.slow({}); text('two'); return 'end';`, 0);
  assert.equal(first.running, true);
  // Once its call waits, what it wrote first has been flushed.
  const waiting = scripts.wait('alice', first.scriptId, LONGER_THAN_ANY_START_MS);
  await release();
  const second = await waiting;
  assert.equal(second.running, false);
  assert.equal(renderOutput(first.output) + renderOutput(second.output), 'one\ntwo\n');
  assert.deepEqual(second.ending, { how: 'finished', value: '"end"' });
  // A return after the end has nothing new.
  const third = await scripts.wait('alice', first.scriptId);
  assert.equal(renderOutput(third.output), '');
});

test("a non-primary agent's yield says its turn's end will stop it, and that stop wakes no one", async () => {
  const { scripts, wakes, called } = setup({ host: { outlivesTurn: (agent) => agent === 'primary' } });
  const r = await scripts.run('helper', `await tools.slow({});`);
  assert.equal(r.running, true);
  assert.equal(r.stopsAtTurnEnd, true);
  await called();
  scripts.turnEnded('helper', { id: 1, live: [] }, false);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && scripts.running('helper') > 0;) await new Promise((res) => setTimeout(res, 10));
  const [listed] = scripts.list('helper');
  assert.deepEqual(listed!.ending, { how: 'stopped', reason: 'limit', why: "its agent's turn ended, and only the primary agent's scripts outlive a turn" });
  assert.deepEqual(wakes, []);
});

test('a left script that fails wakes its agent; one that finishes says nothing', async () => {
  const { scripts, wakes, release } = setup();
  const failing = await scripts.run('alice', `await tools.slow({ key: 'a' }); throw new Error('broke');`);
  const finishing = await scripts.run('alice', `await tools.slow({ key: 'b' }); return 1;`);
  assert.equal(failing.running && finishing.running, true);
  await release('a');
  await release('b');
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && scripts.running('alice') > 0;) await new Promise((res) => setTimeout(res, 10));
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]![1], new RegExp(`\\[script ${failing.scriptId}\\] Your script failed: Error: broke`));
  const later = await scripts.wait('alice', finishing.scriptId);
  assert.deepEqual(later.ending, { how: 'finished', value: '1' });
});

test("the agent's stop ends its script and leaves the call it waited on uncertain", async () => {
  const { scripts, called } = setup();
  const r = await scripts.run('alice', `await tools.slow({});`);
  await called();
  const stopped = await scripts.stop('alice', r.scriptId);
  assert.deepEqual(stopped.ending, { how: 'stopped', reason: 'agent' });
  assert.deepEqual(stopped.calls.named.map((c) => c.state), ['uncertain']);
});

test('an agent at its most running scripts, or a host at its most children, is refused, with nothing run', async () => {
  const { scripts } = setup({ config: { maxRunning: 1 } });
  await scripts.run('alice', `await tools.slow({});`);
  await assert.rejects(scripts.run('alice', `return 1;`), (e: unknown) => e instanceof ScriptRefusal && /your most\..*Nothing was run\./s.test(e.message));
  const full = setup({ capacity: 1 });
  await full.scripts.run('bob', `await tools.slow({});`);
  await assert.rejects(full.scripts.run('carol', `return 1;`), (e: unknown) => e instanceof ScriptRefusal && /its most\..*Nothing was run\./s.test(e.message));
});

test("another agent's script, or one that isn't there, is refused by name", async () => {
  const { scripts } = setup();
  const r = await scripts.run('alice', `return 1;`);
  await assert.rejects(scripts.wait('bob', r.scriptId), (e: unknown) => e instanceof ScriptRefusal && e.message.includes(`no script "${r.scriptId}"`));
  await assert.rejects(scripts.wait('alice', 's1'), /no script "s1": it isn't one of yours, it ran before this host restarted, or it ended and was dropped/);
});

test("another host's id names no script here, as one from before a restart doesn't", async () => {
  const first = setup();
  const theirs = await first.scripts.run('alice', `return 1;`);
  // Each host tags its ids, so this host's first script isn't the other's,
  // though both count from one. Two hosts' random tags are alike about one
  // time in 1.7 million, so it tries up to three hosts.
  let here = setup();
  let mine = await here.scripts.run('alice', `return 1;`);
  for (let tries = 0; tries < 2 && mine.scriptId === theirs.scriptId; tries++) {
    here = setup();
    mine = await here.scripts.run('alice', `return 1;`);
  }
  assert.notEqual(mine.scriptId, theirs.scriptId);
  await assert.rejects(here.scripts.wait('alice', theirs.scriptId), (e: unknown) => e instanceof ScriptRefusal && e.message.includes(`no script "${theirs.scriptId}"`));
});

test('wake_agent() wakes its agent with the payload, and past the cap it is refused', async () => {
  const { scripts, wakes } = setup({ config: { maxWakesPerScript: 2, yieldMs: LONGER_THAN_ANY_START_MS } });
  const r = await scripts.run('alice', `await wake_agent({ n: 1 }); await wake_agent({ n: 2 }); try { await wake_agent({ n: 3 }); } catch (e) { return e.message; }`);
  assert.equal(r.running, false);
  assert.match(r.ending?.how === 'finished' ? r.ending.value ?? '' : '', /wake limit reached: 2 per script/);
  assert.equal(wakes.length, 2);
  assert.match(wakes[0]![1], /\(wake 1 of 2\): \{"n":1\}$/);
});

test('a wake_agent() payload is written in its notice on one line, as JSON that gives the payload back', async () => {
  const { scripts, wakes } = setup({ config: { yieldMs: LONGER_THAN_ANY_START_MS } });
  await scripts.run('alice', `await wake_agent({ text: 'first\\u2028second\\u0085third' }); return 1;`);
  assert.equal(wakes.length, 1);
  const notice = wakes[0]![1];
  assert.ok(!/[\r\n\u0085\u2028\u2029]/.test(notice), JSON.stringify(notice));
  assert.deepEqual(JSON.parse(notice.slice(notice.indexOf('): ') + 3)), { text: 'first\u2028second\u0085third' });
});

test('a listing counts the wakes the host delivered, not one whose delivery failed', async () => {
  const { scripts } = setup({ host: { wake: async (_agent, _scriptId, text) => { if (text.includes('"n":2')) throw new Error('no route'); } } });
  // A yield past the script's end, which comes first: the listing is read once it has ended.
  const r = await scripts.run('alice', `await wake_agent({ n: 1 }); try { await wake_agent({ n: 2 }); } catch {} await wake_agent({ n: 3 }); return 1;`, LONGER_THAN_ANY_START_MS);
  assert.equal(r.running, false, JSON.stringify(r.ending));
  const listed = scripts.list('alice');
  assert.equal(listed.find((s) => s.scriptId === r.scriptId)?.wakes, 2);
  const { renderList } = await import('../src/code-execution/isolate/render.js');
  assert.match(renderList(listed, Date.now()), new RegExp(`- ${r.scriptId}: .*\\(2 wakes delivered\\)`));
  await scripts.dispose();
});

test('an early wake waits for its spacing rather than being dropped', async () => {
  const at: number[] = [];
  const { scripts, wakes } = setup({
    config: { wakeMinIntervalMs: 250, yieldMs: LONGER_THAN_ANY_START_MS },
    host: { wake: async (agent, _id, text) => { at.push(Date.now()); wakes.push([agent, text]); } },
  });
  await scripts.run('alice', `await wake_agent('a'); await wake_agent('b');`);
  assert.equal(wakes.length, 2);
  // Measured between the deliveries, not from the run's start, so a slow child start can't stand in for the spacing.
  assert.ok(at[1]! - at[0]! >= 240, `the second wake came ${at[1]! - at[0]!} ms after the first`);
});

test('wakes go out in the order they were made, and a failed delivery refuses its wake and not the next', async () => {
  let n = 0;
  const { scripts, wakes } = setup({
    config: { wakeMinIntervalMs: 50, yieldMs: LONGER_THAN_ANY_START_MS },
    host: {
      wake: async (agent, _id, text) => {
        n += 1;
        if (n === 2) throw new Error('no context');
        wakes.push([agent, text]);
      },
    },
  });
  const r = await scripts.run('alice', `const ps = [1, 2, 3].map((n) => wake_agent({ n })); const s = await Promise.allSettled(ps); return s.map((x) => x.status === 'fulfilled' ? 'ok' : x.reason.name);`);
  assert.deepEqual(r.ending, { how: 'finished', value: '["ok","WakeRefused","ok"]' });
  assert.deepEqual(wakes.map(([, text]) => /\{"n":(\d)\}$/.exec(text)?.[1]), ['1', '3']);
});

test("an abandoned turn stops a script that hadn't returned, quietly, and its pending return takes no output", async () => {
  const { scripts, wakes, called } = setup({ config: { yieldMs: LONGER_THAN_ANY_START_MS } });
  const pending = scripts.run('alice', `text('hi'); await tools.slow({});`, undefined, { watch: { turnId: 1, endTurn: false } });
  // Once its call waits, what it wrote first has been flushed.
  await called();
  scripts.turnEnded('alice', { id: 1, live: [] }, true);
  const r = await pending;
  assert.deepEqual(r.ending, { how: 'stopped', reason: 'limit', why: 'its turn ended before the script returned' });
  assert.deepEqual(wakes, []);
  // The return no one will read left the output for the next one.
  assert.equal(renderOutput((await scripts.wait('alice', r.scriptId)).output), 'hi\n');
});

test('only the newest ended scripts are kept, newest by when each ended, from each ending on', async () => {
  // Each run returns at its end: a bound no child's start reaches, however loaded the host.
  const { scripts, release } = setup({ config: { keepEnded: 2, yieldMs: LONGER_THAN_ANY_START_MS } });
  // The first started ends last, so it's among the newest ended.
  const first = await scripts.run('alice', `await tools.slow({}); return 'first';`, 0);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await scripts.run('alice', `return ${i};`)).scriptId);
  // The bound holds as each ends, before any later start.
  assert.deepEqual(scripts.list('alice').map((s) => s.scriptId), [first.scriptId, ids[1], ids[2]]);
  await release();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && scripts.running('alice') > 0;) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(scripts.list('alice').map((s) => s.scriptId).sort(), [first.scriptId, ids[2]].sort());
  await assert.rejects(scripts.wait('alice', ids[0]!), /You have no script/);
});

test('an abandoned wait leaves its yielded script running, and a later failure still wakes the agent', async () => {
  const { scripts, wakes, release } = setup({ config: { yieldMs: 200 } });
  const first = await scripts.run('alice', `await tools.slow({}); throw new Error('later');`);
  assert.equal(first.running, true);
  const waiting = scripts.wait('alice', first.scriptId, LONGER_THAN_ANY_START_MS, { turnId: 1, endTurn: false });
  scripts.turnEnded('alice', { id: 1, live: [] }, true);
  assert.equal(scripts.running('alice'), 1, 'still running');
  await release();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && scripts.running('alice') > 0;) await new Promise((r) => setTimeout(r, 10));
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]![1], /Your script failed: Error: later/);
  await waiting;
});

test("each call carries the script's origin, and the watching call's turn only while one watches", async () => {
  const contexts: unknown[] = [];
  const gates: Array<() => void> = [];
  const { scripts } = setup({
    // A bound no child's start reaches, however loaded the host: both calls come while the run watches.
    config: { yieldMs: LONGER_THAN_ANY_START_MS },
    host: {
      dispatch: async (_agent, name, args, context) => {
        contexts.push({ name, ...context });
        if (name === 'slow') await new Promise<void>((resolve) => gates.push(resolve));
        return result(`${name} ${args}`);
      },
    },
  });
  const watch = { turnId: 7, endTurn: false };
  const running = scripts.run('alice', `await tools.echo({}); await tools.slow({});`, undefined, { origin: 'origin-1', watch });
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && gates.length === 0;) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    contexts.map((c) => { const { watching: _, ...rest } = c as { watching?: unknown }; return rest; }),
    [
      { name: 'echo', origin: 'origin-1', watch, startTurnId: 7 },
      { name: 'slow', origin: 'origin-1', watch, startTurnId: 7 },
    ],
  );
  assert.equal((contexts[1] as { watching(): unknown }).watching(), watch);
  // Once the run has returned, no call watches: the call's turn is the one it was made under.
  gates[0]!();
  const r = await running;
  assert.deepEqual(r.ending, { how: 'finished' });
  assert.equal((contexts[1] as { watching(): unknown }).watching(), undefined);
  await scripts.dispose();
});

test("a script's calls carry the turn its run was made in, and what its agent had read then, under a later turn's wait too", async () => {
  const contexts: Array<{ name: string; watch?: { turnId?: number }; startTurnId?: number; startReadThrough?: unknown }> = [];
  const gates: Array<() => void> = [];
  const { scripts } = setup({
    config: { yieldMs: LONGER_THAN_ANY_START_MS },
    host: {
      dispatch: async (_agent, name, args, context) => {
        contexts.push({ name, ...context });
        if (name === 'slow') await new Promise<void>((resolve) => gates.push(resolve));
        return result(`${name} ${args}`);
      },
    },
  });
  // The run returns at once, and the script goes on; a later turn waits on it.
  const atStart = { branch: 'main', sequence: 3 };
  const run = await scripts.run('alice', `await tools.slow({}); await tools.echo({});`, 0, { watch: { turnId: 7, endTurn: false }, startReadThrough: atStart });
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && gates.length === 0;) await new Promise((r) => setTimeout(r, 10));
  const waiting = scripts.wait('alice', run.scriptId, LONGER_THAN_ANY_START_MS, { turnId: 9, endTurn: false });
  gates[0]!();
  const r = await waiting;
  assert.deepEqual(r.ending, { how: 'finished' });
  const echo = contexts.find((c) => c.name === 'echo');
  assert.equal(echo?.watch?.turnId, 9, 'the call carries the turn watching it');
  assert.equal(echo?.startTurnId, 7, 'and the turn its script was started in');
  assert.deepEqual(echo?.startReadThrough, atStart, 'and what its agent had read when it started');
  await scripts.dispose();
});

test("a script's code is read only by its own agent", async () => {
  const { scripts } = setup({ config: { yieldMs: 100 } });
  const code = `await tools.slow({ key: 'mine' });`;
  const r = await scripts.run('alice', code);
  assert.equal(scripts.codeOf('alice', r.scriptId), code);
  // Another agent's wait on it is refused, and its round can't read the code either.
  assert.equal(scripts.codeOf('bob', r.scriptId), undefined);
  assert.equal(scripts.codeOf('alice', 'no-such-script'), undefined);
  await scripts.dispose();
});

test('an agent gone, or the host stopping, stops its scripts quietly, and a gone agent keeps none', async () => {
  const { scripts, wakes } = setup({ config: { yieldMs: 100 } });
  const ended = await scripts.run('eph', `return 1;`, LONGER_THAN_ANY_START_MS);
  assert.equal(ended.running, false);
  const left = await scripts.run('eph', `await tools.slow({});`);
  await scripts.run('alice', `await tools.slow({ key: 'x' });`);
  scripts.agentGone('eph');
  // Its ended script leaves at once, its running one as it ends: no later run of
  // the agent would trim them. Neither is a later agent's of its name.
  const internals = scripts as unknown as { scripts: Map<string, { agentName: string }> };
  assert.deepEqual(scripts.list('eph'), []);
  assert.equal(scripts.running('eph'), 0);
  assert.equal([...internals.scripts.values()].filter((s) => s.agentName === 'eph').length, 1, 'the stopping one is still held');
  // While it's held, a later agent of the name can't wait on it, stop it or read its code.
  assert.equal(scripts.codeOf('eph', left.scriptId), undefined);
  await assert.rejects(scripts.wait('eph', left.scriptId, 0), (e: unknown) => e instanceof ScriptRefusal);
  await assert.rejects(scripts.stop('eph', left.scriptId), (e: unknown) => e instanceof ScriptRefusal);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && [...internals.scripts.values()].some((s) => s.agentName === 'eph');) await new Promise((r) => setTimeout(r, 10));
  assert.equal([...internals.scripts.values()].filter((s) => s.agentName === 'eph').length, 0);
  await scripts.dispose();
  assert.equal(scripts.running('alice'), 0);
  assert.deepEqual(wakes, []);
});

test('a second call on a script another call is waiting on is refused, with nothing changed', async () => {
  const { scripts, release } = setup({ config: { yieldMs: 100 } });
  const r = await scripts.run('alice', `await tools.slow({}); return 2;`);
  const waiting = scripts.wait('alice', r.scriptId, LONGER_THAN_ANY_START_MS);
  await assert.rejects(scripts.wait('alice', r.scriptId, 0), (e: unknown) => e instanceof ScriptRefusal && /Another of your calls is waiting on .* Nothing was changed\./.test(e.message));
  await assert.rejects(scripts.stop('alice', r.scriptId), /Another of your calls is waiting on/);
  await release();
  assert.deepEqual((await waiting).ending, { how: 'finished', value: '2' });
});

test('a left script that crashes wakes its agent', { timeout: 60_000 }, async () => {
  let woke!: (text: string) => void;
  const wake = new Promise<string>((resolve) => (woke = resolve));
  const { scripts } = setup({ host: { wake: async (_agent, _scriptId, text) => woke(text) } });
  const r = await scripts.run('alice', `await tools.echo({}); __crash();`, 0);
  const text = await wake;
  assert.ok(text.startsWith(`[script ${r.scriptId}] Your script crashed`), text);
  await scripts.dispose();
});

test("a left script's ending notice gives its error's name and message, and a crash's account, on one line", { timeout: 60_000 }, async () => {
  const { scripts, wakes, release } = setup();
  await scripts.run('alice', `await tools.slow({}); const e = new Error('broke\\nhere'); e.name = 'Bad\\u2028Name'; throw e;`);
  await release();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && wakes.length === 0;) await new Promise((res) => setTimeout(res, 10));
  assert.equal(wakes.length, 1);
  assert.ok(!/[\r\n\u2028]/.test(wakes[0]![1]), JSON.stringify(wakes[0]![1]));
  assert.match(wakes[0]![1], /Your script failed: Bad Name: broke here\./);
  await scripts.dispose();

  let woke!: (text: string) => void;
  const wake = new Promise<string>((resolve) => (woke = resolve));
  const crashing = setup({ host: { wake: async (_agent, _scriptId, text) => woke(text) } });
  await crashing.scripts.run('alice', `await tools.echo({}); __crash('first line\\nsecond line');`, 0);
  const text = await wake;
  assert.ok(!/[\r\n]/.test(text), JSON.stringify(text));
  assert.match(text, /Your script crashed: .*first line second line/);
  await crashing.scripts.dispose();
});

test('a left script that reaches its limit wakes its agent', { timeout: 60_000 }, async () => {
  let woke!: (text: string) => void;
  const wake = new Promise<string>((resolve) => (woke = resolve));
  const { scripts } = setup({ host: { wake: async (_agent, _scriptId, text) => woke(text) }, config: { lifetimeMs: 1_500 } });
  const r = await scripts.run('alice', `await tools.slow({});`, 0);
  const text = await wake;
  assert.ok(text.startsWith(`[script ${r.scriptId}] Your script was stopped at its limit`), text);
  await scripts.dispose();
});

test("a turn's end stop and an agent's end say why, not that a limit was reached", async () => {
  const { scripts } = setup({ host: { outlivesTurn: () => false }, config: { yieldMs: 100 } });
  const r = await scripts.run('helper', `await tools.slow({});`);
  scripts.turnEnded('helper', { id: 1, live: [] }, false);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && scripts.running('helper') > 0;) await new Promise((res) => setTimeout(res, 10));
  const { renderList } = await import('../src/code-execution/isolate/render.js');
  const listed = renderList(scripts.list('helper'), Date.now());
  assert.match(listed, new RegExp(`${r.scriptId}: stopped under a minute ago: its agent's turn ended`));
  assert.doesNotMatch(listed, /at its limit/);
});

test("a run or wait waits no longer than maxYieldMs, whatever it asks", () => {
  const { scripts } = setup({ config: { maxYieldMs: 5_000, yieldMs: 300 } });
  assert.equal(scripts.bound(60_000), 5_000);
  assert.equal(scripts.bound(undefined), 300);
  assert.equal(scripts.bound(100), 100);
});

test("a script's calls carry the turn of the call watching when each reaches the host, and a turn-ending result goes to the call watching when it comes", async () => {
  const contexts: { name: string; watch?: { turnId?: number; endTurn: boolean }; watching?: () => { turnId?: number; endTurn: boolean } | undefined }[] = [];
  let answer!: () => void;
  const held = new Promise<void>((resolve) => (answer = resolve));
  const { scripts } = setup({
    config: { yieldMs: 100 },
    host: {
      dispatch: async (_agent, name, args, context) => {
        contexts.push({ name, ...context });
        if (name === 'slow') await held;
        if (name === 'slow') {
          // The result ends the turn: it goes to whichever call watches the script now.
          const watching = context.watching?.();
          if (watching) watching.endTurn = true;
        }
        return result(`${name} ${args}`);
      },
    },
  });
  const yields = fireNextYieldAsSet(scripts, LONGER_THAN_ANY_START_MS);
  const r = await scripts.run('alice', `const p = tools.slow({}); await tools.echo({ a: 1 }); await p; await tools.echo({ b: 2 }); return 3;`, LONGER_THAN_ANY_START_MS);
  assert.deepEqual(yields, { fired: true }, 'the run yielded as its timer was set');
  assert.equal(r.running, true);
  const first = { turnId: 1, endTurn: false };
  const firstWait = scripts.wait('alice', r.scriptId, LONGER_THAN_ANY_START_MS, first);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && contexts.length < 2;) await new Promise((res) => setTimeout(res, 10));
  // Its turn is abandoned, and the script is left running with its slow call held.
  scripts.turnEnded('alice', { id: 1, live: [] }, true);
  // A later wait, in a later turn: the call made under it carries its turn, and the held result ends it.
  const second = { turnId: 2, endTurn: false };
  const waiting = scripts.wait('alice', r.scriptId, LONGER_THAN_ANY_START_MS, second);
  answer();
  const done = await waiting;
  assert.deepEqual(done.ending, { how: 'finished', value: '3' });
  assert.equal(second.endTurn, true, 'the wait watching when the result came ends its turn');
  assert.equal(first.endTurn, false);
  assert.deepEqual(contexts.filter((c) => c.name === 'echo').map((c) => c.watch?.turnId), [1, 2]);
  await firstWait;
});

test("the host's places come back as children exit, a launch that fails included", async () => {
  const capacity = new ChildCapacity(2);
  const { scripts } = setup({ config: { yieldMs: LONGER_THAN_ANY_START_MS } });
  const scriptsWith = new AgentScripts(
    { tools: () => [], dispatch: async () => result(''), wake: async () => {}, outlivesTurn: () => true },
    { ...(scripts as unknown as { config: ScriptsConfig }).config },
    capacity,
  );
  made.push(scriptsWith);
  await scriptsWith.run('alice', 'return 1;');
  await scriptsWith.run('alice', 'return 2;');
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && capacity.running > 0;) await new Promise((r) => setTimeout(r, 10));
  assert.equal(capacity.running, 0, 'both places back once the children exited');
  const failing = new AgentScripts(
    { tools: () => [], dispatch: async () => result(''), wake: async () => {}, outlivesTurn: () => true },
    { ...(scripts as unknown as { config: ScriptsConfig }).config, execPath: '/nonexistent/runtime-for-a-test' },
    capacity,
  );
  made.push(failing);
  const r = await failing.run('alice', 'return 1;');
  assert.equal(r.ending?.how, 'crashed');
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && capacity.running > 0;) await new Promise((r2) => setTimeout(r2, 10));
  assert.equal(capacity.running, 0, 'a launch that failed gives its place back');
});

test("a finished script whose child hasn't exited keeps its place in the host until the child exits", async () => {
  const capacity = new ChildCapacity(1);
  const { scripts } = setup({ config: { childEntry: LINGERING_CHILD, stopGraceMs: NEVER_FIRES_IN_A_TEST_MS, yieldMs: LONGER_THAN_ANY_START_MS } });
  const lingering = new AgentScripts(
    { tools: () => [], dispatch: async () => result(''), wake: async () => {}, outlivesTurn: () => true },
    { ...(scripts as unknown as { config: ScriptsConfig }).config },
    capacity,
  );
  made.push(lingering);
  const r = await lingering.run('alice', 'return 1;');
  assert.deepEqual(r.ending, { how: 'finished', value: '1' });
  assert.equal(capacity.running, 1, 'its child is alive, so its place is still taken');
  const disposed = await Promise.race([lingering.dispose().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), LONGER_THAN_ANY_START_MS).unref())]);
  assert.equal(disposed, true, 'dispose ended its child');
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && capacity.running > 0;) await new Promise((res) => setTimeout(res, 10));
  assert.equal(capacity.running, 0, 'the place comes back once the child has exited');
});

test('a script that ends at its start, before it is in the map, still leaves the ended scripts at their bound', async () => {
  // A runtime path Node's spawn refuses at once: the run crashes inside start().
  const { scripts } = setup({ config: { keepEnded: 1, execPath: 'node\0not-a-path' } });
  const first = await scripts.run('alice', 'return 1;');
  const second = await scripts.run('alice', 'return 2;');
  assert.deepEqual([first.ending?.how, second.ending?.how], ['crashed', 'crashed']);
  assert.deepEqual(scripts.list('alice').map((s) => s.scriptId), [second.scriptId]);
});

test('a tool list that throws refuses the run with nothing taken, and the host still stops', async () => {
  let fail = true;
  const { scripts } = setup({
    capacity: 1,
    // Long enough that run() returns the ending, however slowly the child starts.
    config: { yieldMs: LONGER_THAN_ANY_START_MS },
    host: { tools: () => { if (fail) throw new Error('a module listed nothing'); return [{ name: 'echo', description: 'Echoes.' }]; } },
  });
  await assert.rejects(scripts.run('alice', `return 1;`), (e: unknown) => e instanceof ScriptRefusal && /The script's tools couldn't be listed: a module listed nothing\. Nothing was run\./.test(e.message));
  // The host's one place is still free.
  fail = false;
  const r = await scripts.run('alice', `return 2;`);
  assert.deepEqual(r.ending, { how: 'finished', value: '2' });
  await scripts.dispose();
});

/** A host whose delivery of the script's 'working' wake waits until `deliver` is called. */
function heldWake() {
  const wakes: string[] = [];
  const state = { entered: false };
  let deliver!: () => void;
  const delivered = new Promise<void>((resolve) => (deliver = resolve));
  const wake = async (_agent: string, _id: string, text: string) => {
    if (text.includes('working')) {
      state.entered = true;
      await delivered;
    }
    wakes.push(text);
  };
  return { wakes, state, deliver: () => deliver(), wake };
}

// It wakes its agent and spins. A wake's call is answered once the wake is
// delivered, and a script that returns waits for its calls, so only an ending
// that doesn't wait, such as its limit, can come while the wake is delivered.
const WAKE_THEN_SPIN = `wake_agent('working'); for (;;) __tick();`;
type Internals = { scripts: Map<string, { run: { stop(reason: 'limit', why?: string): Promise<unknown> } }> };

test("a left script's ending reaches its agent after a wake it sent that was still being delivered", async () => {
  const held = heldWake();
  const { scripts } = setup({ config: { yieldMs: 0 }, host: { wake: held.wake } });
  const r = await scripts.run('alice', WAKE_THEN_SPIN);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !held.state.entered;) await new Promise((res) => setTimeout(res, 10));
  assert.equal(held.state.entered, true, 'the wake is being delivered');
  // Its limit stops it while the wake is still being delivered.
  await (scripts as unknown as Internals).scripts.get(r.scriptId)!.run.stop('limit');
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(held.wakes, [], 'the ending waits for the wake');
  held.deliver();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && held.wakes.length < 2;) await new Promise((res) => setTimeout(res, 10));
  assert.match(held.wakes[0]!, /working/);
  assert.match(held.wakes[1]!, /was stopped at its limit/);
});

test("a left script's ending that a wait has returned isn't sent again as a notice", async () => {
  const held = heldWake();
  const { scripts } = setup({ config: { yieldMs: 0 }, host: { wake: held.wake } });
  const r = await scripts.run('alice', WAKE_THEN_SPIN);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !held.state.entered;) await new Promise((res) => setTimeout(res, 10));
  await (scripts as unknown as Internals).scripts.get(r.scriptId)!.run.stop('limit');
  // The agent waits on it while its notice waits for the wake's delivery, and gets the ending there.
  const waited = await scripts.wait('alice', r.scriptId, LONGER_THAN_ANY_START_MS);
  assert.equal(waited.ending?.how, 'stopped');
  held.deliver();
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(held.wakes.length, 1);
  assert.match(held.wakes[0]!, /working/);
});

test('the ended scripts kept are those whose endings came last, though the clock says otherwise', async (t) => {
  // A clock that doesn't move: endings in the same millisecond, or a clock stepped back.
  t.mock.method(Date, 'now', () => 1_000_000);
  const { scripts, release } = setup({ config: { keepEnded: 1, yieldMs: LONGER_THAN_ANY_START_MS } });
  // The first started ends last.
  const first = await scripts.run('alice', `await tools.slow({}); return 'first';`, 0);
  const second = await scripts.run('alice', `return 'second';`);
  assert.deepEqual(scripts.list('alice').map((s) => s.scriptId), [first.scriptId, second.scriptId]);
  await release();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && scripts.running('alice') > 0;) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(scripts.list('alice').map((s) => s.scriptId), [first.scriptId]);
});

test("dispose ends a child that said how its script ended and stayed", async () => {
  const { scripts } = setup({ config: { childEntry: LINGERING_CHILD, stopGraceMs: NEVER_FIRES_IN_A_TEST_MS, yieldMs: LONGER_THAN_ANY_START_MS } });
  const r = await scripts.run('alice', `return 1;`);
  assert.deepEqual(r.ending, { how: 'finished', value: '1' });
  // Its child hasn't exited, and nothing has ended it: dispose must.
  const disposed = await Promise.race([scripts.dispose().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), LONGER_THAN_ANY_START_MS).unref())]);
  assert.equal(disposed, true);
});

test("a left script's failure wakes its agent with a glimpse of a long message, and no count a second cut would misstate", async () => {
  const { scripts, wakes, release } = setup();
  // It yields on the call first, so it's left running when it fails.
  const r = await scripts.run('alice', `await tools.slow({ key: 'g' }); throw new Error('w'.repeat(20000));`);
  assert.equal(r.running, true);
  await release('g');
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && wakes.length === 0;) await new Promise((res) => setTimeout(res, 10));
  assert.equal(wakes.length, 1, `${r.scriptId} woke its agent`);
  assert.match(wakes[0]![1], /Your script failed: Error: w{300}…/);
  assert.doesNotMatch(wakes[0]![1], /dropped here/);
});

test("turns that overlap: a turn's end stops a non-primary agent's scripts whose turn isn't live, and those started in none", async () => {
  const { scripts } = setup({ host: { outlivesTurn: () => false }, config: { yieldMs: 0, maxRunning: 6 } });
  const start = async (turnId: number | undefined) =>
    (await scripts.run('helper', `await tools.slow({});`, 0, { watch: { ...(turnId === undefined ? {} : { turnId }), endTurn: false } })).scriptId;
  const running = (id: string) => scripts.list('helper').find((x) => x.scriptId === id)!.running;
  // Those a turn's end stops have ended once their stops land; the rest were never stopped.
  const ended = async (...ids: string[]) => {
    for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && ids.some(running);) await new Promise((res) => setTimeout(res, 10));
  };
  const older = await start(3);
  const open = await start(5);
  const silent = await start(7);
  const newer = await start(9);
  // The silent turn 7 ends while turn 5 is open and turn 9's start is in progress: 3's and 7's scripts end.
  scripts.turnEnded('helper', { id: 7, live: [5, 9] }, false);
  await ended(older, silent);
  assert.deepEqual([older, open, silent, newer].map(running), [false, true, false, true]);
  // A stale settle of turn 4 leaves the live turns' scripts alone.
  scripts.turnEnded('helper', { id: 4, live: [5, 9] }, false);
  assert.deepEqual([open, newer].map(running), [true, true]);
  // Turn 5 closes: its script ends; 9's lives on while its turn does.
  scripts.turnEnded('helper', { id: 5, live: [9] }, false);
  await ended(open);
  assert.deepEqual([open, newer].map(running), [false, true]);
  // A script started in no turn ends at any turn's end, and every turn's end takes the rest.
  const none = await start(undefined);
  scripts.turnEnded('helper', { id: 1, live: [9] }, false);
  await ended(none);
  assert.deepEqual([none, newer].map(running), [false, true]);
  scripts.turnEnded('helper', 'every', false);
  await ended(newer);
  assert.equal(running(newer), false);
  // A newer turn's script isn't kept for being newer: an older turn's end with
  // no turn live stops it.
  const later = await start(12);
  scripts.turnEnded('helper', { id: 4, live: [] }, false);
  await ended(later);
  assert.equal(running(later), false);
});

test("an abandoned turn stops a non-primary agent's script its calls watch that never returned, though the turn is live, and lets go of one that did", async () => {
  const { scripts, release, called, watching } = setup({ host: { outlivesTurn: () => false }, config: { maxRunning: 6 } });
  // Its run call is still waiting on it: the script hasn't returned.
  const pending = scripts.run('helper', `await tools.slow({ key: 'u' });`, LONGER_THAN_ANY_START_MS, { watch: { turnId: 5, endTurn: false } });
  // This one returned at once, and a wait of the same turn watches it now.
  const returned = await scripts.run('helper', `await tools.slow({ key: 'r' });`, 0, { watch: { turnId: 5, endTurn: false } });
  const waiting = scripts.wait('helper', returned.scriptId, LONGER_THAN_ANY_START_MS, { turnId: 5, endTurn: false });
  await called('u');
  await called('r');
  // Turn 5's stream is abandoned and will run again: the turn stays live.
  scripts.turnEnded('helper', { id: 5, live: [5] }, true, 'stream error');
  assert.deepEqual((await pending).ending, { how: 'stopped', reason: 'limit', why: 'its turn ended before the script returned (stream error)' });
  assert.equal(watching('r'), undefined, 'the returned one is let go: its call sees no one watching');
  assert.equal(scripts.list('helper').find((x) => x.scriptId === returned.scriptId)!.running, true, 'and runs on while its turn is live');
  await release('r');
  await waiting;
});

test("every turn of a primary agent's abandoned at once: a watched script that never returned stops, and one that did is let go", async () => {
  const { scripts, release, called, watching } = setup({ config: { maxRunning: 6 } });
  const pending = scripts.run('alice', `await tools.slow({ key: 'u' });`, LONGER_THAN_ANY_START_MS, { watch: { turnId: 2, endTurn: false } });
  const returned = await scripts.run('alice', `await tools.slow({ key: 'r' });`, 0, { watch: { turnId: 3, endTurn: false } });
  const waiting = scripts.wait('alice', returned.scriptId, LONGER_THAN_ANY_START_MS, { turnId: 3, endTurn: false });
  await called('r');
  scripts.turnEnded('alice', 'every', true, 'turn abandoned by quiesce');
  assert.equal((await pending).ending?.how, 'stopped');
  assert.equal(watching('r'), undefined, 'the returned one is let go: its call sees no one watching');
  assert.equal(scripts.list('alice').find((x) => x.scriptId === returned.scriptId)!.running, true, "a primary agent's script outlives its turns");
  await release('r');
  await waiting;
});

test("an abandoned turn acts only on the scripts its own calls watch", async () => {
  const { scripts, release, called, watching } = setup({ config: { yieldMs: 0 } });
  const watched = async (turnId: number) =>
    (await scripts.run('alice', `await tools.slow({ key: 'k${turnId}' });`, 0, { watch: { turnId, endTurn: false } })).scriptId;
  const byOpen = await watched(5);
  const bySilent = await watched(7);
  const running = (id: string) => scripts.list('alice').find((x) => x.scriptId === id)!.running;
  // The waits that watch them: each script's run returned once, so an abandoned watch is let go, not stopped.
  const waits = [scripts.wait('alice', byOpen, LONGER_THAN_ANY_START_MS, { turnId: 5, endTurn: false }), scripts.wait('alice', bySilent, LONGER_THAN_ANY_START_MS, { turnId: 7, endTurn: false })];
  await called('k5');
  await called('k7');
  scripts.turnEnded('alice', { id: 7, live: [5] }, true);
  assert.equal(watching('k7'), undefined, "turn 7's watch is let go: its script's call sees no one watching");
  assert.equal(watching('k5')?.turnId, 5, "turn 5's watch stands");
  assert.deepEqual([byOpen, bySilent].map(running), [true, true]);
  await release('k5');
  await release('k7');
  await Promise.all(waits);
});

test("a wait whose turn was abandoned takes the ending to no one, so the ending's notice still goes out", async () => {
  const held = heldWake();
  const { scripts } = setup({ config: { yieldMs: 0 }, host: { wake: held.wake } });
  const r = await scripts.run('alice', WAKE_THEN_SPIN, 0);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !held.state.entered;) await new Promise((res) => setTimeout(res, 10));
  const waiting = scripts.wait('alice', r.scriptId, LONGER_THAN_ANY_START_MS, { turnId: 1, endTurn: false });
  // The wait's turn is abandoned: the script had returned once, so its watch is let go.
  scripts.turnEnded('alice', { id: 1, live: [] }, true);
  await (scripts as unknown as Internals).scripts.get(r.scriptId)!.run.stop('limit');
  assert.equal((await waiting).ending?.how, 'stopped');
  held.deliver();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && held.wakes.length < 2;) await new Promise((res) => setTimeout(res, 10));
  assert.match(held.wakes[1]!, /was stopped at its limit/);
});

test("a stop watches the script with its own call's watch: a call in flight sees it as the one watching", async () => {
  let context: ScriptCallContext | undefined;
  const { scripts } = setup({
    config: { yieldMs: 0 },
    host: { dispatch: async (_agent, _name, _args, ctx) => { context = ctx; return new Promise(() => {}); } },
  });
  const r = await scripts.run('alice', `await tools.slow({});`, 0);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !context;) await new Promise((res) => setTimeout(res, 10));
  const watch = { turnId: 9, endTurn: false };
  const stopping = scripts.stop('alice', r.scriptId, watch);
  // A turn-ending result arriving now would mark the stop's watch, and so end the stop's turn.
  assert.equal(context!.watching?.(), watch);
  await stopping;
});

test("a wait started on an ended script takes its ending at once, so a notice whose turn comes before the wait returns doesn't repeat it", async () => {
  const held = heldWake();
  const { scripts } = setup({ config: { yieldMs: 0 }, host: { wake: held.wake } });
  const r = await scripts.run('alice', WAKE_THEN_SPIN, 0);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !held.state.entered;) await new Promise((res) => setTimeout(res, 10));
  const internals = scripts as unknown as { scripts: Map<string, { run: { stop(reason: 'limit'): Promise<unknown> }; delivering: Promise<void> | null }> };
  // A reaction to the delivery, ordered before the notice's: it starts the
  // wait, and the notice runs before the wait's own continuation does.
  let waiting: Promise<unknown> | undefined;
  void internals.scripts.get(r.scriptId)!.delivering!.then(() => { waiting = scripts.wait('alice', r.scriptId, LONGER_THAN_ANY_START_MS); });
  await internals.scripts.get(r.scriptId)!.run.stop('limit');
  held.deliver();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !waiting;) await new Promise((res) => setTimeout(res, 10));
  assert.ok(waiting, 'the wait started, before the notice ran');
  await waiting;
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(held.wakes.length, 1, 'only the script\'s own wake, and no notice');
});

test("a stop started on an ended script takes its ending at once, so a notice whose turn comes before the stop returns doesn't repeat it", async () => {
  const held = heldWake();
  const { scripts } = setup({ config: { yieldMs: 0 }, host: { wake: held.wake } });
  const r = await scripts.run('alice', WAKE_THEN_SPIN, 0);
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !held.state.entered;) await new Promise((res) => setTimeout(res, 10));
  const internals = scripts as unknown as { scripts: Map<string, { run: { stop(reason: 'limit'): Promise<unknown> }; delivering: Promise<void> | null }> };
  // A reaction to the delivery, ordered before the notice's: it starts the
  // stop, whose own stop of the ended run yields before the notice runs.
  let stopping: Promise<{ ending: { how: string } | null }> | undefined;
  void internals.scripts.get(r.scriptId)!.delivering!.then(() => { stopping = scripts.stop('alice', r.scriptId); });
  await internals.scripts.get(r.scriptId)!.run.stop('limit');
  held.deliver();
  for (const end = Date.now() + LONGER_THAN_ANY_START_MS; Date.now() < end && !stopping;) await new Promise((res) => setTimeout(res, 10));
  assert.ok(stopping, 'the stop started, before the notice ran');
  assert.equal((await stopping).ending?.how, 'stopped');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(held.wakes.length, 1, 'only the script\'s own wake, and no notice');
});
