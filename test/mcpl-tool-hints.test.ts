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
import { firstSentence } from '../src/mcpl/tool-signature.js';
import { META_TOOL_NAMES, ToolsetHub } from '../src/mcpl/toolset-host.js';
import { ToolsetsModule, resolveAct } from '../src/mcpl/toolsets-module.js';
import {
  startScriptedServer, makeFramework, waitFor, callTool, resultText, windowText,
  type Json, type ScriptedPeer,
} from './helpers/toolset-servers.js';

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

test('toolHints off: the advertisement, tool list and traffic are as before', async () => {
  const t = await setup(() => false, { toolHints: undefined });
  try {
    const hostMcpl = t.server.peer.hostCaps?.mcpl as Json;
    assert.ok(!('toolHints' in hostMcpl), 'no toolHints advertised');
    assert.ok(!('access' in hostMcpl), 'no access advertised');
    assert.deepEqual(hostMcpl, (t.fw.framework as unknown as { mcplHostCapabilities: Json }).mcplHostCapabilities,
      'the very capabilities every server is offered');
    const names = t.fw.framework.getAllTools().map((x) => x.name);
    for (const tool of ['status', 'play', 'place', 'dig', 'peek']) assert.ok(names.includes(`arc--${tool}`), `arc--${tool} listed as before`);
    assert.ok(!names.some((n) => n.startsWith('toolsets--')), 'no meta-tools');
    assert.ok(!t.methods().includes('toolsets/list'), 'no toolsets/list');
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
  } finally { await t.done(); }
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
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('tool changes') && x.includes('now unavailable: peek')), 'the refused push\'s change applied, and told as a notice');
    // The next change has the next rev and applies without any recovery.
    const lists = t.methods().filter((m) => m === 'tools/list').length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('tool changes') && x.includes('peek()')), 'the next change applied, and told');
    await settle(400);
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
    await settle(400);
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

test('toolHints is a boolean, and only for an MCPL server', () => {
  assert.throws(() => assertServerConfigBooleans({ id: 's', url: 'ws://127.0.0.1:1/mcpl', toolHints: 'false' as unknown as boolean }), /toolHints/);
  assert.doesNotThrow(() => assertServerConfigBooleans({ id: 's', url: 'ws://127.0.0.1:1/mcpl', toolHints: null as unknown as boolean }));
  assert.ok(serverConfigProblems({ id: 's', url: 'https://example.invalid/mcp', toolHints: true }).some((p) => p.includes('"toolHints"')),
    'a modern server refuses it');
  assert.deepEqual(serverConfigProblems({ id: 's', url: 'https://example.invalid/mcp', toolHints: false }), []);
  assert.deepEqual(serverConfigProblems({ id: 's', url: 'ws://127.0.0.1:1/mcpl', toolHints: true }), []);
});

test('act and a direct call take one dispatch path: state exchange, lifecycle, results; only _meta differs', async () => {
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
  const dispatched: string[] = [];
  const internals = fw.framework as unknown as { dispatchMcplToolCall: (agent: string, call: { name: string }, ...rest: unknown[]) => void };
  const original = internals.dispatchMcplToolCall.bind(fw.framework);
  internals.dispatchMcplToolCall = (agent, call, ...rest) => { dispatched.push(call.name); original(agent, call, ...rest); };
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

    // One path: the same dispatch, under each tool's own name.
    assert.deepEqual(dispatched, ['arc--status', 'arc--play', 'arc--status']);
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
    assert.ok(!windowText(fw.framework).some((t) => t.includes('tool changes')), 'told once, in the result');
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

test('the host\'s argument check is bounded: no server pattern runs, and deep or wide schemas are left to the server', async () => {
  const { checkArgs } = await import('../src/mcpl/tool-signature.js');
  // A pattern that backtracks catastrophically is never evaluated.
  const started = Date.now();
  assert.equal(checkArgs({ type: 'object', properties: { s: { type: 'string', pattern: '^(a+)+$' } } }, { s: `${'a'.repeat(40)}!` }), null);
  assert.ok(Date.now() - started < 100);
  // Types, enums and the rest are still checked.
  assert.match(checkArgs({ type: 'object', properties: { n: { enum: [1, 2] } } }, { n: 3 })!, /must be one of 1\|2/);
  // Nesting past the bound: unchecked rather than recursed into.
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 200; i++) deep = { allOf: [deep] };
  assert.equal(checkArgs(deep, 5), null);
  // anyOf fan-out that would take exponential time: unchecked past the step budget.
  let wide: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 20; i++) wide = { anyOf: [{ allOf: [wide, { type: 'number' }] }, { allOf: [wide, { type: 'boolean' }] }] };
  const t0 = Date.now();
  assert.equal(checkArgs(wide, null), null);
  assert.ok(Date.now() - t0 < 200, 'bounded');
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
  try {
    assert.match(await look(t.fw), /\[arc\/game:g1\] ended: the game is over\./, 'look tells it');
    assert.ok(!notices(t.fw).length, 'without pushEvents no notice was written');
    assert.doesNotMatch(await look(t.fw), /ended: the game is over/, 'and only once');
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

test('a lost move is repaired by the recovery\'s tools/list, and the model\'s tool list follows it without a further list change', async () => {
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
    await waitFor(() => !listed().includes('arc--peek'), 'a skipped rev recovered, and the tool list rebuilt from it without peek');
    assert.doesNotMatch(await actOnPeek(), /is not a dynamic tool/);
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

test('reminders restate only servers whose changes may be told unasked', () => {
  const told = (canNotify: boolean) => {
    const deps = { notify: () => true, canNotify: () => canNotify, refreshTools: () => {}, log: () => {}, listedName: (_s: string, tool: string) => `arc--${tool}` };
    const hub = new ToolsetHub(deps);
    const c = hub.controllerFor({ id: 'arc', toolHints: true } as McplServerConfig);
    c.presence.beginConnection({ toolHints: true, toolsets: { build: { title: 'Building' } } }, true);
    c.presence.setTools([{ name: 'place', description: 'Place a block.', inputSchema: { type: 'object' }, _meta: { 'mcpl/toolset': 'build' } }]);
    c.presence.noteOpened('build', undefined, 'Workshop');
    hub.observeCompile('scout', [{ role: 'user', content: [{ type: 'text', text: '[arc/build] Workshop tools now' }] }]);
    hub.observeCompile('scout', [{ role: 'user', content: [{ type: 'text', text: 'later' }] }]);
    return hub.reminderFor('scout');
  };
  assert.match(told(true) ?? '', /\[arc\/build\] Workshop/);
  assert.equal(told(false), null);
});

test('a first sentence is cut by characters, never inside a surrogate pair', () => {
  const cut = firstSentence(`${'a'.repeat(138)}😀😀 and more`);
  assert.equal([...cut].length, 140);
  assert.ok(cut.endsWith('…'));
  assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone high surrogate');
});

test('a group the host opened that the manifest then declares, and later drops, isn\'t open', () => {
  const p = new ToolPresence('arc', META_TOOL_NAMES);
  p.beginConnection({ toolHints: true }, true);
  p.setTools([{ name: 'dig', description: 'Dig.', inputSchema: { type: 'object' }, _meta: { 'mcpl/toolset': 'cave' } }]);
  p.openGroup('cave');
  p.setManifest({ toolHints: true, toolsets: { cave: { title: 'Cave' } } });
  p.setManifest({ toolHints: true });
  assert.equal(p.isOpen('cave'), false);
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
    await settle(400);
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

function tappedController(writes: () => boolean = () => true, tools: Json[] = TOOLS, requests: Record<string, (read: (r: unknown) => void) => unknown> = {}) {
  const told: string[] = [];
  const hub = new ToolsetHub({
    notify: (_s: string, text: string) => { if (!writes()) return false; told.push(text); return true; },
    canNotify: () => true, refreshTools: () => {}, log: () => {}, listedName: (_s: string, tool: string) => `arc--${tool}`,
  });
  const c = hub.controllerFor({ id: 'arc', toolHints: true } as McplServerConfig);
  let tap: (read: unknown, epoch: number) => void = () => {};
  const connection = () => ({
    setReadTap: (f: typeof tap | null) => { if (f) tap = f; }, transportEpoch: 0, isConnected: true, toolsetDeclarations: ADVERT,
    sendToolsList: async () => requests.toolsList?.(read),
    sendToolsetsList: async () => requests.toolsetsList?.(read),
  });
  const attached = connection();
  c.attach(attached as never);
  const read = (r: unknown) => tap(r, 0);
  read({ kind: 'result', method: 'tools/list', params: {}, result: { tools }, awaited: true });
  const callResult = (rev: number, tools: Json[]) => ({ content: [{ type: 'text', text: 'ok' }], _meta: { 'mcpl/hints': { rev, tools } } });
  const readCall = (result: Json) => read({ kind: 'result', method: 'tools/call', params: { name: 'status' }, result, awaited: true });
  const reattach = () => {
    c.detach(attached as never);
    c.attach(connection() as never);
    read({ kind: 'result', method: 'tools/list', params: {}, result: { tools }, awaited: true });
  };
  return { hub, c, told, read, callResult, readCall, reattach };
}

test('a result\'s change told as a notice before its caller takes it isn\'t shown again with the result', () => {
  const { c, told, read, callResult, readCall } = tappedController();
  const result = callResult(1, [{ name: 'peek', visible: true }]);
  readCall(result);
  read({ kind: 'hints', params: { rev: 2, tools: [{ name: 'peek', visible: false }] } });
  assert.equal(told.length, 2, 'the result\'s change, then the later one');
  assert.match(told[0]!, /peek\(\)/);
  assert.match(told[1]!, /now unavailable: peek/);
  assert.equal(c.takeChangeText(result), '', 'not shown again with the result');
});

test('a result\'s change drained while no notice can be written is dropped, not shown later with its result', () => {
  const { c, told, read, callResult, readCall } = tappedController(() => false);
  const result = callResult(1, [{ name: 'peek', visible: true }]);
  readCall(result);
  read({ kind: 'hints', params: { rev: 2, tools: [] } });
  assert.equal(told.length, 0);
  assert.equal(c.takeChangeText(result), '');
});

test('taking a result\'s change first tells, as a notice, the change of a result read before it', () => {
  const { c, told, callResult, readCall } = tappedController();
  readCall(callResult(1, [{ name: 'peek', visible: true }]));
  const later = callResult(2, [{ name: 'peek', visible: false }]);
  readCall(later);
  const shown = c.takeChangeText(later);
  assert.equal(told.length, 1, 'the earlier change, told first');
  assert.match(told[0]!, /peek\(\)/);
  assert.match(shown, /now unavailable: peek/);
});

test('an ended record two statements report before either is told is told once', async () => {
  const { told, read } = tappedController();
  const statement = (rev: number) => ({ open: [], ended: [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }], _meta: { 'mcpl/hints': { rev, tools: [] } } });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(1), awaited: true });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(2), awaited: true });
  await nextMacrotask();
  assert.equal(told.join('\n').split('[arc/game:g1] ended: the game is over.').length - 1, 1);
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
    await settle(400);
    const after = t.server.received.slice(from).map((m) => m.method).filter((m) => m === 'tools/list' || m === 'toolsets/list');
    assert.deepEqual(after, ['toolsets/list', 'tools/list', 'toolsets/list'], 'look\'s read, then one recovery: its own toolsets/list, naming lantern again, starts no other');
  } finally { await t.done(); }
});

test('a recovery whose tools/list fails reads no toolsets/list', async () => {
  let failing = false;
  const t = await setup((msg, peer) => {
    if (msg.method !== 'tools/list' || !failing) return false;
    peer.error(msg.id, -32000, 'list unavailable');
    return true;
  });
  try {
    failing = true;
    const from = t.server.received.length;
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => t.server.received.slice(from).some((m) => m.method === 'tools/list'), 'the recovery read tools/list');
    await roundTrip(t);
    await settle(400);
    assert.ok(!t.server.received.slice(from).some((m) => m.method === 'toolsets/list'));
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
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
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
    answer(0, { tools: TOOLS.slice(0, 3), nextCursor: 'a2', _meta: { 'mcpl/rev': rev } });
    answer(1, { tools: [...TOOLS.slice(0, 4), peekFrom('B', false)], _meta: { 'mcpl/rev': rev } });
    await waitFor(() => pages.length >= 3, 'the first list\'s second page asked for');
    answer(2, { tools: [TOOLS[3]!, peekFrom('A', true)], _meta: { 'mcpl/rev': rev } });
    await waitFor(() => notices(t.fw).slice(before).some((x) => x.includes('peek() — From list A.')), 'the first list applied whole, its second page included');
    assert.ok(listed().includes('arc--status'), 'its first page included too');
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
    await settle(400);
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

test('a definition first described in a notice that wasn\'t written is described again', () => {
  let writing = false;
  const { told, read } = tappedController(() => writing);
  read({ kind: 'hints', params: { rev: 1, tools: [{ name: 'peek', visible: true }] } });
  read({ kind: 'hints', params: { rev: 2, tools: [{ name: 'peek', visible: false }] } });
  writing = true;
  read({ kind: 'hints', params: { rev: 3, tools: [{ name: 'peek', visible: true }] } });
  assert.equal(told.length, 1);
  assert.match(told[0]!, /peek\(\) — Peek around\./);
});

test('a tool listed twice is known by its first listing, which act checks arguments against', () => {
  const tools = [...TOOLS.filter((t) => t.name !== 'peek'),
    { name: 'peek', description: 'The first listing.', inputSchema: { type: 'object', properties: { far: { type: 'boolean' } } }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } },
    { name: 'peek', description: 'The second listing.', inputSchema: { type: 'object', properties: { far: { type: 'string' } } }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } }];
  const { hub, told, read } = tappedController(() => true, tools);
  read({ kind: 'hints', params: { rev: 1, tools: [{ name: 'peek', visible: true }] } });
  assert.match(told.join('\n'), /peek\(far\?: boolean\) — The first listing\./);
  const target = resolveAct(hub, { tool: 'peek', args: { far: 'yes' } });
  assert.ok(!target.ok, 'checked against the first listing\'s schema');
});

test('taking a change doesn\'t count its ended record as told: only told() does', async () => {
  const { c, told, read } = tappedController();
  const statement = (rev: number) => ({ open: [], ended: [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }], _meta: { 'mcpl/hints': { rev, tools: [] } } });
  const first = statement(1);
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: first, awaited: true });
  c.takeChange(first);
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(2), awaited: true });
  await nextMacrotask();
  assert.match(told.join('\n'), /\[arc\/game:g1\] ended: the game is over\./, 'still owed after a take with no told');
});

test('a push\'s change that nothing takes is told as a notice', async () => {
  const { told, read } = tappedController();
  read({ kind: 'push', params: { featureSet: 'arc.events', eventId: 'p1', payload: { content: [] }, hints: { rev: 1, tools: [{ name: 'peek', visible: true }] } } });
  await nextMacrotask();
  assert.match(told.join('\n'), /peek\(\)/);
});

test('an ended record told before the server\'s connection was let go isn\'t told again on the next one', async () => {
  const { told, read, reattach } = tappedController();
  const statement = (rev: number) => ({ open: [], ended: [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }], _meta: { 'mcpl/hints': { rev, tools: [] } } });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(1), awaited: true });
  await nextMacrotask();
  reattach();
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(1), awaited: true });
  await nextMacrotask();
  assert.equal(told.join('\n').split('ended: the game is over.').length - 1, 1);
});

test('close with nothing named, after a group the host opened was declared, says nothing is open', async () => {
  const { hub, c } = tappedController();
  c.setGroupOpen('cave', true);
  c.manifestChanged({ toolHints: true, toolsets: { cave: { title: 'Cave' } } });
  const result = await new ToolsetsModule(hub).handleToolCall({ id: 'c1', name: 'close', input: { server: 'arc' } } as never);
  assert.ok(result.isError);
  assert.match(String(result.error), /nothing is open on arc/);
});

test('a tool a recovery\'s list puts in a toolset leaves the model\'s tool list without a further list change', async () => {
  const tools: Json[] = TOOLS.map((x) => ({ ...x }));
  const t = await setup(() => false, {}, ADVERT, tools);
  const listed = () => t.fw.framework.getAllTools().map((x) => x.name);
  try {
    tools.find((x) => x.name === 'status')!._meta = { 'mcpl/toolset': 'build' };
    t.state.next();
    t.server.peer.notify('tools/hints', t.state.hint([]));
    await waitFor(() => !listed().includes('arc--status'), 'the tool list rebuilt from the recovery\'s list');
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

test('a recovery\'s tools/list change is told as it is read, before a hint read after it', async () => {
  const statement = { open: [], _meta: { 'mcpl/hints': { rev: 4, tools: [] } } };
  const { told, read } = tappedController(() => true, TOOLS, {
    toolsList: (r) => {
      const tools = TOOLS.map((x) => (x.name === 'peek' ? { ...x, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } } : x));
      r({ kind: 'result', method: 'tools/list', params: {}, result: { tools, _meta: { 'mcpl/rev': 2 } }, awaited: true });
      r({ kind: 'hints', params: { rev: 3, tools: [{ name: 'peek', visible: false }] } });
      return { tools };
    },
    toolsetsList: (r) => {
      r({ kind: 'result', method: 'toolsets/list', params: {}, result: statement, awaited: true });
      return statement;
    },
  });
  read({ kind: 'hints', params: { rev: 2, tools: [] } });
  await waitFor(() => told.some((x) => x.includes('now unavailable: peek')), 'the recovery ran', 2000);
  const shown = told.findIndex((x) => x.includes('peek()'));
  const gone = told.findIndex((x) => x.includes('now unavailable: peek'));
  assert.ok(shown >= 0 && shown < gone, 'the list\'s change first, then the hint\'s');
});

test('a change look hands back is told before a change read after it', async () => {
  const statement = { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [{ name: 'peek', visible: true }] } } };
  const { c, told, read, callResult, readCall } = tappedController(() => true, TOOLS, {
    toolsetsList: (r) => {
      r({ kind: 'result', method: 'toolsets/list', params: {}, result: statement, awaited: true });
      return statement;
    },
  });
  const cs = await c.refreshOpen();
  readCall(callResult(2, [{ name: 'peek', visible: false }]));
  c.tell(cs!);
  await nextMacrotask();
  const shown = told.findIndex((x) => x.includes('peek()'));
  const gone = told.findIndex((x) => x.includes('now unavailable: peek'));
  assert.ok(shown >= 0 && shown < gone, 'look\'s change first');
});

test('an ended record that expires while its notes wait is still told once', async () => {
  const { told, read } = tappedController();
  const statement = (rev: number, ended: Json[]) => ({ open: [], ended, _meta: { 'mcpl/hints': { rev, tools: [] } } });
  const e1 = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(1, e1), awaited: true });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(2, e1), awaited: true });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(3, []), awaited: true });
  await nextMacrotask();
  assert.equal(told.join('\n').split('ended: the game is over.').length - 1, 1);
});

test('an instance reopened under an ended instance\'s name is told closed when it goes', async () => {
  const { told, read } = tappedController();
  const statement = (rev: number, open: Json[], ended: Json[]) => ({ open, ended, _meta: { 'mcpl/hints': { rev, tools: [] } } });
  const e1 = [{ id: 'e1', toolset: 'game', instance: 'g1', reason: 'the game is over' }];
  const g1 = [{ toolset: 'game', instance: 'g1', title: 'G1' }];
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(1, g1, []), awaited: true });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(2, [], e1), awaited: true });
  await nextMacrotask();
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(3, g1, e1), awaited: true });
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement(4, [], e1), awaited: true });
  await nextMacrotask();
  assert.match(told.join('\n'), /\[arc\/game:g1\] is closed/);
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
    await settle(400);
    assert.ok(!t.server.received.slice(from).some((m) => m.method === 'toolsets/list'), 'no recovery');
  } finally { await t.done(); }
});

test('a notice describes a definition it shows twice only once', async () => {
  const { told, read } = tappedController();
  const statement = { open: [{ toolset: 'game', instance: 'g1', title: 'G1' }, { toolset: 'game', instance: 'g2', title: 'G2' }], _meta: { 'mcpl/hints': { rev: 1, tools: [] } } };
  read({ kind: 'result', method: 'toolsets/list', params: {}, result: statement, awaited: true });
  await nextMacrotask();
  read({ kind: 'hints', params: { rev: 2, tools: [{ name: 'play', instance: 'g1', visible: true }, { name: 'play', instance: 'g2', visible: true }] } });
  const text = told.join('\n');
  assert.match(text, /\[arc\/game:g1\]/, 'both instances are announced');
  assert.match(text, /\[arc\/game:g2\]/, 'both instances are announced');
  assert.equal(text.split('play(').length - 1, 2, 'the tool in each');
  assert.equal(text.split('Play a point.').length - 1, 1, text);
});

const listOf = (tools: Json[]) => ({ kind: 'result', method: 'tools/list', params: {}, result: { tools }, awaited: true });
const movedPeek = (presence: 'static' | 'dynamic') => TOOLS.map((x) => (x.name === 'peek' ? { ...x, _meta: { ...(x._meta as Json), 'mcpl/presence': presence } } : x));

test('a hint restating the presence a tools/list moved a tool to leaves the move to be told at the rebuild', () => {
  const { c, told, read } = tappedController();
  read(listOf(TOOLS));
  read(listOf(movedPeek('static')));
  read({ kind: 'hints', params: { rev: 1, tools: [{ name: 'peek', presence: 'static' }] } });
  assert.doesNotMatch(told.join('\n'), /peek is in your tool list now/, 'not before the rebuild');
  c.applyMoves();
  assert.match(told.join('\n'), /peek is in your tool list now/);
});

test('a move a later tools/list reverses before the rebuild is never told', () => {
  const { c, told, read } = tappedController();
  read(listOf(TOOLS));
  read(listOf(movedPeek('static')));
  read(listOf(movedPeek('dynamic')));
  c.applyMoves();
  assert.doesNotMatch(told.join('\n'), /peek (is in|left) your tool list/);
});

test('a push whose change no notice could carry keeps it for the push\'s own path to take', async () => {
  let writes = false;
  const { c, read } = tappedController(() => writes);
  const params = { featureSet: 'arc.events', eventId: 'p1', payload: { content: [] }, hints: { rev: 1, tools: [{ name: 'peek', visible: true }] } };
  read({ kind: 'push', params });
  await nextMacrotask();
  writes = true;
  assert.match(c.takeChangeText(params), /peek\(\)/);
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
    await settle(400);
    assert.equal(t.server.received.slice(from).filter((m) => m.method === 'toolsets/list').length, 1);
  } finally { await t.done(); }
});

test('a definition a hint gives after a separate hinted move is kept for when the list makes the tool dynamic', () => {
  const { told, read } = tappedController();
  read(listOf(TOOLS));
  read({ kind: 'hints', params: { rev: 1, tools: [{ name: 'status', presence: 'dynamic' }] } });
  read({ kind: 'hints', params: { rev: 2, tools: [{ name: 'status', definition: { description: 'Status, from a hint.', inputSchema: { type: 'object', properties: {} } } }] } });
  read(listOf(TOOLS.map((x) => (x.name === 'status' ? { ...x, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': true } } : x))));
  assert.match(told.join('\n'), /status\(\) — Status, from a hint\./);
});

test('a tool a server describes malformed (a description that isn\'t a string, a schema nested very deep) is still announced and looked at', async () => {
  let deep: Json = { type: 'string' };
  for (let i = 0; i < 20000; i++) deep = { type: 'object', properties: { a: deep } };
  let rows: Json = { type: 'string' };
  for (let i = 0; i < 20000; i++) rows = { type: 'array', items: rows };
  const tools = [
    ...TOOLS.filter((x) => x.name !== 'peek'),
    { name: 'peek', description: 42, inputSchema: { type: 'object', properties: {} }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } },
    { name: 'delve', description: 'Delve.', inputSchema: deep, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } },
    { name: 'burrow', description: 'Burrow.', inputSchema: { type: 'object', properties: { rows } }, _meta: { 'mcpl/presence': 'dynamic', 'mcpl/visible': false } },
  ];
  const { hub, told, read } = tappedController(() => true, tools);
  read({ kind: 'hints', params: { rev: 1, tools: [{ name: 'peek', visible: true }, { name: 'delve', visible: true }, { name: 'burrow', visible: true }] } });
  const text = told.join('\n');
  assert.match(text, /peek\(\)/);
  assert.match(text, /delve\(a\?: .*\) — Delve\./);
  assert.match(text, /burrow\(rows\?: .*\) — Burrow\./);
  const looked = await new ToolsetsModule(hub).handleToolCall({ id: 'l1', name: 'look', input: { server: 'arc', tool: 'delve' } } as never);
  assert.ok(!looked.isError, String(looked.error));
});

test('look at a toolset whose options a server nests very deep still answers', async () => {
  let deep: Json = { type: 'string' };
  for (let i = 0; i < 20000; i++) deep = { type: 'object', properties: { a: deep } };
  const { hub, c } = tappedController();
  c.manifestChanged({ toolHints: true, toolsets: { maze: { title: 'Maze', options: deep } } });
  const looked = await new ToolsetsModule(hub).handleToolCall({ id: 'l2', name: 'look', input: { server: 'arc', toolset: 'maze' } } as never);
  assert.ok(!looked.isError, String(looked.error));
});
