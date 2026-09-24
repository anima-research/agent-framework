import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, ApiModule } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/**
 * The subconscious terminates with its resident.
 *
 * createSubconsciousAgent registers a second Agent (default name
 * `Subconscious`) built from the primary's inference config, reading the
 * resident's shared message slot. By the retirement doctrine's own line —
 * forks are "persistent, addressable continuations of one configured
 * template identity" and "terminate with that template" — the subconscious
 * is on the fork side: a same-model side-process serving one resident.
 * retireResident seals the primary and terminates its forks; this pins that
 * the side-process is sealed with them, so no inference runs in the retired
 * resident's name afterwards, from any wake path (the tune-out coordinator's
 * pushes in production; an operator nudge here, which reaches the same
 * scheduler).
 */
async function waitFor(cond: () => boolean, ms = 1500): Promise<boolean> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) return false; await new Promise((r) => setTimeout(r, 10)); }
  return true;
}

describe('retirement seals the subconscious with the resident', () => {
  it('after retireResident, a wake of the subconscious starts no inference', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'retire-sub-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Nothing to report.' }]));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'test', retirement: { enabled: true } }],
      subconscious: { enabled: true, systemPrompt: 'You are the Subconscious. Report to the resident in second person.' },
      modules: [new ApiModule()],
      gate: { config: { policies: [], default: 'always' } },
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    try {
      framework.start();
      assert.ok(framework.getAgent('Subconscious'), 'the subconscious is registered beside the resident');

      framework.retireResident('resident', 'seals the side-process too');
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');

      const before = membrane.calls.length;
      const nudge = framework.nudgeAgent('Subconscious', 'operator');
      const inferred = await waitFor(() => membrane.calls.length > before);
      assert.ok(!nudge.ok || !inferred,
        `the retired resident's subconscious still infers: nudge=${JSON.stringify(nudge)}, membrane calls ${before} → ${membrane.calls.length}`);
      assert.equal(membrane.calls.length, before, 'no inference ran in the retired resident\'s name');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
