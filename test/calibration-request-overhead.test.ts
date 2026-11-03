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
