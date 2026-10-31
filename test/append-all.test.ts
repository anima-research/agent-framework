import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendAll } from '../src/append-all.js';

test('appendAll appends a list to itself once, as push(...list) does', () => {
  const list = [1, 2, 3];
  appendAll(list, list);
  assert.deepEqual(list, [1, 2, 3, 1, 2, 3]);
});
