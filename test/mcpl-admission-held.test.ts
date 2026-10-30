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

test('held inference releases the drain after dispatch, not after the slow provider answers', async t => {
  const dispatched: string[] = [];
  const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['pushEvents', 'inferenceRequest'] } }, server: { inboundAdmission: {
    timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: async (input: any) => {
      await delay(5);
      return { store: true, mayWake: input.lane === 'inference/request' };
    } }), isReplyIntent: () => true,
  } } });
  const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
  let release!: () => void;
  const provider = new Promise<void>(resolve => { release = resolve; });
  const replies: Promise<any>[] = [];
  t.after(async () => { release(); await Promise.allSettled(replies); await f.close(); });
  await f.register();
  inner.inferenceRouter.resolveModel = () => 'test';
  const complete = f.membrane.complete.bind(f.membrane);
  inner.inferenceRouter.membrane = { complete: async (request: any) => {
    dispatched.push('inference'); await provider; return complete(request);
  } };
  const push = inner.queue.push.bind(inner.queue);
  inner.queue.push = (event: any) => {
    if (event.type === 'mcpl:push-event' || event.type === 'mcpl:channel-incoming') dispatched.push(String(event.eventId ?? event.messageId));
    return push(event);
  };
  await f.framework.quiesce({ reason: 'test' });
  const first = f.send('push/event', params('push/event', 0));
  let answered = false;
  const inference = f.send('inference/request', { featureSet: 'doc', messages: [{ role: 'user', content: 'slow' }] })
    .then(reply => { answered = true; return reply; });
  const channel = f.send('channels/incoming', params('channels/incoming', 1));
  const last = f.send('push/event', params('push/event', 2));
  replies.push(first, inference, channel, last);
  await eventually(() => connection.bufferedEvents.length === 4);
  await f.framework.resume();
  const deadline = performance.now() + 5000;
  while (dispatched.length < 4) {
    assert(performance.now() < deadline, 'all held data must dispatch while inference is still pending');
    await delay(10);
  }
  assert.deepEqual(dispatched, ['0', 'inference', '1', '2']);
  assert.equal(answered, false); assert.equal(inner.inferenceRouter.running.size, 1);
  assert.equal((await first).result.accepted, true);
  assert.equal((await channel).result.results[0].accepted, true);
  assert.equal((await last).result.accepted, true);
  await f.framework.runUntilIdle();
  const stored = f.context();
  assert(stored.indexOf('held_0') >= 0);
  assert(stored.indexOf('held_0') < stored.indexOf('held_1'));
  assert(stored.indexOf('held_1') < stored.indexOf('held_2'));
  release(); assert((await inference).result);
});

test('live data arriving during a drain is captured behind held data in the same serial backlog', async t => {
  const releases: Array<() => void> = []; const calls: number[] = []; const queued: number[] = [];
  let active = 0; let peak = 0;
  const f = await fixture({ server: { inboundAdmission: {
    timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: async (input: any) => {
      peak = Math.max(peak, ++active); calls.push(Number(input.item.eventId ?? input.item.messageId));
      await new Promise<void>(resolve => releases.push(resolve)); active--; return allow;
    } }), isReplyIntent: () => true,
  } } }); t.after(f.close); await f.register();
  const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
  const push = inner.queue.push.bind(inner.queue);
  inner.queue.push = (event: any) => {
    if (event.type === 'mcpl:push-event' || event.type === 'mcpl:channel-incoming') queued.push(Number(event.eventId ?? event.messageId));
    return push(event);
  };
  await f.framework.quiesce({ reason: 'test' });
  f.notify('push/event', params('push/event', 0)); f.notify('channels/incoming', params('channels/incoming', 1));
  await eventually(() => connection.bufferedEvents.length === 2);
  await f.framework.resume(); await eventually(() => calls.length === 1);
  const replies: Promise<any>[] = [];
  for (let i = 2; i < 22; i++) {
    const lane = i % 2 ? 'channels/incoming' : 'push/event';
    if (i % 4 < 2) f.notify(lane, params(lane, i));
    else replies.push(f.send(lane, params(lane, i)));
  }
  await eventually(() => connection.bufferedEvents.length === 21);
  assert.deepEqual(calls, [0]); assert.equal(connection.requiredAdmission.pending.size, 1);
  for (let i = 0; i < 22; i++) {
    await eventually(() => releases.length === i + 1);
    assert.deepEqual(calls, Array.from({ length: i + 1 }, (_, n) => n));
    releases[i]!();
  }
  await Promise.all(replies); await eventually(() => !connection.requiredFlushActive);
  assert.equal(peak, 1); assert.deepEqual(queued, Array.from({ length: 22 }, (_, i) => i));
});
