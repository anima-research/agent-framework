import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy, WindowedPassthroughStrategy, type ContextInjection } from '@animalabs/context-manager';
import { MembraneError, type ContentBlock, type NormalizedRequest, type NormalizedResponse, type YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const NOTE = /\[budget-hold\] Your context didn't fit its budget \(100,201 tokens against 48,568\), so this turn waited \d+ (s|min) for compression to make room\./;

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
  noteTips: boolean; calls: boolean;
  progress: number; stalled: boolean; snapshot: boolean;
  onRefusal?: () => void;
  snapshotThrows?: boolean;
  failNext?: Error;
  injections: string[][];
}
type Patchable = Record<'compile' | 'tick' | 'isReady' | 'getPendingWork', (...args: unknown[]) => unknown>;
async function withCompression<T>(state: Partial<Compression>, run: (c: Compression) => Promise<T>): Promise<T> {
  const c: Compression = {
    ticks: 0, compiles: 0, refusals: 0, refusing: false,
    fitAt: Infinity, readyAt: state.readyAt ?? state.fitAt ?? Infinity, refuseFrom: 1,
    noteTips: false, calls: false, progress: 0, stalled: !state.calls, snapshot: true, injections: [], ...state,
  };
  const progressPatched = new Map<object, unknown>();
  for (const strategy of [AutobiographicalStrategy.prototype, PassthroughStrategy.prototype, WindowedPassthroughStrategy.prototype] as Array<{ getProgressSnapshot?: unknown }>) {
    progressPatched.set(strategy, strategy.getProgressSnapshot);
    strategy.getProgressSnapshot = c.snapshot
      ? () => {
        if (c.snapshotThrows) throw new Error('zz the snapshot could not be read');
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
    const injections = ((args[1] ?? []) as ContextInjection[]).map((i) => String(i.namespace));
    c.injections.push(injections);
    if (c.failNext) {
      const error = c.failNext;
      c.failNext = undefined;
      throw error;
    }
    const withNote = injections.includes('framework:budget-hold');
    if (c.compiles >= c.refuseFrom && (c.ticks < c.fitAt || (c.noteTips && withNote))) {
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
  budgetHolds: Map<string, { state: string; turn?: unknown; startedAt: number }>;
  quiesced: boolean;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<Record<string, unknown>>;
  hasTurn(agentName: string): boolean;
  releaseBudgetHold(agentName: string): void;
  processInferenceRequests(): Promise<void>;
  startAgentStream(agent: unknown, trigger: Record<string, unknown>): Promise<void>;
  releaseAgentRuntime(agent: unknown, home?: unknown, why?: string): void;
  providerAccelerationCooldowns: Map<string, { until: number; heldRequests: unknown[] }>;
  releaseProviderAccelerationCooldown(agentName: string): void;
  eventGate: { inferring: Set<string> } | null;
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
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.deepEqual(t.of('inference:exhausted'), [], 'the turn never failed');
        assert.equal(t.turnCalls().length, 1, 'one request reached the provider');
        assert.match(requestText(t.turnCalls()[0]), NOTE);
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

  it('waits again quietly when a released start is refused while compression is still pending, with no failure marker and no hard-down', async () => {
    await withCompression({ fitAt: Infinity, stalled: false }, async (c) => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => c.refusals >= 4), 'released starts were refused again');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
        assert.equal(t.of('inference:held').length, 1, 'one hold');
        assert.equal(t.alerts('context-refusal').length, 1, 'one alert');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.equal(t.of('inference:hold_ended')[0]!.waitedMs as number >= 0, true);
        assert.ok(!t.stored().includes('[inference-failed]'), 'no failure marker');
        assert.deepEqual(t.alerts('hard-down'), [], 'no hard-down');
        assert.equal(notesStored(t), 1, 'refused releases stored no note');
      } finally {
        await t.close();
      }
    });
  });

  it('runs once without the note when a released start that carried it is refused with nothing pending, whatever the error policy says', async () => {
    await withCompression({ fitAt: 2, readyAt: 2, noteTips: true }, async (c) => {
      const t = await resident({ policyRetries: 0 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
        assert.deepEqual(c.injections.slice(-2).map((i) => i.includes('framework:budget-hold')), [true, false], 'the note, then a run without it');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.equal(notesStored(t), 0);
        assert.doesNotMatch(requestText(t.turnCalls()[0]), NOTE);
      } finally {
        await t.close();
      }
    });
  });

  it('when compression has nothing left and the context still does not fit, clears the wait, and the failure reaches the webhook and the trace', async () => {
    await withWebhook(async (posts) => {
      await withCompression({ fitAt: Infinity, readyAt: 2 }, async () => {
        const t = await resident();
        try {
          t.send('Are you there?');
          assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1));
          assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['nothing_pending']);
          const clears = t.alerts('context-refusal-clear');
          assert.equal(clears.length, 1);
          assert.match(String(clears[0]!.message), /compression had nothing left to do/);
          assert.deepEqual(t.of('ops:alert').map((e) => e.kind).filter((k) => String(k).startsWith('context-refusal')),
            ['context-refusal', 'context-refusal-clear', 'context-refusal'], "the wait's open, its clear, then the failure's own");
          assert.ok(await pollUntil(() => posts.length === 3));
          assert.deepEqual(posts, ['context-refusal', 'context-refusal-clear', 'context-refusal']);
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
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /was stopped/);
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
        t.internal.releaseBudgetHold('prime');
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 0, 'nothing runs while quiesced');
        assert.equal(t.internal.budgetHolds.get('prime')?.state, 'holding', 'a release that comes due while quiesced waits');
        await t.framework.resume();
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')));
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
        assert.equal(t.of('inference:hold_ended').length, 0, 'a suppression of another row leaves the held start');
        assert.ok(await pollUntil(() => c.refusals > refused && t.internal.budgetHolds.get('prime')?.state === 'holding'),
          'the surgery released it, and its start was refused again');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        await t.framework.rollbackToMessage('prime', { messageId: t.rowWith('hello').id });
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed'], 'the rollback dropped it as it ended');
        assert.equal(t.of('inference:aborted').length, 1, 'the held turn ends');
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /was removed/);
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
          assert.ok(await pollUntil(() => c.refusals > refused && t.internal.budgetHolds.get('prime')?.state === 'holding'),
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
        assert.deepEqual(t.of('inference:hold_ended'), []);
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
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1), 'dropped as it starts');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
        assert.equal(t.of('inference:aborted').length, 1);
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
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
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
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1), 'dropped as it starts');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['removed']);
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
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
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
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
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
        c.onRefusal = () => {
          c.onRefusal = undefined;
          c.progress++;
        };
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        assert.ok(await pollUntil(() => c.refusals >= 2), 'what compression wrote during the compile released the turn, and it was refused again');
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

  it('ends a released first start the inference policy drops, and a later wake gets no note', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      let refuse = false;
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered later'], policy: { shouldInfer: () => !refuse } });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        refuse = true;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        await t.framework.runUntilIdle();
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.of('inference:aborted').length, 1, 'its turn ends');
        assert.equal(t.internal.budgetHolds.size, 0);
        refuse = false;
        t.send('later');
        assert.ok(await pollUntil(() => t.stored().includes('Answered later')));
        assert.equal(notesStored(t), 0, 'the later wake gets no note');
      } finally {
        await t.close();
      }
    });
  });

  it('holds the agent\'s other wakes while its held turn is out, and gives the wait and its fit only to the start that carries the held turn', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go', 'Answered other'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        const held = t.internal.budgetHolds.get('prime')!.turn;
        t.internal.releaseBudgetHold('prime');
        const at = t.internal.pendingRequests.indexOf(held as Record<string, unknown>);
        assert.ok(at >= 0, 'released into the queue');
        t.internal.pendingRequests.splice(at, 1);
        t.internal.pendingRequests.push({ agentName: 'prime', reason: 'zz-other', source: 'test', timestamp: Date.now() });
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'no other turn starts while the held turn is out');
        assert.deepEqual(t.of('inference:hold_ended'), []);
        assert.equal(t.internal.budgetHolds.get('prime')?.state, 'released');
        t.internal.pendingRequests.push(held as Record<string, unknown>);
        assert.ok(await pollUntil(() => t.stored().includes('Answered other')), 'the other wake runs after it');
        const calls = t.turnCalls();
        assert.ok(requestText(calls.at(-2)).includes('"go"'), 'the held turn ran first');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.equal(notesStored(t), 1, 'and only it had the note');
      } finally {
        await t.close();
      }
    });
  });

  it('a refused start that is not the held turn joins the wait while the held turn is released, and runs after it', async () => {
    await withCompression({ fitAt: Infinity, refuseFrom: 2 }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Hi', 'Answered go', 'Answered other'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('hello');
        assert.ok(await pollUntil(() => t.stored().includes('Hi')));
        t.sendForPrime('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const held = t.internal.budgetHolds.get('prime')!.turn;
        const refused = c.refusals;
        t.internal.releaseBudgetHold('prime');
        t.internal.pendingRequests.splice(t.internal.pendingRequests.indexOf(held as Record<string, unknown>), 1);
        await t.internal.startAgentStream(t.framework.getAgent('prime')!, { agentName: 'prime', reason: 'zz-other', source: 'test', timestamp: Date.now() });
        assert.equal(c.refusals, refused + 1, 'the other start, which no pass held, was refused');
        assert.equal(t.internal.budgetHolds.get('prime')?.state, 'released', 'the held turn is still out');
        assert.equal(t.of('inference:held').length, 1, 'no second wait');
        assert.ok(!t.stored().includes('[inference-failed]'), 'and no failure');
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.pendingRequests.push(held as Record<string, unknown>);
        assert.ok(await pollUntil(() => t.stored().includes('Answered other')), 'the other runs after the held turn');
        assert.ok(t.stored().includes('Answered go'));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      } finally {
        await t.close();
      }
    });
  });

  it('abortInference() stops a released first start before it begins', async () => {
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
        assert.equal(t.framework.abortInference('prime', 'zz-stop'), true);
        await t.framework.runUntilIdle();
        assert.equal(t.turnCalls().length, 1, 'the released start never ran');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.deepEqual(t.of('inference:aborted').map((e) => e.reason), ['zz-stop']);
      } finally {
        await t.close();
      }
    });
  });

  for (const [label, end] of [
    ['stop()', (t: Resident) => t.framework.stop()],
    ["its agent's end", (t: Resident) => t.internal.releaseAgentRuntime(t.framework.getAgent('prime'), undefined, 'zz its agent ended')],
  ] as const) {
    it(`${label} ends a released first start before it begins, with inference:aborted`, async () => {
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
          await end(t);
          assert.equal(t.of('inference:aborted').length, 1, 'its turn ends with inference:aborted');
          assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
          assert.equal(t.turnCalls().length, 1, 'the released start never ran');
        } finally {
          await t.close();
        }
      });
    });
  }

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
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
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

  it('ends a hold whose released start fails for another reason as failed, and the turn takes that error\'s path', async () => {
    await withCompression({ fitAt: 2 }, async (c) => {
      const t = await resident();
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.failNext = new Error('zz store unavailable');
        c.fitAt = 0;
        c.readyAt = 0;
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['failed']);
        assert.match(String(t.alerts('context-refusal-clear')[0]?.message), /failed for another reason after .*zz store unavailable/);
        assert.ok(await pollUntil(() => t.stored().includes('Answered once it fit')), "the error policy's retry runs it");
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

describe("the hold's note sits where the released turn read it", () => {
  const thinking = (answer: string) => createMockResponse([
    { type: 'thinking', thinking: `reasoning for ${answer}`, signature: `sig-${answer}` } as ContentBlock, text(answer)]);

  it('stores the note once, where it was placed, so the next start keeps the prefix and the reply its thinking', async () => {
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

  it('gives no note to a released wake whose window ends on the agent\'s own reply, and the next start keeps the prefix', async () => {
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
        assert.equal(notesStored(t), 0);
        c.refuseFrom = Infinity;
        t.send('three');
        assert.ok(await pollUntil(() => t.stored().includes('Answered three')));
        const calls = t.turnCalls();
        const released = calls[1]!;
        const next = calls[2]!;
        assert.doesNotMatch(requestText(released), /budget-hold/);
        assert.equal(JSON.stringify(released.messages.at(-1)), JSON.stringify({ participant: 'user', content: [text('[Continue]')] }),
          'a wake with nothing new ends its request on [Continue], which a later request leaves out before a plain reply like this one');
        const read = released.messages.slice(0, -1);
        assert.deepEqual(next.messages.slice(0, read.length), read, 'the next request starts with what the released one read, byte for byte');
      } finally {
        await t.close();
      }
    });
  });

  it("gives no note to a person's held message whose refused start stored an injection after it, and the next start keeps the prefix", async () => {
    let n = 0;
    await withCompression({ fitAt: Infinity }, async (c) => {
      const t = await resident({ context: () => `status ${++n}`, replies: ['Answered one', 'Answered two'] });
      try {
        t.send('one');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        assert.ok(await pollUntil(() => t.stored().includes('Answered one')));
        assert.equal(notesStored(t), 0);
        t.send('two');
        assert.ok(await pollUntil(() => t.stored().includes('Answered two')));
        const [released, next] = t.turnCalls();
        assert.doesNotMatch(requestText(released), /budget-hold/);
        assert.deepEqual(next!.messages.slice(0, released!.messages.length), released!.messages);
      } finally {
        await t.close();
      }
    });
  });

  it("gives the note the wait for compression, which ends at the release, not the start's time after it", async () => {
    await withCompression({ stalled: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        const hold = t.internal.budgetHolds.get('prime')!;
        const held = hold.turn!;
        hold.startedAt = Date.now() - 3_000;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        t.internal.pendingRequests.splice(t.internal.pendingRequests.indexOf(held as Record<string, unknown>), 1);
        await new Promise((r) => setTimeout(r, 2_500));
        t.internal.pendingRequests.push(held as Record<string, unknown>);
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const note = t.rows().map((r) => JSON.stringify(r.content)).find((b) => b.includes('[budget-hold]'));
        assert.ok(note?.includes('this turn waited 3 s for compression'), String(note));
      } finally {
        await t.close();
      }
    });
  });

  it('ends the note\'s figure where compression made room during a quiesce, not at resume()', async () => {
    await withCompression({ stalled: true }, async (c) => {
      const t = await resident({ maintenanceIntervalMs: 0, replies: ['Answered go'] });
      t.internal.budgetHoldRecheckMs = 60_000;
      try {
        t.send('go');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1));
        await t.framework.quiesce({ timeoutMs: 2_000 });
        t.internal.budgetHolds.get('prime')!.startedAt = Date.now() - 3_000;
        c.fitAt = c.ticks;
        c.readyAt = c.ticks;
        t.internal.releaseBudgetHold('prime');
        assert.equal(t.internal.budgetHolds.get('prime')?.state, 'holding', 'the release waits for resume()');
        await new Promise((r) => setTimeout(r, 2_500));
        await t.framework.resume();
        assert.ok(await pollUntil(() => t.stored().includes('Answered go')));
        const note = t.rows().map((r) => JSON.stringify(r.content)).find((b) => b.includes('[budget-hold]'));
        assert.ok(note?.includes('this turn waited 3 s for compression'), String(note));
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
        t.internal.budgetHolds.get('prime')!.startedAt = Date.now() - waitedMs;
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
  async function heldContinuation(c: Compression, options: { gate?: boolean; replies?: Reply[] } = {}) {
    c.refuseFrom = 2;
    const t = await resident({ restart: true, maintenanceIntervalMs: 0, replies: options.replies ?? ['Done after the restart'], ...(options.gate ? { gate: true } : {}) });
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
        assert.equal(t.of('inference:hold_ended').length, 0, 'kept');
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

  it('refuses nothing to a redo while it waits: its start emptied the redo stack, so there is nothing to redo', async () => {
    await withCompression({}, async (c) => {
      const t = await heldContinuation(c);
      try {
        assert.deepEqual(t.framework.redo('prime'), { redone: false });
        assert.notEqual(t.hold(), null, 'it still waits');
        assert.deepEqual(t.of('inference:hold_ended'), []);
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
