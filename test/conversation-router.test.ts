import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRouter } from '../src/mcpl/conversation-router.js';
import type { ChannelDescriptor } from '../src/mcpl/types.js';

const T0 = 1_750_000_000_000;

function makeRouter(overrides: Partial<ConstructorParameters<typeof ConversationRouter>[0]> = {}) {
  return new ConversationRouter({ templateAgent: 'trunk', ...overrides });
}

// ---------------------------------------------------------------------------
// Bind policy
// ---------------------------------------------------------------------------

test('DM message binds without a mention (default dm bind: always)', () => {
  const router = makeRouter();
  const decision = router.route({ channelId: 'slack:D1', mentioned: false, kind: 'dm' });
  assert.equal(decision.kind, 'spawn');
  if (decision.kind === 'spawn') {
    assert.equal(decision.generation, 1);
    assert.match(decision.agentName, /^conversation-slack-D1-g1$/);
    assert.equal(decision.trigger, true);
  }
});

test('channel message without mention stays unbound (default channel bind: mention)', () => {
  const router = makeRouter();
  const decision = router.route({ channelId: 'slack:C1', mentioned: false, kind: 'channel' });
  assert.equal(decision.kind, 'unbound');
});

test('channel mention spawns a fork', () => {
  const router = makeRouter();
  const decision = router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  assert.equal(decision.kind, 'spawn');
});

test('bind rule never keeps DMs unbound', () => {
  const router = makeRouter({ bind: { dm: 'never' } });
  const decision = router.route({ channelId: 'slack:D1', mentioned: true, kind: 'dm' });
  assert.equal(decision.kind, 'unbound');
});

// ---------------------------------------------------------------------------
// Spawn is two-phase: route() proposes, bind() commits
// ---------------------------------------------------------------------------

test('spawn decision does not create the binding until bind() is called', () => {
  const router = makeRouter();
  const d1 = router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  assert.equal(d1.kind, 'spawn');
  assert.equal(router.getBinding('slack:C1'), undefined);

  // Framework failed to spawn → next mention proposes the same generation.
  const d2 = router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  assert.equal(d2.kind, 'spawn');
  if (d2.kind === 'spawn') assert.equal(d2.generation, 1);

  if (d2.kind === 'spawn') router.bind('slack:C1', d2.agentName, d2.generation, T0 + 1);
  const d3 = router.route({ channelId: 'slack:C1', mentioned: false, kind: 'channel' });
  assert.equal(d3.kind, 'existing');
});

// ---------------------------------------------------------------------------
// Trigger policy on bound channels
// ---------------------------------------------------------------------------

test('bound channel: non-mentions land without triggering, mentions trigger', () => {
  const router = makeRouter();
  router.bind('slack:C1', 'conversation-slack-C1-g1', 1, T0);

  const ambient = router.route({ channelId: 'slack:C1', mentioned: false, kind: 'channel' });
  assert.equal(ambient.kind, 'existing');
  if (ambient.kind === 'existing') assert.equal(ambient.trigger, false);

  const mention = router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  assert.equal(mention.kind, 'existing');
  if (mention.kind === 'existing') assert.equal(mention.trigger, true);
});

test('bound DM: every message triggers', () => {
  const router = makeRouter();
  router.bind('slack:D1', 'conversation-slack-D1-g1', 1, T0);
  const decision = router.route({ channelId: 'slack:D1', mentioned: false, kind: 'dm' });
  assert.equal(decision.kind, 'existing');
  if (decision.kind === 'existing') assert.equal(decision.trigger, true);
});

// ---------------------------------------------------------------------------
// TTL + generations
// ---------------------------------------------------------------------------

test('routing queries leave the binding and its expiry clock unchanged', () => {
  const router = makeRouter({ idleTtlMs: 1000 });
  router.bind('slack:C1', 'fork-a', 3, T0);
  const before = { ...router.getBinding('slack:C1')! };
  const generations = router.exportGenerations();

  assert.equal(router.route({ channelId: 'slack:C1', mentioned: false, kind: 'channel' }).kind, 'existing');
  assert.equal(router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' }).kind, 'existing');
  assert.deepEqual(router.getBinding('slack:C1'), before, 'previewing a route must not prolong an engagement');
  assert.deepEqual(router.exportGenerations(), generations);
  assert.equal(router.expired(T0 + 1001).length, 1);
});

test('touch() refreshes expiry explicitly and leaves unbound channels alone', () => {
  const router = makeRouter({ idleTtlMs: 1000 });
  router.bind('slack:C1', 'conversation-slack-C1-g1', 1, T0);

  // Delivery records activity independently of the routing query.
  router.touch('slack:C1', T0 + 900);
  router.touch('slack:unknown', T0 + 900);
  assert.equal(router.getBinding('slack:unknown'), undefined);
  assert.deepEqual(router.exportGenerations(), { 'slack:C1': 1 });
  assert.deepEqual(router.expired(T0 + 1500), []);
  assert.equal(router.expired(T0 + 1901).length, 1);
});

test('rebind after expiry gets a fresh generation and agent name', () => {
  const router = makeRouter({ idleTtlMs: 1000 });
  const d1 = router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  if (d1.kind !== 'spawn') assert.fail('expected spawn');
  router.bind('slack:C1', d1.agentName, d1.generation, T0);

  router.unbind('slack:C1'); // framework does this after the closure turn

  const d2 = router.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  assert.equal(d2.kind, 'spawn');
  if (d2.kind === 'spawn') {
    assert.equal(d2.generation, 2);
    assert.match(d2.agentName, /-g2$/);
    assert.notEqual(d2.agentName, d1.agentName);
  }
});

test('channelForAgent reverse lookup', () => {
  const router = makeRouter();
  router.bind('slack:C1', 'fork-a', 1, T0);
  assert.equal(router.channelForAgent('fork-a'), 'slack:C1');
  assert.equal(router.channelForAgent('fork-b'), undefined);
});

// ---------------------------------------------------------------------------
// Channel classification
// ---------------------------------------------------------------------------

test('classifyChannel reads descriptor metadata and message channel_type', () => {
  const im: ChannelDescriptor = {
    id: 'slack:D1', type: 'slack', label: 'DM: @alice', direction: 'bidirectional',
    address: {}, metadata: { is_im: true },
  };
  const mpim: ChannelDescriptor = {
    id: 'slack:G1', type: 'slack', label: 'Group DM', direction: 'bidirectional',
    address: {}, metadata: { is_mpim: true },
  };
  const channel: ChannelDescriptor = {
    id: 'slack:C1', type: 'slack', label: '#general', direction: 'bidirectional',
    address: {}, metadata: { is_member: true },
  };
  assert.equal(ConversationRouter.classifyChannel(im), 'dm');
  assert.equal(ConversationRouter.classifyChannel(mpim), 'groupDm');
  assert.equal(ConversationRouter.classifyChannel(channel), 'channel');
  assert.equal(ConversationRouter.classifyChannel(undefined, { channel_type: 'im' }), 'dm');
  assert.equal(ConversationRouter.classifyChannel(undefined, { channel_type: 'mpim' }), 'groupDm');
  assert.equal(ConversationRouter.classifyChannel(undefined, { channel_type: 'channel' }), 'channel');
  assert.equal(ConversationRouter.classifyChannel(undefined, undefined), 'channel');
});

test('group DMs bind on any message but trigger only on mention by default', () => {
  const router = new ConversationRouter({ templateAgent: 'main' });
  const ambient = router.route({ channelId: 'slack:G1', mentioned: false, kind: 'groupDm' });
  assert.equal(ambient.kind, 'spawn', 'group DM binds without a mention');
  assert.equal((ambient as { trigger: boolean }).trigger, false, 'no firehose replies in group DMs');

  const mention = router.route({ channelId: 'slack:G2', mentioned: true, kind: 'groupDm' });
  assert.equal(mention.kind, 'spawn');
  assert.equal((mention as { trigger: boolean }).trigger, true, 'mention triggers');
});

test('generation counters export/hydrate round-trips and never regresses', () => {
  const router = new ConversationRouter({ templateAgent: 'main' });
  router.bind('slack:C1', 'conversation-slack-C1-g3', 3, T0);
  router.bind('slack:D1', 'conversation-slack-D1-g1', 1, T0);
  const exported = router.exportGenerations();
  assert.deepEqual(exported, { 'slack:C1': 3, 'slack:D1': 1 });

  const restored = new ConversationRouter({ templateAgent: 'main' });
  restored.hydrateGenerations(exported);
  const decision = restored.route({ channelId: 'slack:C1', mentioned: true, kind: 'channel' });
  assert.equal(decision.kind, 'spawn');
  assert.equal((decision as { generation: number }).generation, 4, 'restart must not reuse generation names');

  // Hydration never regresses a counter that advanced in the meantime.
  restored.bind('slack:D1', 'conversation-slack-D1-g5', 5, T0);
  restored.hydrateGenerations(exported);
  const d1 = restored.route({ channelId: 'slack:D2', mentioned: false, kind: 'dm' });
  assert.equal(d1.kind, 'spawn', 'sanity');
  assert.equal(restored.exportGenerations()['slack:D1'], 5);
});
