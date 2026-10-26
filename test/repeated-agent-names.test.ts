/**
 * An agent's name keys it in the framework's registry, so create() refuses a
 * config that gives two of its agents one name. Before, the later agent
 * silently took the earlier one's place, though AgentConfig.name says "Unique
 * name for this agent". Names compare exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsStore } from '@animalabs/chronicle';

import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const agent = (name: string, systemPrompt = name) => ({ name, model: 'test-model', systemPrompt });

const createWith = (storePath: string, agents: ReturnType<typeof agent>[]) =>
  AgentFramework.create({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents,
    modules: [],
    syncIntervalMs: 0,
  });

const RENAME = 'Each configured agent needs a name of its own: keep one agent of each name, and rename or remove the others. ' +
  'An agent that keeps its name keeps its context log and runtime settings, and one you rename starts both afresh.';

/** What create() settled with: the error it rejected with, or else the
 *  framework, which is stopped here, so a create() that wrongly resolves
 *  leaves nothing running and holding the store. */
async function refusal(created: Promise<AgentFramework>): Promise<Error> {
  let framework: AgentFramework;
  try {
    framework = await created;
  } catch (error) {
    return error as Error;
  }
  await framework.stop();
  assert.fail('create() resolved');
}

/** create() refuses the agents with exactly this message, before anything
 *  opens: no store is left at storePath. */
async function assertRefused(agents: ReturnType<typeof agent>[], message: string): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'repeated-agent-names-'));
  const storePath = join(tempDir, 'store.chronicle');
  try {
    assert.equal((await refusal(createWith(storePath, agents))).message, message);
    assert.equal(existsSync(storePath), false, 'the refused config opened no store');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('create() and repeated agent names', () => {
  it('refuses two agents of one name, naming the name and both places', async () => {
    await assertRefused([agent('dup', 'first'), agent('other'), agent('dup', 'second')],
      `agents[0] and agents[2] are both named "dup". ${RENAME}`);
  });

  it('names every place a name repeats at', async () => {
    await assertRefused([agent('x', '1'), agent('x', '2'), agent('x', '3')],
      `agents[0], agents[1] and agents[2] are all named "x". ${RENAME}`);
  });

  it('names every repeated name, in the order each first appears', async () => {
    await assertRefused([agent('b'), agent('a'), agent('a'), agent('b')],
      `agents[0] and agents[3] are both named "b". agents[1] and agents[2] are both named "a". ${RENAME}`);
  });

  it('refuses with a store the caller owns too, and leaves that store open', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repeated-agent-names-'));
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store.chronicle') });
    try {
      const created = AgentFramework.create({
        store,
        membrane: new MockMembrane().asMembrane(),
        agents: [agent('dup', 'first'), agent('dup', 'second')],
        modules: [],
        syncIntervalMs: 0,
      });
      assert.equal((await refusal(created)).message, `agents[0] and agents[1] are both named "dup". ${RENAME}`);
      assert.equal(store.isClosed(), false, "create() leaves the caller's store open");
    } finally {
      if (!store.isClosed()) store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reads a name that is not a string as its text, as a YAML config can give one', async () => {
    await assertRefused([agent(7 as unknown as string, 'number'), agent('7', 'text')],
      `agents[0] and agents[1] are both named 7. ${RENAME}`);
  });

  it('starts dup beside Dup, and keeps their stored state apart across a restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repeated-agent-names-'));
    const storePath = join(tempDir, 'store.chronicle');
    const agents = [agent('dup', 'first'), agent('Dup', 'second')];
    try {
      let framework = await createWith(storePath, agents);
      try {
        assert.equal(framework.getAgent('dup')?.systemPrompt, 'first');
        assert.equal(framework.getAgent('Dup')?.systemPrompt, 'second');
        framework.updateAgentRuntimeSettings('dup', { sameRoundThinkTextPolicy: 'private' });
      } finally {
        await framework.stop();
      }
      framework = await createWith(storePath, agents);
      try {
        assert.equal(framework.getAgentRuntimeSettings('dup').sameRoundThinkTextPolicy, 'private');
        assert.equal(framework.getAgentRuntimeSettings('Dup').sameRoundThinkTextPolicy, 'public');
        const store = (framework as unknown as { store: JsStore }).store;
        const contextLogs = store.listStates()
          .map((state) => state.id)
          .filter((id) => /^agents\/dup\/context$/i.test(id))
          .sort();
        assert.deepEqual(contextLogs, ['agents/Dup/context', 'agents/dup/context'], 'each agent keeps a context log of its own');
      } finally {
        await framework.stop();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts every agent when the names differ otherwise, with nothing trimmed', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repeated-agent-names-'));
    try {
      const framework = await createWith(join(tempDir, 'store.chronicle'), [agent('dup', 'first'), agent('dup ', 'second')]);
      try {
        assert.equal(framework.getAgent('dup')?.systemPrompt, 'first');
        assert.equal(framework.getAgent('dup ')?.systemPrompt, 'second');
      } finally {
        await framework.stop();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
