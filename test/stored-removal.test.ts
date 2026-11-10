/**
 * The removal funnel (src/stored-removal.ts) reports what it took (#291,
 * AF-7): the framework takes the rows a removal through one agent's context
 * took out of every other window that held them, and context-manager
 * tombstones each row by its own id, a body by each of its shards. On a
 * real store, with bodies stored as shards as context-manager's chunker
 * stores them.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type MessageId } from '@animalabs/context-manager';
import { bodyGroupRun, locateMessageIndices, removeStoredMessage, scanFromTail, storedIdsBetween } from '../src/stored-removal.js';

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) { try { closers.pop()!(); } catch { /* closed already */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type ShardStore = { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: string } } };

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'af-stored-removal-'));
  dirs.push(dir);
  const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
  closers.unshift(() => store.close());
  const cm = await ContextManager.open({ store, namespace: 'agents/scout' });
  closers.push(() => cm.close());
  const plain = (text: string) => String(cm.addMessage('user', [{ type: 'text', text }]));
  const body = (group: string, texts: string[]) => texts.map((text, shardIndex) =>
    (cm as unknown as ShardStore).messageStore.append('user', [{ type: 'text', text }], {}, undefined, { bodyGroupId: group, shardIndex }).id);
  const texts = () => cm.getAllMessages().map((m) => (m.content[0] as { text: string }).text);
  return { cm, plain, body, texts };
}

describe('the removal funnel reports what it took (#291)', () => {
  it('removeStoredMessage of a row outside any body returns its id, and of a body by its head every shard, in store order', async () => {
    const { cm, plain, body, texts } = await rig();
    const a = plain('a');
    const [s0, s1, s2] = body('g-doc', ['s0', 's1', 's2']);
    const z = plain('z');

    assert.deepEqual(removeStoredMessage(cm, a as MessageId), [a]);
    assert.deepEqual(texts(), ['s0', 's1', 's2', 'z']);
    assert.deepEqual(removeStoredMessage(cm, s0 as MessageId), [s0, s1, s2], 'the whole body, each shard by its id');
    assert.deepEqual(texts(), ['z']);
    assert.equal(cm.getMessage(z as MessageId)?.id, z);
  });

  it("bodyGroupRun gives the run's ids beside its ends", async () => {
    const { cm, plain, body } = await rig();
    plain('a');
    const [s0, s1] = body('g-two', ['s0', 's1']);
    const run = bodyGroupRun(cm, 2);
    assert.deepEqual({ from: run.from, to: run.to, fromId: run.fromId, toId: run.toId, group: run.group }, { from: 1, to: 2, fromId: s0, toId: s1, group: true });
    assert.deepEqual(run.ids, [s0, s1]);
    assert.deepEqual(bodyGroupRun(cm, 0).ids, [String(cm.getAllMessages()[0]!.id)]);
  });

  it('storedIdsBetween gives the inclusive interval in store order, either end first, and nothing for an end not stored', async () => {
    const { cm, plain, body } = await rig();
    const a = plain('a');
    const [s0, s1] = body('g-two', ['s0', 's1']);
    const b = plain('b');
    const c = plain('c');
    assert.deepEqual(storedIdsBetween(cm, a, b), [a, s0, s1, b]);
    assert.deepEqual(storedIdsBetween(cm, b, a), [a, s0, s1, b], 'the ends in either order');
    assert.deepEqual(storedIdsBetween(cm, c, c), [c]);
    assert.deepEqual(storedIdsBetween(cm, a, 'nope'), []);
    removeStoredMessage(cm, b as MessageId);
    assert.deepEqual(storedIdsBetween(cm, a, b), [], 'a removed end is not stored');
  });
});

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
  it('visits every row newest first, with its index, across windows that start at 16 rows and double to 500, reading no blobs', () => {
    const { cm, reads } = rows(1201);
    const seen: Array<[string, number]> = [];
    scanFromTail(cm, (row, index) => { seen.push([row.id, index]); return false; });
    assert.equal(seen.length, 1201);
    assert.deepEqual(seen.slice(0, 2), [['r1200', 1200], ['r1199', 1199]]);
    assert.deepEqual(seen.slice(15, 18), [['r1185', 1185], ['r1184', 1184], ['r1183', 1183]], 'on across a window boundary');
    assert.deepEqual(seen.at(-1), ['r0', 0]);
    assert.ok(seen.every(([id, index]) => id === `r${index}`));
    assert.deepEqual(reads, [
      { offset: 1185, limit: 16, resolveBlobs: false },
      { offset: 1153, limit: 32, resolveBlobs: false },
      { offset: 1089, limit: 64, resolveBlobs: false },
      { offset: 961, limit: 128, resolveBlobs: false },
      { offset: 705, limit: 256, resolveBlobs: false },
      { offset: 205, limit: 500, resolveBlobs: false },
      { offset: 0, limit: 205, resolveBlobs: false },
    ]);
  });

  it('stops at the row its visit says it is done with, reading no window past it', () => {
    const { cm, reads } = rows(1201);
    let visited = 0;
    scanFromTail(cm, (row) => { visited++; return row.id === 'r650'; });
    assert.equal(visited, 551);
    assert.equal(reads.length, 6);
    const { cm: newest, reads: newestReads } = rows(1201);
    scanFromTail(newest, () => true);
    assert.deepEqual(newestReads, [{ offset: 1185, limit: 16, resolveBlobs: false }], 'a reader done with the newest row reads one small window');
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
    assert.equal(reads.length, 7, 'an id not stored reads every window');
    const { cm: again, reads: againReads } = rows(1201);
    assert.deepEqual([...locateMessageIndices(again, new Set(['r1100', 'r600']))], [['r1100', { index: 1100 }], ['r600', { index: 600 }]]);
    assert.equal(againReads.length, 6);
    const { cm: none, reads: noneReads } = rows(1201);
    assert.equal(locateMessageIndices(none, new Set()).size, 0);
    assert.deepEqual(noneReads, []);
  });
});
