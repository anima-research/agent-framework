import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function internals(framework: AgentFramework) {
  return framework as unknown as {
    initializeMcpl(servers: []): Promise<void>;
    channelRegistry: ChannelRegistry;
    activeTurnTokens: Map<string, number>;
    deferredMessages: Array<{ forAgent?: string; metadata?: Record<string, unknown> }>;
    pendingRequests: unknown[];
  };
}

describe('speech route failure notice targeting', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'route-failure-targeting-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' },
        { name: 'secondary', model: 'test-model', systemPrompt: 'Secondary.' },
      ],
      modules: [],
      conversations: { templateAgent: 'primary' },
    });
    // Install the real framework callback and registry without a live connector.
    await internals(framework).initializeMcpl([]);
  });

  afterEach(async () => {
    internals(framework).activeTurnTokens.clear();
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records a secondary agent failure through that agent\'s context manager', async (t) => {
    // Ordinary residents share a Chronicle message slot. Check the receiving
    // manager here; the real conversation fork below checks window isolation.
    const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
    const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');
    const result = await internals(framework).channelRegistry.routeSpeech('secondary', 'hello', 'missing-channel');

    assert.equal(result, null);
    assert.equal(primary.mock.callCount(), 0);
    assert.equal(secondary.mock.callCount(), 1);
    const [participant, content, metadata] = secondary.mock.calls[0]!.arguments;
    assert.equal(participant, 'user');
    assert.match(JSON.stringify(content), /\[discord-send-failed\].*5 chars.*missing-channel/);
    assert.equal(metadata?.system, true);
    assert.equal(metadata?.kind, 'discord-send-failed');
    assert.equal(metadata?.channelId, 'missing-channel');
    assert.match(String(metadata?.reason), /no registered channel/);
    assert.equal(internals(framework).pendingRequests.length, 0, 'a failure notice must not request inference');
    assert.equal(membrane.calls.length, 0);
  });

  it('keeps primary failures in the primary context manager', async (t) => {
    const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
    const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');

    await internals(framework).channelRegistry.routeSpeech('primary', 'hello', null);

    assert.equal(primary.mock.callCount(), 1);
    assert.equal(secondary.mock.callCount(), 0);
    assert.equal(primary.mock.calls[0]!.arguments[2]?.kind, 'discord-send-failed');
    assert.equal(internals(framework).pendingRequests.length, 0);
  });

  it('falls back to the primary for an unregistered conversation', async (t) => {
    const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
    const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');

    await internals(framework).channelRegistry.routeSpeech('unknown-conversation', 'hello', null);

    assert.equal(primary.mock.callCount(), 1);
    assert.equal(secondary.mock.callCount(), 0);
    assert.equal(primary.mock.calls[0]!.arguments[2]?.kind, 'discord-send-failed');
    assert.equal(internals(framework).pendingRequests.length, 0);
  });

  it('defers a failure notice against the speaking agent\'s live turn', async (t) => {
    const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
    const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');
    const state = internals(framework);
    state.activeTurnTokens.set('secondary', 1);

    await state.channelRegistry.routeSpeech('secondary', 'hello', null);

    assert.equal(primary.mock.callCount(), 0);
    assert.equal(secondary.mock.callCount(), 0, 'the notice waits for the owner\'s safe boundary');
    assert.equal(state.deferredMessages.length, 1);
    assert.equal(state.deferredMessages[0]!.forAgent, 'secondary');
    assert.equal(state.deferredMessages[0]!.metadata?.kind, 'discord-send-failed');
    assert.equal(state.pendingRequests.length, 0);
  });

  it('delivers a failed fork reply notice to the fork after its turn, without waking it again', async () => {
    const reply = 'Reply from the fork.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: reply }]));
    framework.pushEvent({
      type: 'mcpl:channel-incoming',
      serverId: 'srv',
      channelId: 'missing-channel',
      messageId: 'incoming-1',
      author: { id: 'user-1', name: 'User' },
      content: [{ type: 'text', text: 'Hello fork.' }],
      timestamp: new Date().toISOString(),
      metadata: { channel_type: 'im' },
      triggerInference: true,
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    const binding = framework.getConversationRouter()!.getBinding('missing-channel');
    assert.ok(binding, 'the incoming DM must spawn a real conversation fork');
    const fork = framework.getAgent(binding.agentName)!;
    const { messages: forkMessages } = await fork.getContextManager().compile();
    const { messages: primaryMessages } = await framework.getAgent('primary')!.getContextManager().compile();
    const notices = forkMessages.filter((m) => JSON.stringify(m.content).includes('[discord-send-failed]'));
    assert.equal(notices.length, 1, 'the fork must see its own failure notice exactly once');
    assert.ok(!primaryMessages.some((m) => JSON.stringify(m.content).includes('[discord-send-failed]')));
    const replyIndex = forkMessages.findIndex((m) => m.participant === binding.agentName && JSON.stringify(m.content).includes(reply));
    assert.ok(replyIndex >= 0, 'the attempted reply is still archived');
    assert.ok(forkMessages.indexOf(notices[0]!) > replyIndex, 'failure notice follows the attempted reply');
    assert.equal(internals(framework).deferredMessages.length, 0, 'the completed turn flushes its notice');
    assert.equal(internals(framework).pendingRequests.length, 0);
    assert.equal(membrane.calls.length, 1, 'failure notice is context only, not another wake');
  });
});
