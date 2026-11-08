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
 * default `speech.locus: 'delivery'` the turn has no locus and its prose
 * stays private; under `'latest-inbound'` it keeps the legacy fallback.
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

function batchedWakeRig(speech?: { locus: 'delivery' | 'latest-inbound' }) {
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
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
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
   * Holds the gate's batches: when a batch's timer fires with fewer than two
   * events in it, the batch stays pending, and the returned function counts
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
  const holdBatches = (): (() => number) => {
    const gate = (framework as unknown as {
      eventGate: { debounceTimers: Map<string, { events: unknown[] }>; fireDebounce(policyName: string): void } | null;
    }).eventGate;
    assert.ok(gate, 'premise: the framework has a gate');
    assert.ok(gate.debounceTimers instanceof Map, 'premise: the gate keeps its pending batches in debounceTimers');
    assert.equal(typeof gate.fireDebounce, 'function', 'premise: the gate fires a batch through fireDebounce');
    const fire = gate.fireDebounce.bind(gate);
    let held = 0;
    gate.fireDebounce = (policyName) => {
      if ((gate.debounceTimers.get(policyName)?.events.length ?? 0) >= 2) fire(policyName);
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

  it("an ambient-only batch names no channel: under the default rule the turn has no locus and its prose stays private", async () => {
    const held = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'joining in' }]));
    incoming(ROOM, 'ambient', 'first');
    await waitFor(() => sent('incoming-sent') === 1, 'first sent');
    await waitFor(() => held() >= 1, "the first message's batch held past its window");
    incoming(GENERAL, 'ambient', 'second');
    await waitFor(() => rig.membrane().calls.length >= 1, 'the batch woke the agent');
    await rig.framework().runUntilIdle();
    assert.deepEqual(publishes(), [], 'nothing was published: no delivery woke this turn');
    const texts = rig.framework().getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    // The announce-on-change baseline treats "no channel" as the state a
    // resident boots in, so a first turn without a locus adds no notice; a
    // later turn that loses one is told (announceLocusIfChanged).
    assert.ok(texts.includes('joining in'), 'the prose stays in the window');
  });
});

describe("batched wake routing under speech.locus 'latest-inbound'", () => {
  const rig = batchedWakeRig({ locus: 'latest-inbound' });
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
