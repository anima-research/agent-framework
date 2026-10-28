/**
 * The gate decides a push by the host's facts about it: the server that sent
 * it and the event type the host gives pushes. A push's `origin` is the
 * server's own claim (MCPL SPEC §16.6) and can't move it under another
 * server's or event type's policy, in either push lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';

const QUIET_EDITOR = {
  gate: { config: { default: 'always', policies: [
    { name: 'quiet-editor', match: { scope: ['mcpl:push-event'], source: 'editor' }, behavior: 'defer' },
  ] } },
} as Partial<FrameworkConfig>;

const ELSEWHERE = { serverId: 'elsewhere', eventType: 'mcpl:channel-incoming', eventId: 'not-this-one', featureSet: 'other' };

test("a push whose origin names another server and event type is still gated as its own server's push", async (t) => {
  const f = await fixture({ framework: QUIET_EDITOR }); t.after(f.close);
  await f.send('push/event', {
    featureSet: 'doc', eventId: 'p1', timestamp: TS, origin: ELSEWHERE,
    payload: { content: [{ type: 'text', text: 'plain_push' }] },
  });
  await f.framework.runUntilIdle();
  assert.ok(f.context().includes('plain_push'), 'the push is stored');
  assert.equal(f.membrane.calls.length, 0, "the editor's policy deferred it: no turn");
});

test("a deferred coalesced push whose origin names another server and event type is still gated as its own server's push", async (t) => {
  const f = await fixture({ framework: QUIET_EDITOR }); t.after(f.close);
  const reply = await f.send('push/event', { ...f.params('1', 'deferred_push', { deferred: true, initial: true }), origin: ELSEWHERE });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, "the editor's policy deferred it: no turn");
});
