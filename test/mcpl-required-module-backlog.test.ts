/** Production-path coverage for the bounded, lifecycle-owned module backlog. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { MAX_PENDING_REQUIRED_MODULE_WORK } from '../src/index.js';

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
        ? f.channel(`overflow-${retract}`, retract ? '[message deleted]' : 'overwrite_forbidden', { key: 'key0', retract }, 'chat', 'm0')
        : f.params(`overflow-${retract}`, retract ? '[message deleted]' : 'overwrite_forbidden', { key: 'key0', retract, ...(lane === 'channel-push' ? { channelId: 'chat' } : {}) });
      const r = await f.send(lane === 'channels/incoming' || lane === 'mixed-channel' ? 'channels/incoming' : 'push/event', lane === 'channels/incoming' || lane === 'mixed-channel' ? { messages: [item] } : item);
      const result = r.result.results?.[0] ?? r.result;
      assert.equal(result.accepted, retract);
      if (!retract) assert.equal(result.reason, 'admission_denied');
      assert.equal(f.context().includes('body_0_end'), !retract, 'withdrawal removes the unread occupant even at capacity');
      assert(!f.context().includes('overwrite_forbidden'));
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(stats(inner), { queued: MAX_PENDING_REQUIRED_MODULE_WORK - 1, running: 1, scopes: 1 });
    assert.equal(inner.coalescingTicketCounts.size, 0, 'module limit is independent of retired admission tickets');
    t.diagnostic(JSON.stringify({ lane, creates: 150, acknowledgedCreates: 64, refusedCreates: 86, ...stats(inner), admissionTickets: inner.coalescingTicketCounts.size }));
    assert(traces.some(e => e.reason === 'admission_module_capacity'));
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

for (const boundary of ['stop', 'close', 'reconnect', 'disconnect', 'close-disconnect'] as const) {
  test(`required module backlog: ${boundary} preserves acknowledged work except on stop/disconnect; running work stays counted`, async t => {
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
    if (boundary === 'close' || boundary === 'reconnect' || boundary === 'close-disconnect') await eventually(() => c.transportEpoch > epoch);
    if (boundary === 'close-disconnect') await f.framework.disconnectMcplServer('editor');
    const drops = boundary === 'stop' || boundary === 'disconnect' || boundary === 'close-disconnect';
    assert.equal(stats(inner).queued, drops ? 0 : 9);
    assert.deepEqual(seen, ['e0']);
    assert(pending.every(slot => drops ? slot.dropped && slot.event === undefined : !slot.dropped && slot.event), 'only terminal lifecycle boundaries release payloads');
    assert.equal(traces.some(e => e.type === 'mcpl:module-work-dropped' && e.count === 9), drops);
    assert.equal(stats(inner).running, 1, 'running call is not cancelled and still counts against capacity');
    if (boundary === 'reconnect') {
      await eventually(() => c.transportEpoch > epoch && c.isConnected && c.dataPlaneReady);
      // New-epoch work cannot start a second hung call in the same scope.
      for (let i = 10; i < MAX_PENDING_REQUIRED_MODULE_WORK; i++) assert.equal((await send(i)).result.accepted, true);
      assert.equal((await send(100)).result.reason, 'admission_denied');
      assert.deepEqual(stats(inner), { queued: MAX_PENDING_REQUIRED_MODULE_WORK - 1, running: 1, scopes: 1 });
    }
    held.release();
    await eventually(() => inner.requiredModuleQueues.size === 0);
    assert.deepEqual(seen, drops ? ['e0'] : Array.from({ length: boundary === 'reconnect' ? MAX_PENDING_REQUIRED_MODULE_WORK : 10 }, (_, i) => `e${i}`));
  });
}

for (const lane of ['push/event', 'channels/incoming'] as const) {
  test(`R3-2 ${lane}: delete notice at module capacity removes unread occupant and drops only notice module work`, async t => {
    const held = deferred(); const seen: string[] = [];
    const spy = { name: 'spy', async start() {}, async stop() {}, async onProcess(e: any) {
      if (!['mcpl:push-event', 'mcpl:channel-incoming'].includes(e.type)) return {};
      seen.push(e.eventId); if (seen.length === 1) await held.promise; return {};
    } };
    const f = await fixture({ server: { inboundAdmission: admission }, framework: { modules: [spy] } as never });
    t.after(async () => { held.release(); await f.close(); }); await f.register();
    const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
    const send = (id: string, text: string, flags: any) => {
      const item = lane === 'push/event' ? f.params(id, text, flags) : f.channel(id, text, flags);
      return f.send(lane, lane === 'push/event' ? item : { messages: [item] }).then(r => r.result.results?.[0] ?? r.result);
    };
    assert.equal((await send('create', 'deleted_occupant', { key: 'target' })).accepted, true);
    // No initial birth: an edit first seen after reconnect has unknown history,
    // so its withdrawal removes the unread occupant AND delivers the notice.
    for (let i = 1; i < 64; i++) assert.equal((await send(`e${i}`, `body_${i}`, { initial: true, key: `k${i}` })).accepted, true);
    assert.equal((await send('delete', '[message deleted]', { key: 'target', retract: true })).accepted, true);
    assert(!f.context().includes('deleted_occupant'));
    assert(f.context().includes('[message deleted]'));
    assert.deepEqual(stats(f.framework as any), { queued: 63, running: 1, scopes: 1 });
    assert(traces.some(e => e.type === 'mcpl:module-work-dropped' && e.reason === 'admission_module_capacity' && e.count === 1));
    held.release(); await eventually(() => (f.framework as any).requiredModuleQueues.size === 0);
    assert.equal(seen.length, 64); assert(!seen.includes('delete'));
  });
}
