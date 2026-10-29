/**
 * A batched (debounced) wake's `[Gate: …]` line, end to end over a real MCPL
 * child. The line says which messages a wake is for; for one message that is
 * still the newest entry in the agent's window it says nothing the message
 * right above doesn't, so the delivery agent's wake runs without it. With
 * anything after the message, or several messages in the batch, the line
 * stays. The gate hands such a line to the wake, and a fresh start of the
 * wake's turn decides it (placeWakeLines).
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
import { AgentFramework, CLOCK_ROW_KIND, wakeLineText } from '../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const GENERAL = 'discord:g1:general';
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
            behavior: { debounce: 100 },
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

  /** The text of the first request's messages, in order. */
  const requestTexts = (): string[] => {
    const request = membrane.calls[0] as unknown as { messages: Array<{ content: unknown }> };
    return request.messages.map((m) => (Array.isArray(m.content)
      ? (m.content as Array<{ type: string; text?: string }>).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('\n')
      : String(m.content)));
  };
  type Internals = {
    eventGate: { fireDebounce(policyName: string): void } | null;
    addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
    pendingRequests: Array<Record<string, unknown>>;
    agents: Map<string, { getContextManager(): { getAllMessages(): Array<{ metadata?: Record<string, unknown>; content: Array<{ type: string; text?: string }> }> } }>;
  };
  const internals = (): Internals => framework as unknown as Internals;

  it('one DM, and a message stored after its batch fires but before the turn starts: the line comes back after it, naming the DM', async () => {
    const gate = internals().eventGate!;
    const fire = gate.fireDebounce.bind(gate);
    gate.fireDebounce = (policyName) => {
      fire(policyName);
      // After the gate decided, before the turn compiles, as a provider hold
      // or a compression in flight leaves room for.
      internals().addMessage('someone', [{ type: 'text', text: 'unrelated chatter' }],
        { serverId: 'discord', channelId: GENERAL, messageId: 'm-later' });
    };
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('are you there?');
    await waitFor(() => membrane.calls.length >= 1, 'the wake');
    const texts = requestTexts();
    const dmAt = texts.findIndex((t) => t.includes('are you there?'));
    const laterAt = texts.findIndex((t) => t.includes('unrelated chatter'));
    const lineAt = texts.findIndex((t) => t.includes('[Gate:'));
    assert.ok(dmAt >= 0 && laterAt > dmAt, 'premise: the later message comes after the DM');
    assert.ok(lineAt > laterAt, `the line follows what arrived in the gap (DM ${dmAt}, later ${laterAt}, line ${lineAt})`);
    assert.match(texts[lineAt], new RegExp(`1 message in .*discord:dm:${RAW_DM}.*already shown above at arrival`));
    assert.equal(gateLines().length, 1, 'written once');
  });

  it('four wakes merged into one turn, two carrying the same handed line and two the same message id in different channels: each line is written once', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hello back' }]));
    dm('are you there?');
    await waitFor(() => membrane.calls.length >= 1, 'the first wake');
    await framework.runUntilIdle();
    const md = internals().agents.get('scout')!.getContextManager().getAllMessages()
      .find((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').includes('are you there?')))!.metadata!;
    internals().addMessage('someone', [{ type: 'text', text: 'unrelated chatter' }],
      { serverId: 'discord', channelId: GENERAL, messageId: 'm-later' });
    const line = {
      shown: 'a DM', at: Date.now(),
      entry: { eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string },
      policyNames: ['addressed'],
    };
    const other = {
      shown: '#general', at: Date.now(),
      entry: { eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: GENERAL, messageId: 'm-later' },
      policyNames: ['addressed'],
    };
    const calls = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'again' }]));
    // The same message id in another channel is another event.
    const elsewhere = { ...other, shown: '#random', entry: { ...other.entry, channelId: 'discord:g1:random' } };
    for (const lines of [[line], [{ ...line }], [other], [elsewhere]]) {
      internals().pendingRequests.push({ agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: Date.now(), wakeLines: lines });
    }
    await waitFor(() => membrane.calls.length > calls, 'the merged wake');
    assert.equal(membrane.calls.length, calls + 1, 'premise: one turn');
    assert.equal(gateLines().filter((t) => t.includes('1 message in a DM')).length, 1);
    assert.equal(gateLines().filter((t) => t.includes('1 message in #general')).length, 1);
    assert.equal(gateLines().filter((t) => t.includes('1 message in #random')).length, 1);
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

  type Placing = {
    placeWakeLines(agent: unknown, lines: Array<{ shown: string; at: number; entry: Record<string, unknown>; policyNames: string[]; channelId?: string }>): void;
  };
  const lineFor = (md: Record<string, unknown>, shown: string, at = Date.now()) => ({
    shown, at, entry: { eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string }, policyNames: ['addressed'], channelId: 'discord:dm:1',
  });
  const linesIn = (needle: string): number => framework.getAgent('scout')!.getContextManager().getAllMessages()
    .filter((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').includes(needle))).length;
  const scout = () => (framework as unknown as { agents: Map<string, unknown> }).agents.get('scout');

  it('at the turn\'s start, a handed line whose message is still newest is left out; once something is after it, it is written', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    const placing = framework as unknown as Placing;
    const traces: Array<{ type: string; reason?: string; eventType?: string; policyNames?: string[] }> = [];
    framework.onTrace((event) => { traces.push(event as unknown as { type: string }); });
    const line = lineFor(md, '[Gate: LINE-A]');
    placing.placeWakeLines(scout(), [line]);
    assert.equal(linesIn('LINE-A'), 0, 'still newest: left out');
    const omitted = traces.filter((t) => t.type === 'gate:wake-line-omitted');
    assert.equal(omitted.length, 1, 'and traced');
    assert.equal(omitted[0].reason, 'newest');
    assert.equal(omitted[0].eventType, 'mcpl:push-event');
    assert.deepEqual(omitted[0].policyNames, ['addressed']);
    internals().addMessage('someone', [{ type: 'text', text: 'after it' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-after' });
    placing.placeWakeLines(scout(), [line]);
    assert.equal(linesIn('LINE-A'), 1, 'no longer newest: written');
    const written = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .find((m) => m.content.some((b) => b.type === 'text' && ((b as { text?: string }).text ?? '').includes('LINE-A')))!;
    assert.equal((written.metadata as { source?: unknown } | undefined)?.source, 'gate:debounce');
    assert.deepEqual(traces.filter((t) => t.type === 'message:added' && (t as { source?: string }).source === 'gate:wake-line').length, 1, 'its write traced as message:added');
    placing.placeWakeLines(scout(), [line]);
    assert.equal(linesIn('LINE-A'), 1, 'written once: a later start writes it no second time');
  });

  it('two handed lines are both written, each naming its message, even when one message is still newest', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 first DM`);
    const first = await stored('first DM');
    command(`dm ev-${++n} 134 1548000000000000001 second DM`);
    const second = await stored('second DM');
    (framework as unknown as Placing).placeWakeLines(scout(), [lineFor(first, '[Gate: LINE-1]'), lineFor(second, '[Gate: LINE-2]')]);
    assert.equal(linesIn('LINE-1'), 1);
    assert.equal(linesIn('LINE-2'), 1);
  });

  it('a line whose write fails doesn\'t fail the start and stays undecided for a later one; one that landed though its write threw counts as written', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    internals().addMessage('someone', [{ type: 'text', text: 'after it' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-after' });
    const cm = internals().agents.get('scout')!.getContextManager() as unknown as { addMessage: (...a: unknown[]) => unknown };
    const real = cm.addMessage;
    cm.addMessage = () => { throw new Error('store unavailable'); };
    const line = lineFor(md, 'LINE-FAIL');
    try {
      (framework as unknown as Placing).placeWakeLines(scout(), [line]);
    } finally {
      cm.addMessage = real;
    }
    assert.equal(linesIn('LINE-FAIL'), 0, 'not written');
    (framework as unknown as Placing).placeWakeLines(scout(), [line]);
    assert.equal(linesIn('LINE-FAIL'), 1, 'written by the next start');
    // A write that throws after its row landed counts as written.
    const landing = lineFor(md, 'LINE-LANDED');
    cm.addMessage = (...a: unknown[]) => { real.apply(cm, a); throw new Error('propagation failed'); };
    try {
      (framework as unknown as Placing).placeWakeLines(scout(), [landing]);
    } finally {
      cm.addMessage = real;
    }
    assert.equal(linesIn('LINE-LANDED'), 1, 'it landed');
    (framework as unknown as Placing).placeWakeLines(scout(), [landing]);
    assert.equal(linesIn('LINE-LANDED'), 1, 'and the next start writes it no second time');
  });

  it('two lines, one already written by an earlier start: the other is written though its message is newest', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 first DM`);
    const first = await stored('first DM');
    const one = lineFor(first, '[Gate: LINE-E1]');
    internals().addMessage('someone', [{ type: 'text', text: 'after it' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: `m-e-${n}` });
    (framework as unknown as Placing).placeWakeLines(scout(), [one]);
    assert.equal(linesIn('LINE-E1'), 1, 'premise: the earlier start wrote the first');
    command(`dm ev-${++n} 134 1548000000000000001 second DM`);
    const second = await stored('second DM');
    (framework as unknown as Placing).placeWakeLines(scout(), [one, lineFor(second, '[Gate: LINE-E2]')]);
    assert.equal(linesIn('LINE-E1'), 1, 'the first no second time');
    assert.equal(linesIn('LINE-E2'), 1, 'the second written: the wake has two causes');
  });

  it('a handed line written later counts its message\'s age to when it is written', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    internals().addMessage('someone', [{ type: 'text', text: 'after it' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-after' });
    (framework as unknown as Placing).placeWakeLines(scout(), [lineFor(md, 'LINE-AGE', Date.now() - 60_000)]);
    const written = internals().agents.get('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).map((b) => (b.type === 'text' ? b.text ?? '' : '')).find((t) => t.includes('LINE-AGE'));
    const age = Number(/^\[Gate: 1 event matched\]\n\n- 1 message in LINE-AGE \(oldest ~(\d+)s ago\) — already shown above at arrival; this is a batched wake, not new content$/.exec(written ?? '')?.[1]);
    assert.ok(age >= 60, `counted to the write, not from it: ~${age}s`);
    const fixed = lineFor(md, 'LINE-AGE', 5_000);
    assert.match(wakeLineText(fixed, 65_000), /^\[Gate: 1 event matched\]\n\n- 1 message in LINE-AGE \(oldest ~60s ago\) — already shown above at arrival/, 'the package\'s wakeLineText counts from the event to the time it\'s given');
  });

  it('a registered agent that doesn\'t read the window (an ephemeral run) writes no handed line', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    internals().addMessage('someone', [{ type: 'text', text: 'after it' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-after' });
    const run = await framework.createEphemeralAgent({ name: `run-${n}`, model: 'test-model', systemPrompt: 'Do the task.' });
    try {
      (framework as unknown as Placing).placeWakeLines(run.agent, [lineFor(md, '[Gate: LINE-F]')]);
      const own = run.contextManager.getAllMessages().filter((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').includes('LINE-F')));
      assert.equal(own.length, 0, 'nothing written to the run\'s window');
      assert.equal(linesIn('LINE-F'), 0, 'nor to the primary\'s');
    } finally {
      run.cleanup();
    }
  });

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

  it('still newest with a clock row after it; not newest with a message after the clock row', async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    const ask = () => internals().isNewestContextEntry({ eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string });
    const cm = internals().agents.get('scout')!.getContextManager() as unknown as { addMessage(participant: string, content: unknown[], metadata: unknown): unknown };
    cm.addMessage('user', [{ type: 'text', text: '[clock row]' }], { system: true, kind: CLOCK_ROW_KIND, clock: { at: Date.now() } });
    assert.equal(ask(), true, 'a clock row isn\'t a message a reply could be meant for');
    internals().addMessage('someone', [{ type: 'text', text: 'after the clock' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: `m-c-${n}` });
    assert.equal(ask(), false);
  });

  it("still newest with a row the agent's view leaves out after it, as a tune-out's", async () => {
    command(`dm ev-${++n} 134 1548000000000000001 a DM`);
    const md = await stored('a DM');
    internals().addMessage('someone', [{ type: 'text', text: 'diverted after it' }],
      { serverId: 'discord', channelId: 'discord:g1:general', messageId: `m-t-${n}`, tuneOut: { epochId: 'epoch-1' } });
    await stored('diverted after it');
    assert.equal(internals().isNewestContextEntry({ eventType: 'mcpl:push-event', serverId: 'discord', eventId: md.eventId as string }), true);
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

/** The first call meets an organization-acceleration 429 (a provider hold),
 *  the next succeeds. */
class HoldThenAnswerMembrane extends MockMembrane {
  private n = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    if (++this.n === 1) {
      const error = new MembraneError({
        type: 'rate_limit', retryable: true, httpStatus: 429,
        message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
        rawError: { status: 429 }, rawRequest: request,
      });
      return {
        isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
        provideToolResults() { throw new Error('not waiting'); },
        cancel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> { yield { type: 'error', error } as StreamEvent; },
      } as unknown as YieldingStream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]);
  }
}

describe('a handed line is written once per wake', () => {
  it('a start that resumes a logical turn takes in no handed line, as it takes in no deferred write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-line-resume-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
      pendingRequests: Array<Record<string, unknown>>;
    };
    try {
      internals.addMessage('antra', [{ type: 'text', text: 'are you there?' }], { serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' });
      internals.addMessage('someone', [{ type: 'text', text: 'unrelated chatter' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-later' });
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      internals.pendingRequests.push({
        agentName: 'scout', reason: 'tool_result_guard_retry', source: 'framework', timestamp: Date.now(),
        wakeLines: [{ shown: 'LINE-RESUME', at: Date.now(), entry: { eventType: 'mcpl:push-event', serverId: 'discord', eventId: 'ev-1' }, policyNames: ['addressed'] }],
      });
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'premise: the resuming start ran');
      const lines = framework.getAgent('scout')!.getContextManager().getAllMessages()
        .filter((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').includes('LINE-RESUME'))).length;
      assert.equal(lines, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a turn the provider holds after its start wrote the line: the hold\'s fresh compile doesn\'t write it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-line-once-'));
    const membrane = new HoldThenAnswerMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      providerAccelerationDefaultCooldownMs: number;
      providerAccelerationJitterMs: number;
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
      pendingRequests: Array<Record<string, unknown>>;
    };
    // A hold long enough to outlast the test, released by hand once its premise holds.
    internals.providerAccelerationDefaultCooldownMs = 60_000;
    internals.providerAccelerationJitterMs = 0;
    try {
      internals.addMessage('antra', [{ type: 'text', text: 'are you there?' }], { serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' });
      internals.addMessage('someone', [{ type: 'text', text: 'unrelated chatter' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-later' });
      internals.pendingRequests.push({
        agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: Date.now(),
        wakeLines: [{ shown: 'LINE-ONCE', at: Date.now(), entry: { eventType: 'mcpl:push-event', serverId: 'discord', eventId: 'ev-1' }, policyNames: ['addressed'] }],
      });
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'premise: the first attempt met the hold');
      releaseHoldNow(framework, 'scout');
      await settleUntil(framework, () => membrane.calls.length >= 2, 'the hold\'s fresh compile');
      const lines = framework.getAgent('scout')!.getContextManager().getAllMessages()
        .filter((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').includes('LINE-ONCE'))).length;
      assert.equal(lines, 1);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a line its first start left out, then a provider hold with an arrival during it: the hold\'s fresh start writes the line after the arrival', async () => {
    // Nigel-2405's case: the DM is alone when the start runs, and the chatter is stored during the hold.
    const dir = mkdtempSync(join(tmpdir(), 'wake-line-omit-hold-'));
    const membrane = new HoldThenAnswerMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      providerAccelerationDefaultCooldownMs: number;
      providerAccelerationJitterMs: number;
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
      pendingRequests: Array<Record<string, unknown>>;
    };
    // A hold long enough to outlast the test, released by hand once its premise holds.
    internals.providerAccelerationDefaultCooldownMs = 60_000;
    internals.providerAccelerationJitterMs = 0;
    const texts = () => framework.getAgent('scout')!.getContextManager().getAllMessages()
      .map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
    try {
      internals.addMessage('antra', [{ type: 'text', text: 'are you there?' }], { serverId: 'discord', eventId: 'ev-1', channelId: 'discord:dm:1' });
      internals.pendingRequests.push({
        agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp: Date.now(),
        wakeLines: [{ shown: 'LINE-OMIT', at: Date.now(), entry: { eventType: 'mcpl:push-event', serverId: 'discord', eventId: 'ev-1' }, policyNames: ['addressed'] }],
      });
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'premise: the first attempt met the hold');
      assert.equal(texts().filter((t) => t.includes('LINE-OMIT')).length, 0, 'premise: the first start left the line out');
      internals.addMessage('someone', [{ type: 'text', text: 'unrelated chatter' }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: 'm-during-hold' });
      releaseHoldNow(framework, 'scout');
      await settleUntil(framework, () => membrane.calls.length >= 2, 'the hold\'s fresh compile');
      const all = texts();
      const chatter = all.findIndex((t) => t.includes('unrelated chatter'));
      const line = all.findIndex((t) => t.includes('LINE-OMIT'));
      assert.ok(chatter >= 0, 'premise: the chatter was stored during the hold');
      assert.ok(line > chatter, `the line follows the chatter (chatter ${chatter}, line ${line})`);
      assert.equal(all.filter((t) => t.includes('LINE-OMIT')).length, 1, 'written once');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a handed line across readers, a flush, a quiesce and a hold', () => {
  type Bare = {
    framework: AgentFramework;
    membrane: MockMembrane;
    dir: string;
    internals: {
      addMessage(participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>): string;
      pendingRequests: Array<Record<string, unknown>>;
      activeTurnTokens: Map<string, number>;
      sharedSlotAgents: Set<unknown>;
      providerAccelerationCooldowns: Map<string, Record<string, unknown>>;
      releaseProviderAccelerationCooldown(name: string): void;
      placeWakeLines(agent: unknown, lines: unknown[]): void;
      processInferenceRequests(): Promise<void>;
    };
  };
  const bare = async (names: string[]): Promise<Bare> => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-line-bare-'));
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
  const dmLine = (eventId: string, shown: string) => ({
    shown, at: Date.now(), entry: { eventType: 'mcpl:push-event', serverId: 'discord', eventId }, policyNames: ['addressed'],
  });
  const storeDm = (b: Bare, eventId: string, text: string): void => {
    b.internals.addMessage('antra', [{ type: 'text', text }], { serverId: 'discord', eventId, channelId: 'discord:dm:1' });
  };
  const storeChatter = (b: Bare, text = 'unrelated chatter'): void => {
    b.internals.addMessage('someone', [{ type: 'text', text }], { serverId: 'discord', channelId: 'discord:g1:general', messageId: `m-${text}` });
  };
  const texts = (b: Bare): string[] => b.framework.getAgent('scout')!.getContextManager().getAllMessages()
    .map((m) => m.content.map((x) => (x.type === 'text' ? x.text : '')).join(''));
  const wake = (lines: unknown[], timestamp = Date.now()) => ({ agentName: 'scout', reason: 'gate:debounce', source: 'gate', timestamp, wakeLines: lines });

  // Every resident gets every batched wake. Only the delivery agent's start
  // places the line, so it lands once, before that agent's own answer.
  it('one wake for two residents, the co-resident first: she writes no line, and the delivery agent\'s start writes it once, after her reply and before its own answer', async () => {
    const b = await bare(['scout', 'mira']);
    try {
      storeDm(b, 'ev-1', 'are you there?');
      const line = dmLine('ev-1', 'LINE-MIRA-FIRST');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push({ ...wake([line]), agentName: 'mira' });
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: mira\'s turn ran');
      assert.equal(texts(b).filter((t) => t.includes('LINE-MIRA-FIRST')).length, 0, 'mira places nothing');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout answers' }]));
      b.internals.pendingRequests.push(wake([line]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 2, 'premise: scout\'s turn ran');
      const all = texts(b);
      const mira = all.findIndex((t) => t.includes('mira answers'));
      const at = all.findIndex((t) => t.includes('LINE-MIRA-FIRST'));
      const scout = all.findIndex((t) => t.includes('scout answers'));
      assert.equal(all.filter((t) => t.includes('LINE-MIRA-FIRST')).length, 1, 'written once');
      assert.ok(mira >= 0 && at > mira && scout > at, `after mira's reply, before scout's answer (mira ${mira}, line ${at}, scout ${scout})`);
    } finally { await done(b); }
  });

  it('one wake for two residents, the delivery agent first: it leaves the line out as newest, and the co-resident\'s later start writes none after its answer', async () => {
    const b = await bare(['scout', 'mira']);
    try {
      storeDm(b, 'ev-1', 'are you there?');
      const line = dmLine('ev-1', 'LINE-SCOUT-FIRST');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'scout answers' }]));
      b.internals.pendingRequests.push(wake([line]));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 1, 'premise: scout\'s turn ran');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'mira answers' }]));
      b.internals.pendingRequests.push({ ...wake([line]), agentName: 'mira' });
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 2, 'premise: mira\'s turn ran');
      assert.ok(texts(b).some((t) => t.includes('scout answers')), 'premise: scout\'s answer is in the slot');
      assert.equal(texts(b).filter((t) => t.includes('LINE-SCOUT-FIRST')).length, 0, 'no wake line after an answered DM');
    } finally { await done(b); }
  });
  it('one wake for two agents: each request carries the gate\'s own line object, which "written once" rests on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-line-identity-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: ['scout', 'mira'].map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
      gate: { config: { policies: [], default: 'skip' } },
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    } as never);
    try {
      const internals = framework as unknown as {
        eventGate: { requestInferenceFn(agentName: string, reason: string, source: string, provenance?: unknown): void };
        pendingRequests: Array<{ agentName: string; wakeLines?: unknown[] }>;
      };
      const line = dmLine('ev-1', 'LINE-ID');
      const provenance = { channelId: 'discord:dm:1', line };
      // As the gate's deliverEvents does: one provenance per batch, to every agent it wakes.
      for (const name of ['scout', 'mira']) internals.eventGate.requestInferenceFn(name, 'gate:debounce', 'gate', provenance);
      const carried = internals.pendingRequests.map((r) => r.wakeLines?.[0]);
      assert.equal(carried.length, 2);
      assert.ok(carried.every((c) => c === line), 'the same object, not a copy per agent');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the delivery agent\'s start while a co-resident\'s turn is alive, or while the host is quiesced: no line written, traced, left for a later start', async () => {
    const b = await bare(['scout', 'mira']);
    try {
      storeDm(b, 'ev-1', 'are you there?');
      storeChatter(b);
      const traces: Array<{ type: string; reason?: string }> = [];
      b.framework.onTrace((event) => { traces.push(event as unknown as { type: string }); });
      const scout = b.framework.getAgent('scout')!;
      storeDm(b, 'ev-2', 'and another');
      // One line whose message is newest, with mira's turn alive: held, not newest.
      b.internals.activeTurnTokens.set('mira', 1);
      try {
        b.internals.placeWakeLines(scout, [dmLine('ev-2', 'LINE-ONE')]);
      } finally {
        b.internals.activeTurnTokens.delete('mira');
      }
      assert.deepEqual(traces.splice(0).filter((t) => t.type === 'gate:wake-line-omitted').map((t) => t.reason), ['held'], 'held takes precedence over newest');
      const lines = [dmLine('ev-1', 'LINE-HELD'), dmLine('ev-2', 'LINE-HELD2')];
      b.internals.activeTurnTokens.set('mira', 1);
      try {
        b.internals.placeWakeLines(scout, lines);
      } finally {
        b.internals.activeTurnTokens.delete('mira');
      }
      assert.equal(texts(b).filter((t) => t.includes('LINE-HELD')).length, 0, 'not written into mira\'s live turn');
      await b.framework.quiesce({ reason: 'test window' });
      b.internals.placeWakeLines(scout, lines);
      assert.equal(texts(b).filter((t) => t.includes('LINE-HELD')).length, 0, 'nor while quiesced');
      const omitted = traces.filter((t) => t.type === 'gate:wake-line-omitted');
      assert.deepEqual(omitted.map((t) => t.reason), ['held', 'held', 'held', 'held'], 'each line traced as held, each time');
      await b.framework.resume();
      b.internals.placeWakeLines(scout, lines);
      assert.equal(texts(b).filter((t) => t.includes('LINE-HELD')).length, 2, 'a later start writes both');
    } finally { await done(b); }
  });

  it('a write deferred while a turn ran lands at the next start before the line is decided, so the line comes after it', async () => {
    const b = await bare(['scout']);
    try {
      storeDm(b, 'ev-1', 'are you there?');
      b.internals.activeTurnTokens.set('scout', 1);
      storeChatter(b);
      b.internals.activeTurnTokens.delete('scout');
      assert.ok(!texts(b).some((t) => t.includes('unrelated chatter')), 'premise: the chatter waits, deferred');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      b.internals.pendingRequests.push(wake([dmLine('ev-1', 'LINE-FLUSH')]));
      await b.framework.runUntilIdle();
      const all = texts(b);
      const chatter = all.findIndex((t) => t.includes('unrelated chatter'));
      const line = all.findIndex((t) => t.includes('LINE-FLUSH'));
      assert.ok(chatter >= 0 && line > chatter, `the flushed chatter, then the line (chatter ${chatter}, line ${line})`);
    } finally { await done(b); }
  });

  for (const order of ['older first', 'newer first'] as const) it(`two wakes parked while the host is quiesced, coalesced into one (${order}): each one's line is decided at resume`, async () => {
    const b = await bare(['scout']);
    try {
      storeDm(b, 'ev-1', 'first DM');
      storeDm(b, 'ev-2', 'second DM');
      storeChatter(b);
      await b.framework.quiesce({ reason: 'test window' });
      const t0 = Date.now();
      const [first, second] = order === 'older first' ? [t0, t0 + 10] : [t0 + 10, t0];
      b.internals.pendingRequests.push(wake([dmLine('ev-1', 'LINE-Q1')], first));
      b.internals.pendingRequests.push(wake([dmLine('ev-2', 'LINE-Q2')], second));
      // One scheduler pass while quiesced parks them, coalesced (runUntilIdle
      // doesn't count parked wakes as work).
      await b.internals.processInferenceRequests();
      assert.equal(b.membrane.calls.length, 0, 'premise: parked while quiesced');
      assert.equal(b.internals.pendingRequests.length, 1, 'premise: coalesced into one');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      await b.framework.resume();
      await settleUntil(b.framework, () => b.membrane.calls.length >= 1, 'the turn at resume');
      const all = texts(b);
      assert.equal(all.filter((t) => t.includes('LINE-Q1')).length, 1);
      assert.equal(all.filter((t) => t.includes('LINE-Q2')).length, 1);
    } finally { await done(b); }
  });

  it('two held wakes alike in everything but their lines: the hold keeps both, and both lines are written at its release', async () => {
    const b = await bare(['scout']);
    try {
      storeDm(b, 'ev-1', 'first DM');
      storeDm(b, 'ev-2', 'second DM');
      storeChatter(b);
      const now = Date.now();
      // Released by hand below, not by its timer.
      const timer = setTimeout(() => {}, 60_000);
      b.internals.providerAccelerationCooldowns.set('scout', { startedAt: now, until: now + 60_000, timer, heldRequests: [], reason: 'test hold', failures: 1 });
      const at = Date.now();
      b.internals.pendingRequests.push(wake([dmLine('ev-1', 'LINE-H1')], at));
      b.internals.pendingRequests.push(wake([dmLine('ev-2', 'LINE-H2')], at));
      await b.framework.runUntilIdle();
      assert.equal(b.membrane.calls.length, 0, 'premise: held');
      const held = b.internals.providerAccelerationCooldowns.get('scout')!.heldRequests as unknown[];
      assert.equal(held.length, 2, 'premise: both wakes are in the hold');
      b.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
      clearTimeout(timer);
      releaseHoldNow(b.framework, 'scout');
      await settleUntil(b.framework, () => b.membrane.calls.length >= 1, 'the hold\'s release');
      const all = texts(b);
      assert.equal(all.filter((t) => t.includes('LINE-H1')).length, 1);
      assert.equal(all.filter((t) => t.includes('LINE-H2')).length, 1);
    } finally { await done(b); }
  });
});

/** The first call fails with a retryable server error, the next succeeds. */
class FailOnceMembrane extends MockMembrane {
  private k = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    if (++this.k === 1) {
      const error = new MembraneError({
        type: 'server', retryable: true, httpStatus: 500,
        message: 'Internal server error', rawError: { status: 500 }, rawRequest: request,
      });
      return {
        isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
        provideToolResults() { throw new Error('not waiting'); },
        cancel() {},
        async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> { yield { type: 'error', error } as StreamEvent; },
      } as unknown as YieldingStream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'hello back' }])]);
  }
}

describe('a same-turn retry', () => {
  // Nigel-2405's probe: the first attempt's own start notices sit after the DM,
  // and nothing else arrives, so the retry has no line to write.
  it('one DM, nothing arriving, the first attempt fails and is retried: no line', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'wake-line-retry-'));
    const commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    const membrane = new FailOnceMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      errorPolicy: { onInferenceError: (_e: Error, _a: string, attempt: number) => attempt === 0 ? { retry: true, delayMs: 20 } : { retry: false } },
      gate: { config: { policies: [{ name: 'addressed', match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'], tagsAny: ['chat:addressed'] }, behavior: { debounce: 100 } }], default: 'skip' } },
      mcplServers: [{ id: 'discord', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath } }],
      modules: [],
    } as never);
    try {
      let completed = false;
      framework.onTrace((event) => { if (event.type === 'inference:completed' && event.agentName === 'scout') completed = true; });
      await framework.start();
      const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
      await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
      appendFileSync(commandPath, `dm ev-r1 134 ${RAW_DM} are you there?\n`);
      await waitFor(() => membrane.calls.length >= 2, 'the failed attempt and its retry');
      await waitFor(() => completed, "the retried turn's completion");
      const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
        .map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text?: string }).text ?? '').join('\n'));
      assert.ok(texts.some((t) => t.includes('are you there?')), 'premise: the DM is in the window');
      assert.deepEqual(texts.filter((t) => t.includes('[Gate:')), [], 'no line: nothing arrived after the DM');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
