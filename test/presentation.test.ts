/**
 * The presentation module (src/presentation.ts, #291), driven directly over
 * real ContextManagers on a temp chronicle store, with a fake host: two
 * residents over the shared slot (mira, the primary, and oren), the
 * subconscious serving mira, which reads the residents' slot through its
 * observe edge, and a shared fork of mira on its own branch: its decisions
 * on their own, apart from the framework that calls it. Then readers whose
 * contexts merge two slots each.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, PassthroughStrategy, type MessageId, type MessageMetadata, type StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AgentRegistry, audienceOf, residentSpec, storeOwnRow, subconsciousSpec, taskForkSpec, withAudience, workerSpec,
} from '../src/index.js';
import { isAnotherAgentsInjection } from '../src/stored-injections.js';
import {
  AgentPresentation, heldFromResidents, type PresentationHost, type PresentationTrace, type PresentedAgent, type Position,
} from '../src/presentation.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t } as ContentBlock];
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'test--echo', input: {} }) as ContentBlock;
const toolResult = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'ok' }) as ContentBlock;
const textOf = (m: StoredMessage) => m.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : `<${b.type}>`)).join('');

/** An agent as the module presents to it, which storeOwnRow writes through. */
class TestAgent implements PresentedAgent {
  sink: ((ids: readonly MessageId[]) => void) | undefined;
  sinkCalls: MessageId[][] = [];
  constructor(readonly name: string, public cm: ContextManager, private readonly voices: string[] = [name]) {}
  getContextManager(): ContextManager { return this.cm; }
  isOwnParticipant(participant: string): boolean { return this.voices.includes(participant); }
  setOwnRowSink(sink: ((ids: readonly MessageId[]) => void) | undefined): void { this.sink = sink; }
  ownRowsStored(ids: readonly MessageId[]): void { this.sinkCalls.push([...ids]); this.sink?.(ids); }
  /** The texts of the window, in order. */
  window(): string[] { return this.cm.getPresentedMessages().map(textOf); }
  has(id: MessageId): boolean { return this.cm.ordinalOf(id) !== undefined; }
}

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) { try { closers.pop()!(); } catch { /* closed already */ } }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const residentFilter = (name: string) => (m: StoredMessage) =>
  !heldFromResidents(m.metadata as Record<string, unknown> | undefined) && !isAnotherAgentsInjection(m.metadata, name);

async function openResident(store: JsStore, name: string, strategy = new PassthroughStrategy()): Promise<ContextManager> {
  const cm = await ContextManager.open({ store, namespace: `agents/${name}`, strategy, viewFilter: residentFilter(name) });
  closers.push(() => cm.close());
  return cm;
}

async function rig(options: { beforeOpen?: (store: JsStore) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-presentation-'));
  dirs.push(dir);
  const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
  closers.unshift(() => store.close());
  options.beforeOpen?.(store);
  const registry = new AgentRegistry();
  registry.register(residentSpec('mira', { primary: true }));
  registry.register(residentSpec('oren', { primary: false }));
  registry.register(subconsciousSpec('Subconscious', 'mira'));
  const miraStrategy = new PassthroughStrategy();
  const orenStrategy = new PassthroughStrategy();
  const mira = new TestAgent('mira', await openResident(store, 'mira', miraStrategy));
  const oren = new TestAgent('oren', await openResident(store, 'oren', orenStrategy));
  const subCm = await ContextManager.open({
    store, namespace: 'subconscious/mira', isolate: true, auxiliaryMessageViews: [{}],
    viewFilter: (m) => !isAnotherAgentsInjection(m.metadata, 'Subconscious'), strategy: new PassthroughStrategy(),
  });
  closers.push(() => subCm.close());
  const sub = new TestAgent('Subconscious', subCm);
  const live = new Map<string, TestAgent>([[mira.name, mira], [oren.name, oren], [sub.name, sub]]);
  const alive = new Set<string>();
  const traces: PresentationTrace[] = [];
  let frozen = false;
  const host: PresentationHost = {
    liveAgents: () => live.values(),
    registry,
    turnAlive: (name) => alive.has(name),
    frozen: () => frozen,
    emitTrace: (event) => { traces.push(event); },
  };
  const presentation = new AgentPresentation(host);
  /** A write through `writer`'s context, as the framework's addMessage stamps it, then told to the module. */
  const write = (writer: TestAgent, participant: string, content: ContentBlock[], audience: string[], metadata: MessageMetadata = {}): MessageId => {
    const id = writer.cm.addMessage(participant, content, withAudience(metadata, audience));
    presentation.afterStore(writer, [id]);
    return id;
  };
  /** Shard a message whose first block is `marker`, one shard per block, as a strategy's ingress chunking does. */
  const shardOn = (strategy: PassthroughStrategy, marker: string) => {
    (strategy as unknown as { chunkIngressMessage: unknown }).chunkIngressMessage = (_p: string, content: ContentBlock[]) =>
      (content[0] as { text?: string } | undefined)?.text === marker
        ? { bodyGroupId: `body-${marker}`, shards: content.map((block, shardIndex) => ({ content: [block], shardIndex })) }
        : null;
  };
  return {
    store, registry, mira, oren, sub, live, alive, traces, presentation, write, shardOn, miraStrategy, orenStrategy,
    setFrozen: (on: boolean) => { frozen = on; },
    adoptAll: () => { for (const agent of live.values()) presentation.adopt(agent); },
  };
}

const ofType = <T extends PresentationTrace['type']>(traces: PresentationTrace[], type: T) =>
  traces.filter((t): t is Extract<PresentationTrace, { type: T }> => t.type === type);

describe('the presentation module', () => {
  it('adopt writes the window down, and the compile is what it was', async () => {
    const r = await rig();
    r.mira.cm.addMessage('user', text('before'), withAudience(undefined, ['mira', 'oren']));
    storeOwnRow(r.mira, 'mira', text('a reply'));
    const before = (await r.mira.cm.compile(undefined, undefined, { dryRun: true })).messages;
    assert.equal(r.mira.cm.windowMode(), 'legacy');
    assert.equal(r.store.getStateLen('agents/mira/window'), null, 'no index before the write-down');
    r.adoptAll();
    for (const agent of r.live.values()) assert.equal(agent.cm.windowMode(), 'presented', `${agent.name} is presented`);
    const after = (await r.mira.cm.compile(undefined, undefined, { dryRun: true })).messages;
    assert.deepEqual(after, before, 'the written-down window compiles as the record did');
    assert.ok(r.mira.sink, 'the own-row sink is installed');
    assert.deepEqual(ofType(r.traces, 'presentation:repaired'), [], 'nothing to repair: the write-down took every row in');
  });

  // AF-A-1: a write-down takes the whole record, so a resident taken on
  // after another's window was presented (one added to a host's
  // configuration later) would hold that resident's own rows and its mail.
  // The stamped rows elsewhere to it leave its window at once; the rows an
  // earlier release stored unstamped stay, the write-down's migration.
  it("a resident taken on after another's window was presented holds none of that resident's own rows or mail (decision 1)", async () => {
    const r = await rig();
    const unstamped = r.mira.cm.addMessage('someone', text('from before the stamp'), {});
    r.presentation.adopt(r.mira);
    const dm = r.write(r.mira, 'alice', text('a DM for mira alone'), ['mira']);
    const reply = storeOwnRow(r.mira, 'mira', text("mira's private reply"));
    const both = r.write(r.mira, 'someone', text('for both'), ['mira', 'oren']);
    const held = r.write(r.mira, 'someone', text('held'), ['mira', 'oren'], { tuneOut: { epochId: 'e' } } as MessageMetadata);
    assert.deepEqual(r.mira.window(), ['from before the stamp', 'a DM for mira alone', "mira's private reply", 'for both'], 'setup');

    r.presentation.adopt(r.oren);
    assert.equal(r.oren.cm.windowMode(), 'presented');
    assert.deepEqual(r.oren.window(), ['from before the stamp', 'for both'], 'its arrivals and the unstamped row, nothing of mira\'s');
    for (const id of [dm, reply, held]) assert.equal(r.oren.cm.windowStatusOf(id), 'out', 'taken out as arrived, not undone');
    assert.equal(r.oren.has(unstamped), true);
    assert.deepEqual(ofType(r.traces, 'presentation:retracted').map((t) => [t.agentName, t.reason, t.messageIds]),
      [['oren', 'elsewhere', [dm, reply, held]]]);
    assert.deepEqual(r.presentation.presentAtEnd(r.oren), [], 'no later point presents them');
    assert.deepEqual(r.oren.window(), ['from before the stamp', 'for both']);
    const compiled = (await r.oren.cm.compile(undefined, undefined, { dryRun: true })).messages;
    assert.ok(!JSON.stringify(compiled).includes('mira'), "oren's compile sends nothing of mira's");
    // Taken on again (a restart), its window is left as it is.
    const before = ofType(r.traces, 'presentation:retracted').length;
    const reopened = new TestAgent('oren', await openResident(r.store, 'oren'));
    r.presentation.adopt(reopened);
    assert.deepEqual(reopened.window(), ['from before the stamp', 'for both']);
    assert.equal(ofType(r.traces, 'presentation:retracted').length, before, 'nothing more to take out');
  });

  it("a rebase onto a branch made before a resident's write-down takes in none of another resident's own rows there", async () => {
    const r = await rig();
    r.presentation.adopt(r.mira);
    const reply = storeOwnRow(r.mira, 'mira', text("mira's reply"));
    const both = r.write(r.mira, 'someone', text('for both'), ['mira', 'oren']);
    const main = r.store.currentBranch().name;
    r.store.createBranchAt('early', main, r.store.currentSequence());
    r.presentation.adopt(r.oren);
    assert.deepEqual(r.oren.window(), ['for both'], 'setup: written down on main without mira\'s reply');
    r.store.switchBranch('early');
    assert.equal(r.oren.cm.windowMode(), 'legacy', 'setup: no window index for oren on the early branch');
    r.presentation.rebase(r.oren);
    assert.equal(r.oren.cm.windowMode(), 'presented');
    assert.deepEqual(r.oren.window(), ['for both'], "the rebase's write-down took mira's reply in, and it left");
    assert.equal(r.oren.cm.windowStatusOf(reply), 'out');
    assert.equal(r.oren.has(both), true);
    assert.deepEqual(ofType(r.traces, 'presentation:retracted').at(-1), { type: 'presentation:retracted', agentName: 'oren', messageIds: [reply], reason: 'elsewhere' });
  });

  it("an own row stored through the sink enters its owner's window at its write, and no co-resident's", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    r.alive.add('oren');
    const reply = storeOwnRow(r.mira, 'mira', [...text('calling'), toolUse('c1')]);
    assert.equal(r.mira.has(reply), true, 'presented at its write, while its turn is alive');
    assert.equal(r.oren.has(reply), false, "another agent's round is not oren's (decision 1)");
    assert.deepEqual(r.mira.sinkCalls, [[reply]], 'the sink heard it once, by its id');
    const held = storeOwnRow(r.mira, 'user', text('held back'), undefined, undefined, false);
    assert.equal(r.mira.has(held), false, "a row written with present: false isn't");
    assert.deepEqual(r.mira.sinkCalls, [[reply]], 'and the sink is not told of it');
    assert.equal(r.sub.has(reply), true, "the idle subconscious takes a resident's round through its observe edge");
    const presented = ofType(r.traces, 'presentation:presented');
    assert.deepEqual(presented.map((t) => [t.agentName, t.occasion, t.count]), [['mira', 'write', 1], ['Subconscious', 'at-rest', 1]]);
  });

  it("the sink is told once the row is readable, with the id storeOwnRow returns", async () => {
    const r = await rig();
    const seen: Array<{ id: MessageId; readable: boolean }> = [];
    const writer = {
      name: 'mira',
      getContextManager: () => r.mira.cm,
      ownRowsStored: (ids: readonly MessageId[]) => { for (const id of ids) seen.push({ id, readable: r.mira.cm.getMessage(id) !== null }); },
    };
    const id = storeOwnRow(writer, 'user', text('a notice'), { kind: 'notice' } as MessageMetadata);
    assert.deepEqual(seen, [{ id, readable: true }]);
    assert.equal(audienceOf(r.mira.cm.getMessage(id)!.metadata)?.ownRowOf, 'mira', 'stamped as its own row');
  });

  it("a held row never enters a resident's window, and enters the subconscious's at rest", async () => {
    const r = await rig();
    r.adoptAll();
    const held = r.write(r.mira, 'someone', text('held'), [], { tuneOut: { epochId: 'e-1' } } as MessageMetadata);
    assert.equal(r.sub.has(held), true, 'the idle subconscious is presented it at its write');
    assert.equal(r.mira.has(held), false);
    assert.equal(r.oren.has(held), false);
    r.presentation.presentAtEnd(r.mira);
    r.presentation.presentAtStart(r.oren, 'turn-start');
    assert.equal(r.mira.has(held), false, 'not at a point either');
    assert.equal(r.oren.has(held), false);
  });

  it('an untargeted row enters each resident\'s window at its own point', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const row = r.write(r.mira, 'someone', text('for anyone'), ['mira', 'oren']);
    assert.equal(r.oren.has(row), true, 'oren, idle, is presented it at its write (present at rest)');
    assert.equal(r.mira.has(row), false, "mira's turn is alive: she takes it at her next point");
    assert.equal(r.sub.has(row), true, 'the subconscious observes the slot');
    assert.deepEqual(r.presentation.arrivalsOf(r.mira).map((m) => m.id), [row], "it is mira's arrival");
    r.alive.delete('mira');
    assert.deepEqual(r.presentation.presentAtEnd(r.mira).map((m) => m.id), [row]);
    assert.equal(r.mira.has(row), true);
  });

  it('presentAtEnd does nothing while the turn is alive, presents once it is not, and then has nothing left', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const row = r.write(r.oren, 'someone', text('arrived'), ['mira']);
    assert.deepEqual(r.presentation.presentAtEnd(r.mira), []);
    assert.equal(r.mira.has(row), false);
    r.alive.delete('mira');
    assert.deepEqual(r.presentation.presentAtEnd(r.mira).map((m) => m.id), [row]);
    assert.deepEqual(r.presentation.presentAtEnd(r.mira), [], 'idempotent');
  });

  it("presentAtStart('compile') presents own rows only; 'turn-start' presents own rows and arrivals, own rows alone while frozen", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const arrival = r.write(r.oren, 'someone', text('arrived'), ['mira']);
    const own = storeOwnRow(r.mira, 'user', text('a wake line'), undefined, undefined, false);
    assert.deepEqual(r.presentation.presentAtStart(r.mira, 'compile'), [], 'no arrival returned');
    assert.equal(r.mira.has(own), true, 'the own row is in');
    assert.equal(r.mira.has(arrival), false, 'the arrival is not');
    r.setFrozen(true);
    const own2 = storeOwnRow(r.mira, 'user', text('another'), undefined, undefined, false);
    assert.deepEqual(r.presentation.presentAtStart(r.mira, 'turn-start'), [], 'frozen: no arrival');
    assert.equal(r.mira.has(own2), true, 'own rows still present while frozen');
    assert.equal(r.mira.has(arrival), false);
    r.setFrozen(false);
    assert.deepEqual(r.presentation.presentAtStart(r.mira, 'turn-start').map((m) => m.id), [arrival]);
    assert.deepEqual(r.mira.window().slice(-3), ['a wake line', 'another', 'arrived'], 'in the order presented');
  });

  it('while frozen, a write presents nobody its arrival, and own rows still enter', async () => {
    const r = await rig();
    r.adoptAll();
    r.setFrozen(true);
    const row = r.write(r.mira, 'someone', text('during surgery'), ['mira', 'oren']);
    const own = storeOwnRow(r.oren, 'oren', text("oren's own"));
    assert.equal(r.mira.has(row), false);
    assert.equal(r.oren.has(row), false);
    assert.equal(r.oren.has(own), true);
    r.setFrozen(false);
    r.presentation.repairAndRest();
    assert.equal(r.mira.has(row), true, 'presented once the freeze lifts and the host rests them');
    assert.equal(r.oren.has(row), true);
  });

  it('a tool boundary presents the round first, then a prefix of its arrivals cut at the first body the stream cannot carry', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    r.shardOn(r.orenStrategy, 'part one');
    const first = r.write(r.oren, 'someone', text('first'), ['mira']);
    // The round's rows, stored after the arrival and held back from the sink, as if not presented at their write.
    const reply = storeOwnRow(r.mira, 'mira', [...text('looking'), toolUse('c1')], undefined, undefined, false);
    const results = storeOwnRow(r.mira, 'user', [toolResult('c1')], undefined, undefined, false);
    const body = r.write(r.oren, 'someone', [...text('part one'), ...text(' part two'), ...text(' part three')], ['mira']);
    const toolRow = r.write(r.oren, 'module', [toolResult('other')], ['mira']);
    const after = r.write(r.oren, 'someone', text('after the cut'), ['mira']);
    const named = r.write(r.oren, 'mira', text('named as mira'), ['mira']);

    const { heard, cutAt } = r.presentation.presentAtBoundary(r.mira, [reply, results], { injects: true });
    assert.deepEqual(heard.map((h) => h.id), [first, body], 'the arrivals before the cut, one per body');
    assert.equal(cutAt, toolRow, 'cut at the row with a tool block');
    assert.deepEqual(heard[1]!.content, text('part one part two part three'), 'a sharded body heard whole, as compiled');
    assert.deepEqual(r.mira.window().slice(-6), ['looking<tool_use>', '<tool_result>', 'first', 'part one', ' part two', ' part three'],
      'the round first, then the heard rows, each body whole');
    for (const id of [toolRow, after, named]) assert.equal(r.mira.has(id), false, 'what follows the cut waits');
    const presented = ofType(r.traces, 'presentation:presented').filter((t) => t.agentName === 'mira');
    assert.deepEqual(presented.map((t) => [t.occasion, t.count, t.cutAt]), [['tool-boundary', 2, undefined], ['tool-boundary', 2, toolRow]]);

    // A row named as the agent cuts too.
    r.alive.delete('mira');
    r.presentation.presentAtEnd(r.mira);
    r.alive.add('mira');
    const plain = r.write(r.oren, 'someone', text('plain'), ['mira']);
    const voiced = r.write(r.oren, 'mira', text('voiced as mira'), ['mira']);
    const second = r.presentation.presentAtBoundary(r.mira, [], { injects: true });
    assert.deepEqual(second.heard.map((h) => h.id), [plain]);
    assert.equal(second.cutAt, voiced, "a row named as the agent would render as its own turn");
  });

  it("a tool boundary whose stream can't carry injected rows presents the round alone", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const arrival = r.write(r.oren, 'someone', text('arrived'), ['mira']);
    const results = storeOwnRow(r.mira, 'user', [toolResult('c1')], undefined, undefined, false);
    assert.deepEqual(r.presentation.presentAtBoundary(r.mira, [results], { injects: false }), { heard: [] });
    assert.equal(r.mira.has(results), true);
    assert.equal(r.mira.has(arrival), false);
    r.setFrozen(true);
    const arrival2 = r.write(r.oren, 'someone', text('frozen'), ['mira']);
    assert.deepEqual(r.presentation.presentAtBoundary(r.mira, [], { injects: true }), { heard: [] }, 'frozen: nothing of others');
    assert.equal(r.mira.has(arrival2), false);
  });

  // context-manager writes a presentRows call of several rows as one record,
  // through chronicle's batched append, so a write that fails, or a batch a
  // crash tears, enters none of its rows: chronicle keeps or drops a record
  // whole. The per-row case that stood here (a store handle without the
  // batched append, a write cut short entering a prefix) has no counterpart
  // now: context-manager has no one-record-per-row path, and create()
  // refuses such a handle (presentation-mandatory's refusal case). The
  // batched failure below is what the presentation module meets instead.
  it('a batched presentation that fails hears nothing, and its rows wait whole for the next point', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const ids = ['one', 'two', 'three'].map((t) => r.write(r.oren, 'someone', text(t), ['mira']));
    const store = r.store as unknown as { appendManyToStateJsonWithIdentity: (...args: unknown[]) => unknown };
    const batched = store.appendManyToStateJsonWithIdentity;
    store.appendManyToStateJsonWithIdentity = function (this: JsStore, id: unknown, ...rest: unknown[]) {
      if (id === 'agents/mira/window') throw new Error('the store failed');
      return batched.call(this, id, ...rest);
    };
    const error = console.error;
    console.error = () => {};
    let heard;
    try {
      heard = r.presentation.presentAtBoundary(r.mira, [], { injects: true }).heard;
    } finally {
      console.error = error;
      delete (store as { appendManyToStateJsonWithIdentity?: unknown }).appendManyToStateJsonWithIdentity;
    }
    assert.deepEqual(heard, [], 'nothing entered');
    assert.deepEqual(ids.map((id) => r.mira.has(id)), [false, false, false]);
    assert.deepEqual(ofType(r.traces, 'presentation:failed').map((t) => [t.agentName, t.occasion]), [['mira', 'tool-boundary']]);
    r.alive.delete('mira');
    assert.deepEqual(r.presentation.presentAtEnd(r.mira).map((m) => m.id), ids, 'all of them at the next point');
  });

  it("the hand-off vouches when the window's newest rows are the rows sent, in order, and not when another came between", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const reply = storeOwnRow(r.mira, 'mira', [...text('calling'), toolUse('c1')]);
    const results = storeOwnRow(r.mira, 'user', [toolResult('c1')], undefined, undefined, false);
    const arrival = r.write(r.oren, 'someone', text('heard'), ['mira']);
    const { heard } = r.presentation.presentAtBoundary(r.mira, [reply, results], { injects: true });
    assert.deepEqual(r.presentation.handOff(r.mira, [reply, results, ...heard.map((h) => h.id)]), { vouched: true });
    assert.deepEqual(r.presentation.handOff(r.mira, [reply, undefined, results, arrival]), { vouched: true }, 'an undefined id is skipped');

    const reply2 = storeOwnRow(r.mira, 'mira', [...text('again'), toolUse('c2')]);
    const results2 = storeOwnRow(r.mira, 'user', [toolResult('c2')]);
    storeOwnRow(r.mira, 'user', text('a notice the stream is not given'));
    assert.deepEqual(r.presentation.handOff(r.mira, [reply2, results2]), { vouched: false });
    const mismatch = ofType(r.traces, 'presentation:hand-off-mismatch');
    assert.equal(mismatch.length, 1);
    assert.deepEqual(mismatch[0]!.expected, [reply2, results2]);
    assert.equal(mismatch[0]!.tail.at(-1), r.mira.cm.getPresentedMessages().at(-1)!.id);

    const notice = storeOwnRow(r.mira, 'user', text('a notice it is given'), undefined, undefined, false);
    assert.deepEqual(r.presentation.handOff(r.mira, [notice]), { vouched: true }, 'a row sent and not yet in the window is presented first');
    assert.equal(r.mira.has(notice), true);
  });

  it("a crashed turn's arrivals are arrivals again for a manager reopened on the store", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const row = r.write(r.oren, 'someone', text('arrived mid-turn'), ['mira', 'oren']);
    assert.equal(r.mira.has(row), false);
    // The process dies with mira's turn alive; a new one opens her context on the same store.
    r.mira.cm.close();
    const reopened = new TestAgent('mira', await openResident(r.store, 'mira'));
    r.live.set('mira', reopened);
    const fresh = new AgentPresentation({
      liveAgents: () => r.live.values(), registry: r.registry, turnAlive: () => false, frozen: () => false, emitTrace: () => {},
    });
    fresh.adopt(reopened);
    assert.equal(reopened.cm.windowMode(), 'presented', 'the index survived');
    assert.deepEqual(fresh.presentAtStart(reopened, 'turn-start').map((m) => m.id), [row], "read from the index, not a head");
  });

  it("boot repair presents an own row stored and not presented to its owner alone, and leaves an undone row out", async () => {
    const r = await rig();
    r.adoptAll();
    // Mira's turn is alive, so her own write below presents only itself, not the row held back.
    r.alive.add('mira');
    const kept = storeOwnRow(r.mira, 'user', text('stored before the crash'), undefined, undefined, false);
    const undone = storeOwnRow(r.mira, 'mira', text('an undone reply'));
    assert.equal(r.mira.has(kept), false);
    r.mira.cm.retractRows([undone], { undone: true });
    r.mira.cm.close();
    const reopened = new TestAgent('mira', await openResident(r.store, 'mira'));
    r.live.set('mira', reopened);
    const traces: PresentationTrace[] = [];
    const fresh = new AgentPresentation({
      liveAgents: () => r.live.values(), registry: r.registry, turnAlive: () => false, frozen: () => false, emitTrace: (e) => { traces.push(e); },
    });
    fresh.adopt(reopened);
    assert.equal(reopened.has(kept), true, 'repaired at adopt');
    assert.equal(reopened.has(undone), false, 'an undone row is not repaired');
    assert.equal(r.oren.has(kept), false, "and it is not oren's");
    assert.deepEqual(ofType(traces, 'presentation:repaired').map((t) => [t.agentName, t.count]), [['mira', 1]]);
    fresh.adopt(reopened);
    assert.equal(ofType(traces, 'presentation:repaired').length, 1, 'adopt is once per manager');
  });

  it('repairAndRest sweeps own rows and rests every idle agent, whatever adopt did', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    r.alive.add('oren');
    const own = storeOwnRow(r.oren, 'user', text('an imported own row'), undefined, undefined, false);
    const arrival = r.write(r.mira, 'someone', text('imported'), ['mira', 'oren']);
    r.alive.clear();
    r.presentation.repairAndRest();
    assert.equal(r.oren.has(own), true);
    assert.equal(r.oren.has(arrival), true);
    assert.equal(r.mira.has(arrival), true);
    assert.deepEqual(ofType(r.traces, 'presentation:repaired').map((t) => [t.agentName, t.count]), [['oren', 1]]);
  });

  it("a shared fork derived at the head starts with its parent's window, takes none of its parent's arrivals, and has its framing repaired", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const presentedToMira = storeOwnRow(r.mira, 'mira', text("mira's reply"));
    const parentArrival = r.write(r.oren, 'someone', text("mira's arrival"), ['mira', 'oren']);
    const kidCm = await r.mira.cm.derive({ branch: 'kid-branch', strategy: new PassthroughStrategy() });
    closers.push(() => kidCm.close());
    const derivation = kidCm.getDerivation()!;
    r.registry.register(taskForkSpec('kid', {
      parent: 'mira',
      inherit: { mode: 'shared', atSequence: derivation.atSequence, ownBranch: 'kid-branch', derivation: JSON.parse(JSON.stringify(derivation)) },
    }));
    const kid = new TestAgent('kid', kidCm, ['kid', 'mira']);
    const framing = storeOwnRow(kid, 'user', text('[framing] you were derived from mira'));
    assert.equal(kid.has(framing), false, 'stored before the fork is taken on');
    assert.deepEqual(kid.window(), r.mira.window(), "the parent's window, as it stood");
    assert.equal(kid.has(presentedToMira), true);
    r.live.set('kid', kid);
    r.presentation.adopt(kid);
    assert.equal(kid.has(framing), true, 'its own framing is repaired at adopt');
    assert.deepEqual(r.presentation.presentAtStart(kid, 'turn-start'), [], "its parent's arrival is not its own");
    assert.equal(kid.has(parentArrival), false);
    const forKid = r.write(kid, 'someone', text('for the fork'), ['kid']);
    assert.equal(kid.has(forKid), true, 'its own arrival, presented at rest');
    assert.equal(r.mira.cm.getMessage(forKid), null, 'on its own branch');
  });

  it('holders and presentedToAnyone, across two residents, the subconscious, a legacy reader, a fork and framing', async () => {
    const r = await rig();
    const earlyHeld = r.mira.cm.addMessage('someone', text('held before the write-down'), withAudience({ tuneOut: { epochId: 'e' } } as MessageMetadata, []));
    r.adoptAll();
    const tess = new TestAgent('tess', await openResident(r.store, 'tess'));
    r.live.set('tess', tess);
    r.alive.add('oren');
    const row = r.write(r.mira, 'someone', text('for both'), ['mira', 'oren']);
    assert.deepEqual(r.presentation.holders(row).map((h) => [h.agent, h.via]).sort(), [
      ['Subconscious', 'window'], ['mira', 'window'], ['tess', 'legacy'],
    ], "oren's turn is alive; tess, never taken on, holds the record");
    assert.equal(r.presentation.presentedToAnyone(row), true);
    assert.equal(r.presentation.presentedToAnyone(row, { except: 'mira' }), true, 'the subconscious holds it too');
    const position = r.presentation.holders(row).find((h) => h.agent === 'mira')!;
    assert.equal(position.via === 'window' && position.position, r.mira.cm.ordinalOf(row));

    assert.deepEqual(r.presentation.holders(earlyHeld).map((h) => [h.agent, h.via]).sort(), [
      ['Subconscious', 'window'], ['tess', 'legacy'],
    ], "the residents' written-down windows took the held row in, and leave it out");

    const kidCm = await r.mira.cm.derive({ branch: 'kid-branch', strategy: new PassthroughStrategy() });
    closers.push(() => kidCm.close());
    const derivation = kidCm.getDerivation()!;
    r.registry.register(taskForkSpec('kid', {
      parent: 'mira',
      inherit: { mode: 'shared', atSequence: derivation.atSequence, ownBranch: 'kid-branch', derivation: JSON.parse(JSON.stringify(derivation)) },
    }));
    const kid = new TestAgent('kid', kidCm, ['kid', 'mira']);
    r.live.set('kid', kid);
    assert.ok(r.presentation.holders(row).some((h) => h.agent === 'kid' && h.via === 'window'), "the fork's inherited window holds it");
    assert.ok(!r.presentation.holders(earlyHeld).some((h) => h.agent === 'kid'), "a resident's fork leaves its inherited held rows out");
    r.presentation.noteFramed(kid, [earlyHeld]);
    assert.ok(r.presentation.holders(earlyHeld).some((h) => h.agent === 'kid' && h.via === 'framing'), 'framing counts, held or not');
    r.presentation.forget(kid);
    assert.ok(!r.presentation.holders(earlyHeld).some((h) => h.via === 'framing'), 'until the fork is let go');

    const legacyOnly = tess.cm.addMessage('someone', text('stored while only tess reads it'), withAudience(undefined, ['tess']));
    assert.equal(r.presentation.presentedToAnyone(legacyOnly), false, 'a window that is still the record does not count');
  });

  it("noteFramed presents into a fork's window the rows not in it yet", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const inherited = storeOwnRow(r.mira, 'mira', text("mira's reply"));
    const later = r.write(r.oren, 'someone', text('a row the fork is handed'), ['mira']);
    const kidCm = await r.mira.cm.derive({ branch: 'kid-branch', strategy: new PassthroughStrategy() });
    closers.push(() => kidCm.close());
    const kid = new TestAgent('kid', kidCm, ['kid', 'mira']);
    r.live.set('kid', kid);
    r.presentation.adopt(kid);
    assert.equal(kid.has(inherited), true, "the fork inherited its parent's window");
    r.presentation.noteFramed(kid, [inherited, later]);
    assert.equal(kid.has(later), true, 'presented into the fork');
    assert.equal(r.mira.has(later), false, "not into the parent's");
    assert.deepEqual(ofType(r.traces, 'presentation:presented').filter((t) => t.agentName === 'kid').map((t) => [t.occasion, t.count]),
      [['framing', 1]], 'the row it held already is not presented again');
  });

  it("a window in another version's index format leaves its agent in legacy mode, traced once", async () => {
    const r = await rig({
      beforeOpen: (store) => {
        store.registerState({ id: 'agents/oren/window', strategy: 'append_log', deltaSnapshotEvery: 50, fullSnapshotEvery: 100 });
        store.appendToStateJson('agents/oren/window', { v: 99 });
      },
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      r.adoptAll();
      r.presentation.adopt(r.oren);
    } finally { console.warn = warn; }
    assert.equal(r.oren.cm.windowMode(), 'legacy');
    assert.equal(r.presentation.presenting(r.oren), false);
    assert.equal(r.oren.sink, undefined, 'no sink for an agent the module does not present for');
    assert.deepEqual(ofType(r.traces, 'presentation:failed').map((t) => [t.agentName, t.occasion]), [['oren', 'adopt']]);
    const row = r.write(r.mira, 'someone', text('for both'), ['mira', 'oren']);
    assert.deepEqual(r.presentation.presentAtEnd(r.oren), []);
    assert.ok(r.presentation.holders(row).some((h) => h.agent === 'oren' && h.via === 'legacy'), 'it holds its whole record');
    assert.equal(r.mira.has(row), true, 'the others go on');
  });

  it('a #795 row: stored while the assistant acts, presented to the idle helper at once, and to the assistant at its boundary', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const reply = storeOwnRow(r.mira, 'mira', [...text('checking'), toolUse('c1')]);
    const question = r.write(r.mira, 'someone', text('a question for anyone'), ['mira', 'oren']);
    assert.equal(r.oren.has(question), true, "the helper's window has it before any wake is dispatched");
    assert.equal(r.mira.has(question), false, "not inside the assistant's live turn");
    const results = storeOwnRow(r.mira, 'user', [toolResult('c1')]);
    const { heard } = r.presentation.presentAtBoundary(r.mira, [reply, results], { injects: true });
    assert.deepEqual(heard.map((h) => h.id), [question], 'the assistant hears it at its boundary');
    assert.deepEqual(r.presentation.handOff(r.mira, [reply, results, question]), { vouched: true });
  });

  it('an unstamped row is presented to the owners and observers, and counted in the trace', async () => {
    const r = await rig();
    r.adoptAll();
    const id = r.mira.cm.addMessage('host', text('a host notice with no stamp'));
    r.presentation.afterStore(r.mira, [id]);
    assert.equal(r.mira.has(id), true);
    assert.equal(r.oren.has(id), true);
    assert.equal(r.sub.has(id), true);
    const presented = ofType(r.traces, 'presentation:presented').filter((t) => t.occasion === 'at-rest');
    assert.ok(presented.length === 3 && presented.every((t) => t.unstamped === 1), 'each says it carried no stamp');
  });

  it('listeners hear the rows that entered, and presentedSince reads the window from a place', async () => {
    const r = await rig();
    r.adoptAll();
    const heard: Array<[string, string[]]> = [];
    const off = r.presentation.onPresented('oren', (event) => heard.push([event.occasion, event.rows.map(textOf)]));
    const mark = r.oren.cm.indexLength() as Position;
    r.write(r.mira, 'someone', text('one'), ['oren']);
    storeOwnRow(r.oren, 'oren', text("oren's reply"));
    off();
    r.write(r.mira, 'someone', text('unheard'), ['oren']);
    assert.deepEqual(heard, [['at-rest', ['one']], ['write', ["oren's reply"]]]);
    assert.deepEqual(r.presentation.presentedSince(r.oren, mark).map(textOf), ['one', "oren's reply", 'unheard']);
    assert.deepEqual(r.presentation.presentedSince(r.mira, r.mira.cm.indexLength() as Position), []);
  });

  it("forget takes the sink off: the agent's own rows then wait", async () => {
    const r = await rig();
    r.adoptAll();
    r.presentation.forget(r.oren);
    assert.equal(r.oren.sink, undefined);
    const own = storeOwnRow(r.oren, 'oren', text('after forget'));
    assert.equal(r.oren.has(own), false);
    assert.equal(r.presentation.presenting(r.oren), false);
  });

  it("arrivals held until the next start (a rollback's returned rows) wait at rest and at the compile sweep, and enter at the next turn start; an own row isn't held", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const returned = r.write(r.oren, 'someone', text('returned'), ['mira']);
    const own = storeOwnRow(r.mira, 'user', text('a wake line'), undefined, undefined, false);
    r.alive.delete('mira');
    assert.equal(r.mira.has(returned), false);
    r.presentation.holdUntilStart(r.mira, [returned, own]);
    // At rest: a turn's end (a surgery's release, a resume), and a row
    // stored for mira while she is idle, which enters alone.
    assert.deepEqual(r.presentation.presentAtEnd(r.mira), [], 'no arrival entered');
    assert.equal(r.mira.has(own), true, 'an own row enters at every point, held or not');
    assert.equal(r.mira.has(returned), false, 'the held arrival waits');
    const later = r.write(r.oren, 'someone', text('later'), ['mira']);
    assert.equal(r.mira.has(later), true, 'presented at its write, at rest');
    assert.equal(r.mira.has(returned), false);
    r.presentation.repairAndRest();
    assert.equal(r.mira.has(returned), false);
    // The backstop before a compile presents own rows only, and keeps the hold.
    r.presentation.presentAtStart(r.mira, 'compile');
    assert.deepEqual(r.presentation.presentAtEnd(r.mira), []);
    assert.equal(r.mira.has(returned), false);
    // A fresh start presents it, and ends the hold.
    assert.deepEqual(r.presentation.presentAtStart(r.mira, 'turn-start').map((m) => m.id), [returned]);
    assert.deepEqual(r.mira.window().slice(-3), ['a wake line', 'later', 'returned'], 'in the order presented');
    assert.ok(r.presentation.owedOf(r.mira).length === 0);
  });

  it("a held arrival is still owed, and a forget drops the hold", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const returned = r.write(r.oren, 'someone', text('returned'), ['mira']);
    r.alive.delete('mira');
    r.presentation.holdUntilStart(r.mira, [returned]);
    assert.deepEqual(r.presentation.owedOf(r.mira).map((m) => m.id), [returned], 'owed, though held at rest');
    assert.deepEqual(r.presentation.arrivalsOf(r.mira).map((m) => m.id), [returned]);
    r.presentation.forget(r.mira);
    r.presentation.adopt(r.mira);
    assert.deepEqual(r.presentation.presentAtEnd(r.mira).map((m) => m.id), [returned], 'the hold went with the forget');
  });
});

describe('the presentation module for a reader that observes more than one slot', () => {
  /**
   * The residents (mira and oren), two workers in slots of their own (clerk
   * and scribe), and two readers whose contexts merge two slots each, as the
   * framework opens an observer's context (one auxiliary view per slot it
   * observes): Both reads the residents' slot, held traffic shown, and
   * clerk's, held traffic not shown; Auditor reads clerk's and scribe's.
   */
  async function twoSlotRig() {
    const dir = mkdtempSync(join(tmpdir(), 'af-presentation-two-slots-'));
    dirs.push(dir);
    const store = JsStore.openOrCreate({ path: join(dir, 'store.chronicle') });
    closers.unshift(() => store.close());
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(workerSpec('clerk'));
    registry.register(workerSpec('scribe'));
    registry.register({ ...subconsciousSpec('Both', 'mira'), observes: [{ includeHeld: true }, { agent: 'clerk' }], ownSlot: { namespace: 'both/mira' }, namespace: 'both/mira' });
    registry.register({ ...workerSpec('Auditor'), observes: [{ agent: 'clerk' }, { agent: 'scribe' }] });
    const open = async (namespace: string, auxiliaryMessageViews?: Array<{ namespace?: string }>) => {
      const cm = await ContextManager.open({
        store, namespace, isolate: true, strategy: new PassthroughStrategy(), ...(auxiliaryMessageViews ? { auxiliaryMessageViews } : {}),
      });
      closers.push(() => cm.close());
      return cm;
    };
    const mira = new TestAgent('mira', await openResident(store, 'mira'));
    const oren = new TestAgent('oren', await openResident(store, 'oren'));
    const clerk = new TestAgent('clerk', await open('subagent/clerk'));
    const scribe = new TestAgent('scribe', await open('subagent/scribe'));
    const both = new TestAgent('Both', await open('both/mira', [{}, { namespace: 'subagent/clerk' }]));
    const auditor = new TestAgent('Auditor', await open('subagent/Auditor', [{ namespace: 'subagent/clerk' }, { namespace: 'subagent/scribe' }]));
    const live = new Map<string, TestAgent>([mira, oren, clerk, scribe, both, auditor].map((a) => [a.name, a]));
    const alive = new Set<string>();
    const traces: PresentationTrace[] = [];
    const presentation = new AgentPresentation({
      liveAgents: () => live.values(), registry, turnAlive: (name) => alive.has(name), frozen: () => false, emitTrace: (e) => { traces.push(e); },
    });
    const write = (writer: TestAgent, participant: string, content: ContentBlock[], audience: string[], metadata: MessageMetadata = {}): MessageId => {
      const id = writer.cm.addMessage(participant, content, withAudience(metadata, audience));
      presentation.afterStore(writer, [id]);
      return id;
    };
    return { mira, oren, clerk, scribe, both, auditor, live, alive, traces, presentation, write, adoptAll: () => { for (const a of live.values()) presentation.adopt(a); } };
  }
  const HELD = { tuneOut: { epochId: 'e-1' } } as MessageMetadata;

  it("a reader of the residents' slot and a second slot is presented each slot's rows by the edge on it", async () => {
    const r = await twoSlotRig();
    r.adoptAll();
    const miraRound = storeOwnRow(r.mira, 'mira', text("mira's round"));
    const clerkRound = storeOwnRow(r.clerk, 'clerk', text("clerk's round"));
    const heldForResidents = r.write(r.mira, 'someone', text("held in the residents' slot"), [], HELD);
    const heldInClerks = r.write(r.clerk, 'someone', text("held in clerk's slot"), [], HELD);
    assert.equal(r.both.has(miraRound), true, "mira owns the residents' slot");
    assert.equal(r.both.has(clerkRound), true, "clerk's round, through the edge on clerk's slot, whose owner is clerk");
    assert.equal(r.both.has(heldForResidents), true, "the residents' edge shows held traffic");
    assert.equal(r.both.has(heldInClerks), false, "clerk's edge doesn't");
    assert.deepEqual(r.presentation.arrivalsOf(r.both), [], 'and nothing else is owed');
    assert.equal(r.mira.has(clerkRound), false, "clerk's slot is no resident's");
  });

  it('a reader of two slots, neither the residents\', is presented arrivals from both', async () => {
    const r = await twoSlotRig();
    r.adoptAll();
    r.alive.add('Auditor');
    const clerkRound = storeOwnRow(r.clerk, 'clerk', text("clerk's round"));
    const scribeRound = storeOwnRow(r.scribe, 'scribe', text("scribe's round"));
    const forScribe = r.write(r.scribe, 'someone', text('a row for scribe'), ['scribe']);
    const miraRound = storeOwnRow(r.mira, 'mira', text("mira's round"));
    assert.deepEqual(r.presentation.arrivalsOf(r.auditor).map((m) => m.id), [clerkRound, scribeRound, forScribe], 'owed while its turn is alive');
    r.alive.delete('Auditor');
    assert.deepEqual(r.presentation.presentAtEnd(r.auditor).map((m) => m.id), [clerkRound, scribeRound, forScribe]);
    assert.deepEqual(r.auditor.window(), ["clerk's round", "scribe's round", 'a row for scribe']);
    assert.equal(r.auditor.has(miraRound), false, "it has no edge on the residents' slot");
    const later = storeOwnRow(r.scribe, 'scribe', text("scribe's next round"));
    assert.equal(r.auditor.has(later), true, 'idle, it is presented a write at once (present at rest)');
  });

  it("a window written down at adopt keeps each slot's rows its edge shows, and takes out the rest", async () => {
    const r = await twoSlotRig();
    // Stored before the readers are taken on: their windows are still the whole record.
    const clerkRound = storeOwnRow(r.clerk, 'clerk', text("clerk's round"));
    const heldInClerks = r.clerk.cm.addMessage('someone', text("held in clerk's slot"), withAudience(HELD, []));
    const heldForResidents = r.mira.cm.addMessage('someone', text("held in the residents' slot"), withAudience(HELD, []));
    for (const name of ['mira', 'oren', 'clerk', 'scribe']) r.presentation.adopt(r.live.get(name)!);
    assert.equal(r.both.cm.windowMode(), 'legacy');
    r.presentation.adopt(r.both);
    assert.equal(r.both.has(clerkRound), true);
    assert.equal(r.both.has(heldForResidents), true, "the residents' edge shows held traffic");
    assert.equal(r.both.has(heldInClerks), false, "clerk's edge doesn't: taken out (retractForeign)");
    const retracted = ofType(r.traces, 'presentation:retracted').filter((t) => t.agentName === 'Both');
    assert.deepEqual(retracted.map((t) => t.messageIds), [[heldInClerks]]);
  });
});

describe('the presentation module when a store call fails', () => {
  /** Run `body` with console.error and console.warn silenced, as the module logs each failure it traces. */
  const quietly = <T>(body: () => T): T => {
    const { error, warn } = console;
    console.error = () => {};
    console.warn = () => {};
    try { return body(); } finally { console.error = error; console.warn = warn; }
  };

  it("an own row whose presentation at its write failed enters ahead of the next own row written: a round's reply before its results, and the hand-off vouches", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    // A row held back from the sink (present: false) is never kept for the
    // next write: it waits for the next point's sweep.
    const held = storeOwnRow(r.mira, 'user', text('held back'), undefined, undefined, false);
    const real = r.mira.cm.presentRows.bind(r.mira.cm);
    let failNext = true;
    r.mira.cm.presentRows = (ids) => {
      if (failNext) { failNext = false; throw new Error('a transient write failure'); }
      return real(ids);
    };
    const reply = quietly(() => storeOwnRow(r.mira, 'mira', [...text('calling'), toolUse('c1')]));
    assert.equal(r.mira.has(reply), false, 'the reply missed its write');
    assert.deepEqual(ofType(r.traces, 'presentation:failed').map((t) => [t.agentName, t.occasion]), [['mira', 'write']]);
    const results = storeOwnRow(r.mira, 'user', [toolResult('c1')]);
    assert.deepEqual([r.mira.has(reply), r.mira.has(results), r.mira.has(held)], [true, true, false],
      'the reply enters with its results; the row held back still waits');
    assert.deepEqual(r.mira.cm.getPresentedMessages().slice(-2).map((m) => m.id), [reply, results],
      'the reply ahead of its results, as the record has them');
    // The boundary, as the framework runs it: the round on the wire, then
    // what the stream hears (the held row, an own row due at this point),
    // then the hand-off of all of them in that order.
    const { heard } = r.presentation.presentAtBoundary(r.mira, [reply, results], { injects: true });
    assert.deepEqual(heard.map((h) => h.id), [held]);
    assert.deepEqual(r.presentation.handOff(r.mira, [reply, results, ...heard.map((h) => h.id)]), { vouched: true });
    assert.deepEqual(ofType(r.traces, 'presentation:hand-off-mismatch'), []);
    const compiled = await r.mira.cm.compile(undefined, undefined, { dryRun: true });
    assert.deepEqual(compiled.messages.slice(-3).map((m) => m.content.map((b) => b.type).join(',')), ['text,tool_use', 'tool_result', 'text'],
      'a compile sends the call before its result');
  });

  it("an own row kept after a failed write that enters at another point first isn't presented again, nor one an undo took out", async () => {
    const r = await rig();
    r.adoptAll();
    const real = r.mira.cm.presentRows.bind(r.mira.cm);
    let fail = true;
    r.mira.cm.presentRows = (ids) => {
      if (fail) throw new Error('a transient write failure');
      return real(ids);
    };
    const note = quietly(() => storeOwnRow(r.mira, 'user', text('a notice')));
    assert.equal(r.mira.has(note), false);
    fail = false;
    r.presentation.presentAtEnd(r.mira);
    assert.equal(r.mira.has(note), true, "the turn's end sweeps it in");
    const ordinal = r.mira.cm.ordinalOf(note);
    const failures = ofType(r.traces, 'presentation:failed').length;
    const next = storeOwnRow(r.mira, 'mira', text('a reply'));
    assert.equal(r.mira.cm.ordinalOf(note), ordinal, 'not presented again');
    assert.equal(r.mira.has(next), true);
    assert.equal(ofType(r.traces, 'presentation:failed').length, failures, 'the next write presented cleanly');

    fail = true;
    const undone = quietly(() => storeOwnRow(r.mira, 'mira', text('an undone reply')));
    fail = false;
    r.presentation.presentAtEnd(r.mira);
    r.mira.cm.retractRows([undone], { undone: true });
    assert.equal(r.mira.cm.windowStatusOf(undone), 'undone');
    const after = storeOwnRow(r.mira, 'mira', text('after the undo'));
    assert.equal(r.mira.cm.windowStatusOf(undone), 'undone', 'an undone row stays out');
    assert.equal(r.mira.has(after), true);
  });

  it("an own row kept after a failed write is the next turn start's to sweep: when that fails too, the next own row enters alone", async () => {
    const r = await rig();
    r.adoptAll();
    const real = r.mira.cm.presentRows.bind(r.mira.cm);
    let fail = true;
    r.mira.cm.presentRows = (ids) => {
      if (fail) throw new Error('a transient write failure');
      return real(ids);
    };
    const note = quietly(() => storeOwnRow(r.mira, 'user', text('a notice at rest')));
    r.alive.add('mira');
    // The turn's compile goes ahead without the notice: its sweep failed.
    quietly(() => r.presentation.presentAtStart(r.mira, 'compile'));
    fail = false;
    const reply = storeOwnRow(r.mira, 'mira', text('a reply its request had no notice before'));
    assert.deepEqual([r.mira.has(note), r.mira.has(reply)], [false, true], 'the notice is not put ahead of the reply');
    r.alive.delete('mira');
    r.presentation.presentAtEnd(r.mira);
    assert.deepEqual(r.mira.window().slice(-2), ['a reply its request had no notice before', 'a notice at rest'], "the notice at the turn's end");
  });

  it('a write-down that throws once its record is written leaves the agent presented, its sink installed, and nothing failed', async () => {
    const r = await rig();
    const before = storeOwnRow(r.mira, 'mira', text('a reply before the index'));
    const real = r.mira.cm.presentRows.bind(r.mira.cm);
    r.mira.cm.presentRows = (ids) => {
      const ordinals = real(ids);
      // As a write the store recorded and whose own snapshot then failed.
      if (ids.length === 0) throw new Error('the snapshot after the write failed');
      return ordinals;
    };
    quietly(() => r.adoptAll());
    assert.equal(r.mira.cm.windowMode(), 'presented', 'the write-down landed');
    assert.equal(r.presentation.presenting(r.mira), true, 'and the module presents for mira');
    assert.ok(r.mira.sink, 'her own-row sink is installed');
    assert.deepEqual(ofType(r.traces, 'presentation:failed'), [], 'nothing pinned her in legacy mode');
    assert.equal(r.mira.has(before), true);
    r.alive.add('mira');
    const reply = storeOwnRow(r.mira, 'mira', text('a reply after it'));
    assert.equal(r.mira.has(reply), true, 'an own row enters at its write');
  });

  it("a read that throws at a tool boundary hears nothing and is traced, and so is a hand-off's, which vouches for nothing", async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const reply = storeOwnRow(r.mira, 'mira', [...text('calling'), toolUse('c1')]);
    const results = storeOwnRow(r.mira, 'user', [toolResult('c1')]);
    const arrival = r.write(r.oren, 'someone', text('heard later'), ['mira']);
    const cm = r.mira.cm as unknown as { getUnpresentedMessages: () => unknown; getPresentedMessages: () => unknown };
    cm.getUnpresentedMessages = () => { throw new Error('the store could not be read'); };
    const boundary = quietly(() => r.presentation.presentAtBoundary(r.mira, [reply, results], { injects: true }));
    delete (cm as { getUnpresentedMessages?: unknown }).getUnpresentedMessages;
    assert.deepEqual(boundary, { heard: [] }, 'nothing heard, and no throw into the boundary');
    assert.equal(r.mira.has(arrival), false, 'the arrival waits');
    assert.deepEqual(ofType(r.traces, 'presentation:failed').map((t) => [t.agentName, t.occasion]), [['mira', 'tool-boundary']]);

    cm.getPresentedMessages = () => { throw new Error('the store could not be read'); };
    const handOff = quietly(() => r.presentation.handOff(r.mira, [reply, results]));
    delete (cm as { getPresentedMessages?: unknown }).getPresentedMessages;
    assert.deepEqual(handOff, { vouched: false }, 'the check could not be made');
    assert.deepEqual(ofType(r.traces, 'presentation:failed').map((t) => [t.agentName, t.occasion]), [['mira', 'tool-boundary'], ['mira', 'hand-off']]);
    assert.deepEqual(r.presentation.handOff(r.mira, [reply, results]), { vouched: true }, 'and the window it checks is as it was');
    r.alive.delete('mira');
    assert.deepEqual(r.presentation.presentAtEnd(r.mira).map((m) => m.id), [arrival], "the arrival at the turn's end");
  });
});
