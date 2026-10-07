/**
 * Operator-change admission for self-change tools (agent_settings,
 * tool presentation) made by an operator (puppet) or a module (host).
 *
 * The call is resolved to an absolute change (from-state and concrete
 * target) and the host's gate decides: staged returns a receipt and runs
 * nothing (a puppet stores no pair); apply runs exactly that change after
 * revalidating it; a failed gate refuses. The agent's own model calls never
 * reach the gate. applyResolvedOperatorChange later applies a staged change
 * under a held lease, refusing it as stale if it no longer holds, and its
 * admission lets only that change's call through.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, AutobiographicalStrategy, WorkspaceModule } from '../src/index.js';
import type {
  InferenceRequest,
  Module,
  ModuleContext,
  OperatorChangeDecision,
  ResolvedOperatorChange,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class Mover implements Module {
  readonly name = 'mover';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'set_budget', description: 'Change the caller budget.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return this.ctx.callTool!({
      id: 'delegated', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 130_000 }, callerAgentName: call.callerAgentName,
    });
  }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

type Internals = { pendingRequests: InferenceRequest[]; activeAdmissions: Map<string, unknown> };

describe('operator-change gate: self-change tools', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let mover: Mover;
  let asked: ResolvedOperatorChange[];
  let decide: (change: ResolvedOperatorChange) => Promise<OperatorChangeDecision>;
  let quiet: typeof console.log;

  const staged = async (change: ResolvedOperatorChange): Promise<OperatorChangeDecision> =>
    ({ decision: 'staged', receipt: { id: `rev-${asked.length}`, text: `staged ${change.kind} as rev-${asked.length}; waiting for scout` } });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'operator-gate-'));
    membrane = new MockMembrane();
    mover = new Mover();
    asked = [];
    decide = staged;
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [mover],
      operatorChangeGate: async (change) => { asked.push(structuredClone(change)); return decide(change); },
    });
    quiet = console.log;
    console.log = () => {};
  });
  afterEach(async () => {
    console.log = quiet;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const budget = () => framework.getAgentRuntimeSettings('scout').contextBudgetTokens;
  const pairs = () => (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string }> }>)
    .filter((m) => m.content[0]?.type === 'tool_use').length;

  it("stages an operator's settings change: a receipt, nothing run, no pair stored", async () => {
    const before = budget();
    const out = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    assert.equal(out.toolUseId, null);
    assert.equal(out.staged?.id, 'rev-1');
    assert.match(String(out.result.error), /staged agent-settings as rev-1/);
    assert.equal(budget(), before, 'unchanged');
    assert.equal(pairs(), 0, 'no pair testifies the tool ran');

    assert.equal(asked.length, 1);
    const change = asked[0]!;
    assert.equal(change.kind, 'agent-settings');
    assert.equal(change.surface, 'puppet');
    assert.equal(change.agent, 'scout');
    assert.deepEqual(change.kind === 'agent-settings' && { from: change.from, target: change.target },
      { from: { contextBudgetTokens: before }, target: { contextBudgetTokens: 120_000 } });
    assert.ok(framework.getOperatorLog().some((e) => e.kind === 'operator-change-staged'));
  });

  it('applies at once on apply, asking only once even though the call goes through two checks', async () => {
    decide = async () => ({ decision: 'apply' });
    const out = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    assert.equal(out.result.success, true, String(out.result.error));
    assert.equal(typeof out.toolUseId, 'string');
    assert.equal(budget(), 120_000);
    assert.equal(pairs(), 1);
    assert.equal(asked.length, 1);
    assert.equal((framework as unknown as Internals).activeAdmissions.size, 0, 'the admission ended with the call');
  });

  it('refuses when the gate fails, applying nothing', async () => {
    decide = async () => { throw new Error('journal unavailable'); };
    const before = budget();
    await assert.rejects(
      framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 }),
      /operator-change gate failed \(journal unavailable\)/,
    );
    assert.equal(budget(), before);
    assert.equal(pairs(), 0);
    assert.ok(framework.getOperatorLog().some((e) => e.kind === 'operator-change-refused'));
  });

  it('lets reads, and the agent\'s own model calls, through without asking', async () => {
    const read = await framework.puppetToolCall('scout', 'agent_settings', { action: 'get' });
    assert.equal(read.result.success, true);
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'toolu_own_1', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 140_000 } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    (framework as unknown as Internals).pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest,
    );
    await framework.runUntilIdle();
    assert.equal(budget(), 140_000, "the agent's own change applies");
    assert.equal(asked.length, 0, 'the gate was never asked');
  });

  it("stages a puppet's change made through a module, and a module's own change", async () => {
    const before = budget();
    const viaModule = await framework.puppetToolCall('scout', 'mover--set_budget', {});
    assert.match(String(viaModule.result.error), /staged agent-settings/, 'the wrapper sees the receipt');
    const own = await mover.ctx.callTool!({ id: 'own', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 150_000 }, callerAgentName: 'scout' });
    assert.match(String(own.error), /staged agent-settings/);
    assert.equal(budget(), before);
    assert.deepEqual(asked.map((c) => c.surface), ['puppet', 'host']);
  });

  it("lets invalid input through ungated, to the tool's own refusal", async () => {
    const out = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 'lots' });
    assert.equal(asked.length, 0, 'nothing to resolve, so nothing staged');
    assert.equal(out.result.isError, true);
  });

  it('admits only the exact call its admission was registered for, and revalidates it as it runs', async () => {
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    const change = asked[0]!;
    const admissions = (framework as unknown as Internals).activeAdmissions;
    admissions.set('adm-1', change);
    try {
      // Same admission, different input: not covered, so the gate is asked.
      const other = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 125_000 }, { admission: { id: 'adm-1' } });
      assert.equal(other.toolUseId, null);
      assert.equal(asked.length, 2);
      // The exact call, after the settings moved: refused at the moment it would run.
      framework.updateAgentRuntimeSettings('scout', { contextBudgetTokens: 110_000 });
      const covered = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 }, { admission: { id: 'adm-1' } });
      assert.equal(asked.length, 2, 'covered: not asked again');
      assert.match(String(covered.result.error), /no longer holds/);
      assert.equal(budget(), 110_000, 'nothing applied');
    } finally {
      admissions.delete('adm-1');
    }
  });

  it('ignores an admission nobody registered', async () => {
    const out = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 }, { admission: { id: 'forged' } });
    assert.equal(out.toolUseId, null, 'still staged');
    assert.equal(asked.length, 1);
  });

  it('applies a staged change under a lease as the puppet call it was, without asking again', async () => {
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    const change = asked[0]!;
    const applied = await framework.runAtSafeBoundary({ verb: 'apply rev-1' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-1' } }));
    assert.equal(applied.kind, 'agent-settings');
    assert.equal(budget(), 120_000);
    assert.equal(pairs(), 1, 'stored as the puppet act');
    assert.equal(asked.length, 1, 'not asked again');
    assert.ok(framework.getOperatorLog().some((e) => e.kind === 'operator-change-applied' && (e.params as { admission?: string })?.admission === 'rev-1'));
    assert.equal((framework as unknown as Internals).activeAdmissions.size, 0);
  });

  it('refuses a staged change as stale when the settings moved since', async () => {
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    const change = asked[0]!;
    framework.updateAgentRuntimeSettings('scout', { contextBudgetTokens: 110_000 }); // the agent changed it meanwhile
    await assert.rejects(
      framework.runAtSafeBoundary({ verb: 'apply rev-1' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-1' } })),
      (e: Error & { code?: string }) => e.code === 'stale' && /moved from/.test(e.message),
    );
    assert.equal(budget(), 110_000, 'the newer state stands');
  });

  it('resolves a reset to the concrete values it restores, and refuses if those change', async () => {
    framework.updateAgentRuntimeSettings('scout', { contextBudgetTokens: 120_000 });
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'reset', settings: ['context_budget_tokens'] });
    const change = asked[0]!;
    assert.equal(change.kind === 'agent-settings' && change.target.contextBudgetTokens, 100_000, 'the configured default, concretely');
    const agent = framework.getAgent('scout')! as unknown as { previewRuntimeSettingsTarget: (c: unknown) => unknown };
    const real = agent.previewRuntimeSettingsTarget.bind(agent);
    agent.previewRuntimeSettingsTarget = () => ({ contextBudgetTokens: 90_000 }); // the configuration says otherwise now
    try {
      await assert.rejects(
        framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
          framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-1' } })),
        (e: Error & { code?: string }) => e.code === 'stale' && /not the approved/.test(e.message),
      );
    } finally {
      agent.previewRuntimeSettingsTarget = real;
    }
    assert.equal(budget(), 120_000, 'nothing applied');
  });

  it("needs the held lease to apply, whether the change was an operator's or a module's", async () => {
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    await mover.ctx.callTool!({ id: 'own', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 150_000 }, callerAgentName: 'scout' });
    const [puppeted, moduleOwn] = asked;
    assert.deepEqual([puppeted!.surface, moduleOwn!.surface], ['puppet', 'host']);
    let stale: Parameters<Parameters<AgentFramework['runAtSafeBoundary']>[1]>[0] | null = null;
    await framework.runAtSafeBoundary({ verb: 'first' }, async (lease) => { stale = lease; });
    const before = budget();
    for (const change of [puppeted!, moduleOwn!]) {
      await assert.rejects(
        framework.applyResolvedOperatorChange(change, { lease: stale!, admission: { id: 'rev-x' } }),
        /not the lease currently held/,
      );
    }
    assert.equal(budget(), before, 'neither applied');
  });

  it("applies a module's staged change directly, under the lease", async () => {
    await mover.ctx.callTool!({ id: 'own', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 150_000 }, callerAgentName: 'scout' });
    const change = asked[0]!;
    await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-m' } }));
    assert.equal(budget(), 150_000);
    assert.equal(pairs(), 0, 'a module change stores no pair');
    assert.equal(asked.length, 1);
  });
});

describe('operator-change gate: tool presentation', () => {
  it('stages an operator\'s presentation edit with its from-state, and applies it later under a lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-gate-presentation-'));
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    const asked: ResolvedOperatorChange[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{
        name: 'ada', model: 'test', systemPrompt: '.',
        strategy: new AutobiographicalStrategy({ adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30000, kvStableReachTokens: 8000 }),
        toolPresentation: { path: join(dir, 'tools.json'), cataloguePath: 'board/tools.md' },
      }],
      modules: [workspace],
      operatorChangeGate: async (change) => {
        asked.push(structuredClone(change));
        return { decision: 'staged', receipt: { id: 'rev-p', text: 'staged' } };
      },
    });
    const quiet = console.log;
    console.log = () => {};
    try {
      const visible = () => framework.inspectToolPresentation('ada')!.entries.find((e) => e.name === 'workspace--glob')!.visible;
      const out = await framework.puppetToolCall('ada', 'set_tool_visibility', { name: 'workspace--glob', visible: false });
      assert.equal(out.toolUseId, null);
      assert.equal(visible(), true, 'not applied');
      const change = asked[0]!;
      assert.equal(change.kind, 'tool-presentation');
      assert.deepEqual(change.kind === 'tool-presentation' && { name: change.from.name, visible: change.from.visible }, { name: 'workspace--glob', visible: true });

      await framework.runAtSafeBoundary({ verb: 'apply rev-p' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-p' } }));
      assert.equal(visible(), false, 'applied under the lease');
      assert.equal(asked.length, 1);
    } finally {
      console.log = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
