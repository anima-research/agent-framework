/**
 * runAtSafeBoundary: a host callback held at a safe boundary.
 *
 * The lease waits until every agent sharing the store is idle with no turn
 * alive and no ephemeral run registered, then holds the same reservation a
 * live surgery takes across an async callback. While it waits, new resident
 * turns are held (continuations and registered ephemeral streams pass);
 * while it is held, nothing starts; at release, writes that deferred behind
 * it land, acknowledged.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest, SafeBoundaryLease } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type Internals = {
  pendingRequests: InferenceRequest[];
  processInferenceRequests(): Promise<void>;
  tryGrantSafeBoundary(): void;
  activeTurnTokens: Map<string, number>;
  executeToolCall: (call: Record<string, unknown>) => Promise<unknown>;
  boundaryWaiters: unknown[];
  heldLease: { lease: SafeBoundaryLease; tokens: Map<string, number> } | null;
  surgeryHold: unknown;
  ephemeralRuns: Map<string, unknown>;
  deferredMessages: unknown[];
  unackedDeferredWrites: unknown[];
  addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
};

const wake = (agentName: string, reason = 'mcpl:channel-incoming'): InferenceRequest =>
  ({ agentName, reason, source: 'test', timestamp: Date.now() }) as InferenceRequest;
const tick = () => new Promise((r) => setImmediate(r));

describe('runAtSafeBoundary', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let i: Internals;
  let quiet: typeof console.log;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'safe-boundary-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'other', model: 'test-model', systemPrompt: 'You are other.' },
      ],
      modules: [],
    });
    i = framework as unknown as Internals;
    quiet = console.log;
    console.log = () => {};
  });
  afterEach(async () => {
    console.log = quiet;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('is granted at once on an idle store and holds every agent; a wake waits for the release', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'after the change' }]));
    const result = await framework.runAtSafeBoundary({ verb: 'test change' }, async (lease) => {
      assert.deepEqual([...lease.agents].sort(), ['other', 'scout']);
      assert.equal(i.activeTurnTokens.get('scout'), i.heldLease!.tokens.get('scout'), 'scout reserved by the lease');
      assert.equal(i.activeTurnTokens.get('other'), i.heldLease!.tokens.get('other'), 'other reserved by the lease');

      i.pendingRequests.push(wake('scout'));
      await i.processInferenceRequests();
      assert.equal(membrane.calls.length, 0, 'no turn starts under the lease');
      assert.equal(i.pendingRequests.length, 1, 'the wake is requeued, not dropped');

      await assert.rejects(
        framework.puppetToolCall('scout', 'agent_settings', { action: 'get' }),
        /under live test change/,
        'a puppet without the lease is refused by the hold',
      );
      return 'applied';
    });
    assert.equal(result, 'applied');
    assert.equal(i.heldLease, null);
    assert.equal(i.surgeryHold, null);
    assert.equal(i.activeTurnTokens.size, 0, 'every reserved token released');

    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'the requeued wake runs after the release');
  });

  it('waits for a live turn, holds new resident wakes meanwhile, and runs before them', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'woken after' }]));
    i.activeTurnTokens.set('other', 9_999); // other is mid-turn
    let callsWhenGranted = -1;
    const leased = framework.runAtSafeBoundary({ verb: 'waits' }, async () => {
      callsWhenGranted = membrane.calls.length;
    });
    await tick();
    assert.equal(i.boundaryWaiters.length, 1, 'waiting');
    assert.equal(i.heldLease, null, 'not granted while a turn is alive');

    // scout is idle with no turn alive, yet its new wake is held.
    i.pendingRequests.push(wake('scout'));
    await i.processInferenceRequests();
    assert.equal(membrane.calls.length, 0, 'the waiting lease holds the new wake');
    assert.equal(i.pendingRequests.length, 1, 'held, not dropped');

    i.activeTurnTokens.delete('other'); // other's turn ends
    i.tryGrantSafeBoundary();
    await leased;
    assert.equal(callsWhenGranted, 0, 'the lease ran before the held wake');

    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'the held wake runs after the release');
  });

  it('lets a continuation of a held turn through while it waits', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continued' }]));
    i.activeTurnTokens.set('other', 9_999);
    const leased = framework.runAtSafeBoundary({ verb: 'waits' }, async () => {});
    await tick();
    i.pendingRequests.push(wake('scout'), wake('scout', 'context_budget_restart'));
    await i.processInferenceRequests();
    assert.equal(membrane.calls.length, 1, 'the continuation started its turn');
    assert.deepEqual(i.pendingRequests.map((r) => r.reason), ['mcpl:channel-incoming'], 'the new wake stays held');

    for (let n = 0; n < 200 && (i.activeTurnTokens.has('scout') || framework.getAgent('scout')!.state.status !== 'idle'); n++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    i.activeTurnTokens.delete('other');
    i.tryGrantSafeBoundary();
    await leased;
  });

  it('lets a registered ephemeral stream finish its run, then is granted', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ephemeral done' }]));
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const run = framework.runEphemeralToCompletion(agent, contextManager);
    assert.equal(i.ephemeralRuns.has('worker'), true, 'registered at once');

    let seen: { ephemeral: number; agents: readonly string[] } | null = null;
    const leased = framework.runAtSafeBoundary({ verb: 'after the worker' }, async (lease) => {
      seen = { ephemeral: i.ephemeralRuns.size, agents: lease.agents };
    });
    framework.start();
    const settled = await run;
    assert.equal(settled.speech.includes('ephemeral done'), true, "the worker's turn ran while the lease waited");
    await leased;
    assert.deepEqual(seen, { ephemeral: 0, agents: ['scout', 'other'] });
  });

  it('withdraws a waiting lease on abort and stops holding wakes', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'not held now' }]));
    i.activeTurnTokens.set('other', 9_999);
    const controller = new AbortController();
    let ran = false;
    const leased = framework.runAtSafeBoundary({ verb: 'withdrawn', signal: controller.signal }, async () => { ran = true; });
    await tick();
    controller.abort();
    await assert.rejects(leased, { name: 'AbortError' });
    assert.equal(ran, false);
    assert.equal(i.boundaryWaiters.length, 0);

    i.pendingRequests.push(wake('scout'));
    await i.processInferenceRequests();
    assert.equal(membrane.calls.length, 1, 'no lease waits, so the wake runs');
    i.activeTurnTokens.delete('other');
    await framework.runUntilIdle();
  });

  it('runs a granted callback to its end whatever the signal does after the grant', async () => {
    const controller = new AbortController();
    let finished = false;
    await framework.runAtSafeBoundary({ verb: 'granted', signal: controller.signal }, async () => {
      controller.abort();
      await tick();
      finished = true;
    });
    assert.equal(finished, true);
    assert.equal(i.heldLease, null);
  });

  it('grants waiting leases oldest first, and releases after a failing callback', async () => {
    i.activeTurnTokens.set('other', 9_999);
    const order: string[] = [];
    const first = framework.runAtSafeBoundary({ verb: 'first' }, async () => {
      order.push('first');
      throw new Error('first failed');
    });
    const second = framework.runAtSafeBoundary({ verb: 'second' }, async () => {
      order.push('second');
      assert.equal(i.heldLease?.lease.verb, 'second');
    });
    await tick();
    assert.equal(i.boundaryWaiters.length, 2);
    i.activeTurnTokens.delete('other');
    i.tryGrantSafeBoundary();
    await assert.rejects(first, /first failed/);
    await second;
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(i.heldLease, null);
    assert.equal(i.activeTurnTokens.size, 0);
  });

  it("runs a puppet under the lease on the lease's token, and refuses a lease no longer held", async () => {
    i.executeToolCall = async () => ({ success: true, data: 'settings snapshot', isError: false });
    let kept: SafeBoundaryLease | null = null;
    await framework.runAtSafeBoundary({ verb: 'puppet under lease' }, async (lease) => {
      kept = lease;
      const token = i.activeTurnTokens.get('scout');
      await framework.puppetToolCall('scout', 'agent_settings', { action: 'get' }, { lease });
      assert.equal(i.activeTurnTokens.get('scout'), token, "the lease's token still reserves scout");
    });
    const all = framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string }> }>;
    const types = all.map((m) => m.content[0]?.type);
    const use = types.indexOf('tool_use');
    assert.ok(use >= 0, 'pair stored');
    assert.equal(types[use + 1], 'tool_result', 'pair adjacent');
    assert.equal(i.activeTurnTokens.size, 0);
    await assert.rejects(
      framework.puppetToolCall('scout', 'agent_settings', { action: 'get' }, { lease: kept! }),
      /not the lease currently held/,
    );
  });

  it('lands writes deferred behind it at release, with their ids, and acknowledges them', async () => {
    await framework.runAtSafeBoundary({ verb: 'defer' }, async () => {
      i.addMessage('user', [{ type: 'text', text: 'arrived during the change' }], undefined, { forAgent: 'scout' });
      assert.equal(i.deferredMessages.length, 1, 'deferred behind the reservation');
    });
    assert.equal(i.deferredMessages.length, 0);
    assert.equal(i.unackedDeferredWrites.length, 0, 'acknowledged');
    const all = framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>; metadata?: { deferredWriteId?: string };
    }>;
    const landed = all.find((m) => m.content[0]?.text === 'arrived during the change');
    assert.ok(landed, 'landed at release');
    assert.equal(typeof landed!.metadata?.deferredWriteId, 'string', 'carries its deferred-write id');
  });
});
