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
    assert.deepEqual(response.result, { accepted: false, reason: coalesced ? 'admission_unsupported' : reason });
    assert.equal(calls, coalesced ? 0 : 1); assert.equal(gates, 0);
    await f.framework.runUntilIdle();
    assert.equal(f.context(), before); assert.equal(f.membrane.calls.length, 0); assert.equal(f.renders.length, 0);
    if (coalesced) return; // Unsupported work was never accepted or deduplicated.
    allow = true;
    assert.equal((await f.send('push/event', params)).result.accepted, true, 'refusal did not burn eventId');
    await f.framework.runUntilIdle();
    assert(f.context().includes('push_content')); assert.equal(f.membrane.calls.length, 0); assert.equal(gates, 0);
  });
}

for (const toolHints of [undefined, true, false]) test(`required connection does not offer hints even with toolHints=${toolHints}`, async t => {
  const f = await fixture({ server: { toolHints, inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake: false }) }), isReplyIntent: () => true } } }); t.after(f.close);
  assert.notEqual(f.hostCaps[0]!.toolHints, true);
  assert.equal((f.framework as any).mcplServerRegistry.getServer('editor').readTap, null);
});
