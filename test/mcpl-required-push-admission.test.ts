import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
const cases: Array<[string, () => unknown, string]> = [
  ['denied', () => ({ store: false, mayWake: false, reason: 'admission_denied' }), 'admission_denied'],
  ['throw', () => { throw Error('secret'); }, 'admission_threw'],
  ['timeout', () => new Promise(() => {}), 'admission_timeout'],
  ['invalid', () => ({ store: true, mayWake: 'yes' }), 'admission_invalid'],
];
for (const coalesced of [false, true]) for (const [name, verdict, reason] of cases) {
  test(`required push ${coalesced ? 'coalesced' : 'ordinary'} ${name}: before dedup and effects`, async t => {
    let allow = false; let gates = 0; let calls = 0;
    const f = await fixture({ server: {
      inboundAdmission: { timeoutMs: 50, bind: (connection: unknown) => ({ connection, admit: () => { calls++; return allow ? { store: true, mayWake: false } : verdict(); } }), isReplyIntent: () => true },
      shouldTriggerInference: () => { gates++; return true; },
    } }); t.after(f.close);
    const params = { ...f.params('one', 'push_content', { initial: true }), ...(!coalesced ? { coalesce: undefined } : {}) };
    const before = f.context();
    const response = await f.send('push/event', params);
    assert.deepEqual(response.result, { accepted: false, reason });
    assert.equal(calls, 1); assert.equal(gates, 0);
    await f.framework.runUntilIdle();
    assert.equal(f.context(), before); assert.equal(f.membrane.calls.length, 0); assert.equal(f.renders.length, 0);
    allow = true;
    assert.equal((await f.send('push/event', params)).result.accepted, true, 'refusal did not burn eventId');
    await f.framework.runUntilIdle();
    assert(f.context().includes('push_content')); assert.equal(f.membrane.calls.length, 0); assert.equal(gates, 0);
  });
}

test('required push with hints is unsupported and never invokes admission or the early tap', async t => {
  let calls = 0; let taps = 0;
  const f = await fixture({ server: { inboundAdmission: { timeoutMs: 50, bind: (connection: unknown) => ({ connection, admit: () => { calls++; return { store: true, mayWake: true }; } }), isReplyIntent: () => true } } }); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  connection.setReadTap(() => { taps++; });
  const response = await f.send('push/event', { ...f.params('hint', 'no'), hints: [] });
  assert.deepEqual(response.result, { accepted: false, reason: 'admission_unsupported' });
  assert.equal(calls, 0); assert.equal(taps, 0);
});

for (const featureSet of ['doc', 'unknown']) test(`required hinted push: feature authorization precedes unsupported hints (${featureSet})`, async t => {
  let calls = 0; let taps = 0;
  const f = await fixture({ server: { inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => { calls++; return { store: true, mayWake: true }; } }), isReplyIntent: () => true } } }); t.after(f.close);
  (f.framework as any).mcplServerRegistry.getServer('editor').setReadTap(() => { taps++; });
  const response = await f.send('push/event', { ...f.params('hints', 'never'), featureSet, hints: [] });
  if (featureSet === 'unknown') assert.equal(response.error?.code, -32003);
  else assert.deepEqual(response.result, { accepted: false, reason: 'admission_unsupported' });
  assert.equal(calls, 0); assert.equal(taps, 0);
});
