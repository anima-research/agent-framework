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

describe('surgery marker receipt', () => {
  let dir: string;
  let storePath: string;
  let callsPath: string;
  let eventsPath: string;
  let holdPath: string;
  let probePath: string;
  let framework: AgentFramework;

  const cm = () => framework.getAgent('resident')!.getContextManager();
  const outboxPath = () => join(storePath, 'recovery', 'discord-awareness-outbox.json');
  const ledger = () => new DiscordAwarenessOutbox(outboxPath()).batches();

  async function start(withDiscord: boolean): Promise<void> {
    framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
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
    const events = jsonl<{ event: string; at: number }>(eventsPath);
    const lastReaction = Math.max(...events.filter((e) => e.event === 'reaction-answered').map((e) => e.at));
    const probe = events.find((e) => e.event === 'probe-answered')!;
    assert.ok(probe.at >= lastReaction, 'the probe is answered only after the held reactions');
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
      result = await framework.suppressMessages('resident', { messageIds: [removed[1]] });
    } finally {
      DiscordAwarenessOutbox.prototype.activate = original;
    }

    assert.equal(cm().currentBranch().name, result.targetBranch, 'the suppression is not undone');
    assert.deepEqual(result.removedIds, [removed[1]]);
    assert.ok(!cm().getAllMessages().some((m) => String(m.id) === removed[1]));
    assert.equal(result.markers.status, 'not-scheduled');
    assert.deepEqual(ledger(), [], 'every interval committed, so the retired journal loses nothing');
  });

  it('a surgery that removes nothing addressable schedules no marks', async () => {
    await start(false);
    const keep = String(cm().addMessage('Operator', [{ type: 'text', text: 'kept' }], {}));
    cm().addMessage('resident', [{ type: 'text', text: 'local only' }], {});
    const result = await framework.rollbackToMessage('resident', { messageId: keep });
    assert.deepEqual(result.markers, { status: 'none', queued: 0 });
    assert.equal(ledger().length, 0);
  });
});
