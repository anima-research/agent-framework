/**
 * A move of the store's branch re-synchronizes every live agent (#291,
 * FW-AF-1).
 *
 * Every agent's context manager on a store follows the store's branch, but
 * only a manager that moves it itself (its switchBranch or fork) initializes
 * its strategy again. Before, a host's switchBranch moved the store under
 * every agent and a rollback or a suppression moved it under every agent
 * but the one acting, and each manager left behind kept its strategy at the
 * old branch generation: an AutobiographicalStrategy refused every compile
 * ("requires reinitialization for the current branch generation") until the
 * process restarted. And the presentation index wrote an agent's window
 * down once per manager, at its registration, so a move to a branch made
 * before the write-down (every branch an earlier release's store holds, or
 * a rollback into rows the write-down presented, which branchAt cuts at
 * their own sequence) left the agent in legacy mode for the rest of the
 * process: a write during its turn entered its window at once, and undo was
 * refused, blaming a write-down that had worked.
 *
 * Now, under the move's store reservation, every other live context is
 * initialized again on the store's branch (reinitializeOnStoreBranch, which
 * starts no generation of its own), and every agent is rebased: its window
 * written down where the new branch has none, its own rows repaired. A
 * context that can't follow leaves its agent in legacy mode, traced, until
 * the next move. framework.switchBranch is written to the operator log as a
 * checkout.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy, type MessageId, type MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError, describeReadMark, residentContextOptions, type TraceEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const text = (t: string) => [{ type: 'text', text: t }] as ContentBlock[];
const STALE = /requires reinitialization/;

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const memory = () => new AutobiographicalStrategy({ headWindowTokens: 4000, recentWindowTokens: 4000, autoTickOnNewMessage: false });

/** A passthrough whose next initialize() fails when `failNext` is set. */
class FailingOnce extends PassthroughStrategy {
  failNext = false;
  async initialize(): Promise<void> {
    if (!this.failNext) return;
    this.failNext = false;
    throw new Error('zz-initialize-failed');
  }
}

type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; placement?: Record<string, unknown> }): MessageId;
  presents(agent: unknown): boolean;
  activeTurnTokens: Map<string, unknown>;
};

/** Two residents, mira (the primary) and oren, on one store, each context with the strategy `strategies` gives it. */
async function boot(strategies: { mira?: () => object; oren?: () => object } = {}, storePath?: string) {
  if (!storePath) {
    const dir = mkdtempSync(join(tmpdir(), 'af-branch-move-resync-'));
    dirs.push(dir);
    storePath = join(dir, 'store.chronicle');
  }
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', proseRouting: 'disabled', strategy: (strategies.mira ?? memory)() },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.', proseRouting: 'disabled', strategy: (strategies.oren ?? memory)() },
    ] as Parameters<typeof AgentFramework.create>[0]['agents'],
    modules: [],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  frameworks.push(framework);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  framework.start();
  const internals = framework as unknown as Internals;
  const cm = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();

  /** A nudge of `name`, answered: whether it reached the provider, and the inference failures it met. */
  async function turnOf(name: string): Promise<{ requests: number; failures: string[] }> {
    const calls = membrane.calls.length;
    const before = traces.length;
    membrane.pushResponse(createMockResponse(text(`${name} answers`)));
    const failuresOf = () => traces.slice(before)
      .filter((t): t is Extract<TraceEvent, { type: 'inference:failed' }> => t.type === 'inference:failed' && t.agentName === name)
      .map((t) => String((t as { error?: unknown }).error));
    assert.equal(framework.nudgeAgent(name, 'zz-op').ok, true);
    await waitFor(`${name}'s turn to reach the provider or fail`, () => membrane.calls.length > calls || failuresOf().length > 0);
    await framework.runUntilIdle();
    return { requests: membrane.calls.length - calls, failures: failuresOf() };
  }

  /** Each resident's next turn reaches the provider, with no strategy refusing it. */
  async function bothServe(when: string): Promise<void> {
    for (const name of ['mira', 'oren']) {
      const turn = await turnOf(name);
      assert.deepEqual(turn.failures.filter((f) => STALE.test(f)), [], `${when}: ${name}'s strategy is current`);
      assert.deepEqual(turn.failures, [], `${when}: ${name}'s turn didn't fail`);
      assert.equal(turn.requests, 1, `${when}: ${name}'s turn reached the provider`);
    }
  }

  return { framework, membrane, traces, internals, cm, store: framework.getStore(), turnOf, bothServe };
}

type RebaseTrace = Extract<TraceEvent, { type: 'presentation:presented' | 'presentation:failed' }>;
const rebaseTraces = (traces: TraceEvent[]): RebaseTrace[] => traces.filter((t): t is RebaseTrace =>
  (t.type === 'presentation:presented' || t.type === 'presentation:failed') && t.occasion === 'rebase');

describe('a branch move re-synchronizes every live agent (#291, FW-AF-1)', () => {
  it("after a host's switchBranch, both residents' turns reach the provider, and the checkout is in the operator log", async () => {
    const h = await boot();
    await h.bothServe('before the switch');
    const main = h.store.currentBranch().name;
    h.store.createBranchAt('side', main, h.store.currentSequence());

    await h.framework.switchBranch('side', { requester: { via: 'test', name: 'zz-op' }, note: 'look around' });
    assert.equal(h.store.currentBranch().name, 'side');
    await h.bothServe('after the switch');

    const checkout = h.framework.getOperatorLog({ limit: 20 }).filter((e) => e.kind === 'checkout');
    assert.equal(checkout.length, 1);
    assert.deepEqual(checkout[0]!.params, { branch: 'side' });
    assert.deepEqual(checkout[0]!.result, { sourceBranch: main, targetBranch: 'side' });
    assert.deepEqual(checkout[0]!.requester, { via: 'test', name: 'zz-op' });
    assert.equal(checkout[0]!.note, 'look around');
    assert.ok(h.traces.some((t) => t.type === 'operator:action' && t.kind === 'checkout'));

    // And back: the move to main is followed the same way.
    await h.framework.switchBranch(main);
    await h.bothServe('after the switch back');
  });

  it('a refused checkout is logged with its error, and moves nothing', async () => {
    const h = await boot();
    h.internals.activeTurnTokens.set('oren', Symbol('turn'));
    try {
      await assert.rejects(h.framework.switchBranch('main'), (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy');
    } finally {
      h.internals.activeTurnTokens.delete('oren');
    }
    const entry = h.framework.getOperatorLog({ limit: 5 }).find((e) => e.kind === 'checkout')!;
    assert.match(entry.error!, /every agent sharing the store must be idle/);
    assert.equal(entry.result, undefined, 'nothing moved');
  });

  it("after one resident's rollback, the co-resident's context follows the store too", async () => {
    const h = await boot();
    await h.bothServe('before the rollback');
    await h.bothServe('a second round');
    const first = h.cm('mira').getAllMessages().find((m) => m.participant === 'mira')!;
    const result = await h.framework.rollbackToMessage('mira', { messageId: first.id });
    assert.ok(result.messagesRemoved > 0);
    assert.equal(h.store.currentBranch().name, result.targetBranch);
    await h.bothServe('after the rollback');
  });

  it("after one resident's suppression, the co-resident's context follows the store too", async () => {
    const h = await boot();
    const seeded = h.internals.addMessage('someone', text('suppress me'), {}, { forAgent: 'mira' });
    await h.bothServe('before the suppression');
    const result = await h.framework.suppressMessages('mira', { messageIds: [seeded] });
    assert.equal(result.messagesRemoved, 1);
    assert.equal(h.store.currentBranch().name, result.targetBranch);
    await h.bothServe('after the suppression');
  });

  it("a failed rollback's restore to the source branch is followed by the co-resident's context", async () => {
    let mira!: FailingOnce;
    const h = await boot({ mira: () => (mira = new FailingOnce()) });
    await h.bothServe('before the rollback');
    await h.bothServe('a second round');
    const first = h.cm('mira').getAllMessages().find((m) => m.participant === 'mira')!;
    const main = h.store.currentBranch().name;
    mira.failNext = true; // the rollback's switch fails; its restore succeeds
    await assert.rejects(
      h.framework.rollbackToMessage('mira', { messageId: first.id }),
      (e: unknown) => e instanceof OperatorActionError && /active branch restored to/.test(e.message),
    );
    assert.equal(h.store.currentBranch().name, main);
    await h.bothServe('after the restore');
  });

  it('a rollback to a row the write-down presented keeps the window presented: a mid-turn write waits, and undo is accepted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-branch-move-resync-'));
    dirs.push(dir);
    const storePath = join(dir, 'store.chronicle');
    // A store an earlier release wrote: rows in the residents' slot, no window index.
    {
      const store = JsStore.openOrCreate({ path: storePath });
      const cm = await ContextManager.open({ store, ...residentContextOptions('mira'), strategy: new PassthroughStrategy() });
      for (const t of ['old-1', 'old-2', 'old-3']) cm.addMessage('someone', text(t), {});
      assert.equal(cm.windowMode(), 'legacy', 'setup: the store predates the index');
      cm.close();
      store.close();
    }
    const h = await boot({ mira: () => new PassthroughStrategy(), oren: () => new PassthroughStrategy() }, storePath);
    const mira = h.framework.getAgent('mira')!;
    assert.equal(h.internals.presents(mira), true, 'setup: written down at registration');
    const old2 = h.cm('mira').getAllMessages().find((m) => (m.content[0] as { text?: string }).text === 'old-2')!;
    h.internals.addMessage('someone', text('new-1'), {}, { forAgent: 'mira' });

    const rolled = await h.framework.rollbackToMessage('mira', { messageId: old2.id });
    assert.equal(rolled.messagesRemoved, 2, 'old-3 and new-1');
    assert.equal(h.cm('mira').windowMode(), 'presented', "the new branch's window was written down");
    assert.equal(h.internals.presents(mira), true);
    assert.equal(h.internals.presents(h.framework.getAgent('oren')!), true);
    const written = rebaseTraces(h.traces);
    assert.deepEqual(
      written.map((t) => [t.type, t.agentName]).sort(),
      [['presentation:presented', 'mira'], ['presentation:presented', 'oren']],
      'each window written down on the new branch, traced at rebase',
    );

    // A write for mira while her turn is alive waits for her next point.
    h.internals.activeTurnTokens.set('mira', Symbol('turn'));
    const placement: Record<string, unknown> = {};
    let landed: MessageId;
    try {
      landed = h.internals.addMessage('someone', text('landed mid-turn'), {}, { forAgent: 'mira', placement });
      assert.equal(placement.presented, false, 'placed as not presented');
      assert.equal(h.cm('mira').windowStatusOf(landed), 'out', 'not in her window inside her turn');
    } finally {
      h.internals.activeTurnTokens.delete('mira');
    }
    assert.doesNotThrow(() => h.framework.undoLastTurn('mira'), 'undo is on her window');
    mira.markContextConsumed();
    assert.match(describeReadMark(mira.getConsumedWatermark()), /#\d+$/, 'a mark taken now is a presented mark, with its index length');
  });

  it('a switchBranch to a branch made before the write-down writes the window down there, and it stays presented', async () => {
    const h = await boot({ mira: () => new PassthroughStrategy(), oren: () => new PassthroughStrategy() });
    const main = h.store.currentBranch().name;
    h.store.createBranchAt('old', main, 1);
    await h.framework.switchBranch('old');
    for (const name of ['mira', 'oren']) {
      assert.equal(h.cm(name).windowMode(), 'presented', `${name}'s window on old`);
      assert.equal(h.internals.presents(h.framework.getAgent(name)!), true, name);
    }
    assert.ok(rebaseTraces(h.traces).every((t) => t.type === 'presentation:presented'));
    // A row written now enters the idle agent's window at once, as at rest.
    const row = h.internals.addMessage('someone', text('on old'), {}, { forAgent: 'oren' });
    assert.equal(h.cm('oren').windowStatusOf(row), 'in');
  });

  it("a context whose strategy can't follow leaves its agent in legacy mode, traced, until the next move", async () => {
    let oren!: FailingOnce;
    const h = await boot({ oren: () => (oren = new FailingOnce()) });
    const main = h.store.currentBranch().name;
    h.store.createBranchAt('side', main, h.store.currentSequence());
    oren.failNext = true;
    await h.framework.switchBranch('side'); // the move stands
    const failed = rebaseTraces(h.traces).filter((t) => t.type === 'presentation:failed');
    assert.deepEqual(failed.map((t) => [t.agentName, (t as { error: string }).error]), [['oren', 'zz-initialize-failed']]);
    assert.equal(h.internals.presents(h.framework.getAgent('oren')!), false, "oren's window isn't presented");
    assert.equal(h.internals.presents(h.framework.getAgent('mira')!), true, "mira's is");
    assert.throws(() => h.framework.undoLastTurn('oren'), /isn't presented on this branch .*couldn't follow a branch move/);

    await h.framework.switchBranch(main);
    assert.equal(h.internals.presents(h.framework.getAgent('oren')!), true, 'the next move follows, and presents again');
    await h.bothServe('after the next move');
  });

  it('a branch move drops every redo entry: each undid a window of the branch the store left', async () => {
    const h = await boot();
    await h.bothServe('a round');
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    assert.equal(h.framework.getUndoRedoState('mira').canRedo, true, 'setup');
    const main = h.store.currentBranch().name;
    h.store.createBranchAt('side', main, h.store.currentSequence());
    await h.framework.switchBranch('side');
    assert.equal(h.framework.getUndoRedoState('mira').canRedo, false);
    assert.deepEqual(h.framework.redo('mira'), { redone: false });
  });
});

