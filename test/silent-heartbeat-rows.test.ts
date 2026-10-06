/**
 * Stored-row hazards of silent heartbeat ticks (#216 follow-up).
 *
 * A silent tick stores no prompt row, so its reply lands directly after the
 * previous assistant message. The wire formatter merges consecutive
 * same-role messages, which made the tick read as an unprompted continuation
 * of the earlier turn and put signed thinking from two separate responses
 * into one assistant message (the shape the provider rejects with a 400 when
 * it is the latest assistant message). These tests pin that the tick's rows
 * are identifiable, and that the built request keeps them apart through a
 * request-only separator — never a stored row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';

class ToolModule implements Module {
  readonly name = 'tools';
  calls: ToolCall[] = [];
  private ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext) { this.ctx = ctx; ctx.registerSpeechHandler('*'); }
  async stop() { this.ctx?.unregisterSpeechHandler(); this.ctx = null; }
  async onProcess() { return {}; }
  async onAgentSpeech() {}
  getTools(): ToolDefinition[] { return [{ name: 'ping', description: 'explicit action', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(call: ToolCall): Promise<ToolResult> { this.calls.push(call); return { success: true, data: { ok: true } }; }
}

let seq = 0;
function silentEvent() {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'heartbeat', featureSet: 'heartbeat',
    eventId: `hb-${n}`, content: [], timestamp: new Date().toISOString(),
    origin: { source: 'heartbeat', reason: 'schedule', silent: true, scheduledAt: '2026-10-02 12:00:00 PT' },
    inferenceId: `inf-hb-${n}`, triggerInference: true,
  };
}

function ordinaryEvent(text: string) {
  const n = ++seq;
  return {
    type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes',
    eventId: `ev-${n}`, content: [{ type: 'text', text }], timestamp: new Date().toISOString(),
    inferenceId: `inf-ev-${n}`, triggerInference: true,
  };
}

/** A signed response: the signature is what the provider checks. */
function signed(signature: string, text: string, extra: ContentBlock[] = []): ContentBlock[] {
  return [
    { type: 'thinking', thinking: `reasoning for ${text}`, signature } as ContentBlock,
    { type: 'text', text } as ContentBlock,
    ...extra,
  ];
}

/** One explicit response queue per stream, so a restart opens a fresh one. */
class QueuedStreamsMembrane extends MockMembrane {
  queues: NormalizedResponse[][] = [];
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.queues.shift() ?? []);
    this.lastStream = stream;
    return stream;
  }
}

async function make(opts: { deliver?: boolean; membrane?: MockMembrane; physicalWindowTokens?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'silent-hb-rows-'));
  const membrane = opts.membrane ?? new MockMembrane();
  const mod = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{
      name: 'assistant', model: 'test', systemPrompt: 'test', proseRouting: 'locus', maxTokens: 4_000,
      ...(opts.physicalWindowTokens ? { physicalWindowTokens: opts.physicalWindowTokens } : {}),
    }],
    modules: [mod],
  });
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => 'world:commons', getDefaultPublishChannel: () => 'world:commons',
    routeSpeech: async () => ({ delivered: opts.deliver ?? true, channelId: 'world:commons' }),
    startTyping: () => {}, stopTyping: () => {},
    getChannelTools: () => [], getDescriptor: () => undefined,
  }, { get: (t, p: string) => p in t ? (t as any)[p] : () => undefined });
  return { dir, membrane, mod, framework };
}

/** MockMembrane hands every queued response to the next stream, so queue
 * exactly one wake's responses (all its tool rounds) before each wake. */
async function wake(x: { membrane: MockMembrane; framework: AgentFramework }, event: unknown, ...responses: ContentBlock[][]) {
  for (const content of responses) {
    x.membrane.pushResponse(createMockResponse(content, content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'));
  }
  (x.framework as any).handleMcplPushEvent(event);
  await x.framework.runUntilIdle();
}

/** The provider-shaped messages membrane would put on the wire. */
function wire(request: NormalizedRequest) {
  return new NativeFormatter().buildMessages(request.messages, {
    participantMode: 'multiuser', assistantParticipant: 'assistant',
  }).messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

function signatures(message: { content: Array<Record<string, unknown>> }): string[] {
  return message.content.filter((b) => b.type === 'thinking').map((b) => String(b.signature));
}

const TICK_TOOL_ROUND = signed('sig-tick', 'checking', [
  { type: 'tool_use', id: 'tick-t1', name: 'tools--ping', input: {} } as ContentBlock,
]);
const TICK_TRAILING = [{ type: 'text', text: 'all quiet' }] as ContentBlock[];

function textOf(message: NormalizedMessage): string {
  return message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
}

function stored(framework: AgentFramework) {
  return framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
    participant: string; content: ContentBlock[]; metadata?: Record<string, any>;
  }>;
}

describe('silent heartbeat stored rows', () => {
  it('keeps a tick reply out of the previous assistant message on the wire', async () => {
    const x = await make();
    try {
      // An ordinary turn's delivered prose is followed by its [delivered]
      // receipt row; a silent tick delivers nothing, so it leaves none. The
      // next tick's reply is stored directly after the previous one.
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      await wake(x, silentEvent(), signed('sig-tick-1', 'first tick note'));
      await wake(x, silentEvent(), signed('sig-tick-2', 'second tick note'));
      await wake(x, silentEvent(), signed('sig-tick-3', 'third tick note'));
      assert.equal(x.membrane.calls.length, 4);

      const provider = wire(x.membrane.calls[3]!);
      for (const message of provider.filter((m) => m.role === 'assistant')) {
        assert.ok(
          signatures(message).length <= 1,
          `one assistant message carries signed thinking from ${signatures(message).length} ` +
          `separate responses: ${signatures(message).join(', ')}`,
        );
      }
      const lastAssistant = [...provider].reverse().find((m) => m.role === 'assistant')!;
      assert.deepEqual(signatures(lastAssistant), ['sig-tick-2'],
        'the latest assistant message is exactly the second tick reply, unmodified');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('keeps a tick apart from an ordinary reply that left no receipt', async () => {
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      await wake(x, silentEvent(), signed('sig-tick', 'tick note'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      const provider = wire(x.membrane.calls[2]!);
      for (const message of provider) {
        assert.ok(signatures(message).length <= 1,
          `one ${message.role} message carries signed thinking from: ${signatures(message).join(', ')}`);
      }
      const later = x.membrane.calls[2]!.messages;
      const tickAt = later.findIndex((m) => textOf(m) === 'tick note');
      assert.equal(textOf(later[tickAt - 1]!), '[heartbeat tick]');
      assert.equal(textOf(later[tickAt - 2]!), 'ordinary reply');
      // The tick's own request saw the separator in place of '[Continue]'.
      assert.equal(textOf(x.membrane.calls[1]!.messages.at(-1)!), '[heartbeat tick]');
      assert.deepEqual(later.slice(0, x.membrane.calls[1]!.messages.length), x.membrane.calls[1]!.messages);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('stamps every row a tick writes and stores no prompt or separator row', async () => {
    const x = await make();
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      const before = stored(x.framework).length;
      const tick = silentEvent();
      await wake(x, tick, TICK_TOOL_ROUND, TICK_TRAILING);
      assert.equal(x.mod.calls.length, 1, 'explicit tool still ran');

      const all = stored(x.framework);
      const tickRows = all.slice(before);
      assert.deepEqual(tickRows.map((m) => m.participant), ['assistant', 'user', 'assistant'],
        'tool round assistant row, its tool_result row, trailing assistant row — nothing else');
      for (const row of tickRows) {
        assert.equal(row.metadata?.silentHeartbeat?.eventId, tick.eventId, `row stamped: ${JSON.stringify(row.content)}`);
        assert.equal(row.metadata?.silentHeartbeat?.serverId, 'heartbeat');
      }
      assert.ok(tickRows[1]!.content.every((b) => b.type === 'tool_result'), 'the only user row is the tool_result');
      for (const row of all.slice(0, before)) {
        assert.equal(row.metadata?.silentHeartbeat, undefined, 'ordinary rows are not stamped');
      }
      assert.ok(!JSON.stringify(all).includes('[heartbeat tick]'), 'the separator is never stored');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('renders the separator at a fixed position, byte-stable from the tick request onward', async () => {
    const x = await make();
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      await wake(x, silentEvent(), TICK_TOOL_ROUND, TICK_TRAILING);
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      assert.equal(x.membrane.calls.length, 3, 'tool round continued in-stream');

      const tickRequest = x.membrane.calls[1]!.messages;
      const later = x.membrane.calls[2]!.messages;
      // The tick's own request ends on the separator turn, not '[Continue]'.
      assert.equal(textOf(tickRequest.at(-1)!), '[heartbeat tick]');
      assert.equal(tickRequest.at(-1)!.participant, 'user');
      assert.ok(!tickRequest.some((m) => textOf(m) === '[Continue]'));
      // Every later compile renders the same turn in the same place, so the
      // tick request is a byte-exact prefix of the next request.
      assert.deepEqual(later.slice(0, tickRequest.length), tickRequest);
      const separatorAt = later.findIndex((m) => textOf(m) === '[heartbeat tick]');
      assert.equal(separatorAt, tickRequest.length - 1);
      assert.equal(textOf(later[separatorAt + 1]!), 'checking');
      assert.equal(later.filter((m) => textOf(m) === '[heartbeat tick]').length, 1,
        'one separator per tick, before its first row only');

      const provider = wire(x.membrane.calls[2]!);
      const roles = provider.map((m) => m.role);
      for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1]);
      for (const message of provider) assert.ok(signatures(message).length <= 1);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('keeps the tick identity across a context-budget restart inside the tick', async () => {
    const membrane = new QueuedStreamsMembrane();
    const x = await make({ membrane, physicalWindowTokens: 200_000 });
    try {
      membrane.queues.push([createMockResponse(signed('sig-ordinary', 'ordinary reply'))]);
      await wake(x, ordinaryEvent('hello'));
      const before = stored(x.framework).length;
      // The tool round reports a near-cap real prefix, so the tool boundary
      // restarts through a fresh compile instead of continuing the stream.
      const nearCap = createMockResponse(TICK_TOOL_ROUND, 'tool_use');
      (nearCap as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
      membrane.queues.push([nearCap], [createMockResponse(TICK_TRAILING)]);
      const restarts: unknown[] = [];
      x.framework.onTrace((e: any) => { if (e.type === 'inference:stream_restarted') restarts.push(e); });
      const tick = silentEvent();
      await wake(x, tick);
      assert.equal(restarts.length, 1, 'the tick restarted once');
      assert.equal(membrane.calls.length, 3);

      const tickRows = stored(x.framework).slice(before);
      assert.deepEqual(tickRows.map((m) => m.participant), ['assistant', 'user', 'assistant']);
      for (const row of tickRows) assert.equal(row.metadata?.silentHeartbeat?.eventId, tick.eventId);

      const opening = membrane.calls[1]!.messages;
      const restarted = membrane.calls[2]!.messages;
      assert.deepEqual(restarted.slice(0, opening.length), opening, 'restart compiles the same prefix');
      assert.equal(restarted.filter((m) => textOf(m) === '[heartbeat tick]').length, 1);
      assert.ok(!restarted.some((m) => textOf(m) === '[Continue]'), 'the restart window ends on the tool_result');
      assert.match(JSON.stringify(membrane.calls[2]), /Scheduled private self-check/, 'still a silent turn');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('leaves ordinary turns exactly as before', async () => {
    // Undelivered prose leaves no receipt, so the window ends on the reply.
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      await wake(x, ordinaryEvent('again'), signed('sig-2', 'second reply'));
      // A wake without a stored row (a module/timer-style wake) still gets
      // the existing request-only '[Continue]' turn.
      x.membrane.pushResponse(createMockResponse(signed('sig-3', 'third reply')));
      (x.framework as any).pendingRequests.push({
        agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now(),
      });
      await x.framework.runUntilIdle();
      assert.equal(x.membrane.calls.length, 3);
      for (const call of x.membrane.calls) {
        assert.ok(!call.messages.some((m) => textOf(m) === '[heartbeat tick]'));
      }
      assert.equal(textOf(x.membrane.calls[2]!.messages.at(-1)!), '[Continue]');
      for (const row of stored(x.framework)) assert.equal(row.metadata?.silentHeartbeat, undefined);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });
});
