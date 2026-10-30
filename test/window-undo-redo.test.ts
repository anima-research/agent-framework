/**
 * Undo and redo on an agent's window (#291, decision 4), past a single
 * level: undos redone in turn give back the window they took, in its order;
 * a redo is refused on another branch than its undo's; an undo cut short
 * between its two retractions can be redone or finished; the marks that
 * covered the undone rows cover them again once they are back; and the
 * stored injection an undo took out is stored again at the next start.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextInjection, ContextManager, MessageId, MessageMetadata, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError, asOwnRow } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { covers } from '../src/read-marks.js';
import { GateModule, until } from './helpers/dendrite.js';
import { WireMembrane, final, round } from './helpers/wire-membrane.js';

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

/** A module whose context is a lesson, stored as the agent's own injection after the user's message. */
class LessonModule implements Module {
  readonly name = 'lessons';
  lesson = 'LESSON one';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
  async gatherContext(): Promise<ContextInjection[]> {
    return [{ namespace: 'lessons', position: 'afterUser', content: [text(this.lesson)] }] as ContextInjection[];
  }
}

type Placement = { agent: string; messageId?: string };
type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  recordTurnCheckpoint(agentName: string): void;
  presentAtEndOf(agent: Agent | undefined): void;
  getTurnCheckpoints(agentName: string): Array<{ turnIndex: number; indexLengthBefore?: number }>;
  isUnreadStoredMessage(agent: Agent, id: MessageId, by?: 'consumed' | 'shown'): boolean;
  isUnreadPlacement(placement: Placement, by?: 'consumed' | 'shown'): boolean;
  removePlacement(placement: Placement): boolean;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { modules?: Module[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-window-undo-redo-'));
  dirs.push(dir);
  const membrane = new WireMembrane();
  const gates = new GateModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', allowedTools: 'all', proseRouting: 'disabled' }],
    modules: [gates, new SurfaceModule(), ...(opts.modules ?? [])],
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
  const statuses = (...texts: string[]) => texts.map((t) => cm.windowStatusOf(rowWith(t).id));
  const compiled = async () => (await cm.compile(undefined, undefined, { dryRun: true })).messages
    .map((m) => textOf(m as { content: ContentBlock[] }) || (m as { content: ContentBlock[] }).content.map((b) => b.type).join('+'));
  /** One of mira's turns, asked with `ask` and answered with `reply`. */
  const turn = async (ask: string, reply: string) => {
    membrane.script('mira', final([text(reply)]));
    framework.pushEvent(input(ask));
    await until(() => inWindow(reply), `mira's reply "${reply}"`);
    await framework.runUntilIdle();
  };
  framework.start();
  return { framework, membrane, gates, internals, mira, cm, rowWith, inWindow, windowTexts, statuses, compiled, turn };
}

describe('undo and redo on the window (#291)', () => {
  it('two undos redone in turn give back the window they took, in its order, and the turn still undone reads as undone', async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    const window = h.windowTexts();
    assert.deepEqual(window, ['first', 'one', 'second', 'two']);
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, h.rowWith('second').id), false, "the second turn's compile read its ask");

    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 1, represented: 0 });
    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 2, represented: 0 });
    assert.deepEqual(h.windowTexts(), ['first']);
    assert.deepEqual(h.statuses('one', 'second', 'two'), ['undone', 'out', 'undone']);

    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 2 });
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second']);
    assert.deepEqual(h.statuses('two'), ['undone'], 'the turn still undone stays undone, out of every point');
    // Before: the second redo took the first's rows out as "presented since"
    // its undo (their new ordinals were past its length), leaving 'one' out
    // and not undone, and the window [first, two, one, second].
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 1 });
    assert.deepEqual(h.windowTexts(), window, 'the window as it was before either undo');
    assert.deepEqual(h.statuses('one', 'second', 'two'), ['in', 'in', 'in']);
    h.internals.presentAtEndOf(h.mira);
    assert.deepEqual(h.windowTexts(), window, 'and its next point has nothing to add');
    assert.deepEqual(await h.compiled(), window, 'the compile sends that order');
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 2, 'both checkpoints are back');
    assert.equal(h.internals.isUnreadStoredMessage(h.mira, h.rowWith('second').id), false, 'what the turns read reads as read again');
  });

  it('after two undos redone in turn, an undo takes out the last turn alone, and its redo gives the window back', async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    const window = h.windowTexts();
    h.framework.undoLastTurn('mira');
    h.framework.undoLastTurn('mira');
    h.framework.redo('mira');
    h.framework.redo('mira');
    assert.deepEqual(h.windowTexts(), window, 'the premise: both turns are back, at new ordinals');

    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 1, represented: 0 });
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second'], 'the first turn, redone before it, stays');
    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 2, represented: 0 });
    assert.deepEqual(h.windowTexts(), ['first']);
    h.framework.redo('mira');
    h.framework.redo('mira');
    assert.deepEqual(h.windowTexts(), window, 'and redone again, the window as it was');
  });

  it('a row presented between the undos leaves at the redo that reaches past it and comes back after the redone turns', async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    h.internals.addMessage('someone', [text('between the undos')], undefined, { forAgent: 'mira' });
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second', 'between the undos'], 'presented at rest');
    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 3, represented: 0 }, 'the first turn takes it out with its own tail');
    assert.deepEqual(h.windowTexts(), ['first']);

    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 3 });
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second', 'between the undos']);
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 1, represented: 1 },
      'only the row presented since the second undo leaves; the rows the first redo put back stay');
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second', 'two']);
    assert.deepEqual(h.statuses('between the undos'), ['out'], 'arrived and not presented');
    h.internals.presentAtEndOf(h.mira);
    const window = ['first', 'one', 'second', 'two', 'between the undos'];
    assert.deepEqual(h.windowTexts(), window, 'its next point presents it after the redone turn');
    assert.deepEqual(await h.compiled(), window);
  });

  it('a branch move drops a redo; a redo on another branch than its undo\'s is refused and changes nothing', async () => {
    const h = await boot();
    await h.turn('first', 'one');
    await h.turn('second', 'two');
    await h.turn('third', 'three');
    const store = h.framework.getStore();
    const main = store.currentBranch().name;
    const mainWindow = h.windowTexts();
    const mainCheckpoints = () => JSON.stringify(h.internals.getTurnCheckpoints('mira'));

    // An undo on a rollback branch, then a switch back to main through the framework.
    await h.framework.rollbackToMessage('mira', { messageId: h.rowWith('one').id });
    await h.framework.runUntilIdle();
    await h.turn('x', 'y');
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    await h.framework.switchBranch(main);
    const before = mainCheckpoints();
    assert.equal(h.framework.getUndoRedoState('mira').canRedo, false);
    assert.deepEqual(h.framework.redo('mira'), { redone: false });
    assert.deepEqual(h.windowTexts(), mainWindow, "main's window is as it was");
    assert.equal(mainCheckpoints(), before, "and its checkpoints");

    // An undo on main, then a move of the store past the framework: the
    // entry stays, but its ordinals are main's window's.
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    const undoneOnMain = h.windowTexts();
    const checkpointsOnMain = mainCheckpoints();
    store.createBranchAt('side', main, store.currentSequence());
    store.switchBranch('side');
    const sideWindow = h.windowTexts();
    assert.deepEqual(h.framework.getUndoRedoState('mira'), { canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 1 });
    assert.throws(() => h.framework.redo('mira'),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && e.message.includes(`on branch ${main}`) && e.message.includes('side'));
    assert.deepEqual(h.windowTexts(), sideWindow, "side's window is untouched");
    assert.equal(mainCheckpoints(), checkpointsOnMain, 'no checkpoint was pushed');

    store.switchBranch(main);
    assert.deepEqual(h.windowTexts(), undoneOnMain);
    assert.equal(h.framework.getUndoRedoState('mira').canRedo, true, 'back on its branch, the redo is offered again');
    assert.equal(h.framework.redo('mira').redone, true);
    assert.deepEqual(h.windowTexts(), mainWindow);
  });

  /** mira's second turn takes a round, during which someone's row arrives and is heard: her tail is her rows and theirs, interleaved. */
  async function interleaved() {
    const h = await boot();
    await h.turn('first', 'one');
    h.membrane.script('mira', round('c2', [text('looking')], 'wait', { gate: 'u' }), final([text('two')]));
    h.framework.pushEvent(input('second'));
    await until(() => h.gates.entered.has('u'), 'the second turn waiting on its tool');
    h.internals.addMessage('someone', [text('from someone')], undefined, { forAgent: 'mira' });
    h.gates.release('u');
    await until(() => h.inWindow('two'), 'the second turn');
    await h.framework.runUntilIdle();
    const window = h.windowTexts();
    assert.deepEqual(window, ['first', 'one', 'second', 'looking', 'tool_result', 'from someone', 'two']);
    /** Refuse the next retraction of others' rows (one without `undone`), as a failed index write would. */
    const failOthersOnce = () => {
      const target = h.cm as unknown as { retractRows: (ids: readonly MessageId[], options?: { undone?: boolean }) => void };
      const real = target.retractRows.bind(h.cm);
      target.retractRows = (ids, options) => {
        if (options?.undone) return real(ids, options);
        target.retractRows = real;
        throw new Error('index write refused');
      };
    };
    return { ...h, window, failOthersOnce };
  }

  it('an undo cut short after its own rows left is refused, and a redo puts the turn back in its order', async () => {
    const h = await interleaved();
    h.failOthersOnce();
    assert.throws(() => h.framework.undoLastTurn('mira'),
      (e: unknown) => e instanceof OperatorActionError && e.code === 'failed' && /cut short: 3 of the 4 rows/.test(e.message) && /index write refused/.test(e.message));
    assert.deepEqual(h.statuses('looking', 'two', 'from someone'), ['undone', 'undone', 'in'], "her own rows left, someone's didn't");
    assert.deepEqual(h.framework.getUndoRedoState('mira'), { canUndo: true, canRedo: true, undoDepth: 2, redoDepth: 1 },
      'the checkpoint stays, and the redo is kept');

    // Before: no redo entry was kept, and nothing presented her own rows again.
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 1, represented: 4 });
    assert.deepEqual(h.windowTexts(), h.window, 'the turn back in its order');
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 2, 'its checkpoint once, not twice');
  });

  it('another undo finishes one cut short, and the two redos give the turn back in its order', async () => {
    const h = await interleaved();
    h.failOthersOnce();
    assert.throws(() => h.framework.undoLastTurn('mira'), OperatorActionError);
    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 1, represented: 0 }, 'the row still in the window past the checkpoint');
    assert.deepEqual(h.windowTexts(), ['first', 'one', 'second']);
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 1);
    assert.equal(h.framework.redo('mira').redone, true);
    assert.equal(h.framework.redo('mira').redone, true);
    assert.deepEqual(h.windowTexts(), h.window);
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 2, 'its checkpoint once');
  });

  it('an undo that took nothing out throws its error and keeps no redo', async () => {
    const h = await interleaved();
    const target = h.cm as unknown as { retractRows: (ids: readonly MessageId[], options?: { undone?: boolean }) => void };
    const real = target.retractRows.bind(h.cm);
    target.retractRows = () => { target.retractRows = real; throw new Error('index write refused'); };
    assert.throws(() => h.framework.undoLastTurn('mira'), /^Error: index write refused$/);
    assert.deepEqual(h.windowTexts(), h.window);
    assert.deepEqual(h.framework.getUndoRedoState('mira'), { canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 0 });
  });

  it('a redo gives back the marks that covered the turn: a render its reply answered reads as read, shown and answered, and is not taken back', async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('before the turn')], undefined, { forAgent: 'mira' });
    h.internals.recordTurnCheckpoint('mira');
    // During the turn a render arrives and is presented, and her reply answers it.
    const render = h.internals.addMessage('editor', [text('render v1')], { serverId: 'editor', eventId: 'ev-1' } as MessageMetadata, { forAgent: 'mira' });
    const reply = h.cm.addMessage('mira', [text('I saw render v1')], asOwnRow(undefined, 'mira'));
    h.cm.presentRows([reply]);
    await h.mira.compileContext();
    h.mira.markAnswered(h.mira.getConsumedWatermark());
    const placement = { agent: 'mira', messageId: render };
    assert.equal(h.internals.isUnreadPlacement(placement), false, 'setup: read');

    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 2, represented: 0 });
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 0, represented: 2 });
    // Before: the rows came back past every mark, and read as unread and
    // unshown, so the coalescer took the render back from under the reply.
    assert.equal(h.internals.isUnreadPlacement(placement), false, 'read');
    assert.equal(h.internals.isUnreadPlacement(placement, 'shown'), false, 'shown');
    assert.equal(covers(h.mira.getAnsweredWatermark(), h.cm, h.cm.getMessage(render)!), 'covered', 'answered');
    assert.equal(h.internals.removePlacement(placement), false, 'not taken back');
    assert.deepEqual(h.windowTexts(), ['before the turn', 'render v1', 'I saw render v1']);
  });

  it('a mark given again at a redo covers only what it covered at the undo, and nothing presented since', async () => {
    const h = await boot();
    h.internals.recordTurnCheckpoint('mira');
    const render = h.internals.addMessage('editor', [text('render v1')], undefined, { forAgent: 'mira' });
    await h.mira.compileContext();
    const reply = h.cm.addMessage('mira', [text('I saw render v1')], asOwnRow(undefined, 'mira'));
    h.cm.presentRows([reply]);
    const marks = () => [render, reply].map((id) => covers(h.mira.getConsumedWatermark(), h.cm, h.cm.getMessage(id)!));
    assert.deepEqual(marks(), ['covered', 'not-covered'], 'setup: her compile read the render, not her reply after it');

    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    const since = h.internals.addMessage('user', [text('after the undo')], undefined, { forAgent: 'mira' });
    assert.deepEqual(h.windowTexts().slice(-2), ['render v1', 'after the undo'],
      'presented at rest, after the render the undo gave back as an arrival');
    assert.deepEqual(h.framework.redo('mira').window, { retracted: 2, represented: 2 }, 'both leave, and the turn comes back');
    assert.deepEqual(marks(), ['covered', 'not-covered']);
    h.internals.presentAtEndOf(h.mira);
    assert.deepEqual(h.windowTexts().slice(-3), ['render v1', 'I saw render v1', 'after the undo']);
    assert.equal(covers(h.mira.getConsumedWatermark(), h.cm, h.cm.getMessage(since)!), 'not-covered', 'the row presented since the undo is unread');
  });

  it("a stored injection that changed in the undone turn is stored again at the next start", async () => {
    const lessons = new LessonModule();
    const h = await boot({ modules: [lessons] });
    const sent = (i: number) => h.membrane.streams[i]!.request.messages.map((m) => textOf(m as { content: ContentBlock[] })).filter(Boolean);
    await h.turn('first', 'one');
    lessons.lesson = 'LESSON two';
    await h.turn('second', 'two');
    assert.ok(sent(1).includes('LESSON two'), 'setup: the second request carried the changed lesson');
    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    assert.ok(!h.inWindow('LESSON two'), 'the undo took its copy out');
    await h.turn('third', 'three');
    // Before: the last compile's record still named the undone copy, so the
    // lesson was neither stored nor placed, and the request held only 'LESSON one'.
    assert.ok(sent(2).includes('LESSON two'), 'the next request carries the current lesson');
    await h.turn('fourth', 'four');
    assert.equal(sent(3).filter((t) => t === 'LESSON two').length, 1, 'once: the copy stored again is the one it holds');
  });
});
