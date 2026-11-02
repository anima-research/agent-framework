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
import { bodyGroupRun, removeStoredMessage, storedIdsBetween } from '../src/stored-removal.js';

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
