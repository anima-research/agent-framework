/**
 * Receipt clocks and fold receipts fed by the real membrane producer.
 *
 * context-receipts-framework.test.ts drives the framework with synthetic
 * round reports. Here the installed @animalabs/membrane builds every request
 * and emits its own `UsageEvent.round`; only the provider adapter is
 * scripted (it declares `reportsContentAlterations`, as the shipped
 * Anthropic adapter does). That checks the package boundary: the report's
 * coordinates, fidelity and injected-batch counts as membrane produces them
 * are what the framework's receipts consume.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnthropicAdapter,
  Membrane,
  NativeFormatter,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderRequestOptions,
  type ProviderResponse,
  type StreamCallbacks,
} from '@animalabs/membrane';
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

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** `text`: one round that ends the turn. `tool`: a round that calls probe--wait. */
type Turn = 'text' | 'tool';

/** A provider that plays turns in the shape of the configured tool mode. */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  readonly reportsContentAlterations = true;
  readonly usageCacheConvention = 'cache-excluded' as const;
  turns: Turn[] = [];
  requests: ProviderRequest[] = [];
  constructor(private readonly mode: 'native' | 'xml') {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.requests.push(request);
    const turn = this.turns.shift() ?? 'text';
    const usage = { inputTokens: 40, outputTokens: 3, cacheReadTokens: 0 };
    if (turn === 'tool' && this.mode === 'native') {
      callbacks.onChunk('checking');
      return {
        content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: `call-${this.requests.length}`, name: 'probe--wait', input: {} }],
        stopReason: 'tool_use', usage, model: request.model, rawRequest: request, raw: {},
      };
    }
    const text = turn === 'tool'
      ? 'checking\n<function_calls><invoke name="probe--wait"></invoke></function_calls>'
      : 'heard you';
    callbacks.onChunk(text);
    return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: request.model, rawRequest: request, raw: {} };
  }
}

/**
 * The real Anthropic request builder and cleanup; only the network response
 * is scripted. It shows what the shipped adapter reports.
 */
class ScriptedAnthropic extends AnthropicAdapter {
  turns: Turn[] = [];
  requests: ProviderRequest[] = [];
  sent: Array<{ messages: unknown[] }> = [];
  constructor() { super({ apiKey: 'test', cacheKeepalive: { enabled: false } }); }
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.requests.push(request);
    const wire = (this as unknown as { buildRequest(r: ProviderRequest, cb?: (b?: unknown) => void): { messages: unknown[] } })
      .buildRequest(request, options?.onContentAltered);
    this.sent.push(JSON.parse(JSON.stringify(wire)));
    options?.onRequest?.(wire);
    const turn = this.turns.shift() ?? 'text';
    const usage = { inputTokens: 40, outputTokens: 3 };
    if (turn === 'tool') {
      return {
        content: [{ type: 'tool_use', id: `call-${this.requests.length}`, name: 'probe--wait', input: {} }],
        stopReason: 'tool_use', usage, model: request.model, rawRequest: wire, raw: {},
      };
    }
    callbacks.onChunk('heard you');
    return { content: [{ type: 'text', text: 'heard you' }], stopReason: 'end_turn', usage, model: request.model, rawRequest: wire, raw: {} };
  }
}

/** A tool that holds the turn open until the test lets it finish. */
class ProbeModule implements Module {
  readonly name = 'probe';
  release: (() => void) | null = null;
  entered = false;
  /** Calls so far; the latest one is held until `release`. */
  calls = 0;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'wait', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.entered = true;
    this.calls++;
    await new Promise<void>((r) => { this.release = r; });
    return { success: true, data: 'done' };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

interface Harness {
  framework: AgentFramework;
  adapter: ScriptedAdapter | ScriptedAnthropic;
  probe: ProbeModule;
  command: (c: Record<string, unknown>) => void;
  tempDir: string;
}

let harness: Harness | null = null;

async function open(mode: 'native' | 'xml' | 'anthropic'): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'receipts-membrane-'));
  const commandPath = join(tempDir, 'commands.jsonl');
  writeFileSync(commandPath, '');
  const adapter = mode === 'anthropic' ? new ScriptedAnthropic() : new ScriptedAdapter(mode);
  const membrane = mode === 'xml' ? new Membrane(adapter) : new Membrane(adapter, { formatter: new NativeFormatter() });
  const probe = new ProbeModule();
  const history = new HistoryModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane,
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    mcplServers: [{
      id: 'discord',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [history, probe],
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    gate: {
      configPath: join(tempDir, 'gate.json'),
      config: { policies: [{ name: 'wake', match: { tagsAny: ['chat:addressed', 'chat:dm'] }, behavior: 'always' }], default: 'skip' },
    },
  });
  history.bind(framework.getAgent('scout')!.getContextManager());
  await framework.start();
  const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
  await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  harness = {
    framework,
    adapter,
    probe,
    command: (c) => appendFileSync(commandPath, JSON.stringify(c) + '\n'),
    tempDir,
  };
  return harness;
}

afterEach(async () => {
  if (!harness) return;
  const { framework, tempDir } = harness;
  harness = null;
  const internals = framework as unknown as { queue: { isEmpty: boolean } };
  await waitFor(() => internals.queue.isEmpty && framework.getAgent('scout')!.state.status === 'idle', 'quiescent before stop').catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  await framework.stop();
  rmSync(tempDir, { recursive: true, force: true });
});

function probes(h: Harness) {
  const { framework } = h;
  const ledger = () => (framework as unknown as { clockLedger: ChannelClockLedger }).clockLedger;
  const idle = () => framework.getAgent('scout')!.state.status === 'idle';
  const stored = (messageId: string) =>
    framework.getAgent('scout')!.getContextManager().getAllMessages().find((m) => (m.metadata as { messageId?: string } | undefined)?.messageId === messageId);
  const versionState = (messageId: string): { delivered: boolean } => {
    const message = stored(messageId)!;
    const source = readInboundSource(message.metadata)!;
    assert.equal(source.kind, 'channel');
    if (source.kind !== 'channel') throw new Error('not a channel body');
    const ver = versionOf(source, [message.content], ledger().storeId, message.id, copyFacts(message));
    return { delivered: ledger().isDelivered('scout', ver) };
  };
  const roomClocks = async () => {
    const result = await framework.executeToolCall({ id: `t-${Math.random()}`, name: 'channel_list', input: {}, callerAgentName: 'scout' } as never);
    assert.ok(result.success, JSON.stringify(result));
    const data = result.data as { channels: Array<{ id: string; clocks: Record<string, unknown> }> };
    return data.channels.find((c) => c.id === ROOM)!.clocks as {
      lastDeliveredAt: number | null; delivered?: { messageId?: string };
      lastPartialAt: number | null; partial?: { messageId?: string; missing: string[] };
    };
  };
  const folds = async () => {
    const result = await framework.executeToolCall({ id: `f-${Math.random()}`, name: 'history--folds', input: {}, callerAgentName: 'scout' } as never);
    assert.ok(result.success, JSON.stringify(result));
    return (result.data as { receipts: Array<{ kind: string; presentation?: string }> }).receipts;
  };
  return { idle, versionState, roomClocks, folds, stored };
}

describe('receipts from the real membrane producer', () => {
  it('native: a verbatim round delivers the body and accepts the compile as verbatim', async () => {
    const h = await open('native');
    const p = probes(h);
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'n-1', mode: 'addressed', text: 'are you there?' });
    await waitFor(() => h.adapter.requests.length >= 1, 'provider request');
    await waitFor(p.idle, 'turn settles');
    const clocks = await p.roomClocks();
    assert.equal(clocks.delivered?.messageId, 'n-1');
    assert.equal(clocks.lastPartialAt, null);
    const receipts = await p.folds();
    assert.equal(receipts[0]?.kind, 'baseline');
    assert.equal(receipts[0]?.presentation, 'verbatim');
    const fw = h.framework as unknown as { contextReceipts: { roundReportsMissing: boolean } };
    assert.equal(fw.contextReceipts.roundReportsMissing, false, 'membrane emitted round reports');
  });

  it('native: membrane\'s placeholder for an unsupported image makes the body a partial exposure', async () => {
    const h = await open('native');
    const p = probes(h);
    h.command({
      op: 'incoming', channelId: ROOM, messageId: 'n-img', mode: 'addressed',
      content: [{ type: 'text', text: 'look at this' }, { type: 'image', data: SVG, mimeType: 'image/svg+xml' }],
    });
    await waitFor(() => h.adapter.requests.length >= 1, 'provider request');
    await waitFor(p.idle, 'turn settles');
    const clocks = await p.roomClocks();
    assert.equal(clocks.lastDeliveredAt, null, 'not delivered: membrane did not carry it verbatim');
    assert.equal(clocks.partial?.messageId, 'n-img');
    assert.ok(clocks.partial?.missing.includes('wire-alteration'));
    const receipts = await p.folds();
    assert.equal(receipts[0]?.presentation, 'altered');
  });

  it('native: an item injected mid-turn is delivered by the round membrane reports carrying it', async () => {
    const h = await open('native');
    const p = probes(h);
    h.adapter.turns = ['tool', 'text'];
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'n-start', mode: 'addressed', text: 'do the thing' });
    await waitFor(() => h.probe.entered, 'tool running');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'n-mid', mode: 'addressed', text: 'also this' });
    await waitFor(() => !!(h.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length, 'deferred while the turn is alive');
    h.probe.release!();
    await waitFor(p.idle, 'turn settles');
    assert.equal(h.adapter.requests.length, 2);
    const second = JSON.stringify(h.adapter.requests[1]!.messages);
    assert.ok(second.includes('also this'), 'membrane carried the injection in the second round');
    const clocks = await p.roomClocks();
    assert.equal(clocks.delivered?.messageId, 'n-mid');
  });

  it('native: a second injected batch, after a tool boundary that injected nothing, is confirmed in its own coordinates', async () => {
    const h = await open('native');
    const p = probes(h);
    const held = () => (h.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length;
    const running = (call: number) => waitFor(() => h.probe.calls >= call, `tool call ${call} running`);
    h.adapter.turns = ['tool', 'tool', 'tool', 'text'];
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'b-start', mode: 'addressed', text: 'do the thing' });
    await running(1);
    // Batch 0, at the first boundary: one body.
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'b0', mode: 'addressed', text: 'first aside' });
    await waitFor(() => held() === 1, 'held for the first boundary');
    h.probe.release!();
    // The second boundary injects nothing.
    await running(2);
    h.probe.release!();
    // Batch 1, at the third boundary: a text body, then one membrane can't carry verbatim.
    await running(3);
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'b1-text', mode: 'addressed', text: 'second aside' });
    await waitFor(() => held() === 1, 'batch 1, first message held');
    h.command({
      op: 'incoming', channelId: ROOM, messageId: 'b1-img', mode: 'addressed',
      content: [{ type: 'text', text: 'and this' }, { type: 'image', data: SVG, mimeType: 'image/svg+xml' }],
    });
    await waitFor(() => held() === 2, 'batch 1, both messages held');
    h.probe.release!();
    await waitFor(p.idle, 'turn settles');

    assert.equal(h.adapter.requests.length, 4);
    assert.ok(JSON.stringify(h.adapter.requests[1]!.messages).includes('first aside'), 'the second round carried batch 0');
    assert.ok(!JSON.stringify(h.adapter.requests[2]!.messages).includes('second aside'), 'the third round carried no new injection');
    const fourth = JSON.stringify(h.adapter.requests[3]!.messages);
    assert.ok(fourth.includes('second aside') && fourth.includes('and this'), 'the fourth round carried batch 1');
    assert.equal(p.versionState('b0').delivered, true, 'batch 0, position 0');
    assert.equal(p.versionState('b1-text').delivered, true, 'batch 1, position 0');
    assert.equal(p.versionState('b1-img').delivered, false, 'batch 1, position 1: altered on the way');
    const clocks = await p.roomClocks();
    assert.equal(clocks.partial?.messageId, 'b1-img');
    assert.deepEqual(clocks.partial?.missing, ['wire-alteration']);
  });

  it('xml: an injection the prefill path cannot carry is not delivered until a later compile carries it', async () => {
    const h = await open('xml');
    const p = probes(h);
    h.adapter.turns = ['tool', 'text', 'text'];
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'x-start', mode: 'addressed', text: 'do the thing' });
    await waitFor(() => h.probe.entered, 'tool running');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'x-mid', mode: 'addressed', text: 'also this' });
    await waitFor(() => !!(h.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length, 'deferred while the turn is alive');
    h.probe.release!();
    await waitFor(p.idle, 'turn settles');
    assert.equal(p.versionState('x-mid').delivered, false, 'membrane reported applied 0');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'x-next', mode: 'addressed', text: 'and?' });
    await waitFor(() => h.adapter.requests.length >= 3, 'next turn');
    await waitFor(p.idle, 'next turn settles');
    assert.equal(p.versionState('x-mid').delivered, true, 'the next compile carried it');
  });

  it('the real Anthropic cleanup: an injected body losing a whitespace block is partial, as preparation would make a compiled one', async () => {
    const h = await open('anthropic');
    const p = probes(h);
    h.adapter.turns = ['tool', 'text'];
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'a-start', mode: 'addressed', text: 'do the thing' });
    await waitFor(() => h.probe.entered, 'tool running');
    h.command({
      op: 'incoming', channelId: ROOM, messageId: 'a-mid', mode: 'addressed',
      content: [{ type: 'text', text: 'also this' }, { type: 'text', text: '   ' }],
    });
    await waitFor(() => !!(h.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length, 'deferred while the turn is alive');
    h.probe.release!();
    await waitFor(p.idle, 'turn settles');
    const sent = (h.adapter as ScriptedAnthropic).sent;
    assert.equal(sent.length, 2);
    assert.ok(JSON.stringify(sent[1]!.messages).includes('also this'), 'the injection was carried');
    assert.ok(!JSON.stringify(sent[1]!.messages).includes('"   "'), 'its whitespace block was cleaned away');
    const clocks = await p.roomClocks();
    assert.equal(clocks.partial?.messageId, 'a-mid');
    assert.deepEqual(clocks.partial?.missing, ['wire-alteration']);
    assert.notEqual(clocks.delivered?.messageId, 'a-mid');
  });
});
