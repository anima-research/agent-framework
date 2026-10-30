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
  endTurnAt: number | undefined;
  async handleToolCall(): Promise<ToolResult> {
    this.calls++;
    await this.onCall?.(this.calls);
    return { success: true, data: page(this.calls), ...(this.calls === this.endTurnAt ? { endTurn: true } : {}) };
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
type Declined = Extract<TraceEvent, { type: 'inference:restart_declined' }>;
const declined = (traces: TraceEvent[]) => traces.filter((event): event is Declined => event.type === 'inference:restart_declined');

const HIERARCHICAL_REFUSAL = 'previewContext requires adaptiveResolution; the hierarchical path has no fold plan to preview';

// What a strategy built from another copy of context-manager throws: an error whose class isn't this copy's, with
// that copy's name and message.
function errorFromAnotherCopy(name: string, message: string): Error {
  const error = new (class extends Error {})(message);
  error.name = name;
  return error;
}

async function loggedDuring(run: (logged: readonly string[]) => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    consoleError(...args);
  };
  try {
    await run(logged);
  } finally {
    console.error = consoleError;
  }
  return logged;
}

type Preview = { args: unknown[]; fits: boolean | undefined; answeredNull?: boolean; finalTokens?: number; budgetTokens?: number };
function recordPreviews(framework: AgentFramework): Preview[] {
  const cm = framework.getAgent('prime')!.getContextManager();
  const preview = cm.previewContext.bind(cm);
  const previews: Preview[] = [];
  cm.previewContext = (...args: Parameters<typeof preview>) => {
    const asked: Preview = { args, fits: undefined };
    previews.push(asked);
    const answer = preview(...args);
    Object.assign(asked, { fits: answer?.fits, answeredNull: answer === null, finalTokens: answer?.finalTokens, budgetTokens: answer?.budgetTokens });
    return answer;
  };
  return previews;
}

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

test('a maxStreamTokens restart is declined when the preview throws an unexpected error, and the turn goes on', async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer(FINAL)], [answer('Done on a restarted stream.')]]);
  const strategy = new ThrowingPreviewStrategy(new Error('the preview failed'));
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
  const logged = await loggedDuring(() => withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on a restarted stream.') || failureRows(framework).length > 0);
    assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
    assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
    assert.equal(restarted(traces).length, 0, 'no restart');
    assert.ok(declined(traces).length > 0, 'each boundary that declined the restart said so');
    for (const decline of declined(traces)) {
      assert.equal(decline.reason, 'preview_error', 'the decline names the failed preview');
      assert.equal(decline.previewed, true, 'a failed preview is asked again at each boundary');
    }
    assert.equal(strategy.previews, declined(traces).length, 'the restart decision asked for the preview at each boundary past the budget');
  }));
  assert.equal(logged.filter((line) => line.includes("the restart's preview failed, so the maxStreamTokens restart is declined") && line.includes('the preview failed')).length,
    strategy.previews, 'each failed preview is logged');
});

test("a maxStreamTokens restart is declined, with no log, when the preview throws another context-manager copy's UncoveredDropError", async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer(FINAL)], [answer('Done on a restarted stream.')]]);
  const strategy = new ThrowingPreviewStrategy(errorFromAnotherCopy('UncoveredDropError', 'the select drops messages no summary covers'));
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
  const logged = await loggedDuring(() => withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on a restarted stream.') || failureRows(framework).length > 0);
    assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
    assert.equal(restarted(traces).length, 0, 'no restart');
    assert.ok(declined(traces).length > 0, 'each boundary that declined the restart said so');
    for (const decline of declined(traces)) assert.equal(decline.reason, 'uncovered_drop', 'the decline names the uncovered drop');
  }));
  assert.ok(!logged.some((line) => line.includes("the restart's preview failed")), 'an uncovered drop is not logged as a failed preview');
});

test("where the window projection restarts the stream, the restart is the window's, with no preview asked and no decline reported", async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
  const strategy = new ThrowingPreviewStrategy(new Error('the preview failed'));
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: 10_000, strategy });
  const logged = await loggedDuring(() => withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.') || failureRows(framework).length > 0);
    const restart = restarted(traces)[0] as { reason?: string; inputTokens?: number; budget?: number } | undefined;
    assert.equal(restart?.reason, 'physical_window', 'the window projection restarted the stream');
    assert.equal(restart?.budget, 10_000, "the trace's budget is physicalWindowTokens");
    assert.ok((restart?.inputTokens ?? 0) > 10_000, `its inputTokens is the projection past the window (${restart?.inputTokens})`);
    const logged = framework.queryInferenceLogs({ agentName: 'prime' }).entries.map((entry) => entry.entry.stopReason);
    assert.ok(logged.includes('physical_window'), `the stream's inference-log entry records physical_window (${logged.join(', ')})`);
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
    assert.equal(strategy.previews, 0, 'the restart decision asked for no preview');
    assert.deepEqual(declined(traces), [], 'no decline was reported');
  }));
  assert.ok(!logged.some((line) => line.includes("the restart's preview failed")), 'nothing logged a decline');
});

test("a boundary whose tool result ends the turn asks for no restart preview", async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer(FINAL)], [answer('Done on a restarted stream.')]]);
  const strategy = new ThrowingPreviewStrategy(new Error('the preview failed'));
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
  const module = new PagesModule();
  module.endTurnAt = 5;
  await loggedDuring(() => withFramework(membrane, module, agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => traces.some((event) => event.type === 'inference:turn_ended') || failureRows(framework).length > 0);
    assert.equal(module.calls, 5, 'the turn ended at the tool result that asked it to');
    assert.equal(strategy.previews, 1, 'only the boundary past the budget before it asked for the preview');
    assert.equal(declined(traces).length, 1, 'and only it declined the restart');
  }));
});

class ScriptedPreviewStrategy extends AutobiographicalStrategy {
  previews = 0;
  readiness: ReturnType<AutobiographicalStrategy['checkReadiness']> = { ready: true };
  compressionCount = 0;
  reportsStats: boolean | 'none of the counts' = true;
  constructor(private readonly answer: (budget: { maxTokens: number; reserveForResponse: number }, ask: number) => { fits: boolean; clearedBy?: string[] }) {
    super({ compressionModel: 'test-compression-model', targetChunkTokens: 1_000, recentWindowTokens: 2_000, adaptiveResolution: true });
  }
  override previewContext(...args: unknown[]): ReturnType<AutobiographicalStrategy['previewContext']> {
    const { fits, clearedBy } = this.answer(args[2] as { maxTokens: number; reserveForResponse: number }, ++this.previews);
    return { fits, ...(clearedBy ? { clearedBy } : {}), finalTokens: fits ? 1_000 : 9_000, budgetTokens: 8_000 } as unknown as ReturnType<AutobiographicalStrategy['previewContext']>;
  }
  override checkReadiness(): ReturnType<AutobiographicalStrategy['checkReadiness']> {
    return this.readiness;
  }
  override getStats(): ReturnType<AutobiographicalStrategy['getStats']> {
    if (this.reportsStats === 'none of the counts') return {} as unknown as ReturnType<AutobiographicalStrategy['getStats']>;
    return this.reportsStats ? { ...super.getStats(), compressionCount: this.compressionCount }
      : undefined as unknown as ReturnType<AutobiographicalStrategy['getStats']>;
  }
}

test('a restart declined since a newer message would make room is previewed again at the next boundary, and taken once it fits', async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
  const strategy = new ScriptedPreviewStrategy((_, ask) => (ask === 1 ? { fits: false, clearedBy: ['newer-message'] } : { fits: true, clearedBy: [] }));
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
  await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.') || failureRows(framework).length > 0);
    assert.deepEqual(declined(traces).map((decline) => [decline.clearedBy, decline.previewed]), [[['newer-message'], true]], 'one boundary declined');
    assert.equal(strategy.previews, 2, 'the next boundary asked again');
    assert.equal(restarted(traces).length, 1, 'and restarted');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
  });
});

for (const { what, clearedBy } of [
  { what: 'the budget it was given changes', clearedBy: ['compression'] },
  { what: 'a compression hold is released', clearedBy: [] },
  { what: 'a live context setting changes', clearedBy: ['smaller-recent-window'] },
  { what: 'the budget it was given changes, for a strategy that gives no clearedBy', clearedBy: undefined },
  { what: "the pending compression work of a strategy that reports no counts changes", clearedBy: ['compression'] },
  { what: "the pending compression work of a strategy whose stats hold none of the counts changes", clearedBy: ['compression'] },
  { what: 'a compression lands', clearedBy: ['compression'] },
  { what: "a compression lands, after a decline that named no way to make room while compression work was pending (an empty clearedBy isn't final)", clearedBy: [] },
  { what: 'a stored row is edited', clearedBy: ['compression'] },
  { what: 'a stored row is removed', clearedBy: ['compression'] },
] as const) {
  test(`a restart declined for a reason a newer message can't clear is previewed again once ${what}, and taken once it fits`, async () => {
    const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
    let changed = false;
    const strategy = new ScriptedPreviewStrategy(() => (changed ? { fits: true, clearedBy: [] } : { fits: false, ...(clearedBy ? { clearedBy: [...clearedBy] } : {}) }));
    const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy });
    const module = new PagesModule();
    await withFramework(membrane, module, agent, async (framework, traces) => {
      const prime = framework.getAgent('prime')!;
      const cm = prime.getContextManager();
      let reserve = 20_000;
      Object.defineProperty(prime.toolResultGuard, 'pendingWireReserveTokens', { get: () => reserve });
      const [held] = compressHistory(framework, 1);
      cm.holdCompression([held]);
      const stored = what.startsWith('a stored row') ? cm.addMessage('User', [{ type: 'text', text: `[x] ${PAGE}` }]) : undefined;
      strategy.readiness = { ready: false, description: 'Compressing chunk 0' };
      strategy.reportsStats = what === "the pending compression work of a strategy that reports no counts changes" ? false
        : what === "the pending compression work of a strategy whose stats hold none of the counts changes" ? 'none of the counts' : true;
      module.onCall = (call) => {
        if (call !== 6) return;
        changed = true;
        if (what.startsWith('the budget it was given changes')) reserve = 0;
        else if (what === 'a compression hold is released') cm.releaseCompression([held]);
        else if (what === 'a live context setting changes') cm.updateHotContextSettings({ tailTokens: 1_000 });
        else if (what.startsWith('the pending compression work')) strategy.readiness = { ready: false, description: 'Compressing chunk 1' };
        else if (what === 'a stored row is edited') cm.editMessage(stored!, [{ type: 'text', text: '[x] a line' }]);
        else if (what === 'a stored row is removed') cm.removeMessage(stored!);
        else strategy.compressionCount++;
      };
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.') || failureRows(framework).length > 0);
      assert.deepEqual(declined(traces).map((decline) => decline.previewed), [true, false], 'the 4th boundary declined, the 5th took its answer');
      assert.equal(strategy.previews, 2, `the 6th boundary, once ${what}, asked again`);
      assert.equal(restarted(traces).length, 1, 'and restarted');
      assert.ok(storedText(framework).includes(FINAL), 'the turn answered on the restarted stream');
    });
  });
}

// On the hierarchical path, once the dry select has succeeded, this copy of context-manager answers null. A strategy
// built from another copy throws that copy's refusal, which this copy's ContextManager doesn't turn into null: a
// 0.23.1 copy's NoFoldPlanToPreviewError, or 0.23.0's plain Error. Each says the compile fits.
for (const { answer: preview, strategy: make, answersNull } of [
  { answer: "a 0.23.0 copy's plain Error", strategy: () => new ThrowingPreviewStrategy(new Error(HIERARCHICAL_REFUSAL), false) },
  { answer: "another 0.23.1 copy's NoFoldPlanToPreviewError", strategy: () => new ThrowingPreviewStrategy(errorFromAnotherCopy('NoFoldPlanToPreviewError', 'zz a copy whose refusal reads otherwise'), false) },
  { answer: "this copy's NoFoldPlanToPreviewError, which its ContextManager answers as null", strategy: () => strategy('hierarchical'), answersNull: true },
] as Array<{ answer: string; strategy: () => AutobiographicalStrategy; answersNull?: true }>) {
  test(`a maxStreamTokens restart is taken when the hierarchical preview answers with ${preview}`, async () => {
    const nullAnswered = answersNull === true;
    const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
    const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, physicalWindowTokens: undefined, strategy: make() });
    await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
      const previews = recordPreviews(framework);
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.'));
      assert.ok(previews.length > 0, 'the restart decision asked for the preview');
      if (nullAnswered) assert.ok(previews.every((asked) => asked.answeredNull), 'its ContextManager answered null');
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
  test(`a maxStreamTokens restart whose preview can't fit is declined, and the turn goes on, under ${kind}, each boundary saying why`, async () => {
    const membrane = new TurnMembrane([[...toolRounds(ROUNDS, 4_000), answer(FINAL)]]);
    const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 8_000, physicalWindowTokens: undefined, strategy: strategy(kind) });
    const module = new PagesModule();
    await withFramework(membrane, module, agent, async (framework, traces) => {
      const previews = recordPreviews(framework);
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || failureRows(framework).length > 0);
      assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
      assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
      assert.equal(restarted(traces).length, 0, 'no restart');
      const declines = declined(traces);
      assert.equal(declines.length, module.calls - 3, 'every boundary past maxStreamTokens declined the restart and said so');
      let latest: Preview | undefined;
      let asked = 0;
      for (const decline of declines) {
        assert.equal(decline.reason, 'wont_fit', "the decline says the restart's compile won't fit");
        assert.ok(decline.inputTokens > decline.maxStreamTokens, 'it names the count past maxStreamTokens');
        if (decline.previewed) latest = previews[asked++];
        assert.ok(latest !== undefined && latest.fits === false, 'the decline rests on a preview that said no');
        assert.equal(decline.finalTokens, latest.finalTokens, "it carries that preview's size");
        assert.equal(decline.budgetTokens, latest.budgetTokens, "and that preview's budget");
      }
      assert.equal(asked, previews.length, 'every preview asked was a decline that said so');
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

test("the restart's preview is given the budget the restart's compile is given, the agent's maxTokens and a pending tool-result reserve included", async () => {
  const membrane = new TurnMembrane([[...toolRounds(6, 4_000), answer('Done on the first stream.')], [answer(FINAL)]]);
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 60_000, maxTokens: 3_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified') });
  await withFramework(membrane, new PagesModule(), agent, async (framework, traces) => {
    const prime = framework.getAgent('prime')!;
    Object.defineProperty(prime.toolResultGuard, 'pendingWireReserveTokens', { get: () => 1_234 });
    const previews = recordPreviews(framework);
    const cm = prime.getContextManager();
    const compile = cm.compile.bind(cm);
    const compiled: unknown[] = [];
    cm.compile = ((...args: Parameters<typeof compile>) => {
      compiled.push(args[0]);
      return compile(...args);
    }) as typeof cm.compile;
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || storedText(framework).includes('Done on the first stream.') || failureRows(framework).length > 0);
    assert.equal(restarted(traces).length, 1, 'the turn restarted');
    const budget = { maxTokens: 60_000, reserveForResponse: 3_000 + 1_234 };
    assert.ok(previews.length > 0, 'the restart decision asked for the preview');
    for (const preview of previews) assert.deepEqual(preview.args[0], budget, 'the preview was given the compile budget');
    assert.ok(compiled.length >= 2, 'the turn compiled at its start and at the restart');
    for (const given of compiled) assert.deepEqual(given, budget, "each compile, the restart's included, was given the same budget");
  });
});

test(`on a host that sets no window, a maxStreamTokens restart whose preview can't fit is declined under kv-unified, and the turn goes on until the provider refuses a request as too long, then ends with its failure row, the context-refusal alert and the drain`, async () => {
  const membrane = new TurnMembrane([[...toolRounds(ROUNDS, 4_000), answer(FINAL)]], 9_000);
  const module = new PagesModule();
  const agent = agentConfig({ maxStreamTokens: 10, contextBudgetTokens: 8_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified') });
  const logged = await loggedDuring((lines) => withFramework(membrane, module, agent, async (framework, traces) => {
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 60_000);
    assert.equal(restarted(traces).length, 0, 'no restart');
    assert.ok(declined(traces).length > 0, 'the restart was declined');
    assert.equal(membrane.streams.length, 1, 'the turn ran on one stream');
    assert.ok(membrane.windowStreams[0]?.refusedAt !== undefined, 'the provider refused a request past its window');
    assert.ok(module.calls > 4, `the turn went on past the boundaries where the restart was considered (calls: ${module.calls})`);
    assert.ok(!storedText(framework).includes(FINAL), 'the turn did not answer');
    assert.equal(failureRows(framework)[0]?.errorType, 'context_length', "the turn ended with the provider's refusal as its failure row");
    const refusals = (traces.filter((event) => event.type === 'ops:alert') as Array<{ kind?: string; message?: string }>)
      .filter((alert) => alert.kind === 'context-refusal');
    assert.equal(refusals.length, 1, 'the ending raised the context-refusal alert');
    assert.ok(refusals[0]?.message?.includes('restart was declined'), 'the alert says the restart was declined');
    assert.ok(refusals[0]?.message?.includes('physicalWindowTokens'), 'and advises physicalWindowTokens');
    await waitUntil('the drain to end', () => lines.some((line) => line.includes('drain kicked for prime')));
  }));
  assert.ok(logged.some((line) => line.includes('drain kicked for prime')), 'the ending kicked the compression drain');
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
    assert.ok(declined(traces).length > 0, 'and declined once they no longer fit');
    assert.ok(declined(traces).every((decline) => decline.reason === 'wont_fit'), "each decline says the restart's compile won't fit");
    assert.ok(traces.findIndex((event) => event.type === 'inference:stream_restarted') < traces.findIndex((event) => event.type === 'inference:restart_declined'),
      'the first decline came after a restart');
    assert.ok(!requestText(membrane.streams[membrane.streams.length - 1]).includes(SUMMARY), "the last stream's request holds no summary of the turn");
  });
});

test("under kv-unified, a restart declined since only compression would make room isn't previewed again at that stream's later boundaries while no compression lands", async () => {
  const module = new PagesModule();
  const membrane = new LongTurnMembrane(longTurn(30), module, 40_000);
  const agent = agentConfig({ maxStreamTokens: 8_000, contextBudgetTokens: 20_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified', 6_000) });
  await withFramework(membrane, module, agent, async (framework, traces) => {
    const previews = recordPreviews(framework);
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 120_000);
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
    const declines = declined(traces);
    assert.ok(declines.length > 1, `the restart was declined at more than one boundary (${declines.length})`);
    assert.deepEqual(declines[0]?.clearedBy, ['compression'], 'only compression would make room');
    assert.equal(declines[0]?.previewed, true, 'the first decline previewed');
    assert.ok(declines.slice(1).every((decline) => !decline.previewed), 'the later declines took its answer');
    const declining = previews.find((preview) => preview.fits === false);
    assert.ok(declines.every((decline) => decline.finalTokens === declining?.finalTokens && decline.budgetTokens === declining?.budgetTokens),
      "with the figures of the preview it took");
    assert.equal(previews.filter((preview) => preview.fits === false).length, 1, 'one preview declined');
    assert.equal(previews.length, restarted(traces).length + 1, 'every other preview was a restart that fit');
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

// The pin a turn holds on its opening rows (the framework's turn-inputs pin) beside the restart's preview: the
// preview asks whether the restart's compile would fit with that pin left out, and releases nothing. A declined
// restart keeps the pin; a taken one's compile drops it only by refusing with it held.
const TURN_INPUTS = 'agent-framework:turn-inputs';
const turnPins = (framework: AgentFramework) =>
  framework.getAgent('prime')!.getContextManager().listPins().filter((pin) => pin.name === TURN_INPUTS);
const excludedBy = (preview: Preview) => (preview.args[2] as { excludePins?: readonly string[] } | undefined)?.excludePins;
const UNPINNED_AND_COMPILED_AGAIN = "the compile refused with the turn's inputs pinned";

test("under kv-unified, a restart whose compile fits only with the turn's opening rows unpinned is taken, and its compile drops the pin by refusing with it", async () => {
  const module = new PagesModule();
  const membrane = new LongTurnMembrane(longTurn(30), module, 36_000);
  const agent = agentConfig({ maxStreamTokens: 8_000, contextBudgetTokens: 16_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified', 2_000) });
  const logged = await loggedDuring(() => withFramework(membrane, module, agent, async (framework) => {
    const cm = framework.getAgent('prime')!.getContextManager();
    for (let i = 1; i <= 12; i++) cm.addMessage('User', [{ type: 'text', text: `[in${i}] ${'brief text '.repeat(180)}` }]);
    await drain(framework, 400);
    const previews = recordPreviews(framework);
    const record = cm.previewContext;
    const heldAtPreview: string[][] = [];
    cm.previewContext = (...args: Parameters<typeof record>) => {
      heldAtPreview.push(turnPins(framework).map((pin) => pin.id));
      return record(...args);
    };
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 120_000);
    assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
    const pinned = previews.map((preview, i) => ({ preview, held: heldAtPreview[i] ?? [] })).filter(({ held }) => held.length > 0);
    assert.ok(pinned.length > 0, 'previews were asked while the turn held its pin');
    for (const { preview, held } of pinned) assert.deepEqual(excludedBy(preview), held, "each such preview left the turn's pin out");
    const lastPinned = pinned[pinned.length - 1]!;
    assert.equal(lastPinned.preview.fits, true, 'the last preview asked with the pin held fit without it');
    assert.ok(previews.length > pinned.length, 'and its restart was taken, after which no pin was held');
    assert.deepEqual(turnPins(framework), [], 'no pin is left once the turn has ended');
    assert.ok(!requestText(membrane.streams[membrane.streams.length - 1]).includes('[in1] brief'), "the restarts' compiles folded the opening rows once the pin was gone");
  }));
  assert.equal(logged.filter((line) => line.includes(UNPINNED_AND_COMPILED_AGAIN)).length, 1, "one compile refused with the turn's pin held, and dropped it");
});

test("under kv-unified, a restart declined while the turn holds its pin leaves the pin in place, at each boundary that declines it, to the turn's end", async () => {
  const module = new PagesModule();
  const membrane = new LongTurnMembrane(longTurn(30), module, 40_000);
  const agent = agentConfig({ maxStreamTokens: 8_000, contextBudgetTokens: 20_000, physicalWindowTokens: undefined, strategy: strategy('kv-unified', 6_000) });
  const logged = await loggedDuring(() => withFramework(membrane, module, agent, async (framework, traces) => {
    const previews = recordPreviews(framework);
    const heldAtDecline: string[][] = [];
    framework.onTrace((event) => {
      if (event.type === 'inference:restart_declined') heldAtDecline.push(turnPins(framework).map((pin) => pin.id));
    });
    let held: string[] = [];
    module.onCall = (call) => { if (call === 1) held = turnPins(framework).map((pin) => pin.id); };
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 120_000);
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
    assert.equal(held.length, 1, 'the turn held one pin on its opening rows');
    assert.ok(previews.length > 0 && previews.every((preview) => JSON.stringify(excludedBy(preview)) === JSON.stringify(held)),
      "each preview left the turn's pin out");
    assert.ok(declined(traces).length > 1, `the restart was declined at more than one boundary (${declined(traces).length})`);
    assert.deepEqual(heldAtDecline, declined(traces).map(() => held), 'each decline left the pin in place');
    assert.ok(requestText(membrane.streams[membrane.streams.length - 1]).includes('Read the pages, please.'), "the last stream's request holds the opening request");
    assert.deepEqual(turnPins(framework), [], "the turn's end removed the pin");
  }));
  assert.equal(logged.filter((line) => line.includes(UNPINNED_AND_COMPILED_AGAIN)).length, 0, 'no compile refused with the pin held');
});
