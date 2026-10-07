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
  AgentSettingsExtension,
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
  let decide: (change: ResolvedOperatorChange) => Promise<OperatorChangeDecision>;
  let quiet: typeof console.log;

  const staged = async (change: ResolvedOperatorChange): Promise<OperatorChangeDecision> =>
    ({ decision: 'staged', receipt: { id: `rev-${asked.length}`, text: `staged ${change.kind} as rev-${asked.length}; waiting for scout` } });

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

  it("refuses to apply while the store is held by a lease it isn't running under, and applies inside one", async () => {
    decide = async () => ({ decision: 'apply' });
    const before = budget();
    let releaseLease!: () => void;
    const holding = new Promise<void>((r) => { releaseLease = r; });
    let granted!: () => void;
    const isGranted = new Promise<void>((r) => { granted = r; });
    const leased = framework.runAtSafeBoundary({ verb: 'held elsewhere' }, async () => { granted(); await holding; });
    await isGranted;
    const outside = await mover.ctx.callTool!({ id: 'own', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 150_000 }, callerAgentName: 'scout' });
    assert.match(String(outside.error), /the store is held by held elsewhere/);
    assert.equal(budget(), before, 'permission to apply is not a safe boundary');
    releaseLease();
    await leased;

    await framework.runAtSafeBoundary({ verb: 'mine' }, async () => {
      const inside = await mover.ctx.callTool!({ id: 'own2', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 150_000 }, callerAgentName: 'scout' });
      assert.equal(inside.success, true, String(inside.error));
    });
    assert.equal(budget(), 150_000, 'the lease holder can apply under its own lease');
  });

  it("refuses to apply while another call owns the agent's live turn", async () => {
    decide = async () => ({ decision: 'apply' });
    const before = budget();
    const entered = new Promise<void>((resolve) => { mover.entered = resolve; });
    const holding = framework.puppetToolCall('scout', 'mover--hold', {});
    await entered; // the puppet now owns scout's turn token
    const outside = await mover.ctx.callTool!({ id: 'own', name: 'agent_settings', input: { action: 'update', context_budget_tokens: 150_000 }, callerAgentName: 'scout' });
    assert.match(String(outside.error), /scout has a live turn that isn't this call's/);
    assert.equal(budget(), before);
    mover.release!();
    await holding;
  });

  it("applies a puppet's own delegated change during its turn, but not from a late callback in a later turn", async () => {
    decide = async () => ({ decision: 'apply' });
    const own = await framework.puppetToolCall('scout', 'mover--set_budget', {});
    assert.equal(own.result.success, true, String(own.result.error));
    assert.equal(budget(), 130_000, 'the puppet owns its turn');

    await framework.puppetToolCall('scout', 'mover--set_budget_later', {}); // returns; the change is still to come
    const tokens = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    tokens.set('scout', 987_654); // a later turn is alive when the callback fires
    try {
      (mover as unknown as { fireLater: () => void }).fireLater();
      const late = await mover.later!;
      assert.match(String(late.error), /live turn that isn't this call's/, 'provenance kept, permission not');
      assert.equal(budget(), 130_000, 'unchanged by the late callback');
    } finally {
      tokens.delete('scout');
    }
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
});

describe('operator-change gate: host/command undo by turns', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let asked: ResolvedOperatorChange[];
  let decide: (change: ResolvedOperatorChange) => Promise<OperatorChangeDecision>;
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
    decide = async (change) => ({ decision: 'staged', receipt: { id: 'rev-u', text: `staged ${change.kind}` } });
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

  it('applies an admitted multi-turn undo as one cut with one redo entry', async () => {
    decide = async () => ({ decision: 'apply' });
    await turn('one'); await turn('two'); await turn('three');
    const source = branch();
    const r = await undo(2);
    assert.equal(r.ok, true, String(r.error));
    assert.deepEqual([r.undone, r.requested], [2, 2]);
    assert.equal(branch(), `undo/scout/op-${asked[0]!.id}`, 'the destination is named for the change');
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

  it('finishes a cut an earlier attempt created but never switched to', async () => {
    await turn('one'); await turn('two');
    await undo(1);
    const change = asked[0]!;
    // As if a crash came between creating the destination and switching to it.
    const store = framework.getStore();
    const oldest = change.kind === 'undo-turns' ? change.checkpoints.at(-1)! : null;
    store.createBranchAt(`undo/scout/op-${change.id}`, change.sourceBranch, oldest!.sequenceBefore);
    const applied = await framework.runAtSafeBoundary({ verb: 'retry' }, (lease) =>
      framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
    assert.equal(applied.kind === 'undo-turns' && applied.alreadyApplied, undefined, 'applied now');
    assert.equal(branch(), `undo/scout/op-${change.id}`);
    assert.deepEqual(texts(), ['one', 'reply to one', 'two']);
  });

  it('recognizes a cut that was already applied, and refuses one whose branch moved', async () => {
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
    await assert.rejects(apply(), (e: Error & { code?: string }) => e.code === 'stale' && /already applied/.test(e.message));
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

  for (const seam of ['marker', 'checkpoints', 'log'] as const) {
    it(`finishes the cut's bookkeeping on retry after a failure at the ${seam} write, redo included`, async () => {
      await turn('one'); await turn('two'); await turn('three');
      const source = branch();
      await undo(2);
      const change = asked[0]!;
      const fw = framework as unknown as {
        saveTurnCheckpoints: (agent: string, list: unknown[]) => void;
        recordOperatorAction: (entry: { kind: string }) => void;
      };
      const store = framework.getStore() as unknown as { setStateJson: (id: string, v: unknown) => void };
      const real = { setState: store.setStateJson.bind(store), save: fw.saveTurnCheckpoints.bind(fw), record: fw.recordOperatorAction.bind(fw) };
      let armed = true;
      const fail = () => { armed = false; throw new Error(`injected ${seam} failure`); };
      if (seam === 'marker') store.setStateJson = (id, v) => (armed && (v as { operatorCut?: unknown })?.operatorCut ? fail() : real.setState(id, v));
      if (seam === 'checkpoints') fw.saveTurnCheckpoints = (agent, list) => (armed ? fail() : real.save(agent, list));
      if (seam === 'log') fw.recordOperatorAction = (entry) => (armed && entry.kind === 'undo-turns' ? fail() : real.record(entry));
      const apply = () => framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(change, { lease, admission: { id: 'rev-u' } }));
      try {
        await assert.rejects(apply(), new RegExp(`injected ${seam} failure`));
      } finally {
        store.setStateJson = real.setState;
        fw.saveTurnCheckpoints = real.save;
        fw.recordOperatorAction = real.record;
      }
      assert.equal(branch(), `undo/scout/op-${change.id}`, 'the cut landed before the failure');
      const retried = await apply();
      assert.equal(retried.kind === 'undo-turns' && retried.alreadyApplied, true, 'not cut again');
      assert.equal(host().getTurnCheckpoints('scout').length, 1);
      assert.equal(framework.getOperatorLog().filter((e) => e.kind === 'undo-turns').length, 1, 'logged once');
      assert.equal(host().redoStacks.get('scout')!.length, 1, 'one redo entry, not one per attempt');
      const redone = framework.redo('scout');
      assert.deepEqual([redone.redone, redone.toBranch], [true, source], 'the promised one-step redo exists');
      assert.equal(host().getTurnCheckpoints('scout').length, 3);
    });
  }

  it('never awaits awareness delivery, and never reports its failure as the undo\'s', async () => {
    decide = async () => ({ decision: 'apply' });
    const fw = framework as unknown as { discordAwarenessOutbox: unknown; syncDiscordAwarenessMarkers: () => Promise<void> };
    fw.discordAwarenessOutbox = {}; // so delivery is attempted
    let calls = 0;
    fw.syncDiscordAwarenessMarkers = () => { calls++; return calls === 1 ? Promise.reject(new Error('delivery down')) : new Promise<void>(() => {}); };
    try {
      await turn('one'); await turn('two'); await turn('three');
      const now = await undo(1);
      assert.equal(now.ok, true, 'a delivery failure is not the undo\'s');
      decide = async (change) => ({ decision: 'staged', receipt: { id: 'rev-d', text: `staged ${change.kind}` } });
      await undo(1);
      const staged = asked.at(-1)!;
      const applied = await framework.runAtSafeBoundary({ verb: 'apply' }, (lease) =>
        framework.applyResolvedOperatorChange(staged, { lease, admission: { id: 'rev-d' } }));
      assert.equal(applied.kind, 'undo-turns', 'returned while delivery is still pending');
      assert.equal(calls, 2, 'delivery started both times');
    } finally {
      fw.discordAwarenessOutbox = null;
    }
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
    decide = async () => ({ decision: 'apply' });
    await turn('only');
    const r = await undo(3);
    assert.deepEqual([r.ok, r.undone, r.requested], [true, 1, 3]);
    assert.equal(asked[0]!.kind === 'undo-turns' && asked[0]!.checkpoints.length, 1);
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
