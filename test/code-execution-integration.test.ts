import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class Gates implements Module {
  readonly name = 'gate';
  readonly waiting = new Map<string, (result: ToolResult) => void>();
  async start(_ctx: ModuleContext) {}
  async stop() { for (const resolve of this.waiting.values()) resolve({ success: true }); }
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for the test barrier.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } } }];
  }
  handleToolCall(call: ToolCall): Promise<ToolResult> {
    return new Promise(resolve => this.waiting.set(String((call.input as { key: string }).key), resolve));
  }
  async onProcess(event: ProcessEvent) {
    return event.type === 'external-message' ? { requestInference: true } : {};
  }
  release(key: string, endTurn = false) {
    const resolve = this.waiting.get(key);
    assert.ok(resolve, `barrier ${key} was reached`);
    this.waiting.delete(key);
    resolve({ success: true, data: key, ...(endTurn ? { endTurn: true } : {}) });
  }
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const endTurn of [false, true]) {
  it(`completion ${endTurn ? 'still wakes after an ending' : 'does not wake again after a continuing'} tool boundary`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-integration-'));
    const membrane = new MockMembrane();
    const gates = new Gates();
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'start', name: 'code_execution',
      input: { code: 'await gate__wait({"key": "python"})\nprint("completion-at-boundary")', wait_ms: 0 } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'boundary', name: 'gate--wait',
      input: { key: 'boundary' } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continuation complete' }]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'worker', model: 'test', systemPrompt: 'test' }],
      modules: [gates], syncIntervalMs: 0, codeExecution: { enabled: true },
    });
    let completionQueued = false;
    framework.onTrace(event => {
      if (event.type === 'message:added' && event.source?.startsWith('background-script:')) completionQueued = true;
    });
    try {
      await framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'start', metadata: {} } as ProcessEvent);
      await until(() => gates.waiting.has('python') && gates.waiting.has('boundary'), 'both barriers');
      const originalStream = membrane.lastStream!;
      gates.release('python');
      await until(() => completionQueued, 'script completion notification');
      // The wake is queued while the model is waiting for a different tool.
      gates.release('boundary', endTurn);
      if (endTurn) {
        await until(() => membrane.calls.length === 2, 'completion wake after endTurn');
        assert.match(JSON.stringify(membrane.calls[1]), /completion-at-boundary/);
        assert.equal(originalStream.receivedToolResultOptions.length, 1, 'no continuation after endTurn');
      } else {
        await until(() => originalStream.receivedToolResultOptions.length === 2, 'live injection');
        assert.match(JSON.stringify(originalStream.receivedToolResultOptions[1]), /completion-at-boundary/);
        await until(() => framework.getAgent('worker')!.state.status === 'idle' || membrane.calls.length > 1, 'turn settlement');
        // Let the scheduler process any wake left queued by the boundary.
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(membrane.calls.length, 1, 'an already delivered completion must not buy another inference');
      }
    } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

it('shutdown releases script waiters and tolerates tool results arriving after the queue closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-shutdown-'));
  const gates = new Gates();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'worker', model: 'test', systemPrompt: 'test' }],
    modules: [gates], syncIntervalMs: 0, codeExecution: { enabled: true },
  });
  let stopped = false;
  try {
    await framework.start();
    await framework.executeToolCall({ id: 'start', name: 'code_execution', callerAgentName: 'worker',
      input: { code: 'await gate__wait({"key": "shutdown"})', wait_ms: 0 } });
    await until(() => gates.waiting.has('shutdown'), 'script inner call');
    // Module.stop resolves the tool after the framework closes its queue.
    await framework.stop();
    stopped = true;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((framework as unknown as { scriptToolWaiters: Map<string, unknown> }).scriptToolWaiters.size, 0);
  } finally { if (!stopped) await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('keeps execution-limit notices across observations and counts background interpreters separately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-limits-'));
  const gates = new Gates();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'worker', model: 'test', systemPrompt: 'test' }],
    modules: [gates], syncIntervalMs: 0,
    codeExecution: { enabled: true, scriptTimeoutMs: 60_000, maxScriptTimeoutMs: 120_000 },
  });
  const call = (input: Record<string, unknown>) => framework.executeToolCall({
    id: 'accept', name: 'code_execution', callerAgentName: 'worker', input,
  });
  try {
    await framework.start();
    const start = await call({ code: 'await gate__wait({"key": "foreground"})', wait_ms: 0, time_limit_ms: 180_000 });
    const foreground = start.data as { script_id: string; time_limit_note: string };
    assert.match(foreground.time_limit_note, /capped at 120000/);
    const bg = await call({ code: 'await gate__wait({"key": "background"})', background: true });
    await until(() => gates.waiting.size === 2, 'foreground and background');
    assert.equal(framework.getHostModeStatus().backgroundScripts, 1);
    const waiting = call({ action: 'wait', script_id: foreground.script_id, wait_ms: 5000 });
    gates.release('foreground');
    const finished = await waiting;
    assert.equal((finished.data as { time_limit_note: string }).time_limit_note, foreground.time_limit_note);
    const retained = await call({ action: 'wait', script_id: foreground.script_id, wait_ms: 0 });
    assert.equal((retained.data as { time_limit_note: string }).time_limit_note, foreground.time_limit_note);
    await call({ action: 'cancel', script_id: (bg.data as { script_id: string }).script_id });
    assert.equal(framework.getHostModeStatus().backgroundScripts, 0);
    const next = await call({ code: 'print("next")', wait_ms: 5000 });
    assert.equal((next.data as { time_limit_note?: string }).time_limit_note, undefined, 'override does not leak to later runs');
  } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
});
