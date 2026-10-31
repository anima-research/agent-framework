/**
 * The history tools read the record, not an agent's window (#291, AF-7).
 * Once agents share a slot the two differ: a co-resident's rounds, a row not
 * presented yet, a turn undone or shed, are in the record and not in the
 * agent's window. With the framework's window lookup
 * (ModuleContext.windowStatusOf), each entry for a row the caller's window
 * doesn't hold says so (`window: 'not-shown' | 'undone'`), and for an
 * agent's call another agent's own rows its window doesn't hold are left
 * out unless it observes that agent (decision 1), counted as `leftOut`. A
 * row the caller's window holds and its view leaves out (another agent's
 * stored context injection, a held row in a resident's window) isn't shown
 * to it either (ModuleContext.viewKeeps). The summaries `overview` and
 * `semantic_search` read fold the bound agent's context, so for another
 * agent's call that doesn't observe it they are left out too (FW-AF-7). A
 * call no agent made reads the record whole, marked for the delivery agent.
 * Without the lookup, every tool and every answer is as it was.
 *
 * Two residents of one slot, mira (the primary, whose context the module is
 * bound to, as a host binds it) and oren.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextManager, MessageId, MessageMetadata, StoredMessage, TimeRangeSummaryEntry } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, HistoryModule, storeOwnRow } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;

class SurfaceModule implements Module {
  readonly name = 'surface';
  ctx!: ModuleContext;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
}

type Internals = {
  addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { forAgent?: string }): MessageId;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { subconscious?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-history-window-marks-'));
  dirs.push(dir);
  const history = new HistoryModule();
  const surface = new SurfaceModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
      { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
    ],
    modules: [history, surface],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    ...(opts.subconscious ? { subconscious: { enabled: true, systemPrompt: 'You notice.' } } : {}),
  } as never);
  frameworks.push(framework);
  const cm = (name: string): ContextManager => framework.getAgent(name)!.getContextManager();
  history.bind(cm('mira'));
  const internals = framework as unknown as Internals;
  const ch = { channelId: 'discord:g1:c1' };
  // In both windows.
  const both = internals.addMessage('someone', [text('zz-both')], ch as MessageMetadata);
  // In both, then out of mira's as an undone turn's.
  const undone = internals.addMessage('someone', [text('zz-undone')], ch as MessageMetadata);
  cm('mira').retractRows([undone], { undone: true });
  // Each resident's own round, which the other is never shown.
  const orens = storeOwnRow(framework.getAgent('oren')!, 'oren', [text('zz-orens-note')], ch as MessageMetadata);
  const miras = storeOwnRow(framework.getAgent('mira')!, 'mira', [text('zz-miras-note')], ch as MessageMetadata);
  // Stored past the framework, and presented to no one yet: an own row's
  // write presents its owner's arrivals at rest, so this comes last.
  const out = cm('mira').addMessage('someone', [text('zz-out')], ch as MessageMetadata);
  const call = async (name: string, input: Record<string, unknown>, caller?: string, mod: HistoryModule = history) => {
    const result = await mod.handleToolCall({ id: 't', name, input, ...(caller ? { callerAgentName: caller } : {}) } as ToolCall);
    assert.equal(result.success, true, result.error);
    return result.data as Record<string, unknown> & { messages?: Array<Record<string, unknown>>; matches?: Array<Record<string, unknown>> };
  };
  return { framework, history, surface, cm, internals, ids: { both, undone, out, orens, miras }, call };
}

/** Each entry as [id, its window mark or '-'], in order. */
const marks = (entries: Array<Record<string, unknown>> | undefined) => (entries ?? []).map((e) => [e.id, 'window' in e ? e.window : '-']);

describe("the history tools' window marks (#291, AF-7)", () => {
  it("extract marks each row relative to the calling agent, and leaves out another agent's own rows its window doesn't hold", async () => {
    const h = await boot();
    const { both, undone, out, orens, miras } = h.ids;
    const forMira = await h.call('extract', {}, 'mira');
    assert.deepEqual(marks(forMira.messages), [[both, '-'], [undone, 'undone'], [miras, '-'], [out, 'not-shown']]);
    assert.equal(forMira.leftOut, 1, "oren's own round is left out");
    assert.equal(forMira.returned, 4);

    const forOren = await h.call('extract', {}, 'oren');
    assert.deepEqual(marks(forOren.messages), [[both, '-'], [undone, '-'], [orens, '-'], [out, 'not-shown']], "relative to oren's window");
    assert.equal(forOren.leftOut, 1, "mira's own round is left out for oren");

    const operator = await h.call('extract', {});
    assert.deepEqual(marks(operator.messages), [[both, '-'], [undone, 'undone'], [orens, 'not-shown'], [miras, '-'], [out, 'not-shown']],
      "a call no agent made reads the whole record, marked for the delivery agent");
    assert.equal('leftOut' in operator, false);

    // With an author filter the rows left out are counted the same way.
    const byAuthor = await h.call('extract', { excludeAuthor: 'nobody-zz' }, 'mira');
    assert.deepEqual(marks(byAuthor.messages), [[both, '-'], [undone, 'undone'], [miras, '-'], [out, 'not-shown']]);
    assert.equal(byAuthor.leftOut, 1);
  });

  it("another agent's own row that the caller's window holds is shown, unmarked, as its context is", async () => {
    const h = await boot();
    // As a window written down from a record with oren's earlier rounds in
    // it holds them.
    h.cm('mira').presentRows([h.ids.orens]);
    const forMira = await h.call('extract', {}, 'mira');
    assert.ok(marks(forMira.messages).some(([id, mark]) => id === h.ids.orens && mark === '-'));
    assert.equal('leftOut' in forMira, false);
  });

  it("an agent that observes the other is shown its own rows, marked", async () => {
    const h = await boot();
    const ctx = h.surface.ctx as unknown as { observes(observer: string, observed: string): boolean };
    assert.equal(ctx.observes('mira', 'oren'), false, 'residents observe no one');
    (h.history as unknown as { ctx: ModuleContext }).ctx = { ...h.surface.ctx, windowStatusOf: h.surface.ctx.windowStatusOf, observes: () => true } as ModuleContext;
    const forMira = await h.call('extract', {}, 'mira');
    assert.ok(marks(forMira.messages).some(([id, mark]) => id === h.ids.orens && mark === 'not-shown'));
    assert.equal('leftOut' in forMira, false);
  });

  it('extract around an id carries the same marks, and an id left out reads as not there', async () => {
    const h = await boot();
    const { both, undone, out, orens, miras } = h.ids;
    const around = await h.call('extract', { aroundId: undone, before: 5, after: 5, allChannels: true }, 'mira');
    assert.deepEqual(marks(around.messages), [[both, '-'], [undone, 'undone'], [miras, '-'], [out, 'not-shown']]);
    assert.equal(around.leftOut, 1);
    const refused = await h.history.handleToolCall({ id: 't', name: 'extract', input: { aroundId: orens, allChannels: true }, callerAgentName: 'mira' } as ToolCall);
    assert.equal(refused.success, false);
    assert.match(String(refused.error), /no message in your history has the id/);
    const forOren = await h.call('extract', { aroundId: orens, before: 1, after: 0, allChannels: true }, 'oren');
    assert.deepEqual(marks(forOren.messages), [[undone, '-'], [orens, '-']]);
  });

  it('search marks its matches, and counts what it left out', async () => {
    const h = await boot();
    const { both, undone, out, miras } = h.ids;
    const found = await h.call('search', { query: 'zz-' }, 'mira');
    assert.deepEqual(marks(found.matches), [[both, '-'], [undone, 'undone'], [miras, '-'], [out, 'not-shown']]);
    assert.equal(found.leftOut, 1);
    assert.equal(found.candidatePoolSize, 5, 'the pool is the record');
    const regex = await h.call('search', { query: 'zz-(u|o)', regex: true }, 'mira');
    assert.deepEqual(marks(regex.matches), [[undone, 'undone'], [out, 'not-shown']]);
  });

  it("semantic_search marks a message hit, and leaves out another agent's own row", async () => {
    const h = await boot();
    const { both, undone, orens } = h.ids;
    const mod = new HistoryModule({ semantic: { url: 'http://127.0.0.1:9', namespace: 'n', syncIntervalMs: 0 } });
    await mod.start(h.surface.ctx);
    mod.bind(h.cm('mira'));
    const internals = mod as unknown as { indexer: { dispose(): void } | null; semanticClient: { search: (q: unknown) => Promise<unknown> } };
    internals.indexer?.dispose();
    internals.indexer = null;
    const hit = (id: string, score: number) => ({ id: `msg:${id}`, score, ts: Date.now() / 1000, channel: 'discord:g1:c1', kind: 'message', level: null, meta: {} });
    internals.semanticClient.search = async () => ({
      namespace: 'n', hits: [hit(undone, 0.9), hit(orens, 0.8), hit(both, 0.7)], count_indexed: 3, timing_ms: { embed: 1, search: 1 },
    });
    const found = await h.call('semantic_search', { query: 'zz' }, 'mira', mod);
    const hits = found.hits as Array<Record<string, unknown>>;
    assert.deepEqual(hits.map((x) => [x.messageId, 'window' in x ? x.window : '-']), [[undone, 'undone'], [both, '-']]);
    assert.equal((found.index as { leftOut?: number }).leftOut, 1);
    assert.equal((found.index as { droppedOffBranch: number }).droppedOffBranch, 0, 'an undone message is on the branch');
    await mod.stop();
  });

  it("the framework offers the lookup: an agent's window status, an unknown agent refused, and who observes whom", async () => {
    const h = await boot({ subconscious: true });
    const ctx = h.surface.ctx;
    assert.equal(ctx.windowStatusOf?.(h.ids.undone), 'undone', "the delivery agent's window: mira's");
    assert.equal(ctx.windowStatusOf?.(h.ids.undone, { forAgent: 'oren' }), 'in');
    assert.equal(ctx.windowStatusOf?.('no-such-row' as MessageId, { forAgent: 'oren' }), 'absent');
    assert.throws(() => ctx.windowStatusOf?.(h.ids.both, { forAgent: 'zz-stranger' }), /Unknown agent: "zz-stranger"/);
    assert.equal(ctx.observes?.('Subconscious', 'mira'), true, "the subconscious's edge reads the residents' slot");
    assert.equal(ctx.observes?.('oren', 'mira'), false);

    // Whose context a context manager is.
    assert.equal(ctx.agentNameOf?.(h.cm('mira')), 'mira');
    assert.equal(ctx.agentNameOf?.(h.cm('oren')), 'oren');
    assert.equal(ctx.agentNameOf?.(h.cm('Subconscious')), 'Subconscious');
    assert.equal(ctx.agentNameOf?.({} as ContextManager), undefined, 'a context that is no live agent\'s');

    // What each agent's view keeps: a resident's leaves out held traffic and
    // the other agents' stored injections, the subconscious's the injections only.
    const row = (metadata: Record<string, unknown>) => ({ id: 'r', participant: 'x', content: [], metadata }) as unknown as StoredMessage;
    const injection = row({ contextInjection: { agent: 'mira', namespace: 'notes', contentHash: 'h', part: 0, parts: 1 } });
    const held = row({ tuneOut: { epochId: 'e1' } });
    assert.equal(ctx.viewKeeps?.(injection), true, "the delivery agent's own injection");
    assert.equal(ctx.viewKeeps?.(injection, { forAgent: 'oren' }), false);
    assert.equal(ctx.viewKeeps?.(injection, { forAgent: 'Subconscious' }), false);
    assert.equal(ctx.viewKeeps?.(held, { forAgent: 'oren' }), false);
    assert.equal(ctx.viewKeeps?.(held, { forAgent: 'Subconscious' }), true, 'the subconscious reads held traffic');
    assert.equal(ctx.viewKeeps?.(row({}), { forAgent: 'oren' }), true);
    assert.throws(() => ctx.viewKeeps?.(held, { forAgent: 'zz-stranger' }), /Unknown agent: "zz-stranger"/);
  });

  it("a row the caller's window holds that its view leaves out isn't shown: another agent's injection is left out, a held row marked (J-AF13)", async () => {
    const h = await boot();
    const ch = { channelId: 'discord:g1:c1' };
    const mark = (agent: string) => ({ agent, namespace: 'notes', contentHash: 'h', part: 0, parts: 1 });
    // A row a tune-out holds from the residents.
    const held = h.internals.addMessage('someone', [text('zz-held')], { ...ch, tuneOut: { epochId: 'e1' } } as MessageMetadata);
    // mira's stored context injection, an own row of hers.
    const injection = storeOwnRow(h.framework.getAgent('mira')!, 'system_context:notes', [text('zz-miras-injection')],
      { ...ch, system: true, kind: 'context-injection', contextInjection: mark('mira') } as MessageMetadata);
    // One from before the audience stamp, stored past the framework and so
    // presented to no one (last, as boot's `out` is): its mark alone names
    // whose it is.
    const legacy = h.cm('mira').addMessage('system_context:notes', [text('zz-miras-legacy-injection')],
      { ...ch, system: true, kind: 'context-injection', contextInjection: mark('mira') } as MessageMetadata);
    // As a window written down from the shared record leaves them in oren's.
    h.cm('oren').presentRows([injection, legacy, held]);
    for (const id of [injection, legacy, held]) assert.equal(h.cm('oren').windowStatusOf(id), 'in', 'the premise: oren\'s window holds it');
    const compiled = JSON.stringify((await h.cm('oren').compile()).messages);
    for (const t of ['zz-miras-injection', 'zz-miras-legacy-injection', 'zz-held']) {
      assert.equal(compiled.includes(t), false, `the premise: oren's requests never carry ${t}`);
    }

    const forOren = await h.call('extract', {}, 'oren');
    const ids = new Map(marks(forOren.messages).map(([id, m]) => [id, m]));
    assert.equal(ids.has(injection), false, "mira's injection is left out for oren");
    assert.equal(ids.has(legacy), false, "and so is her injection from before the stamp");
    assert.equal(ids.get(held), 'not-shown', 'a held row is marked as one oren is never shown');
    assert.equal(forOren.leftOut, 3, "mira's round and both her injections");
    const found = await h.call('search', { query: 'zz-' }, 'oren');
    assert.deepEqual(marks(found.matches).filter(([id]) => id === injection || id === legacy || id === held), [[held, 'not-shown']]);

    // mira is shown her own injection; the one stored past the framework was never presented to her.
    const forMira = await h.call('extract', {}, 'mira');
    const miraMarks = new Map(marks(forMira.messages).map(([id, m]) => [id, m]));
    assert.equal(miraMarks.get(injection), '-');
    assert.equal(miraMarks.get(legacy), 'not-shown');
    // A call no agent made reads the record whole.
    const operator = await h.call('extract', {});
    const all = new Set(marks(operator.messages).map(([id]) => id));
    for (const id of [injection, legacy, held]) assert.ok(all.has(id));
    assert.equal('leftOut' in operator, false);
  });

  it("overview and semantic_search leave out mira's summaries for oren, who doesn't observe her, and not for mira, an operator or an observer (J-AF12)", async () => {
    const h = await boot({ subconscious: true });
    const now = Date.now();
    const createdMs = now - 1_000;
    const entry: TimeRangeSummaryEntry = {
      id: 's1', level: 1, content: 'zz-miras-summary', tokens: 3, startMs: now - 60_000, endMs: now + 60_000,
      firstMessageId: 'a', lastMessageId: 'b', firstSequence: 0, lastSequence: Number.MAX_SAFE_INTEGER, createdMs, sourceIds: [],
    };
    // mira's context, the one the module is bound to, holds one summary.
    Object.assign(h.cm('mira'), {
      getSummariesInRange: () => [entry],
      getMaxSummaryLevel: () => 1,
      getSummary: (id: string) => (id === 's1' ? { id: 's1', level: 1, content: entry.content, tokens: 3, created: createdMs } : null),
    });

    const overview = async (caller?: string) => {
      const data = await h.call('overview', {}, caller);
      const summarized = (data.entries as Array<Record<string, unknown>>).filter((e) => e.summarized === true);
      assert.equal(summarized.length, 1, JSON.stringify(data));
      return { data, entry: summarized[0]! };
    };
    const forOren = await overview('oren');
    assert.equal(forOren.entry.content, null, "oren gets no text of mira's summary");
    assert.equal(forOren.entry.contentLeftOut, true);
    assert.equal(forOren.entry.level, 1, 'its level and counts stay');
    assert.equal(typeof forOren.entry.messageCount, 'number');
    assert.equal(forOren.data.summariesLeftOut, 1);
    assert.equal(JSON.stringify(forOren.data).includes('zz-miras-summary'), false);
    for (const caller of ['mira', undefined, 'Subconscious']) {
      const seen = await overview(caller);
      assert.equal(seen.entry.content, 'zz-miras-summary', `${caller ?? 'an operator'} gets the summary's text`);
      assert.equal('contentLeftOut' in seen.entry, false);
      assert.equal('summariesLeftOut' in seen.data, false);
    }

    const mod = new HistoryModule({ semantic: { url: 'http://127.0.0.1:9', namespace: 'n', syncIntervalMs: 0 } });
    await mod.start(h.surface.ctx);
    mod.bind(h.cm('mira'));
    const internals = mod as unknown as { indexer: { dispose(): void } | null; semanticClient: { search: (q: unknown) => Promise<unknown> } };
    internals.indexer?.dispose();
    internals.indexer = null;
    let searches = 0;
    internals.semanticClient.search = async (q) => {
      searches++;
      const kinds = (q as { kinds?: string[] }).kinds;
      const sum = { id: `sum:s1@${createdMs}`, score: 0.9, ts: entry.startMs / 1000, channel: null, kind: 'summary', level: 1, meta: {} };
      const msg = { id: `msg:${h.ids.both}`, score: 0.8, ts: now / 1000, channel: 'discord:g1:c1', kind: 'message', level: null, meta: {} };
      const hits = kinds?.[0] === 'summary' ? [sum] : [sum, msg];
      return { namespace: 'n', hits, count_indexed: 2, timing_ms: { embed: 1, search: 1 } };
    };
    const semantic = async (caller: string | undefined, input: Record<string, unknown> = {}) => {
      const data = await h.call('semantic_search', { query: 'zz', ...input }, caller, mod);
      return { ids: (data.hits as Array<Record<string, unknown>>).map((x) => x.id), index: data.index as { leftOut?: number } };
    };
    const oren = await semantic('oren');
    assert.deepEqual(oren.ids, [`msg:${h.ids.both}`], 'no sum: hit for oren');
    assert.equal(oren.index.leftOut, 1, 'the summary hit is counted as left out');
    for (const caller of ['mira', undefined, 'Subconscious']) {
      const seen = await semantic(caller);
      assert.deepEqual(seen.ids, ['sum:s1', `msg:${h.ids.both}`], `${caller ?? 'an operator'} gets the summary hit`);
      assert.equal(seen.index.leftOut, undefined);
    }
    // A search of summaries alone keeps nothing for oren, so it isn't searched again deeper.
    searches = 0;
    const onlySummaries = await semantic('oren', { kinds: 'summaries', limit: 1 });
    assert.deepEqual(onlySummaries.ids, []);
    assert.equal(onlySummaries.index.leftOut, 1);
    assert.equal(searches, 1);
    await mod.stop();
  });

  it('the tool descriptions gain the window sentence only with the lookup, and are as they were without it', async () => {
    const bare = new HistoryModule({ semantic: { url: 'http://127.0.0.1:9', namespace: 'n', syncIntervalMs: 0 } });
    const before = bare.getTools();
    const noLookup = { getState: () => null, setState: () => {} } as unknown as ModuleContext;
    await bare.start(noLookup);
    assert.deepEqual(bare.getTools(), before, 'a context without the lookup changes nothing');
    await bare.stop();

    const h = await boot();
    const withLookup = new HistoryModule({ semantic: { url: 'http://127.0.0.1:9', namespace: 'n', syncIntervalMs: 0 } });
    await withLookup.start(h.surface.ctx);
    const tools = new Map(withLookup.getTools().map((t) => [t.name, t.description]));
    const plain = new Map(before.map((t) => [t.name, t.description]));
    for (const name of ['extract', 'search']) {
      assert.ok(tools.get(name)!.startsWith(plain.get(name)!), `${name} keeps its description`);
      assert.match(tools.get(name)!.slice(plain.get(name)!.length), /^ A message that isn't in your context carries `window`/);
    }
    assert.match(tools.get('semantic_search')!, /A message hit that isn't in your context carries `window`/);
    assert.doesNotMatch(tools.get('semantic_search')!, /a message you undid/);
    assert.match(plain.get('semantic_search')!, /a message you undid/);
    assert.match(tools.get('semantic_search')!, /and so are summary hits when the summaries fold another agent's context/);
    // stats is an aggregate over the record and stays as it was. overview's
    // summaries' text is left out for another agent's call that doesn't
    // observe the bound agent (FW-AF-7, J-AF12), so it gains a sentence too,
    // which this test pinned as unchanged before.
    assert.equal(tools.get('stats'), plain.get('stats'), 'stats is unchanged');
    assert.ok(tools.get('overview')!.startsWith(plain.get('overview')!), 'overview keeps its description');
    assert.match(tools.get('overview')!.slice(plain.get('overview')!.length), /^ The summaries fold one agent's context, the one this history is bound to/);
    await withLookup.stop();
  });
});
