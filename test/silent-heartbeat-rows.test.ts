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
import { AgentFramework, SILENT_HEARTBEAT_SEPARATOR } from '../src/index.js';
import { indexRequestOnlyRows, renderRequestOnlyRows, tickKey } from '../src/silent-heartbeat.js';
import type { AgentConfig, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { TOOL_RESULT_GUARD_NOTICE } from '../src/tool-result-guard.js';
import { PassthroughStrategy } from '@animalabs/context-manager';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { MembraneError, NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

class ToolModule implements Module {
  readonly name = 'tools';
  calls: ToolCall[] = [];
  /** A message someone sends while the next call runs: the agent's turn is
   * alive, so it is deferred to the tool boundary. */
  arrive: string | null = null;
  /** The next call's result ends the turn. */
  endTurn = false;
  private ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext) { this.ctx = ctx; ctx.registerSpeechHandler('*'); }
  async stop() { this.ctx?.unregisterSpeechHandler(); this.ctx = null; }
  async onProcess() { return {}; }
  async onAgentSpeech() {}
  getTools(): ToolDefinition[] { return [{ name: 'ping', description: 'explicit action', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    if (this.arrive !== null) {
      this.ctx!.addMessage('nissa', [{ type: 'text', text: this.arrive }] as ContentBlock[]);
      this.arrive = null;
    }
    const endTurn = this.endTurn;
    this.endTurn = false;
    return { success: true, data: { ok: true }, ...(endTurn ? { endTurn } : {}) };
  }
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

/** A stream the provider fails at once. */
class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

/** One explicit queue per stream, so a restart opens a fresh one: the
 * responses of its tool rounds, or an error the stream fails with. */
class QueuedStreamsMembrane extends MockMembrane {
  queues: Array<NormalizedResponse[] | Error> = [];
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const next = this.queues.shift() ?? [];
    if (next instanceof Error) return new ErrorStream(next);
    const stream = new MockYieldingStream(next);
    this.lastStream = stream;
    return stream;
  }
}

/** A 429 that holds the turn for a provider cooldown. */
const accelerationLimit = () => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429,
  message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
  rawError: { status: 429 },
});

/** A failure no error policy retries. */
const unretriedFailure = () => new MembraneError({
  type: 'invalid_request', retryable: false, httpStatus: 400,
  message: 'invalid request', rawError: { status: 400 },
});

const transientFailure = () => new MembraneError({
  type: 'server', retryable: true, httpStatus: 500,
  message: 'internal server error', rawError: { status: 500 },
});

/** A tool round whose usage puts the next round past the physical window, so
 * the stream restarts at its boundary. */
function nearCapToolRound(signature: string, text: string, id: string): NormalizedResponse {
  const response = createMockResponse(
    signed(signature, text, [{ type: 'tool_use', id, name: 'tools--ping', input: {} } as ContentBlock]), 'tool_use');
  (response as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
  return response;
}

/** A strategy that leaves every tool exchange out of the compiled window
 * (from the moment `omit` is set, for a window that folds them later). */
class OmitToolExchange extends PassthroughStrategy {
  omit = true;
  select(...args: Parameters<PassthroughStrategy['select']>) {
    return super.select(...args).filter((entry) => !this.omit
      || !entry.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result'));
  }
}

const refused = () => ({
  ...createMockResponse([{ type: 'text', text: 'discard-this-partial-output' }], 'refusal'),
  raw: { request: {}, response: { stop_details: { category: 'test-category' } } },
}) as NormalizedResponse;

async function make(opts: {
  deliver?: boolean; membrane?: MockMembrane; physicalWindowTokens?: number;
  agents?: string[]; agent?: Partial<AgentConfig>;
  /** An earlier framework's directory, to open its store again. */
  dir?: string;
} = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'silent-hb-rows-'));
  const membrane = opts.membrane ?? new MockMembrane();
  const mod = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: (opts.agents ?? ['assistant']).map((name) => ({
      name, model: 'test', systemPrompt: 'test', proseRouting: 'locus' as const, maxTokens: 4_000,
      ...(opts.physicalWindowTokens ? { physicalWindowTokens: opts.physicalWindowTokens } : {}),
      ...opts.agent,
    })),
    modules: [mod],
  });
  (framework as any).channelRegistry = new Proxy({
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }), getDefaultPublishChannel: () => ({ serverId: 'stub', channelId: 'world:commons' }),
    routeSpeech: async () => ({ delivered: opts.deliver ?? true, serverId: 'stub', channelId: 'world:commons' }),
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

function stored(framework: AgentFramework, agent = 'assistant') {
  return framework.getAgent(agent)!.getContextManager().getAllMessages() as Array<{
    participant: string; content: ContentBlock[]; metadata?: Record<string, any>;
  }>;
}

function rowWith(framework: AgentFramework, text: string) {
  const row = stored(framework).find((m) => m.content.some((b) => (b as { text?: string }).text === text));
  assert.ok(row, `a stored row reads ${JSON.stringify(text)}`);
  return row;
}

/** Wait for what a test's next assertions need, rather than for a length of
 * time: a timer the framework set (a retry's backoff, a cooldown's release)
 * can fire late on a loaded host. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
      assert.equal(textOf(later[tickAt - 1]!), SILENT_HEARTBEAT_SEPARATOR);
      assert.equal(textOf(later[tickAt - 2]!), 'ordinary reply');
      // The tick's own request saw the separator in place of '[Continue]'.
      assert.equal(textOf(x.membrane.calls[1]!.messages.at(-1)!), SILENT_HEARTBEAT_SEPARATOR);
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
        assert.deepEqual(row.metadata?.silentHeartbeat,
          { eventId: tick.eventId, serverId: 'heartbeat', agentName: 'assistant', separator: SILENT_HEARTBEAT_SEPARATOR },
          `row stamped: ${JSON.stringify(row.content)}`);
      }
      assert.ok(tickRows[1]!.content.every((b) => b.type === 'tool_result'), 'the only user row is the tool_result');
      for (const row of all.slice(0, before)) {
        assert.equal(row.metadata?.silentHeartbeat, undefined, 'ordinary rows are not stamped');
      }
      assert.ok(!all.some((m) => JSON.stringify(m.content).includes(SILENT_HEARTBEAT_SEPARATOR)),
        'the separator is never stored as a row');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("stores a tick's changed context injection unstamped: history the resident saw, not the tick's speech", async () => {
    const x = await make();
    try {
      let gathered = 0;
      (x.mod as unknown as { gatherContext: () => Promise<unknown[]> }).gatherContext = async () =>
        [{ namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: `LESSON ${++gathered}` }] }];
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      const before = stored(x.framework).length;
      await wake(x, silentEvent(), TICK_TOOL_ROUND, TICK_TRAILING);
      const injected = stored(x.framework).slice(before).filter((m) => m.metadata?.contextInjection);
      assert.deepEqual(injected.map((m) => m.content), [[{ type: 'text', text: 'LESSON 2' }]], "the tick's start stored its changed injection");
      assert.equal(injected[0]!.metadata?.silentHeartbeat, undefined, 'unstamped, so a retention policy for ticks leaves it');
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
      assert.equal(textOf(tickRequest.at(-1)!), SILENT_HEARTBEAT_SEPARATOR);
      assert.equal(tickRequest.at(-1)!.participant, 'user');
      assert.ok(!tickRequest.some((m) => textOf(m) === '[Continue]'));
      // Every later compile renders the same turn in the same place, so the
      // tick request is a byte-exact prefix of the next request.
      assert.deepEqual(later.slice(0, tickRequest.length), tickRequest);
      const separatorAt = later.findIndex((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR);
      assert.equal(separatorAt, tickRequest.length - 1);
      assert.equal(textOf(later[separatorAt + 1]!), 'checking');
      assert.equal(later.filter((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR).length, 1,
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
      assert.equal(restarted.filter((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR).length, 1);
      assert.ok(!restarted.some((m) => textOf(m) === '[Continue]'), 'the restart window ends on the tool_result');
      assert.match(JSON.stringify(membrane.calls[2]), /Scheduled private self-check/, 'still a silent turn');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('opens the tick again on a restart whose compile left none of its rows', async () => {
    const membrane = new QueuedStreamsMembrane();
    const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: false, agent: { strategy: new OmitToolExchange() } });
    try {
      membrane.queues.push([createMockResponse(signed('sig-ordinary', 'ordinary reply'))]);
      await wake(x, ordinaryEvent('hello'));
      const nearCap = createMockResponse(TICK_TOOL_ROUND, 'tool_use');
      (nearCap as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
      membrane.queues.push([nearCap], [createMockResponse(signed('sig-tick-final', 'all quiet'))]);
      await wake(x, silentEvent());
      membrane.queues.push([createMockResponse(signed('sig-later', 'later reply'))]);
      await wake(x, ordinaryEvent('later'));
      assert.equal(membrane.calls.length, 4, 'ordinary, tick, its restart, later');

      // The strategy dropped the tick's only rows (its tool exchange), so the
      // restart's compile ends on the ordinary reply: the tick opens again.
      const restarted = membrane.calls[2]!.messages;
      assert.ok(!restarted.some((m) => textOf(m) === 'checking'));
      assert.equal(textOf(restarted.at(-1)!), SILENT_HEARTBEAT_SEPARATOR);
      assert.ok(!restarted.some((m) => textOf(m) === '[Continue]'));
      // The reply it minted follows the separator in every later request.
      const later = membrane.calls[3]!.messages;
      assert.deepEqual(later.slice(0, restarted.length), restarted);
      assert.equal(later.filter((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR).length, 1);
      assert.equal(textOf(later[later.findIndex((m) => textOf(m) === 'all quiet') - 1]!), SILENT_HEARTBEAT_SEPARATOR);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('separates the first SURVIVING tick row when a strategy drops the tick\'s tool exchange', async () => {
    const x = await make({ deliver: false, agent: { strategy: new OmitToolExchange() } });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      await wake(x, silentEvent(), TICK_TOOL_ROUND, signed('sig-tick-final', 'all quiet'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      const provider = wire(x.membrane.calls[2]!);
      for (const message of provider) {
        assert.ok(signatures(message).length <= 1,
          `one ${message.role} message carries signed thinking from: ${signatures(message).join(', ')}`);
      }
      const later = x.membrane.calls[2]!.messages;
      assert.ok(!later.some((m) => textOf(m) === 'checking'), 'the strategy dropped the tool round');
      const finalAt = later.findIndex((m) => textOf(m) === 'all quiet');
      assert.equal(textOf(later[finalAt - 1]!), SILENT_HEARTBEAT_SEPARATOR);
      assert.equal(later.filter((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR).length, 1);
      assert.deepEqual(later.slice(0, x.membrane.calls[1]!.messages.length), x.membrane.calls[1]!.messages);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('never keys separators on reply text: identical replies cannot steal or collapse them', async () => {
    const x = await make({ deliver: false });
    try {
      const quiet = [{ type: 'text', text: 'all quiet' }] as ContentBlock[];
      await wake(x, ordinaryEvent('hello'), quiet);
      await wake(x, silentEvent(), quiet);
      await wake(x, silentEvent(), signed('sig-a', 'all quiet'));
      await wake(x, silentEvent(), signed('sig-b', 'all quiet'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      const later = x.membrane.calls[4]!.messages;
      const separators = later.flatMap((m, i) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR ? [i] : []);
      // Only the two signed ticks are separated, each directly before its
      // own reply. The unsigned, tool-free tick has no structural identity
      // and merges as it did before (no signed thinking, so no 400 risk);
      // the ordinary reply with the same text is never mistaken for a tick.
      assert.equal(separators.length, 2, JSON.stringify(later.map(textOf)));
      for (const [i, sig] of [[separators[0]!, 'sig-a'], [separators[1]!, 'sig-b']] as const) {
        assert.equal((later[i + 1]!.content[0] as { signature?: string }).signature, sig);
      }
      for (const message of wire(x.membrane.calls[4]!)) assert.ok(signatures(message).length <= 1);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('matches a signed reply carrying blank text blocks, which request builds strip', async () => {
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      await wake(x, silentEvent(), [
        { type: 'text', text: '' } as ContentBlock,
        ...signed('sig-tick', 'quiet'),
        { type: 'text', text: '   ' } as ContentBlock,
      ]);
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      const later = x.membrane.calls[2]!.messages;
      const tickAt = later.findIndex((m) => textOf(m) === 'quiet');
      assert.equal(textOf(later[tickAt - 1]!), SILENT_HEARTBEAT_SEPARATOR);
      for (const message of wire(x.membrane.calls[2]!)) assert.ok(signatures(message).length <= 1);
      assert.deepEqual(later.slice(0, x.membrane.calls[1]!.messages.length), x.membrane.calls[1]!.messages);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('opens a broadcast tick per resident, not per shared eventId', async () => {
    // Residents share one message slot. A broadcast tick reaches each with
    // the same eventId; a resident that was busy runs its copy after another
    // resident has already stored stamped rows for that tick.
    const x = await make({ deliver: false, agents: ['alpha', 'beta'] });
    try {
      const tick = silentEvent();
      await wake(x, { ...ordinaryEvent('hello beta'), targetAgents: ['beta'] }, signed('sig-beta', 'beta reply'));
      await wake(x, { ...tick, targetAgents: ['alpha'] }, signed('sig-alpha-tick', 'alpha tick'));
      assert.ok(stored(x.framework, 'alpha').some((m) => m.metadata?.silentHeartbeat?.eventId === tick.eventId));
      await wake(x, { ...tick, targetAgents: ['beta'] }, signed('sig-beta-tick', 'beta tick'));
      await wake(x, { ...ordinaryEvent('later'), targetAgents: ['beta'] }, signed('sig-beta-later', 'later reply'));

      const betaCalls = x.membrane.calls.filter((c) => c.assistantParticipant === 'beta');
      assert.equal(betaCalls.length, 3);
      const [, betaTick, betaLater] = betaCalls;
      assert.equal(textOf(betaTick!.messages.at(-1)!), SILENT_HEARTBEAT_SEPARATOR, "beta opens its own tick");
      assert.deepEqual(betaLater!.messages.slice(0, betaTick!.messages.length), betaTick!.messages,
        "beta's tick request stays a byte-exact prefix of its next request");
      const betaTickAt = betaLater!.messages.findIndex((m) => textOf(m) === 'beta tick');
      assert.equal(textOf(betaLater!.messages[betaTickAt - 1]!), SILENT_HEARTBEAT_SEPARATOR);
      const owners = stored(x.framework, 'beta')
        .filter((m) => m.metadata?.silentHeartbeat?.eventId === tick.eventId)
        .map((m) => [m.participant, m.metadata!.silentHeartbeat.agentName]);
      assert.deepEqual(owners, [['alpha', 'alpha'], ['beta', 'beta']]);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('stamps guarded tool results through acceptance', async () => {
    const membrane = new QueuedStreamsMembrane();
    const x = await make({ membrane, agent: { toolResultGuard: true } });
    try {
      membrane.queues.push([createMockResponse(signed('sig-ordinary', 'ordinary reply'))]);
      await wake(x, ordinaryEvent('hello'));
      const before = stored(x.framework).length;
      membrane.queues.push([createMockResponse(TICK_TOOL_ROUND, 'tool_use'), createMockResponse(TICK_TRAILING)]);
      const tick = silentEvent();
      await wake(x, tick);
      assert.equal(x.framework.getAgent('assistant')!.toolResultGuard.enabled, true);
      const tickRows = stored(x.framework).slice(before);
      assert.deepEqual(tickRows.map((m) => m.participant), ['assistant', 'user', 'assistant']);
      for (const row of tickRows) assert.equal(row.metadata?.silentHeartbeat?.eventId, tick.eventId);
      const result = tickRows[1]!.content[0] as { type: string; content?: unknown };
      assert.equal(result.type, 'tool_result');
      assert.notEqual(result.content, TOOL_RESULT_GUARD_NOTICE, 'placeholder was replaced on acceptance');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('stamps guarded tool results through a refusal restart', async () => {
    const membrane = new QueuedStreamsMembrane();
    const x = await make({ membrane, agent: { toolResultGuard: true } });
    try {
      membrane.queues.push([createMockResponse(signed('sig-ordinary', 'ordinary reply'))]);
      await wake(x, ordinaryEvent('hello'));
      const before = stored(x.framework).length;
      membrane.queues.push(
        [createMockResponse(TICK_TOOL_ROUND, 'tool_use'), refused()],
        [createMockResponse(TICK_TRAILING)],
      );
      const tick = silentEvent();
      await wake(x, tick);
      assert.equal(membrane.calls.length, 3, 'the guard restarted the tick once');
      const tickRows = stored(x.framework).slice(before);
      assert.deepEqual(tickRows.map((m) => m.participant), ['assistant', 'user', 'assistant']);
      for (const row of tickRows) assert.equal(row.metadata?.silentHeartbeat?.eventId, tick.eventId);
      // Written out, not computed by the code under test.
      assert.equal((tickRows[1]!.content[0] as { content?: unknown }).content, 'Tool result withheld by the guard. ' +
        "The tool has already executed. Its result is kept in the guard's audit record (framework/tool-result-guard), " +
        'for an operator.');
      assert.doesNotMatch(JSON.stringify(tickRows), /discard-this-partial-output/);

      const opening = membrane.calls[1]!.messages;
      const retry = membrane.calls[2]!.messages;
      assert.deepEqual(retry.slice(0, opening.length), opening, 'the retry compiles the same prefix');
      assert.equal(retry.filter((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR).length, 1);
      assert.match(JSON.stringify(membrane.calls[2]), /Scheduled private self-check/, 'still a silent turn');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("renders the ticks and [Continue] replies of a participant the agent counts as its own voice", async () => {
    const x = await make({ agent: { selfParticipants: ['elder'] } });
    try {
      const cm = x.framework.getAgent('assistant')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'earlier' }]);
      cm.addMessage('elder', signed('sig-e1', 'elder tick reply'), {
        silentHeartbeat: { eventId: 'hb-e', serverId: 'heartbeat', agentName: 'elder', separator: SILENT_HEARTBEAT_SEPARATOR },
      });
      cm.addMessage('elder', signed('sig-e2', 'elder continued'), { promptedBy: { turn: 'p-e', text: '[Continue]' } });
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      const texts = x.membrane.calls[0]!.messages.map(textOf);
      assert.equal(texts[texts.indexOf('elder tick reply') - 1], SILENT_HEARTBEAT_SEPARATOR, JSON.stringify(texts));
      assert.equal(texts[texts.indexOf('elder continued') - 1], '[Continue]', JSON.stringify(texts));
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
        assert.ok(!call.messages.some((m) => textOf(m) === SILENT_HEARTBEAT_SEPARATOR));
      }
      assert.equal(textOf(x.membrane.calls[2]!.messages.at(-1)!), '[Continue]');
      for (const row of stored(x.framework)) assert.equal(row.metadata?.silentHeartbeat, undefined);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('sends the agent\'s own system prompt on a tick: a heartbeat changes nothing before the messages', async () => {
    const x = await make();
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-ordinary', 'ordinary reply'));
      await wake(x, silentEvent(), signed('sig-tick', 'tick note'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      assert.deepEqual(x.membrane.calls.map((call) => call.system), ['test', 'test', 'test'],
        'the instruction rides the separator, not a one-turn system prompt');
      assert.match(textOf(x.membrane.calls[1]!.messages.at(-1)!), /Scheduled private self-check/);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });
});

/** A wake with no stored row (a module or timer wake), answered with `content`. */
async function timerWake(x: { membrane: MockMembrane; framework: AgentFramework }, ...responses: ContentBlock[][]) {
  for (const content of responses) {
    x.membrane.pushResponse(createMockResponse(content, content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'));
  }
  (x.framework as any).pendingRequests.push({
    agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now(),
  });
  await x.framework.runUntilIdle();
}

describe('replies to a [Continue] turn', () => {
  it('renders [Continue] again before the reply it prompted, byte-stable from that request on', async () => {
    // Undelivered prose leaves no receipt, so the window ends on the reply.
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      await timerWake(x, signed('sig-c', 'continued reply'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));

      const continued = x.membrane.calls[1]!.messages;
      const later = x.membrane.calls[2]!.messages;
      assert.equal(textOf(continued.at(-1)!), '[Continue]');
      // The request that minted the reply is a byte-exact prefix of the next.
      assert.deepEqual(later.slice(0, continued.length), continued);
      const replyAt = later.findIndex((m) => textOf(m) === 'continued reply');
      assert.equal(textOf(later[replyAt - 1]!), '[Continue]');

      const provider = wire(x.membrane.calls[2]!);
      for (const message of provider) {
        assert.ok(signatures(message).length <= 1,
          `one ${message.role} message carries signed thinking from: ${signatures(message).join(', ')}`);
      }

      const rows = stored(x.framework);
      const reply = rows.find((m) => m.content.some((b) => (b as { text?: string }).text === 'continued reply'))!;
      assert.equal(reply.metadata?.promptedBy?.text, '[Continue]');
      assert.equal(typeof reply.metadata?.promptedBy?.turn, 'string');
      for (const row of rows.filter((m) => m !== reply)) assert.equal(row.metadata?.promptedBy, undefined);
      assert.ok(!rows.some((m) => m.content.some((b) => (b as { text?: string }).text === '[Continue]')),
        'the [Continue] turn is never stored');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("stamps the reply of a [Continue] turn that a wake to read a render started, whose trigger the turn copies without the wake's mark", async () => {
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      // A render still queued (for another resident) keeps its wake to read
      // it, which starts a turn with nothing new for this agent: [Continue].
      const internals = x.framework as any;
      internals.deferredMessages.push({ id: 'render-x', seq: 1, participant: 'editor', forAgent: 'ghost', content: [{ type: 'text', text: 'elsewhere' }], heldAt: Date.now() });
      x.membrane.pushResponse(createMockResponse(signed('sig-c', 'continued reply'), 'end_turn'));
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'mcpl:push-event', source: 'editor', timestamp: Date.now(), readsDeferredWrite: 'render-x' });
      await x.framework.runUntilIdle();
      internals.deferredMessages.splice(0);
      assert.equal(textOf(x.membrane.calls[1]!.messages.at(-1)!), '[Continue]');
      assert.equal(rowWith(x.framework, 'continued reply').metadata?.promptedBy?.text, '[Continue]', 'the reply carries the prompt it followed');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('a row that is both a tick row and a reply to [Continue] gets both turns, separator first', () => {
    const tick = { eventId: 'hb-x', serverId: 'heartbeat', agentName: 'assistant', separator: SILENT_HEARTBEAT_SEPARATOR };
    const prompt = { turn: 'p-1', text: '[Continue]' };
    const stored = [
      { participant: 'assistant', content: signed('sig-a', 'earlier reply') },
      { participant: 'assistant', content: signed('sig-1', 'tick round'), metadata: { silentHeartbeat: tick } },
      { participant: 'assistant', content: signed('sig-2', 'tick continued'),
        metadata: { silentHeartbeat: tick, promptedBy: prompt } },
    ];
    const index = indexRequestOnlyRows(stored, 'assistant');
    const bare = (rows: typeof stored) => rows.map(({ participant, content }) => ({ participant, content }));
    assert.deepEqual(renderRequestOnlyRows(bare(stored), index, 'assistant').messages.map(textOf), [
      'earlier reply', SILENT_HEARTBEAT_SEPARATOR, 'tick round', '[Continue]', 'tick continued',
    ]);
    // With the tick's first row folded away, the stamped row is the tick's
    // first surviving row: both turns precede it, the separator first.
    assert.deepEqual(renderRequestOnlyRows(bare([stored[0]!, stored[2]!]), index, 'assistant').messages.map(textOf),
      ['earlier reply', SILENT_HEARTBEAT_SEPARATOR, '[Continue]', 'tick continued']);
  });

  it('renders the text each stamp recorded, and the bare marker for ticks stamped before it was recorded', () => {
    const stored = [
      { participant: 'assistant', content: signed('sig-old', 'old tick reply'),
        metadata: { silentHeartbeat: { eventId: 'hb-old', serverId: 'heartbeat', agentName: 'assistant' } } },
      { participant: 'assistant', content: signed('sig-new', 'new tick reply'),
        metadata: { silentHeartbeat: { eventId: 'hb-new', serverId: 'heartbeat', agentName: 'assistant', separator: 'recorded separator' } } },
      { participant: 'assistant', content: signed('sig-c', 'continued reply'),
        metadata: { promptedBy: { turn: 'p-1', text: 'recorded prompt' } } },
    ];
    const index = indexRequestOnlyRows(stored, 'assistant');
    const rendered = renderRequestOnlyRows(stored.map(({ participant, content }) => ({ participant, content })), index, 'assistant');
    assert.deepEqual(rendered.messages.map(textOf), [
      '[heartbeat tick]', 'old tick reply', 'recorded separator', 'new tick reply', 'recorded prompt', 'continued reply',
    ]);
    assert.deepEqual([...rendered.separatedTicks].sort(), [
      tickKey({ serverId: 'heartbeat', eventId: 'hb-new' }), tickKey({ serverId: 'heartbeat', eventId: 'hb-old' }),
    ].sort());
  });

  it("renders an inherited voice's ticks and replies to [Continue] as a derived agent's own", () => {
    const tick = { eventId: 'hb-p', serverId: 'heartbeat', agentName: 'parent', separator: SILENT_HEARTBEAT_SEPARATOR };
    const stored = [
      { participant: 'parent', content: signed('sig-p1', 'parent tick reply'), metadata: { silentHeartbeat: tick } },
      { participant: 'parent', content: signed('sig-p2', 'parent continued'), metadata: { promptedBy: { turn: 'p-1', text: '[Continue]' } } },
      { participant: 'child', content: signed('sig-c', 'child reply') },
    ];
    const index = indexRequestOnlyRows(stored, new Set(['child', 'parent']));
    const presented = stored.map(({ content }) => ({ participant: 'parent', content }));
    assert.deepEqual(renderRequestOnlyRows(presented, index, 'parent').messages.map(textOf), [
      SILENT_HEARTBEAT_SEPARATOR, 'parent tick reply', '[Continue]', 'parent continued', 'child reply',
    ]);
  });

  it('keys a tick by its server and its event id together', () => {
    // Two servers' events can share an id: each tick still gets its own
    // separator, before its own first row.
    const a = { eventId: 'hb-1', serverId: 'heartbeat-a', agentName: 'assistant', separator: 'separator a' };
    const b = { eventId: 'hb-1', serverId: 'heartbeat-b', agentName: 'assistant', separator: 'separator b' };
    const stored = [
      { participant: 'assistant', content: signed('sig-a', 'tick a reply'), metadata: { silentHeartbeat: a } },
      { participant: 'nissa', content: [{ type: 'text', text: 'between the ticks' }] as ContentBlock[] },
      { participant: 'assistant', content: signed('sig-b', 'tick b reply'), metadata: { silentHeartbeat: b } },
    ];
    const index = indexRequestOnlyRows(stored, 'assistant');
    const rendered = renderRequestOnlyRows(stored.map(({ participant, content }) => ({ participant, content })), index, 'assistant');
    assert.deepEqual(rendered.messages.map(textOf),
      ['separator a', 'tick a reply', 'between the ticks', 'separator b', 'tick b reply']);
    assert.deepEqual([...rendered.separatedTicks].sort(), [tickKey(a), tickKey(b)].sort());
  });

  it('marks every row the reply\'s turn stores, and renders one [Continue] before the first', async () => {
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      await timerWake(x,
        signed('sig-c', 'checking', [{ type: 'tool_use', id: 'c-t1', name: 'tools--ping', input: {} } as ContentBlock]),
        signed('sig-c2', 'all done'));
      assert.equal(x.mod.calls.length, 1);
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));

      const rows = stored(x.framework);
      const marked = rows.filter((m) => m.metadata?.promptedBy !== undefined);
      assert.deepEqual(marked.map((m) => m.participant), ['assistant', 'user', 'assistant'],
        'the tool round, its tool_result row and the final reply');
      assert.equal(new Set(marked.map((m) => m.metadata!.promptedBy.turn)).size, 1, 'one prompt');

      const later = x.membrane.calls[2]!.messages;
      assert.equal(later.filter((m) => textOf(m) === '[Continue]').length, 1);
      const roundAt = later.findIndex((m) => textOf(m) === 'checking');
      assert.equal(textOf(later[roundAt - 1]!), '[Continue]');
      assert.deepEqual(later.slice(0, x.membrane.calls[1]!.messages.length), x.membrane.calls[1]!.messages);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('a budget restart that ends on the round\'s tool results reads its prompt, for a window that later folds the round', async () => {
    const membrane = new QueuedStreamsMembrane();
    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: false, agent: { strategy } });
    try {
      membrane.queues.push([createMockResponse(signed('sig-1', 'first reply'))]);
      await wake(x, ordinaryEvent('hello'));
      // The reply to [Continue] restarts at its tool boundary. The restart's
      // compile ends on the round's tool_result, so its reply continues that
      // round's tool loop and follows the same prompt.
      membrane.queues.push([nearCapToolRound('sig-c', 'checking', 'c-t1')], [createMockResponse(signed('sig-c2', 'all done'))]);
      (x.framework as any).pendingRequests.push({ agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now() });
      await x.framework.runUntilIdle();
      assert.equal(membrane.calls.length, 3, 'first, the continued reply, its restart');
      assert.equal(textOf(membrane.calls[1]!.messages.at(-1)!), '[Continue]');
      assert.notEqual(textOf(membrane.calls[2]!.messages.at(-1)!), '[Continue]');

      const marked = stored(x.framework).filter((m) => m.metadata?.promptedBy !== undefined);
      assert.equal(marked.length, 3, 'the round, its result and the restart\'s reply');
      assert.equal(new Set(marked.map((m) => m.metadata!.promptedBy.turn)).size, 1);

      // Later, the window folds the first round: [Continue] moves to the
      // restart's reply, the first of the prompt's rows that survives.
      strategy.omit = true;
      membrane.queues.push([createMockResponse(signed('sig-later', 'later reply'))]);
      await wake(x, ordinaryEvent('later'));
      const later = membrane.calls[3]!.messages;
      assert.ok(!later.some((m) => textOf(m) === 'checking'));
      assert.equal(textOf(later[later.findIndex((m) => textOf(m) === 'all done') - 1]!), '[Continue]');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("a restart that ends on the round's tool results and then a changed stored injection still reads its prompt", async () => {
    const membrane = new QueuedStreamsMembrane();
    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: false, agent: { strategy } });
    try {
      let gathered = 0;
      (x.mod as unknown as { gatherContext: () => Promise<unknown[]> }).gatherContext = async () =>
        [{ namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: `LESSON ${++gathered}` }] }];
      membrane.queues.push([createMockResponse(signed('sig-1', 'first reply'))]);
      await wake(x, ordinaryEvent('hello'));
      membrane.queues.push([nearCapToolRound('sig-c', 'checking', 'c-t1')], [createMockResponse(signed('sig-c2', 'all done'))]);
      (x.framework as any).pendingRequests.push({ agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now() });
      await x.framework.runUntilIdle();
      assert.equal(membrane.calls.length, 3, 'first, the continued reply, its restart');
      assert.equal(textOf(membrane.calls[2]!.messages.at(-1)!), `LESSON ${gathered}`, "the premise: the restart's request ends on a stored injection after the results");
      const done = stored(x.framework).find((m) => m.content.some((b) => (b as { text?: string }).text === 'all done'))!;
      assert.equal(done.metadata?.promptedBy?.text, '[Continue]', "the restart's reply follows the round's prompt");
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("a restart that ends on the round's tool results and then an injection compile() places reads no prompt, as on main", async () => {
    const membrane = new QueuedStreamsMembrane();
    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: false, agent: { strategy } });
    try {
      (x.mod as unknown as { gatherContext: () => Promise<unknown[]> }).gatherContext = async () =>
        [{ namespace: 'notes', position: 'afterUser', content: [{ type: 'text', text: 'PLACED NOTE' }], placedEachCompile: true }];
      membrane.queues.push([createMockResponse(signed('sig-1', 'first reply'))]);
      await wake(x, ordinaryEvent('hello'));
      membrane.queues.push([nearCapToolRound('sig-c', 'checking', 'c-t1')], [createMockResponse(signed('sig-c2', 'all done'))]);
      (x.framework as any).pendingRequests.push({ agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now() });
      await x.framework.runUntilIdle();
      assert.equal(membrane.calls.length, 3, 'first, the continued reply, its restart');
      assert.equal(textOf(membrane.calls[2]!.messages.at(-1)!), 'PLACED NOTE', "the premise: the restart's request ends on the placed injection after the results");
      const round = stored(x.framework).find((m) => m.content.some((b) => (b as { text?: string }).text === 'checking'))!;
      assert.equal(round.metadata?.promptedBy?.text, '[Continue]', 'the premise: the round itself follows [Continue]');
      const done = stored(x.framework).find((m) => m.content.some((b) => (b as { text?: string }).text === 'all done'))!;
      assert.equal(done.metadata?.promptedBy, undefined, "a placed injection ends the tail, as on main, where every injection was placed");
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  /** A reply to [Continue] stores a tool round and restarts at its boundary,
   * and the restart meets a 429 that holds the turn. */
  async function heldRestartMeets(opts: {
    deliver: boolean; event: ReturnType<typeof ordinaryEvent>;
    resumed: NormalizedResponse[] | Error;
    whileHeld?: (x: Awaited<ReturnType<typeof make>>) => void;
  }) {
    const membrane = new QueuedStreamsMembrane();
    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: opts.deliver, agent: { strategy } });
    const internal = x.framework as unknown as {
      providerAccelerationDefaultCooldownMs: number; providerAccelerationJitterMs: number;
      providerAccelerationCooldowns: Map<string, { until: number }>; pendingRequests: unknown[];
      releaseProviderAccelerationCooldown(agentName: string): void;
    };
    internal.providerAccelerationDefaultCooldownMs = 10 * 60_000;
    internal.providerAccelerationJitterMs = 0;
    // The agents a provider hold holds, as healthSnapshot() reports them.
    const held = () => (x.framework.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { cooldownReason: string | null } }> })
      .agents.filter((agent) => agent.providerAdmission.cooldownReason !== null).map((agent) => agent.name);
    try {
      membrane.queues.push([createMockResponse(signed('sig-1', 'first reply'))]);
      await wake(x, ordinaryEvent('hello'));
      membrane.queues.push([nearCapToolRound('sig-c', 'checking', 'c-t1')], accelerationLimit(), opts.resumed,
        [createMockResponse(signed('sig-w', 'wake reply'))]);
      internal.pendingRequests.push({ agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now() });
      await x.framework.runUntilIdle();
      assert.deepEqual(held(), ['assistant'], 'the restart is held');
      await wake(x, opts.event);
      opts.whileHeld?.(x);
      assert.deepEqual(held(), ['assistant'], 'the restart is still held');
      internal.providerAccelerationCooldowns.get('assistant')!.until = Date.now();
      internal.releaseProviderAccelerationCooldown('assistant');
      await x.framework.runUntilIdle();
    } catch (error) {
      await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true });
      throw error;
    }
    return { ...x, membrane, strategy, pending: () => internal.pendingRequests };
  }

  it("a reply resumed after a provider cooldown follows the message that arrived during it, not [Continue], and the message's wake then starts no turn of its own", async () => {
    // A message arrives during the cooldown, so the resumed compile ends on
    // it, while the round, still in the window, renders [Continue] earlier.
    const x = await heldRestartMeets({ deliver: false, event: ordinaryEvent('arrived during the cooldown'), resumed: [createMockResponse(signed('sig-r', 'resumed reply'))] });
    try {
      assert.equal(x.membrane.calls.length, 4, 'first, the continued reply, its held restart, the resumed attempt');
      assert.deepEqual(x.pending(), [], "the message's wake is gone");
      const resumed = x.membrane.calls[3]!.messages;
      assert.equal(textOf(resumed.at(-1)!), 'arrived during the cooldown');
      assert.ok(resumed.some((m) => textOf(m) === '[Continue]'), 'the round renders its [Continue]');
      assert.equal(rowWith(x.framework, 'resumed reply').metadata?.promptedBy, undefined);

      // Later, the window folds the round: no [Continue] is left to render.
      x.strategy.omit = true;
      x.membrane.queues.splice(0);
      x.membrane.queues.push([createMockResponse(signed('sig-later', 'later reply'))]);
      await wake(x, ordinaryEvent('later'));
      const later = x.membrane.calls[4]!.messages;
      const replyAt = later.findIndex((m) => textOf(m) === 'resumed reply');
      assert.equal(textOf(later[replyAt - 1]!), 'arrived during the cooldown');
      assert.ok(!later.some((m) => textOf(m) === '[Continue]'));
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("a message that arrived while a restart was held keeps its wake when the resumed request that carried it fails", async () => {
    const x = await heldRestartMeets({ deliver: false, event: ordinaryEvent('arrived during the cooldown'), resumed: unretriedFailure() });
    try {
      assert.equal(textOf(x.membrane.calls[3]!.messages.at(-1)!), 'arrived during the cooldown', 'the resumed request carried the message');
      assert.equal(x.membrane.calls.length, 5, "the message's wake started its own turn: no answered request carried the message");
      assert.ok(x.membrane.calls[4]!.messages.some((m) => textOf(m) === 'arrived during the cooldown'), "the wake's turn reads it");
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it("a message that arrived while a restart was held, and was removed before the resumed request, has a wake that starts no turn", async () => {
    const x = await heldRestartMeets({
      deliver: false, event: ordinaryEvent('arrived during the cooldown'), resumed: [createMockResponse(signed('sig-r', 'resumed reply'))],
      whileHeld: (held) => {
        const cm = held.framework.getAgent('assistant')!.getContextManager();
        const row = cm.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'arrived during the cooldown'))!;
        cm.removeMessage(row.id);
      },
    });
    try {
      assert.ok(!x.membrane.calls[3]!.messages.some((m) => textOf(m) === 'arrived during the cooldown'), 'the resumed request had no message to carry');
      assert.equal(x.membrane.calls.length, 4, "the message's wake started no turn: there's nothing of it to read");
      assert.deepEqual(x.pending(), []);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  for (const deliver of [true, false]) {
    it(`a channel message that arrived while a restart was held ${deliver ? 'starts no turn once the resumed turn answered it in its channel' : 'keeps its wake when the resumed turn read it but said nothing there'}`, async () => {
      const event = { ...ordinaryEvent('arrived during the cooldown'), serverId: 'stub', origin: { mcplChannelId: 'world:commons' } };
      const x = await heldRestartMeets({ deliver, event, resumed: [createMockResponse(signed('sig-r', 'resumed reply'))] });
      try {
        assert.equal(textOf(x.membrane.calls[3]!.messages.at(-1)!), 'arrived during the cooldown', 'the resumed request carried the message');
        assert.equal(x.membrane.calls.length, deliver ? 4 : 5, deliver ? "the message's wake started no turn" : "the message's wake started its own turn");
      } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
    });
  }

  it('an ambient channel message that arrived while a restart was held starts no turn once the resumed turn read it, though the turn said nothing there', async () => {
    const event = { ...ordinaryEvent('arrived during the cooldown'), serverId: 'stub', origin: { mcplChannelId: 'world:commons' }, tags: ['chat:ambient'] };
    const x = await heldRestartMeets({ deliver: false, event, resumed: [createMockResponse(signed('sig-r', 'resumed reply'))] });
    try {
      assert.equal(textOf(x.membrane.calls[3]!.messages.at(-1)!), 'arrived during the cooldown', 'the resumed request carried the message');
      assert.equal(x.membrane.calls.length, 4, "the message's wake started no turn: its server marked it ambient");
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  for (const fork of ['before', 'after'] as const) {
    it(`a message that arrived while a restart was held, whose turn a quiesce then abandoned, ${fork === 'before' ? 'has a wake that starts no turn once the operator switches to a branch made before it' : 'still has its wake start a turn on a branch made after it'}`, async () => {
      const membrane = new QueuedStreamsMembrane();
      const strategy = new OmitToolExchange();
      strategy.omit = false;
      const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: false, agent: { strategy } });
      const internal = x.framework as unknown as {
        providerAccelerationDefaultCooldownMs: number; providerAccelerationJitterMs: number;
        providerAccelerationCooldowns: Map<string, { until: number; heldRequests: Array<{ reason: string }> }>;
        pendingRequests: unknown[]; releaseProviderAccelerationCooldown(agentName: string): void;
      };
      internal.providerAccelerationDefaultCooldownMs = 10 * 60_000;
      internal.providerAccelerationJitterMs = 0;
      try {
        membrane.queues.push([createMockResponse(signed('sig-1', 'first reply'))]);
        await wake(x, ordinaryEvent('hello'));
        membrane.queues.push([nearCapToolRound('sig-c', 'checking', 'c-t1')], accelerationLimit(),
          [createMockResponse(signed('sig-w', 'wake reply'))]);
        internal.pendingRequests.push({ agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now() });
        await x.framework.runUntilIdle();
        assert.equal(internal.providerAccelerationCooldowns.size, 1, 'the restart is held');
        const store = x.framework.getStore();
        const trunk = store.currentBranch().name;
        const beforeMessage = store.currentSequence();
        await wake(x, ordinaryEvent('arrived during the cooldown'));
        store.createBranchAt('elsewhere', trunk, fork === 'before' ? beforeMessage : store.currentSequence());
        const status = await x.framework.quiesce({ abandon: true, timeoutMs: 1_000 });
        assert.deepEqual(status.activeTurnAgents, [], 'the quiesce ended the held turn');
        const hold = internal.providerAccelerationCooldowns.get('assistant')!;
        assert.deepEqual(hold.heldRequests.map((r) => r.reason), ['mcpl:push-event'], "the message's wake still waits in the hold");
        await x.framework.switchBranch('elsewhere');
        await x.framework.resume();
        hold.until = Date.now();
        internal.releaseProviderAccelerationCooldown('assistant');
        await x.framework.runUntilIdle();
        assert.equal(store.currentBranch().name, 'elsewhere', 'the operator switched');
        if (fork === 'before') {
          assert.equal(membrane.calls.length, 3, "the message's wake started no turn: its message isn't on the branch");
        } else {
          assert.equal(membrane.calls.length, 4, "the message's wake started its turn: no answered request carried it");
          assert.ok(membrane.calls[3]!.messages.some((m) => textOf(m) === 'arrived during the cooldown'), "the wake's turn reads it");
        }
        assert.deepEqual(internal.pendingRequests, []);
      } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
    });
  }

  it('a later round that follows a message injected at its tool boundary follows the message, not [Continue]', async () => {
    // Hear-while-acting: a message that arrives while the round's tool runs
    // is stored after the tool results and handed to the live stream with
    // them, so the stream's next round follows it.
    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ deliver: false, agent: { strategy } });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      x.mod.arrive = 'arrived mid-turn';
      await timerWake(x,
        signed('sig-c', 'checking', [{ type: 'tool_use', id: 'c-t1', name: 'tools--ping', input: {} } as ContentBlock]),
        signed('sig-c2', 'all done'));
      const injected = x.membrane.lastStream!.receivedToolResultOptions[0]?.injectedMessages ?? [];
      assert.deepEqual(injected.map((m) => textOf(m as NormalizedMessage)), ['arrived mid-turn']);

      const marked = stored(x.framework).filter((m) => m.metadata?.promptedBy !== undefined);
      assert.deepEqual(marked.map((m) => m.participant), ['assistant', 'user'],
        'the round that followed [Continue], and its tool_result row');
      assert.equal(rowWith(x.framework, 'all done').metadata?.promptedBy, undefined);

      // Later, the window folds the round: the reply follows the message.
      strategy.omit = true;
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      const later = x.membrane.calls[2]!.messages;
      const doneAt = later.findIndex((m) => textOf(m) === 'all done');
      assert.equal(textOf(later[doneAt - 1]!), 'arrived mid-turn');
      assert.ok(!later.some((m) => textOf(m) === '[Continue]'));
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('a reply retried after a failure past its first round keeps following the prompt', async () => {
    const membrane = new QueuedStreamsMembrane();
    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ membrane, physicalWindowTokens: 200_000, deliver: false, agent: { strategy } });
    try {
      membrane.queues.push([createMockResponse(signed('sig-1', 'first reply'))]);
      await wake(x, ordinaryEvent('hello'));
      // The round is stored, its restart fails, and the error policy retries:
      // the retry's compile ends on the round's tool results.
      membrane.queues.push([nearCapToolRound('sig-c', 'checking', 'c-t1')], transientFailure(),
        [createMockResponse(signed('sig-c2', 'all done'))]);
      (x.framework as any).pendingRequests.push({ agentName: 'assistant', reason: 'timer', source: 'framework', timestamp: Date.now() });
      await x.framework.runUntilIdle();
      await waitFor(() => membrane.calls.length >= 4, 'the retry\'s call');
      await x.framework.runUntilIdle();
      assert.equal(membrane.calls.length, 4, 'first, the continued reply, its failed restart, the retry');
      assert.ok(membrane.calls[3]!.messages.at(-1)!.content.some((b) => b.type === 'tool_result'));

      const marked = stored(x.framework).filter((m) => m.metadata?.promptedBy !== undefined);
      assert.equal(marked.length, 3, 'the round, its result and the retry\'s reply');
      assert.equal(new Set(marked.map((m) => m.metadata!.promptedBy.turn)).size, 1);

      strategy.omit = true;
      membrane.queues.push([createMockResponse(signed('sig-later', 'later reply'))]);
      await wake(x, ordinaryEvent('later'));
      const later = membrane.calls[4]!.messages;
      assert.equal(textOf(later[later.findIndex((m) => textOf(m) === 'all done') - 1]!), '[Continue]');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('a request that ends on the agent\'s own message mints a new [Continue], with an older one rendered before it', async () => {
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      await timerWake(x, signed('sig-c1', 'continued once'));
      await timerWake(x, signed('sig-c2', 'continued twice'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));

      const second = x.membrane.calls[2]!.messages;
      assert.equal(textOf(second.at(-1)!), '[Continue]');
      assert.equal(second.filter((m) => textOf(m) === '[Continue]').length, 2, 'the first prompt renders before its reply');
      const once = rowWith(x.framework, 'continued once').metadata?.promptedBy;
      const twice = rowWith(x.framework, 'continued twice').metadata?.promptedBy;
      assert.ok(once && twice);
      assert.notEqual(twice.turn, once.turn);

      const later = x.membrane.calls[3]!.messages;
      for (const text of ['continued once', 'continued twice']) {
        assert.equal(textOf(later[later.findIndex((m) => textOf(m) === text) - 1]!), '[Continue]', text);
      }
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('finds a reply whose only identity is a redacted_thinking block', async () => {
    const x = await make({ deliver: false });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      await timerWake(x, [
        { type: 'redacted_thinking', data: 'opaque-reasoning' } as ContentBlock,
        { type: 'text', text: 'redacted reply' } as ContentBlock,
      ]);
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));

      const continued = x.membrane.calls[1]!.messages;
      const later = x.membrane.calls[2]!.messages;
      assert.equal(textOf(later[later.findIndex((m) => textOf(m) === 'redacted reply') - 1]!), '[Continue]');
      assert.deepEqual(later.slice(0, continued.length), continued);
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('a reply after the process restarts reads its prompt from the stored rows', async () => {
    // The first process ends the turn at the round's tool boundary, so its
    // store ends on the tool results. A new framework over the same store
    // holds nothing in memory from that turn. The agent's plain speech has no
    // channel, so no turn announces one (a locus announced at the first turn
    // after boot would come last, and the reply would follow it instead).
    const noLocus = (x: { framework: AgentFramework }) => { (x.framework as any).channelRegistry.resolveLocus = () => null; };
    const first = await make({ deliver: false });
    noLocus(first);
    await wake(first, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
    first.mod.endTurn = true;
    await timerWake(first,
      signed('sig-c', 'checking', [{ type: 'tool_use', id: 'c-t1', name: 'tools--ping', input: {} } as ContentBlock]));
    const prompt = rowWith(first.framework, 'checking').metadata?.promptedBy;
    assert.ok(prompt);
    await first.framework.stop();

    const strategy = new OmitToolExchange();
    strategy.omit = false;
    const x = await make({ deliver: false, dir: first.dir, agent: { strategy } });
    noLocus(x);
    try {
      await timerWake(x, signed('sig-c2', 'picked up'));
      assert.ok(x.membrane.calls[0]!.messages.at(-1)!.content.some((b) => b.type === 'tool_result'));
      assert.deepEqual(rowWith(x.framework, 'picked up').metadata?.promptedBy, prompt);

      strategy.omit = true;
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));
      const later = x.membrane.calls[1]!.messages;
      assert.equal(textOf(later[later.findIndex((m) => textOf(m) === 'picked up') - 1]!), '[Continue]');
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });

  it('renders [Continue] before the first SURVIVING row when a strategy drops the reply\'s tool exchange', async () => {
    const x = await make({ deliver: false, agent: { strategy: new OmitToolExchange() } });
    try {
      await wake(x, ordinaryEvent('hello'), signed('sig-1', 'first reply'));
      await timerWake(x,
        signed('sig-c', 'checking', [{ type: 'tool_use', id: 'c-t1', name: 'tools--ping', input: {} } as ContentBlock]),
        signed('sig-c2', 'all done'));
      await wake(x, ordinaryEvent('later'), signed('sig-later', 'later reply'));

      const later = x.membrane.calls[2]!.messages;
      assert.ok(!later.some((m) => textOf(m) === 'checking'), 'the strategy dropped the tool round');
      const finalAt = later.findIndex((m) => textOf(m) === 'all done');
      assert.equal(textOf(later[finalAt - 1]!), '[Continue]');
      assert.equal(later.filter((m) => textOf(m) === '[Continue]').length, 1);
      for (const message of wire(x.membrane.calls[2]!)) {
        assert.ok(signatures(message).length <= 1,
          `one ${message.role} message carries signed thinking from: ${signatures(message).join(', ')}`);
      }
    } finally { await x.framework.stop(); rmSync(x.dir, { recursive: true, force: true }); }
  });
});
