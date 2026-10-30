import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolDefinition, ToolResult } from '../src/index.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class WordlessWorkspace implements Module {
  readonly name = 'workspace';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text }] }], requestInference: true };
  }
  getTools(): ToolDefinition[] {
    return [{ name: 'read_image', description: 'read_image', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> { throw new Error(); }
  async writeBinary(): Promise<{ success: boolean }> { return { success: false }; }
  async readBinary(): Promise<{ error: string }> { return { error: 'not used' }; }
}

test('a failed tool whose result holds no error text traces tool:failed with words for its error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-failed-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call-read', name: 'read_image', input: { path: 'board/x.png' } }], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [new WordlessWorkspace()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  t.after(() => framework.stop().catch(() => {}));
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });

  framework.pushEvent({ type: 'external-message', source: 'test', content: 'Look.', metadata: {} });
  await framework.runUntilIdle();

  const outcomes = traces.flatMap((event) =>
    (event.type === 'tool:failed' || event.type === 'tool:completed') && event.callId === 'call-read'
      ? [{ type: event.type, error: event.type === 'tool:failed' ? event.error : undefined }]
      : []);
  assert.deepEqual(outcomes, [{ type: 'tool:failed', error: 'tool returned an error' }]);
});
