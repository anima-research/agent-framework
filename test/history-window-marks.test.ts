/**
 * The history tools read the record, not an agent's window (#291, AF-7).
 * Once agents share a slot the two differ: a co-resident's rounds, a row not
 * presented yet, a turn undone or shed, are in the record and not in the
 * agent's window. With the framework's window lookup
 * (ModuleContext.windowStatusOf), each entry for a row the caller's window
 * doesn't hold says so (`window: 'not-shown' | 'undone'`), and for an
 * agent's call another agent's own rows its window doesn't hold are left
 * out unless it observes that agent (decision 1), counted as `leftOut`. A
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
import type { ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
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
    for (const name of ['stats', 'overview']) assert.equal(tools.get(name), plain.get(name), `${name} is unchanged`);
    await withLookup.stop();
  });
});
