/**
 * Context injection is deprecated (#171). The deprecation changes nothing
 * about how injections are applied. Every module that returns injections,
 * and every MCPL server with an injection that passes the feature-set and
 * grant checks, is named once on stderr; a source with none isn't.
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
  assert.equal(
    warnings[0],
    '[deprecated] module "hud" returns context injections, and this line changes nothing about how they\'re applied. ' +
      'Context injection is deprecated (anima-research/agent-framework#171). Moving changing state into conversation ' +
      'content (push events, tool results) is for whoever maintains the module or server named at the start of this ' +
      "line. Durable system text belongs in the agent's configured system prompt, which whoever configures this host " +
      'sets; system text that changes at runtime has no replacement. Turning that module or server off removes ' +
      'its injections along with whatever else it does.',
    'the whole line an operator reads',
  );
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
