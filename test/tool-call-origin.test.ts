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
import type { InferenceRequest, Module, ModuleContext, ResolvedOperatorChange, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class ProbeModule implements Module {
  readonly name = 'probe';
  readonly calls: ToolCall[] = [];
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return ['record', 'proxy', 'proxy_later'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  }
  /** Delegated work finished after the handler returned. */
  later?: Promise<unknown>;
  /** A callback the module schedules on its own, outside any tool call. */
  independently(callerAgentName: string): Promise<unknown> {
    return new Promise((resolve) => setImmediate(() => resolve(
      this.ctx.callTool!({ id: 'independent', name: 'probe--record', input: {}, callerAgentName }),
    )));
  }
  getUtilities(): ToolDefinition[] {
    return [{ name: 'util_record', description: 'Record the call, as a utility.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'proxy') {
      return this.ctx.callTool!({ id: 'nested', name: 'probe--record', input: {}, callerAgentName: call.callerAgentName });
    }
    if (call.name === 'proxy_later') {
      this.later = new Promise((resolve) => setTimeout(() => resolve(
        this.ctx.callTool!({ id: 'nested-later', name: 'probe--record', input: {}, callerAgentName: call.callerAgentName }),
      ), 5));
      return { success: true, data: 'scheduled' };
    }
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

  it("keeps the puppet's authorship when a module delegates to another tool, now or later", async () => {
    await framework.puppetToolCall('scout', 'probe--proxy', {});
    await framework.puppetToolCall('scout', 'probe--proxy_later', {});
    await probe.later;
    assert.deepEqual(probe.calls.map((c) => ({ id: c.id, origin: c.origin })), [
      { id: 'nested', origin: 'puppet' },
      { id: 'nested-later', origin: 'puppet' },
    ]);
  });

  it("keeps the model's authorship through delegation, and marks a module's own callback as the host's", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'toolu_model_2', name: 'probe--proxy', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    (framework as unknown as Internals).pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest,
    );
    await framework.runUntilIdle();
    await probe.independently('scout');
    assert.deepEqual(probe.calls.map((c) => ({ id: c.id, origin: c.origin })), [
      { id: 'nested', origin: undefined },
      { id: 'independent', origin: 'host' },
    ]);
  });
});

/**
 * The gate's boundary is call origin: only the agent's own model call, or
 * work that call started for that same agent, applies a self-change
 * directly. Each path below once labelled an imposed change as the agent's
 * own (found in #255's review); each must reach the gate now, as the actor
 * who imposed it, with nothing applied.
 */
class Delegator implements Module {
  readonly name = 'dlg';
  ctx!: ModuleContext;
  last?: Promise<ToolResult>;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return ['retarget', 'self_set', 'notify'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as { target?: string; tokens?: number };
    if (call.name === 'retarget') {
      return this.ctx.callTool({ id: 'r', name: 'agent_settings', input: budget(input.tokens ?? 131_000), callerAgentName: input.target });
    }
    if (call.name === 'self_set') {
      this.last = this.ctx.callTool({ id: 's', name: 'agent_settings', input: budget(input.tokens ?? 132_000), callerAgentName: call.callerAgentName });
      return this.last;
    }
    // notify: pushes an ordinary event and nothing more.
    this.ctx.pushEvent({ type: 'custom', name: 'dlg-notify', data: {} } as never);
    return { success: true, data: 'notified' };
  }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

/** A separate module that reacts to traces on its own: the host's actor. */
class Governor implements Module {
  readonly name = 'gov';
  ctx!: ModuleContext;
  now?: Promise<ToolResult>;
  later?: Promise<ToolResult>;
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    ctx.onTrace((ev) => {
      const event = ev as { type: string; processEvent?: { name?: string } };
      if (event.type !== 'process:received' || event.processEvent?.name !== 'dlg-notify' || this.now) return;
      this.now = ctx.callTool({ id: 'g1', name: 'agent_settings', input: budget(133_000), callerAgentName: 'scout' });
      this.later = new Promise((resolve) => setTimeout(() => resolve(
        ctx.callTool({ id: 'g2', name: 'agent_settings', input: budget(134_000), callerAgentName: 'scout' }),
      ), 5));
    });
  }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

const budget = (tokens: number) => ({ action: 'update', context_budget_tokens: tokens });

describe("tool-call origin: the agent's own, and nothing else, skips the gate", () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let dlg: Delegator;
  let gov: Governor;
  let framework: AgentFramework;
  let asked: ResolvedOperatorChange[];
  let quiet: { log: typeof console.log; error: typeof console.error };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'tool-call-origin-gate-'));
    membrane = new MockMembrane();
    dlg = new Delegator();
    gov = new Governor();
    asked = [];
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 },
        { name: 'other', model: 'test-model', systemPrompt: 'You are other.', maxTokens: 1000 },
      ],
      modules: [dlg, gov],
      codeExecution: { enabled: true },
      operatorChangeGate: async (change) => {
        asked.push(structuredClone(change));
        return { id: `rev-${asked.length}`, text: `staged ${change.kind}` };
      },
    });
    quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
  });
  afterEach(async () => {
    console.log = quiet.log;
    console.error = quiet.error;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const tokens = (agent = 'scout') => framework.getAgentRuntimeSettings(agent).contextBudgetTokens;
  const modelCalls = async (name: string, input: Record<string, unknown>) => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: `toolu_${name.replace(/\W/g, '')}`, name, input }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    (framework as unknown as Internals).pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest,
    );
    await framework.runUntilIdle();
  };
  const surfaces = () => asked.map((c) => `${c.agent}:${c.surface}`);

  it("applies the agent's own change, and one a module delegates for that same agent, directly", async () => {
    await modelCalls('agent_settings', budget(125_000));
    assert.equal(tokens(), 125_000);
    await modelCalls('dlg--self_set', { tokens: 126_000 });
    await dlg.last;
    assert.equal(tokens(), 126_000);
    assert.deepEqual(asked, [], 'the gate is never asked');
  });

  it("stages a change a module delegates for another agent from one agent's own call, as the host's", async () => {
    await modelCalls('dlg--retarget', { target: 'other', tokens: 131_000 });
    assert.deepEqual(surfaces(), ['other:host'], "scout's turn can't change other's body as other's own");
    assert.deepEqual([tokens('other'), tokens()], [100_000, 100_000]);
  });

  it('stages a delegated change from a tool-call event a module pushed on its own, as the host\'s unless it names the operator', async () => {
    const push = (callId: string, origin?: unknown) => dlg.ctx.pushEvent({
      type: 'tool-call', callId, agentName: 'scout', moduleName: 'dlg', toolName: 'self_set',
      call: { id: callId, name: 'dlg--self_set', input: {}, ...(origin !== undefined ? { origin } : {}) },
    } as never);
    push('pushed-1');
    await framework.runUntilIdle();
    await dlg.last;
    push('pushed-2', 'puppet');
    await framework.runUntilIdle();
    await dlg.last;
    assert.deepEqual(surfaces(), ['scout:host', 'scout:puppet']);
    assert.equal(tokens(), 100_000);
  });

  it("stages a change another module's trace listener makes during the agent's own call, and one it schedules, as the host's", async () => {
    await modelCalls('dlg--notify', {});
    assert.ok(gov.now, 'the listener fired');
    await gov.now;
    await gov.later;
    assert.deepEqual(surfaces(), ['scout:host', 'scout:host']);
    assert.equal(tokens(), 100_000);
  });

  it("reads an origin a module names as the host's unless it's 'puppet', never as the agent's own", async () => {
    for (const origin of ['', 0, false, Number.NaN, 'agent', 'PUPPET', {}]) {
      await dlg.ctx.callTool({ id: 'n', name: 'agent_settings', input: budget(136_000), callerAgentName: 'scout', origin } as unknown as ToolCall);
    }
    await dlg.ctx.callTool({ id: 'p', name: 'agent_settings', input: budget(137_000), callerAgentName: 'scout', origin: 'puppet' });
    for (const origin of [null, undefined]) {
      await dlg.ctx.callTool({ id: 'u', name: 'agent_settings', input: budget(138_000), callerAgentName: 'scout', origin } as unknown as ToolCall);
    }
    await framework.executeToolCall({ id: 'x', name: 'agent_settings', input: budget(139_000), callerAgentName: 'scout', origin: '' } as unknown as ToolCall);
    assert.deepEqual(surfaces(), [
      ...Array(7).fill('scout:host'),
      'scout:puppet',
      'scout:host', 'scout:host', // no origin and no call behind it: the host
      'scout:host', // the public entry normalizes too
    ]);
    assert.equal(tokens(), 100_000);
  });

  it('refuses a tool call from a task a script left running, after its exec and during a later one', async () => {
    framework.start();
    const settle = (name: string) => [
      `for _ in range(500):`,
      `    if "${name}" in globals(): break`,
      `    await asyncio.sleep(0.01)`,
    ];
    // The puppet's script leaves a task that calls after its exec has ended.
    const first = await framework.puppetToolCall('scout', 'code_execution', {
      code: [
        'import asyncio',
        'async def _after():',
        '    await asyncio.sleep(0.3)',
        '    globals()["late1"] = await agent_settings({"action": "update", "context_budget_tokens": 134000})',
        'asyncio.ensure_future(_after())',
        'print("scheduled")',
      ].join('\n'),
    });
    assert.equal(first.result.success, true, String(first.result.error));
    const out = first.result.data as { stdout: string; stderr: string };
    assert.equal(out.stdout.trim(), 'scheduled');
    assert.match(out.stderr, /1 task\(s\) this script started were still running when it ended/);

    // The next one reads what that task got back, and leaves a task that
    // calls only once the agent's own script is running.
    const second = await framework.puppetToolCall('scout', 'code_execution', {
      code: [
        'import asyncio',
        ...settle('late1'),
        'print(late1)',
        'async def _during():',
        '    while not globals().get("agent_running"):',
        '        await asyncio.sleep(0.01)',
        '    globals()["late2"] = await agent_settings({"action": "update", "context_budget_tokens": 135000})',
        'asyncio.ensure_future(_during())',
      ].join('\n'),
    });
    assert.match((second.result.data as { stdout: string }).stdout, /earlier code_execution script left running/);

    // The agent's own script waits for that call, then makes its own.
    await modelCalls('code_execution', {
      code: [
        'import asyncio',
        'agent_running = True',
        ...settle('late2'),
        'print(await agent_settings({"action": "update", "context_budget_tokens": 126000}))',
      ].join('\n'),
    });
    assert.equal(tokens(), 126_000, "the agent's own script applies its own change");
    assert.deepEqual(asked, [], 'neither leftover call reached the gate: both were refused');
    assert.match(await readGlobal(framework, 'late2'), /earlier code_execution script left running/,
      "the puppet's task, firing during the agent's own exec, was refused");
  });

  it("refuses a call from a thread the script started, which can't be traced to it, while serving the script's own", async () => {
    framework.start();
    const { result } = await framework.puppetToolCall('scout', 'code_execution', {
      code: [
        'import asyncio, threading',
        'loop = asyncio.get_running_loop()',
        'box = {}',
        'def worker():',
        '    box["thread"] = asyncio.run_coroutine_threadsafe(',
        '        agent_settings({"action": "update", "context_budget_tokens": 140000}), loop).result(timeout=10)',
        't = threading.Thread(target=worker)',
        't.start()',
        'while t.is_alive():',
        '    await asyncio.sleep(0.02)',
        'print(box["thread"])',
        'print(await agent_settings({"action": "update", "context_budget_tokens": 141000}))',
      ].join('\n'),
    });
    assert.equal(result.success, true, String(result.error));
    assert.match((result.data as { stdout: string }).stdout, /can't be traced to the running code_execution script/);
    assert.deepEqual(surfaces(), ['scout:puppet'], "only the script's own call reached the gate, as the puppet's");
    assert.equal(tokens(), 100_000);
  });

  it('says nothing of tasks that finished with the script, or of a thread it joined', async () => {
    framework.start();
    const { result } = await framework.puppetToolCall('scout', 'code_execution', {
      code: [
        'import asyncio, threading',
        'await asyncio.gather(*(asyncio.sleep(0.01) for _ in range(3)))',
        't = threading.Thread(target=lambda: None)',
        't.start()',
        't.join()',
        'print("done")',
      ].join('\n'),
    });
    assert.equal(result.success, true, String(result.error));
    assert.deepEqual(result.data && { stdout: (result.data as { stdout: string }).stdout.trim(), stderr: (result.data as { stderr: string }).stderr }, { stdout: 'done', stderr: '' });
  });

  it("keeps a background script's calls its starter's for its whole life", async () => {
    framework.start();
    const started = await framework.puppetToolCall('scout', 'code_execution', {
      code: ['import asyncio', 'await asyncio.sleep(0.2)', 'await agent_settings({"action": "update", "context_budget_tokens": 142000})'].join('\n'),
      background: true,
    });
    assert.equal(started.result.success, true, String(started.result.error));
    const deadline = Date.now() + 10_000;
    while (asked.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(surfaces(), ['scout:puppet']);
    assert.equal(tokens(), 100_000);
  });
});

/** A script global, read by a host script. */
async function readGlobal(framework: AgentFramework, name: string): Promise<string> {
  const read = await framework.executeToolCall({
    id: `read-${name}`, name: 'code_execution', input: { code: `print(${name})` }, callerAgentName: 'scout', origin: 'host',
  });
  return (read.data as { stdout?: string } | undefined)?.stdout ?? String(read.error);
}
