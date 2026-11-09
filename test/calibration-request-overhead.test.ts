/**
 * The calibration sample carries what the request sent besides the window
 * (context-manager #323). The provider's input total counts the system prompt
 * and the tool definitions; the strategy's estimate of its compile doesn't.
 * Without them, a tool-heavy agent's multiplier learns its schemas as a
 * per-token rate, or, past the band, never learns at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AutobiographicalStrategy, type ContextInjection } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
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
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import { CONTINUE_ROW } from '../src/silent-heartbeat.js';

/** One provider call: a usage event, then the response. */
class ScriptedStream {
  private done = false;
  constructor(private readonly script: StreamEvent[]) {}
  cancel(): void { this.done = true; }
  get isWaitingForTools(): boolean { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth(): number { return 0; }
  provideToolResults(): void { throw new Error('ScriptedStream is not waiting for tools'); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await Promise.resolve();
    for (const event of this.script) {
      if (this.done) return;
      yield event;
    }
  }
}

class UsageMembrane extends MockMembrane {
  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new ScriptedStream([
      { type: 'usage', usage: { inputTokens: 900, outputTokens: 5, cacheCreationTokens: 600, cacheReadTokens: 3400 } } as StreamEvent,
      { type: 'complete', response: createMockResponse([{ type: 'text', text: 'ok' }]) } as StreamEvent,
    ]) as unknown as YieldingStream;
  }
}

/** Wakes the agent on an external message and advertises one tool. */
class ToolModule implements Module {
  readonly name = 'server';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'lookup',
      description: 'Looks a thing up.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: 'found' };
  }
  /** A system-position injection, which the request's system prompt carries. */
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    return [{ namespace: 'server', position: 'system', content: [{ type: 'text', text: 'The server is up.' }] }];
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: true,
    };
  }
}

test('the calibration sample carries the system prompt and tools the request sent', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'calibration-overhead-'));
  const membrane = new UsageMembrane();
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true });
  const samples: Array<{ total: number; overhead: unknown }> = [];
  const spied = strategy as unknown as { reportRealInputTokens: (n: number, overhead?: unknown) => void };
  const original = spied.reportRealInputTokens.bind(strategy);
  spied.reportRealInputTokens = (n, overhead) => { samples.push({ total: n, overhead }); original(n, overhead); };

  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are the resident.', strategy }],
    modules: [new ToolModule()],
    syncIntervalMs: 0,
  });
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await framework.runUntilIdle();

    const sent = membrane.calls[0];
    assert.ok(sent, 'the turn sent a request');
    assert.ok(sent.system?.includes('You are the resident.'), 'the request had the agent\'s system prompt');
    assert.ok(sent.system?.includes('The server is up.'), 'and the module\'s system-position injection');
    assert.ok(sent.tools?.some((tool) => tool.name.endsWith('lookup')), 'the request advertised the tool');
    assert.equal(samples.length, 1, 'one call, one sample');
    assert.equal(samples[0].total, 4900, 'input + cache write + cache read');
    assert.deepEqual(samples[0].overhead, { system: sent.system, tools: sent.tools });
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function harness(agentConfig: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'calibration-overhead-'));
  const membrane = new UsageMembrane();
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true });
  const samples: Array<{ total: number; overhead: unknown }> = [];
  const spied = strategy as unknown as { reportRealInputTokens: (n: number, overhead?: unknown) => void };
  const original = spied.reportRealInputTokens.bind(strategy);
  spied.reportRealInputTokens = (n, overhead) => { samples.push({ total: n, overhead }); original(n, overhead); };
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are the resident.', strategy, ...agentConfig }],
    modules: [new ToolModule()],
    syncIntervalMs: 0,
  });
  const close = async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  return { framework, membrane, samples, close };
}

test('with a window, a request that ends on a message sends no trailing turn, and its sample carries none', async () => {
  const h = await harness({ physicalWindowTokens: 200_000 });
  try {
    h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await h.framework.runUntilIdle();
    const sent = h.membrane.calls[0];
    assert.ok(sent, 'the turn sent a request');
    assert.ok(!JSON.stringify(sent.messages).includes(CONTINUE_ROW), 'premise: the request ends on the message, with no [Continue]');
    assert.equal(h.samples.length, 1, 'one call, one sample');
    assert.deepEqual(h.samples[0].overhead, { system: sent.system, tools: sent.tools });
  } finally {
    await h.close();
  }
});

test('with a window, a request that ends on the agent\'s own reply sends [Continue], and its sample carries it, as the compile priced it', async () => {
  const h = await harness({ physicalWindowTokens: 200_000 });
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    cm.addMessage('User', [{ type: 'text', text: 'hello' }]);
    cm.addMessage('resident', [{ type: 'text', text: 'An earlier reply.' }]);
    (h.framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests
      .push({ agentName: 'resident', timestamp: Date.now(), reason: 'test-wake', source: 'test' });
    await h.framework.runUntilIdle();
    const sent = h.membrane.calls[0];
    assert.ok(sent, 'the turn sent a request');
    assert.deepEqual(sent.messages.at(-1)?.content, [{ type: 'text', text: CONTINUE_ROW }], 'premise: the request ends on [Continue]');
    assert.equal(h.samples.length, 1, 'one call, one sample');
    assert.deepEqual(h.samples[0].overhead, { system: sent.system, tools: sent.tools, messages: [[{ type: 'text', text: CONTINUE_ROW }]] });
  } finally {
    await h.close();
  }
});

test('with a window, a request that ends on tool results sends no trailing turn, and its sample carries none', async () => {
  const h = await harness({ physicalWindowTokens: 200_000 });
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    cm.addMessage('User', [{ type: 'text', text: 'hello' }]);
    cm.addMessage('resident', [{ type: 'tool_use', id: 'tu1', name: 'server--lookup', input: { id: 'a' } } as never]);
    cm.addMessage('User', [{ type: 'tool_result', toolUseId: 'tu1', content: 'found' } as never]);
    (h.framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests
      .push({ agentName: 'resident', timestamp: Date.now(), reason: 'test-wake', source: 'test' });
    await h.framework.runUntilIdle();
    const sent = h.membrane.calls[0];
    assert.ok(sent, 'the turn sent a request');
    assert.equal(sent.messages.at(-1)?.content[0]?.type, 'tool_result', 'premise: the request ends on the tool result');
    assert.equal(h.samples.length, 1, 'one call, one sample');
    assert.deepEqual(h.samples[0].overhead, { system: sent.system, tools: sent.tools });
  } finally {
    await h.close();
  }
});

test('the direct API reports its call as its compile\'s sample, with the overhead the compile priced', async () => {
  const h = await harness();
  try {
    h.membrane.pushResponse({
      ...createMockResponse([{ type: 'text', text: 'ok' }]),
      usage: { inputTokens: 700, outputTokens: 5, cacheCreationTokens: 100, cacheReadTokens: 2000 },
    } as never);
    const agent = h.framework.getAgent('resident')!;
    await agent.runInference(h.framework.getAllTools());
    const sent = h.membrane.calls[0];
    assert.ok(sent, 'the call was made');
    assert.equal(h.samples.length, 1, 'one call, one sample');
    assert.equal(h.samples[0].total, 2800, 'input + cache write + cache read');
    assert.deepEqual(h.samples[0].overhead, { system: sent.system, tools: sent.tools });
  } finally {
    await h.close();
  }
});
