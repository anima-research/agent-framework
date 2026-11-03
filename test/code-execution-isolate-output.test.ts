/** The isolate's output bound: the child's batches, and the parent's head and tail of each return's stretch. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MAX_BATCH_CHARS, OutputBatch, renderOutput, WindowOutput } from '../src/code-execution/isolate/output.js';

const bounds = { headChars: 10, tailChars: 10 };

test('a batch says when it is full, and flushes in pieces of at most a batch', () => {
  const batch = new OutputBatch();
  assert.equal(batch.write('x'.repeat(MAX_BATCH_CHARS - 1)), false);
  assert.equal(batch.write('yy'), true);
  const pieces = batch.flush();
  assert.ok(pieces.every((p) => p.length <= MAX_BATCH_CHARS), String(pieces.map((p) => p.length)));
  assert.equal(pieces.join(''), `${'x'.repeat(MAX_BATCH_CHARS - 1)}yy`, 'the pieces join to what was written');
  assert.equal(batch.unflushed, 0);
  assert.deepEqual(batch.flush(), []);
});

test("a batch's pieces never split a surrogate pair", () => {
  const batch = new OutputBatch();
  // The pair straddles where the first piece would end.
  batch.write('x'.repeat(MAX_BATCH_CHARS - 1) + '\u{1F600}' + 'z');
  const pieces = batch.flush();
  assert.equal(pieces.join(''), 'x'.repeat(MAX_BATCH_CHARS - 1) + '\u{1F600}' + 'z');
  for (const piece of pieces) assert.equal(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(piece), false, 'no piece ends or starts inside a pair');
});

test('a stretch within the head comes through whole', () => {
  const w = new WindowOutput(bounds);
  w.apply('abc');
  w.apply('def');
  assert.equal(w.render(), 'abcdef');
});

test('past the head and tail, the middle is dropped and counted', () => {
  const w = new WindowOutput(bounds);
  for (const piece of ['0123456789', 'abcdefghij', 'ABCDEFGHIJ']) w.apply(piece);
  assert.equal(w.render(), '0123456789\n[… 10 characters of output dropped here …]\nABCDEFGHIJ');
  assert.equal(w.droppedChars, 10);
});

test('each return starts a fresh stretch, with its own head and tail', () => {
  const w = new WindowOutput(bounds);
  w.apply('first stretch, long enough to drop some');
  assert.match(renderOutput(w.take()), /^first stre\n\[… \d+ characters of output dropped here …\]\n drop some$/);
  w.apply('0123456789abcdefghijABCDEFGHIJ');
  assert.equal(renderOutput(w.take()), '0123456789\n[… 10 characters of output dropped here …]\nABCDEFGHIJ');
  assert.equal(renderOutput(w.take()), '');
});

test('a surrogate pair is never split where the head ends or where the tail begins', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const w = new WindowOutput(bounds);
  // The head's 10th unit and the tail's first both fall inside a pair.
  for (const piece of ['123456789\u{1F600}', 'abcdefghijklmn', '\u{1F600}123456789']) w.apply(piece);
  assert.equal(lone.test(w.render()), false, w.render());
  assert.ok(w.render().startsWith('123456789\n'), 'the head stops before the pair rather than splitting it');
});

test("past the room it's given, the head and the tail are cut alike, each keeping its own end, and the count takes in what they gave up", () => {
  const w = new WindowOutput({ headChars: 100, tailChars: 100 });
  w.apply(`H${'h'.repeat(98)}|`);
  w.apply('m'.repeat(50));
  w.apply(`|${'t'.repeat(98)}T`);
  const window = w.window();
  assert.equal(window.dropped, 50);
  const whole = renderOutput(window);
  assert.equal(renderOutput(window, whole.length), whole, 'what fits comes whole');
  const fitted = renderOutput(window, 150);
  assert.ok(fitted.length <= 150, `${fitted.length} characters`);
  const [head, line, tail] = fitted.split('\n');
  assert.ok(head!.startsWith('H') && tail!.endsWith('T'), 'the head keeps its start, and the tail its end');
  assert.equal(head!.length, tail!.length, 'the two are cut alike');
  assert.equal(Number(/^\[… (\d+) characters of output dropped here …\]$/.exec(line!)![1]), 250 - head!.length - tail!.length, 'the count is all the output dropped');
  // When one part is short, the other takes the room it leaves.
  const uneven = renderOutput({ head: `A${'a'.repeat(198)}Z`, tail: 'xyz', dropped: 7 }, 120);
  assert.ok(uneven.length <= 120 && uneven.startsWith('Aaa') && uneven.endsWith('\nxyz'), uneven);
  assert.ok(uneven.split('\n')[0]!.length > 50, 'the head has the room the tail left');
  // With no room at all, only the count is left.
  assert.equal(renderOutput(window, 10), '\n[… 250 characters of output dropped here …]\n');
});

test('a cut to the room given never parts a surrogate pair, at the head or the tail', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const pairs = { head: '\u{1F600}'.repeat(50), tail: '\u{1F600}'.repeat(50), dropped: 0 };
  for (let max = 60; max < 70; max++) {
    const text = renderOutput(pairs, max);
    assert.equal(lone.test(text), false, `at ${max}: ${JSON.stringify(text)}`);
    const [head, line, tail] = text.split('\n');
    assert.equal(Number(/(\d+) characters/.exec(line!)![1]), 200 - head!.length - tail!.length, `at ${max}, the count is exact`);
  }
});

test("with nothing dropped yet, the head and the tail are cut as one stretch, so its end is kept wherever it lies", () => {
  // The whole output in the head, the tail still empty, as a stretch under the head's bound leaves it.
  const inHead = renderOutput({ head: `S${'m'.repeat(98)}E`, tail: '', dropped: 0 }, 80);
  assert.ok(inHead.length <= 80 && inHead.startsWith('Smm') && inHead.endsWith('mmE'), inHead);
  const [head, line, tail] = inHead.split('\n');
  assert.equal(Number(/(\d+) characters/.exec(line!)![1]), 100 - head!.length - tail!.length, 'the count is exact');
  // A tail shorter than its share: the end it keeps runs back into the head.
  const short = renderOutput({ head: `S${'h'.repeat(99)}`, tail: 'tE', dropped: 0 }, 80);
  assert.ok(short.endsWith('hhtE'), short);
});

test('past its bounds, a short head leaves its room to the tail', () => {
  const text = renderOutput({ head: 'abc', tail: `${'t'.repeat(199)}T`, dropped: 5 }, 100);
  const [head, line, tail] = text.split('\n');
  assert.equal(head, 'abc');
  assert.ok(text.length <= 100 && tail!.endsWith('T'), text);
  assert.ok(tail!.length > 30, `the tail took the head's unused room: ${tail!.length}`);
  assert.equal(Number(/(\d+) characters/.exec(line!)![1]), 5 + 200 - tail!.length);
});

test('a fractional room still counts whole characters', () => {
  // A short head leaves the tail a fractional share of a fractional room unless the room is whole.
  const text = renderOutput({ head: 'abc', tail: 't'.repeat(200), dropped: 5 }, 100.6);
  const count = /\n\[… (\S+) characters of output dropped here …\]\n/.exec(text)?.[1];
  assert.ok(count !== undefined && Number.isInteger(Number(count)), `the count is ${count}`);
  assert.ok(text.length <= 100, `${text.length} characters`);
});
