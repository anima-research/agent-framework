/** Required admission exercises the real WebSocket -> framework -> registry path. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TS } from './helpers/coalescing-fixture.js';

const denied = { store: false, mayWake: false, reason: 'admission_denied' };
const cases: Array<[string, () => unknown, string]> = [
  ['denial', () => denied, 'admission_denied'],
  ['throw', () => { throw new Error('private detail'); }, 'admission_threw'],
  ['reject', () => Promise.reject(new Error('private detail')), 'admission_threw'],
  ['timeout', () => new Promise(() => {}), 'admission_timeout'],
  ['null', () => null, 'admission_invalid'],
  ['missing', () => undefined, 'admission_invalid'],
  ['nonboolean', () => ({ store: true, mayWake: 1 }), 'admission_invalid'],
  ['contradiction', () => ({ store: false, mayWake: true, reason: 'admission_denied' }), 'admission_invalid'],
  ['unknown reason', () => ({ ...denied, reason: 'private detail' }), 'admission_invalid'],
  ['accept reason', () => ({ store: true, mayWake: true, reason: 'admission_denied' }), 'admission_invalid'],
  ['stamp not supported in A', () => ({ store: true, mayWake: true, stamp: {} }), 'admission_invalid'],
  ['accessor on optional intent', () => Object.defineProperty({ store: true, mayWake: true }, 'replyIntent', { get() { throw Error('getter executed'); }, enumerable: true }), 'admission_invalid'],
  ['non-enumerable optional intent', () => Object.defineProperty({ store: true, mayWake: true }, 'replyIntent', { value: { private: true } }), 'admission_invalid'],
  ['non-enumerable extra member', () => Object.defineProperty({ store: true, mayWake: true }, 'hidden', { value: true }), 'admission_invalid'],
  ['accessor', () => Object.defineProperty({ mayWake: true }, 'store', { get() { throw new Error('getter executed'); }, enumerable: true }), 'admission_invalid'],
];

function config(admit: (input: any) => unknown) {
  return { timeoutMs: 50, bind: (connection: unknown) => ({ connection, admit }), isReplyIntent: () => true };
}

for (const coalesced of [false, true]) for (const [name, verdict, reason] of cases) {
  test(`required channel ${coalesced ? 'coalesced' : 'ordinary'}: ${name} precedes effects`, async (t) => {
    let calls = 0;
    let gates = 0; let validators = 0;
    const f = await fixture({ server: {
      inboundAdmission: { ...config((input) => { calls++; assert.equal(input.lane, 'channels/incoming'); return verdict(); }), isReplyIntent: () => { validators++; return true; } },
      shouldTriggerInference: () => { gates++; return true; },
    } });
    t.after(f.close);
    await f.send('channels/register', { channels: [{ id: 'room/one', type: 'synthetic', label: 'Room' }] });
    const before = f.context();
    const message = { ...f.channel('e1', 'never_store_this', { initial: true }, 'room/one', 'm1'), ...(!coalesced ? { coalesce: undefined } : {}) };
    const response = await f.send('channels/incoming', { messages: [message] });
    assert.deepEqual(response.result, { results: [{ messageId: 'm1', accepted: false, reason: reason }] });
    assert.equal(calls, 1); assert.equal(validators, 0);
    assert.equal(gates, 0);
    await f.framework.runUntilIdle();
    assert.equal(f.context(), before);
    assert.equal(f.membrane.calls.length, 0);
    assert.equal(f.renders.length, 0);
    assert.equal(f.published.length, 0);
  });
}

test('required channel batch isolates denial, throw, timeout and subsequent allow', async (t) => {
  let index = 0;
  const answers = [() => denied, () => { throw Error('private'); }, () => new Promise(() => {}), () => ({ store: true, mayWake: false })];
  const f = await fixture({ server: { inboundAdmission: config(() => answers[index++]!()) } });
  t.after(f.close); await f.register();
  const messages = answers.map((_, i) => ({ channelId: 'chat', messageId: `m${i}`, timestamp: TS, content: [{ type: 'text', text: `item_${i}` }] }));
  const response = await f.send('channels/incoming', { messages });
  assert.deepEqual(response.result.results, [
    { messageId: 'm0', accepted: false, reason: 'admission_denied' },
    { messageId: 'm1', accepted: false, reason: 'admission_threw' },
    { messageId: 'm2', accepted: false, reason: 'admission_timeout' },
    { messageId: 'm3', accepted: true },
  ]);
  await f.framework.runUntilIdle();
  assert(f.context().includes('item_3')); assert(!f.context().includes('item_0'));
  assert.equal(f.membrane.calls.length, 0);
});
