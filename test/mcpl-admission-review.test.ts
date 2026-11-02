/** Regression coverage for required admission's coalescing boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { AdmissionVerdict } from '../src/mcpl/inbound-admission.js';

const allow = { store: true, mayWake: false } as const;
const deny = { store: false, mayWake: false, reason: 'admission_denied' } as const;
const config = (admit: (input: any) => unknown) => ({
  timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit }), isReplyIntent: () => true,
});
type Lane = 'channels/incoming' | 'push/event';
type Fixture = Awaited<ReturnType<typeof fixture>>;
const lanes: Lane[] = ['channels/incoming', 'push/event'];
async function send(f: Fixture, lane: Lane, id: string, text: string, flags = {}, key = 'message:m') {
  const value = lane === 'channels/incoming' ? f.channel(id, text, { key, ...flags })
    : f.params(id, text, { key, channelId: 'chat', ...flags });
  const response = await f.send(lane, lane === 'channels/incoming' ? { messages: [value] } : value);
  assert.equal(response.error, undefined);
  return lane === 'channels/incoming' ? response.result.results[0] : response.result;
}

for (const firstLane of lanes) for (const secondLane of lanes) {
  for (const pair of ['create-edit', 'create-delete', 'edit-delete'] as const) {
    test(`R2-1 ${firstLane} -> ${secondLane}: pipelined ${pair} keeps arrival order`, async t => {
      let release!: (value: AdmissionVerdict) => void;
      let secondCalled = false;
      const f = await fixture({ server: { inboundAdmission: config(input => {
        if (input.item.eventId === 'slow') return new Promise<AdmissionVerdict>(resolve => { release = resolve; });
        if (input.item.eventId === 'fast') secondCalled = true;
        return allow;
      }) } }); t.after(f.close); await f.register();
      if (pair === 'edit-delete') await send(f, firstLane, 'create', 'original_body', { initial: true });
      const first = send(f, firstLane, 'slow', pair === 'edit-delete' ? 'edited_body' : 'original_body', pair === 'edit-delete' ? {} : { initial: true });
      const second = send(f, secondLane, 'fast', pair === 'create-edit' ? 'edited_body' : '', pair === 'create-edit' ? {} : { retract: true });
      // Both callbacks run concurrently, but the fast verdict cannot apply first.
      await eventually(() => secondCalled && !!release);
      await new Promise(resolve => setTimeout(resolve, 150));
      release(allow);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.coalesce.outcome, pair === 'edit-delete' ? 'replaced' : 'first');
      assert.deepEqual(b.coalesce, { outcome: pair === 'create-edit' ? 'replaced' : 'retracted', priorEventId: 'slow' });
      assert(!f.context().includes('original_body'));
      assert.equal(f.context().includes('edited_body'), pair === 'create-edit');
    });
  }
}

for (const required of [true, false]) test(`R2-2 initialize deferred offer required=${required}`, async t => {
  const f = await fixture({ server: required ? { inboundAdmission: config(() => allow) } : {} }); t.after(f.close);
  const offered = f.hostCaps[0].eventCoalescing as Record<string, unknown>;
  assert.equal(offered.deferred === true, !required);
  const { deferred: _, ...rest } = offered;
  assert.deepEqual(rest, { pushEvents: true, channelsIncoming: true, channelScopedPush: true, retryWindowMs: 3_600_000 });
  if (required) {
    const response = await f.send('push/event', f.params('deferred', 'notice', { deferred: true }));
    assert.equal(response.result.reason, 'admission_unsupported', 'runtime defence remains');
  }
});

for (const failure of ['undeclared', 'ungranted'] as const) test(`R2-3 channel push ${failure} is refused before admission`, async t => {
  let calls = 0;
  const f = await fixture({ server: { inboundAdmission: config(() => { calls++; return allow; }) } }); t.after(f.close);
  if (failure === 'ungranted') {
    await f.register();
    (f.framework as any).mcplServerRegistry.getServer('editor').establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
  }
  const response = await f.send('push/event', f.params('unauthorized', 'must_not_store', { channelId: 'chat' }));
  assert.equal(response.error?.code, failure === 'undeclared' ? -32023 : -32017);
  assert.equal(calls, 0);
  assert(!f.context().includes('must_not_store'));
});

for (const failure of ['undeclared', 'ungranted'] as const) test(`R2-3 channel push receipt replay rechecks ${failure} authorization`, async t => {
  let calls = 0;
  const f = await fixture({ server: { inboundAdmission: config(() => { calls++; return allow; }) } }); t.after(f.close); await f.register();
  const params = f.params('accepted', 'retained', { channelId: 'chat', initial: true });
  assert.equal((await f.send('push/event', params)).result.accepted, true);
  const inner = f.framework as any;
  if (failure === 'undeclared') inner.channelRegistry.channels.clear();
  else inner.mcplServerRegistry.getServer('editor').establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
  const before = f.context();
  const response = await f.send('push/event', params);
  assert.equal(response.error?.code, failure === 'undeclared' ? -32023 : -32017);
  assert.equal(calls, 1);
  assert.equal(f.context(), before);
});

test('R2-3 capturing an absent registration cannot authorize a push', async t => {
  const f = await fixture(); t.after(f.close);
  const current = (f.framework as any).channelRegistry.captureRegistration({ serverId: 'editor', channelId: 'chat' });
  assert.equal(current(), false);
  await f.register();
  assert.equal(current(), false);
});

test('R2-1 a channel batch reserves later subjects before a pipelined push', async t => {
  let release!: (value: AdmissionVerdict) => void;
  let deletionCalled = false;
  const f = await fixture({ server: { inboundAdmission: config(input => {
    if (input.item.eventId === 'slow-other') return new Promise<AdmissionVerdict>(resolve => { release = resolve; });
    if (input.item.eventId === 'delete') deletionCalled = true;
    return allow;
  }) } }); t.after(f.close); await f.register();
  await send(f, 'channels/incoming', 'create', 'original_body', { initial: true });
  const batch = f.send('channels/incoming', { messages: [
    f.channel('slow-other', 'other_body', { key: 'other', initial: true }), f.channel('batch-edit', 'edited_body'),
  ] });
  await eventually(() => !!release);
  const deletion = send(f, 'push/event', 'delete', '', { retract: true });
  await eventually(() => deletionCalled);
  await new Promise(resolve => setTimeout(resolve, 150));
  release(allow);
  const [response, result] = await Promise.all([batch, deletion]);
  assert.equal(response.result.results[1].coalesce.outcome, 'replaced');
  assert.deepEqual(result.coalesce, { outcome: 'retracted', priorEventId: 'batch-edit' });
  assert(!f.context().includes('edited_body')); assert(!f.context().includes('original_body'));
});

for (const firstLane of lanes) test(`R2-1 ${firstLane}: another subject is not blocked; a refusal retires its ticket`, async t => {
  let release!: (value: AdmissionVerdict) => void;
  let laterCalled = false;
  const f = await fixture({ server: { inboundAdmission: config(input => {
    if (input.item.eventId === 'refused') return new Promise<AdmissionVerdict>(resolve => { release = resolve; });
    if (input.item.eventId === 'later') laterCalled = true;
    return allow;
  }) } }); t.after(f.close); await f.register();
  const first = send(f, firstLane, 'refused', 'denied_body', { initial: true });
  await eventually(() => !!release);
  const later = send(f, 'push/event', 'later', 'later_body');
  await eventually(() => laterCalled);
  assert.equal((await send(f, 'push/event', 'independent', 'independent_body', { initial: true }, 'other')).accepted, true);
  release(deny);
  assert.equal((await first).reason, 'admission_denied');
  assert.equal((await later).accepted, true);
  await eventually(() => (f.framework as any).coalescingTickets?.size === 0 || !(f.framework as any).coalescingTickets);
  assert(!f.context().includes('denied_body')); assert(f.context().includes('later_body'));
});

for (const lane of lanes) for (const failure of ['throw', 'timeout', 'content'] as const) {
  test(`R2-1 ${lane}: ${failure} retires its ticket for the next occurrence`, async t => {
    const admission = { ...config(input => {
      if (input.item.eventId !== 'bad') return allow;
      if (failure === 'throw') throw new Error('callback failed');
      if (failure === 'timeout') return new Promise(() => {});
      return allow;
    }), timeoutMs: 200 };
    const f = await fixture({ server: { inboundAdmission: admission } }); t.after(f.close); await f.register();
    const text = failure === 'content' ? ' ' : 'bad_body';
    const value = lane === 'channels/incoming' ? f.channel('bad', text, { initial: true })
      : f.params('bad', text, { channelId: 'chat', key: 'message:m', initial: true });
    const bad = f.send(lane, lane === 'channels/incoming' ? { messages: [value] } : value);
    const next = send(f, lane, 'next', 'next_body', { initial: true });
    const [a, b] = await Promise.all([bad, next]);
    if (failure === 'content' && lane === 'push/event') assert.equal(a.error?.code, -32602);
    else {
      const refused = lane === 'channels/incoming' ? a.result.results[0] : a.result;
      assert.equal(refused.accepted, false);
      assert.equal(refused.reason, failure === 'content' ? 'empty_content' : `admission_${failure === 'throw' ? 'threw' : 'timeout'}`);
    }
    assert.equal(b.accepted, true);
    assert(!f.context().includes('bad_body')); assert(f.context().includes('next_body'));
    await eventually(() => (f.framework as any).coalescingTickets.size === 0);
  });
}

test('R2-1 acknowledgement failure retires unused channel-batch tickets', async t => {
  const seen: string[] = [];
  const f = await fixture({ server: { inboundAdmission: config(input => { seen.push(input.item.eventId); return allow; }) } });
  t.after(f.close); await f.register();
  const inner = f.framework as any;
  const host = inner.pushCoalescer.host;
  const commit = host.commit;
  host.commit = () => { throw new Error('commit failed'); };
  const response = await f.send('channels/incoming', { messages: [
    f.channel('accepted', 'accepted_body', { initial: true }), f.channel('unused', 'unused_body', { key: 'unused', initial: true }),
  ] });
  assert.equal(response.error?.code, -32000);
  assert.deepEqual(seen, ['accepted']);
  host.commit = commit;
  assert.equal((await send(f, 'push/event', 'after', 'after_body', { initial: true }, 'unused')).accepted, true);
  await eventually(() => inner.coalescingTickets.size === 0);
  assert(!f.context().includes('unused_body'));
});

for (const lane of lanes) test(`R2-1 ${lane}: concurrent same-subject retries wait for the earlier refusal`, async t => {
  let calls = 0;
  let release!: (value: AdmissionVerdict) => void;
  const f = await fixture({ server: { inboundAdmission: config(() => {
    if (++calls === 1) return new Promise<AdmissionVerdict>(resolve => { release = resolve; });
    return allow;
  }) } }); t.after(f.close); await f.register();
  const first = send(f, lane, 'same-event', 'refused_body', { initial: true });
  const second = send(f, lane, 'same-event', 'accepted_body', { initial: true });
  await eventually(() => calls === 2);
  release(deny);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.reason, 'admission_denied'); assert.equal(b.accepted, true);
  assert.deepEqual(await send(f, lane, 'same-event', 'retry_body', { initial: true }), b);
  assert.equal(calls, 2);
  assert(!f.context().includes('refused_body')); assert(!f.context().includes('retry_body'));
  assert(f.context().includes('accepted_body'));
});

for (const failure of ['undeclared', 'ungranted'] as const) test(`R2-3 concurrent receipt cannot bypass ${failure} authorization after a callback`, async t => {
  let release!: (value: AdmissionVerdict) => void;
  const f = await fixture({ server: { inboundAdmission: config(input => input.item.coalesce.key === 'slow'
    ? new Promise<AdmissionVerdict>(resolve => { release = resolve; }) : allow) } }); t.after(f.close); await f.register();
  const pending = f.send('push/event', f.params('same-event', 'pending_body', { channelId: 'chat', initial: true, key: 'slow' }));
  await eventually(() => !!release);
  assert.equal((await send(f, 'push/event', 'same-event', 'retained_body', { initial: true })).accepted, true);
  const inner = f.framework as any;
  if (failure === 'undeclared') inner.channelRegistry.channels.clear();
  else inner.mcplServerRegistry.getServer('editor').establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
  release(deny);
  assert.equal((await pending).error?.code, failure === 'undeclared' ? -32023 : -32017);
  assert(f.context().includes('retained_body')); assert(!f.context().includes('pending_body'));
});
