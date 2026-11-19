import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushCoalescer, type CoalescerHost, type CoalescedOccurrence, type CoalescingChange, type CoalescingPlacement } from '../src/mcpl/push-coalescer.js';
import { journaledTable } from '../src/mcpl/coalescing-store.js';
import { JOURNALED, numbered } from './helpers/coalescing-journal.js';

const TS = '2026-09-30T00:00:00Z';
const CAP = 8;

function rig(options: { now?: () => number } = {}) {
  const unread = new Set<string>();
  const asked: string[] = [];
  const written: CoalescingChange[] = [];
  const host: CoalescerHost<null> = {
    isUnread: (p: CoalescingPlacement) => { asked.push(p.messageId!); return unread.has(p.messageId!); },
    isUnshown: () => false,
    remove: () => true,
    deliver: async (occ) => ({ agent: 'agent', messageId: `row-${occ.eventId}` }),
    wakeForBatch: async () => {}, wakeToRead: async () => {}, cancelWake: () => {},
    authorized: () => true, audience: async () => ['agent'],
    render: async () => ({ content: [{ type: 'text', text: 'rendered' }] }),
    audit: () => {}, write: (changes) => { written.push(...structuredClone(changes)); },
    ...(options.now ? { now: options.now } : {}),
  };
  const coalescer = new PushCoalescer<null>(host, { maxSubjects: CAP });
  const occurrence = (key: string, eventId: string, extra: Partial<CoalescedOccurrence<null>> = {}): CoalescedOccurrence<null> => ({
    serverId: 'chat', binding: 'chat', scope: { kind: 'channel', id: 'chat:room' }, key, eventId, timestamp: TS,
    retract: false, deferred: false, initial: true, content: [{ type: 'text', text: eventId }], event: null, ...extra,
  });
  const subjects = () => coalescer.snapshot().subjects;
  const held = (key: string) => subjects().some((s) => JSON.parse(s.subject)[4] === key);
  return { coalescer, unread, asked, occurrence, subjects, held, host, written };
}

test('with more placed and read subjects than the cap, the table is at the cap after each admission', async () => {
  const r = rig();
  for (let i = 0; i < 3 * CAP; i++) {
    await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
    assert.equal(r.subjects().length, Math.min(i + 1, CAP), `after admission ${i + 1}`);
  }
  assert.deepEqual(r.subjects().map((s) => JSON.parse(s.subject)[4]), Array.from({ length: CAP }, (_, i) => `message:${2 * CAP + i}`),
    'the subjects kept are the ones touched last');
});

test('each eviction is written, so a coalescer restored from the journal holds the subjects touched last, at the cap', async () => {
  const r = rig();
  for (let i = 0; i < 3 * CAP; i++) await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
  const restored = new PushCoalescer<null>(r.host, { maxSubjects: CAP });
  restored.restore(journaledTable(JOURNALED, numbered(r.written)));
  assert.deepEqual(restored.snapshot().subjects.map((s) => JSON.parse(s.subject)[4]), Array.from({ length: CAP }, (_, i) => `message:${2 * CAP + i}`));
});

test('a restore of a table over the cap forgets the subjects touched longest ago, asking nothing, since a restored occurrence counts as read', () => {
  const r = rig();
  const subjects = Array.from({ length: 3 * CAP }, (_, i) => ({
    subject: JSON.stringify(['chat', 'chat', 'channel', 'chat:room', `message:${i}`]), history: 'none' as const,
    occupant: { eventId: `ev-${i}`, placement: { agent: 'agent', messageId: `row-ev-${i}` } },
  }));
  r.coalescer.restore({ version: 1, receipts: [], subjects });
  assert.deepEqual(r.subjects().map((s) => JSON.parse(s.subject)[4]), Array.from({ length: CAP }, (_, i) => `message:${2 * CAP + i}`));
  assert.deepEqual(r.asked, []);
});

test('with unread subjects beyond the cap, none is evicted, and each admission asks at most one question more than it evicts', async () => {
  const r = rig();
  for (let i = 0; i < 3 * CAP; i++) {
    r.unread.add(`row-ev-${i}`);
    const before = r.subjects().length;
    const askedBefore = r.asked.length;
    await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
    const evicted = before + 1 - r.subjects().length;
    assert.equal(evicted, 0, `admission ${i + 1} evicts no unread subject`);
    assert.ok(r.asked.length - askedBefore <= evicted + 1, `admission ${i + 1} asked ${r.asked.length - askedBefore} questions`);
  }
  assert.equal(r.subjects().length, 3 * CAP);
});

test('once unread subjects beyond the cap are read, each admission evicts read subjects until the table is at the cap', async () => {
  const r = rig();
  for (let i = 0; i < 2 * CAP; i++) {
    r.unread.add(`row-ev-${i}`);
    await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
  }
  r.unread.clear();
  await r.coalescer.accept(r.occurrence('message:next', 'ev-next'));
  assert.equal(r.subjects().length, CAP);
});

test('the walk stops at the oldest unread subject, which stays, and the next admission walks on past it', async () => {
  const r = rig();
  for (let i = 0; i < CAP; i++) await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
  r.unread.add('row-ev-0');
  await r.coalescer.accept(r.occurrence('message:a', 'ev-a'));
  assert.ok(r.held('message:0'), 'the unread subject stays');
  assert.equal(r.subjects().length, CAP + 1, 'the walk stopped at the unread subject');
  await r.coalescer.accept(r.occurrence('message:b', 'ev-b'));
  assert.ok(r.held('message:0'), 'the unread subject still stays');
  assert.ok(!r.held('message:1') && !r.held('message:2'), 'the next admission evicted the read subjects after it');
  assert.equal(r.subjects().length, CAP);
});

test('an admission makes its subject the one touched last', async () => {
  const r = rig();
  for (let i = 0; i < CAP; i++) await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
  await r.coalescer.accept(r.occurrence('message:0', 'ev-0-edit', { initial: false }));
  await r.coalescer.accept(r.occurrence('message:a', 'ev-a'));
  assert.ok(r.held('message:0'), 'the subject admitted again stays');
  assert.ok(!r.held('message:1'), 'the subject touched longest ago leaves');
});

test('a subject with a pending batch is passed over, however old', async () => {
  const r = rig();
  await r.coalescer.accept(r.occurrence('notices', 'ev-notice', { deferred: true }));
  for (let i = 0; i < 2 * CAP; i++) await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
  assert.ok(r.held('notices'), 'the subject with a pending batch stays');
  assert.equal(r.subjects().length, CAP);
});

test('a later occurrence of an evicted subject is answered as one of a subject never seen', async () => {
  const r = rig();
  for (let i = 0; i < 2 * CAP; i++) await r.coalescer.accept(r.occurrence(`message:${i}`, `ev-${i}`));
  assert.ok(!r.held('message:0'), 'premise: message:0 was evicted');
  const evicted = await r.coalescer.accept(r.occurrence('message:0', 'ev-0-edit', { initial: false }));
  const never = await r.coalescer.accept(r.occurrence('message:never', 'ev-never', { initial: false }));
  assert.deepEqual(evicted, never);
});

test('a receipt older than the retry window leaves at the next admission', async () => {
  let clock = 0;
  const r = rig({ now: () => clock });
  await r.coalescer.accept(r.occurrence('message:old', 'ev-old'));
  clock = 3_600_001;
  await r.coalescer.accept(r.occurrence('message:new', 'ev-new'));
  assert.deepEqual(r.coalescer.snapshot().receipts.map(([key]) => JSON.parse(key)[2]), ['ev-new']);
});
