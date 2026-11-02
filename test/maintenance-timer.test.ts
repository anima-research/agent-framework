import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  StrategyContext,
  TokenBudget,
} from '@animalabs/context-manager';
import type {
  Module,
  ModuleContext,
  EventResponse,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, ShutdownTimeoutError } from '../src/index.js';
import { OperatorActionError } from '../src/operator-log.js';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';

class QueuedStrategy implements ContextStrategy {
  readonly name = 'queued-test';
  ticks = 0;
  toolNames: string[][] = [];
  thinkDescriptions: string[] = [];

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 2, description: 'test maintenance queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    this.toolNames.push((ctx.tools ?? []).map((tool) => tool.name));
    const think = ctx.tools?.find((tool) => tool.name === 'think');
    if (think) this.thinkDescriptions.push(think.description);
    this.ticks++;
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class ProviderBoundMaintenanceStrategy implements ContextStrategy {
  readonly name = 'provider-bound-maintenance-test';
  ticks = 0;

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 1, description: 'provider-bound maintenance queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    await ctx.membrane?.complete({
      model: 'test-model',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'maintenance request' }],
      }],
      tools: ctx.tools,
    } as unknown as NormalizedRequest);
    this.ticks++;
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class FailingStrategy implements ContextStrategy {
  readonly name = 'failing-maintenance-test';

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'compression blocked' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    throw new Error('provider rejected maintenance request');
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose every pass takes one tick, then meets the same failure. */
class WorkThenFailStrategy implements ContextStrategy {
  readonly name = 'work-then-fail-test';
  ticks = 0;

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'compression queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.ticks % 2 === 0) throw new Error('provider rejected maintenance request');
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose initialization always fails. */
class RefusingInitStrategy implements ContextStrategy {
  readonly name = 'refusing-init-test';

  async initialize(_ctx: StrategyContext): Promise<void> {
    throw new Error('strategy initialization failed for the test');
  }

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'not expected' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy that refuses on its own, as the autobiographical one does for a branch it hasn't reloaded. */
class StaleStrategy implements ContextStrategy {
  readonly name = 'stale-test';

  checkReadiness(): ReadinessState {
    throw new Error('StaleStrategy.checkReadiness requires reinitialization for the current branch generation');
  }

  getProgressSnapshot(): Record<string, unknown> {
    throw new Error('StaleStrategy.getProgressSnapshot requires reinitialization for the current branch generation');
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose readiness query refuses with whatever text it's given. */
class SayingStrategy implements ContextStrategy {
  readonly name = 'saying-test';
  says = 'the first refusal';

  checkReadiness(): ReadinessState {
    throw new Error(this.says);
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy with work pending that no tick finishes. */
class NeverReadyStrategy implements ContextStrategy {
  readonly name = 'never-ready-test';

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'never ready' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose tick fences its own manager with a failed initialization. */
class FencingTickStrategy implements ContextStrategy {
  readonly name = 'fencing-tick-test';
  manager?: { setStrategy(strategy: ContextStrategy): Promise<void> };

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'fencing tick queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    await this.manager?.setStrategy(new RefusingInitStrategy()).catch(() => undefined);
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy with work pending whose tick runs a hook: a surgery can begin inside a pass. */
class HookedTickStrategy implements ContextStrategy {
  readonly name = 'hooked-tick-test';
  ticks = 0;
  onTick?: () => void;

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'hooked tick queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    this.onTick?.();
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy with no maintenance to do. */
class ReadyStrategy implements ContextStrategy {
  readonly name = 'ready-test';

  checkReadiness(): ReadinessState {
    return { ready: true };
  }

  async tick(_ctx: StrategyContext): Promise<void> {}

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose first tick waits on a gate, and that notes what it sees. */
class GatedTickStrategy implements ContextStrategy {
  readonly name = 'gated-tick-test';
  ticks = 0;
  ticksUnderHold = 0;
  branchAtFirstTickEnd?: string;
  storeOpenAtFirstTickEnd?: boolean;
  framework?: AgentFramework;
  private open?: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.open = resolve; });

  release(): void {
    this.open?.();
  }

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'gated tick queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if ((this.framework as unknown as { surgeryHold: unknown }).surgeryHold) this.ticksUnderHold++;
    if (this.ticks === 1) {
      await this.gate;
      this.storeOpenAtFirstTickEnd = !(this.framework as unknown as { store: { isClosed(): boolean } }).store.isClosed();
      this.branchAtFirstTickEnd = this.framework!.getAgent('agent')!.getContextManager().currentBranch().name;
    }
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/**
 * A strategy whose first tick makes a provider call that parks at the agent's
 * provider gate, as one does once a cooldown a primary call started has ended
 * and the retry turn it queued hasn't run yet.
 */
class ParkedCallTickStrategy implements ContextStrategy {
  readonly name = 'parked-call-tick-test';
  ticks = 0;
  calls = 0;
  outcome?: string;
  framework?: AgentFramework;

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'parked call queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.ticks > 1) return;
    const internals = this.framework as unknown as {
      providerGate(name: string): { primaryPending: boolean };
      withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
    };
    internals.providerGate('agent').primaryPending = true;
    try {
      await internals.withAuxiliaryAdmission('agent', async () => { this.calls++; });
      this.outcome = 'ran';
    } catch (error) {
      this.outcome = (error as Error).name;
      throw error;
    }
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A provider's stated wait of `ms`, as membrane reports a 429 with retry-after. */
function heldFor(ms: number): MembraneError {
  return new MembraneError({
    type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: ms,
    message: 'rate limited for the test', rawError: { status: 429 },
  });
}

/** A strategy whose first tick calls stop() before its first await, then notes whether the store was still open when it ended. */
class StopInTickStrategy implements ContextStrategy {
  readonly name = 'stop-in-tick-test';
  ticks = 0;
  framework?: AgentFramework;
  stopping?: Promise<void>;
  stoppedBeforeTickEnd?: boolean;
  storeOpenAtTickEnd?: boolean;

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'compression queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.ticks > 1) return;
    this.stopping = this.framework!.stop();
    // A stop() that doesn't wait for this tick settles first; one that does
    // can't settle before it ends, so the second second is this tick's.
    const first = await Promise.race([
      this.stopping.then(() => 'stopped' as const, () => 'stopped' as const),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 1000)),
    ]);
    this.stoppedBeforeTickEnd = first === 'stopped';
    this.storeOpenAtTickEnd = !(this.framework as unknown as { store: { isClosed(): boolean } }).store.isClosed();
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose first tick begins a rollback of `agent` before its first await, then notes whether the branch had moved when the tick ended. */
class RollbackInTickStrategy implements ContextStrategy {
  readonly name = 'rollback-in-tick-test';
  ticks = 0;
  framework?: AgentFramework;
  messageId?: string;
  moving?: Promise<unknown>;
  movedBeforeTickEnd?: boolean;
  branchAtTickEnd?: string;

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'compression queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.ticks > 1) return;
    this.moving = this.framework!.rollbackToMessage('agent', { messageId: this.messageId! });
    // A rollback that doesn't wait for this tick settles first; one that
    // does can't settle before the tick ends, so the timer wins.
    const first = await Promise.race([
      this.moving.then(() => 'moved' as const, () => 'moved' as const),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 1000)),
    ]);
    this.movedBeforeTickEnd = first === 'moved';
    this.branchAtTickEnd = this.framework!.getAgent('agent')!.getContextManager().currentBranch().name;
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy that counts its ticks, and its ticks in flight at once. Its first tick waits on a gate, and it is ready after three. */
class GatedCountingStrategy implements ContextStrategy {
  readonly name = 'gated-counting-test';
  ticks = 0;
  inFlight = 0;
  mostInFlight = 0;
  private open?: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.open = resolve; });

  release(): void {
    this.open?.();
  }

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 3, description: 'counted ticks queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    this.inFlight++;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    try {
      if (this.ticks === 1) await this.gate;
    } finally {
      this.inFlight--;
    }
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose every tick meets the same failure, its second only once its gate opens. */
class GatedRepeatFailureStrategy implements ContextStrategy {
  readonly name = 'gated-repeat-failure-test';
  ticks = 0;
  private open?: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.open = resolve; });

  release(): void {
    this.open?.();
  }

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'compression blocked' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.ticks === 2) await this.gate;
    throw new Error('provider rejected maintenance request');
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose first tick waits on a gate, then calls its manager's membrane, as a compression would. */
class CallAfterGateStrategy implements ContextStrategy {
  readonly name = 'call-after-gate-test';
  ticks = 0;
  entered = false;
  outcome?: string;
  private open?: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.open = resolve; });

  release(): void {
    this.open?.();
  }

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'a compression queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.ticks > 1) return;
    this.entered = true;
    await this.gate;
    try {
      await ctx.membrane?.complete({
        model: 'test-model',
        config: { model: 'test-model' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'compress' }] }],
      } as unknown as NormalizedRequest);
      this.outcome = 'sent';
    } catch (error) {
      this.outcome = (error as Error).name;
      throw error;
    }
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

/** A strategy whose ticks succeed and whose readiness can't be read once all of a pass's ticks have run. */
class RefusesAfterTicksStrategy implements ContextStrategy {
  readonly name = 'refuses-after-ticks-test';
  ticks = 0;
  failTick = false;

  checkReadiness(): ReadinessState {
    if (this.ticks >= 8 || (this.failTick && this.ticks > 0)) throw new Error('readiness refused after the ticks');
    return { ready: false, description: 'work queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    this.ticks++;
    if (this.failTick) throw new Error('tick failed');
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class ToolModule implements Module {
  readonly name = 'maintenance-tools';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'inspect',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {} },
    }];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'not expected', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

const membrane = {
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    throw new Error('not expected');
  },
} as unknown as import('@animalabs/membrane').Membrane;

class CapturingMembrane {
  calls: NormalizedRequest[] = [];

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    return {
      content: [],
      stopReason: 'end_turn',
      rawAssistantText: '',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      details: { raw: {} },
    } as unknown as NormalizedResponse;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

/** The first pass the timer recorded. The history lists the newest first, and
 *  under load more passes can end before a test reads it. */
function firstPass(framework: AgentFramework) {
  const history = framework.getContextMaintenanceSnapshot().history;
  return history[history.length - 1]!;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for maintenance');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('queued context maintenance timer', () => {
  it('drains without a new message and refreshes tools before ticking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy,
        allowedTools: 'all',
      }],
      modules: [new ToolModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });

    try {
      framework.start();
      await waitFor(() => strategy.ticks >= 2);
      // The agent's tools, its module's among them, are supplied to every
      // maintenance tick: compression declares every tool its history may
      // hold, folded or not.
      assert.ok(strategy.toolNames[0]!.includes('maintenance-tools--inspect'), strategy.toolNames[0]!.join(', '));
      const callable = framework.getAllTools().map((tool) => tool.name);
      const missing = callable.filter((name) => !strategy.toolNames[0]!.includes(name));
      assert.deepEqual(missing, [], `every tool the agent may call (allowedTools: 'all'): ${strategy.toolNames[0]!.join(', ')}`);
      assert.deepEqual(strategy.toolNames[1], strategy.toolNames[0], 'the same tools at each tick');
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length === 1);
      const snapshot = framework.getContextMaintenanceSnapshot();
      assert.equal(snapshot.current, null);
      assert.equal(snapshot.history[0].agents[0].ticks, 2);
      assert.equal(snapshot.history[0].agents[0].readyAfter, true);
      assert.deepEqual(snapshot.agents, [{ agentName: 'agent', ready: true }]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be disabled explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-disabled-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy,
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });

    try {
      framework.start();
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(strategy.ticks, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a policy-correct dynamic think definition into the provider-bound maintenance request', async () => {
    const cases: Array<{
      label: string;
      sameRoundThinkTextPolicy?: 'public' | 'private';
      expected: RegExp;
    }> = [
      {
        label: 'private',
        sameRoundThinkTextPolicy: 'private',
        expected: /withheld from channel routing/,
      },
      {
        label: 'compatibility-public',
        expected: /may still be routed publicly as your speech/,
      },
    ];

    for (const testCase of cases) {
      const dir = mkdtempSync(join(tmpdir(), `af-maintenance-think-${testCase.label}-`));
      const strategy = new ProviderBoundMaintenanceStrategy();
      const capture = new CapturingMembrane();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: capture.asMembrane(),
        agents: [{
          name: 'agent',
          model: 'test-model',
          systemPrompt: 'test',
          strategy,
          ...(testCase.sameRoundThinkTextPolicy !== undefined
            ? { sameRoundThinkTextPolicy: testCase.sameRoundThinkTextPolicy }
            : {}),
          allowedTools: 'all',
        }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      (framework as unknown as {
        channelRegistry: { getChannelTools: () => ToolDefinition[]; stopAll: () => void };
      }).channelRegistry = {
        getChannelTools: () => [
          {
            name: 'think',
            description: 'static channel think',
            inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: [] },
          },
        ],
        stopAll: () => {},
      };

      try {
        framework.start();
        await waitFor(() => capture.calls.length === 1);
        const think = capture.calls[0].tools?.find((tool) => tool.name === 'think');
        assert.ok(think, 'think tool should be present on the maintenance request');
        assert.match(think.description, testCase.expected);
        assert.notEqual(think.description, 'static channel think');
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('routes a maintenance failure through the ops-alert pipeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-alert-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent',
        model: 'test-model',
        systemPrompt: 'test',
        strategy: new FailingStrategy(),
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{
      kind: string;
      agentName: string;
      message: string;
      data?: Record<string, unknown>;
    }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push({ kind: event.kind, agentName: event.agentName, message: event.message, data: event.data });
    });

    try {
      framework.start();
      await waitFor(() => alerts.length > 0);
      assert.deepEqual(alerts[0], {
        kind: 'context-maintenance-failed',
        agentName: 'agent',
        message: 'provider rejected maintenance request',
        data: {
          scope: 'agent',
          pending: 'compression blocked',
        },
      });
      // Every pass meets the same failure. It is alerted once, and the
      // passes that only repeat it stay out of the history.
      await waitFor(() => (framework as unknown as { maintenanceRunId: number }).maintenanceRunId >= 3);
      const history = framework.getContextMaintenanceSnapshot().history;
      assert.equal(history.length, 1);
      assert.equal(history[0]!.agents[0]!.error, 'provider rejected maintenance request');
      assert.equal(alerts.length, 1);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an agent whose readiness can\'t be read fails alone: its run records the error and it gets its own alert', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-refused-'));
    const healthy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [
        { name: 'fenced', model: 'test-model', systemPrompt: 'test', strategy: new QueuedStrategy() },
        { name: 'healthy', model: 'test-model', systemPrompt: 'test', strategy: healthy },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push({ kind: event.kind, agentName: event.agentName, data: event.data });
    });

    // A failed strategy initialization fences the context manager: its state
    // queries throw until a successful switchBranch or setStrategy.
    const fenced = framework.getAgent('fenced')!.getContextManager();
    await assert.rejects(fenced.setStrategy(new RefusingInitStrategy()), /strategy initialization failed for the test/);
    assert.throws(() => fenced.isReady(), /requires successful strategy initialization/);

    try {
      framework.start();
      await waitFor(() => healthy.ticks >= 2);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.some(
        (run) => run.agents.some((agent) => agent.agentName === 'healthy' && agent.readyAfter === true),
      ));
      const snapshot = framework.getContextMaintenanceSnapshot();
      const run = snapshot.history.find((r) => r.agents.some((agent) => agent.agentName === 'healthy'))!;
      const fencedRun = run.agents.find((agent) => agent.agentName === 'fenced');
      assert.equal(fencedRun?.ticks, 0);
      assert.match(fencedRun?.error ?? '', /requires successful strategy initialization/);
      const entry = snapshot.agents.find((agent) => agent.agentName === 'fenced');
      assert.equal(entry?.ready, false);
      assert.match(entry?.error ?? '', /requires successful strategy initialization/);
      assert.ok(alerts.some((alert) => alert.agentName === 'fenced' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
      assert.equal(alerts.some((alert) => alert.agentName === 'healthy'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure that begins during the pass is that agent\'s error and alert, not the pass\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-refused-after-'));
    const strategy = new FencingTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    strategy.manager = framework.getAgent('agent')!.getContextManager();
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push({ kind: event.kind, agentName: event.agentName, data: event.data });
    });

    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = firstPass(framework).agents[0];
      assert.equal(run.agentName, 'agent');
      assert.equal(run.ticks, 1);
      assert.match(run.error ?? '', /requires successful strategy initialization/);
      assert.equal(run.readyAfter, undefined);
      assert.ok(alerts.some((alert) => alert.agentName === 'agent' && alert.kind === 'context-maintenance-failed' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a strategy that can\'t report its readiness or its progress fails that agent alone, and the snapshot still answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-stale-'));
    const healthy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [
        { name: 'stale', model: 'test-model', systemPrompt: 'test', strategy: new StaleStrategy() },
        { name: 'healthy', model: 'test-model', systemPrompt: 'test', strategy: healthy },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push({ kind: event.kind, agentName: event.agentName, data: event.data });
    });

    try {
      framework.start();
      await waitFor(() => healthy.ticks >= 2);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.some(
        (run) => run.agents.some((agent) => agent.agentName === 'healthy' && agent.readyAfter === true),
      ));
      const snapshot = framework.getContextMaintenanceSnapshot();
      const entry = snapshot.agents.find((agent) => agent.agentName === 'stale');
      assert.equal(entry?.ready, false);
      assert.match(entry?.error ?? '', /requires reinitialization for the current branch generation/);
      assert.equal(entry?.progress, undefined);
      assert.ok(alerts.some((alert) => alert.agentName === 'stale' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('whatever throws while one agent\'s maintenance is prepared is that agent\'s failure alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-prepare-throws-'));
    const healthy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [
        { name: 'broken', model: 'test-model', systemPrompt: 'test', strategy: new QueuedStrategy() },
        { name: 'healthy', model: 'test-model', systemPrompt: 'test', strategy: healthy },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: Array<{ kind: string; agentName: string; data?: Record<string, unknown> }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert') alerts.push({ kind: event.kind, agentName: event.agentName, data: event.data });
    });
    const internals = framework as unknown as { providerGateBlocked: (name: string) => boolean };
    const gateBlocked = internals.providerGateBlocked.bind(framework);
    internals.providerGateBlocked = (name: string) => {
      if (name === 'broken') throw new Error('gate read failed');
      return gateBlocked(name);
    };
    try {
      framework.start();
      await waitFor(() => healthy.ticks >= 2);
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.some(
        (run) => run.agents.some((agent) => agent.agentName === 'broken' && agent.error !== undefined),
      ));
      const run = framework.getContextMaintenanceSnapshot().history.find(
        (candidate) => candidate.agents.some((agent) => agent.agentName === 'broken'),
      )!;
      const broken = run.agents.find((agent) => agent.agentName === 'broken')!;
      assert.equal(broken.error, 'gate read failed');
      assert.equal(broken.ticks, 0);
      assert.ok(alerts.some((alert) => alert.agentName === 'broken' && alert.data?.scope === 'agent'));
      assert.equal(alerts.some((alert) => alert.data?.scope === 'pass'), false);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure that lasts is logged and alerted once, and again once the agent has recovered', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-lasting-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'fenced', model: 'test-model', systemPrompt: 'test', strategy: new QueuedStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(`${event.kind}:${event.agentName}`); });
    const internals = framework as unknown as { runQueuedMaintenance: () => Promise<void> };
    let passes = 0;
    const runPass = internals.runQueuedMaintenance.bind(framework);
    internals.runQueuedMaintenance = () => { passes++; return runPass(); };
    const logged = t.mock.method(console, 'error', () => {});
    const failedLines = () => logged.mock.calls.filter((call) =>
      String(call.arguments[0]).includes('[context-maintenance] agent=fenced failed:')).length;
    const runsWithError = () => framework.getContextMaintenanceSnapshot().history.filter((run) =>
      run.agents.some((agent) => agent.agentName === 'fenced' && agent.error !== undefined)).length;
    const cm = framework.getAgent('fenced')!.getContextManager();
    const fence = () => assert.rejects(cm.setStrategy(new RefusingInitStrategy()), /strategy initialization failed for the test/);
    await fence();
    try {
      framework.start();
      await waitFor(() => passes >= 3);
      assert.deepEqual(alerts, ['context-maintenance-failed:fenced']);
      assert.equal(failedLines(), 1);
      assert.equal(runsWithError(), 1, 'the passes that only repeat the failure stay out of the history');

      // Recovered with nothing to do: passes find it ready and skip it.
      await cm.setStrategy(new ReadyStrategy());
      const after = passes;
      await waitFor(() => passes >= after + 3);
      await fence();
      await waitFor(() => alerts.length === 2);
      assert.equal(failedLines(), 2);

      // Recovered with work no tick finishes: a pass runs it without a failure.
      await cm.setStrategy(new NeverReadyStrategy());
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.some((run) =>
        run.agents.some((agent) => agent.agentName === 'fenced' && agent.ticks > 0 && agent.error === undefined)));
      await fence();
      await waitFor(() => alerts.length === 3);
      assert.equal(failedLines(), 3);
      assert.deepEqual(new Set(alerts), new Set(['context-maintenance-failed:fenced']));
    } finally {
      logged.mock.restore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure that lasts is alerted again when its whole text changes, and again once the alert cooldown has passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-lasting-text-'));
    const strategy = new SayingStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'saying', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event.message); });
    const internals = framework as unknown as { runQueuedMaintenance: () => Promise<void>; opsAlertCooldownMs: number };
    let passes = 0;
    const runPass = internals.runQueuedMaintenance.bind(framework);
    internals.runQueuedMaintenance = () => { passes++; return runPass(); };
    const passed = async (n: number) => { const after = passes; await waitFor(() => passes >= after + n); };
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      await waitFor(() => alerts.length === 1);
      await passed(3);
      assert.deepEqual(alerts, ['the first refusal']);

      // Two long texts that differ only in their middle, which the bounded
      // text a run records leaves out: the alert follows the whole text.
      const long = (middle: string) => `${'a'.repeat(3_000)} ${middle} ${'z'.repeat(3_000)}`;
      strategy.says = long('one');
      await waitFor(() => alerts.length === 2);
      strategy.says = long('two');
      await waitFor(() => alerts.length === 3);
      await passed(3);
      assert.equal(alerts.length, 3);

      // Unchanged, it is alerted again once the cooldown has passed, with the
      // same text as the change's alert (as the trace bounds it).
      internals.opsAlertCooldownMs = 0;
      await waitFor(() => alerts.length >= 5);
      assert.ok(alerts.slice(3).every((text) => text === alerts[2]));
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure that lasts is posted to the webhook again a cooldown after its last post, whatever changed-text report came between', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-webhook-reminder-'));
    const strategy = new SayingStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'saying', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const internals = framework as unknown as { runQueuedMaintenance: () => Promise<void> };
    let passes = 0;
    const runPass = internals.runQueuedMaintenance.bind(framework);
    internals.runQueuedMaintenance = () => { passes++; return runPass(); };
    const passed = async (n: number) => { const after = passes; await waitFor(() => passes >= after + n); };
    // The real opsAlert, with a webhook whose posts are recorded.
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      posts.push(String(JSON.parse(String(init?.body)).content));
      return new Response('{}');
    }) as typeof fetch;
    const hook = process.env.CONNECTOME_OPS_WEBHOOK;
    process.env.CONNECTOME_OPS_WEBHOOK = 'http://webhook.invalid/hook';
    const realNow = Date.now;
    const start = realNow();
    let offset = 0;
    Date.now = () => realNow() + offset;
    const minute = 60_000;
    const maintenancePosts = () => posts.filter((post) => post.includes('context-maintenance-failed'));
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      await waitFor(() => maintenancePosts().length === 1);
      assert.match(maintenancePosts()[0]!, /the first refusal/);
      // 14 minutes on, the text changes: it's reported, and the webhook,
      // still within its cooldown, doesn't post it.
      offset = 14 * minute;
      strategy.says = 'the second refusal';
      await passed(3);
      assert.equal(maintenancePosts().length, 1);
      // At 15 minutes the webhook's cooldown since its post has passed.
      offset = 15 * minute + 1_000;
      await waitFor(() => maintenancePosts().length === 2);
      assert.match(maintenancePosts()[1]!, /the second refusal/);
      assert.ok(Date.now() - start < 16 * minute);
    } finally {
      console.error = quiet;
      Date.now = realNow;
      globalThis.fetch = realFetch;
      if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK; else process.env.CONNECTOME_OPS_WEBHOOK = hook;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a readiness refusal read after an agent\'s last tick is that agent\'s failure, alerted once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-refused-after-ticks-'));
    const strategy = new RefusesAfterTicksStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      // start() runs one pass at once; none follows within the test.
      maintenanceIntervalMs: 60_000,
    });
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(`${event.kind}:${event.agentName}:${event.message}`); });
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = firstPass(framework).agents[0];
      assert.equal(run.ticks, 8);
      assert.equal(run.error, 'readiness refused after the ticks');
      assert.equal(run.readyAfter, undefined);
      assert.deepEqual(alerts, ['context-maintenance-failed:agent:readiness refused after the ticks']);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a run records an agent\'s first failure: a readiness refusal after a failed tick isn\'t reported again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-first-failure-'));
    const strategy = new RefusesAfterTicksStrategy();
    strategy.failTick = true;
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 60_000,
    });
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(`${event.kind}:${event.agentName}:${event.message}`); });
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = firstPass(framework).agents[0];
      assert.equal(run.ticks, 0);
      assert.equal(run.error, 'tick failed');
      assert.deepEqual(alerts, ['context-maintenance-failed:agent:tick failed']);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const surgery of [
    { verb: 'roll back', run: (framework: AgentFramework, first: string) => framework.rollbackToMessage('agent', { messageId: first }) },
    { verb: 'suppress', run: (framework: AgentFramework, first: string) => framework.suppressMessages('agent', { messageIds: [first] }) },
    {
      verb: 'switch branch',
      who: 'every agent',
      run: (framework: AgentFramework, first: string) => {
        framework.getAgent('agent')!.getContextManager().branchAt(first as never, 'elsewhere');
        return framework.switchBranch('elsewhere');
      },
    },
  ] as Array<{ verb: string; who?: string; run: (framework: AgentFramework, first: string) => Promise<unknown> }>) {
    it(`a ${surgery.verb} that begins during a tick waits for it before it moves the branch, and resume refuses while the ${surgery.verb} holds the store`, { timeout: 10_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-surgery-waits-'));
      const strategy = new GatedTickStrategy();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane,
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      strategy.framework = framework;
      const cm = framework.getAgent('agent')!.getContextManager();
      const first = String(cm.addMessage('user', [{ type: 'text', text: 'm1' }]));
      cm.addMessage('user', [{ type: 'text', text: 'm2' }]);
      const internals = framework as unknown as { surgeryHold: unknown };
      try {
        await framework.quiesce();
        framework.start();
        await waitFor(() => strategy.ticks === 1);
        const moved = surgery.run(framework, first);
        await waitFor(() => internals.surgeryHold !== null);
        await assert.rejects(
          framework.resume(),
          (error: unknown) => error instanceof OperatorActionError && error.code === 'agent-busy'
            && error.message.includes(`a live ${surgery.verb} for ${surgery.who ?? 'agent'} holds the store`),
        );
        assert.equal(cm.currentBranch().name, 'main', `the ${surgery.verb} waits for the running tick`);
        strategy.release();
        await moved;
        assert.equal(strategy.branchAtFirstTickEnd, 'main');
        assert.equal(strategy.ticksUnderHold, 0, `the pass starts no tick while the ${surgery.verb} holds the store`);
        assert.notEqual(cm.currentBranch().name, 'main');
        const status = await framework.resume();
        assert.equal(status.quiesced, false);
      } finally {
        strategy.release();
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const surgery of [
    { verb: 'roll back', run: (framework: AgentFramework, first: string) => framework.rollbackToMessage('agent', { messageId: first }) },
    { verb: 'suppress', run: (framework: AgentFramework, first: string) => framework.suppressMessages('agent', { messageIds: [first] }) },
    {
      verb: 'switch branch',
      run: (framework: AgentFramework, first: string) => {
        framework.getAgent('agent')!.getContextManager().branchAt(first as never, 'elsewhere');
        return framework.switchBranch('elsewhere');
      },
    },
  ] as Array<{ verb: string; run: (framework: AgentFramework, first: string) => Promise<unknown> }>) {
    it(`a ${surgery.verb} withdraws a maintenance call parked at the provider gate rather than waiting on it, and that is no failure`, { timeout: 10_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-parked-call-'));
      const strategy = new ParkedCallTickStrategy();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane,
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      strategy.framework = framework;
      const alerts: string[] = [];
      (framework as any).opsAlert = (kind: string, agentName: string, message: string) => alerts.push(`${kind}:${agentName}:${message}`);
      const cm = framework.getAgent('agent')!.getContextManager();
      const first = String(cm.addMessage('user', [{ type: 'text', text: 'm1' }]));
      cm.addMessage('user', [{ type: 'text', text: 'm2' }]);
      const internals = framework as unknown as { providerGate(name: string): { auxiliaryWaiters: unknown[] } };
      const quiet = console.error;
      console.error = () => {};
      try {
        await framework.quiesce();
        framework.start();
        await waitFor(() => internals.providerGate('agent').auxiliaryWaiters.length === 1);
        const moved = surgery.run(framework, first);
        const outcome = await Promise.race([
          moved.then(() => 'moved'),
          new Promise<string>((resolve) => setTimeout(() => resolve(`the ${surgery.verb} still waits`), 3_000)),
        ]);
        assert.equal(outcome, 'moved');
        assert.equal(strategy.outcome, 'MaintenanceWithdrawnError');
        assert.equal(strategy.calls, 0, 'the withdrawn call sent nothing');
        assert.notEqual(cm.currentBranch().name, 'main');
        assert.deepEqual(alerts.filter((alert) => alert.startsWith('context-maintenance-failed')), []);
        const run = firstPass(framework).agents[0]!;
        assert.equal(run.error, undefined);
      } finally {
        console.error = quiet;
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('a maintenance provider call made while a surgery holds the store is withdrawn before it is sent, with the gate closed too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-withdrawn-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new GatedTickStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      reserveStoreForSurgery(verb: string, agentName: string): () => void;
      withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
      providerGate(name: string): { primaryPending: boolean };
    };
    try {
      for (const closed of [false, true]) {
        let ran = false;
        const release = internals.reserveStoreForSurgery('roll back', 'agent');
        // Closed: a cooldown's retry turn is queued, which the hold keeps from
        // starting, so a call that parked would never be woken.
        internals.providerGate('agent').primaryPending = closed;
        try {
          const admitted = internals.withAuxiliaryAdmission('agent', async () => { ran = true; });
          void admitted.catch(() => {});
          const outcome = await Promise.race([
            admitted.then(() => 'admitted', (error: unknown) => error),
            new Promise<string>((resolve) => setTimeout(() => resolve('parked'), 1_000)),
          ]);
          assert.ok(
            outcome instanceof Error && outcome.name === 'MaintenanceWithdrawnError'
              && outcome.message === 'maintenance call withdrawn: a live roll back for agent holds the store',
            `${closed ? 'gate closed' : 'gate open'}: ${outcome instanceof Error ? outcome.message : String(outcome)}`,
          );
          assert.equal(ran, false);
        } finally {
          internals.providerGate('agent').primaryPending = false;
          release();
        }
      }
      assert.equal(await internals.withAuxiliaryAdmission('agent', async () => 7), 7, 'admitted again once the hold is released');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a parked maintenance call woken while its gate is still closed parks again, and goes once the gate opens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-parks-again-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new GatedTickStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
      providerGate(name: string): { primaryPending: boolean; auxiliaryWaiters: Array<() => void> };
      flushAuxiliaryAdmission(name: string): void;
    };
    try {
      const gate = internals.providerGate('agent');
      gate.primaryPending = true;
      let ran = false;
      const call = internals.withAuxiliaryAdmission('agent', async () => { ran = true; return 7; });
      await waitFor(() => gate.auxiliaryWaiters.length === 1);
      for (const resolve of gate.auxiliaryWaiters.splice(0)) resolve();
      await waitFor(() => gate.auxiliaryWaiters.length === 1);
      assert.equal(ran, false, 'woken with the gate still closed, it parked again');
      gate.primaryPending = false;
      internals.flushAuxiliaryAdmission('agent');
      assert.equal(await call, 7);
      assert.equal(ran, true);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const kind of ['resident', 'conversation agent'] as const) {
    for (const held of [false, true]) {
      it(`a ${kind}'s tick that reaches its provider under a surgery's hold is withdrawn${held ? ', though a provider wait holds its model' : ''}`, { timeout: 10_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-surgery-withdrawn-'));
        const provider = new CapturingMembrane();
        const tick = new CallAfterGateStrategy();
        const conversational = kind === 'conversation agent';
        const framework = await AgentFramework.create({
          storePath: join(dir, 'store'),
          membrane: provider.asMembrane(),
          agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: conversational ? new ReadyStrategy() : tick }],
          modules: [],
          syncIntervalMs: 0,
          maintenanceIntervalMs: 10,
          ...(conversational ? { conversations: { templateAgent: 'agent', strategyFactory: () => tick } } : {}),
        });
        const internals = framework as unknown as {
          createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
          reserveStoreForSurgery(verb: string, agentName: string): () => void;
          recordProviderWait(agentName: string, model: string, error: Error): unknown;
        };
        const name = conversational ? 'agent-conv-1' : 'agent';
        const alerts: string[] = [];
        (framework as any).opsAlert = (kind: string, agentName: string) => alerts.push(`${kind}:${agentName}`);
        const quiet = console.error;
        console.error = () => {};
        try {
          if (conversational) await internals.createConversationAgent(name, { serverId: 'stub', channelId: 'chan-1' });
          if (held) internals.recordProviderWait(name, 'test-model', heldFor(60_000));
          framework.start();
          await waitFor(() => tick.entered);
          const release = internals.reserveStoreForSurgery('roll back', 'agent');
          try {
            tick.release();
            await waitFor(() => tick.outcome !== undefined);
            assert.equal(tick.outcome, 'MaintenanceWithdrawnError');
            assert.equal(provider.calls.length, 0, 'the withdrawn call sent nothing');
          } finally {
            release();
          }
          assert.deepEqual(alerts.filter((alert) => alert.startsWith('context-maintenance-failed')), []);
        } finally {
          console.error = quiet;
          tick.release();
          await framework.stop();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it('a pass that only meets a failure already reported stays out of the history', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-repeats-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new FailingStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    (framework as any).opsAlert = () => {};
    const internals = framework as unknown as { maintenanceRunId: number };
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      await waitFor(() => internals.maintenanceRunId >= 4);
      const history = framework.getContextMaintenanceSnapshot().history;
      assert.equal(history.length, 1, 'the first report only, though four passes met the failure');
      assert.equal(history[0]!.id, 1);
      assert.ok(history[0]!.agents[0]!.error);
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an operator's maintain keeps the pass it ran in the history, though the pass only met a failure already reported", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-requested-pass-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new FailingStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    (framework as any).opsAlert = () => {};
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      const first = await framework.maintenanceTick();
      assert.equal(first.ran, true);
      const reported = first.history[0]!.id;
      assert.ok(first.history[0]!.agents[0]!.error, 'the first pass reports the failure');
      const second = await framework.maintenanceTick();
      assert.equal(second.ran, true);
      assert.ok(second.history[0]!.id > reported, 'the newest run is the pass the second maintain ran');
      assert.ok(second.history[0]!.agents[0]!.error);
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("a maintain whose pass had nothing to run leaves no request for the next pass", { timeout: 10_000 }, async () => {
    // Gordon-2414's probe. While the agent's own call holds its provider gate,
    // a maintain's pass queues nothing and records no run, so the next pass,
    // which nobody asked for and which meets only the failure already
    // reported, stays out of the history.
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-request-reset-'));
    const strategy = new FailingStrategy();
    let ticks = 0;
    const failingTick = strategy.tick.bind(strategy);
    strategy.tick = async (ctx: StrategyContext) => { ticks++; return failingTick(ctx); };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      acquirePrimaryProviderGate(agentName: string): void;
      releasePrimaryProviderGate(agentName: string): void;
      startQueuedMaintenance(): void;
      maintenancePass: Promise<void> | null;
    };
    (framework as any).opsAlert = () => {};
    const quiet = console.error;
    const quietWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      framework.start();
      const first = await framework.maintenanceTick();
      assert.equal(first.history.length, 1, 'the first maintain reports the failure');
      internals.acquirePrimaryProviderGate('agent');
      const second = await framework.maintenanceTick();
      assert.equal(second.ran, true);
      assert.equal(second.history.length, 1, 'a pass with nothing queued records no run');
      assert.equal(ticks, 1, 'the second maintain ran no tick');
      internals.releasePrimaryProviderGate('agent');
      internals.startQueuedMaintenance();
      await internals.maintenancePass;
      assert.equal(ticks, 2, 'the pass nobody asked for ran its tick');
      assert.equal(framework.getContextMaintenanceSnapshot().history.length, 1, 'the repeat nobody asked for stays out of the history');
    } finally {
      console.error = quiet;
      console.warn = quietWarn;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a maintain that joins a pass already running keeps that pass in the history", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-request-join-'));
    const strategy = new GatedRepeatFailureStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as { startQueuedMaintenance(): void };
    (framework as any).opsAlert = () => {};
    const quiet = console.error;
    const quietWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      framework.start();
      const first = await framework.maintenanceTick();
      assert.equal(first.history.length, 1, 'the first maintain reports the failure');
      // A pass nobody asked for, whose tick waits on the gate.
      internals.startQueuedMaintenance();
      await waitFor(() => strategy.ticks === 2);
      // The maintain joins it, and the pass then meets the failure already reported.
      const joining = framework.maintenanceTick();
      strategy.release();
      const joined = await joining;
      assert.equal(joined.ran, true);
      assert.equal(strategy.ticks, 2, 'the maintain started no pass of its own');
      assert.equal(joined.history.length, 2, 'the pass the maintain joined is kept');
      assert.ok(joined.history[0]!.id > first.history[0]!.id);
    } finally {
      console.error = quiet;
      console.warn = quietWarn;
      strategy.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a pass that took a tick before meeting a failure already reported stays in the history', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-repeats-after-work-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new WorkThenFailStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    (framework as any).opsAlert = () => {};
    const internals = framework as unknown as { maintenanceRunId: number };
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      await waitFor(() => internals.maintenanceRunId >= 4);
      const history = framework.getContextMaintenanceSnapshot().history;
      assert.ok(history.length >= 3, `each finished pass did work, so each is kept (${history.length})`);
      for (const run of history) {
        assert.equal(run.agents[0]!.ticks, 1);
        assert.ok(run.agents[0]!.error);
      }
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const kind of ['resident', 'conversation agent'] as const) for (const held of [false, true]) {
    it(`a ${kind}'s maintenance call made once stop() has begun is withdrawn${held ? ', though a provider wait holds its model,' : ''} and no failure is reported`, { timeout: 10_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-stopping-'));
      const provider = new CapturingMembrane();
      const tick = new CallAfterGateStrategy();
      const conversational = kind === 'conversation agent';
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: provider.asMembrane(),
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: conversational ? new ReadyStrategy() : tick }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
        ...(conversational ? { conversations: { templateAgent: 'agent', strategyFactory: () => tick } } : {}),
      });
      const internals = framework as unknown as {
        createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
        recordProviderWait(agentName: string, model: string, error: Error): unknown;
      };
      const name = conversational ? 'agent-conv-1' : 'agent';
      const alerts: string[] = [];
      (framework as any).opsAlert = (...args: unknown[]) => { alerts.push(args.map(String).join(' ')); };
      const quiet = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      let stopping: Promise<void> | undefined;
      try {
        if (conversational) await internals.createConversationAgent(name, { serverId: 'stub', channelId: 'chan-1' });
        if (held) internals.recordProviderWait(name, 'test-model', heldFor(60_000));
        framework.start();
        await waitFor(() => tick.entered);
        stopping = framework.stop();
        tick.release();
        await waitFor(() => tick.outcome !== undefined);
        await stopping;
        assert.equal(tick.outcome, 'MaintenanceWithdrawnError');
        assert.equal(provider.calls.length, 0, 'the withdrawn call sent nothing');
        assert.ok(logged.some((line) => line.includes(
          `[context-maintenance] agent=${name} stopped: maintenance call withdrawn: provider admission closed while stopping (${name})`,
        )), logged.join('\n'));
        assert.deepEqual(alerts, [], 'no alert');
        for (const run of framework.getContextMaintenanceSnapshot().history) {
          for (const record of run.agents) assert.equal(record.error, undefined, `no failure recorded for ${record.agentName}`);
        }
      } finally {
        console.error = quiet;
        tick.release();
        await (stopping ?? framework.stop());
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('stop() withdraws a maintenance call parked at the provider gate, and that is no failure', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-parked-stop-'));
    const strategy = new ParkedCallTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    strategy.framework = framework;
    const alerts: string[] = [];
    (framework as any).opsAlert = (...args: unknown[]) => { alerts.push(args.map(String).join(' ')); };
    const internals = framework as unknown as { providerGate(name: string): { auxiliaryWaiters: unknown[] } };
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      await waitFor(() => internals.providerGate('agent').auxiliaryWaiters.length === 1);
      await framework.stop();
      assert.equal(strategy.outcome, 'MaintenanceWithdrawnError');
      assert.equal(strategy.calls, 0, 'the withdrawn call sent nothing');
      assert.deepEqual(alerts, []);
    } finally {
      console.error = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an over-budget drain kick starts in a framework that was never started, as one run with runUntilIdle() is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-unstarted-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new ReadyStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
      overBudgetDrains: Set<Promise<void>>;
    };
    const alerts: string[] = [];
    (framework as any).opsAlert = (...args: unknown[]) => { alerts.push(args.map(String).join(' ')); };
    const quiet = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      assert.equal(internals.overBudgetDrains.size, 1, 'a kick was started');
      assert.ok(alerts.some((alert) => alert.includes('drain breaker kicking;')), alerts.join('\n'));
      await Promise.all([...internals.overBudgetDrains]);
      assert.ok(logged.some((line) => line.includes('drain kicked for agent (OverBudget breaker, 8 ticks)')), logged.join('\n'));
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stop() begun from inside the refusal's alert waits for the kick the alert reports, which ticks none", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-stop-in-alert-'));
    const strategy = new GatedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    strategy.framework = framework;
    const internals = framework as unknown as {
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
      overBudgetDrains: Set<Promise<void>>;
    };
    const alerts: string[] = [];
    let drainsAtAlert = -1;
    let stopping: Promise<void> | undefined;
    // An ops:alert listener that stops the framework, as the alert is raised.
    (framework as any).opsAlert = (kind: string, _agentName: string, message: string) => {
      if (kind !== 'context-refusal') return;
      alerts.push(message);
      drainsAtAlert = internals.overBudgetDrains.size;
      stopping ??= framework.stop();
    };
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      assert.ok(stopping, 'the alert began stop()');
      assert.match(alerts[0] ?? '', /drain breaker kicking;/);
      assert.equal(drainsAtAlert, 1, 'the kick joined the drains stop() waits for before the alert');
      await stopping;
      assert.equal(strategy.ticks, 0, 'the kick ticked none');
      assert.ok(
        logged.some((line) => line.includes('drain kicked for agent (OverBudget breaker, 0 ticks, stopped as the framework stops)')),
        'the kick says it stopped, and why',
      );
    } finally {
      console.error = quiet;
      strategy.release();
      await (stopping ?? framework.stop());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a surgery begun from inside the refusal's alert waits for the kick the alert reports, which ticks none", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-surgery-in-alert-'));
    const strategy = new GatedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    strategy.framework = framework;
    const cm = framework.getAgent('agent')!.getContextManager();
    const first = String(cm.addMessage('user', [{ type: 'text', text: 'm1' }]));
    cm.addMessage('user', [{ type: 'text', text: 'm2' }]);
    const internals = framework as unknown as {
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
      overBudgetDrains: Set<Promise<void>>;
    };
    const alerts: string[] = [];
    let drainsAtAlert = -1;
    let moving: Promise<unknown> | undefined;
    // An ops:alert listener that rolls the agent back, as the alert is raised.
    (framework as any).opsAlert = (kind: string, _agentName: string, message: string) => {
      if (kind !== 'context-refusal') return;
      alerts.push(message);
      drainsAtAlert = internals.overBudgetDrains.size;
      moving ??= framework.rollbackToMessage('agent', { messageId: first });
    };
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      assert.ok(moving, 'the alert began a rollback');
      assert.match(alerts[0] ?? '', /drain breaker kicking;/);
      assert.equal(drainsAtAlert, 1, 'the kick joined the drains the rollback waits for before the alert');
      await moving;
      assert.equal(strategy.ticks, 0, 'the kick ticked none');
      assert.ok(
        logged.some((line) => line.includes('drain kicked for agent (OverBudget breaker, 0 ticks, stopped while a surgery holds the store)')),
        'the kick says it stopped, and why',
      );
      assert.notEqual(cm.currentBranch().name, 'main', 'the rollback went on once the kick ended');
    } finally {
      console.error = quiet;
      strategy.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a stop() made from a drain's first tick, before that tick's first await, waits for the tick", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-stop-in-tick-'));
    const strategy = new StopInTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    strategy.framework = framework;
    const internals = framework as unknown as {
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
    };
    (framework as any).opsAlert = () => {};
    const quiet = console.error;
    console.error = () => {};
    try {
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      await waitFor(() => strategy.stopping !== undefined);
      await strategy.stopping;
      assert.equal(strategy.stoppedBeforeTickEnd, false, 'stop() waited for the tick');
      assert.equal(strategy.storeOpenAtTickEnd, true, 'the tick ended before the store closed');
    } finally {
      console.error = quiet;
      await (strategy.stopping ?? framework.stop());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stop() made from a pass's first tick, before that tick's first await, waits for the tick", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-pass-stop-in-tick-'));
    const strategy = new StopInTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 60_000,
    });
    strategy.framework = framework;
    const alerts: string[] = [];
    (framework as any).opsAlert = (kind: string) => { alerts.push(kind); };
    const quiet = console.error;
    console.error = () => {};
    try {
      // start() runs the first pass at once.
      framework.start();
      assert.ok(strategy.stopping, "the pass's first tick began stop()");
      await strategy.stopping;
      await waitFor(() => strategy.storeOpenAtTickEnd !== undefined, 3000);
      assert.equal(strategy.stoppedBeforeTickEnd, false, 'stop() waited for the tick');
      assert.equal(strategy.storeOpenAtTickEnd, true, 'the tick ended before the store closed');
      assert.deepEqual(alerts, [], 'the pass met no failure');
    } finally {
      console.error = quiet;
      await (strategy.stopping ?? framework.stop());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rollback begun from a pass's first tick, before that tick's first await, waits for the tick, and the pass takes no tick under its hold", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-pass-rollback-in-tick-'));
    const strategy = new RollbackInTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 60_000,
    });
    strategy.framework = framework;
    const cm = framework.getAgent('agent')!.getContextManager();
    strategy.messageId = String(cm.addMessage('user', [{ type: 'text', text: 'm1' }]));
    cm.addMessage('user', [{ type: 'text', text: 'm2' }]);
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      assert.ok(strategy.moving, "the pass's first tick began a rollback");
      await strategy.moving;
      await waitFor(() => strategy.branchAtTickEnd !== undefined, 3000);
      assert.equal(strategy.movedBeforeTickEnd, false, 'the rollback waited for the tick');
      assert.equal(strategy.branchAtTickEnd, 'main', 'the branch was where it was when the tick ended');
      assert.notEqual(cm.currentBranch().name, 'main', 'the rollback went on once the tick ended');
      assert.equal(strategy.ticks, 1, 'the pass took no tick under the hold');
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a maintain begun from an alert a pass raises while it prepares joins that pass, rather than starting a second beside it', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-maintain-in-alert-'));
    const counting = new GatedCountingStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [
        { name: 'unreadable', model: 'test-model', systemPrompt: 'test', strategy: new SayingStrategy() },
        { name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: counting },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 60_000,
    });
    let maintaining: Promise<unknown> | undefined;
    // An ops:alert listener that runs maintain when the unreadable agent's
    // failure is alerted, which the pass does while it prepares.
    framework.onTrace((event) => {
      if (event.type === 'ops:alert' && event.kind === 'context-maintenance-failed' && event.agentName === 'unreadable') maintaining ??= framework.maintenanceTick();
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      framework.start();
      assert.ok(maintaining, 'the pass alerted the failure while it prepared');
      await waitFor(() => counting.ticks >= 1);
      counting.release();
      await maintaining;
      assert.equal(counting.mostInFlight, 1, 'one tick of the agent at a time');
      assert.equal(framework.getContextMaintenanceSnapshot().history.length, 1, 'one pass ran');
    } finally {
      console.error = quiet;
      counting.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an over-budget drain kick takes no tick of a conversation agent disposed before its first tick, and names the disposal though a surgery holds the store', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-disposed-'));
    const forks: GatedCountingStrategy[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'test', strategy: new ReadyStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      conversations: {
        templateAgent: 'trunk',
        bind: { channel: 'mention' },
        strategyFactory: () => { const fork = new GatedCountingStrategy(); forks.push(fork); return fork; },
      },
    });
    const internals = framework as unknown as {
      createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
      disposeConversationAgent(name: string): void;
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
      overBudgetDrains: Set<Promise<void>>;
      surgeryHold: { verb: string; agentName: string; since: number } | null;
    };
    (framework as any).opsAlert = () => {};
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // The kick's body runs a microtask later, so each fork is disposed
      // before the drain's first check.
      await internals.createConversationAgent('trunk-chan-g1', { serverId: 'stub', channelId: 'world:chan' });
      internals.noteInferenceExhausted('trunk-chan-g1', 'compile refused', false, 'over_budget');
      assert.equal(internals.overBudgetDrains.size, 1, 'a kick was started');
      internals.disposeConversationAgent('trunk-chan-g1');
      // Open the gate, so a drain that did tick shows its count.
      forks[0]!.release();
      await Promise.all([...internals.overBudgetDrains]);
      assert.equal(forks[0]!.ticks, 0, 'no tick of the disposed agent');
      assert.ok(
        logged.some((line) => line.includes('drain kicked for trunk-chan-g1 (OverBudget breaker, 0 ticks, stopped as the agent was disposed)')),
        logged.join('\n'),
      );
      // A surgery for another agent holding the store as well: the log names
      // the disposal, the agent's own reason.
      await internals.createConversationAgent('trunk-chan-g2', { serverId: 'stub', channelId: 'world:chan' });
      internals.noteInferenceExhausted('trunk-chan-g2', 'compile refused', false, 'over_budget');
      internals.disposeConversationAgent('trunk-chan-g2');
      internals.surgeryHold = { verb: 'rollback', agentName: 'trunk', since: Date.now() };
      forks[1]!.release();
      await Promise.all([...internals.overBudgetDrains]);
      assert.equal(forks[1]!.ticks, 0, 'no tick of the second disposed agent');
      assert.ok(
        logged.some((line) => line.includes('drain kicked for trunk-chan-g2 (OverBudget breaker, 0 ticks, stopped as the agent was disposed)')),
        logged.join('\n'),
      );
    } finally {
      console.error = quiet;
      internals.surgeryHold = null;
      for (const fork of forks) fork.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pass takes no further tick of a conversation agent disposed while its tick was in flight', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-pass-disposed-'));
    const fork = new GatedCountingStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'test', strategy: new ReadyStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      conversations: { templateAgent: 'trunk', bind: { channel: 'mention' }, strategyFactory: () => fork },
    });
    const internals = framework as unknown as {
      createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
      disposeConversationAgent(name: string): void;
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      await internals.createConversationAgent('trunk-chan-g1', { serverId: 'stub', channelId: 'world:chan' });
      framework.start();
      const maintaining = framework.maintenanceTick();
      await waitFor(() => fork.ticks === 1);
      internals.disposeConversationAgent('trunk-chan-g1');
      fork.release();
      const snapshot = await maintaining;
      assert.equal(fork.ticks, 1, 'no tick after the agent was disposed');
      assert.equal(snapshot.history[0]?.agents.find((run) => run.agentName === 'trunk-chan-g1')?.ticks, 1, 'its run records the one tick');
    } finally {
      console.error = quiet;
      fork.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no over-budget drain kick starts once stop() has begun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-after-stop-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new ReadyStrategy() }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const internals = framework as unknown as {
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
      overBudgetDrains: Set<Promise<void>>;
    };
    const alerts: string[] = [];
    (framework as any).opsAlert = (...args: unknown[]) => { alerts.push(args.map(String).join(' ')); };
    const quiet = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      framework.start();
      const stopping = framework.stop();
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      assert.equal(internals.overBudgetDrains.size, 0, 'no kick was started');
      assert.ok(alerts.some((alert) => alert.startsWith('context-refusal agent ')
        && alert.includes('drain breaker not kicked: the framework is stopping;')), alerts.join('\n'));
      await stopping;
      assert.ok(!logged.some((line) => line.includes('drain kicked')), logged.join('\n'));
    } finally {
      console.error = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a surgery that takes the store while resume waits for a tick is refused by resume after the wait', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-resume-rechecks-'));
    const strategy = new GatedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    strategy.framework = framework;
    const cm = framework.getAgent('agent')!.getContextManager();
    const first = String(cm.addMessage('user', [{ type: 'text', text: 'm1' }]));
    cm.addMessage('user', [{ type: 'text', text: 'm2' }]);
    const internals = framework as unknown as { surgeryHold: unknown };
    try {
      await framework.quiesce();
      framework.start();
      await waitFor(() => strategy.ticks === 1);
      // resume() finds no surgery and waits for the running tick; the
      // rollback takes the store meanwhile.
      const resuming = framework.resume();
      void resuming.catch(() => {});
      const moved = framework.rollbackToMessage('agent', { messageId: first });
      await waitFor(() => internals.surgeryHold !== null);
      strategy.release();
      await assert.rejects(
        resuming,
        (error: unknown) => error instanceof OperatorActionError && error.code === 'agent-busy'
          && error.message.includes('a live roll back for agent holds the store'),
      );
      assert.equal(framework.getHostModeStatus().quiesced, true, 'the host stays quiesced');
      await moved;
    } finally {
      strategy.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a rollback waits for an over-budget drain kick\'s tick in flight, and the kick ticks no more under the hold', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-hold-'));
    const strategy = new GatedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    strategy.framework = framework;
    const cm = framework.getAgent('agent')!.getContextManager();
    const first = String(cm.addMessage('user', [{ type: 'text', text: 'm1' }]));
    cm.addMessage('user', [{ type: 'text', text: 'm2' }]);
    const internals = framework as unknown as {
      surgeryHold: unknown;
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      // A refused compile kicks the drain, whose first tick waits on the gate.
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      await waitFor(() => strategy.ticks === 1);
      const moved = framework.rollbackToMessage('agent', { messageId: first });
      await waitFor(() => internals.surgeryHold !== null);
      assert.equal(cm.currentBranch().name, 'main', 'the rollback waits for the drain kick\'s tick');
      strategy.release();
      await moved;
      assert.equal(strategy.branchAtFirstTickEnd, 'main');
      assert.equal(strategy.ticksUnderHold, 0, 'the kick starts no tick while the rollback holds the store');
      assert.notEqual(cm.currentBranch().name, 'main');
    } finally {
      console.error = quiet;
      strategy.release();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop() waits for an over-budget drain kick's tick in flight, and the kick ticks no more once stop() has begun", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-drain-stop-'));
    const strategy = new GatedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    strategy.framework = framework;
    const internals = framework as unknown as {
      noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
    };
    const quiet = console.error;
    console.error = () => {};
    let stopped = false;
    try {
      framework.start();
      // A refused compile kicks the drain, whose first tick waits on the gate.
      internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
      await waitFor(() => strategy.ticks === 1);
      const stopping = framework.stop().then(() => { stopped = true; });
      // A stop() that didn't wait would close the store with the tick held:
      // it gets half a second to.
      await waitFor(() => stopped, 500).catch(() => {});
      assert.equal(stopped, false, 'stop() waits for the kick\'s tick in flight');
      strategy.release();
      await stopping;
      assert.equal(strategy.storeOpenAtFirstTickEnd, true, 'the tick in flight ended before the store closed');
      assert.equal(strategy.ticks, 1, 'the kick starts no tick once stop() has begun');
    } finally {
      console.error = quiet;
      strategy.release();
      if (!stopped) await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("stop(t) with a maintenance tick that outlasts its budget", () => {
    /** stop(t)'s outcome: its rejection, 'resolved', or 'still pending' after
     *  5 s, so a stop() that waits on the tick fails the test rather than
     *  hanging it. */
    async function stopWithin(framework: AgentFramework, budget?: number): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          framework.stop(budget).then(() => 'resolved', (error: unknown) => error),
          new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 5_000); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    const maintenancePending = (outcome: unknown): boolean => outcome instanceof ShutdownTimeoutError
      && outcome.message === 'Shutdown timed out after 100 ms; pending: maintenance';

    it("a drain kick's tick: stop(t) fails naming maintenance, keeps the store open, and a later stop(t) waits for the same tick again", { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-stop-budget-'));
      const strategy = new GatedTickStrategy();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane,
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 0,
      });
      strategy.framework = framework;
      const internals = framework as unknown as {
        noteInferenceExhausted(agentName: string, reason: string, retryable?: boolean, errorType?: string): void;
      };
      const quiet = console.error;
      console.error = () => {};
      try {
        framework.start();
        internals.noteInferenceExhausted('agent', 'compile refused', false, 'over_budget');
        await waitFor(() => strategy.ticks === 1);
        const outcome = await stopWithin(framework, 100);
        assert.ok(maintenancePending(outcome), String(outcome));
        assert.equal(framework.getStore().isClosed(), false, 'the tick may still write');
        const again = await stopWithin(framework, 100);
        assert.ok(maintenancePending(again), `a later stop() waits for the tick still held: ${String(again)}`);
        assert.equal(framework.getStore().isClosed(), false, 'the tick is still held');
        strategy.release();
        await framework.stop();
        assert.equal(strategy.storeOpenAtFirstTickEnd, true, 'the tick ended before the store closed');
        assert.equal(framework.getStore().isClosed(), true, 'a later stop() closes the store');
      } finally {
        console.error = quiet;
        strategy.release();
        await framework.stop().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a regular pass's tick held past a stop(t)'s budget: a later stop(t) waits for it again", { timeout: 20_000 }, async () => {
      // start() runs the first pass at once; the interval never fires here.
      const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-pass-stop-budget-'));
      const strategy = new GatedTickStrategy();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane,
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 60_000,
      });
      strategy.framework = framework;
      const quiet = console.error;
      console.error = () => {};
      try {
        framework.start();
        await waitFor(() => strategy.ticks === 1);
        const outcome = await stopWithin(framework, 100);
        assert.ok(maintenancePending(outcome), String(outcome));
        const again = await stopWithin(framework, 100);
        assert.ok(maintenancePending(again), `a later stop() waits for the pass still held: ${String(again)}`);
        assert.equal(framework.getStore().isClosed(), false, 'the tick is still held');
        strategy.release();
        await framework.stop();
        assert.equal(strategy.storeOpenAtFirstTickEnd, true, 'the tick ended before the store closed');
        assert.equal(framework.getStore().isClosed(), true, 'a later stop() closes the store');
      } finally {
        console.error = quiet;
        strategy.release();
        await framework.stop().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('no pass starts while a surgery holds the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-surgery-hold-'));
    const strategy = new QueuedStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const internals = framework as unknown as {
      surgeryHold: { verb: string; agentName: string; since: number } | null;
      runQueuedMaintenance: () => Promise<void>;
    };
    internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
    // Count the passes the timer starts while the store is held.
    let passes = 0;
    const runPass = internals.runQueuedMaintenance.bind(framework);
    internals.runQueuedMaintenance = () => { passes++; return runPass(); };
    try {
      framework.start();
      await waitFor(() => passes >= 3);
      assert.equal(strategy.ticks, 0);
      assert.equal(framework.getContextMaintenanceSnapshot().history.length, 0);
      internals.surgeryHold = null;
      await waitFor(() => strategy.ticks >= 2);
    } finally {
      internals.surgeryHold = null;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pass starts no new tick once a surgery holds the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-surgery-mid-pass-'));
    const strategy = new HookedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const internals = framework as unknown as { surgeryHold: { verb: string; agentName: string; since: number } | null };
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event.kind); });
    strategy.onTick = () => {
      internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
    };
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = firstPass(framework).agents[0];
      assert.equal(strategy.ticks, 1);
      assert.equal(run.ticks, 1);
      assert.equal(run.error, undefined);
      // The surgery waits for the pass before it switches, so reading the
      // agent's readiness after its tick is safe.
      assert.equal(run.readyAfter, false);
      assert.equal(run.pendingAfter, 'hooked tick queued');
      assert.deepEqual(alerts, []);
    } finally {
      internals.surgeryHold = null;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failure a pass meets while a surgery waits for it is reported as any failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-surgery-failure-'));
    const strategy = new HookedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    const internals = framework as unknown as { surgeryHold: { verb: string; agentName: string; since: number } | null };
    const alerts: string[] = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event.kind); });
    strategy.onTick = () => {
      internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
      throw new Error('the tick failed while a surgery waited');
    };
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = firstPass(framework).agents[0];
      assert.equal(run.ticks, 0);
      assert.equal(run.error, 'the tick failed while a surgery waited');
      assert.deepEqual(alerts, ['context-maintenance-failed']);
      assert.ok(logged.some((line) =>
        line.includes('[context-maintenance] agent=agent failed:')
        && line.includes('the tick failed while a surgery waited')));
    } finally {
      console.error = consoleError;
      internals.surgeryHold = null;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pass that ends before its agent is ready records what is still pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-maintenance-pending-after-'));
    const strategy = new NeverReadyStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history.at(-1)!.agents[0];
      assert.equal(run.readyAfter, false);
      assert.equal(run.pendingBefore, 'never ready');
      assert.equal(run.pendingAfter, 'never ready');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
