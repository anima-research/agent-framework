import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, ShutdownTimeoutError, type Module, type ProcessEvent, type ToolCall } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type Verb = 'start()' | 'addModule()';

const STOPPING = (verb: Verb) => `${verb} refused: the framework is stopping`;
const STOPPED = (verb: Verb) =>
  `${verb} refused: this framework has stopped, and a stopped framework doesn't start again. ` +
  'Create a new AgentFramework on its store to go on, with its storePath if it opened the store itself.';
const STOP_FAILED = (verb: Verb) =>
  `${verb} refused: this framework's stop() failed, and a stopped framework doesn't start again. ` +
  'A failed stop() may have left its cleanup or final persistence unfinished. ' +
  "Call stop() again: once a stop() of this one resolves, they're done, and only then should a new " +
  'AgentFramework use its store, with its storePath if this one opened the store itself, ' +
  'or another instance use anything this one shares.';
const STOP_FAILED_CLOSED = (verb: Verb, failure: string) =>
  `${verb} refused: this framework's stop() failed and its owned store is closed, so stop() can't be tried again: ` +
  `it rejects with that same failure, this error's cause: ${failure}. ` +
  "A stopped framework doesn't start again, and a new AgentFramework on its store doesn't finish what that stop() left unfinished.";

type Internals = { running: boolean; loopPromise: Promise<void> | null; mcplPrefixMap: Map<string, string> };
const internals = (framework: AgentFramework) => framework as unknown as Internals;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface ModuleOptions {
  stop?: () => Promise<void>;
  onProcess?: (event: ProcessEvent) => Promise<void>;
  tool?: (call: ToolCall) => void;
}

function module(name: string, started: string[] = [], opts: ModuleOptions = {}): Module {
  return {
    name,
    async start() { started.push(name); },
    stop: opts.stop ?? (async () => {}),
    async onProcess(event) {
      await opts.onProcess?.(event);
      return opts.tool && event.type === 'external-message'
        ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'act' }] }], requestInference: true }
        : {};
    },
    getTools: () => opts.tool ? [{ name: 'act', description: 'acts', inputSchema: { type: 'object', properties: {} } }] : [],
    async handleToolCall(call) {
      if (!opts.tool) throw new Error('No tool calls expected');
      opts.tool(call);
      return { success: true, data: 'acted' };
    },
  };
}

interface Fixture { framework: AgentFramework; store: JsStore; dir: string; membrane: MockMembrane }

async function fixture(t: TestContext, options: { modules?: Module[]; owned?: boolean; agent?: boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'stop-ends-its-instance-'));
  const membrane = new MockMembrane();
  const borrowed = options.owned ? undefined : JsStore.openOrCreate({ path: join(dir, 'store') });
  const framework = await AgentFramework.create({
    ...(borrowed ? { store: borrowed } : { storePath: join(dir, 'store') }),
    membrane: membrane.asMembrane(),
    agents: options.agent ? [{ name: 'assistant', model: 'test', systemPrompt: 'system' }] : [],
    modules: options.modules ?? [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const store = framework.getStore();
  t.after(async () => {
    await framework.stop().catch(() => {});
    try { if (!store.isClosed()) store.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return { framework, store, dir, membrane };
}

/** start()'s refusal, or a failure naming what start() did instead. */
function startRefusal(framework: AgentFramework): unknown {
  try { framework.start(); } catch (error) { return error; }
  return new Error('start() returned');
}

async function assertRefused(framework: AgentFramework, text: (verb: Verb) => string): Promise<void> {
  const loop = internals(framework).loopPromise;
  const started: string[] = [];
  const refused = startRefusal(framework);
  assert.ok(refused instanceof Error, String(refused));
  assert.equal(refused.message, text('start()'));
  assert.equal(internals(framework).running, false, 'no lifecycle began');
  assert.equal(internals(framework).loopPromise, loop, 'no loop was started');
  await assert.rejects(framework.addModule(module('late', started)), { message: text('addModule()') });
  internals(framework).mcplPrefixMap.set('colliding', 'zz-server');
  await assert.rejects(framework.addModule(module('colliding', started)), { message: text('addModule()') },
    'a name a server prefix holds gets the same refusal, not the collision');
  assert.deepEqual(started, [], 'the refused modules never started');
  assert.equal(framework.getModule('late'), null, 'the refused module is not registered');
}

test('after a completed stop(), start() and addModule() are refused, and stop() stays settled without tearing down again', { timeout: 30_000 }, async (t) => {
  let stops = 0;
  const { framework } = await fixture(t, { modules: [module('counted', [], { stop: async () => { stops++; } })] });
  framework.start();
  const stopped = framework.stop();
  await stopped;
  await assertRefused(framework, STOPPED);
  await assertRefused(framework, STOPPED);
  assert.equal(framework.stop(), stopped, 'stop() returns the settled stop');
  await framework.stop();
  assert.equal(stops, 1, 'the teardown ran once');
});

test('a stop() of a framework never started ends it too, with an owned store as with a borrowed one', { timeout: 30_000 }, async (t) => {
  for (const owned of [true, false]) {
    const { framework } = await fixture(t, { owned });
    await framework.stop();
    await assertRefused(framework, STOPPED);
  }
});

test('after a failed stop(), start() and addModule() are refused, through each retry, until one resolves and then for good', { timeout: 30_000 }, async (t) => {
  const failure = new Error('injected module stop failure');
  let calls = 0;
  const lastAttempt = deferred();
  const lastAttemptCalled = deferred();
  const { framework, store } = await fixture(t, { modules: [module('flaky', [], {
    stop: async () => {
      calls++;
      if (calls <= 2) throw failure;
      lastAttemptCalled.resolve();
      await lastAttempt.promise;
    },
  })] });
  framework.start();
  try {
    await assert.rejects(framework.stop(), (error) => error === failure);
    await assertRefused(framework, STOP_FAILED);
    await assert.rejects(framework.stop(), (error) => error === failure);
    await assertRefused(framework, STOP_FAILED);
    const retry = framework.stop();
    await lastAttemptCalled.promise;
    await assertRefused(framework, STOPPING);
    lastAttempt.resolve();
    await retry;
    await assertRefused(framework, STOPPED);
    assert.equal(store.isClosed(), false, 'a borrowed store stays open');
  } finally {
    lastAttempt.resolve();
  }
});

test('after a stop() whose wait on the event loop timed out, start() is refused, and the retry waits for that loop before it resolves', { timeout: 30_000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  const { framework } = await fixture(t, { modules: [module('busy', [], {
    onProcess: async (event) => {
      if (event.type !== 'module-event') return;
      entered.resolve();
      await release.promise;
    },
  })] });
  framework.start();
  try {
    framework.pushEvent({ type: 'module-event', source: 'busy', eventType: 'hold', payload: null } as ProcessEvent);
    await entered.promise;
    await assert.rejects(framework.stop(20), (error) => error instanceof ShutdownTimeoutError && error.pending.includes('event loop'));
    await assertRefused(framework, STOP_FAILED);
    let settled = false;
    const retry = framework.stop().finally(() => { settled = true; });
    await new Promise<void>((done) => setTimeout(done, 50));
    assert.equal(settled, false, 'the retry waits for the loop the timed-out stop left running');
    release.resolve();
    await retry;
    await assertRefused(framework, STOPPED);
  } finally {
    release.resolve();
  }
});

test("after a failed stop() that closed its owned store, the refusal carries that stop's failure, which stop() rejects with again", { timeout: 30_000 }, async (t) => {
  const { framework, store } = await fixture(t, { owned: true });
  const failure = new Error('injected final sync failure');
  store.sync = () => { throw failure; };
  await assert.rejects(framework.stop(), (error) => error === failure);
  assert.equal(store.isClosed(), true);
  for (const verb of ['start()', 'addModule()'] as const) {
    const refusal = verb === 'start()' ? startRefusal(framework) : await framework.addModule(module('late')).then(() => new Error('addModule() resolved'), (error: unknown) => error);
    assert.ok(refusal instanceof Error, String(refusal));
    assert.equal(refusal.message, STOP_FAILED_CLOSED(verb, failure.message));
    assert.equal(refusal.cause, failure);
  }
  await assert.rejects(framework.stop(), (error) => error === failure);
});

test('a stop() whose budget is refused leaves the lifecycle as it was: a running framework still adds modules, and one never started starts', { timeout: 30_000 }, async (t) => {
  const running = await fixture(t);
  running.framework.start();
  await assert.rejects(running.framework.stop(0), RangeError);
  const started: string[] = [];
  await running.framework.addModule(module('after-refused-stop', started));
  assert.deepEqual(started, ['after-refused-stop']);
  assert.equal(internals(running.framework).running, true);
  await running.framework.stop();

  const fresh = await fixture(t);
  await assert.rejects(fresh.framework.stop(-1), RangeError);
  fresh.framework.start();
  assert.equal(internals(fresh.framework).running, true, 'start() began the first lifecycle');
});

test("a new AgentFramework on a stopped one's borrowed store takes an event and runs a tool call", { timeout: 30_000 }, async (t) => {
  const old = await fixture(t, { agent: true, modules: [module('probe', [], { tool: () => {} })] });
  old.framework.start();
  await old.framework.stop();

  const acted: string[] = [];
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call-1', name: 'probe--act', input: {} }], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
  const next = await AgentFramework.create({
    store: old.store, membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system' }],
    modules: [module('probe', [], { tool: (call) => { acted.push(call.id); } })],
    syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  t.after(() => next.stop().catch(() => {}));
  const completed = new Promise<void>((done) => {
    next.onTrace((event) => {
      if (event.type === 'inference:completed' && (event as { agentName?: string }).agentName === 'assistant') done();
    });
  });
  next.start();
  next.pushEvent({ type: 'external-message', source: 'probe', content: 'hello', metadata: {} } as ProcessEvent);
  await completed;
  assert.deepEqual(acted, ['call-1'], 'the tool ran');
  assert.equal(membrane.lastStream?.receivedToolResults.length, 1, "the tool's result went back to the model");
  await next.stop();
});

test('a turn runUntilIdle() began before the first start() goes on when start() comes', { timeout: 30_000 }, async (t) => {
  const entered = deferred();
  const released = deferred();
  let gathers = 0;
  const holder: Module = {
    ...module('holder'),
    contextTimeoutMs: 20_000,
    async gatherContext() {
      if (++gathers === 1) { entered.resolve(); await released.promise; }
      return [];
    },
    async onProcess(event) {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'hello' }] }], requestInference: true }
        : {};
    },
  };
  const { framework, membrane } = await fixture(t, { agent: true, modules: [holder] });
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
  framework.pushEvent({ type: 'external-message', source: 'holder', content: 'hello', metadata: {} } as ProcessEvent);
  const idle = framework.runUntilIdle();
  await entered.promise;
  framework.start();
  released.resolve();
  await Promise.race([idle, new Promise((done) => setTimeout(done, 10_000))]);
  assert.equal(membrane.calls.length, 1, 'the turn reached the model');
});
