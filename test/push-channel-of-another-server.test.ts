/**
 * A push names its channel by id, and a channel's id is the agent's locus on
 * its own. So a push naming a channel another server registers, which the
 * pushing server doesn't, is refused at the push boundary: its reply would go
 * out through the server that registers it. One server's label for an id
 * another server registers isn't written to the durable label log, which is
 * kept by the bare id. A push's backfill takes only the pushing server's own
 * entry.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { PushHandler, type McplPushEvent } from '../src/mcpl/push-handler.js';
import { CHANNEL_NOT_PERMITTED } from '../src/mcpl/errors.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { PushEventParams, PushEventResult } from '../src/mcpl/types.js';
import { MockMembrane, HeldStream, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const LABEL_LOG = 'mcpl/channel-label-history';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function captureErrors(t: { after(fn: () => void): void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
}

describe('the push boundary', () => {
  function harness(refuse: (serverId: string, params: PushEventParams) => { channelId: string; holder: string } | undefined) {
    const pushed: McplPushEvent[] = [];
    const traces: Array<{ type: string; [k: string]: unknown }> = [];
    const handler = new PushHandler(
      { validateInbound() {} } as unknown as FeatureSetManager,
      (e) => { pushed.push(e); },
      (t) => { traces.push(t); },
      undefined,
      undefined,
      undefined,
      refuse,
    );
    const send = async (serverId: string, eventId: string, legacy = false) => {
      const out: { result?: PushEventResult; error?: { code: number; message: string; data?: unknown } } = {};
      await handler.handlePushEvent(serverId, {
        featureSet: 'chat', eventId, timestamp: new Date().toISOString(),
        origin: { mcplChannelId: 'discord:g1:room' },
        payload: { content: [{ type: 'text', text: 'hello' }] },
      } as PushEventParams, {
        respond: (r) => { out.result = r; },
        ...(legacy ? {} : { respondError: (code: number, message: string, data?: unknown) => { out.error = { code, message, data }; } }),
      });
      return out;
    };
    return { pushed, traces, send };
  }

  it('refuses a push naming a channel another server registers, with -32017 and a line naming that server', async (t) => {
    const lines = captureErrors(t);
    const asked: string[] = [];
    const h = harness((serverId) => { asked.push(serverId); return { channelId: 'discord:g1:room', holder: 'discord' }; });
    const out = await h.send('slack', 'e1');
    assert.deepEqual(asked, ['slack']);
    assert.equal(out.error?.code, CHANNEL_NOT_PERMITTED);
    assert.deepEqual(out.error?.data, { channelId: 'discord:g1:room' });
    assert.ok(!JSON.stringify(out.error).includes('discord"') && !out.error!.message.includes('discord'),
      "the answer doesn't name the server that registers it");
    assert.equal(h.pushed.length, 0, 'nothing is queued');
    assert.deepEqual(h.traces, [{
      type: 'mcpl:push-event-rejected', serverId: 'slack', eventId: 'e1', featureSet: 'chat',
      reason: 'channel-of-another-server', channelId: 'discord:g1:room', detail: 'registered by server discord',
    }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[push-event-rejected\] server=slack .*channel=discord:g1:room reason=channel-of-another-server: registered by server discord, not this one$/);
  });

  it("holds back a repeat's line for that channel, and traces every refusal", async (t) => {
    const lines = captureErrors(t);
    const h = harness(() => ({ channelId: 'discord:g1:room', holder: 'discord' }));
    await h.send('slack', 'e1');
    await h.send('slack', 'e2');
    assert.equal(lines.length, 1, 'one line a minute for the channel');
    assert.equal(h.traces.length, 2);
  });

  it("answers a responder with no error path with accepted: false", async (t) => {
    captureErrors(t);
    const h = harness(() => ({ channelId: 'discord:g1:room', holder: 'discord' }));
    const out = await h.send('slack', 'e1', true);
    assert.deepEqual(out.result, { accepted: false, reason: 'Channel not permitted' });
  });

  it("doesn't burn the refused push's eventId, so its retry is taken once the push is no longer refused", async (t) => {
    captureErrors(t);
    let refused = true;
    const h = harness(() => (refused ? { channelId: 'discord:g1:room', holder: 'discord' } : undefined));
    await h.send('slack', 'e1');
    refused = false;
    const retry = await h.send('slack', 'e1');
    assert.equal(retry.result?.accepted, true);
    assert.equal(h.pushed.length, 1);
  });
});

describe('the durable label log, kept by the bare id', () => {
  function memoryStore() {
    const events = new Map<string, unknown[]>();
    const registered = new Set<string>();
    return {
      events,
      store: {
        registerState: (opts: { id: string }) => {
          if (registered.has(opts.id)) throw new Error('State already exists');
          registered.add(opts.id);
          if (!events.has(opts.id)) events.set(opts.id, []);
        },
        getStateJson: (id: string) => events.get(id) ?? null,
        appendToStateJson: (id: string, event: unknown) => {
          if (!events.has(id)) events.set(id, []);
          events.get(id)!.push(event);
        },
      },
    };
  }
  function makeRegistry(store: unknown) {
    return new ChannelRegistry(
      { getServer: () => null } as unknown as McplServerRegistry,
      {} as FeatureSetManager,
      () => {},
      () => {},
      { store: store as never },
    );
  }
  const descriptor = (id: string, label: string) => ({ id, type: 'chat', label, direction: 'bidirectional' as const });
  const labels = (events: Map<string, unknown[]>) =>
    (events.get(LABEL_LOG) ?? []).map((e) => (e as { label: string }).label);

  it("records no label a server registers for an id another server registers", async () => {
    const { store, events } = memoryStore();
    const registry = makeRegistry(store);
    await registry.handleRegister('discord', { channels: [descriptor('discord:g1:room', '#room')] });
    await registry.handleRegister('slack', { channels: [descriptor('discord:g1:room', '#mallory')] });
    assert.deepEqual(labels(events), ['#room']);
    const afterRestart = makeRegistry(store);
    assert.ok('error' in afterRestart.resolveProseTargetDurable('#mallory'), 'after a restart, the other label resolves to nothing');
    assert.deepEqual(afterRestart.resolveProseTargetDurable('#room'), { channelId: 'discord:g1:room', label: '#room' });
  });

  it("records no label a server's channels/changed gives for an id another server registers", async () => {
    const { store, events } = memoryStore();
    const registry = makeRegistry(store);
    await registry.handleRegister('discord', { channels: [descriptor('discord:g1:room', '#room')] });
    await registry.handleRegister('slack', { channels: [descriptor('slack:T1:C1', '#lobby')] });
    await registry.handleChanged('slack', { added: [descriptor('discord:g1:room', '#mallory')] });
    await registry.handleChanged('slack', { updated: [descriptor('discord:g1:room', '#mallory-two')] });
    assert.deepEqual(labels(events), ['#room', '#lobby']);
  });

  it('still records the labels of an id only its own server registers', async () => {
    const { store, events } = memoryStore();
    const registry = makeRegistry(store);
    await registry.handleRegister('slack', { channels: [descriptor('slack:T1:C1', '#lobby')] });
    await registry.handleChanged('slack', { updated: [descriptor('slack:T1:C1', '#lobby-renamed')] });
    assert.deepEqual(labels(events), ['#lobby', '#lobby-renamed']);
  });

  it("keeps the fallback when another server that registers its id leaves, and drops it with the server whose message set it", async () => {
    const registry = makeRegistry(memoryStore().store);
    for (const id of ['discord', 'slack']) {
      await registry.handleRegister(id, { channels: [descriptor('discord:g1:room', '#room')] });
    }
    await registry.handleIncoming('slack', { messages: [{ channelId: 'discord:g1:room', messageId: 'm1', author: { id: 'u', name: 'u' }, content: [{ type: 'text', text: 'hi' }], timestamp: new Date().toISOString() }] } as never);
    assert.equal(registry.fallbackServerFor('discord:g1:room'), 'slack');
    registry.removeServer('discord');
    assert.equal(registry.fallbackServerFor('discord:g1:room'), 'slack', "discord's leaving keeps slack's fallback");
    registry.removeServer('slack');
    assert.equal(registry.fallbackServerFor('discord:g1:room'), undefined);
  });

  it("leaves another server's lazy placeholder as it was when a push backfills, and records nothing", async () => {
    const { store, events } = memoryStore();
    const registry = makeRegistry(store);
    registry.ensureChannelRegistered('discord', 'discord:dm:9');
    registry.ensureChannelRegistered('slack', 'discord:dm:9', 'DM: mallory', { channelType: 'dm', recipientName: 'mallory' });
    const rows = registry.listChannelsRaw().filter((e) => e.descriptor.id === 'discord:dm:9');
    const discord = rows.find((e) => e.serverId === 'discord')!;
    assert.equal(discord.descriptor.label, 'discord:dm:9', "discord's placeholder keeps its label");
    assert.ok(!labels(events).includes('DM: mallory'), 'the log records no label for it');
  });
});

describe("a push naming another server's channel, through two real servers", () => {
  let dir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  const paths = (id: string) => ({ status: join(dir, `${id}-status.jsonl`), command: join(dir, `${id}-commands.jsonl`) });
  const lines = (path: string): Array<Record<string, unknown>> =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const stored = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
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

  it("refuses it: nothing is stored or answered, and the other server's channel is as it was", async (t) => {
    const errors = captureErrors(t);
    const before = rows('discord:g1:room');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'cross reply' }]));
    command('slack', { op: 'push', eventId: 'ev-cross', origin: { mcplChannelId: 'discord:g1:room', channelName: '#room (Guild One)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => errors.some((l) => l.includes('reason=channel-of-another-server')), 'the refusal line');
    await framework.runUntilIdle();
    await new Promise((r) => setTimeout(r, 300));
    await framework.runUntilIdle();
    assert.ok(!stored().some((m) => (m.metadata as { eventId?: string } | undefined)?.eventId === 'ev-cross'), 'no row is stored');
    assert.equal(membrane.calls.length, 0, 'no turn starts');
    assert.deepEqual(published('cross reply'), []);
    assert.deepEqual(rows('discord:g1:room'), before, "discord's channel is as it was, and nothing is registered for slack");
    assert.ok(errors.some((l) => /server=slack .*channel=discord:g1:room reason=channel-of-another-server: registered by server discord/.test(l)));
  });

  it("still takes a push naming the pushing server's own channel, and answers it there", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'own reply' }]));
    command('slack', { op: 'push', eventId: 'ev-own', origin: { mcplChannelId: 'slack:T1:C1', channelName: '#lobby (acme)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => stored().some((m) => (m.metadata as { eventId?: string } | undefined)?.eventId === 'ev-own'), 'ev-own stored');
    await framework.runUntilIdle();
    await waitFor(() => published('own reply').length > 0, 'the reply published');
    assert.deepEqual(published('own reply'), ['slack']);
  });

  it("refuses a push naming another server's DM, which keeps its label, and the label log takes none", async (t) => {
    const errors = captureErrors(t);
    const DM = 'discord:dm:1548000000000000009';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'dm reply' }]));
    command('discord', { op: 'dm', eventId: 'dm-1', authorId: 'U9', rawChannelId: '1548000000000000009', text: 'a DM with no name', origin: { authorName: '' } });
    await waitFor(() => rows(DM).length > 0, 'the DM placeholder registered');
    await framework.runUntilIdle();
    command('slack', { op: 'push', eventId: 'ev-dm', origin: { mcplChannelId: DM, isDM: true, authorName: 'mallory', authorId: 'U1' },
      tags: ['chat:addressed'], text: 'a message pushed by slack' });
    await waitFor(() => errors.some((l) => l.includes(`channel=${DM} reason=channel-of-another-server`)), 'the refusal line');
    await framework.runUntilIdle();
    assert.deepEqual(rows(DM), [{ serverId: 'discord', label: DM }]);
    assert.ok('error' in registry().resolveProseTargetDurable('@mallory'), 'no durable label names the DM after mallory');
  });

  it("takes a push naming a channel the pushing server registers too, though another server also does", async (t) => {
    const errors = captureErrors(t);
    await registry().handleRegister('slack', { channels: [{ id: 'discord:g1:room', type: 'chat', label: '#room (slack)', direction: 'bidirectional' }] });
    command('slack', { op: 'push', eventId: 'ev-both', origin: { mcplChannelId: 'discord:g1:room' },
      tags: ['chat:ambient'], text: 'a message pushed by slack' });
    await waitFor(() => stored().some((m) => (m.metadata as { eventId?: string } | undefined)?.eventId === 'ev-both'), 'ev-both stored');
    assert.ok(!errors.some((l) => l.includes('reason=channel-of-another-server')), 'not refused');
  });

  it("still registers a push's channel for the pushing server when no server registers it", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'new reply' }]));
    command('slack', { op: 'push', eventId: 'ev-new', origin: { mcplChannelId: 'slack:T1:C9', channelName: '#new (acme)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'a message pushed by slack' });
    await waitFor(() => rows('slack:T1:C9').length > 0, 'registered for slack');
    assert.deepEqual(rows('slack:T1:C9'), [{ serverId: 'slack', label: '#new (acme)' }]);
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
  const lines = (path: string): Array<Record<string, unknown>> =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const command = (id: string, c: Record<string, unknown>) => appendFileSync(paths(id).command, JSON.stringify(c) + '\n');
  const registry = () => (framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;
  const holders = (id: string) => registry().listChannelsRaw().filter((e) => e.descriptor.id === id).map((e) => e.serverId).sort();
  const published = (text: string) => ['discord', 'slack'].flatMap((id) =>
    lines(paths(id).status).filter((l) => l.event === 'publish' && String(l.text ?? '').includes(text)).map(() => id));
  const registerX = (serverId: string, label: string) =>
    registry().handleRegister(serverId, { channels: [{ id: X, type: 'chat', label, direction: 'bidirectional' }] });

  // Each turn's stream is held until release(), so the registry can change
  // between the message's admission and its reply.
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
      // A yielding stream takes the turn's remaining responses, a tool round's included.
      const turn = responses.splice(0);
      return new HeldStream(released, turn.length > 0 ? turn : [createMockResponse([{ type: 'text', text: 'after' }])]);
    };
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
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
    for (let i = 0; i < 3; i++) {
      await framework.runUntilIdle();
      await new Promise((r) => setTimeout(r, 300));
    }
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

  it("a background script's channel_publish after the turn takes none of the turn's servers, so a shared id is refused", async () => {
    await registerX('slack', '#room (slack)');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'turn reply' }]));
    await pushX('slack', 'ev-bg');
    await settle();
    assert.deepEqual(published('turn reply'), ['slack']);
    // A background script's call: no script record, so no turn.
    const result = await (framework as unknown as {
      handleScriptToolCall(agent: string, tool: string, input: Record<string, unknown>): Promise<string | { text: string }>;
    }).handleScriptToolCall('scout', 'channel_publish', { channelId: X, content: 'background note' });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(published('background note'), []);
    assert.match(typeof result === 'string' ? result : result.text, /this tool can't choose between them/);
  });

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

  it("a turn batching messages from two servers in one shared channel takes neither server, so its reply there is refused", async () => {
    await registerX('slack', '#room (slack)');
    // The first turn, on slack's own channel, holds the agent while both
    // servers' messages into the shared channel queue behind it.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'first reply' }]));
    command('slack', { op: 'push', eventId: 'ev-first', origin: { mcplChannelId: 'slack:T1:C1', channelName: '#lobby (acme)' },
      tags: ['chat:addressed', 'chat:mention'], text: 'first' });
    await waitFor(() => started > 0, 'the first turn started');
    command('discord', { op: 'push', eventId: 'ev-d', origin: { mcplChannelId: X }, tags: ['chat:addressed', 'chat:mention'], text: 'from discord' });
    command('slack', { op: 'push', eventId: 'ev-s', origin: { mcplChannelId: X }, tags: ['chat:addressed', 'chat:mention'], text: 'from slack' });
    const sent = (id: string, eventId: string) => lines(paths(id).status).some((l) => l.event === 'push-sent' && l.eventId === eventId);
    await waitFor(() => sent('discord', 'ev-d') && sent('slack', 'ev-s'), 'both servers pushed');
    await new Promise((r) => setTimeout(r, 500));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'batched reply' }]));
    await settle();
    assert.deepEqual(published('first reply'), ['slack']);
    assert.equal(started, 2, 'one turn took both queued messages');
    assert.deepEqual(published('batched reply'), [], 'neither server is taken for the shared channel');
  });

  it("a channel_publish naming the trigger's channel goes through the trigger's server; one naming another shared id is refused, saying why", async () => {
    await registerX('slack', '#room (slack)');
    await registry().handleRegister('slack', { channels: [{ id: 'discord:g1:general', type: 'chat', label: '#general (slack)', direction: 'bidirectional' }] });
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pub-1', name: 'channel_publish', input: { channelId: X, content: 'named reply' } },
      { type: 'tool_use', id: 'pub-2', name: 'channel_publish', input: { channelId: 'discord:g1:general', content: 'other reply' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'after the tools' }]));
    await pushX('slack', 'ev-tool');
    await settle();
    assert.deepEqual(published('named reply'), ['slack']);
    assert.deepEqual(published('other reply'), []);
    const results = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((c) => c.type === 'tool_result')
      .map((c) => JSON.stringify(c));
    assert.ok(results.some((r) => r.includes("registered by more than one MCPL server, and this tool can't choose between them, so nothing was published")),
      results.join('\n'));
  });
});

describe('the refusal reaction marks the latest message through the server that sent it', () => {
  type Fake = Record<string, unknown>;
  const react = (AgentFramework.prototype as unknown as { reactToRefusal(this: Fake, agent: string, category: string): Promise<void> }).reactToRefusal;
  function fake(server: string | undefined) {
    const calls: string[] = [];
    return {
      calls,
      self: {
        channelRegistry: {
          buildChannelContext: () => ({ incoming: { channelId: 'discord:g1:room', messageId: 'm1' } }),
          fallbackServerFor: (channelId: string) => (channelId === 'discord:g1:room' ? server : undefined),
        },
        mcplServerRegistry: { getServer: (id: string) => ({ sendToolsCall: async () => { calls.push(id); return {}; } }) },
      } as Fake,
    };
  }

  it('through the server whose message it is, whoever else registers the channel', async (t) => {
    captureErrors(t);
    const f = fake('slack');
    await react.call(f.self, 'agent', 'harmful');
    assert.deepEqual(f.calls, ['slack']);
  });

  it('nowhere when no server is kept for that message', async (t) => {
    captureErrors(t);
    const f = fake(undefined);
    await react.call(f.self, 'agent', 'harmful');
    assert.deepEqual(f.calls, []);
  });
});

describe("streamed output goes to the server the speech resolves with", () => {
  it("takes the named server's entry for a shared id, and none without a server", async () => {
    const got: string[] = [];
    const server = (id: string) => ({
      id,
      grant: new CapabilityGrant(new Set(['channels.streaming']), []),
      sendChannelsOutgoingChunk: () => { got.push(`${id} chunk`); },
      sendChannelsOutgoingComplete: () => { got.push(`${id} complete`); },
    });
    const servers = new Map([['discord', server('discord')], ['slack', server('slack')]]);
    const registry = new ChannelRegistry(
      { getServer: (id: string) => servers.get(id) ?? null } as unknown as McplServerRegistry,
      {} as FeatureSetManager, () => {}, () => {}, {},
    );
    for (const id of ['discord', 'slack']) {
      await registry.handleRegister(id, { channels: [{ id: 'discord:g1:room', type: 'chat', label: '#room', direction: 'bidirectional' }] });
    }
    registry.sendOutgoingChunk('discord:g1:room', 'scout', 'i1', 0, 'hello', 'slack');
    registry.sendOutgoingComplete('discord:g1:room', 'scout', 'i1', 'hello', 'slack');
    registry.sendOutgoingChunk('discord:g1:room', 'scout', 'i2', 0, 'hello');
    assert.deepEqual(got, ['slack chunk', 'slack complete']);
  });
});
