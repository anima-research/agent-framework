import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { McplErrorResponse } from '../src/mcpl/errors.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { parseProsePrefix } from '../src/mcpl/prose-grammar.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

type RouteFailure = { conversationId: string; channelId: string | null; reason: string; textLen: number; outcome: 'failed' | 'unknown' };

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
  assert.match(failures[0]!.reason, /^the channel was closed, and opening it failed: /);
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
  // Shaped as routeSpeech's trace is, with the surface's message id.
  assert.deepEqual(routed(), [{
    type: 'mcpl:speech-routed', conversationId: 'Subconscious', serverId: 'body', channelId: 'body:home',
    delivered: true, textLen: 'a thought'.length, text: 'a thought', messageId: 'm-77',
  }]);
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
    [['Subconscious', 'body:home', 'the server reported delivered:false', 'failed']],
  );
});

test("publishForAgent traces a server's error response as unknown, and another rejection with no outcome", async () => {
  const { registry, traces, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleChanged('body', {
    added: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  const failed = () => traces.filter((t) => t.type === 'mcpl:speech-route-failed');

  // An error response may follow a partial post.
  setOnPublish(async () => {
    throw new McplErrorResponse('MCPL server "body" returned error for channels/publish: [-32000] Rate limited after part 1', 'Rate limited after part 1');
  });
  const unconfirmed = await registry.publishForAgent('body:home', 'a long thought', 'Subconscious');
  assert.equal(unconfirmed.error, 'Publish to body:home wasn\'t confirmed: server "body" answered with an error: Rate limited after part 1. It may or may not have been posted, so sending it again could post it twice.');
  assert.equal(failed().length, 1);
  assert.equal(failed()[0]!.outcome, 'unknown');

  // A timeout, a lost connection and a closed connection are plain Errors,
  // which the host can't tell apart: the trace says neither.
  setOnPublish(async () => { throw new Error('channels/publish timed out after 30000ms'); });
  const timedOut = await registry.publishForAgent('body:home', 'a thought', 'Subconscious');
  assert.equal(timedOut.error, 'Failed to publish to channel: channels/publish timed out after 30000ms');
  assert.equal(failed().length, 2);
  assert.equal('outcome' in failed()[1]!, false, JSON.stringify(failed()[1]));
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

test("a server's error response to a request rejects with McplErrorResponse, carrying the server's words, with the code in the operator's message", async () => {
  const connection = new (McplServerConnection as any)('body', null, null) as McplServerConnection;
  const internals = connection as unknown as {
    pendingRequests: Map<number, { resolve(r: unknown): void; reject(e: Error): void; method: string }>;
    handleResponse(response: unknown): void;
  };
  const answer = new Promise((resolve, reject) => {
    internals.pendingRequests.set(7, { resolve, reject, method: 'channels/publish' });
  });
  internals.handleResponse({ jsonrpc: '2.0', id: 7, error: { code: -32017, message: 'Channel not permitted', data: { channelId: 'body:ears' } } });
  await assert.rejects(answer, (err: Error) => {
    assert.ok(err instanceof McplErrorResponse);
    assert.equal(err.message, 'MCPL server "body" returned error for channels/publish: [-32017] Channel not permitted');
    assert.equal((err as McplErrorResponse).serverMessage, 'Channel not permitted');
    return true;
  });
});

test("an error response with no message, or one that isn't text, still settles its request, and says what came", { timeout: 5000 }, async () => {
  const connection = new (McplServerConnection as any)('body', null, null) as McplServerConnection;
  const internals = connection as unknown as {
    pendingRequests: Map<number, { resolve(r: unknown): void; reject(e: Error): void; method: string }>;
    handleResponse(response: unknown): void;
  };
  // Each error, what the agent reads as the server's words, and the operator's
  // message, which shows the code as it came.
  const deep = JSON.parse('['.repeat(100_000) + ']'.repeat(100_000));
  const cases: Array<[unknown, string, string]> = [
    [{ code: -32000 }, 'an error with no message', '[-32000] an error with no message'],
    [{ code: -32000, message: '' }, 'an error with no message', '[-32000] an error with no message'],
    [{}, 'an error with no message', '[none] an error with no message'],
    // String() can't convert this one: building the error must not throw, or the request would never settle.
    [{ code: -32000, message: { toString: 1, valueOf: 1 } }, 'an error whose message isn\'t text: {"toString":1,"valueOf":1}', '[-32000] an error whose message isn\'t text: {"toString":1,"valueOf":1}'],
    [{ message: 'no code' }, 'no code', '[none] no code'],
    [{ code: { toString: 1 }, message: 'odd code' }, 'odd code', '[{"toString":1}] odd code'],
    [{ code: 1.5, message: 'half a code' }, 'half a code', '[1.5] half a code'],
    // Text sent in place of an error object is still the server's words.
    ['Channel not permitted', 'Channel not permitted', '[none] Channel not permitted'],
    // Anything else in its place is shown as it came.
    [[1, 2], 'an error that came as [1,2]', '[none] an error that came as [1,2]'],
    // A long value, or a long message, is cut at 200 characters for the
    // agent; the operator's message keeps a text message whole.
    [{ code: -32000, message: { text: 'x'.repeat(500) } }, `an error whose message isn't text: ${JSON.stringify({ text: 'x'.repeat(500) }).slice(0, 200)}…`, `[-32000] an error whose message isn't text: ${JSON.stringify({ text: 'x'.repeat(500) }).slice(0, 200)}…`],
    [{ code: -32000, message: 'y'.repeat(500) }, `${'y'.repeat(200)}…`, `[-32000] ${'y'.repeat(500)}`],
    ['w'.repeat(500), `${'w'.repeat(200)}…`, `[none] ${'w'.repeat(500)}`],
    // Exactly 200 stays whole; characters past the BMP count once and are never split.
    [{ code: -32000, message: 'z'.repeat(200) }, 'z'.repeat(200), `[-32000] ${'z'.repeat(200)}`],
    [{ code: -32000, message: '\u{1F600}'.repeat(300) }, `${'\u{1F600}'.repeat(200)}…`, `[-32000] ${'\u{1F600}'.repeat(300)}`],
  ];
  for (const [i, [error, serverMessage, operator]] of cases.entries()) {
    const id = 100 + i;
    const answer = new Promise((resolve, reject) => {
      internals.pendingRequests.set(id, { resolve, reject, method: 'channels/publish' });
    });
    internals.handleResponse({ jsonrpc: '2.0', id, error });
    await assert.rejects(answer, (err: Error) => {
      assert.ok(err instanceof McplErrorResponse);
      assert.equal((err as McplErrorResponse).serverMessage, serverMessage, JSON.stringify(error));
      assert.equal(err.message, `MCPL server "body" returned error for channels/publish: ${operator}`);
      return true;
    });
  }
  // A falsy error is no error: a result beside "error": null is the answer.
  const answered = new Promise((resolve, reject) => {
    internals.pendingRequests.set(199, { resolve, reject, method: 'channels/publish' });
  });
  internals.handleResponse({ jsonrpc: '2.0', id: 199, result: { delivered: true }, error: null });
  assert.deepEqual(await answered, { delivered: true });
  // A message nested deeper than JSON.stringify can write, which JSON.parse
  // reads. Node 22 and 24 overflow the stack writing it back, and Node 26
  // doesn't, so the text is named or shown, and either way the request settles.
  const answer = new Promise((resolve, reject) => {
    internals.pendingRequests.set(200, { resolve, reject, method: 'channels/publish' });
  });
  internals.handleResponse({ jsonrpc: '2.0', id: 200, error: { code: -32000, message: deep } });
  await assert.rejects(answer, (err: Error) => {
    assert.ok(err instanceof McplErrorResponse);
    const text = (err as McplErrorResponse).serverMessage;
    assert.ok(
      text === "an error whose message isn't text: (a value nested too deeply to show)" || text.startsWith("an error whose message isn't text: [[["),
      text.slice(0, 120),
    );
    assert.equal(err.message, `MCPL server "body" returned error for channels/publish: [-32000] ${text}`);
    return true;
  });
});

test('a request on a connection already closed rejects with a plain Error, since nothing was sent (R1-2)', async () => {
  const connection = new (McplServerConnection as any)('body', null, null) as McplServerConnection;
  (connection as unknown as { closed: boolean }).closed = true;
  await assert.rejects(
    connection.sendChannelsPublish({ conversationId: 'linn', channelId: 'body:home', content: [{ type: 'text', text: 'hello' }] }),
    (err: Error) => {
      assert.equal(err instanceof McplErrorResponse, false, `a plain Error, not ${err.name}`);
      assert.match(err.message, /is closed/);
      return true;
    },
  );
});

test("a server's error response to the publish goes through fail() as unconfirmed: a trace and the send-failure marker (R1-2)", async () => {
  const { registry, failures, traces, publishCalls, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnPublish(async () => {
    throw new McplErrorResponse('MCPL server "body" returned error for channels/publish: [-32017] Channel not permitted', 'Channel not permitted');
  });

  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:home'), null);
  assert.equal(publishCalls.length, 1, 'the publish was sent, and the server answered with an error');
  assert.deepEqual(failures.map((f) => f.reason), ['server "body" answered the publish with an error: Channel not permitted'],
    "the marker gives the server's own words, without the method or the code");
  // An error response may follow a partial post, so whether it was posted is unknown.
  assert.deepEqual(failures.map((f) => f.outcome), ['unknown']);
  const failed = traces.filter((t) => t.type === 'mcpl:speech-route-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.channelId, 'body:home');
  assert.equal(failed[0]!.outcome, 'unknown');
  assert.equal(traces.filter((t) => t.type === 'mcpl:speech-routed').length, 0);
});

test('a publish that times out or loses its connection still rejects, with no marker claiming it went undelivered (R1-2)', async () => {
  const { registry, failures, traces, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnPublish(async () => { throw new Error('Request channels/publish to MCPL server "body" timed out after 30000ms'); });

  await assert.rejects(registry.routeSpeech('linn', 'hello', 'body:home'), /timed out/);
  assert.equal(failures.length, 0, 'whether the server posted it is unknown');
  assert.equal(traces.filter((t) => t.type === 'mcpl:speech-route-failed').length, 0);
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

test("an open's answer that names another channel, declares no direction or declares one that isn't inbound leaves speech published (R1-3)", async () => {
  for (const answer of [
    { channel: { id: 'body:ears', type: 'chat', label: 'Body · ears', direction: 'bidirectional' } },
    { channel: { id: 'body:other', type: 'chat', label: 'Body · other', direction: 'inbound' } },
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
    assert.deepEqual(failures.map((f) => f.reason), ['the channel was removed while it was opening'],
      `refused as removed, after the answer ${JSON.stringify(answer)}`);
  }
});

test("a server's refusal of an open or a tool's publish reaches the agent in its own words", async () => {
  const refusal = () => new McplErrorResponse('MCPL server "body" returned error for channels/open: [-32024] Channel unavailable', 'Channel unavailable');
  const { registry, failures, setOnOpen, setOnPublish } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnOpen(async () => { throw refusal(); });
  assert.equal(await registry.routeSpeech('linn', 'hello', 'body:home'), null);
  assert.deepEqual(failures.map((f) => f.reason), ['the channel was closed, and opening it failed: server "body" answered with an error: Channel unavailable']);
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.error, 'Failed to open channel: server "body" answered with an error: Channel unavailable');

  setOnOpen(undefined);
  setOnPublish(async () => { throw new McplErrorResponse('MCPL server "body" returned error for channels/publish: [-32017] Channel not permitted', 'Channel not permitted'); });
  const published = await registry.handleChannelToolCall('channel_publish', { channelId: 'body:home', content: 'hi' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(published.error, 'Publish to body:home wasn\'t confirmed: server "body" answered with an error: Channel not permitted. It may or may not have been posted, so sending it again could post it twice.');
});

test("a failure that isn't an Error reaches the agent as its text", async () => {
  const { registry, setOnOpen } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  setOnOpen(async () => { throw 'refused by fiat'; });
  const opened = await registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, { kind: 'agent', agentName: 'linn' });
  assert.equal(opened.error, 'Failed to open channel: refused by fiat');
});

test("every failed open, publish, close and acknowledgement reaches the agent as the server's words, or the failure's text", async () => {
  const { registry, failures, setOnOpen, setOnPublish, setOnClose, setOnAcknowledge, lookup } = makeRegistry({ delivered: true });
  await registry.handleRegister('body', {
    channels: [{ id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' }],
  } as never);
  const agent = { kind: 'agent', agentName: 'linn' } as const;
  const long = 'w'.repeat(300);
  const refusal = (method: string) => new McplErrorResponse(`MCPL server "body" returned error for ${method}: [-32017] ${long}`, `${'w'.repeat(200)}…`);
  const unprintable = { get message(): string { throw new Error('getter'); } };
  for (const [thrown, words] of [
    [{ message: 'channel full' }, 'channel full'],
    [new TypeError(''), 'TypeError'],
    [unprintable, 'a failure that could not be printed'],
  ] as const) {
    setOnOpen(async () => { throw thrown; });
    assert.equal(await registry.routeSpeech('linn', 'hello', 'body:home'), null);
    assert.equal(failures.at(-1)!.reason, `the channel was closed, and opening it failed: ${words}`);
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, agent)).error, `Failed to open channel: ${words}`);
    setOnOpen(undefined);
    setOnPublish(async () => { throw thrown; });
    assert.equal((await registry.handleChannelToolCall('channel_publish', { channelId: 'body:home', content: 'hi' }, agent)).error, `Failed to publish to channel: ${words}`);
    setOnPublish(undefined);
  }
  // A server's refusal of a close, cut as the agent reads it.
  lookup('body:home')!.open = true;
  setOnClose(async () => { throw refusal('channels/close'); });
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'body:home' }, agent);
  assert.equal(closed.error, `Failed to close channel: server "body" answered with an error: ${'w'.repeat(200)}…`);
  // And of a decline's acknowledgement. The failed close left the channel
  // open on the host, and decline is for a channel that isn't.
  lookup('body:home')!.open = false;
  setOnAcknowledge(async () => { throw refusal('channels/acknowledge'); });
  const declined = await registry.handleChannelToolCall('channel_decline', { channelId: 'body:home', messageId: 'm1', acknowledge: 'not now' }, agent);
  assert.equal((declined.data as { acknowledgmentError?: string }).acknowledgmentError, `server "body" answered with an error: ${'w'.repeat(200)}…`);
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

test('a channel announced again while the host opens it is recorded open once the open answers, and the publish goes there (R1-3)', async () => {
  const { registry, publishCalls, setOnOpen } = makeRegistry({ delivered: true });
  const home = { id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' };
  await registry.handleRegister('body', { channels: [home] } as never);
  // The announcement replaces the entry at once, closed, and its reconcile's
  // own open waits until the speech is done.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let announced: Promise<void> | undefined;
  let opens = 0;
  setOnOpen(async () => {
    opens++;
    if (opens === 1) announced = registry.handleChanged('body', { added: [home] } as never);
    else await held;
  });

  assert.deepEqual(await registry.routeSpeech('linn', 'hello', 'body:home'), { delivered: true, channelId: 'body:home' });
  assert.equal(publishCalls.length, 1);
  assert.equal(registry.isChannelOpen('body:home'), true, "the channel's current entry is recorded open before its reconcile's open answers");
  assert.equal(opens, 2, "the announcement's reconcile opened it too, and waits");
  release();
  await announced;
});

// An open answered after a close the host asked for during it: the close is
// the newer decision, so the channel stays closed, whichever way the host
// opened it and whether or not an announcement replaced its entry meanwhile.
async function closedWhileOpening(holdOpen: number) {
  const made = makeRegistry({ delivered: true });
  const home = { id: 'body:home', type: 'chat', label: 'Body · home', direction: 'bidirectional' };
  await made.registry.handleRegister('body', { channels: [home] } as never);
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  let sent!: () => void;
  const held = new Promise<void>((resolve) => { sent = resolve; });
  let opens = 0;
  made.setOnOpen(async () => {
    opens++;
    if (opens === holdOpen) { sent(); await answered; }
  });
  const agent = { kind: 'agent' as const, agentName: 'linn' };
  return { ...made, home, agent, answer, held, opens: () => opens };
}

test("an open answered after the agent closed the channel during it leaves the channel closed", async () => {
  const { registry, closeCalls, agent, answer, held, setOpenResult } = await closedWhileOpening(1);
  // The answer declares the channel inbound-only, which lands either way: it
  // shows the late answer reached the host.
  setOpenResult({ channel: { id: 'body:home', type: 'chat', label: 'Body · home', direction: 'inbound' } });
  const opening = registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, agent);
  await held;
  // Registering the channel already sent one close, its reconcile's.
  const closesBefore = closeCalls.length;
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'body:home' }, agent);
  assert.equal((closed as { success?: boolean }).success, true);
  assert.equal(closeCalls.length, closesBefore + 1, "the agent's close was sent");
  answer();
  await opening;
  assert.equal(registry.getDesiredState('body', 'body:home'), 'closed');
  assert.equal(registry.inboundOnlyServer('body:home'), 'body', "the late answer's declaration was applied");
  assert.equal(registry.isChannelOpen('body:home'), false, 'the open answered after the close must not record the channel open');
});

test("a reconcile's open answered while the channel is tuned out is recorded: a tune-out keeps the transport open", async () => {
  const { registry, home, opens } = await closedWhileOpening(0);
  assert.equal(registry.isChannelOpen('body:home'), false);
  (registry as unknown as { setDesiredState(s: string, c: string, state: string, source: string): void })
    .setDesiredState('body', 'body:home', 'tuned-out', 'agent-tool');
  await registry.handleChanged('body', { added: [home] } as never);
  assert.equal(opens(), 1, "the announcement's reconcile opened it");
  assert.equal(registry.isChannelOpen('body:home'), true);
});

test("an open answered after the agent closed the channel leaves it closed, though an announcement replaced its entry during the open", async () => {
  const { registry, home, agent, answer, held, opens } = await closedWhileOpening(1);
  const opening = registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, agent);
  await held;
  // The server announces the channel again: its entry is replaced, and the
  // announcement's reconcile opens it, answered at once.
  await registry.handleChanged('body', { added: [home] } as never);
  assert.equal(opens(), 2);
  assert.equal(registry.isChannelOpen('body:home'), true, "the reconcile's answered open is recorded");
  await registry.handleChannelToolCall('channel_close', { channelId: 'body:home' }, agent);
  assert.equal(registry.isChannelOpen('body:home'), false);
  answer();
  await opening;
  assert.equal(registry.isChannelOpen('body:home'), false, "the first open's late answer must not reopen the replacement");
});

test("a reconcile's open answered after the agent closed the channel leaves it closed", async () => {
  const { registry, home, agent, answer, held, opens } = await closedWhileOpening(2);
  assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: 'body:home' }, agent) as { success?: boolean }).success, true);
  assert.equal(registry.isChannelOpen('body:home'), true);
  // The server announces it again; the reconcile's open is the one held.
  const announced = registry.handleChanged('body', { added: [home] } as never);
  await held;
  assert.equal(opens(), 2);
  await registry.handleChannelToolCall('channel_close', { channelId: 'body:home' }, agent);
  answer();
  await announced;
  assert.equal(registry.getDesiredState('body', 'body:home'), 'closed');
  assert.equal(registry.isChannelOpen('body:home'), false, "the reconcile's late answer must not record the channel open");
});
