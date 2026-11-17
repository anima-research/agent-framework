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
  updateRewindMarker(agent: Agent, category: string): number;
  rewindEpisode: Map<string, { markerId: MessageId; count: number; category: string }>;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { residents?: string[]; dir?: string; failWriteDown?: boolean; seed?: (cm: ContextManager) => void } = {}) {
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
  // Fail before the first registration writes an index; other residents adopt normally.
  const presentRows = ContextManager.prototype.presentRows;
  let failed = false;
  if (opts.failWriteDown) ContextManager.prototype.presentRows = function (...args) {
    if (!failed && this.windowMode() === 'legacy') {
      failed = true;
      throw new Error('synthetic initial write-down failure');
    }
    return presentRows.apply(this, args);
  };
  let framework: AgentFramework;
  try {
    framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: residents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled' })),
      modules: [new SurfaceModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    } as never);
  } finally {
    ContextManager.prototype.presentRows = presentRows;
  }
  if (opts.failWriteDown) {
    assert.equal(failed, true);
    assert.equal(framework.getAgent('mira')!.getContextManager().windowMode(), 'legacy');
    assert.equal(framework.getAgent('oren')!.getContextManager().windowMode(), 'presented');
  }
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

for (const gap of [false, true]) {
  it(`rewinds the complete ID-matched exchange on the next wire request (notice gap: ${gap})`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    const call = h.internals.addMessage('mira', [
      { type: 'thinking', thinking: '', signature: 'exchange-signature' } as ContentBlock,
      text('exchange-narration'),
      { type: 'tool_use', id: 'exchange-call', name: 'shell', input: {} } as ContentBlock,
    ]);
    if (gap) h.internals.addMessage('user', [text('intervening-notice')], { system: true });
    const result = h.internals.addMessage('user', [
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
  });
}

// `unknown` and `barrier` end with the call still sent after its result was
// shed alone. That is a limit of the scope, not a goal: across a gap nothing
// but a matching ID says which call a result belongs to, and the shed does
// not repair a history it cannot read. The call goes on a later shed (the
// next, or after the ordinary turn's in `barrier`), as before #737.
// (`unrelated-carried` is the other order: the held result is
// passed over and the call is shed on its own.) `raw` forces the record fallback by patching `presents` on a
// host that is presenting: it shows the one range removal on the real
// ContextManager, not a host whose write-down failed.
for (const scenario of ['multiple', 'unknown', 'barrier', 'carried', 'unrelated-carried', 'raw'] as const) {
  it(`ID pairing control on the next request: ${scenario}`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    const call = h.internals.addMessage('mira', [
      { type: 'thinking', thinking: '', signature: 'control-signature' } as ContentBlock,
      { type: 'tool_use', id: 'control-a', name: 'shell', input: {} } as ContentBlock,
      { type: 'tool_use', id: 'control-b', name: 'shell', input: {} } as ContentBlock,
    ]);
    const notices: MessageId[] = [];
    if (scenario === 'multiple') {
      h.internals.addMessage('user', [{ type: 'tool_result', toolUseId: 'control-a', content: 'first-result' } as ContentBlock]);
    }
    notices.push(h.internals.addMessage('user', [text('control-notice')], { system: true }));
    if (scenario === 'barrier') h.internals.addMessage('user', [text('ordinary-turn')]);
    const unknown = scenario === 'unknown' || scenario === 'unrelated-carried';
    const held = scenario === 'carried' || scenario === 'unrelated-carried';
    const result = h.internals.addMessage('user', [
      { type: 'tool_result', toolUseId: unknown ? 'unknown-id' : 'control-b', content: 'last-result' } as ContentBlock,
    ], held ? { tuneOut: { epochId: 'held' } } as MessageMetadata : undefined);
    // Explicit raw-record fallback; the real CM still performs its atomic
    // range removal and the framework retracts removed rows elsewhere.
    if (scenario === 'raw') (h.framework as unknown as { presents: () => boolean }).presents = () => false;
    const cm = h.cm('mira');
    // A held row can be in the window (e.g. initial registration) while
    // the request view filters it out. Exercise that supported case.
    if (held) cm.presentRows([result]);
    const retractions: MessageId[][] = [];
    const removals: MessageId[][] = [];
    const retract = cm.retractRows.bind(cm);
    const remove = cm.removeMessages.bind(cm);
    cm.retractRows = (ids, opts) => { retractions.push([...ids]); return retract(ids, opts); };
    cm.removeMessages = (a, b) => { removals.push([a, b]); return remove(a, b); };
    h.internals.shedNewestTurn(h.agent('mira'), held ? new Set([call]) : undefined);
    const pairs = !unknown && scenario !== 'barrier';
    if (pairs) {
      if (scenario === 'raw') assert.deepEqual(removals, [[call, result]]);
      else {
        assert.equal(retractions.length, 1, 'one atomic retraction');
        assert.ok(retractions[0]!.includes(call) && retractions[0]!.includes(result));
      }
    }
    if (scenario === 'unrelated-carried') {
      assert.equal(cm.windowStatusOf(result), 'in', 'an unrelated held result is not mistaken for a carried call result');
    }
    h.framework.start();
    h.framework.pushEvent(input('next-question', ['mira']));
    await until(() => h.membrane.callsFor('mira').length === 1, 'next request');
    const sent = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
    assert.match(sent, /keep-before/);
    if (pairs || scenario === 'unrelated-carried') assert.doesNotMatch(sent, /control-a|control-b|control-signature/);
    else assert.match(sent, /control-a/, 'unmatched results must not remove an unrelated assistant body');
    assert.doesNotMatch(sent, /last-result|first-result/);
    if (scenario === 'barrier') assert.match(sent, /ordinary-turn/);
  });
}

// Stored rows whose result IDs are wrong or missing (corrupt or legacy):
// right after the call body they still leave with it, as before #737, so the
// exhaustion breaker's one shed clears a corrupted pairing. Across a notice
// only a matching ID pairs them; there the result is shed alone and the call
// is still sent, the scope limit described above.
for (const layout of ['adjacent', 'gap'] as const) {
  for (const ids of ['mismatch', 'missing', 'mixed'] as const) {
    it(`a result whose IDs do not match its call, on the next request (${layout}, ${ids})`, async () => {
      const h = await boot();
      h.internals.addMessage('user', [text('keep-before')]);
      const call = h.internals.addMessage('mira', [
        { type: 'thinking', thinking: '', signature: 'legacy-signature' } as ContentBlock,
        text('legacy-narration'),
        { type: 'tool_use', id: 'legacy-a', name: 'shell', input: {} } as ContentBlock,
        { type: 'tool_use', id: 'legacy-b', name: 'shell', input: {} } as ContentBlock,
      ]);
      const notice = layout === 'gap' ? h.internals.addMessage('user', [text('legacy-notice')], { system: true }) : undefined;
      const resultBlock = (toolUseId: string | undefined, content: string) =>
        ({ type: 'tool_result', ...(toolUseId === undefined ? {} : { toolUseId }), content }) as ContentBlock;
      const result = h.internals.addMessage('user', {
        mismatch: [resultBlock('legacy-x', 'legacy-result')],
        missing: [resultBlock(undefined, 'legacy-result')],
        mixed: [resultBlock('legacy-a', 'legacy-result'), resultBlock('legacy-x', 'legacy-result')],
      }[ids]);
      const cm = h.cm('mira');
      const retractions: MessageId[][] = [];
      const retract = cm.retractRows.bind(cm);
      cm.retractRows = (rows, opts) => { retractions.push([...rows]); return retract(rows, opts); };
      const other = await h.compiled('oren');
      const record = h.internals.shedNewestTurn(h.agent('mira'));
      assert.ok(record);
      if (layout === 'adjacent') {
        assert.deepEqual(record.removedIds, [result, call]);
        assert.deepEqual(retractions, [[call, result]], 'one retraction, the call body and the result');
      } else {
        assert.deepEqual(record.removedIds, [result]);
        assert.deepEqual(retractions, [[result]]);
        assert.equal(cm.windowStatusOf(notice!), 'in', 'the notice stays');
      }
      h.framework.start();
      h.framework.pushEvent(input('next-question', ['mira']));
      await until(() => h.membrane.callsFor('mira').length === 1, 'next request');
      const sent = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
      assert.match(sent, /keep-before/);
      assert.match(sent, /next-question/);
      assert.doesNotMatch(sent, /legacy-result/);
      if (layout === 'adjacent') assert.doesNotMatch(sent, /legacy-a|legacy-b|legacy-signature|legacy-narration/);
      else assert.match(sent, /legacy-signature/, 'not paired across the gap');
      assert.equal(await h.compiled('oren'), other);
      assert.ok(cm.getMessage(call) && cm.getMessage(result), 'the record keeps both');
    });
  }
}

// The adjacent rule on a window that is still the record (`presents`
// patched, as the `raw` control above): one range removal, call to result.
it('a result whose ID does not match the call right before it leaves the record with it (raw)', async () => {
  const h = await boot();
  h.internals.addMessage('user', [text('keep-before')]);
  const call = h.internals.addMessage('mira', [
    { type: 'thinking', thinking: '', signature: 'legacy-raw-signature' } as ContentBlock,
    { type: 'tool_use', id: 'legacy-raw-a', name: 'shell', input: {} } as ContentBlock,
  ]);
  const result = h.internals.addMessage('user', [
    { type: 'tool_result', toolUseId: 'legacy-raw-x', content: 'legacy-raw-result' } as ContentBlock,
  ]);
  (h.framework as unknown as { presents: () => boolean }).presents = () => false;
  const cm = h.cm('mira');
  const removals: MessageId[][] = [];
  const remove = cm.removeMessages.bind(cm);
  cm.removeMessages = (a, b) => { removals.push([a, b]); return remove(a, b); };
  assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result, call]);
  assert.deepEqual(removals, [[call, result]]);
  h.framework.start();
  h.framework.pushEvent(input('next-question', ['mira']));
  await until(() => h.membrane.callsFor('mira').length === 1, 'next request');
  const sent = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
  assert.match(sent, /keep-before/);
  assert.doesNotMatch(sent, /legacy-raw-a|legacy-raw-signature|legacy-raw-result/);
});

// A rewind marker between a call and its result is never taken with them:
// the caller edits the episode's marker in place right after the shed, and
// an earlier episode's is its durable record. It ends the walk, so the
// result is shed alone and the call is still sent until the next shed, as
// before #737 (a scope limit; no path here is known to store a marker
// there). The marker has been edited once already, so it is known by the
// kind its row keeps. `raw` patches `presents` as the control above does: without the
// barrier the range removal deleted the marker and the marker update threw.
for (const mode of ['windowed', 'raw', 'earlier-episode'] as const) {
  it(`a rewind marker between a call and its result stays, on the next request (${mode})`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    const call = h.internals.addMessage('mira', [
      { type: 'thinking', thinking: '', signature: 'marked-signature' } as ContentBlock,
      { type: 'tool_use', id: 'marked-call', name: 'shell', input: {} } as ContentBlock,
    ]);
    assert.equal(h.internals.updateRewindMarker(h.agent('mira'), 'zz-category'), 1);
    assert.equal(h.internals.updateRewindMarker(h.agent('mira'), 'zz-category'), 2);
    const marker = h.internals.rewindEpisode.get('mira')!.markerId;
    // The episode ended; its marker is no longer the tracked one.
    if (mode === 'earlier-episode') h.internals.rewindEpisode.delete('mira');
    const result = h.internals.addMessage('user', [
      { type: 'tool_result', toolUseId: 'marked-call', content: 'marked-result' } as ContentBlock,
    ]);
    if (mode === 'raw') (h.framework as unknown as { presents: () => boolean }).presents = () => false;
    const cm = h.cm('mira');
    const record = h.internals.shedNewestTurn(h.agent('mira'));
    assert.ok(record);
    assert.deepEqual(record.removedIds, [result], 'the result alone');
    assert.ok(cm.getMessage(marker), 'the marker is still stored');
    assert.ok(cm.getMessage(call));
    if (mode !== 'raw') assert.equal(cm.windowStatusOf(marker), 'in', "and still in mira's window");
    if (mode !== 'earlier-episode') {
      assert.equal(h.internals.updateRewindMarker(h.agent('mira'), 'zz-category'), 3);
      assert.equal(h.internals.rewindEpisode.get('mira')!.markerId, marker, 'one marker, edited in place');
    }
    h.framework.start();
    h.framework.pushEvent(input('next-question', ['mira']));
    await until(() => h.membrane.callsFor('mira').length === 1, 'next request');
    const sent = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
    assert.match(sent, /keep-before/);
    assert.match(sent, mode === 'earlier-episode' ? /The 2 most recent turn\(s\) were set aside/ : /The 3 most recent turn\(s\) were set aside/);
    assert.doesNotMatch(sent, /marked-result/);
    assert.match(sent, /marked-signature/, 'not paired across the marker');
  });
}

// Every result ID between the call and the newest result counts, an earlier
// result body's too: with one there that the call does not hold, or that has
// none, the newest result is shed alone. The earlier result is then right
// after the call, and the next shed takes the two together.
for (const sibling of ['unknown', 'missing'] as const) {
  it(`an earlier result body's ID the call does not hold leaves the newest result unpaired (${sibling})`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    const call = h.internals.addMessage('mira', [
      { type: 'thinking', thinking: '', signature: 'sibling-signature' } as ContentBlock,
      { type: 'tool_use', id: 'sibling-a', name: 'shell', input: {} } as ContentBlock,
      { type: 'tool_use', id: 'sibling-b', name: 'shell', input: {} } as ContentBlock,
    ]);
    const earlier = h.internals.addMessage('user', [
      { type: 'tool_result', ...(sibling === 'unknown' ? { toolUseId: 'sibling-x' } : {}), content: 'earlier-result' } as ContentBlock,
    ]);
    const notice = h.internals.addMessage('user', [text('sibling-notice')], { system: true });
    const newest = h.internals.addMessage('user', [
      { type: 'tool_result', toolUseId: 'sibling-b', content: 'newest-result' } as ContentBlock,
    ]);
    const cm = h.cm('mira');
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [newest], 'the newest result alone');
    assert.deepEqual([call, earlier, notice].map((id) => cm.windowStatusOf(id)), ['in', 'in', 'in']);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [earlier, call], 'then the call and the result right after it');
    assert.equal(cm.windowStatusOf(notice), 'in');
    h.framework.start();
    h.framework.pushEvent(input('next-question', ['mira']));
    await until(() => h.membrane.callsFor('mira').length === 1, 'next request');
    const sent = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
    assert.match(sent, /keep-before/);
    assert.doesNotMatch(sent, /sibling-a|sibling-b|sibling-signature|earlier-result|newest-result/);
  });
}

// A result body in shards that the shed passes over (held from mira's
// request by a tune-out; a system row on a window that is still the record),
// across a notice from its call, its second shard's ID one the call does not
// hold. The body is paired or not as a whole: its first shard's ID alone
// must not pair it, which took part of a body (a range the record refuses,
// in the raw fallback). Unpaired, the call is shed on its own, as before
// #737. The shards are appended as operator-surgery.test.ts appends them.
// `mixed` holds only the second shard, which context-manager's chunker
// never stores (every shard has its body's metadata): the shed then lands
// inside the body, and still reads it whole, so the call and the notice
// stay.
it('a result body with only its newer shard passed over is not paired by its first shard alone (mixed)', async () => {
  const h = await boot();
  h.internals.addMessage('user', [text('keep-before')]);
  const call = h.internals.addMessage('mira', [
    { type: 'tool_use', id: 'mixed-a', name: 'shell', input: {} } as ContentBlock,
    { type: 'tool_use', id: 'mixed-b', name: 'shell', input: {} } as ContentBlock,
  ]);
  const notice = h.internals.addMessage('user', [text('mixed-notice')], { system: true });
  const cm = h.cm('mira');
  const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: MessageId } } }).messageStore;
  const shards = [['mixed-a', {}], ['mixed-x', { tuneOut: { epochId: 'held' } }]].map(([toolUseId, metadata], shardIndex) =>
    store.append('user', [{ type: 'tool_result', toolUseId, content: `mixed-result-${shardIndex}` }], metadata, undefined, { bodyGroupId: 'g-mixed-result', shardIndex }).id);
  cm.presentRows([shards[0]!]);
  const record = h.internals.shedNewestTurn(h.agent('mira'));
  assert.ok(record);
  assert.ok(!record.removedIds.includes(call) && !record.removedIds.includes(notice), 'neither the call nor the notice');
  assert.deepEqual([call, notice].map((id) => cm.windowStatusOf(id)), ['in', 'in']);
});

for (const mode of ['windowed', 'raw'] as const) {
  it(`a passed-over result body is not paired by its first shard alone (${mode})`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('keep-before')]);
    const call = h.internals.addMessage('mira', [
      { type: 'tool_use', id: 'shard-a', name: 'shell', input: {} } as ContentBlock,
      { type: 'tool_use', id: 'shard-b', name: 'shell', input: {} } as ContentBlock,
    ]);
    const notice = h.internals.addMessage('user', [text('shard-notice')], { system: true });
    const cm = h.cm('mira');
    const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: MessageId } } }).messageStore;
    const metadata = mode === 'raw' ? { system: true } : { tuneOut: { epochId: 'held' } };
    const shards = ['shard-a', 'shard-x'].map((toolUseId, shardIndex) =>
      store.append('user', [{ type: 'tool_result', toolUseId, content: `shard-result-${shardIndex}` }], metadata, undefined, { bodyGroupId: 'g-held-result', shardIndex }).id);
    if (mode === 'raw') (h.framework as unknown as { presents: () => boolean }).presents = () => false;
    else cm.presentRows([shards[0]!]);
    const record = h.internals.shedNewestTurn(h.agent('mira'), mode === 'raw' ? undefined : new Set([call]));
    assert.ok(record);
    assert.deepEqual(record.removedIds, [call], 'the call on its own');
    for (const id of [notice, ...shards]) assert.ok(cm.getMessage(id), 'the notice and the whole result body are still stored');
    if (mode === 'windowed') {
      assert.deepEqual([call, notice, ...shards].map((id) => cm.windowStatusOf(id)), ['undone', 'in', 'in', 'in']);
    } else {
      assert.equal(cm.getMessage(call), null, 'removed from the record');
    }
  });
}

// Actual failed initial write-down, not a patched presents predicate.
it('raw legacy selection passes over host changes, held rows and foreign injections', async () => {
  const h = await boot({ failWriteDown: true });
  const before = h.internals.addMessage('user', [text('eligible-before')]);
  const held = h.cm('mira').addMessage('user', [text('held')], { tuneOut: { epochId: 'held' } } as MessageMetadata);
  const foreign = h.cm('mira').addMessage('user', [text('foreign')], {
    contextInjection: { agent: 'oren', namespace: 'test', contentHash: 'test', part: 0, parts: 1 },
  } as MessageMetadata);
  const change = h.cm('mira').addMessage('host', [{ type: 'system_change', addSystem: ['metric'] } as unknown as ContentBlock]);
  assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [before]);
  for (const id of [held, foreign, change]) assert.ok(h.cm('mira').getMessage(id));
  assert.equal(h.cm('mira').windowMode(), 'legacy');
});

it('a raw gap removal after failed write-down accounts for and retracts the whole interval elsewhere', async () => {
  const h = await boot({ failWriteDown: true });
  const before = h.internals.addMessage('user', [text('keep-before')]);
  const call = h.internals.addMessage('mira', [
    { type: 'thinking', thinking: '', signature: 'raw-signature' } as ContentBlock,
    { type: 'tool_use', id: 'raw-a', name: 'shell', input: {} } as ContentBlock,
    { type: 'tool_use', id: 'raw-b', name: 'shell', input: {} } as ContentBlock,
  ]);
  const earlier = h.internals.addMessage('user', [{ type: 'tool_result', toolUseId: 'raw-a', content: 'x'.repeat(100 * 1024) } as ContentBlock]);
  const notice = h.internals.addMessage('user', [text('raw-notice')], { system: true });
  const newest = h.internals.addMessage('user', [{ type: 'tool_result', toolUseId: 'raw-b', content: 'y'.repeat(1024) } as ContentBlock]);
  const interval = [call, earlier, notice, newest];
  for (const id of interval) assert.notEqual(h.cm('oren').ordinalOf(id), undefined, 'control: oren held every row');
  const record = h.internals.shedNewestTurn(h.agent('mira'));
  assert.deepEqual(record?.removedIds, [...interval].reverse());
  assert.equal(record?.descriptor, 'a tool exchange (~101KB)');
  for (const id of interval) {
    assert.equal(h.cm('mira').getMessage(id), null);
    assert.equal(h.cm('oren').ordinalOf(id), undefined, 'no stale other-window entry');
  }
  assert.notEqual(h.cm('oren').ordinalOf(before), undefined, 'unrelated prefix remains');
  const sent = await h.compiled('mira');
  assert.match(sent, /keep-before/);
  assert.doesNotMatch(sent, /raw-signature|raw-a|raw-b|raw-notice/);
  h.framework.start();
  h.framework.pushEvent(input('next-raw-question', ['mira']));
  await until(() => h.membrane.callsFor('mira').length === 1, 'legacy next request');
  const wire = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
  assert.match(wire, /keep-before/);
  assert.match(wire, /next-raw-question/);
  assert.doesNotMatch(wire, /raw-signature|raw-a|raw-b|raw-notice/);
  assert.equal(h.cm('mira').windowMode(), 'legacy');
});

for (const hidden of ['call', 'notice', 'sibling'] as const) {
  it(`exchange visibility contract: hidden ${hidden}`, async () => {
    const h = await boot();
    const call = h.internals.addMessage('mira', [
      { type: 'tool_use', id: 'visibility-a', name: 'shell', input: {} } as ContentBlock,
      { type: 'tool_use', id: 'visibility-b', name: 'shell', input: {} } as ContentBlock,
    ], hidden === 'call' ? { tuneOut: { epochId: 'held' } } as MessageMetadata : undefined);
    if (h.cm('mira').ordinalOf(call) === undefined) h.cm('mira').presentRows([call]);
    const sibling = h.internals.addMessage('user', [
      { type: 'tool_result', toolUseId: 'visibility-a', content: 'earlier' } as ContentBlock,
    ], hidden === 'sibling' ? { tuneOut: { epochId: 'held' } } as MessageMetadata : undefined);
    if (h.cm('mira').ordinalOf(sibling) === undefined) h.cm('mira').presentRows([sibling]);
    const notice = h.internals.addMessage('user', [text('visibility-notice')], {
      system: true, ...(hidden === 'notice' ? { tuneOut: { epochId: 'held' } } : {}),
    } as MessageMetadata);
    if (h.cm('mira').ordinalOf(notice) === undefined) h.cm('mira').presentRows([notice]);
    const result = h.internals.addMessage('user', [
      { type: 'tool_result', toolUseId: 'visibility-b', content: 'newest' } as ContentBlock,
    ]);
    const other = await h.compiled('oren');
    const record = h.internals.shedNewestTurn(h.agent('mira'), new Set(hidden === 'call' ? [result] : [call, result]));
    assert.deepEqual(record?.removedIds, hidden === 'sibling' ? [result, notice, sibling, call] : [result]);
    assert.equal(h.cm('mira').windowStatusOf(call), hidden === 'sibling' ? 'undone' : 'in');
    assert.equal(await h.compiled('oren'), other);
  });
}

for (const mode of ['windowed', 'raw'] as const) {
  for (const matching of [false, true]) {
    it(`complete heterogeneous-shard removal/accounting (${mode}, matching: ${matching})`, async () => {
      const h = await boot();
      const call = h.internals.addMessage('mira', [{ type: 'tool_use', id: 'hetero-a', name: 'shell', input: {} } as ContentBlock]);
      const notice = h.internals.addMessage('user', [text('hetero-notice')], { system: true });
      const cm = h.cm('mira');
      const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: MessageId } } }).messageStore;
      // No normal writer established: CM's chunker repeats one metadata object.
      const shards = ['hetero-a', matching ? 'hetero-a' : 'hetero-x'].map((toolUseId, shardIndex) =>
        store.append('user', [{ type: 'tool_result', toolUseId, content: 'shard' }], shardIndex ? { tuneOut: { epochId: 'held' } } : {}, undefined,
          { bodyGroupId: 'hetero', shardIndex }).id);
      cm.presentRows([shards[0]!]);
      h.cm('oren').presentRows([shards[0]!]);
      if (mode === 'raw') (h.framework as unknown as { presents: () => boolean }).presents = () => false;
      const record = h.internals.shedNewestTurn(h.agent('mira'), new Set([shards[0]!]));
      const removed = matching ? [call, notice, ...shards] : shards;
      assert.deepEqual(record?.removedIds, [...removed].reverse());
      if (mode === 'windowed') {
        for (const id of removed) assert.equal(cm.windowStatusOf(id), 'undone');
        const trace = h.traces.filter((t) => t.type === 'presentation:retracted').at(-1) as { messageIds: MessageId[] };
        assert.deepEqual(trace.messageIds, removed);
      } else {
        for (const id of removed) {
          assert.equal(cm.getMessage(id), null);
          assert.equal(h.cm('oren').ordinalOf(id), undefined);
        }
      }
    });
  }
}

// Mixed system-change bodies are rejected by CM on write: simulate loaded
// malformed content at the snapshot boundary; marker bodies use real metadata.
for (const mixed of ['call-change', 'result-change', 'call-marker', 'result-marker'] as const) {
  it(`mixed-body barrier applies before pairing (${mixed})`, async () => {
    const h = await boot();
    const cm = h.cm('mira');
    const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown) => { id: MessageId } } }).messageStore;
    const callBody = mixed.startsWith('call');
    const barrierContent = mixed.endsWith('change') ? [{ type: 'system_change', addSystem: ['metric'] }] : [];
    const barrierMetadata = mixed.endsWith('marker') ? { kind: 'refusal-rewind', system: true } : {};
    const call = store.append('mira', [{ type: 'tool_use', id: 'mixed-barrier', name: 'shell', input: {} }], callBody ? barrierMetadata : {}).id;
    const middle = store.append('user', [{ type: 'tool_result', toolUseId: 'mixed-barrier', content: 'middle' }], !callBody ? barrierMetadata : {}).id;
    const notice = h.internals.addMessage('user', [text('mixed-gap')], { system: true });
    const newest = h.internals.addMessage('user', [{ type: 'tool_result', toolUseId: 'mixed-barrier', content: 'newest' } as ContentBlock]);
    const snapshot = cm.getPresentedMessages().map((row) => ({ ...row,
      content: row.id === (callBody ? call : middle) ? [...row.content, ...barrierContent] as ContentBlock[] : row.content,
    }));
    cm.getPresentedMessages = () => snapshot;
    const record = h.internals.shedNewestTurn(h.agent('mira'));
    assert.deepEqual(record?.removedIds, [newest]);
    for (const id of [call, middle, notice]) assert.equal(cm.windowStatusOf(id), 'in');
  });
}

it('a passed-over sharded result scans its notice gap once, not once per shard', async () => {
  const h = await boot();
  const before = h.internals.addMessage('user', [text('keep-before')]);
  const notices = Array.from({ length: 30 }, (_, i) => h.internals.addMessage('user', [text(`notice-${i}`)], { system: true }));
  const cm = h.cm('mira');
  const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: MessageId } } }).messageStore;
  const shards = Array.from({ length: 40 }, (_, shardIndex) => store.append('user', [
    { type: 'tool_result', toolUseId: 'unmatched', content: 'held' },
  ], { tuneOut: { epochId: 'held' } }, undefined, { bodyGroupId: 'scan-result', shardIndex }).id);
  cm.presentRows([shards[0]!]);
  const snapshot = cm.getPresentedMessages();
  let noticeReads = 0;
  for (const row of snapshot) if (notices.includes(row.id)) {
    const content = row.content;
    Object.defineProperty(row, 'content', { get: () => { noticeReads++; return content; } });
  }
  cm.getPresentedMessages = () => snapshot;
  assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [before]);
  assert.ok(noticeReads < notices.length * 16, `bounded gap reads: ${noticeReads}`);
});
