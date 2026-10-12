/**
 * Integration tests for per-channel conversation routing: incoming MCPL
 * channel messages spawn/route to fork agents instead of the primary
 * conversation when FrameworkConfig.conversations is set.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent, ConversationRouterConfig, TraceEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function incomingEvent(overrides: {
  channelId: string;
  text: string;
  mentioned?: boolean;
  channelType?: string;
  messageId?: string;
}): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'srv',
    channelId: overrides.channelId,
    messageId: overrides.messageId ?? `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'alice' },
    content: [{ type: 'text', text: overrides.text }],
    timestamp: new Date().toISOString(),
    metadata: {
      mentioned: overrides.mentioned ?? false,
      ...(overrides.channelType ? { channel_type: overrides.channelType } : {}),
    },
    triggerInference: true,
  } as unknown as ProcessEvent;
}

describe('Conversation routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'conv-routing-test-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework(
    conversations: Partial<ConversationRouterConfig> = {},
    storeFile = 'test.chronicle',
  ) {
    return AgentFramework.create({
      storePath: join(tempDir, storeFile),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' },
      ],
      modules: [],
      conversations: { templateAgent: 'trunk', ...conversations },
    });
  }

  /** Make a binding look idle past the TTL and re-arm the sweep throttle —
   * deterministic expiry instead of racing a 1ms TTL against the wall clock. */
  function forceExpiry(framework: AgentFramework, channelId: string, idleTtlMs: number) {
    const binding = framework.getConversationRouter()!.getBinding(channelId);
    assert.ok(binding, `binding for ${channelId} should exist before forcing expiry`);
    binding!.lastActivity = Date.now() - idleTtlMs - 1_000;
    (framework as unknown as { lastConversationSweep: number }).lastConversationSweep = 0;
  }

  it('rejects an unknown template agent at creation', async () => {
    await assert.rejects(
      () => AgentFramework.create({
        storePath: join(tempDir, 'test.chronicle'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'x' }],
        modules: [],
        conversations: { templateAgent: 'nope' },
      }),
      /templateAgent "nope"/,
    );
  });

  // Deprecation (agent-framework#235): behavior unchanged, one stderr line.
  function deprecationWarnings(warn: { mock: { calls: Array<{ arguments: unknown[] }> } }): string[] {
    return warn.mock.calls
      .map((c) => String(c.arguments[0]))
      .filter((line) => line.startsWith('[deprecated]') && line.includes('conversation routing'));
  }

  it('configured: logs one [deprecated] line per framework and still routes', async () => {
    const warn = mock.method(console, 'warn', () => {});
    let framework: AgentFramework | undefined;
    try {
      framework = await makeFramework();
      assert.equal(deprecationWarnings(warn).length, 1, 'warned once at creation');
      assert.match(deprecationWarnings(warn)[0]!, /agent-framework#235/);

      // Routing is unchanged: a DM and a channel mention each spawn a fork.
      // (One queued response per stream: MockMembrane hands a stream every
      // response still queued.)
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi alice!' }]));
      framework.pushEvent(incomingEvent({ channelId: 'slack:D1', text: 'hello there', channelType: 'im' }));
      await framework.runUntilIdle();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'On it.' }]));
      framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'bot, help', mentioned: true }));
      await framework.runUntilIdle();
      assert.ok(framework.getAgent('conversation-slack-D1-g1'), 'DM fork spawned');
      assert.ok(framework.getAgent('conversation-slack-C1-g1'), 'channel-mention fork spawned');
      assert.equal(membrane.calls.length, 2, 'both forks ran inference');

      assert.equal(deprecationWarnings(warn).length, 1, 'spawning forks does not warn again');
    } finally {
      warn.mock.restore();
      await framework?.stop();
    }
  });

  it('not configured: no [deprecated] line', async () => {
    const warn = mock.method(console, 'warn', () => {});
    let framework: AgentFramework | undefined;
    try {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi alice!' }]));
      framework = await AgentFramework.create({
        storePath: join(tempDir, 'test.chronicle'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
        modules: [],
      });
      framework.pushEvent(incomingEvent({ channelId: 'slack:D1', text: 'hello there', channelType: 'im' }));
      await framework.runUntilIdle();

      assert.equal(framework.getConversationRouter(), null);
      assert.deepEqual(deprecationWarnings(warn), []);
    } finally {
      warn.mock.restore();
      await framework?.stop();
    }
  });

  it('DM message spawns a fork, routes the message there, and triggers inference', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi alice!' }]));
    const framework = await makeFramework();

    framework.pushEvent(incomingEvent({
      channelId: 'slack:D1', text: 'hello there', channelType: 'im',
    }));
    await framework.runUntilIdle();

    const fork = framework.getAgent('conversation-slack-D1-g1');
    assert.ok(fork, 'fork agent should exist');

    // Message landed in the fork's context, not the trunk's.
    const { messages: forkMessages } = await fork!.getContextManager().compile();
    assert.ok(
      forkMessages.some((m) => JSON.stringify(m.content).includes('hello there')),
      'fork context should contain the incoming message',
    );
    const trunk = framework.getAgent('trunk')!;
    const { messages: trunkMessages } = await trunk.getContextManager().compile();
    assert.ok(
      !trunkMessages.some((m) => JSON.stringify(m.content).includes('hello there')),
      'trunk context must not receive routed messages',
    );

    // Inference ran for the fork.
    assert.ok(membrane.calls.length >= 1, 'inference should have been triggered');

    // Binding is live.
    const router = framework.getConversationRouter()!;
    assert.equal(router.getBinding('slack:D1')?.agentName, 'conversation-slack-D1-g1');

    await framework.stop();
  });

  it('channel message without mention is dropped; mention spawns', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'On it.' }]));
    const framework = await makeFramework();

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'just chatting' }));
    await framework.runUntilIdle();
    assert.equal(framework.getAgent('conversation-slack-C1-g1'), null, 'no fork without mention');
    assert.equal(membrane.calls.length, 0, 'no inference for unrouted messages');

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent('conversation-slack-C1-g1'), 'mention spawns fork');

    await framework.stop();
  });

  it('non-mention on a bound channel lands in context without triggering', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ack' }]));
    const framework = await makeFramework();

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'first', mentioned: true }));
    await framework.runUntilIdle();
    const callsAfterSpawn = membrane.calls.length;

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'ambient detail' }));
    await framework.runUntilIdle();

    const fork = framework.getAgent('conversation-slack-C1-g1')!;
    const { messages } = await fork.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('ambient detail')),
      'ambient message should land in fork context',
    );
    assert.equal(membrane.calls.length, callsAfterSpawn, 'ambient message must not trigger inference');

    await framework.stop();
  });

  it('fork inherits the template context', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();

    // Seed the trunk (primary agent) with handbook-like content.
    framework.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK: always check the logs first.' },
    ]);

    framework.pushEvent(incomingEvent({ channelId: 'slack:D2', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();

    const fork = framework.getAgent('conversation-slack-D2-g1')!;
    const { messages } = await fork.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('HANDBOOK')),
      'fork should inherit trunk context',
    );

    await framework.stop();
  });

  // Exercise the delivery boundary without scheduling inference. The same
  // handler receives ordinary channel traffic and coalesced fixed-audience notices.
  async function deliver(framework: AgentFramework, channelId: string, text: string, deliverTo?: string) {
    const internals = framework as unknown as {
      handleMcplChannelIncoming(event: unknown): Promise<unknown>;
    };
    return internals.handleMcplChannelIncoming({
      ...incomingEvent({ channelId, text, mentioned: true }),
      triggerInference: false,
      ...(deliverTo ? { deliverTo } : {}),
    });
  }

  it('successful ambient delivery refreshes the bound fork idle clock', async () => {
    const framework = await makeFramework();
    try {
      await deliver(framework, 'slack:C1', 'first');
      const router = framework.getConversationRouter()!;
      const binding = router.getBinding('slack:C1')!;
      binding.lastActivity = 1;
      const before = Date.now();
      framework.pushEvent({
        ...incomingEvent({ channelId: 'slack:C1', text: 'ambient detail' }),
        triggerInference: false,
      } as ProcessEvent);
      await framework.runUntilIdle();

      assert.ok(binding.lastActivity >= before, 'successful delivery records activity');
      assert.equal(membrane.calls.length, 0, 'ambient delivery needs no inference');
      assert.deepEqual(router.expired(before), []);
    } finally {
      await framework.stop();
    }
  });

  it('failed delivery leaves the bound fork idle clock unchanged', async () => {
    const framework = await makeFramework();
    try {
      await deliver(framework, 'slack:C1', 'first');
      const router = framework.getConversationRouter()!;
      const binding = router.getBinding('slack:C1')!;
      binding.lastActivity = 1;
      const context = framework.getAgent(binding.agentName)!.getContextManager();
      const addMessage = context.addMessage;
      context.addMessage = () => { throw new Error('injected context write failure'); };
      try {
        await assert.rejects(deliver(framework, 'slack:C1', 'lost'), /injected context write failure/);
        assert.equal(binding.lastActivity, 1, 'a routing decision is not delivered activity');
      } finally {
        context.addMessage = addMessage;
      }
    } finally {
      await framework.stop();
    }
  });

  it('fixed-audience coalesced delivery refreshes the current fork idle clock', async () => {
    const framework = await makeFramework();
    try {
      await deliver(framework, 'slack:C1', 'first');
      const router = framework.getConversationRouter()!;
      const binding = router.getBinding('slack:C1')!;
      binding.lastActivity = 1;
      const before = Date.now();
      await deliver(framework, 'slack:C1', 'updated detail', binding.agentName);
      assert.ok(binding.lastActivity >= before, 'delivery bypassing fresh routing still records activity');
      const { messages } = await framework.getAgent(binding.agentName)!.getContextManager().compile();
      assert.ok(JSON.stringify(messages).includes('updated detail'));
    } finally {
      await framework.stop();
    }
  });

  it('delivery to an older fork does not refresh a newer binding on the same channel', async () => {
    const framework = await makeFramework();
    try {
      await deliver(framework, 'slack:C1', 'first');
      const router = framework.getConversationRouter()!;
      const oldName = router.getBinding('slack:C1')!.agentName;
      router.unbind('slack:C1');
      await deliver(framework, 'slack:C1', 'new engagement');
      const binding = router.getBinding('slack:C1')!;
      binding.lastActivity = 1;
      await deliver(framework, 'slack:C1', 'old engagement correction', oldName);

      assert.equal(binding.lastActivity, 1, 'the correction belongs to the old engagement');
      const { messages } = await framework.getAgent(oldName)!.getContextManager().compile();
      assert.ok(JSON.stringify(messages).includes('old engagement correction'));
    } finally {
      await framework.stop();
    }
  });

  it('idle TTL runs a closure turn, unbinds, disposes the fork, and the next message spawns g2', async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });

    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const router = framework.getConversationRouter()!;
    assert.ok(router.getBinding('slack:D3'), 'spawn should leave a live binding');
    const g1 = framework.getAgent('conversation-slack-D3-g1');
    assert.ok(g1, 'g1 fork should exist after spawn');

    // Force expiry deterministically and provide the closure-turn response.
    forceExpiry(framework, 'slack:D3', IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));

    // Nudge the loop so the sweep runs.
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(router.getBinding('slack:D3'), undefined, 'binding should be gone after TTL');
    const { messages } = await g1!.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('engagement is closing')),
      'closure prompt should be in the fork context',
    );
    assert.equal(
      framework.getAgent('conversation-slack-D3-g1'), null,
      'closed fork should be disposed once its closure turn finished',
    );

    // Next DM spawns a fresh generation.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi again' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'back again', channelType: 'im' }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent('conversation-slack-D3-g2'), 'rebind spawns generation 2');

    await framework.stop();
  });

  it('restart does not reuse generation names or re-seed an existing namespace', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const fw1 = await makeFramework({}, 'restart.chronicle');
    fw1.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK-V1: always check the logs first.' },
    ]);

    fw1.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'case one', channelType: 'im' }));
    await fw1.runUntilIdle();
    assert.ok(fw1.getAgent('conversation-slack-D9-g1'), 'first engagement spawns g1');
    await fw1.stop();

    // Restart: same store, fresh framework. The generation counter must come
    // back from Chronicle so the next engagement is g2 in a fresh namespace.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'fresh' }]));
    const fw2 = await makeFramework({}, 'restart.chronicle');
    fw2.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'case two', channelType: 'im' }));
    await fw2.runUntilIdle();

    assert.equal(fw2.getAgent('conversation-slack-D9-g1'), null, 'g1 must not be resurrected');
    const g2 = fw2.getAgent('conversation-slack-D9-g2');
    assert.ok(g2, 'restart spawns the next generation, not generation 1 again');

    const { messages } = await g2!.getContextManager().compile();
    const handbookCopies = messages.filter(
      (m) => JSON.stringify(m.content).includes('HANDBOOK-V1'),
    ).length;
    assert.equal(handbookCopies, 1, 'fresh namespace is seeded with exactly one template copy');
    assert.ok(
      !messages.some((m) => JSON.stringify(m.content).includes('case one')),
      'a new generation must not inherit the previous engagement history',
    );

    await fw2.stop();
  });

  it('forks cannot open channels or close foreign ones', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C7', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    const forkName = 'conversation-slack-C7-g1';
    assert.ok(framework.getAgent(forkName), 'fork should exist');

    const failures: Array<{ tool: string; error: string }> = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'tool:failed') {
        failures.push({ tool: (e as { tool: string }).tool, error: (e as { error: string }).error });
      }
    });

    const fw = framework as unknown as {
      dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: Record<string, unknown> }): void;
    };
    fw.dispatchChannelToolCall(forkName, { id: 't1', name: 'channel_open', input: { channelId: 'slack:C8' } });
    fw.dispatchChannelToolCall(forkName, { id: 't2', name: 'channel_close', input: { channelId: 'slack:C8' } });

    assert.equal(failures.length, 2, 'both foreign channel operations should be rejected');
    assert.ok(failures[0]!.error.includes('cannot open channels'), 'channel_open is rejected outright');
    assert.ok(failures[1]!.error.includes('closing slack:C8 is not allowed'), 'foreign channel_close is rejected');

    await framework.stop();
  });

  it('fork channel_publish: omitted channelId defaults to home; foreign publish is rejected', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C7', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    const forkName = 'conversation-slack-C7-g1';
    assert.ok(framework.getAgent(forkName), 'fork should exist');

    // tool:started is emitted AFTER the fence with the (possibly rewritten)
    // input, so home-defaulting is observable there; a fence rejection emits
    // tool:failed and never reaches tool:started.
    const started: Array<{ tool: string; input?: { channelId?: string } }> = [];
    const failures: Array<{ callId: string; error: string }> = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'tool:started') started.push(e as unknown as (typeof started)[number]);
      if (e.type === 'tool:failed') failures.push(e as unknown as (typeof failures)[number]);
    });

    const fw = framework as unknown as {
      dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: Record<string, unknown> }): void;
      channelRegistry: {
        handleChannelToolCall(name: string, input: unknown, origin?: unknown): Promise<{ success: boolean }>;
        stopAll(): void;
        getChannelServerId?(id: string): string | null;
      } | null;
    };

    // This harness runs no MCPL servers, so the framework never builds a real
    // ChannelRegistry (the public dispatch path guards on it before routing
    // channel_* tools). Stub the downstream boundary — the unit under test is
    // the fence ABOVE it, and a home-defaulted publish must get past the fence
    // to be observable at tool:started.
    fw.channelRegistry = {
      handleChannelToolCall: async () => ({ success: true }),
      stopAll: () => {},
      // The home's sole registrant (a fork's home is a bare channel id).
      getChannelServerId: (id: string) => (id === 'slack:C7' ? 'slack-a' : null),
    } as typeof fw.channelRegistry;

    // (a) omitted channelId → rewritten to the home channel, passes the fence
    fw.dispatchChannelToolCall(forkName, { id: 'p1', name: 'channel_publish', input: { content: 'hello home' } });
    const homePublish = started.find((t) => t.tool === 'channel_publish');
    assert.ok(homePublish, 'home-defaulted publish should pass the fence and reach tool:started');
    assert.equal(homePublish!.input?.channelId, 'slack:C7', 'omitted channelId is rewritten to the home channel');
    assert.ok(
      !failures.some((f) => f.callId === 'p1'),
      'home-defaulted publish must not be rejected by the fence',
    );

    // (b) foreign channelId → rejected by the fence, never starts
    fw.dispatchChannelToolCall(forkName, { id: 'p2', name: 'channel_publish', input: { channelId: 'slack:C8', content: 'sneaky' } });
    const rejection = failures.find((f) => f.callId === 'p2');
    assert.ok(rejection, 'foreign publish should be rejected');
    assert.ok(rejection!.error.includes('publishing to slack:C8 is not allowed'), 'rejection names the foreign channel');
    assert.equal(
      started.filter((t) => t.tool === 'channel_publish').length, 1,
      'foreign publish never reaches tool:started',
    );

    // (c) the home's id on another server → rejected: the same id there is
    // another conversation
    fw.dispatchChannelToolCall(forkName, { id: 'p3', name: 'channel_publish', input: { channelId: 'slack:C7', serverId: 'slack-b', content: 'elsewhere' } });
    const otherServer = failures.find((f) => f.callId === 'p3');
    assert.ok(otherServer, 'the home id named on another server is rejected');
    assert.ok(otherServer!.error.includes('on server slack-a; publishing to it on server slack-b is not allowed'), otherServer!.error);

    // (d) the home with its own server → passes the fence
    fw.dispatchChannelToolCall(forkName, { id: 'p4', name: 'channel_publish', input: { channelId: 'slack:C7', serverId: 'slack-a', content: 'here' } });
    assert.ok(!failures.some((f) => f.callId === 'p4'), "naming the home's own server passes");
    assert.equal(started.filter((t) => t.tool === 'channel_publish').length, 2);

    await framework.stop();
  });
});
