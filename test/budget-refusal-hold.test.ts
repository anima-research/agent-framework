import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { EventResponse, InferencePolicy, Module, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/** Each stream answers with its own script of rounds. */
class ScriptedStreamMembrane extends MockMembrane {
  constructor(private readonly scripts: NormalizedResponse[][]) { super(); }
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.scripts.shift() ?? []);
    this.lastStream = stream;
    return stream;
  }
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

async function pollUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function stored(framework: AgentFramework): Array<{ text: string; metadata: Record<string, unknown> }> {
  const cm = framework.getAgent('prime')?.getContextManager();
  const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
    content: Array<{ type: string; text?: string }>;
    metadata?: Record<string, unknown>;
  }>;
  return msgs.map((m) => ({
    text: (m.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'),
    metadata: m.metadata ?? {},
  }));
}
const storedText = (framework: AgentFramework): string => stored(framework).map((m) => m.text).join('\n');

async function errorLines<T>(run: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    original(...args);
  };
  try {
    return await run(lines);
  } finally {
    console.error = original;
  }
}

interface Backlog {
  ticks: number; fitAt: number; readyAt: number; fit: boolean;
  alwaysPending: boolean; stalled: boolean; previewless: boolean; refuseCompiles: number;
  previews: number; dryRuns: number; dryRunsRunning: number; mostDryRunsRunning: number; compiles: number;
  dryRunsAcrossFit: number;
  noProgress: boolean;
  progress?: number;
  refusalName?: string;
  /** A dry compile resolves whether the context fits or not, as
   *  context-manager's resolves an over-budget plan (SelectOptions.dryRun). */
  dryRunResolves?: boolean;
  previewError?: Error; dryRunGate?: Promise<void>; dryRunMs?: number; slowCompile?: { nth: number; ms: number };
  compileGate?: { nth: number; until: Promise<void> };
  bindings: { compile: unknown[]; dryRun: unknown[]; preview: unknown[] };
}
const fits = (b: Backlog): boolean => b.fit || b.ticks >= b.fitAt;
const pending = (b: Backlog): boolean => b.alwaysPending || (!fits(b) && b.ticks < b.readyAt);
let refusalName = 'OverBudgetError';
const overBudget = (actual = 100_201) => Object.assign(
  new Error('Compile plan would exceed hard budget: head=41200 tail=8100 middle=62000 budget=48568'),
  { name: refusalName, budget: 48_568, actual },
);

type Patchable = Record<'compile' | 'tick' | 'isReady' | 'previewContext', (...args: unknown[]) => unknown>;

async function withBacklog<T>(backlog: Partial<Backlog>, run: (b: Backlog) => Promise<T>): Promise<T> {
  const b: Backlog = {
    ticks: 0, fitAt: Infinity, readyAt: Infinity, fit: false,
    alwaysPending: false, stalled: false, previewless: false, refuseCompiles: 0,
    previews: 0, dryRuns: 0, dryRunsRunning: 0, mostDryRunsRunning: 0, compiles: 0,
    dryRunsAcrossFit: 0, noProgress: false, bindings: { compile: [], dryRun: [], preview: [] },
    ...backlog,
  };
  refusalName = b.refusalName ?? 'OverBudgetError';
  const proto = ContextManager.prototype as unknown as Patchable;
  const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady, previewContext: proto.previewContext };
  const passthrough = PassthroughStrategy.prototype as unknown as { getProgressSnapshot?: () => unknown };
  proto.compile = async function (this: unknown, ...args: unknown[]) {
    if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun === true) {
      b.bindings.dryRun.push((args[2] as { thinkingBinding?: unknown }).thinkingBinding);
      b.dryRuns++;
      b.mostDryRunsRunning = Math.max(b.mostDryRunsRunning, ++b.dryRunsRunning);
      try {
        const fitsNow = fits(b);
        if (b.dryRunGate) await b.dryRunGate;
        if (b.dryRunMs) await new Promise((r) => setTimeout(r, b.dryRunMs));
        if (!fitsNow && fits(b)) b.dryRunsAcrossFit++;
        if (!fitsNow && !b.dryRunResolves) throw overBudget();
      } finally {
        b.dryRunsRunning--;
      }
      return original.compile.apply(this, args);
    }
    b.compiles++;
    b.bindings.compile.push((args[2] as { thinkingBinding?: unknown } | undefined)?.thinkingBinding);
    if (b.slowCompile?.nth === b.compiles) await new Promise((r) => setTimeout(r, b.slowCompile!.ms));
    if (b.compileGate?.nth === b.compiles) await b.compileGate.until;
    if (!fits(b)) throw overBudget();
    if (b.refuseCompiles > 0) {
      b.refuseCompiles--;
      throw overBudget(49_000);
    }
    return original.compile.apply(this, args);
  };
  proto.previewContext = function (...args: unknown[]) {
    b.previews++;
    b.bindings.preview.push((args[2] as { thinkingBinding?: unknown } | undefined)?.thinkingBinding);
    if (b.previewError) {
      const error = b.previewError;
      b.previewError = undefined;
      throw error;
    }
    if (b.previewless) return null;
    // As context-manager's preview does: an over-budget plan answers
    // fits: false, and any other refusal, a context refusal among them, is
    // rethrown.
    if (!fits(b) && refusalName !== 'OverBudgetError') throw overBudget();
    return { fits: fits(b) };
  };
  proto.tick = async function () { b.ticks++; };
  proto.isReady = function () { return !pending(b); };
  if (!b.noProgress) {
    passthrough.getProgressSnapshot = function () {
      return { chunksCompressed: b.progress ?? (b.stalled ? 0 : b.ticks), fits: fits(b) };
    };
  }
  try {
    return await run(b);
  } finally {
    Object.assign(proto, original);
    delete passthrough.getProgressSnapshot;
    refusalName = 'OverBudgetError';
  }
}

class InboxModule implements Module {
  readonly name = 'inbox';
  gatherContext?: () => Promise<Array<{ namespace: string; position: 'afterUser'; content: Array<{ type: 'text'; text: string }> }>>;
  constructor(context?: () => string) {
    if (context) this.gatherContext = async () => [{ namespace: 'inbox:status', position: 'afterUser', content: [{ type: 'text', text: context() }] }];
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall(): Promise<never> { throw new Error('no tools'); }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
      requestInference: true,
    };
  }
}

class BlobToolModule implements Module {
  readonly name = 'canned';
  constructor(private readonly duringCall?: () => unknown) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'blob', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    await this.duringCall?.();
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
      requestInference: true,
    };
  }
}
function nearCapToolResponse() {
  const r = createMockResponse([
    { type: 'text', text: 'Working' },
    { type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} },
  ], 'tool_use');
  (r as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
  return r;
}

async function heldRestart(texts: string[], options: {
  fits?: boolean;
  duringTool?: (internal: Internal) => unknown;
  inferencePolicy?: InferencePolicy;
  /** The tool round's continuation is a refusal, which the tool-result guard
   *  retries in the turn, instead of a near-cap round that restarts it. */
  guardRetry?: boolean;
} = {}) {
  const proto = ContextManager.prototype as unknown as Patchable;
  const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady };
  let fit = options.fits === true;
  let committing = 0;
  proto.compile = async function (this: unknown, ...args: unknown[]) {
    const dryRun = (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true;
    const refused = dryRun ? !fit : ++committing >= 2 && !fit;
    if (refused) throw overBudget(49_000);
    return original.compile.apply(this, args);
  };
  proto.tick = async function () {};
  proto.isReady = function () { return fit; };
  const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-restart-'));
  const membrane = options.guardRetry
    ? new ScriptedStreamMembrane([
      [
        createMockResponse([{ type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} }], 'tool_use'),
        { ...createMockResponse([{ type: 'text', text: 'refused partial' }], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'test-category' } } } } as NormalizedResponse,
      ],
      ...texts.map((text) => [createMockResponse([{ type: 'text', text }])]),
    ])
    : new SequentialStreamMembrane();
  if (!options.guardRetry) {
    membrane.pushResponse(nearCapToolResponse());
    for (const text of texts) membrane.pushResponse(createMockResponse([{ type: 'text', text }]));
  }
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [options.guardRetry
      ? { name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', maxTokens: 4_000, toolResultGuard: true }
      : { name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000 }],
    modules: [new BlobToolModule(() => options.duringTool?.(internal))],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 50,
    errorPolicy: { maxRetries: 3, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
    ...(options.inferencePolicy ? { inferencePolicy: options.inferencePolicy } : {}),
  });
  const internal = framework as unknown as Internal;
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  let looks = 0;
  const hold = framework as unknown as { checkBudgetHold?: (agentName: string) => Promise<void> };
  const checkBudgetHold = hold.checkBudgetHold?.bind(framework);
  if (checkBudgetHold) hold.checkBudgetHold = (agentName: string) => { looks++; return checkBudgetHold(agentName); };
  framework.start();
  framework.getAgent('prime')!.getContextManager().addMessage('user', [{ type: 'text', text: 'fetch it' }]);
  internal.pendingRequests.push({ agentName: 'prime', reason: 'external-message', source: 'test', timestamp: Date.now() } as unknown as { agentName: string });
  return {
    framework,
    internal,
    membrane,
    of: (type: string) => traces.filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>,
    looks: () => looks,
    fit: () => { fit = true; },
    close: async () => {
      try {
        await framework.stop();
      } finally {
        Object.assign(proto, original);
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

interface Internal {
  budgetHoldMs: number;
  budgetHoldRecheckMs: number;
  budgetHolds: Map<string, unknown>;
  activeTurnTokens: Map<string, number>;
  pendingRequests: Array<{ agentName: string }>;
  providerGateBlocked: (agentName: string) => boolean;
  disposeConversationAgent: (agentName: string) => void;
}
type HeldRequest = { agentName: string; reason: string; coalescingBatch?: boolean; coalescingBatchSubjects?: string[]; coalescingSubject?: string };
const holdOf = (t: { internal: Internal }) =>
  (t.internal.budgetHolds as unknown as Map<string, { state: string; heldRequests: HeldRequest[] }>).get('prime');

const heldRequests = (framework: AgentFramework): number | undefined => {
  const agents = (framework.healthSnapshot() as { agents: Array<{ name: string; budgetHold: { heldRequests: number } | null }> }).agents;
  return agents.find((a) => a.name === 'prime')?.budgetHold?.heldRequests;
};

async function residentTurn(options: {
  maintenanceIntervalMs: number; holdMs?: number; recheckMs?: number; responses?: number; inferencePolicy?: InferencePolicy;
  thinkingBinding?: { binds: boolean; dropBlock: boolean };
  context?: () => string;
  storePath?: string;
  failFirstStream?: () => void;
  policyErrors?: Error[];
  clock?: { intervalSeconds: number };
}) {
  const tempDir = options.storePath === undefined ? mkdtempSync(join(tmpdir(), 'budget-hold-')) : undefined;
  const membrane = new SequentialStreamMembrane();
  if (options.failFirstStream) {
    const stream = membrane.streamYielding.bind(membrane);
    let failed = false;
    membrane.streamYielding = (request: NormalizedRequest, opts?: unknown): YieldingStream => {
      if (failed) return stream(request, opts);
      failed = true;
      options.failFirstStream!();
      throw new Error('provider overloaded');
    };
  }
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Answered once it fit' }]));
  for (let i = 1; i < (options.responses ?? 1); i++) {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `Answered turn ${i + 1}` }]));
  }
  const framework = await AgentFramework.create({
    storePath: options.storePath ?? join(tempDir!, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime', model: 'test-model', systemPrompt: 'You are prime.',
      ...(options.thinkingBinding ? { thinkingBinding: options.thinkingBinding } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    }],
    modules: [new InboxModule(options.context)],
    syncIntervalMs: 0,
    maintenanceIntervalMs: options.maintenanceIntervalMs,
    ...(options.inferencePolicy ? { inferencePolicy: options.inferencePolicy } : {}),
    errorPolicy: { maxRetries: 3, onInferenceError: (error, _agent, attempt) => {
      options.policyErrors?.push(error);
      return attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false };
    } },
  });
  const internal = framework as unknown as Internal;
  if (options.holdMs !== undefined) internal.budgetHoldMs = options.holdMs;
  if (options.recheckMs !== undefined) internal.budgetHoldRecheckMs = options.recheckMs;
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  let looks = 0;
  const hold = framework as unknown as { checkBudgetHold?: (agentName: string) => Promise<void> };
  const checkBudgetHold = hold.checkBudgetHold?.bind(framework);
  if (checkBudgetHold) hold.checkBudgetHold = (agentName: string) => { looks++; return checkBudgetHold(agentName); };
  const send = (text: string) => framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  framework.start();
  const of = (type: string) => traces.filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>;
  const kinds = (types: string[]) => traces.filter((e) => types.includes(e.type)).map((e) => e.type);
  return {
    framework,
    internal,
    membrane,
    send,
    of,
    kinds,
    looks: () => looks,
    close: async () => {
      await framework.stop();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe('a compile refused for budget holds its turn (#304)', () => {
  it('runs the refused turn once compression makes the context fit, with no new wake', async () => {
    await withBacklog({ fitAt: 40 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.equal(t.internal.providerGateBlocked('prime'), false, 'the hold leaves the provider gate open, so compression runs');
        assert.ok(await pollUntil(() => fits(backlog), 10_000), 'compression should catch up');
        const answered = await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000);
        assert.ok(answered, 'the refused turn should run once the context fits, with no new message to wake it');
        assert.equal(t.membrane.calls.length, 1, 'one provider call: the fresh compile after the hold, never a refused one');

        const held = t.of('inference:held');
        assert.equal(held.length, 1);
        assert.equal(held[0]!.errorType, 'over_budget');
        assert.equal(held[0]!.budget, 48_568);
        assert.equal(held[0]!.actual, 100_201);
        assert.equal((held[0]!.until as number) - (held[0]!.since as number), 30 * 60_000, 'a fixed 30-minute bound');
        const alerts = t.of('ops:alert').filter((e) => e.kind === 'context-refusal');
        assert.equal(alerts.length, 1, 'the context-refusal alert went out when the hold started');
        assert.match(String(alerts[0]!.message), /the turn is held until \S+ while compression catches up/);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.deepEqual(t.of('inference:exhausted'), [], 'the turn never failed');
        assert.deepEqual(
          t.kinds(['inference:started', 'inference:failed', 'inference:held', 'inference:hold_ended', 'inference:completed', 'inference:exhausted']),
          ['inference:started', 'inference:failed', 'inference:held', 'inference:hold_ended', 'inference:started', 'inference:completed'],
          'the refused attempt fails, the hold starts and ends, and the turn starts again and completes',
        );
        assert.ok(!storedText(t.framework).includes('[inference-failed]'), 'no failure marker is written for a held turn');
        assert.equal(t.internal.budgetHoldRecheckMs, 5_000, 'unshortened, the hold paces itself at the maintenance timer\'s default interval');
      } finally {
        await t.close();
      }
    });
  });

  it('tells the agent why its turn waited, in a note stored where the released turn read it', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, responses: 2 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
        const note = /\[budget-hold\] Your context didn't fit its budget \(100,201 tokens against 48,568\), so this turn waited \d+ s for compression to make room\./;
        assert.match(JSON.stringify(t.membrane.calls[0]), note);
        const notes = stored(t.framework).filter((m) => m.text.includes('[budget-hold]'));
        assert.equal(notes.length, 1, 'the note is stored once');
        assert.match(notes[0]!.text, note);
        t.send('And now?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered turn 2'), 5_000));
        assert.equal(t.membrane.calls.length, 2);
        assert.equal(JSON.stringify(t.membrane.calls[1]).split('[budget-hold]').length - 1, 1,
          'the next turn reads the stored note as history, and gets no note of its own');
      } finally {
        await t.close();
      }
    });
  });

  it('stores the note once: a restart inside the released turn compiles it where it was, with no second copy', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-restart-'));
      const membrane = new SequentialStreamMembrane();
      membrane.pushResponse(nearCapToolResponse());
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Answered after the restart' }]));
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'),
        membrane: membrane.asMembrane(),
        agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000 }],
        modules: [new BlobToolModule()],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 50,
        errorPolicy: { maxRetries: 3, onInferenceError: (_error, _agent, attempt) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((e) => traces.push(e));
      try {
        framework.start();
        framework.pushEvent({
          type: 'external-message', source: 'test', content: [{ type: 'text', text: 'fetch it' }], metadata: {}, triggerInference: true,
        } as unknown as ProcessEvent);
        assert.ok(await pollUntil(() => storedText(framework).includes('Answered after the restart'), 10_000));
        assert.ok(traces.some((e) => e.type === 'inference:held'), 'the turn was held first');
        assert.ok(traces.some((e) => e.type === 'inference:stream_restarted'), 'and restarted inside the turn');
        assert.equal(membrane.calls.length, 2);
        const copies = (i: number) => JSON.stringify(membrane.calls[i]).split('[budget-hold]').length - 1;
        assert.equal(copies(0), 1, 'the first compile after the release carries the note');
        assert.equal(copies(1), 1, 'the restart\'s compile has it once, where it was stored');
        assert.equal(stored(framework).filter((m) => m.text.includes('[budget-hold]')).length, 1);
      } finally {
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('stores the note as the host\'s own row, which leaves the turn\'s routing as it was', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      type Routing = { triggerChannel?: unknown; locus?: string; engaged: Set<string>; pin?: string; destination: string | null; arrivals: unknown[] };
      const routingNow = () => {
        const r = (t.framework as unknown as { turnRouting: Map<string, Routing> }).turnRouting.get('prime');
        return r && {
          triggerChannel: r.triggerChannel, locus: r.locus, engaged: [...r.engaged].sort(), pin: r.pin,
          destination: r.destination, arrivals: r.arrivals.length,
        };
      };
      const atStart: unknown[] = [];
      const afterCompile: unknown[] = [];
      t.framework.onTrace((e) => {
        if (e.type === 'inference:started') atStart.push(routingNow());
        if (e.type === 'inference:completed') afterCompile.push(routingNow());
      });
      try {
        await (t.framework as unknown as { handleMcplChannelIncoming: (e: unknown) => Promise<unknown> }).handleMcplChannelIncoming({
          type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:guild:chanA', messageId: 'm-1',
          author: { id: 'U1', name: 'owner' }, content: [{ type: 'text', text: 'Are you there?' }],
          timestamp: new Date().toISOString(), metadata: {}, triggerInference: true,
        });
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
        assert.equal(t.of('inference:held').length, 1);
        assert.ok(JSON.stringify(t.membrane.calls[0]).includes('[budget-hold]'), 'the released compile carried the note');
        const rows = (t.framework.getAgent('prime')!.getContextManager().queryMessages({}).messages as unknown as Array<{ metadata?: Record<string, unknown> }>)
          .filter((m) => JSON.stringify(m).includes('[budget-hold]'));
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.metadata?.system, true, 'stored as the host\'s own row');
        assert.equal(rows[0]!.metadata?.kind, 'context-injection');
        assert.equal(afterCompile.length, 1);
        const released = atStart[atStart.length - 1] as { triggerChannel?: unknown };
        assert.deepEqual(released.triggerChannel, { serverId: 'discord', channelId: 'discord:guild:chanA' }, 'the released turn starts from the message\'s channel');
        assert.deepEqual(afterCompile[0], released, 'and the stored note leaves its routing as it was');
      } finally {
        await t.close();
      }
    });
  });

  it('takes later wakes into the held turn, for one compile', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('First message');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.send('Second message, while held');
        assert.ok(await pollUntil(() => heldRequests(t.framework) === 2, 5_000), 'the second wake joins the hold');
        assert.equal(t.membrane.calls.length, 0, 'no compile while held, so no provider call');
        assert.equal(t.of('inference:failed').length, 1, 'only the first refusal: the second wake never compiled while held');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.equal(t.membrane.calls.length, 1, 'both wakes ran as one turn');
        const request = JSON.stringify(t.membrane.calls[0]);
        assert.ok(request.includes('First message') && request.includes('Second message, while held'));
        assert.equal(t.of('inference:held').length, 1, 'the second wake joined the hold, and started none');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps today\'s failure when nothing is pending: compression cannot change it', async () => {
    await withBacklog({ readyAt: 0 }, async () => {
      await errorLines(async (lines) => {
        const t = await residentTurn({ maintenanceIntervalMs: 50 });
        try {
          t.send('Are you there?');
          assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000), 'the turn fails, as before the hold');
          assert.deepEqual(t.of('inference:held'), []);
          assert.equal(t.of('inference:exhausted')[0]!.errorType, 'over_budget');
          assert.ok(storedText(t.framework).includes('[inference-failed]'), 'the agent gets the failure marker');
          assert.ok(await pollUntil(() => lines.some((l) => l.includes('drain kicked for prime')), 3_000));
          const kicks = lines.filter((l) => l.includes('drain kicked for prime'));
          assert.ok(kicks.every((l) => l.startsWith('[inference-failed] drain kicked for prime (OverBudget breaker, ')),
            `the breaker's kick logs as the breaker's: ${kicks.join(' | ')}`);
        } finally {
          await t.close();
        }
      });
    });
  });

  it('ends the hold when compression has nothing left to do and the context still does not fit', async () => {
    await withBacklog({ readyAt: 20 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['nothing_pending']);
        const exhausted = t.of('inference:exhausted')[0]!;
        assert.equal(exhausted.errorType, 'over_budget');
        assert.match(String(exhausted.error), /the turn was first held \d+ s ago; compression had nothing left to do and it still didn't fit/);
        assert.equal(t.membrane.calls.length, 0);
      } finally {
        await t.close();
      }
    });
  });

  it('ends the hold at its deadline, and the turn fails as a refused compile did', async () => {
    await withBacklog({}, async () => {
      const policyErrors: Error[] = [];
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 400, policyErrors });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        assert.match(String(t.of('inference:exhausted')[0]!.error), /the turn was first held \d+ s ago; the hold's 1 s bound passed and it still didn't fit/);
        assert.equal(t.membrane.calls.length, 0);
        const last = policyErrors.at(-1) as Error & { budget?: number; actual?: number };
        assert.equal(last.name, 'OverBudgetError', 'the error policy gets the refusal itself');
        assert.equal(last.budget, 48_568, 'with its figures');
        assert.match(last.message, /the turn was first held/);
      } finally {
        await t.close();
      }
    });
  });

  it('holds a later turn afresh after a hold that ended in failure, and after one that ran', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 400 });
      try {
        t.send('First');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        t.send('Second');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'a failed turn\'s spent hold does not pass to the next turn');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        backlog.fit = false;
        const before = Date.now();
        t.send('Third');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 3, 5_000));
        const third = t.of('inference:held')[2]!;
        assert.ok((third.since as number) >= before, 'its own start, not the released turn\'s');
        assert.ok((third.until as number) >= before + 400);
      } finally {
        await t.close();
      }
    });
  });

  it('runs the turn when the check fails for another reason, and the turn\'s own compile meets it', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        backlog.previewError = new Error('store read failed');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['check_failed']);
        assert.equal(backlog.previewError, undefined, 'the preview met the error');
        assert.ok(JSON.stringify(t.membrane.calls[0]).includes('[budget-hold]'), 'the turn that ran says why it waited');
      } finally {
        await t.close();
      }
    });
  });

  it('paces compression with the maintenance timer off: the drain kick runs again until it fits', async () => {
    await withBacklog({ fitAt: 20 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000),
          'the kick goes on past its 8 ticks while compression is pending');
        assert.ok(backlog.ticks >= 20);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      } finally {
        await t.close();
      }
    });
  });

  it('kicks the drain at once when the hold starts, and logs the kick as the hold\'s', async () => {
    await withBacklog({ fitAt: 8 }, async () => {
      await errorLines(async (lines) => {
        const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 60_000 });
        try {
          t.send('Are you there?');
          assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
          assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
          const kicks = lines.filter((l) => l.includes('drain kicked for prime'));
          assert.deepEqual(kicks, ['[budget-hold] drain kicked for prime (budget hold, 8 ticks)'], 'one kick, logged as the hold\'s');
        } finally {
          await t.close();
        }
      });
    });
  });

  it('with the maintenance timer off, a backlog that never moves costs a kick an interval, not a loop', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 100 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        const since = Date.now();
        assert.ok(await pollUntil(() => backlog.ticks >= 16, 5_000), 'it does kick again');
        await new Promise((r) => setTimeout(r, 300));
        const intervals = Math.ceil((Date.now() - since) / 100) + 1;
        assert.ok(backlog.ticks <= 8 * (intervals + 1), `${backlog.ticks} ticks in ${intervals} intervals`);
        assert.ok(backlog.previews <= intervals + 1, `${backlog.previews} checks in ${intervals} intervals`);
      } finally {
        await t.close();
      }
    });
  });

  it('with the maintenance timer off and the provider gate closed, looks again an interval later', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 50 });
      const open = t.internal.providerGateBlocked.bind(t.framework);
      let blocked = true;
      t.internal.providerGateBlocked = (name: string) => (name === 'prime' && blocked) || open(name);
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(backlog.ticks, 0, 'no kick while the gate is closed: its calls would park there');
        backlog.fit = true;
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000),
          'the hold looked again an interval later, with the gate still closed, and released the turn');
        assert.equal(backlog.ticks, 0);
        blocked = false;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
      } finally {
        await t.close();
      }
    });
  });

  it('keeps the held turn alive: the host reads it as undrained, its status shows the hold, and a surgery is refused naming it', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        const status = t.framework.getHostModeStatus();
        assert.equal(status.drained, false, 'a held turn is a turn alive');
        assert.deepEqual(status.activeTurnAgents, ['prime']);
        const agents = (t.framework.healthSnapshot() as { agents: Array<{ name: string; budgetHold: Record<string, unknown> | null }> }).agents;
        const hold = agents.find((a) => a.name === 'prime')!.budgetHold;
        assert.ok(hold, 'the status names the hold');
        assert.equal(hold!.errorType, 'over_budget');
        assert.equal(hold!.heldRequests, 1);
        assert.equal(status.gatedRequests, 0, 'the turn\'s own retry is no gated wake');
        t.send('Joined while held');
        assert.ok(await pollUntil(() => heldRequests(t.framework) === 2, 5_000));
        assert.equal(t.framework.getHostModeStatus().gatedRequests, 1, 'a wake that joined the hold waits to start');
        await assert.rejects(t.framework.switchBranch('main'), (e: Error) => {
          assert.equal((e as Error & { code?: string }).code, 'agent-busy');
          assert.match(e.message, /prime is idle\+turn-alive \(a budget hold keeps its turn to start again once its context fits, or at \S+ at the latest: Compile plan would exceed hard budget/);
          assert.match(e.message, /end it with quiesce with abandon: true/);
          return true;
        });
        assert.equal(heldRequests(t.framework), 2, 'the turn is still held');
      } finally {
        await t.close();
      }
    });
  });

  it('refuses a rollback while a turn is held, so the turn never runs on history rewound under it', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, responses: 2 });
      try {
        t.send('First');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        const msgs = t.framework.getAgent('prime')!.getContextManager().queryMessages({}).messages as unknown as Array<{ id: unknown }>;
        const answer = String(msgs[msgs.length - 1]!.id);
        backlog.fit = false;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        await assert.rejects(t.framework.rollbackToMessage('prime', { messageId: answer }), (e: Error) => {
          assert.equal((e as Error & { code?: string }).code, 'agent-busy');
          assert.match(e.message, /prime is idle\+turn-alive \(a budget hold/);
          return true;
        });
        assert.ok(storedText(t.framework).includes('Are you there?'), 'the held turn\'s message is still on the branch');
        backlog.fit = true;
        t.send('Still there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered turn 2'), 5_000));
        assert.ok(JSON.stringify(t.membrane.calls[1]).includes('Are you there?'), 'the released turn reads the message it was held for');
      } finally {
        await t.close();
      }
    });
  });

  it('stops the hold\'s drain kick once stop() begins, and starts no kick after it', async () => {
    await withBacklog({}, async (backlog) => {
      await errorLines(async (lines) => {
        const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
        const fw = t.framework as unknown as {
          maintenancePass: unknown;
          overBudgetDrainAfter: Map<string, unknown[]>;
          kickOverBudgetDrain: (name: string, agent: unknown, after?: () => void, by?: 'breaker' | 'hold') => string;
        };
        const proto = ContextManager.prototype as unknown as Patchable;
        let letGo = () => {};
        let stopping: Promise<void> | undefined;
        try {
          assert.ok(await pollUntil(() => fw.maintenancePass === null, 3_000), 'the start pass is done');
          const gate = new Promise<void>((resolve) => { letGo = resolve; });
          proto.tick = async function () { backlog.ticks++; await gate; };
          const before = backlog.ticks;
          t.send('Are you there?');
          assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.ticks === before + 1, 5_000),
            'the hold\'s kick is in its first tick');
          let stopped = false;
          stopping = t.close().then(() => { stopped = true; });
          await new Promise((r) => setTimeout(r, 200));
          assert.equal(stopped, false, 'stop() waits for the tick in flight');
          const waiting = fw.overBudgetDrainAfter.get('prime')?.length ?? 0;
          assert.equal(fw.kickOverBudgetDrain('prime', t.framework.getAgent('prime'), () => {}, 'hold'),
            'not kicked: the framework is stopping');
          assert.equal(fw.overBudgetDrainAfter.get('prime')?.length ?? 0, waiting, 'and keeps no callback');
          letGo();
          await stopping;
          assert.equal(backlog.ticks, before + 1, 'the kick ticked no more once stop() began');
          const kicks = lines.filter((l) => l.includes('drain kicked for prime'));
          assert.deepEqual(kicks, ['[budget-hold] drain kicked for prime (budget hold, 1 ticks, stopped as the framework stops)']);
        } finally {
          letGo();
          await (stopping ?? t.close());
        }
      });
    });
  });

  it('joins a drain kick already in flight: no second kick, and the hold looks when it ends', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      const fw = t.framework as unknown as {
        maintenancePass: unknown;
        overBudgetDrains: Set<Promise<void>>;
        overBudgetDrainAfter: Map<string, unknown[]>;
        kickOverBudgetDrain: (name: string, agent: unknown, after?: () => void, by?: 'breaker' | 'hold') => string;
      };
      const proto = ContextManager.prototype as unknown as Patchable;
      let letGo = () => {};
      try {
        assert.ok(await pollUntil(() => fw.maintenancePass === null, 3_000), 'the start pass is done');
        const gate = new Promise<void>((resolve) => { letGo = resolve; });
        proto.tick = async function () { backlog.ticks++; await gate; };
        const before = backlog.ticks;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.ticks === before + 1, 5_000),
          'the hold\'s kick is in its first tick');
        assert.equal(fw.overBudgetDrains.size, 1);
        let joined = 0;
        assert.equal(fw.kickOverBudgetDrain('prime', t.framework.getAgent('prime'), () => { joined++; }, 'hold'),
          'already draining');
        assert.equal(fw.overBudgetDrains.size, 1, 'no second kick starts');
        assert.equal(fw.overBudgetDrainAfter.get('prime')?.length, 2, 'its callback waits beside the hold\'s own');
        const asked = t.looks();
        letGo();
        assert.ok(await pollUntil(() => joined === 1 && !fw.overBudgetDrainAfter.has('prime'), 3_000),
          'both callbacks ran when the kick ended');
        assert.ok(t.looks() > asked, 'the hold looked when the kick ended');
        assert.equal(backlog.ticks, before + 8, 'one kick\'s eight ticks');
        assert.ok(await pollUntil(() => fw.overBudgetDrains.size === 0, 1_000), 'and the one kick has left the drains');
      } finally {
        letGo();
        await t.close();
      }
    });
  });

  it('keeps holding where a dry compile would resolve but the preview says the context does not fit', async () => {
    await withBacklog({ dryRunResolves: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 3, 5_000));
        assert.deepEqual(t.of('inference:hold_ended'), [], 'held through each look');
        assert.equal(backlog.compiles, 1, 'and never released into the refusal');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      } finally {
        await t.close();
      }
    });
  });

  it('asks for its verdict with the thinking binding the turn\'s compile carries, from the preview and from a dry compile', async () => {
    for (const previewless of [false, true]) {
      await withBacklog({ fitAt: 12, previewless }, async (backlog) => {
        const t = await residentTurn({ maintenanceIntervalMs: 50, thinkingBinding: { binds: true, dropBlock: true } });
        try {
          t.send('Are you there?');
          assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
          const binding = { binds: true, dropBlock: true, participant: 'prime' };
          assert.deepEqual(backlog.bindings.compile, [binding, binding], 'the refused compile and the released one');
          const asked = previewless ? backlog.bindings.dryRun : backlog.bindings.preview;
          assert.ok(asked.length >= 1);
          for (const given of asked) assert.deepEqual(given, binding);
          assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit'], 'the verdict was a fit, not a failed check');
        } finally {
          await t.close();
        }
      });
    }
  });

  it('falls back to a dry compile for a strategy with no preview, one at a time, and lands a fit', async () => {
    await withBacklog({ previewless: true, dryRunMs: 300, fitAt: 40, readyAt: 40 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 6_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000),
          'the turn runs soon after the fit, not at the deadline');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit'],
          'a refusal decided before compression finished is not taken for nothing pending');
        assert.ok(backlog.dryRuns >= 1 && backlog.previews >= 1, 'the preview had nothing to say, and a dry compile decided');
        assert.equal(backlog.mostDryRunsRunning, 1, 'one dry compile at a time');
        assert.ok(backlog.dryRunsAcrossFit >= 1, 'a dry compile began before the fit and ended after it, which is what this test is for');
      } finally {
        await t.close();
      }
    });
  });

  it('on the fallback path, looks again at the next pass after a message a dry compile straddled', async () => {
    await withBacklog({ previewless: true, stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.dryRuns >= 1 && backlog.dryRunsRunning === 0, 5_000));
        let release!: () => void;
        backlog.dryRunGate = new Promise<void>((resolve) => { release = resolve; });
        const dryRuns = backlog.dryRuns;
        t.send('A message while held');
        assert.ok(await pollUntil(() => backlog.dryRuns === dryRuns + 1, 2_000));
        backlog.fit = true;
        t.send('A second message while held');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('A second message while held'), 2_000));
        backlog.dryRunGate = undefined;
        release();
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the stale refusal stood only until the next pass, which the second message had given something new to look at');
        assert.equal(backlog.mostDryRunsRunning, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('on the fallback path, sets aside a refusal that compression coming back made stale', async () => {
    await withBacklog({ previewless: true, noProgress: true, alwaysPending: true, readyAt: 0 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.dryRuns >= 1 && backlog.dryRunsRunning === 0, 5_000));
        let release!: () => void;
        backlog.dryRunGate = new Promise<void>((resolve) => { release = resolve; });
        const dryRuns = backlog.dryRuns;
        backlog.alwaysPending = false;
        assert.ok(await pollUntil(() => backlog.dryRuns === dryRuns + 1, 2_000));
        backlog.alwaysPending = true;
        backlog.dryRunGate = undefined;
        release();
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(t.of('inference:hold_ended'), [], 'the stale refusal did not end the hold as one with nothing pending');
        assert.deepEqual(t.of('inference:exhausted'), []);
        backlog.fit = true;
        t.send('Still there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      } finally {
        await t.close();
      }
    });
  });

  it('on the fallback path, holds on when compression comes back during a dry compile that its progress does not show', async () => {
    await withBacklog({ previewless: true, stalled: true, alwaysPending: true, readyAt: 0 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.dryRuns >= 1 && backlog.dryRunsRunning === 0, 5_000));
        let release!: () => void;
        backlog.dryRunGate = new Promise<void>((resolve) => { release = resolve; });
        const dryRuns = backlog.dryRuns;
        backlog.alwaysPending = false;
        t.send('Still there?');
        assert.ok(await pollUntil(() => backlog.dryRuns === dryRuns + 1, 2_000));
        backlog.alwaysPending = true;
        backlog.dryRunGate = undefined;
        release();
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(t.of('inference:hold_ended'), [], 'the refusal met compression with work again, so the hold goes on');
        assert.deepEqual(t.of('inference:exhausted'), []);
        backlog.fit = true;
        t.send('And now?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      } finally {
        await t.close();
      }
    });
  });

  it('tells a turn that fits after its hold\'s deadline why it waited', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, holdMs: 400 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => backlog.previews >= 1, 2_000));
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        assert.match(JSON.stringify(t.membrane.calls[0]), /\[budget-hold\][^"]*so this turn waited \d+ s for compression to make room\./);
        assert.deepEqual(t.of('inference:exhausted'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('refuses an undo while a turn is held, naming the hold', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('A turn that fits');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        backlog.fit = false;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.throws(() => t.framework.undoLastTurn('prime'), (e: Error) => {
          assert.equal((e as Error & { code?: string }).code, 'agent-busy');
          assert.match(e.message, /Cannot undo while prime is idle\+turn-alive \(a budget hold/);
          return true;
        });
        assert.equal(t.framework.getUndoRedoState('prime').undoDepth, 1, 'the earlier turn is still there to undo');
        assert.ok(storedText(t.framework).includes('Are you there?'));
      } finally {
        await t.close();
      }
    });
  });

  it('makes one held turn one undo step, which keeps the inputs that joined it', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('First message');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.send('Second message, while held');
        assert.ok(await pollUntil(() => heldRequests(t.framework) === 2, 5_000));
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.equal(t.framework.getUndoRedoState('prime').undoDepth, 1, 'the refused start left no undo step of its own');
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        const text = storedText(t.framework);
        assert.ok(!text.includes('Answered once it fit'), 'the undo takes the reply');
        assert.ok(text.includes('First message') && text.includes('Second message, while held'), 'and keeps both inputs');
      } finally {
        await t.close();
      }
    });
  });

  it('makes a turn held on its error policy\'s retry one undo step too', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, failFirstStream: () => { backlog.fit = false; } });
      try {
        t.send('First message');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000), 'the retry\'s compile is refused and held');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.equal(t.framework.getUndoRedoState('prime').undoDepth, 1, 'one undo step for the turn');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps the turn\'s one undo step when its tool-result guard\'s retry is held', async () => {
    const t = await heldRestart(['Answered once it fit'], { guardRetry: true });
    try {
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000), 'the guard\'s retry is refused and held');
      t.fit();
      assert.ok(await pollUntil(() => t.of('inference:completed').length === 1, 5_000));
      assert.equal(t.framework.getUndoRedoState('prime').undoDepth, 1, 'the turn\'s first start recorded its one undo step, and the hold gave none of it back');
    } finally {
      await t.close();
    }
  });

  it('gives up the undo step of a start that reaches its compile while the hold waits', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('First message');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000));
        const fw = t.framework as unknown as { startAgentStream: (agent: unknown, trigger: unknown, attempt: number) => Promise<unknown> };
        await fw.startAgentStream(t.framework.getAgent('prime'), { agentName: 'prime', reason: 'test-start', source: 'test', timestamp: Date.now() }, 0);
        assert.equal(t.of('inference:held').length, 1, 'it joined the hold rather than starting another');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.equal(t.framework.getUndoRedoState('prime').undoDepth, 1, 'the held turn is still one undo step');
      } finally {
        await t.close();
      }
    });
  });

  it('holds a released turn again with its first refusal\'s start and deadline when its own compile still refuses', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: 3 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        const held = t.of('inference:held');
        assert.equal(held.length, 3, 'each refusal of the released turn held it again');
        assert.ok(held.every((e) => e.since === held[0]!.since), 'with the first refusal\'s start');
        assert.ok(held.every((e) => e.until === held[0]!.until), 'and its deadline');
        assert.deepEqual(t.of('inference:exhausted'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('does not release a turn its compile refused again until compression moves or the store changes', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: Infinity, stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'released once, refused, and held again');
        const compiles = backlog.compiles;
        const asked = t.looks();
        await new Promise((r) => setTimeout(r, 600));
        assert.ok(t.looks() > asked, 'passes asked the hold to look');
        assert.equal(t.of('inference:held').length, 2, 'no release on the same evidence, pass after pass');
        assert.equal(backlog.compiles, compiles, 'and no compile refused for it');
        t.send('A message while held');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 3, 3_000),
          'a message is new evidence: the hold looks, releases, and holds again');
      } finally {
        await t.close();
      }
    });
  });

  it('looks again only once something that could make the context fit has changed', async () => {
    await withBacklog({ stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        let previews = backlog.previews;
        let asked = t.looks();
        await new Promise((r) => setTimeout(r, 500));
        assert.ok(t.looks() > asked, 'passes asked the hold to look');
        assert.equal(backlog.previews, previews, 'and it took no verdict while nothing changed');
        t.framework.updateAgentRuntimeSettings('prime', { contextBudgetTokens: 200_000 });
        previews = backlog.previews;
        assert.ok(await pollUntil(() => backlog.previews > previews, 2_000), 'it looks once the budget changes');
        previews = backlog.previews;
        asked = t.looks();
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(t.looks() > asked);
        assert.equal(backlog.previews, previews);
        backlog.stalled = false;
        assert.ok(await pollUntil(() => backlog.previews > previews, 2_000), 'and once compression moves');
      } finally {
        await t.close();
      }
    });
  });

  it('does not release a re-refused turn again on what its own start stored, an injection whose content changed included', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: Infinity, stalled: true }, async (backlog) => {
      let starts = 0;
      const t = await residentTurn({ maintenanceIntervalMs: 50, context: () => `status at start ${++starts}` });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'released once, refused, and held again');
        const stored = (t.framework.getAgent('prime')!.getContextManager().queryMessages({}).messages as unknown as Array<{ content: Array<{ text?: string }> }>)
          .filter((m) => (m.content[0]?.text ?? '').startsWith('status at start'));
        assert.equal(stored.length, 2, 'each start stored the injection, changed');
        const compiles = backlog.compiles;
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(t.of('inference:held').length, 2, 'no release on what the released start stored');
        assert.equal(backlog.compiles, compiles);
      } finally {
        await t.close();
      }
    });
  });

  it('does not release a re-refused turn again on the clock row its own start stored', async () => {
    await withBacklog({ alwaysPending: true, stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, clock: { intervalSeconds: 1 } });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        await new Promise((r) => setTimeout(r, 1_100));
        backlog.fit = true;
        backlog.refuseCompiles = Infinity;
        const cm = t.framework.getAgent('prime')!.getContextManager();
        const messages = cm.queryMessages({}).messages;
        cm.editMessage(messages[messages.length - 1]!.id, [{ type: 'text', text: 'Hi?' }]);
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'released on the edit, refused, and held again');
        const clocks = (cm.queryMessages({}).messages as unknown as Array<{ metadata?: { kind?: string } }>).filter((m) => m.metadata?.kind === 'clock');
        assert.equal(clocks.length, 2, 'the released start stored a clock row, a boundary after the first start\'s');
        const compiles = backlog.compiles;
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(t.of('inference:held').length, 2, 'no release on the clock row the released start stored');
        assert.equal(backlog.compiles, compiles);
      } finally {
        await t.close();
      }
    });
  });

  it('looks again when the budget its next compile plans at changes, as when a tool-result reserve settles', async () => {
    await withBacklog({ stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      let reserve = 5_000;
      const agent = t.framework.getAgent('prime') as unknown as { toolResultGuard: object };
      Object.defineProperty(agent.toolResultGuard, 'pendingWireReserveTokens', { get: () => reserve, configurable: true });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        await new Promise((r) => setTimeout(r, 200));
        const previews = backlog.previews;
        reserve = 0;
        assert.ok(await pollUntil(() => backlog.previews > previews, 2_000), 'a smaller reserve, which can make the context fit, brings a look');
      } finally {
        await t.close();
      }
    });
  });

  it('for a strategy that reports no progress, does not release a re-refused turn again until compression finishes', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: Infinity, noProgress: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'released once, refused, and held again');
        const compiles = backlog.compiles;
        const asked = t.looks();
        await new Promise((r) => setTimeout(r, 600));
        assert.ok(t.looks() > asked, 'passes asked the hold to look');
        assert.equal(t.of('inference:held').length, 2, 'no release pass after pass, with no progress to go on');
        assert.equal(backlog.compiles, compiles);
        backlog.alwaysPending = false;
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 2, 3_000), 'it looks again once nothing is pending');
      } finally {
        await t.close();
      }
    });
  });

  it('looks again when compression moved while a released turn compiled, though that compile was refused', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: 2, progress: 0, slowCompile: { nth: 2, ms: 300 } }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => backlog.compiles === 2, 5_000), 'released, and its compile has begun');
        backlog.progress = 1;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000),
          'the step that landed during the refused compile brought a look, which released the turn again');
        assert.equal(t.of('inference:held').length, 2);
      } finally {
        await t.close();
      }
    });
  });

  it('looks again when a message is removed while held', async () => {
    await withBacklog({ stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        await new Promise((r) => setTimeout(r, 200));
        const previews = backlog.previews;
        const asked = t.looks();
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(t.looks() > asked, 'passes asked the hold to look');
        assert.equal(backlog.previews, previews, 'and nothing had changed, so it took no verdict');
        const cm = t.framework.getAgent('prime')!.getContextManager();
        const messages = cm.queryMessages({}).messages;
        cm.removeMessage(messages[messages.length - 1]!.id);
        assert.ok(await pollUntil(() => backlog.previews > previews, 2_000), 'a removed message brings a look');
      } finally {
        await t.close();
      }
    });
  });

  it('looks again when a message is removed and another arrives between two looks', async () => {
    await withBacklog({ stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        await new Promise((r) => setTimeout(r, 200));
        const previews = backlog.previews;
        const cm = t.framework.getAgent('prime')!.getContextManager();
        const length = cm.getMessageCount();
        const messages = cm.queryMessages({}).messages;
        cm.removeMessage(messages[messages.length - 1]!.id);
        cm.addMessage('User', [{ type: 'text', text: 'Still there?' }]);
        assert.equal(cm.getMessageCount(), length, 'the store is as long as it was');
        assert.ok(await pollUntil(() => backlog.previews > previews, 2_000), 'yet the removal brings a look');
      } finally {
        await t.close();
      }
    });
  });

  it('looks again when a message is edited while held', async () => {
    await withBacklog({ stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        await new Promise((r) => setTimeout(r, 200));
        const previews = backlog.previews;
        const cm = t.framework.getAgent('prime')!.getContextManager();
        const messages = cm.queryMessages({}).messages;
        cm.editMessage(messages[messages.length - 1]!.id, [{ type: 'text', text: 'Hi?' }]);
        assert.ok(await pollUntil(() => backlog.previews > previews, 2_000), 'an edit, which can shrink the context, brings a look');
      } finally {
        await t.close();
      }
    });
  });

  it('ends a released turn refused with nothing pending as a hold with nothing left to do', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: Infinity, slowCompile: { nth: 2, ms: 300 } }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => backlog.compiles === 2, 5_000), 'released, and its compile has begun');
        backlog.alwaysPending = false;
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.equal(t.of('inference:held').length, 1, 'not held again');
        assert.match(String(t.of('inference:exhausted')[0]!.error),
          /the turn was first held \d+ s ago; compression had nothing left to do and it still didn't fit/);
      } finally {
        await t.close();
      }
    });
  });

  it('starts no hold for a compile refused once stop() has closed admission', async () => {
    await withBacklog({ slowCompile: { nth: 1, ms: 300 } }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      t.send('Are you there?');
      assert.ok(await pollUntil(() => backlog.compiles === 1, 5_000), 'the turn\'s compile has begun');
      await t.close();
      assert.ok(await pollUntil(() => t.of('inference:failed').length === 1, 3_000), 'the compile was refused');
      assert.deepEqual(t.of('inference:held'), [], 'and no hold began, since stop had closed admission');
    });
  });

  it('holds a context refusal as it holds an over-budget one', async () => {
    await withBacklog({ fitAt: 40, refusalName: 'UncoveredDropError' }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
        const held = t.of('inference:held');
        assert.equal(held.length, 1);
        assert.equal(held[0]!.errorType, 'context_refusal');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.deepEqual(t.of('inference:exhausted'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('fails a released turn refused after its hold\'s deadline, rather than holding it afresh', async () => {
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: Infinity, slowCompile: { nth: 2, ms: 500 } }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 300 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000));
        assert.equal(heldRequests(t.framework), undefined, 'a released turn is not waiting, so the status shows no hold');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.equal(t.of('inference:held').length, 1, 'no second hold past the first one\'s deadline');
        assert.match(String(t.of('inference:exhausted')[0]!.error), /the hold's 1 s bound passed and it still didn't fit/);
      } finally {
        await t.close();
      }
    });
  });

  it('says when a spent turn was first held as of each refusal it reports', async () => {
    await withBacklog({ slowCompile: { nth: 2, ms: 500 } }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, holdMs: 200 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        (t.internal.budgetHolds as unknown as Map<string, { startedAt: number }>).get('prime')!.startedAt -= 600_000;
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.match(String(t.of('inference:exhausted')[0]!.error), /the turn was first held 10 min ago; the hold's/);
      } finally {
        await t.close();
      }
    });
  });

  it('says a wait of minutes in minutes, in the note and in the failure', async () => {
    type Times = { state: string; startedAt: number; until: number };
    const times = (t: { internal: Internal }) => (t.internal.budgetHolds as unknown as Map<string, Times>).get('prime')!;
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        times(t).startedAt = Date.now() - 7 * 60_000;
        backlog.fit = true;
        assert.ok(await pollUntil(() => t.membrane.calls.length === 1, 5_000));
        assert.ok(JSON.stringify(t.membrane.calls[0]).includes(
          "[budget-hold] Your context didn't fit its budget (100,201 tokens against 48,568), so this turn waited 7 min for compression to make room."));
      } finally {
        await t.close();
      }
    });
    await withBacklog({ fit: true, alwaysPending: true, refuseCompiles: Infinity, slowCompile: { nth: 2, ms: 300 } }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => times(t)?.state === 'released' && backlog.compiles === 2, 5_000), 'released, and its compile has begun');
        times(t).startedAt = Date.now() - 30 * 60_000;
        times(t).until = Date.now() - 1;
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.ok(String(t.of('inference:exhausted')[0]!.error).endsWith(
          "(the turn was first held 30 min ago; the hold's 30 min bound passed and it still didn't fit)"),
          String(t.of('inference:exhausted')[0]!.error));
      } finally {
        await t.close();
      }
    });
  });

  it('ends a released turn the inference policy declines: nothing of its hold reaches a later turn', async () => {
    await withBacklog({}, async (backlog) => {
      let decline = false;
      const t = await residentTurn({ maintenanceIntervalMs: 50, inferencePolicy: { shouldInfer: () => !decline } });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        const openLogical = (t.framework as unknown as { openLogical: Map<string, unknown> }).openLogical;
        assert.ok(openLogical.has('prime'), 'the held turn\'s logical turn stays open');
        decline = true;
        backlog.fit = true;
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1 && t.internal.budgetHolds.size === 0, 3_000),
          'released, declined, and its record gone');
        assert.equal(t.membrane.calls.length, 0);
        assert.ok(!openLogical.has('prime'), 'and the decline closed it');
        decline = false;
        t.send('A later turn');
        assert.ok(await pollUntil(() => t.membrane.calls.length === 1, 3_000));
        assert.ok(!JSON.stringify(t.membrane.calls[0]).includes('[budget-hold]'), 'the later turn carries no note of the declined one\'s wait');
      } finally {
        await t.close();
      }
    });
  });

  it('ends a released turn that a stop reaches before it sends anything: its record goes, and a later turn gets no note of its own', async () => {
    let open!: () => void;
    const until = new Promise<void>((resolve) => { open = resolve; });
    await withBacklog({ compileGate: { nth: 2, until } }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, responses: 2 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        backlog.fit = true;
        assert.ok(await pollUntil(() => backlog.compiles === 2, 3_000), 'the hold released the turn into its compile');
        assert.equal(t.framework.abortInference('prime'), true, 'a stop made while the released turn compiles is reported taken');
        open();
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1, 3_000), 'the stop ended the turn at the check after its compile');
        assert.equal(t.of('inference:completed').length, 0, 'the stopped turn completed nothing');
        assert.equal(t.internal.budgetHolds.size, 0, 'the hold\'s record went with the turn');
        t.send('A later turn');
        assert.ok(await pollUntil(() => t.of('inference:completed').length === 1, 3_000), 'the later turn ran');
        const later = t.membrane.calls[t.membrane.calls.length - 1];
        assert.equal(JSON.stringify(later).split('[budget-hold]').length - 1, 1,
          'the later turn reads the note the stopped turn\'s start stored, and gets none of its own');
      } finally {
        open();
        await t.close();
      }
    });
  });

  it('ends a turn whose compile a stop reached, rather than holding it, when that compile is refused for budget', async () => {
    let open!: () => void;
    const until = new Promise<void>((resolve) => { open = resolve; });
    await withBacklog({ compileGate: { nth: 1, until } }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => backlog.compiles === 1, 5_000), 'the turn is in its compile');
        assert.equal(t.framework.abortInference('prime'), true, 'a stop made while the turn compiles is reported taken');
        open();
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1, 3_000), 'the stop ended the turn at its failure');
        assert.equal(t.of('inference:held').length, 0, 'the refused turn was not held');
        assert.equal(t.internal.budgetHolds.size, 0);
        assert.equal(t.membrane.calls.length, 0, 'nothing was sent');
      } finally {
        open();
        await t.close();
      }
    });
  });

  it('holds a conversation agent\'s refused turn as it holds a resident\'s', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      const fw = t.framework as unknown as {
        conversationRouter: unknown;
        createConversationAgent: (name: string, channelId: string) => Promise<unknown>;
      };
      const fork = 'prime--chanA';
      try {
        fw.conversationRouter = {
          templateAgent: 'prime', expired: () => [], channelForAgent: () => 'chanA', touch: () => {},
          getBinding: () => undefined, closurePrompt: () => undefined,
        };
        await fw.createConversationAgent(fork, 'chanA');
        backlog.fit = false;
        backlog.fitAt = backlog.ticks + 12;
        t.internal.pendingRequests.push({ agentName: fork, reason: 'external-message', source: 'test', timestamp: Date.now() } as never);
        assert.ok(await pollUntil(() => t.membrane.calls.length === 1, 10_000), 'the fork\'s turn runs once its context fits');
        const held = t.of('inference:held');
        assert.deepEqual(held.map((e) => e.agentName), [fork], 'the fork\'s refused turn was held');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => [e.agentName, e.outcome]), [[fork, 'fit']]);
        assert.deepEqual(t.of('inference:exhausted'), []);
      } finally {
        fw.conversationRouter = undefined;
        await t.close();
      }
    });
  });

  it('leaves nothing of a hold after a restart: its messages stay, and the next wake compiles afresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-hold-restart-'));
    try {
      await withBacklog({}, async (backlog) => {
        const first = await residentTurn({ maintenanceIntervalMs: 50, storePath: join(dir, 'store') });
        try {
          first.send('Are you there?');
          assert.ok(await pollUntil(() => first.of('inference:held').length === 1, 5_000));
        } finally {
          await first.close();
        }
        assert.deepEqual(first.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        backlog.fit = true;
        const second = await residentTurn({ maintenanceIntervalMs: 50, storePath: join(dir, 'store') });
        try {
          assert.equal(heldRequests(second.framework), undefined, 'no hold after the restart');
          assert.ok(storedText(second.framework).includes('Are you there?'), 'the held turn\'s message is in the store');
          second.send('Still there?');
          assert.ok(await pollUntil(() => second.membrane.calls.length === 1, 5_000));
          const request = JSON.stringify(second.membrane.calls[0]);
          assert.ok(request.includes('Are you there?') && request.includes('Still there?'),
            'the next wake compiles afresh, from the store');
          assert.deepEqual(second.of('inference:held'), []);
        } finally {
          await second.close();
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an ephemeral run to fail as before: its caller is waiting', async () => {
    await withBacklog({}, async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-eph-'));
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 50,
        errorPolicy: { maxRetries: 3, onInferenceError: (_error, _agent, attempt) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((e) => traces.push(e));
      try {
        const { agent, contextManager } = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
        });
        contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        const run = framework.runEphemeralToCompletion(agent, contextManager);
        framework.start();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('the run was still waiting after 5 s')), 5_000);
        });
        try {
          await assert.rejects(Promise.race([run, bound]), /exceed hard budget/);
        } finally {
          clearTimeout(timer);
        }
        assert.deepEqual(traces.filter((e) => e.type === 'inference:held'), []);
      } finally {
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('holds a batch-only start\'s request as an ordinary cause, which no cancellation withdraws', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.internal.pendingRequests.push({
          agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
          coalescingSubject: 'zz-subject', coalescingBatch: true, coalescingBatchSubjects: ['zz-subject'],
        } as unknown as { agentName: string });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        const held = holdOf(t)!.heldRequests;
        assert.equal(held.length, 1);
        assert.equal(held[0]!.coalescingBatch, undefined, 'no longer batch-only, so the released start keeps its turn');
        assert.equal(held[0]!.coalescingBatchSubjects, undefined);
        (t.framework as unknown as { cancelCoalescedWakes: (subject: string) => void }).cancelCoalescedWakes('zz-subject');
        assert.equal(holdOf(t)!.heldRequests.length, 1, 'the turn keeps its own cause');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
      } finally {
        await t.close();
      }
    });
  });

  it('lets a withdrawn coalesced wake leave a hold, as it leaves a provider hold', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.internal.pendingRequests.push({
          agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(), coalescingSubject: 'zz-retracted',
        } as unknown as { agentName: string });
        assert.ok(await pollUntil(() => holdOf(t)?.heldRequests.length === 2, 5_000), 'the wake joins the hold');
        (t.framework as unknown as { cancelCoalescedWakes: (subject: string) => void }).cancelCoalescedWakes('zz-retracted');
        assert.deepEqual(holdOf(t)!.heldRequests.map((r) => r.coalescingSubject), [undefined], 'the withdrawn wake is gone, the turn\'s own stays');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps a closing conversation\'s held closure turn from the reaper', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      const fw = t.framework as unknown as {
        conversationRouter: unknown; lastConversationSweep: number; closingConversationAgents: Set<string>;
        sweepExpiredConversations: () => void; agents: Map<string, unknown>;
      };
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        fw.conversationRouter = { expired: () => [] };
        fw.lastConversationSweep = 0;
        fw.closingConversationAgents.add('prime');
        fw.sweepExpiredConversations();
        assert.ok(fw.agents.has('prime'), 'the held closure turn is unfinished work');
        assert.ok(holdOf(t), 'and its hold stays');
      } finally {
        fw.closingConversationAgents.delete('prime');
        fw.conversationRouter = undefined;
        await t.close();
      }
    });
  });

  it('drops the hold\'s record when the released start fails outside its compile', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      const fw = t.framework as unknown as { recordTurnCheckpoint: (name: string) => void };
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000));
        const original = fw.recordTurnCheckpoint;
        let failed = 0;
        fw.recordTurnCheckpoint = function (this: unknown, name: string) {
          if (failed++ === 0) throw new Error('ENOSPC: no space left on device');
          return original.call(this, name);
        };
        backlog.fit = true;
        assert.ok(await pollUntil(() => failed > 0 && t.internal.budgetHolds.size === 0, 3_000),
          'nothing of the failed turn\'s hold is left for the next');
      } finally {
        await t.close();
      }
    });
  });

  it('opens the event gate again when a held continuation resumes', async () => {
    const proto = ContextManager.prototype as unknown as Patchable;
    const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady };
    let real = 0;
    proto.compile = async function (this: unknown, ...args: unknown[]) {
      const dryRun = (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true;
      if (!dryRun && ++real === 2) {
        throw Object.assign(new Error('Compile plan would exceed hard budget: budget=48568'), { name: 'OverBudgetError', budget: 48_568, actual: 49_000 });
      }
      return original.compile.apply(this, args);
    };
    proto.tick = async function () {};
    proto.isReady = function () { return false; };
    const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-gate-'));
    const membrane = new SequentialStreamMembrane();
    membrane.pushResponse(nearCapToolResponse());
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Answered after the restart' }]));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000 }],
      modules: [new BlobToolModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 50,
      gate: { config: { policies: [], default: 'skip' } },
      errorPolicy: { maxRetries: 3, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
    });
    const gate = (framework as unknown as { eventGate: { inferenceDiagnostics(): { inferring: string[] } } }).eventGate;
    const traces: TraceEvent[] = [];
    const inferringDuringResume: string[][] = [];
    framework.onTrace((e) => {
      traces.push(e);
      if (e.type === 'inference:content_block' && traces.some((x) => x.type === 'inference:hold_ended')) {
        inferringDuringResume.push(gate.inferenceDiagnostics().inferring);
      }
    });
    try {
      framework.start();
      framework.getAgent('prime')!.getContextManager().addMessage('user', [{ type: 'text', text: 'fetch it' }]);
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'prime', reason: 'external-message', source: 'test', timestamp: Date.now() });
      assert.ok(await pollUntil(() => storedText(framework).includes('Answered after the restart'), 10_000));
      const held = traces.filter((e) => e.type === 'inference:held');
      assert.equal(held.length, 1, 'the restart\'s refused compile was held');
      assert.ok(inferringDuringResume.length >= 1);
      assert.ok(inferringDuringResume.every((names) => names.includes('prime')), 'the resumed turn is inferring at the gate, so its events buffer');
      assert.ok(await pollUntil(() => !gate.inferenceDiagnostics().inferring.includes('prime'), 2_000), 'the gate closes when the turn ends');
    } finally {
      await framework.stop();
      Object.assign(proto, original);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ends the held turn and drops the hold, its requests and what it left for the name, at stop and at disposal', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      let closed = false;
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await t.close();
        closed = true;
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.of('inference:aborted').length, 1, 'the stop ended the held turn');
        assert.deepEqual(t.internal.pendingRequests.filter((r) => r.agentName === 'prime'), [], 'the held request went with the stop');
        assert.equal(t.membrane.calls.length, 0);
        assert.equal(t.internal.budgetHolds.size, 0);
      } finally {
        if (!closed) await t.close();
      }
    });
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 300 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.internal.disposeConversationAgent('prime');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.of('inference:aborted').length, 1, 'the disposal ended the held turn');
        assert.equal(t.internal.budgetHolds.size, 0, 'a later agent of the name starts with none of it');
        await new Promise((r) => setTimeout(r, 450));
        assert.deepEqual(t.internal.pendingRequests.filter((r) => r.agentName === 'prime'), []);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
      } finally {
        await t.close();
      }
    });
  });
  it('lets a quiesce wait for a held continuation, which runs once its hold ends while the wakes that joined it wait for resume', async () => {
    const t = await heldRestart(['Answered after the restart', 'Answered the wake']);
    try {
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 10_000), 'the restart is held');
      t.internal.pendingRequests.push({ agentName: 'prime', reason: 'external-message', source: 'test', timestamp: Date.now() } as unknown as { agentName: string });
      assert.ok(await pollUntil(() => holdOf(t)?.heldRequests.length === 2, 3_000), 'a wake joins the hold');
      const status = await t.framework.quiesce({ reason: 'test', timeoutMs: 1_000 });
      assert.equal(status.drained, false, 'the held turn is alive, so the drain waits for it');
      assert.deepEqual(status.activeTurnAgents, ['prime']);
      assert.equal(t.membrane.calls.length, 1);
      t.fit();
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered after the restart'), 5_000),
        'the continuation runs while the host is quiesced, as a turn alive at the quiesce does');
      assert.ok(await pollUntil(() => t.framework.getHostModeStatus().drained, 3_000), 'and the host is then drained');
      assert.equal(t.framework.getHostModeStatus().gatedRequests, 1, 'with the joined wake waiting');
      assert.equal(t.membrane.calls.length, 2);
      await t.framework.resume();
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered the wake'), 5_000), 'the wake runs at resume');
      assert.equal(t.membrane.calls.length, 3);
    } finally {
      await t.close();
    }
  });

  it('ends a held turn at a quiesce\'s abandon, and the wakes that joined it wait for resume', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        t.send('Joined while held');
        assert.ok(await pollUntil(() => heldRequests(t.framework) === 2, 5_000));
        const status = await t.framework.quiesce({ reason: 'test', timeoutMs: 1_000, abandon: true });
        assert.equal(status.drained, true, 'the abandon ended the held turn');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.of('inference:aborted').length, 1, 'one terminal event for the turn');
        assert.equal(t.internal.budgetHolds.size, 0);
        assert.equal(status.gatedRequests, 1, 'the wake that joined it waits for resume');
        await t.framework.switchBranch('main');
        backlog.fit = true;
        await t.framework.resume();
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000),
          'the joined wake runs as a turn of its own at resume');
        assert.equal(t.membrane.calls.length, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('ends a held turn at a caller\'s stop, and the wakes that joined it run as a turn of their own', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        t.send('Joined while held');
        assert.ok(await pollUntil(() => heldRequests(t.framework) === 2, 5_000));
        backlog.fit = true;
        assert.equal(t.framework.abortInference('prime'), true, 'the stop is reported taken');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.of('inference:aborted').length, 1, 'one terminal event for the turn');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000),
          'the joined wake runs as a turn of its own');
        assert.equal(t.membrane.calls.length, 1);
        assert.equal(t.of('inference:held').length, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('gives a deferred batch\'s wake that joins a held continuation a fresh turn of its own', async () => {
    const t = await heldRestart(['Answered after the restart', 'Answered the batch']);
    try {
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 10_000), 'the restart is held');
      t.internal.pendingRequests.push({
        agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
        coalescingSubject: 'zz-subject', coalescingBatch: true, coalescingBatchSubjects: ['zz-subject'],
      } as unknown as { agentName: string });
      assert.ok(await pollUntil(() => holdOf(t)?.heldRequests.length === 2, 3_000), 'the batch\'s wake joins the hold');
      t.fit();
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered after the restart'), 5_000), 'the continuation runs');
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered the batch'), 5_000), 'the batch\'s wake gets a fresh turn');
      assert.equal(t.membrane.calls.length, 3);
    } finally {
      await t.close();
    }
  });

  it('holds nothing in a framework that was never started: the refusal takes the error policy\'s path, as before', async () => {
    await withBacklog({}, async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-unstarted-'));
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'),
        membrane: new SequentialStreamMembrane().asMembrane(),
        agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
        modules: [new InboxModule()],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 50,
        errorPolicy: { maxRetries: 3, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((e) => traces.push(e));
      try {
        framework.pushEvent({
          type: 'external-message', source: 'test', content: [{ type: 'text', text: 'Are you there?' }], metadata: {}, triggerInference: true,
        } as unknown as ProcessEvent);
        await framework.runUntilIdle();
        assert.equal(traces.filter((e) => e.type === 'inference:held').length, 0, 'no run loop would run a released turn');
        const exhausted = traces.filter((e) => e.type === 'inference:exhausted') as unknown as Array<{ errorType?: string }>;
        assert.equal(exhausted.length, 1, 'the turn fails before runUntilIdle returns');
        assert.equal(exhausted[0]!.errorType, 'over_budget', 'from the refusal, by the error policy\'s path');
      } finally {
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('looks again when compression stops being pending though the strategy\'s progress snapshot stands still', async () => {
    await withBacklog({ progress: 1, readyAt: 30 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => backlog.ticks >= 30, 5_000), 'compression stops being pending');
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000), 'the hold ends without waiting for its deadline');
        assert.equal(t.of('inference:hold_ended')[0]!.outcome, 'nothing_pending');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps the undo history whole at its limit: a held start gives back the checkpoint its record evicted', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      const checkpoints = t.framework as unknown as {
        getTurnCheckpoints: (agentName: string) => Array<{ turnIndex: number }>;
        saveTurnCheckpoints: (agentName: string, checkpoints: unknown[]) => void;
        turnCounters: Map<string, number>;
      };
      try {
        const full = Array.from({ length: 20 }, (_, i) => ({ agentName: 'prime', turnIndex: i, sequenceBefore: i * 3, branchName: `b${i}`, timestamp: i }));
        checkpoints.saveTurnCheckpoints('prime', full.map((c) => ({ ...c })));
        checkpoints.turnCounters.set('prime', 20);
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.deepEqual(checkpoints.getTurnCheckpoints('prime'), full,
          'the twenty checkpoints from before the turn, the oldest included, each as it was');
        assert.equal(checkpoints.turnCounters.get('prime'), 20, 'and the turn index the held start took');
      } finally {
        await t.close();
      }
    });
  });

  it('invalidates redo at a held start, as at any turn\'s first start, and leaves undo as it was', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('A turn that fits');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        const before = t.framework.getUndoRedoState('prime');
        assert.equal(before.redoDepth, 1, 'the undone turn can be redone');
        backlog.fit = false;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.deepEqual(t.framework.getUndoRedoState('prime'), { ...before, canRedo: false, redoDepth: 0 },
          'the held start invalidated redo and left undo as it was');
      } finally {
        await t.close();
      }
    });
  });

  it('ends a held turn whose stop comes as its hold is reported', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      let stopped: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:held' && stopped === undefined) stopped = t.framework.abortInference('prime');
      });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 5_000));
        assert.equal(stopped, true, 'the stop is reported taken');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
        assert.equal(t.of('inference:aborted').length, 1);
        assert.equal(t.internal.budgetHolds.size, 0);
        assert.equal(t.framework.getHostModeStatus().drained, true);
        assert.deepEqual(t.of('ops:alert').filter((e) => e.kind === 'context-refusal'), [], 'no alert says the ended turn is held');
      } finally {
        await t.close();
      }
    });
  });

  it('ends a released turn whose stop comes as its hold\'s end is reported, and runs it no more', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, responses: 2 });
      let stopped: boolean | undefined;
      t.framework.onTrace((e) => {
        if (e.type === 'inference:hold_ended' && stopped === undefined) stopped = t.framework.abortInference('prime');
      });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1, 5_000));
        assert.equal(stopped, true, 'the stop is reported taken');
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
        assert.equal(t.internal.budgetHolds.size, 0);
        t.send('Still there?');
        assert.ok(await pollUntil(() => t.of('inference:completed').length === 1, 5_000), 'a later message gets its turn');
        assert.equal(t.membrane.calls.length, 1, 'and the stopped turn never ran');
        assert.equal(t.of('inference:aborted').length, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('leaves no record of a released turn whose compile a stop or a disposal reaches', async () => {
    for (const end of ['stop', 'disposal'] as const) {
      let open!: () => void;
      const until = new Promise<void>((resolve) => { open = resolve; });
      await withBacklog({ compileGate: { nth: 2, until } }, async (backlog) => {
        const t = await residentTurn({ maintenanceIntervalMs: 50 });
        let closed = false;
        try {
          t.send('Are you there?');
          assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
          backlog.fit = true;
          assert.ok(await pollUntil(() => backlog.compiles === 2, 3_000), 'the hold released the turn into its compile');
          if (end === 'stop') {
            const stopping = t.close();
            open();
            await stopping;
            closed = true;
          } else {
            t.internal.disposeConversationAgent('prime');
            open();
            assert.ok(await pollUntil(() => t.of('inference:aborted').length === 1, 3_000), 'the compile ended with the agent gone');
          }
          assert.equal(t.internal.budgetHolds.size, 0, `nothing of the hold is left after the ${end}`);
        } finally {
          open();
          if (!closed) await t.close();
        }
      });
    }
  });

  it('refuses a puppeted tool call while a turn is held, naming the hold', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await assert.rejects(t.framework.puppetToolCall('prime', 'inbox--anything', {}),
          /puppet refused: agent prime is idle\+turn-alive \(a budget hold keeps its turn to start again once its context fits/);
        assert.equal(heldRequests(t.framework), 1, 'the turn is still held');
      } finally {
        await t.close();
      }
    });
  });
});

describe('the release check takes context-manager\'s verdict on the real strategy (#304)', () => {
  async function realResident(adaptiveResolution: boolean, withStrategy?: (strategy: AutobiographicalStrategy) => void) {
    const proto = ContextManager.prototype as unknown as {
      tick: () => Promise<void>; previewContext: (...args: unknown[]) => unknown; compile: (...args: unknown[]) => unknown;
    };
    const tick = proto.tick;
    proto.tick = async () => {};
    const previewContext = proto.previewContext;
    const previewBudgets: unknown[] = [];
    proto.previewContext = function (this: unknown, ...args: unknown[]) {
      previewBudgets.push(args[0]);
      return previewContext.apply(this, args);
    };
    const compile = proto.compile;
    const compileBudgets: unknown[] = [];
    proto.compile = function (this: unknown, ...args: unknown[]) {
      if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun !== true) compileBudgets.push(args[0]);
      return compile.apply(this, args);
    };
    const tempDir = mkdtempSync(join(tmpdir(), 'budget-hold-real-'));
    const membrane = new SequentialStreamMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Answered once it fit' }]));
    const strategy = new AutobiographicalStrategy({ adaptiveResolution, targetChunkTokens: 300, recentWindowTokens: 400 });
    withStrategy?.(strategy);
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', contextBudgetTokens: 400_000, maxTokens: 1_000,
        strategy,
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 50,
      errorPolicy: { maxRetries: 3, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    const cm = framework.getAgent('prime')!.getContextManager();
    for (let i = 0; i < 16; i++) {
      cm.addMessage(i % 2 === 0 ? 'User' : 'prime', [{ type: 'text', text: `m${i} ` + 'lorem ipsum dolor sit amet '.repeat(i % 3 === 0 ? 500 : 60) }]);
    }
    const budget = (maxTokens: number) => ({ maxTokens, reserveForResponse: 1_000 });
    return {
      framework,
      membrane,
      of: (type: string) => traces.filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>,
      preview: (maxTokens: number) => (cm as unknown as {
        previewContext: (b: { maxTokens: number; reserveForResponse: number }) => { fits: boolean; finalTokens: number; budgetTokens: number };
      }).previewContext(budget(maxTokens)),
      addMessage: (text: string) => cm.addMessage('User', [{ type: 'text', text }]),
      dryCompileResolves: (maxTokens: number) => cm.compile(budget(maxTokens), undefined, { dryRun: true } as never).then(() => true, () => false),
      setBudget: (tokens: number) => framework.updateAgentRuntimeSettings('prime', { contextBudgetTokens: tokens, immediate: true }, { allowInfeasible: true }),
      wake: () => (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'prime', reason: 'external-message', source: 'test', timestamp: Date.now(),
      }),
      previews: () => previewBudgets.length,
      previewBudgets,
      compileBudgets,
      close: async () => {
        await framework.stop();
        proto.tick = tick;
        proto.previewContext = previewContext;
        proto.compile = compile;
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }

  it('holds a released turn again where the note its start stores tips its compile over, and runs it once there is room', async () => {
    const t = await realResident(true);
    try {
      let lo = 2_000;
      let hi = 400_000;
      assert.equal(t.preview(lo).fits, false);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (t.preview(mid).fits) hi = mid; else lo = mid;
      }
      const atHi = t.preview(hi);
      const spare = atHi.budgetTokens - atHi.finalTokens;
      assert.ok(spare >= 0 && spare < 10,
        `${spare} tokens to spare at ${hi} (a plan of ${atHi.finalTokens} against ${atHi.budgetTokens}), well under the note's size`);
      t.setBudget(lo);
      t.framework.start();
      const before = t.previews();
      t.wake();
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000), 'the turn\'s compile is refused below the plan');
      assert.ok(await pollUntil(() => t.previews() > before, 3_000), 'and the release check has looked');
      assert.deepEqual(t.previewBudgets.at(-1), t.compileBudgets.at(-1), 'at the budget the refused compile planned at');
      t.setBudget(hi);
      assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000),
        'that budget releases it, and its compile, with the note stored, is refused at the margin');
      assert.equal(t.membrane.calls.length, 0);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(t.of('inference:held').length, 2, 'the stored note brings no release of its own');
      t.setBudget(hi + 1_000);
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000), 'a budget with room for the note runs the turn');
      assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit', 'fit']);
      assert.equal(JSON.stringify(t.membrane.calls[0]).split('[budget-hold]').length - 1, 2,
        'its compile reads the note each release stored');
    } finally {
      await t.close();
    }
  });

  it('holds a context refusal once on the preview path, and runs the turn once the refusal clears', async () => {
    // A coverage defect in the strategy's emission, one emitted entry left out
    // while `drop` is set, makes its coverage check refuse every select with
    // UncoveredDropError: the committing compile's and the preview's alike.
    // Context-manager's preview rethrows that refusal rather than answering
    // fits: false.
    let drop = true;
    const t = await realResident(true, (strategy) => {
      const s = strategy as unknown as { mergeAdjacentBodyGroupRaw: (...args: unknown[]) => unknown[] };
      const merge = s.mergeAdjacentBodyGroupRaw.bind(strategy);
      s.mergeAdjacentBodyGroupRaw = (...args: unknown[]) => {
        const out = merge(...args);
        if (drop && out.length > 2) out.splice(1, 1);
        return out;
      };
    });
    try {
      assert.throws(() => t.preview(400_000), (e: unknown) => (e as { name?: string }).name === 'UncoveredDropError',
        'the preview rethrows the context refusal');
      t.framework.start();
      t.wake();
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
      assert.equal(t.of('inference:held')[0]!.errorType, 'context_refusal');
      for (let i = 0; i < 4; i++) {
        const looked = t.previews();
        t.addMessage(`later ${i}`);
        assert.ok(await pollUntil(() => t.previews() > looked, 3_000), `a look after message ${i + 1}`);
      }
      assert.equal(t.of('inference:held').length, 1, 'held once while the refusal stands, through those looks');
      assert.deepEqual(t.of('inference:hold_ended'), []);
      assert.equal(t.of('ops:alert').filter((e) => e.kind === 'context-refusal').length, 1);
      assert.equal(t.membrane.calls.length, 0);
      drop = false;
      t.addMessage('after the defect');
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000), 'the turn runs once the refusal clears');
      assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
    } finally {
      await t.close();
    }
  });

  it('falls back to a dry compile where the preview needs adaptive resolution', async () => {
    const t = await realResident(false);
    try {
      // The hierarchical strategy refuses an over-budget context in its
      // preview and in a dry compile alike. A context that fits has no fold
      // plan to preview, and the dry compile decides.
      let fitsFrom = 10_000;
      while (!(await t.dryCompileResolves(fitsFrom)) && fitsFrom < 400_000) fitsFrom += 1_000;
      assert.ok(fitsFrom < 400_000);
      assert.equal(await t.dryCompileResolves(Math.round(fitsFrom * 0.8)), false,
        'its dry compile refuses where the context does not fit, as a committing compile does');
      assert.throws(() => t.preview(fitsFrom), /requires adaptiveResolution/);
      t.setBudget(Math.round(fitsFrom * 0.8));
      t.framework.start();
      const before = t.previews();
      t.wake();
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
      assert.ok(await pollUntil(() => t.previews() > before, 3_000), 'the release check has looked');
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(t.of('inference:hold_ended'), [], 'it stays held while the context does not fit');
      t.setBudget(fitsFrom + 2_000);
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
      assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit'], 'the dry compile said it fits');
    } finally {
      await t.close();
    }
  });
});
