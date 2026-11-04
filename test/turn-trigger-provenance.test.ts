/**
 * Turn provenance: the trigger the framework exposes for the turn in progress
 * (getActiveTurnTrigger / the InferenceRequest handed to startAgentStream)
 * must be internally consistent — channel, addressed and counterparty from
 * ONE request — so a host stamping gateway telemetry never reports one
 * person's channel with another person's id.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest } from '../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    pendingRequests: InferenceRequest[];
    processInferenceRequests(): Promise<void>;
    startAgentStream(agent: unknown, trigger?: InferenceRequest): Promise<void>;
  };
}

describe('Turn trigger provenance', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'turn-trigger-test-'));
    membrane = new MockMembrane();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework() {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
  }

  /** Spy on startAgentStream: capture the merged trigger and the value the
   *  getter exposes while the turn is alive. */
  function spy(framework: AgentFramework) {
    const i = internals(framework);
    const captured: { handed?: InferenceRequest; exposed?: InferenceRequest } = {};
    const orig = i.startAgentStream.bind(framework);
    i.startAgentStream = async (agent: unknown, trigger?: InferenceRequest) => {
      captured.handed = trigger;
      const p = orig(agent, trigger);
      captured.exposed = framework.getActiveTurnTrigger('scout');
      return p;
    };
    return captured;
  }

  it('a batch where a later ADDRESSED request wins keeps its channel and author together', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi bob' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:alice-room', counterparty: 'discord:user:alice', addressed: false },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t + 1,
        channelId: 'discord:g:bob-room', counterparty: 'discord:user:bob', addressed: true },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();

    assert.equal(captured.handed?.channelId, 'discord:g:bob-room', 'addressed channel wins');
    assert.equal(captured.handed?.addressed, true);
    assert.equal(captured.handed?.counterparty, 'discord:user:bob', 'author must come from the SAME request as the channel');
    assert.equal(captured.exposed?.counterparty, 'discord:user:bob', 'getActiveTurnTrigger exposes the same trigger while the turn runs');
    assert.equal(captured.exposed?.channelId, 'discord:g:bob-room');
    assert.equal(framework.getActiveTurnTrigger('scout'), undefined, 'cleared once the turn ended');
    await framework.stop();
  });

  it('a gate-batched wake (telemetry provenance only) names its author without pinning a speech locus', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t,
        counterparty: 'discord:user:7', wakeChannelId: 'discord:g:room', wakeAt: t - 500 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, undefined, 'a gate wake sets no locus');
    assert.equal(captured.handed?.addressed, false);
    assert.equal(captured.handed?.counterparty, 'discord:user:7');
    assert.equal(captured.handed?.wakeChannelId, 'discord:g:room');
    assert.equal(captured.exposed?.counterparty, 'discord:user:7');
    await framework.stop();
  });

  it('a turn merged from several ambient batches names every channel they came from, each once', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    const room = { serverId: 'discord', channelId: 'discord:g:room' };
    const general = { serverId: 'discord', channelId: 'discord:g:general' };
    const feed = { serverId: 'discord', channelId: 'discord:g:feed' };
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'timer', source: 'clock', timestamp: t },
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t + 1, wakeChannels: [room, general] },
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t + 2, wakeChannels: [general, feed] },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.exposed?.channelId, undefined);
    assert.deepEqual(captured.exposed?.wakeChannels, [room, general, feed]);
    await framework.stop();
  });

  for (const [what, other, keeps, why] of [
    ['a wake that names a channel', { reason: 'mcpl:channel-incoming', source: 'discord', channelId: 'discord:g:feed', channelServerId: 'discord' }, false, 'the turn has a channel'],
    ['an addressed push that names no channel', { reason: 'mcpl:push-event', source: 'discord', addressed: true }, true, 'the notice says only where the turn came from and that no channel was chosen, which holds though a message addressed the agent'],
    ['an addressed chat:system notice', { reason: 'mcpl:channel-incoming', source: 'discord', channelId: 'discord:dm:5', channelServerId: 'discord', addressed: true, systemNotice: true }, true, 'a notice neither addresses the agent nor names a channel'],
  ] as const) {
    it(`a turn merged from ${what} and an ambient batch ${keeps ? 'keeps' : 'names no'} batch channels`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
      const framework = await makeFramework();
      const i = internals(framework);
      const captured = spy(framework);
      const t = Date.now();
      const batch: InferenceRequest = { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t + 1, wakeChannels: [{ serverId: 'discord', channelId: 'discord:g:room' }] };
      const wake: InferenceRequest = { agentName: 'scout', timestamp: t, ...other };
      i.pendingRequests.push(...(keeps ? [wake, batch] : [batch, wake]));
      await i.processInferenceRequests();
      await framework.runUntilIdle();
      assert.ok(captured.exposed, 'the merged turn started');
      assert.deepEqual(captured.exposed.wakeChannels, keeps ? [{ serverId: 'discord', channelId: 'discord:g:room' }] : undefined, why);
      await framework.stop();
    });
  }

  it("two ambient batches parked while the host is quiesced, coalesced into one, name both batches' channels at resume", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const room = { serverId: 'discord', channelId: 'discord:g:room' };
    const general = { serverId: 'discord', channelId: 'discord:g:general' };
    await framework.quiesce({ reason: 'test window' });
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t, wakeChannels: [room] },
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t + 1, wakeChannels: [general] },
    );
    await i.processInferenceRequests();
    assert.equal(membrane.calls.length, 0, 'premise: parked while quiesced');
    assert.equal(i.pendingRequests.length, 1, 'premise: coalesced into one');
    await framework.resume();
    await framework.runUntilIdle();
    assert.ok(captured.exposed, 'the turn started at resume');
    assert.deepEqual(captured.exposed.wakeChannels, [room, general]);
    await framework.stop();
  });

  it("a gate wake names a batch channel even when another conversation fork calls it home", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'gated.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      gate: { config: { policies: [{ name: 'batch', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 50 } }], default: 'skip' } },
    });
    const f = framework as unknown as {
      eventGate: { requestInferenceFn(agent: string, reason: string, source: string, provenance?: object): void } | null;
      channelNamed(channelId: string, serverId?: string): { serverId: string; channelId: string } | undefined;
      mayTakeGateRoute(agentName: string, route: { serverId: string; channelId: string }): boolean;
    };
    assert.ok(f.eventGate, 'premise: the framework has a gate');
    f.channelNamed = (channelId, serverId) => ({ serverId: serverId ?? 'discord', channelId });
    f.mayTakeGateRoute = (_agent, route) => route.channelId !== 'discord:g:fork-home';
    f.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', { at: Date.now(), batchChannels: [
      { channelId: 'discord:g:fork-home', serverId: 'discord' },
    ] });
    assert.deepEqual(internals(framework).pendingRequests.at(-1)?.wakeChannels, [{ serverId: 'discord', channelId: 'discord:g:fork-home' }],
      'the agent is told where its batch came from, and may send there explicitly');
    await framework.stop();
  });

  it("a provider hold that keeps one of two equal gate wakes keeps both batches' channels", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'held.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    const i = framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
      providerAccelerationCooldowns: Map<string, { startedAt: number; until: number; timer: ReturnType<typeof setTimeout>; heldRequests: Array<{ wakeChannels?: unknown }>; reason: string; failures: number }>;
    };
    const now = Date.now();
    const timer = setTimeout(() => {}, 60_000);
    try {
      i.providerAccelerationCooldowns.set('scout', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'test hold', failures: 1 });
      const wake = (channelId: string) => ({ agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now, wakeChannels: [{ serverId: 'discord', channelId }] });
      i.pendingRequests.push(wake('discord:g:a'), wake('discord:g:b'));
      await framework.runUntilIdle();
      const held = i.providerAccelerationCooldowns.get('scout')!.heldRequests;
      assert.equal(held.length, 1, 'premise: the hold keeps one of the two equal wakes');
      assert.deepEqual(held[0]!.wakeChannels, [{ serverId: 'discord', channelId: 'discord:g:a' }, { serverId: 'discord', channelId: 'discord:g:b' }]);
    } finally {
      clearTimeout(timer);
      await framework.stop();
    }
  });

  it("a gate wake names a batch channel once, though the batch gave it both with its server and without", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'twice.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      gate: { config: { policies: [{ name: 'batch', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 50 } }], default: 'skip' } },
    });
    const f = framework as unknown as {
      eventGate: { requestInferenceFn(agent: string, reason: string, source: string, provenance?: object): void } | null;
      channelNamed(channelId: string, serverId?: string): { serverId: string; channelId: string } | undefined;
    };
    assert.ok(f.eventGate, 'premise: the framework has a gate');
    f.channelNamed = (channelId, serverId) => ({ serverId: serverId ?? 'discord', channelId });
    f.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', { at: Date.now(), batchChannels: [
      { channelId: 'discord:g:room', serverId: 'discord' },
      { channelId: 'discord:g:room' },
    ] });
    assert.deepEqual(internals(framework).pendingRequests.at(-1)?.wakeChannels, [{ serverId: 'discord', channelId: 'discord:g:room' }]);
    await framework.stop();
  });

  it("a coalesced render whose latest occurrence is a notice still names its channel at the gate, since it folds the batch's messages too", async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'render.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      gate: { config: { policies: [{ name: 'batch', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 30 } }], default: 'skip' } },
    });
    const f = framework as unknown as {
      eventGate: { requestInferenceFn(agent: string, reason: string, source: string, provenance?: { batchChannels?: unknown }): void } | null;
      queueCoalescedWakes(occ: unknown): Promise<void>;
    };
    assert.ok(f.eventGate, 'premise: the framework has a gate');
    const provenances: Array<{ batchChannels?: unknown } | undefined> = [];
    f.eventGate.requestInferenceFn = (_agent, _reason, _source, provenance) => { provenances.push(provenance); };
    const text = [{ type: 'text', text: 'pat joined' }];
    await f.queueCoalescedWakes({
      serverId: 'discord', binding: 'b1', scope: { kind: 'channel', id: 'discord:g:room' }, key: 'k1', eventId: 'ev-1',
      timestamp: new Date().toISOString(), retract: false, deferred: true, initial: false, tags: ['chat:system'], content: text,
      event: { lane: 'push', event: { triggerInference: true, origin: { mcplChannelId: 'discord:g:room' }, content: text, featureSet: 'chat' } },
    });
    for (let i = 0; i < 100 && provenances.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(provenances.map((p) => p?.batchChannels), [[{ channelId: 'discord:g:room', serverId: 'discord' }]]);
    await framework.stop();
  });

  it('a gate wake queued after a NEWER addressed direct wake does not take the turn', async () => {
    // The agent was busy: Alice's DM sat in the gate's buffer while Bob's
    // newer mention queued a direct wake. The gate flushed at turn end, so its
    // request is queued AFTER Bob's but describes an OLDER event.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi bob' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:bob-room', counterparty: 'discord:user:bob', addressed: true },
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t + 5_000,
        channelId: 'discord:dm:alice', addressed: true, counterparty: 'discord:user:alice', wakeAt: t - 2_000 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, 'discord:g:bob-room', 'the newer addressed EVENT wins, not the later-queued request');
    assert.equal(captured.handed?.counterparty, 'discord:user:bob');
    await framework.stop();
  });

  it('an addressed winner with no author never borrows another request\'s author', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:general', counterparty: 'discord:user:carol', addressed: false },
      // An addressed push routed by origin.mcplChannelId alone: no author id.
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t + 1,
        channelId: 'surface:dm:42', addressed: true, wakeAt: t + 1 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, 'surface:dm:42');
    assert.equal(captured.handed?.counterparty, undefined, 'carol did not address the agent');
    await framework.stop();
  });

  it('a context-budget restart batched with an addressed wake starts alone, naming no author, and the wake then starts a turn of its own', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continuing' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const handed: Array<InferenceRequest | undefined> = [];
    const orig = i.startAgentStream.bind(framework);
    i.startAgentStream = async (agent: unknown, trigger?: InferenceRequest) => {
      handed.push(trigger);
      // The mock hands a stream every response queued when it's made, so the
      // second turn's answer is queued as that turn starts.
      if (handed.length === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi alice' }]));
      return orig(agent, trigger);
    };
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:alice-room', counterparty: 'discord:user:alice', addressed: true },
      { agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: t + 1 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();

    assert.deepEqual(handed.map((r) => r?.reason), ['context_budget_restart', 'mcpl:channel-incoming'],
      'the restart starts alone, and the wake starts a turn of its own after it');
    assert.equal(handed[0]?.counterparty, undefined, 'a restart is its own cause: no borrowed author');
    assert.equal(handed[0]?.channelId, undefined, "nor the wake's channel");
    assert.equal(handed[1]?.channelId, 'discord:g:alice-room');
    assert.equal(handed[1]?.counterparty, 'discord:user:alice', "the wake's turn names its own author");
    await framework.stop();
  });
  it('a wake merged again after a stated wait held it answers the newest addressed message, as one merge of its wakes does', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi bob' }]));
    const framework = await makeFramework();
    const i = internals(framework) as ReturnType<typeof internals> & {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
      providerAccelerationCooldowns: Map<string, { heldRequests: InferenceRequest[] }>;
    };
    const handed: Array<InferenceRequest | undefined> = [];
    const orig = i.startAgentStream.bind(framework) as (...args: unknown[]) => Promise<void>;
    (i as unknown as { startAgentStream: (...args: unknown[]) => Promise<void> }).startAgentStream = (...args) => {
      handed.push(args[1] as InferenceRequest | undefined);
      return orig(...args);
    };
    const t = Date.now();
    let fail!: (error: Error) => void;
    const auxiliary = i.withAuxiliaryAdmission('scout', () => new Promise<void>((_, reject) => { fail = reject; }), 'test-model').catch(() => {});
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'timer', source: 'clock', timestamp: t - 3_000 },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t - 1_000,
        channelId: 'discord:g:bob-room', counterparty: 'discord:user:bob', addressed: true },
    );
    await i.processInferenceRequests();
    fail(new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000,
      message: 'rate limit reached', rawError: { status: 429 } } as ConstructorParameters<typeof MembraneError>[0]));
    await auxiliary;
    const deadline = performance.now() + 10_000;
    while ((i.providerAccelerationCooldowns.get('scout')?.heldRequests.length ?? 0) === 0) {
      assert.ok(performance.now() < deadline, 'the merged wake held by the wait');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: t,
        channelId: 'discord:dm:alice', addressed: true, counterparty: 'discord:user:alice', wakeAt: t - 2_000 },
    );
    await i.processInferenceRequests();
    framework.releaseProviderWait('scout');
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(handed.at(-1)?.channelId, 'discord:g:bob-room', 'the newer addressed event wins');
    assert.equal(handed.at(-1)?.counterparty, 'discord:user:bob');
    await framework.stop();
  });
});
