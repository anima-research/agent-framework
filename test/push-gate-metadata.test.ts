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
