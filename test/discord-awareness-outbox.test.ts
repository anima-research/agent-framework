/**
 * The Discord awareness-mark journal: an append-only record of what was
 * asked and what was answered, kept as typed records in the Chronicle store
 * (RecordJournal), never a model of what is on Discord.
 *
 * Contract (room-225's proposed upstream change, after a field incident in
 * which a web-UI rollback queued 918 💤 reactions on other people's messages):
 * marks are an explicit publication choice (default none); one-shot, so
 * branch moves and restarts never derive operations from branch state; and
 * cancel / retract / release are explicit operator acts whose receipts say
 * what history establishes and what it leaves open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import {
  DISCORD_AWARENESS_RECORD_TYPE,
  DiscordAwarenessOutbox,
  boundDiscordAwarenessText,
  extractDiscordAwarenessRefs,
  selectDiscordAwarenessRefs,
  type DiscordAwarenessBatchView,
  type DiscordAwarenessRef,
  type DiscordAwarenessRetractView,
} from '../src/recovery/discord-awareness-outbox.js';
import { AgentFramework } from '../src/framework.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import { OperatorLog } from '../src/operator-log.js';

const ref = (messageId: string, channel = 'c1'): DiscordAwarenessRef =>
  ({ serverId: 'discord', channelId: `discord:g1:${channel}`, messageId });

interface Harness {
  store: JsStore;
  dir: string;
  legacyPath: string;
  /** A fresh instance over the same store: what a restarted process reads. */
  reopen(): DiscordAwarenessOutbox;
}

function withJournal(fn: (outbox: DiscordAwarenessOutbox, h: Harness) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const legacyPath = join(dir, 'recovery', 'discord-awareness-outbox.json');
    const h: Harness = { store, dir, legacyPath, reopen: () => new DiscordAwarenessOutbox(store, { legacyPath }) };
    try {
      await fn(h.reopen(), h);
    } finally {
      if (!store.isClosed()) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function activeBatch(outbox: DiscordAwarenessOutbox, refs: DiscordAwarenessRef[], extra: Record<string, unknown> = {}) {
  const batch = outbox.prepare({
    agentName: 'cairn',
    sourceBranch: 'main',
    targetBranch: 'rollback/cairn/1',
    refs,
    scope: 'all',
    ...extra,
  })!;
  outbox.activate(batch.id);
  return batch;
}

/** Claim and answer one dispatch for a message. */
function answer(
  outbox: DiscordAwarenessOutbox,
  messageId: string,
  outcome: 'confirmed' | 'failed' | 'not-sent' | 'unknown',
  detail: { permanent?: boolean; error?: string } = {},
) {
  const claimed = outbox.claimDispatch('discord', (d) => d.key.messageId !== messageId);
  assert.ok(claimed, `a dispatch for ${messageId} is due`);
  outbox.recordOutcome(claimed.attempts, outcome, detail);
  return claimed;
}

const batches = (outbox: DiscordAwarenessOutbox) =>
  outbox.view().filter((v): v is DiscordAwarenessBatchView => v.kind === 'batch');
const retracts = (outbox: DiscordAwarenessOutbox) =>
  outbox.view().filter((v): v is DiscordAwarenessRetractView => v.kind === 'retract');

test('extractDiscordAwarenessRefs keeps only direct Discord addressing metadata', () => {
  const refs = extractDiscordAwarenessRefs([
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'portal', channelId: 'portal:thread-1', messageId: 'p1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' } },
    { metadata: { serverId: 'discord', channelId: 'discord:g1:c1' } },
  ]);
  assert.deepEqual(refs, [ref('m1')]);
});

test('selection: none marks nothing; addressed means the chat:addressed tag; refs bind the set', () => {
  const messages = [
    { metadata: { ...ref('a1'), tags: ['chat:addressed', 'chat:mention'] } },
    { metadata: { ...ref('b1'), tags: ['chat:ambient'] } },
    { metadata: { ...ref('b2') } },
    { metadata: { ...ref('a2', 'dm'), tags: ['chat:addressed', 'chat:dm'] } },
  ];
  assert.deepEqual(selectDiscordAwarenessRefs(messages, 'none'), { refs: [], addressable: 4, unmarked: 4, notRemoved: 0 });
  const addressed = selectDiscordAwarenessRefs(messages, { scope: 'addressed' });
  assert.deepEqual(addressed.refs.map((r) => r.messageId), ['a1', 'a2']);
  assert.equal(addressed.unmarked, 2);
  assert.equal(selectDiscordAwarenessRefs(messages, { scope: 'all' }).refs.length, 4);
  // A frozen choice: only previewed refs, and never anything else removed.
  const frozen = selectDiscordAwarenessRefs(messages, { scope: 'all', refs: [ref('a1'), ref('gone')] });
  assert.deepEqual(frozen.refs.map((r) => r.messageId), ['a1']);
  assert.equal(frozen.notRemoved, 1);
  assert.equal(frozen.unmarked, 3);
  // Scope still applies to authorized refs.
  const frozenAddressed = selectDiscordAwarenessRefs(messages, { scope: 'addressed', refs: [ref('b1'), ref('a2', 'dm')] });
  assert.deepEqual(frozenAddressed.refs.map((r) => r.messageId), ['a2']);
});

test('the journal is typed records in the store: activation queues one add per ref, written ahead of dispatch', withJournal((outbox, h) => {
  const batch = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
  })!;
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'prepared work is not deliverable');
  assert.equal(outbox.activate(batch.id), 2);
  assert.ok(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length >= 2);

  const claimed = outbox.claimDispatch('discord')!;
  assert.equal(claimed.dispatch.action, 'add');
  // The write-ahead record is in the store before the request could leave:
  // a fresh reader (a restarted process) sees the attempt, outcome unknown.
  const other = h.reopen();
  const op = other.operations().find((candidate) => candidate.opId === claimed.attempts[0].opId)!;
  assert.equal(op.attempts.length, 1);
  assert.equal(other.operationStatus(op), 'unknown');

  outbox.recordOutcome(claimed.attempts, 'confirmed');
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => d.key.messageId), [claimed.dispatch.key.messageId === 'm1' ? 'm2' : 'm1']);
}));

test('startup derives nothing from ancestry: exact-target crash completion, everything else held', withJournal((outbox, h) => {
  const crashed = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all' })!;
  const elsewhere = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/2', refs: [ref('m2')], scope: 'addressed' })!;
  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m3')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  const active = activeBatch(outbox, [ref('m4')]);
  outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm4'); // dies with this request on the wire

  const restarted = h.reopen();
  const recovered = restarted.recoverAtStartup('rollback/cairn/1');
  assert.deepEqual(recovered.activated, [crashed.id]);
  assert.deepEqual(recovered.held, [elsewhere.id]);
  assert.equal(recovered.unknownAttempts, 1);
  const status = new Map(restarted.batches().map((b) => [b.id, b.status]));
  assert.equal(status.get(crashed.id), 'active');
  assert.equal(status.get(elsewhere.id), 'held');
  assert.equal(status.get(suppression.id), 'prepared', 'left for resumePreparedDiscordSuppressions');
  assert.equal(status.get(active.id), 'active');
  // The unanswered add is unknown and, still the newest for its key, retried.
  assert.deepEqual(restarted.pendingDispatches('discord').map((d) => d.key.messageId).sort(), ['m1', 'm4']);
  // A later restart on another branch changes nothing.
  assert.deepEqual(h.reopen().recoverAtStartup('main'), { activated: [], held: [suppression.id], unknownAttempts: 0 });
}));

test('a dispatch is admitted from the journal as it is now: a cancel during an in-flight request stops the rest', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  // A drain computed this list, then sent the first while holding the rest.
  const stale = outbox.pendingDispatches('discord');
  assert.equal(stale.length, 3);
  const first = outbox.recordDispatching(stale[0]);
  assert.equal(first.length, 1);
  const receipt = outbox.cancel(batch.id, 'operator');
  assert.equal(receipt.cancelled, 2);
  assert.equal(receipt.inFlight, 1);
  // The stale list can no longer authorize anything.
  assert.deepEqual(outbox.recordDispatching(stale[1]), []);
  assert.deepEqual(outbox.recordDispatching(stale[2]), []);
  outbox.recordOutcome(first, 'confirmed');
  assert.equal(outbox.claimDispatch('discord'), null);
}));

test('cancel stops every further send of a batch, never removes, and reports what may still land', withJournal((outbox, h) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3'), ref('m4')]);
  answer(outbox, 'm1', 'confirmed');
  answer(outbox, 'm2', 'unknown', { error: 'did not respond' });
  const m3 = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!; // on the wire

  const receipt = outbox.cancel(batch.id, 'operator');
  assert.deepEqual(
    { target: receipt.target, kind: receipt.kind, cancelled: receipt.cancelled, inFlight: receipt.inFlight, unknown: receipt.unknown, confirmed: receipt.confirmed, unresolvedAttempts: receipt.unresolvedAttempts },
    { target: batch.id, kind: 'batch', cancelled: 1, inFlight: 1, unknown: 1, confirmed: 1, unresolvedAttempts: 2 },
  );
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'nothing new is sent, nothing is removed');
  // The in-flight request lands after the cancel: recorded, not followed up.
  outbox.recordOutcome(m3.attempts, 'confirmed');
  assert.equal(outbox.operationStatus(outbox.operations().find((op) => op.key.messageId === 'm3')!), 'confirmed');
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  // Durable across a restart.
  const restarted = h.reopen();
  restarted.recoverAtStartup('some/other/branch');
  assert.ok(restarted.batches().find((b) => b.id === batch.id)?.cancelled);
  assert.equal(restarted.pendingDispatches('discord').length, 0);
}));

test('the cancel receipt keeps an earlier unresolved request after a later answer', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2')]);
  answer(outbox, 'm1', 'unknown', { error: 'timed out' });
  answer(outbox, 'm1', 'confirmed'); // the retry confirms
  answer(outbox, 'm2', 'unknown', { error: 'timed out' });
  answer(outbox, 'm2', 'failed', { permanent: true, error: 'Unknown Message' });
  const receipt = outbox.cancel(batch.id);
  assert.equal(receipt.confirmed, 1);
  assert.equal(receipt.unknown, 0);
  assert.equal(receipt.unresolvedAttempts, 2, 'both first attempts may still land');
}));

test('cancelling a batch its surgery has not activated stops every mark; its body can still resume', withJournal((outbox) => {
  const rollback = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all' })!;
  assert.equal(outbox.cancel(rollback.id, 'operator').cancelled, 2);
  assert.throws(() => outbox.activate(rollback.id), /cancelled before activation/);
  assert.deepEqual(outbox.recoverAtStartup('rollback/cairn/1'), { activated: [], held: [], unknownAttempts: 0 });

  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'suppress/cairn/1', refs: [ref('m3')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  outbox.cancel(suppression.id);
  assert.deepEqual(outbox.preparedSuppressionsForBranch('suppress/cairn/1').map((b) => b.id), [suppression.id]);
  outbox.recordSuppressionComplete(suppression.id);
  assert.deepEqual(outbox.preparedSuppressionsForBranch('suppress/cairn/1'), []);
  assert.equal(outbox.pendingDispatches('discord').length, 0);
}));

test('releasing a held suppression\'s marks never certifies or forgets its unfinished body', withJournal((outbox) => {
  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'partial', refs: [ref('m1')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }],
  })!;
  assert.deepEqual(outbox.recoverAtStartup('main').held, [suppression.id]);
  assert.deepEqual(outbox.preparedSuppressionsForBranch('partial').map((b) => b.id), [suppression.id]);
  const released = outbox.release(suppression.id, 'operator');
  assert.equal(released.addsQueued, 1);
  assert.equal(outbox.batches()[0].status, 'active');
  assert.equal(outbox.batches()[0].suppressionComplete, undefined);
  // Body recovery still owes the redactions on `partial`.
  assert.deepEqual(outbox.preparedSuppressionsForBranch('partial').map((b) => b.id), [suppression.id]);
}));

test('retract queues a removal for every selected key, whatever history says, and discloses unresolved requests', withJournal((outbox) => {
  const a = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  const b = activeBatch(outbox, [ref('m1')]); // another batch asked for the same reaction
  const m1 = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm1')!;
  assert.equal(m1.attempts.length, 2, "both batches' adds ride one request");
  outbox.recordOutcome(m1.attempts, 'unknown', { error: 'did not respond within 75ms' });
  answer(outbox, 'm2', 'not-sent');
  answer(outbox, 'm3', 'confirmed');

  const receipt = outbox.retract(a.id, 'operator');
  assert.equal(receipt.removalsQueued, 3, 'm2 too: history does not decide whether the act is carried out');
  assert.equal(receipt.addsSuperseded, 3, "m2's due add stops, and m1's unknown ones are no longer retried");
  assert.equal(receipt.keysWithUnresolvedAdds, 1);
  assert.equal(receipt.unresolvedAddAttempts, 1, 'one physical request carried both adds');
  assert.equal(receipt.keysWithLegacyUncertainty, 0);
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => `${d.action}:${d.key.messageId}`).sort(),
    ['remove:m1', 'remove:m2', 'remove:m3']);
  for (const id of ['m1', 'm2', 'm3']) answer(outbox, id, 'confirmed');
  const views = new Map(batches(outbox).map((v) => [v.id, v]));
  assert.equal(views.get(a.id)!.removals.confirmed, 3);
  assert.equal(views.get(b.id)!.unresolvedAttempts, 1, 'the unknown add stays unresolved history');
  const [retractView] = retracts(outbox);
  assert.equal(retractView.target, a.id);
  assert.equal(retractView.removals.confirmed, 3);
}));

test('a newer opposite request stops the retries of a retryably failed one, in both directions', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1')]);
  answer(outbox, 'm1', 'failed', { error: 'Discord 503' }); // retryable
  const receipt = outbox.retract(batch.id);
  assert.equal(receipt.addsSuperseded, 1);
  for (let i = 0; i < 3; i++) {
    const claimed = outbox.claimDispatch('discord')!;
    assert.equal(claimed.dispatch.action, 'remove');
    outbox.recordOutcome(claimed.attempts, 'failed', { error: 'Discord 503' });
  }
  const add = outbox.operations().find((op) => op.action === 'add')!;
  assert.equal(add.attempts.length, 1, 'its history stays');
  assert.equal(add.cancelled?.reason, 'superseded');
  // Mirror: a new add supersedes the retryably failing remove.
  activeBatch(outbox, [ref('m1')]);
  const next = outbox.claimDispatch('discord')!;
  assert.equal(next.dispatch.action, 'add');
  assert.equal(outbox.operations().find((op) => op.action === 'remove')!.cancelled?.reason, 'superseded');
}));

test('a newer opposite intent retires the old request\'s retries even when it was on the wire or unknown', withJournal((outbox, h) => {
  // In flight when the retract arrives, then a retryable failure: remove next.
  const a = activeBatch(outbox, [ref('m1')]);
  const onWire = outbox.claimDispatch('discord')!;
  const retract = outbox.retract(a.id);
  assert.equal(retract.addsSuperseded, 1);
  assert.equal(retract.keysWithUnresolvedAdds, 1, 'the request on the wire is disclosed');
  assert.equal(outbox.claimDispatch('discord'), null, 'the key waits for the request on the wire');
  outbox.recordOutcome(onWire.attempts, 'failed', { error: 'Discord 503' });
  assert.equal(outbox.claimDispatch('discord', () => false)!.dispatch.action, 'remove');
  // Unknown, then retract, then the retract cancelled: nothing is revived.
  const b = activeBatch(outbox, [ref('m2')]);
  answer(outbox, 'm2', 'unknown');
  const { requestId } = outbox.retract(b.id);
  outbox.cancel(requestId);
  assert.ok(!outbox.pendingDispatches('discord').some((d) => d.key.messageId === 'm2'));
  // Mirror: a remove in flight when a new add arrives, then a retryable failure.
  const c = activeBatch(outbox, [ref('m3')]);
  answer(outbox, 'm3', 'confirmed');
  outbox.retract(c.id);
  const removeOnWire = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!;
  activeBatch(outbox, [ref('m3')]);
  outbox.recordOutcome(removeOnWire.attempts, 'failed', { error: 'Discord 503' });
  const next = outbox.claimDispatch('discord', (d) => d.key.messageId !== 'm3')!;
  assert.equal(next.dispatch.action, 'add');
  outbox.recordOutcome(next.attempts, 'confirmed');
  // All of it holds across a restart.
  const restarted = h.reopen();
  restarted.recoverAtStartup('rollback/cairn/1');
  const due = restarted.pendingDispatches('discord').map((d) => `${d.action}:${d.key.messageId}`);
  assert.ok(!due.includes('add:m1') && !due.includes('add:m2') && !due.includes('remove:m3'), due.join(','));
}));

test('a retract request can be cancelled by the id its receipt returned, even after a restart', withJournal((outbox, h) => {
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  for (const id of ['m1', 'm2', 'm3']) answer(outbox, id, 'confirmed');
  const { requestId } = outbox.retract(batch.id);
  const onWire = outbox.claimDispatch('discord')!;
  const restarted = h.reopen();
  // The retract is listed, so its id survives the original receipt.
  assert.equal(retracts(restarted)[0].id, requestId);
  const receipt = outbox.cancel(requestId, 'operator');
  assert.deepEqual(
    { kind: receipt.kind, cancelled: receipt.cancelled, inFlight: receipt.inFlight },
    { kind: 'retract', cancelled: 2, inFlight: 1 },
  );
  outbox.recordOutcome(onWire.attempts, 'confirmed');
  assert.equal(outbox.claimDispatch('discord'), null);
  assert.ok(retracts(outbox)[0].cancelled);
}));

test('a retry confirming an unknown add never erases the unresolved first attempt', withJournal((outbox) => {
  const batch = activeBatch(outbox, [ref('m1')]);
  const first = answer(outbox, 'm1', 'unknown');
  const retry = outbox.claimDispatch('discord')!;
  assert.deepEqual(retry.dispatch.opIds, first.dispatch.opIds);
  assert.equal(retry.attempts[0].attempt, 2);
  outbox.recordOutcome(retry.attempts, 'confirmed');
  assert.equal(batches(outbox)[0].unresolvedAttempts, 1);
  const receipt = outbox.retract(batch.id);
  assert.equal(receipt.unresolvedAddAttempts, 1);
}));

test('release queues a held batch\'s recorded operations, explicitly', withJournal((outbox) => {
  const batch = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/9', refs: [ref('m1'), ref('m2')], scope: 'addressed' })!;
  outbox.recoverAtStartup('main');
  assert.equal(outbox.batches()[0].status, 'held');
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  const receipt = outbox.release(batch.id, 'operator');
  assert.deepEqual({ adds: receipt.addsQueued, removals: receipt.removalsQueued }, { adds: 2, removals: 0 });
  assert.equal(outbox.pendingDispatches('discord').length, 2);
  assert.throws(() => outbox.release(batch.id), /not held/);
}));

test('settleActivation says what the journal will do when activation cannot be recorded', withJournal((outbox) => {
  const ok = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'b1', refs: [ref('m1')], scope: 'all' })!;
  assert.deepEqual(outbox.settleActivation(ok.id), { status: 'queued', queued: 1 });
  const cancelled = outbox.prepare({ agentName: 'cairn', sourceBranch: 'main', targetBranch: 'b2', refs: [ref('m2')], scope: 'all' })!;
  outbox.cancel(cancelled.id);
  const settled = outbox.settleActivation(cancelled.id);
  assert.equal(settled.status, 'not-scheduled');
  assert.equal(outbox.batches().find((b) => b.id === cancelled.id)?.status, 'discarded');
}));

test('outside error text is bounded before it is journaled', withJournal((outbox) => {
  assert.equal(boundDiscordAwarenessText('short'), 'short');
  const huge = `${'x'.repeat(300)}${'界'.repeat(500_000)}😀tail`;
  const bounded = boundDiscordAwarenessText(huge);
  assert.ok(bounded.length <= 500, `bounded to ${bounded.length}`);
  assert.match(bounded, /chars omitted/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bounded), 'no lone surrogate');
  activeBatch(outbox, [ref('m1')]);
  answer(outbox, 'm1', 'failed', { error: huge });
  const [op] = outbox.operations();
  assert.ok((op.attempts[0].error ?? '').length <= 500);
}));

test('a corrupt journal entry stops the reader rather than being skipped', withJournal((_outbox, h) => {
  h.store.appendJson(DISCORD_AWARENESS_RECORD_TYPE, { records: 'nope' });
  assert.throws(() => h.reopen().batches(), /Corrupt Discord awareness journal entry/);
}));

test('checkpoints bound replay and reproduce the reduced state', withJournal((_outbox, h) => {
  const outbox = new DiscordAwarenessOutbox(h.store, { checkpointEvery: 8 });
  const batch = activeBatch(outbox, Array.from({ length: 5 }, (_, i) => ref(`m${i}`)));
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) {
      const claimed = outbox.claimDispatch('discord', (d) => d.key.messageId !== `m${i}`);
      if (claimed) outbox.recordOutcome(claimed.attempts, round === 2 ? 'confirmed' : 'failed', { error: 'Discord 503' });
    }
  }
  outbox.retract(batch.id);
  assert.ok(h.store.getRecordIdsByType(`${DISCORD_AWARENESS_RECORD_TYPE}/checkpoint`).length >= 2, 'checkpoints were written');
  const reread = new DiscordAwarenessOutbox(h.store, { checkpointEvery: 8 });
  assert.deepEqual(reread.view(), outbox.view());
  assert.deepEqual(reread.operations(), outbox.operations());
  assert.equal(batches(reread).find((v) => v.id === batch.id)!.adds.confirmed, 5);
  assert.equal(retracts(reread).length, 1);
}));

test('v2 import keeps what the old ledger recorded as evidence, holds pending work, and happens once', withJournal((_outbox, h) => {
  const entry = (messageId: string, fields: Record<string, unknown>) => ({ ...ref(messageId), lastAction: 'add', ...fields });
  const legacy = {
    version: 2,
    batches: [
      {
        // The household's shape: an active target-branch batch, some marks
        // applied, the rest marked permanent-failure by hand after shutdown,
        // one request interrupted on the wire.
        id: 'dd34b043', status: 'active', agentName: 'resident', sourceBranch: 'main',
        targetBranch: 'rollback/resident/1791358473307', emoji: '💤', createdAt: 1791358473400,
        activationPolicy: 'target-branch',
        refs: [
          entry('a1', { desired: true, markerPresent: true, deliveryStatus: 'applied', attempts: 1 }),
          entry('n1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 1, lastError: 'Cannot send request: connection to "discord" is closed' }),
          entry('u1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 1, lastError: 'Connection to MCPL server "discord" closed while awaiting response for tools/call (id=4)' }),
          entry('g1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 1, lastError: 'Unknown Message' }),
          entry('g3', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', attempts: 3, lastError: 'Unknown Message' }),
        ],
      },
      {
        // June's probe: a pending entry whose one attempt's outcome is unknown.
        id: 'pending-batch', status: 'active', agentName: 'resident', sourceBranch: 'main',
        targetBranch: 'rollback/resident/2', emoji: '💤', createdAt: 1791358473500,
        refs: [entry('p1', { desired: true, markerPresent: false, deliveryStatus: 'pending', attempts: 1, lastError: 'did not respond within 10000ms' })],
      },
    ],
  };
  mkdirSync(join(h.dir, 'recovery'), { recursive: true });
  writeFileSync(h.legacyPath, JSON.stringify(legacy));

  const outbox = h.reopen();
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'nothing imported is dispatched');
  assert.equal(outbox.operations().length, 0, 'no synthesized attempts');
  assert.equal(existsSync(h.legacyPath), false);
  assert.equal(existsSync(`${h.legacyPath}.migrated-v2`), true);
  const views = new Map(batches(outbox).map((v) => [v.id, v]));
  assert.deepEqual(views.get('dd34b043')!.legacy, {
    entries: 5,
    lastAddConfirmed: 1,
    lastRemoveConfirmed: 0,
    // u1: its one outcome unrecorded; g3: two earlier attempts unrecorded.
    outcomesUnrecorded: 3,
  });
  assert.equal(views.get('pending-batch')!.status, 'held');
  assert.equal(views.get('pending-batch')!.held!.releaseActions, 1);

  // Retract carries out the act for every ref and discloses what history leaves open.
  const receipt = outbox.retract('dd34b043', 'operator');
  assert.equal(receipt.removalsQueued, 5);
  assert.equal(receipt.unresolvedAddAttempts, 0, 'no physical request of this journal');
  assert.equal(receipt.keysWithLegacyUncertainty, 2, 'u1 and g3');
  const probe = outbox.retract('pending-batch');
  assert.equal(probe.removalsQueued, 1);
  assert.equal(probe.keysWithLegacyUncertainty, 1);
  assert.equal(outbox.cancel('pending-batch').legacyOutcomesUnrecorded, 1);

  // A crash between the import and the rename: the hash is recorded, so the
  // file is only renamed, never imported twice.
  writeFileSync(h.legacyPath, JSON.stringify(legacy));
  const again = h.reopen();
  assert.equal(again.batches().filter((b) => b.id === 'dd34b043').length, 1);
  assert.equal(batches(again).find((v) => v.id === 'dd34b043')!.legacy!.entries, 5);
  assert.equal(existsSync(h.legacyPath), false);
}));

// ---------------------------------------------------------------------------
// Framework seams, with stubbed collaborators
// ---------------------------------------------------------------------------

function storeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-fw-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  return {
    dir,
    store,
    outbox: new DiscordAwarenessOutbox(store),
    cleanup: () => { if (!store.isClosed()) store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function muted<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('framework drain classifies outcomes from what reached the server', async () => {
  const h = storeHarness();
  try {
    activeBatch(h.outbox, [ref('m1'), ref('m2'), ref('m3'), ref('m4'), ref('m5')]);
    const calls: string[] = [];
    let connected = true;
    const connection = {
      get isConnected() { return connected; },
      sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${args.messageId}`);
        if (args.messageId === 'm2') return { isError: true, content: [{ type: 'text', text: 'Unknown Message' }] };
        if (args.messageId === 'm3') throw new McplRequestError('Cannot send request: connection to "discord" is closed', 'not-sent');
        if (args.messageId === 'm4') throw new McplRequestError('did not respond', 'no-response');
        return { content: [{ type: 'text', text: 'Reaction applied' }] };
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: () => connection };
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls.sort(), ['add_reaction:m1', 'add_reaction:m2', 'add_reaction:m3', 'add_reaction:m4', 'add_reaction:m5']);
    const status = new Map(h.outbox.operations().map((op) => [op.key.messageId, h.outbox.operationStatus(op)]));
    assert.equal(status.get('m1'), 'confirmed');
    assert.equal(status.get('m2'), 'failed', 'Discord said the message is gone: final');
    assert.equal(status.get('m3'), 'requested', 'never written: still queued');
    assert.equal(status.get('m4'), 'unknown', 'written, no answer: unknown');

    // A disconnected route leaves its work queued without writing anything.
    connected = false;
    const records = h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length;
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.equal(h.store.getRecordIdsByType(DISCORD_AWARENESS_RECORD_TYPE).length, records);

    // Back online: the unsent and the unknown (newest for their keys) go again.
    connected = true;
    calls.length = 0;
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls.sort(), ['add_reaction:m3', 'add_reaction:m4']);
  } finally {
    h.cleanup();
  }
});

test('a drain whose route goes away stops claiming: the rest stays queued, with no attempts written', async () => {
  const h = storeHarness();
  try {
    activeBatch(h.outbox, [ref('m1'), ref('m2'), ref('m3')]);
    let connected = true;
    const calls: string[] = [];
    const connection = {
      get isConnected() { return connected; },
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        calls.push(String(args.messageId));
        connected = false; // the host is shutting down
        throw new McplRequestError('Connection to MCPL server "discord" closed while awaiting response', 'no-response');
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: () => connection };
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.equal(calls.length, 1);
    const attempts = h.outbox.operations().reduce((sum, op) => sum + op.attempts.length, 0);
    assert.equal(attempts, 1, 'only the request that was on the wire');
    assert.equal(h.outbox.pendingDispatches('discord').length, 3, 'its unknown and the two unsent stay due');
  } finally {
    h.cleanup();
  }
});

test('framework resumes an interrupted suppression before activating its marks', async () => {
  const h = storeHarness();
  try {
    const batch = h.outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'recovery/cairn/suppressed', activationPolicy: 'explicit',
      suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }, { fromId: 'i3', toId: 'i3' }], refs: [ref('m1')], scope: 'all',
    })!;
    const present = new Set(['i1', 'i2']); // i3 interval committed before crash.
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => { present.delete(from); present.delete(to); removals.push(`${from}..${to}`); },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = h.outbox;
    framework.store = { currentBranch: () => ({ name: 'recovery/cairn/suppressed' }) };
    framework.agents = new Map([['cairn', { getContextManager: () => cm }]]);
    await muted(() => framework.resumePreparedDiscordSuppressions());
    assert.deepEqual(removals, ['i1..i2']);
    assert.equal(h.outbox.batches().find((candidate) => candidate.id === batch.id)?.status, 'active');
    assert.deepEqual(h.outbox.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
  } finally {
    h.cleanup();
  }
});

/** A framework stub whose agent context is a plain list (ids i0..), for host/command. */
function hostCommandFramework(h: ReturnType<typeof storeHarness>, messages: Array<{ id: string; metadata: Record<string, unknown> }>) {
  let currentBranch = 'main';
  const removed = new Set<string>();
  const live = () => messages.filter((m) => !removed.has(m.id));
  const contextManager = {
    getAllMessages: () => live(),
    getMessageCount: () => live().length,
    getMessageWindow: (offset: number, limit: number) => ({
      messages: live().slice(offset, offset + limit),
      startIndex: offset,
      totalCount: live().length,
    }),
    branchAt: (_id: string, name: string) => name,
    switchBranch: async (name: string) => { currentBranch = name; },
    removeMessage: (id: string) => { removed.add(id); },
    removeMessages: (from: string, to: string) => {
      const ids = messages.map((m) => m.id);
      for (const id of ids.slice(ids.indexOf(from), ids.indexOf(to) + 1)) removed.add(id);
    },
  };
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.agents = new Map([['cairn', { state: { status: 'idle' }, getContextManager: () => contextManager }]]);
  framework.store = { currentBranch: () => ({ name: currentBranch }), sync: () => h.store.sync() };
  framework.discordAwarenessOutbox = h.outbox;
  framework.discordAwarenessEmoji = '🫥';
  framework.discordAwarenessDrains = new Map();
  framework.mcplServerRegistry = null;
  framework.moduleRegistry = { getModule: () => null };
  framework.lastVisiblePreview = async () => null;
  framework.activeTurnTokens = new Map();
  framework.nextTurnToken = 1;
  framework.deferredMessages = [];
  framework.pendingAssistantBlocks = new Map();
  framework.operatorLog = new OperatorLog(undefined);
  framework.opsAlert = () => {};
  return { framework, removed, setBranch: (name: string) => { currentBranch = name; } };
}

test('message-granular host/command undo places no marks unless asked; the marks verb reaches the controls', async () => {
  const h = storeHarness();
  try {
    const { framework, setBranch } = hostCommandFramework(h, [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ]);
    await muted(async () => {
      const silent = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1 });
      assert.equal(silent.ok, true);
      assert.deepEqual(silent.markers, { scope: 'none', unmarked: 1, notRemoved: 0, status: 'none', queued: 0 });
      assert.equal(h.outbox.pendingDispatches('discord').length, 0);

      setBranch('main');
      const marked = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 3, marks: 'addressed' });
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      assert.equal(marked.markers.unmarked, 2);
      assert.deepEqual(h.outbox.pendingDispatches('discord').map((d) => `${d.key.messageId}${d.key.emoji}`), ['m1🫥']);

      const typo = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1, marks: 'adressed' });
      assert.equal(typo.ok, false);
      assert.match(typo.error, /marks must be none, addressed or all/);

      const listed = await framework.handleHostCommand('discord', { command: 'marks', action: 'list' });
      assert.equal(listed.ok, true);
      const batch = listed.awareness.find((v: { kind: string }) => v.kind === 'batch');
      const cancelled = await framework.handleHostCommand('discord', { command: 'marks', action: 'cancel', target: batch.id, requesterName: 'op' });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.awareness.cancelled, 1);
      assert.equal(h.outbox.pendingDispatches('discord').length, 0);
      const missing = await framework.handleHostCommand('discord', { command: 'marks', action: 'retract' });
      assert.equal(missing.ok, false);
    });
  } finally {
    h.cleanup();
  }
});

test('turn-based host/command undo honours the marks choice for the messages its turns removed', async () => {
  const h = storeHarness();
  try {
    const messages = [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } }, // arrived during the turn
      { id: 'i2', metadata: {} },                                          // the agent's reply
    ];
    const { framework, removed } = hostCommandFramework(h, messages);
    let turns = 1;
    framework.undoLastTurn = () => {
      if (turns === 0) return { undone: false };
      turns--;
      removed.add('i1');
      removed.add('i2');
      return { undone: true };
    };
    await muted(async () => {
      const result = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', turns: 2, marks: 'addressed' });
      assert.equal(result.ok, true);
      assert.equal(result.undone, 1);
      assert.equal(result.markers.status, 'queued');
      assert.equal(result.markers.queued, 1);
      assert.deepEqual(h.outbox.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
    });
  } finally {
    h.cleanup();
  }
});

test('host/command hide takes the store reservation and marks only on request, through the journal', async () => {
  const h = storeHarness();
  try {
    const { framework } = hostCommandFramework(h, [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { channelId: 'discord:g1:c1', messageId: 'm1', tags: ['chat:addressed'] } }, // pre-serverId record
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ]);
    await muted(async () => {
      // Another agent sharing the store is mid-turn: hide refuses, removes nothing.
      framework.activeTurnTokens.set('other', 99);
      const busy = await framework.handleHostCommand('discord', { command: 'hide', agentName: 'cairn', fromMessageId: 'm3' });
      assert.equal(busy.ok, false);
      assert.equal(busy.code, 'agent-busy');
      framework.activeTurnTokens.delete('other');

      const silent = await framework.handleHostCommand('discord', { command: 'hide', agentName: 'cairn', fromMessageId: 'm3' });
      assert.equal(silent.ok, true);
      assert.equal(silent.markers.status, 'none');
      assert.equal(silent.markers.unmarked, 1);
      assert.equal(h.outbox.batches().length, 0);
      assert.equal(framework.surgeryHold, null, 'the reservation was released');

      const marked = await framework.handleHostCommand('discord', {
        command: 'hide', agentName: 'cairn', fromMessageId: 'm1', toMessageId: 'm2', marks: 'addressed',
      });
      assert.equal(marked.hidden, 2);
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      const [dispatch] = h.outbox.pendingDispatches('discord');
      assert.deepEqual(dispatch.key, { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1', emoji: '🫥' });
      assert.deepEqual(new DiscordAwarenessOutbox(h.store).recoverAtStartup('main'), { activated: [], held: [], unknownAttempts: 0 });
    });
  } finally {
    h.cleanup();
  }
});
