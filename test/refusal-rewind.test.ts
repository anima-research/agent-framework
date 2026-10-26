import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import type { Module, ProcessEvent, ProcessState, EventResponse, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { AutobiographicalStrategy } from '@animalabs/context-manager';

/**
 * The refusal auto-rewind sheds the newest turn (in sequence, newest first,
 * INCLUDING the agent's own turns) as a COMPLETE exchange — a tool_result is
 * removed together with its paired tool_use turn, so no orphaned tool_use /
 * signed thinking block is left behind. It maintains exactly ONE consolidated
 * marker per episode.
 */
function makeAgentHarness(messages: any[]) {
  const removed: string[] = [];
  const added: Array<{ participant: string; content: any[]; meta: any }> = [];
  const edited: Array<{ id: string; content: any[] }> = [];
  const cm = {
    getAllMessages: () => messages,
    removeMessage: (id: string) => {
      removed.push(id);
      const i = messages.findIndex((m) => m.id === id);
      if (i >= 0) messages.splice(i, 1);
    },
    // A range by its two ends, inclusive, as context-manager's removeMessages.
    removeMessages: (fromId: string, toId: string) => {
      const from = messages.findIndex((m) => m.id === fromId);
      const to = messages.findIndex((m) => m.id === toId);
      if (from < 0 || to < from) throw new Error(`no range ${fromId}..${toId}`);
      for (const m of messages.splice(from, to - from + 1)) removed.push(m.id);
    },
    addMessage: (participant: string, content: any[], meta: any) => {
      const id = `marker-${added.length}`;
      added.push({ participant, content, meta });
      messages.push({ id, participant, content, metadata: meta });
      return id;
    },
    editMessage: (id: string, content: any[]) => {
      edited.push({ id, content });
      const m = messages.find((x) => x.id === id);
      if (m) m.content = content;
    },
  };
  const fw = Object.create(AgentFramework.prototype) as any;
  fw.rewindEpisode = new Map();
  const agent = { name: 'labclaude', getContextManager: () => cm };
  return { fw, agent, removed, added, edited, messages };
}

test('shed: tool_result removes its paired tool_use turn too (complete exchange)', () => {
  const msgs = [
    { id: 'u1', participant: 'simulect', content: [{ type: 'text', text: 'do it' }], metadata: { messageId: '1' } },
    { id: 'a1', participant: 'labclaude', content: [{ type: 'thinking', thinking: '…' }, { type: 'tool_use', name: 'shell', id: 't1' }] },
    { id: 'r1', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'X'.repeat(320 * 1024) }] },
  ];
  const { fw, agent, removed, added } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.equal(rec.descriptor, 'a tool exchange (~320KB)');
  assert.deepEqual([...removed].sort(), ['a1', 'r1'], 'removes the tool_result AND its tool_use turn — no orphan');
  assert.deepEqual([...rec.removedIds].sort(), ['a1', 'r1']);
  assert.equal(added.length, 0, 'shedNewestTurn must not add a marker');
});

test('shed: human message → described as an incoming message, single removal', () => {
  const msgs = [
    { id: 'a0', participant: 'labclaude', content: [{ type: 'text', text: 'hi' }] },
    { id: 'm2', participant: 'simulect', content: [{ type: 'text', text: 'sketchy' }], metadata: { messageId: '999', channelId: 'discord:g:c' } },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.equal(rec.descriptor, 'an incoming message from simulect (7 chars)');
  assert.deepEqual(removed, ['m2']);
});

test('shed: agent turns ARE shed too (newest-first includes the agent own turns)', () => {
  const msgs = [
    { id: 'u1', participant: 'simulect', content: [{ type: 'text', text: 'q' }], metadata: { messageId: '1' } },
    { id: 'a1', participant: 'labclaude', content: [{ type: 'text', text: 'my narration' }] },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.ok(rec, 'sheds the agent turn (no longer skipped)');
  assert.deepEqual(removed, ['a1']);
});

test('shed: skips the episode marker and sheds the real turn beneath it', () => {
  const msgs = [
    { id: 'm1', participant: 'simulect', content: [{ type: 'text', text: 'real msg' }], metadata: { messageId: '1' } },
    { id: 'mk', participant: 'user', content: [{ type: 'text', text: '[refusal-rewind] ...' }], metadata: { system: true, kind: 'refusal-rewind' } },
  ];
  const { fw, agent, removed } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.ok(rec);
  assert.deepEqual(removed, ['m1']);
});

test('shed: null when only the episode marker remains', () => {
  const msgs = [{ id: 'mk', participant: 'user', content: [{ type: 'text', text: 'x' }], metadata: { system: true } }];
  const { fw, agent } = makeAgentHarness(msgs);
  assert.equal(fw.shedNewestTurn(agent), null);
});

test('marker: six rewinds produce ONE marker, updated in place (not six)', () => {
  const msgs = [{ id: 'm1', participant: 'labclaude', content: [{ type: 'text', text: 'a' }] }];
  const { fw, agent, added, edited } = makeAgentHarness(msgs);

  const c1 = fw.updateRewindMarker(agent, 'cyber');
  const c2 = fw.updateRewindMarker(agent, 'cyber');
  fw.updateRewindMarker(agent, 'cyber');
  fw.updateRewindMarker(agent, 'cyber');
  fw.updateRewindMarker(agent, 'cyber');
  const c6 = fw.updateRewindMarker(agent, 'cyber');

  assert.equal(c1, 1);
  assert.equal(c2, 2);
  assert.equal(c6, 6);
  assert.equal(added.length, 1, 'exactly ONE marker message added for the whole episode');
  assert.equal(edited.length, 5, 'subsequent rewinds edit that one marker in place');
  assert.match(edited[edited.length - 1].content[0].text, /6 most recent turn/, 'marker reflects the running total');
  assert.equal(added[0].meta.kind, 'refusal-rewind');
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);

class Surface implements Module {
  readonly name = 'surface';
  framework?: AgentFramework;
  heardWhileLooking?: string;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'look', description: 'Look at something.', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    if (this.heardWhileLooking) {
      this.framework!.pushEvent({ type: 'external-message', source: 'tui', content: this.heardWhileLooking, metadata: {}, triggerInference: false } as never);
      await new Promise((r) => setTimeout(r, 30));
    }
    return { success: true, data: 'what the tool saw' };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const wakes = (event as { triggerInference?: boolean }).triggerInference !== false;
    return { addMessages: [{ participant: 'user', content: [text(String(event.content))] }], requestInference: wakes };
  }
}

async function rewindRig(
  script: NormalizedResponse[][],
  refusalHandling: Record<string, unknown>,
  setup: {
    strategy?: unknown;
    onRequest?: (count: number, framework: AgentFramework) => void;
    heardWhileLooking?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-rewind-'));
  const membrane = new MockMembrane();
  if (setup.heardWhileLooking) membrane.supportsInjectedMessages = true;
  const surface = new Surface();
  surface.heardWhileLooking = setup.heardWhileLooking;
  const requests: NormalizedRequest[] = [];
  const streams: MockYieldingStream[] = [];
  const streamYielding = membrane.streamYielding.bind(membrane);
  let replies = 0;
  membrane.streamYielding = (request, options) => {
    requests.push(structuredClone(request));
    setup.onRequest?.(requests.length, framework);
    const scripted = script.shift() ?? [];
    for (const response of scripted.length > 0 ? scripted : [createMockResponse([text(`reply ${++replies}`)])]) membrane.pushResponse(response);
    const stream = streamYielding(request, options) as MockYieldingStream;
    streams.push(stream);
    return stream;
  };
  const framework: AgentFramework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout', refusalHandling, ...(setup.strategy ? { strategy: setup.strategy } : {}) }],
    modules: [surface],
  } as never);
  surface.framework = framework;
  const say = async (content: string, until: number) => {
    framework.pushEvent({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true } as never);
    for (let i = 0; i < 200 && requests.length < until; i++) { await framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
    await framework.runUntilIdle();
  };
  const texts = (request: NormalizedRequest) => request.messages.map((m) => JSON.stringify(m.content));
  const stored = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
  return {
    framework, requests, streams, say, texts, stored,
    close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const refused = (partial?: string) => createMockResponse(partial ? [text(partial)] : [], 'refusal');
const markerOf = (request: NormalizedRequest) => {
  const last = request.messages.at(-1)!;
  const said = JSON.stringify(last.content);
  return said.includes('[refusal-rewind]') ? said : undefined;
};

for (const partial of [undefined, 'Here is the start of an answer']) {
  const kind = partial ? ', with partial text on the refused reply' : '';
  test(`after one refusal on a message${kind}, the retry doesn't carry that message and the marker says 1`, async () => {
    const rig = await rewindRig([[], [refused(partial)]], { autoRewind: true, maxRewinds: 3 });
    try {
      await rig.say('first question', 1);
      await rig.say('second question', 3);
      assert.equal(rig.requests.length, 3, 'the turn, the refused request and the retry');
      assert.ok(rig.texts(rig.requests[1]!).some((t) => t.includes('second question')), 'the premise: the refused request carried it');
      const retry = rig.requests[2]!;
      assert.ok(!rig.texts(retry).some((t) => t.includes('second question')), 'the retry leaves the refused message out');
      if (partial) assert.ok(!rig.texts(retry).some((t) => t.includes(partial)), "and the refused attempt's text");
      assert.ok(rig.texts(retry).some((t) => t.includes('first question') && !t.includes('[refusal-rewind]')), 'what came before stays');
      assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
    } finally { await rig.close(); }
  });

  test(`after two refusals${kind}, the two newest messages that reached a request are gone and the marker says 2`, async () => {
    const rig = await rewindRig([[], [refused(partial)], [refused(partial)]], { autoRewind: true, maxRewinds: 3 });
    try {
      await rig.say('first question', 1);
      await rig.say('second question', 4);
      assert.equal(rig.requests.length, 4, 'the turn, two refused requests and the retry');
      const retry = rig.requests[3]!;
      assert.ok(!rig.texts(retry).some((t) => t.includes('second question')), 'the refused message is gone');
      assert.ok(!rig.texts(retry).some((t) => t.includes('reply 1')), 'and the reply before it');
      assert.ok(rig.texts(retry).some((t) => t.includes('first question') && !t.includes('[refusal-rewind]')), 'what came before stays');
      assert.match(markerOf(retry) ?? '', /The 2 most recent turn\(s\) were set aside/);
    } finally { await rig.close(); }
  });
}

for (const partial of [undefined, 'Here is the start of an answer']) {
  const kind = partial ? ', with partial text on the refused reply' : '';
  test(`after a refused tool round${kind}, the retry carries neither the tool call, its result nor the refused reply, and the marker says 1`, async () => {
    const call = { type: 'tool_use', id: 'look-1', name: 'surface--look', input: {} } as ContentBlock;
    const toolCall = createMockResponse([text('let me look'), call], 'tool_use');
    const refusedRound = {
      ...createMockResponse([
        text('let me look'), call, { type: 'tool_result', toolUseId: 'look-1', content: 'what the tool saw' } as ContentBlock,
        ...(partial ? [text(partial)] : []),
      ], 'refusal'),
      toolCalls: [],
    };
    const rig = await rewindRig([[], [toolCall, refusedRound]], { autoRewind: true, maxRewinds: 3 });
    try {
      await rig.say('first question', 1);
      await rig.say('look at it', 3);
      assert.equal(rig.requests.length, 3, 'the turn, the stream whose tool round was refused, and the retry');
      assert.match(JSON.stringify(rig.streams[1]!.receivedToolResults), /what the tool saw/, "the premise: the refused round's stream was given the tool's result");
      const retry = rig.requests[2]!;
      const sent = JSON.stringify(retry.messages);
      assert.doesNotMatch(sent, /what the tool saw/, "the tool's result is gone");
      assert.doesNotMatch(sent, /look-1/, 'and the call it answered');
      if (partial) assert.ok(!rig.texts(retry).some((t) => t.includes(partial)), "and the refused attempt's text");
      assert.ok(rig.texts(retry).some((t) => t.includes('look at it')), 'the message before the exchange stays');
      assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
    } finally { await rig.close(); }
  });
}

test('a message injected into the refused round is the newest turn it carried, and is shed first', async () => {
  const call = { type: 'tool_use', id: 'look-1', name: 'surface--look', input: {} } as ContentBlock;
  const toolCall = createMockResponse([text('let me look'), call], 'tool_use');
  const refusedRound = {
    ...createMockResponse([text('let me look'), call, { type: 'tool_result', toolUseId: 'look-1', content: 'what the tool saw' } as ContentBlock], 'refusal'),
    toolCalls: [],
  };
  const rig = await rewindRig([[], [toolCall, refusedRound]], { autoRewind: true, maxRewinds: 3 }, { heardWhileLooking: 'a message heard while the tool ran' });
  try {
    await rig.say('first question', 1);
    await rig.say('look at it', 3);
    const injected = rig.streams[1]!.receivedToolResultOptions.flatMap((o) => (o as { injectedMessages?: unknown[] } | undefined)?.injectedMessages ?? []);
    assert.match(JSON.stringify(injected), /heard while the tool ran/, 'the premise: the refused round carried the injected message');
    const retry = rig.requests[2]!;
    assert.ok(!rig.texts(retry).some((t) => t.includes('heard while the tool ran')), 'the injected message is gone');
    assert.match(JSON.stringify(retry.messages), /what the tool saw/, 'the tool exchange before it stays');
    assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
  } finally { await rig.close(); }
});

test('an exchange the refused request carried only by its call is shed whole', async () => {
  const rig = await rewindRig([[], [refused()], [refused()]], { autoRewind: true, maxRewinds: 3 });
  try {
    await rig.say('first question', 1);
    const cm = rig.framework.getAgent('scout')!.getContextManager();
    cm.addMessage('scout', [text('let me look'), { type: 'tool_use', id: 'look-9', name: 'surface--look', input: {} } as ContentBlock]);
    cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'look-9', content: 'what the tool saw' } as ContentBlock], { tuneOut: { epochId: 'held' } } as never);
    await rig.say('second question', 4);
    const refusedRequest = JSON.stringify(rig.requests[1]!.messages);
    assert.ok(refusedRequest.includes('look-9') && !refusedRequest.includes('what the tool saw'), 'the premise: the refused request carried the call and not its stored result');
    const retry = rig.requests[3]!;
    assert.ok(!JSON.stringify(retry.messages).includes('look-9'), 'the call is gone');
    assert.ok(!rig.stored().some((m) => JSON.stringify(m.content).includes('what the tool saw')), 'and so is its result');
    assert.match(markerOf(retry) ?? '', /The 2 most recent turn\(s\) were set aside/);
  } finally { await rig.close(); }
});

test('a row no refused request carried, such as tuned-out traffic, is neither removed nor counted', async () => {
  const rig = await rewindRig([[], [refused()], [refused()]], { autoRewind: true, maxRewinds: 3 });
  try {
    await rig.say('first question', 1);
    rig.framework.getAgent('scout')!.getContextManager()
      .addMessage('user', [text('traffic of a channel the agent tuned out')], { tuneOut: { epochId: 'tuned-out' } } as never);
    await rig.say('second question', 4);
    assert.equal(rig.requests.length, 4, 'the turn, two refused requests and the retry');
    assert.ok(rig.requests.every((request) => !rig.texts(request).some((t) => t.includes('tuned out'))), 'the premise: no request carries it');
    const retry = rig.requests[3]!;
    assert.ok(!rig.texts(retry).some((t) => t.includes('second question')), 'the refused message is gone');
    assert.ok(!rig.texts(retry).some((t) => t.includes('reply 1')), 'and the reply before it');
    assert.match(markerOf(retry) ?? '', /The 2 most recent turn\(s\) were set aside/);
    assert.ok(rig.stored().some((m) => JSON.stringify(m.content).includes('tuned out')), 'the tuned-out row stays stored');
  } finally { await rig.close(); }
});

test('a message stored after the refused request was sent is neither removed nor counted', async () => {
  const rig = await rewindRig([[], [refused()]], { autoRewind: true, maxRewinds: 3 }, {
    onRequest: (count, framework) => {
      if (count === 2) framework.getAgent('scout')!.getContextManager().addMessage('user', [text('a message stored while it streams')]);
    },
  });
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 3);
    assert.ok(!rig.texts(rig.requests[1]!).some((t) => t.includes('while it streams')), 'the premise: the refused request was sent without it');
    const retry = rig.requests[2]!;
    assert.ok(!rig.texts(retry).some((t) => t.includes('second question')), 'the refused message is gone');
    assert.ok(rig.texts(retry).some((t) => t.includes('while it streams')), 'the message stored meanwhile stays');
    assert.ok(rig.texts(retry).some((t) => t.includes('reply 1')), 'and so does what came before');
    assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
  } finally { await rig.close(); }
});

test('when no turn the refused request carried is left, the rewind removes only the refused reply, and no later request carries it', async () => {
  const partial = 'Here is the start of an answer';
  const rig = await rewindRig([[refused()], [refused(partial)]], { autoRewind: true, maxRewinds: 3 });
  try {
    rig.framework.getAgent('scout')!.getContextManager().addMessage('scout', [text('   ')]);
    await rig.say('the only question', 2);
    assert.ok(rig.stored().some((m) => /"text":"   "/.test(JSON.stringify(m.content))), 'an older row that carries nothing stays');
    assert.ok(!rig.texts(rig.requests[1]!).some((t) => t.includes('the only question')), 'the premise: the retry carried no turn but the marker');
    await rig.say('a new question', 3);
    assert.equal(rig.requests.length, 3, 'the refused request, its refused retry, and the next turn');
    assert.ok(!rig.texts(rig.requests[2]!).some((t) => t.includes(partial)), "the next request doesn't carry the refused reply");
  } finally { await rig.close(); }
});

test("when the rewind gives up at its cap, no later request carries the refused reply's text", async () => {
  const partial = 'Here is the start of an answer';
  const rig = await rewindRig([[], [refused()], [refused(partial)]], { autoRewind: true, maxRewinds: 1 });
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 3);
    assert.ok(rig.texts(rig.requests[2]!).some((t) => t.includes('[refusal-rewind]')), 'the premise: one rewind ran, and its retry was refused');
    await rig.say('a new question', 4);
    assert.equal(rig.requests.length, 4, 'the turn, the refused request, its refused retry, and the next turn');
    assert.ok(!rig.texts(rig.requests[3]!).some((t) => t.includes(partial)), "the next request doesn't carry the refused reply");
  } finally { await rig.close(); }
});

test("with the rewind off, the next request still carries the refused reply's text", async () => {
  const partial = 'Here is the start of an answer';
  const rig = await rewindRig([[], [refused(partial)]], {});
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    await rig.say('a new question', 3);
    assert.equal(rig.requests.length, 3, 'the turn, the refused request, and the next turn, with no retry');
    assert.ok(rig.texts(rig.requests[2]!).some((t) => t.includes(partial)), 'the next request carries the refused reply, as on main');
  } finally { await rig.close(); }
});

test('a refused reply stored in shards is removed whole, and the marker says 1', async () => {
  const long = (tag: string) => Array.from({ length: 400 }, (_, i) => `${tag}${i}`).join(' ');
  const rig = await rewindRig([[createMockResponse([text(long('answer'))])], [refused(long('partial'))]], { autoRewind: true, maxRewinds: 3 }, {
    strategy: new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 16_000, kvStableReachTokens: 32_000,
      compressionModel: 'mock', targetChunkTokens: 100, autoTickOnNewMessage: false,
    } as never),
  });
  try {
    await rig.say('first question', 1);
    const shards = rig.stored().filter((m) => m.participant === 'scout');
    assert.ok(shards.length > 1, 'the premise: a reply this long is stored in shards');
    await rig.say('second question', 3);
    const retry = rig.requests[2]!;
    assert.ok(!rig.texts(retry).some((t) => t.includes('partial')), 'no shard of the refused reply is carried');
    assert.ok(!rig.texts(retry).some((t) => t.includes('second question')), 'the refused message is gone');
    assert.ok(rig.texts(retry).some((t) => t.includes('answer0')), 'what came before stays');
    assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
  } finally { await rig.close(); }
});

test("/unstick after a refusal whose reply had text sheds that reply first, since the unstick's own request carried it", async () => {
  const partial = 'Here is the start of an answer';
  const rig = await rewindRig([[], [refused(partial)], [refused()]], {});
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    const started = await (rig.framework as unknown as {
      handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; started?: boolean }>;
    }).handleHostCommand('test-server', { command: 'unstick', agentName: 'scout' });
    assert.equal(started.started, true);
    for (let i = 0; i < 200 && rig.requests.length < 4; i++) { await rig.framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
    await rig.framework.runUntilIdle();
    assert.equal(rig.requests.length, 4, "the unstick's run, refused, and its retry");
    assert.ok(rig.texts(rig.requests[2]!).some((t) => t.includes(partial)), "the premise: the unstick's request carried the earlier refused reply");
    const retry = rig.requests[3]!;
    assert.ok(!rig.texts(retry).some((t) => t.includes(partial)), 'the retry leaves that reply out');
    assert.ok(rig.texts(retry).some((t) => t.includes('second question')), 'the message before it stays, for a later shed if the refusals go on');
    assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
  } finally { await rig.close(); }
});

test('/unstick after a refusal sheds the refused message, not the refused reply, and the marker says 1', async () => {
  const rig = await rewindRig([[], [refused()], [refused()]], {});
  try {
    await rig.say('first question', 1);
    await rig.say('second question', 2);
    assert.equal(rig.requests.length, 2, 'the premise: without autoRewind, the refusal stops there');
    const started = await (rig.framework as unknown as {
      handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<{ ok: boolean; started?: boolean }>;
    }).handleHostCommand('test-server', { command: 'unstick', agentName: 'scout' });
    assert.equal(started.started, true);
    for (let i = 0; i < 200 && rig.requests.length < 4; i++) { await rig.framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
    await rig.framework.runUntilIdle();
    assert.equal(rig.requests.length, 4, "the unstick's run, refused, and its retry");
    const retry = rig.requests[3]!;
    assert.ok(!rig.texts(retry).some((t) => t.includes('second question')), 'the refused message is gone');
    assert.ok(rig.texts(retry).some((t) => t.includes('reply 1')), 'the reply before it stays');
    assert.match(markerOf(retry) ?? '', /The 1 most recent turn\(s\) were set aside/);
  } finally { await rig.close(); }
});
