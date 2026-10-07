import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';

import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework, BudgetPreflightError } from '../src/index.js';

const membrane = {} as any;

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

describe('agent runtime settings', () => {
it('agent_settings is one typed tool for the hot runtime surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    const tool = framework.getAllTools().find((candidate) => candidate.name === 'agent_settings');
    assert.ok(tool, 'general-purpose settings tool is exposed');
    assert.deepEqual(
      (tool!.inputSchema as { properties: Record<string, unknown> }).properties.same_round_think_text_policy,
      {
        type: 'string',
        enum: ['public', 'private'],
        description:
          'Routing policy for ordinary text emitted in the same native assistant round as think(). ' +
          "Omitted in the recipe preserves the compatibility carry-forward: public.",
      },
    );
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 60_000,
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        sameRoundThinkTextPolicy: 'private',
      }),
      {
        contextBudgetTokens: 60_000,
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        sameRoundThinkTextPolicy: 'private',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'converging',
      },
    );
    assert.equal(
      framework.cancelAgentRuntimeSettingsTransition('agent').transition,
      'stable',
    );
    assert.deepEqual(framework.resetAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('runtime overrides persist across framework restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-persist-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
      sameRoundThinkTextPolicy: 'public' as const,
    }],
    modules: [],
  });

  let framework = await AgentFramework.create(config());
  framework.updateAgentRuntimeSettings('agent', {
    contextBudgetTokens: 70_000,
    tailTokens: 18_000,
    transitionPaceTokens: 5_000,
    sameRoundThinkTextPolicy: 'private',
  });
  await framework.stop();

  try {
    framework = await AgentFramework.create(config());
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 70_000,
      tailTokens: 18_000,
      transitionPaceTokens: 5_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'runtime_override',
      transition: 'converging',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reset-all skips tail controls unsupported by the active strategy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-basic-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  try {
    assert.deepEqual(framework.resetAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('same_round_think_text_policy reports recipe/runtime/default sources and rejects invalid values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-think-policy-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      sameRoundThinkTextPolicy: 'private',
    }],
    modules: [],
  });
  try {
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'recipe',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'public' }),
      {
        contextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'public',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'stable',
      },
    );

    assert.deepEqual(
      framework.resetAgentRuntimeSettings('agent', ['sameRoundThinkTextPolicy']),
      {
        contextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'private',
        sameRoundThinkTextPolicySource: 'recipe',
        transition: 'stable',
      },
    );

    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'bogus' as 'public' }),
      /sameRoundThinkTextPolicy must be 'public' or 'private'/,
    );
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails closed on an invalid persisted same_round_think_text_policy override before any provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-invalid-persisted-'));
  const storePath = join(dir, 'store');
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    store.registerState({ id: 'framework/state', strategy: 'snapshot' });
  } catch {
    // Already registered.
  }
  store.setStateJson('framework/state', {
    agentRuntimeSettings: {
      agent: {
        sameRoundThinkTextPolicy: 'bogus',
      },
    },
  });
  store.close();

  let providerCalls = 0;
  const rejectingMembrane = {
    complete: async () => {
      providerCalls++;
      throw new Error('provider should not be called');
    },
    streamYielding: () => {
      providerCalls++;
      throw new Error('provider should not be called');
    },
  } as unknown as import('@animalabs/membrane').Membrane;

  try {
    await assert.rejects(
      () => AgentFramework.create({
        storePath,
        membrane: rejectingMembrane,
        agents: [{
          name: 'agent',
          model: 'test-model',
          systemPrompt: 'test',
        }],
        modules: [],
      }),
      /Invalid persisted sameRoundThinkTextPolicy/,
    );
    assert.equal(providerCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
});

it('immediate: a budget decrease with immediate=true applies now — no descent, no persisted flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-immediate-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    // Baseline: a plain decrease starts a paced descent.
    const gradual = framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
    assert.equal(gradual.transition, 'converging');
    assert.equal(gradual.contextBudgetTokens, 60_000, 'snapshot reports the TARGET while converging');

    // Immediate: applies now AND cancels the in-flight descent.
    const now = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 50_000,
      immediate: true,
    });
    assert.equal(now.transition, 'stable', 'no descent — the drop is live');
    assert.equal(now.contextBudgetTokens, 50_000);

    // The mode flag is never persisted as an override.
    const overrides = framework.getAgent('agent')!.getRuntimeSettingsOverrides() as Record<string, unknown>;
    assert.equal(overrides.immediate, undefined, 'immediate is a mode, not a setting');
    assert.equal(overrides.contextBudgetTokens, 50_000);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Budget preflight (issue #122; supersedes feat/budget-preflight-guard).
// The preview stub stands in for the strategy's previewContext so verdicts are
// deterministic; the mapping under test is the framework's, not the picker's.
// ---------------------------------------------------------------------------

function stubPreview(
  framework: AgentFramework,
  agentName: string,
  impl: ((budget: { maxTokens: number }) => Record<string, unknown>) | undefined,
): void {
  const cm = framework.getAgent(agentName)!.getContextManager() as unknown as {
    previewContext?: (budget: { maxTokens: number }) => unknown;
  };
  if (impl === undefined) {
    cm.previewContext = undefined;
  } else {
    cm.previewContext = (budget) => impl(budget);
  }
}

const infeasibleAt = (floor: number) => (budget: { maxTokens: number }) => ({
  finalTokens: floor,
  budgetTokens: budget.maxTokens,
  fits: floor <= budget.maxTokens,
  exhausted: floor > budget.maxTokens,
  headTokens: 10_000,
  tailTokens: 30_000,
  middleTokens: floor - 40_000,
  middleChunkCount: 7,
  deepestLevel: 3,
  resolutions: {},
  moves: 0,
  producedCount: 0,
});

async function withPreflightFramework(
  fn: (framework: AgentFramework) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-preflight-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 550_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    await fn(framework);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('preflight: an immediate infeasible budget throws typed, allowInfeasible overrides', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 260_000,
        immediate: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof BudgetPreflightError);
        assert.equal(error.preview.path, 'immediate');
        assert.equal(error.preview.effective?.fits, false);
        assert.equal(error.preview.effective?.finalTokens, 450_000);
        assert.match(error.message, /450000 tokens against hard budget 260000/);
        return true;
      },
    );
    // The refused patch must not have been applied.
    assert.equal(framework.getAgentRuntimeSettings('agent').contextBudgetTokens, 550_000);

    const applied = framework.updateAgentRuntimeSettings(
      'agent',
      { contextBudgetTokens: 260_000, immediate: true },
      { allowInfeasible: true },
    );
    assert.equal(applied.contextBudgetTokens, 260_000);
  });
});

it('preflight: a paced descent below the floor NEVER blocks — the compile budget is unchanged', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    // 260k < 550k live, no `immediate` → paced. The superseded branch guard
    // previewed 260k as the compile budget and refused this exact patch; the
    // real compile stays at 550k (feasible), so it must apply.
    const applied = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
    });
    assert.equal(applied.transition, 'converging');
    assert.equal(applied.contextBudgetTokens, 260_000, 'snapshot reports the target');
  });
});

it('preflight: a feasible immediate change applies without ceremony', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(200_000));
    const applied = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
      immediate: true,
    });
    assert.equal(applied.contextBudgetTokens, 260_000);
  });
});

it('preflight: preview-unavailable applies with a warn, never blocks', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', undefined);
    const applied = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
      immediate: true,
    });
    assert.equal(applied.contextBudgetTokens, 260_000);
  });
});

it('previewAgentRuntimeSettings: structured reasons for the strategy throw paths', async () => {
  await withPreflightFramework(async (framework) => {
    const cases: Array<[string, string]> = [
      [
        'AutobiographicalStrategy.previewContext requires reinitialization for the current branch generation',
        'branch_generation_changed',
      ],
      ['previewContext is already running; previews must not overlap', 'preview_in_flight'],
      [
        'previewContext requires adaptiveResolution; the hierarchical path has no fold plan to preview',
        'no_adaptive_resolution',
      ],
      ['some novel failure', 'some novel failure'],
    ];
    for (const [message, reason] of cases) {
      stubPreview(framework, 'agent', () => { throw new Error(message); });
      const preview = framework.previewAgentRuntimeSettings('agent', {
        contextBudgetTokens: 600_000,
      });
      assert.equal(preview.available, false, message);
      assert.equal(preview.reason, reason);
    }
  });
});

it('previewAgentRuntimeSettings: paced patches report effective=live plus an advisory target', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    const preview = framework.previewAgentRuntimeSettings('agent', {
      contextBudgetTokens: 260_000,
    });
    assert.equal(preview.path, 'paced');
    assert.equal(preview.available, true);
    assert.equal(preview.effective?.budgetTokens, 550_000, 'effective = UNCHANGED live budget');
    assert.equal(preview.effective?.fits, true);
    assert.equal(preview.advisory?.targetTokens, 260_000);
    assert.equal(preview.advisory?.fits, false);

    // No patch = the resume-gate case: verdict for current settings.
    const current = framework.previewAgentRuntimeSettings('agent');
    assert.equal(current.path, 'none');
    assert.equal(current.effective?.budgetTokens, 550_000);
  });
});

it('preflight: boot restore is never preflighted — an infeasible persisted budget cannot brick startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-preflight-boot-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 550_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  let framework = await AgentFramework.create(config());
  try {
    stubPreview(framework, 'agent', infeasibleAt(450_000));
    framework.updateAgentRuntimeSettings(
      'agent',
      { contextBudgetTokens: 260_000, immediate: true },
      { allowInfeasible: true },
    );
    await framework.stop();
    // Recreate WITHOUT a stub: restore goes through Agent.restoreRuntimeSettings,
    // bypassing the framework wrapper — must not throw regardless of feasibility.
    framework = await AgentFramework.create(config());
    assert.equal(framework.getAgentRuntimeSettings('agent').contextBudgetTokens, 260_000);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preflight: no-op and increasing patches never throw on an already-over-floor agent', async () => {
  await withPreflightFramework(async (framework) => {
    stubPreview(framework, 'agent', infeasibleAt(600_000)); // floor above even 550k live
    // No-op rewrite of the current budget: settings-plane writeback shape.
    const rewrite = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 550_000,
      immediate: true,
    });
    assert.equal(rewrite.contextBudgetTokens, 550_000);
    // Strict improvement (increase) on a wedged agent must apply, not throw.
    const raise = framework.updateAgentRuntimeSettings('agent', {
      contextBudgetTokens: 700_000,
    });
    assert.equal(raise.contextBudgetTokens, 700_000);
    // A LOWERING that does not fit still throws.
    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 500_000,
        immediate: true,
      }),
      BudgetPreflightError,
    );
  });
});

it('previewRuntimeSettingsTarget names every setting an action changes, at the value it is reported at after, the default pace of a paced descent included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-preview-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      // No kvStableReachTokens: no transition pace is set, so a paced
      // descent installs the default one.
      strategy: new AutobiographicalStrategy({ adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000 }),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    const agent = framework.getAgent('agent')!;
    const keys = ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens', 'sameRoundThinkTextPolicy'] as const;
    const reported = () => {
      const snapshot = framework.getAgentRuntimeSettings('agent') as unknown as Record<string, unknown>;
      return Object.fromEntries(keys.map((key) => [key, snapshot[key] ?? null])) as Record<string, unknown>;
    };
    type Action = Parameters<typeof agent.previewRuntimeSettingsTarget>[0];
    // The preview must name exactly what the action changes, at the values
    // getRuntimeSettings reports once it applied.
    const check = (label: string, action: Action, apply: () => void) => {
      const before = reported();
      const target = agent.previewRuntimeSettingsTarget(action) as Record<string, unknown>;
      apply();
      const after = reported();
      for (const key of keys) {
        if (after[key] !== before[key]) {
          assert.ok(key in target, `${label}: ${key} changes from ${String(before[key])} to ${String(after[key])}, but the preview omits it`);
        }
      }
      for (const [key, value] of Object.entries(target)) {
        assert.equal(value, after[key], `${label}: previewed ${key}=${String(value)}, reported ${String(after[key])}`);
      }
    };

    assert.equal(reported().transitionPaceTokens, null, 'no pace is set to begin with');
    check('a paced decrease with no pace set',
      { action: 'update', patch: { contextBudgetTokens: 60_000 } },
      () => framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }));
    assert.equal(reported().transitionPaceTokens, 16_000, 'the default pace was installed');
    check('reset-all', { action: 'reset' }, () => framework.resetAgentRuntimeSettings('agent'));
    check('an immediate decrease installs no pace',
      { action: 'update', patch: { contextBudgetTokens: 80_000, immediate: true } },
      () => framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000, immediate: true }));
    check('an increase', { action: 'update', patch: { contextBudgetTokens: 150_000 } },
      () => framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 150_000 }));
    assert.equal(reported().transitionPaceTokens, null);
    check('a budget-only reset that starts a descent with no pace set',
      { action: 'reset', keys: ['contextBudgetTokens'] },
      () => framework.resetAgentRuntimeSettings('agent', ['contextBudgetTokens']));
    assert.equal(reported().transitionPaceTokens, 16_000, 'the reset installed the default pace');
    check('a decrease with an explicit pace',
      { action: 'update', patch: { contextBudgetTokens: 50_000, transitionPaceTokens: 2_000 } },
      () => framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000, transitionPaceTokens: 2_000 }));
    check('a paced decrease with a pace already set leaves it alone',
      { action: 'update', patch: { contextBudgetTokens: 40_000 } },
      () => framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 40_000 }));
    check('cancel', { action: 'cancel' }, () => framework.cancelAgentRuntimeSettingsTransition('agent'));
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
