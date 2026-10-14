/**
 * Live surgery reports its body change apart from the Discord awareness marks
 * it schedules, and does not wait on Discord to accept them.
 *
 * Field incident (2026-10-07): a web-UI rollback removed 918 Discord messages
 * from a resident's context. rollbackToMessage awaited the serial reaction
 * drain inside its store reservation, so the operator's surgery-result never
 * arrived within the client's 60 s, the store stayed reserved, and every MCPL
 * data plane stayed paused for the whole drain. These tests hold the fake
 * server's reaction replies to model that drain.
 *
 * The receipt is a scheduling statement (`markers`), never a delivery claim,
 * and a ledger failure after the body change landed is reported as
 * `not-scheduled` instead of a failed surgery an operator might retry.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, ApiServer, DiscordAwarenessOutbox } from '../src/index.js';
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

describe('surgery marker receipt', () => {
  let dir: string;
  let storePath: string;
  let callsPath: string;
  let eventsPath: string;
  let holdPath: string;
  let answerLimitPath: string;
  let probePath: string;
  let framework: AgentFramework;

  const cm = () => framework.getAgent('resident')!.getContextManager();
  const outboxPath = () => join(storePath, 'recovery', 'discord-awareness-outbox.json');
  const ledger = () => new DiscordAwarenessOutbox(outboxPath()).batches();
  type Internals = {
    discordAwarenessBarrier: { generation: number; requiresBarrier: boolean } | null;
    mcplServerRegistry: { getServer(id: string): { dataPlaneReady: boolean } | undefined } | null;
    reserveStoreForSurgery(verb: string, agentName: string): () => void;
    recordTurnCheckpoint(agentName: string): void;
    handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  const internals = () => framework as unknown as Internals;
  /** The delivery gate is up: a generation that requires it, and discord's data plane paused. */
  const assertGateUp = (when: string) => {
    assert.equal(internals().discordAwarenessBarrier?.requiresBarrier, true, `${when}: an awareness generation requires the gate`);
    assert.equal(internals().mcplServerRegistry?.getServer('discord')?.dataPlaneReady, false, `${when}: discord's data plane is paused`);
  };
  const probeAnswer = () => jsonl<{ event: string; error?: unknown }>(eventsPath).find((e) => e.event === 'probe-answered');
  /** The kinds of the Discord-awareness ops alerts raised from now on, in order. */
  const awarenessAlerts = (): string[] => {
    const kinds: string[] = [];
    framework.onTrace((event) => {
      const alert = event as unknown as { type: string; kind?: string };
      if (alert.type === 'ops:alert' && alert.kind?.startsWith('discord-awareness')) kinds.push(alert.kind);
    });
    return kinds;
  };

  /** With `appStore`, the framework gets an app-owned store and no storePath, so its outbox is disabled. */
  async function start(withDiscord: boolean, appStore?: unknown, membrane = new MockMembrane()): Promise<void> {
    framework = await AgentFramework.create({
      ...(appStore ? { store: appStore as never } : { storePath }),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      ...(withDiscord ? {
        mcplServers: [{
          id: 'discord',
          command: process.execPath,
          args: [FIXTURE],
          env: {
            CALLS_PATH: callsPath,
            EVENTS_PATH: eventsPath,
            HOLD_PATH: holdPath,
            ANSWER_LIMIT_PATH: answerLimitPath,
            PROBE_PATH: probePath,
          },
          enabledFeatureSets: ['chat'],
        }],
      } : {}),
    });
  }

  /** A kept message, the rollback target, then `n` addressable messages. */
  function seed(n: number): { tail: string; removed: string[] } {
    cm().addMessage('Operator', [{ type: 'text', text: 'kept' }], {
      serverId: 'discord', channelId: 'discord:g1:dm', messageId: 'kept',
    });
    const tail = String(cm().addMessage('Operator', [{ type: 'text', text: 'last good' }], {
      serverId: 'discord', channelId: 'discord:g1:dm', messageId: 'tail',
    }));
    const removed: string[] = [];
    for (let i = 0; i < n; i++) {
      removed.push(String(cm().addMessage(`Member${i}`, [{ type: 'text', text: `ambient ${i}` }], {
        serverId: 'discord', channelId: 'discord:g1:c1', messageId: `amb-${i}`,
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
    answerLimitPath = join(dir, 'answer-limit');
    probePath = join(dir, 'send-probe');
  });

  afterEach(async () => {
    writeFileSync(holdPath, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rollback returns once the batch is active, before Discord has accepted any reaction', async () => {
    await start(true);
    const { tail } = seed(3);

    const result = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail }),
      3_000,
      'rollbackToMessage with reactions held',
    );

    assert.equal(result.messagesRemoved, 3);
    assert.equal(result.markers.status, 'queued');
    assert.equal(result.markers.queued, 3);
    const [batch] = ledger();
    assert.equal(batch.status, 'active', 'the batch is durably active before the call returns');
    assert.equal(result.markers.status === 'queued' && result.markers.batchId, batch.id);
    assert.equal(
      jsonl(eventsPath).filter((e) => e.event === 'reaction-answered').length,
      0,
      'no reaction had been accepted when the rollback returned',
    );

    // Delivery continues in the background and completes once Discord answers.
    writeFileSync(holdPath, '1');
    await waitFor('all three reactions answered', () =>
      jsonl(eventsPath).filter((e) => e.event === 'reaction-answered').length === 3);
    await framework.syncDiscordAwarenessMarkers();
    const entries = ledger()[0].refs;
    assert.deepEqual(entries.map((ref) => ref.deliveryStatus), ['applied', 'applied', 'applied']);
    assert.deepEqual(
      jsonl<{ name: string; args: { emoji: string } }>(callsPath).map((call) => `${call.name}:${call.args.emoji}`),
      ['add_reaction:💤', 'add_reaction:💤', 'add_reaction:💤'],
    );

    const logged = new Map<string, OperatorLogEntry>(
      framework.getOperatorLog({ limit: 10 }).map((entry) => [entry.kind, entry]),
    );
    assert.deepEqual(logged.get('rollback')?.result?.markers, result.markers);
  });

  it('releases the store while delivery runs, but keeps MCPL traffic behind the delivery gate', async () => {
    await start(true);
    const { removed } = seed(4);

    await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: removed[1] }),
      3_000,
      'rollbackToMessage with reactions held',
    );
    await waitFor('the first reaction call to reach the server', () => jsonl(callsPath).length >= 1);

    // The store reservation is released: a second surgery is admitted while
    // the first one's reactions are still unanswered.
    const second = await settlesWithin(
      framework.suppressMessages('resident', { messageIds: [removed[0]] }),
      3_000,
      'a second surgery during delivery',
    );
    assert.equal(second.messagesRemoved, 1);
    assert.equal(second.markers.status, 'queued');

    // The gate was installed before release: ordinary channel traffic sent
    // during delivery is not answered until the reactions are.
    assertGateUp('during the first surgery\'s delivery');
    writeFileSync(probePath, '1');
    await waitFor('the probe to be sent', () => jsonl(eventsPath).some((e) => e.event === 'probe-sent'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      jsonl(eventsPath).some((e) => e.event === 'probe-answered'),
      false,
      'channel traffic waits behind the delivery gate',
    );

    writeFileSync(holdPath, '1');
    await waitFor('the probe to be answered after delivery', () =>
      jsonl(eventsPath).some((e) => e.event === 'probe-answered'));
    assert.equal(probeAnswer()?.error, null, 'the probe was answered, not refused');
    // The server's own event order, not timestamps (two events can share a
    // millisecond), and every expected reaction by id: one compared only with
    // the reactions that happened to be answered would pass if the second
    // surgery's batch were never delivered.
    const events = jsonl<{ event: string; messageId?: string }>(eventsPath);
    const probeIndex = events.findIndex((e) => e.event === 'probe-answered');
    const answeredBeforeProbe = events.slice(0, probeIndex)
      .filter((e) => e.event === 'reaction-answered')
      .map((e) => e.messageId)
      .sort();
    assert.deepEqual(
      answeredBeforeProbe,
      ['amb-0', 'amb-2', 'amb-3'],
      'both surgeries\' reactions are answered before channel traffic is released',
    );
  });

  it('restoring the source while delivery runs keeps traffic gated until the running drain is done', async () => {
    await start(true);
    const { tail } = seed(3);

    const rollback = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail }),
      3_000,
      'rollbackToMessage with reactions held',
    );
    await waitFor('the first reaction call to reach the server', () => jsonl(callsPath).length >= 1);

    // The operator restores the source the way the branch-switch API does
    // (store switch, then synchronization) while the first add_reaction still
    // waits for its reply. Reconciliation makes every mark undesired, and the
    // held one is not present yet, so the ledger shows nothing pending: only
    // the running drain knows it will still send its saved adds.
    framework.getStore().switchBranch(rollback.sourceBranch);
    const restored = framework.syncDiscordAwarenessMarkers();
    // Nothing pending for discord: only the running drain keeps the gate up.
    assert.equal(new DiscordAwarenessOutbox(outboxPath()).pending('discord').length, 0, 'the ledger shows nothing pending');
    assertGateUp('after the restore');

    writeFileSync(probePath, '1');
    await waitFor('the probe to be sent', () => jsonl(eventsPath).some((e) => e.event === 'probe-sent'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      jsonl(eventsPath).some((e) => e.event === 'probe-answered'),
      false,
      'channel traffic waits for the running drain even though nothing appears pending',
    );

    writeFileSync(holdPath, '1');
    await settlesWithin(restored, 5_000, "the restore's synchronization");
    await waitFor('the probe to be answered after delivery', () =>
      jsonl(eventsPath).some((e) => e.event === 'probe-answered'));
    assert.equal(probeAnswer()?.error, null, 'the probe was answered, not refused');

    // Every reaction request the drain made, including the removals the
    // restore needs, was answered before channel traffic was released, and
    // the restore leaves no mark behind.
    const events = jsonl<{ event: string }>(eventsPath);
    const probeIndex = events.findIndex((e) => e.event === 'probe-answered');
    const answered = (from: number, to?: number) =>
      events.slice(from, to).filter((e) => e.event === 'reaction-answered').length;
    assert.equal(answered(0, probeIndex), jsonl(callsPath).length, 'every reaction call answered before the probe');
    assert.equal(answered(probeIndex), 0, 'no reaction answered after the probe');
    assert.deepEqual(
      ledger()[0].refs.map((ref) => [ref.messageId, ref.desired, ref.markerPresent, ref.deliveryStatus]),
      [['amb-0', false, false, 'applied'], ['amb-1', false, false, 'applied'], ['amb-2', false, false, 'applied']],
    );
  });

  it('a rollback whose marker bookkeeping fails after the switch reports the body as applied', async () => {
    await start(true);
    const { tail } = seed(2);
    const alerts = awarenessAlerts();
    const original = DiscordAwarenessOutbox.prototype.activate;
    DiscordAwarenessOutbox.prototype.activate = function () {
      throw new Error('injected ledger failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await framework.rollbackToMessage('resident', { messageId: tail });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = original;
    }

    assert.equal(cm().currentBranch().name, result.targetBranch, 'the rollback stands');
    assert.equal(result.messagesRemoved, 2);
    assert.equal(result.markers.status, 'not-scheduled');
    assert.match(result.markers.status === 'not-scheduled' ? result.markers.error : '', /injected ledger failure/);
    const entry = framework.getOperatorLog({ limit: 10 }).find((e) => e.kind === 'rollback');
    assert.equal(entry?.error, undefined, 'logged as an applied rollback, not a failure');
    assert.equal((entry?.result?.markers as { status?: string } | undefined)?.status, 'not-scheduled');
    assert.deepEqual(alerts, ['discord-awareness-not-scheduled'], 'the operator is told its marks were not scheduled');

    // "Not scheduled" holds across the reconciliation delivery runs and
    // across a restart: the batch was retired, so nothing can promote it.
    writeFileSync(holdPath, '1');
    await framework.syncDiscordAwarenessMarkers();
    assert.deepEqual(ledger(), []);
    await framework.stop();
    await start(true);
    await framework.syncDiscordAwarenessMarkers();
    assert.deepEqual(ledger(), []);
    assert.equal(jsonl(callsPath).length, 0, 'no reaction was ever sent');
  });

  it('reports unresolved bookkeeping when the batch can be neither activated nor retired', async () => {
    await start(false);
    const { tail } = seed(2);
    const alerts = awarenessAlerts();
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
      result = await framework.rollbackToMessage('resident', { messageId: tail });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = activate;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.equal(cm().currentBranch().name, result.targetBranch, 'the rollback stands');
    // The receipt promises nothing about this batch: it is still in the
    // ledger, and a reconciliation may promote and deliver it.
    assert.equal(result.markers.status, 'unresolved');
    const batches = ledger();
    assert.equal(batches.length, 1);
    assert.equal(result.markers.status === 'unresolved' && result.markers.batchId, batches[0].id);
    assert.match(result.markers.status === 'unresolved' ? result.markers.error : '', /injected ledger failure/);
    assert.deepEqual(alerts, ['discord-awareness-unresolved'], 'the operator is told the batch may still be delivered');
  });

  it('a suppression whose marker bookkeeping fails after the last redaction stands', async () => {
    await start(false);
    const { removed } = seed(3);
    const alerts = awarenessAlerts();
    const original = DiscordAwarenessOutbox.prototype.activate;
    DiscordAwarenessOutbox.prototype.activate = function () {
      throw new Error('injected ledger failure');
    };
    let result: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      result = await framework.suppressMessages('resident', { messageIds: [removed[1]] });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = original;
    }

    assert.equal(cm().currentBranch().name, result.targetBranch, 'the suppression is not undone');
    assert.deepEqual(result.removedIds, [removed[1]]);
    assert.ok(!cm().getAllMessages().some((m) => String(m.id) === removed[1]));
    assert.equal(result.markers.status, 'not-scheduled');
    assert.deepEqual(ledger(), [], 'every interval committed, so the retired journal loses nothing');
    const entry = framework.getOperatorLog({ limit: 10 }).find((e) => e.kind === 'suppress');
    assert.equal(entry?.error, undefined, 'logged as an applied suppression');
    assert.deepEqual(entry?.result?.markers, result.markers);
    assert.deepEqual(alerts, ['discord-awareness-not-scheduled']);
  });

  it('installs the delivery gate before the surgery releases the store', async () => {
    await start(true);
    const { tail } = seed(2);
    const atRelease: Array<{ installed: boolean; requires?: boolean }> = [];
    const reserve = internals().reserveStoreForSurgery.bind(framework);
    internals().reserveStoreForSurgery = (verb, agentName) => {
      const release = reserve(verb, agentName);
      return () => {
        const barrier = internals().discordAwarenessBarrier;
        atRelease.push({ installed: barrier !== null, requires: barrier?.requiresBarrier });
        release();
      };
    };
    await settlesWithin(framework.rollbackToMessage('resident', { messageId: tail }), 3_000, 'rollback with reactions held');
    assert.deepEqual(atRelease, [{ installed: true, requires: true }]);
  });

  it('a switch, an undo, a redo and a turn undo during a running drain each start delivery and return while replies are held', async () => {
    await start(true);
    internals().recordTurnCheckpoint('resident');
    const { tail } = seed(3);
    const rollback = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail }),
      3_000,
      'rollbackToMessage with reactions held',
    );
    await waitFor('the first reaction call to reach the server', () => jsonl(callsPath).length >= 1);

    // The web API's commands, called as its WebSocket dispatch calls them.
    const server = new ApiServer(framework, { port: 0 }) as unknown as {
      cmdBranchSwitch(params: { name: string }): Promise<{ switched: boolean }>;
      cmdUndo(params: { agentName: string }): Promise<{ undone?: boolean }>;
      cmdRedo(params: { agentName: string }): Promise<{ redone?: boolean }>;
    };
    // Each command starts delivery of the marks it moved before it returns: it
    // arms a newer generation, which holds traffic, and doesn't wait for it.
    let generation = internals().discordAwarenessBarrier!.generation;
    const startedDelivery = (when: string) => {
      assertGateUp(when);
      const current = internals().discordAwarenessBarrier!.generation;
      assert.ok(current > generation, `${when}: a newer generation, the delivery the command started`);
      generation = current;
    };
    const switched = await settlesWithin(server.cmdBranchSwitch({ name: rollback.sourceBranch }), 3_000, 'web branch switch');
    assert.equal(switched.switched, true);
    startedDelivery('after the switch');
    const undone = await settlesWithin(server.cmdUndo({ agentName: 'resident' }), 3_000, 'web undo');
    assert.equal(undone.undone, true);
    startedDelivery('after the undo');
    const redone = await settlesWithin(server.cmdRedo({ agentName: 'resident' }), 3_000, 'web redo');
    assert.equal(redone.redone, true);
    startedDelivery('after the redo');
    const turnUndo = await settlesWithin(
      internals().handleHostCommand('discord', { command: 'undo', agentName: 'resident', turns: 1 }),
      3_000,
      'host/command turn undo',
    );
    assert.equal(turnUndo.undone, 1);
    startedDelivery('after the turn undo');

    // None of them waited for Discord: no reaction has been answered.
    assert.equal(jsonl(eventsPath).filter((e) => e.event === 'reaction-answered').length, 0);
    // Once Discord answers, the deliveries the commands started finish on
    // their own, with no further sync, and leave nothing pending.
    writeFileSync(holdPath, '1');
    await waitFor('the deliveries the commands started to finish', () => internals().discordAwarenessBarrier === null);
    assert.equal(new DiscordAwarenessOutbox(outboxPath()).pending().length, 0, 'every mark the moves needed was delivered');
  });

  it('a rollback, its restore and a redo during one drain: every mark is sent before traffic is released', async () => {
    await start(true);
    const { tail } = seed(2);
    const rollback = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail }),
      3_000,
      'rollbackToMessage with reactions held',
    );
    await waitFor('the first add to reach the server', () => jsonl(callsPath).length >= 1);

    // The source is restored while the first add waits for its reply.
    framework.getStore().switchBranch(rollback.sourceBranch);
    const restored = framework.syncDiscordAwarenessMarkers();
    // The drain sends both adds, then the removals the restore needs. The
    // first removal is held.
    writeFileSync(answerLimitPath, '2');
    writeFileSync(holdPath, '1');
    await waitFor('the first removal to reach the server', () =>
      jsonl<{ name: string }>(callsPath).some((call) => call.name === 'remove_reaction'));
    // The rollback is redone while that removal is in flight. The drain has
    // already attempted both adds, so it won't send them again itself.
    framework.getStore().switchBranch(rollback.targetBranch);
    const redone = framework.syncDiscordAwarenessMarkers();
    writeFileSync(probePath, '1');
    await waitFor('the probe to be sent', () => jsonl(eventsPath).some((e) => e.event === 'probe-sent'));
    assertGateUp('after the redo');

    writeFileSync(answerLimitPath, '99');
    await settlesWithin(Promise.all([restored, redone]), 5_000, 'the restore and redo synchronizations');
    await waitFor('the probe to be answered after delivery', () => probeAnswer() !== undefined);
    assert.equal(probeAnswer()?.error, null, 'the probe was answered, not refused');

    assert.deepEqual(
      ledger()[0].refs.map((ref) => [ref.messageId, ref.desired, ref.markerPresent]),
      [['amb-0', true, true], ['amb-1', true, true]],
      'the redo\'s marks are on Discord',
    );
    const events = jsonl<{ event: string; name?: string; messageId?: string }>(eventsPath);
    const probeIndex = events.findIndex((e) => e.event === 'probe-answered');
    assert.deepEqual(
      events.slice(0, probeIndex).filter((e) => e.event === 'reaction-answered').map((e) => `${e.name}:${e.messageId}`),
      [
        'add_reaction:amb-0', 'add_reaction:amb-1',
        'remove_reaction:amb-0', 'remove_reaction:amb-1',
        'add_reaction:amb-0', 'add_reaction:amb-1',
      ],
      'the redo\'s adds were sent again, before channel traffic was released',
    );
  });

  it('a turn for channel traffic admitted before the gate may start before the drain completes', async () => {
    // Accepted, and stated in the changelog: the surgery's store reservation
    // ends once the gate is up, so no operator command waits on Discord, and
    // the gate holds only traffic that arrives after it. Before this change
    // the reservation held such a turn until the whole drain had finished.
    // This pins that accepted boundary: holding pre-gate work by some other
    // means would be a deliberate change to it, made together with the text.
    const membrane = new MockMembrane();
    await start(true, undefined, membrane);
    framework.start();
    const { tail } = seed(3);
    // The switch the rollback awaits goes on only once one ordinary channel
    // message has been admitted and answered, before any gate is up.
    const switchBranch = cm().switchBranch.bind(cm());
    (cm() as unknown as { switchBranch: (name: string) => Promise<void> }).switchBranch = async (name: string) => {
      writeFileSync(probePath, '1');
      await waitFor('the channel message answered during the switch', () => probeAnswer() !== undefined);
      return switchBranch(name);
    };
    const turnsBefore = membrane.calls.length;

    await settlesWithin(framework.rollbackToMessage('resident', { messageId: tail }), 3_000, 'rollbackToMessage with reactions held');
    assert.equal(probeAnswer()?.error, null, 'the channel message was admitted');
    await waitFor('a turn for the channel message', () => membrane.calls.length > turnsBefore);

    // The turn started while the drain still runs: the first reaction request
    // is on the wire, but every reply is still held and the gate is still up.
    await waitFor('the first reaction request to reach the server', () => jsonl(callsPath).length >= 1);
    assert.equal(jsonl(eventsPath).filter((e) => e.event === 'reaction-answered').length, 0, 'no reaction reply has been answered');
    assertGateUp('while that turn runs');
    assert.ok(
      JSON.stringify(membrane.calls[turnsBefore]).includes('ordinary traffic while marks are delivered'),
      'the turn carries the channel message',
    );
  });

  it('with the awareness outbox disabled, a rollback schedules no marks and puts up no gate', async () => {
    const { JsStore } = await import('@animalabs/chronicle');
    await start(true, JsStore.openOrCreate({ path: join(dir, 'app-store') }));
    const { tail } = seed(2);
    const result = await settlesWithin(
      framework.rollbackToMessage('resident', { messageId: tail }),
      3_000,
      'rollbackToMessage without an outbox',
    );
    assert.equal(result.messagesRemoved, 2);
    assert.equal(result.removedRefs.length, 2, 'it removed addressable Discord messages');
    assert.deepEqual(result.markers, { status: 'none', queued: 0 });
    assert.equal(internals().discordAwarenessBarrier, null, 'no gate');

    // Reactions are still held, and none is needed: traffic flows at once.
    writeFileSync(probePath, '1');
    await waitFor('the probe to be answered with no gate', () => probeAnswer() !== undefined);
    assert.equal(probeAnswer()?.error, null);
    assert.equal(jsonl(callsPath).length, 0, 'no reaction was sent');
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
    const reconcile = DiscordAwarenessOutbox.prototype.reconcileForBranch;
    DiscordAwarenessOutbox.prototype.reconcileForBranch = function () {
      throw new Error('injected ledger read failure');
    };
    let result: Awaited<ReturnType<AgentFramework['rollbackToMessage']>>;
    try {
      result = await settlesWithin(
        framework.rollbackToMessage('resident', { messageId: tail }),
        3_000,
        'rollbackToMessage whose delivery fails to start',
      );
      await waitFor('the delivery alert', () => alerts.some((alert) => alert.kind === 'discord-awareness-delivery'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      DiscordAwarenessOutbox.prototype.reconcileForBranch = reconcile;
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, [], 'the background failure is handled');
    assert.match(
      alerts.find((alert) => alert.kind === 'discord-awareness-delivery')!.message,
      /after rollback failed: .*injected ledger read failure/,
    );
    // Scheduling succeeded: the batch stays durably active for the next sync.
    assert.equal(result.markers.status, 'queued');
    assert.equal(ledger()[0].status, 'active');
  });

  it('a suppression with nothing addressable reports none, whether or not its journal can be closed', async () => {
    await start(false);
    const alerts = awarenessAlerts();
    const local = String(cm().addMessage('resident', [{ type: 'text', text: 'local only' }], {}));
    const other = String(cm().addMessage('resident', [{ type: 'text', text: 'also local' }], {}));
    cm().addMessage('resident', [{ type: 'text', text: 'after' }], {});

    const closed = await framework.suppressMessages('resident', { messageIds: [local] });
    assert.deepEqual(closed.markers, { status: 'none', queued: 0 });
    const [journal] = ledger();
    assert.equal(journal?.status, 'active', 'activated, which closes the resume journal');
    assert.deepEqual(journal.refs, []);

    // When the journal can be neither activated nor retired, it still
    // schedules nothing, and the receipt says none, not unresolved.
    const activate = DiscordAwarenessOutbox.prototype.activate;
    const discard = DiscordAwarenessOutbox.prototype.discard;
    DiscordAwarenessOutbox.prototype.activate = function () { throw new Error('injected ledger failure'); };
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    let stuck: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      stuck = await framework.suppressMessages('resident', { messageIds: [other] });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = activate;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.deepEqual(stuck.markers, { status: 'none', queued: 0 });
    assert.equal(ledger().filter((batch) => batch.status === 'prepared').length, 1, 'its journal is left prepared');
    assert.deepEqual(alerts, [], 'no marks were at stake, so no alert');
  });

  it('a suppression whose batch can be neither activated nor retired reports unresolved', async () => {
    await start(false);
    const { removed } = seed(3);
    const alerts = awarenessAlerts();
    const activate = DiscordAwarenessOutbox.prototype.activate;
    const discard = DiscordAwarenessOutbox.prototype.discard;
    DiscordAwarenessOutbox.prototype.activate = function () { throw new Error('injected ledger failure'); };
    DiscordAwarenessOutbox.prototype.discard = function () { throw new Error('injected retire failure'); };
    let result: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      result = await framework.suppressMessages('resident', { messageIds: [removed[1]] });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = activate;
      DiscordAwarenessOutbox.prototype.discard = discard;
    }
    assert.equal(cm().currentBranch().name, result.targetBranch, 'the suppression stands');
    assert.equal(result.markers.status, 'unresolved');
    const [batch] = ledger();
    assert.equal(batch.status, 'prepared');
    assert.equal(result.markers.status === 'unresolved' && result.markers.batchId, batch.id);
    const entry = framework.getOperatorLog({ limit: 10 }).find((e) => e.kind === 'suppress');
    assert.deepEqual(entry?.result?.markers, result.markers);
    assert.deepEqual(alerts, ['discord-awareness-unresolved']);
  });

  it('a surgery that removes nothing addressable schedules no marks', async () => {
    await start(false);
    const keep = String(cm().addMessage('Operator', [{ type: 'text', text: 'kept' }], {}));
    cm().addMessage('resident', [{ type: 'text', text: 'local only' }], {});
    const result = await framework.rollbackToMessage('resident', { messageId: keep });
    assert.equal(result.messagesRemoved, 1, 'the rollback did change the body');
    assert.deepEqual(result.markers, { status: 'none', queued: 0 });
    assert.equal(ledger().length, 0);
  });
});
