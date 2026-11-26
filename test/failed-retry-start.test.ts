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

type RetryFailure = 'compile' | 'setup';

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
