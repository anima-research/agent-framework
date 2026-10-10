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

type Publish = (params: { channelId: string }) => Promise<unknown>;

function registryWith(servers: Record<string, { publish: Publish; grant?: boolean }>, failures: unknown[] = []) {
  const published: Array<{ serverId: string; channelId: string }> = [];
  const mocks = new Map<string, unknown>();
  for (const [id, s] of Object.entries(servers)) {
    mocks.set(id, {
      id,
      grant: new CapabilityGrant(new Set(s.grant === false ? [] : ALL_CAPABILITY_PATHS), []),
      sendChannelsPublish: async (params: { channelId: string }) => {
        published.push({ serverId: id, channelId: params.channelId });
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
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  const seed = (serverId: string, id: string, label: string) =>
    channels.set(`${serverId}:${id}`, { serverId, descriptor: { id, type: 'discord', label }, open: true });
  return { registry, published, seed };
}

const ok: Publish = async () => ({ delivered: true, messageId: 'posted-1' });

describe('ChannelRegistry.publish outcomes', () => {
  it('confirms only delivered:true, naming the destination from the registry', async () => {
    const { registry, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'discord:g1:room', '#room (Guild)');
    const outcome = await registry.publish('agent', 'hello', { channelId: 'discord:g1:room' });
    assert.equal(outcome.status, 'delivered');
    assert.equal(outcome.messageId, 'posted-1');
    assert.deepEqual(outcome.destination, { serverId: 'discord', channelId: 'discord:g1:room', label: '#room (Guild)' });
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
    assert.deepEqual(published, [{ serverId: 'beta', channelId: 'discord:g1:room' }]);
    assert.equal(exact.destination?.label, '#room (Beta)');
  });

  it('fails before dispatch without channels.publish in the grant', async () => {
    const { registry, published, seed } = registryWith({ discord: { publish: ok, grant: false } });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'failed');
    assert.equal(published.length, 0);
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
