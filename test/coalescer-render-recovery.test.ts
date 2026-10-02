import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PushCoalescer, coalescingSubjectKey,
  type CoalescedOccurrence, type CoalescingSnapshot, type CoalescingReceiptRecord,
} from '../src/mcpl/push-coalescer.js';

type Event = { self: boolean; wake: boolean };
type Occurrence = CoalescedOccurrence<Event>;
const subject = coalescingSubjectKey('server', 'binding', { kind: 'channel', id: 'chat' }, 'topic');

function occurrence(id: string, self = false, wake = !self): Occurrence {
  return {
    serverId: 'server', binding: 'binding', scope: { kind: 'channel', id: 'chat' },
    key: 'topic', eventId: id, timestamp: new Date().toISOString(),
    deferred: true, retract: false, initial: true,
    content: [{ type: 'text', text: 'fallback:' + id }], event: { self, wake },
  };
}

function harness(published = new Set<string>()) {
  const delivered: Array<{ id: string; body: string; activation: string | null }> = [];
  const wakes = new Set<string>();
  let saved: CoalescingSnapshot | undefined;
  const receipts: CoalescingReceiptRecord[] = [];
  let release: ((value: { content: Array<{ type: 'text'; text: string }> }) => void) | undefined;
  let started!: () => void;
  const rendering = new Promise<void>(resolve => { started = resolve; });
  let hold = false;
  const coalescer = new PushCoalescer<Event>({
    isUnread: () => false,
    remove: () => false,
    isPassive: o => o.event.self,
    deliver: async (o, materialized, _forAgent, activation) => {
      published.add(o.eventId);
      delivered.push({
        id: o.eventId, body: JSON.stringify(materialized ?? o.content),
        activation: activation === null ? null : (activation ?? (o.event.self ? null : o))?.eventId ?? null,
      });
      return { agent: 'agent', messageId: o.eventId };
    },
    wakeForBatch: async (o, preserveExisting?: boolean) => {
      if (!preserveExisting) wakes.clear();
      if (o.event.wake && !o.event.self) wakes.add(o.eventId);
    },
    cancelWake: () => { wakes.clear(); },
    authorized: () => true,
    audience: async () => ['agent'],
    render: async (o) => {
      if (!hold) return { content: [{ type: 'text', text: 'render:' + o.eventId }] };
      started();
      return new Promise(resolve => { release = resolve; });
    },
    audit: () => {},
    save: () => {},
    saveNow: snapshot => { saved = structuredClone(snapshot); receipts.length = 0; },
    recordReceipt: receipt => { receipts.push(structuredClone(receipt)); },
    commit: async () => {},
    wasPublished: (_subject, id) => published.has(id),
  });
  return {
    coalescer, delivered, wakes, published, receipts, rendering,
    hold: () => { hold = true; },
    release: () => { hold = false; release!({ content: [{ type: 'text', text: 'completed active render' }] }); },
    saved: () => structuredClone(saved!),
  };
}

for (const durable of ['snapshot', 'receipt bridge'] as const) {
  for (const consumed of [false, true]) {
    test(durable + ' preserves a frozen counterpart before consumption and settles it after publication: ' + consumed, async () => {
      const live = harness();
      await live.coalescer.accept(occurrence('active'));
      live.hold();
      const run = live.coalescer.assemble('agent');
      await live.rendering;
      await live.coalescer.accept(occurrence('self-during-render', true));
      const snapshot = durable === 'snapshot' ? structuredClone(live.coalescer.snapshot()) : live.saved();
      const receipts = durable === 'receipt bridge' ? structuredClone(live.receipts) : [];

      if (!consumed) live.coalescer.suspend();
      live.release();
      await run;
      assert.equal(live.published.has('active'), consumed);
      const restored = harness(live.published);
      restored.coalescer.restore(snapshot);
      restored.coalescer.restoreReceipts(receipts);
      const causes = restored.coalescer.pendingBatchOccurrences().map(o => o.eventId);
      assert.equal(causes.includes('active'), !consumed, 'unconsumed work keeps its cause; published work clears it');
      assert(!causes.includes('self-during-render'));
      await restored.coalescer.assemble('agent');
      assert.deepEqual(restored.delivered.map(d => d.id), consumed ? ['self-during-render'] : ['active', 'self-during-render']);
      if (!consumed) {
        assert(restored.delivered[0]!.body.includes('fallback:active'), 'the interrupted content survives with its cause');
        assert.equal(restored.delivered[0]!.activation, 'active');
      }
      assert.equal(restored.delivered.at(-1)!.activation, null, 'the later self batch never borrows consumed activity');
      assert.deepEqual(restored.coalescer.pendingBatchOccurrences(), []);
      await restored.coalescer.assemble('agent');
      assert.equal(restored.delivered.length, consumed ? 1 : 2, 'each batch materializes once');
    });
  }
}

test('a newer no-wake counterpart batch cannot erase a separate interrupted batch cause', async () => {
  const live = harness();
  await live.coalescer.accept(occurrence('active'));
  live.hold();
  const run = live.coalescer.assemble('agent');
  await live.rendering;
  await live.coalescer.accept(occurrence('quiet-counterpart', false, false));
  const snapshot = structuredClone(live.coalescer.snapshot());
  live.coalescer.suspend(); live.release(); await run;

  const restored = harness();
  restored.coalescer.restore(snapshot);
  assert(restored.coalescer.pendingBatchOccurrences().some(o => o.eventId === 'active'));
  await restored.coalescer.assemble('agent');
  assert.deepEqual(restored.delivered.map(d => d.id), ['active', 'quiet-counterpart']);
  assert.deepEqual(restored.delivered.map(d => d.activation), ['active', 'quiet-counterpart']);
});

for (const operation of ['retract', 'plain'] as const) {
  test(operation + ' supersedes both interrupted frozen work and the later pending batch', async () => {
    const live = harness();
    await live.coalescer.accept(occurrence('active'));
    live.hold();
    const run = live.coalescer.assemble('agent');
    await live.rendering;
    await live.coalescer.accept(occurrence('self-during-render', true));
    const snapshot = structuredClone(live.coalescer.snapshot());
    live.coalescer.suspend(); live.release(); await run;

    const restored = harness();
    restored.coalescer.restore(snapshot);
    await restored.coalescer.accept({
      ...occurrence('replacement', true), deferred: false, initial: false,
      retract: operation === 'retract', content: operation === 'retract' ? [] : [{ type: 'text', text: 'replacement' }],
    });
    await restored.coalescer.assemble('agent');
    assert(!restored.delivered.some(d => d.id === 'active' || d.id === 'self-during-render'));
    assert.deepEqual(restored.coalescer.pendingBatchOccurrences(), []);
    assert.equal(restored.wakes.size, 0);
  });
}

test('a second interruption preserves frozen and pending batches with their separate causes', async () => {
  const live = harness();
  await live.coalescer.accept(occurrence('active'));
  live.hold();
  const run = live.coalescer.assemble('agent');
  await live.rendering;
  await live.coalescer.accept(occurrence('self', true));
  const first = structuredClone(live.coalescer.snapshot());
  live.coalescer.suspend(); live.release(); await run;

  const once = harness();
  once.coalescer.restore(first);
  await once.coalescer.accept(occurrence('new-quiet', false, false));
  const twice = harness();
  twice.coalescer.restore(structuredClone(once.coalescer.snapshot()));
  assert(twice.coalescer.pendingBatchOccurrences().some(o => o.eventId === 'active'));
  await twice.coalescer.assemble('agent');
  assert.deepEqual(twice.delivered.map(d => d.id), ['active', 'new-quiet']);
  assert.deepEqual(twice.delivered.map(d => d.activation), ['active', 'new-quiet']);
});
