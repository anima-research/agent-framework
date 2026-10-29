import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    // On this branch SubconsciousConfig is a union by `reader`; the persistent
    // reader is the one that is an agent at create, named 'Subconscious' by
    // default and on the primary's model unless told otherwise, as main's is.
    subconscious: { reader: 'persistent', enabled: true, systemPrompt: 'notice', ...subconscious } as SubconsciousConfig,
  });
  return { framework, residentConfig };
}

function fieldsOf(framework: AgentFramework, name: string) {
  const agent = framework.getAgent(name)! as unknown as { physicalWindowTokens?: number; thinkingBinds: boolean; thinkingDropBlock: boolean; model: string };
  return { model: agent.model, physicalWindowTokens: agent.physicalWindowTokens, thinkingBinds: agent.thinkingBinds, thinkingDropBlock: agent.thinkingDropBlock };
}

function storedConfig(framework: AgentFramework, name: string): AgentConfig | undefined {
  return (framework as unknown as { agentConfigs: Map<string, AgentConfig> }).agentConfigs.get(name);
}

describe('the subconscious and the resident\'s model fields', () => {
  const resident: Partial<AgentConfig> = { physicalWindowTokens: 1_000_000, thinkingBinding: { binds: true, dropBlock: true } };

  it('on another model, it carries neither the resident\'s window nor its binding, and the resident\'s config keeps both', async () => {
    const { framework, residentConfig } = await withSubconscious(resident, { model: 'model-b' });
    try {
      assert.deepEqual(fieldsOf(framework, 'assistant'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingBinds: true, thinkingDropBlock: true });
      assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-b', physicalWindowTokens: undefined, thinkingBinds: false, thinkingDropBlock: false });
      for (const config of [storedConfig(framework, 'assistant'), residentConfig]) {
        assert.equal(config?.physicalWindowTokens, 1_000_000);
        assert.deepEqual(config?.thinkingBinding, { binds: true, dropBlock: true });
      }
    } finally { await framework.stop(); }
  });

  it('on the resident\'s model, named or by default, it carries both', async () => {
    for (const subconscious of [{}, { model: 'model-a' }]) {
      const { framework } = await withSubconscious(resident, subconscious);
      try {
        assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingBinds: true, thinkingDropBlock: true });
      } finally { await framework.stop(); }
    }
  });

  it('on another model, it carries the window and binding set for it, and the resident\'s config keeps its own', async () => {
    const { framework, residentConfig } = await withSubconscious(resident, {
      model: 'model-b', physicalWindowTokens: 200_000, thinkingBinding: { binds: true, dropBlock: true },
    });
    try {
      assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-b', physicalWindowTokens: 200_000, thinkingBinds: true, thinkingDropBlock: true });
      assert.deepEqual(fieldsOf(framework, 'assistant'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingBinds: true, thinkingDropBlock: true });
      for (const config of [storedConfig(framework, 'assistant'), residentConfig]) {
        assert.equal(config?.physicalWindowTokens, 1_000_000);
        assert.deepEqual(config?.thinkingBinding, { binds: true, dropBlock: true });
      }
    } finally { await framework.stop(); }
  });

  it('on the resident\'s model, each of the two set for it takes the place of the resident\'s, and null or false leaves it out', async () => {
    const cases: Array<[Record<string, unknown>, ReturnType<typeof fieldsOf>]> = [
      [{ physicalWindowTokens: 500_000 }, { model: 'model-a', physicalWindowTokens: 500_000, thinkingBinds: true, thinkingDropBlock: true }],
      [{ thinkingBinding: { binds: false } }, { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingBinds: false, thinkingDropBlock: false }],
      [{ physicalWindowTokens: null, thinkingBinding: null }, { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingBinds: true, thinkingDropBlock: true }],
      [{ thinkingBinding: false }, { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingBinds: true, thinkingDropBlock: true }],
    ];
    for (const [subconscious, expected] of cases) {
      const { framework, residentConfig } = await withSubconscious(resident, subconscious as Partial<SubconsciousConfig>);
      try {
        assert.deepEqual(fieldsOf(framework, 'Subconscious'), expected, JSON.stringify(subconscious));
        for (const config of [storedConfig(framework, 'assistant'), residentConfig]) {
          assert.equal(config?.physicalWindowTokens, 1_000_000);
          assert.deepEqual(config?.thinkingBinding, { binds: true, dropBlock: true });
        }
      } finally { await framework.stop(); }
    }
  });

  it('an enabled subconscious\'s thinkingBinding that isn\'t an object or holds a switch that isn\'t true or false is refused before anything opens, and a disabled one\'s is left unchecked', async () => {
    for (const thinkingBinding of ['yes', { binds: 'true' }, { binds: true, dropBlock: 'true' }]) {
      const dir = mkdtempSync(join(tmpdir(), 'subconscious-model-fields-'));
      dirs.push(dir);
      await assert.rejects(
        AgentFramework.create({
          storePath: join(dir, 'store'),
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'assistant', model: 'model-a', systemPrompt: 'test', maxTokens: 4_000 }],
          modules: [],
          subconscious: { enabled: true, systemPrompt: 'notice', thinkingBinding } as unknown as SubconsciousConfig,
        }),
        /subconscious\.thinkingBinding/,
      );
      assert.deepEqual(readdirSync(dir), [], JSON.stringify(thinkingBinding));
    }
    const { framework } = await withSubconscious({}, { enabled: false, thinkingBinding: 'yes' } as unknown as Partial<SubconsciousConfig>);
    await framework.stop();
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
      const own = ['physicalWindowTokens', 'thinkingBinding', 'name', 'model', 'systemPrompt', 'strategy', 'proseRouting', 'allowedTools', 'clock'];
      const rest = (config: AgentConfig | undefined) =>
        Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => !own.includes(key)));
      const inherited = rest(storedConfig(framework, 'Subconscious'));
      assert.deepEqual(inherited, rest(storedConfig(framework, 'assistant')));
      for (const key of Object.keys(settings)) assert.ok(key in inherited, key);
    } finally { await framework.stop(); }
  });
});
