/**
 * ChannelRegistry.publish(): what one channels/publish attempt establishes.
 *
 * Only the connector's `delivered: true` confirms a post. `failed` is reserved
 * for proof that nothing went out (refused before dispatch, or a connector
 * `delivered: false` naming no posted message). Anything after dispatch that
 * is not a valid confirmation is `unknown`: an error response (which may
 * follow a partial multi-part post), a timeout, a lost connection, or a
 * missing/malformed receipt. The attempted destination is always named by
 * the registry, never by the caller's spelling.
 *
 * Every publish names its place inside the channel (MCPL RFC-011): a thread,
 * or the root. It goes only to a channel that declares a publish target, a
 * thread only to one that declares `exact`, and a delivery counts only when
 * its echo names the place asked for.
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type Publish = (params: { channelId: string; threadId?: string | null }) => Promise<unknown>;

function registryWith(servers: Record<string, { publish: Publish; grant?: boolean }>, failures: unknown[] = []) {
  const published: Array<{ serverId: string; channelId: string; threadId?: string | null }> = [];
  const mocks = new Map<string, unknown>();
  for (const [id, s] of Object.entries(servers)) {
    mocks.set(id, {
      id,
      grant: new CapabilityGrant(new Set(s.grant === false ? [] : ALL_CAPABILITY_PATHS), []),
      sendChannelsPublish: async (params: { channelId: string; threadId?: string | null }) => {
        published.push({ serverId: id, channelId: params.channelId, ...('threadId' in params ? { threadId: params.threadId } : {}) });
        return s.publish(params);
      },
      sendChannelsOpen: async () => ({}),
    });
  }
  const registry = new ChannelRegistry(
    { getServer: (id: string) => mocks.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { onRouteFailure: (info) => { failures.push(info); } },
  );
  const channels = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: Record<string, unknown>; open: boolean }>;
  }).channels;
  /** A registered channel; it declares `target` (default root), or nothing for null. */
  const seed = (serverId: string, id: string, label: string, target: 'exact' | 'root' | null = 'root') =>
    channels.set(`${serverId}:${id}`, {
      serverId,
      descriptor: { id, type: 'discord', label, ...(target ? { capabilities: { publish: { target } } } : {}) },
      open: true,
    });
  return { registry, published, seed };
}

/** A conforming delivery: it echoes the place it was asked for. */
const ok: Publish = async (params) => ({ delivered: true, messageId: 'posted-1', threadId: params.threadId });

describe('ChannelRegistry server lookup and route failures', () => {
  it('names the server of an id only one server registered; a shared or unknown id names none', () => {
    const { registry, seed } = registryWith({ alpha: { publish: ok }, beta: { publish: ok } });
    seed('alpha', 'solo', '#solo');
    seed('alpha', 'shared', '#shared');
    seed('beta', 'shared', '#shared');
    assert.equal(registry.getChannelServerId('solo'), 'alpha');
    assert.equal(registry.getChannelServerId('shared'), null, 'never whichever server registered it first');
    assert.equal(registry.getChannelServerId('nowhere'), null);
  });

  it('a failed delivery into a thread reports the thread with its channel', async () => {
    const failures: Array<Record<string, unknown>> = [];
    const { registry, seed } = registryWith(
      { discord: { publish: async () => ({ delivered: false, reason: 'thread t-1 is archived' }) } },
      failures,
    );
    seed('discord', 'forum', '#forum', 'exact');
    await registry.deliverSpeech('agent', 'hello', { serverId: 'discord', channelId: 'forum', threadId: 't-1' });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.channelId, 'forum');
    assert.equal(failures[0]!.threadId, 't-1');
    await registry.deliverSpeech('agent', 'hello', { serverId: 'discord', channelId: 'forum' });
    assert.equal('threadId' in failures[1]!, false, 'a root delivery names no thread');
  });
});

describe('ChannelRegistry.publish outcomes', () => {
  it('confirms only delivered:true, naming the destination from the registry', async () => {
    const { registry, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'discord:g1:room', '#room (Guild)');
    const outcome = await registry.publish('agent', 'hello', { channelId: 'discord:g1:room' });
    assert.equal(outcome.status, 'delivered');
    assert.equal(outcome.messageId, 'posted-1');
    assert.deepEqual(outcome.destination, { serverId: 'discord', channelId: 'discord:g1:room', label: '#room (Guild)', threadId: null });
    assert.equal(typeof outcome.at, 'number');
  });

  it('treats delivered:false with no posted message as failed', async () => {
    const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: false }) } });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'failed');
  });

  for (const [what, messageId] of [['a numeric', 123], ['an empty', ''], ['an object', { id: 'x' }]] as const) {
    it(`treats delivered:false beside ${what} message id as unknown: a contradictory receipt proves nothing`, async () => {
      const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: false, messageId }) } });
      seed('discord', 'c', '#c');
      const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
      assert.equal(outcome.status, 'unknown');
      assert.match(outcome.reason ?? '', /contradictory receipt/);
      assert.equal(outcome.messageId, undefined);
    });
  }

  it('treats delivered:false with a null message id as failed (nothing named)', async () => {
    const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: false, messageId: null }) } });
    seed('discord', 'c', '#c');
    assert.equal((await registry.publish('agent', 'x', { channelId: 'c' })).status, 'failed');
  });

  it('refuses a supplied but empty or non-string selector instead of reading it as omitted', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'c', '#c');
    for (const target of [
      { serverId: '', channelId: 'c' },
      { serverId: null as unknown as string, channelId: 'c' },
      { serverId: 7 as unknown as string, channelId: 'c' },
      { channelId: '' },
      { channelId: undefined as unknown as string },
    ]) {
      const outcome = await registry.publish('agent', 'x', target);
      assert.equal(outcome.status, 'failed', JSON.stringify(target));
      assert.equal(outcome.destination, undefined);
      assert.ok('error' in registry.resolveDestination(target), JSON.stringify(target));
    }
    assert.equal(published.length, 0, 'nothing dispatched to the sole matching server');
    assert.equal((await registry.publish('agent', 'x', { serverId: 'discord', channelId: 'c' })).status, 'delivered', 'the exact selector still works');
  });

  it('treats delivered:false that names a posted message as unknown', async () => {
    const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: false, messageId: 'part-1' }) } });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.messageId, 'part-1');
  });

  for (const [what, receipt] of [['a missing receipt', undefined], ['an empty receipt', {}], ['a malformed delivered field', { delivered: 'yes' }]] as const) {
    it(`treats ${what} as unknown, never as delivered (#163's rule)`, async () => {
      const { registry, seed } = registryWith({ discord: { publish: async () => receipt } });
      seed('discord', 'c', '#c');
      const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
      assert.equal(outcome.status, 'unknown');
      assert.match(outcome.reason ?? '', /delivery uncertain/);
    });
  }

  it('treats an error response as unknown, keeping the connector\'s words and data (a partial post may precede it)', async () => {
    const partial = 'Send partially completed. POSTED: part 1 of 2 (message id 111). IN FLIGHT: part 2 of 2.';
    const { registry, seed } = registryWith({
      discord: { publish: async () => { throw new McplRequestError(`MCPL server "discord" returned error for channels/publish: [-32000] ${partial}`, 'error-response', -32000, { posted: ['111'] }); } },
    });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'unknown');
    assert.ok(outcome.reason?.includes(partial), 'the connector\'s account is kept verbatim');
    assert.deepEqual(outcome.detail, { posted: ['111'] });
    assert.equal(outcome.destination?.channelId, 'c');
  });

  it('treats a timeout or a lost connection as unknown', async () => {
    const { registry, seed } = registryWith({
      discord: { publish: async () => { throw new McplRequestError('MCPL server "discord" did not respond to channels/publish (id=7) within 10ms', 'no-response'); } },
    });
    seed('discord', 'c', '#c');
    assert.equal((await registry.publish('agent', 'x', { channelId: 'c' })).status, 'unknown');
  });

  it('treats a request refused before it was written as failed', async () => {
    const { registry, seed } = registryWith({
      discord: { publish: async () => { throw new McplRequestError('Cannot send request: connection to "discord" is closed', 'not-sent'); } },
    });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /connection to "discord" is closed/);
  });

  it('fails without a destination for an unknown channel', async () => {
    const { registry, published } = registryWith({ discord: { publish: ok } });
    const outcome = await registry.publish('agent', 'x', { channelId: 'nowhere' });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.destination, undefined);
    assert.equal(published.length, 0);
  });

  it('refuses a channel id two servers share unless the server is named, and then uses exactly that server', async () => {
    const { registry, published, seed } = registryWith({ alpha: { publish: ok }, beta: { publish: ok } });
    seed('alpha', 'discord:g1:room', '#room (Alpha)');
    seed('beta', 'discord:g1:room', '#room (Beta)');
    const shared = await registry.publish('agent', 'x', { channelId: 'discord:g1:room' });
    assert.equal(shared.status, 'failed');
    assert.match(shared.reason ?? '', /more than one MCPL server/);
    assert.equal(published.length, 0, 'never routed through whichever server came first');
    const exact = await registry.publish('agent', 'x', { serverId: 'beta', channelId: 'discord:g1:room' });
    assert.equal(exact.status, 'delivered');
    assert.deepEqual(published, [{ serverId: 'beta', channelId: 'discord:g1:room', threadId: null }]);
    assert.equal(exact.destination?.label, '#room (Beta)');
  });

  it('fails before dispatch without channels.publish in the grant', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok, grant: false } });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'failed');
    assert.equal(published.length, 0);
  });

  it('names the root explicitly: a publish without a thread sends threadId null, never omits it', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'c', '#c');
    assert.equal((await registry.publish('agent', 'x', { channelId: 'c' })).status, 'delivered');
    assert.deepEqual(published, [{ serverId: 'discord', channelId: 'c', threadId: null }]);
  });

  it('posts into a thread only where the channel declares exact targeting', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'forum', '#forum', 'exact');
    seed('discord', 'plain', '#plain', 'root');
    const inThread = await registry.publish('agent', 'x', { channelId: 'forum', threadId: 't-1' });
    assert.equal(inThread.status, 'delivered');
    assert.equal(inThread.destination?.threadId, 't-1');
    const onRoot = await registry.publish('agent', 'x', { channelId: 'plain', threadId: 't-1' });
    assert.equal(onRoot.status, 'failed');
    assert.match(onRoot.reason ?? '', /has no threads/);
    assert.deepEqual(published, [{ serverId: 'discord', channelId: 'forum', threadId: 't-1' }], 'the threadless channel saw nothing');
  });

  it('never publishes to a channel that declares no publish target, and opens nothing first', async () => {
    const opened: string[] = [];
    const { registry, published, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'legacy', '#legacy', null);
    const channels = (registry as unknown as { channels: Map<string, { open: boolean }> }).channels;
    channels.get('discord:legacy')!.open = false;
    (registry as unknown as { openChannelNow: (e: unknown) => Promise<void> }).openChannelNow = async () => { opened.push('legacy'); };
    const outcome = await registry.publish('agent', 'x', { channelId: 'legacy' });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /doesn't declare where a post lands/);
    assert.equal(outcome.destination?.channelId, 'legacy');
    assert.deepEqual(published, [], 'the connector would choose the place itself');
    assert.deepEqual(opened, [], 'refused before any side effect');
  });

  it('refuses an invalid thread id before dispatch', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'forum', '#forum', 'exact');
    for (const threadId of ['', 7 as unknown as string, { id: 't' } as unknown as string]) {
      assert.equal((await registry.publish('agent', 'x', { channelId: 'forum', threadId })).status, 'failed', JSON.stringify(threadId));
    }
    assert.equal(published.length, 0);
  });

  for (const [what, echo] of [
    ['no echo at all', {}],
    ['an echo of the root when a thread was asked for', { threadId: null }],
    ['an echo of another thread', { threadId: 't-2' }],
    ['an unreadable echo', { threadId: 42 }],
  ] as const) {
    it(`treats a delivery with ${what} as unknown: something was posted, not provably where asked`, async () => {
      const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: true, messageId: 'p-1', ...echo }) } });
      seed('discord', 'forum', '#forum', 'exact');
      const outcome = await registry.publish('agent', 'x', { channelId: 'forum', threadId: 't-1' });
      assert.equal(outcome.status, 'unknown');
      assert.equal(outcome.messageId, 'p-1');
      assert.match(outcome.reason ?? '', /not thread t-1/);
    });
  }

  it('a root publish needs a root echo', async () => {
    const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: true, messageId: 'p-1', threadId: 'stray' }) } });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'unknown');
    assert.match(outcome.reason ?? '', /reported posting in thread stray, not the channel root/);
  });

  it('keeps a refusal\'s reason: delivered:false with no message is failed, in the connector\'s words', async () => {
    const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: false, reason: 'thread t-1 is archived' }) } });
    seed('discord', 'forum', '#forum', 'exact');
    const outcome = await registry.publish('agent', 'x', { channelId: 'forum', threadId: 't-1' });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.reason ?? '', /thread t-1 is archived/);
  });

  it('a channels/changed that withdraws the declaration applies to the next publish', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'c', '#c', 'root');
    assert.equal((await registry.publish('agent', 'x', { channelId: 'c' })).status, 'delivered');
    seed('discord', 'c', '#c', null);
    assert.equal((await registry.publish('agent', 'x', { channelId: 'c' })).status, 'failed');
    assert.equal(published.length, 1);
  });

  it('streams only to a declared channel, at its root, on the server the publish resolved (RFC-011 §6)', () => {
    const chunks: Array<{ server: string; channelId: string; threadId?: unknown }> = [];
    const completes: Array<{ server: string; channelId: string; threadId?: unknown }> = [];
    const serverFor = (name: string) => ({
      grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
      sendChannelsOutgoingChunk: (p: { channelId: string; threadId?: unknown }) => chunks.push({ server: name, channelId: p.channelId, threadId: p.threadId }),
      sendChannelsOutgoingComplete: (p: { channelId: string; threadId?: unknown }) => completes.push({ server: name, channelId: p.channelId, threadId: p.threadId }),
    });
    const servers: Record<string, ReturnType<typeof serverFor>> = { discord: serverFor('discord'), slack: serverFor('slack') };
    const registry = new ChannelRegistry(
      { getServer: (id: string) => servers[id] } as unknown as McplServerRegistry,
      {} as FeatureSetManager,
      () => {},
      () => {},
      {},
    );
    const channels = (registry as unknown as { channels: Map<string, unknown> }).channels;
    const seedIt = (serverId: string, id: string, target: 'exact' | 'root' | null) => channels.set(`${serverId}:${id}`, {
      serverId,
      descriptor: { id, type: serverId, label: id, ...(target ? { capabilities: { publish: { target } } } : {}) },
      open: true,
    });
    seedIt('discord', 'exact', 'exact');
    seedIt('discord', 'root', 'root');
    seedIt('discord', 'none', null);
    // The same id on two servers: the destination's server decides, never a scan of bare ids.
    seedIt('slack', 'root', 'root');
    for (const [serverId, channelId] of [['discord', 'exact'], ['discord', 'root'], ['discord', 'none'], ['slack', 'root'], ['discord', 'missing']] as const) {
      registry.sendOutgoingChunk({ serverId, channelId }, 'agent', 'inf-1', 0, 'Hello');
      registry.sendOutgoingComplete({ serverId, channelId }, 'agent', 'inf-1', 'Hello');
    }
    const expected = [
      { server: 'discord', channelId: 'exact', threadId: null },
      { server: 'discord', channelId: 'root', threadId: null },
      { server: 'slack', channelId: 'root', threadId: null },
    ];
    assert.deepEqual(chunks, expected, 'never to an undeclared or unregistered channel; always the root');
    assert.deepEqual(completes, expected);
  });

  it('routeSpeech reports a failed and an uncertain delivery as different outcomes', async () => {
    const failures: Array<{ outcome?: string }> = [];
    const { registry, seed } = registryWith({ discord: { publish: async () => ({}) }, other: { publish: async () => ({ delivered: false }) } }, failures);
    seed('discord', 'c', '#c');
    seed('other', 'd', '#d');
    assert.equal(await registry.routeSpeech('agent', 'x', 'c'), null);
    assert.equal(await registry.routeSpeech('agent', 'x', 'd'), null);
    assert.deepEqual(failures.map((f) => f.outcome), ['unknown', 'failed']);
  });
});

test('the resident\'s failure marker never claims an uncertain delivery did not happen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-outcome-'));
  const commandPath = join(dir, 'commands.jsonl');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    mcplServers: [{
      id: 'discord',
      command: process.execPath,
      args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
      env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [],
  });
  try {
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    const until = async (cond: () => boolean, what: string) => {
      const deadline = Date.now() + 15_000;
      while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
    };
    await until(() => registry.listChannelsRaw().length >= 2, 'registration');
    const markers = () => framework.getAgent('scout')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'discord-send-failed')
      .map((m) => (m.content[0] as { text: string }).text);
    const turn = async (mode: string, n: number) => {
      appendFileSync(commandPath, JSON.stringify({ op: 'publish-mode', mode }) + '\n');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply ${n}` }]));
      appendFileSync(commandPath, JSON.stringify({ op: 'incoming', channelId: 'discord:g1:room', messageId: `m-${n}`, mode: 'addressed', text: 'hello?' }) + '\n');
      await until(() => markers().length === n, `marker ${n}`);
      await framework.runUntilIdle();
    };
    await turn('no-receipt', 1);
    await turn('not-delivered', 2);
    const [uncertain, failed] = markers();
    assert.match(uncertain!, /was not confirmed/);
    assert.match(uncertain!, /may or may not have been posted/);
    assert.doesNotMatch(uncertain!, /did not receive|Nothing was posted/);
    assert.match(failed!, /could not be delivered/);
    assert.match(failed!, /Nothing was posted/);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure marker for a thread route names the thread, and says to check it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-outcome-thread-'));
  const commandPath = join(dir, 'commands.jsonl');
  writeFileSync(commandPath, '');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    mcplServers: [{
      id: 'discord',
      command: process.execPath,
      args: [join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs')],
      env: {
        STATUS_PATH: join(dir, 'status.jsonl'),
        COMMAND_PATH: commandPath,
        CHANNELS: JSON.stringify([{ id: 'discord:g1:forum', label: '#forum (Guild One)', publishTarget: 'exact' }]),
      },
    }],
    modules: [],
  });
  try {
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    const until = async (cond: () => boolean, what: string) => {
      const deadline = Date.now() + 15_000;
      while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
    };
    await until(() => registry.listChannelsRaw().length >= 1, 'registration');
    const markers = () => framework.getAgent('scout')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'discord-send-failed');
    appendFileSync(commandPath, JSON.stringify({ op: 'publish-mode', mode: 'no-receipt' }) + '\n');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'reply in the thread' }]));
    appendFileSync(commandPath, JSON.stringify({
      op: 'incoming', channelId: 'discord:g1:forum', threadId: 't1', messageId: 'm-1', mode: 'addressed', text: 'hello?',
    }) + '\n');
    await until(() => markers().length === 1, 'marker');
    await framework.runUntilIdle();
    const [marker] = markers();
    const text = (marker!.content[0] as { text: string }).text;
    assert.match(text, /to thread t1 in #forum \(Guild One\) \(discord:g1:forum\) was not confirmed/);
    assert.match(text, /check the thread before sending it again/);
    assert.equal((marker!.metadata as { threadId?: string }).threadId, 't1');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
