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
  takeStoreReservation(verb: string, agentName: string): { release: () => void };
  ephemeralCandidates: Map<unknown, unknown>;
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

  it('refuses a direct surgery while an admitted creation is pending, in the reverse order too', async () => {
    let releaseInit!: () => void;
    let reachedInit!: () => void;
    const initGate = new Promise<void>((r) => { releaseInit = r; });
    const initStarted = new Promise<void>((r) => { reachedInit = r; });
    const strategy = new PassthroughStrategy();
    (strategy as unknown as { initialize: () => Promise<void> }).initialize = async () => { reachedInit(); await initGate; };
    const creating = framework.createEphemeralAgent({ name: 'first', model: 'test-model', systemPrompt: 'test', strategy });
    await initStarted;
    assert.throws(
      () => i.reserveStoreForSurgery('rollback', 'scout'),
      (e: Error & { code?: string }) => e.code === 'agent-busy' && /ephemeral creation\(s\) pending/.test(e.message),
      'the surgery refuses while the creation initializes',
    );
    releaseInit();
    const created = await creating;
    assert.throws(() => i.reserveStoreForSurgery('rollback', 'scout'), /ephemeral creation/, 'and while its candidate is unrun');
    created.cleanup();
    const release = i.reserveStoreForSurgery('rollback', 'scout'); // free now
    release();
  });

  it('withdraws a cleaned-up candidate for good', async () => {
    const created = await framework.createEphemeralAgent({ name: 'withdrawn', model: 'test-model', systemPrompt: 'test' });
    created.cleanup();
    await assert.rejects(
      framework.runEphemeralToCompletion(created.agent, created.contextManager),
      /released by cleanup\(\) and can't run/,
    );
    assert.equal(i.ephemeralCandidates.has(created.agent), false);
  });

  it('still refuses a run under a store hold, keeping its ticket (defence in depth)', async () => {
    // No public path holds the store while a candidate is pending; take the
    // reservation directly to reach the run-time check behind that rule.
    const created = await framework.createEphemeralAgent({ name: 'defended', model: 'test-model', systemPrompt: 'test' });
    const hold = i.takeStoreReservation('rollback', 'scout');
    try {
      await assert.rejects(framework.runEphemeralToCompletion(created.agent, created.contextManager), /under live rollback/);
      assert.equal(i.ephemeralCandidates.get(created.agent), created.contextManager, 'refused before consuming the ticket');
    } finally {
      hold.release();
      created.cleanup();
    }
  });
});

describe('stop() and the store reservation', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let i: Internals;
  let stopped: boolean;
  let quiet: { log: typeof console.log; error: typeof console.error };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'safe-boundary-stop-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    i = framework as unknown as Internals;
    stopped = false;
    quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
  });
  afterEach(async () => {
    console.log = quiet.log;
    console.error = quiet.error;
    if (!stopped) await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // What a promise settled to within `ms`, or 'pending'.
  const within = async <T>(promise: Promise<T>, ms = 200): Promise<T | Error | 'pending'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.catch((e: Error) => e),
        new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    return { gate, release, inside, entered };
  };

  it('waits for a granted callback before tearing down anything it uses, and the callback still has its store', async () => {
    const lease = held();
    const leased = framework.runAtSafeBoundary({ verb: 'held' }, async () => {
      lease.entered();
      await lease.gate;
      framework.getStore().setStateJson('probe/after-stop', { ok: true }); // host bookkeeping after stop() began
      framework.getStore().sync();
      return 'done';
    });
    await lease.inside;
    stopped = true;
    const stopping = framework.stop();
    assert.equal(await within(stopping), 'pending', 'stop() waits for the granted callback');
    lease.release();
    assert.equal(await leased, 'done', 'the callback finished against an open store');
    await stopping;
  });

  it('refuses a waiting request and any new one, and takes no direct surgery, once stop() begins', async () => {
    const first = held();
    const firstDone = framework.runAtSafeBoundary({ verb: 'first' }, async () => { first.entered(); await first.gate; });
    await first.inside;
    let secondRan = false;
    const second = framework.runAtSafeBoundary({ verb: 'second' }, async () => { secondRan = true; });
    await tick();
    stopped = true;
    const stopping = framework.stop();
    const refused = await within(second);
    assert.ok(refused instanceof Error && refused.name === 'AbortError'
      && /safe boundary for second refused: the framework is stopping/.test(refused.message), String(refused));
    const late = await within(framework.runAtSafeBoundary({ verb: 'late' }, async () => {}));
    assert.ok(late instanceof Error && /late refused: the framework is stopping/.test(late.message), String(late));
    assert.throws(() => i.reserveStoreForSurgery('rollback', 'scout'),
      (e: Error & { code?: string }) => e.code === 'invalid' && /Cannot rollback: the framework is stopping/.test(e.message));
    first.release();
    await firstDone;
    await stopping;
    assert.equal(secondRan, false, 'nothing was granted after stop() began');
  });

  it('closes admission at once when stop() is initiated inside a callback: a queued wake never runs, and shutdown completes once it returns', async () => {
    const calls = membrane.calls.length;
    let stopping!: Promise<void>;
    stopped = true;
    await framework.runAtSafeBoundary({ verb: 'handoff' }, async () => {
      i.pendingRequests.push(wake('scout')); // a wake already queued
      stopping = framework.stop(); // initiated, not awaited
      const intruder = await within(framework.runAtSafeBoundary({ verb: 'intruder' }, async () => {}));
      assert.ok(intruder instanceof Error && /intruder refused: the framework is stopping/.test(intruder.message), String(intruder));
      framework.getStore().setStateJson('probe/handoff', { applying: true }); // the callback's own work, store open
      framework.getStore().sync();
    });
    // The lease is released: a scheduler pass now starts nothing.
    await i.processInferenceRequests();
    assert.equal(await within(stopping, 5_000), undefined, 'shutdown completed');
    assert.equal(membrane.calls.length, calls, 'no provider call after the callback returned');
  });

  // A strategy whose initializer (run as an ephemeral creation opens its
  // context in the store) blocks until released, counting its calls.
  const gatedStrategy = () => {
    const gate = held();
    let calls = 0;
    const strategy = new PassthroughStrategy();
    (strategy as unknown as { initialize: () => Promise<void> }).initialize = async () => { calls++; gate.entered(); await gate.gate; };
    return { strategy, gate, calls: () => calls };
  };

  it('refuses a creation parked behind a lease once stop() begins, before it enters the store', async () => {
    const lease = held();
    const leased = framework.runAtSafeBoundary({ verb: 'held' }, async () => { lease.entered(); await lease.gate; });
    await lease.inside;
    const init = gatedStrategy();
    const creating = framework.createEphemeralAgent({ name: 'parked', model: 'test-model', systemPrompt: 'test', strategy: init.strategy });
    await tick();
    stopped = true;
    const stopping = framework.stop();
    const refused = await within(creating);
    assert.ok(refused instanceof Error && /creation refused: the framework is stopping/.test(refused.message), String(refused));
    lease.release();
    await leased;
    await stopping;
    assert.equal(init.calls(), 0, 'its initializer never ran');
  });

  it('lets a creation admitted before stop() finish initializing before the store closes', async () => {
    const init = gatedStrategy();
    const creating = framework.createEphemeralAgent({ name: 'admitted', model: 'test-model', systemPrompt: 'test', strategy: init.strategy });
    await init.gate.inside;
    stopped = true;
    const stopping = framework.stop();
    assert.equal(await within(stopping), 'pending', 'stop() waits for the initializer');
    init.gate.release();
    const created = await creating; // no "Store has been closed"
    created.cleanup();
    await stopping;
    assert.equal(init.calls(), 1);
  });

  it('refuses a creation admitted in the same turn stop() begins, before its initializer runs', async () => {
    const init = gatedStrategy();
    const creating = framework.createEphemeralAgent({ name: 'raced', model: 'test-model', systemPrompt: 'test', strategy: init.strategy });
    stopped = true;
    const stopping = framework.stop(); // admitted above, its continuation not yet run
    const refused = await within(creating);
    assert.ok(refused instanceof Error && /creation refused: the framework is stopping/.test(refused.message), String(refused));
    await stopping;
    assert.equal(init.calls(), 0, 'its initializer never ran');
    assert.equal(i.ephemeralPending.size, 0, 'its ticket was released');
  });

  it('refuses to run a finished candidate once stop() begins, without consuming it', async () => {
    const created = await framework.createEphemeralAgent({ name: 'finished', model: 'test-model', systemPrompt: 'test' });
    stopped = true;
    const stopping = framework.stop();
    await assert.rejects(
      framework.runEphemeralToCompletion(created.agent, created.contextManager),
      /Ephemeral agent "finished" refused: the framework is stopping/,
    );
    assert.equal(i.ephemeralCandidates.get(created.agent), created.contextManager, 'refused before consuming the candidate');
    created.cleanup();
    await stopping;
  });

  it("waits for a direct surgery's awaited switch before tearing down", async () => {
    for (const text of ['one', 'two', 'three']) i.addMessage('user', [{ type: 'text', text }]);
    const cm = framework.getAgent('scout')!.getContextManager();
    const anchor = String(cm.getAllMessages()[0]!.id);
    const cmx = cm as unknown as { switchBranch: (name: string) => Promise<void> };
    const real = cmx.switchBranch.bind(cm);
    const switching = held();
    cmx.switchBranch = async (name) => { switching.entered(); await switching.gate; return real(name); };
    const rollback = framework.rollbackToMessage('scout', { messageId: anchor });
    await switching.inside;
    stopped = true;
    const stopping = framework.stop();
    assert.equal(await within(stopping), 'pending', 'stop() waits for the surgery holding the store');
    switching.release();
    const done = await rollback;
    assert.ok(done, 'the surgery completed against an open store');
    await stopping;
  });
});
