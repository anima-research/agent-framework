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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, DiscordAwarenessOutbox, OperatorActionError } from '../src/index.js';
import type { OperatorLogEntry } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/surgery-marks-mcpl-server.mjs', import.meta.url));

function jsonl<T = Record<string, unknown>>(path: string): T[] {
  return jsonLines<T>(path);
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
  /** The running framework's own ledger instance (the ledger's one writer). */
  const outbox = () => (framework as unknown as { discordAwarenessOutbox: DiscordAwarenessOutbox }).discordAwarenessOutbox;
  /** The reactions in the ledger file, as written now. */
  const entries = (): Array<Record<string, any>> => {
    const path = join(storePath, 'recovery', 'discord-awareness-outbox.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).entries : [];
  };
  /** settleActivation's own activation and retirement, which its fallbacks use. */
  const ledgerInternals = DiscordAwarenessOutbox.prototype as unknown as {
    activateIn: (...args: unknown[]) => Promise<number>;
    retireIn: (...args: unknown[]) => Promise<void>;
  };
  const answered = () => jsonl(eventsPath).filter((e) => e.event === 'reaction-answered').length;
  const calls = () => jsonl<{ name: string; args: { messageId: string; emoji: string } }>(callsPath);

  // Reactions the fake server holds stay held for as long as a test needs
  // them to: the deadline is the longest the framework takes, unless a test
  // means it to run out.
  const AWARENESS_DEADLINE_MS = 60_000;
  async function start(withDiscord: boolean, awarenessDeadlineMs = AWARENESS_DEADLINE_MS): Promise<void> {
    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      discordAwarenessDeadlineMs: awarenessDeadlineMs,
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

  it('a marks value that is not a choice is refused before anything changes', async () => {
    await start(false);
    const { tail, removed } = seed(3);
    const branch = cm().currentBranch().name;
    const invalid = (error: unknown) => error instanceof OperatorActionError && error.code === 'invalid'
      && /marks must be 'none' or \{ scope: 'addressed' \| 'all', refs\? \}/.test(error.message);
    // A bare scope (host/command's vocabulary), a misspelled scope, refs that
    // aren't Discord addresses: each would otherwise mark every message.
    for (const marks of ['addressed', { scope: 'adressed' }, { scope: 'all', refs: ['amb-0'] }]) {
      await assert.rejects(framework.rollbackToMessage('resident', { messageId: tail, marks: marks as never }), invalid);
      await assert.rejects(framework.suppressMessages('resident', { messageIds: [removed[0]], marks: marks as never }), invalid);
    }
    assert.equal(cm().currentBranch().name, branch);
    assert.equal(cm().getAllMessages().length, 5);
    assert.equal(outbox().batches().length, 0);
  });

  it('a surgery whose marker batch cannot be recorded does not start, and says so', async () => {
    await start(false);
    const { tail, removed } = seed(2);
    const branch = cm().currentBranch().name;
    const branchesBefore = cm().listBranches().length;
    const original = DiscordAwarenessOutbox.prototype.prepare;
    DiscordAwarenessOutbox.prototype.prepare = function () {
      throw new Error('recording awareness batch b1 failed: disk full');
    };
    try {
      await assert.rejects(
        framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } }),
        (error: unknown) => error instanceof OperatorActionError && error.code === 'failed'
          && /^Rollback not started, nothing changed: recording awareness batch b1 failed: disk full/.test(error.message),
      );
      // A suppression records its batch (its resume record, with or without
      // marks) before it changes anything, the same way.
      await assert.rejects(
        framework.suppressMessages('resident', { messageIds: [removed[0]] }),
        (error: unknown) => error instanceof OperatorActionError && error.code === 'failed'
          && /^Suppression not started, nothing changed: recording awareness batch b1 failed: disk full/.test(error.message),
      );
    } finally {
      DiscordAwarenessOutbox.prototype.prepare = original;
    }
    assert.equal(cm().currentBranch().name, branch);
    assert.equal(cm().getAllMessages().length, 4);
    assert.equal(cm().listBranches().length, branchesBefore, 'no fork was made');
  });

  it('an operator control the ledger refuses is invalid; one it fails to record is failed', async () => {
    await start(false);
    await assert.rejects(
      framework.cancelDiscordAwareness('no-such-batch'),
      (error: unknown) => error instanceof OperatorActionError && error.code === 'invalid',
    );
    const original = DiscordAwarenessOutbox.prototype.retract;
    DiscordAwarenessOutbox.prototype.retract = function () {
      throw new Error('disk full');
    };
    try {
      await assert.rejects(
        framework.retractDiscordAwareness('all'),
        (error: unknown) => error instanceof OperatorActionError && error.code === 'failed' && /disk full/.test(error.message),
      );
    } finally {
      DiscordAwarenessOutbox.prototype.retract = original;
    }
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

  it('a choice bound to refs counts the ones its surgery did not remove, and the log records how many were authorized', async () => {
    await start(false);
    const { tail, removed } = seed(3, [0, 1, 2]);
    const elsewhere = { serverId: 'discord', channelId: 'discord:g1:c2', messageId: 'not-removed' };
    const refs = [...framework.previewSurgeryMarks('resident', { rollbackTo: tail }).scopes.all.refs, elsewhere];
    const rolled = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all', refs } });
    assert.equal(rolled.markers.notRemoved, 1);
    assert.equal(rolled.markers.status === 'queued' && rolled.markers.queued, 3);
    const logged = framework.getOperatorLog({ limit: 5 }).find((entry) => entry.kind === 'rollback');
    assert.deepEqual(logged?.params?.marks, { scope: 'all', authorizedRefs: 4 });
    assert.deepEqual(logged?.result?.markers, rolled.markers, 'the log keeps the receipt the rollback returned');
    void removed;

    // A suppression counts the same way.
    const kept = String(cm().addMessage('Member', [{ type: 'text', text: 'later' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'later', tags: ['chat:addressed'],
    }));
    const later = { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'later' };
    const suppressed = await framework.suppressMessages('resident', { messageIds: [kept], marks: { scope: 'all', refs: [later, elsewhere] } });
    assert.equal(suppressed.markers.notRemoved, 1);
    const loggedSuppression = framework.getOperatorLog({ limit: 5 }).find((entry) => entry.kind === 'suppress');
    assert.deepEqual(loggedSuppression?.params?.marks, { scope: 'all', authorizedRefs: 2 });
    assert.deepEqual(loggedSuppression?.result?.markers, suppressed.markers, 'the log keeps the receipt the suppression returned');
  });

  it('a delivery that fails to start raises an ops alert and leaves no unhandled rejection', async () => {
    await start(true);
    const { tail } = seed(2);
    const alerts: Array<{ kind: string; message: string }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; message: string });
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const due = DiscordAwarenessOutbox.prototype.due;
    DiscordAwarenessOutbox.prototype.due = function () {
      throw new Error('injected ledger read failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await settlesWithin(
        framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } }),
        20_000,
        'rollbackToMessage whose delivery fails to start',
      );
      await waitFor('the delivery alert', () => alerts.some((alert) => alert.kind === 'discord-awareness-delivery'));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      DiscordAwarenessOutbox.prototype.due = due;
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, [], 'the background failure is handled');
    assert.match(
      alerts.find((alert) => alert.kind === 'discord-awareness-delivery')!.message,
      /after rollback failed: .*injected ledger read failure/,
    );
    // Scheduling succeeded: the batch stays durably active for the next pass.
    assert.equal(result.markers.status, 'queued');
    assert.equal(outbox().batches()[0].status, 'active');
  });

  it('a suppression with nothing addressable reports none, whether or not its resume record can be closed', async () => {
    await start(false);
    const local = String(cm().addMessage('resident', [{ type: 'text', text: 'local only' }], {}));
    const other = String(cm().addMessage('resident', [{ type: 'text', text: 'also local' }], {}));
    cm().addMessage('resident', [{ type: 'text', text: 'after' }], {});
    const none = { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 };

    const closed = await framework.suppressMessages('resident', { messageIds: [local] });
    assert.deepEqual(closed.markers, none);
    const [record] = outbox().batches();
    assert.equal(record?.status, 'active', 'activated, which closes the resume record');
    assert.deepEqual(record.refs, []);

    // When the record can be neither activated nor retired, it still
    // schedules nothing, and the receipt says none; the log says what
    // became of the record.
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const { activateIn, retireIn } = ledgerInternals;
    ledgerInternals.activateIn = async function () { throw new Error('injected ledger failure'); };
    ledgerInternals.retireIn = async function () { throw new Error('injected retire failure'); };
    let stuck: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      stuck = await framework.suppressMessages('resident', { messageIds: [other] });
    } finally {
      console.error = error;
      ledgerInternals.activateIn = activateIn;
      ledgerInternals.retireIn = retireIn;
    }
    assert.deepEqual(stuck.markers, none);
    assert.ok(!cm().getAllMessages().some((m) => String(m.id) === other), 'the redaction stood');
    const left = outbox().batches().filter((batch) => batch.status === 'prepared');
    assert.equal(left.length, 1, 'its resume record is left prepared');
    assert.ok(logged.some((line) => line === `[discord-awareness] agent=resident: suppress applied, but its resume record `
      + `(awareness batch ${left[0]!.id}, no marks) could not be closed: injected ledger failure; retiring it also failed `
      + `(injected retire failure), so it stays prepared, and the first start on ${left[0]!.targetBranch} finds its removals `
      + 'applied and retires it, none of its marks sent'), logged.join('\n'));
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
    // What was requested, not what has gone out by now: a request for the
    // late arrival would be in the ledger however the drain is paced.
    assert.deepEqual(entries().map((entry) => entry.messageId).sort(), authorized.map((r) => r.messageId).sort());
    await waitFor('two reactions answered', () => answered() === 2);
    assert.ok(!calls().some((c) => c.args.messageId === 'late-1'));
  });

  it('returns once marks are scheduled, before Discord has accepted any, and never holds channel traffic', async () => {
    await start(true);
    const { tail, removed } = seed(4);

    // Every reaction is held, so a rollback that waited on Discord would
    // never return: settlesWithin is the hang detector that shows it didn't
    // (not a latency verdict), and answered() === 0 follows from the hold.
    const result = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } }),
      20_000,
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
      20_000,
      'a second surgery during delivery',
    );
    assert.equal(second.markers.status, 'none');

    // Channel traffic sent while reactions are held is answered anyway.
    writeFileSync(probePath, '1');
    await waitFor('the probe to be answered while reactions are still held', () =>
      jsonl(eventsPath).some((e) => e.event === 'probe-answered'));
    assert.equal(jsonl(eventsPath).find((e) => e.event === 'probe-answered')?.error, null, 'accepted, not refused');
    assert.equal(answered(), 0, 'the probe was not waiting behind the marks');

    writeFileSync(holdPath, '1');
    await waitFor('all four adds confirmed in the ledger', () => entries().filter((entry) => entry.confirmed === 'present').length === 4);
    // Exactly the rolled-back messages, nothing from the later suppression.
    assert.deepEqual(
      entries().map((entry) => `${entry.wanted}:${entry.messageId}`).sort(),
      ['present:amb-0', 'present:amb-1', 'present:amb-2', 'present:amb-3'],
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
    const { activateIn } = ledgerInternals;
    ledgerInternals.activateIn = async function () {
      throw new Error('injected ledger failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    } finally {
      ledgerInternals.activateIn = activateIn;
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
    assert.deepEqual(entries(), []);
    assert.equal(calls().length, 0, 'no reaction was ever sent');
  });

  it('reports not-scheduled when the batch can be neither activated nor retired: it stays prepared, and a start retires it unsent', async () => {
    await start(false);
    const { tail } = seed(2);
    const { activateIn, retireIn } = ledgerInternals;
    ledgerInternals.activateIn = async function () {
      throw new Error('injected ledger failure');
    };
    ledgerInternals.retireIn = async function () {
      throw new Error('injected retire failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    } finally {
      ledgerInternals.activateIn = activateIn;
      ledgerInternals.retireIn = retireIn;
    }
    assert.equal(cm().currentBranch().name, result.targetBranch, 'the rollback stands');
    assert.equal(result.markers.status, 'not-scheduled');
    assert.match(result.markers.status === 'not-scheduled' ? result.markers.error : '',
      /^injected ledger failure; retiring it also failed \(injected retire failure\), so it stays prepared, and the next start retires it, none of its marks sent$/);
    assert.deepEqual(outbox().batches().map((batch) => batch.status), ['prepared']);
    // The next start retires it, none of its marks sent.
    await framework.stop();
    await start(false);
    assert.deepEqual(outbox().batches().map((batch) => batch.status), ['retired']);
    assert.deepEqual(entries(), []);
  });

  it('a suppression whose marker bookkeeping fails after the last redaction stands', async () => {
    await start(false);
    const { removed } = seed(3);
    const { activateIn } = ledgerInternals;
    ledgerInternals.activateIn = async function () {
      throw new Error('injected ledger failure');
    };
    let result: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      result = await framework.suppressMessages('resident', { messageIds: [removed[1]], marks: { scope: 'all' } });
    } finally {
      ledgerInternals.activateIn = activateIn;
    }
    assert.equal(cm().currentBranch().name, result.targetBranch, 'the suppression is not undone');
    assert.ok(!cm().getAllMessages().some((m) => String(m.id) === removed[1]));
    assert.equal(result.markers.status, 'not-scheduled');
    assert.deepEqual(outbox().batches().map((batch) => batch.status), ['retired'], 'its one batch is retired');
  });

  it('cancel stops unsent marks without removing any; retract removes this bot\'s marks and discloses an unknown add', async () => {
    // A short awareness deadline turns a withheld reply into "no response".
    await start(true, 150);
    const { tail } = seed(3);
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    assert.equal(result.markers.status, 'queued');
    const batchId = result.markers.status === 'queued' ? result.markers.batchId : '';
    // The first add goes out and is never answered within the deadline.
    await waitFor('the first add to time out unanswered', () => entries().some((entry) => entry.confirmed === 'unknown'));

    const cancelled = await framework.cancelDiscordAwareness(batchId, { requester: { via: 'test', name: 'operator' } });
    assert.equal(cancelled.confirmed, 0);
    assert.equal(cancelled.cancelled + cancelled.mayStillLand, 3, 'every add not yet sent is stopped');
    assert.ok(cancelled.mayStillLand >= 1, 'the timed-out add may still land');

    // Discord finally answers the withheld request: the late add lands.
    writeFileSync(holdPath, '1');
    await waitFor('the withheld add to be answered', () => answered() >= 1);
    const sentBeforeRetract = calls().length;
    assert.ok(calls().every((c) => c.name === 'add_reaction'));
    // The cancel stopped every add that hadn't gone out: what went out is
    // what it counted as able to land, one request per mark.
    assert.equal(sentBeforeRetract, cancelled.mayStillLand);

    // The short deadline has done its part. A removal that went unanswered
    // within it would stay owed, or be sent again, so the removals get the
    // 60 s this file's start() gives by default. Once the first removal
    // reaches Discord, Discord holds its answers for a second, past the
    // short deadline, as a loaded host's slow round trip can.
    (framework as unknown as { discordAwarenessDeadlineMs: number }).discordAwarenessDeadlineMs = AWARENESS_DEADLINE_MS;
    rmSync(holdPath);
    const retracted = await framework.retractDiscordAwareness(batchId, { requester: { via: 'test', name: 'operator' } });
    assert.equal(retracted.removalsQueued, 3, 'one removal per selected message, whatever history says');
    assert.ok(retracted.keysWithUnresolvedAdds >= 1, 'the unknown add is disclosed, not assumed absent');
    await waitFor('the first removal on the wire', () =>
      calls().slice(sentBeforeRetract).some((c) => c.name === 'remove_reaction'));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // Each add sent was answered at the first release, and no removal yet.
    assert.equal(answered(), sentBeforeRetract, 'Discord answered no removal while it held its answers');
    writeFileSync(holdPath, '1');
    // Each removal is confirmed on its first try: one that went unanswered
    // would stay owed, or be sent again.
    await waitFor('each removal to be confirmed', () =>
      entries().length === retracted.removalsQueued && entries().every((entry) => entry.confirmed === 'absent'));
    assert.deepEqual(calls().slice(sentBeforeRetract).map((c) => c.name), Array(retracted.removalsQueued).fill('remove_reaction'),
      'one removal sent per mark, and no add revived');
    const kinds = framework.getOperatorLog({ limit: 10 }).map((e) => e.kind);
    assert.ok(kinds.includes('awareness-cancel') && kinds.includes('awareness-retract'));
  });

  it("a retract whose ledger directory can't be synced after its write stands: it returns its receipt, raises recovery-sync, and its removals go out", { skip: process.getuid?.() === 0 }, async () => {
    await start(true);
    const { tail } = seed(2);
    // Every reaction is answered at once.
    writeFileSync(holdPath, '1');
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    assert.equal(result.markers.status, 'queued');
    await waitFor('both adds to be confirmed', () => entries().filter((entry) => entry.confirmed === 'present').length === 2);
    const alerts: Array<{ kind: string; message: string }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; message: string });
    });
    // The ledger's directory can be written, and not opened to sync.
    const ledgerDir = join(storePath, 'recovery');
    chmodSync(ledgerDir, 0o300);
    let retracted: Awaited<ReturnType<AgentFramework['retractDiscordAwareness']>>;
    try {
      retracted = await framework.retractDiscordAwareness('all');
      await waitFor('both removals to be sent', () => calls().filter((call) => call.name === 'remove_reaction').length === 2);
    } finally {
      chmodSync(ledgerDir, 0o700);
    }
    assert.equal(retracted.removalsQueued, 2);
    assert.ok(alerts.some((alert) => alert.kind === 'recovery-sync'
      && alert.message === `syncing ${ledgerDir} failed, so ${join(ledgerDir, 'discord-awareness-outbox.json')} may not survive a crash: `
        + `EACCES: permission denied, open '${ledgerDir}'`), JSON.stringify(alerts));
  });

  it('a caller-supplied store has no ledger unless discordAwarenessOutboxPath names one: without it a marks choice is refused before anything changes', async () => {
    const store = JsStore.openOrCreate({ path: storePath });
    const config = (extra: Record<string, unknown> = {}) => ({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      operatorLogPath: false as const,
      ...extra,
    });
    framework = await AgentFramework.create(config());
    const { tail } = seed(2, [0]);
    await assert.rejects(
      framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'addressed' } }),
      (error: unknown) => error instanceof OperatorActionError && error.code === 'invalid'
        && error.message === 'marks need the awareness ledger, and this framework has none: it was created with neither storePath nor discordAwarenessOutboxPath',
    );
    assert.equal(cm().getAllMessages().length, 4, 'nothing was removed');
    // A suppression refuses the same way.
    const [first] = cm().getAllMessages();
    await assert.rejects(
      framework.suppressMessages('resident', { messageIds: [String(first!.id)], marks: { scope: 'all' } }),
      (error: unknown) => error instanceof OperatorActionError && error.code === 'invalid'
        && /^marks need the awareness ledger, and this framework has none/.test(error.message),
    );
    assert.equal(cm().getAllMessages().length, 4, 'nothing was suppressed');
    await framework.stop();

    const ledgerPath = join(dir, 'ledger.json');
    framework = await AgentFramework.create(config({ discordAwarenessOutboxPath: ledgerPath }));
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'addressed' } });
    assert.equal(result.markers.status, 'queued');
    assert.equal(result.markers.queued, 1);
    assert.equal(result.markers.unmarked, 1);
    assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).entries.length, 1, 'the ledger is the file it names');
    assert.equal(existsSync(join(storePath, 'recovery', 'discord-awareness-outbox.json')), false);
  });

  it('cancel during delivery stops the marks not yet sent: exactly one request reaches the server', async () => {
    await start(true);
    const { tail } = seed(3);
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } });
    const batchId = result.markers.status === 'queued' ? result.markers.batchId : '';
    await waitFor('the first add on the wire', () => calls().length === 1);
    const receipt = await framework.cancelDiscordAwareness(batchId);
    assert.deepEqual({ cancelled: receipt.cancelled, mayStillLand: receipt.mayStillLand }, { cancelled: 2, mayStillLand: 1 });
    writeFileSync(holdPath, '1');
    await waitFor('the held add answered and recorded', () => entries().some((entry) => entry.confirmed === 'present'));
    // Nothing is owed, and once every drain pass has ended nothing can send
    // without a new trigger.
    assert.deepEqual(outbox().due('discord'), []);
    await framework.syncDiscordAwarenessMarkers();
    await Promise.all([...(framework as unknown as { discordAwarenessDrains: Map<string, Promise<unknown>> }).discordAwarenessDrains.values()]);
    assert.equal(calls().length, 1, 'the cancelled marks were never sent');
  });

  it('a failed rollback keeps its batch when the source cannot be confirmed, and says so', async () => {
    await start(false);
    const { tail } = seed(2);
    const live = cm();
    const realSwitch = live.switchBranch.bind(live);
    // The switch lands, then fails; the restore does nothing: the store is
    // left on the fork, so the batch is the unfinished change's record.
    live.switchBranch = async (name: string) => { await realSwitch(name); throw new Error('injected switch failure'); };
    const realRestore = (framework as any).restoreSourceBranch;
    (framework as any).restoreSourceBranch = async () => 'source not restored (injected)';
    try {
      await assert.rejects(
        framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'all' } }),
        /awareness batch .* kept, since the source branch could not be confirmed: the next start retires it, none of its marks sent/,
      );
    } finally {
      live.switchBranch = realSwitch;
      (framework as any).restoreSourceBranch = realRestore;
    }
    const [batch] = outbox().batches();
    assert.equal(batch.status, 'prepared', 'not retired while the store sits on the fork');
  });

  it('a failed suppression retires its batch only after the source is back, and reports a failed retire', async () => {
    await start(false);
    const { removed } = seed(3);
    const live = cm();
    const realFork = live.fork.bind(live);
    live.fork = async () => { throw new Error('injected fork failure'); };
    const discard = DiscordAwarenessOutbox.prototype.discard;
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    try {
      await assert.rejects(
        framework.suppressMessages('resident', { messageIds: [removed[0]], marks: { scope: 'all' } }),
        /could not be retired \(injected retire failure\); it stays prepared, none of its marks to be sent\. Its removals stay pending for \S+: a start on a branch with that name would finish them there and retire the batch: injected fork failure$/,
      );
    } finally {
      live.fork = realFork;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.equal(outbox().batches()[0].status, 'prepared');
    // With retirement working, the same failure retires it (source confirmed).
    live.fork = async () => { throw new Error('injected fork failure'); };
    try {
      await assert.rejects(
        framework.suppressMessages('resident', { messageIds: [removed[1]], marks: { scope: 'all' } }),
        (error: unknown) => error instanceof OperatorActionError && /^Suppression failed creating .*injected fork failure$/.test(error.message),
      );
    } finally {
      live.fork = realFork;
    }
    assert.equal(outbox().batches().at(-1)!.status, 'retired');
    // The first surgery never created its branch either: its body waits, at
    // the next start too, for a start on a branch with its name.
    await framework.stop();
    await start(false);
    assert.deepEqual(outbox().batches().map((batch) => batch.status), ['prepared', 'retired']);
    assert.equal(outbox().pendingSuppressionsFor(outbox().batches()[0].targetBranch).length, 1);
  });

  /** Run `fn` with every ops alert the framework raises recorded, from the start of a create() too. */
  async function withAlerts<T>(fn: (alerts: Array<{ kind: string; message: string }>) => Promise<T>): Promise<T> {
    const proto = AgentFramework.prototype as unknown as { opsAlert: (kind: string, agent: string, message: string, opts?: unknown) => void };
    const opsAlert = proto.opsAlert;
    const alerts: Array<{ kind: string; message: string }> = [];
    proto.opsAlert = function (kind, agent, message, opts) {
      alerts.push({ kind, message });
      return opsAlert.call(this, kind, agent, message, opts);
    };
    try {
      return await fn(alerts);
    } finally {
      proto.opsAlert = opsAlert;
    }
  }

  it('an interrupted suppression waits for a start on its branch, which finishes its removals and retires its marks, with an alert', async () => {
    await start(false);
    const { removed } = seed(3);
    const live = cm();
    const sourceBranch = live.currentBranch().name;
    // An interrupted suppression: the fork exists, nothing was redacted yet.
    await live.fork('partial');
    const [target] = live.getAllMessages().filter((m) => String(m.id) === removed[1]);
    const batch = (await outbox().prepare({
      agentName: 'resident', sourceBranch, targetBranch: 'partial',
      refs: [{ serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'amb-1' }], scope: 'all',
      suppressionIntervals: [{ fromId: String(target.id), toId: String(target.id) }],
    }))!;
    await live.switchBranch(sourceBranch);
    await framework.stop();

    await withAlerts(async (alerts) => {
      await start(false); // on the source branch: the suppression waits for its own
      assert.equal(outbox().batches()[0].status, 'prepared');
      assert.deepEqual(alerts, []);
    });
    await framework.stop();

    const store = JsStore.openOrCreate({ path: storePath });
    store.switchBranch('partial');
    store.close();
    await withAlerts(async (alerts) => {
      await start(false); // on the target: the body is finished, the marks retired
      assert.ok(!cm().getAllMessages().some((m) => String(m.id) === removed[1]), 'the saved redaction landed');
      const [after] = outbox().batches();
      assert.equal(after.status, 'retired', 'a start never activates a surgery\'s marks');
      assert.deepEqual(entries(), []);
      assert.deepEqual(alerts.map((alert) => alert.kind), ['discord-awareness-not-scheduled']);
      assert.match(alerts[0]!.message, new RegExp(`^The surgery of resident from ${sourceBranch} onto partial \\(awareness batch ${batch.id}: a suppression, or an offline recovery that suppressed\\) was interrupted; this start finished its removals on partial\\.`));
    });
  });

  it('a start that rewrites a version 2 ledger alerts with each batch whose undelivered marks it drops', async () => {
    // The store exists first, as for a host upgraded from 0.22.x.
    await start(false);
    await framework.stop();
    mkdirSync(join(storePath, 'recovery'), { recursive: true });
    writeFileSync(join(storePath, 'recovery', 'discord-awareness-outbox.json'), JSON.stringify({
      version: 2,
      batches: [{
        id: 'legacy-pending', status: 'active', agentName: 'resident', sourceBranch: 'main', targetBranch: 'rollback/resident/1',
        emoji: '💤', createdAt: 1,
        refs: [{
          serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'amb-1',
          desired: true, markerPresent: false, deliveryStatus: 'pending', attempts: 0,
        }],
      }],
    }));
    await withAlerts(async (alerts) => {
      await start(false);
      assert.deepEqual(alerts.map((alert) => alert.kind), ['discord-awareness-import-unsent']);
      assert.match(alerts[0]!.message, /^This start rewrites the awareness ledger as version 3, .*: batch legacy-pending \(resident, main to rollback\/resident\/1\): 1 to add, 0 to remove\./);
    });
    assert.deepEqual([entries(), outbox().due()], [[], []], 'nothing is sent');
    assert.deepEqual(outbox().batches().map((batch) => [batch.id, batch.status, batch.scope]), [['legacy-pending', 'active', 'legacy']]);
  });

  it('a rollback or suppression onto an existing branch is refused before any intent is prepared', async () => {
    await start(false);
    const { tail, removed } = seed(2);
    cm().branchAt(cm().getAllMessages().at(-1)!.id, 'taken');
    await assert.rejects(
      framework.rollbackToMessage('resident', { messageId: tail, branchName: 'taken', marks: { scope: 'all' } }),
      /Rollback branch taken already exists/,
    );
    await assert.rejects(
      framework.suppressMessages('resident', { messageIds: [removed[0]], branchName: 'taken', marks: { scope: 'all' } }),
      /Suppression branch taken already exists/,
    );
    assert.equal(outbox().batches().length, 0);
  });

  it('an interrupted rollback\'s batch: a start on a branch made under its name sends none of its marks', async () => {
    await start(true);
    const { tail } = seed(3);
    const sourceBranch = cm().currentBranch().name;
    // A rollback's batch with marks, left prepared, whose surgery never made fix-1.
    const first = (await outbox().prepare({
      agentName: 'resident', sourceBranch, targetBranch: 'fix-1',
      refs: [0, 1, 2].map((i) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId: `amb-${i}` })),
      scope: 'all',
    }))!;
    const retry = await framework.rollbackToMessage('resident', { messageId: tail, branchName: 'fix-1' });
    assert.equal(retry.targetBranch, 'fix-1');
    await framework.stop();
    // The next start, on fix-1, retires the old batch: none of its marks is
    // sent, and its alert names the redo.
    await withAlerts(async (alerts) => {
      await start(true);
      assert.deepEqual(alerts.map((alert) => alert.kind), ['discord-awareness-not-scheduled']);
      assert.equal(alerts[0]!.message,
        `The surgery of resident from ${sourceBranch} onto fix-1 (awareness batch ${first.id}: a rollback, or an offline `
        + 'recovery) was interrupted. Its 3 awareness mark(s) weren\'t applied, since a start never activates a surgery\'s '
        + `marks. To apply them, redo the surgery from ${sourceBranch}, if it still has every message the surgery removed, `
        + 'onto a new branch name, with its marks');
    });
    assert.equal(cm().currentBranch().name, 'fix-1');
    assert.equal(outbox().batches().find((batch) => batch.id === first.id)?.status, 'retired');
    await framework.syncDiscordAwarenessMarkers();
    assert.deepEqual(calls().filter((call) => call.name === 'add_reaction'), []);
    assert.deepEqual(entries(), []);
  });

  it('a surgery that removes nothing addressable schedules no marks even when marks are chosen', async () => {
    await start(false);
    const keep = String(cm().addMessage('Operator', [{ type: 'text', text: 'kept' }], {}));
    cm().addMessage('resident', [{ type: 'text', text: 'local only' }], {});
    const result = await framework.rollbackToMessage('resident', { messageId: keep, marks: { scope: 'all' } });
    assert.equal(result.messagesRemoved, 1, 'the rollback did change the body');
    assert.deepEqual(result.markers, { scope: 'all', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 });
    assert.equal(outbox().batches().length, 0);
  });
});
