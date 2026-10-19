/**
 * stop() ends Discord awareness drains: a drain sends nothing once stop() has
 * begun, what it hasn't sent stays pending and unrecorded for the next start,
 * and stop() waits for a drain still recording the call its close ended, so no
 * drain writes the ledger after stop() has returned or a failed create() has
 * rejected (F74).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFramework, ShutdownTimeoutError } from '../src/index.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/awareness-barrier-mcpl-server.mjs', import.meta.url));

function tempDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'stop-awareness-drains-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The fixture server, whose reactions wait for a release file that no test
 *  writes: a call to it stays in flight until its connection closes. */
function server(dir: string, id: string, holdsReactions = true): McplServerConfig {
  return {
    id,
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 0,
    enabledFeatureSets: ['chat'],
    env: {
      STATUS_PATH: join(dir, 'status.jsonl'),
      LEDGER_PATH: join(dir, 'awareness.json'),
      SERVER_ID: id,
      ...(holdsReactions ? { RELEASE_PATH: join(dir, 'release') } : {}),
    },
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
    discordAwarenessOutboxPath: join(dir, 'awareness.json'),
    discordAwarenessDeadlineMs: 30_000,
    mcplServers: servers,
  };
}

/** One active batch of marks to add, `refs` as [serverId, messageId]. */
function pendingMarks(dir: string, refs: Array<[string, string]>): void {
  const outbox = new DiscordAwarenessOutbox(join(dir, 'awareness.json'));
  const batch = outbox.prepare({
    agentName: 'assistant', sourceBranch: 'source', targetBranch: 'main', activationPolicy: 'explicit',
    refs: refs.map(([serverId, messageId]) => ({ serverId, channelId: `discord:guild:${serverId}`, messageId })),
  });
  assert.ok(batch);
  outbox.activate(batch.id);
}

/** Each mark's ledger entry: its attempts and its last error. */
function ledger(dir: string): Record<string, { attempts: number; lastError?: string }> {
  const entries: Record<string, { attempts: number; lastError?: string }> = {};
  for (const ref of new DiscordAwarenessOutbox(join(dir, 'awareness.json')).batches()[0].refs) {
    entries[ref.messageId] = { attempts: ref.attempts, ...(ref.lastError ? { lastError: ref.lastError } : {}) };
  }
  return entries;
}

/** When each ledger write lands. */
function recordLedgerWrites(t: import('node:test').TestContext): number[] {
  const writes: number[] = [];
  for (const method of ['recordSuccess', 'recordFailure'] as const) {
    const original = DiscordAwarenessOutbox.prototype[method] as (...args: unknown[]) => void;
    t.mock.method(DiscordAwarenessOutbox.prototype, method, function (this: DiscordAwarenessOutbox, ...args: unknown[]) {
      writes.push(performance.now());
      return original.apply(this, args);
    });
  }
  return writes;
}

async function untilServerLogs(dir: string, event: string): Promise<void> {
  const path = join(dir, 'status.jsonl');
  for (let waited = 0; waited < 10_000; waited += 10) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes(`"${event}"`)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the server never logged ${event}`);
}

type Drains = { discordAwarenessDrains: Map<string, Promise<unknown>>; ownedStoreClosed: boolean };
const internals = (framework: AgentFramework) => framework as unknown as Drains & {
  drainDiscordAwarenessOutbox(serverId: string): Promise<unknown>;
};

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
    const framework = await AgentFramework.create(frameworkConfig(dir, [server(dir, 'discord')]));
    pendingMarks(dir, [['discord', 'm1'], ['discord', 'm2'], ['discord', 'm3']]);
    const writes = recordLedgerWrites(t);
    framework.startDiscordAwarenessDelivery('a test branch move');
    await untilServerLogs(dir, 'reaction-call');
    const log = captureLog(t);
    await framework.stop();
    const stopped = performance.now();
    assert.equal(internals(framework).discordAwarenessDrains.size, 0, 'no drain is running once stop() has returned');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(writes.every((at) => at < stopped), 'no ledger write after stop() returned');
    const entries = ledger(dir);
    assert.equal(entries.m1.attempts, 1, 'the call in flight is recorded');
    assert.match(entries.m1.lastError ?? '', /didn't answer before this host closed its connection/);
    assert.deepEqual([entries.m2, entries.m3], [{ attempts: 0 }, { attempts: 0 }], 'what the drain had not sent stays pending, unrecorded');
    assert.ok(log.some((line) => line.startsWith(
      '[discord-awareness] discord: 2 mark(s) not sent: the framework is stopping; the next start delivers them')), log.join('\n'));
  });

  it('a drain started once stop() has begun sends and records nothing', async (t) => {
    const dir = tempDir(t);
    const framework = await AgentFramework.create(frameworkConfig(dir, [server(dir, 'discord')]));
    pendingMarks(dir, [['discord', 'm1'], ['discord', 'm2']]);
    await framework.stop();
    const log = captureLog(t);
    await internals(framework).drainDiscordAwarenessOutbox('discord');
    assert.deepEqual(ledger(dir), { m1: { attempts: 0 }, m2: { attempts: 0 } },
      'no "not attempted" record: the marks stay pending as they were, for the next start');
    assert.ok(log.some((line) => line.startsWith(
      '[discord-awareness] discord: drain not started: the framework is stopping; the next start delivers what is pending')), log.join('\n'));
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

  it("a drain that rejects while stop() waits for it settles the wait, and the store closes: the failure is its barrier's to report", async (t) => {
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

  it("a create() whose startup barrier fails on one server leaves no other server's drain writing after it rejects", async (t) => {
    const dir = tempDir(t);
    pendingMarks(dir, [['discord-a', 'a1'], ['discord-b', 'b1'], ['discord-b', 'b2'], ['discord-b', 'b3']]);
    const writes = recordLedgerWrites(t);
    // a's mark is delivered, and recording it fails, which fails a's drain
    // and with it the barrier, while b's first call is in flight.
    const recordSuccess = DiscordAwarenessOutbox.prototype.recordSuccess;
    t.mock.method(DiscordAwarenessOutbox.prototype, 'recordSuccess', function (this: DiscordAwarenessOutbox, ...args: Parameters<typeof recordSuccess>) {
      if (args[1].serverId === 'discord-a') throw new Error('zz the ledger refused the write');
      return recordSuccess.apply(this, args);
    });
    await assert.rejects(AgentFramework.create(frameworkConfig(dir, [server(dir, 'discord-b'), server(dir, 'discord-a', false)])),
      /zz the ledger refused the write/);
    const rejected = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(writes.every((at) => at < rejected), 'no ledger write after create() rejected');
    const entries = ledger(dir);
    assert.equal(entries.b1.attempts, 1, "b's call in flight is recorded");
    assert.deepEqual([entries.b2, entries.b3], [{ attempts: 0 }, { attempts: 0 }], "what b's drain had not sent stays pending, unrecorded");
  });
});
