/**
 * `AgentConfig.observes` (the audit of #291's mind-neutrality, D2): residents
 * share one slot, and each is shown only its own rows and the rows meant for
 * it (decision 1), and seeing another agent's thread is a declared
 * relationship, but a resident had no way to declare one. `observes` names
 * the configured agents whose own rows its window takes: an observe edge on
 * each in its registry record, which the presentation index reads
 * (bearingOf) and the history tools ask (ModuleContext.observes). One way,
 * none by default. The rounds it is shown go out in its requests as a
 * transcript by default, as the persistent subconscious's do.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { AgentConfig } from '../src/index.js';
import { storeOwnRow } from '../src/dendrite/audience.js';
import { WireMembrane } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;

type Internals = { observesOwnRowsOf(observer: string, observed: string): boolean; pendingRequests: unknown[] };

async function withResidents(
  agents: Array<Partial<AgentConfig> & { name: string }>,
  run: (framework: AgentFramework, membrane: WireMembrane) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'resident-observes-'));
  const membrane = new WireMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: agents.map((a) => ({ model: 'test-model', systemPrompt: `You are ${a.name}.`, ...a })),
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  try {
    await framework.start();
    await run(framework, membrane);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Store a round of each resident's own, and say which window holds which. */
function crossWindows(framework: AgentFramework) {
  const mira = framework.getAgent('mira')!;
  const nova = framework.getAgent('nova')!;
  const miraRow = storeOwnRow(mira, 'mira', [text('mira thinks aloud')]);
  const novaRow = storeOwnRow(nova, 'nova', [text('nova thinks aloud')]);
  const holds = (agent: typeof mira, id: string) => agent.getContextManager().ordinalOf(id) !== undefined;
  return {
    miraHoldsOwn: holds(mira, miraRow),
    novaHoldsOwn: holds(nova, novaRow),
    miraHoldsNova: holds(mira, novaRow),
    novaHoldsMira: holds(nova, miraRow),
  };
}

describe('AgentConfig.observes', () => {
  it("with observes: ['nova'], mira's window takes nova's own rows and nova's doesn't take mira's", { timeout: 120_000 }, async () => {
    // mira is declared first, so her edge names nova before nova is registered.
    await withResidents([{ name: 'mira', observes: ['nova'] }, { name: 'nova' }], async (framework) => {
      const seen = crossWindows(framework);
      assert.equal(seen.miraHoldsOwn && seen.novaHoldsOwn, true, 'premise: each window holds its own row');
      assert.equal(seen.miraHoldsNova, true, "mira's window takes nova's own row");
      assert.equal(seen.novaHoldsMira, false, "nova's doesn't take mira's: the edge is one way");
      const internals = framework as unknown as Internals;
      assert.equal(internals.observesOwnRowsOf('mira', 'nova'), true, 'the history tools are told mira observes nova');
      assert.equal(internals.observesOwnRowsOf('nova', 'mira'), false, 'and not the other way');
      const edges = framework.getAgentRecord('mira')?.relationships.observes;
      assert.deepEqual(edges, [{ agent: 'nova' }], "the edge is in mira's registry record");
    });
  });

  it("without it, neither window takes the other's own rows", { timeout: 120_000 }, async () => {
    await withResidents([{ name: 'mira' }, { name: 'nova' }], async (framework) => {
      const seen = crossWindows(framework);
      assert.equal(seen.miraHoldsOwn && seen.novaHoldsOwn, true, 'premise: each window holds its own row');
      assert.equal(seen.miraHoldsNova, false);
      assert.equal(seen.novaHoldsMira, false);
      assert.equal((framework as unknown as Internals).observesOwnRowsOf('mira', 'nova'), false);
      assert.deepEqual(framework.getAgentRecord('mira')?.relationships.observes, []);
    });
  });

  it("only the named agent's: a third resident's own rows stay out of the observer's window", { timeout: 120_000 }, async () => {
    await withResidents([{ name: 'mira', observes: ['nova'] }, { name: 'nova' }, { name: 'kai' }], async (framework) => {
      const kai = framework.getAgent('kai')!;
      const kaiRow = storeOwnRow(kai, 'kai', [text('kai thinks aloud')]);
      assert.equal(kai.getContextManager().ordinalOf(kaiRow) !== undefined, true, 'premise: kai holds it');
      assert.equal(framework.getAgent('mira')!.getContextManager().ordinalOf(kaiRow), undefined, "mira's window doesn't take kai's row");
      assert.equal((framework as unknown as Internals).observesOwnRowsOf('mira', 'kai'), false);
    });
  });

  it("sends the observed agent's rounds as a transcript by default, and as stored with foreignRounds 'raw'", { timeout: 120_000 }, async () => {
    for (const foreignRounds of [undefined, 'raw'] as const) {
      await withResidents([{ name: 'mira', observes: ['nova'], foreignRounds }, { name: 'nova' }], async (framework, membrane) => {
        const stored = [
          { type: 'thinking', thinking: 'mulling', signature: 'sig-nova' } as ContentBlock,
          text('Looking it up.'),
          { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'build status' } } as ContentBlock,
        ];
        storeOwnRow(framework.getAgent('nova')!, 'nova', stored);
        (framework as unknown as Internals).pendingRequests.push({ agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now() });
        await framework.runUntilIdle();
        const request = membrane.callsFor('mira').at(-1);
        assert.ok(request, "premise: mira's request");
        const round = request.messages.find((m) => m.participant === 'nova');
        assert.ok(round, `${String(foreignRounds)}: nova's round is in mira's request: ${JSON.stringify(request.messages)}`);
        if (foreignRounds === 'raw') {
          assert.deepEqual(round.content, stored, 'as stored');
        } else {
          assert.deepEqual(round.content, [text('Looking it up.'), text('[search called: {"q":"build status"}]')], 'a transcript');
          assert.ok(!JSON.stringify(request.messages).includes('sig-nova'), "none of nova's thinking");
        }
      });
    }
  });

  it('create refuses an agent that observes itself, or a name no configured agent has', async () => {
    const refused = (agents: Array<Partial<AgentConfig> & { name: string }>) => AgentFramework.create({
      agents: agents.map((a) => ({ model: 'test-model', systemPrompt: 'x', ...a })),
      membrane: new WireMembrane().asMembrane(),
      modules: [],
    } as never);
    await assert.rejects(refused([{ name: 'mira', observes: ['mira'] }]), /^Error: Agent "mira" observes itself/);
    await assert.rejects(refused([{ name: 'mira', observes: ['nvoa'] }, { name: 'nova' }]), /Agent "mira" observes "nvoa", which is no configured agent's name/);
    await assert.rejects(refused([{ name: 'mira', observes: 'nova' as never }]), /Agent "mira" observes must be a list of agent names/);
    await assert.rejects(refused([{ name: 'mira', foreignRounds: 'Raw' as never }]), /Agent "mira" foreignRounds must be 'transcript' or 'raw', not another string/);
  });

  it("hands an observer the rows the observed agent stored before the edge at its next point, after what its window holds", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-observes-later-'));
    const boot = (observes?: string[]) => AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: new WireMembrane().asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', ...(observes ? { observes } : {}) }, { name: 'nova', model: 'test-model', systemPrompt: 'You are nova.' }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    try {
      const before = await boot();
      await before.start();
      const earlier = storeOwnRow(before.getAgent('nova')!, 'nova', [text('before the edge')]);
      storeOwnRow(before.getAgent('mira')!, 'mira', [text('mira, later')]);
      assert.equal(before.getAgent('mira')!.getContextManager().ordinalOf(earlier), undefined, 'premise: not in her window without the edge');
      await before.stop();
      const after = await boot(['nova']);
      await after.start();
      try {
        const window = after.getAgent('mira')!.getContextManager().getPresentedMessages().map((m) => `${m.participant}: ${(m.content[0] as { text: string }).text}`);
        assert.deepEqual(window, ['mira: mira, later', 'nova: before the edge'], "nova's earlier row enters, after mira's later one");
      } finally {
        await after.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('admits two residents that observe each other', { timeout: 120_000 }, async () => {
    await withResidents([{ name: 'mira', observes: ['nova'] }, { name: 'nova', observes: ['mira'] }], async (framework) => {
      const seen = crossWindows(framework);
      assert.equal(seen.miraHoldsNova, true);
      assert.equal(seen.novaHoldsMira, true);
    });
  });
});
