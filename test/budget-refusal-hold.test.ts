import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy, WindowedPassthroughStrategy } from '@animalabs/context-manager';
import { MembraneError, type ContentBlock, type NormalizedRequest, type NormalizedResponse, type YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const NOTE = /\[budget-hold\] Your context didn't fit its budget \(100,201 tokens against 48,568\) when a turn came to start\. That turn waited \d+ (s|min)\./;

async function pollUntil(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const overBudget = () => Object.assign(
  new Error('Compile plan would exceed hard budget: head=41200 tail=8100 middle=62000 budget=48568'),
  { name: 'OverBudgetError', budget: 48_568, actual: 100_201 },
);

interface Compression {
  ticks: number; compiles: number; refusals: number; refusing: boolean;
  fitAt: number; readyAt: number; refuseFrom: number;
  calls: boolean;
  progress: number; summaries: number; stalled: boolean; snapshot: boolean;
  onRefusal?: () => void;
  snapshotThrows?: boolean;
  snapshotOther?: boolean;
  snapshotBigInt?: boolean;
  failNext?: Error;
}
type Patchable = Record<'compile' | 'tick' | 'isReady' | 'getPendingWork', (...args: unknown[]) => unknown>;
async function withCompression<T>(state: Partial<Compression>, run: (c: Compression) => Promise<T>): Promise<T> {
  const c: Compression = {
    ticks: 0, compiles: 0, refusals: 0, refusing: false,
    fitAt: Infinity, readyAt: state.readyAt ?? state.fitAt ?? Infinity, refuseFrom: 1,
    calls: false, progress: 0, summaries: 0, stalled: !state.calls, snapshot: true, ...state,
  };
  const progressPatched = new Map<object, unknown>();
  for (const strategy of [AutobiographicalStrategy.prototype, PassthroughStrategy.prototype, WindowedPassthroughStrategy.prototype] as Array<{ getProgressSnapshot?: unknown }>) {
    progressPatched.set(strategy, strategy.getProgressSnapshot);
    strategy.getProgressSnapshot = c.snapshot
      ? () => {
        if (c.snapshotThrows) throw new Error('zz the snapshot could not be read');
        if (c.snapshotOther) return { completed: c.progress };
        if (c.snapshotBigInt) return { chunksCompressed: BigInt(c.progress) };
        return { chunksCompressed: c.progress, summaryCounts: { l1: c.progress + c.summaries, l2: 0, l3: 0 } };
      }
      : undefined;
  }
  const pending = () => c.ticks < c.readyAt;
  const proto = ContextManager.prototype as unknown as Patchable;
  const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady, getPendingWork: proto.getPendingWork };
  proto.compile = async function (this: unknown, ...args: unknown[]) {
    if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun === true) return original.compile.apply(this, args);
    c.compiles++;
    if (c.failNext) {
      const error = c.failNext;
      c.failNext = undefined;
      throw error;
    }
    if (c.compiles >= c.refuseFrom && c.ticks < c.fitAt) {
      c.refusing = true;
      c.refusals++;
      c.onRefusal?.();
      throw overBudget();
    }
    return original.compile.apply(this, args);
  };
  proto.tick = async function (this: { membrane: { complete(request: unknown): Promise<unknown> } }) {
    if (!c.refusing) return;
    const working = pending();
    c.ticks++;
    if (c.calls && working) await this.membrane.complete({ messages: [], config: { model: 'test-model', maxTokens: 100 } });
    if (working && !c.stalled) c.progress++;
  };
  proto.isReady = function () { return !pending(); };
  proto.getPendingWork = function () { return pending() ? { description: 'zz compression pending', started: new Date() } : null; };
  try {
    return await run(c);
  } finally {
    Object.assign(proto, original);
    for (const [strategy, was] of progressPatched) {
      if (was === undefined) delete (strategy as { getProgressSnapshot?: unknown }).getProgressSnapshot;
      else (strategy as { getProgressSnapshot?: unknown }).getProgressSnapshot = was;
    }
  }
}

class InboxModule implements Module {
  readonly name = 'inbox';
  ctx?: ModuleContext;
  gatherContext?: () => Promise<Array<{ namespace: string; position: 'afterUser'; content: ContentBlock[] }>>;
  constructor(context?: () => string) {
    if (context) this.gatherContext = async () => [{ namespace: 'inbox:status', position: 'afterUser', content: [text(context())] }];
  }
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall(): Promise<never> { throw new Error('no tools'); }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }], requestInference: true };
  }
}

class BlobToolModule implements Module {
  readonly name = 'canned';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'blob', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }], requestInference: true };
  }
}

class RestartEventModule implements Module {
  readonly name = 'restart-event';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<never> { throw new Error('no tools'); }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    return (event.type as string) === 'context_budget_restart' ? { requestInference: true } : {};
  }
}

class PingModule implements Module {
  readonly name = 'pings';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: true, data: 'pong' };
  }
  async onProcess(): Promise<EventResponse> { return {}; }
}

class SequentialStreamMembrane extends MockMembrane {
  private streamIdx = 0;
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.streamIdx, ++this.streamIdx));
    this.lastStream = stream;
    return stream;
  }
}

interface Internal {
  budgetHoldRecheckMs: number;
  budgetHolds: Map<string, { turn?: unknown; startedAt: number; wait: { since: number }; wakes: Array<{ reason?: string }> }>;
  quiesced: boolean;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<Record<string, unknown>>;
  hasTurn(agentName: string): boolean;
  releaseBudgetHold(agentName: string): void;
  releaseBudgetHoldsOnEvidence(): void;
  redoStacks: Map<string, unknown[]>;
  turnCounters: Map<string, number>;
  getTurnCheckpoints(agentName: string): Array<{ turnIndex: number }>;
  checkBudgetHoldsAfterWindowChange(only?: string, release?: boolean): void;
  readHostMode(): { quiesced: boolean } | null;
  saveTurnCheckpoints(agentName: string, checkpoints: Array<{ turnIndex: number }>): void;
  cancelCoalescedWakes(subject: string): void;
  holdProviderAcceleration(agent: unknown, error: Error): boolean;
  processInferenceRequests(): Promise<void>;
  startAgentStream(agent: unknown, trigger: Record<string, unknown>): Promise<void>;
  releaseAgentRuntime(agent: unknown, home?: unknown, why?: string): void;
  providerAccelerationCooldowns: Map<string, { until: number; heldRequests: unknown[] }>;
  releaseProviderAccelerationCooldown(agentName: string): void;
  eventGate: { inferring: Set<string> } | null;
  endContinuedTurn(agentName: string, drop: { kind: 'dropped'; why: string }): void;
  overBudgetDrainInFlight: Set<string>;
  conversationAuxiliaryMembraneFor(agentName: string): { complete(request: unknown): Promise<unknown> };
  providerWaits: { active(agentName: string, model: string): unknown };
}

const symbolNamed = (o: object, name: string): symbol => {
  const found = Object.getOwnPropertySymbols(o).find((s) => s.description === name);
  if (!found) throw new Error(`no ${name} mark`);
  return found;
};
const stringKeys = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o));
const errorStream = (error: Error): YieldingStream => ({
  isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
  provideToolResults() { throw new Error('not waiting'); },
  cancel() {},
  async *[Symbol.asyncIterator]() { yield { type: 'error', error }; },
} as unknown as YieldingStream);
const providerLimit = () => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429,
  message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
  rawError: { status: 429 },
} as ConstructorParameters<typeof MembraneError>[0]);
async function mergedBatchMark(t: { internal: Internal; cm(): { addMessage(p: string, c: unknown): unknown } }): Promise<symbol> {
  const orig = t.internal.startAgentStream;
  let merged: Record<string, unknown> | undefined;
  t.internal.startAgentStream = async function (this: unknown, agent: unknown, trigger: Record<string, unknown>) {
    if (!merged && Object.getOwnPropertySymbols(trigger).some((x) => x.description === 'merged-batch')) merged = trigger;
    return orig.call(this, agent, trigger);
  };
  try {
    t.cm().addMessage('user', [text('hello')]);
    t.internal.pendingRequests.push(
      { agentName: 'prime', reason: 'zz-a', source: 'test', timestamp: Date.now() },
      { agentName: 'prime', reason: 'zz-b', source: 'test', timestamp: Date.now() },
    );
    await t.internal.processInferenceRequests();
  } finally {
    t.internal.startAgentStream = orig;
  }
  assert.ok(merged, 'a merged start, for its mark');
  return symbolNamed(merged, 'merged-batch');
}
function watchReleases(framework: unknown, ready: () => boolean): { whileNotReady: number; all: number; notByProgress: number } {
  const internal = framework as Internal & { agents: Map<string, unknown>; compressionProgressOf(agent: unknown): string | undefined };
  const release = internal.releaseBudgetHold.bind(framework);
  const seen = { whileNotReady: 0, all: 0, notByProgress: 0 };
  internal.releaseBudgetHold = (agentName: string) => {
    const hold = internal.budgetHolds.get(agentName) as { progressAtHold?: string } | undefined;
    const progress = hold ? internal.compressionProgressOf(internal.agents.get(agentName)) : undefined;
    const moved = hold !== undefined && progress !== undefined && progress !== hold.progressAtHold;
    release(agentName);
    if (hold && !internal.budgetHolds.has(agentName)) {
      seen.all++;
      if (!ready()) {
        seen.whileNotReady++;
        if (!moved) seen.notByProgress++;
      }
    }
  };
  return seen;
}

type Reply = string | NormalizedResponse;
async function resident(options: {
  maintenanceIntervalMs?: number;
  replies?: Reply[];
  modules?: Module[];
  context?: () => string;
  binds?: boolean;
  restart?: boolean;
  gate?: boolean;
  judged?: boolean;
  policyRetries?: number;
  policyDelayMs?: number;
  policyErrors?: Error[];
  secondAgent?: boolean;
  policy?: { shouldInfer(agentName: string, requests: Array<Record<string, unknown>>): boolean };
  strategy?: unknown;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-hold-'));
  const inbox = new InboxModule(options.context);
  const membrane = new SequentialStreamMembrane();
  if (options.restart) {
    const near = createMockResponse([text('Working'), { type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} } as ContentBlock], 'tool_use');
    (near as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
    membrane.pushResponse(near);
  }
  for (const reply of options.replies ?? ['Answered once it fit']) {
    membrane.pushResponse(typeof reply === 'string' ? createMockResponse([text(reply)]) : reply);
  }
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime', model: 'test-model', systemPrompt: 'You are prime.',
      ...(options.restart ? { allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000 } : {}),
      ...(options.binds ? { thinkingBinding: { binds: true, dropBlock: false } } : {}),
      ...(options.strategy ? { strategy: options.strategy } : {}),
    }, ...(options.secondAgent ? [{ name: 'second', model: 'test-model', systemPrompt: 'You are second.' }] : [])],
    modules: [options.restart ? new BlobToolModule() : inbox, ...(options.modules ?? [])],
    syncIntervalMs: 0,
    maintenanceIntervalMs: options.maintenanceIntervalMs ?? 50,
    errorPolicy: {
      maxRetries: options.policyRetries ?? 3,
      onInferenceError: (error: Error, _agent: string, attempt: number) => {
        options.policyErrors?.push(error);
        return attempt < (options.policyRetries ?? 3) ? { retry: true, delayMs: options.policyDelayMs ?? 0 } : { retry: false };
      },
    },
    ...(options.gate ? { gate: { config: { policies: [], default: 'always' } } } : {}),
    ...(options.judged ? { gate: {
      config: { policies: [{ name: 'ambient', match: { scope: ['mcpl:push-event'] }, behavior: { judge: { debounceMs: 50, instructions: 'Wake me for questions.' } } }] },
      judge: { onError: 'skip' },
    } } : {}),
    ...(options.policy ? { inferencePolicy: options.policy } : {}),
  } as Parameters<typeof AgentFramework.create>[0]);
  const internal = framework as unknown as Internal;
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  const send = (body: string) => framework.pushEvent({
    type: 'external-message', source: 'test', content: [text(body)], metadata: {}, triggerInference: true,
  } as unknown as ProcessEvent);
  framework.start();
  const cm = () => framework.getAgent('prime')!.getContextManager();
  const rows = () => cm().getAllMessages() as unknown as Array<{ id: string; participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>;
  const bodyOf = (row: { content: Array<{ type: string; text?: string }> }) => row.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const of = (type: string) => traces.filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>;
  return {
    framework, internal, membrane, traces, send, cm, rows, of,
    sendForPrime: (body: string) => {
      const id = String(inbox.ctx!.addMessage('User', [text(body)], undefined, { forAgent: 'prime' } as never));
      internal.pendingRequests.push({ agentName: 'prime', reason: 'external-message', source: 'test', timestamp: Date.now(), readsRow: id });
    },
    stored: () => rows().map(bodyOf).join('\n'),
    rowWith: (body: string) => rows().find((r) => bodyOf(r) === body)!,
    windowText: () => (cm().getPresentedMessages() as unknown as Array<{ content: Array<{ type: string; text?: string }> }>).map(bodyOf).join('\n'),
    turnCalls: () => (membrane.calls as NormalizedRequest[]).filter((call) => call.messages.length > 0),
    alerts: (kind: string) => of('ops:alert').filter((e) => e.kind === kind),
    hold: () => (framework.healthSnapshot() as { agents: Array<{ name: string; budgetHold: Record<string, unknown> | null }> })
      .agents.find((a) => a.name === 'prime')?.budgetHold ?? null,
    close: async () => {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Resident = Awaited<ReturnType<typeof resident>>;
const requestText = (request: NormalizedRequest | undefined) => JSON.stringify(request?.messages ?? null);
const notesStored = (t: Resident) => t.rows().filter((r) => JSON.stringify(r.content).includes('[budget-hold]')).length;
const notesInWindow = (t: Resident) => t.windowText().split('[budget-hold]').length - 1;

async function withWebhook<T>(run: (posts: string[]) => Promise<T>): Promise<T> {
  const env = process.env.CONNECTOME_OPS_WEBHOOK;
  const fetchWas = globalThis.fetch;
  const posts: string[] = [];
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://zz-webhook.invalid/hook';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const content = String((JSON.parse(String(init?.body ?? '{}')) as { content?: unknown }).content ?? '');
    const kind = /\*\*prime\*\* ([a-z-]+):/.exec(content)?.[1];
    if (kind) posts.push(kind);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    return await run(posts);
  } finally {
    globalThis.fetch = fetchWas;
    if (env === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK;
    else process.env.CONNECTOME_OPS_WEBHOOK = env;
  }
}

describe('a turn refused for budget while compression is pending waits idle, and runs once there is room (#304)', () => {
  it('runs the refused turn once compression makes room, with a note saying why it waited', async () => {
    await withCompression({ fitAt: 3 }, async () => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')), 'the turn ran once there was room, with no new message to wake it');
        assert.ok(await pollUntil(() => t.of('inference:completed').length === 1));
        assert.equal(t.of('inference:held').length, 1);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        assert.deepEqual(t.of('inference:exhausted'), [], 'the turn never failed');
        assert.equal(t.turnCalls().length, 1, 'one request reached the provider');
        assert.match(requestText(t.turnCalls()[0]), NOTE);
        assert.equal(notesStored(t), 1, 'the note is stored once');
        assert.equal(t.alerts('context-refusal').length, 1, 'the wait is announced once');
        assert.deepEqual(t.alerts('context-refusal-clear'), [], 'a turn that runs needs no clear');
      } finally {
        await t.close();
      }
    });
  });

  it('fails as before when compression has nothing pending', async () => {
    await withCompression({ fitAt: Infinity, readyAt: 0 }, async () => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1));
        assert.deepEqual(t.of('inference:held'), []);
        assert.equal(t.alerts('context-refusal').length, 1, "the failure's own alert");
      } finally {
        await t.close();
      }
    });
  });

  it('leaves an ephemeral run refused while compression is pending to its error policy, as before', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const worker = await t.framework.deriveAgent({ name: 'worker-1', from: 'prime', mode: 'copy' });
        c.refuseFrom = c.compiles + 1;
        let settled: string | undefined;
        await t.framework.runEphemeralToCompletion(worker.agent, worker.contextManager)
          .then(() => { settled = 'resolved'; }, (error: Error) => { settled = `rejected: ${error.message}`; });
        assert.ok(settled, 'the run settled');
        assert.deepEqual(t.of('inference:held'), [], 'no wait for compression');
        assert.ok(t.of('inference:exhausted').some((e) => e.agentName === 'worker-1'), 'its error policy ran out');
      } finally {
        await t.close();
      }
    });
  });

  it('takes a sharded injection out of the window whole at the wait, so an undo of the released turn leaves none', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      let lesson = 'a short lesson';
      const t = await resident({
        maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'], context: () => lesson,
        strategy: new AutobiographicalStrategy({
          adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000, targetChunkTokens: 50,
        } as ConstructorParameters<typeof AutobiographicalStrategy>[0]),
      });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        lesson = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long lesson.`).join(' ');
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const shards = t.rows().filter((r) => r.metadata?.kind === 'context-injection' && JSON.stringify(r.content).includes('of a long lesson'));
        assert.ok(shards.length > 1, `the injection is stored as shards: ${shards.length}`);
        assert.ok(!t.windowText().includes('of a long lesson'), 'every shard left the window');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        assert.ok(await pollUntil(() => !t.internal.hasTurn('prime')), 'the turn has ended');
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        assert.ok(!t.windowText().includes('of a long lesson'), 'the undo left no injection');
      } finally {
        await t.close();
      }
    });
  });

  it("takes out of the window an injection an earlier failed attempt stored and no request carried, at the retry's wait", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: Infinity }, async (c) => {
      let lesson = 'lesson one';
      const t = await resident({ maintenanceIntervalMs: 0, context: () => lesson, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        lesson = 'lesson two';
        c.failNext = new Error('zz store unavailable');
        c.refuseFrom = c.compiles + 2;
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), "the error policy's retry was refused and waits");
        assert.ok(!t.windowText().includes('lesson two'), "the failed attempt's injection left the window");
        lesson = 'lesson three';
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const released = requestText(t.turnCalls().at(-1));
        assert.ok(released.includes('lesson three') && !released.includes('lesson two'), 'the released request has the new injection only');
      } finally {
        await t.close();
      }
    });
  });

  it('a compression call whose membrane throws a stated wait before it returns a promise records the wait', async () => {
    await withCompression({}, async () => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      try {
        const limit = new MembraneError({
          type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000,
          message: 'zz rate limited', rawError: { status: 429 },
        } as ConstructorParameters<typeof MembraneError>[0]);
        t.membrane.complete = () => { throw limit; };
        await assert.rejects(t.internal.conversationAuxiliaryMembraneFor('prime').complete({ messages: [], config: { model: 'zz-compression-model', maxTokens: 10 } }));
        assert.ok(t.internal.providerWaits.active('prime', 'zz-compression-model'), 'the wait is recorded');
      } finally {
        await t.close();
      }
    });
  });

  it("a baseline snapshot that couldn't be read gives way to the first that can, so a later summary releases the turn", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, snapshotThrows: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.snapshotThrows = false;
        t.internal.releaseBudgetHoldsOnEvidence();
        assert.ok(t.internal.budgetHolds.has('prime'), 'a snapshot that reads is no progress by itself');
        c.summaries++;
        c.fitAt = c.ticks;
        t.internal.releaseBudgetHoldsOnEvidence();
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'the summary released it');
      } finally {
        await t.close();
      }
    });
  });

  it('at the checkpoint limit, a wait and its release leave the checkpoints and the turn counter as a turn without the wait would', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const [first] = t.internal.getTurnCheckpoints('prime');
        t.internal.saveTurnCheckpoints('prime', Array.from({ length: 20 }, (_, turnIndex) => ({ ...first!, turnIndex })));
        t.internal.turnCounters.set('prime', 20);
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const waiting = t.internal.getTurnCheckpoints('prime').map((cp) => cp.turnIndex);
        assert.deepEqual(waiting, Array.from({ length: 20 }, (_, i) => i), 'the evicted checkpoint is back');
        assert.equal(t.internal.turnCounters.get('prime'), 20, 'and the counter');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const after = t.internal.getTurnCheckpoints('prime').map((cp) => cp.turnIndex);
        assert.deepEqual(after, Array.from({ length: 20 }, (_, i) => i + 1), 'one checkpoint for the turn that ran');
        assert.equal(t.internal.turnCounters.get('prime'), 21);
      } finally {
        await t.close();
      }
    });
  });

  it('takes the injections a refused start stored out of the window, so the released request has the new one only and an undo takes it', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      let lesson = 'lesson one';
      const t = await resident({ maintenanceIntervalMs: 0, context: () => lesson, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        lesson = 'lesson two';
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.ok(!t.windowText().includes('lesson two'), "the refused start's injection left the window");
        lesson = 'lesson three';
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const released = requestText(t.turnCalls().at(-1));
        assert.ok(released.includes('lesson three'), 'the released request has the new injection');
        assert.ok(!released.includes('lesson two'), 'and not the one no request carried');
        assert.ok(await pollUntil(() => !t.internal.hasTurn('prime')), 'the turn ended');
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        assert.ok(!t.windowText().includes('lesson three') && !t.windowText().includes('lesson two'), 'the undo took the turn\'s injection with it');
      } finally {
        await t.close();
      }
    });
  });

  it('waits again in a new hold when a released start is refused while compression is still pending, its note counting from the first, with one alert, no failure marker and no hard-down', async () => {
    await withCompression({ fitAt: Infinity, stalled: false }, async (c) => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => c.refusals >= 3 && t.internal.budgetHolds.has('prime')), 'released starts were refused again');
        const hold = t.internal.budgetHolds.get('prime')!;
        const wait = (hold.turn as Record<symbol, { since: number }>)[symbolNamed(hold.turn as object, 'budget-wait')]!;
        assert.equal(hold.wait, wait, 'the hold keeps the wait its turn carries');
        hold.wait.since -= 180_000;
        const refused = c.refusals;
        assert.ok(await pollUntil(() => c.refusals >= refused + 2), 'and again, each hold taking the first one\'s start from its request');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
        const held = t.of('inference:held').length;
        assert.ok(held >= 3, `a new hold for each refusal: ${held}`);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), Array(held).fill('released'));
        assert.equal(t.alerts('context-refusal').length, 1, "one alert, every hold keyed by the wait's start");
        assert.ok(!t.stored().includes('[inference-failed]'), 'no failure marker');
        assert.deepEqual(t.alerts('hard-down'), [], 'no hard-down');
        assert.equal(notesInWindow(t), 1, "each refused release's note left the window at its next hold");
        assert.match(requestText(t.turnCalls().at(-1)), /That turn waited 3 min\./, 'the figure runs from the first hold');
      } finally {
        await t.close();
      }
    });
  });

  it("a released request that fits leaves its wait behind: a provider-held retry of the turn refused for budget waits in a hold of its own, its note counting from it", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const hold = t.internal.budgetHolds.get('prime')!;
        hold.wait.since -= 180_000;
        const stream = t.membrane.streamYielding.bind(t.membrane);
        let limited = false;
        t.membrane.streamYielding = (request: NormalizedRequest, options?: unknown) => {
          if (limited) return stream(request, options);
          limited = true;
          c.fitAt = Infinity;
          c.readyAt = Infinity;
          t.membrane.calls.push(request);
          return errorStream(providerLimit());
        };
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => (t.internal.providerAccelerationCooldowns.get('prime')?.heldRequests.length ?? 0) > 0),
          'the released request fit, met a provider hold, and its retry waits there');
        t.internal.providerAccelerationCooldowns.get('prime')!.until = Date.now();
        t.internal.releaseProviderAccelerationCooldown('prime');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2), 'the retry was refused for budget, and waits');
        assert.ok(t.internal.budgetHolds.get('prime')!.wait.since > hold.wait.since + 120_000, 'in a wait of its own');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const notes = requestText(t.turnCalls().at(-1)).match(/That turn waited \d+ (s|min)\./g) ?? [];
        assert.deepEqual(notes.slice(0, -1), ['That turn waited 3 min.'], 'the first release\'s note, which a request carried, stays');
        assert.doesNotMatch(notes.at(-1)!, /3 min/, 'and the new hold\'s note counts from that hold');
      } finally {
        await t.close();
      }
    });
  });

  it("a released turn merged with a newer wake leaves its wait behind once that start fits: a provider-held retry refused for budget waits in a hold of its own", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const hold = t.internal.budgetHolds.get('prime')!;
        hold.wait.since -= 180_000;
        const stream = t.membrane.streamYielding.bind(t.membrane);
        let limited = false;
        t.membrane.streamYielding = (request: NormalizedRequest, options?: unknown) => {
          if (limited) return stream(request, options);
          limited = true;
          c.fitAt = Infinity;
          c.readyAt = Infinity;
          t.membrane.calls.push(request);
          return errorStream(providerLimit());
        };
        const starts: object[] = [];
        const start = t.internal.startAgentStream;
        t.internal.startAgentStream = async function (this: unknown, agent: unknown, trigger: Record<string, unknown>) {
          starts.push(trigger);
          return start.call(this, agent, trigger);
        };
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'zz-newer', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => (t.internal.providerAccelerationCooldowns.get('prime')?.heldRequests.length ?? 0) > 0),
          'the merged start fit, met a provider hold, and its retry waits there');
        const marks = (o: object) => Object.getOwnPropertySymbols(o).map((x) => x.description);
        assert.ok(marks(starts[0]!).includes('merged-batch') && marks(starts[0]!).includes('budget-wait'), `the start merged the two, the wait with them: ${marks(starts[0]!)}`);
        const kept = t.internal.providerAccelerationCooldowns.get('prime')!.heldRequests[0] as object;
        assert.deepEqual(marks(kept).filter((m) => m === 'merged-batch' || m === 'budget-wait'), [], 'its retry carries neither the batch nor the wait');
        t.internal.providerAccelerationCooldowns.get('prime')!.until = Date.now();
        t.internal.releaseProviderAccelerationCooldown('prime');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2), 'the retry was refused for budget, and waits');
        assert.ok(t.internal.budgetHolds.get('prime')!.wait.since > hold.wait.since + 120_000, 'in a wait of its own');
        assert.equal(t.alerts('context-refusal').length, 2, 'with its own open alert');
      } finally {
        await t.close();
      }
    });
  });

  it('when compression has nothing left and the context still does not fit, releases the wait, and the refusal takes the error policy\'s path with the note in place', async () => {
    await withWebhook(async (posts) => {
      await withCompression({ fitAt: Infinity, readyAt: 2 }, async () => {
        const t = await resident();
        try {
          t.send('Are you there?');
          assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1));
          assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
          assert.deepEqual(t.alerts('context-refusal-clear'), []);
          assert.equal(notesInWindow(t), 1, 'the note stays where it was stored');
          assert.deepEqual(t.of('ops:alert').map((e) => e.kind).filter((k) => String(k).startsWith('context-refusal')),
            ['context-refusal', 'context-refusal'], "the wait's open, then the failure's own");
          assert.ok(await pollUntil(() => posts.length === 2));
          assert.deepEqual(posts, ['context-refusal', 'context-refusal']);
        } finally {
          await t.close();
        }
      });
    });
  });

  it("presents a held first start's arrivals as they come, and one turn answers them all", async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('first');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.equal(t.internal.hasTurn('prime'), false, 'the agent is idle while it waits');
        t.send('second');
        assert.ok(await pollUntil(() => t.windowText().includes('second')), 'an arrival is presented while the first start waits');
        assert.ok(await pollUntil(() => t.hold()?.heldRequests === 2), "its wake joins the hold");
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
        assert.equal(t.turnCalls().length, 1, 'one turn');
        assert.ok(requestText(t.turnCalls()[0]).includes('first') && requestText(t.turnCalls()[0]).includes('second'));
      } finally {
        await t.close();
      }
    });
  });

  it('abortInference() ends a held turn, puts the wakes that joined it back in the queue, and clears the wait', async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered the second'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('first');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        t.send('second');
        assert.ok(await pollUntil(() => t.hold()?.heldRequests === 2));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.equal(t.framework.abortInference('prime', 'zz-stop'), true);
        assert.deepEqual(t.of('inference:aborted').map((e) => e.reason), ['zz-stop']);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /was stopped after .*, so its waiting start doesn't run/);
        assert.ok(await pollUntil(() => t.stored().includes('Answered the second')), 'the wake that joined runs as its own turn');
      } finally {
        await t.close();
      }
    });
  });

  it('stop() ends a held turn with inference:aborted, and the hold with it', async () => {
    await withCompression({ fitAt: Infinity }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('first');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        await t.framework.stop();
        assert.deepEqual(t.of('inference:aborted').map((e) => e.reason), ['shutdown']);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.alerts('context-refusal-clear').length, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('a quiesce drains at once while a turn waits, and a release that comes due meanwhile runs at resume()', async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const status = await t.framework.quiesce({ timeoutMs: 2_000 });
        assert.equal(status.drained, true);
        assert.deepEqual(status.activeTurnAgents, []);
        assert.equal(status.gatedRequests, 1, 'the held request is counted as waiting');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHoldsOnEvidence();
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 0, 'nothing runs while quiesced');
        assert.ok(t.internal.budgetHolds.has('prime'), 'a release that comes due while quiesced waits');
        await t.framework.resume();
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
      } finally {
        await t.close();
      }
    });
  });

  it('refuses nothing to a redo while it waits: its start emptied the redo stack, so there is nothing to redo', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        assert.ok(await pollUntil(() => !t.internal.hasTurn('prime')), 'the turn has ended');
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        assert.equal(t.internal.redoStacks.get('prime')?.length, 1, 'the undo left a redo entry');
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.equal(t.internal.redoStacks.get('prime')?.length ?? 0, 0, "the waiting turn's start emptied the redo stack");
        assert.deepEqual(t.framework.redo('prime'), { redone: false });
        assert.notEqual(t.hold(), null, 'it still waits');
        assert.deepEqual(t.of('inference:hold_ended'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('a wait whose evidence lands while a surgery holds the store ends after the surgery, its note stored then', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const proto = ContextManager.prototype as unknown as Patchable;
      const tick = proto.tick;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let gated = 0;
      proto.tick = async function (this: unknown, ...args: unknown[]) {
        if (c.refusing) {
          gated++;
          await gate;
        }
        return tick.apply(this, args);
      };
      const surgery = () => (t.framework as unknown as { surgeryHold: unknown }).surgeryHold;
      const notes: boolean[] = [];
      t.framework.onTrace((e) => {
        if (e.type === 'message:added' && String((e as { source?: unknown }).source).startsWith('context-injection:framework:budget-hold')) notes.push(surgery() !== null);
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && gated >= 1), 'the turn waits and its drive is in a tick');
        const suppressed = t.framework.suppressMessages('prime', { messageIds: [t.rowWith('Hi').id] });
        assert.ok(await pollUntil(() => surgery() !== null), 'the suppression holds the store, waiting for the tick');
        c.stalled = false;
        open();
        await suppressed;
        assert.ok(await pollUntil(() => notes.length >= 1), 'the note was stored');
        assert.deepEqual(notes, notes.map(() => false), 'no note is written while the surgery holds the store');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome).slice(0, 1), ['released']);
      } finally {
        proto.tick = tick;
        open();
        await t.close();
      }
    });
  });

  it('a stop begun by a listener of the retraction leaves no wait behind', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      let n = 0;
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'], context: () => `status ${n++}` });
      t.internal.budgetHoldRecheckMs = 60_000;
      let stopping: Promise<void> | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'presentation:retracted' && (e as { reason?: unknown }).reason === 'unsent-injection' && !stopping) stopping = t.framework.stop();
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => stopping !== undefined), 'the refused start retracted its injection');
        await stopping;
        assert.equal(t.internal.budgetHolds.size, 0, 'no wait is left in the stopped framework');
      } finally {
        await t.close();
      }
    });
  });

  it('a listener of the release finds the wait ended, its turn queued and its note stored, and a stop there runs nothing', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let seen: { waits: boolean; queued: boolean; note: boolean } | undefined;
      let stopping: Promise<void> | undefined;
      t.framework.onTrace((e) => {
        if (e.type !== 'inference:hold_ended' || seen) return;
        seen = {
          waits: t.internal.budgetHolds.has('prime'),
          queued: t.internal.pendingRequests.some((r) => r.agentName === 'prime'),
          note: t.stored().includes('[budget-hold]'),
        };
        stopping = t.framework.stop();
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.deepEqual(seen, { waits: false, queued: true, note: true });
        await stopping;
        assert.equal(t.internal.budgetHolds.size, 0);
        assert.equal(t.turnCalls().length, 1, 'the stop ran nothing after the first turn');
      } finally {
        await t.close();
      }
    });
  });

  it("a wait whose first hold a listener ended before its alert raises the alert at its next hold, and a stop then clears it", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let first = true;
      t.framework.onTrace((e) => {
        if (e.type !== 'inference:held' || !first) return;
        first = false;
        t.internal.releaseBudgetHold('prime');
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2 && t.internal.budgetHolds.has('prime')),
          'released before its alert, its start was refused again and waits');
        assert.equal(t.alerts('context-refusal').length, 1, "the second hold raised the wait's alert");
        assert.equal(t.framework.abortInference('prime', 'zz-stop'), true);
        assert.equal(t.alerts('context-refusal-clear').length, 1, 'the stop clears the alert it raised');
      } finally {
        await t.close();
      }
    });
  });

  it('an undo cut short releases no wait', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'heartbeat', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'a wake that reads no row waits');
        const cm = t.cm();
        const retract = cm.retractRows.bind(cm);
        cm.retractRows = ((...args: Parameters<typeof cm.retractRows>) => {
          retract(...args);
          throw new Error('zz the retraction failed after its rows left');
        }) as typeof cm.retractRows;
        assert.throws(() => t.framework.undoLastTurn('prime'), /cut short/);
        cm.retractRows = retract;
        assert.ok(t.internal.budgetHolds.has('prime'), 'the wait goes on');
        assert.equal(t.of('inference:hold_ended').length, 0, 'nothing released it');
        assert.ok(!t.stored().includes('[budget-hold]'), 'no note was written inside the unfinished undo');
      } finally {
        await t.close();
      }
    });
  });

  it("a policy retry refused while a module's restart event already waits takes the error policy's path, and the wait stays whole", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const policyErrors: Error[] = [];
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'], policyDelayMs: 1_500, policyErrors, modules: [new RestartEventModule()] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const stream = t.membrane.streamYielding.bind(t.membrane);
      let failed = false;
      t.membrane.streamYielding = (request: NormalizedRequest, options?: unknown) => {
        if (failed) return stream(request, options);
        failed = true;
        t.membrane.calls.push(request);
        return errorStream(new Error('zz the stream failed'));
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.of('inference:failed').length >= 1), "the turn's stream failed, and its policy retry sleeps");
        t.framework.pushEvent({ type: 'context_budget_restart', source: 'test', content: [], metadata: {} } as unknown as ProcessEvent);
        assert.ok(await pollUntil(() => t.internal.budgetHolds.has('prime')), "the restart event's start was refused and waits");
        const waiting = t.internal.budgetHolds.get('prime')!;
        assert.equal((waiting as { turn?: { reason?: string } }).turn?.reason, 'context_budget_restart');
        assert.equal(c.refusals, 1);
        assert.deepEqual(policyErrors.map((e) => e.message), ['zz the stream failed'], "only the stream's failure has reached the error policy");
        assert.ok(await pollUntil(() => c.refusals >= 2, 5_000), 'the policy retry woke, and its compile was refused');
        assert.ok(await pollUntil(() => policyErrors.length === 2), "the retry's refusal reached the error policy");
        assert.match(policyErrors[1]!.message, /exceed hard budget/, 'with the refusal as its error');
        assert.equal(t.internal.budgetHolds.get('prime'), waiting, 'the wait is the one that was there');
        assert.equal(t.of('inference:held').length, 1, 'the retry opened no wait of its own');
      } finally {
        await t.close();
      }
    });
  });

  it("a refused start whose checkpoint can't be dropped takes the error policy's path, and its retry waits", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const internal = t.internal as unknown as { dropTurnCheckpoint: (...args: unknown[]) => unknown };
      const drop = internal.dropTurnCheckpoint;
      let failed = 0;
      internal.dropTurnCheckpoint = function (this: unknown, ...args: unknown[]) {
        if (failed === 0) {
          failed++;
          throw new Error('zz the checkpoint list could not be saved');
        }
        return drop.apply(this, args);
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'the retry the error policy made waits');
        assert.equal(failed, 1, 'the drop failed once');
        assert.equal(c.refusals, 2, 'the first refusal went to the error policy, and its retry was refused and waits');
      } finally {
        internal.dropTurnCheckpoint = drop;
        await t.close();
      }
    });
  });

  it('a stop a listener of the retraction makes with abortInference() ends the waiting turn, as any stop of a wait does', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      let n = 0;
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'], context: () => `status ${n++}` });
      t.internal.budgetHoldRecheckMs = 60_000;
      let stopped: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'presentation:retracted' && (e as { reason?: unknown }).reason === 'unsent-injection' && stopped === undefined) stopped = t.framework.abortInference('prime', 'zz-stop');
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => stopped !== undefined), 'the refused start retracted its injection');
        assert.equal(stopped, true, 'the stop was taken');
        assert.equal(t.internal.budgetHolds.has('prime'), false, 'no wait is left for the stopped turn');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        await t.framework.runUntilIdle();
        assert.ok(!t.stored().includes('Answered go'), 'the stopped turn never runs');
      } finally {
        await t.close();
      }
    });
  });

  it("an undo's wait checks come after its checkpoints are saved", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let seen: number[] | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:hold_ended' && (e as { outcome?: string }).outcome === 'released' && !seen) seen = t.internal.getTurnCheckpoints('prime').map((cp) => cp.turnIndex);
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'heartbeat', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const before = t.internal.getTurnCheckpoints('prime').map((cp) => cp.turnIndex);
        assert.ok((t.framework.undoLastTurn('prime') as { undone: boolean }).undone, 'the undo took the completed turn');
        assert.deepEqual({ before, atRelease: seen }, { before: [0], atRelease: [] }, 'the release saw the saved checkpoints');
      } finally {
        await t.close();
      }
    });
  });

  it('an undo that finishes one cut short releases the waits it leaves', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'heartbeat', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'a wake that reads no row waits');
        const cm = t.cm();
        const retract = cm.retractRows.bind(cm);
        cm.retractRows = ((...args: Parameters<typeof cm.retractRows>) => {
          retract(...args);
          throw new Error('zz the retraction failed after its rows left');
        }) as typeof cm.retractRows;
        assert.throws(() => t.framework.undoLastTurn('prime'), /cut short/);
        cm.retractRows = retract;
        assert.equal(t.of('inference:hold_ended').length, 0, 'the cut-short undo released nothing');
        assert.ok((t.framework.undoLastTurn('prime') as { undone: boolean }).undone, 'the next undo finished it');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released'], 'and released the wait it left');
      } finally {
        await t.close();
      }
    });
  });

  it("a listener of a resume's release that quiesces leaves the host quiesced in memory and in its record", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let quiescing: Promise<unknown> | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:hold_ended' && (e as { outcome?: string }).outcome === 'released' && !quiescing) {
          quiescing = t.framework.quiesce({ timeoutMs: 2_000 }).catch((error: unknown) => `refused: ${String(error)}`);
        }
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        await t.framework.quiesce({ timeoutMs: 2_000 });
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await t.framework.resume();
        const outcome = await quiescing;
        assert.deepEqual({ memory: t.internal.quiesced, record: t.internal.readHostMode()?.quiesced === true, outcome: typeof outcome === 'string' ? outcome : 'quiesced' },
          { memory: true, record: true, outcome: 'quiesced' });
      } finally {
        await t.close();
      }
    });
  });

  it('a stop by a listener of a re-held wait clears the alert its first hold raised', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let held = 0;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:held' && ++held === 2) t.framework.abortInference('prime', 'zz-stop');
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.alerts('context-refusal').length === 1), 'the first hold raised its alert');
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => held === 2 && !t.internal.budgetHolds.has('prime')), 'refused again, its second hold was stopped');
        assert.equal(t.alerts('context-refusal-clear').length, 1, 'the stop cleared the alert that went out');
        assert.equal(t.alerts('context-refusal').length, 1, 'and raised no second open');
      } finally {
        await t.close();
      }
    });
  });

  it("a listener of a dropped wait's end finds its joined wakes back in the queue", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let queued: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:aborted' && queued === undefined && t.of('inference:held').length > 0) queued = t.internal.pendingRequests.some((r) => r.reason === 'external-message');
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        t.send('later');
        assert.ok(await pollUntil(() => t.stored().includes('later')));
        await t.internal.processInferenceRequests();
        assert.ok(t.internal.budgetHolds.get('prime')!.wakes.some((r) => r.reason === 'external-message'), 'the wake joined the wait');
        assert.ok(!t.internal.pendingRequests.some((r) => r.reason === 'external-message'), 'and left the queue');
        assert.equal(t.framework.abortInference('prime', 'zz-stop'), true);
        assert.equal(queued, true, 'the wake that joined it was queued before the turn ended');
      } finally {
        await t.close();
      }
    });
  });

  it("a surgery's sweep finishes only a wait that is still its agent's", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 1 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, secondAgent: true });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        for (const agentName of ['prime', 'second']) t.internal.pendingRequests.push({ agentName, reason: 'heartbeat', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => t.internal.budgetHolds.has('prime') && t.internal.budgetHolds.has('second')), 'both agents wait');
        for (const hold of t.internal.budgetHolds.values()) (hold as unknown as { standsOn: string[] }).standsOn = ['zz-a-row-no-store-has'];
        const [first, other] = [...t.internal.budgetHolds.keys()];
        let stopped = false;
        t.framework.onTrace((e) => {
          if (e.type === 'inference:aborted' && e.agentName === first && !stopped) {
            stopped = true;
            t.framework.abortInference(other!, 'zz-stop');
          }
        });
        t.internal.checkBudgetHoldsAfterWindowChange();
        assert.ok(stopped, "the first wait's drop ran its listener");
        const ended = t.of('inference:hold_ended').filter((e) => e.agentName === other);
        assert.deepEqual(ended.map((e) => e.outcome), ['stopped'], 'the other wait ended once, by its stop');
        assert.equal(t.of('inference:aborted').filter((e) => e.agentName === other).length, 1, 'with one inference:aborted');
      } finally {
        await t.close();
      }
    });
  });

  it('a message that joins a provider-held retry waiting for compression is answered by that retry, as on main for a provider hold', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered go', 'Answered MID'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        const stream = t.membrane.streamYielding.bind(t.membrane);
        let limited = false;
        t.membrane.streamYielding = (request: NormalizedRequest, options?: unknown) => {
          if (limited) return stream(request, options);
          limited = true;
          c.refuseFrom = c.compiles + 1;
          c.readyAt = Infinity;
          t.membrane.calls.push(request);
          return errorStream(providerLimit());
        };
        t.send('go');
        assert.ok(await pollUntil(() => (t.internal.providerAccelerationCooldowns.get('prime')?.heldRequests.length ?? 0) > 0), 'parked');
        t.internal.providerAccelerationCooldowns.get('prime')!.until = Date.now();
        t.internal.releaseProviderAccelerationCooldown('prime');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'its provider-held retry waits for compression');
        t.send('MID');
        assert.ok(await pollUntil(() => t.stored().includes('MID')));
        assert.ok(await pollUntil(() => (t.internal.budgetHolds.get('prime')?.wakes.length ?? 0) === 1), "MID's wake joined the wait before its release");
        const calls = t.turnCalls().length;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        await t.framework.runUntilIdle();
        const after = t.turnCalls().slice(calls);
        assert.equal(after.length, 1, 'one turn ran');
        assert.ok(JSON.stringify(after[0]).includes('MID'), 'and its request read the arrival');
      } finally {
        await t.close();
      }
    });
  });

  it("a stop reached from the gate's flush comes after the wait is announced, and clears its alert", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'], gate: true });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const gate = t.internal.eventGate as unknown as { onInferenceEnded(name: string): void };
        const ended = gate.onInferenceEnded.bind(gate);
        let stopped = false;
        gate.onInferenceEnded = (name: string) => {
          ended(name);
          if (name === 'prime' && !stopped && t.internal.budgetHolds.has('prime')) {
            stopped = true;
            t.framework.abortInference('prime', 'zz-stop');
          }
        };
        t.send('go');
        assert.ok(await pollUntil(() => stopped), "the gate's flush reached a stop while the turn waited");
        const types = t.traces.map((e) => e.type);
        assert.ok(types.indexOf('inference:held') >= 0 && types.indexOf('inference:held') < types.indexOf('inference:hold_ended'), 'announced before it ended');
        assert.equal(t.alerts('context-refusal-clear').length, 1, 'and its alert cleared');
      } finally {
        await t.close();
      }
    });
  });

  it("refuses the reply judge's calls about an agent whose turn waits, holding a judge rule's batch under onError \"skip\", and asks once the wait ends", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'], judged: true });
      t.internal.budgetHoldRecheckMs = 60_000;
      const judged: NormalizedRequest[] = [];
      t.membrane.complete = async (request: NormalizedRequest) => {
        judged.push(request);
        return createMockResponse([text('WAIT: chatter')]);
      };
      const gate = t.internal.eventGate as unknown as {
        evaluate(event: Record<string, unknown>): unknown;
        getStatus(): { policies: Array<{ judgeState?: { heldCount: number; verdicts: Record<string, number> } }> };
      };
      const judge = () => gate.getStatus().policies[0]!.judgeState!;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'the turn waits for compression');
        gate.evaluate({ content: 'is prime around?', eventType: 'mcpl:push-event', serverId: 'discord', channelId: 'c1', metadata: { authorId: 'u1', channelName: 'garden' } });
        assert.ok(await pollUntil(() => Object.values(judge().verdicts).some((n) => n > 0)), 'the judge rule decided its batch');
        assert.deepEqual(judge().verdicts, { reply: 0, wait: 0, error: 0, refused: 1 }, 'its call was refused while the turn waits');
        assert.equal(judge().heldCount, 1, 'and its batch is held for the judge');
        assert.equal(judged.length, 0, 'no judge call was made');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'the waiting turn runs');
        assert.ok(await pollUntil(() => judge().verdicts.wait === 1), 'the held batch is asked once the wait ends');
        assert.equal(judged.length, 1);
        assert.equal(judge().heldCount, 0);
      } finally {
        await t.close();
      }
    });
  });

  it("asks the reply judge about a judge rule's batch held while the agent's turn waited, once a stop ends the wait", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'], judged: true });
      t.internal.budgetHoldRecheckMs = 60_000;
      const judged: NormalizedRequest[] = [];
      t.membrane.complete = async (request: NormalizedRequest) => {
        judged.push(request);
        return createMockResponse([text('WAIT: chatter')]);
      };
      const gate = t.internal.eventGate as unknown as {
        evaluate(event: Record<string, unknown>): unknown;
        getStatus(): { policies: Array<{ judgeState?: { heldCount: number; verdicts: Record<string, number> } }> };
      };
      const judge = () => gate.getStatus().policies[0]!.judgeState!;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'the turn waits for compression');
        gate.evaluate({ content: 'is prime around?', eventType: 'mcpl:push-event', serverId: 'discord', channelId: 'c1', metadata: { authorId: 'u1', channelName: 'garden' } });
        assert.ok(await pollUntil(() => judge().verdicts.refused === 1 && judge().heldCount === 1), 'its call refused and its batch held while the turn waits');
        assert.equal(t.framework.abortInference('prime', 'zz-stop'), true);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.ok(await pollUntil(() => judge().verdicts.wait === 1), 'the held batch is asked once the stop ends the wait');
        assert.equal(judged.length, 1);
        assert.equal(judge().heldCount, 0);
      } finally {
        await t.close();
      }
    });
  });

  it("a surgery's drop of a waiting turn queues its joined wakes before the turn's end is traced", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let queued: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:aborted' && queued === undefined && t.of('inference:held').length > 0) queued = t.internal.pendingRequests.some((r) => r.reason === 'heartbeat');
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'heartbeat', source: 'test', timestamp: Date.now() });
        await t.internal.processInferenceRequests();
        assert.ok(t.internal.budgetHolds.get('prime')!.wakes.some((r) => r.reason === 'heartbeat'), 'the wake joined the wait');
        assert.ok(!t.internal.pendingRequests.some((r) => r.reason === 'heartbeat'), 'and left the queue');
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
        assert.equal(queued, true, 'the wake that joined it was queued before the turn ended');
      } finally {
        await t.close();
      }
    });
  });

  it("an undo whose checkpoint save fails drops a wait whose row it took out after its own trace", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let afterUndone: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:hold_ended' && afterUndone === undefined) afterUndone = t.of('window:undone').length > 0;
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const save = t.internal.saveTurnCheckpoints.bind(t.internal);
        t.internal.saveTurnCheckpoints = () => { throw new Error('zz the checkpoint list could not be saved'); };
        assert.throws(() => t.framework.undoLastTurn('prime'), /saving its checkpoints failed/);
        t.internal.saveTurnCheckpoints = save;
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed'], 'the wait whose row left was dropped');
        assert.equal(afterUndone, true, "after the undo's own trace");
      } finally {
        await t.close();
      }
    });
  });

  it('an undo whose checkpoint save fails releases no wait', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'heartbeat', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const save = t.internal.saveTurnCheckpoints.bind(t.internal);
        t.internal.saveTurnCheckpoints = () => { throw new Error('zz the checkpoint list could not be saved'); };
        assert.throws(() => t.framework.undoLastTurn('prime'), /saving its checkpoints failed/);
        t.internal.saveTurnCheckpoints = save;
        assert.equal(t.of('inference:hold_ended').length, 0, 'nothing released it');
        assert.ok(t.internal.budgetHolds.has('prime'), 'the wait goes on');
      } finally {
        await t.close();
      }
    });
  });

  it("an undo cut short drops a wait whose row it took out after its own trace", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      let afterUndone: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:hold_ended' && afterUndone === undefined) afterUndone = t.of('window:undone').length > 0;
      });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const cm = t.cm();
        const retract = cm.retractRows.bind(cm);
        let calls = 0;
        cm.retractRows = ((...args: Parameters<typeof cm.retractRows>) => {
          retract(...args);
          if (++calls === 2) throw new Error('zz the retraction failed after its rows left');
        }) as typeof cm.retractRows;
        assert.throws(() => t.framework.undoLastTurn('prime'), /cut short/);
        cm.retractRows = retract;
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed'], 'the wait whose row left was dropped');
        assert.equal(afterUndone, true, "after the undo's own trace");
      } finally {
        await t.close();
      }
    });
  });

  it("a resume whose record write throws still ends the waits it holds", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const internal = t.internal as unknown as { persistHostMode(mode: unknown): void };
      const persist = internal.persistHostMode;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        await t.framework.quiesce({ timeoutMs: 2_000 });
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        internal.persistHostMode = function (this: unknown, mode: unknown) {
          if (mode === null) throw new Error('zz the host-mode record could not be written');
          return persist.call(this, mode);
        };
        await assert.rejects(t.framework.resume(), /could not be written/);
        internal.persistHostMode = persist;
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released'], 'the wait ended all the same');
      } finally {
        internal.persistHostMode = persist;
        await t.close();
      }
    });
  });

  it("an inference:held listener finds the host drained, the refused start's turn token given back", async () => {
    await withCompression({ fitAt: Infinity }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 60_000;
      let drained: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:held' && drained === undefined) drained = t.framework.getHostModeStatus().drained;
      });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.equal(drained, true);
      } finally {
        await t.close();
      }
    });
  });

  it("counts the wakes merged in a request a waiting turn keeps one by one among the gated requests", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        const mark = await mergedBatchMark(t);
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const wake = (reason: string) => ({ agentName: 'prime', reason, source: 'test', timestamp: Date.now() });
        t.internal.budgetHolds.get('prime')!.wakes.push({ ...wake('zz-merged'), [mark]: [wake('zz-a'), wake('zz-b')] } as never);
        assert.equal(t.framework.getHostModeStatus().gatedRequests, 3, 'the waiting turn, and the two wakes merged in the request it keeps');
        assert.equal(t.hold()?.heldRequests, 3, "and the agent's health counts them the same way");
        t.internal.budgetHolds.get('prime')!.wakes.push(wake('context_budget_restart') as never);
        assert.equal(t.framework.getHostModeStatus().gatedRequests, 3, 'a restart a quiesce lets through is not a gated request');
        assert.equal(t.hold()?.heldRequests, 3, "and the agent's health leaves it out the same way");
      } finally {
        await t.close();
      }
    });
  });

  it('counts a closure wake merged behind another wake as one its agent waits on', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      try {
        const mark = await mergedBatchMark(t);
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const wake = (reason: string) => ({ agentName: 'prime', reason, source: 'test', timestamp: Date.now() });
        const internal = t.internal as unknown as { closureWaits(name: string): boolean };
        t.internal.pendingRequests.push({ ...wake('zz-merged'), [mark]: [wake('zz-a'), wake('conversation:closure')] } as never);
        assert.equal(internal.closureWaits('prime'), true);
      } finally {
        await t.close();
      }
    });
  });

  it('a policy retry refused for budget gives back each provider admission its frames took, once', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const internal = t.internal as unknown as { acquirePrimaryProviderGate(name: string): void; releasePrimaryProviderGate(name: string): void };
      const acquire = internal.acquirePrimaryProviderGate;
      const release = internal.releasePrimaryProviderGate;
      const counts = { acquired: 0, released: 0 };
      const frames = { open: 0 };
      const startStream = t.internal.startAgentStream;
      t.internal.startAgentStream = async function (this: unknown, ...args: Parameters<typeof startStream>) {
        frames.open++;
        try {
          return await startStream.apply(this, args);
        } finally {
          frames.open--;
        }
      };
      internal.acquirePrimaryProviderGate = function (this: unknown, name: string) { if (name === 'prime') counts.acquired++; return acquire.call(this, name); };
      internal.releasePrimaryProviderGate = function (this: unknown, name: string) { if (name === 'prime') counts.released++; return release.call(this, name); };
      const stream = t.membrane.streamYielding.bind(t.membrane);
      let failed = false;
      t.membrane.streamYielding = (request: NormalizedRequest, options?: unknown) => {
        if (failed) return stream(request, options);
        failed = true;
        t.membrane.calls.push(request);
        return errorStream(new Error('zz the stream failed'));
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), "the stream failed, and its policy retry's compile was refused and waits");
        assert.ok(await pollUntil(() => frames.open === 0), 'every frame of the turn unwound');
        assert.ok(counts.acquired >= 1);
        assert.deepEqual(counts, { acquired: counts.acquired, released: counts.acquired }, 'each admission given back once');
      } finally {
        internal.acquirePrimaryProviderGate = acquire;
        internal.releasePrimaryProviderGate = release;
        await t.close();
      }
    });
  });

  it("a silent start's provider-held retry that waits for budget stands on the start's row, so a rollback that removes it drops the retry", async () => {
    await withCompression({ fitAt: 0, refuseFrom: 1 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered quietly'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const stream = t.membrane.streamYielding.bind(t.membrane);
        let limited = false;
        t.membrane.streamYielding = (request: NormalizedRequest, options?: unknown) => {
          if (limited) return stream(request, options);
          limited = true;
          c.fitAt = Infinity;
          c.readyAt = Infinity;
          t.membrane.calls.push(request);
          return errorStream(providerLimit());
        };
        t.sendForPrime('go');
        (t.internal.pendingRequests.at(-1) as Record<string, unknown>).suppressProse = true;
        assert.ok(await pollUntil(() => (t.internal.providerAccelerationCooldowns.get('prime')?.heldRequests.length ?? 0) > 0), 'the silent start met a provider hold');
        t.internal.providerAccelerationCooldowns.get('prime')!.until = Date.now();
        t.internal.releaseProviderAccelerationCooldown('prime');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'its retry was refused for budget, and waits');
        const standsOn = (t.internal.budgetHolds.get('prime') as unknown as { standsOn: string[] }).standsOn;
        assert.ok(standsOn.includes(String(t.rowWith('go').id)), "the retry stands on the start's row");
        const calls = t.turnCalls().length;
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed'], 'the rollback dropped the waiting retry');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, calls, 'nothing ran on what the rollback left');
      } finally {
        await t.close();
      }
    });
  });

  it('admits a surgery while a turn waits, keeps a held first start whose row is untouched, and drops one whose row a rollback removed', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const refused = c.refusals;
        await t.framework.suppressMessages('prime', { messageIds: [t.rowWith('Hi').id] });
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released'], 'a suppression of another row releases the held start, not drops it');
        assert.ok(await pollUntil(() => c.refusals > refused && t.internal.budgetHolds.has('prime')),
          'its start was refused again, and waits again');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released', 'removed'], 'the rollback dropped it as it ended');
        assert.equal(t.of('inference:aborted').length, 1, 'the held turn ends');
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /was removed or taken out of its window after .*, so its waiting start doesn't run/);
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'no turn ran for the removed row');
      } finally {
        await t.close();
      }
    });
  });

  it('admits a branch switch, a puppet call and an undo while a first start waits, and a start whose trigger reads no row keeps waiting', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'], modules: [new PingModule()] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const store = (t.framework as unknown as { store: { currentBranch(): { name: string } } }).store;
        const before = store.currentBranch().name;
        const waitingAgain = async () => {
          const refused = c.refusals;
          assert.ok(await pollUntil(() => c.refusals > refused && t.internal.budgetHolds.has('prime')),
            'released by the change, and refused again');
        };
        let next = waitingAgain();
        await t.framework.suppressMessages('prime', { messageIds: [t.rowWith('Hi').id] });
        await next;
        next = waitingAgain();
        await t.framework.switchBranch(before);
        await next;
        assert.equal(store.currentBranch().name, before, 'the branch switch was admitted');
        const puppet = await t.framework.puppetToolCall('prime', 'pings--ping', {});
        assert.equal(puppet.result.success, true, 'the puppet call was admitted');
        next = waitingAgain();
        assert.equal(t.framework.undoLastTurn('prime').undone, true, 'the undo was admitted');
        await next;
        assert.notEqual(t.hold(), null, 'the start still waits');
        assert.ok(t.of('inference:hold_ended').every((e) => e.outcome === 'released'), 'each change released it, and none dropped it');
      } finally {
        await t.close();
      }
    });
  });

  it('drops a released first start still in the queue when a surgery removes its row', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1), 'dropped as it starts');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'the queued start never ran');
      } finally {
        await t.close();
      }
    });
  });

  it('takes a released first start out of the start it was merged into once a surgery removed its row, and the wakes merged with it run', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered second'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        t.send('second');
        assert.ok(await pollUntil(() => t.hold()?.heldRequests === 2));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        await t.framework.suppressMessages('prime', { messageIds: [t.rowWith('go').id] });
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1), 'dropped as it starts');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        assert.ok(await pollUntil(() => t.stored().includes('Answered second')), 'the wake merged with it runs as a turn of its own');
        const last = t.turnCalls().at(-1);
        assert.ok(requestText(last).includes('second') && !requestText(last).includes('"go"'));
      } finally {
        await t.close();
      }
    });
  });

  it('drops a released first start a provider wait kept, once a surgery removed its row', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, calls: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const complete = t.membrane.complete.bind(t.membrane);
      let rateLimit = false;
      let limited = false;
      t.membrane.complete = async (request: NormalizedRequest) => {
        if (!rateLimit) return complete(request);
        rateLimit = false;
        limited = true;
        throw new MembraneError({
          type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 600_000,
          message: 'zz rate limit reached for requests', rawError: { status: 429 }, rawRequest: request,
        });
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        rateLimit = true;
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.ok(await pollUntil(() => limited), "compression's call met the provider's stated wait");
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => (t.internal.providerAccelerationCooldowns.get('prime')?.heldRequests.length ?? 0) > 0),
          'the released start waits in the provider hold');
        assert.equal(t.internal.hasTurn('prime'), false);
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.framework.releaseProviderWait('prime');
        const cooldown = t.internal.providerAccelerationCooldowns.get('prime');
        if (cooldown) {
          cooldown.until = Date.now();
          t.internal.releaseProviderAccelerationCooldown('prime');
        }
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1), 'dropped as it starts');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'the start the provider wait kept never ran');
      } finally {
        await t.close();
      }
    });
  });

  it('releases nothing while compression calls fail, and runs the turn once a call lands and makes progress', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, calls: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 50;
      let failing = false;
      let failed = 0;
      const complete = t.membrane.complete.bind(t.membrane);
      t.membrane.complete = async (request: NormalizedRequest) => {
        if (!failing) return complete(request);
        failed++;
        throw new Error('zz compression call failed');
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        failing = true;
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const refused = c.refusals;
        assert.ok(await pollUntil(() => failed >= 5), 'the recheck keeps driving compression');
        assert.equal(c.refusals, refused, 'no failed call released the turn');
        assert.ok(t.internal.budgetHolds.has('prime') && t.of('inference:hold_ended').length === 0, 'the turn still waits');
        c.fitAt = c.ticks;
        failing = false;
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'a call that landed and made progress released it');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
      } finally {
        await t.close();
      }
    });
  });

  it('for a strategy with no progress snapshot, a failed call releases nothing and one that lands releases the turn', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, calls: true, snapshot: false }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 50;
      let failing = false;
      let failed = 0;
      const complete = t.membrane.complete.bind(t.membrane);
      t.membrane.complete = async (request: NormalizedRequest) => {
        if (!failing) return complete(request);
        failed++;
        throw new Error('zz compression call failed');
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        failing = true;
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const refused = c.refusals;
        assert.ok(await pollUntil(() => failed >= 5), 'the recheck keeps driving compression');
        assert.equal(c.refusals, refused, 'no failed call released the turn');
        assert.ok(t.internal.budgetHolds.has('prime') && t.of('inference:hold_ended').length === 0, 'the turn still waits');
        c.fitAt = c.ticks;
        failing = false;
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'a call that landed released it');
      } finally {
        await t.close();
      }
    });
  });

  it("a maintenance pass's end releases a waiting turn once compression has nothing left pending", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ replies: ['Hi', 'Answered go'] });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const ticks = c.ticks;
        assert.ok(await pollUntil(() => c.ticks >= ticks + 3), 'passes tick while it waits');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
      } finally {
        await t.close();
      }
    });
  });

  it('takes the wait\'s baseline before the refused compile, so progress made during the compile releases the turn', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ replies: ['Hi', 'Answered go'] });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const releases = watchReleases(t.framework, () => true);
        c.onRefusal = () => {
          c.onRefusal = undefined;
          c.progress++;
        };
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length >= 1));
        assert.ok(await pollUntil(() => releases.all >= 1), 'what compression wrote during the compile released the turn');
      } finally {
        await t.close();
      }
    });
  });

  it('a progress snapshot that could not be read at the refusal is not progress when it next reads', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ replies: ['Hi', 'Answered go'] });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        c.snapshotThrows = true;
        c.onRefusal = () => {
          c.onRefusal = undefined;
          c.snapshotThrows = false;
        };
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const refused = c.refusals;
        const ticks = c.ticks;
        assert.ok(await pollUntil(() => c.ticks >= ticks + 5), 'passes keep ticking compression');
        assert.equal(c.refusals, refused, 'the snapshot reading again released nothing');
        assert.ok(t.internal.budgetHolds.has('prime') && t.of('inference:hold_ended').length === 0, 'the turn still waits');
      } finally {
        await t.close();
      }
    });
  });

  it('a progress snapshot with neither of its fields counts as none, so a call that lands releases the turn', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, calls: true, snapshotOther: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 50;
      let failing = false;
      const complete = t.membrane.complete.bind(t.membrane);
      t.membrane.complete = async (request: NormalizedRequest) => {
        if (failing) throw new Error('zz compression call failed');
        return complete(request);
      };
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        failing = true;
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        failing = false;
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'a call that landed released it');
      } finally {
        await t.close();
      }
    });
  });

  it('a tick that lands a call without moving the progress snapshot ends the drive', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, calls: true, stalled: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        const ticks = c.ticks;
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.ok(await pollUntil(() => c.ticks > ticks && !t.internal.overBudgetDrainInFlight.has('prime')), 'the drive ticked, and ended');
        const driven = c.ticks - ticks;
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(driven >= 1 && driven <= 2, `the drive stopped after its tick: ${driven} ticks`);
        assert.equal(c.ticks - ticks, driven, 'and nothing ticks after it');
        assert.notEqual(t.hold(), null, 'the turn still waits');
      } finally {
        await t.close();
      }
    });
  });

  it('setting a live context setting to the value it has is no settings change', async () => {
    await withCompression({ fitAt: Infinity }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      try {
        const agent = t.framework.getAgent('prime')! as unknown as {
          contextSettingsChanges(): number;
          updateHotContextSettings(update: { tailTokens?: number }): unknown;
          getContextManager(): Record<string, unknown>;
        };
        let tail = 1_000;
        const cm = agent.getContextManager();
        cm.getHotContextSettings = () => ({ tailTokens: tail, prepared: true });
        cm.updateHotContextSettings = (update: { tailTokens?: number }) => {
          tail = update.tailTokens ?? tail;
          return { tailTokens: tail, prepared: true };
        };
        const before = agent.contextSettingsChanges();
        agent.updateHotContextSettings({ tailTokens: 1_000 });
        assert.equal(agent.contextSettingsChanges(), before, 'the same value changes nothing');
        agent.updateHotContextSettings({ tailTokens: 2_000 });
        assert.equal(agent.contextSettingsChanges(), before + 1, 'a new value is a change');
      } finally {
        await t.close();
      }
    });
  });

  it('a maintenance pass releases a waiting turn only on evidence: stalled compression re-runs nothing, and a budget change releases it', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, stalled: true }, async (c) => {
      const t = await resident({ replies: ['Hi', 'Answered go'] });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const refused = c.refusals;
        let ticks = c.ticks;
        assert.ok(await pollUntil(() => c.ticks >= ticks + 5), 'passes keep ticking compression');
        assert.equal(c.refusals, refused, 'no pass ran the refused start again');
        assert.ok(t.internal.budgetHolds.has('prime') && t.of('inference:hold_ended').length === 0, 'the turn still waits');
        c.fitAt = c.ticks;
        ticks = c.ticks;
        assert.ok(await pollUntil(() => c.ticks >= ticks + 3));
        assert.ok(!t.stored().includes('Answered go'), 'a fit nothing on the list reports waits');
        const budget = t.framework.getAgentRuntimeSettings('prime').contextBudgetTokens;
        t.framework.updateAgentRuntimeSettings('prime', { contextBudgetTokens: budget + 10_000 });
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'the budget change released it');
      } finally {
        await t.close();
      }
    });
  });

  it("a released start the inference policy drops leaves its note in the window, true for whichever turn reads it, and the agent's next hold counts from its own start", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      let refuse = false;
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered later'], policy: { shouldInfer: () => !refuse } });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const hold = t.internal.budgetHolds.get('prime')!;
        hold.wait.since -= 180_000;
        refuse = true;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        await t.framework.runUntilIdle();
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        assert.equal(t.turnCalls().length, 1, 'the policy dropped the released start');
        assert.match(t.windowText(), /when a turn came to start\. That turn waited 3 min\./, 'its note stays in the window');
        refuse = false;
        c.fitAt = Infinity;
        c.readyAt = Infinity;
        t.send('later');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2));
        assert.ok(t.internal.budgetHolds.get('prime')!.wait.since > hold.wait.since + 120_000, 'the new hold starts its own wait');
        assert.equal(notesInWindow(t), 0, "the dropped start's note, which no request carried, left the window at the new hold");
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered later')));
        const last = requestText(t.turnCalls().at(-1));
        assert.match(last, NOTE);
        assert.doesNotMatch(last, /waited 3 min/, "the new hold's figure starts at its own start");
      } finally {
        await t.close();
      }
    });
  });

  it("a provider hold that already keeps an equal request without the wait takes the wait onto it, so a surgery that removes its row drops it", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const held = t.internal.budgetHolds.get('prime')!.turn as Record<string, unknown>;
        assert.ok(t.internal.holdProviderAcceleration(t.framework.getAgent('prime'), providerLimit()), 'a provider hold parks the agent');
        t.internal.pendingRequests.push(stringKeys(held));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        await t.framework.runUntilIdle();
        const kept = t.internal.providerAccelerationCooldowns.get('prime')?.heldRequests ?? [];
        assert.equal(kept.length, 1, 'the provider hold kept one request for both');
        assert.ok(Object.getOwnPropertySymbols(kept[0]!).some((x) => x.description === 'budget-wait'), 'with the wait on it');
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        t.internal.providerAccelerationCooldowns.get('prime')!.until = Date.now();
        t.internal.releaseProviderAccelerationCooldown('prime');
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1), 'dropped as it starts');
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'the request it kept never ran');
      } finally {
        await t.close();
      }
    });
  });

  it('a merged start carrying a wait that no member of its batch carries puts the folded request back in its own place, so a member read before takes none of it', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered other'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        const MERGED = await mergedBatchMark(t);
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const held = t.internal.budgetHolds.get('prime')!.turn as object;
        const WAIT = symbolNamed(held, 'budget-wait');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        t.internal.pendingRequests.splice(0, t.internal.pendingRequests.length);
        t.internal.pendingRequests.push(Object.assign(stringKeys(held), {
          [WAIT]: (held as Record<symbol, unknown>)[WAIT],
          [MERGED]: [
            { agentName: 'prime', reason: 'zz-read', source: 'test', timestamp: Date.now(), readsRow: 'zz-a-row-that-is-gone' },
            { agentName: 'prime', reason: 'zz-other', source: 'test', timestamp: Date.now() },
          ],
        }));
        await t.framework.suppressMessages('prime', { messageIds: [t.rowWith('go').id] });
        await t.internal.processInferenceRequests();
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1), 'the start carrying the wait was dropped, its row gone');
        assert.ok(await pollUntil(() => t.stored().includes('Answered other')), 'the wake merged with it runs as its own turn');
      } finally {
        await t.close();
      }
    });
  });

  it("a progress snapshot that can't be serialized reads as none, and the wait still holds", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2, snapshotBigInt: true }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'the start reached its compile and waits');
        t.internal.releaseBudgetHoldsOnEvidence();
        assert.ok(t.internal.budgetHolds.has('prime'));
      } finally {
        await t.close();
      }
    });
  });

  it('a withdrawal takes a wake out of a hold', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const hold = t.internal.budgetHolds.get('prime')! as unknown as { turn: Record<string, unknown>; wakes: Array<Record<string, unknown>> };
        hold.wakes.push({ agentName: 'prime', reason: 'zz-coalesced', source: 'test', timestamp: Date.now(), coalescingSubject: 'zz-subject' });
        t.internal.cancelCoalescedWakes('zz-subject');
        assert.deepEqual(hold.wakes, [], 'the withdrawn wake is gone from the hold');
        assert.ok(t.internal.budgetHolds.has('prime'), 'and the held turn still waits');
      } finally {
        await t.close();
      }
    });
  });

  it('abortInference() between a release and its start leaves the released first start to run, as a queued wake does', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.equal(t.framework.abortInference('prime', 'zz-stop'), false, 'nothing is in flight to stop');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')), 'the released start runs');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        assert.deepEqual(t.of('inference:aborted'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('a surgery that drops a held turn ends its hold, and a wake that joined it runs as a turn of its own with no note', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered second'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        t.send('second');
        assert.ok(await pollUntil(() => t.hold()?.heldRequests === 2));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await t.framework.suppressMessages('prime', { messageIds: [t.rowWith('go').id] });
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
        assert.ok(await pollUntil(() => t.stored().includes('Answered second')), 'the joined wake runs');
        assert.equal(notesStored(t), 0, 'with no note');
        assert.equal(t.of('inference:held').length, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('a released held turn parked by a quiesce keeps its own place beside a newer wake', async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered both'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        const held = t.internal.budgetHolds.get('prime')!.turn;
        t.internal.releaseBudgetHold('prime');
        await t.framework.quiesce({ timeoutMs: 2_000 });
        t.send('newer');
        assert.ok(await pollUntil(() => t.stored().includes('newer')));
        await t.internal.processInferenceRequests();
        assert.ok(t.internal.pendingRequests.includes(held as Record<string, unknown>), 'the newer wake did not absorb it');
        assert.ok(t.internal.pendingRequests.some((r) => r !== held && r.agentName === 'prime'), 'and the newer wake waits beside it');
        await t.framework.resume();
        assert.ok(await pollUntil(() => t.stored().includes('Answered both')));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
      } finally {
        await t.close();
      }
    });
  });

  it("an undo that takes a waiting first start's message out of the window drops the start", async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
        assert.equal(t.of('inference:aborted').length, 1);
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'nothing answers the message the undo took out');
      } finally {
        await t.close();
      }
    });
  });

  it('drives compression itself with the maintenance timer off, and runs the turn as soon as a call makes room', async () => {
    await withCompression({ fitAt: 3, calls: true }, async () => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit'), 5_000));
      } finally {
        await t.close();
      }
    });
  });

  it('with the maintenance timer off and no call to make, looks again an interval later', async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 100;
      try {
        const ticks = c.ticks;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.ok(await pollUntil(() => c.ticks > ticks && !t.internal.overBudgetDrainInFlight.has('prime')), 'its first drive ticked, and ended');
        assert.notEqual(t.hold(), null, 'the turn still waits');
        c.fitAt = 0;
        c.readyAt = 0;
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit'), 3_000));
      } finally {
        await t.close();
      }
    });
  });

  it('gives a waiting turn in healthSnapshot()', async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.hold() !== null));
        const hold = t.hold()!;
        assert.equal(hold.errorType, 'over_budget');
        assert.equal(hold.budget, 48_568);
        assert.equal(hold.actual, 100_201);
        assert.equal(hold.heldRequests, 1);
        assert.equal(hold.pending, 'zz compression pending');
        assert.equal(typeof hold.since, 'number');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
        assert.equal(t.hold(), null);
      } finally {
        await t.close();
      }
    });
  });

  it('a released start that fails for another reason takes that error\'s path, as a start with no wait does', async () => {
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0 });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.failNext = new Error('zz store unavailable');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')), "the error policy's retry runs it");
        assert.equal(c.failNext, undefined, 'the released start met the error');
        assert.ok(t.of('inference:failed').some((e) => String(e.error).includes('zz store unavailable')), 'and failed on it');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['released']);
        assert.deepEqual(t.alerts('context-refusal-clear'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('each of two holds within the webhook cooldown reaches it with its open and its clear', async () => {
    await withWebhook(async (posts) => {
      await withCompression({ fitAt: Infinity }, async () => {
        const t = await resident({ maintenanceIntervalMs: 0 });
        t.internal.budgetHoldRecheckMs = 60_000;
        try {
          t.send('first');
          assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
          t.framework.abortInference('prime');
          t.send('second');
          assert.ok(await pollUntil(() => t.of('inference:held').length === 2));
          t.framework.abortInference('prime');
          assert.ok(await pollUntil(() => posts.length === 4));
          assert.deepEqual(posts, ['context-refusal', 'context-refusal-clear', 'context-refusal', 'context-refusal-clear']);
        } finally {
          await t.close();
        }
      });
    });
  });
});

describe("the hold's note is stored at its release, where its turn's request reads it", () => {
  const thinking = (answer: string) => createMockResponse([
    { type: 'thinking', thinking: `reasoning for ${answer}`, signature: `sig-${answer}` } as ContentBlock, text(answer)]);

  it('stores the note once, after the message, so the next start keeps the prefix and the reply its thinking', async () => {
    await withCompression({ fitAt: 3 }, async () => {
      const t = await resident({ binds: true, replies: [thinking('reply one'), thinking('reply two')] });
      try {
        t.send('one');
        assert.ok(await pollUntil(() => t.stored().includes('reply one')));
        assert.equal(notesStored(t), 1);
        const order = t.rows().map((r) => r.content.map((b) => b.text ?? b.type).join(''));
        const at = order.findIndex((b) => b.includes('[budget-hold]'));
        assert.ok(order[at - 1]!.includes('one') && order[at + 1]!.includes('reply one'), JSON.stringify(order));
        t.send('two');
        assert.ok(await pollUntil(() => t.stored().includes('reply two')));
        const [released, next] = t.turnCalls();
        assert.deepEqual(next!.messages.slice(0, released!.messages.length), released!.messages, 'the next request starts with the released one, byte for byte');
        assert.ok(JSON.stringify(next!.messages).includes('reasoning for reply one'), 'the reply keeps its thinking');
      } finally {
        await t.close();
      }
    });
  });

  it('gives the note to a released wake whose window ends on the agent\'s own reply, and the next start keeps the prefix', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ replies: ['Hi', 'Woke', 'Answered three'] });
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'test', timestamp: Date.now() });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Woke')));
        assert.equal(notesStored(t), 1);
        c.refuseFrom = Infinity;
        t.send('three');
        assert.ok(await pollUntil(() => t.stored().includes('Answered three')));
        const calls = t.turnCalls();
        const released = calls[1]!;
        const next = calls[2]!;
        assert.match(requestText(released), NOTE);
        const read = released.messages.filter((m) => JSON.stringify(m) !== JSON.stringify({ participant: 'user', content: [text('[Continue]')] }));
        assert.deepEqual(next.messages.slice(0, read.length), read, 'the next request starts with what the released one read, byte for byte');
      } finally {
        await t.close();
      }
    });
  });

  it("gives the note to a person's held message whose refused start stored an injection after it, and the next start keeps the prefix", async () => {
    let n = 0;
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ context: () => `status ${++n}`, replies: ['Answered one', 'Answered two'] });
      try {
        t.send('one');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Answered one')));
        assert.equal(notesStored(t), 1);
        t.send('two');
        assert.ok(await pollUntil(() => t.stored().includes('Answered two')));
        const [released, next] = t.turnCalls();
        assert.match(requestText(released), NOTE);
        assert.deepEqual(next!.messages.slice(0, released!.messages.length), released!.messages);
      } finally {
        await t.close();
      }
    });
  });

  it("gives the note the wait up to the release, not the start's time after it", async () => {
    await withCompression({ stalled: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const hold = t.internal.budgetHolds.get('prime')!;
        const held = hold.turn!;
        hold.wait.since = Date.now() - 3_000;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        const releasing = Date.now();
        t.internal.releaseBudgetHold('prime');
        const releasedAt = Date.now();
        t.internal.pendingRequests.splice(t.internal.pendingRequests.indexOf(held as Record<string, unknown>), 1);
        await new Promise((r) => setTimeout(r, 2_500));
        t.internal.pendingRequests.push(held as Record<string, unknown>);
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const note = t.rows().map((r) => JSON.stringify(r.content)).find((b) => b.includes('[budget-hold]'));
        const waited = Number(/That turn waited (\d+) s\./.exec(String(note))?.[1]);
        assert.ok(waited >= Math.round((releasing - hold.wait.since) / 1000) && waited <= Math.round((releasedAt - hold.wait.since) / 1000),
          `the figure is the wait to the release, not the 2.5 s after it: ${note}`);
      } finally {
        await t.close();
      }
    });
  });

  it('runs the note\'s figure to the release at resume() when room came during a quiesce', async () => {
    await withCompression({ stalled: true }, async (c) => {
      const t = await resident({ replies: ['Answered go'] });
      try {
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        await t.framework.quiesce({ timeoutMs: 2_000 });
        const hold = t.internal.budgetHolds.get('prime')!;
        hold.wait.since = Date.now() - 3_000;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await new Promise((r) => setTimeout(r, 2_500));
        assert.equal(t.internal.budgetHolds.get('prime'), hold, 'the release waits for resume()');
        await t.framework.resume();
        const releasedAt = Date.now();
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const note = t.rows().map((r) => JSON.stringify(r.content)).find((b) => b.includes('[budget-hold]'));
        const waited = Number(/That turn waited (\d+) s\./.exec(String(note))?.[1]);
        assert.ok(waited >= 5 && waited <= Math.round((releasedAt - hold.wait.since) / 1000), `the figure runs to the release at resume(), the quiesce in it: ${note}`);
      } finally {
        await t.close();
      }
    });
  });

  it('an undo of the released turn leaves the note, whose words stay true for the turn that reads it next', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        assert.ok(await pollUntil(() => !t.internal.hasTurn('prime')), 'the turn has ended');
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        assert.ok(!t.windowText().includes('Answered go'), 'the undo took the reply');
        assert.match(t.windowText(), /when a turn came to start\. That turn waited \d+ (s|min)\./, 'and left the note, stored before the turn began');
      } finally {
        await t.close();
      }
    });
  });

  it('ends the hold once when a listener of the stored note stops the framework', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        let stopping: Promise<void> | undefined;
        t.framework.onTrace((e) => {
          if (e.type === 'message:added' && String((e as { source?: unknown }).source).includes('budget-hold')) stopping ??= t.framework.stop();
        });
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.ok(await pollUntil(() => stopping !== undefined), 'the note was stored and the listener stopped');
        await stopping;
        assert.equal(t.of('inference:hold_ended').length, 1, `one end: ${JSON.stringify(t.of('inference:hold_ended').map((e) => e.outcome))}`);
      } finally {
        await t.close();
      }
    });
  });

  it('stores a row for each of two holds whose notes read the same but for their figures', async () => {
    await withCompression({ stalled: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered one', 'Answered two'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const figures: Array<[number, number]> = [];
      const releaseAfter = (waitedMs: number) => {
        const hold = t.internal.budgetHolds.get('prime')!;
        hold.wait.since = Date.now() - waitedMs;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        const releasing = Date.now();
        t.internal.releaseBudgetHold('prime');
        figures.push([Math.round((releasing - hold.wait.since) / 1000), Math.round((Date.now() - hold.wait.since) / 1000)]);
      };
      try {
        t.send('one');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        releaseAfter(3_000);
        assert.ok(await pollUntil(() => t.stored().includes('Answered one')));
        c.fitAt = Infinity;
        c.readyAt = Infinity;
        t.send('two');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2));
        releaseAfter(3_000);
        assert.ok(await pollUntil(() => t.stored().includes('Answered two')));
        assert.equal(t.of('inference:held').length, 2);
        const notes = t.rows().filter((r) => JSON.stringify(r.content).includes('[budget-hold]')).map((r) => JSON.stringify(r.content));
        assert.equal(notes.length, 2);
        notes.forEach((note, i) => {
          const waited = Number(/That turn waited (\d+) s\./.exec(note)?.[1]);
          assert.ok(waited >= figures[i]![0] && waited <= figures[i]![1], `each note counts its own wait: ${note}`);
        });
        assert.equal(notes[0]!.replace(/waited \d+ s/, ''), notes[1]!.replace(/waited \d+ s/, ''), 'the two notes read the same but for the figure');
      } finally {
        await t.close();
      }
    });
  });
});

describe('a continuation refused for budget mid-turn waits idle too', () => {
  async function heldContinuation(c: Compression, options: { gate?: boolean; replies?: Reply[]; policy?: { shouldInfer(agentName: string, requests: Array<Record<string, unknown>>): boolean }; watch?: (t: Resident) => void } = {}) {
    c.refuseFrom = 2;
    const t = await resident({
      restart: true, maintenanceIntervalMs: 0, replies: options.replies ?? ['Done after the restart'],
      ...(options.gate ? { gate: true } : {}), ...(options.policy ? { policy: options.policy } : {}),
    });
    t.internal.budgetHoldRecheckMs = 60_000;
    options.watch?.(t);
    t.cm().addMessage('user', [text('hello')]);
    t.send('fetch it');
    assert.ok(await pollUntil(() => t.of('inference:held').length === 1), 'the continuation is held');
    return t;
  }
  const fit = (c: Compression, t: Resident) => {
    c.fitAt = c.ticks;
    c.readyAt = c.ticks;
    t.internal.releaseBudgetHold('prime');
  };

  it("an undo ends a waiting turn under way after its own record, so an undo from the turn's end finds the first one done", async () => {
    await withCompression({}, async (c) => {
      const t = await heldContinuation(c);
      try {
        let nested: { undone: boolean } | string | undefined;
        t.framework.onTrace((e) => {
          if (e.type !== 'inference:aborted' || nested !== undefined) return;
          try {
            nested = t.framework.undoLastTurn('prime');
          } catch (error) {
            nested = String(error);
          }
        });
        const outer = t.framework.undoLastTurn('prime');
        assert.equal(outer.undone, true, "the undo took the turn's checkpoint");
        const types = t.traces.map((e) => e.type);
        assert.ok(types.lastIndexOf('window:undone') < types.lastIndexOf('inference:aborted'), "the waiting turn's end comes after the undo's");
        assert.deepEqual(nested, { undone: false }, 'an undo from its end finds nothing more to undo');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
        assert.equal(t.internal.budgetHolds.has('prime'), false);
      } finally {
        await t.close();
      }
    });
  });

  it('refuses a puppet call while a budget restart waits, and the restart runs once compression makes room', async () => {
    await withCompression({}, async (c) => {
      const t = await heldContinuation(c);
      try {
        await assert.rejects(t.framework.puppetToolCall('prime', 'canned--fetch', {}), /its turn waits for compression to make room.*abortInference\(\) ends that turn/);
        assert.ok(t.internal.budgetHolds.has('prime'), 'the turn still waits');
        fit(c, t);
        assert.ok(await pollUntil(() => t.stored().includes('Done after the restart')));
      } finally {
        await t.close();
      }
    });
  });

  it('runs as before with no surgery', async () => {
    await withCompression({}, async (c) => {
      const t = await heldContinuation(c);
      try {
        assert.equal(t.internal.hasTurn('prime'), false, 'idle for the surgery gate');
        fit(c, t);
        assert.ok(await pollUntil(() => t.stored().includes('Done after the restart')));
        assert.ok(await pollUntil(() => !t.internal.hasTurn('prime')), 'the turn has ended');
        assert.equal(t.of('inference:completed').length, 1);
      } finally {
        await t.close();
      }
    });
  });

  for (const [label, past] of [['its rounds', 'fetch it'], ['its trigger', 'hello']] as const) {
    it(`is dropped after a rollback past ${label}`, async () => {
      await withCompression({}, async (c) => {
        const t = await heldContinuation(c);
        try {
          await t.framework.rollbackToMessage('prime', { messageId: t.rowWith(past).id });
          assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1));
          assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
          assert.equal(t.of('inference:aborted').length, 1);
          fit(c, t);
          await t.framework.runUntilIdle();
          assert.ok(!t.stored().includes('Done after the restart'), 'nothing runs on the rewound history');
        } finally {
          await t.close();
        }
      });
    });
  }

  it("is kept through a suppression of a row it doesn't stand on; arrivals stay out of its request and run as a turn of their own after it", async () => {
    await withCompression({}, async (c) => {
      const t = await heldContinuation(c, { replies: ['Done after the restart', 'Read the arrival'] });
      try {
        await t.framework.suppressMessages('prime', { messageIds: [t.rowWith('hello').id] });
        const ended = t.of('inference:hold_ended');
        assert.ok(ended.length >= 1 && ended.every((e) => e.outcome === 'released'), 'released, not dropped');
        assert.ok(await pollUntil(() => t.internal.budgetHolds.has('prime')), 'and refused again, it waits again');
        t.send('MID');
        assert.ok(await pollUntil(() => t.stored().includes('MID')));
        assert.ok(!t.windowText().includes('MID'), 'the arrival waits outside the window');
        fit(c, t);
        assert.ok(await pollUntil(() => t.stored().includes('Read the arrival')));
        const calls = t.turnCalls();
        assert.ok(!requestText(calls.at(-2)).includes('MID'), "the continuation's request leaves it out");
        assert.ok(requestText(calls.at(-1)).includes('MID'), 'its own turn reads it');
      } finally {
        await t.close();
      }
    });
  });

  it('lets an undo run, ending the held continuation, and nothing runs on the undone window', async () => {
    await withCompression({}, async (c) => {
      const t = await heldContinuation(c);
      try {
        const undone = t.framework.undoLastTurn('prime');
        assert.equal(undone.undone, true);
        assert.equal(t.of('inference:aborted').length, 1);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
        fit(c, t);
        await t.framework.runUntilIdle();
        assert.ok(!t.stored().includes('Done after the restart'));
      } finally {
        await t.close();
      }
    });
  });

  it("lets go of the event gate's entry while it waits", async () => {
    await withCompression({}, async (c) => {
      let entered: boolean | undefined;
      const t = await heldContinuation(c, {
        gate: true,
        watch: (r) => r.framework.onTrace((e) => {
          if (e.type === 'inference:held') entered = r.internal.eventGate!.inferring.has('prime');
        }),
      });
      try {
        assert.ok(t.internal.eventGate, 'the gate is on');
        assert.equal(entered, true, 'the turn held a gate entry as its wait formed');
        assert.equal(t.internal.eventGate!.inferring.has('prime'), false, "other agents' batches aren't held behind compression");
        fit(c, t);
        assert.ok(await pollUntil(() => t.stored().includes('Done after the restart')));
      } finally {
        await t.close();
      }
    });
  });
});

describe("the wait on context-manager's own autobiographical compression", () => {
  it('waits while its compression is pending, is released by its progress while still not ready, and runs once the strategy is ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-hold-auto-'));
    const membrane = new SequentialStreamMembrane();
    let summaries = 0;
    membrane.complete = async (request: NormalizedRequest) => {
      membrane.calls.push(request);
      summaries++;
      return createMockResponse([text(`Summary ${summaries}: the exchange went on.`)]);
    };
    membrane.pushResponse(createMockResponse([text('Answered go')]));
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'test-compression-model', targetChunkTokens: 50, headWindowTokens: 0,
      recentWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', strategy }],
      modules: [new InboxModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as unknown as Parameters<typeof AgentFramework.create>[0]);
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    const proto = ContextManager.prototype as unknown as Record<string, unknown>;
    const compile = proto.compile as (...a: unknown[]) => unknown;
    let refused = 0;
    try {
      framework.start();
      const cm = framework.getAgent('prime')!.getContextManager();
      const releases = watchReleases(framework, () => cm.isReady());
      for (let i = 0; i < 30; i++) cm.addMessage(i % 2 ? 'prime' : 'User', [text(`message ${i}: ${'word '.repeat(30)}`)]);
      (framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(framework.getAgent('prime'));
      assert.equal(cm.isReady(), false, 'its compression is pending, with nothing ticking it');
      proto.compile = async function (this: { isReady(): boolean }, ...args: unknown[]) {
        if (!this.isReady()) {
          refused++;
          throw Object.assign(new Error('Compile plan would exceed hard budget'), { name: 'OverBudgetError', budget: 1_000, actual: 2_000 });
        }
        return compile.apply(this, args);
      };
      framework.pushEvent({ type: 'external-message', source: 'test', content: [text('go')], metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      assert.ok(await pollUntil(() => traces.some((e) => e.type === 'inference:held')), 'the refused turn waits');
      const stored = () => (cm.getAllMessages() as unknown as Array<{ content: Array<{ text?: string }> }>).some((m) => m.content.some((b) => b.text === 'Answered go'));
      assert.ok(await pollUntil(stored, 10_000), 'it ran once the strategy was ready');
      assert.ok(traces.filter((e) => e.type === 'inference:hold_ended').every((e) => (e as { outcome?: string }).outcome === 'released'));
      assert.ok(summaries > 0, 'compression wrote summaries');
      assert.ok(refused >= 1);
      assert.ok(releases.whileNotReady >= 1, `released by progress while the strategy was still not ready: ${JSON.stringify(releases)}`);
      assert.equal(releases.notByProgress, 0, `each such release came with the progress snapshot changed: ${JSON.stringify(releases)}`);
    } finally {
      proto.compile = compile;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
