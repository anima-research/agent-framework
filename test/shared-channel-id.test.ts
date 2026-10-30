/**
 * Two MCPL servers that register one channel id. MCPL requires a channel id
 * to be unique only within one server's connection (§14.2), so servers `a`
 * and `b` can each register `general`. Every path that acts on a channel then
 * names it with its server (ChannelRef), and a name given as a string, which
 * two servers' channels answer to, is refused with both as candidates, never
 * taken to be whichever registered first. The cases in the `orders` loops
 * run in both registration orders, since a first-match lookup answers
 * differently in each; the rest, whose answer doesn't turn on which server
 * registered first, run once.
 */

import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, conversationForkSpec } from '../src/index.js';
import type { ChannelRef, InferenceRequest, ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { bindAsConversationFork } from './helpers/dendrite.js';
import { isProseTargetToken } from '../src/mcpl/prose-grammar.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

type Call = { server: string; what: string; channelId?: string; text?: string; metadata?: unknown };

/** Each test's registries, whose typing indicators are stopped after it, so
 *  one that fails mid-way leaves no interval holding the process open. */
const registries: ChannelRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.stopAll();
});

/** A registry whose servers record what each is sent, with the channels
 *  `[serverId, channelId, label]` registered open in the order given. */
function fixture(channels: Array<[serverId: string, channelId: string, label?: string]>) {
  const calls: Call[] = [];
  const failures: Array<{ channelId: string | null; serverId?: string; reason: string }> = [];
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const servers = new Map<string, unknown>();
  const server = (id: string) => ({
    id,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (p: { channelId?: string; content?: Array<{ text: string }> }) => {
      calls.push({ server: id, what: 'publish', channelId: p.channelId, text: p.content?.[0]?.text });
      return { delivered: true, messageId: `${id}-m${calls.length}` };
    },
    sendChannelsOpen: async (p: { channelId?: string }) => { calls.push({ server: id, what: 'open', channelId: p.channelId }); return {}; },
    sendChannelsClose: async (p: { channelId?: string }) => { calls.push({ server: id, what: 'close', channelId: p.channelId }); return {}; },
    sendChannelsOutgoingChunk: (p: { channelId?: string }) => { calls.push({ server: id, what: 'chunk', channelId: p.channelId }); },
    sendChannelsOutgoingComplete: (p: { channelId?: string }) => { calls.push({ server: id, what: 'complete', channelId: p.channelId }); },
  });
  const getServer = (id: string) => servers.get(id) ?? servers.set(id, server(id)).get(id);
  const registry = new ChannelRegistry(
    { getServer } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    (e) => { traces.push(e); },
    {
      // The latest delivered inbound is the fallback locus and the default
      // channel, as on main: these tests were written to that rule.
      latestInboundLocus: true,
      onRouteFailure: (info) => { failures.push(info); },
      sendTypingFn: (serverId, channelId, metadata, op) => {
        calls.push({ server: serverId, what: op === 'stop' ? 'typing-stop' : 'typing', channelId, ...(metadata ? { metadata } : {}) });
      },
    },
  );
  registries.push(registry);
  const map = (registry as unknown as { channels: Map<string, unknown> }).channels;
  for (const [serverId, channelId, label] of channels) {
    map.set(destinationKey({ serverId, channelId }), {
      serverId, descriptor: { id: channelId, type: 'chat', label: label ?? channelId }, open: true,
    });
  }
  const take = () => calls.splice(0);
  return { registry, calls, take, failures, traces };
}

const a: ChannelRef = { serverId: 'a', channelId: 'general' };
const b: ChannelRef = { serverId: 'b', channelId: 'general' };
const orders: Array<Array<'a' | 'b'>> = [['a', 'b'], ['b', 'a']];
const both = (order: Array<'a' | 'b'>) => order.map((s): [string, string, string] => [s, 'general', `#general (${s})`]);

for (const order of orders) {
  const registered = `registered ${order.join(' then ')}`;

  test(`speech to a turn's locus goes to its server, with its stream there (${registered})`, async () => {
    const f = fixture(both(order));
    const routed = await f.registry.routeSpeech('agent', 'reply', b);
    assert.deepEqual(routed, { delivered: true, serverId: 'b', channelId: 'general', messageId: 'b-m1' });
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['b publish']);
    f.registry.sendOutgoingChunk(b, 'agent', 'inf', 0, 'reply');
    f.registry.sendOutgoingComplete(b, 'agent', 'inf', 'reply');
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['b chunk', 'b complete']);
    assert.deepEqual(f.failures, []);
  });

  test(`typing by ref types in that server's channel, and a host's bare id types in each server's (${registered})`, () => {
    const f = fixture(both(order));
    f.registry.startTyping(b);
    f.registry.stopTyping(b);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['b typing', 'b typing-stop']);

    // connectome-host's activity module keeps bare ids: typing posts
    // nothing, so a shared one shows in both rather than in neither.
    f.registry.startTyping('general');
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`).sort(), ['a typing', 'b typing']);
    f.registry.stopTyping('general');
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`).sort(), ['a typing-stop', 'b typing-stop']);
    // A qualified name picks one.
    f.registry.startTyping('a:general');
    f.registry.stopTyping('a:general');
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['a typing', 'a typing-stop']);
  });

  test(`each server's channel with the shared id keeps its own typing metadata (${registered})`, () => {
    const f = fixture(both(order));
    f.registry.startTyping(a, { topic: 'a-topic' });
    f.registry.startTyping(b, { topic: 'b-topic' });
    f.registry.stopTyping(a);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what} ${JSON.stringify(c.metadata)}`), [
      'a typing {"topic":"a-topic"}', 'b typing {"topic":"b-topic"}', 'a typing-stop {"topic":"a-topic"}',
    ]);
    f.registry.stopTyping(b);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what} ${JSON.stringify(c.metadata)}`), ['b typing-stop {"topic":"b-topic"}']);
  });

  test(`removing a server stops its channel's typing and keeps the default's ref, whichever server's it was, and drops the default's message only when the default is that server's (${registered})`, () => {
    const f = fixture(both(order));
    const internal = f.registry as unknown as {
      defaultPublishChannel: ChannelRef | null; defaultPublishMessageId: string | null; defaultPublishThreadId: string | undefined;
      channels: Map<string, unknown>;
    };
    f.registry.startTyping(a);
    f.registry.startTyping(b);
    internal.defaultPublishChannel = b;
    internal.defaultPublishMessageId = 'b-msg';
    internal.defaultPublishThreadId = 'b-thread';
    f.take();
    f.registry.removeServer('a');
    assert.deepEqual(f.registry.getDefaultPublishChannel(), b, "b's channel stays the default");
    assert.deepEqual(f.registry.incomingFor(), { channel: b, messageId: 'b-msg', threadId: 'b-thread' }, "another server's removal keeps b's message");
    f.registry.stopTyping(b);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['b typing-stop'], "b's typing was still running");
    // a's typing stopped with its server: registered again, it starts afresh.
    internal.channels.set(destinationKey(a), { serverId: 'a', descriptor: { id: 'general', type: 'chat', label: '#general' }, open: true });
    f.registry.startTyping(a);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['a typing']);
    f.registry.removeServer('b');
    assert.deepEqual(f.registry.getDefaultPublishChannel(), b, "b's channel stays the default's ref, so a call that would default to it is refused as the default gone");
    assert.equal(f.registry.incomingFor(), undefined, "b's message went with its server, so none is given as the one replied to");
  });

  test(`channel_close stops typing in the channel it closes, and the other server's channel with its id goes on typing (${registered})`, async () => {
    const f = fixture(both(order));
    f.registry.startTyping(a);
    f.registry.startTyping(b);
    f.take();
    await f.registry.handleChannelToolCall('channel_close', { channelId: 'b:general' });
    assert.deepEqual(f.take().filter((c) => c.what.startsWith('typing')).map((c) => `${c.server} ${c.what}`), ['b typing-stop']);
    f.registry.stopTyping(a);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what}`), ['a typing-stop'], "a's typing was still running");
  });

  test(`channel_publish refuses a shared id with its candidates, and takes the server-qualified name (${registered})`, async () => {
    const f = fixture(both(order));
    const refused = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'general', content: 'hi' });
    assert.equal(refused.success, false);
    assert.equal(
      refused.error,
      `Channel "general" is on more than one server (${order.map((s) => `"${s}:general"`).join(', ')}), so nothing was posted. ` +
        'Call again with channelId set to one of them.',
    );
    // connectome-host's notices take "not found" as an absent server and park the notice for good.
    assert.doesNotMatch(refused.error ?? '', /not found/i);
    assert.deepEqual(f.take(), [], 'nothing was published');

    const sent = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'b:general', content: 'hi' });
    assert.equal(sent.success, true);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what} ${c.channelId}`), ['b publish general']);
  });

  test(`publishForAgent refuses a shared id, and takes a qualified name or a ref (${registered})`, async () => {
    const f = fixture(both(order));
    const refused = await f.registry.publishForAgent('general', 'from the subconscious', 'Subconscious');
    assert.equal(refused.success, false);
    assert.match(refused.error ?? '', /^Channel "general" is on more than one server/);
    // A host reads why without the words: a name several channels answer to,
    // which a ref settles, as a qualified name does here.
    assert.equal(refused.reason, 'shared-id');
    // A ref whose server doesn't register that id names no registered channel.
    const nowhere = await f.registry.publishForAgent({ serverId: 'z', channelId: 'general' }, 'x', 'Subconscious');
    assert.equal(nowhere.reason, 'channel-not-registered');
    // A ref names its exact pair, an empty serverId included, as publish's
    // destination does, though one server alone registers the id.
    const solo = fixture([['a', 'solo']]);
    const unnamed = await solo.registry.publishForAgent({ serverId: '', channelId: 'solo' }, 'x', 'Subconscious');
    assert.equal(unnamed.reason, 'channel-not-registered');
    assert.match(unnamed.error ?? '', /^No channel "solo" is on server "", so nothing was posted\. /);
    assert.deepEqual(solo.take(), []);
    assert.deepEqual(f.take(), []);

    assert.equal((await f.registry.publishForAgent('a:general', 'one', 'Subconscious')).success, true);
    assert.equal((await f.registry.publishForAgent(b, 'two', 'Subconscious')).success, true);
    assert.deepEqual(f.take().map((c) => `${c.server} ${c.what} ${c.text}`), ['a publish one', 'b publish two']);
    const routed = f.traces.filter((t) => t.type === 'mcpl:speech-routed').map((t) => `${t.serverId} ${t.channelId}`);
    assert.deepEqual(routed, ['a general', 'b general'], 'each routed trace names its own server and the channel id');
  });

  test(`channel_open and channel_close take the server-qualified name, as they take serverId (${registered})`, async () => {
    const f = fixture(both(order));
    const opened = await f.registry.handleChannelToolCall('channel_open', { channelId: 'b:general' });
    assert.equal(opened.success, true);
    assert.deepEqual(opened.data, { channelId: 'general', serverId: 'b', status: 'opened' },
      "the result names the channel's own id and its server");
    const refused = await f.registry.handleChannelToolCall('channel_close', { channelId: 'general' });
    assert.equal(refused.error, `Channel "general" is on more than one server (${order.map((s) => `"${s}:general"`).join(', ')}), ` +
      `so nothing ran. Call again with channelId set to one of them, or with serverId set to ${order.map((s) => `"${s}"`).join(' or ')}.`);
    for (const tool of ['channel_open', 'channel_decline']) {
      const shared = await f.registry.handleChannelToolCall(tool, { channelId: 'general', messageId: 'm0' });
      assert.equal(shared.error, refused.error, `${tool} refuses the shared id as channel_close does`);
    }
    const closed = await f.registry.handleChannelToolCall('channel_close', { channelId: 'a:general' });
    assert.equal(closed.success, true, closed.error);
    assert.deepEqual(closed.data, { channelId: 'general', serverId: 'a', status: 'closed' });
    const reopened = await f.registry.handleChannelToolCall('channel_open', { channelId: 'general', serverId: 'a' });
    assert.equal(reopened.success, true, reopened.error);
    assert.deepEqual(f.take().filter((c) => c.what === 'open' || c.what === 'close').map((c) => `${c.server} ${c.what} ${c.channelId}`),
      ['b open general', 'a close general', 'a open general'], 'each server is sent its own id');
  });

  test(`channel_decline takes the server-qualified name, and records the decision for that server's channel (${registered})`, async () => {
    const f = fixture(both(order));
    (f.registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey(b))!.open = false;
    const declined = await f.registry.handleChannelToolCall('channel_decline', { channelId: 'b:general', messageId: 'm1' });
    assert.equal(declined.success, true, declined.error);
    assert.deepEqual([(declined.data as { channelId?: string }).channelId, (declined.data as { serverId?: string }).serverId], ['general', 'b'],
      'the result names the channel and its server');
    assert.equal(f.registry.getDesiredState('b', 'general'), 'closed');
    assert.equal(f.registry.getDesiredState('a', 'general'), undefined, "a's channel is another channel");
    // a's general is open, so there's nothing to decline there: the refusal names it apart.
    const open = await f.registry.handleChannelToolCall('channel_decline', { channelId: 'a:general', messageId: 'm2' });
    assert.match(open.error ?? '', /^Channel "a:general" is open, so there's nothing to decline/);
  });

  test(`a >> target names one server's channel by its qualified id, and a shared id or label lists them apart (${registered})`, () => {
    const f = fixture(both(order));
    assert.deepEqual(f.registry.resolveProseTarget('b:general'), { channelId: 'general', serverId: 'b', label: '#general (b)' });
    assert.deepEqual(f.registry.resolveProseTarget('general'), {
      error: 'channel id "general" is ambiguous across servers',
      candidates: order.map((s) => `${s}:general`),
    });
    // A label that picks one channel carries that channel's server.
    assert.deepEqual(f.registry.resolveProseTarget('#general (a)'), { channelId: 'general', serverId: 'a', label: '#general (a)' });
    // Each channel's `>>` token resolves back to it, on its own server.
    for (const ref of [a, b]) {
      const token = f.registry.proseTargetFor(ref)!;
      const back = f.registry.resolveProseTarget(token);
      assert.ok('serverId' in back && back.serverId === ref.serverId && back.channelId === 'general', `${token} names ${ref.serverId}'s channel`);
    }
  });

  test(`a shared label's candidates are named so they can be told apart (${registered})`, () => {
    const f = fixture(order.map((s): [string, string, string] => [s, 'general', '#general']));
    assert.deepEqual(f.registry.resolveProseTarget('#general'), {
      error: 'label "#general" matches several channels',
      candidates: order.map((s) => `${s}:general`),
    });
    assert.equal(f.registry.proseTargetFor(b), 'b:general');
  });

  test(`each lookup by ref reads that server's own entry (${registered})`, () => {
    const f = fixture(both(order));
    (f.registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey(a))!.open = false;
    assert.equal(f.registry.getDescriptor(a)?.label, '#general (a)');
    assert.equal(f.registry.getDescriptor(b)?.label, '#general (b)');
    assert.equal(f.registry.isChannelOpen(a), false);
    assert.equal(f.registry.isChannelOpen(b), true);
    assert.deepEqual(f.registry.channelsNamed('general').map((r) => r.serverId).sort(), ['a', 'b']);
    assert.equal(f.registry.nameShown(b), 'b:general');
  });

  test(`a push's channel on one server is registered for it while another server holds the id (${registered})`, () => {
    const [first, second] = order;
    const f = fixture([[first, 'lazy']]);
    f.registry.ensureChannelRegistered(second, 'lazy', 'Lazy');
    assert.equal(f.registry.getDescriptor({ serverId: second, channelId: 'lazy' })?.label, 'Lazy');
    assert.equal(f.registry.getDescriptor({ serverId: first, channelId: 'lazy' })?.label, 'lazy', "the other server's entry is untouched");
    // One server's push placeholder, labelled by its id, isn't relabelled by
    // another server's push that names the id; its own later push names it.
    const p = fixture([]);
    p.registry.ensureChannelRegistered(first, 'pushed');
    p.registry.ensureChannelRegistered(second, 'pushed', 'Pushed');
    assert.equal(p.registry.getDescriptor({ serverId: first, channelId: 'pushed' })?.label, 'pushed', "the first server's placeholder keeps its label");
    assert.equal(p.registry.getDescriptor({ serverId: second, channelId: 'pushed' })?.label, 'Pushed');
    p.registry.ensureChannelRegistered(first, 'pushed', 'Pushed here');
    assert.equal(p.registry.getDescriptor({ serverId: first, channelId: 'pushed' })?.label, 'Pushed here', 'its own push names it');
  });

  test(`each server is told only of its own channels in beforeInference's channel context (${registered})`, () => {
    const f = fixture([...both(order), ['c', 'elsewhere']]);
    f.registry.handleIncoming('b', {
      messages: [{ channelId: 'general', messageId: 'in1', author: { id: 'u', name: 'U' }, timestamp: '2026-10-19T00:00:00.000Z', content: [{ type: 'text', text: 'hi' }] }],
    });
    // Admission records the delivered message as the latest (noteDelivered).
    f.registry.noteDelivered(b, 'in1');
    assert.deepEqual(f.registry.buildChannelContext('agent', 'b'), {
      incoming: { channelId: 'general', messageId: 'in1', threadId: undefined },
      defaultOutgoing: { channelId: 'general' },
      candidates: ['general'],
    });
    assert.deepEqual(f.registry.buildChannelContext('agent', 'a'), { candidates: ['general'] },
      "a hears of no message on b's general, nor of it as the default");
    assert.deepEqual(f.registry.buildChannelContext('agent', 'c'), { candidates: ['elsewhere'] });
    assert.equal(f.registry.buildChannelContext('agent', 'nobody'), undefined);
  });
}

test("one person's DMs on two servers: a mention or a name lists both, told apart, rather than claiming none matches", async () => {
  const f = fixture([]);
  for (const serverId of ['a', 'b']) {
    await f.registry.handleRegister(serverId, { channels: [{
      id: 'discord:dm:42', type: 'discord', label: 'DM: antra', direction: 'bidirectional',
      metadata: { channelType: 'dm', recipientId: '42', recipientName: 'antra' },
    }] } as never);
  }
  const both = { error: '', candidates: ['a:discord:dm:42', 'b:discord:dm:42'] };
  assert.deepEqual(f.registry.resolveProseTarget('<@42>'), { ...both, error: '"<@42>" matches several DMs' });
  assert.deepEqual(f.registry.resolveProseTarget('@antra'), { ...both, error: '"@antra" matches several DMs' });
  assert.deepEqual(f.registry.resolveProseTarget('b:discord:dm:42'),
    { channelId: 'discord:dm:42', serverId: 'b', label: 'DM: antra' }, 'a candidate names its DM back');
});

test("a name offered for a >> line is one token, and not skip_reply, which the line reads as private speech", () => {
  assert.equal(isProseTargetToken('a:general'), true);
  assert.equal(isProseTargetToken('DM: antra'), false);
  assert.equal(isProseTargetToken(''), false);
  assert.equal(isProseTargetToken('skip_reply'), false);
});

test("channel_list names a channel whose id names another channel too by the name that picks it, and leaves the rest as they were", async () => {
  const f = fixture([...both(['a', 'b']), ['a', 'elsewhere']]);
  const listed = await f.registry.handleChannelToolCall('channel_list', {});
  const rows = listed.data as Array<{ id: string; name?: string; serverId: string }>;
  assert.deepEqual(rows.map((r) => [r.serverId, r.id, r.name]), [
    ['a', 'general', 'a:general'], ['b', 'general', 'b:general'], ['a', 'elsewhere', undefined],
  ]);
  assert.ok(!('name' in rows[2]!), 'a row whose id picks it alone gains no field');
  // One server's channel whose id is another channel's qualified name: no
  // other server shares the id, and it still gets the name that picks it.
  const g = fixture([['s', 's:room'], ['s', 'room']]);
  const one = (await g.registry.handleChannelToolCall('channel_list', {})).data as Array<{ id: string; name?: string }>;
  assert.deepEqual(one.map((r) => [r.id, r.name]), [['s:room', 's:s:room'], ['room', undefined]]);
  // The names come from one pass over the channels, not a lookup of every
  // channel per row, so a listing stays linear in the channels.
  const lookups = { n: 0 };
  const reg = f.registry as unknown as { entriesNamed(name: string): unknown[] };
  const entriesNamed = reg.entriesNamed.bind(f.registry);
  reg.entriesNamed = (name: string) => { lookups.n++; return entriesNamed(name); };
  await f.registry.handleChannelToolCall('channel_list', {});
  assert.equal(lookups.n, 0, 'no per-row lookup');
});

test("a fork's qualified-name refusal quotes its home's name as an id is quoted, escapes included", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const odd: ChannelRef = { serverId: 'b', channelId: 'q"x' };
  (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey(odd), {
    serverId: 'b', descriptor: { id: 'q"x', type: 'chat', label: 'q"x' }, open: true,
  });
  t.after(bindAsConversationFork(f.framework, 'scout', odd));
  const results = toolResults(t, f.framework);
  const dispatch = (f.framework as unknown as { dispatchChannelToolCall: Dispatcher }).dispatchChannelToolCall.bind(f.framework);
  dispatch('scout', { id: 'q', name: 'channel_publish', input: { channelId: 'b:q"x', serverId: 'b', content: 'x' } });
  assert.equal(results.get('q')?.error,
    '"b:q\\"x" names this conversation\'s channel by itself, so nothing was posted: call again with serverId left out.');
});

test("what a channel tool says of a channel names it as the agent can name it back, before the send and after", async () => {
  const f = fixture(both(['a', 'b']));
  // b's general declared inbound-only: channel_publish refuses it by the name that picks it.
  await f.registry.handleChanged('b', { updated: [{ id: 'general', type: 'chat', label: 'general', direction: 'inbound' }] } as never);
  const inbound = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'b:general', content: 'x' });
  assert.match(inbound.error ?? '', /^Channel b:general is inbound-only: server "b"/);
  const target = f.registry.resolveProseTarget('b:general', { forSpeech: true });
  assert.match('error' in target ? target.error : '', /^b:general is inbound-only/);
  // A default channel whose server is gone, while another server registers its id.
  const internal = f.registry as unknown as { defaultPublishChannel: ChannelRef | null };
  internal.defaultPublishChannel = { serverId: 'c', channelId: 'general' };
  const gone = await f.registry.handleChannelToolCall('channel_publish', { content: 'x' });
  assert.equal(gone.error, 'The channel this would default to, "c:general", isn\'t registered now, so nothing was posted.');
  assert.deepEqual(f.take().filter((c) => c.what === 'publish'), []);
  // An open or close that didn't complete names it the same way.
  const registry = f.registry as unknown as {
    entryAt(ref: ChannelRef): unknown;
    lifecycleFailureText(action: 'close', entry: unknown, err: unknown): string;
  };
  const failed = registry.lifecycleFailureText('close', registry.entryAt(a), new Error('the wire dropped'));
  assert.ok(failed.includes('"a:general"') && !failed.includes('"general"'), failed);
});

test("channel_open of a tuned-out channel whose id another server shares names it as tune_out takes it back", async () => {
  const f = fixture(both(['a', 'b']));
  f.registry.enterTuneOut('b', 'general', { epochId: 'e', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
  const refused = await f.registry.handleChannelToolCall('channel_open', { channelId: 'b:general' });
  assert.ok(refused.error?.includes('Call tune_out with channelId "b:general" and mode "cancel"'), refused.error);
  assert.deepEqual(refused.data, { refusal: 'tuned-out', channelId: 'general', serverId: 'b' });
  // An open the tune-out overtook during its round-trip says the same.
  const registry = f.registry as unknown as {
    entryAt(ref: ChannelRef): unknown;
    lifecycleFailureText(action: 'open', entry: unknown, err: unknown): string;
  };
  const overtaken = registry.lifecycleFailureText('open', registry.entryAt(b), new Error('the wire dropped'));
  assert.ok(overtaken.startsWith('Channel "b:general" was tuned out meanwhile'), overtaken);
  assert.ok(overtaken.includes('Call tune_out with channelId "b:general" and mode "cancel"'), overtaken);
});

test("a message a server sends for an id only another server registers is refused, not taken as that server's", () => {
  // §14.5: channels/incoming is validated at receipt against the channel the
  // receiving server registered, not against another server's with the id.
  const f = fixture([['b', 'general']]);
  f.registry.handleIncoming('a', { messages: [{
    channelId: 'general', messageId: 'm1', author: { id: 'u1', name: 'Antra' },
    timestamp: '2026-05-30T00:00:00.000Z', content: [{ type: 'text', text: 'from a' }],
  }] } as never);
  assert.ok(f.traces.some((e) => e.type === 'mcpl:channel-incoming-rejected'), 'rejected at receipt');
  assert.equal(f.registry.getDefaultPublishChannel(), null, "b's general doesn't become the default for a's message");
  assert.equal(f.registry.incomingFor(), undefined);
});

test("one server's channel declared inbound-only is refused speech, and the other server's channel with its id is not", async () => {
  const f = fixture([['a', 'general'], ['b', 'general']]);
  await f.registry.handleChanged('a', { updated: [{ id: 'general', type: 'chat', label: 'general', direction: 'inbound' }] } as never);
  assert.equal(f.registry.inboundOnlyServer(a), 'a');
  assert.equal(f.registry.inboundOnlyServer(b), undefined);
  const refused = await f.registry.routeSpeech('agent', 'to a', a);
  assert.equal(refused?.delivered ?? false, false);
  const routed = await f.registry.routeSpeech('agent', 'to b', b);
  assert.equal(routed?.delivered, true);
  assert.deepEqual(f.take().filter((c) => c.what === 'publish').map((c) => `${c.server} ${c.text}`), ['b to b']);
});

test("a publish given a server its channel isn't on says where the id is, by the names channelId takes, and gives no advice to post there", async () => {
  // One place: the text names its server too, so the caller chooses.
  const one = fixture([['a', 'general']]);
  const there = await one.registry.handleChannelToolCall('channel_publish', { channelId: 'general', serverId: 'b', content: 'x' });
  assert.equal(there.error, 'No channel "general" is on server "b", so nothing was posted. It\'s on server "a" as "general".');
  assert.equal((await one.registry.publishForAgent({ serverId: 'b', channelId: 'general' }, 'x', 'agent')).error, there.error);
  // A place no string picks alone is named as such: a's b:room shares its
  // id with c's, and its qualified name with a:b's room.
  const some = fixture([['a', 'b:room'], ['c', 'b:room'], ['a:b', 'room']]);
  const named = await some.registry.handleChannelToolCall('channel_publish', { channelId: 'b:room', serverId: 'z', content: 'x' });
  assert.equal(named.error, 'No channel "b:room" is on server "z", so nothing was posted. It\'s on server "a" (no channelId ' +
    'reaches it alone) and on server "c" as "c:b:room".');
  // A name that reads two ways gives a line per channel, each with its route
  // where a channelId has one.
  const twoWays = await some.registry.handleChannelToolCall('channel_publish', { channelId: 'a:b:room', content: 'x' });
  assert.equal(twoWays.error, 'Channel "a:b:room" could mean either of two channels, so nothing was posted:\n' +
    '- "b:room" on server "a": no channelId reaches it alone.\n- "room" on server "a:b": call again with channelId "room".');
  // An agent's refusal reads the same: the publish has no route to a
  // channel no channelId reaches, and offers none.
  const asAgent = { kind: 'agent', agentName: 'scout' } as never;
  const byAgent = await some.registry.handleChannelToolCall('channel_publish', { channelId: 'a:b:room', content: 'x' }, asAgent);
  assert.equal(byAgent.error, twoWays.error);
  // Where no place has a name, the text says where it is and no more.
  const none = fixture([['a', 'b:room'], ['b', 'room'], ['a:b', 'room']]);
  const listed = await none.registry.handleChannelToolCall('channel_publish', { channelId: 'b:room', serverId: 'z', content: 'x' });
  assert.equal(listed.error, 'No channel "b:room" is on server "z", so nothing was posted. It\'s on server "a" (no channelId reaches it alone).');
  // One server's two channels answering to one name.
  const sameServer = fixture([['s', 's:room'], ['s', 'room']]);
  const oneServer = await sameServer.registry.handleChannelToolCall('channel_publish', { channelId: 's:room', content: 'x' });
  assert.equal(oneServer.error, 'Channel "s:room" could mean more than one channel on server "s" ("s:s:room", "room"), ' +
    'so nothing was posted. Call again with channelId set to one of them.');
  // Three places, one of which takes no posts: each is named, in registration
  // order, and a post there is refused by its own check, by the name that picked it.
  const inbound = fixture([['a', 'general'], ['b', 'general'], ['d', 'general']]);
  await inbound.registry.handleChanged('b', { updated: [{ id: 'general', type: 'chat', label: 'general', direction: 'inbound' }] } as never);
  const readOnly = await inbound.registry.handleChannelToolCall('channel_publish', { channelId: 'general', serverId: 'c', content: 'x' });
  assert.equal(readOnly.error, 'No channel "general" is on server "c", so nothing was posted. It\'s on server "a" as "a:general", on ' +
    'server "b" as "b:general" and on server "d" as "d:general".');
  const qualified = await inbound.registry.handleChannelToolCall('channel_publish', { channelId: 'b:general', serverId: 'c', content: 'x' });
  assert.equal(qualified.error, 'No channel "b:general" is on server "c", so nothing was posted. "b:general" alone names channel ' +
    '"general" on server "b".');
  const shared = await inbound.registry.handleChannelToolCall('channel_publish', { channelId: 'general', content: 'x' });
  assert.equal(shared.error, 'Channel "general" is on more than one server ("a:general", "b:general", "d:general"), so nothing was ' +
    'posted. Call again with channelId set to one of them.');
  const picked = await inbound.registry.handleChannelToolCall('channel_publish', { channelId: 'b:general', content: 'x' });
  assert.match(picked.error ?? '', /^Channel b:general is inbound-only/);
  // A tool that doesn't post offers each the same way, and its serverId too.
  const closing = await inbound.registry.handleChannelToolCall('channel_close', { channelId: 'general' });
  assert.equal(closing.error, 'Channel "general" is on more than one server ("a:general", "b:general", "d:general"), so nothing ran. ' +
    'Call again with channelId set to one of them, or with serverId set to "a" or "b" or "d".');
  // A serverId given alone, which channel_publish's schema doesn't have,
  // names the default channel's id on that server, held to as one given
  // with a channelId is: b's general takes no posts, so nothing goes to a's.
  (inbound.registry as unknown as { defaultPublishChannel: ChannelRef }).defaultPublishChannel = a;
  const alone = await inbound.registry.handleChannelToolCall('channel_publish', { serverId: 'b', content: 'to b' });
  assert.equal(alone.success, false);
  assert.match(alone.error!, /^Channel b:general is inbound-only/);
  const aloneOwn = await inbound.registry.handleChannelToolCall('channel_publish', { serverId: 'a', content: 'to the default' });
  assert.equal(aloneOwn.success, true, aloneOwn.error);
  assert.deepEqual(inbound.take().filter((c) => c.what === 'publish').map((c) => c.server), ['a']);
  for (const f of [one, some, none, sameServer]) assert.deepEqual(f.take().filter((c) => c.what === 'publish'), []);
});
test("a target's refusal lists its candidates in registration order, unmarked, for speech as for a read, though one takes no posts", async () => {
  // b registered first, and its general takes no posts, declared in place, so the map's order stays.
  const f = fixture(both(['b', 'a']));
  (f.registry as unknown as { channels: Map<string, { descriptor: { direction?: string } }> }).channels
    .get(destinationKey(b))!.descriptor.direction = 'inbound';
  for (const forSpeech of [true, false]) {
    assert.deepEqual(f.registry.resolveProseTarget('general', { forSpeech }),
      { error: 'channel id "general" is ambiguous across servers', candidates: ['b:general', 'a:general'] }, `forSpeech ${forSpeech}`);
  }
  assert.deepEqual((f.registry.resolveProseTargetDurable('general') as { candidates?: string[] }).candidates, ['b:general', 'a:general']);
  // So are one person's DMs on two servers, each by the label that picks it.
  const d = fixture([]);
  for (const [serverId, label, direction] of [['a', 'DM: antra (work)', 'inbound'], ['b', 'DM: antra (home)', 'bidirectional']] as const) {
    await d.registry.handleRegister(serverId, { channels: [{
      id: `discord:dm:${serverId}`, type: 'discord', label, direction,
      metadata: { channelType: 'dm', recipientId: '42', recipientName: 'antra' },
    }] } as never);
  }
  for (const forSpeech of [true, false]) {
    assert.deepEqual(d.registry.resolveProseTarget('<@42>', { forSpeech }),
      { error: '"<@42>" matches several DMs', candidates: ['DM: antra (work)', 'DM: antra (home)'] }, `forSpeech ${forSpeech}`);
  }
});
test("a host's speech to a ref that resolves nowhere is traced with the server it named", async () => {
  const f = fixture(both(['a', 'b']));
  const nowhere = await f.registry.publishForAgent({ serverId: 'c', channelId: 'general' }, 'to c', 'agent');
  // The tool's schema has no serverId, so the refusal names where the id is by the names its channelId takes.
  assert.equal(nowhere.error, 'No channel "general" is on server "c", so nothing was posted. It\'s on server "a" as ' +
    '"a:general" and on server "b" as "b:general".');
  const failed = f.traces.filter((e) => e.type === 'mcpl:speech-route-failed');
  assert.deepEqual(failed.map((e) => [e.serverId, e.channelId]), [['c', 'general']]);
  assert.deepEqual(f.take(), [], 'nothing was posted on a or b');
  // A refusal before the send names the channel the qualified name resolved to.
  await f.registry.handleChanged('b', { updated: [{ id: 'general', type: 'chat', label: 'general', direction: 'inbound' }] } as never);
  await f.registry.publishForAgent('b:general', 'to b', 'agent');
  assert.deepEqual(f.traces.filter((e) => e.type === 'mcpl:speech-route-failed').map((e) => [e.serverId, e.channelId]).at(-1), ['b', 'general']);
});

test("a host's speech is traced at the channel it went to, though the channel is removed while the publish is pending", async () => {
  const f = fixture(both(['a', 'b']));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const server = (f.registry as unknown as { serverRegistry: { getServer(id: string): { sendChannelsPublish(p: unknown): Promise<unknown> } } })
    .serverRegistry.getServer('b');
  const send = server.sendChannelsPublish.bind(server);
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  server.sendChannelsPublish = async (p: unknown) => { entered(); await pending; return send(p); };
  const publishing = f.registry.publishForAgent(b, 'to b', 'agent');
  await sending;
  f.registry.removeServer('b');
  release();
  await publishing;
  const routed = f.traces.filter((e) => e.type === 'mcpl:speech-routed');
  assert.deepEqual(routed.map((e) => [e.serverId, e.channelId]), [['b', 'general']]);
});

test("typing asked for a channel not yet registered keeps no metadata for when it is", async () => {
  const f = fixture([]);
  const late = { serverId: 'a', channelId: 'late' };
  f.registry.startTyping(late, { topic: 'stale' });
  assert.deepEqual(f.take(), [], 'no typing for a channel not registered');
  await f.registry.handleRegister('a', { channels: [{ id: 'late', type: 'chat', label: 'late', direction: 'bidirectional' }] } as never);
  f.registry.startTyping(late);
  assert.deepEqual(f.take().filter((c) => c.what.startsWith('typing')).map((c) => `${c.server} ${c.what} ${JSON.stringify(c.metadata)}`),
    ['a typing undefined']);
});

test("two DMs whose labels differ only in case are listed by their tokens, as a name matches either", async () => {
  const f = fixture([]);
  for (const [serverId, label] of [['a', 'DM: Antra'], ['b', 'DM: antra']] as const) {
    await f.registry.handleRegister(serverId, { channels: [{
      id: `discord:dm:${serverId}`, type: 'discord', label, direction: 'bidirectional',
      metadata: { channelType: 'dm', recipientId: '42', recipientName: 'antra' },
    }] } as never);
  }
  assert.deepEqual(f.registry.resolveProseTarget('<@42>'),
    { error: '"<@42>" matches several DMs', candidates: ['discord:dm:a', 'discord:dm:b'] });
});

test("speech's candidates for a label two of one server's channels share come in registration order, unmarked, though one takes no posts", async () => {
  const f = fixture([['s', 'g1', 'general'], ['s', 'g2', 'general']]);
  await f.registry.handleChanged('s', { updated: [{ id: 'g1', type: 'chat', label: 'general', direction: 'inbound' }] } as never);
  for (const forSpeech of [true, false]) {
    const r = f.registry.resolveProseTarget('general', { forSpeech });
    assert.deepEqual(r, { error: 'label "general" matches several channels', candidates: ['g1', 'g2'] }, `forSpeech ${forSpeech}`);
  }
});

test("channel_open, channel_close and channel_decline naming the turn's own channel by its id, once its server withdrew it, are refused, and act on no other server's channel", async () => {
  const f = fixture(both(['a', 'b']));
  await f.registry.handleChannelToolCall('channel_open', { channelId: 'b:general' });
  await f.registry.handleChanged('a', { removed: ['general'] });
  f.take();
  const inTurn = { kind: 'agent', agentName: 'scout', own: [a] } as never;
  for (const [tool, done, extra] of [['channel_open', 'ran', {}], ['channel_close', 'ran', {}], ['channel_decline', 'ran', { messageId: 'm1' }]] as const) {
    const r = await f.registry.handleChannelToolCall(tool, { channelId: 'general', ...extra }, inTurn);
    assert.equal(r.success, false, tool);
    assert.equal(r.error, `"general" is this turn's channel on server "a", which no longer registers it, so nothing ${done}, `
      + 'and nothing can run on it until that server registers it again.', tool);
  }
  assert.deepEqual(f.take(), [], "nothing went to b's general");
  assert.equal((f.registry as unknown as { getDesiredState(s: string, c: string): string | undefined }).getDesiredState('b', 'general'), 'open');
  // Outside the turn the id is b's alone, as before; and the turn's serverId picks b's, its own choice.
  const named = await f.registry.handleChannelToolCall('channel_close', { channelId: 'general', serverId: 'b' }, inTurn);
  assert.equal(named.success, true, named.error);
});

test("a default channel whose server disconnected is refused as the default gone, naming it, and nothing goes to another server's channel with its id", async () => {
  const f = fixture(both(['a', 'b']));
  const internal = f.registry as unknown as { defaultPublishChannel: ChannelRef | null };
  internal.defaultPublishChannel = a;
  f.registry.removeServer('a');
  assert.deepEqual(f.registry.getDefaultPublishChannel(), a, "removeServer keeps the default's ref, as a withdrawal does");
  const gone = await f.registry.handleChannelToolCall('channel_publish', { content: 'x' });
  assert.equal(gone.error, 'The channel this would default to, "a:general", isn\'t registered now, so nothing was posted.');
  assert.deepEqual(f.take().filter((c) => c.what === 'publish'), []);
});

test("a tool call takes the turn's channels only when it carries the turn's id", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const fw = f.framework as unknown as {
    turnRouting: Map<string, unknown>;
    callOwnChannels(agent: string, call: { id: string; name: string; input: object; callerTurnId?: number }): ChannelRef[];
  };
  fw.turnRouting.set('scout', { turnId: 7, wasIn: [a], triggerChannel: a, engaged: new Set() });
  assert.deepEqual(fw.callOwnChannels('scout', { id: 'now', name: 'channel_publish', input: {}, callerTurnId: 7 }), [a], "the turn's own call");
  assert.deepEqual(fw.callOwnChannels('scout', { id: 'earlier', name: 'channel_publish', input: {}, callerTurnId: 6 }), [], "an earlier turn's call");
  assert.deepEqual(fw.callOwnChannels('scout', { id: 'none', name: 'channel_publish', input: {} }), [], 'a call with no turn');
  // A silent start's routing is the latest while turn 7 is still open: turn 7's call is still its own.
  (fw as unknown as { openLogical: Map<string, unknown> }).openLogical.set('scout', fw.turnRouting.get('scout'));
  fw.turnRouting.set('scout', { turnId: 8, wasIn: [], engaged: new Set() });
  assert.deepEqual(fw.callOwnChannels('scout', { id: 'open', name: 'channel_publish', input: {}, callerTurnId: 7 }), [a], "the open turn's call");
  assert.deepEqual(fw.callOwnChannels('scout', { id: 'silent', name: 'channel_publish', input: {}, callerTurnId: 8 }), [], "the silent start's own call, which has no channel");
});

test("channel_open, channel_close and channel_decline naming the turn's own channel by a shared id take that channel, and two of the turn's channels with the id mean neither", async () => {
  const f = fixture(both(['a', 'b']));
  const inTurn = (own: ChannelRef[]) => ({ kind: 'agent', agentName: 'scout', own }) as never;
  const opened = await f.registry.handleChannelToolCall('channel_open', { channelId: 'general' }, inTurn([b]));
  assert.equal(opened.success, true, opened.error);
  assert.deepEqual((opened.data as { serverId?: string }).serverId, 'b');
  const closed = await f.registry.handleChannelToolCall('channel_close', { channelId: 'general' }, inTurn([b]));
  assert.equal(closed.success, true, closed.error);
  assert.deepEqual(f.take().filter((c) => c.what === 'open' || c.what === 'close').map((c) => `${c.what} ${c.server}`), ['open b', 'close b']);
  for (const tool of ['channel_open', 'channel_close', 'channel_decline']) {
    const neither = await f.registry.handleChannelToolCall(tool, { channelId: 'general', messageId: 'm1' }, inTurn([a, b]));
    assert.equal(neither.error, '"general" is the id of this turn\'s channels on more than one server ("a:general", "b:general"), '
      + 'so nothing ran. Call again with channelId set to one of them.', tool);
  }
  // A name no string picks alone: server "a" has "b:room" and server "a:b" has "room", both answering to "a:b:room".
  const odd = fixture([['a', 'b:room'], ['a:b', 'room'], ['c', 'b:room']]);
  const ownOdd: ChannelRef[] = [{ serverId: 'a', channelId: 'b:room' }, { serverId: 'c', channelId: 'b:room' }];
  // channel_publish takes no serverId, so its refusal names none; channel_open does.
  const oddRefusal = await odd.registry.handleChannelToolCall('channel_publish', { channelId: 'b:room', content: 'x' }, inTurn(ownOdd));
  assert.equal(oddRefusal.error, '"b:room" is the id of this turn\'s channels on more than one server ("b:room" on server "a" (no channelId '
    + 'reaches it alone), "c:b:room"), so nothing was posted. Call again with channelId "c:b:room".');
  const oddOpen = await odd.registry.handleChannelToolCall('channel_open', { channelId: 'b:room' }, inTurn(ownOdd));
  assert.equal(oddOpen.error, '"b:room" is the id of this turn\'s channels on more than one server ("b:room" on server "a" (no channelId '
    + 'reaches it alone), "c:b:room"), so nothing ran. Call again with channelId "c:b:room". For a channel shown by its id and '
    + 'server, call again with that channelId and that serverId.');
  // None reachable by a name: no "Call again".
  await odd.registry.handleChanged('c', { removed: ['b:room'] });
  const none = await odd.registry.handleChannelToolCall('channel_publish', { channelId: 'b:room', content: 'x' }, inTurn(ownOdd));
  assert.equal(none.error, '"b:room" is the id of this turn\'s channels on more than one server ("b:room" on server "a" (no channelId '
    + 'reaches it alone), "b:room" on server "c" (its server no longer registers it)), so nothing was posted.');
  // Two named among three: "one of X, Y".
  const three = fixture([['a', 'general'], ['b', 'general'], ['d', 'general']]);
  await three.registry.handleChanged('d', { removed: ['general'] });
  const d = { serverId: 'd', channelId: 'general' };
  const two = await three.registry.handleChannelToolCall('channel_publish', { channelId: 'general', content: 'x' }, inTurn([a, b, d]));
  assert.equal(two.error, '"general" is the id of this turn\'s channels on more than one server ("a:general", "b:general", "general" on '
    + 'server "d" (its server no longer registers it)), so nothing was posted. Call again with channelId set to one of "a:general", "b:general".');
});

const offered = (route: string): string[] =>
  [...route.matchAll(/channelId ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as string);

test("a refusal names the channelId channel_publish reaches a channel it shows by id and server by, or says none reaches it alone", async () => {
  // Server "a"'s "b\"x:room" is the only channel with that id, though its qualified name is server "a:b\"x"'s "room"'s too.
  const f = fixture([['a', 'b"x:room'], ['a:b"x', 'room']]);
  for (const candidate of ['"b\\"x:room" on server "a"', '#lounge = "b\\"x:room" on server "a"']) {
    assert.deepEqual(offered(f.registry.publishRouteFor([candidate])), ['b"x:room'], candidate);
  }
  const posted = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'b"x:room', content: 'hello' });
  assert.equal(posted.success, true, posted.error);
  assert.deepEqual(f.take().filter((c) => c.what === 'publish').map((c) => `${c.server} ${c.channelId}`), ['a b"x:room']);
  // Server "a"'s "b:room": its id is server "c"'s too, and its qualified name server "a:b"'s "room"'s.
  const odd = fixture([['a', 'b:room'], ['a:b', 'room'], ['c', 'b:room']]);
  const none = odd.registry.publishRouteFor(['"b:room" on server "a"']);
  assert.deepEqual(offered(none), [], none);
  assert.match(none, /no channelId reaches .+ alone/);
  assert.ok(none.includes('"b:room"') && none.includes('"a"'), none);
  assert.equal(odd.registry.publishRouteFor(['"b:room" on server "a" (no channelId reaches it alone)', 'c:b:room']), '');
});

test("the route a refusal names is the qualified name first, which a turn's own channel withdrawn with the same id doesn't take, and never an empty id", async () => {
  const f = fixture([['a', 'x"y']]);
  // Server "b" no longer registers its "x\"y", which is still the turn's own channel.
  const own: ChannelRef[] = [{ serverId: 'a', channelId: 'x"y' }, { serverId: 'b', channelId: 'x"y' }];
  const inTurn = { kind: 'agent', agentName: 'scout', own } as never;
  const route = f.registry.publishRouteFor(['"x\\"y" on server "a"']);
  assert.deepEqual(offered(route), ['a:x"y'], route);
  const posted = await f.registry.handleChannelToolCall('channel_publish', { channelId: offered(route)[0]!, content: 'hello' }, inTurn);
  assert.equal(posted.success, true, posted.error);
  assert.deepEqual(f.take().filter((c) => c.what === 'publish').map((c) => `${c.server} ${c.channelId}`), ['a x"y']);
  // The bare id would mean both of the turn's channels, and be refused.
  const bare = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'x"y', content: 'hello' }, inTurn);
  assert.equal(bare.success, false);
  // A channel whose id is empty is reached by its qualified name; channel_publish refuses an empty channelId.
  const empty = fixture([['a', '']]);
  const emptyRoute = empty.registry.publishRouteFor(['"" on server "a"']);
  assert.deepEqual(offered(emptyRoute), ['a:'], emptyRoute);
  const reached = await empty.registry.handleChannelToolCall('channel_publish', { channelId: 'a:', content: 'hello' });
  assert.equal(reached.success, true, reached.error);
  assert.deepEqual(empty.take().filter((c) => c.what === 'publish').map((c) => `${c.server} ${c.channelId}`), ['a ']);
});

test("a turn's channels sharing an id whose qualified names don't show as themselves stay reachable by those names, as JSON", async () => {
  const f = fixture([['a', 'x"y'], ['b', 'x"y']]);
  const own: ChannelRef[] = [{ serverId: 'a', channelId: 'x"y' }, { serverId: 'b', channelId: 'x"y' }];
  const inTurn = (refs: ChannelRef[]) => ({ kind: 'agent', agentName: 'scout', own: refs }) as never;
  for (const [tool, done] of [['channel_publish', 'was posted'], ['channel_open', 'ran']] as const) {
    const refused = await f.registry.handleChannelToolCall(tool, { channelId: 'x"y', content: 'x' }, inTurn(own));
    assert.equal(refused.error, '"x"y" is the id of this turn\'s channels on more than one server ("a:x\\"y", "b:x\\"y"), '
      + `so nothing ${done}. Call again with channelId set to one of them.`, tool);
  }
  const posted = await f.registry.handleChannelToolCall('channel_publish', { channelId: JSON.parse('"a:x\\"y"'), content: 'hello' }, inTurn(own));
  assert.equal(posted.success, true, posted.error);
  assert.deepEqual(f.take().filter((c) => c.what === 'publish').map((c) => `${c.server} ${c.channelId}`), ['a x"y']);
  // A `>>` target can't take JSON: the prose resolver lists them by id and server, and says what channel_publish takes.
  const resolved = f.registry.resolveProseTarget('x"y', { forSpeech: true, own }) as { error?: string; candidates?: string[] };
  assert.deepEqual(resolved.candidates, ['"x\\"y" on server "a"', '"x\\"y" on server "b"']);
  assert.deepEqual(offered(f.registry.publishRouteFor(resolved.candidates!)), ['a:x"y', 'b:x"y']);
});

test("a default channel's reply anchors survive a withdrawal, as on main, and go with its server's disconnect, as on main, while its ref stays", async () => {
  const f = fixture(both(['a', 'b']));
  f.registry.handleIncoming('a', { messages: [{ channelId: 'general', messageId: 'm-a', threadId: 't-a', author: { id: 'u', name: 'u' },
    timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'hi' }] }] } as never);
  // Admission records the delivered message as the latest (noteDelivered).
  f.registry.noteDelivered(a, 'm-a', 't-a');
  const before = f.registry.incomingFor();
  assert.deepEqual(before, { channel: a, messageId: 'm-a', threadId: 't-a' });
  await f.registry.handleChanged('a', { removed: ['general'] });
  assert.deepEqual(f.registry.incomingFor(), before, 'a withdrawal keeps them');
  f.registry.removeServer('a');
  assert.equal(f.registry.incomingFor(), undefined, "a disconnect takes them, so no message on a server that's gone is given as the one replied to");
  assert.deepEqual(f.registry.getDefaultPublishChannel(), a, "the default's ref stays, for the default-gone refusal");
});

test("the subconscious's cancel_tuneout gets its turn's own channels from the framework, for a call made inside the turn", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const seen: Array<readonly ChannelRef[] | undefined> = [];
  const fw = f.framework as unknown as {
    subconsciousAgentName: string | undefined;
    tuneOutCoordinator: unknown;
    turnRouting: Map<string, unknown>;
    dispatchToolCall(agent: string, call: { id: string; name: string; input: object }, turnId?: number): void;
  };
  fw.subconsciousAgentName = 'scout';
  fw.tuneOutCoordinator = {
    handleSubconsciousTool: async (_name: string, _input: unknown, own?: readonly ChannelRef[]) => { seen.push(own); return { success: true }; },
    stop: () => {},
  };
  fw.turnRouting.set('scout', { turnId: 7, wasIn: [b], triggerChannel: b, engaged: new Set() });
  fw.dispatchToolCall('scout', { id: 'c1', name: 'cancel_tuneout', input: { channelId: 'general' } }, 7);
  fw.dispatchToolCall('scout', { id: 'c2', name: 'cancel_tuneout', input: { channelId: 'general' } }, 6);
  for (let i = 0; i < 20 && seen.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [[b], []], "the turn's own call gets its channels; an earlier turn's gets none");
});

test("channel_open's answer when its decision can't be recorded names the shared channel as the agent is shown it", async () => {
  const f = fixture([['a', 'general'], ['b', 'general']]);
  const first = await f.registry.handleChannelToolCall('channel_open', { channelId: 'a:general' });
  assert.equal(first.success, true, first.error);
  (f.registry as unknown as { setDesiredState(): void }).setDesiredState = () => { throw new Error('ENOSPC'); };
  const again = await f.registry.handleChannelToolCall('channel_open', { channelId: 'a:general' });
  assert.equal(again.error, 'Channel a:general is already open, but recording your decision to open it failed: ENOSPC');
});

test('the channel map keeps two channels whose ids would join to one key with a colon, each with its own entry', async () => {
  // Server `a`'s channel `b:room` and server `a:b`'s channel `room` both read
  // `a:b:room` once joined with a colon.
  const f = fixture([]);
  await f.registry.handleRegister('a', { channels: [{ id: 'b:room', type: 'chat', label: "a's b:room", direction: 'bidirectional' }] } as never);
  await f.registry.handleRegister('a:b', { channels: [{ id: 'room', type: 'chat', label: "a:b's room", direction: 'bidirectional' }] } as never);
  assert.equal(f.registry.getDescriptor({ serverId: 'a', channelId: 'b:room' })?.label, "a's b:room");
  assert.equal(f.registry.getDescriptor({ serverId: 'a:b', channelId: 'room' })?.label, "a:b's room");
  const listed = await f.registry.handleChannelToolCall('channel_list', {});
  assert.deepEqual((listed.data as Array<{ id: string; serverId: string }>).map((c) => `${c.serverId} ${c.id}`).sort(), ['a b:room', 'a:b room']);

  // Each id is unique, so each names its channel.
  assert.equal(f.registry.nameShown({ serverId: 'a', channelId: 'b:room' }), 'b:room');
  // The joined name means both, so it's refused with each named by its server and id apart.
  const refused = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'a:b:room', content: 'x' });
  assert.equal(refused.success, false);
  assert.equal(refused.error,
    'Channel "a:b:room" is on more than one server ("b:room", "room"), so nothing was posted. Call again with channelId set to one of them.');
});

test("a name that reads two ways is refused with a line per channel, each with its route where the tool has one", async () => {
  // Server `a` and server `c` both register `b:room`, and server `a:b`
  // registers `room`: `a`'s `b:room` has no string of its own, since `b:room`
  // is shared and `a:b:room` is also `a:b`'s `room`.
  const f = fixture([['a', 'b:room'], ['c', 'b:room'], ['a:b', 'room']]);
  assert.deepEqual(f.registry.channelsNamed('a:b:room').map((r) => `${r.serverId} ${r.channelId}`).sort(), ['a b:room', 'a:b room']);
  // a:b's `room` is the only `room`, so that names it alone; a's `b:room` has no name of its own.
  // A publish says nothing was posted; another tool, that nothing ran.
  const opening = (nothing: string) => `Channel "a:b:room" could mean either of two channels, so ${nothing}:\n`;
  const refused = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'a:b:room', content: 'x' }, { kind: 'agent', agentName: 'scout' });
  assert.equal(refused.error, opening('nothing was posted') +
    '- "b:room" on server "a": no channelId reaches it alone.\n' +
    '- "room" on server "a:b": call again with channelId "room".');
  // The subconscious's refusal reads the same.
  const unspoken = await f.registry.publishForAgent('a:b:room', 'x', 'Subconscious');
  assert.equal(unspoken.error, opening('nothing was posted') +
    '- "b:room" on server "a": no channelId reaches it alone.\n' +
    '- "room" on server "a:b": call again with channelId "room".');
  assert.equal(unspoken.reason, 'shared-id', 'a name that reads two ways is a shared name too');
  // A tool that takes serverId reaches each by its id and server.
  const closeRefused = await f.registry.handleChannelToolCall('channel_close', { channelId: 'a:b:room' });
  assert.equal(closeRefused.error, opening('nothing ran') +
    '- "b:room" on server "a": call again with channelId "b:room" and serverId "a".\n' +
    '- "room" on server "a:b": call again with channelId "room".');
  assert.equal(f.registry.proseTargetFor({ serverId: 'a', channelId: 'b:room' }), undefined, 'no token picks it alone');
  // What an agent is shown names each by what picks it alone, and the one
  // nothing picks alone by its id and server, as the refusals name it.
  assert.equal(f.registry.nameShown({ serverId: 'a', channelId: 'b:room' }), '"b:room" on server "a"');
  assert.equal(f.registry.nameShown({ serverId: 'c', channelId: 'b:room' }), 'c:b:room');
  assert.equal(f.registry.nameShown({ serverId: 'a:b', channelId: 'room' }), 'room');
  // tune_out takes a serverId, so the refusal names a tuned-out channel no
  // name picks by its id and server for the cancel.
  f.registry.enterTuneOut('a', 'b:room', { epochId: 'e', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
  const tuned = await f.registry.handleChannelToolCall('channel_open', { channelId: 'b:room', serverId: 'a' });
  assert.ok(tuned.error?.startsWith('Channel "b:room" on server "a" is tuned out'), tuned.error);
  assert.ok(tuned.error?.includes('Call tune_out with channelId "b:room", serverId "a" and mode "cancel"'), tuned.error);
  // channel_close refuses it too, and says the close can come after the cancel.
  const closing = await f.registry.handleChannelToolCall('channel_close', { channelId: 'b:room', serverId: 'a' });
  assert.ok(closing.error?.startsWith('Channel "b:room" on server "a" is tuned out'), closing.error);
  assert.ok(closing.error?.endsWith('cancelling delivers the diverted backlog, and channel_close closes it after that.'), closing.error);
  assert.ok(closing.error?.includes('channelId "b:room", serverId "a"'), closing.error);
  // An open the tune-out overtook during its round-trip says the same: the
  // cancel by id and server.
  const registry = f.registry as unknown as {
    entryAt(ref: ChannelRef): unknown;
    lifecycleFailureText(action: 'open', entry: unknown, err: unknown): string;
  };
  const overtaken = registry.lifecycleFailureText('open', registry.entryAt({ serverId: 'a', channelId: 'b:room' }), new Error('the wire dropped'));
  assert.ok(overtaken.startsWith('Channel "b:room" on server "a" was tuned out meanwhile'), overtaken);
  assert.ok(overtaken.includes('Call tune_out with channelId "b:room", serverId "a" and mode "cancel"'), overtaken);
  // channel_list gives a name only where one picks the channel alone.
  const rows = (await f.registry.handleChannelToolCall('channel_list', {})).data as Array<{ id: string; name?: string; serverId: string }>;
  assert.deepEqual(rows.map((r) => [r.serverId, r.id, r.name]), [['a', 'b:room', undefined], ['c', 'b:room', 'c:b:room'], ['a:b', 'room', undefined]]);
  assert.deepEqual(f.take(), []);
});

test("a name one server's two channels answer to is refused without offering the server, and a bare id another channel's qualified name shares is refused too", async () => {
  // Server `s` registers `s:room` and `room`: `s:room` is the first's id and the second's qualified name.
  const f = fixture([['s', 's:room'], ['s', 'room']]);
  const close = await f.registry.handleChannelToolCall('channel_close', { channelId: 's:room' });
  assert.equal(close.error, 'Channel "s:room" could mean more than one channel on server "s" ("s:s:room", "room"), so nothing ran. ' +
    'Call again with channelId set to one of them.');
  // A >> target and the publish resolver say the same of it.
  const target = f.registry.resolveProseTarget('s:room') as { error?: string; candidates?: string[] };
  assert.ok(target.error, 'refused');
  assert.deepEqual(target.candidates, ['s:s:room', 'room']);
  const destination = f.registry.resolveDestination({ channelId: 's:room' }) as { error?: string };
  assert.ok(destination.error?.includes('"s:s:room"') && destination.error.includes('"room"'), destination.error);
  // With no id shared at all: server `a`'s `b:room` and server `b`'s `room`.
  const g = fixture([['a', 'b:room'], ['b', 'room']]);
  const publish = await g.registry.handleChannelToolCall('channel_publish', { channelId: 'b:room', content: 'x' });
  assert.equal(publish.error, 'Channel "b:room" is on more than one server ("a:b:room", "room"), so nothing was posted. ' +
    'Call again with channelId set to one of them.');
  // A serverId goes with a channel's own id, which differs between these two, so none is offered.
  const closeAcross = await g.registry.handleChannelToolCall('channel_close', { channelId: 'b:room' });
  assert.equal(closeAcross.error, 'Channel "b:room" is on more than one server ("a:b:room", "room"), so nothing ran. ' +
    'Call again with channelId set to one of them.');
  assert.deepEqual(g.registry.resolveDestination({ channelId: 'b:room' }),
    { error: 'channel id "b:room" is on more than one server ("a:b:room", "room"), and the destination named no server' });
  assert.deepEqual(g.registry.resolveDestination({ channelId: 'a:b:room' }),
    { destination: { serverId: 'a', channelId: 'b:room', label: 'b:room' } }, 'its qualified name picks it');
  assert.deepEqual(g.take(), []);
});

test("a call that gives serverId names the exact pair, and its refusal says which call would work", async () => {
  const f = fixture([...both(['a', 'b']), ['a', 'b:room'], ['b', 'room']]);
  // A serverId goes with the channel's own id.
  const closed = await f.registry.handleChannelToolCall('channel_close', { channelId: 'general', serverId: 'b' });
  assert.equal(closed.success, true, closed.error);
  assert.deepEqual(f.take().filter((c) => c.what === 'close').map((c) => `${c.server} ${c.channelId}`), ['b general']);
  // A qualified name with its serverId isn't the pair, and the refusal says the name works alone.
  const both_ = await f.registry.handleChannelToolCall('channel_close', { channelId: 'a:general', serverId: 'a' });
  assert.equal(both_.error, 'No channel "a:general" is on server "a", so nothing ran. "a:general" alone names channel ' +
    '"general" on server "a": for that one, call again with serverId left out.');
  // An id on another server: leaving serverId out is offered only where the id alone names one channel.
  const elsewhere = await f.registry.handleChannelToolCall('channel_close', { channelId: 'b:room', serverId: 'c' });
  assert.equal(elsewhere.error, 'No channel "b:room" is on server "c", so nothing ran. It\'s on server "a": call again with serverId "a".');
  // A canonical ref whose channel is gone isn't read as another channel's qualified name.
  const gone = await f.registry.publishForAgent({ serverId: 'b', channelId: 'b:room' }, 'x', 'agent');
  assert.equal(gone.success, false);
  assert.deepEqual(f.take().filter((c) => c.what === 'publish'), [], "b's room, whose qualified name is b:room, isn't posted to");
});

test('a channel no longer registered is shown by a name no registered channel answers to', () => {
  // Server `b` registers `general`, and server `x` a channel whose id is `a:general`.
  const f = fixture([['b', 'general'], ['x', 'a:general']]);
  // By its id where nothing registered answers to it...
  assert.equal(f.registry.nameShown({ serverId: 'a', channelId: 'room' }), 'room');
  // ...qualified where its id now names another server's channel...
  assert.equal(f.registry.nameShown({ serverId: 'c', channelId: 'general' }), 'c:general');
  // ...and by its id and server where something answers to both.
  assert.equal(f.registry.nameShown({ serverId: 'a', channelId: 'general' }), '"general" on server "a"');
  // A >> target reads labels too: a name a label takes would send elsewhere.
  const g = fixture([['c', 'c:9', '#lounge']]);
  assert.equal(g.registry.nameShown({ serverId: 'a', channelId: 'lounge' }), 'a:lounge', '">>lounge" would reach c\'s #lounge');
});

test("a DM is listed by its label only where the label, given as a target, picks that DM", async () => {
  // Server x's channel has the id `inbox-a`, which a's DM is labelled:
  // `>>inbox-a` reaches x's channel, since an id outranks a label.
  const f = fixture([['x', 'inbox-a']]);
  for (const serverId of ['a', 'b']) {
    await f.registry.handleRegister(serverId, { channels: [{
      id: `discord:dm:${serverId}`, type: 'discord', label: `inbox-${serverId}`, direction: 'bidirectional',
      metadata: { channelType: 'dm', recipientId: '42', recipientName: 'antra' },
    }] } as never);
  }
  const mention = f.registry.resolveProseTarget('<@42>') as { error?: string; candidates?: string[] };
  assert.ok(mention.error, 'refused');
  assert.deepEqual(mention.candidates, ['discord:dm:a', 'inbox-b']);
  // Each candidate, given as a target, names its own DM.
  for (const [candidate, serverId] of [['discord:dm:a', 'a'], ['inbox-b', 'b']] as const) {
    const named = f.registry.resolveProseTarget(candidate);
    assert.equal('serverId' in named ? named.serverId : named.error, serverId, candidate);
  }
});

test("a DM labelled as an @name is listed by its token, since that label as a target would read as a DM name", async () => {
  const f = fixture([]);
  for (const [serverId, label] of [['a', '@antra'], ['b', '@antra (home)']] as const) {
    await f.registry.handleRegister(serverId, { channels: [{
      id: `discord:dm:${serverId}`, type: 'discord', label, direction: 'bidirectional',
      metadata: { channelType: 'dm', recipientId: '42', recipientName: 'antra' },
    }] } as never);
  }
  assert.deepEqual(f.registry.resolveProseTarget('<@42>'),
    { error: '"<@42>" matches several DMs', candidates: ['discord:dm:a', 'discord:dm:b'] });
});

test("a channel whose id is no >> target is offered by its qualified name", () => {
  const f = fixture([['s', 'skip_reply', 'Skip Reply']]);
  assert.equal(f.registry.proseTargetFor({ serverId: 's', channelId: 'skip_reply' }), 's:skip_reply');
});

test("stopping everything forgets each channel's typing metadata, so the channel registered again types without it", async () => {
  const f = fixture([['a', 'general']]);
  f.registry.startTyping(a, { topic: 'before the stop' });
  f.registry.stopAll();
  await f.registry.handleRegister('a', { channels: [{ id: 'general', type: 'chat', label: 'general', direction: 'bidirectional' }] } as never);
  f.take();
  f.registry.startTyping(a);
  assert.deepEqual(f.take().filter((c) => c.what === 'typing').map((c) => `${c.server} ${c.channelId} ${JSON.stringify(c.metadata)}`),
    ['a general undefined']);
});

test("a publish's failed or unconfirmed answer names its channel apart, as it's shown once the answer comes", async () => {
  const f = fixture(both(['a', 'b']));
  const server = (f.registry as unknown as { serverRegistry: { getServer(id: string): { sendChannelsPublish(p: unknown): Promise<unknown> } } })
    .serverRegistry.getServer('b');
  server.sendChannelsPublish = async () => ({ delivered: false });
  const failed = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'b:general', content: 'x' });
  assert.equal(failed.error, 'Nothing was posted to channel "b:general": the "b" server said it didn\'t post the message.');
  server.sendChannelsPublish = async () => { throw new Error('the wire dropped'); };
  const unknown = await f.registry.handleChannelToolCall('channel_publish', { channelId: 'b:general', content: 'x' });
  assert.match(unknown.error ?? '', /^Posting to channel "b:general" wasn't confirmed: /);
  // A channel whose id another server registers while its send is out is
  // named apart once the answer comes, not by the bare id that now names
  // the other server's channel.
  const g = fixture([['a', 'general']]);
  const gServer = (g.registry as unknown as { serverRegistry: { getServer(id: string): { sendChannelsPublish(p: unknown): Promise<unknown> } } })
    .serverRegistry.getServer('a');
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  gServer.sendChannelsPublish = async () => { entered(); await held; return { delivered: false }; };
  const publishing = g.registry.handleChannelToolCall('channel_publish', { channelId: 'general', content: 'x' });
  await sending;
  g.registry.removeServer('a');
  await g.registry.handleRegister('b', { channels: [{ id: 'general', type: 'chat', label: 'general', direction: 'bidirectional' }] } as never);
  release();
  assert.equal((await publishing).error, 'Nothing was posted to channel "a:general": the "a" server said it didn\'t post the message.');
  // So is an unconfirmed answer.
  const h = fixture([['a', 'general']]);
  const hServer = (h.registry as unknown as { serverRegistry: { getServer(id: string): { sendChannelsPublish(p: unknown): Promise<unknown> } } })
    .serverRegistry.getServer('a');
  let releaseH!: () => void;
  const heldH = new Promise<void>((resolve) => { releaseH = resolve; });
  let enteredH!: () => void;
  const sendingH = new Promise<void>((resolve) => { enteredH = resolve; });
  hServer.sendChannelsPublish = async () => { enteredH(); await heldH; throw new Error('the wire dropped'); };
  const publishingH = h.registry.handleChannelToolCall('channel_publish', { channelId: 'general', content: 'x' });
  await sendingH;
  h.registry.removeServer('a');
  await h.registry.handleRegister('b', { channels: [{ id: 'general', type: 'chat', label: 'general', direction: 'bidirectional' }] } as never);
  releaseH();
  assert.match((await publishingH).error ?? '', /^Posting to channel "a:general" wasn't confirmed: /);
});

test("a closed-channel invitation offers no >> reply a line reads as private speech, with the real registry or without its proseTargetFor", async (t) => {
  const f = await frameworkWith(t, ['a', 'b'], 'explicit');
  // A stand-in registry that can't name targets: the framework guesses one.
  (f.i.channelRegistry as unknown as { proseTargetFor?: unknown }).proseTargetFor = undefined;
  const invite = (f.framework as unknown as { buildClosedChannelInvitation(o: unknown): unknown }).buildClosedChannelInvitation({
    serverId: 's', channelId: 'skip_reply', messageId: 'm1', authorName: 'antra', tags: ['chat:addressed'],
  });
  assert.ok(invite, 'control: an addressed message from a closed channel gets an invitation');
  const text = JSON.stringify(invite);
  assert.ok(text.includes('no single-word target reaches this channel unambiguously'), text);
  assert.ok(!text.includes('>>skip_reply'), text);
  // The real registry offers the channel by its server-qualified name, which
  // a >> line reads as a target.
  delete (f.i.channelRegistry as unknown as { proseTargetFor?: unknown }).proseTargetFor;
  (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 's', channelId: 'skip_reply' }), {
    serverId: 's', descriptor: { id: 'skip_reply', type: 'chat', label: '' }, open: false,
  });
  const real = JSON.stringify((f.framework as unknown as { buildClosedChannelInvitation(o: unknown): unknown }).buildClosedChannelInvitation({
    serverId: 's', channelId: 'skip_reply', messageId: 'm2', authorName: 'antra', tags: ['chat:addressed'],
  }));
  assert.ok(real.includes('>>s:skip_reply'), real);
  assert.ok(!real.includes('>>skip_reply'), real);
});

test("a decline whose decision isn't recorded names its channel apart", async () => {
  const f = fixture(both(['a', 'b']));
  const internal = f.registry as unknown as { channels: Map<string, { open: boolean }>; setDesiredState: () => void };
  internal.channels.get(destinationKey(b))!.open = false;
  internal.setDesiredState = () => { throw new Error('the disk is full'); };
  const failed = await f.registry.handleChannelToolCall('channel_decline', { channelId: 'b:general', messageId: 'm1' });
  assert.match(failed.error ?? '', /^Nothing changed for channel "b:general": /);
});

test("a fork's turn whose wake names no channel still has its home, so it's replying to the latest message as every fork's turn is", () => {
  const f = fixture(both(['a', 'b']));
  Object.assign(f.registry as unknown as Record<string, unknown>, {
    activeChannelResolver: () => null,
    homeChannelResolver: (name: string) => (name === 'fork' ? b : undefined),
    defaultPublishChannel: a,
    defaultPublishMessageId: 'm-latest',
  });
  assert.equal(f.registry.incomingFor('scout'), undefined, 'a turn with no channel at all has none');
  const replyingTo = f.registry.incomingFor('fork');
  assert.deepEqual([replyingTo?.channel, replyingTo?.messageId], [a, 'm-latest']);
});

test("a fork's home is its channel on its server, and one kept as a bare id is read as a wake without its server is: the one registered channel with that id, or the home on no server", async (t) => {
  const { i } = await frameworkWith(t, ['slack', 'discord']);
  const map = (i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  map.set(destinationKey({ serverId: 'slack', channelId: 'lobby' }), {
    serverId: 'slack', descriptor: { id: 'lobby', type: 'chat', label: '#lobby' }, open: true,
  });
  const home = (stored: ChannelRef | string | undefined) =>
    (i as unknown as { channelOfHome(home: ChannelRef | string | undefined): ChannelRef | undefined }).channelOfHome(stored);
  assert.deepEqual(home({ serverId: 'discord', channelId: 'general' }), { serverId: 'discord', channelId: 'general' }, 'a home with its server is that channel');
  assert.deepEqual(home('lobby'), { serverId: 'slack', channelId: 'lobby' }, 'one server registers the id: its channel');
  assert.deepEqual(home('general'), { serverId: '', channelId: 'general' }, 'two servers do: the home on no server');
  assert.deepEqual(home('gone'), { serverId: '', channelId: 'gone' }, 'no server does: the home on no server');
  assert.equal(home(undefined), undefined, 'no home');
});

test('beforeInference gives each server its own channel context in place of the shared one', async (t) => {
  const sent: Array<{ server: string; channels: unknown }> = [];
  const server = (id: string) => ({
    id,
    grant: new CapabilityGrant(new Set(['contextHooks.beforeInference.observe']), []),
    sendBeforeInference: async (params: { channels?: unknown }) => {
      sent.push({ server: id, channels: params.channels });
      return { contextInjections: [] };
    },
  });
  const servers = [server('a'), server('b')];
  const orchestrator = new HookOrchestrator({ getAllServers: () => servers } as never, {} as never);
  await orchestrator.beforeInference(
    { inferenceId: 'i', conversationId: 'agent', turnIndex: 0, userMessage: null, model: { id: 'm' }, channels: { candidates: ['shared'] } } as never,
    (serverId) => (serverId === 'b' ? { defaultOutgoing: { channelId: 'general' } } : undefined),
  );
  assert.deepEqual(sent.sort((x, y) => x.server.localeCompare(y.server)), [
    { server: 'a', channels: undefined },
    { server: 'b', channels: { defaultOutgoing: { channelId: 'general' } } },
  ]);

  // A throw building one server's context fails that server alone, and says so.
  sent.length = 0;
  const logged = t.mock.method(console, 'error', () => {});
  await orchestrator.beforeInference(
    { inferenceId: 'i2', conversationId: 'agent', turnIndex: 0, userMessage: null, model: { id: 'm' } } as never,
    (serverId) => { if (serverId === 'a') throw new Error('no context for a'); return undefined; },
  );
  assert.deepEqual(sent.map((x) => x.server), ['b']);
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /the channel context for "a" couldn't be built/);
});

// ── Through the framework: a turn's channel carries its server ──

type FrameworkInternals = {
  initializeMcpl(servers: []): Promise<void>;
  channelRegistry: ChannelRegistry;
  mcplServerRegistry: McplServerRegistry;
  pendingRequests: InferenceRequest[];
  turnRouting: Map<string, { triggerChannel?: ChannelRef; locus?: ChannelRef }>;
};

/** A framework with a real channel registry, whose servers each register
 *  `general`, open, in the order given, and record what they're sent. */
async function frameworkWith(
  t: TestContext, order: string[], proseRouting?: 'explicit' | 'hybrid', refusesOn?: string, withGate?: boolean,
  agentOptions: { maxStreamTokens?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'af-shared-id-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', ...(proseRouting ? { proseRouting } : {}), ...agentOptions }],
    modules: [],
    ...(withGate ? { gate: { config: { policies: [], default: 'skip' as const } } } : {}),
  });
  // Stopped before its store's directory goes (the hooks run in the order added).
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const i = framework as unknown as FrameworkInternals;
  await i.initializeMcpl([]);
  const calls: string[] = [];
  const beforeInference: Array<{ server: string; channels: unknown }> = [];
  const servers = new Map(order.map((id) => [id, {
    id,
    isConnected: true,
    stopReconnecting() {},
    policyEstablished: true,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (p: { channelId: string; content: Array<{ text: string }> }) => {
      calls.push(`${id} publish ${p.channelId}: ${p.content[0]!.text}`);
      // A server named in refusesOn answers that nothing was posted.
      return id === refusesOn ? { delivered: false } : { delivered: true, messageId: `${id}-${calls.length}` };
    },
    sendChannelsTyping: (channelId: string, _metadata: unknown, op?: string) => {
      calls.push(`${id} typing${op === 'stop' ? '-stop' : ''} ${channelId}`);
    },
    sendChannelsOpen: async () => ({}),
    sendBeforeInference: async (p: { channels?: unknown }) => {
      beforeInference.push({ server: id, channels: p.channels });
      return { contextInjections: [] };
    },
  }]));
  t.mock.method(i.mcplServerRegistry, 'getServer', (id: string) => servers.get(id) as never);
  const map = (i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  for (const serverId of order) {
    map.set(destinationKey({ serverId, channelId: 'general' }), {
      serverId, descriptor: { id: 'general', type: 'chat', label: '#general' }, open: true,
    });
  }
  const notices = () => framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'routing-notice')
    .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
  // The hooks fan out to every server only where a test asks for it.
  const fanOutToServers = () => t.mock.method(i.mcplServerRegistry, 'getAllServers', () => [...servers.values()] as never);
  return { framework, membrane, calls, i, notices, beforeInference, fanOutToServers };
}

function incomingOn(serverId: string, text: string, metadata: Record<string, unknown> = {}): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId,
    channelId: 'general',
    messageId: `m-${serverId}-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'antra' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata,
    triggerInference: true,
  } as unknown as ProcessEvent;
}

for (const order of orders) {
  const registered = `registered ${order.join(' then ')}`;

  test(`a reply to a message on b's general goes to b, with typing there and the server named (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    // The traces that tag the turn and its text with its channel name it by
    // its id, a string, as trace consumers read it (connectome-host's
    // tts-relay takes a string only).
    const traced: Array<[string, unknown]> = [];
    const started: Array<{ channelId?: unknown; serverId?: unknown }> = [];
    f.framework.onTrace((e) => {
      if (e.type === 'inference:started' || e.type === 'inference:tokens' || e.type === 'inference:content_block') {
        traced.push([e.type, (e as { channelId?: unknown }).channelId]);
      }
      if (e.type === 'inference:started') started.push(e as { channelId?: unknown; serverId?: unknown });
    });
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the reply' }]));
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    assert.deepEqual(f.i.turnRouting.get('scout')?.locus, b);
    assert.ok(traced.some(([type]) => type === 'inference:tokens'), 'premise: the text was traced');
    assert.deepEqual(traced.filter(([, channelId]) => channelId !== 'general'), [], 'each trace names the channel by its id');
    // The stream's start names the channel's server too, so a host can post
    // back to the turn's channel where both servers register its id.
    assert.deepEqual(started.map((e) => [e.channelId, e.serverId]), [['general', 'b']]);
    assert.deepEqual(f.calls.filter((c) => c.includes('publish')), ['b publish general: the reply']);
    assert.ok(f.calls.some((c) => c === 'b typing general'), 'typing shows on b');
    assert.ok(!f.calls.some((c) => c.startsWith('a ')), 'a is sent nothing');
    assert.ok(f.notices().some((n) => n.includes('#general (b:general)')), "the routing notice names b's channel");
  });

  test(`explicit mode shows typing on the channel the wake came from, on its server (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit');
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    assert.ok(f.calls.includes('b typing general'), f.calls.join('\n'));
    assert.ok(!f.calls.some((c) => c.startsWith('a ')), 'a is sent nothing');
  });

  test(`explicit mode's typing stays where the wake came from at the turn's later start, though a channel_open moved its default channel (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit', undefined, false, { maxStreamTokens: 20 });
    // Round one opens a's general and crosses the stream's budget, so the
    // turn starts again, a start whose trigger names no channel.
    const overBudget = createMockResponse([
      { type: 'tool_use', id: 'open-a', name: 'channel_open', input: { channelId: 'a:general' } },
    ] as never, 'tool_use');
    overBudget.usage = { inputTokens: 100, outputTokens: 5 };
    f.membrane.pushResponse(overBudget);
    // The restart's response is queued when it starts, so the stream it
    // replaces can't take it.
    let starts = 0;
    const traced: unknown[] = [];
    f.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started' && ++starts === 2) {
        f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
      }
      const t = e as { type: string; blockType?: string; channelId?: unknown };
      if (t.type === 'inference:tokens' && t.blockType === 'text') traced.push(t.channelId);
    });
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    assert.equal(starts, 2, 'control: the turn started again for its budget');
    assert.deepEqual(f.i.turnRouting.get('scout')?.triggerChannel, a, "control: the open moved the turn's default channel");
    assert.ok(f.calls.includes('b typing general'), f.calls.join('\n'));
    assert.ok(!f.calls.includes('a typing general'), `typing never shows in the opened channel: ${f.calls.join('\n')}`);
    // The restart's own trigger names no channel: it keeps what the turn
    // shows, and its text's traces name it.
    assert.ok(traced.length > 0, "control: the restart's text was traced");
    assert.deepEqual([...new Set(traced)], ['general'], "the restart's traces name the channel its typing shows");
    assert.deepEqual((f.i.turnRouting.get('scout') as { typing?: ChannelRef } | undefined)?.typing, b);
  });

  test(`a >> target a shared id names bounces, with its candidates and an example built from them (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit');
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>general hello' }]));
    // The bounce wakes the agent again, and it lets the draft be.
    let starts = 0;
    f.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started' && ++starts >= 2) {
        f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
      }
    });
    // A turn no message triggered: none of its own channels has the id.
    f.framework.nudgeAgent('scout', 'a nudge with no channel');
    await f.framework.runUntilIdle();
    const bounces = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce')
      .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
    assert.equal(bounces.length, 1, bounces.join('\n'));
    assert.ok(bounces[0]!.includes(`Known channels it could mean: ${order.map((s) => `${s}:general`).join(', ')}.`), bounces[0]);
    assert.ok(bounces[0]!.includes(`">>${order[0]}:general {{unsent}}"`), 'the example names a candidate as a target takes it');
    assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [], 'nothing was posted');
  });

  test(`a >> target the id of the channel the turn's message came from goes there, on its server, though the other server has the id too (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit');
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>general hello b' }]));
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    assert.deepEqual(f.calls.filter((c) => c.includes('publish')), ['b publish general: hello b'], f.calls.join('\n'));
  });

  test(`a turn replying on b's general tells each server only of its own channels, through the framework's hook (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    f.fanOutToServers();
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello b' }]));
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    // The turn's own channel, by the framework's callback: b's general.
    const told = new Map(f.beforeInference.map((x) => [x.server, x.channels as { incoming?: unknown; defaultOutgoing?: unknown } | undefined]));
    assert.ok(told.has('a') && told.has('b'), 'both servers were asked');
    assert.deepEqual(told.get('b')?.defaultOutgoing, { channelId: 'general' }, 'b is told the turn speaks in its general');
    assert.equal(told.get('a')?.defaultOutgoing, undefined, "a isn't told that its general is the turn's");
  });

  test(`a batch's turn takes its channel and that channel's server from one request (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    const [ambient, addressed] = order as [string, string];
    // Ambient chatter on one server's general, then an addressed message on
    // the other's: the addressed one is the turn's channel, with its server.
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'on it' }]));
    const now = Date.now();
    f.i.pendingRequests.push(
      { agentName: 'scout', reason: 'chatter', source: 'mcpl', timestamp: now, channelId: 'general', channelServerId: ambient },
      { agentName: 'scout', reason: 'mention', source: 'mcpl', timestamp: now + 1, channelId: 'general', channelServerId: addressed, addressed: true },
    );
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 1, 'the two requests ran as one turn');
    assert.deepEqual(f.i.turnRouting.get('scout')?.triggerChannel, { serverId: addressed, channelId: 'general' });
    assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [`${addressed} publish general: on it`]);
  });

  test(`a bounce whose candidates aren't one token each gives the generic example (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit');
    // One person's DMs on two servers, labelled apart: listed by their labels, which hold spaces.
    const map = (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
    for (const [serverId, label] of [['a', 'DM: antra (work)'], ['b', 'DM: antra (home)']] as const) {
      map.set(destinationKey({ serverId, channelId: `dm-${serverId}` }), {
        serverId, descriptor: { id: `dm-${serverId}`, type: 'chat', label, metadata: { channelType: 'dm', recipientName: 'antra' } }, open: true,
      });
    }
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>@antra hello' }]));
    let starts = 0;
    f.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started' && ++starts >= 2) {
        f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
      }
    });
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    const bounce = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce')
      .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text))[0] ?? '';
    assert.ok(bounce.includes('DM: antra (work)'), bounce);
    assert.ok(bounce.includes('">>#<channel> {{unsent}}"'), 'no candidate is one token, so the example is generic');
    assert.ok(bounce.includes('">>@<person> {{unsent}}"'), 'and the DM example a placeholder too');
    assert.ok(!bounce.includes('For a channel shown by its id and server'), 'no candidate is shown by its id and server');
  });

  test(`a bounce that shows a candidate by its id and server says which tool reaches it (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit');
    // Two servers' channels labelled alike, whose ids don't show as themselves.
    const map = (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
    for (const serverId of ['a', 'b'] as const) {
      map.set(destinationKey({ serverId, channelId: `gen"${serverId}` }), {
        serverId, descriptor: { id: `gen"${serverId}`, type: 'chat', label: '#lounge' }, open: true,
      });
    }
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>#lounge hello' }]));
    let starts = 0;
    f.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started' && ++starts >= 2) {
        f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
      }
    });
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    const bounce = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce')
      .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text))[0] ?? '';
    assert.ok(bounce.includes('"gen\\"a" on server "a"'), bounce);
    assert.ok(bounce.includes('channel_publish reaches "gen\\"a" on server "a" with channelId "a:gen\\"a"'), bounce);
    assert.ok(!bounce.includes('serverId'), 'channel_publish takes no serverId, so the bounce names none');
  });

  test(`a >> delivery that fails names the channel it was for apart, in its bounce (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'explicit', 'b');
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>b:general hello' }]));
    let starts = 0;
    f.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started' && ++starts >= 2) {
        f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
      }
    });
    f.framework.pushEvent(incomingOn('b', 'hello from b'));
    await f.framework.runUntilIdle();
    const bounces = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce')
      .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
    assert.ok(bounces.some((b) => b.includes('delivery to b:general failed')), bounces.join('\n'));
  });

  test(`a >>> delivery that fails names the channel it was for apart, in its bounce (${registered})`, async (t) => {
    const f = await frameworkWith(t, order, 'hybrid', 'b');
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>b:general hello' }]));
    let starts = 0;
    f.framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started' && ++starts >= 2) {
        f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply' }]));
      }
    });
    f.framework.pushEvent(incomingOn('a', 'hello from a'));
    await f.framework.runUntilIdle();
    const bounces = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce')
      .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
    assert.ok(bounces.some((b) => b.includes('delivery to b:general failed')), bounces.join('\n'));
  });

  test(`a wake naming a shared id without its server gives the turn no channel, and takes no fallback (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    // The last delivered message is on a's general, so a fallback would go there.
    Object.assign(f.i.channelRegistry as unknown as { defaultPublishChannel: ChannelRef; defaultPublishMessageId: string },
      { defaultPublishChannel: a, defaultPublishMessageId: 'm-latest' });
    f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'for which general?' }]));
    f.i.pendingRequests.push({ agentName: 'scout', reason: 'host:nudge', source: 'host', timestamp: Date.now(), channelId: 'general' });
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 1, 'the wake ran one turn');
    assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [], 'nothing is published on either server');
    // Nor is the fallback what the registry resolves for the turn, or what
    // the fallback's server is told the turn's outgoing channel is.
    assert.equal(f.i.channelRegistry.resolveLocus('scout'), null);
    assert.equal(f.i.channelRegistry.buildChannelContext('scout', 'a')?.defaultOutgoing, undefined);
    // Nor is it replying to the latest inbound message, wherever that was.
    assert.equal(f.i.channelRegistry.buildChannelContext('scout', 'a')?.incoming, undefined);
    assert.equal(f.i.channelRegistry.incomingFor('scout'), undefined);
  });
}

test("a bounce's example skips a candidate written skip_reply, which a >> line reads as private speech", async (t) => {
  const f = await frameworkWith(t, ['a', 'b'], 'explicit');
  // Two channels labelled #lounge: a's has the id skip_reply, b's lounge-2.
  const map = (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  for (const [serverId, channelId] of [['a', 'skip_reply'], ['b', 'lounge-2']] as const) {
    map.set(destinationKey({ serverId, channelId }), { serverId, descriptor: { id: channelId, type: 'chat', label: '#lounge' }, open: true });
  }
  f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>#lounge hello' }]));
  let starts = 0;
  f.framework.onTrace((e) => {
    if ((e as { type: string }).type === 'inference:started' && ++starts >= 2) {
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
    }
  });
  f.framework.pushEvent(incomingOn('b', 'hello from b'));
  await f.framework.runUntilIdle();
  const bounce = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'prose-bounce')
    .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text))[0] ?? '';
  assert.ok(bounce.includes('Known channels it could mean: skip_reply, lounge-2.'), bounce);
  assert.ok(bounce.includes('e.g. ">>lounge-2 {{unsent}}"'), bounce);
});

test("explicit mode's typing reads each start's own wake, and a turn that has no channel reads only a wake that gives its server", async (t) => {
  const f = await frameworkWith(t, ['a', 'b'], 'explicit');
  const typingFor = (routing: Record<string, unknown>, trigger: Partial<InferenceRequest> | undefined) =>
    (f.framework as unknown as { explicitTypingChannel(r: unknown, t: unknown): ChannelRef | null }).explicitTypingChannel(routing, trigger);
  // The start's own trigger, with its server, whatever the turn's trigger channel became.
  assert.deepEqual(typingFor({ triggerChannel: a }, { channelId: 'general', channelServerId: 'b' }), b);
  assert.equal(typingFor({ triggerChannel: a }, { reason: 'context_budget_restart' }), null, 'a start whose trigger names no channel, in a turn that has shown none');
  assert.deepEqual(typingFor({ typing: b }, { reason: 'context_budget_restart' }), b, 'keeps the channel the turn already shows');
  assert.deepEqual(typingFor({ typing: b }, { channelId: 'general', channelServerId: 'a' }), a,
    "a start's own wake comes before the channel the turn shows");
  // A turn that has no channel doesn't read a wake that gives no server,
  // though its wake's name now means one channel (b's general went
  // meanwhile); it keeps what the turn shows, here none.
  (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.delete(destinationKey(b));
  assert.deepEqual(typingFor({}, { channelId: 'general' }), a, "control: the name means a's general now");
  assert.equal(typingFor({ noChannel: true }, { channelId: 'general' }), null);
  // A later start's wake that gives its server, as the framework's own do, names that pair.
  assert.deepEqual(typingFor({ noChannel: true }, { channelId: 'general', channelServerId: 'a' }), a);
});

test("explicit mode's typing is read once as a start opens, so registrations that move during its hooks don't move it", async (t) => {
  const f = await frameworkWith(t, ['a', 'b'], 'explicit');
  f.fanOutToServers();
  const map = (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  // Only a registers general as the start opens, so the host's bare id means a's.
  const bEntry = map.get(destinationKey(b));
  map.delete(destinationKey(b));
  // While the start's hooks run, a's general goes and b's comes.
  let moved = false;
  for (const id of ['a', 'b']) {
    const server = f.i.mcplServerRegistry.getServer(id) as unknown as { sendBeforeInference(p: unknown): Promise<unknown> };
    const told = server.sendBeforeInference.bind(server);
    server.sendBeforeInference = async (p) => {
      if (!moved) { moved = true; map.delete(destinationKey(a)); map.set(destinationKey(b), bEntry); }
      return told(p);
    };
  }
  f.membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
  f.i.pendingRequests.push({ agentName: 'scout', reason: 'host:nudge', source: 'host', timestamp: Date.now(), channelId: 'general' });
  await f.framework.runUntilIdle();
  assert.ok(moved, "control: the registrations moved during the start's hooks");
  assert.ok(f.calls.includes('a typing general'), `the start showed typing in a's general: ${f.calls.join('\n')}`);
  assert.ok(!f.calls.includes('b typing general'), `nor did its stream move it to b's: ${f.calls.join('\n')}`);
});

test("a push's Discord channel, composed from its origin, is registered for the server that sent it, and its reply goes back there", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const map = (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  // b holds the composed id already, labelled as its own.
  map.set(destinationKey({ serverId: 'b', channelId: 'discord:g1:c1' }), {
    serverId: 'b', descriptor: { id: 'discord:g1:c1', type: 'chat', label: "b's channel" }, open: true,
  });
  f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the reply' }]));
  (f.framework as unknown as { handleMcplPushEvent(e: unknown): unknown }).handleMcplPushEvent({
    type: 'mcpl:push-event', serverId: 'a', featureSet: 'discord', eventId: 'e1', inferenceId: 'i1',
    timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'pushed from a' }],
    origin: { source: 'discord', guildId: 'g1', channelId: 'c1', channelName: 'general (a)' },
    tags: ['chat:addressed'], triggerInference: true,
  });
  assert.equal(f.i.channelRegistry.getDescriptor({ serverId: 'a', channelId: 'discord:g1:c1' })?.label, 'general (a)',
    'registered for a, which sent the push');
  assert.equal(f.i.channelRegistry.getDescriptor({ serverId: 'b', channelId: 'discord:g1:c1' })?.label, "b's channel", "b's is untouched");
  await f.framework.runUntilIdle();
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')), ['a publish discord:g1:c1: the reply'], 'the reply goes back through a');
  assert.ok(!f.calls.some((c) => c.startsWith('b ')), 'b is sent nothing');
});

test("a message moves the turn's locus to its own server's channel, by the server its metadata carries", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const repin = (m: Record<string, unknown>, routing: { engaged: Set<string> }) =>
    (f.framework as unknown as { repinChannel(m: unknown, r: unknown): ChannelRef | undefined }).repinChannel(m, routing);
  const routing = { engaged: new Set([destinationKey(b)]), wasIn: [] as ChannelRef[] };
  assert.deepEqual(repin({ channelId: 'general', serverId: 'a', tags: ['chat:addressed'] }, routing), a, 'an addressed message');
  assert.deepEqual(repin({ channelId: 'general', serverId: 'b' }, routing), b, 'a follow-up where the turn sent');
  assert.equal(repin({ channelId: 'general', serverId: 'a' }, routing), undefined, "a's channel wasn't sent into, though it shares b's id");
  assert.equal(repin({ channelId: 'general', tags: ['chat:addressed'] }, routing), undefined, 'no server, and two channels with that id');
});

test("a gate wake's route goes to a fork only where it's the fork's own home, on its server", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const fw = f.framework as unknown as {
    registry: { register(spec: ReturnType<typeof conversationForkSpec>): unknown };
    mayTakeGateRoute(agentName: string, route: ChannelRef): boolean;
  };
  fw.registry.register(conversationForkSpec('fork-a', { template: 'scout', homeChannel: a, idleTtlMs: 60_000 }));
  assert.equal(fw.mayTakeGateRoute('fork-a', a), true, "the fork's home");
  assert.equal(fw.mayTakeGateRoute('fork-a', b), false, "b's general is another channel, though it shares the id");
  assert.equal(fw.mayTakeGateRoute('scout', a), false, "a's general is the fork's conversation");
  assert.equal(fw.mayTakeGateRoute('scout', b), true, "b's general isn't bound to a fork");
});

test("what an agent is told of a destination or a channel names it apart where its id is shared", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const fw = f.framework as unknown as {
    destinationText(d: ChannelRef & { label?: string }): string;
    recordReplyOpenFailedNotice(agent: string, serverId: string, channel: { channelId: string; label?: string }, selected?: 'subscription-policy'): void;
  };
  assert.equal(fw.destinationText({ ...b, label: '#general' }), '#general (b:general)');
  // A fork's channel_close is refused for any channel but its home: a
  // notice offers it only for that one, on its server.
  t.after(bindAsConversationFork(f.framework, 'scout', a));
  fw.recordReplyOpenFailedNotice('scout', b.serverId, { channelId: b.channelId, label: '#general' }, 'subscription-policy');
  fw.recordReplyOpenFailedNotice('scout', a.serverId, { channelId: a.channelId, label: '#general' }, 'subscription-policy');
  const notices = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'channel-notice')
    .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
  assert.equal(notices.length, 2, notices.join('\n'));
  assert.ok(notices[0]!.includes('#general (b:general)') && !notices[0]!.includes('channel_close'), notices[0]);
  assert.ok(notices[1]!.includes('#general (a:general)') && notices[1]!.includes('channel_close withdraws that'), notices[1]);
});

test("a resend to a shared id lists its candidates in registration order, and one named alone that takes no posts is refused before anything is sent", async (t) => {
  const f = await frameworkWith(t, ['b', 'a']);
  const fw = f.framework as unknown as {
    proseDrafts: { hold(agent: string, segments: Array<{ text: string }>, reason: 'bounced'): { held: Array<{ id: string }> } };
    handleDraftsTool(agent: string, input: unknown): Promise<unknown>;
  };
  (f.i.channelRegistry as unknown as { channels: Map<string, { descriptor: { direction?: string } }> }).channels
    .get(destinationKey(b))!.descriptor.direction = 'inbound';
  const [draft] = fw.proseDrafts.hold('scout', [{ text: 'held words' }], 'bounced').held;
  const refused = ((await fw.handleDraftsTool('scout', { action: 'resend', draftIds: [draft!.id], destination: 'general' })) as
    { error?: string }).error ?? '';
  assert.ok(refused.includes('It could mean: b:general, a:general.'), refused);
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [], 'nothing was sent');
  // Named alone, it's refused at its destination, as a >> target is, before anything is sent.
  const alone = ((await fw.handleDraftsTool('scout', { action: 'resend', draftIds: [draft!.id], destination: 'b:general' })) as
    { error?: string }).error ?? '';
  assert.match(alone, /^Destination "b:general" did not resolve: b:general is .+ Nothing was sent\.$/s);
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [], 'nothing was sent');
});

test("a fork's resend goes home on its server, and another server's channel with that id is refused, both named apart", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const fw = f.framework as unknown as {
    proseDrafts: { hold(agent: string, segments: Array<{ text: string }>, reason: 'bounced'): { held: Array<{ id: string }> } };
    handleDraftsTool(agent: string, input: unknown): Promise<unknown>;
  };
  t.after(bindAsConversationFork(f.framework, 'scout', b));
  const [draft] = fw.proseDrafts.hold('scout', [{ text: 'held words' }], 'bounced').held;
  const refused = ((await fw.handleDraftsTool('scout', { action: 'resend', draftIds: [draft!.id], destination: 'a:general' })) as
    { error?: string }).error ?? '';
  assert.ok(refused.includes('This conversation is bound to channel "b:general"; resending to "a:general" is not allowed.'), refused);
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [], 'nothing was sent');
  await fw.handleDraftsTool('scout', { action: 'resend', draftIds: [draft!.id] });
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')), ['b publish general: held words']);
  // The shared id its home answers to means its home, as in its channel tools.
  const [again] = fw.proseDrafts.hold('scout', [{ text: 'more words' }], 'bounced').held;
  await fw.handleDraftsTool('scout', { action: 'resend', draftIds: [again!.id], destination: 'general' });
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')).at(-1), 'b publish general: more words');
  // So does its qualified name, though another server's channel has that as its id.
  (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'x', channelId: 'b:general' }), {
    serverId: 'x', descriptor: { id: 'b:general', type: 'chat', label: "x's b:general" }, open: true,
  });
  const [third] = fw.proseDrafts.hold('scout', [{ text: 'by its full name' }], 'bounced').held;
  await fw.handleDraftsTool('scout', { action: 'resend', draftIds: [third!.id], destination: 'b:general' });
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')).at(-1), 'b publish general: by its full name');
});

test("the gate's batched summary names a channel as the registry shows it, through the framework's wiring", async (t) => {
  const f = await frameworkWith(t, ['a', 'b'], undefined, undefined, true);
  const gate = (f.framework as unknown as { eventGate: { channelShownFn?: (c: ChannelRef) => string } | null }).eventGate;
  assert.ok(gate, 'the framework built its gate');
  assert.equal(gate!.channelShownFn?.(b), 'b:general');
  assert.equal(gate!.channelShownFn?.({ serverId: 'a', channelId: 'elsewhere' }), 'elsewhere');
});

test("two servers' wakes on one channel id at one moment are two wakes to a provider hold's dedup", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const same = (f.framework as unknown as { sameInferenceRequest(x: InferenceRequest, y: InferenceRequest): boolean })
    .sameInferenceRequest.bind(f.framework);
  const wake = (channelServerId: string): InferenceRequest =>
    ({ agentName: 'scout', reason: 'mention', source: 'mcpl', timestamp: 1, channelId: 'general', channelServerId });
  assert.equal(same(wake('a'), wake('a')), true);
  assert.equal(same(wake('a'), wake('b')), false, "b's wake isn't a's");
});

/** Wait for an event the test is about, failing after a deadline rather than passing on a fixed sleep. */
async function until(condition: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type ToolResult = { success: boolean; data?: unknown; error?: string };

/** The tool results the framework pushes, by call id, kept from its queue. */
function toolResults(t: TestContext, framework: AgentFramework): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  const push = framework.pushEvent.bind(framework);
  t.mock.method(framework, 'pushEvent', (event: ProcessEvent) => {
    const e = event as unknown as { type: string; callId: string; result: ToolResult };
    if (e.type === 'tool-result') results.set(e.callId, e.result);
    else push(event);
  });
  return results;
}

type Dispatcher = (agentName: string, call: { id: string; name: string; input: Record<string, unknown> }) => void;

for (const order of orders) {
  const registered = `registered ${order.join(' then ')}`;

  test(`a fork homed on b's general publishes there by the bare id, and a's channel is foreign to it (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    bindAsConversationFork(f.framework, 'scout', b);
    const results = toolResults(t, f.framework);
    const dispatch = (f.framework as unknown as { dispatchChannelToolCall: Dispatcher }).dispatchChannelToolCall.bind(f.framework);

    // A fork acts only on its home, so the id its home answers to means its home.
    dispatch('scout', { id: 'home', name: 'channel_publish', input: { channelId: 'general', content: 'to my home' } });
    await until(() => results.has('home'), 'the home publish');
    assert.equal(results.get('home')?.success, true);
    dispatch('scout', { id: 'qualified', name: 'channel_publish', input: { channelId: 'b:general', content: 'by its full name' } });
    await until(() => results.has('qualified'), 'the qualified publish');
    dispatch('scout', { id: 'id-server', name: 'channel_publish', input: { channelId: 'general', serverId: 'b', content: 'and its server' } });
    await until(() => results.has('id-server'), 'the publish by its id and server');
    // A serverId beside a channelId names that exact pair, which a qualified
    // name with its own server isn't, and the fork is told the name works alone.
    dispatch('scout', { id: 'qualified-server', name: 'channel_publish', input: { channelId: 'b:general', serverId: 'b', content: 'not this' } });
    assert.equal(results.get('qualified-server')?.error,
      '"b:general" names this conversation\'s channel by itself, so nothing was posted: call again with serverId left out.');
    dispatch('scout', { id: 'close-qualified-server', name: 'channel_close', input: { channelId: 'b:general', serverId: 'b' } });
    assert.equal(results.get('close-qualified-server')?.error,
      '"b:general" names this conversation\'s channel by itself, so nothing was closed: call again with serverId left out.');
    // Beside another server's id it names that server's channel, foreign to the fork.
    dispatch('scout', { id: 'qualified-a', name: 'channel_publish', input: { channelId: 'b:general', serverId: 'a', content: 'not this' } });
    assert.equal(results.get('qualified-a')?.error,
      'This conversation is bound to channel "b:general"; publishing to "b:general" on server "a" is not allowed.');
    // The home's own serverId alone names the home.
    dispatch('scout', { id: 'server-b', name: 'channel_publish', input: { serverId: 'b', content: 'by its server' } });
    await until(() => results.has('server-b'), 'the publish by its server alone');
    // An empty serverId is none given, as the channel tools read it.
    dispatch('scout', { id: 'empty-server', name: 'channel_publish', input: { channelId: 'general', serverId: '', content: 'empty server' } });
    await until(() => results.has('empty-server'), 'the publish with an empty serverId');
    assert.equal(results.get('empty-server')?.success, true, results.get('empty-server')?.error);
    dispatch('scout', { id: 'empty-alone', name: 'channel_publish', input: { serverId: '', content: 'empty server alone' } });
    await until(() => results.has('empty-alone'), 'the publish with only an empty serverId');
    // No channelId at all means the home, not the registry's default channel.
    dispatch('scout', { id: 'no-channel', name: 'channel_publish', input: { content: 'no channel given' } });
    await until(() => results.has('no-channel'), 'the publish with no channelId');
    dispatch('scout', { id: 'foreign-empty', name: 'channel_publish', input: { channelId: 'a:general', serverId: '', content: 'elsewhere' } });
    assert.equal(results.get('foreign-empty')?.error,
      'This conversation is bound to channel "b:general"; publishing to "a:general" is not allowed.');
    // What was asked is quoted as an id is, escapes included.
    dispatch('scout', { id: 'odd-server', name: 'channel_publish', input: { channelId: 'general', serverId: 'x"y', content: 'elsewhere' } });
    assert.equal(results.get('odd-server')?.error,
      'This conversation is bound to channel "b:general"; publishing to "general" on server "x\\"y" is not allowed.');

    dispatch('scout', { id: 'foreign', name: 'channel_publish', input: { channelId: 'a:general', content: 'elsewhere' } });
    assert.equal(results.get('foreign')?.error,
      'This conversation is bound to channel "b:general"; publishing to "a:general" is not allowed.');
    // A serverId the call gives has to be the home's, with a channelId or without.
    dispatch('scout', { id: 'server-only', name: 'channel_publish', input: { serverId: 'a', content: 'elsewhere' } });
    assert.equal(results.get('server-only')?.error,
      'This conversation is bound to channel "b:general"; publishing to a channel on server "a" is not allowed.');
    dispatch('scout', { id: 'id-on-a', name: 'channel_publish', input: { channelId: 'general', serverId: 'a', content: 'elsewhere' } });
    assert.equal(results.get('id-on-a')?.error,
      'This conversation is bound to channel "b:general"; publishing to "general" on server "a" is not allowed.');
    // Nor may it close the other server's channel with its home's id, as
    // channel_close's serverId would pick it (anima-research/agent-framework#612).
    dispatch('scout', { id: 'close-on-a', name: 'channel_close', input: { channelId: 'general', serverId: 'a' } });
    assert.equal(results.get('close-on-a')?.error,
      'This conversation is bound to channel "b:general"; closing "general" on server "a" is not allowed.');
    assert.notEqual(f.i.channelRegistry.getDesiredState('a', 'general'), 'closed', "no close of a's channel was decided");
    assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [
      'b publish general: to my home', 'b publish general: by its full name', 'b publish general: and its server',
      'b publish general: by its server', 'b publish general: empty server', 'b publish general: empty server alone',
      'b publish general: no channel given',
    ], 'nothing was posted on a');
    // Where the pair a call gives is another registered channel, one whose id
    // is the home's qualified name, it's that channel, foreign to the fork.
    (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'x', channelId: 'b:general' }), {
      serverId: 'x', descriptor: { id: 'b:general', type: 'chat', label: "x's b:general" }, open: true,
    });
    dispatch('scout', { id: 'x-pair', name: 'channel_publish', input: { channelId: 'b:general', serverId: 'x', content: 'to x' } });
    assert.equal(results.get('x-pair')?.error,
      'This conversation is bound to channel "general" on server "b"; publishing to "b:general" on server "x" is not allowed.');
    // With no serverId, a name its home answers to still means its home.
    dispatch('scout', { id: 'qualified-beside-x', name: 'channel_publish', input: { channelId: 'b:general', content: 'home again' } });
    await until(() => results.has('qualified-beside-x'), 'the qualified publish beside x');
    assert.equal(results.get('qualified-beside-x')?.success, true);
    assert.ok(f.calls.includes('b publish general: home again'), f.calls.join('\n'));
    // Where the home's own server registers a channel whose id is the home's
    // qualified name, the pair is that channel, foreign to the fork, and
    // nothing tells the fork to leave the serverId out.
    (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.set(destinationKey({ serverId: 'b', channelId: 'b:general' }), {
      serverId: 'b', descriptor: { id: 'b:general', type: 'chat', label: "b's b:general" }, open: true,
    });
    dispatch('scout', { id: 'b-pair', name: 'channel_publish', input: { channelId: 'b:general', serverId: 'b', content: 'to b:general' } });
    assert.equal(results.get('b-pair')?.error,
      'This conversation is bound to channel "general" on server "b"; publishing to "b:general" on server "b" is not allowed.');
    // A home no name picks now is quoted as its id and server.
    dispatch('scout', { id: 'open', name: 'channel_open', input: { channelId: 'elsewhere' } });
    assert.equal(results.get('open')?.error, 'This conversation is bound to channel "general" on server "b", so it can\'t open ' +
      'other channels, and nothing was opened. Reply in "general" on server "b".');
  });

  test(`tune_out refuses a shared id with its candidates, and takes one server's channel by its qualified name (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    const entered: string[] = [];
    (f.framework as unknown as { tuneOutCoordinator: unknown }).tuneOutCoordinator = {
      enter: (serverId: string, channelId: string) => {
        entered.push(`${serverId} ${channelId}`);
        return { ok: true, params: { cadenceSeconds: 300, backlogCap: 50, maxWakes: 3 } };
      },
      cancel: (serverId: string, channelId: string) => { entered.push(`cancel ${serverId} ${channelId}`); return { ok: true }; },
      hasReader: () => true,
      stop: () => {},
    };
    // The tune-out's transport is another test's (tune-out-transport): here
    // it opens at once, so the answer names only the channel and settings.
    const opened: string[] = [];
    (f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> })
      .openForTuneOut = async (serverId: string, channelId: string) => { opened.push(`${serverId} ${channelId}`); return undefined; };
    const results = toolResults(t, f.framework);
    const dispatch = (f.framework as unknown as { dispatchTuneOutToolCall: Dispatcher }).dispatchTuneOutToolCall.bind(f.framework);

    // Every answer, a refusal too, comes once the handler's body settles.
    const answered = async (id: string) => { for (let i = 0; i < 20 && !results.has(id); i++) await new Promise((r) => setImmediate(r)); };
    dispatch('scout', { id: 'shared', name: 'tune_out', input: { channelId: 'general' } });
    await answered('shared');
    // tune_out takes a serverId, so the refusal offers one.
    assert.equal(results.get('shared')?.error,
      `Channel "general" is on more than one server (${order.map((s) => `"${s}:general"`).join(', ')}), so nothing ran. ` +
        `Call again with channelId set to one of them, or with serverId set to ${order.map((s) => `"${s}"`).join(' or ')}.`);
    dispatch('scout', { id: 'one', name: 'tune_out', input: { channelId: 'b:general' } });
    // A tune-out's answer waits for its transport (openForTuneOut).
    for (let i = 0; i < 20 && !results.has('one'); i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(results.get('one')?.data, { tunedOut: 'b:general', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3 },
      'the result names the channel as the agent can name it back');
    dispatch('scout', { id: 'cancel', name: 'tune_out', input: { channelId: 'b:general', mode: 'cancel' } });
    await answered('cancel');
    assert.deepEqual(results.get('cancel')?.data, { cancelled: 'b:general' });
    assert.deepEqual(entered, ['b general', 'cancel b general']);
    assert.deepEqual(opened, ['b general'], "the tune-out's transport is opened on b's channel");
    // A cancel by id and server takes that server's channel: the form the
    // tuned-out refusals give for a channel no name picks alone.
    dispatch('scout', { id: 'pair', name: 'tune_out', input: { channelId: 'general', serverId: 'a', mode: 'cancel' } });
    await answered('pair');
    assert.equal(results.get('pair')?.error, undefined);
    assert.deepEqual(entered.at(-1), 'cancel a general');
  });

  test(`tune_out inside the turn reads the id of the turn's own channel as that channel, and refuses it once its server withdrew it (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    const entered: string[] = [];
    (f.framework as unknown as { tuneOutCoordinator: unknown }).tuneOutCoordinator = {
      enter: (serverId: string, channelId: string) => {
        entered.push(`${serverId} ${channelId}`);
        return { ok: true, params: { cadenceSeconds: 300, backlogCap: 50, maxWakes: 3 } };
      },
      cancel: () => ({ ok: true }),
      hasReader: () => true,
      stop: () => {},
    };
    (f.i.channelRegistry as unknown as { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> })
      .openForTuneOut = async () => undefined;
    const results = toolResults(t, f.framework);
    const dispatch = (f.framework as unknown as { dispatchTuneOutToolCall: Dispatcher }).dispatchTuneOutToolCall.bind(f.framework);
    // The turn answers a message in b's general.
    (f.framework as unknown as { turnRouting: Map<string, unknown> }).turnRouting.set('scout', {
      turnId: 9, wasIn: [{ serverId: 'b', channelId: 'general' }], triggerChannel: { serverId: 'b', channelId: 'general' }, engaged: new Set(),
    });
    dispatch('scout', { id: 'own', name: 'tune_out', input: { channelId: 'general' }, callerTurnId: 9 } as never);
    for (let i = 0; i < 20 && !results.has('own'); i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(results.get('own')?.data, { tunedOut: 'b:general', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3 },
      "the turn's own channel, not a shared-id refusal");
    await (f.i.channelRegistry as unknown as ChannelRegistry).handleChanged('b', { removed: ['general'] });
    dispatch('scout', { id: 'gone', name: 'tune_out', input: { channelId: 'general' }, callerTurnId: 9 } as never);
    for (let i = 0; i < 20 && !results.has('gone'); i++) await new Promise((r) => setImmediate(r));
    assert.equal(results.get('gone')?.error, '"general" is this turn\'s channel on server "b", which no longer registers it, so nothing ran, '
      + 'and nothing can run on it until that server registers it again.');
    assert.deepEqual(entered, ['b general'], "a's general isn't taken for it");
  });

  test(`tune_out's answer names the channel as it's named once its transport opened, though another server registered its id meanwhile (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    const reg = f.i.channelRegistry as unknown as ChannelRegistry & { openForTuneOut(serverId: string, channelId: string): Promise<string | undefined> };
    await reg.handleRegister('a', { channels: [{ id: 'solo', type: 'chat', label: 'solo', direction: 'bidirectional' }] } as never);
    (f.framework as unknown as { tuneOutCoordinator: unknown }).tuneOutCoordinator = {
      enter: () => ({ ok: true, params: { cadenceSeconds: 300, backlogCap: 50, maxWakes: 3 } }),
      cancel: () => ({ ok: true }),
      hasReader: () => true,
      stop: () => {},
    };
    reg.openForTuneOut = async () => {
      await reg.handleRegister('b', { channels: [{ id: 'solo', type: 'chat', label: 'solo', direction: 'bidirectional' }] } as never);
      return undefined;
    };
    const results = toolResults(t, f.framework);
    const dispatch = (f.framework as unknown as { dispatchTuneOutToolCall: Dispatcher }).dispatchTuneOutToolCall.bind(f.framework);
    dispatch('scout', { id: 'solo', name: 'tune_out', input: { channelId: 'solo' } });
    for (let i = 0; i < 20 && !results.has('solo'); i++) await new Promise((r) => setImmediate(r));
    assert.equal((results.get('solo')?.data as { tunedOut?: string } | undefined)?.tunedOut, 'a:solo');
  });

  test(`tune_out repeated while its transport is closed answers once it opens, naming the channel as it's named then (${registered})`, async (t) => {
    const f = await frameworkWith(t, order);
    const reg = f.i.channelRegistry as unknown as ChannelRegistry & {
      openForTuneOut(serverId: string, channelId: string): Promise<string | undefined>;
      getTuneOutState(serverId: string, channelId: string): unknown;
      tuneOutTransportOpen(serverId: string, channelId: string): boolean;
    };
    await reg.handleRegister('a', { channels: [{ id: 'solo', type: 'chat', label: 'solo', direction: 'bidirectional' }] } as never);
    const params = { epochId: 'e1', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3, startedAtSequence: 0 };
    (f.framework as unknown as { tuneOutCoordinator: unknown }).tuneOutCoordinator = {
      enter: () => ({ ok: false, error: 'already', alreadyTunedOut: true }),
      cancel: () => ({ ok: true }),
      stop: () => {},
    };
    reg.getTuneOutState = () => ({ params, wakeCount: 0 });
    reg.tuneOutTransportOpen = () => false;
    reg.openForTuneOut = async () => {
      await reg.handleRegister('b', { channels: [{ id: 'solo', type: 'chat', label: 'solo', direction: 'bidirectional' }] } as never);
      return undefined;
    };
    const results = toolResults(t, f.framework);
    const dispatch = (f.framework as unknown as { dispatchTuneOutToolCall: Dispatcher }).dispatchTuneOutToolCall.bind(f.framework);
    dispatch('scout', { id: 'again', name: 'tune_out', input: { channelId: 'solo' } });
    for (let i = 0; i < 20 && !results.has('again'); i++) await new Promise((r) => setImmediate(r));
    assert.match(results.get('again')?.error ?? '', /^Nothing changed in the tune-out: "a:solo" is already tuned out, /);
  });

  test(`tune_out repeated on one server's channel of a shared id says it's already tuned out, naming it as the agent names it back (${registered})`, async () => {
    const f = fixture(both(order));
    const params = { epochId: 'e1', cadenceSeconds: 300, backlogCap: 50, maxWakes: 3, startedAtSequence: 0 };
    // The registry is the fixture's real one, with b's general tuned out.
    (f.registry as unknown as { getTuneOutState(s: string, c: string): unknown }).getTuneOutState =
      (s: string, c: string) => (s === 'b' && c === 'general' ? { params, wakeCount: 0 } : undefined);
    const coordinator = new TuneOutCoordinator(f.registry as never, {} as never, {
      subconsciousName: () => 'Subconscious', isForkBound: () => false, emitTrace: () => {},
    } as never);
    const again = coordinator.enter('b', 'general', {}, 'agent-tool');
    assert.match((again as { error?: string }).error ?? '', /^Nothing changed: "b:general" is already tuned out, /);
  });
}

test("a fork whose home its server no longer registers is told so, and not offered another server's channel", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  bindAsConversationFork(f.framework, 'scout', b);
  const results = toolResults(t, f.framework);
  const dispatch = (f.framework as unknown as { dispatchChannelToolCall: Dispatcher }).dispatchChannelToolCall.bind(f.framework);
  // b's general goes; a's general keeps the id.
  (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.delete(destinationKey(b));
  dispatch('scout', { id: 'publish', name: 'channel_publish', input: { content: 'to a gone home' } });
  assert.equal(results.get('publish')?.error,
    'This conversation is bound to channel "b:general", which isn\'t registered now, so nothing was posted, ' +
    'and nothing can be until its server registers it again.');
  dispatch('scout', { id: 'close', name: 'channel_close', input: { channelId: 'general' } });
  assert.equal(results.get('close')?.error,
    'This conversation is bound to channel "b:general", which isn\'t registered now, so nothing was closed, ' +
    'and nothing can be until its server registers it again.');
  // So is a call that names it with its server, or by its server alone.
  for (const [id, input] of [['id-server', { channelId: 'general', serverId: 'b' }], ['server-only', { serverId: 'b' }]] as const) {
    dispatch('scout', { id, name: 'channel_publish', input: { ...input, content: 'x' } });
    assert.equal(results.get(id)?.error,
      'This conversation is bound to channel "b:general", which isn\'t registered now, so nothing was posted, ' +
      'and nothing can be until its server registers it again.', id);
  }
  // Before any advice to call again, and with no reply offered in it.
  dispatch('scout', { id: 'qualified-server', name: 'channel_publish', input: { channelId: 'b:general', serverId: 'b', content: 'x' } });
  assert.equal(results.get('qualified-server')?.error,
    'This conversation is bound to channel "b:general", which isn\'t registered now, so nothing was posted, ' +
    'and nothing can be until its server registers it again.');
  dispatch('scout', { id: 'open', name: 'channel_open', input: { channelId: 'elsewhere' } });
  assert.equal(results.get('open')?.error,
    'This conversation is bound to channel "b:general", which isn\'t registered now; it can\'t open other channels, and nothing was opened.');
  assert.deepEqual(f.calls.filter((c) => c.includes('publish')), [], "nothing was posted to a's general, which has the home's id");
});

test("coalesced channel work is admitted only while its own server registers the channel, not another server's channel with the same id", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const fw = f.framework as unknown as {
    coalescingBinding(serverId: string): string;
    coalescedAuthorized(occ: unknown): boolean;
  };
  const work = (serverId: string) => ({
    serverId,
    binding: fw.coalescingBinding(serverId),
    scope: { kind: 'channel', id: 'general' },
    event: { lane: 'channel' },
  });
  assert.equal(fw.coalescedAuthorized(work('a')), true, "control: a's channel is registered");
  // a's general goes; b's stays registered under the same id.
  (f.i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels.delete(destinationKey(a));
  assert.equal(fw.coalescedAuthorized(work('a')), false, "b's channel carries none of a's authority");
  assert.equal(fw.coalescedAuthorized(work('b')), true);
});

test("a [channels] notice names a channel whose id another server shares by its qualified id, which channel_close takes", async (t) => {
  const f = await frameworkWith(t, ['a', 'b']);
  const fw = f.framework as unknown as {
    recordChannelAutoOpenNotice(agent: string | undefined, serverId: string, channels: Array<{ channelId: string; label?: string }>, cause: 'opened-by-reply'): void;
    recordReplyOpenFailedNotice(agent: string | undefined, serverId: string, channel: { channelId: string; label?: string }): void;
  };
  fw.recordChannelAutoOpenNotice('scout', b.serverId, [{ channelId: b.channelId, label: '#general' }], 'opened-by-reply');
  fw.recordReplyOpenFailedNotice('scout', b.serverId, { channelId: b.channelId, label: '#general' });
  const notices = f.framework.getAgent('scout')!.getContextManager().queryMessages({}).messages
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'channel-notice')
    .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
  assert.equal(notices.length, 2, notices.join('\n'));
  assert.ok(notices.every((n) => n.includes('#general (b:general)')), notices.join('\n'));
});
