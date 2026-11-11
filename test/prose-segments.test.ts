import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { splitProseRuns, withoutRoundsProse } from '../src/prose-segments.js';

/** The runs as speech routes them: each trimmed, as the framework does. */
const splitProseSegments = (content: Parameters<typeof splitProseRuns>[0]): string[] =>
  splitProseRuns(content).map((run) => run.trim());

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

test('runs keep the words exactly as written', () => {
  const content: ContentBlock[] = [
    textBlock('    indented code\n    second line\n'),
    toolUse('t1'), toolResult('t1'),
    textBlock('\n\nAfter the tool.  '),
    toolUse('t2'), toolResult('t2'),
    textBlock(' \n\t'),
  ];
  assert.deepEqual(splitProseRuns(content), ['    indented code\n    second line\n', '\n\nAfter the tool.  ']);
});

test('a refused XML attempt and its notice are boundaries too, and a turn-ending attempt leaves only its prose', () => {
  const attempt = { type: 'tool_attempt', rawXml: '<invoke name="send_message">' } as unknown as ContentBlock;
  const notice = { type: 'tool_notice', notices: [{ ordinal: 0, kind: 'refused', message: 'boundary' }] } as unknown as ContentBlock;
  assert.deepEqual(splitProseSegments([textBlock('Before the attempt.'), attempt, notice, textBlock('After its notice.')]),
    ['Before the attempt.', 'After its notice.']);
  assert.deepEqual(splitProseSegments([textBlock('Again.'), attempt]), ['Again.']);
  assert.deepEqual(splitProseRuns([textBlock('Before. '), attempt, notice, textBlock(' After.')]), ['Before. ', ' After.']);
  // A notice is a boundary of its own, with no attempt before it.
  assert.deepEqual(splitProseRuns([textBlock('Before. '), notice, textBlock(' After.')]), ['Before. ', ' After.']);
});

test('withoutRoundsProse drops a round\'s text by its place: the text before its calls, after the previous round\'s tool blocks', () => {
  const content: ContentBlock[] = [
    textBlock('SAME'),
    toolUse('t1'), toolResult('t1'),
    thinking(), textBlock('MIDDLE'),
    toolUse('t2'), toolUse('t3'), toolResult('t2'), toolResult('t3'),
    thinking(), textBlock('SAME'),
    toolUse('t4'), toolResult('t4'),
    textBlock('LAST'),
  ];
  const dropped = withoutRoundsProse(content, new Set([2]));
  assert.deepEqual(splitProseSegments(dropped), ['SAME', 'MIDDLE', 'LAST'], 'round 2 is the third round, whatever its text');
  assert.equal(dropped.filter((b) => b.type === 'thinking').length, 2, 'blocks that aren\'t text stay');
  assert.deepEqual(splitProseSegments(withoutRoundsProse(content, new Set([0, 1]))), ['SAME', 'LAST']);
});

test('withoutRoundsProse counts a round with no prose, first or between others, and keeps every round\'s text with no rounds named', () => {
  const first: ContentBlock[] = [
    toolUse('t1'), toolResult('t1'),
    textBlock('SECOND'),
    toolUse('t2'), toolResult('t2'),
    textBlock('THIRD'),
  ];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(first, new Set([1]))), ['THIRD']);
  assert.deepEqual(withoutRoundsProse(first, new Set()), first);
  const between: ContentBlock[] = [
    textBlock('ONE'),
    toolUse('t1'), toolResult('t1'),
    toolUse('t2'), toolResult('t2'),
    textBlock('THREE'),
    toolUse('t3'), toolResult('t3'),
    textBlock('LAST'),
  ];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(between, new Set([2]))), ['ONE', 'LAST'], 'THREE is round 2, after round 1 with no prose');
  assert.deepEqual(splitProseSegments(withoutRoundsProse(between, new Set([1]))), ['ONE', 'THREE', 'LAST'], 'round 1 has no prose to drop');
});

test('withoutRoundsProse keeps text between two calls of one round, and text after its last unanswered call, in that round', () => {
  // Text between calls of one round (native content without roundContent, or
  // a first response cut off at max_tokens) stays that round's, and the later
  // rounds keep their places.
  const interleaved: ContentBlock[] = [
    textBlock('A0'), toolUse('t1'), textBlock('B0'), toolUse('t2'), toolResult('t1'), toolResult('t2'),
    textBlock('C1'), toolUse('t3'), toolResult('t3'),
    textBlock('D'),
  ];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(interleaved, new Set([0, 1]))), ['D']);
  assert.deepEqual(splitProseSegments(withoutRoundsProse(interleaved, new Set([1]))), ['A0', 'B0', 'D']);
  const blankBetween: ContentBlock[] = [
    textBlock('A0'), toolUse('t1'), textBlock('\n'), toolUse('t2'), toolResult('t1'), toolResult('t2'),
    textBlock('C1'), toolUse('t3'), toolResult('t3'),
    textBlock('D'),
  ];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(blankBetween, new Set([1]))), ['A0', 'D']);
  // A cut-off first response: both calls are round 0's, results or not.
  const cut: ContentBlock[] = [textBlock('A0'), toolUse('t1'), textBlock('B0'), toolUse('t2')];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(cut, new Set([0]))), []);
  // Text after a round's last call with no results after it stays the round's:
  // content that ends at an unanswered call can't be told from a round cut
  // off at max_tokens, whose text after the call is the round's own.
  const unanswered: ContentBlock[] = [textBlock('P0'), toolUse('t1'), textBlock('AFTER')];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(unanswered, new Set([0]))), []);
  const laterUnanswered: ContentBlock[] = [
    textBlock('P0'), toolUse('t1'), toolResult('t1'),
    textBlock('P1'), toolUse('t2'), textBlock('AFTER'),
  ];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(laterUnanswered, new Set([1]))), ['P0']);
  // Text between a round's last call and its results stays the round's too.
  const beforeResults: ContentBlock[] = [textBlock('P0'), toolUse('t1'), textBlock('MID'), toolResult('t1'), textBlock('P1'), toolUse('t2'), toolResult('t2'), textBlock('LAST')];
  assert.deepEqual(splitProseSegments(withoutRoundsProse(beforeResults, new Set([1]))), ['P0', 'MID', 'LAST']);
  assert.deepEqual(splitProseSegments(withoutRoundsProse(beforeResults, new Set([0]))), ['P1', 'LAST']);
});
