/**
 * RecordJournal — typed chronicle records that don't follow branch switches,
 * replayed from the latest checkpoint, with the two durability barriers named.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from '../src/record-journal.js';

const KILL_FIXTURE = join(import.meta.dirname, 'fixtures/record-journal-kill.mjs');

function withStore<T>(fn: (store: JsStore, path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'record-journal-'));
  const path = join(dir, 'store');
  const store = JsStore.openOrCreate({ path });
  try {
    return fn(store, path);
  } finally {
    if (!store.isClosed()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

type Entry = { n: string };
const entriesOf = (journal: RecordJournal<Entry, unknown>): string[] => journal.load().entries.map((e) => e.entry.n);

describe('RecordJournal', () => {
  it('an empty journal loads nothing', () => {
    withStore((store) => {
      const journal = new RecordJournal<Entry, unknown>(store, { type: 'journal-test/entry' });
      assert.deepStrictEqual(journal.load(), { snapshot: null, entries: [] });
      assert.strictEqual(journal.entriesSinceCheckpoint, 0);
    });
  });

  it('append returns where the record landed; a fresh load replays entries in append order', () => {
    withStore((store) => {
      const journal = new RecordJournal<Entry, unknown>(store, { type: 'journal-test/entry' });
      const a = journal.append({ n: 'a' });
      const b = journal.append({ n: 'b' });
      assert.match(a.id, /^\d+$/);
      assert.ok(BigInt(b.id) > BigInt(a.id), 'ids increase in append order');
      assert.strictEqual(typeof a.sequence, 'number');
      const loaded = new RecordJournal<Entry, unknown>(store, { type: 'journal-test/entry' }).load();
      assert.deepStrictEqual(loaded.entries, [
        { id: a.id, sequence: a.sequence, entry: { n: 'a' } },
        { id: b.id, sequence: b.sequence, entry: { n: 'b' } },
      ]);
    });
  });

  it('entries from every branch load from any branch, in global order, through deleteBranch and reopen', () => {
    withStore((store, path) => {
      const journal = new RecordJournal<Entry, unknown>(store, { type: 'journal-test/entry' });
      journal.append({ n: 'main-0' });
      const fork = store.currentSequence();
      journal.append({ n: 'main-1' });
      const main = store.currentBranch().name;
      store.createBranchAt('rollback', main, fork);
      store.switchBranch('rollback');
      journal.append({ n: 'rollback-2' });
      assert.deepStrictEqual(entriesOf(journal), ['main-0', 'main-1', 'rollback-2'],
        'the rolled-back branch still sees what main appended after the fork');
      store.switchBranch(main);
      journal.append({ n: 'main-3' });
      store.deleteBranch('rollback');
      assert.deepStrictEqual(entriesOf(journal), ['main-0', 'main-1', 'rollback-2', 'main-3']);
      store.close();
      const reopened = JsStore.openOrCreate({ path });
      try {
        assert.deepStrictEqual(entriesOf(new RecordJournal<Entry, unknown>(reopened, { type: 'journal-test/entry' })),
          ['main-0', 'main-1', 'rollback-2', 'main-3']);
      } finally {
        reopened.close();
      }
    });
  });

  it('load returns the latest checkpoint and only the entries after it; other records do not disturb it', () => {
    withStore((store) => {
      store.registerState({ id: 'journal-test/tree', strategy: 'tree' });
      const journal = new RecordJournal<Entry, { seen: string[] }>(store, { type: 'journal-test/entry' });
      const other = new RecordJournal<Entry, never>(store, { type: 'journal-test/other' });
      journal.append({ n: 'a' });
      other.append({ n: 'x' });
      journal.append({ n: 'b' });
      journal.checkpoint({ seen: ['a', 'b'] });
      assert.strictEqual(journal.entriesSinceCheckpoint, 0);
      store.treeSet('journal-test/tree', 'f.txt', { blobHash: 'f'.repeat(64), size: 1, mode: 0o644 });
      journal.append({ n: 'c' });
      other.append({ n: 'y' });
      assert.strictEqual(journal.entriesSinceCheckpoint, 1);

      const reader = new RecordJournal<Entry, { seen: string[] }>(store, { type: 'journal-test/entry' });
      const first = reader.load();
      assert.deepStrictEqual(first.snapshot, { seen: ['a', 'b'] });
      assert.deepStrictEqual(first.entries.map((e) => e.entry.n), ['c']);
      assert.strictEqual(reader.entriesSinceCheckpoint, 1);

      // A checkpoint after load covers what was loaded; the newest one wins.
      reader.checkpoint({ seen: ['a', 'b', 'c'] });
      const second = new RecordJournal<Entry, { seen: string[] }>(store, { type: 'journal-test/entry' }).load();
      assert.deepStrictEqual(second, { snapshot: { seen: ['a', 'b', 'c'] }, entries: [] });
      assert.deepStrictEqual(entriesOf(new RecordJournal<Entry, unknown>(store, { type: 'journal-test/other' })), ['x', 'y']);
    });
  });

  it('names its two barriers: afterCommittedState syncs before the append, durable after it, neither by default', () => {
    withStore((store) => {
      const calls: string[] = [];
      const recording = {
        getRecordIdsByType: (type: string) => store.getRecordIdsByType(type),
        getRecord: (id: string) => store.getRecord(id),
        appendJson: (type: string, data: unknown) => { calls.push('append'); return store.appendJson(type, data); },
        sync: () => { calls.push('sync'); store.sync(); },
      } as unknown as JsStore;
      const journal = new RecordJournal<Entry, { n: number }>(recording, { type: 'journal-test/entry' });
      journal.append({ n: 'plain' });
      assert.deepStrictEqual(calls.splice(0), ['append'], 'a plain append does not sync');
      journal.append({ n: 'asserting' }, { afterCommittedState: true });
      assert.deepStrictEqual(calls.splice(0), ['sync', 'append']);
      journal.append({ n: 'durable' }, { durable: true });
      assert.deepStrictEqual(calls.splice(0), ['append', 'sync']);
      journal.append({ n: 'both' }, { afterCommittedState: true, durable: true });
      assert.deepStrictEqual(calls.splice(0), ['sync', 'append', 'sync']);
      journal.checkpoint({ n: 1 }, { durable: true });
      assert.deepStrictEqual(calls.splice(0), ['append', 'sync']);
    });
  });

  it('after a hard kill, an afterCommittedState entry never survives without the state it asserts', () => {
    withStore((store, path) => {
      store.registerState({ id: 'journal-test/tree', strategy: 'tree' });
      store.sync();
      store.close();
      const child = spawnSync(process.execPath, [KILL_FIXTURE, path, 'asserting'], { encoding: 'utf-8' });
      assert.strictEqual(child.signal, 'SIGKILL', `the child died by SIGKILL (stderr: ${child.stderr})`);
      const reopened = JsStore.openOrCreate({ path });
      try {
        try { reopened.registerState({ id: 'journal-test/tree', strategy: 'tree' }); } catch { /* exists */ }
        const entries = new RecordJournal<{ asserts: string }, unknown>(reopened, { type: 'journal-test/entry' }).load().entries;
        assert.strictEqual(entries.length, 1, 'the appended entry survived the kill');
        assert.notStrictEqual(reopened.treeGet('journal-test/tree', 'committed.txt'), null,
          'the state it asserts survived with it');
      } finally {
        reopened.close();
      }
    });
  });

  it('a write that fails after reaching the store blocks further writes until load() replays it', () => {
    withStore((store) => {
      let failNextSync = false;
      const flaky = {
        getRecordIdsByType: (type: string) => store.getRecordIdsByType(type),
        getRecord: (id: string) => store.getRecord(id),
        appendJson: (type: string, data: unknown) => store.appendJson(type, data),
        sync: () => {
          if (failNextSync) { failNextSync = false; throw new Error('disk full'); }
          store.sync();
        },
      } as unknown as JsStore;
      const journal = new RecordJournal<Entry, { seen: string[] }>(flaky, { type: 'journal-test/entry' });

      // The durable barrier fails after A reached the store: the caller never reduces A.
      failNextSync = true;
      assert.throws(() => journal.append({ n: 'A' }, { durable: true }), /disk full/);
      assert.strictEqual(journal.needsReconcile, true);
      // Without reconciliation, a later write and checkpoint would cover A unreduced.
      assert.throws(() => journal.append({ n: 'B' }), /load\(\) and reduce its tail before writing again/);
      assert.throws(() => journal.checkpoint({ seen: ['B'] }), /load\(\) and reduce its tail/);

      const reconciled = journal.load();
      assert.deepStrictEqual(reconciled.entries.map((e) => e.entry.n), ['A'], 'load replays the ambiguous record');
      assert.strictEqual(journal.needsReconcile, false);
      journal.append({ n: 'B' });
      journal.checkpoint({ seen: ['A', 'B'] });
      assert.deepStrictEqual(new RecordJournal<Entry, { seen: string[] }>(store, { type: 'journal-test/entry' }).load(),
        { snapshot: { seen: ['A', 'B'] }, entries: [] });

      // A failure BEFORE the record reaches the store wrote nothing and leaves the journal usable.
      failNextSync = true;
      assert.throws(() => journal.append({ n: 'C' }, { afterCommittedState: true }), /disk full/);
      assert.strictEqual(journal.needsReconcile, false);
      journal.append({ n: 'D' });
      assert.deepStrictEqual(
        new RecordJournal<Entry, { seen: string[] }>(store, { type: 'journal-test/entry' }).load().entries.map((e) => e.entry.n),
        ['D'],
      );
    });
  });

  it('refuses a checkpoint type equal to the entry type', () => {
    withStore((store) => {
      assert.throws(() => new RecordJournal(store, { type: 't', checkpointType: 't' }), /distinct record types/);
    });
  });
});
