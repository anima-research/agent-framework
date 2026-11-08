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
  progress: number; stalled: boolean; snapshot: boolean;
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
    calls: false, progress: 0, stalled: !state.calls, snapshot: true, ...state,
  };
  const progressPatched = new Map<object, unknown>();
  for (const strategy of [AutobiographicalStrategy.prototype, PassthroughStrategy.prototype, WindowedPassthroughStrategy.prototype] as Array<{ getProgressSnapshot?: unknown }>) {
    progressPatched.set(strategy, strategy.getProgressSnapshot);
    strategy.getProgressSnapshot = c.snapshot
      ? () => {
        if (c.snapshotThrows) throw new Error('zz the snapshot could not be read');
        if (c.snapshotOther) return { completed: c.progress };
        if (c.snapshotBigInt) return { chunksCompressed: BigInt(c.progress) };
        return { chunksCompressed: c.progress, summaryCounts: { l1: c.progress, l2: 0, l3: 0 } };
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
  budgetHolds: Map<string, { turn?: unknown; startedAt: number; waitSince: number }>;
  quiesced: boolean;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<Record<string, unknown>>;
  hasTurn(agentName: string): boolean;
  releaseBudgetHold(agentName: string): void;
  releaseBudgetHoldsOnEvidence(): void;
  redoStacks: Map<string, unknown[]>;
  turnCounters: Map<string, number>;
  getTurnCheckpoints(agentName: string): Array<{ turnIndex: number }>;
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
/** A start merged from two wakes, run once, for the symbol its merged batch is kept under. */
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
/** Count each release of an agent's hold from waiting, with whether its strategy was ready then. */
function watchReleases(framework: unknown, ready: () => boolean): { whileNotReady: number; all: number } {
  const internal = framework as Internal;
  const release = internal.releaseBudgetHold.bind(framework);
  const seen = { whileNotReady: 0, all: 0 };
  internal.releaseBudgetHold = (agentName: string) => {
    const before = internal.budgetHolds.has(agentName);
    release(agentName);
    if (before && !internal.budgetHolds.has(agentName)) {
      seen.all++;
      if (!ready()) seen.whileNotReady++;
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
  policyRetries?: number;
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
    }],
    modules: [options.restart ? new BlobToolModule() : inbox, ...(options.modules ?? [])],
    syncIntervalMs: 0,
    maintenanceIntervalMs: options.maintenanceIntervalMs ?? 50,
    errorPolicy: { maxRetries: options.policyRetries ?? 3, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < (options.policyRetries ?? 3) ? { retry: true, delayMs: 0 } : { retry: false }) },
    ...(options.gate ? { gate: { config: { policies: [], default: 'always' } } } : {}),
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
        c.progress++;
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
        wait.since -= 180_000;
        hold.waitSince -= 180_000;
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
        (hold.turn as Record<symbol, { since: number }>)[symbolNamed(hold.turn as object, 'budget-wait')]!.since -= 180_000;
        hold.waitSince -= 180_000;
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
        assert.ok(t.internal.budgetHolds.get('prime')!.waitSince > hold.waitSince + 120_000, 'in a wait of its own');
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
        (hold.turn as Record<symbol, { since: number }>)[symbolNamed(hold.turn as object, 'budget-wait')]!.since -= 180_000;
        hold.waitSince -= 180_000;
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
        assert.ok(t.internal.budgetHolds.get('prime')!.waitSince > hold.waitSince + 120_000, 'in a wait of its own');
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
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /was stopped after .*, so it doesn't run/);
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
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /was removed or taken out of its window after .*, so it doesn't run/);
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
        (hold.turn as Record<symbol, { since: number }>)[symbolNamed(hold.turn as object, 'budget-wait')]!.since -= 180_000;
        hold.waitSince -= 180_000;
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
        assert.ok(t.internal.budgetHolds.get('prime')!.waitSince > hold.waitSince + 120_000, 'the new hold starts its own wait');
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
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
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
    await withCompression({ fitAt: 2 }, async (c) => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.failNext = new Error('zz store unavailable');
        c.fitAt = 0;
        c.readyAt = 0;
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')), "the error policy's retry runs it");
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

describe("the hold's note is stored at its release, where every later request reads it", () => {
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
        hold.waitSince = Date.now() - 3_000;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        const releasedAt = Date.now();
        t.internal.pendingRequests.splice(t.internal.pendingRequests.indexOf(held as Record<string, unknown>), 1);
        await new Promise((r) => setTimeout(r, 2_500));
        t.internal.pendingRequests.push(held as Record<string, unknown>);
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const note = t.rows().map((r) => JSON.stringify(r.content)).find((b) => b.includes('[budget-hold]'));
        const waited = Number(/That turn waited (\d+) s\./.exec(String(note))?.[1]);
        assert.equal(waited, Math.round((releasedAt - hold.waitSince) / 1000), `the figure is the wait to the release, not the 2.5 s after it: ${note}`);
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
        hold.waitSince = Date.now() - 3_000;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await new Promise((r) => setTimeout(r, 2_500));
        assert.equal(t.internal.budgetHolds.get('prime'), hold, 'the release waits for resume()');
        await t.framework.resume();
        const releasedAt = Date.now();
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const note = t.rows().map((r) => JSON.stringify(r.content)).find((b) => b.includes('[budget-hold]'));
        const waited = Number(/That turn waited (\d+) s\./.exec(String(note))?.[1]);
        assert.ok(waited >= 5 && waited <= Math.round((releasedAt - hold.waitSince) / 1000), `the figure runs to the release at resume(), the quiesce in it: ${note}`);
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

  it('stores a row for each of two holds whose notes read the same', async () => {
    await withCompression({ stalled: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered one', 'Answered two'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      const releaseAfter = (waitedMs: number) => {
        const hold = t.internal.budgetHolds.get('prime')!;
        hold.waitSince = Date.now() - waitedMs;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
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
        assert.equal(notes[0], notes[1], 'the two notes read the same');
      } finally {
        await t.close();
      }
    });
  });
});

describe('a continuation refused for budget mid-turn waits idle too', () => {
  async function heldContinuation(c: Compression, options: { gate?: boolean; replies?: Reply[]; policy?: { shouldInfer(agentName: string, requests: Array<Record<string, unknown>>): boolean } } = {}) {
    c.refuseFrom = 2;
    const t = await resident({
      restart: true, maintenanceIntervalMs: 0, replies: options.replies ?? ['Done after the restart'],
      ...(options.gate ? { gate: true } : {}), ...(options.policy ? { policy: options.policy } : {}),
    });
    t.internal.budgetHoldRecheckMs = 60_000;
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
        assert.ok(t.of('inference:hold_ended').every((e) => e.outcome === 'released'), 'released, not dropped');
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

  it('lets an undo run, ending the held continuation first, and nothing runs on the undone window', async () => {
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
      const t = await heldContinuation(c, { gate: true });
      try {
        assert.ok(t.internal.eventGate, 'the gate is on');
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
    } finally {
      proto.compile = compile;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
