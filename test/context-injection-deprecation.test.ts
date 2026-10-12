/**
 * Context injection is deprecated (#171). Behavior must be unchanged —
 * injections still apply — but every injecting source is named exactly once
 * on stderr, and sources that inject nothing stay silent.
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
  assert.match(warnings[0], /module "hud" injected context/);
  assert.match(warnings[0], /#171/);
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
  assert.match(warnings[0], /MCPL server "recap-server" injected context \(position "beforeUser"\)/);
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
