/**
 * Speaking never opens a channel, so a channel the agent answers stays
 * closed, and its later messages keep arriving as push events. Where a turn
 * with no trigger (a heartbeat) speaks still follows the agent there: on main
 * the answer opened the channel, and its channels/incoming messages moved the
 * most recent inbound channel. A push from a channel the agent answered while
 * it was closed now moves it the same way, until the next decision about the
 * channel; a push from any other channel moves nothing, as before. The test
 * runs over a real MCPL wire (a loopback server) into the framework's own
 * ChannelRegistry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixture, TS } from './helpers/coalescing-fixture.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const registryOf = (f: Fixture) => (f.framework as unknown as { channelRegistry: ChannelRegistry }).channelRegistry;

/** A message from `channelId` that addresses the agent, as a closed channel's
 *  connector sends it; `coalesce` makes it a channel-scoped coalesced push. */
const push = (eventId: string, channelId: string, tags: string[], coalesce?: Record<string, unknown>) => ({
  featureSet: 'doc',
  eventId,
  timestamp: TS,
  origin: { mcplChannelId: channelId, messageId: `m-${eventId}`, authorId: 'u', authorName: 'User' },
  tags,
  payload: { content: [{ type: 'text', text: `message ${eventId}` }] },
  ...(coalesce ? { coalesce: { channelId, key: `message:m-${eventId}`, ...coalesce } } : {}),
});

async function setUp(f: Fixture) {
  await f.send('channels/register', {
    channels: ['lobby', 'dm', 'quiet'].map((id) => ({ id, type: 'discord', label: id })),
  });
  // An open channel's message: the most recent inbound channel is the lobby.
  await f.send('channels/incoming', {
    messages: [{ channelId: 'lobby', messageId: 'l1', timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'hello all' }] }],
  });
  const registry = registryOf(f);
  assert.equal(registry.getDefaultPublishChannel(), 'lobby');
  assert.equal(registry.isChannelOpen('dm'), false);
  return registry;
}

test('a push from a channel the agent answered while closed is where a turn with no trigger speaks', async (t) => {
  const f = await fixture(); t.after(f.close);
  const registry = await setUp(f);

  // Petra's control: a closed channel nobody answered moves nothing.
  await f.send('push/event', push('q1', 'quiet', ['chat:mention', 'chat:addressed']));
  assert.equal(registry.getDefaultPublishChannel(), 'lobby');

  // The agent answers the DM; it stays closed.
  assert.deepEqual(await registry.routeSpeech('agent', 'happy to help', 'dm'), { delivered: true, channelId: 'dm' });
  assert.equal(registry.isChannelOpen('dm'), false);

  // A reaction to the answer isn't where a message came in.
  await f.send('push/event', push('r1', 'dm', ['chat:reaction']));
  assert.equal(registry.getDefaultPublishChannel(), 'lobby');

  // The DM's next message arrives by push, and a turn with no trigger speaks there.
  await f.send('push/event', push('d1', 'dm', ['chat:dm', 'chat:addressed', 'chat:private']));
  assert.equal(registry.getDefaultPublishChannel(), 'dm');
  assert.equal(registry.resolveLocus('agent'), 'dm');
  await registry.routeSpeech('agent', 'the heartbeat speaks', registry.resolveLocus('agent'));
  assert.equal(f.published.at(-1)?.channelId, 'dm');

  // The agent's close is the next decision about it: the answer ends there.
  await f.send('channels/incoming', {
    messages: [{ channelId: 'lobby', messageId: 'l2', timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'again' }] }],
  });
  await registry.handleChannelToolCall('channel_close', { channelId: 'dm' }, { kind: 'agent', agentName: 'agent' });
  await f.send('push/event', push('d2', 'dm', ['chat:dm', 'chat:addressed', 'chat:private']));
  assert.equal(registry.getDefaultPublishChannel(), 'lobby');
});

test('the answer survives a restart: after a reload, a push from the answered channel still moves the fallback', async (t) => {
  const f = await fixture(); t.after(f.close);
  const registry = await setUp(f);
  await registry.routeSpeech('agent', 'happy to help', 'dm');

  await f.framework.stop();
  await f.create();
  const reloaded = await setUp(f);
  assert.notEqual(reloaded, registry, 'a new framework, over the same store');

  await f.send('push/event', push('q1', 'quiet', ['chat:mention', 'chat:addressed']));
  assert.equal(reloaded.getDefaultPublishChannel(), 'lobby');
  await f.send('push/event', push('d1', 'dm', ['chat:dm', 'chat:addressed']));
  assert.equal(reloaded.getDefaultPublishChannel(), 'dm');
});

test("a coalesced push counts once, when it's admitted afresh, and a withdrawal never does", async (t) => {
  const f = await fixture(); t.after(f.close);
  const registry = await setUp(f);
  await registry.routeSpeech('agent', 'happy to help', 'dm');

  const first = push('c1', 'dm', ['chat:dm', 'chat:addressed'], { initial: true });
  await f.send('push/event', first);
  assert.equal(registry.getDefaultPublishChannel(), 'dm', 'the channel-scoped push a connector sends for a closed channel');

  // The lobby speaks; then the producer retries the DM push it already sent.
  await f.send('channels/incoming', {
    messages: [{ channelId: 'lobby', messageId: 'l2', timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'again' }] }],
  });
  await f.send('push/event', first);
  assert.equal(registry.getDefaultPublishChannel(), 'lobby', "a retry of acknowledged work isn't a new message");

  // A withdrawal of the DM's message, tagged as a message so only the
  // withdrawal itself can keep it from counting.
  const withdrawal = { ...push('c2', 'dm', ['chat:dm', 'chat:addressed']), coalesce: { channelId: 'dm', key: 'message:m-c1', retract: true }, payload: { content: [] } };
  const r = await f.send('push/event', withdrawal);
  assert.equal(r.error, undefined, 'the withdrawal is accepted');
  assert.equal(registry.getDefaultPublishChannel(), 'lobby', 'a withdrawal is never where a message came in');
});
