/**
 * Turn provenance: the trigger the framework exposes for the turn in progress
 * (getActiveTurnTrigger / the InferenceRequest handed to startAgentStream)
 * must be internally consistent — channel, addressed and counterparty from
 * ONE request — so a host stamping gateway telemetry never reports one
 * person's channel with another person's id.
 */
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
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
      getChannelTools: () => [], resolveLocus: () => ref(LOUNGE),
      routeSpeech: async (_agent: string, text: string, locus: Ref | null) => {
        routed.push({ text, locus: locus?.channelId ?? null }); return { delivered: true, serverId: 'discord', channelId: locus?.channelId };
      }, getDescriptor: () => undefined, getDefaultPublishChannel: () => ref(LOUNGE),
      channelsNamed: (id: string) => [ref(id)], nameShown: (r: Ref) => r.channelId,
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
const LOUNGE = 'discord:g:lounge';
/** A channel with its server, as the registry names one. */
type Ref = { serverId: string; channelId: string };
const ref = (channelId: string): Ref => ({ serverId: 'discord', channelId });
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
    turnRouting: Map<string, { nonChannelOrigin?: boolean; triggerChannel?: Ref; locus?: Ref; pin?: Ref }>;
    openLogical: Map<string, unknown>;
    channelRegistry: unknown;
  };
  state.channelRegistry = new Proxy({
    getChannelTools: () => [],
    resolveLocus: (agentName: string) => state.turnRouting.get(agentName)?.triggerChannel ?? ref(LOUNGE),
    routeSpeech: async (_agent: string, text: string, locus: Ref | null) => {
      if (routeGate) await routeGate;
      routed.push({ text, locus: locus?.channelId ?? null }); return { delivered: true, serverId: 'discord', channelId: locus?.channelId };
    },
    // A named or sticky destination posts through deliverSpeech, which
    // reports the post's outcome, as the real registry does.
    deliverSpeech: async (_agent: string, text: string, channel: Ref | string | null) => {
      if (routeGate) await routeGate;
      const channelId = typeof channel === 'string' ? channel : channel?.channelId ?? null;
      routed.push({ text, locus: channelId });
      return { status: 'delivered', destination: { serverId: 'discord', channelId }, at: Date.now() };
    },
    resolveProseTarget: (target: string) => ({ serverId: 'discord', channelId: target }),
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'discord', channelId } }),
    getDescriptor: () => undefined, getDefaultPublishChannel: () => ref(LOUNGE),
    channelsNamed: (id: string) => [ref(id)], nameShown: (r: Ref) => r.channelId,
    startTyping: (channel: Ref | string) => { typing.push(typeof channel === 'string' ? channel : channel.channelId); },
  }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
  const i = internals(framework);
  const starts: InferenceRequest[] = [];
  const start = i.startAgentStream.bind(framework);
  // Each start's routing as its stream begins, in order of the starts.
  const routings: Array<{ nonChannelOrigin?: boolean; triggerChannel?: Ref; locus?: Ref; pin?: Ref }> = [];
  i.startAgentStream = async (agent, trigger) => {
    if (trigger) starts.push(trigger);
    const result = await start(agent, trigger);
    routings.push(state.turnRouting.get('scout')!);
    return result;
  };
  // Polls, letting the scheduler run to idle between looks: a debounce's
  // wake is queued by its timer, after the test has pushed its events. The
  // deadline bounds a scheduler that never goes idle too, failing the wait
  // rather than hanging it. A turn whose held posts keep it from going idle
  // is watched with whileRunning instead.
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
/** The turns whose work a request continues, as the framework marks them (CALLER_TURNS). */
const callerTurns = (r: InferenceRequest | undefined): number[] => {
  if (!r) return [];
  const mark = Object.getOwnPropertySymbols(r).find((k) => k.description === 'caller-turns');
  return mark ? (r as unknown as Record<symbol, number[]>)[mark] : [];
};
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
        routing.triggerChannel = ref(ROOM);
        routing.locus = ref(ROOM);
        if (mode === 'hybrid') routing.pin = ref('discord:g:other');
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
          routing.triggerChannel = ref(ROOM);
          routing.locus = ref(ROOM);
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

  it("a silent turn's budget restart that reads a stored private message makes it private, and tells it nothing", async () => {
    for (const silent of [true, false]) {
      const rig = await surfaceRig();
      const label = silent ? 'a silent restart' : 'control: a restart that can publish';
      try {
        // An open turn with no destination, as a silent turn's is, between
        // its stream and the restart that continues it, when the operator's
        // message is stored.
        const routing = routingOf(rig.framework);
        rig.state.openLogical.set('scout', routing);
        storeOperatorMessage(rig.framework);
        rig.i.pendingRequests.push({ agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(), ...(silent ? { suppressProse: true } : {}) });
        await rig.until(() => rig.starts.length >= 1, 'the restart');
        await rig.framework.runUntilIdle();
        assert.equal(routing.nonChannelOrigin, true, `${label}: the turn is private now, so its publish names its channel`);
        assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, silent ? 0 : 1, `${label}: ${JSON.stringify(rig.texts())}`);
      } finally {
        await rig.close();
      }
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
      assert.equal(rig.routings[0]!.nonChannelOrigin, true, 'the silent start is private too, so its publish names its channel');
      assert.equal(rig.routings[1]!.nonChannelOrigin, true, "the room's start, the first to publish, is private");
      assert.deepEqual(rig.routed, []);
      // Only the start with a reply is told why it's private: the silent one has none.
      assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
  });

  for (const hadDestination of [false, true]) {
    it(`an explicit-mode turn that ${hadDestination ? 'had' : 'had no'} destination is told it's private when private input comes in, and its plain answer is kept private, with no draft`, async () => {
      let framework: AgentFramework | undefined;
      const tool = robot(() => framework!.pushEvent(tuiMessage('for your eyes only, what is the door code?')));
      const rig = await surfaceRig({ modules: [tool], agent: { proseRouting: 'explicit' } });
      framework = rig.framework;
      try {
        rig.membrane.pushResponse(createMockResponse([
          ...(hadDestination ? [{ type: 'text', text: `>>${ROOM} on my way` }] : []),
          { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
        ] as never, 'tool_use'));
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'The door code is 4417.' }]));
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed.map((r) => r.text), hadDestination ? ['on my way'] : [], 'nothing after the private input went out');
        const texts = rig.texts();
        assert.equal(texts.filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, `told once that the turn is private: ${JSON.stringify(texts)}`);
        assert.ok(texts.includes('[prose-routing] Your text (22 chars) was kept private — this turn holds private input, so its plain ' +
          "speech goes to no channel, and it isn't held as a draft. To publish, use a >> prefix or an explicit send tool."), JSON.stringify(texts));
        assert.ok(!texts.some((t) => t.includes('{{unsent}}')), 'no offer to resend it');
        const drafts = (rig.framework as unknown as { proseDrafts: { open(agent: string): unknown[] } }).proseDrafts.open('scout');
        assert.deepEqual(drafts, [], 'and no draft held');
      } finally {
        await rig.close();
      }
    });
  }

  it("a private turn that takes in more private input is told nothing again", async () => {
    let framework: AgentFramework | undefined;
    const tool = robot(() => framework!.pushEvent(tuiMessage('and one more thing')));
    const rig = await surfaceRig({ modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'looking into it' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the private turn');
      await rig.framework.runUntilIdle();
      assert.ok(privateStart(rig.starts[0]!), 'control: the turn opened private');
      const wired = rig.streams[0]!.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
      assert.ok(wired.some((w) => w.includes('and one more thing')), `control: its boundary took in the second message: ${JSON.stringify(wired)}`);
      assert.deepEqual(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)), [], 'it was private already, so nothing says it became so');
    } finally {
      await rig.close();
    }
  });

  it("an explicit-mode room start that a stored operator message makes private is told why", async () => {
    const rig = await surfaceRig({ agent: { proseRouting: 'explicit' } });
    try {
      storeOperatorMessage(rig.framework);
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', "the room's start");
      assert.equal(rig.routings[0]!.nonChannelOrigin, true, 'control: the start is private');
      assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, JSON.stringify(rig.texts()));
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
      routing.triggerChannel = ref(ROOM);
      routing.locus = ref(ROOM);
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

  it("a private turn's sleep announcement is posted nowhere, where a channel turn's goes to its locus", async () => {
    for (const privateTurn of [true, false]) {
      const rig = await surfaceRig({ gate: { config: { policies: [], default: 'always' } } });
      const internalsOf = rig.framework as unknown as {
        dispatchSleepToolCall(agentName: string, call: { id: string; name: string; input: unknown; callerTurnId?: number }): void;
        eventGate: { clearSleep(): unknown };
      };
      try {
        const routing = routingOf(rig.framework);
        routing.locus = ref(ROOM);
        if (privateTurn) { delete routing.locus; routing.nonChannelOrigin = true; }
        rig.state.turnRouting.set('scout', routing as never);
        // The call is the turn's own, made inside it.
        internalsOf.dispatchSleepToolCall('scout', { id: 's1', name: 'sleep', input: { seconds: 60, message: 'going quiet' }, callerTurnId: (routing as { turnId?: number }).turnId });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(rig.routed, privateTurn ? [] : [{ text: 'going quiet', locus: ROOM }], JSON.stringify(rig.routed));
      } finally {
        internalsOf.eventGate.clearSleep();
        await rig.close();
      }
    }
  });

  it("a silent turn's boundary that stores private input makes that turn private and marks the next start", async () => {
    let framework: AgentFramework | undefined;
    const tool = robot(() => { storeOperatorMessage(framework!); });
    const rig = await surfaceRig({ modules: [tool] });
    framework = rig.framework;
    try {
      // A mock stream takes the responses queued when it starts, so the
      // silent turn's round after its tool has one queued too.
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tidied up' }]));
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
      await rig.until(() => rig.starts.length >= 1 && rig.texts().includes('for your eyes only'), "the silent turn, and the boundary's store");
      await rig.framework.runUntilIdle();
      assert.equal(rig.routings[0]!.nonChannelOrigin, true, 'the silent turn is private from its boundary');
      assert.deepEqual(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)), [], 'a silent turn, whose speech goes nowhere, is told nothing');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's start");
      await rig.framework.runUntilIdle();
      assert.equal(rig.routings[1]!.nonChannelOrigin, true, "the room's start, the first that can publish, is private");
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it('a boundary that ends the turn leaves it a channel turn, and marks the private input it stored for the next start', async () => {
    let framework: AgentFramework | undefined;
    // Deferred while the turn is alive, with no wake of its own, and stored
    // at the boundary that ends the turn.
    const tool = robot(() => { storeOperatorMessage(framework!); }, { endTurn: true });
    const rig = await surfaceRig({ modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'on my way' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.texts().includes('for your eyes only'), "the room's turn, and the boundary's store");
      await rig.framework.runUntilIdle();
      assert.notEqual(rig.routings[0]!.nonChannelOrigin, true, "the room's turn ended a channel turn");
      assert.ok(!rig.texts().some((t) => t.startsWith(PRIVATE_FROM_HERE)), 'nothing made the ended turn private');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's next start");
      await rig.framework.runUntilIdle();
      assert.equal(rig.routings[1]!.nonChannelOrigin, true, 'the next start, the first to read it, is private');
      assert.deepEqual(rig.routed, [{ text: 'on my way', locus: ROOM }]);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's own envelope posts its body where it names, and sets no destination for its later rounds", async () => {
    for (const mode of ['hybrid', 'explicit'] as const) {
      const prefix = mode === 'hybrid' ? '>>>' : '>>';
      const rig = await surfaceRig({ modules: [robot()], agent: { proseRouting: mode } });
      try {
        rig.membrane.pushResponse(createMockResponse([
          { type: 'text', text: `${prefix}discord:g:other a note for them\nand the rest of it` },
          { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
        ] as never, 'tool_use'));
        // Its later round answers the operator, believing the notice.
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
        rig.framework.pushEvent(tuiMessage());
        await rig.until(() => rig.starts.length >= 1, `${mode}: the private turn`);
        await rig.framework.runUntilIdle();
        assert.ok(privateStart(rig.starts[0]!), `${mode}: control: the turn is private`);
        assert.deepEqual(rig.routed, [{ text: 'a note for them\nand the rest of it', locus: 'discord:g:other' }],
          `${mode}: the envelope runs to the next envelope line, and nothing later follows it: ${JSON.stringify(rig.routed)}`);
        assert.equal(rig.routings[0]!.pin, undefined, `${mode}: no destination was set`);
      } finally {
        await rig.close();
      }
    }
  });

  for (const turnsPrivate of [true, false]) {
    it(`a channel_open answered after its turn ${turnsPrivate ? 'turned private moves neither the locus nor the trigger channel' : 'went on as a channel turn moves both, as a control'}`, async () => {
      const rig = await surfaceRig();
      try {
        let answer!: (result: unknown) => void;
        const internalsOf = rig.framework as unknown as {
          channelRegistry: Record<string, unknown>;
          dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown; callerTurnId?: number }): void;
          makeTurnPrivate(agent: unknown, routing: unknown): unknown;
        };
        internalsOf.channelRegistry.handleChannelToolCall = () => new Promise((resolve) => { answer = resolve; });
        const routing = routingOf(rig.framework);
        routing.triggerChannel = ref(ROOM);
        routing.locus = ref(ROOM);
        rig.state.openLogical.set('scout', routing);
        // The call is the turn's own, made inside it.
        internalsOf.dispatchChannelToolCall('scout', {
          id: 'o1', name: 'channel_open', input: { channelId: 'discord:g:other' }, callerTurnId: routing.turnId as number,
        });
        // Private input comes into the turn while the open is in flight.
        if (turnsPrivate) internalsOf.makeTurnPrivate(rig.framework.getAgent('scout'), routing);
        answer({ success: true, data: { channelId: 'discord:g:other', serverId: 'discord' } });
        await new Promise((r) => setImmediate(r));
        if (turnsPrivate) {
          assert.equal(routing.locus, undefined, 'the locus stays gone');
          assert.equal(routing.triggerChannel, undefined, 'and so does the trigger channel');
        } else {
          assert.deepEqual(routing.locus, ref('discord:g:other'), 'control: the call is the turn\'s, so it moves the locus');
          assert.deepEqual(routing.triggerChannel, ref('discord:g:other'));
        }
      } finally {
        rig.state.openLogical.delete('scout');
        await rig.close();
      }
    });
  }

  it("a channel_publish that names no channel is judged by the turn it was made in, and a script's by its start turn alone, whichever turn is live", async () => {
    const rig = await surfaceRig();
    try {
      const results: Array<{ id: string; success: boolean; error?: string }> = [];
      const internalsOf = rig.framework as unknown as {
        notePrivateTurn(turnId: number): void;
        dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown; callerTurnId?: number }): void;
        scriptCallStarts: Map<string, unknown>;
        pushEvent(event: unknown): void;
        channelRegistry: Record<string, unknown>;
      };
      internalsOf.channelRegistry.handleChannelToolCall = async () => ({ success: true, data: { posted: true } });
      const push = internalsOf.pushEvent.bind(rig.framework);
      internalsOf.pushEvent = (event: unknown) => {
        const e = event as { type?: string; callId?: string; result?: { success: boolean; error?: string } };
        if (e.type === 'tool-result' && e.result) results.push({ id: e.callId!, ...e.result });
        else push(event);
      };
      // The live turn is private; another, a channel turn, isn't.
      const live = routingOf(rig.framework);
      live.nonChannelOrigin = true;
      internalsOf.notePrivateTurn(live.turnId as number);
      const earlier = (live.turnId as number) + 7;
      const publish = (id: string, callerTurnId?: number) => internalsOf.dispatchChannelToolCall('scout', {
        id, name: 'channel_publish', input: { content: 'hello' }, ...(callerTurnId !== undefined ? { callerTurnId } : {}),
      });
      publish('in-live', live.turnId as number);
      publish('in-earlier', earlier);
      // A script's call, judged at the bridge by its start turn, isn't judged again here.
      internalsOf.scriptCallStarts.set('from-script', { turnId: earlier, readThrough: null });
      publish('from-script', live.turnId as number);
      internalsOf.scriptCallStarts.delete('from-script');
      await new Promise((r) => setImmediate(r));
      const outcome = (id: string) => results.find((r) => r.id === id)?.success;
      assert.equal(outcome('in-live'), false, 'made in the private turn: refused');
      assert.equal(outcome('in-earlier'), true, 'made in a channel turn: posted, though the live turn is private');
      assert.equal(outcome('from-script'), true, "a script's call is the bridge's to judge");
    } finally {
      await rig.close();
    }
  });

  it("channel_publish's description says a turn that has taken in private input names its channel", async () => {
    const registry = new ChannelRegistry({ getServer: () => undefined } as never, {} as never, () => {}, () => {});
    const publish = registry.getChannelTools().find((t) => t.name === 'channel_publish')!;
    // The refusal a private turn's publish meets, and a script's, is in its
    // description, so the default it offers is never one the turn refuses.
    assert.match(publish.description,
      /must name a channel, and so must a turn that has taken in private input, such as a console or WebUI message, and a script such a turn started\./);
    const channelId = (publish.inputSchema as unknown as { properties: { channelId: { description: string } } }).properties.channelId;
    assert.match(channelId.description, /required of a subagent, of a turn that has taken in private input, and of a script such a turn started\)/);
  });

  it("a private turn's channel_publish names where it goes, a fork's home included", async () => {
    const rig = await surfaceRig();
    try {
      const results: Array<{ success: boolean; error?: string }> = [];
      const internalsOf = rig.framework as unknown as {
        conversationAgentHomes: Map<string, Ref>;
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
        // A home is a channel with its server, as main keeps it.
        if (fork) internalsOf.conversationAgentHomes.set('scout', ref(ROOM));
        results.length = 0;
        internalsOf.dispatchChannelToolCall('scout', { id: `c-${fork}`, name: 'channel_publish', input: { content: 'hello' } });
        assert.equal(results[0]?.success, false, `${fork ? 'a fork' : 'a trunk agent'}: refused without a channelId`);
        assert.match(results[0]!.error!, /^This private turn has no default channel; channel_publish requires an explicit channelId\./);
        if (fork) assert.match(results[0]!.error!, new RegExp(`name "${ROOM}"`));
        assert.match(results[0]!.error!, / channel_list shows the channel ids\.$/, 'where to find a channel id, for an agent that may list them');
      }
      // An agent that may not call channel_list isn't pointed at it.
      const canUse = (rig.framework as unknown as { canAgentUseTool(a: string, t: string): boolean }).canAgentUseTool;
      (rig.framework as unknown as { canAgentUseTool(a: string, t: string): boolean }).canAgentUseTool = (a, t) => t !== 'channel_list' && canUse.call(rig.framework, a, t);
      results.length = 0;
      internalsOf.dispatchChannelToolCall('scout', { id: 'c-nolist', name: 'channel_publish', input: { content: 'hello' } });
      assert.ok(!results[0]!.error!.includes('channel_list'), results[0]!.error);
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
        roundCallOf(agentName: string, call: { name: string; input?: unknown }, refusedHere?: boolean, privateTurn?: boolean): { cause: string | null };
      };
      internalsOf.channelRegistry.handleChannelToolCall = async (name: string, input: unknown) => { calls.push({ name, input }); return { success: true, data: {} }; };
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      rig.state.openLogical.set('scout', routing);
      internalsOf.dispatchChannelToolCall('scout', { id: 'p1', name: 'channel_publish', input: { channelId: ROOM, content: 'hello' } });
      await rig.until(() => calls.length >= 1, 'the named publish');
      assert.deepEqual(calls.map((c) => (c.input as { channelId?: string }).channelId), [ROOM], "the model's named publish went through");
      // Its round, a private turn's, counts a refused publish as no send,
      // and a named one as one. A channel turn's round counts both.
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { content: 'hello' } }, false, true).cause, null);
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { channelId: ROOM, content: 'hello' } }, false, true).cause, 'send');
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { content: 'hello' } }, false, false).cause, 'send');
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
        incomingFor: () => ({ channel: ref('discord:g:room'), messageId: 'm1' }),
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

  it("a request a turn causes carries that turn, the one it names over the live one", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        derivedTurnRequest(agentName: string, reason: string, routing?: unknown): InferenceRequest;
      };
      const live = routingOf(rig.framework);
      for (const reason of ['refusal-retry', 'unstick-retry', 'inference-failure-rewind-retry', 'prose-continuation']) {
        const asked = internalsOf.derivedTurnRequest('scout', reason);
        assert.deepEqual(callerTurns(asked), [live.turnId], reason);
        assert.notEqual(asked.nonChannelOrigin, true, `${reason}: judged at its start, not here`);
      }
      // A cause named explicitly wins over the live turn, as a bounce names the
      // turn its envelope came from.
      assert.deepEqual(callerTurns(internalsOf.derivedTurnRequest('scout', 'prose-bounce', { turnId: 7 })), [7]);
    } finally {
      await rig.close();
    }
  });

  // A request that continues a turn's work is judged at the start that reads
  // the work: a turn that turns private after the request is queued, as at a
  // later tool boundary that takes in an operator's message, makes it private.
  for (const turnsPrivate of [true, false]) {
    const how = turnsPrivate ? 'is private when its turn turned private after it was queued' : 'stays a channel turn when its turn did not turn private, as a control';
    const queueAndStart = async (queue: (rig: Awaited<ReturnType<typeof surfaceRig>>, turnId: number) => Promise<void>) => {
      const rig = await surfaceRig();
      try {
        const internalsOf = rig.framework as unknown as { makeTurnPrivate(agent: unknown, routing: unknown): unknown };
        // The turn whose work it continues: a channel turn when the request is queued.
        const turn = routingOf(rig.framework);
        turn.locus = ref(ROOM);
        await queue(rig, turn.turnId as number);
        assert.notEqual(rig.i.pendingRequests.at(-1)?.nonChannelOrigin, true, 'control: queued unmarked');
        assert.deepEqual(callerTurns(rig.i.pendingRequests.at(-1)), [turn.turnId], 'it carries the turn');
        // The turn then takes in private input, before the request's start.
        if (turnsPrivate) internalsOf.makeTurnPrivate(rig.framework.getAgent('scout'), turn);
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the start');
        assert.equal(rig.starts[0]!.nonChannelOrigin === true, turnsPrivate, JSON.stringify(rig.starts[0]));
        assert.equal(rig.routings[0]!.nonChannelOrigin === true, turnsPrivate);
      } finally {
        await rig.close();
      }
    };
    it(`a tune-out cancel's turn for the resident ${how}`, async () => {
      await queueAndStart(async (rig, turnId) => {
        (rig.framework as unknown as { requestForTurn(a: string, r: string, s: string, t?: number): void })
          .requestForTurn('scout', 'tune-out cancelled (agent request)', 'tune-out', turnId);
      });
    });
    it(`a script's wake ${how}`, async () => {
      await queueAndStart(async (rig, turnId) => {
        await (rig.framework as unknown as { scriptWake(a: string, id: string, text: string, label: string, t?: number): Promise<void> })
          .scriptWake('scout', 's1', '[script s1] Woke you', 's1-wake', turnId);
      });
    });
    it(`a bounce's wake ${how}`, async () => {
      await queueAndStart(async (rig) => {
        const internalsOf = rig.framework as unknown as { derivedTurnRequest(a: string, r: string, routing?: unknown): InferenceRequest };
        rig.i.pendingRequests.push(internalsOf.derivedTurnRequest('scout', 'prose-bounce', routingOf(rig.framework)));
      });
    });
  }

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

  it("a turn that turns private at a boundary shows its speech handlers no channel of the wake that opened it", async () => {
    const heard: Array<{ nonChannelOrigin?: boolean; trigger?: { channelId?: string; addressed?: boolean } }> = [];
    let framework: AgentFramework | undefined;
    const listener = {
      name: 'listener',
      async start(ctx: { registerSpeechHandler(name: string, options?: unknown): void }) { ctx.registerSpeechHandler('*', { additive: true }); },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false }; },
      async onProcess() { return {}; },
      async onAgentSpeech(_agent: string, _content: unknown, context: (typeof heard)[number]) { heard.push(context); },
    } as unknown as Module;
    const tool = robot(() => framework!.pushEvent(tuiMessage('for your eyes only')));
    const rig = await surfaceRig({ modules: [listener, tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'on my way' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => heard.length >= 1, "the room's turn's speech");
      assert.ok(roomStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.equal(heard[0]!.nonChannelOrigin, true, 'control: the turn turned private');
      assert.equal(heard[0]!.trigger?.channelId, undefined, JSON.stringify(heard[0]!.trigger));
      assert.equal(heard[0]!.trigger?.addressed, false);
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
      internalsOf.channelRegistry.incomingFor = () => ({ channel: ref(ROOM), messageId: 'm1' });
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

  it("a '!' continuation carries the turn that asked for it", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as { requestProseContinuation(agent: unknown, routing: Routing): void };
      const routing = routingOf(rig.framework);
      routing.continuation = true;
      internalsOf.requestProseContinuation(rig.framework.getAgent('scout'), routing);
      const asked = rig.i.pendingRequests.at(-1);
      assert.equal(asked?.reason, 'prose-continuation');
      assert.deepEqual(callerTurns(asked), [routing.turnId], "so its start is private when that turn is by then");
      rig.i.pendingRequests.length = 0;
    } finally {
      await rig.close();
    }
  });

  for (const privateTurn of [true, false]) {
    it(`a ${privateTurn ? 'private' : "room's"} turn's auto-continuation is ${privateTurn ? 'private, and publishes nothing' : "the room's, and speaks there"}`, async () => {
      const rig = await surfaceRig({ agent: { autoContinue: { maxConsecutive: 1 } } });
      try {
        if (privateTurn) rig.framework.pushEvent(tuiMessage());
        else rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 2 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn and its continuation');
        assert.equal(rig.starts.length, 2, JSON.stringify(rig.starts));
        assert.equal(rig.starts[1]!.reason, 'auto-continue');
        assert.equal(rig.routings[1]!.nonChannelOrigin === true, privateTurn, 'the continuation is private exactly when its turn was');
        if (privateTurn) {
          assert.ok(privateStart(rig.starts[1]!), JSON.stringify(rig.starts[1]));
          assert.deepEqual(rig.routed, [], 'neither turn published');
          // Speech kept private counts as no publish anywhere, so no wake is
          // taken as answered by it (Agent.publishedAfterReading).
          const published = (rig.framework.getAgent('scout') as unknown as { publishedThrough: Map<string, unknown> }).publishedThrough;
          assert.equal(published.size, 0, JSON.stringify([...published.keys()]));
        } else {
          assert.deepEqual(rig.routed, [{ text: 'reply 1', locus: ROOM }, { text: 'reply 2', locus: ROOM }]);
        }
      } finally {
        await rig.close();
      }
    });
  }

  // A private turn's channel messages (noticeChannelMessages).
  const HOLDS_ROOM = `[routing] This private turn also holds a message from ${ROOM}, and your plain speech won't reach it.`;
  /** The stored row of each `[routing]` notice of a private turn's channel messages, in order. */
  const channelNotices = (rig: { texts(): string[] }) => rig.texts().filter((t) => t.startsWith('[routing] This private turn also holds'));
  /** Where in the store the notice sits, against the turn's first reply. */
  const noticeBeforeReply = (rig: { texts(): string[] }) => {
    const all = rig.texts();
    const notice = all.findIndex((t) => t.startsWith('[routing] This private turn also holds'));
    return notice >= 0 && notice < all.indexOf('reply 1');
  };

  for (const order of ['room first', 'private first'] as const) {
    it(`a private start that takes in a room's message names the room before the reply, ${order}`, async () => {
      const rig = await surfaceRig();
      try {
        rig.i.pendingRequests.push(...(order === 'room first' ? [roomWake(), tuiWake()] : [tuiWake(), roomWake()]));
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
        assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
        assert.deepEqual(channelNotices(rig), [`${HOLDS_ROOM} If one needs an answer there, use an explicit send tool.`]);
        assert.ok(noticeBeforeReply(rig), JSON.stringify(rig.texts()));
        assert.ok(JSON.stringify(rig.membrane.calls[0]).includes(HOLDS_ROOM), 'the notice is in the request the reply answers');
        assert.deepEqual(rig.routed, []);
      } finally {
        await rig.close();
      }
    });
  }

  it("a private start keeps no channel or server from a room's wake it takes in", async () => {
    const rig = await surfaceRig();
    try {
      rig.i.pendingRequests.push({ ...roomWake(), channelServerId: 'discord' }, tuiWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      assert.equal(rig.starts[0]!.channelId, undefined);
      assert.equal(rig.starts[0]!.channelServerId, undefined, JSON.stringify(rig.starts[0]));
      assert.equal(rig.starts[0]!.nonChannelOrigin, true);
    } finally {
      await rig.close();
    }
  });

  it("a room's turn made private by a stored operator message names the room it was woken for", async () => {
    const rig = await surfaceRig();
    try {
      storeOperatorMessage(rig.framework);
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      assert.equal(rig.routings[0]!.nonChannelOrigin, true, 'control: the stored message made the turn private');
      assert.equal(channelNotices(rig).length, 1, JSON.stringify(rig.texts()));
      assert.ok(noticeBeforeReply(rig), JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
  });

  it("a room's wake that continues an open private turn names the room", async () => {
    const rig = await surfaceRig();
    try {
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      rig.state.openLogical.set('scout', routing);
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', "the room's wake");
      assert.equal(rig.routings[0], routing, "control: the room's wake continued the private turn");
      assert.deepEqual(channelNotices(rig), [`${HOLDS_ROOM} If one needs an answer there, use an explicit send tool.`]);
      assert.deepEqual(rig.routed, []);
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });

  it("a start gathers its channel wakes' channels, and not an auto-continuation's, which is its turn's locus", async () => {
    const rig = await surfaceRig();
    try {
      const started: InferenceRequest[] = [];
      rig.i.startAgentStream = async (_agent, trigger) => { if (trigger) started.push(trigger); };
      const now = Date.now();
      rig.i.pendingRequests.push(
        { agentName: 'scout', reason: 'auto-continue', source: 'framework', timestamp: now, channelId: 'discord:g:third', channelServerId: 'discord' },
        roomWake(),
      );
      await rig.i.processInferenceRequests();
      assert.equal(started.length, 1, JSON.stringify(started));
      const symbol = Object.getOwnPropertySymbols(started[0]!).find((k) => k.description === 'wake-channels');
      assert.ok(symbol, 'the start carries its channels');
      assert.deepEqual((started[0] as unknown as Record<symbol, unknown>)[symbol!], [{ channelId: ROOM }]);
    } finally {
      rig.i.pendingRequests.length = 0;
      await rig.close();
    }
  });

  it("a channel's message is named once in a private turn, and a second channel is named on its own", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        noticeChannelMessages(agent: unknown, routing: Routing, channels: Array<{ channelId: string; serverId?: string }>): unknown;
      };
      const routing = routingOf(rig.framework);
      routing.nonChannelOrigin = true;
      const agent = rig.framework.getAgent('scout');
      assert.ok(internalsOf.noticeChannelMessages(agent, routing, [{ channelId: ROOM, serverId: 'discord' }]));
      assert.equal(internalsOf.noticeChannelMessages(agent, routing, [{ channelId: ROOM, serverId: 'discord' }]), undefined, 'named already');
      assert.ok(internalsOf.noticeChannelMessages(agent, routing, [{ channelId: ROOM, serverId: 'discord' }, { channelId: LOUNGE, serverId: 'discord' }]));
      assert.deepEqual(channelNotices(rig), [
        `${HOLDS_ROOM} If one needs an answer there, use an explicit send tool.`,
        `[routing] This private turn also holds a message from ${LOUNGE}, and your plain speech won't reach it. If one needs an answer there, use an explicit send tool.`,
      ]);
      // Two at once are listed together, and a notice that can't be stored
      // leaves its channels to be named later.
      const fresh: Routing = { nonChannelOrigin: true };
      const cm = agent!.getContextManager() as unknown as { addMessage: (...a: unknown[]) => unknown };
      const addMessage = cm.addMessage;
      cm.addMessage = () => { throw new Error('the store is full'); };
      try {
        assert.equal(internalsOf.noticeChannelMessages(agent, fresh, [{ channelId: 'discord:g:a' }, { channelId: 'discord:g:b' }]), undefined);
      } finally {
        cm.addMessage = addMessage;
      }
      assert.ok(internalsOf.noticeChannelMessages(agent, fresh, [{ channelId: 'discord:g:a' }, { channelId: 'discord:g:b' }]));
      assert.equal(channelNotices(rig).at(-1),
        "[routing] This private turn also holds a message from discord:g:a and discord:g:b, and your plain speech won't reach them. If one needs an answer there, use an explicit send tool.");
    } finally {
      await rig.close();
    }
  });

  /** The mark of the channels a request brings in, as a start shows it. */
  const wakeChannelsMark = (request: InferenceRequest): symbol | undefined =>
    Object.getOwnPropertySymbols(request).find((k) => k.description === 'wake-channels');

  it("a quiesce that keeps one of two parked wakes keeps the other's channels on it, and the private start names both", async () => {
    const rig = await surfaceRig();
    try {
      await rig.framework.quiesce();
      const now = Date.now();
      // Two addressed rooms' wakes with one key, and an operator's: the
      // quiesce keeps the newer room wake, which stands for the other.
      rig.i.pendingRequests.push(
        { ...roomWake(), channelServerId: 'discord', timestamp: now },
        { ...roomWake(), channelId: LOUNGE, channelServerId: 'discord', timestamp: now + 1 },
        tuiWake(),
      );
      await rig.i.processInferenceRequests();
      assert.equal(rig.i.pendingRequests.filter((r) => r.channelId).length, 1, 'control: the quiesce kept one of the two');
      await rig.framework.resume();
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn after resume');
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.deepEqual(channelNotices(rig), [
        `[routing] This private turn also holds a message from ${LOUNGE} and ${ROOM}, and your plain speech won't reach them. If one needs an answer there, use an explicit send tool.`,
      ]);
    } finally {
      await rig.close();
    }
  });

  it("a provider hold that keeps one of two equal wakes keeps the other's channels on it", async () => {
    const rig = await surfaceRig();
    try {
      // A gate wake carries its window's channels as a mark: take the mark
      // from a start's, where the batch gathers it.
      const started: InferenceRequest[] = [];
      rig.i.startAgentStream = async (_agent, trigger) => { if (trigger) started.push(trigger); };
      rig.i.pendingRequests.push(roomWake());
      await rig.i.processInferenceRequests();
      const mark = wakeChannelsMark(started[0]!)!;
      assert.ok(mark, 'control: the start carries the mark');
      const internalsOf = rig.framework as unknown as { holdRequest(held: InferenceRequest[], request: InferenceRequest): void };
      const now = Date.now();
      const windowWake = (channelId: string) => ({
        agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now, nonChannelOrigin: true,
        [mark]: [{ channelId, serverId: 'discord' }],
      }) as unknown as InferenceRequest;
      const held: InferenceRequest[] = [];
      internalsOf.holdRequest(held, windowWake(ROOM));
      internalsOf.holdRequest(held, windowWake(LOUNGE));
      assert.equal(held.length, 1, 'control: the two are equal, so one is kept');
      assert.deepEqual((held[0] as unknown as Record<symbol, unknown>)[mark], [
        { channelId: ROOM, serverId: 'discord' }, { channelId: LOUNGE, serverId: 'discord' },
      ]);
    } finally {
      rig.i.pendingRequests.length = 0;
      await rig.close();
    }
  });

  it("wakes merged by a quiesce keep the turns whose work they continue, and the start is judged by them", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        requestForTurn(a: string, r: string, s: string, t?: number): void;
        notePrivateTurn(turnId: number): void;
      };
      await rig.framework.quiesce();
      const turnId = (routingOf(rig.framework).turnId as number) + 500;
      // Two parked wakes with one key: the older continues a turn's work, and
      // the newer, which the quiesce keeps, continues none.
      internalsOf.requestForTurn('scout', 'tune-out cancelled', 'tune-out', turnId);
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'tune-out cancelled', source: 'tune-out', timestamp: Date.now() + 1 });
      await rig.i.processInferenceRequests();
      assert.equal(rig.i.pendingRequests.length, 1, 'control: the quiesce kept one of the two');
      assert.deepEqual(callerTurns(rig.i.pendingRequests[0]), [turnId], 'the kept wake carries the turn');
      // The turn turns private before the host resumes.
      internalsOf.notePrivateTurn(turnId);
      await rig.framework.resume();
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn after resume');
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
    } finally {
      await rig.close();
    }
  });

  it("a provider hold that keeps one of two equal wakes keeps the other's turns, and a start carries its batch's turns", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        holdRequest(held: InferenceRequest[], request: InferenceRequest): void;
        derivedTurnRequest(a: string, r: string, routing?: unknown): InferenceRequest;
      };
      const held: InferenceRequest[] = [];
      internalsOf.holdRequest(held, internalsOf.derivedTurnRequest('scout', 'prose-bounce', { turnId: 7 }));
      internalsOf.holdRequest(held, internalsOf.derivedTurnRequest('scout', 'prose-bounce', { turnId: 8 }));
      assert.equal(held.length, 1, 'control: the two are equal, so one is kept');
      assert.deepEqual(callerTurns(held[0]), [7, 8]);
      // A start carries every turn its batch continues, so a start held again
      // before its token is judged by them again.
      const started: InferenceRequest[] = [];
      rig.i.startAgentStream = async (_agent, trigger) => { if (trigger) started.push(trigger); };
      rig.i.pendingRequests.push(
        internalsOf.derivedTurnRequest('scout', 'prose-bounce', { turnId: 7 }),
        internalsOf.derivedTurnRequest('scout', 'refusal-retry', { turnId: 9 }),
      );
      await rig.i.processInferenceRequests();
      assert.deepEqual(callerTurns(started[0]).sort(), [7, 9], JSON.stringify(started));
    } finally {
      rig.i.pendingRequests.length = 0;
      await rig.close();
    }
  });

  it("a gate wake gives an agent only the channels it holds a message from, by its route's rule", async () => {
    const rig = await surfaceRig({ gate: { config: { policies: [], default: 'always' } } });
    try {
      const internalsOf = rig.framework as unknown as {
        conversationAgentHomes: Map<string, Ref>;
        eventGate: { requestInferenceFn(agentName: string, reason: string, source: string, provenance?: unknown): void };
      };
      const window = { nonChannelOrigin: true, channels: [{ channelId: ROOM, serverId: 'discord' }, { channelId: LOUNGE, serverId: 'discord' }] };
      internalsOf.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', window);
      const trunk = rig.i.pendingRequests.at(-1)!;
      // A conversation bound to the lounge holds no message from the room.
      internalsOf.conversationAgentHomes.set('scout', ref(LOUNGE));
      internalsOf.eventGate.requestInferenceFn('scout', 'gate:debounce', 'gate', window);
      const fork = rig.i.pendingRequests.at(-1)!;
      const mark = wakeChannelsMark(trunk)!;
      assert.deepEqual((trunk as unknown as Record<symbol, unknown>)[mark], window.channels, 'the trunk agent holds both');
      assert.deepEqual((fork as unknown as Record<symbol, unknown>)[mark], [{ channelId: LOUNGE, serverId: 'discord' }], 'the fork holds its own');
    } finally {
      (rig.framework as unknown as { conversationAgentHomes: Map<string, Ref> }).conversationAgentHomes.clear();
      rig.i.pendingRequests.length = 0;
      await rig.close();
    }
  });

  it("a private turn's round counts its channel_publish that names no channel as no send, by the stream's privacy", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as { channelRegistry: Record<string, unknown> };
      internalsOf.channelRegistry.getChannelTools = () => [{ name: 'channel_publish', description: 'Publish.', inputSchema: { type: 'object', properties: {} } }];
      internalsOf.channelRegistry.handleChannelToolCall = async () => ({ success: true, data: {} });
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'here is the answer' },
        { type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'to wherever' } },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      // Its publish was refused, so nothing silenced the round's words: the
      // turn's privacy kept them, both rounds', and no send held one as a draft.
      assert.ok(rig.texts().some((t) => t.startsWith('[delivered]') && t.includes('2 plain-speech segment(s) kept private (private turn')),
        JSON.stringify(rig.texts()));
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's boundary that injects a room's addressed message names the room with the injections, and moves nothing", async () => {
    let framework: AgentFramework | undefined;
    const tool = robot(() => {
      (framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown }).addMessage(
        'someone', [{ type: 'text', text: 'over here' }], { channelId: ROOM, serverId: 'discord', tags: ['chat:addressed'] });
    });
    const rig = await surfaceRig({ modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
      ] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      const wired = rig.streams[0]!.receivedToolResultOptions
        .flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
      assert.ok(wired.some((w) => w.includes('over here')), `control: the room's message was injected: ${JSON.stringify(wired)}`);
      assert.ok(wired.some((w) => w.includes(HOLDS_ROOM)), `the notice rode the injections: ${JSON.stringify(wired)}`);
      assert.equal(channelNotices(rig).length, 1, JSON.stringify(rig.texts()));
      assert.equal(rig.routings[0]!.locus, undefined, 'the private turn has no locus still');
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  for (const privateTurn of [true, false]) {
    it(`a ${privateTurn ? 'private' : "room's"} turn's boundary over budget ${privateTurn ? 'names an addressed message it took in, for the restart to read' : 'leaves an addressed message to move the restart, naming nothing'}`, async () => {
      // The tool round reports 10 input tokens, over the agent's budget of 5, so
      // its boundary can't inject what it stored and leaves it to the restart.
      const OTHER = 'discord:g:other';
      let framework: AgentFramework | undefined;
      const tool = robot(() => {
        (framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown }).addMessage(
          'someone', [{ type: 'text', text: 'over here' }], { channelId: OTHER, serverId: 'discord', tags: ['chat:addressed'] });
      });
      const rig = await surfaceRig({ maxStreamTokens: 5, modules: [tool] });
      framework = rig.framework;
      try {
        rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
        if (privateTurn) rig.framework.pushEvent(tuiMessage());
        else rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 2 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn and its restart');
        assert.deepEqual(rig.starts.map((r) => r.reason)[1], 'context_budget_restart', JSON.stringify(rig.starts));
        const wired = rig.streams[0]!.receivedToolResultOptions
          .flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
        assert.ok(!wired.some((w) => w.includes('over here')), `control: the boundary injected nothing: ${JSON.stringify(wired)}`);
        if (privateTurn) {
          assert.deepEqual(channelNotices(rig), [
            `[routing] This private turn also holds a message from ${OTHER}, and your plain speech won't reach it. If one needs an answer there, use an explicit send tool.`,
          ]);
          const all = rig.texts();
          assert.ok(all.findIndex((t) => t.startsWith('[routing] This private turn also holds')) < all.indexOf('reply 1'),
            `the notice is in the window before the restart's reply: ${JSON.stringify(all)}`);
          assert.ok(JSON.stringify(rig.membrane.calls.at(-1)).includes('This private turn also holds a message from'),
            "the notice is in the restart's request");
          assert.deepEqual(rig.routed, []);
        } else {
          assert.deepEqual(channelNotices(rig), [], "a room's turn names nothing");
          assert.deepEqual(rig.routed, [{ text: 'reply 1', locus: OTHER }], 'the message moved the restart to its channel');
        }
      } finally {
        await rig.close();
      }
    });
  }

  it("a gate wake names its window's channel messages, and a private turn that takes it names them", async () => {
    const gate = { config: { policies: [{ name: 'both', match: { scope: ['external-message', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate });
    try {
      const eventGate = (rig.framework as unknown as { eventGate: { evaluate(info: Record<string, unknown>): unknown } }).eventGate;
      rig.framework.pushEvent(tuiMessage());
      eventGate.evaluate({
        content: 'over here', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
        metadata: { author: { id: 'u1' } }, tags: ['chat:addressed'],
      });
      eventGate.evaluate({
        content: 'and here', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: LOUNGE,
        metadata: { author: { id: 'u2' } }, tags: ['chat:ambient'],
      });
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.deepEqual(channelNotices(rig), [
        `[routing] This private turn also holds a message from ${ROOM} and ${LOUNGE}, and your plain speech won't reach them. If one needs an answer there, use an explicit send tool.`,
      ]);
      assert.ok(noticeBeforeReply(rig), JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
  });

  it("a request that continues a turn's work is private exactly when that turn is, as it stands when the request comes", async () => {
    const asker = {
      name: 'asker', async start() {}, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false, error: 'none' }; },
      async onProcess(event: ProcessEvent) {
        return event.type === 'inference-request' ? { requestInference: [(event as { agentName: string }).agentName] } : {};
      },
    };
    const rig = await surfaceRig({ modules: [asker as never] });
    try {
      const internalsOf = rig.framework as unknown as { notePrivateTurn(turnId: number): void };
      const routing = routingOf(rig.framework);
      const ask = (callerTurnId?: number) => rig.framework.pushEvent({
        type: 'inference-request', agentName: 'scout', reason: 'subagent done', source: 'subagent',
        ...(callerTurnId !== undefined ? { callerTurnId } : {}),
      } as never);
      ask(routing.turnId as number);
      ask();
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the public asks');
      assert.ok(rig.starts.every((r) => r.nonChannelOrigin !== true), `a public turn's, and one that names none, are public: ${JSON.stringify(rig.starts)}`);
      // The turn took private input after its work began.
      internalsOf.notePrivateTurn(routing.turnId as number);
      const before = rig.starts.length;
      ask(routing.turnId as number);
      await rig.until(() => rig.starts.length > before && rig.framework.getAgent('scout')!.state.status === 'idle', 'the private ask');
      assert.ok(privateStart(rig.starts.at(-1)!), JSON.stringify(rig.starts.at(-1)));
    } finally {
      await rig.close();
    }
  });

  it("a turn is recorded private where it turns private: at its open, and when it takes in private input later", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        isPrivateTurn(turnId: number): boolean;
        makeTurnPrivate(agent: unknown, routing: Routing): unknown;
      };
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the private turn');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2 && rig.framework.getAgent('scout')!.state.status === 'idle', "the room's turn");
      const [opened, room] = rig.routings as Routing[];
      assert.equal(internalsOf.isPrivateTurn(opened!.turnId as number), true, 'a turn opened private');
      assert.equal(internalsOf.isPrivateTurn(room!.turnId as number), false, "control: the room's turn");
      internalsOf.makeTurnPrivate(rig.framework.getAgent('scout'), room!);
      assert.equal(internalsOf.isPrivateTurn(room!.turnId as number), true, 'a turn made private later');
    } finally {
      await rig.close();
    }
  });

  it("a gate window that holds a request continuing a private turn's work wakes one private turn", async () => {
    const asker = {
      name: 'asker', async start() {}, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false, error: 'none' }; },
      async onProcess(event: ProcessEvent) {
        return event.type === 'inference-request' ? { requestInference: [(event as { agentName: string }).agentName] } : {};
      },
    };
    const gate = { config: { policies: [{ name: 'both', match: { scope: ['inference-request', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate, modules: [asker as never] });
    try {
      const internalsOf = rig.framework as unknown as { notePrivateTurn(turnId: number): void };
      const routing = routingOf(rig.framework);
      internalsOf.notePrivateTurn(routing.turnId as number);
      const eventGate = (rig.framework as unknown as { eventGate: { evaluate(info: Record<string, unknown>): unknown } }).eventGate;
      rig.framework.pushEvent({ type: 'inference-request', agentName: 'scout', reason: 'subagent done', source: 'subagent', callerTurnId: routing.turnId } as never);
      eventGate.evaluate({
        content: 'over here', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
        metadata: { author: { id: 'u1' } }, tags: ['chat:addressed'],
      });
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      assert.equal(rig.starts.length, 1, JSON.stringify(rig.starts));
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  for (const privateWork of [true, false]) {
    it(`a room's turn whose boundary injects what ${privateWork ? 'a private' : 'a channel'} turn's work brought back ${privateWork ? 'is private from there' : 'stays the room\'s'}`, async () => {
      let framework: AgentFramework | undefined;
      let workTurn = 0;
      // As a script's wake or a module's result is stored: with the turn whose work it brings back.
      const tool = robot(() => {
        (framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown }).addMessage(
          'user', [{ type: 'text', text: 'the report you asked for' }], { callerTurnId: workTurn });
      });
      const rig = await surfaceRig({ modules: [tool] });
      framework = rig.framework;
      try {
        const internalsOf = rig.framework as unknown as { notePrivateTurn(turnId: number): void };
        workTurn = (routingOf(rig.framework).turnId as number) + 500;
        if (privateWork) internalsOf.notePrivateTurn(workTurn);
        rig.membrane.pushResponse(createMockResponse([
          { type: 'text', text: 'on my way' },
          { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
        ] as never, 'tool_use'));
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'here is what it said' }]));
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', "the room's turn");
        const wired = rig.streams[0]!.receivedToolResultOptions
          .flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
        assert.ok(wired.some((w) => w.includes('the report you asked for')), `control: the boundary injected it: ${JSON.stringify(wired)}`);
        if (privateWork) {
          assert.deepEqual(rig.routed, [{ text: 'on my way', locus: ROOM }], 'only the round before the injection went to the room');
          assert.ok(wired.some((w) => w.includes(PRIVATE_FROM_HERE)), `the notice rode the injections: ${JSON.stringify(wired)}`);
        } else {
          assert.deepEqual(rig.routed, [{ text: 'on my way', locus: ROOM }, { text: 'here is what it said', locus: ROOM }]);
        }
      } finally {
        await rig.close();
      }
    });
  }

  it("what a private turn's work brought back, stored while the agent is idle, makes its next start private", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        notePrivateTurn(turnId: number): void;
        addMessage(participant: string, content: unknown, metadata: unknown): unknown;
      };
      const workTurn = (routingOf(rig.framework).turnId as number) + 500;
      internalsOf.notePrivateTurn(workTurn);
      internalsOf.addMessage('user', [{ type: 'text', text: 'the report you asked for' }], { callerTurnId: workTurn });
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the start');
      assert.equal(rig.routings[0]!.nonChannelOrigin, true, "the room's start read it, so it is private");
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  for (const privateTurn of [true, false]) {
    it(`a ${privateTurn ? 'private' : 'channel'} turn's skip_reply self-wake and sleep wake ${privateTurn ? 'private' : 'channel'} turns`, async () => {
      const rig = await surfaceRig({ gate: { config: { policies: [], default: 'always' } } });
      const internalsOf = rig.framework as unknown as {
        notePrivateTurn(turnId: number): void;
        dispatchToolCall(agentName: string, call: { id: string; name: string; input: unknown }, turnId?: number): void;
        dispatchSleepToolCall(agentName: string, call: { id: string; name: string; input: unknown; callerTurnId?: number }): void;
        channelRegistry: Record<string, unknown>;
        eventGate: {
          armSelfWake(agentName: string, seconds: number, source?: string, callerTurnId?: number): { inMs: number; armed: boolean };
          clearSleep(): unknown;
        };
      };
      try {
        const routing = routingOf(rig.framework);
        if (privateTurn) { routing.nonChannelOrigin = true; internalsOf.notePrivateTurn(routing.turnId as number); }
        rig.state.turnRouting.set('scout', routing as never);
        const turnId = routing.turnId as number;
        // skip_reply arms the self-wake with the turn it was called in.
        const gate = internalsOf.eventGate;
        const arm = gate.armSelfWake.bind(gate);
        const armed: unknown[][] = [];
        gate.armSelfWake = (...args) => { armed.push(args); return { inMs: 30_000, armed: true }; };
        internalsOf.channelRegistry.handleChannelToolCall = async () => ({ success: true, endTurn: true, data: { skipped: true } });
        internalsOf.dispatchToolCall('scout', { id: 'k1', name: 'skip_reply', input: { wake_in_seconds: 30 } }, turnId);
        assert.deepEqual(armed[0]?.slice(0, 4), ['scout', 30, 'skip_reply', turnId], JSON.stringify(armed));
        gate.armSelfWake = arm;
        // Its wake, a second later, goes by that turn.
        arm('scout', 1, 'skip_reply', turnId);
        await rig.until(() => rig.starts.some((r) => r.source === 'self-wake') && rig.framework.getAgent('scout')!.state.status === 'idle', 'the self-wake');
        assert.equal(rig.starts.find((r) => r.source === 'self-wake')!.nonChannelOrigin === true, privateTurn, JSON.stringify(rig.starts));
        // A sleep set in the turn wakes by it too.
        internalsOf.dispatchSleepToolCall('scout', { id: 's1', name: 'sleep', input: { seconds: 0.05, announce: false }, callerTurnId: turnId });
        await rig.until(() => rig.starts.some((r) => r.source === 'sleep') && rig.framework.getAgent('scout')!.state.status === 'idle', 'the sleep\'s wake');
        assert.equal(rig.starts.find((r) => r.source === 'sleep')!.nonChannelOrigin === true, privateTurn, JSON.stringify(rig.starts));
      } finally {
        internalsOf.eventGate.clearSleep();
        await rig.close();
      }
    });
  }

  it("a tune-out cancel asked for in a turn hands the resident's wake that turn", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        requestForTurn(agentName: string, reason: string, source: string, callerTurnId?: number): void;
        dispatchTuneOutToolCall(agentName: string, call: { id: string; name: string; input: unknown; callerTurnId?: number }): void;
        tuneOutCoordinator: unknown;
      };
      // The tool hands the cancel the turn it was called in.
      const cancels: unknown[][] = [];
      internalsOf.tuneOutCoordinator = { cancel: (...args: unknown[]) => { cancels.push(args); return { ok: true }; } };
      const turnId = (routingOf(rig.framework).turnId as number) + 500;
      internalsOf.dispatchTuneOutToolCall('scout', { id: 't1', name: 'tune_out', input: { channelId: ROOM, mode: 'cancel' }, callerTurnId: turnId });
      assert.equal(cancels[0]?.[5], turnId, JSON.stringify(cancels));
      // The resident's wake carries it, for its start to judge.
      internalsOf.requestForTurn('scout', 'tune-out cancelled', 'tune-out', turnId);
      assert.deepEqual(callerTurns(rig.i.pendingRequests.at(-1)), [turnId]);
      internalsOf.requestForTurn('scout', 'tune-out cancelled', 'tune-out');
      assert.deepEqual(callerTurns(rig.i.pendingRequests.at(-1)), [], 'one that names no turn carries none');
    } finally {
      rig.i.pendingRequests.length = 0;
      (rig.framework as unknown as { tuneOutCoordinator: unknown }).tuneOutCoordinator = null;
      await rig.close();
    }
  });

  it('a turn id is private once noted, public above the floor, and private when no longer known: evicted, or from before the framework', async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        notePrivateTurn(turnId: number): void; isPrivateTurn(turnId: number): boolean; privateTurnIds: Set<number>;
      };
      // Ids given out before this framework was made, by another one or an
      // earlier run of the process, are no longer known.
      const first = routingOf(rig.framework).turnId as number;
      assert.equal(internalsOf.isPrivateTurn(first - 1), true, 'an id from before the framework');
      const base = first + 1_000;
      assert.equal(internalsOf.isPrivateTurn(base + 100), false, 'unnoted, above the floor');
      internalsOf.notePrivateTurn(base + 100);
      assert.equal(internalsOf.isPrivateTurn(base + 100), true);
      // 4,095 more private turns fill the record. One more, noted last with
      // the lowest id of all, as a turn made private late can be: the record
      // keeps the 4,096 highest, so the lowest goes, and the floor rises to it.
      for (let i = 0; i < 4095; i++) internalsOf.notePrivateTurn(base + 200 + i);
      internalsOf.notePrivateTurn(base + 5);
      assert.equal(internalsOf.privateTurnIds.size, 4096, 'the record holds 4,096');
      assert.equal(internalsOf.isPrivateTurn(base + 5), true, 'evicted: no longer known, so private');
      assert.equal(internalsOf.isPrivateTurn(base + 3), true, 'below the floor: no longer known');
      assert.equal(internalsOf.isPrivateTurn(base + 50), false, 'above the floor and never private, though noted after the first');
      assert.equal(internalsOf.isPrivateTurn(base + 100), true, 'the first noted is kept, as one of the highest');
      assert.equal(internalsOf.isPrivateTurn(base + 150), false, 'never private');
      // A turn at or below the floor that turns private now isn't recorded:
      // it's private already, and the floor stays where it is.
      internalsOf.notePrivateTurn(base + 4);
      assert.equal(internalsOf.privateTurnIds.size, 4096);
      assert.equal(internalsOf.isPrivateTurn(base + 5), true, 'the floor stays at the highest evicted');
    } finally {
      await rig.close();
    }
  });

  it("a script's wake carries the turn that started the script, and so does its message", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        scriptWake(agentName: string, scriptId: string, text: string, label: string, startTurnId: number | undefined): Promise<void>;
      };
      const routing = routingOf(rig.framework);
      const woke = async (startTurnId: number | undefined) => {
        await internalsOf.scriptWake('scout', 's1', '[script s1] Woke you', 's1-wake', startTurnId);
        const asked = rig.i.pendingRequests.at(-1);
        rig.i.pendingRequests.length = 0;
        assert.equal(asked?.reason, 'script:wake');
        assert.notEqual(asked?.nonChannelOrigin, true, 'judged at its start, not here');
        return callerTurns(asked);
      };
      assert.deepEqual(await woke(routing.turnId as number), [routing.turnId], 'the wake carries its start turn');
      // Its message carries the turn whose work it brings back.
      const stored = rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ metadata?: Record<string, unknown> }>;
      assert.equal(stored.at(-1)?.metadata?.callerTurnId, routing.turnId, JSON.stringify(stored.at(-1)?.metadata));
      assert.deepEqual(await woke(undefined), [], 'a script started in no turn wakes as before');
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

  for (const privateBefore of [true, false]) {
    it(`an addressed arrival ${privateBefore ? 'a private turn notes' : 'a channel turn notes before turning private'} is named at the next start, and moves no locus`, async () => {
      const OTHER = 'discord:g:other';
      const rig = await surfaceRig();
      try {
        const internalsOf = rig.framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown };
        const routing = routingOf(rig.framework);
        routing.arrivals = [];
        if (privateBefore) routing.nonChannelOrigin = true;
        else routing.locus = ref(ROOM);
        rig.state.openLogical.set('scout', routing);
        // Stored while none of the turn's streams runs: an arrival.
        internalsOf.addMessage('someone', [{ type: 'text', text: 'over here' }], { channelId: OTHER, serverId: 'discord', tags: ['chat:addressed'] });
        assert.equal((routing.arrivals as unknown[]).length, 1, `noted: ${JSON.stringify(routing.arrivals)}`);
        // The start that continues the turn is private, by a private wake.
        rig.i.pendingRequests.push(tuiWake());
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the start');
        assert.equal(rig.routings[0], routing, 'control: the start continued the turn');
        assert.equal(routing.locus, undefined, 'no locus');
        assert.deepEqual(channelNotices(rig), [
          `[routing] This private turn also holds a message from ${OTHER}, and your plain speech won't reach it. If one needs an answer there, use an explicit send tool.`,
        ]);
        assert.deepEqual(rig.routed, []);
      } finally {
        rig.state.openLogical.delete('scout');
        await rig.close();
      }
    });
  }
});
