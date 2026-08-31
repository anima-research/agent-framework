import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { ContextManager } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';

test('agent wires immutable-prefix and exact wire receipt only for kv-unified', async () => {
  let compileOptions: unknown;
  let begun: unknown;
  const strategy = {
    isKvUnifiedEnabled: () => true,
    beginKvUnifiedSubmission: (args: unknown) => { begun = args; },
  };
  const cm = {
    getStrategy: () => strategy,
    setToolDefinitions: () => {},
    compile: async (_budget: unknown, _injections: unknown, options: unknown) => {
      compileOptions = options;
      return {
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'hello' }] }],
        systemInjections: [],
      };
    },
  } as unknown as ContextManager;
  const membrane = {
    streamYielding: () => ({}) as never,
  } as unknown as Membrane;
  const agent = new Agent(
    { name: 'resident', model: 'test', systemPrompt: 'system' },
    cm,
    membrane,
  );
  const started = await agent.startStreamWithInjections([], undefined);
  assert.equal(started.request.cacheMarkers, 'cm-owned');
  assert.equal(typeof (compileOptions as { kvUnifiedImmutablePrefixHash?: string }).kvUnifiedImmutablePrefixHash, 'string');
  started.request.onCacheWireReceipt?.({ requestHash: 'wire-hash', markers: [] });
  const submission = started.takeKvSubmission?.();
  assert.equal(typeof submission?.submissionId, 'string');
  assert.equal(submission?.wireReceipt.requestHash, 'wire-hash');
  assert.deepEqual(begun, {
    submissionId: submission?.submissionId,
    requestHash: 'wire-hash',
    layoutHash: (begun as { layoutHash: string }).layoutHash,
  });
  assert.equal((begun as { layoutHash: string }).layoutHash.length, 64);
});

test('agent leaves marker ownership unchanged for non-kv strategies', async () => {
  let compileOptions: unknown = 'unset';
  const cm = {
    getStrategy: () => ({ isKvUnifiedEnabled: () => false }),
    setToolDefinitions: () => {},
    compile: async (_budget: unknown, _injections: unknown, options: unknown) => {
      compileOptions = options;
      return { messages: [], systemInjections: [] };
    },
  } as unknown as ContextManager;
  const agent = new Agent(
    { name: 'resident', model: 'test', systemPrompt: 'system' },
    cm,
    {} as Membrane,
  );
  const request = await agent.buildActivationRequest([]);
  assert.equal(request.cacheMarkers, undefined);
  assert.equal(compileOptions, undefined);
});
