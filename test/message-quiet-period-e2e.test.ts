/**
 * FrameworkConfig.messageQuietPeriod through real ingress (#856 R1-1, R1-6):
 * the wake-locus MCPL fixture registers two guild channels and sends
 * channels/incoming traffic or a Discord-shaped DM on command, and records
 * every channels/publish with its channel. So these tests see what a room
 * sees: how many turns a burst makes, and in which channel each reply lands.
 *
 * The gate is `always` with no debounce, so each message is its own wake and
 * the quiet period alone decides when the turns start. The membrane answers
 * each turn with one line of prose, queued up front, one response per turn
 * (OneResponsePerTurnMembrane, R2-6), which the default `locus` routing
 * publishes to the turn's channel.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest } from '../src/types/agent.js';
import { OneResponsePerTurnMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const RAW_DM = '1548000000000000001';
const DM = `discord:dm:${RAW_DM}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('messageQuietPeriod through MCPL ingress', () => {
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: OneResponsePerTurnMembrane;
  let framework: AgentFramework;
  let n = 0;

  async function start(quiet: { quietMs: number; maxWaitMs?: number }, privilegedUsersPath?: string): Promise<void> {
    tempDir = mkdtempSync(join(tmpdir(), 'quiet-period-e2e-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new OneResponsePerTurnMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      messageQuietPeriod: quiet,
      gate: { config: { policies: [], default: 'always' }, ...(privilegedUsersPath ? { privilegedUsersPath } : {}) },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  }

  beforeEach(() => { n = 0; });
  afterEach(async () => {
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (line: string): void => appendFileSync(commandPath, line + '\n');
  const incoming = (channelId: string, text: string, mode: 'ambient' | 'addressed' = 'ambient'): void =>
    command(`incoming ${channelId} m-${++n} ${mode} ${text}`);
  const dm = (text: string): void => command(`dm ev-${++n} 134 ${RAW_DM} ${text}`);
  const sent = (event: string): number => jsonLines<{ event: string }>(statusPath).filter((e) => e.event === event).length;
  const publishes = (): string[] => jsonLines<{ event: string; channelId?: string }>(statusPath)
    .filter((e) => e.event === 'publish')
    .map((e) => e.channelId!);
  const reply = (text: string): void => membrane.pushResponse(createMockResponse([{ type: 'text', text }]));

  it('a burst in one channel makes one turn, after the burst is quiet', async () => {
    await start({ quietMs: 600 });
    reply('one reply for the burst');
    const t0 = Date.now();
    incoming(ROOM, 'first part');
    await sleep(150);
    incoming(ROOM, 'second part');
    await sleep(150);
    incoming(ROOM, 'third part');
    await waitFor(() => publishes().length >= 1, 'the reply');
    const at = Date.now() - t0;
    assert.ok(at >= 850, `the turn waited for the burst to end: replied at +${at} ms`);
    assert.deepEqual(publishes(), [ROOM]);
    await sleep(500);
    assert.equal(membrane.calls.length, 1, 'one turn for three messages');
  });

  it('two channels each addressed while the agent is idle: one turn per channel, each reply in its own channel (R1-1)', async () => {
    await start({ quietMs: 400 });
    reply('to room');
    reply('to general');
    incoming(ROOM, 'scout, a question in room', 'addressed');
    await sleep(200);
    incoming(GENERAL, 'scout, a question in general', 'addressed');
    await waitFor(() => publishes().length >= 2, 'both replies');
    assert.deepEqual(publishes(), [ROOM, GENERAL], 'one turn per channel, oldest burst first, each speaking where it was asked');
    await sleep(500);
    assert.equal(membrane.calls.length, 2);
  });

  it("an ambient message in a second channel that the first channel's turn already read starts no turn of its own (main's read-drop)", async () => {
    // The held wake keeps its message's ingress decision: an ambient message
    // asks nothing, so once a turn that carried it was answered, its wake is
    // dropped as read, as on `main` when such a message lands mid-turn. The
    // first channel's reply stays in the first channel; nothing is published
    // to the second.
    await start({ quietMs: 400 });
    reply('to room');
    incoming(ROOM, 'a remark in room');
    await sleep(200);
    incoming(GENERAL, 'a remark in general');
    await waitFor(() => sent('incoming-sent') >= 2, 'both messages sent');
    await waitFor(() => publishes().length >= 1, "room's reply");
    assert.deepEqual(publishes(), [ROOM]);
    await sleep(1_200);
    assert.equal(membrane.calls.length, 1, "general's wake was read by room's turn and started none");
    assert.deepEqual(publishes(), [ROOM], 'nothing landed in general');
  });

  it("a timer while two addressed channels are held starts neither's turn for it: each channel is answered in itself (R2-1)", async () => {
    await start({ quietMs: 600 });
    // The timer's turn says nothing, so where its prose would fall back to
    // doesn't enter the publish log.
    membrane.pushResponse(createMockResponse([]));
    reply('to room');
    reply('to general');
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
    incoming(ROOM, 'scout, a question in room', 'addressed');
    await sleep(150);
    incoming(GENERAL, 'scout, a question in general', 'addressed');
    await waitFor(() => sent('incoming-sent') >= 2, 'both messages sent');
    // A self-wake timer lands while both bursts are held: the framework's
    // own wake, pushed as the gate's timer pushes it.
    internals.pendingRequests.push({ agentName: 'scout', reason: 'self-wake', source: 'gate', timestamp: Date.now() });
    await waitFor(() => membrane.calls.length >= 1, "the timer's turn");
    await waitFor(() => publishes().length >= 2, 'both channels answered');
    assert.deepEqual(publishes(), [ROOM, GENERAL], 'each question answered in its own channel, oldest first');
    assert.equal(membrane.calls.length, 3, 'the timer\'s turn, then one per channel');
  });

  it('while the agent sleeps, a privileged author\'s DM wakes it, held then answered in the DM; another author\'s does not (R1-6)', async () => {
    const privileged = join(tmpdir(), `quiet-privileged-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(privileged, JSON.stringify({ userIds: ['134'] }));
    try {
      await start({ quietMs: 600 }, privileged);
      reply('answering the privileged DM');
      const gate = (framework as unknown as { eventGate: { setSleep(s: number, note?: string, agent?: string): unknown } }).eventGate;
      gate.setSleep(3600, 'resting', 'scout');
      // The gate decides: the privileged author's DM wakes the sleeping
      // agent; a stranger's (author 999) does not, hold or no hold.
      command(`dm ev-${++n} 999 ${RAW_DM} are you there?`);
      await sleep(900);
      assert.equal(membrane.calls.length, 0, "a stranger's DM doesn't wake a sleeping agent");
      const t0 = Date.now();
      dm('scout, wake up please');
      await waitFor(() => publishes().length >= 1, "the privileged DM's reply", 5_000);
      assert.ok(Date.now() - t0 >= 550, 'held for the quiet period first');
      assert.deepEqual(publishes(), [DM]);
      assert.equal(membrane.calls.length, 1);
    } finally {
      rmSync(privileged, { force: true });
    }
  });

  it("a DM's turn is not delayed by chatter elsewhere, and its reply stays in the DM (R1-1)", async () => {
    await start({ quietMs: 600, maxWaitMs: 5_000 });
    reply('answering the DM');
    reply('joining the room');
    const t0 = Date.now();
    dm('are you there?');
    // Chatter in the room every 150 ms for about 2 s: the room's burst is
    // never quiet while the DM waits its own 600 ms.
    const chatter = setInterval(() => incoming(ROOM, 'chatter'), 150);
    try {
      await waitFor(() => publishes().length >= 1, "the DM's reply", 5_000);
      const at = Date.now() - t0;
      assert.ok(at < 2_000, `the DM was answered on its own clock, at +${at} ms, not after the chatter`);
      assert.deepEqual(publishes(), [DM]);
    } finally {
      clearInterval(chatter);
    }
    // The room's chatter is ambient: what the DM's turn carried is read and
    // starts no turn; what landed after it compiled may. Either way, nothing
    // the room said is answered in the DM.
    await sleep(1_500);
    assert.equal(publishes()[0], DM);
    assert.ok(publishes().slice(1).every((c) => c === ROOM), `later replies, if any, went to the room: ${publishes().join(', ')}`);
  });
});

/**
 * A deferred coalesced batch (RFC-006) scoped to a channel, held beside
 * another channel's burst (#856 R3-1): the turn the other burst starts
 * leaves the batch for the batch's own turn, so the channel it was asked in
 * is the channel it is answered in. The loopback fixture renders the batch
 * as `document_diff`; `ok` answers every turn.
 */
describe('messageQuietPeriod and a deferred coalesced batch', () => {
  const batch = (id: string, text: string, channel: string) => ({
    featureSet: 'doc', eventId: id, timestamp: TS, tags: ['chat:mention', 'chat:addressed'],
    coalesce: { channelId: channel, key: 'doc', deferred: true, initial: true },
    payload: { content: [{ type: 'text', text }] },
  });

  for (const on of [false, true]) {
    it(`an addressed deferred batch held beside another channel's burst keeps its turn, in its channel (option ${on ? 'on' : 'off'})`, async () => {
      const f = await fixture({
        framework: {
          ...(on ? { messageQuietPeriod: { quietMs: 600 } } : {}),
          gate: { config: { policies: [], default: 'always' } },
        } as Partial<FrameworkConfig>,
        mcpl: {},
      });
      try {
        f.alwaysRespond();
        await f.register('room');
        await f.register('general');
        await f.framework.start();
        await f.send('channels/incoming', { messages: [{
          channelId: 'room', messageId: 'r1', eventId: 'r1', timestamp: TS, author: { id: 'u', name: 'U' },
          tags: ['chat:mention', 'chat:addressed'], content: [{ type: 'text', text: 'ROOMQ scout?' }],
        }] });
        await sleep(150);
        await f.send('push/event', batch('b1', 'GENQ batch question', 'general'));
        await waitFor(() => f.published.length >= 2, 'both answers', 6_000);
        await sleep(300);
        assert.deepEqual(f.published.map((p) => p.channelId), ['room', 'general'], 'general was asked, so general is answered');
        assert.equal(f.membrane.calls.length, 2, 'one turn per burst');
        const carries = f.membrane.calls.map((c) => JSON.stringify((c as { messages?: unknown }).messages).includes('document_diff'));
        assert.deepEqual(carries, [false, true], "the room's turn left the batch; general's turn assembled it");
      } finally {
        await f.close();
      }
    });
  }

  it("a notice to the held batch while the other burst's start is parked behind an auxiliary call: still left for its own turn (R4-1a)", async () => {
    const f = await fixture({
      framework: { messageQuietPeriod: { quietMs: 600 }, gate: { config: { policies: [], default: 'always' } } } as Partial<FrameworkConfig>,
      mcpl: {},
    });
    try {
      f.alwaysRespond();
      await f.register('room');
      await f.register('general');
      await f.framework.start();
      // An auxiliary call (a compression, say) is in flight from before the
      // burst: the room's start will park on it (providerPrimaryWaiting).
      const x = f.framework as unknown as { providerGate(agent: string): { auxiliaryInFlight: number; idleWaiters: Array<() => void> } };
      const gate = x.providerGate('agent');
      gate.auxiliaryInFlight++;
      await f.send('channels/incoming', { messages: [{
        channelId: 'room', messageId: 'r1', eventId: 'r1', timestamp: TS, author: { id: 'u', name: 'U' },
        tags: ['chat:mention', 'chat:addressed'], content: [{ type: 'text', text: 'ROOMQ agent?' }],
      }] });
      await sleep(150);
      await f.send('push/event', batch('b1', 'GENQ batch question', 'general'));
      // The room's burst is ready at +600 and its start parks; a second
      // notice of the batch lands while it is parked, then the call ends.
      await sleep(900);
      assert.equal(f.membrane.calls.length, 0, 'the start is parked');
      await f.send('push/event', { ...batch('b2', 'GENQ more', 'general'), coalesce: { channelId: 'general', key: 'doc', deferred: true } });
      await sleep(100);
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor(() => f.published.length >= 2, 'both answers', 6_000);
      await sleep(300);
      assert.deepEqual(f.published.map((p) => p.channelId), ['room', 'general'], 'general was asked, so general is answered');
      const carries = f.membrane.calls.map((c) => JSON.stringify((c as { messages?: unknown }).messages).includes('document_diff'));
      assert.deepEqual(carries, [false, true], "the room's turn left the batch though a notice replaced its wake while the start was parked");
    } finally {
      await f.close();
    }
  });
});
