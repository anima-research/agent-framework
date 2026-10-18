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
import type { ProcessEvent, ConversationRouterConfig, TraceEvent, Module, ModuleContext, ToolCall, ToolResult } from '../src/index.js';
import { Membrane, OpenAIResponsesAPIAdapter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
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
    const seeded = framework.getAgent('conversation-slack-D3-g1')!.getContextManager().getAllMessages();
    return { seeded, lines };
  }

  /** The line a spawn logs for a seed that left something out. */
  function seedLine(thinking: number, calls: number, results: number): string {
    return `[conversation] conversation-slack-D3-g1: seeded from trunk without ${thinking} thinking block(s), ` +
      `${calls} unanswered tool call(s) and ${results} orphaned tool result(s)`;
  }

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

    const fork = framework.getAgent('conversation-slack-D3-g1')!.getContextManager();
    const onTrunk = compiles.filter((c) => c.cm === trunk);
    assert.ok(onTrunk.length >= 1, 'the seed compiled the template');
    assert.ok(onTrunk.every((c) => c.dry), "the template's compiles during the spawn are dry runs");
    assert.equal(compiles.find((c) => c.cm === fork)?.dry, true, "the new namespace's emptiness check is a dry run");

    const types = seeded.flatMap((m) => m.content.map((b) => b.type));
    assert.ok(!types.includes('thinking') && !types.includes('redacted_thinking'), `no thinking in the seed: ${types}`);
    const texts = seeded.map((m) => JSON.stringify(m.content));
    assert.ok(texts.some((t) => t.includes('HANDBOOK')) && texts.some((t) => t.includes('Checked the logs.')));
    assert.ok(seeded.some((m) => m.participant === 'conversation-slack-D3-g1'
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
    assert.equal(seeded[round]!.participant, 'conversation-slack-D3-g1');
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
    // The seed is everything before the fork's own first message ('hi').
    const firstOwn = seeded.findIndex((m) => JSON.stringify(m.content).includes('"hi"'));
    assert.ok(firstOwn > 1, 'the incoming message follows the seed');
    // The thinking goes first, so the round's row holds only its unanswered
    // call, which the pairing pass replaces with its placeholder.
    const last = seeded[firstOwn - 1]!;
    assert.deepEqual(last.content.map((b) => b.type), ['text']);
    assert.ok(JSON.stringify(last.content).includes('[tool call omitted]'), `the seed ends on the placeholder: ${JSON.stringify(last.content)}`);
    assert.equal(last.participant, 'conversation-slack-D3-g1');
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
      { participantMode: 'simple', assistantParticipant: 'conversation-slack-D3-g1', humanParticipant: 'user', systemPrompt: 'fork' } as never,
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

  it("a fork whose namespace already holds history isn't seeded again", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const fw1 = await makeFramework({}, 'reseed.chronicle');
    fw1.getAgent('trunk')!.getContextManager().addMessage('user', [
      { type: 'text', text: 'HANDBOOK-V1: always check the logs first.' },
    ]);
    fw1.pushEvent(incomingEvent({ channelId: 'slack:D8', text: 'case one', channelType: 'im' }));
    await fw1.runUntilIdle();
    assert.ok(fw1.getAgent('conversation-slack-D8-g1'), 'first engagement spawns g1');
    await fw1.stop();

    // Restart with the generation counters lost, so the next engagement
    // proposes g1 again, and its namespace already holds g1's history.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'again' }]));
    const fw2 = await makeFramework({}, 'reseed.chronicle');
    (fw2.getConversationRouter() as unknown as { generations: Map<string, number> }).generations.clear();
    fw2.pushEvent(incomingEvent({ channelId: 'slack:D8', text: 'case two', channelType: 'im' }));
    await fw2.runUntilIdle();

    const g1 = fw2.getAgent('conversation-slack-D8-g1');
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
    const internals = framework as unknown as {
      turnRouting: Map<string, unknown>; proseSpeechChains: Map<string, unknown>;
    };
    assert.equal(internals.turnRouting.has('conversation-slack-D3-g1'), false, 'the closed fork leaves no routing');
    assert.equal(internals.proseSpeechChains.has('conversation-slack-D3-g1'), false, 'the closed fork leaves no speech chain');

    // Next DM spawns a fresh generation.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi again' }]));
    framework.pushEvent(incomingEvent({ channelId: 'slack:D3', text: 'back again', channelType: 'im' }));
    await framework.runUntilIdle();
    assert.ok(framework.getAgent('conversation-slack-D3-g2'), 'rebind spawns generation 2');

    await framework.stop();
  });

  it('a write deferred for a fork during its closure turn is stored in the fork before it is disposed', async () => {
    const IDLE_TTL_MS = 60_000;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello!' }]));
    const framework = await makeFramework({ idleTtlMs: IDLE_TTL_MS });
    framework.pushEvent(incomingEvent({ channelId: 'slack:D4', text: 'hi', channelType: 'im' }));
    await framework.runUntilIdle();
    const g1 = framework.getAgent('conversation-slack-D4-g1')!;
    assert.ok(g1, 'g1 fork should exist after spawn');

    forceExpiry(framework, 'slack:D4', IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
    // While the closure turn is alive, a write addressed to the fork is
    // deferred to that turn's end.
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
    };
    const streamYielding = membrane.streamYielding.bind(membrane);
    let deferred: string | undefined;
    membrane.streamYielding = (request, options) => {
      deferred = internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined,
        { forAgent: 'conversation-slack-D4-g1' });
      return streamYielding(request, options);
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(deferred, '', 'deferred: the closure turn was alive');
    assert.equal(framework.getAgent('conversation-slack-D4-g1'), null, 'disposed once its closure turn finished');
    const stored = g1.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
    assert.ok(stored[stored.length - 2]!.includes('Final report posted.'), stored.join('\n'));
    assert.ok(stored[stored.length - 1]!.includes('one more thing'), 'stored after the closure reply, before the fork was disposed');

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
    const g1 = framework.getAgent('conversation-slack-D6-g1')!;
    assert.ok(g1, 'g1 fork should exist after spawn');

    forceExpiry(framework, 'slack:D6', IDLE_TTL_MS);
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'e1', name: 'test--echo', input: {} },
    ] as ContentBlock[], 'tool_use'));
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: undefined, opts?: { forAgent?: string }): string;
    };
    const streamYielding = membrane.streamYielding.bind(membrane);
    let streams = 0;
    let deferred: string | undefined;
    membrane.streamYielding = (request, options) => {
      const first = streams++ === 0;
      if (first) {
        // While the closure turn is alive, a write addressed to the fork is
        // deferred to that turn's end.
        deferred = internals.addMessage('alice', [{ type: 'text', text: 'one more thing' }], undefined,
          { forAgent: 'conversation-slack-D6-g1' });
      }
      const stream = streamYielding(request, options);
      // A mock stream takes every response queued when it starts, so the
      // restart's stream gets its reply only once the first has started.
      if (first) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Final report posted.' }]));
      return stream;
    };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.equal(deferred, '', 'deferred: the closure turn was alive');
    assert.equal(streams, 2, 'the closure turn restarted once');
    assert.equal(framework.getAgent('conversation-slack-D6-g1'), null, 'disposed once its closure turn finished');
    const stored = g1.getContextManager().getAllMessages().map((m) => JSON.stringify(m.content));
    // The restart's turn start stores what was held for the turn, before its
    // compile, so the restarted stream carries it and its reply follows.
    assert.ok(stored[stored.length - 2]!.includes('one more thing'), stored.join('\n'));
    assert.ok(stored[stored.length - 1]!.includes('Final report posted.'), 'the restarted closure turn finished in the fork');

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
      } | null;
    };

    // This harness runs no MCPL servers, so the framework never builds a real
    // ChannelRegistry (the public dispatch path guards on it before routing
    // channel_* tools). Stub the downstream boundary — the unit under test is
    // the fence ABOVE it, and a home-defaulted publish must get past the fence
    // to be observable at tool:started.
    fw.channelRegistry = { handleChannelToolCall: async () => ({ success: true }), stopAll: () => {} };

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

    await framework.stop();
  });
});
