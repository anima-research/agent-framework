import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { PushCoalescer, coalescingSubjectKey, type CoalescedOccurrence, type CoalescerHost, type CoalescingChange, type CoalescingSnapshot, type PushRenderResult } from '../src/mcpl/push-coalescer.js';
import {
  COALESCING_JOURNAL_ID, COALESCING_JOURNAL_REGISTRATION, COALESCING_RECENT_ID, COALESCING_TABLE_ID, CoalescingStore, journaledTable,
  type CoalescingJournalItem, type StoredCoalescing, type StoredCoalescingTable,
} from '../src/mcpl/coalescing-store.js';
import { JOURNALED, numbered } from './helpers/coalescing-journal.js';

const TS = '2026-09-30T00:00:00Z';
const EMPTY: CoalescingSnapshot = { version: 1, receipts: [], subjects: [] };
const NONE: StoredCoalescing = { table: null, journal: [], recent: [] };

function recorder(fail: (call: string) => boolean = () => false) {
  const calls: string[] = [];
  const tables: StoredCoalescingTable[] = [];
  const store = {
    setStateJson: (id: string, value: unknown) => {
      const call = `set ${id}${Array.isArray(value) && value.length === 0 ? ' []' : ''}`;
      if (fail(call)) throw new Error(`ENOSPC simulated: ${call}`);
      calls.push(call);
      if (id === COALESCING_TABLE_ID) tables.push(structuredClone(value as StoredCoalescingTable));
      return {} as ReturnType<JsStore['setStateJson']>;
    },
    appendToStateJson: (id: string) => {
      const call = `append ${id}`;
      if (fail(call)) throw new Error(`ENOSPC simulated: ${call}`);
      calls.push(call);
      return {} as ReturnType<JsStore['appendToStateJson']>;
    },
  };
  return { store, calls, tables };
}

const record = (subject: string, consumed = `${subject}-1`) => ({ subject, history: 'some' as const, consumedEventId: consumed });
const change = (subject: string, consumed?: string): CoalescingChange => ({ subject, record: record(subject, consumed) });
const TABLE: CoalescingSnapshot = { version: 1, receipts: [], subjects: Array.from({ length: 4 }, (_, i) => record(`s${i}`)) };

test('over a table without a number, a table write empties the journal first; over a numbered table, the table goes first', () => {
  const unmarked = recorder();
  new CoalescingStore(unmarked.store, { table: EMPTY, journal: [change('a')], recent: [] }, () => {}).writeTable(EMPTY);
  assert.deepEqual(unmarked.calls, [`set ${COALESCING_JOURNAL_ID} []`, `set ${COALESCING_TABLE_ID}`]);
  const marked = recorder();
  new CoalescingStore(marked.store, { table: { ...EMPTY, journal: 3 }, journal: [{ ...change('a'), seq: 3 }], recent: [] }, () => {}).writeTable(EMPTY);
  assert.deepEqual(marked.calls, [`set ${COALESCING_TABLE_ID}`, `set ${COALESCING_JOURNAL_ID} []`]);
});

test("a journal after a table without a number doesn't number the next table", () => {
  const r = recorder();
  new CoalescingStore(r.store, { table: EMPTY, journal: [{ ...change('a'), seq: 1_000_000 }], recent: [] }, () => {}).writeTable(EMPTY);
  assert.equal(r.tables[0].journal, 0);
});

test('a store that holds nothing is current, and its first change writes the table in place of an append', () => {
  const r = recorder();
  const durable = new CoalescingStore(r.store, NONE, () => {});
  assert.equal(durable.current, true);
  durable.write([change('a')], () => TABLE);
  assert.deepEqual(r.calls, [`set ${COALESCING_TABLE_ID}`]);
  assert.equal(new CoalescingStore(r.store, { table: TABLE, journal: [], recent: [] }, () => {}).current, false, 'a table without a number is not current');
});

test('a table write empties the list a release before the journal wrote, after the table', () => {
  const r = recorder();
  new CoalescingStore(r.store, { table: EMPTY, journal: [], recent: [{}] }, () => {}).writeTable(EMPTY);
  assert.deepEqual(r.calls, [`set ${COALESCING_TABLE_ID}`, `set ${COALESCING_RECENT_ID} []`]);
});

test('a change is appended to the journal over a numbered table, and the table is written in its place over one without a number', () => {
  const marked = recorder();
  new CoalescingStore(marked.store, { table: { ...TABLE, journal: 0 }, journal: [], recent: [] }, () => {}).write([change('a')], () => TABLE);
  assert.deepEqual(marked.calls, [`append ${COALESCING_JOURNAL_ID}`]);
  const unmarked = recorder();
  new CoalescingStore(unmarked.store, { table: TABLE, journal: [], recent: [] }, () => {}).write([change('a')], () => TABLE);
  assert.deepEqual(unmarked.calls, [`set ${COALESCING_TABLE_ID}`]);
});

test("the table is written once the journal's bytes since its last write reach the table's bytes at that write, and carries the number of the last change", () => {
  const r = recorder();
  const durable = new CoalescingStore(r.store, NONE, () => {});
  durable.writeTable(TABLE);
  const tableBytes = Buffer.byteLength(JSON.stringify(r.tables[0]));
  const itemBytes = Buffer.byteLength(JSON.stringify({ ...change('x0'), seq: 1 }));
  const before = Math.ceil(tableBytes / itemBytes) - 1;
  r.calls.length = 0;
  for (let i = 0; i < before; i++) durable.write([change(`x${i}`)], () => TABLE);
  assert.ok(!r.calls.includes(`set ${COALESCING_TABLE_ID}`), `no table write after ${before} changes`);
  durable.write([change('x9')], () => TABLE);
  assert.deepEqual(r.calls.slice(-3), [`append ${COALESCING_JOURNAL_ID}`, `set ${COALESCING_TABLE_ID}`, `set ${COALESCING_JOURNAL_ID} []`]);
  assert.equal(r.tables.at(-1)!.journal, before + 1);
});

test('after a failed append the next write is the whole table, and the failure is thrown to the writer', () => {
  let failing = true;
  const r = recorder((call) => failing && call.startsWith('append'));
  const durable = new CoalescingStore(r.store, { table: { ...EMPTY, journal: 0 }, journal: [], recent: [] }, () => {});
  assert.throws(() => durable.write([change('a')], () => EMPTY), /ENOSPC/);
  assert.equal(durable.current, false);
  failing = false;
  durable.write([change('b')], () => EMPTY);
  assert.equal(r.calls[0], `set ${COALESCING_TABLE_ID}`);
  assert.equal(r.tables[0].journal, 1, "the table covers the failed change's number");
});

test('an append that lands and then throws leaves the table owed, and the table write after it empties the journal', () => {
  let landedThenThrew = false;
  const r = recorder();
  const append = r.store.appendToStateJson;
  r.store.appendToStateJson = (id: string) => {
    const result = append(id);
    if (!landedThenThrew) { landedThenThrew = true; throw new Error('EIO after the write'); }
    return result;
  };
  const durable = new CoalescingStore(r.store, { table: { ...TABLE, journal: 0 }, journal: [], recent: [] }, () => {});
  assert.throws(() => durable.write([change('a')], () => TABLE), /EIO/);
  durable.write([change('b')], () => TABLE);
  assert.deepEqual(r.calls, [`append ${COALESCING_JOURNAL_ID}`, `set ${COALESCING_TABLE_ID}`, `set ${COALESCING_JOURNAL_ID} []`]);
  assert.equal(r.tables[0].journal, 1);
});

test("a failed table write at a journal's compaction is reported and leaves the change written, and the next write is the table", () => {
  const reported: unknown[] = [];
  let failTable = true;
  const r = recorder((call) => failTable && call === `set ${COALESCING_TABLE_ID}`);
  const durable = new CoalescingStore(r.store, { table: { ...EMPTY, journal: 0 }, journal: [], recent: [] }, (error) => reported.push(error));
  durable.write([change('a')], () => EMPTY);
  assert.equal(reported.length, 1, 'the compaction failed, and was reported');
  assert.deepEqual(r.calls, [`append ${COALESCING_JOURNAL_ID}`], 'the change itself was written');
  failTable = false;
  durable.write([change('b')], () => EMPTY);
  assert.deepEqual(r.calls.slice(1), [`set ${COALESCING_TABLE_ID}`, `set ${COALESCING_JOURNAL_ID} []`]);
});

test("after the store moves to a branch whose table has a number, the next write is the table, numbered past the branch's journal, and then the journal is emptied", () => {
  const r = recorder();
  const durable = new CoalescingStore(r.store, { table: { ...TABLE, journal: 2 }, journal: [], recent: [] }, () => {});
  durable.branchMoved({ table: { ...TABLE, journal: 5 }, journal: [{ ...change('a'), seq: 6 }, { ...change('b'), seq: 7 }], recent: [] });
  assert.equal(durable.current, false);
  durable.write([change('c')], () => TABLE);
  assert.deepEqual(r.calls, [`set ${COALESCING_TABLE_ID}`, `set ${COALESCING_JOURNAL_ID} []`]);
  assert.ok(r.tables[0].journal! >= 7, `the table's number ${r.tables[0].journal} covers the branch's journal`);
});

test("after the store moves to a branch whose table has no number, the next write empties the journal, writes the table and empties the old list", () => {
  const r = recorder();
  const durable = new CoalescingStore(r.store, { table: { ...TABLE, journal: 2 }, journal: [], recent: [] }, () => {});
  durable.branchMoved({ table: TABLE, journal: [change('a')], recent: [{}] });
  durable.write([change('c')], () => TABLE);
  assert.deepEqual(r.calls, [`set ${COALESCING_JOURNAL_ID} []`, `set ${COALESCING_TABLE_ID}`, `set ${COALESCING_RECENT_ID} []`]);
});

test('once the host stops, every write is the whole table', () => {
  const r = recorder();
  const durable = new CoalescingStore(r.store, { table: { ...TABLE, journal: 0 }, journal: [], recent: [] }, () => {});
  durable.stopping();
  durable.write([change('a')], () => TABLE);
  assert.deepEqual(r.calls, [`set ${COALESCING_TABLE_ID}`]);
});

test("no start applies a change at or below its table's number, and a journal after a table without a number is not applied", () => {
  const table: StoredCoalescingTable = { version: 1, receipts: [['r0', { result: { accepted: true }, at: 1 }]], subjects: [record('a'), record('b')], journal: 4 };
  const journal: CoalescingJournalItem[] = [
    { subject: 'b', record: record('b', 'b-0'), seq: 3 },
    { subject: 'a', record: null, seq: 4 },
    { subject: 'c', record: record('c'), receipt: ['r1', { result: { accepted: true }, at: 2 }], seq: 5 },
    { subject: 'b', record: record('b', 'b-2'), seq: 6 },
  ];
  assert.deepEqual(journaledTable(table, journal), {
    version: 1,
    receipts: [['r0', { result: { accepted: true }, at: 1 }], ['r1', { result: { accepted: true }, at: 2 }]],
    subjects: [record('a'), record('c'), record('b', 'b-2')],
  });
  const { journal: _number, ...unmarked } = table;
  assert.deepEqual(journaledTable(unmarked, journal), unmarked);
  assert.equal(journaledTable(null, journal), null);
});

test("a crash between a table's write and the journal's emptying, after a change that wasn't journaled, restores the table's newer state", () => {
  const dir = mkdtempSync(join(tmpdir(), 'coalescing-torn-'));
  try {
    const store = JsStore.openOrCreate({ path: dir });
    store.registerState({ id: COALESCING_TABLE_ID, strategy: 'snapshot' });
    store.registerState({ id: COALESCING_RECENT_ID, strategy: 'snapshot' });
    store.registerState(COALESCING_JOURNAL_REGISTRATION);
    let failAppend = false;
    let failEmpty = false;
    const durable = new CoalescingStore({
      setStateJson: (id, value) => {
        if (failEmpty && id === COALESCING_JOURNAL_ID) throw new Error('killed before the emptying');
        return store.setStateJson(id, value);
      },
      appendToStateJson: (id, item) => {
        if (failAppend) throw new Error('ENOSPC simulated');
        return store.appendToStateJson(id, item);
      },
    }, NONE, () => {});
    durable.writeTable(TABLE);
    durable.write([change('s0', 'first')], () => TABLE);
    failAppend = true;
    const newer = { ...TABLE, subjects: [record('s0', 'second'), ...TABLE.subjects.slice(1)] };
    assert.throws(() => durable.write([change('s0', 'second')], () => newer), /ENOSPC/);
    failAppend = false;
    failEmpty = true;
    assert.throws(() => durable.write([change('s1', 'third')], () => ({ ...newer, subjects: [newer.subjects[0], record('s1', 'third'), ...newer.subjects.slice(2)] })), /killed/);
    const restored = journaledTable(store.getStateJson(COALESCING_TABLE_ID) as StoredCoalescingTable, store.getStateJson(COALESCING_JOURNAL_ID) as CoalescingJournalItem[]);
    assert.ok((store.getStateJson(COALESCING_JOURNAL_ID) as unknown[]).length > 0, 'premise: the journal still holds the first change');
    assert.deepEqual(restored!.subjects.slice(0, 2).map((s) => s.consumedEventId), ['second', 'third']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writer(options: { render?: () => Promise<PushRenderResult>; authorized?: () => boolean; commit?: () => Promise<void> } = {}) {
  const written: CoalescingChange[] = [];
  const delivered: string[] = [];
  const host: CoalescerHost<null> = {
    isUnread: () => true, isUnshown: () => true, remove: () => true,
    deliver: async (occ) => { delivered.push(occ.eventId); return { agent: 'agent', messageId: `row-${occ.eventId}` }; },
    wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {},
    authorized: options.authorized ?? (() => true), audience: async () => ['agent'],
    render: options.render ?? (async () => ({ content: [{ type: 'text', text: 'rendered' }] })),
    audit: () => {}, write: (changes) => { written.push(...structuredClone(changes)); },
    ...(options.commit ? { commit: options.commit } : {}),
  };
  return { host, written, delivered };
}

const notice = (eventId: string): CoalescedOccurrence<null> => ({
  serverId: 'editor', binding: 'editor', scope: { kind: 'featureSet', id: 'doc' }, key: 'document', eventId, timestamp: TS,
  retract: false, deferred: true, initial: true, content: [{ type: 'text', text: `fallback ${eventId}` }], event: null,
});

test('a render that answers nothing is written as settled, so a coalescer restored from the journal delivers no fallback', async () => {
  const w = writer({ render: async () => ({ content: [] }) });
  const coalescer = new PushCoalescer<null>(w.host);
  await coalescer.accept(notice('n1'));
  await coalescer.assemble('agent');
  assert.deepEqual(w.delivered, [], 'premise: the render answered nothing');
  const restored = new PushCoalescer<null>(w.host);
  restored.restore(journaledTable(JOURNALED, numbered(w.written)));
  await restored.assemble('agent');
  assert.deepEqual(w.delivered, []);
});

test('a batch whose authority is revoked at its freeze is written as dropped, so a coalescer restored from the journal delivers nothing of it', async () => {
  let allowed = true;
  const w = writer({ authorized: () => allowed });
  const coalescer = new PushCoalescer<null>(w.host);
  await coalescer.accept(notice('n1'));
  allowed = false;
  await coalescer.assemble('agent');
  allowed = true;
  const restored = new PushCoalescer<null>(w.host);
  restored.restore(journaledTable(JOURNALED, numbered(w.written)));
  await restored.assemble('agent');
  assert.deepEqual(w.delivered, []);
});

test("a batch whose authority is revoked after its render's start is durable is written as dropped, so a coalescer restored from the journal delivers no fallback", async () => {
  let allowed = true;
  let revokeAtCommit = false;
  const w = writer({ authorized: () => allowed, commit: async () => { if (revokeAtCommit) allowed = false; } });
  const coalescer = new PushCoalescer<null>(w.host);
  await coalescer.accept(notice('n1'));
  revokeAtCommit = true;
  await coalescer.assemble('agent');
  assert.equal(allowed, false, "premise: the render-start's commit revoked it");
  allowed = true;
  revokeAtCommit = false;
  const restored = new PushCoalescer<null>(w.host);
  restored.restore(journaledTable(JOURNALED, numbered(w.written)));
  await restored.assemble('agent');
  assert.deepEqual(w.delivered, []);
});

test('an admission whose effects throw after they dropped a batch writes its subject, so a coalescer restored from the journal holds no batch', async () => {
  const w = writer();
  const deliver = w.host.deliver;
  let refuse = false;
  w.host.deliver = async (...args) => { if (refuse) throw new Error('the store refused it'); return deliver(...args); };
  const coalescer = new PushCoalescer<null>(w.host);
  await coalescer.accept(notice('n1'));
  refuse = true;
  await assert.rejects(coalescer.accept({ ...notice('p1'), deferred: false, initial: false }), /refused/);
  refuse = false;
  const restored = new PushCoalescer<null>(w.host);
  restored.restore(journaledTable(JOURNALED, numbered(w.written)));
  await restored.assemble('agent');
  assert.deepEqual(w.delivered, []);
});

test('a batch that a restore finds published is written as settled', () => {
  const w = writer();
  w.host.wasPublished = () => true;
  const coalescer = new PushCoalescer<null>(w.host);
  const subject = coalescingSubjectKey('editor', 'editor', { kind: 'featureSet', id: 'doc' }, 'document');
  coalescer.restore({ version: 1, receipts: [], subjects: [{ subject, history: 'none', batch: { latest: notice('n1'), notices: [], dropped: 0, rendering: true } }] });
  coalescer.writeSettledAtRestore();
  assert.deepEqual(w.written.map((c) => [c.subject, c.record?.batch, c.record?.consumedEventId]), [[subject, undefined, 'n1']]);
});

async function meanBytesPerAdmission(subjects: number): Promise<{ mean: number; admissions: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'coalescing-growth-'));
  try {
    const store = JsStore.openOrCreate({ path: dir });
    store.registerState({ id: COALESCING_TABLE_ID, strategy: 'snapshot' });
    store.registerState({ id: COALESCING_RECENT_ID, strategy: 'snapshot' });
    store.registerState(COALESCING_JOURNAL_REGISTRATION);
    let tableWrites = 0;
    const durable = new CoalescingStore({
      setStateJson: (id, value) => { if (id === COALESCING_TABLE_ID) tableWrites++; return store.setStateJson(id, value); },
      appendToStateJson: (id, item) => store.appendToStateJson(id, item),
    }, { table: null, journal: [], recent: [] }, (error) => { throw error; });
    let clock = 0;
    const host: CoalescerHost<null> = {
      isUnread: () => false, isUnshown: () => false, remove: () => true,
      deliver: async (occ) => ({ agent: 'agent', messageId: `row-${occ.eventId}` }),
      wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {},
      authorized: () => true, audience: async () => ['agent'],
      render: async () => ({ content: [] }), audit: () => {},
      write: (changes, table) => durable.write(changes, table),
      now: () => clock,
    };
    const coalescer = new PushCoalescer<null>(host, { maxSubjects: subjects });
    durable.writeTable(coalescer.snapshot());
    let n = 0;
    const admit = async () => {
      n++;
      clock += 10_000;
      await coalescer.accept({
        serverId: 'chat', binding: 'chat', scope: { kind: 'channel', id: 'chat:room' }, key: `message:${n}`, eventId: `ev-${n}`, timestamp: TS,
        retract: false, deferred: false, initial: true, content: [{ type: 'text', text: `message ${n}` }], event: null,
        identity: { messageId: `${n}`, author: { id: 'u1', name: 'someone' } },
      });
    };
    const size = () => { store.sync(); return statSync(join(dir, 'records.log')).size; };
    const until = async (done: () => boolean) => {
      while (!done()) {
        assert.ok(n < 20 * subjects, `the table was written ${tableWrites} times in ${n} admissions`);
        await admit();
      }
    };
    await until(() => n >= subjects);
    const filled = tableWrites;
    await until(() => tableWrites > filled);
    const from = size();
    const first = n;
    await until(() => tableWrites >= filled + 3);
    const grown = size() - from;
    store.close();
    return { mean: grown / (n - first), admissions: n - first };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the log's growth for one admission does not grow with the table: the same at 512 subjects and at 4,096", async (t) => {
  const small = await meanBytesPerAdmission(512);
  const large = await meanBytesPerAdmission(4_096);
  t.diagnostic(`mean bytes per admission: ${small.mean.toFixed(1)} at 512 subjects (${small.admissions} admissions), ${large.mean.toFixed(1)} at 4,096 (${large.admissions}); ratio ${(large.mean / small.mean).toFixed(4)}`);
  assert.ok(large.mean / small.mean < 1.02,
    `${large.mean} bytes for each admission at 4,096 subjects against ${small.mean} at 512: the bound, 1.02, is set from runs, which give one ratio each time `
    + '(1.0028 at this change) since the bytes follow the admissions and not the clock; a growth with the table would give near 8');
});
