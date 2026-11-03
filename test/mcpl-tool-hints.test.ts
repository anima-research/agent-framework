/**
 * MCPL RFC-014 host side, against a scripted server that sends exactly what
 * each conformance vector needs (RFC §13: 3, 4, 10–13, 21–23, 27, 28, 30,
 * 33, 34, 36, 38), plus "toolHints off = unchanged". The reference server's
 * own behaviour (vectors 9 and 26) is in mcpl-toolsets-e2e.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { McplServerConfig } from '../src/mcpl/types.js';
import { serverConfigProblems } from '../src/mcpl/protocol-family.js';
import { assertServerConfigBooleans } from '../src/mcpl/transport.js';
import { ToolPresence } from '../src/mcpl/tool-presence.js';
import { firstSentence, objectSignature } from '../src/mcpl/tool-signature.js';
import { META_TOOL_NAMES, ToolsetHub } from '../src/mcpl/toolset-host.js';
import { ToolsetsModule, resolveAct } from '../src/mcpl/toolsets-module.js';
import {
  startScriptedServer, makeFramework, waitFor, callTool, resultText, windowText,
  type Json, type ScriptedPeer,
} from './helpers/toolset-servers.js';
import { createMockResponse } from './helpers/mock-membrane.js';

const TOOLS: Json[] = [
  { name: 'status', description: 'Status of the arcade.', inputSchema: { type: 'object', properties: {} } },
  { name: 'play', description: 'Play a point. Points look like D4.', inputSchema: { type: 'object', properties: { point: { type: 'string' } }, required: ['point'] }, _meta: { 'mcpl/toolset': 'game', 'mcpl/visible': false } },
  { name: 'place', description: 'Place a block.', inputSchema: { type: 'object', properties: { x: { type: 'integer' } } }, _meta: { 'mcpl/toolset': 'build', 'mcpl/visible': false } },
  { name: 'dig', description: 'Dig a hole.', inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/toolset': 'cave', 'mcpl/visible': true } },
  { name: 'peek', description: 'Peek around.', inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } },
];

const ADVERT: Json = {
  toolHints: true,
  toolsets: {
    game: { title: 'Game', summary: 'A game', default: 'closed', instances: true },
    build: { title: 'Building', summary: 'Blocks', default: 'closed' },
  },
  featureSets: {
    'arc.tools': { description: 'tools', uses: ['tools'] },
    'arc.events': { description: 'events', uses: ['pushEvents'] },
  },
};

/** The server's side of the toolset state, which each test drives. Its
 *  toolsets/list statement is kept consistent with every hint it sends, as
 *  RFC §5.3 requires (a full statement). */
class State {
  rev = 0;
  open: Json[] = [];
  /** toolsets/list's `tools` statement: every visible dynamic tool, per instance. */
  statement: Json[] = [{ name: 'dig', visible: true }];
  ended: Json[] = [];
  next(): number { return ++this.rev; }
  /** A HintChanges under the next rev, its tool entries kept in the statement. */
  hint(tools: Json[], extra: Json = {}): Json {
    for (const e of tools) {
      this.statement = this.statement.filter((x) => !(x.name === e.name && x.instance === e.instance));
      if (e.visible === true) this.statement.push(e);
    }
    return { rev: this.next(), tools, ...extra };
  }
  listResult(): Json {
    return { open: this.open, ...(this.ended.length ? { ended: this.ended } : {}), _meta: { 'mcpl/hints': { rev: this.next(), tools: this.statement } } };
  }
}

type Handler = (msg: Json, peer: ScriptedPeer, state: State) => boolean | void;

async function setup(handler: Handler = () => false, config: Partial<McplServerConfig> = {}, advert: Json = ADVERT, tools: Json[] = TOOLS) {
  const state = new State();
  const server = await startScriptedServer({
    advert,
    tools,
    listRev: () => (advert.toolHints === true ? state.rev : undefined),
    onList: (msg, peer) => handler(msg, peer, state) === true,
    on: (msg, peer) => {
      if (handler(msg, peer, state)) return;
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, state.listResult()); return; }
      if (msg.method === 'tools/call') { peer.reply(msg.id, { content: [{ type: 'text', text: `${String((msg.params as Json).name)} done` }] }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  const fw = await makeFramework([{ id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true, ...config } as McplServerConfig]);
  await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status'), 'static tools listed');
  if (({ toolHints: true, ...config }).toolHints === true && advert.toolHints === true) {
    await waitFor(() => server.received.some((m) => m.method === 'toolsets/list'), 'toolsets/list after connecting');
    await fw.framework.executeToolCall({ id: 'sync', name: 'arc--status', input: {} } as never);
  }
  const methods = () => server.received.map((m) => m.method).filter((m) => typeof m === 'string');
  return {
    fw, server, state, methods,
    async done() { await fw.stop(); await server.close(); },
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const roundTrip = (t: { fw: Awaited<ReturnType<typeof setup>>['fw'] }) => t.fw.framework.executeToolCall({ id: 'sync', name: 'arc--status', input: {} } as never);
const nextMacrotask = () => new Promise((r) => setImmediate(r));
const present = (tools: Json[], name: string, presence: 'static' | 'dynamic') => {
  const tool = tools.find((x) => x.name === name)!;
  tool._meta = { ...(tool._meta as Json | undefined), 'mcpl/presence': presence };
};
const look = async (fw: Awaited<ReturnType<typeof setup>>['fw'], input: Json = { server: 'arc' }) => resultText(await callTool(fw.framework, 'toolsets--look', input));
const push = (peer: ScriptedPeer, eventId: string, text: string, extra: Json = {}) => peer.request('push/event', {
  featureSet: 'arc.events', eventId, timestamp: new Date().toISOString(), payload: { content: [{ type: 'text', text }] }, ...extra,
});

test("a toolset's options read as an object of its parameters, as the listing's docs show them", () => {
  assert.equal(objectSignature({ type: 'object', properties: { size: { type: 'integer', enum: [9, 13, 19], default: 9 } } }), '{size?: 9|13|19 =9}');
  assert.equal(objectSignature({ type: 'object', properties: {} }), '{}');
});

test('toolHints off: the advertisement, tool list and traffic are as before', async () => {
  const t = await setup(() => false, { toolHints: false });
  const { toolHints: _hints, toolsets: _toolsets, surface: _surface, ...plainAdvert } = ADVERT;
  const plain = await setup(() => false, { toolHints: false }, plainAdvert);
  try {
    const offered = t.server.peer.hostCaps?.mcpl as Json;
    assert.ok(!('toolHints' in offered) && !('toolsets' in offered) && !('surface' in offered), 'nothing of RFC-014 offered');
    assert.deepEqual(offered, plain.server.peer.hostCaps?.mcpl, 'the offer a server that doesn\'t advertise toolHints gets');
    const arcTools = t.fw.framework.getAllTools().filter((x) => x.name.startsWith('arc--'))
      .map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }));
    assert.deepEqual(arcTools, TOOLS.map((x) => ({ name: `arc--${String(x.name)}`, description: x.description, inputSchema: x.inputSchema })),
      'every tool listed whole, in the server\'s order, as before');
    // The meta-tools are every agent's now (the host's built-in toolset), whatever a server's hints.
    assert.ok(t.fw.framework.getAllTools().some((x) => x.name === 'toolsets--open'), 'the host\'s meta-tools');
    assert.ok(!t.methods().some((m) => String(m).startsWith('toolsets/')), 'no toolsets/* request of any kind');
    // A tools/hints request is a method this host doesn't handle, as before.
    const answer = await t.server.peer.request('tools/hints', { rev: 1, tools: [{ name: 'peek', visible: true }] });
    assert.equal((answer.error as Json).code, -32601);
    // A push's hints are not read: its content reaches the window unchanged.
    await push(t.server.peer, 'p1', 'something happened', { hints: { rev: 1, tools: [{ name: 'peek', visible: true }] } });
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('something happened')), 'push stored');
    assert.ok(!windowText(t.fw.framework).some((x) => x.includes('tools now')), 'no announcement');
    // A call carries no _meta.
    await t.fw.framework.executeToolCall({ id: 'c1', name: 'arc--play', input: { point: 'D4' } } as never);
    const call = t.server.received.find((m) => m.method === 'tools/call')!;
    assert.ok(!('_meta' in (call.params as Json)), 'no _meta on the call');
  } finally {
    await t.done();
    await plain.done();
  }
});

test('vector 3, 11: a push\'s hints apply on arrival whatever is decided about the push; nothing is restated', async () => {
  const t = await setup();
  try {
    // Accepted: the change is told after the event's own content.
    const accepted = await push(t.server.peer, 'p1', 'White played E5', { hints: t.state.hint([{ name: 'peek', visible: true }]) });
    assert.equal((accepted.result as Json).accepted, true);
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('White played E5') && x.includes('[arc] tools now')), 'push stored with its change');
    // Refused (an undeclared feature set): applied all the same, and told on its own.
    const refused = await push(t.server.peer, 'p2', 'nobody hears this', { featureSet: 'arc.nope', hints: t.state.hint([{ name: 'peek', visible: false }]) });
    assert.ok(refused.error, 'the push was refused');
    await waitFor(() => windowText(t.fw.framework).some((x) => x.startsWith('[toolsets] MCPL server "arc", tool changes:\n') && x.includes('now unavailable: peek')), 'the refused push\'s change applied, and told as a notice that opens with its tag');
    // The next change has the next rev and applies without any recovery.
    const lists = t.methods().filter((m) => m === 'tools/list').length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('tool changes') && x.includes('peek()')), 'the next change applied, and told');
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    assert.equal(t.methods().filter((m) => m === 'tools/list').length, lists, 'no recovery');
  } finally { await t.done(); }
});

test('vector 4, 12: a skipped rev recovers through tools/list, then toolsets/list, including an instance\'s own definition', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    const p = msg.params as Json;
    state.open.push({ toolset: 'game', instance: p.instance, title: `Game ${String(p.instance)}` });
    peer.reply(msg.id, { toolset: 'game', instance: p.instance, title: `Game ${String(p.instance)}`, _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: p.instance, visible: true }]) } });
    return true;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    const before = t.server.received.length;
    // rev+1 is lost (never read): the server's next change carries rev+2.
    t.state.next();
    t.state.statement = [{ name: 'play', instance: 'g1', visible: true, definition: { name: 'play', description: 'Play one of the legal points.', inputSchema: { type: 'object', properties: { point: { enum: ['C3'] } }, required: ['point'] } } }];
    t.server.peer.notify('tools/hints', { rev: t.state.next(), tools: [] });
    await waitFor(() => t.server.received.slice(before).some((m) => m.method === 'toolsets/list'), 'recovery read toolsets/list');
    const recovery = t.server.received.slice(before).map((m) => m.method).filter((m) => m === 'tools/list' || m === 'toolsets/list');
    assert.deepEqual(recovery, ['tools/list', 'toolsets/list'], 'tools/list first');
    await roundTrip(t);
    // The instance's own definition from the statement is what the host checks against.
    const refused = await callTool(t.fw.framework, 'toolsets--act', { tool: 'play', instance: 'g1', args: { point: 'D4' } });
    assert.ok(refused.isError);
    assert.match(resultText(refused), /must be one of "C3"/);
  } finally { await t.done(); }
});

test('vector 10: an undeclared toolset is the host\'s to open; no toolsets/open is sent and closed calls are gated', async () => {
  const t = await setup();
  try {
    const gated = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'dig', args: {} });
    assert.ok(gated.isError);
    assert.match(resultText(gated), /dig is in cave, which isn't open/);
    const opened = await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'cave' });
    assert.match(resultText(opened), /\[arc\/cave\] open\.\n.*dig\(\)/s);
    const dug = await callTool(t.fw.framework, 'toolsets--act', { tool: 'dig', args: {} });
    assert.ok(!dug.isError, resultText(dug));
    await callTool(t.fw.framework, 'toolsets--close', { server: 'arc', toolset: 'cave' });
    const again = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'dig', args: {} });
    assert.ok(again.isError, 'gated again once closed');
    assert.ok(!t.methods().includes('toolsets/open') && !t.methods().includes('toolsets/close'), 'the server was never told');
    assert.equal(t.server.received.filter((m) => m.method === 'tools/call' && (m.params as Json).name === 'dig').length, 1, 'only the call made while open was sent');
  } finally { await t.done(); }
});

test('vector 13: an ended record is told once, however often the host reconnects', async () => {
  const t = await setup(() => false, { reconnect: true, reconnectIntervalMs: 50 });
  try {
    t.state.ended = [{ id: 'e7', toolset: 'game', instance: 'g9', reason: 'idle for 30 minutes' }];
    for (let i = 0; i < 2; i++) {
      const lists = t.methods().filter((m) => m === 'toolsets/list').length;
      t.state.rev = 0;
      t.server.peer.ws.terminate();
      await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, `toolsets/list after reconnect ${i + 1}`);
      await roundTrip(t);
    }
    const told = windowText(t.fw.framework).filter((x) => x.includes('[arc/game:g9] ended: idle for 30 minutes'));
    assert.equal(told.length, 1, 'told once');
  } finally { await t.done(); }
});

test('vectors 21, 22: a definition changes only its instance\'s description and schema', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    const p = msg.params as Json;
    state.open.push({ toolset: 'game', instance: p.instance });
    peer.reply(msg.id, { toolset: 'game', instance: p.instance, title: String(p.instance), _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: p.instance, visible: true }]) } });
    return true;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'a' });
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'b' });
    // a's own definition, whose _meta claims another toolset and static presence.
    t.server.peer.notify('tools/hints', t.state.hint([{
      name: 'play', instance: 'a', visible: true,
      definition: { name: 'renamed', description: 'Play a legal point.', inputSchema: { type: 'object', properties: { point: { enum: ['A1'] } }, required: ['point'] }, _meta: { 'mcpl/toolset': 'build', 'mcpl/presence': 'static' } },
    }]));
    await roundTrip(t);
    const names = t.fw.framework.getAllTools().map((x) => x.name);
    assert.ok(!names.includes('arc--play') && !names.includes('arc--renamed'), 'still out of the tool list (presence unchanged)');
    const onA = await callTool(t.fw.framework, 'toolsets--act', { tool: 'play', instance: 'a', args: { point: 'B2' } });
    assert.ok(onA.isError, 'checked against a\'s definition');
    const onB = await callTool(t.fw.framework, 'toolsets--act', { tool: 'play', instance: 'b', args: { point: 'B2' } });
    assert.ok(!onB.isError, resultText(onB));
    const sent = t.server.received.filter((m) => m.method === 'tools/call' && (m.params as Json).name === 'play');
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0]!.params as Json)._meta, { 'mcpl/instance': 'b' });
    const all = await look(t.fw);
    assert.match(all, /\[arc\/game:a\][^\n]*\n\s+play\(point: "A1"\)/, 'a has its own definition, under its own name');
    assert.match(all, /\[arc\/game:b\][^\n]*\n\s+play\(point: string\)/, 'b keeps the declared one');
    assert.doesNotMatch(all, /\[arc\/build\]/, 'no other toolset');
  } finally { await t.done(); }
});

test('vectors 23, 38: toolsets/list is a full statement; an empty one clears what the host believed', async () => {
  const t = await setup();
  try {
    t.state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }, { toolset: 'build', title: 'B' }];
    t.state.statement = [{ name: 'play', instance: 'g1', visible: true }, { name: 'place', visible: true }, { name: 'peek', visible: true }, { name: 'dig', visible: true }];
    await look(t.fw); // look re-reads toolsets/list
    let all = await look(t.fw);
    assert.match(all, /\[arc\/game:g1\] G1 tools now[^\n]*\n\s+play/);
    assert.match(all, /\[arc\/build\] B tools now[^\n]*\n\s+place/);
    assert.match(all, /peek\(\)/);
    // Not stated visible in g1 any more: invisible there. Nothing visible at all: everything goes.
    t.state.statement = [];
    all = await look(t.fw);
    assert.match(all, /\[arc\/game:g1\] G1 no tools available right now\./);
    assert.match(all, /\[arc\/build\] B no tools available right now\./);
    assert.doesNotMatch(all, /peek\(/);
  } finally { await t.done(); }
});

test('vector 27: open, close and list results take the next rev; tools/list takes none', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'build', title: 'B' }];
      peer.reply(msg.id, { toolset: 'build', title: 'B', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
      return true;
    }
    if (msg.method === 'toolsets/close') {
      state.open = [];
      peer.reply(msg.id, { content: [{ type: 'text', text: 'packed up' }], _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: false }], { toolsets: [{ toolset: 'build', state: 'closed' }] }) } });
      return true;
    }
    return false;
  });
  try {
    const lists = () => t.methods().filter((m) => m === 'tools/list').length;
    const before = lists();
    const opened = await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    assert.match(resultText(opened), /place\(x\?: int\)/);
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => lists() > before, 'a tools/list between the open\'s rev and the close\'s');
    await roundTrip(t);
    const closed = await callTool(t.fw.framework, 'toolsets--close', { server: 'arc' });
    assert.match(resultText(closed), /packed up\n\[arc\/build\] closed\. Now unavailable: place\./);
    await look(t.fw); // a toolsets/list, rev after the close's
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    assert.equal(lists(), before + 1, 'every rev was the next one: no recovery');
  } finally { await t.done(); }
});

test('vector 28: the hints of a result that arrives after its timeout are applied, and told', async () => {
  let held: { id: unknown; peer: ScriptedPeer } | null = null;
  const t = await setup((msg, peer) => {
    if (msg.method === 'tools/call' && (msg.params as Json).name === 'status') { held = { id: msg.id, peer }; return true; }
    return false;
  }, { requestTimeoutMs: 300 });
  try {
    const result = await t.fw.framework.executeToolCall({ id: 'slow', name: 'arc--status', input: {} } as never);
    assert.ok(result.isError, 'timed out');
    assert.ok(held, 'the call reached the server');
    const h = held as unknown as { id: unknown; peer: ScriptedPeer };
    h.peer.reply(h.id, { content: [{ type: 'text', text: 'late' }], _meta: { 'mcpl/hints': t.state.hint([{ name: 'peek', visible: true }]) } });
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('tool changes') && x.includes('peek()')), 'the late change told');
    assert.match(await look(t.fw), /peek\(\)/);
  } finally { await t.done(); }
});

test('a close answered after its timeout still closes the instance it named, and is told', async () => {
  let held: { id: unknown; peer: ScriptedPeer } | null = null;
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/close') { held = { id: msg.id, peer }; return true; }
    if (msg.method !== 'toolsets/open') return false;
    state.open.push({ toolset: 'game', instance: 'g1' });
    peer.reply(msg.id, { toolset: 'game', instance: 'g1', _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: true }]) } });
    return true;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    const connection = (t.fw.framework as unknown as { mcplServerRegistry: { getServer(id: string): { sendToolsetsClose(p: Json, ms: number): Promise<unknown> } } })
      .mcplServerRegistry.getServer('arc');
    await assert.rejects(connection.sendToolsetsClose({ toolset: 'game', instance: 'g1' }, 300));
    await waitFor(() => held !== null, 'the close reached the server');
    const h = held as unknown as { id: unknown; peer: ScriptedPeer };
    h.peer.reply(h.id, { content: [] });
    await waitFor(() => notices(t.fw).some((x) => x.includes('[arc/game:g1] closed.')), 'the late close told');
  } finally { await t.done(); }
});

test('vector 30: a duplicate eventId\'s hints are ignored', async () => {
  const t = await setup();
  try {
    await push(t.server.peer, 'same', 'first', { hints: t.state.hint([{ name: 'peek', visible: true }]) });
    // A conforming server never sends this (a push is never retried); its
    // hints, read again, are ignored. The statement stays as the first left it.
    await push(t.server.peer, 'same', 'again', { hints: { rev: t.state.next(), tools: [{ name: 'peek', visible: false }] } });
    await settle();
    const presence = (t.fw.framework as unknown as { toolsetHub: { get(id: string): { presence: { view(): Map<string, { tools: Map<string, unknown> }> } } } })
      .toolsetHub.get('arc').presence;
    assert.ok([...presence.view().values()].some((e) => e.tools.has('peek')), 'the repeat changed nothing');
  } finally { await t.done(); }
});

test('vector 33: a manifest change that removes a toolset closes its instances', async () => {
  let advert: Json = ADVERT;
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'mcpl/manifest') { peer.reply(msg.id, { version: '0.5', pushEvents: true, ...advert }); return true; }
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'build', title: 'B' }];
      peer.reply(msg.id, { toolset: 'build', title: 'B', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
      return true;
    }
    return false;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    advert = { ...ADVERT, toolsets: { game: (ADVERT.toolsets as Json).game } };
    t.server.peer.notify('mcpl/manifestChanged', { revision: 'r2', domains: ['toolsets'] });
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('[arc/build] closed')), 'the close told');
    assert.doesNotMatch(await look(t.fw), /\[arc\/build\]/);
  } finally { await t.done(); }
});

test('a manifest change that removes a toolset closes each of its open instances', async () => {
  let advert: Json = ADVERT;
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'mcpl/manifest') { peer.reply(msg.id, { version: '0.5', pushEvents: true, ...advert }); return true; }
    if (msg.method === 'toolsets/open') {
      const instance = String((msg.params as Json).instance);
      state.open = [...state.open, { toolset: 'game', instance, title: instance.toUpperCase() }];
      peer.reply(msg.id, { toolset: 'game', instance, title: instance.toUpperCase(), _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance, visible: true }]) } });
      return true;
    }
    return false;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g2' });
    advert = { ...ADVERT, toolsets: { build: (ADVERT.toolsets as Json).build } };
    t.server.peer.notify('mcpl/manifestChanged', { revision: 'r2', domains: ['toolsets'] });
    await waitFor(() => ['[arc/game:g1] closed', '[arc/game:g2] closed'].every((line) => windowText(t.fw.framework).some((x) => x.includes(line))), 'both closes told');
    assert.doesNotMatch(await look(t.fw), /\[arc\/game:/);
  } finally { await t.done(); }
});

test('a manifest change that withdraws toolHints makes every tool static, and the agent is told', async () => {
  let advert: Json = ADVERT;
  const t = await setup((msg, peer) => {
    if (msg.method === 'mcpl/manifest') { peer.reply(msg.id, { version: '0.5', pushEvents: true, ...advert }); return true; }
    return false;
  });
  try {
    const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
    assert.ok(!listed().includes('arc--peek'), 'a dynamic tool, while hints apply');
    const { toolHints: _withdrawn, toolsets: _gone, ...rest } = ADVERT;
    advert = rest;
    t.server.peer.notify('mcpl/manifestChanged', { revision: 'r2', domains: ['toolsets'] });
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('arc no longer presents toolsets: its tools are called directly now, by name, not through toolsets--act.')), 'the withdrawal told');
    await waitFor(() => ['play', 'place', 'dig', 'peek'].every((tool) => listed().includes(`arc--${tool}`)), 'every tool listed');
  } finally { await t.done(); }
});

test('vector 34: a server with toolHints and no declared toolsets states its dynamic tools in toolsets/list', async () => {
  const advert: Json = { toolHints: true, featureSets: ADVERT.featureSets };
  const tools = [TOOLS[0]!, TOOLS[4]!];
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/list') return false;
    peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: state.next(), tools: [{ name: 'peek', visible: true, definition: { description: 'Peek at the room you are in.', inputSchema: { type: 'object', properties: { far: { type: 'boolean' } } } } }] } } });
    return true;
  }, {}, advert, tools);
  try {
    const all = await look(t.fw);
    assert.match(all, /\[arc\] tools now[^\n]*\n\s+peek\(far\?: boolean\) — Peek at the room you are in\./);
    assert.ok(!t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'));
  } finally { await t.done(); }
});

test('suggestions are shown, never acted on', async () => {
  const t = await setup();
  try {
    t.server.peer.notify('tools/hints', { rev: t.state.next(), suggest: [{ toolset: 'game', action: 'open', reason: 'a challenger is waiting' }] });
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('arc suggests opening game: a challenger is waiting')), 'suggestion told');
    await settle();
    assert.ok(!t.methods().includes('toolsets/open'), 'nothing was opened');
  } finally { await t.done(); }
});

test('reminders: an open toolset whose announcement left the context is restated once, at the next start', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    state.open = [{ toolset: 'build', title: 'Workshop' }];
    peer.reply(msg.id, { toolset: 'build', title: 'Workshop', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
    return true;
  });
  const { createMockResponse } = await import('./helpers/mock-membrane.js');
  const turn = async (scripted = false) => {
    const n = t.fw.membrane.calls.length;
    if (!scripted) t.fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    t.fw.framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as never);
    await waitFor(() => t.fw.membrane.calls.length > n && t.fw.framework.getAgent('scout')!.state.status === 'idle', 'the turn\'s request made and the turn ended');
    return JSON.stringify(t.fw.membrane.calls[n]!.messages);
  };
  try {
    // The agent opens the toolset itself; the announcement is in its tool result.
    t.fw.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'toolu_open', name: 'toolsets--open', input: { server: 'arc', toolset: 'build' } }] as never, 'tool_use'));
    t.fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'opened' }]));
    await turn(true);
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('[arc/build] Workshop')), 'the open stored');
    assert.match(await turn(), /\[arc\/build\]/, 'the announcement is in view');
    // It leaves the context (as a fold or the window would take it).
    const cm = t.fw.framework.getAgent('scout')!.getContextManager();
    for (const m of cm.getAllMessages()) {
      if (JSON.stringify(m.content).includes('toolu_open')) cm.removeMessage(m.id);
    }
    assert.doesNotMatch(await turn(), /\[arc\/build\]/, 'gone from this request');
    const reminded = await turn();
    assert.match(reminded, /Open toolsets \(a reminder/);
    assert.ok(reminded.includes('[arc/build] Workshop tools now') && reminded.includes('place(x?: int) — Place a block.'), 'its current tools, described');
    assert.match(reminded, /"participant":"system_context:mcpl-toolsets"/, 'a stored afterUser injection');
    assert.match(reminded, /toolsets--close \{server:\\"arc\\", toolset:\\"build\\"\} closes it\./);
    const once = await turn();
    assert.equal(once.split('Open toolsets (a reminder').length - 1, 1, 'stored once, not again');
  } finally { await t.done(); }
});

for (const [label, toolHints] of [['left out', undefined], ['null', null]] as const) {
  test(`toolHints ${label} is on: the hints are offered, the meta-tools registered, and the server's dynamic tools leave the list`, async () => {
    const t = await setup(() => false, { toolHints: toolHints as unknown as boolean });
    try {
      const offered = t.server.peer.hostCaps?.mcpl as Json;
      assert.equal(offered.toolHints, true, 'toolHints offered');
      const names = t.fw.framework.getAllTools().map((x) => x.name);
      for (const meta of ['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close']) assert.ok(names.includes(meta), meta);
      await waitFor(() => t.server.received.some((m) => m.method === 'toolsets/list'), 'toolsets/list after connecting');
      await roundTrip(t);
      await waitFor(() => !t.fw.framework.getAllTools().some((x) => x.name === 'arc--play'), 'a toolset tool leaves the list');
      assert.ok(t.fw.framework.getAllTools().some((x) => x.name === 'arc--status'), 'a static tool stays');
    } finally { await t.done(); }
  });
}

test('toolHints left out, on a server that does not advertise them: the hints are offered, and its tools are listed whole as before, beside the meta-tools', async () => {
  const { toolHints: _hints, toolsets: _toolsets, surface: _surface, ...plainAdvert } = ADVERT;
  const t = await setup(() => false, { toolHints: undefined }, plainAdvert);
  try {
    assert.equal((t.server.peer.hostCaps?.mcpl as Json).toolHints, true, 'toolHints offered');
    const arcTools = t.fw.framework.getAllTools().filter((x) => x.name.startsWith('arc--'))
      .map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }));
    assert.deepEqual(arcTools, TOOLS.map((x) => ({ name: `arc--${String(x.name)}`, description: x.description, inputSchema: x.inputSchema })),
      'every tool listed whole, in the server\'s order, as before');
    assert.equal(t.fw.framework.getAllTools().filter((x) => x.name.startsWith('toolsets--')).length, 4, 'the four meta-tools');
    await roundTrip(t);
    assert.ok(!t.methods().some((m) => String(m).startsWith('toolsets/')), 'no toolsets/* request to a server without hints');
  } finally { await t.done(); }
});

test('at startup a toolPrefix of toolsets is refused, with or without toolHints: the name is the framework\'s from creation', async () => {
  // A configuration that loaded when hints were opt-in, with its prefix
  // taking the name, would leave every agent without the meta-tools the
  // host's built-in toolset needs; it's refused instead (only a module given
  // to create() keeps the name, below).
  const dead = { url: 'ws://127.0.0.1:9/mcpl', reconnect: false };
  for (const [label, servers] of [
    ['hints left out', [{ id: 'ts', toolPrefix: 'toolsets', ...dead }, { id: 'arc', toolPrefix: 'arc', ...dead }]],
    ['hints off on it', [{ id: 'ts', toolPrefix: 'toolsets', toolHints: false, ...dead }]],
    ['hints asked elsewhere', [{ id: 'ts', toolPrefix: 'toolsets', ...dead }, { id: 'arc', toolPrefix: 'arc', toolHints: true, ...dead }]],
  ] as const) {
    await assert.rejects(makeFramework(servers as unknown as McplServerConfig[]), /toolPrefix "toolsets" collides with module "toolsets"/, label);
  }
});

/** A module that holds the name `toolsets` for itself (a host's own). */
class HostToolsets {
  readonly name = 'toolsets';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return [{ name: 'mine', description: 'The host\'s own.', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall() { return { success: true, data: 'mine' }; }
  async onProcess() { return {}; }
}

/** The reference arc server with a fresh State, for a runtime connect. */
async function arcServer() {
  const state = new State();
  return startScriptedServer({
    advert: ADVERT, tools: TOOLS, listRev: () => state.rev,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, state.listResult()); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
}

const META = ['toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close'];
const metaTools = (fw: Awaited<ReturnType<typeof makeFramework>>) => fw.framework.getAllTools().filter((x) => META.includes(x.name)).map((x) => x.name);

test('a runtime connect of a server that leaves toolHints out gets hints: offered, the meta-tools there from creation, its toolset tools out of the list', async () => {
  const server = await arcServer();
  const fw = await makeFramework([]);
  try {
    // The host's own toolsets (the built-in one) need them, MCPL or none.
    assert.deepEqual(metaTools(fw).sort(), [...META].sort(), 'the meta-tools before any server');
    await fw.framework.connectMcplServer({ id: 'arc', toolPrefix: 'arc', url: server.url });
    assert.equal((server.peer.hostCaps?.mcpl as Json).toolHints, true, 'toolHints offered');
    assert.deepEqual(metaTools(fw).sort(), [...META].sort(), 'the same meta-tools after the connect');
    await waitFor(() => server.received.some((m) => m.method === 'toolsets/list'), 'toolsets/list after connecting');
    await waitFor(() => !fw.framework.getAllTools().some((x) => x.name === 'arc--play'), 'a toolset tool leaves the list: the read tap is on');
    assert.ok(fw.framework.getAllTools().some((x) => x.name === 'arc--status'), 'a static tool stays');
  } finally { await fw.stop(); await server.close(); }
});

test('a module named toolsets at startup keeps the name: a server that leaves toolHints out loads without hints, and the line names the module', async () => {
  const server = await arcServer();
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let fw: Awaited<ReturnType<typeof makeFramework>> | undefined;
  try {
    fw = await makeFramework([{ id: 'arc', toolPrefix: 'arc', url: server.url }], { modules: [new HostToolsets() as never] });
  } finally { console.error = realError; }
  try {
    await waitFor(() => fw!.framework.getAllTools().some((x) => x.name === 'arc--play'), 'every tool listed');
    assert.ok(!('toolHints' in (server.peer.hostCaps?.mcpl as Json)), 'no hints offered');
    assert.ok(fw.framework.getAllTools().some((x) => x.name === 'toolsets--mine'), 'the host\'s own module stays');
    assert.deepEqual(metaTools(fw), []);
    assert.ok(logged.some((l) => l.includes('tool hints (RFC-014) are off for arc') && l.includes('module "toolsets"')), logged.join(' | '));
  } finally { await fw.stop(); await server.close(); }
});

test('at runtime the name toolsets is the framework\'s: a host module or a server prefix can\'t take it, and a restart\'s claim on it leaves a server that omits toolHints without hints', async () => {
  // The framework's own toolsets module holds the name from creation (the
  // host's built-in toolset needs it), so only a module registered at
  // creation can keep the name, as the test above shows.
  {
    const fw = await makeFramework([]);
    try {
      await assert.rejects(fw.framework.addModule(new HostToolsets() as never), /already registered: toolsets/);
    } finally { await fw.stop(); }
  }
  for (const [label, config] of [
    ['another server\'s prefix', { id: 'ts', toolPrefix: 'toolsets', toolHints: false }],
    ['its own prefix', { id: 'arc', toolPrefix: 'toolsets' }],
  ] as const) {
    const server = await arcServer();
    const fw = await makeFramework([]);
    try {
      await assert.rejects(fw.framework.connectMcplServer({ url: server.url, ...config } as McplServerConfig), /collides with module "toolsets"/, label);
    } finally { await fw.stop(); await server.close(); }
  }
  // A restart moving a server to the prefix holds the name as a claim, in
  // the window between its disconnect and its connect.
  const server = await arcServer();
  const fw = await makeFramework([]);
  try {
    (fw.framework as unknown as { restartClaims(): { prefixes: Map<string, unknown> } }).restartClaims().prefixes.set('toolsets', { restarting: 'mover' });
    await fw.framework.connectMcplServer({ id: 'arc', url: server.url, toolPrefix: 'arc' });
    assert.ok(!('toolHints' in (server.peer.hostCaps?.mcpl as Json)), 'a restart\'s claim: no hints offered');
  } finally { await fw.stop(); await server.close(); }
});

test('a modern server that leaves toolHints out has no hints: no controller at startup or at a runtime connect', async () => {
  const modern = { url: 'http://127.0.0.1:9/mcp', reconnect: false };
  const fw = await makeFramework([{ id: 'plain', toolPrefix: 'plain', ...modern }]);
  const hub = () => (fw.framework as unknown as { toolsetHub: { get(id: string): unknown } | null }).toolsetHub;
  try {
    // The meta-tools are the host's own now; a modern server just has no hints.
    assert.equal(hub()?.get('plain'), undefined, 'none at startup');
    // A modern runtime connect takes no hints path at all; this pins that it stays so.
    await fw.framework.connectMcplServer({ id: 'plain2', toolPrefix: 'plain2', ...modern }).catch(() => {});
    assert.equal(hub()?.get('plain2'), undefined, 'none after a runtime connect');
  } finally { await fw.stop(); }
});

test('a server that leaves toolHints out keeps its toolset state across a restart under the same configuration, as one with true does', async () => {
  const t = await setup(() => false, { toolHints: undefined });
  try {
    await waitFor(() => t.server.received.some((m) => m.method === 'toolsets/list'), 'toolsets/list after connecting');
    await roundTrip(t);
    // What the agent was told is the state kept for a next connection: an
    // ended record the server reports after each restart is told once.
    t.state.ended = [{ id: 'e7', toolset: 'game', instance: 'g9', reason: 'idle for 30 minutes' }];
    for (let i = 0; i < 2; i++) {
      const lists = t.methods().filter((m) => m === 'toolsets/list').length;
      t.state.rev = 0;
      await t.fw.framework.restartMcplServer('arc', { id: 'arc', toolPrefix: 'arc', url: t.server.url });
      await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, `toolsets/list after restart ${i + 1}`);
      await roundTrip(t);
    }
    const told = windowText(t.fw.framework).filter((x) => x.includes('[arc/game:g9] ended: idle for 30 minutes'));
    assert.equal(told.length, 1, 'told once, across both restarts');
  } finally { await t.done(); }
});

test('a hinted server restarted into a modern configuration under its id leaves no toolset state behind', async () => {
  const t = await setup();
  try {
    assert.match(await look(t.fw), /Game/, 'the toolsets are shown before the restart');
    await t.fw.framework.restartMcplServer('arc', { id: 'arc', toolPrefix: 'arc', url: 'http://127.0.0.1:9/mcp', reconnect: false }).catch(() => {});
    assert.doesNotMatch(await look(t.fw, {}), /Game|arc\/game/, 'nothing of the old server\'s toolsets is shown');
    // Nor kept: a modern server never has a controller, so the old one's state (open toolsets, ended ids) is forgotten.
    const hub = (t.fw.framework as unknown as { toolsetHub: { get(id: string): unknown } | null }).toolsetHub;
    assert.equal(hub?.get('arc'), undefined, 'no controller kept for the id');
  } finally { await t.done(); }
});

test('toolHints is a boolean, and only for an MCPL server', () => {
  assert.throws(() => assertServerConfigBooleans({ id: 's', url: 'ws://127.0.0.1:1/mcpl', toolHints: 'false' as unknown as boolean }), /toolHints/);
  assert.doesNotThrow(() => assertServerConfigBooleans({ id: 's', url: 'ws://127.0.0.1:1/mcpl', toolHints: null as unknown as boolean }));
  assert.ok(serverConfigProblems({ id: 's', url: 'https://example.invalid/mcp', toolHints: true }).some((p) => p.includes('"toolHints"')),
    'a modern server refuses it');
  assert.deepEqual(serverConfigProblems({ id: 's', url: 'https://example.invalid/mcp', toolHints: false }), []);
  assert.deepEqual(serverConfigProblems({ id: 's', url: 'https://example.invalid/mcp' }), [], 'a modern server takes the default: it can\'t negotiate hints, so it is offered none');
  assert.deepEqual(serverConfigProblems({ id: 's', url: 'ws://127.0.0.1:1/mcpl', toolHints: true }), []);
});

test('act and a direct call behave alike: state exchange, lifecycle, results; only _meta differs', async () => {
  const { createMockResponse } = await import('./helpers/mock-membrane.js');
  const state = new State();
  let n = 0;
  const calls: Json[] = [];
  const advert: Json = {
    ...ADVERT,
    // Host-managed state: each call is sent the state the last one returned.
    featureSets: { 'arc.tools': { description: 'tools', uses: ['tools'], hostState: true }, 'arc.events': { description: 'events', uses: ['pushEvents'] } },
  };
  const server = await startScriptedServer({
    advert, tools: TOOLS, listRev: () => state.rev,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') { peer.reply(msg.id, state.listResult()); return; }
      if (msg.method === 'toolsets/open') {
        state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
        peer.reply(msg.id, { toolset: 'game', instance: 'g1', title: 'G1', _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: true }]) } });
        return;
      }
      if (msg.method === 'tools/call') {
        const p = msg.params as Json;
        calls.push(p);
        n++;
        const hides = p.name === 'play' ? { _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: false }]) } } : {};
        peer.reply(msg.id, { content: [{ type: 'text', text: `${String(p.name)} ran` }], state: { checkpoint: `c${n}`, parent: n > 1 ? `c${n - 1}` : null, data: { n } }, ...hides });
        return;
      }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  // A second server observes tool use (RFC-007), metadata only.
  const lifecycle: Json[] = [];
  const observer = await startScriptedServer({
    advert: { toolLifecycle: { observe: true }, featureSets: { 'obs.watch': { description: 'watch', uses: ['toolLifecycle.observe'] } } },
    tools: [],
    on: (msg) => { if (msg.method === 'tools/lifecycle') lifecycle.push(msg.params as Json); },
  });
  const fw = await makeFramework([
    { id: 'arc', toolPrefix: 'arc', url: server.url, toolHints: true },
    { id: 'obs', toolPrefix: 'obs', url: observer.url, toolLifecycle: { observe: {} } },
  ] as McplServerConfig[]);
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  fw.framework.onTrace((e: unknown) => traces.push(e as never));
  try {
    await waitFor(() => fw.framework.getAllTools().some((t) => t.name === 'arc--status') && server.received.some((m) => m.method === 'toolsets/list'), 'connected');
    await callTool(fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    const use = (id: string, name: string, input: Json) => createMockResponse([{ type: 'tool_use', id, name, input }] as never, 'tool_use');
    fw.membrane.pushResponse(use('toolu_01AAAAAAAAAAAAAAAAAAAAAA', 'arc--status', {}));
    fw.membrane.pushResponse(use('toolu_01BBBBBBBBBBBBBBBBBBBBBB', 'toolsets--act', { tool: 'play', args: { point: 'D4' } }));
    fw.membrane.pushResponse(use('toolu_01CCCCCCCCCCCCCCCCCCCCCC', 'arc--status', {}));
    fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    fw.framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as never);
    await waitFor(() => calls.length === 3, 'three calls');
    await waitFor(() => fw.membrane.lastStream?.receivedToolResults.length === 3, 'three results returned');

    // Each call starts under its own tool's name, act's as a direct call's.
    const started = traces.filter((e) => e.type === 'tool:started').map((e) => `${String(e.module)}:${String(e.tool)}`);
    assert.deepEqual(started, ['mcpl:arc:status', 'mcpl:arc:play', 'mcpl:arc:status']);
    // The state exchange runs through act as through a direct call: each call
    // is sent the state the one before it returned.
    assert.deepEqual(calls.map((c) => c.state ?? null), [null, { n: 1 }, { n: 2 }]);
    // Only the instance is added.
    assert.deepEqual(calls.map((c) => c._meta ?? null), [null, { 'mcpl/instance': 'g1' }, null]);
    // RFC-007 observers see the server's tool, not the meta-tool.
    await waitFor(() => lifecycle.filter((p) => p.phase === 'started').length === 3, 'three openings observed');
    const opened = lifecycle.filter((p) => p.phase === 'started').map((p) => `${String(p.serverId)}:${String(p.serverTool)}:${String(p.tool)}`);
    assert.deepEqual(opened, ['arc:status:arc--status', 'arc:play:arc--play', 'arc:status:arc--status']);
    // The act's result, as the model got it, shows the change its call made,
    // and no notice repeats it.
    const results = JSON.stringify(fw.membrane.lastStream!.receivedToolResults);
    assert.match(results, /play ran/);
    assert.match(results, /now unavailable: play/);
    await nextMacrotask();
    assert.ok(!windowText(fw.framework).some((t) => t.includes('tool changes') && t.includes('now unavailable: play')), 'told once, in the result');
  } finally {
    await fw.stop();
    await server.close();
    await observer.close();
  }
});

test('a hint change in the result of a call whose result the agent doesn\'t see is told as a notice', async () => {
  let reacting = false;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/call' || !reacting) return false;
    peer.reply(msg.id, { content: [{ type: 'text', text: 'reacted' }], _meta: { 'mcpl/hints': state.hint([{ name: 'peek', visible: true }]) } });
    return true;
  });
  try {
    // As the framework's own calls (a reaction, a send) are made: straight on the connection.
    const connection = (t.fw.framework as unknown as { mcplServerRegistry: { getServer(id: string): { sendToolsCall(n: string, a: object): Promise<unknown> } } })
      .mcplServerRegistry.getServer('arc');
    reacting = true;
    await connection.sendToolsCall('status', {});
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('tool changes') && x.includes('peek()')), 'told as a notice');
  } finally { await t.done(); }
});

test('close refuses an instance for a toolset without instances, and sends nothing', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'build', title: 'B' }];
      peer.reply(msg.id, { toolset: 'build', title: 'B', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
      return true;
    }
    return false;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    const r = await callTool(t.fw.framework, 'toolsets--close', { server: 'arc', toolset: 'build', instance: 'x' });
    assert.ok(r.isError);
    assert.match(resultText(r), /arc\/build has no instances: close it without one/);
    assert.ok(!t.methods().includes('toolsets/close'), 'nothing sent');
  } finally { await t.done(); }
});

test('a selector that is there but isn\'t a name is refused, not read as left out: nothing is closed or called', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
      peer.reply(msg.id, { toolset: 'game', instance: 'g1', title: 'G1', _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: true }]) } });
      return true;
    }
    return false;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game' });
    const refusals: Array<[string, Json, RegExp]> = [
      ['toolsets--close', { server: 'arc', toolset: 'game', instance: '' }, /instance must be a name, or left out; got a blank string/],
      ['toolsets--close', { server: 'arc', toolset: 5 }, /toolset must be a name, or left out; got a number/],
      ['toolsets--close', { server: ['arc'] }, /server must be a name, or left out; got a list/],
      ['toolsets--look', { server: 'arc', tool: { name: 'play' } }, /tool must be a name, or left out; got an object/],
      ['toolsets--act', { server: 'arc', tool: 'play', instance: '  ', args: { point: 'D4' } }, /instance must be a name, or left out; got a blank string/],
    ];
    for (const [name, input, refusal] of refusals) {
      const r = await callTool(t.fw.framework, name, input);
      assert.ok(r.isError, `${name} ${JSON.stringify(input)} is refused`);
      assert.match(resultText(r), refusal);
    }
    assert.ok(!t.methods().includes('toolsets/close'), 'nothing closed');
    assert.ok(!t.server.received.some((m) => m.method === 'tools/call' && (m.params as Json).name === 'play'), 'nothing called');
    assert.match(await look(t.fw), /G1/, 'g1 is still open');
  } finally { await t.done(); }
});

test('a selector given as null reads as left out', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
      peer.reply(msg.id, { toolset: 'game', instance: 'g1', title: 'G1', _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: true }]) } });
      return true;
    }
    if (msg.method === 'toolsets/close') {
      state.open = [];
      peer.reply(msg.id, { _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: false }]) } });
      return true;
    }
    return false;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    const played = await callTool(t.fw.framework, 'toolsets--act', { server: null, tool: 'play', instance: null, args: { point: 'D4' } });
    assert.ok(!played.isError, resultText(played));
    const call = t.server.received.find((m) => m.method === 'tools/call' && (m.params as Json).name === 'play');
    assert.deepEqual((call?.params as Json | undefined)?._meta, { 'mcpl/instance': 'g1' }, 'the one open instance, as with instance left out');
    const closed = await callTool(t.fw.framework, 'toolsets--close', { server: 'arc', toolset: null, instance: null });
    assert.ok(!closed.isError, resultText(closed));
    assert.ok(t.methods().includes('toolsets/close'), 'the one open thing closed');
  } finally { await t.done(); }
});

test('an open or close whose outcome the host can\'t know is reported as unconfirmed, with look named; one known not sent, as not done', async () => {
  const dropped = await setup((msg, peer) => {
    if (msg.method !== 'toolsets/open') return false;
    peer.ws.terminate();
    return true;
  }, { reconnect: true, reconnectIntervalMs: 60_000 });
  try {
    const r = await callTool(dropped.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    assert.ok(r.isError);
    assert.match(resultText(r), /didn't confirm opening build/, 'unconfirmed');
    assert.match(resultText(r), /closed before it answered/, 'with the connection\'s own account');
    assert.match(resultText(r), /toolsets--look \{server:"arc"\}/, 'naming look');
    const again = await callTool(dropped.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    assert.ok(again.isError);
    assert.match(resultText(again), /did not open build/, 'with the connection gone, an open is known not sent');
    assert.doesNotMatch(resultText(again), /toolsets--look/, 'so there is nothing to look for');
  } finally { await dropped.done(); }

  const refused = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'build', title: 'B' }];
      peer.reply(msg.id, { toolset: 'build', title: 'B', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
      return true;
    }
    if (msg.method === 'toolsets/close') { peer.error(msg.id, -32000, 'the board is locked'); return true; }
    return false;
  });
  try {
    await callTool(refused.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    const r = await callTool(refused.fw.framework, 'toolsets--close', { server: 'arc', toolset: 'build' });
    assert.ok(r.isError);
    assert.match(resultText(r), /didn't confirm closing build/, 'unconfirmed');
    assert.match(resultText(r), /the board is locked/, 'with the server\'s own account');
    assert.match(resultText(r), /toolsets--look \{server:"arc"\}/, 'naming look');
  } finally { await refused.done(); }
});

test('a refusal for a name the server doesn\'t have says what it has, or names look', async () => {
  const t = await setup();
  try {
    const refusals: Array<[string, Json, RegExp[]]> = [
      ['toolsets--look', { server: 'arc', toolset: 'nope' }, [/"nope"/, /game, build, cave/]],
      ['toolsets--close', { server: 'arc', toolset: 'nope' }, [/"nope"/, /game, build, cave/]],
      ['toolsets--open', { server: 'arc', toolset: 'nope' }, [/"nope"/, /game, build, cave/]],
      ['toolsets--look', { server: 'arc', tool: 'nope' }, [/"nope"/, /toolsets--look \{server:"arc"\}/]],
      ['toolsets--look', { server: 'arc', instance: 'g9' }, [/"g9"/, /no instance is open/]],
      ['toolsets--open', { toolset: 'nope' }, [/"nope"/, /toolsets--look/]],
    ];
    for (const [name, input, facts] of refusals) {
      const r = await callTool(t.fw.framework, name, input);
      assert.ok(r.isError, `${name} ${JSON.stringify(input)} is refused`);
      for (const fact of facts) assert.match(resultText(r), fact, `${name} ${JSON.stringify(input)}`);
    }
  } finally { await t.done(); }

  const none = await setup(() => false, {}, { ...ADVERT, toolHints: false });
  try {
    for (const input of [{}, { toolset: 'game' }]) {
      const r = await callTool(none.fw.framework, 'toolsets--open', input);
      assert.ok(r.isError);
      assert.match(resultText(r), /called directly, by name/);
    }
    const named = await callTool(none.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game' });
    assert.ok(named.isError);
    assert.match(resultText(named), /arc sends no tool hints/);
    assert.match(resultText(named), /called directly, by name/);
  } finally { await none.done(); }
});

test('a toolsets--act call whose outcome the host can\'t know names look, for the model and for a caller in process', async () => {
  const dropsOnPeek: Handler = (msg, peer) => {
    if (msg.method !== 'tools/call' || (msg.params as Json).name !== 'peek') return false;
    peer.ws.terminate();
    return true;
  };
  const t = await setup(dropsOnPeek);
  try {
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await roundTrip(t);
    t.fw.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'toolu_act', name: 'toolsets--act', input: { server: 'arc', tool: 'peek', args: {} } }] as never, 'tool_use'));
    t.fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'turn over' }]));
    t.fw.framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as never);
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('turn over')), 'the turn ended');
    const results = (t.fw.membrane.lastStream?.receivedToolResults ?? []).flat() as Array<{ toolUseId: string; content: unknown }>;
    const text = JSON.stringify(results.find((r) => r.toolUseId === 'toolu_act')?.content ?? null);
    assert.match(text, /closed before it answered/);
    assert.match(text, /toolsets--look \{server:\\"arc\\"\}/, 'naming look');
  } finally { await t.done(); }

  const inProcess = await setup(dropsOnPeek);
  try {
    inProcess.server.peer.notify('tools/hints', inProcess.state.hint([{ name: 'peek', visible: true }]));
    await roundTrip(inProcess);
    const r = await callTool(inProcess.fw.framework, 'toolsets--act', { server: 'arc', tool: 'peek', args: {} });
    assert.ok(r.isError);
    assert.match(resultText(r), /closed before it answered/);
    assert.match(resultText(r), /toolsets--look \{server:"arc"\}/, 'naming look');
  } finally { await inProcess.done(); }
});

test('the host\'s argument check is bounded: no server pattern runs, and deep or wide schemas are left to the server', async () => {
  const { checkArgs } = await import('../src/mcpl/tool-signature.js');
  // A pattern that backtracks catastrophically is never evaluated: the value
  // fails it, and passes.
  assert.equal(checkArgs({ type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }, { s: `${'a'.repeat(40)}!` }), null);
  // Types, enums and the rest are still checked.
  assert.match(checkArgs({ type: 'object', properties: { n: { enum: [1, 2] } } }, { n: 3 })!, /must be one of 1\|2/);
  // Nesting past the bound: unchecked rather than recursed into.
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 200; i++) deep = { allOf: [deep] };
  assert.equal(checkArgs(deep, 5), null);
  // anyOf fan-out that would take exponential time: unchecked past the step
  // budget, so a value no branch admits passes.
  let wide: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 20; i++) wide = { anyOf: [{ allOf: [wide, { type: 'number' }] }, { allOf: [wide, { type: 'boolean' }] }] };
  assert.equal(checkArgs(wide, null), null);
});

const notices = (fw: Awaited<ReturnType<typeof setup>>['fw']) => windowText(fw.framework).filter((x) => x.includes('tool changes'));

test('a tools/list with a malformed page changes nothing the host believes', async () => {
  let malformed = false;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/list' || !malformed) return false;
    if ((msg.params as Json | undefined)?.cursor === undefined) peer.reply(msg.id, { tools: TOOLS.slice(0, 3), nextCursor: 'p2', _meta: { 'mcpl/rev': state.rev } });
    else peer.reply(msg.id, { nextCursor: null });
    return true;
  });
  try {
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek()')), 'peek announced');
    malformed = true;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => t.server.received.some((m) => m.method === 'tools/list' && (m.params as Json | undefined)?.cursor === 'p2'), 'the second page asked for');
    // The second page's answer was sent before look's request, on an ordered transport.
    assert.match(await look(t.fw), /peek\(\)/, 'peek is still known and visible');
    assert.ok(!notices(t.fw).some((x) => x.includes('now unavailable: peek')), 'nothing was told gone');
  } finally { await t.done(); }
});

test('a toolsets/list result with no open list is ignored', async () => {
  let malformed = false;
  const t = await setup((msg, peer, state) => {
    if (msg.method === 'toolsets/open') {
      state.open = [{ toolset: 'build', title: 'Workshop' }];
      peer.reply(msg.id, { toolset: 'build', title: 'Workshop', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
      return true;
    }
    if (msg.method === 'toolsets/list' && malformed) {
      peer.reply(msg.id, { _meta: { 'mcpl/hints': { rev: state.next(), tools: [] } } });
      return true;
    }
    return false;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    malformed = true;
    const after = await look(t.fw);
    assert.match(after, /\[arc\/build\] Workshop tools now/, 'build is still open, with its tools');
    assert.doesNotMatch(after, /is closed/);
  } finally { await t.done(); }
});

test('an ended record is told once it reaches the agent: a notice not written leaves it for look', async () => {
  const t = await setup((msg, _peer, state) => {
    if (msg.method === 'toolsets/list') state.ended = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
    return false;
  }, { disabledCapabilities: ['pushEvents'] });
  const agentLook = async () => resultText((await t.fw.framework.puppetToolCall('scout', 'toolsets--look', { server: 'arc' })).result);
  try {
    assert.match(await look(t.fw), /\[arc\/game:g1\] ended: the game is over\./, 'a host\'s own look shows it to its caller');
    assert.ok(!notices(t.fw).length, 'without pushEvents no notice was written');
    assert.match(await agentLook(), /\[arc\/game:g1\] ended: the game is over\./, 'so the agent\'s own look still tells it');
    assert.doesNotMatch(await agentLook(), /ended: the game is over/, 'and only once');
  } finally { await t.done(); }
});

test('a told ended id is forgotten once the server stops reporting it, so a server that reuses the id after forgetting it is heard again', async () => {
  let ended: Json[] = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'first game over' }];
  const t = await setup((msg, _peer, state) => {
    if (msg.method === 'toolsets/list') state.ended = ended;
    return false;
  });
  try {
    await waitFor(() => notices(t.fw).some((x) => x.includes('[arc/game:g1] ended: first game over.')), 'the first end told');
    ended = [];
    await look(t.fw);
    ended = [{ id: 'e1', toolset: 'game', instance: 'g2', reason: 'second game over' }];
    assert.match(await look(t.fw), /\[arc\/game:g2\] ended: second game over\./);
  } finally { await t.done(); }
});

test('a result\'s change told as a notice comes before a later change read after it', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/call') return false;
    peer.reply(msg.id, { content: [{ type: 'text', text: 'ok' }], _meta: { 'mcpl/hints': state.hint([{ name: 'peek', visible: false }]) } });
    peer.notify('tools/hints', state.hint([{ name: 'peek', visible: true }]));
    return true;
  });
  try {
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek()')), 'peek announced');
    const before = notices(t.fw).length;
    await callTool(t.fw.framework, 'arc--status', {});
    await waitFor(() => notices(t.fw).length >= before + 2, 'both changes told');
    const [first, second] = notices(t.fw).slice(before);
    assert.match(first!, /now unavailable: peek/, 'the result\'s change first');
    assert.match(second!, /peek\(\)/, 'then the later one');
  } finally { await t.done(); }
});

test('look shows a suggestion its re-read carries', async () => {
  let suggest = false;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/list' || !suggest) return false;
    peer.reply(msg.id, { open: state.open, _meta: { 'mcpl/hints': { rev: state.next(), tools: state.statement, suggest: [{ toolset: 'game', action: 'open', reason: 'a rematch is ready' }] } } });
    return true;
  });
  try {
    suggest = true;
    assert.match(await look(t.fw), /arc suggests opening game: a rematch is ready/);
  } finally { await t.done(); }
});

test('a hint naming a tool tools/list hasn\'t listed is recovered from tools/list, then toolsets/list', async () => {
  const t = await setup();
  try {
    const from = t.server.received.length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'lantern', visible: true }]));
    await waitFor(() => t.server.received.slice(from).some((m) => m.method === 'toolsets/list'), 'recovery read toolsets/list');
    const recovery = t.server.received.slice(from).map((m) => m.method).filter((m) => m === 'tools/list' || m === 'toolsets/list');
    assert.deepEqual(recovery, ['tools/list', 'toolsets/list']);
  } finally { await t.done(); }
});

test('a lost move is repaired by the recovery\'s tools/list, and the model\'s tool list follows it at the next refresh', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  const t = await setup(() => false, {}, ADVERT, tools);
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
  const told = (text: string) => notices(t.fw).filter((x) => x.includes(text)).length;
  const actOnPeek = async () => resultText(await callTool(t.fw.framework, 'toolsets--act', { tool: 'peek', args: {} }));
  try {
    assert.ok(!listed().includes('arc--peek'), 'peek starts dynamic');
    present(tools, 'peek', 'static');
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', presence: 'static' }]));
    await roundTrip(t);
    assert.ok(!listed().includes('arc--peek'), 'the move waits for the next tool list');
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => listed().includes('arc--peek'), 'peek moved into the tool list');
    assert.equal(told('peek is in your tool list now, as arc--peek.'), 1, 'told once, with where it went');
    present(tools, 'peek', 'dynamic');
    const peek = tools.find((x) => x.name === 'peek')!;
    peek._meta = { ...(peek._meta as Json), 'mcpl/visible': true };
    t.state.next();
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'a skipped rev recovered');
    await roundTrip(t);
    assert.doesNotMatch(await actOnPeek(), /is not a dynamic tool/, 'act takes it at once, where the latest list put it');
    assert.ok(listed().includes('arc--peek'), 'the tool list waits for the next refresh');
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => !listed().includes('arc--peek'), 'the next refresh moves peek out of the tool list');
    assert.equal(told('peek is in your tool list now'), 1, 'the first move was applied once');
    assert.equal(told('peek left your tool list'), 1, 'and the move back told once');
    assert.ok(notices(t.fw).some((x) => x.includes('peek() — Peek around.')), 'and announced, as the list made it visible');
  } finally { await t.done(); }
});

test('an entry that moves a tool to dynamic keeps the definition it carries', async () => {
  const tools: Json[] = [...TOOLS.map((x) => ({ ...x })), { name: 'echo', description: 'Echo as listed.', inputSchema: { type: 'object', properties: {} } }];
  const t = await setup(() => false, {}, ADVERT, tools);
  try {
    present(tools, 'echo', 'dynamic');
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'echo', presence: 'dynamic', visible: true, definition: { description: 'Echo, as hinted now.', inputSchema: { type: 'object', properties: { loud: { type: 'boolean' } } } } }]));
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => !t.fw.framework.getAllTools().some((x) => x.name === 'arc--echo'), 'echo moved out of the tool list');
    const refused = await callTool(t.fw.framework, 'toolsets--act', { tool: 'echo', args: { loud: 'yes' } });
    assert.ok(refused.isError, 'checked against the definition the hint carried');
    assert.match(resultText(refused), /loud/);
  } finally { await t.done(); }
});

test('a server that didn\'t advertise toolHints: its hints are ignored and every tool stays static', async () => {
  const t = await setup((msg, peer) => {
    if (msg.method !== 'tools/call') return false;
    peer.reply(msg.id, { content: [{ type: 'text', text: 'ok' }], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'status', presence: 'dynamic' }] } } });
    return true;
  }, {}, { ...ADVERT, toolHints: undefined });
  const names = () => t.fw.framework.getAllTools().map((x) => x.name);
  try {
    for (const tool of ['status', 'play', 'place', 'dig', 'peek']) assert.ok(names().includes(`arc--${tool}`), `arc--${tool} is in the tool list`);
    t.server.peer.notify('tools/hints', { rev: 2, tools: [{ name: 'play', presence: 'dynamic' }] });
    await roundTrip(t);
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => t.methods().filter((m) => m === 'tools/list').length >= 2, 'the tool list read again');
    await roundTrip(t);
    for (const tool of ['status', 'play', 'peek']) assert.ok(names().includes(`arc--${tool}`), `arc--${tool} is still in the tool list`);
    assert.ok(!t.methods().includes('toolsets/list'), 'no toolsets/list');
    assert.equal(notices(t.fw).length, 0, 'nothing told');
  } finally { await t.done(); }
});

test('revs start over on each connection: after a reconnect, the new connection\'s next rev applies', async () => {
  const t = await setup(() => false, { reconnect: true, reconnectIntervalMs: 50 });
  try {
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek()')), 'peek announced');
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.state.rev = 0;
    t.server.peer.ws.terminate();
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'toolsets/list after the reconnect');
    await roundTrip(t);
    const from = t.methods().length;
    const before = notices(t.fw).length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: false }]));
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('now unavailable: peek')), 'the new connection\'s change told');
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    assert.ok(!t.methods().slice(from).some((m) => m === 'tools/list' || m === 'toolsets/list'), 'no recovery');
  } finally { await t.done(); }
});

test('a tools/list whose rev is past the last one read recovers what was lost', async () => {
  const t = await setup();
  try {
    t.state.hint([{ name: 'peek', visible: true }]);
    const from = t.methods().length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek()')), 'the change never sent recovered, and told');
    assert.ok(t.methods().slice(from).includes('toolsets/list'), 'recovered through toolsets/list');
  } finally { await t.done(); }
});

test('vector 14: an open and a retitle made on another connection arrive as hint toolsets entries', async () => {
  const t = await setup();
  try {
    t.state.open = [{ toolset: 'build', title: 'Shared workshop' }];
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'place', visible: true }], { toolsets: [{ toolset: 'build', state: 'open', title: 'Shared workshop' }] }));
    await waitFor(() => notices(t.fw).some((x) => x.includes('[arc/build] Shared workshop') && x.includes('place(')), 'the open told');
    const act = await callTool(t.fw.framework, 'toolsets--act', { tool: 'place', args: { x: 1 } });
    assert.ok(!act.isError, resultText(act));
    t.state.open = [{ toolset: 'build', title: 'Night shift' }];
    t.server.peer.notify('tools/hints', t.state.hint([], { toolsets: [{ toolset: 'build', state: 'open', title: 'Night shift' }, { toolset: 'game', state: 'open', title: 'No instance' }] }));
    await waitFor(() => notices(t.fw).some((x) => x.includes('[arc/build] Night shift')), 'the retitle told');
    assert.ok(!notices(t.fw).some((x) => x.includes('[arc/game')), 'an entry naming no instance of a toolset with instances opens nothing');
  } finally { await t.done(); }
});

test('an instance the host believed open, missing from the next statement with no ended record, is told closed', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
    peer.reply(msg.id, { toolset: 'game', instance: 'g1', title: 'G1', _meta: { 'mcpl/hints': state.hint([{ name: 'play', instance: 'g1', visible: true }]) } });
    return true;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    t.state.open = [];
    t.state.statement = t.state.statement.filter((x) => x.instance !== 'g1');
    assert.match(await look(t.fw), /\[arc\/game:g1\] is closed: arc no longer has it open\./);
  } finally { await t.done(); }
});

function tappedController(writes: () => boolean = () => true) {
  const told: string[] = [];
  const hub = new ToolsetHub({
    notify: (_s: string, text: string) => { if (!writes()) return false; told.push(text); return true; },
    canNotify: () => true, log: () => {}, listedName: (_s: string, tool: string) => `arc--${tool}`,
  });
  const c = hub.controllerFor({ id: 'arc', toolHints: true } as McplServerConfig);
  let tap: (read: unknown, epoch: number) => void = () => {};
  c.attach({ setReadTap: (f: typeof tap | null) => { if (f) tap = f; }, transportEpoch: 0, isConnected: true, toolsetDeclarations: ADVERT } as never);
  const read = (r: unknown) => tap(r, 0);
  read({ kind: 'result', method: 'tools/list', params: {}, result: { tools: TOOLS }, awaited: true });
  const callResult = (rev: number, tools: Json[]) => ({ content: [{ type: 'text', text: 'ok' }], _meta: { 'mcpl/hints': { rev, tools } } });
  const readCall = (result: Json) => read({ kind: 'result', method: 'tools/call', params: { name: 'status' }, result, awaited: true });
  return { hub, c, told, read, callResult, readCall };
}

test('taking a result\'s change first tells, as a notice, the change of a result read before it (in process: in an agent\'s window a notice told during a call is stored after the call\'s result)', () => {
  const { c, told, callResult, readCall } = tappedController();
  readCall(callResult(1, [{ name: 'peek', visible: true }]));
  const later = callResult(2, [{ name: 'peek', visible: false }]);
  readCall(later);
  const taken = c.takeChange(later);
  assert.equal(told.length, 1, 'the earlier change, told first');
  assert.match(told[0]!, /peek\(\)/);
  assert.match(c.presence.render(taken), /now unavailable: peek/);
});

test('a hint read right after a tools/list\'s last page, in the same chunk, isn\'t undone by that list', async () => {
  let held: Json | null = null;
  let holding = false;
  const t = await setup((msg) => {
    if (msg.method !== 'tools/list' || !holding) return false;
    held = msg;
    return true;
  });
  try {
    holding = true;
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => held !== null, 'the tool list asked for');
    const connection = (t.fw.framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } }).mcplServerRegistry.getServer('arc');
    const transport = (connection as { transport: { emit(event: string, line: string): void } }).transport;
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', id: (held as unknown as Json).id, result: { tools: TOOLS, _meta: { 'mcpl/rev': t.state.rev } } }));
    transport.emit('line', JSON.stringify({ jsonrpc: '2.0', method: 'tools/hints', params: t.state.hint([{ name: 'peek', visible: true }]) }));
    await roundTrip(t);
    const told = notices(t.fw).slice(before);
    assert.ok(told.some((x) => x.includes('peek()')), 'the hint\'s change told');
    assert.ok(!told.some((x) => x.includes('now unavailable: peek')), 'and not undone by the list read before it');
  } finally { await t.done(); }
});

test('a move a hint announces but the next tools/list contradicts never reaches the tool list', async () => {
  const t = await setup();
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
  try {
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', presence: 'static', visible: true }]));
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek()')), 'the hint read');
    const lists = t.methods().filter((m) => m === 'tools/list').length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => t.methods().filter((m) => m === 'tools/list').length > lists, 'the tool list read again');
    await roundTrip(t);
    assert.ok(!listed().includes('arc--peek'), 'peek stays where the list says');
    assert.ok(!notices(t.fw).some((x) => x.includes('peek is in your tool list now')));
  } finally { await t.done(); }
});

test('a move a hint announces but a reconnect\'s tools/list contradicts never reaches the tool list', async () => {
  const t = await setup(() => false, { reconnect: true, reconnectIntervalMs: 50 });
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
  try {
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', presence: 'static', visible: true }]));
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek()')), 'the hint read');
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.state.rev = 0;
    t.server.peer.ws.terminate();
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'toolsets/list after the reconnect');
    await roundTrip(t);
    t.server.peer.notify('notifications/tools/list_changed', {});
    const after = t.methods().filter((m) => m === 'tools/list').length;
    await waitFor(() => t.methods().filter((m) => m === 'tools/list').length > after, 'the tool list read again');
    await roundTrip(t);
    assert.ok(!listed().includes('arc--peek'));
    assert.ok(!notices(t.fw).some((x) => x.includes('peek is in your tool list now')));
  } finally { await t.done(); }
});

test('a toolsets/list naming a tool tools/list hasn\'t listed is recovered from, once', async () => {
  const t = await setup();
  try {
    t.state.statement.push({ name: 'lantern', visible: true });
    const from = t.server.received.length;
    await look(t.fw);
    await waitFor(() => t.server.received.slice(from).filter((m) => m.method === 'toolsets/list').length >= 2, 'the recovery read toolsets/list');
    await roundTrip(t);
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    const after = t.server.received.slice(from).map((m) => m.method).filter((m) => m === 'tools/list' || m === 'toolsets/list');
    assert.deepEqual(after, ['toolsets/list', 'tools/list', 'toolsets/list'], 'look\'s read, then one recovery: its own toolsets/list, naming lantern again, starts no other');
  } finally { await t.done(); }
});

test('a recovery whose tools/list fails still reads toolsets/list, as connecting does, and tells what it says', async () => {
  let failing = false;
  const t = await setup((msg, peer) => {
    if (msg.method !== 'tools/list' || !failing) return false;
    peer.error(msg.id, -32000, 'list unavailable');
    return true;
  });
  try {
    failing = true;
    const from = t.server.received.length;
    const before = notices(t.fw).length;
    t.state.open = [{ toolset: 'build', title: 'Workshop' }];
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => t.server.received.slice(from).some((m) => m.method === 'tools/list'), 'the recovery read tools/list');
    await waitFor(() => t.server.received.slice(from).some((m) => m.method === 'toolsets/list'), 'and then toolsets/list');
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('Workshop')), 'what toolsets/list said, told');
    await roundTrip(t);
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    const order = t.server.received.slice(from).map((m) => m.method).filter((m) => m === 'tools/list' || m === 'toolsets/list');
    assert.deepEqual(order, ['tools/list', 'toolsets/list'], 'tools/list first (RFC-014 §6.1), and no further recovery');
  } finally { await t.done(); }
});

test('a tools/list whose answer comes after its timeout applies nothing', async () => {
  let held: Json | null = null;
  let holding = false;
  const t = await setup((msg) => {
    if (msg.method !== 'tools/list' || !holding) return false;
    held = msg;
    return true;
  }, { requestTimeoutMs: 300 });
  try {
    holding = true;
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => held !== null, 'the tool list asked for');
    await settle(500);
    const tools = TOOLS.map((x) => (x.name === 'peek' ? { ...x, description: 'A late description.', _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } } : x));
    t.server.peer.reply((held as unknown as Json).id, { tools, _meta: { 'mcpl/rev': t.state.rev } });
    await roundTrip(t);
    assert.ok(!notices(t.fw).slice(before).some((x) => x.includes('peek()')));
    assert.doesNotMatch(await look(t.fw, { server: 'arc', tool: 'peek' }), /A late description/);
  } finally { await t.done(); }
});

test('two paged tools/lists read at once each apply whole, never mixed', async () => {
  const pages: Array<{ msg: Json; peer: ScriptedPeer }> = [];
  let paging = false;
  const t = await setup((msg, peer) => {
    if (msg.method !== 'tools/list' || !paging) return false;
    pages.push({ msg, peer });
    return true;
  });
  try {
    paging = true;
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => pages.length >= 2, 'two lists asked for');
    const answer = (i: number, result: Json) => pages[i]!.peer.reply(pages[i]!.msg.id, result);
    const rev = t.state.rev;
    const peekFrom = (list: string, visible: boolean) => ({ name: 'peek', description: `From list ${list}.`, inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': visible } });
    answer(0, { tools: [{ ...TOOLS[0]!, description: 'Status, from list A.' }, ...TOOLS.slice(1, 3)], nextCursor: 'a2', _meta: { 'mcpl/rev': rev } });
    answer(1, { tools: [...TOOLS.slice(0, 4), peekFrom('B', false)], _meta: { 'mcpl/rev': rev } });
    await waitFor(() => pages.length >= 3, 'the first list\'s second page asked for');
    answer(2, { tools: [TOOLS[3]!, peekFrom('A', true)], _meta: { 'mcpl/rev': rev } });
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('peek() — From list A.')), 'the first list applied whole, its second page included');
    assert.match(await look(t.fw, { server: 'arc', tool: 'status' }), /Status, from list A\./, 'its first page included too');
    assert.ok(t.fw.framework.getAllTools().some((x) => x.name === 'arc--status'), 'and the model\'s tool list holds it');
    assert.match(await look(t.fw, { server: 'arc', tool: 'peek' }), /From list A\./);
  } finally { await t.done(); }
});

test('a tools/list whose pages carry different revs starts a recovery, after which the later change stands', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  let paging = false;
  let second: { msg: Json; peer: ScriptedPeer } | null = null;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/list' || !paging) return false;
    if ((msg.params as Json | undefined)?.cursor === 'p2') second = { msg, peer };
    else peer.reply(msg.id, { tools: tools.slice(3), nextCursor: 'p2', _meta: { 'mcpl/rev': state.rev } });
    return true;
  }, {}, ADVERT, tools);
  try {
    paging = true;
    const from = t.server.received.length;
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => second !== null, 'the second page asked for');
    const peek = tools.find((x) => x.name === 'peek')!;
    peek._meta = { ...(peek._meta as Json), 'mcpl/visible': true };
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    const held = second as unknown as { msg: Json; peer: ScriptedPeer };
    paging = false;
    held.peer.reply(held.msg.id, { tools: tools.slice(0, 3), _meta: { 'mcpl/rev': t.state.rev } });
    await waitFor(() => t.server.received.slice(from).some((m) => m.method === 'toolsets/list'), 'a recovery read toolsets/list');
    await roundTrip(t);
    const peekNotices = notices(t.fw).slice(before).filter((x) => x.includes('peek'));
    assert.match(peekNotices[peekNotices.length - 1]!, /peek\(\)/, 'peek is visible once the recovery has read the list again');
  } finally { await t.done(); }
});

test('without the pushEvents grant, an announcement that left the context isn\'t restated by a reminder', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    state.open = [{ toolset: 'build', title: 'Workshop' }];
    peer.reply(msg.id, { toolset: 'build', title: 'Workshop', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
    return true;
  }, { disabledCapabilities: ['pushEvents'] });
  const { createMockResponse } = await import('./helpers/mock-membrane.js');
  const turn = async (scripted = false) => {
    const n = t.fw.membrane.calls.length;
    if (!scripted) t.fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    t.fw.framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as never);
    await waitFor(() => t.fw.membrane.calls.length > n && t.fw.framework.getAgent('scout')!.state.status === 'idle', 'the turn\'s request made and the turn ended');
    return JSON.stringify(t.fw.membrane.calls[n]!.messages);
  };
  try {
    t.fw.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'toolu_open', name: 'toolsets--open', input: { server: 'arc', toolset: 'build' } }] as never, 'tool_use'));
    t.fw.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'opened' }]));
    await turn(true);
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('[arc/build] Workshop')), 'the open stored');
    assert.match(await turn(), /\[arc\/build\]/, 'the announcement is in view');
    const cm = t.fw.framework.getAgent('scout')!.getContextManager();
    for (const m of cm.getAllMessages()) {
      if (JSON.stringify(m.content).includes('toolu_open')) cm.removeMessage(m.id);
    }
    const later = (await turn()) + (await turn());
    assert.doesNotMatch(later, /Open toolsets \(a reminder/);
  } finally { await t.done(); }
});

test('a hint or statement naming a tool the operator\'s tool policy leaves out starts no recovery', async () => {
  const t = await setup(() => false, { disabledTools: ['peek', 'lantern'] });
  try {
    const from = t.server.received.length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }, { name: 'lantern', visible: true }]));
    await roundTrip(t);
    t.state.statement.push({ name: 'lantern', visible: true });
    await look(t.fw);
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    assert.ok(!t.server.received.slice(from).some((m) => m.method === 'tools/list'));
    assert.equal(t.server.received.slice(from).filter((m) => m.method === 'toolsets/list').length, 1, 'only look\'s own read');
  } finally { await t.done(); }
});

test('look with a tool or toolset, or one that fails, tells its re-read\'s change as a notice', async () => {
  const t = await setup();
  try {
    const looks = [{ server: 'arc', tool: 'status' }, { server: 'arc', toolset: 'build' }, { server: 'arc', toolset: 'nope' }];
    for (const [i, input] of looks.entries()) {
      const before = notices(t.fw).length;
      const visible = i % 2 === 0;
      t.state.statement = visible ? [{ name: 'dig', visible: true }, { name: 'peek', visible: true }] : [{ name: 'dig', visible: true }];
      await look(t.fw, input);
      await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes(visible ? 'peek()' : 'now unavailable: peek')), `the re-read change of look ${JSON.stringify(input)} told`);
    }
  } finally { await t.done(); }
});

test('a definition first described in a notice that wasn\'t written is described again once the server is granted pushEvents', async () => {
  let advert: Json = { ...ADVERT, pushEvents: false };
  const t = await setup((msg, peer) => {
    if (msg.method === 'mcpl/manifest') { peer.reply(msg.id, { version: '0.5', ...advert }); return true; }
    return false;
  }, {}, advert);
  const count = (method: string) => t.methods().filter((m) => m === method).length;
  try {
    const before = notices(t.fw).length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: false }]));
    await roundTrip(t);
    assert.equal(notices(t.fw).length, before, 'no notice without the grant');
    const [manifests, lists] = [count('mcpl/manifest'), count('tools/list')];
    advert = { ...ADVERT, pushEvents: true };
    t.server.peer.notify('mcpl/manifestChanged', { revision: 'r2', domains: ['featureSets'] });
    await waitFor(() => count('mcpl/manifest') > manifests && count('tools/list') > lists, 'the manifest fetched again and applied');
    await roundTrip(t);
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('peek()')), 'peek told');
    assert.match(notices(t.fw).slice(before).join('\n'), /peek\(\) — Peek around\./);
  } finally { await t.done(); }
});

test('a push\'s change that nothing takes is told as a notice (in process: a push refused before the push path reads it needs a stopping host)', async () => {
  const { told, read } = tappedController();
  read({ kind: 'push', params: { featureSet: 'arc.events', eventId: 'p1', payload: { content: [] }, hints: { rev: 1, tools: [{ name: 'peek', visible: true }] } } });
  await nextMacrotask();
  assert.match(told.join('\n'), /peek\(\)/);
});

test('a tool a recovery\'s list puts in a toolset leaves the model\'s tool list at the next refresh, and is told so', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  const t = await setup(() => false, {}, ADVERT, tools);
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
  try {
    tools.find((x) => x.name === 'status')!._meta = { 'mcpl/toolset': 'build' };
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'a skipped rev recovered');
    await roundTrip(t);
    assert.ok(listed().includes('arc--status'), 'the tool list waits for the next refresh');
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => !listed().includes('arc--status'), 'the next refresh moves status out of the tool list');
    assert.ok(notices(t.fw).some((x) => x.includes('status left your tool list')));
  } finally { await t.done(); }
});

test('after a reconnect whose tools/list moved a tool, the model\'s tool list agrees with presence', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  const t = await setup(() => false, { reconnect: true, reconnectIntervalMs: 50 }, ADVERT, tools);
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
  try {
    present(tools, 'peek', 'static');
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.state.rev = 0;
    t.server.peer.ws.terminate();
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'toolsets/list after the reconnect');
    await waitFor(() => listed().includes('arc--peek'), 'peek in the tool list');
    assert.match(resultText(await callTool(t.fw.framework, 'toolsets--act', { tool: 'peek', args: {} })), /peek is not a dynamic tool/);
  } finally { await t.done(); }
});

test('a paged tools/list whose rev only some pages carry isn\'t taken for one that straddled a change', async () => {
  let paging = false;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/list' || !paging) return false;
    if ((msg.params as Json | undefined)?.cursor === 'p2') peer.reply(msg.id, { tools: TOOLS.slice(3), _meta: { 'mcpl/rev': state.rev } });
    else peer.reply(msg.id, { tools: TOOLS.slice(0, 3), nextCursor: 'p2' });
    return true;
  });
  try {
    paging = true;
    const from = t.server.received.length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => t.server.received.slice(from).filter((m) => m.method === 'tools/list').length >= 2, 'both pages asked for');
    await roundTrip(t);
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    assert.ok(!t.server.received.slice(from).some((m) => m.method === 'toolsets/list'), 'no recovery');
  } finally { await t.done(); }
});


test('a push whose change no notice could carry keeps it for the push\'s own path to take (in process: it needs a push whose own path runs after the next macrotask)', async () => {
  let writes = false;
  const { c, read } = tappedController(() => writes);
  const params = { featureSet: 'arc.events', eventId: 'p1', payload: { content: [] }, hints: { rev: 1, tools: [{ name: 'peek', visible: true }] } };
  read({ kind: 'push', params });
  await nextMacrotask();
  writes = true;
  assert.match(c.presence.render(c.takeChange(params)), /peek\(\)/);
});

test('a recovery whose own tools/list straddled a change starts no second recovery', async () => {
  let paging = false;
  let second: { msg: Json; peer: ScriptedPeer } | null = null;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/list' || !paging) return false;
    if ((msg.params as Json | undefined)?.cursor === 'p2') second = { msg, peer };
    else peer.reply(msg.id, { tools: TOOLS.slice(0, 3), nextCursor: 'p2', _meta: { 'mcpl/rev': state.rev } });
    return true;
  });
  try {
    paging = true;
    const from = t.server.received.length;
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => second !== null, 'the recovery\'s second page asked for');
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    const held = second as unknown as { msg: Json; peer: ScriptedPeer };
    paging = false;
    held.peer.reply(held.msg.id, { tools: TOOLS.slice(3), _meta: { 'mcpl/rev': t.state.rev } });
    await waitFor(() => t.server.received.slice(from).some((m) => m.method === 'toolsets/list'), 'the recovery read toolsets/list');
    await roundTrip(t);
    await settle(400); // past the 200 ms recovery debounce
    await roundTrip(t); // and the server has read whatever the host sent before it
    assert.equal(t.server.received.slice(from).filter((m) => m.method === 'toolsets/list').length, 1);
  } finally { await t.done(); }
});

test('look at a toolset whose options a server nests very deep still answers (in process: the suite\'s scripted server writes its initialize answer with JSON.stringify, which can\'t write options that deep)', async () => {
  let deep: Json = { type: 'string' };
  for (let i = 0; i < 20000; i++) deep = { type: 'object', properties: { a: deep } };
  const { hub, c } = tappedController();
  c.manifestChanged({ toolHints: true, toolsets: { maze: { title: 'Maze', options: deep } } });
  const looked = await new ToolsetsModule(hub, () => null).handleToolCall({ id: 'l2', name: 'look', input: { server: 'arc', toolset: 'maze' } } as never);
  assert.ok(!looked.isError, String(looked.error));
  assert.match(resultText(looked), /options: \(nested too deeply to show\)/);
});

test('look says when it couldn\'t ask a server, and shows what the host last knew of it', async () => {
  let listing = true;
  const t = await setup((msg, peer) => {
    if (msg.method !== 'toolsets/list' || listing) return false;
    peer.error(msg.id, -32000, 'busy');
    return true;
  });
  try {
    listing = false;
    const text = await look(t.fw);
    assert.match(text, /^arc\n {2}nothing open/);
    assert.match(text, /arc couldn't be asked/, 'says it couldn\'t ask');
    assert.match(text, /what the host last knew/, 'and what it shows instead');
    const refused = await callTool(t.fw.framework, 'toolsets--look', { server: 'arc', instance: 'g1' });
    assert.ok(refused.isError);
    assert.match(resultText(refused), /no open instance "g1"/);
    assert.match(resultText(refused), /arc couldn't be asked/, 'a refusal says it couldn\'t ask too');
  } finally { await t.done(); }
});

test('an open\'s tool change goes with its result where the agent reads it, and as a notice for a host\'s own open', async () => {
  const opens: Handler = (msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    state.open = [{ toolset: 'build', title: 'B' }];
    peer.reply(msg.id, { toolset: 'build', title: 'B', _meta: { 'mcpl/hints': state.hint([{ name: 'place', visible: true }]) } });
    return true;
  };
  const agent = await setup(opens);
  try {
    const { toolUseId } = await agent.fw.framework.puppetToolCall('scout', 'toolsets--open', { server: 'arc', toolset: 'build' });
    const stored = agent.fw.framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
      .find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId);
    assert.match(JSON.stringify(stored?.content ?? null), /place\(x\?: int\) — Place a block\./, 'the stored result holds the change');
    await nextMacrotask();
    assert.equal(notices(agent.fw).length, 0, 'the puppet\'s stored result told it');
  } finally { await agent.done(); }

  const host = await setup(opens);
  try {
    const r = await callTool(host.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'build' });
    assert.match(resultText(r), /place\(x\?: int\) — Place a block\./, 'the caller reads the tools it opened');
    await waitFor(() => notices(host.fw).some((x) => x.includes('[arc/build] B') && x.includes('place(x?: int) — Place a block.')), 'the agent told as a notice');
  } finally { await host.done(); }
});

test('a restart under the same id with toolHints keeps what the host told: an end told before is not told again', async () => {
  const t = await setup((msg, _peer, state) => {
    if (msg.method === 'toolsets/list') state.ended = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
    return false;
  });
  const told = () => notices(t.fw).filter((x) => x.includes('ended: the game is over')).length;
  try {
    await waitFor(() => told() === 1, 'the end told');
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    await t.fw.framework.restartMcplServer('arc');
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'toolsets/list after the restart');
    await roundTrip(t);
    await nextMacrotask();
    assert.equal(told(), 1, 'told once, across the restart');
  } finally { await t.done(); }
});

const withPresence = (name: string, presence: 'static' | 'dynamic') => TOOLS.map((x) => (x.name === name ? { ...x, _meta: { ...(x._meta as Json | undefined), 'mcpl/presence': presence } } : x));

async function movingServer(moved: Json[]) {
  let phase: 'off' | 'move' | 'hold' = 'off';
  let release: (() => void) | null = null;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/list' || phase === 'off') return false;
    const answer = () => peer.reply(msg.id, { tools: moved, _meta: { 'mcpl/rev': state.rev } });
    if (phase === 'move') {
      phase = 'hold';
      answer();
    } else {
      release = answer;
    }
    return true;
  });
  const moveAndHold = async () => {
    phase = 'move';
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => phase === 'hold', 'the recovery\'s tools/list answered');
    await roundTrip(t);
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => release !== null, 'the rebuild\'s tools/list asked for');
  };
  return { t, moveAndHold, release: () => release?.() };
}

test('look naming a tool with no instance shows the definition act checks: the sole open instance\'s own', async () => {
  const own = { name: 'play', instance: 'g1', visible: false, definition: { name: 'play', description: 'Play one of the legal points.', inputSchema: { type: 'object', properties: { point: { enum: ['C3'] } }, required: ['point'] } } };
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'toolsets/open') return false;
    state.open.push({ toolset: 'game', instance: 'g1', title: 'Game g1' });
    const hints = state.hint([own]);
    // The statement restates the definition (RFC §6.1), so look's re-read keeps it.
    state.statement = [own];
    peer.reply(msg.id, { toolset: 'game', instance: 'g1', title: 'Game g1', _meta: { 'mcpl/hints': hints } });
    return true;
  });
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'game', instance: 'g1' });
    const refused = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'play', args: { point: 'D4' } });
    assert.match(resultText(refused), /must be one of "C3"/, 'act checks g1\'s own definition');
    assert.match(await look(t.fw, { server: 'arc', tool: 'play' }), /Play one of the legal points\./, 'look shows the same one');
  } finally { await t.done(); }
});

test('RFC-014 §4.2: a rebuild whose listing of a server breaks off before a moved tool doesn\'t tell its move, and the tool list doesn\'t show it', async () => {
  const moved = withPresence('peek', 'static');
  const { t, moveAndHold, release } = await movingServer([moved[0]!, null as unknown as Json, ...moved.slice(1)]);
  try {
    await moveAndHold();
    release();
    // A rebuild that changes nothing a caller sees has no public sign of its end: this waits on the framework's own flag.
    await waitFor(() => (t.fw.framework as unknown as { mcplToolRefreshInFlight: boolean }).mcplToolRefreshInFlight === false, 'the rebuild ended');
    await nextMacrotask();
    assert.ok(!t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the tool list doesn\'t show peek');
    assert.equal(notices(t.fw).filter((x) => x.includes('peek is in your tool list now')).length, 0, 'so the move isn\'t told');
  } finally {
    release();
    await t.done();
  }
});

test('RFC-014 §4.2: a move a broken-off listing didn\'t publish is told by the next rebuild that does', async () => {
  const moved = withPresence('peek', 'static');
  const list = [moved[0]!, null as unknown as Json, ...moved.slice(1)];
  const { t, moveAndHold, release } = await movingServer(list);
  const toldMoved = () => notices(t.fw).filter((x) => x.includes('peek is in your tool list now')).length;
  try {
    await moveAndHold();
    release();
    await waitFor(() => (t.fw.framework as unknown as { mcplToolRefreshInFlight: boolean }).mcplToolRefreshInFlight === false, 'the broken rebuild ended');
    assert.equal(toldMoved(), 0, 'not told while the list doesn\'t show peek');
    list.splice(1, 1);
    const lists = t.server.received.filter((m) => m.method === 'tools/list').length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => t.server.received.filter((m) => m.method === 'tools/list').length > lists, 'the next rebuild\'s tools/list asked for');
    release();
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the next rebuild publishes peek');
    await waitFor(() => toldMoved() > 0, 'the move told');
    await nextMacrotask();
    assert.equal(toldMoved(), 1, 'once');
  } finally {
    release();
    await t.done();
  }
});

test('RFC-014 §4.2: a move to dynamic is told by a broken-off listing that no longer offers the tool, though it never read it', async () => {
  const { t, moveAndHold, release } = await movingServer([null as unknown as Json, ...withPresence('status', 'dynamic')]);
  const toldLeft = () => notices(t.fw).filter((x) => x.includes('status left your tool list')).length;
  try {
    await moveAndHold();
    release();
    await waitFor(() => !t.fw.framework.getAllTools().some((x) => x.name === 'arc--status'), 'the rebuild publishes a list without status');
    await waitFor(() => toldLeft() > 0, 'the move told');
    await nextMacrotask();
    assert.equal(toldLeft(), 1, 'once');
    assert.equal(resultText(await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'status', args: {} })), 'status done', 'and act calls it');
  } finally {
    release();
    await t.done();
  }
});

test('RFC-014 §4.2: a rebuild whose listing of a server breaks off after a moved tool tells its move once, and the tool list shows it', async () => {
  const { t, moveAndHold, release } = await movingServer([...withPresence('peek', 'static'), null as unknown as Json]);
  try {
    await moveAndHold();
    release();
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the rebuild publishes peek');
    await waitFor(() => notices(t.fw).some((x) => x.includes('peek is in your tool list now')), 'the move told');
    await nextMacrotask();
    assert.equal(notices(t.fw).filter((x) => x.includes('peek is in your tool list now')).length, 1, 'once');
  } finally {
    release();
    await t.done();
  }
});


test('RFC-014 §4.2: a tool a list moves to static is called both ways until the tool list shows it, then by its listed name', async () => {
  const { t, moveAndHold, release } = await movingServer(withPresence('peek', 'static'));
  try {
    await moveAndHold();
    const viaAct = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'peek', args: {} });
    assert.equal(resultText(viaAct), 'peek done', 'act still calls it, where the tool list put it');
    const byName = await t.fw.framework.executeToolCall({ id: 'early', name: 'arc--peek', input: {} } as never);
    assert.equal(resultText(byName), 'peek done', 'its listed name calls it, where the server\'s latest list put it');
    release();
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the rebuild shows peek');
    assert.equal(resultText(await t.fw.framework.executeToolCall({ id: 'late', name: 'arc--peek', input: {} } as never)), 'peek done');
    const viaActLate = resultText(await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'peek', args: {} }));
    assert.match(viaActLate, /peek is not a dynamic tool/, 'act refuses it now');
    assert.match(viaActLate, /arc--peek/, 'naming the name it\'s called by');
  } finally {
    release();
    await t.done();
  }
});

test('RFC-014 §4.2: a tool a list moves to dynamic is called both ways until the tool list drops it, then through act', async () => {
  const { t, moveAndHold, release } = await movingServer(withPresence('status', 'dynamic'));
  try {
    await moveAndHold();
    const byName = await t.fw.framework.executeToolCall({ id: 'early', name: 'arc--status', input: {} } as never);
    assert.equal(resultText(byName), 'status done', 'its listed name still calls it, where the tool list put it');
    assert.equal(resultText(await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'status', args: {} })), 'status done', 'act calls it, where the server\'s latest list put it');
    release();
    await waitFor(() => !t.fw.framework.getAllTools().some((x) => x.name === 'arc--status'), 'the rebuild drops status');
    const late = await t.fw.framework.executeToolCall({ id: 'late', name: 'arc--status', input: {} } as never);
    assert.match(String(late.error), /status is a dynamic tool of arc, called with toolsets--act/);
    assert.equal(resultText(await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'status', args: {} })), 'status done');
  } finally {
    release();
    await t.done();
  }
});

test('RFC-014 §4.2: a static tool the tool list hasn\'t published isn\'t taken through act', async () => {
  const newt = { name: 'newt', description: 'A newt.', inputSchema: { type: 'object', properties: {} } };
  const { t, moveAndHold, release } = await movingServer([...withPresence('peek', 'static'), newt]);
  try {
    await moveAndHold();
    const viaAct = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'newt', args: {} });
    assert.ok(viaAct.isError);
    assert.match(resultText(viaAct), /newt is not a dynamic tool/);
    assert.match(resultText(viaAct), /arc--newt/, 'naming the name it\'s called by');
    assert.equal(resultText(await t.fw.framework.executeToolCall({ id: 'byname', name: 'arc--newt', input: {} } as never)), 'newt done', 'which takes it');
    release();
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--newt'), 'the rebuild publishes newt');
  } finally {
    release();
    await t.done();
  }
});

test('RFC-014 §4.2: look names a tool by the definition act would check, wherever act would take it', async () => {
  const { t, moveAndHold, release } = await movingServer(withPresence('peek', 'static'));
  try {
    const hinted = { name: 'peek', visible: false, definition: { description: 'Peek, from a hint.', inputSchema: { type: 'object', properties: { far: { type: 'boolean' } } } } };
    t.server.peer.notify('tools/hints', t.state.hint([hinted]));
    // The server's own statement keeps restating the definition (RFC §6.1), as the move's recovery reads it.
    t.state.statement.push(hinted);
    await roundTrip(t);
    await moveAndHold();
    assert.match(resultText(await callTool(t.fw.framework, 'toolsets--look', { server: 'arc', tool: 'peek' })), /^peek\(far\?: boolean\)[\s\S]*Peek, from a hint\./, 'act would still take it, so look shows the hint\'s definition');
    release();
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the rebuild shows peek');
    assert.match(resultText(await callTool(t.fw.framework, 'toolsets--look', { server: 'arc', tool: 'peek' })), /Peek around\./, 'act wouldn\'t, so look shows the listed one');
  } finally {
    release();
    await t.done();
  }
});

/** arc, whose tools/list moves peek to static once `move` is called, and a second server, slow, whose tools/list can be held. */
async function arcAndSlow() {
  let moved = false;
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/list' || !moved) return false;
    peer.reply(msg.id, { tools: withPresence('peek', 'static'), _meta: { 'mcpl/rev': state.rev } });
    return true;
  });
  let holdNext = false;
  let held: (() => void) | null = null;
  const slow = await startScriptedServer({
    advert: { featureSets: ADVERT.featureSets },
    tools: [TOOLS[0]!],
    onList: (msg, peer) => {
      if (!holdNext) return false;
      holdNext = false;
      held = () => peer.reply(msg.id, { tools: [TOOLS[0]!] });
      return true;
    },
  });
  await t.fw.framework.connectMcplServer({ id: 'slow', toolPrefix: 'slow', url: slow.url });
  await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'slow--status'), 'slow listed');
  const move = async () => {
    moved = true;
    const lists = t.methods().filter((m) => m === 'tools/list').length;
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => t.methods().filter((m) => m === 'tools/list').length > lists, 'the recovery\'s tools/list asked for');
    await roundTrip(t);
    holdNext = true;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => held !== null, 'the rebuild waits on slow');
  };
  const unmove = () => { moved = false; };
  const release = () => { const h = held; held = null; h?.(); };
  const toldMoved = () => notices(t.fw).filter((x) => x.includes('peek is in your tool list now')).length;
  return { t, slow, move, unmove, release, toldMoved, async done() { release(); await t.done(); await slow.close(); } };
}

test('RFC-014 §4.2: a move is told once the rebuild has published every server\'s list, and a call by name before then still goes through', async () => {
  const s = await arcAndSlow();
  try {
    await s.move();
    assert.equal(s.toldMoved(), 0, 'not told while the rebuild waits on another server');
    const byName = await s.t.fw.framework.executeToolCall({ id: 'early', name: 'arc--peek', input: {} } as never);
    assert.equal(resultText(byName), 'peek done', 'the server\'s latest list put it there');
    s.release();
    await waitFor(() => s.toldMoved() === 1, 'told once the rebuild publishes');
    assert.ok(s.t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the tool list shows it');
  } finally { await s.done(); }
});

test('RFC-014 §4.2: a rebuild that never publishes leaves its moves to the one that does, which tells each once', async () => {
  const s = await arcAndSlow();
  const third = await startScriptedServer({ advert: { featureSets: ADVERT.featureSets }, tools: [TOOLS[0]!] });
  try {
    await s.move();
    assert.equal(s.toldMoved(), 0, 'not told by the rebuild that waits');
    await s.t.fw.framework.connectMcplServer({ id: 'third', toolPrefix: 'third', url: third.url });
    await waitFor(() => s.t.fw.framework.getAllTools().some((x) => x.name === 'third--status' || x.name === 'arc--peek'), 'the newer rebuild published');
    await waitFor(() => s.toldMoved() === 1, 'told by the rebuild that published');
    s.release();
    // A rebuild that never publishes changes nothing a caller sees, so its end has no public sign: this waits on the framework's own flag.
    await waitFor(() => (s.t.fw.framework as unknown as { mcplToolRefreshInFlight: boolean }).mcplToolRefreshInFlight === false, 'the older rebuild ended');
    await roundTrip(s.t);
    await nextMacrotask();
    assert.equal(s.toldMoved(), 1, 'told once');
  } finally {
    await s.done();
    await third.close();
  }
});

test('RFC-014 §4.2: a move a list undoes while the rebuild waits on another server is never told, and the tool list follows the undoing at the next refresh', async () => {
  const s = await arcAndSlow();
  try {
    await s.move();
    s.unmove();
    const lists = s.t.methods().filter((m) => m === 'toolsets/list').length;
    s.t.state.next();
    s.t.server.peer.notify('tools/hints', s.t.state.hint([]));
    await waitFor(() => s.t.methods().filter((m) => m === 'toolsets/list').length > lists, 'the undoing list read');
    s.release();
    await waitFor(() => s.t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the rebuild publishes what it listed');
    assert.equal(resultText(await s.t.fw.framework.executeToolCall({ id: 'stale', name: 'arc--peek', input: {} } as never)), 'peek done', 'callable where the tool list shows it');
    assert.equal(resultText(await callTool(s.t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'peek', args: {} })), 'peek done', 'and where the server\'s latest list put it');
    s.t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => !s.t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the next refresh follows the undoing');
    await roundTrip(s.t);
    await nextMacrotask();
    assert.equal(s.toldMoved(), 0, 'never told');
  } finally { await s.done(); }
});

test('RFC-014 §4.2: where the tool list hasn\'t published a tool, the server\'s latest list decides where it is called', async () => {
  const newd = { name: 'newd', description: 'A new dynamic tool.', inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } };
  const { t, moveAndHold, release } = await movingServer([...withPresence('peek', 'static'), newd]);
  try {
    await moveAndHold();
    const byName = await t.fw.framework.executeToolCall({ id: 'byname', name: 'arc--newd', input: {} } as never);
    assert.ok(byName.isError, 'refused by name');
    assert.match(String(byName.error), /newd is a dynamic tool of arc/);
    assert.equal(resultText(await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'newd', args: {} })), 'newd done', 'taken through act');
    release();
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the rebuild publishes');
  } finally {
    release();
    await t.done();
  }
});

/** Several of the connection's reads in one synchronous run, as when they arrive in one chunk. */
const chunk = (t: Awaited<ReturnType<typeof setup>>, ...messages: Json[]) => {
  const connection = (t.fw.framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } }).mcplServerRegistry.getServer('arc');
  const transport = (connection as { transport: { emit(event: string, line: string): void } }).transport;
  for (const m of messages) transport.emit('line', JSON.stringify({ jsonrpc: '2.0', ...m }));
};
/** A server that holds the requests of the methods in `holding` until a test answers them. */
async function holdingServer(config: Partial<McplServerConfig> = {}) {
  const holding = new Set<string>();
  const held: Json[] = [];
  const t = await setup((msg) => {
    if (!holding.has(String(msg.method))) return false;
    held.push(msg);
    return true;
  }, config);
  return { t, holding, held };
}
const storedResult = (t: Awaited<ReturnType<typeof setup>>, toolUseId: string): string => JSON.stringify(
  t.fw.framework.getAgent('scout')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
    .find((b) => b.type === 'tool_result' && b.toolUseId === toolUseId)?.content ?? null);
const statusResult = (id: unknown, hints: Json) => ({ id, result: { content: [{ type: 'text', text: 'status done' }], _meta: { 'mcpl/hints': hints } } });

test('a call\'s change told as a notice before the puppet stores the call isn\'t stored again with its result', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('tools/call');
    const call = t.fw.framework.puppetToolCall('scout', 'arc--status', {});
    await waitFor(() => held.length === 1, 'the call reached the server');
    holding.clear();
    const before = notices(t.fw).length;
    chunk(t, statusResult(held[0]!.id, t.state.hint([{ name: 'peek', visible: true }])),
      { method: 'tools/hints', params: t.state.hint([{ name: 'peek', visible: false }]) });
    const { toolUseId } = await call;
    const told = notices(t.fw).slice(before);
    const shown = told.findIndex((x) => x.includes('peek()'));
    const gone = told.findIndex((x) => x.includes('now unavailable: peek'));
    assert.ok(shown >= 0 && shown < gone, 'the call\'s change, then the later one');
    assert.doesNotMatch(storedResult(t, toolUseId), /peek\(\)/, 'not stored again with the result');
  } finally { await t.done(); }
});

test('without the pushEvents grant, a call\'s change a later read drains before the puppet stores the call is dropped, not stored with its result', async () => {
  const { t, holding, held } = await holdingServer({ disabledCapabilities: ['pushEvents'] });
  try {
    holding.add('tools/call');
    const call = t.fw.framework.puppetToolCall('scout', 'arc--status', {});
    await waitFor(() => held.length === 1, 'the call reached the server');
    holding.clear();
    const before = notices(t.fw).length;
    chunk(t, statusResult(held[0]!.id, t.state.hint([{ name: 'peek', visible: true }])),
      { method: 'tools/hints', params: t.state.hint([]) });
    const { toolUseId } = await call;
    assert.equal(notices(t.fw).length, before, 'no notice');
    assert.doesNotMatch(storedResult(t, toolUseId), /peek\(\)/);
  } finally { await t.done(); }
});

test('an ended record two statements report before either is told is told once', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('toolsets/list');
    const looks = [look(t.fw), look(t.fw)];
    await waitFor(() => held.length === 2, 'both looks asked the server');
    holding.clear();
    t.state.ended = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
    chunk(t, { id: held[0]!.id, result: t.state.listResult() }, { id: held[1]!.id, result: t.state.listResult() });
    await Promise.all(looks);
    await roundTrip(t);
    assert.equal(windowText(t.fw.framework).join('\n').split('[arc/game:g1] ended: the game is over.').length - 1, 1);
  } finally { await t.done(); }
});

test('an ended record that expires while its note waits is still told once', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('toolsets/list');
    const looks = [look(t.fw), look(t.fw)];
    await waitFor(() => held.length === 2, 'both looks asked the server');
    holding.clear();
    t.state.ended = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
    const first = t.state.listResult();
    t.state.ended = [];
    chunk(t, { id: held[0]!.id, result: first }, { id: held[1]!.id, result: t.state.listResult() });
    await Promise.all(looks);
    await roundTrip(t);
    assert.equal(windowText(t.fw.framework).join('\n').split('[arc/game:g1] ended: the game is over.').length - 1, 1);
  } finally { await t.done(); }
});

test('a recovery\'s tools/list change is told as it is read, before a hint read after it in the same chunk', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('tools/list');
    const before = notices(t.fw).length;
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => held.length === 1, 'the recovery\'s tools/list asked for');
    holding.clear();
    const tools = TOOLS.map((x) => (x.name === 'peek' ? { ...x, _meta: { ...(x._meta as Json), 'mcpl/visible': true } } : x));
    chunk(t, { id: held[0]!.id, result: { tools, _meta: { 'mcpl/rev': t.state.rev } } },
      { method: 'tools/hints', params: t.state.hint([{ name: 'peek', visible: false }]) });
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('now unavailable: peek')), 'the hint\'s change told');
    const told = notices(t.fw).slice(before);
    const shown = told.findIndex((x) => x.includes('peek()'));
    assert.ok(shown >= 0 && shown < told.findIndex((x) => x.includes('now unavailable: peek')), 'the list\'s change first');
  } finally { await t.done(); }
});

test('a change a filtered look hands back is told before a change read after it in the same chunk', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('toolsets/list');
    const before = notices(t.fw).length;
    const pending = look(t.fw, { server: 'arc', tool: 'status' });
    await waitFor(() => held.length === 1, 'look asked the server');
    holding.clear();
    t.state.statement = [{ name: 'dig', visible: true }, { name: 'peek', visible: true }];
    chunk(t, { id: held[0]!.id, result: t.state.listResult() },
      { method: 'tools/hints', params: t.state.hint([{ name: 'peek', visible: false }]) });
    await pending;
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('now unavailable: peek')), 'the later change told');
    const told = notices(t.fw).slice(before);
    const shown = told.findIndex((x) => x.includes('peek()'));
    assert.ok(shown >= 0 && shown < told.findIndex((x) => x.includes('now unavailable: peek')), 'look\'s change first');
  } finally { await t.done(); }
});

test('an instance reopened under an ended instance\'s name is told closed when it goes', async () => {
  const t = await setup();
  const told = (text: string) => windowText(t.fw.framework).join('\n').split(text).length - 1;
  try {
    t.state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
    await look(t.fw);
    t.state.open = [];
    t.state.ended = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
    await look(t.fw);
    await waitFor(() => told('[arc/game:g1] ended: the game is over.') === 1, 'the end told');
    t.state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
    await look(t.fw);
    t.state.open = [];
    const closed = told('[arc/game:g1] is closed');
    await look(t.fw);
    await roundTrip(t);
    assert.equal(told('[arc/game:g1] is closed') - closed, 1, 'the reopened instance told closed');
    assert.equal(told('[arc/game:g1] ended: the game is over.'), 1, 'the end not told again');
  } finally { await t.done(); }
});

test('a notice describes a definition it shows in two instances only once', async () => {
  const t = await setup();
  try {
    t.state.open = [{ toolset: 'game', instance: 'g1', title: 'G1' }, { toolset: 'game', instance: 'g2', title: 'G2' }];
    await look(t.fw);
    await waitFor(() => notices(t.fw).some((x) => x.includes('[arc/game:g2]')), 'look\'s change told');
    const before = notices(t.fw).length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'play', instance: 'g1', visible: true }, { name: 'play', instance: 'g2', visible: true }]));
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('play(')), 'the change told');
    await roundTrip(t);
    const text = notices(t.fw).slice(before).join('\n');
    assert.match(text, /\[arc\/game:g1\]/);
    assert.equal(text.split('play(').length - 1, 2, 'the tool in each');
    assert.equal(text.split('Play a point.').length - 1, 1, 'its first sentence once');
  } finally { await t.done(); }
});

test('a hint restating the presence a recovery\'s tools/list moved a tool to leaves the move to be told at the next refresh', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  const t = await setup(() => false, {}, ADVERT, tools);
  const told = () => notices(t.fw).filter((x) => x.includes('peek is in your tool list now')).length;
  try {
    present(tools, 'peek', 'static');
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, 'a skipped rev recovered');
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', presence: 'static' }]));
    await roundTrip(t);
    assert.equal(told(), 0, 'not before the refresh');
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => t.fw.framework.getAllTools().some((x) => x.name === 'arc--peek'), 'the refresh shows peek');
    await roundTrip(t);
    assert.equal(told(), 1, 'told once, at the refresh');
  } finally { await t.done(); }
});

test('a definition a hint gives after a separate hinted move is used once the tool list makes the tool dynamic', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  const t = await setup(() => false, {}, ADVERT, tools);
  try {
    const definition = { description: 'Status, from a hint.', inputSchema: { type: 'object', properties: { loud: { type: 'boolean' } } } };
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'status', presence: 'dynamic' }]));
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'status', definition }]));
    // The server's own statement restates the definition in force (RFC §6.1), as look's re-read reads it.
    t.state.statement.push({ name: 'status', visible: true, definition });
    await roundTrip(t);
    present(tools, 'status', 'dynamic');
    const status = tools.find((x) => x.name === 'status')!;
    status._meta = { ...(status._meta as Json), 'mcpl/visible': true };
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => !t.fw.framework.getAllTools().some((x) => x.name === 'arc--status'), 'the tool list makes status dynamic');
    const refused = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'status', args: { loud: 'yes' } });
    assert.ok(refused.isError, 'checked against the hint\'s definition');
    assert.match(resultText(refused), /loud/);
    assert.match(await look(t.fw, { server: 'arc', tool: 'status' }), /Status, from a hint\./);
  } finally { await t.done(); }
});

test('a tool listed twice is known by its first listing, which act checks arguments against', async () => {
  const tools: Json[] = [...TOOLS.filter((x) => x.name !== 'peek'),
    { name: 'peek', description: 'The first listing.', inputSchema: { type: 'object', properties: { far: { type: 'boolean' } } }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } },
    { name: 'peek', description: 'The second listing.', inputSchema: { type: 'object', properties: { far: { type: 'string' } } }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } }];
  const t = await setup(() => false, {}, ADVERT, tools);
  try {
    assert.match(await look(t.fw, { server: 'arc', tool: 'peek' }), /The first listing\./);
    const refused = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'peek', args: { far: 'yes' } });
    assert.ok(refused.isError, 'checked against the first listing\'s schema');
  } finally { await t.done(); }
});

test('a first sentence is cut by characters, never inside one', async () => {
  const tools: Json[] = [...TOOLS.filter((x) => x.name !== 'peek'),
    { name: 'peek', description: `${'x'.repeat(138)}\u{1F600}\u{1F600}\u{1F600} and more`, inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } }];
  const t = await setup(() => false, {}, ADVERT, tools);
  try {
    const before = notices(t.fw).length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('peek()')), 'peek announced');
    const line = notices(t.fw).slice(before).join('\n').split('\n').find((x) => x.includes('peek()'))!;
    assert.match(line, /x\u{1F600}…$/u, 'cut after a whole character');
    assert.doesNotMatch(line, /\uFFFD/, 'nothing replaced for a broken character');
  } finally { await t.done(); }
});

test('a group the host opened, which the manifest then declares, is no longer open: close says nothing is open, and once the manifest drops it act is refused', async () => {
  let advert: Json = ADVERT;
  const t = await setup((msg, peer) => {
    if (msg.method === 'mcpl/manifest') { peer.reply(msg.id, { version: '0.5', pushEvents: true, ...advert }); return true; }
    return false;
  });
  const count = (method: string) => t.methods().filter((m) => m === method).length;
  // A manifest change is applied once the host asks for the tool list it rebuilds after it, which
  // comes after the fetch (held back to one per five seconds) and its feature-set update.
  const changeManifest = async (next: Json) => {
    const [manifests, lists] = [count('mcpl/manifest'), count('tools/list')];
    advert = next;
    t.server.peer.notify('mcpl/manifestChanged', { revision: `r${manifests + 2}`, domains: ['toolsets'] });
    await waitFor(() => count('mcpl/manifest') > manifests && count('tools/list') > lists, 'the manifest fetched again and applied');
    await roundTrip(t);
  };
  try {
    await callTool(t.fw.framework, 'toolsets--open', { server: 'arc', toolset: 'cave' });
    await changeManifest({ ...ADVERT, toolsets: { ...(ADVERT.toolsets as Json), cave: { title: 'Cave' } } });
    const closed = await callTool(t.fw.framework, 'toolsets--close', { server: 'arc' });
    assert.ok(closed.isError);
    assert.match(resultText(closed), /nothing is open on arc/);
    await changeManifest(ADVERT);
    const gated = await callTool(t.fw.framework, 'toolsets--act', { server: 'arc', tool: 'dig', args: {} });
    assert.ok(gated.isError);
    assert.match(resultText(gated), /dig is in cave, which isn't open/);
  } finally { await t.done(); }
});

/** JSON nested `depth` levels deep, written as text: a server that writes JSON without JSON.stringify can send it. */
const deepObjectJson = (depth: number) => `${'{"type":"object","properties":{"a":'.repeat(depth)}{"type":"string"}${'}}'.repeat(depth)}`;
const deepArrayJson = (depth: number) => `${'{"type":"array","items":'.repeat(depth)}{"type":"string"}${'}'.repeat(depth)}`;
const rawLine = (t: Awaited<ReturnType<typeof setup>>, line: string) => {
  const connection = (t.fw.framework as unknown as { mcplServerRegistry: { getServer(id: string): unknown } }).mcplServerRegistry.getServer('arc');
  (connection as { transport: { emit(event: string, line: string): void } }).transport.emit('line', line);
};

test('a tool a server describes malformed (a description that isn\'t a string, a schema nested very deep) is still announced and looked at', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('tools/list');
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => held.length === 1, 'the tool list asked for');
    holding.clear();
    const listed = TOOLS.filter((x) => x.name !== 'peek').map((x) => JSON.stringify(x)).join(',');
    const dynamic = '"_meta":{"mcpl/presence":"dynamic","mcpl/visible":true}';
    rawLine(t, `{"jsonrpc":"2.0","id":${JSON.stringify(held[0]!.id)},"result":{"tools":[${listed},`
      + `{"name":"peek","description":42,"inputSchema":{"type":"object","properties":{}},${dynamic}},`
      + `{"name":"delve","description":"Delve.","inputSchema":${deepObjectJson(20000)},${dynamic}},`
      + `{"name":"burrow","description":"Burrow.","inputSchema":{"type":"object","properties":{"rows":${deepArrayJson(20000)}}},${dynamic}}],`
      + `"_meta":{"mcpl/rev":${t.state.rev}}}}`);
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('burrow(')), 'the tools announced');
    const text = notices(t.fw).slice(before).join('\n');
    assert.match(text, /peek\(\)/);
    assert.match(text, /delve\(a\?: .*\) — Delve\./);
    assert.match(text, /burrow\(rows\?: .*\) — Burrow\./);
    assert.match(await look(t.fw, { server: 'arc', tool: 'delve' }), /inputSchema:\n\(nested too deeply to show\)/);
  } finally { await t.done(); }
});


test('a first sentence that reached the model is left out of the next announcement of the same definition', async () => {
  const t = await setup();
  const fresh = async (step: () => void, what: string) => {
    const before = notices(t.fw).length;
    step();
    await waitFor(() => notices(t.fw).length > before, what);
    await roundTrip(t);
    return notices(t.fw).slice(before).join('\n');
  };
  try {
    assert.match(await fresh(() => t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }])), 'peek shown'), /peek\(\) — Peek around\./);
    await fresh(() => t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: false }])), 'peek hidden');
    const again = await fresh(() => t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }])), 'peek shown again');
    assert.match(again, /peek\(\)/);
    assert.doesNotMatch(again, /Peek around\./, 'its first sentence once');
  } finally { await t.done(); }
});

test('a look that restates the present counts as shown only what it showed: a tool a hint hid while look waited on another server keeps its first sentence owed', async () => {
  const t = await setup();
  let holdFar = false;
  let heldFar: (() => void) | null = null;
  const far = await startScriptedServer({
    advert: ADVERT,
    tools: [{ name: 'status', description: 'Status of the far arcade.', inputSchema: { type: 'object', properties: {} } }],
    listRev: () => 1,
    on: (msg, peer) => {
      if (msg.method === 'toolsets/list') {
        const answer = () => peer.reply(msg.id, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [] } } });
        if (holdFar) { holdFar = false; heldFar = answer; } else answer();
        return;
      }
      if (msg.method === 'tools/call') { peer.reply(msg.id, { content: [{ type: 'text', text: 'done' }] }); return; }
      if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  try {
    await t.fw.framework.connectMcplServer({ id: 'far', toolPrefix: 'far', url: far.url, toolHints: true } as McplServerConfig);
    await waitFor(() => far.received.some((m) => m.method === 'toolsets/list'), 'far connected and read');
    holdFar = true;
    const lists = t.methods().filter((m) => m === 'toolsets/list').length;
    t.state.statement = [{ name: 'peek', visible: true }];
    const looked = t.fw.framework.puppetToolCall('scout', 'toolsets--look', {});
    await waitFor(() => heldFar !== null && t.methods().filter((m) => m === 'toolsets/list').length > lists, 'look asked both servers; far holds its answer');
    await roundTrip(t);
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: false }]));
    await waitFor(() => notices(t.fw).some((x) => x.includes('now unavailable: peek')), 'the hint hid peek while look waited');
    heldFar!();
    assert.doesNotMatch(resultText((await looked).result), /peek\(\)/, 'look showed the present, with peek hidden');
    await roundTrip(t);
    const before = notices(t.fw).length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('peek()')), 'peek shown');
    assert.match(notices(t.fw).slice(before).join('\n'), /peek\(\) — Peek around\./, 'its first sentence, never yet shown');
  } finally { await t.done(); await far.close(); }
});

test('a tool whose schema holds a literal nested very deep or a type that isn\'t text, or whose description or class entries are objects, is announced and looked at', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('tools/list');
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => held.length === 1, 'the tool list asked for');
    holding.clear();
    const listed = TOOLS.filter((x) => x.name !== 'peek').map((x) => JSON.stringify(x)).join(',');
    const dynamic = '"_meta":{"mcpl/presence":"dynamic","mcpl/visible":true}';
    const deep = `${'{"a":'.repeat(20000)}1${'}'.repeat(20000)}`;
    rawLine(t, `{"jsonrpc":"2.0","id":${JSON.stringify(held[0]!.id)},"result":{"tools":[${listed},`
      + `{"name":"peek","description":{"toString":1},"inputSchema":{"type":"object","properties":{}},"_meta":{"mcpl/presence":"dynamic","mcpl/visible":true,"mcpl/class":["game",{"toString":1}]}},`
      + `{"name":"fixed","description":"Fixed.","inputSchema":{"type":"object","properties":{"a":{"const":${deep}},"b":{"enum":[${deep}]},"c":{"type":"string","default":${deep}},"d":{"type":{"toString":1}},"e":{"type":["string",{"toString":1}]}}},${dynamic}}],`
      + `"_meta":{"mcpl/rev":${t.state.rev}}}}`);
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('fixed(')), 'the tools announced');
    assert.match(notices(t.fw).slice(before).join('\n'), /fixed\(a\?: …, b\?: …, c\?: string =…, d\?: any, e\?: string\) — Fixed\./);
    const peek = await look(t.fw, { server: 'arc', tool: 'peek' });
    assert.match(peek, /^peek\(\)\nclass: game\ninputSchema:/, 'no description where it isn\'t text, and only the class entries that are');
    assert.match(await look(t.fw, { server: 'arc', tool: 'fixed' }), /^fixed\(a\?: …, b\?: …, c\?: string =…, d\?: any, e\?: string\)\nFixed\./);
  } finally { await t.done(); }
});

test('whatever the runtime\'s stack, a literal is written out up to 65 levels deep and cut to … past that, and look shows a schema\'s JSON whose deepest object is up to 64 levels below it and says too deep past that', async () => {
  const { t, holding, held } = await holdingServer();
  try {
    holding.add('tools/list');
    const before = notices(t.fw).length;
    t.server.peer.notify('notifications/tools/list_changed', {});
    await waitFor(() => held.length === 1, 'the tool list asked for');
    holding.clear();
    const listed = TOOLS.filter((x) => x.name !== 'peek').map((x) => JSON.stringify(x)).join(',');
    const dynamic = '"_meta":{"mcpl/presence":"dynamic","mcpl/visible":true}';
    const nested = (levels: number) => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
    rawLine(t, `{"jsonrpc":"2.0","id":${JSON.stringify(held[0]!.id)},"result":{"tools":[${listed},`
      + `{"name":"bounded","description":"Bounded.","inputSchema":{"type":"object","properties":{"a":{"const":${nested(65)}},"b":{"const":${nested(66)}}}},${dynamic}},`
      + `{"name":"edge","description":"Edge.","inputSchema":{"type":"object","properties":{"a":{"const":${nested(62)}}}},${dynamic}},`
      + `{"name":"past","description":"Past.","inputSchema":{"type":"object","properties":{"a":{"const":${nested(63)}}}},${dynamic}}],`
      + `"_meta":{"mcpl/rev":${t.state.rev}}}}`);
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('bounded(')), 'the tool announced');
    const line = notices(t.fw).slice(before).join('\n').split('\n').find((l) => l.includes('bounded('))!;
    assert.ok(line.includes(`a?: ${nested(65)}, b?: …)`), line.slice(0, 200));
    assert.match(await look(t.fw, { server: 'arc', tool: 'bounded' }), /inputSchema:\n\(nested too deeply to show\)/);
    assert.match(await look(t.fw, { server: 'arc', tool: 'edge' }), /inputSchema:\n\{\n  "type": "object"/);
    assert.match(await look(t.fw, { server: 'arc', tool: 'past' }), /inputSchema:\n\(nested too deeply to show\)/);
  } finally { await t.done(); }
});

test('a puppet look that restates the present, whose pair can\'t be stored, tells the change it found as a notice', async () => {
  const t = await setup();
  try {
    const cm = t.fw.framework.getAgent('scout')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    let refused = false;
    cm.addMessage = ((...args: Parameters<typeof add>) => {
      if (!refused) {
        refused = true;
        throw new Error('the store refused the write');
      }
      return add(...args);
    }) as typeof cm.addMessage;
    const before = notices(t.fw).length;
    t.state.statement = [{ name: 'peek', visible: true }];
    await assert.rejects(t.fw.framework.puppetToolCall('scout', 'toolsets--look', { server: 'arc' }), /the store refused the write/);
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('peek()')), 'the change look found, told as a notice');
  } finally { await t.done(); }
});
