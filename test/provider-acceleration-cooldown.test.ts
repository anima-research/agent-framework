import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class InputModule implements Module {
  readonly name = 'input';
  private ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class AccelerationThenSuccessMembrane extends MockMembrane {
  private n = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.n++;
    if (this.n === 1) {
      return new ErrorStream(new MembraneError({
        type: 'rate_limit', retryable: true, httpStatus: 429,
        message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
        rawError: { status: 429 }, rawRequest: request,
      }));
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'recovered' }])]);
  }
}


class GenericRateLimitThenSuccessMembrane extends MockMembrane {
  private n = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request); this.n++;
    if (this.n === 1) return new ErrorStream(new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's rate limit for input tokens per minute; retry after 1", retryAfterMs: 1,
      rawError: { status: 429 }, rawRequest: request,
    }));
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'ordinary retry' }])]);
  }
}

class AlwaysSuccessMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'ok' }])]);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function textOf(request: NormalizedRequest): string {
  return request.messages.flatMap((m) => m.content)
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text).join('\n');
}

test('organization acceleration 429 defers one fresh compile, includes arrivals, and avoids failure breaker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-cooldown-'));
  const membrane = new AccelerationThenSuccessMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = framework as unknown as {
    providerAccelerationDefaultCooldownMs: number;
    providerAccelerationJitterMs: number;
    consecutiveInferenceFailures: Map<string, number>;
    providerAccelerationCooldowns: Map<string, { heldRequests: unknown[] }>;
    providerAccelerationLastRecovery: Map<string, {
      waitedMs: number; cooldownMs: number; heldRequests: number; messageCount: number; stopReason: string;
    }>;
  };
  internal.providerAccelerationDefaultCooldownMs = 1_000;
  internal.providerAccelerationJitterMs = 0;
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} });
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'no immediate same-window retry');
    assert.equal(internal.consecutiveInferenceFailures.get('resident') ?? 0, 0, 'capacity does not enter hard-down streak');
    assert.equal(internal.providerAccelerationCooldowns.size, 1);

    framework.pushEvent({ type: 'external-message', source: 'test', content: 'arrived during cooldown', metadata: {} });
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'new arrival is held, not separately inferred');
    assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2);

    await sleep(1_100);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'one deferred primary attempt');
    assert.match(textOf(membrane.calls[1]!), /first/);
    assert.match(textOf(membrane.calls[1]!), /arrived during cooldown/);

    const messages = framework.getAgent('resident')!.getContextManager().queryMessages({}).messages;
    const failed = messages.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
    const authoredReceipt = messages.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'provider-acceleration-recovered');
    assert.equal(failed.length, 0, 'no poisoned-history/failure marker');
    assert.equal(authoredReceipt.length, 0, 'provider admission never authors resident memory');
    const recovery = internal.providerAccelerationLastRecovery.get('resident');
    assert.ok(recovery, 'operational recovery receipt is exposed outside Chronicle');
    assert.ok(recovery.waitedMs >= recovery.cooldownMs);
    assert.equal(recovery.heldRequests, 2);
    assert.ok(recovery.messageCount > 0);
    assert.equal(recovery.stopReason, 'end_turn');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dynamic conversation forks are excluded from provider cooldown ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-conversation-'));
  const membrane = new AccelerationThenSuccessMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = framework as unknown as {
    conversationAgentHomes: Map<string, string>;
    providerAccelerationCooldowns: Map<string, unknown>;
    providerGates: Map<string, unknown>;
    holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown): boolean;
  };
  internal.conversationAgentHomes.set('resident', 'world:test');
  try {
    const error = new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429,
      message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
      rawError: { status: 429 },
    });
    const held = internal.holdProviderAcceleration(framework.getAgent('resident')!, error, {
      agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now(),
    });
    assert.equal(held, false, 'conversation fork retains its existing provider policy');
    assert.equal(internal.providerAccelerationCooldowns.size, 0);
    assert.equal(internal.providerGates.size, 0, 'generation-unique conversation name allocates no provider gate');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a resident waiting behind auxiliary work does not block another resident', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-cross-agent-'));
  const membrane = new AlwaysSuccessMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [
      { name: 'resident', model: 'test-model', systemPrompt: 'system' },
      { name: 'other', model: 'test-model', systemPrompt: 'system' },
    ],
    modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = framework as unknown as {
    withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
    startAgentStream(agent: unknown): Promise<void>;
  };
  let finish!: () => void;
  const auxiliary = internal.withAuxiliaryAdmission('resident', () => new Promise<void>((resolve) => {
    finish = resolve;
  }));
  try {
    await internal.startAgentStream(framework.getAgent('resident')!);
    await internal.startAgentStream(framework.getAgent('other')!);
    await sleep(20);
    assert.equal(membrane.calls.length, 1, 'the other resident reaches the provider while the first waits');
    finish();
    await auxiliary;
    await sleep(20);
    assert.equal(membrane.calls.length, 2, 'the waiting resident resumes after auxiliary settlement');
  } finally {
    finish();
    await auxiliary;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shutdown aborts a primary waiting behind in-flight auxiliary work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-stop-aux-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = framework as unknown as {
    withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
  };
  let finish!: () => void;
  const auxiliary = internal.withAuxiliaryAdmission('resident', () => new Promise<void>((resolve) => {
    finish = resolve;
  }));
  let stopped = false;
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} });
    const draining = framework.runUntilIdle();
    await sleep(20);
    assert.equal(membrane.calls.length, 0, 'primary waits behind the admitted auxiliary');
    await Promise.race([
      framework.stop().then(() => { stopped = true; }),
      sleep(250).then(() => { throw new Error('shutdown left the primary waiting behind auxiliary work'); }),
    ]);
    await draining;
    assert.equal(membrane.calls.length, 0, 'shutdown does not start a late primary against the closed store');
  } finally {
    finish();
    await auxiliary;
    if (!stopped) await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary 429 keeps the existing retry policy instead of entering acceleration cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-generic-'));
  const membrane = new GenericRateLimitThenSuccessMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'ordinary', metadata: {} });
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2);
    const internal = framework as unknown as { providerAccelerationCooldowns: Map<string, unknown> };
    assert.equal(internal.providerAccelerationCooldowns.size, 0);
  } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('local provider gate settles in-flight auxiliary work and parks later auxiliary admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-provider-gate-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }], modules: [],
    syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = framework as unknown as {
    acquirePrimaryProviderGate(name: string): void;
    releasePrimaryProviderGate(name: string): void;
    waitForAuxiliaryIdle(name: string): Promise<void>;
    withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
    providerGates: Map<string, { deferredAuxiliary: number }>;
  };
  try {
    let finish!: () => void;
    const inFlight = internal.withAuxiliaryAdmission('resident', () => new Promise<number>((resolve) => {
      finish = () => resolve(3);
    }));
    internal.acquirePrimaryProviderGate('resident');
    let primaryReady = false;
    const wait = internal.waitForAuxiliaryIdle('resident').then(() => { primaryReady = true; });
    let laterRan = false;
    const later = internal.withAuxiliaryAdmission('resident', async () => { laterRan = true; return 7; });
    await sleep(10);
    assert.equal(primaryReady, false, 'primary observes the already in-flight auxiliary');
    assert.equal(laterRan, false, 'new auxiliary is parked');
    finish();
    assert.equal(await inFlight, 3);
    await wait;
    assert.equal(primaryReady, true);
    assert.equal(laterRan, false, 'parked auxiliary still waits for primary settlement');
    internal.releasePrimaryProviderGate('resident');
    assert.equal(await later, 7);
    assert.equal(internal.providerGates.get('resident')?.deferredAuxiliary, 0, 'completed wait no longer reports backlog');

    // The real Context Manager door is the wrapped auxiliary Membrane, not
    // merely the helper tested above.
    internal.acquirePrimaryProviderGate('resident');
    const cm = framework.getAgent('resident')!.getContextManager() as unknown as {
      membrane: { complete(request: NormalizedRequest): Promise<unknown> };
    };
    const request = {
      messages: [], tools: [], config: { model: 'test-model', maxTokens: 16 },
    } as unknown as NormalizedRequest;
    const before = membrane.calls.length;
    const throughCm = cm.membrane.complete(request);
    await sleep(10);
    assert.equal(membrane.calls.length, before, 'Context Manager provider call is parked');
    internal.releasePrimaryProviderGate('resident');
    await throughCm;
    assert.equal(membrane.calls.length, before + 1, 'Context Manager call resumes once');
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
