/**
 * Receipt clocks end to end over a real MCPL child and a scripted provider:
 * a channel item is received at acceptance, a provider round that fails
 * delivers nothing, and the next round that stands delivers the body — with
 * channel_list reporting each step. Also: history--folds answers from the
 * fold journal the same rounds wrote.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import {
  AgentFramework,
  readInboundSource,
  type EventResponse,
  type Module,
  type ModuleContext,
  type ProcessEvent,
  type ProcessState,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '../src/index.js';
import { HistoryModule } from '../src/modules/history/index.js';
import { copyFacts, versionOf, type ChannelClockLedger } from '../src/context-receipts/index.js';
import { createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * `fail`: the provider call errors. `ok`: one round that stands. `tool`: a
 * round that calls `probe--wait`, then a second round whose report says how
 * much of the injected batch it carried (`carries`: 'all', or 0 as on
 * membrane's XML path).
 */
type Script = 'fail' | 'ok' | { tool: true; carries: 'all' | 0 };

const usage = { inputTokens: 40, outputTokens: 3, cacheReadTokens: 0 };
const roundEvent = (index: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'usage', usage, round: { index, stopReason: 'end_turn', usage, altered: { messages: [], injected: [] }, fidelity: 'established', ...extra } }) as unknown as StreamEvent;
const complete = () =>
  ({ type: 'complete', response: createMockResponse([{ type: 'text', text: 'heard you' }]) }) as unknown as StreamEvent;

class ScriptedStream implements YieldingStream {
  private done = false;
  private waiting = false;
  private wake: (() => void) | null = null;
  injected: number[] = [];
  constructor(private events: StreamEvent[], private readonly afterTools?: (injected: number) => StreamEvent[]) {
    this.waiting = events.some((e) => e.type === 'tool-calls');
  }
  provideToolResults(_results: unknown[], options?: { injectedMessages?: unknown[] }): void {
    const n = options?.injectedMessages?.length ?? 0;
    this.injected.push(n);
    this.waiting = false;
    this.events.push(...(this.afterTools?.(n) ?? [complete()]));
    this.wake?.();
  }
  cancel(): void { this.done = true; this.wake?.(); }
  get isWaitingForTools() { return this.waiting; }
  get pendingToolCallIds() { return this.waiting ? ['call-1'] : []; }
  get toolDepth() { return this.injected.length; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (!this.done) {
      const event = this.events.shift();
      if (event) {
        yield event;
        if (event.type === 'complete' || event.type === 'error') return;
        continue;
      }
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}

class ScriptedMembrane {
  scripts: Script[] = [];
  requests: NormalizedRequest[] = [];
  /** When each request reached the provider. */
  startedAt: number[] = [];
  streams: ScriptedStream[] = [];
  streamYielding(request: NormalizedRequest): YieldingStream {
    this.requests.push(request);
    this.startedAt.push(Date.now());
    const script = this.scripts.shift() ?? 'ok';
    let stream: ScriptedStream;
    if (script === 'fail') {
      stream = new ScriptedStream([{ type: 'error', error: new Error('provider unavailable') } as unknown as StreamEvent]);
    } else if (script === 'ok') {
      stream = new ScriptedStream([roundEvent(0), complete()]);
    } else {
      const toolUse = { type: 'tool_use', id: 'call-1', name: 'probe--wait', input: {} };
      stream = new ScriptedStream(
        [
          roundEvent(0),
          {
            type: 'tool-calls',
            calls: [{ id: 'call-1', name: 'probe--wait', input: {} }],
            context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [toolUse] },
          } as unknown as StreamEvent,
        ],
        (n) => [
          roundEvent(1, n > 0 ? { injectedBatch: { batch: 0, applied: script.carries === 'all' ? n : 0 } } : {}),
          complete(),
        ],
      );
    }
    this.streams.push(stream);
    return stream;
  }
  async complete(): Promise<never> { throw new Error('not used'); }
}

/** A tool that holds the turn open until the test lets it finish. */
class ProbeModule implements Module {
  readonly name = 'probe';
  release: (() => void) | null = null;
  entered = false;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'wait', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.entered = true;
    await new Promise<void>((r) => { this.release = r; });
    return { success: true, data: 'done' };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

describe('receipt clocks through the framework', () => {
  let tempDir: string;
  let commandPath: string;
  let framework: AgentFramework;
  let membrane: ScriptedMembrane;
  let probe: ProbeModule;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'receipt-clocks-'));
    commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    membrane = new ScriptedMembrane();
    probe = new ProbeModule();
    const history = new HistoryModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane as never,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [history, probe],
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      // Addressed items and DMs wake the resident; ambient chatter does not.
      gate: {
        configPath: join(tempDir, 'gate.json'),
        config: {
          policies: [{ name: 'wake', match: { tagsAny: ['chat:addressed', 'chat:dm'] }, behavior: 'always' }],
          default: 'skip',
        },
      },
    });
    history.bind(framework.getAgent('scout')!.getContextManager());
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    // Let the fixture's last traffic land before stopping: an event that
    // arrives after stop() closes the queue rejects with "Queue is closed".
    const internals = framework as unknown as { queue: { isEmpty: boolean } };
    await waitFor(
      () => internals.queue.isEmpty && framework.getAgent('scout')!.state.status === 'idle',
      'quiescent before stop',
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (c: Record<string, unknown>): void => appendFileSync(commandPath, JSON.stringify(c) + '\n');

  async function channelList(): Promise<{ channels: Array<{ id: string; clocks?: Record<string, unknown> }>; receiptClocks: Record<string, unknown> }> {
    const result = await framework.executeToolCall({ id: `t-${Math.random()}`, name: 'channel_list', input: {}, callerAgentName: 'scout' } as never);
    assert.ok(result.success, JSON.stringify(result));
    return result.data as never;
  }
  const ledger = () => (framework as unknown as { clockLedger: ChannelClockLedger }).clockLedger;
  const stored = (pred: (meta: Record<string, unknown>) => boolean) =>
    framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => pred((m.metadata ?? {}) as Record<string, unknown>));
  /** Whether the ledger holds a complete delivery of this stored item's version. */
  const deliveredItem = (meta: (m: Record<string, unknown>) => boolean): boolean => {
    const message = stored(meta)!;
    const source = readInboundSource(message.metadata)!;
    assert.equal(source.kind, 'channel');
    if (source.kind !== 'channel') return false;
    const ver = versionOf(source, [message.content], ledger().storeId, message.id, copyFacts(message));
    return ledger().isDelivered('scout', ver);
  };
  const idle = () => framework.getAgent('scout')!.state.status === 'idle';

  const roomClocks = async () => (await channelList()).channels.find((c) => c.id === ROOM)!.clocks as {
    lastReceivedAt: number | null; received?: { messageId?: string };
    lastDeliveredAt: number | null; delivered?: { messageId?: string; basis: string };
  };

  it('advances received while a failing round delivers nothing, then delivers at the round that stands', async () => {
    membrane.scripts = ['fail', 'ok'];
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-1', mode: 'addressed', text: 'are you there?' });
    await waitFor(() => membrane.requests.length >= 1, 'first provider request');
    await waitFor(() => framework.getAgent('scout')!.state.status === 'idle', 'failed turn settles');

    let clocks = await roomClocks();
    assert.ok(clocks.lastReceivedAt, 'received at acceptance');
    assert.equal(clocks.received?.messageId, 'm-1');
    assert.equal(clocks.lastDeliveredAt, null, 'a failed round delivers nothing');

    command({ op: 'incoming', channelId: ROOM, messageId: 'm-2', mode: 'addressed', text: 'hello?' });
    await waitFor(() => membrane.requests.length >= 2, 'second provider request');
    await waitFor(() => framework.getAgent('scout')!.state.status === 'idle', 'second turn settles');

    clocks = await roomClocks();
    assert.ok(clocks.lastDeliveredAt, 'delivered at the round that stood');
    assert.equal(clocks.delivered?.messageId, 'm-2');
    assert.equal(clocks.delivered?.basis, 'message-digest', 'an ordinary channels/incoming item: platform id plus digest');
    const scope = (await channelList()).receiptClocks as { agent: string; storeId: string; trackingSince: number; degraded: boolean };
    assert.equal(scope.agent, 'scout');
    assert.match(scope.storeId, /^[0-9a-f-]{36}$/);
    assert.ok(scope.trackingSince > 0);
    assert.equal(scope.degraded, false);

    // The same round accepted the compile: history--folds has a baseline.
    const folds = await framework.executeToolCall({ id: 'f1', name: 'history--folds', input: {}, callerAgentName: 'scout' } as never);
    assert.ok(folds.success, JSON.stringify(folds));
    const data = folds.data as { receipts: Array<{ kind: string }>; folding: string };
    assert.equal(data.receipts[0]?.kind, 'baseline');
    assert.match(data.folding, /passthrough|strategy/);
  });

  it('receives an item that wakes nobody without delivering it, until a round carries it', async () => {
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-amb', mode: 'ambient', text: 'just chatting' });
    await waitFor(() => !!stored((m) => m.messageId === 'm-amb'), 'ambient item stored');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(membrane.requests.length, 0, 'the gate did not wake the resident');
    let clocks = await roomClocks();
    assert.equal(clocks.received?.messageId, 'm-amb');
    assert.equal(clocks.lastDeliveredAt, null);

    command({ op: 'incoming', channelId: ROOM, messageId: 'm-addr', mode: 'addressed', text: 'now you' });
    await waitFor(() => membrane.requests.length >= 1, 'woken');
    await waitFor(idle, 'turn settles');
    clocks = await roomClocks();
    assert.equal(clocks.delivered?.messageId, 'm-addr');
    assert.ok(deliveredItem((m) => m.messageId === 'm-amb'), 'the ambient body reached the resident in the same round');
  });

  it('identifies a push/event body by its event id', async () => {
    command({ op: 'dm', eventId: 'ev-dm-1', authorId: '134', authorName: 'antra', rawChannelId: '1548000000000000001', text: 'psst' });
    await waitFor(() => membrane.requests.length >= 1, 'woken by the DM');
    await waitFor(idle, 'turn settles');
    const message = stored((m) => (m.inboundSource as { eventId?: string } | undefined)?.eventId === 'ev-dm-1')!;
    const source = readInboundSource(message.metadata)!;
    assert.ok(source.kind === 'channel' && source.lane === 'push/event');
    const clocks = ledger().clocksFor('scout', [source as never]).values().next().value!;
    assert.equal(clocks.delivered?.basis, 'event');
    assert.ok(clocks.lastReceivedAt);
  });

  it('delivers an item injected mid-turn at the round that carried it, during a long tool-using turn', async () => {
    membrane.scripts = [{ tool: true, carries: 'all' }];
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-start', mode: 'addressed', text: 'do the thing' });
    await waitFor(() => probe.entered, 'tool running');
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-mid', mode: 'addressed', text: 'also this' });
    await waitFor(() => !!(framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length, 'deferred while the turn is alive');
    let clocks = await roomClocks();
    assert.equal(clocks.received?.messageId, 'm-mid', 'received at acceptance, while held');
    assert.equal(clocks.delivered?.messageId, 'm-start');
    probe.release!();
    await waitFor(idle, 'turn settles');
    assert.deepEqual(membrane.streams[0]!.injected, [1]);
    clocks = await roomClocks();
    assert.equal(clocks.delivered?.messageId, 'm-mid', 'delivered by the round that carried the injection');

    // The next turn compiles the stored copy of the same body: the same
    // version (content hashed key-order-independently), so no second delivery.
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-after', mode: 'addressed', text: 'next' });
    await waitFor(() => membrane.requests.length >= 2, 'next turn');
    await waitFor(idle, 'next turn settles');
    const store = framework.getStore();
    const midDeliveries = store.getRecordIdsByType('agent-framework/channel-clocks')
      .map((rid) => JSON.parse(store.getRecord(rid)!.payload.toString('utf8')) as { k: string; src?: { messageId?: string } })
      .filter((e) => e.k === 'dlv' && e.src?.messageId === 'm-mid');
    assert.equal(midDeliveries.length, 1, 'injected and stored copies are one version');
  });

  it('does not count an injection the round did not carry (XML path) until a later compile carries it', async () => {
    membrane.scripts = [{ tool: true, carries: 0 }, 'ok'];
    command({ op: 'incoming', channelId: ROOM, messageId: 'x-start', mode: 'addressed', text: 'do the thing' });
    await waitFor(() => probe.entered, 'tool running');
    command({ op: 'incoming', channelId: ROOM, messageId: 'x-mid', mode: 'addressed', text: 'also this' });
    await waitFor(() => !!(framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length, 'deferred');
    probe.release!();
    await waitFor(idle, 'turn settles');
    assert.deepEqual(membrane.streams[0]!.injected, [1], 'the framework supplied it to the stream');
    // Whether the framework wakes again for it or the next item does, a later
    // request carries it; the round that carried none of it never delivers it.
    command({ op: 'incoming', channelId: ROOM, messageId: 'x-next', mode: 'addressed', text: 'and?' });
    await waitFor(() => deliveredItem((m) => m.messageId === 'x-mid') && idle(), 'a later compile carries it');
    const store = framework.getStore();
    const deliveries = store.getRecordIdsByType('agent-framework/channel-clocks')
      .map((rid) => JSON.parse(store.getRecord(rid)!.payload.toString('utf8')) as { k: string; at: number; src?: { messageId?: string } })
      .filter((e) => e.k === 'dlv' && e.src?.messageId === 'x-mid');
    assert.equal(deliveries.length, 1);
    assert.ok(membrane.startedAt.length >= 2);
    assert.ok(deliveries[0]!.at >= membrane.startedAt[1]!, 'delivered by a later request, not by the round that carried none of it');
  });

  it('keeps no receipt state for a stream whose agent was disposed while its request was prepared', async () => {
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const prepare = agent.startStreamWithInjections.bind(agent);
    let prepared = false;
    agent.startStreamWithInjections = async (...args: Parameters<typeof prepare>) => {
      // Slow enough for the idle watchdog to dispose the agent meanwhile.
      await new Promise((r) => setTimeout(r, 300));
      const result = await prepare(...args);
      prepared = true;
      return result;
    };
    await assert.rejects(
      framework.runEphemeralToCompletion(agent, contextManager, { idleTimeoutMs: 50, idlePollMs: 10 }),
      /stalled/,
    );
    await waitFor(() => prepared, 'the request prepared after disposal');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(membrane.requests.length, 1, 'a stream was started, then abandoned');
    const receipts = (framework as unknown as { contextReceipts: { streams: Map<string, unknown> } }).contextReceipts;
    assert.equal(receipts.streams.size, 0);
  });
});
