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
    deferredWritesPersisted: boolean;
    unackedDeferredWrites: unknown[];
    flushDeferredWrites(label: string): Promise<void>;
    injectScriptWake(record: { id: string; agentName: string }, envelope: string): void;
  };
}

const SEND_FAILED = '[discord-send-failed]';
const BOUNCED = 'was not delivered —';
const count = (messages: Array<{ content: unknown }>, needle: string) =>
  messages.filter((m) => JSON.stringify(m.content).includes(needle)).length;

describe('notices about an agent\'s own action', () => {
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

  /** A real conversation fork: an incoming DM binds one, and its reply fails (no such channel). */
  async function spawnFork(reply = 'Reply from the fork.') {
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
    return framework.getAgent(binding.agentName)!;
  }

  async function runEphemeral(proseRouting: 'locus' | 'explicit', speech: string) {
    const created = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: speech }]));
    const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    framework.start();
    await run;
    await framework.runUntilIdle();
    // The run is released; read what it left in Chronicle.
    const archive = await ContextManager.open({
      store: framework.getStore(), namespace: 'subagent/worker', isolate: true, strategy: new PassthroughStrategy(),
    });
    return (await archive.compile()).messages;
  }

  describe('residents share one message slot', () => {
    it('keeps a secondary resident\'s notice on the default path, where it reads it', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');
      const result = await internals(framework).channelRegistry.routeSpeech('secondary', 'hello', 'missing-channel');

      assert.equal(result, null);
      assert.equal(primary.mock.callCount(), 1, 'the default path writes the shared slot');
      assert.equal(secondary.mock.callCount(), 0);
      const [participant, content, metadata] = primary.mock.calls[0]!.arguments;
      assert.equal(participant, 'user');
      assert.match(JSON.stringify(content), /\[discord-send-failed\].*5 chars.*missing-channel/);
      assert.equal(metadata?.system, true);
      assert.equal(metadata?.kind, 'discord-send-failed');
      assert.equal(metadata?.channelId, 'missing-channel');
      assert.match(String(metadata?.reason), /no registered channel/);
      t.mock.restoreAll();
      const { messages } = await framework.getAgent('secondary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 1, 'the speaking resident reads the shared slot');
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

    it('waits for the primary\'s live turn before writing a secondary resident\'s notice', async () => {
      const state = internals(framework);
      state.activeTurnTokens.set('primary', 1);

      await state.channelRegistry.routeSpeech('secondary', 'hello', null);

      assert.equal(state.deferredMessages.length, 1, 'the shared slot is mid-turn for the primary');
      assert.equal(state.deferredMessages[0]!.forAgent, undefined);
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 0);
    });

    for (const [speaker, cycling] of [['secondary', 'primary'], ['primary', 'secondary']] as const) {
      it(`waits for ${cycling}'s tool cycle before writing ${speaker}'s notice`, async () => {
        const state = internals(framework);
        state.pendingAssistantBlocks.set(cycling, []);

        await state.channelRegistry.routeSpeech(speaker, 'hello', null);

        assert.equal(state.deferredMessages.length, 1, 'a write now would split a tool_use from its result');
        const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
        assert.equal(count(messages, SEND_FAILED), 0);
      });
    }
  });

  describe('a fork or an ephemeral run reads only its own window', () => {
    it('delivers a failed fork reply notice to the fork after its turn, without waking it again', async () => {
      const reply = 'Reply from the fork.';
      const fork = await spawnFork(reply);
      const { messages: forkMessages } = await fork.getContextManager().compile();
      const { messages: primaryMessages } = await framework.getAgent('primary')!.getContextManager().compile();
      const notices = forkMessages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
      assert.equal(notices.length, 1, 'the fork must see its own failure notice exactly once');
      assert.equal(count(primaryMessages, SEND_FAILED), 0);
      const replyIndex = forkMessages.findIndex((m) => m.participant === fork.name && JSON.stringify(m.content).includes(reply));
      assert.ok(replyIndex >= 0, 'the attempted reply is still archived');
      assert.ok(forkMessages.indexOf(notices[0]!) > replyIndex, 'failure notice follows the attempted reply');
      assert.equal(internals(framework).deferredMessages.length, 0, 'the completed turn flushes its notice');
      assert.equal(internals(framework).pendingRequests.length, 0);
      assert.equal(membrane.calls.length, 1, 'failure notice is context only, not another wake');
    });

    it('defers a fork\'s notice against the fork\'s own live turn', async (t) => {
      const fork = await spawnFork();
      const state = internals(framework);
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const forkCm = t.mock.method(fork.getContextManager(), 'addMessage');
      state.activeTurnTokens.set(fork.name, 99);

      await state.channelRegistry.routeSpeech(fork.name, 'hello', null);

      assert.equal(primary.mock.callCount(), 0);
      assert.equal(forkCm.mock.callCount(), 0, 'the notice waits for the fork\'s safe boundary');
      assert.equal(state.deferredMessages.length, 1);
      assert.equal(state.deferredMessages[0]!.forAgent, fork.name);
      assert.equal(state.deferredMessages[0]!.metadata?.kind, 'discord-send-failed');
      assert.equal(state.pendingRequests.length, 0);
    });

    it('tells the primary, by name, when the speaker ended before its delivery failed', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');

      await internals(framework).channelRegistry.routeSpeech('released-conversation', 'hello', 'missing-channel');

      assert.equal(secondary.mock.callCount(), 0);
      assert.equal(primary.mock.callCount(), 1);
      const [, content, metadata] = primary.mock.calls[0]!.arguments;
      assert.match(JSON.stringify(content),
        /\[discord-send-failed\] A reply by released-conversation \(5 chars\) could not be delivered to missing-channel \(no registered channel[^)]*\)\. released-conversation has ended, and the human did not receive it\./);
      assert.equal(metadata?.speaker, 'released-conversation');
      assert.equal(metadata?.textLen, 5);
      assert.equal(internals(framework).pendingRequests.length, 0, 'context only: the primary is not woken');
    });

    it('tells no one, logged, when an ended speaker\'s reply had no channel to reach', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      await internals(framework).channelRegistry.routeSpeech('released-conversation', 'hello', null);

      assert.equal(primary.mock.callCount(), 0);
      assert.equal(internals(framework).deferredMessages.length, 0);
      assert.ok(errors.some((e) => e.includes('[route-failure] released-conversation has ended, and its reply had no channel to reach')));
    });

    it('lands an ephemeral run\'s last failure notice in its own window before releasing it', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const speech = 'Worker speech with no channel to go to.';

      const archived = await runEphemeral('locus', speech);

      const replyIndex = archived.findIndex((m) => m.participant === 'worker' && JSON.stringify(m.content).includes(speech));
      const noticeIndex = archived.findIndex((m) => JSON.stringify(m.content).includes(SEND_FAILED));
      assert.ok(replyIndex >= 0, 'the run\'s reply is archived');
      assert.ok(noticeIndex > replyIndex, 'its failure notice follows the reply in its own window');
      assert.equal(count(archived, SEND_FAILED), 1);
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 0, 'the primary did not write that reply');
      assert.ok(!errors.some((e) => /not a registered agent/.test(e)));
      assert.ok(errors.some((e) => e.includes('[route-failure] worker has ended, and its reply had no channel to reach')));
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('passes an ephemeral run\'s failed delivery to a channel on to the primary, by name', async () => {
      (internals(framework).channelRegistry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = 'missing-channel';
      const speech = 'Worker speech for a channel that is not registered.';

      const archived = await runEphemeral('locus', speech);

      assert.equal(count(archived, '[discord-send-failed] Your previous reply'), 1, 'the run keeps its own record');
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      const named = messages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
      assert.equal(named.length, 1);
      assert.match(JSON.stringify(named[0]!.content), /A reply by worker \(\d+ chars\) could not be delivered to missing-channel .*worker has ended/);
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('still releases an ephemeral run when the primary cannot be told, logged', async (t) => {
      (internals(framework).channelRegistry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = 'missing-channel';
      const primaryCm = framework.getAgent('primary')!.getContextManager();
      const store = primaryCm.addMessage.bind(primaryCm);
      t.mock.method(primaryCm, 'addMessage', (...args: Parameters<typeof primaryCm.addMessage>) => {
        if (JSON.stringify(args[1]).includes('A reply by worker')) throw new Error('store refused the write');
        return store(...args);
      });
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      const archived = await runEphemeral('locus', 'Worker speech for a channel that is not registered.');

      assert.equal(framework.getAgent('worker'), null, 'the run is released');
      assert.equal(count(archived, '[discord-send-failed] Your previous reply'), 1);
      assert.ok(errors.some((e) => e.includes('[route-failure] failed to tell the primary that worker\'s reply to missing-channel failed')));
    });

    it('tells no one, logged, when there is no primary to tell', async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'route-failure-no-primary-'));
      const bare = await AgentFramework.create({
        storePath: join(dir, 'test.chronicle'), membrane: membrane.asMembrane(), agents: [], modules: [],
      });
      try {
        await internals(bare).initializeMcpl([]);
        (internals(bare).channelRegistry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = 'missing-channel';
        const errors: string[] = [];
        t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
        const created = await bare.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'locus',
        });
        created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Worker speech with nobody to tell.' }]));
        const run = bare.runEphemeralToCompletion(created.agent, created.contextManager);
        bare.start();
        await run;
        await bare.runUntilIdle();

        const archive = await ContextManager.open({
          store: bare.getStore(), namespace: 'subagent/worker', isolate: true, strategy: new PassthroughStrategy(),
        });
        const { messages } = await archive.compile();
        assert.equal(count(messages, 'A reply by worker'), 0, 'the run is not told about itself');
        assert.equal(count(messages, '[discord-send-failed] Your previous reply'), 1);
        assert.ok(errors.some((e) => e.includes('[route-failure] worker has ended, and there is no primary to tell that its reply to missing-channel failed')));
      } finally {
        await bare.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('sends an ephemeral run\'s bounced prose notice to its own window, beside its clipboard', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      const archived = await runEphemeral('explicit', 'Worker prose with no destination.');

      assert.equal(count(archived, BOUNCED), 1, 'the speaker reads why its text did not go out');
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, BOUNCED), 0, 'the primary wrote no such text, and is not told of it');
      assert.ok(!errors.some((e) => e.includes('[route-failure]')), 'a bounce is not a failed reply');
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('drops, logged, a background-script wake for an agent no longer registered', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      internals(framework).injectScriptWake({ id: 's-2', agentName: 'released-run' }, '[background script s-2] Your background script DIED.');

      assert.equal(primary.mock.callCount(), 0, 'the primary started no such script');
      assert.ok(errors.some((e) => /"released-run" is not a registered agent — message dropped/.test(e)));
    });

    it('wakes a fork\'s background script into the fork\'s own window', async () => {
      const fork = await spawnFork();
      const envelope = '[background script s-1] Your background script DIED 0m after start.';

      internals(framework).injectScriptWake({ id: 's-1', agentName: fork.name }, envelope);

      const { messages: forkMessages } = await fork.getContextManager().compile();
      const { messages: primaryMessages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(forkMessages, envelope), 1);
      assert.equal(count(primaryMessages, envelope), 0);
    });

    for (const condition of ['ordinary', 'other-tool-cycle', 'quiesced', 'write-fails'] as const) {
      it('handles a failed TTL-closure reply notice at disposal: ' + condition, async (t) => {
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
        // A host with a recovery queue: what lands at release is acked out of it.
        if (condition === 'ordinary') state.deferredWritesPersisted = true;
        if (condition === 'write-fails') {
          const cm = fork.getContextManager();
          const store = cm.addMessage.bind(cm);
          t.mock.method(cm, 'addMessage', (...args: Parameters<typeof cm.addMessage>) => {
            if (JSON.stringify(args[1]).includes(SEND_FAILED)) throw new Error('store refused the write');
            return store(...args);
          });
        }
        const errors: string[] = [];
        t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
        binding.lastActivity = 0;
        state.lastConversationSweep = 0;
        state.sweepExpiredConversations();
        await framework.runUntilIdle();
        state.pendingAssistantBlocks.clear();

        assert.equal(framework.getAgent(fork.name), null, 'the fork is disposed when its closure turn ends');
        if (condition === 'quiesced') {
          // A write while quiesced could land mid-surgery: the archive write
          // is dropped, logged, and the primary's notice waits for resume.
          assert.ok(errors.some((e) => e.includes(`[deferred-flush] ${fork.name}: released while quiesced, so a queued write for its window is dropped`)));
          assert.equal(state.deferredMessages.length, 1);
          state.quiesced = false;
          await state.flushDeferredWrites('closure test resume');
        }
        if (condition === 'other-tool-cycle') {
          // The primary's notice waits for the shared slot's tool cycle.
          assert.equal(state.deferredMessages.length, 1);
          await state.flushDeferredWrites('the primary\'s next boundary');
        }
        assert.equal(state.deferredMessages.length, 0, 'nothing is left queued');
        assert.equal(state.unackedDeferredWrites.length, 0, 'nor waiting in the recovery queue');
        // Open a fresh manager over the retained fork namespace, rather than
        // relying only on the disposed Agent's in-memory context manager.
        const archive = await ContextManager.open({
          store: framework.getStore(), namespace: 'conversations/' + fork.name,
          isolate: true, strategy: new PassthroughStrategy(),
        });
        const { messages } = await archive.compile();
        const replyIndex = messages.findIndex((m) => m.participant === fork.name && JSON.stringify(m.content).includes(finalReply));
        assert.ok(replyIndex >= 0, 'the failed closure reply remains archived');
        if (condition === 'quiesced') {
          assert.equal(count(messages, SEND_FAILED), 0);
        } else if (condition === 'write-fails') {
          // A write the store refuses is logged; disposal still completes.
          assert.equal(count(messages, SEND_FAILED), 0);
          assert.ok(errors.some((e) => e.includes(`[deferred-flush] ${fork.name}: failed to store a queued write before release`)));
        } else {
          const noticeIndex = messages.findIndex((m) => JSON.stringify(m.content).includes(SEND_FAILED));
          assert.ok(noticeIndex > replyIndex, 'the archived failure notice follows the closure reply');
          assert.equal(count(messages, SEND_FAILED), 1);
          assert.match(JSON.stringify(messages[noticeIndex]!.content), /Your previous reply.*delivered:false/);
          // Every write of a drained entry carries its durable id (drainDeferredFor).
          const stored = archive.getAllMessages().find((m) => JSON.stringify(m.content).includes(SEND_FAILED));
          assert.equal(typeof (stored?.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId, 'string');
        }
        // The fork never reads its notice again, so the primary is told, by name.
        const primary = await framework.getAgent('primary')!.getContextManager().compile();
        const told = primary.messages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
        assert.equal(told.length, 1);
        assert.match(JSON.stringify(told[0]!.content),
          new RegExp(`A reply by ${fork.name} \\(${finalReply.length} chars\\) could not be delivered to #closure test \\(closure-channel\\) \\(.*delivered:false.*\\)\\. ${fork.name} has ended, and the human did not receive it\\.`));
        assert.equal(membrane.calls.length, 2, 'only the initial and closure turns ran');
        assert.equal(state.pendingRequests.length, 0, 'a failed closure reply does not wake another turn');
      });
    }
  });
});
