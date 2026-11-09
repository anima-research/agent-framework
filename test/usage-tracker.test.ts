import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EPHEMERAL_USAGE_NAME, UsageTracker } from '../src/usage/usage-tracker.js';
import type { UsageUpdatedEvent } from '../src/usage/types.js';

describe('UsageTracker', () => {
  function createTracker() {
    const traces: UsageUpdatedEvent[] = [];
    const tracker = new UsageTracker({ emitTrace: (e) => traces.push(e) });
    return { tracker, traces };
  }

  it('accumulates tokens across multiple inferences', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75, cacheCreationTokens: 10, cacheReadTokens: 30 });

    const snap = tracker.getSnapshot();
    assert.equal(snap.totals.inputTokens, 300);
    assert.equal(snap.totals.outputTokens, 125);
    assert.equal(snap.totals.cacheCreationTokens, 10);
    assert.equal(snap.totals.cacheReadTokens, 30);
    assert.equal(snap.inferenceCount, 2);
  });

  it('tracks per-agent breakdown', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('alice', { inputTokens: 100, outputTokens: 50 });
    tracker.onInferenceCompleted('bob', { inputTokens: 200, outputTokens: 75 });
    tracker.onInferenceCompleted('alice', { inputTokens: 150, outputTokens: 60 });

    const snap = tracker.getSnapshot();
    assert.equal(snap.byAgent.length, 2);

    const alice = snap.byAgent.find(a => a.agentName === 'alice')!;
    assert.equal(alice.usage.inputTokens, 250);
    assert.equal(alice.inferenceCount, 2);

    const bob = snap.byAgent.find(a => a.agentName === 'bob')!;
    assert.equal(bob.usage.inputTokens, 200);
    assert.equal(bob.inferenceCount, 1);
  });

  it('accumulates estimated cost', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    const snap = tracker.getSnapshot();
    assert.ok(snap.totals.estimatedCost);
    assert.ok(Math.abs(snap.totals.estimatedCost.total - 0.03) < 1e-10);
    assert.equal(snap.totals.estimatedCost.currency, 'USD');
  });

  it('drops cost on currency mismatch', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'EUR' });

    const snap = tracker.getSnapshot();
    assert.equal(snap.totals.estimatedCost, undefined);
  });

  it('leaves estimatedCost undefined when no cost data provided', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 });

    const snap = tracker.getSnapshot();
    assert.equal(snap.totals.estimatedCost, undefined);
  });

  it('returns deep-copied snapshots', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });

    const snap1 = tracker.getSnapshot();
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    // snap1 should not have been mutated
    assert.equal(snap1.totals.inputTokens, 100);
    assert.ok(snap1.totals.estimatedCost);
    assert.ok(Math.abs(snap1.totals.estimatedCost.total - 0.01) < 1e-10);
    assert.equal(snap1.inferenceCount, 1);
  });

  it('emits deep-copied trace events', () => {
    const { tracker, traces } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    // First trace should not have been mutated by the second inference
    assert.equal(traces[0].totals.inputTokens, 100);
    assert.ok(traces[0].totals.estimatedCost);
    assert.ok(Math.abs(traces[0].totals.estimatedCost.total - 0.01) < 1e-10);
  });

  it('emits usage:updated trace on each inference', () => {
    const { tracker, traces } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 });

    assert.equal(traces.length, 1);
    assert.equal(traces[0].type, 'usage:updated');
    assert.equal(traces[0].agentName, 'agent');
    assert.equal(traces[0].inferenceCount, 1);
  });

  it('round-trips through toJSON/restore', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('alice', { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 5, cacheReadTokens: 20 }, { total: 0.01, currency: 'USD' });
    tracker.onInferenceCompleted('bob', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });
    tracker.onInferenceCompleted('alice', { inputTokens: 150, outputTokens: 60 }, { total: 0.015, currency: 'USD' });

    const persisted = tracker.toJSON();
    // Simulate JSON round-trip (as Chronicle does)
    const restored = new UsageTracker({
      emitTrace: () => {},
      restored: JSON.parse(JSON.stringify(persisted)),
    });

    const snap = restored.getSnapshot();
    assert.equal(snap.totals.inputTokens, 450);
    assert.equal(snap.totals.outputTokens, 185);
    assert.equal(snap.totals.cacheCreationTokens, 5);
    assert.equal(snap.totals.cacheReadTokens, 20);
    assert.equal(snap.inferenceCount, 3);
    assert.ok(snap.totals.estimatedCost);
    assert.ok(Math.abs(snap.totals.estimatedCost.total - 0.045) < 1e-10);
    assert.equal(snap.totals.estimatedCost.currency, 'USD');

    assert.equal(snap.byAgent.length, 2);
    const alice = snap.byAgent.find(a => a.agentName === 'alice')!;
    assert.equal(alice.usage.inputTokens, 250);
    assert.equal(alice.inferenceCount, 2);

    const bob = snap.byAgent.find(a => a.agentName === 'bob')!;
    assert.equal(bob.usage.inputTokens, 200);
    assert.equal(bob.inferenceCount, 1);
  });

  it('continues accumulating after restore', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' });

    const restored = new UsageTracker({
      emitTrace: () => {},
      restored: JSON.parse(JSON.stringify(tracker.toJSON())),
    });
    restored.onInferenceCompleted('agent', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' });

    const snap = restored.getSnapshot();
    assert.equal(snap.totals.inputTokens, 300);
    assert.equal(snap.totals.outputTokens, 125);
    assert.equal(snap.inferenceCount, 2);
    assert.ok(snap.totals.estimatedCost);
    assert.ok(Math.abs(snap.totals.estimatedCost.total - 0.03) < 1e-10);
  });

  it('counts every ephemeral agent in one shared entry, apart from an agent of its name, and the trace still names each', () => {
    const { tracker, traces } = createTracker();
    tracker.onInferenceCompleted('spawn-a-1', { inputTokens: 100, outputTokens: 50 }, { total: 0.01, currency: 'USD' }, true);
    tracker.onInferenceCompleted('spawn-b-2', { inputTokens: 200, outputTokens: 75 }, { total: 0.02, currency: 'USD' }, true);
    tracker.onInferenceCompleted(EPHEMERAL_USAGE_NAME, { inputTokens: 7, outputTokens: 3 });

    const snap = tracker.getSnapshot();
    assert.deepEqual(snap.byAgent.map((a) => [a.agentName, a.ephemeral, a.inferenceCount, a.usage.inputTokens]), [
      [EPHEMERAL_USAGE_NAME, undefined, 1, 7],
      [EPHEMERAL_USAGE_NAME, true, 2, 300],
    ]);
    const shared = snap.byAgent.find((a) => a.ephemeral)!;
    assert.ok(Math.abs(shared.usage.estimatedCost!.total - 0.03) < 1e-10);
    // The snapshot holds a copy: changing it changes nothing kept.
    shared.usage.inputTokens = 0;
    shared.usage.estimatedCost!.total = 0;
    const kept = tracker.getSnapshot().byAgent.find((a) => a.ephemeral)!;
    assert.equal(kept.usage.inputTokens, 300);
    assert.ok(Math.abs(kept.usage.estimatedCost!.total - 0.03) < 1e-10);
    assert.equal(snap.totals.inputTokens, 307);
    assert.equal(snap.inferenceCount, 3);
    assert.deepEqual(traces.map((e) => e.agentName), ['spawn-a-1', 'spawn-b-2', EPHEMERAL_USAGE_NAME]);
  });

  it('restores the shared entry, and folds into it each stored entry wasEphemeral names, leaving the totals as stored', () => {
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('resident', { inputTokens: 1000, outputTokens: 500 });
    tracker.onInferenceCompleted('spawn-new', { inputTokens: 40, outputTokens: 4 }, undefined, true);
    const stored = JSON.parse(JSON.stringify(tracker.toJSON()));
    // Entries an earlier release stored for each ephemeral agent by its own
    // name, counted in the stored totals as that release counted them.
    stored.byAgent.push(
      { agentName: 'spawn-old-1', usage: { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 }, inferenceCount: 1 },
      { agentName: 'spawn-old-2', usage: { inputTokens: 200, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }, inferenceCount: 2 },
    );
    stored.totals.inputTokens += 300;
    stored.totals.outputTokens += 30;
    stored.inferenceCount += 3;
    const restored = new UsageTracker({
      emitTrace: () => {},
      restored: stored,
      wasEphemeral: (name) => name.startsWith('spawn-old-'),
    });
    const totalsOf = (s: { totals: { inputTokens: number; outputTokens: number }; inferenceCount: number }) =>
      [s.totals.inputTokens, s.totals.outputTokens, s.inferenceCount];
    // The fold moves entries; the totals and the count stay as stored.
    assert.deepEqual(totalsOf(restored.getSnapshot()), [1340, 534, 5]);
    restored.onInferenceCompleted('spawn-later', { inputTokens: 1, outputTokens: 1 }, undefined, true);

    const snap = restored.getSnapshot();
    assert.deepEqual(snap.byAgent.map((a) => [a.agentName, a.ephemeral, a.inferenceCount, a.usage.inputTokens, a.usage.outputTokens]), [
      ['resident', undefined, 1, 1000, 500],
      [EPHEMERAL_USAGE_NAME, true, 5, 341, 35],
    ]);
    assert.deepEqual(totalsOf(snap), [1341, 535, 6]);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.toJSON())).byAgent.map((a: { agentName: string }) => a.agentName), ['resident', EPHEMERAL_USAGE_NAME]);
  });

  it('once costs in two currencies meet in a tally, its cost stays absent and marked, in the totals, an entry and the shared entry, through a restore', () => {
    const { tracker } = createTracker();
    const u = { inputTokens: 1, outputTokens: 1 };
    const usd = (total: number) => ({ total, currency: 'USD' });
    const eur = (total: number) => ({ total, currency: 'EUR' });
    tracker.onInferenceCompleted('resident', u, usd(1));
    tracker.onInferenceCompleted('resident', u, eur(2));
    tracker.onInferenceCompleted('resident', u, usd(3));
    tracker.onInferenceCompleted('spawn-a', u, usd(1), true);
    tracker.onInferenceCompleted('spawn-b', u, eur(2), true);
    tracker.onInferenceCompleted('spawn-c', u, usd(3), true);
    tracker.onInferenceCompleted('other', u, usd(5));
    // An unpriced inference adds its tokens and leaves the cost as it was.
    tracker.onInferenceCompleted('other', u);
    const costs = (s: ReturnType<UsageTracker['getSnapshot']>) => [
      ['totals', s.totals.estimatedCost, s.totals.mixedCurrencies, s.totals.inputTokens, s.totals.outputTokens],
      ...s.byAgent.map((a) => [a.agentName, a.usage.estimatedCost, a.usage.mixedCurrencies, a.usage.inputTokens, a.usage.outputTokens]),
    ];
    // A later cost in either currency doesn't start the sum again from itself,
    // and every inference still counts its tokens.
    assert.deepEqual(costs(tracker.getSnapshot()), [
      ['totals', undefined, true, 8, 8],
      ['resident', undefined, true, 3, 3],
      ['other', usd(5), undefined, 2, 2],
      [EPHEMERAL_USAGE_NAME, undefined, true, 3, 3],
    ]);
    // The mark is stored and restored, so a cost after a restart doesn't either.
    const restored = new UsageTracker({ emitTrace: () => {}, restored: JSON.parse(JSON.stringify(tracker.toJSON())) });
    restored.onInferenceCompleted('resident', u, usd(4));
    restored.onInferenceCompleted('spawn-d', u, usd(4), true);
    restored.onInferenceCompleted('other', u, usd(1));
    assert.deepEqual(costs(restored.getSnapshot()), [
      ['totals', undefined, true, 11, 11],
      ['resident', undefined, true, 4, 4],
      ['other', usd(6), undefined, 3, 3],
      [EPHEMERAL_USAGE_NAME, undefined, true, 4, 4],
    ]);
  });

  it('marks the totals at restore when the stored entries show two currencies met, as a record written before the mark can', () => {
    const tally = (usage: Record<string, unknown> = {}) =>
      ({ inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, ...usage });
    const usd = (total: number) => ({ estimatedCost: { total, currency: 'USD' } });
    const eur = (total: number) => ({ estimatedCost: { total, currency: 'EUR' } });
    const totalsAfter = (totals: Record<string, unknown>, entries: Array<[string, Record<string, unknown>]>) => {
      const restored = new UsageTracker({
        emitTrace: () => {},
        restored: { totals: tally(totals), byAgent: entries.map(([agentName, usage]) => ({ agentName, usage: tally(usage), inferenceCount: 1 })), inferenceCount: entries.length } as never,
        wasEphemeral: (name) => name.startsWith('spawn-'),
      }).getSnapshot().totals;
      return [restored.estimatedCost, restored.mixedCurrencies];
    };
    // A record from before the mark, after USD 1, EUR 2 and USD 3: the totals
    // started again at the third cost. The entries show the mix.
    assert.deepEqual(totalsAfter(usd(3), [['resident', usd(1)], ['spawn-1', eur(2)], ['spawn-2', usd(3)]]), [undefined, true]);
    // An entry against the totals' own currency, and a marked entry, show it too.
    assert.deepEqual(totalsAfter(usd(3), [['resident', eur(2)]]), [undefined, true]);
    assert.deepEqual(totalsAfter(usd(3), [['resident', { mixedCurrencies: true }]]), [undefined, true]);
    // Costs in one currency leave the totals' cost as stored.
    assert.deepEqual(totalsAfter(usd(4), [['resident', usd(1)], ['spawn-1', usd(3)]]), [{ total: 4, currency: 'USD' }, undefined]);
  });

  it('the fold carries a currency mix into the shared entry, from stored entries in two currencies or one already marked', () => {
    const tally = (usage: Record<string, unknown>) =>
      ({ inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, ...usage });
    const priced = (agentName: string, total: number, currency: string) =>
      ({ agentName, usage: tally({ estimatedCost: { total, currency } }), inferenceCount: 1 });
    const marked = (agentName: string, usage: Record<string, unknown> = {}) =>
      ({ agentName, usage: tally({ mixedCurrencies: true, ...usage }), inferenceCount: 1 });
    const restore = (byAgent: unknown[]) => new UsageTracker({
      emitTrace: () => {},
      restored: { totals: tally({}), byAgent, inferenceCount: byAgent.length } as never,
      wasEphemeral: (name) => name.startsWith('spawn-'),
    }).getSnapshot().byAgent.map((a) => [a.agentName, a.usage.estimatedCost, a.usage.mixedCurrencies]);

    assert.deepEqual(restore([priced('spawn-1', 1, 'USD'), priced('spawn-2', 2, 'EUR'), priced('spawn-3', 3, 'USD')]), [
      [EPHEMERAL_USAGE_NAME, undefined, true],
    ]);
    assert.deepEqual(restore([priced('spawn-1', 1, 'USD'), marked('spawn-2'), priced('spawn-3', 3, 'USD')]), [
      [EPHEMERAL_USAGE_NAME, undefined, true],
    ]);
    // A stored mark wins over a cost stored beside it, which would otherwise stay as it is for good.
    assert.deepEqual(restore([marked('kept', { estimatedCost: { total: 9, currency: 'USD' } })]), [['kept', undefined, true]]);
  });

  it("a usage without a count adds nothing for it, so the totals stay numbers and are stored as numbers", () => {
    // membrane passes a Bedrock stream's output count through as reported, so one can be missing.
    const { tracker } = createTracker();
    tracker.onInferenceCompleted('agent', { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 20 });
    tracker.onInferenceCompleted('agent', {
      inputTokens: 25,
      outputTokens: undefined as unknown as number,
      cacheCreationTokens: NaN,
      cacheReadTokens: NaN,
    });
    const stored = JSON.parse(JSON.stringify(tracker.toJSON()));
    assert.equal(stored.totals.inputTokens, 125);
    assert.equal(stored.totals.outputTokens, 50);
    assert.equal(stored.totals.cacheCreationTokens, 10);
    assert.equal(stored.totals.cacheReadTokens, 20);
    assert.equal(stored.byAgent[0].usage.inputTokens, 125);
    assert.equal(stored.byAgent[0].usage.outputTokens, 50);
  });
});
