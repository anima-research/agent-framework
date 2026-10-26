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

class SettingModule implements Module {
  value: unknown = 'zz-initial';
  constructor(readonly name: string, private readonly key: string) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
  getAgentSettingsExtension(): AgentSettingsExtension {
    return {
      properties: { [this.key]: { type: 'string' } },
      keys: [this.key],
      get: () => ({ [this.key]: this.value }),
      update: (_agent, patch) => {
        if (patch[this.key] === 'zz-bad') throw new Error(`${this.key} refused zz-bad`);
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

class TwoKeyModule implements Module {
  readonly name = 'zz-two';
  values: Record<string, unknown> = { zz_a: 'zz-initial', zz_b: 'zz-initial' };
  unreadableAfterUpdate = false;
  private updated = false;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools() { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
  getAgentSettingsExtension(): AgentSettingsExtension {
    return {
      properties: { zz_a: { type: 'string' }, zz_b: { type: 'string' } },
      keys: ['zz_a', 'zz_b'],
      get: () => {
        if (this.unreadableAfterUpdate && this.updated) throw new Error('zz-unreadable');
        return Object.fromEntries(Object.entries(this.values).filter(([, value]) => value !== undefined));
      },
      update: (_agent, patch) => {
        this.updated = true;
        for (const key of ['zz_a', 'zz_b']) {
          if (patch[key] === undefined) continue;
          if (patch[key] === 'zz-bad') throw new Error(`${key} refused zz-bad`);
          this.values[key] = patch[key];
        }
        return { ...this.values };
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

describe('agent_settings refuses names it doesn\'t take and core values of the wrong type before anything applies, applies the core first, and says what a refusal changed', () => {
  it('a refused core setting leaves the extensions\' settings in the call unapplied', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tool_result_inline_max_chars: 5_000, tool_result_guard: true, tail_tokens: -1 });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'tailTokens must be a non-negative safe integer. No setting reads differently after this call.');
      const now = settings(call);
      assert.equal(now.tool_result_inline_max_chars, null, 'the inline cap was not set');
      assert.equal(now.tool_result_guard, false, 'the guard was not enabled');
      assert.equal(now.tailTokens, 30_000);
    });
  });

  it('an extension\'s refused setting comes after the core applied, and the refusal names what changed', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, tool_result_inline_max_chars: 5_000, tool_result_guard: 'yes' });
      assert.equal(refused.isError, true);
      assert.equal(refused.error,
        'tool_result_guard must be true or false, not "yes". Changed before the refusal: tail_tokens, tool_result_inline_max_chars; no other setting reads differently.');
      const now = settings(call);
      assert.equal(now.tailTokens, 20_000);
      assert.equal(now.tool_result_inline_max_chars, 5_000);
      assert.equal(now.tool_result_guard, false);
    });
  });

  it('a lower budget the strategy can\'t reach gradually is refused before an extension applies', async () => {
    await withFramework({ strategy: false }, (_framework, call) => {
      const refused = call({ action: 'update', context_budget_tokens: 60_000, tool_result_guard: true });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'The active context strategy cannot prepare a smaller window live. No setting reads differently after this call.');
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
      assert.match(refused.error!, / or pass allowInfeasible\. No setting reads differently after this call\.$/);
      const now = settings(call);
      assert.equal(now.tool_result_guard, false);
      assert.equal(now.closed_channel_note, true);
      assert.equal(now.contextBudgetTokens, 550_000);
    });
  });

  it('a module extension\'s refusal comes after the core applied, and names it', async () => {
    const module = new SettingModule('zz-module', 'zz_module');
    await withFramework({ modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_module: 'zz-bad' });
      assert.equal(refused.error, 'zz_module refused zz-bad. Changed before the refusal: tail_tokens; no other setting reads differently.');
      assert.equal(settings(call).tailTokens, 20_000);
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('a core refusal leaves a module extension\'s setting in the call unapplied', async () => {
    const module = new SettingModule('zz-module', 'zz_module');
    await withFramework({ modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: -1, zz_module: 'zz-good' });
      assert.equal(refused.error, 'tailTokens must be a non-negative safe integer. No setting reads differently after this call.');
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('when one extension refuses after another applied, the refusal names both the core and that one', async () => {
    const first = new SettingModule('zz-first', 'zz_first');
    const second = new SettingModule('zz-second', 'zz_second');
    await withFramework({ modules: [first, second] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_first: 'zz-good', zz_second: 'zz-bad' });
      assert.equal(refused.error, 'zz_second refused zz-bad. Changed before the refusal: tail_tokens, zz_first; no other setting reads differently.');
      assert.equal(first.value, 'zz-good');
      assert.equal(second.value, 'zz-initial');
      assert.equal(settings(call).tailTokens, 20_000);
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
      framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 150_000 });
      const refused = call({ action: 'reset' });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'The active context strategy cannot prepare a smaller window live. No setting reads differently after this call.');
      const now = settings(call);
      assert.equal(now.tool_result_inline_max_chars, 5_000, 'the inline cap was not reset');
      assert.equal(now.contextBudgetTokens, 150_000);
    });
  });

  it('a call that changes everything it names still answers as before', async () => {
    const module = new SettingModule('zz-module', 'zz_module');
    await withFramework({ modules: [module] }, (_framework, call) => {
      const done = call({ action: 'update', tail_tokens: 20_000, tool_result_guard: true, zz_module: 'zz-good' });
      assert.equal(done.success, true);
      const data = done.data as Record<string, unknown>;
      assert.equal(data.tailTokens, 20_000);
      assert.equal(data.tool_result_guard, true);
      assert.equal(data.zz_module, 'zz-good');
      assert.equal(module.value, 'zz-good');
    });
  });

  it('the strategy\'s own refusal comes before any extension applies', async () => {
    const unpaced = new AutobiographicalStrategy({ recentWindowTokens: 30_000 });
    await withFramework({ strategy: unpaced }, (_framework, call) => {
      const refused = call({ action: 'update', context_budget_tokens: 60_000, tool_result_inline_max_chars: 5_000 });
      assert.equal(refused.isError, true);
      assert.match(refused.error!, /^Gradual context-window transitions require adaptiveResolution with foldingStrategy "kv-stable"\. No setting reads differently after this call\.$/);
      const now = settings(call);
      assert.equal(now.tool_result_inline_max_chars, null, 'the inline cap was not set');
      assert.equal(now.contextBudgetTokens, 100_000);
    });
  });

  it('a tail for a strategy without live settings is refused before anything applies', async () => {
    const module = new SettingModule('zz-module', 'zz_module');
    await withFramework({ strategy: false, modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_module: 'zz-good', tool_result_inline_max_chars: 5_000 });
      assert.equal(refused.error, 'The active context strategy does not support live tail/transition settings. No setting reads differently after this call.');
      assert.equal(module.value, 'zz-initial');
      assert.equal(settings(call).tool_result_inline_max_chars, null);
    });
  });

  it('a context manager that can\'t give the strategy\'s live settings refuses before anything applies', async () => {
    const module = new SettingModule('zz-module', 'zz_module');
    await withFramework({ modules: [module] }, (framework, call) => {
      const cm = framework.getAgent('agent')!.getContextManager() as unknown as { getHotContextSettings: () => unknown };
      cm.getHotContextSettings = () => { throw new Error('zz-branch not loaded'); };
      const refused = call({ action: 'update', zz_module: 'zz-good', context_budget_tokens: 150_000 });
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

  it('a store write that fails after a setting changed names that setting', async () => {
    await withFramework({}, (framework, call) => {
      const internal = framework as unknown as {
        persistToolResultInlineCap: (...args: unknown[]) => void;
        persistAgentRuntimeSettings: (...args: unknown[]) => void;
      };
      const persistCap = internal.persistToolResultInlineCap;
      internal.persistToolResultInlineCap = () => { throw new Error('zz-disk full'); };
      const cap = call({ action: 'update', tool_result_inline_max_chars: 5_000 });
      assert.equal(cap.error, 'zz-disk full. Changed before the refusal: tool_result_inline_max_chars; no other setting reads differently.');
      internal.persistToolResultInlineCap = persistCap;
      internal.persistAgentRuntimeSettings = () => { throw new Error('zz-disk full'); };
      const tail = call({ action: 'update', tail_tokens: 20_000 });
      assert.equal(tail.error, 'zz-disk full. Changed before the refusal: tail_tokens; no other setting reads differently.');
      assert.equal(settings(call).tailTokens, 20_000, 'in memory, as the refusal says');
    });
  });

  it('a saved setting the strategy doesn\'t apply is named when a refused reset cleared it', async () => {
    await withFramework({ strategy: false }, (framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).success, true);
      (framework.getAgent('agent') as unknown as { runtimeSettingsOverrides: Record<string, unknown> })
        .runtimeSettingsOverrides.tailTokens = 20_000;
      (framework as unknown as { persistToolResultInlineCap: (...args: unknown[]) => void })
        .persistToolResultInlineCap = () => { throw new Error('zz-disk full'); };
      const refused = call({ action: 'reset', settings: ['tail_tokens', 'tool_result_inline_max_chars'] });
      assert.equal(refused.error,
        'zz-disk full. Changed before the refusal: tail_tokens, tool_result_inline_max_chars; no other setting reads differently.');
    });
  });

  it('a reset refuses a name beside `settings`, and a name that is no setting', async () => {
    await withFramework({}, (_framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).isError, undefined);
      const stray = call({ action: 'reset', tail_tokens: 20_000 });
      assert.equal(stray.error, 'A reset doesn\'t take tail_tokens: give the names to reset in `settings`. Nothing in this call was changed.');
      const beside = call({ action: 'reset', settings: ['tool_result_inline_max_chars'], zz_stray: 1 });
      assert.equal(beside.error, 'A reset doesn\'t take zz_stray: give the names to reset in `settings`. Nothing in this call was changed.');
      const inherited = call({ action: 'reset', settings: ['constructor'] });
      assert.equal(inherited.error, 'Unknown reset setting: constructor. Nothing in this call was changed.');
      assert.equal(settings(call).tool_result_inline_max_chars, 5_000, 'nothing was reset');
    });
  });

  it('a cancel refuses any name beside `action`, and cancels nothing', async () => {
    await withFramework({}, (_framework, call) => {
      assert.equal(call({ action: 'update', context_budget_tokens: 60_000 }).success, true);
      assert.equal(settings(call).transition, 'converging');
      const stray = call({ action: 'cancel', context_budget_tokens: 80_000 });
      assert.equal(stray.isError, true);
      assert.equal(stray.error, 'A cancel doesn\'t take context_budget_tokens: it takes no settings. Nothing in this call was changed.');
      assert.equal(settings(call).transition, 'converging', 'the descent goes on');
      assert.equal(call({ action: 'cancel' }).success, true);
      assert.equal(settings(call).transition, 'stable');
    });
  });

  it('a numeric setting takes a number or text that reads as one, and refuses anything else', async () => {
    await withFramework({}, (_framework, call) => {
      for (const value of [null, '', '  ', 'abc', true, false, [20_000], {}]) {
        const refused = call({ action: 'update', tail_tokens: value });
        assert.equal(refused.error, `tail_tokens must be a number, not ${JSON.stringify(value)}. Nothing in this call was changed.`, JSON.stringify(value));
      }
      assert.equal(settings(call).tailTokens, 30_000);
      const budget = call({ action: 'update', context_budget_tokens: [150_000] });
      assert.equal(budget.error, 'context_budget_tokens must be a number, not [150000]. Nothing in this call was changed.');
      const pace = call({ action: 'update', transition_pace_tokens: true });
      assert.equal(pace.error, 'transition_pace_tokens must be a number, not true. Nothing in this call was changed.');
      const cap = call({ action: 'update', tool_result_inline_max_chars: null });
      assert.equal(cap.error, 'tool_result_inline_max_chars must be a number, not null. No setting reads differently after this call.');
      assert.equal(call({ action: 'update', tail_tokens: '20000' }).success, true);
      assert.equal(settings(call).tailTokens, 20_000);
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: '5000' }).success, true);
      assert.equal(settings(call).tool_result_inline_max_chars, 5_000);
    });
  });

  it('a boolean takes true or false, or the text "true" or "false", and refuses anything else', async () => {
    await withFramework({}, (_framework, call) => {
      for (const value of ['yes', 1, null]) {
        const refused = call({ action: 'update', context_budget_tokens: 60_000, immediate: value });
        assert.equal(refused.error, `immediate must be true or false, not ${JSON.stringify(value)}. Nothing in this call was changed.`, JSON.stringify(value));
      }
      assert.equal(settings(call).contextBudgetTokens, 100_000);
      assert.equal(call({ action: 'update', context_budget_tokens: 60_000, immediate: 'false' }).success, true);
      let now = settings(call);
      assert.equal(now.transition, 'converging');
      assert.equal(now.effectiveContextBudgetTokens, 100_000);
      assert.equal(call({ action: 'update', context_budget_tokens: 60_000, immediate: 'true' }).success, true);
      now = settings(call);
      assert.equal(now.transition, 'stable');
      assert.equal(now.effectiveContextBudgetTokens, 60_000);
      assert.equal(call({ action: 'update', tool_result_guard: 'true', closed_channel_note: 'false' }).success, true);
      now = settings(call);
      assert.equal(now.tool_result_guard, true);
      assert.equal(now.closed_channel_note, false);
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
    const module = new SettingModule('zz-module', 'zz_module');
    await withFramework({ modules: [module] }, (_framework, call) => {
      assert.equal(call({ action: 'update', zz_module: 'zz-good', tool_result_inline_max_chars: 5_000 }).success, true);
      const reset = call({ action: 'reset' });
      assert.equal(reset.success, true, reset.error);
      const data = reset.data as Record<string, unknown>;
      assert.equal(data.zz_module, 'zz-initial');
      assert.equal(data.tool_result_inline_max_chars, null);
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('a refusal inside one extension\'s update names the key it had already changed', async () => {
    const two = new TwoKeyModule();
    await withFramework({ modules: [two] }, (_framework, call) => {
      const refused = call({ action: 'update', zz_a: 'zz-good', zz_b: 'zz-bad' });
      assert.equal(refused.error, 'zz_b refused zz-bad. Changed before the refusal: zz_a; no other setting reads differently.');
      assert.equal(two.values.zz_a, 'zz-good');
    });
  });

  it('a refusal says so when the settings can\'t be read back after it', async () => {
    const two = new TwoKeyModule();
    two.unreadableAfterUpdate = true;
    await withFramework({ modules: [two] }, (_framework, call) => {
      const refused = call({ action: 'update', zz_a: 'zz-good', zz_b: 'zz-bad' });
      assert.equal(refused.error, 'zz_b refused zz-bad. Whether anything in this call was changed couldn\'t be read back.');
    });
  });

  it('a named reset of a setting whose extension can\'t reset is refused before anything applies', async () => {
    const two = new TwoKeyModule();
    await withFramework({ modules: [two] }, (_framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).success, true);
      const refused = call({ action: 'reset', settings: ['tool_result_inline_max_chars', 'zz_a'] });
      assert.equal(refused.error, 'zz_a can\'t be reset. Nothing in this call was changed.');
      assert.equal(settings(call).tool_result_inline_max_chars, 5_000, 'nothing was reset');
    });
  });

  it('the account names a changed budget, pace or think policy', async () => {
    await withFramework({}, (_framework, call) => {
      const policy = settings(call).sameRoundThinkTextPolicy === 'public' ? 'private' : 'public';
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ context_budget_tokens: 150_000 }, 'context_budget_tokens'],
        [{ transition_pace_tokens: 4_000 }, 'transition_pace_tokens'],
        [{ same_round_think_text_policy: policy }, 'same_round_think_text_policy'],
      ];
      for (const [core, name] of cases) {
        const refused = call({ action: 'update', ...core, tool_result_guard: 'yes' });
        assert.equal(refused.error,
          `tool_result_guard must be true or false, not "yes". Changed before the refusal: ${name}; no other setting reads differently.`, name);
      }
    });
  });

  it('an override saved equal to the value it replaces is named by its setting', async () => {
    await withFramework({}, (_framework, call) => {
      assert.equal(settings(call).tool_result_guard_source, 'recipe_default');
      const refused = call({ action: 'update', tool_result_guard: false, closed_channel_note: 'no' });
      assert.equal(refused.error,
        'closed_channel_note must be true or false, not "no". Changed before the refusal: tool_result_guard; no other setting reads differently.');
      assert.equal(settings(call).tool_result_guard_source, 'runtime_override');
    });
  });

  it('an extension\'s value set from unset to null is named', async () => {
    const first = new SettingModule('zz-first', 'zz_first');
    const second = new SettingModule('zz-second', 'zz_second');
    first.value = undefined;
    await withFramework({ modules: [first, second] }, (_framework, call) => {
      const refused = call({ action: 'update', zz_first: null, zz_second: 'zz-bad' });
      assert.equal(refused.error, 'zz_second refused zz-bad. Changed before the refusal: zz_first; no other setting reads differently.');
      assert.equal(first.value, null);
    });
  });

  it('an extension value its get leaves out while unset is named once the call sets it', async () => {
    const two = new TwoKeyModule();
    two.values.zz_a = undefined;
    await withFramework({ modules: [two] }, (_framework, call) => {
      const refused = call({ action: 'update', zz_a: null, zz_b: 'zz-bad' });
      assert.equal(refused.error, 'zz_b refused zz-bad. Changed before the refusal: zz_a; no other setting reads differently.');
    });
  });

  it('a cancel that fails after changing the budget names it', async () => {
    await withFramework({}, (framework, call) => {
      assert.equal(call({ action: 'update', context_budget_tokens: 60_000 }).success, true);
      (framework as unknown as { persistAgentRuntimeSettings: (...args: unknown[]) => void })
        .persistAgentRuntimeSettings = () => { throw new Error('zz-disk full'); };
      const refused = call({ action: 'cancel' });
      assert.equal(refused.error, 'zz-disk full. Changed before the refusal: context_budget_tokens; no other setting reads differently.');
      assert.equal(settings(call).transition, 'stable', 'in memory, as the refusal says');
    });
  });
});
