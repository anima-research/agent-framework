import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequiredAdmission } from '../src/mcpl/inbound-admission.js';
import { isReplyBinding, replyBindingCurrent } from '../src/mcpl/reply-routing.js';
import { withReplyConsumer, admissionRoutingFields } from '../src/mcpl/reply-admission.js';

function fixture(raw: unknown = { store: true, mayWake: true }) {
  const admission = new RequiredAdmission({ timeoutMs: 100, bind: connection => ({ connection, admit: () => raw as any }), isReplyIntent: () => true }, 'endpoint');
  admission.bind(1);
  return { admission, ingress: admission.capture(() => undefined), transport: new AbortController() };
}

test('reply admission: unset consumer is exactly the required-admission ingress object and verdict', async () => {
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

test('reply admission: a validated allow finishes required admission before resolving private work', async () => {
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

for (const outcome of ['refused', 'read-only', 'stale'] as const) test(`reply admission: ${outcome} input is not detached`, async () => {
  const x = fixture();
  let reads = 0;
  const item = new Proxy({}, { ownKeys() { reads++; throw Error('must not traverse'); } });
  const verdict = outcome === 'refused'
    ? { store: false as const, mayWake: false as const, reason: 'admission_denied' as const }
    : { store: true as const, mayWake: outcome !== 'read-only' };
  // Isolate the wrapper's traversal from the admission layer's own snapshot.
  const ingress = withReplyConsumer({ ...x.ingress, admit: async () => verdict,
    check: () => outcome === 'stale' ? 'admission_stale' : undefined,
  }, async () => { assert.fail('no route resolution'); }, x.transport.signal);
  assert.equal(await ingress.admit('channels/incoming', item), verdict);
  assert.equal(reads, 0);
});

test('reply admission: a throwing consumer retains private work and the accepted verdict', async () => {
  const x = fixture(), logs: unknown[][] = [], original = console.error;
  const consume = async () => { throw Error('private callback detail'); };
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const ingress = withReplyConsumer(x.ingress, consume, x.transport.signal);
    for (let i = 0; i < 2; i++) {
      const verdict = await ingress.admit('channels/incoming', {});
      assert.equal(verdict.store, true);
      assert.deepEqual(Reflect.ownKeys(verdict), ['store', 'mayWake']);
      const binding = admissionRoutingFields(verdict).routing;
      assert(isReplyBinding(binding)); assert.equal(binding.destination, undefined);
      assert.equal(replyBindingCurrent(binding), false);
      assert.equal((x.admission as any).pending.size, 0);
    }
    assert.equal(logs.length, 1); assert(!JSON.stringify(logs).includes('private callback detail'));
  } finally { console.error = original; }
});
