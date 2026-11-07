import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, ShutdownTimeoutError } from '../src/index.js';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { TOOL_RESULT_GUARD_AUDIT_STATE } from '../src/tool-result-guard.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { ProcessEvent, Module, ModuleContext, ToolDefinition, ToolCall, ToolResult, EventResponse } from '../src/index.js';
import type { ContentBlock, NormalizedResponse } from '@animalabs/membrane';
import { destinationKey, type ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { HeldStream, MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { UNREACHED_WATCHDOG, silenceRun } from './helpers/run-watchdog.js';

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
    landedDeferredWriteIds(ids: Set<string>, scanFrom: Map<string, number>): Set<string>;
    scriptWake(agentName: string, scriptId: string, text: string, label: string): Promise<void>;
    closingConversationAgents: Set<string>;
    activeStreams: Map<string, Promise<void>>;
    recordChannelAutoOpenNotice(agentName: string | undefined, serverId: string, channels: Array<{ channelId: string; label?: string }>, cause: 'subscription-policy' | 'opened-by-delivery' | 'opened-by-reply'): void;
    addMessage(participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, opts?: { forAgent?: string }): string;
  };
}

/** A HeldStream that says when the framework has taken its events: which it
 *  yielded, and when it was left, by a consumer's break or at its end. */
class WatchedHeldStream extends HeldStream {
  readonly yielded: string[] = [];
  private finish!: () => void;
  readonly finished = new Promise<void>((resolve) => { this.finish = resolve; });
  override async *[Symbol.asyncIterator](): ReturnType<HeldStream[typeof Symbol.asyncIterator]> {
    try {
      for await (const event of super[Symbol.asyncIterator]()) {
        this.yielded.push(event.type);
        yield event;
      }
    } finally {
      this.finish();
    }
  }
}

/** A tool whose call makes `speaker`'s reply fail to reach a channel while its
 *  turn is alive, and a tool that does nothing; either can quiesce the host
 *  from inside the turn. */
class SenderModule implements Module {
  readonly name = 'sender';
  framework: AgentFramework | null = null;
  speaker = 'worker';
  quiesceOnCall = false;
  endTurnOnPost = false;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'post', description: 'Post a reply', inputSchema: { type: 'object', properties: {} } },
      { name: 'noop', description: 'Do nothing', inputSchema: { type: 'object', properties: {} } },
    ];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name.endsWith('post')) {
      await internals(this.framework!).channelRegistry.routeSpeech(this.speaker, 'mid-turn reply', { serverId: 'srv', channelId: 'missing-channel' });
    }
    if (this.quiesceOnCall) internals(this.framework!).quiesced = true;
    if (this.endTurnOnPost && call.name.endsWith('post')) return { success: true, data: { ok: true }, endTurn: true };
    return { success: true, data: { ok: true } };
  }
  async onProcess(): Promise<EventResponse> { return {}; }
}

const SEND_FAILED = '[discord-send-failed]';
// What a turn with no locus is told instead.
const UNDELIVERABLE = '[send-undeliverable]';
const BOUNCED = 'was not delivered —';
const count = (messages: Array<{ content: unknown }>, needle: string) =>
  messages.filter((m) => JSON.stringify(m.content).includes(needle)).length;

describe('notices about an agent\'s own action', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;

  /** The host, on the test's store: a restart makes it again over the same store. */
  async function host() {
    const created = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' },
        { name: 'secondary', model: 'test-model', systemPrompt: 'Secondary.' },
      ],
      modules: [],
      conversations: { templateAgent: 'primary' },
      // These rows route an ephemeral run's reply by the registry's default
      // locus (its latest accepted inbound), which only the legacy rule has.
      speech: { locus: 'latest-inbound' },
    });
    // Install the real framework callback and registry without a live connector.
    await internals(created).initializeMcpl([]);
    return created;
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'route-failure-targeting-'));
    membrane = new MockMembrane();
    framework = await host();
  });

  afterEach(async () => {
    internals(framework).activeTurnTokens.clear();
    internals(framework).pendingAssistantBlocks.clear();
    internals(framework).quiesced = false;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** An incoming DM on `channel`, which no channel the registry knows. */
  function dm(messageId: string, text: string, channel = 'missing-channel', server = 'srv'): ProcessEvent {
    return {
      type: 'mcpl:channel-incoming',
      serverId: server,
      channelId: channel,
      messageId,
      author: { id: 'user-1', name: 'User' },
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
      metadata: { channel_type: 'im' },
      triggerInference: true,
    } as unknown as ProcessEvent;
  }

  /** A real conversation fork: an incoming DM binds one, and its reply fails (no such channel). */
  async function spawnFork(reply = 'Reply from the fork.', channel = 'missing-channel', server = 'srv') {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: reply }]));
    framework.pushEvent(dm(channel === 'missing-channel' ? 'incoming-1' : `incoming-${channel}`, 'Hello fork.', channel, server));
    await framework.runUntilIdle();
    const binding = framework.getConversationRouter()!.getBinding({ serverId: server, channelId: channel });
    assert.ok(binding, 'the incoming DM must spawn a real conversation fork');
    return framework.getAgent(binding.agentName)!;
  }

  /** A durable decision for `channel` on `server`, as an open or a close
   *  records it in the registry's lifecycle log. */
  function decide(channel: string, desired: 'open' | 'closed', source = 'opened-by-reply', on = framework, server = 'srv') {
    (internals(on).channelRegistry as unknown as { setDesiredState(serverId: string, channelId: string, desired: string, source: string): void })
      .setDesiredState(server, channel, desired, source);
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
    it('addresses a secondary resident\'s notice to it, in the slot every resident reads', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const secondary = t.mock.method(framework.getAgent('secondary')!.getContextManager(), 'addMessage');
      const result = await internals(framework).channelRegistry.routeSpeech('secondary', 'hello', { serverId: 'srv', channelId: 'missing-channel' });

      assert.equal(result, null);
      assert.equal(primary.mock.callCount(), 0);
      assert.equal(secondary.mock.callCount(), 1, 'written through the speaker\'s own window');
      const [participant, content, metadata] = secondary.mock.calls[0]!.arguments;
      assert.equal(participant, 'user');
      assert.match(JSON.stringify(content), /\[discord-send-failed\] Your previous reply \(5 chars\) could not be delivered to missing-channel/);
      assert.equal(metadata?.system, true);
      assert.equal(metadata?.kind, 'discord-send-failed');
      assert.equal(metadata?.channelId, 'missing-channel');
      // The turn's locus names its server, so the reason does too.
      assert.equal(metadata?.reason, 'the "srv" server has no channel "missing-channel" registered here');
      assert.equal(metadata?.textLen, 5);
      t.mock.restoreAll();
      const { messages } = await framework.getAgent('secondary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 1, 'the speaking resident reads it');
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
      assert.match(JSON.stringify(primary.mock.calls[0]!.arguments[1]), /\[send-undeliverable\] Your previous reply \(5 chars\) had no channel to go to/);
      assert.match(JSON.stringify(primary.mock.calls[0]!.arguments[1]), /This is a routing\/configuration situation/,
        'a turn with no channel at all may be a misconfiguration');
      assert.equal(internals(framework).pendingRequests.length, 0);
    });

    it('waits for the speaking resident\'s own live turn', async () => {
      const state = internals(framework);
      state.activeTurnTokens.set('secondary', 1);

      await state.channelRegistry.routeSpeech('secondary', 'hello', null);

      assert.equal(state.deferredMessages.length, 1, 'the speaker is mid-turn');
      assert.equal(state.deferredMessages[0]!.forAgent, 'secondary');
      const { messages } = await framework.getAgent('secondary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 0);
    });

    for (const speaker of ['secondary', 'primary'] as const) {
      it(`waits for ${speaker}'s own tool cycle before writing its notice`, async () => {
        const state = internals(framework);
        state.pendingAssistantBlocks.set(speaker, []);

        await state.channelRegistry.routeSpeech(speaker, 'hello', null);

        assert.equal(state.deferredMessages.length, 1, 'a write now would split its tool_use from its result');
        assert.equal(state.deferredMessages[0]!.forAgent, speaker);
        const { messages } = await framework.getAgent(speaker)!.getContextManager().compile();
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

      await internals(framework).channelRegistry.routeSpeech('released-conversation', 'hello', { serverId: 'srv', channelId: 'missing-channel' });

      assert.equal(secondary.mock.callCount(), 0);
      assert.equal(primary.mock.callCount(), 1);
      const [, content, metadata] = primary.mock.calls[0]!.arguments;
      assert.match(JSON.stringify(content),
        /\[discord-send-failed\] A reply by released-conversation \(5 chars\) could not be delivered to missing-channel \(the \\"srv\\" server has no channel \\"missing-channel\\" registered here\)\. Nothing was posted\. released-conversation has ended\./);
      assert.equal(metadata?.speaker, 'released-conversation');
      assert.equal(metadata?.textLen, 5);
      assert.equal(internals(framework).pendingRequests.length, 0, 'context only: the primary is not woken');
    });

    it('tells the primary, by name, in the speaker\'s notice\'s words when an ended speaker\'s delivery was not confirmed', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const registry = internals(framework).channelRegistry as unknown as {
        onRouteFailure(info: { conversationId: string; channelId: string | null; reason: string; textLen: number; outcome?: 'failed' | 'unknown'; detail?: string }): void;
      };

      registry.onRouteFailure({
        conversationId: 'released-conversation', channelId: 'missing-channel', reason: 'connection lost', textLen: 5,
        outcome: 'unknown', detail: 'status 503',
      });

      assert.equal(primary.mock.callCount(), 1);
      const [, content, metadata] = primary.mock.calls[0]!.arguments;
      assert.equal((content as Array<{ text: string }>)[0]!.text,
        '[discord-send-failed] Delivery of a reply by released-conversation (5 chars) to missing-channel was not confirmed (connection lost). ' +
        'It may or may not have been posted, so sending it again could post it twice. released-conversation has ended. Connector detail: status 503');
      assert.equal(metadata?.speaker, 'released-conversation');
      assert.equal(metadata?.outcome, 'unknown');
      assert.equal(metadata?.detail, 'status 503');
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

    it('treats an ephemeral run\'s final reply with no channel of its own as its caller\'s result: no failure, logged or told', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const speech = 'Worker speech with no channel to go to.';

      const archived = await runEphemeral('locus', speech);

      // The run's prose is its caller's result (#551): with no channel of its
      // own it is undelivered, not a failed delivery, before or after its
      // release, so nothing is written, logged or passed on.
      assert.ok(archived.some((m) => m.participant === 'worker' && JSON.stringify(m.content).includes(speech)), 'the run\'s reply is archived');
      assert.equal(count(archived, UNDELIVERABLE), 0, 'no no-locus notice in its own window');
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, 'Your previous reply'), 0, 'the primary did not write that reply');
      assert.equal(count(messages, 'A reply by worker'), 0);
      assert.ok(!errors.some((e) => /not a registered agent/.test(e)));
      assert.ok(!errors.some((e) => e.includes('[route-failure] worker')), 'no route failure is logged');
      assert.ok(!errors.some((e) => e.includes('[routeSpeech] worker')), 'no "NOT routed" line');
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('never sends an ephemeral run\'s reply to the default channel, so nothing fails there', async (t) => {
      (internals(framework).channelRegistry as unknown as { defaultPublishChannel: string | null }).defaultPublishChannel = 'missing-channel';
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      await runEphemeral('locus', 'Worker speech that the default channel never gets.');

      // The latest inbound channel is nobody's choice for a subagent (#551).
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 0, 'the primary is told of no failure');
      assert.ok(!errors.some((e) => e.includes('missing-channel')), 'no delivery to the default channel was attempted');
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('passes an ended ephemeral run\'s failed delivery to a channel it was given on to the primary, by name', async () => {
      await runEphemeral('locus', 'Worker speech.');
      // After the run's release, its speech is routed to a channel given
      // directly, as a channel the run opened or named would be; the channel
      // isn't registered, so the delivery fails.
      await internals(framework).channelRegistry.routeSpeech('worker', 'Worker speech for a channel that is not registered.', { serverId: 'srv', channelId: 'missing-channel' });

      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      const named = messages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
      assert.equal(named.length, 1);
      assert.match(JSON.stringify(named[0]!.content), /A reply by worker \(\d+ chars\) could not be delivered to missing-channel .*worker has ended/);
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('logs it when the primary cannot be told of an ended ephemeral run\'s failed delivery', async (t) => {
      const primaryCm = framework.getAgent('primary')!.getContextManager();
      const store = primaryCm.addMessage.bind(primaryCm);
      t.mock.method(primaryCm, 'addMessage', (...args: Parameters<typeof primaryCm.addMessage>) => {
        if (JSON.stringify(args[1]).includes('A reply by worker')) throw new Error('store refused the write');
        return store(...args);
      });
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      await runEphemeral('locus', 'Worker speech.');
      assert.equal(framework.getAgent('worker'), null, 'the run is released');
      await internals(framework).channelRegistry.routeSpeech('worker', 'Worker speech for a channel that is not registered.', { serverId: 'srv', channelId: 'missing-channel' });

      assert.ok(errors.some((e) => e.includes('[route-failure] failed to tell the primary that worker\'s reply to missing-channel failed')));
    });

    it('tells no one, logged, when there is no primary to tell', async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'route-failure-no-primary-'));
      const bare = await AgentFramework.create({
        storePath: join(dir, 'test.chronicle'), membrane: membrane.asMembrane(), agents: [], modules: [], speech: { locus: 'latest-inbound' },
      });
      try {
        await internals(bare).initializeMcpl([]);
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
        // After the run's release, its speech is routed to a channel given
        // directly, as a channel of its own would be, and the delivery fails.
        await internals(bare).channelRegistry.routeSpeech('worker', 'Worker speech with nobody to tell.', { serverId: 'srv', channelId: 'missing-channel' });

        const archive = await ContextManager.open({
          store: bare.getStore(), namespace: 'subagent/worker', isolate: true, strategy: new PassthroughStrategy(),
        });
        const { messages } = await archive.compile();
        assert.equal(count(messages, 'A reply by worker'), 0, 'the run is not told about itself');
        assert.ok(errors.some((e) => e.includes('[route-failure] worker has ended, and there is no primary to tell that its reply to missing-channel failed')));
      } finally {
        await bare.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps an ephemeral run\'s bounced prose notice to its own window, or drops it, logged, once the run is released', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      const archived = await runEphemeral('explicit', 'Worker prose with no destination.');

      // The run settles before its final prose is routed, so the bounce can
      // come before or after its release: its notice lands in its own window,
      // or, once it's gone, is dropped, logged, and passed to no one.
      const dropped = errors.some((e) => e.includes('[notice] worker is no longer registered, so its prose-bounce notice is dropped'));
      assert.equal(count(archived, BOUNCED) + (dropped ? 1 : 0), 1, 'the notice lands in its own window or is dropped, once');
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, BOUNCED), 0, 'the primary wrote no such text, and is not told of it');
      assert.ok(!errors.some((e) => e.includes('[route-failure]')), 'a bounce is not a failed reply');
      assert.equal(internals(framework).deferredMessages.length, 0);
    });

    it('drops, logged once, a draft notice for an agent no longer registered: its drafts are held, with no write or trace', async (t) => {
      const state = internals(framework) as unknown as ReturnType<typeof internals> & {
        agents: Map<string, unknown>;
        routingOf(name: string): unknown;
        holdProseDrafts(agent: unknown, texts: Array<{ text: string }>, reason: string, options: unknown): Array<{ id: string }>;
        bounceProse(agent: unknown, text: string, reason: string, candidates: undefined, prefix: '>>', round: unknown, after?: { outcome?: 'unknown' }): void;
        takeUnsent(agent: unknown, body: string, round: unknown, prefix: '>>'): unknown;
        dismissLatestBounce(agent: unknown): void;
        draftsSending: Set<string>;
        draftsInFlight: Set<string>;
        proseDrafts: { get(agent: string, id: string): unknown; recordOutcome(...args: unknown[]): void };
        deliverWithUnsent(agent: unknown, body: string, channelId: string, unsent: unknown): Promise<unknown>;
      };
      const agent = framework.getAgent('secondary')!;
      const writes = [
        t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage'),
        t.mock.method(agent.getContextManager(), 'addMessage'),
      ];
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const traced: string[] = [];
      const off = framework.onTrace((event) => { if (event.type === 'message:added') traced.push(JSON.stringify(event)); });
      state.agents.delete('secondary');
      let woken = -1;
      try {
        const round = { routing: state.routingOf('secondary'), notice: 'later' };
        // {{unsent}} with nothing held, and no words of its own.
        assert.deepEqual(state.takeUnsent(agent, '{{unsent}}', round, '>>'), { refused: true });
        const held = state.holdProseDrafts(agent, [{ text: 'words held at once' }], 'bounced', { routing: state.routingOf('secondary'), notice: 'now' });
        assert.equal(held.length, 1, 'the draft is held as before');
        // >>skip_reply {{unsent}}, and {{unsent}}, while that draft is being sent.
        state.draftsSending.add(`secondary\u0000${held[0]!.id}`);
        state.draftsInFlight.add(`secondary\u0000${held[0]!.id}`);
        state.dismissLatestBounce(agent);
        assert.equal((state.takeUnsent(agent, '{{unsent}}', round, '>>') as { refused?: unknown }).refused, true);
        // {{unsent}} whose send came back, but whose outcome could not be recorded.
        t.mock.method(state.channelRegistry, 'resolveDestination', () => ({ destination: { serverId: 'srv', channelId: 'unrecorded-channel' } }));
        t.mock.method(state.channelRegistry, 'deliverSpeech', async () => ({ status: 'delivered', at: Date.now() }));
        t.mock.method(state.proseDrafts, 'recordOutcome', () => { throw new Error('journal refused'); });
        await state.deliverWithUnsent(agent, 'words resent', 'unrecorded-channel', state.proseDrafts.get('secondary', held[0]!.id));
        state.bounceProse(agent, 'words whose send threw', 'connection lost', undefined, '>>', round, { outcome: 'unknown' });
        // Prose with no destination: a bounce, whose notice would wake its speaker.
        state.bounceProse(agent, 'words with no destination', 'no destination', undefined, '>>', round);
        // Counted before the loop runs: running, it takes what is pending.
        woken = (state.pendingRequests as Array<{ agentName?: string }>).filter((r) => r.agentName === 'secondary').length;
        await framework.runUntilIdle();
      } finally {
        state.agents.set('secondary', agent);
        off();
      }
      assert.equal(writes.reduce((n, w) => n + w.mock.callCount(), 0), 0, 'nothing is written to any window');
      assert.equal(state.deferredMessages.length, 0);
      assert.deepEqual(traced, [], 'nothing is traced as added');
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its held-draft notice is dropped'));
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its unknown-send notice is dropped'));
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its prose-bounce notice is dropped'));
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its empty-{{unsent}} notice is dropped'));
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its in-flight-dismiss notice is dropped'));
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its refused-{{unsent}} notice is dropped'));
      assert.ok(errors.includes('[notice] secondary is no longer registered, so its unrecorded-outcome notice is dropped'));
      assert.equal(woken, 0, 'no wake is requested for it');
      assert.ok(!errors.some((e) => /not a registered agent/.test(e)), 'not dropped by addMessage instead');
    });

    it('drops, logged once, a script wake for an agent no longer registered: no write, trace or wake', async (t) => {
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const traces: string[] = [];
      framework.onTrace((event) => { if (event.type === 'message:added') traces.push(JSON.stringify(event)); });

      // The script's wake_agent(), had it made the call, would be told it couldn't be delivered.
      await assert.rejects(
        internals(framework).scriptWake('released-run', 's2', '[script s2] Your script failed: Error: gone.', 's2-ended'),
        /agent released-run has no context to wake/,
      );

      assert.equal(primary.mock.callCount(), 0, 'the primary started no such script');
      assert.deepEqual(errors, ['[notice] released-run is no longer registered, so its script s2 wake notice is dropped']);
      assert.deepEqual(traces, [], 'nothing was queued or stored');
      assert.equal(internals(framework).deferredMessages.length, 0);
      assert.equal(internals(framework).pendingRequests.length, 0, 'no wake for an agent that is gone');
    });

    it('wakes a fork\'s script into the fork\'s own window', async () => {
      const fork = await spawnFork();
      // Without quotes, which the count's JSON would escape.
      const envelope = '[script s1] Your script failed: Error: boom.';

      await internals(framework).scriptWake(fork.name, 's1', envelope, 's1-ended');

      const { messages: forkMessages } = await fork.getContextManager().compile();
      const { messages: primaryMessages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(forkMessages, envelope), 1);
      assert.equal(count(primaryMessages, envelope), 0);
    });

    it("drops a fork's script wake when the fork is released while its text is being spilled", async () => {
      const fork = await spawnFork();
      const envelope = '[script s3] Your script failed: Error: late.';
      // The spill takes a while, as a workspace write can: the fork is released meanwhile.
      const real = (framework as unknown as { spillOrTruncate: (...args: unknown[]) => Promise<unknown> }).spillOrTruncate.bind(framework);
      let spilling!: () => void;
      const spillStarted = new Promise<void>((resolve) => { spilling = resolve; });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      (framework as unknown as { spillOrTruncate: (...args: unknown[]) => Promise<unknown> }).spillOrTruncate = async (...args: unknown[]) => {
        spilling();
        await held;
        return real(...args);
      };
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      try {
        const waking = internals(framework).scriptWake(fork.name, 's3', envelope, 's3-ended');
        await spillStarted;
        (framework as unknown as { disposeConversationAgent(name: string): void }).disposeConversationAgent(fork.name);
        finish();
        await assert.rejects(waking, new RegExp(`agent ${fork.name} has no context to wake`));
      } finally {
        console.error = error;
        delete (framework as unknown as { spillOrTruncate?: unknown }).spillOrTruncate;
      }
      assert.ok(errors.includes(`[notice] ${fork.name} is no longer registered, so its script s3 wake notice is dropped`), errors.join('\n'));
      assert.equal(internals(framework).pendingRequests.length, 0, 'no wake for a fork that is gone');
    });

    it('drops a script wake once the host has begun to stop: before its spill, and after a spill the stop began during', async () => {
      const fork = await spawnFork();
      const fw = framework as unknown as { stopPromise: Promise<void> | null; spillOrTruncate: (...args: unknown[]) => Promise<unknown> };
      const real = fw.spillOrTruncate.bind(framework);
      let spills = 0;
      let spilling!: () => void;
      const spillStarted = new Promise<void>((resolve) => { spilling = resolve; });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      fw.spillOrTruncate = async (...args: unknown[]) => {
        spills += 1;
        spilling();
        await held;
        return real(...args);
      };
      try {
        // A stop begun during the spill: the wake is dropped once the spill is done.
        const waking = internals(framework).scriptWake(fork.name, 's4', '[script s4] Woke you.', 's4-wake1');
        await spillStarted;
        fw.stopPromise = new Promise(() => {});
        finish();
        await assert.rejects(waking, /this host is stopping/);
        // Begun before the wake: nothing is spilled at all.
        await assert.rejects(internals(framework).scriptWake(fork.name, 's5', '[script s5] Woke you.', 's5-wake1'), /this host is stopping/);
        assert.equal(spills, 1);
      } finally {
        fw.stopPromise = null;
        delete (framework as unknown as { spillOrTruncate?: unknown }).spillOrTruncate;
      }
      assert.equal(internals(framework).pendingRequests.length, 0, 'no wake once the host is stopping');
    });

    /** Run the fallback reaper over a closing fork, as a minute's sweep would. */
    function reap(forkName: string) {
      const state = internals(framework);
      state.closingConversationAgents.add(forkName);
      state.lastConversationSweep = 0;
      state.sweepExpiredConversations();
    }

    it('tells the primary, once, of a failure notice a fork stored but never read, when the fork is released', async () => {
      const reply = 'Reply from the fork.';
      const fork = await spawnFork(reply);
      // The notice landed in the fork's window after its turn: no compile has read it.

      reap(fork.name);

      assert.equal(framework.getAgent(fork.name), null, 'released with no closure turn');
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      const told = messages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
      assert.equal(told.length, 1);
      assert.match(JSON.stringify(told[0]!.content),
        new RegExp(`A reply by ${fork.name} \\(${reply.length} chars\\) could not be delivered to missing-channel \\(the \\\\"srv\\\\" server has no channel \\\\"missing-channel\\\\" registered here\\)\\. Nothing was posted\\. ${fork.name} has ended\\.`));
      // The marker passed on names the channel's server, as the fork's did.
      const markers = framework.getAgent('primary')!.getContextManager().queryMessages({}).messages
        .map((m) => m.metadata as { kind?: string; channelId?: string; serverId?: string } | undefined)
        .filter((m) => m?.kind === 'discord-send-failed');
      assert.deepEqual(markers.map((m) => [m?.channelId, m?.serverId]), [['missing-channel', 'srv']]);
    });

    it('passes on only what a fork never read: a notice its later turn compiled stays its own', async () => {
      const fork = await spawnFork('Reply from the fork.');
      const second = 'A second reply, which fails as well.';
      membrane.pushResponse(createMockResponse([{ type: 'text', text: second }]));
      framework.pushEvent({
        type: 'mcpl:channel-incoming',
        serverId: 'srv',
        channelId: 'missing-channel',
        messageId: 'incoming-2',
        author: { id: 'user-1', name: 'User' },
        content: [{ type: 'text', text: 'Hello again.' }],
        timestamp: new Date().toISOString(),
        metadata: { channel_type: 'im' },
        triggerInference: true,
      } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 2, 'the fork\'s second turn compiled its first notice');

      reap(fork.name);

      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      const told = messages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
      assert.equal(told.length, 1);
      assert.match(JSON.stringify(told[0]!.content), new RegExp(`A reply by ${fork.name} \\(${second.length} chars\\)`));
    });

    it("passes on nothing a channel server's metadata dressed as a failure notice, when the fork is released", async () => {
      // An unread message in a fork's window whose metadata claims to be the
      // host's failed-reply notice, with the server's own words in its fields,
      // and every other key only the host writes.
      const hostKeys = {
        system: true, kind: 'discord-send-failed', draftOwner: 'primary', draftIds: ['d-k7x3qm2'],
        tuneOut: { epochId: 'an-epoch' }, coalescingSubject: '["srv","b","channel","missing-channel","message:incoming-1"]',
        firstView: true, deferredWriteId: 'a-queued-write', external: { source: 'discord', id: '1548000000000000002' },
        openaiResponsesItems: [],
      };
      framework.pushEvent({
        type: 'mcpl:channel-incoming',
        serverId: 'srv',
        channelId: 'missing-channel',
        messageId: 'incoming-1',
        author: { id: 'user-1', name: 'User' },
        content: [{ type: 'text', text: 'An ordinary message.' }],
        timestamp: new Date().toISOString(),
        metadata: { channel_type: 'im', ...hostKeys, textLen: 5, reason: 'words the server chose', detail: 'more of them' },
        triggerInference: false,
      } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      const binding = framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'missing-channel' });
      assert.ok(binding, 'the DM spawns a real conversation fork');
      assert.equal(membrane.calls.length, 0, 'no turn read the message');
      const row = framework.getAgent(binding.agentName)!.getContextManager().getAllMessages()
        .find((m) => JSON.stringify(m.content).includes('An ordinary message.'));
      assert.ok(row, "the message is in the fork's window, unread");
      for (const key of Object.keys(hostKeys)) {
        assert.equal(Object.hasOwn((row.metadata ?? {}) as object, key), false, `the fork's row has no ${key}`);
      }

      reap(binding.agentName);

      assert.equal(framework.getAgent(binding.agentName), null, 'released');
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, SEND_FAILED), 0, 'the primary is told nothing');
      assert.equal(count(messages, 'words the server chose'), 0);
    });

    /** A clean stop() and a restart on the same store: a restart re-creates no fork. */
    async function restart() {
      await framework.stop();
      framework = await host();
    }

    /** The registry learns a label for `channel` after the fork's reply to it failed. */
    function learnLabel(channel: string, label: string) {
      (internals(framework).channelRegistry as unknown as { channels: Map<string, unknown> }).channels
        .set(destinationKey({ serverId: 'srv', channelId: channel }), { serverId: 'srv', descriptor: { id: channel, type: 'discord', label }, open: true });
    }

    async function primaryNotices() {
      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      return messages.map((m) => JSON.stringify(m.content)).filter((text) => text.includes(SEND_FAILED));
    }

    it('tells the primary of each failure notice a live fork never read when stop() ends the forks, by the channel\'s label, so it outlasts a restart', async () => {
      const reply = 'Reply from the fork.';
      const first = await spawnFork(reply);
      const second = await spawnFork(reply, 'missing-channel-2');
      // The label is the registry's until stop() forgets its channels, so the
      // notice has it only if the forks end before that.
      learnLabel('missing-channel', '#general');
      const disposed: string[] = [];
      framework.onTrace((event) => { if (event.type === 'mcpl:conversation-disposed') disposed.push(String(event.agentName)); });
      const stopped = framework;

      await restart();

      assert.deepEqual([...disposed].sort(), [first.name, second.name].sort(), 'stop() ends each fork as its end does');
      assert.equal(stopped.getAgent(first.name), null, 'the fork is removed');
      assert.equal(stopped.getAgent(second.name), null);
      const told = await primaryNotices();
      assert.equal(told.length, 2, told.join('\n'));
      assert.match(told[0]!, new RegExp(`A reply by ${first.name} \\(${reply.length} chars\\) could not be delivered to #general \\(missing-channel\\).*${first.name} has ended\\.`));
      assert.match(told[1]!, new RegExp(`A reply by ${second.name} \\(${reply.length} chars\\) could not be delivered to missing-channel-2 .*${second.name} has ended\\.`));
    });

    it('keeps that notice, and one queued for the fork, in the persisted queue when stop() ends the fork while quiesced, by the channel\'s label, and writes nothing to the fork\'s window, for the primary at resume', async () => {
      const reply = 'Reply from the fork.';
      const fork = await spawnFork(reply);
      learnLabel('missing-channel', '#general');
      await framework.quiesce({ reason: 'test window' });
      internals(framework).addMessage('user', [{ type: 'text', text: 'QUEUED FOR THE FORK' }], undefined, { forAgent: fork.name });
      internals(framework).addMessage('user', [{ type: 'text', text: `${SEND_FAILED} QUEUED FOR THE FORK.` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'a late failure', textLen: 7 }, { forAgent: fork.name });
      assert.ok(internals(framework).deferredMessages.some((m) => m.forAgent === fork.name), 'the writes wait in the queue');

      await restart();

      assert.deepEqual(await primaryNotices(), [], 'deferred while quiesced, not stored');
      const window = await ContextManager.open({
        store: framework.getStore(), namespace: `conversations/${fork.name}`, isolate: true, strategy: new PassthroughStrategy(),
      });
      assert.ok(!window.getAllMessages().some((m) => JSON.stringify(m.content).includes('QUEUED FOR THE FORK')),
        'a quiesced fork\'s release is postponed, so nothing queued for it lands in its window');
      await framework.resume();
      const told = await primaryNotices();
      assert.equal(told.length, 2, told.join('\n'));
      for (const length of [reply.length, 7]) {
        assert.ok(told.some((text) => new RegExp(`A reply by ${fork.name} \\(${length} chars\\) could not be delivered to #general \\(missing-channel\\)`).test(text)),
          told.join('\n'));
      }
    });

    it('drops, logged, a failed reply queued for a quiesced fork with no channel to reach when stop() ends the fork', async () => {
      const fork = await spawnFork();
      await framework.quiesce({ reason: 'test window' });
      internals(framework).addMessage('user', [{ type: 'text', text: `${SEND_FAILED} QUEUED FOR THE FORK.` }],
        { system: true, kind: 'discord-send-failed', channelId: '', reason: 'no channel', textLen: 9 }, { forAgent: fork.name });
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      try {
        await framework.stop();
      } finally {
        console.error = error;
      }
      assert.ok(!internals(framework).deferredMessages.some((m) => m.forAgent === fork.name), 'nothing stays queued for the fork');
      assert.ok(errors.some((line) => line.includes(`${fork.name} has ended, and its reply had no channel to reach`)), errors.join('\n'));
      framework = await host();
      await framework.resume();
      assert.ok(!(await primaryNotices()).some((text) => text.includes('(9 chars)')), 'no one is told of it');
    });

    it('looks a marked failed reply queued for a fork up in the primary\'s window when stop() ends the fork: a copy that landed there isn\'t written again', async () => {
      const fork = await spawnFork();
      const state = internals(framework) as ReturnType<typeof internals> & { deferredSeq: number };
      // A failed reply held for the fork whose earlier write may have landed,
      // its store unread, and a copy of it under its id that did land in the
      // primary's window. (Not quiesced: there the entry is deferred again,
      // and after resume the primary holds one copy with the mark's lookup or
      // without it, so the test couldn't tell them apart.)
      const id = 'marked-failed-reply';
      (state.deferredMessages as unknown[]).push({
        id, seq: ++state.deferredSeq, participant: 'user', heldAt: Date.now(), forAgent: fork.name, landing: 'unknown',
        content: [{ type: 'text', text: `${SEND_FAILED} QUEUED FOR THE FORK.` }],
        metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'a late failure', textLen: 7 },
      });
      framework.getAgent('primary')!.getContextManager()
        .addMessage('user', [{ type: 'text', text: 'AN EARLIER COPY' }], { deferredWriteId: id } as never);

      await restart();

      const copies = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => (m.metadata as { deferredWriteId?: string } | undefined)?.deferredWriteId === id);
      assert.equal(copies.length, 1, 'found by its id, it is not written to the primary again');
    });

    /** How `promise` ends within `ms`: it returned, it rejected, or it's still
     *  waiting, as runUntilIdle() waits on a stream entry that outlives its
     *  stream. */
    async function outcomeWithin(promise: Promise<unknown>, ms: number): Promise<'returned' | 'rejected' | 'still waiting'> {
      let timer!: ReturnType<typeof setTimeout>;
      const late = new Promise<'still waiting'>((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
      const outcome = await Promise.race([promise.then(() => 'returned' as const, () => 'rejected' as const), late]);
      clearTimeout(timer);
      return outcome;
    }

    it('ends a fork whose stream outlasts stop()\'s wait: its release tells the primary of the failure notice queued behind its turn, and no entry of its stream outlives the stream', { timeout: 30_000 }, async () => {
      const reply = 'Reply from the fork.';
      const fork = await spawnFork(reply);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      membrane.streamYielding = (request) => {
        membrane.calls.push(request);
        return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'A held reply.' }])]);
      };
      try {
        framework.start();
        framework.pushEvent(dm('incoming-2', 'Are you there?'));
        // Registered, not just made: a stream made after stop() begins is
        // dropped before it sends anything, and stop() has nothing to wait for.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !internals(framework).activeStreams.has(fork.name)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const handle = internals(framework).activeStreams.get(fork.name);
        assert.ok(handle, "the fork's stream registered");
        // This turn read the first reply's notice when it compiled. An earlier
        // reply's failure that arrives now waits in the queue behind the turn.
        (internals(framework).channelRegistry as unknown as {
          onRouteFailure(info: { conversationId: string; channelId: string | null; reason: string; textLen: number }): void
        }).onRouteFailure({ conversationId: fork.name, channelId: 'missing-channel', reason: 'a late failure', textLen: 5 });
        assert.ok(internals(framework).deferredMessages.some((m) => m.forAgent === fork.name), 'the notice waits behind the turn');

        const outcome = await framework.stop(100).then(() => null, (error: unknown) => error);
        assert.ok(outcome instanceof ShutdownTimeoutError, String(outcome));
        assert.equal(framework.getAgent(fork.name), null, 'a fork ends whatever its stream is doing');
        const told = await primaryNotices();
        assert.ok(told.some((text) => text.includes(`A reply by ${fork.name} (5 chars)`) && text.includes(`${fork.name} has ended.`)),
          told.join('\n'));

        release();
        await handle!.then(() => {}, () => {});
        assert.equal(internals(framework).activeStreams.has(fork.name), false, "no entry of the fork's stream outlives the stream");
        assert.equal(await outcomeWithin(framework.runUntilIdle(), 10_000), 'returned');
        await restart();

        assert.ok((await primaryNotices()).some((text) => text.includes(`A reply by ${fork.name} (5 chars)`)), 'it outlasts a restart');
      } finally {
        release();
      }
    });

    /** A stream that ignores its cancel and ends later with no event at all,
     *  once `closed` settles. */
    class SilentlyClosingStream extends MockYieldingStream {
      constructor(private readonly closed: Promise<void>) { super([]); }
      override async *[Symbol.asyncIterator](): AsyncGenerator<never> {
        await this.closed;
      }
    }

    it('ends a quiesced fork whose stream outlasts stop()\'s wait: stop() sends its queued failed reply to the primary, and the stream\'s late end leaves nothing behind', { timeout: 30_000 }, async () => {
      const fork = await spawnFork('Reply from the fork.');
      let close!: () => void;
      const closed = new Promise<void>((resolve) => { close = resolve; });
      membrane.streamYielding = (request) => {
        membrane.calls.push(request);
        return new SilentlyClosingStream(closed);
      };
      const state = internals(framework);
      try {
        framework.start();
        framework.pushEvent(dm('incoming-2', 'Are you there?'));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !state.activeStreams.has(fork.name)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const handle = state.activeStreams.get(fork.name);
        assert.ok(handle, "the fork's stream registered");
        let settled = false;
        void handle!.then(() => { settled = true; }, () => { settled = true; });
        // What a context-budget restart that ended with no stream of its own
        // leaves: its predecessor's stream still running, and no turn token
        // held, so the quiesce has no turn to wait for.
        state.activeTurnTokens.delete(fork.name);
        await framework.quiesce({ reason: 'test window' });
        (state.channelRegistry as unknown as {
          onRouteFailure(info: { conversationId: string; channelId: string | null; reason: string; textLen: number }): void
        }).onRouteFailure({ conversationId: fork.name, channelId: 'missing-channel', reason: 'a late failure', textLen: 5 });
        const queued = state.deferredMessages.find((m) => m.forAgent === fork.name) as { id: string } | undefined;
        assert.ok(queued, 'the late failed reply waits in the queue');

        const outcome = await framework.stop(100).then(() => null, (error: unknown) => error);
        assert.ok(outcome instanceof ShutdownTimeoutError, String(outcome));
        assert.equal(framework.getAgent(fork.name), null, 'a fork ends whatever its stream is doing');
        const entry = state.deferredMessages.find((m) => (m as { id?: string }).id === queued.id);
        assert.ok(entry, 'the entry is still queued, under its own id');
        assert.equal(entry.forAgent, undefined, 'for the primary');

        // The stream ends with no event.
        close();
        const until = Date.now() + 5_000;
        while (Date.now() < until && !settled) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(settled, 'the stream ended');
        assert.equal(state.activeStreams.has(fork.name), false, "no entry of the fork's stream outlives the stream");
        assert.equal(await outcomeWithin(framework.runUntilIdle(), 10_000), 'returned');

        await restart();
        await framework.resume();
        const told = await primaryNotices();
        assert.ok(told.some((text) => text.includes(`A reply by ${fork.name} (5 chars)`)), told.join('\n'));
      } finally {
        close();
      }
    });

    it('ends a fork whose turn holds its token: stop() sends its queued failed reply to the primary, so a flush of that turn into the fork\'s own window afterwards meets nothing', async () => {
      const reply = 'Reply from the fork.';
      const fork = await spawnFork(reply);
      const state = internals(framework) as ReturnType<typeof internals> & {
        flushForStart(agent: unknown, occasion: 'turn-start' | 'assembly'): boolean;
      };
      await framework.quiesce({ reason: 'test window' });
      state.addMessage('user', [{ type: 'text', text: `${SEND_FAILED} QUEUED FOR THE FORK.` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'a late failure', textLen: 7 }, { forAgent: fork.name });
      // Its turn holds its token without a stream, as one still assembling or
      // compiling does. A stop() whose wait ran out on such a turn fails and
      // leaves storage open; here a teardown step fails instead.
      state.activeTurnTokens.set(fork.name, 7);
      const registry = state.channelRegistry as unknown as { stopAll(): void };
      const stopAll = registry.stopAll.bind(registry);
      registry.stopAll = () => { throw new Error('zz a teardown step failed'); };
      const failure = await framework.stop().then(() => null, (error: unknown) => error);
      registry.stopAll = stopAll;
      assert.match(String(failure), /zz a teardown step failed/);
      assert.equal(framework.getAgent(fork.name), null, 'a fork ends whatever its turn is doing');
      assert.ok(!state.deferredMessages.some((m) => m.forAgent === fork.name), "stop()'s pass took what was queued for it");

      // The turn unwinds through its assembly, whose flush writes into the
      // fork's own window, past readdDrained.
      assert.equal(state.flushForStart(fork, 'assembly'), false);
      assert.ok(!fork.getContextManager().getAllMessages().some((m) => JSON.stringify(m.content).includes('QUEUED FOR THE FORK')),
        "nothing lands in the fork's window");
      state.activeTurnTokens.delete(fork.name);
      await restart();
      await framework.resume();

      const told = await primaryNotices();
      assert.ok(told.some((text) => text.includes(`A reply by ${fork.name} (${reply.length} chars)`)), told.join('\n'));
      assert.ok(told.some((text) => text.includes(`A reply by ${fork.name} (7 chars)`)), told.join('\n'));
    });

    it('settles the tool-result batch and the open tool round a fork still holds when stop() ends it', async () => {
      const fork = await spawnFork('Reply from the fork.');
      const guard = fork.toolResultGuard;
      guard.setOverride(true);
      guard.storeResults(
        [{ type: 'tool_result', toolUseId: 'held-call', content: 'A held result.' }] as never,
        [{ toolUseId: 'held-call', content: 'A held result.' }] as never,
        [{ id: 'held-call', name: 'held--tool', input: {}, result: { toolUseId: 'held-call', content: 'A held result.' } }] as never,
        undefined, undefined);
      assert.ok(guard.hasPending, 'its batch is pending');
      const state = internals(framework);
      state.pendingAssistantBlocks.set(fork.name, []);

      await restart();

      assert.equal(guard.hasPending, false);
      // Settled conservatively: the guard's audit record, for an operator,
      // has the fork's batch withheld, not admitted.
      const audit = framework.getStore().getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<{ agentName?: string; type?: string; reason?: string }> | null;
      assert.ok((audit ?? []).some((record) => record.agentName === fork.name && record.type === 'withheld' && record.reason === 'aborted'), JSON.stringify(audit));
      assert.equal(state.pendingAssistantBlocks.has(fork.name), false, "and took its open tool round's entry");
    });

    it('ends a fork whose batch can\'t be settled all the same: stop() logs it, and the fork is deregistered and released', async () => {
      const reply = 'Reply from the fork.';
      const fork = await spawnFork(reply);
      const guard = fork.toolResultGuard;
      Object.defineProperty(guard, 'hasPending', { get: () => true, configurable: true });
      guard.abandon = () => { throw new Error('zz the batch could not be settled'); };
      const state = internals(framework);
      state.pendingAssistantBlocks.set(fork.name, []);
      const stopped = framework;
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      try {
        await restart();
      } finally {
        console.error = error;
      }

      assert.ok(errors.some((line) => line.includes(`agent=${fork.name} failed to record a batch the fork left`)), errors.join('\n'));
      assert.equal(stopped.getAgent(fork.name), null, 'the fork is deregistered');
      assert.equal(state.pendingAssistantBlocks.has(fork.name), false, "its open tool round's entry is gone");
      assert.ok((await primaryNotices()).some((text) => text.includes(`A reply by ${fork.name} (${reply.length} chars)`)), 'its release passed its notice on');
    });

    it('ends the other forks when one fork\'s end throws, fails with that error, and a second stop() ends that fork too', async () => {
      const first = await spawnFork();
      const second = await spawnFork('Reply from the fork.', 'missing-channel-2');
      const owner = framework as unknown as { disposeConversationAgent(name: string): void };
      const usual = owner.disposeConversationAgent.bind(framework);
      const error = new Error("zz the first fork's end failed");
      owner.disposeConversationAgent = (name: string) => {
        if (name === first.name) throw error;
        usual(name);
      };

      const failure = await framework.stop().then(() => null, (e: unknown) => e);

      assert.ok(failure === error || (failure instanceof AggregateError && failure.errors.includes(error)), String(failure));
      assert.equal(framework.getAgent(second.name), null, "the other fork's end still ran");
      assert.equal(framework.getAgent(first.name), first, 'the fork whose end threw is still registered');
      delete (owner as { disposeConversationAgent?: unknown }).disposeConversationAgent;
      await restart();
      const told = await primaryNotices();
      assert.equal(told.length, 2, told.join('\n'));
      assert.ok(told.some((text) => text.includes(`A reply by ${first.name} `)), told.join('\n'));
    });

    it("unbinds the channel of each fork stop() ends", async () => {
      const fork = await spawnFork();
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'missing-channel' })?.agentName, fork.name, 'the fork holds the channel');
      await framework.stop();
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'missing-channel' }), undefined, 'the channel unbinds with its fork');
    });

    it('fails a spawn whose fork stop() ends before the spawn binds it, so no binding names the fork, and the channel\'s next message spawns the next generation', async () => {
      // stop() unbinds a channel only where its binding names the fork it
      // ends, and a spawn binds only once its fork's creation has returned.
      // Ending the fork in that gap as stop()'s loop does
      // (disposeConversationAgent, with no binding to remove) stands in for a
      // stop() that runs then.
      const state = framework as unknown as {
        createConversationAgent(name: string, channelId: string): Promise<unknown>;
        disposeConversationAgent(name: string): void;
      };
      const create = state.createConversationAgent;
      let ended: string | undefined;
      state.createConversationAgent = async function (this: typeof state, name, channelId) {
        const agent = await create.call(this, name, channelId);
        this.disposeConversationAgent(name);
        ended = name;
        return agent;
      };
      const failed: string[] = [];
      framework.onTrace((event) => { if (event.type === 'mcpl:conversation-spawn-failed') failed.push(String(event.error)); });

      framework.pushEvent(dm('incoming-1', 'Hello fork.'));
      await framework.runUntilIdle();
      assert.ok(ended, 'the fork was created and then ended before its bind');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'missing-channel' }), undefined, 'no binding names the ended fork');
      assert.equal(failed.length, 1, 'the spawn fails, as a failed spawn does');
      assert.match(failed[0]!, /ended before its channel was bound/);

      delete (state as { createConversationAgent?: unknown }).createConversationAgent;
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Reply from the next fork.' }]));
      framework.pushEvent(dm('incoming-2', 'Hello again.'));
      await framework.runUntilIdle();
      const next = framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'missing-channel' })?.agentName;
      assert.ok(next && next !== ended, `the next generation binds the channel (bound: ${next}; failed: ${failed.join(' | ')})`);
    });

    it('does not reap a closing fork whose turn holds its token before its stream registers', async () => {
      const fork = await spawnFork();
      const state = internals(framework);
      state.activeTurnTokens.set(fork.name, 7);

      reap(fork.name);
      assert.equal(framework.getAgent(fork.name), fork, 'a turn mid-compile is busy');

      state.activeTurnTokens.delete(fork.name);
      reap(fork.name);
      assert.equal(framework.getAgent(fork.name), null);
    });

    it('lands a queued ordinary write in a released fork\'s window, with its durable id, and acks it', async () => {
      const fork = await spawnFork();
      const state = internals(framework);
      state.deferredWritesPersisted = true;
      state.activeTurnTokens.set(fork.name, 3);
      state.addMessage('user', [{ type: 'text', text: 'queued for the fork' }], { kind: 'test-note' }, { forAgent: fork.name });
      assert.equal(state.deferredMessages.length, 1);
      state.activeTurnTokens.delete(fork.name);

      reap(fork.name);

      assert.equal(framework.getAgent(fork.name), null);
      assert.equal(state.deferredMessages.length, 0);
      assert.equal(state.unackedDeferredWrites.length, 0, 'acked out of the recovery queue');
      const archive = await ContextManager.open({
        store: framework.getStore(), namespace: 'conversations/' + fork.name, isolate: true, strategy: new PassthroughStrategy(),
      });
      const stored = archive.getAllMessages().find((m) => JSON.stringify(m.content).includes('queued for the fork'));
      assert.ok(stored, 'it landed in the fork\'s own window');
      assert.equal(typeof (stored.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId, 'string');
    });

    for (const [what, hold] of [
      ['its own tool cycle', (state: ReturnType<typeof internals>, fork: string) => { state.pendingAssistantBlocks.set(fork, []); }],
      ['its own stream', (state: ReturnType<typeof internals>, fork: string) => { state.activeStreams.set(fork, new Promise<void>(() => {})); }],
    ] as const) {
      it(`defers a fork's notice while only ${what} is alive`, async (t) => {
        const fork = await spawnFork();
        const state = internals(framework);
        const forkCm = t.mock.method(fork.getContextManager(), 'addMessage');
        hold(state, fork.name);
        try {
          await state.channelRegistry.routeSpeech(fork.name, 'hello', null);

          assert.equal(forkCm.mock.callCount(), 0);
          assert.equal(state.deferredMessages.length, 1);
          assert.equal(state.deferredMessages[0]!.forAgent, fork.name);
        } finally {
          // A stream that never settles would hold stop() in afterEach.
          state.activeStreams.delete(fork.name);
        }
      });
    }

    it('lands a fork\'s notice while only another agent\'s tool cycle is pending', async (t) => {
      const fork = await spawnFork();
      const state = internals(framework);
      const forkCm = t.mock.method(fork.getContextManager(), 'addMessage');
      state.pendingAssistantBlocks.set('primary', []);

      await state.channelRegistry.routeSpeech(fork.name, 'hello', null);

      assert.equal(forkCm.mock.callCount(), 1, 'the fork\'s window has no cycle in flight');
      assert.equal(state.deferredMessages.length, 0);
    });

    it('tells the agent whose send opened a channel, in its own window; a policy open tells the primary', async (t) => {
      const fork = await spawnFork();
      const state = internals(framework);
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const forkCm = t.mock.method(fork.getContextManager(), 'addMessage');

      // The fork's own home channel, which it can close.
      state.recordChannelAutoOpenNotice(fork.name, 'srv', [{ channelId: 'missing-channel', label: '#home' }], 'opened-by-reply');
      assert.equal(forkCm.mock.callCount(), 1);
      assert.equal(primary.mock.callCount(), 0);
      assert.match(JSON.stringify(forkCm.mock.calls[0]!.arguments[1]),
        /Now open: #home \(missing-channel\): your own message into the closed channel opened it\. .*use channel_close/);

      state.recordChannelAutoOpenNotice(undefined, 'srv', [{ channelId: 'c-2' }], 'subscription-policy');
      assert.equal(primary.mock.callCount(), 1, 'no agent caused a policy open');
      assert.equal(forkCm.mock.callCount(), 1);
    });

    it("keeps the server the registry names for an open a delivery forced, as the framework's callback writes the notice's inputs", async () => {
      // The fork's home is on a server other than the fixture's own, so a
      // notice built with any server but the callback's names the wrong one.
      const fork = await spawnFork('Reply from the fork.', 'missing-channel', 'other-server');
      const registry = internals(framework).channelRegistry as unknown as {
        onChannelAutoOpened(info: { conversationId?: string; serverId: string; source: string; channels: Array<{ channelId: string; label?: string }> }): void;
      };
      registry.onChannelAutoOpened({ conversationId: fork.name, serverId: 'other-server', source: 'opened-by-delivery', channels: [{ channelId: 'missing-channel', label: '#home' }] });
      const notice = fork.getContextManager().getAllMessages()
        .find((m) => (m.metadata as { kind?: unknown } | undefined)?.kind === 'channel-notice');
      assert.equal((notice?.metadata as { passOn?: { serverId?: unknown } } | undefined)?.passOn?.serverId, 'other-server');
    });

    it("tells a fork whose send opened a channel away from its home that it opened, without channel_close, which it can't call there, and tells the primary by name, which can", async (t) => {
      const fork = await spawnFork();
      const state = internals(framework);
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const forkCm = t.mock.method(fork.getContextManager(), 'addMessage');

      state.recordChannelAutoOpenNotice(fork.name, 'srv', [{ channelId: 'c-1', label: '#one' }], 'opened-by-reply');

      assert.equal(forkCm.mock.callCount(), 1);
      assert.equal(JSON.stringify(forkCm.mock.calls[0]!.arguments[1]), JSON.stringify([{ type: 'text', text:
        '[channels] Now open: #one (c-1): your own message into the closed channel opened it. Your primary has been told and can close it.' }]));
      assert.equal(primary.mock.callCount(), 1, 'the primary is told too');
      assert.equal(JSON.stringify(primary.mock.calls[0]!.arguments[1]), JSON.stringify([{ type: 'text', text:
        `[channels] Now open: #one (c-1): a message from your fork in missing-channel, named ${fork.name}, into the closed channel opened it, and that fork can't close it. ` +
        "If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again." }]));
      assert.equal((primary.mock.calls[0]!.arguments[2] as { speaker?: unknown } | undefined)?.speaker, fork.name);

      // The advice left out is advice the fork can't take: its channel_close
      // there is refused.
      const results: Array<{ success?: boolean; error?: string }> = [];
      const push = framework.pushEvent.bind(framework);
      (framework as unknown as { pushEvent: (e: { type: string; result?: { success?: boolean; error?: string } }) => void }).pushEvent = (e) => {
        if (e.type === 'tool-result') results.push(e.result!); else push(e as never);
      };
      try {
        (framework as unknown as { dispatchChannelToolCall(agent: string, call: { id: string; name: string; input: Record<string, unknown> }): void })
          .dispatchChannelToolCall(fork.name, { id: 'close-away', name: 'channel_close', input: { channelId: 'c-1' } });
        for (let i = 0; i < 50 && results.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
      } finally {
        (framework as unknown as { pushEvent: unknown }).pushEvent = push;
      }
      assert.equal(results[0]?.success, false);
      assert.match(results[0]?.error ?? '', /closing "c-1" is not allowed/);
    });

    it('tells the primary, by name, of a channel notice a fork could act on and never read, when the fork is released', async () => {
      const fork = await spawnFork();
      const state = internals(framework);
      decide('missing-channel', 'open');
      state.recordChannelAutoOpenNotice(fork.name, 'srv', [{ channelId: 'missing-channel', label: '#home' }], 'opened-by-reply');

      reap(fork.name);

      assert.equal(framework.getAgent(fork.name), null, 'released');
      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('#home'));
      assert.equal(told.length, 1, 'the primary is told once');
      assert.equal((told[0]!.content[0] as { text: string }).text,
        `[channels] Now open: #home (missing-channel): a message from your fork in missing-channel, named ${fork.name}, into the closed channel opened it; that fork has ended. ` +
        "If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.");
      assert.equal((told[0]!.metadata as { speaker?: unknown } | undefined)?.speaker, fork.name);
    });

    it('tells the primary nothing, logged, of a channel a fork\'s unread notice said opened, once the channel has closed', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const fork = await spawnFork();
      decide('missing-channel', 'open');
      internals(framework).recordChannelAutoOpenNotice(fork.name, 'srv', [{ channelId: 'missing-channel', label: '#home' }], 'opened-by-reply');
      decide('missing-channel', 'closed', 'agent-tool');

      reap(fork.name);

      assert.equal(framework.getAgent(fork.name), null, 'released');
      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('#home'));
      assert.equal(told.length, 0, 'the primary is told nothing');
      assert.ok(errors.includes(
        `[channel] ${fork.name} has ended, and no channel its notice said opened is decided open or tuned out now (#home (missing-channel)): no one is told`));
    });

    it("passes on no channel notice its reader couldn't act on: the primary was told then, once", async () => {
      const fork = await spawnFork();
      const state = internals(framework);
      // Decided open, so only the notice's missing inputs keep it back.
      decide('c-1', 'open');
      state.recordChannelAutoOpenNotice(fork.name, 'srv', [{ channelId: 'c-1', label: '#one' }], 'opened-by-reply');

      reap(fork.name);

      assert.equal(framework.getAgent(fork.name), null, 'released');
      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('#one'));
      assert.equal(told.length, 1, 'only the notice of the time');
      assert.match(JSON.stringify(told[0]!.content), new RegExp(`your fork in missing-channel, named ${fork.name}, into the closed channel opened it, and that fork can't close it`));
    });

    it('tells the primary, by name, of a channel an ended agent\'s send opened, and the primary\'s channel_close closes it', async (t) => {
      const state = internals(framework);
      const channels = (state.channelRegistry as unknown as { channels: Map<string, { open: boolean }> }).channels;
      // The channel the ended run's send opened, on a server that lets it close.
      channels.set(destinationKey({ serverId: 'srv', channelId: 'opened-1' }), { serverId: 'srv', descriptor: { id: 'opened-1', type: 'srv', label: '#opened' }, open: true } as never);
      const closed: unknown[] = [];
      const server = {
        grant: new CapabilityGrant(new Set(['channels.publish', 'channels.lifecycle']), []),
        sendChannelsTyping() {},
        async sendChannelsClose(params: unknown) { closed.push(params); },
      };
      t.mock.method(state.mcplServerRegistry, 'getServer', () => server as never);

      state.recordChannelAutoOpenNotice('released-run', 'srv', [{ channelId: 'opened-1', label: '#opened' }], 'opened-by-delivery');

      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('Now open: #opened (opened-1)'));
      assert.equal(told.length, 1, 'the primary is told once');
      assert.match(JSON.stringify(told[0]!.content), /a message from released-run into the closed channel opened it; released-run has ended\. .*use channel_close/);
      assert.equal((told[0]!.metadata as { speaker?: unknown } | undefined)?.speaker, 'released-run');
      assert.equal(state.deferredMessages.length, 0);

      // The remedy it names is the primary's to use.
      (framework as unknown as { dispatchChannelToolCall(agent: string, call: { id: string; name: string; input: Record<string, unknown> }): void })
        .dispatchChannelToolCall('primary', { id: 'close-1', name: 'channel_close', input: { channelId: 'opened-1' } });
      for (let i = 0; i < 50 && channels.get(destinationKey({ serverId: 'srv', channelId: 'opened-1' }))!.open; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(closed, [{ channelId: 'opened-1' }]);
      assert.equal(channels.get(destinationKey({ serverId: 'srv', channelId: 'opened-1' }))!.open, false, 'the channel the send opened is closed');
    });

    it('tells no one, logged, of a channel an ended agent\'s send opened when there is no primary', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const primary = t.mock.method(framework.getAgent('primary')!.getContextManager(), 'addMessage');
      const state = internals(framework) as unknown as ReturnType<typeof internals> & { primaryAgentName: string | null };
      const name = state.primaryAgentName;
      state.primaryAgentName = null;
      try {
        state.recordChannelAutoOpenNotice('released-run', 'srv', [{ channelId: 'opened-2' }], 'opened-by-delivery');
      } finally {
        state.primaryAgentName = name;
      }
      assert.equal(primary.mock.callCount(), 0);
      assert.equal(state.deferredMessages.length, 0);
      assert.deepEqual(errors, ['[channel] released-run has ended, and there is no primary to tell that opened-2 opened']);
    });

    it('passes a restored failure notice whose agent is gone to the primary, by name, and drops its other writes, logged', async (t) => {
      const state = internals(framework);
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push(
        {
          id: 'w-1', seq: 1, participant: 'user', forAgent: 'conversation-gone',
          content: [{ type: 'text', text: '[discord-send-failed] Your previous reply (12 chars) could not be delivered.' }],
          metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'no registered channel', textLen: 12 },
        },
        {
          // Queued by an earlier build: no textLen, and no reason either.
          id: 'w-2', seq: 2, participant: 'user', forAgent: 'conversation-older',
          content: [{ type: 'text', text: '[discord-send-failed] Your previous reply could not be delivered.' }],
          metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel' },
        },
        {
          id: 'w-3', seq: 3, participant: 'user', forAgent: 'conversation-gone',
          content: [{ type: 'text', text: 'an ordinary write' }],
        },
      );

      await state.flushDeferredWrites('boot-recovery');

      const { messages } = await framework.getAgent('primary')!.getContextManager().compile();
      const told = messages.filter((m) => JSON.stringify(m.content).includes('has ended')).map((m) => JSON.stringify(m.content));
      assert.equal(told.length, 2);
      assert.match(told[0]!, /A reply by conversation-gone \(12 chars\) could not be delivered to missing-channel \(no registered channel\)\. Nothing was posted\. conversation-gone has ended\./);
      assert.match(told[1]!, /A reply by conversation-older could not be delivered to missing-channel\. Nothing was posted\. conversation-older has ended\./);
      assert.ok(!told.some((t) => t.includes('undefined')));
      // Each is the entry itself, under its own id: boot's landed scan finds
      // it, so a crash before the ack replays neither.
      const stamped = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('has ended'))
        .map((m) => (m.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId);
      assert.deepEqual(stamped, ['w-1', 'w-2']);
      assert.deepEqual([...state.landedDeferredWriteIds(new Set(['w-1', 'w-2']), new Map())].sort(), ['w-1', 'w-2']);
      assert.equal(count(messages, 'an ordinary write'), 0);
      assert.ok(errors.some((e) => /"conversation-gone" is not a registered agent — message dropped \(participant=user\)/.test(e)));
      assert.equal(state.deferredMessages.length, 0);
    });

    it('passes a restored channel notice its gone reader could act on to the primary, by name, under its own id; one it couldn\'t is dropped, logged', async (t) => {
      const state = internals(framework);
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      decide('c-4', 'open');
      decide('c-5', 'open', 'server-bootstrap');
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push(
        {
          id: 'w-4', seq: 4, participant: 'user', forAgent: 'conversation-gone',
          content: [{ type: 'text', text: '[channels] Now open: #four (c-4): your own message into the closed channel opened it.' }],
          metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [{ channelId: 'c-4', label: '#four' }] } },
        },
        {
          id: 'w-5', seq: 5, participant: 'user', forAgent: 'conversation-gone',
          content: [{ type: 'text', text: '[channels] Not open: #five (c-5). Your reply there went out, but opening the channel failed.' }],
          metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId: 'c-5', label: '#five' }, selectedForOpening: 'server-bootstrap' } },
        },
        {
          // Its reader couldn't act on it, or an earlier build stored it: no inputs.
          id: 'w-6', seq: 6, participant: 'user', forAgent: 'conversation-gone',
          content: [{ type: 'text', text: '[channels] Now open: #six (c-6): your own message into the closed channel opened it.' }],
          metadata: { system: true, kind: 'channel-notice' },
        },
      );

      await state.flushDeferredWrites('boot-recovery');

      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('conversation-gone'));
      assert.deepEqual(told.map((m) => (m.content[0] as { text: string }).text), [
        "[channels] Now open: #four (c-4): a message from conversation-gone into the closed channel opened it; conversation-gone has ended. " +
          "If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
        "[channels] Not open: #five (c-5). A reply from conversation-gone went out there, but opening the channel failed; conversation-gone has ended. " +
          "It's selected for opening again, because its server lists it as open by default: the host tries again, and channel_close withdraws that.",
      ]);
      assert.deepEqual(told.map((m) => (m.metadata as { deferredWriteId?: unknown; speaker?: unknown }).deferredWriteId), ['w-4', 'w-5']);
      assert.deepEqual(told.map((m) => (m.metadata as { speaker?: unknown }).speaker), ['conversation-gone', 'conversation-gone']);
      const all = framework.getAgent('primary')!.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
      assert.equal(all.filter((c) => c.includes('#six')).length, 0);
      assert.ok(errors.some((e) => /"conversation-gone" is not a registered agent — message dropped \(participant=user\)/.test(e)));
      assert.equal(state.deferredMessages.length, 0);
    });

    it('passes on, of a restored channel notice, only what still holds: the channels still decided open or tuned out, and a failed one still decided open and not open', async (t) => {
      const state = internals(framework);
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      decide('c-7', 'open');
      decide('c-8', 'open');
      decide('c-8', 'closed', 'agent-tool');
      // Selected for opening, and open since.
      decide('c-9', 'open', 'server-bootstrap');
      (state.channelRegistry as unknown as { channels: Map<string, unknown> }).channels
        .set(destinationKey({ serverId: 'srv', channelId: 'c-9' }), { serverId: 'srv', descriptor: { id: 'c-9', type: 'srv', label: '#nine' }, open: true });
      // Selected for opening on its own server, where it isn't open, while
      // another server's channel with the same id is.
      decide('c-22', 'open', 'server-bootstrap');
      (state.channelRegistry as unknown as { channels: Map<string, unknown> }).channels
        .set(destinationKey({ serverId: 'other', channelId: 'c-22' }), { serverId: 'other', descriptor: { id: 'c-22', type: 'other', label: '#twenty-two' }, open: true });
      // Selected for opening, and closed since.
      decide('c-10', 'open', 'server-bootstrap');
      decide('c-10', 'closed', 'agent-tool');
      // Opened, and tuned out since: still open, its traffic held.
      decide('c-13', 'open');
      state.channelRegistry.enterTuneOut('srv', 'c-13',
        { epochId: 'e-13', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
      // One channel id on two servers: each notice is checked by its own
      // server's decision.
      decide('c-14', 'open');
      decide('c-14', 'closed', 'agent-tool', framework, 'other');
      // Selected for opening, and tuned out since: a newer decision, by the
      // agent that tuned it out, so its failed notice is left out.
      decide('c-15', 'open', 'server-bootstrap');
      state.channelRegistry.enterTuneOut('srv', 'c-15',
        { epochId: 'e-15', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
      const opened = (id: string, channels: Array<{ channelId: string; label: string }>, serverId = 'srv') => ({
        id, seq: Number(id.slice(2)), participant: 'user', forAgent: 'conversation-gone',
        content: [{ type: 'text', text: '[channels] Now open: your own message into the closed channel opened it.' }],
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId, cause: 'opened-by-delivery', channels } },
      });
      const failed = (id: string, channel: { channelId: string; label: string }) => ({
        id, seq: Number(id.slice(2)), participant: 'user', forAgent: 'conversation-gone',
        content: [{ type: 'text', text: '[channels] Not open. Your reply there went out, but opening the channel failed.' }],
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'reply-open-failed', serverId: 'srv', channel, selectedForOpening: 'server-bootstrap' } },
      });
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push(
        opened('w-7', [{ channelId: 'c-7', label: '#seven' }, { channelId: 'c-8', label: '#eight' }]),
        opened('w-8', [{ channelId: 'c-8', label: '#eight' }]),
        failed('w-9', { channelId: 'c-9', label: '#nine' }),
        failed('w-10', { channelId: 'c-10', label: '#ten' }),
        opened('w-13', [{ channelId: 'c-13', label: '#thirteen' }]),
        opened('w-14', [{ channelId: 'c-14', label: '#fourteen' }]),
        failed('w-15', { channelId: 'c-15', label: '#fifteen' }),
        opened('w-16', [{ channelId: 'c-14', label: '#fourteen' }], 'other'),
        failed('w-22', { channelId: 'c-22', label: '#twenty-two' }),
      );

      await state.flushDeferredWrites('boot-recovery');

      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('conversation-gone'));
      assert.deepEqual(told.map((m) => (m.content[0] as { text: string }).text), [
        '[channels] Now open: #seven (c-7): a message from conversation-gone into the closed channel opened it; conversation-gone has ended. ' +
          "If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
        '[channels] Now open: #thirteen (c-13): a message from conversation-gone into the closed channel opened it; conversation-gone has ended. ' +
          "If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
        '[channels] Now open: #fourteen (c-14): a message from conversation-gone into the closed channel opened it; conversation-gone has ended. ' +
          "If you don't want it, use channel_close: a channel you close stays closed until you open it with channel_open, and neither speaking there, the subscription policy nor its server's own default opens it again.",
        "[channels] Not open: #twenty-two (srv:c-22). A reply from conversation-gone went out there, but opening the channel failed; conversation-gone has ended. " +
          "It's selected for opening again, because its server lists it as open by default: the host tries again, and channel_close withdraws that.",
      ]);
      assert.deepEqual(told.map((m) => (m.metadata as { deferredWriteId?: unknown }).deferredWriteId), ['w-7', 'w-13', 'w-14', 'w-22']);
      for (const line of [
        '[channel] conversation-gone has ended, and no channel its notice said opened is decided open or tuned out now (#eight (c-8)): no one is told',
        '[channel] conversation-gone has ended, and #nine (c-9), which its notice said was not open and selected for opening, is open now or no longer decided open: no one is told',
        '[channel] conversation-gone has ended, and #ten (c-10), which its notice said was not open and selected for opening, is open now or no longer decided open: no one is told',
        '[channel] conversation-gone has ended, and #fifteen (c-15), which its notice said was not open and selected for opening, is open now or no longer decided open: no one is told',
        '[channel] conversation-gone has ended, and no channel its notice said opened is decided open or tuned out now (#fourteen (c-14)): no one is told',
      ]) assert.ok(errors.includes(line), line);
      assert.equal(state.deferredMessages.length, 0);
    });

    it('reads a stranded channel notice\'s channels from the lifecycle log at a serving boot, before there is a registry', async (t) => {
      decide('c-11', 'open');
      decide('c-12', 'open');
      decide('c-12', 'closed', 'agent-tool');
      // A failed reply's channel, selected for opening still, and one closed
      // since.
      decide('c-17', 'open', 'server-bootstrap');
      decide('c-18', 'open', 'server-bootstrap');
      decide('c-18', 'closed', 'agent-tool');
      // Opened, and tuned out since, which the log records with its params.
      decide('c-19', 'open');
      internals(framework).channelRegistry.enterTuneOut('srv', 'c-19',
        { epochId: 'e-19', cadenceSeconds: 60, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
      // One channel id on two servers, each with its own decision.
      decide('c-20', 'open');
      decide('c-20', 'closed', 'agent-tool', framework, 'other');
      await framework.stop();
      const storePath = join(tempDir, 'test.chronicle');
      const notice = (id: string, channelId: string, label: string, serverId = 'srv') => ({
        id, seq: Number(id.slice(2)), participant: 'user', forAgent: 'conversation-gone',
        content: [{ type: 'text', text: `[channels] Now open: ${label} (${channelId}): your own message into the closed channel opened it.` }],
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId, cause: 'opened-by-reply', channels: [{ channelId, label }] } },
      });
      const failed = (id: string, channelId: string, label: string) => ({
        id, seq: Number(id.slice(2)), participant: 'user', forAgent: 'conversation-gone',
        content: [{ type: 'text', text: `[channels] Not open: ${label} (${channelId}). Your reply there went out, but opening the channel failed.` }],
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'reply-open-failed', serverId: 'srv', channel: { channelId, label }, selectedForOpening: 'server-bootstrap' } },
      });
      // A resume that didn't finish its flush leaves the flag cleared and the
      // queue behind, which a serving boot lands before MCPL is brought up.
      mkdirSync(join(storePath, 'recovery'), { recursive: true });
      writeFileSync(join(storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: false }));
      writeFileSync(join(storePath, 'recovery', 'deferred-writes.json'), JSON.stringify({
        version: 1, pending: [
          notice('w-11', 'c-11', '#eleven'), notice('w-12', 'c-12', '#twelve'),
          failed('w-17', 'c-17', '#seventeen'), failed('w-18', 'c-18', '#eighteen'),
          notice('w-19', 'c-19', '#nineteen'),
          notice('w-20', 'c-20', '#twenty'), notice('w-21', 'c-20', '#twenty', 'other'),
        ],
      }));
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });

      framework = await AgentFramework.create({
        storePath,
        membrane: membrane.asMembrane(),
        agents: [
          { name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' },
          { name: 'secondary', model: 'test-model', systemPrompt: 'Secondary.' },
        ],
        modules: [],
        conversations: { templateAgent: 'primary' },
      });

      assert.equal(internals(framework).channelRegistry, null, 'the boot landed them with no registry');
      const told = framework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('conversation-gone'));
      assert.deepEqual(told.map((m) => (m.metadata as { deferredWriteId?: unknown }).deferredWriteId), ['w-11', 'w-17', 'w-19', 'w-20']);
      const texts = told.map((m) => (m.content[0] as { text: string }).text);
      assert.match(texts[0]!, /^\[channels\] Now open: #eleven \(c-11\): a message from conversation-gone into the closed channel opened it; conversation-gone has ended\./);
      assert.match(texts[1]!, /^\[channels\] Not open: #seventeen \(c-17\)\. A reply from conversation-gone went out there, but opening the channel failed; conversation-gone has ended\. It's selected for opening again/);
      assert.match(texts[2]!, /^\[channels\] Now open: #nineteen \(c-19\): a message from conversation-gone/);
      assert.match(texts[3]!, /^\[channels\] Now open: #twenty \(c-20\): a message from conversation-gone/);
      for (const line of [
        '[channel] conversation-gone has ended, and no channel its notice said opened is decided open or tuned out now (#twelve (c-12)): no one is told',
        '[channel] conversation-gone has ended, and #eighteen (c-18), which its notice said was not open and selected for opening, is open now or no longer decided open: no one is told',
        '[channel] conversation-gone has ended, and no channel its notice said opened is decided open or tuned out now (#twenty (c-20)): no one is told',
      ]) assert.ok(errors.includes(line), line);
    });

    it('passes a restored failure notice on as the same queue entry while the primary is mid-turn: it waits under its own id', async () => {
      const state = internals(framework);
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push({
        id: 'w-9', seq: 9, participant: 'user', forAgent: 'conversation-gone',
        content: [{ type: 'text', text: '[discord-send-failed] Your previous reply (12 chars) could not be delivered.' }],
        metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'no registered channel', textLen: 12 },
      });
      state.activeTurnTokens.set('primary', 1);

      await state.flushDeferredWrites('resume');

      assert.equal(state.deferredMessages.length, 1, 'one entry, not the original and a separate notice');
      const entry = state.deferredMessages[0] as unknown as { id: string; forAgent?: string; content: unknown; metadata?: Record<string, unknown> };
      assert.equal(entry.id, 'w-9');
      assert.equal(entry.forAgent, undefined, 'now the primary\'s');
      assert.equal(entry.metadata?.speaker, 'conversation-gone');
      assert.match(JSON.stringify(entry.content), /A reply by conversation-gone \(12 chars\) could not be delivered/);
    });

    it('counts a body the store shards as one notice, and the same text stored again as a notice of its own', async () => {
      const state = internals(framework) as unknown as { releasedWindow(agent: unknown, held: Set<string>): { unread: Array<{ metadata: { tag?: unknown } }> } | null };
      const agent = framework.getAgent('secondary')!;
      const cm = agent.getContextManager();
      // Shard every notice into one message per block, as a strategy's ingress
      // chunking does. The group id names the text, as context-manager's
      // chunker's does, so the same text shards under the same id each time
      // it's stored.
      (cm as unknown as { strategy: Record<string, unknown> }).strategy.chunkIngressMessage = (_participant: string, content: ContentBlock[]) =>
        content.length > 1
          ? {
            bodyGroupId: `bg-${content.map((block) => (block as { text?: string }).text).join('')}`,
            shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })),
          }
          : null;
      const notice = (tag: string, words: string) => cm.addMessage('user',
        [{ type: 'text', text: `[discord-send-failed] ${words}` }, { type: 'text', text: ' and the rest of it' }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', tag } as never);

      notice('first', 'the same words');
      notice('second', 'the same words');
      notice('third', 'other words');

      const stored = cm.getAllMessages().filter((m) => (m.metadata as { kind?: unknown } | undefined)?.kind === 'discord-send-failed');
      assert.deepEqual(stored.map((m) => m.shardIndex), [0, 1, 0, 1, 0, 1], 'each body is stored as two shards');
      assert.equal(stored[2]!.bodyGroupId, stored[0]!.bodyGroupId, 'the same text is stored again under the same group id');
      assert.deepEqual(state.releasedWindow(agent, new Set())!.unread.map((m) => m.metadata.tag), ['first', 'second', 'third']);
    });

    it('counts as read, across branches, only what an agent\'s window shares with the branch it read up to the point they part', async () => {
      const state = internals(framework) as unknown as { releasedWindow(agent: unknown, held: Set<string>): { unread: Array<{ metadata: { tag?: unknown } }> } | null };
      const agent = framework.getAgent('secondary')!;
      const cm = agent.getContextManager();
      const store = framework.getStore();
      const notice = (tag: string) => cm.getMessage(cm.addMessage('user', [{ type: 'text', text: `[discord-send-failed] ${tag}` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', tag } as never))!;
      const tags = () => state.releasedWindow(agent, new Set())!.unread.map((m) => m.metadata.tag);

      const read = notice('read');
      agent.markContextConsumed();
      // A branch made at the head shares everything the agent read.
      store.createBranch('maintained', store.currentBranch().name);
      await framework.switchBranch('maintained');
      notice('after the switch');
      assert.deepEqual(tags(), ['after the switch'], 'what it read stays read; what came after is unread');

      // A branch made before what it read: past that point, nothing on it was
      // read, though its numbers repeat the ones the agent read up to.
      store.createBranchAt('rewound', 'maintained', read.sequence - 1);
      await framework.switchBranch('rewound');
      const again = notice('on the rewound branch');
      assert.ok(again.sequence <= agent.getConsumedWatermark()!.sequence, 'numbered within what the watermark covers on its own branch');
      assert.deepEqual(tags(), ['on the rewound branch']);
    });

    it('counts as unread a notice stored on a branch after the agent read past the point where it parts from another', async () => {
      const state = internals(framework) as unknown as { releasedWindow(agent: unknown, held: Set<string>): { unread: Array<{ metadata: { tag?: unknown } }> } | null };
      const agent = framework.getAgent('secondary')!;
      const cm = agent.getContextManager();
      const store = framework.getStore();
      const notice = (tag: string) => cm.getMessage(cm.addMessage('user', [{ type: 'text', text: `[discord-send-failed] ${tag}` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', tag } as never))!;
      const tags = () => state.releasedWindow(agent, new Set())!.unread.map((m) => m.metadata.tag);

      notice('before the branch');
      const home = store.currentBranch().name;
      store.createBranch('side', home);
      await framework.switchBranch('side');
      notice('on the side branch');
      notice('also on the side branch');
      agent.markContextConsumed();
      // Back on the branch the side branch was made from: its numbers past the
      // branch point are its own, and the agent read none of them.
      await framework.switchBranch(home);
      const late = notice('stored at home after the agent read on the side branch');
      assert.ok(late.sequence <= agent.getConsumedWatermark()!.sequence, 'numbered within what the watermark covers on the side branch');
      assert.deepEqual(tags(), ['stored at home after the agent read on the side branch']);
    });

    it('counts as unread what the current branch has from a branch between it and the one the agent read on', async () => {
      const state = internals(framework) as unknown as { releasedWindow(agent: unknown, held: Set<string>): { unread: Array<{ metadata: { tag?: unknown } }> } | null };
      const agent = framework.getAgent('secondary')!;
      const cm = agent.getContextManager();
      const store = framework.getStore();
      const notice = (tag: string) => cm.getMessage(cm.addMessage('user', [{ type: 'text', text: `[discord-send-failed] ${tag}` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', tag } as never))!;
      const tags = () => state.releasedWindow(agent, new Set())!.unread.map((m) => m.metadata.tag);

      notice('read at home');
      const home = store.currentBranch().name;
      store.createBranch('between', home);
      await framework.switchBranch('between');
      notice('on the branch between');
      notice('also on the branch between');
      store.createBranch('current', 'between');
      await framework.switchBranch(home);
      for (const n of [1, 2, 3]) notice(`later at home ${n}`);
      agent.markContextConsumed();
      // The current branch parts from home where the branch between left it,
      // below its own branch point, so the agent read none of what it has
      // from the branch between, though their numbers are within what the
      // watermark covers at home.
      await framework.switchBranch('current');
      assert.deepEqual(tags(), ['on the branch between', 'also on the branch between']);
    });

    it('counts as unread, across a branch made after the agent read, what was stored after its watermark', async () => {
      const state = internals(framework) as unknown as { releasedWindow(agent: unknown, held: Set<string>): { unread: Array<{ metadata: { tag?: unknown } }> } | null };
      const agent = framework.getAgent('secondary')!;
      const cm = agent.getContextManager();
      const store = framework.getStore();
      const notice = (tag: string) => cm.getMessage(cm.addMessage('user', [{ type: 'text', text: `[discord-send-failed] ${tag}` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', tag } as never))!;
      const tags = () => state.releasedWindow(agent, new Set())!.unread.map((m) => m.metadata.tag);

      notice('read');
      agent.markContextConsumed();
      notice('stored after the watermark');
      const home = store.currentBranch().name;
      store.createBranch('later', home);
      await framework.switchBranch('later');
      assert.deepEqual(tags(), ['stored after the watermark']);
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
        (state.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'srv', channelId }), {
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
        const binding = framework.getConversationRouter()!.getBinding({ serverId: 'srv', channelId })!;
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

        if (condition === 'quiesced') {
          // The fork is disposed when its closure turn ends, quiesced or not.
          // Only its window's release waits for resume, since a write could
          // land mid-surgery: its notice is still queued, and the primary
          // hasn't been told.
          assert.equal(framework.getAgent(fork.name), null, 'disposed at once');
          assert.equal(state.deferredMessages.length, 1);
          assert.equal(state.deferredMessages[0]!.forAgent, fork.name);
          const waiting = await framework.getAgent('primary')!.getContextManager().compile();
          assert.equal(count(waiting.messages, SEND_FAILED), 0);
          await framework.resume({ force: true });
        }
        assert.equal(framework.getAgent(fork.name), null, 'the fork is disposed when its closure turn ends');
        // other-tool-cycle: a write waits only for its own target's tool
        // cycle, so neither the fork's notice nor the primary's waits for the
        // secondary's.
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
        if (condition === 'write-fails') {
          // A write the store refuses is logged; disposal still completes.
          assert.equal(count(messages, SEND_FAILED), 0);
          assert.ok(errors.some((e) => e.includes(`[deferred-flush] ${fork.name}: failed to store a queued write before release`)));
        } else {
          const noticeIndex = messages.findIndex((m) => JSON.stringify(m.content).includes(SEND_FAILED));
          assert.ok(noticeIndex > replyIndex, 'the archived failure notice follows the closure reply');
          assert.equal(count(messages, SEND_FAILED), 1);
          assert.match(JSON.stringify(messages[noticeIndex]!.content), /Your previous reply.*server said it didn't post the message/);
          // Every write of a drained entry carries its durable id (drainDeferredFor).
          const stored = archive.getAllMessages().find((m) => JSON.stringify(m.content).includes(SEND_FAILED));
          const id = (stored?.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId;
          assert.equal(typeof id, 'string');
          if (condition === 'quiesced') {
            // Still queued for the fork at its release, the notice goes on to
            // the primary as that entry, under the same id. (Otherwise it was
            // stored in the fork's window at its turn's end, and is passed on
            // from there, as a new write.)
            const passed = framework.getAgent('primary')!.getContextManager().getAllMessages()
              .find((m) => JSON.stringify(m.content).includes(`A reply by ${fork.name}`));
            assert.equal((passed?.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId, id);
          }
        }
        // The fork never reads its notice again, so the primary is told, by name.
        const primary = await framework.getAgent('primary')!.getContextManager().compile();
        const told = primary.messages.filter((m) => JSON.stringify(m.content).includes(SEND_FAILED));
        assert.equal(told.length, 1);
        assert.match(JSON.stringify(told[0]!.content),
          new RegExp(`A reply by ${fork.name} \\(${finalReply.length} chars\\) could not be delivered to #closure test \\(closure-channel\\) \\(.*server said it didn't post the message\\)\\. Nothing was posted\\. ${fork.name} has ended\\.`));
        assert.equal(membrane.calls.length, 2, 'only the initial and closure turns ran');
        assert.equal(state.pendingRequests.length, 0, 'a failed closure reply does not wake another turn');
      });
    }
  });

  describe('a run\'s notices at its tool boundaries, and its release', () => {
    let runDir: string;
    let runFramework: AgentFramework;
    let runMembrane: MockMembrane;
    let sender: SenderModule;

    beforeEach(async () => {
      runDir = mkdtempSync(join(tmpdir(), 'route-failure-runs-'));
      runMembrane = new MockMembrane();
      sender = new SenderModule();
      runFramework = await AgentFramework.create({
        storePath: join(runDir, 'test.chronicle'),
        membrane: runMembrane.asMembrane(),
        agents: [{ name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' }],
        modules: [sender],
      });
      sender.framework = runFramework;
      await internals(runFramework).initializeMcpl([]);
    });

    afterEach(async () => {
      internals(runFramework).quiesced = false;
      await runFramework.stop();
      rmSync(runDir, { recursive: true, force: true });
    });

    /** Run 'worker' once through these rounds; every round but the last ends on its tool call. */
    async function run(rounds: ContentBlock[][]) {
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      rounds.forEach((blocks, i) => runMembrane.pushResponse(createMockResponse(blocks, i < rounds.length - 1 ? 'tool_use' : undefined)));
      const done = runFramework.runEphemeralToCompletion(created.agent, created.contextManager);
      runFramework.start();
      await done;
      await runFramework.runUntilIdle();
    }

    async function archived() {
      const archive = await ContextManager.open({
        store: runFramework.getStore(), namespace: 'subagent/worker', isolate: true, strategy: new PassthroughStrategy(),
      });
      return (await archive.compile()).messages;
    }

    const injected = () => runMembrane.lastStream!.receivedToolResultOptions
      .flatMap((o) => o?.injectedMessages ?? [])
      .map((m) => JSON.stringify(m.content));

    it('passes on nothing a run read live at a tool boundary, when its stream declares it carries injected messages', async () => {
      runMembrane.supportsInjectedMessages = true;
      await run([
        [{ type: 'tool_use', id: 'p1', name: 'sender--post', input: {} }],
        [{ type: 'text', text: '>>skip_reply done' }],
      ]);

      assert.ok(injected().some((c) => c.includes(SEND_FAILED)), 'the notice reached the run\'s live stream');
      assert.equal(count(await archived(), SEND_FAILED), 1, 'and its window');
      const { messages } = await runFramework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, 'A reply by worker'), 0, 'it read it, so no one else is told');
    });

    it('passes on, by name, a notice its boundary stored but never sent, when a tool ends the turn', async () => {
      runMembrane.supportsInjectedMessages = true;
      sender.endTurnOnPost = true;
      await run([
        [{ type: 'tool_use', id: 'p1', name: 'sender--post', input: {} }],
        // Never asked for: the post's result ends the turn.
        [{ type: 'text', text: 'unused' }],
      ]);

      assert.ok(!injected().some((c) => c.includes(SEND_FAILED)), 'the turn ended before the notice was sent');
      assert.equal(count(await archived(), SEND_FAILED), 1, 'it was stored in the run\'s window');
      const { messages } = await runFramework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, 'A reply by worker'), 1, 'the run never read it, so the primary is told');
    });

    it('injects a bounced prose notice at the next tool boundary, after the prose it bounced', async () => {
      const prose = 'Worker prose with no destination.';
      await run([
        [{ type: 'text', text: prose }, { type: 'tool_use', id: 'n1', name: 'sender--noop', input: {} }],
        [{ type: 'text', text: '>>skip_reply done' }],
      ]);

      assert.ok(injected().some((c) => c.includes(BOUNCED)), 'the speaker hears it within the turn');
      const messages = await archived();
      const proseIndex = messages.findIndex((m) => m.participant === 'worker' && JSON.stringify(m.content).includes(prose));
      const noticeIndex = messages.findIndex((m) => JSON.stringify(m.content).includes(BOUNCED));
      assert.ok(proseIndex >= 0, 'the bounced prose is in its window');
      assert.ok(noticeIndex > proseIndex, 'the notice follows it there');
      assert.match(JSON.stringify(messages[noticeIndex]!.content), /\{\{unsent\}\}/, 'naming the clipboard that holds it');
      const { messages: primary } = await runFramework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(primary, BOUNCED), 0);
    });

    it('deregisters a run that ends while the host is quiesced at once, and releases its window at resume, landing what it left queued', async () => {
      // A stream that can't carry injected messages leaves the post's failure
      // notice queued for the run's turn end, and the run ends while the host
      // is quiesced, so it is still queued for the window's release at resume.
      runMembrane.supportsInjectedMessages = false;
      sender.quiesceOnCall = true;
      await run([
        [{ type: 'tool_use', id: 'p1', name: 'sender--post', input: {} }],
        [{ type: 'text', text: '>>skip_reply done' }],
      ]);
      const state = internals(runFramework);
      assert.equal(state.quiesced, true);
      assert.equal(runFramework.getAgent('worker'), null, 'deregistered at once');
      assert.ok(state.deferredMessages.some((m) => m.forAgent === 'worker'), 'its failure notice is still queued');
      const waiting = await runFramework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(waiting.messages, 'A reply by worker'), 0, 'the primary isn\'t told before resume');

      await runFramework.resume({ force: true });

      assert.equal(state.deferredMessages.length, 0);
      assert.equal(count(await archived(), SEND_FAILED), 1, 'what it left queued landed in its window');
      const { messages } = await runFramework.getAgent('primary')!.getContextManager().compile();
      assert.equal(count(messages, 'A reply by worker'), 1, 'and, still queued at the release, it goes on to the primary by name');
    });

    const queuedForTheRun = [
      {
        what: 'a failed reply',
        content: [{ type: 'text', text: `${SEND_FAILED} Your previous reply (5 chars) could not be delivered to #x (missing-channel).` }],
        metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'no registered channel', textLen: 5 },
        inRun: SEND_FAILED,
        toPrimary: 'A reply by worker',
        opened: null,
      },
      {
        what: 'a channel notice the run could act on',
        content: [{ type: 'text', text: '[channels] Now open: #seven (c-7): your own message into the closed channel opened it.' }],
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-delivery', channels: [{ channelId: 'c-7', label: '#seven' }] } },
        inRun: 'Now open: #seven',
        toPrimary: "a message from worker into the closed channel opened it; worker has ended",
        opened: 'c-7',
      },
    ];
    for (const queued of queuedForTheRun) it(`passes ${queued.what} still queued when a run ends unquiesced on to the primary as the same queue entry`, async () => {
      if (queued.opened) decide(queued.opened, 'open', 'opened-by-delivery', runFramework);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      runMembrane.streamYielding = (request) => {
        runMembrane.calls.push(request);
        return new HeldStream(released, []);
      };
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const state = internals(runFramework);
      runFramework.start();
      const done = runFramework.runEphemeralToCompletion(created.agent, created.contextManager, UNREACHED_WATCHDOG);
      const ended = done.then(() => null, (error: unknown) => error);
      for (let i = 0; i < 400 && !state.activeStreams.has('worker'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(state.activeStreams.has('worker'), 'the run\'s stream started');
      // A notice queued for the run's turn end, which the run's stall then
      // ends first.
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push({
        id: 'w-late', seq: 1_000_000, participant: 'user', forAgent: 'worker', content: queued.content, metadata: queued.metadata,
      });
      silenceRun(runFramework, 'worker');
      assert.match(String(await ended), /stalled/, 'the idle watchdog ended the run');
      release();
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

      assert.equal(state.deferredMessages.length, 0);
      const idOf = (m: { metadata?: unknown } | undefined) => (m?.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId;
      const archive = await ContextManager.open({
        store: runFramework.getStore(), namespace: 'subagent/worker', isolate: true, strategy: new PassthroughStrategy(),
      });
      const record = archive.getAllMessages().filter((m) => JSON.stringify(m.content).includes(queued.inRun));
      assert.equal(record.length, 1, 'it landed in the run\'s window');
      assert.equal(idOf(record[0]), 'w-late');
      const told = runFramework.getAgent('primary')!.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes(queued.toPrimary));
      assert.equal(told.length, 1, 'the primary is told once');
      assert.equal(idOf(told[0]), 'w-late', 'as the same entry, under its id');
    });

    it('leaves a run that ended during a surgery to its window\'s release: the surgery\'s flush doesn\'t drop its queue', async () => {
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const state = internals(runFramework) as unknown as ReturnType<typeof internals> & {
        reserveStoreForSurgery(verb: string, agentName: string): () => void;
      };
      // Not started, so the run is registered and idle when the surgery begins.
      const done = runFramework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 150 });
      state.quiesced = true;
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push({
        id: 'w-held', seq: 1_000_000, participant: 'user', forAgent: 'worker',
        content: [{ type: 'text', text: 'Written for the run while the host was quiesced.' }],
      });
      const releaseSurgery = state.reserveStoreForSurgery('test surgery', 'primary');
      await assert.rejects(done, /failed to start inference/);
      assert.equal(runFramework.getAgent('worker'), null, 'the run ended during the surgery');

      releaseSurgery();
      assert.deepEqual((state.deferredMessages as unknown as Array<{ id: string }>).map((m) => m.id), ['w-held'], 'its write waits for its window\'s release');

      await runFramework.resume({ force: true });
      assert.equal(state.deferredMessages.length, 0);
      assert.equal(count(await archived(), 'Written for the run while the host was quiesced.'), 1, 'and lands in its window at resume');
    });

    const storedUnread = [
      {
        what: 'a failed reply',
        content: [{ type: 'text' as const, text: `${SEND_FAILED} Your previous reply (5 chars) could not be delivered to #x (missing-channel).` }],
        metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'no registered channel', textLen: 5 },
        toPrimary: 'A reply by worker',
        opened: null,
      },
      {
        what: 'a channel notice the run could act on',
        content: [{ type: 'text' as const, text: '[channels] Now open: #eight (c-8): your own message into the closed channel opened it.' }],
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-reply', channels: [{ channelId: 'c-8', label: '#eight' }] } },
        toPrimary: "a message from worker into the closed channel opened it; worker has ended",
        opened: 'c-8',
      },
    ];
    for (const unread of storedUnread) it(`passes ${unread.what} a run stored unread on to the primary\'s queue when the host stops before the release it waited for`, async () => {
      if (unread.opened) decide(unread.opened, 'open', 'opened-by-reply', runFramework);
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      // Stored in its window, and never read: the run never compiled.
      created.contextManager.addMessage('user', unread.content, unread.metadata as never);
      const state = internals(runFramework) as unknown as ReturnType<typeof internals> & { releasesAfterResume: Map<string, unknown> };
      // Not started, so its startup watchdog ends it, while the host is quiesced.
      const done = runFramework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 150 });
      state.quiesced = true;
      await assert.rejects(done, /failed to start inference/);
      assert.ok(state.releasesAfterResume.has('worker'), 'its window\'s release waits for resume');

      await runFramework.stop();

      const passed = (state.deferredMessages as unknown as Array<{ forAgent?: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>)
        .filter((m) => JSON.stringify(m.content).includes(unread.toPrimary));
      assert.equal(passed.length, 1, 'queued for the primary, for resume or boot');
      assert.equal(passed[0]!.forAgent, undefined);
      assert.equal(passed[0]!.metadata?.speaker, 'worker');
    });

    it('passes a failed reply a run stored unread on to the primary\'s queue when stop()\'s sweep ends the run while the host is quiesced', async () => {
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      created.contextManager.addMessage('user',
        [{ type: 'text', text: `${SEND_FAILED} Your previous reply (5 chars) could not be delivered to #x (missing-channel).` }],
        { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'no registered channel', textLen: 5 } as never);
      const state = internals(runFramework) as unknown as ReturnType<typeof internals> & { releasesAfterResume: Map<string, unknown> };
      // Not started, and its watchdog far off: stop()'s sweep ends it, and its
      // end postpones its window's release after stop()'s first pass has run.
      const ended = runFramework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 60_000 })
        .then(() => null, (error: unknown) => error);
      state.quiesced = true;

      await runFramework.stop();

      assert.ok(await ended instanceof Error, 'stop() ended the run');
      assert.equal(state.releasesAfterResume.size, 0, 'no release is left postponed');
      const passed = (state.deferredMessages as unknown as Array<{ forAgent?: string; content: ContentBlock[]; metadata?: Record<string, unknown> }>)
        .filter((m) => JSON.stringify(m.content).includes('A reply by worker'));
      assert.equal(passed.length, 1, 'queued for the primary, for resume or boot');
      assert.equal(passed[0]!.forAgent, undefined, "the primary's");
      assert.equal(passed[0]!.metadata?.speaker, 'worker');
    });

    it('completes a release whose window can\'t be read for what it left unread: what was queued lands, logged', async (t) => {
      const errors: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      t.mock.method(created.agent, 'getConsumedWatermark', () => { throw new Error('watermark unreadable'); });
      const state = internals(runFramework);
      (state.deferredMessages as unknown as Array<Record<string, unknown>>).push({
        id: 'w-q', seq: 1_000_000, participant: 'user', forAgent: 'worker',
        content: [{ type: 'text', text: 'Queued for the run.' }],
      });

      await assert.rejects(
        runFramework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 150 }),
        /failed to start inference/,
      );

      assert.equal(state.deferredMessages.length, 0);
      assert.equal(count(await archived(), 'Queued for the run.'), 1, 'what was queued landed in its window');
      assert.ok(errors.some((e) => e.includes('[route-failure] worker: could not read its window for unread notices the primary would take')));
    });

    it('resumes past a run that ended while the host was quiesced: resume doesn\'t weigh its context', async (t) => {
      sender.quiesceOnCall = true;
      await run([
        [{ type: 'tool_use', id: 'n1', name: 'sender--noop', input: {} }],
        [{ type: 'text', text: '>>skip_reply done' }],
      ]);
      const previewed: string[] = [];
      // The run's context, were it weighed, would not fit; nothing else gives a verdict.
      t.mock.method(runFramework as unknown as { previewAgentRuntimeSettings(name: string): unknown }, 'previewAgentRuntimeSettings', (name: string) => {
        previewed.push(name);
        return name === 'worker'
          ? { available: true, effective: { fits: false, finalTokens: 2, budgetTokens: 1 } }
          : { available: false, reason: 'no_preview_support' };
      });

      await runFramework.resume();

      assert.equal(runFramework.getHostModeStatus().quiesced, false, 'resumed');
      assert.ok(!previewed.includes('worker'), 'the ended run is not weighed');
    });

    it('dispatches nothing an ended run\'s stream yields late while the host is quiesced', async (t) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held: WatchedHeldStream | undefined;
      runMembrane.streamYielding = (request) => {
        runMembrane.calls.push(request);
        // Yields nothing, cancel included, until released; then a tool call.
        // The response has no usage, which the mock would yield before it.
        const late: Partial<NormalizedResponse> = createMockResponse([{ type: 'tool_use', id: 'late-1', name: 'sender--noop', input: {} }], 'tool_use');
        delete late.usage;
        held = new WatchedHeldStream(released, [late as NormalizedResponse]);
        return held;
      };
      const calls = t.mock.method(sender, 'handleToolCall');
      const created = await runFramework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const state = internals(runFramework);
      runFramework.start();
      const done = runFramework.runEphemeralToCompletion(created.agent, created.contextManager, UNREACHED_WATCHDOG);
      const ended = done.then(() => null, (error: unknown) => error);
      for (let i = 0; i < 400 && !state.activeStreams.has('worker'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(state.activeStreams.has('worker'), 'the run\'s stream started');
      state.quiesced = true;
      silenceRun(runFramework, 'worker');
      assert.match(String(await ended), /stalled/, 'the idle watchdog ended the run');
      assert.equal(runFramework.getAgent('worker'), null, 'the ended run is deregistered at once, quiesced or not');
      assert.ok((state as unknown as { releasesAfterResume: Map<string, unknown> }).releasesAfterResume.has('worker'), 'it ended while quiesced');

      release();
      const left = await Promise.race([
        held!.finished.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);

      assert.ok(left, 'its stream was left, before the 5 s bound');
      assert.deepEqual(held!.yielded, ['tool-calls'], 'it yielded the late tool call, and nothing after it');
      assert.equal(calls.mock.callCount(), 0, 'its late tool call is not dispatched');
      await runFramework.resume({ force: true });
    });

    // Each case runs for a failed reply, and for a channel notice the run
    // could act on, which the primary takes in its place too (passesToPrimary).
    const takenInItsPlace = [
      {
        what: 'a failed reply',
        metadata: { system: true, kind: 'discord-send-failed', channelId: 'missing-channel', reason: 'no registered channel', textLen: 5 },
        text: `${SEND_FAILED} Your previous reply (5 chars) could not be delivered to missing-channel (no registered channel).`,
        inRun: 'Your previous reply (5 chars)',
        toPrimary: 'A reply by worker',
        opened: null,
      },
      {
        what: 'a channel notice the run could act on',
        metadata: { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId: 'srv', cause: 'opened-by-delivery', channels: [{ channelId: 'c-7', label: '#seven' }] } },
        text: '[channels] Now open: #seven (c-7): your own message into the closed channel opened it.',
        inRun: 'Now open: #seven',
        toPrimary: 'a message from worker into the closed channel opened it; worker has ended',
        opened: 'c-7',
      },
    ];
    for (const notice of takenInItsPlace) describe(`${notice.what} whose earlier write may have landed reaches the primary once`, () => {
      // The notice queued for the run, marked as one whose earlier write
      // threw and whose landing couldn't be read back (`landing: 'unknown'`).
      // Where that write landed, a copy under the entry's id is in the run's
      // window, as the write left it.
      type LandingState = ReturnType<typeof internals> & {
        releasesAfterResume: Map<string, unknown>;
        agents: Map<string, unknown>;
        persistDeferredWrites(): void;
        settleUnknownLandings(which: (msg: { id: string }) => boolean): void;
      };
      const state = () => internals(runFramework) as unknown as LandingState;
      // Each restart's framework, stopped before the run's directory goes.
      const restarts: AgentFramework[] = [];
      afterEach(async () => { for (const framework of restarts.splice(0)) await framework.stop(); });
      /** The primary's by-name notices in the run's place, queued for it. */
      const queuedForPrimary = (framework: AgentFramework): number =>
        count(internals(framework).deferredMessages.filter((m) => m.forAgent === undefined) as Array<{ content: unknown }>, notice.toPrimary);
      /** The primary's by-name notices in the run's place, stored or queued for it. */
      const told = (framework: AgentFramework): number =>
        count(framework.getAgent('primary')!.getContextManager().getAllMessages(), notice.toPrimary) + queuedForPrimary(framework);

      async function queued(landed: boolean) {
        const created = await runFramework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'explicit',
        });
        created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        // The channel the notice says opened is still decided open, so the primary is told of it.
        if (notice.opened) decide(notice.opened, 'open', 'opened-by-delivery', runFramework);
        if (landed) created.contextManager.addMessage('user', [{ type: 'text', text: notice.text }], { ...notice.metadata, deferredWriteId: 'w-e' } as never);
        (state().deferredMessages as unknown as Array<Record<string, unknown>>).push({
          id: 'w-e', seq: 1_000_000, participant: 'user', forAgent: 'worker',
          content: [{ type: 'text', text: notice.text }], metadata: notice.metadata, heldAt: Date.now(), landing: 'unknown',
        });
        return created;
      }

      /** Not started, so its startup watchdog ends it. */
      const ending = (created: Awaited<ReturnType<typeof queued>>) =>
        runFramework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 150 });

      /** The framework on the same store after this one stops: a restart, which replays what the persisted queue holds. */
      async function restarted(): Promise<AgentFramework> {
        await runFramework.stop();
        const framework = await AgentFramework.create({
          storePath: join(runDir, 'test.chronicle'),
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'primary', model: 'test-model', systemPrompt: 'Primary.', proseRouting: 'locus' }],
          modules: [new SenderModule()],
        });
        restarts.push(framework);
        await internals(framework).initializeMcpl([]);
        return framework;
      }

      for (const landed of [true, false]) {
        it(`once across a crash between its release's sync and its queue's rewrite (${landed ? 'its earlier write landed' : 'a control: nothing landed'})`, async (t) => {
          t.mock.method(console, 'error', () => {});
          state().deferredWritesPersisted = true;
          const created = await queued(landed);
          state().persistDeferredWrites();
          // The crash: the release's ack syncs the store, and the queue is never rewritten after it.
          state().persistDeferredWrites = () => {};
          await assert.rejects(ending(created), /failed to start inference/);
          assert.equal(told(runFramework), 1, 'told once at the release');

          const reopened = await restarted();
          assert.equal(told(reopened), 1, 'and once after the restart replays the queue');
        });

        it(`once across stop() and a restart when a quiesce postponed its release (${landed ? 'its earlier write landed' : 'a control: nothing landed'})`, async (t) => {
          t.mock.method(console, 'error', () => {});
          const created = await queued(landed);
          const done = ending(created);
          state().quiesced = true;
          // quiesce() writes the queue to its record as it sets the flag.
          state().persistDeferredWrites();
          await assert.rejects(done, /failed to start inference/);
          assert.ok(state().releasesAfterResume.has('worker'), "its window's release waits for resume");

          const reopened = await restarted();
          assert.equal(queuedForPrimary(runFramework), 1, 'stop() leaves one notice queued for the primary');
          assert.equal(told(reopened), 1);
        });
      }

      it('not at all across stop() and a restart, when a quiesce postponed its release and the run read the copy', async (t) => {
        t.mock.method(console, 'error', () => {});
        const created = await queued(true);
        created.agent.markContextConsumed();
        const done = ending(created);
        state().quiesced = true;
        state().persistDeferredWrites();
        await assert.rejects(done, /failed to start inference/);
        assert.ok(state().releasesAfterResume.has('worker'), "its window's release waits for resume");

        const reopened = await restarted();
        assert.equal(queuedForPrimary(runFramework), 0, 'stop() leaves nothing queued for the primary');
        assert.equal(told(reopened), 0);
      });

      it("as boot would, read or not, a pending one and an un-acked one, when stop()'s pass for a release the quiesce postponed throws", async (t) => {
        t.mock.method(console, 'error', () => {});
        const created = await queued(true);
        created.agent.markContextConsumed();
        const done = ending(created);
        for (let i = 0; i < 400 && !state().agents.has('worker'); i++) await new Promise((r) => setTimeout(r, 5));
        state().settleUnknownLandings((m) => m.id === 'w-e');
        assert.deepEqual((state().unackedDeferredWrites as Array<{ id: string }>).map((m) => m.id), ['w-e']);
        // A second notice for the run, still pending, which never landed.
        (state().deferredMessages as unknown as Array<Record<string, unknown>>).push({
          id: 'w-f', seq: 1_000_001, participant: 'user', forAgent: 'worker',
          content: [{ type: 'text', text: notice.text }], metadata: notice.metadata, heldAt: Date.now(),
        });
        // Un-acked notices of other agents', the primary's own and another
        // run's, which the run's fallback mustn't take as its own.
        (state().unackedDeferredWrites as unknown as Array<Record<string, unknown>>).push(
          { id: 'w-p', seq: 999_998, participant: 'user', content: [{ type: 'text', text: notice.text }], metadata: notice.metadata, heldAt: Date.now() },
          { id: 'w-o', seq: 999_999, participant: 'user', forAgent: 'other', content: [{ type: 'text', text: notice.text }], metadata: notice.metadata, heldAt: Date.now() },
        );
        state().quiesced = true;
        state().persistDeferredWrites();
        await assert.rejects(done, /failed to start inference/);
        assert.ok(state().releasesAfterResume.has('worker'), "its window's release waits for resume");
        // stop()'s first ack fails to sync, so the un-acked entry is still
        // there when the pass for postponed releases runs, and throws.
        const store = runFramework.getStore();
        const sync = store.sync.bind(store);
        let failNext = true;
        t.mock.method(store, 'sync', () => {
          if (failNext) { failNext = false; throw new Error('sync failed'); }
          return sync();
        });
        t.mock.method(state() as unknown as { passOnFromReleasedWindow(): unknown }, 'passOnFromReleasedWindow', () => { throw new Error('pass failed'); });

        await assert.rejects(runFramework.stop(), /pass failed/);
        assert.equal(told(runFramework), 2, 'both are queued for the primary, though the run read the landed one');
        assert.deepEqual(
          (state().deferredMessages as Array<{ id: string }>).map((m) => m.id).filter((id) => id === 'w-p' || id === 'w-o'), [],
          "the primary's and the other run's un-acked notices, which landed, aren't queued again",
        );
      });

      it("passes on only the released run's own un-acked entries, not another agent's", async (t) => {
        t.mock.method(console, 'error', () => {});
        const created = await queued(false);
        // Un-acked notices of other agents', the primary's own and another
        // run's: written to their windows, their acks still to come.
        (state().unackedDeferredWrites as unknown as Array<Record<string, unknown>>).push(
          { id: 'w-p', seq: 999_998, participant: 'user', content: [{ type: 'text', text: notice.text }], metadata: notice.metadata, heldAt: Date.now() },
          { id: 'w-o', seq: 999_999, participant: 'user', forAgent: 'other', content: [{ type: 'text', text: notice.text }], metadata: notice.metadata, heldAt: Date.now() },
        );
        await assert.rejects(ending(created), /failed to start inference/);
        assert.equal(told(runFramework), 1, "told once, of the run's own notice");
      });

      it('once, by its own id, when its earlier write landed and the run\'s window can\'t be read', async (t) => {
        t.mock.method(console, 'error', () => {});
        const created = await queued(true);
        t.mock.method(created.contextManager, 'getAllMessages', () => { throw new Error('window unreadable'); });
        await assert.rejects(ending(created), /failed to start inference/);
        const notices = runFramework.getAgent('primary')!.getContextManager().getAllMessages()
          .filter((m) => JSON.stringify(m.content).includes(notice.toPrimary));
        assert.deepEqual(notices.map((m) => (m.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId), ['w-e']);
      });

      for (const read of [false, true]) {
        it(`${read ? 'not at all, where the run read the copy' : 'once'}, stored once, when its store can't be searched and the window's read finds the copy`, async (t) => {
          t.mock.method(console, 'error', () => {});
          const created = await queued(true);
          if (read) created.agent.markContextConsumed();
          t.mock.method(created.contextManager, 'queryMessages', () => { throw new Error('search failed'); });
          await assert.rejects(ending(created), /failed to start inference/);
          assert.equal(told(runFramework), read ? 0 : 1);
          assert.equal(count(await archived(), notice.inRun), 1, 'not stored a second time');
        });
      }

      it("once across a crash between its release's sync and its queue's rewrite, when a lookup found its earlier write landed and it waits for an ack", async (t) => {
        t.mock.method(console, 'error', () => {});
        state().deferredWritesPersisted = true;
        const created = await queued(true);
        const done = ending(created);
        for (let i = 0; i < 400 && !state().agents.has('worker'); i++) await new Promise((r) => setTimeout(r, 5));
        // Found by a path that reads held writes (settleFound): un-acked until the next ack.
        state().settleUnknownLandings((m) => m.id === 'w-e');
        assert.deepEqual((state().unackedDeferredWrites as Array<{ id: string }>).map((m) => m.id), ['w-e']);
        state().persistDeferredWrites();
        // The crash: nothing rewrites the queue after this.
        state().persistDeferredWrites = () => {};
        await assert.rejects(done, /failed to start inference/);
        assert.equal(told(runFramework), 1, 'told once at the release');
        assert.deepEqual(state().unackedDeferredWrites, [], 'and acked there');

        const reopened = await restarted();
        assert.equal(told(reopened), 1, 'and once after the restart replays the queue');
      });

      it("once across stop() and a restart when a quiesce postponed its release and it's still un-acked there (a control)", async (t) => {
        t.mock.method(console, 'error', () => {});
        const created = await queued(true);
        const done = ending(created);
        for (let i = 0; i < 400 && !state().agents.has('worker'); i++) await new Promise((r) => setTimeout(r, 5));
        state().settleUnknownLandings((m) => m.id === 'w-e');
        assert.deepEqual((state().unackedDeferredWrites as Array<{ id: string }>).map((m) => m.id), ['w-e']);
        // A write queued for the primary, so stop()'s last flush acks what's un-acked.
        (state().deferredMessages as unknown as Array<Record<string, unknown>>).push({
          id: 'w-p', seq: 1, participant: 'user', content: [{ type: 'text', text: 'an ordinary write' }], heldAt: Date.now(),
        });
        state().quiesced = true;
        state().persistDeferredWrites();
        await assert.rejects(done, /failed to start inference/);
        assert.ok(state().releasesAfterResume.has('worker'), "its window's release waits for resume");
        // stop()'s first ack fails to sync, so the entry is still un-acked at
        // the pass for postponed releases, and the last flush's ack takes it.
        const store = runFramework.getStore();
        const sync = store.sync.bind(store);
        let failNext = true;
        t.mock.method(store, 'sync', () => {
          if (failNext) { failNext = false; throw new Error('sync failed'); }
          return sync();
        });

        const reopened = await restarted();
        assert.equal(queuedForPrimary(runFramework), 1, 'stop() leaves one notice queued for the primary');
        assert.equal(told(reopened), 1);
      });
    });
  });
});
