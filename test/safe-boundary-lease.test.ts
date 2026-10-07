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
import { AgentFramework, PassthroughStrategy } from '../src/index.js';
import type { InferenceRequest, MessagePlacement, Module, ModuleContext, SafeBoundaryLease, ToolDefinition, ToolResult } from '../src/index.js';
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
  ephemeralPending: Set<object>;
  landedDeferredWrites: Set<string>;
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
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

  it('waits for an ephemeral creation in progress, then for its unrun candidate until cleanup', async () => {
    let releaseInit!: () => void;
    let reachedInit!: () => void;
    const initGate = new Promise<void>((r) => { releaseInit = r; });
    const initStarted = new Promise<void>((r) => { reachedInit = r; });
    const strategy = new PassthroughStrategy();
    (strategy as unknown as { initialize: () => Promise<void> }).initialize = async () => { reachedInit(); await initGate; };
    const creating = framework.createEphemeralAgent({ name: 'pending', model: 'test-model', systemPrompt: 'test', strategy });
    await initStarted;

    let granted = false;
    const leased = framework.runAtSafeBoundary({ verb: 'after creation' }, async () => { granted = true; });
    await tick();
    assert.equal(granted, false, 'not granted while the creation initializes');
    releaseInit();
    const created = await creating;
    i.tryGrantSafeBoundary();
    await tick();
    assert.equal(granted, false, 'nor while its candidate is unrun');
    created.cleanup();
    await leased;
    assert.equal(granted, true, 'granted once the candidate is released');
    assert.equal(i.ephemeralPending.size, 0);
  });

  it('holds a creation nobody it is draining asked for, without letting it block the grant', async () => {
    i.activeTurnTokens.set('other', 9_999); // a real turn keeps the lease waiting
    const order: string[] = [];
    const leased = framework.runAtSafeBoundary({ verb: 'held creation' }, async () => { order.push('lease'); });
    await tick();
    const creating = framework.createEphemeralAgent({ name: 'outsider', model: 'test-model', systemPrompt: 'test' })
      .then((c) => { order.push('created'); return c; });
    await tick();
    assert.deepEqual(order, [], 'held behind the waiting lease');
    assert.equal(i.ephemeralPending.size, 0, 'a held request is not pending');

    i.activeTurnTokens.delete('other');
    i.tryGrantSafeBoundary();
    await leased;
    const created = await creating;
    assert.deepEqual(order, ['lease', 'created'], 'it proceeds only after the lease');
    created.cleanup();
  });

  it("admits a creation for a stream it is draining, and waits for that stream's candidate", async () => {
    i.activeTurnTokens.set('other', 9_999); // other's real turn is alive: the lease drains it
    let granted = false;
    const leased = framework.runAtSafeBoundary({ verb: 'draining' }, async () => { granted = true; });
    await tick();
    const created = await framework.createEphemeralAgent(
      { name: 'helper', model: 'test-model', systemPrompt: 'test' }, { requestedBy: 'other' },
    );
    assert.equal(i.ephemeralPending.size, 1, 'admitted while the lease waits');
    i.activeTurnTokens.delete('other'); // other's turn ends
    i.tryGrantSafeBoundary();
    await tick();
    assert.equal(granted, false, "the lease still waits for other's candidate");
    created.cleanup();
    await leased;
    assert.equal(granted, true);
  });

  it('keeps a durable deferral whose store write failed pending for the next boundary', async () => {
    class Courier implements Module {
      readonly name = 'courier';
      ctx!: ModuleContext;
      async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> { return { success: true }; }
      async onProcess(): Promise<Record<string, never>> { return {}; }
    }
    const courier = new Courier();
    await framework.addModule(courier as unknown as Module);
    const cm = framework.getAgent('scout')!.getContextManager();
    const realAdd = cm.addMessage.bind(cm);
    let failing = true;
    (cm as unknown as { addMessage: typeof cm.addMessage }).addMessage = ((participant, content, metadata, causedBy) => {
      if (failing && (content[0] as { text?: string }).text === 'durable notice') throw new Error('injected append failure');
      return realAdd(participant, content, metadata, causedBy);
    }) as typeof cm.addMessage;

    const placement: MessagePlacement = {};
    const quietErr = console.error;
    console.error = () => {};
    try {
      await framework.runAtSafeBoundary({ verb: 'deliver' }, async () => {
        courier.ctx.addMessage('user', [{ type: 'text', text: 'durable notice' }], undefined, { forAgent: 'scout', placement, durable: true });
      });
    } finally {
      console.error = quietErr;
    }
    assert.equal(placement.durable, true);
    const landed = () => (cm.getAllMessages() as Array<{ content: Array<{ text?: string }> }>)
      .filter((m) => m.content[0]?.text === 'durable notice').length;
    assert.equal(landed(), 0, 'the write failed');
    assert.equal(i.deferredMessages.length, 1, 'kept pending, not acknowledged away');

    failing = false;
    await framework.runAtSafeBoundary({ verb: 'next boundary' }, async () => {});
    assert.equal(landed(), 1, 'lands at the next boundary, once');
    assert.equal(i.deferredMessages.length, 0);
    assert.equal(i.unackedDeferredWrites.length, 0);
  });

  it('takes the creation ticket before yielding, so a lease asked for in the same tick waits for it', async () => {
    const order: string[] = [];
    const strategy = new PassthroughStrategy();
    (strategy as unknown as { initialize: () => Promise<void> }).initialize = async () => {
      await tick();
      order.push('initialized');
    };
    const creating = framework.createEphemeralAgent({ name: 'same-tick', model: 'test-model', systemPrompt: 'test', strategy });
    const leased = framework.runAtSafeBoundary({ verb: 'same tick' }, async () => { order.push('lease'); });
    const created = await creating;
    i.tryGrantSafeBoundary();
    await tick();
    assert.deepEqual(order, ['initialized'], 'the lease waited for the creation and its candidate');
    created.cleanup();
    await leased;
    assert.deepEqual(order, ['initialized', 'lease']);
  });

  it("holds a creation behind a direct surgery's store hold, not only behind a lease", async () => {
    const release = i.reserveStoreForSurgery('rollback', 'scout');
    let created = false;
    const creating = framework.createEphemeralAgent({ name: 'behind-surgery', model: 'test-model', systemPrompt: 'test' })
      .then((c) => { created = true; return c; });
    await tick();
    assert.equal(created, false, 'held while the surgery holds the store');
    release();
    const c = await creating;
    assert.equal(created, true, 'proceeds once the hold is released');
    c.cleanup();
  });

  it('keeps no landed-write ids for memory-only deferrals', async () => {
    i.activeTurnTokens.set('other', 9_999);
    for (let n = 0; n < 4; n++) i.addMessage('user', [{ type: 'text', text: `ordinary ${n}` }], undefined, { forAgent: 'other' });
    assert.equal(i.deferredMessages.length, 4);
    i.activeTurnTokens.delete('other');
    await framework.runAtSafeBoundary({ verb: 'flush' }, async () => {});
    assert.equal(i.deferredMessages.length, 0, 'all landed');
    assert.equal(i.landedDeferredWrites.size, 0, 'and left no ids behind');
  });
});
