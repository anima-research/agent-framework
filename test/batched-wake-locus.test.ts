/**
 * Batched (debounced) wakes and outbound routing, end to end over a real MCPL
 * child: a DM push event (raw snowflake channel id, as discord-mcpl sends it)
 * and ambient channel traffic land in the same debounce window.
 *
 * Before: a batched wake carried no channel, so the turn froze on the
 * process-global most-recent-inbound channel. channels/incoming retargets
 * that; a DM push event never does. Either order misrouted the DM reply:
 *   - ambient AFTER the DM: the ambient channel became the fallback;
 *   - ambient BEFORE the DM: the DM never displaced it.
 * Now a batch containing an addressed message routes to that message's
 * registered channel. An ambient-only batch names no channel: under the
 * default `speech.locus: 'delivery'` the turn has no locus, its prose stays
 * private, and the resident is told which channels the batch came from;
 * under `'latest-inbound'` it keeps the legacy fallback.
 *
 * The tests hold the gate's batch until both events are in it (holdBatches),
 * so they don't depend on the second reaching the gate inside the window.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { conversationForkSpec } from '../src/dendrite/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { appendInTwoParts } from './helpers/command-file.js';
import { jsonLines } from './helpers/json-lines.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const RAW_DM = '1548000000000000001';
const DM = `discord:dm:${RAW_DM}`;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function batchedWakeRig(opts: {
  speech?: { locus: 'delivery' | 'latest-inbound' };
  proseRouting?: 'locus' | 'hybrid';
} = {}) {
  const { speech, proseRouting } = opts;
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-locus-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', ...(proseRouting ? { proseRouting } : {}) }],
      ...(speech ? { speech } : {}),
      gate: {
        config: {
          policies: [{
            name: 'batch',
            match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] },
            behavior: { debounce: 100 },
          }],
          default: 'skip',
        },
      },
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
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (line: string): void => appendFileSync(commandPath, line + '\n');
  const dmLine = (text: string): string => `dm ev-${++n} 134 ${RAW_DM} ${text}`;
  const dm = (text: string): void => command(dmLine(text));
  // A DM written in two parts, as a poll can read a write half done.
  const dmInTwoParts = (text: string): Promise<void> => appendInTwoParts(commandPath, dmLine(text), 200);
  const incoming = (channelId: string, mode: 'ambient' | 'addressed', text: string): void =>
    command(`incoming ${channelId} m-${++n} ${mode} ${text}`);
  const sent = (event: string): number => jsonLines<{ event: string }>(statusPath).filter((e) => e.event === event).length;
  const publishes = (): string[] => jsonLines<{ event: string; channelId?: string }>(statusPath)
      .filter((e) => e.event === 'publish')
      .map((e) => e.channelId!);

  /**
   * Holds the gate's batches: when a batch's timer fires with fewer than
   * `size` events in it (two by default), the batch stays pending, and the
   * returned function counts
   * those held fires. A test that pairs two sends calls this, sends its first
   * event, waits until that event's batch has been held past its 100 ms
   * window, and then sends the second, which joins the same batch. That batch
   * fires on the timer the second event starts, with both events in it,
   * however long the second took to arrive. Without the hold, whether the
   * two share a batch depends on the second reaching the gate within 100 ms
   * of the first, which a loaded runner can miss.
   *
   * The hold lasts for the rest of the test, since each test builds its own
   * framework. It reaches three private members, each checked here, so a
   * rename fails at this helper. A batch that fires without passing through
   * the hold never counts a held fire, so its test times out waiting for one.
   */
  const holdBatches = (size = 2): (() => number) => {
    const gate = (framework as unknown as {
      eventGate: { debounceTimers: Map<string, { events: unknown[] }>; fireDebounce(policyName: string): void } | null;
    }).eventGate;
    assert.ok(gate, 'premise: the framework has a gate');
    assert.ok(gate.debounceTimers instanceof Map, 'premise: the gate keeps its pending batches in debounceTimers');
    assert.equal(typeof gate.fireDebounce, 'function', 'premise: the gate fires a batch through fireDebounce');
    const fire = gate.fireDebounce.bind(gate);
    let held = 0;
    gate.fireDebounce = (policyName) => {
      if ((gate.debounceTimers.get(policyName)?.events.length ?? 0) >= size) fire(policyName);
      else held++;
    };
    return () => held;
  };

  return {
    membrane: () => membrane,
    framework: () => framework,
    dm, dmInTwoParts, incoming, sent, publishes, holdBatches,
  };
}

function assertNamesBatchChannels(notice: string, channels: string[]): void {
  const shown = channels.map((c) => `#${c} (discord:g1:${c})`);
  const where = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  assert.ok(notice.includes(
    `had no channel to go to — this turn came from ${where}, and what came from ${channels.length === 1 ? 'there' : 'those'} ` +
    `didn't address you, and no channel was chosen for its reply; to reply ${channels.length === 1 ? 'there' : 'in one of them'}, ` +
    'send your reply to that channel explicitly. This is a routing situation, not a channel failure.'), notice);
  assert.ok(!notice.includes('came from no channel'), notice);
  assert.ok(!notice.includes('configuration'), 'nothing is misconfigured when no message of a batch addressed the agent');
}

async function ambientBatchHasNoLocus(rig: ReturnType<typeof batchedWakeRig>, channels: string[], named: string[]): Promise<void> {
  const held = channels.length > 1 ? rig.holdBatches(channels.length) : undefined;
  rig.membrane().pushResponse(createMockResponse([{ type: 'text', text: 'joining in' }]));
  rig.incoming(channels[0]!, 'ambient', 'message 1');
  if (held) {
    await waitFor(() => rig.sent('incoming-sent') === 1, 'first sent');
    await waitFor(() => held() >= 1, "the first message's batch held past its window");
  }
  channels.slice(1).forEach((channel, i) => rig.incoming(channel, 'ambient', `message ${i + 2}`));
  await waitFor(() => rig.membrane().calls.length >= 1, 'the batch woke the agent');
  await rig.framework().runUntilIdle();
  assert.deepEqual(rig.publishes(), [], 'nothing was published: no delivery woke this turn');
  const texts = rig.framework().getAgent('scout')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
  assert.ok(texts.includes('joining in'), 'the prose stays in the window');
  const notices = texts.filter((t) => t.startsWith('[send-undeliverable]'));
  assert.equal(notices.length, 1, JSON.stringify(texts));
  assertNamesBatchChannels(notices[0]!, named);
}

describe('batched wake routing', () => {
  const rig = batchedWakeRig();
  const { dm, dmInTwoParts, incoming, sent, publishes, holdBatches } = rig;
  const membrane = { pushResponse: (r: ReturnType<typeof createMockResponse>) => rig.membrane().pushResponse(r) };

  it('a DM followed one beat later by ambient chatter elsewhere, in one batch: the reply goes to the DM', async () => {
    const held = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the DM' }]));
    // In two parts, as a poll can read a write half done: the fixture sends
    // the DM only once its line is whole. Sent from the first part, which
    // ends inside the raw channel id, it would carry no text, and the host
    // refuses that, so no batch would be held.
    await dmInTwoParts('are you there?');
    await waitFor(() => sent('dm-sent') === 1, 'dm sent');
    await waitFor(() => held() >= 1, "the DM's batch held past its window");
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [DM]);
  });

  it('ambient chatter followed by a DM in the same window: the reply goes to the DM', async () => {
    const held = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the DM' }]));
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => sent('incoming-sent') === 1, 'ambient sent');
    await waitFor(() => held() >= 1, "the ambient message's batch held past its window");
    dm('quick question');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [DM]);
  });

  it('a mention in one channel then ambient chatter in another: the reply goes to the mention', async () => {
    const held = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the mention' }]));
    incoming(ROOM, 'addressed', '@scout hello');
    await waitFor(() => sent('incoming-sent') === 1, 'mention sent');
    await waitFor(() => held() >= 1, "the mention's batch held past its window");
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [ROOM]);
  });

  it('two closed channels addressed in one batch: the turn speaks in the later one, and no [routing] notice names the earlier', async () => {
    // main's test (#852), read onto this branch's rig: the framework is the
    // rig's accessor, and the batch's addressed message picks the locus
    // under the default 'delivery' rule as it does under main's.
    const framework = rig.framework();
    const registry = (framework as unknown as {
      channelRegistry: { handleChannelToolCall(name: string, args: Record<string, unknown>, caller: { kind: 'agent'; agentName: string }): Promise<{ success: boolean }> };
    }).channelRegistry;
    for (const channelId of [ROOM, GENERAL]) {
      assert.equal((await registry.handleChannelToolCall('channel_close', { channelId }, { kind: 'agent', agentName: 'scout' })).success, true);
    }
    const held = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering' }]));
    incoming(ROOM, 'addressed', '@scout first');
    await waitFor(() => held() >= 1, "the first message's batch held past its window");
    incoming(GENERAL, 'addressed', '@scout second');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [GENERAL]);
    const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text));
    const invitation = texts.find((t) => t.includes('[Channel invitation]') && t.includes('first')) ??
      texts.find((t, i) => t.includes('[Channel invitation]') && texts[i - 1]?.includes('first'));
    assert.ok(invitation?.includes('If that is #room'), String(invitation));
    assert.ok(invitation?.includes('write your reply with no prefix'), String(invitation));
    assert.ok(invitation?.includes('If that is another channel, or you see none, to reply here'), String(invitation));
    const routing = texts.filter((t) => t.startsWith('[routing]'));
    assert.ok(routing.length >= 1 && routing.at(-1)!.includes('general'), JSON.stringify(routing));
    assert.ok(!routing.some((t) => t.includes('room')), JSON.stringify(routing));
  });

  it('an ambient batch of one message has no locus: its prose stays private, and the resident is told the channel it came from', async () => {
    await ambientBatchHasNoLocus(rig, [ROOM], ['room']);
  });

  it('an ambient batch of two messages from one channel names that channel once', async () => {
    await ambientBatchHasNoLocus(rig, [ROOM, ROOM], ['room']);
  });

  it('an ambient batch from two channels has no locus: its prose stays private, and the resident is told which channels the batch came from', async () => {
    await ambientBatchHasNoLocus(rig, [ROOM, GENERAL], ['room', 'general']);
  });

  it('an ambient batch of three messages from two channels names each channel once, in the order they first appear', async () => {
    await ambientBatchHasNoLocus(rig, [ROOM, GENERAL, ROOM], ['room', 'general']);
  });

  it("a sleep's announcement in a turn from two channels is told those channels", async () => {
    const held = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'sleep-1', name: 'sleep', input: { seconds: 60 } }], 'tool_use'));
    incoming(ROOM, 'ambient', 'first');
    await waitFor(() => sent('incoming-sent') === 1, 'first sent');
    await waitFor(() => held() >= 1, "the first message's batch held past its window");
    incoming(GENERAL, 'ambient', 'second');
    await waitFor(() => rig.membrane().calls.length >= 1, 'the batch woke the agent');
    await rig.framework().runUntilIdle();
    assert.deepEqual(publishes(), []);
    const texts = rig.framework().getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    const notices = texts.filter((t) => t.startsWith('[send-undeliverable]'));
    assert.equal(notices.length, 1, "the announcement's, since a sleep ends the turn: " + JSON.stringify(texts));
    assertNamesBatchChannels(notices[0]!, ['room', 'general']);
  });
});

describe("batched wake routing under speech.locus 'latest-inbound'", () => {
  const rig = batchedWakeRig({ speech: { locus: 'latest-inbound' } });
  const { incoming, sent, publishes, holdBatches } = rig;

  it('an ambient-only batch keeps the legacy fallback (most recent inbound)', async () => {
    const held = holdBatches();
    rig.membrane().pushResponse(createMockResponse([{ type: 'text', text: 'joining in' }]));
    incoming(ROOM, 'ambient', 'first');
    await waitFor(() => sent('incoming-sent') === 1, 'first sent');
    await waitFor(() => held() >= 1, "the first message's batch held past its window");
    incoming(GENERAL, 'ambient', 'second');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [GENERAL]);
    await rig.framework().runUntilIdle();
    const texts = rig.framework().getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    assert.ok(!texts.some((t) => t.startsWith('[send-undeliverable]')), 'a turn the fallback gave a channel gets no notice');
  });
});

describe("batched wake routing with proseRouting 'hybrid'", () => {
  const rig = batchedWakeRig({ proseRouting: 'hybrid' });

  it("an ambient batch from two channels has no locus, and the resident's notice names them", async () => {
    await ambientBatchHasNoLocus(rig, [ROOM, GENERAL], ['room', 'general']);
  });
});

describe('batched wake routing with conversation forks', () => {
  let tempDir: string;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-locus-fork-'));
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'trunk', model: 'test-model', systemPrompt: 'You are trunk.' },
      ],
      gate: {
        config: {
          policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 50 } }],
          default: 'skip',
        },
      },
      modules: [],
    });
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('the addressed route applies only to the fork homed there; other forks and the trunk get none', async () => {
    const internals = framework as unknown as {
      registry: { register(spec: ReturnType<typeof conversationForkSpec>): unknown };
      pendingRequests: Array<{ agentName: string; channelId?: string; channelServerId?: string; addressed?: boolean; counterparty?: string }>;
      eventGate: { evaluate(info: unknown): unknown };
    };
    // A conversation fork's home is its registry record (Dendrite); the gate
    // fans out to every agent that receives gate wakes, forks included.
    internals.registry.register(conversationForkSpec('fork-room', { template: 'trunk', homeChannel: { serverId: 'discord', channelId: ROOM }, idleTtlMs: 60_000 }));
    internals.registry.register(conversationForkSpec('fork-other', { template: 'trunk', homeChannel: { serverId: 'discord', channelId: GENERAL }, idleTtlMs: 60_000 }));
    internals.eventGate.evaluate({
      content: '@agent hi', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: ROOM,
      tags: ['chat:addressed'], metadata: { authorId: '5' },
    });
    await waitFor(() => internals.pendingRequests.some((r) => r.agentName === 'fork-other'), 'gate wake broadcast');
    const byAgent = new Map(internals.pendingRequests.map((r) => [r.agentName, r]));
    assert.equal(byAgent.get('fork-room')?.channelId, ROOM, 'the fork that owns the channel takes the route');
    assert.equal(byAgent.get('fork-room')?.channelServerId, 'discord', "with the route's server");
    assert.equal(byAgent.get('fork-room')?.addressed, true);
    assert.equal(byAgent.get('fork-other')!.channelId, undefined, 'a fork bound elsewhere gets no locus');
    assert.ok(byAgent.has('trunk'), 'the trunk is woken too');
    assert.equal(byAgent.get('trunk')!.channelId, undefined, 'the trunk never takes a fork-bound channel');
    // Telemetry provenance still reaches every agent.
    assert.equal(byAgent.get('fork-other')?.counterparty, 'discord:user:5');
  });
});
