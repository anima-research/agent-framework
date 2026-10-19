import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

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
