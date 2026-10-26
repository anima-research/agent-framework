/**
 * The presentation module (src/presentation.ts, #291), driven directly over
 * real ContextManagers on a temp chronicle store, with a fake host: two
 * residents over the shared slot (mira, the primary, and oren), the
 * subconscious serving mira, which reads the residents' slot through its
 * observe edge, and a shared fork of mira on its own branch. Nothing of the
 * framework calls the module yet (FrameworkConfig.presentationIndex is
 * inert); these are its decisions on their own.
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
  AgentRegistry, audienceOf, residentSpec, storeOwnRow, subconsciousSpec, taskForkSpec, withAudience,
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

  it('a presentation cut short hears only the bodies that entered whole', async () => {
    const r = await rig();
    r.adoptAll();
    r.alive.add('mira');
    const ids = ['one', 'two', 'three'].map((t) => r.write(r.oren, 'someone', text(t), ['mira']));
    const append = r.store.appendToStateJsonWithIdentity;
    let n = 0;
    r.store.appendToStateJsonWithIdentity = function (this: JsStore, id: string, item: unknown, by: string, at: string) {
      if (id === 'agents/mira/window' && ++n === 2) throw new Error('the store failed partway');
      return append.call(this, id, item, by, at);
    } as typeof append;
    const error = console.error;
    console.error = () => {};
    let heard;
    try {
      heard = r.presentation.presentAtBoundary(r.mira, [], { injects: true }).heard;
    } finally {
      console.error = error;
      r.store.appendToStateJsonWithIdentity = append;
    }
    assert.deepEqual(heard.map((h) => h.id), [ids[0]], 'the prefix that entered');
    assert.deepEqual(ids.map((id) => r.mira.has(id)), [true, false, false]);
    assert.deepEqual(ofType(r.traces, 'presentation:failed').map((t) => [t.agentName, t.occasion]), [['mira', 'tool-boundary']]);
    r.alive.delete('mira');
    assert.deepEqual(r.presentation.presentAtEnd(r.mira).map((m) => m.id), ids.slice(1), 'the rest at the next point');
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
});
