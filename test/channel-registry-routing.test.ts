import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { parseProsePrefix } from '../src/mcpl/prose-grammar.js';
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
  let failPublishes = false;

  const mockServer = {
    // Post-policy state: full grant, so tests exercise delivery, not §5.3 denial.
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { channelId?: string; conversationId?: string }) => {
      publishCalls.push(params);
      if (failPublishes) throw new Error('transport closed');
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
    setFailPublishes: (v: boolean) => { failPublishes = v; },
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

test('routeSpeech still delivers when the open on delivery fails', async () => {
  const { registry, failures, publishCalls, traces, lookup, setFailOpens } = makeRegistry({ delivered: true });

  seedRegistered(registry, 'discord', 'dm-alice');
  registry.handleIncoming('discord', incoming('dm-alice', 'hello?'));
  lookup('dm-alice')!.open = false;
  setFailOpens(true);

  const res = await registry.routeSpeech('sol', 'goes out anyway', 'dm-alice');

  assert.deepEqual(res, { delivered: true, channelId: 'dm-alice' }, 'the words are delivered');
  assert.equal(publishCalls.at(-1)?.channelId, 'dm-alice');
  assert.deepEqual(failures, [], 'a failed open is no failed route');
  assert.ok(traces.some((t) => t.type === 'mcpl:channel-open-failed' && t.channelId === 'dm-alice'), 'the failed open is traced');
  assert.equal(lookup('dm-alice')!.open, false);
});

test('routeSpeech publishes on a server whose grant lacks channels.lifecycle, where nothing can open', async () => {
  const published: Array<string | undefined> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.lifecycle')), []),
    sendChannelsPublish: async (params: { channelId?: string }) => {
      published.push(params.channelId);
      return { delivered: true };
    },
  };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
  );
  seedRegistered(registry, 'portal', 'lobby');

  const res = await registry.routeSpeech('sol', 'hello from outside', 'lobby');

  assert.deepEqual(res, { delivered: true, channelId: 'lobby' }, 'the open fails, and the words still go');
  assert.deepEqual(published, ['lobby']);
  assert.equal(registry.canOpenChannels('portal'), false);
});

test('routeSpeech reports a publish that throws as a failed route (R1-4)', async () => {
  const { registry, failures, setFailPublishes } = makeRegistry({ delivered: true });
  seedRegistered(registry, 'discord', 'ch-z');
  registry.handleIncoming('discord', incoming('ch-z', 'hi'));
  setFailPublishes(true);

  const res = await registry.routeSpeech('sol', 'into a dead transport', 'ch-z');

  assert.equal(res, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.channelId, 'ch-z');
  assert.match(failures[0]!.reason, /^publish failed: transport closed$/);
});

test("routeSpeech leaves a channel the agent closed or declined itself closed, and publishes there", async () => {
  const { registry, publishCalls, openCalls, lookup } = makeRegistry({ delivered: true });
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
    const res = await registry.routeSpeech('sol', 'answering', id);
    assert.deepEqual(res, { delivered: true, channelId: id });
    assert.equal(publishCalls.at(-1)?.channelId, id);
    assert.equal(lookup(id)!.open, false, `${id} stays closed`);
    assert.equal(registry.getDesiredState('discord', id), 'closed');
  }
  assert.equal(openCalls.length, opensBefore, 'speech opened neither');
  assert.equal(registry.closedByAgent('discord', 'closed-by-agent'), 'closed');
  assert.equal(registry.closedByAgent('discord', 'declined-by-agent'), 'declined');
});

test("speech opens a channel a machine closed, and the agent's own close of it then stands against its speech", async () => {
  const { registry, openCalls, lookup } = makeRegistry({ delivered: true });
  await registry.handleChanged('discord', {
    added: [
      { id: 'gc-a', type: 'discord', label: '#a', direction: 'bidirectional' },
      { id: 'gc-b', type: 'discord', label: '#b', direction: 'bidirectional' },
    ],
  } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  const gc = { kind: 'module' as const, moduleName: 'subscription-gc' };
  for (const id of ['gc-a', 'gc-b']) {
    assert.equal((await registry.handleChannelToolCall('channel_open', { channelId: id }, agent)).success, true);
    assert.equal((await registry.handleChannelToolCall(
      'channel_close', { channelId: id, source: 'subscription-gc', overrideExplicitOpen: true }, gc)).success, true);
    assert.equal(registry.closedByAgent('discord', id), undefined, 'a machine close is no decision of the agent');
  }
  // The agent closes one of them itself: its close replaces the machine's.
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'gc-b' }, agent);
  assert.deepEqual(closed.data, { channelId: 'gc-b', status: 'already closed' });
  assert.equal(registry.closedByAgent('discord', 'gc-b'), 'closed');
  const opensBefore = openCalls.length;

  await registry.routeSpeech('sol', 'answering', 'gc-a');
  await registry.routeSpeech('sol', 'answering', 'gc-b');

  assert.deepEqual(openCalls.slice(opensBefore).map((c) => c.channelId), ['gc-a'], 'speech opens only the machine-closed one');
  assert.equal(lookup('gc-a')!.open, true);
  assert.equal(lookup('gc-b')!.open, false);
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

test("the agent's close or decline of a channel nobody decided about sticks against later policy; a machine close doesn't", async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  const added = {
    added: [
      { id: 'closed-by-agent', type: 'discord', label: '#a', direction: 'bidirectional' },
      { id: 'declined-by-agent', type: 'discord', label: '#b', direction: 'bidirectional' },
      { id: 'closed-by-gc', type: 'discord', label: '#c', direction: 'bidirectional' },
    ],
  } as never;
  // Registered closed by default: nobody has decided about any of them.
  await registry.handleChanged('discord', added);
  const origin = { kind: 'agent' as const, agentName: 'sol' };
  const closed = await registry.handleChannelToolCall('channel_close', { channelId: 'closed-by-agent' }, origin);
  assert.deepEqual(closed.data, { channelId: 'closed-by-agent', status: 'already closed' });
  const declined = await registry.handleChannelToolCall(
    'channel_decline', { channelId: 'declined-by-agent', messageId: 'm1' }, origin);
  assert.equal(declined.success, true);
  // connectome-host's subscription-gc closes an idle channel in this shape.
  const gc = await registry.handleChannelToolCall(
    'channel_close', { channelId: 'closed-by-gc', source: 'subscription-gc' }, { kind: 'module', moduleName: 'subscription-gc' });
  assert.deepEqual(gc.data, { channelId: 'closed-by-gc', status: 'already closed' });

  // Policy now admits every channel, and all three register again.
  registry.setSubscriptionPolicy('discord', 'auto');
  const opensBefore = openCalls.length;
  await registry.handleChanged('discord', added);

  assert.equal(registry.getDesiredState('discord', 'closed-by-agent'), 'closed', 'the close sticks');
  assert.equal(registry.getDesiredState('discord', 'declined-by-agent'), 'closed', 'the decline sticks');
  assert.equal(registry.getDesiredState('discord', 'closed-by-gc'), 'open', 'a machine close decided nothing');
  assert.deepEqual(openCalls.slice(opensBefore).map((c) => c.channelId), ['closed-by-gc'], 'policy opens only that one');
});

test("a machine's close of a channel with no record leaves it the default it was, so policy can still open it (#417)", async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  // Registered lazily, from a message: no decision on record.
  registry.ensureChannelRegistered('discord', 'lazy-1', '#lazy');
  const gc = await registry.handleChannelToolCall(
    'channel_close', { channelId: 'lazy-1', source: 'subscription-gc' }, { kind: 'module', moduleName: 'subscription-gc' });
  assert.equal(gc.success, true);
  assert.equal(registry.getDesiredState('discord', 'lazy-1'), 'closed');
  assert.equal(registry.closedByAgent('discord', 'lazy-1'), undefined);

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
    /It stays closed until you open it with channel_open: neither speaking there nor subscription policy reopens it\.$/);
});

test('resolveSendTarget names the channel a send went to and guesses nothing', async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  const added = (id: string, raw: string) => ({
    id, type: 'discord', label: `#${raw}`, direction: 'bidirectional', address: { guildId: 'g', channelId: raw },
  });
  await registry.handleChanged('discord-a', { added: [added('discord:g:444', '444'), added('discord:g:555', '555')] } as never);
  await registry.handleChanged('discord-b', { added: [added('discord:h:555', '555')] } as never);
  const opensBefore = openCalls.length;

  assert.equal(registry.resolveSendTarget('discord:g:444'), 'discord:g:444', 'a descriptor id');
  assert.equal(registry.resolveSendTarget('444', 'discord-a'), 'discord:g:444', 'a raw id, on its server');
  assert.equal(registry.resolveSendTarget('444', 'discord-b'), undefined, 'not on another server');
  assert.equal(registry.resolveSendTarget('555'), undefined, 'a raw id two servers share');
  assert.equal(registry.resolveSendTarget('555', 'discord-b'), 'discord:h:555', 'the server settles it');
  assert.equal(registry.resolveSendTarget('999', 'discord-a'), undefined, 'an unknown id');
  assert.equal(openCalls.length, opensBefore, 'a lookup opens nothing');
});

test("openForSpeech opens a closed channel nobody decided to keep closed, and leaves every other one as it is", async () => {
  const { registry, openCalls } = makeRegistry({ delivered: true });
  const ids = ['undecided', 'agent-closed', 'decided-open', 'tuned-out', 'open-now'];
  await registry.handleChanged('discord', {
    added: ids.map((id) => ({ id, type: 'discord', label: `#${id}`, direction: 'bidirectional' })),
  } as never);
  const agent = { kind: 'agent' as const, agentName: 'sol' };
  await registry.handleChannelToolCall('channel_close', { channelId: 'agent-closed' }, agent);
  await registry.handleChannelToolCall('channel_open', { channelId: 'open-now' }, agent);
  await registry.handleChannelToolCall('channel_open', { channelId: 'tuned-out' }, agent);
  registry.enterTuneOut('discord', 'tuned-out', { epochId: 'e1', cadenceSeconds: 600, backlogCap: 20, maxWakes: 3, startedAtSequence: 0 }, 'agent-tool');
  // Decided open, with its transport down.
  await registry.handleChannelToolCall('channel_open', { channelId: 'decided-open' }, agent);
  (registry as unknown as { findChannelEntry(id: string): { open: boolean } }).findChannelEntry('decided-open').open = false;
  const opensBefore = openCalls.length;

  assert.equal(await registry.openForSpeech('discord', 'undecided', 'opened-by-reply'), 'opened');
  assert.equal(await registry.openForSpeech('discord', 'agent-closed', 'opened-by-reply'), 'not-opened');
  assert.equal(await registry.openForSpeech('discord', 'decided-open', 'opened-by-reply'), 'not-opened');
  assert.equal(await registry.openForSpeech('discord', 'tuned-out', 'opened-by-reply'), 'not-opened');
  assert.equal(await registry.openForSpeech('discord', 'open-now', 'opened-by-reply'), 'not-opened');
  assert.equal(await registry.openForSpeech('discord', 'nowhere', 'opened-by-reply'), 'unknown-channel');

  assert.deepEqual(openCalls.slice(opensBefore).map((c) => c.channelId), ['undecided']);
  assert.equal(registry.getDesiredState('discord', 'undecided'), 'open');
  assert.equal(registry.getDesiredState('discord', 'tuned-out'), 'tuned-out', 'the tune-out stands');
  assert.equal(registry.closedByAgent('discord', 'agent-closed'), 'closed');
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
