/**
 * stop() ends Discord awareness drains: a drain sends nothing once stop() has
 * begun, what it hasn't sent stays queued in the ledger, unrecorded, for the
 * next start, and stop() waits for a drain still recording the call its close
 * ended, so no drain writes the ledger after stop() has returned or a failed
 * create() has rejected (F74).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework, ShutdownTimeoutError } from '../src/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { DiscordAwarenessOutbox, defaultDiscordAwarenessOutboxPath } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/surgery-marks-mcpl-server.mjs', import.meta.url));

function tempDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'stop-awareness-drains-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The fixture server, whose reactions wait for a release file that no test
 *  writes: a call to it stays in flight until its connection closes. Each
 *  call it gets is logged to `calls-<id>.jsonl`. */
function server(dir: string, id: string): McplServerConfig {
  return {
    id,
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 0,
    enabledFeatureSets: ['chat'],
    env: { CALLS_PATH: join(dir, `calls-${id}.jsonl`), HOLD_PATH: join(dir, 'release') },
  };
}

function frameworkConfig(dir: string, servers: McplServerConfig[]) {
  return {
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules: [],
    discordAwarenessDeadlineMs: 30_000,
    mcplServers: servers,
  };
}

const ledgerPath = (dir: string) => defaultDiscordAwarenessOutboxPath(join(dir, 'store'));

/** One active batch of marks to add, `refs` as [serverId, messageId], queued
 *  in the store's ledger while no framework has the store open. */
async function pendingMarks(dir: string, refs: Array<[string, string]>): Promise<void> {
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  try {
    const outbox = new DiscordAwarenessOutbox(ledgerPath(dir), { store });
    const batch = await outbox.prepare({
      agentName: 'assistant', sourceBranch: 'source', targetBranch: 'main', scope: 'all',
      refs: refs.map(([serverId, messageId]) => ({ serverId, channelId: `discord:guild:${serverId}`, messageId })),
    });
    assert.ok(batch);
    await outbox.activate(batch.id);
  } finally {
    store.close();
  }
}

/** Once no framework has the ledger open: each reaction's entry by its
 *  message id, and the message ids still owed. */
function ledger(dir: string): { entries: Record<string, Record<string, any>>; due: string[] } {
  const entries: Record<string, Record<string, any>> = {};
  for (const entry of JSON.parse(readFileSync(ledgerPath(dir), 'utf8')).entries) entries[entry.messageId] = entry;
  return { entries, due: new DiscordAwarenessOutbox(ledgerPath(dir)).due().map((request) => request.messageId).sort() };
}

/** When each ledger write a drain makes is done: its write-ahead and its outcome. */
function recordLedgerWrites(t: import('node:test').TestContext): number[] {
  const writes: number[] = [];
  for (const method of ['claim', 'recordOutcome'] as const) {
    const original = DiscordAwarenessOutbox.prototype[method] as (...args: unknown[]) => Promise<unknown>;
    t.mock.method(DiscordAwarenessOutbox.prototype, method, async function (this: DiscordAwarenessOutbox, ...args: unknown[]) {
      try {
        return await original.apply(this, args);
      } finally {
        writes.push(performance.now());
      }
    });
  }
  return writes;
}

/** The message ids of the calls a server has had, once it has had `count`. */
async function untilCalls(dir: string, id: string, count: number): Promise<string[]> {
  const path = join(dir, `calls-${id}.jsonl`);
  for (let waited = 0; waited < 10_000; waited += 10) {
    const calls = jsonLines<{ args: { messageId: string } }>(path).map((call) => String(call.args.messageId));
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${id} never had ${count} call(s)`);
}

type Drains = { discordAwarenessDrains: Map<string, Promise<unknown>>; ownedStoreClosed: boolean };
const internals = (framework: AgentFramework) => framework as unknown as Drains;

/** Registers `drain` as a server's running drain, which leaves the map as it
 *  settles, as a real one does. */
function registerDrain(framework: AgentFramework, serverId: string, drain: Promise<void>): void {
  const drains = internals(framework).discordAwarenessDrains;
  drains.set(serverId, drain);
  const leave = () => { drains.delete(serverId); };
  drain.then(leave, leave);
}

/** The host log's lines, from here on. */
function captureLog(t: import('node:test').TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return lines;
}

/** What `settling` came to within `ms`: 'resolved', its rejection, or 'still waiting'. */
function settlesWithin(settling: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    settling.then(() => 'resolved', (error: unknown) => error),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

describe('stop() and Discord awareness drains', () => {
  it('a drain sending when stop() begins sends nothing more, and stop() waits for it to record the call its close ended', async (t) => {
    const dir = tempDir(t);
    await pendingMarks(dir, [['discord', 'm1'], ['discord', 'm2'], ['discord', 'm3']]);
    const writes = recordLedgerWrites(t);
    // The start's delivery sends the first add, which the server holds.
    const framework = await AgentFramework.create(frameworkConfig(dir, [server(dir, 'discord')]));
    const [first] = await untilCalls(dir, 'discord', 1);
    const log = captureLog(t);
    await framework.stop();
    const stopped = performance.now();
    assert.equal(internals(framework).discordAwarenessDrains.size, 0, 'no drain is running once stop() has returned');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(writes.every((at) => at < stopped), 'no ledger write after stop() returned');
    assert.deepEqual(await untilCalls(dir, 'discord', 1), [first], 'nothing more was sent');
    const { entries, due } = ledger(dir);
    const rest = ['m1', 'm2', 'm3'].filter((id) => id !== first);
    assert.deepEqual([entries[first].attempts, entries[first].confirmed, entries[first].mayLand], [1, 'unknown', ['add']],
      'the call in flight is recorded unanswered');
    assert.ok(log.some((line) => line.startsWith(`[discord-awareness] add discord:guild:discord/${first}: unknown`)
      && /didn't answer before this host closed its connection/.test(line)), log.join('\n'));
    assert.deepEqual(rest.map((id) => [entries[id].attempts, entries[id].sending]), [[0, undefined], [0, undefined]],
      'what the drain had not sent is unrecorded');
    assert.deepEqual(due, ['m1', 'm2', 'm3'], 'and stays queued for the next start, with the unanswered add');
    assert.ok(log.some((line) => line.startsWith(
      '[discord-awareness] discord: 2 mark(s) not sent: the framework is stopping; the next start delivers them')), log.join('\n'));
  });

  it('stop() returns only once a drain still running has settled', async (t) => {
    const dir = tempDir(t);
    const framework = await AgentFramework.create(frameworkConfig(dir, []));
    let settled = false;
    registerDrain(framework, 'discord', new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 200)));
    await framework.stop();
    assert.equal(settled, true, 'the drain had settled');
    assert.equal(internals(framework).ownedStoreClosed, true);
  });

  it('a drain that rejects while stop() waits for it settles the wait, and the store closes: the failure is reported where the drain was started', async (t) => {
    const dir = tempDir(t);
    const framework = await AgentFramework.create(frameworkConfig(dir, []));
    registerDrain(framework, 'discord', new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('zz the ledger refused the write')), 50);
    }));
    await framework.stop();
    assert.equal(internals(framework).discordAwarenessDrains.size, 0);
    assert.equal(internals(framework).ownedStoreClosed, true);
  });

  it('a drain whose wait runs out fails the stop(), naming it, keeps the store open, and a later stop() waits for it', async (t) => {
    const dir = tempDir(t);
    const framework = await AgentFramework.create(frameworkConfig(dir, []));
    let settle!: () => void;
    registerDrain(framework, 'discord', new Promise<void>((resolve) => { settle = resolve; }));
    await assert.rejects(framework.stop(50), (error: unknown) => {
      assert.ok(error instanceof ShutdownTimeoutError, String(error));
      assert.deepEqual(error.pending, ['awareness drain:discord']);
      return true;
    });
    assert.equal(internals(framework).ownedStoreClosed, false, 'the store stays open for another stop()');
    // The drain is still registered, so a later stop() waits for it.
    const later = framework.stop();
    assert.equal(await settlesWithin(later, 200), 'still waiting', 'a later stop() waits for the drain');
    settle();
    await later;
    assert.equal(internals(framework).ownedStoreClosed, true);
  });

  it("a create() that fails while its start's delivery has a call in flight leaves no drain writing after it rejects", async (t) => {
    const dir = tempDir(t);
    await pendingMarks(dir, [['discord', 'm1'], ['discord', 'm2'], ['discord', 'm3']]);
    const writes = recordLedgerWrites(t);
    // The start fails once its delivery's first add is on the wire: a tools
    // refresh that fails then, which comes after the delivery has started.
    let first: string | undefined;
    t.mock.method(AgentFramework.prototype as unknown as { refreshMcplTools(): Promise<void> }, 'refreshMcplTools', async () => {
      [first] = await untilCalls(dir, 'discord', 1);
      throw new Error('zz the tools refresh failed');
    });
    await assert.rejects(AgentFramework.create(frameworkConfig(dir, [server(dir, 'discord')])), /zz the tools refresh failed/);
    const rejected = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(writes.every((at) => at < rejected), 'no ledger write after create() rejected');
    assert.ok(first);
    const { entries, due } = ledger(dir);
    assert.deepEqual([entries[first].attempts, entries[first].confirmed], [1, 'unknown'], 'the call in flight is recorded unanswered');
    const rest = ['m1', 'm2', 'm3'].filter((id) => id !== first);
    assert.deepEqual(rest.map((id) => [entries[id].attempts, entries[id].sending]), [[0, undefined], [0, undefined]],
      'what the drain had not sent is unrecorded');
    assert.deepEqual(due, ['m1', 'm2', 'm3'], 'and stays queued for the next start');
  });
});
