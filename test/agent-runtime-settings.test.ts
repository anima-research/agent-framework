import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';

import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager';
import { Agent, AgentFramework, BudgetPreflightError, type AgentRuntimeSettingsPatch } from '../src/index.js';

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
      effectiveContextBudgetTokens: 100_000,
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
        effectiveContextBudgetTokens: 100_000,
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
      effectiveContextBudgetTokens: 100_000,
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
    // The descent was still running at the stop, so it resumes paced from the
    // recipe's budget.
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 70_000,
      effectiveContextBudgetTokens: 100_000,
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

// context-manager #162: a lower budget the agent had reached comes back reached.
describe('a reached budget across a restart', () => {
  type Record = { [key: string]: unknown };
  const persisted = (framework: AgentFramework) =>
    (framework.getStore().getStateJson('framework/state') as { agentRuntimeSettings?: { [name: string]: Record } } | null)
      ?.agentRuntimeSettings?.agent;
  const writeRecord = (framework: AgentFramework, record: Record) => {
    const store = framework.getStore();
    const state = (store.getStateJson('framework/state') ?? {}) as { agentRuntimeSettings?: { [name: string]: Record } };
    store.setStateJson('framework/state', { ...state, agentRuntimeSettings: { ...state.agentRuntimeSettings, agent: record } });
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-settings-reached-'));
    const config = () => ({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{
        name: 'agent', model: 'test-model', systemPrompt: 'test',
        strategy: strategy(), contextBudgetTokens: 100_000, maxTokens: 10_000,
      }],
      modules: [],
    });
    return { dir, config };
  };
  const budgets = (framework: AgentFramework) => {
    const s = framework.getAgentRuntimeSettings('agent');
    return { target: s.contextBudgetTokens, effective: s.effectiveContextBudgetTokens, transition: s.transition };
  };
  const compile = (framework: AgentFramework) => framework.getAgent('agent')!.compileContext();
  /** Run `fn` with ContextManager.prototype[method] replaced. */
  async function withPatched<T>(method: string, impl: unknown, fn: () => Promise<T>): Promise<T> {
    const proto = ContextManager.prototype as unknown as { [key: string]: unknown };
    const original = proto[method];
    proto[method] = impl;
    try { return await fn(); } finally { proto[method] = original; }
  }
  const quietErrors = () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.error = original; } };
  };
  /** Each test's framework, stopped and removed afterwards. */
  async function run(fn: (h: { config: ReturnType<typeof setup>['config']; framework: () => AgentFramework; restart: () => Promise<AgentFramework> }) => Promise<void>) {
    const { dir, config } = setup();
    let framework = await AgentFramework.create(config());
    try {
      await fn({
        config,
        framework: () => framework,
        restart: async () => { await framework.stop(); framework = await AgentFramework.create(config()); return framework; },
      });
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a descent that settled comes back settled, and the first compile plans at it', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 100_000, transition: 'converging' });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 }, 'not reached yet');
      // The store is empty, so the first compile's frontier fits and the descent settles.
      await compile(framework());
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the settle is recorded');
      const restarted = await restart();
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 60_000, transition: 'stable' });
      // The record's proof stands until a compile here says otherwise, so a
      // persisting call before any compile keeps it.
      restarted.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.equal(persisted(restarted)?.contextBudgetReachedTokens, 60_000);
      const planned: number[] = [];
      const cm = restarted.getAgent('agent')!.getContextManager() as unknown as { compile: (budget?: { maxTokens: number }) => Promise<unknown> };
      const original = cm.compile.bind(cm);
      cm.compile = (budget, ...rest) => { planned.push(budget?.maxTokens ?? -1); return (original as (...a: unknown[]) => Promise<unknown>)(budget, ...rest); };
      await compile(restarted);
      assert.deepEqual(planned, [60_000], 'the first compile after the restart plans at the reached budget');
    });
  });

  it('a restored descent that settles after the restart is recorded then', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      const restarted = await restart();
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 100_000, transition: 'converging' });
      await compile(restarted);
      assert.deepEqual(persisted(restarted), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('an immediate decrease is recorded once a compile fits at it, not before', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 }, 'nothing has compiled at it yet');
      await compile(framework());
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
      assert.deepEqual(budgets(await restart()), { target: 60_000, effective: 60_000, transition: 'stable' });
    });
  });

  it('an immediate decrease that never compiled comes back paced', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      assert.deepEqual(budgets(await restart()), { target: 60_000, effective: 100_000, transition: 'converging' });
    });
  });

  it('a compile refused at the reached budget withdraws the record, and the restart paces', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(framework());
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      await withPatched('compile', async () => { throw refusal; }, async () => {
        await assert.rejects(() => compile(framework()), /over budget/);
      });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 });
      assert.deepEqual(budgets(await restart()), { target: 60_000, effective: 100_000, transition: 'converging' });
    });
  });

  it('a reached budget the preflight says no longer fits restores paced, with a line saying why', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(framework());
      const log = quietErrors();
      try {
        // A restart with a new maxTokens or strategy configuration raised the folded floor.
        const restarted = await withPatched('previewContext', (budget: { maxTokens: number }) => ({
          finalTokens: 70_000, budgetTokens: budget.maxTokens, fits: 70_000 <= budget.maxTokens,
        }), restart);
        assert.deepEqual(budgets(restarted), { target: 60_000, effective: 100_000, transition: 'converging' });
      } finally {
        log.restore();
      }
      // One line, written once the restore is made, saying why and what it made.
      assert.deepEqual(log.lines.filter((line) => line.includes('[agent-settings]')), [
        '[agent-settings] agent: its record says a compile fit at contextBudgetTokens=60000, but the folded floor renders ' +
          '70000 tokens against it now; restored it paced instead: contextBudgetTokens is 60000, and compiles plan at 100000 (converging)',
      ]);
    });
  });

  it('a reached budget the preflight says fits but that fails to apply at once restores paced, with a line naming that step', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(framework());
      const proto = Agent.prototype as unknown as {
        restoreRuntimeSettings: (settings: unknown, opts?: { provenBudget?: number }) => unknown;
      };
      const original = proto.restoreRuntimeSettings;
      proto.restoreRuntimeSettings = function (this: unknown, settings: unknown, opts?: { provenBudget?: number }) {
        if (opts?.provenBudget !== undefined) throw new Error('hot settings refused');
        return original.call(this, settings, opts);
      };
      const log = quietErrors();
      let restarted: AgentFramework;
      try {
        restarted = await restart();
      } finally {
        proto.restoreRuntimeSettings = original;
        log.restore();
      }
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 100_000, transition: 'converging' });
      assert.ok(
        log.lines.some((line) => line.includes('applying it at once failed (hot settings refused), though the preflight says it fits now')),
        log.lines.join('\n'),
      );
      assert.ok(!log.lines.some((line) => line.includes("can't be checked")), log.lines.join('\n'));
    });
  });

  it('a record without the field, or with one for another budget, restores paced', async () => {
    await run(async ({ framework, restart }) => {
      // An earlier release's record; then one an older release carried
      // forward beside a budget it changed.
      writeRecord(framework(), { contextBudgetTokens: 60_000 });
      assert.equal(budgets(await restart()).transition, 'converging');
      writeRecord(framework(), { contextBudgetTokens: 70_000, contextBudgetReachedTokens: 60_000 });
      assert.deepEqual(budgets(await restart()), { target: 70_000, effective: 100_000, transition: 'converging' });
    });
  });

  it('an invalid field is ignored with a bounded line, and a record holding only it still boots', async () => {
    await run(async ({ framework, restart }) => {
      const log = quietErrors();
      try {
        for (const invalid of ['yes'.repeat(100), [60_000], { budget: 60_000 }, null]) {
          writeRecord(framework(), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: invalid });
          assert.equal(budgets(await restart()).transition, 'converging', JSON.stringify(invalid));
        }
        writeRecord(framework(), { contextBudgetReachedTokens: -5 });
        assert.deepEqual(budgets(await restart()), { target: 100_000, effective: 100_000, transition: 'stable' }, 'the recipe budget');
      } finally {
        log.restore();
      }
      // The line names the kind of value, never its content.
      const lines = log.lines.filter((l) => l.includes('ignoring an invalid persisted contextBudgetReachedTokens'));
      const line = (kind: string) => `[agent-settings] ignoring an invalid persisted contextBudgetReachedTokens for agent "agent": ${kind}`;
      assert.deepEqual(lines, [
        line('a string'),
        line('an array'),
        line('an object'),
        line('null'),
        line('a number that isn\'t a positive safe integer'),
      ], log.lines.join('\n'));
    });
  });

  it('a malformed persisted budget, tail or pace is ignored with a line naming its kind, and the rest restores', async () => {
    await run(async ({ framework, restart }) => {
      writeRecord(framework(), { contextBudgetTokens: 'x'.repeat(100), tailTokens: -1, transitionPaceTokens: 4_000 });
      const log = quietErrors();
      let restarted: AgentFramework;
      try {
        restarted = await restart();
      } finally {
        log.restore();
      }
      const { contextBudgetTokens, effectiveContextBudgetTokens, tailTokens, transitionPaceTokens } = restarted.getAgentRuntimeSettings('agent');
      assert.deepEqual(
        { contextBudgetTokens, effectiveContextBudgetTokens, tailTokens, transitionPaceTokens },
        { contextBudgetTokens: 100_000, effectiveContextBudgetTokens: 100_000, tailTokens: 30_000, transitionPaceTokens: 4_000 },
      );
      assert.deepEqual(log.lines.filter((l) => l.includes('[agent-settings]')), [
        '[agent-settings] ignoring an invalid persisted contextBudgetTokens for agent "agent": a string',
        '[agent-settings] ignoring an invalid persisted tailTokens for agent "agent": a number that isn\'t a non-negative safe integer',
      ]);
      restarted.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.deepEqual(persisted(restarted), { transitionPaceTokens: 4_000, tailTokens: 20_000 }, 'a later write leaves them out');
    });
    await run(async ({ framework, restart }) => {
      writeRecord(framework(), { transitionPaceTokens: 0, tailTokens: 20_000 });
      const log = quietErrors();
      let restarted: AgentFramework;
      try {
        restarted = await restart();
      } finally {
        log.restore();
      }
      assert.equal(restarted.getAgentRuntimeSettings('agent').tailTokens, 20_000);
      assert.deepEqual(log.lines.filter((l) => l.includes('[agent-settings]')), [
        '[agent-settings] ignoring an invalid persisted transitionPaceTokens for agent "agent": a number that isn\'t a positive safe integer',
      ]);
      restarted.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'private' });
      assert.deepEqual(persisted(restarted), { tailTokens: 20_000, sameRoundThinkTextPolicy: 'private' }, 'a later write leaves the pace out');
    });
  });

  it('a patch cannot set the field', async () => {
    await run(async ({ framework }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 } as never);
      assert.deepEqual(framework().getAgent('agent')!.getRuntimeSettingsOverrides(), { contextBudgetTokens: 60_000 });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 });
    });
  });

  it('every persisting call keeps the field true to the live state', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      f.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, tailTokens: 20_000, contextBudgetReachedTokens: 60_000 }, 'another setting keeps it');
      f.cancelAgentRuntimeSettingsTransition('agent');
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000, 'a cancel with no descent keeps it');
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000 });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 50_000, tailTokens: 20_000 }, 'a new descent has reached nothing');
      f.cancelAgentRuntimeSettingsTransition('agent');
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, tailTokens: 20_000, contextBudgetReachedTokens: 60_000 }, 'cancelled back to the reached budget');
      f.resetAgentRuntimeSettings('agent', ['contextBudgetTokens']);
      assert.deepEqual(persisted(f), { tailTokens: 20_000 }, 'reset to the recipe');
    });
  });

  it('a settle marks only the persisted budget it reached', async () => {
    await run(async ({ framework }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 });
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }, { persist: false });
      await compile(framework());
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 80_000 }, "the record's 80k was never compiled at");
    });
  });

  it('a descent applied without persisting settles without writing anything', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }, { persist: false });
      const log = quietErrors();
      try {
        await compile(framework());
      } finally {
        log.restore();
      }
      assert.deepEqual(log.lines.filter((l) => l.includes('[agent-settings]')), [], 'no record is no error');
      assert.deepEqual(budgets(framework()), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.equal(persisted(framework()), undefined, 'nothing written for an ephemeral descent');
      assert.deepEqual(budgets(await restart()), { target: 100_000, effective: 100_000, transition: 'stable' }, 'the recipe budget');
    });
  });

  it('a failed write of the field is logged, and the compile stands', async () => {
    await run(async ({ framework }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      const store = framework().getStore() as unknown as { setStateJson: (...args: unknown[]) => void };
      const original = store.setStateJson.bind(store);
      store.setStateJson = () => { throw new Error('disk full'); };
      const log = quietErrors();
      try {
        await compile(framework());
      } finally {
        store.setStateJson = original;
        log.restore();
      }
      assert.ok(log.lines.some((l) => l.includes("couldn't record agent's compile at budget 60000")), log.lines.join('\n'));
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000 });
      // The next compile at that budget records it, once writes work again.
      await compile(framework());
      assert.deepEqual(persisted(framework()), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('a budget changed while a compile runs is not proven by that compile', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      // The compile was asked for at the recipe's 100k; the budget drops to
      // 60k at once while it runs.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'the 100k compile proves nothing about 60k');
      assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), undefined, 'and no proof stands for the live budget: that compile planned at 100k');
      await compile(f);
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('a compile refused after the budget changed under it withdraws its own budget\'s marker, and leaves the new budget\'s proof', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000);
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      // The first compile plans at 60k and is refused only after the budget
      // went to 80k, unpersisted, and a second compile fit there.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        if (++calls === 1) {
          await held;
          throw refusal;
        }
        return original.apply(this, args);
      }, async () => {
        const first = compile(f);
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 }, { persist: false });
        await compile(f);
        release();
        await assert.rejects(first, /over budget/);
      });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'the record still holds 60k, now without its marker');
      assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), 80_000, 'the refusal at 60k says nothing about 80k');
    });
  });

  /**
   * Two compiles at 60k, the first held until `between` has run: `firstFits`
   * says how the first ends, and the second, started after it, ends the
   * other way. Each selects at its start, as the context manager does (a fit
   * calls the real compile then, a refusal is decided then); only the
   * first's outcome is held.
   */
  async function twoCompilesAt60k(f: AgentFramework, firstFits: boolean, between: () => Promise<void>) {
    const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
    const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
      const isFirst = ++calls === 1;
      const outcome = isFirst !== firstFits ? Promise.reject(refusal) : original.apply(this, args);
      outcome.catch(() => {}); // returned below
      if (isFirst) await held;
      return outcome;
    }, async () => {
      const first = compile(f);
      first.catch(() => {}); // asserted below; if between() fails, its refusal is not left unhandled
      try {
        await between();
      } finally {
        release();
      }
      if (firstFits) await first;
      else await assert.rejects(first, /over budget/);
    });
  }

  it('of two compiles at one budget, the one that started later decides, whichever finishes last', async () => {
    // A refusal planned before a fit at the same budget, with nothing changed between them.
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await twoCompilesAt60k(f, false, async () => {
        await compile(f);
        assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the second compile fit at 60k');
      });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the later-started fit stands');
      assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), 60_000);
    });
    // A refusal planned before the budget went to 80k and came back to 60k,
    // where a second compile fit; then, in a second run, the budget moves to
    // 70k unpersisted before the refusal arrives.
    for (const moveAway of [false, true]) {
      await run(async ({ framework }) => {
        const f = framework();
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
        await twoCompilesAt60k(f, false, async () => {
          f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 });
          f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
          await compile(f);
          assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the second compile fit at 60k');
          if (moveAway) f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 70_000 }, { persist: false });
        });
        assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the later-started fit stands');
        assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), moveAway ? undefined : 60_000);
      });
    }
    // A fit planned before a refusal at the same budget.
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      await twoCompilesAt60k(f, true, async () => {
        await assert.rejects(compile(f), /over budget/);
        assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'the second compile\'s refusal withdrew the marker');
      });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'the later-started refusal stands');
      assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), undefined);
    });
  });

  it("a later-started compile whose fit isn't credited still outranks an earlier-started refusal at its budget", async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const held = [
        new Promise<void>((resolve) => { releaseFirst = resolve; }),
        new Promise<void>((resolve) => { releaseSecond = resolve; }),
      ];
      let calls = 0;
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        const n = calls++;
        // Each selects at its start; only its outcome is held.
        const outcome = n === 0 ? Promise.reject(refusal) : original.apply(this, args);
        outcome.catch(() => {}); // returned below
        await held[n];
        return outcome;
      }, async () => {
        // Both plan at 60k. The second fits while the budget moves to 70k
        // unpersisted, so nothing credits it; the first is refused after it.
        const first = compile(f);
        first.catch(() => {}); // asserted below
        try {
          const second = compile(f);
          f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 70_000 }, { persist: false });
          releaseSecond();
          await second;
        } finally {
          releaseFirst();
          releaseSecond();
        }
        await assert.rejects(first, /over budget/);
      });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the earlier-started refusal is ignored');
    });
  });

  it("a settle's credit outranks an earlier-started refusal at its target", async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        if (++calls === 1) {
          await held;
          throw refusal;
        }
        return original.apply(this, args);
      }, async () => {
        // The first plans at 60k and is refused only after the budget went to
        // 80k and paced back down, and a compile at 80k settled that descent.
        const first = compile(f);
        first.catch(() => {}); // asserted below
        try {
          f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 });
          f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
          assert.equal(budgets(f).transition, 'converging');
          await compile(f);
          assert.deepEqual(budgets(f), { target: 60_000, effective: 60_000, transition: 'stable' });
          assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the settle credited 60k');
        } finally {
          release();
        }
        await assert.rejects(first, /over budget/);
      });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the settle outranks the earlier-started refusal');
    });
  });

  it('a settle credits its target only from the latest compile to end at the budget it planned at', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      assert.equal(budgets(f).transition, 'converging');
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        if (++calls > 1) throw refusal;
        // The first selects at its start; only its outcome is held.
        const outcome = original.apply(this, args);
        await held;
        return outcome;
      }, async () => {
        // Both plan at 100k. The second is refused there first; the first
        // then fits and settles the descent to 60k.
        const first = compile(f);
        try {
          await assert.rejects(compile(f), /over budget/);
        } finally {
          release();
        }
        await first;
      });
      assert.deepEqual(budgets(f), { target: 60_000, effective: 60_000, transition: 'stable' }, 'the first compile settled the descent');
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'and credits nothing: a later-started compile was refused at 100k');
      assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), undefined);
    });
  });

  it('the start order keeps nothing once no compile runs, through descents and compiles at once', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      // What it keeps is visible only inside the agent.
      const kept = () => [...(f.getAgent('agent') as unknown as { latestEndedStart: Map<number, number> }).latestEndedStart.keys()];
      // Descents to three budgets, each settled by a compile.
      for (const budget of [90_000, 75_000, 60_000]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: budget });
        await compile(f);
        assert.deepEqual(budgets(f), { target: budget, effective: budget, transition: 'stable' });
        assert.deepEqual(kept(), [], `after the descent to ${budget}`);
      }
      // Two at once: the later-started one's place at 60k is kept while the earlier one runs.
      await twoCompilesAt60k(f, false, async () => {
        await compile(f);
        assert.deepEqual(kept(), [60_000], 'kept while an earlier-started compile runs');
      });
      assert.deepEqual(kept(), [], 'and dropped once it ends');
    });
  });

  it('of two compiles in flight across a settle, the one that finishes later proves nothing it planned before it', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      // Both plan at the live 100k; the first is held until the second has
      // finished and settled the descent.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        const n = ++calls;
        const result = await original.apply(this, args);
        if (n === 1) await held;
        return result;
      }, async () => {
        const first = compile(f);
        await compile(f);
        assert.deepEqual(budgets(f), { target: 60_000, effective: 60_000, transition: 'stable' });
        assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'the second settled it');
        release();
        await first;
      });
      assert.equal(f.getAgent('agent')!.getProvenContextBudgetTokens(), 60_000, "the first's 100k plan doesn't replace the proof");
      f.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000, 'so a persisting call keeps the marker');
    });
  });

  it('a proof stands only until the live budget changes: back at a proven budget, nothing is marked before a compile fits', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000);
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 });
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'back at once: no compile has fit at it since');
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 });
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      assert.equal(budgets(f).transition, 'converging');
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'back paced: the descent has reached nothing');
      await compile(f);
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 }, 'its settle marks it');
    });
  });

  it('a descent re-armed to the same target while a compile runs is not credited to that compile', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      // The compile plans at the live 100k; meanwhile the budget is raised
      // at once and lowered back, paced, to the same 60k.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 120_000 });
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'the compile planned at 100k under another descent');
    });
    // The same with the live budget left alone: the descent is cancelled and
    // armed again, to the same 60k, while the compile runs.
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.cancelAgentRuntimeSettingsTransition('agent');
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
        return original.apply(this, args);
      }, () => compile(f));
      assert.equal(persisted(f)?.contextBudgetReachedTokens, undefined, 'a descent armed again is another descent');
    });
    // And armed again directly, to the same 60k, with nothing in between.
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(budgets(f), { target: 60_000, effective: 60_000, transition: 'stable' }, 'the re-armed descent settled');
      assert.equal(persisted(f)?.contextBudgetReachedTokens, undefined, 'a descent armed again to the same target is another descent');
    });
    // And armed again by a reset to the recipe's budget, below the live one.
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 120_000 });
      f.resetAgentRuntimeSettings('agent', ['contextBudgetTokens']);
      assert.deepEqual(budgets(f), { target: 100_000, effective: 120_000, transition: 'converging' });
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.resetAgentRuntimeSettings('agent', ['contextBudgetTokens']);
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(budgets(f), { target: 100_000, effective: 100_000, transition: 'stable' }, 'the re-armed descent settled');
      // Setting the budget it now runs at keeps any proof the settle gave it.
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 100_000, immediate: true });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 100_000 }, 'a descent armed again by a reset is another descent');
    });
  });

  it('a compile without a budget through compileWithInjections proves and records it too', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await f.getAgent('agent')!.compileWithInjections();
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it('a record that cannot be read is logged, and told again at the next compile', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      const store = f.getStore() as unknown as { getStateJson: (...args: unknown[]) => unknown };
      const original = store.getStateJson.bind(store);
      store.getStateJson = () => { throw new Error('store unreadable'); };
      const log = quietErrors();
      try {
        await compile(f);
      } finally {
        store.getStateJson = original;
        log.restore();
      }
      assert.ok(log.lines.some((l) => l.includes("couldn't record agent's compile at budget 60000")), log.lines.join('\n'));
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 });
      await compile(f);
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
    });
  });

  it("a record the boot can't read is logged, and the agent boots at the recipe's", async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      // Only the boot's read of the record fails.
      const proto = JsStore.prototype as unknown as { getStateJson: (...args: unknown[]) => unknown };
      const original = proto.getStateJson;
      proto.getStateJson = function (this: unknown, ...args: unknown[]) {
        if (new Error().stack?.includes('readAgentRuntimeSettings')) throw new Error('store unreadable');
        return original.apply(this, args);
      };
      const log = quietErrors();
      let restarted: AgentFramework;
      try {
        restarted = await restart();
      } finally {
        proto.getStateJson = original;
        log.restore();
      }
      assert.deepEqual(budgets(restarted), { target: 100_000, effective: 100_000, transition: 'stable' });
      assert.ok(
        log.lines.some((l) => l.includes("agent: its persisted settings can't be read (store unreadable); it boots at the recipe's")),
        log.lines.join('\n'),
      );
    });
  });

  it('after a withdrawal that failed and a persisting write without the marker, the next fit writes it again', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(f);
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000);
      const store = f.getStore() as unknown as { setStateJson: (...args: unknown[]) => void };
      const write = store.setStateJson.bind(store);
      store.setStateJson = () => { throw new Error('disk full'); };
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      const log = quietErrors();
      try {
        await withPatched('compile', async () => { throw refusal; }, async () => {
          await assert.rejects(() => compile(f), /over budget/);
        });
      } finally {
        store.setStateJson = write;
        log.restore();
      }
      f.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000, tailTokens: 20_000 }, 'the refusal stands in the record now');
      await compile(f);
      assert.equal(persisted(f)?.contextBudgetReachedTokens, 60_000, 'the next fit is told, and written');
    });
  });

  /** Apply `budget` at once and compile, so it's proven, then restart: the boot applies it at once. */
  async function provenAtBoot(h: { framework: () => AgentFramework; restart: () => Promise<AgentFramework> }, budget: number) {
    h.framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: budget, immediate: true });
    await compile(h.framework());
    const restarted = await h.restart();
    assert.deepEqual(budgets(restarted), { target: budget, effective: budget, transition: 'stable' }, 'applied at once at boot');
    return restarted;
  }
  /**
   * A compile whose first plan the context manager refuses, after `meanwhile`
   * ran while that plan was under way: the budget each plan was asked for,
   * the record as the second began, the log, and what it threw.
   */
  async function refusedFirst(f: AgentFramework, meanwhile?: () => void) {
    const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
    const planned: number[] = [];
    let recordAtRetry: Record | undefined;
    const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
    const log = quietErrors();
    let thrown: unknown;
    try {
      await withPatched('compile', async function (this: unknown, budget?: { maxTokens: number }, ...rest: unknown[]) {
        planned.push(budget?.maxTokens ?? -1);
        if (planned.length === 1) {
          meanwhile?.();
          throw refusal;
        }
        recordAtRetry = { ...persisted(f) };
        return original.apply(this, [budget, ...rest]);
      }, () => compile(f));
    } catch (error) {
      thrown = error;
    } finally {
      log.restore();
    }
    return { planned, recordAtRetry, lines: log.lines, thrown };
  }

  it('a budget applied at once at boot whose first compile is refused is restored paced, and the compile goes on', async () => {
    await run(async (h) => {
      const restarted = await provenAtBoot(h, 60_000);
      const { planned, recordAtRetry, lines, thrown } = await refusedFirst(restarted);
      assert.equal(thrown, undefined);
      assert.deepEqual(planned, [60_000, 100_000], 'refused at the boot budget, then compiled from the recipe\'s');
      assert.deepEqual(recordAtRetry, { contextBudgetTokens: 60_000 }, 'the refusal withdrew the marker before the compile went on');
      assert.ok(lines.some((l) => l.includes('restored it as a paced descent from the recipe\'s budget')), lines.join('\n'));
      assert.equal(budgets(restarted).target, 60_000, 'the descent to it is armed (or settled)');
      assert.equal(persisted(restarted)?.contextBudgetTokens, 60_000);
    });
  });

  it('a dry run under a budget the boot applied at once proves nothing: the fallback stays armed, whether the preview fits or is refused', async () => {
    await run(async (h) => {
      const restarted = await provenAtBoot(h, 60_000);
      const recorded = persisted(restarted);
      // A preview that fits notes nothing and keeps the fallback.
      await restarted.previewActivation('agent');
      // A preview refused at the boot budget restores nothing from a preview.
      const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      const log = quietErrors();
      try {
        await withPatched('compile', async () => { throw refusal; }, async () => {
          await assert.rejects(restarted.previewActivation('agent'), /over budget/);
        });
      } finally {
        log.restore();
      }
      assert.ok(!log.lines.some((l) => l.includes('the context manager refused')), log.lines.join('\n'));
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 60_000, transition: 'stable' }, 'still the boot budget, applied at once');
      assert.deepEqual(persisted(restarted), recorded, 'neither preview wrote the record');
      // The fallback is still armed: the first sent compile refused at the
      // boot budget restores it paced, and goes on.
      const { planned, lines, thrown } = await refusedFirst(restarted);
      assert.equal(thrown, undefined);
      assert.deepEqual(planned, [60_000, 100_000]);
      assert.ok(lines.some((l) => l.includes('restored it as a paced descent from the recipe\'s budget')), lines.join('\n'));
    });
  });

  it("the fallback runs once: if the recipe's budget is refused too, its compile reports that refusal", { timeout: 20_000 }, async () => {
    // Restored paced, and kept set where the strategy can't prepare a smaller window.
    for (const canPace of [true, false]) {
      await run(async (h) => {
        const restarted = await provenAtBoot(h, 60_000);
        if (!canPace) {
          const cm = restarted.getAgent('agent')!.getContextManager() as unknown as {
            updateHotContextSettings: (update: { preparedWindowTokens?: number | null }) => unknown;
          };
          const hot = cm.updateHotContextSettings.bind(cm);
          cm.updateHotContextSettings = (update) => {
            if (typeof update.preparedWindowTokens === 'number') throw new Error('no smaller window here');
            return hot(update);
          };
        }
        const refusal = Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
        const planned: number[] = [];
        const log = quietErrors();
        try {
          await withPatched('compile', async function (this: unknown, budget?: { maxTokens: number }) {
            planned.push(budget?.maxTokens ?? -1);
            throw refusal;
          }, async () => {
            await assert.rejects(compile(restarted), /over budget/);
          });
        } finally {
          log.restore();
        }
        assert.deepEqual(planned, [60_000, 100_000], `one fallback, then the refusal at the recipe's budget (canPace ${canPace})`);
        assert.equal(log.lines.filter((l) => l.includes('the context manager refused')).length, 1, `one fallback line (canPace ${canPace})`);
        assert.equal(budgets(restarted).target, 60_000, 'the boot budget stays set');
      });
    }
  });

  it('a budget at or above the recipe\'s, applied at once at boot, has no paced restore to fall back to: its refusal is the compile\'s', async () => {
    await run(async (h) => {
      const restarted = await provenAtBoot(h, 120_000);
      const { planned, lines, thrown } = await refusedFirst(restarted);
      assert.equal((thrown as Error | undefined)?.message, 'over budget');
      assert.deepEqual(planned, [120_000], 'no second compile');
      assert.ok(!lines.some((l) => l.includes('paced')), lines.join('\n'));
      assert.deepEqual(budgets(restarted), { target: 120_000, effective: 120_000, transition: 'stable' });
      assert.deepEqual(persisted(restarted), { contextBudgetTokens: 120_000 }, 'the refusal withdrew the marker');
    });
  });

  it("a refused budget the boot applied at once that can't be restored paced: the agent compiles at the recipe's, keeping the budget set", async () => {
    await run(async (h) => {
      const restarted = await provenAtBoot(h, 60_000);
      // The strategy can't prepare a smaller window now.
      const cm = restarted.getAgent('agent')!.getContextManager() as unknown as {
        updateHotContextSettings: (update: { preparedWindowTokens?: number | null }) => unknown;
      };
      const hot = cm.updateHotContextSettings.bind(cm);
      cm.updateHotContextSettings = (update) => {
        if (typeof update.preparedWindowTokens === 'number') throw new Error('no smaller window here');
        return hot(update);
      };
      const { planned, lines, thrown } = await refusedFirst(restarted);
      assert.equal(thrown, undefined);
      assert.deepEqual(planned, [60_000, 100_000]);
      assert.ok(lines.some((l) => l.includes(
        "couldn't restore it paced (no smaller window here), so it compiles at the recipe's budget, with contextBudgetTokens=60000 kept set",
      )), lines.join('\n'));
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 100_000, transition: 'stable' }, 'set to 60k, live at the recipe\'s');
      restarted.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      assert.deepEqual(persisted(restarted), { contextBudgetTokens: 60_000, tailTokens: 20_000 }, 'a later write keeps the budget');
    });
  });

  it('after the boot, a tail change keeps the fallback, and any write of the budget ends it', async () => {
    await run(async (h) => {
      h.framework().updateAgentRuntimeSettings('agent', { tailTokens: 15_000 });
      const restarted = await provenAtBoot(h, 60_000);
      restarted.updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      const { planned, thrown } = await refusedFirst(restarted);
      assert.equal(thrown, undefined);
      assert.deepEqual(planned, [60_000, 100_000], 'restored paced');
      assert.equal(restarted.getAgentRuntimeSettings('agent').tailTokens, 20_000, 'the fallback re-applies only the budget, not the boot\'s tail');
    });
    // Each write of the budget, before the first compile or while it runs,
    // is the operator's decision: the refusal is that compile's own.
    const writes: Array<[string, (f: AgentFramework) => void, boolean, number, ReturnType<typeof budgets>]> = [
      ['a paced decrease', (f) => { f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 50_000 }); }, false, 60_000,
        { target: 50_000, effective: 60_000, transition: 'converging' }],
      ['the same budget at once', (f) => { f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true }); }, false, 60_000,
        { target: 60_000, effective: 60_000, transition: 'stable' }],
      ['the same budget, unpersisted', (f) => { f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }, { persist: false }); }, false, 60_000,
        { target: 60_000, effective: 60_000, transition: 'stable' }],
      ['a reset of the budget', (f) => { f.resetAgentRuntimeSettings('agent', ['contextBudgetTokens']); }, false, 100_000,
        { target: 100_000, effective: 100_000, transition: 'stable' }],
      ['an increase while the first compile runs', (f) => { f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 80_000 }); }, true, 60_000,
        { target: 80_000, effective: 80_000, transition: 'stable' }],
    ];
    for (const [what, write, meanwhile, refusedAt, after] of writes) {
      await run(async (h) => {
        const restarted = await provenAtBoot(h, 60_000);
        if (!meanwhile) write(restarted);
        const { planned, thrown } = await refusedFirst(restarted, meanwhile ? () => write(restarted) : undefined);
        assert.equal((thrown as Error | undefined)?.message, 'over budget', what);
        assert.deepEqual(planned, [refusedAt], `${what}: no fallback`);
        assert.deepEqual(budgets(restarted), after, what);
      });
    }
    // And a compile that fits at it ends the fallback too.
    await run(async (h) => {
      const restarted = await provenAtBoot(h, 60_000);
      await compile(restarted);
      const { planned, thrown } = await refusedFirst(restarted);
      assert.equal((thrown as Error | undefined)?.message, 'over budget');
      assert.deepEqual(planned, [60_000], 'once a compile has fit at it, a refusal is the compile\'s own');
    });
  });

  /** A writer at the usual maxTokens leaves `record`; the agent then boots with maxTokens raised to 70k, above a persisted 60k. */
  async function bootRaised(record: Record, fn: (booted: AgentFramework, lines: string[]) => Promise<void> | void) {
    const { dir, config } = setup();
    const raised = () => ({ ...config(), agents: config().agents.map((a) => ({ ...a, maxTokens: 70_000 })) });
    try {
      const writer = await AgentFramework.create(config());
      writeRecord(writer, record);
      await writer.stop();
      const log = quietErrors();
      let booted: AgentFramework | undefined;
      try {
        booted = await AgentFramework.create(raised());
      } finally {
        log.restore();
      }
      try {
        await fn(booted, log.lines);
      } finally {
        await booted.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a persisted budget the agent can't take now (maxTokens raised above it) stays set but unapplied, and it runs at the recipe's, with a line", async () => {
    const refused = 'contextBudgetTokens must be a safe integer greater than max response tokens (70000)';
    const kept = `contextBudgetTokens=60000 (${refused}) can't be applied now, so it stays set but unapplied: ` +
      'contextBudgetTokens is 60000, and compiles plan at 100000';
    const cases: Array<[Record, string]> = [
      // One line, which keeps why a reached budget wasn't applied at once.
      [{ contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 },
        `[agent-settings] agent: its record says a compile fit at contextBudgetTokens=60000, but whether it fits now can't be checked (${refused}); ${kept}`],
      [{ contextBudgetTokens: 60_000 }, `[agent-settings] agent: ${kept}`],
    ];
    for (const [record, line] of cases) {
      await bootRaised(record, (booted, lines) => {
        assert.deepEqual(budgets(booted), { target: 60_000, effective: 100_000, transition: 'stable' }, JSON.stringify(record));
        assert.deepEqual(lines.filter((l) => l.includes('[agent-settings]')), [line], JSON.stringify(record));
      });
    }
  });

  it('a reached budget applies at once on its own, though a tail beside it can\'t be applied', async () => {
    await run(async ({ framework, restart }) => {
      framework().updateAgentRuntimeSettings('agent', { tailTokens: 20_000 });
      framework().updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
      await compile(framework());
      assert.deepEqual(persisted(framework()), { tailTokens: 20_000, contextBudgetTokens: 60_000, contextBudgetReachedTokens: 60_000 });
      // The strategy refuses a live tail now; it takes a budget as before.
      const proto = ContextManager.prototype as unknown as { updateHotContextSettings: (update: { tailTokens?: number }) => unknown };
      const original = proto.updateHotContextSettings;
      proto.updateHotContextSettings = function (this: unknown, update: { tailTokens?: number }) {
        if (update.tailTokens !== undefined) throw new Error('no live tail here');
        return original.call(this, update);
      };
      const log = quietErrors();
      let restarted: AgentFramework;
      try {
        restarted = await restart();
      } finally {
        proto.updateHotContextSettings = original;
        log.restore();
      }
      assert.deepEqual(budgets(restarted), { target: 60_000, effective: 60_000, transition: 'stable' }, 'the budget applied at once');
      assert.deepEqual(log.lines.filter((l) => l.includes('[agent-settings]')), [
        "[agent-settings] agent: tailTokens=20000 (no live tail here) can't be applied now, so it stays set but unapplied: " +
          'contextBudgetTokens is 60000, and compiles plan at 60000',
      ]);
    });
  });

  it("on a strategy without live settings, a tail and a lower budget stay set but unapplied, a later write keeps them, and a reset clears the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-settings-no-hot-'));
    // The context manager's default strategy has no live settings.
    const config = () => ({
      storePath: join(dir, 'store'), membrane,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', contextBudgetTokens: 100_000, maxTokens: 10_000 }],
      modules: [],
    });
    let framework = await AgentFramework.create(config());
    try {
      writeRecord(framework, { contextBudgetTokens: 60_000, tailTokens: 20_000 });
      await framework.stop();
      const log = quietErrors();
      try {
        framework = await AgentFramework.create(config());
      } finally {
        log.restore();
      }
      assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
        contextBudgetTokens: 60_000,
        effectiveContextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'public',
        sameRoundThinkTextPolicySource: 'compatibility_default',
        transition: 'stable',
      });
      assert.deepEqual(log.lines.filter((l) => l.includes('[agent-settings]')), [
        '[agent-settings] agent: tailTokens=20000 (The active context strategy does not support live tail/transition settings), ' +
          'contextBudgetTokens=60000 (The active context strategy cannot prepare a smaller window live) ' +
          "can't be applied now, so they stay set but unapplied: contextBudgetTokens is 60000, and compiles plan at 100000",
      ]);
      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'private' });
      assert.deepEqual(persisted(framework), { contextBudgetTokens: 60_000, tailTokens: 20_000, sameRoundThinkTextPolicy: 'private' });
      framework.resetAgentRuntimeSettings('agent', ['tailTokens']);
      assert.deepEqual(persisted(framework), { contextBudgetTokens: 60_000, sameRoundThinkTextPolicy: 'private' }, 'the reset clears the kept tail');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("each persisted setting is restored on its own: a private policy governs and a tail applies when the budget can't, and a later write keeps the budget", async () => {
    await bootRaised({ contextBudgetTokens: 60_000, tailTokens: 20_000, sameRoundThinkTextPolicy: 'private' }, (booted) => {
      const { contextBudgetTokens, effectiveContextBudgetTokens, tailTokens, sameRoundThinkTextPolicy, sameRoundThinkTextPolicySource } =
        booted.getAgentRuntimeSettings('agent');
      assert.deepEqual(
        { contextBudgetTokens, effectiveContextBudgetTokens, tailTokens, sameRoundThinkTextPolicy, sameRoundThinkTextPolicySource },
        { contextBudgetTokens: 60_000, effectiveContextBudgetTokens: 100_000, tailTokens: 20_000, sameRoundThinkTextPolicy: 'private', sameRoundThinkTextPolicySource: 'runtime_override' },
      );
      // The snapshot each request takes, which routes its same-round text and describes its think tool.
      const request = (booted as unknown as { captureInferenceToolSnapshot: (agent: Agent) => { sameRoundThinkTextPolicy: string } })
        .captureInferenceToolSnapshot(booted.getAgent('agent')!);
      assert.equal(request.sameRoundThinkTextPolicy, 'private');
      booted.updateAgentRuntimeSettings('agent', { tailTokens: 25_000 });
      assert.deepEqual(persisted(booted), { contextBudgetTokens: 60_000, tailTokens: 25_000, sameRoundThinkTextPolicy: 'private' });
    });
  });

  it("a patch's preview plans at the reach its next compile plans at", async () => {
    // The reach of every kv-stable plan, a preview's or a compile's, as the
    // strategy hands it to the planner.
    const proto = AutobiographicalStrategy.prototype as unknown as { buildPicker: (...args: unknown[]) => unknown };
    const original = proto.buildPicker;
    let reaches: Array<number | undefined> = [];
    proto.buildPicker = function (this: { _lastKvStable?: { opts?: { reachTokens?: number } } }, ...args: unknown[]) {
      const picker = original.apply(this, args);
      reaches.push(this._lastKvStable?.opts?.reachTokens);
      return picker;
    };
    // Preview `patch` after `before`, then apply it and compile: the reach both planned at.
    const both = async (before: (f: AgentFramework) => void, patch: AgentRuntimeSettingsPatch) => {
      let reach: number | undefined;
      await run(async ({ framework }) => {
        const f = framework();
        before(f);
        reaches = [];
        f.previewAgentRuntimeSettings('agent', patch);
        const previewed = reaches;
        reaches = [];
        f.updateAgentRuntimeSettings('agent', patch, { persist: false });
        reaches = [];
        await compile(f);
        assert.ok(previewed.length > 0 && reaches.length > 0, `${JSON.stringify(patch)}: planned ${JSON.stringify({ previewed, reaches })}`);
        assert.deepEqual([...new Set(previewed)], [...new Set(reaches)], JSON.stringify(patch));
        reach = reaches[0];
      });
      return reach;
    };
    const none = () => {};
    try {
      // The recipe's reach is 8k; no descent is under way unless `before` arms one.
      assert.equal(await both(none, { contextBudgetTokens: 60_000, transitionPaceTokens: 4_000, immediate: true }), 8_000, 'an immediate change: the configured reach');
      assert.equal(await both(none, { contextBudgetTokens: 60_000, transitionPaceTokens: 4_000 }), 4_000, 'a paced decrease: its pace');
      assert.equal(await both(none, { transitionPaceTokens: 4_000 }), 8_000, 'a pace with no descent: the configured reach');
      const descending = (f: AgentFramework) => { f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 }); };
      assert.equal(await both(descending, { transitionPaceTokens: 4_000 }), 4_000, 'a pace during a descent: that pace');
      const paced = (f: AgentFramework) => { f.updateAgentRuntimeSettings('agent', { transitionPaceTokens: 4_000 }); };
      assert.equal(await both(paced, { contextBudgetTokens: 60_000 }), 4_000, 'a paced decrease without a pace: the live one');
    } finally {
      proto.buildPicker = original;
    }
  });

  it('a descent ended by an immediate change to its own target is not credited to the compile that ran meanwhile', async () => {
    await run(async ({ framework }) => {
      const f = framework();
      f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000 });
      assert.equal(budgets(f).transition, 'converging');
      const original = (ContextManager.prototype as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile;
      // The compile plans at the live 100k; the same 60k is applied at once
      // while it runs, ending the descent without a settle.
      await withPatched('compile', async function (this: unknown, ...args: unknown[]) {
        f.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 60_000, immediate: true });
        return original.apply(this, args);
      }, () => compile(f));
      assert.deepEqual(budgets(f), { target: 60_000, effective: 60_000, transition: 'stable' });
      assert.deepEqual(persisted(f), { contextBudgetTokens: 60_000 }, 'nothing settled, and the compile planned at 100k');
    });
  });
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
      effectiveContextBudgetTokens: 100_000,
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
      effectiveContextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'recipe',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'public' }),
      {
        contextBudgetTokens: 100_000,
        effectiveContextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'public',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'stable',
      },
    );

    assert.deepEqual(
      framework.resetAgentRuntimeSettings('agent', ['sameRoundThinkTextPolicy']),
      {
        contextBudgetTokens: 100_000,
        effectiveContextBudgetTokens: 100_000,
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

it('preflight: a boot restore without a matching reached budget is never preflighted, so an infeasible persisted budget cannot brick startup', async () => {
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
