/**
 * After the store's branch moves, every agent sharing the store compiles
 * again without a restart (#326). context-manager re-initializes only the
 * manager that makes a move; the framework re-initializes every other one
 * before the move releases the store.
 *
 * Two agents with autobiographical strategies, whose loaded branch
 * generation is what goes stale, on one store. No provider is called except
 * where a test takes a turn.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { ContextManager } from '@animalabs/context-manager';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function autobiographical(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

type Internals = {
  surgeryHold: { verb: string } | null;
  activeTurnTokens: Map<string, number>;
  syncMoveReinit: { done: Promise<void> } | null;
  saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
  getTurnCheckpoints(agentName: string): unknown[];
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
};

describe('after a branch move, every agent on the store compiles without a restart', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  let traces: TraceEvent[];
  let firstId: string;

  const cmOf = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
  const internals = () => framework as unknown as Internals;
  const text = (t: string) => [{ type: 'text' as const, text: t }];
  /** A dry compile and a readiness read: both refuse on a manager left on an
   *  earlier branch generation. */
  const budget = { maxTokens: 100_000, reserveForResponse: 1_000 };
  const works = async (name: string): Promise<void> => {
    await cmOf(name).compile(budget, undefined, { dryRun: true });
    assert.equal(typeof cmOf(name).isReady(), 'boolean');
  };
  /** One turn's checkpoint for `a`, taken before its last message. */
  const checkpointTurn = (): void => {
    const sequenceBefore = framework.getStore().currentSequence();
    cmOf('a').addMessage('user', text('a turn to undo'));
    internals().saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
  };
  const reinitAlerts = () => traces.filter(
    (t): t is Extract<TraceEvent, { type: 'ops:alert' }> => t.type === 'ops:alert' && t.kind === 'context-reinit-failed',
  );

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'reinit-after-move-'));
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
        { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: autobiographical() },
      ],
      modules: [],
    });
    traces = [];
    framework.onTrace((event) => { traces.push(event); });
    firstId = String(cmOf('a').addMessage('user', text('hello a')));
    cmOf('b').addMessage('user', text('hello b'));
    cmOf('a').addMessage('user', text('second a'));
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rollbackToMessage on one agent: the other compiles, and takes a turn', async () => {
    const r = await framework.rollbackToMessage('a', { messageId: firstId });
    assert.equal(r.messagesRemoved, 2);
    await works('a');
    await works('b');

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'b answers' }]));
    framework.nudgeAgent('b', 'test');
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'b compiled its turn and called the provider');
    assert.ok(traces.some((t) => t.type === 'inference:completed' && t.agentName === 'b'),
      traces.map((t) => t.type).join(', '));
    assert.deepEqual(reinitAlerts(), []);
  });

  it('suppressMessages on one agent: the other compiles', async () => {
    // The first message: after a middle one is removed, context-manager
    // 0.14.0's autobiographical strategy refuses every compile that follows
    // a dry run, the suppression's own preview included, whatever the move.
    const r = await framework.suppressMessages('a', { messageIds: [firstId] });
    assert.equal(r.messagesRemoved, 1);
    await works('a');
    await works('b');
  });

  it('switchBranch(): every agent compiles, and a switch to the current branch leaves them working', async () => {
    const store = framework.getStore();
    store.createBranchAt('side', 'main', store.currentSequence());
    await framework.switchBranch('side');
    assert.equal(store.currentBranch().name, 'side');
    await works('a');
    await works('b');
    await framework.switchBranch('side');
    await works('a');
    await works('b');
  });

  it('undoLastTurn(): the store stays reserved until every manager is re-initialized, then both compile', async () => {
    checkpointTurn();
    const r = framework.undoLastTurn('a');
    assert.equal(r.undone, true);
    assert.equal(framework.getStore().currentBranch().name, r.toBranch, 'the store moved before the undo returned');
    assert.ok(internals().surgeryHold, 'the store stays reserved while the managers re-initialize');
    assert.deepEqual([...internals().activeTurnTokens.keys()].sort(), ['a', 'b'], 'no turn can start meanwhile');
    await internals().syncMoveReinit?.done;
    assert.equal(internals().surgeryHold, null);
    assert.equal(internals().activeTurnTokens.size, 0, 'the reservation is released');
    await works('a');
    await works('b');
  });

  it('redo(): both compile once the store is released', async () => {
    checkpointTurn();
    framework.undoLastTurn('a');
    await internals().syncMoveReinit?.done;
    const r = framework.redo('a');
    assert.equal(r.redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.ok(internals().surgeryHold);
    await internals().syncMoveReinit?.done;
    assert.equal(internals().activeTurnTokens.size, 0);
    await works('a');
    await works('b');
  });

  it('an undo and a redo made back to back move the store under one reservation, and the managers end current', async () => {
    checkpointTurn();
    const undone = framework.undoLastTurn('a');
    const redone = framework.redo('a');
    assert.equal(undone.undone, true);
    assert.equal(redone.redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    // An operation that awaits its steps is refused while the managers
    // re-initialize, as during any surgery. The hold is the undo's.
    await assert.rejects(
      framework.rollbackToMessage('a', { messageId: firstId }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /live undo for a/.test(e.message),
    );
    await internals().syncMoveReinit?.done;
    assert.equal(internals().syncMoveReinit, null);
    assert.equal(internals().activeTurnTokens.size, 0);
    await works('a');
    await works('b');
    assert.deepEqual(reinitAlerts(), [], 'the pass the redo overtook is not reported');
  });

  it('a host/command turn undo answers with the preview, compiled once the managers are current', async () => {
    checkpointTurn();
    const answer = await internals().handleHostCommand('discord', { command: 'undo', agentName: 'a', turns: 1 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.undone, 1);
    assert.ok(answer.lastVisible, `the preview compiled: ${JSON.stringify(answer)}`);
    assert.equal(internals().activeTurnTokens.size, 0);
    await works('b');
  });

  it('undo and redo are refused while another agent on the store is busy, and keep what they would move', async () => {
    checkpointTurn();
    internals().activeTurnTokens.set('b', 7);
    try {
      assert.throws(
        () => framework.undoLastTurn('a'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /b is idle\+turn-alive/.test(e.message),
      );
      assert.equal(internals().getTurnCheckpoints('a').length, 1, 'the checkpoint is kept');
      assert.equal(framework.getStore().currentBranch().name, 'main');
    } finally {
      internals().activeTurnTokens.delete('b');
    }
    framework.undoLastTurn('a');
    await internals().syncMoveReinit?.done;
    internals().activeTurnTokens.set('b', 7);
    try {
      assert.throws(
        () => framework.redo('a'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /b is idle\+turn-alive/.test(e.message),
      );
      assert.equal(framework.getUndoRedoState('a').redoDepth, 1, 'the redo is kept');
    } finally {
      internals().activeTurnTokens.delete('b');
    }
  });

  it('a failed re-initialization raises an ops alert naming its agent; the move stands, and a switch to the current branch recovers it', async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    const r = await framework.rollbackToMessage('a', { messageId: firstId });
    assert.equal(framework.getStore().currentBranch().name, r.targetBranch, 'the rollback stands');
    const alerts = reinitAlerts();
    assert.equal(alerts.length, 1, JSON.stringify(alerts));
    assert.equal(alerts[0]!.agentName, 'b');
    assert.match(alerts[0]!.message, /The rollback moved the store's branch/);
    assert.match(alerts[0]!.message, /injected initialization failure/);
    await works('a');
    await assert.rejects(
      cmOf('b').compile(budget, undefined, { dryRun: true }),
      /requires successful strategy initialization/,
    );

    await framework.switchBranch(r.targetBranch);
    await works('b');
    assert.equal(reinitAlerts().length, 1);
  });

  it('a rollback whose switch fails and goes back to the source still leaves the other agent current', async () => {
    const a = cmOf('a') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
    const initializeStrategy = a.initializeStrategy;
    let failNext = true;
    a.initializeStrategy = async function (this: unknown, ...args: unknown[]) {
      if (failNext) { failNext = false; throw new Error('injected strategy init failure'); }
      return initializeStrategy.apply(this, args);
    };
    try {
      await assert.rejects(
        framework.rollbackToMessage('a', { messageId: firstId, branchName: 'failed-rollback' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /active branch restored to main/.test(e.message),
      );
    } finally {
      a.initializeStrategy = initializeStrategy;
    }
    assert.equal(framework.getStore().currentBranch().name, 'main');
    await works('a');
    await works('b');
  });
});
