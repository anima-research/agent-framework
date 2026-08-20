import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHeadTailProjectionLease } from '../src/context-projection-lease.js';

const text = (participant: string, value: string) => ({ participant, content: [{ type: 'text' as const, text: value }] });

describe('resident-scoped head/tail projection lease', () => {
  const result = {
    messages: [
      text('head-a', 'h1'), text('head-b', 'h2'),
      text('middle-a', 'm1'), text('injection:world', 'injected'), text('middle-b', 'm2'),
      text('tail-a', 't1'), text('tail-b', 't2'), text('tail-c', 't3'),
    ],
    systemInjections: [],
  };
  const stats = { total: { messages: 7 }, head: { messages: 2 }, tail: { messages: 3 } };

  test('leases only the named resident and preserves injections', () => {
    const shaped = applyHeadTailProjectionLease(result, stats, 'mythos', 'mythos');
    assert.deepEqual(shaped.messages.map(m => m.participant), [
      'head-a', 'head-b', 'injection:world', 'tail-a', 'tail-b', 'tail-c',
    ]);
    assert.ok(result.messages.map(m => m.participant).includes('middle-a'));
  });

  test('is byte-equivalent by reference when disabled or another resident', () => {
    assert.equal(applyHeadTailProjectionLease(result, stats, 'sill', 'mythos'), result);
    assert.equal(applyHeadTailProjectionLease(result, stats, 'mythos', undefined), result);
  });

  test('fails closed when statistics do not match the compiled base', () => {
    assert.throws(() => applyHeadTailProjectionLease(result, { ...stats, total: { messages: 8 } }, 'mythos', 'mythos'), /base-count mismatch/);
  });
});
