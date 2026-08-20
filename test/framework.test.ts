/**
 * Agent framework integration tests
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, ContentBlock, YieldingStream, StreamEvent } from '@animalabs/membrane';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, ProcessQueueImpl } from '../src/index.js';

// ============================================================================
// Mock Membrane - minimal interface that framework needs
// ============================================================================

interface MinimalMembrane {
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
  streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream;
}

/**
 * Mock yielding stream for testing the streaming inference path.
 * Takes a sequence of responses: first response starts the stream,
 * subsequent responses resume after each tool round.
 */
class MockYieldingStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private _done = false;
  private _isWaitingForTools = false;
  private _pendingToolCallIds: string[] = [];
  private _toolDepth = 0;
  private pendingResolve: (() => void) | null = null;
  receivedToolResults: unknown[][] = [];

  constructor(private responses: NormalizedResponse[]) {
    this.processResponse(0);
  }

  private processResponse(index: number): void {
    const response = this.responses[index];
    if (!response) {
      this._done = true;
      return;
    }

    // Emit block lifecycle + tokens. Mirroring the membrane's native yielding
    // path (block_start → tokens → block_complete) so tests exercise the
    // framework's 'block' case-arm + the blockType/blockIndex tagging on
    // tokens. Real membrane emits 'block' on every block transition; we emit
    // one text block per response, which is enough to cover the trace plumbing.
    const text = response.rawAssistantText;
    if (text) {
      this.events.push({
        type: 'block',
        event: { event: 'block_start', index: 0, block: { type: 'text' } },
      } as StreamEvent);
      this.events.push({
        type: 'tokens',
        content: text,
        meta: { type: 'text', visible: true, blockIndex: 0 },
      } as StreamEvent);
      this.events.push({
        type: 'block',
        event: { event: 'block_complete', index: 0, block: { type: 'text', content: text } },
      } as StreamEvent);
    }

    // Emit usage
    if (response.usage) {
      this.events.push({ type: 'usage', usage: response.usage } as StreamEvent);
    }

    // Tool calls or complete
    if (response.toolCalls.length > 0) {
      this._isWaitingForTools = true;
      this._pendingToolCallIds = response.toolCalls.map((c) => c.id);
      this.events.push({
        type: 'tool-calls',
        calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input as Record<string, unknown>,
        })),
        context: {
          rawText: '',
          preamble: '',
          depth: this._toolDepth,
          previousResults: [],
          accumulated: '',
          // membrane ≥0.5.64: verbatim blocks of the current round, in
          // provider order (thinking with signatures before tool_use)
          roundContent: response.content,
        },
      } as StreamEvent);
    } else {
      this.events.push({ type: 'complete', response } as StreamEvent);
      this._done = true;
    }
  }

  provideToolResults(results: unknown[]): void {
    if (!this._isWaitingForTools) throw new Error('Not waiting for tools');
    this.receivedToolResults.push(results);
    this._isWaitingForTools = false;
    this._pendingToolCallIds = [];
    this._toolDepth++;
    this.processResponse(this._toolDepth);
    // Wake up the iterator
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }
  }

  cancel(): void {
    this._done = true;
    this.events.push({ type: 'aborted', reason: 'user' } as StreamEvent);
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }
  }

  get isWaitingForTools() { return this._isWaitingForTools; }
  get pendingToolCallIds() { return [...this._pendingToolCallIds]; }
  get toolDepth() { return this._toolDepth; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) {
      while (this.events.length > 0) {
        const event = this.events.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') {
          return;
        }
      }
      if (this._done) return;
      await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    }
  }
}

function createMockResponse(
  content: ContentBlock[],
  stopReason: NormalizedResponse['stopReason'] = 'end_turn'
): NormalizedResponse {
  const rawText = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const toolCalls = content
    .filter((b): b is ContentBlock & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));

  return {
    content,
    stopReason,
    rawAssistantText: rawText,
    toolCalls,
    toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: {
      stop: { reason: stopReason, wasTruncated: false },
      usage: { inputTokens: 10, outputTokens: 5 },
      timing: { totalDurationMs: 100, attempts: 1 },
      model: { requested: 'test', actual: 'test', provider: 'mock' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
    },
    raw: { request: {}, response: {} },
  };
}

class MockMembrane implements MinimalMembrane {
  responses: NormalizedResponse[] = [];
  calls: NormalizedRequest[] = [];
  lastStream: MockYieldingStream | null = null;
  private responseIndex = 0;

  pushResponse(response: NormalizedResponse): void {
    this.responses.push(response);
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    if (this.responseIndex >= this.responses.length) {
      // Default response
      return createMockResponse([{ type: 'text', text: 'Default response' }]);
    }
    return this.responses[this.responseIndex++];
  }

  streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    // All remaining queued responses feed the stream
    const remaining = this.responses.slice(this.responseIndex);
    this.responseIndex = this.responses.length;
    const stream = new MockYieldingStream(remaining);
    this.lastStream = stream;
    return stream;
  }

  // Cast helper - use this when passing to framework
  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

// ============================================================================
// Mock Module
// ============================================================================

class TestModule implements Module {
  readonly name = 'test';
  ctx: ModuleContext | null = null;
  events: ProcessEvent[] = [];
  toolCalls: ToolCall[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echoes the input',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to echo' },
          },
          required: ['message'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.toolCalls.push(call);
    if (call.name === 'echo') {
      const input = call.input as { message: string };
      return { success: true, data: { echoed: input.message } };
    }
    return { success: false, error: 'Unknown tool', isError: true };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    this.events.push(event);

    // Handle external message by requesting inference
    if (event.type === 'external-message') {
      return {
        addMessages: [
          {
            participant: 'User',
            content: [{ type: 'text', text: String(event.content) }],
          },
        ],
        requestInference: true,
      };
    }

    return {};
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ProcessQueueImpl', () => {
  it('should push and pop events', () => {
    const queue = new ProcessQueueImpl();
    const event: ProcessEvent = {
      type: 'timer-fired',
      timerId: 'test',
      reason: 'test',
    };

    queue.push(event);
    assert.strictEqual(queue.depth, 1);
    assert.strictEqual(queue.isEmpty, false);

    const popped = queue.tryPop();
    assert.deepStrictEqual(popped, event);
    assert.strictEqual(queue.depth, 0);
    assert.strictEqual(queue.isEmpty, true);
  });

  it('prioritizes external messages without reversing their arrival order', () => {
    const queue = new ProcessQueueImpl();
    const firstMessage: ProcessEvent = {
      type: 'external-message',
      source: 'test',
      content: 'first',
      metadata: {},
    };
    const secondMessage: ProcessEvent = {
      type: 'external-message',
      source: 'test',
      content: 'second',
      metadata: {},
    };
    const firstInternal: ProcessEvent = {
      type: 'timer-fired',
      timerId: 'first-internal',
      reason: 'test',
    };
    const secondInternal: ProcessEvent = {
      type: 'timer-fired',
      timerId: 'second-internal',
      reason: 'test',
    };

    queue.push(firstInternal);
    queue.push(firstMessage);
    queue.push(secondMessage);
    queue.push(secondInternal);

    assert.deepStrictEqual(queue.tryPop(), firstMessage);
    assert.deepStrictEqual(queue.tryPop(), secondMessage);
    assert.deepStrictEqual(queue.tryPop(), firstInternal);
    assert.deepStrictEqual(queue.tryPop(), secondInternal);
  });

  it('should return null when queue is empty', () => {
    const queue = new ProcessQueueImpl();
    assert.strictEqual(queue.tryPop(), null);
  });

  it('should peek without removing', () => {
    const queue = new ProcessQueueImpl();
    const event: ProcessEvent = {
      type: 'timer-fired',
      timerId: 'test',
      reason: 'test',
    };

    queue.push(event);
    assert.deepStrictEqual(queue.peek(), event);
    assert.strictEqual(queue.depth, 1);
  });

  it('should clear all events', () => {
    const queue = new ProcessQueueImpl();
    queue.push({ type: 'timer-fired', timerId: '1', reason: 'test' });
    queue.push({ type: 'timer-fired', timerId: '2', reason: 'test' });

    queue.clear();
    assert.strictEqual(queue.isEmpty, true);
  });

  it('should close and prevent further pushes', () => {
    const queue = new ProcessQueueImpl();
    queue.close();

    assert.throws(() => {
      queue.push({ type: 'timer-fired', timerId: 'test', reason: 'test' });
    }, /Queue is closed/);
  });
});

describe('AgentFramework', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-framework-test-'));
    membrane = new MockMembrane();
  });

  it('should create framework with agents and modules', async () => {
    const testModule = new TestModule();

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    assert.notStrictEqual(framework.getAgent('assistant'), null);
    assert.deepStrictEqual(framework.getAllAgents().map((a) => a.name), ['assistant']);
    assert.notStrictEqual(testModule.ctx, null);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should route external messages and trigger inference', async () => {
    const testModule = new TestModule();

    // Set up response
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello! How can I help?' }]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    // Push an external message event
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello!',
      metadata: {},
    });

    // Run until idle
    await framework.runUntilIdle();

    // Check that module received the event
    assert.strictEqual(testModule.events.length, 1);
    assert.strictEqual(testModule.events[0].type, 'external-message');

    // Check that membrane was called
    assert.strictEqual(membrane.calls.length, 1);
    assert.strictEqual(membrane.calls[0].system, 'You are a helpful assistant.');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should handle tool calls', async () => {
    const testModule = new TestModule();

    // First response with tool call
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me echo that for you.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'test--echo',
        input: { message: 'test message' },
      },
    ], 'tool_use'));

    // Second response after tool result
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'The echoed message is: test message' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    // Push message and run
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Echo this!',
      metadata: {},
    });

    await framework.runUntilIdle();

    // Check tool was called
    assert.strictEqual(testModule.toolCalls.length, 1);
    assert.strictEqual(testModule.toolCalls[0].name, 'echo');
    assert.deepStrictEqual(testModule.toolCalls[0].input, { message: 'test message' });

    // With streaming, membrane is called once (streamYielding handles tool rounds internally)
    assert.strictEqual(membrane.calls.length, 1);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('preserves signed thinking blocks in tool-call turns (round-trip ordering)', async () => {
    const testModule = new TestModule();

    // Round 1: signed thinking BEFORE the tool_use — the API requires this
    // ordering to survive verbatim into the stored assistant turn.
    membrane.pushResponse(createMockResponse([
      { type: 'thinking', thinking: 'I should echo this', signature: 'sig_round1' } as unknown as ContentBlock,
      { type: 'text', text: 'Let me echo that.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'test--echo',
        input: { message: 'hi' },
      },
    ], 'tool_use'));

    // Round 2 (final): signature-only thinking (display:'omitted') + answer
    membrane.pushResponse(createMockResponse([
      { type: 'thinking', thinking: '', signature: 'sig_round2' } as unknown as ContentBlock,
      { type: 'text', text: 'Done: hi' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
      modules: [testModule],
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Echo this!',
      metadata: {},
    });

    await framework.runUntilIdle();

    const agent = framework.getAgent('assistant');
    assert.ok(agent);
    const compiled = await agent.compileContext();

    // The assistant turn that carries the tool_use must contain the signed
    // thinking block BEFORE the tool_use, signature intact.
    const assistantWithTool = compiled.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_use')
    );
    assert.ok(assistantWithTool, 'assistant turn with tool_use should be stored');
    const blocks = assistantWithTool.content as ContentBlock[];
    const thinkIdx = blocks.findIndex((b) => b.type === 'thinking');
    const toolIdx = blocks.findIndex((b) => b.type === 'tool_use');
    assert.ok(thinkIdx >= 0, 'thinking block should be stored in the tool_use turn');
    assert.ok(thinkIdx < toolIdx, 'thinking must precede tool_use in the same turn');
    assert.strictEqual(
      (blocks[thinkIdx] as { signature?: string }).signature,
      'sig_round1',
      'signature must survive verbatim'
    );

    // The final assistant turn keeps its signature-only thinking block.
    const finalSigBlock = compiled.messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : []))
      .find((b) => b.type === 'thinking' && (b as { signature?: string }).signature === 'sig_round2');
    assert.ok(finalSigBlock, 'signature-only thinking block must survive in the final turn');

    // No double-storing: the round-1 preamble text must appear exactly once
    // across all stored assistant content.
    const preambleCount = compiled.messages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : []))
      .filter((b) => b.type === 'text' && (b as { text: string }).text.includes('Let me echo that.'))
      .length;
    assert.strictEqual(preambleCount, 1, 'preamble text must not be double-stored');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should emit framework events', async () => {
    const testModule = new TestModule();
    const events: string[] = [];

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello!' }]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
        },
      ],
      modules: [testModule],
    });

    framework.onTrace((event) => {
      events.push(event.type);
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello',
      metadata: {},
    });

    await framework.runUntilIdle();

    assert.ok(events.includes('process:received'), 'Should emit process:received');
    assert.ok(events.includes('inference:started'), 'Should emit inference:started');
    assert.ok(events.includes('inference:completed'), 'Should emit inference:completed');
    assert.ok(events.includes('message:added'), 'Should emit message:added');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should filter tools by agent allowedTools', async () => {
    const testModule = new TestModule();

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'No tools available' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
          allowedTools: ['nonexistent--tool'], // Won't match test--echo
        },
      ],
      modules: [testModule],
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello',
      metadata: {},
    });

    await framework.runUntilIdle();

    // Should have no tools in the request
    assert.strictEqual(membrane.calls[0].tools, undefined);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should support adding and removing modules at runtime', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
        },
      ],
      modules: [],
    });

    const testModule = new TestModule();
    await framework.addModule(testModule);
    assert.notStrictEqual(testModule.ctx, null);

    await framework.removeModule('test');
    assert.strictEqual(testModule.ctx, null);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should share store when provided', async () => {
    // This test verifies that app-owned stores work
    const { JsStore } = await import('@animalabs/chronicle');
    const store = JsStore.openOrCreate({ path: join(tempDir, 'shared.chronicle') });

    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [
        {
          name: 'assistant',
          model: 'test-model',
          systemPrompt: 'Test',
        },
      ],
      modules: [],
    });

    // Framework should work
    assert.notStrictEqual(framework.getStore(), null);
    assert.strictEqual(framework.getStore(), store);

    await framework.stop();
    // Store should still be open (framework doesn't own it)
    // We can close it ourselves
    store.close();

    rmSync(tempDir, { recursive: true });
  });
});

describe('Streaming lifecycle', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-framework-stream-'));
    membrane = new MockMembrane();
  });

  it('should complete a simple stream without tool calls', async () => {
    const testModule = new TestModule();
    const events: string[] = [];

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello from stream' }]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [testModule],
    });

    framework.onTrace((event) => events.push(event.type));

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hello',
      metadata: {},
    });

    await framework.runUntilIdle();

    assert.ok(events.includes('inference:started'));
    assert.ok(events.includes('inference:tokens'));
    assert.ok(events.includes('inference:completed'));

    // Agent should be idle after completion
    const agent = framework.getAgent('assistant')!;
    assert.strictEqual(agent.state.status, 'idle');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should tag inference:tokens with block metadata and emit content_block boundaries', async () => {
    const testModule = new TestModule();
    type TraceEvent = { type: string; [k: string]: unknown };
    const captured: TraceEvent[] = [];

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'thinking ⊕ text' }]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [testModule],
    });

    framework.onTrace((e) => captured.push(e as unknown as TraceEvent));

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hi',
      metadata: {},
    });

    await framework.runUntilIdle();

    const tokenEvents = captured.filter((e) => e.type === 'inference:tokens');
    assert.ok(tokenEvents.length > 0, 'expected at least one inference:tokens event');
    for (const t of tokenEvents) {
      assert.strictEqual(t.blockType, 'text', 'tokens carry blockType from ChunkMeta');
      assert.strictEqual(t.blockIndex, 0, 'tokens carry blockIndex from ChunkMeta');
    }

    const blockEvents = captured.filter((e) => e.type === 'inference:content_block');
    const phases = blockEvents.map((e) => e.phase);
    assert.deepStrictEqual(
      phases,
      ['block_start', 'block_complete'],
      'content_block boundary events fire in lifecycle order'
    );
    for (const b of blockEvents) {
      assert.strictEqual(b.blockType, 'text');
      assert.strictEqual(b.blockIndex, 0);
    }

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should handle multi-round tool calls in a single stream', async () => {
    const testModule = new TestModule();

    // Round 1: tool call
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'First echo.' },
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: { message: 'round1' } },
    ], 'tool_use'));

    // Round 2: another tool call
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Second echo.' },
      { type: 'tool_use', id: 'call_2', name: 'test--echo', input: { message: 'round2' } },
    ], 'tool_use'));

    // Round 3: final response
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Done with both echoes.' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [testModule],
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Do two echoes',
      metadata: {},
    });

    await framework.runUntilIdle();

    // Both tools were called
    assert.strictEqual(testModule.toolCalls.length, 2);
    assert.deepStrictEqual(testModule.toolCalls[0].input, { message: 'round1' });
    assert.deepStrictEqual(testModule.toolCalls[1].input, { message: 'round2' });

    // Still only one membrane call (one stream)
    assert.strictEqual(membrane.calls.length, 1);

    // Agent is idle
    assert.strictEqual(framework.getAgent('assistant')!.state.status, 'idle');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should cancel active streams on stop', async () => {
    const testModule = new TestModule();

    // Response with a tool call but no follow-up (stream will wait forever)
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_hang', name: 'test--echo', input: { message: 'hang' } },
    ], 'tool_use'));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [testModule],
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Hang',
      metadata: {},
    });

    // Process the event and start streaming (but don't wait for idle — it won't happen)
    // Let the stream start and dispatch the tool call
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // stop() should cancel active streams and not hang
    await framework.stop();

    // Agent should be idle after cancellation
    assert.strictEqual(framework.getAgent('assistant')!.state.status, 'idle');

    rmSync(tempDir, { recursive: true });
  });

  it('should emit tool_calls_yielded and stream_resumed traces', async () => {
    const testModule = new TestModule();
    const events: string[] = [];

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_t', name: 'test--echo', input: { message: 'trace' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Done' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [testModule],
    });

    framework.onTrace((event) => events.push(event.type));

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Trace test',
      metadata: {},
    });

    await framework.runUntilIdle();

    assert.ok(events.includes('inference:tool_calls_yielded'), 'Should emit tool_calls_yielded');
    assert.ok(events.includes('inference:stream_resumed'), 'Should emit stream_resumed');
    assert.ok(events.includes('inference:completed'), 'Should emit completed');

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });

  it('should convert AF tool results to Membrane format when resuming stream', async () => {
    const testModule = new TestModule();

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_conv', name: 'test--echo', input: { message: 'convert' } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Converted' },
    ]));

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [testModule],
    });

    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Convert test',
      metadata: {},
    });

    await framework.runUntilIdle();

    // Verify the mock stream received correctly converted tool results
    const stream = membrane.lastStream!;
    assert.strictEqual(stream.receivedToolResults.length, 1);
    const results = stream.receivedToolResults[0] as Array<{ toolUseId: string; content: string; isError?: boolean }>;
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].toolUseId, 'call_conv');
    assert.strictEqual(results[0].content, JSON.stringify({ echoed: 'convert' }));
    // Non-error results are now explicitly `isError: false` (the error path
    // returns early, so the previous `isError: afResult.isError` was always
    // falsy and misleading to read).
    assert.strictEqual(results[0].isError, false);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });
});

describe('Module state persistence', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-framework-test-'));
    membrane = new MockMembrane();
  });

  it('should persist and restore module state', async () => {
    class StatefulModule implements Module {
      readonly name = 'stateful';
      ctx: ModuleContext | null = null;

      async start(ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        // Set initial state
        const existing = ctx.getState<{ count: number }>();
        if (!existing) {
          ctx.setState({ count: 1 });
        } else {
          ctx.setState({ count: existing.count + 1 });
        }
      }

      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> {
        return { success: false, error: 'No tools', isError: true };
      }
      async onProcess(): Promise<EventResponse> { return {}; }
    }

    const storePath = join(tempDir, 'state.chronicle');

    // First run
    const module1 = new StatefulModule();
    const framework1 = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'a', model: 'm', systemPrompt: 's' }],
      modules: [module1],
    });
    assert.deepStrictEqual(module1.ctx?.getState<{ count: number }>()?.count, 1);
    await framework1.stop();

    // Second run - state should be restored
    const module2 = new StatefulModule();
    const framework2 = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'a', model: 'm', systemPrompt: 's' }],
      modules: [module2],
    });
    assert.deepStrictEqual(module2.ctx?.getState<{ count: number }>()?.count, 2);
    await framework2.stop();

    rmSync(tempDir, { recursive: true });
  });

  it('should track external IDs', async () => {
    class IdTrackingModule implements Module {
      readonly name = 'idtracker';
      ctx: ModuleContext | null = null;

      async start(ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
      }

      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(): Promise<ToolResult> {
        return { success: false, error: 'No tools', isError: true };
      }
      async onProcess(): Promise<EventResponse> { return {}; }
    }

    const module = new IdTrackingModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'ids.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'a', model: 'm', systemPrompt: 's' }],
      modules: [module],
    });

    // Add a message with external ID
    const msgId = module.ctx!.addMessage(
      'User',
      [{ type: 'text', text: 'Hello from Discord' }],
      { external: { source: 'discord', id: 'msg123' } }
    );

    // Should be able to look it up
    const found = module.ctx!.findMessageByExternalId('discord', 'msg123');
    assert.strictEqual(found, msgId);

    // Unknown ID should return null
    const notFound = module.ctx!.findMessageByExternalId('discord', 'unknown');
    assert.strictEqual(notFound, null);

    await framework.stop();
    rmSync(tempDir, { recursive: true });
  });
});
