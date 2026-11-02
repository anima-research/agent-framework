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
  REINIT_MOVES, disposalAlert, longHoldAlert, opsWebhookText, refusedWorkAlert, restoreAlert, type ReinitAlertText,
} from '../src/framework.js';
import type { TraceEvent } from '../src/index.js';
import { ApiServer } from '../src/api/server.js';
import { HeldStream, MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

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
const watchRunningPass = (framework: AgentFramework): (() => boolean) => {
  const pass = (framework as unknown as { maintenancePass: Promise<void> | null }).maintenancePass;
  assert.ok(pass, 'a maintenance pass is running');
  let waitedOn = false;
  const then = pass.then.bind(pass) as (onFulfilled?: unknown, onRejected?: unknown) => Promise<unknown>;
  Object.defineProperty(pass, 'then', {
    value: (onFulfilled?: unknown, onRejected?: unknown) => { waitedOn = true; return then(onFulfilled, onRejected); },
  });
  return () => waitedOn;
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
const says = (message: string, ...facts: string[]): void => {
  for (const fact of facts) assert.ok(message.includes(fact), `${JSON.stringify(fact)} in:\n${message}`);
};
const courierModule = (onStart: (ctx: ModuleContext) => void): Module => ({
  name: 'courier',
  async start(ctx: ModuleContext) { onStart(ctx); },
  async stop() {},
  getTools: () => [],
  async handleToolCall() { return { success: true }; },
  async onProcess() { return {}; },
});
/** A turn of `name`'s, answered with `reply`: it records the turn's checkpoint, as any turn does. */
const realTurn = async (framework: AgentFramework, membrane: MockMembrane, name: string, reply: string): Promise<void> => {
  membrane.pushResponse(createMockResponse([{ type: 'text', text: reply }]));
  framework.nudgeAgent(name, 'test');
  await framework.runUntilIdle();
};
/** A turn of `name`'s whose stream holds until `release()`, so the agent is busy meanwhile. */
const heldTurn = (framework: AgentFramework, membrane: MockMembrane, name: string): { streaming: Promise<void>; release: () => Promise<void> } => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let streaming!: () => void;
  const started = new Promise<void>((resolve) => { streaming = resolve; });
  const streamYielding = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request, options) => {
    if (!JSON.stringify(request.system ?? '').includes(`You are ${name}.`)) return streamYielding(request, options);
    membrane.streamYielding = streamYielding;
    membrane.calls.push(request);
    streaming();
    return new HeldStream(released, [createMockResponse([{ type: 'text', text: `${name} answers` }])]);
  };
  framework.nudgeAgent(name, 'test');
  const run = framework.runUntilIdle();
  return { streaming: started, release: async () => { release(); await run; } };
};

type Internals = {
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
};

describe('after a branch move, every agent on the store compiles without a restart', () => {
  let tempDir: string;
  let framework: AgentFramework;
  let membrane: MockMembrane;
  let traces: TraceEvent[];
  let firstId: string;
  let courier: ModuleContext;

  const cmOf = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
  const internals = () => framework as unknown as Internals;
  const text = (t: string) => [{ type: 'text' as const, text: t }];
  const budget = { maxTokens: 100_000, reserveForResponse: 1_000 };
  const works = async (name: string): Promise<void> => {
    await cmOf(name).compile(budget, undefined, { dryRun: true });
    assert.equal(typeof cmOf(name).isReady(), 'boolean');
  };
  const checkpointTurn = async (): Promise<void> => {
    await realTurn(framework, membrane, 'a', 'a turn to undo');
    assert.equal(framework.getUndoRedoState('a').undoDepth, 1, 'the turn recorded its checkpoint');
  };
  const holdFor = (name: string, words: string): void => {
    assert.match(courier.addMessage('courier', text(words), undefined, { forAgent: name }), /^held:/, 'deferred, not stored');
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
      modules: [courierModule((ctx) => { courier = ctx; })],
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

  it('undoLastTurn(): the store moves before it returns, and both compile once its settled settles', async () => {
    await checkpointTurn();
    const r = framework.undoLastTurn('a');
    assert.equal(r.undone, true);
    assert.equal(framework.getStore().currentBranch().name, r.toBranch, 'the store moved before the undo returned');
    await reinitDone(r);
    await works('a');
    await works('b');
  });

  it('redo(): both compile once the store is released', async () => {
    await checkpointTurn();
    await reinitDone(framework.undoLastTurn('a'));
    const r = framework.redo('a');
    assert.equal(r.redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    await reinitDone(r);
    await works('a');
    await works('b');
  });

  it('an undo and a redo made back to back move the store under one reservation, and the managers end current', async () => {
    await checkpointTurn();
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
    await works('a');
    await works('b');
    assert.deepEqual(reinitAlerts(), [], 'the pass the redo overtook is not reported');
  });

  it("the API server's undo and redo tell clients of the move once every manager is current, so a client that reads an agent's context then gets it", async () => {
    await checkpointTurn();
    const api = new ApiServer(framework) as unknown as {
      cmdUndo(params: { agentName: string }): Promise<Record<string, unknown>>;
      cmdRedo(params: { agentName: string }): Promise<Record<string, unknown>>;
      cmdAgentContext(params: { agentName: string }): Promise<{ context: unknown[] }>;
      broadcast(event: string, data: unknown): void;
    };
    const reads: Array<Promise<{ context: unknown[] }>> = [];
    api.broadcast = (event) => {
      if (event !== 'branch:switched') return;
      reads.push(api.cmdAgentContext({ agentName: 'b' }));
    };
    const undone = await api.cmdUndo({ agentName: 'a' });
    assert.equal(undone.undone, true);
    assert.ok(!('settled' in undone), `the answer carries no promise: ${Object.keys(undone).join(', ')}`);
    const redone = await api.cmdRedo({ agentName: 'a' });
    assert.equal(redone.redone, true);
    assert.ok(!('settled' in redone), `the answer carries no promise: ${Object.keys(redone).join(', ')}`);
    assert.equal(reads.length, 2, 'one event for each move');
    for (const read of await Promise.all(reads)) assert.ok(read.context.length > 0, "b's context compiled");
    assert.deepEqual(reinitAlerts(), []);
  });

  it('a host/command turn undo answers with the preview, compiled once the managers are current', async () => {
    await checkpointTurn();
    const answer = await internals().handleHostCommand('discord', { command: 'undo', agentName: 'a', turns: 1 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.undone, 1);
    assert.ok(answer.lastVisible, `the preview compiled: ${JSON.stringify(answer)}`);
    await works('b');
  });

  it('undo and redo are refused while another agent on the store is busy, and keep what they would move', async () => {
    await checkpointTurn();
    const refusedForB = (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /\bb is \w/.test(e.message);
    let busy = heldTurn(framework, membrane, 'b');
    await busy.streaming;
    try {
      assert.throws(() => framework.undoLastTurn('a'), refusedForB);
      assert.equal(framework.getUndoRedoState('a').undoDepth, 1, 'the checkpoint is kept');
      assert.equal(framework.getStore().currentBranch().name, 'main');
    } finally {
      await busy.release();
    }
    await reinitDone(framework.undoLastTurn('a'));
    busy = heldTurn(framework, membrane, 'b');
    await busy.streaming;
    try {
      assert.throws(() => framework.redo('a'), refusedForB);
      assert.equal(framework.getUndoRedoState('a').redoDepth, 1, 'the redo is kept');
    } finally {
      await busy.release();
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
    await checkpointTurn();
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    const held = 'for b, during the hold';
    const textsOfB = () => cmOf('b').getAllMessages()
      .flatMap((m) => m.content)
      .flatMap((block) => (block.type === 'text' ? [block.text] : []));

    const undone = framework.undoLastTurn('a');
    assert.equal(undone.undone, true);
    holdFor('b', held);
    await reinitDone(undone);
    assert.deepEqual(reinitAlerts().map((alert) => alert.agentName), ['b']);
    assert.ok(!textsOfB().includes(held), 'not stored at the release');

    await framework.switchBranch(framework.getStore().currentBranch().name);
    await works('b');
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

  it("an agent that leaves during its own re-initialization, which then fails, isn't reported", async () => {
    await checkpointTurn();
    const internals = framework as unknown as { agents: Map<string, unknown> };
    const b = internals.agents.get('b');
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    let initialized = false;
    strategy.initialize = async () => {
      initialized = true;
      internals.agents.delete('b');
      throw new Error('injected initialization failure');
    };
    try {
      await reinitDone(framework.undoLastTurn('a'));
    } finally {
      internals.agents.set('b', b);
    }
    assert.equal(initialized, true, "b's re-initialization ran");
    assert.deepEqual(reinitAlerts(), []);
  });

  it("the alert's remedy says a switch to the current branch stores the queued writes and a restart can lose them, and stop() says how many it leaves for an agent whose manager refuses them", async () => {
    await checkpointTurn();
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const undone = framework.undoLastTurn('a');
    holdFor('b', 'for b, during the hold');
    holdFor('a', 'for a, during the hold');
    await reinitDone(undone);
    const alerts = reinitAlerts();
    assert.deepEqual(alerts.map((alert) => alert.agentName), ['b']);
    const message = alerts[0]!.message;
    assert.ok(message.startsWith('The undo moved the store\'s branch'), message);
    says(message, 'refuses its work', 'switchBranch() to the current branch re-initializes it and stores its queued writes', 'a restart can lose them');
    assert.match(message, /Its re-initialization failed: .*injected initialization failure\.$/, 'the cause comes last');
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await framework.stop();
    } finally {
      console.error = quiet;
    }
    const left = logged.filter((line) => line.startsWith('[deferral] stop: '));
    assert.ok(left.some((line) => line.includes('1 deferred write(s) for b stay queued') && line.includes('this memory-only queue loses them at exit')), logged.join('\n'));
    assert.ok(!left.some((line) => line.includes('for a stay queued')), `nothing is said for a, whose write the release stored: ${logged.join('\n')}`);
  });

  for (const record of ['current', 'behind'] as const) {
    it(`stop() says a persisted queue whose record is ${record} ${record === 'current' ? 'keeps' : 'can lose'} the writes it leaves for an agent whose manager refuses them`, async () => {
      await checkpointTurn();
      const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      strategy.initialize = async () => { throw new Error('injected initialization failure'); };
      const fw = framework as unknown as { deferredWritesPersisted: boolean; writeDeferredWrites: () => unknown };
      const undone = framework.undoLastTurn('a');
      holdFor('b', 'for b, during the hold');
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
      const line = logged.find((l) => l.includes('1 deferred write(s) for b stay queued'));
      assert.ok(line, logged.join('\n'));
      if (record === 'current') {
        says(line, 'the persisted queue keeps them for boot');
        assert.doesNotMatch(line, /can lose|record is behind/);
      } else {
        says(line, "the persisted queue's record is behind", 'since its last write failed or met the cap', 'a restart can lose them');
        assert.doesNotMatch(line, /keeps them for boot/);
      }
    });
  }

  it('a failed undo or redo leaves the store where it was, released, with its turn kept (createBranchAt and switchBranch throwing)', async () => {
    await checkpointTurn();
    const store = framework.getStore() as unknown as { createBranchAt: (...args: unknown[]) => unknown; switchBranch: (name: string) => void };
    const createBranchAt = store.createBranchAt;
    store.createBranchAt = () => { throw new Error('injected branch failure'); };
    try {
      assert.throws(() => framework.undoLastTurn('a'), /injected branch failure/);
    } finally {
      store.createBranchAt = createBranchAt;
    }
    assert.equal(framework.getUndoRedoState('a').undoDepth, 1, 'the checkpoint is kept');
    assert.equal(framework.getStore().currentBranch().name, 'main');

    await reinitDone(framework.undoLastTurn('a'));
    const switchBranch = store.switchBranch;
    store.switchBranch = () => { throw new Error('injected switch failure'); };
    try {
      assert.throws(() => framework.redo('a'), /injected switch failure/);
    } finally {
      store.switchBranch = switchBranch;
    }
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
        await checkpointTurn();
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
      assert.ok(alerts[0]!.message.startsWith(`The ${move} moved the store's branch`), alerts[0]!.message);
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
    await checkpointTurn();
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

  it("a hold's alert, raised during the pass, names the move, its agent, the manager the pass is on and the writes waiting", async () => {
    await checkpointTurn();
    shortenHoldAlert(2_000);
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
    const undone = framework.undoLastTurn('a');
    const redone = framework.redo('a');
    assert.equal(redone.settled, undone.settled, 'one reservation, one pass that runs again');
    try {
      await until(() => atGate, "b's second re-initialization to reach its gate", 10_000);
      holdFor('a', 'for a, during the hold');
      await until(() => longHoldAlerts().length > 0, 'the store-held-long alert', 10_000);
      const [alert] = longHoldAlerts();
      assert.equal(alert!.agentName, 'a');
      assert.ok(alert!.message.startsWith('The undo has held the store for '), alert!.message);
      says(alert!.message, 'no turn starts', '(1 write now)', 'The undo is for a', "re-initializing b's context manager now");
      const data = alert!.data as { verb?: string; reinitializing?: string; queued?: number; heldMs?: number; waitingForMaintenance?: boolean };
      assert.equal(data.verb, 'undo');
      assert.equal(data.reinitializing, 'b');
      assert.equal(data.waitingForMaintenance, undefined);
      assert.equal(data.queued, 1);
    } finally {
      release();
    }
    await reinitDone(redone);
    assert.equal(longHoldAlerts().length, 1, 'one alert for the hold');
    assert.deepEqual(reinitAlerts(), []);
    await works('b');
  });

  it("a branch switch still holding the store for its config mount after its pass names no manager", async () => {
    shortenHoldAlert(2_000);
    let mounted!: () => void;
    const mount = new Promise<void>((resolve) => { mounted = resolve; });
    const workspace = {
      ...courierModule(() => {}),
      name: 'workspace',
      materializeMount: async () => { await mount; },
    };
    await framework.addModule(workspace as Module);
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
      await until(() => longHoldAlerts().length > 0, 'the store-held-long alert', 10_000);
      const [alert] = longHoldAlerts();
      assert.equal(alert!.agentName, 'every agent');
      assert.ok(alert!.message.startsWith('The branch switch has held the store for '), alert!.message);
      assert.ok(alert!.message.endsWith(' The branch switch is for every agent.'), alert!.message);
      const data = alert!.data as { reinitializing?: string; waitingForMaintenance?: boolean };
      assert.equal(data.reinitializing, undefined);
      assert.equal(data.waitingForMaintenance, undefined);
    } finally {
      mounted();
    }
    await switching;
    assert.equal(longHoldAlerts().length, 1);
    assert.deepEqual(reinitAlerts(), []);
    await works('a');
    await works('b');
  });

  it('an undo whose release throws still settles its settled, and says the release failed', async () => {
    await checkpointTurn();
    const fw = framework as unknown as { readdDrained: (...args: unknown[]) => unknown };
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const readdDrained = fw.readdDrained;
    try {
      const undone = framework.undoLastTurn('a');
      holdFor('b', 'for b, during the hold');
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
    assert.ok(logged.some((line) => line.includes("the undo's re-initialization or its release of the store failed") && line.includes('injected release flush failure')),
      logged.join('\n'));
  });

  it('a hold let go before its threshold says nothing after it', async () => {
    await checkpointTurn();
    shortenHoldAlert(1_000);
    await reinitDone(framework.undoLastTurn('a'));
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
    assert.ok(alerts[0]!.message.startsWith('The suppression failed'), alerts[0]!.message);
    says(alerts[0]!.message, "couldn't be put back", 'refuses its work', 'a restart can lose them');
  });

  it("stop() waits for an undo's re-initialization before the store closes", async () => {
    await checkpointTurn();
    const undone = framework.undoLastTurn('a');
    assert.ok(undone.settled);
    let reinitEnded = false;
    void undone.settled.then(() => { reinitEnded = true; });
    await framework.stop();
    assert.equal(reinitEnded, true, 'the re-initialization finished before stop() returned');
  });

  it('a turn asked for while the managers re-initialize starts once the store is let go', async () => {
    await checkpointTurn();
    const undone = framework.undoLastTurn('a');
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'b answers after the undo' }]));
    framework.nudgeAgent('b', 'test');
    const calls = membrane.calls.length;
    const run = framework.runUntilIdle();
    assert.equal(membrane.calls.length, calls, 'no turn starts while the managers re-initialize');
    await reinitDone(undone);
    await run;
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, calls + 1, 'the turn ran once the store was let go');
  });

  it('a host/command undo of two turns undoes both, then answers', async () => {
    await realTurn(framework, membrane, 'a', 'turn one');
    await realTurn(framework, membrane, 'a', 'turn two');
    const answer = await internals().handleHostCommand('discord', { command: 'undo', agentName: 'a', turns: 2 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.undone, 2);
    assert.equal(framework.getUndoRedoState('a').undoDepth, 0);
    await works('a');
    await works('b');
  });

  it("undo refuses as busy when the named agent is busy, and a joined redo when another agent is", async () => {
    await checkpointTurn();
    const busy = (name: string) => {
      const agent = framework.getAgent(name)!;
      const state = agent.state;
      Object.defineProperty(agent, 'state', { configurable: true, get: () => ({ ...state, status: 'inferring' }) });
      return () => { delete (agent as unknown as { state?: unknown }).state; };
    };
    const turning = heldTurn(framework, membrane, 'a');
    await turning.streaming;
    try {
      assert.throws(
        () => framework.undoLastTurn('a'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /^Cannot undo while agent is \w/.test(e.message),
      );
    } finally {
      await turning.release();
    }
    const undone = framework.undoLastTurn('a');
    const idle = busy('b');
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

  it("an undo's managers re-initialize one at a time, with a turn of the event loop between them", async () => {
    await checkpointTurn();
    const calls: string[] = [];
    let turns = 0;
    let counting = true;
    const countTurn = () => { turns++; if (counting) setImmediate(countTurn); };
    setImmediate(countTurn);
    const turnsAtEntry: number[] = [];
    for (const name of ['a', 'b']) {
      const cm = cmOf(name) as unknown as { setStrategy: (s: unknown) => Promise<void> };
      const setStrategy = cm.setStrategy.bind(cm);
      cm.setStrategy = (strategy: unknown) => {
        calls.push(name);
        turnsAtEntry.push(turns);
        return setStrategy(strategy);
      };
    }
    try {
      const undone = framework.undoLastTurn('a');
      assert.deepEqual(calls, [], 'no manager re-initializes inside undoLastTurn()');
      const before = await new Promise<number>((resolve) => { setImmediate(() => resolve(calls.length)); });
      assert.ok(before < 2, `the event loop ran while the managers re-initialized (${before} of 2 had when it did)`);
      await reinitDone(undone);
    } finally {
      counting = false;
    }
    assert.deepEqual(calls.sort(), ['a', 'b']);
    assert.ok(turnsAtEntry[1]! > turnsAtEntry[0]!,
      `the event loop turned between the two managers' re-initializations (turns at each entry: ${turnsAtEntry.join(', ')})`);
    await works('a');
    await works('b');
  });

  it("an undo's re-initialization waits for an over-budget drain kick already running", async () => {
    await checkpointTurn();
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
    says(message, 'RESTORE TO main selected it', 'FAILED', 'refuses its work until switchBranch() to the current branch re-initializes it');
    assert.doesNotMatch(message, /still on failed-twice/);
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    const alert = alerts[0]!.message;
    assert.ok(alert.startsWith('The rollback failed and the store was put back'), alert);
    says(alert, 'refuses its work', 'switchBranch() to the current branch re-initializes it and stores its queued writes', 'a restart can lose them', 'The store is on main.');
    assert.match(alert, /Its re-initialization failed: .*injected strategy init failure\.$/, 'the cause comes last');
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
    says(message, 'RESTORE TO main ALSO FAILED (injected restore refusal)', 'the store is still on failed-thrice',
      'refuses its work until switchBranch() to main re-initializes it');
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    const alert = alerts[0]!.message;
    assert.ok(alert.startsWith("The rollback failed and the store couldn't be put back"), alert);
    says(alert, 'refuses its work', 'switchBranch() to the branch it should run on re-initializes it and stores its queued writes', 'a restart can lose them');
    assert.ok(alert.endsWith(' The store is on failed-thrice, and the restore to main failed: injected restore refusal.'), alert);
    assert.doesNotMatch(alert, /moved the store's branch/);
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
    says(message, 'RESTORE TO main ALSO FAILED (injected restore refusal)', 'the store is still on partly-suppressed', 'serves from that branch');
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    const alert = alerts[0]!.message;
    assert.ok(alert.startsWith("The suppression failed and the store couldn't be put back"), alert);
    says(alert, 'serves from there, which may be partly suppressed', 'until switchBranch() to the branch it should run on moves it');
    assert.doesNotMatch(alert, /refuses its work/);
    assert.ok(alert.endsWith(' The store is on partly-suppressed, and the restore to main failed: injected restore refusal.'), alert);
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
    says(message, 'RESTORE TO main selected it', 'FAILED (injected strategy init failure)', 'refuses its work until switchBranch() to the current branch re-initializes it');
    const alerts = reinitAlerts().filter((alert) => alert.agentName === 'a');
    assert.equal(alerts.length, 1, JSON.stringify(reinitAlerts()));
    const alert = alerts[0]!.message;
    assert.ok(alert.startsWith('The suppression failed and the store was put back'), alert);
    says(alert, 'refuses its work', 'switchBranch() to the current branch re-initializes it and stores its queued writes', 'a restart can lose them');
    assert.ok(alert.endsWith(' The store is on main. Its re-initialization failed: injected strategy init failure.'), alert);
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
    const kept = keptHead(webhook.posted, 'a', 'context-reinit-failed');
    assert.ok(kept.startsWith("The rollback failed and the store couldn't be put back"), kept);
    says(kept, 'switchBranch() to the branch it should run on re-initializes it and stores its queued writes', 'a restart can lose them');
  });

  it('a suppression whose fork is refused before the store moved re-initializes no other manager and raises no alert', async () => {
    const store = framework.getStore();
    const cmA = cmOf('a') as unknown as { fork: (name: string) => Promise<string> };
    const fork = cmA.fork;
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
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
    assert.deepEqual(reinitAlerts(), [], "nothing moved, so nothing re-initialized b's manager");
    await works('a');
    await works('b');
  });

  it('a rollback whose switch is refused before the store moves re-initializes no other manager', async () => {
    const store = framework.getStore() as unknown as { switchBranch: (name: string) => void };
    const switchBranch = store.switchBranch;
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
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
    assert.deepEqual(reinitAlerts(), [], "nothing moved, so nothing re-initialized b's manager");
    await works('a');
    await works('b');
  });

  it("a redo whose branch was deleted drops that step and says so, with the switch's error as its cause, and the redo beneath it still works", async () => {
    const store = framework.getStore();
    await realTurn(framework, membrane, 'a', 'turn one');
    await realTurn(framework, membrane, 'a', 'turn two');
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

    const redone = framework.redo('a');
    assert.equal(redone.redone, true, 'the step beneath it redoes');
    await reinitDone(redone);
    assert.equal(store.currentBranch().name, 'main');
    await works('a');
    await works('b');
  });

  it("a redo whose switch fails while the branch listing fails too keeps its step, and answers the switch's error", async () => {
    await checkpointTurn();
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
    const redone = framework.redo('a');
    assert.equal(redone.redone, true);
    await reinitDone(redone);
    await works('a');
    await works('b');
  });

  it("a runtime-settings change while an undo's managers re-initialize is refused, and nothing is applied", async () => {
    await checkpointTurn();
    const before = framework.getAgentRuntimeSettings('b');
    const undone = framework.undoLastTurn('a');
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
    await checkpointTurn();
    const undone = framework.undoLastTurn('a');
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

  it("a runtime-settings change while a rollback holds the store is refused, and nothing is applied", async () => {
    const before = framework.getAgentRuntimeSettings('b');
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let atGate = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    strategy.initialize = async (...args: unknown[]) => {
      atGate = true;
      await gate;
      return initialize(...args);
    };
    const rolled = framework.rollbackToMessage('a', { messageId: firstId });
    try {
      await until(() => atGate, "b's re-initialization in the rollback's pass to reach its gate", 10_000);
      assert.throws(
        () => framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
      );
    } finally {
      open();
    }
    await rolled;
    assert.equal(framework.getAgentRuntimeSettings('b').sameRoundThinkTextPolicy, before.sameRoundThinkTextPolicy);
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
    await checkpointTurn();
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
    await works('a');
  });
});

describe('conversation forks and an undo', () => {
  type ForkInternals = Internals & {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ getContextManager(): ContextManager }>;
  };

  it("a fork created while an undo's managers re-initialize waits for them, and compiles", { timeout: 30_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'reinit-fork-'));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
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
      await realTurn(framework, membrane, 'a', 'a turn to undo');
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
      const spawning = internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' });
      await until(() => atGate, "the template's re-initialization to reach its gate", 10_000);
      await settled();
      assert.equal(order.length, 0, `the spawn waits, and nothing has compiled the template: ${JSON.stringify(order)}`);
      open();
      const fork = await spawning;
      (cmA as unknown as { compile: typeof compile }).compile = compile;
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
  type Harness = { membrane: MockMembrane; storePath: string; courier?: ModuleContext; gated?: GatedTickStrategy };
  const harnesses = new WeakMap<AgentFramework, Harness>();
  const harness = (framework: AgentFramework): Harness => harnesses.get(framework)!;
  const withForks = async (
    prefix: string,
    run: (framework: AgentFramework, internals: ForkInternals, logged: string[]) => Promise<void>,
    opts: { tick?: boolean; clock?: boolean } = {},
  ) => {
    const tempDir = mkdtempSync(join(tmpdir(), prefix));
    const membrane = new MockMembrane();
    const gated = opts.tick ? new GatedTickStrategy() : undefined;
    const kept: Harness = { membrane, storePath: join(tempDir, 'store'), ...(gated ? { gated } : {}) };
    const framework = await AgentFramework.create({
      storePath: kept.storePath,
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical(), ...(opts.clock ? { clock: { intervalMinutes: 10 } } : {}) },
        ...(gated ? [{ name: 'm', model: 'test-model', systemPrompt: 'You are m.', strategy: gated }] : []),
      ],
      modules: [courierModule((ctx) => { kept.courier = ctx; })],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
      ...(gated ? { syncIntervalMs: 0, maintenanceIntervalMs: 10 } : {}),
    });
    harnesses.set(framework, kept);
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await run(framework, framework as unknown as ForkInternals, logged);
    } finally {
      console.error = quiet;
      gated?.release?.();
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
  /** Forks a-early-g1, spawned before a's turn, and a-late-g1, after it, each bound and holding a message of its own. */
  const forksAroundACheckpoint = async (framework: AgentFramework, internals: ForkInternals): Promise<void> => {
    const router = framework.getConversationRouter()!;
    const cmA = framework.getAgent('a')!.getContextManager();
    cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
    await internals.createConversationAgent('a-early-g1', { serverId: 'world', channelId: 'world:early' });
    router.bind({ serverId: 'world', channelId: 'world:early' }, 'a-early-g1', 1);
    framework.getAgent('a-early-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'early own' }]);
    await realTurn(framework, harness(framework).membrane, 'a', 'a turn to undo');
    await internals.createConversationAgent('a-late-g1', { serverId: 'world', channelId: 'world:late' });
    router.bind({ serverId: 'world', channelId: 'world:late' }, 'a-late-g1', 1);
    framework.getAgent('a-late-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'late own' }]);
  };
  // On this branch a fork's stored copy of a channel message carries its author
  // (`alice: …`, presentAuthor), so a text is found as written or so prefixed.
  const matches = (t: string, text: string) => t === text || t.endsWith(': ' + text);
  const count = (texts: string[], text: string) => texts.filter((t) => matches(t, text)).length;
  type Alert = { kind: string; agentName: string; message: string };
  const reinitAlertsOf = (framework: AgentFramework): Alert[] => {
    const alerts: Alert[] = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert' && event.kind === 'context-reinit-failed') alerts.push(event as unknown as Alert);
    });
    return alerts;
  };
  const holdFor = (framework: AgentFramework, name: string, words: string): void => {
    assert.match(harness(framework).courier!.addMessage('courier', [{ type: 'text', text: words }], undefined, { forAgent: name }), /^held:/,
      'deferred, not stored');
  };
  /** Holds `name`'s next re-initialization at a gate, so the move's pass waits there with the store held. */
  const gateReinit = (framework: AgentFramework, name: string) => {
    const strategy = framework.getAgent(name)!.getContextManager().getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let gated = false;
    strategy.initialize = async (...args: unknown[]) => {
      if (!gated) {
        gated = true;
        entered();
        await gate;
      }
      return initialize(...args);
    };
    return { reached, open };
  };
  /** The channel's next mention, through the framework's own routing: it spawns and binds a fresh fork, whose texts this returns. */
  const nextForkFor = async (framework: AgentFramework, internals: ForkInternals, channelId: string, disposed: string): Promise<string[]> => {
    const placement = await (internals as unknown as HoldInternals).handleMcplChannelIncoming(channelMessage(channelId, 'THE NEXT MENTION'));
    const fresh = placement?.agent;
    assert.ok(fresh && fresh !== disposed && framework.getAgent(fresh), `a fresh fork took the mention: ${JSON.stringify(placement)}`);
    assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId })?.agentName, fresh, 'and is bound to the channel');
    return textsOf(framework, fresh);
  };

  it("an undo to before a fork was spawned disposes it, unbinds its channel and says so, and the channel's next mention spawns a fresh fork; a fork spawned before that point stays", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts = reinitAlertsOf(framework);
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      await undo.settled;
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      const message = alerts[0]!.message;
      assert.ok(message.startsWith('The undo left this conversation agent with no messages of its own'), message);
      says(message, 'it was disposed and its channel unbound', "Its channel's next qualifying message spawns a new fork",
        "which needs the template's own context manager to be working", "a redo to a branch that holds them doesn't bring this one back");
      assert.doesNotMatch(message, /refuses its work|held for it/);
      assert.ok(!framework.getAgent('a-late-g1'), 'the fork is disposed rather than left to answer with no history');
      const router = framework.getConversationRouter()!;
      assert.equal(router.getBinding({ serverId: 'world', channelId: 'world:late' }), undefined, 'its channel is unbound');
      const fresh = await nextForkFor(framework, internals, 'world:late', 'a-late-g1');
      assert.equal(count(fresh, 'late own'), 0, JSON.stringify(fresh));
      const early = await textsOf(framework, 'a-early-g1');
      assert.equal(count(early, 'early own'), 1, `the fork spawned before the point keeps its own: ${JSON.stringify(early)}`);
      assert.equal(router.getBinding({ serverId: 'world', channelId: 'world:early' })?.agentName, 'a-early-g1');
    });
  });

  for (const move of ['branch switch', 'rollback', 'redo'] as const) {
    it(`a ${move} that leaves a fork with no stored message of its own disposes it and unbinds its channel`, { timeout: 30_000 }, async () => {
      await withForks(`reinit-fork-dispose-${move.replace(' ', '-')}-`, async (framework, internals) => {
        await forksAroundACheckpoint(framework, internals);
        const store = framework.getStore();
        const cmA = framework.getAgent('a')!.getContextManager();
        const alerts = reinitAlertsOf(framework);
        let emptied = 'a-late-g1';
        let channelId = 'world:late';
        if (move === 'branch switch') {
          const turn = cmA.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
          store.createBranchAt('before-late', store.currentBranch().name, turn.sequence);
          await framework.switchBranch('before-late');
        } else if (move === 'rollback') {
          cmA.addMessage('user', [{ type: 'text', text: 'after the turn' }]);
          const turn = cmA.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
          await framework.rollbackToMessage('a', { messageId: turn.id });
        } else {
          await framework.undoLastTurn('a').settled;
          alerts.length = 0;
          emptied = 'a-undo-g1';
          channelId = 'world:undo';
          await internals.createConversationAgent(emptied, { serverId: 'world', channelId });
          framework.getConversationRouter()!.bind({ serverId: 'world', channelId }, emptied, 1);
          framework.getAgent(emptied)!.getContextManager().addMessage('user', [{ type: 'text', text: 'own, on the undo branch' }]);
          await framework.redo('a').settled;
        }
        assert.deepEqual(alerts.map((alert) => alert.agentName), [emptied], JSON.stringify(alerts));
        says(alerts[0]!.message, 'it was disposed and its channel unbound');
        assert.ok(!framework.getAgent(emptied), 'disposed');
        assert.equal(framework.getAgentRecord(emptied)?.ended?.reason, 'context-emptied');
        assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId }), undefined, 'its channel is unbound');
        assert.ok(framework.getAgent('a-early-g1'), 'the fork with history stays');
      });
    });
  }

  it("a clock-keeping fork the move emptied is disposed, though a channel message and a correction arrived for it, re-initialized, while the store was held", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-clock-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      await forkInternals.createConversationAgent('a-tail-g1', { serverId: 'world', channelId: 'world:tail' });
      const alerts = reinitAlertsOf(framework);
      const pass = gateReinit(framework, 'a-tail-g1');
      const undo = framework.undoLastTurn('a');
      try {
        await pass.reached;
        for (const event of [
          channelMessage('world:late', 'A MESSAGE WHILE HELD'),
          channelMessage('world:late', 'A CORRECTION WHILE HELD', { deliverTo: 'a-late-g1' }),
        ]) {
          const placement = await internals.handleMcplChannelIncoming(event);
          assert.equal(placement?.agent, 'a-late-g1', `placed for the fork: ${JSON.stringify(placement)}`);
          assert.ok(placement?.deferredId, `deferred: ${JSON.stringify(placement)}`);
        }
      } finally {
        pass.open();
      }
      await undo.settled;
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed: nothing was written into its emptied namespace while the store was held');
      assert.deepEqual(alerts.map((alert) => alert.agentName).sort(), ['a-late-g1', 'a-tail-g1'], JSON.stringify(alerts));
    }, { clock: true });
  });

  it("a fork the move emptied whose own re-initialization fails is disposed, with the disposal's alert alone, counting the write held for it", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-failed-', async (framework, internals, logged) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts = reinitAlertsOf(framework);
      const late = framework.getAgent('a-late-g1')!.getContextManager().getStrategy() as unknown as { initialize: () => Promise<void> };
      late.initialize = async () => { throw new Error('injected fork init failure'); };
      const undo = framework.undoLastTurn('a');
      holdFor(framework, 'a-late-g1', 'FOR THE LATE FORK');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        undo.settled!.then(() => 'settled'),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(outcome, 'settled', 'the pass and the release finish');
      assert.ok(!logged.some((line) => line.includes("the undo's re-initialization or its release of the store failed")), logged.join('\n'));
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      const message = alerts[0]!.message;
      says(message, 'it was disposed and its channel unbound');
      assert.match(message, /(^| )1 write was held for it while the store was held\./);
      assert.match(message, / Its re-initialization had failed: .*injected fork init failure\.$/, 'its failed re-initialization comes last');
      assert.doesNotMatch(message, /refuses its work/);
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
    });
  });

  it("a fork a move emptied while writes were held for it: the alert counts them", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-held-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const alerts = reinitAlertsOf(framework);
      const pass = gateReinit(framework, 'a');
      const undo = framework.undoLastTurn('a');
      await pass.reached;
      for (const words of ['FIRST DURING THE UNDO', 'SECOND DURING THE UNDO']) {
        const placement = await internals.handleMcplChannelIncoming(channelMessage('world:late', words));
        assert.ok(placement?.deferredId && !placement.messageId, `deferred, not stored: ${JSON.stringify(placement)}`);
      }
      holdFor(framework, 'a-late-g1', 'A MODULE WRITE DURING THE UNDO');
      pass.open();
      await undo.settled;
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(alerts[0]!.message, /(^| )3 writes were held for it while the store was held\./);
    });
  });

  it("a fork whose disposal fails partway is reported with the failure, and the pass goes on to dispose the next emptied fork", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-disposefail-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const router = framework.getConversationRouter()!;
      await internals.createConversationAgent('a-later-g1', { serverId: 'world', channelId: 'world:later' });
      router.bind({ serverId: 'world', channelId: 'world:later' }, 'a-later-g1', 1);
      framework.getAgent('a-later-g1')!.getContextManager().addMessage('user', [{ type: 'text', text: 'later own' }]);
      const alerts = reinitAlertsOf(framework);
      const released = framework as unknown as { releaseWindow: (agent: { name: string }) => void };
      const releaseWindow = released.releaseWindow;
      released.releaseWindow = function (this: unknown, agent: { name: string }) {
        if (agent.name === 'a-late-g1') throw new Error('injected release failure');
        return releaseWindow.call(this, agent);
      };
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        holdFor(framework, 'a-late-g1', 'for a-late-g1, during the hold');
        await undo.settled;
      } finally {
        released.releaseWindow = releaseWindow;
      }
      const byAgent = new Map(alerts.map((alert) => [alert.agentName, alert.message]));
      assert.deepEqual([...byAgent.keys()].sort(), ['a-late-g1', 'a-later-g1'], JSON.stringify(alerts));
      const late = byAgent.get('a-late-g1')!;
      says(late, 'its cleanup failed (below)');
      assert.match(late, /(^| )1 write was held for it while the store was held\./);
      assert.match(late, / Its cleanup failed: .*injected release failure\.$/, 'the failure comes last');
      says(byAgent.get('a-later-g1')!, 'it was disposed and its channel unbound');
      for (const [name, channelId] of [['a-late-g1', 'world:late'], ['a-later-g1', 'world:later']] as const) {
        assert.ok(!framework.getAgent(name), `${name} is unregistered`);
        assert.equal(router.getBinding({ serverId: 'world', channelId }), undefined, `${name}'s channel is unbound`);
      }
      assert.ok(framework.getAgent('a-early-g1'), 'the fork spawned before the point stays');
    });
  });

  it("an undo that empties a fork, and a redo that restores it before the pass ends, leave the fork bound and say nothing", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-undo-redo-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts = reinitAlertsOf(framework);
      const pass = gateReinit(framework, 'a');
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      await pass.reached;
      const redo = framework.redo('a');
      assert.equal(redo.redone, true, 'the redo joins the running re-initialization');
      assert.equal(redo.settled, undo.settled, 'and settles with it');
      pass.open();
      await redo.settled;
      assert.deepEqual(alerts, [], 'nothing reported');
      assert.ok(framework.getAgent('a-late-g1'), 'not disposed');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:late' })?.agentName, 'a-late-g1');
      const late = await textsOf(framework, 'a-late-g1');
      assert.equal(count(late, 'late own'), 1, JSON.stringify(late));
    });
  });

  it('a fork with stored history on the landed branch stays, and nothing is said, even when that history compiles to nothing', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hashistory-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts = reinitAlertsOf(framework);
      const early = framework.getAgent('a-early-g1')!.getContextManager();
      const stored = early.getMessageCount();
      const compile = early.compile.bind(early);
      (early as unknown as { compile: typeof compile }).compile = async (...args: Parameters<typeof compile>) =>
        ({ ...(await compile(...args)), messages: [] });
      try {
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        await undo.settled;
      } finally {
        (early as unknown as { compile: typeof compile }).compile = compile;
      }
      assert.ok(framework.getAgent('a-early-g1'), 'not disposed');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:early' })?.agentName, 'a-early-g1');
      assert.equal(early.getMessageCount(), stored, 'its history is untouched');
      assert.ok(!alerts.some((alert) => alert.agentName === 'a-early-g1'), JSON.stringify(alerts));
    });
  });

  it('a move is refused while a fork is being created, and goes through once it is', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-inflight-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      await realTurn(framework, harness(framework).membrane, 'a', 'a turn to undo');
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
      assert.equal(undo.undone, true, 'not refused once the fork is created');
      await undo.settled;
    });
  });

  it('a spawn that fails clears its name, so a move goes through after it', { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-spawnfail-', async (framework, internals) => {
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      await realTurn(framework, harness(framework).membrane, 'a', 'a turn to undo');
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

  type Placement = { agent: string; messageId?: string; deferredId?: string };
  type HoldInternals = ForkInternals & {
    handleMcplChannelIncoming(event: unknown): Promise<Placement | undefined>;
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
  /** Starts m's maintenance tick and holds it, makes the move, which waits for the tick, and runs `during` meanwhile. */
  const duringMaintenanceWait = async (framework: AgentFramework, move: () => Promise<unknown>, during: () => Promise<void>): Promise<void> => {
    const gated = harness(framework).gated!;
    framework.start();
    gated.armed = true;
    await until(() => gated.entered, "m's maintenance tick to start", 8_000);
    const waitedOn = watchRunningPass(framework);
    let moved: Promise<unknown> | undefined;
    let done = false;
    try {
      moved = move();
      void moved.then(() => { done = true; }, () => { done = true; });
      await until(waitedOn, 'the move to wait on the running maintenance pass', 8_000);
      assert.equal(done, false, 'the move waits on the running maintenance tick');
      await during();
    } finally {
      gated.release?.();
    }
    await moved;
  };

  it("while an undo holds the store, a kept fork's channel message and a correction for it are deferred, and land after the release", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-writes-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const early = framework.getAgent('a-early-g1')!.getContextManager();
      const placements: Array<Placement | undefined> = [];
      const added: Array<{ messageId: string; source: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'message:added') added.push(event as unknown as { messageId: string; source: string });
      });
      const pass = gateReinit(framework, 'a');
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      await pass.reached;
      placements.push(await internals.handleMcplChannelIncoming(channelMessage('world:early', 'MESSAGE DURING THE UNDO')));
      placements.push(await internals.handleMcplChannelIncoming(channelMessage('world:early', 'CORRECTION DURING THE UNDO', { deliverTo: 'a-early-g1' })));
      for (const placement of placements) {
        assert.ok(placement?.deferredId && !placement.messageId, `deferred, not stored: ${JSON.stringify(placement)}`);
      }
      assert.ok(!storedTexts(early).some((text) => text.includes('DURING THE UNDO')), 'nothing written into the fork during the hold');
      pass.open();
      await undo.settled;
      const texts = await textsOf(framework, 'a-early-g1');
      const own = texts.findIndex((t) => matches(t, 'early own'));
      const message = texts.findIndex((t) => matches(t, 'MESSAGE DURING THE UNDO'));
      const correction = texts.findIndex((t) => matches(t, 'CORRECTION DURING THE UNDO'));
      assert.ok(own >= 0 && message > own && correction > message, `its own history, then the two writes: ${JSON.stringify(texts)}`);
      assert.equal(count(texts, 'MESSAGE DURING THE UNDO') + count(texts, 'CORRECTION DURING THE UNDO'), 2, JSON.stringify(texts));
      assert.deepEqual(added.filter((t) => t.source === 'mcpl:channel-incoming').map((t) => t.messageId), ['', ''],
        `traced at the deferral, with no id yet: ${JSON.stringify(added)}`);
      const storedId = (words: string) => early.getAllMessages()
        .find((m) => m.content.some((b) => typeof (b as { text?: string }).text === 'string' && matches((b as { text: string }).text, words)))?.id;
      assert.deepEqual(added.filter((t) => t.source === 'deferred-flush:surgery-release').map((t) => t.messageId),
        [storedId('MESSAGE DURING THE UNDO'), storedId('CORRECTION DURING THE UNDO')], `traced as each lands, with its stored id: ${JSON.stringify(added)}`);
    });
  });

  it("while an undo holds the store, a kept fork's idle-TTL closure prompt is deferred, and lands after the release", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-closure-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const early = framework.getAgent('a-early-g1')!.getContextManager();
      const prompt = framework.getConversationRouter()!.closurePrompt;
      const pass = gateReinit(framework, 'a');
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      await pass.reached;
      framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:early' })!.lastActivity = 0;
      internals.lastConversationSweep = 0;
      internals.sweepExpiredConversations();
      assert.equal(count(storedTexts(early), prompt), 0, 'the closure prompt is not written into the fork during the hold');
      pass.open();
      await undo.settled;
      const texts = storedTexts(early);
      assert.ok(texts.indexOf(prompt) > texts.indexOf('early own'), `its own history, then the closure prompt: ${JSON.stringify(texts)}`);
      assert.equal(count(texts, prompt), 1, JSON.stringify(texts));
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
    });
  });

  it("a spawn after a failed stop() is refused, and so is one after a completed stop(), where addModule() and start() are refused too", { timeout: 30_000 }, async () => {
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
      await assert.rejects(spawn('a-stopped-g1'), /conversation agent "a-stopped-g1" not created: the framework is stopping/);
      await assert.rejects(framework.addModule(stopper('added')), /addModule\(\) refused: this framework has stopped/);
      assert.throws(() => framework.start(), /start\(\) refused: this framework has stopped/);
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

  it("a spawn on a new framework on a stopped one's store is made, seeded from the template", { timeout: 30_000 }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'reinit-fork-restart-'));
    const store = JsStore.openOrCreate({ path: join(tempDir, 'store') });
    const create = () => AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() }],
      modules: [],
      conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
    });
    const first = await create();
    let next: AgentFramework | undefined;
    try {
      first.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello a' }]);
      first.start();
      await first.stop();
      next = await create();
      next.start();
      await (next as unknown as ForkInternals).createConversationAgent('a-after-g1', { serverId: 'world', channelId: 'world:after' });
      assert.ok(next.getAgent('a-after-g1'), 'registered');
      assert.deepEqual(await textsOf(next, 'a-after-g1'), ['hello a'], 'seeded from the template');
    } finally {
      await next?.stop().catch(() => {});
      await first.stop().catch(() => {});
      if (!store.isClosed()) store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a fork spawned while a rollback waits for running maintenance keeps its name to itself after a restart", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-spawn-counter-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'after the turn' }]);
      const point = cmA.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
      const source = framework.getStore().currentBranch().name;
      let arriving: Promise<Placement | undefined> | undefined;
      await duringMaintenanceWait(framework, () => framework.rollbackToMessage('a', { messageId: point.id }), async () => {
        arriving = internals.handleMcplChannelIncoming(channelMessage('world:new', 'A FIRST MENTION'));
        await settled();
      });
      const placement = await arriving!;
      assert.notEqual(framework.getStore().currentBranch().name, source, 'the rollback moved the store');
      const first = placement?.agent;
      assert.ok(first && framework.getAgent(first), `the spawn made its fork: ${JSON.stringify(placement)}`);
      await framework.stop();
      const again = await AgentFramework.create({
        storePath: harness(framework).storePath,
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() }],
        modules: [],
        conversations: { templateAgent: 'a', bind: { channel: 'mention' }, strategyFactory: () => autobiographical() },
      });
      try {
        const next = await (again as unknown as HoldInternals).handleMcplChannelIncoming(channelMessage('world:new', 'A MENTION AFTER THE RESTART'));
        const fresh = next?.agent;
        assert.ok(fresh && again.getAgent(fresh), `the mention after the restart spawned a fork: ${JSON.stringify(next)}`);
        assert.notEqual(fresh, first, "the channel's next fork after the restart isn't given the first fork's name");
        const texts = await textsOf(again, fresh);
        assert.ok(!texts.some((text) => text.includes('A FIRST MENTION')), `nor its conversation: ${JSON.stringify(texts)}`);
      } finally {
        await again.stop();
      }
    }, { tick: true });
  });

  it("a rollback asked for in the same step as a mention that spawns a fork is refused as busy", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-spawn-busy-', async (framework, forkInternals) => {
      const internals = forkInternals as unknown as HoldInternals;
      const cmA = framework.getAgent('a')!.getContextManager();
      cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]);
      cmA.addMessage('user', [{ type: 'text', text: 'again' }]);
      const first = cmA.getAllMessages()[0]!;
      const arriving = internals.handleMcplChannelIncoming(channelMessage('world:new', 'A FIRST MENTION'));
      await assert.rejects(framework.rollbackToMessage('a', { messageId: first.id }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /is being created/.test(e.message));
      const placement = await arriving;
      assert.ok(placement?.agent && framework.getAgent(placement.agent), `the spawn made its fork: ${JSON.stringify(placement)}`);
      // On this branch the spawn also tells its source (Dendrite's derivation
      // notice), so the two rows stand first and the only row after them is that notice.
      const texts = storedTexts(cmA);
      assert.deepEqual(texts.slice(0, 2), ['hello a', 'again'], 'the rollback changed nothing');
      assert.ok(texts.length <= 3, `only the derivation notice may follow: ${JSON.stringify(texts)}`);
    });
  });

  it("a fork that refused its work and is then disposed has both alerts posted to the webhook", { timeout: 30_000 }, async () => {
    const webhook = captureWebhook();
    try {
      await withForks('reinit-fork-dispose-webhook-', async (framework, internals) => {
        await forksAroundACheckpoint(framework, internals);
        const strategy = framework.getAgent('a-late-g1')!.getContextManager().getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
        const initialize = strategy.initialize.bind(strategy);
        strategy.initialize = async () => { throw new Error('injected fork init failure'); };
        await framework.switchBranch(framework.getStore().currentBranch().name);
        strategy.initialize = initialize;
        await framework.undoLastTurn('a').settled;
        assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
        const posts = webhook.posted.filter((post) => post.startsWith('\u{1F6A8} **a-late-g1** context-reinit-failed: '));
        assert.equal(posts.length, 2, JSON.stringify(posts.map((post) => post.slice(0, 120))));
        says(posts[0]!, 'refuses its work');
        says(posts[1]!, 'it was disposed and its channel unbound');
      });
    } finally {
      webhook.restore();
    }
  });

  it("while a rollback waits for running maintenance, a fork's channel message is deferred, and lands on the branch the rollback moves to", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-hold-rollback-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      framework.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'after the turn' }]);
      const point = framework.getAgent('a')!.getContextManager().getAllMessages()
        .find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
      const source = framework.getStore().currentBranch().name;
      let placement: Placement | undefined;
      await duringMaintenanceWait(framework, () => framework.rollbackToMessage('a', { messageId: point.id }), async () => {
        placement = await internals.handleMcplChannelIncoming(channelMessage('world:early', 'MESSAGE DURING THE ROLLBACK'));
        assert.ok(placement?.deferredId && !placement.messageId, `deferred, not stored: ${JSON.stringify(placement)}`);
      });
      assert.notEqual(framework.getStore().currentBranch().name, source, 'the rollback moved the store');
      const early = await textsOf(framework, 'a-early-g1');
      assert.equal(count(early, 'MESSAGE DURING THE ROLLBACK'), 1, `on the branch the rollback moved to: ${JSON.stringify(early)}`);
    }, { tick: true });
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
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(`${event.kind}:${event.agentName}:${event.message}`);
      });
      const internals = framework as unknown as {
        providerGate(name: string): { primaryPending: boolean; auxiliaryWaiters: Array<() => void> };
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
  staleRefusal = 'GatedTickStrategy.tick requires reinitialization for the current branch generation';
  readinessFailure?: string;
  failure?: Error;
  entered = false;
  release?: () => void;

  checkReadiness(): ReadinessState {
    if (this.stale) throw new Error(this.readinessFailure ?? 'GatedTickStrategy.checkReadiness requires reinitialization for the current branch generation');
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
    if (this.stale && this.throwOnStale) throw new Error(this.staleRefusal);
  }

  select(_store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] {
    return [];
  }
}

describe('an undo while a maintenance tick runs', () => {
  const variants = [
    { where: 'the tick meets the re-initialization refusal', stale: 'tick', refusal: 'GatedTickStrategy.tick requires reinitialization for the current branch generation' },
    { where: "the tick's write meets the stale-branch refusal", stale: 'tick', refusal: 'GatedTickStrategy.persistPins refused stale branch-scoped mutation' },
    { where: 'the readiness read after the tick meets the refusal', stale: 'readiness' },
    { where: 'the tick fails for another reason', stale: 'readiness', failure: 'provider exploded' },
    { where: 'the readiness read after the tick fails for another reason', stale: 'readiness', failure: 'readiness exploded', readinessOnly: true },
  ] as const;
  for (const variant of variants) {
    const alerted = 'failure' in variant;
    it(`${alerted ? 'keeps' : 'raises no'} maintenance-failure alert when ${variant.where} after the store moved`, { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'reinit-tick-'));
      const gated = new GatedTickStrategy();
      gated.throwOnStale = variant.stale === 'tick';
      if ('refusal' in variant) gated.staleRefusal = variant.refusal;
      if ('readinessOnly' in variant) gated.readinessFailure = variant.failure;
      else if ('failure' in variant) gated.failure = new Error(variant.failure);
      const membrane = new MockMembrane();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: membrane.asMembrane(),
        agents: [
          { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
          { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: gated },
        ],
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 10,
      });
      const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string });
      });
      framework.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello a' }]);
      const quiet = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await realTurn(framework, membrane, 'a', 'a turn to undo');
        framework.start();
        gated.armed = true;
        await until(() => gated.entered, "b's tick to start", 8_000);
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        assert.ok(undo.settled, 'a re-initialization is running');
        gated.stale = true;
        gated.release!();
        await undo.settled;
        const failed = alerts.filter((alert) => alert.kind === 'context-maintenance-failed');
        if ('failure' in variant) {
          assert.deepEqual(failed.map((alert) => alert.agentName), ['b'], JSON.stringify(alerts));
          says(failed[0]!.message, variant.failure);
        } else {
          assert.deepEqual(failed, [], JSON.stringify(alerts));
          assert.ok(logged.some((line) => line.includes('agent=b stopped: an undo moved the store under the tick')) || variant.stale === 'readiness',
            logged.join('\n'));
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

describe('a move while a maintenance tick is already running', () => {
  const withRunningTick = async (
    prefix: string,
    run: (framework: AgentFramework, gated: GatedTickStrategy, firstId: string) => Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const membrane = new MockMembrane();
    const gated = new GatedTickStrategy();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
        { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: autobiographical() },
        { name: 'm', model: 'test-model', systemPrompt: 'You are m.', strategy: gated },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 10,
    });
    try {
      const cmA = framework.getAgent('a')!.getContextManager();
      const firstId = String(cmA.addMessage('user', [{ type: 'text', text: 'hello a' }]));
      framework.getAgent('b')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello b' }]);
      cmA.addMessage('user', [{ type: 'text', text: 'second a' }]);
      await realTurn(framework, membrane, 'a', 'a turn to undo');
      framework.start();
      gated.armed = true;
      await until(() => gated.entered, "m's maintenance tick to start", 8_000);
      await run(framework, gated, firstId);
    } finally {
      gated.release?.();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const longHoldAlertsOf = (framework: AgentFramework) => {
    const alerts: Array<{ agentName: string; message: string; data?: unknown }> = [];
    framework.onTrace((event) => {
      if (event.type === 'ops:alert' && event.kind === 'store-held-long') alerts.push(event as unknown as { agentName: string; message: string; data?: unknown });
    });
    return alerts;
  };

  for (const move of ['rollback', 'suppression'] as const) {
    it(`a ${move} still waiting for the tick when its hold passes the threshold raises the alert, naming the ${move} and saying it waits for maintenance`, { timeout: 30_000 }, async () => {
      await withRunningTick(`reinit-tick-${move}-`, async (framework, gated, firstId) => {
        (framework as unknown as { holdAlertMs: number }).holdAlertMs = 1_000;
        const alerts = longHoldAlertsOf(framework);
        const moving = move === 'rollback'
          ? framework.rollbackToMessage('a', { messageId: firstId })
          : framework.suppressMessages('a', { messageIds: [firstId] });
        let done = false;
        void moving.then(() => { done = true; }, () => { done = true; });
        try {
          await until(() => alerts.length > 0, 'the store-held-long alert', 10_000);
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          assert.equal(alerts.length, 1, 'one alert for the hold, past its threshold');
          assert.equal(done, false, `the ${move} is still waiting for the tick`);
          const [alert] = alerts;
          assert.equal(alert!.agentName, 'a');
          // The alert comes at its threshold, not before. The hold is measured
          // by Date.now() and the timer runs on libuv's clock, each to the whole
          // millisecond, so it can read just under 1,000 (as tool-result-guard's
          // duration check allows).
          assert.ok(((alert!.data as { heldMs?: number }).heldMs ?? 0) >= 1_000 - 5, JSON.stringify(alert!.data));
          assert.ok(alert!.message.startsWith(`The ${move} has held the store for `), alert!.message);
          assert.ok(alert!.message.endsWith(` The ${move} is for a, and is waiting for maintenance work that was already running to finish.`), alert!.message);
          const data = alert!.data as { verb?: string; reinitializing?: string; waitingForMaintenance?: boolean };
          assert.equal(data.verb, move === 'rollback' ? 'roll back' : 'suppress');
          assert.equal(data.waitingForMaintenance, true);
          assert.equal(data.reinitializing, undefined);
        } finally {
          gated.release!();
        }
        await moving;
        assert.equal(alerts.length, 1, 'nothing more once the store is let go');
      });
    });
  }

  it("an undo's re-initialization waits for the tick before any manager re-initializes", { timeout: 30_000 }, async () => {
    await withRunningTick('reinit-tick-undo-', async (framework, gated) => {
      const calls: string[] = [];
      for (const name of ['a', 'b', 'm']) {
        const cm = framework.getAgent(name)!.getContextManager() as unknown as { setStrategy: (s: unknown) => Promise<void> };
        const setStrategy = cm.setStrategy.bind(cm);
        cm.setStrategy = (strategy: unknown) => { calls.push(name); return setStrategy(strategy); };
      }
      const waitedOn = watchRunningPass(framework);
      const undone = framework.undoLastTurn('a');
      assert.equal(undone.undone, true);
      let done = false;
      void undone.settled!.then(() => { done = true; });
      await until(waitedOn, 'the re-initialization to wait on the running maintenance pass', 8_000);
      assert.equal(done, false, 'the re-initialization is waiting for the tick');
      assert.deepEqual(calls, [], 'no manager re-initializes while the tick runs');
      gated.release!();
      await undone.settled;
      assert.deepEqual(calls.sort(), ['a', 'b', 'm']);
    });
  });

  it("a branch switch waits for the tick before it moves the store", { timeout: 30_000 }, async () => {
    await withRunningTick('reinit-tick-switch-', async (framework, gated) => {
      const store = framework.getStore();
      store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
      const waitedOn = watchRunningPass(framework);
      const switching = framework.switchBranch('side');
      let done = false;
      void switching.then(() => { done = true; }, () => { done = true; });
      await until(waitedOn, 'the switch to wait on the running maintenance pass', 8_000);
      assert.equal(store.currentBranch().name, 'main', 'the store has not moved while the tick runs');
      assert.equal(done, false);
      gated.release!();
      await switching;
      assert.equal(store.currentBranch().name, 'side');
    });
  });
});

describe("a re-initialization alert's opening", () => {
  it('is in what the ops webhook keeps of the message, in every shape the builders make', () => {
    const branch = (kind: string) => `${kind}/a/${'9'.repeat(200)}`;
    const remedy = 're-initializes it and stores its queued writes, at resume on a quiesced host; a restart can lose them.';
    for (const [queued, says] of [[0, '0 writes'], [1, '1 write'], [2, '2 writes']] as const) {
      const { opening } = longHoldAlert({ move: 'undo', agentName: 'a', heldSeconds: 61, queued, waitingForMaintenance: false });
      assert.ok(opening.includes(` wait in the deferral queue (${says} now). `), opening);
    }
    for (const causeLength of [3_000, 200_000, 1_000_000]) {
      const cause = `injected cause ${'x'.repeat(causeLength)}`;
      const shapes: Array<[string, ReinitAlertText, boolean]> = [];
      const name = (what: string) => `${what}-${'9'.repeat(200)}`;
      for (const move of REINIT_MOVES) {
        shapes.push([`refused work after the ${move}`, refusedWorkAlert(move, cause), true]);
        for (const on of ['reinitializing', 'maintenance', 'neither'] as const) {
          const hold = longHoldAlert({
            move, agentName: `${name('agent')}${'x'.repeat(causeLength)}`, heldSeconds: 999_999_999, queued: 999_999_999,
            ...(on === 'reinitializing' ? { reinitializing: name('manager') } : {}),
            waitingForMaintenance: on === 'maintenance',
          });
          assert.ok(hold.opening.includes(' wait in the deferral queue (999999999 writes now). '), hold.opening);
          says(hold.opening, `A restart ends the ${move}, the conversation agents and the runs`, 're-initializes the configured agents',
            'writes still queued at exit survive only in a persisted deferral queue');
          shapes.push([`a long hold by the ${move}, ${on}`, hold, false]);
        }
        for (const heldWrites of [0, 1, 2, 999_999_999]) {
          const cleanupFailed = `injected cleanup failure ${'y'.repeat(causeLength)}`;
          const reinitFailed = `injected re-initialization failure ${'z'.repeat(causeLength)}`;
          shapes.push([`disposal after the ${move} whose cleanup failed, ${heldWrites} held`, disposalAlert({ move, cleanupFailed, heldWrites }), false]);
          shapes.push([`disposal after the ${move} whose re-initialization failed, ${heldWrites} held`, disposalAlert({ move, reinitFailed, heldWrites }), false]);
          const bothFailed = disposalAlert({ move, reinitFailed, cleanupFailed, heldWrites });
          says(bothFailed.message, `Its re-initialization had failed: ${reinitFailed}.`, `Its cleanup failed: ${cleanupFailed}.`);
          shapes.push([`disposal after the ${move} whose re-initialization and cleanup failed, ${heldWrites} held`, bothFailed, false]);
          const whole = disposalAlert({ move, heldWrites }).message;
          assert.equal(opsWebhookText(whole), whole, `a disposal after the ${move} with ${heldWrites} held and no failure carries no cause, and is kept whole`);
        }
      }
      for (const selected of [false, true]) {
        const restore = { source: branch('main'), selected, cause };
        shapes.push([`restore after the rollback, selected ${selected}`, restoreAlert({ ...restore, move: 'rollback', now: branch('rollback') }), true]);
        for (const managerCurrent of [false, true]) {
          shapes.push([
            `restore after the suppression, selected ${selected}, current ${managerCurrent}`,
            restoreAlert({ ...restore, move: 'suppression', now: branch('suppression'), managerCurrent }),
            selected || !managerCurrent,
          ]);
        }
      }
      for (const [shape, text, refusing] of shapes) {
        assert.ok(text.message.startsWith(text.opening), shape);
        const kept = opsWebhookText(text.message);
        assert.ok(kept.length < text.message.length, `${shape}: the webhook cuts it`);
        assert.ok(kept.startsWith(text.opening), `${shape}: its opening, ${text.opening.length} characters, is in what the webhook keeps:\n${kept}`);
        if (refusing) assert.ok(text.opening.endsWith(remedy), `${shape}: the remedy ends its opening: ${text.opening}`);
      }
    }
  });
});
