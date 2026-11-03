/**
 * A maintenance call withdrawn partway through context-manager's compression
 * fallback ladder is a withdrawal, not a failure (agent-framework#549).
 *
 * context-manager 0.16.0 rethrows an error branded as its CompressionWithdrawn
 * from every rung of the ladder, recording nothing, and records anything else
 * a rung's call throws as that rung's provider error, quarantining the chunk's
 * request family once every rung has failed. The framework withdraws a
 * maintenance call at its provider gate while a surgery holds the store. So
 * the compression here runs through the framework's own maintenance membrane:
 * its canonical call is refused, and a surgery takes the store during that
 * call, so the ladder's next rung, the source-only call, is withdrawn at the
 * gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';

const MODEL = 'test-model';

/** A provider that refuses the first call it gets, the compression's
 *  canonical call, and runs `during` while answering it. */
class RefusingMembrane {
  calls: NormalizedRequest[] = [];
  during: () => void = () => {};

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    if (this.calls.length === 1) this.during();
    return {
      content: [],
      stopReason: 'refusal',
      usage: { inputTokens: 100, outputTokens: 0 },
      raw: { response: { stop_details: { category: 'reasoning_extraction' } } },
    } as unknown as NormalizedResponse;
  }

  asMembrane(): Membrane {
    return this as unknown as Membrane;
  }
}

describe("a maintenance call withdrawn inside context-manager's fallback ladder", () => {
  it('is no failure: nothing is quarantined, and nothing after it is sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-withdrawal-ladder-'));
    const provider = new RefusingMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: provider.asMembrane(),
      agents: [{ name: 'agent', model: MODEL, systemPrompt: 'test', strategy: new PassthroughStrategy() }],
      modules: [],
      syncIntervalMs: 0,
    });
    const internals = framework as unknown as {
      auxiliaryMembraneFor(agentName: string): Membrane;
      reserveStoreForSurgery(verb: string, agentName: string): () => void;
    };
    let release: (() => void) | undefined;
    provider.during = () => { release = internals.reserveStoreForSurgery('roll back', 'agent'); };

    const strategy = new AutobiographicalStrategy({
      compressionModel: MODEL,
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
      // After a refused canonical call, the source-only rung needs no recall
      // to drop, so it's the rung that runs next here.
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
    });
    // The framework's maintenance membrane, with each call it's asked for and
    // what it threw.
    const maintenance = internals.auxiliaryMembraneFor('agent');
    const asked: NormalizedRequest[] = [];
    const thrown: unknown[] = [];
    const counting = {
      complete: async (request: NormalizedRequest) => {
        asked.push(request);
        try { return await maintenance.complete(request); } catch (error) { thrown.push(error); throw error; }
      },
    } as unknown as Membrane;
    const manager = await ContextManager.open({ path: join(dir, 'compression'), strategy, membrane: counting });
    const logs: string[] = [];
    const error = console.error;
    console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
    try {
      for (let i = 0; i < 14; i++) {
        manager.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `raw-${i} ` + 'substantive '.repeat(18) }]);
      }
      const [settled] = await Promise.allSettled([manager.tick()]);
      assert.ok(release, 'the canonical call was made, and the surgery took the store during it');
      assert.equal(asked.length, 2, 'the ladder went on to the source-only rung');
      assert.equal(provider.calls.length, 1, 'which was withdrawn at the gate, before its call was sent');
      assert.equal((thrown[0] as Error | undefined)?.name, 'MaintenanceWithdrawnError');
      assert.equal(settled.status, 'rejected', 'the tick ends with the withdrawal');
      assert.equal((settled as PromiseRejectedResult).reason, thrown[0], 'rethrown unchanged');
      assert.deepEqual(strategy.getCompressionQuarantineStatus(), { count: 0, keys: [], spans: [] }, 'nothing is quarantined');
      assert.ok(!logs.some((line) => line.includes('Failed to compress chunk')), logs.join('\n'));
    } finally {
      console.error = error;
      release?.();
      manager.close();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
