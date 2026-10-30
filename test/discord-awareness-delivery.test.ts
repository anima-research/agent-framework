/**
 * Awareness-mark delivery never gates the resident.
 *
 * Before: queued marks held every MCPL data plane, at startup, reconnect and
 * after surgery, until each reaction had been attempted; at Discord's pace a
 * large batch left the resident deaf for many minutes, and an unreadable
 * ledger aborted startup or recycled connections at runtime. Now delivery is
 * a background drain over the awareness ledger: traffic flows while marks
 * are delivered; a route that is down leaves its work queued; the mandatory
 * per-request deadline still turns a hung reaction into an unanswered one.
 * The ledger is still read before startup, because it also carries the
 * suppressions' resume records that protect the resident's body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { DiscordAwarenessOutbox, defaultDiscordAwarenessOutboxPath } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/surgery-marks-mcpl-server.mjs', import.meta.url));

function jsonl(path: string): Array<Record<string, unknown>> {
  return jsonLines(path);
}

/** Resolve with the promise's value, or fail if it is still pending after ms: a hang detector. */
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
    crash: join(dir, 'crash'),
    down: join(dir, 'down'),
  };
  const ledgerPath = defaultDiscordAwarenessOutboxPath(storePath);
  /** Queue marks in the store's ledger while no host has it open. */
  const queueMarks = async (messageIds: string[]) => {
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const outbox = new DiscordAwarenessOutbox(ledgerPath, { store });
      const batch = (await outbox.prepare({
        agentName: 'resident',
        sourceBranch: 'source',
        targetBranch: 'main',
        refs: messageIds.map((messageId) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId })),
        scope: 'all',
      }))!;
      await outbox.activate(batch.id);
    } finally {
      store.close();
    }
  };
  /** A reaction's entry in the ledger file, as written now. */
  const entry = (messageId: string): Record<string, any> | undefined => existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8')).entries.find((e: { messageId: string }) => e.messageId === messageId)
    : undefined;
  const entries = (): Array<Record<string, any>> => existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')).entries : [];
  const config = (opts: { discord?: boolean; requestTimeoutMs?: number; awarenessDeadlineMs?: number; reconnect?: boolean } = {}) => ({
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
        env: {
          CALLS_PATH: paths.calls, EVENTS_PATH: paths.events, HOLD_PATH: paths.hold, PROBE_PATH: paths.probe,
          CRASH_PATH: paths.crash, DOWN_PATH: paths.down,
        },
        enabledFeatureSets: ['chat'],
        ...(opts.reconnect ? { reconnect: true, reconnectIntervalMs: 50, reconnectMaxIntervalMs: 200 } : {}),
      }],
    }),
  });
  return { dir, storePath, ledgerPath, entry, entries, paths, queueMarks, config };
}

test('startup does not wait for queued marks, and channel traffic flows while they are held', async () => {
  const { dir, entries, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    await queueMarks(['m1', 'm2']);
    writeFileSync(paths.probe, '1'); // the server sends channel traffic as soon as it can
    // A hang detector: startup that waited on the withheld reactions would never return.
    framework = await settlesWithin(AgentFramework.create(config()), 30_000, 'AgentFramework.create with reactions withheld');
    await waitFor('the queued add to reach the server', () => jsonl(paths.calls).length >= 1);
    await waitFor('the channel traffic to be answered', () =>
      jsonl(paths.events).some((event) => event.event === 'probe-answered'));
    assert.deepEqual(jsonl(paths.events).filter((event) => event.event === 'probe-answered').map((event) => event.error), [null],
      'answered, not refused');
    assert.equal(
      jsonl(paths.events).filter((event) => event.event === 'reaction-answered').length,
      0,
      'answered while every reaction was still withheld',
    );
    writeFileSync(paths.hold, '1');
    await waitFor('both adds confirmed', () => entries().filter((e) => e.confirmed === 'present').length === 2);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an operator's sync that meets a running pass has it try once more what it already tried", async () => {
  const { dir, entry, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    await queueMarks(['m1', 'm2']);
    // Every reaction is held, so each goes unanswered at the 300 ms deadline.
    framework = await AgentFramework.create(config({ awarenessDeadlineMs: 300 }));
    // The start's pass sends m1, which goes unanswered, then m2.
    await waitFor('the pass to send m1 and then m2', () => jsonl(paths.calls).length >= 2);
    assert.equal(entry('m1')!.attempts, 1, 'm1 went unanswered once, and is owed again');
    // The sync joins the pass while m2 is on the wire.
    await framework.syncDiscordAwarenessMarkers();
    const sent = jsonl(paths.calls).map((call) => (call.args as { messageId: string }).messageId);
    assert.deepEqual(sent, ['m1', 'm2', 'm1', 'm2'], 'the pass tried each once more before the sync returned');
    assert.deepEqual([entry('m1')!.attempts, entry('m2')!.attempts], [2, 2]);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the mandatory awareness deadline still bounds a hung reaction with requestTimeoutMs: 0', async (t) => {
  const { dir, entry, paths, queueMarks, config } = setup();
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  let framework: AgentFramework | undefined;
  try {
    await queueMarks(['m1']);
    framework = await AgentFramework.create(config({ requestTimeoutMs: 0, awarenessDeadlineMs: 150 }));
    await waitFor('the hung add to be recorded unanswered', () => entry('m1')?.confirmed === 'unknown');
    assert.deepEqual(entry('m1')!.mayLand, ['add']);
    // The file holds the answer from its rename; the drain logs it once the
    // write, the directories' syncs included, is done.
    await waitFor('the drain to log the unanswered add with the deadline', () => logged.some((line) =>
      line.startsWith('[discord-awareness] add discord:g1:c1/m1: unknown') && /didn't answer within/.test(line)));
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a route that is not connected leaves marks queued; they go out once it is', async () => {
  const { dir, ledgerPath, entry, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    await queueMarks(['m1']);
    framework = await AgentFramework.create(config({ discord: false }));
    const before = readFileSync(ledgerPath, 'utf8');
    await framework.syncDiscordAwarenessMarkers();
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, 'nothing recorded for a route that is down');
    await framework.stop();
    framework = undefined;

    writeFileSync(paths.hold, '1');
    framework = await AgentFramework.create(config());
    await waitFor('the queued add confirmed', () => entry('m1')?.confirmed === 'present');
    assert.deepEqual(jsonl(paths.calls).map((call) => call.name), ['add_reaction']);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable ledger stops startup, since it may hold a suppression the body needs resumed', async () => {
  const { dir, storePath, ledgerPath, config } = setup();
  try {
    JsStore.openOrCreate({ path: storePath }).close();
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, '{"version": 3, "moment": 1');
    await assert.rejects(
      AgentFramework.create(config({ discord: false })),
      /Discord awareness accounting failed during startup reconciliation: Invalid Discord awareness ledger .*: it isn't JSON/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a start that gives up on operations raises the delivery alert a pass would', async () => {
  const { dir, storePath, ledgerPath, queueMarks, config } = setup();
  const alerts: Array<{ kind: string; message: string }> = [];
  let framework: AgentFramework | undefined;
  try {
    // An add that went unanswered twice, whose third request was on the
    // wire when its host stopped.
    await queueMarks(['m1']);
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const outbox = new DiscordAwarenessOutbox(ledgerPath, { store });
      for (let i = 0; i < 2; i++) await outbox.recordOutcome((await outbox.claim('discord'))!, 'unknown');
      assert.ok(await outbox.claim('discord'));
    } finally {
      store.close();
    }
    framework = await AgentFramework.create(config({ discord: false }));
    // The alert create() raised, replayed as a host's sink attached after it gets it.
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push({ kind: event.kind, message: event.message });
    }, { replay: true });
    assert.deepEqual(alerts.map((alert) => alert.kind), ['discord-awareness-delivery']);
    assert.equal(alerts[0].message, 'Nothing more is sent for 1 awareness mark(s): their third unconfirmed attempt '
      + 'was still unanswered when the previous process ended');
    assert.deepEqual(new DiscordAwarenessOutbox(ledgerPath).due(), [], 'and it is not sent again');
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a host that is stopping claims no more marks: those still due wait for the next start', async () => {
  const { dir, ledgerPath, entry, paths, queueMarks, config } = setup();
  let framework: AgentFramework | undefined;
  let release: (() => void) | undefined;
  try {
    await queueMarks(['m1', 'm2']);
    framework = await AgentFramework.create(config());
    await waitFor('the first add on the wire', () => jsonl(paths.calls).length === 1);
    // stop() begins, and waits before it closes any connection, as for a
    // guard annotation still being written.
    const annotations = (framework as unknown as { guardAnnotations: Set<Promise<void>> }).guardAnnotations;
    const annotation = new Promise<void>((resolve) => { release = resolve; });
    annotations.add(annotation);
    void annotation.finally(() => annotations.delete(annotation));
    const stopping = framework.stop();
    // Discord answers the add on the wire while the host is stopping. The
    // drain records that answer, and then stops rather than claim the next
    // add.
    writeFileSync(paths.hold, '1');
    const first = String((jsonl(paths.calls)[0].args as { messageId: string }).messageId);
    const second = first === 'm1' ? 'm2' : 'm1';
    await waitFor('the first add confirmed', () => entry(first)?.confirmed === 'present');
    assert.deepEqual([entry(second)!.sending, entry(second)!.attempts], [undefined, 0], 'nothing more is claimed once stop() has begun');
    release!();
    await stopping;
    framework = undefined;
    assert.equal(jsonl(paths.calls).length, 1);
    assert.deepEqual(
      new DiscordAwarenessOutbox(ledgerPath).due().map((request) => request.messageId),
      [second],
      'it stays owed after the stop',
    );
    framework = await AgentFramework.create(config());
    await waitFor('the next start delivers it', () => jsonl(paths.calls).length === 2);
    assert.equal(String((jsonl(paths.calls)[1].args as { messageId: string }).messageId), second);
  } finally {
    release?.();
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a branch switch neither adds nor removes marks', async () => {
  const { dir, entry, entries, paths, config } = setup();
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
    await waitFor('the add confirmed', () => entry('m1')?.confirmed === 'present');
    // Switch back to the source and forward again, through the operator's
    // branch switch: nothing is sent.
    await framework.switchBranch(result.sourceBranch);
    await framework.syncDiscordAwarenessMarkers();
    await framework.switchBranch(result.targetBranch);
    await framework.syncDiscordAwarenessMarkers();
    await framework.stop();
    framework = await AgentFramework.create(config());
    await framework.syncDiscordAwarenessMarkers();
    assert.deepEqual(jsonl(paths.calls).map((call) => call.name), ['add_reaction']);
    assert.deepEqual(entries().map((e) => [e.messageId, e.due, e.confirmed]), [['m1', null, 'present']]);
  } finally {
    writeFileSync(paths.hold, '1');
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marks queued while a configured route is down go out when it reconnects, without a restart', async () => {
  const { dir, entries, paths, config } = setup();
  let framework: AgentFramework | undefined;
  try {
    writeFileSync(paths.hold, '1');
    framework = await AgentFramework.create(config({ reconnect: true }));
    const cm = framework.getAgent('resident')!.getContextManager();
    const tail = String(cm.addMessage('Operator', [{ type: 'text', text: 'tail' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'tail',
    }));
    cm.addMessage('Member', [{ type: 'text', text: 'hi' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1', tags: ['chat:addressed'],
    });
    const connection = (framework as unknown as { mcplServerRegistry: { getServer(id: string): { isConnected: boolean } } })
      .mcplServerRegistry.getServer('discord');

    // The route goes down and stays down while the marks are chosen.
    writeFileSync(paths.down, '1');
    writeFileSync(paths.crash, '1');
    await waitFor('the route to go down', () => !connection.isConnected);
    const result = await framework.rollbackToMessage('resident', { messageId: tail, marks: { scope: 'addressed' } });
    assert.equal(result.markers.status, 'queued');
    assert.deepEqual(jsonl(paths.calls), [], 'nothing reached a route that is down');

    // It comes back: the reconnect itself starts delivery.
    rmSync(paths.down, { force: true });
    await waitFor('the queued add confirmed after the reconnect', () => {
      const all = entries();
      return all.length === 1 && all[0]!.confirmed === 'present';
    }, 10_000);
    assert.deepEqual(jsonl(paths.calls).map((call) => call.name), ['add_reaction']);
  } finally {
    writeFileSync(paths.hold, '1');
    rmSync(paths.down, { force: true });
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an inbound event is handled in the turn it arrives: delivery holds no MCPL traffic', () => {
  // The push coalescer orders a push against its retraction by arrival, so
  // an inbound handler must not yield before it hands the event on.
  const framework = Object.create(AgentFramework.prototype) as any;
  const handled: string[] = [];
  framework.pushHandler = { handlePushEvent: async () => { handled.push('push-event'); } };
  framework.inferenceRouter = { handleInferenceRequest: async () => { handled.push('inference-request'); } };
  framework.channelRegistry = { handleIncoming: async () => { handled.push('channels-incoming'); } };
  framework.handleHostCommand = async () => { handled.push('host-command'); return { ok: true }; };
  const connection = new EventEmitter() as any;
  connection.id = 'discord';
  framework.wireMcplEvents(connection, { id: 'discord' });
  const responder = { id: 1, respond: () => {}, respondError: () => {} };
  for (const event of ['push-event', 'inference-request', 'channels-incoming', 'host-command']) {
    connection.emit(event, {}, responder);
  }
  assert.deepEqual(handled.sort(), ['channels-incoming', 'host-command', 'inference-request', 'push-event']);
});
