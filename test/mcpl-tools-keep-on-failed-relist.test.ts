/**
 * A server that fails tools/list during a re-list (every reconnect re-lists
 * ALL servers) keeps its known tools instead of vanishing from the list: a
 * vanishing tool changes the top of every request (full prompt-cache
 * rewrite, twice) and hides the tools unannounced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

type Internals = {
  mcplServerRegistry: unknown;
  mcplTools: Array<{ name: string }>;
  refreshMcplTools(): Promise<void>;
};

test('a failed re-list keeps that server\'s known tools; others refresh normally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-keep-'));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }], modules: [],
  });
  try {
    const state = { aTools: ['send'], bFails: false };
    const server = (id: string, list: () => string[]) => ({
      id,
      sendToolsList: async () => {
        if (id === 'b' && state.bFails) throw new Error('connection to "b" is closed');
        return { tools: list().map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) };
      },
    });
    const servers = [server('a', () => state.aTools), server('b', () => ['read', 'write']), server('never', () => { throw new Error('no'); })];
    const internals = fw as unknown as Internals;
    internals.mcplServerRegistry = { getAllServers: () => servers, closeAll: async () => {} };
    const names = () => internals.mcplTools.map((t) => t.name).sort();

    await internals.refreshMcplTools();
    assert.deepEqual(names(), ['mcpl--a--send', 'mcpl--b--read', 'mcpl--b--write']);

    state.bFails = true;
    state.aTools = ['send', 'react'];
    await internals.refreshMcplTools();
    assert.deepEqual(names(), ['mcpl--a--react', 'mcpl--a--send', 'mcpl--b--read', 'mcpl--b--write'],
      'b keeps its tools; a picks up its new one');

    state.bFails = false;
    await internals.refreshMcplTools();
    assert.equal(internals.mcplTools.filter((t) => t.name.startsWith('mcpl--b--')).length, 2);
  } finally {
    await fw.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
