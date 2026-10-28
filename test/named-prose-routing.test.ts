import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AnthropicAdapter, Membrane, NativeFormatter } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { HeartbeatWake } from '../src/heartbeat/heartbeat.js';
import type { ProseDraftStore } from '../src/prose-drafts.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const RULE = 'Your plain text is never posted to any channel, in any turn.';
const TICK: HeartbeatWake = { kind: 'heartbeat', reason: 'manual', silent: false, text: '[heartbeat] Periodic self-check-in.', eventId: 'hb-1' };

const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }) as ContentBlock;
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;

type Request = { system?: string; tools?: ToolDefinition[] };
type AgentSpec = { name: string; proseRouting?: string; allowedTools?: string[] };

async function harness(opts: { agents: AgentSpec[]; gate?: boolean; fork?: boolean; modules?: Module[]; codeExecution?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'named-prose-'));
  const commandPath = join(dir, 'commands.jsonl');
  const statusPath = join(dir, 'status.jsonl');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  // A wake the test didn't script gets an empty completion, not a stream with no events.
  const streamYielding = membrane.streamYielding.bind(membrane);
  (membrane as unknown as { streamYielding: typeof streamYielding }).streamYielding = (request, options) => {
    const internals = membrane as unknown as { responses: unknown[]; responseIndex: number };
    if (internals.responseIndex >= internals.responses.length) membrane.pushResponse(createMockResponse([]));
    return streamYielding(request, options);
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: opts.agents.map((a) => ({
      name: a.name, model: 'test-model', systemPrompt: `You are ${a.name}.`,
      ...(a.proseRouting ? { proseRouting: a.proseRouting } : {}),
      ...(a.allowedTools ? { allowedTools: a.allowedTools } : {}),
    })),
    heartbeat: { statePath: join(dir, 'heartbeat.json'), defaults: { paused: true } },
    mcplServers: [{
      id: 'discord', command: process.execPath,
      args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
      env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
    }],
    modules: opts.modules ?? [],
    ...(opts.gate ? { gate: { config: { policies: [], default: 'always' } } } : {}),
    ...(opts.codeExecution ? { codeExecution: { enabled: true } } : {}),
    ...(opts.fork ? { conversations: { templateAgent: opts.agents[0]!.name, bind: { channel: 'mention' } } } : {}),
  } as unknown as Parameters<typeof AgentFramework.create>[0]);
  await framework.start();
  const until = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const internals = framework as unknown as {
    channelRegistry: { listChannelsRaw(): unknown[]; handleChanged(serverId: string, params: unknown): Promise<unknown> };
    pendingRequests: unknown[];
    activeTurnTokens: Map<string, unknown>;
    deliverHeartbeat(wake: HeartbeatWake): void;
    proseDrafts: ProseDraftStore;
    buildClosedChannelInvitation(opts: Record<string, unknown>): { block: { text: string } } | null;
  };
  await until(() => internals.channelRegistry.listChannelsRaw().length >= 2, 'registration');
  let incoming = 0;
  const command = (c: Record<string, unknown>) => appendFileSync(commandPath, JSON.stringify(c) + '\n');
  const h = {
    framework,
    membrane,
    internals,
    until,
    close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
    publishes: (): Array<{ channelId: string; text: string }> => existsSync(statusPath)
      ? readFileSync(statusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; channelId: string; text: string })
        .filter((e) => e.event === 'publish')
      : [],
    /** A turn answered with `responses`, started by `start`; resolves once the agent is idle again. */
    turn: async (responses: ContentBlock[][], start: () => void, agentName = 'scout') => {
      for (const [i, r] of responses.entries()) {
        membrane.pushResponse(createMockResponse(r, i < responses.length - 1 ? 'tool_use' : 'end_turn'));
      }
      const before = membrane.calls.length;
      start();
      await until(() => membrane.calls.length > before, 'turn start');
      await framework.runUntilIdle();
      await until(() => !internals.activeTurnTokens.has(agentName), 'turn end');
      await framework.runUntilIdle();
    },
    addressed: (channelId = ROOM, metadata?: Record<string, unknown>) => () =>
      command({ op: 'incoming', channelId, messageId: `in-${++incoming}`, mode: 'addressed', text: `message ${incoming}`, ...(metadata ? { metadata } : {}) }),
    request: (agentName: string) => () =>
      internals.pendingRequests.push({ agentName, reason: 'test', source: 'test', timestamp: Date.now() }),
    texts: (agent = 'scout') => framework.getAgent(agent)!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text),
    kinds: (agent = 'scout') => framework.getAgent(agent)!.getContextManager().getAllMessages()
      .map((m) => (m.metadata as { kind?: string } | undefined)?.kind),
    /** The text of every tool result the latest stream received. */
    results: () => (membrane.lastStream?.receivedToolResults ?? []).flat().map((r) => {
      const content = (r as { content?: unknown }).content;
      return typeof content === 'string' ? content : JSON.stringify(content);
    }),
    /** The requests made for one agent's turns, by its system prompt's first line. */
    requestsOf: (agent: string): Request[] => (membrane.calls as unknown as Request[])
      .filter((r) => (r.system ?? '').startsWith(`You are ${agent}.`)),
  };
  return h;
}

const toolNamed = (tools: ToolDefinition[] | undefined, name: string) => {
  const tool = tools?.find((t) => t.name === name);
  assert.ok(tool, `${name} is offered`);
  return tool as ToolDefinition & { inputSchema: { required?: string[] } };
};

describe('a named agent', () => {
  it('never has its plain text posted, in a channel message\'s turn, a heartbeat tick\'s or a self-wake\'s, >> and >>> lines included, and is given no primer', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }], gate: true });
    try {
      await h.turn([[text('Plain words.')]], h.addressed());
      await h.turn([[text('>>#general Prefixed words.\n>>>#general Enveloped words.')]], h.addressed());
      await h.turn([[text('Words beside a call.'), call('t1', 'think', { content: 'Working it out.' })], [text('Closing words.')]], h.addressed());
      await h.turn([[text('Tick words.')]], () => h.internals.deliverHeartbeat(TICK));
      await h.turn([[call('w1', 'skip_reply', { reason: 'back soon', wake_in_seconds: 1 })]], h.request('scout'));
      await h.turn([[text('Self-wake words.')]], () => {});
      assert.ok(h.texts().some((t) => t.startsWith('[self-wake]')), 'the self-wake turn ran');
      assert.deepEqual(h.publishes(), []);
      assert.ok(!h.kinds().includes('prose-routing-primer'), 'no primer row');
    } finally {
      await h.close();
    }
  });

  it('is told after a turn with plain text that nothing was delivered, and that the words stayed in its context', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }] });
    try {
      await h.turn([[text('Plain words.')]], h.addressed());
      assert.ok(h.texts().includes('Plain words.'), 'the words stayed in its context');
      const receipt = h.texts().find((t) => t.startsWith('[delivered]'));
      assert.equal(receipt,
        '[delivered] nothing — 1 plain-speech segment(s) kept in your context, sent to no one (only a send tool that names where it goes reaches anyone)');
    } finally {
      await h.close();
    }
  });

  it('carries the rule at the system position in every turn\'s request, naming channel_publish only where it may call it', async () => {
    const h = await harness({
      agents: [
        { name: 'scout', proseRouting: 'named' },
        { name: 'lark', proseRouting: 'named', allowedTools: ['think', 'skip_reply'] },
        { name: 'wren' },
      ],
    });
    try {
      for (const name of ['scout', 'lark', 'wren', 'scout']) await h.turn([[text('Noted.')]], h.request(name), name);
      const [scout, scoutAgain] = h.requestsOf('scout');
      const line = (r?: Request) => r?.system?.slice(r.system.indexOf(RULE));
      assert.equal(line(scoutAgain), line(scout), 'the same line in a later turn');
      const [lark] = h.requestsOf('lark');
      const [wren] = h.requestsOf('wren');
      assert.ok(scout?.system?.includes(RULE), scout?.system);
      assert.ok(scout?.system?.includes('channel_publish with a channelId'), scout?.system);
      assert.ok(lark?.system?.includes(RULE), lark?.system);
      assert.ok(!lark?.system?.includes('channel_publish'), lark?.system);
      assert.ok(lark?.system?.includes('a tool that names a channel, a person or a message, such as a send, DM or reply tool.'), lark?.system);
      assert.ok(wren && !wren.system?.includes(RULE), 'an agent in another mode carries no rule');
    } finally {
      await h.close();
    }
  });

  it('as a subagent, carries the rule with its final reply going back to whoever started it', async () => {
    const h = await harness({ agents: [{ name: 'scout' }] });
    try {
      const created = await h.framework.createEphemeralAgent({ name: 'helper', model: 'test-model', systemPrompt: 'You are helper.', proseRouting: 'named' } as never);
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Look into it.' }]);
      h.membrane.pushResponse(createMockResponse([text('Looked.')]));
      const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager);
      const processing = setInterval(() => { void h.framework.runUntilIdle(); }, 10);
      try {
        assert.equal((await run).speech, 'Looked.');
      } finally {
        clearInterval(processing);
      }
      const [request] = h.requestsOf('helper');
      assert.ok(request?.system?.includes(RULE), request?.system);
      assert.ok(request?.system?.includes('Your final reply goes back to whoever started you; other plain text stays in your own context.'), request?.system);
      assert.ok(!request?.system?.includes("console and observers"), request?.system);
    } finally {
      await h.close();
    }
  });

  it('has a channel_publish with no channelId refused and posting nothing, a serverId alone included, while naming a channel posts there', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }] });
    try {
      await h.turn([[call('p1', 'channel_publish', { content: 'To the default?' })], []], h.addressed());
      const refusals = h.results();
      await h.turn([[call('p2', 'channel_publish', { serverId: 'discord', content: 'To a server alone?' })], []], h.addressed());
      refusals.push(...h.results());
      await h.turn([[call('p4', 'channel_publish', { channelId: '', content: 'To an empty name?' })], []], h.addressed());
      refusals.push(...h.results());
      const puppeted = await h.framework.puppetToolCall('scout', 'channel_publish', { content: 'Puppeted?' });
      assert.equal(puppeted.result.success, false);
      refusals.push(String(puppeted.result.error));
      assert.equal(h.publishes().length, 0);
      await h.turn([[call('p3', 'channel_publish', { channelId: GENERAL, content: 'To general.' })], []], h.addressed());
      assert.deepEqual(h.publishes().map((p) => [p.channelId, p.text]), [[GENERAL, 'To general.']]);
      assert.equal(refusals.length, 4);
      for (const refusal of refusals) {
        assert.match(refusal, /Nothing was posted: channel_publish needs a channelId, since nothing is sent to a default channel\. channel_list shows the channel ids\./);
      }
    } finally {
      await h.close();
    }
  });

  it('has a script\'s channel_publish with no channelId refused, posting nothing', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }], codeExecution: true });
    try {
      const code = "try { const r = await tools.channel_publish({ content: 'From a script.' }); return [r.isError, r.content[0].text]; } catch (e) { return ['threw', String(e)]; }";
      await h.turn([[call('ce1', 'code_execution', { code })], []], h.addressed());
      assert.match(h.results().join('\n'), /channel_publish needs a channelId, since nothing is sent to a default channel/);
      assert.deepEqual(h.publishes(), []);
    } finally {
      await h.close();
    }
  });

  it('offers tools that agree with the rule, while another agent\'s tools say what they always did', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }, { name: 'wren' }], gate: true });
    try {
      await h.turn([[text('Noted.')]], h.request('scout'));
      await h.turn([[text('Noted.')]], h.request('wren'), 'wren');
      const named = h.requestsOf('scout')[0]!.tools;
      const other = h.requestsOf('wren')[0]!.tools;
      const publish = toolNamed(named, 'channel_publish');
      assert.ok(publish.inputSchema.required?.includes('channelId'), 'channelId is required');
      assert.doesNotMatch(publish.description, /most recent incoming|omitted|default channel to post/);
      assert.match(publish.description, /nothing is sent to a default channel/);
      assert.doesNotMatch(toolNamed(named, 'skip_reply').description, /just write plain text/);
      assert.match(toolNamed(named, 'skip_reply').description, /is NOT posted\. To reply instead, send it with a tool that names where it goes\./);
      assert.doesNotMatch(toolNamed(named, 'skip_reply').description, /stays private/);
      assert.doesNotMatch(toolNamed(named, 'think').description, /same_round_think_text_policy|routed/);
      assert.doesNotMatch(toolNamed(named, 'sleep').description, /announces/);
      assert.match(toolNamed(named, 'sleep').description, /Nothing is announced, since your plain text isn't posted: to tell a channel you're going quiet, send that first\./);
      assert.deepEqual(Object.keys((toolNamed(named, 'sleep').inputSchema as { properties: object }).properties), ['seconds']);
      assert.ok(!toolNamed(other, 'channel_publish').inputSchema.required?.includes('channelId'));
      assert.match(toolNamed(other, 'channel_publish').description, /most recent incoming message/);
      assert.match(toolNamed(other, 'skip_reply').description, /just write plain text/);
      assert.match(toolNamed(other, 'think').description, /same_round_think_text_policy/);
      assert.match(toolNamed(other, 'sleep').description, /announces in your current channel/);
    } finally {
      await h.close();
    }
  });

  it('hands no module speech handler its plain text, while another agent\'s still reaches one', async () => {
    const heard: string[] = [];
    const listener: Module = {
      name: 'listener',
      async start(ctx: ModuleContext) { ctx.registerSpeechHandler('*'); },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: true }; },
      async onProcess() { return {}; },
      async onAgentSpeech(agentName: string) { heard.push(agentName); },
    };
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }, { name: 'wren' }], modules: [listener] });
    try {
      await h.turn([[text('Plain words.')]], h.request('scout'));
      await h.turn([[text('Plain words.')]], h.request('wren'), 'wren');
      assert.deepEqual(heard, ['wren']);
    } finally {
      await h.close();
    }
  });

  it('is offered channel_publish naming the channel when addressed in one it hasn\'t opened', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }, { name: 'lark', proseRouting: 'named', allowedTools: ['think', 'skip_reply'] }] });
    try {
      await h.internals.channelRegistry.handleChanged('discord', {
        added: [{ id: 'discord:g1:lobby', type: 'discord', label: '#lobby', direction: 'bidirectional' }],
      });
      const invitation = h.internals.buildClosedChannelInvitation({
        serverId: 'discord', channelId: 'discord:g1:lobby', channelLabel: '#lobby', messageId: 'm7', authorName: 'Ann',
        tags: ['chat:addressed'], targetAgents: ['scout'],
      })?.block.text ?? '';
      assert.match(invitation, /\n1\. Reply — call channel_publish with channelId "discord:discord:g1:lobby"; it will be delivered there, which opens the channel\./);
      assert.doesNotMatch(invitation, /plain text|prefix/);
      const withoutPublish = h.internals.buildClosedChannelInvitation({
        serverId: 'discord', channelId: 'discord:g1:lobby', channelLabel: '#lobby', messageId: 'm8', authorName: 'Ann',
        tags: ['chat:addressed'], targetAgents: ['lark'],
      })?.block.text ?? '';
      assert.match(withoutPublish, /\n1\. Reply — check whether discord exposes a send tool that can address it\. Replying there opens the channel\./);
      assert.doesNotMatch(withoutPublish, /channel_publish|plain text|prefix/);
    } finally {
      await h.close();
    }
  });

  it('posts nothing when it announces a sleep, and is told of no undeliverable reply', async () => {
    // The control: a locus agent's announcement posts within the bound the check below waits.
    const control = await harness({ agents: [{ name: 'scout' }], gate: true });
    try {
      await control.turn([[call('s0', 'sleep', { seconds: 600 })]], control.addressed());
      const since = Date.now();
      await control.until(() => control.publishes().some((p) => p.text.includes('Going quiet')), 'the control announced its sleep');
      assert.ok(Date.now() - since < 500, 'the control announced within the bound');
    } finally {
      await control.close();
    }
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }], gate: true });
    try {
      await h.turn([[call('s1', 'sleep', { seconds: 600 })]], h.addressed());
      const gate = (h.framework as unknown as { eventGate: { getSleepState(): { until: number } | null } }).eventGate;
      assert.ok(gate.getSleepState(), 'the sleep ran');
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(h.publishes(), []);
      assert.ok(!h.texts().some((t) => t.includes('[send-undeliverable]')), h.texts().join('\n'));
    } finally {
      await h.close();
    }
  });

  it('has its refusal marked on no one\'s message, while another agent\'s still is', async () => {
    const reactions = async (proseRouting?: string) => {
      const h = await harness({ agents: [{ name: 'scout', ...(proseRouting ? { proseRouting } : {}) }] });
      try {
        await h.turn([[text('Hi.')]], h.addressed());
        const server = (h.framework as unknown as { mcplServerRegistry: { getServer(id: string): { sendToolsCall(name: string, args: unknown): Promise<unknown> } } })
          .mcplServerRegistry.getServer('discord');
        const calls: string[] = [];
        server.sendToolsCall = async (name: string) => { calls.push(name); return { content: [] }; };
        await (h.framework as unknown as { reactToRefusal(name: string, category: string): Promise<void> }).reactToRefusal('scout', 'other');
        return calls;
      } finally {
        await h.close();
      }
    };
    assert.deepEqual(await reactions(), ['add_reaction'], 'control: a locus agent\'s refusal is marked');
    assert.deepEqual(await reactions('named'), []);
  });

  it('as a conversation fork, has a channel_publish or a drafts resend with no destination refused, not sent to its home', async () => {
    const h = await harness({ agents: [{ name: 'scout', proseRouting: 'named' }], fork: true });
    const fork = forkAgentName('conversation', 'discord', ROOM, 1);
    try {
      await h.turn([[call('p1', 'channel_publish', { content: 'Home?' })], []], h.addressed(ROOM, { mentioned: true }), fork);
      assert.ok(h.framework.getAgent(fork), 'the fork spawned');
      assert.match(h.results().join('\n'), /channel_publish needs a channelId, since nothing is sent to a default channel/);
      const { held } = h.internals.proseDrafts.hold(fork, [{ text: 'Carried over.' }], 'explicit-send');
      await h.turn([[call('d1', 'drafts', { action: 'resend', draftIds: [held[0]!.id], destination: null, confirmDuplicate: null })], []],
        h.addressed(ROOM, { mentioned: true }), fork);
      assert.match(h.results().join('\n'), /resend needs a destination/);
      assert.deepEqual(h.publishes(), []);
    } finally {
      await h.close();
    }
  });
});

/** An Anthropic adapter that records each provider request and answers from a script. */
class WireAnthropic extends AnthropicAdapter {
  readonly sent: Array<{ system?: unknown }> = [];
  readonly replies: Array<{ content: ContentBlock[]; stopReason: string }> = [];
  constructor() { super({ apiKey: 'test', cacheKeepalive: { enabled: false } } as never); }
  override async stream(...args: Parameters<AnthropicAdapter['stream']>): ReturnType<AnthropicAdapter['stream']> {
    const [request, callbacks, options] = args;
    const wire = (this as unknown as { buildRequest(r: unknown, onAltered?: unknown): unknown })
      .buildRequest(request, (options as { onContentAltered?: unknown } | undefined)?.onContentAltered);
    this.sent.push(JSON.parse(JSON.stringify(wire)) as { system?: unknown });
    const reply = this.replies.shift() ?? { content: [text('done')], stopReason: 'end_turn' };
    for (const block of reply.content) if (block.type === 'text') callbacks.onChunk(block.text);
    return { ...reply, usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: wire, raw: {} } as never;
  }
}

class Speaker implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text' as const, text: String(event.content) }] }], requestInference: true };
  }
}

describe('a named agent\'s later provider rounds', () => {
  it('carry the rule at the system position, as its first round does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'named-prose-wire-'));
    const adapter = new WireAnthropic();
    adapter.replies.push(
      { content: [call('t1', 'think', { content: 'Working it out.' })], stopReason: 'tool_use' },
      { content: [text('Thought it through.')], stopReason: 'end_turn' },
    );
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
      agents: [{ name: 'scout', model: 'claude-sonnet-4-5', systemPrompt: 'You are scout.', proseRouting: 'named' }],
      modules: [new Speaker()],
    } as unknown as Parameters<typeof AgentFramework.create>[0]);
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      assert.equal(adapter.sent.length, 2, 'two provider rounds');
      for (const [i, request] of adapter.sent.entries()) {
        assert.ok(JSON.stringify(request.system).includes(RULE), `round ${i + 1}: ${JSON.stringify(request.system)}`);
      }
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
