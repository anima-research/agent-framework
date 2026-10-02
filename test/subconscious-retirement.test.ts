import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, ApiModule } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import type { FrameworkConfig } from '../src/index.js';

/**
 * The subconscious terminates with its resident.
 *
 * createSubconsciousAgent registers a second Agent (default name
 * `Subconscious`) built from the primary's inference config, reading the
 * resident's shared message slot. By the retirement doctrine's own line —
 * forks are "persistent, addressable continuations of one configured
 * template identity" and "terminate with that template" — the subconscious
 * is on the fork side: a same-model side-process serving one resident.
 * retireResident seals the primary and terminates its forks; these pin that
 * the side-process is sealed with them, so no inference runs in the retired
 * resident's name afterwards, from any wake path (the tune-out coordinator's
 * pushes in production; an operator nudge here, which reaches the same
 * scheduler) — in this process, and again after a restart against the same
 * store.
 */
async function waitFor(cond: () => boolean, ms = 300): Promise<boolean> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) return false; await new Promise((r) => setTimeout(r, 10)); }
  return true;
}

function config(
  tempDir: string,
  membrane: MockMembrane,
  agents: FrameworkConfig['agents'],
): FrameworkConfig {
  return {
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents,
    subconscious: { enabled: true, systemPrompt: 'You are the Subconscious. Report to the resident in second person.' },
    modules: [new ApiModule()],
    gate: { config: { policies: [], default: 'always' } },
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  };
}

const resident = { name: 'resident', model: 'test-model', systemPrompt: 'test', retirement: { enabled: true } };

describe('retirement seals the subconscious with the resident', () => {
  it('after retireResident, a wake of the subconscious starts no inference', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'retire-sub-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Nothing to report.' }]));
    const framework = await AgentFramework.create(config(tempDir, membrane, [resident]));
    try {
      framework.start();
      assert.ok(framework.getAgent('Subconscious'), 'the subconscious is registered beside the resident');

      framework.retireResident('resident', 'seals the side-process too');
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      assert.equal(framework.getAgent('Subconscious'), null, 'the side-process is unregistered with its resident');

      const before = membrane.calls.length;
      const nudge = framework.nudgeAgent('Subconscious', 'operator');
      assert.equal(nudge.ok, false);
      assert.match(nudge.error ?? '', /terminated when its template resident retired/);
      const inferred = await waitFor(() => membrane.calls.length > before);
      assert.ok(!inferred, `the retired resident's subconscious still infers: membrane calls ${before} → ${membrane.calls.length}`);
      assert.equal(membrane.calls.length, before, 'no inference ran in the retired resident\'s name');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a restart against a sealed primary creates no subconscious', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'retire-sub-boot-'));
    const first = new MockMembrane();
    let framework = await AgentFramework.create(config(tempDir, first, [resident]));
    try {
      framework.start();
      framework.retireResident('resident', 'sealed before the restart');
      await framework.stop();

      const second = new MockMembrane();
      second.pushResponse(createMockResponse([{ type: 'text', text: 'Nothing to report.' }]));
      framework = await AgentFramework.create(config(tempDir, second, [resident]));
      assert.equal(framework.getResidentLifecycleStatus('resident').status, 'retired');
      assert.equal(framework.getAgent('Subconscious'), null, 'no side-process is re-created for a sealed primary');
      framework.start();

      const nudge = framework.nudgeAgent('Subconscious', 'operator');
      assert.equal(nudge.ok, false);
      assert.match(nudge.error ?? '', /terminated when its template resident retired/);
      const inferred = await waitFor(() => second.calls.length > 0);
      assert.ok(!inferred, `a subconscious inferred after the restart: ${second.calls.length} membrane call(s)`);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retiring a resident the subconscious does not attend leaves it alive', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'retire-sub-other-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Nothing to report.' }]));
    const other = { name: 'other', model: 'test-model', systemPrompt: 'test', retirement: { enabled: true } };
    // The subconscious attends the primary: the first configured resident.
    const framework = await AgentFramework.create(config(tempDir, membrane, [resident, other]));
    try {
      framework.start();
      framework.retireResident('other', 'not the primary');
      assert.ok(framework.getAgent('Subconscious'), 'the primary\'s side-process is untouched');
      assert.equal(framework.nudgeAgent('Subconscious', 'operator').ok, true);
      assert.ok(await waitFor(() => membrane.calls.length > 0, 1500), 'the surviving subconscious still infers');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
