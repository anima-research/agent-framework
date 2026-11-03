/**
 * Integration tests for per-channel conversation routing: incoming MCPL
 * channel messages spawn/route to fork agents instead of the primary
 * conversation when FrameworkConfig.conversations is set.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent, ConversationRouterConfig, TraceEvent, Module, ModuleContext, ToolCall, ToolResult } from '../src/index.js';
import { Membrane, OpenAIResponsesAPIAdapter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import type { EventGate } from '../src/gate/event-gate.js';
import { gateToolCalls } from './helpers/gate-tool-calls.js';
import { forceExpiry } from './helpers/force-expiry.js';

/** The name the router gives a channel's fork, for the `srv` server every
 *  event here comes from. */
const forkName = (channelId: string, generation: number) => forkAgentName('conversation', 'srv', channelId, generation);

function incomingEvent(overrides: {
  channelId: string;
  serverId?: string;
  text: string;
  mentioned?: boolean;
  channelType?: string;
  messageId?: string;
}): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: overrides.serverId ?? 'srv',
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

/** The store throws when asked to remove this agent's turn checkpoints. */
function failCheckpointRemoval(framework: AgentFramework, agentName: string): void {
  const store = framework.getStore();
  const treeRemove = store.treeRemove.bind(store);
  (store as unknown as { treeRemove: typeof treeRemove }).treeRemove = (treeId, key) => {
    if (treeId === 'framework/turn-checkpoints/tree' && key === agentName) throw new Error('injected checkpoint store failure');
    return treeRemove(treeId, key);
  };
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
      assert.ok(framework.getAgent(forkName('slack:D1', 1)), 'DM fork spawned');
      assert.ok(framework.getAgent(forkName('slack:C1', 1)), 'channel-mention fork spawned');
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

    const fork = framework.getAgent(forkName('slack:D1', 1));
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
    assert.equal(router.getBinding({ serverId: 'srv', channelId: 'slack:D1' })?.agentName, forkName('slack:D1', 1));

    await framework.stop();
  });

  it("two servers' channels with one id each get a fork of their own", async () => {
    // Channel ids are unique only within one MCPL server's connection. The
    // mock hands every queued response to the next stream, so each wake gets
    // its own response, queued just before it.
    const framework = await makeFramework();
    const spawned: Array<{ serverId?: string; channelId?: string }> = [];
    framework.onTrace((e) => {
      const t = e as { type: string; serverId?: string; channelId?: string };
      if (t.type === 'mcpl:conversation-spawned') spawned.push({ serverId: t.serverId, channelId: t.channelId });
    });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'one' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D1', text: 'from srv', channelType: 'im' }));
    await framework.runUntilIdle();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'two' }]));
    framework.pushEvent(incomingEvent({ serverId: 'other', channelId: 'slack:D1', text: 'from other', channelType: 'im' }));
    await framework.runUntilIdle();

    const router = framework.getConversationRouter()!;
    assert.equal(router.getBinding({ serverId: 'srv', channelId: 'slack:D1' })?.agentName, forkName('slack:D1', 1));
    const otherName = router.getBinding({ serverId: 'other', channelId: 'slack:D1' })?.agentName;
    assert.ok(otherName && otherName !== forkName('slack:D1', 1), `the other server's channel has a fork of its own: ${otherName}`);
    assert.deepEqual(router.channelForAgent(forkName('slack:D1', 1)), { serverId: 'srv', channelId: 'slack:D1' });
    const otherFork = framework.getAgent(otherName)!;
    assert.ok(otherFork, "the other server's fork is registered");
    const { messages } = await otherFork.getContextManager().compile();
    assert.ok(messages.some((m) => JSON.stringify(m.content).includes('from other')), "the other server's message reaches its own fork");
    assert.ok(!messages.some((m) => JSON.stringify(m.content).includes('from srv')), "and not srv's");
    // Each spawned fork's home keeps its server, which its channel tools and
    // speech go to (shared-channel-id's fork tests, over recording servers).
    const homes = (framework as unknown as { registry: { homeChannel(name: string): unknown } }).registry;
    assert.deepEqual(homes.homeChannel(forkName('slack:D1', 1)), { serverId: 'srv', channelId: 'slack:D1' });
    assert.deepEqual(homes.homeChannel(otherFork.name), { serverId: 'other', channelId: 'slack:D1' });
    assert.deepEqual(spawned, [{ serverId: 'srv', channelId: 'slack:D1' }, { serverId: 'other', channelId: 'slack:D1' }],
      'each spawn is traced with its server');
    await framework.stop();
  });

  it('channel message without mention is dropped; mention spawns', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'On it.' }]));
    const framework = await makeFramework();
    const unrouted: Array<string | undefined> = [];
    framework.onTrace((e) => {
      const t = e as { type: string; serverId?: string };
      if (t.type === 'mcpl:conversation-unrouted') unrouted.push(t.serverId);
    });

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'just chatting' }));
    await framework.runUntilIdle();
    assert.equal(framework.getAgent(forkName('slack:C1', 1)), null, 'no fork without mention');
    assert.equal(membrane.calls.length, 0, 'no inference for unrouted messages');
    assert.deepEqual(unrouted, ['srv'], "the unrouted trace names the message's server");

    framework.pushEvent(incomingEvent({ channelId: 'slack:C1', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent(forkName('slack:C1', 1)), 'mention spawns fork');

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

    const fork = framework.getAgent(forkName('slack:C1', 1))!;
    const { messages } = await fork.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('ambient detail')),
      'ambient message should land in fork context',
    );
    assert.equal(membrane.calls.length, callsAfterSpawn, 'ambient message must not trigger inference');

    await framework.stop();
  });

  /** Spawn the fork for `slack:D3`, and return what its namespace was seeded
   *  with and the `[conversation]` lines the spawn logged. */
  async function seedOf(framework: AgentFramework) {
    const log = mock.method(console, 'log', () => {});
    let lines: string[];
    try {
      framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      lines = log.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.startsWith('[conversation]'));
    } finally {
      log.mock.restore();
    }
    const seeded = framework.getAgent(forkName('slack:D3', 1))!.getContextManager().getAllMessages();
    return { seeded, lines };
  }

  /** The line a spawn logs for a seed that left something out. */
  function seedLine(thinking: number, calls: number, results: number, notices = 0, injections = 0): string {
    return `[conversation] ${forkName('slack:D3', 1)}: seeded from trunk without ${injections} stored context injection(s), ` +
      `${thinking} thinking block(s), ` +
      `${notices} channel or by-name notice(s), ${calls} unanswered tool call(s) and ${results} orphaned tool result(s)`;
  }

  it("a fork's seed leaves out the trunk's stored context injections, as it had none before they were stored, and says so", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!;
    trunk.getContextManager().addMessage('user', [{ type: 'text', text: 'HANDBOOK: always check the logs first.' }]);
    // A speaker whose name looks like an injection's participant is conversation, and stays.
    trunk.getContextManager().addMessage('system_context:visitor', [{ type: 'text', text: 'VISITOR: hello from outside.' }]);
    const injection = { namespace: 'lessons', position: 'afterUser' as const, content: [{ type: 'text' as const, text: 'TRUNK-LESSON' }] };
    (framework as unknown as {
      storeInjections(agent: unknown, injections: unknown[]): unknown[] | undefined;
    }).storeInjections(trunk, [injection]);
    assert.ok(trunk.getContextManager().getAllMessages().some((m) => JSON.stringify(m.content).includes('TRUNK-LESSON')), 'the premise: the trunk holds it');

    const { seeded, lines } = await seedOf(framework);
    assert.ok(seeded.some((m) => JSON.stringify(m.content).includes('HANDBOOK')), 'the fork inherits the trunk\'s conversation');
    assert.ok(!seeded.some((m) => JSON.stringify(m.content).includes('TRUNK-LESSON')), 'and not its stored injection');
    assert.ok(seeded.some((m) => JSON.stringify(m.content).includes('VISITOR')), 'a speaker named like one is kept: the seed goes by the mark, not the name');
    assert.deepEqual(lines, [seedLine(0, 0, 0, 0, 1)]);
  });

  it('fork inherits the template context, and a seed that leaves nothing out logs nothing', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();

    // Seed the trunk (primary agent) with handbook-like content.
    framework.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK: always check the logs first.' },
    ]);

    const { seeded, lines } = await seedOf(framework);
    assert.ok(
      seeded.some((m) => JSON.stringify(m.content).includes('HANDBOOK')),
      'fork should inherit trunk context',
    );
    assert.deepEqual(lines, [], 'a seed with nothing left out logs no line');

    await framework.stop();
  });

  it("a fork's seed is a dry run, and carries none of the template's thinking", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!.getContextManager();
    trunk.addMessage('user', [{ type: 'text', text: 'HANDBOOK: always check the logs first.' }]);
    trunk.addMessage('trunk', [
      { type: 'thinking', thinking: 'minted under the trunk\'s prefix', signature: 'sig-trunk' },
      { type: 'text', text: 'Checked the logs.' },
    ] as never);
    trunk.addMessage('trunk', [{ type: 'redacted_thinking', data: 'opaque' }] as never);

    // Every compile on any context manager during the spawn, by instance.
    const proto = (trunk.constructor as { prototype: { compile: (...args: unknown[]) => unknown } }).prototype;
    const original = proto.compile;
    const compiles: Array<{ cm: unknown; dry: boolean }> = [];
    proto.compile = function (this: unknown, ...args: unknown[]) {
      compiles.push({ cm: this, dry: (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true });
      return original.apply(this, args);
    };
    let seed: Awaited<ReturnType<typeof seedOf>>;
    try {
      seed = await seedOf(framework);
    } finally {
      proto.compile = original;
    }
    const { seeded, lines } = seed;

    const fork = framework.getAgent(forkName('slack:D3', 1))!.getContextManager();
    const onTrunk = compiles.filter((c) => c.cm === trunk);
    assert.ok(onTrunk.length >= 1, 'the seed compiled the template');
    assert.ok(onTrunk.every((c) => c.dry), "the template's compiles during the spawn are dry runs");
    assert.equal(compiles.find((c) => c.cm === fork)?.dry, true, "the new namespace's emptiness check is a dry run");

    const types = seeded.flatMap((m) => m.content.map((b) => b.type));
    assert.ok(!types.includes('thinking') && !types.includes('redacted_thinking'), `no thinking in the seed: ${types}`);
    const texts = seeded.map((m) => JSON.stringify(m.content));
    assert.ok(texts.some((t) => t.includes('HANDBOOK')) && texts.some((t) => t.includes('Checked the logs.')));
    assert.ok(seeded.some((m) => m.participant === forkName('slack:D3', 1)
      && JSON.stringify(m.content).includes('Checked the logs.')), "the reply keeps its text, under the fork's name");
    assert.ok(seeded.every((m) => m.content.length > 0), 'the thinking-only message is left out, not stored empty');
    assert.deepEqual(lines, [seedLine(2, 0, 0)], 'one line counts what the seed left out');

    await framework.stop();
  });

  it("a seed that ends on a completed tool round keeps the round, without its thinking", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!.getContextManager();
    trunk.addMessage('user', [{ type: 'text', text: 'check the logs' }]);
    trunk.addMessage('trunk', [
      { type: 'thinking', thinking: 'the logs first', signature: 'sig-round' },
      { type: 'tool_use', id: 'toolu_logs', name: 'read_logs', input: {} },
    ] as never);
    trunk.addMessage('user', [{ type: 'tool_result', toolUseId: 'toolu_logs', content: 'all quiet' }] as never);

    const { seeded, lines } = await seedOf(framework);
    const contents = seeded.map((m) => m.content);
    const round = contents.findIndex((c) => c.some((b) => b.type === 'tool_use'));
    assert.ok(round >= 0, 'the round is in the seed');
    assert.deepEqual(contents[round]!.map((b) => b.type), ['tool_use'], 'its call stays, its thinking goes');
    assert.equal(seeded[round]!.participant, forkName('slack:D3', 1));
    assert.deepEqual(contents[round + 1]!.map((b) => b.type), ['tool_result'], 'its result follows it');
    assert.deepEqual(lines, [seedLine(1, 0, 0)]);
    await framework.stop();
  });

  it("a seed's unanswered call gives way to a placeholder, and the seed ends on neither it nor a thinking-only row", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!.getContextManager();
    trunk.addMessage('user', [{ type: 'text', text: 'check the logs' }]);
    trunk.addMessage('trunk', [{ type: 'text', text: 'Looking.' }]);
    // A tool round's assistant row, stored before its results (the spawn can
    // land between the two when the coalescer spawns outside the event loop),
    // and a thinking-only row after it.
    trunk.addMessage('trunk', [
      { type: 'thinking', thinking: 'mid-round', signature: 'sig-mid' },
      { type: 'tool_use', id: 'toolu_pending', name: 'read_logs', input: {} },
    ] as never);
    trunk.addMessage('trunk', [{ type: 'thinking', thinking: 'still thinking', signature: 'sig-after' }] as never);

    const { seeded, lines } = await seedOf(framework);
    const types = seeded.flatMap((m) => m.content.map((b) => b.type));
    assert.ok(!types.includes('tool_use') && !types.includes('thinking'), `no unanswered call or thinking in the seed: ${types}`);
    // The seed is everything before the fork's own first message ('hi',
    // stored as the model reads it: under its author's name).
    const firstOwn = seeded.findIndex((m) => JSON.stringify(m.content).includes('"alice: hi"'));
    assert.ok(firstOwn > 1, 'the incoming message follows the seed');
    // The thinking goes first, so the round's row holds only its unanswered
    // call, which the pairing pass replaces with its placeholder.
    const last = seeded[firstOwn - 1]!;
    assert.deepEqual(last.content.map((b) => b.type), ['text']);
    assert.ok(JSON.stringify(last.content).includes('[tool call omitted]'), `the seed ends on the placeholder: ${JSON.stringify(last.content)}`);
    assert.equal(last.participant, forkName('slack:D3', 1));
    assert.ok(JSON.stringify(seeded[firstOwn - 2]!.content).includes('Looking.'), 'the exchange before the round stays');
    assert.deepEqual(lines, [seedLine(2, 1, 0)]);
    await framework.stop();
  });

  it("a seed keeps a partly answered round's answered call and drops the other, drops an orphaned result and a trailing unanswered call, and keeps the text beside each", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!.getContextManager();
    // A result whose call isn't in the history (as where a window starts
    // after the call), beside the user's text.
    trunk.addMessage('user', [
      { type: 'tool_result', toolUseId: 'toolu_gone', content: 'stale' },
      { type: 'text', text: 'check both' },
    ] as never);
    // A parallel round with one of its two calls answered.
    trunk.addMessage('trunk', [
      { type: 'text', text: 'Checking both.' },
      { type: 'tool_use', id: 'toolu_a', name: 'read_logs', input: {} },
      { type: 'tool_use', id: 'toolu_b', name: 'read_config', input: {} },
    ] as never);
    trunk.addMessage('user', [{ type: 'tool_result', toolUseId: 'toolu_a', content: 'all quiet' }] as never);
    // The next round's row, stored before its result: thinking, text and a call.
    trunk.addMessage('trunk', [
      { type: 'thinking', thinking: 'the config next', signature: 'sig-next' },
      { type: 'text', text: 'And the config.' },
      { type: 'tool_use', id: 'toolu_c', name: 'read_config', input: {} },
    ] as never);

    const { seeded, lines } = await seedOf(framework);
    const blocks = seeded.flatMap((m) => m.content) as Array<{ type: string; id?: string; toolUseId?: string }>;
    assert.deepEqual(blocks.filter((b) => b.type === 'tool_use').map((b) => b.id), ['toolu_a'], 'the answered call stays, the unanswered ones go');
    assert.deepEqual(blocks.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId), ['toolu_a'], 'its result stays, the orphaned one goes');
    const round = seeded.find((m) => m.content.some((b) => b.type === 'tool_use'))!;
    assert.deepEqual(round.content.map((b) => b.type), ['text', 'tool_use'], "the round's text stays beside its answered call");
    assert.ok(seeded.some((m) => JSON.stringify(m.content).includes('check both')), "the user's text stays beside the orphaned result");
    const trailing = seeded.find((m) => JSON.stringify(m.content).includes('And the config.'))!;
    assert.deepEqual(trailing.content.map((b) => b.type), ['text'], "the trailing row keeps its text, without its thinking or its unanswered call");
    assert.deepEqual(lines, [seedLine(1, 2, 1)]);
    await framework.stop();
  });

  /** A Responses reply as membrane stores it: `output` through membrane's own
   *  Responses adapter and its conversion to content blocks, with the HTTP
   *  call stubbed. */
  async function storedResponsesReply(output: Array<Record<string, unknown>>): Promise<ContentBlock[]> {
    const completed = {
      type: 'response.completed',
      response: { id: 'resp_seed', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(`data: ${JSON.stringify(completed)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
    try {
      const responses = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'test' }), {
        formatter: new OpenAIResponsesFormatter(),
      });
      const response = await responses.stream({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'what changed?' }] }],
        config: { model: 'gpt-test', maxTokens: 100 },
        tools: [{ name: 'read_config', description: 'Read the config.', inputSchema: { type: 'object', properties: {} } }],
      } as never);
      return (response as { content: ContentBlock[] }).content;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("a Responses seed replays no item paired with the reasoning it left out; opaque carriers stay whole", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!.getContextManager();
    trunk.addMessage('user', [{ type: 'text', text: 'what changed?' }]);
    // A reply holding a compaction, a reasoning item, a hosted web search, a
    // message and a function call, as membrane stores it.
    trunk.addMessage('trunk', await storedResponsesReply([
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'earlier history' },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'config' } },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The config.' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_config', arguments: '{}', status: 'completed' },
    ]));
    trunk.addMessage('user', [{ type: 'tool_result', toolUseId: 'call_1', content: 'ok' }] as never);
    // A reply with no reasoning item: nothing it was paired with is left out,
    // so it replays as it was.
    trunk.addMessage('trunk', await storedResponsesReply([
      { type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Read it.' }] },
    ]));
    // An Anthropic reply in the same history: its thinking carries no raw item.
    trunk.addMessage('trunk', [
      { type: 'thinking', thinking: 'plain', signature: 'sig-plain' },
      { type: 'text', text: 'Done.' },
    ] as never);

    const { seeded } = await seedOf(framework);
    const items = new OpenAIResponsesFormatter().buildMessages(
      seeded.map((m) => ({ participant: m.participant, content: m.content })),
      { participantMode: 'simple', assistantParticipant: forkName('slack:D3', 1), humanParticipant: 'user', systemPrompt: 'fork' } as never,
    ).messages as unknown as Array<Record<string, unknown>>;
    const ids = items.map((item) => item.id).filter((id) => id !== undefined);
    assert.deepEqual(ids, ['cmp_1', 'ws_1', 'msg_2'], `only the opaque carriers and the unpaired reply replay by id: ${JSON.stringify(items)}`);
    assert.ok(!items.some((item) => item.type === 'reasoning'), 'the reasoning item is left out');
    assert.ok(items.some((item) => item.type === 'function_call' && item.call_id === 'call_1'), 'the call renders from its fields');
    assert.ok(items.some((item) => item.type === 'message' && JSON.stringify(item.content).includes('The config.')), 'the text renders from its fields');
    const plain = seeded.find((m) => JSON.stringify(m.content).includes('Done.'))!;
    assert.deepEqual(plain.content.map((b) => b.type), ['text'], "an Anthropic reply loses only its thinking");
    await framework.stop();
  });

  it("a fork's seed leaves out the trunk's channel notices and its by-name notices, whichever build stored them, and keeps the rest", async () => {
    // A stream takes every response queued when it starts, so each fork's
    // turn gets its response just before that fork spawns.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeFramework();
    const trunk = framework.getAgent('trunk')!.getContextManager();
    trunk.addMessage('user', [{ type: 'text', text: 'HANDBOOK: always check the logs first.' }]);
    // Not a system notice, so its keys mark nothing.
    trunk.addMessage('user', [{ type: 'text', text: 'MODULE NOTE: from the ops board.' }], { speaker: 'board', kind: 'channel-notice' });
    // A live fork, away from its home in the reply notice below.
    framework.pushEvent(incomingEvent({ channelId: 'slack:D1', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const live = forkName('slack:D1', 1);
    assert.ok(framework.getAgent(live), 'the D1 fork is live');
    const ended = forkName('slack:D9', 1); // never registered, as an agent that has ended
    const internals = framework as unknown as {
      passNoticeToPrimary(speaker: string, metadata: Record<string, unknown>): void;
      recordChannelAutoOpenNotice(agentName: string | undefined, serverId: string, channels: Array<{ channelId: string; label?: string }>, cause: string): void;
      recordReplyOpenFailedNotice(agentName: string | undefined, serverId: string, channel: { channelId: string; label?: string }, selected?: string): void;
    };
    const quiet = mock.method(console, 'error', () => {});
    try {
      internals.passNoticeToPrimary(ended, {
        system: true, kind: 'discord-send-failed', channelId: 'slack:D9', reason: 'rate limited', textLen: 42, outcome: 'failed',
      });
      internals.recordChannelAutoOpenNotice(ended, 'srv', [{ channelId: 'slack:D9', label: '@dora' }], 'opened-by-reply');
      internals.recordReplyOpenFailedNotice(ended, 'srv', { channelId: 'slack:D8', label: '@erin' }, 'subscription-policy');
      internals.recordReplyOpenFailedNotice(live, 'srv', { channelId: 'slack:D2', label: '@carol' }, 'subscription-policy');
      internals.recordChannelAutoOpenNotice(undefined, 'srv', [{ channelId: 'slack:D7', label: '@frank' }], 'subscription-policy');
      // The trunk's own open: its message into a closed channel opened it.
      internals.recordChannelAutoOpenNotice('trunk', 'srv', [{ channelId: 'slack:C1', label: '#general' }], 'opened-by-reply');
      // A policy admission as 0.22.3 and 0.22.4 worded and stored it.
      trunk.addMessage('user', [{
        type: 'text', text: "[channels] Now open: @gail (slack:D6) — your subscription policy just admitted it. What an open channel delivers to you depends on its server. If you don't want it, use channel_close — your choice sticks; neither policy nor a later send will silently reopen it.",
      }], { system: true, kind: 'channel-notice' });
      // The trunk's own failed reply, which onRouteFailure stores in this shape.
      trunk.addMessage('user', [{
        type: 'text', text: '[discord-send-failed] Your previous reply (10 chars) could not be delivered to slack:C1 (rate limited). Nothing was posted; it is saved in your archive.',
      }], { system: true, kind: 'discord-send-failed', channelId: 'slack:C1', reason: 'rate limited', textLen: 10 });
    } finally {
      quiet.mock.restore();
    }
    const held: Array<[string, RegExp]> = [
      ["an ended fork's failed reply", /A reply by conversation-slack-D9-g1-\w+ \(42 chars\) could not be delivered to slack:D9/],
      ['a channel its reply opened', /Now open: @dora \(slack:D9\): a message from conversation-slack-D9-g1-\w+ into the closed channel opened it/],
      ["a channel its reply couldn't open", /Not open: @erin \(slack:D8\)\. A reply from conversation-slack-D9-g1-\w+ went out there/],
      ["a channel a live fork's reply couldn't open, which it can't close", /Not open: @carol \(slack:D2\)\. A reply from your fork in slack:D1, named conversation-slack-D1-g1-\w+, went out there/],
      ['a policy admission', /Selected for opening by subscription policy: @frank \(slack:D7\)/],
      ["the trunk's own open", /Now open: #general \(slack:C1\): your own message into the closed channel opened it/],
      ["a policy admission in 0.22.4's words", /Now open: @gail \(slack:D6\) — your subscription policy just admitted it/],
    ];
    const kept = ['HANDBOOK', 'MODULE NOTE', 'Your previous reply (10 chars) could not be delivered to slack:C1', 'MY PLAN'];
    const trunkTexts = trunk.getAllMessages().map((m) => JSON.stringify(m.content));
    for (const [row, pattern] of held) {
      assert.equal(trunkTexts.filter((t) => pattern.test(t)).length, 1, `the trunk holds ${row}`);
    }
    // A reply of the trunk's own that repeats a notice word for word loses
    // that block, and keeps the rest.
    const admission = trunk.getAllMessages().flatMap((m) => m.content)
      .find((b) => b.type === 'text' && b.text.includes('Selected for opening by subscription policy: @frank')) as { text: string };
    trunk.addMessage('trunk', [{ type: 'text', text: admission.text }, { type: 'text', text: 'MY PLAN: answer the ops board first.' }]);

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const { seeded, lines } = await seedOf(framework);
    const seedTexts = seeded.map((m) => JSON.stringify(m.content));
    for (const [row, pattern] of held) {
      assert.ok(!seedTexts.some((t) => pattern.test(t)), `the seed leaves out ${row}`);
    }
    for (const text of kept) assert.ok(seedTexts.some((t) => t.includes(text)), `the seed keeps ${text}`);
    assert.ok(seeded.every((m) => m.content.length > 0), 'no message is stored empty');
    assert.deepEqual(lines, [seedLine(0, 0, 0, held.length + 1)], 'the line counts the notices left out, and the repeat');
    const after = trunk.getAllMessages().map((m) => JSON.stringify(m.content));
    for (const [row, pattern] of held) assert.ok(after.some((t) => pattern.test(t)), `the trunk keeps ${row}`);

    // The ended fork's own channel spawns its next generation from the trunk too.
    framework.getConversationRouter()!.hydrateGenerations({ 'slack:D9': 1 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'back again', channelType: 'im' }));
    await framework.runUntilIdle();
    const next = framework.getAgent(forkName('slack:D9', 2))!.getContextManager().getAllMessages()
      .map((m) => JSON.stringify(m.content));
    assert.ok(next.some((t) => t.includes('HANDBOOK')), "the channel's next fork is seeded from the trunk");
    for (const [row, pattern] of held) assert.ok(!next.some((t) => pattern.test(t)), `the channel's next fork leaves out ${row}`);
    await framework.stop();
  });

  it("a fork whose namespace already holds history isn't seeded again", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const fw1 = await makeFramework({}, 'reseed.chronicle');
    fw1.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK-V1: always check the logs first.' },
    ]);
    fw1.pushEvent(incomingEvent({ channelId: 'slack:D8', text: 'case one', channelType: 'im' }));
    await fw1.runUntilIdle();
    assert.ok(fw1.getAgent(forkName('slack:D8', 1)), 'first engagement spawns g1');
    await fw1.stop();

    // Restart with the generation counters lost, so the next engagement
    // proposes g1 again, and its namespace already holds g1's history.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'again' }]));
    const fw2 = await makeFramework({}, 'reseed.chronicle');
    (fw2.getConversationRouter() as unknown as { generations: Map<string, number> }).generations.clear();
    fw2.pushEvent(incomingEvent({ channelId: 'slack:D8', text: 'case two', channelType: 'im' }));
    await fw2.runUntilIdle();

    const g1 = fw2.getAgent(forkName('slack:D8', 1));
    assert.ok(g1, 'the lost counters propose g1 again');
    const contents = g1!.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
    assert.equal(contents.filter((c) => c.includes('HANDBOOK-V1')).length, 1, 'no second template copy on its history');
    assert.ok(contents.some((c) => c.includes('case one')), 'its own history stays');
    await fw2.stop();
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
      const binding = router.getBinding({ serverId: 'srv', channelId: 'slack:C1' })!;
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
      const binding = router.getBinding({ serverId: 'srv', channelId: 'slack:C1' })!;
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
      const binding = router.getBinding({ serverId: 'srv', channelId: 'slack:C1' })!;
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
      const oldName = router.getBinding({ serverId: 'srv', channelId: 'slack:C1' })!.agentName;
      router.unbind({ serverId: 'srv', channelId: 'slack:C1' });
      await deliver(framework, 'slack:C1', 'new engagement');
      const binding = router.getBinding({ serverId: 'srv', channelId: 'slack:C1' })!;
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
    // The lifecycle traces name the channel's server, as the spawn's does.
    const lifecycle: Array<[string, string | undefined]> = [];
    framework.onTrace((e) => {
      const t = e as { type: string; serverId?: string };
      if (t.type === 'mcpl:conversation-closed' || t.type === 'mcpl:conversation-disposed') lifecycle.push([t.type, t.serverId]);
    });

    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const router = framework.getConversationRouter()!;
    assert.ok(router.getBinding({ serverId: 'srv', channelId: 'slack:D3' }), 'spawn should leave a live binding');
    const g1 = framework.getAgent(forkName('slack:D3', 1));
    assert.ok(g1, 'g1 fork should exist after spawn');

    // Force expiry deterministically and provide the closure-turn response.
    forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D3' }, IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));

    // Nudge the loop so the sweep runs.
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(router.getBinding({ serverId: 'srv', channelId: 'slack:D3' }), undefined, 'binding should be gone after TTL');
    const { messages } = await g1!.getContextManager().compile();
    assert.ok(
      messages.some((m) => JSON.stringify(m.content).includes('engagement is closing')),
      'closure prompt should be in the fork context',
    );
    assert.deepEqual(lifecycle, [['mcpl:conversation-closed', 'srv'], ['mcpl:conversation-disposed', 'srv']]);
    assert.equal(
      framework.getAgent(forkName('slack:D3', 1)), null,
      'closed fork should be disposed once its closure turn finished',
    );
    const internals = framework as unknown as {
      turnRouting: Map<string, unknown>; proseSpeechChains: Map<string, unknown>;
    };
    assert.equal(internals.turnRouting.has(forkName('slack:D3', 1)), false, 'the closed fork leaves no routing');
    assert.equal(internals.proseSpeechChains.has(forkName('slack:D3', 1)), false, 'the closed fork leaves no speech chain');

    // Next DM spawns a fresh generation.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi again' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'back again', channelType: 'im' }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent(forkName('slack:D3', 2)), 'rebind spawns generation 2');

    await framework.stop();
  });

  it("a disposed conversation agent's name is refused for a new agent", async () => {
    const framework = await makeFramework();
    const internals = framework as unknown as {
      createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
      disposeConversationAgent(name: string): void;
    };
    const name = forkName('slack:D9', 1);
    try {
      await internals.createConversationAgent(name, { serverId: 'srv', channelId: 'slack:D9' });
      assert.ok(framework.getAgent(name), 'the fork is registered under the name');
      internals.disposeConversationAgent(name);
      assert.equal(framework.getAgent(name), null, 'the fork is gone, so only its name is held');
      for (const attempt of [1, 2]) {
        await assert.rejects(
          framework.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'Do the task.' }),
          { message: `Ephemeral agent name "${name}" is already registered or has been used in this framework` },
          `attempt ${attempt}: a refusal that released the name would let this one through`,
        );
      }
      assert.equal(framework.getAgent(name), null, 'and no new agent took it');
    } finally {
      await framework.stop();
    }
  });

  // The gate's sleep quiets the whole agent, every conversation of it, so a
  // fork's sleep and wake are refused (#646), and a fork's end tells the gate,
  // which cancels the fork's pending self-wake.
  async function makeGatedFramework(conversations: Partial<ConversationRouterConfig> = {}, gate: { privilegedUsersPath?: string } = {}) {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
      modules: [],
      conversations: { templateAgent: 'trunk', ...conversations },
      gate: { config: { policies: [], default: 'always' }, configPath: join(tempDir, 'gate.json'), ...gate },
    });
  }
  const gateOf = (framework: AgentFramework) => (framework as unknown as { eventGate: EventGate }).eventGate;
  const ordinaryWake = { eventType: 'external-message', serverId: 'test', channelId: '', content: 'tick' };

  it("a fork's sleep is refused, so the primary's ordinary wakes aren't held back", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    const framework = await makeGatedFramework();
    const gate = gateOf(framework);
    const calls = gateToolCalls(framework);
    try {
      framework.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      assert.deepStrictEqual(calls.refused, ['sleep: Nothing was set: a sleep quiets the whole agent, not one conversation.']);
      assert.deepStrictEqual(calls.started, [], 'refused before the tool runs');
      assert.equal(gate.getSleepState(), null, 'nothing is asleep');
      assert.notEqual(gate.evaluate(ordinaryWake).policyName, 'asleep', "the primary's ordinary wake goes on to the policies");
    } finally {
      // So that a run where the sleep takes doesn't hold the file's process for its hour.
      gate.clearSleep();
      await framework.stop();
    }
  });

  it("a fork's wake is refused, so the primary's sleep stays", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'w1', name: 'wake', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    // The message that wakes the fork is a privileged user's: admission gates a
    // fork's channel message as it gates every inbound (Dendrite §D), and a
    // sleeping agent is roused by its heartbeat or a privileged user alone.
    const privilegedUsersPath = join(tempDir, 'privileged.json');
    writeFileSync(privilegedUsersPath, JSON.stringify(['U1']));
    const framework = await makeGatedFramework({}, { privilegedUsersPath });
    const gate = gateOf(framework);
    const calls = gateToolCalls(framework);
    try {
      gate.setSleep(3600, 'resting', 'trunk');
      framework.pushEvent(incomingEvent({ channelId: 'slack:D10', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      assert.deepStrictEqual(calls.refused, ["wake: Nothing was changed: a sleep is the agent's, so this conversation can't end one."]);
      assert.deepStrictEqual(calls.started, [], 'refused before the tool runs');
      assert.ok(gate.getSleepState() !== null, "the primary's sleep stays");
    } finally {
      gate.clearSleep();
      await framework.stop();
    }
  });

  it("a fork's end at the idle sweep tells the gate", async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeGatedFramework({ idleTtlMs: IDLE_TTL_MS });
    const gate = gateOf(framework);
    try {
      framework.pushEvent(incomingEvent({ channelId: 'slack:D7', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      const fork = forkName('slack:D7', 1);
      assert.ok(framework.getAgent(fork), 'the fork exists');

      forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D7' }, IDLE_TTL_MS);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
      const streamYielding = membrane.streamYielding.bind(membrane);
      let pending: unknown[] | undefined;
      membrane.streamYielding = (request, options) => {
        gate.armSelfWake(fork, 60);
        pending = gate.upcomingWakes([fork]);
        return streamYielding(request, options);
      };
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      assert.equal(framework.getAgent(fork), null, 'the fork is disposed');
      assert.equal(pending?.length, 1, "its self-wake was pending in its closure turn");
      assert.deepStrictEqual(gate.upcomingWakes([fork]), [], 'and its end cancelled it');
    } finally {
      await framework.stop();
    }
  });

  it("a fork's end at stop() tells the gate, and leaves the primary's sleep", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeGatedFramework();
    const gate = gateOf(framework);
    framework.pushEvent(incomingEvent({ channelId: 'slack:D8', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const fork = forkName('slack:D8', 1);
    assert.ok(framework.getAgent(fork), 'the fork exists');
    try {
      gate.setSleep(3600, 'resting', 'trunk');
      assert.equal(gate.armSelfWake(fork, 60).armed, true, 'the fork has a self-wake pending');
      await framework.stop();
      assert.equal(framework.getAgent(fork), null, 'stop() ends the fork');
      assert.deepStrictEqual(gate.upcomingWakes([fork]), [], 'and its self-wake with it');
      assert.ok(gate.inferenceDiagnostics().sleepUntil > 0, "the primary's sleep is kept through the fork's end and the stop");
    } finally {
      gate.clearSleep();
    }
  });

  it("the primary's own wake and sleep still work", async () => {
    // One turn: wake (with nothing asleep), then sleep, which ends the turn,
    // since a second turn would first need something to rouse the sleeper.
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'w1', name: 'wake', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
    const framework = await makeGatedFramework();
    const gate = gateOf(framework);
    const calls = gateToolCalls(framework);
    try {
      assert.strictEqual(framework.nudgeAgent('trunk', 'test').ok, true);
      await framework.runUntilIdle();
      assert.deepStrictEqual(calls.succeeded, ['wake', 'sleep']);
      assert.deepStrictEqual(calls.refused, []);
      assert.ok(gate.getSleepState() !== null, 'the primary slept');
    } finally {
      gate.clearSleep();
      await framework.stop();
    }
  });

  it('a write deferred for a fork during its closure turn is stored in the fork before it is disposed', async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });
    framework.pushEvent(incomingEvent({ channelId: 'slack:D4', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const g1 = framework.getAgent(forkName('slack:D4', 1))!;
    assert.ok(g1, 'g1 fork should exist after spawn');

    forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D4' }, IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
    // While the closure turn is alive, a write addressed to the fork is
    // deferred to that turn's end.
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
    };
    const streamYielding = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request, options) => {
      internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined,
        { forAgent: forkName('slack:D4', 1) });
      return streamYielding(request, options);
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(framework.getAgent(forkName('slack:D4', 1)), null, 'disposed once its closure turn finished');
    const stored = g1.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
    assert.ok(stored[stored.length - 2]!.includes('Final report posted.'), stored.join('\n'));
    assert.ok(stored[stored.length - 1]!.includes('one more thing'), 'stored after the closure reply, before the fork was disposed');

    await framework.stop();
  });

  it('a fork whose closure turn ends while the host is quiesced is disposed at the turn\'s end, and what was held for it lands in its window at resume', async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });
    framework.pushEvent(incomingEvent({ channelId: 'slack:D6', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const fork = forkName('slack:D6', 1);
    const g1 = framework.getAgent(fork)!;
    assert.ok(g1, 'g1 fork should exist after spawn');

    forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D6' }, IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
      deferredMessages: Array<{ forAgent?: string }>;
    };
    // While the closure turn is alive, a write for the fork is deferred to
    // the turn's end, and an operator quiesces the host, which waits for the
    // turn to end.
    const streamYielding = membrane.streamYielding.bind(membrane);
    let deferred: string | undefined;
    let quiescing: Promise<unknown> | undefined;
    membrane.streamYielding = (request, options) => {
      if (deferred === undefined) {
        deferred = internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined, { forAgent: fork });
        quiescing = framework.quiesce({ reason: 'test window' });
      }
      return streamYielding(request, options);
    };
    const lastStored = () => JSON.stringify(g1.getContextManager().getAllMessages().at(-1)?.content);
    const queued = () => internals.deferredMessages.filter((m) => m.forAgent === fork).length;
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    await quiescing;
    assert.equal(framework.getAgent(fork), null, 'disposed at its closure turn\'s end, though the host is quiesced');
    assert.equal(queued(), 1, 'what was held for it waits for its window\'s release at resume');
    assert.ok(!lastStored().includes('one more thing'), `not stored while quiesced:\n${lastStored()}`);

    await framework.resume();
    assert.ok(lastStored().includes('one more thing'), `stored in the fork at resume:\n${lastStored()}`);
    assert.equal(queued(), 0, 'nothing is left queued for the fork');

    await framework.stop();
  });

  it("a write deferred for a fork that its store refuses at the closure turn's end is tried again at the fork's release, and leaves the queue there, logged", async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });
    framework.pushEvent(incomingEvent({ channelId: 'slack:D5', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const fork = forkName('slack:D5', 1);
    const g1 = framework.getAgent(fork)!;
    assert.ok(g1, 'g1 fork should exist after spawn');
    // The fork's store refuses 'one more thing' each time it's written.
    const cm = g1.getContextManager();
    const add = cm.addMessage.bind(cm);
    (cm as unknown as { addMessage: typeof add }).addMessage = (...args) => {
      if ((args[1] as Array<{ text?: string }>).some((b) => b.text === 'one more thing')) throw new Error('disk full');
      return add(...args);
    };

    forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D5' }, IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
      deferredMessages: Array<{ forAgent?: string }>;
    };
    const streamYielding = membrane.streamYielding.bind(membrane);
    let deferred: string | undefined;
    membrane.streamYielding = (request, options) => {
      deferred = internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined, { forAgent: fork });
      return streamYielding(request, options);
    };
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    } finally { console.error = error; }

    assert.equal(deferred, '', 'deferred: the closure turn was alive');
    assert.equal(framework.getAgent(fork), null, 'disposed once its closure turn finished');
    assert.deepEqual(internals.deferredMessages.filter((m) => m.forAgent === fork), [], 'nothing is left queued for the fork');
    assert.ok(errors.some((e) => e.includes('turn-end flush: deferred write ')
      && e.includes(`(alice: text) for ${fork} could not be stored; it stays queued`)),
      `the closure turn's flush met the refusal:\n${errors.join('\n')}`);
    assert.ok(errors.some((e) => e.includes(`[deferred-flush] ${fork}: failed to store a queued write before release (participant=alice)`)
      && e.includes('disk full')), `the fork's release met it again:\n${errors.join('\n')}`);

    await framework.stop();
  });

  /** A fork spawned on `channelId` and closed by the sweep, whose closure
   *  request is then dropped before it runs, as a stale one is, with a write
   *  for it deferred meanwhile. Nothing holds it when this returns: no
   *  stream, no request, no turn token, and the host isn't quiesced. */
  async function closingForkWithAQueuedWrite(channelId: string) {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });
    framework.pushEvent(incomingEvent({ channelId, text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const fork = forkName(channelId, 1);
    const g1 = framework.getAgent(fork)!;
    assert.ok(g1, 'the fork should exist after spawn');
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
      deferredMessages: Array<{ forAgent?: string }>;
      pendingRequests: Array<{ agentName: string }>;
      activeTurnTokens: Map<string, number>;
      lastConversationSweep: number;
      sweepExpiredConversations(): void;
    };
    forceExpiry(framework, { serverId: 'srv', channelId }, IDLE_TTL_MS);
    internals.sweepExpiredConversations();
    assert.equal(internals.pendingRequests.filter((r) => r.agentName === fork).length, 1, 'the closure turn is queued');
    internals.pendingRequests.splice(0, internals.pendingRequests.length,
      ...internals.pendingRequests.filter((r) => r.agentName !== fork));
    internals.activeTurnTokens.set(fork, 1);
    assert.equal(internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined, { forAgent: fork }), '', 'deferred');
    internals.activeTurnTokens.delete(fork);
    const sweep = () => {
      internals.lastConversationSweep = 0;
      internals.sweepExpiredConversations();
    };
    const lastStored = () => JSON.stringify(g1.getContextManager().getAllMessages().at(-1)?.content);
    const queued = () => internals.deferredMessages.filter((m) => m.forAgent === fork).length;
    return { framework, fork, sweep, lastStored, queued };
  }

  it('the reaper disposes a closing fork on a quiesced host too, and its queued write lands in its window at resume', async () => {
    const { framework, fork, sweep, lastStored, queued } = await closingForkWithAQueuedWrite('slack:D9');
    await framework.quiesce({ reason: 'test window' });
    sweep();
    assert.equal(framework.getAgent(fork), null, 'disposed, though the host is quiesced');
    assert.equal(queued(), 1, 'its write waits for its window\'s release at resume');
    assert.ok(!lastStored().includes('one more thing'), `not stored while quiesced:\n${lastStored()}`);

    await framework.resume();
    assert.ok(lastStored().includes('one more thing'), `stored in the fork at resume:\n${lastStored()}`);
    assert.equal(queued(), 0, 'nothing is left queued for the fork');

    await framework.stop();
  });

  it('a closure turn that restarts is disposed by the frame that ends it, after storing what was held for it', async () => {
    const IDLE_TTL_MS = 60_000;
    // One tool, for the closure turn's tool round.
    const tools: Module = {
      name: 'test',
      async start(_ctx: ModuleContext) {},
      async stop() {},
      getTools: () => [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: {} } }],
      async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'echoed' }; },
      async onProcess() { return {}; },
    } as unknown as Module;
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      // The mock's tool round reports 10 input tokens, over this budget,
      // which the fork inherits from its template: the closure turn's tool
      // round restarts its stream.
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.', maxStreamTokens: 5 }],
      modules: [tools],
      conversations: { templateAgent: 'trunk', idleTtlMs: IDLE_TTL_MS },
    });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D6', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const g1 = framework.getAgent(forkName('slack:D6', 1))!;
    assert.ok(g1, 'g1 fork should exist after spawn');

    forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D6' }, IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'e1', name: 'test--echo', input: {} },
    ] as ContentBlock[], 'tool_use'));
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
    };
    const streamYielding = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const first = streams++ === 0;
      if (first) {
        // While the closure turn is alive, a write addressed to the fork is
        // deferred to that turn's end.
        internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined,
          { forAgent: forkName('slack:D6', 1) });
      }
      const stream = streamYielding(request, options);
      // A mock stream takes every response queued when it starts, so the
      // restart's stream gets its reply only once the first has started.
      if (first) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
      return stream;
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(streams, 2, 'the closure turn restarted once');
    assert.equal(framework.getAgent(forkName('slack:D6', 1)), null, 'disposed once its closure turn finished');
    const stored = g1.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
    // The restart's turn start stores what was held for the turn, before its
    // compile, so the restarted stream carries it and its reply follows.
    assert.ok(stored[stored.length - 2]!.includes('one more thing'), stored.join('\n'));
    assert.ok(stored[stored.length - 1]!.includes('Final report posted.'), 'the restarted closure turn finished in the fork');

    await framework.stop();
  });

  it("a closed fork whose turn checkpoints the store fails to remove is still disposed whole at its closure turn's end", async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });
    const errors = mock.method(console, 'error', () => {});
    try {
      framework.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      const fork = forkName('slack:D9', 1);
      const g1 = framework.getAgent(fork);
      assert.ok(g1, 'the fork spawned');
      const disposed: string[] = [];
      framework.onTrace((e: TraceEvent) => {
        if (e.type === 'mcpl:conversation-disposed') disposed.push(e.agentName);
      });
      failCheckpointRemoval(framework, fork);

      forceExpiry(framework, { serverId: 'srv', channelId: 'slack:D9' }, IDLE_TTL_MS);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
      // The disposal runs in the closure turn's driveStream finally, whose
      // promise nothing holds: had it rejected, node:test would fail this
      // test on the unhandled rejection.
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();

      const stored = g1.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
      assert.ok(stored[stored.length - 1]!.includes('Final report posted.'), "the closure turn ran, so its stream's frame disposed the fork");
      assert.equal(framework.getAgent(fork), null, 'the fork is unregistered');
      assert.deepEqual(disposed, [fork], 'its disposal ran to the end');
      assert.ok(
        errors.mock.calls.some((call) => String(call.arguments[0]).startsWith(`[checkpoints] agent=${fork}: `)),
        'the failure is logged',
      );
    } finally {
      errors.mock.restore();
      await framework.stop();
    }
  });

  it('the fallback reaper goes on past a fork whose turn checkpoints the store fails to remove', async () => {
    const framework = await makeFramework({ idleTtlMs: 60_000 });
    const errors = mock.method(console, 'error', () => {});
    try {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'one' }]));
      framework.pushEvent(incomingEvent({ channelId: 'slack:D10', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'two' }]));
      framework.pushEvent(incomingEvent({ channelId: 'slack:D11', text: 'hi', channelType: 'im' }));
      await framework.runUntilIdle();
      const failing = forkName('slack:D10', 1);
      const next = forkName('slack:D11', 1);
      assert.ok(framework.getAgent(failing) && framework.getAgent(next), 'both forks spawned');

      // Both closed, with no closure inference left to run (the case the
      // reaper is for), and the one whose removal fails comes first.
      const router = framework.getConversationRouter()!;
      router.unbind({ serverId: 'srv', channelId: 'slack:D10' });
      router.unbind({ serverId: 'srv', channelId: 'slack:D11' });
      const internals = framework as unknown as { closingConversationAgents: Set<string>; lastConversationSweep: number };
      internals.closingConversationAgents.add(failing);
      internals.closingConversationAgents.add(next);
      internals.lastConversationSweep = 0;
      failCheckpointRemoval(framework, failing);

      framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();

      assert.ok(
        errors.mock.calls.some((call) => String(call.arguments[0]).startsWith(`[checkpoints] agent=${failing}: `)),
        "the failing fork's removal failed, and was logged",
      );
      assert.equal(framework.getAgent(failing), null, 'the failing fork is disposed');
      assert.equal(framework.getAgent(next), null, 'the reaper went on to the next fork');
      assert.equal(internals.closingConversationAgents.size, 0);
    } finally {
      errors.mock.restore();
      await framework.stop();
    }
  });

  it('restart does not reuse generation names or re-seed an existing namespace', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const fw1 = await makeFramework({}, 'restart.chronicle');
    fw1.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK-V1: always check the logs first.' },
    ]);

    fw1.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'case one', channelType: 'im' }));
    await fw1.runUntilIdle();
    assert.ok(fw1.getAgent(forkName('slack:D9', 1)), 'first engagement spawns g1');
    await fw1.stop();

    // Restart: same store, fresh framework. The generation counter must come
    // back from Chronicle so the next engagement is g2 in a fresh namespace.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'fresh' }]));
    const fw2 = await makeFramework({}, 'restart.chronicle');
    fw2.pushEvent(incomingEvent({ channelId: 'slack:D9', text: 'case two', channelType: 'im' }));
    await fw2.runUntilIdle();

    assert.equal(fw2.getAgent(forkName('slack:D9', 1)), null, 'g1 must not be resurrected');
    const g2 = fw2.getAgent(forkName('slack:D9', 2));
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

  // F109: channel ids that read alike once sanitized (`foo bar`, `foo-bar`)
  // used to give one fork name. In one process the second channel's spawn
  // failed on every message; after a restart its fork opened the first
  // channel's namespace and carried on as that conversation.
  it('two channels whose ids read alike get a fork each, and each message lands in its own', async () => {
    const framework = await makeFramework();
    const failed: TraceEvent[] = [];
    framework.onTrace((e: TraceEvent) => { if (e.type === 'mcpl:conversation-spawn-failed') failed.push(e); });

    // A stream takes every response queued when it starts, so each turn's
    // response is queued just before its message.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'one' }]));
    framework.pushEvent(incomingEvent({ channelId: 'foo bar', text: 'said on foo bar', channelType: 'im' }));
    await framework.runUntilIdle();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'two' }]));
    framework.pushEvent(incomingEvent({ channelId: 'foo-bar', text: 'said on foo-bar', channelType: 'im' }));
    await framework.runUntilIdle();

    assert.deepEqual(failed, [], 'neither spawn fails');
    const router = framework.getConversationRouter()!;
    const spaced = router.getBinding({ serverId: 'srv', channelId: 'foo bar' })?.agentName;
    const dashed = router.getBinding({ serverId: 'srv', channelId: 'foo-bar' })?.agentName;
    assert.ok(spaced && dashed, 'each channel is bound to a fork');
    assert.notEqual(spaced, dashed, 'to forks of its own');
    const held = (name: string) => framework.getAgent(name)!.getContextManager().getAllMessages()
      .map((m) => JSON.stringify(m.content)).join('\n');
    assert.ok(held(spaced!).includes('said on foo bar') && !held(spaced!).includes('said on foo-bar'));
    assert.ok(held(dashed!).includes('said on foo-bar') && !held(dashed!).includes('said on foo bar'));
    await framework.stop();
  });

  it("after a restart, a channel whose id reads like an earlier engagement's gets a fresh, seeded fork", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const fw1 = await makeFramework({}, 'alike.chronicle');
    fw1.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK-V1: always check the logs first.' },
    ]);
    fw1.pushEvent(incomingEvent({ channelId: 'foo bar', text: 'PRIVATE to foo bar', channelType: 'im' }));
    await fw1.runUntilIdle();
    const first = fw1.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'foo bar' })?.agentName;
    assert.ok(first, 'the first channel spawns its fork');
    await fw1.stop();

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello' }]));
    const fw2 = await makeFramework({}, 'alike.chronicle');
    fw2.pushEvent(incomingEvent({ channelId: 'foo-bar', text: 'hello from foo-bar', channelType: 'im' }));
    await fw2.runUntilIdle();

    const name = fw2.getConversationRouter()!.getBinding({ serverId: 'srv', channelId: 'foo-bar' })?.agentName;
    assert.ok(name, 'the second channel spawns its fork');
    assert.notEqual(name, first, "under a name, and so in a namespace, other than the first channel's");
    const contents = fw2.getAgent(name!)!.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
    assert.ok(!contents.some((c) => c.includes('PRIVATE to foo bar')), "the other channel's conversation isn't in it");
    assert.equal(contents.filter((c) => c.includes('HANDBOOK-V1')).length, 1, 'it is seeded from the trunk, once');
    await fw2.stop();
  });

  it('forks cannot open channels or close foreign ones', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C7', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    const fork = forkName('slack:C7', 1);
    assert.ok(framework.getAgent(fork), 'fork should exist');

    const failures: Array<{ tool: string; error: string }> = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'tool:failed') {
        failures.push({ tool: (e as { tool: string }).tool, error: (e as { error: string }).error });
      }
    });

    const fw = framework as unknown as {
      dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: Record<string, unknown> }): void;
    };
    fw.dispatchChannelToolCall(fork, { id: 't1', name: 'channel_open', input: { channelId: 'slack:C8' } });
    fw.dispatchChannelToolCall(fork, { id: 't2', name: 'channel_close', input: { channelId: 'slack:C8' } });

    assert.equal(failures.length, 2, 'both foreign channel operations should be rejected');
    assert.ok(failures[0]!.error.includes("so it can't open other channels, and nothing was opened"), 'channel_open is rejected outright');
    assert.ok(failures[1]!.error.includes('closing "slack:C8" is not allowed'), 'foreign channel_close is rejected');

    await framework.stop();
  });

  it('fork channel_publish: omitted channelId defaults to home; foreign publish is rejected', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    framework.pushEvent(incomingEvent({ channelId: 'slack:C7', text: 'bot, help', mentioned: true }));
    await framework.runUntilIdle();
    const fork = forkName('slack:C7', 1);
    assert.ok(framework.getAgent(fork), 'fork should exist');

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
      // The fence names the home channel as the agent would see it, and
      // reads whether its server still registers it.
      nameShown: (channel: { channelId: string }) => channel.channelId,
      quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
      getDescriptor: () => ({}),
    } as typeof fw.channelRegistry;

    // (a) omitted channelId → rewritten to the home channel, passes the fence
    fw.dispatchChannelToolCall(fork, { id: 'p1', name: 'channel_publish', input: { content: 'hello home' } });
    const homePublish = started.find((t) => t.tool === 'channel_publish');
    assert.ok(homePublish, 'home-defaulted publish should pass the fence and reach tool:started');
    assert.equal(homePublish!.input?.channelId, 'slack:C7', 'omitted channelId is rewritten to the home channel');
    assert.ok(
      !failures.some((f) => f.callId === 'p1'),
      'home-defaulted publish must not be rejected by the fence',
    );

    // (b) foreign channelId → rejected by the fence, never starts
    fw.dispatchChannelToolCall(fork, { id: 'p2', name: 'channel_publish', input: { channelId: 'slack:C8', content: 'sneaky' } });
    const rejection = failures.find((f) => f.callId === 'p2');
    assert.ok(rejection, 'foreign publish should be rejected');
    assert.ok(rejection!.error.includes('publishing to "slack:C8" is not allowed'), 'rejection names the foreign channel');
    assert.equal(
      started.filter((t) => t.tool === 'channel_publish').length, 1,
      'foreign publish never reaches tool:started',
    );

    await framework.stop();
  });
});
