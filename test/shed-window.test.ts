/**
 * A shed on a presented window (#291, AF-7): the refusal rewind's and the
 * inference-failure quarantine's shed takes the agent's newest exchange out
 * of its own window, as an undone turn's rows leave it, and never touches
 * the record. Before, it removed the newest rows of the record, whoever
 * wrote them: on a residents' host that could be a co-resident's round, or
 * a row the agent was never shown, and it changed every other resident's
 * window and cache prefix with it. Now no other window changes, the
 * refusal marker's "the originals remain in the raw record" is true, and
 * an undone row is in no list a presentation point presents from, so the
 * poison doesn't come back.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type MessageId, type MessageMetadata, type StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, residentContextOptions, storeOwnRow } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { until } from './helpers/dendrite.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const textOf = (row: { content: ContentBlock[] }) => row.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');

/** An `external-message` event's text becomes a message for the agents its metadata names. */
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

type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
  shedNewestTurn(agent: Agent, carried?: ReadonlySet<MessageId>): { descriptor: string; removedIds: MessageId[] } | null;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { residents?: string[]; dir?: string; seed?: (cm: ContextManager) => void; agents?: Record<string, object>; modules?: Module[] } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'af-shed-window-'));
  if (!opts.dir) dirs.push(dir);
  const storePath = join(dir, 'store.chronicle');
  if (opts.seed) {
    // Rows stored before the host's first start, which every resident's
    // window takes in when it is written down at its registration.
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, ...residentContextOptions('mira') });
    opts.seed(cm);
    cm.close();
    store.close();
  }
  const membrane = new WireMembrane();
  const residents = opts.residents ?? ['mira', 'oren'];
  const framework = await AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: residents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled', ...opts.agents?.[name] })),
    modules: [new SurfaceModule(), ...(opts.modules ?? [])],
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
  const windowTexts = (name: string) => cm(name).getPresentedMessages().map((m) => textOf(m) || m.content.map((b) => b.type).join('+'));
  const ordinals = (name: string) => new Map(cm(name).getPresentedMessages().map((m) => [m.id, cm(name).ordinalOf(m.id)]));
  const compiled = async (name: string) => JSON.stringify((await cm(name).compile(undefined, undefined, { dryRun: true })).messages);
  return { dir, framework, membrane, internals, traces, agent, cm, rowWith, windowTexts, ordinals, compiled };
}

describe('a shed on a presented window (#291, AF-7)', () => {
  it("takes mira's newest exchange out of her window as an undone turn's, and leaves the record, and oren's window and compile, as they were", async () => {
    const h = await boot();
    h.internals.addMessage('someone', [text('zz-hello')]);
    const call = storeOwnRow(h.agent('mira'), 'mira', [text('calling'), { type: 'tool_use', id: 't1', name: 'shell', input: {} } as ContentBlock]);
    const result = storeOwnRow(h.agent('mira'), 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock]);
    // The record's newest row is oren's own round, which mira was never shown.
    const orens = storeOwnRow(h.agent('oren'), 'oren', [text('oren speaks')]);
    assert.deepEqual(h.windowTexts('mira'), ['zz-hello', 'calling', 'tool_result']);
    assert.equal(h.cm('mira').ordinalOf(orens), undefined);
    const stored = h.cm('mira').getMessageCount();
    const orenOrdinals = h.ordinals('oren');
    const orenCompiled = await h.compiled('oren');

    const record = h.internals.shedNewestTurn(h.agent('mira'));
    assert.ok(record);
    assert.equal(record.descriptor, 'a tool exchange (~1KB)');
    assert.deepEqual(record.removedIds, [result, call], "mira's exchange, not oren's newer round");
    assert.deepEqual([call, result].map((id) => h.cm('mira').windowStatusOf(id)), ['undone', 'undone']);
    assert.deepEqual(h.windowTexts('mira'), ['zz-hello']);
    assert.ok(!h.cm('mira').getUnpresentedMessages().some((m) => m.id === call || m.id === result), 'no presentation point brings them back');
    assert.ok(!(await h.compiled('mira')).includes('calling'), "and mira's next compile leaves them out");
    assert.equal(h.cm('mira').getMessageCount(), stored, 'the record keeps every row');
    assert.ok(h.cm('oren').getMessage(orens), "oren's round with it");
    assert.deepEqual(h.ordinals('oren'), orenOrdinals, "oren's window is as it was");
    assert.equal(await h.compiled('oren'), orenCompiled, "and so is oren's compile");
    const traced = h.traces.filter((t) => t.type === 'presentation:retracted') as Array<{ agentName: string; messageIds: string[]; reason: string }>;
    assert.deepEqual(traced.map((t) => [t.agentName, t.messageIds, t.reason]), [['mira', [call, result], 'shed']]);
  });

  it("a row shown to both residents leaves the shedding resident's window only", async () => {
    const h = await boot();
    const row = h.internals.addMessage('someone', [text('zz-poison')]);
    assert.ok(h.cm('mira').ordinalOf(row) !== undefined && h.cm('oren').ordinalOf(row) !== undefined, 'presented to both');
    const orenOrdinal = h.cm('oren').ordinalOf(row);
    const record = h.internals.shedNewestTurn(h.agent('mira'));
    assert.deepEqual(record?.removedIds, [row]);
    assert.equal(record?.descriptor, 'a someone turn (9 chars)');
    assert.equal(h.cm('mira').windowStatusOf(row), 'undone');
    assert.equal(h.cm('oren').ordinalOf(row), orenOrdinal, "oren keeps it where it was");
    assert.ok(h.cm('mira').getMessage(row), 'the record keeps it');
  });

  it('passes over a system change, and a row a tune-out holds from residents, which the window took in at its write-down', async () => {
    let held!: MessageId;
    let before!: MessageId;
    const h = await boot({
      seed: (cm) => {
        before = cm.addMessage('someone', [text('zz-before')]);
        held = cm.addMessage('someone', [text('zz-held')], { tuneOut: { epochId: 'e1' } } as MessageMetadata);
      },
    });
    assert.equal(h.cm('mira').windowStatusOf(held), 'in', "the write-down took the held row into mira's window, which her view leaves out");
    const change = h.cm('mira').addMessage('host', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock]);
    h.cm('mira').presentRows([change]);
    assert.deepEqual(h.windowTexts('mira').slice(-3), ['zz-before', 'zz-held', 'system_change']);

    const record = h.internals.shedNewestTurn(h.agent('mira'));
    assert.deepEqual(record?.removedIds, [before], "the newest row mira is sent, past the change and the held row");
    assert.deepEqual([change, held, before].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in', 'undone']);
  });

  it('a shed row stays out of the window across an undo and a redo of an earlier turn, and across a restart', async () => {
    const h = await boot({ residents: ['mira'] });
    h.membrane.script('mira', final([text('one')]));
    h.framework.start();
    h.framework.pushEvent(input('first', ['mira']));
    await until(() => h.windowTexts('mira').includes('one'), 'the first turn');
    await h.framework.runUntilIdle();
    const poison = h.internals.addMessage('someone', [text('zz-poison')], undefined, { forAgent: 'mira' });
    assert.notEqual(h.cm('mira').ordinalOf(poison), undefined, 'presented at rest');
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [poison]);

    assert.equal(h.framework.undoLastTurn('mira').undone, true);
    assert.equal(h.cm('mira').windowStatusOf(poison), 'undone');
    assert.equal(h.framework.redo('mira').redone, true);
    assert.deepEqual(h.windowTexts('mira'), ['first', 'one'], 'the redo puts back its own turn only');
    assert.equal(h.cm('mira').windowStatusOf(poison), 'undone');

    await h.framework.stop();
    frameworks.pop();
    const again = await boot({ residents: ['mira'], dir: h.dir });
    assert.equal(again.cm('mira').windowStatusOf(poison), 'undone', "a restart's repair and rest don't present it");
    assert.deepEqual(again.windowTexts('mira'), ['first', 'one']);
    assert.ok(again.cm('mira').getMessage(poison), 'the record still holds it');
  });
});

// #737: a system notice between a call and its result split the exchange,
// so the shed took the result alone and left the call for membrane to answer
// with a synthesized `[pending]` result on the next request.
for (const gap of [false, true]) {
  it(`rewinds the complete ID-matched exchange on the next wire request (notice gap: ${gap})`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    // The call and result as production stores them: mira's own rows.
    const call = storeOwnRow(h.agent('mira'), 'mira', [
      { type: 'thinking', thinking: '', signature: 'exchange-signature' } as ContentBlock,
      text('exchange-narration'),
      { type: 'tool_use', id: 'exchange-call', name: 'shell', input: {} } as ContentBlock,
    ]);
    if (gap) h.internals.addMessage('user', [text('intervening-notice')], { system: true });
    const result = storeOwnRow(h.agent('mira'), 'user', [
      { type: 'tool_result', toolUseId: 'exchange-call', content: 'exchange-result' } as ContentBlock,
    ]);
    const other = await h.compiled('oren');
    h.internals.shedNewestTurn(h.agent('mira'));
    h.framework.start();
    h.framework.pushEvent(input('next-question', ['mira']));
    await until(() => h.membrane.callsFor('mira').length === 1, 'next request');
    const sent = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
    assert.doesNotMatch(sent, /exchange-call|exchange-result|exchange-signature|exchange-narration/);
    assert.match(sent, /keep-before/);
    assert.match(sent, /next-question/);
    assert.equal(await h.compiled('oren'), other);
    assert.ok(h.cm('mira').getMessage(call));
    assert.ok(h.cm('mira').getMessage(result));
    if (gap) assert.match(sent, /intervening-notice/, 'the notice stays in the window');
  });
}

const callBlock = (id: string) => ({ type: 'tool_use', id, name: 'shell', input: {} }) as ContentBlock;
const resultBlock = (id?: string, content = 'result-payload') =>
  ({ type: 'tool_result', ...(id === undefined ? {} : { toolUseId: id }), content }) as ContentBlock;
const watchRetracts = (h: Awaited<ReturnType<typeof boot>>) => {
  const cm = h.cm('mira');
  const retracts: Array<[MessageId[], unknown]> = [];
  const removals: Array<[MessageId, MessageId]> = [];
  const retract = cm.retractRows.bind(cm);
  const remove = cm.removeMessages.bind(cm);
  const removeOne = cm.removeMessage.bind(cm);
  cm.retractRows = (ids, opts) => { retracts.push([[...ids], opts]); return retract(ids, opts); };
  cm.removeMessages = (a, b) => { removals.push([a, b]); return remove(a, b); };
  // A single row outside any body is removed by removeMessage
  // (removeStoredMessages), so watch that too.
  cm.removeMessage = (id) => { removals.push([id, id]); return removeOne(id); };
  return { retracts, removals };
};

// A plain notice, then a system-marked row holding a host change
// (system_change): every row between is a system row, so only the host
// change keeps the pair from being proven. The plain notice before it is
// what lets the store take the change after an unanswered call.
function hostChange(h: Awaited<ReturnType<typeof boot>>): MessageId {
  h.internals.addMessage('user', [text('notice')], { system: true });
  const id = h.internals.addMessage('user', [{ type: 'system_change', addSystem: ['Use metric units.'] } as unknown as ContentBlock], { system: true });
  if (h.cm('mira').ordinalOf(id) === undefined) h.cm('mira').presentRows([id]);
  assert.equal(h.cm('mira').windowStatusOf(id), 'in', "the premise: mira's window holds the host change");
  return id;
}

describe('a presented-window shed pairs a result with its call across system notices only when proven (#737)', () => {
  it('retracts the call and result in one retractRows, past several notices, and keeps the notices', async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('a'), callBlock('b')]);
    const n1 = h.internals.addMessage('user', [text('notice-one')], { system: true });
    const n2 = h.internals.addMessage('user', [text('notice-two')], { system: true });
    const result = storeOwnRow(h.agent('mira'), 'user', [resultBlock('b'), resultBlock('a')]);
    const oren = await h.compiled('oren');
    const { retracts, removals } = watchRetracts(h);
    const rec = h.internals.shedNewestTurn(h.agent('mira'));
    assert.deepEqual(rec?.removedIds, [result, call], 'the exchange only, newest first');
    assert.equal(rec?.descriptor, 'a tool exchange (~1KB)');
    assert.deepEqual(retracts, [[[call, result], { undone: true }]], 'one retract, each body by its head, no notice');
    assert.deepEqual(removals, [], 'nothing removed from the record');
    assert.deepEqual([call, result].map((id) => h.cm('mira').windowStatusOf(id)), ['undone', 'undone']);
    assert.deepEqual([n1, n2].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in']);
    assert.equal(await h.compiled('oren'), oren, "oren's window is as it was");
    const traced = h.traces.filter((t) => t.type === 'presentation:retracted') as Array<{ messageIds: string[] }>;
    assert.deepEqual(traced.map((t) => t.messageIds), [[call, result]]);
  });

  it('a newer notice is passed over, and the exchange before it goes whole across the notice between', async () => {
    const h = await boot();
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('a')]);
    const between = h.internals.addMessage('user', [text('notice-between')], { system: true });
    const result = storeOwnRow(h.agent('mira'), 'user', [resultBlock('a')]);
    const notice = h.internals.addMessage('user', [text('newer-notice')], { system: true });
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result, call]);
    assert.deepEqual([between, notice].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in']);
  });

  for (const stamped of [true, false]) {
    it(`a held result of a carried call goes with it across a notice only when stamped; an unrelated held result is not mistaken for one (stamped: ${stamped})`, async () => {
      const h = await boot();
      // Rows put in the window directly; the results are held, and left out
      // by the view. Stamped, as mira's own rows; unstamped, as a
      // write-down takes in rows stored before stamps, whose writer is
      // unknown: those prove no pair across the notice, so the carried call
      // is shed alone, as on main, and the held result stays.
      const store = (h.cm('mira') as unknown as { messageStore: { append: (...args: unknown[]) => { id: MessageId } } }).messageStore;
      const own = (meta: object = {}) => (stamped ? { ...meta, audience: ['mira'], ownRowOf: 'mira' } : meta);
      const call = store.append('mira', [callBlock('a')], own()).id;
      h.cm('mira').presentRows([call]);
      const notice = h.internals.addMessage('user', [text('notice')], { system: true });
      const held = store.append('user', [resultBlock('a')], own({ tuneOut: { epochId: 'held' } })).id;
      const stray = store.append('user', [resultBlock('unrelated')], own({ tuneOut: { epochId: 'held' } })).id;
      h.cm('mira').presentRows([held]);
      h.cm('mira').presentRows([stray]);
      assert.ok(!(await h.compiled('mira')).includes('result-payload'), 'the premise: the view leaves both out');
      const rec = h.internals.shedNewestTurn(h.agent('mira'), new Set([call]));
      assert.deepEqual(rec?.removedIds, stamped ? [held, call] : [call]);
      assert.deepEqual([notice, stray].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in']);
      if (!stamped) assert.equal(h.cm('mira').windowStatusOf(held), 'in');
    });
  }

  it('a notice the agent is not sent is passed over too: a held notice, and a stored reasoning-loss row', async () => {
    const own = { audience: ['mira'], ownRowOf: 'mira' } as MessageMetadata;
    const h = await boot({ seed(cm) {
      cm.addMessage('mira', [callBlock('x')], own);
      cm.addMessage('user', [text('hidden-legacy-notice')], { kind: 'reasoning-loss', system: true });
      cm.addMessage('user', [resultBlock('x')], own);
    } });
    assert.ok(h.windowTexts('mira').includes('hidden-legacy-notice'), 'the premise: the window holds the reasoning-loss row');
    assert.doesNotMatch(await h.compiled('mira'), /hidden-legacy-notice/, 'and the view leaves it out');
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('y')]);
    const held = h.internals.addMessage('user', [text('held notice')], { system: true, tuneOut: { epochId: 'held' } } as MessageMetadata);
    h.cm('mira').presentRows([held]);
    const result = storeOwnRow(h.agent('mira'), 'user', [resultBlock('y')]);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result, call]);
    assert.equal(h.cm('mira').windowStatusOf(held), 'in');
    assert.equal(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds.length, 2, 'the seeded call and result');
    assert.ok(h.windowTexts('mira').includes('hidden-legacy-notice'), 'the reasoning-loss row stays');
  });

  // What isn't proven sheds as main does: the result alone, with the call
  // and the notice left in the window. Nothing declines.
  for (const shape of ['mismatch', 'missing-id', 'incomplete', 'reused-call', 'unresolved-reuse', 'answered-earlier', 'mixed', 'other-writer',
    'ordinary-turn', 'marker', 'host-change'] as const) {
    it(`a pair it can't prove sheds as before: the result alone, crossing nothing (${shape})`, async () => {
      const h = await boot(shape === 'other-writer' ? { agents: { mira: { observes: ['oren'], foreignRounds: 'raw' } } } : {});
      h.internals.addMessage('user', [text('keep-before')]);
      const own = (participant: string, content: ContentBlock[]) => storeOwnRow(h.agent('mira'), participant, content);
      // An earlier result of 'a' and no other call, so only the count of
      // results rejects the pair: in the record and the window
      // (answered-earlier), or in the record only, set aside from the window
      // (unresolved-reuse).
      if (shape === 'answered-earlier') own('user', [resultBlock('a')]);
      const earlier = shape === 'unresolved-reuse' ? own('user', [resultBlock('a')]) : undefined;
      if (earlier) h.cm('mira').retractRows([earlier], { undone: true });
      if (shape === 'reused-call') own('mira', [callBlock('a')]);
      const call = own('mira', [callBlock('a'), ...(shape === 'incomplete' ? [callBlock('b')] : [])]);
      const between = shape === 'ordinary-turn' ? h.internals.addMessage('user', [text('ordinary')])
        : shape === 'marker' ? h.internals.addMessage('user', [text('marker')], { system: true, kind: 'refusal-rewind' })
        : shape === 'host-change' ? hostChange(h)
        : h.internals.addMessage('user', [text('notice')], { system: true });
      const resultContent = [resultBlock(shape === 'missing-id' ? undefined : shape === 'mismatch' ? 'x' : 'a'),
        ...(shape === 'mixed' ? [callBlock('b')] : [])];
      const result = shape === 'other-writer' ? storeOwnRow(h.agent('oren'), 'user', resultContent) : own('user', resultContent);
      assert.notEqual(h.cm('mira').ordinalOf(result), undefined, "the premise: mira's window holds the result");
      if (earlier) assert.ok(h.cm('mira').getMessage(earlier) && h.cm('mira').ordinalOf(earlier) === undefined, 'the premise: the earlier result is in the record only');
      const { retracts, removals } = watchRetracts(h);
      const rec = h.internals.shedNewestTurn(h.agent('mira'));
      assert.deepEqual(rec?.removedIds, [result], 'the result body alone, as on main');
      assert.deepEqual([retracts, removals], [[[[result], { undone: true }]], []]);
      assert.deepEqual([call, between].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in'], 'the call and what sits between stay');
      assert.ok(h.cm('mira').getMessage(result), 'the record keeps the result');
    });
  }

  // Two module writers, each writing for mira: one's tool call, a notice,
  // then the other's result with the same ID. Both rows carry the same
  // audience stamp and no owner stamp, so nothing says one writer wrote
  // both: the result goes alone, as on main, and the call and notice stay.
  it("rows two module writers stored for the same audience, with no owner stamp, prove no pair across a notice", async () => {
    class Writer implements Module {
      ctx!: ModuleContext;
      constructor(readonly name: string) {}
      async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] { return []; }
      async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
      async onProcess(): Promise<EventResponse> { return {}; }
    }
    const one = new Writer('writer-one'), two = new Writer('writer-two');
    const h = await boot({ modules: [one, two] });
    await h.framework.start();
    const call = one.ctx.addMessage('mira', [callBlock('shared-id')], undefined, { forAgent: 'mira' });
    const notice = h.internals.addMessage('user', [text('notice')], { system: true });
    const result = two.ctx.addMessage('user', [resultBlock('shared-id')], undefined, { forAgent: 'mira' });
    const stamps = [call, result].map((id) => h.cm('mira').getMessage(id)?.metadata as { audience?: string[]; ownRowOf?: string } | undefined);
    assert.deepEqual(stamps.map((m) => [m?.audience, m?.ownRowOf]), [[['mira'], undefined], [['mira'], undefined]],
      'the premise: the same audience, and no owner');
    const { retracts, removals } = watchRetracts(h);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result], 'the result alone, as on main');
    assert.deepEqual([retracts, removals], [[[[result], { undone: true }]], []]);
    assert.deepEqual([call, notice].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in'], 'the unrelated call and the notice stay');
  });

  it("the record's shed (a window that is still the record) is unchanged: the adjacent pair in one removal", async () => {
    const h = await boot();
    (h.framework as unknown as { presents: () => boolean }).presents = () => false;
    const call = h.internals.addMessage('mira', [callBlock('a')]);
    const result = h.internals.addMessage('user', [resultBlock('a')]);
    const { retracts, removals } = watchRetracts(h);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result, call]);
    assert.deepEqual([retracts, removals], [[], [[call, result]]]);
  });

  it("the record's shed doesn't cross a notice: the result alone, the call and notice kept", async () => {
    const h = await boot();
    (h.framework as unknown as { presents: () => boolean }).presents = () => false;
    const call = h.internals.addMessage('mira', [callBlock('a')]);
    const notice = h.internals.addMessage('user', [text('notice')], { system: true });
    const result = h.internals.addMessage('user', [resultBlock('a')]);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result]);
    assert.ok(!h.cm('mira').getMessage(result), 'the result is removed from the record');
    assert.ok(h.cm('mira').getMessage(call) && h.cm('mira').getMessage(notice), 'the call and the notice stay');
  });
});

// Shapes main recovers, which a presented-window shed recovers as main does
// (the review of #1026's planner, which declined each of them).
describe('a presented-window shed recovers what main recovered', () => {
  it('a result the request carried takes the call right before it, though the call was not carried', async () => {
    const h = await boot();
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('r')]);
    const result = storeOwnRow(h.agent('mira'), 'user', [resultBlock('r')]);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'), new Set([result]))?.removedIds, [result, call]);
    assert.deepEqual([call, result].map((id) => h.cm('mira').windowStatusOf(id)), ['undone', 'undone']);
  });

  it('a call with no result is shed as a body of its own', async () => {
    const h = await boot();
    const before = h.internals.addMessage('user', [text('keep-before')]);
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('orphan')]);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [call]);
    assert.equal(h.cm('mira').windowStatusOf(before), 'in');
  });

  it('an ordinary body whose first shard is held and whose second is sent goes whole', async () => {
    const h = await boot();
    const cm = h.cm('mira');
    const store = (cm as unknown as { messageStore: { append: (...args: unknown[]) => { id: MessageId } } }).messageStore;
    const held = store.append('user', [text('part-0')], { tuneOut: { epochId: 'held' } }, undefined, { bodyGroupId: 'mixed', shardIndex: 0 }).id;
    const sent = store.append('user', [text('part-1')], {}, undefined, { bodyGroupId: 'mixed', shardIndex: 1 }).id;
    cm.presentRows([held]);
    assert.match(await h.compiled('mira'), /part-1/);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [sent, held]);
    assert.deepEqual([held, sent].map((id) => cm.windowStatusOf(id)), ['undone', 'undone']);
  });

  for (const mode of ['transcript', 'raw'] as const) {
    it(`an observer sheds an observed agent's adjacent call and result together (${mode})`, async () => {
      const h = await boot({ agents: { mira: { observes: ['oren'], foreignRounds: mode } } });
      const call = storeOwnRow(h.agent('oren'), 'oren', [callBlock('o1')]);
      const result = storeOwnRow(h.agent('oren'), 'user', [resultBlock('o1')]);
      assert.ok(h.cm('mira').ordinalOf(call) !== undefined && h.cm('mira').ordinalOf(result) !== undefined, "the premise: mira's window holds both");
      const oren = await h.compiled('oren');
      assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'), new Set([call, result]))?.removedIds, [result, call]);
      assert.deepEqual([call, result].map((id) => h.cm('mira').windowStatusOf(id)), ['undone', 'undone']);
      assert.equal(await h.compiled('oren'), oren, "oren's window is as it was");
    });
  }

  it("an observer doesn't pair its own call with another writer's result of the same ID across a notice", async () => {
    const h = await boot({ agents: { mira: { observes: ['oren'], foreignRounds: 'raw' } } });
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('probe-id')]);
    const notice = storeOwnRow(h.agent('mira'), 'user', [text('probe-notice')], { system: true });
    const result = storeOwnRow(h.agent('oren'), 'user', [resultBlock('probe-id')]);
    assert.ok(h.cm('mira').ordinalOf(result) !== undefined, "the premise: mira's window holds oren's result");
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result]);
    assert.deepEqual([call, notice].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in']);
  });

  // Rows with no stamp are of unknown ownership, not one writer's (#1026,
  // review probe C): mira's unstamped call and oren's unstamped result of the
  // same ID across a notice aren't paired, and mira's call stays, as on main.
  it("an observer doesn't pair unstamped rows of two writers with the same ID across a notice", async () => {
    const h = await boot({ agents: { mira: { observes: ['oren'], foreignRounds: 'raw' } } });
    const append = (name: string, participant: string, content: ContentBlock[], meta = {}) =>
      (h.cm(name) as unknown as { messageStore: { append: (...args: unknown[]) => { id: MessageId } } }).messageStore.append(participant, content, meta).id;
    const call = append('mira', 'mira', [callBlock('probe-id')]);
    const notice = append('mira', 'user', [text('probe-notice')], { system: true });
    const result = append('oren', 'user', [resultBlock('probe-id')]);
    h.cm('mira').presentRows([call, notice, result]);
    assert.ok(h.cm('mira').ordinalOf(call) !== undefined && h.cm('mira').ordinalOf(result) !== undefined, "the premise: mira's window holds both");
    assert.ok([call, result].every((id) => !h.cm('mira').getMessage(id)?.metadata?.audience), 'and neither is stamped');
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result]);
    assert.deepEqual([call, notice].map((id) => h.cm('mira').windowStatusOf(id)), ['in', 'in']);
  });

  // An unstamped adjacent pair still recovers on main's path.
  for (const mode of ['transcript', 'raw'] as const) {
    it(`an observer sheds an observed agent's unstamped adjacent call and result together (${mode})`, async () => {
      const h = await boot({ agents: { mira: { observes: ['oren'], foreignRounds: mode } } });
      const store = (h.cm('oren') as unknown as { messageStore: { append: (...args: unknown[]) => { id: MessageId } } }).messageStore;
      const call = store.append('oren', [callBlock('o2')], {}).id;
      const result = store.append('user', [resultBlock('o2')], {}).id;
      h.cm('mira').presentRows([call, result]);
      assert.ok(h.cm('mira').ordinalOf(call) !== undefined && h.cm('mira').ordinalOf(result) !== undefined, "the premise: mira's window holds both");
      assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'), new Set([call, result]))?.removedIds, [result, call]);
      assert.deepEqual([call, result].map((id) => h.cm('mira').windowStatusOf(id)), ['undone', 'undone']);
    });
  }

  it("a persistent subconscious sheds the primary's adjacent call and result it is presented", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-shed-window-sub-'));
    dirs.push(dir);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: new WireMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.', foreignRounds: 'raw' },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    frameworks.push(framework);
    await framework.start();
    const scout = framework.getAgent('scout')!;
    const call = storeOwnRow(scout, 'scout', [text('Looking it up.'), callBlock('c1')]);
    const result = storeOwnRow(scout, 'user', [{ ...resultBlock('c1', 'green'), toolName: 'search' } as ContentBlock]);
    const sub = framework.getAgent('Subconscious')!;
    const cm = sub.getContextManager();
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [call, result], 'the premise: its window holds both');
    assert.ok(!cm.getAllMessages().some((m) => m.id === call), "and its own slot doesn't");
    const internals = framework as unknown as Internals;
    assert.deepEqual(internals.shedNewestTurn(sub, new Set([call, result]))?.removedIds, [result, call]);
  });

  // Two of the primary's rounds reuse ID 'x'. The subconscious's window
  // keeps the first round's call and the second round's result, with a
  // notice between; the other endpoints are set aside from its window and
  // are in the primary's record, not its own. Its own record and window show
  // one call and one result, so they can't prove the pair: rows from
  // another slot's record pair across a notice only as on main, and the
  // result goes alone.
  it("a persistent subconscious doesn't pair another slot's rows across a notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-shed-window-sub-'));
    dirs.push(dir);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: new WireMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.', foreignRounds: 'raw' },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
    frameworks.push(framework);
    await framework.start();
    const scout = framework.getAgent('scout')!;
    const sub = framework.getAgent('Subconscious')!;
    const cm = sub.getContextManager();
    const call1 = storeOwnRow(scout, 'scout', [callBlock('x')]);
    const result1 = storeOwnRow(scout, 'user', [resultBlock('x', 'first')]);
    const notice = storeOwnRow(sub, 'user', [text('notice')], { system: true });
    const call2 = storeOwnRow(scout, 'scout', [callBlock('x')]);
    const result2 = storeOwnRow(scout, 'user', [resultBlock('x', 'second')]);
    cm.retractRows([result1, call2], { undone: true });
    assert.deepEqual(cm.getPresentedMessages().map((m) => m.id), [call1, notice, result2], 'the premise: its window keeps one call and one result');
    assert.ok(![call1, result1, call2, result2].some((id) => cm.getAllMessages().some((m) => m.id === id)), "and its own record holds none of the primary's rounds");
    const internals = framework as unknown as Internals;
    assert.deepEqual(internals.shedNewestTurn(sub)?.removedIds, [result2], 'the result alone, as on main');
    assert.deepEqual([call1, notice].map((id) => cm.windowStatusOf(id)), ['in', 'in']);
  });

  // A collision in the window only: the primary's earlier result of 'a' is
  // in the subconscious's window and not in its own record, which holds its
  // own call and result of 'a' across a notice. Without it the pair goes
  // whole; with it the result goes alone.
  for (const collide of [false, true]) {
    it(`a persistent subconscious's own pair across a notice, with a same-ID result in its window only (collision: ${collide})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-shed-window-sub-'));
      dirs.push(dir);
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'),
        membrane: new WireMembrane().asMembrane(),
        agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
        subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'Read for scout.', foreignRounds: 'raw' },
        modules: [],
        syncIntervalMs: 0,
        maintenanceIntervalMs: 0,
      } as never);
      frameworks.push(framework);
      await framework.start();
      const sub = framework.getAgent('Subconscious')!;
      const cm = sub.getContextManager();
      const earlier = collide ? storeOwnRow(framework.getAgent('scout')!, 'user', [resultBlock('a')]) : undefined;
      const call = storeOwnRow(sub, 'Subconscious', [callBlock('a')]);
      const notice = storeOwnRow(sub, 'user', [text('notice')], { system: true });
      const result = storeOwnRow(sub, 'user', [resultBlock('a')]);
      if (earlier) {
        assert.ok(cm.ordinalOf(earlier) !== undefined && !cm.getAllMessages().some((m) => m.id === earlier),
          'the premise: in its window, not its record');
      }
      const internals = framework as unknown as Internals;
      assert.deepEqual(internals.shedNewestTurn(sub)?.removedIds, collide ? [result] : [result, call]);
      assert.equal(cm.windowStatusOf(notice), 'in');
      assert.equal(cm.windowStatusOf(call), collide ? 'in' : 'undone');
    });
  }
});
