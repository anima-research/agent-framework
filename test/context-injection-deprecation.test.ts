/**
 * Context injection is deprecated (#171). The deprecation changes nothing
 * about how injections are applied, and every source whose injections are
 * gathered in time is named once on stderr. A source that injects nothing,
 * or a module that answers after its timeout, isn't named.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from '../src/module-registry.js';
import { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { resetContextInjectionDeprecationWarnings } from '../src/context-injection-deprecation.js';
import type { Module } from '../src/types/index.js';

function makeRegistry(modules: Module[]): ModuleRegistry {
  const registry = Object.create(ModuleRegistry.prototype) as ModuleRegistry;
  (registry as any).modules = new Map(modules.map((m) => [m.name, m]));
  return registry;
}

function injectingModule(name: string, count: number): Module {
  return {
    name,
    start: async () => {},
    stop: async () => {},
    getTools: () => [],
    handleToolCall: async () => ({ success: true }),
    onProcess: async () => ({}),
    gatherContext: async () => Array.from({ length: count }, (_, i) => ({
      namespace: name,
      position: 'afterUser' as const,
      content: [{ type: 'text' as const, text: `${name} #${i}` }],
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

beforeEach(() => resetContextInjectionDeprecationWarnings());

test('a module that injects is still applied and is named once across turns', async () => {
  const registry = makeRegistry([injectingModule('hud', 1)]);
  let first: unknown[] = [];
  const warnings = await captureWarnings(async () => {
    first = await registry.gatherContext('agent');
    await registry.gatherContext('agent');
    await registry.gatherContext('agent');
  });
  assert.equal(first.length, 1, 'injection still applied');
  assert.equal(warnings.length, 1, `one warning for three turns, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /module "hud" returns context injections, and this line changes nothing about how they're applied\./);
  assert.match(warnings[0], /#171/);
});

test('a module that answers after its timeout is neither added to the returned injections nor named', async () => {
  let lateAnswered = false;
  const late: Module = {
    ...injectingModule('late', 1),
    contextTimeoutMs: 50,
    gatherContext: async () => {
      await new Promise((r) => setTimeout(r, 120));
      lateAnswered = true;
      return [{ namespace: 'late', position: 'afterUser' as const, content: [{ type: 'text' as const, text: 'late #0' }] }];
    },
  };
  const registry = makeRegistry([injectingModule('prompt', 1), late]);
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
  let returned: unknown[] = [];
  let warnings: string[] = [];
  try {
    warnings = await captureWarnings(async () => {
      returned = await registry.gatherContext('agent');
      // Past the late answer: it resolves at 120 ms, its timeout fired at 50.
      await new Promise((r) => setTimeout(r, 200));
    });
  } finally { console.error = origErr; }
  assert.ok(lateAnswered, 'the late module did answer, after its timeout');
  assert.deepEqual(returned.map((i) => (i as { namespace: string }).namespace), ['prompt'], 'the late answer is not added after the timeout');
  assert.equal(warnings.length, 1, `only the module that answered in time is named, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /module "prompt"/);
  assert.ok(errs.some((e) => e.includes('[late] gatherContext') && e.includes('timed out after 50ms')), 'the timeout is logged as before');
});

test('a module whose gatherContext throws before returning a promise fails alone', async () => {
  const thrower: Module = {
    ...injectingModule('thrower', 1),
    gatherContext: (() => { throw new Error('no context today'); }) as Module['gatherContext'],
  };
  const registry = makeRegistry([thrower, injectingModule('prompt', 1)]);
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
  let returned: unknown[] = [];
  try {
    await captureWarnings(async () => { returned = await registry.gatherContext('agent'); });
  } finally { console.error = origErr; }
  assert.deepEqual(returned.map((i) => (i as { namespace: string }).namespace), ['prompt'], "the other module's injections are returned");
  assert.ok(errs.some((e) => e.includes('[thrower] gatherContext') && e.includes('no context today')), 'the throw is logged as a rejection is');
});

test('a module whose gatherContext returns nothing is not warned about', async () => {
  const registry = makeRegistry([injectingModule('quiet', 0), injectingModule('loud', 2)]);
  const warnings = await captureWarnings(async () => { await registry.gatherContext('agent'); });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"loud"/);
});

function orchestratorWith(grantPaths: string[], position: string) {
  const server = {
    id: 'recap-server',
    grant: new CapabilityGrant(new Set(grantPaths), []),
    sendBeforeInference: async () => ({
      featureSet: 'recap',
      contextInjections: [{ namespace: 'recap', position, content: 'recent messages…' }],
    }),
  };
  const registry = { getAllServers: () => [server] } as any;
  const featureSets = { validateInbound: () => {} } as any;
  return new HookOrchestrator(registry, featureSets);
}

const params = { agentName: 'agent', userMessage: 'hi' } as any;

test('an MCPL server injection within its grant is still applied and named once', async () => {
  const orchestrator = orchestratorWith(['contextHooks.beforeInference.inject.beforeUser'], 'beforeUser');
  let applied: unknown[] = [];
  const warnings = await captureWarnings(async () => {
    applied = await orchestrator.beforeInference(params);
    await orchestrator.beforeInference(params);
  });
  assert.equal(applied.length, 1, 'injection still applied');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MCPL server "recap-server" returns context injections, and this line changes nothing about how they're applied\./);
});

test('an injection outside the grant is dropped as before and does not warn', async () => {
  const orchestrator = orchestratorWith(['contextHooks.beforeInference.inject.beforeUser'], 'system');
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  let applied: unknown[] = [];
  let warnings: string[] = [];
  try {
    warnings = await captureWarnings(async () => { applied = await orchestrator.beforeInference(params); });
  } finally { console.error = origErr; }
  assert.equal(applied.length, 0);
  assert.equal(warnings.length, 0);
  assert.ok(errs.some((e) => e.includes('dropped beforeInference injection')));
});
