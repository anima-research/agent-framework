/**
 * The subconscious inherits the resident's inference settings, but on another
 * model not the fields that describe the resident's model
 * (SUBCONSCIOUS_MODEL_FIELDS): its window and whether its thinking binds.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentFramework } from '../src/index.js';
import type { AgentConfig } from '../src/index.js';
import type { SubconsciousConfig } from '../src/tune-out/tools.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

async function withSubconscious(resident: Partial<AgentConfig>, subconscious: Partial<SubconsciousConfig>) {
  const dir = mkdtempSync(join(tmpdir(), 'subconscious-model-fields-'));
  dirs.push(dir);
  const residentConfig: AgentConfig = { name: 'assistant', model: 'model-a', systemPrompt: 'test', maxTokens: 4_000, ...resident };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [residentConfig],
    modules: [],
    subconscious: { enabled: true, systemPrompt: 'notice', ...subconscious },
  });
  return { framework, residentConfig };
}

/** What an agent was built with, for the two fields: the window is public, and
 *  the binding is read by the agent into its drop-control flag. */
function fieldsOf(framework: AgentFramework, name: string) {
  const agent = framework.getAgent(name)! as unknown as { physicalWindowTokens?: number; thinkingDropBlock: boolean; model: string };
  return { model: agent.model, physicalWindowTokens: agent.physicalWindowTokens, thinkingDropBlock: agent.thinkingDropBlock };
}

/** The resident's config as the framework keeps it, which the subconscious's
 *  copy and conversation forks are made from. */
function storedConfig(framework: AgentFramework, name: string): AgentConfig | undefined {
  return (framework as unknown as { agentConfigs: Map<string, AgentConfig> }).agentConfigs.get(name);
}

describe('the subconscious and the resident\'s model fields', () => {
  const resident: Partial<AgentConfig> = { physicalWindowTokens: 1_000_000, thinkingBinding: { dropBlock: true } };

  it('on another model, it carries neither the resident\'s window nor its binding, and the resident\'s config keeps both', async () => {
    const { framework, residentConfig } = await withSubconscious(resident, { model: 'model-b' });
    try {
      assert.deepEqual(fieldsOf(framework, 'assistant'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingDropBlock: true });
      assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-b', physicalWindowTokens: undefined, thinkingDropBlock: false });
      // The copy is the subconscious's own: the config the framework keeps
      // for the resident, and the one its host passed, still hold both.
      for (const config of [storedConfig(framework, 'assistant'), residentConfig]) {
        assert.equal(config?.physicalWindowTokens, 1_000_000);
        assert.deepEqual(config?.thinkingBinding, { dropBlock: true });
      }
    } finally { await framework.stop(); }
  });

  it('on the resident\'s model, named or by default, it carries both', async () => {
    for (const subconscious of [{}, { model: 'model-a' }]) {
      const { framework } = await withSubconscious(resident, subconscious);
      try {
        assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingDropBlock: true });
      } finally { await framework.stop(); }
    }
  });

  it('on another model, it still carries every other field of the resident\'s config that the copy doesn\'t override', async () => {
    const settings = {
      thinking: { enabled: true, budgetTokens: 2_048 },
      maxTokens: 1_234,
      temperature: 0.3,
      contextBudgetTokens: 90_000,
      maxStreamTokens: 123_000,
      promptCaching: false,
      cacheTtl: '1h',
      providerParams: { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } },
      toolResultGuard: true,
    } satisfies Partial<AgentConfig>;
    const { framework } = await withSubconscious({ ...resident, ...settings }, { model: 'model-b' });
    try {
      const agent = framework.getAgent('Subconscious')!;
      assert.deepEqual(
        {
          thinking: agent.thinking,
          maxTokens: agent.maxTokens,
          contextBudgetTokens: agent.contextBudgetTokens,
          maxStreamTokens: agent.maxStreamTokens,
          promptCaching: agent.promptCaching,
        },
        {
          thinking: settings.thinking,
          maxTokens: settings.maxTokens,
          contextBudgetTokens: settings.contextBudgetTokens,
          maxStreamTokens: settings.maxStreamTokens,
          promptCaching: settings.promptCaching,
        },
      );
      // Every field, as the configs are kept: the subconscious's is the
      // resident's less the two model fields and what the copy sets itself.
      const own = ['physicalWindowTokens', 'thinkingBinding', 'name', 'model', 'systemPrompt', 'strategy', 'proseRouting', 'allowedTools', 'clock'];
      const rest = (config: AgentConfig | undefined) =>
        Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => !own.includes(key)));
      const inherited = rest(storedConfig(framework, 'Subconscious'));
      assert.deepEqual(inherited, rest(storedConfig(framework, 'assistant')));
      for (const key of Object.keys(settings)) assert.ok(key in inherited, key);
    } finally { await framework.stop(); }
  });
});
