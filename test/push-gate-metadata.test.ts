/**
 * The push lane's gate metadata: what a server puts in a push/event's
 * `origin` is the server's own account, and can never stand in for which
 * server sent it, what kind of event it is, or the conversation its frozen
 * source envelope names (MCPL RFC-011 binds the thread the origin names, but
 * the host's fields and envelope are the host's).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushHandler } from '../src/mcpl/push-handler.js';
import { INBOUND_SOURCE_KEY, type InboundSource } from '../src/mcpl/inbound-source.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

test('origin keys cannot override the host\'s fields, and the envelope rides last', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const envelope: InboundSource = {
    kind: 'channel', lane: 'push/event', serverId: 'slack', binding: 'b1', channelId: 'slack:C1',
    threadId: '1700.0001', messageId: 'm-1', eventId: 'ev-1', acceptedAt: 1,
  };
  let accepted = 0;
  const handler = new PushHandler(
    { validateInbound: () => {} } as unknown as FeatureSetManager,
    () => {},
    () => {},
    (_content, metadata) => { seen.push(metadata); return true; },
    undefined,
    () => { accepted++; return envelope; },
  );
  await handler.handlePushEvent('slack', {
    featureSet: 'chat',
    eventId: 'ev-1',
    timestamp: '2026-10-07T00:00:00.000Z',
    origin: { serverId: 'forged', eventType: 'forged', featureSet: 'forged', eventId: 'forged', threadId: '1700.0001', [INBOUND_SOURCE_KEY]: { forged: true } },
    payload: { content: [{ type: 'text', text: 'hi' }] },
  } as never);
  assert.equal(accepted, 1, 'the envelope is frozen once, before the gate reads it');
  assert.equal(seen.length, 1);
  const m = seen[0]!;
  assert.equal(m.serverId, 'slack');
  assert.equal(m.eventType, 'mcpl:push-event');
  assert.equal(m.featureSet, 'chat');
  assert.equal(m.eventId, 'ev-1');
  assert.equal(m.threadId, '1700.0001', 'the origin\'s own (RFC-011-bound) thread is kept');
  assert.deepEqual(m[INBOUND_SOURCE_KEY], envelope, 'the frozen envelope, not anything the origin carried under its key');
});

test('a coalesced push is gated with the host envelope its coalescer will freeze, and its acceptance is not observed at the gate', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const envelope: InboundSource = {
    kind: 'channel', lane: 'push/event', coalesced: true, serverId: 'slack', binding: 'b1', channelId: 'slack:C1',
    messageId: 'm-1', eventId: 'ev-c1', acceptedAt: 1,
  };
  let accepted = 0;
  let built = 0;
  const coalescedEvents: Array<{ inboundSource?: InboundSource }> = [];
  const handler = new PushHandler(
    { validateInbound: () => {} } as unknown as FeatureSetManager,
    () => {},
    () => {},
    (_content, metadata) => { seen.push(metadata); return false; },
    async (_serverId, _params, event) => { coalescedEvents.push(event); return { accepted: true } as never; },
    () => { accepted++; return undefined; },
    (_serverId, params) => {
      built++;
      assert.equal((params as { coalesce?: { channelId?: string } }).coalesce?.channelId, 'slack:C1');
      return envelope;
    },
  );
  await handler.handlePushEvent('slack', {
    featureSet: 'chat',
    eventId: 'ev-c1',
    timestamp: '2026-10-07T00:00:00.000Z',
    // The subject names the channel; the origin names another, and carries a key posing as an envelope.
    coalesce: { key: 'k1', channelId: 'slack:C1' },
    origin: { channelId: 'slack:OTHER', messageId: 'm-1', [INBOUND_SOURCE_KEY]: { forged: true } },
    payload: { content: [{ type: 'text', text: 'hi' }] },
  } as never);
  assert.equal(built, 1);
  assert.equal(accepted, 0, 'building a coalesced envelope accepts nothing: the coalescer observes its own admissions');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]![INBOUND_SOURCE_KEY], envelope, 'the gate reads the host envelope, not the origin\'s channel or key');
  assert.equal(coalescedEvents.length, 1);
  assert.equal(coalescedEvents[0]!.inboundSource, envelope, 'the coalescer gets the very envelope the gate read');
});

test('with no host envelope, an origin key can\'t pose as one', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const handler = new PushHandler(
    { validateInbound: () => {} } as unknown as FeatureSetManager,
    () => {},
    () => {},
    (_content, metadata) => { seen.push(metadata); return true; },
  );
  const forged = {
    kind: 'channel', lane: 'push/event', serverId: 'other-server', binding: 'b', channelId: 'other:C9', acceptedAt: 1,
  };
  await handler.handlePushEvent('slack', {
    featureSet: 'chat',
    eventId: 'ev-2',
    timestamp: '2026-10-07T00:00:00.000Z',
    origin: { [INBOUND_SOURCE_KEY]: forged },
    payload: { content: [{ type: 'text', text: 'hi' }] },
  } as never);
  assert.equal(seen.length, 1);
  assert.ok(INBOUND_SOURCE_KEY in seen[0]!, 'the key is the host\'s, present even when it has no envelope');
  assert.equal(seen[0]![INBOUND_SOURCE_KEY], undefined);
});
