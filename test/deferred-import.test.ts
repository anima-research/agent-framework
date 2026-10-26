/**
 * The reader of the deferred-write queue a release before #291 left
 * (src/deferred-import.ts, AF-6): what it refuses, what it drops, and the
 * order it gives the importer. The importer's boot behaviour is
 * deferred-import-boot.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deferredWritesRefusal, isToolBlockEntry, readPersistedDeferredWrites } from '../src/deferred-import.js';

const file = { file: '/store/recovery/deferred-writes.json', slotId: 'framework/deferred-writes' };
const slot = { slotId: 'framework/deferred-writes' };
const text = (t: string) => [{ type: 'text', text: t }];
const read = (raw: unknown, record: { file?: string; slotId: string } = file) => {
  const lines: string[] = [];
  const queue = readPersistedDeferredWrites(raw, record, (line) => lines.push(line));
  return { ...queue, lines };
};
const texts = (entries: Array<{ content: unknown[] }>) =>
  entries.map((e) => (e.content[0] as { text: string }).text);

describe('readPersistedDeferredWrites', () => {
  it('reads nothing stored as an empty queue: no file, and a slot with nothing in it', () => {
    for (const raw of [undefined, null]) {
      const queue = read(raw, slot);
      assert.deepEqual(queue.entries, []);
      assert.equal(queue.changed, false);
    }
  });

  it('reads a file holding no writes as an empty queue, and a file holding null as no queue', () => {
    assert.deepEqual(read({ version: 1, pending: [] }).entries, []);
    assert.throws(() => read(null), /\(\/store\/recovery\/deferred-writes\.json\) hold null, not a queue of writes\. The framework doesn't start without them/);
  });

  it('reads the forms releases wrote: a bare array in the slot, and version 1 and 2 files and slots', () => {
    const entry = (id: string, seq?: number) => ({ id, ...(seq !== undefined ? { seq } : {}), participant: 'user', content: text(id) });
    assert.deepEqual(texts(read([entry('a'), entry('b')], slot).entries), ['a', 'b']);
    assert.deepEqual(texts(read({ version: 1, pending: [entry('a', 1)] }).entries), ['a']);
    const v2 = read({ version: 2, pending: [entry('a', 1), entry('b', 2)], scanFrom: { agent: 4, other: -3, bad: 'x' } });
    assert.deepEqual(texts(v2.entries), ['a', 'b']);
    assert.deepEqual([...v2.scanFrom], [['agent', 4], ['other', 0]], 'scan positions kept, floored at 0, non-numbers left out');
    assert.deepEqual(texts(read({ version: 2, pending: [entry('a', 1)] }, slot).entries), ['a']);
  });

  it('refuses a record that is not a queue, naming what it holds and where, with nothing changed', () => {
    assert.throws(() => read('pending', slot), (error: Error) => {
      assert.match(error.message, /^the deferred context writes \(framework\/deferred-writes\) hold a string, not a queue of writes\. /);
      assert.match(error.message, /They're unchanged, and starting again won't help until they're repaired\.$/);
      return true;
    });
    assert.throws(() => read({ pending: 'x' }), /hold an object whose pending is a string, not a list of writes/);
    assert.throws(() => read({ version: 1 }), /hold an object whose pending is missing, not a list of writes/);
    assert.throws(() => read(7), /hold a number, not a queue of writes/);
  });

  it('drops each malformed entry with a line naming it, and says the record changed', () => {
    const queue = read({
      version: 2,
      pending: [
        { id: 'ok', seq: 1, participant: 'user', content: text('kept') },
        { id: 'p', seq: 2, participant: 7, content: text('x') },
        { id: 'c', seq: 3, participant: 'user', content: 'not blocks' },
        { id: 'b', seq: 4, participant: 'user', content: [null] },
        { id: 'f', seq: 5, participant: 'user', content: text('x'), forAgent: '' },
        null,
      ],
    });
    assert.deepEqual(texts(queue.entries), ['kept']);
    assert.equal(queue.changed, true);
    assert.equal(queue.lines.filter((l) => l.includes('is malformed and was dropped')).length, 5);
    assert.ok(queue.lines.some((l) => l.includes('dropped: p (participant of type number)')), queue.lines.join('\n'));
    assert.ok(queue.lines.some((l) => l.includes('dropped: no id (no participant)')), queue.lines.join('\n'));
  });

  it('keeps one entry per id, the first, and gives an entry with no id one of its own', () => {
    const queue = read({
      version: 2,
      pending: [
        { id: 'same', seq: 1, participant: 'user', content: text('first') },
        { id: 'same', seq: 2, participant: 'user', content: text('second') },
        { seq: 3, participant: 'user', content: text('no id') },
      ],
    });
    assert.deepEqual(texts(queue.entries), ['first', 'no id']);
    assert.equal(queue.entries[0]!.id, 'same');
    assert.match(queue.entries[1]!.id, /^[0-9a-f-]{36}$/);
    assert.equal(queue.changed, true);
    assert.ok(queue.lines.some((l) => l.includes('repeats id same')));
    assert.ok(queue.lines.some((l) => l.includes('has no id; it is given')));
  });

  it('orders by seq, then the entries without a valid one in record order, and numbers them 1..N', () => {
    const queue = read({
      version: 2,
      pending: [
        { id: 'c', seq: 30, participant: 'user', content: text('c') },
        { id: 'none', participant: 'user', content: text('none') },
        { id: 'a', seq: 10, participant: 'user', content: text('a') },
        { id: 'neg', seq: -1, participant: 'user', content: text('neg') },
        { id: 'big', seq: Number.MAX_SAFE_INTEGER, participant: 'user', content: text('big') },
        { id: 'frac', seq: 1.5, participant: 'user', content: text('frac') },
        { id: 'str', seq: '2', participant: 'user', content: text('str') },
      ],
    });
    assert.deepEqual(texts(queue.entries), ['a', 'c', 'big', 'none', 'neg', 'frac', 'str']);
    assert.deepEqual(queue.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(queue.changed, true);
    // The entry with no seq is named by nothing: a record from before seq is in write order already.
    assert.equal(queue.lines.filter((l) => l.includes('is queued after the others')).length, 3);
  });

  it('keeps what an entry carries for the importer: its agent, metadata, a time a Date holds, and an unknown landing', () => {
    const [entry] = read({
      version: 2,
      pending: [{
        id: 'w', seq: 1, participant: 'user', content: text('w'), forAgent: 'oren',
        metadata: { kind: 'tune-out-cancel' }, heldAt: 1_700_000_000_000, landing: 'unknown',
      }],
    }).entries;
    assert.deepEqual(entry, {
      id: 'w', seq: 1, participant: 'user', content: text('w'), forAgent: 'oren',
      metadata: { kind: 'tune-out-cancel' }, heldAt: 1_700_000_000_000, landing: 'unknown',
    });
    const [odd] = read({ version: 2, pending: [{ id: 'x', seq: 1, participant: 'user', content: text('x'), heldAt: 9e15, landing: 'maybe' }] }).entries;
    assert.equal(odd!.heldAt, undefined, 'a time past what a Date holds is left out');
    assert.equal(odd!.landing, undefined, 'only the unknown landing is kept');
  });
});

describe('deferredWritesRefusal', () => {
  it('says the file is unchanged and what lets the framework start, for a read that failed and for a form it refuses', () => {
    const cause = new Error('EIO');
    const failed = deferredWritesRefusal(file, 'could not be read: EIO', cause);
    assert.equal(failed.cause, cause);
    assert.match(failed.message, /The file is unchanged, and the framework starts once it can be read\.$/);
    const form = deferredWritesRefusal(file, 'hold a string, not a queue of writes');
    assert.match(form.message, /such as \{"version":1,"pending":\[\]\} for none\. Removing it reads the queue from framework\/deferred-writes instead/);
    assert.match(deferredWritesRefusal(slot, 'could not be read: EIO', cause).message, /They're unchanged, and the framework starts once they can be read\.$/);
  });
});

describe('isToolBlockEntry', () => {
  it('is true for an entry holding a tool_use or a tool_result, as the puppet queued its pair', () => {
    assert.equal(isToolBlockEntry({ content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] as never }), true);
    assert.equal(isToolBlockEntry({ content: [{ type: 'tool_result', toolUseId: 't', content: 'ok' }] as never }), true);
    assert.equal(isToolBlockEntry({ content: text('plain') as never }), false);
  });
});
