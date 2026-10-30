import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry, destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import { McplRequestError, McplServerConnection } from '../src/mcpl/server-connection.js';
import { parseProsePrefix } from '../src/mcpl/prose-grammar.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

/** A channel on the fixture's chat server, and one on its body server. */
const discord = (channelId: string): ChannelRef => ({ serverId: 'discord', channelId });
const body = (channelId: string): ChannelRef => ({ serverId: 'body', channelId });

type RouteFailure = { conversationId: string; channelId: string | null; reason: string; textLen: number; outcome?: 'failed' | 'unknown'; detail?: string };

/**
 * Build a registry with a mock server whose publish result is configurable,
 * plus capture arrays for route-failure notifications and emitted traces.
 */
function makeRegistry(
  publishResult: { delivered?: boolean } | undefined,
  homeChannelResolver?: (agentName: string) => ChannelRef | undefined,
  activeChannelResolver?: (agentName: string) => ChannelRef | undefined,
  onChannelAutoOpened?: (info: {
    conversationId?: string;
    serverId: string;
    source: 'subscription-policy' | 'opened-by-delivery';
    channels: Array<{ channelId: string; label?: string }>;
  }) => void,
) {
  const failures: RouteFailure[] = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const publishCalls: Array<{ channelId?: string; conversationId?: string }> = [];

  const openCalls: Array<{ channelId?: string }> = [];
  const closeCalls: Array<{ channelId?: string }> = [];
  const streamCalls: Array<{ kind: 'chunk' | 'complete'; channelId?: string }> = [];
  let failOpens = false;
  let onOpen: (() => Promise<void>) | undefined;
  let onPublish: (() => Promise<void>) | undefined;
  let onClose: (() => Promise<void>) | undefined;
  let onAcknowledge: (() => Promise<void>) | undefined;
  let openResult: unknown = {};

  const mockServer = {
    // Post-policy state: full grant, so tests exercise delivery, not §5.3 denial.
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { channelId?: string; conversationId?: string }) => {
      publishCalls.push(params);
      await onPublish?.();
      return publishResult;
    },
    sendChannelsOutgoingChunk: (params: { channelId?: string }) => {
      streamCalls.push({ kind: 'chunk', channelId: params.channelId });
    },
    sendChannelsOutgoingComplete: (params: { channelId?: string }) => {
      streamCalls.push({ kind: 'complete', channelId: params.channelId });
    },
    sendChannelsOpen: async (params: { channelId?: string }) => {
      if (failOpens) throw new Error('open refused by server');
      openCalls.push(params);
      await onOpen?.();
      return openResult;
    },
    sendChannelsClose: async (params: { channelId?: string }) => {
      closeCalls.push(params);
      await onClose?.();
      return {};
    },
    sendChannelsAcknowledge: async () => {
      await onAcknowledge?.();
      return { acknowledged: true };
    },
  };
  const serverRegistry = {
    getServer: (_id: string) => mockServer,
  } as unknown as McplServerRegistry;

  const registry = new ChannelRegistry(
    serverRegistry,
    {} as FeatureSetManager,
    () => {},
    (e) => { traces.push(e); },
    {
      onRouteFailure: (info) => { failures.push(info); },
      homeChannelResolver,
      activeChannelResolver,
      onChannelAutoOpened,
      // These tests exercise the precedence home → active → global; the
      // global fallback exists only under the legacy locus rule.
      latestInboundLocus: true,
    },
  );

  // A channel's entry, found by its id among the registered ones (each test's
  // ids are unique to one server): a test-only cast into the private map, as
  // the typing test reaches it, not part of the public surface.
  const lookup = (channelId: string) =>
    [...(registry as unknown as {
      channels: Map<string, { serverId: string; open: boolean; descriptor: { id: string; label: string; metadata?: Record<string, unknown> } }>;
    }).channels.values()].find((e) => e.descriptor.id === channelId);

  return {
    registry, failures, traces, publishCalls, openCalls, closeCalls, streamCalls, lookup,
    setFailOpens: (v: boolean) => { failOpens = v; },
    /** Runs while the server is answering an open, before it returns. */
    setOnOpen: (fn: (() => Promise<void>) | undefined) => { onOpen = fn; },
    /** Runs while the server is answering a publish, before it returns. */
    setOnPublish: (fn: (() => Promise<void>) | undefined) => { onPublish = fn; },
    /** What the server answers channels/open with. */
    setOpenResult: (result: unknown) => { openResult = result; },
    /** Runs while the server is answering a close, or an acknowledgement. */
    setOnClose: (fn: (() => Promise<void>) | undefined) => { onClose = fn; },
    setOnAcknowledge: (fn: (() => Promise<void>) | undefined) => { onAcknowledge = fn; },
  };
}

function incoming(channelId: string, text: string, channelName?: string, tags?: string[], threadId?: string) {
  return {
    messages: [{
      channelId,
      messageId: tags ? `marker-${channelId}` : 'm1',
      author: { id: 'u1', name: 'Antra' },
      timestamp: '2026-05-30T00:00:00.000Z',
      content: [{ type: 'text' as const, text }],
      tags,
      threadId,
      metadata: channelName ? { channelName } : undefined,
    }],
  };
}


/** §14.5: channels/incoming no longer mints unknown channels — seed the
 *  registered state a conforming server would have created via
 *  channels/register before feeding incoming traffic. */
function seedRegistered(registry: ChannelRegistry, serverId: string, ...ids: string[]): void {
  const map = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  for (const id of ids) {
    const key = destinationKey({ serverId, channelId: id });
    if (!map.has(key)) {
      map.set(key, { serverId, descriptor: { id, type: serverId, label: id }, open: false });
    }
  }
}


/**
 * Ingest a message and record it as delivered — what the framework does
 * after admission (the registry itself no longer sets the locus at
 * ingestion; a held message is never noted).
 */
function deliver(registry: ChannelRegistry, channelId: string, text: string): void {
  const message = incoming(channelId, text);
  registry.handleIncoming('discord', message);
  const m = message.messages[0]!;
  registry.noteDelivered(discord(m.channelId), m.messageId);
}

test('handleIncoming REJECTS an unknown channel instead of minting it (§14.5)', async () => {
  const { registry, traces } = makeRegistry({ delivered: true });

  // Channel "post-boot-ch" was never registered via channels/register|changed.
  assert.equal(registry.getDescriptor(discord('post-boot-ch')), undefined);

  registry.handleIncoming('discord', incoming('post-boot-ch', 'hi', '#cairn'));

  // §14.5: the unknown channel is NOT minted, the message is rejected with
  // a diagnostic, and the locus never becomes routable — a server cannot
  // self-attest a channel identity by messaging it into existence.
  assert.equal(registry.getDescriptor(discord('post-boot-ch')), undefined, 'unknown channel must not be registered by its first message');
  assert.ok(traces.some(t => t.type === 'mcpl:channel-incoming-rejected'));
  assert.equal(registry.resolveLocus('cairn'), null, 'a rejected message must not establish a locus');
});

test('routeSpeech surfaces a failure when the server reports delivered:false', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: false });
  seedRegistered(registry, 'discord', 'ch-x');
  deliver(registry, 'ch-x', 'hi');

  const res = await registry.routeSpeech('cairn', 'undeliverable reply', registry.resolveLocus('cairn'));

  assert.equal(res, null, 'a non-delivered send must not report success');
  assert.equal(failures.length, 1, 'onRouteFailure should fire');
  assert.equal(failures[0].channelId, 'ch-x');
  assert.equal(failures[0].reason, 'the "discord" server said it didn\'t post the message');
  assert.equal(failures[0].outcome, 'failed', 'the server said nothing was delivered');
  assert.ok(traces.some(t => t.type === 'mcpl:speech-route-failed' && t.outcome === 'failed'));
});

test('routeSpeech counts a publish reply that leaves delivered out as unconfirmed, not delivered', async () => {
  const { registry, failures } = makeRegistry({});
  seedRegistered(registry, 'discord', 'ch-x');
  deliver(registry, 'ch-x', 'hi');

  const res = await registry.routeSpeech('cairn', 'a reply', registry.resolveLocus('cairn'));

  assert.equal(res, null, 'no delivery is confirmed, so the stream gets none of it');
  assert.equal(failures.length, 1, 'and the route failure is reported');
  assert.equal(failures[0].outcome, 'unknown', 'as a post that may or may not exist');
});

test('routeSpeech reports each delivered publish as mcpl:speech-routed, with nothing that ties it to a stream or ends one', async () => {
  const { registry, traces } = makeRegistry({ delivered: true });
  seedRegistered(registry, 'discord', 'ch-x');
  deliver(registry, 'ch-x', 'hi');

  const before = traces.length;
  await registry.routeSpeech('cairn', 'first reply', registry.resolveLocus('cairn'));
  await registry.routeSpeech('cairn', 'second reply', registry.resolveLocus('cairn'));

  // The first publish also opens the channel, and says so in a trace of its
  // own; every other trace the two sends give is checked.
  const routed = traces.slice(before).filter((t) => t.type !== 'mcpl:channel-opened-by-send');
  assert.deepEqual(routed.map((t) => ({ type: t.type, channelId: t.channelId, text: t.text, delivered: t.delivered })), [
    { type: 'mcpl:speech-routed', channelId: 'ch-x', text: 'first reply', delivered: true },
    { type: 'mcpl:speech-routed', channelId: 'ch-x', text: 'second reply', delivered: true },
  ], 'one trace per publish, with its whole text, and none that ends an utterance');
  for (const t of routed) {
    assert.deepEqual(['inferenceId', 'streamId', 'index'].filter((key) => key in t), [],
      'no stream id or index, unlike inference:published');
  }
});

test('routeSpeech routes a conversation fork to its HOME channel, not the global last-inbound (item 3)', async () => {
  // Two channels are live. chanA registered first; then a message arrives on
  // chanB, flipping the process-global defaultPublishChannel to chanB. A fork
  // bound to chanA must still publish to chanA.
  const homes: Record<string, ChannelRef> = { 'conversation-chanA-g1': discord('chanA') };
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    (agentName) => homes[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  deliver(registry, 'chanA', 'hi from A');
  seedRegistered(registry, 'discord', 'chanB');
  deliver(registry, 'chanB', 'hi from B');
  // Global locus is now chanB.
  assert.deepEqual(registry.getDefaultPublishChannel(), discord('chanB'));

  const res = await registry.routeSpeech('conversation-chanA-g1', 'reply for A', registry.resolveLocus('conversation-chanA-g1'));
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'chanA' },
    'fork must route to its home channel, not the global last-inbound');
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('routeSpeech falls back to the global locus for the trunk agent (no home)', async () => {
  // The trunk/primary agent has no home entry; it correctly uses the global
  // most-recent-inbound channel.
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    () => undefined, // no agent has a home
  );

  seedRegistered(registry, 'discord', 'chanA');
  deliver(registry, 'chanA', 'hi from A');
  seedRegistered(registry, 'discord', 'chanB');
  deliver(registry, 'chanB', 'hi from B');

  const res = await registry.routeSpeech('trunk', 'heartbeat reply', registry.resolveLocus('trunk'));
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'chanB' });
  assert.equal(publishCalls.at(-1)?.channelId, 'chanB');
});

test('buildChannelContext advertises the fork home as defaultOutgoing (item 3)', () => {
  const homes: Record<string, ChannelRef> = { 'conversation-chanA-g1': discord('chanA') };
  const { registry } = makeRegistry(
    { delivered: true },
    (agentName) => homes[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  deliver(registry, 'chanA', 'hi from A');
  seedRegistered(registry, 'discord', 'chanB');
  deliver(registry, 'chanB', 'hi from B');

  // The fork is told chanA (where its speech actually lands)...
  const forkCtx = registry.buildChannelContext('conversation-chanA-g1', 'discord');
  assert.equal(forkCtx?.defaultOutgoing?.channelId, 'chanA');

  // ...while the trunk agent (no home) is told the global default.
  const trunkCtx = registry.buildChannelContext('trunk', 'discord');
  assert.equal(trunkCtx?.defaultOutgoing?.channelId, 'chanB');
});

test('routeSpeech surfaces a failure when there is no locus at all', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: true });
  // No handleIncoming → defaultPublishChannel is null.
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let res;
  try {
    res = await registry.routeSpeech('cairn', 'into the void', registry.resolveLocus('cairn'));
  } finally {
    console.error = original;
  }
  assert.equal(res, null);
  // connectome-doctor reads the [routeSpeech] line for "no locus".
  assert.ok(lines.some((line) => line.startsWith('[routeSpeech]') && line.includes('no locus')), lines.join('\n'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].channelId, null);
  assert.equal(failures[0].reason, 'this turn came from no channel, and it had no home or recent channel to reply in; if it ' +
    'should have had one, ask whoever runs this host');
  // The trace, like the log line connectome-doctor reads, keeps "no locus".
  const failed = traces.filter((e) => e.type === 'mcpl:speech-route-failed');
  assert.deepEqual(failed.map((e) => e.reason), ['turn has no locus (no home/trigger channel; nothing to deliver into)']);
});

// ── item-3 redux: single TRUNK agents route to the turn's triggering channel ──

test('routeSpeech routes a TRUNK agent to its ACTIVE triggering channel, not the global last-inbound (item-3 redux)', async () => {
  // The exact live repro: scout (a single trunk agent) is answering channel A
  // when a message arrives on channel B, flipping the process-global
  // defaultPublishChannel to B. The reply must still land in A. Forks (home)
  // don't exist here — connectome-host never spawns them — so the ONLY thing
  // keeping A's answer in A is the active-triggering-channel resolver.
  const active: Record<string, ChannelRef> = { scout: discord('chanA') };
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    () => undefined,               // no fork homes (trunk-only, connectome-host mode)
    (agentName) => active[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  deliver(registry, 'chanA', 'A: sleep && date');
  seedRegistered(registry, 'discord', 'chanB');
  deliver(registry, 'chanB', 'B: unrelated'); // flips global to chanB
  assert.deepEqual(registry.getDefaultPublishChannel(), discord('chanB'));

  const res = await registry.routeSpeech('scout', 'the date is ...', registry.resolveLocus('scout'));
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'chanA' },
    'trunk reply must go to the channel that triggered the turn, not the global last-inbound');
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('routeSpeech precedence: fork HOME wins over the active triggering channel', async () => {
  // A fork bound to chanA must route home even if its live turn was (somehow)
  // triggered from chanB — home is the strongest signal and must not regress.
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    (n) => (n === 'conversation-chanA-g1' ? discord('chanA') : undefined),
    () => discord('chanB'),
  );
  seedRegistered(registry, 'discord', 'chanA');
  deliver(registry, 'chanA', 'hi');
  seedRegistered(registry, 'discord', 'chanB');
  deliver(registry, 'chanB', 'hi');

  const res = await registry.routeSpeech('conversation-chanA-g1', 'reply', registry.resolveLocus('conversation-chanA-g1'));
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'chanA' });
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('buildChannelContext advertises the active triggering channel as defaultOutgoing (item-3 redux)', () => {
  const active: Record<string, ChannelRef> = { scout: discord('chanA') };
  const { registry } = makeRegistry(
    { delivered: true },
    () => undefined,
    (n) => active[n],
  );
  seedRegistered(registry, 'discord', 'chanA');
  deliver(registry, 'chanA', 'hi from A');
  seedRegistered(registry, 'discord', 'chanB');
  deliver(registry, 'chanB', 'hi from B'); // global → chanB

  // The trunk is TOLD chanA (where its speech will actually land), matching
  // what routeSpeech resolves — not the global chanB.
  const ctx = registry.buildChannelContext('scout', 'discord');
  assert.equal(ctx?.defaultOutgoing?.channelId, 'chanA');
});

test('ensureChannelRegistered keeps a DM closed while making its one-shot reply routable', async () => {
  // A Discord DM arrives via push/event (channel closed), so it is never
  // registered and never updates defaultPublishChannel — routeSpeech would drop
  // the reply. Registering it on inbound makes it a publishable locus; the
  // active resolver (the woken turn's DM) then targets it.
  const dm = 'discord:dm:42';
  const active: Record<string, ChannelRef> = { scout: discord(dm) };
  const { registry, publishCalls, traces } = makeRegistry(
    { delivered: true },
    () => undefined,
    (n) => active[n],
  );

  // No prior handleIncoming for the DM — it only ever came as a push event.
  assert.equal(registry.getDescriptor(discord(dm)), undefined);
  assert.equal(registry.getDefaultPublishChannel(), null);

  registry.ensureChannelRegistered('discord', dm, 'DM with Antra');

  assert.ok(registry.getDescriptor(discord(dm)), 'the DM channel should be registered on discord');
  assert.equal(registry.isChannelOpen(discord(dm)), false, 'one-shot reachability is not a subscription');
  assert.ok(traces.some((t) => t.type === 'mcpl:channel-lazy-registered'));

  const res = await registry.routeSpeech('scout', 'replying in the DM', registry.resolveLocus('scout'));
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: dm },
    'the DM reply must route back to the DM channel, not the global locus');
  assert.equal(publishCalls.at(-1)?.channelId, dm);
});

test('ensureChannelRegistered again does not reopen a closed channel', () => {
  const { registry, lookup } = makeRegistry({ delivered: true });
  registry.ensureChannelRegistered('discord', 'discord:guild:7', '#cairn');
  assert.ok(registry.getDescriptor(discord('discord:guild:7')));
  // Force it closed, then re-ensure — a direct push must not mutate lifecycle.
  lookup('discord:guild:7')!.open = false;
  registry.ensureChannelRegistered('discord', 'discord:guild:7', '#cairn');
  assert.equal(registry.isChannelOpen(discord('discord:guild:7')), false, 'a direct push must not mutate lifecycle');
});

// ---------------------------------------------------------------------------
// Channel-lifecycle invariants (2026-07-22): delivery opens a closed channel
// speech opens (speechOpens), so nothing is sent into one it would open
// unopened; a channel the agent or a module closed, or one on a server that's
// up without channels.lifecycle, takes the words as it stands. Subscribed ⇒
// open at any discovery time.
// ---------------------------------------------------------------------------

test('routeSpeech into a closed locus opens the channel first, then delivers', async () => {
  const { registry, publishCalls, openCalls, lookup } = makeRegistry({ delivered: true });

  // A DM-shaped situation: the channel is registered but closed.
  seedRegistered(registry, 'discord', 'dm-alice');
  deliver(registry, 'dm-alice', 'hello?');
  lookup('dm-alice')!.open = false;

  const res = await registry.routeSpeech('sol', 'a reply meant for the DM', discord('dm-alice'));

  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'dm-alice' });
  assert.equal(openCalls.length, 1, 'delivery into a closed channel must open it');
  assert.equal(openCalls[0]!.channelId, 'dm-alice');
  assert.equal(registry.isChannelOpen(discord('dm-alice')), true, 'live state flips open');
  assert.equal(registry.getDesiredState('discord', 'dm-alice'), 'open',
    'durable desired state records the engagement');
  assert.equal(publishCalls.at(-1)?.channelId, 'dm-alice');
});

test('routeSpeech does NOT deliver when the open-on-delivery fails', async () => {
  const { registry, failures, publishCalls, lookup, setFailOpens } = makeRegistry({ delivered: true });

  seedRegistered(registry, 'discord', 'dm-alice');
  deliver(registry, 'dm-alice', 'hello?');
  lookup('dm-alice')!.open = false;
  const publishesBefore = publishCalls.length;
  setFailOpens(true);

  const res = await registry.routeSpeech('sol', 'must not go out', discord('dm-alice'));

  assert.equal(res, null, 'no delivery into a channel that could not be opened');
  assert.equal(publishCalls.length, publishesBefore, 'publish must not be attempted');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.reason, /^opening the channel for these words didn't complete: /);
  assert.equal(failures[0]!.outcome, 'failed', 'nothing was published');
});

test('routeSpeech publishes into a closed channel on a server whose lifecycle this host doesn\'t direct, where nothing opens', async () => {
  const published: Array<string | undefined> = [];
  const opens: Array<string | undefined> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle')), []),
    sendChannelsPublish: async (params: { channelId?: string }) => {
      published.push(params.channelId);
      return { delivered: true };
    },
    sendChannelsOpen: async (params: { channelId?: string }) => {
      opens.push(params.channelId);
      return {};
    },
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
  );
  seedRegistered(registry, 'portal', 'lobby');
  const lobby = { serverId: 'portal', channelId: 'lobby' };

  const res = await registry.routeSpeech('sol', 'hello from outside', lobby);

  assert.deepEqual(res, { delivered: true, serverId: 'portal', channelId: 'lobby' }, 'nothing opens, and the words still go');
  assert.deepEqual(published, ['lobby']);
  assert.deepEqual(opens, [], 'no open is tried');
  assert.equal(registry.directsLifecycle('portal'), false);
  assert.equal(registry.speechOpens(lobby), false);
  assert.equal(registry.getDesiredState('portal', 'lobby'), undefined, 'speech records no intent to open');
});

test("routeSpeech leaves a channel the agent closed or declined itself closed, and publishes there", async () => {
  const { registry, publishCalls, openCalls } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'closed-by-agent', type: 'discord', label: '#a', direction: 'bidirectional' },
      { id: 'declined-by-agent', type: 'discord', label: '#b', direction: 'bidirectional' },
    ],
  } as never);
  const origin = { kind: 'agent' as const, agentName: 'sol' };
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'closed-by-agent' }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'closed-by-agent' }, origin)).success, true);
  assert.equal((await registry.handleChannelToolCall(
    'channel_decline', { channelId: 'declined-by-agent', messageId: 'm1' }, origin)).success, true);
  const opensBefore = openCalls.length;

  for (const id of ['closed-by-agent', 'declined-by-agent']) {
    const res = await registry.routeSpeech('sol', 'answering', discord(id));
    assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: id });
    assert.equal(publishCalls.at(-1)?.channelId, id);
    assert.equal(registry.isChannelOpen(discord(id)), false, `${id} stays closed`);
    assert.equal(registry.getDesiredState('discord', id), 'closed');
  }
  assert.equal(openCalls.length, opensBefore, 'speech opened neither');
  assert.equal(registry.closedByAgent(discord('closed-by-agent')), 'closed');
  assert.equal(registry.closedByAgent(discord('declined-by-agent')), 'declined');
});

test("speech opens a channel a machine closed, and the agent's own close of it then stands against its speech", async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'gc-a', type: 'discord', label: '#a', direction: 'bidirectional' },
      { id: 'gc-b', type: 'discord', label: '#b', direction: 'bidirectional' },
      { id: 'hk-a', type: 'discord', label: '#h', direction: 'bidirectional' },
    ],
  } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  // Both machine sources: subscription-gc's idle close and a housekeeping close.
  for (const [id, source] of [['gc-a', 'subscription-gc'], ['gc-b', 'subscription-gc'], ['hk-a', 'housekeeping']] as const) {
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: id }, agent)).success, true);
    assert.equal((await registry.handleChannelToolCall(
      'channel_close', { channelId: id, source, overrideExplicitOpen: true }, { kind: 'module', moduleName: source })).success, true);
    assert.equal(registry.closedByAgent(discord(id)), undefined, 'a machine close is no decision of the agent');
    assert.equal(registry.speechOpens(discord(id)), true, `speech opens what ${source} closed`);
  }
  // The agent closes one of them itself: its close replaces the machine's.
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'gc-b' }, agent);
  assert.deepEqual(closed.data, { channelId: 'gc-b', serverId: 'discord', status: 'already closed' });
  assert.equal(registry.closedByAgent(discord('gc-b')), 'closed');
  const opensBefore = openCalls.length;

  for (const id of ['gc-a', 'gc-b', 'hk-a']) {
    assert.ok(await registry.routeSpeech('sol', 'answering', discord(id)), `${id}: delivered`);
  }

  assert.deepEqual(openCalls.slice(opensBefore).map((c) => c.channelId), ['gc-a', 'hk-a'], 'speech opens only the machine-closed ones');
  assert.equal(registry.isChannelOpen(discord('gc-a')), true);
  assert.equal(registry.isChannelOpen(discord('gc-b')), false);
  assert.equal(registry.isChannelOpen(discord('hk-a')), true);
});

test('routeSpeech with an omitted locus fails loudly as a routing bug', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: true });
  seedRegistered(registry, 'discord', 'ch-y');
  deliver(registry, 'ch-y', 'hi');

  const res = await (registry.routeSpeech as unknown as (
    c: string, t: string) => Promise<unknown>)('cairn', 'who knows where');

  assert.equal(res, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.reason, 'the host lost track of which channel this reply was for; if this keeps happening, ask ' +
    'whoever runs this host');
  const failed = traces.filter((e) => e.type === 'mcpl:speech-route-failed');
  assert.deepEqual(failed.map((e) => e.reason),
    ['caller passed no locus (routing bug: every speech path must snapshot the turn locus)']);
});

test('subscription allow-list opens channels discovered AFTER bootstrap (subscribed => open)', async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  registry.setSubscriptionPolicy('discord', ['late-chan', '111222333']);

  // Post-bootstrap discovery via channels/changed — the path that used to
  // leave subscribed channels closed.
  await registry.handleChanged('discord', {
    added: [
      { id: 'late-chan', type: 'discord', label: '#late', direction: 'bidirectional' },
      { id: 'discord:guild:111222333', type: 'discord', label: '#by-raw-id',
        direction: 'bidirectional', address: { guildId: 'guild', channelId: '111222333' } },
      { id: 'unrelated', type: 'discord', label: '#unrelated', direction: 'bidirectional' },
    ],
  } as never);

  assert.equal(registry.getDesiredState('discord', 'late-chan'), 'open');
  assert.equal(registry.getDesiredState('discord', 'discord:guild:111222333'), 'open',
    'allow-list matches raw server-internal ids too');
  assert.equal(registry.getDesiredState('discord', 'unrelated'), 'closed');
  assert.ok(openCalls.some(c => c.channelId === 'late-chan'));
  assert.ok(openCalls.some(c => c.channelId === 'discord:guild:111222333'));
  assert.ok(!openCalls.some(c => c.channelId === 'unrelated'));
});

test("policy 'auto' opens every post-bootstrap discovery", async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  registry.setSubscriptionPolicy('discord', 'auto');

  await registry.handleChanged('discord', {
    added: [{ id: 'brand-new', type: 'discord', label: '#new', direction: 'bidirectional' }],
  } as never);

  assert.equal(registry.getDesiredState('discord', 'brand-new'), 'open');
  assert.ok(openCalls.some(c => c.channelId === 'brand-new'));
});

test('an agent decision to stay closed sticks — policy does not override channel_decline/close', async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  registry.setSubscriptionPolicy('discord', 'auto');

  // Simulate a real prior decision recorded as agent-sourced desired state.
  (registry as unknown as {
    setDesiredState(s: string, c: string, d: 'open' | 'closed', src: string): void;
  }).setDesiredState('discord', 'declined-chan', 'closed', 'agent-tool');

  await registry.handleChanged('discord', {
    added: [{ id: 'declined-chan', type: 'discord', label: '#declined', direction: 'bidirectional' }],
  } as never);

  assert.equal(registry.getDesiredState('discord', 'declined-chan'), 'closed',
    'agent decisions outrank subscription policy');
  assert.ok(!openCalls.some(c => c.channelId === 'declined-chan'));
});

test('openIfClosedForSend resolves raw server-internal ids and opens the channel', async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });

  await registry.handleChanged('discord', {
    added: [{ id: 'discord:dm:444555', type: 'discord', label: 'DM: Alice',
      direction: 'bidirectional', address: { guildId: 'dm', channelId: '444555' } }],
  } as never);
  assert.equal(registry.isChannelOpen(discord('discord:dm:444555')), false, 'DM registers closed');

  const { status } = await registry.openIfClosedForSend('444555', 'discord');

  assert.equal(status, 'opened');
  assert.equal(registry.isChannelOpen(discord('discord:dm:444555')), true);
  assert.ok(openCalls.some(c => c.channelId === 'discord:dm:444555'));
});

test("a machine's close of a channel with no record leaves it the default it was, so policy can still open it (#417)", async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  // Registered lazily, from a message: no decision on record.
  registry.ensureChannelRegistered('discord', 'lazy-1', '#lazy');
  assert.equal(registry.getDesiredState('discord', 'lazy-1'), undefined);
  const gc = await registry.handleChannelToolCall(
    'channel_close', { channelId: 'lazy-1', source: 'subscription-gc' }, { kind: 'module', moduleName: 'subscription-gc' });
  assert.equal(gc.success, true, gc.error);
  assert.equal(registry.getDesiredState('discord', 'lazy-1'), 'closed');
  assert.equal(registry.closedByAgent(discord('lazy-1')), undefined);

  // Policy admits everything, and the channel registers again: policy lifts the default.
  registry.setSubscriptionPolicy('discord', 'auto');
  const opensBefore = openCalls.length;
  await registry.handleChanged('discord', {
    added: [{ id: 'lazy-1', type: 'discord', label: '#lazy', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.getDesiredState('discord', 'lazy-1'), 'open', 'nobody decided, so policy decides');
  assert.deepEqual(openCalls.slice(opensBefore).map((c) => c.channelId), ['lazy-1']);
});

test("channel_close's description says the close stands against speech and policy", () => {
  const { registry } = makeRegistry({ delivered: true });
  const close = registry.getChannelTools().find((t) => t.name === 'channel_close')!;
  assert.match(close.description,
    /You can still speak there\. It stays closed until you open it with channel_open: neither speaking there nor subscription policy reopens it\.$/);
});

test("a module's close, made with no machine source, is the module's: speech leaves it closed, and it isn't the agent's", async () => {
  const { registry, openCalls, publishCalls } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'mode-a', type: 'discord', label: '#a', direction: 'bidirectional' },
      { id: 'mode-b', type: 'discord', label: '#b', direction: 'bidirectional' },
    ],
  } as never);
  // A module's tool call (ctx.callTool), as connectome-host's channel modes make them.
  const mode = { kind: 'module' as const };
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  // mode-b was opened by the module's other mode, which records an open as the agent's.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'mode-b' }, mode)).success, true);
  for (const id of ['mode-a', 'mode-b']) {
    const closed = await registry.handleChannelToolCall('channel_close', { channelId: id }, mode);
    assert.equal(closed.success, true, `${id}: not refused as a machine's close of an explicit open`);
    assert.equal(registry.getDesiredState('discord', id), 'closed');
    assert.equal(registry.speechOpens(discord(id)), false, `${id}: speech leaves it closed`);
    assert.equal(registry.closedByAgent(discord(id)), undefined, `${id}: not the agent's close`);
    assert.equal(registry.speechLeavesClosed(discord(id)), true, `${id}: a decided close all the same, which speech leaves closed`);
  }
  const opensBefore = openCalls.length;
  assert.deepEqual(await registry.routeSpeech('sol', 'a reply', discord('mode-a')), { delivered: true, serverId: 'discord', channelId: 'mode-a' });
  assert.equal(publishCalls.at(-1)?.channelId, 'mode-a');
  assert.equal(openCalls.length, opensBefore, 'speech opened nothing');

  // Policy doesn't lift it at the next registration.
  registry.setSubscriptionPolicy('discord', 'auto');
  await registry.handleChanged('discord', {
    added: [{ id: 'mode-a', type: 'discord', label: '#a', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.getDesiredState('discord', 'mode-a'), 'closed');
  // A machine's close doesn't replace it.
  await registry.handleChannelToolCall('channel_close', { channelId: 'mode-b', source: 'subscription-gc' }, mode);
  assert.equal(registry.speechOpens(discord('mode-b')), false, "still the module's");
  // The agent's own close does, and from then on it's the agent's.
  await registry.handleChannelToolCall('channel_close', { channelId: 'mode-a' }, agent);
  assert.equal(registry.closedByAgent(discord('mode-a')), 'closed');
  // The latest deliberate close wins: the mode set again makes it the module's.
  await registry.handleChannelToolCall('channel_close', { channelId: 'mode-a' }, mode);
  assert.equal(registry.closedByAgent(discord('mode-a')), undefined, "the module's again");
  assert.equal(registry.speechOpens(discord('mode-a')), false);
});

/** A registry over a lifecycle log, as Chronicle keeps it, with a server whose
 *  channels/open answers can be held, and which applies opens and closes in
 *  the order they arrive. */
function loggedRegistry(events: unknown[]) {
  const openCalls: Array<{ channelId?: string }> = [];
  const closeCalls: Array<{ channelId?: string }> = [];
  const published: Array<string | undefined> = [];
  const serverOpen = new Set<string>();
  let openHold: Promise<void> | null = null;
  let openReached: () => void = () => {};
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOpen: async (params: { channelId?: string }) => {
      openCalls.push(params);
      if (params.channelId) serverOpen.add(params.channelId);
      openReached();
      if (openHold) await openHold;
      return {};
    },
    sendChannelsClose: async (params: { channelId?: string }) => {
      closeCalls.push(params);
      if (params.channelId) serverOpen.delete(params.channelId);
      return {};
    },
    sendChannelsPublish: async (params: { channelId?: string }) => {
      published.push(params.channelId);
      return { delivered: true };
    },
    sendChannelsAcknowledge: async () => ({ acknowledged: true }),
  };
  const store = {
    registerState: () => {},
    getStateJson: (id: string) => (id === 'mcpl/channel-lifecycle' ? events : null),
    appendToStateJson: (id: string, event: unknown) => { if (id === 'mcpl/channel-lifecycle') events.push(event); },
  };
  // Each open speech reports, as the framework's "[channels] Now open" notice hears of it.
  const autoOpened: Array<{ channels: Array<{ channelId: string }> }> = [];
  const failures: Array<{ reason: string }> = [];
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {},
    {
      store: store as never,
      onChannelAutoOpened: (info) => { autoOpened.push(info); },
      onRouteFailure: (info) => { failures.push(info); },
    },
  );
  return {
    registry, openCalls, closeCalls, published, serverOpen, autoOpened, failures,
    /** Hold every channels/open answer until the returned release; resolves `reached` at the first one. */
    holdOpens: () => {
      let release!: () => void;
      openHold = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { openReached = resolve; });
      return { reached, release: () => { openHold = null; release(); } };
    },
  };
}

const channelsOf = (...ids: string[]) =>
  ids.map((id) => ({ id, type: 'discord', label: `#${id}`, direction: 'bidirectional' as const }));

test("the latest deliberate close records itself over any closed record: the retired recipe's migration, a source a replay couldn't read, the agent's own earlier close; a machine's close replaces none", async () => {
  // A record replayed from the log with no source reads as 'unknown'.
  const events: unknown[] = [{ kind: 'desired-state', serverId: 'discord', channelId: 'replayed', desired: 'closed', timestamp: '2026-10-01T00:00:00.000Z' }];
  const { registry, openCalls } = loggedRegistry(events);
  // The server's first registration consumes the retired recipe policy ('manual'):
  // every channel it lists that has no record is recorded closed by that migration.
  await registry.handleRegister('discord', { channels: channelsOf('migrated-a', 'migrated-b', 'migrated-c', 'replayed') } as never);
  for (const id of ['migrated-a', 'migrated-b', 'migrated-c', 'replayed']) {
    assert.equal(registry.getDesiredState('discord', id), 'closed', id);
    assert.equal(registry.speechOpens(discord(id)), true, `${id}: nobody decided it, so speech would open it`);
  }
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'migrated-a' }, agent)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_decline', { channelId: 'migrated-b', messageId: 'm1' }, agent)).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'migrated-c' }, { kind: 'module' })).success, true);
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'replayed' }, agent)).success, true);
  assert.equal(registry.closedByAgent(discord('migrated-a')), 'closed');
  assert.equal(registry.closedByAgent(discord('migrated-b')), 'declined');
  assert.equal(registry.closedByAgent(discord('migrated-c')), undefined, "a module's close");
  assert.equal(registry.closedByAgent(discord('replayed')), 'closed');
  // A decline after the agent's own close is the latest decision, and the note says so.
  assert.equal((await registry.handleChannelToolCall('channel_decline', { channelId: 'migrated-a', messageId: 'm2' }, agent)).success, true);
  assert.equal(registry.closedByAgent(discord('migrated-a')), 'declined');
  // A machine's close replaces none of them.
  const gc = { kind: 'module' as const, moduleName: 'subscription-gc' };
  for (const id of ['migrated-a', 'migrated-c']) {
    assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: id, source: 'subscription-gc' }, gc)).success, true);
  }
  assert.equal(registry.closedByAgent(discord('migrated-a')), 'declined');
  assert.equal(registry.speechOpens(discord('migrated-c')), false, "still the module's");

  const opensBefore = openCalls.length;
  for (const id of ['migrated-a', 'migrated-b', 'migrated-c', 'replayed']) {
    assert.deepEqual(await registry.routeSpeech('sol', 'answering', discord(id)), { delivered: true, serverId: 'discord', channelId: id });
  }
  assert.equal(openCalls.length, opensBefore, 'speech opened none of them');
  // Each decision went to the log.
  const logged = (id: string) => (events as Array<{ kind?: string; channelId?: string; source?: string }>)
    .filter((e) => e.kind === 'desired-state' && e.channelId === id).at(-1)?.source;
  assert.deepEqual(['migrated-a', 'migrated-b', 'migrated-c', 'replayed'].map(logged),
    ['invitation-declined', 'invitation-declined', 'module-tool', 'agent-tool']);
});

test("words waiting on an open speech started go into the channel as it stands once the agent closes or declines it meanwhile, and nothing says it opened", async () => {
  const { registry, holdOpens, autoOpened, serverOpen, published, failures } = loggedRegistry([]);
  await registry.handleRegister('discord', { channels: channelsOf('closed-meanwhile', 'declined-meanwhile') } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };

  for (const [id, decide] of [
    ['closed-meanwhile', () => registry.handleChannelToolCall('channel_close', { channelId: 'closed-meanwhile' }, agent)],
    ['declined-meanwhile', () => registry.handleChannelToolCall('channel_decline', { channelId: 'declined-meanwhile', messageId: 'm1' }, agent)],
  ] as const) {
    // Speech opens it, since nobody decided about it; the agent decides while the open is on its way.
    const held = holdOpens();
    const speaking = registry.routeSpeech('sol', 'answering', discord(id));
    await held.reached;
    assert.equal(registry.getDesiredState('discord', id), 'open', "the open's intent is recorded");
    const decided = decide();
    held.release();
    assert.equal((await decided).success, true);
    assert.deepEqual(await speaking, { delivered: true, serverId: 'discord', channelId: id }, `${id}: the words went`);
    assert.equal(published.at(-1), id);
    assert.equal(registry.getDesiredState('discord', id), 'closed', `${id}: the decision made meanwhile stands`);
    assert.equal(registry.isChannelOpen(discord(id)), false);
    assert.equal(serverOpen.has(id), false, `${id}: the server applied the open, then the close`);
  }
  assert.deepEqual(autoOpened, [], 'nothing reports either channel as opened');
  assert.deepEqual(failures, [], 'and no words were refused');
});

test("a channel no longer registered isn't one the agent keeps closed, whatever its record says", async () => {
  const { registry } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', { added: channelsOf('gone') } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'gone' }, agent)).success, true);
  assert.equal(registry.closedByAgent(discord('gone')), 'closed');
  assert.equal(registry.speechLeavesClosed(discord('gone')), true);
  await registry.handleChanged('discord', { removed: ['gone'] } as never);
  assert.equal(registry.getDesiredState('discord', 'gone'), 'closed', 'the decision is kept');
  assert.equal(registry.closedByAgent(discord('gone')), undefined);
  assert.equal(registry.speechLeavesClosed(discord('gone')), false);
});

test("words go into a channel the agent closed whose close is still on its way, without opening it", async () => {
  const { registry, openCalls, closeCalls, published, holdOpens } = loggedRegistry([]);
  await registry.handleRegister('discord', { channels: channelsOf('closing') } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'closing' }, agent)).success, true);
  // An open still being answered holds the channel's lifecycle queue, so the
  // agent's close waits behind it, and so do the words.
  const held = holdOpens();
  const reopening = registry.handleChannelToolCall('channel_open', { channelId: 'closing', backscroll: 5, beforeMessageId: 'm0' }, agent);
  await held.reached;
  const closing = registry.handleChannelToolCall('channel_close', { channelId: 'closing' }, agent);
  const speaking = registry.routeSpeech('sol', 'answering', discord('closing'));
  const opensBefore = openCalls.length;
  held.release();
  await reopening;
  assert.equal((await closing).success, true);
  assert.deepEqual(await speaking, { delivered: true, serverId: 'discord', channelId: 'closing' });
  assert.equal(published.at(-1), 'closing');
  assert.equal(openCalls.length, opensBefore, 'the words opened nothing');
  assert.equal(registry.isChannelOpen(discord('closing')), false);
  assert.ok(closeCalls.some((c) => c.channelId === 'closing'));
});

test('a channel decided open whose open failed is closed at the transport, so the agent can decline it, and speech then leaves it closed', async () => {
  const { registry, openCalls, publishCalls, setFailOpens } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', { added: channelsOf('down') } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  setFailOpens(true);
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'down' }, agent)).success, false);
  assert.equal(registry.getDesiredState('discord', 'down'), 'open');
  assert.equal(registry.isChannelOpen(discord('down')), false);
  const declined = await registry.handleChannelToolCall('channel_decline', { channelId: 'down', messageId: 'm1' }, agent);
  assert.equal(declined.success, true, declined.error);
  assert.equal(registry.closedByAgent(discord('down')), 'declined');
  setFailOpens(false);
  const opensBefore = openCalls.length;
  assert.deepEqual(await registry.routeSpeech('sol', 'answering', discord('down')), { delivered: true, serverId: 'discord', channelId: 'down' });
  assert.equal(publishCalls.at(-1)?.channelId, 'down');
  assert.equal(openCalls.length, opensBefore, 'speech leaves it closed');
  // A channel open at the transport is still refused.
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'down' }, agent)).success, true);
  const refused = await registry.handleChannelToolCall('channel_decline', { channelId: 'down', messageId: 'm2' }, agent);
  assert.equal(refused.success, false);
  assert.equal(refused.error, 'Channel "down" is open, so there\'s nothing to decline. If you need it closed, call channel_close.');
});

test('resolveSendTarget names the channel a send went to and guesses nothing', async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  const added = (id: string, raw: string) => ({
    id, type: 'discord', label: `#${raw}`, direction: 'bidirectional', address: { guildId: 'g', channelId: raw },
  });
  await registry.handleChanged('discord-a', { added: [added('discord:g:444', '444'), added('discord:g:555', '555')] } as never);
  await registry.handleChanged('discord-b', { added: [added('discord:h:555', '555')] } as never);
  const opensBefore = openCalls.length;
  const on = (serverId: string, channelId: string): ChannelRef => ({ serverId, channelId });

  assert.deepEqual(registry.resolveSendTarget('discord:g:444'), on('discord-a', 'discord:g:444'), 'a descriptor id');
  assert.deepEqual(registry.resolveSendTarget('444', 'discord-a'), on('discord-a', 'discord:g:444'), 'a raw id, on its server');
  assert.equal(registry.resolveSendTarget('444', 'discord-b'), undefined, 'not on another server');
  assert.equal(registry.resolveSendTarget('555'), undefined, 'a raw id two servers share');
  assert.deepEqual(registry.resolveSendTarget('555', 'discord-b'), on('discord-b', 'discord:h:555'), 'the server settles it');
  assert.equal(registry.resolveSendTarget('999', 'discord-a'), undefined, 'an unknown id');
  assert.equal(openCalls.length, opensBefore, 'a lookup opens nothing');
});

test("a send opens a closed channel speech opens, and leaves every other one as it stands, answering stays-closed", async () => {
  const { registry, openCalls, traces, lookup, setOnClose } = makeRegistry({ delivered: true });
  const ids = ['undecided', 'agent-closed', 'declined', 'module-closed', 'gc-closed', 'decided-open', 'open-now', 'close-failed'];
  await registry.handleChanged('discord', { added: channelsOf(...ids) } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  await registry.handleChannelToolCall('channel_close', { channelId: 'agent-closed' }, agent);
  await registry.handleChannelToolCall('channel_decline', { channelId: 'declined', messageId: 'm1' }, agent);
  await registry.handleChannelToolCall('channel_close', { channelId: 'module-closed' }, { kind: 'module' });
  await registry.handleChannelToolCall('channel_close', { channelId: 'gc-closed', source: 'subscription-gc' }, { kind: 'module', moduleName: 'subscription-gc' });
  await registry.handleChannelToolCall('channel_open', { channelId: 'open-now' }, agent);
  await registry.handleChannelToolCall('channel_open', { channelId: 'decided-open' }, agent);
  await registry.handleChannelToolCall('channel_open', { channelId: 'close-failed' }, agent);
  // The decided-open channel's transport is down; the agent's close of
  // close-failed is on record, though the server refused it.
  lookup('decided-open')!.open = false;
  setOnClose(async () => { throw new Error('close refused by server'); });
  assert.equal((await registry.handleChannelToolCall('channel_close', { channelId: 'close-failed' }, agent)).success, false);
  setOnClose(undefined);
  assert.equal(registry.getDesiredState('discord', 'close-failed'), 'closed');
  assert.equal(registry.isChannelOpen(discord('close-failed')), true, 'its transport is still open');
  const opensBefore = openCalls.length;

  assert.deepEqual(ids.map((id) => [id, registry.speechOpens(discord(id))]), [
    ['undecided', true], ['agent-closed', false], ['declined', false], ['module-closed', false], ['gc-closed', true],
    ['decided-open', true], ['open-now', false], ['close-failed', false],
  ]);
  assert.equal(registry.speechOpens(discord('nowhere')), false);

  const statuses: Array<[string, string]> = [];
  for (const id of ids) statuses.push([id, (await registry.openIfClosedForSend(id, 'discord')).status]);
  assert.deepEqual(statuses, [
    ['undecided', 'opened'], ['agent-closed', 'stays-closed'], ['declined', 'stays-closed'], ['module-closed', 'stays-closed'],
    ['gc-closed', 'opened'], ['decided-open', 'already-open'], ['open-now', 'already-open'], ['close-failed', 'stays-closed'],
  ], 'a reconfirmed transport of a channel decided open opens no closed channel');
  assert.deepEqual((await registry.openIfClosedForSend('nowhere', 'discord')).status, 'unknown-channel');
  // A channel open at the transport with no decision on record, as a push's
  // registration that traffic confirmed: the send records its engagement as
  // an open, as it always did, which a retarget or a restart carries out.
  seedRegistered(registry, 'discord', 'no-record');
  lookup('no-record')!.open = true;
  assert.equal(registry.getDesiredState('discord', 'no-record'), undefined);
  assert.equal((await registry.openIfClosedForSend('no-record', 'discord')).status, 'opened');
  assert.equal(registry.getDesiredState('discord', 'no-record'), 'open');

  assert.deepEqual(openCalls.slice(opensBefore).map((c) => c.channelId), ['undecided', 'gc-closed', 'decided-open', 'no-record']);
  assert.deepEqual(traces.filter((t) => t.type === 'mcpl:channel-opened-by-send').map((t) => t.channelId),
    ['undecided', 'gc-closed', 'no-record'], 'each open by a send is traced');
  assert.equal(registry.getDesiredState('discord', 'close-failed'), 'closed', "the agent's close stands");
  assert.equal(registry.closedByAgent(discord('agent-closed')), 'closed');
  assert.equal(registry.closedByAgent(discord('declined')), 'declined');
});

test("a send answers already-open for an open channel on a server whose lifecycle this host doesn't direct, and stays-closed for a closed one, opening neither", async () => {
  const opens: Array<string | undefined> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle')), []),
    sendChannelsOpen: async (params: { channelId?: string }) => { opens.push(params.channelId); return {}; },
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {},
  );
  seedRegistered(registry, 'portal', 'lobby', 'hall');
  (registry as unknown as { channels: Map<string, { open: boolean }> }).channels.get(destinationKey({ serverId: 'portal', channelId: 'hall' }))!.open = true;
  assert.equal((await registry.openIfClosedForSend('lobby', 'portal')).status, 'stays-closed');
  assert.equal((await registry.openIfClosedForSend('hall', 'portal')).status, 'already-open');
  assert.deepEqual(opens, []);
});

test('policy admissions are announced to the agent exactly once, as one batch', async () => {
  const autoOpened: Array<{ conversationId?: string; source: string; channels: Array<{ channelId: string }> }> = [];
  const { registry } = makeRegistry({ delivered: true }, undefined, undefined, (info) => autoOpened.push(info));
  registry.setSubscriptionPolicy('discord', ['chan-1', 'chan-2']);

  const added = {
    added: [
      { id: 'chan-1', type: 'discord', label: '#one', direction: 'bidirectional' },
      { id: 'chan-2', type: 'discord', label: '#two', direction: 'bidirectional' },
      { id: 'chan-3', type: 'discord', label: '#three', direction: 'bidirectional' },
    ],
  } as never;
  await registry.handleChanged('discord', added);

  assert.equal(autoOpened.length, 1, 'one batched notice per reconcile pass');
  assert.equal(autoOpened[0]!.source, 'subscription-policy');
  assert.deepEqual(autoOpened[0]!.channels.map(c => c.channelId).sort(), ['chan-1', 'chan-2']);

  // Same channels registering again (reboot / re-register): no re-announcement.
  await registry.handleChanged('discord', added);
  assert.equal(autoOpened.length, 1, 'a durable decision is never re-announced');
});

test('opened-by-delivery is announced to the delivering agent', async () => {
  const autoOpened: Array<{ conversationId?: string; source: string; channels: Array<{ channelId: string }> }> = [];
  const { registry, lookup } = makeRegistry({ delivered: true }, undefined, undefined, (info) => autoOpened.push(info));

  seedRegistered(registry, 'discord', 'dm-alice');
  deliver(registry, 'dm-alice', 'hello?');
  lookup('dm-alice')!.open = false;

  await registry.routeSpeech('sol', 'reply', discord('dm-alice'));

  assert.equal(autoOpened.length, 1);
  assert.equal(autoOpened[0]!.source, 'opened-by-delivery');
  assert.equal(autoOpened[0]!.conversationId, 'sol');
  assert.deepEqual(autoOpened[0]!.channels.map(c => c.channelId), ['dm-alice']);
});

test('resolveProseTarget matches the name segment of suffixed labels (#fable vs "#fable (guild)")', async () => {
  const { registry } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'discord:g1:100', type: 'discord', label: "#fable (antra's server)", direction: 'bidirectional' },
      { id: 'discord:g1:101', type: 'discord', label: '#ops (Connectome)', direction: 'bidirectional' },
    ],
  } as never);

  const hit = registry.resolveProseTarget('#fable');
  assert.ok('channelId' in hit && hit.channelId === 'discord:g1:100', 'suffix-blind name match resolves');

  // Same name in two guilds = honest ambiguity with full labels.
  await registry.handleChanged('discord', {
    added: [{ id: 'discord:g2:200', type: 'discord', label: '#fable (Connectome)', direction: 'bidirectional' }],
  } as never);
  const amb = registry.resolveProseTarget('#fable');
  assert.ok('error' in amb && amb.candidates!.length === 2, 'cross-guild name collision errors with candidates');

  // No match offers near-candidates instead of a dead end.
  const miss = registry.resolveProseTarget('#fabl');
  assert.ok('error' in miss && (miss.candidates?.length ?? 0) >= 1, 'near-candidates on no-match');
});

test('DM prose targets resolve people-first: @name, prefix-lenient names, and <@id> mention tokens', async () => {
  const { registry } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'discord:dm:555', type: 'discord', label: 'DM: antra', direction: 'bidirectional',
        metadata: { channelType: 'dm', recipientName: 'antra', recipientId: '134390790938951680' } },
      { id: 'discord:dm:556', type: 'discord', label: 'DM: laria', direction: 'bidirectional',
        metadata: { channelType: 'dm', recipientName: 'laria', recipientId: '628555451356676097' } },
    ],
  } as never);

  const exact = registry.resolveProseTarget('@antra');
  assert.ok('channelId' in exact && exact.channelId === 'discord:dm:555', 'exact recipient name');

  const lenient = registry.resolveProseTarget('@antra_tessera');
  assert.ok('channelId' in lenient && lenient.channelId === 'discord:dm:555',
    'handle resolves against display-name prefix');

  const token = registry.resolveProseTarget('<@134390790938951680>');
  assert.ok('channelId' in token && token.channelId === 'discord:dm:555', 'mention token by recipientId');

  const missing = registry.resolveProseTarget('@nobody');
  assert.ok('error' in missing && /send_dm/.test(missing.error), 'no-match points at send_dm');
  assert.ok('error' in missing && (missing.candidates?.length ?? 0) === 2, 'lists known DMs by name');
});

test('non-conversational markers do not retarget the default publish locus (#157)', async () => {
  // A reaction/edit/delete marker (RFC-001 tags) is ABOUT a message, not one
  // the agent replies to: arriving on chanB it must not flip the
  // process-global defaultPublishChannel away from the real conversation on
  // chanA, and must not become context.incoming's reply anchor.
  const { registry, lookup } = makeRegistry(undefined);
  seedRegistered(registry, 'discord', 'chanA');
  seedRegistered(registry, 'discord', 'chanB');
  // The host directs this server's lifecycle (the mock's grant includes
  // channels.lifecycle), so traffic repairs a channel's open state only
  // while the channel is decided open (#210). chanB is.
  (registry as unknown as {
    setDesiredState(s: string, c: string, d: 'open' | 'closed', src: string): void;
  }).setDesiredState('discord', 'chanB', 'open', 'agent-tool');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A', undefined, undefined, 'thread-A'));
  registry.noteDelivered(discord('chanA'), 'm1', 'thread-A');

  // The framework records every delivered message through noteDelivered,
  // tags and the coalescer's first-view mark included; the rule is the
  // registry's (isMarkerTagged), so it is exercised here as the framework calls it.
  for (const tag of ['chat:reaction', 'chat:reaction-remove', 'chat:edited', 'chat:deleted', 'chat:system']) {
    lookup('chanB')!.open = false;
    registry.handleIncoming('discord', incoming('chanB', `[${tag}] marker`, undefined, [tag]));
    registry.noteDelivered(discord('chanB'), 'marker-chanB', undefined, [tag]);
    assert.deepEqual(registry.getDefaultPublishChannel(), discord('chanA'),
      `a ${tag} marker on chanB must not steal the default publish locus`);
    const anchor = registry.buildChannelContext(undefined, 'discord')?.incoming;
    assert.equal(anchor?.messageId, 'm1', `a ${tag} marker leaves the reply anchor's message`);
    assert.equal(anchor?.threadId, 'thread-A', `a ${tag} marker leaves the reply anchor's thread`);
    // The liveness repair still runs for a marker, as for any message: a
    // server sending channels/incoming for a channel decided open is
    // evidence that its transport is open.
    assert.equal(registry.isChannelOpen(discord('chanB')), true, `a ${tag} marker still repairs chanB's open state`);
    // On the anchor's own channel, a marker leaves the anchor too.
    registry.handleIncoming('discord', incoming('chanA', `[${tag}] marker on A`, undefined, [tag]));
    registry.noteDelivered(discord('chanA'), 'marker-chanA', undefined, [tag]);
    const sameChannel = registry.buildChannelContext(undefined, 'discord')?.incoming;
    assert.equal(sameChannel?.messageId, 'm1', `a ${tag} marker on the anchor's channel leaves its message`);
    assert.equal(sameChannel?.threadId, 'thread-A', `a ${tag} marker on the anchor's channel leaves its thread`);
  }

  // A real message still retargets: the skip is tag-scoped, not a freeze.
  const real = incoming('chanB', 'real message on B', undefined, undefined, 'thread-B');
  real.messages[0]!.messageId = 'm2';
  registry.handleIncoming('discord', real);
  registry.noteDelivered(discord('chanB'), 'm2', 'thread-B');
  assert.deepEqual(registry.getDefaultPublishChannel(), discord('chanB'));
  const after = registry.buildChannelContext(undefined, 'discord')?.incoming;
  assert.equal(after?.messageId, 'm2', 'a real message becomes the reply anchor');
  assert.equal(after?.threadId, 'thread-B', 'with its own thread');
  // One with no thread leaves none behind.
  const unthreaded = incoming('chanA', 'real message on A, no thread');
  unthreaded.messages[0]!.messageId = 'm3';
  registry.handleIncoming('discord', unthreaded);
  registry.noteDelivered(discord('chanA'), 'm3');
  const last = registry.buildChannelContext(undefined, 'discord')?.incoming;
  assert.equal(last?.messageId, 'm3', 'a real message with no thread becomes the reply anchor');
  assert.equal(last?.threadId, undefined, 'and takes no thread from the one before it');
});

test('a chat:system notice leaves the default publish locus where the conversation is, ambient or addressed by its place (RFC-001 rev 3)', async () => {
  // The weather line that took a resident's DM reply into a world: tagged
  // as overheard chatter, it became the most recent inbound message.
  // On this branch the latest delivered inbound is recorded at admission
  // (noteDelivered, with the message's tags), not at ingestion, so each
  // message is delivered here as the framework delivers it.
  const deliver = (message: ReturnType<typeof incoming>): void => {
    registry.handleIncoming('discord', message);
    const m = message.messages[0]!;
    registry.noteDelivered(discord(m.channelId), m.messageId, m.threadId, m.tags);
  };
  const { registry } = makeRegistry(undefined);
  seedRegistered(registry, 'discord', 'chanA');
  seedRegistered(registry, 'discord', 'world');
  deliver(incoming('chanA', 'the conversation'));
  deliver(incoming('world', '* world weather: clear (forecast)', undefined,
    ['chat:ambient', 'chat:system', 'eidoverse:weather']));
  assert.deepEqual(registry.getDefaultPublishChannel(), discord('chanA'),
    'the forecast must not become where unaddressed speech goes');
  // A notice addressed by its place (a pin in a DM: chat:dm ⇒ addressed)
  // is still a notice: kind and addressing are separate facets.
  seedRegistered(registry, 'discord', 'dm');
  const pin = incoming('dm', '[pinned a message]', undefined, ['chat:dm', 'chat:system']);
  pin.messages[0]!.messageId = 'm-pin';
  deliver(pin);
  assert.deepEqual(registry.getDefaultPublishChannel(), discord('chanA'),
    'a notice in a DM steers nothing either');
});

test('a marker on a NEVER-conversed channel leaves the locus null, not marker-anchored (#157)', async () => {
  const { registry } = makeRegistry(undefined);
  seedRegistered(registry, 'discord', 'chanB');
  const marker = incoming('chanB', '[edited] marker', undefined, ['chat:edited']);
  registry.handleIncoming('discord', marker);
  // Recorded at admission (noteDelivered), with the marker's tags.
  registry.noteDelivered(discord('chanB'), marker.messages[0]!.messageId, undefined, marker.messages[0]!.tags);
  assert.equal(registry.getDefaultPublishChannel(), null,
    'an edit marker alone must not establish a publish locus');
  assert.equal(registry.buildChannelContext(undefined, 'discord')?.incoming, undefined,
    'nor a reply anchor');
});

test('proseTargetFor: one whitespace-free token per channel that resolves back to it', async () => {
  const { registry } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'discord:dm:555', type: 'discord', label: 'DM: antra', direction: 'bidirectional',
        metadata: { channelType: 'dm', recipientName: 'antra', recipientId: '134390790938951680' } },
      // A DM known only by its label (no metadata): still "@name".
      { id: 'discord:dm:557', type: 'discord', label: 'DM: _reim0n', direction: 'bidirectional' },
      { id: 'discord:g1:100', type: 'discord', label: "#fable (antra's server)", direction: 'bidirectional' },
      { id: 'discord:g1:101', type: 'discord', label: '#ops', direction: 'bidirectional' },
      // Same name in two guilds: "#lobby" is ambiguous, the full labels have spaces → the id.
      { id: 'discord:g1:102', type: 'discord', label: '#lobby (antra\'s server)', direction: 'bidirectional' },
      { id: 'discord:g2:200', type: 'discord', label: '#lobby (Connectome)', direction: 'bidirectional' },
    ],
  } as never);

  const expected: Record<string, string> = {
    'discord:dm:555': '@antra',
    'discord:dm:557': '@_reim0n',
    'discord:g1:100': '#fable',
    'discord:g1:101': '#ops',
    'discord:g1:102': 'discord:g1:102',
    'discord:g2:200': 'discord:g2:200',
  };
  for (const [id, want] of Object.entries(expected)) {
    const t = registry.proseTargetFor(discord(id));
    assert.equal(t, want, `target for ${id}`);
    // The property that matters: the grammar reads it whole, and it routes back here.
    assert.equal(parseProsePrefix(`>>${t} hello`).target, t, `${t} parses as one target`);
    const r = registry.resolveProseTarget(t!);
    assert.ok('channelId' in r && r.channelId === id, `${t} resolves to ${id}`);
  }
  assert.equal(registry.proseTargetFor(discord('discord:nowhere')), undefined, 'unregistered → undefined');
});

test('proseTargetFor: a channel whose id another server shares gets a token that resolves back on its own server', async () => {
  const { registry } = makeRegistry({ delivered: true });
  // The same channel id registered by two connections: a target naming the
  // channel by id alone means both, so each one's token is a label of its own
  // or its server-qualified id.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'chan:7', type: 'discord', label: '#shared-a', direction: 'bidirectional' }],
  } as never);
  await registry.handleChanged('discord-b', {
    added: [{ id: 'chan:7', type: 'discord', label: '#shared-b', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.proseTargetFor({ serverId: 'discord-a', channelId: 'chan:7' }), '#shared-a');
  assert.equal(registry.proseTargetFor({ serverId: 'discord-b', channelId: 'chan:7' }), '#shared-b');

  // With one label between them as well, only the server-qualified id names either.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'chan:9', type: 'discord', label: '#same', direction: 'bidirectional' }],
  } as never);
  await registry.handleChanged('discord-b', {
    added: [{ id: 'chan:9', type: 'discord', label: '#same', direction: 'bidirectional' }],
  } as never);
  for (const serverId of ['discord-a', 'discord-b']) {
    const t = registry.proseTargetFor({ serverId, channelId: 'chan:9' });
    assert.equal(t, `${serverId}:chan:9`);
    assert.equal(parseProsePrefix(`>>${t} hello`).target, t, `${t} parses as one target`);
    const r = registry.resolveProseTarget(t!);
    assert.ok('channelId' in r && r.channelId === 'chan:9' && r.serverId === serverId, `${t} resolves back on ${serverId}`);
  }

  // An id with whitespace and a label with whitespace: nothing parses as one target.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'thread 42', type: 'discord', label: 'thread 42', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.proseTargetFor({ serverId: 'discord-a', channelId: 'thread 42' }), undefined);

  // The server is honoured: a channel registered only on discord-a isn't named for discord-b.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'chan:8', type: 'discord', label: '#only-a', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.proseTargetFor({ serverId: 'discord-a', channelId: 'chan:8' }), '#only-a');
  assert.equal(registry.proseTargetFor({ serverId: 'discord-b', channelId: 'chan:8' }), undefined);
});

// ---------------------------------------------------------------------------
// Inbound-only channels (SPEC §14.2 `direction: 'inbound'`): the host posts
// nothing into them. pocket-body declares its live transcript this way and
// refuses publishes there, and another agent speaking in the room arrives on
// it addressed, so a resident's plain speech can be aimed at it.
// ---------------------------------------------------------------------------

async function registerInboundOnly(registry: ChannelRegistry): Promise<void> {
  await registry.handleChanged('body', {
    added: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
}

test('plain speech into a channel its server declared inbound-only is refused before the channel is opened or published to', async () => {
  const { registry, failures, traces, publishCalls, openCalls } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);
  assert.equal(registry.isChannelOpen(body('body:ears')), false, 'precondition: registered closed');

  const result = await registry.routeSpeech('linn', 'Hello, room.', body('body:ears'));

  assert.equal(result, null, 'nothing was delivered');
  assert.deepEqual(publishCalls, [], 'nothing was published');
  assert.deepEqual(openCalls, [], 'the delivery attempt did not open the channel');
  assert.equal(registry.isChannelOpen(body('body:ears')), false);
  assert.equal(failures.length, 1, 'the refusal reaches the resident as a send failure');
  assert.equal(failures[0]!.channelId, 'body:ears');
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  assert.match(failures[0]!.reason, /use that server's own tools$/);
  assert.ok(traces.some((t) => t.type === 'mcpl:speech-route-failed' && t.channelId === 'body:ears'));
});

test('publish() itself refuses an inbound-only channel, so a drafts resend, which names the server, is refused before anything opens', async () => {
  const { registry, failures, publishCalls, openCalls } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);

  // As a drafts resend calls it: an exact destination, no speech routing.
  const outcome = await registry.publish('linn', 'held words', { serverId: 'body', channelId: 'body:ears' });

  assert.equal(outcome.status, 'failed', 'nothing was posted');
  assert.deepEqual(outcome.destination, { serverId: 'body', channelId: 'body:ears', label: 'Body · ears' });
  assert.match(outcome.reason ?? '', /^inbound-only: server "body" declared this channel's direction "inbound"/);
  assert.deepEqual(openCalls, [], 'the closed channel was not opened');
  assert.deepEqual(publishCalls, []);
  assert.deepEqual(failures, [], "the caller reports it: publish() writes no marker of its own");
});

test('channel_publish into an inbound-only channel is refused, naming the declaration, and publishes nothing', async () => {
  const { registry, publishCalls } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);

  const result = await registry.handleChannelToolCall('channel_publish', {
    channelId: 'body:ears',
    content: 'Hello, room.',
  });

  assert.equal(result.success, false);
  assert.equal(result.isError, true);
  assert.match(String(result.error), /^Channel body:ears is inbound-only: server "body" declared this channel's direction "inbound"/);
  assert.deepEqual(publishCalls, [], 'nothing was published');
});

test('no outgoing stream starts in an inbound-only channel', async () => {
  const { registry, streamCalls } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);

  registry.sendOutgoingChunk({ serverId: 'body', channelId: 'body:ears' }, 'linn', 'inf_1', 0, 'Hello');
  registry.sendOutgoingComplete({ serverId: 'body', channelId: 'body:ears' }, 'linn', 'inf_1', 'Hello');

  assert.deepEqual(streamCalls, []);
});

/**
 * A registry over connections the test names and can replace, as a
 * server's reconnect does, each recording the stream messages it gets.
 */
function makeStreamingRegistry() {
  const sent: Array<{ to: string; kind: 'chunk' | 'complete'; channelId: string; inferenceId: string; text: string }> = [];
  let thrown = 0;
  const connection = (name: string) => ({
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    refuses: false,
    sendChannelsOutgoingChunk(p: { channelId: string; inferenceId: string; delta: string }) {
      if (this.refuses) { thrown++; throw new Error('transport closed'); }
      sent.push({ to: name, kind: 'chunk', channelId: p.channelId, inferenceId: p.inferenceId, text: p.delta });
    },
    sendChannelsOutgoingComplete(p: { channelId: string; inferenceId: string; content: Array<{ text: string }> }) {
      if (this.refuses) { thrown++; throw new Error('transport closed'); }
      sent.push({ to: name, kind: 'complete', channelId: p.channelId, inferenceId: p.inferenceId, text: p.content[0]!.text });
    },
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async () => ({}),
  });
  const servers = new Map<string, ReturnType<typeof connection>>();
  const serverRegistry = { getServer: (id: string) => servers.get(id) ?? null } as unknown as McplServerRegistry;
  const registry = new ChannelRegistry(serverRegistry, {} as FeatureSetManager, () => {}, () => {});
  return {
    registry,
    sent,
    /** How many sends a refusing connection has thrown on. */
    thrown: () => thrown,
    /** The server's connection, named `name` in `sent`, in place of any earlier one. */
    connect: (serverId: string, name = serverId) => { servers.set(serverId, connection(name)); },
    /** Registers a channel of the server's, as channels/changed does. */
    register: (serverId: string, channelId: string, direction?: 'inbound') =>
      registry.handleChanged(serverId, { added: [{ id: channelId, type: 'chat', label: channelId, ...(direction ? { direction } : {}) }] } as never),
    /** Whether the server's connection throws on each stream message, as one whose transport has closed can. */
    refuse: (serverId: string, refuse: boolean) => { servers.get(serverId)!.refuses = refuse; },
    /** The server's grant without `channels.streaming`, as a reducing featureSets/update leaves it. */
    revokeStreaming: (serverId: string) => {
      servers.get(serverId)!.grant = new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.streaming')), []);
    },
    /** How many streams the registry still keeps a record of. */
    streamsKept: () => (registry as unknown as { takenStreams: Map<string, unknown> }).takenStreams.size,
  };
}

const at = (serverId: string, channelId: string) => ({ serverId, channelId });

test("a stream that started in a channel goes on there and ends there after its server declares the channel inbound-only, and a new stream starts nothing there", async () => {
  const { registry, sent, connect, register } = makeStreamingRegistry();
  connect('body');
  await register('body', 'body:room');

  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 0, 'Hello');
  await registry.handleChanged('body', {
    updated: [{ id: 'body:room', type: 'chat', label: 'body:room', direction: 'inbound' }],
  } as never);
  // A publish delivered before the declaration, streamed after it.
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 1, '\n\nand more');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_1', 'Hello\n\nand more');
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_2', 0, 'Later');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_2', 'Later');

  assert.deepEqual(sent, [
    { to: 'body', kind: 'chunk', channelId: 'body:room', inferenceId: 'inf_1', text: 'Hello' },
    { to: 'body', kind: 'chunk', channelId: 'body:room', inferenceId: 'inf_1', text: '\n\nand more' },
    { to: 'body', kind: 'complete', channelId: 'body:room', inferenceId: 'inf_1', text: 'Hello\n\nand more' },
  ], 'the stream the channel took goes on to its end there, and the next stream starts nothing');
});

test('two servers whose channels share an id are two destinations: each gets only its own part of a stream, its complete included', async () => {
  const { registry, sent, connect, register } = makeStreamingRegistry();
  connect('a');
  connect('b');
  await register('a', 'room');
  await register('b', 'room');

  registry.sendOutgoingChunk(at('a', 'room'), 'linn', 'inf_1', 0, 'to a');
  registry.sendOutgoingChunk(at('b', 'room'), 'linn', 'inf_1', 1, 'to b');
  registry.sendOutgoingComplete(at('a', 'room'), 'linn', 'inf_1', 'to a');
  registry.sendOutgoingComplete(at('b', 'room'), 'linn', 'inf_1', 'to b');

  assert.deepEqual(sent.map((s) => [s.to, s.kind, s.text]), [
    ['a', 'chunk', 'to a'], ['b', 'chunk', 'to b'], ['a', 'complete', 'to a'], ['b', 'complete', 'to b'],
  ]);
});

test("a channel id that passes from one server to another mid-stream: what's published to the new server streams there, and the old server gets none of it", async () => {
  const { registry, sent, connect, register } = makeStreamingRegistry();
  connect('a');
  connect('b');
  await register('a', 'room');

  registry.sendOutgoingChunk(at('a', 'room'), 'linn', 'inf_1', 0, 'to a');
  await registry.handleChanged('a', { removed: ['room'] } as never);
  await register('b', 'room');
  registry.sendOutgoingChunk(at('b', 'room'), 'linn', 'inf_1', 1, 'to b');
  registry.sendOutgoingComplete(at('a', 'room'), 'linn', 'inf_1', 'to a');
  registry.sendOutgoingComplete(at('b', 'room'), 'linn', 'inf_1', 'to b');

  assert.deepEqual(sent.map((s) => [s.to, s.kind, s.text]), [
    ['a', 'chunk', 'to a'], ['b', 'chunk', 'to b'], ['b', 'complete', 'to b'],
  ], 'a, which no longer registers the channel, gets no complete');
});

test('a server disconnected and connected again mid-stream gets the rest of the stream once it registers the channel again, and nothing before', async () => {
  const { registry, sent, connect, register } = makeStreamingRegistry();
  connect('body', 'first');
  await register('body', 'body:room');

  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 0, 'Hello');
  // The framework's disconnect path: the server's channels go with it.
  registry.removeServer('body');
  connect('body', 'second');
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 1, '\n\nwhile away');
  await register('body', 'body:room');
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 2, '\n\nback');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_1', 'Hello\n\nwhile away\n\nback');

  assert.deepEqual(sent.map((s) => [s.to, s.kind, s.text]), [
    ['first', 'chunk', 'Hello'],
    ['second', 'chunk', '\n\nback'],
    ['second', 'complete', 'Hello\n\nwhile away\n\nback'],
  ], 'a consumer that kept its utterance across the reconnect reconciles it from the complete');
});

test('a destination no chunk of a stream started at gets no complete for it, and a stream that started there gets one, once', async () => {
  const { registry, sent, connect, register, revokeStreaming } = makeStreamingRegistry();
  connect('a');
  connect('b');
  await register('a', 'room');
  await register('a', 'hall');
  await register('b', 'room');
  revokeStreaming('b');

  // b's grant doesn't take the stream, so nothing starts there.
  registry.sendOutgoingChunk(at('b', 'room'), 'linn', 'inf_1', 0, 'to b');
  registry.sendOutgoingChunk(at('a', 'room'), 'linn', 'inf_1', 1, 'to a');
  registry.sendOutgoingComplete(at('b', 'room'), 'linn', 'inf_1', 'to b');
  registry.sendOutgoingComplete(at('a', 'hall'), 'linn', 'inf_1', 'never sent');
  registry.sendOutgoingComplete(at('a', 'room'), 'linn', 'inf_1', 'to a');
  registry.sendOutgoingComplete(at('a', 'room'), 'linn', 'inf_1', 'to a');
  registry.sendOutgoingComplete(at('a', 'room'), 'linn', 'inf_9', 'no such stream');

  assert.deepEqual(sent.map((s) => [s.to, s.kind, s.inferenceId]), [['a', 'chunk', 'inf_1'], ['a', 'complete', 'inf_1']]);
});

test("a stream's rest goes nowhere once its server's grant has lost channels.streaming, and its record goes with its complete", async () => {
  const { registry, sent, connect, register, revokeStreaming, streamsKept } = makeStreamingRegistry();
  connect('body');
  await register('body', 'body:room');

  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 0, 'Hello');
  revokeStreaming('body');
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 1, '\n\nand more');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_1', 'Hello\n\nand more');

  assert.deepEqual(sent.map((s) => [s.kind, s.text]), [['chunk', 'Hello']]);
  assert.equal(streamsKept(), 0, 'the complete that went nowhere still ended the record');
});

test("two streams at one destination are kept apart: one's complete leaves the other going on", async () => {
  const { registry, sent, connect, register } = makeStreamingRegistry();
  connect('body');
  await register('body', 'body:room');

  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 0, 'one');
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_2', 0, 'two');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_1', 'one');
  await registry.handleChanged('body', {
    updated: [{ id: 'body:room', type: 'chat', label: 'body:room', direction: 'inbound' }],
  } as never);
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_2', 1, '\n\nstill two');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_2', 'two\n\nstill two');

  assert.deepEqual(sent.map((s) => [s.kind, s.inferenceId, s.text]), [
    ['chunk', 'inf_1', 'one'], ['chunk', 'inf_2', 'two'], ['complete', 'inf_1', 'one'],
    ['chunk', 'inf_2', '\n\nstill two'], ['complete', 'inf_2', 'two\n\nstill two'],
  ]);
});

test("a chunk whose send throws still started the stream, so its complete follows, for the consumer to reconcile; a complete whose send throws throws nothing out", async () => {
  const { registry, sent, thrown, connect, register, refuse } = makeStreamingRegistry();
  connect('body');
  await register('body', 'body:room');

  refuse('body', true);
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 0, 'Hello');
  refuse('body', false);
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_1', 'Hello');
  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_2', 0, 'Hi');
  refuse('body', true);
  assert.doesNotThrow(() => registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_2', 'Hi'));

  assert.equal(thrown(), 2, 'the chunk and the second complete each reached the connection and threw');
  assert.deepEqual(sent.map((s) => [s.kind, s.inferenceId]), [['complete', 'inf_1'], ['chunk', 'inf_2']]);
});

test('a stream keeps no record in the registry once each destination it started at has its complete', async () => {
  // Every stream records where it started. A record that outlived its
  // stream would stay for as long as the process runs.
  const { registry, connect, register, streamsKept } = makeStreamingRegistry();
  connect('body');
  await register('body', 'body:room');
  await register('body', 'body:hall');

  registry.sendOutgoingChunk(at('body', 'body:room'), 'linn', 'inf_1', 0, 'Hello');
  registry.sendOutgoingChunk(at('body', 'body:hall'), 'linn', 'inf_1', 1, 'Hi');
  registry.sendOutgoingComplete(at('body', 'body:room'), 'linn', 'inf_1', 'Hello');
  assert.equal(streamsKept(), 1, 'the stream still has the hall to end');
  registry.sendOutgoingComplete(at('body', 'body:hall'), 'linn', 'inf_1', 'Hi');
  assert.equal(streamsKept(), 0);
});

/** Never called: tsc checks it. A stream goes to the destination its publish
 *  went to, so a bare channel id, which would be resolved again at each call,
 *  is no stream target. */
function streamTakesOnlyADestination(registry: ChannelRegistry): void {
  // @ts-expect-error a bare channel id isn't a destination
  registry.sendOutgoingChunk('body:room', 'linn', 'inf_1', 0, 'Hello');
  // @ts-expect-error a bare channel id isn't a destination
  registry.sendOutgoingComplete('body:room', 'linn', 'inf_1', 'Hello');
}
void streamTakesOnlyADestination;

test("two destinations whose ids join to the same string, registered one after the other, are still two destinations to the stream", async () => {
  // Server a's channel `b:room` and server a:b's channel `room` would both be
  // `a:b:room` joined with a colon.
  const { registry, sent, connect, register } = makeStreamingRegistry();
  connect('a');
  connect('a:b');
  await register('a', 'b:room');

  registry.sendOutgoingChunk(at('a', 'b:room'), 'linn', 'inf_1', 0, 'to a');
  await registry.handleChanged('a', { removed: ['b:room'] } as never);
  await register('a:b', 'room');
  await registry.handleChanged('a:b', {
    updated: [{ id: 'room', type: 'chat', label: 'room', direction: 'inbound' }],
  } as never);
  // A new stream at a:b's inbound-only channel: it starts nothing there.
  registry.sendOutgoingChunk(at('a:b', 'room'), 'linn', 'inf_1', 1, 'to a:b');
  registry.sendOutgoingComplete(at('a', 'b:room'), 'linn', 'inf_1', 'to a');
  registry.sendOutgoingComplete(at('a:b', 'room'), 'linn', 'inf_1', 'to a:b');

  assert.deepEqual(sent.map((s) => [s.to, s.kind, s.text]), [['a', 'chunk', 'to a']],
    "a, which no longer registers b:room, gets no complete, and a:b's stream never started");
});

test('a channel declared outbound or bidirectional, or with no direction, still takes speech, channel_publish and the stream', async () => {
  const { registry, failures, publishCalls, streamCalls } = makeRegistry({ delivered: true });
  await registry.handleChanged('body', {
    added: [
      { id: 'body:out', type: 'chat', label: 'out', direction: 'outbound' },
      { id: 'body:both', type: 'chat', label: 'both', direction: 'bidirectional' },
      { id: 'body:unstated', type: 'chat', label: 'unstated' },
    ],
  } as never);

  for (const id of ['body:out', 'body:both', 'body:unstated']) {
    assert.ok(await registry.routeSpeech('linn', `speech to ${id}`, body(id)), `speech delivered to ${id}`);
    const published = await registry.handleChannelToolCall('channel_publish', { channelId: id, content: `publish to ${id}` });
    assert.equal(published.success, true, `channel_publish delivered to ${id}`);
    registry.sendOutgoingChunk({ serverId: 'body', channelId: id }, 'linn', 'inf_1', 0, 'x');
  }

  assert.deepEqual(failures, []);
  assert.deepEqual(publishCalls.map((c) => c.channelId), [
    'body:out', 'body:out', 'body:both', 'body:both', 'body:unstated', 'body:unstated',
  ]);
  assert.deepEqual(streamCalls.map((c) => c.channelId), ['body:out', 'body:both', 'body:unstated']);
});

test('inboundOnlyServer names the declaring server for an inbound-only channel, and nothing for any other', async () => {
  // The routing notices ask the registry this, so they say what routeSpeech does.
  const { registry } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);
  await registry.handleChanged('body', {
    added: [
      { id: 'body:out', type: 'chat', label: 'out', direction: 'outbound' },
      { id: 'body:both', type: 'chat', label: 'both', direction: 'bidirectional' },
      { id: 'body:unstated', type: 'chat', label: 'unstated' },
    ],
  } as never);

  assert.equal(registry.inboundOnlyServer(body('body:ears')), 'body');
  for (const id of ['body:out', 'body:both', 'body:unstated', 'body:unregistered']) {
    assert.equal(registry.inboundOnlyServer(body(id)), undefined, id);
  }
});

test('the refusal follows the descriptor its server declared last: channels/register, and channels/changed updates either way', async () => {
  const { registry, failures, publishCalls } = makeRegistry({ delivered: true });

  // channels/register declares it inbound-only.
  await registry.handleRegister('body', {
    channels: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
  assert.equal(await registry.routeSpeech('linn', 'one', body('body:ears')), null);
  assert.equal(registry.inboundOnlyServer(body('body:ears')), 'body');

  // An update declares it bidirectional: speech goes out.
  await registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' }],
  } as never);
  assert.ok(await registry.routeSpeech('linn', 'two', body('body:ears')));
  assert.equal(registry.inboundOnlyServer(body('body:ears')), undefined);

  // Another declares it inbound-only again: refused again.
  await registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
  assert.equal(await registry.routeSpeech('linn', 'three', body('body:ears')), null);

  assert.deepEqual(publishCalls.map((c) => c.channelId), ['body:ears'], 'only the bidirectional turn published');
  assert.equal(failures.length, 2);
  for (const f of failures) {
    assert.match(f.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  }
});

test('publishForAgent into an inbound-only channel is refused and traced as failed; into any other channel it traces once as routed, after the publish', async () => {
  const { registry, publishCalls, traces } = makeRegistry({ delivered: true, messageId: 'm-77' } as { delivered: boolean });
  await registerInboundOnly(registry);
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  const routed = () => traces.filter((t) => t.type === 'mcpl:speech-routed');

  const refused = await registry.publishForAgent('body:ears', 'a thought', 'Subconscious');
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /inbound-only: server "body" declared this channel's direction "inbound"/);
  assert.equal(refused.reason, 'inbound-only');
  assert.equal(publishCalls.length, 0, 'nothing was published');
  assert.equal(routed().length, 0, 'speech that was never posted is not traced as routed');
  const failed = traces.filter((t) => t.type === 'mcpl:speech-route-failed');
  assert.equal(failed.length, 1, 'the refusal is traced as a failure');
  assert.equal(failed[0]!.conversationId, 'Subconscious');
  assert.equal(failed[0]!.channelId, 'body:ears');
  assert.match(String(failed[0]!.reason), /inbound-only: server "body" declared/);
  assert.equal(failed[0]!.outcome, 'failed', 'nothing was published');

  const posted = await registry.publishForAgent('body:home', 'a thought', 'Subconscious');
  assert.equal(posted.success, true);
  assert.equal('reason' in posted, false);
  assert.deepEqual(publishCalls.map((c) => c.channelId), ['body:home']);
  // Shaped as routeSpeech's trace is, but without the surface's message id,
  // though the server named one ('m-77').
  assert.deepEqual(routed(), [{
    type: 'mcpl:speech-routed', conversationId: 'Subconscious', serverId: 'body', channelId: 'body:home',
    delivered: true, textLen: 'a thought'.length, text: 'a thought',
  }], "no messageId: connectome-host's TTS relay keeps every routed trace without reading conversationId, "
    + 'and when an interruption of the resident matches no entry it edits the newest traced message in the '
    + "channel, so an id here would let it trim the subconscious's post");
});

test('publishForAgent traces a publish the server reports undelivered as failed, not routed', async () => {
  const { registry, publishCalls, traces } = makeRegistry({ delivered: false });
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);

  const undelivered = await registry.publishForAgent('body:home', 'a thought', 'Subconscious');

  assert.deepEqual(publishCalls.map((c) => c.channelId), ['body:home']);
  assert.equal('reason' in undelivered, false, 'a publish that went out carries no reason');
  assert.deepEqual(traces.filter((t) => t.type === 'mcpl:speech-routed'), []);
  assert.deepEqual(
    traces.filter((t) => t.type === 'mcpl:speech-route-failed').map((t) => [t.conversationId, t.channelId, t.reason, t.outcome]),
    [['Subconscious', 'body:home', 'the "body" server said it didn\'t post the message', 'failed']],
  );
});

test("publishForAgent traces what a rejected publish may have done: unknown after an error response or a timeout, failed when the request never left", async () => {
  const { registry, traces, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  const failed = () => traces.filter((t) => t.type === 'mcpl:speech-route-failed');

  // An error response may follow a partial post.
  setOnPublish(async () => {
    throw new McplRequestError('The "body" server answered with an error: Rate limited after part 1', 'error-response', { posted: ['m-1'] });
  });
  const unconfirmed = await registry.publishForAgent('body:home', 'a long thought', 'Subconscious');
  assert.equal('reason' in unconfirmed, false, 'a publish that went out carries no reason');
  assert.equal(unconfirmed.error, 'Posting to channel "body:home" wasn\'t confirmed: The "body" server answered with an error: Rate limited after part 1 (delivery uncertain). It may or may not have been posted, so sending it again could post it twice. Connector detail: {"posted":["m-1"]}');
  assert.deepEqual(failed().map((t) => [t.reason, t.outcome, t.detail]),
    [['The "body" server answered with an error: Rate limited after part 1 (delivery uncertain)', 'unknown', '{"posted":["m-1"]}']],
    "the trace carries the connector's detail, as plain speech's does");

  // So may a request that went out and got no answer.
  setOnPublish(async () => {
    throw new McplRequestError('MCPL server "body" did not respond to channels/publish within 30000ms', 'no-response');
  });
  const timedOut = await registry.publishForAgent('body:home', 'a thought', 'Subconscious');
  assert.equal('reason' in timedOut, false, 'nor does one that timed out');
  assert.equal(failed()[1]!.outcome, 'unknown');

  // Only a request that never left proves nothing was posted.
  setOnPublish(async () => {
    throw new McplRequestError('Cannot send request: connection to "body" is closed', 'not-sent');
  });
  const notSent = await registry.publishForAgent('body:home', 'another', 'Subconscious');
  assert.equal(notSent.error, 'Nothing was posted to channel "body:home": Cannot send request: connection to "body" is closed.');
  assert.equal(notSent.reason, 'not-sent', 'one whose request was refused before anything was written is a refusal');
  assert.equal(failed()[2]!.outcome, 'failed');
  assert.equal('detail' in failed()[2]!, false, 'no detail when the connector sent none');
  assert.equal(traces.filter((t) => t.type === 'mcpl:speech-routed').length, 0);
});

test('buildChannelContext names no defaultOutgoing for a locus its server declared inbound-only', async () => {
  const active: Record<string, ChannelRef> = { linn: body('body:ears'), nell: body('body:home') };
  const { registry } = makeRegistry({ delivered: true }, () => undefined, (n) => active[n]);
  await registerInboundOnly(registry);
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);

  assert.equal(registry.buildChannelContext('linn', 'body')?.defaultOutgoing, undefined, 'speech goes nowhere, so no channel is named');
  assert.equal(registry.buildChannelContext('nell', 'body')?.defaultOutgoing?.channelId, 'body:home');
});

test('an inbound-only channel resolves as a speech target to an error naming the declaration, and still resolves for reading', async () => {
  const { registry } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);

  const speech = registry.resolveProseTarget('body:ears', { forSpeech: true });
  assert.ok('error' in speech, 'refused as a target for speech');
  assert.match(
    (speech as { error: string }).error,
    /^body:ears is inbound-only: server "body" declared this channel's direction "inbound"/,
  );
  // It names the refused channel, which a name that resolves to nothing doesn't.
  assert.equal((speech as { refusedChannelId?: string }).refusedChannelId, 'body:ears');
  const nowhere = registry.resolveProseTarget('#nowhere', { forSpeech: true });
  assert.ok('error' in nowhere && !('refusedChannelId' in nowhere), 'an unknown name is no refusal');
  // Reading its history still finds it.
  assert.deepEqual(registry.resolveProseTarget('body:ears'), { channelId: 'body:ears', serverId: 'body', label: 'Body · ears' });
  assert.deepEqual(registry.resolveProseTargetDurable('body:ears'), { channelId: 'body:ears', serverId: 'body', label: 'Body · ears' },
    'a live channel resolves on the live path, with its server');
  // No reply token is offered for it; one is for the bidirectional channel.
  assert.equal(registry.proseTargetFor(body('body:ears')), undefined);
  assert.ok(registry.proseTargetFor(body('body:home')));
  // A bidirectional channel resolves either way.
  assert.deepEqual(registry.resolveProseTarget('body:home', { forSpeech: true }), { channelId: 'body:home', serverId: 'body', label: 'Body · home' });
});

test('a channel declared inbound-only while the host opens it for speech is refused before the publish, and stays open with the open\'s notice', async () => {
  const autoOpened: Array<{ source: string; channels: Array<{ channelId: string }> }> = [];
  const { registry, publishCalls, openCalls, closeCalls, failures, setOnOpen } =
    makeRegistry({ delivered: true }, undefined, undefined, (info) => autoOpened.push(info));
  await registry.handleRegister('body', {
    channels: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' }],
  } as never);
  // Registering reconciles the channel to its default, closed, which sends
  // one channels/close; the claim below is about what happens after that.
  const closesAtRegistration = closeCalls.length;
  setOnOpen(async () => {
    await registry.handleChanged('body', {
      updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
    } as never);
  });

  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:ears')), null);
  assert.deepEqual(openCalls.map((c) => c.channelId), ['body:ears'], 'the closed channel was opened');
  assert.equal(publishCalls.length, 0, 'nothing was published after the declaration');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  // The open happened, whatever the recheck decided: the channel stays open,
  // and the open's notice, which says how to close it, went out with the marker.
  assert.equal(registry.isChannelOpen(body('body:ears')), true, 'the opened channel stays open');
  assert.equal(closeCalls.length, closesAtRegistration, 'nothing closes it after the open');
  assert.deepEqual(autoOpened.map((n) => [n.source, n.channels.map((c) => c.channelId)]), [['opened-by-delivery', ['body:ears']]]);
});

test("publishForAgent's routed trace names the server it published through, though the channel is removed while the reply is pending", async () => {
  const { registry, traces, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnPublish(async () => {
    await registry.handleChanged('body', { removed: ['body:home'] } as never);
  });

  const posted = await registry.publishForAgent('body:home', 'a thought', 'Subconscious');
  assert.equal(posted.success, true);
  const routed = traces.filter((t) => t.type === 'mcpl:speech-routed');
  assert.equal(routed.length, 1);
  assert.equal(routed[0]!.serverId, 'body');
});

test("a server's error response to the publish goes through fail() as unconfirmed: a trace and the send-failure marker (R1-2)", async () => {
  const { registry, failures, traces, publishCalls, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnPublish(async () => {
    throw new McplRequestError('The "body" server answered with an error: Channel not permitted', 'error-response');
  });

  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:home')), null);
  assert.equal(publishCalls.length, 1, 'the publish was sent, and the server answered with an error');
  assert.deepEqual(failures.map((f) => f.reason), ['The "body" server answered with an error: Channel not permitted (delivery uncertain)'],
    "the marker gives the server's own words, and says delivery is uncertain");
  // An error response may follow a partial post, so whether it was posted is unknown.
  assert.deepEqual(failures.map((f) => f.outcome), ['unknown']);
  const failed = traces.filter((t) => t.type === 'mcpl:speech-route-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.channelId, 'body:home');
  assert.equal(failed[0]!.outcome, 'unknown');
  assert.equal(traces.filter((t) => t.type === 'mcpl:speech-routed').length, 0);
});

test("a lazily registered channel whose open answers inbound-only is refused before the publish, and stays refused (R1-3)", async () => {
  const announced: Array<{ source: string; channels: Array<{ channelId: string }> }> = [];
  const { registry, publishCalls, openCalls, failures, traces, setOpenResult } =
    makeRegistry({ delivered: true }, undefined, undefined, (info) => { announced.push(info); });
  registry.ensureChannelRegistered('body', 'body:ears', 'Body · ears');
  setOpenResult({ channel: { id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' } });

  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:ears')), null);
  assert.deepEqual(openCalls.map((c) => c.channelId), ['body:ears'], 'speech opened the channel, as for any closed locus');
  assert.equal(publishCalls.length, 0, 'nothing was published after the server declared it');
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  // The open happened, and the channel stays open: the notice says so, and
  // how to close it, while the marker reports the refused speech.
  assert.deepEqual(announced.map((a) => [a.source, a.channels.map((c) => c.channelId)]), [['opened-by-delivery', ['body:ears']]]);
  assert.equal(traces.filter((t) => t.type === 'mcpl:channel-opened-by-send').length, 1);
  assert.equal(registry.isChannelOpen(body('body:ears')), true);

  // The next speech is refused before anything goes to the server.
  assert.equal(await registry.routeSpeech('linn', 'again', body('body:ears')), null);
  assert.equal(openCalls.length, 1);
  assert.equal(publishCalls.length, 0);
  assert.equal(failures.length, 2);
});

test("an open's answer whose channel names no id is this channel's, so its inbound-only declaration applies (R1-3)", async () => {
  // The lifecycle work takes an answer whose channel has no id as the
  // requested channel's, not a substitution, so the declaration it carries
  // applies as well, and the speech is refused rather than posted.
  const { registry, publishCalls, openCalls, failures, setOpenResult } = makeRegistry({ delivered: true });
  registry.ensureChannelRegistered('body', 'body:ears', 'Body · ears');
  setOpenResult({ channel: { direction: 'inbound' } });

  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:ears')), null);
  assert.deepEqual(openCalls.map((c) => c.channelId), ['body:ears'], 'speech opened the channel');
  assert.equal(publishCalls.length, 0, 'nothing was published');
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  assert.equal(registry.isChannelOpen(body('body:ears')), true, 'the open stands');
});

test("an open's answer that declares no direction, or one that isn't inbound, leaves speech published (R1-3)", async () => {
  // An answer for another channel is a substitution, which fails the open
  // whatever it declares (channel-open-substitution.test.ts).
  for (const answer of [
    { channel: { id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' } },
    {},
  ]) {
    const { registry, publishCalls, failures, setOpenResult } = makeRegistry({ delivered: true });
    registry.ensureChannelRegistered('body', 'body:ears', 'Body · ears');
    setOpenResult(answer);
    assert.deepEqual(await registry.routeSpeech('linn', 'hello', body('body:ears')), { delivered: true, serverId: 'body', channelId: 'body:ears' },
      `published after the answer ${JSON.stringify(answer)}`);
    assert.equal(publishCalls.length, 1);
    assert.equal(failures.length, 0);
  }
});

test('a channel removed while the host opens it for speech is refused, and nothing is published (R1-3)', async () => {
  // Whatever the open's answer declares: there's no entry left to apply it to.
  for (const answer of [{}, { channel: { id: 'body:home', type: 'chat', label: 'Body · home', direction: 'inbound' } }]) {
    const { registry, publishCalls, openCalls, failures, setOnOpen, setOpenResult } = makeRegistry({ delivered: true });
    await registry.handleRegister('body', {
      channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
    } as never);
    setOpenResult(answer);
    setOnOpen(async () => {
      await registry.handleChanged('body', { removed: ['body:home'] } as never);
    });

    assert.equal(await registry.routeSpeech('linn', 'hello', body('body:home')), null);
    assert.deepEqual(openCalls.map((c) => c.channelId), ['body:home']);
    assert.equal(publishCalls.length, 0, 'nothing was published to the removed channel');
    assert.deepEqual(failures.map((f) => f.reason), ['opening the channel for these words didn\'t complete: the "body" server no longer lists the channel'],
      `refused as removed, after the answer ${JSON.stringify(answer)}`);
  }
});

test("a server's refusal of an open or a tool's publish reaches the agent in its own words", async () => {
  const refusal = () => new McplRequestError('The "body" server answered with an error: Channel unavailable', 'error-response');
  const { registry, failures, setOnOpen, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnOpen(async () => { throw refusal(); });
  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:home')), null);
  assert.deepEqual(failures.map((f) => f.reason), ['opening the channel for these words didn\'t complete: The "body" server answered with an error: Channel unavailable']);
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.error, 'Opening channel "body:home" didn\'t complete; the open stays recorded, and this host tries it again when the ' +
    '"body" server next registers this channel, if this host may open and close its channels then, or now if you call ' +
    'channel_open again. The "body" server answered with an error: Channel unavailable.');

  setOnOpen(undefined);
  setOnPublish(async () => { throw new McplRequestError('The "body" server answered with an error: Channel not permitted', 'error-response'); });
  const published = await registry.handleChannelToolCall('channel_publish', { channelId: 'body:home', content: 'hi' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(published.error, 'Posting to channel "body:home" wasn\'t confirmed: The "body" server answered with an error: Channel not permitted (delivery uncertain). It may or may not have been posted, so sending it again could post it twice.');
});

test("an open's answer can't lift an inbound-only declaration: a server lifts it by changing or registering the channel (R1-3)", async () => {
  const { registry, publishCalls, failures, setOpenResult } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
  setOpenResult({ channel: { id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' } });
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:ears' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.success, true);
  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:ears')), null, 'still refused after the answer');
  assert.equal(publishCalls.length, 0);
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared/);

  // The server's own change lifts it.
  await registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' }],
  } as never);
  assert.deepEqual(await registry.routeSpeech('linn', 'now', body('body:ears')), { delivered: true, serverId: 'body', channelId: 'body:ears' });
  assert.equal(publishCalls.length, 1);
});

test("an open's answer that arrives in the same read as a newer channels/changed can't lift its refusal (R1-3)", async () => {
  // Greta-2425's probe: the connection resolves the open's answer, then
  // handles the next line at once, so the answer is applied after, and
  // over, the channels/changed the server sent after it.
  let answerOpen!: (answer: unknown) => void;
  let openSent!: () => void;
  const opening = new Promise<void>((resolve) => { openSent = resolve; });
  const publishCalls: string[] = [];
  const failures: string[] = [];
  const mockServer = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (p: { channelId?: string }) => { publishCalls.push(String(p.channelId)); return { delivered: true }; },
    sendChannelsOutgoingChunk: () => {},
    sendChannelsOutgoingComplete: () => {},
    sendChannelsOpen: () => new Promise((resolve) => { answerOpen = resolve; openSent(); }),
    sendChannelsClose: async () => ({}),
  };
  const registry = new ChannelRegistry(
    { getServer: () => mockServer } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { onRouteFailure: (info) => { failures.push(info.reason); } },
  );
  await registry.handleChanged('body', {
    added: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' }],
  } as never);
  const delivery = registry.routeSpeech('linn', 'hello', body('body:ears'));
  await opening;
  answerOpen({ channel: { id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' } });
  void registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);

  assert.equal(await delivery, null);
  assert.deepEqual(publishCalls, [], 'nothing was published into the channel declared inbound-only');
  assert.match(failures[0]!, /^inbound-only: server "body" declared/);
});

test("an open by reconcile applies its answer too: a channel the answer declares inbound-only is refused (R1-3)", async () => {
  const { registry, publishCalls, openCalls, failures, setOpenResult } = makeRegistry({ delivered: true });
  const ears = { id: 'body:ears', type: 'chat', label: 'Body · ears' };
  await registry.handleRegister('body', { channels: [ears] } as never);
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:ears' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.success, true);
  // The server registers again, as after a reconnect, and reconcile reopens
  // the channel the agent opened: this time the answer declares it.
  setOpenResult({ channel: { ...ears, direction: 'inbound' } });
  await registry.handleRegister('body', { channels: [ears] } as never);
  assert.equal(openCalls.length, 2, 'reconcile opened it again');

  assert.equal(await registry.routeSpeech('linn', 'hello', body('body:ears')), null);
  assert.equal(publishCalls.length, 0);
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared/);
});

// A registry with body:home registered, counting the server's opens. An open
// raced by a close or by a re-registration is the lifecycle queue's
// (channel-lifecycle-order.test.ts).
async function withHome() {
  const made = makeRegistry({ delivered: true });
  const home = { id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' };
  await made.registry.handleRegister('body', { channels: [home] } as never);
  let opens = 0;
  made.setOnOpen(async () => { opens++; });
  return { ...made, home, opens: () => opens };
}

test("a reconcile's open answered while the channel is tuned out is recorded: a tune-out keeps the transport open", async () => {
  const { registry, home, opens } = await withHome();
  assert.equal(registry.isChannelOpen(body('body:home')), false);
  (registry as unknown as { setDesiredState(s: string, c: string, state: string, source: string): void })
    .setDesiredState('body', 'body:home', 'tuned-out', 'agent-tool');
  await registry.handleChanged('body', { added: [home] } as never);
  assert.equal(opens(), 1, "the announcement's reconcile opened it");
  assert.equal(registry.isChannelOpen(body('body:home')), true);
});
