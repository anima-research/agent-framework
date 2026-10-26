import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager as StoreWindow, PassthroughStrategy } from '@animalabs/context-manager';
import { JsStore } from '@animalabs/chronicle';
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
import type { Module, ModuleContext } from '../src/index.js';
import {
  REINIT_MOVES, TEMPLATE_REMEDIES, disposalAlert, longHoldAlert, opsWebhookText, refusedWorkAlert, restoreAlert, type AgentKind,
  type ReinitAlertText,
} from '../src/framework.js';
import type { TraceEvent } from '../src/index.js';
import { ApiServer } from '../src/api/server.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function autobiographical(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

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
const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const captureWebhook = () => {
  const hook = process.env.CONNECTOME_OPS_WEBHOOK;
  const realFetch = globalThis.fetch;
  const posted: string[] = [];
  process.env.CONNECTOME_OPS_WEBHOOK = 'http://zz.invalid/hook';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(JSON.parse(String(init?.body)).content);
    return new Response(null);
  }) as typeof fetch;
  return {
    posted,
    restore: () => {
      globalThis.fetch = realFetch;
      if (hook === undefined) delete process.env.CONNECTOME_OPS_WEBHOOK; else process.env.CONNECTOME_OPS_WEBHOOK = hook;
    },
  };
};
const keptHead = (posted: string[], agentName: string, kind: string): string => {
  const prefix = `\u{1F6A8} **${agentName}** ${kind}: `;
  const posts = posted.filter((post) => post.startsWith(prefix));
  assert.equal(posts.length, 1, JSON.stringify(posted.map((post) => post.slice(0, 80))));
  const marker = posts[0]!.indexOf(' …[');
  assert.ok(marker > 0, `the post was cut: ${posts[0]}`);
  return posts[0]!.slice(prefix.length, marker);
};
const until = async (check: () => boolean, what: string, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

type Internals = {
  surgeryHold: { verb: string } | null;
  activeTurnTokens: Map<string, number>;
  syncMoveReinit: unknown;
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
  const budget = { maxTokens: 100_000, reserveForResponse: 1_000 };
  const works = async (name: string): Promise<void> => {
    await cmOf(name).compile(budget, undefined, { dryRun: true });
    assert.equal(typeof cmOf(name).isReady(), 'boolean');
  };
  const checkpointTurn = (): void => {
    const sequenceBefore = framework.getStore().currentSequence();
    cmOf('a').addMessage('user', text('a turn to undo'));
    internals().saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
  };
  const reinitDone = async (moved: { settled?: Promise<void> }): Promise<void> => {
    assert.ok(moved.settled, 'a move answers with the promise of its re-initialization');
    await moved.settled;
  };
  const reinitAlerts = () => traces.filter(
    (t): t is Extract<TraceEvent, { type: 'ops:alert' }> => t.type === 'ops:alert' && t.kind === 'context-reinit-failed',
  );
  const longHoldAlerts = () => traces.filter(
    (t): t is Extract<TraceEvent, { type: 'ops:alert' }> => t.type === 'ops:alert' && t.kind === 'store-held-long',
  );
  const shortenHoldAlert = (ms: number): void => {
    (framework as unknown as { holdAlertMs: number }).holdAlertMs = ms;
  };
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
    await reinitDone(r);
    assert.equal(internals().surgeryHold, null);
    assert.equal(internals().activeTurnTokens.size, 0, 'the reservation is released');
    await works('a');
    await works('b');
  });

  it('redo(): both compile once the store is released', async () => {
    checkpointTurn();
    await reinitDone(framework.undoLastTurn('a'));
    const r = framework.redo('a');
    assert.equal(r.redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.ok(internals().surgeryHold);
    await reinitDone(r);
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
    await assert.rejects(
      framework.rollbackToMessage('a', { messageId: firstId }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /live undo for a/.test(e.message),
    );
    assert.equal(redone.settled, undone.settled, "the redo moves the store under the undo's reservation, and settles with it");
    await reinitDone(redone);
    assert.equal(internals().syncMoveReinit, null);
    assert.equal(internals().activeTurnTokens.size, 0);
    await works('a');
    await works('b');
    assert.deepEqual(reinitAlerts(), [], 'the pass the redo overtook is not reported');
  });

  it("the API server's undo and redo tell clients of the move once every manager is current, so a client that reads an agent's context then gets it", async () => {
    checkpointTurn();
    const api = new ApiServer(framework) as unknown as {
      cmdUndo(params: { agentName: string }): Promise<Record<string, unknown>>;
      cmdRedo(params: { agentName: string }): Promise<Record<string, unknown>>;
      cmdAgentContext(params: { agentName: string }): Promise<{ context: unknown[] }>;
      broadcast(event: string, data: unknown): void;
    };
    const held: boolean[] = [];
    const reads: Array<Promise<{ context: unknown[] }>> = [];
    api.broadcast = (event) => {
      if (event !== 'branch:switched') return;
      held.push(internals().surgeryHold !== null);
      reads.push(api.cmdAgentContext({ agentName: 'b' }));
    };
    const undone = await api.cmdUndo({ agentName: 'a' });
    assert.equal(undone.undone, true);
    assert.ok(!('settled' in undone), `the answer carries no promise: ${Object.keys(undone).join(', ')}`);
    const redone = await api.cmdRedo({ agentName: 'a' });
    assert.equal(redone.redone, true);
    assert.ok(!('settled' in redone), `the answer carries no promise: ${Object.keys(redone).join(', ')}`);
    assert.deepEqual(held, [false, false], 'each event goes once the store is let go');
    for (const read of await Promise.all(reads)) assert.ok(read.context.length > 0, "b's context compiled");
    assert.deepEqual(reinitAlerts(), []);
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
    await reinitDone(framework.undoLastTurn('a'));
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

  it('a message deferred during the hold for an agent whose re-initialization fails stays queued at the release, and is stored once the agent recovers', async () => {
    checkpointTurn();
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    const queue = framework as unknown as {
      addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
      deferredMessages: Array<{ forAgent?: string }>;
    };
    const held = 'for b, during the hold';
    const textsOfB = () => cmOf('b').getAllMessages()
      .flatMap((m) => m.content)
      .flatMap((block) => (block.type === 'text' ? [block.text] : []));

    const undone = framework.undoLastTurn('a');
    assert.equal(undone.undone, true);
    assert.ok(internals().surgeryHold, 'the undo holds the store while the managers re-initialize');
    assert.equal(queue.addMessage('user', text(held), undefined, { forAgent: 'b' }), '', 'deferred, not stored');
    await reinitDone(undone);
    assert.deepEqual(reinitAlerts().map((alert) => alert.agentName), ['b']);
    assert.equal(internals().surgeryHold, null, 'the store is released');
    assert.deepEqual(queue.deferredMessages.map((m) => m.forAgent), ['b'], 'still queued for b after the release');
    assert.ok(!textsOfB().includes(held));

    await framework.switchBranch(framework.getStore().currentBranch().name);
    await works('b');
    assert.deepEqual(queue.deferredMessages, [], 'nothing is left queued');
    assert.equal(textsOfB().filter((t) => t === held).length, 1, 'stored once, in b\'s window');
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

  it("a run whose manager fails to re-initialize is told that a restart ends the run, as it was when it failed", async () => {
    checkpointTurn();
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const internals = framework as unknown as {
      agents: Map<string, unknown>;
      ephemeralRuns: Map<string, unknown>;
      reportReinitFailures: (...args: unknown[]) => void;
    };
    const b = internals.agents.get('b');
    internals.ephemeralRuns.set('b', {
      settle: { promise: new Promise(() => {}), resolve() {}, reject() {} }, inferenceStarted: false, lastActivity: Date.now(), toolCallsCount: 0,
    });
    const report = internals.reportReinitFailures.bind(framework);
    internals.reportReinitFailures = (...args: unknown[]) => {
      internals.ephemeralRuns.delete('b');
      internals.agents.delete('b');
      report(...args);
    };
    try {
      await reinitDone(framework.undoLastTurn('a'));
    } finally {
      internals.ephemeralRuns.delete('b');
      internals.agents.set('b', b);
    }
    const alerts = reinitAlerts();
    assert.deepEqual(alerts.map((alert) => alert.agentName), ['b']);
    assert.match(alerts[0]!.message, /; a restart ends the run\. The work it refuses includes compiles and message writes\. Its re-initialization failed: .*injected initialization failure/);
  });

  it("a run that ends during its own re-initialization, which then fails, isn't reported", async () => {
    checkpointTurn();
    const internals = framework as unknown as { agents: Map<string, unknown>; ephemeralRuns: Map<string, unknown> };
    const b = internals.agents.get('b');
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    let initialized = false;
    strategy.initialize = async () => {
      initialized = true;
      internals.agents.delete('b');
      internals.ephemeralRuns.delete('b');
      throw new Error('injected initialization failure');
    };
    internals.ephemeralRuns.set('b', {
      settle: { promise: new Promise(() => {}), resolve() {}, reject() {} }, inferenceStarted: false, lastActivity: Date.now(), toolCallsCount: 0,
    });
    try {
      await reinitDone(framework.undoLastTurn('a'));
    } finally {
      internals.ephemeralRuns.delete('b');
      internals.agents.set('b', b);
    }
    assert.equal(initialized, true, "b's re-initialization ran");
    assert.deepEqual(reinitAlerts(), []);
  });

  for (const during of ['switch', 'restore'] as const) {
    it(`a run named by a rollback whose restore fails, and which ends during the rollback's ${during}, is told a restart ends the run`, async () => {
      const internals = framework as unknown as { agents: Map<string, unknown>; ephemeralRuns: Map<string, unknown> };
      const agentA = internals.agents.get('a');
      let ended: 'switch' | 'restore' | undefined;
      const end = (where: 'switch' | 'restore') => {
        ended = where;
        internals.ephemeralRuns.delete('a');
        internals.agents.delete('a');
      };
      const a = cmOf('a') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
      const initializeStrategy = a.initializeStrategy;
      a.initializeStrategy = async function () {
        if (during === 'switch') end('switch');
        throw new Error('injected strategy init failure');
      };
      internals.ephemeralRuns.set('a', {
        settle: { promise: new Promise(() => {}), resolve() {}, reject() {} }, inferenceStarted: false, lastActivity: Date.now(), toolCallsCount: 0,
      });
      const store = framework.getStore() as unknown as { switchBranch: (name: string) => void };
      const switchBranch = store.switchBranch;
      store.switchBranch = function (this: unknown, name: string) {
        if (name === 'main') {
          if (during === 'restore') end('restore');
          throw new Error('injected restore refusal');
        }
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
        internals.ephemeralRuns.delete('a');
        internals.agents.set('a', agentA);
      }
      assert.equal(ended, during, `the run ended during the rollback's ${during}`);
      assert.match(message, /RESTORE TO main ALSO FAILED \(injected restore refusal\); the store is still on failed-thrice, and the agent refuses its work until switchBranch\(\) to main re-initializes it \(a restart ends the run instead\)/);
      const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
      assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
      assert.match(alerts[0]!.message, /^The rollback failed and the store couldn't be put back, so this agent's context manager refuses its work until switchBranch\(\) to the branch it should run on re-initializes it and stores its queued writes, at resume on a quiesced host; a restart ends the run\. The work it refuses includes compiles and message writes\. The store is on failed-thrice/);
    });
  }

  it("the alert's remedy says a restart loses the writes kept queued, and stop() says how many it leaves for an agent whose manager refuses them", async () => {
    checkpointTurn();
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const queue = framework as unknown as {
      addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
    };
    const undone = framework.undoLastTurn('a');
    assert.equal(queue.addMessage('user', text('for b, during the hold'), undefined, { forAgent: 'b' }), '', 'deferred, not stored');
    assert.equal(queue.addMessage('user', text('for a, during the hold'), undefined, { forAgent: 'a' }), '', 'deferred, not stored');
    await reinitDone(undone);
    const alerts = reinitAlerts();
    assert.deepEqual(alerts.map((alert) => alert.agentName), ['b']);
    assert.match(alerts[0]!.message, /^The undo moved the store's branch, and this agent's context manager failed to re-initialize\. It refuses its work until switchBranch\(\) to the current branch re-initializes it and stores its queued writes, at resume on a quiesced host; a restart re-initializes it too, but loses them unless the deferral queue is persisted\. The work it refuses includes compiles and message writes\. Quiescing the host before it stops persists the deferral queue\. Its re-initialization failed: .*injected initialization failure\.$/);
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await framework.stop();
    } finally {
      console.error = quiet;
    }
    assert.ok(
      logged.some((line) => line === '[deferral] stop: 1 deferred write(s) for b stay queued, not stored by the flush above; this memory-only queue loses them at exit'),
      logged.join('\n'),
    );
    assert.ok(!logged.some((line) => /write\(s\) for a stay queued/.test(line)), `nothing is said for a, whose write the release stored: ${logged.join('\n')}`);
  });

  for (const record of ['current', 'behind'] as const) {
    it(`stop() says a persisted queue whose record is ${record} ${record === 'current' ? 'keeps' : 'can lose'} the writes it leaves for an agent whose manager refuses them`, async () => {
      checkpointTurn();
      const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      strategy.initialize = async () => { throw new Error('injected initialization failure'); };
      const fw = framework as unknown as {
        addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
        deferredWritesPersisted: boolean;
        writeDeferredWrites: () => unknown;
      };
      const undone = framework.undoLastTurn('a');
      assert.equal(fw.addMessage('user', text('for b, during the hold'), undefined, { forAgent: 'b' }), '', 'deferred, not stored');
      await reinitDone(undone);
      fw.deferredWritesPersisted = true;
      if (record === 'behind') fw.writeDeferredWrites = () => { throw new Error('injected record write failure'); };
      const logged: string[] = [];
      const quiet = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await framework.stop();
      } finally {
        console.error = quiet;
      }
      assert.ok(logged.includes('[deferral] stop: 1 deferred write(s) for b stay queued, not stored by the flush above; ' + (record === 'current'
        ? 'the persisted queue keeps them for boot'
        : "the persisted queue's record is behind, since its last write failed or met the cap, so a restart can lose them")),
      logged.join('\n'));
    });
  }

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

    await reinitDone(framework.undoLastTurn('a'));
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
    await reinitDone(redone);
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
        await reinitDone(framework.undoLastTurn('a'));
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
      if (calls === 1) throw new Error('injected first-pass failure');
      return initialize(...args);
    };
    checkpointTurn();
    framework.undoLastTurn('a');
    await reinitDone(framework.redo('a'));
    assert.deepEqual(reinitAlerts(), [], 'the overtaken pass is not reported');
    await works('b');

    let failAll = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failAll) throw new Error('injected last-pass failure');
      return initialize(...args);
    };
    framework.undoLastTurn('a');
    await reinitDone(framework.redo('a'));
    failAll = false;
    const alerts = reinitAlerts();
    assert.equal(alerts.length, 1, JSON.stringify(alerts));
    assert.match(alerts[0]!.message, /The redo moved the store's branch/);
  });

  it("a hold's reporter, called during the pass, names the move, its agent, the manager the pass is on and the writes waiting", async () => {
    checkpointTurn();
    const fw = framework as unknown as { reportLongHold(hold: unknown): void };
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let calls = 0;
    let atGate = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    strategy.initialize = async (...args: unknown[]) => {
      if (++calls === 2) {
        atGate = true;
        await gate;
      }
      return initialize(...args);
    };
    const queue = framework as unknown as {
      addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
    };
    const undone = framework.undoLastTurn('a');
    const redone = framework.redo('a');
    assert.equal(redone.settled, undone.settled, 'one reservation, one pass that runs again');
    try {
      await until(() => atGate, "b's second re-initialization to reach its gate", 10_000);
      assert.equal(queue.addMessage('user', text('for a, during the hold'), undefined, { forAgent: 'a' }), '', 'deferred, not stored');
      const hold = internals().surgeryHold;
      assert.ok(hold, 'the store is held');
      fw.reportLongHold(hold);
      assert.equal(longHoldAlerts().length, 1, JSON.stringify(longHoldAlerts()));
      const [alert] = longHoldAlerts();
      assert.equal(alert!.agentName, 'a');
      assert.match(alert!.message, /^The undo has held the store for \d+ s, so no turn starts and the writes it defers wait in the deferral queue \(1 write now\)\. A restart ends the undo, the conversation agents and the runs, and re-initializes the configured agents; writes still queued at exit survive only in a persisted deferral queue\. The undo is for a, and is re-initializing b's context manager now\.$/);
      const data = alert!.data as { verb?: string; reinitializing?: string; queued?: number; heldMs?: number; waitingForMaintenance?: boolean };
      assert.equal(data.verb, 'undo');
      assert.equal(data.reinitializing, 'b');
      assert.equal(data.waitingForMaintenance, undefined);
      assert.equal(data.queued, 1);
      assert.ok(typeof data.heldMs === 'number' && data.heldMs >= 0, JSON.stringify(data));
    } finally {
      release();
    }
    await reinitDone(redone);
    assert.equal(longHoldAlerts().length, 1, 'its timer, at the default threshold, went with the hold');
    assert.deepEqual(reinitAlerts(), []);
    await works('b');
  });

  it("a rollback still waiting for maintenance that was running when it took the store raises the alert, saying that's what it waits on", async () => {
    shortenHoldAlert(1_000);
    const { promise: pass, settle, waited } = watchedPromise();
    const fw = framework as unknown as { maintenancePass: Promise<void> | null };
    fw.maintenancePass = pass;
    let rolled: Promise<unknown> | undefined;
    try {
      rolled = framework.rollbackToMessage('a', { messageId: firstId });
      await settled();
      assert.ok(waited(), 'the rollback waits on the running maintenance pass');
      await until(() => longHoldAlerts().length > 0, 'the store-held-long alert', 10_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(longHoldAlerts().length, 1, JSON.stringify(longHoldAlerts()));
      const [alert] = longHoldAlerts();
      assert.equal(alert!.agentName, 'a');
      // The alert comes at its threshold, not before. The hold is measured
      // by Date.now() and the timer runs on libuv's clock, each to the whole
      // millisecond, so it can read just under 1,000 (as tool-result-guard's
      // duration check allows).
      assert.ok(((alert!.data as { heldMs?: number }).heldMs ?? 0) >= 1_000 - 5, JSON.stringify(alert!.data));
      assert.match(alert!.message, /^The rollback has held the store for \d+ s, so no turn starts .* The rollback is for a, and is waiting for maintenance work that was already running to finish\.$/);
      const data = alert!.data as { verb?: string; reinitializing?: string; waitingForMaintenance?: boolean };
      assert.equal(data.verb, 'roll back');
      assert.equal(data.waitingForMaintenance, true);
      assert.equal(data.reinitializing, undefined);
    } finally {
      settle();
      fw.maintenancePass = null;
    }
    await rolled;
    assert.equal(longHoldAlerts().length, 1, 'nothing more once the store is let go');
    assert.deepEqual(reinitAlerts(), []);
    await works('b');
  });

  it("a branch switch still holding the store for its config mount after its pass names no manager", async () => {
    const fw = framework as unknown as {
      moduleRegistry: { getModule(name: string): unknown };
      reportLongHold(hold: unknown): void;
    };
    const getModule = fw.moduleRegistry.getModule.bind(fw.moduleRegistry);
    let mounted!: () => void;
    const mount = new Promise<void>((resolve) => { mounted = resolve; });
    fw.moduleRegistry.getModule = (name: string) =>
      name === 'workspace' ? { materializeMount: async () => { await mount; } } : getModule(name);
    let reinitialized = 0;
    for (const name of ['a', 'b']) {
      const cm = cmOf(name) as unknown as { setStrategy: (s: unknown) => Promise<void> };
      const setStrategy = cm.setStrategy.bind(cm);
      cm.setStrategy = async (strategy: unknown) => {
        try { return await setStrategy(strategy); } finally { reinitialized++; }
      };
    }
    let switching: Promise<void> | undefined;
    try {
      switching = framework.switchBranch(framework.getStore().currentBranch().name);
      await until(() => reinitialized === 2, "the pass's re-initialization of both managers", 10_000);
      const hold = (internals() as unknown as { surgeryHold: { reinitializing?: string } | null }).surgeryHold;
      assert.ok(hold, 'the store is still held, for the config mount');
      assert.equal(hold.reinitializing, undefined);
      fw.reportLongHold(hold);
      const [alert] = longHoldAlerts();
      assert.equal(alert!.agentName, 'every agent');
      assert.match(alert!.message, /^The branch switch has held the store for \d+ s, so no turn starts .* The branch switch is for every agent\.$/);
      const data = alert!.data as { reinitializing?: string; waitingForMaintenance?: boolean };
      assert.equal(data.reinitializing, undefined);
      assert.equal(data.waitingForMaintenance, undefined);
    } finally {
      mounted();
      fw.moduleRegistry.getModule = getModule;
    }
    await switching;
    assert.equal(longHoldAlerts().length, 1);
    assert.deepEqual(reinitAlerts(), []);
    await works('a');
    await works('b');
  });

  it("a suppression's hold is named as the suppression", async () => {
    const fw = framework as unknown as { maintenancePass: Promise<void> | null; reportLongHold(hold: unknown): void };
    const { promise: pass, settle, waited } = watchedPromise();
    fw.maintenancePass = pass;
    let suppressing: Promise<unknown> | undefined;
    try {
      suppressing = framework.suppressMessages('a', { messageIds: [firstId] });
      await settled();
      assert.ok(waited(), 'the suppression waits on the running maintenance pass');
      fw.reportLongHold(internals().surgeryHold);
      assert.match(longHoldAlerts()[0]!.message, /^The suppression has held the store for \d+ s, so no turn starts .* The suppression is for a, and is waiting for maintenance work that was already running to finish\.$/);
    } finally {
      settle();
      fw.maintenancePass = null;
    }
    await suppressing;
  });

  it("between two managers' re-initializations, the hold names neither", async () => {
    checkpointTurn();
    const named: Array<string | undefined> = [];
    const cm = cmOf('a') as unknown as { setStrategy: (s: unknown) => Promise<void> };
    const setStrategy = cm.setStrategy.bind(cm);
    cm.setStrategy = async (strategy: unknown) => {
      try {
        return await setStrategy(strategy);
      } finally {
        setImmediate(() => {
          named.push((internals() as unknown as { surgeryHold: { reinitializing?: string } | null }).surgeryHold?.reinitializing);
        });
      }
    };
    await reinitDone(framework.undoLastTurn('a'));
    assert.deepEqual(named, [undefined]);
  });

  it('an undo whose release throws still settles its settled, and says the release failed', async () => {
    checkpointTurn();
    const fw = framework as unknown as {
      addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
      readdDrained: (...args: unknown[]) => unknown;
    };
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const readdDrained = fw.readdDrained;
    try {
      const undone = framework.undoLastTurn('a');
      assert.equal(fw.addMessage('user', text('for b, during the hold'), undefined, { forAgent: 'b' }), '', 'deferred, not stored');
      fw.readdDrained = () => { throw new Error('injected release flush failure'); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        undone.settled!.then(() => 'settled', () => 'rejected'),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(outcome, 'settled');
    } finally {
      console.error = quiet;
      fw.readdDrained = readdDrained;
    }
    assert.ok(logged.some((line) => /^\[operator\] releasing the store the undo reserved failed: .*injected release flush failure/.test(line)), logged.join('\n'));
    assert.equal(internals().surgeryHold, null, 'the hold was cleared before the flush');
  });

  it('a hold let go before its threshold says nothing after it', async () => {
    checkpointTurn();
    shortenHoldAlert(1_000);
    await reinitDone(framework.undoLastTurn('a'));
    assert.equal(internals().surgeryHold, null);
    const atRelease = longHoldAlerts().length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(longHoldAlerts().length, atRelease, 'its timer went with the hold');
  });

  it('a suppression whose fork switches the store and then fails restores the source, and the other agent is current', async () => {
    const a = cmOf('a') as unknown as { fork: (...args: unknown[]) => Promise<unknown> };
    const fork = a.fork;
    const store = framework.getStore();
    a.fork = async (...args: unknown[]) => {
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

  it("a suppression whose fork switches the store and then fails, and whose restore can't select the source, names the suppression", async () => {
    const a = cmOf('a') as unknown as { fork: (...args: unknown[]) => Promise<unknown> };
    const fork = a.fork;
    const store = framework.getStore();
    const storeSwitch = store as unknown as { switchBranch: (name: string) => void };
    const switchBranch = storeSwitch.switchBranch;
    a.fork = async (...args: unknown[]) => {
      const name = String(args[1] ?? args[0]);
      if (!store.listBranches().some((b) => b.name === name)) store.createBranchAt(name, 'main', store.currentSequence());
      store.switchBranch(name);
      throw new Error('injected fork failure');
    };
    storeSwitch.switchBranch = function (this: unknown, name: string) {
      if (name === 'main') throw new Error('injected restore refusal');
      return switchBranch.call(this, name);
    };
    let message = '';
    try {
      await assert.rejects(
        framework.suppressMessages('a', { messageIds: [firstId] }),
        (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
      );
    } finally {
      a.fork = fork;
      storeSwitch.switchBranch = switchBranch;
    }
    assert.notEqual(store.currentBranch().name, 'main');
    assert.match(message, /RESTORE TO main ALSO FAILED \(injected restore refusal\)/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /^The suppression failed and the store couldn't be put back, so this agent's context manager refuses its work /);
  });

  it("a run named by a suppression whose fork fails, and which ends during the fork, is told a restart ends the run when the restore fails too", async () => {
    const internals = framework as unknown as { agents: Map<string, unknown>; ephemeralRuns: Map<string, unknown> };
    const agentA = internals.agents.get('a');
    internals.ephemeralRuns.set('a', {
      settle: { promise: new Promise(() => {}), resolve() {}, reject() {} }, inferenceStarted: false, lastActivity: Date.now(), toolCallsCount: 0,
    });
    const a = cmOf('a') as unknown as { fork: (...args: unknown[]) => Promise<unknown> };
    const fork = a.fork;
    const store = framework.getStore();
    const storeSwitch = store as unknown as { switchBranch: (name: string) => void };
    const switchBranch = storeSwitch.switchBranch;
    let ended = false;
    a.fork = async (...args: unknown[]) => {
      const name = String(args[1] ?? args[0]);
      if (!store.listBranches().some((b) => b.name === name)) store.createBranchAt(name, 'main', store.currentSequence());
      store.switchBranch(name);
      ended = true;
      internals.ephemeralRuns.delete('a');
      internals.agents.delete('a');
      throw new Error('injected fork failure');
    };
    storeSwitch.switchBranch = function (this: unknown, name: string) {
      if (name === 'main') throw new Error('injected restore refusal');
      return switchBranch.call(this, name);
    };
    let message = '';
    try {
      await assert.rejects(
        framework.suppressMessages('a', { messageIds: [firstId] }),
        (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
      );
    } finally {
      a.fork = fork;
      storeSwitch.switchBranch = switchBranch;
      internals.ephemeralRuns.delete('a');
      internals.agents.set('a', agentA);
    }
    assert.equal(ended, true, 'the run ended during the fork');
    assert.match(message, /RESTORE TO main ALSO FAILED \(injected restore refusal\); the store is still on [^,]+, and the agent refuses its work until switchBranch\(\) to main re-initializes it \(a restart ends the run instead\)/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /^The suppression failed and the store couldn't be put back, so this agent's context manager refuses its work until switchBranch\(\) to the branch it should run on re-initializes it and stores its queued writes, at resume on a quiesced host; a restart ends the run\./);
  });

  it("stop() waits for an undo's re-initialization before the store closes", async () => {
    checkpointTurn();
    const undone = framework.undoLastTurn('a');
    assert.ok(undone.settled);
    let reinitEnded = false;
    void undone.settled.then(() => { reinitEnded = true; });
    await framework.stop();
    assert.equal(reinitEnded, true, 'the re-initialization finished before stop() returned');
  });

  it('a turn asked for while the managers re-initialize starts once the store is let go', async () => {
    checkpointTurn();
    const undone = framework.undoLastTurn('a');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'b answers after the undo' }]));
    framework.nudgeAgent('b', 'test');
    const run = framework.runUntilIdle();
    assert.ok(internals().surgeryHold, 'still reserved');
    assert.equal(membrane.calls.length, 0, 'no turn starts while the managers re-initialize');
    await reinitDone(undone);
    await run;
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 1, 'the turn ran once the store was let go');
  });

  it('a host/command undo of two turns undoes both, then answers', async () => {
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
    const undone = framework.undoLastTurn('a');
    idle = busy('b');
    try {
      assert.throws(
        () => framework.redo('a'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /b is inferring/.test(e.message),
      );
    } finally {
      idle();
    }
    await reinitDone(undone);
  });

  it("an undo's re-initialization waits for maintenance already running before any manager re-initializes", async () => {
    checkpointTurn();
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
      const undone = framework.undoLastTurn('a');
      await settled();
      assert.ok(waited(), 'the re-initialization is waiting on the pass');
      assert.deepEqual(calls, [], 'no manager re-initializes while the pass runs');
      settle();
      fw.maintenancePass = null;
      await reinitDone(undone);
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
    const undone = framework.undoLastTurn('a');
    assert.deepEqual(calls, [], 'no manager re-initializes inside undoLastTurn()');
    const before = await new Promise<number>((resolve) => { setImmediate(() => resolve(calls.length)); });
    assert.ok(before < 2, `the event loop ran while the managers re-initialized (${before} of 2 had when it did)`);
    await reinitDone(undone);
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
      const undone = framework.undoLastTurn('a');
      await settled();
      assert.ok(waited(), 'the re-initialization is waiting on the kick');
      assert.deepEqual(calls, [], 'no manager re-initializes while the kick runs');
      settle();
      drains.delete(kick);
      await reinitDone(undone);
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
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.match(message, /RESTORE TO main selected it, but re-initializing the agent's context manager for it FAILED/);
    assert.match(message, /the agent refuses its work until switchBranch\(\) to the current branch, or a restart, re-initializes it/);
    assert.doesNotMatch(message, /still on failed-twice/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /^The rollback failed and the store was put back, but this agent's context manager failed to re-initialize\. It refuses its work until switchBranch\(\) to the current branch re-initializes it/);
    assert.match(alerts[0]!.message, /a restart re-initializes it too, but loses them unless the deferral queue is persisted\. The work it refuses includes compiles and message writes\. Quiescing the host before it stops persists the deferral queue\. The store is on main\. Its re-initialization failed: .+\.$/);
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
    assert.match(message, /RESTORE TO main ALSO FAILED \(injected restore refusal\); the store is still on failed-thrice, and the agent refuses its work until switchBranch\(\) to main re-initializes it \(a restart re-initializes it on failed-thrice instead\)/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /^The rollback failed and the store couldn't be put back, so this agent's context manager refuses its work until switchBranch\(\) to the branch it should run on re-initializes it and stores its queued writes, at resume on a quiesced host; a restart re-initializes it on the branch the store is on instead\. A restart loses its queued writes unless the deferral queue is persisted\. The work it refuses includes compiles and message writes\. Quiescing the host before it stops persists the deferral queue\. The store is on failed-thrice, and the restore to main failed: injected restore refusal\.$/);
    assert.doesNotMatch(alerts[0]!.message, /moved the store's branch/);
  });

  it("a suppression whose removals fail after its fork, and whose restore can't select the source, says the agent serves from the failed branch", async () => {
    const a = cmOf('a') as unknown as { removeMessage: (...args: unknown[]) => void; removeMessages: (...args: unknown[]) => void };
    const removeMessage = a.removeMessage;
    const removeMessages = a.removeMessages;
    a.removeMessage = () => { throw new Error('injected removal failure'); };
    a.removeMessages = () => { throw new Error('injected removal failure'); };
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => void };
    const switchBranch = store.switchBranch;
    store.switchBranch = function (this: unknown, name: string) {
      if (name === 'main') throw new Error('injected restore refusal');
      return switchBranch.call(this, name);
    };
    let message = '';
    try {
      await assert.rejects(
        framework.suppressMessages('a', { messageIds: [firstId], branchName: 'partly-suppressed' }),
        (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
      );
    } finally {
      a.removeMessage = removeMessage;
      a.removeMessages = removeMessages;
      store.switchBranch = switchBranch;
    }
    assert.equal(framework.getStore().currentBranch().name, 'partly-suppressed');
    assert.match(message, /RESTORE TO main ALSO FAILED \(injected restore refusal\); the store is still on partly-suppressed, where the agent's context manager is current, so the agent serves from that branch until switchBranch\(\) moves it/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /^The suppression failed and the store couldn't be put back, so this agent's context manager is current on the branch the suppression made: it serves from there, which may be partly suppressed, until switchBranch\(\) to the branch it should run on moves it\. The store is on partly-suppressed, and the restore to main failed: injected restore refusal\.$/);
    await works('a');
  });

  it("a suppression whose removals fail after its fork, and whose restore selects the source but fails to re-initialize, says the agent refuses its work", async () => {
    const a = cmOf('a') as unknown as {
      removeMessage: (...args: unknown[]) => void;
      removeMessages: (...args: unknown[]) => void;
      initializeStrategy: (...args: unknown[]) => Promise<void>;
    };
    const removeMessage = a.removeMessage;
    const removeMessages = a.removeMessages;
    const initializeStrategy = a.initializeStrategy;
    let removalFailed = false;
    a.removeMessage = () => { removalFailed = true; throw new Error('injected removal failure'); };
    a.removeMessages = () => { removalFailed = true; throw new Error('injected removal failure'); };
    a.initializeStrategy = async function (this: unknown, ...args: unknown[]) {
      if (removalFailed) throw new Error('injected strategy init failure');
      return initializeStrategy.apply(this, args);
    };
    let message = '';
    try {
      await assert.rejects(
        framework.suppressMessages('a', { messageIds: [firstId], branchName: 'partly-suppressed' }),
        (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
      );
    } finally {
      a.removeMessage = removeMessage;
      a.removeMessages = removeMessages;
      a.initializeStrategy = initializeStrategy;
    }
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.match(message, /RESTORE TO main selected it, but re-initializing the agent's context manager for it FAILED \(injected strategy init failure\); the agent refuses its work until switchBranch\(\) to the current branch, or a restart, re-initializes it/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    assert.match(alerts[0]!.message, /^The suppression failed and the store was put back, but this agent's context manager failed to re-initialize\. It refuses its work until switchBranch\(\) to the current branch re-initializes it/);
    assert.match(alerts[0]!.message, / The store is on main\. Its re-initialization failed: injected strategy init failure\.$/);
  });

  it("with a long cause, the webhook still gets a failed restore's outcome and what to do", async () => {
    const a = cmOf('a') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
    const initializeStrategy = a.initializeStrategy;
    a.initializeStrategy = async function () { throw new Error('injected strategy init failure'); };
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => void };
    const switchBranch = store.switchBranch;
    store.switchBranch = function (this: unknown, name: string) {
      if (name === 'main') throw new Error(`injected restore refusal ${'x'.repeat(3_000)}`);
      return switchBranch.call(this, name);
    };
    const webhook = captureWebhook();
    try {
      await assert.rejects(framework.rollbackToMessage('a', { messageId: firstId, branchName: 'failed-thrice' }));
    } finally {
      webhook.restore();
      a.initializeStrategy = initializeStrategy;
      store.switchBranch = switchBranch;
    }
    assert.match(keptHead(webhook.posted, 'a', 'context-reinit-failed'), /^The rollback failed and the store couldn't be put back, so this agent's context manager refuses its work until switchBranch\(\) to the branch it should run on re-initializes it and stores its queued writes, at resume on a quiesced host; a restart re-initializes it on the branch the store is on instead\. /);
  });

  it('a suppression whose fork is refused before the store moved re-initializes no other manager and raises no alert', async () => {
    const store = framework.getStore();
    const cmA = cmOf('a') as unknown as { fork: (name: string) => Promise<string> };
    const fork = cmA.fork;
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let initializations = 0;
    strategy.initialize = async (...args: unknown[]) => { initializations++; return initialize(...args); };
    cmA.fork = async () => { throw new Error('injected fork refusal'); };
    try {
      await assert.rejects(
        framework.suppressMessages('a', { messageIds: [firstId], branchName: 'refused-fork' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /injected fork refusal/.test(e.message),
      );
    } finally {
      cmA.fork = fork;
    }
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

  it("a redo whose branch was deleted drops that step and says so, with the switch's error as its cause, and the redo beneath it still works", async () => {
    const store = framework.getStore();
    const before1 = store.currentSequence();
    const turn1 = { agentName: 'a', turnIndex: 1, sequenceBefore: before1, branchName: 'main', timestamp: Date.now() };
    internals().saveTurnCheckpoints('a', [turn1]);
    cmOf('a').addMessage('user', text('turn one'));
    const before2 = store.currentSequence();
    internals().saveTurnCheckpoints('a', [turn1, { agentName: 'a', turnIndex: 2, sequenceBefore: before2, branchName: 'main', timestamp: Date.now() }]);
    cmOf('a').addMessage('user', text('turn two'));
    await reinitDone(framework.undoLastTurn('a'));
    const afterFirstUndo = store.currentBranch().name;
    await reinitDone(framework.undoLastTurn('a'));
    const afterSecondUndo = store.currentBranch().name;
    assert.equal(framework.getUndoRedoState('a').redoDepth, 2);
    store.deleteBranch(afterFirstUndo);

    const mover = store as unknown as { switchBranch: (name: string) => void };
    const switchBranch = mover.switchBranch.bind(store);
    let switchError: unknown;
    mover.switchBranch = (name: string) => {
      try {
        return switchBranch(name);
      } catch (error) {
        switchError = error;
        throw error;
      }
    };
    let thrown: unknown;
    try {
      assert.throws(() => framework.redo('a'), (e: unknown) => {
        thrown = e;
        return e instanceof OperatorActionError && e.code === 'failed';
      });
    } finally {
      mover.switchBranch = switchBranch;
    }
    assert.ok(switchError, 'the switch refused the deleted branch');
    assert.equal((thrown as Error).cause, switchError, "the switch's own error is the cause");
    assert.match((thrown as Error).message,
      new RegExp(`${afterFirstUndo}, no longer exists, so that step is dropped\\. 1 redo step remains\\.$`));
    assert.equal(store.currentBranch().name, afterSecondUndo, 'the store stays where it was');
    assert.equal(framework.getUndoRedoState('a').redoDepth, 1, 'the dead step is gone');
    assert.equal(internals().surgeryHold, null);

    const redone = framework.redo('a');
    assert.equal(redone.redone, true, 'the step beneath it redoes');
    await reinitDone(redone);
    assert.equal(store.currentBranch().name, 'main');
    await works('a');
    await works('b');
  });

  for (const [beneath, says] of [[0, 'No redo steps remain.'], [2, '2 redo steps remain.']] as const) {
    it(`a redo whose branch was deleted, with ${beneath} step(s) beneath it, says "${says}"`, () => {
      const stacks = (framework as unknown as { redoStacks: Map<string, Array<{ branchName: string; checkpoint: unknown }>> }).redoStacks;
      const step = (branchName: string) => ({
        branchName,
        checkpoint: { agentName: 'a', turnIndex: 1, sequenceBefore: 0, branchName: 'main', timestamp: Date.now() },
      });
      stacks.set('a', [...Array.from({ length: beneath }, (_, i) => step(`beneath-${i}`)), step('deleted-before-its-redo')]);
      assert.throws(() => framework.redo('a'), (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
        && e.message.endsWith(`the branch this redo returns to, deleted-before-its-redo, no longer exists, so that step is dropped. ${says}`));
      assert.equal(framework.getUndoRedoState('a').redoDepth, beneath);
      assert.equal(internals().surgeryHold, null);
    });
  }

  it("a redo whose switch fails while the branch listing fails too keeps its step, and answers the switch's error", async () => {
    checkpointTurn();
    await reinitDone(framework.undoLastTurn('a'));
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
    const redone = framework.redo('a');
    assert.equal(redone.redone, true);
    await reinitDone(redone);
    await works('a');
    await works('b');
  });

  it("a runtime-settings change while an undo's managers re-initialize is refused, and nothing is applied", async () => {
    checkpointTurn();
    const before = framework.getAgentRuntimeSettings('b');
    const undone = framework.undoLastTurn('a');
    assert.ok(internals().syncMoveReinit, 'the re-initialization is running');
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    assert.throws(
      () => framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
    );
    await reinitDone(undone);
    assert.equal(framework.getAgentRuntimeSettings('b').sameRoundThinkTextPolicy, before.sameRoundThinkTextPolicy);
    assert.equal(framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }).sameRoundThinkTextPolicy, next);
  });

  it("a runtime-settings reset or cancelled transition while an undo's managers re-initialize is refused, and nothing is applied", async () => {
    const before = framework.getAgentRuntimeSettings('b');
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next });
    checkpointTurn();
    const undone = framework.undoLastTurn('a');
    assert.ok(internals().syncMoveReinit, 'the re-initialization is running');
    assert.throws(
      () => framework.resetAgentRuntimeSettings('b'),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
    );
    assert.throws(
      () => framework.cancelAgentRuntimeSettingsTransition('b'),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
    );
    await reinitDone(undone);
    assert.equal(framework.getAgentRuntimeSettings('b').sameRoundThinkTextPolicy, next, 'the override is still set');
    assert.equal(framework.resetAgentRuntimeSettings('b').sameRoundThinkTextPolicy, before.sameRoundThinkTextPolicy);
  });

  it("after a rollback, the other agent compiles what the landed branch holds", async () => {
    await framework.rollbackToMessage('a', { messageId: firstId });
    const { messages } = await cmOf('b').compile(budget, undefined, { dryRun: true });
    const texts = JSON.stringify(messages);
    assert.match(texts, /hello a/);
    assert.doesNotMatch(texts, /hello b/);
    assert.doesNotMatch(texts, /second a/);
  });

  it("a redo made from a listener of the last pass's alert is refused as busy, the store stays where the undo left it, and the agent that moved compiles", async () => {
    checkpointTurn();
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    let redo: unknown = 'not called';
    framework.onTrace((event) => {
      if (event.type === 'ops:alert' && event.kind === 'context-reinit-failed' && redo === 'not called') {
        try { redo = framework.redo('a'); } catch (error) { redo = error; }
      }
    });
    const undone = framework.undoLastTurn('a');
    await reinitDone(undone);
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
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ getContextManager(): ContextManager }>;
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
      const order: string[] = [];
      const strategy = cmA.getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      let atGate = false;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      strategy.initialize = async (...args: unknown[]) => {
        atGate = true;
        await gate;
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
      const spawning = internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' });
      await until(() => atGate, "the template's re-initialization to reach its gate", 10_000);
      await settled();
      assert.equal(order.length, 0, `the spawn waits, and nothing has compiled the template: ${JSON.stringify(order)}`);
      open();
      const fork = await spawning;
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
  const forksAroundACheckpoint = async (framework: AgentFramework, internals: ForkInternals): Promise<number> => {
    const router = framework.getConversationRouter()!;
    const cmA = framework.getAgent('a')!.getContextManager();
    cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
    await internals.createConversationAgent('a-early-g1', { serverId: 'world', channelId: 'world:early' });
    router.bind({ serverId: 'world', channelId: 'world:early' }, 'a-early-g1', 1);
    framework.getAgent('a-early-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'early own' }]);
    const sequenceBefore = framework.getStore().currentSequence();
    cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
    internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
    await internals.createConversationAgent('a-late-g1', { serverId: 'world', channelId: 'world:late' });
    router.bind({ serverId: 'world', channelId: 'world:late' }, 'a-late-g1', 1);
    framework.getAgent('a-late-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late own' }]);
    return sequenceBefore;
  };
  const count = (texts: string[], text: string) => texts.filter((t) => t === text).length;

  it("an undo to before a fork was spawned seeds the fork again from the template; a redo brings back its own history; a fork spawned before that point keeps its own", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-reseed-', async (framework, internals, logged) => {
      await forksAroundACheckpoint(framework, internals);
      const router = framework.getConversationRouter()!;

      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      await undo.settled;
      assert.equal(router.getBinding({ serverId: 'world', channelId: 'world:late' })?.agentName, 'a-late-g1', 'the fork stays, bound to its channel');
      const late = await textsOf(framework, 'a-late-g1');
      assert.equal(count(late, 'hello a'), 1, `seeded again from the template's compile on this branch: ${JSON.stringify(late)}`);
      assert.equal(count(late, 'a turn to undo'), 0, JSON.stringify(late));
      assert.equal(count(late, 'late own'), 0, JSON.stringify(late));
      const early = await textsOf(framework, 'a-early-g1');
      assert.ok(count(early, 'hello a') === 1 && count(early, 'early own') === 1, `the fork spawned before the point keeps its own, seeded once: ${JSON.stringify(early)}`);
      assert.equal(logged.filter((line) => /a-late-g1 had no messages on the branch the store moved to: seeded again from a/.test(line)).length, 1, logged.join('\n'));
      const lastSeeded = framework.getAgent('a-late-g1')!.getContextManager().getAllMessages().at(-1)!.sequence;
      const mark = framework.getAgent('a-late-g1')!.getConsumedWatermark();
      assert.equal(mark?.branch, framework.getStore().currentBranch().name, `the consumed mark is on the branch the undo landed on: ${JSON.stringify(mark)}`);
      assert.ok(mark !== null && mark.sequence >= lastSeeded, `the consumed mark covers the seeded copies: ${JSON.stringify(mark)}, last seeded ${lastSeeded}`);

      const redo = framework.redo('a');
      assert.equal(redo.redone, true);
      await redo.settled;
      const redone = await textsOf(framework, 'a-late-g1');
      assert.ok(redone.includes('late own') && redone.includes('a turn to undo'), `the redo brings back its own history: ${JSON.stringify(redone)}`);
      assert.equal(count(redone, 'hello a'), 1, `and seeds nothing over it: ${JSON.stringify(redone)}`);
      assert.equal(logged.filter((line) => /seeded again/.test(line)).length, 1, logged.join('\n'));
    });
  });

  it("a switch to a branch from before a fork was spawned seeds it again; a fork whose re-initialization fails there is reported, and not seeded", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-switch-', async (framework, internals, logged) => {
      const sequenceBefore = await forksAroundACheckpoint(framework, internals);
      await internals.createConversationAgent('a-bad-g1', { serverId: 'world', channelId: 'world:bad' });
      framework.getConversationRouter()!.bind({ serverId: 'world', channelId: 'world:bad' }, 'a-bad-g1', 1);
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
      assert.match(reinit[0]!.message, /^The branch switch moved the store's branch, and this agent's context manager failed to re-initialize\. It refuses its work until switchBranch\(\) to the current branch re-initializes it and stores its queued writes, at resume on a quiesced host; a restart ends it, and its channel's next qualifying message spawns a new fork\. The work it refuses includes compiles and message writes, and a fork its channel spawns after a restart gets none of the writes queued for this one\. Its re-initialization failed: .*injected fork init failure/);
      assert.equal(framework.getAgent('a-bad-g1')!.getContextManager().getMessageCount(), 0, 'not seeded');
      assert.ok(!logged.some((line) => /a-bad-g1 had no messages/.test(line)), logged.join('\n'));
    });
  });

  it("a rollback of a conversation agent whose restore fails too says a restart ends it, not that a restart re-initializes it", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-restore-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      const early = framework.getAgent('a-early-g1')!.getContextManager();
      const firstId = early.getAllMessages()[0]!.id;
      const cm = early as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
      const initializeStrategy = cm.initializeStrategy;
      cm.initializeStrategy = async function () { throw new Error('injected strategy init failure'); };
      let message = '';
      try {
        await assert.rejects(
          framework.rollbackToMessage('a-early-g1', { messageId: firstId, branchName: 'fork-failed-twice' }),
          (e: unknown) => { message = e instanceof Error ? e.message : String(e); return e instanceof OperatorActionError; },
        );
      } finally {
        cm.initializeStrategy = initializeStrategy;
      }
      assert.match(message, /RESTORE TO main selected it, but re-initializing the agent's context manager for it FAILED \(injected strategy init failure\); the agent refuses its work until switchBranch\(\) to the current branch re-initializes it \(a restart ends it instead\)/);
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed' && alert.agentName === 'a-early-g1');
      assert.equal(reinit.length, 1, JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /^The rollback failed and the store was put back, but this agent's context manager failed to re-initialize\. It refuses its work until switchBranch\(\) to the current branch re-initializes it and stores its queued writes, at resume on a quiesced host; a restart ends it, and its channel's next qualifying message spawns a new fork\. The work it refuses includes compiles and message writes, and a fork its channel spawns after a restart gets none of the writes queued for this one\. The store is on main\./);
    });
  });

  it("a fork that leaves while it's seeded again, whose seeding then fails, isn't reported", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-seed-leaves-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts: Array<{ kind: string; agentName: string }> = [];
      let disposals = 0;
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string });
        if (event.type === 'mcpl:conversation-disposed' && (event as { agentName?: string }).agentName === 'a-late-g1') disposals++;
      });
      const owner = framework as unknown as { disposeConversationAgent(name: string): void };
      const cmA = framework.getAgent('a')!.getContextManager();
      const compile = cmA.compile.bind(cmA);
      let compiled = false;
      (cmA as unknown as { compile: () => Promise<never> }).compile = async () => {
        compiled = true;
        owner.disposeConversationAgent('a-late-g1');
        throw new Error('injected template compile failure');
      };
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      assert.equal(compiled, true, 'the seeding read the template');
      assert.equal(disposals, 1, 'disposed once, by its own end, not again by the re-seed');
      assert.deepEqual(alerts.filter((alert) => alert.kind === 'context-reinit-failed'), []);
      assert.ok(!framework.getAgent('a-late-g1'), 'gone');
      assert.equal(internals.surgeryHold, null, 'the store is released');
    });
  });

  it("a fork whose seeding fails after a move is disposed and reported, and the move stands", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-seedfail-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      const cmA = framework.getAgent('a')!.getContextManager();
      const compile = cmA.compile.bind(cmA);
      (cmA as unknown as { compile: () => Promise<never> }).compile = async () => { throw new Error('injected template compile failure'); };
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /^The \w[\w ]* left this conversation agent with no messages of its own, and it couldn't be seeded again, so it was disposed and its channel unbound\. Its channel's next qualifying message spawns a new fork, unless its seeding fails again\. That fork is seeded from the template, under a new name\. Its messages stay on the branches that hold them, but no agent reads them again, so a redo to a branch that holds them doesn't bring this one back\. It couldn't be seeded because its seeding from the template failed: .*injected template compile failure\.$/);
      assert.doesNotMatch(reinit[0]!.message, /refuses its work/);
      assert.equal(internals.surgeryHold, null, 'the store is released');
      assert.ok(!framework.getAgent('a-late-g1'), 'the fork is disposed rather than left to answer with no history');
      const router = framework.getConversationRouter()!;
      assert.equal(router.getBinding({ serverId: 'world', channelId: 'world:late' }), undefined, 'its channel is unbound');
      const next = router.route({ channelId: 'world:late', mentioned: true, kind: 'channel' });
      assert.equal(next.kind, 'spawn', `the channel's next mention spawns a fresh fork: ${JSON.stringify(next)}`);
      assert.ok(framework.getAgent('a-early-g1'), 'the fork spawned before the point stays');
    });
  });

  it("a fork whose disposal fails partway after its seeding fails is reported with both, and the pass seeds the next fork", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-disposefail-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const router = framework.getConversationRouter()!;
      await internals.createConversationAgent('a-later-g1', { serverId: 'world', channelId: 'world:later' });
      router.bind({ serverId: 'world', channelId: 'world:later' }, 'a-later-g1', 1);
      framework.getAgent('a-later-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'later own' }]);
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      const cmLate = framework.getAgent('a-late-g1')!.getContextManager();
      (cmLate as unknown as { addMessage: () => never }).addMessage = () => { throw new Error('injected seed failure'); };
      const released = framework as unknown as { releaseWindow: (agent: { name: string }) => void };
      const releaseWindow = released.releaseWindow;
      released.releaseWindow = function (this: unknown, agent: { name: string }) {
        if (agent.name === 'a-late-g1') throw new Error('injected release failure');
        return releaseWindow.call(this, agent);
      };
      const queue = framework as unknown as {
        addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
      };
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        assert.equal(queue.addMessage('user', [{ type: 'text', text: 'for a-late-g1, during the hold' }], undefined, { forAgent: 'a-late-g1' }), '', 'deferred, not stored');
        await undo.settled;
      } finally {
        released.releaseWindow = releaseWindow;
      }
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /couldn't be seeded again, so it was unregistered and its channel unbound, but its cleanup failed \(below\)\. Its channel's next qualifying message spawns a new fork, unless its seeding fails again\. That fork is seeded from the template, under a new name\. The write held for it while the store was held may be in its window, where no agent reads it, still queued under its name, or in neither, as far as that cleanup got\. A flush that meets one still queued passes it on to the primary agent if it's a failed reply, a channel notice the fork could have acted on, or a module write for it, and drops anything else, logged\. .*It couldn't be seeded because its seeding from the template failed: .*injected seed failure\. Its cleanup failed: .*injected release failure\.$/);
      assert.equal(internals.surgeryHold, null, 'the store is released');
      assert.ok(!framework.getAgent('a-late-g1'), 'the fork is unregistered');
      assert.equal(router.getBinding({ serverId: 'world', channelId: 'world:late' }), undefined, 'its channel is unbound');
      const later = await textsOf(framework, 'a-later-g1');
      assert.equal(count(later, 'hello a'), 1, `the next fork is seeded again from the template: ${JSON.stringify(later)}`);
      assert.equal(count(later, 'later own'), 0, JSON.stringify(later));
    });
  });

  it('a move is refused while a fork is being created, and goes through once it is', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-inflight-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cmA.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('a', [{ agentName: 'a', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
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
      const spawning = internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' });
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
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      await undo.settled;
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
        await assert.rejects(internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' }), /injected template compile failure/);
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true, 'not refused as a fork being created');
      await undo.settled;
    });
  });

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
          const undo = framework.undoLastTurn('a');
          assert.equal(undo.undone, true);
          await held.reached; // the pass is seeding a-late-g1, inside the template's compile
          const redo = framework.redo('a');
          assert.equal(redo.redone, true, 'the redo joins the running re-initialization');
          assert.equal(redo.settled, undo.settled, 'and settles with it');
          held.release({ throws: joined.throws });
          await redo.settled;
        } finally {
          held.restore();
        }
        assert.equal(framework.getStore().currentBranch().name, 'main');
        assert.ok(framework.getAgent('a-late-g1'), 'not disposed');
        assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:late' })?.agentName, 'a-late-g1');
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
      await internals.createConversationAgent('a-late2-g1', { serverId: 'world', channelId: 'world:late2' });
      framework.getConversationRouter()!.bind({ serverId: 'world', channelId: 'world:late2' }, 'a-late2-g1', 1);
      framework.getAgent('a-late2-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late2 own' }]);
      const alerts: Array<{ kind: string; agentName: string; message: string; data?: { after?: string } }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string; data?: { after?: string } });
      });
      const held = holdTemplateCompile(framework, ['throw', 'hold']);
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await held.reached;
        const redo = framework.redo('a');
        assert.equal(redo.redone, true);
        held.release();
        await redo.settled;
      } finally {
        held.restore();
      }
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /because its seeding from the template failed: .*injected template compile failure/);
      assert.match(reinit[0]!.message, /^The undo left this conversation agent/);
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
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      } finally {
        strategy.initialize = initialize;
      }
      const byAgent = new Map(alerts.filter((alert) => alert.kind === 'context-reinit-failed').map((alert) => [alert.agentName, alert.message]));
      assert.deepEqual([...byAgent.keys()].sort(), ['a', 'a-late-g1'], JSON.stringify(alerts));
      assert.match(byAgent.get('a')!, /injected template init failure/);
      assert.match(byAgent.get('a-late-g1')!, /couldn't be seeded again, so it was disposed and its channel unbound\. Once a switchBranch\(\) to the current branch or a restart re-initializes the template, its channel's next qualifying message spawns a new fork\. That fork is seeded from the template, under a new name\. .*It couldn't be seeded because the template a's own context manager failed to re-initialize \([^)]*injected template init failure[^)]*\)\.$/);
      assert.match(byAgent.get('a-late-g1')!, /no agent reads them again/);
      assert.ok(!framework.getAgent('a-late-g1'), 'the empty fork is disposed');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:late' }), undefined);
      assert.ok(framework.getAgent('a-early-g1'), 'the fork with history stays');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:early' })?.agentName, 'a-early-g1');
    });
  });

  it("with a long cause, the webhook still gets the template's and the fork's openings", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-webhook-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const strategy = framework.getAgent('a')!.getContextManager().getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      strategy.initialize = async () => { throw new Error(`injected template init failure ${'x'.repeat(3_000)}`); };
      const webhook = captureWebhook();
      try {
        await framework.undoLastTurn('a').settled;
      } finally {
        webhook.restore();
        strategy.initialize = initialize;
      }
      assert.match(keptHead(webhook.posted, 'a', 'context-reinit-failed'), /^The undo moved the store's branch, and this agent's context manager failed to re-initialize\. It refuses its work until switchBranch\(\) to the current branch re-initializes it and stores its queued writes, at resume on a quiesced host; a restart re-initializes it too, but loses them unless the deferral queue is persisted\. /);
      assert.match(keptHead(webhook.posted, 'a-late-g1', 'context-reinit-failed'), /^The undo left this conversation agent with no messages of its own, and it couldn't be seeded again, so it was disposed and its channel unbound\. Once a switchBranch\(\) to the current branch or a restart re-initializes the template, its channel's next qualifying message spawns a new fork\. /);
    });
  });

  it("a template refusal in a pass an undo joins disposes nothing, and the next pass seeds the fork the joined undo emptied", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-template-joined-', async (framework, internals) => {
      const store = framework.getStore();
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const turn1 = { agentName: 'a', turnIndex: 1, sequenceBefore: store.currentSequence(), branchName: 'main', timestamp: Date.now() };
      cmA.addMessage('user', [{ type: 'text', text: 'a turn one' }]);
      internals.saveTurnCheckpoints('a', [turn1]);
      await internals.createConversationAgent('a-late-g1', { serverId: 'world', channelId: 'world:late' });
      framework.getConversationRouter()!.bind({ serverId: 'world', channelId: 'world:late' }, 'a-late-g1', 1);
      framework.getAgent('a-late-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late own' }]);
      const turn2 = { agentName: 'a', turnIndex: 2, sequenceBefore: store.currentSequence(), branchName: 'main', timestamp: Date.now() };
      cmA.addMessage('user', [{ type: 'text', text: 'a turn two' }]);
      internals.saveTurnCheckpoints('a', [turn1, turn2]);

      const alerts: Array<{ kind: string; agentName: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string });
      });
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
      try {
        const first = framework.undoLastTurn('a');
        assert.equal(first.undone, true, 'the first undo keeps a-late-g1 its history');
        await reached;
        const second = framework.undoLastTurn('a');
        assert.equal(second.undone, true, 'the second undo joins, to before a-late-g1 was spawned');
        release();
        await second.settled;
      } finally {
        strategy.initialize = initialize;
      }
      assert.deepEqual(alerts.filter((alert) => alert.kind === 'context-reinit-failed'), [], 'nothing reported: the refusal came in a pass a move joined');
      assert.ok(framework.getAgent('a-late-g1'), 'not disposed');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:late' })?.agentName, 'a-late-g1');
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
      assert.match(reinit[0]!.message, /couldn't be seeded again, so it was disposed and its channel unbound\. Once an agent is registered under the template's name, or the router names a registered one, its channel's next qualifying message spawns a new fork\. That fork is seeded from the template, under a new name\. .*It couldn't be seeded because no agent is registered as the conversation template "a"\.$/);
      assert.ok(!framework.getAgent('a-late-g1'), 'the empty fork is disposed');
      assert.ok(framework.getAgent('a-early-g1'), 'the fork with history stays');
    });
  });

  it('a conversation agent created over a namespace that already holds history is not seeded again, even when that history compiles to nothing', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-recreate-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      await internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' });
      const stored = framework.getAgent('a-chan-g1')!.getContextManager().getMessageCount();
      assert.ok(stored > 0, 'seeded once');
      const forget = framework as unknown as { disposeConversationAgent(name: string): void; usedEphemeralAgentNames: Set<string> };
      forget.disposeConversationAgent('a-chan-g1');
      forget.usedEphemeralAgentNames.delete('a-chan-g1');
      const proto = Object.getPrototypeOf(cmA) as { compile: (...args: unknown[]) => Promise<{ messages: unknown[] }> };
      const compile = proto.compile;
      proto.compile = async function (this: unknown, ...args: unknown[]) {
        const result = await compile.apply(this, args);
        return this === cmA ? result : { ...result, messages: [] };
      };
      try {
        await internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' });
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
          const undo = framework.undoLastTurn('a');
          assert.equal(undo.undone, true);
          await undo.settled;
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
    removePlacement(placement: Placement): boolean;
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
  };

  it("while an undo waits for running maintenance, a fork's channel message and a correction for it are deferred, and land after it's seeded again", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-writes-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const placements: Array<Placement | undefined> = [];
      const added: Array<{ messageId: string; source: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'message:added') added.push(event as unknown as { messageId: string; source: string });
      });
      await duringMaintenanceWait(internals, async () => {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      }, async () => {
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
      assert.deepEqual(added.filter((t) => t.source === 'mcpl:channel-incoming').map((t) => t.messageId), ['', ''],
        `traced at the deferral, with no id yet: ${JSON.stringify(added)}`);
      assert.deepEqual(added.filter((t) => t.source === 'deferred-flush:surgery-release').map((t) => t.messageId),
        placements.map((p) => p!.messageId), `traced as each lands, with its stored id: ${JSON.stringify(added)}`);
    });
  });

  it("a fork disposed after a move takes the writes held for it into its window, and its alert says how many", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-seedfail-held-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      const late = framework.getAgent('a-late-g1')!.getContextManager();
      const cmA = framework.getAgent('a')!.getContextManager();
      const compile = cmA.compile.bind(cmA);
      try {
        await duringMaintenanceWait(internals, async () => {
          const undo = framework.undoLastTurn('a');
          assert.equal(undo.undone, true);
          await undo.settled;
        }, async () => {
          for (const words of ['FIRST DURING THE UNDO', 'SECOND DURING THE UNDO']) {
            const placement = await internals.handleMcplChannelIncoming(channelMessage('world:late', words));
            assert.ok(placement?.deferredId && !placement.messageId, `deferred, not stored: ${JSON.stringify(placement)}`);
          }
          (cmA as unknown as { compile: () => Promise<never> }).compile = async () => { throw new Error('injected template compile failure'); };
        });
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
      assert.deepEqual(storedTexts(late), ['FIRST DURING THE UNDO', 'SECOND DURING THE UNDO'], 'the held writes are in its window');
      const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
      assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(reinit[0]!.message, /so it was disposed and its channel unbound\. Its channel's next qualifying message spawns a new fork, unless its seeding fails again\. That fork is seeded from the template, under a new name\. The 2 writes held for it while the store was held go with it, so that fork doesn't get them: its window's release stored what its store took of them there and passed on to the primary agent each failed reply, channel notice the fork could have acted on, or module write for it\. Its messages stay on the branches/);
    });
  });

  it("a spawn that waits out a move's hold into a stop() fails, as a failed spawn does", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-spawn-stop-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const cmA = framework.getAgent('a')!.getContextManager();
      const strategy = cmA.getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      let atGate = false;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      strategy.initialize = async (...args: unknown[]) => {
        atGate = true;
        await gate;
        return initialize(...args);
      };
      assert.equal(framework.undoLastTurn('a').undone, true);
      const spawning = internals.createConversationAgent('a-new-g1', { serverId: 'world', channelId: 'world:new' });
      void spawning.catch(() => {});
      await until(() => atGate, "the template's re-initialization to reach its gate", 10_000);
      const stopping = framework.stop();
      void stopping.catch(() => {});
      await settled();
      open();
      await assert.rejects(spawning, /conversation agent "a-new-g1" not created: the framework is stopping/);
      await stopping;
      assert.ok(!framework.getAgent('a-new-g1'), 'not registered');
      const left = framework as unknown as { usedEphemeralAgentNames: Map<string, unknown>; conversationSpawnsInFlight: Set<string> };
      assert.equal(left.usedEphemeralAgentNames.has('a-new-g1'), false, 'no name is reserved');
      assert.equal(left.conversationSpawnsInFlight.size, 0, 'no spawn is marked in flight');
    });
  });

  for (const after of ['resume', 'stop', 'crash', 'cleanup', 'released before the report'] as const) {
    it(after === 'resume'
      ? "a fork disposed on a quiesced host: its window takes the writes held for it at the host's resume, and a failed reply, a channel notice it could act on and a module's write for it each reach the primary"
      : after === 'stop'
        ? "a fork disposed on a quiesced host: a stop before the resume drops its other held writes, logged, stored nowhere, and a failed reply, a channel notice it could act on and a module's write for it each reach the primary at the restarted host's resume"
        : after === 'crash'
          ? "a fork disposed on a quiesced host: after a crash, the restarted host's resume drops its other held writes, logged, stored nowhere, and a failed reply, a channel notice it could act on and a module's write for it each reach the primary"
          : after === 'cleanup'
            ? "a fork disposed on a quiesced host whose cleanup then fails: its alert says the release was postponed to the resume, which takes the writes held for it"
            : "a fork disposed on a quiesced host whose postponed release runs before the alert is made: the alert says the release was postponed, as the disposal met it",
    { timeout: 90_000 }, async () => {
      const tempDir = mkdtempSync(join(tmpdir(), `reinit-fork-quiesced-${after}-`));
      let courier: ModuleContext | undefined;
      const courierModule = (): Module => ({
        name: 'courier',
        async start(ctx: ModuleContext) { courier ??= ctx; },
        async stop() {},
        getTools: () => [],
        async handleToolCall() { return { success: true }; },
        async onProcess() { return {}; },
      });
      const config = () => ({
        storePath: join(tempDir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() }],
        modules: [courierModule()],
        conversations: { templateAgent: 'a', bind: { channel: 'mention' as const }, strategyFactory: () => autobiographical() },
      });
      type Queue = {
        deferredMessages: Array<{ forAgent?: string }>;
        releasesAfterResume: Map<string, unknown>;
        addMessage(participant: string, content: unknown, metadata?: unknown, opts?: { forAgent?: string }): string;
      };
      const queuedForFork = (framework: AgentFramework) =>
        (framework as unknown as Queue).deferredMessages.filter((msg) => msg.forAgent === 'a-late-g1').length;
      const passedOn = (framework: AgentFramework) => {
        const texts = storedTexts(framework.getAgent('a')!.getContextManager());
        return {
          failedReply: texts.filter((text) => text.startsWith('[discord-send-failed] A reply by a-late-g1')).length,
          channelNotice: texts.filter((text) => text.startsWith('[channels] Now open: #late (c-late): a message from a-late-g1')).length,
          moduleWrite: texts.filter((text) => text === 'A MODULE WRITE FOR THE FORK').length,
        };
      };
      const eachOnce = { failedReply: 1, channelNotice: 1, moduleWrite: 1 };
      const logged: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        const framework = await AgentFramework.create(config());
        const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
        framework.onTrace((event) => {
          if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
        });
        const forkInternals = framework as unknown as ForkInternals;
        await forksAroundACheckpoint(framework, forkInternals);
        const internals = forkInternals as unknown as HoldInternals;
        const late = framework.getAgent('a-late-g1')!.getContextManager();
        const cmA = framework.getAgent('a')!.getContextManager();
        const compile = cmA.compile.bind(cmA);
        await framework.quiesce({ reason: 'the test' });
        const owner = framework as unknown as { evictTurnCheckpoints(name: string): void };
        const evict = owner.evictTurnCheckpoints.bind(framework);
        if (after === 'released before the report') {
          const internalsForReport = framework as unknown as {
            reportReinitFailures: (...args: unknown[]) => void; runReleasesAfterResume(): void;
          };
          const report = internalsForReport.reportReinitFailures.bind(framework);
          internalsForReport.reportReinitFailures = (...args: unknown[]) => {
            internalsForReport.runReleasesAfterResume();
            report(...args);
          };
        }
        if (after === 'cleanup') {
          owner.evictTurnCheckpoints = (name: string) => {
            if (name === 'a-late-g1') throw new Error('injected checkpoint eviction failure');
            evict(name);
          };
        }
        try {
          await duringMaintenanceWait(internals, async () => {
            await framework.undoLastTurn('a').settled;
          }, async () => {
            for (const words of ['FIRST DURING THE UNDO', 'SECOND DURING THE UNDO']) {
              assert.ok((await internals.handleMcplChannelIncoming(channelMessage('world:late', words)))?.deferredId, 'deferred');
            }
            const failed = { kind: 'discord-send-failed', channelId: 'world:late', reason: 'injected send failure', textLen: 19, outcome: 'failed' };
            assert.equal((framework as unknown as Queue).addMessage('a-late-g1', [{ type: 'text', text: 'A REPLY THAT FAILED' }], failed, { forAgent: 'a-late-g1' }), '', 'deferred');
            const opened = { system: true, kind: 'channel-notice', passOn: { notice: 'channel-opened', serverId: 'world', cause: 'opened-by-reply', channels: [{ channelId: 'c-late', label: '#late' }] } };
            assert.equal((framework as unknown as Queue).addMessage('user', [{ type: 'text', text: '[channels] Now open: #late (c-late): your own message into the closed channel opened it.' }], opened, { forAgent: 'a-late-g1' }), '', 'deferred');
            assert.match(courier!.addMessage('courier', [{ type: 'text', text: 'A MODULE WRITE FOR THE FORK' }], undefined, { forAgent: 'a-late-g1' }), /^held:/, 'deferred');
            (cmA as unknown as { compile: () => Promise<never> }).compile = async () => { throw new Error('injected template compile failure'); };
          });
        } finally {
          (cmA as unknown as { compile: typeof compile }).compile = compile;
          owner.evictTurnCheckpoints = evict;
        }
        assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
        const store = framework.getStore();
        try {
          store.registerState({ id: 'mcpl/channel-lifecycle', strategy: 'append_log' } as never);
        } catch (err) {
          if (!/exist/i.test(String(err))) throw err;
        }
        store.appendToStateJson('mcpl/channel-lifecycle', { kind: 'desired-state', serverId: 'world', channelId: 'c-late', desired: 'open', source: 'opened-by-reply' });
        store.sync();
        if (after === 'released before the report') {
          assert.equal(queuedForFork(framework), 0, 'its release took them');
          assert.ok(!(framework as unknown as Queue).releasesAfterResume.has('a-late-g1'), 'and has run');
          const window = storedTexts(late);
          assert.equal(window.filter((text) => /DURING THE UNDO|A REPLY THAT FAILED|c-late|A MODULE WRITE FOR THE FORK/.test(text)).length, 5, JSON.stringify(window));
        } else {
          assert.equal(queuedForFork(framework), 5, 'its held writes stay queued while the host is quiesced');
          assert.ok((framework as unknown as Queue).releasesAfterResume.has('a-late-g1'), 'its release waits for the resume');
        }
        const reinit = alerts.filter((alert) => alert.kind === 'context-reinit-failed');
        assert.deepEqual(reinit.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
        assert.match(reinit[0]!.message, / The 5 writes held for it while the store was held go with it, so that fork doesn't get them: its window's release was postponed to the host's resume, which stores what its store takes of them there and passes on to the primary agent each failed reply, channel notice the fork could have acted on, or module write for it\. A stop\(\) before the resume drops the rest, logged, and those go to the primary at the restarted host's resume; after a crash, that resume does the same\. Its messages stay on the branches/);
        if (after === 'cleanup') {
          assert.match(reinit[0]!.message, /, but its cleanup failed \(below\)\. /);
          assert.match(reinit[0]!.message, / Its cleanup failed: .*injected checkpoint eviction failure\.$/);
        }
        if (after === 'crash') {
          const crashed = join(tempDir, 'crashed');
          cpSync(join(tempDir, 'store'), join(crashed, 'store'), { recursive: true });
          await framework.stop();
          const mark = logged.length;
          const booted = await AgentFramework.create({ ...config(), storePath: join(crashed, 'store') });
          try {
            const kept = (booted as unknown as { deferredMessages: Array<{ forAgent?: string; content: unknown }> }).deferredMessages
              .filter((msg) => /DURING THE UNDO|A REPLY THAT FAILED|A reply by a-late-g1|c-late|A MODULE WRITE FOR THE FORK/.test(JSON.stringify(msg.content)));
            assert.equal(kept.length, 5, `the persisted queue kept the five: ${JSON.stringify(kept)}`);
            await booted.resume();
            assert.equal(queuedForFork(booted), 0, 'nothing stays queued for the fork');
            const dropped = logged.slice(mark).filter((line) => /delivery target "a-late-g1" is not a registered agent/.test(line));
            assert.equal(dropped.length, 2, logged.slice(mark).join('\n'));
            assert.deepEqual(passedOn(booted), eachOnce, 'the primary gets each of the three');
            const window = await StoreWindow.open({
              store: booted.getStore(), namespace: 'conversations/a-late-g1', isolate: true, strategy: new PassthroughStrategy(),
            });
            for (const texts of [storedTexts(booted.getAgent('a')!.getContextManager()), storedTexts(window)]) {
              assert.ok(!texts.some((text) => /DURING THE UNDO|A REPLY THAT FAILED/.test(text)), JSON.stringify(texts));
            }
          } finally {
            await booted.stop();
          }
        } else if (after === 'released before the report') {
          await framework.resume();
          await framework.stop();
        } else if (after !== 'stop') {
          await framework.resume();
          assert.equal(queuedForFork(framework), 0);
          const window = storedTexts(late);
          assert.equal(window.filter((text) => /DURING THE UNDO|A REPLY THAT FAILED|c-late|A MODULE WRITE FOR THE FORK/.test(text)).length, 5, JSON.stringify(window));
          assert.deepEqual(passedOn(framework), eachOnce, 'the primary gets each of the three');
          await framework.stop();
        } else {
          const mark = logged.length;
          await framework.stop();
          assert.equal(queuedForFork(framework), 0, 'nothing stays queued for the fork');
          const dropped = logged.slice(mark).filter((line) => /delivery target "a-late-g1" is not a registered agent/.test(line));
          assert.equal(dropped.length, 2, logged.slice(mark).join('\n'));
          const booted = await AgentFramework.create(config());
          try {
            const kept = (booted as unknown as { deferredMessages: Array<{ forAgent?: string; content: unknown }> }).deferredMessages
              .filter((msg) => /DURING THE UNDO|A REPLY THAT FAILED|A reply by a-late-g1|c-late|A MODULE WRITE FOR THE FORK/.test(JSON.stringify(msg.content)));
            assert.equal(kept.length, 3, `the persisted queue kept the three for the primary: ${JSON.stringify(kept)}`);
            assert.deepEqual(kept.map((msg) => msg.forAgent), [undefined, undefined, undefined], "the primary's");
            await booted.resume();
            assert.deepEqual(passedOn(booted), eachOnce, 'the primary gets each of the three');
            const window = await StoreWindow.open({
              store: booted.getStore(), namespace: 'conversations/a-late-g1', isolate: true, strategy: new PassthroughStrategy(),
            });
            for (const texts of [storedTexts(booted.getAgent('a')!.getContextManager()), storedTexts(window)]) {
              assert.ok(!texts.some((text) => /DURING THE UNDO|A REPLY THAT FAILED/.test(text)), JSON.stringify(texts));
            }
          } finally {
            await booted.stop();
          }
        }
      } finally {
        console.error = error;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  it("a spawn after a failed stop() is refused, and so is one after a completed stop() and an addModule(): neither begins a lifecycle", { timeout: 30_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'reinit-fork-stopped-'));
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store') });
    let failStop = true;
    const stopper = (name: string) => ({
      name,
      start: async () => {},
      stop: async () => { if (failStop) throw new Error('injected module stop failure'); },
      async onProcess() { return {}; },
      getTools: () => [],
      async handleToolCall(): Promise<never> { throw new Error('No tool calls expected'); },
    });
    const framework = await AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() }],
      modules: [stopper('stopper')],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
    });
    const spawn = (name: string) => (framework as unknown as ForkInternals).createConversationAgent(name, { serverId: 'world', channelId: `world:${name}` });
    try {
      framework.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello a' }]);
      framework.start();
      await assert.rejects(framework.stop());
      await assert.rejects(spawn('a-failed-g1'), /conversation agent "a-failed-g1" not created: the framework is stopping/);
      failStop = false;
      await framework.stop();
      await framework.addModule(stopper('added'));
      await assert.rejects(spawn('a-added-g1'), /conversation agent "a-added-g1" not created: the framework is stopping/);
      framework.start();
      await spawn('a-started-g1');
      assert.ok(framework.getAgent('a-started-g1'), 'a start() begins a lifecycle that spawns');
    } finally {
      failStop = false;
      await framework.stop().catch(() => {});
      if (!store.isClosed()) store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a spawn that reaches its check in stop()'s first steps, while the framework still runs, is refused", { timeout: 30_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'reinit-fork-early-'));
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store') });
    const framework = await AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() }],
      modules: [],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
    });
    const internals = framework as unknown as ForkInternals & { endConnectsInFlight(): void; running: boolean };
    try {
      framework.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello a' }]);
      framework.start();
      const endConnects = internals.endConnectsInFlight.bind(internals);
      let spawning: Promise<unknown> | undefined;
      let running: boolean | undefined;
      internals.endConnectsInFlight = () => {
        running = internals.running;
        spawning = internals.createConversationAgent('a-early-g1', { serverId: 'world', channelId: 'world:early' });
        void spawning.catch(() => {});
        endConnects();
      };
      await framework.stop();
      assert.equal(running, true, 'the spawn reached its check while the framework still ran');
      await assert.rejects(spawning!, /conversation agent "a-early-g1" not created: the framework is stopping/);
      assert.ok(!framework.getAgent('a-early-g1'), 'not registered');
    } finally {
      await framework.stop().catch(() => {});
      if (!store.isClosed()) store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a spawn after a stop() and a start() is made: the check is for a stop() of this lifecycle', { timeout: 30_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'reinit-fork-restart-'));
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store') });
    const framework = await AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() }],
      modules: [],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
    });
    try {
      framework.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello a' }]);
      framework.start();
      await framework.stop();
      framework.start();
      await (framework as unknown as ForkInternals).createConversationAgent('a-after-g1', { serverId: 'world', channelId: 'world:after' });
      assert.ok(framework.getAgent('a-after-g1'), 'registered');
      assert.deepEqual(await textsOf(framework, 'a-after-g1'), ['hello a'], 'seeded from the template');
    } finally {
      await framework.stop().catch(() => {});
      if (!store.isClosed()) store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("while an undo holds the store, a coalesced push's removal of a fork's stored message is declined, and the message stays", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-remove-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const early = framework.getAgent('a-early-g1')!.getContextManager();
      let target: { id: string; text: string } | undefined;
      await duringMaintenanceWait(internals, async () => {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      }, async () => {
        const message = early.getAllMessages().at(-1)!;
        target = { id: message.id, text: storedTexts(early).at(-1)! };
        assert.equal(internals.removePlacement({ agent: 'a-early-g1', messageId: message.id }), false,
          'the removal is declined while the store is held');
        assert.ok(early.getAllMessages().some((m) => m.id === message.id), 'the message is still stored during the hold');
      });
      assert.ok(target, 'a stored message to remove');
      assert.ok(early.getAllMessages().some((m) => m.id === target!.id), `the message is still stored after the release: ${target!.text}`);
    });
  });

  it("while an undo waits for running maintenance, a fork's idle-TTL closure prompt is deferred, and lands after it's seeded again", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-closure-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const late = framework.getAgent('a-late-g1')!.getContextManager();
      const prompt = framework.getConversationRouter()!.closurePrompt;
      await duringMaintenanceWait(internals, async () => {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      }, async () => {
        framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:late' })!.lastActivity = 0;
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
      (cmA as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) => {
        const compiled = await compile(...args);
        (cmA as unknown as { compile: typeof compile }).compile = compile;
        store.createBranchAt('elsewhere', store.currentBranch().name, store.currentSequence());
        await cmA.switchBranch('elsewhere');
        return compiled;
      };
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      } finally {
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      assert.equal(store.currentBranch().name, 'elsewhere');
      assert.deepEqual(storedTexts(late), [], 'nothing seeded from the compile of the branch the store left');
      assert.ok(!framework.getAgent('a-late-g1'), 'the fork is disposed');
      assert.ok(logged.some((line) => /agent=a-late-g1 .*It couldn't be seeded because its seeding from the template failed: Error: the store moved to another branch, [^,]+, while it was being seeded\./.test(line)),
        logged.join('\n'));
    });
  });
});

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
        saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
      };
      const gate = () => internals.providerGate('agent');
      const cm = framework.getAgent('agent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'm1' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cm.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('agent', [{ agentName: 'agent', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      const parkThen = async (label: string, move: () => { settled?: Promise<void> }): Promise<void> => {
        gate().primaryPending = false;
        strategy.armed = true;
        await waitParked();
        const moved = move();
        assert.ok(moved.settled, `${label}: a re-initialization is running`);
        await moved.settled;
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

class GatedTickStrategy implements ContextStrategy {
  readonly name = 'gated-tick-test';
  armed = false;
  stale = false;
  throwOnStale = true;
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
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        assert.ok(undo.settled, 'a re-initialization is running');
        gated.stale = true;
        gated.release!();
        await undo.settled;
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

describe("a re-initialization alert's opening", () => {
  it('is in what the ops webhook keeps of the message, in every shape the builders make', () => {
    const branch = (kind: string) => `${kind}/a/${'9'.repeat(200)}`;
    const restartSays = (kind: AgentKind, elsewhere: boolean): RegExp => kind === 'conversation'
      ? /; a restart ends it, and its channel's next qualifying message spawns a new fork\.$/
      : kind === 'run'
        ? /; a restart ends the run\.$/
        : elsewhere
          ? /; a restart re-initializes it on the branch the store is on instead\.$/
          : /; a restart re-initializes it too, but loses them unless the deferral queue is persisted\.$/;
    const refusalSays: Record<AgentKind, string> = {
      configured: ' The work it refuses includes compiles and message writes. Quiescing the host before it stops persists the deferral queue.',
      conversation: ' The work it refuses includes compiles and message writes, and a fork its channel spawns after a restart gets none of the writes queued for this one.',
      run: ' The work it refuses includes compiles and message writes.',
    };
    for (const [queued, says] of [[0, '0 writes'], [1, '1 write'], [2, '2 writes']] as const) {
      const { opening } = longHoldAlert({ move: 'undo', agentName: 'a', heldSeconds: 61, queued, waitingForMaintenance: false });
      assert.ok(opening.includes(` wait in the deferral queue (${says} now). `), opening);
    }
    for (const causeLength of [3_000, 200_000, 1_000_000]) {
      const cause = `injected cause ${'x'.repeat(causeLength)}`;
      const shapes: Array<[string, ReinitAlertText, { kind: AgentKind; elsewhere: boolean }?]> = [];
      const name = (what: string) => `${what}-${'9'.repeat(200)}`;
      for (const move of REINIT_MOVES) {
        for (const kind of ['configured', 'conversation', 'run'] as const) {
          shapes.push([`refused work after the ${move}, ${kind} agent`, refusedWorkAlert(move, kind, cause), { kind, elsewhere: false }]);
        }
        for (const on of ['reinitializing', 'maintenance', 'neither'] as const) {
          const hold = longHoldAlert({
            move, agentName: `${name('agent')}${'x'.repeat(causeLength)}`, heldSeconds: 999_999_999, queued: 999_999_999,
            ...(on === 'reinitializing' ? { reinitializing: name('manager') } : {}),
            waitingForMaintenance: on === 'maintenance',
          });
          assert.ok(hold.opening.endsWith(`. A restart ends the ${move}, the conversation agents and the runs, and re-initializes the configured agents; writes still queued at exit survive only in a persisted deferral queue.`), hold.opening);
          assert.ok(hold.opening.includes(' wait in the deferral queue (999999999 writes now). '), hold.opening);
          shapes.push([`a long hold by the ${move}, ${on}`, hold]);
        }
        for (const remedy of [undefined, ...Object.values(TEMPLATE_REMEDIES)]) {
          for (const cleanupFailed of [undefined, `injected cleanup failure ${'y'.repeat(500)}`]) {
            for (const heldWrites of [0, 1, 2]) {
              for (const releasePostponed of [false, true]) {
                shapes.push([
                  `disposal after the ${move}, remedy ${remedy}, cleanup ${cleanupFailed !== undefined}, ${heldWrites} held, release postponed ${releasePostponed}`,
                  disposalAlert({ move, remedy, cleanupFailed, heldWrites, releasePostponed, cause }),
                ]);
              }
            }
          }
        }
      }
      for (const selected of [false, true]) {
        for (const kind of ['configured', 'conversation', 'run'] as const) {
          const restore = { source: branch('main'), selected, kind, cause };
          shapes.push([
            `restore after the rollback, selected ${selected}, ${kind} agent`,
            restoreAlert({ ...restore, move: 'rollback', now: branch('rollback') }),
            { kind, elsewhere: !selected },
          ]);
          for (const managerCurrent of [false, true]) {
            shapes.push([
              `restore after the suppression, selected ${selected}, current ${managerCurrent}, ${kind} agent`,
              restoreAlert({ ...restore, move: 'suppression', now: branch('suppression'), managerCurrent }),
              selected || !managerCurrent ? { kind, elsewhere: !selected } : undefined,
            ]);
          }
        }
      }
      for (const [shape, text, refusing] of shapes) {
        assert.ok(text.message.startsWith(text.opening), shape);
        const kept = opsWebhookText(text.message);
        assert.ok(kept.length < text.message.length, `${shape}: the webhook cuts it`);
        assert.ok(kept.startsWith(text.opening), `${shape}: its opening, ${text.opening.length} characters, is in what the webhook keeps:\n${kept}`);
        if (refusing === undefined) continue;
        assert.match(text.opening, restartSays(refusing.kind, refusing.elsewhere), shape);
        assert.ok(text.message.includes(`${refusalSays[refusing.kind]} `), `${shape}: ${text.message.slice(0, 700)}`);
      }
    }
  });
});
