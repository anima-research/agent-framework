/**
 * Module.onToolBatchComplete (shelf-383): awaited when an agent's tool round
 * completes — its last pending result arrives — before that result is
 * provided, and so before anything continues the turn. Bounded and fail-open;
 * the agent's state is checked again after it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/types/trace.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class ToolModule implements Module {
  readonly name = 'robot';
  membrane: MockMembrane;
  hookCalls: Array<{ agentName: string; resultsProvidedBefore: number }> = [];
  onHook: ((agentName: string) => Promise<void>) | null = null;
  onTool: ((call: ToolCall) => void) | null = null;

  constructor(membrane: MockMembrane) {
    this.membrane = membrane;
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'act', description: 'Act', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.onTool?.(call);
    return { success: true, data: { ok: true } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }],
      requestInference: true,
    };
  }

  async onToolBatchComplete(agentName: string): Promise<void> {
    this.hookCalls.push({ agentName, resultsProvidedBefore: this.membrane.lastStream?.receivedToolResults.length ?? 0 });
    await this.onHook?.(agentName);
  }
}

describe('Module.onToolBatchComplete', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let tools: ToolModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'batch-hook-'));
    membrane = new MockMembrane();
    tools = new ToolModule(membrane);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(extra: Module[] = []): Promise<AgentFramework> {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You act.' }],
      modules: [tools, ...extra],
    });
  }

  /** One round of two tool calls, then a closing text response. */
  function scriptTwoCallRound(): void {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--act', input: { n: 1 } },
      { type: 'tool_use', id: 'c2', name: 'robot--act', input: { n: 2 } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]));
  }

  function trigger(framework: AgentFramework): void {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
  }

  it('runs once per completed batch, before its results reach the stream', async () => {
    scriptTwoCallRound();
    const framework = await createFramework();
    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(tools.hookCalls, [{ agentName: 'assistant', resultsProvidedBefore: 0 }],
      'one call for the two-call round, before the round was resumed');
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1, 'the round then resumed with its results');
    await framework.stop();
  });

  it('a hook that outlasts its bound is traced and skipped, and the round goes on', async () => {
    scriptTwoCallRound();
    const framework = await createFramework();
    const registry = (framework as unknown as { moduleRegistry: { notifyToolBatchComplete: (a: string, t?: number) => Promise<unknown> } }).moduleRegistry;
    const notify = registry.notifyToolBatchComplete.bind(registry);
    registry.notifyToolBatchComplete = (agentName: string) => notify(agentName, 50);
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    tools.onHook = () => new Promise<void>(() => {}); // never settles

    trigger(framework);
    await framework.runUntilIdle();

    const failed = traces.find((e) => e.type === 'module:batch_hook_failed') as
      | { module: string; error: string; agentName: string } | undefined;
    assert.equal(failed?.module, 'robot');
    assert.equal(failed?.agentName, 'assistant');
    assert.match(failed!.error, /timed out after 50ms/);
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1, 'the round went on without the hook');
    await framework.stop();
  });

  it('a hook that throws before returning its promise is traced and skipped, and later hooks still run', async () => {
    // Registered before the robot module, so its synchronous throw would have
    // escaped while the robot's hook was still to be called.
    const thrower: Module = {
      name: 'thrower',
      async start() {},
      async stop() {},
      getTools: () => [],
      handleToolCall: async () => ({ success: true }),
      onProcess: async () => ({}),
      onToolBatchComplete(): Promise<void> {
        throw new Error('thrown before any promise');
      },
    };
    scriptTwoCallRound();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You act.' }],
      modules: [thrower, tools],
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));

    trigger(framework);
    await framework.runUntilIdle();

    const failed = traces.find((e) => e.type === 'module:batch_hook_failed') as
      | { module: string; error: string } | undefined;
    assert.equal(failed?.module, 'thrower');
    assert.match(failed!.error, /thrown before any promise/);
    assert.equal(tools.hookCalls.length, 1, "the other module's hook still ran");
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1, 'the round went on with its results');
    await framework.stop();
  });

  it('an agent cancelled during the hook has the result dropped, not provided', async () => {
    scriptTwoCallRound();
    const framework = await createFramework();
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    tools.onHook = async (agentName) => {
      framework.abortInference(agentName, 'cancelled at the batch boundary');
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(membrane.lastStream!.receivedToolResults.length, 0, 'nothing was provided to the cancelled round');
    assert.ok(traces.some((e) => e.type === 'tool:result_dropped'), 'the dropped result is traced');
    await framework.stop();
  });

  it('a result whose call the turn no longer waits on after the hook is dropped and traced, not thrown', async () => {
    scriptTwoCallRound();
    const framework = await createFramework();
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    tools.onHook = async (agentName) => {
      // The round is replaced while modules catch up: the agent waits again,
      // now on a call of a new batch.
      const agent = framework.getAgent(agentName) as unknown as { _state: { status: string; pending: Map<string, unknown> } };
      agent._state = {
        ...agent._state,
        status: 'waiting_for_tools',
        pending: new Map([['c-new', { id: 'c-new', name: 'robot--act', input: {}, startedAt: Date.now() }]]),
      };
      setTimeout(() => framework.abortInference(agentName, 'end the replaced round'), 50);
    };
    try {
      trigger(framework);
      await framework.runUntilIdle();
    } finally {
      console.error = originalError;
    }
    const dropped = traces.find((e) => e.type === 'tool:result_dropped') as { callId: string } | undefined;
    assert.ok(dropped, 'the stale result is traced as dropped');
    assert.ok(!errors.some((line) => line.includes('Unknown tool call')), errors.join('\n'));
    assert.equal(membrane.lastStream!.receivedToolResults.length, 0, 'nothing was provided to the replaced round');
    await framework.stop();
  });

  it('a result is dropped when the round is replaced by one that reuses its call id', async () => {
    scriptTwoCallRound();
    const framework = await createFramework();
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));
    tools.onHook = async (agentName) => {
      // The round is replaced while modules catch up by one waiting on a call
      // with the same id: a new entry for it, not the one this result answers.
      const agent = framework.getAgent(agentName) as unknown as { _state: { status: string; pending: Map<string, { id: string }> } };
      const [id] = [...agent._state.pending.keys()];
      agent._state = {
        ...agent._state,
        status: 'waiting_for_tools',
        pending: new Map([[id!, { id: id!, name: 'robot--act', input: { generation: 2 }, startedAt: Date.now() } as unknown as { id: string }]]),
      };
      setTimeout(() => framework.abortInference(agentName, 'end the replaced round'), 50);
    };
    trigger(framework);
    await framework.runUntilIdle();
    assert.ok(traces.some((e) => e.type === 'tool:result_dropped'), 'the stale result is traced as dropped');
    assert.equal(membrane.lastStream!.receivedToolResults.length, 0, 'nothing was provided to the replacing round');
    await framework.stop();
  });

  it("a result for a call that isn't pending doesn't run the hook early", async () => {
    // One call: while it runs, a stray result for another call arrives.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'robot--act', input: { n: 1 } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]));
    const framework = await createFramework();
    const originalError = console.error;
    console.error = () => {};
    tools.onTool = () => {
      framework.pushEvent({ type: 'tool-result', callId: 'stray', agentName: 'assistant', moduleName: 'robot', result: { success: true } } as unknown as ProcessEvent);
    };
    try {
      trigger(framework);
      // The stray result throws where it's provided, as on main; the round
      // then goes on with its own result.
      await assert.rejects(() => framework.runUntilIdle(), /Unknown tool call: stray/);
      await framework.runUntilIdle();
    } finally {
      console.error = originalError;
    }
    assert.equal(tools.hookCalls.length, 1, 'only the round\'s own last result runs the hook');
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1);
    await framework.stop();
  });

  it('a hook still running from an earlier batch is skipped, not called and waited for again', async () => {
    const framework = await createFramework();
    const registry = (framework as unknown as { moduleRegistry: { notifyToolBatchComplete: (a: string, t?: number) => Promise<Array<{ module: string; error: string }>> } }).moduleRegistry;
    let calls = 0;
    tools.onHook = () => { calls++; return new Promise<void>(() => {}); }; // never settles
    const first = await registry.notifyToolBatchComplete('assistant', 50);
    assert.match(first[0]!.error, /timed out after 50ms/);
    const started = Date.now();
    const second = await registry.notifyToolBatchComplete('assistant', 5_000);
    assert.ok(Date.now() - started < 1_000, 'the second batch was not held');
    assert.deepEqual(second, [{ module: 'robot', error: 'still running from an earlier batch' }]);
    assert.equal(calls, 1, 'the wedged hook was called once');
    await framework.stop();
  });

  it("an on-agent-action workspace has the batch's disk changes before the stream resumes", async () => {
    const dir = join(tempDir, 'files');
    mkdirSync(dir, { recursive: true });
    const workspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: dir, mode: 'read-write', watch: 'on-agent-action' }],
    });
    // A tool that changes disk directly, as a shell command would.
    tools.onTool = (call) => writeFileSync(join(dir, `made-by-${call.id}.txt`), 'from a tool');
    scriptTwoCallRound();
    const framework = await createFramework([workspace]);
    workspace.initStore(framework.getStore()); // as hosts do

    const seenAtResume: Array<string | null> = [];
    const provide = MockYieldingStream.prototype.provideToolResults;
    MockYieldingStream.prototype.provideToolResults = function (this: MockYieldingStream, ...args) {
      const store = (workspace as unknown as { store: { treeGet: (s: string, p: string) => { blobHash: string } | null } }).store;
      for (const id of ['c1', 'c2']) seenAtResume.push(store.treeGet('workspace/files/tree', `made-by-${id}.txt`) ? id : null);
      return provide.apply(this, args);
    };
    try {
      trigger(framework);
      await framework.runUntilIdle();
    } finally {
      MockYieldingStream.prototype.provideToolResults = provide;
    }

    assert.deepEqual(seenAtResume, ['c1', 'c2'], 'both files were in the workspace when the round resumed');
    await framework.stop();
  });
});
