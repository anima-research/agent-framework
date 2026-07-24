import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { splitProseSegments, undeliveredSuffix, isWhitespaceInsensitivePrefix } from '../src/prose-segments.js';

const textBlock = (text: string): ContentBlock => ({ type: 'text', text } as ContentBlock);
const toolUse = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'workspace--write', input: {} } as ContentBlock);
const toolResult = (id: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content: 'done', isError: false } as ContentBlock);
const thinking = (): ContentBlock => ({ type: 'thinking', thinking: '', signature: 'x' } as ContentBlock);

test('item 4: prose before a tool_use is not dropped or merged — it becomes its own ordered segment', () => {
  // Shape of the real captured turn (docs/reports/item4-failing-transcript.jsonl),
  // as the membrane accumulates it into response.content across tool rounds:
  //   [text FIRST, tool_use, tool_result, thinking, tool_use, tool_result, text SECOND]
  const content: ContentBlock[] = [
    textBlock('FIRST_MESSAGE_BEFORE_TOOL.'),
    toolUse('t1'),
    toolResult('t1'),
    thinking(),
    toolUse('t2'),
    toolResult('t2'),
    textBlock('SECOND_MESSAGE_AFTER_TOOL.'),
  ];

  const segments = splitProseSegments(content);

  // Old behaviour joined all text into ONE trailing post
  // ("FIRST_MESSAGE_BEFORE_TOOL.\nSECOND_MESSAGE_AFTER_TOOL."); the fix keeps
  // them as two separate messages IN ORDER.
  assert.deepEqual(segments, ['FIRST_MESSAGE_BEFORE_TOOL.', 'SECOND_MESSAGE_AFTER_TOOL.']);
});

test('three interleaved messages (msgA → [tool] → msgB → [tool] → msgC) all survive in order', () => {
  const content: ContentBlock[] = [
    textBlock('A'),
    toolUse('t1'), toolResult('t1'),
    textBlock('B'),
    toolUse('t2'), toolResult('t2'),
    textBlock('C'),
  ];
  assert.deepEqual(splitProseSegments(content), ['A', 'B', 'C']);
});

test('contiguous text blocks merge into one segment; whitespace-only runs are dropped', () => {
  const content: ContentBlock[] = [
    textBlock('line one'),
    textBlock('line two'),
    toolUse('t1'), toolResult('t1'),
    textBlock('   '),
  ];
  assert.deepEqual(splitProseSegments(content), ['line one\nline two']);
});

test('a plain no-tool turn yields a single segment (unchanged behaviour)', () => {
  assert.deepEqual(splitProseSegments([textBlock('just a reply')]), ['just a reply']);
});

test('a tool-only turn (no prose) yields no segments', () => {
  assert.deepEqual(splitProseSegments([toolUse('t1'), toolResult('t1')]), []);
});

// ── undeliveredSuffix: matching a voice client's spokenText against
//    live-routed prose (see the abort keepText path in framework.ts) ──

test('undeliveredSuffix: spoken fully covered by delivered → null (nothing further to post)', () => {
  assert.equal(undeliveredSuffix('The full sentence the mo', 'The full sentence the model intended'), null);
  assert.equal(undeliveredSuffix('Same text.', 'Same text.'), null);
});

test('undeliveredSuffix: spoken extends past delivered → the raw suffix', () => {
  assert.equal(undeliveredSuffix('Hello there general', 'Hello there'), 'general');
});

test('undeliveredSuffix: whitespace differences never break alignment', () => {
  // Live-routed segments are joined with '\n'; the voice stream keeps its own
  // spacing. Only the non-whitespace character sequence matters.
  assert.equal(undeliveredSuffix('One two  three four', 'One\ntwo\nthree'), 'four');
  assert.equal(undeliveredSuffix('One  two', 'One two'), null);
});

test('undeliveredSuffix: diverging spoken text is returned whole (per-block clients)', () => {
  // A client that resets its accumulator per block sends only the current
  // utterance's fragment — never posted, so all of it is undelivered.
  assert.equal(
    undeliveredSuffix('A new fragment entirely', 'The prose the live path posted'),
    'A new fragment entirely',
  );
});

test('undeliveredSuffix: suffix that is only whitespace → null', () => {
  assert.equal(undeliveredSuffix('Hello there  ', 'Hello there'), null);
});

test('undeliveredSuffix: astral characters compare safely at the boundary', () => {
  assert.equal(undeliveredSuffix('Great 🎉 and onward', 'Great 🎉'), 'and onward');
  assert.equal(undeliveredSuffix('Great 🎉', 'Great 🎉'), null);
});

// ── isWhitespaceInsensitivePrefix: the staleness-guard predicate ──

test('isWhitespaceInsensitivePrefix: matches across whitespace differences', () => {
  assert.equal(isWhitespaceInsensitivePrefix('Hello there', 'Hello\nthere general'), true);
  assert.equal(isWhitespaceInsensitivePrefix('Hello  there ', 'Hello there'), true);
});

test('isWhitespaceInsensitivePrefix: rejects diverging and over-long prefixes', () => {
  assert.equal(isWhitespaceInsensitivePrefix('Something else', 'Hello there'), false);
  assert.equal(
    isWhitespaceInsensitivePrefix('Hello there general', 'Hello there'),
    false,
    'a report longer than what was streamed cannot be a prefix of it',
  );
});

test('isWhitespaceInsensitivePrefix: empty prefix trivially matches', () => {
  assert.equal(isWhitespaceInsensitivePrefix('', 'anything'), true);
  assert.equal(isWhitespaceInsensitivePrefix('', ''), true);
});
