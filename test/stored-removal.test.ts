/**
 * The tail scan the stored-row lookups share: newest first, in blob-free
 * windows, across window boundaries, stopping where its caller is done.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { locateMessageIndices, scanFromTail } from '../src/stored-removal.js';

/** A stand-in store of `count` rows, `r0` to `r<count - 1>`, that records each window read. */
function rows(count: number) {
  const reads: Array<{ offset: number; limit: number; resolveBlobs?: boolean }> = [];
  const cm = {
    getMessageCount: () => count,
    getMessageWindow: (offset: number, limit: number, opts?: { resolveBlobs?: boolean }) => {
      reads.push({ offset, limit, ...(opts && 'resolveBlobs' in opts ? { resolveBlobs: opts.resolveBlobs } : {}) });
      const messages = Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => ({ id: `r${offset + i}` }));
      return { messages, startIndex: offset };
    },
  };
  return { cm, reads };
}

describe('scanFromTail', () => {
  it('visits every row newest first, with its index, across windows, reading no blobs', () => {
    const { cm, reads } = rows(1201);
    const seen: Array<[string, number]> = [];
    scanFromTail(cm, (row, index) => { seen.push([row.id, index]); return false; });
    assert.equal(seen.length, 1201);
    assert.deepEqual(seen.slice(0, 2), [['r1200', 1200], ['r1199', 1199]]);
    assert.deepEqual(seen.slice(499, 502), [['r701', 701], ['r700', 700], ['r699', 699]], 'on across a window boundary');
    assert.deepEqual(seen.at(-1), ['r0', 0]);
    assert.ok(seen.every(([id, index]) => id === `r${index}`));
    assert.deepEqual(reads, [
      { offset: 701, limit: 500, resolveBlobs: false },
      { offset: 201, limit: 500, resolveBlobs: false },
      { offset: 0, limit: 201, resolveBlobs: false },
    ]);
  });

  it('stops at the row its visit says it is done with, reading no window past it', () => {
    const { cm, reads } = rows(1201);
    let visited = 0;
    scanFromTail(cm, (row) => { visited++; return row.id === 'r650'; });
    assert.equal(visited, 551);
    assert.equal(reads.length, 2);
  });

  it('visits nothing in an empty store', () => {
    const { cm, reads } = rows(0);
    scanFromTail(cm, () => { throw new Error('visited'); });
    assert.deepEqual(reads, []);
  });
});

describe('locateMessageIndices', () => {
  it('finds each id by its index across windows, and reads no further once all are found', () => {
    const { cm, reads } = rows(1201);
    const found = locateMessageIndices(cm, new Set(['r1100', 'r600', 'nowhere']));
    assert.deepEqual([...found], [['r1100', { index: 1100 }], ['r600', { index: 600 }]]);
    assert.equal(reads.length, 3, 'an id not stored reads every window');
    const { cm: again, reads: againReads } = rows(1201);
    assert.deepEqual([...locateMessageIndices(again, new Set(['r1100', 'r600']))], [['r1100', { index: 1100 }], ['r600', { index: 600 }]]);
    assert.equal(againReads.length, 2);
    const { cm: none, reads: noneReads } = rows(1201);
    assert.equal(locateMessageIndices(none, new Set()).size, 0);
    assert.deepEqual(noneReads, []);
  });
});
