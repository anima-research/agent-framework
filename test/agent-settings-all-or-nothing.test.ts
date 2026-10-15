/**
 * agent_settings changes all of a call's settings or none of them: every
 * setting, the core ones and each extension's, is checked before any is
 * applied, so a refusal leaves everything as it was, and says so.
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
  options: { strategy?: boolean; modules?: Module[]; contextBudgetTokens?: number },
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
      ...(options.strategy === false ? {} : { strategy: strategy() }),
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

describe('agent_settings changes all of a call\'s settings or none', () => {
  it('a refused core setting leaves the extensions\' settings in the call unapplied', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tool_result_inline_max_chars: 5_000, tool_result_guard: true, tail_tokens: -1 });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'tailTokens must be a non-negative safe integer Nothing in this call was changed.');
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
      assert.equal(refused.error, 'tool_result_guard must be a boolean Nothing in this call was changed.');
      const now = settings(call);
      assert.equal(now.tailTokens, 30_000, 'the tail was not changed');
      assert.equal(now.tool_result_inline_max_chars, null, 'the inline cap, checked before it, was not set either');
    });
  });

  it('a lower budget the strategy can\'t reach gradually is refused before an extension applies', async () => {
    await withFramework({ strategy: false }, (_framework, call) => {
      const refused = call({ action: 'update', context_budget_tokens: 60_000, tool_result_guard: true });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'The active context strategy cannot prepare a smaller window live Nothing in this call was changed.');
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
      const refused = call({ action: 'update', context_budget_tokens: 260_000, immediate: true, tool_result_guard: true });
      assert.equal(refused.isError, true);
      assert.match(refused.error!, /^\[budget-preflight\] contextBudgetTokens=260000 would NOT fit/);
      assert.match(refused.error!, / Nothing in this call was changed\.$/);
      const now = settings(call);
      assert.equal(now.tool_result_guard, false);
      assert.equal(now.contextBudgetTokens, 550_000);
    });
  });

  it('a module extension that checks ahead refuses before the core applies', async () => {
    const module = new SettingModule('zz-ahead', 'zz_ahead', true);
    await withFramework({ modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, zz_ahead: 'zz-bad' });
      assert.equal(refused.error, 'zz_ahead refused zz-bad Nothing in this call was changed.');
      assert.equal(settings(call).tailTokens, 30_000);
      assert.equal(module.value, 'zz-initial');
    });
  });

  it('a module extension that can\'t check ahead is applied first, so its refusal leaves the rest unapplied', async () => {
    const module = new SettingModule('zz-late', 'zz_late', false);
    await withFramework({ modules: [module] }, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, tool_result_guard: true, zz_late: 'zz-bad' });
      assert.equal(refused.error, 'zz_late refused zz-bad Nothing in this call was changed.');
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
      assert.equal(refused.error, 'zz_second refused zz-bad Changed before the refusal: zz_first; nothing else in this call was.');
      assert.equal(first.value, 'zz-good');
      assert.equal(second.value, 'zz-initial');
      assert.equal(settings(call).tailTokens, 30_000);
    });
  });

  it('a name that is no setting is refused, with nothing applied', async () => {
    await withFramework({}, (_framework, call) => {
      const refused = call({ action: 'update', tail_tokens: 20_000, tail_token: 5_000 });
      assert.equal(refused.error, 'Unknown setting: tail_token Nothing in this call was changed.');
      assert.equal(settings(call).tailTokens, 30_000);
      const two = call({ action: 'update', zz_one: 1, zz_two: 2 });
      assert.equal(two.error, 'Unknown settings: zz_one, zz_two Nothing in this call was changed.');
    });
  });

  it('a reset the core refuses leaves the extensions\' settings as they were', async () => {
    await withFramework({ strategy: false }, (framework, call) => {
      assert.equal(call({ action: 'update', tool_result_inline_max_chars: 5_000 }).isError, undefined);
      // A raised budget, so a reset-all returns to a smaller configured one.
      framework.updateAgentRuntimeSettings('agent', { contextBudgetTokens: 150_000 });
      const refused = call({ action: 'reset' });
      assert.equal(refused.isError, true);
      assert.equal(refused.error, 'The active context strategy cannot prepare a smaller window live Nothing in this call was changed.');
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
});
