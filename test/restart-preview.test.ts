import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, PassthroughStrategy } from '@animalabs/context-manager';
import type { ContextInjection } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { AgentConfig, EventResponse, Module, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const ROUNDS = 12;
const PAGE = 'page text '.repeat(400);
const SUMMARY = 'Recollection of the pages read so far.';
const FINAL = 'All pages read.';

const page = (n: number) => `[r${n}] ${PAGE}`;
const pages = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
const requestText = (request: NormalizedRequest) => JSON.stringify(request.messages ?? []);
const wholePagesIn = (request: NormalizedRequest, count = ROUNDS) => {
  const text = requestText(request);
  return pages(count).filter((n) => text.includes(JSON.stringify(page(n)).slice(1, -1)));
};
class PagesModule implements Module {
  readonly name = 'pages';
  calls = 0;
  starts = 0;
  onCall: ((call: number) => void | Promise<void>) | undefined;
  injectAt: ((start: number) => ContextInjection[]) | undefined;
  constructor(private readonly awaitAtResultMs = 0) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'read', description: 'Read the next page', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    this.calls++;
    await this.onCall?.(this.calls);
    return { success: true, data: page(this.calls) };
  }
  async gatherContext(): Promise<ContextInjection[]> {
    return this.injectAt?.(++this.starts) ?? [];
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'tool-result' && this.awaitAtResultMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.awaitAtResultMs));
    }
    if (event.type !== 'external-message') return {};
    const { content } = event as unknown as { content: ContentBlock[] };
    return { addMessages: [{ participant: 'User', content }], requestInference: true };
  }
}

const estimatedTokens = (value: unknown) => Math.ceil(JSON.stringify(value ?? null).length / 4);

// A provider with a context window: once a stream's request, grown by the results sent into it, is past the
// window, the provider refuses it as too long.
class WindowStream extends MockYieldingStream {
  refusedAt?: number;
  protected size: number;
  constructor(responses: NormalizedResponse[], request: NormalizedRequest, private readonly window: number) {
    super(responses);
    this.size = estimatedTokens(request.messages);
  }
  override provideToolResults(results: unknown[], options?: { injectedMessages?: Array<{ participant?: string; content: unknown[] }> }): void {
    this.size += estimatedTokens(results);
    super.provideToolResults(results, options);
  }
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) {
      if (this.size > this.window) {
        this.refusedAt = this.size;
        yield {
          type: 'error',
          error: new MembraneError({
            type: 'context_length', retryable: false, httpStatus: 400, providerErrorCode: 'context_length_exceeded',
            message: `This model's maximum context length is ${this.window} tokens; the request has ${this.size}.`,
            rawError: { status: 400 },
          }),
        } as StreamEvent;
        return;
      }
      yield next.value;
    }
  }
}

class TurnMembrane extends MockMembrane {
  readonly streams: NormalizedRequest[] = [];
  readonly windowStreams: WindowStream[] = [];
  constructor(private readonly queues: NormalizedResponse[][], private readonly window?: number) {
    super();
  }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.streams.push(request);
    const responses = this.queues.shift() ?? [];
    if (this.window !== undefined) {
      const stream = new WindowStream(responses, request, this.window);
      this.windowStreams.push(stream);
      return stream;
    }
    return new MockYieldingStream(responses);
  }
  override async complete(): Promise<NormalizedResponse> {
    return createMockResponse([{ type: 'text', text: SUMMARY }]);
  }
}

function toolRounds(count: number, lastPromptTokens: number): NormalizedResponse[] {
  const rounds: NormalizedResponse[] = [];
  let cacheRead = 0;
  for (let round = 1; round <= count; round++) {
    const response = createMockResponse([
      { type: 'text', text: `Reading page ${round}.` },
      { type: 'tool_use', id: `read_${round}`, name: 'pages--read', input: {} },
    ], 'tool_use');
    cacheRead += round < count ? 1_000 + round * 1_100 : lastPromptTokens;
    (response as { usage: unknown }).usage = { inputTokens: 3 * round, outputTokens: 20 * round, cacheReadTokens: cacheRead };
    rounds.push(response);
  }
  return rounds;
}

const answer = (text: string) => createMockResponse([{ type: 'text', text }]);

type Kind = 'kv-stable' | 'hierarchical' | 'kv-unified';

function strategy(kind: Kind = 'hierarchical', recentWindowTokens = 2_000): AutobiographicalStrategy {
  const base = { compressionModel: 'test-compression-model', targetChunkTokens: 1_000, recentWindowTokens, autoTickOnNewMessage: true };
  if (kind === 'hierarchical') return new AutobiographicalStrategy(base);
  if (kind === 'kv-stable') return new AutobiographicalStrategy({ ...base, adaptiveResolution: true, foldingStrategy: 'kv-stable' });
  return new AutobiographicalStrategy({
    ...base,
    adaptiveResolution: true,
    foldingStrategy: 'kv-unified',
    headWindowTokens: 0,
    kvUnified: {
      policy: {
        alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
        cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25,
        continuityLambda: 1, continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
        continuityStableHalfLife: 10, continuityStableFloor: 0.25,
      },
      tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
      treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: true,
    },
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
}

const agentConfig = (extra: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'prime',
  model: 'test-model',
  systemPrompt: 'You are prime.',
  allowedTools: 'all',
  maxTokens: 4_000,
  contextBudgetTokens: 60_000,
  physicalWindowTokens: 200_000,
  strategy: strategy(),
  ...extra,
});

async function waitUntil(label: string, condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withFramework(
  membrane: MockMembrane,
  module: PagesModule,
  agent: AgentConfig,
  run: (framework: AgentFramework, traces: TraceEvent[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'restart-preview-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [agent],
    modules: [module],
    syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  try {
    framework.start();
    await run(framework, traces);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function ask(framework: AgentFramework): void {
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text: 'Read the pages, please.' }],
    triggerInference: true,
  } as unknown as ProcessEvent);
}

function storedText(framework: AgentFramework): string {
  const messages = framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? [];
  return JSON.stringify(messages.map((message) => message.content));
}

function failureRows(framework: AgentFramework): Array<Record<string, unknown>> {
  const messages = framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? [];
  return messages
    .map((message) => (message.metadata ?? {}) as Record<string, unknown>)
    .filter((metadata) => metadata.kind === 'inference-failed');
}

function compressHistory(framework: AgentFramework, count: number): string[] {
  const cm = framework.getAgent('prime')!.getContextManager();
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) ids.push(cm.addMessage(i % 2 === 1 ? 'User' : 'prime', [{ type: 'text', text: `[h${i}] ${PAGE}` }]));
  return ids;
}

async function drain(framework: AgentFramework, ticks: number): Promise<void> {
  const cm = framework.getAgent('prime')!.getContextManager();
  for (let tick = 0; tick < ticks && cm.getPendingWork(); tick++) await cm.tick();
  assert.equal(cm.getPendingWork(), null, 'the history before the turn is compressed');
}

const restarted = (traces: TraceEvent[]) => traces.filter((event) => event.type === 'inference:stream_restarted');

for (const kind of ['kv-stable', 'kv-unified'] satisfies Kind[]) {
  test(`a maxStreamTokens restart is taken when its preview fits under ${kind}, and the turn answers on the restarted stream`, async () => {
    const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
    const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 26_000, physicalWindowTokens: undefined, strategy: strategy(kind) });
    await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
      compressHistory(framework, 16);
      await drain(framework, 300);
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.') || failureRows(framework).length > 0);
      assert.equal((restarted(traces)[0] as { reason?: string } | undefined)?.reason, 'context_budget', 'the turn restarted');
      assert.equal(membrane.streams.length, 2, 'the restart sent its request');
      assert.ok(requestText(membrane.streams[1]).includes(SUMMARY), "the restart's request holds the history's summaries");
      assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
      assert.deepEqual(failureRows(framework), [], "the restart's compile didn't refuse");
    });
  });
}

test('a maxStreamTokens restart declined at one boundary is taken at a later one, once its preview fits, under kv-unified', async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 26_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified') });
  const module = new PagesModule();
  await withFramework(membrane, module, agent, async (framework, traces) => {
    const cm = framework.getAgent('prime')!.getContextManager();
    const history = compressHistory(framework, 30);
    await drain(framework, 600);
    module.onCall = (call) => {
      if (call === 1) cm.holdCompression([history[0]]);
      if (call === 5) cm.releaseCompression([history[0]]);
    };
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.') || failureRows(framework).length > 0);
    assert.equal(restarted(traces).length, 1, 'the turn restarted once');
    assert.deepEqual(wholePagesIn(membrane.streams[1], 6), pages(5), 'the turn restarted at the boundary after the release');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
    assert.deepEqual(failureRows(framework), [], "the restart's compile didn't refuse");
  });
});

class ThrowingPreviewStrategy extends AutobiographicalStrategy {
  previews = 0;
  constructor(private readonly error: Error, adaptiveResolution = true) {
    super({ compressionModel: 'test-compression-model', targetChunkTokens: 1_000, recentWindowTokens: 2_000, adaptiveResolution });
  }
  override previewContext(): never {
    this.previews++;
    throw this.error;
  }
}

test('a maxStreamTokens restart is skipped when the preview throws an unexpected error, and the turn goes on', async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer(FINAL)], [answer('Done on a restarted stream.')]]);
  const strategy = new ThrowingPreviewStrategy(new Error('the preview failed'));
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    consoleError(...args);
  };
  try {
    await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on a restarted stream.') || failureRows(framework).length > 0);
      assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
      assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
      assert.equal(restarted(traces).length, 0, 'no restart');
      assert.ok(strategy.previews > 0, 'the restart decision asked for the preview');
    });
  } finally {
    console.error = consoleError;
  }
  assert.ok(logged.some((line) => line.includes("the restart's preview failed, so the stream goes on") && line.includes('the preview failed')),
    'the decline on an unexpected throw is logged');
});

class NullPreviewStrategy extends AutobiographicalStrategy {
  previews = 0;
  override previewContext(): ReturnType<AutobiographicalStrategy['previewContext']> {
    this.previews++;
    return null as unknown as ReturnType<AutobiographicalStrategy['previewContext']>;
  }
}

// context-manager 0.23.0 throws this plain Error on the hierarchical path once the dry select has succeeded;
// 0.23.1 returns null there. Both say the compile fits.
for (const { answer: preview, strategy: make } of [
  { answer: "0.23.0's plain Error", strategy: () => new ThrowingPreviewStrategy(new Error('previewContext requires adaptiveResolution; the hierarchical path has no fold plan to preview'), false) },
  { answer: "0.23.1's null", strategy: () => new NullPreviewStrategy({ compressionModel: 'test-compression-model', targetChunkTokens: 1_000, recentWindowTokens: 2_000 }) },
]) {
  test(`a maxStreamTokens restart is taken when the hierarchical preview answers with ${preview}`, async () => {
    const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
    const strategy = make();
    const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
    await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.'));
      assert.ok(strategy.previews > 0, 'the restart decision asked for the preview');
      assert.equal((restarted(traces)[0] as { reason?: string } | undefined)?.reason, 'context_budget', 'the turn restarted');
      assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
    });
  });
}

test('a maxStreamTokens restart is taken as before under a strategy with no preview', async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
  const agent = agentConfig({ maxStreamTokens: 10, physicalWindowTokens: undefined, strategy: new PassthroughStrategy() });
  await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.'));
    assert.equal((restarted(traces)[0] as { reason?: string } | undefined)?.reason, 'context_budget', 'the turn restarted');
    assert.equal(membrane.streams.length, 2, 'the restart sent its request');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
    assert.deepEqual(failureRows(framework), [], "the restart's compile didn't refuse");
  });
});

for (const kind of ['hierarchical', 'kv-stable', 'kv-unified'] satisfies Kind[]) {
  test(`a maxStreamTokens restart whose preview can't fit is skipped, and the turn goes on, under ${kind}`, async () => {
    const membrane = new TurnMembrane([[...toolRounds(ROUNDS, 4_000), answer(FINAL)]]);
    const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 8_000, physicalWindowTokens: undefined, strategy: strategy(kind) });
    await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || failureRows(framework).length > 0);
      assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
      assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
      assert.equal(restarted(traces).length, 0, 'no restart');
    });
  });
}

test("the restart's preview is given the thinking binding its compile is given, for a model that binds its thinking", async () => {
  const membrane = new TurnMembrane([[...toolRounds(ROUNDS, 4_000), answer(FINAL)]]);
  const agent = agentConfig({
    maxStreamTokens: 10, contextBudgetTokens: 8_000, physicalWindowTokens: undefined, strategy: strategy('kv-stable'), thinkingBinding: { binds: true },
  });
  await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    const cm = framework.getAgent('prime')!.getContextManager();
    const preview = cm.previewContext.bind(cm);
    const options: unknown[] = [];
    cm.previewContext = (...args: Parameters<typeof preview>) => {
      options.push(args[2]);
      return preview(...args);
    };
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || failureRows(framework).length > 0);
    assert.ok(options.length > 0, 'the restart decision asked for the preview');
    for (const option of options) {
      const binding = (option as { thinkingBinding?: { binds?: boolean; participant?: string } } | undefined)?.thinkingBinding;
      assert.equal(binding?.binds, true, 'the preview was given the binding');
      assert.equal(binding?.participant, 'prime', "the binding names the agent as the participant whose messages it binds");
    }
    assert.equal(restarted(traces).length, 0, 'no restart');
    assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
  });
});

test(`on a host that sets no window, a maxStreamTokens restart whose preview can't fit is skipped under kv-unified, and the turn goes on until the provider refuses a request as too long, then ends with its failure row`, async () => {
  const membrane = new TurnMembrane([[...toolRounds(ROUNDS, 4_000), answer(FINAL)]], 9_000);
  const module = new PagesModule();
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 8_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified') });
  await withFramework(membrane, module, agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 60_000);
    assert.equal(restarted(traces).length, 0, 'no restart');
    assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
    assert.ok(membrane.windowStreams[0]?.refusedAt !== undefined, 'the provider refused a request past its window');
    assert.ok(module.calls > 4, `the turn went on past the boundaries where the restart was considered (calls: ${module.calls})`);
    assert.ok(!storedText(framework).includes(FINAL), 'the turn did not answer');
    assert.equal(failureRows(framework)[0]?.errorType, 'context_length', "the turn ended with the provider's refusal as its failure row");
  });
});

// A long agentic turn, its stream's usage reporting each call's request size, summed over the stream's calls as
// membrane's usage events are. Each stream takes the turn's remaining rounds, so a restart goes on where the turn was.
class SizedWindowStream extends WindowStream {
  private inputTokens = 0;
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    for await (const event of super[Symbol.asyncIterator]()) {
      if ((event as { type: string }).type !== 'usage') {
        yield event;
        continue;
      }
      this.inputTokens += this.size;
      yield { ...(event as object), usage: { inputTokens: this.inputTokens, outputTokens: 20 } } as unknown as StreamEvent;
    }
  }
}

class LongTurnMembrane extends MockMembrane {
  readonly streams: NormalizedRequest[] = [];
  readonly callsAtStart: number[] = [];
  readonly windowStreams: SizedWindowStream[] = [];
  constructor(private readonly rounds: NormalizedResponse[], private readonly module: PagesModule, private readonly window: number) {
    super();
  }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.streams.push(request);
    this.callsAtStart.push(this.module.calls);
    const stream = new SizedWindowStream(this.rounds.slice(this.module.calls), request, this.window);
    this.windowStreams.push(stream);
    return stream;
  }
  override async complete(): Promise<NormalizedResponse> {
    return createMockResponse([{ type: 'text', text: SUMMARY }]);
  }
}

function longTurn(count: number): NormalizedResponse[] {
  const rounds = [...toolRounds(count, 0), answer(FINAL)];
  for (const round of rounds) (round as { usage: unknown }).usage = { inputTokens: 1, outputTokens: 20 };
  return rounds;
}

test("under kv-unified, a restart past the budget whose compile can't fit, since nothing of the turn has been summarised, is declined, and the turn goes on to its answer", async () => {
  const module = new PagesModule();
  const membrane = new LongTurnMembrane(longTurn(30), module, 40_000);
  const agent = agentConfig({ maxStreamTokens: 8_000, contextBudgetTokens: 20_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified', 6_000) });
  await withFramework(membrane, module, agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 120_000);
    assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
    assert.ok(restarted(traces).length > 0, 'restarts were taken while their compiles fit');
    assert.ok(!requestText(membrane.streams[membrane.streams.length - 1]).includes(SUMMARY), "the last stream's request holds no summary of the turn");
  });
});

test('under kv-unified, with a module awaiting at each tool result, restarts whose compiles fold the turn\'s older rounds are taken, and a turn longer than the provider\'s window answers', async () => {
  const module = new PagesModule(50);
  const membrane = new LongTurnMembrane(longTurn(40), module, 30_000);
  const agent = agentConfig({ maxStreamTokens: 8_000, contextBudgetTokens: 20_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified', 6_000) });
  await withFramework(membrane, module, agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 180_000);
    assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
    assert.ok(restarted(traces).length > 0, 'the turn restarted');
    assert.ok(estimatedTokens(pages(40).map(page)) > 30_000, "the turn's results alone are longer than the provider's window");
    const last = membrane.streams[membrane.streams.length - 1];
    assert.ok(requestText(last).includes(SUMMARY), "the last stream's request holds summaries of the turn's older rounds");
    const newest = membrane.callsAtStart[membrane.streams.length - 1];
    assert.ok(wholePagesIn(last, 40).includes(newest), `the last stream's request holds the turn's newest result, page ${newest}, whole`);
  });
});
