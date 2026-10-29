/**
 * The Discord awareness-mark ledger: one entry per reaction, holding what
 * the acts that still stand want of it, whether Discord is owed a request
 * for that, and what Discord last answered, never a model of what is on
 * Discord. A JSON file, version 3, where agent-framework 0.22.x kept its
 * version 2 ledger.
 *
 * Contract (since a field incident in which a web-UI rollback queued 918 💤
 * reactions on other people's messages):
 * marks are an explicit publication choice (default none); one-shot, so
 * branch moves and restarts never derive requests from branch state; and
 * cancel and retract are explicit operator acts whose receipts say what the
 * answers establish and what they leave open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import {
  DiscordAwarenessOutbox,
  DiscordAwarenessRefusal,
  boundDiscordAwarenessText,
  defaultDiscordAwarenessOutboxPath,
  isPermanentDiscordReactionFailure,
  extractDiscordAwarenessRefs,
  selectDiscordAwarenessRefs,
  type DiscordAwarenessBatchView,
  type DiscordAwarenessImportedUnsent,
  type DiscordAwarenessOutcome,
  type DiscordAwarenessRef,
  type DiscordAwarenessRetractView,
} from '../src/recovery/discord-awareness-outbox.js';
import { AgentFramework } from '../src/framework.js';
import { McplRequestError } from '../src/mcpl/server-connection.js';
import { OperatorLog } from '../src/operator-log.js';

/** A batch's status as the ledger holds it, or undefined when it holds no such batch. */
const statusOf = (outbox: DiscordAwarenessOutbox, batchId: string) => outbox.batches().find((batch) => batch.id === batchId)?.status;
const ref = (messageId: string, channel = 'c1'): DiscordAwarenessRef =>
  ({ serverId: 'discord', channelId: `discord:g1:${channel}`, messageId });

/** Permissions on the ledger's directory make its writes fail; root ignores them. */
const asRoot = process.getuid?.() === 0 ? 'root ignores file permissions' : false;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Harness {
  store: JsStore;
  dir: string;
  /** The ledger file, where a store keeps it. */
  path: string;
  /** What each version 2 rewrite by an instance open() made announced, in order. */
  announced: DiscordAwarenessImportedUnsent[][];
  /** Each directory a write couldn't sync after its rename, as reported. */
  unsynced: string[];
  /** A fresh instance over the same file: what a restarted process reads. */
  open(opts?: {
    announceImport?: (unsent: DiscordAwarenessImportedUnsent[]) => void;
    onUnsyncedWrite?: (directory: string, error: unknown) => void;
  }): DiscordAwarenessOutbox;
  /** The file as written now. */
  file(): any;
  /** A reaction's entry in the file, by message (and emoji). */
  entry(messageId: string, emoji?: string): any;
}

function withLedger(fn: (outbox: DiscordAwarenessOutbox, h: Harness) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const path = defaultDiscordAwarenessOutboxPath(join(dir, 'store'));
    const h: Harness = {
      store, dir, path, announced: [], unsynced: [],
      open: (opts = {}) => new DiscordAwarenessOutbox(path, {
        store,
        announceImport: (unsent) => { h.announced.push(unsent); },
        onUnsyncedWrite: (directory) => { h.unsynced.push(directory); },
        ...opts,
      }),
      file: () => JSON.parse(readFileSync(path, 'utf8')),
      entry: (messageId, emoji = '💤') => h.file().entries.find((e: any) => e.messageId === messageId && e.emoji === emoji),
    };
    try {
      await fn(h.open(), h);
    } finally {
      if (existsSync(dirname(path))) chmodSync(dirname(path), 0o700);
      chmodSync(join(dir, 'store'), 0o700);
      if (!store.isClosed()) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const input = (refs: DiscordAwarenessRef[], extra: Record<string, unknown> = {}) => ({
  agentName: 'cairn',
  sourceBranch: 'main',
  targetBranch: 'rollback/cairn/1',
  refs,
  scope: 'all' as const,
  ...extra,
});

async function activeBatch(outbox: DiscordAwarenessOutbox, refs: DiscordAwarenessRef[], extra: Record<string, unknown> = {}) {
  const batch = (await outbox.prepare(input(refs, extra)))!;
  await outbox.activate(batch.id);
  return batch;
}

/** Claim and answer the request owed for one message. */
async function answer(
  outbox: DiscordAwarenessOutbox,
  messageId: string,
  outcome: DiscordAwarenessOutcome,
  detail: { permanent?: boolean } = {},
) {
  const request = await outbox.claim('discord', (candidate) => candidate.messageId !== messageId);
  assert.ok(request, `a request for ${messageId} is owed`);
  const ended = await outbox.recordOutcome(request, outcome, detail);
  return { request, ended };
}

const batches = (outbox: DiscordAwarenessOutbox) =>
  outbox.view().filter((v): v is DiscordAwarenessBatchView => v.kind === 'batch');
const retracts = (outbox: DiscordAwarenessOutbox) =>
  outbox.view().filter((v): v is DiscordAwarenessRetractView => v.kind === 'retract');
const none = { queued: 0, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 };

function writeLedger(h: Harness, ledger: unknown): void {
  mkdirSync(dirname(h.path), { recursive: true });
  writeFileSync(h.path, typeof ledger === 'string' ? ledger : JSON.stringify(ledger));
}

const legacyEntry = (messageId: string, fields: Record<string, unknown> = {}) =>
  ({ ...ref(messageId), desired: false, markerPresent: false, deliveryStatus: 'applied', attempts: 0, ...fields });

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
  // A message stored twice is addressed if either copy says so, in either order.
  for (const copies of [[['chat:addressed'], []], [[], ['chat:addressed']]]) {
    const twice = copies.map((tags) => ({ metadata: { ...ref('c1'), tags } }));
    assert.deepEqual(selectDiscordAwarenessRefs(twice, { scope: 'addressed' }).refs.map((r) => r.messageId), ['c1']);
  }
});

test('the ledger is compact version 3 JSON where 0.22.x kept its own: a prepare is on disk when it returns, and activation owes one add per ref', withLedger(async (outbox, h) => {
  assert.equal(h.path, join(h.dir, 'store', 'recovery', 'discord-awareness-outbox.json'));
  const batch = (await outbox.prepare(input([ref('m1'), ref('m2'), ref('m1')])))!;
  const raw = readFileSync(h.path, 'utf8');
  assert.equal(raw.indexOf('\n'), raw.length - 1, 'one line');
  const prepared = JSON.parse(raw);
  assert.equal(prepared.version, 3);
  assert.equal(prepared.moment, 1);
  assert.deepEqual(prepared.batches.map((b: any) => [b.id, b.status, b.chosen, b.refs.length]), [[batch.id, 'prepared', 1, 2]]);
  assert.deepEqual(prepared.entries, [], 'a choice owes nothing until its surgery activates it');

  assert.equal(await outbox.activate(batch.id), 2);
  assert.equal(await outbox.activate(batch.id), 0, 'an active batch owes nothing more');
  assert.equal(h.file().moment, 2);
  assert.deepEqual(h.entry('m1'), { ...ref('m1'), emoji: '💤', wanted: 'present', wantedBy: [batch.id], due: 2, attempts: 0 });
  assert.deepEqual(outbox.due('discord').map((r) => `${r.action}:${r.messageId}:${r.due}`), ['add:m1:2', 'add:m2:2']);

  const request = await outbox.claim('discord');
  assert.deepEqual(request, { ...ref('m1'), emoji: '💤', action: 'add', due: 2 });
  assert.deepEqual(h.entry('m1').sending, { action: 'add', due: 2 }, 'written ahead, before the request can leave');
  assert.deepEqual(outbox.due('discord').map((r) => r.messageId), ['m2'], 'one with a request on the wire is not owed again');
  assert.equal(await outbox.recordOutcome(request!, 'confirmed'), false);
  const answered = h.entry('m1');
  assert.deepEqual([answered.confirmed, answered.due, answered.sending], ['present', null, undefined]);
}));

test('a start activates nothing: it retires what interrupted surgeries left, keeps a pending suppression for its branch, and records a request left on the wire as unanswered', withLedger(async (outbox, h) => {
  const left = (await outbox.prepare(input([ref('m1')])))!;
  const suppression = (await outbox.prepare(input([ref('m2')], {
    targetBranch: 'suppress/cairn/1', suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }],
  })))!;
  const active = await activeBatch(outbox, [ref('m3')], { targetBranch: 'rollback/cairn/3' });
  assert.equal((await outbox.claim('discord'))?.messageId, 'm3');

  // The process ends with that request out; a restarted one reads the file.
  const restarted = h.open();
  let statusesAtAnnounce: string[] = [];
  const recovered = await restarted.recoverAtStartup(() => {
    statusesAtAnnounce = h.file().batches.map((b: any) => b.status);
  });
  assert.deepEqual(recovered, {
    retired: [{ batchId: left.id, agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', marks: 1, suppression: false }],
    unknownAttempts: 1,
    givenUp: 0,
  });
  assert.deepEqual(statusesAtAnnounce, ['prepared', 'prepared', 'active'], 'announced before it is written');
  assert.deepEqual(h.file().batches.map((b: any) => [b.id, b.status]),
    [[left.id, 'retired'], [suppression.id, 'prepared'], [active.id, 'active']]);
  assert.deepEqual(restarted.pendingSuppressionsFor('suppress/cairn/1').map((b) => b.id), [suppression.id]);
  assert.deepEqual(restarted.pendingSuppressionsFor('suppress/cairn'), [], 'only on its exact branch');
  const m3 = h.entry('m3');
  assert.deepEqual([m3.sending, m3.confirmed, m3.mayLand, m3.attempts], [undefined, 'unknown', ['add'], 1]);
  assert.deepEqual(restarted.due('discord').map((r) => r.messageId), ['m3'], 'still owed, so sent again');
  assert.equal(batches(restarted).find((v) => v.id === active.id)?.mayStillLand, 1);
}));

test('a request a previous process left on the wire at its third unconfirmed attempt ends what is owed, and the start says so', withLedger(async (outbox, h) => {
  await activeBatch(outbox, [ref('m1')]);
  await answer(outbox, 'm1', 'unknown');
  await answer(outbox, 'm1', 'failed');
  await outbox.claim('discord');
  const recovered = await h.open().recoverAtStartup();
  assert.deepEqual([recovered.unknownAttempts, recovered.givenUp], [1, 1]);
  const entry = h.entry('m1');
  assert.deepEqual([entry.failed, entry.due, entry.attempts], [true, null, 3]);
}));

test("a retract made after a surgery's choice wins over that choice's activation, even once cancelled; one made before the choice loses", withLedger(async (outbox, h) => {
  // An operator retracts every mark while a surgery that chose marks runs.
  const running = (await outbox.prepare(input([ref('m1'), ref('m2')])))!;
  const during = await outbox.retract('all');
  assert.equal(during.removalsQueued, 2, "a prepared batch's refs are reached");
  await outbox.cancel(during.requestId);
  assert.equal(await outbox.activate(running.id), 0, 'nothing owed: the retract came after the choice');
  assert.deepEqual([h.entry('m1').wanted, h.entry('m1').due], [null, null], "and the retract's cancel revives nothing");

  // A choice made after a retract wins over it.
  await outbox.retract(running.id);
  const later = await activeBatch(outbox, [ref('m1')], { targetBranch: 'rollback/cairn/2' });
  assert.deepEqual([h.entry('m1').wanted, h.entry('m1').wantedBy], ['present', [later.id]]);
  assert.deepEqual(outbox.due('discord').map((r) => `${r.action}:${r.messageId}`), ['remove:m2', 'add:m1']);
}));

test('an answer ends what is owed only for the act its request served', withLedger(async (outbox, h) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  const add = (await outbox.claim('discord'))!;
  // A retract while the add is out.
  await outbox.retract(batch.id);
  assert.deepEqual(outbox.due('discord'), [], 'the reaction waits for the answer on the wire');
  await outbox.recordOutcome(add, 'confirmed');
  const confirmed = h.entry('m1');
  assert.deepEqual([confirmed.confirmed, confirmed.wanted], ['present', 'absent'], 'the answer is kept');
  assert.notEqual(confirmed.due, null, 'and the retract still gets its own request');

  // An unanswered request for an older act counts toward nothing owed now.
  const remove = (await outbox.claim('discord'))!;
  assert.equal(remove.action, 'remove');
  await activeBatch(outbox, [ref('m1')], { targetBranch: 'rollback/cairn/2' });
  assert.equal(await outbox.recordOutcome(remove, 'unknown'), false);
  const unanswered = h.entry('m1');
  assert.deepEqual([unanswered.confirmed, unanswered.mayLand, unanswered.attempts], ['unknown', ['remove'], 0]);
  assert.deepEqual(outbox.due('discord').map((r) => r.action), ['add']);
}));

test('cancel takes its act out of each reaction it wants: one no act wants is owed nothing, and a request on the wire still records its answer', withLedger(async (outbox, h) => {
  const first = await activeBatch(outbox, [ref('m1'), ref('m2')]);
  const second = await activeBatch(outbox, [ref('m1')], { targetBranch: 'rollback/cairn/2' });
  assert.deepEqual(h.entry('m1').wantedBy, [first.id, second.id]);
  const m1 = (await outbox.claim('discord', (r) => r.messageId !== 'm1'))!;

  assert.deepEqual(await outbox.cancel(first.id, 'op'), { target: first.id, kind: 'batch', cancelled: 1, confirmed: 0, mayStillLand: 1 });
  assert.deepEqual([h.entry('m2').wanted, h.entry('m2').due], [null, null], 'no act wants m2 now');
  assert.deepEqual(h.entry('m1').wantedBy, [second.id], 'the other batch still wants m1');
  assert.equal(h.file().batches.find((b: any) => b.id === first.id).cancelled.by, 'op');
  await outbox.recordOutcome(m1, 'confirmed');
  assert.equal(h.entry('m1').confirmed, 'present');
  assert.deepEqual(outbox.due('discord'), []);

  assert.deepEqual(await outbox.cancel(second.id), { target: second.id, kind: 'batch', cancelled: 0, confirmed: 1, mayStillLand: 0 });
  // A repeated cancel finds nothing the act still wants, and writes nothing.
  const before = readFileSync(h.path, 'utf8');
  assert.deepEqual(await outbox.cancel(second.id), { target: second.id, kind: 'batch', cancelled: 0, confirmed: 0, mayStillLand: 0 });
  assert.equal(readFileSync(h.path, 'utf8'), before);
}));

test("a cancelled retract's receipt counts every reaction it still wants, a later retract's too", withLedger(async (outbox) => {
  const batch = await activeBatch(outbox, [ref('m1'), ref('m2')]);
  await answer(outbox, 'm1', 'confirmed');
  await answer(outbox, 'm2', 'confirmed');
  const older = await outbox.retract(batch.id);
  await answer(outbox, 'm1', 'confirmed');
  await outbox.retract('all');
  // Both reactions are the newer retract's too, and still the older one's:
  // its removal of m1 was confirmed, and m2's is still owed.
  assert.deepEqual(await outbox.cancel(older.requestId),
    { target: older.requestId, kind: 'retract', cancelled: 0, confirmed: 1, mayStillLand: 0 });
}));

test("a cancelled batch's receipt leaves out a reaction its activation left to a later retract", withLedger(async (outbox) => {
  const chosen = (await outbox.prepare(input([ref('m1')])))!;
  // A retract after the choice reaches the prepared batch's ref, and its
  // removal goes unanswered.
  await outbox.retract('all');
  await answer(outbox, 'm1', 'unknown');
  assert.equal(await outbox.activate(chosen.id), 0, 'the retract decides m1');
  assert.deepEqual(await outbox.cancel(chosen.id), { target: chosen.id, kind: 'batch', cancelled: 0, confirmed: 0, mayStillLand: 0 });
}));

test('cancelling a batch its surgery has not activated stops every mark: its activation is refused, and it settles not scheduled', withLedger(async (outbox) => {
  const ok = (await outbox.prepare(input([ref('m1')], { targetBranch: 'b1' })))!;
  assert.deepEqual(await outbox.settleActivation(ok.id), { status: 'queued', queued: 1 });
  const batch = (await outbox.prepare(input([ref('m2'), ref('m3')], { targetBranch: 'b2' })))!;
  assert.deepEqual(await outbox.cancel(batch.id), { target: batch.id, kind: 'batch', cancelled: 2, confirmed: 0, mayStillLand: 0 });
  await assert.rejects(outbox.activate(batch.id), /was cancelled before activation/);
  const settled = await outbox.settleActivation(batch.id);
  assert.equal(settled.status, 'not-scheduled');
  assert.match((settled as { error: string }).error, /was cancelled before activation/);
  assert.equal(statusOf(outbox, batch.id), 'retired');
  assert.deepEqual(outbox.due('discord').map((r) => r.messageId), ['m1']);
}));

test('a retract owes a removal for every selected reaction, whatever was answered before, and says on which an add may still land', withLedger(async (outbox) => {
  const batch = await activeBatch(outbox, [ref('m1'), ref('m2'), ref('m3')]);
  await answer(outbox, 'm1', 'confirmed');
  await answer(outbox, 'm2', 'unknown');
  const { requestId, ...receipt } = await outbox.retract(batch.id, 'op');
  assert.ok(requestId);
  assert.deepEqual(receipt, { removalsQueued: 3, addsSuperseded: 2, keysWithUnresolvedAdds: 1 });
  assert.deepEqual(outbox.due('discord').map((r) => `${r.action}:${r.messageId}`), ['remove:m1', 'remove:m2', 'remove:m3']);
}));

test('three unconfirmed attempts at one act end it, and a refusal for good ends it at once; one refused before it left the host does not count', withLedger(async (outbox, h) => {
  const batch = await activeBatch(outbox, [ref('m1'), ref('m2')]);
  assert.equal((await answer(outbox, 'm1', 'failed')).ended, false);
  assert.equal((await answer(outbox, 'm1', 'unknown')).ended, false);
  assert.equal((await answer(outbox, 'm1', 'not-sent')).ended, false);
  assert.equal(h.entry('m1').attempts, 2);
  assert.equal((await answer(outbox, 'm1', 'failed')).ended, true);
  assert.deepEqual([h.entry('m1').failed, h.entry('m1').due], [true, null]);
  assert.equal((await answer(outbox, 'm2', 'failed', { permanent: true })).ended, true);
  assert.deepEqual(outbox.due('discord'), []);
  assert.equal(batches(outbox)[0].reactions.failed, 2);
  // A new act owes a request again.
  await outbox.retract(batch.id);
  assert.deepEqual(outbox.due('discord').map((r) => r.messageId), ['m1', 'm2']);
  assert.equal(h.entry('m1').failed, undefined);
}));

test("retract('all') takes the refs of every batch not retired and every reaction the ledger holds, and no other ref of a retired batch", withLedger(async (outbox) => {
  await activeBatch(outbox, [ref('m1')]);
  await outbox.prepare(input([ref('m2')], { targetBranch: 'rollback/cairn/2' }));
  const retired = (await outbox.prepare(input([ref('m3')], { targetBranch: 'rollback/cairn/3' })))!;
  assert.equal(await outbox.discard(retired.id), true);
  assert.equal(await outbox.discard(retired.id), false, 'only a prepared batch is retired');
  // A retract of a retired batch still reaches its refs, so the ledger holds m3.
  await outbox.retract(retired.id);
  await answer(outbox, 'm3', 'confirmed');
  const untouched = (await outbox.prepare(input([ref('m4')], { targetBranch: 'rollback/cairn/4' })))!;
  await outbox.discard(untouched.id);
  assert.equal((await outbox.retract('all')).removalsQueued, 3);
  assert.deepEqual(outbox.due('discord').map((r) => `${r.action}:${r.messageId}`).sort(), ['remove:m1', 'remove:m2', 'remove:m3']);
}));

test("views count each batch's reactions by state, and a retract's the reactions it still wants absent", withLedger(async (outbox) => {
  const batch = await activeBatch(outbox, ['m1', 'm2', 'm3', 'm4', 'm5'].map((m) => ref(m)));
  await answer(outbox, 'm1', 'confirmed');
  await answer(outbox, 'm2', 'failed', { permanent: true });
  await answer(outbox, 'm4', 'unknown');
  await outbox.claim('discord', (r) => r.messageId !== 'm3');
  const [view] = batches(outbox);
  assert.deepEqual(view.reactions, { ...none, queued: 2, sending: 1, present: 1, failed: 1 });
  assert.equal(view.mayStillLand, 2, 'the add on the wire and the one never answered');
  const { requestId } = await outbox.retract(batch.id);
  const [retract] = retracts(outbox);
  assert.deepEqual([retract.id, retract.target, retract.keys], [requestId, batch.id, 5]);
  assert.deepEqual(retract.reactions, { ...none, queued: 4, sending: 1 });
  await outbox.cancel(requestId);
  assert.deepEqual(retracts(outbox)[0].reactions, none);
  assert.ok(retracts(outbox)[0].cancelled);
}));

test('the first act rewrites a version 2 ledger as version 3: its batches stay as history, and the work it had still to do is dropped, announced before the write', withLedger(async (_outbox, h) => {
  writeLedger(h, {
    version: 2,
    batches: [
      { id: 'never', status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1',
        emoji: '💤', createdAt: 1, refs: [legacyEntry('m1'), legacyEntry('m2')] },
      { id: 'queued', status: 'active', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/2',
        emoji: '💤', createdAt: 2, refs: [
          legacyEntry('m3', { desired: true, deliveryStatus: 'pending' }),
          legacyEntry('m4', { markerPresent: true, deliveryStatus: 'pending' }),
          legacyEntry('m5', { desired: true, markerPresent: true, attempts: 1, lastAction: 'add' }),
        ] },
      { id: 'sup', status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'suppress/cairn/1',
        emoji: '💤', createdAt: 3, activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }],
        refs: [legacyEntry('m6')] },
      // A second listing of one batch is skipped.
      { id: 'queued', status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'x', emoji: '💤',
        createdAt: 4, refs: [] },
    ],
  });
  let versionAtAnnounce: unknown;
  const outbox = h.open({ announceImport: (unsent) => { h.announced.push(unsent); versionAtAnnounce = h.file().version; } });
  assert.throws(() => outbox.batches(), /is version 2, which its first write rewrites as version 3/);
  await outbox.recoverAtStartup();
  assert.equal(versionAtAnnounce, 2, 'announced before the rewrite is written');
  const named = (batchId: string, targetBranch: string, adds: number, removals: number) =>
    ({ batchId, agentName: 'cairn', sourceBranch: 'main', targetBranch, adds, removals });
  assert.deepEqual(h.announced, [[
    named('never', 'rollback/cairn/1', 2, 0),
    named('queued', 'rollback/cairn/2', 1, 1),
    named('sup', 'suppress/cairn/1', 1, 0),
  ]]);
  const file = h.file();
  assert.equal(file.version, 3);
  assert.deepEqual(file.batches.map((b: any) => [b.id, b.status, b.scope, b.legacyAdded, b.refs.length]),
    [['never', 'retired', 'legacy', 0, 2], ['queued', 'active', 'legacy', 1, 3], ['sup', 'prepared', 'legacy', 0, 1]]);
  assert.deepEqual(file.entries, []);
  assert.deepEqual(outbox.due('discord'), [], 'none of it is sent');
  assert.deepEqual(outbox.pendingSuppressionsFor('suppress/cairn/1').map((b) => b.id), ['sup']);
  // A retract of a batch 0.22.x activated reaches its refs.
  assert.equal((await outbox.retract('queued')).removalsQueued, 3);
  // Rewritten once: a restarted process reads version 3 and announces nothing.
  await h.open().recoverAtStartup();
  assert.equal(h.announced.length, 1);
}));

test("a rewrite counts what 0.22.x saw added from the old writer's lastError, never from its reconciliation state", withLedger(async (_outbox, h) => {
  // Entries exactly as the 64c480b writer leaves them (recordSuccess clears
  // lastError, recordFailure sets it; setDesired rewrites deliveryStatus
  // from the cached markerPresent without any request).
  writeLedger(h, {
    version: 2,
    batches: [{
      id: 'reconciled', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/9',
      emoji: '💤', createdAt: 1,
      refs: [
        // An unknown add, then a switch to the source: "applied" only because
        // the cache (false) matched desired (false). The add may have landed.
        legacyEntry('u1', { attempts: 1, lastAction: 'add', lastError: 'MCPL server "discord" did not respond within 10000ms' }),
        // A confirmed add, then a switch to the source: "pending" is the
        // removal the old writer wanted; the add really succeeded.
        legacyEntry('c1', { markerPresent: true, deliveryStatus: 'pending', attempts: 1, lastAction: 'add' }),
      ],
    }],
  });
  const outbox = h.open();
  await outbox.recoverAtStartup();
  const [view] = batches(outbox);
  assert.equal(view.legacyAdded, 1, "c1 alone: u1's add left an error, whatever its reconciliation state says");
  assert.equal(view.status, 'active');
  // The old writer's pending removal is dropped, never sent, and named.
  assert.deepEqual(h.announced.flat().map((b) => [b.batchId, b.adds, b.removals]), [['reconciled', 0, 1]]);
  assert.deepEqual(outbox.due('discord'), []);
}));

test("retract('all') after a rewrite takes off every key 0.22.x attempted, each a ref of a batch it activated", withLedger(async (_outbox, h) => {
  // A ledger as every release from 0.6.7 to 0.22.3 writes it: attempts only
  // on refs of a batch it activated (its pending() returns no other),
  // whatever their outcome, and none on a batch it never activated.
  const entry = (messageId: string, fields: Record<string, unknown>) =>
    legacyEntry(messageId, { desired: true, deliveryStatus: 'pending', ...fields });
  const legacy = {
    version: 2,
    batches: [
      {
        id: 'active-1', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/1',
        emoji: '💤', createdAt: 1,
        refs: [
          entry('a1', { markerPresent: true, deliveryStatus: 'applied', attempts: 1, lastAction: 'add' }),
          entry('a2', { attempts: 2, lastAction: 'add', lastError: 'MCPL server "discord" did not respond within 10000ms' }),
          entry('a3', { desired: false, deliveryStatus: 'applied', attempts: 2, lastAction: 'remove' }),
          entry('a4', { deliveryStatus: 'permanent-failure', attempts: 1, lastAction: 'add', lastError: 'Unknown Message' }),
          entry('a5', {}),
        ],
      },
      {
        id: 'active-2', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/2',
        emoji: '👀', createdAt: 2,
        refs: [entry('b1', { markerPresent: true, deliveryStatus: 'applied', attempts: 1, lastAction: 'add' })],
      },
      {
        // Never activated, so never attempted: retired by the rewrite.
        id: 'never', status: 'prepared', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/3',
        emoji: '💤', createdAt: 3,
        refs: [entry('c1', { desired: false, deliveryStatus: 'applied' })],
      },
    ],
  };
  writeLedger(h, legacy);
  const outbox = h.open();
  const receipt = await outbox.retract('all');
  assert.deepEqual(batches(outbox).map((v) => [v.id, v.legacyAdded]), [['active-1', 1], ['active-2', 1]]);
  const removals = outbox.due('discord').map((r) => `${r.action}:${r.emoji}:${r.messageId}`).sort();
  const attempted = legacy.batches.flatMap((batch) => batch.refs
    .filter((r) => r.attempts > 0).map((r) => `remove:${batch.emoji}:${r.messageId}`));
  assert.deepEqual(attempted.filter((key) => !removals.includes(key)), [], 'every key 0.22.x attempted is taken');
  assert.deepEqual(removals, ['remove:👀:b1', 'remove:💤:a1', 'remove:💤:a2', 'remove:💤:a3', 'remove:💤:a4', 'remove:💤:a5']);
  assert.equal(receipt.removalsQueued, 6);
}));

test('a file of another version, or not the shape version 3 promises, is refused, and stays to be read again', withLedger(async (_outbox, h) => {
  const batch = {
    id: 'b', status: 'active', agentName: 'cairn', sourceBranch: 'main', targetBranch: 't', emoji: '💤', createdAt: 1,
    chosen: 1, scope: 'all', refs: [ref('m1')],
  };
  const entry = { ...ref('m1'), emoji: '💤', wanted: 'present', wantedBy: ['b'], due: 2, attempts: 0 };
  const valid = { version: 3, moment: 2, batches: [batch], retracts: [], entries: [entry] };
  const cases: Array<[string, unknown, RegExp]> = [
    ['not JSON', '{broken', /it isn't JSON$/],
    ['a later version', { ...valid, version: 4 }, /is version 4, which this build can't read: it reads versions 2 and 3$/],
    ['no version', { batches: [] }, /is of no version, which this build can't read/],
    ['the moment', { ...valid, moment: null }, /Invalid Discord awareness ledger/],
    ["a batch's status", { ...valid, batches: [{ ...batch, status: 'discarded' }] }, /Invalid Discord awareness ledger/],
    ["a batch's moment", { ...valid, batches: [{ ...batch, chosen: '1' }] }, /Invalid Discord awareness ledger/],
    ["a batch's scope", { ...valid, batches: [{ ...batch, scope: 'some' }] }, /Invalid Discord awareness ledger/],
    ["an entry's wish", { ...valid, entries: [{ ...entry, wanted: 'yes' }] }, /Invalid Discord awareness ledger/],
    ["an entry's due", { ...valid, entries: [{ ...entry, due: '2' }] }, /Invalid Discord awareness ledger/],
    ["an entry's request on the wire", { ...valid, entries: [{ ...entry, sending: { action: 'react', due: 2 } }] }, /Invalid Discord awareness ledger/],
    ["an entry's answer", { ...valid, entries: [{ ...entry, confirmed: 'maybe' }] }, /Invalid Discord awareness ledger/],
    ['a retract', { ...valid, retracts: [{ id: 'r', target: 'all', at: 1, keys: 1 }] }, /Invalid Discord awareness ledger/],
    ['a version written as text', { ...valid, version: '3' }, /is version "3", which this build can't read: it reads versions 2 and 3$/],
    ["a batch's ref", { ...valid, batches: [{ ...batch, refs: [{ serverId: 'discord', messageId: 'm1' }] }] }, /Invalid Discord awareness ledger/],
    ["a batch's removal interval", { ...valid, batches: [{ ...batch, suppressionIntervals: [{ fromId: 1, toId: 'i' }] }] }, /Invalid Discord awareness ledger/],
    ["a batch's cancellation", { ...valid, batches: [{ ...batch, cancelled: { at: 'now' } }] }, /Invalid Discord awareness ledger/],
    ["a batch's count of 0.22.x's adds", { ...valid, batches: [{ ...batch, legacyAdded: '1' }] }, /Invalid Discord awareness ledger/],
    ["an entry's wishers", { ...valid, entries: [{ ...entry, wantedBy: ['b', 2] }] }, /Invalid Discord awareness ledger/],
    ["an entry's attempts", { ...valid, entries: [{ ...entry, attempts: null }] }, /Invalid Discord awareness ledger/],
    ["an entry's retract moment", { ...valid, entries: [{ ...entry, retracted: '1' }] }, /Invalid Discord awareness ledger/],
    ["the due its request serves", { ...valid, entries: [{ ...entry, sending: { action: 'add' } }] }, /Invalid Discord awareness ledger/],
    ["an entry's actions that may land", { ...valid, entries: [{ ...entry, mayLand: ['react'] }] }, /Invalid Discord awareness ledger/],
    ["an entry's failure", { ...valid, entries: [{ ...entry, failed: 'yes' }] }, /Invalid Discord awareness ledger/],
  ];
  for (const [what, ledger, refusal] of cases) {
    writeLedger(h, ledger);
    const raw = readFileSync(h.path, 'utf8');
    const outbox = h.open();
    assert.throws(() => outbox.batches(), refusal, what);
    await assert.rejects(outbox.retract('all'), refusal, what);
    assert.equal(readFileSync(h.path, 'utf8'), raw, `the file stays as it was (${what})`);
  }
  writeLedger(h, valid);
  assert.deepEqual(h.open().due('discord').map((r) => r.messageId), ['m1']);
}));

test("a version 2 ledger whose batches the released readers would have refused is refused, and stays to be read again", withLedger(async (_outbox, h) => {
  const entry = legacyEntry('m1');
  const v2 = {
    id: 'legacy-sup', status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'partial', emoji: '💤', createdAt: 1,
    activationPolicy: 'explicit', suppressionIntervals: [{ fromId: 'i1', toId: 'i2' }], refs: [entry],
  };
  const without = <T extends object>(value: T, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  // Every field the released readers (0.6.7 to 0.22.3) checked in a version
  // 2 ledger, each made wrong in turn: the document's, a batch's, an
  // interval's and an entry's. Rewritten as written, the first would retire
  // a suppression whose removals a start on its branch still owes.
  const refused: Array<[string, unknown]> = [
    ['batches', { version: 2, batches: v2 }],
    ['activationPolicy', { version: 2, batches: [{ ...v2, activationPolicy: 'explicit ' }] }],
    ...['id', 'agentName', 'sourceBranch', 'targetBranch', 'emoji'].map((key): [string, unknown] =>
      [key, { version: 2, batches: [{ ...v2, [key]: 7 }] }]),
    ['status', { version: 2, batches: [{ ...v2, status: 'pending' }] }],
    ['createdAt', { version: 2, batches: [{ ...v2, createdAt: '1' }] }],
    ['refs', { version: 2, batches: [{ ...v2, refs: entry }] }],
    ['suppressionIntervals', { version: 2, batches: [{ ...v2, suppressionIntervals: 'i1-i2' }] }],
    ['an interval\'s fromId', { version: 2, batches: [{ ...v2, suppressionIntervals: [{ toId: 'i2' }] }] }],
    ['an interval\'s toId', { version: 2, batches: [{ ...v2, suppressionIntervals: [{ fromId: 'i1' }] }] }],
    ...['serverId', 'channelId', 'messageId', 'desired', 'markerPresent', 'deliveryStatus', 'attempts'].map((key): [string, unknown] =>
      [`an entry's ${key}`, { version: 2, batches: [{ ...v2, refs: [without(entry, key)] }] }]),
    ['an entry\'s deliveryStatus value', { version: 2, batches: [{ ...v2, refs: [{ ...entry, deliveryStatus: 'sent' }] }] }],
    ['an entry\'s lastAction', { version: 2, batches: [{ ...v2, refs: [{ ...entry, lastAction: 'react' }] }] }],
    ['an entry\'s lastAttemptAt', { version: 2, batches: [{ ...v2, refs: [{ ...entry, lastAttemptAt: '1' }] }] }],
    ['an entry\'s lastError', { version: 2, batches: [{ ...v2, refs: [{ ...entry, lastError: 7 }] }] }],
  ];
  for (const [field, ledger] of refused) {
    writeLedger(h, ledger);
    await assert.rejects(h.open().recoverAtStartup(), /Invalid Discord awareness ledger/, field);
    assert.equal(h.file().version, 2, `the ledger stays as it was (${field})`);
  }
  // As those releases wrote it, it is rewritten, and the suppression's body stays owed.
  writeLedger(h, { version: 2, batches: [v2] });
  const outbox = h.open();
  await outbox.recoverAtStartup();
  assert.deepEqual(outbox.pendingSuppressionsFor('partial').map((b) => b.id), ['legacy-sup']);
}));

test("a write that fails leaves the file as it was, and the act's change with it", { skip: asRoot }, withLedger(async (outbox, h) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  const before = readFileSync(h.path, 'utf8');
  chmodSync(dirname(h.path), 0o500);
  await assert.rejects(outbox.retract(batch.id), /EACCES/);
  assert.equal(readFileSync(h.path, 'utf8'), before);
  assert.deepEqual(retracts(outbox), [], 'read back from the file: the retract is gone');
  assert.deepEqual(outbox.due('discord').map((r) => r.action), ['add']);
  chmodSync(dirname(h.path), 0o700);
  await outbox.retract(batch.id);
  assert.equal(retracts(outbox).length, 1);
}));

test("a write whose directory, or the directory's parent, can't be synced after its rename stands, and is reported", { skip: asRoot }, withLedger(async (outbox, h) => {
  const batch = (await outbox.prepare(input([ref('m1')])))!;
  // The rename lands, and syncing the ledger's directory can't open it.
  chmodSync(dirname(h.path), 0o300);
  const settled = await outbox.settleActivation(batch.id);
  chmodSync(dirname(h.path), 0o700);
  assert.deepEqual(settled, { status: 'queued', queued: 1 });
  assert.equal(statusOf(h.open(), batch.id), 'active', 'in the file');
  assert.deepEqual(h.unsynced, [dirname(h.path)]);
  // Its parent, the store's directory, can't be opened to sync.
  const other = (await outbox.prepare(input([ref('m2')], { targetBranch: 'rollback/cairn/2' })))!;
  chmodSync(dirname(dirname(h.path)), 0o300);
  try {
    assert.equal(await outbox.discard(other.id), true);
  } finally {
    chmodSync(dirname(dirname(h.path)), 0o700);
  }
  assert.equal(statusOf(h.open(), other.id), 'retired', 'in the file');
  assert.deepEqual(h.unsynced, [dirname(h.path), dirname(dirname(h.path))]);
}));

test("a report of an unsynced directory that throws doesn't fail the write it reports", { skip: asRoot }, withLedger(async (outbox, h) => {
  const batch = (await outbox.prepare(input([ref('m1')])))!;
  const reporting = h.open({ onUnsyncedWrite: () => { throw new Error('injected report failure'); } });
  chmodSync(dirname(h.path), 0o300);
  try {
    assert.deepEqual(await reporting.settleActivation(batch.id), { status: 'queued', queued: 1 });
  } finally {
    chmodSync(dirname(h.path), 0o700);
  }
  assert.equal(statusOf(h.open(), batch.id), 'active');
}));

test("a prepare whose write failed leaves the ledger as it was, and says why", { skip: asRoot }, withLedger(async (outbox, h) => {
  await outbox.prepare(input([ref('m0')]));
  const dir = dirname(h.path);
  // The temporary file can't be made.
  chmodSync(dir, 0o500);
  await assert.rejects(outbox.prepare(input([ref('m1')])), (error: Error) => /^recording awareness batch \S+ failed: [^;]*EACCES[^;]*$/.test(error.message));
  // Nor can it without search permission, and the file can't be read back.
  chmodSync(dir, 0o200);
  await assert.rejects(outbox.prepare(input([ref('m2')])), (error: Error) => /^recording awareness batch \S+ failed: /.test(error.message));
  chmodSync(dir, 0o700);
  assert.deepEqual(h.open().batches().map((b) => [b.refs[0]!.messageId, b.status]), [['m0', 'prepared']]);
  assert.deepEqual(outbox.batches().map((b) => b.refs[0]!.messageId), ['m0'], 'nor does memory hold them');
}));

test('acts run one at a time: an act starts only once the write before it is done, so a reaction is claimed again only after its answer is written', withLedger(async (outbox) => {
  await activeBatch(outbox, [ref('m1')]);
  const first = (await outbox.claim('discord'))!;
  // Hold the answer's write.
  const internals = outbox as unknown as { persist: (...args: unknown[]) => Promise<void> };
  const persist = internals.persist;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  internals.persist = async function (this: unknown, ...args: unknown[]) {
    if (writes++ === 0) await held;
    return persist.apply(this, args);
  };
  const answered = outbox.recordOutcome(first, 'failed');
  const next = outbox.claim('discord');
  await new Promise((resolve) => setImmediate(resolve));
  // The answer is made, and its write held: the claim hasn't started, so the
  // reaction is owed and not on the wire again.
  assert.equal(writes, 1);
  assert.deepEqual(outbox.due('discord').map((request) => request.messageId), ['m1']);
  release();
  assert.equal(await answered, false);
  assert.deepEqual(await next, first, 'claimed once the refusal was written, for the same act');
  assert.equal(writes, 2);
}));

test("a claim records as unanswered its server's request still on the wire, whose answer couldn't be written, and asks again", { skip: asRoot }, withLedger(async (outbox, h) => {
  await activeBatch(outbox, [ref('m1'), { ...ref('m2'), serverId: 'discord-2' }]);
  const other = (await outbox.claim('discord-2'))!;
  const request = (await outbox.claim('discord'))!;
  // The answer's write fails, so the file still holds the request on the wire.
  chmodSync(dirname(h.path), 0o500);
  await assert.rejects(outbox.recordOutcome(request, 'confirmed'), /EACCES/);
  chmodSync(dirname(h.path), 0o700);
  assert.deepEqual(h.entry('m1').sending, { action: 'add', due: request.due });
  assert.deepEqual(outbox.due('discord'), [], 'nothing is owed while it is marked on the wire');
  // The server's next claim releases it: it may have landed, and the add is asked again.
  const again = (await outbox.claim('discord'))!;
  assert.deepEqual([again.messageId, again.due], ['m1', request.due]);
  assert.deepEqual([h.entry('m1').mayLand, h.entry('m1').attempts, h.entry('m1').confirmed], [['add'], 1, 'unknown']);
  // Another server's request on the wire is its own pass's.
  assert.deepEqual(h.entry('m2').sending, { action: 'add', due: other.due });
}));

test('an act that throws after changing the document leaves memory as the file holds it', withLedger(async (outbox, h) => {
  const left = (await outbox.prepare(input([ref('m1')])))!;
  const restarted = h.open();
  await assert.rejects(restarted.recoverAtStartup(() => { throw new Error('injected announce failure'); }), /injected announce failure/);
  assert.equal(statusOf(restarted, left.id), 'prepared', 'not retired in memory either');
  assert.deepEqual((await restarted.recoverAtStartup()).retired.map((r) => r.batchId), [left.id]);
}));

test('one channel spelled two ways is one reaction: a retract under one spelling decides an older choice under the other', withLedger(async (outbox, h) => {
  const placed = await activeBatch(outbox, [{ serverId: 'discord', channelId: 'c1', messageId: 'm1' }]);
  await answer(outbox, 'm1', 'confirmed');
  const later = (await outbox.prepare(input([{ serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' }], { targetBranch: 'rollback/cairn/2' })))!;
  await outbox.retract(placed.id);
  assert.equal(await outbox.activate(later.id), 0, 'the retract decides the reaction, however its channel is spelled');
  assert.equal(h.file().entries.length, 1);
}));

test('reactions on one message by other routes or emoji are separate entries', withLedger(async (outbox, h) => {
  await activeBatch(outbox, [ref('m1'), { ...ref('m1'), serverId: 'discord-2' }]);
  await activeBatch(outbox, [ref('m1')], { emoji: '🫥', targetBranch: 'rollback/cairn/2' });
  assert.equal(h.file().entries.length, 3);
  assert.deepEqual(outbox.due().map((r) => `${r.serverId}:${r.emoji}`).sort(), ['discord-2:💤', 'discord:💤', 'discord:🫥']);
}));

test('a new act owes its request with fresh attempts, and a confirmation clears them', withLedger(async (outbox, h) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  await answer(outbox, 'm1', 'failed');
  assert.equal(h.entry('m1').attempts, 1);
  await outbox.retract(batch.id);
  assert.deepEqual([h.entry('m1').attempts, h.entry('m1').due !== null], [0, true], 'the retract owes a removal with fresh attempts');
  await answer(outbox, 'm1', 'failed');
  await answer(outbox, 'm1', 'confirmed');
  assert.deepEqual([h.entry('m1').attempts, h.entry('m1').due, h.entry('m1').confirmed], [0, null, 'absent']);
}));

test('a request never answered stays one that may land after a later one is confirmed', withLedger(async (outbox, h) => {
  await activeBatch(outbox, [ref('m1')]);
  await answer(outbox, 'm1', 'unknown');
  await answer(outbox, 'm1', 'confirmed');
  assert.deepEqual([h.entry('m1').mayLand, h.entry('m1').confirmed], [['add'], 'present']);
  assert.equal(batches(outbox)[0]!.mayStillLand, 1);
}));

test('an answer is refused for a request not on the wire, for another act, or for the other action', withLedger(async (outbox) => {
  await activeBatch(outbox, [ref('m1')]);
  const request = (await outbox.claim('discord'))!;
  await assert.rejects(outbox.recordOutcome({ ...request, action: 'remove' }, 'confirmed'), /No remove for discord:g1:c1\/m1 is on the wire/);
  await assert.rejects(outbox.recordOutcome({ ...request, due: request.due - 1 }, 'confirmed'), /No add for discord:g1:c1\/m1 is on the wire/);
  await outbox.recordOutcome(request, 'confirmed');
  await assert.rejects(outbox.recordOutcome(request, 'confirmed'), /No add for discord:g1:c1\/m1 is on the wire/, 'already answered');
}));

test('the store is synced before a write that activates, completes or retires a batch, and a failed sync writes nothing', withLedger(async (outbox, h) => {
  const batch = (await outbox.prepare(input([ref('m1')])))!;
  const sync = h.store.sync.bind(h.store);
  let syncs = 0;
  (h.store as any).sync = () => { syncs++; throw new Error('injected sync failure'); };
  const before = readFileSync(h.path, 'utf8');
  await assert.rejects(outbox.activate(batch.id), /injected sync failure/);
  await assert.rejects(outbox.discard(batch.id), /injected sync failure/);
  await assert.rejects(outbox.completeSuppression(batch.id), /injected sync failure/);
  const announced: string[][] = [];
  await assert.rejects(h.open().recoverAtStartup((planned) => { announced.push(planned.retired.map((r) => r.batchId)); }), /injected sync failure/);
  assert.deepEqual(announced, [[batch.id]], 'the start announced the retirement it then could not write');
  assert.equal(readFileSync(h.path, 'utf8'), before);
  assert.equal(syncs, 4);
  // A retract, a claim and an answer assert nothing about the store.
  (h.store as any).sync = () => { syncs++; return sync(); };
  await outbox.retract(batch.id);
  await answer(outbox, 'm1', 'confirmed');
  assert.equal(syncs, 4);
  (h.store as any).sync = sync;
}));

test("an operator's request the ledger won't carry out is a refusal; a ledger failure is not", { skip: asRoot }, withLedger(async (outbox, h) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  await assert.rejects(outbox.cancel('no-such-batch'), DiscordAwarenessRefusal);
  await assert.rejects(outbox.retract('no-such-batch'), DiscordAwarenessRefusal);
  chmodSync(dirname(h.path), 0o500);
  await assert.rejects(outbox.cancel(batch.id), (error) => !(error instanceof DiscordAwarenessRefusal) && /EACCES/.test((error as Error).message));
}));

test('a retract request can be cancelled by the id its receipt returned, even after a restart', withLedger(async (outbox, h) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  await answer(outbox, 'm1', 'confirmed');
  const { requestId } = await outbox.retract(batch.id);
  await answer(outbox, 'm1', 'unknown');
  const restarted = h.open();
  assert.deepEqual(await restarted.cancel(requestId, 'op'), { target: requestId, kind: 'retract', cancelled: 0, confirmed: 0, mayStillLand: 1 });
  assert.deepEqual(restarted.due('discord'), []);
  assert.equal(retracts(restarted)[0].cancelled?.by, 'op');
}));

test('outside error text is bounded, at the default bound and at a small one', () => {
  assert.equal(boundDiscordAwarenessText('short'), 'short');
  const huge = `${'x'.repeat(300)}${'界'.repeat(500_000)}😀tail`;
  const bounded = boundDiscordAwarenessText(huge);
  assert.ok(bounded.length <= 500, `bounded to ${bounded.length}`);
  assert.match(bounded, /chars omitted/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(bounded), 'no lone surrogate');
  // A bound smaller than the marker keeps no head, rather than nearly all of it.
  assert.ok(boundDiscordAwarenessText('y'.repeat(1_000), 40).length < 100);
});

test('a bounded text never splits a surrogate pair at either cut', () => {
  // At the default bound of 500 each cut lands inside an emoji here.
  const text = `${'a'.repeat(359)}😀${'x'.repeat(1000)}😀${'b'.repeat(99)}`;
  const bounded = boundDiscordAwarenessText(text);
  const parts = /^([\s\S]*) … \[(\d+) chars omitted\] … ([\s\S]*)$/.exec(bounded);
  assert.ok(parts, bounded);
  const [, head, omitted, tail] = parts;
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!lone.test(head!) && !lone.test(tail!), 'no surrogate pair is split at either cut');
  assert.ok(text.startsWith(head!) && text.endsWith(tail!));
  assert.equal(head!.length + Number(omitted) + tail!.length, text.length, 'the count omitted is what lies between');
});

test('Discord refusals that no retry can change are permanent', () => {
  for (const text of ['Unknown Message', 'Unknown Channel', 'Unknown Emoji', 'Missing Access', 'Missing Permissions',
    'Missing Permission', 'Cannot access this channel', 'Channel 123456789012345678 not found',
    'Message 123456789012345678 not found', 'Maximum number of reactions reached (20)', 'Reaction was blocked']) {
    assert.equal(isPermanentDiscordReactionFailure(text), true, text);
  }
  for (const text of ['Internal Server Error', 'You are being rate limited.', 'did not respond within 10000ms']) {
    assert.equal(isPermanentDiscordReactionFailure(text), false, text);
  }
});

// ---------------------------------------------------------------------------
// Framework seams, with stubbed collaborators
// ---------------------------------------------------------------------------

function storeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'discord-awareness-fw-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  const path = defaultDiscordAwarenessOutboxPath(join(dir, 'store'));
  return {
    dir,
    store,
    path,
    outbox: new DiscordAwarenessOutbox(path, { store }),
    entry: (messageId: string) => JSON.parse(readFileSync(path, 'utf8')).entries.find((e: any) => e.messageId === messageId),
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

/** A bare framework that drains through `connection`. */
function drainingFramework(outbox: DiscordAwarenessOutbox, connection: (id: string) => unknown) {
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.discordAwarenessOutbox = outbox;
  framework.discordAwarenessDrains = new Map();
  framework.discordAwarenessDrainsJoined = new Set();
  framework.operatorOperations = new Set();
  framework.mcplServerConfigs = new Map();
  framework.discordAwarenessDeadlineMs = 1000;
  framework.mcplServerRegistry = { getServer: (id: string) => connection(id) };
  framework.operatorLog = new OperatorLog(undefined);
  framework.opsAlert = () => {};
  return framework;
}

test("the framework's cancel and retract are operator operations, which stop() waits for", withLedger(async (outbox) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  const framework = drainingFramework(outbox, () => null);
  for (const [label, act] of [
    ['awareness:cancel', () => framework.cancelDiscordAwareness(batch.id)],
    ['awareness:retract', () => framework.retractDiscordAwareness(batch.id)],
  ] as const) {
    const pending = act();
    assert.deepEqual([...framework.operatorOperations].map((op: { label: string }) => op.label), [label]);
    await muted(() => pending);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(framework.operatorOperations.size, 0);
  }
}));

test('framework drain classifies outcomes from what reached the server', async () => {
  const h = storeHarness();
  try {
    const all = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'];
    await activeBatch(h.outbox, all.map((m) => ref(m)));
    const calls: string[] = [];
    const channels = new Set<unknown>();
    let connected = true;
    const connection = {
      get isConnected() { return connected; },
      sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${args.messageId}`);
        channels.add(args.channelId);
        if (args.messageId === 'm2') return { isError: true, content: [{ type: 'text', text: 'Unknown Message' }] };
        if (args.messageId === 'm3') throw new McplRequestError('Cannot send request: connection to "discord" is closed', 'not-sent');
        if (args.messageId === 'm4') throw new McplRequestError('did not respond', 'no-response');
        if (args.messageId === 'm6') throw new McplRequestError('Internal error', 'error-response');
        if (args.messageId === 'm7') throw new TypeError('transport went away');
        // A refusal no retry can change, answered as a JSON-RPC error.
        if (args.messageId === 'm8') throw new McplRequestError('The "discord" server answered with an error: Unknown Message', 'error-response');
        // One whose words say so only past what the bound keeps.
        if (args.messageId === 'm9') return { isError: true, content: [{ type: 'text', text: `${'x'.repeat(400)} Unknown Channel ${'y'.repeat(400)}` }] };
        // The server's own words, carrying its configured token.
        if (args.messageId === 'm10') throw new McplRequestError('rejected token sekrit-token-value-123', 'no-response');
        return { content: [{ type: 'text', text: 'Reaction applied' }] };
      },
    };
    const framework = drainingFramework(h.outbox, () => connection);
    framework.mcplServerConfigs.set('discord', { id: 'discord', command: 'unused', token: 'sekrit-token-value-123' });
    const alerts: Array<{ kind: string; message: string }> = [];
    framework.opsAlert = (kind: string, _agent: string, message: string) => { alerts.push({ kind, message }); };
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await framework.drainDiscordAwarenessOutbox('discord');
    } finally {
      console.error = error;
    }
    assert.deepEqual(calls.sort(), all.map((m) => `add_reaction:${m}`).sort());
    assert.deepEqual([...channels], ['c1'], 'sent to the Discord channel id');
    assert.equal(h.entry('m1').confirmed, 'present');
    assert.deepEqual([h.entry('m2').failed, h.entry('m2').due], [true, null], 'Discord said the message is gone: final');
    assert.deepEqual([h.entry('m8').failed, h.entry('m8').due, h.entry('m8').mayLand], [true, null, undefined], 'a JSON-RPC refusal no retry can change: final');
    assert.deepEqual([h.entry('m9').failed, h.entry('m9').due], [true, null], 'classified on the whole text');
    assert.ok(logged.some((line) => line.includes('m10') && line.includes('rejected token')), logged.join('\n'));
    assert.ok(!logged.some((line) => line.includes('sekrit-token-value-123')), 'the configured token is redacted from the log');
    assert.deepEqual([h.entry('m3').attempts, h.entry('m3').mayLand], [0, undefined], 'never written: still owed, no attempt');
    for (const m of ['m4', 'm6', 'm7', 'm10']) {
      // A JSON-RPC error may come after the server acted, and an error the
      // connection did not classify may follow a write.
      assert.deepEqual([h.entry(m).confirmed, h.entry(m).mayLand, h.entry(m).attempts], ['unknown', ['add'], 1], `${m}: written, no answer`);
    }
    assert.equal(alerts.length, 1, 'one alert for the pass');
    assert.equal(alerts[0].kind, 'discord-awareness-delivery');
    assert.match(alerts[0].message, /^Nothing more is sent for 3 awareness mark\(s\) on discord: .*add discord:g1:c1\/m2: failed: Unknown Message/);

    // A disconnected route leaves its work queued without writing anything.
    connected = false;
    const before = readFileSync(h.path, 'utf8');
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.equal(readFileSync(h.path, 'utf8'), before);

    // Back online: the unsent and the unanswered go again.
    connected = true;
    calls.length = 0;
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls.sort(), ['add_reaction:m10', 'add_reaction:m3', 'add_reaction:m4', 'add_reaction:m6', 'add_reaction:m7']);
  } finally {
    h.cleanup();
  }
});

test('a drain whose route goes away stops claiming: the rest stays queued, with no request written ahead', async () => {
  const h = storeHarness();
  try {
    await activeBatch(h.outbox, [ref('m1'), ref('m2'), ref('m3')]);
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
    const framework = drainingFramework(h.outbox, () => connection);
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls, ['m1']);
    assert.deepEqual(['m1', 'm2', 'm3'].map((m) => [h.entry(m).attempts, h.entry(m).sending]),
      [[1, undefined], [0, undefined], [0, undefined]], 'only the request that was on the wire');
    assert.equal(h.outbox.due('discord').length, 3, 'its unanswered one and the two unsent stay owed');
  } finally {
    h.cleanup();
  }
});

test('a trigger that joined a pass whose route went away gets a pass of its own, on the connection that replaced it', async () => {
  const h = storeHarness();
  try {
    await activeBatch(h.outbox, [ref('m1'), ref('m2')]);
    const sent: string[] = [];
    let framework: any;
    let current: unknown;
    const replacement = {
      isConnected: true,
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        sent.push(`new:${args.messageId}`);
        return { content: [{ type: 'text', text: 'Reaction applied' }] };
      },
    };
    const original = {
      isConnected: true,
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        sent.push(`old:${args.messageId}`);
        // The server restarts while this request is out: its old connection
        // goes, and the new one's delivery joins the pass still running.
        original.isConnected = false;
        current = replacement;
        void framework.drainDiscordAwarenessOutbox('discord');
        throw new McplRequestError('closed while awaiting response', 'no-response');
      },
    };
    current = original;
    framework = drainingFramework(h.outbox, () => current);
    await muted(async () => {
      await framework.drainDiscordAwarenessOutbox('discord');
      const deadline = Date.now() + 5_000;
      while (sent.length < 3 || framework.discordAwarenessDrains.size > 0) {
        assert.ok(Date.now() < deadline, `timed out: ${JSON.stringify(sent)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    assert.deepEqual(sent, ['old:m1', 'new:m1', 'new:m2']);
  } finally {
    h.cleanup();
  }
});

test("a delivery whose ledger write fails is reported where it was started, and the next pass asks again", { skip: asRoot }, withLedger(async (outbox, h) => {
  await activeBatch(outbox, [ref('m1')]);
  const connection = {
    isConnected: true,
    sendToolsCallWithDeadline: async (): Promise<unknown> => {
      // The ledger's directory refuses the answer's write.
      chmodSync(dirname(h.path), 0o500);
      return { content: [{ type: 'text', text: 'Reaction applied' }] };
    },
  };
  const framework = drainingFramework(outbox, () => connection);
  const alerts: Array<{ kind: string; message: string }> = [];
  framework.opsAlert = (kind: string, _agent: string, message: string) => { alerts.push({ kind, message }); };
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    framework.deliverDiscordAwarenessInBackground('connect', 'host');
    const deadline = Date.now() + 5_000;
    while (alerts.length === 0) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the delivery alert');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    console.error = error;
    chmodSync(dirname(h.path), 0o700);
  }
  assert.equal(alerts[0]!.kind, 'discord-awareness-delivery');
  assert.match(alerts[0]!.message, /^Awareness mark delivery after connect failed: .*outcome write.*EACCES/);
  assert.ok(logged.some((line) => line.startsWith('[discord-awareness] delivery after connect failed: ')), logged.join('\n'));
  assert.ok(h.entry('m1').sending, 'the file still holds the request on the wire');
  // The next pass releases it: it may have landed, and the add is asked again.
  connection.sendToolsCallWithDeadline = async () => ({ content: [{ type: 'text', text: 'Reaction applied' }] });
  await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
  assert.deepEqual([h.entry('m1').confirmed, h.entry('m1').mayLand, h.entry('m1').due], ['present', ['add'], null]);
}));

test('a request written ahead as stop() begins is not sent, and stays owed', async () => {
  const h = storeHarness();
  try {
    await activeBatch(h.outbox, [ref('m1'), ref('m2')]);
    const calls: string[] = [];
    const connection = {
      isConnected: true,
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        calls.push(String(args.messageId));
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const framework = drainingFramework(h.outbox, () => connection);
    const claim = h.outbox.claim.bind(h.outbox);
    h.outbox.claim = async (serverId, skip) => {
      const request = await claim(serverId, skip);
      framework.stopPromise = Promise.resolve(); // stop() begins while it was written
      return request;
    };
    await muted(() => framework.drainDiscordAwarenessOutbox('discord'));
    assert.deepEqual(calls, []);
    assert.deepEqual([h.entry('m1').sending, h.entry('m1').attempts], [undefined, 0]);
    assert.equal(h.outbox.due('discord').length, 2);
  } finally {
    h.cleanup();
  }
});

test('a retract made just after a drain finds nothing owed is delivered on its own trigger', async () => {
  // A drain that had made its final claim but not yet left the registry
  // would be handed the retract's trigger and never look again: the removal
  // would stay owed until some unrelated trigger. Each depth puts the
  // retract one microtask further from that final claim.
  const sent: Record<number, string[]> = {};
  const owed: Record<number, number> = {};
  for (const depth of [0, 1, 2, 3]) {
    const h = storeHarness();
    try {
      const batch = await activeBatch(h.outbox, [ref('m1')]);
      const calls: string[] = [];
      const connection = {
        isConnected: true,
        sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
          calls.push(`${name}:${args.messageId}`);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      };
      const framework = drainingFramework(h.outbox, () => connection);
      const claim = h.outbox.claim.bind(h.outbox);
      let retracted: Promise<void> | undefined;
      h.outbox.claim = (serverId, skip) => {
        const claimed = claim(serverId, skip);
        void claimed.then((request) => {
          if (request || retracted) return;
          retracted = (async () => {
            for (let i = 0; i < depth; i++) await null;
            await framework.retractDiscordAwareness(batch.id);
          })();
        });
        return claimed;
      };
      await muted(async () => {
        await framework.drainDiscordAwarenessOutbox('discord');
        while (!retracted) await new Promise((resolve) => setImmediate(resolve));
        await retracted;
        // Bounded, and yielding to timers, so a drain left registered fails
        // the test rather than spinning it.
        const deadline = Date.now() + 5000;
        while (framework.discordAwarenessDrains.size > 0 || h.outbox.due('discord').length > 0) {
          assert.ok(Date.now() < deadline, 'every drain pass left the registry, and nothing stayed owed, within 5 s');
          await Promise.allSettled([...framework.discordAwarenessDrains.values()]);
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      sent[depth] = calls;
      owed[depth] = h.outbox.due('discord').length;
    } finally {
      h.cleanup();
    }
  }
  const delivered = ['add_reaction:m1', 'remove_reaction:m1'];
  assert.deepEqual(sent, { 0: delivered, 1: delivered, 2: delivered, 3: delivered });
  assert.deepEqual(owed, { 0: 0, 1: 0, 2: 0, 3: 0 });
});

test('one drain pass per server: a request made owed while its reply is out joins the pass, which sends it next', async () => {
  const h = storeHarness();
  try {
    await activeBatch(h.outbox, [ref('m1')]);
    const calls: string[] = [];
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => { answerFirst = resolve; });
    const connection = {
      isConnected: true,
      sendToolsCallWithDeadline: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${args.messageId}`);
        if (calls.length === 1) await firstAnswered;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const framework = drainingFramework(h.outbox, () => connection);
    await muted(async () => {
      const first = framework.drainDiscordAwarenessOutbox('discord');
      while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      // Work for another message while m1's reply is out. Only the registry
      // holds it back: the reaction's own `sending` guards only m1.
      await activeBatch(h.outbox, [ref('m2')], { targetBranch: 'rollback/cairn/2' });
      void framework.drainDiscordAwarenessOutbox('discord');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ['add_reaction:m1'], 'nothing more leaves while the reply is out');
      answerFirst();
      assert.deepEqual(await first, { status: 'delivered', delivered: 2, failed: 0 });
      assert.deepEqual(calls, ['add_reaction:m1', 'add_reaction:m2'], 'the joined pass sent the new work');
      assert.equal(framework.discordAwarenessDrains.size, 0);
      // A pass with nothing owed leaves once its claim finds nothing.
      await framework.drainDiscordAwarenessOutbox('discord');
      assert.equal(framework.discordAwarenessDrains.size, 0);
    });
  } finally {
    h.cleanup();
  }
});

test('a sync for one server drains only that server', async () => {
  const h = storeHarness();
  try {
    await activeBatch(h.outbox, [ref('m1'), { serverId: 'discord-b', channelId: 'discord:g2:c1', messageId: 'n1' }]);
    const calls: string[] = [];
    const framework = drainingFramework(h.outbox, (id: string) => ({
      isConnected: true,
      sendToolsCallWithDeadline: async (_name: string, args: Record<string, unknown>) => {
        calls.push(`${id}:${args.messageId}`);
        return { content: [{ type: 'text', text: 'Reaction added' }] };
      },
    }));
    // A sync is an operator's operation, which stop() waits for.
    framework.operatorOperations = new Set();
    await muted(() => framework.syncDiscordAwarenessMarkers('discord-b'));
    assert.deepEqual(calls, ['discord-b:n1']);
    await muted(() => framework.syncDiscordAwarenessMarkers());
    assert.deepEqual(calls, ['discord-b:n1', 'discord:m1']);
  } finally {
    h.cleanup();
  }
});

test("the framework's retract and cancel each record their act in the operator log, done or refused", withLedger(async (outbox) => {
  const batch = await activeBatch(outbox, [ref('m1')]);
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.discordAwarenessOutbox = outbox;
  framework.operatorOperations = new Set();
  framework.deliverDiscordAwarenessInBackground = () => {};
  const logged: Array<Record<string, any>> = [];
  framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
  const requester = { via: 'test', name: 'op' };
  let retracted: unknown;
  let cancelled: unknown;
  await muted(async () => {
    retracted = await framework.retractDiscordAwareness(batch.id, { requester });
    cancelled = await framework.cancelDiscordAwareness(batch.id, { requester });
    await assert.rejects(framework.retractDiscordAwareness('no-such-batch', { requester }),
      (error) => error instanceof Error && (error as { code?: string }).code === 'invalid' && /not found/.test(error.message));
  });
  assert.deepEqual(logged.map((entry) => [entry.kind, entry.agent, entry.requester, entry.params]), [
    ['awareness-retract', '*', requester, { target: batch.id }],
    ['awareness-cancel', '*', requester, { target: batch.id }],
    ['awareness-retract', '*', requester, { target: 'no-such-batch' }],
  ]);
  assert.deepEqual(logged.slice(0, 2).map((entry) => entry.result), [retracted, cancelled].map((receipt) => ({ ...(receipt as object) })));
  assert.match(logged[2].error, /not found/, 'a refused act is recorded with its refusal');
}));

/** A bare framework that resumes suppressions on `branch` from `cm`. */
function resumingFramework(outbox: DiscordAwarenessOutbox, branch: string, cm: unknown) {
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.discordAwarenessOutbox = outbox;
  framework.store = { currentBranch: () => ({ name: branch }) };
  framework.agents = new Map([['cairn', { getContextManager: () => cm }]]);
  framework.opsAlert = () => {};
  return framework;
}

const suppression = (intervals: Array<{ fromId: string; toId: string }>) =>
  input([ref('m1')], { targetBranch: 'recovery/cairn/suppressed', suppressionIntervals: intervals });

test("framework finishes an interrupted suppression's removals and retires its marks, with an alert that names the redo", async () => {
  const h = storeHarness();
  try {
    const batch = (await h.outbox.prepare(suppression([{ fromId: 'i1', toId: 'i2' }, { fromId: 'i3', toId: 'i3' }])))!;
    const present = new Set(['i1', 'i2']); // i3 interval committed before crash.
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => { present.delete(from); present.delete(to); removals.push(`${from}..${to}`); },
    };
    // The batch is retired only once its removals are made.
    const complete = h.outbox.completeSuppression.bind(h.outbox);
    const presentAtCompletion: string[][] = [];
    h.outbox.completeSuppression = (batchId: string, announceRetirement?: () => void) => {
      presentAtCompletion.push([...present]);
      return complete(batchId, announceRetirement);
    };
    const alerts: Array<{ kind: string; agent: string; message: string }> = [];
    const framework = resumingFramework(h.outbox, 'recovery/cairn/suppressed', cm);
    framework.opsAlert = (kind: string, agent: string, message: string) => { alerts.push({ kind, agent, message }); };
    await muted(() => framework.resumePreparedDiscordSuppressions());
    assert.deepEqual(presentAtCompletion, [[]], 'completed once, with the interval already removed');
    assert.deepEqual(removals, ['i1..i2']);
    assert.equal(statusOf(h.outbox, batch.id), 'retired', "a start never activates a surgery's marks");
    assert.deepEqual(h.outbox.due('discord'), []);
    assert.deepEqual(alerts.map((alert) => [alert.kind, alert.agent]), [['discord-awareness-not-scheduled', 'cairn']]);
    assert.equal(
      alerts[0]!.message,
      `The surgery of cairn from main onto recovery/cairn/suppressed (awareness batch ${batch.id}: a suppression, or an ` +
        'offline recovery that suppressed) was interrupted; this start finished its removals on recovery/cairn/suppressed. ' +
        'Its 1 awareness mark(s) weren\'t applied, since a start never activates a surgery\'s marks. To apply them, redo ' +
        'the surgery from main, if it still has every message the surgery removed, onto a new branch name, with its marks',
    );
  } finally {
    h.cleanup();
  }
});

test('framework finishes the body of a suppression an operator cancelled, retires it, and raises no alert', async () => {
  const h = storeHarness();
  try {
    const batch = (await h.outbox.prepare(suppression([{ fromId: 'i1', toId: 'i2' }])))!;
    await h.outbox.cancel(batch.id, 'operator');
    const present = new Set(['i1', 'i2']);
    const removals: string[] = [];
    const cm = {
      getMessage: (id: string) => present.has(id) ? { id } : null,
      removeMessage: (id: string) => { present.delete(id); removals.push(id); },
      removeMessages: (from: string, to: string) => { present.delete(from); present.delete(to); removals.push(`${from}..${to}`); },
    };
    const alerts: string[] = [];
    const framework = resumingFramework(h.outbox, 'recovery/cairn/suppressed', cm);
    framework.opsAlert = (kind: string) => { alerts.push(kind); };
    await muted(() => framework.resumePreparedDiscordSuppressions());
    assert.deepEqual(removals, ['i1..i2'], "the body is the store's integrity, whatever became of the marks");
    const after = new DiscordAwarenessOutbox(h.path).batches().find((candidate) => candidate.id === batch.id)!;
    assert.ok(after.cancelled);
    assert.equal(after.status, 'retired', 'retired, never activated');
    assert.deepEqual(alerts, [], 'its marks were cancelled, and its body is finished: nothing to redo');
  } finally {
    h.cleanup();
  }
});

test('a resumed suppression removes a one-shard body as a range and a message outside any body alone', async () => {
  const h = storeHarness();
  try {
    const batch = (await h.outbox.prepare(suppression([{ fromId: 'plain', toId: 'plain' }, { fromId: 'shard', toId: 'shard' }])))!;
    const present = new Set(['plain', 'shard']);
    const removals: string[] = [];
    // As context-manager 0.14 does, removeMessage refuses a shard, a
    // one-shard body's included.
    const cm = {
      getMessage: (id: string) => present.has(id)
        ? { id, ...(id === 'shard' ? { bodyGroupId: 'doc', shardIndex: 0 } : {}) }
        : null,
      removeMessage: (id: string) => {
        if (id === 'shard') throw new Error(`Cannot remove shard ${id} in isolation: it is part of bodyGroup doc.`);
        present.delete(id);
        removals.push(id);
      },
      removeMessages: (from: string, to: string) => {
        present.delete(from); present.delete(to); removals.push(`${from}..${to}`);
      },
    };
    await muted(() => resumingFramework(h.outbox, 'recovery/cairn/suppressed', cm).resumePreparedDiscordSuppressions());
    assert.deepEqual(removals, ['shard..shard', 'plain']);
    assert.equal(statusOf(h.outbox, batch.id), 'retired', "a start never activates a surgery's marks");
  } finally {
    h.cleanup();
  }
});

test('a resumed suppression skips an interval that committed before the crash, and refuses one only partly present', async () => {
  const run = async (present: Set<string>) => {
    const h = storeHarness();
    try {
      const batch = (await h.outbox.prepare(suppression([{ fromId: 'a0', toId: 'a1' }, { fromId: 'b0', toId: 'b1' }])))!;
      const removals: string[] = [];
      const cm = {
        getMessage: (id: string) => (present.has(id) ? { id } : null),
        removeMessage: (id: string) => { present.delete(id); removals.push(id); },
        removeMessages: (from: string, to: string) => { present.delete(from); present.delete(to); removals.push(`${from}..${to}`); },
      };
      const outcome = await muted(() => resumingFramework(h.outbox, 'recovery/cairn/suppressed', cm).resumePreparedDiscordSuppressions())
        .then(() => 'resumed', (error: Error) => error.message);
      return { outcome, removals, status: statusOf(h.outbox, batch.id) };
    } finally {
      h.cleanup();
    }
  };

  // The later interval committed before the crash: only the earlier is removed.
  const committed = await run(new Set(['a0', 'a1']));
  assert.equal(committed.outcome, 'resumed');
  assert.deepEqual(committed.removals, ['a0..a1']);
  assert.equal(committed.status, 'retired', "a start never activates a surgery's marks");

  // An interval with one end gone isn't safe to finish.
  const partial = await run(new Set(['a0', 'a1', 'b0']));
  assert.match(partial.outcome, /interval b0\.\.b1 is only partially present/);
  assert.deepEqual(partial.removals, []);
  assert.equal(partial.status, 'prepared');
});

test("a version 2 ledger's batch is reported in its own words: its retirement is only logged", () => {
  const alerts: Array<{ kind: string; message: string; key?: string }> = [];
  const logged: string[] = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.opsAlert = (kind: string, _agent: string, message: string, opts?: { key?: string }) => { alerts.push({ kind, message, key: opts?.key }); };
  const base = { agentName: 'cairn', sourceBranch: 'main', targetBranch: 'legacy/x', marks: 0, suppression: true, imported: true };
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    framework.reportRetiredAwareness({ ...base, batchId: 'done-x' }, { finished: true });
    framework.reportRetiredAwareness({ ...base, batchId: 'old-x', suppression: false, targetBranch: 'main' });
  } finally {
    console.error = error;
  }
  assert.deepEqual(alerts, []);
  assert.deepEqual(logged, [
    '[discord-awareness] this start retires version 2 awareness batch done-x of cairn, having finished its removals on legacy/x',
    '[discord-awareness] this start retires version 2 awareness batch old-x of cairn',
  ]);
});

/** A bare framework whose ops alerts reach a stubbed webhook. */
function alertingFramework() {
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.opsAlertLastSent = new Map<string, number>();
  framework.opsAlertCooldownMs = 15 * 60_000;
  framework.logFailure = () => {};
  framework.traceListeners = [];
  return framework;
}

async function withWebhook(t: { mock: { method: (...args: any[]) => unknown } }, fn: () => Promise<void> | void): Promise<string[]> {
  const posts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: { body?: string }) => { posts.push(String(init?.body)); return new Response(null); });
  const hook = process.env.CONNECTOME_OPS_WEBHOOK;
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://127.0.0.1:9/ops';
  const error = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = error;
    if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK; else process.env.CONNECTOME_OPS_WEBHOOK = hook;
  }
  return posts;
}

test('two retirements for one agent each reach the ops webhook within its cooldown', async (t) => {
  const posts = await withWebhook(t, () => {
    const framework = alertingFramework();
    const base = { agentName: 'cairn', sourceBranch: 'main', marks: 1, suppression: false };
    framework.reportRetiredAwareness({ ...base, batchId: 'b1', targetBranch: 'rollback/cairn/1' });
    framework.reportRetiredAwareness({ ...base, batchId: 'b2', targetBranch: 'rollback/cairn/2' });
    // The same batch's alert again is still bounded by the cooldown.
    framework.reportRetiredAwareness({ ...base, batchId: 'b1', targetBranch: 'rollback/cairn/1' });
  });
  assert.equal(posts.length, 2);
  assert.match(posts[0]!, /awareness batch b1/);
  assert.match(posts[1]!, /awareness batch b2/);
});

test('each kind of retirement alert a start raises reaches the ops webhook for two batches within its cooldown', async (t) => {
  const posts = await withWebhook(t, () => {
    const framework = alertingFramework();
    const agent = { agentName: 'cairn', sourceBranch: 'main' };
    for (const n of [1, 2]) {
      // An interrupted rollback's unapplied marks, and an interrupted
      // suppression's, whose body this start finished.
      framework.reportRetiredAwareness({ ...agent, batchId: `interrupted-${n}`, targetBranch: `rollback/cairn/${n}`, marks: 1, suppression: false });
      framework.reportRetiredAwareness({ ...agent, batchId: `finished-${n}`, targetBranch: `suppress/cairn/${n}`, marks: 1, suppression: true }, { finished: true });
    }
  });
  assert.equal(posts.length, 4, posts.join('\n'));
  for (const kind of ['interrupted', 'finished']) {
    for (const n of [1, 2]) assert.ok(posts.some((post) => new RegExp(`awareness batch ${kind}-${n}[):]`).test(post)), `${kind}-${n}`);
  }
});

test("the per-batch alerts of a surgery whose marks could not be scheduled, or whose batch could not be retired, each reach the ops webhook within its cooldown", async (t) => {
  const posts = await withWebhook(t, async () => {
    const framework = alertingFramework();
    const facts = { scope: 'all', unmarked: 0, notRemoved: 0 };
    // A marker batch whose activation couldn't be recorded, twice.
    for (const id of ['b1', 'b2']) framework.settledMarkerReceipt({ status: 'not-scheduled', error: 'injected' }, id, 1, 'rollback', 'cairn', facts);
    // A failed suppression whose batch couldn't be retired once its source was back, twice.
    framework.store = { currentBranch: () => ({ name: 'main' }), listBranches: () => [] };
    framework.discordAwarenessOutbox = { discard: async () => { throw new Error('injected'); } };
    for (const id of ['f1', 'f2']) {
      await framework.retireAfterRestore({ id, targetBranch: `recovery/cairn/${id}`, suppressionIntervals: [{ fromId: 'i', toId: 'i' }] }, 'main', 'cairn');
    }
  });
  assert.equal(posts.length, 4, posts.join('\n'));
  for (const [index, id] of ['b1', 'b2', 'f1', 'f2'].entries()) assert.match(posts[index]!, new RegExp(`batch ${id}\\b`));
});

test("after a failed surgery, retiring its batch says whether it is retired, or stays prepared with what that leaves", async () => {
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  const alerts: string[] = [];
  framework.opsAlert = (kind: string) => { alerts.push(kind); };
  framework.store = { currentBranch: () => ({ name: 'main' }), listBranches: () => [] };
  const batch = { id: 'f1', targetBranch: 'recovery/cairn/f1', suppressionIntervals: [{ fromId: 'i', toId: 'i' }] };
  framework.discordAwarenessOutbox = { discard: async () => true };
  assert.equal(await framework.retireAfterRestore(batch, 'main', 'cairn'), '; awareness batch f1 retired, none of its marks sent');
  assert.deepEqual(alerts, []);
  framework.discordAwarenessOutbox = { discard: async () => { throw new Error('injected write failure'); } };
  // A batch with no suppression has no removals to leave pending.
  assert.equal(
    await framework.retireAfterRestore({ id: 'f2', targetBranch: 'rollback/cairn/f2' }, 'main', 'cairn'),
    '; awareness batch f2 could not be retired (injected write failure); it stays prepared, none of its marks to be sent, until the next start retires it',
  );
  assert.deepEqual(alerts, []);
  assert.match(
    await framework.retireAfterRestore(batch, 'main', 'cairn'),
    /^; awareness batch f1 could not be retired \(injected write failure\); it stays prepared, none of its marks to be sent\. Its removals stay pending for recovery\/cairn\/f1: a start on a branch with that name would finish them there and retire the batch$/,
  );
  assert.deepEqual(alerts, ['discord-awareness-unresolved']);
});

test('the start that rewrites a version 2 ledger raises one alert naming each batch whose undelivered marks it dropped', withLedger(async (_outbox, h) => {
  writeLedger(h, {
    version: 2,
    batches: [
      { id: 'never', status: 'prepared', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1',
        emoji: '💤', createdAt: 1, refs: [legacyEntry('m1'), legacyEntry('m2')] },
      { id: 'queued', status: 'active', agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/2',
        emoji: '💤', createdAt: 2, refs: [
          legacyEntry('m3', { desired: true, deliveryStatus: 'pending' }),
          legacyEntry('m4', { markerPresent: true, deliveryStatus: 'pending' }),
          legacyEntry('m5', { desired: true, markerPresent: true }),
        ] },
    ],
  });
  const alerts: Array<{ kind: string; agent: string; message: string }> = [];
  const logged: string[] = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.discordAwarenessOutbox = h.open({ announceImport: (unsent) => framework.announceDiscordAwarenessImport(unsent) });
  framework.opsAlert = (kind: string, agent: string, message: string) => { alerts.push({ kind, agent, message }); };
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await framework.reconcileDiscordAwarenessAtStartup();
  } finally {
    console.error = error;
  }
  const named = 'batch never (cairn, main to rollback/cairn/1): 2 to add, 0 to remove; '
    + 'batch queued (cairn, main to rollback/cairn/2): 1 to add, 1 to remove';
  assert.deepEqual(alerts, [{
    kind: 'discord-awareness-import-unsent',
    agent: 'host',
    message: 'This start rewrites the awareness ledger as version 3, and the marks agent-framework 0.22.x had still to add '
      + `or remove won't be sent, since nobody chose them: ${named}. A batch 0.22.x never activated placed no marks. To `
      + 'take off the marks it placed for a batch it activated, retract that batch through the host command marks '
      + '(action retract): a retract takes off the mark of the batch\'s emoji from each of its messages, whichever '
      + 'batch placed it',
  }]);
  assert.deepEqual(logged, [
    `[discord-awareness] rewriting ${h.path} as version 3: 2 batch(es) had marks agent-framework 0.22.x had still `
      + `to add or remove, and none of them will be sent, since nobody chose them: ${named}. A batch 0.22.x never `
      + 'activated placed no marks; retracting a batch takes off the mark of its emoji from each of its messages, '
      + 'whichever batch placed it',
  ]);
  assert.deepEqual(framework.discordAwarenessOutbox.due('discord'), [], 'nothing was sent');
  assert.deepEqual(h.open().batches().map((b) => [b.id, b.status]), [['never', 'retired'], ['queued', 'active']]);
}));

test('a start on a ledger it cannot read stops, naming the ledger read', withLedger(async (_outbox, h) => {
  writeLedger(h, '{broken');
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.discordAwarenessOutbox = h.open();
  await assert.rejects(framework.reconcileDiscordAwarenessAtStartup(),
    /accounting failed during startup reconciliation: Invalid Discord awareness ledger .*: it isn't JSON$/);
}));

test("a suppression's resume record that could not be closed is logged, and a closed one says nothing", async () => {
  const logged: string[] = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.opsAlert = () => { throw new Error('no alert expected'); };
  const facts = { scope: 'none', unmarked: 0, notRemoved: 0 };
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    framework.discordAwarenessOutbox = { settleActivation: async () => ({ status: 'not-scheduled', error: 'injected; it is retired instead, none of its marks sent' }) };
    assert.deepEqual(await framework.activateSurgeryMarkers({ id: 's1', refs: [] }, 'suppress', 'cairn', facts), { ...facts, status: 'none', queued: 0 });
    framework.discordAwarenessOutbox = { settleActivation: async () => ({ status: 'queued', queued: 0 }) };
    await framework.activateSurgeryMarkers({ id: 's2', refs: [] }, 'suppress', 'cairn', facts);
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, [
    '[discord-awareness] agent=cairn: suppress applied, but its resume record (awareness batch s1, no marks) could not '
      + 'be closed: injected; it is retired instead, none of its marks sent',
  ]);
});

/** A framework stub whose agent context is a plain list (ids i0..), for host/command. */
function hostCommandFramework(outbox: DiscordAwarenessOutbox | null, messages: Array<{ id: string; metadata: Record<string, unknown> }>) {
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
  // The Dendrite registry an undo's fork sweep reads (disposeEmptiedForks); no forks here.
  framework.registry = { homeChannel: () => undefined, list: () => [] };
  framework.agents = new Map([['cairn', { state: { status: 'idle' }, getContextManager: () => contextManager }]]);
  framework.store = { currentBranch: () => ({ name: currentBranch }), listBranches: () => [] };
  framework.discordAwarenessOutbox = outbox;
  framework.discordAwarenessEmoji = '🫥';
  framework.discordAwarenessDrains = new Map();
  framework.discordAwarenessDrainsJoined = new Set();
  framework.operatorOperations = new Set();
  framework.mcplServerRegistry = null;
  framework.moduleRegistry = { getModule: () => null };
  framework.lastVisiblePreview = async () => null;
  framework.activeTurnTokens = new Map();
  framework.nextTurnToken = 1;
  framework.deferredMessages = [];
  framework.pendingAssistantBlocks = new Map();
  // A host/command and a store surgery are operations stop() waits for.
  framework.operatorOperations = new Set();
  // A surgery waits for maintenance work that is running: here, none.
  framework.maintenancePass = null;
  framework.overBudgetDrains = new Set();
  // Its hold wakes maintenance calls parked at the provider gates: here, none.
  framework.providerGates = new Map();
  framework.conversationSpawnsInFlight = new Set();
  framework.conversationAgentHomes = new Map();
  framework.ephemeralRuns = new Map();
  framework.operatorLog = new OperatorLog(undefined);
  framework.opsAlert = () => {};
  return { framework, removed, setBranch: (name: string) => { currentBranch = name; } };
}

test('message-granular host/command undo places no marks unless asked; the marks verb reaches the controls', async () => {
  const h = storeHarness();
  try {
    const { framework, setBranch, removed } = hostCommandFramework(h.outbox, [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
      { id: 'i2', metadata: { ...ref('m2'), tags: ['chat:ambient'] } },
      { id: 'i3', metadata: { ...ref('m3') } },
    ]);
    const logged: Array<Record<string, any>> = [];
    framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
    await muted(async () => {
      // A mistyped choice is refused before anything is removed.
      const typo = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1, marks: 'adressed' });
      assert.equal(typo.ok, false);
      assert.match(typo.error, /marks must be none, addressed or all/);
      assert.equal(removed.size, 0, 'the refused undo removed nothing');
      // A verb that removes nothing takes no choice and ignores the field.
      const listedAnyway = await framework.handleHostCommand('discord', { command: 'marks', action: 'list', marks: null });
      assert.equal(listedAnyway.ok, true);

      const silent = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1 });
      assert.equal(silent.ok, true);
      assert.deepEqual(silent.markers, { scope: 'none', unmarked: 1, notRemoved: 0, status: 'none', queued: 0 });
      assert.deepEqual(h.outbox.due('discord'), []);

      setBranch('main');
      const marked = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 3, marks: 'addressed' });
      assert.equal(marked.markers.status, 'queued');
      assert.equal(marked.markers.queued, 1);
      assert.equal(marked.markers.unmarked, 2);
      assert.deepEqual(h.outbox.due('discord').map((r) => `${r.messageId}${r.emoji}`), ['m1🫥']);

      const listed = await framework.handleHostCommand('discord', { command: 'marks', action: 'list' });
      assert.equal(listed.ok, true);
      const batch = listed.awareness.find((v: { kind: string }) => v.kind === 'batch');
      const cancelled = await framework.handleHostCommand('discord', { command: 'marks', action: 'cancel', target: batch.id, requesterName: 'op' });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.awareness.cancelled, 1);
      assert.deepEqual(h.outbox.due('discord'), []);
      const missing = await framework.handleHostCommand('discord', { command: 'marks', action: 'retract' });
      assert.equal(missing.ok, false);
      // Each undo that removed messages records its marks choice and the
      // receipt it returned, and the verb's cancel records its act.
      const undos = logged.filter((entry) => entry.kind === 'rollback');
      assert.deepEqual(undos.map((entry) => [entry.params?.marks, entry.result?.markers]), [['none', silent.markers], [{ scope: 'addressed' }, marked.markers]]);
      const cancels = logged.filter((entry) => entry.kind === 'awareness-cancel');
      assert.deepEqual(cancels.map((entry) => [entry.params, entry.requester, entry.result]),
        [[{ target: batch.id }, { via: 'host-command:discord', name: 'op' }, cancelled.awareness]]);
    });
  } finally {
    h.cleanup();
  }
});

test('hide and an undo by turns place no marks: a marks choice is refused before anything is removed', async () => {
  const h = storeHarness();
  try {
    const { framework, removed } = hostCommandFramework(h.outbox, [
      { id: 'i0', metadata: { ...ref('m0') } },
      { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
    ]);
    let turnsUndone = 0;
    framework.runUndoLastTurn = () => { turnsUndone++; return { undone: true }; };
    const logged: Array<Record<string, any>> = [];
    framework.recordOperatorAction = (entry: Record<string, unknown>) => { logged.push(entry); return entry; };
    await muted(async () => {
      for (const params of [
        { command: 'hide', agentName: 'cairn', fromMessageId: 'm1', marks: 'all' },
        { command: 'undo', agentName: 'cairn', turns: 1, marks: 'addressed' },
        { command: 'undo', agentName: 'cairn', marks: 'all' },
      ]) {
        const refused = await framework.handleHostCommand('discord', params);
        assert.equal(refused.ok, false, JSON.stringify(params));
        assert.match(refused.error, /^marks apply only to an undo by messages; (hide|an undo by turns) places none \(got "(all|addressed)"\)$/);
      }
      assert.equal(removed.size, 0, 'nothing was hidden');
      assert.equal(turnsUndone, 0, 'no turn was undone');

      const hidden = await framework.handleHostCommand('discord', { command: 'hide', agentName: 'cairn', fromMessageId: 'm1', marks: 'none' });
      assert.equal(hidden.ok, true);
      assert.equal(hidden.hidden, 1);
      assert.equal('markers' in hidden, false);
      const undone = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', turns: 1 });
      assert.equal(undone.ok, true);
      assert.equal(undone.undone, 1);
      assert.equal('markers' in undone, false);
      assert.equal(existsSync(h.path), false, 'neither recorded a batch');
      assert.deepEqual(logged.map((entry) => [entry.kind, entry.params]), [['hide', { fromMessageId: 'm1' }]]);
    });
  } finally {
    h.cleanup();
  }
});

test('a framework with no ledger refuses a marks choice before anything is removed, and its controls refuse; without marks it still undoes', async () => {
  const { framework } = hostCommandFramework(null, [
    { id: 'i0', metadata: { ...ref('m0') } },
    { id: 'i1', metadata: { ...ref('m1'), tags: ['chat:addressed'] } },
  ]);
  await muted(async () => {
    const refused = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1, marks: 'all' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'invalid');
    assert.equal(refused.error, 'marks need the awareness ledger, and this framework has none: it was created with neither storePath nor discordAwarenessOutboxPath');
    assert.equal(framework.store.currentBranch().name, 'main', 'nothing was rolled back');
    const listed = await framework.handleHostCommand('discord', { command: 'marks', action: 'list' });
    assert.deepEqual([listed.ok, listed.awareness], [true, []]);
    const cancel = await framework.handleHostCommand('discord', { command: 'marks', action: 'cancel', target: 'b1' });
    assert.equal(cancel.ok, false);
    assert.equal(cancel.code, 'invalid');
    assert.match(cancel.error, /^This framework has no awareness ledger/);
    const undone = await framework.handleHostCommand('discord', { command: 'undo', agentName: 'cairn', messages: 1 });
    assert.equal(undone.ok, true);
    assert.equal(undone.messagesRemoved, 1);
    assert.deepEqual(undone.markers, { scope: 'none', unmarked: 1, notRemoved: 0, status: 'none', queued: 0 });
  });
});
