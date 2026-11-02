/**
 * FrameworkConfig.messageQuietPeriod through real ingress (#856 R1-1, R1-6):
 * the wake-locus MCPL fixture registers two guild channels and sends
 * channels/incoming traffic or a Discord-shaped DM on command, and records
 * every channels/publish with its channel. So these tests see what a room
 * sees: how many turns a burst makes, and in which channel each reply lands.
 *
 * The gate is `always` with no debounce, so each message is its own wake and
 * the quiet period alone decides when the turns start. MockMembrane answers
 * each turn with one line of prose, which the default `locus` routing
 * publishes to the turn's channel.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
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
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  async function start(quiet: { quietMs: number; maxWaitMs?: number }): Promise<void> {
    tempDir = mkdtempSync(join(tmpdir(), 'quiet-period-e2e-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      messageQuietPeriod: quiet,
      gate: { config: { policies: [], default: 'always' } },
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
    // One response per turn: the mock hands a turn's stream every response
    // queued so far, so the second is queued once the first turn has spoken.
    reply('to room');
    incoming(ROOM, 'scout, a question in room', 'addressed');
    await sleep(200);
    incoming(GENERAL, 'scout, a question in general', 'addressed');
    await waitFor(() => publishes().length >= 1, "room's reply");
    reply('to general');
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
    await waitFor(() => publishes().length >= 1, "room's reply");
    assert.deepEqual(publishes(), [ROOM]);
    await sleep(1_200);
    assert.equal(membrane.calls.length, 1, "general's wake was read by room's turn and started none");
    assert.deepEqual(publishes(), [ROOM], 'nothing landed in general');
  });

  it("a DM's turn is not delayed by chatter elsewhere, and its reply stays in the DM (R1-1)", async () => {
    await start({ quietMs: 600, maxWaitMs: 5_000 });
    reply('answering the DM');
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
    reply('joining the room');
    // The room's chatter is ambient: what the DM's turn carried is read and
    // starts no turn; what landed after it compiled may. Either way, nothing
    // the room said is answered in the DM.
    await sleep(1_500);
    assert.equal(publishes()[0], DM);
    assert.ok(publishes().slice(1).every((c) => c === ROOM), `later replies, if any, went to the room: ${publishes().join(', ')}`);
  });
});
