import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { McplRequestError, McplServerConnection } from '../src/mcpl/server-connection.js';
import { parseProsePrefix } from '../src/mcpl/prose-grammar.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

type RouteFailure = { conversationId: string; channelId: string | null; reason: string; textLen: number; outcome?: 'failed' | 'unknown'; detail?: string };

/**
 * Build a registry with a mock server whose publish result is configurable,
 * plus capture arrays for route-failure notifications and emitted traces.
 */
function makeRegistry(
  publishResult: { delivered?: boolean } | undefined,
  homeChannelResolver?: (agentName: string) => string | undefined,
  activeChannelResolver?: (agentName: string) => string | undefined,
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
    },
  );

  // findChannelEntry is private; reach it the same way the typing test reaches
  // the channels map — a test-only cast, not part of the public surface.
  const lookup = (channelId: string) =>
    (registry as unknown as {
      findChannelEntry(id: string): { serverId: string; open: boolean; descriptor: { id: string; label: string; metadata?: Record<string, unknown> } } | undefined;
    }).findChannelEntry(channelId);

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
    if (!map.has(`${serverId}:${id}`)) {
      map.set(`${serverId}:${id}`, { serverId, descriptor: { id, type: serverId, label: id }, open: false });
    }
  }
}

test('handleIncoming REJECTS an unknown channel instead of minting it (§14.5)', async () => {
  const { registry, traces, lookup } = makeRegistry({ delivered: true });

  // Channel "post-boot-ch" was never registered via channels/register|changed.
  assert.equal(lookup('post-boot-ch'), undefined);

  registry.handleIncoming('discord', incoming('post-boot-ch', 'hi', '#cairn'));

  // §14.5: the unknown channel is NOT minted, the message is rejected with
  // a diagnostic, and the locus never becomes routable — a server cannot
  // self-attest a channel identity by messaging it into existence.
  assert.equal(lookup('post-boot-ch'), undefined, 'unknown channel must not be registered by its first message');
  assert.ok(traces.some(t => t.type === 'mcpl:channel-incoming-rejected'));
  assert.equal(registry.resolveLocus('cairn'), null, 'a rejected message must not establish a locus');
});

test('routeSpeech surfaces a failure when the server reports delivered:false', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: false });
  seedRegistered(registry, 'discord', 'ch-x');
  registry.handleIncoming('discord', incoming('ch-x', 'hi'));

  const res = await registry.routeSpeech('cairn', 'undeliverable reply', registry.resolveLocus('cairn'));

  assert.equal(res, null, 'a non-delivered send must not report success');
  assert.equal(failures.length, 1, 'onRouteFailure should fire');
  assert.equal(failures[0].channelId, 'ch-x');
  assert.match(failures[0].reason, /delivered:false/);
  assert.equal(failures[0].outcome, 'failed', 'the server said nothing was delivered');
  assert.ok(traces.some(t => t.type === 'mcpl:speech-route-failed' && t.outcome === 'failed'));
});

test('routeSpeech counts a publish reply that leaves delivered out as unconfirmed, not delivered', async () => {
  const { registry, failures } = makeRegistry({});
  seedRegistered(registry, 'discord', 'ch-x');
  registry.handleIncoming('discord', incoming('ch-x', 'hi'));

  const res = await registry.routeSpeech('cairn', 'a reply', registry.resolveLocus('cairn'));

  assert.equal(res, null, 'no delivery is confirmed, so the stream gets none of it');
  assert.equal(failures.length, 1, 'and the route failure is reported');
  assert.equal(failures[0].outcome, 'unknown', 'as a post that may or may not exist');
});

test('routeSpeech reports each delivered publish as mcpl:speech-routed, with nothing that ties it to a stream or ends one', async () => {
  const { registry, traces } = makeRegistry({ delivered: true });
  seedRegistered(registry, 'discord', 'ch-x');
  registry.handleIncoming('discord', incoming('ch-x', 'hi'));

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
  const homes: Record<string, string> = { 'conversation-chanA-g1': 'chanA' };
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    (agentName) => homes[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));
  // Global locus is now chanB.
  assert.equal(registry.getDefaultPublishChannel(), 'chanB');

  const res = await registry.routeSpeech('conversation-chanA-g1', 'reply for A', registry.resolveLocus('conversation-chanA-g1'));
  assert.deepEqual(res, { delivered: true, channelId: 'chanA' },
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
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));

  const res = await registry.routeSpeech('trunk', 'heartbeat reply', registry.resolveLocus('trunk'));
  assert.deepEqual(res, { delivered: true, channelId: 'chanB' });
  assert.equal(publishCalls.at(-1)?.channelId, 'chanB');
});

test('buildChannelContext advertises the fork home as defaultOutgoing (item 3)', () => {
  const homes: Record<string, string> = { 'conversation-chanA-g1': 'chanA' };
  const { registry } = makeRegistry(
    { delivered: true },
    (agentName) => homes[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));

  // The fork is told chanA (where its speech actually lands)...
  const forkCtx = registry.buildChannelContext('conversation-chanA-g1');
  assert.equal(forkCtx?.defaultOutgoing?.channelId, 'chanA');

  // ...while the trunk agent (no home) is told the global default.
  const trunkCtx = registry.buildChannelContext('trunk');
  assert.equal(trunkCtx?.defaultOutgoing?.channelId, 'chanB');
});

test('routeSpeech surfaces a failure when there is no locus at all', async () => {
  const { registry, failures } = makeRegistry({ delivered: true });
  // No handleIncoming → defaultPublishChannel is null.
  const res = await registry.routeSpeech('cairn', 'into the void', registry.resolveLocus('cairn'));
  assert.equal(res, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].channelId, null);
  assert.match(failures[0].reason, /no locus/);
});

// ── item-3 redux: single TRUNK agents route to the turn's triggering channel ──

test('routeSpeech routes a TRUNK agent to its ACTIVE triggering channel, not the global last-inbound (item-3 redux)', async () => {
  // The exact live repro: scout (a single trunk agent) is answering channel A
  // when a message arrives on channel B, flipping the process-global
  // defaultPublishChannel to B. The reply must still land in A. Forks (home)
  // don't exist here — connectome-host never spawns them — so the ONLY thing
  // keeping A's answer in A is the active-triggering-channel resolver.
  const active: Record<string, string> = { scout: 'chanA' };
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    () => undefined,               // no fork homes (trunk-only, connectome-host mode)
    (agentName) => active[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'A: sleep && date'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'B: unrelated')); // flips global to chanB
  assert.equal(registry.getDefaultPublishChannel(), 'chanB');

  const res = await registry.routeSpeech('scout', 'the date is ...', registry.resolveLocus('scout'));
  assert.deepEqual(res, { delivered: true, channelId: 'chanA' },
    'trunk reply must go to the channel that triggered the turn, not the global last-inbound');
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('routeSpeech precedence: fork HOME wins over the active triggering channel', async () => {
  // A fork bound to chanA must route home even if its live turn was (somehow)
  // triggered from chanB — home is the strongest signal and must not regress.
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    (n) => (n === 'conversation-chanA-g1' ? 'chanA' : undefined),
    () => 'chanB',
  );
  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi'));

  const res = await registry.routeSpeech('conversation-chanA-g1', 'reply', registry.resolveLocus('conversation-chanA-g1'));
  assert.deepEqual(res, { delivered: true, channelId: 'chanA' });
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('buildChannelContext uses the frozen turn pin and omits channel claims for a private turn', () => {
  const active: Record<string, string> = { scout: 'chanA' };
  const { registry } = makeRegistry({ delivered: true }, () => undefined, (name) => active[name]);
  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));

  const frozen = registry.buildChannelContext('scout', { frozenLocus: 'chanA' });
  assert.equal(frozen?.defaultOutgoing?.channelId, 'chanA');
  assert.equal(frozen?.incoming?.channelId, 'chanB');

  const privateContext = registry.buildChannelContext('scout', { frozenLocus: null, privateTurn: true });
  assert.equal(privateContext?.defaultOutgoing, undefined);
  assert.equal(privateContext?.incoming, undefined);
});

test("buildChannelContext keeps a real turn's incoming message when no channel is open and the turn has no locus", () => {
  const { registry } = makeRegistry({ delivered: true }, () => undefined, () => undefined);
  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  // The channel has since closed.
  (registry as unknown as { getOpenChannels(): unknown[] }).getOpenChannels = () => [];
  const context = registry.buildChannelContext('scout', { frozenLocus: null });
  assert.equal(context?.incoming?.channelId, 'chanA', 'an explicit- or disabled-mode turn still has what it replies to');
  assert.equal(context?.defaultOutgoing, undefined);
  assert.equal(registry.buildChannelContext('scout', { frozenLocus: null, privateTurn: true }), undefined, 'a private turn has neither');
});

test('buildChannelContext advertises the active triggering channel as defaultOutgoing (item-3 redux)', () => {
  const active: Record<string, string> = { scout: 'chanA' };
  const { registry } = makeRegistry(
    { delivered: true },
    () => undefined,
    (n) => active[n],
  );
  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B')); // global → chanB

  // The trunk is TOLD chanA (where its speech will actually land), matching
  // what routeSpeech resolves — not the global chanB.
  const ctx = registry.buildChannelContext('scout');
  assert.equal(ctx?.defaultOutgoing?.channelId, 'chanA');
});

test('ensureChannelRegistered keeps a DM closed while making its one-shot reply routable', async () => {
  // A Discord DM arrives via push/event (channel closed), so it is never
  // registered and never updates defaultPublishChannel — routeSpeech would drop
  // the reply. Registering it on inbound makes it a publishable locus; the
  // active resolver (the woken turn's DM) then targets it.
  const dm = 'discord:dm:42';
  const active: Record<string, string> = { scout: dm };
  const { registry, publishCalls, lookup, traces } = makeRegistry(
    { delivered: true },
    () => undefined,
    (n) => active[n],
  );

  // No prior handleIncoming for the DM — it only ever came as a push event.
  assert.equal(lookup(dm), undefined);
  assert.equal(registry.getDefaultPublishChannel(), null);

  registry.ensureChannelRegistered('discord', dm, 'DM with Antra');

  const entry = lookup(dm);
  assert.ok(entry, 'the DM channel should be registered');
  assert.equal(entry!.serverId, 'discord');
  assert.equal(entry!.open, false, 'one-shot reachability is not a subscription');
  assert.ok(traces.some((t) => t.type === 'mcpl:channel-lazy-registered'));

  const res = await registry.routeSpeech('scout', 'replying in the DM', registry.resolveLocus('scout'));
  assert.deepEqual(res, { delivered: true, channelId: dm },
    'the DM reply must route back to the DM channel, not the global locus');
  assert.equal(publishCalls.at(-1)?.channelId, dm);
});

test('ensureChannelRegistered is idempotent and does not reopen a closed channel', () => {
  const { registry, lookup } = makeRegistry({ delivered: true });
  registry.ensureChannelRegistered('discord', 'discord:guild:7', '#cairn');
  const first = lookup('discord:guild:7');
  assert.ok(first);
  // Force it closed, then re-ensure — a direct push must not mutate lifecycle.
  first!.open = false;
  registry.ensureChannelRegistered('discord', 'discord:guild:7', '#cairn');
  const second = lookup('discord:guild:7');
  assert.equal(second, first, 'must reuse the same entry');
  assert.equal(second!.open, false, 'a direct push must not mutate lifecycle');
});

// ---------------------------------------------------------------------------
// Channel-lifecycle invariants (2026-07-22): sending into a closed channel is
// not a thing — delivery opens it; subscribed ⇒ open at any discovery time.
// ---------------------------------------------------------------------------

test('routeSpeech into a closed locus opens the channel first, then delivers', async () => {
  const { registry, publishCalls, openCalls, lookup } = makeRegistry({ delivered: true });

  // A DM-shaped situation: the channel is registered but closed.
  seedRegistered(registry, 'discord', 'dm-alice');
  registry.handleIncoming('discord', incoming('dm-alice', 'hello?'));
  lookup('dm-alice')!.open = false;

  const res = await registry.routeSpeech('sol', 'a reply meant for the DM', 'dm-alice');

  assert.deepEqual(res, { delivered: true, channelId: 'dm-alice' });
  assert.equal(openCalls.length, 1, 'delivery into a closed channel must open it');
  assert.equal(openCalls[0]!.channelId, 'dm-alice');
  assert.equal(lookup('dm-alice')!.open, true, 'live state flips open');
  assert.equal(registry.getDesiredState('discord', 'dm-alice'), 'open',
    'durable desired state records the engagement');
  assert.equal(publishCalls.at(-1)?.channelId, 'dm-alice');
});

test('routeSpeech does NOT deliver when the open-on-delivery fails', async () => {
  const { registry, failures, publishCalls, lookup, setFailOpens } = makeRegistry({ delivered: true });

  seedRegistered(registry, 'discord', 'dm-alice');
  registry.handleIncoming('discord', incoming('dm-alice', 'hello?'));
  lookup('dm-alice')!.open = false;
  const publishesBefore = publishCalls.length;
  setFailOpens(true);

  const res = await registry.routeSpeech('sol', 'must not go out', 'dm-alice');

  assert.equal(res, null, 'no delivery into a channel that could not be opened');
  assert.equal(publishCalls.length, publishesBefore, 'publish must not be attempted');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.reason, /closed and open failed/);
  assert.equal(failures[0]!.outcome, 'failed', 'nothing was published');
});

test('routeSpeech with an omitted locus fails loudly as a routing bug', async () => {
  const { registry, failures } = makeRegistry({ delivered: true });
  seedRegistered(registry, 'discord', 'ch-y');
  registry.handleIncoming('discord', incoming('ch-y', 'hi'));

  const res = await (registry.routeSpeech as unknown as (
    c: string, t: string) => Promise<unknown>)('cairn', 'who knows where');

  assert.equal(res, null);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.reason, /routing bug/);
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
  const { registry, openCalls, lookup } = makeRegistry({ delivered: true });

  await registry.handleChanged('discord', {
    added: [{ id: 'discord:dm:444555', type: 'discord', label: 'DM: Alice',
      direction: 'bidirectional', address: { guildId: 'dm', channelId: '444555' } }],
  } as never);
  assert.equal(lookup('discord:dm:444555')!.open, false, 'DM registers closed');

  const { status } = await registry.openIfClosedForSend('444555', 'discord');

  assert.equal(status, 'opened');
  assert.equal(lookup('discord:dm:444555')!.open, true);
  assert.ok(openCalls.some(c => c.channelId === 'discord:dm:444555'));
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
  registry.handleIncoming('discord', incoming('dm-alice', 'hello?'));
  lookup('dm-alice')!.open = false;

  await registry.routeSpeech('sol', 'reply', 'dm-alice');

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

  for (const tag of ['chat:reaction', 'chat:reaction-remove', 'chat:edited', 'chat:deleted']) {
    lookup('chanB')!.open = false;
    registry.handleIncoming('discord', incoming('chanB', `[${tag}] marker`, undefined, [tag]));
    assert.equal(registry.getDefaultPublishChannel(), 'chanA',
      `a ${tag} marker on chanB must not steal the default publish locus`);
    const anchor = registry.buildChannelContext()?.incoming;
    assert.equal(anchor?.messageId, 'm1', `a ${tag} marker leaves the reply anchor's message`);
    assert.equal(anchor?.threadId, 'thread-A', `a ${tag} marker leaves the reply anchor's thread`);
    // The liveness repair still runs for a marker, as for any message: a
    // server sending channels/incoming for a channel decided open is
    // evidence that its transport is open.
    assert.equal(lookup('chanB')?.open, true, `a ${tag} marker still repairs chanB's open state`);
    // On the anchor's own channel, a marker leaves the anchor too.
    registry.handleIncoming('discord', incoming('chanA', `[${tag}] marker on A`, undefined, [tag]));
    const sameChannel = registry.buildChannelContext()?.incoming;
    assert.equal(sameChannel?.messageId, 'm1', `a ${tag} marker on the anchor's channel leaves its message`);
    assert.equal(sameChannel?.threadId, 'thread-A', `a ${tag} marker on the anchor's channel leaves its thread`);
  }

  // A real message still retargets: the skip is tag-scoped, not a freeze.
  const real = incoming('chanB', 'real message on B', undefined, undefined, 'thread-B');
  real.messages[0]!.messageId = 'm2';
  registry.handleIncoming('discord', real);
  assert.equal(registry.getDefaultPublishChannel(), 'chanB');
  const after = registry.buildChannelContext()?.incoming;
  assert.equal(after?.messageId, 'm2', 'a real message becomes the reply anchor');
  assert.equal(after?.threadId, 'thread-B', 'with its own thread');
  // One with no thread leaves none behind.
  const unthreaded = incoming('chanA', 'real message on A, no thread');
  unthreaded.messages[0]!.messageId = 'm3';
  registry.handleIncoming('discord', unthreaded);
  const last = registry.buildChannelContext()?.incoming;
  assert.equal(last?.messageId, 'm3', 'a real message with no thread becomes the reply anchor');
  assert.equal(last?.threadId, undefined, 'and takes no thread from the one before it');
});

test('a marker on a NEVER-conversed channel leaves the locus null, not marker-anchored (#157)', async () => {
  const { registry } = makeRegistry(undefined);
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', '[edited] marker', undefined, ['chat:edited']));
  assert.equal(registry.getDefaultPublishChannel(), null,
    'an edit marker alone must not establish a publish locus');
  assert.equal(registry.buildChannelContext()?.incoming, undefined,
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
    const t = registry.proseTargetFor(id);
    assert.equal(t, want, `target for ${id}`);
    // The property that matters: the grammar reads it whole, and it routes back here.
    assert.equal(parseProsePrefix(`>>${t} hello`).target, t, `${t} parses as one target`);
    const r = registry.resolveProseTarget(t!);
    assert.ok('channelId' in r && r.channelId === id, `${t} resolves to ${id}`);
  }
  assert.equal(registry.proseTargetFor('discord:nowhere'), undefined, 'unregistered → undefined');
});

test('proseTargetFor: no token when none is safe (shared id across servers, whitespace-only options)', async () => {
  const { registry } = makeRegistry({ delivered: true });
  // The same channel id registered by two connections: a resolved target names a
  // channel by id alone, so either server's reply could leave through the other.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'chan:7', type: 'discord', label: '#shared-a', direction: 'bidirectional' }],
  } as never);
  await registry.handleChanged('discord-b', {
    added: [{ id: 'chan:7', type: 'discord', label: '#shared-b', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.proseTargetFor('chan:7', 'discord-a'), undefined);
  assert.equal(registry.proseTargetFor('chan:7', 'discord-b'), undefined);
  assert.equal(registry.proseTargetFor('chan:7'), undefined);

  // An id with whitespace and a label with whitespace: nothing parses as one target.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'thread 42', type: 'discord', label: 'thread 42', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.proseTargetFor('thread 42', 'discord-a'), undefined);

  // serverId is honoured: a channel registered only on discord-a isn't named for discord-b.
  await registry.handleChanged('discord-a', {
    added: [{ id: 'chan:8', type: 'discord', label: '#only-a', direction: 'bidirectional' }],
  } as never);
  assert.equal(registry.proseTargetFor('chan:8', 'discord-a'), '#only-a');
  assert.equal(registry.proseTargetFor('chan:8', 'discord-b'), undefined);
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
  const { registry, failures, traces, publishCalls, openCalls, lookup } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);
  assert.equal(lookup('body:ears')?.open, false, 'precondition: registered closed');

  const result = await registry.routeSpeech('linn', 'Hello, room.', 'body:ears');

  assert.equal(result, null, 'nothing was delivered');
  assert.deepEqual(publishCalls, [], 'nothing was published');
  assert.deepEqual(openCalls, [], 'the delivery attempt did not open the channel');
  assert.equal(lookup('body:ears')?.open, false);
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

test('an inbound-only channel gets no outgoing stream', async () => {
  const { registry, streamCalls } = makeRegistry({ delivered: true });
  await registerInboundOnly(registry);

  registry.sendOutgoingChunk('body:ears', 'linn', 'inf_1', 0, 'Hello');
  registry.sendOutgoingComplete('body:ears', 'linn', 'inf_1', 'Hello, room.');

  assert.deepEqual(streamCalls, []);
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
    assert.ok(await registry.routeSpeech('linn', `speech to ${id}`, id), `speech delivered to ${id}`);
    const published = await registry.handleChannelToolCall('channel_publish', { channelId: id, content: `publish to ${id}` });
    assert.equal(published.success, true, `channel_publish delivered to ${id}`);
    registry.sendOutgoingChunk(id, 'linn', 'inf_1', 0, 'x');
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

  assert.equal(registry.inboundOnlyServer('body:ears'), 'body');
  for (const id of ['body:out', 'body:both', 'body:unstated', 'body:unregistered']) {
    assert.equal(registry.inboundOnlyServer(id), undefined, id);
  }
});

test('the refusal follows the descriptor its server declared last: channels/register, and channels/changed updates either way', async () => {
  const { registry, failures, publishCalls } = makeRegistry({ delivered: true });

  // channels/register declares it inbound-only.
  await registry.handleRegister('body', {
    channels: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
  assert.equal(await registry.routeSpeech('linn', 'one', 'body:ears'), null);
  assert.equal(registry.inboundOnlyServer('body:ears'), 'body');

  // An update declares it bidirectional: speech goes out.
  await registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' }],
  } as never);
  assert.ok(await registry.routeSpeech('linn', 'two', 'body:ears'));
  assert.equal(registry.inboundOnlyServer('body:ears'), undefined);

  // Another declares it inbound-only again: refused again.
  await registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
  assert.equal(await registry.routeSpeech('linn', 'three', 'body:ears'), null);

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

  await registry.publishForAgent('body:home', 'a thought', 'Subconscious');

  assert.deepEqual(publishCalls.map((c) => c.channelId), ['body:home']);
  assert.deepEqual(traces.filter((t) => t.type === 'mcpl:speech-routed'), []);
  assert.deepEqual(
    traces.filter((t) => t.type === 'mcpl:speech-route-failed').map((t) => [t.conversationId, t.channelId, t.reason, t.outcome]),
    [['Subconscious', 'body:home', 'server "body" reported delivered:false', 'failed']],
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
  assert.equal(unconfirmed.error, 'Publish to body:home wasn\'t confirmed: The "body" server answered with an error: Rate limited after part 1 (delivery uncertain). It may or may not have been posted, so sending it again could post it twice. Connector detail: {"posted":["m-1"]}');
  assert.deepEqual(failed().map((t) => [t.reason, t.outcome, t.detail]),
    [['The "body" server answered with an error: Rate limited after part 1 (delivery uncertain)', 'unknown', '{"posted":["m-1"]}']],
    "the trace carries the connector's detail, as plain speech's does");

  // So may a request that went out and got no answer.
  setOnPublish(async () => {
    throw new McplRequestError('MCPL server "body" did not respond to channels/publish within 30000ms', 'no-response');
  });
  await registry.publishForAgent('body:home', 'a thought', 'Subconscious');
  assert.equal(failed()[1]!.outcome, 'unknown');

  // Only a request that never left proves nothing was posted.
  setOnPublish(async () => {
    throw new McplRequestError('Cannot send request: connection to "body" is closed', 'not-sent');
  });
  const notSent = await registry.publishForAgent('body:home', 'another', 'Subconscious');
  assert.match(notSent.error ?? '', /^Publish to body:home failed: .*is closed\. Nothing was posted\./);
  assert.equal(failed()[2]!.outcome, 'failed');
  assert.equal('detail' in failed()[2]!, false, 'no detail when the connector sent none');
  assert.equal(traces.filter((t) => t.type === 'mcpl:speech-routed').length, 0);
});

test('buildChannelContext names no defaultOutgoing for a locus its server declared inbound-only', async () => {
  const active: Record<string, string> = { linn: 'body:ears', nell: 'body:home' };
  const { registry } = makeRegistry({ delivered: true }, () => undefined, (n) => active[n]);
  await registerInboundOnly(registry);
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);

  assert.equal(registry.buildChannelContext('linn')?.defaultOutgoing, undefined, 'speech goes nowhere, so no channel is named');
  assert.equal(registry.buildChannelContext('nell')?.defaultOutgoing?.channelId, 'body:home');
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
  assert.deepEqual(registry.resolveProseTarget('body:ears'), { channelId: 'body:ears', label: 'Body · ears' });
  assert.deepEqual(registry.resolveProseTargetDurable('body:ears'), { channelId: 'body:ears', label: 'Body · ears' });
  // No reply token is offered for it; one is for the bidirectional channel.
  assert.equal(registry.proseTargetFor('body:ears', 'body'), undefined);
  assert.ok(registry.proseTargetFor('body:home', 'body'));
  // A bidirectional channel resolves either way.
  assert.deepEqual(registry.resolveProseTarget('body:home', { forSpeech: true }), { channelId: 'body:home', label: 'Body · home' });
});

test('a channel declared inbound-only while the host opens it for speech is refused before the publish, and stays open with the open\'s notice', async () => {
  const autoOpened: Array<{ source: string; channels: Array<{ channelId: string }> }> = [];
  const { registry, publishCalls, openCalls, closeCalls, failures, setOnOpen, lookup } =
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

  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:ears'), null);
  assert.deepEqual(openCalls.map((c) => c.channelId), ['body:ears'], 'the closed channel was opened');
  assert.equal(publishCalls.length, 0, 'nothing was published after the declaration');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  // The open happened, whatever the recheck decided: the channel stays open,
  // and the open's notice, which says how to close it, went out with the marker.
  assert.equal(lookup('body:ears')?.open, true, 'the opened channel stays open');
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

  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:home'), null);
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

  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:ears'), null);
  assert.deepEqual(openCalls.map((c) => c.channelId), ['body:ears'], 'speech opened the channel, as for any closed locus');
  assert.equal(publishCalls.length, 0, 'nothing was published after the server declared it');
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  // The open happened, and the channel stays open: the notice says so, and
  // how to close it, while the marker reports the refused speech.
  assert.deepEqual(announced.map((a) => [a.source, a.channels.map((c) => c.channelId)]), [['opened-by-delivery', ['body:ears']]]);
  assert.equal(traces.filter((t) => t.type === 'mcpl:channel-opened-by-send').length, 1);
  assert.equal(registry.isChannelOpen('body:ears'), true);

  // The next speech is refused before anything goes to the server.
  assert.equal(await registry.routeSpeech('linn', 'again', 'body:ears'), null);
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

  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:ears'), null);
  assert.deepEqual(openCalls.map((c) => c.channelId), ['body:ears'], 'speech opened the channel');
  assert.equal(publishCalls.length, 0, 'nothing was published');
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared this channel's direction "inbound"/);
  assert.equal(registry.isChannelOpen('body:ears'), true, 'the open stands');
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
    assert.deepEqual(await registry.routeSpeech('linn', 'hello', 'body:ears'), { delivered: true, channelId: 'body:ears' },
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

    assert.equal(await registry.routeSpeech('linn', 'hello', 'body:home'), null);
    assert.deepEqual(openCalls.map((c) => c.channelId), ['body:home']);
    assert.equal(publishCalls.length, 0, 'nothing was published to the removed channel');
    assert.deepEqual(failures.map((f) => f.reason), ['channel is closed and open failed: Channel is no longer registered: body:home'],
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
  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:home'), null);
  assert.deepEqual(failures.map((f) => f.reason), ['channel is closed and open failed: The "body" server answered with an error: Channel unavailable']);
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.error, 'Failed to open channel: The "body" server answered with an error: Channel unavailable (it stays selected for opening: a later delivery or reconnect tries again, and channel_close withdraws that)');

  setOnOpen(undefined);
  setOnPublish(async () => { throw new McplRequestError('The "body" server answered with an error: Channel not permitted', 'error-response'); });
  const published = await registry.handleChannelToolCall('channel_publish', { channelId: 'body:home', content: 'hi' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(published.error, 'Publish to body:home wasn\'t confirmed: The "body" server answered with an error: Channel not permitted (delivery uncertain). It may or may not have been posted, so sending it again could post it twice.');
});

test("an open's answer can't lift an inbound-only declaration: a server lifts it by changing or registering the channel (R1-3)", async () => {
  const { registry, publishCalls, failures, setOpenResult } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'inbound' }],
  } as never);
  setOpenResult({ channel: { id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' } });
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:ears' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.success, true);
  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:ears'), null, 'still refused after the answer');
  assert.equal(publishCalls.length, 0);
  assert.match(failures[0]!.reason, /^inbound-only: server "body" declared/);

  // The server's own change lifts it.
  await registry.handleChanged('body', {
    updated: [{ id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' }],
  } as never);
  assert.deepEqual(await registry.routeSpeech('linn', 'now', 'body:ears'), { delivered: true, channelId: 'body:ears' });
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
  const delivery = registry.routeSpeech('linn', 'hello', 'body:ears');
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

  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:ears'), null);
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
  assert.equal(registry.isChannelOpen('body:home'), false);
  (registry as unknown as { setDesiredState(s: string, c: string, state: string, source: string): void })
    .setDesiredState('body', 'body:home', 'tuned-out', 'agent-tool');
  await registry.handleChanged('body', { added: [home] } as never);
  assert.equal(opens(), 1, "the announcement's reconcile opened it");
  assert.equal(registry.isChannelOpen('body:home'), true);
});
