/**
 * Awareness-mark delivery never gates the resident.
 *
 * Before: queued marks held every MCPL data plane, at startup, reconnect and
 * after surgery, until each reaction had been attempted; at Discord's pace a
 * large batch left the resident deaf for many minutes, and an unreadable
 * ledger aborted startup or recycled connections at runtime. Now delivery is
 * a background drain over the awareness journal: traffic flows while marks
 * are delivered; a route that is down leaves its work queued; the mandatory
 * per-request deadline still turns a hung reaction into an unknown outcome.
 * The journal is still read before startup, because it also carries the
 * suppression resume journal that protects the resident's body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { DISCORD_AWARENESS_RECORD_TYPE, DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/surgery-marks-mcpl-server.mjs', import.meta.url));

function jsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'awareness-delivery-'));
  const storePath = join(dir, 'store');
  const paths = {
    calls: join(dir, 'calls.jsonl'),
    events: join(dir, 'events.jsonl'),
    hold: join(dir, 'release'),
    probe: join(dir, 'probe'),
  };
  /** Queue marks in the store's journal while no host has it open. */
  const queueMarks = (messageIds: string[]) => {
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const outbox = new DiscordAwarenessOutbox(store);
      const batch = outbox.prepare({
        agentName: 'resident',
        sourceBranch: 'source',
        targetBranch: 'main',
        refs: messageIds.map((messageId) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId })),
        scope: 'all',
        activationPolicy: 'explicit',
      })!;
      outbox.activate(batch.id);
    } finally {
      store.close();
    }
  };
  /** The running framework's own journal instance. */
  const journal = (framework: AgentFramework): DiscordAwarenessOutbox =>
    (framework as unknown as { discordAwarenessOutbox: DiscordAwarenessOutbox }).discordAwarenessOutbox;
  const config = (opts: { discord?: boolean; requestTimeoutMs?: number; awarenessDeadlineMs?: number } = {}) => ({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'resident', model: 'test', systemPrompt: 'test' }],
    modules: [],
    maintenanceIntervalMs: 0,
    ...(opts.awarenessDeadlineMs ? { discordAwarenessDeadlineMs: opts.awarenessDeadlineMs } : {}),
    ...(opts.discord === false ? {} : {
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
        env: { CALLS_PATH: paths.calls, EVENTS_PATH: paths.events, HOLD_PATH: paths.hold, PROBE_PATH: paths.probe },
        enabledFeatureSets: ['chat'],
      }],
    }),
  });
  return { dir, storePath, journal, paths, queueMarks, config };
}

test('startup does not wait for queued marks, and channel traffic flows while they are held', async () => {
  const { dir, journal, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    queueMarks(['m1', 'm2']);
    writeFileSync(paths.probe, '1'); // the server sends channel traffic as soon as it can
    framework = await AgentFramework.create(config());
    await waitFor('the queued add to reach the server', () => jsonl(paths.calls).length >= 1);
    await waitFor('the channel traffic to be answered', () =>
      jsonl(paths.events).some((event) => event.event === 'probe-answered'));
    assert.equal(
      jsonl(paths.events).filter((event) => event.event === 'reaction-answered').length,
      0,
      'answered while every reaction was still withheld',
    );
    writeFileSync(paths.hold, '1');
    await waitFor('both adds confirmed', () => {
      const outbox = journal(framework!);
      return outbox.operations().filter((op) => outbox.operationStatus(op) === 'confirmed').length === 2;
    });
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the mandatory awareness deadline still bounds a hung reaction with requestTimeoutMs: 0', async () => {
  const { dir, journal, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    queueMarks(['m1']);
    framework = await AgentFramework.create(config({ requestTimeoutMs: 0, awarenessDeadlineMs: 150 }));
    await waitFor('the hung add to be recorded unknown', () =>
      journal(framework!).operations().some((op) => op.attempts[0]?.outcome === 'unknown'));
    const [op] = journal(framework).operations();
    assert.equal(op.attempts[0].outcome, 'unknown');
    assert.match(op.attempts[0].error ?? '', /did not respond/);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a route that is not connected leaves marks queued; they go out once it is', async () => {
  const { dir, journal, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    queueMarks(['m1']);
    framework = await AgentFramework.create(config({ discord: false }));
    const before = JSON.stringify(journal(framework).operations());
    await framework.syncDiscordAwarenessMarkers();
    assert.equal(JSON.stringify(journal(framework).operations()), before, 'nothing recorded for a route that is down');
    await framework.stop();
    framework = undefined;

    writeFileSync(paths.hold, '1');
    framework = await AgentFramework.create(config());
    await waitFor('the queued add confirmed', () => {
      const outbox = journal(framework!);
      return outbox.operations().every((op) => outbox.operationStatus(op) === 'confirmed');
    });
    assert.deepEqual(jsonl(paths.calls).map((call) => call.name), ['add_reaction']);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt journal stops startup, since it may hold a suppression the body needs resumed', async () => {
  const { dir, storePath, config } = setup();
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    store.appendJson(DISCORD_AWARENESS_RECORD_TYPE, { records: 'not a record group' });
    store.close();
    await assert.rejects(
      AgentFramework.create(config({ discord: false })),
      /Discord awareness accounting failed during startup reconciliation: Corrupt Discord awareness journal entry/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a branch switch neither adds nor removes marks', async () => {
  const { dir, journal, paths, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    writeFileSync(paths.hold, '1');
    framework = await AgentFramework.create(config());
    const cm = framework.getAgent('resident')!.getContextManager();
    cm.addMessage('Operator', [{ type: 'text', text: 'kept' }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'kept' });
    const tail = String(cm.addMessage('Operator', [{ type: 'text', text: 'tail' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'tail',
    }));
    cm.addMessage('Member', [{ type: 'text', text: 'hi' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1', tags: ['chat:addressed'],
    });
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'addressed' } });
    await waitFor('the add confirmed', () =>
      journal(framework!).operations().some((op) => op.attempts[0]?.outcome === 'confirmed'));
    // Switch back to the source and forward again: nothing is sent.
    await cm.switchBranch(result.sourceBranch);
    await framework.syncDiscordAwarenessMarkers();
    await cm.switchBranch(result.targetBranch);
    await framework.syncDiscordAwarenessMarkers();
    await framework.stop();
    framework = await AgentFramework.create(config());
    await framework.syncDiscordAwarenessMarkers();
    assert.deepEqual(jsonl(paths.calls).map((call) => call.name), ['add_reaction']);
    assert.equal(journal(framework).operations().length, 1);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
