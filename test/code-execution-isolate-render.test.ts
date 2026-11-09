/** What a return of `code_execution` says to the model: the ending, the calls' record, the value and the output, each within its bound. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bounded, formatMs, glimpse, renderList, renderReturn, VALUE_CHARS } from '../src/code-execution/isolate/render.js';
import type { CallSummary } from '../src/code-execution/isolate/calls.js';
import type { ScriptListing, ScriptReturn } from '../src/code-execution/isolate/scripts.js';
import { renderOutput } from '../src/code-execution/isolate/output.js';

const noCalls: CallSummary = { made: 0, answered: 0, failed: 0, refused: 0, unsent: 0, running: 0, waiting: 0, named: [], more: {} };
const ret = (over: Partial<ScriptReturn>): ScriptReturn => ({
  scriptId: 's1-test',
  running: false,
  output: { head: '', tail: '', dropped: 0 },
  first: true,
  calls: noCalls,
  ending: { how: 'finished' },
  stopsAtTurnEnd: false,
  ...over,
});
const options = { boundMs: 30_000, lifetimeMs: 86_400_000 };

test("a call that was never sent reads as nothing done, not as refused", () => {
  const text = renderReturn(ret({ calls: { ...noCalls, made: 3, answered: 1, refused: 1, unsent: 1 } }), options);
  assert.match(text, /Its calls: 3 \(1 answered; 1 refused before it ran, so nothing was done; 1 never sent, so nothing was done\)\./);
});

test('each call whose answer the script did not see is named, as it was left', () => {
  const calls: CallSummary = {
    made: 6,
    answered: 1,
    failed: 0,
    refused: 0,
    unsent: 0,
    running: 0,
    waiting: 0,
    named: [
      { tool: 'write', args: '{"p":1}', state: 'uncertain' },
      { tool: 'slow', args: '{}', state: 'timed-out' },
      { tool: 'slow', args: '{"k":2}', state: 'timed-out-answered', answer: 'ok' },
      { tool: 'big', args: '{}', state: 'too-large' },
      { tool: 'echo', args: '{}', state: 'unseen' },
    ],
    more: {},
  };
  const text = renderReturn(ret({ calls, ending: { how: 'stopped', reason: 'agent' } }), options);
  assert.match(text, /Its calls: 6 \(1 answered; 5 whose answers it didn't see\):/);
  assert.match(text, /- still running when the script ended, so it may or may not take effect: tools\["write"\]\(\{"p":1\}\)/);
  assert.match(text, /- timed out in the script, and still running when the script ended, so it may still take effect: tools\["slow"\]\(\{\}\)/);
  assert.match(text, /- timed out in the script, and its answer came later: tools\["slow"\]\(\{"k":2\}\), answer "ok"/);
  assert.match(text, /- answered with a result the script couldn't receive, too large for its memory or nested too deep, so it got an error instead: tools\["big"\]\(\{\}\)/);
  assert.match(text, /- answered, but the script ended before it read the answer: tools\["echo"\]\(\{\}\)/);
});

test("at a yield, a too-large answer is counted as one whose answer it didn't see", () => {
  const calls: CallSummary = { ...noCalls, made: 2, running: 1, named: [{ tool: 'big', args: '{}', state: 'too-large' }] };
  const text = renderReturn(ret({ running: true, ending: null, calls }), options);
  assert.match(text, /Its calls so far: 2 \(1 still running; 1 whose answer it didn't see\)\./);
});

test('a crash says what it means for the agent, and a failure gives its stack after its line', () => {
  const crashed = renderReturn(ret({ ending: { how: 'crashed', detail: 'its process exited with code 7 before the script ended' } }), options);
  assert.match(crashed, /^Script s1-test crashed: its process exited with code 7 before the script ended\. A crash is the script's process failing, not an error its code threw: a fault in the host or its runtime, or something the script's own data asked of the runtime that it couldn't do, .*Running it again may work; if the same script crashes again, change what it does with its data or its code\.\n/);
  // The ending's stack is the script's frames alone (GuestError.stack): they follow the ending's line.
  const failed = renderReturn(ret({ ending: { how: 'failed', error: { name: 'TypeError', message: 'boom', stack: '    at anonymous (script:2:1)' } } }), options);
  assert.match(failed, /^Script s1-test failed: TypeError: boom\n    at anonymous \(script:2:1\)\nIt made no tool calls\./);
  // A message of several lines is given once, on the ending's one line.
  const multi = renderReturn(ret({ ending: { how: 'failed', error: { name: 'Error', message: 'first\nsecond', stack: '    at f (script:3:5)' } } }), options);
  assert.equal(multi.split('second').length - 1, 1, multi);
  assert.match(multi, /^Script s1-test failed: Error: first second\n    at f \(script:3:5\)\n/);
  // A message line that reads like a frame is the message's, given once, and stays on the ending's line.
  const framed = renderReturn(ret({ ending: { how: 'failed', error: { name: 'Error', message: 'first\n    at note', stack: '    at f (script:3:5)' } } }), options);
  assert.equal(framed.split('at note').length - 1, 1, framed);
  assert.match(framed, /^Script s1-test failed: Error: first {5}at note\n    at f \(script:3:5\)\n/);
  // No frames, no stack: the ending's line alone.
  const bare = renderReturn(ret({ ending: { how: 'failed', error: { name: 'InternalError', message: 'out of memory' } } }), options);
  assert.match(bare, /^Script s1-test failed: InternalError: out of memory\nIt made no tool calls\./);
  // A cut message and cut frames each keep their own marker.
  const cut = renderReturn(ret({ ending: { how: 'failed', error: { name: 'Error', message: bounded('m'.repeat(VALUE_CHARS * 2), VALUE_CHARS), stack: bounded('    at f (script:3:5)\n'.repeat(1_000), VALUE_CHARS) } } }), options);
  assert.equal(cut.split('characters dropped here').length - 1, 2, cut.slice(0, 200));
  assert.match(cut, /\n {4}at f \(script:3:5\)\n/);
});

test("a return shows the value as the run kept it, and a listing cuts a failure's message to 300 characters", () => {
  const kept = bounded('v'.repeat(VALUE_CHARS * 2), VALUE_CHARS);
  const text = renderReturn(ret({ ending: { how: 'finished', value: kept } }), options);
  assert.ok(text.includes(`It returned: ${kept}`));
  assert.match(text, /\[… 8000 characters dropped here …\]/);
  const listed = renderList(
    [{ scriptId: 's2-test', running: false, ending: { how: 'failed', error: { name: 'Error', message: 'm'.repeat(1000) } }, startedAt: Date.now(), endedAt: Date.now(), wakes: 0 }],
    Date.now(),
  );
  const line = listed.split('\n').find((l) => l.startsWith('- s2-test'))!;
  assert.ok(line.length < 400, `the listed line is ${line.length} characters`);
  // A glimpse of its start, with no count: the message may be one the run cut already, whose count a second cut would misstate.
  assert.match(line, /m{300}…/);
  assert.doesNotMatch(line, /dropped here/);
});

test('a cut never parts a surrogate pair, at the head or the tail', () => {
  const pair = '\u{1F600}';
  // The head's last unit would be a pair's first half, and the tail's first a pair's second half.
  const text = 'a'.repeat(3) + pair + 'b'.repeat(20) + pair + 'c'.repeat(3);
  const cut = bounded(text, 8);
  const [head, tail] = cut.split(/\n\[… \d+ characters dropped here …\]\n/);
  assert.equal(/[\uD800-\uDBFF]$/.test(head!), false, `head ${JSON.stringify(head)}`);
  assert.equal(/^[\uDC00-\uDFFF]/.test(tail!), false, `tail ${JSON.stringify(tail)}`);
  const dropped = Number(/\[… (\d+) characters dropped here …\]/.exec(cut)![1]);
  assert.equal(head!.length + dropped + tail!.length, text.length);
});

test("a glimpse is a text's start and an ellipsis, never parting a surrogate pair, and never a count", () => {
  assert.equal(glimpse('short', 300), 'short');
  assert.equal(glimpse('x'.repeat(400), 300), `${'x'.repeat(300)}…`);
  // A pair across the cut is left out whole.
  const pair = `${'a'.repeat(299)}😀b`;
  assert.equal(glimpse(pair, 300), `${'a'.repeat(299)}…`);
  assert.doesNotMatch(glimpse('m'.repeat(20_000), 300), /dropped here/);
});

test('durations are said exactly, a fraction of a second included', () => {
  assert.equal(formatMs(1_500), '1.5 s');
  assert.equal(formatMs(300), '300 ms');
  assert.equal(formatMs(120_000), '2 min');
  assert.equal(formatMs(86_400_000), '24 h');
});

test('durations at their sites are said exactly: a yield, a lifetime', () => {
  const running = renderReturn(ret({ running: true, ending: null }), { boundMs: 1_500, lifetimeMs: 86_400_000 });
  assert.match(running, /is still running after 1\.5 s\./);
  const limit = renderReturn(ret({ ending: { how: 'stopped', reason: 'limit' } }), { boundMs: 30_000, lifetimeMs: 1_500 });
  assert.match(limit, /was stopped at its limit of 1\.5 s\./);
});

test("a script's ending reads on one line in a wait's and a list's result, a stop's reason cut as a failure's message is", () => {
  const LINE_BREAK = /[\r\n\u000b\u000c\u0085\u2028\u2029]/;
  const why = `its turn ended before the script returned (rate\nlimited ${'x'.repeat(400)})`;
  const stopped = renderReturn(ret({ ending: { how: 'stopped', reason: 'limit', why } }), options);
  const stoppedLine = stopped.split('\n').find((line) => line.includes('was stopped:'))!;
  const cut = `${why.slice(0, 300).replace('\n', ' ')}…`;
  assert.equal(stoppedLine, `Script s1-test was stopped: ${cut}.`);
  const failed = renderReturn(ret({ ending: { how: 'failed', error: { name: 'Bad\u2028Name', message: 'broke\nhere' } } }), options);
  assert.match(failed, /^Script s1-test failed: Bad Name: broke here$/m);
  const crashed = renderReturn(ret({ ending: { how: 'crashed', detail: 'its process exited before the script ended: first\nsecond' } }), options);
  assert.match(crashed, /^Script s1-test crashed: its process exited before the script ended: first second\. A crash/m);
  const listing = (ending: ScriptListing['ending']): string =>
    renderList([{ scriptId: 's1-test', running: false, startedAt: 0, endedAt: 0, ending, wakes: 0 }], 60_000);
  for (const text of [
    listing({ how: 'stopped', reason: 'limit', why }),
    listing({ how: 'failed', error: { name: 'Bad\u2028Name', message: 'broke\nhere' } }),
  ]) {
    assert.ok(!text.split('\n').some((line) => line.includes('ago:') && LINE_BREAK.test(line)), text);
  }
  assert.ok(listing({ how: 'stopped', reason: 'limit', why }).split('\n').includes(`- s1-test: stopped 1 min ago: ${cut}`));
  assert.match(listing({ how: 'failed', error: { name: 'Bad\u2028Name', message: 'broke\nhere' } }), /failed 1 min ago: Bad Name: broke here/);
});

test("a timed-out call's late answer is written on one line, as JSON that gives the answer back", () => {
  const answer = 'first\u2028second\u0085third';
  const calls: CallSummary = { ...noCalls, made: 1, named: [{ tool: 'slow', args: '{}', state: 'timed-out-answered', answer }] };
  const text = renderReturn(ret({ calls, ending: { how: 'finished' } }), options);
  const line = text.split('\n').find((l) => l.includes('its answer came later'))!;
  assert.ok(!/[\u0085\u2028\u2029]/.test(line), JSON.stringify(line));
  assert.equal(JSON.parse(line.slice(line.indexOf(', answer ') + ', answer '.length)), answer);
});

test('calls waiting their turn in the host are among those a yield counts', () => {
  const text = renderReturn(ret({ running: true, ending: null, calls: { ...noCalls, made: 19, running: 16, waiting: 3 } }), options);
  assert.match(text, /Its calls so far: 19 \(16 still running; 3 waiting their turn in the host\)\./);
});

test("bounded keeps both ends of a long text within its max, drops the middle with its count, and splits no surrogate pair", () => {
  // mulberry32, whose 32-bit steps lose nothing in a JavaScript number.
  let seed = 7;
  const next = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  // Surrogate pairs, so a cut falls inside one, and lone halves too, at bounds from none up.
  const alphabet = ['a', 'b', '\n', '\u{1F600}', '\u00e9', '\ud800', '\udc00'];
  for (let round = 0; round < 500; round++) {
    const max = next(41);
    const text = Array.from({ length: next(120) }, () => alphabet[next(alphabet.length)]).join('');
    const at = JSON.stringify({ max, text });
    const out = bounded(text, max);
    if (text.length <= max) {
      assert.equal(out, text, at);
      continue;
    }
    const cut = /^([\s\S]*)\n\[… (\d+) characters dropped here …\]\n([\s\S]*)$/.exec(out);
    assert.ok(cut, at);
    const [, head, dropped, tail] = cut;
    assert.ok(text.startsWith(head!) && text.endsWith(tail!), at);
    assert.equal(head!.length + Number(dropped) + tail!.length, text.length, at);
    assert.ok(head!.length + tail!.length <= max, at);
    if (max >= 4) assert.ok(head!.length > 0 && tail!.length > 0, `both ends kept: ${at}`);
    const tailStart = text.length - tail!.length;
    assert.ok(!(high(text.charCodeAt(head!.length - 1)) && low(text.charCodeAt(head!.length))), `no pair split at the head: ${at}`);
    assert.ok(!(high(text.charCodeAt(tailStart - 1)) && low(text.charCodeAt(tailStart))), `no pair split at the tail: ${at}`);
  }
});

test("a return held to its agent's inline cap gives its output the room the rest leaves, both its ends kept", () => {
  const output = { head: `H${'h'.repeat(7_999)}`, tail: `${'t'.repeat(7_999)}T`, dropped: 20_000 };
  const value = bounded(JSON.stringify('v'.repeat(20_000)), VALUE_CHARS);
  const ending = { how: 'finished' as const, value };
  assert.ok(renderReturn(ret({ output, ending }), options).length > 24_000, 'past the default cap, left to itself');
  for (const maxChars of [24_000, 12_000]) {
    const text = renderReturn(ret({ output, ending }), { ...options, maxChars });
    assert.ok(text.length <= maxChars, `${text.length} characters at a cap of ${maxChars}`);
    // The output fills the room the rest leaves, but for the slack of the count's longest line.
    assert.ok(text.length >= maxChars - 16, `${text.length} characters fill a cap of ${maxChars}`);
    assert.ok(text.includes(`It returned: ${value}\n`), 'the value stays as the run kept it');
    assert.match(text, /Its output:\nHhh/);
    assert.ok(text.endsWith('ttT'), "the output's last character is the return's last");
  }
  // A cap the rest of the return passes on its own leaves the output its count.
  const tight = renderReturn(ret({ output, ending }), { ...options, maxChars: 4_000 });
  assert.ok(tight.endsWith('Its output:\n\n[… 36000 characters of output dropped here …]\n'), tight.slice(-120));
  // A cap the rest fits, with less room than the count's line, leaves the output that line alone, past the cap.
  const uncut = renderReturn(ret({ output, ending }), options);
  const rest = uncut.length - renderOutput(output).length;
  const narrow = renderReturn(ret({ output, ending }), { ...options, maxChars: rest + 20 });
  assert.equal(narrow, `${uncut.slice(0, rest)}\n[… 36000 characters of output dropped here …]\n`);
  // With no cap, the output comes as the run kept it.
  assert.ok(renderReturn(ret({ output, ending }), options).endsWith(`[… 20000 characters of output dropped here …]\n${output.tail}`));
});

test('a return with no output says so, at its first return and after one', () => {
  assert.ok(renderReturn(ret({}), options).endsWith('\nNo output.'));
  assert.ok(renderReturn(ret({ first: false }), options).endsWith('\nNo output since the last return.'));
  // A cap takes nothing from a return that has no output.
  assert.ok(renderReturn(ret({}), { ...options, maxChars: 10 }).endsWith('\nNo output.'));
});
