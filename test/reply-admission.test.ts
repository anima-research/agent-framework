import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequiredAdmission } from '../src/mcpl/inbound-admission.js';
import { withReplyConsumer, admissionRoutingFields } from '../src/mcpl/reply-admission.js';

function fixture(raw: unknown = { store: true, mayWake: true }) {
  const admission = new RequiredAdmission({ timeoutMs: 100, bind: connection => ({ connection, admit: () => raw as any }), isReplyIntent: () => true }, 'endpoint');
  admission.bind(1);
  return { admission, ingress: admission.capture(() => undefined), transport: new AbortController() };
}

test('reply admission: unset consumer is exactly the slice-A ingress object and verdict', async () => {
  const x = fixture({ store: true, mayWake: false, replyIntent: { opaque: 'intent' } });
  const original = await x.ingress.admit('channels/incoming', {});
  const unset = withReplyConsumer(x.ingress, undefined, x.transport.signal);
  assert.equal(unset, x.ingress);
  const result = await unset.admit('channels/incoming', {});
  assert.deepEqual(result, original);
  assert.deepEqual(Reflect.ownKeys(result), Reflect.ownKeys(original));
  assert.equal(Object.isFrozen(result), Object.isFrozen(original));
  assert.deepEqual(admissionRoutingFields(result), {});
});

test('reply admission: a validated allow finishes A before resolving private work', async () => {
  const x = fixture();
  const routing = Object.freeze({ privateWork: true });
  let calls = 0;
  const ingress = withReplyConsumer(x.ingress, async (input, verdict) => {
    calls++;
    assert.equal((x.admission as any).pending.size, 0);
    assert.equal(verdict.store, true); assert(Object.isFrozen(verdict));
    assert.equal(input.connection, x.ingress.key); assert.equal(input.lane, 'push/event');
    assert(Object.isFrozen(input.item)); assert(Object.isFrozen((input.item as any).payload));
    return { routing };
  }, x.transport.signal);
  const verdict = await ingress.admit('push/event', { payload: { value: 'content' } });
  assert.equal(calls, 1); assert.equal(verdict.store, true);
  assert.deepEqual(Reflect.ownKeys(verdict), ['store', 'mayWake']);
  assert.equal(admissionRoutingFields(verdict).routing, routing);
});

for (const raw of [{ store: false, mayWake: false, reason: 'admission_denied' }, { store: true, mayWake: false }, { store: true, mayWake: 'invalid' }]) {
  test(`reply admission: no consumer for ${JSON.stringify(raw)}`, async () => {
    const x = fixture(raw);
    const ingress = withReplyConsumer(x.ingress, async () => { assert.fail('not wakeable'); }, x.transport.signal);
    const verdict = await ingress.admit('channels/incoming', {});
    assert.equal(verdict.store, raw.mayWake === false && raw.store === true);
    assert.deepEqual(admissionRoutingFields(verdict), {});
  });
}
