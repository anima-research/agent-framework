import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import type { Module, ProcessEvent, ProcessState, EventResponse, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/**
 * The refusal auto-rewind sheds the newest turn (in sequence, newest first,
 * INCLUDING the agent's own turns) as a COMPLETE exchange — a tool_result is
 * removed together with its paired tool_use turn, so no orphaned tool_use /
 * signed thinking block is left behind. It maintains exactly ONE consolidated
 * marker per episode. These exercise the private primitives on a prototype
 * instance with a minimal in-memory ContextManager stub.
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

test('shed: with nothing left that reached a request, it returns null and removes nothing', () => {
  const msgs = [
    { id: 'mk', participant: 'user', content: [{ type: 'text', text: '[refusal-rewind] ...' }], metadata: { system: true, kind: 'refusal-rewind' } },
    { id: 'a1', participant: 'labclaude', content: [] },
  ];
  const { fw, agent, removed, messages } = makeAgentHarness(msgs);
  assert.equal(fw.shedNewestTurn(agent), null);
  assert.deepEqual(removed, []);
  assert.deepEqual(messages.map((m: { id: string }) => m.id), ['mk', 'a1']);
});

test("shed: the episode's marker between two rows a request never carries stays", () => {
  const msgs = [
    { id: 'u1', participant: 'simulect', content: [{ type: 'text', text: 'the question' }], metadata: { messageId: '1' } },
    { id: 'a1', participant: 'labclaude', content: [] },
    { id: 'mk', participant: 'user', content: [{ type: 'text', text: '[refusal-rewind] ...' }], metadata: { system: true, kind: 'refusal-rewind' } },
    { id: 'a2', participant: 'labclaude', content: [{ type: 'text', text: ' ' }] },
  ];
  const { fw, agent, removed, messages } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.equal(rec.descriptor, 'an incoming message from simulect (12 chars)');
  assert.deepEqual([...removed].sort(), ['a1', 'a2', 'u1']);
  assert.deepEqual(messages.map((m: { id: string }) => m.id), ['mk']);
});

test('shed: a row a request never carries is removed with the turn, uncounted', () => {
  const msgs = [
    { id: 'u1', participant: 'simulect', content: [{ type: 'text', text: 'the question' }], metadata: { messageId: '1' } },
    { id: 'a1', participant: 'labclaude', content: [{ type: 'text', text: '   ' }] },
  ];
  const { fw, agent, removed, added } = makeAgentHarness(msgs);
  const rec = fw.shedNewestTurn(agent);
  assert.equal(rec.descriptor, 'an incoming message from simulect (12 chars)', 'the turn shed is the one a request carried');
  assert.deepEqual([...removed].sort(), ['a1', 'u1']);
  assert.equal(fw.updateRewindMarker(agent, 'cyber'), 1, 'one turn reached a request');
  assert.match(added[0].content[0].text, /The 1 most recent turn\(s\) were set aside/);
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);

class Surface implements Module {
  readonly name = 'surface';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'look', description: 'Look at something.', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'what the tool saw' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: [text(String(event.content))] }], requestInference: true };
  }
}

async function rewindRig(script: NormalizedResponse[][], refusalHandling: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'refusal-rewind-'));
  const membrane = new MockMembrane();
  const requests: NormalizedRequest[] = [];
  const streamYielding = membrane.streamYielding.bind(membrane);
  let replies = 0;
  membrane.streamYielding = (request, options) => {
    requests.push(structuredClone(request));
    const scripted = script.shift() ?? [];
    for (const response of scripted.length > 0 ? scripted : [createMockResponse([text(`reply ${++replies}`)])]) membrane.pushResponse(response);
    return streamYielding(request, options);
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout', refusalHandling }],
    modules: [new Surface()],
  } as never);
  const say = async (content: string, until: number) => {
    framework.pushEvent({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true } as never);
    for (let i = 0; i < 200 && requests.length < until; i++) { await framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
    await framework.runUntilIdle();
  };
  const texts = (request: NormalizedRequest) => request.messages.map((m) => JSON.stringify(m.content));
  return {
    framework, requests, say, texts,
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

test('after a refused tool round, the retry carries neither the tool call nor its result, and the marker says 1', async () => {
  const toolCall = createMockResponse([text('let me look'), { type: 'tool_use', id: 'look-1', name: 'surface--look', input: {} } as ContentBlock], 'tool_use');
  const rig = await rewindRig([[], [toolCall, refused()]], { autoRewind: true, maxRewinds: 3 });
  try {
    await rig.say('first question', 1);
    await rig.say('look at it', 3);
    assert.equal(rig.requests.length, 3, 'the turn, the stream whose tool round was refused, and the retry');
    const retry = rig.requests[2]!;
    const sent = JSON.stringify(retry.messages);
    assert.doesNotMatch(sent, /what the tool saw/, "the tool's result is gone");
    assert.doesNotMatch(sent, /look-1/, 'and the call it answered');
    assert.ok(rig.texts(retry).some((t) => t.includes('look at it')), 'the message before the exchange stays');
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
