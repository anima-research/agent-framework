import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Module, ModuleContext, ProcessEvent, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

class HeartbeatModule implements Module {
  readonly name = 'mcpl';
  calls = 0;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'heartbeat--heartbeat_status', description: 'Read heartbeat status', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { this.calls++; return { success: true, data: { ok: true } }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: [{ type: 'text', text: 'check' }] }], requestInference: true };
  }
}

class ToolThenErrorStream implements YieldingStream {
  private events: StreamEvent[] = [{
    type: 'tool-calls',
    calls: [{ id: 'toolu_retry', name: 'mcpl--heartbeat--heartbeat_status', input: {} }],
    context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [{ type: 'tool_use', id: 'toolu_retry', name: 'mcpl--heartbeat--heartbeat_status', input: {} }] },
  } as StreamEvent];
  private wake: (() => void) | null = null; private done = false;
  get isWaitingForTools() { return !this.done; } get pendingToolCallIds() { return this.done ? [] : ['toolu_retry']; } get toolDepth() { return 0; }
  provideToolResults(): void { this.done = true; this.events.push({ type: 'error', error: new Error('retry after tool') } as StreamEvent); this.wake?.(); this.wake = null; }
  cancel(): void { this.done = true; this.wake?.(); this.wake = null; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) { while (this.events.length) yield this.events.shift()!; if (this.done) return; await new Promise<void>((r) => { this.wake = r; }); }
  }
}
class SequentialStreamMembrane {
  calls = 0;
  constructor(readonly responses: NormalizedResponse[]) {}
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> { return this.responses[Math.min(this.calls++, this.responses.length - 1)]!; }
  streamYielding(_request: NormalizedRequest): YieldingStream { return new MockYieldingStream([this.responses[Math.min(this.calls++, this.responses.length - 1)]!]); }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

class ToolThenFrameworkRetryMembrane {
  calls = 0;
  readonly final = createMockResponse([{ type: 'text', text: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>' }] as ContentBlock[]);
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> { return this.final; }
  streamYielding(_request: NormalizedRequest): YieldingStream { return this.calls++ === 0 ? new ToolThenErrorStream() : new MockYieldingStream([this.final]); }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

class RetryingWrapperMembrane {
  readonly response = createMockResponse([{ type: 'text', text: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>' }] as ContentBlock[]);
  async complete(_request: NormalizedRequest): Promise<NormalizedResponse> { return this.response; }
  streamYielding(_request: NormalizedRequest): YieldingStream {
    const response = this.response;
    return {
      isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0,
      provideToolResults: () => { throw new Error('not waiting for tools'); }, cancel: () => {},
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        yield { type: 'tokens', content: '<mcpl--heartbeat--heartbeat_status>', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
        yield { type: 'retrying', attempt: 1, maxAttempts: 1, reason: 'refusal', category: 'test' } as StreamEvent;
        yield { type: 'tokens', content: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
        yield { type: 'complete', response } as StreamEvent;
      },
    } as YieldingStream;
  }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

async function run(enabled?: boolean, allowedTools?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-')); dirs.push(dir);
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>' }] as ContentBlock[]));
  const module = new HeartbeatModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'sys', toolWrapperProseGuard: enabled, ...(allowedTools ? { allowedTools } : {}) }],
    modules: [module],
  });
  const routed: string[] = [];
  const outgoing: string[] = [];
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
    resolveLocus: () => 'world:test',
    routeSpeech: async (_agent: string, speech: string) => { routed.push(speech); return { delivered: true, channelId: 'world:test' }; },
    sendOutgoingChunk: (_channel: string, _agent: string, _id: string, _index: number, delta: string) => { outgoing.push(delta); },
    getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
  }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
  await framework.runUntilIdle();
  const all = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
  await framework.stop();
  return { routed, outgoing, all, module };
}

class LateToolAfterIdleMembrane {
  streamYielding(): YieldingStream {
    return {
      isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0,
      provideToolResults: () => {}, cancel: () => {},
      async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        yield { type: 'tokens', content: 'starting', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield { type: 'tool-calls', calls: [{ id: 'late', name: 'mcpl--heartbeat--heartbeat_status', input: {} }], context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [{ type: 'tool_use', id: 'late', name: 'mcpl--heartbeat--heartbeat_status', input: {} }] } } as StreamEvent;
        yield { type: 'complete', response: createMockResponse([{ type: 'text', text: 'late' }]) } as StreamEvent;
      },
    } as YieldingStream;
  }
  async complete(): Promise<NormalizedResponse> { throw new Error('not used'); }
  asMembrane(): import('@animalabs/membrane').Membrane { return this as unknown as import('@animalabs/membrane').Membrane; }
}

describe('tool wrapper prose guard integration', () => {
  it('default-off preserves and routes wrapper prose', async () => {
    const { routed, outgoing, all } = await run();
    assert.deepEqual(routed, ['<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>']);
    assert.equal(outgoing.join(''), '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>', 'default-off mutation exposes the wrapper on outgoing preview');
    assert.ok(all.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('<mcpl--heartbeat--heartbeat_status>'))));
  });
  it('does not claim authority for a globally registered but request-disallowed tool', async () => {
    const { routed, all, module } = await run(true, ['some--other']);
    assert.deepEqual(routed, ['<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>']);
    assert.equal(module.calls, 0);
    assert.ok(!all.some((m) => m.metadata?.kind === 'tool-wrapper-prose-contained'));
  });

  it('buffers abandoned retry tokens and contains only the final wrapper response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-retry-')); dirs.push(dir);
    const module = new HeartbeatModule(); const membrane = new RetryingWrapperMembrane();
    const routed: string[] = []; const outgoing: string[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'sys', toolWrapperProseGuard: true }], modules: [module],
    });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test', routeSpeech: async (_a: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:test' }; },
      sendOutgoingChunk: (_c: string, _a: string, _id: string, _i: number, delta: string) => { outgoing.push(delta); },
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
    }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const all = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    await framework.stop();
    assert.deepEqual(routed, []); assert.deepEqual(outgoing, []); assert.equal(module.calls, 0);
    assert.equal(all.filter((m) => m.metadata?.kind === 'tool-wrapper-prose-contained').length, 1);
    assert.ok(!all.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('<mcpl--heartbeat--heartbeat_status>'))));
  });

  it('preserves structured-tool history across a framework error retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-framework-retry-')); dirs.push(dir);
    const module = new HeartbeatModule(); const membrane = new ToolThenFrameworkRetryMembrane(); const routed: string[] = [];
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [{ name: 'assistant', model: 'test', systemPrompt: 'sys', toolWrapperProseGuard: true }], modules: [module] });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test', routeSpeech: async (_a: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:test' }; },
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
    }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent); await framework.runUntilIdle();
    const all = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    await framework.stop();
    assert.equal(module.calls, 1); assert.equal(membrane.calls, 2); assert.deepEqual(routed, ['<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>']);
    assert.ok(!all.some((m) => m.metadata?.kind === 'tool-wrapper-prose-contained'));
  });

  it('preserves structured-tool history across a context-budget restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-budget-restart-')); dirs.push(dir);
    const module = new HeartbeatModule(); const routed: string[] = [];
    const membrane = new SequentialStreamMembrane([
      createMockResponse([{ type: 'tool_use', id: 'toolu_budget', name: 'mcpl--heartbeat--heartbeat_status', input: {} }] as ContentBlock[]),
      createMockResponse([{ type: 'text', text: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>' }] as ContentBlock[]),
    ]);
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [{ name: 'assistant', model: 'test', systemPrompt: 'sys', maxStreamTokens: 1, toolWrapperProseGuard: true }], modules: [module] });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test', routeSpeech: async (_a: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:test' }; },
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
    }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent); await framework.runUntilIdle();
    const all = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    await framework.stop();
    assert.equal(module.calls, 1); assert.equal(membrane.calls, 2); assert.deepEqual(routed, ['<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>']);
    assert.ok(!all.some((m) => m.metadata?.kind === 'tool-wrapper-prose-contained'));
  });

  it('buffers then delivers ordinary prose when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-ordinary-')); dirs.push(dir);
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Ordinary answer.' }] as ContentBlock[]));
    const routed: string[] = []; const outgoing: string[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'sys', toolWrapperProseGuard: true }], modules: [new HeartbeatModule()],
    });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test',
      routeSpeech: async (_agent: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:test' }; },
      sendOutgoingChunk: (_channel: string, _agent: string, _id: string, _index: number, delta: string) => { outgoing.push(delta); },
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
    }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
    (framework as unknown as Record<string, unknown>).channelEventModule = { getChannelId: () => 'world:test' };
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const all = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    await framework.stop();
    assert.deepEqual(routed, ['Ordinary answer.']);
    assert.deepEqual(outgoing, [], 'guarded turns buffer ordinary prose until completion');
    assert.ok(all.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'Ordinary answer.')));
    assert.ok(!all.some((m) => m.metadata?.kind === 'tool-wrapper-prose-contained'));
  });

  it('does not reinterpret wrapper-shaped trailing prose after a genuine structured tool call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-tool-')); dirs.push(dir);
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{
      type: 'tool_use', id: 'toolu_1', name: 'mcpl--heartbeat--heartbeat_status', input: {},
    }] as ContentBlock[]));
    membrane.pushResponse(createMockResponse([{
      type: 'text', text: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>',
    }] as ContentBlock[]));
    const module = new HeartbeatModule(); const routed: string[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'sys', toolWrapperProseGuard: true }],
      modules: [module],
    });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test', routeSpeech: async (_a: string, text: string) => { routed.push(text); return { delivered: true, channelId: 'world:test' }; },
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
    }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const all = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{ content: ContentBlock[]; metadata?: Record<string, unknown> }>;
    await framework.stop();
    assert.equal(module.calls, 1, 'genuine structured tool executes exactly once');
    assert.deepEqual(routed, ['<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>']);
    assert.ok(all.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('<mcpl--heartbeat--heartbeat_status>'))));
    assert.ok(!all.some((m) => m.metadata?.kind === 'tool-wrapper-prose-contained'));
  });

  it('returns empty speech to ephemeral callers for a contained wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-ephemeral-')); dirs.push(dir);
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{
      type: 'text', text: '<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>',
    }] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [], modules: [new HeartbeatModule()],
    });
    const created = await framework.createEphemeralAgent({
      name: 'ephemeral-wrapper', model: 'test', systemPrompt: 'sys', allowedTools: 'all', toolWrapperProseGuard: true,
    });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'check' }]);
    const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    framework.start();
    const result = await run;
    const internals = framework as unknown as {
      logicalTurnToolCalls: WeakMap<object, { turnToken: number; count: number }>;
      recordLogicalTurnToolCalls(agent: object, turnToken: number, count: number): void;
    };
    assert.equal(internals.logicalTurnToolCalls.has(created.agent), false, 'normal ephemeral cleanup removes logical-turn state');
    internals.recordLogicalTurnToolCalls(created.agent, 1, 1);
    assert.equal(internals.logicalTurnToolCalls.has(created.agent), false, 'late stream events cannot recreate disposed ephemeral state');
    await framework.stop();
    assert.deepEqual(result, { speech: '', toolCallsCount: 0 });
  });

  it('cleans logical-turn state when an ephemeral startup watchdog fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-ephemeral-watchdog-')); dirs.push(dir);
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [], modules: [new HeartbeatModule()] });
    const created = await framework.createEphemeralAgent({ name: 'ephemeral-wrapper-watchdog', model: 'test', systemPrompt: 'sys', allowedTools: 'all', toolWrapperProseGuard: true });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'check' }]);
    const internals = framework as unknown as { logicalTurnToolCalls: WeakMap<object, { turnToken: number; count: number }> };
    internals.logicalTurnToolCalls.set(created.agent, { turnToken: 1, count: 1 });
    await assert.rejects(framework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 20 }), /failed to start inference/);
    assert.equal(internals.logicalTurnToolCalls.has(created.agent), false);
    await framework.stop();
  });

  it('refuses an ephemeral name that collides with a registered resident', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-resident-name-')); dirs.push(dir);
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [{ name: 'resident', model: 'test', systemPrompt: 'sys' }], modules: [new HeartbeatModule()] });
    await assert.rejects(
      framework.createEphemeralAgent({ name: 'resident', model: 'test', systemPrompt: 'sys', allowedTools: 'all' }),
      /already registered or has been used/,
    );
    assert.ok(framework.getAgent('resident'));
    await framework.stop();
  });

  it('idle-watchdog disposal cancels and ignores late tool events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-late-tool-')); dirs.push(dir);
    const module = new HeartbeatModule();
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new LateToolAfterIdleMembrane().asMembrane(), agents: [], modules: [module] });
    await framework.start();
    const created = await framework.createEphemeralAgent({ name: 'late-tool-after-idle', model: 'test', systemPrompt: 'sys', allowedTools: 'all', toolWrapperProseGuard: true });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'check' }]);
    await assert.rejects(framework.runEphemeralToCompletion(created.agent, created.contextManager, { startupTimeoutMs: 100, idleTimeoutMs: 20, idlePollMs: 5 }), /stalled/);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(module.calls, 0, 'late structured call never executes after disposal');
    assert.equal(framework.getAgent(created.agent.name), null);
    const internals = framework as unknown as { activeStreams: Map<string, unknown>; pendingAssistantBlocks: Map<string, unknown> };
    assert.equal(internals.activeStreams.has(created.agent.name), false, 'disposal removes the old active stream handle');
    assert.equal(internals.pendingAssistantBlocks.has(created.agent.name), false, 'disposal removes pending tool blocks');
    await framework.stop();
  });

  it('refuses ephemeral name reuse before a stale stream can bind to a successor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-ephemeral-name-')); dirs.push(dir);
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [], modules: [new HeartbeatModule()] });
    const first = await framework.createEphemeralAgent({ name: 'single-generation-name', model: 'test', systemPrompt: 'sys', allowedTools: 'all', toolWrapperProseGuard: true });
    first.contextManager.addMessage('user', [{ type: 'text', text: 'check' }]);
    await assert.rejects(framework.runEphemeralToCompletion(first.agent, first.contextManager, { startupTimeoutMs: 20 }), /failed to start inference/);
    await assert.rejects(
      framework.createEphemeralAgent({ name: 'single-generation-name', model: 'test', systemPrompt: 'sys', allowedTools: 'all', toolWrapperProseGuard: true }),
      /already registered or has been used/,
    );
    assert.equal(framework.getAgent('single-generation-name'), null);
    await framework.stop();
  });

  it('ignores late tool events from a disposed generation after name reuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-generation-')); dirs.push(dir);
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [], modules: [new HeartbeatModule()] });
    const oldAgent = { name: 'reused' }; const newAgent = { name: 'reused' };
    const internals = framework as unknown as {
      logicalTurnToolCalls: WeakMap<object, { turnToken: number; count: number }>;
      recordLogicalTurnToolCalls(agent: object, turnToken: number, count: number): void;
      agents: Map<string, object>;
    };
    internals.agents.set('reused', newAgent);
    internals.logicalTurnToolCalls.set(oldAgent, { turnToken: 1, count: 1 });
    internals.logicalTurnToolCalls.set(newAgent, { turnToken: 2, count: 0 });
    internals.recordLogicalTurnToolCalls(oldAgent, 1, 1);
    assert.deepEqual(internals.logicalTurnToolCalls.get(newAgent), { turnToken: 2, count: 0 });
    internals.agents.delete('reused');
    await framework.stop();
  });

  it('conversation disposal reclaims logical-turn state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-conversation-cleanup-')); dirs.push(dir);
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [], modules: [new HeartbeatModule()] });
    const internals = framework as unknown as {
      logicalTurnToolCalls: WeakMap<object, { turnToken: number; count: number }>;
      disposeConversationAgent(agentName: string): void;
      agents: Map<string, object>;
    };
    const fork = { name: 'fork' };
    internals.agents.set('fork', fork);
    internals.logicalTurnToolCalls.set(fork, { turnToken: 1, count: 1 });
    internals.disposeConversationAgent('fork');
    assert.equal(internals.logicalTurnToolCalls.has(fork), false);
    await framework.stop();
  });

  it('enabled contains wrapper before continuity and publication, with content-free system receipt', async () => {
    const { routed, outgoing, all, module } = await run(true);
    assert.deepEqual(routed, []);
    assert.deepEqual(outgoing, [], 'wrapper never reaches outgoing preview/voice streaming');
    assert.equal(module.calls, 0, 'textual wrapper never executes the registered tool');
    assert.ok(!all.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('<mcpl--heartbeat--heartbeat_status>'))));
    const receipt = all.find((m) => m.metadata?.kind === 'tool-wrapper-prose-contained');
    assert.ok(receipt, 'structured system receipt exists');
    const receiptText = receipt!.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assert.equal(receiptText, '[tool-boundary] No tool was called.');
    assert.ok(!receiptText.includes('heartbeat'), 'receipt does not echo the tool name or wrapper syntax');
  });

  it('successful ephemeral completion stops typing and finalizes outgoing after caller disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-ephemeral-terminal-')); dirs.push(dir);
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Ordinary ephemeral answer.' }] as ContentBlock[]));
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [], modules: [] });
    const typing: string[] = [];
    const outgoing: Array<[string, string]> = [];
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test',
      startTyping: (channel: string) => typing.push(`start:${channel}`),
      stopTyping: (channel?: string) => typing.push(`stop:${channel ?? '(all)'}`),
      routeSpeech: async () => ({ delivered: true, channelId: 'world:test' }),
      sendOutgoingChunk: (_channel: string, _agent: string, _id: string, _index: number, delta: string) => outgoing.push(['chunk', delta]),
      sendOutgoingComplete: (_channel: string, _agent: string, _id: string, text: string) => outgoing.push(['complete', text]),
      getDefaultPublishChannel: () => 'world:test', isChannelOpen: () => true, getDescriptor: () => undefined, getChannelTools: () => [],
      resolveProseTarget: () => ({ channelId: 'world:test' }),
    }, { get: (target, prop: string) => (prop in target ? (target as Record<string, unknown>)[prop] : () => undefined) });
    const created = await framework.createEphemeralAgent({ name: 'ephemeral-terminal', model: 'test', systemPrompt: 'sys', allowedTools: 'all' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'go' }]);
    const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    framework.start();
    assert.deepEqual(await run, { speech: 'Ordinary ephemeral answer.', toolCallsCount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(typing.includes('stop:(all)'), 'terminal physical frame stops typing after ephemeral caller disposal');
    assert.ok(outgoing.some(([kind, text]) => kind === 'complete' && text === 'Ordinary ephemeral answer.'), 'terminal physical frame finalizes outgoing stream');
    await framework.stop();
  });

  it('releases a conversation name reservation after transient creation failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-wrapper-guard-conversation-retry-')); dirs.push(dir);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'trunk', model: 'test', systemPrompt: 'sys' }], modules: [],
      conversations: { templateAgent: 'trunk', bind: { channel: 'mention' } },
    });
    const internals = framework as unknown as { store: Record<PropertyKey, unknown>; createConversationAgent(name: string, channelId: string): Promise<{ name: string }> };
    const goodStore = internals.store;
    internals.store = new Proxy(goodStore, { get(target, prop) {
      if (prop === 'getMessages' || prop === 'appendMessage' || prop === 'getStateJson') throw new Error('transient store failure');
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await assert.rejects(internals.createConversationAgent('trunk-chan-g1', 'world:chan'), /transient store failure/);
    internals.store = goodStore;
    const retried = await internals.createConversationAgent('trunk-chan-g1', 'world:chan');
    assert.equal(retried.name, 'trunk-chan-g1');
    await framework.stop();
  });

});
