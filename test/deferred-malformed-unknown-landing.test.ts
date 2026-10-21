import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager, PassthroughStrategy, MalformedContentError } from '@animalabs/context-manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';

// Focused merge regression: the unit harness opens no store/provider/network; the final characterization uses a temporary store.
function harness() {
  const f = Object.create(AgentFramework.prototype) as any;
  const agent = {};
  let readback: any[] | undefined = [];
  let lookup: any[] | undefined = undefined;
  let count: number | undefined = 0;
  const queued: any[] = [];
  const outcomes: any[] = [];
  f.primaryAgentName = 'a';
  f.deliveryAgent = () => agent;
  f.storedCountOf = () => count;
  f.storedCopiesOf = () => readback;
  f.landedCopiesById = () => lookup;
  f.requeueDrained = (entries: any[]) => queued.push(...entries);
  f.logDeferredWriteError = (_m: any, _w: any, _e: any, outcome: any) => outcomes.push(outcome);
  const msg = (id: string, seq: number, forAgent = 'a') => ({
    id, seq, forAgent, participant: 'user', content: [{ type: 'text', text: id }],
  });
  return { f, queued, outcomes, msg,
    setReadback: (v: any[] | undefined) => { readback = v; },
    setLookup: (v: any[] | undefined) => { lookup = v; },
    setCount: (v: number | undefined) => { count = v; },
  };
}
const malformed = () => new MalformedContentError('fixture', ['content[0]']);

test('malformed refusal with confirmed empty landing drops and unblocks its successor', () => {
  const h = harness(); const a = h.msg('a', 1), b = h.msg('b', 2); const calls: string[] = [];
  let landed = 0;
  const result = h.f.writeDrainedInOrder([a, b], 'test', (m: any) => {
    calls.push(m.id); if (m === a) throw malformed(); return 'b-stored';
  }, () => landed++);
  assert.deepEqual(calls, ['a', 'b']); assert.equal(result.has(a), false);
  assert.equal(result.get(b).id, 'b-stored'); assert.deepEqual(h.queued, []);
  assert.equal(landed, 0); assert.deepEqual(h.outcomes, ['dropped']);
});

for (const unknown of ['count', 'readback']) {
  test(`malformed refusal drops despite unavailable ${unknown}, unblocking its successor`, () => {
    const h = harness(); if (unknown === 'count') h.setCount(undefined); else h.setReadback(undefined);
    const a = h.msg('a', 1), b = h.msg('b', 2), c = h.msg('c', 3, 'other');
    const calls: string[] = [];
    const written = h.f.writeDrainedInOrder([c, b, a], 'test', (m: any) => {
      calls.push(m.id); if (m === a) throw malformed(); return m.id + '-stored';
    });
    assert.deepEqual(calls, ['a', 'b', 'c']); assert.deepEqual(h.queued, []);
    assert.equal(written.has(a), false); assert.equal((a as any).landing, undefined);
    assert.deepEqual(h.outcomes, ['dropped']);
  });
  test(`ordinary failure with unknown ${unknown} retains ordering and reconciliation`, () => {
    const h = harness(); if (unknown === 'count') h.setCount(undefined); else h.setReadback(undefined);
    const a = h.msg('a', 1), b = h.msg('b', 2), c = h.msg('c', 3, 'other');
    const calls: string[] = [];
    h.f.writeDrainedInOrder([c, b, a], 'test', (m: any) => {
      calls.push(m.id); if (m === a) throw new Error('uncertain I/O failure'); return 'c-stored';
    });
    assert.deepEqual(calls, ['a', 'c']); assert.deepEqual(h.queued, [a, b]);
    assert.equal((a as any).landing, 'unknown'); assert.deepEqual(h.outcomes, ['unknown']);
    h.queued.length = 0;
    h.f.writeDrainedInOrder([a, b], 'retry', () => { throw new Error('must not rewrite before lookup'); });
    assert.deepEqual(h.queued, [a, b]); assert.equal(h.outcomes.at(-1), 'still-unknown');
  });
}

test('unknown landing found by ID counts as written without rewriting, then unblocks successor', () => {
  const h = harness(); const a = Object.assign(h.msg('a', 1), { landing: 'unknown' });
  const b = h.msg('b', 2); const stored = { id: 'stored-a', participant: 'user', content: a.content };
  h.setLookup([stored]); const calls: string[] = [], callbacks: string[] = [];
  const result = h.f.writeDrainedInOrder([a, b], 'retry', (m: any) => {
    calls.push(m.id); return 'stored-b';
  }, (_m: any, id: string) => callbacks.push(id));
  assert.deepEqual(calls, ['b']); assert.deepEqual(callbacks, ['stored-a']);
  assert.equal(result.get(a).id, 'stored-a'); assert.deepEqual(result.get(a).content, a.content);
  assert.deepEqual(h.queued, []); assert.equal(h.outcomes[0].foundLater, true);
});

for (const outcome of ['success', 'malformed-empty', 'malformed-unknown']) {
  test(`unknown landing confirmed absent retries once: ${outcome}`, () => {
    const h = harness(); const a = Object.assign(h.msg('a', 1), { landing: 'unknown' });
    h.setLookup([]); if (outcome === 'malformed-unknown') h.setReadback(undefined);
    let calls = 0;
    const result = h.f.writeDrainedInOrder([a], 'retry', () => {
      calls++; if (outcome !== 'success') throw malformed(); return 'stored-a';
    });
    assert.equal(calls, 1);
    if (outcome === 'success') { assert.equal(result.get(a).id, 'stored-a'); assert.deepEqual(h.queued, []); }
    if (outcome === 'malformed-empty') { assert.deepEqual(h.outcomes, ['dropped']); assert.deepEqual(h.queued, []); }
    if (outcome === 'malformed-unknown') { assert.equal(a.landing, undefined); assert.deepEqual(h.queued, []); assert.deepEqual(h.outcomes, ['dropped']); }
  });
}

test('ordinary error with empty landing remains queued with its successor', () => {
  const h = harness(); const a = h.msg('a', 1), b = h.msg('b', 2);
  let calls = 0;
  h.f.writeDrainedInOrder([a, b], 'test', () => { calls++; throw new Error('I/O failure'); });
  assert.equal(calls, 1); assert.deepEqual(h.queued, [a, b]); assert.deepEqual(h.outcomes, [undefined]);
});

test('confirmed readback copy takes precedence over a malformed refusal', () => {
  const h = harness(); const a = h.msg('a', 1);
  h.setReadback([{ id: 'stored-a', participant: 'user', content: a.content }]);
  let callbacks = 0;
  const result = h.f.writeDrainedInOrder([a], 'test', () => { throw malformed(); }, () => callbacks++);
  assert.equal(result.get(a).id, 'stored-a'); assert.equal(callbacks, 1); assert.deepEqual(h.queued, []);
  assert.equal(h.outcomes[0].count, 1);
});


test('CM typed malformed refusal is pre-write for whole bodies and all ingress shards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-malformed-prewrite-'));
  let shardMalformed = false;
  const strategy = Object.assign(new PassthroughStrategy(), {
    chunkIngressMessage: () => shardMalformed ? {
      bodyGroupId: 'fixture-group',
      shards: [
        { shardIndex: 0, content: [{ type: 'text' as const, text: 'valid first shard' }] },
        { shardIndex: 1, content: [{ type: 'text', text: 42 }] as unknown as ContentBlock[] },
      ],
    } : null,
  });
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
  try {
    const initial = cm.addMessage('user', [{ type: 'text', text: 'keep me' }]);
    const count = cm.getMessageCount();
    const bodies = [
      [{ type: 'text', text: 42 }],
      [{ type: 'text' }],
      [{ type: 'blob_ref', hash: 'not-caller-owned' }],
      [{ type: 'text', text: 'valid before malformed' }, { type: 'text', text: false }],
      [{ type: 'image', source: 'not-an-object' }],
    ];
    for (let i = 0; i < bodies.length; i++) {
      const id = `refused-${i}`;
      assert.throws(() => cm.addMessage('user', bodies[i] as never, { deferredWriteId: id } as never), MalformedContentError);
      assert.equal(cm.getMessageCount(), count);
      assert.equal(cm.queryMessages({ metadata: { deferredWriteId: id } } as never).messages.length, 0);
    }
    shardMalformed = true;
    assert.throws(() => cm.addMessage('user', [{ type: 'text', text: 'split this valid input' }], { deferredWriteId: 'bad-shard' } as never), MalformedContentError);
    assert.equal(cm.getMessageCount(), count, 'even the valid first shard was never appended');
    assert.equal(cm.queryMessages({ metadata: { deferredWriteId: 'bad-shard' } } as never).messages.length, 0);
    assert.deepEqual(cm.getMessage(initial)?.content, [{ type: 'text', text: 'keep me' }]);
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});
