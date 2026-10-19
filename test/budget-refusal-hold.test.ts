/**
 * A compile refused for budget holds its turn (#304). An immediate budget
 * decrease, or a turn that grew the context past the budget, makes the next
 * compile refuse with context-manager's OverBudgetError before any provider
 * call. Before the hold, the error policy retried it into the same refusal
 * within seconds and the turn ended; compression then freed the space, but
 * nothing ran the turn again, so the resident stayed silent until its next
 * wake. Now the turn waits while compression runs, and runs once
 * context-manager's preview says the context fits: later wakes join it, and a
 * deadline, or compression with nothing pending, ends it as a refused compile
 * ended before. The last describe runs the release check against the real
 * autobiographical strategy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { EventResponse, InferencePolicy, Module, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/** One queued response per stream, so each turn gets its own. */
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

/** Every console.error line written while `run` runs, still written through. */
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

/**
 * The context manager's compression backlog: the context fits once `fitAt`
 * ticks have run (or `fit` is set), and pending work is reported until then,
 * or until `readyAt` ticks, whichever is sooner, as a strategy reports a
 * backlog (`alwaysPending` keeps it reported). The maintenance loop and the
 * drain kick tick it. The strategy's progress snapshot moves with each tick,
 * unless `stalled`, and when the context comes to fit, as a real one's does
 * when the compression that makes it fit lands.
 * - The release check's verdict is the context manager's preview, whose
 *   contract is to say whether the context fits: here it says `fits`, and
 *   throws `previewError` once when one is set.
 * - `previewless` is a strategy with no preview: the check falls back to a
 *   dry compile, which refuses as the committing one would (as a
 *   hierarchical strategy's does), decided at its start as a select decides,
 *   after `dryRunGate` and `dryRunMs` when they are set.
 * - A committing compile is refused while the context doesn't fit, and
 *   `refuseCompiles` more times whatever it does, as one is when content
 *   reaches it after the check; `slowCompile` makes the nth wait first.
 * The last describe runs the real strategy instead.
 */
interface Backlog {
  ticks: number; fitAt: number; readyAt: number; fit: boolean;
  alwaysPending: boolean; stalled: boolean; previewless: boolean; refuseCompiles: number;
  previews: number; dryRuns: number; dryRunsRunning: number; mostDryRunsRunning: number; compiles: number;
  /** Dry compiles that began before the context fit and ended after. */
  dryRunsAcrossFit: number;
  /** The strategy reports no progress snapshot at all. */
  noProgress: boolean;
  /** When set, the progress snapshot reports this instead of the ticks. */
  progress?: number;
  /** The refusal's error name: OverBudgetError unless set. */
  refusalName?: string;
  previewError?: Error; dryRunGate?: Promise<void>; dryRunMs?: number; slowCompile?: { nth: number; ms: number };
  /** The nth compile waits until this settles. */
  compileGate?: { nth: number; until: Promise<void> };
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
    dryRunsAcrossFit: 0, noProgress: false,
    ...backlog,
  };
  refusalName = b.refusalName ?? 'OverBudgetError';
  const proto = ContextManager.prototype as unknown as Patchable;
  const original = { compile: proto.compile, tick: proto.tick, isReady: proto.isReady, previewContext: proto.previewContext };
  const passthrough = PassthroughStrategy.prototype as unknown as { getProgressSnapshot?: () => unknown };
  proto.compile = async function (this: unknown, ...args: unknown[]) {
    if ((args[2] as { dryRun?: boolean } | undefined)?.dryRun === true) {
      b.dryRuns++;
      b.mostDryRunsRunning = Math.max(b.mostDryRunsRunning, ++b.dryRunsRunning);
      try {
        const fitsNow = fits(b);
        if (b.dryRunGate) await b.dryRunGate;
        if (b.dryRunMs) await new Promise((r) => setTimeout(r, b.dryRunMs));
        if (!fitsNow && fits(b)) b.dryRunsAcrossFit++;
        if (!fitsNow) throw overBudget();
      } finally {
        b.dryRunsRunning--;
      }
      return original.compile.apply(this, args);
    }
    b.compiles++;
    if (b.slowCompile?.nth === b.compiles) await new Promise((r) => setTimeout(r, b.slowCompile!.ms));
    if (b.compileGate?.nth === b.compiles) await b.compileGate.until;
    if (!fits(b)) throw overBudget();
    if (b.refuseCompiles > 0) {
      b.refuseCompiles--;
      throw overBudget(49_000);
    }
    return original.compile.apply(this, args);
  };
  proto.previewContext = function () {
    b.previews++;
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

/** Stores each external message for the agent and asks for a turn, as a
 *  channel module does. */
class InboxModule implements Module {
  readonly name = 'inbox';
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

/** A tool whose result is large, and a first round whose usage reports a
 *  prompt near a 200k window, so the round's continuation restarts the stream
 *  through a fresh compile (physicalWindowTokens, #92). */
class BlobToolModule implements Module {
  readonly name = 'canned';
  /** Runs while the tool runs, with the turn alive; the tool waits for what
   *  it returns. */
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

/**
 * A turn whose continuation is held: its first compile fits, its tool round's
 * usage near a 200k window restarts it through a fresh compile
 * (nearCapToolResponse), and that compile is refused for budget, as is every
 * dry compile the release check falls back to (the strategy has no preview),
 * until `fit()`. Compression is pending until then. Each response text is
 * answered by one provider call after the first round's.
 */
async function heldRestart(texts: string[], options: {
  /** The restart's compile fits from the start, so nothing is held. */
  fits?: boolean;
  /** Runs while the tool runs, the first round's or a puppeted call's; the
   *  tool waits for what it returns. */
  duringTool?: (internal: Internal) => unknown;
  inferencePolicy?: InferencePolicy;
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
  const membrane = new SequentialStreamMembrane();
  membrane.pushResponse(nearCapToolResponse());
  for (const text of texts) membrane.pushResponse(createMockResponse([{ type: 'text', text }]));
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000 }],
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

/** The framework's internals these tests read or shorten. */
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
  /** A store the test keeps, to open again after a stop; one of its own when left out. */
  storePath?: string;
}) {
  const tempDir = options.storePath === undefined ? mkdtempSync(join(tmpdir(), 'budget-hold-')) : undefined;
  const membrane = new SequentialStreamMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Answered once it fit' }]));
  for (let i = 1; i < (options.responses ?? 1); i++) {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `Answered turn ${i + 1}` }]));
  }
  const framework = await AgentFramework.create({
    storePath: options.storePath ?? join(tempDir!, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
    modules: [new InboxModule()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: options.maintenanceIntervalMs,
    ...(options.inferencePolicy ? { inferencePolicy: options.inferencePolicy } : {}),
    // The default policy's three retries, without its 1, 2 and 4 second waits.
    errorPolicy: { maxRetries: 3, onInferenceError: (_error, _agent, attempt) => (attempt < 3 ? { retry: true, delayMs: 0 } : { retry: false }) },
  });
  const internal = framework as unknown as Internal;
  if (options.holdMs !== undefined) internal.budgetHoldMs = options.holdMs;
  if (options.recheckMs !== undefined) internal.budgetHoldRecheckMs = options.recheckMs;
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  // Every look the hold is asked for (checkBudgetHold), whatever it decides:
  // a window that asserts no verdict asserts first that the hold was asked.
  // Counted only where there is a hold, so the file runs against main too.
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
  /** The traces of these types, in the order they came. */
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
    // 40 ticks: the pass at start and the hold's first kick give 16, so the
    // maintenance loop must tick the held agent for the context to fit.
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

  it('tells the agent why its turn waited, in that turn\'s compile alone', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, responses: 2 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
        const first = JSON.stringify(t.membrane.calls[0]);
        assert.match(first, /\[budget-hold\] Your context didn't fit its budget \(100,201 tokens against 48,568\), so this turn waited \d+ s\. It fits now\./);
        // An injection, never stored: no later turn sees it, and no stored
        // message could move a turn's routing (#333's arrival rule).
        assert.ok(!storedText(t.framework).includes('[budget-hold]'), 'the note is not stored');
        t.send('And now?');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered turn 2'), 5_000));
        assert.equal(t.membrane.calls.length, 2);
        assert.ok(!JSON.stringify(t.membrane.calls[1]).includes('[budget-hold]'), 'the next turn carries no note');
      } finally {
        await t.close();
      }
    });
  });

  it('puts the note into the released turn\'s first compile only: a restart inside the turn compiles without it', async () => {
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
        assert.ok(JSON.stringify(membrane.calls[0]).includes('[budget-hold]'), 'the first compile after the release carries the note');
        assert.ok(!JSON.stringify(membrane.calls[1]).includes('[budget-hold]'), 'the restart\'s compile does not');
      } finally {
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('keeps the note out of the store and out of the turn\'s routing', async () => {
    await withBacklog({ fitAt: 12 }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      // The routing the released turn starts with, and the routing it has
      // once its compile, the one carrying the note, has been sent.
      type Routing = { triggerChannel?: string; locus?: string; engaged: Set<string>; pin?: string; destination: string | null; arrivals: unknown[] };
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
        // A message on a channel, so the turn has a trigger channel to keep.
        await (t.framework as unknown as { handleMcplChannelIncoming: (e: unknown) => Promise<unknown> }).handleMcplChannelIncoming({
          type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:guild:chanA', messageId: 'm-1',
          author: { id: 'U1', name: 'owner' }, content: [{ type: 'text', text: 'Are you there?' }],
          timestamp: new Date().toISOString(), metadata: {}, triggerInference: true,
        });
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 10_000));
        assert.equal(t.of('inference:held').length, 1);
        assert.ok(JSON.stringify(t.membrane.calls[0]).includes('[budget-hold]'), 'the released compile carried the note');
        // Every message in the store, every metadata field included.
        const everything = JSON.stringify(t.framework.getAgent('prime')!.getContextManager().queryMessages({}).messages);
        assert.ok(!everything.includes('budget-hold'), 'nothing of the note is stored');
        // The released start (the last one) and the routing after its compile.
        assert.equal(afterCompile.length, 1);
        const released = atStart[atStart.length - 1] as { triggerChannel?: string };
        assert.equal(released.triggerChannel, 'discord:guild:chanA', 'the released turn starts from the message\'s channel');
        assert.deepEqual(afterCompile[0], released, 'and the compile with the note leaves its routing as it was');
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
    // The maintenance pass at start runs 8 ticks before the turn: the
    // backlog is still pending at the refusal, and done 12 ticks later.
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
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 400 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        assert.match(String(t.of('inference:exhausted')[0]!.error), /the turn was first held \d+ s ago; the hold's 1 s bound passed and it still didn't fit/);
        assert.equal(t.membrane.calls.length, 0);
      } finally {
        await t.close();
      }
    });
  });

  it('holds a later turn afresh after a hold that ended in failure, and after one that ran', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50, holdMs: 400 });
      try {
        // A turn whose hold passes its bound fails ...
        t.send('First');
        assert.ok(await pollUntil(() => t.of('inference:exhausted').length === 1, 5_000));
        // ... and the next turn's refusal holds again, with its own deadline.
        t.send('Second');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 2, 5_000), 'a failed turn\'s spent hold does not pass to the next turn');
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        // After a held turn that ran, a later refusal starts a new hold, not
        // the released turn's.
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
        // The context now fits, but the check's preview fails for another
        // reason: the hold doesn't call that a fit, and lets the turn's
        // compile find out.
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
    // No maintenance timer, and an interval longer than the test: only the
    // hold's first kick can compress.
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
        // The first kick at once, then one an interval of 100 ms: never more
        // kicks, or checks, than the intervals that have passed allow.
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

  it('leaves the held agent idle: its status shows the hold, and a surgery is admitted and looks again', async () => {
    await withBacklog({}, async (backlog) => {
      // One maintenance pass at start, then none for an hour: only the
      // surgery can bring the release check.
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000), 'no turn token is kept for the held turn');
        const agents = (t.framework.healthSnapshot() as { agents: Array<{ name: string; budgetHold: Record<string, unknown> | null }> }).agents;
        const hold = agents.find((a) => a.name === 'prime')!.budgetHold;
        assert.ok(hold, 'the status names the hold');
        assert.equal(hold!.errorType, 'over_budget');
        assert.equal(hold!.heldRequests, 1);
        // The hold's first kick looks once when it ends. Only after that look
        // does the context fit, so the look that releases the turn is the
        // surgery's.
        assert.ok(await pollUntil(() => backlog.previews >= 1, 3_000), 'the hold has looked once, after its first kick');
        await new Promise((r) => setTimeout(r, 100));
        const previews = backlog.previews;
        backlog.fit = true;
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(backlog.previews, previews, 'nothing looks again before the surgery');
        await t.framework.switchBranch('main');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the surgery brought the release check forward');
        assert.equal(heldRequests(t.framework), undefined);
      } finally {
        await t.close();
      }
    });
  });

  it('stops the hold\'s drain kick when a surgery takes the store mid-tick, and the surgery waits for it', async () => {
    await withBacklog({}, async (backlog) => {
      // One maintenance pass at start, then none for an hour.
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      const fw = t.framework as unknown as {
        maintenancePass: unknown;
        overBudgetDrainAfter: Map<string, unknown[]>;
        kickOverBudgetDrain: (name: string, agent: unknown, after?: () => void) => void;
      };
      const proto = ContextManager.prototype as unknown as Patchable;
      // Let go in the finally too, so a failed assertion fails the test
      // rather than leaving the tick, and the stop that waits for it, hanging.
      let letGo = () => {};
      try {
        assert.ok(await pollUntil(() => fw.maintenancePass === null, 3_000), 'the start pass is done');
        // From here a tick waits to be let go, as a compression call does.
        const gate = new Promise<void>((resolve) => { letGo = resolve; });
        proto.tick = async function () { backlog.ticks++; await gate; };
        const before = backlog.ticks;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.ticks === before + 1, 5_000),
          'the hold\'s kick is in its first tick');
        assert.equal(fw.overBudgetDrainAfter.get('prime')?.length, 1, 'with the hold\'s check waiting on it');
        let switched = false;
        const surgery = t.framework.switchBranch('main').then(() => { switched = true; });
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(switched, false, 'the surgery waits for the tick in flight');
        // A kick asked for while the surgery holds the store starts nothing
        // and leaves no callback behind.
        fw.kickOverBudgetDrain('prime', t.framework.getAgent('prime'), () => {});
        assert.equal(fw.overBudgetDrainAfter.get('prime')?.length, 1);
        letGo();
        await surgery;
        assert.equal(backlog.ticks, before + 1, 'the kick stopped once the surgery held the store: no tick after it');
        assert.equal(fw.overBudgetDrainAfter.has('prime'), false, 'the kick ran its callback when it ended');
        assert.ok(t.internal.budgetHolds.size === 1, 'the turn is still held');
      } finally {
        letGo();
        await t.close();
      }
    });
  });

  it('stops the hold\'s drain kick once stop() begins, and starts no kick after it', async () => {
    await withBacklog({}, async (backlog) => {
      await errorLines(async (lines) => {
        // One maintenance pass at start, then none for an hour.
        const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
        const fw = t.framework as unknown as {
          maintenancePass: unknown;
          overBudgetDrainAfter: Map<string, unknown[]>;
          kickOverBudgetDrain: (name: string, agent: unknown, after?: () => void, by?: 'breaker' | 'hold') => string;
        };
        const proto = ContextManager.prototype as unknown as Patchable;
        // Let go in the finally too, so a failed assertion fails the test
        // rather than leaving the tick, and the stop that waits for it, hanging.
        let letGo = () => {};
        let stopping: Promise<void> | undefined;
        try {
          assert.ok(await pollUntil(() => fw.maintenancePass === null, 3_000), 'the start pass is done');
          // From here a tick waits to be let go, as a compression call does.
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
          // A kick asked for once stop() has begun starts nothing and keeps
          // no callback.
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
      // One maintenance pass at start, then none for an hour.
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

  it('falls back to a dry compile for a strategy with no preview, one at a time, and lands a fit', async () => {
    // Beth-2389's probe: dry compiles of 300 ms, a pass every 50 ms, each
    // asking. Compression finishes, and makes the context fit, while one runs.
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

  it('on the fallback path, looks again at the next pass after a surgery a dry compile straddled', async () => {
    // Compression makes no progress, so only a surgery changes what the
    // check compares.
    await withBacklog({ previewless: true, stalled: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.dryRuns >= 1 && backlog.dryRunsRunning === 0, 5_000));
        // A surgery brings a check, whose dry compile decides it doesn't fit
        // and is held there.
        let release!: () => void;
        backlog.dryRunGate = new Promise<void>((resolve) => { release = resolve; });
        const dryRuns = backlog.dryRuns;
        await t.framework.switchBranch('main');
        assert.ok(await pollUntil(() => backlog.dryRuns === dryRuns + 1, 2_000));
        // The context now fits, and a second surgery asks while that dry
        // compile runs.
        backlog.fit = true;
        await t.framework.switchBranch('main');
        backlog.dryRunGate = undefined;
        release();
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000),
          'the stale refusal stood only until the next pass, which the second surgery had given something new to look at');
        assert.equal(backlog.mostDryRunsRunning, 1);
      } finally {
        await t.close();
      }
    });
  });

  it('on the fallback path, sets aside a refusal that compression coming back made stale', async () => {
    // A strategy with no progress snapshot: whether compression is pending is
    // all the hold knows of it.
    await withBacklog({ previewless: true, noProgress: true, alwaysPending: true, readyAt: 0 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.dryRuns >= 1 && backlog.dryRunsRunning === 0, 5_000));
        // Compression goes idle, so the next look's dry compile begins with
        // nothing pending, and while it runs, compression has work again.
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
    // Progress frozen: only whether compression is pending changes, which
    // the signature sees beside the frozen progress.
    await withBacklog({ previewless: true, stalled: true, alwaysPending: true, readyAt: 0 }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.dryRuns >= 1 && backlog.dryRunsRunning === 0, 5_000));
        // Compression goes idle, and a message brings a look whose dry
        // compile begins with nothing pending. While it runs, compression has
        // work again.
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
      // No passes after the first, so nothing looks between the hold's first
      // check and its deadline.
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, holdMs: 400 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => backlog.previews >= 1, 2_000));
        backlog.fit = true;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        assert.match(JSON.stringify(t.membrane.calls[0]), /\[budget-hold\][^"]*so this turn waited \d+ s\. It fits now/);
        assert.deepEqual(t.of('inference:exhausted'), []);
      } finally {
        await t.close();
      }
    });
  });

  it('looks again after an undo', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      // One maintenance pass at start, then none for an hour: only the undo
      // can bring the release check.
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, responses: 2 });
      try {
        t.send('A turn that fits');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        backlog.fit = false;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000));
        backlog.fit = true;
        const undone = t.framework.undoLastTurn('prime');
        assert.equal(undone.undone, true, 'the earlier turn left a checkpoint to undo');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered turn 2'), 3_000),
          'the undo brought the release check forward');
        // The undo took the earlier turn, and with it the held turn's input,
        // stored after that turn's checkpoint. The held turn then runs on what
        // the undo left, as any queued wake does after an undo.
        const released = JSON.stringify(t.membrane.calls[1]);
        assert.ok(released.includes('A turn that fits'), 'the undone turn\'s input is still there');
        assert.ok(!released.includes('Are you there?'), 'and the held turn\'s own input is not');
      } finally {
        await t.close();
      }
    });
  });

  it('looks again after a redo', async () => {
    await withBacklog({ fit: true }, async (backlog) => {
      // No passes after the first: only the undo and the redo bring checks.
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, responses: 2 });
      try {
        t.send('A turn that fits');
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000));
        backlog.fit = false;
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1 && backlog.previews >= 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000));
        // An undo while the turn is held, whose own check finds no fit yet ...
        assert.equal(t.framework.undoLastTurn('prime').undone, true);
        assert.ok(await pollUntil(() => backlog.previews >= 2, 2_000));
        // ... and a redo once it would fit.
        backlog.fit = true;
        assert.equal(t.framework.redo('prime').redone, true);
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered turn 2'), 3_000),
          'the redo brought the release check forward');
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

  it('gives up the undo step of a start that reaches its compile while the hold waits', async () => {
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('First message');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000));
        // As a start parked for the primary provider's admission does when it
        // resumes: it reaches its compile without the scheduler's look at the
        // hold, and its refusal joins the waiting hold.
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
    // The check says it fits at once, but the turn's compile refuses three
    // times, as it can when content reaches it after the check (the turn
    // start's flush of deferred messages, a coalesced batch's assembly).
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

  it('does not release a turn its compile refused again until compression moves or a surgery runs', async () => {
    // The check says it fits, the turn's compile is refused every time, and
    // compression makes no progress.
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
        await t.framework.switchBranch('main');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 3, 3_000),
          'a surgery is new evidence: the hold looks, releases, and holds again');
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
        // A budget for the agent changes what its next compile plans at. (The
        // change previews once itself, as its preflight.)
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
        // Compression finishes, which the hold sees, so it looks once more.
        backlog.alwaysPending = false;
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 2, 3_000), 'it looks again once nothing is pending');
      } finally {
        await t.close();
      }
    });
  });

  it('looks again when compression moved while a released turn compiled, though that compile was refused', async () => {
    // Compression's progress is frozen but for one step, which lands while
    // the released turn's (slow) compile runs, and that compile is refused.
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
        // Both in one synchronous step, so no pass comes between them.
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
        // By the time that compile is refused, compression has nothing pending.
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
      // stop() closes admission while that compile runs, and it is then refused.
      await t.close();
      assert.ok(await pollUntil(() => t.of('inference:failed').length === 1, 3_000), 'the compile was refused');
      assert.deepEqual(t.of('inference:held'), [], 'and no hold began, since stop had closed admission');
    });
  });

  it('holds a context refusal as it holds an over-budget one', async () => {
    // 40 ticks, past the pass at start and the hold's first kick: the release
    // check looks while the context still doesn't fit.
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
    // The check says it fits, but the released turn's compile starts only
    // after the deadline (a slow queue), and refuses.
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
    // The deadline spends the hold, and the released turn's compile is slow,
    // so its refusal comes after the spend.
    await withBacklog({ slowCompile: { nth: 2, ms: 500 } }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, holdMs: 200 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000));
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['deadline']);
        // As though the turn was first held ten minutes before that refusal.
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
    // The note: a turn held seven minutes, by its record, then released.
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        times(t).startedAt = Date.now() - 7 * 60_000;
        backlog.fit = true;
        assert.ok(await pollUntil(() => t.membrane.calls.length === 1, 5_000));
        assert.ok(JSON.stringify(t.membrane.calls[0]).includes(
          "[budget-hold] Your context didn't fit its budget (100,201 tokens against 48,568), so this turn waited 7 min. It fits now."));
      } finally {
        await t.close();
      }
    });
    // The failure: the default 30-minute bound, a turn first held 30 minutes
    // ago by its record, and its released compile refused past the bound.
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

  it('ends a released turn that a stop reaches before it sends anything: nothing of its hold reaches a later turn', async () => {
    let open!: () => void;
    const until = new Promise<void>((resolve) => { open = resolve; });
    await withBacklog({ compileGate: { nth: 2, until } }, async (backlog) => {
      // The released compile makes a stream (the mock counts it among its
      // calls) that the stop keeps from being read; the later turn's is the
      // second.
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
        assert.ok(!JSON.stringify(later).includes('[budget-hold]'), 'the later turn carries no note of the stopped one\'s wait');
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
    // The fork is spawned while the context fits, since a spawn dry-compiles
    // its template, and the backlog then starts for the fork's own turn.
    await withBacklog({ fit: true }, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      const fw = t.framework as unknown as {
        conversationRouter: unknown;
        createConversationAgent: (name: string, channelId: string) => Promise<unknown>;
      };
      const fork = 'prime--chanA';
      try {
        // A conversation router whose template is prime, and a fork of it
        // for one channel, as a first message in that channel spawns.
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
        // The same store, opened by a new framework, as a process restart does.
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

  it('runs no check while a surgery holds the store, and looks again at its release', async () => {
    // The maintenance timer off and the provider gate closed: the hold's own
    // interval is what looks, and a surgery stops nothing else from looking.
    await withBacklog({}, async (backlog) => {
      const t = await residentTurn({ maintenanceIntervalMs: 0, recheckMs: 50 });
      const open = t.internal.providerGateBlocked.bind(t.framework);
      let blocked = true;
      t.internal.providerGateBlocked = (name: string) => (name === 'prime' && blocked) || open(name);
      const fw = t.framework as unknown as { reserveStoreForSurgery: (verb: string, agentName: string) => () => void };
      // Released in finally too: stop() waits for a surgery's release, so a
      // failed assertion would otherwise hang the file rather than fail.
      let release = () => {};
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        release = fw.reserveStoreForSurgery('test surgery', 'prime');
        const previews = backlog.previews;
        const asked = t.looks();
        backlog.fit = true;
        await new Promise((r) => setTimeout(r, 400));
        assert.ok(t.looks() > asked, 'the hold\'s interval asked it to look');
        assert.deepEqual(t.of('inference:hold_ended'), [], 'no check, through eight intervals, while the surgery holds the store');
        assert.equal(backlog.previews, previews);
        release();
        assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000), 'the release looked again, and the turn fits');
        blocked = false;
        assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 3_000));
      } finally {
        release();
        await t.close();
      }
    });
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
        // Bounded, so a run that holds fails here rather than hanging the file.
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
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      try {
        // A batch-only wake reaches its compile, which is refused.
        t.internal.pendingRequests.push({
          agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
          coalescingSubject: 'zz-subject', coalescingBatch: true, coalescingBatchSubjects: ['zz-subject'],
        } as unknown as { agentName: string });
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        const held = holdOf(t)!.heldRequests;
        assert.equal(held.length, 1);
        assert.equal(held[0]!.coalescingBatch, undefined, 'no longer batch-only, so the released start keeps its turn');
        assert.equal(held[0]!.coalescingBatchSubjects, undefined);
        // Its content was stored before its compile: a cancellation of its
        // subject takes neither the turn nor its only cause.
        (t.framework as unknown as { cancelCoalescedWakes: (subject: string) => void }).cancelCoalescedWakes('zz-subject');
        assert.equal(holdOf(t)!.heldRequests.length, 1, 'the turn keeps its own cause');
        backlog.fit = true;
        await t.framework.switchBranch('main');
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
        // As a fork closing with its closure turn held: no stream, no pending request.
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
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000 });
      const fw = t.framework as unknown as { recordTurnCheckpoint: (name: string) => void };
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.ok(await pollUntil(() => !t.internal.activeTurnTokens.has('prime'), 3_000));
        // The released start's checkpoint write fails, as a full disk would.
        const original = fw.recordTurnCheckpoint;
        let failed = 0;
        fw.recordTurnCheckpoint = function (this: unknown, name: string) {
          if (failed++ === 0) throw new Error('ENOSPC: no space left on device');
          return original.call(this, name);
        };
        backlog.fit = true;
        await t.framework.switchBranch('main');
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
    // The turn's first compile fits, and its restart's fresh compile is
    // refused once: the hold takes a context_budget_restart.
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
      // Sampled while the resumed stream runs (by inference:completed the
      // gate has closed the turn again).
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
      // And closed once the turn ends: the reopening leaves no turn open at
      // the gate, where it would buffer every agent's events.
      assert.ok(await pollUntil(() => !gate.inferenceDiagnostics().inferring.includes('prime'), 2_000), 'the gate closes when the turn ends');
    } finally {
      await framework.stop();
      Object.assign(proto, original);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drops the hold, its requests and what it left for the name, at stop and at disposal', async () => {
    await withBacklog({}, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 50 });
      let closed = false;
      try {
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        await t.close();
        closed = true;
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
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
        assert.equal(t.internal.budgetHolds.size, 0, 'a later agent of the name starts with none of it');
        // Past the hold's deadline: nothing is queued for an agent that's gone.
        await new Promise((r) => setTimeout(r, 450));
        assert.deepEqual(t.internal.pendingRequests.filter((r) => r.agentName === 'prime'), []);
        assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['stopped']);
      } finally {
        await t.close();
      }
    });
  });
  it('keeps a held continuation from running while the host is quiesced: it runs at resume', async () => {
    const t = await heldRestart(['Answered after the restart']);
    try {
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 10_000), 'the restart is held');
      const { status, said } = await errorLines(async (lines) => ({
        status: await t.framework.quiesce({ reason: 'test', timeoutMs: 1_000 }),
        said: lines.filter((l) => l.startsWith('[host-mode] quiesced')),
      }));
      assert.equal(status.drained, true, 'the held turn holds no turn token');
      // Asserted below, once the provider calls are.
      const heldAtQuiesce = status.heldTurns;
      const saidAtQuiesce = said;
      assert.equal(t.membrane.calls.length, 1);
      t.fit();
      assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000), 'the context fits, and the hold ends');
      assert.equal(t.framework.getHostModeStatus().heldTurns, 0, 'no turn is held once the hold ends');
      // The released continuation reaches the scheduler, which either starts
      // it or parks it as it parks a wake.
      await pollUntil(() => t.membrane.calls.length > 1 || t.framework.getHostModeStatus().gatedRequests === 1, 3_000);
      assert.equal(t.membrane.calls.length, 1, 'no provider call after quiesce reported the host drained');
      assert.equal(t.framework.getHostModeStatus().gatedRequests, 1, 'the continuation is parked, as a wake is');
      assert.equal(heldAtQuiesce, 1, 'the status quiesce returned showed the held turn');
      assert.deepEqual(saidAtQuiesce, ['[host-mode] quiesced — drained, 0 wake(s) parked, 1 turn(s) held for budget'], 'and so did its line');
      // A parked request isn't work for runUntilIdle while the host is
      // quiesced, so it returns rather than waiting for resume; the bound
      // only stops a regression from hanging the test.
      let bound: ReturnType<typeof setTimeout> | undefined;
      const idle = await Promise.race([
        t.framework.runUntilIdle().then(() => true),
        new Promise<boolean>((r) => { bound = setTimeout(() => r(false), 10_000); }),
      ]);
      clearTimeout(bound);
      assert.equal(idle, true, 'runUntilIdle returns while the continuation waits for resume');
      await t.framework.resume();
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered after the restart'), 5_000), 'the continuation runs at resume');
      assert.equal(t.membrane.calls.length, 2);
    } finally {
      await t.close();
    }
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
      // The continuation skips batch assembly, so the batch's wake can't be
      // one of its causes: it starts a turn of its own once that one ends.
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered the batch'), 5_000), 'the batch\'s wake gets a fresh turn');
      assert.equal(t.membrane.calls.length, 3);
    } finally {
      await t.close();
    }
  });

  it('gives a deferred batch\'s wake that waited behind a turn which then restarted a fresh turn of its own', async () => {
    // Nothing is held: the restart's compile fits. The batch's wake arrives
    // while the turn's tool runs, so it waits, queued, until the restart is
    // queued beside it.
    const t = await heldRestart(['Answered after the restart', 'Answered the batch'], {
      fits: true,
      duringTool: (internal) => internal.pendingRequests.push({
        agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
        coalescingSubject: 'zz-subject', coalescingBatch: true, coalescingBatchSubjects: ['zz-subject'],
      } as unknown as { agentName: string }),
    });
    try {
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered after the restart'), 10_000), 'the restart runs');
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered the batch'), 5_000), 'the batch\'s wake gets a fresh turn');
      assert.equal(t.membrane.calls.length, 3);
      assert.equal(t.of('inference:held').length, 0);
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
    // A progress snapshot that doesn't move while readiness does.
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
        const full = Array.from({ length: 20 }, (_, i) => ({ agentName: 'prime', turnIndex: i, sequenceBefore: 0, branchName: 'main', timestamp: i }));
        checkpoints.saveTurnCheckpoints('prime', full);
        checkpoints.turnCounters.set('prime', 20);
        t.send('Are you there?');
        assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000));
        assert.deepEqual(checkpoints.getTurnCheckpoints('prime').map((c) => c.turnIndex), full.map((c) => c.turnIndex),
          'the twenty checkpoints from before the turn, the oldest included');
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
        // The held turn's input is stored, and a redo would move the store
        // from under it.
        assert.deepEqual(t.framework.getUndoRedoState('prime'), { ...before, canRedo: false, redoDepth: 0 },
          'the held start invalidated redo and left undo as it was');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps a released continuation that waits on provider admission from starting while the host is quiesced', async () => {
    const t = await heldRestart(['Answered after the restart']);
    const internals = t.framework as unknown as {
      withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>): Promise<T>;
      providerGates: Map<string, { primaryDepth: number }>;
      activeTurnTriggers: Map<string, { releasedByBudgetHold?: boolean } | undefined>;
    };
    // What the turn the release starts carries, sampled as it starts.
    const started: Array<boolean | undefined> = [];
    t.framework.onTrace((e) => {
      if (e.type === 'inference:started' && t.of('inference:hold_ended').length === 1) {
        started.push(internals.activeTurnTriggers.get('prime')?.releasedByBudgetHold);
      }
    });
    let releaseAux = () => {};
    try {
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 10_000), 'the restart is held');
      // An auxiliary call holds provider admission, so the released restart
      // passes the scheduler and waits behind it, with no turn token.
      const auxDone = internals.withAuxiliaryAdmission('prime', () => new Promise<void>((resolve) => { releaseAux = resolve; }));
      t.fit();
      assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1
        && (internals.providerGates.get('prime')?.primaryDepth ?? 0) === 1
        && !t.internal.activeTurnTokens.has('prime'), 5_000), 'released, and waiting on admission');
      const status = await t.framework.quiesce({ reason: 'test', timeoutMs: 1_000 });
      assert.equal(status.parkedAdmissions, 1);
      releaseAux();
      await auxDone;
      await pollUntil(() => t.membrane.calls.length > 1 || t.framework.getHostModeStatus().gatedRequests === 1, 3_000);
      assert.equal(t.membrane.calls.length, 1, 'no turn starts while the host is quiesced');
      assert.equal(t.framework.getHostModeStatus().gatedRequests, 1, 'the continuation is parked, as a wake is');
      await t.framework.resume();
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered after the restart'), 5_000), 'it runs at resume');
      assert.deepEqual(started, [undefined], 'the turn it starts carries no mark, so nothing it retries is parked');
    } finally {
      releaseAux();
      await t.close();
    }
  });

  it('keeps a released budget restart from starting while a puppeted tool call holds the agent', async () => {
    // Armed below: the puppeted call's tool waits for it.
    let gate: Promise<void> | undefined;
    let letGo = () => {};
    const t = await heldRestart(['Answered after the restart'], { duringTool: () => gate });
    const internals = t.framework as unknown as { processInferenceRequests: () => Promise<void> };
    const pass = internals.processInferenceRequests.bind(t.framework);
    let passes = 0;
    internals.processInferenceRequests = () => { passes++; return pass(); };
    let puppet: Promise<unknown> | undefined;
    try {
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 10_000), 'the restart is held');
      // The held agent is idle, so the puppeted call is admitted, and it
      // holds the agent's turn token while its tool runs (#145).
      gate = new Promise<void>((resolve) => { letGo = resolve; });
      puppet = t.framework.puppetToolCall('prime', 'canned--fetch', {});
      assert.ok(await pollUntil(() => t.internal.activeTurnTokens.has('prime'), 3_000), 'the puppeted call holds the agent');
      t.fit();
      assert.ok(await pollUntil(() => t.of('inference:hold_ended').length === 1, 3_000), 'the context fits, and the hold ends');
      // The released restart continued a turn that gave its token back, so
      // the scheduler keeps it queued behind the puppeted call, pass after pass.
      const ended = passes;
      assert.ok(await pollUntil(() => passes >= ended + 5 || t.membrane.calls.length > 1, 3_000));
      assert.equal(t.membrane.calls.length, 1, 'no turn starts while the puppeted call holds the agent');
      letGo();
      await puppet;
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered after the restart'), 5_000), 'the restart runs once the call ends');
      assert.equal(t.membrane.calls.length, 2);
    } finally {
      letGo();
      await puppet?.catch(() => {});
      await t.close();
    }
  });

  it('starts a released guard retry as its turn\'s trigger wherever it was queued, and a batch\'s wake ahead of it gets a fresh turn', async () => {
    await withBacklog({ fit: true }, async () => {
      const t = await residentTurn({ maintenanceIntervalMs: 3_600_000, responses: 2 });
      const internals = t.framework as unknown as { activeTurnTriggers: Map<string, { reason?: string } | undefined> };
      const triggers: Array<string | undefined> = [];
      t.framework.onTrace((e) => { if (e.type === 'inference:started') triggers.push(internals.activeTurnTriggers.get('prime')?.reason); });
      try {
        // As a hold releases a held guard retry while a batch's wake is
        // already queued ahead of it.
        t.internal.pendingRequests.push(
          {
            agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
            coalescingSubject: 'zz-subject', coalescingBatch: true, coalescingBatchSubjects: ['zz-subject'],
          } as unknown as { agentName: string },
          { agentName: 'prime', reason: 'tool_result_guard_retry', source: 'framework', timestamp: Date.now(), releasedByBudgetHold: true } as unknown as { agentName: string },
        );
        assert.ok(await pollUntil(() => t.membrane.calls.length === 2, 5_000), 'two turns');
        assert.deepEqual(triggers, ['tool_result_guard_retry', 'mcpl:push-event'], 'the guard retry resumes its turn, then the batch\'s wake gets its own');
      } finally {
        await t.close();
      }
    });
  });

  it('keeps a deferred batch\'s wake beside a restart the inference policy declines queued for a turn of its own', async () => {
    // The policy declines any turn a budget restart would start.
    const policy: InferencePolicy = { shouldInfer: (_agentName, requests) => !requests.some((r) => r.reason === 'context_budget_restart') };
    const t = await heldRestart(['Answered the batch'], {
      fits: true,
      inferencePolicy: policy,
      duringTool: (internal) => internal.pendingRequests.push({
        agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
        coalescingSubject: 'zz-subject', coalescingBatch: true, coalescingBatchSubjects: ['zz-subject'],
      } as unknown as { agentName: string }),
    });
    try {
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered the batch'), 10_000), 'the batch\'s wake gets a turn of its own');
      assert.equal(t.membrane.calls.length, 2, 'the first round, then the batch\'s turn; the declined restart made no call');
    } finally {
      await t.close();
    }
  });
});

describe('the release check takes context-manager\'s verdict on the real strategy (#304)', () => {
  /**
   * A resident whose autobiographical strategy holds sixteen messages of
   * mixed sizes, none compressed: compression is pending, and stays so, since
   * nothing here can compress (the tick is stubbed: there is no compression
   * model). The verdict's path, the preview and both compiles, is the
   * strategy's own, unpatched.
   */
  async function realResident(adaptiveResolution: boolean, withStrategy?: (strategy: AutobiographicalStrategy) => void) {
    const proto = ContextManager.prototype as unknown as {
      tick: () => Promise<void>; previewContext: (...args: unknown[]) => unknown; compile: (...args: unknown[]) => unknown;
    };
    const tick = proto.tick;
    proto.tick = async () => {};
    // Spies that call through: the budget of each preview, to see that a
    // check ran and at what budget, and of each committing compile.
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

  it('keeps holding at a budget where a dry compile resolves but the plan does not fit', async () => {
    const t = await realResident(true);
    try {
      // Just over the budget, the adaptive strategy's dry compile can resolve
      // a plan the turn's compile refuses, and the preview says it doesn't
      // fit. The loop finds such a budget.
      assert.equal(t.preview(400_000).fits, true);
      const plan = t.preview(400_000).finalTokens;
      let band: number | undefined;
      for (let b = plan; b < plan * 1.05 && band === undefined; b += Math.max(1, Math.round(plan / 1_000))) {
        if (await t.dryCompileResolves(b) && !t.preview(b).fits) band = b;
      }
      assert.ok(band !== undefined, 'there is a budget where the dry compile resolves and the plan does not fit');
      t.setBudget(band);
      t.framework.start();
      const before = t.previews();
      t.wake();
      assert.ok(await pollUntil(() => t.of('inference:held').length === 1, 5_000), 'the turn\'s compile is refused there');
      assert.ok(await pollUntil(() => t.previews() > before, 3_000), 'and the release check has looked');
      assert.deepEqual(t.previewBudgets.at(-1), t.compileBudgets.at(-1), 'at the budget the refused compile planned at');
      await new Promise((r) => setTimeout(r, 1_000));
      assert.equal(t.of('inference:held').length, 1, 'held once, never released into the same refusal');
      assert.deepEqual(t.of('inference:hold_ended'), []);
      assert.equal(t.membrane.calls.length, 0);
      // The smallest budget the plan fits, by the preview. Its room to spare
      // is less than the note's size, so the released compile, which carries
      // the note, fits only because the note is merged after the selection.
      let lo = band;
      let hi = 400_000;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (t.preview(mid).fits) hi = mid; else lo = mid;
      }
      const atHi = t.preview(hi);
      const spare = atHi.budgetTokens - atHi.finalTokens;
      assert.ok(spare >= 0 && spare < 10,
        `${spare} tokens to spare at ${hi} (a plan of ${atHi.finalTokens} against ${atHi.budgetTokens}), well under the note's size`);
      t.setBudget(hi);
      assert.ok(await pollUntil(() => storedText(t.framework).includes('Answered once it fit'), 5_000), 'that budget releases it');
      assert.deepEqual(t.of('inference:hold_ended').map((e) => e.outcome), ['fit']);
      assert.ok(JSON.stringify(t.membrane.calls[0]).includes('[budget-hold]'), 'and its compile carries the note');
    } finally {
      await t.close();
    }
  });

  it('holds a context refusal once on the preview path, and runs the turn once the refusal clears', async () => {
    // Beth-2389's probe, kept as a test. A coverage defect in the strategy's
    // emission, one emitted entry left out while `drop` is set, makes its
    // coverage check refuse every select with UncoveredDropError: the
    // committing compile's and the preview's alike. Context-manager's preview
    // rethrows that refusal rather than answering fits: false.
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
      // Four changes the hold looks again for, a message each, and a look for
      // each: the preview rethrows the refusal at every one.
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
