import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverBudgetError } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { bindAsConversationFork } from './helpers/dendrite.js';

type RetryFailure = 'compile' | 'setup' | 'none';

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
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
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await Promise.resolve();
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const serverError = (request: NormalizedRequest) => new MembraneError({
  type: 'server', retryable: true, httpStatus: 500, message: 'zz internal error', rawError: { status: 500 }, rawRequest: request,
});

class HeldStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  cancelled = false;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.cancelled = true; this.release(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await this.released;
  }
}

class FirstCallFails extends MockMembrane {
  primary = 0;
  readonly held: HeldStream[] = [];
  constructor(private readonly retryFailsAtSetup: boolean, private readonly holdLater = false) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.primary++;
    if (this.primary === 1) return new ErrorStream(serverError(request));
    if (this.primary === 2 && this.retryFailsAtSetup) throw serverError(request);
    if (this.holdLater) {
      const stream = new HeldStream();
      this.held.push(stream);
      return stream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.primary}` }])]);
  }
}

type Internal = {
  closingConversationAgents: Set<string>;
  conversationRouter: unknown;
  lastConversationSweep: number;
  sweepExpiredConversations(): void;
  disposeConversationAgent(agentName: string): void;
  startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
  activeStreams: Map<string, unknown>;
  activeTurnTokens: Map<string, number>;
  agents: Map<string, unknown>;
  providerAdmissionClosed: boolean;
  addMessage(participant: string, content: Array<{ type: 'text'; text: string }>): unknown;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, what: string, boundMs = 5_000): Promise<void> {
  const deadline = performance.now() + boundMs;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`zz-timeout: ${what} did not happen within ${boundMs} ms`);
    await sleep(20);
  }
}

const retryOnce: ErrorPolicy = { maxRetries: 1, onInferenceError: (_e, _a, attempt) => (attempt < 1 ? { retry: true, delayMs: 0 } : { retry: false }) };

async function withFramework(
  retry: RetryFailure,
  run: (fw: AgentFramework, internal: Internal, membrane: FirstCallFails, exhausted: () => boolean, traces: string[]) => Promise<void>,
  errorPolicy: ErrorPolicy = retryOnce,
  holdLater = false,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'failed-retry-start-'));
  const membrane = new FirstCallFails(retry === 'setup', holdLater);
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy,
  });
  if (retry === 'compile') {
    const cm = fw.getAgent('resident')!.getContextManager();
    const compile = cm.compile.bind(cm);
    let compiles = 0;
    cm.compile = ((...args: Parameters<typeof cm.compile>) => {
      compiles++;
      if (compiles === 2) {
        return Promise.reject(new OverBudgetError({
          budget: 4000, actual: 8000,
          diagnostics: { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 1, deepestLevel: 1 },
        }));
      }
      return compile(...args);
    }) as typeof cm.compile;
  }
  let exhausted = false;
  const traces: string[] = [];
  fw.onTrace((event) => {
    if ((event as { agentName?: string }).agentName !== 'resident') return;
    traces.push(event.type);
    if (event.type === 'inference:exhausted') exhausted = true;
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    await run(fw, fw as unknown as Internal, membrane, () => exhausted, traces);
  } finally {
    console.error = quiet;
    await fw.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const retry of ['compile', 'setup'] as const) {
  test(`a turn whose stream fails and whose policy retry fails at its ${retry} leaves no stream behind: runUntilIdle settles, and the next message's turn runs`, async () => {
    await withFramework(retry, async (fw, _internal, membrane, exhausted) => {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      let settled = false;
      const idle = fw.runUntilIdle().then(() => { settled = true; });
      await until(exhausted, 'the turn exhausted');
      await until(() => settled, 'runUntilIdle settling after the exhausted turn');
      await idle;
      assert.equal(membrane.primary, retry === 'setup' ? 2 : 1, 'the failed call, and the retry\'s where its stream failed as it was made');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-second', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, retry === 'setup' ? 3 : 2, "the next message's turn made its call");
    });
  });
}

test('a closing conversation agent whose stream fails, and whose policy retry fails at its compile, is disposed by the closing-conversation reaper', async () => {
  await withFramework('compile', async (fw, internal, _membrane, exhausted) => {
    bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
    internal.closingConversationAgents.add('resident');
    fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
    await internal.startAgentStream(fw.getAgent('resident'), { agentName: 'resident', reason: 'conversation:closure', source: 'test', timestamp: Date.now() });
    await until(exhausted, 'the closure turn exhausted');
    const router = internal.conversationRouter;
    internal.conversationRouter = { expired: () => [], getBinding: () => undefined };
    internal.lastConversationSweep = 0;
    try { internal.sweepExpiredConversations(); } finally { internal.conversationRouter = router; }
    assert.ok(!fw.getAgent('resident'), 'disposed: no turn, no stream and no request is left');
  });
});

test("a turn whose stream fails, and whose policy retry's start fails at its compile and waits to retry in turn: runUntilIdle settles only once that retry's turn has answered", async () => {
  const twiceAfterAWait: ErrorPolicy = { maxRetries: 2, onInferenceError: (_e, _a, attempt) => (attempt < 2 ? { retry: true, delayMs: 200 } : { retry: false }) };
  await withFramework('compile', async (fw, _internal, membrane, _exhausted, traces) => {
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    let settled = false;
    const idle = fw.runUntilIdle().then(() => { settled = true; });
    await until(() => settled, 'runUntilIdle settling');
    await idle;
    assert.ok(traces.includes('inference:completed'), `the second retry's turn answered before runUntilIdle settled: ${traces.join(',')}`);
    assert.equal(membrane.primary, 2, 'the failed call, then the second retry\'s');
  }, twiceAfterAWait);
});

test('a message stored after a turn whose policy retry fails at its compile and exhausts enters the window, with no other stream to bring it in', async () => {
  await withFramework('compile', async (fw, internal, _membrane, exhausted) => {
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    void fw.runUntilIdle();
    await until(exhausted, 'the turn exhausted');
    internal.addMessage('User', [{ type: 'text', text: 'zz-later' }]);
    const cm = fw.getAgent('resident')!.getContextManager();
    await until(() => JSON.stringify(cm.getPresentedMessages()).includes('zz-later'), 'the message entering the window');
  });
});

test("a caller who stops a policy retry while its compile runs finds the failed stream listed until its frame ends", async () => {
  await withFramework('none', async (fw, internal, _membrane, _exhausted, traces) => {
    const cm = fw.getAgent('resident')!.getContextManager();
    const compile = cm.compile.bind(cm);
    let compiles = 0;
    let inheritedDuringCompile = false;
    cm.compile = ((...args: Parameters<typeof cm.compile>) => {
      compiles++;
      if (compiles === 2) {
        inheritedDuringCompile = internal.activeStreams.has('resident');
        fw.abortInference('resident', 'user');
      }
      return compile(...args);
    }) as typeof cm.compile;
    let streamsAtAbort: unknown;
    fw.onTrace((event) => {
      if (event.type === 'inference:aborted' && (event as { agentName?: string }).agentName === 'resident') {
        streamsAtAbort = (fw.healthSnapshot() as { activeStreams: string[] }).activeStreams;
      }
    });
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    void fw.runUntilIdle();
    await until(() => traces.includes('inference:aborted'), 'the stop reported');
    assert.equal(inheritedDuringCompile, true, "the failed stream's entry was there while the retry compiled");
    assert.deepEqual(streamsAtAbort, ['resident'], 'the failed stream is listed as the stop is reported, its frame still running');
    await until(() => !internal.activeStreams.has('resident'), 'the failed stream leaving once its frame ends');
  });
});

test('a policy retry whose compile ends while the framework stops is dropped, and the failed stream stays listed until its frame ends', async () => {
  await withFramework('none', async (fw, internal) => {
    const cm = fw.getAgent('resident')!.getContextManager();
    const compile = cm.compile.bind(cm);
    let compiles = 0;
    let inheritedDuringCompile = false;
    cm.compile = (async (...args: Parameters<typeof cm.compile>) => {
      compiles++;
      if (compiles === 2) {
        inheritedDuringCompile = internal.activeStreams.has('resident');
        void fw.stop();
        await until(() => internal.providerAdmissionClosed, 'the framework closing admission');
      }
      return compile(...args);
    }) as typeof cm.compile;
    let dropped = false;
    let streamsAtDrop: unknown;
    fw.onTrace((event) => {
      const e = event as { type: string; agentName?: string; reason?: string };
      if (e.type === 'inference:aborted' && e.agentName === 'resident' && e.reason?.includes('is dropped before it sends anything')) {
        dropped = true;
        streamsAtDrop = (fw.healthSnapshot() as { activeStreams: string[] }).activeStreams;
      }
    });
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    void fw.runUntilIdle();
    await until(() => dropped, 'the drop reported');
    assert.equal(inheritedDuringCompile, true, "the failed stream's entry was there while the retry compiled");
    assert.deepEqual(streamsAtDrop, ['resident'], 'the failed stream is listed as the drop is reported, its frame still running');
    await until(() => !internal.activeStreams.has('resident'), 'the failed stream leaving once its frame ends');
  });
});

test("a policy retry of an agent replaced while the retry waited leaves the replacement's stream entry alone", async () => {
  const afterAWait: ErrorPolicy = { maxRetries: 1, onInferenceError: (_e, _a, attempt) => (attempt < 1 ? { retry: true, delayMs: 200 } : { retry: false }) };
  await withFramework('none', async (fw, internal, _membrane, _exhausted, traces) => {
    const agent = fw.getAgent('resident')!;
    let dropped = false;
    fw.onTrace((event) => {
      const e = event as { type: string; reason?: string };
      if (e.type === 'inference:aborted' && e.reason?.includes('the agent was replaced or removed')) dropped = true;
    });
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    void fw.runUntilIdle();
    await until(() => traces.includes('inference:failed'), 'the first stream failing');
    const replacementStream = new Promise<void>(() => {});
    internal.agents.set('resident', Object.create(agent));
    internal.activeStreams.set('resident', replacementStream);
    try {
      await until(() => dropped, "the old agent's retry dropped");
      await until(() => !internal.activeTurnTokens.has('resident'), "the retry's start ending");
      assert.equal(internal.activeStreams.get('resident'), replacementStream, "the replacement's entry stands");
    } finally {
      internal.activeStreams.delete('resident');
      internal.agents.set('resident', agent);
    }
  }, afterAWait);
});

test("a conversation agent disposed while the stream of its turn's second retry runs has that stream cancelled", async () => {
  const twice: ErrorPolicy = { maxRetries: 2, onInferenceError: (_e, _a, attempt) => (attempt < 2 ? { retry: true, delayMs: 0 } : { retry: false }) };
  await withFramework('compile', async (fw, internal, membrane) => {
    bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
    fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
    await internal.startAgentStream(fw.getAgent('resident'), { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
    await until(() => membrane.held.length === 1, "the second retry's stream");
    await sleep(50);
    internal.disposeConversationAgent('resident');
    assert.equal(membrane.held[0]!.cancelled, true, 'the disposal cancelled the stream');
  }, twice, true);
});

test('a stop before a policy retry compiles leaves the failed stream tracked while its frame still reads it', async () => {
  await withFramework('none', async (fw, _internal, membrane) => {
    const agent = fw.getAgent('resident')!;
    let release!: () => void;
    const mayEnd = new Promise<void>((resolve) => { release = resolve; });
    let readingOn = false;
    let ended = false;
    membrane.streamYielding = (request: NormalizedRequest) => {
      const error = serverError(request);
      const stream = new ErrorStream(error);
      stream[Symbol.asyncIterator] = async function* () {
        yield { type: 'error', error } as StreamEvent;
        readingOn = true;
        await mayEnd;
        ended = true;
      };
      return stream;
    };
    let starts = 0;
    let stopped = false;
    let idAtFailure: number | undefined;
    let idAtStop: number | undefined;
    fw.onTrace((event) => {
      if ((event as { agentName?: string }).agentName !== 'resident') return;
      if (event.type === 'inference:failed') idAtFailure = agent.streamId;
      if (event.type === 'inference:started' && ++starts === 2) stopped = fw.abortInference('resident', 'user');
      if (event.type === 'inference:aborted') idAtStop = agent.streamId;
    });
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    const pumping = fw.runUntilIdle();
    try {
      await until(() => readingOn, 'the failed stream read on after its retry stopped');
      assert.equal(stopped, true, "the retry's start was stopped");
      assert.ok(idAtFailure !== undefined && idAtFailure === idAtStop, 'the retry ended before it took the stream id');
      assert.deepEqual((fw.healthSnapshot() as { activeStreams: string[] }).activeStreams, ['resident'], 'the failed stream is tracked while its frame reads it');
      let settled = false;
      const idle = fw.runUntilIdle().then(() => { settled = true; });
      await sleep(100);
      assert.equal(settled, false, 'runUntilIdle waits while the frame reads');
      release();
      await idle;
      assert.equal(ended, true, 'runUntilIdle settled after the frame ended');
    } finally {
      release();
      await pumping;
    }
  });
});

test('a policy retry that takes the stream id and fails at its compile, while the failed stream is still read, leaves that stream tracked until its frame ends', async () => {
  await withFramework('compile', async (fw, _internal, membrane, exhausted) => {
    const agent = fw.getAgent('resident')!;
    let release!: () => void;
    const mayEnd = new Promise<void>((resolve) => { release = resolve; });
    let readingOn = false;
    let ended = false;
    membrane.streamYielding = (request: NormalizedRequest) => {
      const error = serverError(request);
      const stream = new ErrorStream(error);
      stream[Symbol.asyncIterator] = async function* () {
        yield { type: 'error', error } as StreamEvent;
        readingOn = true;
        await mayEnd;
        ended = true;
      };
      return stream;
    };
    let idAtFailure: number | undefined;
    fw.onTrace((event) => {
      if ((event as { agentName?: string }).agentName !== 'resident') return;
      if (event.type === 'inference:failed' && idAtFailure === undefined) idAtFailure = agent.streamId;
    });
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    const pumping = fw.runUntilIdle();
    try {
      await until(() => readingOn, 'the failed stream read on after its retry');
      assert.ok(exhausted(), "the retry's compile failed and the turn exhausted");
      assert.ok(idAtFailure !== undefined && agent.streamId > idAtFailure, 'the retry took the stream id');
      assert.deepEqual((fw.healthSnapshot() as { activeStreams: string[] }).activeStreams, ['resident'], 'the failed stream is tracked while its frame reads it');
      let idleEarly = false;
      let settled = false;
      void fw.runUntilIdle().then(() => { idleEarly = !ended; settled = true; });
      await sleep(100);
      assert.equal(settled, false, 'runUntilIdle waits while the frame reads');
      release();
      await until(() => settled, 'runUntilIdle settling once the failed stream has ended');
      assert.equal(idleEarly, false, 'runUntilIdle waited for the frame to end');
      assert.deepEqual((fw.healthSnapshot() as { activeStreams: string[] }).activeStreams, [], 'no stream is tracked once the frame has ended');
    } finally {
      release();
      await Promise.race([pumping, sleep(1_000)]);
    }
  });
});

class HeldTool implements Module {
  readonly name = 'held';
  private opened!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.opened = resolve; });
  called = false;
  open(): void { this.opened(); }
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> { this.opened(); }
  getTools(): ToolDefinition[] { return [{ name: 'wait', description: 'Wait until let go.', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(): Promise<ToolResult> {
    this.called = true;
    await this.gate;
    return { success: true, data: 'let go' };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

test("a stream that fails with its tool round still running, whose policy retry fails at its compile, leaves no pending round behind once its frame ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'failed-retry-start-'));
  const membrane = new FirstCallFails(false);
  const held = new HeldTool();
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule(), held], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy: retryOnce,
  });
  const cm = fw.getAgent('resident')!.getContextManager();
  const compile = cm.compile.bind(cm);
  let compiles = 0;
  cm.compile = ((...args: Parameters<typeof cm.compile>) => {
    if (++compiles === 2) {
      return Promise.reject(new OverBudgetError({
        budget: 4000, actual: 8000,
        diagnostics: { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 1, deepestLevel: 1 },
      }));
    }
    return compile(...args);
  }) as typeof cm.compile;
  let ended = false;
  membrane.streamYielding = (request: NormalizedRequest) => {
    const error = serverError(request);
    const stream = new ErrorStream(error);
    stream[Symbol.asyncIterator] = async function* () {
      yield {
        type: 'tool-calls',
        calls: [{ id: 'zz-call', name: 'held--wait', input: {} }],
        context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [{ type: 'tool_use', id: 'zz-call', name: 'held--wait', input: {} }] },
      } as unknown as StreamEvent;
      yield { type: 'error', error } as StreamEvent;
      ended = true;
    };
    return stream;
  };
  const internal = fw as unknown as Internal & { pendingAssistantBlocks: Map<string, unknown> };
  let exhausted = false;
  fw.onTrace((event) => {
    if ((event as { agentName?: string }).agentName === 'resident' && event.type === 'inference:exhausted') exhausted = true;
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    void fw.runUntilIdle();
    await until(() => ended && exhausted, 'the failed stream ending, its retry exhausted');
    await until(() => !internal.activeStreams.has('resident'), 'the failed stream leaving activeStreams');
    assert.equal(held.called, true, "the round's tool was called");
    assert.equal(internal.pendingAssistantBlocks.has('resident'), false, 'no pending round is left once the frame has ended');
  } finally {
    held.open();
    console.error = quiet;
    await fw.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed stream's frame that ends after its retry's stream has started a tool round leaves that stream's entry and round alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'failed-retry-start-'));
  const membrane = new FirstCallFails(false);
  const held = new HeldTool();
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule(), held], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy: retryOnce,
  });
  let release!: () => void;
  const mayEnd = new Promise<void>((resolve) => { release = resolve; });
  let ended = false;
  let calls = 0;
  membrane.streamYielding = (request: NormalizedRequest) => {
    if (++calls === 1) {
      const error = serverError(request);
      const stream = new ErrorStream(error);
      stream[Symbol.asyncIterator] = async function* () {
        yield { type: 'error', error } as StreamEvent;
        await mayEnd;
        ended = true;
      };
      return stream;
    }
    return new MockYieldingStream([createMockResponse([{ type: 'tool_use', id: 'zz-call', name: 'held--wait', input: {} }], 'tool_use')]);
  };
  const internal = fw as unknown as Internal & { pendingAssistantBlocks: Map<string, unknown> };
  const frames: unknown[] = [];
  const register = internal.activeStreams.set.bind(internal.activeStreams);
  internal.activeStreams.set = (name, handle) => {
    if (name === 'resident') frames.push(handle);
    return register(name, handle);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
    void fw.runUntilIdle();
    await until(() => held.called, "the retry's tool round running");
    assert.equal(frames.length, 2, "the failed stream's frame and the retry's stream registered, in that order");
    const retryStream = internal.activeStreams.get('resident');
    const retryRound = internal.pendingAssistantBlocks.get('resident');
    assert.ok(retryStream !== undefined && retryRound !== undefined, "the retry's stream and round are registered");
    release();
    await frames[0];
    assert.equal(ended, true, 'the failed stream ended');
    assert.equal(internal.activeStreams.get('resident'), retryStream, "the retry's stream entry stands");
    assert.equal(internal.pendingAssistantBlocks.get('resident'), retryRound, "the retry's round stands");
  } finally {
    release();
    held.open();
    console.error = quiet;
    await fw.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
