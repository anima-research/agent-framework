import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const RAW_DM = '1548000000000000001';

/** Run the framework's queue until `cond` holds: a provider hold releases on
 *  its timer, and the framework under test isn't started. */
async function settleUntil(framework: { runUntilIdle(): Promise<void> }, cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await framework.runUntilIdle();
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** End `name`'s provider hold now, as its timer would when it runs out. */
function releaseHoldNow(framework: unknown, name: string): void {
  const f = framework as {
    providerAccelerationCooldowns: Map<string, { until: number }>;
    releaseProviderAccelerationCooldown(name: string): void;
  };
  const hold = f.providerAccelerationCooldowns.get(name);
  assert.ok(hold, `premise: ${name} is held`);
  hold.until = Date.now();
  f.releaseProviderAccelerationCooldown(name);
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('a batched wake writes no line when it is delivered for messages already in the window', () => {
  let tempDir: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-line-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      gate: {
        config: {
          // Addressed messages wake through a short debounce; ambient ones
          // are stored at arrival and wake nothing.
          policies: [{
            name: 'addressed',
            match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'], tagsAny: ['chat:addressed'] },
            behavior: { debounce: 100 },
          }],
          default: 'skip',
        },
        onboarding: false,
      },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (line: string): void => appendFileSync(commandPath, line + '\n');
  const dm = (text: string): void => command(`dm ev-${++n} 134 ${RAW_DM} ${text}`);

  /** The text of every entry in scout's window. */
  const window = (): string[] => framework.getAgent('scout')!.getContextManager().getAllMessages()
    .map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text?: string }).text ?? '').join('\n'));
  const gateLines = (): string[] => window().filter((t) => t.includes('[Gate:'));

  /** Holds the gate's batches until `release` is called with them pending. */
  const holdBatches = (): { held: () => number; release: () => void } => {
    const gate = (framework as unknown as {
      eventGate: { debounceTimers: Map<string, { events: unknown[] }>; fireDebounce(policyName: string): void } | null;
    }).eventGate;
    assert.ok(gate, 'premise: the framework has a gate');
    assert.equal(typeof gate.fireDebounce, 'function', 'premise: the gate fires a batch through fireDebounce');
    const fire = gate.fireDebounce.bind(gate);
    const pending = new Set<string>();
    let released = false;
    gate.fireDebounce = (policyName) => {
      if (released) fire(policyName);
      else pending.add(policyName);
    };
    return {
      held: () => pending.size,
      release: () => { released = true; for (const p of pending) fire(p); pending.clear(); },
    };
  };

  it("two DMs in one batch: no line, and the wake reads both DMs' rows", async () => {
    const gate = (framework as unknown as {
      eventGate: { requestInferenceFn: (agent: string, reason: string, source: string, provenance?: unknown) => void };
      pendingRequests: Array<{ agentName: string; reason: string; readsRows?: Array<{ row: string }> }>;
    });
    const asked: Array<{ agent: string; reason: string; rows?: string[] }> = [];
    const request = gate.eventGate.requestInferenceFn;
    gate.eventGate.requestInferenceFn = (agent, reason, source, provenance) => {
      request(agent, reason, source, provenance);
      asked.push({ agent, reason, rows: gate.pendingRequests.at(-1)?.readsRows?.map((r) => r.row) });
    };
    const batches = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('first');
    await waitFor(() => batches.held() >= 1, "the first DM's batch, held");
    dm('second');
    await waitFor(() => window().some((t) => t.includes('second')), 'the second DM stored');
    batches.release();
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    assert.deepEqual(gateLines(), []);
    const rows = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { serverId?: unknown } | undefined)?.serverId === 'discord'
        && m.content.some((b) => b.type === 'text' && /\b(first|second)\b/.test((b as { text: string }).text)))
      .map((m) => m.id);
    assert.equal(rows.length, 2, 'premise: both DMs are stored');
    const wake = asked.find((a) => a.reason === 'gate:debounce');
    assert.ok(wake, 'premise: the batch woke scout');
    assert.deepEqual(wake.rows, rows, "the wake reads the DMs' own rows");
  });

});

describe("a batched wake's rows across a quiesce and a hold", () => {
  type Bare = {
    framework: AgentFramework;
    membrane: MockMembrane;
    dir: string;
    internals: {
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
      pendingRequests: Array<Record<string, unknown>>;
      providerAccelerationCooldowns: Map<string, Record<string, unknown>>;
      processInferenceRequests(): Promise<void>;
    };
  };
  const bare = async (names: string[]): Promise<Bare> => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-rows-bare-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: names.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    return { framework, membrane, dir, internals: framework as unknown as Bare['internals'] };
  };
  const done = async (b: Bare): Promise<void> => {
    await b.framework.stop();
    rmSync(b.dir, { recursive: true, force: true });
  };
  const storeDm = (b: Bare, eventId: string, text: string): string =>
    b.internals.addMessage('antra', [{ type: 'text', text }], { serverId: 'discord', eventId, channelId: 'discord:dm:1' });
  const wake = (row: string, timestamp = Date.now()) => ({ agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp, readsRows: [{ row }] });
  const rowsOf = (requests: Array<Record<string, unknown>>) => requests.map((r) => (r.readsRows as Array<{ row: string }>)[0]!.row).sort();

  for (const order of ['older first', 'newer first'] as const) it(`two wakes for two batches' rows parked while the host is quiesced (${order}): neither absorbs the other`, async () => {
    const b = await bare(['scout']);
    try {
      const rows = [storeDm(b, 'ev-1', 'first DM'), storeDm(b, 'ev-2', 'second DM')];
      await b.framework.quiesce({ reason: 'test window' });
      const t0 = Date.now();
      const [first, second] = order === 'older first' ? [t0, t0 + 10] : [t0 + 10, t0];
      b.internals.pendingRequests.push(wake(rows[0]!, first));
      b.internals.pendingRequests.push(wake(rows[1]!, second));
      // One scheduler pass while quiesced parks them, coalescing alike wakes
      // (runUntilIdle doesn't count parked wakes as work).
      await b.internals.processInferenceRequests();
      assert.equal(b.membrane.calls.length, 0, 'premise: parked while quiesced');
      assert.deepEqual(rowsOf(b.internals.pendingRequests), [...rows].sort(), 'both wakes are kept, each with its rows');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      await b.framework.resume();
      await settleUntil(b.framework, () => b.membrane.calls.length >= 1, 'the turn at resume');
    } finally { await done(b); }
  });

  it('two held wakes alike in everything but their rows: the hold keeps both', async () => {
    const b = await bare(['scout']);
    try {
      const rows = [storeDm(b, 'ev-1', 'first DM'), storeDm(b, 'ev-2', 'second DM')];
      const now = Date.now();
      // Released by hand below, not by its timer.
      const timer = setTimeout(() => {}, 60_000);
      b.internals.providerAccelerationCooldowns.set('scout', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'test hold', failures: 1 });
      const at = Date.now();
      b.internals.pendingRequests.push(wake(rows[0]!, at));
      b.internals.pendingRequests.push(wake(rows[1]!, at));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 0, 'premise: held');
      const held = b.internals.providerAccelerationCooldowns.get('scout')!.heldRequests as Array<Record<string, unknown>>;
      assert.deepEqual(rowsOf(held), [...rows].sort(), 'both wakes are in the hold');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      clearTimeout(timer);
      releaseHoldNow(b.framework, 'scout');
      await settleUntil(b.framework, () => b.membrane.calls.length >= 1, 'the hold\'s release');
    } finally { await done(b); }
  });
});


describe('a debounced batch of targeted messages', () => {
  type Internals = {
    handleMcplChannelIncoming(event: Record<string, unknown>): Promise<unknown>;
    pendingRequests: Array<{ agentName: string; reason: string; readsRows?: unknown[] }>;
  };
  const boot = async (): Promise<{ framework: AgentFramework; internals: Internals; dir: string; membrane: MockMembrane }> => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-line-targeted-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' },
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
      ],
      gate: {
        config: {
          policies: [{
            name: 'addressed',
            match: { scope: ['mcpl:channel-incoming'], tagsAny: ['chat:addressed'] },
            behavior: { debounce: 300 },
          }],
          default: 'skip',
        },
      },
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    return { framework, internals: framework as unknown as Internals, dir, membrane };
  };
  const forMira = (messageId: string, text: string, targetAgents = ['mira']) => ({
    type: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM, messageId,
    author: { id: 'u-1', name: 'antra' }, content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(), tags: ['chat:addressed'], triggerInference: true, targetAgents,
  });
  const batchWakes = (internals: Internals) => internals.pendingRequests.filter((r) => r.reason === 'gate:debounce');
  const gateRows = (framework: AgentFramework) => framework.getAgent('scout')!.getContextManager().getAllMessages()
    .filter((m) => JSON.stringify(m.content).includes('[Gate:'));
  const windowTexts = (framework: AgentFramework, name: string) => framework.getAgent(name)!.getContextManager()
    .getPresentedMessages().map((m) => JSON.stringify(m.content));

  it('one message for a co-resident wakes her alone, her wake reading its row: no line is stored', async () => {
    const { framework, internals, dir, membrane } = await boot();
    try {
      await internals.handleMcplChannelIncoming(forMira('m-t1', 'mira, a word'));
      await waitFor(() => batchWakes(internals).length > 0, 'the batch to fire');
      assert.deepEqual(batchWakes(internals).map((r) => r.agentName), ['mira'], 'mira alone is woken');
      assert.equal(batchWakes(internals)[0]!.readsRows?.length, 1, 'her wake reads her message\'s row');
      assert.deepEqual(gateRows(framework), [], 'no line is stored in the slot');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'her turn ran');
      assert.ok(JSON.stringify(membrane.calls[0]!.messages).includes('mira, a word'), 'her request carries the message');
      assert.deepEqual(gateRows(framework), [], 'and no line is stored');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one message for a co-resident and a name that is no agent\'s wakes her alone, her wake reading its row: no line is stored', async () => {
    const { framework, internals, dir, membrane } = await boot();
    try {
      await internals.handleMcplChannelIncoming(forMira('m-t1', 'mira, a word', ['mira', 'ghost']));
      await waitFor(() => batchWakes(internals).length > 0, 'the batch to fire');
      assert.deepEqual(batchWakes(internals).map((r) => r.agentName), ['mira'], 'mira alone is woken');
      assert.equal(batchWakes(internals)[0]!.readsRows?.length, 1, 'her wake reads her message\'s row');
      assert.deepEqual(gateRows(framework), [], 'no line is stored in the slot');
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'her turn ran');
      assert.ok(JSON.stringify(membrane.calls[0]!.messages).includes('mira, a word'), 'her request carries the message');
      assert.deepEqual(gateRows(framework), [], 'and no line is stored');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const ROOM_A = 'discord:g1:room-a';
  const ROOM_B = 'discord:g1:room-b';
  const inRoom = (channelId: string, messageId: string, text: string, extra: Record<string, unknown>) => ({
    type: 'mcpl:channel-incoming', serverId: 'discord', channelId, messageId,
    author: { id: 'u-1', name: 'antra' }, content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(), tags: ['chat:addressed'], triggerInference: true, ...extra,
  });
  const wakeRoutes = (internals: Internals) => (batchWakes(internals) as Array<{ agentName: string; channelId?: string }>)
    .map((r) => [r.agentName, r.channelId]).sort();
  const gateLinesIn = (framework: AgentFramework, name: string) => windowTexts(framework, name).filter((t) => t.includes('[Gate:'));

  it("messages for two co-residents in one batch: each is woken for her own, routed to her own channel, with no line in either window", async () => {
    const { framework, internals, dir } = await boot();
    try {
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-a1', 'scout, a word', { targetAgents: ['scout'] }));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_B, 'm-b1', 'mira, a word', { targetAgents: ['mira'] }));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-a2', 'scout, another', { targetAgents: ['scout'] }));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_B, 'm-b2', 'mira, another', { targetAgents: ['mira'] }));
      await waitFor(() => batchWakes(internals).length >= 2, 'the batch to fire');
      assert.deepEqual(wakeRoutes(internals), [['mira', ROOM_B], ['scout', ROOM_A]], "each wake is routed to her own message's channel");
      assert.deepEqual(gateLinesIn(framework, 'scout'), []);
      assert.deepEqual(gateLinesIn(framework, 'mira'), []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a batch with a message for no one in particular and one for mira: scout is routed by the first alone, mira by both, with no line in either window', async () => {
    const { framework, internals, dir } = await boot();
    try {
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-u1', 'hello, all', {}));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_B, 'm-b1', 'mira, a word', { targetAgents: ['mira'] }));
      await waitFor(() => batchWakes(internals).length >= 2, 'the batch to fire');
      assert.deepEqual(wakeRoutes(internals), [['mira', ROOM_B], ['scout', ROOM_A]], 'scout is routed to the message he may see');
      assert.deepEqual(gateLinesIn(framework, 'scout'), []);
      assert.deepEqual(gateLinesIn(framework, 'mira'), []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const secondWakeThrows = async (framework: AgentFramework, internals: Internals) => {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const gate = (framework as unknown as { eventGate: { requestInferenceFn: (...args: unknown[]) => void } }).eventGate;
    const wake = gate.requestInferenceFn;
    let wakes = 0;
    gate.requestInferenceFn = (...args: unknown[]) => {
      if (++wakes === 2) throw new Error('the wake failed');
      return wake.apply(gate, args);
    };
    try {
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-a1', 'scout, a word', { targetAgents: ['scout'] }));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_B, 'm-b1', 'mira, a word', { targetAgents: ['mira'] }));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-a2', 'scout, another', { targetAgents: ['scout'] }));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_B, 'm-b2', 'mira, another', { targetAgents: ['mira'] }));
    } catch (err) {
      console.error = consoleError;
      throw err;
    }
    return {
      fired: () => wakes >= 2,
      told: () => errors.filter((e) => e.includes('[gate]')),
      restore: () => { console.error = consoleError; },
    };
  };

  it("a batch whose delivery throws after waking scout is logged as having woken scout, and as dropped for mira, who isn't woken", async () => {
    const { framework, internals, dir } = await boot();
    let restore = () => {};
    try {
      const run = await secondWakeThrows(framework, internals);
      restore = run.restore;
      await waitFor(run.fired, 'the batch to fire');
      assert.deepEqual(batchWakes(internals).map((r) => r.agentName), ['scout'], 'premise: scout is woken and mira, whose wake threw, is not');
      const told = run.told();
      assert.equal(told.length, 1, `the gate tells of it once: ${told.join(' | ')}`);
      assert.ok(told[0]!.includes('its pending batch of 4 events woke scout, and delivering it threw (the wake failed)'), `the log says the batch woke scout before its delivery threw: ${told[0]}`);
      assert.ok(told[0]!.includes("so it's dropped for mira, who isn't woken"), `and that it's dropped for mira, who isn't woken: ${told[0]}`);
    } finally {
      restore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a batch for no one in particular whose delivery throws after waking one resident is logged as having woken her, and as dropped for the other (bot review 2, #89)", async () => {
    const { framework, internals, dir } = await boot();
    const errors: string[] = [];
    const consoleError = console.error;
    try {
      const gate = (framework as unknown as { eventGate: { requestInferenceFn: (...args: unknown[]) => void } }).eventGate;
      const wake = gate.requestInferenceFn;
      let wakes = 0;
      gate.requestInferenceFn = (...args: unknown[]) => {
        if (++wakes === 2) throw new Error('the wake failed');
        return wake.apply(gate, args);
      };
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-u1', 'hello, all', {}));
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-u2', 'anyone?', {}));
      await waitFor(() => wakes >= 2, 'the batch to fire');
      console.error = consoleError;
      const woken = batchWakes(internals).map((r) => r.agentName);
      assert.equal(woken.length, 1, `premise: one resident is woken, and the other's wake threw: ${woken.join(', ')}`);
      const other = ['scout', 'mira'].find((name) => name !== woken[0])!;
      const told = errors.filter((e) => e.includes('[gate]'));
      assert.equal(told.length, 1, `the gate tells of it once: ${told.join(' | ')}`);
      assert.ok(told[0]!.includes(`its pending batch of 2 events woke ${woken[0]}, and delivering it threw (the wake failed)`), `the log says the batch woke ${woken[0]}: ${told[0]}`);
      assert.ok(told[0]!.includes(`so it's dropped for ${other}, who isn't woken`), `and that it's dropped for ${other}: ${told[0]}`);
    } finally {
      console.error = consoleError;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a batch held for the host's quiesce whose delivery throws after waking scout is logged as having woken scout, and as dropped for mira, who isn't woken", async () => {
    const { framework, internals, dir } = await boot();
    let restore = () => {};
    try {
      const gate = (framework as unknown as { eventGate: { setQuiesced(quiesced: boolean): void; inferenceDiagnostics(): { bufferedEvents: number } } }).eventGate;
      gate.setQuiesced(true);
      const run = await secondWakeThrows(framework, internals);
      restore = run.restore;
      await waitFor(() => gate.inferenceDiagnostics().bufferedEvents === 4, 'the batch to be held for the quiesce');
      gate.setQuiesced(false);
      await waitFor(run.fired, 'the held batch to be delivered');
      assert.deepEqual(batchWakes(internals).map((r) => r.agentName), ['scout'], 'premise: scout is woken and mira, whose wake threw, is not');
      const told = run.told();
      assert.equal(told.length, 1, `the gate tells of it once: ${told.join(' | ')}`);
      assert.ok(told[0]!.includes("a batch of 4 events, held for an agent's turn or the host's quiesce, woke scout, and delivering it threw (the wake failed)"), `the log says the held batch woke scout before its delivery threw: ${told[0]}`);
      assert.ok(told[0]!.includes("so it's dropped for mira, who isn't woken"), `and that it's dropped for mira, who isn't woken: ${told[0]}`);
    } finally {
      restore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a debounced correction delivered to mira wakes mira, not the agents its original message named", async () => {
    const { framework, internals, dir } = await boot();
    try {
      await internals.handleMcplChannelIncoming(inRoom(ROOM_A, 'm-c1', 'an edit', { targetAgents: ['scout'], deliverTo: 'mira' }));
      await waitFor(() => batchWakes(internals).length > 0, 'the batch to fire');
      assert.deepEqual(batchWakes(internals).map((r) => r.agentName), ['mira'], 'mira, who holds it, is woken');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two messages for a co-resident wake her alone, with no line in any window', async () => {
    const { framework, internals, dir } = await boot();
    try {
      await internals.handleMcplChannelIncoming(forMira('m-t1', 'mira, a word'));
      await internals.handleMcplChannelIncoming(forMira('m-t2', 'mira, another'));
      await waitFor(() => batchWakes(internals).length > 0, 'the batch to fire');
      assert.deepEqual(batchWakes(internals).map((r) => r.agentName), ['mira'], 'mira alone is woken');
      assert.deepEqual(gateRows(framework), []);
      assert.ok(!windowTexts(framework, 'mira').some((t) => t.includes('[Gate:')));
      assert.ok(!windowTexts(framework, 'scout').some((t) => t.includes('[Gate:')));
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
