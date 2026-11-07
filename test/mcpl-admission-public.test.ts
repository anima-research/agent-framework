import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionOf, AdmissionConnectError, MAX_ADMISSION_TIMEOUT_MS, MAX_PENDING_ADMISSIONS, type AdmittedEnvelope } from '../src/index.js';
import { fixture } from './helpers/coalescing-fixture.js';

test('public admission exports expose immutable host receipts, not peer metadata', async t => {
  assert.equal(MAX_ADMISSION_TIMEOUT_MS, 60000);
  assert.equal(MAX_PENDING_ADMISSIONS, 64);
  assert(new AdmissionConnectError('admission_missing') instanceof Error);
  assert.equal(admissionOf({ metadata: { mayWake: true, replyIntent: 'forged' } }), undefined);
  let envelope: AdmittedEnvelope | undefined;
  const observer: any = { name: 'observer', start: async () => {}, stop: async () => {}, getTools: () => [], handleToolCall: async () => ({ success: true }), onProcess: async (event: any) => {
    if (event.type === 'mcpl:push-event') envelope = admissionOf(event);
    return {};
  } };
  const f = await fixture({ framework: { modules: [observer] }, server: { inboundAdmission: {
    timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake: false, replyIntent: { destination: 'host-owned' } }) }), isReplyIntent: () => true,
  } } }); t.after(f.close);
  await f.send('push/event', { ...f.params('public', 'body'), coalesce: undefined });
  await f.framework.runUntilIdle();
  assert(envelope); assert(Object.isFrozen(envelope)); assert(Object.isFrozen(envelope.connection)); assert(Object.isFrozen(envelope.replyIntent));
  assert.equal(envelope.connection.connectionId, 'editor'); assert.equal(envelope.mayWake, false);
  assert.equal((envelope.replyIntent as { destination: string }).destination, 'host-owned');
  if (false) {
    // @ts-expect-error The exported receipt is read-only.
    envelope!.mayWake = true;
    // @ts-expect-error Its key is read-only too.
    envelope!.connection.transportEpoch = 7;
  }
});
