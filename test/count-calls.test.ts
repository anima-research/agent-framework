// The test helper that counts a method's calls for one synchronous call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countingCalls } from './helpers/count-calls.js';

test('countingCalls counts the calls it picks, throws past its ceiling, and restores the method either way', () => {
  const original = String.prototype.indexOf;
  const counted = countingCalls(String.prototype, 'indexOf', (args) => args[0] === 'b', 10, () => ['abc'.indexOf('b'), 'abc'.indexOf('c'), 'abc'.indexOf('b')]);
  assert.deepEqual(counted, { result: [1, 2, 1], calls: 2 });
  assert.throws(() => countingCalls(String.prototype, 'indexOf', () => true, 1, () => 'abc'.indexOf('a') + 'abc'.indexOf('b')), /indexOf was called more than 1 times where counted/);
  assert.equal(String.prototype.indexOf, original);
});

test('countingCalls refuses a run that returns a promise or another thenable, restores the method, and passes a nullish result through', () => {
  const original = Set.prototype.has;
  assert.throws(() => countingCalls(Set.prototype, 'has', () => true, 10, async () => new Set([1]).has(1)), /run returned a promise/);
  assert.throws(() => countingCalls(Set.prototype, 'has', () => true, 10, () => ({ then: () => {} })), /run returned a promise/);
  assert.equal(Set.prototype.has, original);
  assert.deepEqual(countingCalls(Set.prototype, 'has', () => true, 10, () => undefined), { result: undefined, calls: 0 });
  assert.deepEqual(countingCalls(Set.prototype, 'has', () => true, 10, () => null), { result: null, calls: 0 });
});

test('countingCalls allows exactly as many counted calls as its ceiling', () => {
  const twice = countingCalls(String.prototype, 'indexOf', () => true, 2, () => 'abc'.indexOf('a') + 'abc'.indexOf('b'));
  assert.deepEqual(twice, { result: 1, calls: 2 });
  assert.throws(() => countingCalls(String.prototype, 'indexOf', () => true, 2, () => 'abc'.indexOf('a') + 'abc'.indexOf('b') + 'abc'.indexOf('c')), /more than 2 times/);
});

test("countingCalls restores the method when run throws, or its predicate does, and lets the error through", () => {
  const original = String.prototype.indexOf;
  assert.throws(() => countingCalls(String.prototype, 'indexOf', () => true, 10, () => { 'abc'.indexOf('a'); throw new Error('run failed'); }), /run failed/);
  assert.equal(String.prototype.indexOf, original);
  assert.throws(() => countingCalls(String.prototype, 'indexOf', () => { throw new Error('predicate failed'); }, 10, () => 'abc'.indexOf('a')), /predicate failed/);
  assert.equal(String.prototype.indexOf, original);
});
