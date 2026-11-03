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
import { ChannelRegistry, destinationKey, type PublishOutcome } from '../src/mcpl/channel-registry.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { appendInTwoParts } from './helpers/command-file.js';

type Publish = (params: { channelId: string }) => Promise<unknown>;

function registryWith(
  servers: Record<string, { publish: Publish; grant?: boolean | { without: string[] }; open?: () => Promise<unknown> }>,
  failures: unknown[] = [],
  traces: Array<{ type: string; [key: string]: unknown }> = [],
) {
  const published: Array<{ serverId: string; channelId: string }> = [];
  const opened: Array<{ serverId: string; channelId: string }> = [];
  const mocks = new Map<string, unknown>();
  for (const [id, s] of Object.entries(servers)) {
    mocks.set(id, {
      id,
      grant: new CapabilityGrant(new Set(
        s.grant === false ? [] : ALL_CAPABILITY_PATHS.filter((p) => !(typeof s.grant === 'object' && s.grant.without.includes(p))),
      ), []),
      sendChannelsPublish: async (params: { channelId: string }) => {
        published.push({ serverId: id, channelId: params.channelId });
        return s.publish(params);
      },
      sendChannelsOpen: async (params: { channelId: string }) => {
        opened.push({ serverId: id, channelId: params.channelId });
        return s.open ? s.open() : {};
      },
    });
  }
  const registry = new ChannelRegistry(
    { getServer: (id: string) => mocks.get(id) } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    (event) => { traces.push(event); },
    { onRouteFailure: (info) => { failures.push(info); } },
  );
  const channels = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  const seed = (serverId: string, id: string, label: string, open = true) =>
    channels.set(destinationKey({ serverId, channelId: id }), { serverId, descriptor: { id, type: 'discord', label }, open });
  return { registry, published, opened, seed };
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

  it('opens a closed destination first, and a failed open sends nothing', async () => {
    const opens = registryWith({ discord: { publish: ok } });
    opens.seed('discord', 'c', '#c', false);
    assert.equal((await opens.registry.publish('agent', 'x', { channelId: 'c' })).status, 'delivered');
    assert.deepEqual(opens.opened, [{ serverId: 'discord', channelId: 'c' }]);
    assert.deepEqual(opens.published, [{ serverId: 'discord', channelId: 'c' }]);

    const fails = registryWith({ discord: { publish: ok, open: async () => { throw new Error('no such channel'); } } });
    fails.seed('discord', 'c', '#c', false);
    const outcome = await fails.registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.reason, 'opening the channel for these words didn\'t complete: no such channel');
    assert.deepEqual(fails.opened, [{ serverId: 'discord', channelId: 'c' }]);
    assert.deepEqual(fails.published, [], 'nothing dispatched after a failed open');
  });

  it('prints speech routing\'s open line only for speech routing\'s publishes', async (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const { registry, seed, opened } = registryWith({ discord: { publish: ok } });
    seed('discord', 'c', '#c', false);
    seed('discord', 'd', '#d', false);
    // A draft resend isn't speech routing's: the channel opens, and no
    // [routeSpeech] line is printed for it.
    assert.equal((await registry.publish('agent', 'x', { serverId: 'discord', channelId: 'c' })).status, 'delivered');
    assert.deepEqual(lines.filter((l) => l.startsWith('[routeSpeech]')), []);
    await registry.publish('agent', 'x', { channelId: 'd', routed: true });
    assert.deepEqual(opened, [{ serverId: 'discord', channelId: 'c' }, { serverId: 'discord', channelId: 'd' }]);
    assert.deepEqual(lines.filter((l) => l.startsWith('[routeSpeech]')), [
      '[routeSpeech] agent: locus d was closed — opened by delivery (speech implies engagement)',
    ]);
    // Speech into a channel that's already open opens nothing and says so nowhere.
    seed('discord', 'e', '#e');
    assert.equal((await registry.publish('agent', 'x', { channelId: 'e', routed: true })).status, 'delivered');
    assert.equal(opened.length, 2);
    assert.equal(lines.filter((l) => l.includes('was closed')).length, 1, 'no open line for an open channel');
  });

  it('refuses a send the grant forbids before opening anything', async () => {
    // The grant could open the channel (channels.lifecycle), but not publish into it.
    const { registry, seed, opened, published } = registryWith({ discord: { publish: ok, grant: { without: ['channels.publish'] } } });
    seed('discord', 'c', '#c', false);
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.reason, 'this host isn\'t permitted to post to the "discord" server\'s channels, and trying again ' +
      'won\'t change that; if you need it, ask whoever runs this host');
    assert.deepEqual(opened, [], 'a refused send opens nothing');
    assert.deepEqual(published, []);
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
      assert.match(outcome.reason ?? '', /^the "discord" server said it didn't post the message, along with a message id that isn't valid \(.*\) \(delivery uncertain\)$/);
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
      discord: { publish: async () => { throw new McplRequestError(`MCPL server "discord" returned error for channels/publish: [-32000] ${partial}`, 'error-response', { posted: ['111'] }); } },
    });
    seed('discord', 'c', '#c');
    const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
    assert.equal(outcome.status, 'unknown');
    assert.ok(outcome.reason?.includes(partial), 'the connector\'s account is kept verbatim');
    assert.deepEqual(outcome.detail, { posted: ['111'] });
    assert.equal(outcome.destination?.channelId, 'c');
  });

  for (const id of ['message-' + 'x'.repeat(10_000), { malformed: 'x'.repeat(10_000) }]) {
    it('bounds a contradictory ' + (typeof id === 'string' ? 'string' : 'object') + ' message id in the reason, preserving the receipt', async () => {
      const { registry, seed } = registryWith({ discord: { publish: async () => ({ delivered: false, messageId: id }) } });
      seed('discord', 'c', '#c');
      const outcome = await registry.publish('agent', 'x', { channelId: 'c' });
      assert.equal(outcome.status, 'unknown');
      assert.ok(outcome.reason!.length < 2300, 'the diagnostic is bounded');
      assert.match(outcome.reason!, /\[truncated\]/);
      assert.match(outcome.reason!, /delivery uncertain/);
      assert.equal(outcome.messageId, typeof id === 'string' ? id : undefined, 'diagnostic clipping does not rewrite a connector id');
    });
  }

  it('speech failure forwards bounded connector data to both notice and trace, preserving the original outcome', async () => {
    const data = { posted: ['111'], note: 'x'.repeat(10_000) };
    const failures: unknown[] = [];
    const traces: Array<{ type: string; [key: string]: unknown }> = [];
    const { registry, seed } = registryWith({
      discord: { publish: async () => { throw new McplRequestError('part 2 failed', 'error-response', data); } },
    }, failures, traces);
    seed('discord', 'c', '#c');
    const outcome = await registry.deliverSpeech('agent', 'words', { serverId: 'discord', channelId: 'c' });
    assert.equal(outcome.status, 'unknown');
    assert.deepEqual(outcome.detail, data, 'the outcome still carries the complete structured data');
    const info = failures[0] as { detail?: string };
    assert.ok(info.detail && info.detail.length <= 2000);
    assert.match(info.detail, /"posted":\["111"\]/);
    assert.match(info.detail, /\[truncated\]$/);
    assert.equal(traces.find((e) => e.type === 'mcpl:speech-route-failed')?.detail, info.detail);
  });

  it('unrenderable connector data keeps an unknown speech failure visible rather than throwing', async () => {
    const data: Record<string, unknown> = { posted: ['111'] };
    data.self = data;
    const failures: unknown[] = [];
    const { registry, seed } = registryWith({
      discord: { publish: async () => { throw new McplRequestError('part 2 failed', 'error-response', data); } },
    }, failures);
    seed('discord', 'c', '#c');
    const outcome = await registry.deliverSpeech('agent', 'words', { serverId: 'discord', channelId: 'c' });
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.detail, data, 'the formatter does not change the source value');
    assert.equal((failures[0] as { detail?: string }).detail, '[unserializable connector value]');
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
    assert.equal(shared.reason, 'channel id "discord:g1:room" is on more than one server ("alpha:discord:g1:room", ' +
      '"beta:discord:g1:room"), and the destination named no server');
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
    assert.equal(await registry.routeSpeech('agent', 'x', { serverId: 'discord', channelId: 'c' }), null);
    assert.equal(await registry.routeSpeech('agent', 'x', { serverId: 'other', channelId: 'd' }), null);
    assert.deepEqual(failures.map((f) => f.outcome), ['unknown', 'failed']);
  });
});

describe('channel_publish answers by the receipt rule', () => {
  // Ada-1017's item for #163's rule (agent-framework#163): the tool and the
  // subconscious's speak_in_channel, which shares its path, count only a
  // connector's delivered:true as posted, as plain speech does.
  const publishWith = async (publish: Publish) => {
    const { registry, seed } = registryWith({ discord: { publish } });
    seed('discord', 'c', '#c');
    return registry.handleChannelToolCall('channel_publish', { channelId: 'c', content: 'words' }) as Promise<{
      success: boolean; data?: unknown; error?: string; isError?: boolean;
    }>;
  };

  it('answers delivered:true with success and the connector receipt', async () => {
    const result = await publishWith(ok);
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { delivered: true, messageId: 'posted-1' });
  });

  it('tells a caller that asks its outcome, with the channel a delivered post went to', async () => {
    const { registry, seed } = registryWith({ discord: { publish: ok } });
    seed('discord', 'c', '#c');
    const seen: { outcome?: PublishOutcome } = {};
    const result = await registry.handleChannelToolCall('channel_publish', { channelId: 'c', content: 'words' }, undefined, seen);
    assert.equal(result.success, true);
    assert.equal(seen.outcome?.status, 'delivered');
    // Both halves of the key a publish is noted under (destinationKey).
    assert.equal(seen.outcome?.destination?.serverId, 'discord');
    assert.equal(seen.outcome?.destination?.channelId, 'c');
  });

  for (const [what, receipt] of [['a missing receipt', undefined], ['an empty receipt', {}], ['a malformed delivered field', { delivered: 'yes' }]] as const) {
    it(`answers ${what} as unconfirmed, never as success`, async () => {
      const result = await publishWith(async () => receipt);
      assert.equal(result.success, false);
      assert.equal(result.isError, true);
      assert.equal(result.error, 'Posting to channel "c" wasn\'t confirmed: the "discord" server\'s answer didn\'t say whether it posted ' +
        'the message (delivery uncertain). It may or may not have been posted, so sending it again could post it twice.');
    });
  }

  it('answers delivered:false with no message id as failed: nothing was posted', async () => {
    const result = await publishWith(async () => ({ delivered: false }));
    assert.equal(result.success, false);
    assert.equal(result.error, 'Nothing was posted to channel "c": the "discord" server said it didn\'t post the message.');
  });

  it('answers delivered:false beside a message id as unconfirmed', async () => {
    const result = await publishWith(async () => ({ delivered: false, messageId: 'part-1' }));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /^Posting to channel "c" wasn't confirmed: the "discord" server said it didn't post the message, yet named message part-1 as posted \(delivery uncertain\)\. /);
  });

  it('answers a request refused before it was written as failed, and an error response or a plain throw as unconfirmed', async () => {
    const notSent = await publishWith(async () => { throw new McplRequestError('Cannot send request: connection to "discord" is closed', 'not-sent'); });
    assert.equal(notSent.error, 'Nothing was posted to channel "c": Cannot send request: connection to "discord" is closed.');
    // The connection's messages are sentences, and the answer adds its own ending.
    const sentence = await publishWith(async () => {
      throw new McplRequestError('The request wasn\'t sent: the connection to the "discord" server is closed, so nothing ran. This host is reconnecting to it; try again later.', 'not-sent');
    });
    assert.equal(sentence.error, 'Nothing was posted to channel "c": The request wasn\'t sent: the connection to the "discord" server is closed, ' +
      'so nothing ran. This host is reconnecting to it; try again later.');
    // A server's own words keep their final period, since they're its words.
    const ended = await publishWith(async () => {
      throw new McplRequestError('The "discord" server answered with an error: Part 2 failed.', 'error-response');
    });
    assert.match(ended.error ?? '', /^Posting to channel "c" wasn't confirmed: The "discord" server answered with an error: Part 2 failed\. \(delivery uncertain\)\. /);
    const answered = await publishWith(async () => { throw new McplRequestError('MCPL server "discord" returned error for channels/publish: [-32000] part 2 failed', 'error-response', { posted: ['111'] }); });
    assert.match(answered.error ?? '', /^Posting to channel "c" wasn't confirmed: .*part 2 failed \(delivery uncertain\)\. It may or may not have been posted/);
    // What the connector says was posted reaches the answer, as it does the marker.
    assert.ok(answered.error?.endsWith(' could post it twice. Connector detail: {"posted":["111"]}'), answered.error);
    const thrown = await publishWith(async () => { throw new Error('connector exploded'); });
    assert.match(thrown.error ?? '', /^Posting to channel "c" wasn't confirmed: connector exploded \(delivery uncertain\)\./);
    assert.ok(!thrown.error?.includes('Connector detail'), 'no data, no detail');
    // A long string comes through as itself, bounded.
    const long = await publishWith(async () => { throw new McplRequestError('timed out', 'no-response', 'q'.repeat(3000)); });
    const detail = /Connector detail: (q+)… \[truncated\]$/.exec(long.error ?? '');
    assert.ok(detail && detail[1]!.length < 3000, long.error?.slice(-80));
    // A request that never left posted nothing, whatever data rides on it.
    const refused = await publishWith(async () => { throw new McplRequestError('Cannot send request: connection to "discord" is closed', 'not-sent', { posted: [] }); });
    assert.match(refused.error ?? '', /^Nothing was posted to channel "c": /);
  });

  it('publishForAgent, the subconscious\'s speak_in_channel path, answers by the same rule', async () => {
    const answers: Array<[unknown, RegExp]> = [
      [{ delivered: true, messageId: 'posted-1' }, /^$/],
      [{ delivered: false }, /^Nothing was posted to channel "c": the "discord" server said it didn't post the message\.$/],
      [undefined, /^Posting to channel "c" wasn't confirmed: .*didn't say whether it posted the message.*could post it twice\.$/],
    ];
    for (const [receipt, pattern] of answers) {
      const { registry, seed } = registryWith({ discord: { publish: async () => receipt } });
      seed('discord', 'c', '#c');
      const result = await registry.publishForAgent('c', 'words', 'scout');
      assert.equal(result.success, receipt !== undefined && (receipt as { delivered?: boolean }).delivered === true, JSON.stringify(receipt));
      assert.match(result.error ?? '', pattern, JSON.stringify(receipt));
    }
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
    const traces: Array<{ type: string; detail?: unknown }> = [];
    framework.onTrace((event) => traces.push(event));
    // `inTwoParts` writes the mode's line in two parts, as a poll can read a
    // long line half written: the fixture waits for its newline.
    const turn = async (mode: string, n: number, detail?: unknown, inTwoParts = false) => {
      const line = JSON.stringify({ op: 'publish-mode', mode, detail });
      if (inTwoParts) await appendInTwoParts(commandPath, line, 100);
      else appendFileSync(commandPath, line + '\n');
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
    // About 10 KB, long enough for a poll to read it half written.
    await turn('error', 3, { posted: ['111'], note: 'x'.repeat(10_000) }, true);
    const partial = markers()[2]!;
    assert.match(partial, /was not confirmed/);
    assert.match(partial, /Connector detail:.*"posted":\["111"\]/);
    assert.match(partial, /\[truncated\]$/);
    assert.ok(partial.length < 2500, 'the resident receives a bounded display, not the whole error object');
    const trace = traces.find((event) => event.type === 'mcpl:speech-route-failed' && event.detail !== undefined);
    assert.ok(trace?.detail, 'the same connector account reaches the failure trace');
    const marker = framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => (m.content[0] as { text: string }).text === partial);
    assert.equal((marker?.metadata as { detail?: unknown } | undefined)?.detail, trace?.detail, 'the persisted marker metadata carries the same bounded display');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
