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
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'assistant', model: 'model-a', systemPrompt: 'test', maxTokens: 4_000, ...resident }],
    modules: [],
    subconscious: { enabled: true, systemPrompt: 'notice', ...subconscious },
  });
  return framework;
}

/** What an agent was built with, for the two fields: the window is public, and
 *  the binding is read by the agent into its drop-control flag. */
function fieldsOf(framework: AgentFramework, name: string) {
  const agent = framework.getAgent(name)! as unknown as { physicalWindowTokens?: number; thinkingDropBlock: boolean; model: string };
  return { model: agent.model, physicalWindowTokens: agent.physicalWindowTokens, thinkingDropBlock: agent.thinkingDropBlock };
}

describe('the subconscious and the resident\'s model fields', () => {
  const resident: Partial<AgentConfig> = { physicalWindowTokens: 1_000_000, thinkingBinding: { dropBlock: true } };

  it('on another model, it carries neither the resident\'s window nor its binding', async () => {
    const framework = await withSubconscious(resident, { model: 'model-b' });
    try {
      assert.deepEqual(fieldsOf(framework, 'assistant'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingDropBlock: true });
      assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-b', physicalWindowTokens: undefined, thinkingDropBlock: false });
      // The resident's own config is left as it was.
      assert.equal(framework.getAgent('assistant')!.physicalWindowTokens, 1_000_000);
    } finally { await framework.stop(); }
  });

  it('on the resident\'s model, named or by default, it carries both, as every other inference setting', async () => {
    for (const subconscious of [{}, { model: 'model-a' }]) {
      const framework = await withSubconscious(resident, subconscious);
      try {
        assert.deepEqual(fieldsOf(framework, 'Subconscious'), { model: 'model-a', physicalWindowTokens: 1_000_000, thinkingDropBlock: true });
      } finally { await framework.stop(); }
    }
  });

  it('on another model, it still carries the inference settings that aren\'t the model\'s', async () => {
    const framework = await withSubconscious({ ...resident, maxTokens: 1_234 }, { model: 'model-b' });
    try {
      assert.equal(framework.getAgent('Subconscious')!.maxTokens, 1_234);
    } finally { await framework.stop(); }
  });
});
