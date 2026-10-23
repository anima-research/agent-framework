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
    assert.match(gateLines()[0], new RegExp(`1 message in .*discord:dm:${RAW_DM}.*already shown above at arrival`));
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
 * What keeps the line: the framework's answer to the gate's question
 * (isNewestContextEntry) is "no" while a turn is running in the window, while
 * a write waits to land there, and for a message a tune-out holds from the
 * residents. Each check is pinned here on its own: the other two don't apply.
 */
describe('a batched wake keeps its line while its message may not be the newest thing the agent sees', () => {
  let tempDir: string;
  let framework: AgentFramework;

  type Internals = {
    addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>, opts?: { forAgent?: string }): unknown;
    activeTurnTokens: Map<string, number>;
    deferredMessages: unknown[];
    isNewestContextEntry(entry: { eventType: string; serverId?: string; channelId?: string; messageId?: string; eventId?: string }): boolean;
  };
  const internals = (): Internals => framework as unknown as Internals;
  const DM = { eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:dm:1', messageId: 'dm-1' };
  const storeDm = (extra: Record<string, unknown> = {}): void => {
    internals().addMessage('antra', [{ type: 'text', text: 'are you there?' }],
      { serverId: DM.serverId, channelId: DM.channelId, messageId: DM.messageId, ...extra });
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-line-checks-'));
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
  });

  afterEach(async () => {
    internals().activeTurnTokens.clear();
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('control: the message just stored, with nothing running or waiting, is the newest entry', () => {
    storeDm();
    assert.equal(internals().isNewestContextEntry(DM), true);
  });

  it('not while a turn is running in the window: its output lands before the compile', () => {
    storeDm();
    internals().activeTurnTokens.set('scout', 1);
    assert.equal(internals().isNewestContextEntry(DM), false);
  });

  it('not while a write waits to land in the window: it lands before the compile', () => {
    storeDm();
    // A write made during a turn waits for the turn's boundary; the turn then ends with it still queued.
    internals().activeTurnTokens.set('scout', 1);
    internals().addMessage('user', [{ type: 'text', text: 'a note written mid-turn' }], { kind: 'test-note' });
    internals().activeTurnTokens.delete('scout');
    assert.equal(internals().deferredMessages.length, 1, 'premise: the write is still queued');
    assert.equal(internals().isNewestContextEntry(DM), false);
  });

  it('not for a message a tune-out holds: the agent never sees it, so only the line names it', () => {
    storeDm({ tuneOut: { epochId: 'epoch-1' } });
    assert.equal(internals().isNewestContextEntry(DM), false);
  });

  it('a channel message is its own only in its channel and on its server', () => {
    storeDm();
    assert.equal(internals().isNewestContextEntry({ ...DM, channelId: 'discord:dm:2' }), false, 'another channel');
    assert.equal(internals().isNewestContextEntry({ ...DM, serverId: 'slack' }), false, 'another server');
    assert.equal(internals().isNewestContextEntry({ ...DM, messageId: 'dm-2' }), false, 'another message');
  });

  it('a push event is found by its server and event id', () => {
    internals().addMessage('antra', [{ type: 'text', text: 'are you there?' }],
      { serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' });
    const push = { eventType: 'mcpl:push-event', serverId: 'discord', eventId: 'ev-1' };
    assert.equal(internals().isNewestContextEntry(push), true);
    assert.equal(internals().isNewestContextEntry({ ...push, eventId: 'ev-2' }), false, 'another event');
    assert.equal(internals().isNewestContextEntry({ ...push, serverId: 'slack' }), false, 'another server');
  });
});
