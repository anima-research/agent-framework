/** Real transport regression tests for bounded, ordered required backlog release. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { MAX_PENDING_ADMISSIONS } from '../src/mcpl/inbound-admission.js';

const allow = { store: true, mayWake: false } as const;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const params = (lane: string, id: number) => lane === 'push/event'
  ? { featureSet: 'doc', eventId: String(id), timestamp: TS, payload: { content: [{ type: 'text', text: `held_${id}` }] } }
  : { messages: [{ channelId: 'chat', messageId: String(id), timestamp: TS, content: [{ type: 'text', text: `held_${id}` }] }] };

for (const lane of ['push/event', 'channels/incoming'] as const) for (const notify of [false, true]) {
  for (const burst of [true, false]) test(`held ${lane} ${notify ? 'notifications' : 'requests'}: ${burst ? '>64 burst' : 'staggered hook'} preserves all items in order`, async t => {
    const count = burst ? MAX_PENDING_ADMISSIONS + 6 : 5;
    let hooks = 0; let active = 0; let peak = 0;
    const f = await fixture({ server: { inboundAdmission: {
      timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: async (input: any) => {
        hooks++; peak = Math.max(peak, ++active);
        const id = Number(input.item.eventId ?? input.item.messageId);
        await delay(burst ? 2 : (count - id) * 10);
        active--; return allow;
      } }), isReplyIntent: () => true,
    } } }); t.after(f.close); await f.register();
    const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
    const observed: number[] = []; const refused: any[] = [];
    f.framework.onTrace((e: any) => { if (e.reason?.startsWith('admission_')) refused.push(e); });
    const push = inner.queue.push.bind(inner.queue);
    inner.queue.push = (event: any) => {
      if (event.type === 'mcpl:push-event' || event.type === 'mcpl:channel-incoming') observed.push(Number(event.eventId ?? event.messageId));
      return push(event);
    };
    await f.framework.quiesce({ reason: 'test' });
    const replies: Promise<any>[] = [];
    for (let i = 0; i < count; i++) {
      if (notify) f.notify(lane, params(lane, i));
      else replies.push(f.send(lane, params(lane, i)));
    }
    await eventually(() => connection.bufferedEvents.length === count);
    assert.equal(hooks, 0);
    await f.framework.resume();
    const responses = await Promise.all(replies);
    await eventually(() => observed.length + refused.length === count);
    assert.equal(refused.length, 0, 'a host-generated flush must not overflow preflight slots');
    assert(responses.every(r => lane === 'push/event' ? r.result.accepted : r.result.results.every((item: any) => item.accepted)));
    assert.equal(hooks, count); assert.equal(peak, 1);
    assert.deepEqual(observed, Array.from({ length: count }, (_, i) => i));
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 0);
    for (let i = 0; i < count; i++) assert(f.context().includes(`held_${i}`));
  });
}

test('held channel batches finish in order before the next independently sent item', async t => {
  const calls: string[] = []; const queued: string[] = [];
  const f = await fixture({ server: { inboundAdmission: {
    timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: async (input: any) => {
      calls.push(input.item.messageId); await delay(input.item.messageId === '0' ? 20 : 1); return allow;
    } }), isReplyIntent: () => true,
  } } }); t.after(f.close); await f.register();
  const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
  const push = inner.queue.push.bind(inner.queue);
  inner.queue.push = (event: any) => { if (event.type === 'mcpl:channel-incoming') queued.push(event.messageId); return push(event); };
  const item = (id: number) => (params('channels/incoming', id) as { messages: unknown[] }).messages[0];
  await f.framework.quiesce({ reason: 'test' });
  const first = f.send('channels/incoming', { messages: [item(0), item(1)] });
  const second = f.send('channels/incoming', { messages: [item(2)] });
  await eventually(() => connection.bufferedEvents.length === 2);
  await f.framework.resume(); await Promise.all([first, second]);
  assert.deepEqual(calls, ['0', '1', '2']); assert.deepEqual(queued, calls);
});

test('held flush waits for live pre-pause slot owners instead of refusing backlog overflow', async t => {
  const releases: Array<() => void> = []; let calls = 0;
  const f = await fixture({ server: { inboundAdmission: {
    timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: async () => {
      if (++calls <= MAX_PENDING_ADMISSIONS) await new Promise<void>(resolve => releases.push(resolve));
      return allow;
    } }), isReplyIntent: () => true,
  } } }); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  const live = Array.from({ length: MAX_PENDING_ADMISSIONS }, (_, i) => f.send('push/event', params('push/event', i)));
  await eventually(() => releases.length === MAX_PENDING_ADMISSIONS);
  await f.framework.quiesce({ reason: 'test' });
  const held = [f.send('push/event', params('push/event', 64)), f.send('push/event', params('push/event', 65))];
  await eventually(() => connection.bufferedEvents.length === 2);
  await f.framework.resume();
  assert.equal(calls, MAX_PENDING_ADMISSIONS);
  for (const release of releases) release();
  assert((await Promise.all([...live, ...held])).every(r => r.result.accepted));
  assert.equal(calls, MAX_PENDING_ADMISSIONS + 2);
});

for (const boundary of ['pause', 'reconnect'] as const) test(`active held flush survives ${boundary} without overlapping drainers or rebinding queued work`, async t => {
  let release!: () => void; const calls: string[] = []; const refusals: string[] = [];
  const f = await fixture({ server: { reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20, inboundAdmission: {
    timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: async (input: any) => {
      calls.push(input.item.eventId);
      if (input.item.eventId === '0') await new Promise<void>(resolve => { release = resolve; });
      return allow;
    } }), isReplyIntent: () => true,
  } } }); t.after(f.close);
  f.framework.onTrace((e: any) => { if (e.type === 'mcpl:push-event-rejected') refusals.push(e.reason); });
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  await f.framework.quiesce({ reason: 'test' });
  f.notify('push/event', params('push/event', 0)); f.notify('push/event', params('push/event', 1));
  await eventually(() => connection.bufferedEvents.length === 2);
  await f.framework.resume(); await eventually(() => calls.length === 1);
  // Re-entrant ready calls must not launch another drainer. Nor may new data
  // jump ahead of the backlog. Control traffic and responses remain live.
  connection.ready(); connection.readyControlPlane();
  f.notify('push/event', params('push/event', 2));
  await f.register(); assert.deepEqual((await f.send('ping', {})).result, {});
  await eventually(() => connection.bufferedEvents.length === 2);
  assert.deepEqual(calls, ['0']);
  if (boundary === 'pause') {
    await f.framework.quiesce({ reason: 'test' }); release();
    await eventually(() => refusals.length === 1);
    assert.equal(refusals[0], 'admission_not_ready'); assert.deepEqual(calls, ['0']);
    await f.framework.resume();
    await eventually(() => calls.length === 3 && !connection.requiredFlushActive);
    assert.deepEqual(calls, ['0', '1', '2']);
  } else {
    const epoch = connection.transportEpoch; f.disconnect();
    await eventually(() => connection.transportEpoch > epoch && connection.isConnected && connection.dataPlaneReady);
    await eventually(() => refusals.length === 3);
    assert(refusals.every(reason => reason === 'admission_stale')); assert.deepEqual(calls, ['0']);
    release();
    assert.equal((await f.send('push/event', params('push/event', 3))).result.accepted, true);
  }
  await f.framework.runUntilIdle(); assert(!f.context().includes('held_0'));
});
