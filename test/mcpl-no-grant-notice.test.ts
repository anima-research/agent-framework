import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { McplRequestError, McplServerConnection } from '../src/index.js';
import { foreignRowAsSent } from '../src/foreign-rounds.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import {
  startScriptedServer, makeFramework, waitFor, windowText, callTool,
  type Json, type ScriptedPeer,
} from './helpers/toolset-servers.js';

const POLICY_WAIT_MS = 300;
const TOOLS: Json[] = [{ name: 'status', description: 'Status of the radio.', inputSchema: { type: 'object', properties: {} } }];
const NOTICE_KIND = 'mcpl-no-grant';
const advert = (): Json => ({ featureSets: { 'radio.events': { description: 'Rings of the bell.', uses: ['pushEvents'] } } });

const notice = (method: string, cause: string, tail: string) =>
  `[no-grant] The MCPL server "radio" sent ${method}, and the host refused it. The server holds no grant for such messages, because ${cause}. ` +
  `So for now its pushes and channel messages don't reach you. ${tail ? `${tail} ` : ''}If you can't change that yourself, ask whoever runs this host. The host says this one time. It says it again only after it connects the server anew, or after the server got a grant and lost it.`;
const POSSIBLE_OLD_SERVER = 'One possible cause: a server from before MCPL 0.5 does not take that request. Such a server needs an update to MCPL 0.5.';
const OLD_SERVER = 'The server declares an MCPL version before 0.5. Such a server does not take that request, and it needs an update to MCPL 0.5.';
const ENDED = '[no-grant] The MCPL server "radio" now holds a grant. The host accepts the messages that its grant covers.';
const CAUSE = {
  unanswered: "it did not answer the host's policy request",
  errored: "it answered the host's policy request with an error",
  refused: 'it refused the policy that the host offered',
  noMcpl: 'it declared no MCPL in its handshake, so the host offered it no policy',
  hostError: "the host hit an error while it set up the server's policy",
};
const REFUSED_TAIL = "The host's log has the server's reason, if it gave one.";

type Policy = (msg: Json, peer: ScriptedPeer) => void;
type Fw = Awaited<ReturnType<typeof makeFramework>>;

const unanswered: Policy = () => {};
const accepts: Policy = (msg, peer) => peer.reply(msg.id, { accepted: true });
const answersWithError: Policy = (msg, peer) => peer.error(msg.id, -32601, 'Method not found');
const refuses: Policy = (msg, peer) => peer.reply(msg.id, { accepted: false, fallback: 'mcp-only', reason: 'SERVER-REASON-7' });

const ring = (eventId: string, text: string): Json => ({
  featureSet: 'radio.events', eventId, timestamp: new Date().toISOString(), payload: { content: [{ type: 'text', text }] },
});

function shortPolicyWait(t: TestContext): void {
  const proto = McplServerConnection.prototype;
  const original = proto.sendFeatureSetsUpdateRequest;
  proto.sendFeatureSetsUpdateRequest = function (params) {
    return original.call(this, params, POLICY_WAIT_MS);
  };
  t.after(() => { proto.sendFeatureSetsUpdateRequest = original; });
}

function stderrLines(t: TestContext): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    original(...args);
  };
  t.after(() => { console.error = original; });
  return lines;
}

async function radio(t: TestContext, policy: Policy, advertised: Json | null = advert()) {
  const server = await startScriptedServer({
    advert: advertised,
    tools: TOOLS,
    onPolicy: policy,
    on: (msg, peer) => {
      if (msg.method === 'tools/call') peer.reply(msg.id, { content: [{ type: 'text', text: 'on air' }] });
      else if (msg.method === 'mcpl/manifest') peer.reply(msg.id, { version: '0.5', pushEvents: true, ...advertised });
      else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  t.after(() => server.close());
  return server;
}

function host(t: TestContext, url: string, config: Partial<McplServerConfig> = {}): Promise<Fw> {
  const starting = makeFramework([{ id: 'radio', toolPrefix: 'radio', url, ...config }], { modules: [] });
  t.after(async () => { await (await starting).stop(); });
  return starting;
}

async function setup(t: TestContext, policy: Policy, config: Partial<McplServerConfig> = {}, advertised: Json | null = advert()) {
  if (policy === unanswered) shortPolicyWait(t);
  const server = await radio(t, policy, advertised);
  const fw = await host(t, server.url, config);
  return { server, fw };
}

function noticeRows(fw: Fw) {
  return fw.framework.getAgent('scout')!.getContextManager().getAllMessages()
    .filter((m) => m.metadata?.kind === NOTICE_KIND);
}

function ended(fw: Fw): string[] {
  return fw.framework.getAgent('scout')!.getContextManager().getAllMessages()
    .filter((m) => m.metadata?.kind === 'mcpl-no-grant-ended')
    .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
}

function notices(fw: Fw): string[] {
  return noticeRows(fw).map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
}

function connectionOf(fw: Fw): McplServerConnection {
  const registry: unknown = Reflect.get(fw.framework, 'mcplServerRegistry');
  const connection: unknown = registry !== null && typeof registry === 'object' ? Reflect.get(registry, 'getServer')?.call(registry, 'radio') : undefined;
  assert.ok(connection instanceof McplServerConnection);
  return connection;
}

const handshakes = (server: { received: Json[] }) => server.received.filter((m) => m.method === 'notifications/initialized').length;

async function roundTrip(fw: Fw): Promise<void> {
  const result = await callTool(fw.framework, 'radio--status', {});
  assert.notEqual(result.isError, true, `the server's tool answers: ${JSON.stringify(result)}`);
}

test('case 1: a server that never answers the policy Request: its first refused push writes one notice in the host\'s words, which starts no turn and is in the next turn\'s request', async (t) => {
  const { server, fw } = await setup(t, unanswered);
  server.peer.notify('push/event', ring('r1', 'RING-ONE'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.unanswered, ''));
  assert.equal(Reflect.get(noticeRows(fw)[0]!.metadata ?? {}, 'serverId'), 'radio');
  await roundTrip(fw);
  assert.ok(!windowText(fw.framework).some((x) => x.includes('RING-ONE')), 'nothing the push carried is in the context');
  assert.equal(fw.membrane.calls.length, 0, 'no turn started');
  assert.equal(fw.framework.nudgeAgent('scout', 'test').ok, true);
  await waitFor(() => fw.membrane.calls.length > 0, 'the agent\'s next turn');
  assert.ok(JSON.stringify(fw.membrane.calls[0]).includes('sent push/event, and the host refused it'), 'the next turn\'s request holds the notice');
});

test('case 2: one notice for each spell without a grant: 100 more refused pushes, and a transport that drops and comes back with no grant, write no second notice', async (t) => {
  const { server, fw } = await setup(t, unanswered, { reconnect: true, reconnectIntervalMs: 50 });
  const first = server.peer;
  first.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the first notice');
  for (let i = 0; i < 100; i++) first.notify('push/event', ring(`more-${i}`, 'more'));
  await roundTrip(fw);
  assert.equal(notices(fw).length, 1, 'no notice for the 100 more');
  assert.equal(connectionOf(fw).noGrantEnd, 'unanswered', 'the 100 more were refused with the end still recorded');
  first.ws.terminate();
  await waitFor(() => handshakes(server) === 2, 'the host reconnects and finishes its handshake');
  const answer = await server.peer.request('push/event', ring('after', 'after the reconnect'));
  assert.ok(answer.error, 'refused on the next transport too');
  assert.equal(connectionOf(fw).noGrantEnd, 'unanswered', 'the next transport recorded its own end');
  assert.equal(notices(fw).length, 1, 'no notice for the next transport of the same connect');
});

test('case 3: a restart is a new connect: its first refused message writes a second notice', async (t) => {
  const { server, fw } = await setup(t, unanswered);
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the first notice');
  await fw.framework.restartMcplServer('radio');
  assert.equal(server.peers.length, 2, 'the restart connected again');
  const answer = await server.peer.request('push/event', ring('r2', 'after the restart'));
  assert.ok(answer.error, 'refused after the restart');
  await waitFor(() => notices(fw).length === 2, 'a second notice');
});

test('case 4: a push sent as a request gets the error answer of today, and the resident gets the one notice', async (t) => {
  const { server, fw } = await setup(t, unanswered);
  const answer = await server.peer.request('push/event', ring('r1', 'RING'));
  const error = answer.error as Json | undefined;
  assert.equal(error?.code, -32002);
  assert.equal(error?.message, 'push-event rejected: capability "pushEvents" initial policy not yet established (§5.3)');
  await waitFor(() => notices(fw).length === 1, 'the notice');
});

test('case 5: a server that refuses the initial policy: the notice has the words for a refusal, and nothing of its reason', async (t) => {
  const { server, fw } = await setup(t, refuses);
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.refused, REFUSED_TAIL));
  assert.ok(!windowText(fw.framework).some((x) => x.includes('SERVER-REASON-7')), 'the server\'s reason is not in the context');
});

test('case 6: a policy established without pushEvents: a refused push writes no notice', async (t) => {
  const { server, fw } = await setup(t, accepts, {}, { pushEvents: false });
  const answer = await server.peer.request('push/event', ring('r1', 'one'));
  const error = answer.error as Json | undefined;
  assert.equal(error?.code, -32002, 'refused at the gate');
  assert.equal(error?.message, 'push-event rejected: capability "pushEvents" not in the effective grant');
  await roundTrip(fw);
  assert.equal(notices(fw).length, 0);
});

test('a push held while a policy exchange runs, which then ends with no grant, is refused at the flush and writes the notice', async (t) => {
  const server = await radio(t, (msg, peer) => {
    peer.notify('push/event', ring('held', 'HELD-RING'));
    peer.error(msg.id, -32601, 'Method not found');
  });
  const fw = await host(t, server.url);
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.errored, ''));
  assert.ok(!windowText(fw.framework).some((x) => x.includes('HELD-RING')), 'nothing the push carried is in the context');
});

test('case 7: a push sent while the policy exchange is under way at the first connect is held and delivered, with no notice', async (t) => {
  let release: (() => void) | undefined;
  const server = await radio(t, (msg, peer) => { release = () => peer.reply(msg.id, { accepted: true }); });
  const starting = host(t, server.url);
  await waitFor(() => release !== undefined, 'the policy Request');
  server.peer.notify('push/event', ring('held', 'HELD-RING'));
  release!();
  const fw = await starting;
  await waitFor(() => windowText(fw.framework).some((x) => x.includes('HELD-RING')), 'the held push delivered');
  assert.equal(notices(fw).length, 0);
});

test('case 7: a push sent while the policy exchange is under way after a reconnect is held and delivered, with no notice', async (t) => {
  let release: (() => void) | undefined;
  let policies = 0;
  const server = await radio(t, (msg, peer) => {
    policies++;
    if (policies === 1) peer.reply(msg.id, { accepted: true });
    else release = () => peer.reply(msg.id, { accepted: true });
  });
  const fw = await host(t, server.url, { reconnect: true, reconnectIntervalMs: 50 });
  server.peer.ws.terminate();
  await waitFor(() => release !== undefined, 'the next transport\'s policy Request');
  server.peer.notify('push/event', ring('held', 'HELD-AFTER-RECONNECT'));
  release!();
  await waitFor(() => windowText(fw.framework).some((x) => x.includes('HELD-AFTER-RECONNECT')), 'the held push delivered');
  assert.equal(notices(fw).length, 0);
});

test('case 8: a server with no grant that only offers tools: its tools answer, and no notice is written', async (t) => {
  const { fw } = await setup(t, unanswered);
  await roundTrip(fw);
  assert.equal(notices(fw).length, 0);
});

test('case 9: a refused channels/register writes the notice, naming that method, and a later refused push writes no second one', async (t) => {
  const { server, fw } = await setup(t, unanswered);
  const answer = await server.peer.request('channels/register', {
    channels: [{ id: 'chat:radio', type: 'chat', label: 'radio', direction: 'bidirectional' }],
  });
  assert.ok(answer.error, 'refused for lack of a grant');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('channels/register', CAUSE.unanswered, ''));
  server.peer.notify('push/event', ring('r1', 'one'));
  await roundTrip(fw);
  assert.equal(notices(fw).length, 1);
});

test('case 10: a host with no agent writes no notice, and logs no failure for the refused messages', async (t) => {
  shortPolicyWait(t);
  const lines = stderrLines(t);
  const server = await radio(t, unanswered);
  const starting = makeFramework([{ id: 'radio', toolPrefix: 'radio', url: server.url }], { agents: [], modules: [] });
  t.after(async () => { await (await starting).stop(); });
  const fw = await starting;
  const refusals: unknown[] = [];
  connectionOf(fw).on('no-grant-refusal', (refusal: unknown) => refusals.push(refusal));
  for (const id of ['r1', 'r2']) {
    const answer = await server.peer.request('push/event', ring(id, 'one'));
    assert.ok(answer.error, 'refused for lack of a grant');
  }
  assert.deepEqual(refusals, [{ method: 'push/event', end: 'unanswered' }, { method: 'push/event', end: 'unanswered' }], 'each refusal raised the event');
  assert.deepEqual(lines.filter((line) => line.includes('holds no grant')), []);
});

test('case 11: a server that answers the policy Request with an error: the notice has the words for an error answer', async (t) => {
  const { server, fw } = await setup(t, answersWithError);
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.errored, ''));
});

test('a server that declares an MCPL version from before 0.5, and never answers the policy Request: the notice says so as a fact', async (t) => {
  const { server, fw } = await setup(t, unanswered, {}, { version: '0.4', ...advert() });
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.unanswered, OLD_SERVER));
});

test('a server that declares a version that is no string, and never answers the policy Request: the notice keeps its words for a possible cause', async (t) => {
  const { server, fw } = await setup(t, unanswered, {}, { version: 4, ...advert() });
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.unanswered, POSSIBLE_OLD_SERVER));
});

test('a server that declares MCPL 0.5 or later, and answers the policy Request with an error: the notice says nothing of an old server', async (t) => {
  const { server, fw } = await setup(t, answersWithError, {}, { version: '0.5.0-draft', ...advert() });
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.errored, ''));
});

async function refusedAfterManifestChange(t: TestContext, refusal: Json, logged: string): Promise<void> {
  const lines = stderrLines(t);
  let policies = 0;
  const { server, fw } = await setup(t, (msg, peer) => {
    policies++;
    if (policies === 1) peer.reply(msg.id, { accepted: true });
    else peer.reply(msg.id, { accepted: false, fallback: 'mcp-only', ...refusal });
  });
  const granted = await server.peer.request('push/event', ring('r1', 'GRANTED-RING'));
  assert.equal(granted.error, undefined, 'a push is admitted under the first policy');
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => policies === 2, 'the policy Request after the manifest change');
  await roundTrip(fw);
  const answer = await server.peer.request('push/event', ring('r2', 'one'));
  assert.ok(answer.error, 'refused under the empty grant');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.refused, REFUSED_TAIL));
  assert.ok(lines.some((line) => line.includes(logged)), `the host's log has "${logged}"`);
}

test('case 12: a server that refuses the policy after a manifest change: the notice has the words for a refusal, and the host\'s log has its reason', (t) =>
  refusedAfterManifestChange(t, { reason: 'SERVER-REASON-8' }, 'refused post-manifest policy (SERVER-REASON-8)'));

test('case 12, with no reason: the host\'s log says that the server gave none', (t) =>
  refusedAfterManifestChange(t, {}, 'refused post-manifest policy (no reason)'));

test('case 12, with a line break in the reason: the host\'s log keeps the reason in one field of one line', (t) =>
  refusedAfterManifestChange(t, { reason: 'line one\n[mcpl] forged' }, 'refused post-manifest policy ("line\\u0020one\\n[mcpl]\\u0020forged")'));

test('case 15: a server that gets a grant at a later exchange is no longer told that it holds none', async (t) => {
  let policies = 0;
  const { server, fw } = await setup(t, (msg, peer) => {
    policies++;
    if (policies === 1) peer.error(msg.id, -32601, 'Method not found');
    else peer.reply(msg.id, { accepted: true });
  });
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => policies === 2, 'the policy Request after the manifest change');
  await roundTrip(fw);
  const granted = await server.peer.request('push/event', ring('r1', 'GRANTED-RING'));
  assert.equal(granted.error, undefined, 'a push is admitted under the later grant');
  const refused = await server.peer.request('inference/request', { messages: [] });
  const error = refused.error as Json | undefined;
  assert.equal(error?.code, -32002, 'refused at the gate');
  assert.equal(error?.message, 'inference-request rejected: capability "inferenceRequest" not in the effective grant');
  assert.equal(notices(fw).length, 0);
  assert.deepEqual(ended(fw), [], 'a server that was never told of a spell gets no row when its grant comes');
});

test('case 16: a server that got a grant and lost it again is told again, on the same connection', async (t) => {
  let policies = 0;
  const { server, fw } = await setup(t, (msg, peer) => {
    policies++;
    if (policies === 2) peer.reply(msg.id, { accepted: true });
    else peer.error(msg.id, -32601, 'Method not found');
  }, { reconnect: true, reconnectIntervalMs: 50 });
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the first notice');
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => policies === 2, 'the policy Request after the manifest change');
  await roundTrip(fw);
  const granted = await server.peer.request('push/event', ring('r2', 'GRANTED-RING'));
  assert.equal(granted.error, undefined, 'a push is admitted under the grant');
  assert.deepEqual(ended(fw), [ENDED], 'the agent is told that the server now holds a grant');
  server.peer.ws.terminate();
  await waitFor(() => handshakes(server) === 2, 'the host reconnects and finishes its handshake');
  const answer = await server.peer.request('push/event', ring('r3', 'after the reconnect'));
  assert.ok(answer.error, 'refused, since the reconnect\'s policy Request got an error');
  await waitFor(() => notices(fw).length === 2, 'a second notice, for the second spell');
  assert.equal(notices(fw)[1], notice('push/event', CAUSE.errored, ''));
  assert.equal(ended(fw).length, 1);
});

test('a granted server whose manifest drops pushEvents, and whose policy Request after it gets an error: its next push is refused and writes the notice, without the words for an old server', async (t) => {
  let policies = 0;
  let manifest: Json = { version: '0.5', pushEvents: true, ...advert() };
  const server = await startScriptedServer({
    advert: advert(),
    tools: TOOLS,
    onPolicy: (msg, peer) => {
      policies++;
      if (policies === 1) peer.reply(msg.id, { accepted: true });
      else peer.error(msg.id, -32603, 'Internal error');
    },
    on: (msg, peer) => {
      if (msg.method === 'mcpl/manifest') peer.reply(msg.id, manifest);
      else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  t.after(() => server.close());
  const fw = await host(t, server.url);
  const admitted = await server.peer.request('push/event', ring('r1', 'GRANTED-RING'));
  assert.equal(admitted.error, undefined, 'a push is admitted under the first grant');
  manifest = { version: '0.5', ...advert() };
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => policies === 2, 'the policy Request after the manifest change');
  await waitFor(() => connectionOf(fw).noGrantEnd === 'errored', 'the end of the failed exchange');
  const answer = await server.peer.request('push/event', ring('r2', 'two'));
  assert.ok(answer.error, 'refused, since the grant left in force lacks pushEvents');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.errored, ''));
});

test('a server that was told of and then accepts a grant that admits none of the gated messages: no row says that the server now holds a grant', async (t) => {
  let policies = 0;
  let manifest: Json = { version: '0.5', pushEvents: true, ...advert() };
  const server = await startScriptedServer({
    advert: advert(),
    tools: TOOLS,
    onPolicy: (msg, peer) => {
      policies++;
      if (policies === 1) peer.error(msg.id, -32601, 'Method not found');
      else peer.reply(msg.id, { accepted: true });
    },
    on: (msg, peer) => {
      if (msg.method === 'tools/call') peer.reply(msg.id, { content: [{ type: 'text', text: 'on air' }] });
      else if (msg.method === 'mcpl/manifest') peer.reply(msg.id, manifest);
      else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  t.after(() => server.close());
  const fw = await host(t, server.url);
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  manifest = { version: '0.5', ...advert() };
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => policies === 2, 'the policy Request after the manifest change');
  await roundTrip(fw);
  const answer = await server.peer.request('push/event', ring('r2', 'two'));
  assert.ok(answer.error, 'still refused, since the grant lacks pushEvents');
  assert.deepEqual(ended(fw), []);
  assert.equal(connectionOf(fw).noGrantTold, true, 'the agent is still counted as told');
});

test('a server in a spell without a grant, whose policy Request after a manifest change gets an error: the end is the new one, and no second notice comes', async (t) => {
  let policies = 0;
  const { server, fw } = await setup(t, (msg, peer) => {
    policies++;
    if (policies === 1) refuses(msg, peer);
    else peer.error(msg.id, -32603, 'Internal error');
  });
  server.peer.notify('push/event', ring('r1', 'one'));
  await waitFor(() => notices(fw).length === 1, 'the notice');
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => policies === 2, 'the policy Request after the manifest change');
  await waitFor(() => connectionOf(fw).noGrantEnd === 'errored', 'the end of the newer exchange');
  const answer = await server.peer.request('push/event', ring('r2', 'two'));
  assert.ok(answer.error, 'still refused');
  assert.equal(notices(fw).length, 1);
});

test('a policy Request that the host could not send: the notice has the words for the host\'s error, not the server\'s silence', async (t) => {
  const proto = McplServerConnection.prototype;
  const original = proto.sendFeatureSetsUpdateRequest;
  proto.sendFeatureSetsUpdateRequest = async () => {
    throw new McplRequestError('The request wasn\'t sent: this host couldn\'t write it to the "radio" server, so nothing ran. Try again later.', 'not-sent');
  };
  t.after(() => { proto.sendFeatureSetsUpdateRequest = original; });
  const { server, fw } = await setup(t, accepts);
  const answer = await server.peer.request('push/event', ring('r1', 'one'));
  assert.ok(answer.error, 'refused, since nothing is granted');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.hostError, "The host's log has the error. A restart of the server may clear it."));
});

test('case 13: a server that declares no MCPL and sends push/event: the notice has the words for no MCPL', async (t) => {
  const { server, fw } = await setup(t, unanswered, {}, null);
  const answer = await server.peer.request('push/event', ring('r1', 'one'));
  assert.ok(answer.error, 'refused, since nothing is granted');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.noMcpl, 'A server that sends MCPL messages must declare MCPL.'));
});

test('case 14: a reconnect whose policy step throws on the host leaves the connection live: the notice has the words for the host\'s error', async (t) => {
  const advertised = advert();
  const { server, fw } = await setup(t, accepts, { reconnect: true, reconnectIntervalMs: 50 }, advertised);
  advertised.featureSets = [null];
  server.peer.ws.terminate();
  await waitFor(() => handshakes(server) === 2, 'the host reconnects and finishes its handshake');
  const answer = await server.peer.request('push/event', ring('r1', 'one'));
  assert.ok(answer.error, 'refused, since the policy step left no grant');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.hostError, "The host's log has the error. A restart of the server may clear it."));
});

test('a granted server whose manifest drops pushEvents and holds a feature set that the host fails to read: the host\'s error ends the exchange, and its next push writes the notice', async (t) => {
  let manifest: Json = { version: '0.5', pushEvents: true, ...advert() };
  const server = await startScriptedServer({
    advert: advert(),
    tools: TOOLS,
    onPolicy: accepts,
    on: (msg, peer) => {
      if (msg.method === 'mcpl/manifest') peer.reply(msg.id, manifest);
      else if (msg.id !== undefined) peer.error(msg.id, -32601, 'Method not found');
    },
  });
  t.after(() => server.close());
  const fw = await host(t, server.url);
  const admitted = await server.peer.request('push/event', ring('r1', 'GRANTED-RING'));
  assert.equal(admitted.error, undefined, 'a push is admitted under the first grant');
  manifest = { version: '0.5', featureSets: [null] };
  server.peer.notify('mcpl/manifestChanged', {});
  await waitFor(() => connectionOf(fw).noGrantEnd === 'host-error', 'the end that the host\'s error leaves');
  const answer = await server.peer.request('push/event', ring('r2', 'two'));
  assert.ok(answer.error, 'refused, since the grant left in force lacks pushEvents');
  await waitFor(() => notices(fw).length === 1, 'the notice');
  assert.equal(notices(fw)[0], notice('push/event', CAUSE.hostError, "The host's log has the error. A restart of the server may clear it."));
});

test('a watched call of a tool with a default MCPL name is sent as it was before the notice\'s tag', () => {
  const [line] = foreignRowAsSent([{ type: 'tool_use', id: 'c1', name: 'mcpl--radio--play', input: {} }]);
  assert.ok(line?.type === 'text' && line.text.startsWith('[mcpl--radio--play called: '), JSON.stringify(line));
});
