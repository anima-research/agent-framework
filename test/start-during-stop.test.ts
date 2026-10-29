/**
 * start() and addModule() made while a stop() is still running are refused
 * (#315's in-flight half). Before, a start() then left the stop waiting on
 * the new lifecycle's loop, for good with no budget, or let the stop tear
 * down modules and an owned store under a loop that no later stop() could
 * end; a module added after the stop took its list of modules stayed started
 * past it. Once the stop has settled, both stay refused, with another text
 * (stop-ends-its-instance.test.ts). A stop() admitted while an addModule()'s
 * start() runs stops that module once its start() has settled, and refuses
 * the addModule() then (#882). Each test waits on the event it needs (a
 * module's stop() being called), not on a fixed delay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Module } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

type Internals = { running: boolean; loopPromise: Promise<void> | null; moduleRegistry: { modules: Map<string, Module> } };

function module(name: string, hooks: { start?: Module['start']; stop?: Module['stop'] } = {}): Module {
  return {
    name,
    start: hooks.start ?? (async () => {}),
    stop: hooks.stop ?? (async () => {}),
    async onProcess() { return {}; },
    getTools: () => [],
    async handleToolCall() { throw new Error('No tool calls expected'); },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A module whose stop() says when it has been called and waits for the test. */
function slowToStop() {
  const called = deferred();
  const release = deferred();
  return { called, release, module: module('slow', { stop: async () => { called.resolve(); await release.promise; } }) };
}

async function fixture(t: import('node:test').TestContext, modules: Module[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'start-during-stop-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [], modules, syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internals = framework as unknown as Internals;
  const own = framework.getStore();
  t.after(async () => {
    // Where a refusal is missing, a second loop can still be running, and a
    // stop waiting on it: end both before the store goes.
    internals.running = false;
    await framework.stop().catch(() => {});
    await internals.loopPromise?.catch(() => {});
    try { if (!own.isClosed()) own.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return { framework, internals };
}

test('a start() made right after stop() is refused, and that stop settles with its loop ended', { timeout: 30_000 }, async (t) => {
  const { framework, internals } = await fixture(t);
  framework.start();
  const loop = internals.loopPromise!;
  let loopEnded = false;
  void loop.then(() => { loopEnded = true; });
  const stopping = framework.stop();
  assert.throws(() => framework.start(), { message: 'start() refused: the framework is stopping' });
  await stopping;
  assert.equal(loopEnded, true, 'the loop had ended when the stop settled');
  assert.equal(internals.running, false);
  assert.equal(internals.loopPromise, loop, 'no second loop was started');
});

test("a start() or addModule() made in stop()'s first synchronous steps is refused too", { timeout: 30_000 }, async (t) => {
  // stop() claims its attempt, then runs steps that can emit traces, the push
  // coalescer's suspend() first, before it clears running. A stand-in for the
  // coalescer calls start() and addModule() there, as a trace listener could.
  const { framework, internals } = await fixture(t);
  framework.start();
  let refusal: unknown = 'start() was never called';
  let adding: Promise<unknown> | undefined;
  const started: string[] = [];
  (framework as unknown as { pushCoalescer: { suspend(): void } }).pushCoalescer = {
    suspend: () => {
      try { framework.start(); refusal = 'start() returned'; } catch (error) { refusal = error; }
      adding = framework.addModule(module('late', { start: async () => { started.push('late'); } }))
        .then(() => 'addModule() resolved', (error: unknown) => error);
    },
  };
  await framework.stop();
  assert.ok(refusal instanceof Error && refusal.message === 'start() refused: the framework is stopping', String(refusal));
  const addRefusal = await adding;
  assert.ok(addRefusal instanceof Error && addRefusal.message === 'addModule() refused: the framework is stopping', String(addRefusal));
  assert.deepEqual(started, []);
  assert.equal(internals.running, false);
});

test('a start() on a running framework does nothing', { timeout: 30_000 }, async (t) => {
  const { framework, internals } = await fixture(t);
  framework.start();
  const loop = internals.loopPromise;
  framework.start();
  assert.equal(internals.loopPromise, loop, 'no second loop was started');
  await framework.stop();
});

test("a start() made while a module's stop() runs is refused, and no loop outlives that stop", { timeout: 30_000 }, async (t) => {
  const slow = slowToStop();
  const { framework, internals } = await fixture(t, [slow.module]);
  framework.start();
  const loop = internals.loopPromise!;
  let loopEnded = false;
  void loop.then(() => { loopEnded = true; });
  const stopping = framework.stop();
  try {
    await slow.called.promise;
    assert.throws(() => framework.start(), { message: 'start() refused: the framework is stopping' });
  } finally {
    slow.release.resolve();
  }
  await stopping;
  assert.equal(loopEnded, true, 'the loop had ended when the stop settled');
  assert.equal(internals.running, false);
  assert.equal(internals.loopPromise, loop, 'no second loop was started');
  assert.equal(framework.getStore().isClosed(), true, 'the stop closed the store it owns, with nothing running over it');
});

test("an addModule() made while a module's stop() runs is refused, and its module never starts", { timeout: 30_000 }, async (t) => {
  const slow = slowToStop();
  const { framework, internals } = await fixture(t, [slow.module]);
  framework.start();
  const stopping = framework.stop();
  const started: string[] = [];
  try {
    await slow.called.promise;
    await assert.rejects(
      framework.addModule(module('late', { start: async () => { started.push('late'); } })),
      { message: 'addModule() refused: the framework is stopping' },
    );
  } finally {
    slow.release.resolve();
  }
  await stopping;
  assert.deepEqual(started, []);
  assert.equal(internals.moduleRegistry.modules.has('late'), false);
});

test("a module whose start() is still running when stop() begins is stopped only after its start() returns, so its stop() ends what its start() set up", { timeout: 30_000 }, async (t) => {
  const reached = deferred();
  const { framework } = await fixture(t, [module('first', { stop: async () => { reached.resolve(); } })]);
  framework.start();
  const order: string[] = [];
  const entered = deferred();
  const release = deferred();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const adding = framework.addModule(module('late', {
    start: async () => {
      order.push('start entered');
      entered.resolve();
      await release.promise;
      timer = setTimeout(() => { fired = true; }, 0);
      order.push('start returned');
    },
    stop: async () => { order.push('stop called'); clearTimeout(timer); },
  })).catch(() => {});
  await entered.promise;
  const stopping = framework.stop();
  await reached.promise;
  release.resolve();
  await stopping;
  await adding;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['start entered', 'start returned', 'stop called']);
  assert.equal(fired, false, 'the timer its start() set was cleared by its stop()');
});

test("an addModule() whose start() is still running when a stop() is admitted is refused once its start() returns, with no module:added", { timeout: 30_000 }, async (t) => {
  const reached = deferred();
  const { framework, internals } = await fixture(t, [module('first', { stop: async () => { reached.resolve(); } })]);
  framework.start();
  const added: string[] = [];
  framework.onTrace((event) => { if (event.type === 'module:added') added.push(event.moduleName); });
  const entered = deferred();
  const release = deferred();
  const adding = framework.addModule(module('late', { start: async () => { entered.resolve(); await release.promise; } }))
    .then(() => 'addModule() resolved', (error: unknown) => error);
  await entered.promise;
  const stopping = framework.stop();
  await reached.promise;
  release.resolve();
  const outcome = await adding;
  await stopping;
  assert.ok(outcome instanceof Error && outcome.message.startsWith('addModule() refused: '), String(outcome));
  assert.deepEqual(added, []);
  assert.equal(internals.moduleRegistry.modules.has('late'), false);
});

test("a removeModule() made while the module's start() runs stops it only after its start() returns, and the module is announced added, then removed", { timeout: 30_000 }, async (t) => {
  const { framework, internals } = await fixture(t);
  framework.start();
  const order: string[] = [];
  framework.onTrace((event) => { if (event.type === 'module:added' || event.type === 'module:removed') order.push(event.type); });
  const entered = deferred();
  const release = deferred();
  const adding = framework.addModule(module('late', {
    start: async () => { order.push('start entered'); entered.resolve(); await release.promise; order.push('start returned'); },
    stop: async () => { order.push('stop called'); },
  }));
  await entered.promise;
  const removing = framework.removeModule('late');
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.resolve();
  await adding;
  await removing;
  assert.deepEqual(order.filter((entry) => !entry.startsWith('module:')), ['start entered', 'start returned', 'stop called']);
  assert.deepEqual(order.filter((entry) => entry.startsWith('module:')), ['module:added', 'module:removed']);
  assert.equal(internals.moduleRegistry.modules.has('late'), false);
});
