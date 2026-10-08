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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { join } from 'node:path';
import WebSocket from 'ws';
import { AgentFramework, ApiServer, AutobiographicalStrategy, ResumeBlockedError, WorkspaceModule } from '../src/index.js';
import type {
  AgentSettingsExtension,
  InferenceRequest,
  Module,
  ModuleContext,
  OperatorChangeReceipt,
  ResolvedOperatorChange,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

class Mover implements Module {
  readonly name = 'mover';
  ctx!: ModuleContext;
  /** Resolves `hold` once released. */
  release?: () => void;
  entered?: () => void;
  /** The delegated change `set_budget_later` makes after its call returned. */
  later?: Promise<ToolResult>;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return ['set_budget', 'hold', 'set_budget_later'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const change = (id: string, tokens = 130_000) => this.ctx.callTool!({
      id, name: 'agent_settings', input: { action: 'update', context_budget_tokens: tokens }, callerAgentName: call.callerAgentName,
    });
    if (call.name === 'hold') {
      this.entered?.();
      await new Promise<void>((resolve) => { this.release = resolve; });
      return { success: true, data: 'held' };
    }
    if (call.name === 'set_budget_later') {
      let fire!: () => void;
      const fired = new Promise<void>((resolve) => { fire = resolve; });
      this.later = fired.then(() => change('late', 160_000));
      (this as { fireLater?: () => void }).fireLater = fire;
      return { success: true, data: 'scheduled' };
    }
    return change('delegated');
  }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

/** A synthetic host settings extension: `knob`, with a configurable default. */
class Knobs implements Module {
  readonly name = 'knobs';
  value = 7;
  defaultValue = 3;
  failGet = false;
  canPreview = true;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
  getAgentSettingsExtension(): AgentSettingsExtension {
    const read = () => {
      if (this.failGet) throw new Error('knob store unavailable');
      return { knob: this.value };
    };
    return {
      properties: { knob: { type: 'number' } },
      keys: ['knob'],
      get: read,
      update: (_agent, patch) => { this.value = Number(patch.knob); return read(); },
      reset: () => { this.value = this.defaultValue; return read(); },
      ...(this.canPreview ? {
        preview: (_agent: string, change: { action: 'update'; patch: Record<string, unknown> } | { action: 'reset'; keys?: string[] }) =>
          change.action === 'update' ? { knob: Number(change.patch.knob) } : { knob: this.defaultValue },
      } : {}),
    };
  }
}

type Internals = { pendingRequests: InferenceRequest[]; activeAdmissions: Map<string, unknown> };

describe('operator-change gate: self-change tools', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let mover: Mover;
  let knobs: Knobs;
  let asked: ResolvedOperatorChange[];
  let decide: (change: ResolvedOperatorChange) => Promise<OperatorChangeReceipt>;
  let quiet: typeof console.log;

  const staged = async (change: ResolvedOperatorChange): Promise<OperatorChangeReceipt> =>
    ({ id: `rev-${asked.length}`, text: `staged ${change.kind} as rev-${asked.length}; waiting for scout` });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'operator-gate-'));
    membrane = new MockMembrane();
    mover = new Mover();
    knobs = new Knobs();
    asked = [];
    decide = staged;
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [mover, knobs],
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

  it('reads input exactly as the handler does: a numeric string is a change, and it is staged', async () => {
    const before = budget();
    const out = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: '120000' });
    assert.equal(out.toolUseId, null, 'staged, not run');
    assert.equal(budget(), before);
    assert.deepEqual(asked[0]!.kind === 'agent-settings' && asked[0]!.target, { contextBudgetTokens: 120_000 });
  });

  it("refuses a change it can't resolve, without running it or asking", async () => {
    const before = budget();
    const viaPuppet = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 'lots' });
    assert.equal(viaPuppet.toolUseId, null, 'no pair: nothing ran');
    assert.match(String(viaPuppet.result.error), /couldn't be resolved/);
    const viaModule = await mover.ctx.callTool!({ id: 'bad', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 'lots' }, callerAgentName: 'scout' });
    assert.match(String(viaModule.error), /couldn't be resolved/);
    assert.equal(asked.length, 0);
    assert.equal(budget(), before);
    assert.equal(pairs(), 0);
  });

  it('resolves a mixed core and extension change through each owner, and applies both later', async () => {
    await framework.puppetToolCall('scout', 'agent_settings', {
      action: 'update', context_budget_tokens: 120_000, tool_result_inline_max_chars: 4321.7, knob: 11,
    });
    const change = asked[0]!;
    assert.deepEqual(change.kind === 'agent-settings' && change.extensions, {
      from: { tool_result_inline_max_chars: null, knob: 7 },
      target: { tool_result_inline_max_chars: 4321, knob: 11 },
    }, 'normalized by the owner');
    await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-1' } }));
    assert.equal(budget(), 120_000);
    assert.equal(knobs.value, 11);
  });

  it("refuses a change to an extension whose reader fails, or that can't preview", async () => {
    knobs.failGet = true;
    const failing = await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', knob: 11 });
    assert.match(String(failing.result.error), /couldn't be resolved \(knob store unavailable\)/);
    knobs.failGet = false;
    knobs.canPreview = false;
    const opaque = await framework.puppetToolCall('scout', 'agent_settings', { action: 'reset', settings: ['knob'] });
    assert.match(String(opaque.result.error), /can't preview a change/);
    assert.equal(asked.length, 0);
    assert.equal(knobs.value, 7, 'nothing changed');
  });

  it("refuses an extension reset once the owner's default moved, rather than replaying it", async () => {
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'reset', settings: ['knob'] });
    const change = asked[0]!;
    assert.deepEqual(change.kind === 'agent-settings' && change.extensions, { from: { knob: 7 }, target: { knob: 3 } });
    knobs.defaultValue = 9; // the current value stays 7
    await assert.rejects(
      framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-1' } })),
      (e: Error & { code?: string }) => e.code === 'stale' && /host-managed settings/.test(e.message),
    );
    assert.equal(knobs.value, 7);
  });

  it('refuses a staged change once the active branch moved, even with the settings unchanged', async () => {
    await framework.puppetToolCall('scout', 'agent_settings', { action: 'update', context_budget_tokens: 120_000 });
    const change = asked[0]!;
    const store = framework.getStore();
    store.createBranch('changed');
    store.switchBranch('changed');
    await assert.rejects(
      framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-1' } })),
      (e: Error & { code?: string }) => e.code === 'stale' && /active branch moved/.test(e.message),
    );
  });

  it('stages a delegated change made after its puppet call returned, never running it', async () => {
    const before = budget();
    await framework.puppetToolCall('scout', 'mover--set_budget_later', {}); // a module tool: runs, schedules the change
    (mover as unknown as { fireLater: () => void }).fireLater();
    const late = await mover.later!;
    assert.match(String(late.error), /staged agent-settings/, 'it keeps its actor, so it is gated, and only staged');
    assert.equal(asked.at(-1)!.surface, 'puppet');
    assert.equal(budget(), before);
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

describe('operator-change gate: settings an action changes without naming them', () => {
  it('stages the default pace a paced descent installs, for an update and a budget reset, and refuses it as stale once a pace is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-gate-pace-'));
    const asked: ResolvedOperatorChange[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{
        name: 'ada', model: 'test', systemPrompt: '.', maxTokens: 10_000, contextBudgetTokens: 100_000,
        // No kvStableReachTokens: no pace is set until a descent installs one.
        strategy: new AutobiographicalStrategy({ adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000 }),
      }],
      modules: [],
      operatorChangeGate: async (change) => {
        asked.push(structuredClone(change));
        return { id: `rev-${asked.length}`, text: 'staged' };
      },
    });
    const quiet = console.log;
    console.log = () => {};
    try {
      const apply = (change: ResolvedOperatorChange) => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: change.id } }));
      const settings = () => framework.getAgentRuntimeSettings('ada');

      await framework.puppetToolCall('ada', 'agent_settings', { action: 'update', context_budget_tokens: 60_000 });
      const decrease = asked[0]!;
      assert.ok(decrease.kind === 'agent-settings');
      assert.deepEqual([decrease.from, decrease.target], [
        { contextBudgetTokens: 100_000, transitionPaceTokens: null },
        { contextBudgetTokens: 60_000, transitionPaceTokens: 16_000 },
      ], 'the approval shows the pace the descent installs');
      framework.updateAgentRuntimeSettings('ada', { transitionPaceTokens: 4_000 }); // a pace set meanwhile
      await assert.rejects(apply(decrease), (e: Error & { code?: string }) => e.code === 'stale');
      assert.equal(settings().contextBudgetTokens, 100_000, 'nothing applied');

      // A budget-only reset that starts a descent, with no pace set.
      framework.updateAgentRuntimeSettings('ada', { contextBudgetTokens: 150_000 });
      framework.resetAgentRuntimeSettings('ada', ['transitionPaceTokens']);
      await framework.puppetToolCall('ada', 'agent_settings', { action: 'reset', settings: ['context_budget_tokens'] });
      const reset = asked[1]!;
      assert.ok(reset.kind === 'agent-settings');
      assert.deepEqual([reset.from, reset.target], [
        { contextBudgetTokens: 150_000, transitionPaceTokens: null },
        { contextBudgetTokens: 100_000, transitionPaceTokens: 16_000 },
      ]);
      await apply(reset);
      assert.deepEqual(
        { contextBudgetTokens: settings().contextBudgetTokens, transitionPaceTokens: settings().transitionPaceTokens },
        reset.target,
        'applied exactly what was approved',
      );
    } finally {
      console.log = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
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
        return { id: 'rev-p', text: 'staged' };
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

      const store = framework.getStore();
      const main = store.currentBranch().name;
      store.createBranch('elsewhere');
      store.switchBranch('elsewhere');
      await assert.rejects(
        framework.runAtSafeBoundary({ verb: 'apply rev-p' }, (lease) =>
          framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-p' } })),
        (e: Error & { code?: string }) => e.code === 'stale' && /active branch moved/.test(e.message),
      );
      store.switchBranch(main);
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

  it('stages a description reset with the wording it exposes, and refuses it as stale when that wording moves under an unchanged personal description', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-gate-reset-target-'));
    const profile = join(dir, 'workspace-defaults.json');
    const personal = join(dir, 'tools.json');
    writeFileSync(profile, JSON.stringify({ version: 1, tools: { 'workspace--glob': { description: 'default wording A' } } }));
    writeFileSync(personal, JSON.stringify({ version: 1, tools: { 'workspace--glob': { description: 'mine' } } }));
    const workspace = new WorkspaceModule({ mounts: [{ name: 'board', path: dir, mode: 'read-write', watch: 'never' }] });
    const asked: ResolvedOperatorChange[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{
        name: 'ada', model: 'test', systemPrompt: '.',
        strategy: new AutobiographicalStrategy({ adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30000, kvStableReachTokens: 8000 }),
        toolPresentation: { path: personal, cataloguePath: 'board/tools.md', defaults: [{ source: 'Module: workspace', path: profile }] },
      }],
      modules: [workspace],
      operatorChangeGate: async (change) => {
        asked.push(structuredClone(change));
        return { id: `rev-${asked.length}`, text: 'staged' };
      },
    });
    const quiet = console.log;
    console.log = () => {};
    try {
      const shown = () => framework.inspectToolPresentation('ada')!.entries.find((e) => e.name === 'workspace--glob')!.description;
      const apply = (change: ResolvedOperatorChange) => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: change.id } }));
      const reset = { name: 'workspace--glob', description: null };

      await framework.puppetToolCall('ada', 'set_tool_description', reset);
      const first = asked[0]!;
      assert.ok(first.kind === 'tool-presentation');
      assert.deepEqual([first.from.description, first.target.description], ['mine', 'default wording A'],
        'the approval shows the wording the reset exposes');

      // The default changes while the personal description, all `from` sees, stays.
      writeFileSync(profile, JSON.stringify({ version: 1, tools: { 'workspace--glob': { description: 'default wording B' } } }));
      assert.equal(shown(), 'mine');
      await assert.rejects(apply(first), (e: Error & { code?: string }) =>
        e.code === 'stale' && /would now leave workspace--glob/.test(e.message) && /default wording B/.test(e.message));
      assert.equal(shown(), 'mine', 'nothing applied');

      await framework.puppetToolCall('ada', 'set_tool_description', reset);
      const second = asked[1]!;
      assert.ok(second.kind === 'tool-presentation');
      assert.equal(second.target.description, 'default wording B');
      await apply(second);
      assert.equal(shown(), 'default wording B', 'exactly the approved wording');

      // An edit the presentation would refuse is refused at staging, never staged.
      const refused = await framework.puppetToolCall('ada', 'set_tool_description', { name: 'workspace--glob', description: 7 });
      assert.equal(refused.staged, undefined);
      assert.match(String(refused.result.error), /couldn't be resolved .*Invalid description/);
      assert.equal(asked.length, 2);
    } finally {
      console.log = quiet;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operator-change gate: host/command undo by turns', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let asked: ResolvedOperatorChange[];
  let decide: (change: ResolvedOperatorChange) => Promise<OperatorChangeReceipt>;
  let quiet: { log: typeof console.log; error: typeof console.error };
  type HostInternals = {
    pendingRequests: InferenceRequest[];
    redoStacks: Map<string, Array<{ branchName: string; checkpoints: unknown[] }>>;
    getTurnCheckpoints(agent: string): Array<{ turnIndex: number }>;
    saveTurnCheckpoints(agent: string, list: unknown[]): void;
    handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    addMessage(participant: string, content: unknown[]): string;
  };
  const host = () => framework as unknown as HostInternals;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'operator-gate-undo-'));
    membrane = new MockMembrane();
    asked = [];
    decide = async (change) => ({ id: 'rev-u', text: `staged ${change.kind}` });
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (change) => { asked.push(structuredClone(change)); return decide(change); },
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

  const turn = async (text: string) => {
    host().addMessage('user', [{ type: 'text', text }]);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply to ${text}` }]));
    host().pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest);
    await framework.runUntilIdle();
  };
  const texts = () => (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ text?: string }> }>)
    .map((m) => m.content[0]?.text ?? '');
  const branch = () => framework.getStore().currentBranch().name;
  const undo = (turns: number) => host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', turns, requesterName: 'nissa' });

  it('stages an undo as the exact checkpoints it would undo, changing nothing', async () => {
    await turn('one'); await turn('two'); await turn('three');
    const before = { branch: branch(), texts: texts(), checkpoints: host().getTurnCheckpoints('scout').length };
    const r = await undo(2);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'staged');
    assert.deepEqual(r.staged, { id: 'rev-u' });
    assert.deepEqual({ branch: branch(), texts: texts(), checkpoints: host().getTurnCheckpoints('scout').length }, before);
    const change = asked[0]!;
    assert.equal(change.kind, 'undo-turns');
    assert.equal(change.kind === 'undo-turns' && change.requestedTurns, 2);
    assert.deepEqual(change.kind === 'undo-turns' && change.checkpoints.map((c) => c.turnIndex), [2, 1], 'newest first');
    assert.equal(change.sourceBranch, before.branch);
  });

  it('applies a staged multi-turn undo as one cut with one redo entry', async () => {
    await turn('one'); await turn('two'); await turn('three');
    const source = branch();
    const r = await undo(2);
    assert.deepEqual([r.ok, r.code], [false, 'staged'], 'host/command only stages');
    const change = asked[0]!;
    const applied = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    assert.deepEqual(applied.kind === 'undo-turns' && [applied.undone, applied.requested], [2, 2]);
    assert.equal(branch(), `undo/scout/op-${change.id}`, 'the destination is named for the change');
    // A turn's checkpoint is taken after its input landed, so undoing turns
    // keeps the oldest undone turn's input, exactly as the per-turn loop does.
    assert.deepEqual(texts(), ['one', 'reply to one', 'two'], 'turns two and three are undone');
    assert.equal(host().getTurnCheckpoints('scout').length, 1);
    assert.equal(host().redoStacks.get('scout')!.length, 1, 'one redo entry');

    const redone = framework.redo('scout');
    assert.equal(redone.toBranch, source, 'one redo restores the source tip');
    assert.deepEqual(texts(), ['one', 'reply to one', 'two', 'reply to two', 'three', 'reply to three']);
    assert.equal(host().getTurnCheckpoints('scout').length, 3, 'and every checkpoint the cut removed');
  });

  it('applies a staged undo later under a lease, dropping the answer turn added since without going stale', async () => {
    await turn('one'); await turn('two'); await turn('three');
    await undo(2);
    const change = asked[0]!;
    await turn('notice and answer'); // same branch: a newer turn, not a conflict
    const applied = await framework.runAtSafeBoundary({ verb: 'apply rev-u' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    assert.deepEqual(applied.kind === 'undo-turns' && [applied.requested, applied.undone], [2, 2]);
    assert.deepEqual(texts(), ['one', 'reply to one', 'two'], 'the staged turns and the answer turn are undone');
    assert.equal(host().getTurnCheckpoints('scout').length, 1, 'staged and newer checkpoints removed');
    framework.redo('scout');
    assert.equal(texts().at(-1), 'reply to notice and answer', 'one redo restores the source tip, answer turn included');
    assert.equal(host().getTurnCheckpoints('scout').length, 4, 'with every checkpoint');
    assert.ok(framework.getOperatorLog().some((e) => e.kind === 'undo-turns' && (e.params as { admission?: string }).admission === 'rev-u'));
  });

  it('starts a fresh attempt on a branch of its own after one that created its destination but never switched', async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    // As if the process died between creating the destination and switching
    // to it: the switch fails, and so does recording the failure.
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => unknown };
    const realSwitch = store.switchBranch.bind(store);
    store.switchBranch = () => { throw new Error('the process died before switching'); };
    const restore = failJournalOnce('failed');
    try {
      await assert.rejects(applyIt(change), /died before switching/);
    } finally {
      store.switchBranch = realSwitch;
      restore();
    }
    const record = framework.getOperatorChangeRecord(change.id)!;
    assert.deepEqual([record.attempts.length, record.attempts[0]!.failed, record.switched], [1, undefined, undefined], 'an attempt with no disposition');
    assert.ok(framework.getStore().listBranches().some((x) => x.name === `undo/scout/op-${change.id}`), 'its branch was created');
    const applied = await applyIt(change);
    assert.equal(applied.kind === 'undo-turns' && applied.alreadyApplied, undefined, 'applied now');
    assert.equal(branch(), `undo/scout/op-${change.id}~2`, 'on its own branch, the unused one left alone');
    assert.deepEqual(texts(), ['one', 'reply to one', 'two']);
  });

  it('recognizes a cut that was already applied, and reports it as established after the branch moved on', async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    const apply = () => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    await apply();
    const after = { branch: branch(), texts: texts() };
    const again = await apply();
    assert.equal(again.kind === 'undo-turns' && again.alreadyApplied, true, 'a retry changes nothing');
    assert.deepEqual({ branch: branch(), texts: texts() }, after);
    assert.equal(host().redoStacks.get('scout')!.length, 1, 'no second redo entry');
    assert.equal(framework.getOperatorLog().filter((e) => e.kind === 'undo-turns').length, 1, 'no second log record');

    framework.redo('scout'); // the active branch moves away from the destination
    const source = branch();
    const established = await apply();
    assert.equal(established.kind === 'undo-turns' && established.alreadyApplied, true, 'its established outcome, reported as recorded');
    assert.equal(branch(), source, 'and nothing cut again');
    assert.equal(framework.getOperatorLog().filter((e) => e.kind === 'undo-turns').length, 1);
  });

  it('refuses a staged undo whose branch moved or whose checkpoint is gone', async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    framework.undoLastTurn('scout'); // someone else undid it meanwhile
    await assert.rejects(
      framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } })),
      (e: Error & { code?: string }) => e.code === 'stale' && /active branch moved/.test(e.message),
    );
  });

  const failJournalOnce = (kind: string) => {
    const fw = framework as unknown as { journalChange: (entry: { kind: string }) => void };
    const real = fw.journalChange.bind(fw);
    let armed = true;
    fw.journalChange = (entry) => {
      if (armed && entry.kind === kind) { armed = false; throw new Error(`injected ${kind} failure`); }
      return real(entry);
    };
    return () => { fw.journalChange = real; };
  };
  const failSwitchOnce = () => {
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => unknown };
    const real = store.switchBranch.bind(store);
    let armed = true;
    store.switchBranch = (name) => { if (armed) { armed = false; throw new Error('injected cut failure'); } return real(name); };
    return () => { store.switchBranch = real; };
  };
  const failLogOnce = (kind: string) => {
    const fw = framework as unknown as { recordOperatorAction: (entry: { kind: string }) => void };
    const real = fw.recordOperatorAction.bind(fw);
    let armed = true;
    fw.recordOperatorAction = (entry) => { if (armed && entry.kind === kind) { armed = false; throw new Error('injected log failure'); } return real(entry); };
    return () => { fw.recordOperatorAction = real; };
  };
  const applyIt = (change: ResolvedOperatorChange) => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
    framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));

  for (const [seam, later] of ([
    ['attempt', false], ['cut', false],
    ['switched', false], ['switched', true],
    ['outcome', false], ['outcome', true],
    ['log', false], ['log', true],
    ['completed', false], ['completed', true],
  ] as const)) {
    it(`recovers from a failure at its ${seam} step${later ? ', keeping later work' : ''}`, async () => {
      await turn('one'); await turn('two'); await turn('three');
      const source = branch();
      await undo(2);
      const change = asked[0]!;
      const destination = `undo/scout/op-${change.id}`;
      const restore = seam === 'cut' ? failSwitchOnce() : seam === 'log' ? failLogOnce('undo-turns') : failJournalOnce(seam);
      try {
        await assert.rejects(applyIt(change), new RegExp(`injected ${seam} failure`));
      } finally {
        restore();
      }
      const committed = seam !== 'attempt' && seam !== 'cut';
      assert.equal(branch() === destination, committed, committed ? 'the cut committed before the failure' : 'nothing was cut');
      if (later) await turn('after the failure');
      const retried = await applyIt(change);
      assert.equal(retried.kind === 'undo-turns' && retried.alreadyApplied === true, committed, 'a committed cut is recovered, never cut again');
      // A fresh attempt cuts onto a branch of its own; one that never got as
      // far as creating its branch reuses the first name.
      assert.equal(branch(), seam === 'cut' ? `${destination}~2` : destination);
      assert.equal(framework.getOperatorLog().filter((e) => e.kind === 'undo-turns').length, 1, 'logged once');
      const record = framework.getOperatorChangeRecord(change.id)!;
      assert.equal(record.attempts.length, seam === 'cut' ? 2 : 1, seam === 'cut' ? 'the unapplied attempt, then a fresh one' : 'one attempt');
      assert.ok(record.outcome && record.completed);
      if (later) {
        assert.equal(host().getTurnCheckpoints('scout').length, 2, 'the older turn and the later one: later work kept');
        assert.equal(texts().at(-1), 'reply to after the failure');
        assert.equal(host().redoStacks.get('scout')?.length ?? 0, 0, 'the later work invalidated redo');
        return;
      }
      assert.equal(host().getTurnCheckpoints('scout').length, 1);
      assert.equal(host().redoStacks.get('scout')!.length, 1, 'one redo entry');
      const redone = framework.redo('scout');
      assert.deepEqual([redone.redone, redone.toBranch], [true, source], 'the one-step redo');
      assert.equal(host().getTurnCheckpoints('scout').length, 3);
    });
  }

  it('leaves a completed cut alone on retry after further work, in process and after reopen', async () => {
    await turn('one'); await turn('two'); await turn('three');
    await undo(1);
    const change = asked[0]!;
    const apply = () => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    await apply();
    await turn('after the cut'); // real work on the destination: a new turn and its checkpoint
    const now = () => ({
      checkpoints: host().getTurnCheckpoints('scout').map((c) => c.turnIndex),
      texts: texts(),
      redo: host().redoStacks.get('scout')?.length ?? 0,
    });
    const settled = now();
    assert.equal(settled.checkpoints.length, 3, 'two older turns and the one after the cut');
    const again = await apply();
    assert.equal(again.kind === 'undo-turns' && again.alreadyApplied, true);
    assert.deepEqual(now(), settled, 'nothing touched in process');
    await framework.stop();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (c) => { asked.push(structuredClone(c)); return decide(c); },
    });
    const logged = () => framework.getOperatorLog().filter((e) => e.kind === 'undo-turns').length;
    const before = logged();
    const reopened = await apply();
    assert.equal(reopened.kind === 'undo-turns' && reopened.alreadyApplied, true);
    assert.deepEqual(now(), { ...settled, redo: 0 }, 'nor after reopen, and no redo entry conjured');
    assert.equal(logged(), before, 'and no second record of the cut');
  });


  const say = async (messageId: string) => {
    framework.getAgent('scout')!.getContextManager().addMessage('Member', [{ type: 'text', text: messageId }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId, tags: ['chat:addressed'],
    });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply to ${messageId}` }]));
    host().pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest);
    await framework.runUntilIdle();
  };
  const undoWithMarks = (turns: number, marks: string) =>
    host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', turns, marks, requesterName: 'nissa' });

  it('freezes the marks choice to the refs the cut would remove at staging', async () => {
    await say('a0'); await say('a1'); await say('a2');
    const r = await undoWithMarks(2, 'all');
    assert.equal(r.code, 'staged');
    const change = asked[0]!;
    assert.deepEqual(change.kind === 'undo-turns' && change.marks, {
      scope: 'all',
      refs: [{ serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'a2' }],
    }, "the oldest undone turn keeps its input (a1); a2's turn is what the cut removes");
    assert.equal(change.kind === 'undo-turns' && change.serverId, 'discord');
  });

  it('marks only the frozen refs the cut removed, counting a later cut arrival as unmarked', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    // Arrives after staging: the cut removes it too, but nobody authorized it.
    framework.getAgent('scout')!.getContextManager().addMessage('Member', [{ type: 'text', text: 'late' }], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'late', tags: ['chat:addressed'],
    });
    const applied = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    assert.equal(applied.kind, 'undo-turns');
    const m = applied.kind === 'undo-turns' ? applied.markers! : null;
    assert.deepEqual(
      m && { scope: m.scope, status: m.status, queued: m.queued, unmarked: m.unmarked, notRemoved: m.notRemoved },
      { scope: 'all', status: 'queued', queued: 1, unmarked: 1, notRemoved: 0 },
      'the reserved before/after snapshot established what was removed; a2 marked, late unmarked',
    );
    const again = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    assert.deepEqual(again.kind === 'undo-turns' && again.markers, m, 'a retry reports the same receipt');
  });

  type OutboxView = {
    batches(): Array<{ id: string; status: string }>;
    retract(target: string): unknown;
    cancel(target: string): unknown;
    pendingDispatches(): Array<{ action: string }>;
  };
  const outbox = () => (framework as unknown as { discordAwarenessOutbox: OutboxView }).discordAwarenessOutbox;
  const arrive = (messageId: string) => framework.getAgent('scout')!.getContextManager().addMessage('Member', [{ type: 'text', text: messageId }], {
    serverId: 'discord', channelId: 'discord:g1:c1', messageId, tags: ['chat:addressed'],
  });
  const receipt = (applied: Awaited<ReturnType<typeof applyIt>>) => {
    const m = applied.kind === 'undo-turns' || applied.kind === 'undo-messages' || applied.kind === 'hide' ? applied.markers : null;
    return m && { status: m.status, queued: m.queued, unmarked: m.unmarked, notRemoved: m.notRemoved };
  };

  it("recovers the activation's recorded receipt after a failure at the outcome record, late arrival included, with no second batch", async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    arrive('late');
    const restore = failJournalOnce('outcome');
    try {
      await assert.rejects(applyIt(change), /injected outcome failure/);
    } finally {
      restore();
    }
    const retried = await applyIt(change);
    assert.deepEqual(receipt(retried), { status: 'queued', queued: 1, unmarked: 1, notRemoved: 0 }, 'a2 marked; the late arrival counted unmarked');
    assert.equal(retried.kind === 'undo-turns' && retried.alreadyApplied, true);
    assert.deepEqual(outbox().batches().filter((x) => x.id.startsWith(`op-${change.id}`)).map((x) => x.status), ['active'], 'one batch');
  });

  it('recovers the established outcome after its destination was used and left and the source restored, never cutting again', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    arrive('late');
    const restore = failJournalOnce('outcome');
    try {
      await assert.rejects(applyIt(change), /injected outcome failure/);
    } finally {
      restore();
    }
    assert.equal(branch(), `undo/scout/op-${change.id}`);
    await turn('on the destination'); // the destination is used
    framework.getStore().switchBranch(change.sourceBranch); // and an operator restores the source
    const branches = () => framework.getStore().listBranches().map((x) => x.name).sort();
    const before = branches();
    const retried = await applyIt(change);
    assert.equal(retried.kind === 'undo-turns' && retried.alreadyApplied, true);
    assert.equal(branch(), change.sourceBranch, 'the restored source stays active: source active is not permission to cut again');
    assert.deepEqual(branches(), before, 'no new branch');
    assert.deepEqual(receipt(retried), { status: 'queued', queued: 1, unmarked: 1, notRemoved: 0 }, 'from the attempt that committed');
  });

  it('never cuts again after its destination was left at once, before any turn ran there', async () => {
    await turn('one'); await turn('two'); await turn('three');
    await undo(2);
    const change = asked[0]!;
    const destination = `undo/scout/op-${change.id}`;
    const restore = failJournalOnce('outcome');
    try {
      await assert.rejects(applyIt(change), /injected outcome failure/);
    } finally {
      restore();
    }
    // Left before any turn ran there. (Its switch record, a typed record, is
    // itself a write on the destination, so the switch record and the
    // used-destination evidence prove the cut together.)
    framework.getStore().switchBranch(change.sourceBranch);
    assert.equal(framework.getOperatorChangeRecord(change.id)!.switched, 1);
    void destination;
    const retried = await applyIt(change);
    assert.equal(retried.kind === 'undo-turns' && retried.alreadyApplied, true, 'never cut again');
    assert.equal(branch(), change.sourceBranch);
  });

  it('establishes a cut this process saw complete when its switch record was lost, whatever the branches show since', async () => {
    await turn('one'); await turn('two'); await turn('three');
    await undo(2);
    const change = asked[0]!;
    const restore = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      restore();
    }
    // Branch state is no evidence either way: the destination used, then
    // left, and the source restored.
    await turn('on the destination');
    framework.getStore().switchBranch(change.sourceBranch);
    const branches = () => framework.getStore().listBranches().map((x) => x.name).sort();
    const before = branches();
    const retried = await applyIt(change);
    assert.equal(retried.kind === 'undo-turns' && retried.alreadyApplied, true, 'committed: never cut again');
    assert.equal(branch(), change.sourceBranch);
    assert.deepEqual(branches(), before);
    assert.equal(framework.getOperatorChangeRecord(change.id)!.switched, 1, 'its switch recorded now, from what this process saw');
  });

  for (const target of ['all', 'by id'] as const) {
    it(`keeps a retract made while the cut waits (${target}): its keys are born superseded`, async () => {
      await say('a0'); await say('a1'); await say('a2');
      await undoWithMarks(2, 'all');
      const change = asked[0]!;
      outbox().retract(target === 'all' ? 'all' : `op-${change.id}`);
      const applied = await applyIt(change);
      assert.deepEqual(receipt(applied), { status: 'queued', queued: 0, unmarked: 0, notRemoved: 0 }, 'the retract outranks the staged choice');
      assert.equal(outbox().pendingDispatches().filter((d) => d.action === 'add').length, 0, 'no add is sent');
    });
  }

  it('reports a choice cancelled while the cut waited as not scheduled, with the cut applied', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    outbox().cancel(`op-${change.id}`);
    const applied = await applyIt(change);
    assert.equal(receipt(applied)!.status, 'not-scheduled');
    assert.equal(branch(), `undo/scout/op-${change.id}`, 'the cut applied');
    assert.equal(outbox().pendingDispatches().filter((d) => d.action === 'add').length, 0);
  });

  it('forms a new attempt when the first never cut, counting what the cut actually removes', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    arrive('late-1');
    const restore = failSwitchOnce();
    try {
      await assert.rejects(applyIt(change), /injected cut failure/);
    } finally {
      restore();
    }
    arrive('late-2'); // arrives on the source before the retry
    const applied = await applyIt(change);
    assert.deepEqual(receipt(applied), { status: 'queued', queued: 1, unmarked: 2, notRemoved: 0 }, 'both arrivals, as the cut that committed removed them');
    const record = framework.getOperatorChangeRecord(change.id)!;
    assert.deepEqual(record.attempts.map((x) => x.evidence.marks.unmarked), [1, 2], 'the first prediction is history, not the outcome');
    assert.equal(record.outcome!.n, 2);
  });

  it("establishes a committed cut's outcome at startup when a crash came before its record", async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    const restore = failJournalOnce('outcome');
    try {
      await assert.rejects(applyIt(change), /injected outcome failure/);
    } finally {
      restore();
    }
    await framework.stop();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (c) => { asked.push(structuredClone(c)); return decide(c); },
    });
    const record = framework.getOperatorChangeRecord(change.id)!;
    assert.ok(record.outcome && record.completed, 'established before modules or traffic');
    assert.deepEqual([record.outcome.markers.status, record.outcome.markers.queued], ['queued', 1]);
    assert.equal(outbox().batches().find((x) => x.id === `op-${change.id}`)?.status, 'active');
  });

  it('discards a staged choice when the gate refuses its change or the host drops it', async () => {
    await say('a0'); await say('a1'); await say('a2');
    decide = async () => { throw new Error('host says no'); };
    const refusal = await undoWithMarks(2, 'all');
    assert.equal(refusal.code, 'gate-failed');
    const refused = asked[0]!;
    assert.equal(outbox().batches().find((x) => x.id === `op-${refused.id}`)?.status, 'discarded');
    decide = async (c) => ({ id: 'rev-x', text: `staged ${c.kind}` });
    await undoWithMarks(2, 'all');
    const dropped = asked[1]!;
    framework.dropResolvedOperatorChange(dropped);
    assert.equal(outbox().batches().find((x) => x.id === `op-${dropped.id}`)?.status, 'discarded');
    await assert.rejects(applyIt(dropped), (e: Error & { code?: string }) => e.code === 'stale' && /dropped/.test(e.message));
  });

  it('stages a hide with its exact messages and frozen refs, applies it under the lease, and reports one receipt', async () => {
    await say('h0'); await say('h1'); await say('h2');
    const r = await host().handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId: 'h1', toMessageId: 'h2', marks: 'all', requesterName: 'nissa' });
    assert.equal(r.code, 'staged');
    const change = asked[0]!;
    assert.equal(change.kind === 'hide' && change.messages.length, 3, 'h1, its reply, and h2');
    assert.deepEqual(change.kind === 'hide' && change.marks, {
      scope: 'all',
      refs: ['h1', 'h2'].map((messageId) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId })),
    });
    const applied = await applyIt(change);
    assert.deepEqual(applied.kind === 'hide' && applied.hidden, 3);
    assert.deepEqual(receipt(applied), { status: 'queued', queued: 2, unmarked: 0, notRemoved: 0 });
    assert.deepEqual(texts().filter((t) => /h[12]/.test(t)), ['reply to h2'], 'exactly the range is gone: the reply after it stays');
    const again = await applyIt(change);
    assert.equal(again.kind === 'hide' && again.alreadyApplied, true);
    assert.deepEqual(receipt(again), receipt(applied));
    assert.equal(framework.getOperatorLog().filter((e) => e.kind === 'hide').length, 1);
  });

  it("counts an interrupted hide's removals from its own evidence when finishing it", async () => {
    await say('h0'); await say('h1'); await say('h2');
    await host().handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId: 'h1', toMessageId: 'h2', marks: 'all', requesterName: 'nissa' });
    const change = asked[0]!;
    const restore = failJournalOnce('outcome');
    try {
      await assert.rejects(applyIt(change), /injected outcome failure/);
    } finally {
      restore();
    }
    const finished = await applyIt(change);
    assert.equal(finished.kind === 'hide' && finished.hidden, 3, 'what it removed before the interruption still counts');
    assert.deepEqual(receipt(finished), { status: 'queued', queued: 2, unmarked: 0, notRemoved: 0 });
  });

  it('refuses a hide whose message changed, or whose interrupted attempt the active branch left', async () => {
    await say('h0'); await say('h1'); await say('h2');
    await host().handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId: 'h1', toMessageId: 'h2', marks: 'none', requesterName: 'nissa' });
    const edited = asked[0]!;
    const cmx = framework.getAgent('scout')!.getContextManager();
    const h1 = cmx.getAllMessages().find((m) => (m.metadata as { messageId?: string } | undefined)?.messageId === 'h1')!;
    cmx.editMessage(h1.id, [{ type: 'text', text: 'h1, edited' }]);
    await assert.rejects(applyIt(edited), (e: Error & { code?: string }) => e.code === 'stale' && /changed since it was staged/.test(e.message));

    await host().handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId: 'h2', marks: 'none', requesterName: 'nissa' });
    const interrupted = asked[1]!;
    const restore = failJournalOnce('outcome');
    try {
      await assert.rejects(applyIt(interrupted), /injected outcome failure/);
    } finally {
      restore();
    }
    framework.getStore().createBranch('elsewhere');
    framework.getStore().switchBranch('elsewhere');
    await assert.rejects(applyIt(interrupted), (e: Error & { code?: string }) => e.code === 'stale' && /outcome is unknown/.test(e.message));
  });

  it('stages an undo by messages at its tail, cuts onto its own branch, and counts a later arrival unmarked', async () => {
    await say('m0'); await say('m1');
    const r = await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'all', requesterName: 'nissa' });
    assert.equal(r.code, 'staged');
    const change = asked[0]!;
    assert.deepEqual(change.kind === 'undo-messages' && change.marks, {
      scope: 'all',
      refs: [{ serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' }],
    }, 'm1 and its reply follow the tail');
    arrive('late');
    const applied = await applyIt(change);
    assert.deepEqual(applied.kind === 'undo-messages' && [applied.toBranch, applied.messagesRemoved], [`undo-msgs/scout/op-${change.id}`, 3]);
    assert.deepEqual(receipt(applied), { status: 'queued', queued: 1, unmarked: 1, notRemoved: 0 });
    assert.deepEqual(texts(), ['m0', 'reply to m0']);
    const again = await applyIt(change);
    assert.equal(again.kind === 'undo-messages' && again.alreadyApplied, true);
  });

  for (const crashBeforeRestore of [false, true]) {
    it(`never reads a failed cut as committed, though it wrote on its destination${crashBeforeRestore ? ', even when the crash came before its restore' : ''}`, async () => {
      await say('m0'); await say('m1');
      await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'all', requesterName: 'nissa' });
      const change = asked[0]!;
      const destination = `undo-msgs/scout/op-${change.id}`;
      const cmx = framework.getAgent('scout')!.getContextManager() as unknown as { switchBranch: (name: string) => Promise<unknown> };
      const realSwitch = cmx.switchBranch.bind(cmx);
      let armed = true;
      // The store moves and strategy initialization writes on the destination
      // before failing, as June's probe did.
      cmx.switchBranch = async (name) => {
        if (!armed) return realSwitch(name);
        armed = false;
        framework.getStore().switchBranch(name);
        framework.getStore().setStateJson('probe/initializer', { wrote: true });
        throw new Error('injected strategy initialization failure');
      };
      const fw = framework as unknown as { restoreCutSource: (...args: unknown[]) => Promise<unknown> };
      const realRestore = fw.restoreCutSource.bind(fw);
      if (crashBeforeRestore) fw.restoreCutSource = async () => { throw new Error('the process died before restoring'); };
      try {
        await assert.rejects(applyIt(change), crashBeforeRestore ? /died before restoring/ : /injected strategy initialization failure/);
      } finally {
        cmx.switchBranch = realSwitch;
        fw.restoreCutSource = realRestore;
      }
      assert.equal(branch(), crashBeforeRestore ? destination : change.sourceBranch);
      assert.equal(framework.getOperatorChangeRecord(change.id)!.attempts[0]!.failed !== undefined, true, 'its failure recorded first');
      const retried = await applyIt(change);
      assert.equal(retried.kind === 'undo-messages' && retried.alreadyApplied, undefined, 'a fresh attempt, not a recovered commitment');
      assert.deepEqual(texts(), ['m0', 'reply to m0'], 'the cut really happened this time');
      assert.deepEqual(receipt(retried), { status: 'queued', queued: 1, unmarked: 0, notRemoved: 0 }, 'marks from the attempt that committed');
      const record = framework.getOperatorChangeRecord(change.id)!;
      assert.deepEqual([record.attempts.length, record.outcome!.n], [2, 2]);
    });
  }

  it('hides a one-shard body group as a range, and a shard of a larger group as its whole group', async () => {
    type ShardStore = { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: string } } };
    const shards = (group: string, texts: string[], messageId: string) => texts.map((text, shardIndex) =>
      (framework.getAgent('scout')!.getContextManager() as unknown as ShardStore).messageStore
        .append('Member', [{ type: 'text', text }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId }, undefined, { bodyGroupId: group, shardIndex }).id);
    await say('before');
    shards('g1', ['lone'], 'lone');
    shards('g3', ['big 0', 'big 1', 'big 2'], 'big');
    for (const [fromMessageId, expected] of [['lone', 1], ['big', 3]] as const) {
      await host().handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId, toMessageId: fromMessageId, marks: 'none', requesterName: 'nissa' });
      const change = asked.at(-1)!;
      assert.equal(change.kind === 'hide' && change.messages.length, expected, 'the frozen plan names the whole group');
      const applied = await applyIt(change);
      assert.equal(applied.kind === 'hide' && applied.hidden, expected);
    }
    assert.deepEqual(texts().filter((t) => /lone|big/.test(t)), []);
  });

  it("refuses a branch already bearing its destination's name, made by no attempt of the change", async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    framework.getStore().createBranch(`undo/scout/op-${change.id}`); // someone else's branch, at the current tip
    const before = texts();
    await assert.rejects(applyIt(change), (e: Error & { code?: string }) => e.code === 'invalid' && /already exists, and no attempt/.test(e.message));
    assert.deepEqual(texts(), before, 'nothing cut');
    assert.equal(branch(), change.sourceBranch);
    assert.equal(framework.getOperatorChangeRecord(change.id), null, 'nothing recorded either');
  });

  const reopen = async () => {
    await framework.stop();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (c) => { asked.push(structuredClone(c)); return decide(c); },
    });
  };
  const quiesced = () => (framework as unknown as { quiesced: boolean }).quiesced;
  const failCutAfterInitializerWrite = () => {
    const cmx = framework.getAgent('scout')!.getContextManager() as unknown as { switchBranch: (name: string) => Promise<unknown> };
    const real = cmx.switchBranch.bind(cmx);
    let armed = true;
    cmx.switchBranch = async (name) => {
      if (!armed) return real(name);
      armed = false;
      framework.getStore().switchBranch(name);
      framework.getStore().setStateJson('probe/initializer', { wrote: true });
      throw new Error('injected strategy initialization failure');
    };
    return () => { cmx.switchBranch = real; };
  };
  const resolve = (changeId: string, attempt: number, verdict: 'committed' | 'not-committed', reason: string) =>
    framework.runAtSafeBoundary({ verb: 'resolve' }, (lease) =>
      framework.resolveOperatorChange(changeId, attempt, verdict, { lease, reason, requester: { via: 'test', name: 'nissa' } }));

  it('holds an attempt whose failure record was lost once the process restarts, and settles it as not committed', async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'all', requesterName: 'nissa' });
    const change = asked[0]!;
    const undoCut = failCutAfterInitializerWrite();
    const undoRecord = failJournalOnce('failed');
    try {
      await assert.rejects(applyIt(change), /injected strategy initialization failure/);
    } finally {
      undoCut(); undoRecord();
    }
    await reopen(); // what this process saw is gone
    assert.equal(branch(), change.sourceBranch);
    assert.equal(quiesced(), false, 'the original body is active, so traffic is safe');
    assert.deepEqual(framework.getOperatorChangeRecord(change.id)!.unresolved, { n: 1, target: `undo-msgs/scout/op-${change.id}` });
    await assert.rejects(applyIt(change), (e: Error & { code?: string }) => e.code === 'unresolved', 'never certified, never cut again');
    await assert.rejects(resolve(change.id, 2, 'not-committed', 'wrong attempt'), (e: Error & { code?: string }) => e.code === 'stale');
    const settled = await resolve(change.id, 1, 'not-committed', 'its initializer failed; nothing applied');
    assert.deepEqual([settled.recorded.verdict, settled.recorded.via, settled.restored], ['not-committed', 'live', undefined]);
    assert.match(settled.settlement, /abandoned/);
    const applied = await applyIt(change);
    assert.equal(applied.kind === 'undo-messages' && applied.toBranch, `undo-msgs/scout/op-${change.id}~2`, 'a fresh attempt, on its own branch');
    assert.deepEqual(texts(), ['m0', 'reply to m0']);
    assert.equal(framework.getOperatorChangeRecord(change.id)!.attempts[0]!.resolution!.reason, 'its initializer failed; nothing applied');
  });

  it('boots quiesced while an unresolved attempt left its destination active, and settles it as committed without publishing by itself', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    const undoRecord = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      undoRecord();
    }
    await reopen();
    assert.equal(branch(), `undo/scout/op-${change.id}`);
    assert.equal(quiesced(), true, 'no turn starts on a body nobody can vouch for');
    await assert.rejects(applyIt(change), (e: Error & { code?: string }) => e.code === 'unresolved');
    const staged = () => outbox().batches().find((x) => x.id === `op-${change.id}`)?.status;
    assert.equal(staged(), 'staged', 'its marks wait');
    const settled = await resolve(change.id, 1, 'committed', 'the switch completed; its record was lost');
    assert.match(settled.settlement, /next retry or the next start/);
    assert.equal(staged(), 'staged', 'the attestation publishes nothing');
    const applied = await applyIt(change);
    assert.equal(applied.kind === 'undo-turns' && applied.alreadyApplied, true);
    assert.deepEqual(receipt(applied), { status: 'queued', queued: 1, unmarked: 0, notRemoved: 0 });
    const record = framework.getOperatorChangeRecord(change.id)!;
    assert.deepEqual([record.switched, record.attempts[0]!.resolution!.verdict], [undefined, 'committed'], 'an attestation, not a framework-observed switch');
  });

  it('refuses resume(), forced or not and through host/command, while the active body is an unresolved cut\'s destination, until it is settled', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    const undoRecord = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      undoRecord();
    }
    await reopen();
    assert.equal(quiesced(), true);
    const held = [{ changeId: change.id, agent: 'scout', kind: 'undo-turns', attempt: 1, target: `undo/scout/op-${change.id}` }];
    for (const opts of [undefined, { force: true }]) {
      await assert.rejects(framework.resume(opts), (e: unknown) => {
        assert.ok(e instanceof ResumeBlockedError);
        assert.deepEqual([e.unresolved, e.verdicts], [held, []]);
        assert.match(e.message, new RegExp(`operator change ${change.id} \\(undo-turns for scout\\) is unresolved: its attempt 1`));
        assert.ok(e.message.includes(`resolveOperatorChange("${change.id}", 1, 'committed' | 'not-committed', { lease, reason })`));
        assert.ok(e.message.includes(`--operator-change resolve ${change.id} --attempt 1 --verdict <committed|not-committed> --reason <text>`));
        assert.match(e.message, /force doesn't override it/);
        return true;
      });
      assert.equal(quiesced(), true, `still quiesced after resume(${JSON.stringify(opts ?? {})})`);
    }
    const viaCommand = await host().handleHostCommand('discord', { command: 'resume', force: true, requesterName: 'nissa' });
    assert.deepEqual([viaCommand.ok, viaCommand.unresolved], [false, held], 'a refusal the host can read, not a throw');
    assert.equal(quiesced(), true);

    await resolve(change.id, 1, 'committed', 'the switch completed; its record was lost');
    const status = await framework.resume();
    assert.equal(status.quiesced, false, 'settled: resume proceeds');
  });

  // Every CM branch switch fails until the returned function is called.
  const failEverySwitch = () => {
    const cmx = framework.getAgent('scout')!.getContextManager() as unknown as { switchBranch: (name: string) => Promise<unknown> };
    const real = cmx.switchBranch.bind(cmx);
    cmx.switchBranch = async () => { throw new Error('injected restore failure'); };
    return () => { cmx.switchBranch = real; };
  };
  const restoreSource = (changeId: string) => framework.runAtSafeBoundary({ verb: 'restore' }, (lease) =>
    framework.restoreOperatorChangeSource(changeId, { lease, requester: { via: 'test', name: 'nissa' } }));

  it('holds an abandoned destination a not-committed settlement could not restore: resume() refuses, forced or not, until the source is restored live', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    const undoRecord = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      undoRecord();
    }
    await reopen();
    const destination = `undo/scout/op-${change.id}`;
    assert.deepEqual([branch(), quiesced()], [destination, true]);
    const undoSwitch = failEverySwitch();
    let settled: Awaited<ReturnType<typeof resolve>>;
    try {
      settled = await resolve(change.id, 1, 'not-committed', 'nothing applied');
    } finally {
      undoSwitch();
    }
    assert.equal(settled.restored, undefined, 'nothing was restored');
    assert.match(settled.remaining!, new RegExp(`the source ${change.sourceBranch} is not restored: RESTORE TO ${change.sourceBranch} FAILED \\(injected restore failure\\)`));
    assert.equal(branch(), destination);
    assert.equal(framework.getOperatorChangeRecord(change.id)!.unresolved, undefined, 'its verdict is recorded');

    const abandoned = [{
      changeId: change.id, agent: 'scout', kind: 'undo-turns', attempt: 1, target: destination, source: change.sourceBranch,
      active: destination, recorded: true, restorationFailure: 'injected restore failure',
    }];
    for (const opts of [undefined, { force: true }]) {
      await assert.rejects(framework.resume(opts), (e: unknown) => {
        assert.ok(e instanceof ResumeBlockedError);
        assert.deepEqual([e.restorationRequired, e.unresolved, e.verdicts], [abandoned, [], []]);
        assert.ok(e.message.includes(`restoreOperatorChangeSource("${change.id}", { lease })`));
        assert.doesNotMatch(e.message, /resolveOperatorChange|--verdict/, 'no further attestation is asked for');
        return true;
      });
    }
    const viaCommand = await host().handleHostCommand('discord', { command: 'resume', force: true, requesterName: 'nissa' });
    assert.deepEqual([viaCommand.ok, viaCommand.restorationRequired], [false, abandoned]);
    assert.equal(quiesced(), true);

    const restored = await restoreSource(change.id);
    assert.deepEqual(restored, { changeId: change.id, attempt: 1, restored: change.sourceBranch });
    assert.equal(branch(), change.sourceBranch);
    assert.ok(framework.getOperatorLog().some((e) => e.kind === 'restore-operator-change-source' && (e.params as { changeId?: string }).changeId === change.id));
    await assert.rejects(restoreSource(change.id), (e: Error & { code?: string }) => e.code === 'invalid' && /nothing to restore/.test(e.message));
    assert.equal((await framework.resume()).quiesced, false, 'the known body is back: resume proceeds');
  });

  it('holds traffic itself when a live attempt fails and its source cannot be restored, until a live restoration, then serves the source', async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'none', requesterName: 'nissa' });
    const change = asked[0]!;
    const destination = `undo-msgs/scout/op-${change.id}`;
    const undoCut = failCutAfterInitializerWrite();
    let undoSwitch = () => {};
    const cmx = framework.getAgent('scout')!.getContextManager() as unknown as { switchBranch: (name: string) => Promise<unknown> };
    const cutting = cmx.switchBranch;
    cmx.switchBranch = async (name) => { // the cut fails as before; then every restore fails
      const result = cutting(name);
      undoSwitch = failEverySwitch();
      return result;
    };
    try {
      await assert.rejects(applyIt(change), /injected strategy initialization failure/);
    } finally {
      undoSwitch(); undoCut();
    }
    assert.equal(branch(), destination, 'left on the abandoned destination');
    assert.equal(quiesced(), true, 'the framework held traffic without anyone calling resume()');

    const providerCalls = membrane.calls.length;
    host().pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest);
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, providerCalls, 'a queued wake does not run on the abandoned body after the lease released');
    await assert.rejects(framework.resume({ force: true }), (e: unknown) => e instanceof ResumeBlockedError && e.restorationRequired[0]?.target === destination);

    // A retry that fails again keeps the hold, and says so: the host's retry
    // of the change, and a live restoration.
    const failing = failEverySwitch();
    let again: Awaited<ReturnType<typeof restoreSource>>;
    try {
      await assert.rejects(applyIt(change), (e: Error & { code?: string }) =>
        e.code === 'failed' && /abandoned attempt 1 cut to .*, and restoring its source .* failed again/.test(e.message));
      again = await restoreSource(change.id);
    } finally {
      failing();
    }
    assert.equal(again.restored, undefined);
    assert.match(again.remaining!, /is not restored: RESTORE TO .* FAILED \(injected restore failure\)/);
    assert.deepEqual([branch(), quiesced()], [destination, true]);

    assert.deepEqual(await restoreSource(change.id), { changeId: change.id, attempt: 1, restored: change.sourceBranch });
    await framework.resume();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back on the source' }]));
    await framework.runUntilIdle();
    assert.ok(membrane.calls.length > providerCalls, 'the parked wake ran once resumed');
    assert.equal(branch(), change.sourceBranch, 'on the source body');
    assert.ok(texts().includes('back on the source'));
  });

  // The strategy's initializer fails until the returned function is called:
  // a real CM switch then selects the branch but never initializes there.
  const failInitialization = () => {
    const strategy = framework.getAgent('scout')!.getContextManager().getStrategy() as unknown as Record<string, unknown>;
    const own = Object.prototype.hasOwnProperty.call(strategy, 'initialize');
    const real = strategy.initialize;
    strategy.initialize = async () => { throw new Error('injected initializer failure'); };
    return () => { if (own) strategy.initialize = real; else delete strategy.initialize; };
  };

  it('counts a restoration only once the source\'s context initialized: one that selected the source and failed stays held until a live restoration completes', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    const undoRecord = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      undoRecord();
    }
    await reopen();
    const destination = `undo/scout/op-${change.id}`;
    const undoInit = failInitialization();
    let settled: Awaited<ReturnType<typeof resolve>>;
    try {
      settled = await resolve(change.id, 1, 'not-committed', 'nothing applied');
    } finally {
      undoInit();
    }
    assert.equal(branch(), change.sourceBranch, 'the store is back on the source…');
    assert.equal(settled.restored, undefined, '…but nothing was restored');
    assert.match(settled.remaining!, /is not restored: RESTORE TO .* FAILED \(injected initializer failure\)/);
    await assert.rejects(framework.resume({ force: true }), (e: unknown) => {
      assert.ok(e instanceof ResumeBlockedError);
      assert.deepEqual(e.restorationRequired, [{
        changeId: change.id, agent: 'scout', kind: 'undo-turns', attempt: 1, target: destination, source: change.sourceBranch,
        active: change.sourceBranch, recorded: true, restorationFailure: 'injected initializer failure',
      }]);
      assert.match(e.message, /a restoration selected its source .* but didn't complete \(injected initializer failure\)/);
      assert.match(e.message, /the source initializes afresh at startup/);
      return true;
    });
    const strategy = framework.getAgent('scout')!.getContextManager().getStrategy() as unknown as Record<string, unknown>;
    const own = Object.prototype.hasOwnProperty.call(strategy, 'initialize');
    const initialize = strategy.initialize as ((ctx: unknown) => Promise<void>) | undefined;
    let initialized = 0;
    strategy.initialize = async (ctx: unknown) => { initialized++; await initialize?.call(strategy, ctx); };
    try {
      assert.deepEqual(await restoreSource(change.id), { changeId: change.id, attempt: 1, restored: change.sourceBranch });
    } finally {
      if (own) strategy.initialize = initialize; else delete strategy.initialize;
    }
    assert.equal(initialized, 1, 'the retry initialized the source it found selected');
    assert.equal((await framework.resume()).quiesced, false);
  });

  it("completes a selected-but-uninitialized restoration on the host's retry, and only then attempts afresh", async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'none', requesterName: 'nissa' });
    const change = asked[0]!;
    const destination = `undo-msgs/scout/op-${change.id}`;
    const undoCut = failCutAfterInitializerWrite(); // the cut selects its destination, then fails
    const undoInit = failInitialization(); // and restoring selects the source but can't initialize it
    try {
      await assert.rejects(applyIt(change), /injected strategy initialization failure/);
      undoCut();
      assert.deepEqual([branch(), quiesced()], [change.sourceBranch, true], 'selected, not restored: held');
      // The host's retry while the source still can't initialize: refused, and no fresh attempt.
      await assert.rejects(applyIt(change), (e: Error & { code?: string }) => e.code === 'failed' && /failed again/.test(e.message));
      assert.equal(framework.getOperatorChangeRecord(change.id)!.attempts.length, 1, 'no fresh attempt on an uninitialized source');
    } finally {
      undoInit(); undoCut();
    }
    await assert.rejects(framework.resume(), (e: unknown) => e instanceof ResumeBlockedError && e.restorationRequired[0]?.active === change.sourceBranch);

    const applied = await applyIt(change); // the host's retry: completes the restoration, then attempts afresh
    assert.equal(applied.kind === 'undo-messages' && applied.toBranch, `${destination}~2`);
    assert.deepEqual(texts(), ['m0', 'reply to m0']);
    assert.equal((await framework.resume()).quiesced, false);
  });

  it('says a restart finds the attempt unresolved when only this process saw it fail', async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'none', requesterName: 'nissa' });
    const change = asked[0]!;
    const destination = `undo-msgs/scout/op-${change.id}`;
    const undoCut = failCutAfterInitializerWrite();
    const undoRecord = failJournalOnce('failed'); // its failure can't be recorded
    let undoSwitch = () => {};
    const cmx = framework.getAgent('scout')!.getContextManager() as unknown as { switchBranch: (name: string) => Promise<unknown> };
    const cutting = cmx.switchBranch;
    cmx.switchBranch = async (name) => { // after the cut, every restore fails
      const result = cutting(name);
      undoSwitch = failEverySwitch();
      return result;
    };
    try {
      await assert.rejects(applyIt(change), /injected strategy initialization failure/);
    } finally {
      undoSwitch(); undoRecord(); undoCut();
    }
    assert.equal(branch(), destination);
    await assert.rejects(framework.resume(), (e: unknown) => {
      assert.ok(e instanceof ResumeBlockedError);
      assert.deepEqual([e.restorationRequired[0]?.recorded, e.restorationRequired[0]?.active], [false, destination]);
      assert.match(e.message, /this process saw it fail, but its failure couldn't be recorded/);
      assert.match(e.message, /restart the host, which finds the attempt unresolved and boots quiesced until it is settled not-committed/);
      return true;
    });
  });

  it('lets resume() proceed while an unresolved attempt left its source, not its destination, active', async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'all', requesterName: 'nissa' });
    const change = asked[0]!;
    const undoCut = failCutAfterInitializerWrite();
    const undoRecord = failJournalOnce('failed');
    try {
      await assert.rejects(applyIt(change), /injected strategy initialization failure/);
    } finally {
      undoCut(); undoRecord();
    }
    await reopen();
    assert.equal(branch(), change.sourceBranch);
    assert.ok(framework.getOperatorChangeRecord(change.id)!.unresolved, 'unresolved, on a branch that is not active');
    await framework.quiesce({ reason: 'maintenance' });
    const status = await framework.resume();
    assert.equal(status.quiesced, false, 'a historical unresolved attempt does not hold the known body');
  });

  it("restores a recorded failure's source at startup, before any traffic, when the process died before restoring it", async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'none', requesterName: 'nissa' });
    const change = asked[0]!;
    const undoCut = failCutAfterInitializerWrite();
    const fw = framework as unknown as { restoreCutSource: (...args: unknown[]) => Promise<unknown> };
    const realRestore = fw.restoreCutSource.bind(fw);
    fw.restoreCutSource = async () => { throw new Error('the process died before restoring'); };
    try {
      await assert.rejects(applyIt(change), /died before restoring/);
    } finally {
      undoCut(); fw.restoreCutSource = realRestore;
    }
    assert.equal(branch(), `undo-msgs/scout/op-${change.id}`, 'left on the failed destination');
    await reopen();
    assert.equal(branch(), change.sourceBranch, 'restored before traffic');
    assert.equal(quiesced(), false);
    const applied = await applyIt(change); // the host's retry
    assert.equal(applied.kind === 'undo-messages' && applied.toBranch, `undo-msgs/scout/op-${change.id}~2`);
  });

  it('settles a held attempt offline when the destination cannot even start, then starts normally', async () => {
    await turn('one'); await turn('two'); await turn('three');
    await undo(2);
    const change = asked[0]!;
    const undoRecord = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      undoRecord();
    }
    await framework.stop();
    const storePath = join(tempDir, 'test.chronicle');
    const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const mockPath = fileURLToPath(new URL('./helpers/mock-membrane.js', import.meta.url));
    const cli = fileURLToPath(new URL('../src/recovery/recover-cli.js', import.meta.url));
    const script = join(tempDir, 'start.mjs');
    // A context strategy that can't initialize on the cut body (it needs a
    // message only the source has): the agent itself fails to start there.
    writeFileSync(script, `
      import { AgentFramework, AutobiographicalStrategy } from ${JSON.stringify(index)};
      import { MockMembrane } from ${JSON.stringify(mockPath)};
      console.log = () => {}; console.error = () => {};
      class Picky extends AutobiographicalStrategy {
        async initialize(ctx) {
          if (!ctx.messageStore.getAll().some((m) => m.content?.[0]?.text === 'three')) throw new Error('cannot initialize on this body');
          return super.initialize?.(ctx);
        }
      }
      try {
        const fw = await AgentFramework.create({ storePath: ${JSON.stringify(storePath)}, membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'x', maxTokens: 1000, strategy: new Picky() }], modules: [],
          operatorChangeGate: async () => ({ id: 'rev', text: 'staged' }) });
        process.stdout.write(JSON.stringify({ started: true, branch: fw.getStore().currentBranch().name, quiesced: fw.quiesced }));
        await fw.stop();
      } catch (error) {
        process.stdout.write(JSON.stringify({ started: false, error: error.message }));
      }
    `);
    const start = () => JSON.parse(spawnSync(process.execPath, [script], { encoding: 'utf8' }).stdout) as { started: boolean; branch?: string; quiesced?: boolean; error?: string };
    const recover = (...args: string[]) => {
      const run = spawnSync(process.execPath, [cli, '--store', storePath, '--operator-change', ...args], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    const failed = start();
    assert.equal(failed.started, false, 'normal startup cannot finish');
    assert.match(String(failed.error), /cannot initialize on this body/);
    const listed = recover('list');
    assert.deepEqual(listed.unresolved.map((u: { changeId: string; attempt: number; targetIsActive: boolean }) => [u.changeId, u.attempt, u.targetIsActive]),
      [[change.id, 1, true]], 'inspected without starting the host');
    // A dry run is no preview of a decision: refused before the store opens, nothing recorded.
    const dry = spawnSync(process.execPath, [cli, '--store', storePath, '--operator-change', 'resolve', change.id,
      '--attempt', '1', '--verdict', 'not-committed', '--reason', 'only looking', '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 1);
    assert.match(dry.stderr, /does not apply to --operator-change \(inspect with --operator-change list\)/);
    assert.deepEqual(recover('list').unresolved.map((u: { attempt: number }) => u.attempt), [1], 'still unresolved: nothing was recorded');
    // A wrong attempt is refused, and the refusal is logged like the CLI's other acts.
    const wrong = spawnSync(process.execPath, [cli, '--store', storePath, '--operator-change', 'resolve', change.id,
      '--attempt', '2', '--verdict', 'not-committed', '--reason', 'wrong attempt'], { encoding: 'utf8' });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /--attempt 2 is not its unresolved attempt \(1 is\)/);
    const settled = recover('resolve', change.id, '--attempt', '1', '--verdict', 'not-committed', '--reason', 'the cut body cannot start', '--requester', 'nissa');
    assert.deepEqual([settled.recorded.via, settled.recorded.verdict, settled.restored], ['offline', 'not-committed', undefined]);
    assert.deepEqual(settled.recorded.requester, { via: 'cli', name: 'nissa' });
    const logged = readFileSync(join(storePath, 'operator-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry: { kind: string }) => entry.kind === 'resolve-operator-change');
    assert.deepEqual(logged.map((entry: { agent: string; params: { attempt: number; via: string }; error?: string; result?: { settlement: string } }) =>
      [entry.agent, entry.params.attempt, entry.params.via, entry.error !== undefined, entry.result !== undefined]),
    [['scout', 2, 'offline', true, false], ['scout', 1, 'offline', false, true]], 'the refusal and the resolution, each logged');
    assert.deepEqual(logged[1].requester, { via: 'cli', name: 'nissa' });
    assert.match(settled.settlement, new RegExp(`abandoned; the next start restores ${change.sourceBranch} before any agent initializes`));
    assert.deepEqual(start(), { started: true, branch: change.sourceBranch, quiesced: false }, 'normal readiness: restored before the agent initialized');
    await reopen().catch(() => {}); // the framework in this process was stopped above
  });

  it('establishes an offline committed verdict at the next start, as its receipt says', async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'all');
    const change = asked[0]!;
    const undoRecord = failJournalOnce('switched');
    try {
      await assert.rejects(applyIt(change), /injected switched failure/);
    } finally {
      undoRecord();
    }
    await framework.stop();
    const cli = fileURLToPath(new URL('../src/recovery/recover-cli.js', import.meta.url));
    const run = spawnSync(process.execPath, [cli, '--store', join(tempDir, 'test.chronicle'), '--operator-change', 'resolve', change.id,
      '--attempt', '1', '--verdict', 'committed', '--reason', 'the switch completed'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const settled = JSON.parse(run.stdout);
    assert.match(settled.settlement, /next start: startup establishes its outcome and activates its staged marks before any traffic/);
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (c) => { asked.push(structuredClone(c)); return decide(c); },
    });
    const record = framework.getOperatorChangeRecord(change.id)!;
    assert.deepEqual([record.outcome?.markers.status, record.outcome?.markers.queued], ['queued', 1], 'established at startup');
    assert.equal(outbox().batches().find((x) => x.id === `op-${change.id}`)?.status, 'active');
    assert.equal(quiesced(), false);
  });

  it('refuses an undo by messages whose tail changed since staging', async () => {
    await say('m0'); await say('m1');
    await host().handleHostCommand('discord', { command: 'undo', agentName: 'scout', messages: 2, marks: 'none', requesterName: 'nissa' });
    const change = asked[0]!;
    const cmx = framework.getAgent('scout')!.getContextManager();
    cmx.editMessage(cmx.getAllMessages()[1]!.id, [{ type: 'text', text: 'reply, edited' }]);
    await assert.rejects(applyIt(change), (e: Error & { code?: string }) => e.code === 'stale' && /tail message .* changed/.test(e.message));
  });

  it("runs the public rollback under a host's held lease, and refuses it inside one without the lease", async () => {
    await turn('one'); await turn('two');
    const target = String(framework.getAgent('scout')!.getContextManager().getAllMessages()[1]!.id);
    await assert.rejects(
      framework.runAtSafeBoundary({ verb: 'nested' }, () => framework.rollbackToMessage('scout', { messageId: target })),
      (e: Error & { code?: string }) => e.code === 'agent-busy',
    );
    const rolled = await framework.runAtSafeBoundary({ verb: 'held' }, (lease) =>
      framework.rollbackToMessage('scout', { messageId: target, lease }));
    assert.equal(rolled.messagesRemoved, 2);
  });

  it("keeps a staged undo without a marks choice local, still counting what it removed", async () => {
    await say('a0'); await say('a1'); await say('a2');
    await undoWithMarks(2, 'none');
    const change = asked[0]!;
    assert.equal(change.kind === 'undo-turns' && change.marks, 'none');
    const applied = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    const m = applied.kind === 'undo-turns' ? applied.markers! : null;
    assert.deepEqual(m && { scope: m.scope, queued: m.queued, unmarked: m.unmarked }, { scope: 'none', queued: 0, unmarked: 1 });
  });

  it("never awaits awareness delivery inside the lease, and never reports its failure as the undo's", async () => {
    const fw = framework as unknown as { syncDiscordAwarenessMarkers: () => Promise<void> };
    let calls = 0;
    // The real outbox queues the marks; only delivery is stubbed: it fails
    // the first time and never finishes the second.
    fw.syncDiscordAwarenessMarkers = () => { calls++; return calls === 1 ? Promise.reject(new Error('delivery down')) : new Promise<void>(() => {}); };
    await say('a0'); await say('a1'); await say('a2'); await say('a3');
    for (const id of ['rev-a', 'rev-b']) {
      await undoWithMarks(2, 'all'); // two turns, so the cut removes addressed inputs to mark
      const staged = asked.at(-1)!;
      const applied = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(staged, { lease, admission: { id } }));
      assert.equal(applied.kind === 'undo-turns' && applied.markers?.status, 'queued', 'marks queued; the undo stands either way');
    }
    assert.equal(calls, 2, 'delivery started both times, and neither apply waited for it');
  });

  it('refuses a staged undo whose checkpoint is gone though the branch stayed', async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    host().saveTurnCheckpoints('scout', host().getTurnCheckpoints('scout').slice(0, 1)); // the staged one is gone
    await assert.rejects(
      framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } })),
      (e: Error & { code?: string }) => e.code === 'stale' && /no longer an undoable checkpoint/.test(e.message),
    );
  });

  it('resolves fewer turns than requested when history is shorter, and reports both', async () => {
    await turn('only');
    const r = await undo(3);
    assert.deepEqual([r.code, r.requested], ['staged', 3]);
    const change = asked[0]!;
    assert.equal(change.kind === 'undo-turns' && change.checkpoints.length, 1);
    const applied = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    assert.deepEqual(applied.kind === 'undo-turns' && [applied.undone, applied.requested], [1, 3]);
  });

  it('says what the cut removed, later arrivals included, beside what followed its cut at staging', async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    assert.equal(change.kind === 'undo-turns' && change.messagesAfter, 1, "at staging the cut would remove two's reply");
    await turn('alice: new 1'); await turn('bob: new 2'); await turn('carol: new 3');
    const apply = () => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    const applied = await apply();
    assert.deepEqual(applied.kind === 'undo-turns' && [applied.undone, applied.messagesRemoved], [1, 7],
      'one turn undone; the cut removed its reply and the six messages that arrived after staging');
    assert.deepEqual(texts(), ['one', 'reply to one', 'two']);
    const again = await apply();
    assert.deepEqual(again.kind === 'undo-turns' && [again.alreadyApplied, again.messagesRemoved], [true, 7],
      'a retry reports the established count');
  });

  it('refuses when the gate fails, and asks nothing when there is nothing to undo', async () => {
    const empty = await undo(1);
    assert.deepEqual([empty.ok, empty.undone], [true, 0]);
    assert.equal(asked.length, 0);
    await turn('one');
    decide = async () => { throw new Error('journal unavailable'); };
    const r = await undo(1);
    assert.deepEqual([r.ok, r.code], [false, 'gate-failed']);
    assert.equal(host().getTurnCheckpoints('scout').length, 1, 'nothing undone');
  });
});

describe('operator-change gate: host/command unstick, planned at staging', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let asked: ResolvedOperatorChange[];
  let decide: (change: ResolvedOperatorChange) => Promise<OperatorChangeReceipt>;
  let quiet: { log: typeof console.log; error: typeof console.error };
  type UnstickInternals = {
    pendingRequests: InferenceRequest[];
    unstickJournalState: unknown;
    unstickAttemptWaiters: Map<string, unknown>;
    handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    addMessage(participant: string, content: unknown[]): string;
  };
  const host = () => framework as unknown as UnstickInternals;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'operator-gate-unstick-'));
    membrane = new MockMembrane();
    asked = [];
    decide = async (change) => ({ id: 'rev-s', text: `staged ${change.kind}` });
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (change) => { asked.push(structuredClone(change)); return decide(change); },
    });
    quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    // History: two answered turns, then a message the agent keeps refusing
    // (a refusal stores nothing, so the culprit is the newest message).
    for (const text of ['one', 'two']) {
      host().addMessage('user', [{ type: 'text', text }]);
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply to ${text}` }]));
      host().pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest);
      await framework.runUntilIdle();
    }
    host().addMessage('user', [{ type: 'text', text: 'culprit' }]);
  });
  afterEach(async () => {
    console.log = quiet.log;
    console.error = quiet.error;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const cm = () => framework.getAgent('scout')!.getContextManager();
  const texts = () => (cm().getAllMessages() as Array<{ content: Array<{ text?: string }>; metadata?: { system?: unknown } }>)
    .filter((m) => !m.metadata?.system).map((m) => m.content[0]?.text ?? '');
  const textOf = (id: string) => (cm().getAllMessages() as Array<{ id: string; content: Array<{ text?: string }> }>)
    .find((m) => String(m.id) === id)?.content[0]?.text;
  const unstick = (maxRewinds = 3) => host().handleHostCommand('discord', { command: 'unstick', agentName: 'scout', maxRewinds, requesterName: 'nissa' });
  const refusal = () => createMockResponse([{ type: 'thinking', thinking: '', signature: 'sig' } as never], 'refusal');
  const step = (change: ResolvedOperatorChange, n: number) => framework.runAtSafeBoundary({ verb: `step ${n}` }, (lease) =>
    framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-s' }, step: n }));
  const rerun = async (change: ResolvedOperatorChange, n: number) => {
    const outcome = framework.rerunUnstick(change as never, { step: n });
    await framework.runUntilIdle();
    return outcome;
  };

  it('stages the whole plan, newest exchange first, with exact ids and changes nothing', async () => {
    const before = texts();
    const r = await unstick(3);
    assert.deepEqual([r.ok, r.code, r.cap], [false, 'staged', 3]);
    const change = asked[0]!;
    assert.equal(change.kind, 'unstick');
    const plan = change.kind === 'unstick' ? change.plan : [];
    assert.deepEqual(plan.map((p) => p.messageIds.map(textOf)), [['culprit'], ['reply to two'], ['two']], 'the known range at risk');
    assert.ok(plan.every((p) => p.fingerprints.length === p.messageIds.length));
    assert.deepEqual(texts(), before);
  });

  it('applies planned steps under leases and re-runs between them, never shedding a later arrival', async () => {
    await unstick(3);
    const change = asked[0]!;
    host().addMessage('user', [{ type: 'text', text: 'later arrival' }]); // e.g. the notice's answer
    assert.deepEqual((await step(change, 1)).kind === 'unstick' && (await step(change, 1)), { kind: 'unstick', step: 1, shedIds: (change as { plan: Array<{ messageIds: string[] }> }).plan[0]!.messageIds, alreadyApplied: true });
    assert.deepEqual(texts(), ['one', 'reply to one', 'two', 'reply to two', 'later arrival']);
    membrane.pushResponse(refusal());
    assert.deepEqual(await rerun(change, 1), { step: 1, status: 'completed', outcome: 'refused', category: 'unknown' });
    await step(change, 2);
    assert.deepEqual(texts(), ['one', 'reply to one', 'two', 'later arrival'], 'step 2 took its planned exchange, not the later arrival');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
    const second = await rerun(change, 2);
    assert.equal(second.status === 'completed' && second.outcome, 'responded');
    const op = framework.getUnstickOperation(change.id)!;
    assert.deepEqual(op.steps.map((s) => [s.step, s.status]), [[1, 'shed'], [2, 'shed']]);
    assert.deepEqual(op.attempts.map((a) => [a.step, a.outcome]), [[1, 'refused'], [2, 'responded']]);
  });

  it('takes steps only in order, after a refused re-run, and only within the plan', async () => {
    await unstick(2);
    const change = asked[0]!;
    await assert.rejects(step(change, 2), /follows only a refused re-run after step 1/);
    await step(change, 1);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'fine now' }]));
    await rerun(change, 1);
    await assert.rejects(step(change, 2), /follows only a refused re-run/, 'it responded: nothing more is authorized');
    await assert.rejects(step(change, 3), /plans 2 step\(s\); there is no step 3/);
  });

  it('refuses a step whose planned message was edited in place, or whose branch moved', async () => {
    await unstick(2);
    const change = asked[0]!;
    await step(change, 1);
    membrane.pushResponse(refusal());
    await rerun(change, 1);
    const planned = (change as { plan: Array<{ messageIds: string[] }> }).plan[1]!.messageIds[0]!;
    cm().editMessage(planned as never, [{ type: 'text', text: 'reply to two, edited' }]);
    await assert.rejects(step(change, 2), (e: Error & { code?: string }) => e.code === 'stale' && /changed since it was approved/.test(e.message));
    const store = framework.getStore();
    store.createBranch('elsewhere');
    store.switchBranch('elsewhere');
    await assert.rejects(step(change, 2), (e: Error & { code?: string }) => e.code === 'stale' && /active branch moved/.test(e.message));
  });

  // A re-run's outcome, or 'pending' if it hasn't settled while the framework
  // was driven for `ms`.
  const outcomeWithin = async (outcome: Promise<unknown>, ms = 3_000) => {
    let settled: unknown = 'pending';
    void outcome.then((o) => { settled = o; }, (e) => { settled = e; });
    const deadline = Date.now() + ms;
    while (settled === 'pending' && Date.now() < deadline) {
      await framework.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return settled;
  };
  // The provider refuses to set up the stream `times` times, then serves.
  const failSetup = (times: number, message: string) => {
    const real = membrane.streamYielding.bind(membrane);
    let left = times;
    membrane.streamYielding = (...args: Parameters<MockMembrane['streamYielding']>) => {
      if (left-- > 0) throw new Error(message);
      return real(...args);
    };
    return () => { membrane.streamYielding = real; };
  };
  type Policies = {
    errorPolicy: { onInferenceError: (e: Error, agent: string, attempt: number) => { retry: boolean; delayMs?: number } };
    providerHoldHook?: (e: Error) => { holdMs: number } | undefined;
  };

  it('settles and releases a re-run whose turn fails before its stream starts: its caller hears, and the agent is not left busy', async () => {
    await unstick(3);
    const change = asked[0]!;
    await step(change, 1);
    (framework as unknown as Policies).errorPolicy = { onInferenceError: () => ({ retry: false }) };
    const undoSetup = failSetup(1, 'provider setup refused the request');
    try {
      const outcome = await outcomeWithin(framework.rerunUnstick(change as never, { step: 1 }));
      assert.deepEqual(outcome, { step: 1, status: 'completed', outcome: 'failed', error: 'provider setup refused the request' });
    } finally {
      undoSetup();
    }
    assert.equal(host().unstickAttemptWaiters.size, 0, 'released');
    assert.deepEqual(framework.getUnstickOperation(change.id)!.attempts,
      [{ step: 1, status: 'completed', outcome: 'failed', error: 'provider setup refused the request' }], 'journaled');
    // The agent isn't held busy: another operation's re-run starts and runs.
    await unstick(1);
    const other = asked[1]!;
    await step(other, 1);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answered' }]));
    const second = await outcomeWithin(framework.rerunUnstick(other as never, { step: 1 }));
    assert.deepEqual(second, { step: 1, status: 'completed', outcome: 'responded' });
  });

  it('keeps a re-run bound through a setup retry and a provider hold, reporting the turn that finally ran', async () => {
    await unstick(3);
    const change = asked[0]!;
    await step(change, 1);
    (framework as unknown as Policies).errorPolicy = {
      onInferenceError: (_e, _agent, attempt) => (attempt < 1 ? { retry: true, delayMs: 1 } : { retry: false }),
    };
    let undoSetup = failSetup(1, 'transient setup failure');
    try {
      membrane.pushResponse(refusal());
      const retried = await outcomeWithin(framework.rerunUnstick(change as never, { step: 1 }));
      assert.deepEqual(retried, { step: 1, status: 'completed', outcome: 'refused', category: 'unknown' }, 'the retried turn\'s own outcome');
    } finally {
      undoSetup();
    }
    await step(change, 2);
    let holds = 1; // the host holds once; asked again when the slice expires, it releases
    (framework as unknown as Policies).providerHoldHook = (e) => (/quota/.test(e.message) && holds-- > 0 ? { holdMs: 1_000 } : undefined);
    undoSetup = failSetup(1, 'quota exhausted for now');
    try {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
      const held = await outcomeWithin(framework.rerunUnstick(change as never, { step: 2 }), 6_000);
      assert.deepEqual(held, { step: 2, status: 'completed', outcome: 'responded' }, 'held, then run: not failed by the hold');
    } finally {
      undoSetup();
    }
    assert.equal(host().unstickAttemptWaiters.size, 0);
  });

  it('finishes an interrupted step on its planned exchange, never another', async () => {
    await unstick(2);
    const change = asked[0]!;
    const manager = cm() as unknown as { removeMessage: (id: string) => void };
    const realRemove = manager.removeMessage.bind(manager);
    manager.removeMessage = () => { throw new Error('injected crash mid-shed'); };
    try {
      await assert.rejects(step(change, 1), /injected crash mid-shed/);
    } finally {
      manager.removeMessage = realRemove;
    }
    assert.equal(framework.getUnstickOperation(change.id)!.steps[0]!.status, 'intent', 'the intent was journaled first');
    const finished = await step(change, 1);
    assert.equal(finished.kind === 'unstick' && finished.alreadyApplied, undefined, 'finished now');
    assert.deepEqual(texts(), ['one', 'reply to one', 'two', 'reply to two'], 'exactly the culprit, nothing older');
    assert.equal(framework.getUnstickOperation(change.id)!.steps[0]!.status, 'shed');
  });

  it('launches each re-run at most once, and reports an orphaned one as interrupted', async () => {
    await unstick(2);
    const change = asked[0]!;
    await step(change, 1);
    const first = framework.rerunUnstick(change as never, { step: 1 });
    const again = framework.rerunUnstick(change as never, { step: 1 });
    assert.equal(host().pendingRequests.filter((r) => r.reason === 'unstick-attempt').length, 1, 'one inference queued');
    // As if the process died before the queued re-run ran.
    host().pendingRequests.length = 0;
    host().unstickAttemptWaiters.clear();
    host().unstickJournalState = null;
    assert.deepEqual(await framework.rerunUnstick(change as never, { step: 1 }), { step: 1, status: 'interrupted' });
    assert.equal(host().pendingRequests.length, 0, 'never relaunched');
    void first; void again;
  });

  it('keeps its record when the branch moves, since the journal is the store\'s, not the branch\'s', async () => {
    await unstick(2);
    const change = asked[0]!;
    await step(change, 1);
    const store = framework.getStore();
    store.createBranch('moved');
    store.switchBranch('moved');
    host().unstickJournalState = null; // reload from the store
    assert.equal(framework.getUnstickOperation(change.id)!.steps[0]!.status, 'shed');
  });

  it("refuses a plan in any store but the one it was staged in, a replacement store included", async () => {
    await unstick(1);
    const change = asked[0]!;
    // A fresh store with the same agent, branch name and tail id.
    const other = await AgentFramework.create({
      storePath: join(tempDir, 'replacement.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
    });
    try {
      const ocm = other.getAgent('scout')!.getContextManager();
      ocm.addMessage('user', [{ type: 'text', text: 'culprit' }]);
      await assert.rejects(
        other.runAtSafeBoundary({ verb: 'apply elsewhere' }, (lease) =>
          other.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-s' }, step: 1 })),
        (e: Error & { code?: string }) => e.code === 'stale' && /another store/.test(e.message),
      );
      assert.equal(ocm.getAllMessages().length, 1, 'nothing removed there');
    } finally {
      await other.stop();
    }
  });

  it('keeps every operation through journal checkpoints, finished or not', async () => {
    await unstick(1);
    const change = asked[0]!;
    await step(change, 1);
    const journal = framework as unknown as { journalUnstick: (entry: unknown, opts: object) => void };
    for (let i = 0; i < 70; i++) {
      journal.journalUnstick({ kind: 'step-intent', operationId: `filler-${i}`, agent: 'scout', step: 1, messageIds: [] }, {});
    }
    host().unstickJournalState = null; // reload from the store, through the checkpoint
    assert.equal(framework.getUnstickOperation(change.id)!.steps[0]!.status, 'shed', 'its re-run still pending, it is still on record');
  });

  it("refuses a second agent's re-run while one is in flight, recording nothing for it", async () => {
    await unstick(1);
    const first = asked[0]!;
    await step(first, 1);
    host().addMessage('user', [{ type: 'text', text: 'second culprit' }]);
    await unstick(1);
    const second = asked[1]!;
    await step(second, 1);
    void framework.rerunUnstick(first as never, { step: 1 });
    await assert.rejects(framework.rerunUnstick(second as never, { step: 1 }), (e: Error & { code?: string }) => e.code === 'agent-busy');
    assert.equal(framework.getUnstickOperation(second.id)!.attempts.length, 0);
    assert.equal(host().pendingRequests.filter((r) => r.reason === 'unstick-attempt').length, 1);
  });

  it('makes a duplicate caller wait for the same settlement as the first', async () => {
    await unstick(1);
    const change = asked[0]!;
    await step(change, 1);
    const fw = framework as unknown as { releaseUnstickAttempt: (b: unknown) => void };
    const realRelease = fw.releaseUnstickAttempt.bind(fw);
    let held: unknown = null;
    fw.releaseUnstickAttempt = (b) => { held = b; }; // the turn hasn't settled yet
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
    const first = framework.rerunUnstick(change as never, { step: 1 });
    await framework.runUntilIdle();
    assert.equal(framework.getUnstickOperation(change.id)!.attempts[0]!.status, 'completed', 'the outcome is recorded');
    const duplicate = framework.rerunUnstick(change as never, { step: 1 });
    const early = await Promise.race([duplicate.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('waiting'), 50))]);
    assert.equal(early, 'waiting', 'not before settlement');
    fw.releaseUnstickAttempt = realRelease;
    realRelease(held);
    assert.deepEqual(await duplicate, await first);
  });

  it('keeps one marker per operation, counting a repaired step once', async () => {
    await unstick(2);
    const change = asked[0]!;
    const journal = framework as unknown as { journalUnstick: (entry: { kind: string }, opts: object) => void };
    const realJournal = journal.journalUnstick.bind(journal);
    let armed = true;
    journal.journalUnstick = (entry, opts) => {
      if (armed && entry.kind === 'step-done') { armed = false; throw new Error('injected completion failure'); }
      return realJournal(entry, opts);
    };
    try {
      await assert.rejects(step(change, 1), /injected completion failure/);
    } finally {
      journal.journalUnstick = realJournal;
    }
    await step(change, 1); // the repair
    const markers = (cm().getAllMessages() as Array<{ content: Array<{ text?: string }>; metadata?: { kind?: string } }>)
      .filter((m) => m.metadata?.kind === 'unstick-marker');
    assert.equal(markers.length, 1, 'one marker for the operation');
    assert.match(String(markers[0]!.content[0]!.text), /set aside 1 earlier exchange\(s\)/);
    assert.match(String(markers[0]!.content[0]!.text), /Messages that arrived after them were kept/);
  });

  it("fails a queued re-run whose source moved before it started, and keeps an ordinary wake batched with it", async () => {
    await unstick(1);
    const change = asked[0]!;
    await step(change, 1);
    const attempt = framework.rerunUnstick(change as never, { step: 1 }); // queued first, not yet run
    host().pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest);
    const store = framework.getStore();
    store.createBranch('moved-before-dispatch');
    store.switchBranch('moved-before-dispatch');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ordinary answer' }]));
    const fw = framework as unknown as { startAgentStream: (agent: unknown, trigger: InferenceRequest) => Promise<unknown> };
    const realStart = fw.startAgentStream.bind(fw);
    const dispatched: InferenceRequest[] = [];
    fw.startAgentStream = (agent, trigger) => { dispatched.push(trigger); return realStart(agent, trigger); };
    try {
      await framework.runUntilIdle();
    } finally {
      fw.startAgentStream = realStart;
    }
    assert.equal(dispatched.length, 1, 'one turn: the ordinary wake');
    assert.equal(dispatched[0]!.unstick, undefined, 'the turn carries no unstick binding');
    assert.notEqual(dispatched[0]!.reason, 'unstick-attempt', 'nor its reason');
    const outcome = await attempt;
    assert.equal(outcome.status === 'completed' && outcome.outcome, 'failed');
    assert.match(String(outcome.status === 'completed' && outcome.error), /moved before the re-run started/);
    assert.equal(texts().at(-1), 'ordinary answer', 'the ordinary wake still had its turn');
    assert.equal(framework.getUnstickOperation(change.id)!.attempts[0]!.outcome, 'failed', 'and it was not reported as the re-run');
  });

  it("settles a re-run the inference policy declines, leaving the agent's next re-run free", async () => {
    await unstick(1);
    const first = asked[0]!;
    await step(first, 1);
    const fw = framework as unknown as { inferencePolicy: { shouldInfer: (...args: unknown[]) => boolean } };
    const realPolicy = fw.inferencePolicy;
    fw.inferencePolicy = { ...realPolicy, shouldInfer: () => false };
    let outcome;
    try {
      outcome = await rerun(first, 1);
    } finally {
      fw.inferencePolicy = realPolicy;
    }
    assert.deepEqual(outcome.status === 'completed' && [outcome.outcome, /policy declined/.test(String(outcome.error))], ['failed', true]);
    assert.equal(framework.getUnstickOperation(first.id)!.attempts[0]!.outcome, 'failed');
    host().addMessage('user', [{ type: 'text', text: 'second culprit' }]);
    await unstick(1);
    const second = asked[1]!;
    await step(second, 1);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'back' }]));
    const next = await rerun(second, 1);
    assert.equal(next.status === 'completed' && next.outcome, 'responded', 'not refused as busy');
  });

  it('releases a waiting re-run as interrupted when the framework stops', async () => {
    await unstick(1);
    const change = asked[0]!;
    await step(change, 1);
    const fw = framework as unknown as { inferencePolicy: { shouldInfer: (...args: unknown[]) => boolean } };
    const attempt = framework.rerunUnstick(change as never, { step: 1 }); // queued; nothing dispatches it
    await framework.stop();
    assert.deepEqual(await attempt, { step: 1, status: 'interrupted' });
    void fw;
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
      operatorChangeGate: async (c) => { asked.push(structuredClone(c)); return decide(c); },
    });
    assert.equal(framework.getUnstickOperation(change.id)!.attempts[0]!.status, 'launched', 'the journal agrees: launched, which reads interrupted');
  });

  it('runs back to back as a host would: each step after the previous re-run has fully settled', async () => {
    await unstick(3);
    const change = asked[0]!;
    // One response per re-run, queued as it starts: the mock hands a stream
    // every queued response (later ones resume tool rounds).
    const responses = [refusal(), refusal(), createMockResponse([{ type: 'text', text: 'back' }])];
    let done = false;
    const pump = (async () => { while (!done) { await framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 5)); } })();
    const outcomes: string[] = [];
    try {
      for (const { step: n } of (change as { plan: Array<{ step: number }> }).plan) {
        await step(change, n); // takes the lease as soon as the previous re-run has settled
        membrane.pushResponse(responses[n - 1]!);
        const attempt = await framework.rerunUnstick(change as never, { step: n });
        // Resolved only once the turn has fully settled: no live turn left.
        assert.equal((framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens.has('scout'), false);
        assert.equal(framework.getAgent('scout')!.state.status, 'idle');
        outcomes.push(attempt.status === 'completed' ? attempt.outcome : attempt.status);
        if (attempt.status !== 'completed' || attempt.outcome !== 'refused') break;
      }
    } finally {
      done = true;
      await pump;
    }
    assert.deepEqual(outcomes, ['refused', 'refused', 'responded']);
    assert.deepEqual(framework.getUnstickOperation(change.id)!.steps.map((x) => x.status), ['shed', 'shed', 'shed']);
    assert.deepEqual(texts(), ['one', 'reply to one', 'back'], 'exactly the planned range went, then the agent answered');
  });
});

describe('surgery bound to the context it was previewed in', () => {
  let dir: string;
  let a: AgentFramework;
  let b: AgentFramework;
  let quiet: { log: typeof console.log; error: typeof console.error };
  const make = (name: string) => AgentFramework.create({
    storePath: join(dir, name),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
    modules: [],
  });
  const seed = (fw: AgentFramework, n: number) => {
    const cm = fw.getAgent('scout')!.getContextManager();
    for (let i = 0; i < n; i++) cm.addMessage('user', [{ type: 'text', text: `m${i}` }]);
    return cm;
  };
  const stale = (pattern: RegExp) => (e: Error & { code?: string }) => e.code === 'stale' && pattern.test(e.message);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'surgery-context-'));
    quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    a = await make('a');
    b = await make('b');
  });
  afterEach(async () => {
    await a.stop();
    await b.stop();
    console.log = quiet.log;
    console.error = quiet.error;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a rollback previewed in one store when it reaches another, before any change', async () => {
    const ca = seed(a, 5);
    const cb = seed(b, 5);
    const target = String(ca.getAllMessages()[1]!.id);
    assert.equal(String(cb.getAllMessages()[1]!.id), target, 'both stores assign the same id');
    const preview = a.previewSurgeryMarks('scout', { rollbackTo: target });
    assert.equal(preview.context.storeId, a.getStoreIdentity());
    assert.notEqual(a.getStoreIdentity(), b.getStoreIdentity());
    await assert.rejects(b.rollbackToMessage('scout', { messageId: target, expected: preview.context }), stale(/another store/));
    assert.equal(cb.getAllMessages().length, 5, 'the other store is untouched');
    const rolled = await a.rollbackToMessage('scout', { messageId: target, expected: preview.context });
    assert.equal(rolled.messagesRemoved, 3);
  });

  it('refuses a rollback whose branch moved since its preview, and keeps same-branch arrivals within it', async () => {
    const ca = seed(a, 5);
    const target = String(ca.getAllMessages()[1]!.id);
    const preview = a.previewSurgeryMarks('scout', { rollbackTo: target });
    ca.addMessage('user', [{ type: 'text', text: 'arrived since' }]);
    const store = a.getStore();
    store.createBranch('moved');
    store.switchBranch('moved');
    await assert.rejects(a.rollbackToMessage('scout', { messageId: target, expected: preview.context }), stale(/active branch moved/));
    store.switchBranch(preview.context.branch);
    const rolled = await a.rollbackToMessage('scout', { messageId: target, expected: preview.context });
    assert.equal(rolled.messagesRemoved, 4, 'the arrival on the same branch is part of the chosen rollback');
  });

  it('checks the same context for a suppression', async () => {
    const ca = seed(a, 5);
    seed(b, 5);
    const target = String(ca.getAllMessages()[2]!.id);
    const preview = a.previewSurgeryMarks('scout', { suppress: [target] });
    await assert.rejects(b.suppressMessages('scout', { messageIds: [target], expected: preview.context }), stale(/another store/));
    assert.equal(b.getAgent('scout')!.getContextManager().getAllMessages().length, 5);
  });
});


describe('operator journals that cannot be read', () => {
  let dir: string;
  let quiet: { log: typeof console.log; error: typeof console.error };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-journal-unreadable-'));
    quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
  });
  afterEach(() => {
    console.log = quiet.log;
    console.error = quiet.error;
    rmSync(dir, { recursive: true, force: true });
  });
  const unreadable = (store: JsStore, type: string) => {
    const real = store.getRecordIdsByType.bind(store);
    store.getRecordIdsByType = (t: string) => {
      if (t === type) throw new Error('injected read failure');
      return real(t);
    };
  };

  for (const type of ['operator/changes', 'operator/unstick']) {
    it(`refuses to start when ${type} can't be read, rather than reading it as empty`, async () => {
      const store = JsStore.openOrCreate({ path: join(dir, 'store') });
      unreadable(store, type);
      await assert.rejects(
        AgentFramework.create({
          store,
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
          modules: [],
        }),
        (e: Error) => e.name === 'OperatorJournalUnreadableError' && e.message.includes(type),
      );
    });
  }

  const evidence = { target: 'undo/scout/op-x', source: 'main', sourceHead: 1, removed: 1, staged: false,
    marks: { scope: 'none', refs: [], unmarked: 0, notRemoved: 0 } };
  const startOn = (store: JsStore) => AgentFramework.create({
    store,
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
    modules: [],
  });
  const refusedAs = (type: string) => (e: Error) => e.name === 'OperatorJournalUnreadableError' && e.message.includes(type) && /malformed/.test(e.message);

  it('refuses a checkpoint whose snapshot is null rather than reading the entries it covers as gone', async () => {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const pending = store.appendJson('operator/changes', { kind: 'attempt', changeId: 'pending', changeKind: 'undo-turns', agent: 'scout', n: 1, at: 1, evidence });
    store.appendJson('operator/changes/checkpoint', { through: String(pending.id), snapshot: null });
    store.sync();
    await assert.rejects(startOn(store), refusedAs('operator/changes'));
  });

  it('refuses an entry missing what its kind requires', async () => {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    store.appendJson('operator/changes', { kind: 'attempt', changeId: 'half' });
    store.sync();
    await assert.rejects(startOn(store), refusedAs('operator/changes'));
  });

  const hideEvidence = { ...evidence, target: 'main', source: 'main', removed: 2, ids: [{ id: 'm1', fingerprint: 'f1' }, { id: 'm2', fingerprint: 'f2' }] };
  let ledgers = 0;
  const refuses = async (entries: object[], why: RegExp) => {
    const store = JsStore.openOrCreate({ path: join(dir, `ledger-${++ledgers}`) });
    try {
      for (const entry of entries) store.appendJson('operator/changes', entry);
      store.sync();
      await assert.rejects(startOn(store), (e: Error) => refusedAs('operator/changes')(e) && why.test(e.message));
    } finally {
      store.close();
    }
  };
  const hideAttempt = (ev: object) => ({ kind: 'attempt', changeId: 'h', changeKind: 'hide', agent: 'scout', n: 1, at: 1, evidence: ev });

  it("refuses a hide attempt without its ids, which recovery would read as an empty removal", async () => {
    const { ids: _omitted, ...withoutIds } = hideEvidence;
    await refuses([hideAttempt(withoutIds)], /a hide's ids/);
  });

  it('refuses a hide whose removal count differs from its ids', async () => {
    await refuses([hideAttempt({ ...hideEvidence, removed: 3 })], /a hide removes exactly its ids/);
  });

  it('refuses a marks ref missing what delivery dereferences', async () => {
    const marks = { scope: 'all', refs: [{ serverId: 's', channelId: 'c' }], unmarked: 0, notRemoved: 0 };
    await refuses([hideAttempt({ ...hideEvidence, marks })], /a marks ref/);
  });

  it('refuses an outcome whose receipt lacks what its status needs', async () => {
    const markers = { scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 1 };
    await refuses([hideAttempt(hideEvidence), { kind: 'outcome', changeId: 'h', outcome: { n: 1, at: 2, removed: 2, markers } }], /markers receipt/);
  });

  it('refuses an outcome, or a switch, that names no attempt of its own', async () => {
    const markers = { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 };
    await refuses([hideAttempt(hideEvidence), { kind: 'outcome', changeId: 'h', outcome: { n: 2, at: 2, removed: 2, markers } }], /names no attempt of its own/);
    await refuses([{ kind: 'switched', changeId: 'never-attempted', n: 1 }], /switched entry/);
  });

  it('refuses a null-snapshot checkpoint in the unstick journal too', async () => {
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const launched = store.appendJson('operator/unstick', { kind: 'attempt-launched', operationId: 'op', agent: 'scout', step: 1 });
    store.appendJson('operator/unstick/checkpoint', { through: String(launched.id), snapshot: null });
    store.sync();
    await assert.rejects(startOn(store), refusedAs('operator/unstick'));
  });

  // operator/unstick, read as applyUnstickStep and rerunUnstick read it.
  const unstickStore = (snapshot: object | undefined, entries: object[]) => {
    const store = JsStore.openOrCreate({ path: join(dir, `unstick-${++ledgers}`) });
    if (snapshot) {
      const covered = store.appendJson('operator/unstick', { kind: 'step-intent', operationId: 'covered', agent: 'scout', step: 1, messageIds: ['c'] });
      store.appendJson('operator/unstick/checkpoint', { through: String(covered.id), snapshot });
    }
    for (const entry of entries) store.appendJson('operator/unstick', entry);
    store.sync();
    return store;
  };
  const unstickRefuses = async (snapshot: object | undefined, entries: object[], why: RegExp) => {
    const store = unstickStore(snapshot, entries);
    try {
      await assert.rejects(startOn(store), (e: Error) => refusedAs('operator/unstick')(e) && why.test(e.message));
    } finally {
      store.close();
    }
  };
  const operation = (attempts: object[], steps: object[] = [{ step: 1, status: 'shed', messageIds: ['m1', 'm2'] }]) =>
    ({ op: { operationId: 'op', agent: 'scout', steps, attempts } });
  const intent = (step: number, agent = 'scout') => ({ kind: 'step-intent', operationId: 'op', agent, step, messageIds: [`m${step}`] });
  const shed = (step: number) => ({ kind: 'step-done', operationId: 'op', step });
  const launched = (step: number) => ({ kind: 'attempt-launched', operationId: 'op', agent: 'scout', step });

  it('refuses an unstick checkpoint whose attempt or step misstates what it records, rather than reporting an outcome it lacks', async () => {
    await unstickRefuses(operation([{ step: 1, status: 'completed' }]), [], /operation op: attempt 1 \(launched with no outcome, or completed with one\)/);
    await unstickRefuses(operation([{ step: 1, status: 'completed', outcome: 'maybe' }]), [], /attempt 1/);
    await unstickRefuses(operation([{ step: 1, status: 'done', outcome: 'responded' }]), [], /attempt 1/);
    await unstickRefuses(operation([{ step: 1, status: 'launched', outcome: 'refused' }]), [], /attempt 1/);
    await unstickRefuses(operation([{ step: 1, status: 'completed', outcome: 'refused', category: 7 }]), [], /attempt 1/);
    await unstickRefuses(operation([{ step: 1, status: 'launched' }, { step: 1, status: 'launched' }]), [], /an attempt/);
    await unstickRefuses(operation([], [{ step: 1, status: 'finished', messageIds: ['m1'] }]), [], /a step/);
    await unstickRefuses(operation([], [{ step: 1, status: 'shed', messageIds: [7] }]), [], /a step/);
    await unstickRefuses(operation([], [{ step: 0.5, status: 'shed', messageIds: ['m1'] }]), [], /a step/);
  });

  it('refuses unstick entries that misstate their ids, or name a step or attempt the ledger never held', async () => {
    await unstickRefuses(undefined, [{ ...intent(1), messageIds: [1, 2] }], /step-intent entry for op step 1/);
    await unstickRefuses(undefined, [shed(1)], /no such step/);
    await unstickRefuses(undefined, [intent(1), launched(1)], /its step was never shed/);
    await unstickRefuses(undefined, [intent(1), shed(1), { kind: 'attempt-done', operationId: 'op', step: 1, outcome: 'refused' }], /no such attempt/);
    await unstickRefuses(undefined, [intent(1), shed(1), launched(1), { kind: 'attempt-done', operationId: 'op', step: 1, outcome: 'refused', error: {} }], /attempt-done entry/);
    await unstickRefuses(undefined, [intent(1), intent(2, 'someone-else')], /its agent differs/);
  });

  it('reads a well-formed unstick ledger, its checkpoint and the entries after it, as before', async () => {
    const store = unstickStore(operation([{ step: 1, status: 'completed', outcome: 'refused', category: 'safety' }]),
      [intent(2), shed(2), launched(2), { kind: 'attempt-done', operationId: 'op', step: 2, outcome: 'responded' }]);
    const framework = await startOn(store);
    try {
      assert.deepEqual(framework.getUnstickOperation('op'), {
        operationId: 'op',
        agent: 'scout',
        steps: [{ step: 1, status: 'shed', messageIds: ['m1', 'm2'] }, { step: 2, status: 'shed', messageIds: ['m2'] }],
        attempts: [{ step: 1, status: 'completed', outcome: 'refused', category: 'safety' }, { step: 2, status: 'completed', outcome: 'responded' }],
      });
    } finally {
      await framework.stop();
      store.close();
    }
  });

  it('refuses a malformed ledger offline as well', () => {
    const path = join(dir, 'offline');
    const store = JsStore.openOrCreate({ path });
    const pending = store.appendJson('operator/changes', { kind: 'attempt', changeId: 'pending', changeKind: 'undo-turns', agent: 'scout', n: 1, at: 1, evidence });
    store.appendJson('operator/changes/checkpoint', { through: String(pending.id), snapshot: null });
    store.sync();
    store.close();
    const cli = fileURLToPath(new URL('../src/recovery/recover-cli.js', import.meta.url));
    const run = spawnSync(process.execPath, [cli, '--store', path, '--operator-change', 'list'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /malformed operator\/changes checkpoint/);
  });

  it('fails an operation mid-run when operator/changes becomes unreadable, never answering as if it were empty', async () => {
    const framework = await AgentFramework.create({
      storePath: join(dir, 'live'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', maxTokens: 1000 }],
      modules: [],
    });
    try {
      (framework as unknown as { changesJournalState: unknown }).changesJournalState = null; // the next use loads again
      unreadable(framework.getStore() as JsStore, 'operator/changes');
      for (const attempt of ['first', 'again']) {
        assert.throws(() => framework.getOperatorChangeRecord('prior-hide'), (e: Error) => e.name === 'OperatorJournalUnreadableError',
          `${attempt}: an unreadable journal is never installed as an empty one`);
      }
    } finally {
      await framework.stop();
    }
  });
});

describe('a hard kill between a body change and its outcome record', () => {
  it('never keeps an outcome without the body it certifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-outcome-kill-'));
    try {
      const index = fileURLToPath(new URL('../src/index.js', import.meta.url));
      const mock = fileURLToPath(new URL('./helpers/mock-membrane.js', import.meta.url));
      const script = join(dir, 'child.mjs');
      writeFileSync(script, `
        import { AgentFramework } from ${JSON.stringify(index)};
        import { MockMembrane } from ${JSON.stringify(mock)};
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const [mode, dir] = process.argv.slice(2);
        console.log = () => {}; console.error = () => {};
        const staged = [];
        const fw = await AgentFramework.create({
          storePath: join(dir, 'store'),
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'x', maxTokens: 1000 }],
          modules: [],
          operatorChangeGate: async (c) => { staged.push(c); return { id: 'rev', text: 'staged' }; },
        });
        const cm = fw.getAgent('scout').getContextManager();
        const texts = () => cm.getAllMessages().map((m) => m.content[0]?.text);
        if (mode === 'check') {
          const ids = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'change.json'), 'utf8'));
          const record = fw.getOperatorChangeRecord(ids.id);
          writeFileSync(join(dir, 'after.json'), JSON.stringify({ removed: record?.outcome?.removed ?? null, texts: texts() }));
          await fw.stop();
          process.exit(0);
        }
        for (const id of ['m0', 'm1', 'm2', 'm3']) {
          cm.addMessage('Member', [{ type: 'text', text: id }], { serverId: 'discord', channelId: 'discord:g1:c1', messageId: id });
        }
        fw.getStore().sync();
        await fw.handleHostCommand('discord', { command: 'hide', agentName: 'scout', fromMessageId: 'm1', toMessageId: 'm2', marks: 'none' });
        const change = staged[0];
        writeFileSync(join(dir, 'change.json'), JSON.stringify({ id: change.id }));
        const store = fw.getStore();
        const realAppend = store.appendJson.bind(store);
        const realSync = store.sync.bind(store);
        let outcomeAppended = false;
        store.appendJson = (type, data) => {
          const record = realAppend(type, data);
          if (type === 'operator/changes' && data && data.kind === 'outcome') outcomeAppended = true;
          return record;
        };
        store.sync = () => { if (outcomeAppended) process.kill(process.pid, 'SIGKILL'); return realSync(); };
        await fw.runAtSafeBoundary({ verb: 'apply' }, (lease) => fw.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev' } }));
        process.exit(3); // not reached: killed at the sync right after the outcome append
      `);
      const run = (mode: string) => spawnSync(process.execPath, [script, mode, dir], { encoding: 'utf8' });
      const applied = run('apply');
      assert.equal(applied.signal, 'SIGKILL', applied.stderr);
      const check = run('check');
      assert.equal(check.status, 0, check.stderr);
      const after = JSON.parse(readFileSync(join(dir, 'after.json'), 'utf8')) as { removed: number | null; texts: string[] };
      assert.equal(after.removed, 2, 'the outcome is known after reopen (recorded, or established at startup)');
      assert.deepEqual(after.texts, ['m0', 'm3'], 'and the body it certifies is there with it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operator-change gate: the API server', () => {
  type Host = { addMessage(participant: string, content: unknown[]): string; pendingRequests: InferenceRequest[] };
  type Response = { success: boolean; data?: unknown; error?: string };

  /** A framework, with or without a gate, behind an API server on an ephemeral port. */
  async function withApi(gated: boolean, fn: (h: {
    framework: AgentFramework;
    send: (command: string, params: Record<string, unknown>) => Promise<Response>;
    texts: () => string[];
    asked: ResolvedOperatorChange[];
  }) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'operator-gate-api-'));
    const membrane = new MockMembrane();
    const asked: ResolvedOperatorChange[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'test', maxTokens: 1000 }],
      modules: [],
      ...(gated ? { operatorChangeGate: async (change: ResolvedOperatorChange) => { asked.push(change); return { id: 'rev', text: 'staged' }; } } : {}),
    });
    const quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    const server = new ApiServer(framework, { port: 0, host: '127.0.0.1' });
    await server.start();
    const port = (server as unknown as { httpServer: { address(): { port: number } } }).httpServer.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    let n = 0;
    const send = (command: string, params: Record<string, unknown>) => new Promise<Response>((resolve) => {
      const id = `c${++n}`;
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString()) as Response & { type: string; id: string };
        if (msg.type === 'response' && msg.id === id) { ws.off('message', onMessage); resolve(msg); }
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ type: 'request', id, command, params }));
    });
    const texts = () => (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ text?: string }> }>)
      .map((m) => m.content[0]?.text ?? '');
    try {
      const host = framework as unknown as Host;
      for (const t of ['one', 'two']) {
        host.addMessage('user', [{ type: 'text', text: t }]);
        membrane.pushResponse(createMockResponse([{ type: 'text', text: `reply to ${t}` }]));
        host.pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() } as InferenceRequest);
        await framework.runUntilIdle();
      }
      await fn({ framework, send, texts, asked });
    } finally {
      ws.close();
      console.log = quiet.log;
      console.error = quiet.error;
      await server.stop();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses undo, redo and branch switches whole while a gate is configured, saying why; the host's own calls stay its own", async () => {
    await withApi(true, async ({ framework, send, texts, asked }) => {
      const store = framework.getStore();
      const snapshot = () => ({ texts: texts(), branch: store.currentBranch().name, branches: store.listBranches().map((b) => b.name).sort() });
      const before = snapshot();
      const refusals = [
        await send('undo', { agentName: 'scout' }),
        await send('branch.create', { name: 'side', switchTo: true }),
        await send('branch.switch', { name: before.branch }),
      ];
      for (const r of refusals) {
        assert.equal(r.success, false);
        assert.match(String(r.error), /refused: an operator-change gate is configured, and this API can't stage the change; use the host's command for it/);
      }
      assert.deepEqual(snapshot(), before, 'nothing changed, and branch.create made no branch');

      // The host's own undo is the host's responsibility; the API's redo of it is refused too.
      const undone = framework.undoLastTurn('scout');
      assert.equal(undone.undone, true);
      const afterHostUndo = snapshot();
      const redo = await send('redo', { agentName: 'scout' });
      assert.equal(redo.success, false);
      assert.match(String(redo.error), /^redo refused: an operator-change gate is configured/);
      assert.deepEqual(snapshot(), afterHostUndo);
      assert.equal(asked.length, 0, 'the API never stages');

      const created = await send('branch.create', { name: 'side' });
      assert.equal(created.success, true, 'creating a branch without switching changes no body');
    });
  });

  it('keeps undo, redo and branch switches without a gate', async () => {
    await withApi(false, async ({ framework, send, texts }) => {
      const undo = await send('undo', { agentName: 'scout' });
      assert.equal(undo.success, true, String(undo.error));
      assert.deepEqual(texts(), ['one', 'reply to one', 'two']);
      const redo = await send('redo', { agentName: 'scout' });
      assert.equal(redo.success, true, String(redo.error));
      assert.deepEqual(texts(), ['one', 'reply to one', 'two', 'reply to two']);
      const created = await send('branch.create', { name: 'side', switchTo: true });
      assert.equal(created.success, true, String(created.error));
      assert.equal(framework.getStore().currentBranch().name, 'side');
    });
  });
});
