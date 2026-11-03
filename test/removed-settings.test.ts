/**
 * `processLogging.broadcast` and an agent's `refusalHandling.announceHumanTurns`
 * are removed, since neither had an effect in any release. A config that still
 * sets either starts as before, with the setting ignored, and the types no
 * longer have them, so a typed config that writes one in an object literal
 * checked against them doesn't compile.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework, type AgentConfig, type ProcessLoggingConfig } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

// Compiled, never run: each line fails the build if its key comes back to the
// type, with any type.
const broadcastIsGone: 'broadcast' extends keyof ProcessLoggingConfig ? never : true = true;
const announceHumanTurnsIsGone:
  'announceHumanTurns' extends keyof NonNullable<AgentConfig['refusalHandling']> ? never : true = true;
void broadcastIsGone;
void announceHumanTurnsIsGone;

it('a config that still sets processLogging.broadcast or refusalHandling.announceHumanTurns starts, and isProcessLoggingEnabled() reports only persist', async () => {
  for (const persist of [false, true]) {
    const tempDir = mkdtempSync(join(tmpdir(), 'removed-settings-'));
    let framework: AgentFramework | undefined;
    try {
      // Untyped, as a JSON config or a host passing its own config on gives it.
      framework = await AgentFramework.create({
        storePath: join(tempDir, 'store.chronicle'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{
          name: 'agent',
          model: 'test-model',
          systemPrompt: 'test',
          refusalHandling: { autoRewind: false, announceHumanTurns: !persist },
        }],
        modules: [],
        syncIntervalMs: 0,
        processLogging: { persist, broadcast: !persist },
      } as never);
      assert.ok(framework.getAgent('agent'));
      assert.deepEqual(framework.isProcessLoggingEnabled(), { persist });
    } finally {
      await framework?.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
