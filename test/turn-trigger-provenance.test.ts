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
import { AgentFramework, readInboundSource } from '../src/index.js';
import { isNonChannelSurfaceEvent } from '../src/framework.js';
import type { InferenceRequest, Module, ProcessEvent, ProcessState, EventResponse } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';


class SurfaceModule implements Module {
  readonly name = 'surface';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message' && event.type !== 'api:message') return {};
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: true,
    };
  }
}

function internals(framework: AgentFramework) {
  return framework as unknown as {
    pendingRequests: InferenceRequest[];
    processInferenceRequests(): Promise<void>;
    startAgentStream(agent: unknown, trigger?: InferenceRequest): Promise<void>;
  };
}

describe('non-channel surface classification', () => {
  it('treats an unknown future external-message source as private', () => {
    assert.equal(isNonChannelSurfaceEvent({
      type: 'external-message', source: 'future-operator-console', content: 'hello', metadata: {},
    } as never), true);
    assert.equal(isNonChannelSurfaceEvent({
      type: 'external-message', source: 'future-operator-console', content: 'hello', metadata: { channelId: 'discord:g:room' },
    } as never), false);
    assert.equal(isNonChannelSurfaceEvent({
      type: 'external-message', source: 'bridge', content: 'hello', metadata: { channelId: 'discord:g:room' },
    }), false);
    assert.equal(isNonChannelSurfaceEvent({
      type: 'api:message', participant: 'user', content: 'hello', metadata: { channelId: 'discord:g:api' },
    } as never), false);
    assert.equal(isNonChannelSurfaceEvent({
      type: 'external-message', source: 'bridge', content: 'hello', metadata: { channelId: '' },
    }), true);
    assert.equal(isNonChannelSurfaceEvent({
      type: 'external-message', source: 'bridge', content: 'hello', metadata: { channelId: '   ' },
    }), true, 'whitespace names no channel');
    assert.equal(isNonChannelSurfaceEvent({ type: 'mcpl:channel-incoming', channelId: 'room' } as never), false);
  });
});

describe('surface provenance through the real scheduler', () => {
  it("a batch that holds a private surface's wake is private, whatever else it holds, and routes no prose", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'surface-mixed-test-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'OPERATOR-ONLY' }]));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }],
      modules: [new SurfaceModule()],
    });
    const i = internals(framework);
    const routed: Array<{ text: string; locus: string | null }> = [];
    i.pendingRequests.push({ agentName: 'scout', reason: 'mcpl:push-event', source: 'feeds', timestamp: Date.now() });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelTools: () => [], resolveLocus: () => 'discord:g:lounge',
      routeSpeech: async (_agent: string, text: string, locus: string | null) => {
        routed.push({ text, locus }); return { delivered: true, channelId: locus };
      }, getDescriptor: () => undefined, getDefaultPublishChannel: () => 'discord:g:lounge',
    }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'private question', metadata: {}, triggerInference: true });
    await framework.runUntilIdle();
    assert.deepEqual(routed, []);
    const routing = (framework as unknown as { turnRouting: Map<string, { nonChannelOrigin?: boolean; locus?: string }> }).turnRouting.get('scout');
    assert.equal(routing?.nonChannelOrigin, true);
    assert.equal(routing?.locus, undefined);
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  for (const channelId of ['discord:g:room', '   ']) {
    it(`a surface message whose metadata names ${channelId.trim() ? 'a channel opens no private turn, and its message carries no surface stamp' : 'only whitespace is private, and its message is stamped as a surface\'s'}`, async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'surface-channel-test-'));
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([]));
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }],
        modules: [new SurfaceModule()],
      });
      let handed: InferenceRequest | undefined;
      const i = internals(framework);
      const start = i.startAgentStream.bind(framework);
      i.startAgentStream = async (agent, trigger) => { handed = trigger; return start(agent, trigger); };
      framework.pushEvent({
        type: 'external-message', source: 'bridge', content: 'surface input', metadata: { channelId }, triggerInference: true,
      });
      await framework.runUntilIdle();
      const named = channelId.trim() !== '';
      assert.equal(handed?.nonChannelOrigin === true, !named, JSON.stringify(handed));
      const stored = framework.getAgent('scout')!.getContextManager().getAllMessages()
        .find((m) => JSON.stringify(m.content).includes('surface input'));
      assert.ok(stored, 'control: the message was stored');
      assert.equal(readInboundSource(stored!.metadata)?.kind === 'surface', !named, JSON.stringify(stored!.metadata));
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    });
  }
});

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

  it('a context-budget restart keeps the channel for routing but names no author', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continuing' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:alice-room', counterparty: 'discord:user:alice', addressed: true },
      { agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: t + 1 },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();

    assert.equal(captured.handed?.reason, 'context_budget_restart');
    assert.equal(captured.handed?.channelId, 'discord:g:alice-room', 'routing channel is kept');
    assert.equal(captured.handed?.counterparty, undefined, 'a restart is its own cause — no borrowed author');
    await framework.stop();
  });
});

// ---------------------------------------------------------------------------
// Private wins, one way: a start whose batch holds a private surface's wake
// is private, whatever else it holds; a turn that takes in private input
// stays private for the rest of it; and a private turn's sends name where
// they go.
// ---------------------------------------------------------------------------

const ROOM = 'discord:g:room';
const tuiMessage = (content = 'private question') =>
  ({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true }) as never;

/** A framework whose turns are recorded as they start, with a registry that
 *  records routed speech and resolves a turn's locus to its trigger channel,
 *  as the real registry's active-channel resolution does. */
async function surfaceRig(opts: {
  gate?: unknown; maxStreamTokens?: number; modules?: Module[]; agent?: Record<string, unknown>;
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'surface-edges-test-'));
  const membrane = new MockMembrane();
  // A mock stream takes every response queued when it starts, so each stream
  // gets a reply of its own as it starts, unless the test queued one.
  const streamYielding = membrane.streamYielding.bind(membrane);
  let replies = 0;
  const streams: Array<NonNullable<MockMembrane['lastStream']>> = [];
  membrane.streamYielding = (request, options) => {
    const queue = membrane as unknown as { responses: unknown[]; responseIndex: number };
    if (queue.responseIndex >= queue.responses.length) membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply ${++replies}` }]));
    const stream = streamYielding(request, options);
    streams.push(membrane.lastStream!);
    return stream;
  };
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(),
    agents: [{
      name: 'scout', model: 'test-model', systemPrompt: 'scout',
      ...(opts.maxStreamTokens !== undefined ? { maxStreamTokens: opts.maxStreamTokens } : {}),
      ...opts.agent,
    }],
    modules: [new SurfaceModule(), ...(opts.modules ?? [])],
    ...(opts.gate ? { gate: opts.gate } : {}),
  } as never);
  const routed: Array<{ text: string; locus: string | null }> = [];
  const typing: string[] = [];
  // While held, every post waits, as a slow one does, so a round's queued
  // delivery can run after its boundary (holdRoutes).
  let routeGate: Promise<void> | undefined;
  const holdRoutes = (): (() => void) => {
    let release!: () => void;
    routeGate = new Promise((resolve) => { release = resolve; });
    return () => { routeGate = undefined; release(); };
  };
  const state = framework as unknown as {
    turnRouting: Map<string, { nonChannelOrigin?: boolean; triggerChannel?: string; locus?: string; pin?: string }>;
    openLogical: Map<string, unknown>;
    channelRegistry: unknown;
  };
  state.channelRegistry = new Proxy({
    getChannelTools: () => [],
    resolveLocus: (agentName: string) => state.turnRouting.get(agentName)?.triggerChannel ?? 'discord:g:lounge',
    routeSpeech: async (_agent: string, text: string, locus: string | null) => {
      if (routeGate) await routeGate;
      routed.push({ text, locus }); return { delivered: true, channelId: locus };
    },
    // A named or sticky destination posts through deliverSpeech, which
    // reports the post's outcome, as the real registry does.
    deliverSpeech: async (_agent: string, text: string, channelId: string) => {
      if (routeGate) await routeGate;
      routed.push({ text, locus: channelId });
      return { status: 'delivered', destination: { serverId: 'discord', channelId }, at: Date.now() };
    },
    resolveProseTarget: (target: string) => ({ channelId: target }),
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'discord', channelId } }),
    getDescriptor: () => undefined, getDefaultPublishChannel: () => 'discord:g:lounge',
    startTyping: (channelId: string) => { typing.push(channelId); },
  }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
  const i = internals(framework);
  const starts: InferenceRequest[] = [];
  const start = i.startAgentStream.bind(framework);
  // Each start's routing as its stream begins, in order of the starts.
  const routings: Array<{ nonChannelOrigin?: boolean; triggerChannel?: string; locus?: string; pin?: string }> = [];
  i.startAgentStream = async (agent, trigger) => {
    if (trigger) starts.push(trigger);
    const result = await start(agent, trigger);
    routings.push(state.turnRouting.get('scout')!);
    return result;
  };
  // Polls while the scheduler runs: a debounce's wake is queued by its
  // timer, after the test has pushed its events. One drive of the scheduler
  // runs at a time, and the condition is looked at every few milliseconds
  // while it does, since a held post can keep it from going idle. The
  // deadline bounds a scheduler that never goes idle too, failing the wait
  // rather than hanging it.
  const until = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    const timedOut = () => new Error(`timed out: ${what} (starts: ${JSON.stringify(starts)})`);
    while (!cond()) {
      if (Date.now() > deadline) throw timedOut();
      await new Promise((r) => setTimeout(r, 10));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          framework.runUntilIdle(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), Math.max(0, deadline - Date.now())); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  /** Polls a condition while the scheduler runs on its own, for a turn whose
   *  held posts keep it from going idle (holdRoutes). */
  const whileRunning = async (cond: () => boolean, what: string) => {
    void framework.runUntilIdle();
    const deadline = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what} (starts: ${JSON.stringify(starts)})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** The text of every message in the agent's store. */
  const texts = () => (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
    .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
  return {
    framework, membrane, streams, routed, typing, starts, routings, state, i, until, whileRunning, texts, holdRoutes,
    close: async () => { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); },
  };
}

const privateStart = (r: InferenceRequest) => r.nonChannelOrigin === true && !r.channelId;
const roomStart = (r: InferenceRequest) => r.channelId === ROOM && r.nonChannelOrigin !== true;
type Routing = Record<string, unknown>;
const routingOf = (framework: AgentFramework): Routing =>
  (framework as unknown as { routingOf(name: string): Routing }).routingOf('scout');
const tuiWake = (): InferenceRequest => ({ agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: Date.now(), nonChannelOrigin: true });
const roomWake = (): InferenceRequest => ({
  agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), channelId: ROOM, addressed: true,
});
/** A tool whose call runs `during` before it answers, as a tool that takes a
 *  moment does, so what `during` brings in lands before the round's results. */
const robot = (during: () => void = () => {}, result: { endTurn?: boolean } = {}) => ({
  name: 'robot',
  async start() {}, async stop() {},
  getTools: () => [{ name: 'move', description: 'Move', inputSchema: { type: 'object', properties: {} } }],
  async handleToolCall() {
    during();
    await new Promise((r) => setTimeout(r, 30));
    return { success: true, data: 'moved', ...result };
  },
  async onProcess() { return {}; },
}) as unknown as Module;
const PRIVATE_FROM_HERE = '[routing] A message from a private surface came into this turn';
/** An operator's message stored with a private surface's stamp, as the
 *  framework stamps one (surfaceSourceFor), its wake still to come. */
const storeOperatorMessage = (framework: AgentFramework) =>
  (framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown }).addMessage(
    'user', [{ type: 'text', text: 'for your eyes only' }], { inboundSource: { kind: 'surface', surface: 'tui', acceptedAt: Date.now() } });

describe('private wins, one way', () => {
  it("a batch that holds a private wake and a room's addressed one starts one private turn, in either order", async () => {
    for (const privateFirst of [true, false]) {
      const framework = await AgentFramework.create({
        storePath: join(mkdtempSync(join(tmpdir(), 'private-batch-test-')), 'store'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [],
      });
      const i = internals(framework);
      const captured: InferenceRequest[] = [];
      i.startAgentStream = async (_agent: unknown, trigger?: InferenceRequest) => { if (trigger) captured.push(trigger); };
      const wakes = [tuiWake(), roomWake()];
      i.pendingRequests.push(...(privateFirst ? wakes : wakes.reverse()));
      await i.processInferenceRequests();
      const label = privateFirst ? 'private first' : 'room first';
      assert.equal(captured.length, 1, `${label}: one start takes both`);
      assert.equal(i.pendingRequests.length, 0, `${label}: nothing is requeued`);
      assert.ok(privateStart(captured[0]!), `${label}: ${JSON.stringify(captured[0])}`);
      assert.equal(captured[0]!.addressed, false, `${label}: the private turn answers in no channel`);
      await framework.stop();
    }
  });

  it('a gate window with a private message and an addressed room message wakes one private turn, which routes nothing', async () => {
    const gate = { config: { policies: [{ name: 'both', match: { scope: ['external-message', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate });
    try {
      const eventGate = (rig.framework as unknown as { eventGate: { evaluate(info: Record<string, unknown>): unknown } }).eventGate;
      rig.framework.pushEvent(tuiMessage());
      eventGate.evaluate({
        content: 'over here', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
        metadata: { author: { id: 'u1' } }, tags: ['chat:addressed'],
      });
      await rig.until(() => rig.starts.length >= 1, 'the turn');
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts.length, 1, JSON.stringify(rig.starts));
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.deepEqual(rig.routed, [], 'nothing is routed');
    } finally {
      await rig.close();
    }
  });

  it('a quiesce keeps a private wake apart from another with the same reason, so the newer one evicts neither', async () => {
    const rig = await surfaceRig();
    try {
      await rig.framework.quiesce();
      const now = Date.now();
      // As a debounce flush just before the quiesce leaves them: a private
      // window's wake, then another's.
      rig.i.pendingRequests.push(
        { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now, nonChannelOrigin: true },
        { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now + 1 },
      );
      await rig.i.processInferenceRequests();
      assert.equal(rig.starts.length, 0, 'control: nothing starts while quiesced');
      await rig.framework.resume();
      await rig.until(() => rig.starts.length >= 1, 'the turn after resume');
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts.length, 1, JSON.stringify(rig.starts));
      assert.ok(privateStart(rig.starts[0]!), `the private wake makes its turn private: ${JSON.stringify(rig.starts[0])}`);
      assert.deepEqual(rig.routed, [], 'nothing is routed');
    } finally {
      await rig.close();
    }
  });

  it('a provider hold keeps a private wake beside another with the same reason, source and time', async () => {
    const rig = await surfaceRig();
    try {
      const cooldowns = (rig.framework as unknown as { providerAccelerationCooldowns: Map<string, Record<string, unknown>> }).providerAccelerationCooldowns;
      const now = Date.now();
      const timer = setTimeout(() => {}, 60_000);
      try {
        cooldowns.set('scout', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'a test hold', failures: 1 });
        rig.i.pendingRequests.push(
          { agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: now },
          { agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: now, nonChannelOrigin: true },
        );
        await rig.i.processInferenceRequests();
        const held = cooldowns.get('scout')!.heldRequests as InferenceRequest[];
        assert.equal(held.length, 2, JSON.stringify(held));
        assert.ok(held.some((r) => r.nonChannelOrigin === true), 'the private wake is held, not dropped as the same wake');
      } finally {
        clearTimeout(timer);
        cooldowns.delete('scout');
        rig.i.pendingRequests.length = 0;
      }
    } finally {
      await rig.close();
    }
  });

  it('a continuation that takes in a private wake makes its channel turn private from there, and says so, in either order', async () => {
    for (const [mode, privateFirst] of [['locus', false], ['locus', true], ['hybrid', false]] as const) {
      const rig = await surfaceRig({ agent: { proseRouting: mode } });
      const label = `${mode}, ${privateFirst ? 'the private wake' : 'the continuation'} queued first`;
      try {
        // An open channel turn, as a stream that ended on tool use leaves one
        // for the non-streaming fallback's tool_results_ready to continue. In
        // hybrid mode an earlier `>>>` set a sticky destination.
        const routing = routingOf(rig.framework);
        routing.triggerChannel = ROOM;
        routing.locus = ROOM;
        if (mode === 'hybrid') routing.pin = 'discord:g:other';
        rig.state.openLogical.set('scout', routing);
        // An addressed message in another channel arrived earlier, which the
        // channel turn would follow at its next start (TurnRouting.arrivals).
        const arrivalMeta = { channelId: 'discord:g:elsewhere', tags: ['chat:addressed'], source: 'mcpl:channel-incoming' };
        const arrivalId = rig.framework.getAgent('scout')!.getContextManager().addMessage('user', [{ type: 'text', text: 'over here' }], arrivalMeta as never);
        (rig.framework as unknown as { noteArrival(agentName: string, metadata: unknown, id: unknown): void }).noteArrival('scout', arrivalMeta, arrivalId);
        assert.equal((routing.arrivals as unknown[]).length, 1, `${label}: control: the arrival is noted`);
        const continuation: InferenceRequest = { agentName: 'scout', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() };
        rig.i.pendingRequests.push(...(privateFirst ? [tuiWake(), continuation] : [continuation, tuiWake()]));
        await rig.until(() => rig.starts.length >= 1, 'the continuation');
        await rig.framework.runUntilIdle();
        assert.equal(rig.starts.length, 1, `${label}: one start takes both: ${JSON.stringify(rig.starts)}`);
        assert.ok(privateStart(rig.starts[0]!), `${label}: ${JSON.stringify(rig.starts[0])}`);
        assert.equal(routing.nonChannelOrigin, true, `${label}: the turn is private now`);
        assert.equal(routing.locus, undefined, `${label}: its locus is gone, and no earlier arrival moved it back`);
        assert.equal(routing.pin, undefined, `${label}: and so is its sticky destination`);
        assert.equal(routing.triggerChannel, undefined, `${label}: and its trigger channel`);
        assert.deepEqual(routing.arrivals, [], `${label}: and its arrivals`);
        assert.deepEqual(rig.routed, [], `${label}: its speech went to no channel`);
        const notice = rig.texts().find((t) => t.startsWith(PRIVATE_FROM_HERE)) ?? '';
        assert.ok(notice, `${label}: the agent is told: ${JSON.stringify(rig.texts())}`);
        assert.equal(notice.includes('or a >>> envelope'), mode === 'hybrid', `${label}: ${notice}`);
      } finally {
        await rig.close();
      }
    }
  });

  it("a room's wake that continues an open private turn leaves it private: no typing in the room, and nothing new said", async () => {
    for (const mode of ['locus', 'explicit'] as const) {
      const rig = await surfaceRig({ agent: { proseRouting: mode } });
      try {
        // A private turn open between its streams, as a capacity hold or a
        // tool wait leaves one, when an addressed room message comes.
        const routing = routingOf(rig.framework);
        routing.nonChannelOrigin = true;
        rig.state.openLogical.set('scout', routing);
        // Explicit mode bounces unprefixed prose, which would wake again.
        if (mode === 'explicit') rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 1, 'the start');
        await rig.framework.runUntilIdle();
        assert.equal(rig.starts.length, 1, `${mode}: ${JSON.stringify(rig.starts)}`);
        assert.equal(routing.nonChannelOrigin, true, `${mode}: the turn stays private`);
        assert.ok(!rig.typing.includes(ROOM), `${mode}: no typing in the room: ${JSON.stringify(rig.typing)}`);
        assert.deepEqual(rig.routed, [], `${mode}: nothing is routed`);
        assert.ok(!rig.texts().some((t) => t.startsWith(PRIVATE_FROM_HERE)), `${mode}: it was private already`);
      } finally {
        rig.state.openLogical.delete('scout');
        await rig.close();
      }
    }
  });

  it("a budget restart of a private turn is private, and a room's wake that arrived meanwhile gives it no channel", async () => {
    // The tool round reports 10 input tokens, over the agent's budget of 5, so
    // its boundary restarts the stream; the tool's own work brings in the
    // room's addressed wake while the turn is running.
    let framework: AgentFramework | undefined;
    const tool = robot(() => { internals(framework!).pendingRequests.push(roomWake()); });
    const rig = await surfaceRig({ maxStreamTokens: 5, modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 2, 'the turn and its restart');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.starts.map((s) => s.reason), ['external-message', 'context_budget_restart'], JSON.stringify(rig.starts));
      assert.ok(rig.starts.every(privateStart), `both starts are private: ${JSON.stringify(rig.starts)}`);
      assert.deepEqual(rig.routed, [], "the private turn's speech stayed on its surface");
    } finally {
      await rig.close();
    }
  });

  it("a boundary that injects a private surface's message makes the room's turn private from there, and its notice rides the injections", async () => {
    let framework: AgentFramework | undefined;
    const tool = robot(() => framework!.pushEvent(tuiMessage('for your eyes only')));
    const rig = await surfaceRig({ modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'on my way' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
      rig.i.pendingRequests.push(roomWake());
      // The room's turn, then the operator message's own private turn.
      await rig.until(() => rig.starts.length >= 2, "the room's turn, then the operator message's");
      await rig.framework.runUntilIdle();
      assert.ok(roomStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.ok(privateStart(rig.starts[1]!), JSON.stringify(rig.starts[1]));
      assert.deepEqual(rig.routed, [{ text: 'on my way', locus: ROOM }], 'only the round before the injection went to the room');
      const wired = rig.streams[0]!.receivedToolResultOptions
        .flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
      assert.ok(wired.some((w) => w.includes('for your eyes only')), `control: the operator's message was injected: ${JSON.stringify(wired)}`);
      assert.ok(wired.some((w) => w.includes(PRIVATE_FROM_HERE)), `the notice rode the injections: ${JSON.stringify(wired)}`);
      const told = rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE) || t.startsWith('[routing] Your plain speech currently goes to no channel'));
      assert.equal(told.length, 1, `the agent is told once, the private turn after it included: ${JSON.stringify(told)}`);
    } finally {
      await rig.close();
    }
  });

  it("a private surface's message a start's flush stores makes that start's turn private, though its wake hasn't come, and says why", async () => {
    // As when its wake waits in a gate window: the message was deferred while
    // a turn was alive, and the next start's flush stores it.
    for (const opens of [true, false]) {
      const rig = await surfaceRig();
      const label = opens ? 'a start that opens a turn' : 'a start that continues a channel turn';
      try {
        const internalsOf = rig.framework as unknown as { deferredMessages: unknown[] };
        internalsOf.deferredMessages.push({
          id: `deferred-${opens}`, seq: 1, participant: 'user', content: [{ type: 'text', text: 'for your eyes only' }],
          metadata: { inboundSource: { kind: 'surface', surface: 'tui', acceptedAt: Date.now() } }, heldAt: Date.now(),
        });
        const routing = routingOf(rig.framework);
        if (!opens) {
          routing.triggerChannel = ROOM;
          routing.locus = ROOM;
          rig.state.openLogical.set('scout', routing);
        }
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 1, 'the start');
        await rig.framework.runUntilIdle();
        assert.ok(rig.texts().includes('for your eyes only'), `${label}: control: the start's flush stored it`);
        const turn = rig.routings[0]!;
        assert.equal(turn.nonChannelOrigin, true, `${label}: the turn is private`);
        assert.equal(turn.triggerChannel, undefined, `${label}: and names no trigger channel`);
        assert.deepEqual(rig.routed, [], `${label}: nothing is routed`);
        assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, `${label}: told why, once`);
      } finally {
        rig.state.openLogical.delete('scout');
        await rig.close();
      }
    }
  });

  it("a private message stored while the agent is idle makes its next start private, and only that one", async () => {
    const rig = await surfaceRig();
    try {
      // Stored at once, its wake still to come, as when the wake waits in a
      // gate window or the message wakes nothing.
      storeOperatorMessage(rig.framework);
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1, "the room's start");
      await rig.framework.runUntilIdle();
      assert.equal(rig.routings[0]!.nonChannelOrigin, true, 'the start that reads it is private');
      assert.equal(rig.routed.length, 0, `its reply went to no channel: ${JSON.stringify(rig.routed)}`);
      assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, 'and the resident is told why');
      // The mark is spent: the room's next message gets its reply.
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's next start");
      await rig.framework.runUntilIdle();
      assert.notEqual(rig.routings[1]!.nonChannelOrigin, true, 'a later start is a channel turn');
      assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM], JSON.stringify(rig.routed));
    } finally {
      await rig.close();
    }
  });

  it("a silent start leaves the mark of a stored private message to the next start", async () => {
    const rig = await surfaceRig();
    try {
      storeOperatorMessage(rig.framework);
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
      await rig.until(() => rig.starts.length >= 1, 'the silent start');
      await rig.framework.runUntilIdle();
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's start");
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts[0]!.suppressProse, true, 'control: the first start was silent');
      assert.equal(rig.routings[1]!.nonChannelOrigin, true, "the room's start, the first to publish, is private");
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a round written before the turn turned private, delivered after it, sets no destination for the turn's later speech", async () => {
    for (const mode of ['hybrid', 'explicit'] as const) {
      const prefix = mode === 'hybrid' ? '>>>' : '>>';
      let framework: AgentFramework | undefined;
      const tool = robot(() => framework!.pushEvent(tuiMessage('for your eyes only')));
      const rig = await surfaceRig({ modules: [tool], agent: { proseRouting: mode } });
      framework = rig.framework;
      // A held post is released before the rig stops, whatever failed.
      let release = (): void => {};
      try {
        // Round 1, before the private input: words for the room, then a
        // destination for later speech, whose posts wait until released.
        release = rig.holdRoutes();
        rig.membrane.pushResponse(createMockResponse([
          { type: 'text', text: `${prefix}${ROOM} on my way\n${prefix}discord:g:other and over there` },
          { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
        ] as never, 'tool_use'));
        // Round 2, after it: unprefixed words that answer the operator.
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
        rig.i.pendingRequests.push(roomWake());
        await rig.whileRunning(() => rig.state.turnRouting.get('scout')?.nonChannelOrigin === true, `${mode}: the boundary makes the turn private`);
        const turn = rig.state.turnRouting.get('scout')!;
        assert.equal(turn.triggerChannel, undefined, `${mode}: the private turn names no trigger channel`);
        release();
        await rig.until(() => rig.starts.length >= 2, `${mode}: the operator message's own turn`);
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed.map((r) => r.text), ['on my way', 'and over there'],
          `${mode}: round 1's words went where they named, and nothing after: ${JSON.stringify(rig.routed)}`);
        assert.equal(turn.pin, undefined, `${mode}: no destination was set again`);
      } finally {
        release();
        await rig.close();
      }
    }
  });

  it('a turn whose private notice cannot be stored is private all the same', async () => {
    const rig = await surfaceRig();
    try {
      const cm = rig.framework.getAgent('scout')!.getContextManager() as unknown as { addMessage(...args: unknown[]): unknown };
      const add = cm.addMessage.bind(cm);
      cm.addMessage = (participant: unknown, content: unknown, metadata: unknown) => {
        if ((metadata as { kind?: string } | undefined)?.kind === 'routing-notice') throw new Error('the store is full');
        return add(participant, content, metadata);
      };
      const announced = (rig.framework as unknown as { lastAnnouncedLocus: Map<string, string | null> }).lastAnnouncedLocus;
      announced.set('scout', ROOM);
      const routing = routingOf(rig.framework);
      routing.triggerChannel = ROOM;
      routing.locus = ROOM;
      rig.state.openLogical.set('scout', routing);
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() }, tuiWake());
      await rig.until(() => rig.starts.length >= 1, 'the continuation');
      await rig.framework.runUntilIdle();
      assert.equal(routing.nonChannelOrigin, true, 'the turn is private');
      assert.equal(routing.locus, undefined);
      assert.deepEqual(rig.routed, [], 'and its speech went to no channel');
      assert.equal(announced.get('scout'), ROOM, 'the announce baseline stays what the resident was last told');
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });

  it("a continuation of a private turn keeps a destination the private turn chose", async () => {
    const rig = await surfaceRig({ agent: { proseRouting: 'hybrid' } });
    try {
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      routing.pin = 'discord:g:other';
      rig.state.openLogical.set('scout', routing);
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() }, tuiWake());
      await rig.until(() => rig.starts.length >= 1, 'the continuation');
      await rig.framework.runUntilIdle();
      assert.equal(routing.pin, 'discord:g:other', 'its own destination stays');
      assert.deepEqual(rig.routed, [{ text: 'reply 1', locus: 'discord:g:other' }], 'and its speech follows it');
      assert.ok(!rig.texts().some((t) => t.startsWith(PRIVATE_FROM_HERE)), 'it was private already');
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });

  it("a private turn's sleep announcement is posted nowhere, where a channel turn's goes to its locus", async () => {
    for (const privateTurn of [true, false]) {
      const rig = await surfaceRig({ gate: { config: { policies: [], default: 'always' } } });
      const internalsOf = rig.framework as unknown as {
        dispatchSleepToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
        eventGate: { clearSleep(): unknown };
      };
      try {
        const routing = routingOf(rig.framework);
        routing.locus = ROOM;
        if (privateTurn) { delete routing.locus; routing.nonChannelOrigin = true; }
        rig.state.turnRouting.set('scout', routing as never);
        internalsOf.dispatchSleepToolCall('scout', { id: 's1', name: 'sleep', input: { seconds: 60, message: 'going quiet' } });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(rig.routed, privateTurn ? [] : [{ text: 'going quiet', locus: ROOM }], JSON.stringify(rig.routed));
      } finally {
        internalsOf.eventGate.clearSleep();
        await rig.close();
      }
    }
  });

  it('a boundary that ends the turn leaves it as it is, and the private message waits for its own private turn', async () => {
    let framework: AgentFramework | undefined;
    const tool = robot(() => framework!.pushEvent(tuiMessage('for your eyes only')), { endTurn: true });
    const rig = await surfaceRig({ modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'on my way' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's turn, then the operator message's");
      await rig.framework.runUntilIdle();
      assert.ok(roomStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.notEqual(rig.routings[0]!.nonChannelOrigin, true, "the room's turn ended a channel turn");
      assert.ok(privateStart(rig.starts[1]!), JSON.stringify(rig.starts[1]));
      assert.deepEqual(rig.routed, [{ text: 'on my way', locus: ROOM }]);
      assert.ok(!rig.texts().some((t) => t.startsWith(PRIVATE_FROM_HERE)), 'nothing made the ended turn private');
    } finally {
      await rig.close();
    }
  });

  it("a channel_open answered after its turn turned private moves neither the locus nor the trigger channel", async () => {
    const rig = await surfaceRig();
    try {
      let answer!: (result: unknown) => void;
      const internalsOf = rig.framework as unknown as {
        channelRegistry: Record<string, unknown>;
        dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
        makeTurnPrivate(agent: unknown, routing: unknown): unknown;
      };
      internalsOf.channelRegistry.handleChannelToolCall = () => new Promise((resolve) => { answer = resolve; });
      const routing = routingOf(rig.framework);
      routing.triggerChannel = ROOM;
      routing.locus = ROOM;
      rig.state.openLogical.set('scout', routing);
      internalsOf.dispatchChannelToolCall('scout', { id: 'o1', name: 'channel_open', input: { channelId: 'discord:g:other' } });
      // Private input comes into the turn while the open is in flight.
      internalsOf.makeTurnPrivate(rig.framework.getAgent('scout'), routing);
      answer({ success: true, data: { channelId: 'discord:g:other' } });
      await new Promise((r) => setImmediate(r));
      assert.equal(routing.locus, undefined, 'the locus stays gone');
      assert.equal(routing.triggerChannel, undefined, 'and so does the trigger channel');
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });

  it("a private turn's channel_publish names where it goes, a fork's home included", async () => {
    const rig = await surfaceRig();
    try {
      const results: Array<{ success: boolean; error?: string }> = [];
      const internalsOf = rig.framework as unknown as {
        conversationAgentHomes: Map<string, string>;
        dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
        pushEvent(event: unknown): void;
      };
      const push = internalsOf.pushEvent.bind(rig.framework);
      internalsOf.pushEvent = (event: unknown) => {
        const e = event as { type?: string; result?: { success: boolean; error?: string } };
        if (e.type === 'tool-result' && e.result) results.push(e.result);
        else push(event);
      };
      routingOf(rig.framework).nonChannelOrigin = true;
      for (const fork of [false, true]) {
        if (fork) internalsOf.conversationAgentHomes.set('scout', ROOM);
        results.length = 0;
        internalsOf.dispatchChannelToolCall('scout', { id: `c-${fork}`, name: 'channel_publish', input: { content: 'hello' } });
        assert.equal(results[0]?.success, false, `${fork ? 'a fork' : 'a trunk agent'}: refused without a channelId`);
        assert.match(results[0]!.error!, /channel_publish requires an explicit channelId/);
        if (fork) assert.match(results[0]!.error!, new RegExp(`name "${ROOM}"`));
      }
    } finally {
      await rig.close();
    }
  });

  it("a private turn's channel_publish that names a channel goes there, and its round counts only that one as a send", async () => {
    const rig = await surfaceRig();
    try {
      const calls: Array<{ name: string; input: unknown }> = [];
      const internalsOf = rig.framework as unknown as {
        channelRegistry: Record<string, unknown>;
        dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
        executeToolCall(call: { id: string; name: string; input: unknown; callerAgentName?: string }): Promise<{ success: boolean; error?: string }>;
        roundCallOf(agentName: string, call: { name: string; input?: unknown }): { cause: string | null };
      };
      internalsOf.channelRegistry.handleChannelToolCall = async (name: string, input: unknown) => { calls.push({ name, input }); return { success: true, data: {} }; };
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      rig.state.openLogical.set('scout', routing);
      internalsOf.dispatchChannelToolCall('scout', { id: 'p1', name: 'channel_publish', input: { channelId: ROOM, content: 'hello' } });
      await rig.until(() => calls.length >= 1, 'the named publish');
      assert.deepEqual(calls.map((c) => (c.input as { channelId?: string }).channelId), [ROOM], "the model's named publish went through");
      // Its round counts a refused publish as no send, and a named one as one.
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { content: 'hello' } }).cause, null);
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { channelId: ROOM, content: 'hello' } }).cause, 'send');
      // A host's own call as the agent is its own choice, judged as main judges it.
      const hosts = await internalsOf.executeToolCall({ id: 'p2', name: 'channel_publish', input: { content: 'hello' }, callerAgentName: 'scout' });
      assert.equal(hosts.success, true, JSON.stringify(hosts));
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });

  it("a private turn's refusal reacts in no channel", async () => {
    const rig = await surfaceRig();
    try {
      const reactions: unknown[] = [];
      const internalsOf = rig.framework as unknown as {
        channelRegistry: Record<string, unknown>;
        mcplServerRegistry: unknown;
        reactToRefusal(agentName: string, category: string): Promise<void>;
      };
      Object.assign(internalsOf.channelRegistry, {
        buildChannelContext: () => ({ incoming: { channelId: 'discord:g:room', messageId: 'm1' } }),
        getChannelServerId: () => 'discord',
      });
      // No MCPL server is configured here: the stub stands in for the one
      // that owns the channel, and is taken away before the framework stops.
      const servers = internalsOf.mcplServerRegistry;
      internalsOf.mcplServerRegistry = { getServer: () => ({ sendToolsCall: async (...args: unknown[]) => { reactions.push(args); } }) };
      try {
        await internalsOf.reactToRefusal('scout', 'refusal');
        assert.equal(reactions.length, 1, 'control: a turn that is not private reacts');
        routingOf(rig.framework).nonChannelOrigin = true;
        await internalsOf.reactToRefusal('scout', 'refusal');
        assert.equal(reactions.length, 1, 'a private turn adds no reaction');
      } finally {
        internalsOf.mcplServerRegistry = servers;
      }
    } finally {
      await rig.close();
    }
  });

  it("a request a turn causes carries the turn's privacy, from the turn it names", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        derivedTurnRequest(agentName: string, reason: string, routing?: unknown): InferenceRequest;
      };
      const live = routingOf(rig.framework);
      assert.notEqual(internalsOf.derivedTurnRequest('scout', 'refusal-retry').nonChannelOrigin, true, 'control: the live turn is not private');
      live.nonChannelOrigin = true;
      for (const reason of ['refusal-retry', 'unstick-retry', 'inference-failure-rewind-retry', 'prose-continuation']) {
        assert.equal(internalsOf.derivedTurnRequest('scout', reason).nonChannelOrigin, true, reason);
      }
      // A cause named explicitly wins over the live turn, as a bounce names the
      // turn its envelope came from.
      assert.notEqual(internalsOf.derivedTurnRequest('scout', 'prose-bounce', { nonChannelOrigin: false }).nonChannelOrigin, true);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's round speech stays on its surface and is counted as kept private", async () => {
    const rig = await surfaceRig({ modules: [robot()] });
    try {
      // One stream: a round that speaks and calls a tool, then a reply.
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'on my way' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1, 'the private turn');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed, [], 'nothing is routed');
      assert.ok(rig.texts().some((t) => t.startsWith('[delivered]') && t.includes('2 plain-speech segment(s) kept private (private turn')), JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
  });

  it("a private turn's text-only reply counts each segment it kept on its surface", async () => {
    const rig = await surfaceRig();
    try {
      // Two runs of text, split by an all-refused XML round (a tool attempt
      // answered in-band by its notice): two segments, though nothing was
      // called.
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'first part' },
        { type: 'tool_attempt', rawXml: '<invoke name="read">' },
        { type: 'tool_notice', notices: [{ ordinal: 0, kind: 'refused', message: 'boundary' }] },
        { type: 'text', text: 'second part' },
      ] as never));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1, 'the private turn');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed, [], 'nothing is routed');
      assert.ok(rig.texts().some((t) => t.startsWith('[delivered]') && t.includes('2 plain-speech segment(s) kept private (private turn')), JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
  });

  it('an API message that names no channel opens a private turn', async () => {
    const rig = await surfaceRig();
    try {
      rig.framework.pushEvent({ type: 'api:message', participant: 'user', content: 'from the API', metadata: {} } as never);
      await rig.until(() => rig.starts.length >= 1, 'the turn');
      await rig.framework.runUntilIdle();
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's speech reaches modules marked private", async () => {
    const heard: Array<{ nonChannelOrigin?: boolean }> = [];
    const listener = {
      name: 'listener',
      async start(ctx: { registerSpeechHandler(name: string, options?: unknown): void }) { ctx.registerSpeechHandler('*', { additive: true }); },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false }; },
      async onProcess() { return {}; },
      async onAgentSpeech(_agent: string, _content: unknown, context: { nonChannelOrigin?: boolean }) { heard.push(context); },
    } as unknown as Module;
    const rig = await surfaceRig({ modules: [listener] });
    try {
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => heard.length >= 1, 'the speech');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => heard.length >= 2, "the room's speech");
      await rig.framework.runUntilIdle();
      assert.equal(heard[0]!.nonChannelOrigin, true);
      assert.notEqual(heard[1]!.nonChannelOrigin, true);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's refusal rewind retries privately, and its record names no channel", async () => {
    const rig = await surfaceRig({ agent: { refusalHandling: { autoRewind: true, maxRewinds: 1 } } });
    try {
      const records: Array<Record<string, unknown>> = [];
      const internalsOf = rig.framework as unknown as { logFailure(record: Record<string, unknown>): void; channelRegistry: Record<string, unknown> };
      internalsOf.logFailure = (record) => { records.push(record); };
      internalsOf.channelRegistry.buildChannelContext = () => ({ incoming: { channelId: ROOM, messageId: 'm1' } });
      rig.membrane.pushResponse(createMockResponse([], 'refusal'));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 2, "the turn and its rewind's retry");
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts[1]!.reason, 'refusal-rewind-retry', JSON.stringify(rig.starts));
      assert.ok(privateStart(rig.starts[1]!), 'the retry stays private');
      const refusal = records.find((r) => r.kind === 'refusal');
      assert.ok(refusal, JSON.stringify(records));
      assert.equal(refusal!.locus, null, 'a private turn has no incoming channel to name');
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's '!' continuation asks for a private turn", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as { requestProseContinuation(agent: unknown, routing: Routing): void };
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      routing.continuation = true;
      internalsOf.requestProseContinuation(rig.framework.getAgent('scout'), routing);
      const asked = rig.i.pendingRequests.at(-1);
      assert.equal(asked?.reason, 'prose-continuation');
      assert.equal(asked?.nonChannelOrigin, true);
      rig.i.pendingRequests.length = 0;
    } finally {
      await rig.close();
    }
  });

  it("a private turn's same-round private think keeps its words as the resident's own choice", async () => {
    const rig = await surfaceRig({ modules: [robot()], agent: { sameRoundThinkTextPolicy: 'private' } });
    try {
      // think is a channel tool the registry answers.
      (rig.state.channelRegistry as Record<string, unknown>).handleChannelToolCall = async () => ({ success: true, data: {} });
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'thinking aloud' },
        { type: 'tool_use', id: 't1', name: 'think', input: { thought: 'quietly' } },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1, 'the private turn');
      await rig.framework.runUntilIdle();
      const receipt = rig.texts().find((t) => t.startsWith('[delivered]')) ?? '';
      assert.match(receipt, /1 plain-speech segment\(s\) kept private \(skip_reply or a private think\)/, receipt);
      assert.match(receipt, /1 plain-speech segment\(s\) kept private \(private turn/, receipt);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's round that skip_reply silences counts its words as the resident's own choice, not the turn's privacy", async () => {
    const rig = await surfaceRig();
    try {
      (rig.state.channelRegistry as Record<string, unknown>).handleChannelToolCall = async (name: string) =>
        name === 'skip_reply' ? { success: true, endTurn: true, data: { skipped: true } } : { success: true, data: {} };
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'not for anyone' },
        { type: 'tool_use', id: 's1', name: 'skip_reply', input: {} },
      ] as never, 'tool_use'));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1, 'the private turn');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed, []);
      assert.ok(privateStart(rig.starts[0]!), 'control: the turn was private');
      // The turn's receipt names its tallies, which its end then spends.
      const receipt = rig.texts().find((t) => t.startsWith('[delivered]')) ?? '';
      assert.match(receipt, /1 plain-speech segment\(s\) kept private \(skip_reply or a private think\)/, receipt);
      assert.doesNotMatch(receipt, /private turn/, receipt);
    } finally {
      await rig.close();
    }
  });

  it("a private hybrid turn's speech with no target, mid-turn and trailing, is kept private and held as no draft", async () => {
    const rig = await surfaceRig({ modules: [robot()], agent: { proseRouting: 'hybrid' } });
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'on my way' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'arrived' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1, 'the private turn');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed, []);
      const drafts = (rig.framework as unknown as { proseDrafts: { open(agent: string): unknown[] } }).proseDrafts;
      assert.deepEqual(drafts.open('scout'), [], 'no draft holds them');
      const receipt = rig.texts().find((t) => t.startsWith('[delivered]')) ?? '';
      assert.match(receipt, /2 plain-speech segment\(s\) kept private \(private turn — publish only with an explicit send tool or a >>> envelope\)/, receipt);
    } finally {
      await rig.close();
    }
  });

  it('the notice that speech has no channel names a >>> envelope in hybrid mode, and only there', async () => {
    for (const mode of ['locus', 'hybrid'] as const) {
      const rig = await surfaceRig({ agent: { proseRouting: mode } });
      try {
        const announce = (rig.framework as unknown as { announceLocusIfChanged(agentName: string, locus: string | null): void })
          .announceLocusIfChanged.bind(rig.framework);
        announce('scout', ROOM);
        announce('scout', null);
        const notices = rig.texts().filter((t) => t.startsWith('[routing] Your plain speech currently goes to no channel'));
        assert.equal(notices.length, 1, `${mode}: ${JSON.stringify(notices)}`);
        assert.equal(notices[0]!.includes('Use an explicit send tool or a >>> envelope to reach a channel.'), mode === 'hybrid', notices[0]);
        assert.ok(notices[0]!.includes('Use an explicit send tool'), notices[0]);
      } finally {
        await rig.close();
      }
    }
  });

  it("a private turn's addressed arrival moves no locus, at a boundary or between streams", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as { noteArrival(agentName: string, metadata: unknown, messageId: string): void };
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      routing.arrivals = [];
      rig.state.openLogical.set('scout', routing);
      internalsOf.noteArrival('scout', { channelId: ROOM, tags: ['chat:addressed'], source: 'mcpl:channel-incoming' }, 'm1');
      assert.deepEqual(routing.arrivals, [], 'nothing is noted to re-pin the private turn at its next start');
      // Control: a channel turn notes it.
      routing.nonChannelOrigin = false;
      internalsOf.noteArrival('scout', { channelId: ROOM, tags: ['chat:addressed'], source: 'mcpl:channel-incoming' }, 'm2');
      assert.equal((routing.arrivals as unknown[]).length, 1, JSON.stringify(routing.arrivals));
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });
});
