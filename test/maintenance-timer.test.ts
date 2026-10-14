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
import { AgentFramework } from '../src/index.js';
import { OperatorActionError } from '../src/operator-log.js';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';

class QueuedStrategy implements ContextStrategy {
  readonly name = 'queued-test';
  ticks = 0;
  toolCounts: number[] = [];
  thinkDescriptions: string[] = [];

  checkReadiness(): ReadinessState {
    return { ready: this.ticks >= 2, description: 'test maintenance queued' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    this.toolCounts.push(ctx.tools?.length ?? 0);
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
      // Module tool + synthesized agent_settings are both supplied to
      // maintenance/compression requests.
      assert.deepEqual(strategy.toolCounts, [2, 2]);
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
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, message, data: opts?.data });

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
      // Every pass meets the same failure and records it; it is alerted once.
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 3);
      for (const run of framework.getContextMaintenanceSnapshot().history) {
        assert.equal(run.agents[0].error, 'provider rejected maintenance request');
      }
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
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });

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
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });

    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history[0].agents[0];
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
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });

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
    (framework as any).opsAlert = (
      kind: string,
      agentName: string,
      _message: string,
      opts?: { data?: Record<string, unknown> },
    ) => alerts.push({ kind, agentName, data: opts?.data });
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
    (framework as any).opsAlert = (kind: string, agentName: string) => alerts.push(`${kind}:${agentName}`);
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
      await waitFor(() => runsWithError() >= 3);
      assert.deepEqual(alerts, ['context-maintenance-failed:fenced']);
      assert.equal(failedLines(), 1);

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
    (framework as any).opsAlert = (_kind: string, _agentName: string, text: string) => alerts.push(text);
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

      // Unchanged, it is alerted again once the cooldown has passed.
      internals.opsAlertCooldownMs = 0;
      await waitFor(() => alerts.length >= 5);
      assert.ok(alerts.slice(3).every((text) => text === long('two')));
    } finally {
      console.error = quiet;
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
    (framework as any).opsAlert = (kind: string, agentName: string, message: string) => alerts.push(`${kind}:${agentName}:${message}`);
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history[0].agents[0];
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
    (framework as any).opsAlert = (kind: string, agentName: string, message: string) => alerts.push(`${kind}:${agentName}:${message}`);
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history[0].agents[0];
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
    (framework as any).opsAlert = (kind: string) => alerts.push(kind);
    strategy.onTick = () => {
      internals.surgeryHold = { verb: 'rollback', agentName: 'agent', since: Date.now() };
    };
    try {
      framework.start();
      await waitFor(() => framework.getContextMaintenanceSnapshot().history.length >= 1);
      const run = framework.getContextMaintenanceSnapshot().history[0].agents[0];
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
    (framework as any).opsAlert = (kind: string) => alerts.push(kind);
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
      const run = framework.getContextMaintenanceSnapshot().history[0].agents[0];
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
      assert.equal(run.ticks, 8);
      assert.equal(run.readyAfter, false);
      assert.equal(run.pendingBefore, 'never ready');
      assert.equal(run.pendingAfter, 'never ready');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
