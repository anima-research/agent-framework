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
import type {
  ContextEntry,
  ContextLogView,
  ContextManager,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  StrategyContext,
  TokenBudget,
} from '@animalabs/context-manager';
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
  /** Wait for the re-initialization an undo or redo started; one must be running. */
  const reinitDone = async (): Promise<void> => {
    const running = internals().syncMoveReinit;
    assert.ok(running, 'a re-initialization is running');
    await running.done;
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
    await reinitDone();
    assert.equal(internals().surgeryHold, null);
    assert.equal(internals().activeTurnTokens.size, 0, 'the reservation is released');
    await works('a');
    await works('b');
  });

  it('redo(): both compile once the store is released', async () => {
    checkpointTurn();
    framework.undoLastTurn('a');
    await reinitDone();
    const r = framework.redo('a');
    assert.equal(r.redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.ok(internals().surgeryHold);
    await reinitDone();
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
    await reinitDone();
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
    await reinitDone();
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
  it('a failed undo or redo leaves the store where it was, released, with its turn kept (createBranchAt and switchBranch throwing)', async () => {
    checkpointTurn();
    const store = framework.getStore() as unknown as { createBranchAt: (...args: unknown[]) => unknown; switchBranch: (name: string) => void };
    const createBranchAt = store.createBranchAt;
    store.createBranchAt = () => { throw new Error('injected branch failure'); };
    try {
      assert.throws(() => framework.undoLastTurn('a'), /injected branch failure/);
    } finally {
      store.createBranchAt = createBranchAt;
    }
    assert.equal(internals().surgeryHold, null, 'the reservation is released');
    assert.equal(internals().activeTurnTokens.size, 0);
    assert.equal(internals().getTurnCheckpoints('a').length, 1, 'the checkpoint is kept');
    assert.equal(framework.getStore().currentBranch().name, 'main');

    framework.undoLastTurn('a');
    await reinitDone();
    const switchBranch = store.switchBranch;
    store.switchBranch = () => { throw new Error('injected switch failure'); };
    try {
      assert.throws(() => framework.redo('a'), /injected switch failure/);
    } finally {
      store.switchBranch = switchBranch;
    }
    assert.equal(internals().surgeryHold, null);
    assert.equal(internals().activeTurnTokens.size, 0);
    assert.equal(framework.getUndoRedoState('a').redoDepth, 1, 'the redo entry is kept');
    const redone = framework.redo('a');
    assert.equal(redone.redone, true);
    await reinitDone();
  });

  for (const move of ['undo', 'branch switch', 'suppression'] as const) {
    it(`a re-initialization that fails after a ${move} raises its alert, naming the move`, async () => {
      const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      let failNext = true;
      strategy.initialize = async (...args: unknown[]) => {
        if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
        return initialize(...args);
      };
      if (move === 'undo') {
        checkpointTurn();
        framework.undoLastTurn('a');
        await reinitDone();
      } else if (move === 'branch switch') {
        const store = framework.getStore();
        store.createBranchAt('side', 'main', store.currentSequence());
        await framework.switchBranch('side');
      } else {
        await framework.suppressMessages('a', { messageIds: [firstId] });
      }
      const alerts = reinitAlerts();
      assert.equal(alerts.length, 1, JSON.stringify(alerts));
      assert.equal(alerts[0]!.agentName, 'b');
      assert.match(alerts[0]!.message, new RegExp(`The ${move} moved the store's branch`));
      assert.equal(internals().surgeryHold, null);
    });
  }

  it("only the last pass's failures are reported when a redo overtakes a failing pass", async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let calls = 0;
    strategy.initialize = async (...args: unknown[]) => {
      calls++;
      // The first pass's re-initialization of b fails; the pass the redo
      // starts succeeds.
      if (calls === 1) throw new Error('injected first-pass failure');
      return initialize(...args);
    };
    checkpointTurn();
    framework.undoLastTurn('a');
    framework.redo('a');
    await reinitDone();
    assert.deepEqual(reinitAlerts(), [], 'the overtaken pass is not reported');
    await works('b');

    // Now the last pass fails: one alert, labelled with the last move.
    let failAll = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failAll) throw new Error('injected last-pass failure');
      return initialize(...args);
    };
    framework.undoLastTurn('a');
    framework.redo('a');
    await reinitDone();
    failAll = false;
    const alerts = reinitAlerts();
    assert.equal(alerts.length, 1, JSON.stringify(alerts));
    assert.match(alerts[0]!.message, /The redo moved the store's branch/);
  });

  it('a suppression whose fork switches the store and then fails restores the source, and the other agent is current', async () => {
    const a = cmOf('a') as unknown as { fork: (...args: unknown[]) => Promise<unknown> };
    const fork = a.fork;
    const store = framework.getStore();
    a.fork = async (...args: unknown[]) => {
      // As a fork whose initialization fails after the store has moved.
      const name = String(args[1] ?? args[0]);
      if (!store.listBranches().some((b) => b.name === name)) store.createBranchAt(name, 'main', store.currentSequence());
      store.switchBranch(name);
      throw new Error('injected fork failure');
    };
    try {
      await assert.rejects(
        framework.suppressMessages('a', { messageIds: [firstId] }),
        (e: unknown) => e instanceof OperatorActionError && /active branch restored to main/.test(e.message),
      );
    } finally {
      a.fork = fork;
    }
    assert.equal(store.currentBranch().name, 'main');
    assert.equal(internals().surgeryHold, null);
    await works('a');
    await works('b');
  });

  it("stop() waits for an undo's re-initialization before the store closes", async () => {
    checkpointTurn();
    framework.undoLastTurn('a');
    const running = internals().syncMoveReinit;
    assert.ok(running);
    let reinitEnded = false;
    void running.done.then(() => { reinitEnded = true; });
    await framework.stop();
    assert.equal(reinitEnded, true, 'the re-initialization finished before stop() returned');
  });

  it('a turn asked for while the managers re-initialize starts once the store is let go', async () => {
    checkpointTurn();
    framework.undoLastTurn('a');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'b answers after the undo' }]));
    framework.nudgeAgent('b', 'test');
    const run = framework.runUntilIdle();
    assert.ok(internals().surgeryHold, 'still reserved');
    assert.equal(membrane.calls.length, 0, 'no turn starts while the managers re-initialize');
    await reinitDone();
    await run;
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'the turn ran once the store was let go');
  });

  it('a host/command undo of two turns undoes both, then answers', async () => {
    // As turns record them: each turn's checkpoint is saved at its start,
    // so the branch an undo goes back to holds the earlier ones.
    const first = { agentName: 'a', turnIndex: 1, sequenceBefore: framework.getStore().currentSequence(), branchName: 'main', timestamp: Date.now() };
    internals().saveTurnCheckpoints('a', [first]);
    cmOf('a').addMessage('user', text('turn one'));
    const second = { agentName: 'a', turnIndex: 2, sequenceBefore: framework.getStore().currentSequence(), branchName: 'main', timestamp: Date.now() };
    internals().saveTurnCheckpoints('a', [first, second]);
    cmOf('a').addMessage('user', text('turn two'));
    const answer = await internals().handleHostCommand('discord', { command: 'undo', agentName: 'a', turns: 2 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.undone, 2);
    assert.equal(internals().activeTurnTokens.size, 0);
    await works('a');
    await works('b');
  });

  it("undo refuses as busy when the named agent is busy, and a joined redo when another agent is", async () => {
    checkpointTurn();
    // An agent reads as busy while its state says so.
    const busy = (name: string) => {
      const agent = framework.getAgent(name)!;
      const state = agent.state;
      Object.defineProperty(agent, 'state', { configurable: true, get: () => ({ ...state, status: 'inferring' }) });
      return () => { delete (agent as unknown as { state?: unknown }).state; };
    };
    let idle = busy('a');
    try {
      assert.throws(
        () => framework.undoLastTurn('a'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /Cannot undo while agent is inferring/.test(e.message),
      );
    } finally {
      idle();
    }
    framework.undoLastTurn('a');
    idle = busy('b');
    try {
      assert.throws(
        () => framework.redo('a'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /b is inferring/.test(e.message),
      );
    } finally {
      idle();
    }
    await reinitDone();
  });

  it("an undo's re-initialization waits for maintenance already running before any manager re-initializes", async () => {
    checkpointTurn();
    // A maintenance pass in flight: one the test settles.
    let settle!: () => void;
    const pass = new Promise<void>((resolve) => { settle = resolve; });
    const fw = framework as unknown as { maintenancePass: Promise<void> | null };
    fw.maintenancePass = pass;
    const calls: string[] = [];
    for (const name of ['a', 'b']) {
      const cm = cmOf(name) as unknown as { setStrategy: (s: unknown) => Promise<void> };
      const setStrategy = cm.setStrategy.bind(cm);
      cm.setStrategy = (strategy: unknown) => { calls.push(name); return setStrategy(strategy); };
    }
    try {
      framework.undoLastTurn('a');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(calls, [], 'no manager re-initializes while the pass runs');
      settle();
      fw.maintenancePass = null;
      await reinitDone();
      assert.deepEqual(calls.sort(), ['a', 'b']);
    } finally {
      settle();
      fw.maintenancePass = null;
    }
    await works('a');
    await works('b');
  });

  it("a rollback whose restore fails too reports the named agent's manager", async () => {
    const a = cmOf('a') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
    const initializeStrategy = a.initializeStrategy;
    a.initializeStrategy = async function () { throw new Error('injected strategy init failure'); };
    try {
      await assert.rejects(
        framework.rollbackToMessage('a', { messageId: firstId, branchName: 'failed-twice' }),
        (e: unknown) => e instanceof OperatorActionError && /RESTORE TO main ALSO FAILED/.test(e.message),
      );
    } finally {
      a.initializeStrategy = initializeStrategy;
    }
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /The restore to main moved the store's branch/);
  });

  it("a redo made from a listener of the last pass's alert is refused as busy, the store stays where the undo left it, and the agent that moved compiles", async () => {
    checkpointTurn();
    // b's next initialization fails, so the undo's pass reports an alert.
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    // A trace listener that redoes, synchronously, when it hears that alert.
    let redo: unknown = 'not called';
    framework.onTrace((event) => {
      if (event.type === 'ops:alert' && event.kind === 'context-reinit-failed' && redo === 'not called') {
        try { redo = framework.redo('a'); } catch (error) { redo = error; }
      }
    });
    const undone = framework.undoLastTurn('a');
    await reinitDone();
    assert.ok(
      redo instanceof OperatorActionError && redo.code === 'agent-busy' && /Cannot redo: the store is under live undo for a/.test(redo.message),
      `the redo was refused: ${redo instanceof Error ? redo.message : JSON.stringify(redo)}`,
    );
    assert.equal(framework.getStore().currentBranch().name, undone.toBranch, 'the store stays where the undo left it');
    assert.equal(internals().surgeryHold, null);
    await works('a');
  });
});

describe('conversation forks and an undo', () => {
  type ForkInternals = Internals & {
    createConversationAgent(name: string, channelId: string): Promise<{ getContextManager(): ContextManager }>;
  };

  it("a fork created while an undo's managers re-initialize waits for them, and compiles", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'reinit-fork-'));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
        { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: autobiographical() },
      ],
      modules: [],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
    });
    try {
      const internals = framework as unknown as ForkInternals;
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      // The template's re-initialization takes 300 ms, so a fork that didn't
      // wait would be seeded from it mid-initialization.
      const strategy = cmA.getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      strategy.initialize = async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return initialize(...args);
      };
      assert.equal(framework.undoLastTurn('a').undone, true);
      assert.ok(internals.syncMoveReinit, 'the re-initialization is running');
      const fork = await internals.createConversationAgent('a-chan-g1', 'world:chan');
      await fork.getContextManager().compile({ maxTokens: 100_000, reserveForResponse: 1_000 }, undefined, { dryRun: true });
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/** A strategy whose next tick, once armed, closes its agent's provider gate and parks a maintenance call there. */
class ArmedParkedCallStrategy implements ContextStrategy {
  readonly name = 'armed-parked-call-test';
  armed = false;
  calls = 0;
  outcomes: string[] = [];
  framework?: AgentFramework;

  checkReadiness(): ReadinessState {
    return { ready: false, description: 'parked call queued' };
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    const internals = this.framework as unknown as {
      providerGate(name: string): { primaryPending: boolean };
      withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
    };
    internals.providerGate('agent').primaryPending = true;
    try {
      await internals.withAuxiliaryAdmission('agent', async () => { this.calls++; });
      this.outcomes.push('ran');
    } catch (error) {
      this.outcomes.push((error as Error).name);
      throw error;
    }
  }

  select(_store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] {
    return [];
  }
}

describe('an undo or redo while a maintenance call waits at the provider gate', () => {
  for (const variant of ['undo', 'undo, then redo'] as const) {
    it(`${variant}: each move withdraws the parked call, and its re-initialization releases the store`, { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'reinit-parked-'));
      const strategy = new ArmedParkedCallStrategy();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test', strategy }],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      strategy.framework = framework;
      const alerts: string[] = [];
      (framework as unknown as { opsAlert: (kind: string, agentName: string, message: string) => void }).opsAlert =
        (kind, agentName, message) => alerts.push(`${kind}:${agentName}:${message}`);
      const internals = framework as unknown as {
        providerGate(name: string): { primaryPending: boolean; auxiliaryWaiters: Array<() => void> };
        surgeryHold: unknown;
        syncMoveReinit: { done: Promise<void> } | null;
        saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
      };
      const gate = () => internals.providerGate('agent');
      const cm = framework.getAgent('agent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'm1' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cm.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('agent', [{ agentName: 'agent', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      // Park a maintenance call at the gate, then make the move: its
      // re-initialization waits for the running pass, which the withdrawal ends.
      const parkThen = async (label: string, move: () => unknown): Promise<void> => {
        gate().primaryPending = false;
        strategy.armed = true;
        await waitParked();
        move();
        const running = internals.syncMoveReinit;
        assert.ok(running, `${label}: a re-initialization is running`);
        const outcome = await Promise.race([
          running.done.then(() => 'released'),
          new Promise<string>((resolve) => setTimeout(() => resolve(`${label}: the re-initialization still waits`), 3_000)),
        ]);
        assert.equal(outcome, 'released');
        assert.equal(internals.surgeryHold, null, `${label}: the store is released`);
      };
      const waitParked = async () => {
        const start = Date.now();
        while (gate().auxiliaryWaiters.length !== 1) {
          if (Date.now() - start > 3_000) throw new Error('no maintenance call parked at the gate');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const quiet = console.error;
      console.error = () => {};
      try {
        await framework.quiesce();
        framework.start();
        await parkThen('undo', () => framework.undoLastTurn('agent'));
        if (variant === 'undo, then redo') await parkThen('redo', () => framework.redo('agent'));
        assert.deepEqual(strategy.outcomes, variant === 'undo' ? ['MaintenanceWithdrawnError'] : ['MaintenanceWithdrawnError', 'MaintenanceWithdrawnError']);
        assert.equal(strategy.calls, 0, 'the withdrawn calls sent nothing');
        assert.deepEqual(alerts.filter((alert) => alert.startsWith('context-maintenance-failed')), []);
      } finally {
        console.error = quiet;
        gate().primaryPending = false;
        for (const resolve of gate().auxiliaryWaiters.splice(0)) resolve();
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
