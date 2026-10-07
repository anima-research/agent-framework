/**
 * Who initiated a tool call travels with it.
 *
 * puppetToolCall stamps origin 'puppet' (and any admission the host passed);
 * ModuleContext.callTool stamps 'host'; the agent's own model calls carry
 * none. The stamp survives the framework's redispatches: the utils
 * meta-tool's reconstruction and code_execution's inner calls. A puppeted
 * agent_settings reaches the agent_settings handler (it used to fall
 * through to module-name parsing as "Invalid tool name format").
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest, Module, ModuleContext, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class ProbeModule implements Module {
  readonly name = 'probe';
  readonly calls: ToolCall[] = [];
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'record', description: 'Record the call.', inputSchema: { type: 'object', properties: {} } }];
  }
  getUtilities(): ToolDefinition[] {
    return [{ name: 'util_record', description: 'Record the call, as a utility.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { recorded: call.name } };
  }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

type Internals = {
  runAgentSettingsToolCall: (agentName: string, call: ToolCall) => ToolResult;
  pendingRequests: InferenceRequest[];
};

const provenance = (c: ToolCall) => ({ origin: c.origin, admission: c.admission?.id });

describe('tool-call origin', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let probe: ProbeModule;
  let framework: AgentFramework;
  let quiet: typeof console.log;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tool-call-origin-'));
    membrane = new MockMembrane();
    probe = new ProbeModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [probe],
      codeExecution: { enabled: true },
    });
    quiet = console.log;
    console.log = () => {};
  });
  afterEach(async () => {
    console.log = quiet;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a puppeted agent_settings reaches the agent_settings handler, as an operator', async () => {
    const i = framework as unknown as Internals;
    const seen: Array<{ origin?: string }> = [];
    const real = i.runAgentSettingsToolCall.bind(framework);
    i.runAgentSettingsToolCall = (agentName, call) => {
      seen.push({ origin: call.origin });
      return real(agentName, call);
    };

    const got = await framework.puppetToolCall('scout', 'agent_settings', { action: 'get' });
    assert.equal(got.result.success, true, String(got.result.error));
    assert.equal(typeof (got.result.data as { contextBudgetTokens?: unknown }).contextBudgetTokens, 'number');

    const updated = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    assert.equal(updated.result.success, true, String(updated.result.error));
    assert.equal(framework.getAgentRuntimeSettings('scout').contextBudgetTokens, 120_000);
    assert.deepEqual(seen, [{ origin: 'puppet' }, { origin: 'puppet' }]);

    const types = (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string }> }>)
      .map((m) => m.content[0]?.type);
    assert.deepEqual(types, ['tool_use', 'tool_result', 'tool_use', 'tool_result'], 'both pairs stored');
  });

  it('origin and admission survive the utils meta-tool', async () => {
    const { result } = await framework.puppetToolCall(
      'scout', 'utils', { action: 'run', name: 'probe--util_record', args: {} }, { admission: { id: 'chg-7' } },
    );
    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(probe.calls.map(provenance), [{ origin: 'puppet', admission: 'chg-7' }]);
  });

  it("marks a module's callTool as the host's", async () => {
    await probe.ctx.callTool!({ id: 'host-1', name: 'probe--record', input: {}, callerAgentName: 'scout' });
    assert.deepEqual(probe.calls.map(provenance), [{ origin: 'host', admission: undefined }]);
  });

  it("leaves the agent's own model calls unmarked", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'toolu_model_1', name: 'probe--record', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    (framework as unknown as Internals).pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest,
    );
    await framework.runUntilIdle();
    assert.deepEqual(probe.calls.map(provenance), [{ origin: undefined, admission: undefined }]);
  });

  it("carries origin and admission into code_execution's inner calls (real python3), and only for that script", async () => {
    framework.start();
    const code = ['await probe__record({})', 'print("ok")'].join('\n');
    const { result } = await framework.puppetToolCall('scout', 'code_execution', { code }, { admission: { id: 'chg-9' } });
    assert.equal(result.success, true, String(result.error));
    assert.equal((result.data as { stdout?: string }).stdout?.trim(), 'ok');
    assert.equal(probe.calls.length, 1);
    assert.match(String(probe.calls[0]!.id), /^pytc-/, 'an inner call');
    assert.deepEqual(provenance(probe.calls[0]!), { origin: 'puppet', admission: 'chg-9' });

    // A later script the operator didn't start carries nothing over.
    const hostRun = await probe.ctx.callTool!({ id: 'host-ce', name: 'code_execution', input: { code }, callerAgentName: 'scout' });
    assert.equal(hostRun.success, true, String(hostRun.error));
    assert.deepEqual(provenance(probe.calls[1]!), { origin: 'host', admission: undefined });
  });
});
