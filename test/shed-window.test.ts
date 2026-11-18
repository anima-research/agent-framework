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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type MessageId, type MessageMetadata, type StoredMessage } from '@animalabs/context-manager';
import { MembraneError, type ContentBlock, type StreamEvent } from '@animalabs/membrane';
import { AgentFramework, residentContextOptions, storeOwnRow } from '../src/index.js';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { until } from './helpers/dendrite.js';
import { WireMembrane, final } from './helpers/wire-membrane.js';
import { branchKey } from '../src/agent.js';

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
  planNewestTurn(agent: Agent, carried?: ReadonlySet<MessageId>, refused?: MessageId, boundary?: 'terminal-refusal'): any;
  applyShed(agent: Agent, plan: any): any;
  quarantinePoisonedHistory(agent: Agent, reason: string, carried: ReadonlySet<MessageId>): void;
  handleHostCommand(server: string, params: any): Promise<any>;
  pendingRequests: any[];
  exhaustionRewinds: Map<string, number>;
  shedNewestTurn(agent: Agent, carried?: ReadonlySet<MessageId>): { descriptor: string; removedIds: MessageId[] } | null;
  updateRewindMarker(agent: Agent, category: string): number;
  rewindEpisode: Map<string, { markerId: MessageId; count: number; category: string }>;
};

// Synthetic planner controls supply an explicit stand-in for compile provenance.
const snapshotCarried = (agent: Agent) => new Set(agent.getContextManager().getAllMessages().map((m) => m.id));

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(opts: { residents?: string[]; dir?: string; failWriteDown?: boolean; autoRewind?: boolean; seed?: (cm: ContextManager) => void } = {}) {
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
      agents: residents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, allowedTools: 'all', refusalHandling: { autoRewind: opts.autoRewind ?? false, maxRewinds: 1 }, proseRouting: 'disabled' })),
      modules: [new SurfaceModule()],
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      exhaustedTurnRearmMs: false,
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

it('legacy refusal recovery removes the newest own-row actually sent by compile, not an older owned row', async () => {
  const h = await boot({ failWriteDown: true, autoRewind: true });
  const older = storeOwnRow(h.agent('mira'), 'user', [text('legacy-older-keep')]);
  const poison = storeOwnRow(h.agent('oren'), 'oren', [text('legacy-newer-poison')]);
  const refusal = final([text('legacy-refused-reply')]); refusal.stopReason = 'refusal';
  h.membrane.script('mira', refusal);
  h.framework.start();
  assert.equal(h.framework.nudgeAgent('mira').ok, true);
  await until(() => h.membrane.callsFor('mira').length === 2
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'legacy refusal and repaired retry complete');
  const [failed, retry] = h.membrane.callsFor('mira').map((r) => JSON.stringify(r.messages));
  assert.match(failed!, /legacy-older-keep/);
  assert.match(failed!, /legacy-newer-poison/, 'legacy compile really sends the co-resident own-row without an observe edge');
  assert.match(retry!, /legacy-older-keep/, 'do not sacrifice older history while poison survives');
  assert.doesNotMatch(retry!, /legacy-newer-poison|legacy-refused-reply/);
  assert.ok(h.cm('mira').getMessage(older));
  assert.equal(h.cm('mira').getMessage(poison), null);
  assert.equal(h.cm('mira').windowMode(), 'legacy', 'no conversion to presented mode');
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
    h.framework.start();
    h.framework.pushEvent(input('before-question', ['mira']));
    await until(() => h.membrane.callsFor('mira').length === 1
      && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'before-shed turn complete');
    const beforeWire = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
    for (const witness of ['exchange-call', 'exchange-result', 'exchange-signature', 'exchange-narration']) {
      assert.ok(beforeWire.includes(witness), `before-wire carries ${witness}`);
    }
    for (const id of [call, result]) assert.notEqual(h.cm('oren').ordinalOf(id), undefined, 'other resident really held the exchange');
    const other = await h.compiled('oren');
    // The completed reply and its input are newer; shed both first.
    h.internals.shedNewestTurn(h.agent('mira'));
    h.internals.shedNewestTurn(h.agent('mira'));
    const shed = h.internals.shedNewestTurn(h.agent('mira'));
    assert.ok(shed?.removedIds.includes(call) && shed.removedIds.includes(result));
    h.framework.pushEvent(input('next-question', ['mira']));
    await until(() => h.membrane.callsFor('mira').length === 2
      && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'next turn complete');
    const sent = JSON.stringify(h.membrane.callsFor('mira')[1]!.messages);
    assert.doesNotMatch(sent, /exchange-call|exchange-result|exchange-signature|exchange-narration/);
    assert.match(sent, /keep-before/);
    assert.match(sent, /next-question/);
    if (gap) assert.match(sent, /intervening-notice/);
    assert.equal(await h.compiled('oren'), other);
    assert.ok(h.cm('mira').getMessage(call));
    assert.ok(h.cm('mira').getMessage(result));
  });
}

// Option B intentionally retires the adjacent-whatever-IDs policy and all
// result-only/call-only fallback assertions. The old vectors below now must
// decline with byte-identical raw and window snapshots (see docs/recovery-b.md).
const callBlock = (id: string) => ({ type: 'tool_use', id, name: 'shell', input: {} }) as ContentBlock;
const resultBlock = (id?: string) => ({ type: 'tool_result', ...(id === undefined ? {} : { toolUseId: id }), content: 'result-payload' }) as ContentBlock;
const snapshot = (h: Awaited<ReturnType<typeof boot>>) => JSON.stringify({
  raw: h.cm('mira').getAllMessages(), mira: h.cm('mira').getPresentedMessages(),
  oren: h.cm('oren').getPresentedMessages(), mode: h.cm('mira').windowMode(),
});
const assertDecline = (h: Awaited<ReturnType<typeof boot>>, carried?: Set<MessageId>) => {
  const before = snapshot(h);
  const plan = h.internals.planNewestTurn(h.agent('mira'), carried);
  assert.equal(plan.kind, 'unsupported', JSON.stringify(plan));
  assert.equal(h.internals.shedNewestTurn(h.agent('mira'), carried), null);
  assert.equal(snapshot(h), before, 'no endpoint, notice or other window changes');
  assert.equal(h.internals.pendingRequests.length, 0);
  assert.equal(h.internals.exhaustionRewinds.size, 0);
  assert.equal(h.internals.rewindEpisode.size, 0);
};

for (const legacy of [false, true]) {
  for (const shape of ['mismatch', 'missing', 'incomplete', 'reused', 'duplicate-result', 'ordinary', 'marker', 'change', 'hidden-notice', 'mixed', 'result-marker', 'call-marker', 'newer-barrier'] as const) {
    for (const carried of [false, true]) it(`bounded decline (${shape}, legacy:${legacy}, carried:${carried})`, async () => {
      const h = await boot({ failWriteDown: legacy });
      const call = h.internals.addMessage('mira', [callBlock('a'), ...(shape === 'incomplete' ? [callBlock('b')] : [])], shape === 'call-marker' ? { system: true, kind: 'refusal-rewind' } : undefined);
      if (shape === 'reused') h.internals.addMessage('mira', [callBlock('a')]);
      if (shape === 'ordinary') h.internals.addMessage('user', [text('barrier')]);
      if (shape === 'marker') h.internals.updateRewindMarker(h.agent('mira'), 'test');
      const change = shape === 'change' ? h.internals.addMessage('user', [text('loaded change placeholder')], { system: true }) : undefined;
      if (shape === 'hidden-notice') {
        const id = h.internals.addMessage('user', [text('held notice')], { system: true, tuneOut: { epochId: 'held' } } as MessageMetadata);
        if (!legacy) h.cm('mira').presentRows([id]);
      }
      const result = h.internals.addMessage('user', [resultBlock(shape === 'missing' ? undefined : shape === 'mismatch' ? 'x' : 'a'),
        ...(shape === 'mixed' ? [callBlock('b')] : [])], (shape === 'result-marker' || shape === 'newer-barrier') ? { system: true, kind: 'refusal-rewind' } : undefined);
      if (shape === 'mixed') h.internals.addMessage('user', [resultBlock('b')]);
      if (shape === 'duplicate-result') h.internals.addMessage('user', [resultBlock('a')]);
      if (change) {
        // CM refuses new system changes inside an incomplete round. Simulate
        // a loaded corrupt snapshot, not a normal writer of this layout.
        const cm = h.cm('mira');
        const inject = (rows: StoredMessage[]) => rows.map((m) => m.id === change
          ? { ...m, content: [{ type: 'system_change', addSystem: ['metric'] }] as unknown as ContentBlock[] } : m);
        const raw = cm.getAllMessages.bind(cm), presented = cm.getPresentedMessages.bind(cm);
        cm.getAllMessages = () => inject(raw());
        cm.getPresentedMessages = () => inject(presented());
      }
      const before = snapshot(h);
      const plan = h.internals.planNewestTurn(h.agent('mira'), carried ? new Set([call, ...(shape === 'mixed' ? [result] : [])]) : undefined);
      assert.equal(plan.kind, 'unsupported');
      if (shape === 'change') assert.equal(plan.reason, 'barrier between tool endpoints');
      if (shape === 'newer-barrier') assert.equal(plan.reason, 'hidden content or marker in tool body');
      assert.equal(h.internals.shedNewestTurn(h.agent('mira'), carried ? new Set([call]) : undefined), null);
      assert.equal(snapshot(h), before);
      // The quarantine caller must not count or retry even at maxRewinds=1.
      h.internals.quarantinePoisonedHistory(h.agent('mira'), 'invalid request', snapshotCarried(h.agent('mira')));
      assert.equal(snapshot(h), before);
      assert.equal(h.internals.pendingRequests.length, 0);
      assert.equal(h.internals.exhaustionRewinds.size, 0);
      assert.equal(h.internals.rewindEpisode.size, shape === 'marker' ? 1 : 0);
    });
  }

  for (const gap of [false, true]) it(`real legacy write-down failure / presented removal (legacy:${legacy}, gap:${gap})`, async () => {
    const h = await boot({ failWriteDown: legacy });
    const call = h.internals.addMessage('mira', [callBlock('a'), callBlock('b')]);
    const r1 = h.internals.addMessage('user', [resultBlock('a')]);
    const notice = gap ? h.internals.addMessage('user', [text('one-shot-notice')], { system: true }) : undefined;
    const r2 = h.internals.addMessage('user', [resultBlock('b')]);
    for (const id of [call, r1, r2, ...(notice ? [notice] : [])]) assert.notEqual(h.cm('oren').ordinalOf(id), undefined);
    const before = snapshot(h);
    const oren = await h.compiled('oren');
    const rec = h.internals.shedNewestTurn(h.agent('mira'));
    if (legacy && gap) {
      assert.equal(rec, null);
      assert.equal(snapshot(h), before, 'raw notice-gap is zero-write, no forced presentation');
      assert.equal(h.cm('mira').windowMode(), 'legacy');
    } else {
      assert.deepEqual(rec?.removedIds, [r2, r1, call]);
      if (legacy) for (const id of [call, r1, r2]) {
        assert.equal(h.cm('mira').getMessage(id), null);
        assert.equal(h.cm('oren').ordinalOf(id), undefined, 'raw removal propagates');
      }
      else {
        assert.equal(await h.compiled('oren'), oren);
        if (notice) assert.equal(h.cm('mira').windowStatusOf(notice), 'in');
      }
    }
  });

  for (const carriedMixed of [false, true]) it(`mixed chain reverse closure, legacy:${legacy}, mixed carried:${carriedMixed}`, async () => {
    const h = await boot({ failWriteDown: legacy });
    const call = h.internals.addMessage('mira', [callBlock('a')]);
    const mixed = h.internals.addMessage('user', [resultBlock('a'), callBlock('b')]);
    h.internals.addMessage('user', [resultBlock('b')]);
    assertDecline(h, new Set([call, ...(carriedMixed ? [mixed] : [])]));
  });

  for (const hidden of ['held', 'foreign', 'system', 'marker'] as const) it(`non-tool sibling cannot borrow result eligibility (${hidden}, legacy:${legacy})`, async () => {
    const h = await boot({ failWriteDown: legacy });
    const cm = h.cm('mira');
    const call = h.internals.addMessage('mira', [callBlock('a')]);
    const store = (cm as any).messageStore;
    const result = store.append('user', [resultBlock('a')], {}, undefined, { bodyGroupId: 'hidden-result', shardIndex: 0 }).id;
    const metadata = hidden === 'foreign' ? { contextInjection: { agent: 'oren', namespace: 'test', contentHash: 'x', part: 0, parts: 1 } }
      : hidden === 'held' ? { tuneOut: { epochId: 'held' } } : hidden === 'marker' ? { kind: 'refusal-rewind' } : { system: true };
    store.append('user', [text('non-tool-sibling')], metadata, undefined, { bodyGroupId: 'hidden-result', shardIndex: 1 });
    if (!legacy) cm.presentRows([result]);
    assertDecline(h, new Set([call]));
  });
}

it('sharded call and result positives keep whole signed bodies, including stored uncarried results', async () => {
  const h = await boot();
  const cm = h.cm('mira');
  const store = (cm as any).messageStore;
  const ids = [
    store.append('mira', [{ type: 'thinking', thinking: '', signature: 'whole-signature' }], {}, undefined, { bodyGroupId: 'call', shardIndex: 0 }).id,
    store.append('mira', [callBlock('a'), callBlock('b')], {}, undefined, { bodyGroupId: 'call', shardIndex: 1 }).id,
    store.append('user', [resultBlock('a')], { tuneOut: { epochId: 'held' } }, undefined, { bodyGroupId: 'result', shardIndex: 0 }).id,
    store.append('user', [resultBlock('b')], { tuneOut: { epochId: 'held' } }, undefined, { bodyGroupId: 'result', shardIndex: 1 }).id,
  ];
  cm.presentRows([ids[0], ids[2]]);
  const rec = h.internals.shedNewestTurn(h.agent('mira'), new Set([ids[0]]));
  assert.deepEqual(rec?.removedIds, [...ids].reverse());
});

it('descriptor counts dominant signed/input/UTF-8 bytes and multiple images, excluding retained notice', async () => {
  const h = await boot();
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } } as ContentBlock;
  const call = h.internals.addMessage('mira', [
    { type: 'thinking', thinking: '', signature: 's'.repeat(16000) } as ContentBlock,
    { ...callBlock('a'), input: { value: '界\n"\\'.repeat(8000) } } as ContentBlock, image,
  ]);
  const notice = h.internals.addMessage('user', [text('excluded'.repeat(80000)), image], { system: true });
  const result = h.internals.addMessage('user', [resultBlock('a'), image, image]);
  const bytes = [call, result].reduce((n, id) => n + Buffer.byteLength(JSON.stringify(h.cm('mira').getMessage(id)!.content)), 0);
  const rec = h.internals.shedNewestTurn(h.agent('mira'));
  assert.deepEqual(rec?.removedIds, [result, call]);
  assert.equal(rec?.descriptor, `a tool exchange (~${Math.round(bytes / 1024)}KB, 3 image(s))`);
  assert.equal(h.cm('mira').windowStatusOf(notice), 'in');
});

for (const pending of ['pending', 'queued', 'assistant', 'live'] as const) it(`settled boundary declines known ${pending} work`, async () => {
  const h = await boot();
  h.internals.addMessage('user', [text('eligible')]);
  const guard = h.agent('mira').toolResultGuard;
  if (pending === 'pending') Object.defineProperty(guard, 'hasPending', { get: () => true });
  if (pending === 'queued') Object.defineProperty(guard, 'idle', { get: () => false });
  if (pending === 'assistant') (h.framework as any).pendingAssistantBlocks.set('mira', [callBlock('a')]);
  if (pending === 'live') Object.defineProperty(h.agent('mira'), 'state', { get: () => ({ status: 'streaming' }) });
  assertDecline(h);
  // Restore before shutdown: tests do not ask the guard to settle for planning.
  if (pending === 'assistant') (h.framework as any).pendingAssistantBlocks.clear();
});

for (const fault of ['pre', 'post', 'unknown', 'marker'] as const) it(`quarantine stops without retry on ${fault}-write failure`, async () => {
  const h = await boot();
  const id = h.internals.addMessage('user', [text('eligible')]);
  const cm = h.cm('mira');
  const retract = cm.retractRows.bind(cm);
  let writes = 0;
  cm.retractRows = (...args) => {
    writes++;
    if (fault === 'pre') throw new Error('pre-write');
    retract(...args);
    if (fault !== 'marker') throw new Error('post-commit');
  };
  if (fault === 'unknown') cm.windowStatusOf = () => { throw new Error('unreadable'); };
  if (fault === 'marker') h.internals.updateRewindMarker = () => { throw new Error('marker'); };
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'invalid request', snapshotCarried(h.agent('mira')));
  assert.equal(writes, 1, 'no blind replay');
  assert.equal(h.internals.pendingRequests.length, 0);
  assert.equal(h.internals.rewindEpisode.size, 0);
  assert.equal(h.internals.exhaustionRewinds.get('mira') ?? 0, fault === 'post' || fault === 'marker' ? 1 : 0);
  if (fault !== 'unknown') assert.equal(cm.windowStatusOf(id), fault === 'pre' ? 'in' : 'undone');
});

for (const caller of ['auto', 'forced', 'exhaustion'] as const) {
  for (const supported of [false, true]) it(`live ${caller} caller, notice retention and retry disposition (supported:${supported})`, async (t) => {
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const h = await boot({ autoRewind: caller === 'auto' });
    h.internals.addMessage('user', [text('keep-prefix')]);
    const call = h.internals.addMessage('mira', [
      { type: 'thinking', thinking: '', signature: 'caller-signature' } as ContentBlock, text('caller-narration'), callBlock('a'), callBlock('b'),
    ]);
    const now = Date.now();
    const clock = h.internals.addMessage('user', [text('retained-clock')], {
      system: true, kind: 'clock', clock: { at: now, onBoundary: true, zone: 'UTC' },
    } as MessageMetadata);
    const r1 = h.internals.addMessage('user', [resultBlock('a')]);
    const oneShot = h.internals.addMessage('user', [text('one-shot-lifecycle')], { system: true, kind: 'tool-lifecycle' });
    const r2 = h.internals.addMessage('user', [resultBlock(supported ? 'b' : 'wrong')]);
    const ids = [call, clock, r1, oneShot, r2];
    for (const id of ids) assert.notEqual(h.cm('oren').ordinalOf(id), undefined, 'other resident holds same exchange BEFORE');
    const beforeWire = JSON.stringify((await h.cm('mira').compile(undefined, undefined, { dryRun: true })).messages);
    for (const value of ['caller-signature', 'caller-narration', 'result-payload', 'one-shot-lifecycle', 'retained-clock']) assert.match(beforeWire, new RegExp(value));
    const other = await h.compiled('oren');
    const otherRows = ids.map((id) => ({ row: h.cm('oren').getMessage(id), ordinal: h.cm('oren').ordinalOf(id) }));
    const rawBefore = JSON.stringify(h.cm('mira').getAllMessages());
    let lateNotice: MessageId | undefined;
    if (caller !== 'exhaustion') {
      const refusal = final([text('refused-reply-payload')]);
      refusal.stopReason = 'refusal';
      h.membrane.script('mira', refusal);
      h.membrane.onRequest = (name) => {
        if (name === 'mira' && lateNotice === undefined) lateNotice = h.internals.addMessage('user', [text('after-compile-notice')], { system: true });
      };
    }
    const failedRequests: string[] = [];
    if (caller === 'exhaustion') {
      const original = h.membrane.streamYielding.bind(h.membrane);
      h.membrane.streamYielding = (request, options) => {
        if (failedRequests.length >= 3) return original(request, options);
        failedRequests.push(JSON.stringify(request.messages));
        throw new MembraneError({ type: 'invalid_request', message: 'pre-stream invalid request', retryable: false, httpStatus: 400 } as never);
      };
    }
    h.framework.start();
    if (caller === 'exhaustion') {
      // Real start/compile/provider failure: the terminal start must release
      // its logical token before the production exhaustion breaker can plan.
      for (let i = 0; i < 3; i++) {
        assert.equal(h.framework.nudgeAgent('mira').ok, true);
        await until(() => h.traces.filter((e) => e.type === 'inference:exhausted').length === i + 1
          && !(h.framework as any).logicalTurnAlive(h.agent('mira')),
        'pre-stream failure, recovery decision and token release');
      }
      assert.equal(failedRequests.length, 3);
      for (const request of failedRequests) assert.match(request, /caller-signature.*caller-narration/);
      assert.ok(lines.some((line) => line.includes(supported ? 'auto-quarantined' : 'unsupported: missing or ambiguous call body')),
        'witness the actual breaker disposition, not just unchanged rows');
    } else {
      const command = await h.internals.handleHostCommand('test', { command: caller === 'forced' ? 'unstick' : 'nudge', agentName: 'mira', maxRewinds: 1 });
      assert.equal(command.ok, caller === 'forced' ? supported : true);
      if (caller === 'forced' && !supported) assert.match(command.error, /Cannot unstick/);
    }
    await h.framework.runUntilIdle();
    const expected = supported ? (caller === 'exhaustion' ? 1 : 2) : (caller === 'auto' ? 1 : 0);
    await until(() => h.membrane.callsFor('mira').length >= expected
      && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'recovery decision and terminal turn');
    const calls = h.membrane.callsFor('mira');
    if (supported) {
      assert.equal(calls.length, caller === 'exhaustion' ? 1 : 2);
      const sent = JSON.stringify(calls.at(-1)!.messages);
      assert.doesNotMatch(sent, /caller-signature|caller-narration|result-payload|refused-reply-payload/);
      for (const value of ['keep-prefix', 'one-shot-lifecycle', 'retained-clock', 'The 1 most recent']) assert.match(sent, new RegExp(value));
      if (lateNotice) assert.match(sent, /after-compile-notice/);
      assert.equal((h.framework as any).lastClockOf(h.agent('mira')).lastClockAt, now, 'retained clock is still the baseline');
      for (const id of [clock, oneShot]) assert.equal(h.cm('mira').windowStatusOf(id), 'in');
      for (const id of [call, r1, r2]) assert.equal(h.cm('mira').windowStatusOf(id), 'undone');
      const markers = h.cm('mira').getAllMessages().filter((m) => m.metadata?.kind === 'refusal-rewind');
      assert.equal(markers.length, 1);
      const shedTraces = h.traces.filter((t) => t.type === 'presentation:retracted' && t.reason === 'shed');
      assert.equal(shedTraces.length, 1, 'one bounded step for entire round');
    } else {
      assert.equal(calls.length, caller === 'auto' ? 1 : 0, 'unsupported queues no probe or rewind retry');
      for (const id of ids) assert.equal(h.cm('mira').windowStatusOf(id), 'in');
      assert.equal(h.internals.rewindEpisode.size, 0);
      assert.equal(h.internals.exhaustionRewinds.size, 0);
      if (caller === 'auto') assert.ok(h.cm('mira').getAllMessages().some((m) => textOf(m) === 'refused-reply-payload'), 'unsupported leaves refused reply untouched too');
      else assert.equal(JSON.stringify(h.cm('mira').getAllMessages()), rawBefore);
    }
    // New shared notices/replies may be stored while Mira is active. The
    // pre-existing rows and Oren's compile must remain untouched by shedding.
    assert.deepEqual(ids.map((id) => ({ row: h.cm('oren').getMessage(id), ordinal: h.cm('oren').ordinalOf(id) })), otherRows, 'all original other-window bodies and ordinals are unchanged');
    if (caller === 'exhaustion') assert.equal(await h.compiled('oren'), other);
  });
}

for (const supported of [false, true]) it(`real terminal error stream declines before planning regardless of ID closure (supported:${supported})`, async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const h = await boot();
  const call = h.internals.addMessage('mira', [callBlock('a')]);
  const notice = h.internals.addMessage('user', [text('error-stream-one-shot')], { system: true });
  const result = h.internals.addMessage('user', [resultBlock(supported ? 'a' : 'wrong')]);
  const original = h.membrane.streamYielding.bind(h.membrane);
  const requests: string[] = [];
  let failures = 0;
  h.membrane.streamYielding = (request, options) => {
    requests.push(JSON.stringify(request.messages));
    if (failures++ >= 3) return original(request, options);
    const error = new MembraneError({ type: 'invalid_request', message: 'synthetic invalid request', retryable: false, httpStatus: 400 } as never);
    return { isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
      provideToolResults() { throw new Error('not waiting'); }, cancel() {},
      async *[Symbol.asyncIterator]() { yield { type: 'error', error } as StreamEvent; },
    } as any;
  };
  h.framework.start();
  for (let i = 0; i < 3; i++) {
    const ack = await h.internals.handleHostCommand('test', { command: 'nudge', agentName: 'mira' });
    assert.equal(ack.ok, true);
    await h.framework.runUntilIdle();
    await until(() => requests.length >= i + 1 && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'error frame teardown');
  }
  assert.ok(lines.some((line) => line.includes('stopped: active stream; failed request boundary unavailable')), 'breaker was invoked and declined before the planner');
  assert.equal(requests.length, 3, 'active-stream exhaustion declines even a complete exchange');
  for (const request of requests.slice(0, 3)) assert.match(request, /tool_use.*a/);
  for (const id of [call, result]) assert.equal(h.cm('mira').windowStatusOf(id), 'in');
  assert.equal(h.cm('mira').windowStatusOf(notice), 'in');
});

it('refused-reply cleanup failure accounts for removal but stops before marker/retry', async () => {
  const h = await boot();
  const call = h.internals.addMessage('mira', [callBlock('a')]);
  const result = h.internals.addMessage('user', [resultBlock('a')]);
  const refused = final([text('cleanup-failure-reply')]);
  refused.stopReason = 'refusal';
  h.membrane.script('mira', refused);
  const cm = h.cm('mira');
  cm.removeMessage = () => { throw new Error('cleanup failure'); };
  cm.removeMessages = () => { throw new Error('cleanup failure'); };
  h.framework.start();
  const ack = await h.internals.handleHostCommand('test', { command: 'unstick', agentName: 'mira', maxRewinds: 1 });
  assert.equal(ack.ok, true);
  await until(() => h.membrane.callsFor('mira').length === 1
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'cleanup failure and give-up complete');
  assert.equal(h.membrane.callsFor('mira').length, 1);
  assert.equal(h.internals.rewindEpisode.size, 0);
  for (const id of [call, result]) assert.equal(cm.windowStatusOf(id), 'undone');
  const outcome = await h.internals.handleHostCommand('test', { command: 'unstick-outcome', agentName: 'mira' });
  assert.equal(outcome.outcome, 'gave-up');
  assert.equal(outcome.rewinds, 1, 'actual exchange removal is counted even though cleanup failed');
  assert.ok(cm.getAllMessages().some((m) => textOf(m) === 'cleanup-failure-reply'));
});

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


// Defensive heterogeneous stored bodies: the normal chunker repeats metadata.
// Use the real store/read path (including CM validation), not a patched snapshot.
for (const mode of ['windowed', 'raw'] as const) {
  for (const hidden of ['held', 'foreign'] as const) {
    for (const gap of [false, true]) {
      it(`hidden tool-call shard cannot borrow narration visibility (${mode}, ${hidden}, gap: ${gap})`, async () => {
        const h = await boot({ failWriteDown: mode === 'raw' });
        const cm = h.cm('mira');
        const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: MessageId } } }).messageStore;
        const hiddenMetadata = hidden === 'held' ? { tuneOut: { epochId: 'held' } }
          : { contextInjection: { agent: 'oren', namespace: 'test', contentHash: 'test', part: 0, parts: 1 } };
        const narration = store.append('mira', [text('visible narration')], {}, undefined, { bodyGroupId: 'hidden-call', shardIndex: 0 }).id;
        const call = store.append('mira', [{ type: 'tool_use', id: 'hidden-a', name: 'shell', input: {} }], hiddenMetadata, undefined,
          { bodyGroupId: 'hidden-call', shardIndex: 1 }).id;
        if (mode === 'windowed') cm.presentRows([narration]);
        const notice = gap ? h.internals.addMessage('user', [text('hidden-call-gap')], { system: true }) : undefined;
        const result = h.internals.addMessage('user', [{ type: 'tool_result', toolUseId: 'hidden-a', content: 'visible result' } as ContentBlock]);
        assert.match(await h.compiled('mira'), /visible narration/);
        assert.doesNotMatch(await h.compiled('mira'), /tool_use/);
        assertDecline(h);
        for (const id of [narration, call, ...(notice ? [notice] : [])]) {
          assert.ok(cm.getMessage(id), 'the complete call body and notice remain');
          if (mode === 'windowed') assert.equal(cm.windowStatusOf(id), 'in');
        }
      });
    }
  }

}

for (const mode of ['windowed', 'raw'] as const) {
  it(`visible whitespace cannot borrow hidden shard content (${mode})`, async () => {
    const h = await boot({ failWriteDown: mode === 'raw' });
    const before = h.internals.addMessage('user', [text('eligible prefix')]);
    const cm = h.cm('mira');
    const store = (cm as unknown as { messageStore: { append: (p: string, c: unknown[], m?: unknown, cb?: unknown, extra?: unknown) => { id: MessageId } } }).messageStore;
    const first = store.append('user', [text('   ')], {}, undefined, { bodyGroupId: 'empty-visible', shardIndex: 0 }).id;
    const last = store.append('user', [text('held nonempty')], { tuneOut: { epochId: 'held' } }, undefined,
      { bodyGroupId: 'empty-visible', shardIndex: 1 }).id;
    if (mode === 'windowed') cm.presentRows([first]);
    assert.doesNotMatch(await h.compiled('mira'), /held nonempty/);
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [before]);
    for (const id of [first, last]) {
      assert.ok(cm.getMessage(id));
      if (mode === 'windowed') assert.equal(cm.windowStatusOf(id), 'in');
    }
  });
}

for (const caller of ['auto', 'forced', 'exhaustion'] as const) it(`legacy notice-gap ${caller} caller is zero-write and never forces conversion`, async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const h = await boot({ failWriteDown: true, autoRewind: caller === 'auto' });
  const call = h.internals.addMessage('mira', [callBlock('a')]);
  const notice = h.internals.addMessage('user', [text('legacy-one-shot')], { system: true });
  const result = h.internals.addMessage('user', [resultBlock('a')]);
  const before = snapshot(h);
  if (caller !== 'exhaustion') {
    const refusal = final([text('legacy-refused-reply')]); refusal.stopReason = 'refusal';
    h.membrane.script('mira', refusal);
  }
  h.framework.start();
  if (caller === 'exhaustion') {
    // Synthetic terminal control with explicit compile-history stand-in.
    const history = { carriedBodies: new Set([call, result]), branch: branchKey(h.cm('mira').currentBranchRef()) };
    for (let i = 0; i < 3; i++) (h.framework as any).emitTrace({ type: 'inference:exhausted', agentName: 'mira',
      error: 'invalid request', errorType: 'invalid_request', httpStatus: 400 }, history);
  } else {
    const ack = await h.internals.handleHostCommand('test', { command: caller === 'auto' ? 'nudge' : 'unstick', agentName: 'mira' });
    assert.equal(ack.ok, caller === 'auto');
    if (caller === 'forced') assert.match(ack.error, /legacy removal is not contiguous/);
  }
  await until(() => h.membrane.callsFor('mira').length === (caller === 'auto' ? 1 : 0)
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'legacy decline complete');
  if (caller !== 'forced') assert.ok(lines.some((line) => line.includes('legacy removal is not contiguous')), 'actual planner decline, not an uninvoked breaker');
  assert.equal(h.membrane.callsFor('mira').length, caller === 'auto' ? 1 : 0);
  assert.equal(h.cm('mira').windowMode(), 'legacy');
  assert.equal(h.internals.rewindEpisode.size, 0);
  assert.equal(h.internals.exhaustionRewinds.size, 0);
  for (const id of [call, notice, result]) assert.ok(h.cm('mira').getMessage(id));
  if (caller !== 'auto') assert.equal(snapshot(h), before);
  else assert.ok(h.cm('mira').getAllMessages().some((m) => textOf(m) === 'legacy-refused-reply'));
});

it('forced recovery re-plans after a successful preflight and gives up on a newly mixed body', async () => {
  const h = await boot();
  const call = h.internals.addMessage('mira', [callBlock('a')]);
  const result = h.internals.addMessage('user', [resultBlock('a')]);
  const refusal = final([text('changed-history-refused-reply')]); refusal.stopReason = 'refusal';
  h.membrane.script('mira', refusal);
  h.membrane.onRequest = () => h.cm('mira').editMessage(result, [resultBlock('a'), callBlock('b')]);
  h.framework.start();
  const ack = await h.internals.handleHostCommand('test', { command: 'unstick', agentName: 'mira' });
  assert.equal(ack.ok, true, 'initial supported preflight');
  await until(() => h.membrane.callsFor('mira').length === 1
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 're-plan decline and forced give-up complete');
  assert.equal(h.membrane.callsFor('mira').length, 1, 'no unchanged immediate retry');
  const outcome = await h.internals.handleHostCommand('test', { command: 'unstick-outcome', agentName: 'mira' });
  assert.equal(outcome.outcome, 'gave-up');
  assert.equal(outcome.rewinds, 0);
  for (const id of [call, result]) assert.equal(h.cm('mira').windowStatusOf(id), 'in');
  assert.ok(h.cm('mira').getAllMessages().some((m) => textOf(m) === 'changed-history-refused-reply'));
});

for (const legacy of [false, true]) for (const owned of [false, true]) it(`native audience and context ownership cannot be borrowed (legacy:${legacy}, owned:${owned})`, async () => {
  const h = await boot({ failWriteDown: legacy });
  const cm = h.cm('mira');
  const call = h.internals.addMessage('mira', [callBlock('a')]);
  const result = cm.addMessage('user', [resultBlock('a')], { audience: owned ? ['mira', 'oren'] : ['oren'], ...(owned ? { ownRowOf: 'oren' } : {}) } as MessageMetadata);
  if (!legacy) cm.presentRows([result]); // a loaded/write-down body, not a normal arrival
  assertDecline(h, new Set([call]));
});

it('live pre-stream legacy quarantine is one raw removal without forced write-down, with a truthful marker', async () => {
  const h = await boot({ failWriteDown: true });
  const call = h.internals.addMessage('mira', [callBlock('a')]);
  const result = h.internals.addMessage('user', [resultBlock('a')]);
  const original = h.membrane.streamYielding.bind(h.membrane);
  let failures = 0;
  h.membrane.streamYielding = (request, options) => {
    if (failures++ >= 3) return original(request, options);
    throw new MembraneError({ type: 'invalid_request', message: 'pre-stream legacy invalid request', retryable: false, httpStatus: 400 } as never);
  };
  h.framework.start();
  for (let i = 0; i < 3; i++) {
    assert.equal(h.framework.nudgeAgent('mira').ok, true);
    await until(() => h.traces.filter((e) => e.type === 'inference:exhausted').length === i + 1
      && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'legacy pre-stream failure and recovery');
  }
  await until(() => h.membrane.callsFor('mira').length === 1
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'legacy repaired retry completes');
  const retry = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
  assert.doesNotMatch(retry, /tool_use|result-payload/);
  assert.match(retry, /The 1 most recent/);

  assert.equal(h.cm('mira').windowMode(), 'legacy');
  for (const id of [call, result]) {
    assert.equal(h.cm('mira').getMessage(id), null);
    assert.equal(h.cm('oren').ordinalOf(id), undefined);
  }
  const marker = h.cm('mira').getAllMessages().find((m) => m.metadata?.kind === 'refusal-rewind')!;
  assert.match(textOf(marker), /originals were removed from the raw record/);
});

// Known framework ownership is busy even before/after Agent.status changes.
// Refusal may recover its terminal owner; pre-stream exhaustion must first release it.
function recoveryState(h: Awaited<ReturnType<typeof boot>>) {
  const fw = h.framework as any;
  return {
    rows: snapshot(h), pending: [...fw.pendingRequests],
    forced: [...fw.forcedRewind], counts: [...fw.refusalRewinds],
    exhaustion: [...fw.exhaustionRewinds], episodes: [...fw.rewindEpisode],
    answers: [...fw.unstickAnswers], waiters: [...fw.unstickWaiters],
    calls: h.membrane.callsFor('mira').length, traces: [...h.traces],
  };
}
async function assertKnownBusy(h: Awaited<ReturnType<typeof boot>>) {
  const before = recoveryState(h);
  assert.equal(h.agent('mira').state.status, 'idle');
  assert.equal(h.agent('mira').toolResultGuard.idle, true);
  assert.equal(h.agent('mira').toolResultGuard.hasPending, false);
  const ack = await h.internals.handleHostCommand('test', { command: 'unstick', agentName: 'mira' });
  assert.equal(ack.ok, false, 'known prior work must not open forced recovery');
  assert.match(ack.error, /live assistant round/);
  assert.deepEqual(h.internals.planNewestTurn(h.agent('mira')), { kind: 'unsupported', reason: 'live assistant round' });
  assert.equal(h.internals.shedNewestTurn(h.agent('mira')), null);
  assert.deepEqual(recoveryState(h), before, 'no rows, session, counter, answer, waiter, probe or wake mutation');
}

it('standalone recovery refuses actual asynchronous start before status changes', async () => {
  const h = await boot();
  h.internals.addMessage('user', [text('eligible-start-target')]);
  const agent = h.agent('mira');
  const fw = h.framework as any;
  const start = agent.startStreamWithInjections.bind(agent);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  agent.startStreamWithInjections = async (...args) => { entered = true; await wait; return start(...args); };
  const refusal = final([text('inflight-refused')]);
  refusal.stopReason = 'refusal';
  h.membrane.script('mira', refusal);
  h.framework.start();
  try {
    assert.equal((await h.internals.handleHostCommand('test', { command: 'nudge', agentName: 'mira' })).ok, true);
    await until(() => entered, 'in-flight start');
    assert.equal(fw.hasTurn('mira'), true, 'actual scheduler allocated ownership');
    await assertKnownBusy(h);
    release();
    // runUntilIdle alone sees status=idle before the suspended start resumes.
    await until(() => h.membrane.callsFor('mira').length > 0 && !fw.hasTurn('mira'), 'original turn completes');
    await h.framework.runUntilIdle();
    assert.equal(h.membrane.callsFor('mira').length, 1, 'no recovery probe/retry');
    assert.equal(h.traces.filter((t) => t.type === 'presentation:retracted' && t.reason === 'shed').length, 0);
    assert.ok(h.rowWith('mira', 'inflight-refused'), 'prior refusal is not captured or cleaned up');
    assert.equal(h.cm('mira').windowStatusOf(h.rowWith('mira', 'eligible-start-target')!.id), 'in');
    assert.equal(fw.forcedRewind.size, 0);
  } finally { release(); agent.startStreamWithInjections = start; }
});

for (const location of ['queued', 'parked', 'pass', 'provider-held', 'budget-held'] as const) {
  it(`standalone recovery refuses ${location} continuation without a token or stream`, async () => {
    const h = await boot();
    h.internals.addMessage('user', [text('eligible-continuation-target')]);
    const fw = h.framework as any;
    const request = { agentName: 'mira', reason: 'context_budget_restart', source: 'test', timestamp: Date.now() };
    // Use the actual framework-owned collections and predicates. In particular
    // budget-held is outside hasTurn(), so checking tokens alone is not enough.
    if (location === 'queued') fw.pendingRequests.push(request);
    if (location === 'parked') fw.parkedContinuations.add(request);
    if (location === 'pass') fw.passRequests.add(new Map([['mira', [request]]]));
    if (location === 'provider-held') fw.providerAccelerationCooldowns.set('mira', { heldRequests: [request] });
    if (location === 'budget-held') fw.budgetHolds.set('mira', { turn: request, wakes: [] });
    // Existing episode state must not be reset/replaced by a refused command.
    fw.refusalRewinds.set('mira', 2);
    fw.unstickAnswers.set('mira', { outcome: 'cleared', rewinds: 2 });
    fw.unstickWaiters.set('mira', new Set([() => assert.fail('must not resolve a waiter')]));
    assert.equal(fw.activeTurnTokens.has('mira'), false);
    assert.equal(fw.activeStreams.has('mira'), false);
    assert.equal(fw.logicalTurnAlive(h.agent('mira')), true);
    try {
      await assertKnownBusy(h);
      assert.deepEqual(h.internals.planNewestTurn(h.agent('mira'), undefined, undefined, 'terminal-refusal'),
        { kind: 'unsupported', reason: 'live assistant round' }, 'refusal cannot borrow ownership from another queued/held turn');
      const before = recoveryState(h);
      h.internals.quarantinePoisonedHistory(h.agent('mira'), 'invalid request', snapshotCarried(h.agent('mira')));
      assert.deepEqual(recoveryState(h), before, 'terminal exhaustion also respects queued/held ownership');
    }
    finally {
      fw.pendingRequests.length = 0;
      fw.parkedContinuations.clear();
      fw.passRequests.clear();
      fw.providerAccelerationCooldowns.clear();
      fw.budgetHolds.clear();
      fw.unstickWaiters.clear();
    }
  });
}

for (const hidden of ['foreign', 'held', 'audience'] as const) it(`legacy visible result for ${hidden} call declines instead of skipping an orphan`, async () => {
  const h = await boot({ failWriteDown: true });
  const eligible = h.internals.addMessage('user', [text('eligible-before-hidden-call')]);
  const metadata = hidden === 'foreign' ? { ownRowOf: 'oren', audience: ['oren'] }
    : hidden === 'audience' ? { audience: ['oren'] } : { tuneOut: { epochId: 'held' } };
  h.cm('mira').addMessage('mira', [callBlock('foreign')], metadata as MessageMetadata);
  h.cm('mira').addMessage('user', [resultBlock('foreign')]);
  const plan = h.internals.planNewestTurn(h.agent('mira'));
  assert.equal(plan.kind, 'unsupported');
  const before = snapshot(h);
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'bad history', snapshotCarried(h.agent('mira')));
  assert.equal(snapshot(h), before);
  assert.ok(h.cm('mira').getMessage(eligible));
  assert.equal(h.internals.exhaustionRewinds.size, 0);
});

for (const missing of ['removed', 'branched-away', 'undone'] as const) it(`replaces a ${missing} episode marker with a fresh branch-local count`, async () => {
  const h = await boot();
  const anchor = h.internals.addMessage('user', [text('before marker')]);
  h.internals.updateRewindMarker(h.agent('mira'), 'first');
  const old = h.internals.rewindEpisode.get('mira')!.markerId;
  if (missing === 'removed') h.cm('mira').removeMessage(old);
  else if (missing === 'undone') h.cm('mira').retractRows([old], { undone: true });
  else {
    const cm = h.cm('mira');
    await cm.switchBranch(cm.branchAt(anchor, 'before-rewind-marker'));
    assert.equal(cm.getMessage(old), null, 'real branch excludes the old marker');
  }
  h.internals.addMessage('user', [text('later supported turn')]);
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'bad history', snapshotCarried(h.agent('mira')));
  const ep = h.internals.rewindEpisode.get('mira')!;
  assert.notEqual(ep.markerId, old);
  assert.equal(ep.count, 1);
  assert.match(textOf(h.cm('mira').getMessage(ep.markerId)!), /The 1 most recent/);
  assert.equal(h.internals.pendingRequests.length, 1);
});

it('automatic refusal gets a fresh budget after cap give-up on an independent wake', async () => {
  const h = await boot({ autoRewind: true });
  const refusal = () => { const r = final([text('refused')]); r.stopReason = 'refusal'; return r; };
  h.membrane.script('mira', refusal());
  h.membrane.script('mira', refusal());
  h.framework.start();
  h.framework.pushEvent(input('first poison', ['mira']));
  await h.framework.runUntilIdle();
  await until(() => h.membrane.callsFor('mira').length === 2 && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'cap give-up');
  assert.equal((h.framework as any).refusalRewinds.has('mira'), false);
  assert.equal(h.internals.rewindEpisode.size, 0, 'give-up closes the old episode');
  h.internals.addMessage('user', [text('intervening retained message')]);
  h.membrane.script('mira', refusal());
  h.membrane.script('mira', final([text('recovered')]));
  h.framework.pushEvent(input('second poison', ['mira']));
  await h.framework.runUntilIdle();
  await until(() => h.membrane.callsFor('mira').length === 4 && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'independent recovery completes');
  assert.equal(h.cm('mira').windowStatusOf(h.rowWith('mira', 'second poison')!.id), 'undone');
});

it('unsupported exhaustion preserves prior confirmed budget and marker', async () => {
  const h = await boot();
  (h.agent('mira').refusalHandling as any).maxRewinds = 3;
  h.internals.addMessage('user', [text('first shed')]);
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'first', snapshotCarried(h.agent('mira')));
  h.internals.pendingRequests.length = 0;
  const ep = { ...h.internals.rewindEpisode.get('mira')! };
  h.internals.addMessage('mira', [callBlock('unfinished')]);
  const before = snapshot(h);
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'second', snapshotCarried(h.agent('mira')));
  assert.equal(snapshot(h), before);
  assert.equal(h.internals.exhaustionRewinds.get('mira'), 1);
  assert.deepEqual(h.internals.rewindEpisode.get('mira'), ep);
  assert.equal(h.internals.pendingRequests.length, 0);
});

it('terminal exhaustion declines without a failed-request witness, preserving later arrivals', async () => {
  const h = await boot();
  const guard = h.agent('mira').toolResultGuard;
  guard.setOverride(true);
  (h.framework as any).consecutiveInferenceFailures.set('mira', 2);
  const call = h.internals.addMessage('mira', [callBlock('ending')]);
  const wire = [{ toolUseId: 'ending', content: 'guard result' }];
  const result = guard.storeResults([resultBlock('ending')], wire as any, [], undefined, undefined);
  guard.submissionResults(wire as any);
  assert.equal(guard.hasSubmittedPending, true);
  const original = h.membrane.streamYielding.bind(h.membrane);
  let requests = 0;
  h.membrane.streamYielding = (request, options) => {
    if (requests++ > 0) return original(request, options);
    (h.framework as any).pendingAssistantBlocks.set('mira', [callBlock('ending')]);
    const error = new MembraneError({ type: 'invalid_request', message: 'poison 400', retryable: false, httpStatus: 400 } as never);
    return { isWaitingForTools: false, pendingToolCallIds: [], toolDepth: 0, isCancelled: false,
      provideToolResults() {}, cancel() {},
      async *[Symbol.asyncIterator]() { yield { type: 'error', error } as StreamEvent; },
    } as any;
  };
  let ending: unknown;
  h.framework.onTrace((event) => {
    if (event.type !== 'inference:exhausted') return;
    ending = { submitted: guard.hasSubmittedPending, pending: (h.framework as any).pendingAssistantBlocks.has('mira'), status: h.cm('mira').windowStatusOf(call) };
    h.internals.addMessage('user', [text('arrived after failed request')]);
  });
  h.framework.start();
  await h.internals.handleHostCommand('test', { command: 'nudge', agentName: 'mira' });
  await until(() => ending !== undefined && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'failed turn teardown');
  await h.framework.runUntilIdle();
  assert.deepEqual(ending, { submitted: true, pending: true, status: 'in' });
  assert.equal(guard.hasPending, false);
  assert.equal(requests, 1, 'no deferred quarantine or retry against a later snapshot');
  for (const id of [call, result, h.rowWith('mira', 'arrived after failed request')!.id]) assert.equal(h.cm('mira').windowStatusOf(id), 'in');
  assert.equal(h.internals.exhaustionRewinds.size, 0);
  assert.equal(h.internals.rewindEpisode.size, 0);
});


it('737 release note describes Safe B rather than retired endpoint fallbacks', () => {
  const note = readFileSync(new URL('../../changelog.d/737-notice-gap-rewind.fixed.md', import.meta.url), 'utf8');
  assert.match(note, /whole, complete tool exchanges/);
  assert.match(note, /exact contiguous interval or declines unchanged/);
  assert.match(note, /never falling back to one endpoint/);
  assert.doesNotMatch(note, /whatever the IDs|notices inside the exchange go with it|quadratic|removed interval|shed one at a time/);
});

it('confirmed throwing legacy removal still retracts other resident windows', async () => {
  const h = await boot({ failWriteDown: true });
  const id = h.internals.addMessage('user', [text('legacy commit then throw')]);
  const cm = h.cm('mira');
  const remove = cm.removeMessage.bind(cm);
  cm.removeMessage = (...args) => { remove(...args); throw new Error('post commit'); };
  const plan = h.internals.planNewestTurn(h.agent('mira'));
  assert.equal(plan.kind, 'ready');
  const outcome = h.internals.applyShed(h.agent('mira'), plan);
  assert.equal(outcome.kind, 'stopped');
  assert.deepEqual(outcome.record.removedIds, [id]);
  assert.equal(h.cm('oren').ordinalOf(id), undefined);
  assert.equal(h.internals.pendingRequests.length, 0);
});


it('unstick preflight distinguishes waiting from manual repair', async () => {
  const h = await boot();
  const fw = h.framework as any;
  h.internals.addMessage('mira', [callBlock('interrupted')]);
  const repair = await h.internals.handleHostCommand('test', { command: 'unstick', agentName: 'mira' });
  assert.equal(repair.ok, false);
  assert.match(repair.error, /Inspect and repair history first; see docs\/recovery-b.md/);
  fw.pendingAssistantBlocks.set('mira', [callBlock('interrupted')]);
  const wait = await h.internals.handleHostCommand('test', { command: 'unstick', agentName: 'mira' });
  assert.equal(wait.ok, false);
  assert.match(wait.error, /Wait for the active turn and tool work to settle/);
  fw.pendingAssistantBlocks.delete('mira');
  assert.equal(fw.forcedRewind.size, 0);
  assert.equal(h.internals.pendingRequests.length, 0);
});

// Independent review's orphan-wire reproduction: an unmatched visible result
// must stop recovery, not make it walk back to unrelated older history.
for (const legacy of [false, true]) it(`visible orphan result stops quarantine without shedding older history (legacy:${legacy})`, async () => {
  const h = await boot({ failWriteDown: legacy });
  const older = h.internals.addMessage('user', [text('unrelated older message')]);
  const orphan = h.internals.addMessage('user', [resultBlock('missing-call')]);
  assert.match(await h.compiled('mira'), /missing-call/, 'the orphan really reaches the next wire request');
  const rawBefore = JSON.stringify(h.cm('mira').getAllMessages());
  const windowBefore = JSON.stringify(h.cm('mira').getPresentedMessages());
  const wireBefore = await h.compiled('mira');
  const plan = h.internals.planNewestTurn(h.agent('mira'));
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'orphan result', snapshotCarried(h.agent('mira')));
  assert.equal(plan.kind, 'unsupported');
  assert.equal(plan.reason, 'missing or ambiguous call body');
  assert.equal(JSON.stringify(h.cm('mira').getAllMessages()), rawBefore);
  assert.equal(JSON.stringify(h.cm('mira').getPresentedMessages()), windowBefore);
  assert.equal(await h.compiled('mira'), wireBefore);
  assert.ok(h.cm('mira').getMessage(older));
  assert.ok(h.cm('mira').getMessage(orphan));
  assert.equal(h.internals.exhaustionRewinds.get('mira') ?? 0, 0);
  assert.equal(h.internals.rewindEpisode.size, 0);
  assert.equal(h.internals.pendingRequests.length, 0);
});

it('non-tail marker starts a fresh notice instead of editing a cached prefix', async () => {
  const h = await boot();
  h.internals.updateRewindMarker(h.agent('mira'), 'first');
  const old = h.internals.rewindEpisode.get('mira')!.markerId;
  h.internals.addMessage('user', [text('retained intervening turn')]);
  h.internals.addMessage('user', [text('new poison')]);
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'second', snapshotCarried(h.agent('mira')));
  const ep = h.internals.rewindEpisode.get('mira')!;
  assert.notEqual(ep.markerId, old);
  assert.equal(ep.count, 1);
  assert.match(textOf(h.cm('mira').getMessage(old)!), /The 1 most recent/);
  assert.equal(h.cm('mira').getPresentedMessages().at(-1)!.id, ep.markerId);
});

it('planner logs the original snapshot exception before declining unchanged', async () => {
  const h = await boot();
  h.internals.addMessage('user', [text('target')]);
  const cm = h.cm('mira');
  const get = cm.getAllMessages;
  const error = new TypeError('snapshot regression');
  const log = console.error;
  const logs: unknown[][] = [];
  try {
    console.error = (...args) => { logs.push(args); };
    cm.getAllMessages = () => { throw error; };
    assert.equal(h.internals.planNewestTurn(h.agent('mira')).kind, 'unsupported');
    assert.ok(logs.some((args) => args.includes(error)));
  } finally { cm.getAllMessages = get; console.error = log; }
});

it('forced stopped summary does not claim another provider attempt after removal', async () => {
  const h = await boot();
  const fw = h.framework as any;
  let summary = '';
  fw.forcedRewind.set('mira', { remaining: 0, removed: [{ descriptor: 'turn', removedIds: [] }], serverId: 'test', channelId: 'test' });
  fw.postToChannel = async (_s: string, _c: string, content: string) => { summary = content; };
  fw.finishUnstick('mira', false);
  assert.match(summary, /recovery stopped after 1 confirmed removal/);
  assert.doesNotMatch(summary, /requests still couldn't be completed/);
});

it('published recovery instructions document the conservative boundaries and exclusive repair', () => {
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const doc = read('docs/recovery-b.md');
  assert.match(doc, /exclusive offline maintenance process/);
  assert.match(doc, /Do not use normal whole-turn `\/undo`/);
  assert.match(doc, /refused-reply cleanup removes that reply globally/);
  assert.match(read('docs/tool-result-guard.md'), /if annotation is pending, recovery declines unchanged/);
  assert.match(read('src/types/agent.ts'), /Unsupported or cap-exhausted attempts stop unchanged/);
  assert.ok(JSON.parse(read('package.json')).files.includes('docs/recovery-b.md'));
  const framework = read('src/framework.ts');
  assert.doesNotMatch(framework, /shedNewestTurn takes|shedNewestTurn \+/);
});

it('throwing committed refused-reply cleanup reconciles other windows but does not retry', async () => {
  const h = await boot({ autoRewind: true });
  h.internals.addMessage('user', [text('eligible cleanup target')]);
  const refusal = final([text('cleanup commits then throws')]); refusal.stopReason = 'refusal';
  h.membrane.script('mira', refusal);
  const cm = h.cm('mira'), other = h.cm('oren');
  const remove = cm.removeMessage.bind(cm);
  let deleted: MessageId | undefined;
  cm.removeMessage = (id) => {
    if (textOf(cm.getMessage(id)!) === 'cleanup commits then throws') {
      other.presentRows([id]);
      assert.notEqual(other.ordinalOf(id), undefined);
      deleted = id;
      remove(id);
      throw new Error('cleanup post commit');
    }
    return remove(id);
  };
  h.framework.start();
  await h.internals.handleHostCommand('test', { command: 'nudge', agentName: 'mira' });
  await until(() => deleted !== undefined && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'cleanup stops and turn ends');
  assert.equal(cm.getMessage(deleted!), null);
  assert.equal(other.ordinalOf(deleted!), undefined, 'no stale reference to globally deleted refusal');
  assert.equal(h.membrane.callsFor('mira').length, 1);
  assert.equal(h.internals.pendingRequests.length, 0);
});

for (const previous of ['resident', 'completed', 'undone'] as const) {
  for (const restart of [false, true]) it(`tool ID reuse is local to its owner and completed round (${previous}, restart:${restart})`, async () => {
    let h = await boot();
    const owner = previous === 'resident' ? 'oren' : 'mira';
    const oldCall = storeOwnRow(h.agent(owner), owner, [callBlock('reused')]);
    const oldResult = storeOwnRow(h.agent(owner), 'user', [resultBlock('reused')]);
    if (previous === 'undone') h.cm('mira').retractRows([oldCall, oldResult], { undone: true });
    const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('reused')]);
    const result = storeOwnRow(h.agent('mira'), 'user', [resultBlock('reused')]);
    if (restart) {
      await h.framework.stop();
      h = await boot({ dir: h.dir });
    }
    const rawBefore = JSON.stringify(h.cm('mira').getAllMessages());
    const orenBefore = await h.compiled('oren');
    // All callers share this planner; both served-request and standalone
    // selection must choose only the newest round, never the older endpoints.
    for (const carried of [undefined, new Set([call, result])]) {
      const plan = h.internals.planNewestTurn(h.agent('mira'), carried);
      assert.equal(plan.kind, 'ready', plan.reason);
      assert.deepEqual(plan.rows.map((m: StoredMessage) => m.id), [call, result]);
    }
    assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'))?.removedIds, [result, call]);
    assert.equal(JSON.stringify(h.cm('mira').getAllMessages()), rawBefore);
    assert.equal(await h.compiled('oren'), orenBefore);
    assert.deepEqual([call, result].map((id) => h.cm('mira').windowStatusOf(id)), ['undone', 'undone']);
    assert.deepEqual([oldCall, oldResult].map((id) => h.cm(owner).windowStatusOf(id)),
      previous === 'undone' ? ['undone', 'undone'] : ['in', 'in']);
  });
}

it('legacy recovery removes only the newest completed round when IDs repeat', async () => {
  const h = await boot({ failWriteDown: true });
  const oldCall = h.internals.addMessage('mira', [callBlock('reused')]);
  const oldResult = h.internals.addMessage('user', [resultBlock('reused')]);
  const call = h.internals.addMessage('mira', [callBlock('reused')]);
  const result = h.internals.addMessage('user', [resultBlock('reused')]);
  h.internals.quarantinePoisonedHistory(h.agent('mira'), 'invalid request', snapshotCarried(h.agent('mira')));
  assert.ok(h.cm('mira').getMessage(oldCall));
  assert.ok(h.cm('mira').getMessage(oldResult));
  assert.equal(h.cm('mira').getMessage(call), null);
  assert.equal(h.cm('mira').getMessage(result), null);
  assert.equal(h.internals.exhaustionRewinds.get('mira'), 1);
  assert.equal(h.internals.pendingRequests.length, 1);
});

it('ID reuse before all calls in the preceding round complete still declines unchanged', async () => {
  const h = await boot();
  h.internals.addMessage('mira', [callBlock('a'), callBlock('b')]);
  h.internals.addMessage('user', [resultBlock('a')]);
  h.internals.addMessage('mira', [callBlock('a')]);
  h.internals.addMessage('user', [resultBlock('a')]);
  const before = snapshot(h);
  const plan = h.internals.planNewestTurn(h.agent('mira'));
  assert.equal(plan.kind, 'unsupported');
  assert.equal(plan.reason, 'reused unresolved call IDs');
  assert.equal(h.internals.shedNewestTurn(h.agent('mira')), null);
  assert.equal(snapshot(h), before);
});

for (const legacy of [false, true]) it(`a newer foreign round reusing an ID cannot steal result eligibility (legacy:${legacy})`, async () => {
  const h = await boot({ failWriteDown: legacy });
  const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('shared')]);
  const result = storeOwnRow(h.agent('mira'), 'user', [resultBlock('shared')]);
  const foreignCall = storeOwnRow(h.agent('oren'), 'oren', [callBlock('shared')]);
  const foreignResult = storeOwnRow(h.agent('oren'), 'user', [resultBlock('shared')]);
  for (const carried of [undefined, new Set([call])]) {
    const plan = h.internals.planNewestTurn(h.agent('mira'), carried);
    if (legacy && !carried) {
      // The legacy compile includes this ordinary co-resident round. It is
      // visible but not reader-owned: decline, don't sacrifice older history.
      assert.match(await h.compiled('mira'), /tool_use/);
      assert.equal(plan.kind, 'unsupported');
      assert.equal(plan.reason, 'missing or ambiguous call body');
    } else {
      assert.equal(plan.kind, 'ready', plan.reason);
      assert.deepEqual(plan.rows.map((m: StoredMessage) => m.id), [call, result]);
    }
  }
  assert.deepEqual(h.internals.shedNewestTurn(h.agent('mira'), new Set([call]))?.removedIds, [result, call]);
  assert.ok(h.cm('oren').getMessage(foreignCall));
  assert.ok(h.cm('oren').getMessage(foreignResult));
});

for (const postCommit of [false, true]) it(`live pre-stream exhaustion accounts for a forced session removal (post-commit throw:${postCommit})`, async () => {
  const h = await boot();
  h.internals.addMessage('user', [text('forced-keep-prefix')]);
  const call = h.internals.addMessage('mira', [callBlock('forced-exhaustion')]);
  const result = h.internals.addMessage('user', [resultBlock('forced-exhaustion')]);
  const fw = h.framework as any;
  const answers: any[] = [];
  const answer = fw.answerUnstick.bind(fw);
  fw.answerUnstick = (name: string, value: any) => { answers.push(value); answer(name, value); };
  const original = h.membrane.streamYielding.bind(h.membrane);
  let failures = 0;
  h.membrane.streamYielding = (request, options) => {
    if (failures++ >= 3) return original(request, options);
    throw new MembraneError({ type: 'invalid_request', message: 'forced pre-stream invalid request', retryable: false, httpStatus: 400 } as never);
  };
  h.framework.start();
  for (let i = 0; i < 2; i++) {
    assert.equal(h.framework.nudgeAgent('mira').ok, true);
    await until(() => h.traces.filter((e) => e.type === 'inference:exhausted').length === i + 1
      && !fw.logicalTurnAlive(h.agent('mira')), 'prior live failures complete');
  }
  if (postCommit) {
    const retract = h.cm('mira').retractRows.bind(h.cm('mira'));
    h.cm('mira').retractRows = (...args) => { retract(...args); throw new Error('committed notification failure'); };
  }
  const ack = await h.internals.handleHostCommand('test', { command: 'unstick', agentName: 'mira', maxRewinds: 1 });
  assert.equal(ack.ok, true);
  await until(() => answers.some((a) => a.outcome === 'turn-failed')
    && !fw.logicalTurnAlive(h.agent('mira')), 'failure answer includes synchronous quarantine');
  assert.equal(answers.find((a) => a.outcome === 'turn-failed').rewinds, 1);
  for (const id of [call, result]) assert.equal(h.cm('mira').windowStatusOf(id), 'undone');
  if (postCommit) {
    assert.equal(fw.forcedRewind.get('mira').remaining, 0, 'confirmed removal consumes forced budget too');
    assert.equal(fw.forcedRewind.get('mira').removed.length, 1);
    assert.equal(h.membrane.callsFor('mira').length, 0, 'uncertain notification never automatically retries');
    // Even with a larger exhaustion cap, the forced cap cannot be bypassed.
    (h.agent('mira').refusalHandling as any).maxRewinds = 3;
    const before = snapshot(h);
    h.internals.quarantinePoisonedHistory(h.agent('mira'), 'later independent failure', snapshotCarried(h.agent('mira')));
    assert.equal(snapshot(h), before);
    assert.equal(fw.forcedRewind.get('mira').removed.length, 1);
    assert.equal(h.framework.nudgeAgent('mira').ok, true);
  }
  await until(() => answers.some((a) => a.outcome === 'cleared')
    && !fw.logicalTurnAlive(h.agent('mira')), 'eventual forced completion');
  assert.equal(answers.find((a) => a.outcome === 'cleared').rewinds, 1);
  assert.equal(h.membrane.callsFor('mira').length, 1);
  assert.doesNotMatch(JSON.stringify(h.membrane.callsFor('mira')[0]!.messages), /forced-exhaustion/);
});

// Independent review's public-start ordering: the provider sees the compile,
// then a microtask stores an own row before the rejected start reaches recovery.
for (const legacy of [false, true]) it(`pre-stream exhaustion carries the failed compile, not a later arrival (legacy:${legacy})`, async () => {
  const h = await boot({ failWriteDown: legacy });
  const poison = storeOwnRow(h.agent('mira'), 'user', [text('original-carried-poison')]);
  const original = h.membrane.streamYielding.bind(h.membrane);
  const failedRequests: string[] = [];
  let late: MessageId | undefined;
  h.membrane.streamYielding = (request, options) => {
    if (failedRequests.length >= 3) return original(request, options);
    failedRequests.push(JSON.stringify(request.messages));
    if (failedRequests.length === 3) queueMicrotask(() => {
      late = storeOwnRow(h.agent('mira'), 'user', [text('arrival-after-failed-compile')]);
    });
    throw new MembraneError({ type: 'invalid_request', message: 'pre-stream ordering', retryable: false, httpStatus: 400 } as never);
  };
  h.framework.start();
  for (let i = 0; i < 3; i++) {
    assert.equal(h.framework.nudgeAgent('mira').ok, true);
    await until(() => h.traces.filter((e) => e.type === 'inference:exhausted').length === i + 1
      && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'failure and breaker complete');
  }
  assert.match(failedRequests[2], /original-carried-poison/);
  assert.doesNotMatch(failedRequests[2], /arrival-after-failed-compile/);
  assert.ok(late);
  await until(() => h.membrane.callsFor('mira').length === 1
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'repaired retry completes');
  const retry = JSON.stringify(h.membrane.callsFor('mira')[0]!.messages);
  assert.match(retry, /arrival-after-failed-compile/);
  assert.doesNotMatch(retry, /original-carried-poison/);
  assert.match(retry, /The 1 most recent/);
  if (legacy) {
    assert.ok(h.cm('mira').getMessage(late));
    assert.equal(h.cm('mira').getMessage(poison), null);
  } else {
    assert.equal(h.cm('mira').windowStatusOf(late), 'in');
    assert.equal(h.cm('mira').windowStatusOf(poison), 'undone');
  }
});

it('refusal retains an arrival absent from the refused compile (ordering control)', async () => {
  const h = await boot({ autoRewind: true });
  const poison = storeOwnRow(h.agent('mira'), 'user', [text('original-carried-poison')]);
  const refusal = final([text('refused')]); refusal.stopReason = 'refusal';
  h.membrane.script('mira', refusal);
  let late: MessageId | undefined;
  h.membrane.onRequest = (name) => {
    if (name === 'mira' && late === undefined)
      late = storeOwnRow(h.agent('mira'), 'user', [text('arrival-after-failed-compile')]);
  };
  h.framework.start();
  assert.equal(h.framework.nudgeAgent('mira').ok, true);
  await until(() => h.membrane.callsFor('mira').length === 2
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'refusal retry completes');
  const [failed, retry] = h.membrane.callsFor('mira').map((r) => JSON.stringify(r.messages));
  assert.match(failed, /original-carried-poison/);
  assert.doesNotMatch(failed, /arrival-after-failed-compile/);
  assert.match(retry, /arrival-after-failed-compile/);
  assert.doesNotMatch(retry, /original-carried-poison/);
  assert.ok(late);
  assert.equal(h.cm('mira').windowStatusOf(late), 'in');
  assert.equal(h.cm('mira').windowStatusOf(poison), 'undone');
});

for (const compileThrows of [false, true]) it(`pre-stream exhaustion without provenance declines rather than reusing an earlier compile (compile throws:${compileThrows})`, async () => {
  const h = await boot();
  const poison = storeOwnRow(h.agent('mira'), 'user', [text('unwitnessed-poison')]);
  const cm = h.cm('mira');
  const compile = cm.compile.bind(cm);
  let compiles = 0;
  let late: MessageId | undefined;
  cm.compile = async (...args) => {
    const compiled = await compile(...args);
    if (++compiles !== 3) return compiled;
    queueMicrotask(() => {
      late = storeOwnRow(h.agent('mira'), 'user', [text('unwitnessed-late-arrival')]);
    });
    if (compileThrows) throw new MembraneError({ type: 'invalid_request', message: 'compile failed before returning provenance', retryable: false, httpStatus: 400 } as never);
    return { ...compiled, provenance: undefined };
  };
  const failedRequests: string[] = [];
  h.membrane.streamYielding = (request) => {
    failedRequests.push(JSON.stringify(request.messages));
    throw new MembraneError({ type: 'invalid_request', message: 'no compile witness', retryable: false, httpStatus: 400 } as never);
  };
  const log = console.error, lines: string[] = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    h.framework.start();
    for (let i = 0; i < 3; i++) {
      assert.equal(h.framework.nudgeAgent('mira').ok, true);
      await until(() => h.traces.filter((e) => e.type === 'inference:exhausted').length === i + 1
        && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'unwitnessed failure settles');
    }
    await h.framework.runUntilIdle();
    assert.ok(lines.some((line) => line.includes('stopped: failed compile history unavailable')));
    assert.equal(compiles, 3, 'no repaired retry without provenance');
    assert.equal(failedRequests.length, compileThrows ? 2 : 3);
    assert.doesNotMatch(failedRequests.at(-1)!, /unwitnessed-late-arrival/);
    assert.ok(late);
    for (const id of [poison, late]) assert.equal(cm.windowStatusOf(id), 'in');
    assert.equal(h.internals.exhaustionRewinds.size, 0);
    assert.equal(h.internals.rewindEpisode.size, 0);
  } finally { console.error = log; }
});

// A late result closes a carried call in storage, but must not expand the
// failed compile's exhaustion witness. Exercise only public start/nudge/store.
for (const legacy of [false, true]) it(`pre-stream exhaustion declines closure over a late uncarried result (legacy:${legacy})`, async () => {
  const h = await boot({ failWriteDown: legacy });
  const prefix = storeOwnRow(h.agent('mira'), 'user', [text('older-carried-prefix')]);
  let call: MessageId | undefined;
  let late: MessageId | undefined;
  const failedRequests: string[] = [];
  const original = h.membrane.streamYielding.bind(h.membrane);
  h.membrane.streamYielding = (request, options) => {
    if (failedRequests.length >= 3) return original(request, options);
    failedRequests.push(JSON.stringify(request.messages));
    if (failedRequests.length === 3) queueMicrotask(() => {
      late = storeOwnRow(h.agent('mira'), 'user', [resultBlock('late-result-call')]);
    });
    throw new MembraneError({ type: 'invalid_request', message: 'late result ordering', retryable: false, httpStatus: 400 } as never);
  };
  const log = console.error, lines: string[] = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    h.framework.start();
    for (let i = 0; i < 3; i++) {
      if (i === 2) call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('late-result-call')]);
      assert.equal(h.framework.nudgeAgent('mira').ok, true);
      await until(() => h.traces.filter((e) => e.type === 'inference:exhausted').length === i + 1
        && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'late-result failure settles');
    }
    const failed = JSON.parse(failedRequests[2]) as { content: ContentBlock[] }[];
    assert.ok(failed.some((m) => m.content.some((b) => b.type === 'tool_use' && b.id === 'late-result-call')),
      'the failed request really carries the call');
    assert.doesNotMatch(failedRequests[2], /result-payload/);
    assert.ok(call);
    assert.ok(late);
    await h.framework.runUntilIdle();
    for (const id of [prefix, call, late]) {
      assert.ok(h.cm('mira').getMessage(id), 'no raw endpoint or older fallback removed');
      if (!legacy) assert.equal(h.cm('mira').windowStatusOf(id), 'in');
    }
    assert.ok(lines.some((line) => line.includes('unsupported: endpoint not carried by failed compile')));
    assert.equal(h.membrane.callsFor('mira').length, 0, 'decline queues no repaired retry');
    assert.equal(failedRequests.length, 3);
    assert.equal(h.internals.exhaustionRewinds.size, 0, 'decline consumes no step');
    assert.equal(h.internals.rewindEpisode.size, 0, 'decline adds no marker');
  } finally { console.error = log; }
});

for (const legacy of [false, true]) it(`refusal still closes over a resident result absent from its compile (legacy:${legacy})`, async () => {
  const h = await boot({ failWriteDown: legacy, autoRewind: true });
  const call = storeOwnRow(h.agent('mira'), 'mira', [callBlock('refusal-late-result')]);
  let late: MessageId | undefined;
  const refusal = final([text('refused')]); refusal.stopReason = 'refusal';
  h.membrane.script('mira', refusal);
  h.membrane.onRequest = (name) => {
    if (name === 'mira' && late === undefined)
      late = storeOwnRow(h.agent('mira'), 'user', [resultBlock('refusal-late-result')]);
  };
  h.framework.start();
  assert.equal(h.framework.nudgeAgent('mira').ok, true);
  await until(() => h.membrane.callsFor('mira').length === 2
    && !(h.framework as any).logicalTurnAlive(h.agent('mira')), 'refusal closure retry completes');
  const [failed, retry] = h.membrane.callsFor('mira').map((r) => JSON.stringify(r.messages));
  assert.match(failed, /refusal-late-result/);
  assert.doesNotMatch(failed, /result-payload/);
  assert.doesNotMatch(retry, /refusal-late-result|result-payload/);
  assert.ok(late);
  for (const id of [call, late]) {
    if (legacy) assert.equal(h.cm('mira').getMessage(id), null);
    else assert.equal(h.cm('mira').windowStatusOf(id), 'undone');
  }
});
