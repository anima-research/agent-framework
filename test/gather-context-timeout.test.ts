/**
 * gatherContext per-module timeout (3.5): the flat 5s default silently
 * dropped any module whose gatherContext does real work (e.g. a retrieval
 * module making 2 sequential LLM calls with provider backoff) — fail-open
 * meant "guaranteed timeout, every turn, invisibly".
 *
 * A module can now declare `contextTimeoutMs` for its own budget; the
 * registry default was raised to 15s. Fail-open behavior is preserved for
 * modules that actually exceed their budget.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from '../src/module-registry.js';
import type { Module } from '../src/types/index.js';

function makeRegistry(modules: Module[]): ModuleRegistry {
  const registry = Object.create(ModuleRegistry.prototype) as ModuleRegistry;
  (registry as any).modules = new Map(modules.map((m) => [m.name, m]));
  return registry;
}

function slowModule(name: string, delayMs: number, contextTimeoutMs?: number): Module {
  return {
    name,
    ...(contextTimeoutMs !== undefined ? { contextTimeoutMs } : {}),
    start: async () => {},
    stop: async () => {},
    getTools: () => [],
    handleToolCall: async () => ({ success: true }),
    onProcess: async () => ({}),
    gatherContext: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return [{
        namespace: name,
        position: 'system' as const,
        content: [{ type: 'text' as const, text: `from ${name}` }],
      }];
    },
  };
}

test('a module slower than the shared default completes within its own contextTimeoutMs', async () => {
  // Registry default budget of 100ms, module takes 300ms but declares 1000ms.
  const registry = makeRegistry([slowModule('retrieval', 300, 1000)]);

  const injections = await registry.gatherContext('agent', 100);
  assert.equal(injections.length, 1, 'the slow module must inject, not silently time out');
  assert.deepEqual(injections[0].content, [{ type: 'text', text: 'from retrieval' }]);
});

test('a module exceeding its own budget still fails open (skipped, no throw)', async () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const registry = makeRegistry([slowModule('laggard', 500, 50)]);
    const injections = await registry.gatherContext('agent', 5000);
    assert.equal(injections.length, 0);
    assert.ok(errs.some((e) => e.includes('[laggard]') && e.includes('timed out after 50ms')));
  } finally {
    console.error = orig;
  }
});

test('modules without contextTimeoutMs use the shared default; fast ones are unaffected', async () => {
  const registry = makeRegistry([
    slowModule('fast', 10),
    slowModule('slow-no-override', 400),
  ]);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const injections = await registry.gatherContext('agent', 100);
    assert.equal(injections.length, 1, 'only the fast module injects');
    assert.deepEqual(injections[0].content, [{ type: 'text', text: 'from fast' }]);
  } finally {
    console.error = orig;
  }
});

test('a self-declared contextTimeoutMs is CLAMPED so no module can hold every turn hostage', async () => {
  // A module declaring an absurd 10-minute budget must still be cut off at the
  // 30s ceiling, or one wedged module stalls every inference turn of every
  // agent. Fake timers so the test doesn't actually wait 30s.
  mock.timers.enable({ apis: ['setTimeout'] });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  try {
    const hanging: Module = {
      name: 'wedged',
      contextTimeoutMs: 600_000, // 10 minutes — must be clamped to 30s
      start: async () => {},
      stop: async () => {},
      getTools: () => [],
      handleToolCall: async () => ({ success: true }),
      onProcess: async () => ({}),
      gatherContext: () => new Promise(() => {}), // never resolves
    };
    const registry = makeRegistry([hanging]);
    const p = registry.gatherContext('agent', 5000);
    // Advance to the 30s ceiling; if the budget weren't clamped, nothing fires.
    mock.timers.tick(30_000);
    const injections = await p;
    assert.equal(injections.length, 0, 'the wedged module fails open at the ceiling');
    assert.ok(
      errs.some((e) => e.includes('[wedged]') && e.includes('timed out after 30000ms')),
      `expected clamp to 30000ms, saw: ${errs.join(' | ')}`,
    );
  } finally {
    console.error = orig;
    mock.timers.reset();
  }
});

test('per-module budgets run in parallel — total time is bounded by the largest budget, not the sum', async () => {
  const registry = makeRegistry([
    slowModule('a', 150, 1000),
    slowModule('b', 150, 1000),
    slowModule('c', 150, 1000),
  ]);
  const started = Date.now();
  const injections = await registry.gatherContext('agent', 100);
  const elapsed = Date.now() - started;
  assert.equal(injections.length, 3);
  assert.ok(elapsed < 450, `parallel gather took ${elapsed}ms`);
});

/** Errors logged while `run` runs, with console.error put back after. */
async function loggedErrors<T>(run: () => Promise<T>): Promise<{ value: T; errs: string[] }> {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
  try {
    return { value: await run(), errs };
  } finally {
    console.error = orig;
  }
}

test('a module that answers after its timeout adds nothing to the list returned, even once it answers', async () => {
  // The late module's budget timer (50ms) falls due before its answer
  // (120ms), and that before the 200ms wait below, which starts when the
  // list is returned: timers fire in due order.
  const registry = makeRegistry([slowModule('fast', 10), slowModule('late', 120, 50)]);
  const { value: injections, errs } = await loggedErrors(() => registry.gatherContext('agent', 1000));
  assert.deepEqual(injections.map((i) => i.namespace), ['fast']);
  assert.ok(errs.some((e) => e.includes('[late]') && e.includes('timed out after 50ms')));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(injections.map((i) => i.namespace), ['fast'], 'the late answer is not pushed into the returned list');
});

test('a module whose gatherContext throws before returning a promise is skipped, and the others still inject', async () => {
  const thrower: Module = {
    ...slowModule('thrower', 0),
    gatherContext: (() => { throw new Error('no context today'); }) as Module['gatherContext'],
  };
  const registry = makeRegistry([thrower, slowModule('fast', 10)]);
  const { value: injections, errs } = await loggedErrors(() => registry.gatherContext('agent', 1000));
  assert.deepEqual(injections.map((i) => i.namespace), ['fast']);
  assert.ok(errs.some((e) => e.includes('[thrower] gatherContext') && e.includes('no context today')), 'logged as a rejection is');
});

test("each module's budget starts once its call returns, so neither its own synchronous work nor an earlier module's spends it", async () => {
  // `busy` blocks for 80ms, past every 50ms budget here, and then needs 20ms
  // more; `quick` then needs 20ms. Each module's work timer (20ms) is set
  // before its budget timer (50ms), and timers fire in due order, so each
  // answers in time whenever its budget starts once its own call returns.
  const busy: Module = {
    ...slowModule('busy', 0, 50),
    gatherContext: async () => {
      const until = Date.now() + 80;
      while (Date.now() < until) { /* synchronous work */ }
      await new Promise((r) => setTimeout(r, 20));
      return [{ namespace: 'busy', position: 'system' as const, content: [{ type: 'text' as const, text: 'from busy' }] }];
    },
  };
  const registry = makeRegistry([busy, slowModule('quick', 20, 50)]);
  const { value: injections, errs } = await loggedErrors(() => registry.gatherContext('agent', 1000));
  assert.deepEqual(injections.map((i) => i.namespace).sort(), ['busy', 'quick'], errs.join(' | '));
});

test('a late answer that comes while a slower module is still awaited adds nothing to the list returned', async () => {
  // `late` times out at 50ms and answers at 120ms, while `slow`, in time on
  // its 1000ms budget, answers at 200ms: the list is returned after both.
  const registry = makeRegistry([slowModule('late', 120, 50), slowModule('slow', 200, 1000)]);
  const { value: injections, errs } = await loggedErrors(() => registry.gatherContext('agent', 1000));
  assert.deepEqual(injections.map((i) => i.namespace), ['slow'], 'the late answer is not in the list, and the slow one is');
  assert.ok(errs.some((e) => e.includes('[late]') && e.includes('timed out after 50ms')));
});

test("a late answer's blocks that aren't text print no line about the system prompt", async () => {
  // `timely` answers in time with an image block and prints the line, which
  // shows this test can see it; `late` answers after its 50ms budget with one.
  const IMAGE = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } as never;
  const withImage = (name: string, delayMs: number, budgetMs: number): Module => ({
    ...slowModule(name, delayMs, budgetMs),
    gatherContext: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return [{ namespace: name, position: 'system' as const, content: [IMAGE] }];
    },
  });
  const registry = makeRegistry([withImage('timely', 10, 1000), withImage('late', 120, 50)]);
  (registry as unknown as { notShownWarned: Set<string> }).notShownWarned = new Set();
  const { errs } = await loggedErrors(async () => {
    const injections = await registry.gatherContext('agent', 1000);
    await new Promise((r) => setTimeout(r, 200));
    return injections;
  });
  const notShown = errs.filter((e) => e.includes("isn't text"));
  assert.equal(notShown.length, 1, notShown.join(' | '));
  assert.ok(notShown[0]!.startsWith('[timely]'));
});

test("a module whose gatherContext returns a plain array, not a promise, has it taken", async () => {
  const plain: Module = {
    ...slowModule('plain', 0),
    gatherContext: (() => [{ namespace: 'plain', position: 'system' as const, content: [{ type: 'text' as const, text: 'from plain' }] }]) as unknown as Module['gatherContext'],
  };
  const registry = makeRegistry([plain, slowModule('fast', 10)]);
  const { value: injections, errs } = await loggedErrors(() => registry.gatherContext('agent', 1000));
  assert.deepEqual(injections.map((i) => i.namespace).sort(), ['fast', 'plain'], errs.join(' | '));
});

test('a module that answers with something other than an array is skipped and logged, with or without a promise', async () => {
  const answering = (name: string, answer: () => unknown): Module => ({
    ...slowModule(name, 0),
    gatherContext: answer as unknown as Module['gatherContext'],
  });
  const registry = makeRegistry([
    answering('syncString', () => 'not injections'),
    answering('asyncString', async () => 'not injections'),
    slowModule('fast', 10),
  ]);
  const { value: injections, errs } = await loggedErrors(() => registry.gatherContext('agent', 1000));
  assert.deepEqual(injections.map((i) => i.namespace), ['fast'], 'no characters are added as injections');
  for (const name of ['syncString', 'asyncString']) {
    assert.ok(errs.some((e) => e.includes(`[${name}] gatherContext`) && e.includes('answered with string, not an array')), `${name} is logged`);
  }
});
