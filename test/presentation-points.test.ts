/**
 * The presentation points (#291, AF-4; mandatory since AF-6): a write is
 * stored at once and enters each reader's window at that
 * reader's points (its turn's start, its tool boundary as a prefix its
 * stream can carry, its turn's end, and at once while no turn of it is
 * alive); an agent's own rows enter as they are written, but for one written
 * where a turn it isn't part of may be alive, which waits; a surgery's hold
 * keeps writes in memory and replays them at its release; a quiesce freezes
 * every window but for each agent's own rows; an undo takes a turn out of
 * the agent's window and a redo puts it back, moving no branch.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager as StoreWindow, PassthroughStrategy, type ContextManager, type MessageId, type MessageMetadata, type StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, OperatorActionError, audienceOf } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { residentContextOptions } from '../src/context-options.js';
import { storeOwnRow } from '../src/dendrite/audience.js';
import { GateModule, until } from './helpers/dendrite.js';
import { WireMembrane, final, round } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) => row.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

/** A surface's module: an `external-message` event's text becomes a message, read by the agents its metadata names. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata: { ask: string[] } };
    return { addMessages: [{ participant: 'user', content }], requestInference: metadata.ask };
  }
}
const input = (t: string, ask: string[]): ProcessEvent =>
  ({ type: 'external-message', source: 'test', content: [text(t)], metadata: { ask } }) as unknown as ProcessEvent;

type Placement = { agent?: string; messageId?: string; presented?: false };
type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string; placement?: Placement }): MessageId;
  readsRowFor(placement: Placement | undefined, agentName: string): { readsRow?: string };
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
  storeInFork(target: Agent, content: ContentBlock[], metadata: MessageMetadata): MessageId;
  surgeryHeldWrites: unknown[];
  storeDueClock(agent: Agent, occasion: 'event' | 'turn-start' | 'tool-boundary'): { id: MessageId } | undefined;
  placeWakeLines(agent: Agent, lines: unknown[]): void;
  sweepExpiredConversations(): void;
  conversationRouter: unknown;
  lastConversationSweep: number;
  closingConversationAgents: Set<string>;
  pendingRequests: unknown[];
  activeTurnTokens: Map<string, number>;
  presentAtEndOf(agent: Agent | undefined): void;
  noteArrival(agentName: string, metadata: MessageMetadata | undefined, messageId: MessageId): void;
  getTurnCheckpoints(agentName: string): Array<{ indexLengthBefore?: number; windowBranch?: string; sequenceBefore: number }>;
  saveTurnCheckpoints(agentName: string, checkpoints: unknown[]): void;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { residents?: string[]; clock?: boolean | { intervalSeconds: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-presentation-points-'));
  dirs.push(dir);
  const membrane = new WireMembrane();
  const gates = new GateModule();
  const surface = new SurfaceModule();
  const residents = opts.residents ?? ['mira'];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: residents.map((name, i) => ({
      name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled',
      // One clock a day, so a window takes one at its first event only,
      // unless the case asks for a finer one.
      ...(i === 0 && opts.clock ? { clock: opts.clock === true ? { intervalMinutes: 1440 } : opts.clock } : {}),
    })),
    modules: [gates, surface],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  } as never);
  frameworks.push(framework);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  const internals = framework as unknown as Internals;
  const agent = (name: string) => framework.getAgent(name)!;
  const cm = (name: string): ContextManager => agent(name).getContextManager();
  const rowWith = (name: string, t: string): StoredMessage | undefined => cm(name).getAllMessages().find((m) => textOf(m) === t);
  const inWindow = (name: string, t: string) => { const row = rowWith(name, t); return !!row && cm(name).ordinalOf(row.id) !== undefined; };
  const windowTexts = (name: string) => cm(name).getPresentedMessages().map((m) => textOf(m) || m.content.map((b) => b.type).join('+'));
  return { framework, membrane, gates, surface, internals, traces, agent, cm, rowWith, inWindow, windowTexts };
}

describe('presentation points (#291)', () => {
  it("a write during a live turn is stored at once, out of the window and with no clock; its boundary hears it, and a row it cuts enters at the turn's end", async () => {
    const h = await boot({ clock: true });
    h.membrane.script('mira', round('c1', [text('looking')], 'wait', { gate: 'm' }), final([text('done')]));
    h.framework.start();
    h.framework.pushEvent(input('go', ['mira']));
    await until(() => h.gates.entered.has('m'), "mira's round waiting on its tool");
    const clocks = () => h.cm('mira').getAllMessages().filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'clock').length;
    const clocksBefore = clocks();
    const placement: Placement = {};
    const heard = h.internals.addMessage('user', [text('heard at the boundary')], undefined, { forAgent: 'mira', placement });
    const named = h.internals.addMessage('mira', [text('named as mira')], undefined, { forAgent: 'mira' });
    assert.ok(heard && named, 'both stored at once, though her turn is alive');
    assert.ok(h.cm('mira').getMessage(heard) && h.cm('mira').getMessage(named), 'in the record');
    assert.deepEqual([h.inWindow('mira', 'heard at the boundary'), h.inWindow('mira', 'named as mira')], [false, false], 'out of her window');
    assert.deepEqual(placement, { agent: 'mira', messageId: heard, presented: false }, 'placed as stored and not presented to her');
    assert.deepEqual(h.internals.readsRowFor(placement, 'mira'), { readsRow: heard }, 'so a wake for it reads it');
    assert.equal(clocks(), clocksBefore, 'a write stored during a turn takes no clock: it would sit inside the turn');

    h.gates.release('m');
    await h.framework.runUntilIdle();
    const injected = h.membrane.streams[0]!.stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
    assert.deepEqual(injected.map((m) => textOf(m as { content: ContentBlock[] })), ['heard at the boundary'], 'the boundary injects what its stream can carry');
    const window = h.windowTexts('mira');
    assert.deepEqual(window.slice(window.indexOf('looking')), ['looking', 'tool_result', 'heard at the boundary', 'done', 'named as mira'],
      "the window as the stream carried it, and the row it cut after the turn's last reply");
    const record = h.cm('mira').getAllMessages().map((m) => textOf(m));
    assert.ok(record.indexOf('named as mira') < record.indexOf('looking'), 'the record keeps the order the rows were stored in');
    assert.deepEqual(h.traces.filter((e) => e.type === 'presentation:hand-off-mismatch'), [], 'the boundary handed its stream the rows its window took');
  });

  // AF-A-3: between a budget restart's release of its turn token and the
  // continuation's next round, the index counts the turn alive (hasTurn), and
  // so does addMessage now: the write takes no clock and is placed as not
  // presented, where it took a clock presented mid-turn ahead of a write that
  // waited for the turn's end.
  it("a write in a continuation's gap (a budget restart queued, no token held) is stored out of the window with no clock, placed as not presented", async () => {
    const h = await boot({ clock: true });
    // Not started, so the queue isn't drained: a budget restart's continuation, as driveStream queues it.
    h.internals.pendingRequests.push({ agentName: 'mira', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
    assert.equal(h.internals.activeTurnTokens.has('mira'), false, 'setup: no token held');
    const clocks = () => h.cm('mira').getAllMessages().filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'clock').length;
    const clocksBefore = clocks();
    const placement: Placement = {};
    const id = h.internals.addMessage('alice', [text('a message during the restart')], undefined, { forAgent: 'mira', placement });
    assert.equal(clocks(), clocksBefore, 'no clock row: it would sit inside the turn its continuation goes on with');
    assert.equal(h.cm('mira').windowStatusOf(id), 'out', 'out of her window');
    assert.deepEqual(placement, { agent: 'mira', messageId: id, presented: false });
    h.internals.pendingRequests.length = 0;
    h.internals.presentAtEndOf(h.agent('mira'));
    assert.equal(h.inWindow('mira', 'a message during the restart'), true, "the turn's end presents it");
  });

  // A boundary that threw into its handler left the stream unresumed, and
  // the turn hung: the timeout fails it fast.
  it("a tool boundary whose read of the record throws hears nothing, and the turn goes on to its answer; the row waits for the turn's end", { timeout: 60_000 }, async () => {
    const h = await boot();
    h.membrane.script('mira', round('c1', [text('looking')], 'wait', { gate: 'm' }), final([text('done')]));
    h.framework.start();
    h.framework.pushEvent(input('go', ['mira']));
    await until(() => h.gates.entered.has('m'), "mira's round waiting on its tool");
    h.internals.addMessage('user', [text('would be heard')], undefined, { forAgent: 'mira' });
    // The boundary's read of what mira is owed (getUnpresentedMessages)
    // fails once, as a store read error would.
    const cm = h.cm('mira') as unknown as { getUnpresentedMessages: (...args: unknown[]) => unknown };
    const real = cm.getUnpresentedMessages.bind(cm);
    let armed = true;
    cm.getUnpresentedMessages = (...args: unknown[]) => {
      if (armed) { armed = false; throw new Error('the store could not be read'); }
      return real(...args);
    };
    const error = console.error;
    console.error = () => {};
    try {
      h.gates.release('m');
      await h.framework.runUntilIdle();
    } finally {
      console.error = error;
      delete (cm as { getUnpresentedMessages?: unknown }).getUnpresentedMessages;
    }
    assert.equal(armed, false, 'the read failed');
    const stream = h.membrane.streams[0]!.stream;
    assert.equal(stream.receivedToolResults.length, 1, 'the stream was handed its results');
    assert.deepEqual(stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []), [], 'and heard nothing with them');
    assert.ok(h.traces.some((e) => e.type === 'presentation:failed' && (e as { occasion?: string }).occasion === 'tool-boundary'),
      'the failure is traced');
    assert.ok(h.traces.some((e) => e.type === 'inference:completed' && (e as { agentName?: string }).agentName === 'mira'), 'the turn completed');
    const window = h.windowTexts('mira');
    assert.deepEqual(window.slice(window.indexOf('looking')), ['looking', 'tool_result', 'done', 'would be heard'],
      "the answer after its results, and the row at the turn's end");
  });

  it("a write stored during a turn takes no clock that is due; the turn's tool boundary takes it, ahead of what it hears", async () => {
    const h = await boot({ clock: { intervalSeconds: 1 } });
    h.membrane.script('mira', round('c1', [text('looking')], 'wait', { gate: 'm' }), final([text('done')]));
    h.framework.start();
    h.framework.pushEvent(input('go', ['mira']));
    await until(() => h.gates.entered.has('m'), "mira's round waiting on its tool");
    const isClock = (m: { metadata?: unknown }) => (m.metadata as { kind?: string } | undefined)?.kind === 'clock';
    const clocks = () => h.cm('mira').getAllMessages().filter(isClock).length;
    const before = clocks();
    // Past the next boundary, so a clock is due.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    h.internals.addMessage('user', [text('arrived')], undefined, { forAgent: 'mira' });
    assert.equal(clocks(), before, 'none written inside the turn');
    h.gates.release('m');
    await h.framework.runUntilIdle();
    const injected = h.membrane.streams[0]!.stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
    assert.equal(injected.length, 2, 'the boundary injects the clock and the row');
    assert.match(textOf(injected[0] as { content: ContentBlock[] }), /\d/, 'the clock first');
    assert.equal(textOf(injected[1] as { content: ContentBlock[] }), 'arrived');
    const window = h.cm('mira').getPresentedMessages();
    const at = window.findIndex((m) => textOf(m) === 'arrived');
    assert.ok(isClock(window[at - 1]!), 'in the window, the clock just before it');
    assert.deepEqual(h.traces.filter((e) => e.type === 'presentation:hand-off-mismatch'), [], 'and handed over in that order');
  });

  it("a row written past the framework enters the window at the agent's next turn start, which its request carries", async () => {
    const h = await boot();
    // A host's writer that stores into the context itself (connectome-host's
    // notices until HOST-1): unstamped, so it's for the slot's owners, and
    // no write through the framework presents it at once.
    h.cm('mira').addMessage('user', [text('a host wrote this')]);
    assert.equal(h.inWindow('mira', 'a host wrote this'), false);
    h.membrane.script('mira', final([text('read it')]));
    h.framework.start();
    h.internals.pendingRequests.push({ agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now() });
    await until(() => h.inWindow('mira', 'read it'), 'the turn');
    await h.framework.runUntilIdle();
    assert.ok(JSON.stringify(h.membrane.calls[0]!.messages).includes('a host wrote this'), 'its request carries it');
    assert.deepEqual(h.windowTexts('mira'), ['a host wrote this', 'read it']);
    assert.ok(h.traces.some((e) => e.type === 'presentation:presented' && (e as { occasion: string; unstamped?: number }).occasion === 'turn-start'
      && (e as { unstamped?: number }).unstamped === 1), 'presented at the start, traced as unstamped');
  });

  it('a write while no turn is alive enters every idle reader\'s window at once', async () => {
    const on = await boot({ residents: ['mira', 'oren'] });
    const placement: Placement = {};
    const id = on.internals.addMessage('someone', [text('for both')], undefined, { placement });
    assert.deepEqual(audienceOf(on.cm('mira').getMessage(id)!.metadata)?.audience, ['mira', 'oren']);
    assert.deepEqual([on.inWindow('mira', 'for both'), on.inWindow('oren', 'for both')], [true, true], 'present at rest, for each reader');
    assert.equal(placement.presented, undefined, 'presented: no wake needs to read it');
  });

  it("each row of another writer's that enters a window outside a tool boundary is weighed once, as its open turn's arrival", async () => {
    const h = await boot();
    const noted: string[] = [];
    h.internals.noteArrival = (name, _metadata, id) => { noted.push(`${name}: ${textOf(h.cm(name).getMessage(id)!)}`); };
    h.internals.addMessage('user', [text('at rest')], undefined, { forAgent: 'mira' });
    assert.deepEqual(noted, ['mira: at rest'], 'presented at its write, and weighed then');
    h.membrane.script('mira', round('c1', [text('looking')], 'wait', { gate: 'm' }), final([text('done')]));
    h.framework.start();
    h.framework.pushEvent(input('go', ['mira']));
    await until(() => h.gates.entered.has('m'), "mira's round waiting on its tool");
    h.internals.addMessage('user', [text('heard')], undefined, { forAgent: 'mira' });
    h.internals.addMessage('mira', [text('cut at the boundary')], undefined, { forAgent: 'mira' });
    assert.deepEqual(noted, ['mira: at rest', 'mira: go'], 'stored during the turn: not weighed yet');
    h.gates.release('m');
    await h.framework.runUntilIdle();
    assert.deepEqual(noted, ['mira: at rest', 'mira: go', 'mira: cut at the boundary'],
      "the boundary weighs what it hears itself; what its end presents is weighed there; her own rows never");
  });

  it("a channel message stored in a fork's store enters its window at once while it's idle, else at its turn's next point", async () => {
    const h = await boot();
    const mira = h.agent('mira');
    h.internals.storeInFork(mira, [text('while idle')], {});
    assert.equal(h.inWindow('mira', 'while idle'), true);
    h.internals.activeTurnTokens.set('mira', 12);
    h.internals.storeInFork(mira, [text('during a turn')], {});
    assert.equal(h.inWindow('mira', 'during a turn'), false);
    assert.deepEqual(audienceOf(h.rowWith('mira', 'during a turn')!.metadata)?.audience, ['mira'], 'for the fork alone');
    h.internals.activeTurnTokens.delete('mira');
    h.internals.presentAtEndOf(mira);
    assert.equal(h.inWindow('mira', 'during a turn'), true);
  });

  it("a turn's end is its logical turn's: a frame whose continuation is on its way presents nothing, and the turn's last end does", async () => {
    const h = await boot();
    // A budget restart's continuation, queued as the old frame ends.
    const continuation = { agentName: 'mira', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() };
    h.internals.pendingRequests.push(continuation);
    try {
      h.internals.addMessage('user', [text('arrived between frames')], undefined, { forAgent: 'mira' });
      assert.equal(h.inWindow('mira', 'arrived between frames'), false, 'not presented at rest: the turn is alive');
      h.internals.presentAtEndOf(h.agent('mira'));
      assert.equal(h.inWindow('mira', 'arrived between frames'), false, "the old frame's end presents nothing");
    } finally {
      h.internals.pendingRequests.length = 0;
    }
    h.internals.presentAtEndOf(h.agent('mira'));
    assert.equal(h.inWindow('mira', 'arrived between frames'), true, "the logical turn's end presents it");
  });

  // puppet-tool-call.test.ts's two cases of this, ported from the deferral
  // queue's, were its twins once AF-6 made presentation mandatory; their
  // checks are here.
  it("a message arriving while the puppet holds the agent enters the window after the pair; a pair a turn replaced waits for that turn's end", async () => {
    const h = await boot();
    const quiet = console.log;
    console.log = () => {};
    try {
      const puppet = h.framework.puppetToolCall('mira', 'test--wait', { gate: 'p' });
      await until(() => h.gates.entered.has('p'), 'the puppet call waiting');
      const arrived = h.internals.addMessage('user', [text('hey, you there?')], undefined, { forAgent: 'mira' });
      assert.ok(arrived && h.cm('mira').getMessage(arrived), 'stored at once, and answered by its stored id');
      assert.equal(h.inWindow('mira', 'hey, you there?'), false, 'stored, and out of the window while the puppet holds the agent');
      h.gates.release('p');
      await puppet;
      assert.deepEqual(h.windowTexts('mira').slice(-3), ['tool_use', 'tool_result', 'hey, you there?'], 'the pair first and adjacent; the message after');
      const record = h.cm('mira').getAllMessages().map((m) => textOf(m) || m.content[0]!.type);
      assert.ok(record.indexOf('hey, you there?') < record.indexOf('tool_use'), 'the record has the message first');

      h.gates.entered.clear();
      const replaced = h.framework.puppetToolCall('mira', 'test--wait', { gate: 'q' });
      await until(() => h.gates.entered.has('q'), 'the second puppet call waiting');
      // The provider-admission re-entry: a turn takes the reservation.
      h.internals.activeTurnTokens.set('mira', 9999);
      h.gates.release('q');
      await replaced;
      assert.equal(h.internals.activeTurnTokens.get('mira'), 9999, "the turn's token is not clobbered");
      const cm = h.cm('mira');
      const pair = cm.getAllMessages().slice(-2);
      assert.deepEqual(pair.map((m) => m.content[0]!.type), ['tool_use', 'tool_result'], 'stored now, back to back');
      assert.deepEqual(pair.map((m) => cm.ordinalOf(m.id)), [undefined, undefined], "kept out of the replacing turn's window");
      h.internals.activeTurnTokens.delete('mira');
      h.internals.presentAtEndOf(h.agent('mira'));
      const [use, result] = pair.map((m) => cm.ordinalOf(m.id)!);
      assert.equal(result, use! + 1, "the replacing turn's end presents the pair, adjacent");
    } finally {
      console.log = quiet;
    }
  });

  it("a surgery's hold keeps writes out of every store, and its release replays them in arrival order to the idle readers", async () => {
    const h = await boot({ residents: ['mira', 'oren'] });
    const before = h.cm('mira').getAllMessages().length;
    const release = h.internals.reserveStoreForSurgery('test-surgery', 'mira');
    assert.equal(h.internals.addMessage('user', [text('one')]), '', 'held');
    assert.equal(h.internals.addMessage('user', [text('two')], undefined, { forAgent: 'oren' }), '', 'held');
    assert.equal(h.internals.storeInFork(h.agent('mira'), [text('three')], {}), '', "a write into a fork's store is held too");
    assert.equal(h.cm('mira').getAllMessages().length, before, 'no store has them');
    assert.equal(h.internals.surgeryHeldWrites.length, 3);
    release();
    assert.equal(h.internals.surgeryHeldWrites.length, 0);
    const landed = h.cm('mira').getAllMessages().slice(before);
    assert.deepEqual(landed.map((m) => textOf(m)), ['one', 'two', 'three'], 'in the order they arrived');
    assert.ok(landed.every((m) => !(m.metadata && 'deferredWriteId' in m.metadata)), 'never queued, so no durable queue id');
    assert.deepEqual(['one', 'two', 'three'].map((t) => h.inWindow('mira', t)), [true, false, true], "in mira's window: what's for her");
    assert.deepEqual(['one', 'two', 'three'].map((t) => h.inWindow('oren', t)), [true, true, false], "in oren's: what's for him");
  });

  it('a quiesce freezes the windows: a write is stored and not presented, a draining turn\'s boundary hears nothing, and resume presents both', async () => {
    const h = await boot();
    h.membrane.script('mira', round('c1', [text('looking')], 'wait', { gate: 'm' }), final([text('done')]));
    h.framework.start();
    h.framework.pushEvent(input('go', ['mira']));
    await until(() => h.gates.entered.has('m'), "mira's round waiting on its tool");
    h.internals.addMessage('user', [text('arrived mid-turn')], undefined, { forAgent: 'mira' });
    const quiesced = h.framework.quiesce({ reason: 'test' });
    await until(() => h.framework.getHostModeStatus().quiesced, 'the host quiesced');
    h.internals.addMessage('user', [text('arrived while quiesced')], undefined, { forAgent: 'mira' });
    h.gates.release('m');
    await quiesced;
    const injected = h.membrane.streams[0]!.stream.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
    assert.deepEqual(injected, [], "the draining turn's boundary injects nothing while quiesced");
    assert.deepEqual([h.inWindow('mira', 'arrived mid-turn'), h.inWindow('mira', 'arrived while quiesced')], [false, false], 'stored, not presented');
    assert.ok(h.rowWith('mira', 'arrived while quiesced'), 'in the record');
    assert.ok(h.inWindow('mira', 'done'), "the draining turn's own rows are presented");
    await h.framework.resume();
    assert.deepEqual(h.windowTexts('mira').slice(-2), ['arrived mid-turn', 'arrived while quiesced'], 'resume presents them, in the order they were stored');
  });

  it('an undo takes the turn out of the window and moves no branch; a redo puts it back after taking out what was presented since', async () => {
    const h = await boot();
    h.membrane.script('mira', final([text('one')]));
    h.membrane.script('mira', round('c2', [text('looking')], 'wait', { gate: 'u' }), final([text('two')]));
    h.framework.start();
    h.framework.pushEvent(input('first', ['mira']));
    await until(() => h.inWindow('mira', 'one'), 'the first turn');
    await h.framework.runUntilIdle();
    h.framework.pushEvent(input('second', ['mira']));
    await until(() => h.gates.entered.has('u'), 'the second turn waiting on its tool');
    h.internals.addMessage('someone', [text('from someone')], undefined, { forAgent: 'mira' });
    h.gates.release('u');
    await until(() => h.inWindow('mira', 'two'), 'the second turn');
    await h.framework.runUntilIdle();
    const cm = h.cm('mira');
    const checkpoint = h.internals.getTurnCheckpoints('mira').at(-1)!;
    assert.equal(checkpoint.windowBranch, cm.currentBranch().name, 'the checkpoint names the window it measured');
    assert.equal(checkpoint.indexLengthBefore, cm.ordinalOf(h.rowWith('mira', 'looking')!.id), "it is where the turn's first row of its own entered");
    assert.deepEqual(h.windowTexts('mira'), ['first', 'one', 'second', 'looking', 'tool_result', 'from someone', 'two']);

    h.internals.activeTurnTokens.set('mira', 4242);
    assert.throws(() => h.framework.undoLastTurn('mira'), (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy', 'refused while a turn is alive');
    h.internals.activeTurnTokens.delete('mira');

    const branches = h.framework.getStore().listBranches().length;
    const undone = h.framework.undoLastTurn('mira');
    assert.deepEqual(undone, { undone: true, turnIndex: 1, fromBranch: cm.currentBranch().name, toBranch: cm.currentBranch().name, window: { retracted: 4, represented: 0 } });
    assert.equal(h.framework.getStore().listBranches().length, branches, 'no branch was made');
    assert.deepEqual(h.windowTexts('mira'), ['first', 'one', 'second'], 'the turn left the window');
    assert.deepEqual(['looking', 'two', 'from someone'].map((t) => cm.windowStatusOf(h.rowWith('mira', t)!.id)), ['undone', 'undone', 'out'],
      "her own rows as undone, another's as arrived and not presented");
    const compiled = (await cm.compile(undefined, undefined, { dryRun: true })).messages.map((m) => textOf(m as { content: ContentBlock[] }));
    assert.ok(!compiled.includes('two') && !compiled.includes('looking'), 'and the next compile');
    assert.ok(cm.getAllMessages().some((m) => textOf(m) === 'two'), 'the record keeps them');
    assert.deepEqual(h.traces.filter((t) => t.type === 'window:undone').map((t) => [(t as { retracted: number }).retracted]), [[4]]);

    // A write since: at rest, it and the arrival the undo gave back enter the window.
    h.internals.addMessage('user', [text('after the undo')], undefined, { forAgent: 'mira' });
    assert.deepEqual(h.windowTexts('mira'), ['first', 'one', 'second', 'from someone', 'after the undo']);

    const redone = h.framework.redo('mira');
    assert.deepEqual(redone.window, { retracted: 2, represented: 4 });
    assert.equal(redone.fromBranch, redone.toBranch);
    assert.deepEqual(h.windowTexts('mira'), ['first', 'one', 'second', 'looking', 'tool_result', 'from someone', 'two'],
      'the turn back where it was, before what was presented since');
    h.internals.presentAtEndOf(h.agent('mira'));
    assert.deepEqual(h.windowTexts('mira').slice(-2), ['two', 'after the undo'], 'which its next point presents after it');
    assert.equal(h.internals.getTurnCheckpoints('mira').length, 2, 'the checkpoint is back');
  });

  it("an arrival an undo gives back enters the window at the agent's next point, though a row written for her is presented before it", async () => {
    const h = await boot({ residents: ['mira', 'oren'] });
    h.membrane.script('mira', final([text('one')]));
    h.membrane.script('mira', round('c2', [text('looking')], 'wait', { gate: 'u' }), final([text('two')]));
    h.framework.start();
    h.framework.pushEvent(input('first', ['mira']));
    await until(() => h.inWindow('mira', 'one'), 'the first turn');
    await h.framework.runUntilIdle();
    h.framework.pushEvent(input('second', ['mira']));
    await until(() => h.gates.entered.has('u'), 'the second turn waiting on its tool');
    h.internals.addMessage('someone', [text('from someone')], undefined, { forAgent: 'mira' });
    h.internals.addMessage('someone', [text('for oren')], undefined, { forAgent: 'oren' });
    h.gates.release('u');
    await until(() => h.inWindow('mira', 'two'), 'the second turn');
    await h.framework.runUntilIdle();
    assert.equal(h.inWindow('mira', 'from someone'), true, 'premise: her turn heard it');
    assert.equal(h.inWindow('mira', 'for oren'), false, "premise: oren's row stays out of her window");

    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    assert.equal(h.cm('mira').windowStatusOf(h.rowWith('mira', 'from someone')!.id), 'out', 'given back as arrived and not presented');

    storeOwnRow(h.agent('mira'), 'user', [text('a notice for mira')]);
    assert.equal(h.inWindow('mira', 'a notice for mira'), true, 'premise: her own row entered as it was written');

    h.internals.addMessage('user', [text('after the undo')], undefined, { forAgent: 'mira' });
    assert.deepEqual(h.windowTexts('mira').slice(-2), ['from someone', 'after the undo'], 'the arrival the undo gave back, then what came since');
  });

  it('an undo converts a checkpoint recorded without the window\'s length', async () => {
    const h = await boot();
    h.membrane.script('mira', final([text('one')]));
    h.membrane.script('mira', final([text('two')]));
    h.framework.start();
    h.framework.pushEvent(input('first', ['mira']));
    await until(() => h.inWindow('mira', 'one'), 'the first turn');
    await h.framework.runUntilIdle();
    h.framework.pushEvent(input('second', ['mira']));
    await until(() => h.inWindow('mira', 'two'), 'the second turn');
    await h.framework.runUntilIdle();
    const checkpoints = h.internals.getTurnCheckpoints('mira');
    const last = checkpoints.at(-1)!;
    delete last.indexLengthBefore;
    delete last.windowBranch;
    h.internals.saveTurnCheckpoints('mira', checkpoints);
    assert.deepEqual(h.framework.undoLastTurn('mira').window, { retracted: 1, represented: 0 });
    assert.deepEqual(h.windowTexts('mira'), ['first', 'one', 'second'], 'from the first row in the window stored after its sequence');
  });

  // AF-A-2: a turn an earlier release recorded carries no audience stamp, and
  // the index reads an unstamped row as an arrival, so an undo that took the
  // turn's rows out as arrived saw them back at the agent's next point. Its
  // own rows (its voice's, and the results of its own calls) leave as undone.
  it("an undo of a turn recorded before the audience stamp takes its own rows out as undone, and no later point brings them back", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-points-'));
    dirs.push(dir);
    const storePath = join(dir, 'store.chronicle');
    let before: number;
    {
      // An earlier release's store: two turns of mira's, the second with a tool round, nothing stamped.
      const store = JsStore.openOrCreate({ path: storePath });
      const cm = await StoreWindow.open({ store, ...residentContextOptions('mira'), strategy: new PassthroughStrategy() });
      cm.addMessage('user', [text('first')]);
      cm.addMessage('mira', [text('one')]);
      cm.addMessage('user', [text('second')]);
      before = store.currentSequence();
      cm.addMessage('mira', [text('looking'), { type: 'tool_use', id: 'old-1', name: 'test--echo', input: {} } as ContentBlock]);
      cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'old-1', content: 'ok' } as ContentBlock]);
      cm.addMessage('mira', [text('two')]);
      cm.close();
      store.close();
    }
    const framework = await AgentFramework.create({
      storePath, membrane: new WireMembrane().asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', allowedTools: 'all', proseRouting: 'disabled' }],
      modules: [], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    frameworks.push(framework);
    const internals = framework as unknown as Internals;
    const cm = framework.getAgent('mira')!.getContextManager();
    const windowTexts = () => cm.getPresentedMessages().map((m) => textOf(m) || m.content.map((b) => b.type).join('+'));
    assert.deepEqual(windowTexts(), ['first', 'one', 'second', 'looking', 'tool_result', 'two'], 'setup: written down at boot');
    // The earlier release's checkpoint for the second turn: no window length.
    internals.saveTurnCheckpoints('mira', [{ agentName: 'mira', turnIndex: 1, sequenceBefore: before, branchName: framework.getStore().currentBranch().name, timestamp: Date.now() }]);
    assert.deepEqual(framework.undoLastTurn('mira').window, { retracted: 3, represented: 0 });
    assert.deepEqual(windowTexts(), ['first', 'one', 'second']);
    const statusOf = (t: string) => cm.windowStatusOf(cm.getAllMessages().find((m) => (textOf(m) || m.content[0]!.type) === t)!.id);
    assert.deepEqual(['looking', 'tool_result', 'two'].map(statusOf), ['undone', 'undone', 'undone'], 'its own rows, the tool result among them');
    // A write for mira while she is idle presents her at rest.
    internals.addMessage('alice', [text('hello again')], undefined, { forAgent: 'mira' });
    assert.deepEqual(windowTexts(), ['first', 'one', 'second', 'hello again'], 'the undone turn stays out');
    internals.presentAtEndOf(framework.getAgent('mira')!);
    assert.deepEqual(windowTexts(), ['first', 'one', 'second', 'hello again']);
    const redone = framework.redo('mira');
    assert.deepEqual(redone.window, { retracted: 1, represented: 3 }, 'a redo puts the turn back');
    assert.deepEqual(windowTexts(), ['first', 'one', 'second', 'looking', 'tool_result', 'two']);
  });

  it("a co-resident's live turn no longer holds an agent's own rows back", async () => {
    // Before #291 a clock would have landed inside oren's turn in the shared
    // record, so none was written while it was alive.
    const h = await boot({ residents: ['mira', 'oren'], clock: true });
    h.internals.activeTurnTokens.set('oren', 7);
    const clock = h.internals.storeDueClock(h.agent('mira'), 'event');
    assert.ok(clock, 'written for mira: her own row, in no window but hers');
    assert.notEqual(h.cm('mira').ordinalOf(clock.id), undefined, 'in her window');
    assert.equal(h.cm('oren').ordinalOf(clock.id), undefined, "never in oren's");
    h.internals.activeTurnTokens.delete('oren');
  });

  it("each resident a batched wake was for writes its own line into its own window, once", async () => {
    const line = { entry: { eventType: 'mcpl:push-event', serverId: 'notes', eventId: 'not-stored' }, policyNames: ['batch'], shown: '#room', at: Date.now() };
    const h = await boot({ residents: ['mira', 'oren'] });
    for (const name of ['mira', 'oren', 'mira', 'oren']) h.internals.placeWakeLines(h.agent(name), [line]);
    const lines = h.cm('mira').getAllMessages().filter((m) => (m.metadata as { source?: string } | undefined)?.source === 'gate:debounce');
    assert.deepEqual(lines.map((m) => audienceOf(m.metadata)?.ownRowOf), ['mira', 'oren'], "one line each, each the resident's own row");
    assert.deepEqual(lines.map((m) => [h.cm('mira').ordinalOf(m.id) !== undefined, h.cm('oren').ordinalOf(m.id) !== undefined]),
      [[true, false], [false, true]], 'each in its own window');
  });

  it('a closure prompt written while the fork\'s turn is alive waits for that turn\'s end', async () => {
    const h = await boot();
    const router = {
      expired: () => [{ channelId: 'chat:room', serverId: 'chat', agentName: 'mira' }],
      unbind: () => {},
      getBinding: () => undefined,
      closurePrompt: 'the conversation is closing',
    };
    h.internals.conversationRouter = router;
    h.internals.lastConversationSweep = 0;
    h.internals.activeTurnTokens.set('mira', 31);
    try {
      h.internals.sweepExpiredConversations();
      assert.ok(h.rowWith('mira', 'the conversation is closing'), 'stored');
      assert.equal(h.inWindow('mira', 'the conversation is closing'), false, 'out of the live turn\'s window');
      h.internals.activeTurnTokens.delete('mira');
      h.internals.presentAtEndOf(h.agent('mira'));
      assert.equal(h.inWindow('mira', 'the conversation is closing'), true, "presented at the turn's end, as its own row");
    } finally {
      h.internals.activeTurnTokens.delete('mira');
      h.internals.conversationRouter = undefined;
      h.internals.closingConversationAgents.clear();
      h.internals.pendingRequests.length = 0;
    }
  });
});
