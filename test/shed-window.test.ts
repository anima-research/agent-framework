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
  shedNewestTurn(agent: Agent): { descriptor: string; removedIds: MessageId[] } | null;
};

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { residents?: string[]; dir?: string; seed?: (cm: ContextManager) => void } = {}) {
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
    agents: residents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', proseRouting: 'disabled' })),
    modules: [new SurfaceModule()],
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
