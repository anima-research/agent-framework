import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
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
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  YieldingStream,
} from '@animalabs/membrane';
import {
  AgentFramework,
  ApiModule,
  type EventResponse,
  type Module,
  type ModuleContext,
  type ProcessEvent,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '../src/index.js';
import { createMockResponse, MockYieldingStream } from './helpers/mock-membrane.js';

class RejectInferenceMembrane {
  calls = 0;

  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls++;
    throw new Error('retired resident ran maintenance inference');
  }

  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.calls++;
    throw new Error('retired resident ran conversational inference');
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class AlwaysQueuedStrategy implements ContextStrategy {
  readonly name = 'always-queued-retirement-test';

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'would require model-authored maintenance' };
  }

  async tick(ctx: StrategyContext): Promise<void> {
    await ctx.membrane?.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'maintenance' }] }],
    } as unknown as NormalizedRequest);
  }

  select(
    _store: MessageStoreView,
    _log: ContextLogView,
    _budget: TokenBudget,
  ): ContextEntry[] {
    return [];
  }
}

class LiveOnlyModule implements Module {
  readonly name = 'resident';
  handled = 0;
  context: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.context = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  getLiveTools(agentName: string): ToolDefinition[] {
    return agentName === 'resident'
      ? [{ name: 'lifecycle', description: 'live only', inputSchema: { type: 'object' } }]
      : [];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.handled++;
    return { success: true, data: { ok: true } };
  }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
}

class RetiringLiveModule implements Module {
  readonly name = 'resident';
  handled = 0;
  framework: AgentFramework | null = null;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  getLiveTools(agentName: string): ToolDefinition[] {
    return agentName === 'resident'
      ? [{ name: 'lifecycle', description: 'retire now', inputSchema: { type: 'object' } }]
      : [];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.handled++;
    const retirement = this.framework!.retireResident('resident', 'live handler test');
    return { success: true, data: retirement };
  }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
}

class OrdinaryToolModule implements Module {
  readonly name = 'ordinary';
  handled = 0;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'act', description: 'ordinary tool', inputSchema: { type: 'object' } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.handled++;
    return { success: true, data: { ok: true } };
  }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
}

class LiveToolMembrane {
  calls = 0;
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> {
    throw new Error('unexpected complete');
  }
  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.calls++;
    return new MockYieldingStream([
      createMockResponse([{
        type: 'tool_use',
        id: 'live-call',
        name: 'resident--lifecycle',
        input: {},
      } as ContentBlock], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'live call completed' }]),
    ]);
  }
  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class LateNonStreamingMembrane {
  calls = 0;
  private resolveResponse!: (response: NormalizedResponse) => void;
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  }

  async stream(_request: NormalizedRequest, _options?: { signal?: AbortSignal }): Promise<NormalizedResponse> {
    this.calls++;
    this.markStarted();
    return new Promise<NormalizedResponse>((resolve) => { this.resolveResponse = resolve; });
  }

  finishLate(): void {
    this.resolveResponse(createMockResponse([{ type: 'text', text: 'late model output' }]));
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class CancellationIgnoringStream implements YieldingStream {
  cancelCalls = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  provideToolResults(): void { throw new Error('not waiting for tools'); }
  cancel(): void { this.cancelCalls++; }
  finishLate(): void { this.release(); }

  async *[Symbol.asyncIterator](): AsyncIterator<import('@animalabs/membrane').StreamEvent> {
    await this.released;
    yield {
      type: 'complete',
      response: createMockResponse([{ type: 'text', text: 'late streaming output' }]),
    } as import('@animalabs/membrane').StreamEvent;
  }
}

class LateStreamingMembrane {
  readonly stream = new CancellationIgnoringStream();
  readonly created: Promise<void>;
  private markCreated!: () => void;

  constructor() {
    this.created = new Promise<void>((resolve) => { this.markCreated = resolve; });
  }

  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.markCreated();
    return this.stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class ThrowingCancellationStream implements YieldingStream {
  cancelCalls = 0;
  onCancel: (() => void) | null = null;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  provideToolResults(): void { throw new Error('not waiting for tools'); }
  cancel(): void {
    this.cancelCalls++;
    this.onCancel?.();
    this.release();
    throw new Error('provider cancel failed');
  }
  finish(): void { this.release(); }

  async *[Symbol.asyncIterator](): AsyncIterator<import('@animalabs/membrane').StreamEvent> {
    await this.released;
    yield {
      type: 'complete',
      response: createMockResponse([{ type: 'text', text: 'completion after throwing cancel' }]),
    } as import('@animalabs/membrane').StreamEvent;
  }
}

class ThrowingCancellationMembrane {
  calls = 0;
  readonly stream = new ThrowingCancellationStream();
  readonly created: Promise<void>;
  private markCreated!: () => void;

  constructor() {
    this.created = new Promise<void>((resolve) => { this.markCreated = resolve; });
  }

  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.calls++;
    this.markCreated();
    return this.stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

/** cancel() throws WITHOUT releasing the iterator — the provider behavior the
 *  production comment allows, which ThrowingCancellationStream masks by
 *  releasing before it throws. */
class NonSettlingThrowingCancelStream implements YieldingStream {
  cancelCalls = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  provideToolResults(): void { throw new Error('not waiting for tools'); }
  cancel(): void {
    this.cancelCalls++;
    throw new Error('cancel failed before aborting provider');
  }
  finish(): void { this.release(); }

  async *[Symbol.asyncIterator](): AsyncIterator<import('@animalabs/membrane').StreamEvent> {
    await this.released;
    yield {
      type: 'complete',
      response: createMockResponse([{ type: 'text', text: 'output after unsettled cancel' }]),
    } as import('@animalabs/membrane').StreamEvent;
  }
}

class NonSettlingCancelMembrane {
  readonly stream = new NonSettlingThrowingCancelStream();
  readonly created: Promise<void>;
  private markCreated!: () => void;
  constructor() {
    this.created = new Promise<void>((resolve) => { this.markCreated = resolve; });
  }
  streamYielding(_request: NormalizedRequest): YieldingStream {
    this.markCreated();
    return this.stream;
  }
  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

describe('resident retirement', () => {
  it('seals through the neutral API, clears wake state, preserves history, and blocks restart inference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-resident-retirement-'));
    const storePath = join(dir, 'store');
    const sealPath = join(storePath, 'resident-retirements.jsonl');
    const membrane = new RejectInferenceMembrane();
    let framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [new ApiModule()],
      gate: { config: { policies: [], default: 'always' } },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });

    try {
      framework.getAgent('resident')!.getContextManager().addMessage(
        'User',
        [{ type: 'text', text: 'history survives' }],
      );
      const gate = (framework as unknown as {
        eventGate: {
          armSelfWake(agent: string, seconds: number): unknown;
          setSleep(seconds: number, note: string, agent: string): unknown;
          getSleepState(): unknown;
          selfWakeTimers: Map<string, unknown>;
        };
      }).eventGate;
      gate.armSelfWake('resident', 60);
      gate.setSleep(60, 'retirement test', 'resident');

      const result = framework.retireResident('resident', 'resident-authored test reason');
      assert.equal(result.status, 'retired');
      assert.equal(result.alreadyRetired, false);
      assert.equal(result.chronicleRecorded, true);
      assert.equal(gate.getSleepState(), null);
      assert.equal(gate.selfWakeTimers.has('resident'), false);
      assert.equal(framework.nudgeAgent('resident').ok, false);

      const exposedAgent = framework.getAgent('resident')!;
      await assert.rejects(
        exposedAgent.runInference([]),
        /inference is permanently disabled: resident retired/,
      );
      await assert.rejects(
        exposedAgent.startStream([]),
        /inference is permanently disabled: resident retired/,
      );
      assert.equal(membrane.calls, 0, 'public Agent methods cannot reach the provider after sealing');

      const repeat = framework.retireResident('resident', 'replacement reason');
      assert.equal(repeat.alreadyRetired, true);
      assert.equal(repeat.reason, 'resident-authored test reason');

      const seals = readFileSync(sealPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(seals.length, 1);
      assert.equal(seals[0].agentName, 'resident');
      assert.equal(seals[0].kind, 'resident-retired');

      const lifecycle = framework.getStore().getStateJson('framework/resident-lifecycle') as unknown[];
      assert.equal(lifecycle.length, 1);

      const before = await framework.getAgent('resident')!.compileContext();
      assert.match(JSON.stringify(before), /history survives/);
      const logged: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        for (let i = 0; i < 100; i++) {
          (framework as unknown as {
            addMessage(participant: string, content: Array<{ type: 'text'; text: string }>): void;
          }).addMessage('User', [{ type: 'text', text: 'must not append' }]);
        }
      } finally {
        console.error = originalError;
      }
      const after = await framework.getAgent('resident')!.compileContext();
      assert.doesNotMatch(JSON.stringify(after), /must not append/);
      const drops = logged.filter((line) => line.startsWith('[message-dropped] agent=resident reason=resident_retired'));
      assert.deepEqual(
        drops.map((line) => line.match(/dropped=(\d+)/)?.[1]),
        ['1', '100'],
        'the post-retirement drop is traced on the first append and every 100th, not per message',
      );

      await framework.stop();
      const reject = new RejectInferenceMembrane();
      framework = await AgentFramework.create({
        storePath,
        membrane: reject.asMembrane(),
        agents: [{
          name: 'resident',
          model: 'test-model',
          systemPrompt: 'test',
          strategy: new AlwaysQueuedStrategy(),
        }],
        modules: [new ApiModule()],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      await assert.rejects(
        framework.getAgent('resident')!.runInference([]),
        /inference is permanently disabled: resident retired/,
      );
      framework.start();
      framework.pushEvent({ type: 'api:message', participant: 'User', content: 'restart wake' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(reject.calls, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps live-only module tools off programmatic and puppet paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-live-tool-'));
    const membrane = new LiveToolMembrane();
    const liveModule = new LiveOnlyModule();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test' }],
      modules: [liveModule],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      const omittedCaller = await framework.executeToolCall({
        id: 'omitted-caller',
        name: 'resident--lifecycle',
        input: {},
      });
      assert.equal(omittedCaller.success, false);
      assert.match(omittedCaller.error ?? '', /provider-issued live agent stream/);

      const forgedCaller = await framework.executeToolCall({
        id: 'forged-caller',
        name: 'resident--lifecycle',
        callerAgentName: 'outsider',
        input: {},
      });
      assert.equal(forgedCaller.success, false);
      assert.match(forgedCaller.error ?? '', /provider-issued live agent stream/);
      assert.equal(liveModule.handled, 0, 'live-only names are globally reserved before preview');

      const moduleCall = await liveModule.context!.callTool({
        id: 'module-context-call',
        name: 'resident--lifecycle',
        input: {},
      });
      assert.equal(moduleCall.success, false);
      assert.match(moduleCall.error ?? '', /provider-issued live agent stream/);
      assert.equal(liveModule.handled, 0, 'trusted module provenance does not bypass live-only reservation');

      const preview = await framework.previewActivation('resident');
      assert.ok(preview.tools?.some((tool) => tool.name === 'resident--lifecycle'));
      const direct = await framework.executeToolCall({
        id: 'direct',
        name: 'resident--lifecycle',
        callerAgentName: 'resident',
        input: {},
      });
      assert.equal(direct.success, false);
      assert.match(direct.error ?? '', /provider-issued live agent stream/);
      await assert.rejects(
        framework.puppetToolCall('resident', 'resident--lifecycle', {}),
        /restricted to a provider-issued live stream/,
      );
      framework.nudgeAgent('resident', 'live-tool-test');
      await framework.runUntilIdle();
      assert.equal(membrane.calls, 1);
      assert.equal(liveModule.handled, 1, 'the same tool dispatches from a real resident stream');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminates the stream when the live tool handler applies retirement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-live-handler-retirement-'));
    const membrane = new LiveToolMembrane();
    const retiringModule = new RetiringLiveModule();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [retiringModule],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    retiringModule.framework = framework;
    try {
      framework.nudgeAgent('resident', 'live-handler-retirement-test');
      await framework.runUntilIdle();
      assert.equal(retiringModule.handled, 1);
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      assert.equal(membrane.calls, 1, 'the provider stream starts only once');
      const context = await framework.getAgent('resident')!.compileContext();
      assert.doesNotMatch(
        JSON.stringify(context),
        /live call completed/,
        'the second provider round is never resumed or persisted after the seal',
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies direct and puppet tool execution and history append after retirement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retired-tool-boundary-'));
    const ordinary = new OrdinaryToolModule();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new RejectInferenceMembrane().asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [ordinary],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      const beforeSeal = await framework.executeToolCall({
        id: 'before-seal',
        name: 'ordinary--act',
        callerAgentName: 'resident',
        input: {},
      });
      assert.equal(beforeSeal.success, true);
      assert.equal(ordinary.handled, 1);

      framework.retireResident('resident');
      const contextBefore = await framework.getAgent('resident')!.compileContext();
      const direct = await framework.executeToolCall({
        id: 'after-seal',
        name: 'ordinary--act',
        callerAgentName: 'resident',
        input: {},
      });
      assert.equal(direct.success, false);
      assert.match(direct.error ?? '', /terminal and cannot execute tools/);
      await assert.rejects(
        framework.puppetToolCall('resident', 'ordinary--act', {}),
        /agent resident is terminal/,
      );
      assert.equal(ordinary.handled, 1, 'no post-seal handler invocation');
      const contextAfter = await framework.getAgent('resident')!.compileContext();
      assert.deepEqual(contextAfter.messages, contextBefore.messages, 'puppet appends no forged history');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts in-flight public inference and discards a provider response that ignores cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retired-running-inference-'));
    const membrane = new LateNonStreamingMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      const pending = framework.getAgent('resident')!.runInference([]);
      await membrane.started;
      framework.retireResident('resident');
      membrane.finishLate();
      const result = await pending;
      assert.equal(result.aborted, true);
      assert.equal(result.abortReason, 'resident retired');
      const context = await framework.getAgent('resident')!.compileContext();
      assert.doesNotMatch(JSON.stringify(context), /late model output/);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels the sealing stream and ignores buffered completion events after retirement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retired-running-stream-'));
    const membrane = new LateStreamingMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      framework.start();
      framework.nudgeAgent('resident', 'active-stream-retirement-test');
      await membrane.created;
      framework.retireResident('resident');
      assert.equal(membrane.stream.cancelCalls, 1, 'retirement cancels the active yielding stream');
      membrane.stream.finishLate();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const context = await framework.getAgent('resident')!.compileContext();
      assert.doesNotMatch(JSON.stringify(context), /late streaming output/);
    } finally {
      membrane.stream.finishLate();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() completes when a provider cancel() throws without settling its iterator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retired-unsettled-cancel-'));
    const membrane = new NonSettlingCancelMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      framework.start();
      framework.nudgeAgent('resident', 'unsettled-cancel-retirement-test');
      await membrane.created;
      // Let the framework register the iteration handle in activeStreams.
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok((framework as unknown as { activeStreams: Map<string, unknown> }).activeStreams.has('resident'));
      assert.throws(() => framework.retireResident('resident'), /cancel failed before aborting provider/);
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      assert.equal(framework.getAgent('resident')!.state.status, 'idle');
      assert.equal(membrane.stream.cancelCalls, 1);

      // The iterator is still pending. stop() must settle anyway.
      const outcome = await Promise.race([
        framework.stop().then(() => 'stopped'),
        new Promise((resolve) => setTimeout(() => resolve('timed-out'), 2000)),
      ]);
      assert.equal(outcome, 'stopped', 'framework.stop() must not wait on an iterator the provider failed to cancel');
    } finally {
      membrane.stream.finish();
      await framework.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminates existing conversation forks and refuses new ones after template retirement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retired-template-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new RejectInferenceMembrane().asMembrane(),
      agents: [{
        name: 'template',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      conversations: { templateAgent: 'template' },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      const oldFork = await (framework as unknown as {
        createConversationAgent(name: string, channel: string): Promise<unknown>;
      }).createConversationAgent('conversation-dm-g1', 'dm') as {
        runInference(tools: ToolDefinition[]): Promise<unknown>;
      };
      assert.ok(framework.getAgent('conversation-dm-g1'));
      assert.equal(framework.nudgeAgent('conversation-dm-g1').ok, true);

      framework.retireResident('template');
      assert.equal(framework.getAgent('conversation-dm-g1'), null);
      const oldForkNudge = framework.nudgeAgent('conversation-dm-g1');
      assert.equal(oldForkNudge.ok, false);
      assert.match(oldForkNudge.error ?? '', /terminated when its template resident retired/);
      await assert.rejects(
        oldFork.runInference([]),
        /inference is permanently disabled: template resident retired/,
      );
      const oldForkTool = await framework.executeToolCall({
        id: 'old-fork-tool',
        name: 'unknown--tool',
        callerAgentName: 'conversation-dm-g1',
        input: {},
      });
      assert.equal(oldForkTool.success, false);
      assert.match(oldForkTool.error ?? '', /terminal and cannot execute tools/);
      await assert.rejects(
        (framework as unknown as {
          createConversationAgent(name: string, channel: string): Promise<unknown>;
        }).createConversationAgent('conversation-dm-g2', 'dm'),
        /template resident "template" is retired/,
      );
      assert.equal(framework.getAgent('conversation-dm-g2'), null);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminalizes every fork before surfacing a provider cancellation failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retirement-throwing-cancel-'));
    const storePath = join(dir, 'store');
    const membrane = new ThrowingCancellationMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'template',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      conversations: { templateAgent: 'template' },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      const oldFork = await (framework as unknown as {
        createConversationAgent(name: string, channel: string): Promise<unknown>;
      }).createConversationAgent('conversation-dm-throwing', 'dm') as {
        runInference(tools: ToolDefinition[]): Promise<unknown>;
      };
      const reentrantForkNudge: {
        result: ReturnType<AgentFramework['nudgeAgent']> | null;
      } = { result: null };
      membrane.stream.onCancel = () => {
        reentrantForkNudge.result = framework.nudgeAgent('conversation-dm-throwing');
      };

      framework.start();
      framework.nudgeAgent('template', 'throwing-cancel-retirement-test');
      await membrane.created;
      assert.throws(
        () => framework.retireResident('template'),
        /provider cancel failed/,
      );

      assert.equal(membrane.stream.cancelCalls, 1);
      assert.equal(
        reentrantForkNudge.result?.ok,
        false,
        'fork is terminal before provider cancellation',
      );
      assert.match(
        reentrantForkNudge.result?.error ?? '',
        /terminated when its template resident retired/,
      );
      assert.equal(framework.getResidentLifecycleStatus('template').status, 'retired');
      assert.equal(framework.getAgent('template')!.state.status, 'idle');
      assert.equal(framework.getAgent('conversation-dm-throwing'), null);
      assert.match(
        framework.nudgeAgent('conversation-dm-throwing').error ?? '',
        /terminated when its template resident retired/,
      );
      await assert.rejects(
        oldFork.runInference([]),
        /inference is permanently disabled: template resident retired/,
      );
      assert.equal(membrane.calls, 1, 'the retained fork cannot reach the provider');

      const seals = readFileSync(
        join(storePath, 'resident-retirements.jsonl'),
        'utf8',
      ).trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(seals.map((record) => record.agentName), ['template']);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const context = await framework.getAgent('template')!.compileContext();
      assert.doesNotMatch(JSON.stringify(context), /completion after throwing cancel/);
    } finally {
      membrane.stream.finish();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects every invalid persisted identity before opening the store', async () => {
    const invalidNames = ['', ' resident ', 'resident\n'];
    for (const [index, name] of invalidNames.entries()) {
      const dir = mkdtempSync(join(tmpdir(), `af-retirement-invalid-name-${index}-`));
      const storePath = join(dir, 'store');
      try {
        await assert.rejects(
          AgentFramework.create({
            storePath,
            membrane: new RejectInferenceMembrane().asMembrane(),
            agents: [{
              name,
              model: 'test-model',
              systemPrompt: 'test',
              retirement: { enabled: true },
            }],
            modules: [],
          }),
          /Invalid persisted resident identity/,
        );
        assert.equal(fs.existsSync(storePath), false, 'validation precedes store creation');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('fails closed on torn, malformed, semantically invalid, and duplicate seal records', async () => {
    const cases = [
      { name: 'torn', content: '{"version":1', message: /incomplete final record/ },
      { name: 'malformed', content: '{not json}\n', message: /Invalid retirement seal/ },
      {
        name: 'invalid',
        content: '{"version":1,"kind":"resident-retired","agentName":"resident","retiredAt":1,"reason":7}\n',
        message: /invalid retirement record/,
      },
      {
        name: 'duplicate',
        content:
          '{"version":1,"kind":"resident-retired","agentName":"resident","retiredAt":1}\n' +
          '{"version":1,"kind":"resident-retired","agentName":"resident","retiredAt":2}\n',
        message: /invalid retirement record/,
      },
      {
        name: 'empty-agent-name',
        content: `${JSON.stringify({
          version: 1,
          kind: 'resident-retired',
          agentName: '',
          retiredAt: 1,
        })}\n`,
        message: /invalid retirement record/,
      },
      {
        name: 'padded-agent-name',
        content: `${JSON.stringify({
          version: 1,
          kind: 'resident-retired',
          agentName: ' resident ',
          retiredAt: 1,
        })}\n`,
        message: /invalid retirement record/,
      },
      {
        name: 'control-character-agent-name',
        content: `${JSON.stringify({
          version: 1,
          kind: 'resident-retired',
          agentName: 'resident\n',
          retiredAt: 1,
        })}\n`,
        message: /invalid retirement record/,
      },
    ];
    for (const testCase of cases) {
      const dir = mkdtempSync(join(tmpdir(), `af-retirement-${testCase.name}-`));
      const storePath = join(dir, 'store');
      const seed = await AgentFramework.create({
        storePath,
        membrane: new RejectInferenceMembrane().asMembrane(),
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test' }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 0,
      });
      await seed.stop();
      mkdirSync(storePath, { recursive: true });
      writeFileSync(join(storePath, 'resident-retirements.jsonl'), testCase.content);
      try {
        await assert.rejects(
          AgentFramework.create({
            storePath,
            membrane: new RejectInferenceMembrane().asMembrane(),
            agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test' }],
            modules: [],
          }),
          testCase.message,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('durably creates a nested sidecar before appending later resident records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retirement-durable-create-'));
    const storePath = join(dir, 'store');
    const retirementPath = join(dir, 'new', 'nested', 'resident-retirements.jsonl');
    const framework = await AgentFramework.create({
      storePath,
      retirementPath,
      membrane: new RejectInferenceMembrane().asMembrane(),
      agents: [
        { name: 'first', model: 'test-model', systemPrompt: 'test', retirement: { enabled: true } },
        { name: 'second', model: 'test-model', systemPrompt: 'test', retirement: { enabled: true } },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      framework.retireResident('first');
      let records = readFileSync(retirementPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => record.agentName), ['first']);

      framework.retireResident('second');
      records = readFileSync(retirementPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => record.agentName), ['first', 'second']);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed if directory durability syncing throws after the seal file is fsynced', {
    skip: process.platform === 'win32',
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-retirement-durability-error-'));
    const storePath = join(dir, 'store');
    const retirementPath = join(dir, 'new', 'nested', 'resident-retirements.jsonl');
    const membrane = new RejectInferenceMembrane();
    const framework = await AgentFramework.create({
      storePath,
      retirementPath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident',
        model: 'test-model',
        systemPrompt: 'test',
        retirement: { enabled: true },
      }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const originalFsyncSync = fs.fsyncSync;
    let fsyncCalls = 0;
    fs.fsyncSync = ((fd: number) => {
      originalFsyncSync(fd);
      fsyncCalls++;
      if (fsyncCalls === 2) {
        throw new Error('injected directory-fsync failure');
      }
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => framework.retireResident('resident'),
        /injected directory-fsync failure/,
      );
      assert.equal(fsyncCalls, 2, 'file fsync succeeded before the directory failure');
      const seals = readFileSync(retirementPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(seals.map((record) => record.agentName), ['resident']);
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      await assert.rejects(
        framework.getAgent('resident')!.runInference([]),
        /inference is permanently disabled: resident retired/,
      );
      assert.equal(membrane.calls, 0, 'an ambiguous seal outcome cannot reach the provider');
    } finally {
      fs.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a branch-independent seal path for app-owned stores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-resident-retirement-owned-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    try {
      await assert.rejects(
        AgentFramework.create({
          store,
          membrane: new RejectInferenceMembrane().asMembrane(),
          agents: [{
            name: 'resident',
            model: 'test-model',
            systemPrompt: 'test',
            retirement: { enabled: true },
          }],
          modules: [],
        }),
        /app-owned store without retirementPath/,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
