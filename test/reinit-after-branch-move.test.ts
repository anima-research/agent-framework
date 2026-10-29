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
import { AgentFramework, OperatorActionError, describeReadMark, residentContextOptions } from '../src/index.js';
import type { Module, ModuleContext } from '../src/index.js';
import {
  REINIT_MOVES, disposalAlert, longHoldAlert, opsWebhookText, refusedWorkAlert, restoreAlert, type ReinitAlertText,
} from '../src/framework.js';
import type { TraceEvent } from '../src/index.js';
import { ApiServer } from '../src/api/server.js';
import { HeldStream, MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';

// Read onto #291's presentation index (feat/presentation). #353 re-initializes
// every context manager on the store after a move of its branch; here that is
// the mechanism for every move (followBranchMove), and the agent's window
// follows the move beside it (rebased, written down where the branch has none:
// the last describe). Four things differ, and the tests below say so where
// they meet them:
// - An undo and a redo are on the agent's window (decision 4): they move no
//   branch, reserve nothing and re-initialize no manager, so every agent goes
//   on compiling and neither answers with `settled`. A test whose point is a
//   move that holds the store and re-initializes every manager makes that move
//   with switchBranch() here, the store's own move, or a switch to a branch
//   made before a turn where main's undo went before it.
// - No queue holds a write. A write made while a move holds the store is kept
//   in memory by the hold (a module's addMessage answers '', a fork's channel
//   message is placed for the fork with no id) and stored at the release. A
//   write for an agent whose manager then refuses its work waits in memory
//   too, as does every write for it until a switch re-initializes it, which
//   stores them (main kept them in its queue); an agent that ends first passes
//   on the ones the primary takes in its place.
// - stop() has no queued write to name, persisted or not.
// - A row written past the framework enters an agent's window at its next
//   point, so a test that reads a context such a row should be in presents it
//   first.

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
    assert.equal(courier.addMessage('courier', text(words), undefined, { forAgent: name }), '', 'held by the hold, not stored');
  };
  /** The managers whose strategy is set again from now on, by name. */
  const watchReinits = (): (() => string[]) => {
    const calls: string[] = [];
    for (const name of ['a', 'b']) {
      const cm = cmOf(name) as unknown as { setStrategy: (s: unknown) => Promise<void> };
      const setStrategy = cm.setStrategy.bind(cm);
      cm.setStrategy = (strategy: unknown) => { calls.push(name); return setStrategy(strategy); };
    }
    return () => calls;
  };
  /** A switch to the branch the store is on, the move that holds the store
   *  and re-initializes every manager, whose pass waits at `name`'s next
   *  re-initialization until `open()`. */
  const gatedSwitch = (name: string) => {
    const strategy = cmOf(name).getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
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
    const switched = framework.switchBranch(framework.getStore().currentBranch().name);
    return { reached, open, switched };
  };
  /** The message:added traces from now on. */
  const addedTraces = (): Array<{ messageId: string; source: string }> => {
    const added: Array<{ messageId: string; source: string }> = [];
    framework.onTrace((event) => {
      if (event.type === 'message:added') added.push({ messageId: event.messageId, source: event.source });
    });
    return added;
  };
  /** A process event, through every module, as the event loop dispatches it. */
  const dispatchProcessEvent = (event: Record<string, unknown>): Promise<void> =>
    (framework as unknown as { dispatchProcessEventToModules(event: unknown): Promise<void> }).dispatchProcessEventToModules(event);
  const textsOfCm = (name: string): string[] => cmOf(name).getAllMessages()
    .flatMap((m) => m.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []));
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

  it('undoLastTurn() moves no branch and re-initializes no manager: both compile at once, and it answers with no settled', async () => {
    await checkpointTurn();
    const reinitialized = watchReinits();
    const r = framework.undoLastTurn('a');
    assert.equal(r.undone, true);
    assert.equal(r.fromBranch, 'main');
    assert.equal(r.toBranch, 'main', 'the store stays on its branch');
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.ok(r.window && r.window.retracted > 0, `the turn left a's window: ${JSON.stringify(r.window)}`);
    assert.equal(r.settled, undefined, 'nothing is held, so nothing settles');
    assert.deepEqual(reinitialized(), [], 'no manager is re-initialized');
    await works('a');
    await works('b');
    assert.deepEqual(reinitAlerts(), []);
  });

  it('redo() moves no branch and re-initializes no manager: both compile at once', async () => {
    await checkpointTurn();
    assert.equal(framework.undoLastTurn('a').undone, true);
    const reinitialized = watchReinits();
    const r = framework.redo('a');
    assert.equal(r.redone, true);
    assert.equal(r.toBranch, 'main');
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.equal(r.settled, undefined);
    assert.deepEqual(reinitialized(), []);
    await works('a');
    await works('b');
  });

  it('an undo and a redo made back to back hold nothing: a switch right after goes through, and the managers stay current', async () => {
    await checkpointTurn();
    assert.equal(framework.undoLastTurn('a').undone, true);
    assert.equal(framework.redo('a').redone, true);
    assert.equal(framework.getStore().currentBranch().name, 'main');
    await framework.switchBranch('main');
    await works('a');
    await works('b');
    assert.deepEqual(reinitAlerts(), []);
  });

  it("the API server's undo and redo tell clients of the window's change (window:undone), and a client that reads an agent's context then gets it", async () => {
    await checkpointTurn();
    const api = new ApiServer(framework) as unknown as {
      cmdUndo(params: { agentName: string }): Promise<Record<string, unknown>>;
      cmdRedo(params: { agentName: string }): Promise<Record<string, unknown>>;
      cmdAgentContext(params: { agentName: string }): Promise<{ context: unknown[] }>;
      broadcast(event: string, data: unknown): void;
    };
    // b's rows were written past the framework, so they enter its window at
    // its next point (#291): present them, as a turn of b's would.
    (framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(framework.getAgent('b'));
    const reads: Array<Promise<{ context: unknown[] }>> = [];
    api.broadcast = (event) => {
      if (event !== 'window:undone') return;
      reads.push(api.cmdAgentContext({ agentName: 'b' }));
    };
    const undone = await api.cmdUndo({ agentName: 'a' });
    assert.equal(undone.undone, true);
    assert.ok(!('settled' in undone), `the answer carries no promise: ${Object.keys(undone).join(', ')}`);
    const redone = await api.cmdRedo({ agentName: 'a' });
    assert.equal(redone.redone, true);
    assert.ok(!('settled' in redone), `the answer carries no promise: ${Object.keys(redone).join(', ')}`);
    assert.equal(reads.length, 2, 'one event for each change');
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

  it('undo and redo go through while another agent on the store is busy: they move no branch under it', async () => {
    await checkpointTurn();
    let busy = heldTurn(framework, membrane, 'b');
    await busy.streaming;
    try {
      assert.equal(framework.undoLastTurn('a').undone, true, "an undo on a's window while b streams");
      assert.equal(framework.getStore().currentBranch().name, 'main');
    } finally {
      await busy.release();
    }
    busy = heldTurn(framework, membrane, 'b');
    await busy.streaming;
    try {
      assert.equal(framework.redo('a').redone, true, 'a redo while b streams');
    } finally {
      await busy.release();
    }
    await works('a');
    await works('b');
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

  it("a write held during a switch's hold for an agent whose re-initialization fails waits in memory, as do the writes for it after, and the switch that recovers it stores each once, in its window, traced as it lands", async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    const held = 'for b, during the hold';
    const meanwhile = ['for b, while it refuses its work', 'for b, still before its recovery'];
    const written = [held, ...meanwhile];
    const added = addedTraces();
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const pass = gatedSwitch('a');
      await pass.reached;
      holdFor('b', held);
      pass.open();
      await pass.switched;
      // Between the failure and the recovery a write for b is answered as a
      // held write is, never refused at its writer.
      for (const words of meanwhile) {
        assert.equal(courier.addMessage('courier', text(words), undefined, { forAgent: 'b' }), '', `kept in memory, not refused: ${words}`);
      }
    } finally {
      console.error = quiet;
    }
    assert.deepEqual(reinitAlerts().map((alert) => alert.agentName), ['b']);
    for (const words of written) assert.ok(!textsOfCm('b').includes(words), `not stored before the recovery: ${words}`);
    assert.ok(!logged.some((line) => line.includes("couldn't be stored at its release")), logged.join('\n'));
    assert.equal(logged.filter((line) => line.includes('agent=b') && line.includes('waits in memory until switchBranch() re-initializes it')).length, 1,
      `the wait is logged once, as it begins: ${logged.join('\n')}`);
    assert.equal(framework.getHostModeStatus().deferredWrites, 3, 'the three writes wait in memory');
    assert.equal(added.length, 0, `none is traced before it is stored: ${JSON.stringify(added)}`);

    await framework.switchBranch(framework.getStore().currentBranch().name);
    await works('b');
    const rows = written.map((words) => cmOf('b').getAllMessages().filter((m) => m.content.some((block) => block.type === 'text' && block.text === words)));
    rows.forEach((found, i) => assert.equal(found.length, 1, `stored once: ${written[i]}`));
    const stored = rows.map((found) => found[0]!);
    assert.ok(stored.every((row, i) => i === 0 || row.sequence > stored[i - 1]!.sequence), 'stored in arrival order');
    for (const row of stored) assert.equal(cmOf('b').windowStatusOf(row.id), 'in', "in b's window");
    assert.deepEqual(added.map((t) => [t.source, t.messageId]), stored.map((row) => ['surgery-release', row.id]),
      `each traced once, as it lands, with its stored id: ${JSON.stringify(added)}`);
    assert.equal(framework.getHostModeStatus().deferredWrites, 0);
    const after = 'for b, after the recovery';
    assert.notEqual(courier.addMessage('courier', text(after), undefined, { forAgent: 'b' }), '', 'stored at once');
    assert.equal(textsOfCm('b').filter((t) => t === after).length, 1, 'stored once');
  });

  it("a write the fence refuses at its writer, for a manager that refuses its work, is kept in memory, neither thrown nor traced at its arrival, and stored, traced once with its id, when a switch recovers the agent", async () => {
    const surfaced: string[] = [];
    await framework.addModule({
      ...courierModule(() => {}),
      name: 'surface',
      async onProcess(event: { type: string }) {
        if (event.type !== 'external-message') return {};
        surfaced.push(JSON.stringify(event));
        return { addMessages: [{ participant: 'user', content: (event as unknown as { content: ContentBlock[] }).content }] };
      },
    } as Module);
    const strategy = cmOf('a').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    await framework.switchBranch(framework.getStore().currentBranch().name);
    assert.deepEqual(reinitAlerts().map((alert) => alert.agentName), ['a']);
    const added = addedTraces();
    const words = 'through the surface, for the primary that refuses its work';
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await dispatchProcessEvent({ type: 'external-message', source: 'test', content: text(words), metadata: {} });
    } finally {
      console.error = quiet;
    }
    assert.equal(surfaced.length, 1, 'the surface answered the event');
    assert.ok(!logged.some((line) => line.includes('requires successful strategy initialization') && !line.includes('waits in memory')),
      `not refused at its writer: ${logged.join('\n')}`);
    assert.ok(!textsOfCm('a').includes(words), 'not stored while a refuses its work');
    assert.equal(added.length, 0, `not traced at its arrival: ${JSON.stringify(added)}`);
    assert.equal(framework.getHostModeStatus().deferredWrites, 1);

    await framework.switchBranch(framework.getStore().currentBranch().name);
    await works('a');
    const rows = cmOf('a').getAllMessages().filter((m) => m.content.some((block) => block.type === 'text' && block.text === words));
    assert.equal(rows.length, 1, 'stored once');
    assert.deepEqual(added.map((t) => [t.source, t.messageId]), [['surgery-release', rows[0]!.id]], JSON.stringify(added));
  });

  it("a write a module makes during a move's hold is traced once, as the release stores it, with its stored id, not at its arrival", async () => {
    await framework.addModule({
      ...courierModule(() => {}),
      name: 'surface',
      async onProcess(event: { type: string }) {
        if (event.type !== 'external-message') return {};
        return { addMessages: [{ participant: 'user', content: (event as unknown as { content: ContentBlock[] }).content }] };
      },
    } as Module);
    const added = addedTraces();
    const words = 'through the surface, during the hold';
    const pass = gatedSwitch('a');
    await pass.reached;
    try {
      await dispatchProcessEvent({ type: 'external-message', source: 'test', content: text(words), metadata: {} });
      assert.equal(added.length, 0, `not traced at its arrival: ${JSON.stringify(added)}`);
    } finally {
      pass.open();
    }
    await pass.switched;
    const rows = cmOf('a').getAllMessages().filter((m) => m.content.some((block) => block.type === 'text' && block.text === words));
    assert.equal(rows.length, 1, 'stored once, at the release');
    assert.deepEqual(added.map((t) => [t.source, t.messageId]), [['surgery-release', rows[0]!.id]], JSON.stringify(added));
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
      await framework.switchBranch(framework.getStore().currentBranch().name);
    } finally {
      internals.agents.set('b', b);
    }
    assert.equal(initialized, true, "b's re-initialization ran");
    assert.deepEqual(reinitAlerts(), []);
  });

  it("the alert's remedy says a switch to the current branch re-initializes the agent and stores the writes kept in memory for it meanwhile; stop() names no queued write", async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const pass = gatedSwitch('a');
      await pass.reached;
      holdFor('b', 'for b, during the hold');
      holdFor('a', 'for a, during the hold');
      pass.open();
      await pass.switched;
      const alerts = reinitAlerts();
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['b']);
      const message = alerts[0]!.message;
      assert.ok(message.startsWith("The branch switch moved the store's branch"), message);
      says(message, 'refuses its work', 'switchBranch() to the current branch re-initializes it', 'stores the writes kept in memory for it meanwhile; a restart loses them');
      assert.match(message, /Its re-initialization failed: .*injected initialization failure\.$/, 'the cause comes last');
      assert.ok(textsOfCm('a').includes('for a, during the hold'), "a's write was stored at the release");
      await framework.stop();
    } finally {
      console.error = quiet;
    }
    assert.ok(!logged.some((line) => line.startsWith('[deferral] stop: ')), `no queued write to name: ${logged.join('\n')}`);
  });

  // main's two tests of what stop() says of a persisted queue's record
  // (current, behind) have no counterpart: no queue, persisted or not, holds
  // a write here (#291). The test above checks stop() names none.

  // AF-B-3: what stop() drops, it names. The writes kept for an agent whose
  // manager refuses its work go with the process: one line and one ops alert
  // for the agent, with the count and the kinds; the mail among them stays
  // held in the registry for the next boot.
  it("stop() names the writes kept in memory for an agent whose manager refuses its work, once for the agent, with an ops alert", async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    strategy.initialize = async () => { throw new Error('injected initialization failure'); };
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let mail: { mailId: string; delivered: boolean };
    try {
      const pass = gatedSwitch('a');
      await pass.reached;
      holdFor('b', 'for b, during the hold');
      pass.open();
      await pass.switched;
      assert.equal(courier.addMessage('courier', text('for b, while it refuses its work'), undefined, { forAgent: 'b' }), '');
      mail = framework.sendAgentMessage('a', 'b', text('mail for b'), { wake: false });
      assert.equal(mail.delivered, true, 'answered as a held write is');
      assert.equal(framework.getHostModeStatus().deferredWrites, 3, 'setup: three writes wait in memory for b');
      await framework.stop();
    } finally {
      console.error = quiet;
    }
    const lines = logged.filter((line) => line.startsWith('[stop] '));
    assert.equal(lines.length, 1, `one line, for b: ${lines.join('\n')}`);
    says(lines[0]!, '[stop] agent=b: 3 writes for b kept in memory are not stored by this stop',
      '3 kept while its context manager refuses its work, which are lost', 'Kinds: 2 message, 1 agent-message.',
      'The mail among them (1) stays held in the registry, and the next boot delivers it.');
    const lost = traces.filter((t): t is Extract<TraceEvent, { type: 'ops:alert' }> => t.type === 'ops:alert' && t.kind === 'store-held-lost');
    assert.deepEqual(lost.map((alert) => [alert.agentName, alert.data]), [
      ['b', { count: 3, keptForRecovery: 3, heldBySurgery: 0, kinds: { message: 2, 'agent-message': 1 }, mail: 1 }],
    ]);
    assert.ok(framework.listHeldMail().some((held) => held.id === mail.mailId), 'the mail stays held for the next boot');
  });

  it("stop() names the writes a surgery's hold still keeps when the surgery outlives its wait", async () => {
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const pass = gatedSwitch('a');
    try {
      await pass.reached;
      holdFor('b', 'for b, during the hold');
      holdFor('b', 'for b, also during the hold');
      await assert.rejects(framework.stop(50), 'the wait for the switch runs out');
    } finally {
      console.error = quiet;
      pass.open();
      await pass.switched.catch(() => {});
    }
    const lines = logged.filter((line) => line.startsWith('[stop] '));
    assert.equal(lines.length, 1, `one line, for b: ${lines.join('\n')}`);
    says(lines[0]!, '[stop] agent=b: 2 writes for b kept in memory are not stored by this stop',
      "2 a branch switch's hold still keeps, its operation having outlived stop()'s wait, which are stored only if it releases before the process exits",
      'Kinds: 2 message.');
    const lost = traces.filter((t): t is Extract<TraceEvent, { type: 'ops:alert' }> => t.type === 'ops:alert' && t.kind === 'store-held-lost');
    assert.deepEqual(lost.map((alert) => [alert.agentName, alert.data]), [
      ['b', { count: 2, keptForRecovery: 0, heldBySurgery: 2, kinds: { message: 2 }, mail: 0 }],
    ]);
  });

  it('an undo or redo makes no branch and moves none: a store whose createBranchAt and switchBranch throw stops neither', async () => {
    await checkpointTurn();
    const store = framework.getStore() as unknown as { createBranchAt: (...args: unknown[]) => unknown; switchBranch: (name: string) => void };
    const createBranchAt = store.createBranchAt;
    const switchBranch = store.switchBranch;
    store.createBranchAt = () => { throw new Error('injected branch failure'); };
    store.switchBranch = () => { throw new Error('injected switch failure'); };
    try {
      assert.equal(framework.undoLastTurn('a').undone, true);
      assert.equal(framework.redo('a').redone, true);
    } finally {
      store.createBranchAt = createBranchAt;
      store.switchBranch = switchBranch;
    }
    assert.equal(framework.getStore().currentBranch().name, 'main');
    assert.equal(framework.getUndoRedoState('a').undoDepth, 1, "the redo put the turn's checkpoint back");
  });

  for (const move of ['branch switch', 'suppression'] as const) {
    it(`a re-initialization that fails after a ${move} raises its alert, naming the move`, async () => {
      const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
      const initialize = strategy.initialize.bind(strategy);
      let failNext = true;
      strategy.initialize = async (...args: unknown[]) => {
        if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
        return initialize(...args);
      };
      if (move === 'branch switch') {
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

  it('an undo and a redo re-initialize no manager: a strategy whose initialize would fail is never called, and nothing is said', async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    let calls = 0;
    strategy.initialize = async () => { calls++; throw new Error('injected initialization failure'); };
    await checkpointTurn();
    assert.equal(framework.undoLastTurn('a').undone, true);
    assert.equal(framework.redo('a').redone, true);
    assert.equal(framework.undoLastTurn('a').undone, true);
    assert.equal(calls, 0, "b's strategy wasn't initialized again");
    assert.deepEqual(reinitAlerts(), []);
    await works('b');
  });

  it("a hold's alert, raised during the pass, names the move, its agent, the manager the pass is on and the writes the hold keeps", async () => {
    shortenHoldAlert(2_000);
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let atGate = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    strategy.initialize = async (...args: unknown[]) => {
      if (!atGate) {
        atGate = true;
        await gate;
      }
      return initialize(...args);
    };
    const switched = framework.switchBranch(framework.getStore().currentBranch().name);
    try {
      await until(() => atGate, "b's re-initialization to reach its gate", 10_000);
      holdFor('a', 'for a, during the hold');
      await until(() => longHoldAlerts().length > 0, 'the store-held-long alert', 10_000);
      const [alert] = longHoldAlerts();
      assert.equal(alert!.agentName, 'every agent');
      assert.ok(alert!.message.startsWith('The branch switch has held the store for '), alert!.message);
      says(alert!.message, 'no turn starts', 'wait in memory (1 write now)', 'The branch switch is for every agent', "re-initializing b's context manager now",
        'the writes the hold keeps are lost');
      const data = alert!.data as { verb?: string; reinitializing?: string; queued?: number; heldMs?: number; waitingForMaintenance?: boolean };
      assert.equal(data.verb, 'switch branch');
      assert.equal(data.reinitializing, 'b');
      assert.equal(data.waitingForMaintenance, undefined);
      assert.equal(data.queued, 1);
    } finally {
      release();
    }
    await switched;
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

  it('a held write that throws at the release is logged, and the release still lets the store go', async () => {
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const cm = cmOf('b') as unknown as { addMessage: (...args: unknown[]) => unknown };
    const addMessage = cm.addMessage;
    try {
      const pass = gatedSwitch('a');
      await pass.reached;
      holdFor('b', 'for b, during the hold');
      cm.addMessage = () => { throw new Error('injected release write failure'); };
      pass.open();
      await pass.switched;
    } finally {
      cm.addMessage = addMessage;
      console.error = quiet;
    }
    assert.ok(logged.some((line) => line.includes("couldn't be stored at its release") && line.includes('injected release write failure')),
      logged.join('\n'));
    await framework.switchBranch(framework.getStore().currentBranch().name);
  });

  it('a hold let go before its threshold says nothing after it', async () => {
    shortenHoldAlert(1_000);
    await framework.switchBranch(framework.getStore().currentBranch().name);
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
    says(alerts[0]!.message, "couldn't be put back", 'refuses its work', 'stores the writes kept in memory for it meanwhile; a restart loses them');
  });

  it("stop() waits for a branch switch's re-initialization before the store closes", async () => {
    const switching = framework.switchBranch(framework.getStore().currentBranch().name);
    let reinitEnded = false;
    void switching.then(() => { reinitEnded = true; });
    await framework.stop();
    assert.equal(reinitEnded, true, 'the re-initialization finished before stop() returned');
  });

  it('a turn asked for while the managers re-initialize starts once the store is let go', async () => {
    const switching = framework.switchBranch(framework.getStore().currentBranch().name);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'b answers after the switch' }]));
    framework.nudgeAgent('b', 'test');
    const calls = membrane.calls.length;
    const run = framework.runUntilIdle();
    assert.equal(membrane.calls.length, calls, 'no turn starts while the managers re-initialize');
    await switching;
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

  it('undo refuses as busy when the named agent is busy, and a redo goes through while another agent is', async () => {
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
    assert.equal(framework.undoLastTurn('a').undone, true);
    const idle = busy('b');
    try {
      assert.equal(framework.redo('a').redone, true, "a redo on a's window while b is inferring");
    } finally {
      idle();
    }
  });

  it("a branch switch's managers re-initialize one at a time, with a turn of the event loop between them", async () => {
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
      const switching = framework.switchBranch(framework.getStore().currentBranch().name);
      assert.deepEqual(calls, [], 'no manager re-initializes inside switchBranch() before it yields');
      const before = await new Promise<number>((resolve) => { setImmediate(() => resolve(calls.length)); });
      assert.ok(before < 2, `the event loop ran while the managers re-initialized (${before} of 2 had when it did)`);
      await switching;
    } finally {
      counting = false;
    }
    assert.deepEqual(calls.sort(), ['a', 'b']);
    assert.ok(turnsAtEntry[1]! > turnsAtEntry[0]!,
      `the event loop turned between the two managers' re-initializations (turns at each entry: ${turnsAtEntry.join(', ')})`);
    await works('a');
    await works('b');
  });

  it("a branch switch waits for an over-budget drain kick already running before any manager re-initializes", async () => {
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
      const switching = framework.switchBranch(framework.getStore().currentBranch().name);
      await settled();
      assert.ok(waited(), 'the switch is waiting on the kick');
      assert.deepEqual(calls, [], 'no manager re-initializes while the kick runs');
      settle();
      drains.delete(kick);
      await switching;
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
    says(alert, 'refuses its work', 'switchBranch() to the current branch re-initializes it', 'stores the writes kept in memory for it meanwhile; a restart loses them', 'The store is on main.');
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
    says(alert, 'refuses its work', 'switchBranch() to the branch it should run on re-initializes it', 'stores the writes kept in memory for it meanwhile; a restart loses them');
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
    says(alert, 'refuses its work', 'switchBranch() to the current branch re-initializes it', 'stores the writes kept in memory for it meanwhile; a restart loses them');
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
    says(kept, 'switchBranch() to the branch it should run on re-initializes it', 'stores the writes kept in memory for it meanwhile; a restart loses them');
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

  // main's two tests of a redo whose branch is gone, or whose switch fails,
  // have no counterpart: a redo on the window has no branch to return to.
  // What a branch move does to a redo is that the move drops every redo step
  // (followBranchMove), which the last describe checks.



  it("a runtime-settings change while a branch switch's managers re-initialize is refused, and nothing is applied", async () => {
    const before = framework.getAgentRuntimeSettings('b');
    const pass = gatedSwitch('a');
    await pass.reached;
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    try {
      assert.throws(
        () => framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
      );
    } finally {
      pass.open();
    }
    await pass.switched;
    assert.equal(framework.getAgentRuntimeSettings('b').sameRoundThinkTextPolicy, before.sameRoundThinkTextPolicy);
    assert.equal(framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next }).sameRoundThinkTextPolicy, next);
  });

  it("a runtime-settings reset or cancelled transition while a branch switch's managers re-initialize is refused, and nothing is applied", async () => {
    const before = framework.getAgentRuntimeSettings('b');
    const next = before.sameRoundThinkTextPolicy === 'private' ? 'public' : 'private';
    framework.updateAgentRuntimeSettings('b', { sameRoundThinkTextPolicy: next });
    const pass = gatedSwitch('a');
    await pass.reached;
    try {
      assert.throws(
        () => framework.resetAgentRuntimeSettings('b'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
      );
      assert.throws(
        () => framework.cancelAgentRuntimeSettingsTransition('b'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /nothing was changed/.test(e.message),
      );
    } finally {
      pass.open();
    }
    await pass.switched;
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

  it("a rollback asked for from a listener of a switch's re-initialization alert is refused as busy: the alert comes while the switch holds the store", async () => {
    const strategy = cmOf('b').getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize.bind(strategy);
    let failNext = true;
    strategy.initialize = async (...args: unknown[]) => {
      if (failNext) { failNext = false; throw new Error('injected initialization failure'); }
      return initialize(...args);
    };
    let rolled: Promise<unknown> | undefined;
    framework.onTrace((event) => {
      if (event.type === 'ops:alert' && event.kind === 'context-reinit-failed' && !rolled) {
        rolled = framework.rollbackToMessage('a', { messageId: firstId });
        rolled.catch(() => {});
      }
    });
    await framework.switchBranch(framework.getStore().currentBranch().name);
    assert.ok(rolled, 'the listener heard the alert');
    await assert.rejects(rolled, (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /live switch branch/.test(e.message));
    assert.equal(framework.getStore().currentBranch().name, 'main', 'the store stays where the switch left it');
    await works('a');
  });
});

describe('conversation forks and a branch move', () => {
  type ForkInternals = Internals & {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ getContextManager(): ContextManager }>;
  };

  it("a fork created while a branch switch's managers re-initialize waits for them, and compiles", { timeout: 30_000 }, async () => {
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
      await realTurn(framework, membrane, 'a', 'a turn of its own');
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
      const switching = framework.switchBranch(framework.getStore().currentBranch().name);
      const spawning = internals.createConversationAgent('a-chan-g1', { serverId: 'world', channelId: 'world:chan' });
      await until(() => atGate, "the template's re-initialization to reach its gate", 10_000);
      await settled();
      assert.equal(order.length, 0, `the spawn waits, and nothing has compiled the template: ${JSON.stringify(order)}`);
      open();
      await switching;
      const fork = await spawning;
      (cmA as unknown as { compile: typeof compile }).compile = compile;
      const reinitialized = order.indexOf('template re-initialized');
      assert.ok(reinitialized >= 0 && order.indexOf('template compiled', reinitialized) > reinitialized,
        `the seed read the template after its re-initialization: ${JSON.stringify(order)}`);
      const { messages } = await fork.getContextManager().compile({ maxTokens: 100_000, reserveForResponse: 1_000 }, undefined, { dryRun: true });
      const texts = messages.flatMap((m) => m.content)
        .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
        .map((b) => b.text);
      assert.equal(texts.filter((t) => t === 'hello a').length, 1, `seeded once from the landed branch: ${JSON.stringify(texts)}`);
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
    assert.equal(harness(framework).courier!.addMessage('courier', [{ type: 'text', text: words }], undefined, { forAgent: name }), '',
      'held by the hold, not stored');
  };
  /** A branch at a's turn of forksAroundACheckpoint (its reply the branch's
   *  last row), made and not yet switched to: the store move main's undo of
   *  that turn made, which leaves a fork spawned after the turn with nothing
   *  of its own. A switch to it is the move these tests make here (#291: an
   *  undo is on the window and moves no branch). */
  const branchAtTheTurn = (framework: AgentFramework): string => {
    const store = framework.getStore();
    const cmA = framework.getAgent('a')!.getContextManager();
    const turn = cmA.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
    const name = `at-the-turn-${store.listBranches().length}`;
    store.createBranchAt(name, store.currentBranch().name, turn.sequence);
    return name;
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

  it("a branch switch to before a fork was spawned disposes it, unbinds its channel and says so, and the channel's next mention spawns a fresh fork; a fork spawned before that point stays", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts = reinitAlertsOf(framework);
      await framework.switchBranch(branchAtTheTurn(framework));
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      const message = alerts[0]!.message;
      assert.ok(message.startsWith('The branch switch left this conversation agent with no messages of its own'), message);
      says(message, 'it was disposed and its channel unbound', "Its channel's next qualifying message spawns a new fork",
        "which needs the template's own context manager to be working", "a switch to a branch that holds them doesn't bring this one back");
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

  for (const move of ['branch switch', 'rollback'] as const) {
    it(`a ${move} that leaves a fork with no stored message of its own disposes it and unbinds its channel`, { timeout: 30_000 }, async () => {
      await withForks(`reinit-fork-dispose-${move.replace(' ', '-')}-`, async (framework, internals) => {
        await forksAroundACheckpoint(framework, internals);
        const store = framework.getStore();
        const cmA = framework.getAgent('a')!.getContextManager();
        const alerts = reinitAlertsOf(framework);
        const emptied = 'a-late-g1';
        const channelId = 'world:late';
        if (move === 'branch switch') {
          const turn = cmA.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
          store.createBranchAt('before-late', store.currentBranch().name, turn.sequence);
          await framework.switchBranch('before-late');
        } else {
          cmA.addMessage('user', [{ type: 'text', text: 'after the turn' }]);
          const turn = cmA.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'a turn to undo'))!;
          await framework.rollbackToMessage('a', { messageId: turn.id });
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

  // main's redo variant of the test above has none here: a redo is on the
  // window and moves no branch, so a fork made between an undo and its redo
  // keeps its history, as the next test but one checks.
  it("a clock-keeping fork the move emptied is disposed, though a channel message and a correction arrived for it, re-initialized, while the store was held", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-clock-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      await forkInternals.createConversationAgent('a-tail-g1', { serverId: 'world', channelId: 'world:tail' });
      const alerts = reinitAlertsOf(framework);
      const pass = gateReinit(framework, 'a-tail-g1');
      const moving = framework.switchBranch(branchAtTheTurn(framework));
      try {
        await pass.reached;
        for (const event of [
          channelMessage('world:late', 'A MESSAGE WHILE HELD'),
          channelMessage('world:late', 'A CORRECTION WHILE HELD', { deliverTo: 'a-late-g1' }),
        ]) {
          const placement = await internals.handleMcplChannelIncoming(event);
          assert.equal(placement?.agent, 'a-late-g1', `placed for the fork: ${JSON.stringify(placement)}`);
          assert.ok(!placement?.messageId, `held by the hold, with no id yet: ${JSON.stringify(placement)}`);
        }
      } finally {
        pass.open();
      }
      await moving;
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
      const moving = framework.switchBranch(branchAtTheTurn(framework));
      holdFor(framework, 'a-late-g1', 'FOR THE LATE FORK');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        moving.then(() => 'settled'),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 10_000); }),
      ]);
      clearTimeout(timer);
      assert.equal(outcome, 'settled', 'the pass and the release finish');
      assert.ok(!logged.some((line) => line.includes('following a branch move failed')), logged.join('\n'));
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      const message = alerts[0]!.message;
      says(message, 'it was disposed and its channel unbound');
      // A module's write for a fork goes to the primary in its place.
      assert.match(message, /(^| )1 write held for it went to the primary\./);
      assert.match(message, / Its re-initialization had failed: .*injected fork init failure\.$/, 'its failed re-initialization comes last');
      assert.doesNotMatch(message, /refuses its work/);
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
      assert.equal(count(storedTexts(framework.getAgent('a')!.getContextManager()), 'FOR THE LATE FORK'), 1, 'the primary has it, once');
    });
  });

  it("a fork a move emptied while writes were held for it: the module's write goes to the primary, its channel messages are dropped, and the alert counts them", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-dispose-held-', async (framework, forkInternals, logged) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const alerts = reinitAlertsOf(framework);
      const added: Array<{ messageId: string; source: string }> = [];
      framework.onTrace((event) => {
        if (event.type === 'message:added') added.push({ messageId: event.messageId, source: event.source });
      });
      const pass = gateReinit(framework, 'a');
      const moving = framework.switchBranch(branchAtTheTurn(framework));
      await pass.reached;
      for (const words of ['FIRST DURING THE MOVE', 'SECOND DURING THE MOVE']) {
        const placement = await internals.handleMcplChannelIncoming(channelMessage('world:late', words));
        assert.ok(placement?.agent === 'a-late-g1' && !placement.messageId, `held by the hold, not stored: ${JSON.stringify(placement)}`);
      }
      holdFor(framework, 'a-late-g1', 'A MODULE WRITE DURING THE MOVE');
      pass.open();
      await moving;
      assert.ok(!framework.getAgent('a-late-g1'), 'disposed');
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], JSON.stringify(alerts));
      assert.match(alerts[0]!.message, /(^| )Of 3 writes held for it, 1 went to the primary and 2 were dropped\./);
      const primary = framework.getAgent('a')!.getContextManager();
      const texts = storedTexts(primary);
      assert.equal(count(texts, 'A MODULE WRITE DURING THE MOVE'), 1, `the primary has the module's write, once: ${JSON.stringify(texts)}`);
      for (const words of ['FIRST DURING THE MOVE', 'SECOND DURING THE MOVE']) assert.equal(count(texts, words), 0, `not the channel message: ${words}`);
      const row = primary.getAllMessages().find((m) => m.content.some((b) => matches((b as { text?: string }).text ?? '', 'A MODULE WRITE DURING THE MOVE')))!;
      assert.deepEqual(added.filter((t) => t.messageId === row.id).map((t) => t.source), ['surgery-release'], JSON.stringify(added));
      assert.ok(!logged.some((line) => line.includes('is not a registered agent')), `nothing replayed for the disposed fork: ${logged.join('\n')}`);
      assert.ok(logged.some((line) => line.includes('2 write(s) kept in memory for a-late-g1, which has ended, are dropped')), logged.join('\n'));
    });
  });

  for (const failsAgain of [false, true]) {
    it(`writes kept for a fork whose manager refuses its work, which a later move empties, go to the primary when the move disposes it${failsAgain ? ', its re-initialization failing again' : ''}`, { timeout: 30_000 }, async () => {
      await withForks('reinit-fork-dispose-kept-', async (framework, forkInternals) => {
        await forksAroundACheckpoint(framework, forkInternals);
        const internals = forkInternals as unknown as HoldInternals;
        const alerts = reinitAlertsOf(framework);
        const late = framework.getAgent('a-late-g1')!.getContextManager().getStrategy() as unknown as { initialize: (...args: unknown[]) => Promise<void> };
        const initialize = late.initialize.bind(late);
        let failures = failsAgain ? 2 : 1;
        late.initialize = async (...args: unknown[]) => {
          if (failures > 0) { failures--; throw new Error('injected fork init failure'); }
          return initialize(...args);
        };
        await framework.switchBranch(framework.getStore().currentBranch().name);
        assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-late-g1'], 'its manager refuses its work, and it is kept: it has its own message');
        holdFor(framework, 'a-late-g1', 'KEPT FOR THE LATE FORK');
        const placement = await internals.handleMcplChannelIncoming(channelMessage('world:late', 'A MESSAGE WHILE IT REFUSES'));
        assert.ok(placement?.agent === 'a-late-g1' && !placement.messageId, `kept, not stored: ${JSON.stringify(placement)}`);
        assert.equal(framework.getHostModeStatus().deferredWrites, 2);
        await framework.switchBranch(branchAtTheTurn(framework));
        assert.ok(!framework.getAgent('a-late-g1'), 'the move emptied it, and it is disposed');
        assert.equal(alerts.length, 2, JSON.stringify(alerts));
        assert.match(alerts[1]!.message, /(^| )Of 2 writes held for it, 1 went to the primary and 1 was dropped\./);
        const texts = storedTexts(framework.getAgent('a')!.getContextManager());
        assert.equal(count(texts, 'KEPT FOR THE LATE FORK'), 1, `the primary has the module's write, once: ${JSON.stringify(texts)}`);
        assert.equal(count(texts, 'A MESSAGE WHILE IT REFUSES'), 0, 'not the channel message');
        assert.equal(framework.getHostModeStatus().deferredWrites, 0);
      });
    });
  }

  it("writes kept for a fork whose manager refuses its work go to the primary, the ones it takes in the fork's place, when the fork ends", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-end-kept-', async (framework, forkInternals, logged) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const alerts = reinitAlertsOf(framework);
      const early = framework.getAgent('a-early-g1')!.getContextManager().getStrategy() as unknown as { initialize: () => Promise<void> };
      early.initialize = async () => { throw new Error('injected fork init failure'); };
      await framework.switchBranch(framework.getStore().currentBranch().name);
      assert.deepEqual(alerts.map((alert) => alert.agentName), ['a-early-g1']);
      holdFor(framework, 'a-early-g1', 'KEPT FOR THE EARLY FORK');
      const placement = await internals.handleMcplChannelIncoming(channelMessage('world:early', 'A MESSAGE WHILE IT REFUSES'));
      assert.ok(placement?.agent === 'a-early-g1' && !placement.messageId, `kept, not stored: ${JSON.stringify(placement)}`);
      assert.equal(framework.getHostModeStatus().deferredWrites, 2);
      framework.stopAgent('a-early-g1');
      assert.ok(!framework.getAgent('a-early-g1'), 'ended');
      const texts = storedTexts(framework.getAgent('a')!.getContextManager());
      assert.equal(count(texts, 'KEPT FOR THE EARLY FORK'), 1, `the primary has the module's write, once: ${JSON.stringify(texts)}`);
      assert.equal(count(texts, 'A MESSAGE WHILE IT REFUSES'), 0, 'not the channel message');
      assert.ok(logged.some((line) => line.includes('1 write(s) kept in memory for a-early-g1, which has ended, is dropped')), logged.join('\n'));
      assert.equal(framework.getHostModeStatus().deferredWrites, 0);
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
      released.releaseWindow = (agent: { name: string }) => {
        if (agent.name === 'a-late-g1') throw new Error('injected release failure');
        return releaseWindow.call(framework, agent);
      };
      try {
        const moving = framework.switchBranch(branchAtTheTurn(framework));
        holdFor(framework, 'a-late-g1', 'for a-late-g1, during the hold');
        await moving;
      } finally {
        released.releaseWindow = releaseWindow;
      }
      const byAgent = new Map(alerts.map((alert) => [alert.agentName, alert.message]));
      assert.deepEqual([...byAgent.keys()].sort(), ['a-late-g1', 'a-later-g1'], JSON.stringify(alerts));
      const late = byAgent.get('a-late-g1')!;
      says(late, 'its cleanup failed (below)');
      assert.match(late, /(^| )1 write held for it went to the primary\./);
      assert.match(late, / Its cleanup failed: .*injected release failure\.$/, 'the failure comes last');
      says(byAgent.get('a-later-g1')!, 'it was disposed and its channel unbound');
      for (const [name, channelId] of [['a-late-g1', 'world:late'], ['a-later-g1', 'world:later']] as const) {
        assert.ok(!framework.getAgent(name), `${name} is unregistered`);
        assert.equal(router.getBinding({ serverId: 'world', channelId }), undefined, `${name}'s channel is unbound`);
      }
      assert.ok(framework.getAgent('a-early-g1'), 'the fork spawned before the point stays');
    });
  });

  it("an undo and a redo of the turn before a fork was spawned leave the fork bound with its history, and say nothing: neither moves the store", { timeout: 30_000 }, async () => {
    await withForks('reinit-fork-undo-redo-', async (framework, internals) => {
      await forksAroundACheckpoint(framework, internals);
      const alerts = reinitAlertsOf(framework);
      const undo = framework.undoLastTurn('a');
      assert.equal(undo.undone, true);
      assert.equal(undo.toBranch, undo.fromBranch, 'no branch moves');
      assert.ok(framework.getAgent('a-late-g1'), 'the fork stays after the undo');
      const redo = framework.redo('a');
      assert.equal(redo.redone, true);
      await settled();
      assert.deepEqual(alerts, [], 'nothing reported');
      assert.ok(framework.getAgent('a-late-g1'), 'not disposed');
      assert.equal(framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:late' })?.agentName, 'a-late-g1');
      // Its history is in its store (written past the framework, it enters the
      // fork's window at the fork's next point, #291).
      const late = storedTexts(framework.getAgent('a-late-g1')!.getContextManager());
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
        await framework.switchBranch(branchAtTheTurn(framework));
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
        // An undo is on a's window and moves no branch, so a spawn under way
        // doesn't refuse it; a move of the store is refused.
        assert.equal(framework.undoLastTurn('a').undone, true);
        await assert.rejects(
          framework.switchBranch('main'),
          (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /a-chan-g1 is being created/.test(e.message),
        );
      } finally {
        release();
        (cmA as unknown as { compile: typeof compile }).compile = compile;
      }
      await spawning;
      await framework.switchBranch('main');
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
      await framework.switchBranch('main');
    });
  });

  type Placement = { agent: string; messageId?: string };
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
    let moved: Promise<unknown> | undefined;
    let done = false;
    try {
      moved = move();
      void moved.then(() => { done = true; }, () => { done = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(done, false, 'the move waits on the running maintenance tick');
      await during();
    } finally {
      gated.release?.();
    }
    await moved;
  };

  it("while a move holds the store, a kept fork's channel message and a correction for it are held, and land after the release, traced with their ids as they land", { timeout: 30_000 }, async () => {
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
      const moving = framework.switchBranch(framework.getStore().currentBranch().name);
      await pass.reached;
      placements.push(await internals.handleMcplChannelIncoming(channelMessage('world:early', 'MESSAGE DURING THE MOVE')));
      placements.push(await internals.handleMcplChannelIncoming(channelMessage('world:early', 'CORRECTION DURING THE MOVE', { deliverTo: 'a-early-g1' })));
      for (const placement of placements) {
        assert.ok(placement?.agent === 'a-early-g1' && !placement.messageId, `held by the hold, not stored: ${JSON.stringify(placement)}`);
      }
      assert.ok(!storedTexts(early).some((text) => text.includes('DURING THE MOVE')), 'nothing written into the fork during the hold');
      pass.open();
      await moving;
      const texts = await textsOf(framework, 'a-early-g1');
      const own = texts.findIndex((t) => matches(t, 'early own'));
      const message = texts.findIndex((t) => matches(t, 'MESSAGE DURING THE MOVE'));
      const correction = texts.findIndex((t) => matches(t, 'CORRECTION DURING THE MOVE'));
      assert.ok(own >= 0 && message > own && correction > message, `its own history, then the two writes: ${JSON.stringify(texts)}`);
      assert.equal(count(texts, 'MESSAGE DURING THE MOVE') + count(texts, 'CORRECTION DURING THE MOVE'), 2, JSON.stringify(texts));
      // A write the hold keeps has no id at its arrival, so it is traced once,
      // as it lands (main traced it at the deferral too, with no id).
      assert.deepEqual(added.filter((t) => t.source === 'mcpl:channel-incoming').map((t) => t.messageId), [],
        `not traced at the hold: ${JSON.stringify(added)}`);
      const storedId = (words: string) => early.getAllMessages()
        .find((m) => m.content.some((b) => typeof (b as { text?: string }).text === 'string' && matches((b as { text: string }).text, words)))?.id;
      assert.deepEqual(added.filter((t) => t.source === 'surgery-release').map((t) => t.messageId),
        [storedId('MESSAGE DURING THE MOVE'), storedId('CORRECTION DURING THE MOVE')], `traced as each lands, with its stored id: ${JSON.stringify(added)}`);
    });
  });

  it("while a move holds the store, a kept fork's idle-TTL closure waits for the release, and its prompt lands after it", { timeout: 30_000 }, async () => {
    // The sweep waits for a hold's release here (it writes the closure prompt
    // as the fork's own row), where main's wrote the prompt through the hold.
    await withForks('reinit-fork-hold-closure-', async (framework, forkInternals) => {
      await forksAroundACheckpoint(framework, forkInternals);
      const internals = forkInternals as unknown as HoldInternals;
      const early = framework.getAgent('a-early-g1')!.getContextManager();
      const prompt = framework.getConversationRouter()!.closurePrompt;
      const pass = gateReinit(framework, 'a');
      const moving = framework.switchBranch(framework.getStore().currentBranch().name);
      await pass.reached;
      framework.getConversationRouter()!.getBinding({ serverId: 'world', channelId: 'world:early' })!.lastActivity = 0;
      internals.lastConversationSweep = 0;
      internals.sweepExpiredConversations();
      assert.equal(count(storedTexts(early), prompt), 0, 'the closure prompt is not written into the fork during the hold');
      pass.open();
      await moving;
      internals.lastConversationSweep = 0;
      internals.sweepExpiredConversations();
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
      const moving = framework.switchBranch(framework.getStore().currentBranch().name);
      void moving.catch(() => {});
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
      // Written past the framework, the row enters a's window at a's next
      // point (#291); the seed below reads the template's window.
      (framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(framework.getAgent('a'));
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
        await framework.switchBranch(branchAtTheTurn(framework));
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

  it("while a rollback waits for running maintenance, a fork's channel message is held, and lands on the branch the rollback moves to", { timeout: 30_000 }, async () => {
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
        assert.ok(placement?.agent === 'a-early-g1' && !placement.messageId, `held by the hold, not stored: ${JSON.stringify(placement)}`);
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

// Read onto #291: an undo or redo moves no branch and holds nothing, so the
// moves here are branch switches, the store's own moves, each of which holds
// the store as main's undo did.
describe('a branch switch while a maintenance call waits at the provider gate', () => {
  for (const variant of ['a switch', 'a switch, then another'] as const) {
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
        saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
      };
      const gate = () => internals.providerGate('agent');
      const cm = framework.getAgent('agent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'm1' }]);
      const sequenceBefore = framework.getStore().currentSequence();
      cm.addMessage('user', [{ type: 'text', text: 'a turn to undo' }]);
      internals.saveTurnCheckpoints('agent', [{ agentName: 'agent', turnIndex: 1, sequenceBefore, branchName: 'main', timestamp: Date.now() }]);
      const parkThen = async (label: string, move: () => Promise<void>): Promise<void> => {
        gate().primaryPending = false;
        strategy.armed = true;
        await waitParked();
        await move();
        assert.equal(gate().auxiliaryWaiters.length, 0, `${label}: the parked call was withdrawn`);
      };
      const waitParked = async () => {
        while (gate().auxiliaryWaiters.length !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
      };
      const quiet = console.error;
      console.error = () => {};
      try {
        await framework.quiesce();
        framework.start();
        const store = framework.getStore();
        await parkThen('the switch', () => framework.switchBranch(store.currentBranch().name));
        if (variant === 'a switch, then another') await parkThen('the second switch', () => framework.switchBranch(store.currentBranch().name));
        assert.deepEqual(strategy.outcomes, variant === 'a switch' ? ['MaintenanceWithdrawnError'] : ['MaintenanceWithdrawnError', 'MaintenanceWithdrawnError']);
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
  // Read onto #291: an undo moves no branch, so a tick that runs across it
  // meets no refusal for a moved branch, and nothing re-initializes its
  // manager. main's three variants for a tick that meets such a refusal (and
  // raises no alert) have no counterpart; a tick that fails for a reason of
  // its own still raises its alert.
  for (const variant of variants.filter((v) => 'failure' in v)) {
    it(`keeps maintenance-failure alert when ${variant.where}, an undo made while the tick ran`, { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'reinit-tick-'));
      const gated = new GatedTickStrategy();
      gated.throwOnStale = false;
      if ('readinessOnly' in variant) gated.readinessFailure = variant.failure;
      else gated.failure = new Error(variant.failure);
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
      console.error = () => {};
      try {
        await realTurn(framework, membrane, 'a', 'a turn to undo');
        framework.start();
        gated.armed = true;
        await until(() => gated.entered, "b's tick to start", 8_000);
        const undo = framework.undoLastTurn('a');
        assert.equal(undo.undone, true);
        assert.equal(undo.settled, undefined, 'nothing is held');
        // The readiness variant's failure is read after the tick.
        if ('readinessOnly' in variant) gated.stale = true;
        gated.release!();
        await until(() => alerts.some((alert) => alert.kind === 'context-maintenance-failed'), "b's maintenance-failure alert", 8_000);
        const failed = alerts.filter((alert) => alert.kind === 'context-maintenance-failed');
        assert.deepEqual(failed.map((alert) => alert.agentName), ['b'], JSON.stringify(alerts));
        says(failed[0]!.message, variant.failure);
        assert.ok(!alerts.some((alert) => alert.kind === 'context-reinit-failed'), 'no manager was re-initialized');
      } finally {
        console.error = quiet;
        gated.stale = false;
        gated.release?.();
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('an undo made while a tick runs moves no branch under it: the tick finishes, nothing is alerted, and no manager is re-initialized', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reinit-tick-'));
    const gated = new GatedTickStrategy();
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
    const alerts: Array<{ kind: string }> = [];
    framework.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string }); });
    framework.getAgent('a')!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello a' }]);
    try {
      await realTurn(framework, membrane, 'a', 'a turn to undo');
      framework.start();
      gated.armed = true;
      await until(() => gated.entered, "b's tick to start", 8_000);
      const store = framework.getStore();
      const head = store.currentBranch().name;
      assert.equal(framework.undoLastTurn('a').undone, true, "the undo doesn't wait for the tick");
      assert.equal(store.currentBranch().name, head, 'no branch moved under the tick');
      gated.release!();
      await until(() => framework.getAgent('b')!.getContextManager().isReady(), "b's tick to finish", 8_000);
      assert.deepEqual(alerts, [], JSON.stringify(alerts));
    } finally {
      gated.release?.();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

  // Read onto #291: an undo moves no branch, so it neither waits for the tick
  // nor re-initializes a manager (a branch switch waits for it: next test).
  it("an undo doesn't wait for a running tick, and re-initializes no manager", { timeout: 30_000 }, async () => {
    await withRunningTick('reinit-tick-undo-', async (framework, gated) => {
      const calls: string[] = [];
      for (const name of ['a', 'b', 'm']) {
        const cm = framework.getAgent(name)!.getContextManager() as unknown as { setStrategy: (s: unknown) => Promise<void> };
        const setStrategy = cm.setStrategy.bind(cm);
        cm.setStrategy = (strategy: unknown) => { calls.push(name); return setStrategy(strategy); };
      }
      const undone = framework.undoLastTurn('a');
      assert.equal(undone.undone, true, 'the undo is done while the tick runs');
      assert.equal(undone.settled, undefined);
      gated.release!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(calls, [], 'no manager re-initialized');
    });
  });

  it("a branch switch waits for the tick before it moves the store", { timeout: 30_000 }, async () => {
    await withRunningTick('reinit-tick-switch-', async (framework, gated) => {
      const store = framework.getStore();
      store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
      const switching = framework.switchBranch('side');
      let done = false;
      void switching.then(() => { done = true; }, () => { done = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
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
    // #291: no queue keeps a write. A refusing manager's writes wait in
    // memory until a switch re-initializes it and stores them, and a hold
    // keeps its writes in memory until its release.
    const remedy = 're-initializes it and stores the writes kept in memory for it meanwhile; a restart loses them.';
    for (const [queued, says] of [[0, '0 writes'], [1, '1 write'], [2, '2 writes']] as const) {
      const { opening } = longHoldAlert({ move: 'branch switch', agentName: 'a', heldSeconds: 61, queued, waitingForMaintenance: false });
      assert.ok(opening.includes(` wait in memory (${says} now). `), opening);
    }
    says(longHoldAlert({ move: 'branch switch', agentName: 'a', heldSeconds: 61, queued: 1, waitingForMaintenance: false }).opening,
      'the writes the hold keeps are lost, as are those kept for a manager refusing its work.');
    // A disposed agent's held writes: those the primary takes in its place
    // went on to it, and the rest were dropped.
    for (const [heldWrites, passedOn, clause] of [
      [1, 1, ' 1 write held for it went to the primary.'],
      [2, 2, ' 2 writes held for it went to the primary.'],
      [1, 0, " 1 write held for it was dropped: it doesn't go to the primary."],
      [2, 0, ' 2 writes held for it were dropped: none goes to the primary.'],
      [3, 1, ' Of 3 writes held for it, 1 went to the primary and 2 were dropped.'],
      [3, 2, ' Of 3 writes held for it, 2 went to the primary and 1 was dropped.'],
    ] as const) {
      for (const move of REINIT_MOVES) {
        const { opening, message } = disposalAlert({ move, heldWrites, passedOn });
        assert.ok(message.startsWith(`${opening}${clause} Its messages stay`), message);
        assert.equal(opsWebhookText(message), message, `kept whole: ${message}`);
      }
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
          assert.ok(hold.opening.includes(' wait in memory (999999999 writes now). '), hold.opening);
          says(hold.opening, `A restart ends the ${move}, the conversation agents and the runs`, 're-initializes the configured agents',
            'the writes the hold keeps are lost');
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
          for (const passedOn of [0, heldWrites]) {
            const whole = disposalAlert({ move, heldWrites, passedOn }).message;
            assert.equal(opsWebhookText(whole), whole,
              `a disposal after the ${move} with ${heldWrites} held, ${passedOn} passed on, and no failure carries no cause, and is kept whole`);
          }
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


// The window follows a branch move (#291), beside #353's re-initialization
// of every manager: carried here from the fix wave's branch-move-resync test
// (FW-AF-1), whose strategy cases #353's tests above already make. The
// presentation index writes an agent's window down at its registration, so a
// move to a branch made before that write-down (every branch an earlier
// release's store holds, or a rollback into rows the write-down presented,
// which branchAt cuts at their own sequence) would leave the agent in legacy
// mode for the rest of the process: a write during its turn would enter its
// window at once, and undo would be refused. Every agent is rebased after the
// move instead: its window written down where the new branch has none, its own
// rows repaired. A manager whose re-initialization fails leaves its agent in
// legacy mode, traced, until the next move. framework.switchBranch is written
// to the operator log as a checkout.
describe('the window follows a branch move (#291)', () => {
  const blocks = (t: string) => [{ type: 'text', text: t }] as ContentBlock[];
  const STALE = /requires reinitialization/;
  const dirs: string[] = [];
  const frameworks: AgentFramework[] = [];
  afterEach(async () => {
    while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
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

  type WindowInternals = {
    addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; placement?: Record<string, unknown> }): MessageId;
    presents(agent: unknown): boolean;
    activeTurnTokens: Map<string, unknown>;
  };

  /** Two residents, mira (the primary) and oren, on one store, each context with the strategy `strategies` gives it. */
  async function boot(strategies: { mira?: () => object; oren?: () => object } = {}, storePath?: string) {
    if (!storePath) {
      const dir = mkdtempSync(join(tmpdir(), 'af-window-follows-'));
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
    const internals = framework as unknown as WindowInternals;
    const cm = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();

    /** A nudge of `name`, answered: whether it reached the provider, and the inference failures it met. */
    async function turnOf(name: string): Promise<{ requests: number; failures: string[] }> {
      const calls = membrane.calls.length;
      const before = traces.length;
      membrane.pushResponse(createMockResponse(blocks(`${name} answers`)));
      const failuresOf = () => traces.slice(before)
        .filter((t): t is Extract<TraceEvent, { type: 'inference:failed' }> => t.type === 'inference:failed' && t.agentName === name)
        .map((t) => String((t as { error?: unknown }).error));
      assert.equal(framework.nudgeAgent(name, 'zz-op').ok, true);
      await until(() => membrane.calls.length > calls || failuresOf().length > 0, `${name}'s turn to reach the provider or fail`, 10_000);
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

  it("a host's switchBranch is in the operator log as a checkout, and both residents serve on the new branch and back", async () => {
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

  it('a rollback to a row the write-down presented keeps the window presented: a mid-turn write waits, and undo is accepted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-window-follows-'));
    dirs.push(dir);
    const storePath = join(dir, 'store.chronicle');
    // A store an earlier release wrote: rows in the residents' slot, no window index.
    {
      const store = JsStore.openOrCreate({ path: storePath });
      const cm = await StoreWindow.open({ store, ...residentContextOptions('mira'), strategy: new PassthroughStrategy() });
      for (const t of ['old-1', 'old-2', 'old-3']) cm.addMessage('someone', blocks(t), {});
      assert.equal(cm.windowMode(), 'legacy', 'setup: the store predates the index');
      cm.close();
      store.close();
    }
    const h = await boot({ mira: () => new PassthroughStrategy(), oren: () => new PassthroughStrategy() }, storePath);
    const mira = h.framework.getAgent('mira')!;
    assert.equal(h.internals.presents(mira), true, 'setup: written down at registration');
    const old2 = h.cm('mira').getAllMessages().find((m) => (m.content[0] as { text?: string }).text === 'old-2')!;
    h.internals.addMessage('someone', blocks('new-1'), {}, { forAgent: 'mira' });

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
    try {
      const landed = h.internals.addMessage('someone', blocks('landed mid-turn'), {}, { forAgent: 'mira', placement });
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
    const row = h.internals.addMessage('someone', blocks('on old'), {}, { forAgent: 'oren' });
    assert.equal(h.cm('oren').windowStatusOf(row), 'in');
  });

  it("a manager whose re-initialization fails leaves its agent in legacy mode, traced and alerted, until the next move", async () => {
    let oren!: FailingOnce;
    const h = await boot({ oren: () => (oren = new FailingOnce()) });
    const main = h.store.currentBranch().name;
    h.store.createBranchAt('side', main, h.store.currentSequence());
    oren.failNext = true;
    await h.framework.switchBranch('side'); // the move stands
    const failed = rebaseTraces(h.traces).filter((t) => t.type === 'presentation:failed');
    assert.equal(failed.length, 1, JSON.stringify(failed));
    assert.equal(failed[0]!.agentName, 'oren');
    assert.match((failed[0] as { error: string }).error, /zz-initialize-failed/);
    const alerts = h.traces.filter((t) => t.type === 'ops:alert' && t.kind === 'context-reinit-failed');
    assert.deepEqual(alerts.map((t) => (t as { agentName?: string }).agentName), ['oren'], "#353's alert names the agent too");
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

  /** An autobiographical strategy that folds small chunks into L1s and merges four of them into an L2, compressing only when ticked. */
  const folding = () => new AutobiographicalStrategy({
    compressionModel: 'test-model', targetChunkTokens: 200, recentWindowTokens: 300, headWindowTokens: 0, mergeThreshold: 4,
    autoTickOnNewMessage: false,
  });
  type FoldedSummary = { id: string; level: number; sourceIds: readonly string[] };
  /** The rows a summary of `cm`'s strategy folds, through every level below it. */
  const leavesOf = (cm: ContextManager, id: string): string[] => {
    const summary = cm.getSummary(id) as FoldedSummary | null;
    if (!summary) return [];
    return summary.level === 1 ? [...summary.sourceIds] : summary.sourceIds.flatMap((source) => leavesOf(cm, source));
  };
  /** The rows the summaries `cm`'s strategy keeps fold. */
  const foldedBy = (cm: ContextManager): Set<string> => new Set(
    (cm.getStrategy() as unknown as { summaries: FoldedSummary[] }).summaries.flatMap((s) => leavesOf(cm, s.id)),
  );
  /** Tick `cm` until nothing is left to compress. */
  const drain = async (cm: ContextManager): Promise<void> => {
    for (let i = 0; i < 2000 && !cm.isReady(); i++) await cm.tick();
    assert.equal(cm.isReady(), true, 'drained');
  };
  /** The rows `cm`'s compile renders, raw or folded in a summary, by their ids. */
  const renderedBy = async (cm: ContextManager): Promise<string[]> => {
    const compiled = await cm.compile({ maxTokens: 1_000_000, reserveForResponse: 0 }, undefined, { dryRun: true });
    const sources = (compiled as { provenance?: { messages: Array<{ kind: string; bodies?: Array<{ messageId: string }>; summaries?: Array<{ id: string }> }> } })
      .provenance?.messages ?? [];
    assert.ok(sources.length > 0, 'the compile has provenance');
    return sources.flatMap((part) => part.kind === 'raw'
      ? (part.bodies ?? []).map((body) => String(body.messageId))
      : part.kind === 'summary' ? (part.summaries ?? []).flatMap((s) => leavesOf(cm, s.id)) : []);
  };

  it("a suppression through one of two folding residents takes the rows out of both windows and out of every summary of the other's: it follows the fork before the removals", async () => {
    const h = await boot({ mira: folding, oren: folding });
    // Compression answers with a summary; a turn's stream is the mock's own.
    let compressions = 0;
    h.membrane.complete = async () => createMockResponse(blocks(`[summary ${++compressions}] ` + 'mem '.repeat(20)));
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(String(h.internals.addMessage('someone', blocks(`TAG${i} ` + 'word '.repeat(60)), {}, {})));
    for (const name of ['mira', 'oren']) {
      assert.equal(h.cm(name).windowMode(), 'presented', name);
      assert.deepEqual([...new Set(ids.map((id) => h.cm(name).windowStatusOf(id as MessageId)))], ['in'], `setup: every row is in ${name}'s window`);
      await drain(h.cm(name));
    }
    const removed = ids.slice(9, 39);
    for (const name of ['mira', 'oren']) {
      const levels = (h.cm(name).getStrategy() as unknown as { summaries: FoldedSummary[] }).summaries.map((s) => s.level);
      assert.ok(levels.includes(1) && levels.includes(2), `setup: ${name} folded into L1s and L2s: ${levels.join('')}`);
      const folded = foldedBy(h.cm(name));
      assert.equal(removed.filter((id) => folded.has(id)).length, removed.length, `setup: ${name}'s summaries fold every row to be removed`);
    }
    const refused: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { refused.push(args.map(String).join(' ')); error(...args); };
    let r: Awaited<ReturnType<AgentFramework['suppressMessages']>>;
    try {
      r = await h.framework.suppressMessages('mira', { messageIds: removed });
      await settled();
    } finally {
      console.error = error;
    }
    assert.equal(r.messagesRemoved, removed.length);
    const gone = new Set(removed);
    for (const name of ['mira', 'oren']) {
      const cm = h.cm(name);
      assert.deepEqual([...new Set(removed.map((id) => cm.windowStatusOf(id as MessageId)))], ['absent'], `out of ${name}'s window`);
      const folded = foldedBy(cm);
      assert.deepEqual(removed.filter((id) => folded.has(id)), [], `no summary of ${name}'s folds a removed row`);
      assert.deepEqual((await renderedBy(cm)).filter((id) => gone.has(id)), [], `${name}'s compile renders no removed row`);
      await drain(cm);
      const refolded = foldedBy(cm);
      assert.deepEqual(removed.filter((id) => refolded.has(id)), [], `nor once ${name}'s kept rows are folded again`);
      assert.deepEqual((await renderedBy(cm)).filter((id) => gone.has(id)), [], `${name}'s compile then renders none either`);
    }
    assert.deepEqual(refused.filter((line) => /onRetracted failed|requires reinitialization/.test(line)), [], "no strategy refused the rows' leaving");
    await h.bothServe('after the suppression');
  });

  it('a rollback whose switch fails, and whose restore succeeds, leaves both residents presented and current on the source', async () => {
    const h = await boot();
    const main = h.store.currentBranch().name;
    const first = h.internals.addMessage('someone', blocks('zz-first'), {}, { forAgent: 'mira' });
    h.internals.addMessage('someone', blocks('zz-second'), {}, { forAgent: 'mira' });
    await h.bothServe('before the rollback');
    const mira = h.cm('mira') as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
    const initializeStrategy = mira.initializeStrategy;
    let failNext = true;
    mira.initializeStrategy = async function (this: unknown, ...args: unknown[]) {
      if (failNext) { failNext = false; throw new Error('zz-switch-init-failed'); }
      return initializeStrategy.apply(this, args);
    };
    try {
      await assert.rejects(
        h.framework.rollbackToMessage('mira', { messageId: first, branchName: 'zz-failed-rollback' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /active branch restored to /.test(e.message),
      );
    } finally {
      mira.initializeStrategy = initializeStrategy;
    }
    assert.equal(h.store.currentBranch().name, main);
    for (const name of ['mira', 'oren']) {
      assert.equal(h.internals.presents(h.framework.getAgent(name)!), true, `${name} presents`);
      assert.equal(h.cm(name).windowMode(), 'presented', `${name}'s window`);
    }
    await h.bothServe('after the failed rollback');
  });

  it("a suppression whose removals fail after its fork, and whose restore succeeds, has the other resident follow the store back: both presented and current on the source", async () => {
    const h = await boot();
    const main = h.store.currentBranch().name;
    const target = h.internals.addMessage('someone', blocks('zz-to-suppress'), {}, {});
    await h.bothServe('before the suppression');
    for (const name of ['mira', 'oren']) assert.equal(h.cm(name).windowStatusOf(target), 'in', `setup: in ${name}'s window`);
    const mira = h.cm('mira') as unknown as { removeMessage: (...args: unknown[]) => void; removeMessages: (...args: unknown[]) => void };
    const removeMessage = mira.removeMessage;
    const removeMessages = mira.removeMessages;
    mira.removeMessage = () => { throw new Error('zz-removal-failed'); };
    mira.removeMessages = () => { throw new Error('zz-removal-failed'); };
    try {
      await assert.rejects(
        h.framework.suppressMessages('mira', { messageIds: [target], branchName: 'zz-partly-suppressed' }),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /active branch restored to /.test(e.message),
      );
    } finally {
      mira.removeMessage = removeMessage;
      mira.removeMessages = removeMessages;
    }
    assert.equal(h.store.currentBranch().name, main);
    for (const name of ['mira', 'oren']) {
      assert.equal(h.cm(name).windowStatusOf(target), 'in', `the row stays in ${name}'s window on the source`);
      assert.equal(h.internals.presents(h.framework.getAgent(name)!), true, `${name} presents`);
      assert.equal(h.cm(name).windowMode(), 'presented', `${name}'s window`);
    }
    await h.bothServe('after the failed suppression');
  });

  for (const move of ['rollback', 'suppression'] as const) {
    it(`a ${move} drops every redo entry, every agent's: each undid a window of the branch the store left`, async () => {
      const h = await boot();
      const first = h.internals.addMessage('someone', blocks('zz-first'), {}, { forAgent: 'oren' });
      const second = h.internals.addMessage('someone', blocks('zz-second'), {}, { forAgent: 'oren' });
      await h.bothServe('a round');
      assert.equal(h.framework.undoLastTurn('mira').undone, true);
      assert.equal(h.framework.getUndoRedoState('mira').canRedo, true, 'setup');
      if (move === 'rollback') await h.framework.rollbackToMessage('oren', { messageId: first });
      else await h.framework.suppressMessages('oren', { messageIds: [second] });
      assert.equal(h.framework.getUndoRedoState('mira').canRedo, false);
      assert.deepEqual(h.framework.redo('mira'), { redone: false });
    });
  }
});
