/**
 * AF #844's bot review, findings on undo and redo, branch moves, a surgery's
 * release and a rollback's planning (review 8, F2b). Each test says what it
 * found before its fix.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextManager, MessageId, MessageMetadata, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { GateModule, until } from './helpers/dendrite.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';

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
