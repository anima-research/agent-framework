/**
 * prefixesMeet (#265): two MCPL toolPrefixes can give one tool name,
 * `<toolPrefix>--<tool>`, exactly when they meet. Checked against a search
 * over every pair of short prefixes; mcpl-prefix-rule.test.ts checks where
 * the framework applies it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixesMeet } from '../src/mcpl/prefix-rule.js';

test('prefixesMeet says exactly when two prefixes can give one tool name', () => {
  // Every pair of prefixes up to four characters of `a` and `-`, against a
  // search for two tool names that join to one name. Four characters of tool
  // name are enough for any such pair to show a shared name.
  const words: string[] = [];
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i < 2 ** n; i++) words.push([...Array(n).keys()].map((k) => ((i >> k) & 1 ? '-' : 'a')).join(''));
  }
  for (const a of words) {
    for (const b of words) {
      const meet = words.some((t1) => words.some((t2) => `${a}--${t1}` === `${b}--${t2}`));
      assert.equal(prefixesMeet(a, b), meet, `"${a}" beside "${b}"`);
    }
  }
  for (const [a, b] of [['foo', 'foo--bar'], ['foo--bar', 'foo'], ['foo', 'foo-'], ['mcpl--plain', 'mcpl--plain--inner'], ['foo', 'foo']]) {
    assert.equal(prefixesMeet(a!, b!), true, `"${a}" meets "${b}"`);
  }
  for (const [a, b] of [['foo', 'foo-bar'], ['foo', 'foobar'], ['foo', 'bar'], ['foo-', 'foo-bar'], ['foo-bar', 'foo']]) {
    assert.equal(prefixesMeet(a!, b!), false, `"${a}" doesn't meet "${b}"`);
  }
});
