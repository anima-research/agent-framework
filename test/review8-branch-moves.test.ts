/**
 * AF #844's bot review, findings on undo and redo, branch moves, a surgery's
 * release and a rollback's planning (review 8, F2b). Each test says what it
 * found before its fix.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { ContextManager, MessageId, MessageMetadata, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { GateModule, until } from './helpers/dendrite.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { fixture } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { SUB, internals as admissionInternals, textOf as storedText, find, registerOpen, enter } from './helpers/admission.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) => row.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

/** A surface's module: an `external-message` event's text becomes a user message that asks mira. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content } = event as unknown as { content: ContentBlock[] };
    return { addMessages: [{ participant: 'user', content }], requestInference: ['mira'] };
  }
}
const input = (t: string): ProcessEvent =>
  ({ type: 'external-message', source: 'test', content: [text(t)], metadata: {} }) as unknown as ProcessEvent;

type RedoEntry = { window: { tail: unknown[] } };
type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  presentAtEndOf(agent: Agent | undefined): void;
  getTurnCheckpoints(agentName: string): Array<{ turnIndex: number; indexLengthBefore?: number }>;
  redoStacks: Map<string, RedoEntry[]>;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** mira on a store of her own, with a surface that asks her. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'af-review8-2b-'));
  dirs.push(dir);
  const membrane = new WireMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', allowedTools: 'all', proseRouting: 'disabled' }],
    modules: [new GateModule(), new SurfaceModule()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  frameworks.push(framework);
  const internals = framework as unknown as Internals;
  const mira = framework.getAgent('mira')!;
  const cm: ContextManager = mira.getContextManager();
  const rowWith = (t: string): StoredMessage => {
    const row = cm.getAllMessages().find((m) => textOf(m) === t);
    assert.ok(row, `a row "${t}" is stored`);
    return row;
  };
  const inWindow = (t: string) => { const row = cm.getAllMessages().find((m) => textOf(m) === t); return !!row && cm.ordinalOf(row.id) !== undefined; };
  const windowTexts = () => cm.getPresentedMessages().map((m) => textOf(m) || m.content.map((b) => b.type).join('+'));
  const turn = async (ask: string, reply: string) => {
    membrane.script('mira', final([text(reply)]));
    framework.pushEvent(input(ask));
    await until(() => inWindow(reply), `mira's reply "${reply}"`);
    await framework.runUntilIdle();
  };
  /** The checkpoint store's next write throws, once, as a failed write would. */
  const failCheckpointSaveOnce = () => {
    const store = framework.getStore() as unknown as { treeSet: (...args: unknown[]) => unknown };
    const real = store.treeSet;
    store.treeSet = function (this: unknown, ...args: unknown[]) {
      store.treeSet = real;
      throw new Error('the tree write was refused');
    };
  };
  const operatorActions = () => {
    const actions: Array<Extract<TraceEvent, { type: 'operator:action' }>> = [];
    framework.onTrace((e) => { if (e.type === 'operator:action') actions.push(e); });
    return actions;
  };
  framework.start();
  return { framework, membrane, internals, mira, cm, rowWith, inWindow, windowTexts, turn, failCheckpointSaveOnce, operatorActions };
}

describe('undo and redo, when a later step fails (AF #844 bot review 10, 49, 123)', () => {
  // 10: the undo kept its redo entry and took the rows out, then its
  // checkpoint save threw the store's error. The checkpoint stayed, so a
  // retried undo took it again with nothing left past it and kept an empty
  // redo, which the first redo then consumed: it restored nothing.
  it("an undo whose checkpoint save fails is refused saying its rows left, and the next undo finishes it without a redo of nothing", async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    const window = h.windowTexts();
    const actions = h.operatorActions();
    h.failCheckpointSaveOnce();
    assert.throws(() => h.framework.undoLastTurn('mira'), (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
      && /took its 1 row out of the window, and saving its checkpoints failed \(the tree write was refused\)/.test(e.message)
      && /redo\(\) puts it back, or another undo finishes it/.test(e.message));
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second'], 'the row left');
    assert.deepEqual(h.framework.getUndoRedoState('mira'), { canUndo: true, canRedo: true, undoDepth: 2, redoDepth: 1 });
    assert.equal(actions.at(-1)?.error, 'the tree write was refused', 'recorded with its error');
    const again = h.framework.undoLastTurn('mira');
    assert.deepEqual([again.undone, again.window], [true, { retracted: 0, represented: 0 }], 'it finishes the save');
    assert.deepEqual(h.framework.getUndoRedoState('mira'), { canUndo: true, canRedo: true, undoDepth: 1, redoDepth: 1 }, 'and keeps no second redo');
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 1 });
    assert.deepEqual(h.windowTexts(), window, 'the turn is back');
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 2);
  });

  // 49: a redo's presentRows threw the store's error after the rows
  // presented since the undo had left the window, and the redo entry stayed
  // with nothing said of what had changed.
  it('a redo cut short after the rows presented since its undo left is refused saying so, and another redo finishes it', async () => {
    const h = await boot();
    await h.turn('first', 'one');
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    h.internals.addMessage('someone', [text('since the undo')], undefined, { forAgent: 'mira' });
    assert.deepEqual(h.windowTexts(), ['first', 'since the undo'], 'premise: presented at rest');
    const actions = h.operatorActions();
    const target = h.cm as unknown as { presentRows: (ids: MessageId[]) => unknown };
    const real = target.presentRows;
    target.presentRows = function (this: unknown, ids: MessageId[]) {
      if (ids.length === 0) return real.call(this, ids);
      target.presentRows = real;
      throw new Error('the index write was refused');
    };
    assert.throws(() => h.framework.redo('mira'), (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
      && /Redo of mira's turn 0 was cut short: the 1 row it took out of the window first left it, and 0 of the 1 row of the turn it puts back returned \(the index write was refused\)/.test(e.message)
      && /Another redo\(\) finishes it/.test(e.message));
    assert.deepEqual(h.windowTexts(), ['first']);
    assert.deepEqual((actions.at(-1)?.result as { window?: unknown } | undefined)?.window, { retracted: 1, represented: 0 });
    assert.equal(actions.at(-1)?.error, 'the index write was refused');
    assert.equal(h.framework.getUndoRedoState('mira').canRedo, true, 'the redo is kept');
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 1 });
    assert.deepEqual(h.windowTexts(), ['first', 'one']);
    h.internals.presentAtEndOf(h.mira);
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'since the undo']);
    assert.equal(h.framework.getUndoRedoState('mira').redoDepth, 0);
  });

  it("a redo whose checkpoint save fails puts the turn back, says so, and another redo saves it", async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    const window = h.windowTexts();
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    h.failCheckpointSaveOnce();
    assert.throws(() => h.framework.redo('mira'), (e: unknown) => e instanceof OperatorActionError && e.code === 'failed'
      && /Redo of mira's turn 1 was cut short: the 1 row of the turn is back in the window, and saving its checkpoints failed \(the tree write was refused\)/.test(e.message));
    assert.deepEqual(h.windowTexts(), window);
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 1, 'premise: its checkpoint is not saved');
    assert.equal(h.framework.getUndoRedoState('mira').canRedo, true);
    assert.equal(h.framework.redo('mira').redone, true);
    assert.deepEqual(h.windowTexts(), window);
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 2, 'its checkpoint saved');
    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 1, represented: 0 }, 'an undo takes out the last turn alone');
  });

  // 123: the redo emitted window:undone before redo() popped its entry, so a
  // listener's undo pushed a new entry that the outer redo then popped,
  // leaving the stale entry it had consumed on the stack.
  it("a listener's undo from the redo's trace keeps its own redo entry, not the one the redo consumed", async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    const window = h.windowTexts();
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    const consumed = h.internals.redoStacks.get('mira')!.at(-1)!;
    let nested: ReturnType<AgentFramework['undoLastTurn']> | undefined;
    const off = h.framework.onTrace((t) => {
      if (t.type === 'window:undone' && (t as { represented?: number }).represented && nested === undefined) nested = h.framework.undoLastTurn('mira');
    });
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 1 });
    off();
    assert.deepEqual(nested?.window, { retracted: 1, represented: 0 }, 'premise: the listener undid the turn again');
    const stack = h.internals.redoStacks.get('mira')!;
    assert.equal(stack.length, 1);
    assert.ok(!stack.includes(consumed), 'the entry the redo consumed is gone');
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 1 });
    assert.deepEqual(h.windowTexts(), window);
  });
});

// 21: the release cleared the hold and took every held write off the queue
// before it replayed any. A synchronous listener of the first replayed
// write's trace that cancelled a tune-out found writesHeld false and an
// empty held list, so the cancel ran then and dumped its backlog without
// the held message the replay had still to store.
describe("a surgery's release, while it replays the writes its hold kept (AF #844 bot review 21)", () => {
  it("a tune-out cancel a listener asks for mid-replay waits for the rest, and its backlog has the message replayed after it", async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const registry = admissionInternals(f).channelRegistry;
      const coordinator = admissionInternals(f).tuneOutCoordinator!;
      const epochId = registry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const framework = f.framework as unknown as {
        addMessage(p: string, c: unknown[], m: Record<string, unknown>): string;
        reserveStoreForSurgery(verb: string, agentName: string): () => void;
      };
      const release = framework.reserveStoreForSurgery('roll back', 'agent');
      assert.equal(framework.addMessage('antra', [{ type: 'text', text: 'first, in work' }], { channelId: 'work', serverId: 'editor' }), '', 'premise: held by the hold');
      assert.equal(framework.addMessage('antra', [{ type: 'text', text: 'second, held from noisy' }], {
        tuneOut: { epochId }, channelId: 'noisy', serverId: 'editor', author: { id: 'U1', name: 'antra' },
      }), '');
      let answer: ReturnType<typeof coordinator.cancel> | undefined;
      let waiting: number | undefined;
      const off = f.framework.onTrace((t) => {
        if (t.type !== 'message:added' || t.source !== 'surgery-release' || answer) return;
        waiting = f.framework.getHostModeStatus().deferredWrites;
        answer = coordinator.cancel('editor', 'noisy', 'agent-tool', 'test');
      });
      release();
      off();
      assert.equal(waiting, 1, 'the write still to replay is counted as held');
      assert.deepEqual(answer, { ok: true, deferred: true }, 'the cancel waits for the replay');
      assert.equal(registry.getTuneOutState('editor', 'noisy'), null, 'and runs at its end');
      assert.match(storedText(find(f, '<tuned-out-backlog')), /second, held from noisy/, 'its backlog has the message replayed after the cancel was asked');
    } finally { await f.close(); }
  });
});


// 61: a rollback through an agent whose switch failed, and whose restore
// selected the source but couldn't initialize its manager, leaves that
// manager refusing its work. Following the move skipped it as the agent the
// move was made through and counted it as recovered: its window was rebased
// and read as presented though its strategy refuses, and writes kept for it
// would have gone to the release as recovered.
describe('a branch move made through an agent whose manager its restore left refusing its work (AF #844 bot review 61)', () => {
  it("doesn't count that manager recovered: its window stays in legacy mode, traced with the cause, until a move re-initializes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-2b-fenced-'));
    dirs.push(dir);
    const autobiographical = () => new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
    });
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [
        { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: autobiographical() },
        { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: autobiographical() },
      ],
      modules: [],
    });
    frameworks.push(framework);
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    const cmA = () => framework.getAgent('a')!.getContextManager();
    const firstId = String(cmA().addMessage('user', [text('hello a')]));
    cmA().addMessage('user', [text('second a')]);
    const presents = () => (framework as unknown as { presents(agent: Agent): boolean }).presents(framework.getAgent('a')!);
    assert.equal(presents(), true, 'premise');
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // The rollback's switch fails, and its restore selects main but can't
      // initialize a's manager.
      const target = cmA() as unknown as { initializeStrategy: (...args: unknown[]) => Promise<void> };
      const initializeStrategy = target.initializeStrategy;
      target.initializeStrategy = async () => { throw new Error('injected strategy init failure'); };
      const before = traces.length;
      try {
        await assert.rejects(framework.rollbackToMessage('a', { messageId: firstId, branchName: 'failed-twice' }),
          (e: unknown) => e instanceof OperatorActionError && /RESTORE TO main selected it/.test(e.message));
      } finally {
        target.initializeStrategy = initializeStrategy;
      }
      assert.equal(framework.getStore().currentBranch().name, 'main', 'premise: the restore selected main');
      assert.equal(presents(), false, 'its window is not read as presented');
      const failed = traces.slice(before).filter((t) => t.type === 'presentation:failed' && t.agentName === 'a');
      assert.deepEqual(failed.map((t) => (t as { occasion: string }).occasion), ['rebase']);
      assert.match((failed[0] as { error: string }).error, /injected strategy init failure/, 'naming the cause');
      assert.equal(traces.slice(before).filter((t) => t.type === 'ops:alert' && t.kind === 'context-reinit-failed' && t.agentName === 'a').length, 1,
        'reported once, by the restore');
      // A switch that re-initializes the manager presents its window again.
      await framework.switchBranch(framework.getStore().currentBranch().name);
    } finally {
      console.error = quiet;
    }
    assert.equal(presents(), true);
    await framework.getAgent('a')!.getContextManager().compile({ maxTokens: 100_000, reserveForResponse: 1_000 }, undefined, { dryRun: true });
  });
});

// 63: the persisted quiesce flags were set after the modules started, so a
// module's start() write on a host that stopped quiesced was handled as one
// to a serving host: it took a clock row, and entered the agent's window at
// once.
describe('a module that writes from start() on a host booting quiesced (AF #844 bot review 63)', () => {
  async function bootWithStartWrite(quiesced: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'af-review8-2b-quiesced-'));
    dirs.push(dir);
    const storePath = join(dir, 'store');
    const hostModePath = join(dir, 'host-mode.json');
    if (quiesced) writeFileSync(hostModePath, JSON.stringify({ version: 1, quiesced: true, reason: 'maintenance', since: Date.now() }));
    const quiet = console.error;
    console.error = () => {};
    try {
      const framework = await AgentFramework.create({
        storePath,
        hostModePath,
        membrane: new MockMembrane().asMembrane(),
        timeZone: 'UTC',
        agents: [{ name: 'a', model: 'test-model', systemPrompt: 'You are a.', clock: { intervalMinutes: 10 } }],
        modules: [{
          name: 'starter',
          async start(ctx: ModuleContext) { ctx.addMessage('someone', [text('written at start')]); },
          async stop() {},
          getTools: () => [],
          async handleToolCall() { return { success: true }; },
          async onProcess() { return {}; },
        } as Module],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 0,
      } as never);
      frameworks.push(framework);
      const cm = framework.getAgent('a')!.getContextManager();
      const rows = cm.getAllMessages();
      const written = rows.find((m) => textOf(m) === 'written at start');
      assert.ok(written, 'the write is stored');
      return { clocks: rows.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'clock').length, status: cm.windowStatusOf(written.id) };
    } finally {
      console.error = quiet;
    }
  }

  it('takes no clock row, and stays out of the window until resume, as a write the importer stores then does', async () => {
    assert.deepEqual(await bootWithStartWrite(false), { clocks: 1, status: 'in' }, 'premise: on a serving host it takes one, and enters the window');
    assert.deepEqual(await bootWithStartWrite(true), { clocks: 0, status: 'out' });
  });
});

