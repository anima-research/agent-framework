/**
 * Read marks (src/read-marks.ts, #291): a mark taken in legacy mode covers
 * a row by its own sequence, as the `{ branch, sequence }` watermarks did;
 * one taken in presented mode covers a row by its index ordinal, strictly
 * below the index length taken with it. Run over a real ContextManager on a
 * temp chronicle store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, type StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import {
  coverTest, covers, describeReadMark, markAtOrAfter, readMarkForTest, readMarkOf, type ReadMark,
} from '../src/read-marks.js';
import { positionIn, windowEnd, windowMarkOf, type Position } from '../src/presentation.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'af-read-marks-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
  const cm = await ContextManager.open({ store, namespace: 'agents/mira', strategy: new PassthroughStrategy() });
  const row = (id: string): StoredMessage => cm.getMessage(id)!;
  return {
    store, cm, row,
    cleanup: () => { cm.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('read marks', () => {
  it('a mark taken in legacy mode covers a row by its own sequence, as `<=` did', async () => {
    const r = await rig();
    try {
      const a = r.cm.addMessage('user', text('a'));
      const mark = readMarkOf(r.cm)!;
      const b = r.cm.addMessage('user', text('b'));
      assert.equal(covers(mark, r.cm, r.row(a)), 'covered');
      assert.equal(covers(mark, r.cm, r.row(b)), 'not-covered', 'a row stored after the mark');
      assert.match(describeReadMark(mark), /^main@\d+$/, 'no index length in legacy mode');
    } finally { r.cleanup(); }
  });

  it('a mark taken in presented mode covers a row strictly below its index length', async () => {
    const r = await rig();
    try {
      r.cm.addMessage('user', text('a'));
      r.cm.presentRows([]);
      const b = r.cm.addMessage('user', text('b'));
      r.cm.presentRows([b]);
      const mark = readMarkOf(r.cm)!;
      const head = r.store.currentSequence();
      const length = r.cm.indexLength();
      assert.equal(r.cm.ordinalOf(b), length - 1, 'the last row presented sits at length - 1');
      assert.equal(covers(mark, r.cm, r.row(b)), 'covered');
      const c = r.cm.addMessage('user', text('c'));
      assert.equal(covers(mark, r.cm, r.row(c)), 'not-covered', 'stored, not presented');
      r.cm.presentRows([c]);
      assert.equal(r.cm.ordinalOf(c), length, 'the next row takes the length the mark holds');
      assert.equal(covers(mark, r.cm, r.row(c)), 'not-covered', 'strictly below: the off-by-one pin');
      assert.equal(describeReadMark(mark), `main@${head}#${length}`);
    } finally { r.cleanup(); }
  });

  it("a row stored before the mark and not presented by then isn't covered: the head says nothing of the window", async () => {
    const r = await rig();
    try {
      r.cm.presentRows([]);
      const early = r.cm.addMessage('user', text('stored, not presented'));
      const mark = readMarkOf(r.cm)!;
      assert.ok(r.row(early).sequence <= r.store.currentSequence(), 'below the head');
      assert.equal(covers(mark, r.cm, r.row(early)), 'not-covered');
    } finally { r.cleanup(); }
  });

  it('a row taken out of the window is not covered', async () => {
    const r = await rig();
    try {
      r.cm.presentRows([]);
      const a = r.cm.addMessage('user', text('a'));
      r.cm.presentRows([a]);
      r.cm.retractRows([a], { undone: true });
      const mark = readMarkOf(r.cm)!;
      assert.equal(covers(mark, r.cm, r.row(a)), 'not-covered');
    } finally { r.cleanup(); }
  });

  it("a row of an auxiliary slot that isn't in the window is not covered", async () => {
    const r = await rig();
    const sub = await ContextManager.open({
      store: r.store, namespace: 'subconscious/mira', isolate: true, auxiliaryMessageViews: [{}], strategy: new PassthroughStrategy(),
    });
    try {
      sub.presentRows([]);
      const shared = r.cm.addMessage('user', text('in the residents\' slot'));
      const row = sub.getUnpresentedMessages().find((m) => m.id === shared)!;
      assert.ok(row, "the subconscious's record holds it");
      assert.equal(covers(readMarkOf(sub), sub, row), 'not-covered');
      sub.presentRows([shared]);
      assert.equal(covers(readMarkOf(sub), sub, row), 'covered');
    } finally { sub.close(); r.cleanup(); }
  });

  it('a legacy mark taken before the write-down still covers by sequence after it', async () => {
    const r = await rig();
    try {
      const a = r.cm.addMessage('user', text('a'));
      const mark = readMarkOf(r.cm)!;
      const b = r.cm.addMessage('user', text('b'));
      r.cm.presentRows([]);
      assert.equal(r.cm.windowMode(), 'presented');
      assert.equal(covers(mark, r.cm, r.row(a)), 'covered');
      assert.equal(covers(mark, r.cm, r.row(b)), 'not-covered');
    } finally { r.cleanup(); }
  });

  it('a mark on another branch is doubt, but for a legacy mark read across its branch point', async () => {
    const r = await rig();
    try {
      const a = r.cm.addMessage('user', text('a'));
      const mark = readMarkForTest('elsewhere', r.row(a).sequence + 10, null);
      assert.equal(covers(mark, r.cm, r.row(a)), 'doubt');
      assert.equal(covers(mark, r.cm, r.row(a), { partAt: r.row(a).sequence }), 'covered', 'at the branch point');
      assert.equal(covers(mark, r.cm, r.row(a), { partAt: r.row(a).sequence - 1 }), 'not-covered', 'past the branch point');
      const presented = readMarkForTest('elsewhere', 100, 3);
      assert.equal(covers(presented, r.cm, r.row(a), { partAt: 100 }), 'doubt', 'a presented mark across a branch point');
      assert.equal(covers(null, r.cm, r.row(a)), 'doubt', 'no mark');
    } finally { r.cleanup(); }
  });

  it('a presented mark read against a manager in legacy mode is doubt', async () => {
    const r = await rig();
    try {
      const a = r.cm.addMessage('user', text('a'));
      const test = coverTest(readMarkForTest('main', 100, 5), r.cm);
      assert.equal(test(r.row(a)), 'doubt');
    } finally { r.cleanup(); }
  });

  it('markAtOrAfter compares by head on one branch, and says when the marks are on two', () => {
    const early = readMarkForTest('main', 4, null);
    const late = readMarkForTest('main', 9, 3);
    assert.equal(markAtOrAfter(late, early), true);
    assert.equal(markAtOrAfter(early, late), false);
    assert.equal(markAtOrAfter(early, early), true);
    assert.equal(markAtOrAfter(late, readMarkForTest('fork', 1, null)), 'other-branch');
    assert.deepEqual(readMarkForTest('main', 4, null), early, 'two marks of one place are deep-equal');
    assert.equal(describeReadMark(null), 'no mark');
  });

  it('readMarkOf is null for a double that has no branch, and reads the last row where there is no store', () => {
    assert.equal(readMarkOf({}), null);
    const double = {
      currentBranch: () => ({ name: 'main' }),
      getAllMessages: () => [{ id: 'x', sequence: 7 }],
    } as never;
    assert.equal(describeReadMark(readMarkOf(double)), 'main@7');
    assert.equal(readMarkOf({ currentBranch: () => { throw new Error('closed'); }, getAllMessages: () => [] } as never), null);
  });

  it('window marks: null in legacy mode, the index length after the write-down', async () => {
    const r = await rig();
    try {
      const a = r.cm.addMessage('user', text('a'));
      assert.equal(windowMarkOf(r.cm), null);
      assert.equal(positionIn(r.cm, a), undefined, 'no position in legacy mode');
      r.cm.presentRows([]);
      assert.deepEqual(windowMarkOf(r.cm), { branch: 'main', position: r.cm.indexLength() });
      assert.equal(positionIn(r.cm, a), 0);
      assert.equal(windowEnd(r.cm), r.cm.indexLength());
    } finally { r.cleanup(); }
  });

  it('the mark is opaque, and a position is not a plain number (build-time pins)', () => {
    const mark: ReadMark = readMarkForTest('main', 1, null);
    // @ts-expect-error A mark's head is not a field to read.
    void mark.sequence;
    // @ts-expect-error A mark is not built by hand.
    const forged: ReadMark = { branch: 'main', sequence: 1 };
    // @ts-expect-error A cover takes a row, not a sequence.
    covers(mark, {}, 5);
    // @ts-expect-error A position is an index ordinal, not any number (a sequence, say).
    const position: Position = 5;
    void forged;
    void position;
  });
});
