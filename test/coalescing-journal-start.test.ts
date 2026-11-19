import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { fixture, crash } from './helpers/coalescing-fixture.js';
import { journaledTable, type CoalescingJournalItem, type StoredCoalescingTable } from '../src/mcpl/coalescing-store.js';
import type { CoalescingReceiptRecord, CoalescingSnapshot } from '../src/mcpl/push-coalescer.js';

const keyed = (subject: string, key: string) => JSON.parse(subject).at(-1) === key;

function durableOf(store: Pick<JsStore, 'getStateJson'>): CoalescingSnapshot {
  return journaledTable(
    store.getStateJson('mcpl/coalescing') as StoredCoalescingTable,
    (store.getStateJson('mcpl/coalescing-journal') ?? []) as CoalescingJournalItem[],
  )!;
}

function rewrite(dir: string, edit: (store: JsStore, durable: CoalescingSnapshot) => void): void {
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try { edit(store, durableOf(store)); } finally { store.close(); }
}

test('a store that a release before the journal wrote starts with its table and its list of receipts, and then holds a numbered table and an empty list', async (t) => {
  const f = await fixture(); t.after(f.close);
  const a = await f.send('push/event', f.params('a', 'a_fallback', { deferred: true, key: 'A' }));
  const b = await f.send('push/event', f.params('b', 'b_fallback', { deferred: true, key: 'B' }));
  await crash(f);
  rewrite(f.dir, (store, durable) => {
    const [key, receipt] = durable.receipts.find(([k]) => keyed(k, 'b'))!;
    const subject = durable.subjects.find((s) => keyed(s.subject, 'B'))!;
    const record: CoalescingReceiptRecord = {
      key, result: b.result, at: receipt.at, subject: subject.subject, born: 'unknown',
      batch: { latest: subject.batch!.latest, notices: subject.batch!.notices, dropped: subject.batch!.dropped },
    };
    store.setStateJson('mcpl/coalescing-journal', []);
    store.setStateJson('mcpl/coalescing', {
      version: 1, receipts: durable.receipts.filter(([k]) => k !== key), subjects: durable.subjects.filter((s) => s !== subject),
    });
    store.setStateJson('mcpl/coalescing-recent', [record]);
  });
  await f.create();
  const store = f.framework.getStore() as unknown as JsStore;
  assert.equal(typeof (store.getStateJson('mcpl/coalescing') as StoredCoalescingTable).journal, 'number', 'the start wrote the table with its number');
  assert.deepEqual(store.getStateJson('mcpl/coalescing-recent'), [], 'and emptied the list');
  assert.deepEqual((await f.send('push/event', f.params('a', 'a_fallback', { deferred: true, key: 'A' }))).result, a.result, "the table's receipt answers its retry");
  assert.deepEqual((await f.send('push/event', f.params('b', 'b_fallback', { deferred: true, key: 'B' }))).result, b.result, "the list's receipt answers its retry");
  await f.framework.runUntilIdle();
  assert.deepEqual(f.renders.map((r) => r.eventId), ['a'], "the table's batch renders");
  assert.ok(f.context().includes('b_fallback'), "the list's batch is delivered as its fallback, by that release's rule");
});

test("a journal after a table without a number is what was left before a downgrade: a start ignores it and empties it, so a batch the older release consumed isn't delivered again", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await f.send('push/event', f.params('x', 'x_fallback', { deferred: true, key: 'X' }));
  const pending = durableOf(f.framework.getStore() as unknown as JsStore).subjects.find((s) => keyed(s.subject, 'X'))!;
  assert.ok(pending.batch, 'premise: the batch is pending');
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'premise: the batch rendered');
  await crash(f);
  rewrite(f.dir, (store, durable) => {
    store.appendToStateJson('mcpl/coalescing-journal', { subject: pending.subject, record: pending, seq: 1_000_000 });
    store.setStateJson('mcpl/coalescing', { version: 1, receipts: durable.receipts, subjects: durable.subjects });
  });
  await f.create();
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'the consumed batch is not rendered again');
  const store = f.framework.getStore() as unknown as JsStore;
  assert.deepEqual(store.getStateJson('mcpl/coalescing-journal'), [], 'the start emptied the journal');
  assert.equal(typeof (store.getStateJson('mcpl/coalescing') as StoredCoalescingTable).journal, 'number', 'and wrote the table with its number');
});

test('after a branch move, the next change writes the whole table to the branch the store is on, as the coalescer holds it', async (t) => {
  const f = await fixture(); t.after(f.close);
  const store = f.framework.getStore() as unknown as JsStore;
  await tableOfEight(f);
  store.createBranch('elsewhere', store.currentBranch().name);
  await f.send('push/event', f.params('x', 'x_fallback', { deferred: true, key: 'X' }));
  assert.ok((store.getStateJson('mcpl/coalescing-journal') as unknown[]).length > 0, 'premise: the change was appended');
  await f.framework.switchBranch('elsewhere');
  await f.send('push/event', f.params('y', 'y_fallback', { deferred: true, key: 'Y' }));
  assert.deepEqual(durableOf(store).subjects.filter((s) => s.batch).map((s) => JSON.parse(s.subject).at(-1)).sort(), ['X', 'Y']);
});

async function tableOfEight(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  for (let i = 0; i < 8; i++) await f.send('push/event', f.params(`p${i}`, `plain ${i}`, { key: `P${i}` }));
  (f.framework as unknown as { writeCoalescingTable(at: 'start'): void }).writeCoalescingTable('start');
}

test('a deferred acceptance that the journal holds survives a crash, with its receipt, and renders', async (t) => {
  const f = await fixture(); t.after(f.close);
  await tableOfEight(f);
  const params = f.params('d1', 'journal_fallback', { deferred: true, key: 'D' });
  const original = await f.send('push/event', params);
  const store = f.framework.getStore() as unknown as JsStore;
  assert.ok((store.getStateJson('mcpl/coalescing-journal') as unknown[]).length > 0, 'premise: the acceptance is in the journal');
  await crash(f); await f.create();
  assert.deepEqual((await f.send('push/event', params)).result, original.result, 'the receipt survived');
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert.deepEqual(f.renders.map((r) => r.eventId), ['d1']);
  assert.ok(f.context().includes('document_diff'), 'its render reached the agent');
});

test('a start writes a batch that it finds published, though the store holds nothing else to write', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.alwaysRespond();
  await f.send('push/event', f.params('x', 'x_fallback', { deferred: true, key: 'X' }));
  const pending = durableOf(f.framework.getStore() as unknown as JsStore).subjects.find((s) => keyed(s.subject, 'X'))!;
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'premise: the batch rendered, and its render is in the context');
  (f.framework as unknown as { writeCoalescingTable(at: 'start'): void }).writeCoalescingTable('start');
  await crash(f);
  rewrite(f.dir, (store) => {
    const table = store.getStateJson('mcpl/coalescing') as StoredCoalescingTable;
    const subjects = table.subjects.map((s) => (s.subject === pending.subject ? { ...pending, batch: { ...pending.batch!, rendering: true } } : s));
    store.setStateJson('mcpl/coalescing', { ...table, subjects });
  });
  await f.create();
  const settled = durableOf(f.framework.getStore() as unknown as JsStore).subjects.find((s) => keyed(s.subject, 'X'))!;
  assert.equal(settled.batch, undefined, 'the settlement is written');
  assert.equal(f.renders.length, 1, 'and nothing rendered again');
});

test("a change that lands after the stop's table write goes into the table, so an earlier release started next reads it", async (t) => {
  const f = await fixture(); t.after(f.close);
  await tableOfEight(f);
  const internals = f.framework as unknown as {
    deliverCoalesced: (...args: unknown[]) => Promise<unknown>;
    writeCoalescingTable: (at: 'start' | 'stop') => void;
  };
  const deliver = internals.deliverCoalesced.bind(internals);
  let held!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { held = resolve; });
  internals.deliverCoalesced = (...args) => {
    internals.deliverCoalesced = deliver;
    held();
    return new Promise((resolve) => { release = () => resolve(deliver(...args)); });
  };
  const write = internals.writeCoalescingTable.bind(internals);
  let stopWritten!: () => void;
  const atStop = new Promise<void>((resolve) => { stopWritten = resolve; });
  internals.writeCoalescingTable = (at) => { write(at); if (at === 'stop') stopWritten(); };
  const answer = f.send('push/event', f.params('late', 'late_plain', { key: 'LATE' })).catch(() => undefined);
  await reached;
  const stopping = f.framework.stop();
  await atStop;
  release();
  await answer;
  await stopping;
  rewrite(f.dir, (store) => {
    const table = store.getStateJson('mcpl/coalescing') as StoredCoalescingTable;
    assert.ok(table.subjects.some((s) => keyed(s.subject, 'LATE')), "the late admission's subject is in the table");
  });
  await f.create();
});

test("a damaged journal after a table without a number doesn't stop a start, which empties it", async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('x', 'x_plain', { key: 'X' }));
  await crash(f);
  rewrite(f.dir, (store, durable) => {
    store.setStateJson('mcpl/coalescing', { version: 1, receipts: durable.receipts, subjects: durable.subjects });
    store.appendToStateJson('mcpl/coalescing-journal', null);
  });
  await f.create();
  assert.deepEqual((f.framework.getStore() as unknown as JsStore).getStateJson('mcpl/coalescing-journal'), []);
});

test('a start on a store that holds nothing writes nothing', async (t) => {
  const f = await fixture(); t.after(f.close);
  const store = f.framework.getStore() as unknown as JsStore;
  assert.equal(store.getStateJson('mcpl/coalescing'), null);
  assert.deepEqual(store.getStateJson('mcpl/coalescing-journal') ?? [], []);
});
