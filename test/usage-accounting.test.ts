import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cumulativeDelta } from '../src/usage-accounting.js';

test('cumulative usage is reduced to the physical provider-call delta', () => {
  assert.equal(cumulativeDelta(120, 0), 120);
  assert.equal(cumulativeDelta(275, 120), 155);
});

test('a reset or malformed cumulative usage sample fails conservatively', () => {
  assert.equal(cumulativeDelta(25, 275), 25, 'counter reset is an already-per-call sample');
  assert.equal(cumulativeDelta(Number.NaN, 25), 0);
  assert.equal(cumulativeDelta(-1, 25), 0);
});
