/** Production-path coverage for the bounded, lifecycle-owned module backlog. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { MAX_PENDING_REQUIRED_MODULE_WORK } from '../src/framework.js';

const allow = { store: true, mayWake: false } as const;
const admission = { timeoutMs: 5000, bind: (connection: any) => ({ connection, admit: () => allow }), isReplyIntent: () => true };
const stats = (inner: any) => {
  const queues = [...inner.requiredModuleQueues.values()] as any[];
  return { queued: queues.reduce((n, q) => n + q.pending.length, 0), running: queues.filter(q => q.running).length, scopes: queues.length };
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
};

for (const lane of ['push/event', 'channels/incoming', 'channel-push', 'mixed-channel'] as const) {
  test(`required ${lane}: sustained ingress behind a hung module stays bounded; refusal is before storage; FIFO recovers`, async t => {
    assert.equal(MAX_PENDING_REQUIRED_MODULE_WORK, 64);
    const held = deferred(); const seen: string[] = [];
    const spy = { name: 'spy', async start() {}, async stop() {}, async onProcess(event: any) {
      if (!['mcpl:push-event', 'mcpl:channel-incoming'].includes(event.type)) return {};
      seen.push(event.eventId);
      if (seen.length === 1) await held.promise;
      return {};
    } };
    const f = await fixture({ server: { inboundAdmission: admission }, framework: { modules: [spy] } as never });
    t.after(async () => { held.release(); await f.close(); }); await f.register();
    const inner = f.framework as any; const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
    const send = (i: number) => {
      const id = `e${i}`; const text = `body_${i}_end`;
      if (lane === 'channels/incoming' || (lane === 'mixed-channel' && i % 2)) return f.send('channels/incoming', { messages: [f.channel(id, text, { initial: true, key: `key${i}` }, 'chat', `m${i}`)] });
      return f.send('push/event', f.params(id, text, { initial: true, key: `key${i}`, ...(lane === 'channel-push' || lane === 'mixed-channel' ? { channelId: 'chat' } : {}) }));
    };
    for (let i = 0; i < MAX_PENDING_REQUIRED_MODULE_WORK + 86; i++) {
      const r = await send(i);
      const result = r.result.results?.[0] ?? r.result;
      assert.equal(result.accepted, i < MAX_PENDING_REQUIRED_MODULE_WORK);
      if (i >= MAX_PENDING_REQUIRED_MODULE_WORK) {
        assert.equal(result.reason, 'admission_denied');
        assert(!f.context().includes(`body_${i}_end`), 'refused work has no built-in content');
      }
    }
    for (const retract of [false, true]) {
      const item = lane === 'channels/incoming' || lane === 'mixed-channel'
        ? f.channel(`overflow-${retract}`, retract ? '' : 'overwrite_forbidden', { key: 'key0', retract }, 'chat', 'm0')
        : f.params(`overflow-${retract}`, retract ? '' : 'overwrite_forbidden', { key: 'key0', retract, ...(lane === 'channel-push' ? { channelId: 'chat' } : {}) });
      const r = await f.send(lane === 'channels/incoming' || lane === 'mixed-channel' ? 'channels/incoming' : 'push/event', lane === 'channels/incoming' || lane === 'mixed-channel' ? { messages: [item] } : item);
      assert.equal((r.result.results?.[0] ?? r.result).reason, 'admission_denied');
      assert(f.context().includes('body_0_end'), 'overflow cannot replace/remove an unread occupant');
      assert(!f.context().includes('overwrite_forbidden'));
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(stats(inner), { queued: MAX_PENDING_REQUIRED_MODULE_WORK - 1, running: 1, scopes: 1 });
    assert.equal(inner.coalescingTicketCounts.size, 0, 'module limit is independent of retired admission tickets');
    t.diagnostic(JSON.stringify({ lane, creates: 150, acknowledgedCreates: 64, refusedCreates: 86, ...stats(inner), admissionTickets: inner.coalescingTicketCounts.size }));
    assert(traces.some(e => e.reason === 'admission_denied'));
    // Retries of already accepted work remain receipts, even at capacity.
    const retry = await send(0);
    assert.equal((retry.result.results?.[0] ?? retry.result).accepted, true);
    assert.equal(stats(inner).queued, MAX_PENDING_REQUIRED_MODULE_WORK - 1);
    held.release();
    await eventually(() => inner.requiredModuleQueues.size === 0);
    assert.deepEqual(seen, Array.from({ length: MAX_PENDING_REQUIRED_MODULE_WORK }, (_, i) => `e${i}`));
    const retryRefused = await send(MAX_PENDING_REQUIRED_MODULE_WORK);
    assert.equal((retryRefused.result.results?.[0] ?? retryRefused.result).accepted, true, 'overflow did not burn a receipt');
    await eventually(() => seen.length === MAX_PENDING_REQUIRED_MODULE_WORK + 1);
  });
}

for (const boundary of ['stop', 'close', 'reconnect', 'disconnect'] as const) {
  test(`required module backlog: ${boundary} drops queued payloads without cancelling running work or resurrecting the queue`, async t => {
    const held = deferred(); const seen: string[] = [];
    const spy = { name: 'spy', async start() {}, async stop() {}, async onProcess(e: any) {
      if (e.type !== 'mcpl:push-event') return {};
      seen.push(e.eventId); if (e.eventId === 'e0') await held.promise;
      return {};
    } };
    const f = await fixture({ server: { inboundAdmission: admission, reconnect: boundary === 'reconnect', reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 }, framework: { modules: [spy] } as never });
    t.after(async () => { held.release(); await f.close(); });
    const inner = f.framework as any; const c = inner.mcplServerRegistry.getServer('editor');
    const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
    const send = (i: number) => f.send('push/event', f.params(`e${i}`, `body_${i}`, { initial: true, key: `k${i}` }));
    for (let i = 0; i < 10; i++) assert.equal((await send(i)).result.accepted, true);
    await eventually(() => seen.length === 1);
    const queue = [...inner.requiredModuleQueues.values()][0] as any;
    const pending = [...queue.pending];
    const epoch = c.transportEpoch;
    if (boundary === 'stop') await f.framework.stop();
    else if (boundary === 'disconnect') await f.framework.disconnectMcplServer('editor');
    else f.disconnect();
    if (boundary === 'close' || boundary === 'reconnect') await eventually(() => c.transportEpoch > epoch);
    assert.equal(stats(inner).queued, 0, 'lifecycle boundary synchronously releases the pending backlog');
    assert.deepEqual(seen, ['e0']);
    assert(pending.every(slot => slot.dropped && slot.event === undefined), 'queued payload references released, not hidden behind promises');
    assert(traces.some(e => e.type === 'mcpl:module-work-dropped' && e.count === 9));
    assert.equal(stats(inner).running, 1, 'running call is not cancelled and still counts against capacity');
    if (boundary === 'reconnect') {
      await eventually(() => c.transportEpoch > epoch && c.isConnected && c.dataPlaneReady);
      // New-epoch work cannot start a second hung call in the same scope.
      for (let i = 10; i < 10 + MAX_PENDING_REQUIRED_MODULE_WORK - 1; i++) assert.equal((await send(i)).result.accepted, true);
      assert.equal((await send(100)).result.reason, 'admission_denied');
      assert.deepEqual(stats(inner), { queued: MAX_PENDING_REQUIRED_MODULE_WORK - 1, running: 1, scopes: 1 });
    }
    held.release();
    await eventually(() => inner.requiredModuleQueues.size === 0);
    assert.deepEqual(seen, boundary === 'reconnect' ? ['e0', ...Array.from({ length: MAX_PENDING_REQUIRED_MODULE_WORK - 1 }, (_, i) => `e${i + 10}`)] : ['e0']);
  });
}

