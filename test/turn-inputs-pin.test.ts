import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, PassthroughStrategy } from '@animalabs/context-manager';
import type { ContextManager } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { AgentConfig, EventResponse, Module, ProcessEvent, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';

const PIN = 'agent-framework:turn-inputs';
type ProtectedRange = ReturnType<ContextManager['listPins']>[number];
const PAGE = 'page text '.repeat(400);
const SUMMARY = 'Recollection of the pages read so far.';
const FINAL = 'All pages read.';
const OPENING = 'Read the pages, please.';

const page = (n: number) => `[r${n}] ${PAGE}`;
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const requestText = (request: NormalizedRequest) => JSON.stringify(request.messages ?? []);
const estimatedTokens = (value: unknown) => Math.ceil(JSON.stringify(value ?? null).length / 4);

class PagesModule implements Module {
  readonly name = 'pages';
  calls = 0;
  onCall: ((call: number) => void | Promise<void>) | undefined;
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
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'tool-result' && this.awaitAtResultMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.awaitAtResultMs));
    }
    if (event.type !== 'external-message') return {};
    const { content } = event as unknown as { content: ContentBlock[] };
    return { addMessages: [{ participant: 'User', content }], requestInference: true };
  }
}

function toolRounds(count: number): NormalizedResponse[] {
  return Array.from({ length: count }, (_, i) => createMockResponse([
    { type: 'text', text: `Reading page ${i + 1}.` },
    { type: 'tool_use', id: `read_${i + 1}`, name: 'pages--read', input: {} },
  ], 'tool_use'));
}

const answer = (t: string) => createMockResponse(text(t));

class TurnMembrane extends MockMembrane {
  readonly streams: NormalizedRequest[] = [];
  constructor(private readonly queues: NormalizedResponse[][]) {
    super();
  }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.streams.push(request);
    return new MockYieldingStream(this.queues.shift() ?? []);
  }
  override async complete(): Promise<NormalizedResponse> {
    return createMockResponse(text(SUMMARY));
  }
}

class SizedWindowStream extends MockYieldingStream {
  private size: number;
  private inputTokens = 0;
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
      const event = next.value;
      if (this.size > this.window) {
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
  constructor(private readonly rounds: NormalizedResponse[], private readonly module: PagesModule, private readonly window: number) {
    super();
  }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.streams.push(request);
    return new SizedWindowStream(this.rounds.slice(this.module.calls), request, this.window);
  }
  override async complete(): Promise<NormalizedResponse> {
    return createMockResponse(text(SUMMARY));
  }
}

type Kind = 'hierarchical' | 'kv-unified';

function strategy(kind: Kind = 'hierarchical', recentWindowTokens = 2_000): AutobiographicalStrategy {
  const base = { compressionModel: 'test-compression-model', targetChunkTokens: 1_000, recentWindowTokens, autoTickOnNewMessage: true };
  if (kind === 'hierarchical') return new AutobiographicalStrategy(base);
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
  run: (framework: AgentFramework) => Promise<void>,
  options: Pick<Parameters<typeof AgentFramework.create>[0], 'inferencePolicy' | 'errorPolicy'> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turn-inputs-pin-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [agent],
    modules: [module],
    syncIntervalMs: 0,
    ...options,
  });
  try {
    framework.start();
    await run(framework);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const cmOf = (framework: AgentFramework) => framework.getAgent('prime')!.getContextManager();
const rows = (framework: AgentFramework) => cmOf(framework).queryMessages({}).messages;
const storedText = (framework: AgentFramework) => JSON.stringify(rows(framework).map((message) => message.content));
const rowWith = (framework: AgentFramework, t: string) => rows(framework).findIndex((message) => JSON.stringify(message.content).includes(t));
const idle = (framework: AgentFramework) => framework.getAgent('prime')!.state.status === 'idle';
const inputPins = (framework: AgentFramework): ProtectedRange[] => cmOf(framework).listPins().filter((pin) => pin.name === PIN);
const failureRows = (framework: AgentFramework) => rows(framework)
  .map((message) => (message.metadata ?? {}) as Record<string, unknown>)
  .filter((metadata) => metadata.kind === 'inference-failed');

function ask(framework: AgentFramework, t = OPENING): void {
  framework.pushEvent({ type: 'external-message', source: 'test', content: text(t), triggerInference: true } as unknown as ProcessEvent);
}

/** The pin's span as store positions. */
function span(framework: AgentFramework, pin: ProtectedRange): [number, number] {
  const ids = rows(framework).map((message) => message.id);
  return [ids.indexOf(pin.firstMessageId), ids.indexOf(pin.lastMessageId)];
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function capturingErrors<T>(run: (logged: string[]) => Promise<T>): Promise<T> {
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    consoleError(...args);
  };
  try {
    return await run(logged);
  } finally {
    console.error = consoleError;
  }
}

test("under kv-unified, a long turn's opening request stays whole in each of its streams' requests, while restarts fold its older rounds, and its pin ends with it", async () => {
  const module = new PagesModule(1);
  const rounds = [...toolRounds(40), answer(FINAL)];
  for (const round of rounds) (round as { usage: unknown }).usage = { inputTokens: 1, outputTokens: 20 };
  const membrane = new LongTurnMembrane(rounds, module, 30_000);
  const agent = agentConfig({ maxStreamTokens: 8_000, contextBudgetTokens: 20_000, strategy: strategy('kv-unified', 6_000) });
  await withFramework(membrane, module, agent, async (framework) => {
    ask(framework);
    await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL), 180_000);
    assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
    assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
    assert.ok(membrane.streams.some((request) => requestText(request).includes(SUMMARY)), "the turn's restarts folded its older rounds");
    const without = membrane.streams.flatMap((request, i) => requestText(request).includes(OPENING) ? [] : [i]);
    assert.deepEqual(without, [], `every stream's request holds the opening request whole (of ${membrane.streams.length})`);
    await waitUntil('no pin to be left once the turn has ended', () => inputPins(framework).length === 0, 5_000);
  });
});

test("a turn's pin covers what arrived since the agent's last turn, an aside stored without a wake included, and none of that last turn's rows", async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(3), answer('First answered.')], [...toolRounds(1), answer(FINAL)]]);
  await withFramework(membrane, module, agentConfig(), async (framework) => {
    ask(framework, 'First, read three pages.');
    await waitUntil('the first turn to end', () => storedText(framework).includes('First answered.') && idle(framework));
    cmOf(framework).addMessage('Dana', text('An aside nobody asked about.'));
    let pins: ProtectedRange[] | undefined;
    module.onCall = (call) => { if (call === 4) pins = inputPins(framework); };
    ask(framework);
    await waitUntil('the second turn to end', () => storedText(framework).includes(FINAL));
    assert.equal(pins?.length, 1, 'one pin while the turn runs');
    const [from, to] = span(framework, pins![0]);
    assert.ok(from > rowWith(framework, 'First answered.'), "the pin starts after the agent's last reply");
    assert.ok(from <= rowWith(framework, 'An aside nobody asked about.'), 'the pin covers the aside');
    assert.ok(to >= rowWith(framework, OPENING), 'the pin covers the request');
    await waitUntil('no pin to be left once the turn has ended', () => inputPins(framework).length === 0, 5_000);
  });
});

class RefusingFirstMembrane extends TurnMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    if (this.streams.length > 0) return super.streamYielding(request);
    this.streams.push(request);
    return new SizedWindowStream(toolRounds(2), request, estimatedTokens(request.messages) + 200);
  }
}

test("after a turn that ended with its last round's results stored and no reply, the next turn's pin starts after those results", async () => {
  const module = new PagesModule();
  const membrane = new RefusingFirstMembrane([[...toolRounds(1), answer(FINAL)]]);
  await withFramework(membrane, module, agentConfig(), async (framework) => {
    ask(framework, 'First, read two pages.');
    await waitUntil('the first turn to fail', () => failureRows(framework).length > 0 && idle(framework));
    assert.ok(rowWith(framework, '[r1]') > rowWith(framework, 'Reading page 1.'), "the first round's results are stored after its call");
    let pins: ProtectedRange[] | undefined;
    module.onCall = (call) => { if (call === 2) pins = inputPins(framework); };
    ask(framework);
    await waitUntil('the second turn to end', () => storedText(framework).includes(FINAL));
    assert.equal(pins?.length, 1, 'one pin while the turn runs');
    const [from, to] = span(framework, pins![0]);
    assert.ok(from > rowWith(framework, '[r1]'), "the pin starts after the first turn's results");
    assert.ok(to >= rowWith(framework, OPENING), 'the pin covers the request');
  });
});

test('a turn whose continuation the inference policy drops leaves no pin', async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(3), answer('Never reached.')]]);
  const dropped: string[] = [];
  const policy = {
    shouldInfer: (_agent: string, requests: Array<{ reason: string }>) => {
      const restart = requests.some((r) => r.reason === 'context_budget_restart');
      if (restart) dropped.push('context_budget_restart');
      return !restart;
    },
  };
  await withFramework(membrane, module, agentConfig({ maxStreamTokens: 5 }), async (framework) => {
    let pins: ProtectedRange[] | undefined;
    module.onCall = (call) => { if (call === 1) pins = inputPins(framework); };
    ask(framework);
    await waitUntil('the turn to end', () => module.calls > 0 && idle(framework));
    assert.equal(pins?.length, 1, 'the turn held its pin');
    assert.deepEqual(dropped, ['context_budget_restart'], "the policy dropped the turn's restart");
    assert.equal(membrane.streams.length, 1, "the turn's restart was dropped, not sent");
    await waitUntil('no pin to be left once the turn has ended', () => inputPins(framework).length === 0, 5_000);
  }, { inferencePolicy: policy as never });
});

test("pins of the turn's name left on rows of an earlier turn are gone once the next turn starts", async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[answer('First answered.')], [...toolRounds(1), answer(FINAL)]]);
  await withFramework(membrane, module, agentConfig(), async (framework) => {
    ask(framework, 'First, say hello.');
    await waitUntil('the first turn to end', () => storedText(framework).includes('First answered.') && idle(framework));
    const earlier = rows(framework)[rowWith(framework, 'First, say hello.')].id;
    const reply = rows(framework)[rowWith(framework, 'First answered.')].id;
    const left = [cmOf(framework).pinRange(earlier, earlier, { name: PIN }), cmOf(framework).pinRange(reply, reply, { name: PIN })];
    let pins: ProtectedRange[] | undefined;
    module.onCall = () => { pins = inputPins(framework); };
    ask(framework);
    await waitUntil('the second turn to end', () => storedText(framework).includes(FINAL));
    assert.equal(pins?.length, 1, 'one pin while the turn runs');
    assert.ok(!left.includes(pins![0].id), 'both pins left from before are gone');
    assert.ok(span(framework, pins![0])[1] >= rowWith(framework, OPENING), "the turn's own pin covers its request");
  });
});

for (const kind of ['hierarchical', 'kv-unified'] satisfies Kind[]) {
  test(`under ${kind}, when the turn's pinned inputs don't fit beside the rest, its compile drops the pin, says so, and the turn answers`, async () => {
    const module = new PagesModule();
    const membrane = new TurnMembrane([[answer(FINAL)]]);
    const agent = agentConfig({ contextBudgetTokens: 26_000, strategy: strategy(kind) });
    await capturingErrors(async (logged) => {
      await withFramework(membrane, module, agent, async (framework) => {
        const cm = cmOf(framework);
        for (let i = 1; i <= 30; i++) cm.addMessage('Dana', text(`[a${i}] ${PAGE}`));
        for (let tick = 0; tick < 600 && cm.getPendingWork(); tick++) await cm.tick();
        assert.equal(cm.getPendingWork(), null, 'the rows before the request are compressed');
        ask(framework);
        await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL));
        assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
        assert.ok(storedText(framework).includes(FINAL), 'the turn answered');
        assert.ok(requestText(membrane.streams[0]).includes(SUMMARY), 'its request holds summaries in place of the rows the pin would have kept whole');
        assert.deepEqual(inputPins(framework), [], 'no pin is left');
      });
      assert.ok(logged.some((line) => line.includes("[turn-inputs] prime: the compile refused with the turn's inputs pinned")),
        'the dropped pin is logged');
    });
  });
}

class FailingStream extends MockYieldingStream {
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    yield { type: 'error', error: new Error('upstream connection reset') } as StreamEvent;
  }
}

class FailingMembrane extends TurnMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.streams.push(request);
    return new FailingStream([]);
  }
}

test("a turn whose retry stop() cancels leaves no pin behind for the framework's next start", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-inputs-pin-'));
  let waiting!: () => void;
  const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
  const errorPolicy = { maxRetries: 1, onInferenceError: () => { waiting(); return { retry: true as const, delayMs: 60_000 }; } };
  const open = (membrane: MockMembrane) => AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [agentConfig()], modules: [new PagesModule()], syncIntervalMs: 0, errorPolicy,
  });
  try {
    const framework = await open(new FailingMembrane([]));
    try {
      framework.start();
      ask(framework);
      await within(inDelay, 30_000, "the turn's retry to wait");
      assert.equal(inputPins(framework).length, 1, 'the turn holds its pin while its retry waits');
    } finally {
      await framework.stop();
    }
    const reopened = await open(new TurnMembrane([]));
    try {
      assert.deepEqual(inputPins(reopened), [], 'no pin is left in the store');
    } finally {
      await reopened.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when the compile refuses without the pin too, the pin is dropped once and the turn ends with that refusal, as it would have without the pin', async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[answer(FINAL)]]);
  const agent = agentConfig({ contextBudgetTokens: 8_000, strategy: strategy('kv-unified') });
  const errorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false as const }) };
  await capturingErrors(async (logged) => {
    await withFramework(membrane, module, agent, async (framework) => {
      const cm = cmOf(framework);
      for (let i = 1; i <= 16; i++) cm.addMessage('Dana', text(`[a${i}] ${PAGE}`));
      for (let tick = 0; tick < 300 && cm.getPendingWork(); tick++) await cm.tick();
      const compile = cm.compile.bind(cm);
      const refusals: Array<{ pinned: number; name: unknown }> = [];
      cm.compile = async (...args: Parameters<typeof compile>) => {
        const pinned = inputPins(framework).length;
        try {
          return await compile(...args);
        } catch (error) {
          refusals.push({ pinned, name: (error as { name?: unknown }).name });
          throw error;
        }
      };
      ask(framework);
      await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL));
      assert.deepEqual(refusals, [{ pinned: 1, name: 'OverBudgetError' }, { pinned: 0, name: 'OverBudgetError' }],
        'the compile refused with the pin, then once more without it');
      assert.equal(failureRows(framework)[0]?.errorType, 'over_budget', "the turn ended with the compile's refusal");
      assert.equal(membrane.streams.length, 0, 'no request was sent');
      assert.deepEqual(inputPins(framework), [], 'no pin is left');
    }, { errorPolicy });
    assert.equal(logged.filter((line) => line.includes("[turn-inputs] prime: the compile refused with the turn's inputs pinned")).length, 1,
      'the pin was dropped once');
  });
});

test("two committing compiles that refuse at once with the turn's pin held each compile again without it", async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(1), answer(FINAL)]]);
  await withFramework(membrane, module, agentConfig({ contextBudgetTokens: 60_000, strategy: strategy('kv-unified') }), async (framework) => {
    const cm = cmOf(framework);
    for (let i = 1; i <= 30; i++) cm.addMessage('Dana', text(`[a${i}] ${PAGE}`));
    for (let tick = 0; tick < 600 && cm.getPendingWork(); tick++) await cm.tick();
    let held = 0;
    let outcomes: string[] = [];
    const compiles: Array<{ pinned: number; outcome: unknown }> = [];
    module.onCall = async () => {
      held = inputPins(framework).length;
      const agent = framework.getAgent('prime')!;
      const budget = { maxTokens: 26_000, reserveForResponse: 0 };
      const compile = cm.compile.bind(cm);
      cm.compile = async (...args: Parameters<typeof compile>) => {
        const pinned = inputPins(framework).length;
        try {
          const result = await compile(...args);
          compiles.push({ pinned, outcome: 'compiled' });
          return result;
        } catch (error) {
          compiles.push({ pinned, outcome: (error as { name?: unknown }).name });
          throw error;
        }
      };
      try {
        outcomes = await Promise.all([agent.compileContext(budget), agent.compileContext(budget)]
          .map((p) => p.then(() => 'compiled', (error: unknown) => String((error as { name?: unknown }).name))));
      } finally {
        cm.compile = compile;
      }
    };
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL) || failureRows(framework).length > 0);
    assert.equal(held, 1, 'the turn held its pin when both compiles started');
    assert.deepEqual(compiles, [
      { pinned: 1, outcome: 'OverBudgetError' }, { pinned: 1, outcome: 'OverBudgetError' },
      { pinned: 0, outcome: 'compiled' }, { pinned: 0, outcome: 'compiled' },
    ], 'both refused with the pin held, then each compiled once without it');
    assert.deepEqual(outcomes, ['compiled', 'compiled'], 'both compiled without the pin');
  });
});

test("a dry-run compile that refuses while the turn's pin is held leaves the pin in place", async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(1), answer(FINAL)]]);
  await withFramework(membrane, module, agentConfig(), async (framework) => {
    for (let i = 1; i <= 4; i++) cmOf(framework).addMessage('Dana', text(`[a${i}] ${PAGE}`));
    let refused: unknown;
    let before: string[] = [];
    let pins: ProtectedRange[] | undefined;
    module.onCall = async () => {
      before = inputPins(framework).map((pin) => pin.id);
      refused = await framework.getAgent('prime')!.compileWithInjections({ maxTokens: 3_000, reserveForResponse: 0 }, undefined, { dryRun: true })
        .then(() => 'it fitted', (error: unknown) => error);
      pins = inputPins(framework);
    };
    ask(framework);
    await waitUntil('the turn to end', () => storedText(framework).includes(FINAL));
    assert.equal((refused as { name?: unknown } | undefined)?.name, 'OverBudgetError', `the dry run refused as over budget: ${String(refused)}`);
    assert.equal(before.length, 1, 'the turn held its pin before the dry run');
    assert.deepEqual(pins?.map((pin) => pin.id), before, `the same pin is held after it: ${JSON.stringify(pins)}`);
  });
});

test('under a strategy without pins, a turn runs and logs nothing about a pin', async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(1), answer(FINAL)]]);
  await capturingErrors(async (logged) => {
    await withFramework(membrane, module, agentConfig({ strategy: new PassthroughStrategy() }), async (framework) => {
      ask(framework);
      await waitUntil('the turn to end', () => storedText(framework).includes(FINAL));
    });
    assert.deepEqual(logged.filter((line) => line.includes('[turn-inputs]')), [], 'nothing about a pin is logged');
  });
});

test("a silent start pins nothing, and a pin of the turn's name left from before is gone once it starts", async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(1), answer('Tick done.')]]);
  await withFramework(membrane, module, agentConfig(), async (framework) => {
    const old = cmOf(framework).addMessage('Dana', text('An old message.'));
    cmOf(framework).pinRange(old, old, { name: PIN });
    let pins: ProtectedRange[] | undefined;
    module.onCall = () => { pins = inputPins(framework); };
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'prime', reason: 'timer', source: 'framework', timestamp: Date.now(), suppressProse: true,
    });
    await framework.runUntilIdle();
    await waitUntil('the silent turn to end', () => module.calls > 0 && idle(framework));
    assert.deepEqual(pins, [], 'no pin of the name while the silent turn runs');
  });
});

test("one resident's opening, and its turn's end, leave another resident's pin in place in their shared store", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-inputs-pin-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new TurnMembrane([]).asMembrane(),
    agents: [agentConfig(), agentConfig({ name: 'helper', systemPrompt: 'You are helper.', strategy: strategy() })],
    modules: [], syncIntervalMs: 0,
  });
  const starts = framework as unknown as { pinTurnInputs(agent: unknown, routing: object): void; releaseTurnInputs(routing: object): void };
  const prime = framework.getAgent('prime')!;
  const helper = framework.getAgent('helper')!;
  const pinsOf = (agent: typeof prime) => agent.getContextManager().listPins().filter((pin) => pin.name === PIN).map((pin) => pin.id);
  try {
    prime.getContextManager().addMessage('Dana', text('A request for both.'));
    const primeTurn = {};
    const helperTurn = {};
    starts.pinTurnInputs(prime, primeTurn);
    const primePin = pinsOf(prime);
    assert.equal(primePin.length, 1, "prime's opening pinned");
    starts.pinTurnInputs(helper, helperTurn);
    assert.deepEqual(pinsOf(prime), primePin, "helper's opening left prime's pin");
    assert.equal(pinsOf(helper).length, 1, "helper's opening pinned its own");
    starts.releaseTurnInputs(helperTurn);
    assert.deepEqual(pinsOf(prime), primePin, "helper's turn's end left prime's pin");
    assert.deepEqual(pinsOf(helper), [], "helper's pin went with its turn");
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin starts at the first row the agent sees, past rows it never sees under any name, its own included, and such rows inside it, such as a tuned-out message, stay out of its request and its budget", async () => {
  const module = new PagesModule();
  const membrane = new TurnMembrane([[...toolRounds(1), answer(FINAL)]]);
  const agent = agentConfig({ contextBudgetTokens: 8_000 });
  await capturingErrors(async (logged) => {
    await withFramework(membrane, module, agent, async (framework) => {
      const cm = cmOf(framework);
      const tunedOut = { tuneOut: { epochId: 'away' } } as never;
      cm.addMessage('Dana', text('TUNED OUT before the aside.'), tunedOut);
      cm.addMessage('Dana', text('An aside before.'));
      cm.addMessage('prime', text('TUNED OUT, under the agent\'s own name.'), tunedOut);
      cm.addMessage('Dana', text(`TUNED OUT ${PAGE.repeat(8)}`), tunedOut);
      let pins: ProtectedRange[] | undefined;
      module.onCall = () => { pins = inputPins(framework); };
      ask(framework);
      await waitUntil('the turn to end', () => failureRows(framework).length > 0 || storedText(framework).includes(FINAL));
      assert.deepEqual(failureRows(framework), [], 'the turn ended without a failure row');
      const [from, to] = span(framework, pins![0]);
      assert.equal(from, rowWith(framework, 'An aside before.'), 'the pin starts at the aside, the first row the agent sees');
      assert.ok(to >= rowWith(framework, OPENING), 'the pin covers the request');
      const hidden = rowWith(framework, `TUNED OUT ${PAGE.slice(0, 20)}`);
      assert.ok(from < hidden && hidden < to, 'a tuned-out message lies inside the pinned range');
      for (const request of membrane.streams) assert.ok(!requestText(request).includes('TUNED OUT'), 'no request holds a tuned-out message');
    });
    assert.ok(!logged.some((line) => line.includes('[turn-inputs]')), 'the pin was never dropped for the budget');
  });
});

// A shared fork reads its parent's context at a checkpoint and writes on a
// branch of its own (deriveAgent). Its own turn's pin housekeeping clears and
// sets pins of the turn's name; none of that may reach its parent's branch, or
// the parent's opening request could fold mid-turn.
test("a shared fork's opening and its end leave its parent's turn-inputs pin in place, and the parent's own end still releases it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-inputs-pin-'));
  const membrane = new RoutedMembrane();
  membrane.identify = (request) => (JSON.stringify(request.messages).includes('[FORK-FRAMING]') ? 'fork-1' : request.assistantParticipant ?? '');
  const gates = new GateModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', strategy: strategy(), contextBudgetTokens: 60_000, maxTokens: 200 }],
    modules: [gates],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  const pinsOf = (cm: ContextManager) => cm.listPins().filter((pin) => pin.name === PIN).map((pin) => ({ id: pin.id }));
  const mira = framework.getAgent('mira')!;
  try {
    mira.getContextManager().addMessage('user', text('Please look into the open issues.'));
    membrane.script('mira', waitCall('g-mira'), say('mira done'));
    framework.start();
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now() });
    await until(() => gates.entered.has('g-mira'), 'mira to block mid-turn');
    const miraPin = pinsOf(mira.getContextManager());
    assert.equal(miraPin.length, 1, "mira's turn holds its pin while it runs");

    membrane.script('fork-1', say('fork done'));
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      strategy: strategy() as never,
      framing: [{ participant: 'user', content: text('[FORK-FRAMING] You are the fork. Count the open issues.') }],
    });
    const run = await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    assert.equal(run.speech, 'fork done', 'the fork ran its turn to its end');
    assert.ok(membrane.callsFor('fork-1').length > 0, "the fork's turn opened a stream");
    assert.deepEqual(pinsOf(mira.getContextManager()), miraPin, "the fork's opening and its end left mira's pin");

    // Her one stream yields at the tool call and goes on to her answer once the gate opens.
    gates.release('g-mira');
    const miraSaid = () => mira.getContextManager().getAllMessages()
      .some((m) => m.participant === 'mira' && m.content.some((block) => block.type === 'text' && block.text === 'mira done'));
    await until(miraSaid, "mira's turn to reach its answer", 10_000);
    await until(() => pinsOf(mira.getContextManager()).length === 0, "mira's own end to release her pin", 5_000);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
