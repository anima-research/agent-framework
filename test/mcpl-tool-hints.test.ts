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
    await new Promise((r) => setTimeout(r, 50));
  }
  const methods = () => server.received.map((m) => m.method).filter((m) => typeof m === 'string');
  return {
    fw, server, state, methods,
    async done() { await fw.stop(); await server.close(); },
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
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
    assert.doesNotMatch(await look(t.fw), /peek\(/, 'the refused push\'s change applied');
    await waitFor(() => windowText(t.fw.framework).some((x) => x.includes('tool changes') && x.includes('now unavailable: peek')), 'its change told as a notice');
    // The next change has the next rev and applies without any recovery.
    const lists = t.methods().filter((m) => m === 'tools/list').length;
    t.server.peer.notify('tools/hints', t.state.hint([{ name: 'peek', visible: true }]));
    await settle(400);
    assert.match(await look(t.fw), /peek\(\)/);
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
    await settle();
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
    assert.equal(t.server.received.filter((m) => m.method === 'tools/call').length, 1, 'only the call made while open was sent');
  } finally { await t.done(); }
});

test('vector 13: an ended record is told once, however often the host reconnects', async () => {
  const t = await setup(() => false, { reconnect: true, reconnectIntervalMs: 50 });
  try {
    t.state.ended = [{ id: 'e7', toolset: 'game', instance: 'g9', reason: 'idle for 30 minutes' }];
    for (let i = 0; i < 2; i++) {
      const lists = t.methods().filter((m) => m === 'toolsets/list').length;
      t.server.peer.ws.terminate();
      await waitFor(() => t.methods().filter((m) => m === 'toolsets/list').length > lists, `toolsets/list after reconnect ${i + 1}`);
      await settle(150);
    }
    const told = windowText(t.fw.framework).filter((x) => x.includes('[arc/game:g9] ended: idle for 30 minutes'));
    assert.equal(told.length, 1, 'told once');
  } finally { await t.done(); }
});

test('vectors 21, 22: a definition changes only its instance\'s description, schema and annotations', async () => {
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
    await settle();
    const names = t.fw.framework.getAllTools().map((x) => x.name);
    assert.ok(!names.includes('arc--play') && !names.includes('arc--renamed'), 'still out of the tool list (presence unchanged)');
    const all = await look(t.fw);
    assert.match(all, /\[arc\/game:a\][^\n]*\n\s+play\(point: "A1"\)/, 'a has its own definition, under its own name');
    assert.match(all, /\[arc\/game:b\][^\n]*\n\s+play\(point: string\)/, 'b keeps the declared one');
    assert.doesNotMatch(all, /\[arc\/build\]/, 'no other toolset');
    const onA = await callTool(t.fw.framework, 'toolsets--act', { tool: 'play', instance: 'a', args: { point: 'B2' } });
    assert.ok(onA.isError, 'checked against a\'s definition');
    const onB = await callTool(t.fw.framework, 'toolsets--act', { tool: 'play', instance: 'b', args: { point: 'B2' } });
    assert.ok(!onB.isError, resultText(onB));
    const sent = t.server.received.filter((m) => m.method === 'tools/call');
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0]!.params as Json)._meta, { 'mcpl/instance': 'b' });
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
    await t.fw.framework.executeToolCall({ id: 'refresh', name: 'arc--status', input: {} } as never);
    const closed = await callTool(t.fw.framework, 'toolsets--close', { server: 'arc' });
    assert.match(resultText(closed), /packed up\n\[arc\/build\] closed\. Now unavailable: place\./);
    await look(t.fw); // a toolsets/list, rev after the close's
    await settle(400);
    assert.equal(lists(), before, 'every rev was the next one: no recovery');
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
    await waitFor(() => t.fw.membrane.calls.length > n, 'a request');
    await settle(150);
    return JSON.stringify(t.fw.membrane.calls[t.fw.membrane.calls.length - 1]!.messages);
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
    await settle(100);
    assert.ok(!windowText(fw.framework).some((t) => t.includes('tool changes')), 'told once, in the result');
  } finally {
    await fw.stop();
    await server.close();
    await observer.close();
  }
});

test('a hint change in the result of a call whose result the agent doesn\'t see is told as a notice', async () => {
  const t = await setup((msg, peer, state) => {
    if (msg.method !== 'tools/call') return false;
    peer.reply(msg.id, { content: [{ type: 'text', text: 'reacted' }], _meta: { 'mcpl/hints': state.hint([{ name: 'peek', visible: true }]) } });
    return true;
  });
  try {
    // As the framework's own calls (a reaction, a send) are made: straight on the connection.
    const connection = (t.fw.framework as unknown as { mcplServerRegistry: { getServer(id: string): { sendToolsCall(n: string, a: object): Promise<unknown> } } })
      .mcplServerRegistry.getServer('arc');
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
