import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendAll } from '../src/append-all.js';

test('appendAll appends a list to itself once, as push(...list) does', () => {
  const list = [1, 2, 3];
  appendAll(list, list);
  assert.deepEqual(list, [1, 2, 3, 1, 2, 3]);
});

test('appendAll appends a distinct list longer than a spread can pass, every item in order', () => {
  const into = [-1];
  const items = Array.from({ length: 250_000 }, (_, i) => i);
  appendAll(into, items);
  assert.equal(into.length, 250_001);
  assert.equal(into[0], -1);
  assert.deepEqual(into.slice(1), items);
});
