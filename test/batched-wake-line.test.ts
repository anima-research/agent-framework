/**
 * A batched (debounced) wake's `[Gate: …]` line, end to end over a real MCPL
 * child. The line says which messages a wake is for; for one message that is
 * still the newest entry in the agent's window it says nothing the message
 * right above doesn't, so the wake runs without it. With anything after the
 * message, or several messages in the batch, the line stays.
 *
 * Seen live: a resident whose addressed messages wake through a 5 s debounce
 * had a third of its window made of these lines, four in five of them right
 * under the one message they named.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const GENERAL = 'discord:g1:general';
const ROOM = 'discord:g1:room';
const RAW_DM = '1548000000000000001';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('a batched wake writes its line only when it says something', () => {
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
            behavior: { debounce: 300 },
          }],
          default: 'skip',
        },
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
  const incoming = (channelId: string, mode: 'ambient' | 'addressed', text: string): void =>
    command(`incoming ${channelId} m-${++n} ${mode} ${text}`);

  /** The text of every entry in scout's window. */
  const window = (): string[] => {
    const agent = (framework as unknown as {
      agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> } }>;
    }).agents.get('scout')!;
    return agent.getContextManager().getAllMessages()
      .map((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'));
  };
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

  it('one DM, still the newest entry when its wake fires: the wake runs without a line', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('are you there?');
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    assert.ok(window().some((t) => t.includes('are you there?')), 'premise: the DM is in the window');
    assert.deepEqual(gateLines(), []);
  });

  it('one mention in a channel (channels/incoming), still the newest entry: the wake runs without a line', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    incoming(ROOM, 'addressed', '@scout are you around?');
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    assert.ok(window().some((t) => t.includes('are you around?')), 'premise: the mention is in the window');
    assert.deepEqual(gateLines(), []);
  });

  it('one DM with an ambient message stored after it: the line stays, naming the DM', async () => {
    const batches = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('are you there?');
    await waitFor(() => batches.held() >= 1, "the DM's batch, held");
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => window().some((t) => t.includes('unrelated chatter')), 'the ambient message stored');
    batches.release();
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    assert.equal(gateLines().length, 1);
    assert.match(gateLines()[0], /1 message in .*already shown above at arrival/);
  });

  it('two DMs in one batch: the line stays, counting both', async () => {
    const batches = holdBatches();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('first');
    await waitFor(() => batches.held() >= 1, "the first DM's batch, held");
    dm('second');
    await waitFor(() => window().some((t) => t.includes('second')), 'the second DM stored');
    batches.release();
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    assert.equal(gateLines().length, 1);
    assert.match(gateLines()[0], /2 messages in /);
  });
});

/**
 * What the framework answers the gate (isNewestContextEntry), against a real
 * window: true only for the event's own stored entry, newest, with no turn
 * alive, nothing deferred, and no tune-out holding it.
 */
describe('isNewestContextEntry', () => {
  let tempDir: string;
  let commandPath: string;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-line-newest-'));
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      // Stored at arrival, and nothing wakes: the window holds still.
      gate: { config: { policies: [], default: 'skip' } },
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

  type Internals = {
    isNewestContextEntry(entry: { eventType: string; serverId?: string; channelId?: string; messageId?: string; eventId?: string }): boolean;
    activeTurnTokens: Map<string, number>;
    activeStreams: Map<string, unknown>;
    deferredMessages: Array<{ forAgent?: string }>;
    addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
    agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ metadata?: Record<string, unknown>; content: Array<{ type: string; text?: string }> }> } }>;
  };
  const internals = (): Internals => framework as unknown as Internals;
  const command = (line: string): void => appendFileSync(commandPath, line + '\n');
  /** The stored metadata of the window's entry whose text includes `text`. */
  const stored = async (text: string): Promise<Record<string, unknown>> => {
    const find = () => internals().agents.get('scout')!.getContextManager().getAllMessages()
      .find((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').includes(text)));
    await waitFor(() => find() !== undefined, `"${text}" stored`);
    return find()!.metadata ?? {};
  };

  it('a push event: its own entry, newest → true; another server, another event id, or none → false', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    const ask = (over: Record<string, unknown>) => internals().isNewestContextEntry({ eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string, ...over });
    assert.equal(ask({}), true);
    assert.equal(ask({ serverId: 'other' }), false);
    assert.equal(ask({ eventId: 'ev-elsewhere' }), false);
    assert.equal(ask({ eventId: undefined }), false);
    assert.equal(ask({ serverId: undefined }), false);
    assert.equal(ask({ eventType: 'workspace:changed' }), false);
  });

  it('a channel message: by its server, channel and message id → true; another channel or message id → false', async () => {
    command(`incoming ${ROOM} m-${++n} addressed a mention`);
    const md = await stored('a mention');
    const ask = (over: Record<string, unknown>) => internals().isNewestContextEntry({
      eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: md.channelId as string, messageId: md.messageId as string, ...over,
    });
    assert.equal(ask({}), true);
    assert.equal(ask({ channelId: GENERAL }), false);
    assert.equal(ask({ messageId: 'm-elsewhere' }), false);
    assert.equal(ask({ messageId: undefined }), false);
  });

  it('not newest once anything is stored after it', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 first`);
    const md = await stored('first');
    command(`incoming ${GENERAL} m-${++n} ambient after it`);
    await stored('after it');
    assert.equal(internals().isNewestContextEntry({ eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string }), false);
  });

  it('false while a turn is alive (started, or streaming) or a write is deferred for the agent', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    const ask = () => internals().isNewestContextEntry({ eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string });
    assert.equal(ask(), true, 'premise');
    internals().activeTurnTokens.set('scout', 1);
    assert.equal(ask(), false, 'a turn started');
    internals().activeTurnTokens.delete('scout');
    internals().activeStreams.set('scout', {});
    assert.equal(ask(), false, 'a turn streaming');
    internals().activeStreams.delete('scout');
    internals().deferredMessages.push({ forAgent: 'scout' });
    assert.equal(ask(), false, 'a write deferred');
    internals().deferredMessages.pop();
    assert.equal(ask(), true);
  });

  it('false for an entry a tune-out holds from the residents', async () => {
    internals().addMessage('user', [{ type: 'text', text: 'held by a tune-out' }],
      { serverId: 'discord', eventId: 'ev-held', tuneOut: { epochId: 'epoch-1' } });
    await stored('held by a tune-out');
    assert.equal(internals().isNewestContextEntry({ eventType: 'mcpl:push-event', serverId: 'discord', eventId: 'ev-held' }), false);
  });
});
