/**
 * Integration tests for per-channel conversation routing: incoming MCPL
 * channel messages spawn/route to fork agents instead of the primary
 * conversation when FrameworkConfig.conversations is set.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
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

  it('channel_publish with omitted channelId defaults to home channel and is not rejected', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C11', text: 'help', mentioned: true }));
    await framework.runUntilIdle();
    const forkName = 'conversation-slack-C11-g1';
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

    // Omitted channelId — the fence should inject home (slack:C11) and NOT reject.
    fw.dispatchChannelToolCall(forkName, { id: 't1', name: 'channel_publish', input: { content: 'hello from home' } });

    assert.equal(failures.length, 0, 'home-default channel_publish must not be rejected by the fence');

    await framework.stop();
  });

  it('channel_publish to a foreign channelId is rejected', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C12', text: 'help', mentioned: true }));
    await framework.runUntilIdle();
    const forkName = 'conversation-slack-C12-g1';
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

    // Foreign channelId — the fence must reject this publish.
    fw.dispatchChannelToolCall(forkName, { id: 't2', name: 'channel_publish', input: { channelId: 'slack:C99', content: 'hello foreign' } });

    assert.equal(failures.length, 1, 'foreign channel_publish should be rejected by the fence');
    assert.ok(failures[0]!.error.includes('slack:C99'), 'rejection error should reference the foreign channel');

    await framework.stop();
  });
});
