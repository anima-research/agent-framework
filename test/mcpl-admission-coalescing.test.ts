/** Required admission over the same real WebSocket transport as the RFC-006 matrix. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { admissionOf, type AdmissionVerdict } from '../src/mcpl/inbound-admission.js';

const allow = { store: true, mayWake: false } as const;
const deny = { store: false, mayWake: false, reason: 'admission_denied' } as const;
const config = (admit: (input: any) => unknown) => ({
  timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit }), isReplyIntent: () => true,
});
type Lane = 'channels/incoming' | 'push/event';
type Fixture = Awaited<ReturnType<typeof fixture>>;
const lanes: Lane[] = ['channels/incoming', 'push/event'];
function item(f: Fixture, lane: Lane, id: string, text: string, flags = {}) {
  return lane === 'channels/incoming' ? f.channel(id, text, flags)
    : f.params(id, text, { key: 'message:m', channelId: 'chat', ...flags });
}
async function send(f: Fixture, lane: Lane, id: string, text: string, flags = {}) {
  const value = item(f, lane, id, text, flags);
  const response = await f.send(lane, lane === 'channels/incoming' ? { messages: [value] } : value);
  assert.equal(response.error, undefined);
  return lane === 'channels/incoming' ? response.result.results[0] : response.result;
}

for (const createLane of lanes) for (const updateLane of lanes) {
  test(`required coalesce ${createLane} -> ${updateLane}: admitted replacement, refused update, withdrawal`, async t => {
    const seen: any[] = [];
    const envelopes: unknown[] = [];
    const observer: any = { name: 'observer', start: async () => {}, stop: async () => {}, getTools: () => [], handleToolCall: async () => ({ success: true }), onProcess: async (event: any) => {
      if (event.type.startsWith('mcpl:')) envelopes.push(admissionOf(event));
      return {};
    } };
    const f = await fixture({ framework: { modules: [observer] }, server: { inboundAdmission: config(input => {
      seen.push(input); return input.item.eventId.startsWith('refused') ? deny : allow;
    }) } }); t.after(f.close); await f.register();
    assert.equal((await send(f, createLane, 'create', 'original_body', { initial: true })).coalesce.outcome, 'first');
    assert(f.context().includes('original_body'));
    assert.deepEqual((await send(f, updateLane, 'edit', 'edited_body')).coalesce, { outcome: 'replaced', priorEventId: 'create' });
    assert(!f.context().includes('original_body')); assert(f.context().includes('edited_body'));
    assert.equal((await send(f, updateLane, 'refused', 'refused_body')).reason, 'admission_denied');
    assert(f.context().includes('edited_body')); assert(!f.context().includes('refused_body'));
    assert.equal((await send(f, updateLane, 'refused-delete', '', { retract: true })).reason, 'admission_denied');
    assert(f.context().includes('edited_body'));
    assert.equal((await send(f, updateLane, 'delete', '', { retract: true })).coalesce.outcome, 'retracted');
    assert(!f.context().includes('edited_body'));
    assert.deepEqual(seen.map(input => input.item.eventId), ['create', 'edit', 'refused', 'refused-delete', 'delete']);
    assert(seen.every(input => input.item.coalesce.key === 'message:m' && Object.isFrozen(input.item.coalesce)));
    assert(envelopes.length >= 2); assert(envelopes.every(value => value && (value as any).mayWake === false));
    await f.framework.runUntilIdle(); assert.equal(f.membrane.calls.length, 0);
  });
}

for (const lane of lanes) for (const replacement of ['edit', 'delete'] as const) {
  test(`required ${lane}: refused create cannot be revived by approved ${replacement}`, async t => {
    const seen: string[] = [];
    const f = await fixture({ server: { inboundAdmission: config(input => {
      seen.push(input.item.eventId); return input.item.eventId === 'create' ? deny : allow;
    }) } }); t.after(f.close); await f.register();
    const before = f.context();
    assert.equal((await send(f, lane, 'create', 'never_revive_this', { initial: true })).reason, 'admission_denied');
    assert.equal(f.context(), before);
    const result = await send(f, lane, replacement, replacement === 'edit' ? 'independently_admitted_edit' : '', replacement === 'delete' ? { retract: true } : {});
    assert.equal(result.accepted, true);
    assert.equal(result.coalesce.priorEventId, undefined, 'a refusal created no RFC-006 target or receipt');
    if (replacement === 'edit') assert(f.context().includes('independently_admitted_edit'));
    else assert.equal(f.context(), before, 'pure withdrawal with no target appends nothing');
    assert(!f.context().includes('never_revive_this'));
    assert.deepEqual(seen, ['create', replacement]);
    await f.framework.runUntilIdle(); assert.equal(f.membrane.calls.length, 0);
  });
}

for (const lane of lanes) for (const timing of ['callback', 'coalescer-lock'] as const) for (const change of ['epoch', 'registration'] as const) {
  test(`required ${lane}: replacement rechecks ${change} after ${timing}`, async t => {
    let release!: (value: AdmissionVerdict) => void;
    let entered = false;
    const f = await fixture({ server: { inboundAdmission: config(input => {
      if (input.item.eventId !== 'edit') return allow;
      entered = true;
      return timing === 'callback' ? new Promise<AdmissionVerdict>(resolve => { release = resolve; }) : allow;
    }) } }); t.after(f.close); await f.register();
    assert.equal((await send(f, lane, 'create', 'retained_original', { initial: true })).accepted, true);
    const inner = f.framework as any;
    let unlock!: () => void;
    let queued = false;
    let locked: Promise<unknown> | undefined;
    if (timing === 'coalescer-lock') {
      // Hold the real coalescer mutex, not admission, to expose the final effect boundary.
      locked = inner.pushCoalescer.locked(() => new Promise<void>(resolve => { unlock = resolve; }));
      await eventually(() => !!unlock);
      const accept = inner.pushCoalescer.accept.bind(inner.pushCoalescer);
      inner.pushCoalescer.accept = (...args: any[]) => { queued = true; return accept(...args); };
    }
    const pending = send(f, lane, 'edit', 'must_not_replace');
    await eventually(() => entered);
    if (timing === 'coalescer-lock') {
      await eventually(() => queued, 'the admitted replacement waiting for the coalescer mutex');
    }
    if (change === 'epoch') inner.mcplServerRegistry.getServer('editor').requiredAdmission.bind(999);
    else {
      const entries: Map<string, any> = inner.channelRegistry.channels;
      const [key, entry] = [...entries].find(([, entry]) => entry.descriptor.id === 'chat')!;
      entries.set(key, { ...entry, descriptor: { ...entry.descriptor } });
    }
    if (timing === 'callback') release(allow); else unlock();
    const result = await pending;
    await locked;
    assert.equal(result.accepted, false); assert.equal(result.reason, 'admission_stale');
    assert(f.context().includes('retained_original')); assert(!f.context().includes('must_not_replace'));
  });
}

test('required channel batch admits each coalesced item independently and keeps replacement keys', async t => {
  const seen: string[] = [];
  const f = await fixture({ server: { inboundAdmission: config(input => {
    seen.push(input.item.eventId); return input.item.eventId === 'deny' ? deny : allow;
  }) } }); t.after(f.close); await f.register();
  const response = await f.send('channels/incoming', { messages: [
    f.channel('create', 'batch_original', { initial: true }), f.channel('deny', 'batch_denied'), f.channel('edit', 'batch_latest'),
  ] });
  assert.deepEqual(response.result.results.map((result: any) => result.accepted), [true, false, true]);
  assert.deepEqual(response.result.results[2].coalesce, { outcome: 'replaced', priorEventId: 'create' });
  assert.deepEqual(seen, ['create', 'deny', 'edit']);
  assert(f.context().includes('batch_latest')); assert(!f.context().includes('batch_original')); assert(!f.context().includes('batch_denied'));
});
