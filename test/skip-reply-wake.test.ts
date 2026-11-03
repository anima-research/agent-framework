import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP_REPLY_WAKE_NO_GATE_REFUSAL,
  readSkipReplyWake,
  skipReplyNote,
  skipReplyWakeRefusal,
} from '../src/mcpl/skip-reply-wake.js';

const read = (wake: unknown) => readSkipReplyWake({ reason: 'later', wake_in_seconds: wake });

describe('readSkipReplyWake: what a skip_reply call\'s wake_in_seconds asks for', () => {
  it('absent or null asks for no wake', () => {
    assert.deepEqual(readSkipReplyWake({ reason: 'later' }), { kind: 'none' });
    assert.deepEqual(read(null), { kind: 'none' });
    assert.deepEqual(readSkipReplyWake(null), { kind: 'none' }, 'a call whose input is null');
    assert.deepEqual(readSkipReplyWake('wake'), { kind: 'none' }, 'a call whose input isn\'t an object');
  });

  it('a number from 1 is the wake, in whole seconds', () => {
    assert.deepEqual(read(60), { kind: 'wake', seconds: 60 });
    assert.deepEqual(read(1), { kind: 'wake', seconds: 1 });
    assert.deepEqual(read(1.5), { kind: 'wake', seconds: 1 });
    assert.deepEqual(read(90.7), { kind: 'wake', seconds: 90 });
  });

  it('a string that reads as a number is that number', () => {
    assert.deepEqual(read('30'), { kind: 'wake', seconds: 30 });
    assert.deepEqual(read(' 30 '), { kind: 'wake', seconds: 30 });
  });

  it('a number over 3600 waits 3600, as the schema says, Infinity included', () => {
    for (const wake of [3601, 5000, Infinity, 'Infinity', '1e400']) {
      assert.deepEqual(read(wake), { kind: 'wake', seconds: 3600 }, `wake_in_seconds: ${String(wake)}`);
    }
  });

  it('a number below 1 isn\'t a wake request, so 0 can\'t become a wake every second', () => {
    for (const wake of [0, 0.5, -5, -Infinity, '0', '-5', '0.999']) {
      assert.deepEqual(read(wake), { kind: 'invalid', value: wake }, `wake_in_seconds: ${String(wake)}`);
    }
  });

  it('anything else isn\'t a wake request, and keeps the value it got', () => {
    for (const wake of ['soon', '10 minutes', '', '   ', 'NaN', Number.NaN, true, false, [5], [], {}]) {
      assert.deepEqual(read(wake), { kind: 'invalid', value: wake }, `wake_in_seconds: ${JSON.stringify(wake)}`);
    }
  });
});

describe('skipReplyWakeRefusal: why a skip_reply call is refused, if it is', () => {
  it('a call with no wake is never refused', () => {
    assert.equal(skipReplyWakeRefusal({ kind: 'none' }, true), undefined);
    assert.equal(skipReplyWakeRefusal({ kind: 'none' }, false), undefined);
  });

  it('with an EventGate, a wake is taken and a value that isn\'t one is refused, named', () => {
    assert.equal(skipReplyWakeRefusal({ kind: 'wake', seconds: 1 }, true), undefined);
    const refusal = skipReplyWakeRefusal({ kind: 'invalid', value: 'soon' }, true);
    assert.equal(
      refusal,
      'Your turn didn\'t end, and no wake was set: wake_in_seconds takes a number of seconds from 1 to 3600, and "soon" isn\'t one. Call skip_reply with a number of seconds to come back on your own, or without wake_in_seconds to end the turn and wait for the next message.',
    );
    assert.match(skipReplyWakeRefusal({ kind: 'invalid', value: true }, true)!, /, and true isn't one\./);
    assert.match(skipReplyWakeRefusal({ kind: 'invalid', value: 0 }, true)!, /, and 0 isn't one\./);
    // JSON would write these as null, which names no value the model sent.
    assert.match(skipReplyWakeRefusal({ kind: 'invalid', value: -Infinity }, true)!, /, and -Infinity isn't one\./);
    assert.match(skipReplyWakeRefusal({ kind: 'invalid', value: Number.NaN }, true)!, /, and NaN isn't one\./);
    assert.match(skipReplyWakeRefusal({ kind: 'invalid', value: { at: 'noon' } }, true)!, /, and \{"at":"noon"\} isn't one\./);
  });

  it('names a long value by its first 80 characters, never by half a character', () => {
    const refusal = skipReplyWakeRefusal({ kind: 'invalid', value: 'x'.repeat(200) }, true)!;
    assert.match(refusal, new RegExp(`and "${'x'.repeat(79)}… isn't one`));
    // 41 emoji are 82 UTF-16 units, so 80 units would end inside the 40th.
    const emoji = skipReplyWakeRefusal({ kind: 'invalid', value: '😀'.repeat(41) }, true)!;
    assert.ok(emoji.includes(`and "${'😀'.repeat(39)}… isn't one`), emoji);
    assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('without an EventGate, any wake_in_seconds is refused: the host offers none', () => {
    assert.equal(skipReplyWakeRefusal({ kind: 'wake', seconds: 60 }, false), SKIP_REPLY_WAKE_NO_GATE_REFUSAL);
    assert.equal(skipReplyWakeRefusal({ kind: 'invalid', value: 'soon' }, false), SKIP_REPLY_WAKE_NO_GATE_REFUSAL);
  });
});

describe('skipReplyNote: what a skip_reply\'s result tells the agent', () => {
  const plain = 'Turn ended; nothing sent. Self-wake in ~900s unless something wakes you first.';

  it('a skip with no wake says only that the turn ended, even beside a heartbeat', () => {
    assert.equal(skipReplyNote(undefined), 'Turn ended; nothing sent.');
    assert.equal(skipReplyNote(undefined, { inSeconds: 300, what: 'your heartbeat (a check-in prompt, every 60 min)' }), 'Turn ended; nothing sent.');
  });

  it('a self-wake with nothing known before it names the wake', () => {
    assert.equal(skipReplyNote(900), plain);
  });

  it('a heartbeat due sooner is added, keeping the hedge: when it\'s due, and the time the self-wake would have left', () => {
    assert.equal(
      skipReplyNote(900, { inSeconds: 300, what: 'your heartbeat (a check-in prompt, every 60 min)' }),
      `${plain} Your heartbeat (a check-in prompt, every 60 min) is due sooner, in ~300s; if it wakes you, the self-wake `
        + 'is cancelled, so set it again for the ~600s left if you still want it.',
    );
    assert.equal(
      skipReplyNote(600, { inSeconds: 45, what: 'your reminder "check the CI run"' }),
      `Turn ended; nothing sent. Self-wake in ~600s unless something wakes you first. Your reminder "check the CI run" is due sooner, `
        + 'in ~45s; if it wakes you, the self-wake is cancelled, so set it again for the ~555s left if you still want it.',
    );
    assert.match(skipReplyNote(900, { inSeconds: 900, what: 'your heartbeat' }), /for the ~1s left/, 'a wake rounded to the self-wake leaves at least a second');
  });
});
