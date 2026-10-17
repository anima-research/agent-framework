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

/** A promise the test settles, which records whether anything has waited on
 *  it through `then` (Promise.allSettled does), so a test can check that a
 *  wait was reached instead of sleeping and hoping it was. */
const watchedPromise = () => {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  let waitedOn = false;
  const then = promise.then.bind(promise) as (onFulfilled?: unknown, onRejected?: unknown) => Promise<unknown>;
  Object.defineProperty(promise, 'then', {
    value: (onFulfilled?: unknown, onRejected?: unknown) => { waitedOn = true; return then(onFulfilled, onRejected); },
  });
  return { promise, settle, waited: () => waitedOn };
};
/** Let every queued microtask run (setImmediate's callback runs after them). */
const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });

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
    const { promise: pass, settle, waited } = watchedPromise();
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
      await settled();
      assert.ok(waited(), 'the re-initialization is waiting on the pass');
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

  it("an undo's managers re-initialize one at a time, with a turn of the event loop between them", async () => {
    checkpointTurn();
    const calls: string[] = [];
    for (const name of ['a', 'b']) {
      const cm = cmOf(name) as unknown as { setStrategy: (s: unknown) => Promise<void> };
      const setStrategy = cm.setStrategy.bind(cm);
      cm.setStrategy = (strategy: unknown) => { calls.push(name); return setStrategy(strategy); };
    }
    framework.undoLastTurn('a');
    assert.deepEqual(calls, [], 'no manager re-initializes inside undoLastTurn()');
    // An immediate queued now runs on the event loop's next turn: before the
    // last manager re-initializes, since each waits for a turn of its own.
    const before = await new Promise<number>((resolve) => { setImmediate(() => resolve(calls.length)); });
    assert.ok(before < 2, `the event loop ran while the managers re-initialized (${before} of 2 had when it did)`);
    await reinitDone();
    assert.deepEqual(calls.sort(), ['a', 'b']);
    await works('a');
    await works('b');
  });

  it("an undo's re-initialization waits for an over-budget drain kick already running", async () => {
    checkpointTurn();
    const { promise: kick, settle, waited } = watchedPromise();
    const drains = (framework as unknown as { overBudgetDrains: Set<Promise<void>> }).overBudgetDrains;
    drains.add(kick);
    const calls: string[] = [];
    for (const name of ['a', 'b']) {
      const cm = cmOf(name) as unknown as { setStrategy: (s: unknown) => Promise<void> };
      const setStrategy = cm.setStrategy.bind(cm);
      cm.setStrategy = (strategy: unknown) => { calls.push(name); return setStrategy(strategy); };
    }
    try {
      framework.undoLastTurn('a');
      await settled();
      assert.ok(waited(), 'the re-initialization is waiting on the kick');
      assert.deepEqual(calls, [], 'no manager re-initializes while the kick runs');
      settle();
      drains.delete(kick);
      await reinitDone();
      assert.deepEqual(calls.sort(), ['a', 'b']);
    } finally {
      settle();
      drains.delete(kick);
    }
    await works('a');
    await works('b');
  });

  it("a rollback whose restore fails too reports the named agent's manager, and names the branch the store is on", async () => {
    const a = cmOf('a') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
    const initializeStrategy = a.initializeStrategy;
    a.initializeStrategy = async function () { throw new Error('injected strategy init failure'); };
    let message = '';
    try {
      await assert.rejects(
        framework.rollbackToMessage('a', { messageId: firstId, branchName: 'failed-twice' }),
        (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
      );
    } finally {
      a.initializeStrategy = initializeStrategy;
    }
    // The restore's switch selects main before its initialization fails, so
    // the store is back on main, and the message says so.
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.match(message, /RESTORE TO main selected it, but re-initializing the agent's context manager for it FAILED/);
    assert.match(message, /the agent refuses its work until switchBranch\(\) to the current branch, or a restart, re-initializes it/);
    assert.doesNotMatch(message, /still on failed-twice/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /The restore to main put the store back on main, and re-initializing/);
  });

  it("a rollback whose restore can't even select the source says the store stayed on the failed branch", async () => {
    const a = cmOf('a') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
    const initializeStrategy = a.initializeStrategy;
    a.initializeStrategy = async function () { throw new Error('injected strategy init failure'); };
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => void };
    const switchBranch = store.switchBranch;
    store.switchBranch = function (this: unknown, name: string) {
      if (name === 'main') throw new Error('injected restore refusal');
      return switchBranch.call(this, name);
    };
    let message = '';
    try {
      await assert.rejects(
        framework.rollbackToMessage('a', { messageId: firstId, branchName: 'failed-thrice' }),
        (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
      );
    } finally {
      a.initializeStrategy = initializeStrategy;
      store.switchBranch = switchBranch;
    }
    assert.equal(framework.getStore().currentBranch().name, 'failed-thrice');
    assert.match(message, /RESTORE TO main ALSO FAILED \(injected restore refusal\); the store is still on failed-thrice/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /The restore to main failed \(injected restore refusal\), so the store is still on failed-thrice\./);
    assert.doesNotMatch(alerts[0]!.message, /moved the store's branch/);
  });

  it('a suppression refused before the store moved (its branch name is taken) re-initializes no other manager and raises no alert', async () => {
    const store = framework.getStore();
    store.createBranchAt('taken', 'main', store.currentSequence());
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let initializations = 0;
    strategy.initialize = async (...args: unknown[]) => { initializations++; return initialize(...args); };
    await assert.rejects(
      framework.suppressMessages('a', { messageIds: [firstId], branchName: 'taken' }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /\btaken\b/.test(e.message),
    );
    assert.equal(store.currentBranch().name, 'main');
    assert.equal(initializations, 0, "b's manager wasn't re-initialized: nothing moved");
    assert.deepEqual(reinitAlerts(), []);
    assert.equal(internals().surgeryHold, null);
    await works('a');
    await works('b');
  });

  it('a rollback whose switch is refused before the store moves re-initializes no other manager', async () => {
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => void };
    const switchBranch = store.switchBranch;
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let initializations = 0;
    strategy.initialize = async (...args: unknown[]) => { initializations++; return initialize(...args); };
    store.switchBranch = () => { throw new Error('injected switch refusal'); };
    try {
      await assert.rejects(
        framework.rollbackToMessage('a', { messageId: firstId, branchName: 'refused-switch' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /injected switch refusal/.test(e.message),
      );
    } finally {
      store.switchBranch = switchBranch;
    }
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.equal(initializations, 0, "b's manager wasn't re-initialized: nothing moved");
    assert.deepEqual(reinitAlerts(), []);
    await works('a');
    await works('b');
  });

  it('a redo whose branch was deleted drops that entry and says so, and the redo beneath it still works', async () => {
    // Two turns of a's, each checkpointed at its start as a turn is, then
    // undone one after the other.
    const store = framework.getStore();
    const before1 = store.currentSequence();
    const turn1 = { agentName: 'a', turnIndex: 1, sequenceBefore: before1, branchName: 'main', timestamp: Date.now() };
    internals().saveTurnCheckpoints('a', [turn1]);
    cmOf('a').addMessage('user', text('turn one'));
    const before2 = store.currentSequence();
    internals().saveTurnCheckpoints('a', [turn1, { agentName: 'a', turnIndex: 2, sequenceBefore: before2, branchName: 'main', timestamp: Date.now() }]);
    cmOf('a').addMessage('user', text('turn two'));
    framework.undoLastTurn('a');
    await reinitDone();
    const afterFirstUndo = store.currentBranch().name;
    framework.undoLastTurn('a');
    await reinitDone();
    assert.equal(framework.getUndoRedoState('a').redoDepth, 2);
    // The top entry returns to the branch the first undo left; delete it.
    store.deleteBranch(afterFirstUndo);

    let message = '';
    assert.throws(() => framework.redo('a'), (e: unknown) => {
      message = e instanceof Error ? e.message : String(e);
      return e instanceof OperatorActionError && e.code === 'failed';
    });
    assert.match(message, new RegExp(`${afterFirstUndo}, no longer exists, so that step is dropped\\. The step now on top can be redone \\(1 remaining\\)\\.$`));
    assert.equal(framework.getUndoRedoState('a').redoDepth, 1, 'the dead entry is gone');
    assert.equal(internals().surgeryHold, null);

    const redone = framework.redo('a');
    assert.equal(redone.redone, true, 'the entry beneath it redoes');
    await reinitDone();
    assert.equal(store.currentBranch().name, 'main');
    await works('a');
    await works('b');
  });

  it('a redo drops every step on top whose branch is gone, says how many, and says when none remain', async () => {
    // Start on a branch of the test's own, so the bottom step's branch can go too.
    const store = framework.getStore();
    store.createBranchAt('work', 'main', store.currentSequence());
    await framework.switchBranch('work');
    const before1 = store.currentSequence();
    const turn1 = { agentName: 'a', turnIndex: 1, sequenceBefore: before1, branchName: 'work', timestamp: Date.now() };
    internals().saveTurnCheckpoints('a', [turn1]);
    cmOf('a').addMessage('user', text('turn one'));
    const before2 = store.currentSequence();
    internals().saveTurnCheckpoints('a', [turn1, { agentName: 'a', turnIndex: 2, sequenceBefore: before2, branchName: 'work', timestamp: Date.now() }]);
    cmOf('a').addMessage('user', text('turn two'));
    framework.undoLastTurn('a');
    await reinitDone();
    const afterFirstUndo = store.currentBranch().name;
    framework.undoLastTurn('a');
    await reinitDone();
    assert.equal(framework.getUndoRedoState('a').redoDepth, 2);
    // The top step returns to the branch the first undo left, the one beneath to `work`.
    store.deleteBranch(afterFirstUndo);
    store.deleteBranch('work');

    let message = '';
    assert.throws(() => framework.redo('a'), (e: unknown) => {
      message = e instanceof Error ? e.message : String(e);
      return e instanceof OperatorActionError && e.code === 'failed';
    });
    assert.match(message, new RegExp(`${afterFirstUndo}, no longer exists, so that step is dropped, with the one beneath it, whose branch is gone too\\. No redo steps remain\\.$`));
    assert.equal(framework.getUndoRedoState('a').redoDepth, 0);
    assert.equal(internals().surgeryHold, null);
    await works('a');
  });

  it("a redo whose switch fails while the branch listing fails too keeps its step, and answers the switch's error", async () => {
    checkpointTurn();
    framework.undoLastTurn('a');
    await reinitDone();
    assert.equal(framework.getUndoRedoState('a').redoDepth, 1);
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => void; listBranches: () => unknown };
    const switchBranch = store.switchBranch;
    const listBranches = store.listBranches;
    store.switchBranch = () => { throw new Error('injected switch failure'); };
    store.listBranches = () => { throw new Error('injected listing failure'); };
    try {
      assert.throws(() => framework.redo('a'), /injected switch failure/);
    } finally {
      store.switchBranch = switchBranch;
      store.listBranches = listBranches;
    }
    assert.equal(framework.getUndoRedoState('a').redoDepth, 1, 'the step is kept');
    assert.equal(internals().surgeryHold, null);
    assert.equal(framework.redo('a').redone, true);
    await reinitDone();
    await works('a');
    await works('b');
  });

  it("a runtime-settings change while an undo's managers re-initialize is refused, and nothing is applied", async () => {
    checkpointTurn();
    const before = framework.getAgentRuntimeSettings('b');
    framework.undoLastTurn('a');
    assert.ok(internals().syncMoveReinit, 'the re-initialization is running');
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    assert.throws(
      () => framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
    );
    await reinitDone();
    assert.equal(framework.getAgentRuntimeSettings('b').sameRoundThinkTextPolicy, before.sameRoundThinkTextPolicy);
    // Once the store is let go, the same change applies.
    assert.equal(framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }).sameRoundThinkTextPolicy, next);
  });

  it("a runtime-settings reset or cancelled transition while an undo's managers re-initialize is refused, and nothing is applied", async () => {
    const before = framework.getAgentRuntimeSettings('b');
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next });
    checkpointTurn();
    framework.undoLastTurn('a');
    assert.ok(internals().syncMoveReinit, 'the re-initialization is running');
    assert.throws(
      () => framework.resetAgentRuntimeSettings('b'),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
    );
    assert.throws(
      () => framework.cancelAgentRuntimeSettingsTransition('b'),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
    );
    await reinitDone();
    assert.equal(framework.getAgentRuntimeSettings('b').sameRoundThinkTextPolicy, next, 'the override is still set');
    assert.equal(framework.resetAgentRuntimeSettings('b').sameRoundThinkTextPolicy, before.sameRoundThinkTextPolicy);
  });

  it("after a rollback, the other agent compiles what the landed branch holds", async () => {
    // a and b share the store's slot here, so the rollback to a's first
    // message takes b's later message with it.
    await framework.rollbackToMessage('a', { messageId: firstId });
    const { messages } = await cmOf('b').compile(budget, undefined, { dryRun: true });
    const texts = JSON.stringify(messages);
    assert.match(texts, /hello a/);
    assert.doesNotMatch(texts, /hello b/);
    assert.doesNotMatch(texts, /second a/);
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

  it("a fork created while an undo's managers re-initialize waits for them, and compiles", { timeout: 30_000 }, async () => {
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
      const order: string[] = [];
      const strategy = cmA.getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      strategy.initialize = async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await initialize(...args);
        order.push('template re-initialized');
      };
      const compile = cmA.compile.bind(cmA);
      (cmA as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) => {
        order.push('template compiled');
        return compile(...args);
      };
      assert.equal(framework.undoLastTurn('a').undone, true);
      assert.ok(internals.syncMoveReinit, 'the re-initialization is running');
      const fork = await internals.createConversationAgent('a-chan-g1', 'world:chan');
      (cmA as unknown as { compile: typeof compile }).compile = compile;
      assert.equal(internals.surgeryHold, null, 'the spawn finished after the store was let go');
      const reinitialized = order.indexOf('template re-initialized');
      assert.ok(reinitialized >= 0 && order.indexOf('template compiled', reinitialized) > reinitialized,
        `the seed read the template after its re-initialization: ${JSON.stringify(order)}`);
      const { messages } = await fork.getContextManager().compile({ maxTokens: 100_000, reserveForResponse: 1_000 }, undefined, { dryRun: true });
      const texts = messages.flatMap((m) => m.content)
        .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
        .map((b) => b.text);
      assert.deepEqual(texts, ['hello a'], 'seeded once from the landed branch, with nothing of the undone turn');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const budget = { maxTokens: 100_000, reserveForResponse: 1_000 };
  const textsOf = async (framework: AgentFramework, name: string): Promise<string[]> => {
    const { messages } = await framework.getAgent(name)!.getContextManager().compile(budget, undefined, { dryRun: true });
    return messages.flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
      .map((b) => b.text);
  };
  const withForks = async (prefix: string, run: (framework: AgentFramework, internals: ForkInternals, logged: string[]) => Promise<void>) => {
    const tempDir = mkdtempSync(join(tmpdir(), prefix));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
      ],
      modules: [],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
    });
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await run(framework, framework as unknown as ForkInternals, logged);
    } finally {
      console.error = quiet;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
  /** Template `a` says hello; a fork is spawned before a turn's checkpoint and
   *  one after it; each fork then writes a message of its own. */
  const forksAroundACheckpoint = async (framework: AgentFramework, internals: ForkInternals): Promise<number> => {
    const router = framework.getConversationRouter()!;
    const cmA = framework.getAgent('a')!.getContextManager();
    cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
    await internals.createConversationAgent('a-early-g1', 'world:early');
    router.bind('world:early', 'a-early-g1', 1);
    framework.getAgent('a-early-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'early own' }]);
    const sequenceBefore = framework.getStore().currentSequence();
    cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
    internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
    await internals.createConversationAgent('a-late-g1', 'world:late');
    router.bind('world:late', 'a-late-g1', 1);
    framework.getAgent('a-late-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late own' }]);
    return sequenceBefore;
  };
  const count = (texts: string[], text: string) => texts.filter((t) => t === text).length;

  it("an undo to before a fork was spawned seeds the fork again from the template; a redo brings back its own history; a fork spawned before that point keeps its own", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-reseed-', async (framework, internals, logged) => {
      await forksAroundACheckpoint(framework, internals);
      const router = framework.getConversationRouter()!;

      assert.equal(framework.undoLastTurn('a').undone, true);
      await internals.syncMoveReinit!.done;
      assert.equal(router.getBinding('world:late')?.agentName, 'a-late-g1', 'the fork stays, bound to its channel');
      const late = await textsOf(framework, 'a-late-g1');
      assert.equal(count(late, 'hello a'), 1, `seeded again from the template's compile on this branch: ${JSON.stringify(late)}`);
      assert.equal(count(late, 'a turn to undo'), 0, JSON.stringify(late));
      assert.equal(count(late, 'late own'), 0, JSON.stringify(late));
      const early = await textsOf(framework, 'a-early-g1');
      assert.ok(count(early, 'hello a') === 1 && count(early, 'early own') === 1, `the fork spawned before the point keeps its own, seeded once: ${JSON.stringify(early)}`);
      assert.equal(logged.filter((line) => /a-late-g1 had no messages on the branch the store moved to: seeded again from a/.test(line)).length, 1, logged.join('\n'));
      // RFC-006: the seeded copies count as consumed, as a seed at creation does.
      const lastSeeded = framework.getAgent('a-late-g1')!.getContextManager().getAllMessages().at(-1)!.sequence;
      const mark = framework.getAgent('a-late-g1')!.getConsumedWatermark();
      assert.equal(mark?.branch, framework.getStore().currentBranch().name, `the consumed mark is on the branch the undo landed on: ${JSON.stringify(mark)}`);
      assert.ok(mark !== null && mark.sequence >= lastSeeded, `the consumed mark covers the seeded copies: ${JSON.stringify(mark)}, last seeded ${lastSeeded}`);

      assert.equal(framework.redo('a').redone, true);
      await internals.syncMoveReinit!.done;
      const redone = await textsOf(framework, 'a-late-g1');
      assert.ok(redone.includes('late own') && redone.includes('a turn to undo'), `the redo brings back its own history: ${JSON.stringify(redone)}`);
      assert.equal(count(redone, 'hello a'), 1, `and seeds nothing over it: ${JSON.stringify(redone)}`);
      assert.equal(logged.filter((line) => /seeded again/.test(line)).length, 1, logged.join('\n'));
    });
  });

  it("a switch to a branch from before a fork was spawned seeds it again; a fork whose re-initialization fails there is reported, and not seeded", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-switch-', async (framework, internals, logged) => {
      const sequenceBefore = await forksAroundACheckpoint(framework, internals);
      await internals.createConversationAgent('a-bad-g1', 'world:bad');
      framework.getConversationRouter()!.bind('world:bad', 'a-bad-g1', 1);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      const bad = framework.getAgent('a-bad-g1')!.getContextManager().getStrategy() as unknown as { initialize: () => Promise<void> };
      bad.initialize = async () => { throw new Error('injected fork init failure'); };

      framework.getStore().createBranchAt('earlier', 'main', sequenceBefore);
      await framework.switchBranch('earlier');
      const late = await textsOf(framework, 'a-late-g1');
      assert.equal(count(late, 'hello a'), 1, JSON.stringify(late));
      assert.equal(count(late, 'late own'), 0, JSON.stringify(late));
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-bad-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /injected fork init failure/);
      assert.equal(framework.getAgent('a-bad-g1')!.getContextManager().getMessageCount(), 0, 'not seeded');
      assert.ok(!logged.some((line) => /a-bad-g1 had no messages/.test(line)), logged.join('\n'));
    });
  });

  it("a fork whose seeding fails after a move is disposed and reported, and the move stands", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-seedfail-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      // The template's compile, which a seeding reads, fails once the managers
      // are re-initialized.
      const cmA = framework.getAgent('a')!.getContextManager();
      const compile = cmA.compile.bind(cmA);
      (cmA as unknown as { compile: () => Promise<never> }).compile = async () => { throw new Error('injected template compile failure'); };
      try {
        assert.equal(framework.undoLastTurn('a').undone, true);
        await internals.syncMoveReinit!.done;
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /had no messages of its own, and it couldn't be seeded again, because its seeding from the template failed: .*injected template compile failure\. It was disposed and its channel unbound/);
      assert.match(reinit[0]!.message, /no agent reads them again, so a redo to a branch that holds them doesn't bring this one back\. The channel's next qualifying message spawns a new fork, under a new name, unless its seeding fails again\.$/);
      assert.doesNotMatch(reinit[0]!.message, /refuses its work/);
      assert.equal(internals.surgeryHold, null, 'the store is released');
      assert.ok(!framework.getAgent('a-late-g1'), 'the fork is disposed rather than left to answer with no history');
      const router = framework.getConversationRouter()!;
      assert.equal(router.getBinding('world:late'), undefined, 'its channel is unbound');
      const next = router.route({ channelId: 'world:late', mentioned: true, kind: 'channel' });
      assert.equal(next.kind, 'spawn', `the channel's next mention spawns a fresh fork: ${JSON.stringify(next)}`);
      assert.ok(framework.getAgent('a-early-g1'), 'the fork spawned before the point stays');
    });
  });

  it('a move is refused while a fork is being created, and goes through once it is', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-inflight-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      // Hold the spawn at the template's compile, which it makes before it
      // registers the fork.
      const compile = cmA.compile.bind(cmA);
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      (cmA as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) => {
        entered();
        await gate;
        return compile(...args);
      };
      const spawning = internals.createConversationAgent('a-chan-g1', 'world:chan');
      await reached;
      try {
        assert.throws(
          () => framework.undoLastTurn('a'),
          (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /a-chan-g1 is being created/.test(e.message),
        );
        await assert.rejects(
          framework.switchBranch('main'),
          (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /a-chan-g1 is being created/.test(e.message),
        );
      } finally {
        release();
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      await spawning;
      assert.equal(framework.undoLastTurn('a').undone, true);
      await internals.syncMoveReinit!.done;
      await textsOf(framework, 'a-chan-g1');
    });
  });

  it('a spawn that fails clears its name, so a move goes through after it', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-spawnfail-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      const compile = cmA.compile.bind(cmA);
      (cmA as unknown as { compile: () => Promise<never> }).compile = async () => { throw new Error('injected template compile failure'); };
      try {
        await assert.rejects(internals.createConversationAgent('a-chan-g1', 'world:chan'), /injected template compile failure/);
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      assert.equal(framework.undoLastTurn('a').undone, true, 'not refused as a fork being created');
      await internals.syncMoveReinit!.done;
    });
  });

  /** Takes the template's next compiles in order: 'throw' fails one; 'hold'
   *  waits at a gate until `release`, which says whether it then fails, and
   *  compiles after it; 'answer' compiles first and then waits at the gate
   *  with its answer. */
  const holdTemplateCompile = (framework: AgentFramework, calls: Array<'throw' | 'hold' | 'answer'>) => {
    const cmA = framework.getAgent('a')!.getContextManager();
    const compile = cmA.compile.bind(cmA);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holdThrows = false;
    (cmA as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) => {
      const call = calls.shift();
      if (call === 'throw') throw new Error('injected template compile failure');
      if (call === 'answer') {
        const answer = await compile(...args);
        entered();
        await gate;
        return answer;
      }
      if (call === 'hold') {
        entered();
        await gate;
        if (holdThrows) throw new Error('injected refusal after the store moved');
      }
      return compile(...args);
    };
    return {
      reached,
      release: (opts: { throws?: boolean } = {}) => { holdThrows = opts.throws === true; release(); },
      restore: () => { release(); (cmA as unknown as { compile: typeof compile }).compile = compile; },
    };
  };

  // The redo lands while the pass waits on the template's compile: after the
  // compile answered on the branch the pass judged, before a compile that
  // then runs on the branch the redo landed on, and before one that fails.
  const joinedSeeds = [
    { compile: 'answered before the move', call: 'answer', throws: false },
    { compile: 'runs after the move', call: 'hold', throws: false },
    { compile: 'throws after the move', call: 'hold', throws: true },
  ] as const;
  for (const joined of joinedSeeds) {
    it(`a redo that joins while a fork is being seeded again writes nothing to the branch it lands on, and disposes nothing (the template's compile ${joined.compile})`, { timeout: 30_000 }, async () => {
      await withForks('reinit-fork-joined-', async (framework, internals) => {
        await forksAroundACheckpoint(framework, internals);
        const alerts: string[] = [];
        framework.onTrace((event) => {
          if (event.type === 'ops:alert') alerts.push((event as unknown as { agentName: string }).agentName);
        });
        const held = holdTemplateCompile(framework, [joined.call]);
        try {
          assert.equal(framework.undoLastTurn('a').undone, true);
          const running = internals.syncMoveReinit!;
          await held.reached; // the pass is seeding a-late-g1, inside the template's compile
          assert.equal(framework.redo('a').redone, true, 'the redo joins the running re-initialization');
          held.release({ throws: joined.throws });
          await running.done;
        } finally {
          held.restore();
        }
        assert.equal(framework.getStore().currentBranch().name, 'main');
        assert.ok(framework.getAgent('a-late-g1'), 'not disposed');
        assert.equal(framework.getConversationRouter()!.getBinding('world:late')?.agentName, 'a-late-g1');
        const late = await textsOf(framework, 'a-late-g1');
        assert.equal(count(late, 'hello a'), 1, `no template copy stacked on its own history: ${JSON.stringify(late)}`);
        assert.equal(count(late, 'late own'), 1, JSON.stringify(late));
        assert.deepEqual(alerts, [], 'nothing reported');
      });
    });
  }

  it('a fork disposed in a pass that a later move joins is still reported', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-disposed-joined-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      await internals.createConversationAgent('a-late2-g1', 'world:late2');
      framework.getConversationRouter()!.bind('world:late2', 'a-late2-g1', 1);
      framework.getAgent('a-late2-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late2 own' }]);
      const alerts: Array<{ kind: string; agentName: string; message: string; data?: { after?: string } }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string; data?: { after?: string } });
      });
      // a-late-g1's seed fails; a-late2-g1's is held while a redo joins.
      const held = holdTemplateCompile(framework, ['throw', 'hold']);
      try {
        assert.equal(framework.undoLastTurn('a').undone, true);
        const running = internals.syncMoveReinit!;
        await held.reached;
        assert.equal(framework.redo('a').redone, true);
        held.release();
        await running.done;
      } finally {
        held.restore();
      }
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /because its seeding from the template failed: .*injected template compile failure/);
      // Reported under the move whose branch its pass judged, not the redo that joined later.
      assert.match(reinit[0]!.message, /^The undo moved the store's branch/);
      assert.equal(reinit[0]!.data?.after, 'undo');
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed in the first pass');
      const late2 = await textsOf(framework, 'a-late2-g1');
      assert.ok(count(late2, 'late2 own') === 1 && count(late2, 'hello a') === 1, `kept, with nothing stacked: ${JSON.stringify(late2)}`);
    });
  });

  it("a template whose own re-initialization fails: an empty fork is disposed, naming the template, and a fork with history is left alone", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-template-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      const strategy = framework.getAgent('a')!.getContextManager().getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      strategy.initialize = async () => { throw new Error('injected template init failure'); };
      try {
        assert.equal(framework.undoLastTurn('a').undone, true);
        await internals.syncMoveReinit!.done;
      } finally {
        strategy.initialize = initialize;
      }
      const byAgent = new Map(alerts.filter((alert) => alert.kind === 'context-reinit-failed').map((alert) => [alert.agentName, alert.message]));
      assert.deepEqual([...byAgent.keys()].sort(), ['a', 'a-late-g1'], JSON.stringify(alerts));
      assert.match(byAgent.get('a')!, /injected template init failure/);
      assert.match(byAgent.get('a-late-g1')!, /couldn't be seeded again, because the template a's own context manager failed to re-initialize \([^)]*injected template init failure[^)]*\)\. It was disposed/);
      // A spawn seeds from the template too, so the channel spawns again only once it's re-initialized.
      assert.match(byAgent.get('a-late-g1')!, /Once the template is re-initialized, which a switchBranch\(\) to the current branch or a restart does, the channel's next qualifying message spawns a new fork seeded from the template, under a new name\.$/);
      assert.match(byAgent.get('a-late-g1')!, /no agent reads them again/);
      assert.ok(!framework.getAgent('a-late-g1'), 'the empty fork is disposed');
      assert.equal(framework.getConversationRouter()!.getBinding('world:late'), undefined);
      assert.ok(framework.getAgent('a-early-g1'), 'the fork with history stays');
      assert.equal(framework.getConversationRouter()!.getBinding('world:early')?.agentName, 'a-early-g1');
    });
  });

  it("a template refusal in a pass an undo joins disposes nothing, and the next pass seeds the fork the joined undo emptied", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-template-joined-', async (framework, internals) => {
      // Two of a's turns: a-late-g1 is spawned between them, so the first
      // undo leaves it its history and the second, which joins, empties it.
      const store = framework.getStore();
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const turn1 = { agentName: 'a', turnIndex: 1, sequenceBefore: store.currentSequence(), branchName: 'main', timestamp: Date.now() };
      cmA.addMessage('user', [{ type: 'text', text: 'a turn one' }]);
      internals.saveTurnCheckpoints('a', [turn1]);
      await internals.createConversationAgent('a-late-g1', 'world:late');
      framework.getConversationRouter()!.bind('world:late', 'a-late-g1', 1);
      framework.getAgent('a-late-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late own' }]);
      const turn2 = { agentName: 'a', turnIndex: 2, sequenceBefore: store.currentSequence(), branchName: 'main', timestamp: Date.now() };
      cmA.addMessage('user', [{ type: 'text', text: 'a turn two' }]);
      internals.saveTurnCheckpoints('a', [turn1, turn2]);

      const alerts: Array<{ kind: string; agentName: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string });
      });
      // The template's first re-initialization waits, and then refuses, as one
      // can when the store moves under it; later ones run as usual.
      const strategy = cmA.getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      strategy.initialize = async (...args: unknown[]) => {
        if (++calls > 1) return initialize(...args);
        entered();
        await gate;
        throw new Error('injected refusal after the store moved');
      };
      // The managers re-initialize one at a time, the template first, so
      // a-late-g1's comes after the second undo has joined, and the pass
      // judges it, rather than skipping it as failed.
      try {
        assert.equal(framework.undoLastTurn('a').undone, true, 'the first undo keeps a-late-g1 its history');
        const running = internals.syncMoveReinit!;
        await reached; // the first pass is re-initializing the template
        assert.equal(framework.undoLastTurn('a').undone, true, 'the second undo joins, to before a-late-g1 was spawned');
        release();
        await running.done;
      } finally {
        strategy.initialize = initialize;
      }
      assert.deepEqual(alerts.filter((alert) => alert.kind === 'context-reinit-failed'), [], 'nothing reported: the refusal came in a pass a move joined');
      assert.ok(framework.getAgent('a-late-g1'), 'not disposed');
      assert.equal(framework.getConversationRouter()!.getBinding('world:late')?.agentName, 'a-late-g1');
      const late = await textsOf(framework, 'a-late-g1');
      assert.equal(count(late, 'hello a'), 1, `seeded again by the next pass, from the template: ${JSON.stringify(late)}`);
      assert.equal(count(late, 'late own'), 0, JSON.stringify(late));
    });
  });

  it('a missing template: an empty fork is disposed, naming it, and a fork with history is left alone', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-notemplate-', async (framework, internals) => {
      const sequenceBefore = await forksAroundACheckpoint(framework, internals);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      (framework as unknown as { agents: Map<string, unknown> }).agents.delete('a');
      framework.getStore().createBranchAt('earlier', 'main', sequenceBefore);
      await framework.switchBranch('earlier');
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /couldn't be seeded again, because no agent is registered as the conversation template "a"\. It was disposed/);
      assert.match(reinit[0]!.message, /Once an agent is registered under that name, or the conversation router is configured with a registered template, the channel's next qualifying message spawns a new fork seeded from the template, under a new name\.$/);
      assert.ok(!framework.getAgent('a-late-g1'), 'the empty fork is disposed');
      assert.ok(framework.getAgent('a-early-g1'), 'the fork with history stays');
    });
  });

  it('a conversation agent created over a namespace that already holds history is not seeded again, even when that history compiles to nothing', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-recreate-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      await internals.createConversationAgent('a-chan-g1', 'world:chan');
      const stored = framework.getAgent('a-chan-g1')!.getContextManager().getMessageCount();
      assert.ok(stored > 0, 'seeded once');
      // The name comes round again over the same namespace, as when the
      // router's counter wasn't stored (agent-framework's F50 case).
      const forget = framework as unknown as { disposeConversationAgent(name: string): void; usedEphemeralAgentNames: Set<string> };
      forget.disposeConversationAgent('a-chan-g1');
      forget.usedEphemeralAgentNames.delete('a-chan-g1');
      // Every compile but the template's reads as empty, as a history that is
      // hidden or past its window does.
      const proto = Object.getPrototypeOf(cmA) as { compile: (...args: unknown[]) => Promise<{ messages: unknown[] }> };
      const compile = proto.compile;
      proto.compile = async function (this: unknown, ...args: unknown[]) {
        const result = await compile.apply(this, args);
        return this === cmA ? result : { ...result, messages: [] };
      };
      try {
        await internals.createConversationAgent('a-chan-g1', 'world:chan');
      } finally {
        proto.compile = compile;
      }
      assert.equal(framework.getAgent('a-chan-g1')!.getContextManager().getMessageCount(), stored, 'no second copy of the template');
    });
  });

  for (const shape of ['history compiles to nothing', 'compile throws'] as const) {
    it(`a fork with stored history on the landed branch is neither seeded again nor disposed when its ${shape}`, { timeout: 30_000 }, async () => {
      await withForks('reinit-fork-hashistory-', async (framework, internals) => {
        await forksAroundACheckpoint(framework, internals);
        const alerts: string[] = [];
        framework.onTrace((event) => {
          if (event.type === 'ops:alert') alerts.push((event as unknown as { agentName: string }).agentName);
        });
        const early = framework.getAgent('a-early-g1')!.getContextManager();
        const stored = early.getMessageCount();
        const compile = early.compile.bind(early);
        let compiled = 0;
        (early as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) => {
          compiled++;
          if (shape === 'compile throws') throw new Error('injected fork compile failure');
          return { ...(await compile(...args)), messages: [] };
        };
        try {
          assert.equal(framework.undoLastTurn('a').undone, true);
          await internals.syncMoveReinit!.done;
        } finally {
          (early as unknown as { compile: typeof compile }).compile = compile;
        }
        assert.equal(compiled, 0, 'the re-seed never compiles a fork that has history');
        assert.ok(framework.getAgent('a-early-g1'), 'not disposed');
        assert.equal(early.getMessageCount(), stored, 'nothing seeded over its history');
        assert.ok(!alerts.includes('a-early-g1'), JSON.stringify(alerts));
      });
    });
  }

  type Placement = { agent: string; messageId?: string; deferredId?: string };
  type HoldInternals = ForkInternals & {
    maintenancePass: Promise<void> | null;
    handleMcplChannelIncoming(event: unknown): Promise<Placement | undefined>;
    resolvePlacement(placement: Placement): void;
    lastConversationSweep: number;
    sweepExpiredConversations(): void;
  };
  const channelMessage = (channelId: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'mcpl:channel-incoming',
    serverId: 'world',
    channelId,
    messageId: `m-${text.toLowerCase().replace(/\W+/g, '-')}`,
    author: { id: 'U1', name: 'alice' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: { mentioned: true },
    triggerInference: false,
    ...extra,
  });
  const storedTexts = (cm: ContextManager): string[] => cm.getAllMessages().flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map((b) => b.text);
  /** Hold a maintenance pass across `move()`, run `during()` while the move
   *  waits for it, then let it go and wait for the move to finish. */
  const duringMaintenanceWait = async (internals: HoldInternals, move: () => Promise<unknown>, during: () => Promise<void>): Promise<void> => {
    const { promise: pass, settle, waited } = watchedPromise();
    internals.maintenancePass = pass;
    let moved: Promise<unknown> | undefined;
    try {
      moved = move();
      await settled();
      assert.ok(waited(), 'the move waits on the running maintenance pass');
      await during();
    } finally {
      settle();
      internals.maintenancePass = null;
    }
    await moved;
    await internals.syncMoveReinit?.done;
  };

  it("while an undo waits for running maintenance, a fork's channel message and a correction for it are deferred, and land after it's seeded again", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-writes-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const placements: Array<Placement | undefined> = [];
      await duringMaintenanceWait(internals, async () => assert.equal(framework.undoLastTurn('a').undone, true), async () => {
        placements.push(await internals.handleMcplChannelIncoming(channelMessage('world:late', 'MESSAGE DURING THE UNDO')));
        placements.push(await internals.handleMcplChannelIncoming(channelMessage('world:late', 'CORRECTION DURING THE UNDO', { deliverTo: 'a-late-g1' })));
        for (const placement of placements) {
          assert.ok(placement?.deferredId && !placement.messageId, `deferred, not stored: ${JSON.stringify(placement)}`);
        }
        assert.deepEqual(storedTexts(framework.getAgent('a-late-g1')!.getContextManager()), [], 'nothing written into the emptied fork during the wait');
      });
      assert.deepEqual(await textsOf(framework, 'a-late-g1'), ['hello a', 'MESSAGE DURING THE UNDO', 'CORRECTION DURING THE UNDO'],
        'seeded from the template on the landed branch, then the two writes');
      for (const placement of placements) {
        internals.resolvePlacement(placement!);
        assert.ok(placement!.messageId && !placement!.deferredId, `the placement resolves to the stored message: ${JSON.stringify(placement)}`);
      }
    });
  });

  it("while an undo waits for running maintenance, a fork's idle-TTL closure prompt is deferred, and lands after it's seeded again", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-closure-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const late = framework.getAgent('a-late-g1')!.getContextManager();
      const prompt = framework.getConversationRouter()!.closurePrompt;
      await duringMaintenanceWait(internals, async () => assert.equal(framework.undoLastTurn('a').undone, true), async () => {
        framework.getConversationRouter()!.getBinding('world:late')!.lastActivity = 0;
        internals.lastConversationSweep = 0;
        internals.sweepExpiredConversations();
        assert.deepEqual(storedTexts(late), [], 'the closure prompt is not written into the emptied fork during the wait');
      });
      const texts = storedTexts(late);
      assert.deepEqual(texts.slice(0, 2), ['hello a', prompt], `seeded first, then the closure prompt: ${JSON.stringify(texts)}`);
    });
  });

  it("while a rollback waits for running maintenance, a fork's channel message is deferred, and lands on the branch the rollback moves to", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-rollback-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const point = framework.getAgent('a')!.getContextManager().getAllMessages()
        .find((m) => m.content.some((b) => (b as { text?: string }).text === 'hello a'))!;
      const source = framework.getStore().currentBranch().name;
      let placement: Placement | undefined;
      await duringMaintenanceWait(internals, () => framework.rollbackToMessage('a', { messageId: point.id }), async () => {
        placement = await internals.handleMcplChannelIncoming(channelMessage('world:early', 'MESSAGE DURING THE ROLLBACK'));
        assert.ok(placement?.deferredId && !placement.messageId, `deferred, not stored: ${JSON.stringify(placement)}`);
      });
      assert.notEqual(framework.getStore().currentBranch().name, source, 'the rollback moved the store');
      const early = await textsOf(framework, 'a-early-g1');
      assert.equal(count(early, 'MESSAGE DURING THE ROLLBACK'), 1, `on the branch the rollback moved to: ${JSON.stringify(early)}`);
    });
  });

  it("a re-seed whose template compile spans a move it didn't make writes nothing, and the fork is disposed and reported", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-foreign-move-', async (framework, forkInternals, logged) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const store = framework.getStore();
      const cmA = framework.getAgent('a')!.getContextManager();
      const late = framework.getAgent('a-late-g1')!.getContextManager();
      const compile = cmA.compile.bind(cmA);
      // The template's own manager moves the store between the seed's compile
      // and its write, as a host moving through an agent's context manager can.
      (cmA as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) => {
        const compiled = await compile(...args);
        (cmA as unknown as { compile: typeof compile }).compile = compile;
        store.createBranchAt('elsewhere', store.currentBranch().name, store.currentSequence());
        await cmA.switchBranch('elsewhere');
        return compiled;
      };
      try {
        assert.equal(framework.undoLastTurn('a').undone, true);
        await forkInternals.syncMoveReinit!.done;
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      assert.equal(store.currentBranch().name, 'elsewhere');
      assert.deepEqual(storedTexts(late), [], 'nothing seeded from the compile of the branch the store left');
      assert.ok(!framework.getAgent('a-late-g1'), 'the fork is disposed');
      assert.ok(logged.some((line) => /agent=a-late-g1 .*couldn't be seeded again, because its seeding from the template failed: Error: the store moved to another branch while it was being seeded\./.test(line)),
        logged.join('\n'));
    });
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
        // No clock bounds a correct re-initialization here: a hang fails at
        // the test's own timeout, which names the test.
        await running.done;
        assert.equal(internals.surgeryHold, null, `${label}: the store is released`);
      };
      const waitParked = async () => {
        while (gate().auxiliaryWaiters.length !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
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

/**
 * A strategy whose next tick, once armed, waits for the test; once `stale`
 * is set (as a move leaves a manager), its tick and readiness refuse as a
 * manager loaded for an earlier branch generation does, until it is
 * initialized again.
 */
class GatedTickStrategy implements ContextStrategy {
  readonly name = 'gated-tick-test';
  armed = false;
  stale = false;
  throwOnStale = true;
  /** Thrown by the tick once released, whatever the generation: a failure of the tick's own. */
  failure?: Error;
  entered = false;
  release?: () => void;

  checkReadiness(): ReadinessState {
    if (this.stale) throw new Error('GatedTickStrategy.checkReadiness requires reinitialization for the current branch generation');
    return this.armed ? { ready: false, description: 'a tick is due' } : { ready: true };
  }

  async initialize(): Promise<void> {
    this.stale = false;
  }

  async tick(_ctx: StrategyContext): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.entered = true;
    await new Promise<void>((resolve) => { this.release = resolve; });
    if (this.failure) throw this.failure;
    if (this.stale && this.throwOnStale) throw new Error('GatedTickStrategy.tick requires reinitialization for the current branch generation');
  }

  select(_store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] {
    return [];
  }
}

describe('an undo while a maintenance tick runs', () => {
  for (const where of ['the tick', 'the readiness read after it', 'a provider failure in the tick'] as const) {
    it(`raises no maintenance-failure alert when ${where} meets the moved store`, { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'reinit-tick-'));
      const gated = new GatedTickStrategy();
      gated.throwOnStale = where === 'the tick';
      // A failure of the tick's own, in a tick the move landed under: its work
      // was for the branch the store left, so it is withdrawn too.
      if (where === 'a provider failure in the tick') gated.failure = new Error('provider exploded');
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [
          { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
          { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: gated },
        ],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      const alerts: string[] = [];
      (framework as unknown as { opsAlert: (kind: string, agentName: string, message: string) => void }).opsAlert =
        (kind, agentName, message) => alerts.push(`${kind}:${agentName}:${message}`);
      const internals = framework as unknown as {
        syncMoveReinit: { done: Promise<void> } | null;
        saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
      };
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      const quiet = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await framework.quiesce();
        framework.start();
        gated.armed = true;
        const start = Date.now();
        while (!gated.entered) {
          if (Date.now() - start > 8_000) throw new Error("b's tick never started");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(framework.undoLastTurn('a').undone, true);
        const running = internals.syncMoveReinit;
        assert.ok(running, 'a re-initialization is running');
        // The move leaves b's manager on the old generation until its pass.
        gated.stale = true;
        gated.release!();
        await running.done;
        assert.deepEqual(alerts.filter((alert) => alert.startsWith('context-maintenance-failed')), []);
        if (where === 'a provider failure in the tick') {
          assert.ok(logged.some((line) => /agent=b stopped: an undo moved the store under the tick: provider exploded/.test(line)), logged.join('\n'));
        }
        assert.equal(gated.stale, false, "b's manager was re-initialized");
        assert.equal(framework.getAgent('b')!.getContextManager().isReady(), true);
      } finally {
        console.error = quiet;
        gated.release?.();
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
