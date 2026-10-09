/**
 * Receipt identity and fidelity through the ingestion stamps (6c927de:
 * sourceBodyDigest, storedBodyDigest), end to end: a real MCPL child, the
 * framework's ingestion, a context-manager strategy that can shard a body at
 * ingestion or render one cut short, and the real membrane with only the
 * provider scripted. Agreed in room-220 #46752–#48150:
 *  - one source-body version through sharding and injection;
 *  - a copy rendered short is never a delivery;
 *  - a shard group an interrupted write left short is never a delivery;
 *  - a body stored before stamping is never confirmed, nor shown lost;
 *  - a stamped copy edited after ingestion is a partial exposure, never a
 *    delivery of the original.
 * The header composition (a rename between two acceptances; a copy rendered
 * as its source header alone) is covered with shelf-356 in
 * combined/receipts-356.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Membrane,
  NativeFormatter,
  type ContentBlock,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type StreamCallbacks,
} from '@animalabs/membrane';
import { PassthroughStrategy } from '@animalabs/context-manager';
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
import { copyFacts, versionOf, type ChannelClockLedger } from '../src/context-receipts/index.js';

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

const textOf = (blocks: readonly ContentBlock[]) =>
  blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

/**
 * Passthrough, except: a body mentioning SHARD-ME is stored as one shard per
 * block (lossless), and a body mentioning CUT-ME is rendered as its first
 * block alone. A sharded body mentioning SAME-CONTENT takes one fixed group
 * id, as the real chunker's content hash gives every copy of one text.
 */
class FixtureStrategy extends PassthroughStrategy {
  chunkIngressMessage(_participant: string, content: ContentBlock[]): { bodyGroupId: string; shards: Array<{ content: ContentBlock[]; shardIndex: number }> } | null {
    const text = textOf(content);
    if (!text.includes('SHARD-ME')) return null;
    const bodyGroupId = text.includes('SAME-CONTENT') ? 'group-same-content' : `group-${Math.random().toString(36).slice(2)}`;
    return { bodyGroupId, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) };
  }
  override select(...args: Parameters<PassthroughStrategy['select']>): ReturnType<PassthroughStrategy['select']> {
    return super.select(...args).map((entry) =>
      textOf(entry.content).includes('CUT-ME') ? { ...entry, content: entry.content.slice(0, 1) } : entry,
    );
  }
}

type Turn = 'text' | 'tool';

class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  readonly reportsContentAlterations = true;
  readonly usageCacheConvention = 'cache-excluded' as const;
  turns: Turn[] = [];
  requests: ProviderRequest[] = [];
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    this.requests.push(request);
    const usage = { inputTokens: 40, outputTokens: 3 };
    if ((this.turns.shift() ?? 'text') === 'tool') {
      return {
        content: [{ type: 'tool_use', id: `call-${this.requests.length}`, name: 'probe--wait', input: {} }],
        stopReason: 'tool_use', usage, model: request.model, rawRequest: request, raw: {},
      };
    }
    callbacks.onChunk('heard you');
    return { content: [{ type: 'text', text: 'heard you' }], stopReason: 'end_turn', usage, model: request.model, rawRequest: request, raw: {} };
  }
}

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

interface Harness {
  framework: AgentFramework;
  adapter: ScriptedAdapter;
  probe: ProbeModule;
  command: (c: Record<string, unknown>) => void;
  tempDir: string;
}

let harness: Harness | null = null;

async function open(): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'receipts-source-body-'));
  const commandPath = join(tempDir, 'commands.jsonl');
  writeFileSync(commandPath, '');
  const adapter = new ScriptedAdapter();
  const probe = new ProbeModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', strategy: new FixtureStrategy() }],
    mcplServers: [{
      id: 'discord',
      command: process.execPath,
      args: [FIXTURE],
      env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
    }],
    modules: [probe],
    errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    gate: {
      configPath: join(tempDir, 'gate.json'),
      config: { policies: [{ name: 'wake', match: { tagsAny: ['chat:addressed', 'chat:dm'] }, behavior: 'always' }], default: 'skip' },
    },
  });
  await framework.start();
  const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
  await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  harness = { framework, adapter, probe, command: (c) => appendFileSync(commandPath, JSON.stringify(c) + '\n'), tempDir };
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
  const cm = () => h.framework.getAgent('scout')!.getContextManager();
  const ledger = () => (h.framework as unknown as { clockLedger: ChannelClockLedger }).clockLedger;
  const idle = () => h.framework.getAgent('scout')!.state.status === 'idle';
  const copies = (messageId: string) =>
    cm().getAllMessages().filter((m) => (m.metadata as { messageId?: string } | undefined)?.messageId === messageId && m.shardIndex !== undefined ? m.shardIndex === 0 : (m.metadata as { messageId?: string } | undefined)?.messageId === messageId);
  const entries = (k: 'dlv' | 'part', messageId: string) => {
    const store = h.framework.getStore();
    return store.getRecordIdsByType('agent-framework/channel-clocks')
      .map((rid) => JSON.parse(store.getRecord(rid)!.payload.toString('utf8')) as { k: string; src?: { messageId?: string }; ver?: { key: string; basis: string }; why?: string[] })
      .filter((e) => e.k === k && e.src?.messageId === messageId);
  };
  const versionOfCopy = (head: ReturnType<typeof copies>[number]) => {
    const source = readInboundSource(head.metadata)!;
    assert.ok(source.kind === 'channel');
    const members = head.bodyGroupId
      ? cm().getAllMessages().filter((m) => m.bodyGroupId === head.bodyGroupId).sort((a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0))
      : [head];
    return versionOf(source as never, members.map((m) => m.content), ledger().storeId, head.id, copyFacts(head));
  };
  return { cm, idle, copies, entries, versionOfCopy };
}

describe('receipts through the ingestion stamps', () => {
  it('a body injected whole and later compiled as lossless shards is one version: one delivery', async () => {
    const h = await open();
    const p = probes(h);
    h.adapter.turns = ['tool', 'text'];
    h.command({ op: 'incoming', channelId: ROOM, messageId: 's-start', mode: 'addressed', text: 'do the thing' });
    await waitFor(() => h.probe.entered, 'tool running');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 's-mid', mode: 'addressed', content: [{ type: 'text', text: 'SHARD-ME first part' }, { type: 'text', text: 'second part' }] });
    await waitFor(() => !!(h.framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length, 'deferred while the turn is alive');
    h.probe.release!();
    await waitFor(() => p.entries('dlv', 's-mid').length === 1 && p.idle(), 'delivered whole by injection');
    const head = p.copies('s-mid')[0]!;
    assert.ok(head.bodyGroupId, 'stored as shards');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 's-next', mode: 'addressed', text: 'next' });
    await waitFor(() => p.entries('dlv', 's-next').length === 1 && p.idle(), 'the next compile, carrying the shards');
    assert.equal(p.entries('dlv', 's-mid').length, 1, 'the sharded compile is the same version');
    assert.equal(p.entries('part', 's-mid').length, 0);
  });

  it('end to end through CM\'s body identity: the same text posted twice, under one group id, is two whole deliveries', async () => {
    // What makes the repost its own delivery is context-manager judging each
    // ingestion as its own body (a group id names content, not an ingestion).
    // With one body per group id, the repost's shards join the first copy's
    // body, whose head is the first copy's, and the repost is never
    // delivered on its own.
    const h = await open();
    const p = probes(h);
    const content = [{ type: 'text', text: 'SHARD-ME SAME-CONTENT first part' }, { type: 'text', text: 'second part' }];
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'twice-1', mode: 'addressed', content });
    await waitFor(() => p.entries('dlv', 'twice-1').length === 1 && p.idle(), 'the first copy delivered');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'twice-2', mode: 'addressed', content });
    await waitFor(() => p.entries('dlv', 'twice-2').length === 1 && p.idle(), 'the repost delivered on its own');
    const [first] = p.copies('twice-1');
    const [second] = p.copies('twice-2');
    assert.ok(first!.bodyGroupId && first!.bodyGroupId === second!.bodyGroupId, 'one group id names both copies');
    assert.equal(p.entries('part', 'twice-2').length, 0, 'the repost was carried whole, not short of shards');
    assert.equal(p.entries('dlv', 'twice-1').length, 1, 'and the first copy is still one delivery');
  });

  it('a copy rendered short is never a delivery', async () => {
    const h = await open();
    const p = probes(h);
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'c-1', mode: 'addressed', content: [{ type: 'text', text: 'CUT-ME first' }, { type: 'text', text: 'the rest of it' }] });
    await waitFor(() => h.adapter.requests.length >= 1 && p.idle(), 'compiled');
    assert.ok(!JSON.stringify(h.adapter.requests[0]!.messages).includes('the rest of it'), 'only the first block was rendered');
    assert.equal(p.entries('dlv', 'c-1').length, 0);
    assert.deepEqual(p.entries('part', 'c-1').map((e) => e.why), [['content']]);
  });

  it('a shard group an interrupted write left short is never a delivery (Hugo #47804)', async () => {
    const h = await open();
    const p = probes(h);
    const store = (p.cm() as unknown as { messageStore: { append: (...args: unknown[]) => { id: string } } }).messageStore;
    const append = store.append.bind(store);
    let shardsWritten = 0;
    store.append = (...args: unknown[]) => {
      const extra = args[4] as { bodyGroupId?: string } | undefined;
      if (extra?.bodyGroupId && ++shardsWritten === 2) throw new Error('injected failure before the second shard');
      return append(...args);
    };
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'i-1', mode: 'ambient', content: [{ type: 'text', text: 'SHARD-ME first half' }, { type: 'text', text: 'second half' }] });
    await waitFor(() => p.copies('i-1').length === 1, 'the first shard was stored');
    store.append = append;
    const head = p.copies('i-1')[0]!;
    assert.ok(head.bodyGroupId);
    const written = p.cm().getAllMessages().filter((m) => m.bodyGroupId === head.bodyGroupId);
    assert.equal(written.length, 1);
    assert.ok((head.shardCount ?? 0) > written.length, 'the stored shard declares more of the group than was written');
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'i-trigger', mode: 'addressed', text: 'look' });
    await waitFor(() => p.entries('dlv', 'i-trigger').length === 1 && p.idle(), 'the next compile');
    assert.ok(!JSON.stringify(h.adapter.requests.at(-1)!.messages).includes('second half'), 'the second shard was never stored');
    assert.equal(p.entries('dlv', 'i-1').length, 0, 'the body was never whole');
    assert.deepEqual(p.entries('part', 'i-1').map((e) => e.why), [['shards']]);
  });

  it('a copy stored with the closed-channel invitation, untouched, is intact and delivered (Tessa #48282)', async () => {
    const h = await open();
    const p = probes(h);
    // Accepted while its channel is open, then held until the channel closes,
    // so storage appends the invitation after ingestion stamped the body.
    const registry = (h.framework as unknown as {
      channelRegistry: { handleChannelToolCall(name: string, input: unknown, caller: unknown): Promise<unknown>; isChannelOpen(id: string): boolean };
    }).channelRegistry;
    const fw = h.framework as unknown as { pushEvent(e: { type: string }): void };
    const held: Array<{ type: string }> = [];
    const push = fw.pushEvent.bind(h.framework);
    fw.pushEvent = (e) => { if (e.type === 'mcpl:channel-incoming') held.push(e); else push(e); };
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'q-1', mode: 'addressed', text: 'said while open' });
    await waitFor(() => held.length > 0, 'accepted and held');
    await registry.handleChannelToolCall('channel_close', { channelId: ROOM }, { kind: 'agent', agentName: 'scout' });
    assert.equal(registry.isChannelOpen(ROOM), false);
    fw.pushEvent = push;
    for (const e of held) push(e);
    await waitFor(() => p.copies('q-1').length === 1, 'stored');
    const stored = p.copies('q-1')[0]!;
    assert.equal((stored.metadata as { channelInvitation?: boolean }).channelInvitation, true, 'stored with the invitation');
    await waitFor(() => p.idle(), 'settled');
    h.command({ op: 'incoming', channelId: 'discord:g1:general', messageId: 'q-trigger', mode: 'addressed', text: 'over here' });
    await waitFor(() => p.entries('dlv', 'q-trigger').length === 1 && p.idle(), 'a compile carrying it');
    assert.ok(h.adapter.requests.some((r) => JSON.stringify(r.messages).includes('said while open')), 'it was carried');
    assert.equal(p.entries('dlv', 'q-1').length, 1, 'its own witness matches, so it can confirm');
    assert.equal(p.entries('part', 'q-1').length, 0, 'never read as edited');
  });

  it('a body stored before stamping is never confirmed, nor shown lost (legacy control)', async () => {
    const h = await open();
    const p = probes(h);
    // A first item gives a real frozen envelope to copy for the legacy record.
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'l-real', mode: 'addressed', text: 'a real item' });
    await waitFor(() => p.entries('dlv', 'l-real').length === 1 && p.idle(), 'first delivery');
    const real = p.copies('l-real')[0]!;
    const envelope = { ...readInboundSource(real.metadata)!, messageId: 'l-old' };
    p.cm().addMessage('someone', [{ type: 'text', text: 'stored before stamps existed' }], { inboundSource: envelope, messageId: 'l-old' } as never);
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'l-trigger', mode: 'addressed', text: 'and now' });
    await waitFor(() => p.entries('dlv', 'l-trigger').length === 1 && p.idle(), 'the next compile');
    assert.ok(JSON.stringify(h.adapter.requests.at(-1)!.messages).includes('stored before stamps existed'), 'it was carried');
    assert.equal(p.entries('dlv', 'l-old').length, 0, 'unconfirmed');
    assert.equal(p.entries('part', 'l-old').length, 0, 'and no loss claimed');
  });

  it('a stamped copy edited after ingestion is a partial exposure, never a delivery of the original (edit control)', async () => {
    const h = await open();
    const p = probes(h);
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'e-1', mode: 'ambient', text: 'ORIGINAL words' });
    await waitFor(() => p.copies('e-1').length === 1, 'stored without waking anyone');
    const stored = p.copies('e-1')[0]!;
    p.cm().editMessage(stored.id, [{ type: 'text', text: 'EDITED words' }]);
    h.command({ op: 'incoming', channelId: ROOM, messageId: 'e-trigger', mode: 'addressed', text: 'look' });
    await waitFor(() => p.entries('dlv', 'e-trigger').length === 1 && p.idle(), 'the next compile');
    const wire = JSON.stringify(h.adapter.requests.at(-1)!.messages);
    assert.ok(wire.includes('EDITED words') && !wire.includes('ORIGINAL words'));
    assert.equal(p.entries('dlv', 'e-1').length, 0, 'the original body was never shown');
    assert.deepEqual(p.entries('part', 'e-1').map((e) => e.why), [['edited']]);
  });
});
