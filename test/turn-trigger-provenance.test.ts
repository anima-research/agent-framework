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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, ApiModule, readInboundSource } from '../src/index.js';
import { isNonChannelSurfaceEvent } from '../src/framework.js';
import type { InferenceRequest, Module, ProcessEvent, ProcessState, EventResponse } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class SurfaceModule implements Module {
  readonly name = 'surface';
  constructor(private readonly quiet: readonly string[] = [], private readonly unstored: readonly string[] = []) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message' && event.type !== 'api:message') return {};
    if (this.unstored.includes(String((event as { source?: unknown }).source))) return { requestInference: true };
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: !this.quiet.includes(String((event as { source?: unknown }).source)),
    };
  }
}

class SlowModule implements Module {
  readonly name = 'test';
  private readonly gates: Array<() => void> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return [{ name: 'slow', description: 'Answers when released.', inputSchema: { type: 'object' as const, properties: {} } }]; }
  async handleToolCall() {
    await new Promise<void>((resolve) => this.gates.push(resolve));
    return { success: true, data: {} };
  }
  release(): boolean {
    const gate = this.gates.shift();
    gate?.();
    return gate !== undefined;
  }
  get waiting(): number { return this.gates.length; }
  async onProcess(): Promise<EventResponse> { return {}; }
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

  for (const fromFramework of [true, false]) {
    it(`a turn woken by ${fromFramework ? "the framework's own MCPL tool-list notice speaks as on main" : "a module's event with the notice's fields is private"}`, async () => {
      const rig = await surfaceRig();
      try {
        const internalsOf = rig.framework as unknown as {
          mcplTools: Array<{ name: string }>;
          emitMcplToolDiff(oldToolNames: Set<string>, serverId: string): void;
        };
        internalsOf.mcplTools = [{ name: 'fresh_tool' }];
        if (fromFramework) internalsOf.emitMcplToolDiff(new Set(), 'tools-server');
        else {
          rig.framework.pushEvent({
            type: 'external-message', source: 'mcpl:tools-server', content: 'New tools available: fresh_tool',
            metadata: { newTools: ['fresh_tool'], removedTools: [] },
          } as never);
        }
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn the notice wakes');
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed.map((r) => r.locus), fromFramework ? [LOUNGE] : []);
      } finally {
        await rig.close();
      }
    });
  }
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
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

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

const ROOM = 'discord:g:room';
const LOUNGE = 'discord:g:lounge';
type Ref = { serverId: string; channelId: string };
const ref = (channelId: string): Ref => ({ serverId: 'discord', channelId });
const tuiMessage = (content = 'private question') =>
  ({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true }) as never;

async function surfaceRig(opts: {
  gate?: unknown; maxStreamTokens?: number; modules?: Module[]; agent?: Record<string, unknown>;
  storeDir?: string;
  quietSources?: string[];
  unstoredSources?: string[];
  codeExecution?: Record<string, unknown>;
  otherAgents?: string[];
} = {}) {
  const tempDir = opts.storeDir ?? mkdtempSync(join(tmpdir(), 'surface-edges-test-'));
  const membrane = new MockMembrane();
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
    }, ...(opts.otherAgents ?? []).map((name) => ({ name, model: 'test-model', systemPrompt: name }))],
    modules: [new SurfaceModule(opts.quietSources, opts.unstoredSources), ...(opts.modules ?? [])],
    ...(opts.gate ? { gate: opts.gate } : {}),
    ...(opts.codeExecution ? { codeExecution: { enabled: true, ...opts.codeExecution } } : {}),
  } as never);
  const routed: Array<{ text: string; locus: string | null }> = [];
  const typing: string[] = [];
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
  i.startAgentStream = async (agent, trigger) => {
    if (trigger) starts.push(trigger);
    return start(agent, trigger);
  };
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
  const whileRunning = async (cond: () => boolean, what: string) => {
    const running = framework.runUntilIdle();
    const deadline = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what} (starts: ${JSON.stringify(starts)})`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return { running };
  };
  const texts = () => (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
    .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
  return {
    framework, membrane, streams, routed, typing, starts, state, i, until, whileRunning, texts, holdRoutes,
    close: async () => { await framework.stop(); if (!opts.storeDir) rmSync(tempDir, { recursive: true, force: true }); },
  };
}

type Routing = Record<string, unknown>;
const routingOf = (framework: AgentFramework): Routing =>
  (framework as unknown as { routingOf(name: string): Routing }).routingOf('scout');
const tuiWake = (): InferenceRequest => ({ agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: Date.now(), nonChannelOrigin: true });
const roomWake = (): InferenceRequest => ({
  agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(), channelId: ROOM, addressed: true,
});
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
const PRIVATE_FROM_HERE = '[routing] Private input came into this turn';
const storeOperatorMessage = (framework: AgentFramework) =>
  (framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown }).addMessage(
    'user', [{ type: 'text', text: 'for your eyes only' }], { inboundSource: { kind: 'surface', surface: 'tui', acceptedAt: Date.now() } });

const NO_DEFAULT_CHANNEL = 'This private turn has no default channel';
const stored = (rig: { framework: AgentFramework }) =>
  JSON.stringify(rig.framework.getAgent('scout')!.getContextManager().getAllMessages());

describe('private wins, one way', () => {

  it('a gate window with a private message, which nothing stores, and an addressed room message wakes one private turn, which routes nothing', async () => {
    const gate = { config: { policies: [{ name: 'both', match: { scope: ['external-message', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate, unstoredSources: ['tui'] });
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
      assert.deepEqual(rig.routed, [], 'nothing is routed');
    } finally {
      await rig.close();
    }
  });

  it('a continuation that takes in a private wake makes its channel turn private from there, and says so, in either order', async () => {
    for (const [mode, privateFirst] of [['locus', false], ['locus', true], ['hybrid', false]] as const) {
      const rig = await surfaceRig({ agent: { proseRouting: mode } });
      const label = `${mode}, ${privateFirst ? 'the private wake' : 'the continuation'} queued first`;
      try {
        const routing = routingOf(rig.framework);
        routing.triggerChannel = ref(ROOM);
        routing.locus = ref(ROOM);
        if (mode === 'hybrid') routing.pin = ref('discord:g:other');
        rig.state.openLogical.set('scout', routing);
        const arrivalMeta = { channelId: 'discord:g:elsewhere', tags: ['chat:addressed'], source: 'mcpl:channel-incoming' };
        const arrivalId = rig.framework.getAgent('scout')!.getContextManager().addMessage('user', [{ type: 'text', text: 'over here' }], arrivalMeta as never);
        (rig.framework as unknown as { noteArrival(agentName: string, metadata: unknown, id: unknown): void }).noteArrival('scout', arrivalMeta, arrivalId);
        const continuation: InferenceRequest = { agentName: 'scout', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() };
        rig.i.pendingRequests.push(...(privateFirst ? [tuiWake(), continuation] : [continuation, tuiWake()]));
        await rig.until(() => rig.starts.length >= 1, 'the continuation');
        await rig.framework.runUntilIdle();
        assert.equal(rig.starts.length, 1, `${label}: one start takes both: ${JSON.stringify(rig.starts)}`);
        assert.deepEqual(rig.routed, [], `${label}: its speech went to no channel, the arrival's included`);
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
        const routing = routingOf(rig.framework);
        routing.nonChannelOrigin = true;
        rig.state.openLogical.set('scout', routing);
        if (mode === 'explicit') rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 1, 'the start');
        await rig.framework.runUntilIdle();
        assert.equal(rig.starts.length, 1, `${mode}: ${JSON.stringify(rig.starts)}`);
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
    let framework: AgentFramework | undefined;
    const tool = robot(() => { internals(framework!).pendingRequests.push(roomWake()); });
    const rig = await surfaceRig({ maxStreamTokens: 5, modules: [tool] });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 2, 'the turn and its restart');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.starts.map((s) => s.reason), ['external-message', 'context_budget_restart'], `control: the turn restarted: ${JSON.stringify(rig.starts)}`);
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
      await rig.until(() => rig.starts.length >= 2, "the room's turn, then the operator message's");
      await rig.framework.runUntilIdle();
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
      storeOperatorMessage(rig.framework);
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1, "the room's start");
      await rig.framework.runUntilIdle();
      assert.equal(rig.routed.length, 0, `its reply went to no channel: ${JSON.stringify(rig.routed)}`);
      assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, 'and the resident is told why');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's next start");
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM], JSON.stringify(rig.routed));
    } finally {
      await rig.close();
    }
  });

  it("a budget restart that reads a stored private message is told so, unless it's silent", async () => {
    for (const silent of [true, false]) {
      const rig = await surfaceRig();
      const label = silent ? 'a silent restart' : 'control: a restart that can publish';
      try {
        const routing = routingOf(rig.framework);
        rig.state.openLogical.set('scout', routing);
        storeOperatorMessage(rig.framework);
        rig.i.pendingRequests.push({ agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(), ...(silent ? { suppressProse: true } : {}) });
        await rig.until(() => rig.starts.length >= 1, 'the restart');
        await rig.framework.runUntilIdle();
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
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'hello' } }] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tidied up' }]));
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
      await rig.until(() => rig.starts.length >= 1, 'the silent start');
      await rig.framework.runUntilIdle();
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's start");
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed, []);
      assert.ok(stored(rig).includes(NO_DEFAULT_CHANNEL), 'the silent start is private: its channel_publish naming no channel was refused');
      assert.equal(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)).length, 1, JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
    const control = await surfaceRig();
    try {
      (control.state.channelRegistry as Record<string, unknown>).handleChannelToolCall = async () => ({ success: true, data: { published: true } });
      control.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'hello' } }] as never, 'tool_use'));
      control.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tidied up' }]));
      control.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
      await control.until(() => control.starts.length >= 1 && control.framework.getAgent('scout')!.state.status === 'idle', 'the silent start');
      await control.framework.runUntilIdle();
      assert.ok(stored(control).includes('"p1"'), `control: the call was made: ${stored(control).slice(-3000)}`);
      assert.ok(!stored(control).includes(NO_DEFAULT_CHANNEL), `control: with no private input, the same call isn't refused as private: ${stored(control).slice(-3000)}`);
    } finally {
      await control.close();
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
        const kept = texts.find((t) => t.includes('was kept private')) ?? '';
        assert.ok(kept, `the resident is told its words were kept private: ${JSON.stringify(texts)}`);
        assert.match(kept, />> prefix|explicit send tool/, 'and how to publish');
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
      const wired = rig.streams[0]!.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []).map((m) => JSON.stringify(m.content));
      assert.ok(wired.some((w) => w.includes('and one more thing')), `control: its boundary took in the second message: ${JSON.stringify(wired)}`);
      assert.deepEqual(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)), [], 'it was private already, so nothing says it became so');
    } finally {
      await rig.close();
    }
  });

  for (const mode of ['explicit', 'disabled'] as const) {
    it(`a ${mode}-mode room start that a stored operator message makes private is told why, and names no channel`, async () => {
      const rig = await surfaceRig({ agent: { proseRouting: mode } });
      try {
        storeOperatorMessage(rig.framework);
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', "the room's start");
        const told = rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE));
        assert.equal(told.length, 1, JSON.stringify(rig.texts()));
        assert.match(told[0]!, /explicit send tool/, 'it says how to reach a channel');
        if (mode === 'explicit') assert.match(told[0]!, />> prefix/, told[0]);
        assert.deepEqual(rig.texts().filter((t) => t.startsWith('[routing] This private turn also holds')), []);
      } finally {
        await rig.close();
      }
    });
  }

  it("a disabled-mode turn is told once that it's private when private input comes in at a boundary", async () => {
    let framework: AgentFramework | undefined;
    const tool = robot(() => framework!.pushEvent(tuiMessage('for your eyes only')));
    const rig = await surfaceRig({ modules: [tool], agent: { proseRouting: 'disabled' } });
    framework = rig.framework;
    try {
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      await rig.framework.runUntilIdle();
      const told = rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE));
      assert.equal(told.length, 1, JSON.stringify(rig.texts()));
      assert.match(told[0]!, /explicit send tool/, 'it says how to reach a channel');
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
      let release = (): void => {};
      try {
        release = rig.holdRoutes();
        rig.membrane.pushResponse(createMockResponse([
          { type: 'text', text: `${prefix}${ROOM} on my way\n${prefix}discord:g:other and over there` },
          { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
        ] as never, 'tool_use'));
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
        rig.i.pendingRequests.push(roomWake());
        const run = await rig.whileRunning(() => rig.texts().some((t) => t.startsWith(PRIVATE_FROM_HERE)), `${mode}: the boundary makes the turn private`);
        release();
        await run.running;
        await rig.until(() => rig.starts.length >= 2, `${mode}: the operator message's own turn`);
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed.map((r) => r.text), ['on my way', 'and over there'],
          `${mode}: round 1's words went where they named, and nothing after: ${JSON.stringify(rig.routed)}`);
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
      assert.deepEqual(rig.routed, [], 'its speech went to no channel');
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
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'hello' } }] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tidied up' }]));
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
      await rig.until(() => rig.starts.length >= 1 && rig.texts().includes('for your eyes only'), "the silent turn, and the boundary's store");
      await rig.framework.runUntilIdle();
      assert.ok(stored(rig).includes(NO_DEFAULT_CHANNEL), 'the silent turn is private from the boundary: its channel_publish naming no channel was refused');
      assert.deepEqual(rig.texts().filter((t) => t.startsWith(PRIVATE_FROM_HERE)), [], 'a silent turn, whose speech goes nowhere, is told nothing');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's start");
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it('a boundary that ends the turn leaves it a channel turn, and marks the private input it stored for the next start', async () => {
    let framework: AgentFramework | undefined;
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
      assert.ok(!rig.texts().some((t) => t.startsWith(PRIVATE_FROM_HERE)), 'nothing made the ended turn private');
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 2, "the room's next start");
      await rig.framework.runUntilIdle();
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
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
        rig.framework.pushEvent(tuiMessage());
        await rig.until(() => rig.starts.length >= 1, `${mode}: the private turn`);
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed, [{ text: 'a note for them\nand the rest of it', locus: 'discord:g:other' }],
          `${mode}: the envelope runs to the next envelope line, and nothing later follows it: ${JSON.stringify(rig.routed)}`);
      } finally {
        await rig.close();
      }
    }
  });

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
      const live = routingOf(rig.framework);
      live.nonChannelOrigin = true;
      internalsOf.notePrivateTurn(live.turnId as number);
      const earlier = (live.turnId as number) + 7;
      const publish = (id: string, callerTurnId?: number) => internalsOf.dispatchChannelToolCall('scout', {
        id, name: 'channel_publish', input: { content: 'hello' }, ...(callerTurnId !== undefined ? { callerTurnId } : {}),
      });
      publish('in-live', live.turnId as number);
      publish('in-earlier', earlier);
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
    const negated = /\b(not|needn't|optional|may omit|may leave)\b/;
    const rule = publish.description.split(/(?<=\.)\s+/).find((sentence) => sentence.includes('private input')) ?? '';
    for (const fact of [/\bmust\b/, /private input/, /a script such a turn started/]) assert.match(rule, fact);
    assert.doesNotMatch(rule, negated);
    const channelId = (publish.inputSchema as unknown as { properties: { channelId: { description: string } } }).properties.channelId;
    const clause = channelId.description.split(';').find((part) => part.includes('private input')) ?? '';
    for (const fact of [/\brequired of\b/, /private input/, /a script such a turn started/]) assert.match(clause, fact);
    assert.doesNotMatch(clause, negated);
  });

  it("a private turn's channel_publish that names no channel is refused, and says how to name one", async () => {
    const rig = await surfaceRig();
    try {
      const results: Array<{ success: boolean; error?: string }> = [];
      const internalsOf = rig.framework as unknown as {
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
      internalsOf.dispatchChannelToolCall('scout', { id: 'c1', name: 'channel_publish', input: { content: 'hello' } });
      assert.equal(results[0]?.success, false, 'refused');
      assert.match(results[0]!.error!, /private/, 'it says why');
      assert.match(results[0]!.error!, /channelId/, 'it says what to give');
      assert.match(results[0]!.error!, /channel_list/, 'and where to find an id, for an agent that may list them');
      (rig.framework as unknown as { conversationAgentHomes: Map<string, Ref> }).conversationAgentHomes.set('scout', ref(ROOM));
      (rig.state.channelRegistry as Record<string, unknown>).handleChannelToolCall = async () => ({ success: true, data: { published: true } });
      results.length = 0;
      internalsOf.dispatchChannelToolCall('scout', { id: 'c-fork', name: 'channel_publish', input: { content: 'hello' } });
      await new Promise((r) => setImmediate(r));
      assert.equal(results[0]?.success, false, "a fork's: refused too");
      assert.match(results[0]!.error!, /private/, "for the turn's privacy");
      (rig.framework as unknown as { conversationAgentHomes: Map<string, Ref> }).conversationAgentHomes.delete('scout');
      const canUse = (rig.framework as unknown as { canAgentUseTool(a: string, t: string): boolean }).canAgentUseTool;
      (rig.framework as unknown as { canAgentUseTool(a: string, t: string): boolean }).canAgentUseTool = (a, t) => t !== 'channel_list' && canUse.call(rig.framework, a, t);
      results.length = 0;
      internalsOf.dispatchChannelToolCall('scout', { id: 'c2', name: 'channel_publish', input: { content: 'hello' } });
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
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { content: 'hello' } }, false, true).cause, null);
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { channelId: ROOM, content: 'hello' } }, false, true).cause, 'send');
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { content: 'hello' } }, false, false).cause, 'send');
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

  it("a private turn's round speech stays on its surface and is counted as kept private", async () => {
    const rig = await surfaceRig({ modules: [robot()] });
    try {
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
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a turn that turns private at a boundary shows its speech handlers no channel of the wake that opened it", async () => {
    const heard: Array<{ nonChannelOrigin?: boolean; trigger?: { channelId?: string; channelServerId?: string; addressed?: boolean } }> = [];
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
      rig.i.pendingRequests.push({ ...roomWake(), channelServerId: 'discord' });
      await rig.until(() => heard.length >= 1, "the room's turn's speech");
      assert.equal(heard[0]!.nonChannelOrigin, true, 'control: the turn turned private');
      assert.equal(heard[0]!.trigger?.channelId, undefined, JSON.stringify(heard[0]!.trigger));
      assert.equal(heard[0]!.trigger?.channelServerId, undefined, JSON.stringify(heard[0]!.trigger));
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
      const refusal = records.find((r) => r.kind === 'refusal');
      assert.ok(refusal, JSON.stringify(records));
      assert.equal(refusal!.locus, null, 'a private turn has no incoming channel to name');
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  describe("an operator's retake", () => {
    type Rig = Awaited<ReturnType<typeof surfaceRig>>;
    const idle = (rig: Rig) => rig.framework.getAgent('scout')!.state.status === 'idle';
    const privateTurn = async (rig: Rig) => {
      const starts = rig.starts.length;
      rig.framework.pushEvent(tuiMessage('for your eyes only: what is the plan?'));
      await rig.until(() => rig.starts.length > starts && idle(rig), 'the private turn');
      assert.deepEqual(rig.routed, [], 'control: the private turn spoke in no channel');
    };
    const roomTurn = async (rig: Rig) => {
      const before = rig.routed.length;
      const starts = rig.starts.length;
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length > starts && idle(rig), 'the channel turn');
      await rig.framework.runUntilIdle();
      assert.deepEqual(rig.routed.slice(before).map((r) => r.locus), [ROOM], `control: the channel turn spoke in its channel: ${JSON.stringify(rig.routed)}`);
    };
    const nudge = async (rig: Rig) => {
      const before = rig.routed.length;
      const streams = rig.streams.length;
      assert.ok(rig.framework.nudgeAgent('scout', 'host-console').ok);
      await rig.until(() => rig.streams.length > streams && idle(rig), 'the nudged turn to run');
      await rig.framework.runUntilIdle();
      return rig.routed.slice(before);
    };
    const unstick = async (rig: Rig) => {
      const posted: string[] = [];
      const internalsOf = rig.framework as unknown as {
        postToChannel(serverId: string, channelId: string, content: string): Promise<void>;
        handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
      };
      internalsOf.postToChannel = async (_server, channelId) => { posted.push(channelId); };
      const before = rig.routed.length;
      const streams = rig.streams.length;
      const asked = await internalsOf.handleHostCommand('discord', { command: 'unstick', agentName: 'scout', channelId: ROOM, maxRewinds: 1 });
      assert.ok(asked.ok, JSON.stringify(asked));
      await rig.until(() => rig.streams.length > streams && idle(rig), 'the unstick turn to run');
      await rig.framework.runUntilIdle();
      assert.deepEqual(posted, [ROOM], "the outcome is the operator's notice, posted where it was asked");
      return rig.routed.slice(before);
    };
    const apiInferenceRequest = async (rig: Rig) => {
      const before = rig.routed.length;
      const streams = rig.streams.length;
      rig.framework.pushEvent({ type: 'api:inference-request', agentName: 'scout' } as never);
      await rig.until(() => rig.streams.length > streams && idle(rig), 'the requested turn to run');
      await rig.framework.runUntilIdle();
      return rig.routed.slice(before);
    };
    const acrossRestart = async (before: (rig: Rig) => Promise<void>, after: (rig: Rig) => Promise<void>) => {
      const storeDir = mkdtempSync(join(tmpdir(), 'surface-restart-test-'));
      try {
        const first = await surfaceRig({ storeDir });
        try { await before(first); } finally { await first.close(); }
        const second = await surfaceRig({ storeDir });
        try { await after(second); } finally { await second.close(); }
      } finally {
        rmSync(storeDir, { recursive: true, force: true });
      }
    };

    it("a nudge after a private turn speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await privateTurn(rig);
        assert.deepEqual(await nudge(rig), []);
      } finally {
        await rig.close();
      }
    });

    it("a nudge after a channel turn speaks as on main, in the fallback channel", async () => {
      const rig = await surfaceRig();
      try {
        await roomTurn(rig);
        assert.deepEqual((await nudge(rig)).map((r) => r.locus), [LOUNGE]);
      } finally {
        await rig.close();
      }
    });

    it("an unstick after a private turn speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await privateTurn(rig);
        assert.deepEqual(await unstick(rig), []);
      } finally {
        await rig.close();
      }
    });

    it("an inference request through the API after a private turn speaks in no channel", async () => {
      const rig = await surfaceRig({ modules: [new ApiModule()] });
      try {
        await privateTurn(rig);
        assert.deepEqual(await apiInferenceRequest(rig), []);
      } finally {
        await rig.close();
      }
    });

    it("an inference request through the API after a channel turn speaks as on main, in the fallback channel", async () => {
      const rig = await surfaceRig({ modules: [new ApiModule()] });
      try {
        await roomTurn(rig);
        assert.deepEqual((await apiInferenceRequest(rig)).map((r) => r.locus), [LOUNGE]);
      } finally {
        await rig.close();
      }
    });

    it("a nudge asked for while a channel turn runs, which then takes in private input, speaks in no channel", async () => {
      let framework: AgentFramework | undefined;
      const tool = robot(() => {
        assert.ok(framework!.nudgeAgent('scout', 'host-console').ok);
        framework!.pushEvent({ type: 'external-message', source: 'console', content: 'for your eyes only', metadata: {} } as never);
      });
      const rig = await surfaceRig({ modules: [tool], quietSources: ['console'] });
      framework = rig.framework;
      try {
        rig.membrane.pushResponse(createMockResponse([
          { type: 'text', text: 'on my way' },
          { type: 'tool_use', id: 'm1', name: 'robot--move', input: {} },
        ] as never, 'tool_use'));
        rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'about what you asked' }]));
        const streams = rig.streams.length;
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.streams.length >= streams + 2 && idle(rig), "the room's turn, then the nudged one");
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed, [{ text: 'on my way', locus: ROOM }], 'only the round before the private input reached a channel');
      } finally {
        await rig.close();
      }
    });

    for (const fromPrivate of [true, false]) {
      it(`a nudge after a ${fromPrivate ? 'private turn and a silent heartbeat tick speaks in no channel' : 'channel turn and a silent heartbeat tick speaks as on main'}`, async () => {
        const rig = await surfaceRig();
        try {
          if (fromPrivate) await privateTurn(rig); else await roomTurn(rig);
          const starts = rig.starts.length;
          rig.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
          await rig.until(() => rig.starts.length > starts && idle(rig), 'the silent tick');
          await rig.framework.runUntilIdle();
          assert.deepEqual((await nudge(rig)).map((r) => r.locus), fromPrivate ? [] : [LOUNGE]);
        } finally {
          await rig.close();
        }
      });
    }

    for (const step of ['an undo', 'a redo'] as const) {
      it(`a nudge after ${step}, following a channel turn, speaks in no channel: the turn it retakes isn't known`, async () => {
        const rig = await surfaceRig();
        try {
          await roomTurn(rig);
          await roomTurn(rig);
          assert.ok(rig.framework.undoLastTurn('scout').undone);
          if (step === 'a redo') assert.ok(rig.framework.redo('scout').redone);
          assert.deepEqual(await nudge(rig), []);
          assert.ok(rig.texts().some((t) => t.startsWith('[delivered]') && t.includes('kept private (private turn')), 'the resident is told');
          await roomTurn(rig);
          assert.deepEqual((await nudge(rig)).map((r) => r.locus), [LOUNGE], 'a public turn since makes it known again');
        } finally {
          await rig.close();
        }
      });
    }

    it("a nudge after the operator switches back to a branch that ends on a private exchange speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await privateTurn(rig);
        const undone = rig.framework.undoLastTurn('scout');
        assert.ok(undone.undone && undone.fromBranch);
        await roomTurn(rig);
        await rig.framework.switchBranch(undone.fromBranch!);
        assert.deepEqual(await nudge(rig), []);
      } finally {
        await rig.close();
      }
    });

    it("a nudge after a rewind shed the channel turn that followed a private exchange speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await privateTurn(rig);
        await roomTurn(rig);
        const internalsOf = rig.framework as unknown as { shedNewestTurn(agent: unknown): { removedIds: unknown[] } | null };
        assert.ok(internalsOf.shedNewestTurn(rig.framework.getAgent('scout')), 'control: the channel turn was shed');
        assert.deepEqual(await nudge(rig), []);
      } finally {
        await rig.close();
      }
    });

    it("a nudge after the operator hides a range across a channel turn that followed a private exchange speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await privateTurn(rig);
        const store = (rig.framework as unknown as { addMessage(participant: string, content: unknown, metadata: unknown): unknown }).addMessage
          .bind(rig.framework);
        store('bob', [{ type: 'text', text: 'how is the build?' }], { messageId: 'd1', channelId: ROOM });
        await roomTurn(rig);
        store('bob', [{ type: 'text', text: 'thanks' }], { messageId: 'd2', channelId: ROOM });
        const hidden = await (rig.framework as unknown as {
          handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; hidden?: number; error?: string }>;
        }).handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId: 'd1', toMessageId: 'd2' });
        assert.ok(hidden.ok && (hidden.hidden ?? 0) >= 3, `control: the range took the channel turn's reply too: ${JSON.stringify(hidden)}`);
        assert.deepEqual(await nudge(rig), []);
      } finally {
        await rig.close();
      }
    });

    for (const step of ['undo', 'redo'] as const) {
      it(`another agent's ${step} on the shared store leaves this agent's nudge after its channel turn in no channel`, async () => {
        const rig = await surfaceRig({ otherAgents: ['ranger'] });
        try {
          const settled = () => ['scout', 'ranger'].every((name) => rig.framework.getAgent(name)!.state.status === 'idle');
          const channelTurn = async (agentName: string) => {
            const before = rig.routed.length;
            const starts = rig.starts.length;
            rig.i.pendingRequests.push({ ...roomWake(), agentName });
            await rig.until(() => rig.starts.length > starts && settled(), `${agentName}'s channel turn`);
            await rig.framework.runUntilIdle();
            assert.deepEqual(rig.routed.slice(before).map((r) => r.locus), [ROOM], `control: ${agentName}'s turn spoke in its channel`);
          };
          await channelTurn('scout');
          if (step === 'undo') {
            await channelTurn('ranger');
            assert.ok(rig.framework.undoLastTurn('scout').undone);
          } else {
            assert.ok(rig.framework.undoLastTurn('scout').undone);
            await channelTurn('ranger');
            assert.ok(rig.framework.redo('scout').redone);
          }
          const before = rig.routed.length;
          const streams = rig.streams.length;
          assert.ok(rig.framework.nudgeAgent('ranger', 'host-console').ok);
          await rig.until(() => rig.streams.length > streams && settled(), "ranger's nudged turn to run");
          await rig.framework.runUntilIdle();
          assert.deepEqual(rig.routed.slice(before), []);
        } finally {
          await rig.close();
        }
      });
    }

    it("after a restart, a nudge following a channel turn speaks in no channel: the turn it retakes isn't known", async () => {
      await acrossRestart(roomTurn, async (rig) => {
        assert.deepEqual(await nudge(rig), []);
      });
    });

    it("a nudge after a channel turn and a silent heartbeat tick that took in a stored private message speaks in no channel", async () => {
      const rig = await surfaceRig({ quietSources: ['console'] });
      try {
        await roomTurn(rig);
        rig.framework.pushEvent({ type: 'external-message', source: 'console', content: 'for your eyes only', metadata: {} } as never);
        await rig.until(() => stored(rig).includes('for your eyes only'), 'the private message stored');
        const starts = rig.starts.length;
        rig.i.pendingRequests.push({ agentName: 'scout', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true });
        await rig.until(() => rig.starts.length > starts && idle(rig), 'the silent tick');
        await rig.framework.runUntilIdle();
        assert.deepEqual(await nudge(rig), []);
      } finally {
        await rig.close();
      }
    });

    it("a nudge parked behind an auxiliary call, while the operator undoes the channel turn before it, speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await roomTurn(rig);
        const gate = (rig.framework as unknown as {
          providerGate(name: string): { auxiliaryInFlight: number; idleWaiters: Array<() => void> };
        }).providerGate('scout');
        gate.auxiliaryInFlight = 1;
        const before = rig.routed.length;
        const streams = rig.streams.length;
        assert.ok(rig.framework.nudgeAgent('scout', 'host-console').ok);
        await rig.until(() => gate.idleWaiters.length > 0, 'the nudge to park');
        assert.ok(rig.framework.undoLastTurn('scout').undone, 'the operator undoes while it waits');
        gate.auxiliaryInFlight = 0;
        for (const resolve of gate.idleWaiters.splice(0)) resolve();
        await rig.until(() => rig.streams.length > streams && idle(rig), 'the nudged turn to run');
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed.slice(before), []);
      } finally {
        await rig.close();
      }
    });

    it("a nudge merged with a channel's wake after a private turn speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        await privateTurn(rig);
        const before = rig.routed.length;
        const starts = rig.starts.length;
        const streams = rig.streams.length;
        rig.i.pendingRequests.push(roomWake());
        assert.ok(rig.framework.nudgeAgent('scout', 'host-console').ok);
        await rig.until(() => rig.streams.length > streams && idle(rig), 'the merged turn to run');
        await rig.framework.runUntilIdle();
        assert.equal(rig.starts.length, starts + 1, 'control: one start took both');
        assert.deepEqual(rig.routed.slice(before), []);
      } finally {
        await rig.close();
      }
    });
  });

  describe("what a turn causes speaks where the turn would", () => {
    type Rig = Awaited<ReturnType<typeof surfaceRig>>;
    const idle = (rig: Rig) => rig.framework.getAgent('scout')!.state.status === 'idle';
    const firstTurn = async (rig: Rig, fromPrivate: boolean) => {
      if (fromPrivate) rig.framework.pushEvent(tuiMessage());
      else rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && idle(rig), 'the turn');
      await rig.framework.runUntilIdle();
    };
    const nextTurnRouted = async (rig: Rig, before: number) => {
      await rig.until(() => rig.starts.length >= 2 && idle(rig), 'the turn it causes');
      await rig.framework.runUntilIdle();
      return rig.routed.slice(before);
    };

    for (const fromPrivate of [true, false]) {
      it(`a ' !' continuation of a ${fromPrivate ? 'private turn speaks in no channel' : 'channel turn speaks as on main, in the fallback channel'}`, async () => {
        const rig = await surfaceRig({ agent: { proseRouting: 'hybrid' } });
        try {
          rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#elsewhere ! on it' }]));
          await firstTurn(rig, fromPrivate);
          assert.equal(rig.starts.length, 2, 'control: the continuation ran');
          assert.deepEqual(rig.routed.map((r) => r.text), fromPrivate ? ['on it'] : ['on it', 'reply 1']);
          if (!fromPrivate) assert.equal(rig.routed[1]!.locus, LOUNGE);
        } finally {
          await rig.close();
        }
      });
    }

    const toolTurns: Array<[string, unknown]> = [
      ["a skip_reply's wake", { name: 'skip_reply', input: { reason: 'later', wake_in_seconds: 1 } }],
      ["a sleep's wake", { name: 'sleep', input: { seconds: 1, announce: false } }],
    ];
    for (const [what, call] of toolTurns) {
      for (const fromPrivate of [true, false]) {
        it(`${what}, armed by the model in a ${fromPrivate ? 'private turn, speaks in no channel' : 'channel turn, speaks as on main'}`, async () => {
          const rig = await surfaceRig({ gate: { config: { policies: [], default: 'always' } } });
          try {
            rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'arm', ...(call as object) } as never], 'tool_use'));
            await firstTurn(rig, fromPrivate);
            assert.deepEqual(await nextTurnRouted(rig, 0), fromPrivate ? [] : [{ text: 'reply 1', locus: LOUNGE }]);
          } finally {
            (rig.framework as unknown as { eventGate: { clearSleep(): unknown } }).eventGate.clearSleep();
            await rig.close();
          }
        });
      }
    }

    for (const fromPrivate of [true, false]) {
      it(`a script the model left running in a ${fromPrivate ? 'private turn wakes turns that speak in no channel' : 'channel turn wakes turns that speak as on main'}, by wake_agent() and by its failure`, async () => {
        const slow = new SlowModule();
        const rig = await surfaceRig({ modules: [slow], codeExecution: { wakeMinIntervalMs: 0 }, agent: { allowedTools: 'all' } });
        try {
          const code = 'await tools["test--slow"]({});\nawait wake_agent({ found: 1 });\nawait tools["test--slow"]({});\nthrow new Error("watcher broke");';
          rig.membrane.pushResponse(createMockResponse([
            { type: 'tool_use', id: 'run', name: 'code_execution', input: { code, yield_time_ms: 100 } } as never,
          ], 'tool_use'));
          rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'armed' }]));
          await firstTurn(rig, fromPrivate);
          const before = rig.routed.length;
          assert.equal(before, fromPrivate ? 0 : 1, `control: the arming turn spoke where it should: ${JSON.stringify(rig.routed)}`);
          await rig.until(() => slow.waiting === 1, "the left script's first call");
          slow.release();
          await rig.until(() => rig.starts.length >= 2 && idle(rig) && slow.waiting === 1, "the wake_agent() wake's turn");
          slow.release();
          await rig.until(() => rig.starts.length >= 3 && idle(rig), "the failure's turn");
          await rig.framework.runUntilIdle();
          assert.deepEqual(rig.starts.map((r) => r.reason).slice(1), ['script:wake', 'script:wake'], JSON.stringify(rig.starts));
          assert.deepEqual(rig.routed.slice(before).map((r) => r.locus), fromPrivate ? [] : [LOUNGE, LOUNGE], JSON.stringify(rig.routed));
        } finally {
          await rig.close();
        }
      });
    }

    for (const fromPrivate of [true, false]) {
      it(`a retry after inference failures shed history, from a ${fromPrivate ? 'private turn, speaks in no channel' : 'channel turn, speaks as on main'}`, async () => {
        const rig = await surfaceRig();
        try {
          await firstTurn(rig, fromPrivate);
          const before = rig.routed.length;
          const internalsOf = rig.framework as unknown as {
            noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
          };
          for (let i = 0; i < 3; i++) internalsOf.noteInferenceExhausted('scout', 'the request was invalid', false, 'invalid_request');
          assert.deepEqual((await nextTurnRouted(rig, before)).map((r) => r.locus), fromPrivate ? [] : [LOUNGE]);
        } finally {
          await rig.close();
        }
      });
    }

    it("a script's wake queued while its turn was a channel's speaks in no channel once that turn turns private first", async () => {
      const rig = await surfaceRig();
      try {
        await firstTurn(rig, false);
        const before = rig.routed.length;
        const turn = routingOf(rig.framework);
        await (rig.framework as unknown as {
          scriptWake(agentName: string, scriptId: string, text: string, label: string, startTurnId: number): Promise<void>;
        }).scriptWake('scout', 's1', '[script s1] Woke you', 's1-wake', turn.turnId as number);
        (rig.framework as unknown as { makeTurnPrivate(agent: unknown, routing: unknown): unknown })
          .makeTurnPrivate(rig.framework.getAgent('scout'), turn);
        assert.deepEqual(await nextTurnRouted(rig, before), []);
      } finally {
        await rig.close();
      }
    });

    for (const reportId of ['its own', 'above the next run\'s floor'] as const) {
      it(`a private turn's script report deferred across an update's restart${reportId === 'its own' ? '' : ", naming an earlier run's turn id above the next run's floor,"} keeps the next run's start out of every channel, and leaves a later turn its channel`, async () => {
        const storeDir = mkdtempSync(join(tmpdir(), 'private-turn-restart-'));
        try {
          const first = await surfaceRig({ storeDir });
          let turnId: number;
          try {
            await firstTurn(first, true);
            turnId = routingOf(first.framework).turnId as number;
            await first.framework.quiesce({ reason: 'update' });
            await (first.framework as unknown as {
              scriptWake(agentName: string, scriptId: string, text: string, label: string, startTurnId: number): Promise<void>;
            }).scriptWake('scout', 's1', '[script s1] the build finished', 's1-ended', turnId);
            first.i.pendingRequests.length = 0;
            assert.equal(first.framework.getHostModeStatus().deferredWrites, 1, 'control: the report is deferred, and kept');
          } finally {
            await first.close();
          }
          if (reportId !== 'its own') {
            const queuePath = join(storeDir, 'store', 'recovery', 'deferred-writes.json');
            const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as { pending: Array<{ metadata?: Record<string, unknown> }> };
            assert.equal(queue.pending[0]?.metadata?.callerTurnId, turnId, 'control: the report names its turn');
            queue.pending[0]!.metadata!.callerTurnId = turnId + 1e9;
            writeFileSync(queuePath, JSON.stringify(queue));
          }
          const next = await surfaceRig({ storeDir });
          try {
            if (next.framework.getHostModeStatus().quiesced) await next.framework.resume();
            assert.ok(stored(next).includes('the build finished'), 'control: the next run stored the report');
            const channelTurn = async () => {
              const before = next.routed.length;
              const streams = next.streams.length;
              next.i.pendingRequests.push(roomWake());
              await next.until(() => next.streams.length > streams && next.framework.getAgent('scout')!.state.status === 'idle', 'a channel turn to run');
              await next.framework.runUntilIdle();
              return next.routed.slice(before).map((r) => r.locus);
            };
            assert.deepEqual(await channelTurn(), [], "the start that reads the earlier run's private report speaks in no channel");
            assert.deepEqual(await channelTurn(), [ROOM], 'a later channel turn speaks in its channel');
          } finally {
            await next.close();
          }
        } finally {
          rmSync(storeDir, { recursive: true, force: true });
        }
      });
    }

    it("a provider hold that holds a private wake beside an equal one wakes a turn that speaks in no channel", async () => {
      const rig = await surfaceRig();
      try {
        const internalsOf = rig.framework as unknown as {
          providerAccelerationCooldowns: Map<string, Record<string, unknown>>;
          releaseProviderAccelerationCooldown(agentName: string): void;
        };
        const now = Date.now();
        internalsOf.providerAccelerationCooldowns.set('scout', {
          startedAt: now, until: now + 60_000, timer: setTimeout(() => {}, 60_000), heldRequests: [], reason: 'a test hold', failures: 1,
        });
        rig.i.pendingRequests.push(
          { agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: now },
          { agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: now, nonChannelOrigin: true },
        );
        await rig.i.processInferenceRequests();
        assert.equal(rig.starts.length, 0, 'control: held');
        internalsOf.providerAccelerationCooldowns.get('scout')!.until = Date.now();
        internalsOf.releaseProviderAccelerationCooldown('scout');
        await rig.until(() => rig.starts.length >= 1 && idle(rig), 'the released turn');
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed, []);
      } finally {
        await rig.close();
      }
    });

    it("a module's message that carries a private turn's key leaves a channel turn speaking in its channel", async () => {
      let ctx: { addMessage(participant: string, content: unknown, metadata?: unknown): unknown } | undefined;
      let privateTurnId = 0;
      const writer = {
        name: 'writer',
        async start(c: typeof ctx) { ctx = c; }, async stop() {},
        getTools: () => [], async handleToolCall() { return { success: false }; },
        async onProcess(event: ProcessEvent) {
          return (event as { type: string }).type === 'writer:probe'
            ? { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'from its response' }], metadata: { callerTurnId: privateTurnId } }] }
            : {};
        },
      };
      const rig = await surfaceRig({ modules: [writer as never] });
      try {
        await firstTurn(rig, true);
        privateTurnId = routingOf(rig.framework).turnId as number;
        ctx!.addMessage('user', [{ type: 'text', text: 'from its context' }], { callerTurnId: privateTurnId });
        rig.framework.pushEvent({ type: 'writer:probe' } as never);
        await rig.framework.runUntilIdle();
        rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 2 && idle(rig), 'the channel turn');
        await rig.framework.runUntilIdle();
        assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM], 'the channel turn answered in its channel');
      } finally {
        await rig.close();
      }
    });
  });

  for (const privateTurn of [true, false]) {
    it(`a ${privateTurn ? 'private' : "room's"} turn's auto-continuation is ${privateTurn ? 'private, and publishes nothing' : "the room's, and speaks there"}`, async () => {
      const rig = await surfaceRig({ agent: { autoContinue: { maxConsecutive: 1 } } });
      try {
        if (privateTurn) rig.framework.pushEvent(tuiMessage());
        else rig.i.pendingRequests.push(roomWake());
        await rig.until(() => rig.starts.length >= 2 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn and its continuation');
        assert.equal(rig.starts.length, 2, JSON.stringify(rig.starts));
        if (privateTurn) {
          assert.deepEqual(rig.routed, [], 'neither turn published');
        } else {
          assert.deepEqual(rig.routed, [{ text: 'reply 1', locus: ROOM }, { text: 'reply 2', locus: ROOM }]);
        }
      } finally {
        await rig.close();
      }
    });
  }

  const channelNotices = (rig: { texts(): string[] }) => rig.texts().filter((t) => t.startsWith('[routing] This private turn also holds'));
  const named = (rig: { texts(): string[] }) => channelNotices(rig).map((t) => [...new Set(t.match(/discord:g:[a-z]+/g) ?? [])].sort());
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
        assert.deepEqual(named(rig), [[ROOM]]);
        assert.match(channelNotices(rig)[0]!, /explicit send/, 'it says how to answer there');
        assert.ok(noticeBeforeReply(rig), JSON.stringify(rig.texts()));
        assert.ok(JSON.stringify(rig.membrane.calls[0]).includes(channelNotices(rig)[0]!), 'the notice is in the request the reply answers');
        assert.deepEqual(rig.routed, []);
      } finally {
        await rig.close();
      }
    });
  }

  it("a room's turn made private by a stored operator message names the room it was woken for", async () => {
    const rig = await surfaceRig();
    try {
      storeOperatorMessage(rig.framework);
      rig.i.pendingRequests.push(roomWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
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
      assert.deepEqual(named(rig), [[ROOM]]);
      assert.deepEqual(rig.routed, []);
    } finally {
      rig.state.openLogical.delete('scout');
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
      assert.deepEqual(named(rig), [[ROOM], [LOUNGE]]);
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
      assert.deepEqual(named(rig).at(-1), ['discord:g:a', 'discord:g:b']);
    } finally {
      await rig.close();
    }
  });

  it("a quiesce that keeps one of two parked wakes keeps the other's channels on it, and the private start names both", async () => {
    const rig = await surfaceRig();
    try {
      await rig.framework.quiesce();
      const now = Date.now();
      rig.i.pendingRequests.push(
        { ...roomWake(), channelServerId: 'discord', timestamp: now },
        { ...roomWake(), channelId: LOUNGE, channelServerId: 'discord', timestamp: now + 1 },
        tuiWake(),
      );
      await rig.i.processInferenceRequests();
      assert.equal(rig.i.pendingRequests.filter((r) => r.channelId).length, 1, 'control: the quiesce kept one of the two');
      await rig.framework.resume();
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn after resume');
      assert.deepEqual(named(rig), [[LOUNGE, ROOM]]);
    } finally {
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
      assert.ok(rig.texts().some((t) => t.startsWith('[delivered]') && t.includes('2 plain-speech segment(s) kept private (private turn')),
        JSON.stringify(rig.texts()));
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's refused channel_publish is no send on the fallback path either, where no round is routed live", async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as { channelRegistry: Record<string, unknown> };
      internalsOf.channelRegistry.getChannelTools = () => [{ name: 'channel_publish', description: 'Publish.', inputSchema: { type: 'object', properties: {} } }];
      internalsOf.channelRegistry.handleChannelToolCall = async () => ({ success: true, data: {} });
      const call = { type: 'tool_use' as const, id: 'p1', name: 'channel_publish', input: { content: 'to wherever' } };
      const streamYielding = rig.membrane.streamYielding.bind(rig.membrane);
      rig.membrane.streamYielding = (request, options) => {
        const stream = streamYielding(request, options);
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          for await (const event of { [Symbol.asyncIterator]: iterate }) {
            if (event.type === 'tool-calls') {
              yield { ...event, context: { ...event.context, roundContent: undefined } };
            } else if (event.type === 'complete') {
              const round = [{ type: 'text' as const, text: 'here is the answer' }, call, { type: 'tool_result' as const, toolUseId: call.id, content: 'refused' }];
              yield { ...event, response: { ...event.response, content: [...round, ...event.response.content] } };
            } else yield event;
          }
        };
        return stream;
      };
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'here is the answer' }, call] as never, 'tool_use'));
      rig.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the turn');
      await rig.framework.runUntilIdle();
      const receipt = rig.texts().find((t) => t.startsWith('[delivered]')) ?? '';
      assert.ok(receipt.includes('kept private (private turn'), `the turn's privacy kept its words: ${JSON.stringify(rig.texts())}`);
      assert.ok(!receipt.includes('held as draft'), `no send held them as drafts to resend: ${receipt}`);
      const drafts = (rig.framework as unknown as { proseDrafts: { open(agent: string): unknown[] } }).proseDrafts.open('scout');
      assert.deepEqual(drafts, []);
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
      assert.deepEqual(named(rig), [[ROOM]], JSON.stringify(rig.texts()));
      assert.ok(wired.some((w) => w.includes('This private turn also holds') && w.includes(ROOM)), `the notice rode the injections: ${JSON.stringify(wired)}`);
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  for (const privateTurn of [true, false]) {
    it(`a ${privateTurn ? 'private' : "room's"} turn's boundary over budget ${privateTurn ? 'names an addressed message it took in, for the restart to read' : 'leaves an addressed message to move the restart, naming nothing'}`, async () => {
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
          assert.deepEqual(named(rig), [[OTHER]]);
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
      assert.deepEqual(named(rig), [[LOUNGE, ROOM]]);
      assert.ok(noticeBeforeReply(rig), JSON.stringify(rig.texts()));
    } finally {
      await rig.close();
    }
  });

  for (const privateWork of [true, false]) {
    it(`a room's turn whose boundary injects what ${privateWork ? 'a private' : 'a channel'} turn's work brought back ${privateWork ? 'is private from there' : 'stays the room\'s'}`, async () => {
      let framework: AgentFramework | undefined;
      let workTurn = 0;
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
      assert.deepEqual(rig.routed, []);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's same-round private think keeps its words as the resident's own choice", async () => {
    const rig = await surfaceRig({ modules: [robot()], agent: { sameRoundThinkTextPolicy: 'private' } });
    try {
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
      assert.match(receipt, /2 plain-speech segment\(s\) kept private \(private turn/, receipt);
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
        assert.equal(notices[0]!.includes('>>> envelope'), mode === 'hybrid', notices[0]);
        assert.ok(notices[0]!.includes('explicit send tool'), notices[0]);
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
        internalsOf.addMessage('someone', [{ type: 'text', text: 'over here' }], { channelId: OTHER, serverId: 'discord', tags: ['chat:addressed'] });
        rig.i.pendingRequests.push(tuiWake());
        await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the start');
        assert.deepEqual(named(rig), [[OTHER]]);
        assert.deepEqual(rig.routed, []);
      } finally {
        rig.state.openLogical.delete('scout');
        await rig.close();
      }
    });
  }

  it("an arrival removed before the private turn's next start isn't named", async () => {
    const OTHER = 'discord:g:other';
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        addMessage(participant: string, content: unknown, metadata: unknown): string;
        removeMessage(id: string): void;
      };
      const routing = routingOf(rig.framework);
      routing.arrivals = [];
      routing.nonChannelOrigin = true;
      rig.state.openLogical.set('scout', routing);
      const id = internalsOf.addMessage('someone', [{ type: 'text', text: 'over here' }], { channelId: OTHER, serverId: 'discord', tags: ['chat:addressed'] });
      internalsOf.removeMessage(id);
      rig.i.pendingRequests.push(tuiWake());
      await rig.until(() => rig.starts.length >= 1 && rig.framework.getAgent('scout')!.state.status === 'idle', 'the start');
      assert.deepEqual(channelNotices(rig), [], "the turn doesn't hold it, so it isn't named");
    } finally {
      rig.state.openLogical.delete('scout');
      await rig.close();
    }
  });
});
