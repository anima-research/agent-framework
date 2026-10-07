/**
 * Live surgery and Discord awareness marks, end to end against a fake
 * Discord MCPL server.
 *
 * Field incident (2026-10-07): a web-UI rollback removed 918 Discord messages
 * from a resident's context, and the framework queued a 💤 reaction on every
 * one of them, mostly other people's ambient messages in a busy channel. The
 * rollback awaited the serial reaction drain inside its store reservation and
 * held every MCPL data plane until it finished.
 *
 * The contract these tests pin:
 * - a surgery is local unless the operator chooses marks (`marks`, default
 *   `none`); `addressed` covers messages tagged chat:addressed; a choice
 *   with `refs` marks only those refs, never later arrivals;
 * - the surgery returns with a marker-scheduling receipt, never a delivery
 *   claim, and never fails an applied body change over marker bookkeeping;
 * - delivery runs in the background and never holds MCPL traffic;
 * - cancel and retract are explicit, and their receipts disclose requests
 *   whose outcome is unknown.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, DiscordAwarenessOutbox } from '../src/index.js';
import type { OperatorLogEntry } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/surgery-marks-mcpl-server.mjs', import.meta.url));

function jsonl<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Resolve with the promise's value, or fail if it is still pending after ms. */
async function settlesWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('surgery and awareness marks', () => {
  let dir: string;
  let storePath: string;
  let callsPath: string;
  let eventsPath: string;
  let holdPath: string;
  let probePath: string;
  let framework: AgentFramework;

  const cm = () => framework.getAgent('resident')!.getContextManager();
  const outbox = () => new DiscordAwarenessOutbox(join(storePath, 'recovery', 'discord-awareness-journal.jsonl'));
  const answered = () => jsonl(eventsPath).filter((e) => e.event === 'reaction-answered').length;
  const calls = () => jsonl<{ name: string; args: { messageId: string; emoji: string } }>(callsPath);

  async function start(withDiscord: boolean, awarenessDeadlineMs?: number): Promise<void> {
    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      ...(awarenessDeadlineMs ? { discordAwarenessDeadlineMs: awarenessDeadlineMs } : {}),
      ...(withDiscord ? {
        mcplServers: [{
          id: 'discord',
          command: process.execPath,
          args: [FIXTURE],
          env: { CALLS_PATH: callsPath, EVENTS_PATH: eventsPath, HOLD_PATH: holdPath, PROBE_PATH: probePath },
          enabledFeatureSets: ['chat'],
        }],
      } : {}),
    });
  }

  /**
   * A kept message, the rollback target, then `n` messages from a busy
   * channel; those whose index is in `addressed` addressed the resident.
   */
  function seed(n: number, addressed: number[] = []): { tail: string; removed: string[] } {
    cm().addMessage('Operator', [{ type: 'text', text: 'kept' }], {
      serverId: 'discord', channelId: 'discord:g1:dm', messageId: 'kept',
    });
    const tail = String(cm().addMessage('Operator', [{ type: 'text', text: 'last good' }], {
      serverId: 'discord', channelId: 'discord:g1:dm', messageId: 'tail',
    }));
    const removed: string[] = [];
    for (let i = 0; i < n; i++) {
      removed.push(String(cm().addMessage(`Member${i}`, [{ type: 'text', text: `message ${i}` }], {
        serverId: 'discord',
        channelId: 'discord:g1:c1',
        messageId: `amb-${i}`,
        tags: addressed.includes(i) ? ['chat:addressed', 'chat:mention'] : ['chat:ambient'],
      })));
    }
    return { tail, removed };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surgery-marks-'));
    storePath = join(dir, 'store');
    callsPath = join(dir, 'calls.jsonl');
    eventsPath = join(dir, 'events.jsonl');
    holdPath = join(dir, 'release-reactions');
    probePath = join(dir, 'send-probe');
  });

  afterEach(async () => {
    writeFileSync(holdPath, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a rollback is local by default: no reaction, and the receipt counts what stayed unmarked', async () => {
    await start(true);
    const { tail } = seed(5, [3]);
    writeFileSync(holdPath, '1');
    const result = await framework.rollbackToMessage('resident', { messageId: tail });
    assert.equal(result.messagesRemoved, 5);
    assert.equal(result.removedRefs.length, 5);
    assert.deepEqual(result.markers, { scope: 'none', unmarked: 5, notRemoved: 0, status: 'none', queued: 0 });
    await framework.syncDiscordAwarenessMarkers();
    assert.equal(calls().length, 0);
    assert.equal(outbox().batches().length, 0);
    const entry = framework.getOperatorLog({ limit: 5 }).find((e) => e.kind === 'rollback');
    assert.equal(entry?.params?.marks, 'none');
  });

  it('addressed marks only the messages that addressed the resident', async () => {
    await start(true);
    const { tail } = seed(6, [1, 4]);
    writeFileSync(holdPath, '1');
    const preview = framework.previewSurgeryMarks('resident', { rollbackTo: tail });
    assert.equal(preview.messagesRemoved, 6);
    assert.equal(preview.addressable, 6);
    assert.equal(preview.scopes.addressed.count, 2);
    assert.deepEqual(preview.scopes.addressed.channels, [{ channelId: 'discord:g1:c1', count: 2 }]);
    assert.equal(preview.scopes.all.count, 6);

    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'addressed' } });
    assert.equal(result.markers.status, 'queued');
    assert.equal(result.markers.queued, 2);
    assert.equal(result.markers.unmarked, 4);
    await waitFor('two reactions answered', () => answered() === 2);
    await framework.syncDiscordAwarenessMarkers();
    assert.deepEqual(calls().map((c) => `${c.name}:${c.args.messageId}:${c.args.emoji}`).sort(), [
      'add_reaction:amb-1:💤',
      'add_reaction:amb-4:💤',
    ]);
  });

  it('a choice bound to previewed refs never widens to messages that arrive before it applies', async () => {
    await start(true);
    const { tail } = seed(3, [0, 2]);
    writeFileSync(holdPath, '1');
    const preview = framework.previewSurgeryMarks('resident', { rollbackTo: tail });
    const authorized = preview.scopes.addressed.refs;
    assert.equal(authorized.length, 2);
    // An addressed message arrives while the operator is deciding.
    cm().addMessage('Late', [{ type: 'text', text: '@resident are you there?' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'late-1', tags: ['chat:addressed'],
    });
    const result = await framework.rollbackToMessage('resident', {
      messageId: tail,
      marks: { scope: 'addressed', refs: authorized },
    });
    assert.equal(result.messagesRemoved, 4, 'the rollback still removes everything after its anchor');
    assert.equal(result.markers.queued, 2);
    assert.equal(result.markers.unmarked, 2, 'the late arrival is removed locally, unmarked');
    await waitFor('two reactions answered', () => answered() === 2);
    assert.ok(!calls().some((c) => c.args.messageId === 'late-1'));
  });

  it('returns once marks are scheduled, before Discord has accepted any, and never holds channel traffic', async () => {
    await start(true);
    const { tail, removed } = seed(4);

    const result = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } }),
      3_000,
      'rollbackToMessage with reactions held',
    );
    assert.equal(result.markers.status, 'queued');
    assert.equal(result.markers.queued, 4);
    assert.equal(answered(), 0, 'no reaction had been accepted when the rollback returned');
    await waitFor('the first reaction call to reach the server', () => calls().length >= 1);

    // The store is free: a second surgery is admitted during delivery.
    cm().addMessage('Someone', [{ type: 'text', text: 'new' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'after-1',
    });
    const fresh = cm().getAllMessages().at(-1)!;
    const second = await settlesWithin(
      framework.suppressMessages('resident', { messageIds: [String(fresh.id)] }),
      3_000,
      'a second surgery during delivery',
    );
    assert.equal(second.markers.status, 'none');

    // Channel traffic sent while reactions are held is answered anyway.
    writeFileSync(probePath, '1');
    await waitFor('the probe to be answered while reactions are still held', () =>
      jsonl(eventsPath).some((e) => e.event === 'probe-answered'));
    assert.equal(answered(), 0, 'the probe was not waiting behind the marks');

    writeFileSync(holdPath, '1');
    await waitFor('all four adds confirmed in the journal', () => {
      const journal = outbox();
      return journal.operations().filter((op) => journal.operationStatus(op) === 'confirmed').length === 4;
    });
    // Exactly the rolled-back messages, nothing from the later suppression.
    assert.deepEqual(
      outbox().operations().map((op) => `${op.action}:${op.key.messageId}`).sort(),
      ['add:amb-0', 'add:amb-1', 'add:amb-2', 'add:amb-3'],
    );
    assert.equal(removed.length, 4);

    const logged = new Map<string, OperatorLogEntry>(
      framework.getOperatorLog({ limit: 10 }).map((entry) => [entry.kind, entry]),
    );
    assert.deepEqual(logged.get('rollback')?.result?.markers, result.markers);
  });

  it('a rollback whose marker bookkeeping fails after the switch reports the body as applied', async () => {
    await start(true);
    const { tail } = seed(2);
    const original = DiscordAwarenessOutbox.prototype.activate;
    DiscordAwarenessOutbox.prototype.activate = function () {
      throw new Error('injected ledger failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = original;
    }

    assert.equal(cm().currentBranch().name, result.targetBranch, 'the rollback stands');
    assert.equal(result.markers.status, 'not-scheduled');
    assert.match(result.markers.status === 'not-scheduled' ? result.markers.error : '', /injected ledger failure/);
    const entry = framework.getOperatorLog({ limit: 10 }).find((e) => e.kind === 'rollback');
    assert.equal(entry?.error, undefined, 'logged as an applied rollback, not a failure');

    // "Not scheduled" holds across delivery and a full restart.
    writeFileSync(holdPath, '1');
    await framework.syncDiscordAwarenessMarkers();
    await framework.stop();
    await start(true);
    await framework.syncDiscordAwarenessMarkers();
    assert.equal(outbox().operations().length, 0);
    assert.equal(calls().length, 0, 'no reaction was ever sent');
  });

  it('reports unresolved bookkeeping when the batch can be neither activated nor retired', async () => {
    await start(false);
    const { tail } = seed(2);
    const activate = DiscordAwarenessOutbox.prototype.activate;
    const discard = DiscordAwarenessOutbox.prototype.discard;
    DiscordAwarenessOutbox.prototype.activate = function () {
      throw new Error('injected ledger failure');
    };
    DiscordAwarenessOutbox.prototype.discard = function () {
      throw new Error('injected retire failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = activate;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.equal(cm().currentBranch().name, result.targetBranch, 'the rollback stands');
    assert.equal(result.markers.status, 'unresolved');
    const batches = outbox().batches();
    assert.equal(batches.length, 1);
    assert.equal(result.markers.status === 'unresolved' && result.markers.batchId, batches[0].id);
  });

  it('a suppression whose marker bookkeeping fails after the last redaction stands', async () => {
    await start(false);
    const { removed } = seed(3);
    const original = DiscordAwarenessOutbox.prototype.activate;
    DiscordAwarenessOutbox.prototype.activate = function () {
      throw new Error('injected ledger failure');
    };
    let result: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      result = await framework.suppressMessages('resident', { messageIds: [removed[1]], marks: { scope: 'all' } });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = original;
    }
    assert.equal(cm().currentBranch().name, result.targetBranch, 'the suppression is not undone');
    assert.ok(!cm().getAllMessages().some((m) => String(m.id) === removed[1]));
    assert.equal(result.markers.status, 'not-scheduled');
    assert.equal(outbox().batches().every((batch) => batch.status === 'discarded' || batch.status === 'active'), true);
  });

  it('cancel stops unsent marks without removing any; retract removes this bot\'s marks and discloses an unknown add', async () => {
    // A short awareness deadline turns a withheld reply into "no response".
    await start(true, 150);
    const { tail } = seed(3);
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    assert.equal(result.markers.status, 'queued');
    const batchId = result.markers.status === 'queued' ? result.markers.batchId : '';
    // The first add goes out and is never answered within the deadline.
    await waitFor('the first add to time out as unknown', () =>
      outbox().operations().some((op) => outbox().operationStatus(op) === 'unknown'));

    const cancelled = framework.cancelDiscordAwareness(batchId, { requester: { via: 'test', name: 'operator' } });
    assert.equal(cancelled.confirmed, 0);
    assert.equal(cancelled.unknown + cancelled.inFlight + cancelled.cancelled, 3);
    assert.ok(cancelled.unknown + cancelled.inFlight >= 1, 'the timed-out add may still land');

    // Discord finally answers the withheld request: the late add lands.
    writeFileSync(holdPath, '1');
    await waitFor('the withheld add to be answered', () => answered() >= 1);
    const sentBeforeRetract = calls().length;
    assert.ok(calls().every((c) => c.name === 'add_reaction'));

    const retracted = framework.retractDiscordAwareness(batchId, { requester: { via: 'test', name: 'operator' } });
    assert.ok(retracted.removalsQueued >= 1);
    assert.ok(retracted.keysWithUnresolvedAdds >= 1, 'the unknown add is disclosed, not assumed absent');
    await waitFor('the removals to be sent', () =>
      calls().slice(sentBeforeRetract).filter((c) => c.name === 'remove_reaction').length === retracted.removalsQueued);
    const kinds = framework.getOperatorLog({ limit: 10 }).map((e) => e.kind);
    assert.ok(kinds.includes('awareness-cancel') && kinds.includes('awareness-retract'));
  });

  it('marks chosen where no awareness journal exists are reported as not scheduled, not as unwanted', async () => {
    // A caller-supplied store and no storePath: no default journal location.
    framework = await AgentFramework.create({
      store: JsStore.openOrCreate({ path: storePath }),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      operatorLogPath: false,
    });
    const { tail } = seed(2, [0]);
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'addressed' } });
    assert.equal(result.messagesRemoved, 2);
    assert.equal(result.markers.status, 'not-scheduled');
    assert.match(result.markers.status === 'not-scheduled' ? result.markers.error : '', /no awareness journal/);
    assert.equal(result.markers.unmarked, 1);
    const local = await framework.rollbackToMessage('resident', { messageId: String(cm().getAllMessages()[0].id) });
    assert.equal(local.markers.status, 'none', 'nothing chosen is still none');
  });

  it('a surgery that removes nothing addressable schedules no marks even when marks are chosen', async () => {
    await start(false);
    const keep = String(cm().addMessage('Operator', [{ type: 'text', text: 'kept' }], {}));
    cm().addMessage('resident', [{ type: 'text', text: 'local only' }], {});
    const result = await framework.rollbackToMessage('resident', { messageId: keep, marks: { scope: 'all' } });
    assert.deepEqual(result.markers, { scope: 'all', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 });
    assert.equal(outbox().batches().length, 0);
  });
});
