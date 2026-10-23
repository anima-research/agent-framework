/**
 * start() and addModule() made while a stop() is still running are refused
 * (#315's in-flight half). Before, a start() then left the stop waiting on
 * the new lifecycle's loop, for good with no budget, or let the stop tear
 * down modules and an owned store under a loop that no later stop() could
 * end; a module added after the stop took its list of modules stayed started
 * past it. Once the stop has settled, this refusal no longer fires: what a
 * start() after a settled stop() should do is #315's question, and the last
 * test leaves it open. Each test waits on the event it needs (a module's
 * stop() being called), not on a fixed delay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, type Module } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const STOPPING = /^(start|addModule)\(\) refused: the framework is stopping$/;

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

async function fixture(t: import('node:test').TestContext, modules: Module[] = [], borrowStore = false) {
  const dir = mkdtempSync(join(tmpdir(), 'start-during-stop-'));
  const store = borrowStore ? JsStore.openOrCreate({ path: join(dir, 'store') }) : undefined;
  const framework = await AgentFramework.create({
    ...(store ? { store } : { storePath: join(dir, 'store') }),
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

test("a start() made in stop()'s first synchronous steps is refused too", { timeout: 30_000 }, async (t) => {
  // stop() claims its attempt, then runs steps that can emit traces, the push
  // coalescer's suspend() first, before it clears running. A stand-in for the
  // coalescer calls start() there, as a trace listener could.
  const { framework, internals } = await fixture(t);
  framework.start();
  let refusal: unknown = 'start() was never called';
  (framework as unknown as { pushCoalescer: { suspend(): void } }).pushCoalescer = {
    suspend: () => {
      try { framework.start(); refusal = 'start() returned'; } catch (error) { refusal = error; }
    },
  };
  await framework.stop();
  assert.ok(refusal instanceof Error && refusal.message === 'start() refused: the framework is stopping', String(refusal));
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

test('once a stop() has settled, the stopping refusal no longer fires', { timeout: 30_000 }, async (t) => {
  // A store the framework doesn't own, so its close doesn't refuse first.
  // Only the stopping refusal is asserted: whether start() and addModule()
  // then begin a working lifecycle is #315's.
  const { framework } = await fixture(t, [], true);
  framework.start();
  await framework.stop();
  const refusal = (run: () => unknown): unknown => { try { run(); return null; } catch (error) { return error; } };
  const afterStart = refusal(() => framework.start());
  assert.ok(!(afterStart instanceof Error && STOPPING.test(afterStart.message)), String(afterStart));
  await framework.stop().catch(() => {});
  const added = await framework.addModule(module('after')).then(() => null, (error: unknown) => error);
  assert.ok(!(added instanceof Error && STOPPING.test(added.message)), String(added));
});
