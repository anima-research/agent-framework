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
    assert.equal(isNonChannelSurfaceEvent({ type: 'mcpl:channel-incoming', channelId: 'room' } as never), false);
  });
});


describe('surface provenance through the real scheduler', () => {
  it('[push, tui] chooses the first declared private kind and routes no prose', async () => {
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

  it('pushEvent carries metadata.channelId onto the turn trigger', async () => {
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
      type: 'external-message', source: 'bridge', content: 'channel input',
      metadata: { channelId: 'discord:g:room' }, triggerInference: true,
    });
    await framework.runUntilIdle();
    assert.equal(handed?.channelId, 'discord:g:room');
    assert.notEqual(handed?.nonChannelOrigin, true);
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

describe('private non-channel trigger batching', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'private-batch-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('does not borrow a sibling channel request from the same batch', async () => {
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [],
    });
    const i = internals(framework);
    const captured: InferenceRequest[] = [];
    i.startAgentStream = async (_agent: unknown, trigger?: InferenceRequest) => {
      if (trigger) captured.push(trigger);
    };
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: t, nonChannelOrigin: true },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t + 1,
        channelId: 'discord:g:room', addressed: true },
    );
    await i.processInferenceRequests();
    assert.ok(i.pendingRequests.some((r) => r.channelId === 'discord:g:room'));
    await i.processInferenceRequests();
    assert.equal(captured[0]?.nonChannelOrigin, true);
    assert.equal(captured[0]?.channelId, undefined);
    assert.equal(captured[0]?.addressed, false);
    assert.equal(captured[1]?.channelId, 'discord:g:room', 'requeued channel request gets its own turn');
    assert.equal(captured[1]?.addressed, true);
    await framework.stop();
  });

  it('runs a channel-first request separately and requeues the later private request', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'channel-first.chronicle'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [],
    });
    const i = internals(framework);
    const captured: InferenceRequest[] = [];
    i.startAgentStream = async (_agent: unknown, trigger?: InferenceRequest) => { if (trigger) captured.push(trigger); };
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:room', addressed: true },
      { agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: t + 1, nonChannelOrigin: true },
    );
    await i.processInferenceRequests();
    assert.ok(i.pendingRequests.some((request) => request.nonChannelOrigin));
    await i.processInferenceRequests();
    assert.equal(captured[0]?.channelId, 'discord:g:room');
    assert.equal(captured[0]?.nonChannelOrigin, undefined);
    assert.equal(captured[1]?.nonChannelOrigin, true);
    assert.equal(captured[1]?.channelId, undefined);
    await framework.stop();
  });

});

// ---------------------------------------------------------------------------
// The batch rules at their edges: a gate window, a quiesce
// and a continuation each keep a private surface's wake and a channel's
// apart, a channel-bound surface message keeps its addressing, and a private
// turn's sends name where they go.
// ---------------------------------------------------------------------------

const ROOM = 'discord:g:room';
const tuiMessage = (content = 'private question') =>
  ({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true }) as never;
const roomMessage = (addressed: boolean, content = 'room message') => ({
  type: 'external-message', source: 'bridge', content, triggerInference: true,
  metadata: { channelId: ROOM, ...(addressed ? { tags: ['chat:addressed'] } : {}) },
}) as never;

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
  membrane.streamYielding = (request, options) => {
    const queue = membrane as unknown as { responses: unknown[]; responseIndex: number };
    if (queue.responseIndex >= queue.responses.length) membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply ${++replies}` }]));
    return streamYielding(request, options);
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
  const state = framework as unknown as {
    turnRouting: Map<string, { nonChannelOrigin?: boolean; triggerChannel?: string; locus?: string }>;
    openLogical: Map<string, unknown>;
    channelRegistry: unknown;
  };
  state.channelRegistry = new Proxy({
    getChannelTools: () => [],
    resolveLocus: (agentName: string) => state.turnRouting.get(agentName)?.triggerChannel ?? 'discord:g:lounge',
    routeSpeech: async (_agent: string, text: string, locus: string | null) => {
      routed.push({ text, locus }); return { delivered: true, channelId: locus };
    },
    getDescriptor: () => undefined, getDefaultPublishChannel: () => 'discord:g:lounge',
  }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
  const i = internals(framework);
  const starts: InferenceRequest[] = [];
  const start = i.startAgentStream.bind(framework);
  i.startAgentStream = async (agent, trigger) => { if (trigger) starts.push(trigger); return start(agent, trigger); };
  // Polls, letting the scheduler run between looks: a debounce's wake is
  // queued by its timer, after the test has pushed its events.
  const until = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what} (starts: ${JSON.stringify(starts)})`);
      await new Promise((r) => setTimeout(r, 10));
      await framework.runUntilIdle();
    }
  };
  return {
    framework, membrane, routed, starts, state, i, until,
    close: async () => { await framework.stop(); rmSync(tempDir, { recursive: true, force: true }); },
  };
}

const privateStart = (r: InferenceRequest) => r.nonChannelOrigin === true && !r.channelId;
const roomStart = (r: InferenceRequest) => r.channelId === ROOM && r.nonChannelOrigin !== true;

describe('surface batches at their edges, through the real scheduler', () => {
  it('a channel-bound surface message that addressed the agent says so, directly and through the gate', async () => {
    const direct = await surfaceRig();
    try {
      direct.framework.pushEvent(roomMessage(true));
      await direct.until(() => direct.starts.length >= 1, 'the turn');
      assert.equal(direct.starts[0]!.channelId, ROOM);
      assert.equal(direct.starts[0]!.addressed, true);
    } finally {
      await direct.close();
    }
    const gate = { config: { policies: [{ name: 'surface', match: { scope: ['external-message'] }, behavior: { debounce: 50 } }], default: 'skip' } };
    const gated = await surfaceRig({ gate });
    try {
      gated.framework.pushEvent(roomMessage(true));
      await gated.until(() => gated.starts.length >= 1, 'the debounced turn');
      assert.equal(gated.starts[0]!.channelId, ROOM);
      assert.equal(gated.starts[0]!.addressed, true);
    } finally {
      await gated.close();
    }
  });

  it('a gate window with a private message and an addressed channel one wakes a turn for each, in either order', async () => {
    const gate = { config: { policies: [{ name: 'surface', match: { scope: ['external-message'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    for (const privateFirst of [true, false]) {
      const rig = await surfaceRig({ gate });
      try {
        const events = [tuiMessage(), roomMessage(true)];
        for (const event of privateFirst ? events : events.reverse()) rig.framework.pushEvent(event);
        await rig.until(() => rig.starts.length >= 2, 'two turns');
        await rig.framework.runUntilIdle();
        const label = privateFirst ? 'private first' : 'channel first';
        assert.equal(rig.starts.length, 2, `${label}: one turn per part of the window`);
        assert.ok((privateFirst ? privateStart : roomStart)(rig.starts[0]!), `${label}: the part that arrived first goes first`);
        assert.ok(rig.starts.some(privateStart), `${label}: a private turn`);
        const room = rig.starts.find(roomStart);
        assert.ok(room, `${label}: a turn for the room`);
        assert.equal(room!.addressed, true, `${label}: the room's turn knows it was addressed`);
        assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM], `${label}: only the room's turn spoke, in the room`);
      } finally {
        await rig.close();
      }
    }
  });

  it('a gate window with a private message and an ambient channel event wakes one private turn, which routes nothing', async () => {
    // The ambient event's wake names its room only as where it woke the
    // agent, so it has no channel to answer in: it shares the private turn,
    // whose content holds the operator's words too.
    const gate = { config: { policies: [{ name: 'both', match: { scope: ['external-message', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate });
    try {
      const eventGate = (rig.framework as unknown as { eventGate: { evaluate(info: Record<string, unknown>): unknown } }).eventGate;
      rig.framework.pushEvent(tuiMessage());
      eventGate.evaluate({
        content: 'room chatter', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
        metadata: { author: { id: 'u1' } }, tags: [],
      });
      await rig.until(() => rig.starts.length >= 1, 'the turn');
      await new Promise((r) => setTimeout(r, 300));
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts.length, 1, JSON.stringify(rig.starts));
      assert.ok(privateStart(rig.starts[0]!), JSON.stringify(rig.starts[0]));
      assert.deepEqual(rig.routed, [], 'nothing is routed');
    } finally {
      await rig.close();
    }
  });

  it('a quiesce parks a private wake and a channel-bound one apart, and each gets its own turn at resume', async () => {
    for (const privateFirst of [true, false]) {
      const rig = await surfaceRig();
      try {
        await rig.framework.quiesce();
        const events = [tuiMessage(), roomMessage(false)];
        for (const event of privateFirst ? events : events.reverse()) rig.framework.pushEvent(event);
        await rig.framework.runUntilIdle();
        assert.equal(rig.starts.length, 0, 'control: nothing starts while quiesced');
        await rig.framework.resume();
        await rig.until(() => rig.starts.length >= 2, 'two turns after resume');
        await rig.framework.runUntilIdle();
        const label = privateFirst ? 'private first' : 'channel first';
        assert.equal(rig.starts.length, 2, label);
        assert.ok(rig.starts.some(privateStart) && rig.starts.some(roomStart), `${label}: ${JSON.stringify(rig.starts)}`);
        assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM], `${label}: only the room's turn spoke`);
      } finally {
        await rig.close();
      }
    }
  });

  it('a quiesce keeps a private wake apart from an unclassified one with the same reason, so the newer one evicts neither', async () => {
    const rig = await surfaceRig();
    try {
      await rig.framework.quiesce();
      const now = Date.now();
      // As a debounce flush just before the quiesce leaves them: a private
      // window's wake, then an unclassified one's.
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
      assert.ok(privateStart(rig.starts[0]!), `the private wake leads its turn: ${JSON.stringify(rig.starts[0])}`);
      assert.deepEqual(rig.routed, [], 'nothing is routed');
    } finally {
      await rig.close();
    }
  });

  it("a continuation takes its open turn's kind, and a wake of the other kind gets a turn of its own, whichever was queued first", async () => {
    for (const [openPrivate, otherFirst] of [[true, false], [false, false], [true, true], [false, true]] as const) {
      const rig = await surfaceRig();
      try {
        // An open turn, as a stream that ended on tool use leaves one for the
        // non-streaming fallback's tool_results_ready to continue.
        const routing = (rig.framework as unknown as { routingOf(name: string): Record<string, unknown> }).routingOf('scout');
        if (openPrivate) routing.nonChannelOrigin = true;
        else routing.triggerChannel = ROOM;
        rig.state.openLogical.set('scout', routing);
        const other: InferenceRequest = openPrivate
          ? { agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: Date.now(), channelId: ROOM, nonChannelOrigin: false }
          : { agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: Date.now(), nonChannelOrigin: true };
        const continuation: InferenceRequest = { agentName: 'scout', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() };
        // A wake that arrives during the tool wait is queued ahead of the
        // results' tool_results_ready.
        rig.i.pendingRequests.push(...(otherFirst ? [other, continuation] : [continuation, other]));
        await rig.until(() => rig.starts.length >= 2, 'the continuation and the other kind\'s turn');
        await rig.framework.runUntilIdle();
        const label = `open ${openPrivate ? 'private' : 'channel'} turn, ${otherFirst ? 'the other kind queued first' : 'the continuation queued first'}`;
        assert.equal(rig.starts.length, 2, label);
        assert.equal(rig.starts[0]!.reason, 'tool_results_ready', `${label}: the continuation runs first`);
        if (openPrivate) {
          assert.ok(privateStart(rig.starts[0]!), `${label}: the continuation keeps the turn private: ${JSON.stringify(rig.starts[0])}`);
          assert.ok(roomStart(rig.starts[1]!), `${label}: the channel wake gets its own turn`);
        } else {
          assert.notEqual(rig.starts[0]!.nonChannelOrigin, true, label);
          assert.ok(privateStart(rig.starts[1]!), `${label}: the private wake gets its own turn`);
        }
      } finally {
        await rig.close();
      }
    }
  });

  it("a wake of the other kind alone waits while a turn is open, and starts its own turn once that turn ends", async () => {
    const rig = await surfaceRig();
    try {
      const routing = (rig.framework as unknown as { routingOf(name: string): Record<string, unknown> }).routingOf('scout');
      routing.nonChannelOrigin = true;
      rig.state.openLogical.set('scout', routing);
      // One pass of the scheduler: runUntilIdle would wait for the held wake.
      rig.i.pendingRequests.push({
        agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: Date.now(), channelId: ROOM, addressed: true,
      });
      await rig.i.processInferenceRequests();
      assert.equal(rig.starts.length, 0, `nothing continues the private turn with the room's wake: ${JSON.stringify(rig.starts)}`);
      assert.ok(rig.i.pendingRequests.some((r) => r.channelId === ROOM), 'the wake is still queued');
      // The private turn's continuation arrives, runs, and its stream's end
      // ends the turn.
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() });
      await rig.until(() => rig.starts.length >= 2, "the continuation, then the room's own turn");
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts[0]!.reason, 'tool_results_ready', JSON.stringify(rig.starts));
      assert.ok(privateStart(rig.starts[0]!), 'the continuation keeps the turn private');
      assert.ok(roomStart(rig.starts[1]!), JSON.stringify(rig.starts[1]));
      assert.equal(rig.starts[1]!.addressed, true);
      assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM]);
    } finally {
      await rig.close();
    }
  });

  it("a budget restart keeps its turn's kind, and a wake of the other kind that arrived meanwhile gets its own turn", async () => {
    // The tool round reports 10 input tokens, over the agent's budget of 5, so
    // its boundary restarts the stream; the tool's own work brings in a wake
    // of the other kind while the turn is running: an addressed room message
    // in a private turn, an operator's message in the room's.
    for (const privateFirst of [true, false]) {
      let framework: AgentFramework | undefined;
      const tools = {
        name: 'robot',
        async start() {}, async stop() {},
        getTools: () => [{ name: 'move', description: 'Move', inputSchema: { type: 'object', properties: {} } }],
        async handleToolCall() { framework!.pushEvent(privateFirst ? roomMessage(true) : tuiMessage()); return { success: true, data: 'moved' }; },
        async onProcess() { return {}; },
      } as unknown as Module;
      const rig = await surfaceRig({ maxStreamTokens: 5, modules: [tools] });
      framework = rig.framework;
      try {
        // The first stream's tool round; each later stream gets the rig's reply.
        rig.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'm1', name: 'robot--move', input: {} }] as never, 'tool_use'));
        rig.framework.pushEvent(privateFirst ? tuiMessage() : roomMessage(true));
        await rig.until(() => rig.starts.length >= 3, 'the turn, its restart and the other kind\'s turn');
        await rig.framework.runUntilIdle();
        const label = privateFirst ? 'a private turn' : "the room's turn";
        assert.deepEqual(rig.starts.map((s) => s.reason), ['external-message', 'context_budget_restart', 'external-message'], label);
        const [first, restart, other] = rig.starts as [InferenceRequest, InferenceRequest, InferenceRequest];
        if (privateFirst) {
          assert.ok(privateStart(first) && privateStart(restart), `${label}: the restart continues the private turn: ${JSON.stringify(rig.starts)}`);
          assert.ok(roomStart(other) && other.addressed === true, `${label}: the room message gets its own turn`);
        } else {
          assert.ok(roomStart(first) && roomStart(restart), `${label}: the restart continues the room's turn: ${JSON.stringify(rig.starts)}`);
          assert.ok(privateStart(other), `${label}: the operator's message gets its own private turn`);
        }
        // The room's turn spoke, once, in the room; the private turn's speech stayed on its surface.
        assert.deepEqual(rig.routed.map((r) => r.locus), [ROOM], label);
      } finally {
        await rig.close();
      }
    }
  });

  it("a private turn's channel_publish names where it goes, a fork's home included", async () => {
    const rig = await surfaceRig();
    try {
      const results: Array<{ success: boolean; error?: string }> = [];
      const internalsOf = rig.framework as unknown as {
        conversationAgentHomes: Map<string, string>;
        routingOf(name: string): Record<string, unknown>;
        dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
        pushEvent(event: unknown): void;
      };
      const push = internalsOf.pushEvent.bind(rig.framework);
      internalsOf.pushEvent = (event: unknown) => {
        const e = event as { type?: string; result?: { success: boolean; error?: string } };
        if (e.type === 'tool-result' && e.result) results.push(e.result);
        else push(event);
      };
      internalsOf.routingOf('scout').nonChannelOrigin = true;
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

  it("a private turn's refusal reacts in no channel", async () => {
    const rig = await surfaceRig();
    try {
      const reactions: unknown[] = [];
      const internalsOf = rig.framework as unknown as {
        channelRegistry: Record<string, unknown>;
        mcplServerRegistry: unknown;
        routingOf(name: string): Record<string, unknown>;
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
        internalsOf.routingOf('scout').nonChannelOrigin = true;
        await internalsOf.reactToRefusal('scout', 'refusal');
        assert.equal(reactions.length, 1, 'a private turn adds no reaction');
      } finally {
        internalsOf.mcplServerRegistry = servers;
      }
    } finally {
      await rig.close();
    }
  });

  it('a request a turn causes carries the turn\'s private origin, from the turn it names', async () => {
    const rig = await surfaceRig();
    try {
      const internalsOf = rig.framework as unknown as {
        routingOf(name: string): Record<string, unknown>;
        derivedTurnRequest(agentName: string, reason: string, routing?: unknown): InferenceRequest;
      };
      const live = internalsOf.routingOf('scout');
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
    const tools = {
      name: 'robot',
      async start() {}, async stop() {},
      getTools: () => [{ name: 'move', description: 'Move', inputSchema: { type: 'object', properties: {} } }],
      async handleToolCall() { return { success: true, data: 'moved' }; },
      async onProcess() { return {}; },
    } as unknown as Module;
    const rig = await surfaceRig({ modules: [tools] });
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
      const texts = (rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
        .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      assert.ok(texts.some((t) => t.startsWith('[delivered]') && t.includes('2 plain-speech segment(s) kept private (non-channel turn')), JSON.stringify(texts));
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
      const texts = (rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
        .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      assert.ok(texts.some((t) => t.startsWith('[delivered]') && t.includes('2 plain-speech segment(s) kept private (non-channel turn')), JSON.stringify(texts));
    } finally {
      await rig.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The scheduler's split, and a private turn's other paths, as the house's
// internal review of the whole change found them.
// ---------------------------------------------------------------------------

type Routing = Record<string, unknown>;
const routingOf = (framework: AgentFramework): Routing =>
  (framework as unknown as { routingOf(name: string): Routing }).routingOf('scout');
const tuiWake = (): InferenceRequest => ({ agentName: 'scout', reason: 'external-message', source: 'tui', timestamp: Date.now(), nonChannelOrigin: true });
const roomWake = (): InferenceRequest => ({ agentName: 'scout', reason: 'external-message', source: 'bridge', timestamp: Date.now(), channelId: ROOM });
const silentTick = (): InferenceRequest => ({
  agentName: 'scout', reason: 'mcpl:push-event', source: 'heartbeat', timestamp: Date.now(), suppressProse: true,
});

describe("the scheduler's split, and a private turn's other paths", () => {
  it('a silent tick at the head of a batch decides nothing: the open turn still holds the other kind', async () => {
    for (const openPrivate of [false, true]) {
      const rig = await surfaceRig();
      try {
        const routing = routingOf(rig.framework);
        if (openPrivate) routing.nonChannelOrigin = true;
        else routing.triggerChannel = ROOM;
        rig.state.openLogical.set('scout', routing);
        const other = openPrivate ? roomWake() : tuiWake();
        rig.i.pendingRequests.push(silentTick(), other);
        await rig.i.processInferenceRequests();
        const label = `open ${openPrivate ? 'private' : 'channel'} turn`;
        assert.ok(rig.i.pendingRequests.includes(other), `${label}: the other kind's wake waits: ${JSON.stringify(rig.starts)}`);
        assert.equal(rig.starts.length, 1, `${label}: the silent tick starts, and only it: ${JSON.stringify(rig.starts)}`);
        assert.equal(rig.starts[0]!.suppressProse, true, `${label}: ${JSON.stringify(rig.starts)}`);
        assert.equal(rig.starts[0]!.nonChannelOrigin, undefined, `${label}: the tick takes its own kind, not the turn's`);
        assert.equal(rig.state.openLogical.get('scout'), routing, `${label}: the open turn is left as it was`);
      } finally {
        await rig.close();
      }
    }
  });

  it('a turn that is neither private nor a channel\'s holds a private wake too, and takes a neutral one', async () => {
    const rig = await surfaceRig();
    try {
      // An open turn with no channel of its own, as a heartbeat's.
      const routing = routingOf(rig.framework);
      rig.state.openLogical.set('scout', routing);
      const wake = tuiWake();
      rig.i.pendingRequests.push(wake);
      await rig.i.processInferenceRequests();
      assert.equal(rig.starts.length, 0, `the private wake starts nothing in it: ${JSON.stringify(rig.starts)}`);
      assert.ok(rig.i.pendingRequests.includes(wake), 'it waits');
      // A neutral wake continues the turn, and the private one still waits.
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'timer', source: 'clock', timestamp: Date.now() });
      await rig.i.processInferenceRequests();
      assert.equal(rig.starts.length, 1, JSON.stringify(rig.starts));
      assert.equal(rig.starts[0]!.reason, 'timer');
      assert.notEqual(rig.starts[0]!.nonChannelOrigin, true);
      assert.ok(rig.i.pendingRequests.includes(wake), 'the private wake still waits');
    } finally {
      await rig.close();
    }
  });

  it("an idle open turn's hold resets when something of its kind comes, and past its bound the turn ends and its held wakes start", async () => {
    const holdsOf = (rig: Awaited<ReturnType<typeof surfaceRig>>) =>
      (rig.framework as unknown as { openTurnHolds: Map<string, { turn: unknown; since: number }> }).openTurnHolds;
    const openChannelTurn = (rig: Awaited<ReturnType<typeof surfaceRig>>) => {
      const routing = routingOf(rig.framework);
      routing.triggerChannel = ROOM;
      rig.state.openLogical.set('scout', routing);
      return routing;
    };
    const first = await surfaceRig();
    try {
      const routing = openChannelTurn(first);
      first.i.pendingRequests.push(tuiWake());
      await first.i.processInferenceRequests();
      assert.equal(first.starts.length, 0);
      assert.equal(holdsOf(first).get('scout')?.turn, routing, "the hold's clock starts at the first pass that finds nothing of the turn's kind");
      // Long past the bound, a pass that finds the turn's own kind resets it,
      // and the turn goes on.
      holdsOf(first).get('scout')!.since -= 31_000;
      first.i.pendingRequests.push({ agentName: 'scout', reason: 'timer', source: 'clock', timestamp: Date.now() });
      await first.i.processInferenceRequests();
      assert.equal(first.starts.length, 1, 'the neutral wake continued the turn');
      assert.equal(first.starts[0]!.reason, 'timer');
      assert.equal(holdsOf(first).has('scout'), false, 'and reset the clock');
    } finally {
      await first.close();
    }
    const second = await surfaceRig();
    try {
      const routing = openChannelTurn(second);
      const traces: Array<Record<string, unknown>> = [];
      second.framework.onTrace((event) => { if (event.type === 'inference:request_stale') traces.push(event as unknown as Record<string, unknown>); });
      second.i.pendingRequests.push(tuiWake());
      await second.i.processInferenceRequests();
      const since = holdsOf(second).get('scout')!.since;
      // A pass under the bound keeps the turn open, and its clock.
      holdsOf(second).get('scout')!.since -= 29_000;
      await second.i.processInferenceRequests();
      assert.equal(second.state.openLogical.get('scout'), routing, 'under the bound, the turn stays open');
      assert.equal(holdsOf(second).get('scout')?.since, since - 29_000, 'and its clock runs on');
      assert.equal(second.starts.length, 0);
      holdsOf(second).get('scout')!.since -= 2_000;
      const lines: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
      try {
        await second.i.processInferenceRequests();
      } finally {
        console.error = error;
      }
      assert.notEqual(second.state.openLogical.get('scout'), routing, 'past the bound, the turn ends');
      assert.ok(lines.some((line) => line.includes('[inference-stale] agent=scout') && line.includes('ending the turn')), JSON.stringify(lines));
      assert.equal(traces.length, 1, JSON.stringify(traces));
      assert.equal(traces[0]!.agentStatus, 'idle+turn-open');
      assert.equal(traces[0]!.requestCount, 1);
      assert.ok((traces[0]!.oldestRequestAge as number) >= 0, JSON.stringify(traces[0]));
      await second.until(() => second.starts.some(privateStart), 'the held wake starts its own turn');
      assert.deepEqual(second.routed, []);
    } finally {
      await second.close();
    }
  });

  it("a pass about another turn, a silent tick's budget restart, leaves an open turn's hold clock as it is", async () => {
    const rig = await surfaceRig();
    try {
      const holds = (rig.framework as unknown as { openTurnHolds: Map<string, { turn: unknown; since: number }> }).openTurnHolds;
      const routing = routingOf(rig.framework);
      routing.triggerChannel = ROOM;
      rig.state.openLogical.set('scout', routing);
      rig.i.pendingRequests.push(tuiWake());
      await rig.i.processInferenceRequests();
      const since = holds.get('scout')!.since;
      // A silent tick ran beside the held turn, and its stream left a budget
      // restart: the tick's routing is the agent's live one.
      const tick = { ...(routing as object), nonChannelOrigin: false, triggerChannel: undefined } as Record<string, unknown>;
      rig.state.turnRouting.set('scout', tick);
      rig.i.pendingRequests.push({ agentName: 'scout', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(), suppressProse: true });
      await rig.i.processInferenceRequests();
      assert.ok(rig.starts.some((s) => s.reason === 'context_budget_restart'), `control: the restart ran: ${JSON.stringify(rig.starts)}`);
      assert.equal(holds.get('scout')?.turn, routing, "the held turn's clock is still there");
      assert.equal(holds.get('scout')?.since, since, 'and unchanged');
    } finally {
      await rig.close();
    }
  });

  it("a gate window's channel-bound surface message keeps its own turn beside a private message, though newer ambient chatter shares its part", async () => {
    const gate = { config: { policies: [{ name: 'both', match: { scope: ['external-message', 'mcpl:channel-incoming'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate });
    try {
      const eventGate = (rig.framework as unknown as { eventGate: { evaluate(info: Record<string, unknown>): unknown } }).eventGate;
      rig.framework.pushEvent(tuiMessage());
      rig.framework.pushEvent(roomMessage(false));
      await rig.framework.runUntilIdle();
      eventGate.evaluate({
        content: 'newer room chatter', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
        metadata: { author: { id: 'u2' } }, tags: [],
      });
      await rig.until(() => rig.starts.length >= 2, 'a turn for each part');
      await rig.framework.runUntilIdle();
      assert.ok(rig.starts.some(privateStart), JSON.stringify(rig.starts));
      assert.ok(rig.starts.some(roomStart), `the channel-bound message's part keeps its channel: ${JSON.stringify(rig.starts)}`);
    } finally {
      await rig.close();
    }
  });

  it("a provider hold keeps a gate window's private wake beside its other part, though both have one reason, source and time", async () => {
    const rig = await surfaceRig();
    try {
      const cooldowns = (rig.framework as unknown as { providerAccelerationCooldowns: Map<string, Record<string, unknown>> }).providerAccelerationCooldowns;
      const now = Date.now();
      const timer = setTimeout(() => {}, 60_000);
      try {
        cooldowns.set('scout', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'a test hold', failures: 1 });
        rig.i.pendingRequests.push(
          { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now },
          { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now, nonChannelOrigin: true },
        );
        await rig.i.processInferenceRequests();
        const held = cooldowns.get('scout')!.heldRequests as InferenceRequest[];
        assert.equal(held.length, 2, JSON.stringify(held));
        assert.ok(held.some((r) => r.nonChannelOrigin === true), 'the private wake is held, not dropped as the other part');
      } finally {
        clearTimeout(timer);
        cooldowns.delete('scout');
        rig.i.pendingRequests.length = 0;
      }
    } finally {
      await rig.close();
    }
  });

  it("a window's parts go in the order their first events arrived, though a shared buffer holds them as their debounces fired", async () => {
    const gate = { config: { policies: [
      { name: 'slow', match: { scope: ['external-message'] }, behavior: { debounce: 300 } },
      { name: 'fast', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 30 } },
    ], default: 'skip' } };
    const rig = await surfaceRig({ gate });
    try {
      const eventGate = (rig.framework as unknown as {
        eventGate: { evaluate(info: Record<string, unknown>): unknown; onInferenceStarted(name: string): void; onInferenceEnded(name: string): void; inferenceDiagnostics(): { bufferedEvents: number } };
      }).eventGate;
      // While an agent infers, each policy's firing goes to one buffer.
      eventGate.onInferenceStarted('elsewhere');
      rig.framework.pushEvent(tuiMessage());
      // The framework hands the operator's message to the gate as it
      // processes it.
      await rig.framework.runUntilIdle();
      await new Promise((r) => setTimeout(r, 20));
      eventGate.evaluate({
        content: 'over here', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
        metadata: { author: { id: 'u1' } }, tags: ['chat:addressed'],
      });
      await rig.until(() => eventGate.inferenceDiagnostics().bufferedEvents >= 2, 'both firings buffered, the room\'s first');
      eventGate.onInferenceEnded('elsewhere');
      await rig.until(() => rig.starts.length >= 2, 'a turn for each part');
      await rig.framework.runUntilIdle();
      assert.ok(privateStart(rig.starts[0]!), `the operator's message arrived first, so its turn goes first: ${JSON.stringify(rig.starts)}`);
      assert.ok(roomStart(rig.starts[1]!), JSON.stringify(rig.starts[1]));
    } finally {
      await rig.close();
    }
  });

  it('a gate window with a private message and an unaddressed channel-bound one wakes a turn for each', async () => {
    const gate = { config: { policies: [{ name: 'surface', match: { scope: ['external-message'] }, behavior: { debounce: 100 } }], default: 'skip' } };
    const rig = await surfaceRig({ gate });
    try {
      rig.framework.pushEvent(tuiMessage());
      rig.framework.pushEvent(roomMessage(false));
      await rig.until(() => rig.starts.length >= 2, 'two turns');
      await rig.framework.runUntilIdle();
      assert.ok(rig.starts.some(privateStart), JSON.stringify(rig.starts));
      const room = rig.starts.find(roomStart);
      assert.ok(room, 'the channel-bound message names its channel, unaddressed as it is');
      assert.notEqual(room!.addressed, true);
    } finally {
      await rig.close();
    }
  });

  it("a channel-bound surface message's channel isn't another agent's when a conversation fork owns it", async () => {
    const gate = { config: { policies: [{ name: 'surface', match: { scope: ['external-message'] }, behavior: { debounce: 50 } }], default: 'skip' } };
    for (const viaGate of [false, true]) {
      const rig = await surfaceRig(viaGate ? { gate } : {});
      try {
        (rig.framework as unknown as { conversationAgentHomes: Map<string, string> }).conversationAgentHomes.set('scout-fork', ROOM);
        rig.framework.pushEvent(roomMessage(true));
        await rig.until(() => rig.starts.length >= 1, 'the trunk agent\'s turn');
        await rig.framework.runUntilIdle();
        const label = viaGate ? 'through the gate' : 'directly';
        assert.equal(rig.starts[0]!.channelId, undefined, `${label}: ${JSON.stringify(rig.starts[0])}`);
        assert.notEqual(rig.starts[0]!.addressed, true, label);
        assert.ok(!rig.routed.some((r) => r.locus === ROOM), `${label}: nothing lands in the fork's channel`);
      } finally {
        await rig.close();
      }
    }
  });

  it('a quiesce keeps a channel-bound wake apart from an unclassified one with the same reason', async () => {
    const rig = await surfaceRig();
    try {
      await rig.framework.quiesce();
      const now = Date.now();
      rig.i.pendingRequests.push(
        { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now, channelId: ROOM },
        { agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: now + 1 },
      );
      await rig.i.processInferenceRequests();
      assert.equal(rig.starts.length, 0, 'control: nothing starts while quiesced');
      await rig.framework.resume();
      await rig.until(() => rig.starts.length >= 1, 'the turn after resume');
      await rig.framework.runUntilIdle();
      assert.equal(rig.starts[0]!.channelId, ROOM, `the newer unclassified wake didn't evict the channel's: ${JSON.stringify(rig.starts)}`);
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

  it("a private turn's channel_publish that names a channel goes there, from the model and from a call made as the agent", async () => {
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
      assert.deepEqual(calls.map((c) => (c.input as { channelId?: string }).channelId), [ROOM], 'the model\'s named publish went through');
      // A call made as the agent, during its private turn, keeps the rule.
      const refused = await internalsOf.executeToolCall({ id: 'p2', name: 'channel_publish', input: { content: 'hello' }, callerAgentName: 'scout' });
      assert.equal(refused.success, false);
      assert.match(refused.error!, /channel_publish requires an explicit channelId/);
      const named = await internalsOf.executeToolCall({ id: 'p3', name: 'channel_publish', input: { channelId: ROOM, content: 'hello' }, callerAgentName: 'scout' });
      assert.equal(named.success, true);
      // Its round counts a refused publish as no send, and a named one as one.
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { content: 'hello' } }).cause, null);
      assert.equal(internalsOf.roundCallOf('scout', { name: 'channel_publish', input: { channelId: ROOM, content: 'hello' } }).cause, 'send');
      // Outside any turn, a call made as the agent isn't judged by the turn that ended.
      rig.state.openLogical.delete('scout');
      const after = await internalsOf.executeToolCall({ id: 'p4', name: 'channel_publish', input: { content: 'hello' }, callerAgentName: 'scout' });
      assert.equal(after.success, true, JSON.stringify(after));
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
      rig.framework.pushEvent(roomMessage(true));
      await rig.until(() => heard.length >= 2, "the room's speech");
      await rig.framework.runUntilIdle();
      assert.equal(heard[0]!.nonChannelOrigin, true);
      assert.notEqual(heard[1]!.nonChannelOrigin, true);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's inference:started is marked private for trace listeners", async () => {
    const started: Array<{ nonChannelOrigin?: boolean }> = [];
    const listener = {
      name: 'tracer',
      async start(ctx: { onTrace(listener: (event: { type: string; nonChannelOrigin?: boolean }) => void): () => void }) {
        ctx.onTrace((event) => { if (event.type === 'inference:started') started.push(event); });
      },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false }; },
      async onProcess() { return {}; },
    } as unknown as Module;
    const rig = await surfaceRig({ modules: [listener] });
    try {
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => started.length >= 1, 'the private turn');
      await rig.framework.runUntilIdle();
      rig.framework.pushEvent(roomMessage(true));
      await rig.until(() => started.length >= 2, "the room's turn");
      await rig.framework.runUntilIdle();
      assert.equal(started[0]!.nonChannelOrigin, true);
      assert.equal(started[1]!.nonChannelOrigin, undefined);
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
      await rig.until(() => rig.starts.length >= 2, 'the turn and its rewind\'s retry');
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

  it("a private turn's hooks are told its frozen state, through the real before-inference wiring", async () => {
    const rig = await surfaceRig();
    try {
      const turns: unknown[] = [];
      const internalsOf = rig.framework as unknown as { hookOrchestrator: unknown; channelRegistry: Record<string, unknown> };
      // The orchestrator's other calls do nothing here.
      internalsOf.hookOrchestrator = new Proxy({ beforeInference: async () => [] }, {
        get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined,
      });
      // In a turn's hooks, the registry is asked with the turn's frozen state.
      internalsOf.channelRegistry.buildChannelContext = (_name: string, turn?: unknown) => { if (turn) turns.push(turn); return undefined; };
      rig.framework.pushEvent(tuiMessage());
      await rig.until(() => turns.length >= 1, 'the private turn\'s hooks');
      await rig.framework.runUntilIdle();
      rig.framework.pushEvent(roomMessage(true));
      await rig.until(() => turns.length >= 2, 'the room\'s');
      await rig.framework.runUntilIdle();
      assert.deepEqual(turns[0], { frozenLocus: null, privateTurn: true });
      assert.deepEqual(turns[1], { frozenLocus: ROOM, privateTurn: false });
    } finally {
      await rig.close();
    }
  });

  it("a private turn's same-round private think keeps its words as the resident's own choice", async () => {
    const robot = {
      name: 'robot',
      async start() {}, async stop() {},
      getTools: () => [{ name: 'move', description: 'Move', inputSchema: { type: 'object', properties: {} } }],
      async handleToolCall() { return { success: true, data: 'moved' }; },
      async onProcess() { return {}; },
    } as unknown as Module;
    const rig = await surfaceRig({ modules: [robot], agent: { sameRoundThinkTextPolicy: 'private' } });
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
      const texts = (rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
        .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      const receipt = texts.find((t) => t.startsWith('[delivered]')) ?? '';
      assert.match(receipt, /1 plain-speech segment\(s\) kept private \(skip_reply or a private think\)/, receipt);
      assert.match(receipt, /1 plain-speech segment\(s\) kept private \(non-channel turn/, receipt);
    } finally {
      await rig.close();
    }
  });

  it("a private turn's round that skip_reply silences counts its words as the resident's own choice, not the surface's", async () => {
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
      const texts = (rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
        .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      const receipt = texts.find((t) => t.startsWith('[delivered]')) ?? '';
      assert.match(receipt, /1 plain-speech segment\(s\) kept private \(skip_reply or a private think\)/, receipt);
      assert.doesNotMatch(receipt, /non-channel turn/, receipt);
    } finally {
      await rig.close();
    }
  });

  it("a private hybrid turn's speech with no target, mid-turn and trailing, is kept private and held as no draft", async () => {
    const robot = {
      name: 'robot',
      async start() {}, async stop() {},
      getTools: () => [{ name: 'move', description: 'Move', inputSchema: { type: 'object', properties: {} } }],
      async handleToolCall() { return { success: true, data: 'moved' }; },
      async onProcess() { return {}; },
    } as unknown as Module;
    const rig = await surfaceRig({ modules: [robot], agent: { proseRouting: 'hybrid' } });
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
      const texts = (rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
        .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      const receipt = texts.find((t) => t.startsWith('[delivered]')) ?? '';
      assert.match(receipt, /2 plain-speech segment\(s\) kept private \(non-channel turn — publish only with an explicit send tool or a >>> envelope\)/, receipt);
    } finally {
      await rig.close();
    }
  });

  it("the notice that speech has no channel names a >>> envelope in hybrid mode, and only there", async () => {
    for (const mode of ['locus', 'hybrid'] as const) {
      const rig = await surfaceRig({ agent: { proseRouting: mode } });
      try {
        const announce = (rig.framework as unknown as { announceLocusIfChanged(agentName: string, locus: string | null): void })
          .announceLocusIfChanged.bind(rig.framework);
        announce('scout', ROOM);
        announce('scout', null);
        const notices = (rig.framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>)
          .flatMap((m) => m.content).map((b) => b.text ?? '').filter((t) => t.startsWith('[routing] Your plain speech currently goes to no channel'));
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
      await rig.close();
    }
  });
});
