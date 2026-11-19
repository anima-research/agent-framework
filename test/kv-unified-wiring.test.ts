import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { ContextManager } from '@animalabs/context-manager';
import type { Membrane } from '@animalabs/membrane';
import type { KvUnifiedRequestHooks } from '../src/kv-unified-wire.js';

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
  const kvRequest = started.request as typeof started.request & KvUnifiedRequestHooks;
  assert.equal(kvRequest.cacheMarkers, 'cm-owned');
  assert.equal(typeof (compileOptions as { kvUnifiedImmutablePrefixHash?: string }).kvUnifiedImmutablePrefixHash, 'string');
  kvRequest.onCacheWireReceipt?.({ requestHash: 'wire-hash', markers: [] });
  const submission = started.takeKvSubmission?.();
  assert.equal(typeof submission?.submissionId, 'string');
  assert.equal(submission?.wireReceipt.requestHash, 'wire-hash');
  assert.deepEqual(begun, {
    submissionId: submission?.submissionId,
    requestHash: 'wire-hash',
    layoutHash: (begun as { layoutHash: string }).layoutHash,
  });
  assert.ok((begun as { layoutHash: string }).layoutHash.length > 0, 'a layout hash');
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
  assert.equal((request as typeof request & KvUnifiedRequestHooks).cacheMarkers, undefined);
  assert.equal(compileOptions, undefined);
});

test('a new activation closes the receipt flight its predecessor left open before it submits', async () => {
  const order: string[] = [];
  const strategy = {
    isKvUnifiedEnabled: () => true,
    beginKvUnifiedSubmission: (args: { submissionId: string }) => { order.push(`begin:${args.submissionId}`); },
    reportKvUnifiedFailed: (submissionId: string) => { order.push(`fail:${submissionId}`); },
  };
  const cm = {
    getStrategy: () => strategy,
    setToolDefinitions: () => {},
    compile: async () => ({
      messages: [{ participant: 'user', content: [{ type: 'text', text: 'hello' }] }],
      systemInjections: [],
    }),
  } as unknown as ContextManager;
  const membrane = { streamYielding: () => ({}) as never } as unknown as Membrane;
  const agent = new Agent({ name: 'devops', model: 'test', systemPrompt: 'system' }, cm, membrane);

  // Activation 1: the provider attempt fires its receipt and then dies with no
  // usage event (transport error / idle timeout / framework cancel). Nothing
  // takes the submission; the stream's own teardown has not run yet.
  const first = await agent.startStreamWithInjections([], undefined);
  (first.request as typeof first.request & KvUnifiedRequestHooks)
    .onCacheWireReceipt?.({ requestHash: 'wire-1', markers: [] });
  const firstId = order[0]?.slice('begin:'.length);
  assert.ok(firstId, 'first activation must have begun a submission');
  agent.reset();

  // Activation 2 (retry, restart, or the next wake) must supersede that flight
  // BEFORE its own receipt reaches the ledger.
  const second = await agent.startStreamWithInjections([], undefined);
  (second.request as typeof second.request & KvUnifiedRequestHooks)
    .onCacheWireReceipt?.({ requestHash: 'wire-2', markers: [] });
  assert.equal(order.length, 3, JSON.stringify(order));
  assert.equal(order[1], `fail:${firstId}`);
  assert.ok(order[2]!.startsWith('begin:') && order[2] !== order[0]);
  // The predecessor's late teardown finds nothing left to fail.
  assert.deepEqual(first.drainKvSubmissionIds?.(), []);
  // The successor's own flight is still live for its usage event.
  assert.equal(second.takeKvSubmission?.()?.wireReceipt.requestHash, 'wire-2');
});
