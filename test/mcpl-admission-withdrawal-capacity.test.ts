/** R4-1: production-path withdrawal reservations are bounded across subjects/epochs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OVERCAP_WITHDRAWAL_TICKETS } from '../src/index.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';

const allow = { store: true, mayWake: false } as const;
const deny = { store: false, mayWake: false, reason: 'admission_denied' } as const;
const admission = (admit: (input: any) => unknown = () => allow) => ({
  timeoutMs: 60000, isReplyIntent: () => true, bind: (connection: unknown) => ({ connection, admit }),
});
const allowance = MAX_OVERCAP_WITHDRAWAL_TICKETS;

test('R4-1 withdrawal allowance is exported as 16', () => {
  assert.equal(allowance, 16);
});

test('R4-1 withdrawal allowance: reviewer 200-subject batch reserves at most 64+16 tickets', async t => {
  const calls: string[] = [];
  const f = await fixture({ server: { inboundAdmission: admission(input => { calls.push(input.item.eventId); return allow; }) } });
  const inner = f.framework as any;
  let unlock!: () => void;
  const pending: Promise<any>[] = [];
  t.after(async () => { unlock?.(); await Promise.all(pending); await f.close(); });
  await f.register();
  for (let i = 0; i < 200; i++) {
    assert.equal((await f.send('channels/incoming', { messages: [f.channel(`c${i}`, `body_${i}_end`, { initial: true, key: `s${i}` }, 'chat', `m${i}`)] })).result.results[0].accepted, true);
  }
  const applied: string[] = [];
  const accepted = inner.pushCoalescer.host.accepted;
  inner.pushCoalescer.host.accepted = (occ: any) => { applied.push(occ.eventId); accepted(occ); };
  inner.coalescingAdmission = new Promise<void>(r => { unlock = r; });
  pending.push(f.send('channels/incoming', { messages: Array.from({ length: 64 }, (_, i) =>
    f.channel(`held${i}`, 'held', { initial: true, key: `held${i}` }, 'chat', `held${i}`)) }));
  await eventually(() => inner.coalescingTicketCounts.get('editor') === 64);
  const retractions = f.send('channels/incoming', { messages: Array.from({ length: 200 }, (_, i) =>
    f.channel(`d${i}`, '[deleted]', { retract: true, key: `s${i}` }, 'chat', `m${i}`)) });
  pending.push(retractions);
  await eventually(() => calls.includes('d0'));
  // The whole batch reserves before its first callback; callback budget cannot bound this.
  assert.equal(inner.coalescingTicketCounts.get('editor'), 64 + allowance);
  assert.equal(inner.coalescingWithdrawalTickets.size, allowance);
  const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
  const overflow = await f.send('channels/incoming', { messages: [f.channel('overflow', '', { retract: true, key: 's16' }, 'chat', 'm16')] });
  assert.equal(overflow.result.results[0].reason, 'admission_denied');
  assert(traces.some(e => e.messageId === 'm16' && e.reason === 'admission_withdrawal_capacity'));
  unlock(); await Promise.all(pending);
  const results = (await retractions).result.results;
  assert(results.slice(0, allowance).every((r: any) => r.accepted));
  assert(results.slice(allowance).every((r: any) => !r.accepted && r.reason === 'admission_denied'));
  assert.deepEqual(applied.filter(id => id.startsWith('d')), Array.from({ length: allowance }, (_, i) => `d${i}`));
  assert(!calls.includes('d16'), 'reservation refusal never calls policy, even after earlier tickets retire');
  for (let i = 0; i < 200; i++) assert.equal(f.context().includes(`body_${i}_end`), i >= allowance);
  await eventually(() => inner.coalescingTicketCounts.size === 0);
  assert.equal(inner.coalescingWithdrawalTickets.size, 0);
  assert.equal(inner.coalescingWithdrawalTicketCounts.size, 0);
});

for (const lane of ['channels/incoming', 'push/event'] as const) {
  test(`R4-1 withdrawal allowance ${lane}: refused create/retract, retract/create, repeated retract`, async t => {
    const calls: string[] = [];
    let refuseCreate!: () => void;
    const heldRefusal = new Promise<typeof deny>(r => { refuseCreate = () => r(deny); });
    const f = await fixture({ server: { inboundAdmission: admission(input => {
      calls.push(input.item.eventId); return input.item.eventId === 'refused-create' ? heldRefusal : allow;
    }) } });
    const inner = f.framework as any;
    const pending: Promise<any>[] = [];
    let unlock!: () => void;
    t.after(async () => { refuseCreate(); unlock?.(); await Promise.all(pending); await f.close(); });
    await f.register();
    const send = async (id: string, key: string, text: string, flags = {}) => {
      const value = lane === 'channels/incoming' ? f.channel(id, text, { key, ...flags })
        : f.params(id, text, { key, channelId: 'chat', ...flags });
      const reply = await f.send(lane, lane === 'channels/incoming' ? { messages: [value] } : value);
      return lane === 'channels/incoming' ? reply.result.results[0] : reply.result;
    };
    assert.equal((await send('live', 'live', 'old_occupant', { initial: true })).accepted, true);
    inner.coalescingAdmission = new Promise<void>(r => { unlock = r; });
    pending.push(send('refused-create', 'refused', 'never_revive', { initial: true }));
    // Other subjects fill the normal cap while the refused create still owns its ticket.
    pending.push(f.send('channels/incoming', { messages: Array.from({ length: 63 }, (_, i) =>
      f.channel(`held${i}`, 'held', { key: `held${i}`, initial: true })) }));
    await eventually(() => inner.coalescingTicketCounts.get('editor') === 64);
    const noTarget = send('after-refusal', 'refused', '', { retract: true });
    const removal = send('remove-live', 'live', '', { retract: true });
    pending.push(noTarget, removal);
    await eventually(() => calls.includes('remove-live'));
    assert.equal((await send('repeat', 'live', '', { retract: true })).reason, 'admission_denied');
    assert.equal((await send('too-early-create', 'live', 'never_store', { initial: true })).reason, 'admission_denied');
    assert.equal(inner.coalescingTicketCounts.get('editor'), 66);
    refuseCreate(); unlock(); await Promise.all(pending);
    assert.equal((await pending[0]).reason, 'admission_denied');
    assert.equal((await noTarget).accepted, true);
    assert.equal((await noTarget).coalesce.priorEventId, undefined);
    assert.equal((await removal).coalesce.outcome, 'retracted');
    assert(!f.context().includes('old_occupant')); assert(!f.context().includes('never_'));
    assert.equal((await send('later-create', 'live', 'new_occupant', { initial: true })).accepted, true);
    assert(f.context().includes('new_occupant'));
    assert(!calls.includes('repeat')); assert(!calls.includes('too-early-create'));
    await eventually(() => inner.coalescingTicketCounts.size === 0);
    assert.equal(inner.coalescingWithdrawalTicketCounts.size, 0);
  });

  test(`R4-1 withdrawal allowance ${lane}: real reconnect at bound cannot reset allowance or subject dedupe`, async t => {
    const f = await fixture({ server: { inboundAdmission: admission(), reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 } });
    const inner = f.framework as any;
    let unlock!: () => void;
    t.after(async () => { unlock?.(); await eventually(() => inner.coalescingTicketCounts.size === 0); await f.close(); });
    await f.register();
    for (let i = 0; i <= allowance; i++) {
      await f.send('channels/incoming', { messages: [f.channel(`c${i}`, `body_${i}_end`, { initial: true, key: `s${i}` })] });
    }
    inner.coalescingAdmission = new Promise<void>(r => { unlock = r; });
    // No reply promises: this transport is deliberately abandoned while effects wait.
    f.sendUnanswered('channels/incoming', { messages: Array.from({ length: 64 }, (_, i) =>
      f.channel(`held${i}`, 'held', { initial: true, key: `held${i}` })) });
    await eventually(() => inner.coalescingTicketCounts.get('editor') === 64);
    f.sendUnanswered('channels/incoming', { messages: Array.from({ length: allowance }, (_, i) =>
      f.channel(`d${i}`, '', { retract: true, key: `s${i}` })) });
    await eventually(() => inner.coalescingTicketCounts.get('editor') === 80);
    const connection = inner.mcplServerRegistry.getServer('editor');
    const epoch = connection.transportEpoch;
    f.disconnect();
    await eventually(() => connection.transportEpoch > epoch && connection.isConnected && connection.dataPlaneReady);
    await f.register();
    assert.equal(inner.coalescingTicketCounts.get('editor'), 80);
    assert.equal(inner.coalescingWithdrawalTickets.size, allowance);
    const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
    const send = async (id: string, key: string) => {
      const value = lane === 'channels/incoming' ? f.channel(id, '', { retract: true, key })
        : f.params(id, '', { retract: true, key, channelId: 'chat' });
      const reply = await f.send(lane, lane === 'channels/incoming' ? { messages: [value] } : value);
      return lane === 'channels/incoming' ? reply.result.results[0] : reply.result;
    };
    assert.equal((await send('new-epoch-overflow', 's16')).reason, 'admission_denied');
    assert(traces.some(e => e.reason === 'admission_withdrawal_capacity'));
    assert.equal((await send('new-epoch-duplicate', 's0')).reason, 'admission_denied');
    assert.equal(inner.coalescingTicketCounts.get('editor'), 80);
    unlock();
    await eventually(() => inner.coalescingTicketCounts.size === 0);
    assert.equal(inner.coalescingWithdrawalTickets.size, 0);
    assert.equal(inner.coalescingWithdrawalTicketCounts.size, 0);
    for (let i = 0; i <= allowance; i++) assert(f.context().includes(`body_${i}_end`), 'stale old-epoch retractions cannot apply');
    assert.equal((await send('retry-after-retire', 's16')).accepted, true);
    assert(!f.context().includes('body_16_end'));
  });
}
