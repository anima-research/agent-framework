/**
 * agent_settings checks every setting a call names before it applies any, as
 * far as a check can tell: the names, the core settings' own checks and each
 * extension's validate. What a check can't foresee (an extension without
 * validate, the budget preflight, a strategy's own refusal, a store write
 * that fails) can still refuse after something applied, so what can refuse
 * goes first, and every refusal says exactly what the call changed: nothing,
 * or which settings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { AgentSettingsExtension, EventResponse, Module, ProcessEvent, ToolCall, ToolResult } from '../src/index.js';

const membrane = {} as never;

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

/** A module whose agent_settings extension owns one key, checking ahead or not. */
class SettingModule implements Module {
  value: unknown = 'zz-initial';
  constructor(readonly name: string, private readonly key: string, private readonly checksAhead: boolean) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
  getAgentSettingsExtension(): AgentSettingsExtension {
    const refuse = (patch: Record<string, unknown>) => {
      if (patch[this.key] === 'zz-bad') throw new Error(`${this.key} refused zz-bad`);
    };
    return {
      properties: { [this.key]: { type: 'string' } },
      keys: [this.key],
      get: () => ({ [this.key]: this.value }),
      ...(this.checksAhead ? { validate: (_agent: string, patch: Record<string, unknown>) => refuse(patch) } : {}),
      update: (_agent, patch) => {
        refuse(patch);
        this.value = patch[this.key];
        return { [this.key]: this.value };
      },
      reset: () => {
        this.value = 'zz-initial';
        return { [this.key]: this.value };
      },
    };
  }
}

async function withFramework(
  options: { strategy?: false | AutobiographicalStrategy; modules?: Module[]; contextBudgetTokens?: number },
  fn: (framework: AgentFramework, call: (input: Record<string, unknown>) => ToolResult) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-atomic-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      ...(options.strategy === false ? {} : { strategy: options.strategy ?? strategy() }),
      contextBudgetTokens: options.contextBudgetTokens ?? 100_000,
      maxTokens: 10_000,
    }],
    modules: options.modules ?? [],
  });
  // The tool answers through a tool-result event; take it as it's pushed.
  const internal = framework as unknown as {
    pushEvent(event: unknown): void;
    dispatchAgentSettingsToolCall(agentName: string, call: ToolCall): void;
  };
  const results: ToolResult[] = [];
  const push = internal.pushEvent.bind(framework);
  internal.pushEvent = (event: unknown) => {
    const e = event as { type?: string; toolName?: string; result?: ToolResult };
    if (e.type === 'tool-result' && e.toolName === 'agent_settings') results.push(e.result!);
    else push(event);
  };
  let n = 0;
  const call = (input: Record<string, unknown>): ToolResult => {
    internal.dispatchAgentSettingsToolCall('agent', { id: `zz-settings-${++n}`, name: 'agent_settings', input });
    return results[results.length - 1]!;
  };
  try {
    await fn(framework, call);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const settings = (call: (input: Record<string, unknown>) => ToolResult) =>
  call({ action: 'get' }).data as Record<string, unknown>;

describe('agent_settings checks a call\'s settings before it applies any, and says what a refusal changed', () => {
  it('a refused core setting leaves the extensions\' settings in the call unapplied', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tool_result_inline_max_chars: 5_000, tool_result_guard: true, tail_tokens: -1 });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'tailTokens must be a non-negative safe integer. Nothing in this call was changed.');
      const now = settings(call);
      assert.equal(now.tool_result_inline_max_chars, null, 'the inline cap was not set');
      assert.equal(now.tool_result_guard, false, 'the guard was not enabled');
      assert.equal(now.tailTokens, 30_000);
    });
  });

  it('a refused extension setting leaves the core settings in the call unapplied', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, tool_result_inline_max_chars: 5_000, tool_result_guard: 'yes' });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'tool_result_guard must be a boolean. Nothing in this call was changed.');
      const now = settings(call);
      assert.equal(now.tailTokens, 30_000, 'the tail was not changed');
      assert.equal(now.tool_result_inline_max_chars, null, 'the inline cap, checked before it, was not set either');
    });
  });

  it('a lower budget the strategy can\'t reach gradually is refused before an extension applies', async () => {
    await withFramework({ strategy: false }, (_framework, call) => {
      const refused = call({ action: 'update', context_budget_tokens: 60_000, tool_result_guard: true });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'The active context strategy cannot prepare a smaller window live. Nothing in this call was changed.');
      assert.equal(settings(call).tool_result_guard, false);
    });
  });

  it('the budget preflight\'s refusal comes before an extension applies', async () => {
    await withFramework({ contextBudgetTokens: 550_000 }, (framework, call) => {
      const cm = framework.getAgent('agent')!.getContextManager() as unknown as {
        previewContext?: (budget: { maxTokens: number }) => unknown;
      };
      cm.previewContext = (budget) => ({
        finalTokens: 450_000, budgetTokens: budget.maxTokens, fits: false, exhausted: true,
        headTokens: 10_000, tailTokens: 30_000, middleTokens: 410_000, middleChunkCount: 7,
        deepestLevel: 3, resolutions: {}, moves: 0, producedCount: 0,
      });
      const refused = call({
        action: 'update', context_budget_tokens: 260_000, immediate: true, tool_result_guard: true, closed_channel_note: false,
      });
      assert.equal(refused.isError, true);
      assert.match(refused.error!, /^\[budget-preflight\] contextBudgetTokens=260000 would NOT fit/);
      assert.match(refused.error!, / Nothing in this call was changed\.$/);
      const now = settings(call);
      assert.equal(now.tool_result_guard, false);
      assert.equal(now.closed_channel_note, true);
      assert.equal(now.contextBudgetTokens, 550_000);
    });
  });

  it('a module extension that checks ahead refuses before the core applies', async () => {
    const module = new SettingModule('zz-ahead', 'zz_ahead', true);
    await withFramework({ modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_ahead: 'zz-bad' });
      assert.equal(refused.error, 'zz_ahead refused zz-bad. Nothing in this call was changed.');
      assert.equal(settings(call).tailTokens, 30_000);
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('a module extension that can\'t check ahead is applied first, so its refusal leaves the rest unapplied', async () => {
    const module = new SettingModule('zz-late', 'zz_late', false);
    await withFramework({ modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, tool_result_guard: true, zz_late: 'zz-bad' });
      assert.equal(refused.error, 'zz_late refused zz-bad. Nothing in this call was changed.');
      const now = settings(call);
      assert.equal(now.tailTokens, 30_000);
      assert.equal(now.tool_result_guard, false);
    });
  });

  it('when two extensions can\'t check ahead, the refusal names what the first changed', async () => {
    const first = new SettingModule('zz-first', 'zz_first', false);
    const second = new SettingModule('zz-second', 'zz_second', false);
    await withFramework({ modules: [first, second] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_first: 'zz-good', zz_second: 'zz-bad' });
      assert.equal(refused.error, 'zz_second refused zz-bad. Changed before the refusal: zz_first; nothing else in this call was.');
      assert.equal(first.value, 'zz-good');
      assert.equal(second.value, 'zz-initial');
      assert.equal(settings(call).tailTokens, 30_000);
    });
  });

  it('a name that is no setting is refused, with nothing applied', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, tail_token: 5_000 });
      assert.equal(refused.error, 'Unknown setting: tail_token. Nothing in this call was changed.');
      assert.equal(settings(call).tailTokens, 30_000);
      const two = call({ action: 'update', zz_one: 1, zz_two: 2 });
      assert.equal(two.error, 'Unknown settings: zz_one, zz_two. Nothing in this call was changed.');
    });
  });

  it('a reset the core refuses leaves the extensions\' settings as they were', async () => {
    await withFramework({ strategy: false }, (framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).isError, undefined);
      // A raised budget, so a reset-all returns to a smaller configured one.
      framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 150_000 });
      const refused = call({ action: 'reset' });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'The active context strategy cannot prepare a smaller window live. Nothing in this call was changed.');
      const now = settings(call);
      assert.equal(now.tool_result_inline_max_chars, 5_000, 'the inline cap was not reset');
      assert.equal(now.contextBudgetTokens, 150_000);
    });
  });

  it('a call that changes everything it names still answers as before', async () => {
    const module = new SettingModule('zz-ahead', 'zz_ahead', true);
    await withFramework({ modules: [module] }, (_framework, call) => {
      const done = call({ action: 'update', tail_tokens: 20_000, tool_result_guard: true, zz_ahead: 'zz-good' });
      assert.equal(done.success, true);
      const data = done.data as Record<string, unknown>;
      assert.equal(data.tailTokens, 20_000);
      assert.equal(data.tool_result_guard, true);
      assert.equal(data.zz_ahead, 'zz-good');
      assert.equal(module.value, 'zz-good');
    });
  });
  it('the strategy\'s own refusal comes before the extensions that checked ahead apply', async () => {
    // An autobiographical strategy without kv-stable folding has live
    // settings, but refuses a gradual transition when the update applies.
    const unpaced = new AutobiographicalStrategy({ recentWindowTokens: 30_000 });
    await withFramework({ strategy: unpaced }, (_framework, call) => {
      const refused = call({ action: 'update', context_budget_tokens: 60_000, tool_result_inline_max_chars: 5_000 });
      assert.equal(refused.isError, true);
      assert.match(refused.error!, /^Gradual context-window transitions require adaptiveResolution with foldingStrategy "kv-stable"\. Nothing in this call was changed\.$/);
      const now = settings(call);
      assert.equal(now.tool_result_inline_max_chars, null, 'the inline cap was not set');
      assert.equal(now.contextBudgetTokens, 100_000);
    });
  });

  it('a tail for a strategy without live settings is refused before anything applies', async () => {
    const module = new SettingModule('zz-late', 'zz_late', false);
    await withFramework({ strategy: false, modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_late: 'zz-good', tool_result_inline_max_chars: 5_000 });
      assert.equal(refused.error, 'The active context strategy does not support live tail/transition settings. Nothing in this call was changed.');
      assert.equal(module.value, 'zz-initial', 'the extension without validate, applied first otherwise, was not');
      assert.equal(settings(call).tool_result_inline_max_chars, null);
    });
  });

  it('a context manager that can\'t give the strategy\'s live settings refuses before anything applies', async () => {
    const module = new SettingModule('zz-late', 'zz_late', false);
    await withFramework({ modules: [module] }, (framework, call) => {
      const cm = framework.getAgent('agent')!.getContextManager() as unknown as { getHotContextSettings: () => unknown };
      cm.getHotContextSettings = () => { throw new Error('zz-branch not loaded'); };
      const refused = call({ action: 'update', zz_late: 'zz-good', context_budget_tokens: 150_000 });
      assert.equal(refused.error, 'zz-branch not loaded. Nothing in this call was changed.');
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('an update that names `settings` is refused, since only a reset reads it', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', settings: ['tail_tokens'], tail_tokens: 20_000 });
      assert.equal(refused.error, '`settings` lists names for a reset; to change a setting, give its name and new value. Nothing in this call was changed.');
      assert.equal(settings(call).tailTokens, 30_000);
    });
  });

  it('an extension\'s validate refuses before an extension without one applies', async () => {
    const module = new SettingModule('zz-late', 'zz_late', false);
    await withFramework({ modules: [module] }, (_framework, call) => {
      const cap = call({ action: 'update', zz_late: 'zz-good', tool_result_inline_max_chars: 500 });
      assert.equal(cap.error, 'tool_result_inline_max_chars must be a number >= 1000. Nothing in this call was changed.');
      const guard = call({ action: 'update', zz_late: 'zz-good', tool_result_guard: 'yes' });
      assert.equal(guard.error, 'tool_result_guard must be a boolean. Nothing in this call was changed.');
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('a store write that fails after a setting changed names that setting', async () => {
    await withFramework({}, (framework, call) => {
      const internal = framework as unknown as {
        persistToolResultInlineCap: (...args: unknown[]) => void;
        persistAgentRuntimeSettings: (...args: unknown[]) => void;
      };
      const persistCap = internal.persistToolResultInlineCap;
      internal.persistToolResultInlineCap = () => { throw new Error('zz-disk full'); };
      const cap = call({ action: 'update', tool_result_inline_max_chars: 5_000 });
      assert.equal(cap.error, 'zz-disk full. Changed before the refusal: tool_result_inline_max_chars; nothing else in this call was.');
      internal.persistToolResultInlineCap = persistCap;
      internal.persistAgentRuntimeSettings = () => { throw new Error('zz-disk full'); };
      const tail = call({ action: 'update', tail_tokens: 20_000 });
      assert.equal(tail.error, 'zz-disk full. Changed before the refusal: tail_tokens; nothing else in this call was.');
      assert.equal(settings(call).tailTokens, 20_000, 'in memory, as the refusal says');
    });
  });

  it('a saved setting the strategy doesn\'t apply is named when a refused reset cleared it', async () => {
    await withFramework({ strategy: false }, (framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).success, true);
      // Saved under a strategy with live settings; this one doesn't apply it.
      (framework.getAgent('agent') as unknown as { runtimeSettingsOverrides: Record<string, unknown> })
        .runtimeSettingsOverrides.tailTokens = 20_000;
      (framework as unknown as { persistToolResultInlineCap: (...args: unknown[]) => void })
        .persistToolResultInlineCap = () => { throw new Error('zz-disk full'); };
      const refused = call({ action: 'reset', settings: ['tail_tokens', 'tool_result_inline_max_chars'] });
      assert.equal(refused.error,
        'zz-disk full. Changed before the refusal: tail_tokens, tool_result_inline_max_chars; nothing else in this call was.');
    });
  });

  it('the budget preflight\'s notes are logged only once the budget has applied', async () => {
    await withFramework({ strategy: false }, (framework, call) => {
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        const internal = framework as unknown as { persistAgentRuntimeSettings: (...args: unknown[]) => void };
        const persist = internal.persistAgentRuntimeSettings;
        internal.persistAgentRuntimeSettings = () => { throw new Error('zz-disk full'); };
        const failed = call({ action: 'update', context_budget_tokens: 150_000 });
        assert.equal(failed.error, 'zz-disk full. Changed before the refusal: context_budget_tokens; nothing else in this call was.');
        assert.deepEqual(warned.filter((w) => w.startsWith('[budget-preflight]')), [], 'nothing claims an apply that failed');
        internal.persistAgentRuntimeSettings = persist;
        assert.equal(call({ action: 'update', context_budget_tokens: 160_000 }).success, true);
        assert.equal(warned.filter((w) => w.startsWith('[budget-preflight]')).length, 1);
      } finally {
        console.warn = warn;
      }
    });
  });

  it('a reset refuses a name beside `settings`, and a name that is no setting', async () => {
    await withFramework({}, (_framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).isError, undefined);
      const stray = call({ action: 'reset', tail_tokens: 20_000 });
      assert.equal(stray.error, 'A reset takes only `settings`, a list of setting names; it has no tail_tokens. Nothing in this call was changed.');
      const inherited = call({ action: 'reset', settings: ['constructor'] });
      assert.equal(inherited.error, 'Unknown reset setting: constructor. Nothing in this call was changed.');
      assert.equal(settings(call).tool_result_inline_max_chars, 5_000, 'nothing was reset');
    });
  });

  it('a reset of a setting that isn\'t the budget passes while a raised budget sits above the configured one', async () => {
    await withFramework({ strategy: false }, (framework, call) => {
      framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 150_000 });
      const reset = call({ action: 'reset', settings: ['same_round_think_text_policy'] });
      assert.equal(reset.success, true, reset.error);
      assert.equal(settings(call).contextBudgetTokens, 150_000);
    });
  });

  it('an immediate lower budget passes on an agent whose strategy has no live settings', async () => {
    await withFramework({ strategy: false }, (_framework, call) => {
      const lower = call({ action: 'update', context_budget_tokens: 60_000, immediate: true });
      assert.equal(lower.success, true, lower.error);
      assert.equal(settings(call).contextBudgetTokens, 60_000);
    });
  });

  it('a reset of everything resets the extensions\' settings and answers with them', async () => {
    const module = new SettingModule('zz-late', 'zz_late', false);
    await withFramework({ modules: [module] }, (_framework, call) => {
      assert.equal(call({ action: 'update', zz_late: 'zz-good', tool_result_inline_max_chars: 5_000 }).success, true);
      const reset = call({ action: 'reset' });
      assert.equal(reset.success, true, reset.error);
      const data = reset.data as Record<string, unknown>;
      assert.equal(data.zz_late, 'zz-initial');
      assert.equal(data.tool_result_inline_max_chars, null);
      assert.equal(module.value, 'zz-initial');
    });
  });
});
