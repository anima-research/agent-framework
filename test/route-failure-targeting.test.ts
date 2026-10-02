import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
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
    pendingAssistantBlocks: Map<string, unknown[]>;
    mcplServerRegistry: McplServerRegistry;
    lastConversationSweep: number;
    sweepExpiredConversations(): void;
    quiesced: boolean;
    flushDeferredWrites(label: string): Promise<void>;
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
    internals(framework).pendingAssistantBlocks.clear();
    internals(framework).quiesced = false;
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

  for (const condition of ['ordinary', 'other-tool-cycle', 'quiesced'] as const) {
    it('retains a failed TTL-closure reply notice before disposal: ' + condition, async (t) => {
      const state = internals(framework);
      const channelId = 'closure-channel';
      let failPublishing = false;
      const publisher = {
        grant: new CapabilityGrant(new Set(['channels.publish']), []),
        sendChannelsTyping() {},
        async sendChannelsPublish() {
          if (failPublishing && condition === 'quiesced') state.quiesced = true;
          return { delivered: !failPublishing };
        },
      };
      t.mock.method(state.mcplServerRegistry, 'getServer', () => publisher as never);
      (state.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set('srv:' + channelId, {
        serverId: 'srv', descriptor: { id: channelId, type: 'srv', label: 'closure test' }, open: true,
      });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Initial reply.' }]));
      framework.pushEvent({
        type: 'mcpl:channel-incoming', serverId: 'srv', channelId, messageId: 'closure-incoming',
        author: { id: 'user', name: 'User' },
        content: [{ type: 'text', text: 'Please help.' }],
        timestamp: new Date().toISOString(),
        metadata: { mentioned: true },
        triggerInference: true,
      } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      const binding = framework.getConversationRouter()!.getBinding(channelId)!;
      assert.ok(binding);
      const fork = framework.getAgent(binding.agentName)!;

      failPublishing = true;
      const finalReply = 'Final reply that the server cannot deliver.';
      membrane.pushResponse(createMockResponse([{ type: 'text', text: finalReply }]));
      if (condition === 'other-tool-cycle') state.pendingAssistantBlocks.set('secondary', []);
      binding.lastActivity = 0;
      state.lastConversationSweep = 0;
      state.sweepExpiredConversations();
      await framework.runUntilIdle();
      state.pendingAssistantBlocks.clear();

      if (condition === 'quiesced') {
        assert.ok(framework.getAgent(fork.name) === fork, 'a deferred write keeps its owner registered while quiesced');
        assert.equal(state.deferredMessages.length, 1);
        state.lastConversationSweep = 0;
        state.sweepExpiredConversations();
        assert.ok(framework.getAgent(fork.name) === fork, 'the fallback reaper must also retain the pending write target');
        state.quiesced = false;
        await state.flushDeferredWrites('closure test resume');
        state.lastConversationSweep = 0;
        state.sweepExpiredConversations();
      }

      assert.equal(framework.getAgent(fork.name), null, 'the settled fork is eventually disposed');
      assert.equal(state.deferredMessages.length, 0);
      // Open a fresh manager over the retained fork namespace, rather than
      // relying only on the disposed Agent's in-memory context manager.
      const archive = await ContextManager.open({
        store: framework.getStore(), namespace: 'conversations/' + fork.name,
        isolate: true, strategy: new PassthroughStrategy(),
      });
      const { messages } = await archive.compile();
      const noticeIndex = messages.findIndex((m) => JSON.stringify(m.content).includes('[discord-send-failed]'));
      const replyIndex = messages.findIndex((m) => m.participant === fork.name && JSON.stringify(m.content).includes(finalReply));
      assert.ok(replyIndex >= 0, 'the failed closure reply remains archived');
      assert.ok(noticeIndex > replyIndex, 'the archived failure notice follows the closure reply');
      assert.equal(messages.filter((m) => JSON.stringify(m.content).includes('[discord-send-failed]')).length, 1);
      assert.match(JSON.stringify(messages[noticeIndex]!.content), /delivered:false/);
      const primary = await framework.getAgent('primary')!.getContextManager().compile();
      assert.ok(!primary.messages.some((m) => JSON.stringify(m.content).includes('[discord-send-failed]')));
      assert.equal(membrane.calls.length, 2, 'only the initial and closure turns ran');
      assert.equal(state.pendingRequests.length, 0, 'a failed closure reply does not wake another turn');
    });
  }

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
