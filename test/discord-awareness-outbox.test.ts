/**
 * The Discord awareness-mark journal: an append-only record of what was
 * asked and what was answered, never a model of what is on Discord.
 *
 * Contract (room-225's proposed upstream change, after a field incident in
 * which a web-UI rollback queued 918 💤 reactions on other people's messages):
 * marks are an explicit publication choice (default none); one-shot, so
 * branch moves and restarts never derive operations from branch state; and
 * cancel / retract / release are explicit operator acts whose receipts say
 * what is known and what is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DiscordAwarenessOutbox,
  extractDiscordAwarenessRefs,
  selectDiscordAwarenessRefs,
  type DiscordAwarenessRef,
} from '../src/recovery/discord-awareness-outbox.js';
import { AgentFramework } from '../src/framework.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import { OperatorLog } from '../src/operator-log.js';

const ref = (messageId: string, channel = 'c1'): DiscordAwarenessRef =>
  ({ serverId: 'discord', channelId: `discord:g1:${channel}`, messageId });

function withJournal(fn: (path: string, dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-'));
    try {
      await fn(join(dir, 'recovery', 'discord-awareness-journal.jsonl'), dir);
    } finally {
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

/** Dispatch everything due, answering each dispatch with `answer`. */
function drain(
  outbox: DiscordAwarenessOutbox,
  answer: (dispatch: { action: string; messageId: string }) => 'confirmed' | 'failed' | 'not-sent' | 'unknown',
): string[] {
  const seen: string[] = [];
  for (let pass = 0; pass < 10; pass++) {
    const dispatches = outbox.pendingDispatches('discord');
    if (dispatches.length === 0) break;
    for (const dispatch of dispatches) {
      const attempts = outbox.recordDispatching(dispatch);
      const outcome = answer({ action: dispatch.action, messageId: dispatch.key.messageId });
      seen.push(`${dispatch.action}:${dispatch.key.messageId}:${outcome}`);
      outbox.recordOutcome(attempts, outcome, outcome === 'failed' ? { permanent: true, error: 'Unknown Message' } : {});
    }
  }
  return seen;
}

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
  const none = selectDiscordAwarenessRefs(messages, 'none');
  assert.deepEqual(none, { refs: [], addressable: 4, unmarked: 4, notRemoved: 0 });

  const addressed = selectDiscordAwarenessRefs(messages, { scope: 'addressed' });
  assert.deepEqual(addressed.refs.map((r) => r.messageId), ['a1', 'a2']);
  assert.equal(addressed.unmarked, 2);

  const all = selectDiscordAwarenessRefs(messages, { scope: 'all' });
  assert.equal(all.refs.length, 4);

  // A frozen choice: only previewed refs, and never anything else removed.
  const frozen = selectDiscordAwarenessRefs(messages, { scope: 'all', refs: [ref('a1'), ref('gone')] });
  assert.deepEqual(frozen.refs.map((r) => r.messageId), ['a1']);
  assert.equal(frozen.notRemoved, 1, 'an authorized ref the surgery did not remove');
  assert.equal(frozen.unmarked, 3);

  // Scope still applies to authorized refs.
  const frozenAddressed = selectDiscordAwarenessRefs(messages, { scope: 'addressed', refs: [ref('b1'), ref('a2', 'dm')] });
  assert.deepEqual(frozenAddressed.refs.map((r) => r.messageId), ['a2']);
});

test('a prepared batch delivers nothing; activation queues one add per ref, written ahead of dispatch', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
  })!;
  assert.equal(outbox.pendingDispatches('discord').length, 0, 'prepared work is not deliverable');
  assert.equal(outbox.activate(batch.id), 2);
  const [first] = outbox.pendingDispatches('discord');
  assert.equal(first.action, 'add');
  assert.equal(first.key.emoji, '💤');

  const attempts = outbox.recordDispatching(first);
  // The write-ahead record is durable before the request could leave.
  const journal = readFileSync(path, 'utf8');
  assert.match(journal, /"t":"dispatching"/);
  // A fresh reader (another process) sees it as unknown, never as unsent.
  const other = new DiscordAwarenessOutbox(path);
  assert.equal(other.operations().find((op) => op.opId === first.opIds[0])!.attempts.length, 1);
  assert.equal(other.operationStatus(other.operations().find((op) => op.opId === first.opIds[0])!), 'unknown');

  outbox.recordOutcome(attempts, 'confirmed');
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => d.key.messageId), ['m2']);
}));

test('startup derives nothing from ancestry: exact-target crash completion, everything else held', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const crashed = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1')], scope: 'all',
  })!;
  const elsewhere = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/2', refs: [ref('m2')], scope: 'addressed',
  })!;
  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m3')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  const active = activeBatch(outbox, [ref('m4')]);
  const [dispatch] = outbox.pendingDispatches('discord').filter((d) => d.key.messageId === 'm4');
  outbox.recordDispatching(dispatch); // the process dies with this request on the wire

  const restarted = new DiscordAwarenessOutbox(path);
  const recovered = restarted.recoverAtStartup('rollback/cairn/1');
  assert.deepEqual(recovered.activated, [crashed.id]);
  assert.deepEqual(recovered.held, [elsewhere.id]);
  assert.equal(recovered.unknownAttempts, 1);
  const status = new Map(restarted.batches().map((b) => [b.id, b.status]));
  assert.equal(status.get(crashed.id), 'active');
  assert.equal(status.get(elsewhere.id), 'held');
  assert.equal(status.get(suppression.id), 'prepared', 'left for resumePreparedDiscordSuppressions');
  assert.equal(status.get(active.id), 'active');
  // The unanswered add is unknown, and as the newest op for its key it is
  // retried (idempotent); the held batch's ref is not dispatched at all.
  assert.deepEqual(
    restarted.pendingDispatches('discord').map((d) => d.key.messageId).sort(),
    ['m1', 'm4'],
  );

  // A later restart on a different branch changes nothing.
  const again = new DiscordAwarenessOutbox(path).recoverAtStartup('main');
  assert.deepEqual(again, { activated: [], held: [suppression.id], unknownAttempts: 0 });
}));

test('cancel stops every further send of a batch, never removes, and says what may still land', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3'), ref('m4')]);
  const dispatches = outbox.pendingDispatches('discord');
  const byId = new Map(dispatches.map((d) => [d.key.messageId, d]));
  outbox.recordOutcome(outbox.recordDispatching(byId.get('m1')!), 'confirmed');
  outbox.recordOutcome(outbox.recordDispatching(byId.get('m2')!), 'unknown', { error: 'did not respond' });
  const m3Attempts = outbox.recordDispatching(byId.get('m3')!); // on the wire right now

  const receipt = outbox.cancel(batch.id, 'operator');
  assert.deepEqual(
    { cancelled: receipt.cancelled, inFlight: receipt.inFlight, unknown: receipt.unknown, confirmed: receipt.confirmed },
    { cancelled: 1, inFlight: 1, unknown: 1, confirmed: 1 },
  );
  // Nothing new is sent, no removal is queued, and the unknown add is not
  // retried; the key with a request on the wire stays busy meanwhile.
  assert.equal(outbox.pendingDispatches('discord').length, 0);

  // The in-flight request lands after the cancel: that is recorded as what
  // happened, and it is still not followed by anything.
  outbox.recordOutcome(m3Attempts, 'confirmed');
  const m3 = outbox.operations().find((op) => op.key.messageId === 'm3')!;
  assert.equal(outbox.operationStatus(m3), 'confirmed');
  assert.equal(outbox.pendingDispatches('discord').length, 0);

  // Cancellation is durable: a restart or a branch move re-arms nothing.
  const restarted = new DiscordAwarenessOutbox(path);
  restarted.recoverAtStartup('some/other/branch');
  assert.ok(restarted.batches().find((b) => b.id === batch.id)?.cancelled);
  assert.equal(restarted.pendingDispatches('discord').length, 0);
  // Retract still reaches what may have landed: m1, m2 (unknown) and m3.
  const retracted = restarted.retract(batch.id);
  assert.equal(retracted.removalsQueued, 3);
  assert.equal(retracted.keysWithUnresolvedAdds, 1);
}));

test('cancelling a batch whose surgery has not activated it stops every mark, and its body can still resume', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const rollback = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
  })!;
  const receipt = outbox.cancel(rollback.id, 'operator');
  assert.equal(receipt.cancelled, 2);
  assert.throws(() => outbox.activate(rollback.id), /cancelled before activation/);
  // Not activated by startup's crash completion, and not held either.
  assert.deepEqual(outbox.recoverAtStartup('rollback/cairn/1'), { activated: [], held: [], unknownAttempts: 0 });
  assert.equal(outbox.pendingDispatches('discord').length, 0);

  const suppression = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'suppress/cairn/1', refs: [ref('m3')], scope: 'all',
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i1' }],
  })!;
  outbox.cancel(suppression.id);
  // The suppression's body still resumes on its branch; its marks never go.
  assert.deepEqual(outbox.preparedSuppressionsForBranch('suppress/cairn/1').map((b) => b.id), [suppression.id]);
  outbox.recordSuppressionComplete(suppression.id);
  assert.deepEqual(outbox.preparedSuppressionsForBranch('suppress/cairn/1'), []);
  assert.equal(outbox.pendingDispatches('discord').length, 0);
}));

test('retract removes this bot\'s mark across batches, supersedes unsent adds, and discloses unresolved attempts', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const a = activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  const b = activeBatch(outbox, [ref('m1')]); // another batch asked for the same reaction
  // m1's adds share one dispatch (same key, same action, both requested).
  const m1 = outbox.pendingDispatches('discord').find((d) => d.key.messageId === 'm1')!;
  assert.equal(m1.opIds.length, 2);
  const m1Attempts = outbox.recordDispatching(m1);
  outbox.recordOutcome(m1Attempts, 'unknown', { error: 'did not respond within 75ms' });
  // m2's add never left the host; m3's was confirmed.
  const m2 = outbox.pendingDispatches('discord').find((d) => d.key.messageId === 'm2')!;
  outbox.recordOutcome(outbox.recordDispatching(m2), 'not-sent');
  const m3 = outbox.pendingDispatches('discord').find((d) => d.key.messageId === 'm3')!;
  outbox.recordOutcome(outbox.recordDispatching(m3), 'confirmed');

  const receipt = outbox.retract(a.id, 'operator');
  // m1 and m3 had adds leave the host; m2's never did, so nothing to remove.
  assert.equal(receipt.removalsQueued, 2);
  assert.equal(receipt.addsSuperseded, 1, "m2's unsent add is superseded");
  assert.equal(receipt.keysWithUnresolvedAdds, 1, 'm1: a timed-out add may land after the removal');
  assert.equal(receipt.unresolvedAddAttempts, 1, "one request carried both batches' adds");

  const dispatches = outbox.pendingDispatches('discord');
  assert.deepEqual(dispatches.map((d) => `${d.action}:${d.key.messageId}`).sort(), ['remove:m1', 'remove:m3']);

  // The removal is confirmed, and the earlier unknown add stays unresolved:
  // a confirmation of a different request never resolves it.
  drain(outbox, () => 'confirmed');
  const views = new Map(outbox.view().map((v) => [v.id, v]));
  assert.equal(views.get(a.id)!.adds.unknown, 1);
  assert.equal(views.get(a.id)!.removals.confirmed, 2);
  assert.equal(views.get(b.id)!.unresolvedAttempts, 1);
}));

test('a retry confirming an unknown add never erases the unresolved first attempt', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = activeBatch(outbox, [ref('m1')]);
  const first = outbox.pendingDispatches('discord')[0];
  outbox.recordOutcome(outbox.recordDispatching(first), 'unknown');
  // Still the newest op for its key: retried (idempotent), as attempt 2.
  const retry = outbox.pendingDispatches('discord')[0];
  assert.deepEqual(retry.opIds, first.opIds);
  const retryAttempts = outbox.recordDispatching(retry);
  assert.equal(retryAttempts[0].attempt, 2);
  outbox.recordOutcome(retryAttempts, 'confirmed');
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  assert.equal(outbox.view()[0].unresolvedAttempts, 1, 'attempt 1 is still unknown');

  const receipt = outbox.retract(batch.id);
  assert.equal(receipt.keysWithUnresolvedAdds, 1);
  assert.equal(receipt.unresolvedAddAttempts, 1);
}));

test('a new request reaches Discord even when an earlier one got the same answer', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const first = activeBatch(outbox, [ref('m1')]);
  drain(outbox, () => 'confirmed');
  outbox.retract(first.id);
  drain(outbox, () => 'confirmed');
  // Someone else's tool may have reacted again since; a fresh, explicit
  // placement is sent rather than skipped on the strength of old receipts.
  activeBatch(outbox, [ref('m1')]);
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => d.action), ['add']);
}));

test('retract supersedes an add that never left the host instead of churning the reaction', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = activeBatch(outbox, [ref('m2'), ref('m3')]);
  // m3's add was sent and confirmed; m2's has not been sent yet.
  const m3 = outbox.pendingDispatches('discord').find((d) => d.key.messageId === 'm3')!;
  outbox.recordOutcome(outbox.recordDispatching(m3), 'confirmed');
  const receipt = outbox.retract(batch.id);
  assert.equal(receipt.addsSuperseded, 1);
  assert.equal(receipt.removalsQueued, 1, 'nothing was ever sent for m2, so there is nothing to remove');
  assert.deepEqual(outbox.pendingDispatches('discord').map((d) => `${d.action}:${d.key.messageId}`), ['remove:m3']);
  const m2 = outbox.operations().find((op) => op.key.messageId === 'm2')!;
  assert.equal(m2.cancelled?.reason, 'superseded');
}));

test('release queues a held batch\'s recorded operations, explicitly', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/9', refs: [ref('m1'), ref('m2')], scope: 'addressed',
  })!;
  outbox.recoverAtStartup('main');
  assert.equal(outbox.batches()[0].status, 'held');
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  const receipt = outbox.release(batch.id, 'operator');
  assert.deepEqual({ adds: receipt.addsQueued, removals: receipt.removalsQueued }, { adds: 2, removals: 0 });
  assert.equal(outbox.batches()[0].status, 'active');
  assert.equal(outbox.pendingDispatches('discord').length, 2);
  assert.throws(() => outbox.release(batch.id), /not held/);
}));

test('a torn or uncommitted append applies none of its records', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = outbox.prepare({
    agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
  })!;
  outbox.activate(batch.id);
  const committed = readFileSync(path, 'utf8');
  // Simulate an activation whose append was cut off before its commit.
  const lines = committed.trimEnd().split('\n');
  const activation = lines.filter((line) => line.includes('"txn"'));
  assert.ok(activation.length >= 3, 'activation is a transaction');
  writeFileSync(path, lines.filter((line) => !line.includes('"txn"') && !line.includes('"t":"commit"')).join('\n') + '\n');
  appendFileSync(path, activation.slice(0, -1).join('\n') + '\n' + '{"t":"requested","at":1,"op');
  const reread = new DiscordAwarenessOutbox(path);
  assert.equal(reread.batches()[0].status, 'prepared', 'the activation never committed');
  assert.equal(reread.pendingDispatches('discord').length, 0);
  assert.equal(reread.operations().length, 0);
}));

test('an append after a torn tail repairs it instead of corrupting the journal', withJournal((path) => {
  const outbox = new DiscordAwarenessOutbox(path);
  const batch = activeBatch(outbox, [ref('m1'), ref('m2')]);
  // A single-record append cut off mid-line (the process died writing it).
  appendFileSync(path, '{"t":"dispatching","at":1,"opId":"x","att');
  const reread = new DiscordAwarenessOutbox(path);
  assert.equal(reread.pendingDispatches('discord').length, 2, 'the torn record never applied');
  // The next append must not share the torn line.
  const dispatch = reread.pendingDispatches('discord')[0];
  reread.recordOutcome(reread.recordDispatching(dispatch), 'confirmed');
  const again = new DiscordAwarenessOutbox(path);
  assert.equal(again.pendingDispatches('discord').length, 1);
  assert.ok(!readFileSync(path, 'utf8').includes('"att{'), 'the fragment was truncated away');

  // A complete record that only lost its newline is kept, then terminated.
  const lines = readFileSync(path, 'utf8');
  writeFileSync(path, lines.trimEnd());
  const kept = new DiscordAwarenessOutbox(path);
  assert.equal(kept.pendingDispatches('discord').length, 1);
  kept.cancel(batch.id);
  assert.equal(new DiscordAwarenessOutbox(path).pendingDispatches('discord').length, 0);
  assert.equal(new DiscordAwarenessOutbox(path).batches()[0].cancelled !== undefined, true);
}));

test('v2 import keeps what the old ledger recorded, holds pending work, and happens once', withJournal((path, dir) => {
  const legacyPath = join(dir, 'recovery', 'discord-awareness-outbox.json');
  const entry = (messageId: string, fields: Record<string, unknown>) => ({ ...ref(messageId), attempts: 1, lastAction: 'add', ...fields });
  const legacy = {
    version: 2,
    batches: [
      {
        // The household's shape: an active target-branch batch, some marks
        // applied, the rest marked permanent-failure by hand after shutdown.
        id: 'dd34b043', status: 'active', agentName: 'resident', sourceBranch: 'main',
        targetBranch: 'rollback/resident/1791358473307', emoji: '💤', createdAt: 1791358473400,
        activationPolicy: 'target-branch',
        refs: [
          entry('a1', { desired: true, markerPresent: true, deliveryStatus: 'applied' }),
          entry('a2', { desired: true, markerPresent: true, deliveryStatus: 'applied' }),
          entry('p1', { desired: true, markerPresent: false, deliveryStatus: 'permanent-failure', lastError: 'Cannot send request: connection to "discord" is closed' }),
        ],
      },
      {
        // An interrupted drain that nobody edited: its pending work is held.
        id: 'pending-batch', status: 'active', agentName: 'resident', sourceBranch: 'main',
        targetBranch: 'rollback/resident/2', emoji: '💤', createdAt: 1791358473500,
        refs: [
          entry('q1', { desired: true, markerPresent: false, deliveryStatus: 'pending', lastError: 'Cannot send request' }),
          entry('q2', { desired: true, markerPresent: true, deliveryStatus: 'applied' }),
        ],
      },
    ],
  };
  mkdirSync(join(dir, 'recovery'), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify(legacy));

  const outbox = new DiscordAwarenessOutbox(path);
  // Reading imports in memory only; nothing is dispatched from an import.
  assert.equal(outbox.pendingDispatches('discord').length, 0);
  const views = new Map(outbox.view().map((v) => [v.id, v]));
  assert.equal(views.get('dd34b043')!.adds.confirmed, 2);
  assert.equal(views.get('dd34b043')!.adds.failed, 1);
  assert.equal(views.get('pending-batch')!.status, 'held');
  assert.equal(views.get('pending-batch')!.held!.releaseActions, 1);

  // The first write persists the import (with its hash) and retires the file.
  const receipt = outbox.retract('dd34b043', 'operator');
  assert.equal(receipt.removalsQueued, 3, 'every add that left the host is removed; the import cannot tell which were sent');
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(`${legacyPath}.migrated-v2`), true);

  // A crash between the import append and the rename re-reads the same
  // file: its hash is recorded, so nothing is imported or queued twice.
  writeFileSync(legacyPath, JSON.stringify(legacy));
  const again = new DiscordAwarenessOutbox(path);
  assert.equal(again.batches().filter((b) => b.id === 'dd34b043').length, 1);
  assert.equal(again.pendingDispatches('discord').length, 3);
  again.cancel('pending-batch');
  assert.equal(existsSync(legacyPath), false, 'the next write finishes the rename');
}));

test('framework drain classifies outcomes from what reached the server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-drain-'));
  try {
    const outbox = new DiscordAwarenessOutbox(join(dir, 'journal.jsonl'));
    activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3'), ref('m4'), ref('m5')]);
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
    framework.discordAwarenessOutbox = outbox;
    framework.discordAwarenessDrains = new Map();
    framework.discordAwarenessDeadlineMs = 1000;
    framework.mcplServerRegistry = { getServer: () => connection };
    const originalError = console.error;
    console.error = () => {};
    try {
      await framework.drainDiscordAwarenessOutbox('discord');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(calls, ['add_reaction:m1', 'add_reaction:m2', 'add_reaction:m3', 'add_reaction:m4', 'add_reaction:m5']);
    const status = new Map(outbox.operations().map((op) => [op.key.messageId, outbox.operationStatus(op)]));
    assert.equal(status.get('m1'), 'confirmed');
    assert.equal(status.get('m2'), 'failed', 'Discord said the message is gone: final');
    assert.equal(status.get('m3'), 'requested', 'never written: still queued');
    assert.equal(status.get('m4'), 'unknown', 'written, no answer: unknown');
    assert.equal(status.get('m5'), 'confirmed');

    // A disconnected route leaves its work queued without writing anything.
    connected = false;
    const before = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    console.error = () => {};
    try {
      await framework.drainDiscordAwarenessOutbox('discord');
    } finally {
      console.error = originalError;
    }
    assert.equal(readFileSync(join(dir, 'journal.jsonl'), 'utf8'), before);

    // Back online: the unsent and the unknown (newest for their keys) go again.
    connected = true;
    calls.length = 0;
    await framework.drainDiscordAwarenessOutbox('discord');
    assert.deepEqual(calls.sort(), ['add_reaction:m3', 'add_reaction:m4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('framework resumes an interrupted suppression before activating its marks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-resume-'));
  try {
    const outbox = new DiscordAwarenessOutbox(join(dir, 'journal.jsonl'));
    const batch = outbox.prepare({
      agentName: 'cairn',
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/suppressed',
      activationPolicy: 'explicit',
      suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }, { fromId: 'i3', toId: 'i3' }],
      refs: [ref('m1')],
      scope: 'all',
    })!;
    const present = new Set(['i1', 'i2']); // i3 interval committed before crash.
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => {
        present.delete(from); present.delete(to); removals.push(`${from}..${to}`);
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.discordAwarenessOutbox = outbox;
    framework.store = { currentBranch: () => ({ name: 'recovery/cairn/suppressed' }) };
    framework.agents = new Map([['cairn', { getContextManager: () => cm }]]);

    await framework.resumePreparedDiscordSuppressions();

    assert.deepEqual(removals, ['i1..i2']);
    assert.equal(outbox.batches().find((candidate) => candidate.id === batch.id)?.status, 'active');
    assert.deepEqual(outbox.pendingDispatches('discord').map((d) => d.key.messageId), ['m1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message-granular host/command undo places no marks unless the command asks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-undo-'));
  try {
    const messages = [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ];
    let currentBranch = 'main';
    const contextManager = {
      getAllMessages: () => messages,
      getMessageCount: () => messages.length,
      getMessageWindow: (offset: number, limit: number) => ({
        messages: messages.slice(offset, offset + limit),
        startIndex: offset,
        totalCount: messages.length,
      }),
      branchAt: (_id: string, name: string) => name,
      switchBranch: async (name: string) => { currentBranch = name; },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map([['cairn', { state: { status: 'idle' }, getContextManager: () => contextManager }]]);
    framework.store = { currentBranch: () => ({ name: currentBranch }) };
    framework.discordAwarenessOutbox = new DiscordAwarenessOutbox(join(dir, 'journal.jsonl'));
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
    const originalError = console.error;
    console.error = () => {};
    try {
      const silent = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1 });
      assert.equal(silent.ok, true);
      assert.deepEqual(silent.markers, { scope: 'none', unmarked: 1, notRemoved: 0, status: 'none', queued: 0 });
      assert.equal(framework.discordAwarenessOutbox.pendingDispatches('discord').length, 0);

      currentBranch = 'main';
      const marked = await framework.handleHostCommand('discord', {
        command: 'undo', agentName: 'cairn', messages: 3, marks: 'addressed',
      });
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      assert.equal(marked.markers.unmarked, 2);
      const dispatches = framework.discordAwarenessOutbox.pendingDispatches('discord');
      assert.deepEqual(dispatches.map((d: { key: { messageId: string; emoji: string } }) => `${d.key.messageId}${d.key.emoji}`), ['m1🫥']);

      // A mistyped scope is refused, never guessed.
      currentBranch = 'main';
      const typo = await framework.handleHostCommand('discord', {
        command: 'undo', agentName: 'cairn', messages: 1, marks: 'adressed',
      });
      assert.equal(typo.ok, false);
      assert.match(typo.error, /marks must be none, addressed or all/);

      // The journal's controls are reachable through host/command too.
      const listed = await framework.handleHostCommand('discord', { command: 'marks', action: 'list' });
      assert.equal(listed.ok, true);
      assert.equal(listed.awareness.length, 1);
      const cancelled = await framework.handleHostCommand('discord', {
        command: 'marks', action: 'cancel', batchId: listed.awareness[0].id, requesterName: 'op',
      });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.awareness.cancelled, 1);
      assert.equal(framework.discordAwarenessOutbox.pendingDispatches('discord').length, 0);
      const missing = await framework.handleHostCommand('discord', { command: 'marks', action: 'retract' });
      assert.equal(missing.ok, false);
    } finally {
      console.error = originalError;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host/command hide marks only on request, through the journal, routed by the issuing server for old records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-hide-'));
  try {
    const messages = [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { channelId: 'discord:g1:c1', messageId: 'm1', tags: ['chat:addressed'] } }, // pre-serverId record
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ];
    const removed: string[] = [];
    const contextManager = {
      getAllMessages: () => messages.filter((m) => !removed.includes(m.id)),
      removeMessage: (id: string) => { removed.push(id); },
      removeMessages: (from: string, to: string) => {
        const ids = messages.map((m) => m.id);
        for (const id of ids.slice(ids.indexOf(from), ids.indexOf(to) + 1)) removed.push(id);
      },
    };
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.agents = new Map([['cairn', { state: { status: 'idle' }, getContextManager: () => contextManager }]]);
    framework.store = { currentBranch: () => ({ name: 'main' }) };
    framework.discordAwarenessOutbox = new DiscordAwarenessOutbox(join(dir, 'journal.jsonl'));
    framework.discordAwarenessEmoji = '💤';
    framework.discordAwarenessDrains = new Map();
    framework.mcplServerRegistry = null;
    framework.lastVisiblePreview = async () => null;
    framework.operatorLog = new OperatorLog(undefined);
    const originalError = console.error;
    console.error = () => {};
    try {
      const silent = await framework.handleHostCommand('discord', { command: 'hide', agentName: 'cairn', fromMessageId: 'm3' });
      assert.equal(silent.ok, true);
      assert.equal(silent.markers.status, 'none');
      assert.equal(silent.markers.unmarked, 1);
      assert.equal(framework.discordAwarenessOutbox.batches().length, 0);

      const marked = await framework.handleHostCommand('discord', {
        command: 'hide', agentName: 'cairn', fromMessageId: 'm1', toMessageId: 'm2', marks: 'addressed',
      });
      assert.equal(marked.ok, true);
      assert.equal(marked.hidden, 2);
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      assert.equal(marked.markers.unmarked, 1);
      const [dispatch] = framework.discordAwarenessOutbox.pendingDispatches('discord');
      assert.deepEqual(dispatch.key, { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1', emoji: '💤' });
      // Explicit and already applied: a restart on this branch changes nothing.
      const restarted = new DiscordAwarenessOutbox(join(dir, 'journal.jsonl'));
      assert.deepEqual(restarted.recoverAtStartup('main'), { activated: [], held: [], unknownAttempts: 0 });
      assert.equal(restarted.batches()[0].status, 'active');
    } finally {
      console.error = originalError;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
