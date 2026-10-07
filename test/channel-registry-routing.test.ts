import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry, type SpeechRouteView } from '../src/mcpl/channel-registry.js';
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
  speechRouteResolver?: (agentName: string) => SpeechRouteView,
  onChannelAutoOpened?: (info: {
    conversationId?: string;
    serverId: string;
    source: 'subscription-policy' | 'opened-by-delivery';
    channels: Array<{ channelId: string; label?: string }>;
  }) => void,
) {
  const failures: RouteFailure[] = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const publishCalls: Array<{ channelId?: string; conversationId?: string; threadId?: string | null }> = [];

  const openCalls: Array<{ channelId?: string }> = [];
  const closeCalls: Array<{ channelId?: string }> = [];
  let failOpens = false;

  const mockServer = {
    // Post-policy state: full grant, so tests exercise delivery, not §5.3 denial.
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { channelId?: string; conversationId?: string; threadId?: string | null }) => {
      publishCalls.push(params);
      // A conforming MCPL RFC-011 server: a delivery echoes the place asked for.
      return publishResult?.delivered === true && 'threadId' in params ? { ...publishResult, threadId: params.threadId } : publishResult;
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
      speechRouteResolver,
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


/** §14.5: channels/incoming no longer mints unknown channels — seed the
 *  registered state a conforming server would have created via
 *  channels/register before feeding incoming traffic. Each channel declares
 *  an MCPL RFC-011 publish target (`root`), as a conforming server's do. */
function seedRegistered(registry: ChannelRegistry, serverId: string, ...ids: string[]): void {
  const map = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: Record<string, unknown>; open: boolean }>;
  }).channels;
  for (const id of ids) {
    if (!map.has(`${serverId}:${id}`)) {
      map.set(`${serverId}:${id}`, {
        serverId,
        descriptor: { id, type: serverId, label: id, capabilities: { publish: { target: 'root' } } },
        open: false,
      });
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

test('the gate reads a message\'s thread from the protocol field, never from adapter metadata', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const registry = new ChannelRegistry(
    { getServer: () => undefined } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { shouldTriggerInference: (_content, metadata) => { seen.push(metadata); return true; } },
  );
  seedRegistered(registry, 'slack', 'slack:C1');
  const message = (extra: Record<string, unknown>) => ({
    messages: [{
      channelId: 'slack:C1', messageId: `m-${seen.length}`, author: { id: 'u1', name: 'Ada' },
      timestamp: '2026-10-07T00:00:00.000Z', content: [{ type: 'text' as const, text: 'hi' }], ...extra,
    }],
  });
  // A root message whose adapter metadata happens to carry a threadId key.
  await registry.handleIncoming('slack', message({ metadata: { threadId: 'forged', messageId: 'forged-m' } }));
  // A thread message whose adapter metadata disagrees with the protocol field.
  await registry.handleIncoming('slack', message({ threadId: '1700.0001', metadata: { threadId: 'forged' } }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.threadId, undefined, 'a root message stays at the root');
  assert.equal(seen[0]!.messageId, 'm-0', 'the protocol message id wins too');
  assert.equal(seen[1]!.threadId, '1700.0001');
});

test('routeSpeech surfaces a failure when the server reports delivered:false', async () => {
  const { registry, failures, traces } = makeRegistry({ delivered: false });
  seedRegistered(registry, 'discord', 'ch-x');
  registry.handleIncoming('discord', incoming('ch-x', 'hi'));

  const res = await registry.routeSpeech('cairn', 'undeliverable reply', 'ch-x');

  assert.equal(res, null, 'a non-delivered send must not report success');
  assert.equal(failures.length, 1, 'onRouteFailure should fire');
  assert.equal(failures[0].channelId, 'ch-x');
  assert.match(failures[0].reason, /delivered:false/);
  assert.ok(traces.some(t => t.type === 'mcpl:speech-route-failed'));
});

test('routeSpeech routes a conversation fork to its HOME channel, whatever arrives elsewhere (item 3)', async () => {
  // Two channels are live and chanB spoke last. A fork bound to chanA must
  // still publish to chanA.
  const homes: Record<string, string> = { 'conversation-chanA-g1': 'chanA' };
  const { registry, publishCalls } = makeRegistry(
    { delivered: true },
    (agentName) => homes[agentName],
  );

  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));

  const res = await registry.routeSpeech('conversation-chanA-g1', 'reply for A', registry.resolveLocus('conversation-chanA-g1'));
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'chanA', label: 'chanA' },
    'fork must route to its home channel, not the last inbound');
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA');
});

test('incoming traffic never selects a destination: without a home there is no locus (shelf-355)', async () => {
  // The old registry tracked the process-global most-recent inbound channel
  // and routed homeless speech there. Now a route comes only from a turn's
  // own wake or a deliberate choice, which the framework holds.
  const { registry, publishCalls, failures } = makeRegistry(
    { delivered: true },
    () => undefined, // no agent has a home
  );

  seedRegistered(registry, 'discord', 'chanA');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  seedRegistered(registry, 'discord', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));

  assert.equal(registry.resolveLocus('trunk'), null);
  assert.equal(registry.buildChannelContext('trunk')?.defaultOutgoing, undefined,
    'nothing is advertised as where speech goes');
  const res = await registry.routeSpeech('trunk', 'heartbeat reply', registry.resolveLocus('trunk'));
  assert.equal(res, null);
  assert.equal(publishCalls.length, 0);
  assert.match(failures.at(-1)!.reason, /no locus/);
});

test('buildChannelContext advertises the agent\'s own route and its reply edge, and nothing for a held or absent route', () => {
  const routes: Record<string, SpeechRouteView> = {
    'conversation-chanA-g1': { kind: 'channel', serverId: 'discord', channelId: 'chanA' },
    scout: { kind: 'channel', serverId: 'discord', channelId: 'chanB', replyTo: 'm-7', threadId: 't-1' },
    held: { kind: 'held', conversations: ['#chanA (chanA)', '#chanB (chanB)'] },
    tui: { kind: 'surface', surface: 'tui' },
  };
  const { registry } = makeRegistry({ delivered: true }, () => undefined, (n) => routes[n] ?? { kind: 'none' });
  seedRegistered(registry, 'discord', 'chanA', 'chanB');
  registry.handleIncoming('discord', incoming('chanA', 'hi from A'));
  registry.handleIncoming('discord', incoming('chanB', 'hi from B'));

  assert.equal(registry.buildChannelContext('conversation-chanA-g1')?.defaultOutgoing?.channelId, 'chanA');
  const scout = registry.buildChannelContext('scout');
  assert.equal(scout?.defaultOutgoing?.channelId, 'chanB');
  assert.deepEqual(scout?.incoming, { channelId: 'chanB', messageId: 'm-7', threadId: 't-1' },
    'the reply edge is the route\'s own triggering message');
  for (const agent of ['held', 'tui', 'nobody']) {
    const ctx = registry.buildChannelContext(agent);
    assert.equal(ctx?.defaultOutgoing, undefined, `${agent}: no outgoing channel`);
    assert.equal(ctx?.incoming, undefined, `${agent}: no reply edge`);
  }
});

test('a route that names its server publishes there, even when another server registers the same channel id', async () => {
  const published: Array<{ server: string; channelId?: string }> = [];
  const server = (id: string) => ({
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async (params: { channelId?: string; threadId?: string | null }) => {
      published.push({ server: id, channelId: params.channelId });
      return { delivered: true, messageId: `${id}-1`, threadId: params.threadId };
    },
    sendChannelsOpen: async () => ({}),
  });
  const servers: Record<string, unknown> = { a: server('a'), b: server('b') };
  const registry = new ChannelRegistry(
    { getServer: (id: string) => servers[id] } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    {},
  );
  seedRegistered(registry, 'a', 'shared');
  seedRegistered(registry, 'b', 'shared');

  const res = await registry.routeSpeech('scout', 'to b', { serverId: 'b', channelId: 'shared' });
  assert.deepEqual(res, { delivered: true, serverId: 'b', channelId: 'shared', label: 'shared', messageId: 'b-1' });
  assert.deepEqual(published, [{ server: 'b', channelId: 'shared' }]);
  // Without the server, the shared id is refused rather than guessed.
  assert.equal(await registry.routeSpeech('scout', 'which one?', 'shared'), null);
  assert.equal(published.length, 1);
});

test('routeSpeech surfaces a failure when there is no locus at all', async () => {
  const { registry, failures } = makeRegistry({ delivered: true });
  const res = await registry.routeSpeech('cairn', 'into the void', registry.resolveLocus('cairn'));
  assert.equal(res, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].channelId, null);
  assert.match(failures[0].reason, /no locus/);
});

// ── channel_publish: an explicit send through the publish executor ──

test('channel_publish without a channel goes to the caller\'s route, and its receipt names the destination', async () => {
  const { registry, publishCalls } = makeRegistry(
    { delivered: true, messageId: 'p-1' } as { delivered?: boolean },
    () => undefined,
    (n) => (n === 'scout' ? { kind: 'channel', serverId: 'discord', channelId: 'chanA' } : { kind: 'none' }),
  );
  seedRegistered(registry, 'discord', 'chanA', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'chanB spoke last'));

  const res = await registry.handleChannelToolCall('channel_publish', { content: 'hello' }, { kind: 'agent', agentName: 'scout' });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { delivered: true, status: 'delivered', serverId: 'discord', channelId: 'chanA', channelLabel: 'chanA', threadId: null, messageId: 'p-1' });
  assert.equal(publishCalls.at(-1)?.channelId, 'chanA', 'the route, not the last inbound channel');
});

test('a route whose server is unknown resolves the same way for channel_publish as for plain speech', async () => {
  const { registry, publishCalls } = makeRegistry(
    { delivered: true, messageId: 'p-2' } as { delivered?: boolean },
    () => undefined,
    () => ({ kind: 'channel', channelId: 'chanA' }),
  );
  seedRegistered(registry, 'discord', 'chanA');
  const published = await registry.handleChannelToolCall('channel_publish', { content: 'explicit' }, { kind: 'agent', agentName: 'scout' });
  assert.equal(published.success, true, JSON.stringify(published));
  const spoken = await registry.routeSpeech('scout', 'plain speech', 'chanA');
  assert.deepEqual(spoken, { delivered: true, serverId: 'discord', channelId: 'chanA', label: 'chanA', messageId: 'p-2' });
  assert.deepEqual(publishCalls.map((c) => c.channelId), ['chanA', 'chanA']);
});

test('channel_publish without a channel or a route is refused, never guessed', async () => {
  const views: Record<string, SpeechRouteView> = {
    held: { kind: 'held', conversations: ['#chanA (chanA)', '#chanB (chanB)'] },
    tui: { kind: 'surface', surface: 'tui' },
  };
  const { registry, publishCalls } = makeRegistry({ delivered: true }, () => undefined, (n) => views[n] ?? { kind: 'none' });
  seedRegistered(registry, 'discord', 'chanA', 'chanB');
  registry.handleIncoming('discord', incoming('chanB', 'chanB spoke last'));

  const none = await registry.handleChannelToolCall('channel_publish', { content: 'x' }, { kind: 'agent', agentName: 'nobody' });
  assert.equal(none.success, false);
  assert.match(none.error!, /No channelId given, and you have no current speech route: name the channel to publish to\. Nothing was sent\./);
  const held = await registry.handleChannelToolCall('channel_publish', { content: 'x' }, { kind: 'agent', agentName: 'held' });
  assert.match(held.error!, /your speech route is held between #chanA \(chanA\) and #chanB \(chanB\)/);
  const tui = await registry.handleChannelToolCall('channel_publish', { content: 'x' }, { kind: 'agent', agentName: 'tui' });
  assert.match(tui.error!, /your speech route is the local surface tui, not a channel/);
  const module = await registry.handleChannelToolCall('channel_publish', { content: 'x' }, { kind: 'module' });
  assert.match(module.error!, /you have no current speech route/);
  assert.equal(publishCalls.length, 0);
});

test('channel_publish checks supplied selectors before any default: an empty one is refused, never read as omitted', async () => {
  const { registry, publishCalls } = makeRegistry(
    { delivered: true, messageId: 'p-9' } as { delivered?: boolean },
    () => undefined,
    () => ({ kind: 'channel', serverId: 'discord', channelId: 'routed' }),
  );
  seedRegistered(registry, 'discord', 'only', 'routed');
  const caller = { kind: 'agent' as const, agentName: 'scout' };
  for (const [input, why] of [
    [{ channelId: 'only', serverId: '', content: 'x' }, /serverId must name a server/],
    [{ channelId: 'only', serverId: 7, content: 'x' }, /serverId must name a server/],
    [{ channelId: '', content: 'x' }, /channelId must name a channel/],
    [{ serverId: 'discord', content: 'x' }, /serverId needs the channelId it belongs to/],
    [{ channelId: 'only', threadId: '', content: 'x' }, /threadId must be a thread id/],
  ] as const) {
    const res = await registry.handleChannelToolCall('channel_publish', input, caller);
    assert.equal(res.success, false, JSON.stringify(input));
    assert.match(res.error!, why);
    assert.match(res.error!, /Nothing was sent\.$/);
  }
  assert.equal(publishCalls.length, 0, 'not the sole server, and not the route');
  // null means "not in use": the field is omitted, not invalid.
  const ok = await registry.handleChannelToolCall('channel_publish', { channelId: 'only', serverId: null, threadId: null, content: 'y' }, caller);
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.deepEqual(publishCalls.map((c) => [c.channelId, c.threadId]), [['only', null]]);
});

test('channel_publish reports failed and unknown outcomes with the attempted destination', async () => {
  const refused = makeRegistry({ delivered: false });
  seedRegistered(refused.registry, 'discord', 'chanA');
  const failed = await refused.registry.handleChannelToolCall('channel_publish', { channelId: 'chanA', content: 'x' }, { kind: 'agent', agentName: 'scout' });
  assert.equal(failed.success, false);
  assert.match(failed.error!, /^Not sent to chanA \(chanA\): .*Nothing was posted\.$/);
  assert.deepEqual(
    { status: (failed.data as { status: string }).status, serverId: (failed.data as { serverId: string }).serverId, channelId: (failed.data as { channelId: string }).channelId },
    { status: 'failed', serverId: 'discord', channelId: 'chanA' },
  );

  const silent = makeRegistry(undefined);
  seedRegistered(silent.registry, 'discord', 'chanA');
  const unknown = await silent.registry.handleChannelToolCall('channel_publish', { channelId: 'chanA', content: 'x' }, { kind: 'agent', agentName: 'scout' });
  assert.equal(unknown.success, false);
  assert.match(unknown.error!, /^Delivery to chanA \(chanA\) was not confirmed — it may or may not have been posted: .*Check the channel before sending again\.$/);
  assert.equal((unknown.data as { status: string }).status, 'unknown');
});

test('ensureChannelRegistered keeps a DM closed; the reply goes out once its connector declares the channel', async () => {
  // A Discord DM arrives via push/event (channel closed). The host registers
  // it lazily so it resolves — but a host-minted channel carries no MCPL
  // RFC-011 declaration, so the framework doesn't publish there: the
  // connector might choose the place itself. A connector that registers the
  // DM with a declaration (as discord-mcpl does) makes the reply routable.
  const dm = 'discord:dm:42';
  const { registry, publishCalls, lookup, traces } = makeRegistry(
    { delivered: true },
    () => undefined,
  );

  // No prior handleIncoming for the DM — it only ever came as a push event.
  assert.equal(lookup(dm), undefined);

  registry.ensureChannelRegistered('discord', dm, 'DM with Antra');

  const entry = lookup(dm);
  assert.ok(entry, 'the DM channel should be registered');
  assert.equal(entry!.serverId, 'discord');
  assert.equal(entry!.open, false, 'one-shot reachability is not a subscription');
  assert.ok(traces.some((t) => t.type === 'mcpl:channel-lazy-registered'));

  const undeclared = await registry.routeSpeech('scout', 'replying in the DM', { serverId: 'discord', channelId: dm });
  assert.equal(undeclared, null, 'no declaration, no publication');
  assert.equal(publishCalls.length, 0);

  await registry.handleChanged('discord', {
    updated: [{ id: dm, type: 'discord', label: 'DM with Antra', direction: 'bidirectional', capabilities: { publish: { target: 'root' } } }],
  });
  const res = await registry.routeSpeech('scout', 'replying in the DM', { serverId: 'discord', channelId: dm });
  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: dm, label: 'DM with Antra' },
    'the DM reply routes back to the DM channel once it is declared');
  assert.equal(publishCalls.at(-1)?.channelId, dm);
  assert.equal(publishCalls.at(-1)?.threadId, null, 'at the channel itself');
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

  assert.deepEqual(res, { delivered: true, serverId: 'discord', channelId: 'dm-alice', label: 'dm-alice' });
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
