/**
 * A persisted reader (`subconscious.persist`, design note §3 option C): with
 * reader forks, `'epoch'` or `'resident'` makes the reader one derived
 * identity. Its first look in the scope derives it as a fork is derived; each
 * later look resumes it (a new incarnation on its own branch) and hands it
 * what the resident's window took since its last look, as framing. Left out,
 * or `'look'`, each look derives a fork of its own, as before.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('a persisted reader: configuration', () => {
  const create = async (subconscious: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-persist-cfg-'));
    dirs.push(dir);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'x' }],
      subconscious: { enabled: true, reader: 'forks', model: 'test-model', voice: 'read', ...subconscious } as never,
      modules: [],
    });
    frameworks.push(framework);
    return framework;
  };

  it('takes each persist and resync mode, and a pendingRound object or function', async () => {
    for (const persist of ['look', 'epoch', 'resident']) await create({ persist });
    for (const resync of ['window', 'none']) await create({ persist: 'epoch', resync });
    await create({ pendingRound: { include: false } });
    await create({ pendingRound: () => ({ madeBy: { result: 'host text' } }) });
  });

  it('refuses a persist, resync or pendingRound it has no mode for', async () => {
    await assert.rejects(create({ persist: 'forever' }), /subconscious\.persist must be 'look', 'epoch' or 'resident', not another string/);
    await assert.rejects(create({ persist: 'epoch', resync: 'all' }), /subconscious\.resync must be 'window' or 'none', not another string/);
    await assert.rejects(create({ pendingRound: 'none' }), /subconscious\.pendingRound must be an object, as deriveAgent's pendingRound takes it, or a function/);
    await assert.rejects(create({ pendingRound: [] }), /subconscious\.pendingRound must be an object/);
  });
});
