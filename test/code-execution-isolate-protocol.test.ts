/**
 * The isolate's protocol on its own: each check that turns a child's frame into
 * a message, the frame decoder's limits, and the bounds on what a call and a
 * wake may carry.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/code-execution/isolate/frames.js';
import {
  argumentsRefusal,
  countJsonValues,
  decodeChildMessage,
  MAX_ARGUMENT_BYTES,
  MAX_ARGUMENT_VALUES,
  MAX_WAKE_PAYLOAD_BYTES,
  wakeLimitRefusal,
  wakeRefusal,
} from '../src/code-execution/isolate/protocol.js';

for (const [frame, reason] of [
  [[], /not an object/],
  [{ t: 'call', id: -1, name: 'x', args: '{}' }, /call's id/],
  [{ t: 'call', id: 1.5, name: 'x', args: '{}' }, /call's id/],
  [{ t: 'call', id: 2 ** 32, name: 'x', args: '{}' }, /call's id was not a whole number from 0 to 4294967295/],
  [{ t: 'call', id: 1, name: '', args: '{}' }, /call's name/],
  [{ t: 'call', id: 1, name: 'n'.repeat(257), args: '{}' }, /1 to 256 UTF-16 code units/],
  [{ t: 'call', id: 1, name: 'x', args: {} }, /arguments were not text/],
  [{ t: 'seen', id: 'one' }, /seen frame's id/],
  [{ t: 'seen', id: 2 ** 32 }, /seen frame's id/],
  [{ t: 'out', text: 1 }, /output frame did not hold text/],
  [{ t: 'end', how: 'finished', value: 1 }, /finished script's value/],
  [{ t: 'end', how: 'failed', error: 'no' }, /./],
  [{ t: 'end', how: 'sideways' }, /./],
  [{ t: 'whatever' }, /./],
] as const) {
  test(`a child's frame ${JSON.stringify(frame).slice(0, 60)} is no message`, () => {
    const message = decodeChildMessage(frame);
    assert.ok('invalid' in message, JSON.stringify(message));
    assert.match((message as { invalid: string }).invalid, reason);
  });
}

test('the frames a child may send decode as themselves', () => {
  assert.deepEqual(decodeChildMessage({ t: 'call', id: 4294967295, name: 'x', args: '{}' }), { t: 'call', id: 4294967295, name: 'x', args: '{}' });
  assert.deepEqual(decodeChildMessage({ t: 'seen', id: 3, unfit: true }), { t: 'seen', id: 3, unfit: true });
  assert.deepEqual(decodeChildMessage({ t: 'out', text: 'hi' }), { t: 'out', text: 'hi' });
});

test('the frame decoder takes frames across chunks, and refuses one too long, an empty one, and one cut off at the end', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ t: 'out', text: 'hello' });
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3)), [{ t: 'out', text: 'hello' }]);
  decoder.end();
  const header = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
  assert.throws(() => new FrameDecoder().push(header(MAX_FRAME_BYTES + 1)), /more than the 67108864 the protocol allows/);
  assert.throws(() => new FrameDecoder().push(header(0)), /a frame was empty/);
  const cut = new FrameDecoder();
  cut.push(Buffer.concat([header(100), Buffer.alloc(10, 0x7b)]));
  assert.throws(() => cut.end(), /the stream ended inside a frame, with 10 of its bytes read/);
  // Cut inside the header itself: one, two or three of its four bytes.
  for (const n of [1, 2, 3]) {
    const inHeader = new FrameDecoder();
    inHeader.push(frame.subarray(0, n));
    assert.throws(() => inHeader.end(), new RegExp(`the stream ended inside a frame, with ${n} of its bytes read`), `${n} header bytes`);
  }
});

test('a frame whose JSON starts with a byte-order mark is refused as not JSON', () => {
  const json = Buffer.from(JSON.stringify({ t: 'out', text: 'x' }), 'utf8');
  const body = Buffer.concat([Buffer.from([0]), Buffer.from([0xef, 0xbb, 0xbf]), json]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header, body])), /not JSON/);
});

test("a call's frame always fits, since it carries its arguments escaped, at most six bytes for each of theirs", () => {
  // A control character escapes to six bytes in a frame, the most any one byte becomes.
  assert.equal(JSON.stringify('\u0001'), '"\\u0001"');
  assert.ok(MAX_ARGUMENT_BYTES * 6 + 4096 <= MAX_FRAME_BYTES);
  // The largest arguments of the costliest characters still make a frame.
  const frame = encodeFrame({ t: 'call', id: 1, name: 'x', args: '\u0001'.repeat(MAX_ARGUMENT_BYTES) });
  assert.ok(frame.length <= MAX_FRAME_BYTES);
});

test('values are counted outside strings, and counting stops once past its limit', () => {
  assert.equal(countJsonValues('1'), 1);
  assert.equal(countJsonValues('[1,2,3]'), 4);
  // The object, the array, its two empty objects, and the string: an empty object or array holds nothing.
  assert.equal(countJsonValues('{"a":[{},{}],"b":"x,[{"}'), 5);
  assert.equal(countJsonValues('[{},[ ],{"a":[]}]'), 5);
  // 50,000 empty objects in an array in an object: 50,002 values.
  assert.equal(countJsonValues(JSON.stringify({ items: Array.from({ length: 50_000 }, () => ({})) })), 50_002);
  assert.equal(countJsonValues('"a \\" , [ {"'), 1);
  assert.equal(countJsonValues(JSON.stringify(Array.from({ length: 1000 }, () => 0)), 10), 11);
});

test("arguments past a call's bytes or values, and a wake past its payload, are refused with what to do", () => {
  assert.equal(argumentsRefusal('echo', JSON.stringify({ s: 'x'.repeat(MAX_ARGUMENT_BYTES - 20) })), null);
  const big = argumentsRefusal('echo', JSON.stringify({ s: 'x'.repeat(MAX_ARGUMENT_BYTES) }));
  assert.equal(big?.name, 'ArgumentsTooLarge');
  assert.match(big!.message, /^echo's arguments are \d+ bytes of JSON, past the 4 MiB a call can take; nothing was sent\. Send the data in parts, over several calls\.$/);
  const many = argumentsRefusal('echo', JSON.stringify(Array.from({ length: MAX_ARGUMENT_VALUES }, () => 0)));
  assert.equal(many?.name, 'ArgumentsTooLarge');
  assert.match(many!.message, /more than 100,000 values/);
  assert.equal(wakeRefusal(JSON.stringify('w'.repeat(MAX_WAKE_PAYLOAD_BYTES - 2))), null);
  const wake = wakeRefusal(JSON.stringify('w'.repeat(MAX_WAKE_PAYLOAD_BYTES)));
  assert.equal(wake?.name, 'WakeRefused');
  assert.match(wake!.message, /past the 64 KiB a wake can carry; nothing was sent/);
});

test('a decoder given a cap on values refuses a frame holding more, before parsing it', () => {
  const capped = new FrameDecoder(undefined, false, 4);
  assert.deepEqual(capped.push(encodeFrame({ t: 'out', text: 'x' })), [{ t: 'out', text: 'x' }]);
  assert.throws(() => new FrameDecoder(undefined, false, 4).push(encodeFrame({ t: 'out', text: 'x', more: [1, 2, 3] })), /a frame held more than 4 values/);
});

test('a frame pushed a byte at a time decodes, and the decoder keeps one buffer of its body, not its chunks', () => {
  const frame = encodeFrame({ t: 'out', text: 'x'.repeat(5000) });
  const decoder = new FrameDecoder();
  const internals = decoder as unknown as Record<string, unknown>;
  for (let i = 0; i < frame.length - 1; i++) assert.deepEqual(decoder.push(frame.subarray(i, i + 1)), []);
  // Short of its last byte: the body is one buffer of the length its header named.
  assert.equal((internals.body as Buffer).length, frame.length - 4);
  assert.deepEqual(decoder.push(frame.subarray(frame.length - 1)), [{ t: 'out', text: 'x'.repeat(5000) }]);
  assert.equal(internals.body, null);
  // Two frames and part of a third in one chunk.
  const two = Buffer.concat([encodeFrame({ t: 'out', text: 'a' }), encodeFrame({ t: 'out', text: 'b' }), frame.subarray(0, 7)]);
  const d2 = new FrameDecoder();
  assert.deepEqual(d2.push(two), [{ t: 'out', text: 'a' }, { t: 'out', text: 'b' }]);
  assert.deepEqual(d2.push(frame.subarray(7)), [{ t: 'out', text: 'x'.repeat(5000) }]);
});

test("a frame's values are counted before it's parsed, its UTF-8 checked before that, and each failure says which", () => {
  const raw = (text: string | Buffer) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  };
  // Not JSON at all, and past the cap: the count comes first, so no parse is tried.
  assert.throws(() => new FrameDecoder(undefined, false, 4).push(raw('[1,2,3,4,5,6,')), /a frame held more than 4 values/);
  // Within the cap, not JSON.
  assert.throws(() => new FrameDecoder(undefined, false, 4).push(raw('[1,2,')), /a frame was not JSON$/);
  // A byte that isn't UTF-8 inside a string.
  assert.throws(() => new FrameDecoder().push(raw(Buffer.concat([Buffer.from('{"t":"out","text":"'), Buffer.from([0xff]), Buffer.from('"}')]))), /a frame was not UTF-8$/);
});

test('with wakes off, the refusal says no script here can wake its agent', () => {
  assert.match(wakeLimitRefusal(0).message, /wake_agent\(\) is off on this host: its operator set maxWakesPerScript to 0, so nothing was sent, and no script here can wake its agent\./);
  assert.match(wakeLimitRefusal(3).message, /^wake limit reached: 3 per script.*A new script can wake its agent again\.$/);
});
