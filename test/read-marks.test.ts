/**
 * Read marks (src/read-marks.ts, #291): a mark taken in legacy mode covers
 * a row by its own sequence, as the `{ branch, sequence }` watermarks did,
 * while the window is the record, and once it is written down, the rows the
 * window held by its head where they still stand; one taken in presented
 * mode covers a row by its index ordinal, strictly below the index length
 * taken with it. Run over a real ContextManager on a temp chronicle store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, type StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock, Membrane } from '@animalabs/membrane';
import { Agent } from '../src/agent.js';
import type { AgentConfig } from '../src/types/index.js';
import {
  coverTest, covers, describeReadMark, markAtOrAfter, readMarkForTest, readMarkOf, readMarkThrough, type MarkCm, type ReadMark,
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

  it('a legacy mark read after the write-down covers the rows the window held by its head, where they still stand, as a presented mark through them would', async () => {
    const r = await rig();
    try {
      const add = (t: string) => r.cm.addMessage('user', text(t));
      const [a, b, c] = [add('a'), add('b'), add('c')];
      const mark = readMarkOf(r.cm)!;
      const d = add('d, stored after the mark, before the write-down');
      r.cm.presentRows([]);
      assert.equal(r.cm.windowMode(), 'presented');
      const e = add('e');
      r.cm.presentRows([e]);
      // What a mark taken in presented mode as the write-down left the
      // window, through the legacy mark's head, covers: the rows below d.
      const throughHead = readMarkForTest('main', r.store.currentSequence(), r.cm.ordinalOf(d)!);
      const reads = (m: ReadMark) => [a, b, c, d, e].map((id) => covers(m, r.cm, r.row(id)));
      assert.deepEqual(reads(mark), ['covered', 'covered', 'covered', 'not-covered', 'not-covered']);
      assert.deepEqual(reads(mark), reads(throughHead));
      r.cm.retractRows([b]);
      assert.equal(covers(mark, r.cm, r.row(b)), 'not-covered', 'taken out of the window');
      r.cm.presentRows([b]);
      assert.ok(r.cm.ordinalOf(b)! > r.cm.ordinalOf(e)!, 'b is presented again, after e');
      assert.deepEqual(reads(mark), ['covered', 'not-covered', 'covered', 'not-covered', 'not-covered'],
        "presented again after the mark's head: not covered, where a compare by sequence would cover it");
      assert.deepEqual(reads(mark), reads(throughHead));
      const atWriteDown = coverTest(mark, { currentBranch: () => r.cm.currentBranch(), windowMode: () => 'legacy' as const });
      assert.equal(atWriteDown(r.row(b)), 'covered', 'read against a window that is the record, it covers by sequence');
    } finally { r.cleanup(); }
  });

  it("a legacy mark's reading of a presented window reads where the window holds a row a few times per test, whatever the window's length", async () => {
    const r = await rig();
    try {
      const ids = Array.from({ length: 64 }, (_, i) => r.cm.addMessage('user', text(`row ${i}`)));
      const mark = readMarkForTest('main', r.row(ids[39]!).sequence, null);
      r.cm.presentRows([]);
      let reads = 0;
      const counting: MarkCm = {
        currentBranch: () => r.cm.currentBranch(), windowMode: () => r.cm.windowMode(),
        ordinalOf: (id) => r.cm.ordinalOf(id), indexLength: () => r.cm.indexLength(),
        getPresentedMessages: () => r.cm.getPresentedMessages(),
        branchSequenceOf: (id) => { reads++; return r.cm.branchSequenceOf(id); },
      };
      const test = coverTest(mark, counting);
      const covered = ids.filter((id) => test(r.row(id)) === 'covered');
      assert.deepEqual(covered, ids.slice(0, 40), 'the rows at or below the head');
      assert.ok(reads <= 7, `a binary search over the window: ${reads} reads`);
      const failing: MarkCm = { ...counting, branchSequenceOf: () => { throw new Error('closed'); } };
      const failed = coverTest(mark, failing);
      assert.equal(failed(r.row(ids[0]!)), 'doubt', "a read of the window that throws can't say");
      assert.equal(failed(r.row(ids[63]!)), 'not-covered', 'a row stored after the head needs no read');
      // A double that can't say where its window holds a row is read by sequence.
      const bare = coverTest(mark, { currentBranch: () => r.cm.currentBranch(), windowMode: () => 'presented' as const, ordinalOf: () => 99 });
      assert.deepEqual([bare(r.row(ids[39]!)), bare(r.row(ids[40]!))], ['covered', 'not-covered']);
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
      // Read across against a presented window: the rows it held, where they
      // stand, through the lower of the head and the branch point.
      const b = r.cm.addMessage('user', text('b'));
      r.cm.presentRows([]);
      const across = { partAt: r.row(b).sequence };
      assert.deepEqual([a, b].map((id) => covers(mark, r.cm, r.row(id), across)), ['covered', 'covered']);
      r.cm.retractRows([a]);
      r.cm.presentRows([a]);
      assert.deepEqual([a, b].map((id) => covers(mark, r.cm, r.row(id), across)), ['not-covered', 'covered'],
        'a row presented again after the branch point is not covered');
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
    // Two marks that both keep a length: the greater is the later, at one
    // head too; equal lengths fall back to the head.
    assert.equal(markAtOrAfter(readMarkForTest('main', 9, 5), readMarkForTest('main', 9, 3)), true);
    assert.equal(markAtOrAfter(readMarkForTest('main', 9, 3), readMarkForTest('main', 9, 5)), false, 'one head, a shorter window');
    assert.equal(markAtOrAfter(readMarkForTest('main', 8, 5), readMarkForTest('main', 9, 5)), false, 'one length: by head');
    assert.equal(markAtOrAfter(readMarkForTest('main', 9, 3), readMarkForTest('main', 8, null)), true, 'one without a length: by head');
    // A double without a store reads its head from its last row, which a
    // presentation doesn't move: two marks at one head with one between.
    let length = 3;
    const double = {
      currentBranch: () => ({ name: 'main' }), getAllMessages: () => [{ id: 'x', sequence: 7 }],
      windowMode: () => 'presented' as const, indexLength: () => length,
    } as never;
    const before = readMarkOf(double)!;
    length = 4;
    const after = readMarkOf(double)!;
    assert.deepEqual([describeReadMark(before), describeReadMark(after)], ['main@7#3', 'main@7#4']);
    assert.deepEqual([markAtOrAfter(after, before), markAtOrAfter(before, after)], [true, false]);
  });

  it("of two publish marks at one head, the one whose window reached further is kept, so the rows presented between count as read before the publish", async () => {
    const r = await rig();
    try {
      r.cm.presentRows([]);
      const a = r.cm.addMessage('user', text('a'));
      r.cm.presentRows([a]);
      const b = r.cm.addMessage('user', text('b'));
      r.cm.presentRows([b]);
      // A redo's mark (readMarkThrough) covers the window below b; one taken
      // at the same head covers it all.
      const through = readMarkThrough(r.cm, r.cm.ordinalOf(b)!)!;
      const now = readMarkOf(r.cm)!;
      assert.equal(describeReadMark(through).split('#')[0], describeReadMark(now).split('#')[0], 'one head');
      assert.deepEqual([covers(through, r.cm, r.row(b)), covers(now, r.cm, r.row(b))], ['not-covered', 'covered']);
      const agent = new Agent({ name: 'mira', model: 'test-model', systemPrompt: 'sys' } as AgentConfig, r.cm, {} as Membrane);
      const room = 'chat:room';
      agent.notePublished(room, through);
      assert.equal(agent.publishedAfterReading(room, r.row(b), r.cm), false, 'noted before b was read');
      agent.notePublished(room, now);
      assert.equal(agent.publishedAfterReading(room, r.row(b), r.cm), true, 'the later mark replaces it');
      agent.notePublished(room, through);
      assert.equal(agent.publishedAfterReading(room, r.row(b), r.cm), true, 'and the earlier one does not replace the later');
    } finally { r.cleanup(); }
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
