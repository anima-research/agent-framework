/**
 * Placing a context injection at `beforeUser` is deprecated (#171). Every
 * injection is still collected as before. Each module or MCPL server whose
 * collected injections include a `beforeUser` one is named once on stderr;
 * `system` and `afterUser` injections, which stay supported, name nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from '../src/module-registry.js';
import { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { Module, ModuleContextInjection } from '../src/types/index.js';

type Position = 'system' | 'beforeUser' | 'afterUser';

function makeRegistry(modules: Module[]): ModuleRegistry {
  const registry = Object.create(ModuleRegistry.prototype) as ModuleRegistry;
  (registry as any).modules = new Map(modules.map((m) => [m.name, m]));
  (registry as any).moduleContexts = new Map(modules.map((m) => [m.name, {}]));
  (registry as any).beforeUserWarned = new Set<string>();
  return registry;
}

function injectingModule(name: string, positions: Position[], extra: Partial<ModuleContextInjection> = {}): Module {
  return {
    name,
    start: async () => {},
    stop: async () => {},
    getTools: () => [],
    handleToolCall: async () => ({ success: true }),
    onProcess: async () => ({}),
    gatherContext: async () => positions.map((position, i) => ({
      namespace: name,
      position,
      content: [{ type: 'text' as const, text: `${name} #${i}` }],
      ...extra,
    })),
  };
}

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = orig; }
  return lines.filter((l) => l.includes('[deprecated]'));
}

test('a module that places a beforeUser injection is still collected and is named once across turns', async () => {
  const registry = makeRegistry([injectingModule('hud', ['beforeUser'])]);
  let first: unknown[] = [];
  const warnings = await captureWarnings(async () => {
    first = await registry.gatherContext('agent');
    await registry.gatherContext('agent');
    await registry.gatherContext('agent');
  });
  assert.equal(first.length, 1, 'injection still collected');
  assert.equal(warnings.length, 1, `one warning for three turns, got ${JSON.stringify(warnings)}`);
  assert.equal(
    warnings[0],
    '[deprecated] module "hud" places a context injection at beforeUser, which still works. ' +
      'Placing a context injection at beforeUser is deprecated (anima-research/agent-framework#171). ' +
      'It is placed again at every compile before the newest user message, or at the window\'s end where there ' +
      'is none, so it moves whenever that place does: the request misses the cache from there on, and it can ' +
      'split a tool call from its result. Use afterUser, which is stored where it lands, unless a module sets placedEachCompile on it.',
    'the whole line an operator reads',
  );
});

test('a module whose injections are system or afterUser, placedEachCompile included, is not named', async () => {
  const registry = makeRegistry([
    injectingModule('instructions', ['system']),
    injectingModule('toolsets', ['afterUser']),
    injectingModule('near-end', ['afterUser'], { placedEachCompile: true }),
  ]);
  let collected: unknown[] = [];
  const warnings = await captureWarnings(async () => { collected = await registry.gatherContext('agent'); });
  assert.equal(collected.length, 3, 'every injection still collected');
  assert.deepEqual(warnings, []);
});

test('a module is named when any of its injections is beforeUser', async () => {
  const registry = makeRegistry([injectingModule('mixed', ['afterUser', 'beforeUser'])]);
  const warnings = await captureWarnings(async () => { await registry.gatherContext('agent'); });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[deprecated\] module "mixed" places a context injection at beforeUser/);
});

test('a module is named once by each framework that collects it, so same-named modules in two are each named', async () => {
  const first = makeRegistry([injectingModule('hud', ['beforeUser'])]);
  const second = makeRegistry([injectingModule('hud', ['beforeUser'])]);
  const warnings = await captureWarnings(async () => {
    await first.gatherContext('agent');
    await second.gatherContext('agent');
    await second.gatherContext('agent');
  });
  assert.equal(warnings.length, 2, `one line from each registry, got ${JSON.stringify(warnings)}`);
});

function orchestratorWith(grantPaths: string[], position: string, content: unknown = 'recent messages…') {
  const server = {
    id: 'recap-server',
    grant: new CapabilityGrant(new Set(grantPaths), []),
    sendBeforeInference: async () => ({
      featureSet: 'recap',
      contextInjections: [{ namespace: 'recap', position, content }],
    }),
  };
  const registry = { getAllServers: () => [server] } as any;
  const featureSets = { validateInbound: () => {} } as any;
  return new HookOrchestrator(registry, featureSets);
}

const params = { agentName: 'agent', userMessage: 'hi' } as any;

test('an MCPL server beforeUser injection within its grant is still collected and named once', async () => {
  const orchestrator = orchestratorWith(['contextHooks.beforeInference.inject.beforeUser'], 'beforeUser');
  let collected: unknown[] = [];
  const warnings = await captureWarnings(async () => {
    collected = await orchestrator.beforeInference(params);
    await orchestrator.beforeInference(params);
  });
  assert.equal(collected.length, 1, 'injection still collected');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[deprecated\] MCPL server "recap-server" places a context injection at beforeUser, which still works\. /);
});

for (const position of ['system', 'afterUser'] as const) {
  test(`an MCPL server ${position} injection within its grant is collected and not named`, async () => {
    const orchestrator = orchestratorWith([`contextHooks.beforeInference.inject.${position}`], position);
    let collected: unknown[] = [];
    const warnings = await captureWarnings(async () => { collected = await orchestrator.beforeInference(params); });
    assert.equal(collected.length, 1);
    assert.deepEqual(warnings, []);
  });
}

test('a beforeUser injection outside the grant is dropped as before and does not warn', async () => {
  const orchestrator = orchestratorWith(['contextHooks.beforeInference.inject.system'], 'beforeUser');
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  let collected: unknown[] = [];
  let warnings: string[] = [];
  try {
    warnings = await captureWarnings(async () => { collected = await orchestrator.beforeInference(params); });
  } finally { console.error = origErr; }
  assert.equal(collected.length, 0);
  assert.equal(warnings.length, 0);
  assert.ok(errs.some((e) => e.includes('dropped beforeInference injection')));
});

test('a granted beforeUser injection that can\'t be read is dropped as before and does not warn', async () => {
  const orchestrator = orchestratorWith(['contextHooks.beforeInference.inject.beforeUser'], 'beforeUser', [null]);
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  let collected: unknown[] = [];
  let warnings: string[] = [];
  try {
    warnings = await captureWarnings(async () => { collected = await orchestrator.beforeInference(params); });
  } finally { console.error = origErr; }
  assert.equal(collected.length, 0);
  assert.equal(warnings.length, 0);
  assert.ok(errs.some((e) => e.includes("couldn't be read")), JSON.stringify(errs));
});
