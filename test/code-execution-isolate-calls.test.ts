/** The isolate's call record: what it counts, what it names, and its bounds. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CALL_BRIEF_CHARS, CALLS_NAMED, CallLog, callBrief } from '../src/code-execution/isolate/calls.js';

test('answered calls are counted by how they were answered, and none is kept', () => {
  const log = new CallLog();
  for (const outcome of ['answered', 'answered', 'failed', 'refused'] as const) log.answered(log.start('echo', '{}'), outcome, '');
  assert.deepEqual(log.summary(), { made: 4, answered: 2, failed: 1, refused: 1, unsent: 0, running: 0, waiting: 0, named: [], more: {} });
});

test('a call never sent, for want of room in the host, counts among those made, and apart from the refused', () => {
  const log = new CallLog();
  log.unsent();
  log.answered(log.start('echo', '{}'), 'refused', '');
  assert.deepEqual(log.summary(), { made: 2, answered: 0, failed: 0, refused: 1, unsent: 1, running: 0, waiting: 0, named: [], more: {} });
});

test("a refusal the script never saw is counted as a refusal, and nothing is named", () => {
  const log = new CallLog();
  log.unseen(log.start('echo', '{}'), 'refused');
  assert.deepEqual(log.summary(), { made: 1, answered: 0, failed: 0, refused: 1, unsent: 0, running: 0, waiting: 0, named: [], more: {} });
});

test("a result too large for the script's memory is named, since the script didn't see it", () => {
  const log = new CallLog();
  log.answered(log.start('workspace--read', '{"path":"big.json"}'), 'too-large', '');
  assert.deepEqual(log.summary().named, [{ tool: 'workspace--read', args: '{"path":"big.json"}', state: 'too-large' }]);
});

test('calls still running when the script ends are named as uncertain, with their arguments', () => {
  const log = new CallLog();
  log.start('workspace--write', '{"path":"a.md"}');
  log.start('workspace--write', '{"path":"b.md"}');
  assert.equal(log.summary().running, 2);
  log.ended();
  assert.deepEqual(log.summary().named, [
    { tool: 'workspace--write', args: '{"path":"a.md"}', state: 'uncertain' },
    { tool: 'workspace--write', args: '{"path":"b.md"}', state: 'uncertain' },
  ]);
  assert.equal(log.summary().running, 0);
});

test("a timed-out call is named, and an answer before the end names the answer's start", () => {
  const log = new CallLog();
  const late = log.start('slow', '{"n":1}');
  const never = log.start('slow', '{"n":2}');
  log.timedOut(late);
  log.timedOut(never);
  log.answered(late, 'answered', 'Wrote 3 lines to notes.md');
  log.ended();
  assert.deepEqual(log.summary().named, [
    { tool: 'slow', args: '{"n":1}', state: 'timed-out-answered', answer: 'Wrote 3 lines to notes.md' },
    { tool: 'slow', args: '{"n":2}', state: 'timed-out' },
  ]);
});

test('the record stands as it was at the end: a later answer changes nothing', () => {
  const log = new CallLog();
  const call = log.start('slow', '{}');
  log.timedOut(call);
  log.ended();
  log.answered(call, 'answered', 'too late');
  assert.deepEqual(log.summary().named, [{ tool: 'slow', args: '{}', state: 'timed-out' }]);
});

test(`past ${CALLS_NAMED} named calls, the rest are counted by tool`, () => {
  const log = new CallLog();
  for (let i = 0; i < CALLS_NAMED + 3; i++) log.start(i % 2 ? 'a' : 'b', `{"i":${i}}`);
  log.ended();
  const s = log.summary();
  assert.equal(s.named.length, CALLS_NAMED);
  // i = 10, 11 and 12 are past the named: b, a, b.
  assert.deepEqual(s.more, { a: 1, b: 2 });
});

test('arguments are cut to their brief, never between the halves of a surrogate pair', () => {
  assert.equal(callBrief('x'.repeat(CALL_BRIEF_CHARS)), 'x'.repeat(CALL_BRIEF_CHARS));
  // An ordinary cut: the first CALL_BRIEF_CHARS - 1 characters, then the ellipsis.
  assert.equal(callBrief('y'.repeat(CALL_BRIEF_CHARS + 50)), `${'y'.repeat(CALL_BRIEF_CHARS - 1)}…`);
  const cut = callBrief('x'.repeat(CALL_BRIEF_CHARS - 2) + '\u{1F600}'.repeat(5));
  assert.ok(cut.length <= CALL_BRIEF_CHARS && cut.endsWith('…'));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false);
});
