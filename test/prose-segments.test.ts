import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { splitProseRuns, splitProseSegments } from '../src/prose-segments.js';

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

test('runs keep the words exactly as written; segments are those runs trimmed for routing', () => {
  const content: ContentBlock[] = [
    textBlock('    indented code\n    second line\n'),
    toolUse('t1'), toolResult('t1'),
    textBlock('\n\nAfter the tool.  '),
    toolUse('t2'), toolResult('t2'),
    textBlock(' \n\t'),
  ];
  assert.deepEqual(splitProseRuns(content), ['    indented code\n    second line\n', '\n\nAfter the tool.  ']);
  assert.deepEqual(splitProseSegments(content), ['indented code\n    second line', 'After the tool.']);
});

test('a refused XML attempt and its notice are boundaries too, and a turn-ending attempt leaves only its prose', () => {
  const attempt = { type: 'tool_attempt', rawXml: '<invoke name="send_message">' } as unknown as ContentBlock;
  const notice = { type: 'tool_notice', notices: [{ ordinal: 0, kind: 'refused', message: 'boundary' }] } as unknown as ContentBlock;
  assert.deepEqual(splitProseSegments([textBlock('Before the attempt.'), attempt, notice, textBlock('After its notice.')]),
    ['Before the attempt.', 'After its notice.']);
  assert.deepEqual(splitProseSegments([textBlock('Again.'), attempt]), ['Again.']);
  assert.deepEqual(splitProseRuns([textBlock('Before. '), attempt, notice, textBlock(' After.')]), ['Before. ', ' After.']);
});
