/**
 * A message's reply goes back through the server whose message it answers.
 * MCPL makes a channel id unique only within one server's connection
 * (§14.2), so another server can register the same id, push naming it, or
 * hold it alone once the first server withdraws it. These tests drive two
 * real servers, `discord` and `slack`, where `slack` registers or names
 * discord's channel id, and check which server the agent's words go out
 * through: in each prose routing mode, through channel_publish, a drafts
 * resend and a script's call, with conversation forks, and for a coalesced
 * retraction. Each test prints what it saw with t.diagnostic.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { ConversationRouter } from '../src/mcpl/conversation-router.js';
import type { ChannelRef } from '../src/index.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { ToolResult } from '../src/types/events.js';
import type { PushEventParams, PushEventResult } from '../src/mcpl/types.js';
import { MockMembrane, HeldStream, createMockResponse } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
// These tests were written to the latest-inbound speech rule: a message
// re-pins the turn, and the latest one is the default channel and the
// fallback locus.
const LEGACY = { locus: 'latest-inbound' } as const;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function postsSettled(framework: AgentFramework, agent: string): Promise<void> {
  const posting = (framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains;
  for (;;) {
    await framework.runUntilIdle();
    const chain = posting.get(agent);
    await chain;
    await framework.runUntilIdle();
    if (posting.get(agent) === chain) return;
  }
}

describe("a push naming another server's channel, through two real servers", () => {
  let dir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  const paths = (id: string) => ({ status: join(dir, `${id}-status.jsonl`), command: join(dir, `${id}-commands.jsonl`) });
  const lines = (path: string): Array<Record<string, unknown>> => jsonLines(path);
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const registry = () => (framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;
  const rows = (id: string) => registry().listChannelsRaw().filter((e) => e.descriptor.id === id)
    .map((e) => ({ serverId: e.serverId, label: e.descriptor.label }));
  const published = (text: string) => ['discord', 'slack'].flatMap((id) =>
    lines(paths(id).status).filter((l) => l.event === 'publish' && String(l.text ?? '').includes(text)).map(() => id));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'push-other-server-'));
    for (const id of ['discord', 'slack']) writeFileSync(paths(id).command, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      speech: LEGACY,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [
        { id: 'discord', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('discord').status, COMMAND_PATH: paths('discord').command } },
        { id: 'slack', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('slack').status, COMMAND_PATH: paths('slack').command,
            CHANNELS: JSON.stringify([{ id: 'slack:T1:C1', label: '#lobby (acme)' }]) } },
      ],
      modules: [],
    });
    await framework.start();
    await waitFor(() => registry().listChannelsRaw().length >= 3, 'both servers registered');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends nothing through the other server, and leaves its channel as it was", async (t) => {
    const before = rows('discord:g1:room');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'cross reply' }]));
    command('slack', { op: 'push', eventId: 'ev-cross', origin: { mcplChannelId: 'discord:g1:room', channelName: '#room (Guild One)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => published('cross reply').length > 0, 'the reply went out');
    await framework.runUntilIdle();
    t.diagnostic(`turns ${membrane.calls.length}; reply published through ${JSON.stringify(published('cross reply'))}; rows ${JSON.stringify(rows('discord:g1:room'))}`);
    assert.deepEqual(published('cross reply'), ['slack'], 'the reply goes out through slack, and nothing through discord');
    assert.deepEqual(rows('discord:g1:room').filter((r) => r.serverId === 'discord'), before, "discord's channel is as it was");
  });

  it("leaves another server's DM as it was, and answers the push through the server that pushed it", async (t) => {
    const DM = 'discord:dm:1548000000000000009';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'dm reply' }]));
    command('discord', { op: 'dm', eventId: 'dm-1', authorId: 'U9', rawChannelId: '1548000000000000009', text: 'a DM with no name', origin: { authorName: '' } });
    await waitFor(() => rows(DM).some((r) => r.serverId === 'discord'), 'the DM placeholder registered');
    await framework.runUntilIdle();
    const before = rows(DM).filter((r) => r.serverId === 'discord');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'pushed dm reply' }]));
    command('slack', { op: 'push', eventId: 'ev-dm', origin: { mcplChannelId: DM, isDM: true, authorName: 'mallory', authorId: 'U1' },
      tags: ['chat:addressed'], text: 'a message pushed by slack' });
    await waitFor(() => published('pushed dm reply').length > 0, 'the reply went out');
    await framework.runUntilIdle();
    t.diagnostic(`rows ${JSON.stringify(rows(DM))}; pushed dm reply through ${JSON.stringify(published('pushed dm reply'))}`);
    assert.deepEqual(published('pushed dm reply'), ['slack'], "slack's push is answered through slack, and nothing through discord");
    assert.deepEqual(rows(DM).filter((r) => r.serverId === 'discord'), before, "discord's DM is as it was");
  });

  it("a coalesced retraction of the pushing server's occurrence is taken though another server registers the id its origin names", async (t) => {
    const NEW = 'discord:g1:new';
    const handler = (framework as unknown as {
      pushHandler: { handlePushEvent(serverId: string, params: PushEventParams, responder: { respond(r: PushEventResult): void; respondError(code: number, message: string): void }): Promise<void> };
    }).pushHandler;
    const send = async (params: Record<string, unknown>) => {
      const out: { result?: PushEventResult; error?: { code: number; message: string } } = {};
      await handler.handlePushEvent('slack', { featureSet: 'chat', timestamp: new Date().toISOString(), ...params } as unknown as PushEventParams, {
        respond: (r) => { out.result = r; },
        respondError: (code, message) => { out.error = { code, message }; },
      });
      return out;
    };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    // slack's occurrence names an id no server registers yet.
    const first = await send({ eventId: 'c-1', origin: { mcplChannelId: NEW }, coalesce: { key: 'message:m1' },
      payload: { content: [{ type: 'text', text: 'a coalesced note from slack' }] } });
    // discord registers the id; slack then retracts its occurrence.
    await registry().handleRegister('discord', { channels: [{ id: NEW, type: 'chat', label: '#new (Guild One)', direction: 'bidirectional' }] });
    const retract = await send({ eventId: 'c-2', origin: { mcplChannelId: NEW }, coalesce: { key: 'message:m1', retract: true },
      payload: { content: [] } });
    await framework.runUntilIdle();
    t.diagnostic(`first: ${JSON.stringify(first)}; retract: ${JSON.stringify(retract)}; rows ${JSON.stringify(rows(NEW))}`);
    assert.equal(first.error, undefined);
    assert.equal(retract.error, undefined, 'the retraction is not refused');
    assert.ok(['retracted', 'consumed'].includes(retract.result?.coalesce?.outcome ?? ''), JSON.stringify(retract));
    assert.deepEqual(rows(NEW).filter((r) => r.serverId === 'discord'), [{ serverId: 'discord', label: '#new (Guild One)' }], "discord's channel is as it was");
  });

  it("still takes a push naming the pushing server's own channel, and answers it there", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'own reply' }]));
    command('slack', { op: 'push', eventId: 'ev-own', origin: { mcplChannelId: 'slack:T1:C1', channelName: '#lobby (acme)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => published('own reply').length > 0, 'the reply published');
    assert.deepEqual(published('own reply'), ['slack']);
  });
});

describe("a turn's replies go out through the server whose message triggered it", () => {
  const X = 'discord:g1:room';
  let dir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  let release!: () => void;
  let started = 0;
  let restoreErrors: () => void = () => {};
  const paths = (id: string) => ({ status: join(dir, `${id}-status.jsonl`), command: join(dir, `${id}-commands.jsonl`) });
  const lines = (path: string): Array<Record<string, unknown>> => jsonLines(path);
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const registry = () => (framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;
  const holders = (id: string) => registry().listChannelsRaw().filter((e) => e.descriptor.id === id).map((e) => e.serverId).sort();
  const published = (text: string) => ['discord', 'slack'].flatMap((id) =>
    lines(paths(id).status).filter((l) => l.event === 'publish' && String(l.text ?? '').includes(text)).map(() => id));
  const registerX = (serverId: string, label: string) =>
    registry().handleRegister(serverId, { channels: [{ id: X, type: 'chat', label, direction: 'bidirectional' }] });
  // A background script's call: no origin and no turn.
  const background = async (input: Record<string, unknown>): Promise<string> => {
    const r = await (framework as unknown as {
      dispatchScriptToolCall(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult>;
    }).dispatchScriptToolCall('scout', 'channel_publish', input);
    return JSON.stringify(r);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reply-server-'));
    for (const id of ['discord', 'slack']) writeFileSync(paths(id).command, '');
    const original = console.error;
    console.error = () => {};
    restoreErrors = () => { console.error = original; };
    started = 0;
    const released = new Promise<void>((resolve) => { release = resolve; });
    membrane = new MockMembrane();
    const responses: Array<ReturnType<typeof createMockResponse>> = [];
    membrane.pushResponse = (r) => { responses.push(r as ReturnType<typeof createMockResponse>); };
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      started++;
      const turn = responses.splice(0);
      return new HeldStream(released, turn.length > 0 ? turn : [createMockResponse([{ type: 'text', text: 'after' }])]);
    };
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      speech: LEGACY,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [
        { id: 'discord', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('discord').status, COMMAND_PATH: paths('discord').command } },
        { id: 'slack', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('slack').status, COMMAND_PATH: paths('slack').command,
            CHANNELS: JSON.stringify([{ id: 'slack:T1:C1', label: '#lobby (acme)' }]) } },
      ],
      modules: [],
    });
    await framework.start();
    await waitFor(() => registry().listChannelsRaw().length >= 3, 'both servers registered');
  });

  afterEach(async () => {
    release();
    await framework.stop();
    restoreErrors();
    rmSync(dir, { recursive: true, force: true });
  });

  async function pushX(from: string, eventId: string): Promise<void> {
    command(from, { op: 'push', eventId, origin: { mcplChannelId: X, channelName: '#room (Guild One)' },
      tags: ['chat:addressed', 'chat:mention'], text: `a message pushed by ${from}` });
    await waitFor(() => started > 0, 'the turn started');
  }
  async function settle(): Promise<void> {
    release();
    await postsSettled(framework, 'scout');
  }

  // A script's call through the host's bridge, as the isolate hands it over:
  // the watching turn, and the turn that started the script.
  const scriptCallIn = async (tool: string, input: Record<string, unknown>, watchTurn: number, startTurnId: number): Promise<string> =>
    JSON.stringify(await (framework as unknown as {
      scriptToolCall(agent: string, tool: string, argsJson: string,
        context: { watch: { turnId: number; endTurn: boolean }; startTurnId: number }): Promise<{ ok: boolean; json: string }>;
    }).scriptToolCall('scout', tool, JSON.stringify(input), { watch: { turnId: watchTurn, endTurn: false }, startTurnId }));
  const turnNow = () => (framework as unknown as { turnRouting: Map<string, { turnId: number; locus?: ChannelRef }> }).turnRouting.get('scout')!;

  for (const own of [false, true]) {
    it(`a channel_open from a script ${own ? 'the turn started moves its locus' : 'an earlier turn started moves none of the turn\'s routing'}, so the reply goes ${own ? 'to the opened channel' : 'where its message came from'}`, { timeout: 60_000 }, async (t) => {
      const traces: Array<{ type: string; tool?: string }> = [];
      framework.onTrace((e) => { traces.push(e as never); });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'reply after the open' }]));
      await pushX('discord', 'ev-open');
      const turn = turnNow().turnId;
      assert.deepEqual((turnNow() as unknown as { wasIn: unknown[] }).wasIn, [{ serverId: 'discord', channelId: X }],
        "the turn's message's channel, its trigger and its locus, is one it has been in");
      // The script's answer comes back through the event queue, so it's read after the turn is released.
      const opening = scriptCallIn('channel_open', { channelId: 'slack:T1:C1' }, turn, own ? turn : turn - 1);
      await waitFor(() => traces.some((e) => e.tool === 'channel_open' && e.type === 'tool:completed'), 'the open completed');
      t.diagnostic(`locus ${JSON.stringify(turnNow().locus)}`);
      release();
      await waitFor(() => published('reply after the open').length > 0, 'the reply went out');
      await settle();
      t.diagnostic(`open: ${(await opening).slice(0, 300)}`);
      t.diagnostic(`through ${JSON.stringify(published('reply after the open'))}`);
      assert.deepEqual(published('reply after the open'), own ? ['slack'] : ['discord']);
    });
  }

  for (const own of [false, true]) {
  it(`a drafts resend from a script ${own ? 'the turn started engages its destination, so a follow-up there re-pins the turn' : 'an earlier turn started engages none of the turn\'s channels, so a follow-up there doesn\'t re-pin it'}`, { timeout: 60_000 }, async (t) => {
    const { held } = (framework as unknown as {
      proseDrafts: { hold(agent: string, segments: Array<{ text: string }>, reason: string): { held: Array<{ id: string }> } };
    }).proseDrafts.hold('scout', [{ text: 'held words' }], 'no-destination');
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'list-1', name: 'channel_list', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'reply after the follow-up' }]));
    await pushX('discord', 'ev-engage');
    const turn = turnNow().turnId;
    const added: string[] = [];
    framework.onTrace((e) => { if (e.type === 'message:added') added.push(e.source); });
    const resending = scriptCallIn('drafts', { action: 'resend', draftIds: [held[0]!.id], destination: 'slack:T1:C1' }, turn, own ? turn : turn - 1);
    await waitFor(() => published('held words').length > 0, 'the resend went out');
    command('slack', { op: 'incoming', channelId: 'slack:T1:C1', messageId: 'follow-up', mode: 'ambient', text: 'a follow-up in the lobby' });
    await waitFor(() => added.includes('mcpl:channel-incoming'), 'the follow-up arrived');
    release();
    await waitFor(() => published('reply after the follow-up').length > 0, 'the reply went out');
    await settle();
    const resent = await resending;
    t.diagnostic(`resend: ${resent.slice(0, 200)}; locus ${JSON.stringify(turnNow().locus)}; through ${JSON.stringify(published('reply after the follow-up'))}`);
    assert.deepEqual(published('reply after the follow-up'), own ? ['slack'] : ['discord']);
  });
  }

  it('a server that registers the channel too, pushes, and withdraws it before the reply gets no reply through the other server', async () => {
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'withdrawn reply' }]));
    await pushX('slack', 'ev-withdraw');
    await registry().handleChanged('slack', { removed: [X] });
    assert.deepEqual(holders(X), ['discord']);
    await settle();
    assert.deepEqual(published('withdrawn reply'), [], 'nothing goes out through discord');
  });

  it("a reply isn't sent through a server that registers the channel only after the triggering server pushed it and left", async () => {
    registry().removeServer('discord');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'left reply' }]));
    await pushX('slack', 'ev-left');
    await registerX('discord', '#room (Guild One)');
    registry().removeServer('slack');
    await settle();
    assert.deepEqual(published('left reply'), []);
  });

  it('the same goes for a message on the channels lane: a server that registers the channel, sends into it and withdraws it gets no reply through the other server', async () => {
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'lane reply' }]));
    command('slack', { op: 'incoming', channelId: X, messageId: 'in-1', mode: 'addressed', text: 'a message slack sent' });
    await waitFor(() => started > 0, 'the turn started');
    await registry().handleChanged('slack', { removed: [X] });
    await settle();
    assert.deepEqual(published('lane reply'), []);
  });

  for (const pusher of ['slack', 'discord'] as const) {
    it(`where both servers register one channel, the reply to ${pusher}'s push goes back through ${pusher}`, async () => {
      await registerX('slack', '#room (slack)');
      assert.deepEqual(holders(X), ['discord', 'slack']);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `${pusher} reply` }]));
      await pushX(pusher, `ev-both-${pusher}`);
      await settle();
      assert.deepEqual(published(`${pusher} reply`), [pusher]);
    });
  }

  it("a background script's channel_publish naming a shared id goes nowhere, and through the server it names", async (t) => {
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'turn reply' }]));
    await pushX('slack', 'ev-bg');
    await settle();
    assert.deepEqual(published('turn reply'), ['slack']);
    const shared = await background({ channelId: X, content: 'background note' });
    const named = await background({ channelId: X, serverId: 'discord', content: 'background note to discord' });
    t.diagnostic(`shared: ${shared}`);
    t.diagnostic(`named: ${named}`);
    assert.deepEqual(published('background note'), ['discord'], 'only the call that names discord reached it');
    assert.deepEqual(published('background note to discord'), ['discord'], 'a serverId it names is the server it goes through');
  });

  it("a script started in one turn and waited on in a later turn from the other server takes the later turn's channel for none of its names", async (t) => {
    await registerX('slack', '#room (slack)');
    const routing = () => (framework as unknown as { turnRouting: Map<string, { turnId: number }> }).turnRouting.get('scout')!;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first reply' }]));
    await pushX('discord', 'ev-turn-1');
    const first = routing().turnId;
    await settle();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'second reply' }]));
    command('slack', { op: 'push', eventId: 'ev-turn-2', origin: { mcplChannelId: X }, tags: ['chat:addressed', 'chat:mention'], text: 'from slack' });
    await waitFor(() => started > 1, 'the second turn started');
    await settle();
    const second = routing().turnId;
    assert.deepEqual([published('first reply'), published('second reply')], [['discord'], ['slack']]);
    // A script's call as a later turn's wait carries it, through the host's
    // bridge as the isolate hands it over: the watching turn's id, with the
    // turn the script was started in.
    const scriptCall = async (startTurnId: number, content: string) => JSON.stringify(await (framework as unknown as {
      scriptToolCall(agent: string, tool: string, argsJson: string,
        context: { watch: { turnId: number; endTurn: boolean }; startTurnId: number }): Promise<{ ok: boolean; json: string }>;
    }).scriptToolCall('scout', 'channel_publish', JSON.stringify({ channelId: X, content }), { watch: { turnId: second, endTurn: false }, startTurnId }));
    const fromFirst = await scriptCall(first, 'from the first turn\'s script');
    const fromSecond = await scriptCall(second, 'from the second turn\'s script');
    t.diagnostic(`first turn's script: ${fromFirst}`);
    t.diagnostic(`second turn's script: ${fromSecond}`);
    assert.deepEqual(published("from the first turn's script"), [], "the second turn's channel isn't the first turn's script's");
    assert.match(fromFirst, /is on more than one server/);
    assert.deepEqual(published("from the second turn's script"), ['slack'], "a script in its own turn takes that turn's channel");
  });

  it("a background script's channel_publish naming no channel goes through the server whose message set that default, or the server it names, and nowhere once that server withdrew the channel", async (t) => {
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'lane reply' }]));
    command('slack', { op: 'incoming', channelId: X, messageId: 'in-1', mode: 'addressed', text: 'a message slack sent' });
    await waitFor(() => started > 0, 'the turn started');
    await settle();
    const whileShared = await background({ content: 'default while shared' });
    const namedDiscord = await background({ serverId: 'discord', content: 'default named discord' });
    await registry().handleChanged('slack', { removed: [X] });
    const gone = await background({ content: 'default after withdrawal' });
    const goneNamed = await background({ serverId: 'slack', content: 'default named slack after withdrawal' });
    for (const [k, v] of Object.entries({ whileShared, namedDiscord, gone, goneNamed })) t.diagnostic(`${k}: ${v}`);
    assert.deepEqual(published('default while shared'), ['slack'], "the default's own server");
    assert.deepEqual(published('default named discord'), ['discord'], 'a serverId with no channelId names the default\'s id on that server');
    assert.deepEqual(published('default after withdrawal'), [], 'nothing through the server left holding the id');
    assert.deepEqual(published('default named slack after withdrawal'), []);
    // Neither refusal offers a way on: the only channel left with the id is
    // another server's, not where the default's message came from.
    assert.equal((JSON.parse(gone) as ToolResult).error, 'The channel this would default to, "slack:discord:g1:room", isn\'t registered now, so nothing was posted.');
    assert.equal((JSON.parse(goneNamed) as ToolResult).error,
      'Server "slack" has no channel "discord:g1:room", the id of the channel this call would default to, so nothing was posted.');
  });

  // Inside a turn, a publish naming no channel goes where the turn's plain
  // speech would (publishInputWithTurnLocus): the turn's locus, here the
  // lobby slack's addressed message woke it in, on slack, and not the
  // default a later message set mid-turn.
  const publishedTo = (text: string) => ['discord', 'slack'].flatMap((id) =>
    lines(paths(id).status).filter((l) => l.event === 'publish' && String(l.text ?? '').includes(text)).map((l) => `${id} ${String(l.channelId)}`));
  for (const withdraws of [true, false]) {
    it(`a channel_publish naming no channel, inside a turn, goes to the turn's locus through its server, not into a default another message set mid-turn${withdraws ? ', and nowhere once that server withdrew the locus' : ''}`, async () => {
      await registerX('slack', '#room (slack)');
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'pub-default', name: 'channel_publish', input: { content: 'in-turn default' } },
      ], 'tool_use'));
      membrane.pushResponse(createMockResponse([]));
      command('slack', { op: 'incoming', channelId: 'slack:T1:C1', messageId: 'in-lobby', mode: 'addressed', text: 'on the lobby' });
      await waitFor(() => started > 0, 'the turn started');
      command('slack', { op: 'incoming', channelId: X, messageId: 'in-ambient', mode: 'ambient', text: 'in passing' });
      await waitFor(() => registry().getDefaultPublishChannel()?.channelId === X, 'the shared channel is the default');
      assert.deepEqual(registry().getDefaultPublishChannel(), { serverId: 'slack', channelId: X });
      if (withdraws) await registry().handleChanged('slack', { removed: ['slack:T1:C1'] });
      await settle();
      assert.deepEqual(publishedTo('in-turn default'), withdraws ? [] : ['slack slack:T1:C1']);
    });
  }

  for (const withdraws of [true, false]) {
    it(`a turn with no trigger speaks into the latest message's channel through that message's server${withdraws ? ', and nowhere once it withdrew the channel' : ''}`, async () => {
      await registerX('slack', '#room (slack)');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'lane reply' }]));
      command('slack', { op: 'incoming', channelId: X, messageId: 'in-1', mode: 'addressed', text: 'a message slack sent' });
      await waitFor(() => started > 0, 'the turn started');
      await settle();
      assert.deepEqual(published('lane reply'), ['slack']);
      if (withdraws) await registry().handleChanged('slack', { removed: [X] });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'nudged reply' }]));
      framework.nudgeAgent('scout', 'a nudge with no channel');
      await waitFor(() => started > 1, 'the nudged turn started');
      await settle();
      assert.deepEqual(published('nudged reply'), withdraws ? [] : ['slack']);
    });
  }

  it("a turn batching both servers' messages in one shared channel replies there through one server at most", async (t) => {
    const pushed: Array<{ type: string; source?: string; messageId?: string }> = [];
    framework.onTrace((e) => { if ((e as { type: string }).type === 'message:added') pushed.push(e as never); });
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first reply' }]));
    command('slack', { op: 'push', eventId: 'ev-first', origin: { mcplChannelId: 'slack:T1:C1', channelName: '#lobby (acme)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'first' });
    await waitFor(() => started > 0, 'the first turn started');
    command('discord', { op: 'push', eventId: 'ev-d', origin: { mcplChannelId: X }, tags: ['chat:addressed', 'chat:mention'], text: 'from discord' });
    command('slack', { op: 'push', eventId: 'ev-s', origin: { mcplChannelId: X }, tags: ['chat:addressed', 'chat:mention'], text: 'from slack' });
    const sent = (id: string, eventId: string) => lines(paths(id).status).some((l) => l.event === 'push-sent' && l.eventId === eventId);
    await waitFor(() => sent('discord', 'ev-d') && sent('slack', 'ev-s'), 'both servers pushed');
    // The host has taken both pushes in, so the first turn's release finds them together.
    await waitFor(() => pushed.filter((e) => e.source === 'mcpl:push-event').length >= 3, 'the host took both pushes in');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'batched reply' }]));
    await settle();
    await waitFor(() => started > 1 && published('batched reply').length > 0, 'the batched turn replied');
    await settle();
    t.diagnostic(`turns ${started}; batched reply through ${JSON.stringify(published('batched reply'))}`);
    assert.deepEqual(published('first reply'), ['slack']);
    assert.equal(started, 2, 'one turn took both pushes');
    assert.equal(published('batched reply').length, 1, 'the batched reply goes through one server');
  });

  it("a channel_publish naming the trigger's shared id goes through the trigger's server; another shared id takes the server the call names, and is refused without one", async (t) => {
    await registerX('slack', '#room (slack)');
    await registry().handleRegister('slack', { channels: [{ id: 'discord:g1:general', type: 'chat', label: '#general (slack)', direction: 'bidirectional' }] });
    await registry().handleRegister('discord', { channels: [{ id: 'discord:g1:only', type: 'chat', label: '#only (Guild One)', direction: 'bidirectional' }] });
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pub-1', name: 'channel_publish', input: { channelId: X, content: 'named reply' } },
      { type: 'tool_use', id: 'pub-2', name: 'channel_publish', input: { channelId: 'discord:g1:general', content: 'other reply' } },
      { type: 'tool_use', id: 'pub-3', name: 'channel_publish', input: { channelId: 'discord:g1:general', serverId: 'slack', content: 'chosen reply' } },
      { type: 'tool_use', id: 'pub-4', name: 'channel_publish', input: { channelId: 'discord:g1:only', serverId: 'slack', content: 'misnamed reply' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'after the tools' }]));
    await pushX('slack', 'ev-tool');
    await settle();
    const results = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((c) => c.type === 'tool_result')
      .map((c) => JSON.stringify(c));
    for (const r of results) t.diagnostic(r.slice(0, 600));
    t.diagnostic(`named ${JSON.stringify(published('named reply'))} other ${JSON.stringify(published('other reply'))} chosen ${JSON.stringify(published('chosen reply'))} misnamed ${JSON.stringify(published('misnamed reply'))}`);
    assert.deepEqual(published('named reply'), ['slack'], "the trigger's id means the trigger's channel");
    assert.deepEqual(published('other reply'), []);
    assert.ok(results.some((r) => r.includes('Channel \\"discord:g1:general\\" is on more than one server')), 'a shared id that is no channel of the turn is refused');
    assert.deepEqual(published('chosen reply'), ['slack'], 'the server the call names');
    assert.deepEqual(published('misnamed reply'), [], 'a named server that does not register the id is held to, not passed over');
  });

  it("a channel_publish naming the trigger's id, once the trigger's server withdrew it, is refused rather than sent through the other server", async (t) => {
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pub-gone', name: 'channel_publish', input: { channelId: X, content: 'gone reply' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    await pushX('slack', 'ev-tool-gone');
    await registry().handleChanged('slack', { removed: [X] });
    await settle();
    const results = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((c) => c.type === 'tool_result').map((c) => JSON.stringify(c));
    for (const r of results) t.diagnostic(r.slice(0, 400));
    assert.deepEqual(published('gone reply'), []);
    assert.ok(results.some((r) => r.includes(
      '\\"discord:g1:room\\" is this turn\'s channel on server \\"slack\\", which no longer registers it, so nothing was posted, '
      + 'and nothing can be until that server registers it again.')), results.join('\n'));
  });
});

describe('in explicit and hybrid mode, a reply goes out through no server but the one whose message it answers', () => {
  const X = 'discord:g1:room';
  let dir: string;
  let framework: AgentFramework | undefined;
  let membrane: MockMembrane;
  let release: () => void = () => {};
  let started = 0;
  let restoreErrors: () => void = () => {};
  const paths = (id: string) => ({ status: join(dir, `${id}-status.jsonl`), command: join(dir, `${id}-commands.jsonl`) });
  const lines = (path: string): Array<Record<string, unknown>> => jsonLines(path);
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const registry = () => (framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;
  const published = (text: string) => ['discord', 'slack'].flatMap((id) =>
    lines(paths(id).status).filter((l) => l.event === 'publish' && String(l.text ?? '').includes(text)).map(() => id));

  async function start(proseRouting: 'explicit' | 'hybrid'): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'reply-mode-'));
    for (const id of ['discord', 'slack']) writeFileSync(paths(id).command, '');
    const original = console.error;
    console.error = () => {};
    restoreErrors = () => { console.error = original; };
    started = 0;
    const released = new Promise<void>((resolve) => { release = resolve; });
    membrane = new MockMembrane();
    const responses: Array<ReturnType<typeof createMockResponse>> = [];
    membrane.pushResponse = (r) => { responses.push(r as ReturnType<typeof createMockResponse>); };
    membrane.streamYielding = (request) => {
      membrane.calls.push(request);
      started++;
      const turn = responses.splice(0);
      return new HeldStream(released, turn.length > 0 ? turn : [createMockResponse([])]);
    };
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      speech: LEGACY,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting }],
      mcplServers: [
        { id: 'discord', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('discord').status, COMMAND_PATH: paths('discord').command } },
        { id: 'slack', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('slack').status, COMMAND_PATH: paths('slack').command,
            CHANNELS: JSON.stringify([{ id: 'slack:T1:C1', label: '#lobby (acme)' }]) } },
      ],
      modules: [],
    });
    await framework.start();
    traces.length = 0;
    framework.onTrace((e) => { traces.push(e as { type: string; tool?: string }); });
    await waitFor(() => registry().listChannelsRaw().length >= 3, 'both servers registered');
    await registry().handleRegister('slack', { channels: [{ id: X, type: 'chat', label: '#room (slack)', direction: 'bidirectional' }] });
  }
  const traces: Array<{ type: string; tool?: string }> = [];
  // Where a reply's words ended: published through a server, held as a
  // draft by a bounce, or refused at their route.
  const ended = (text: string) => (): boolean => published(text).length > 0
    || (framework as unknown as { proseDrafts: { open(agent: string): unknown[] } }).proseDrafts.open('scout').some((d) => JSON.stringify(d).includes(text))
    || traces.some((e) => e.type === 'mcpl:speech-route-failed');
  // A tool call of the turn's answered.
  const answered = (tool: string) => (): boolean => traces.some((e) => e.tool === tool && e.type !== 'tool:started');

  afterEach(async () => {
    release();
    await framework?.stop();
    framework = undefined;
    restoreErrors();
    rmSync(dir, { recursive: true, force: true });
  });

  // slack pushes into X, and one server withdraws X while the turn is held;
  // released, the turn runs until `done` says its words have ended somewhere.
  async function replyAfter(leaves: 'slack' | 'discord', done: () => boolean): Promise<void> {
    command('slack', { op: 'push', eventId: `ev-${leaves}`, origin: { mcplChannelId: X, channelName: '#room (slack)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => started > 0, 'the turn started');
    await registry().handleChanged(leaves, { removed: [X] });
    release();
    await waitFor(done, "the turn's words ended somewhere");
    await framework!.runUntilIdle();
  }

  // The target names the channel of slack's message by its id, which the
  // turn's own channel answers to, or by its server-qualified name.
  for (const target of [X, `slack:${X}`]) {
    for (const leaves of ['slack', 'discord'] as const) {
      const what = leaves === 'slack' ? 'goes nowhere once slack withdrew the channel' : 'goes through slack once discord withdrew it';
      const where = leaves === 'slack' ? [] : ['slack'];

      it(`explicit mode: a >> envelope naming ${target} ${what}`, async (t) => {
        await start('explicit');
        membrane.pushResponse(createMockResponse([{ type: 'text', text: `>>${target} envelope reply` }]));
        await replyAfter(leaves, ended('envelope reply'));
        t.diagnostic(`through ${JSON.stringify(published('envelope reply'))}`);
        assert.deepEqual(published('envelope reply'), where);
      });

      it(`hybrid mode: a >>> envelope naming ${target} ${what}`, async (t) => {
        await start('hybrid');
        membrane.pushResponse(createMockResponse([{ type: 'text', text: `>>>${target} hybrid reply` }]));
        await replyAfter(leaves, ended('hybrid reply'));
        t.diagnostic(`through ${JSON.stringify(published('hybrid reply'))}`);
        assert.deepEqual(published('hybrid reply'), where);
      });

      it(`hybrid mode: unprefixed speech after a target-only >>> envelope naming ${target} ${what}`, async (t) => {
        await start('hybrid');
        membrane.pushResponse(createMockResponse([
          { type: 'text', text: `>>>${target}` },
          { type: 'tool_use', id: 'list-1', name: 'channel_list', input: {} },
        ], 'tool_use'));
        membrane.pushResponse(createMockResponse([{ type: 'text', text: 'sticky reply' }]));
        await replyAfter(leaves, ended('sticky reply'));
        t.diagnostic(`through ${JSON.stringify(published('sticky reply'))}`);
        assert.deepEqual(published('sticky reply'), where);
      });

      it(`explicit mode: a drafts resend into ${target}, inside the turn, ${what}`, async (t) => {
        await start('explicit');
        const { held } = (framework as unknown as {
          proseDrafts: { hold(agent: string, segments: Array<{ text: string }>, reason: string): { held: Array<{ id: string }> } };
        }).proseDrafts.hold('scout', [{ text: 'held words' }], 'no-destination');
        membrane.pushResponse(createMockResponse([
          { type: 'tool_use', id: 'resend-1', name: 'drafts', input: { action: 'resend', draftIds: [held[0]!.id], destination: target } },
        ], 'tool_use'));
        membrane.pushResponse(createMockResponse([]));
        await replyAfter(leaves, answered('drafts'));
        t.diagnostic(`through ${JSON.stringify(published('held words'))}`);
        assert.deepEqual(published('held words'), where);
      });
    }
  }

  it("explicit mode: a >> envelope in a round that also calls a tool, naming the message's channel, goes nowhere once slack withdrew it", async (t) => {
    await start('explicit');
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: `>>${X} in the tool round` },
      { type: 'tool_use', id: 'list-1', name: 'channel_list', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    await replyAfter('slack', ended('in the tool round'));
    t.diagnostic(`through ${JSON.stringify(published('in the tool round'))}`);
    assert.deepEqual(published('in the tool round'), []);
  });

  // A channel_open of another channel moves the turn's trigger there, and in
  // hybrid mode its locus; the channel the turn's message came from stays the
  // turn's, so its id still means that channel.
  it("explicit mode: a >> envelope naming the message's channel, after the turn opened another channel, goes nowhere once slack withdrew it", async (t) => {
    await start('explicit');
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'open-1', name: 'channel_open', input: { channelId: 'slack:T1:C1' } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `>>${X} after the open` }]));
    const traces: Array<{ type: string; tool?: string; error?: string }> = [];
    framework!.onTrace((e) => { traces.push(e as never); });
    await replyAfter('slack', ended('after the open'));
    const opened = traces.find((e) => e.tool === 'channel_open' && e.type !== 'tool:started');
    t.diagnostic(`open ${opened?.type} ${opened?.error ?? ''}; through ${JSON.stringify(published('after the open'))}`);
    assert.equal(opened?.type, 'tool:completed', 'the turn opened its other channel');
    assert.deepEqual(published('after the open'), []);
  });

  it("hybrid mode: a >>> envelope the turn wrote before it opened another channel goes nowhere once slack withdrew the channel after the open", async (t) => {
    await start('hybrid');
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: `>>>${X} written before the open` },
      { type: 'tool_use', id: 'open-1', name: 'channel_open', input: { channelId: 'slack:T1:C1' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    const traces: Array<{ type: string; tool?: string; error?: string }> = [];
    framework!.onTrace((e) => {
      traces.push(e as never);
      const done = e as { type: string; tool?: string };
      if (done.type === 'tool:completed' && done.tool === 'channel_open') void registry().handleChanged('slack', { removed: [X] });
    });
    command('slack', { op: 'push', eventId: 'ev-before', origin: { mcplChannelId: X, channelName: '#room (slack)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => started > 0, 'the turn started');
    release();
    await waitFor(() => !registry().listChannelsRaw().some((e) => e.serverId === 'slack' && e.descriptor.id === X), 'slack withdrew the channel');
    await postsSettled(framework!, 'scout');
    const failed = (traces as Array<{ type: string; serverId?: string; channelId?: string }>).filter((e) => e.type === 'mcpl:speech-route-failed');
    t.diagnostic(`failed ${JSON.stringify(failed)}; through ${JSON.stringify(published('written before the open'))}`);
    assert.deepEqual(published('written before the open'), []);
    assert.deepEqual(failed.map((e) => [e.serverId, e.channelId]), [['slack', X]], "its delivery was for slack's channel, refused there");
  });

  it("hybrid mode: a channel_open naming the message's channel id, once slack withdrew it, is refused, and the turn's speech goes through no other server", async (t) => {
    await start('hybrid');
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'open-x', name: 'channel_open', input: { channelId: X } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'after the reopen' }]));
    const traces: Array<{ type: string; tool?: string; error?: string }> = [];
    framework!.onTrace((e) => { traces.push(e as never); });
    await replyAfter('slack', ended('after the reopen'));
    const opened = traces.find((e) => e.tool === 'channel_open' && e.type !== 'tool:started');
    t.diagnostic(`open ${opened?.type} ${opened?.error ?? ''}; through ${JSON.stringify(published('after the reopen'))}`);
    assert.equal(opened?.type, 'tool:failed');
    assert.equal(opened?.error, `"${X}" is this turn's channel on server "slack", which no longer registers it, so nothing ran, `
      + 'and nothing can run on it until that server registers it again.');
    assert.deepEqual(published('after the reopen'), []);
  });

  it("hybrid mode: a >>> envelope naming the channel a mid-turn message moved the turn to goes nowhere once that message's server withdrew it", async (t) => {
    await start('hybrid');
    // The turn is slack's, on its own lobby. While it's held, an addressed
    // message of slack's on the shared channel arrives, and slack withdraws
    // that channel; the turn's tool round then moves its locus there, and
    // its next round names the channel by its id.
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'list-1', name: 'channel_list', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `>>>${X} re-pinned reply` }]));
    command('slack', { op: 'incoming', channelId: 'slack:T1:C1', messageId: 'in-lobby', mode: 'addressed', text: 'on the lobby' });
    await waitFor(() => started > 0, 'the turn started');
    // The held turn's own routing state, which a later turn's doesn't replace.
    const routing = (framework as unknown as { turnRouting: Map<string, { locus?: unknown; wasIn: unknown[] }> }).turnRouting.get('scout');
    command('slack', { op: 'incoming', channelId: X, messageId: 'in-x', mode: 'addressed', text: 'over here' });
    await waitFor(() => {
      const d = registry().getDefaultPublishChannel();
      return d?.serverId === 'slack' && d.channelId === X;
    }, "slack's message on the shared channel arrived");
    await registry().handleChanged('slack', { removed: [X] });
    release();
    await postsSettled(framework!, 'scout');
    const locus = routing?.locus;
    t.diagnostic(`locus ${JSON.stringify(locus)}; wasIn ${JSON.stringify(routing?.wasIn)}; through ${JSON.stringify(published('re-pinned reply'))}`);
    assert.deepEqual(locus, { serverId: 'slack', channelId: X }, 'the locus moved to slack\'s channel');
    assert.deepEqual(routing?.wasIn, [{ serverId: 'slack', channelId: 'slack:T1:C1' }, { serverId: 'slack', channelId: X }],
      'the turn keeps the channel it opened in and the one it moved to');
    assert.deepEqual(published('re-pinned reply'), []);
  });
});

describe("a script's call, through a real code_execution run", () => {
  const X = 'discord:g1:room';
  let dir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  let restoreErrors: () => void = () => {};
  const paths = (id: string) => ({ status: join(dir, `${id}-status.jsonl`), command: join(dir, `${id}-commands.jsonl`) });
  const lines = (path: string): Array<Record<string, unknown>> => jsonLines(path);
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const registry = () => (framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;
  const published = (text: string) => ['discord', 'slack'].flatMap((id) =>
    lines(paths(id).status).filter((l) => l.event === 'publish' && String(l.text ?? '').includes(text)).map(() => id));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reply-script-'));
    for (const id of ['discord', 'slack']) writeFileSync(paths(id).command, '');
    const original = console.error;
    console.error = () => {};
    restoreErrors = () => { console.error = original; };
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      speech: LEGACY,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [
        { id: 'discord', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('discord').status, COMMAND_PATH: paths('discord').command } },
        { id: 'slack', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('slack').status, COMMAND_PATH: paths('slack').command,
            CHANNELS: JSON.stringify([{ id: 'slack:T1:C1', label: '#lobby (acme)' }]) } },
      ],
      modules: [],
      codeExecution: { enabled: true },
    });
    await framework.start();
    await waitFor(() => registry().listChannelsRaw().length >= 3, 'both servers registered');
    await registry().handleRegister('slack', { channels: [{ id: X, type: 'chat', label: '#room (slack)', direction: 'bidirectional' }] });
  });

  afterEach(async () => {
    await framework.stop();
    restoreErrors();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a script the turn runs takes the turn's channel for the id of the channel its message came from", async (t) => {
    const code = `await tools.channel_publish({ channelId: ${JSON.stringify(X)}, content: 'from the script' }); return 1;`;
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'ce-1', name: 'code_execution', input: { code } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    command('slack', { op: 'push', eventId: 'ev-script', origin: { mcplChannelId: X, channelName: '#room (slack)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    const blocks = () => framework.getAgent('scout')!.getContextManager().getAllMessages().flatMap((m) => m.content);
    await waitFor(() => blocks().some((c) => c.type === 'tool_result' && (c as { toolName?: string }).toolName === 'code_execution'),
      'the script finished', 45_000);
    const result = blocks().find((c) => c.type === 'tool_result' && (c as { toolName?: string }).toolName === 'code_execution');
    t.diagnostic(JSON.stringify(result).slice(0, 600));
    assert.deepEqual(published('from the script'), ['slack']);
  });
});

describe("with conversation routing, each server's channel is its own conversation", () => {
  const X = 'discord:g1:room';
  let dir: string;
  let framework: AgentFramework | undefined;
  let restoreErrors: () => void = () => {};
  const paths = (id: string) => ({ status: join(dir, `${id}-status.jsonl`), command: join(dir, `${id}-commands.jsonl`) });
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const registry = () => (framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;
  const holders = (text: string) => [...(framework as unknown as { agents: Map<string, { name: string; getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }> }).agents.values()]
    .filter((a) => a.name !== 'scout' && a.getContextManager().getAllMessages().some((m) => m.content.some((c) => c.type === 'text' && (c.text ?? '').includes(text))))
    .map((a) => a.name);

  async function registerOpen(): Promise<void> {
    await registry().handleRegister('slack', { channels: [{ id: X, type: 'chat', label: '#room (slack)', direction: 'bidirectional' }] });
    await registry().handleChannelToolCall('channel_open', { serverId: 'slack', channelId: X }, { kind: 'module' });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reply-router-'));
    for (const id of ['discord', 'slack']) writeFileSync(paths(id).command, '');
    const original = console.error;
    console.error = () => {};
    restoreErrors = () => { console.error = original; };
    const membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      speech: LEGACY,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [
        { id: 'discord', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('discord').status, COMMAND_PATH: paths('discord').command } },
        { id: 'slack', command: process.execPath, args: [FIXTURE],
          env: { STATUS_PATH: paths('slack').status, COMMAND_PATH: paths('slack').command,
            CHANNELS: JSON.stringify([{ id: 'slack:T1:C1', label: '#lobby (acme)' }]) } },
      ],
      modules: [],
      conversations: { templateAgent: 'scout', bind: { channel: 'always' } },
    });
    await framework.start();
    await waitFor(() => registry().listChannelsRaw().length >= 3, 'both servers registered');
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    restoreErrors();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a server that registers a bound channel's id too has its message answered in a fork of its own, each fork takes only its own server's gate route from when it is bound, and the trunk takes neither", async () => {
    const take = (agent: string, server: string) =>
      (framework as unknown as { mayTakeGateRoute(a: string, r: ChannelRef): boolean }).mayTakeGateRoute(agent, { serverId: server, channelId: X });
    await registerOpen();
    command('discord', { op: 'incoming', channelId: X, messageId: 'd-1', mode: 'addressed', text: 'from discord' });
    await waitFor(() => holders('from discord').length > 0, "discord's message reached a fork");
    const [discordFork] = holders('from discord');
    assert.equal(take(discordFork!, 'slack'), false, "with only its fork bound, discord's fork doesn't take slack's route on that id");
    command('slack', { op: 'incoming', channelId: X, messageId: 's-1', mode: 'addressed', text: 'from slack' });
    await waitFor(() => holders('from slack').length > 0, "slack's message reached a fork");
    await framework!.runUntilIdle();
    assert.deepEqual(holders('from discord'), [discordFork]);
    assert.ok(!holders('from slack').includes(discordFork!), "slack's message is not in discord's fork");
    assert.equal(holders('from slack').length, 1);
    const [slackFork] = holders('from slack');
    assert.equal(take(discordFork!, 'discord'), true, "discord's fork takes discord's route");
    assert.equal(take(discordFork!, 'slack'), false, "discord's fork doesn't take slack's");
    assert.equal(take(slackFork!, 'slack'), true, "slack's fork takes slack's route");
    assert.equal(take(slackFork!, 'discord'), false, "slack's fork doesn't take discord's");
    assert.equal(take('scout', 'discord'), false, "the trunk doesn't take discord's route");
    assert.equal(take('scout', 'slack'), false, "the trunk doesn't take slack's route");
  });

  it("a host's executeToolCall naming a fork, with no channel and outside the fork's turn, posts in the fork's home through its server, not into the default another server's message set", async () => {
    await registerOpen();
    command('discord', { op: 'incoming', channelId: X, messageId: 'd-1', mode: 'addressed', text: 'from discord' });
    await waitFor(() => holders('from discord').length > 0, "discord's message reached a fork");
    command('slack', { op: 'incoming', channelId: X, messageId: 's-1', mode: 'addressed', text: 'from slack' });
    await waitFor(() => holders('from slack').length > 0, "slack's message reached a fork");
    await framework!.runUntilIdle();
    const [discordFork] = holders('from discord');
    const via = (text: string) => ['discord', 'slack'].filter((id) => jsonLines(paths(id).status)
      .some((l) => l.event === 'publish' && String(l.text ?? '').includes(text)));
    const result = await framework!.executeToolCall({ id: 'h-1', name: 'channel_publish', input: { content: 'zz-home-post' }, callerAgentName: discordFork } as never);
    assert.ok(result.success, result.error);
    await waitFor(() => via('zz-home-post').length > 0, 'the post went out');
    assert.deepEqual(via('zz-home-post'), ['discord']);
  });

  it("each server's next message goes on to its own fork", async () => {
    await registerOpen();
    command('discord', { op: 'incoming', channelId: X, messageId: 'd-1', mode: 'addressed', text: 'discord first' });
    await waitFor(() => holders('discord first').length > 0, "discord's first message reached a fork");
    command('slack', { op: 'incoming', channelId: X, messageId: 's-1', mode: 'addressed', text: 'slack first' });
    await waitFor(() => holders('slack first').length > 0, "slack's first message reached a fork");
    command('discord', { op: 'incoming', channelId: X, messageId: 'd-2', mode: 'addressed', text: 'discord second' });
    command('slack', { op: 'incoming', channelId: X, messageId: 's-2', mode: 'addressed', text: 'slack second' });
    await waitFor(() => holders('discord second').length > 0 && holders('slack second').length > 0, 'both second messages reached a fork');
    await framework!.runUntilIdle();
    assert.deepEqual(holders('discord second'), holders('discord first'));
    assert.deepEqual(holders('slack second'), holders('slack first'));
    assert.notDeepEqual(holders('slack first'), holders('discord first'));
  });
});

describe("the router's bindings, by server and id", () => {
  it("keeps two servers' channels with one id apart", () => {
    const router = new ConversationRouter({ templateAgent: 'scout' });
    router.bind({ serverId: 'discord', channelId: 'c' }, 'fork-d', 1);
    router.bind({ serverId: 'slack', channelId: 'c' }, 'fork-s', 2);
    assert.equal(router.getBinding({ serverId: 'discord', channelId: 'c' })?.agentName, 'fork-d');
    assert.equal(router.getBinding({ serverId: 'slack', channelId: 'c' })?.agentName, 'fork-s');
    router.unbind({ serverId: 'slack', channelId: 'c' });
    assert.equal(router.getBinding({ serverId: 'discord', channelId: 'c' })?.agentName, 'fork-d', "unbinding one server's channel leaves the other's");
    assert.equal(router.getBinding({ serverId: 'slack', channelId: 'c' }), undefined);
  });
});

describe("a name the turn's own channel answers to, in the registry", () => {
  async function registry(): Promise<ChannelRegistry> {
    const r = new ChannelRegistry({ getServer: () => null } as unknown as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {});
    for (const id of ['a', 'b']) {
      await r.handleRegister(id, { channels: [{ id: 'general', type: 'chat', label: '#general', direction: 'bidirectional' }] });
    }
    return r;
  }
  const a = { serverId: 'a', channelId: 'general' };
  const b = { serverId: 'b', channelId: 'general' };

  it("means the turn's channel, on its server, though another server registers the id", async () => {
    const r = await registry();
    assert.ok('error' in r.resolveProseTarget('general', { forSpeech: true }), 'without the turn, the shared id is refused');
    assert.deepEqual(r.resolveProseTarget('general', { forSpeech: true, own: [b] }), { channelId: 'general', serverId: 'b', label: '#general' });
    assert.deepEqual(r.resolveProseTarget('a:general', { forSpeech: true, own: [b] }), { channelId: 'general', serverId: 'a', label: '#general' },
      'a qualified name still picks its own channel');
  });

  it("is refused once that server no longer registers it, with no other channel offered", async () => {
    const r = await registry();
    await r.handleChanged('b', { removed: ['general'] });
    assert.deepEqual(r.resolveProseTarget('general', { forSpeech: true, own: [b] }),
      { error: '"general" is this turn\'s channel on server "b", which no longer registers it, and nothing can be sent there until that server registers it again' });
    assert.deepEqual(r.resolveProseTarget('general', { forSpeech: true }), { channelId: 'general', serverId: 'a', label: '#general' },
      'outside the turn the id is a\'s alone');
  });

  it("means neither where the turn's channels with that id are on two servers", async () => {
    const r = await registry();
    assert.deepEqual(r.resolveProseTarget('general', { forSpeech: true, own: [a, b, a] }),
      { error: '"general" is the id of this turn\'s channels on more than one server', candidates: ['a:general', 'b:general'] });
  });

  it("names each of the turn's channels it means neither of by a name that reaches it, and one its server no longer registers as such", async () => {
    const r = await registry();
    await r.handleChanged('a', { removed: ['general'] });
    // b's general is now the id's only holder, but the turn's rule refuses the bare id, so its qualified name is offered.
    assert.deepEqual(r.resolveProseTarget('general', { forSpeech: true, own: [a, b] }),
      { error: '"general" is the id of this turn\'s channels on more than one server',
        candidates: ['"general" on server "a" (its server no longer registers it)', 'b:general'] });
    assert.deepEqual(r.resolveProseTarget('b:general', { forSpeech: true, own: [a, b] }), { channelId: 'general', serverId: 'b', label: '#general' },
      'the offered name reaches it');
    const published = await r.handleChannelToolCall('channel_publish', { channelId: 'general', content: 'x' }, { kind: 'agent', agentName: 'scout', own: [a, b] } as never);
    assert.equal(published.error, '"general" is the id of this turn\'s channels on more than one server ("general" on server "a" (its server '
      + 'no longer registers it), "b:general"), so nothing was posted. Call again with channelId "b:general".');
  });

  it("names and offers the turn's channels by their qualified names though their id ends in a parenthesis", async () => {
    const r = new ChannelRegistry({ getServer: () => null } as unknown as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {});
    for (const id of ['a', 'b']) {
      await r.handleRegister(id, { channels: [{ id: 'room (old)', type: 'chat', label: '#room', direction: 'bidirectional' }] });
    }
    const own = [{ serverId: 'a', channelId: 'room (old)' }, { serverId: 'b', channelId: 'room (old)' }];
    const published = await r.handleChannelToolCall('channel_publish', { channelId: 'room (old)', content: 'x' }, { kind: 'agent', agentName: 'scout', own } as never);
    assert.equal(published.error, '"room (old)" is the id of this turn\'s channels on more than one server ("a:room (old)", "b:room (old)"), '
      + 'so nothing was posted. Call again with channelId set to one of them.');
  });
});
