// The text helpers the workspace's read, grep and edit share: numbered lines
// with a long one cut, a BOM's check, and a string's length as JSON, which a
// page's budget is counted in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasBom, jsonLength, numberedLine, safeCut } from '../src/modules/workspace/text.js';

test('numberedLine numbers a line as cat -n does, and cuts a long one without splitting a surrogate pair', () => {
  assert.equal(numberedLine('text', 7), '     7\ttext');
  assert.equal(numberedLine('x'.repeat(2000), 1), `     1\t${'x'.repeat(2000)}`);
  assert.equal(numberedLine('x'.repeat(2001), 1), `     1\t${'x'.repeat(2000)} [… 1 more chars]`);
  const emoji = 'x'.repeat(4) + '😀' + 'y';
  assert.equal(safeCut(emoji, 5), 4);
  assert.equal(numberedLine(emoji, 2, 5, (cut) => `from ${cut}`), `     2\txxxx [… 3 more chars; from 4]`);
  assert.equal(numberedLine('abc', 3, 0), '     3\t [… 3 more chars]');
});

test('hasBom finds a UTF-8 byte order mark at the start alone', () => {
  assert.equal(hasBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), true);
  assert.equal(hasBom(Buffer.from([0xef, 0xbb])), false);
  assert.equal(hasBom(Buffer.from([0x61, 0xef, 0xbb, 0xbf])), false);
  // A byte off the mark at any one of its three places is no mark.
  for (const at of [0, 1, 2]) {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
    bytes[at] ^= 1;
    assert.equal(hasBom(bytes), false, `byte ${at} changed`);
  }
});

test('jsonLength counts a string as JSON.stringify writes it', () => {
  let mismatches = 0;
  const check = (value: string) => {
    if (jsonLength(value) !== JSON.stringify(value).length - 2) mismatches++;
  };
  for (let c = 0; c <= 0xffff; c++) check(String.fromCharCode(c));
  // Escapes and surrogates beside each other: a pair, each half alone, and both in the wrong order.
  const edges = [0x41, 0x22, 0x5c, 0x0a, 0x1f, 0x7f, 0x2028, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xd83d, 0xde00];
  for (const a of edges) for (const b of edges) for (const c of edges) check(String.fromCharCode(a, b, c));
  assert.equal(mismatches, 0);
});
