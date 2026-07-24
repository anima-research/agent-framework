import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

type RouteFailure = { conversationId: string; channelId: string | null; reason: string; textLen: number };

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
  let failOpens = false;

  const mockServer = {
    sendChannelsPublish: async (params: { channelId?: string; conversationId?: string }) => {
      publishCalls.push(params);
      return publishResult;
    },
    sendChannelsOpen: async (params: { channelId?: string }) => {
      if (failOpens) throw new Error('open refused by server');
      openCalls.push(params);
      return {};
    },
    sendChannelsClose: async (params: { channelId?: string }) => {
      closeCalls.push(params);
      return {};
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
    registry, failures, traces, publishCalls, openCalls, closeCalls, lookup,
    setFailOpens: (v: boolean) => { failOpens = v; },
  };
}

function incoming(channelId: string, text: string, channelName?: string) {
  return {
    messages: [{
      channelId,
      messageId: 'm1',
      author: { id: 'u1', name: 'Antra' },
      timestamp: '2026-05-30T00:00:00.000Z',
      content: [{ type: 'text' as const, text }],
      metadata: channelName ? { channelName } : undefined,
    }],
  };
}

test('handleIncoming lazy-registers an unknown channel so it becomes a publishable locus', async () => {
  const { registry, traces, lookup } = makeRegistry({ delivered: true });

  // Channel "post-boot-ch" was never registered via channels/register|changed.
  assert.equal(lookup('post-boot-ch'), undefined);

  registry.handleIncoming('discord', incoming('post-boot-ch', 'hi', '#cairn'));

  const entry = lookup('post-boot-ch');
  assert.ok(entry, 'channel should be lazy-registered from the inbound message');
  assert.equal(entry!.serverId, 'discord');
  assert.equal(entry!.descriptor.label, '#cairn');
  assert.equal((entry!.descriptor.metadata as { lazyRegistered?: boolean })?.lazyRegistered, true);
  assert.ok(traces.some(t => t.type === 'mcpl:channel-lazy-registered'));

  // routeSpeech now resolves the locus and publishes (no failure).
  const res = await registry.routeSpeech('cairn', 'my reply', registry.resolveLocus('cairn'));
  assert.deepEqual(res, { delivered: true, channelId: 'post-boot-ch' });
});

test('routeSpeech surfaces a failure when the server reports delivered:false', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: false });
  registry.handleIncoming('discord', incoming('ch-x', 'hi'));

  const res = await registry.routeSpeech('cairn', 'undeliverable reply', registry.resolveLocus('cairn'));

  assert.equal(res, null, 'a non-delivered send must not report success');
  assert.equal(failures.length, 1, 'onRouteFailure should fire');
  assert.equal(failures[0].channelId, 'ch-x');
  assert.match(failures[0].reason, /delivered:false/);
  assert.ok(traces.some(t => t.type === 'mcpl:speech-route-failed'));
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

  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
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

  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
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

  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
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

  registry.handleIncoming('discord', incoming('chanA', 'A: sleep && date'));
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
  registry.handleIncoming('discord', incoming('chanA', 'hi'));
  registry.handleIncoming('discord', incoming('chanB', 'hi'));

  const res = await registry.routeSpeech('conversation-chanA-g1', 'reply', registry.resolveLocus('conversation-chanA-g1'));
  assert.deepEqual(res, { delivered: true, channelId: 'chanA' });
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('buildChannelContext advertises the active triggering channel as defaultOutgoing (item-3 redux)', () => {
  const active: Record<string, string> = { scout: 'chanA' };
  const { registry } = makeRegistry(
    { delivered: true },
    () => undefined,
    (n) => active[n],
  );
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
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

  registry.handleIncoming('discord', incoming('dm-alice', 'hello?'));
  lookup('dm-alice')!.open = false;
  const publishesBefore = publishCalls.length;
  setFailOpens(true);

  const res = await registry.routeSpeech('sol', 'must not go out', 'dm-alice');

  assert.equal(res, null, 'no delivery into a channel that could not be opened');
  assert.equal(publishCalls.length, publishesBefore, 'publish must not be attempted');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.reason, /closed and open failed/);
});

test('routeSpeech with an omitted locus fails loudly as a routing bug', async () => {
  const { registry, failures } = makeRegistry({ delivered: true });
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
