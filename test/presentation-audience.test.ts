/**
 * The presentation index's audience rule (src/presentation.ts bearingOf,
 * readerFacts, audienceFault, and dendrite/audience.ts observedRowFor): what
 * one stored row is to one reader, from the row's stamp and the registry.
 * One case per kind of row, over a real AgentRegistry: two residents (mira,
 * the primary, and oren), the subconscious serving mira, an observer of the
 * residents' slot that doesn't see held traffic, a shared task fork of mira
 * on its own branch, and a worker; then readers that observe two slots, the
 * residents' and another, or two others, each slot's rows weighed by the
 * edge on it. Then, through a real framework with the subconscious, a
 * message addressed to it alone.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AgentFramework, AgentRegistry, RESIDENTS_SLOT, asOwnRow, audienceOf, observedRowFor, residentSpec, subconsciousSpec, taskForkSpec,
  withAudience, workerSpec,
} from '../src/index.js';
import type { EventResponse, Module, ProcessEvent, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { audienceFault, bearingOf, readerFacts, recordedReaderFacts } from '../src/presentation.js';
import { RoutedMembrane, say, until } from './helpers/dendrite.js';

const FORKED_AT = 10;

function registry(): AgentRegistry {
  const r = new AgentRegistry();
  r.register(residentSpec('mira', { primary: true }));
  r.register(residentSpec('oren', { primary: false }));
  r.register(subconsciousSpec('Subconscious', 'mira'));
  r.register({ ...subconsciousSpec('Watcher', 'mira'), observes: [{}], ownSlot: { namespace: 'watcher/mira' }, namespace: 'watcher/mira' });
  r.register(taskForkSpec('kid', {
    parent: 'mira',
    inherit: { mode: 'shared', atSequence: FORKED_AT, ownBranch: 'kid-branch', derivation: { slots: { messageNamespace: null } } },
  }));
  r.register(workerSpec('worker-1'));
  return r;
}

/** A stored row as bearingOf reads it. */
const row = (metadata: MessageMetadata | undefined, sequence = 20, participant = 'user') => ({ sequence, participant, metadata });
const held = (metadata: MessageMetadata) => ({ ...metadata, tuneOut: { epochId: 'e-1' } }) as MessageMetadata;
const injection = (agent: string) => ({ contextInjection: { agent, namespace: 'notes', contentHash: 'h', part: 0, parts: 1 } }) as unknown as MessageMetadata;

describe("the presentation index's audience rule", () => {
  const reg = registry();
  const mira = readerFacts(reg, 'mira');
  const oren = readerFacts(reg, 'oren');
  const sub = readerFacts(reg, 'Subconscious');
  const watcher = readerFacts(reg, 'Watcher');
  const kid = readerFacts(reg, 'kid');

  it("reads each reader's slot, edges and inheritance from the registry", () => {
    assert.deepEqual(mira.ownSlot, { namespace: null });
    assert.equal(mira.hidesHeld, true, 'a resident leaves held rows out');
    assert.equal(mira.observed.length, 0);
    assert.deepEqual(sub.ownSlot, { namespace: 'subconscious/mira' });
    assert.equal(sub.hidesHeld, false);
    assert.deepEqual(sub.observed.map((o) => [o.slot, o.edge.includeHeld, o.owners]), [[{ namespace: null }, true, ['mira', 'oren']]]);
    assert.deepEqual(kid.ownSlot, { namespace: null, branch: 'kid-branch' });
    assert.equal(kid.hidesHeld, true, "a shared fork of a resident carries the residents' filter");
    assert.equal(kid.derivedAt, FORKED_AT);
    assert.equal(readerFacts(reg, 'nobody').ownSlot, undefined, "an agent the registry doesn't know has no slot");
  });

  it("reads an agent that has ended from its newest ended record, as its release does; the live facts know nothing of it", () => {
    const ending = registry();
    const live = recordedReaderFacts(ending, 'kid');
    assert.deepEqual(live, kid, 'a live agent: the facts readerFacts gives');
    ending.end('kid', 'completed');
    ending.end('oren', 'stopped');
    assert.equal(readerFacts(ending, 'kid').ownSlot, undefined, 'readerFacts reads live records only');
    assert.deepEqual(recordedReaderFacts(ending, 'kid'), kid, 'its slot, its filter and its derivation point, as recorded');
    assert.deepEqual(recordedReaderFacts(ending, 'oren'), oren, "a stopped resident still reads the residents' slot");
    assert.equal(bearingOf(row(withAudience(undefined, ['mira'])), recordedReaderFacts(ending, 'oren'), 'own'), 'elsewhere',
      "the primary's notice is not the stopped resident's");
    assert.equal(bearingOf(row(undefined, FORKED_AT), recordedReaderFacts(ending, 'kid'), 'own'), 'elsewhere',
      "an unstamped row at its derivation point is its parent's inheritance");
    assert.equal(recordedReaderFacts(ending, 'nobody').ownSlot, undefined, "an agent the registry never knew has no slot");
  });

  it("an agent's own row is its own, and elsewhere for a co-resident (decision 1)", () => {
    const own = row(asOwnRow(undefined, 'mira'), 20, 'mira');
    assert.equal(bearingOf(own, mira, 'own'), 'own');
    assert.equal(bearingOf(own, oren, 'own'), 'elsewhere');
  });

  it('an untargeted row stamped for every resident is an arrival for each', () => {
    const untargeted = row(withAudience(undefined, ['mira', 'oren']));
    assert.equal(bearingOf(untargeted, mira, 'own'), 'arrival');
    assert.equal(bearingOf(untargeted, oren, 'own'), 'arrival');
  });

  it("mail for a co-resident is elsewhere, and the recipient's arrival", () => {
    const mail = row(withAudience({ dendrite: { mailId: 'm-1', to: 'oren' } } as MessageMetadata, ['oren']));
    assert.equal(bearingOf(mail, mira, 'own'), 'elsewhere');
    assert.equal(bearingOf(mail, oren, 'own'), 'arrival');
  });

  it("a held row is no resident's, and an arrival for the subconscious through its edge, which shows held traffic", () => {
    const heldRow = row(held(withAudience(undefined, [])));
    assert.equal(bearingOf(heldRow, mira, 'own'), 'elsewhere');
    assert.equal(bearingOf(heldRow, oren, 'own'), 'elsewhere');
    assert.equal(bearingOf(heldRow, sub, RESIDENTS_SLOT), 'arrival');
    assert.equal(bearingOf(heldRow, watcher, RESIDENTS_SLOT), 'elsewhere', "through an edge that doesn't show held traffic");
  });

  it("a resident's own round is an arrival for the subconscious (the observe edge's default)", () => {
    assert.equal(bearingOf(row(asOwnRow(undefined, 'mira'), 20, 'mira'), sub, RESIDENTS_SLOT), 'arrival');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'oren'), 20, 'oren'), sub, RESIDENTS_SLOT), 'arrival', "oren owns the slot it reads too");
  });

  it("another agent's stored context injection is never an arrival", () => {
    const stored = row(asOwnRow(injection('mira'), 'mira'), 20, 'system_context:notes');
    assert.equal(bearingOf(stored, mira, 'own'), 'own', "mira's own");
    assert.equal(bearingOf(stored, oren, 'own'), 'elsewhere');
    assert.equal(bearingOf(stored, sub, RESIDENTS_SLOT), 'elsewhere', 'not through an observe edge either');
    assert.equal(bearingOf(row(injection('mira'), 20, 'system_context:notes'), oren, 'own'), 'elsewhere', 'unstamped, too');
  });

  it("the subconscious's own delivery into the residents' slot is the residents' arrival, never its own", () => {
    const delivery = row(withAudience(undefined, ['mira']), 20, 'Subconscious');
    assert.equal(bearingOf(delivery, mira, 'own'), 'arrival');
    assert.equal(bearingOf(delivery, sub, RESIDENTS_SLOT), 'elsewhere', 'its round already holds what it delivered');
    assert.equal(observedRowFor({ includeHeld: true }, { participant: 'Subconscious', metadata: undefined }, { observer: 'Subconscious', owners: ['mira'] }), false);
  });

  it("an unstamped row is an arrival for the slot's owners and its observers", () => {
    const unstamped = row({ kind: 'host-notice' } as MessageMetadata);
    assert.equal(bearingOf(unstamped, mira, 'own'), 'arrival');
    assert.equal(bearingOf(unstamped, oren, 'own'), 'arrival');
    assert.equal(bearingOf(unstamped, sub, RESIDENTS_SLOT), 'arrival');
    assert.equal(bearingOf(row(held({})), mira, 'own'), 'elsewhere', 'but held, a resident leaves it out');
  });

  it("a shared fork's inheritance is not its arrival; a row for it is", () => {
    assert.equal(bearingOf(row(undefined, FORKED_AT), kid, 'own'), 'elsewhere', 'an unstamped row at the checkpoint');
    assert.equal(bearingOf(row(undefined, FORKED_AT + 1), kid, 'own'), 'arrival', 'one after it');
    assert.equal(bearingOf(row(withAudience(undefined, ['mira', 'oren']), 5), kid, 'own'), 'elsewhere', "the parent's arrival");
    assert.equal(bearingOf(row(asOwnRow(undefined, 'mira'), 5, 'mira'), kid, 'own'), 'elsewhere', "the parent's round");
    assert.equal(bearingOf(row(withAudience(undefined, ['kid']), 30), kid, 'own'), 'arrival');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'kid'), 31, 'mira'), kid, 'own'), 'own', "its own row, though named as its parent's voice");
  });

  it("a row addressed to the subconscious alone is its arrival through its edge, no resident's, and no fault", () => {
    const forSub = row(withAudience({ kind: 'module-note' } as MessageMetadata, ['Subconscious']));
    assert.equal(bearingOf(forSub, sub, RESIDENTS_SLOT), 'arrival', 'its edge shows a row meant for it, as the merged view did');
    assert.equal(bearingOf(forSub, mira, 'own'), 'elsewhere');
    assert.equal(bearingOf(forSub, oren, 'own'), 'elsewhere');
    assert.equal(bearingOf(forSub, watcher, RESIDENTS_SLOT), 'elsewhere', 'another observer of the slot is not named');
    assert.equal(observedRowFor({}, forSub, { observer: 'Subconscious', owners: ['mira', 'oren'] }), true, 'whatever the edge shows of held traffic');
    assert.equal(audienceFault(['Subconscious'], RESIDENTS_SLOT, reg), false, 'readable through the edge, so no fault');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'Subconscious')), sub, RESIDENTS_SLOT), 'elsewhere',
      'a row in the slot it watches stamped as its own is its own delivery, which its round holds');
    assert.equal(bearingOf(row(withAudience(undefined, ['Subconscious']), 20, 'Subconscious'), sub, RESIDENTS_SLOT), 'elsewhere',
      'nor a row stored under its own name');
  });

  it("a row stamped only for an agent that can't read the slot reaches no window, and is a routing fault", () => {
    const fault = row(withAudience(undefined, ['worker-9']));
    assert.equal(bearingOf(fault, mira, 'own'), 'elsewhere');
    assert.equal(bearingOf(fault, oren, 'own'), 'elsewhere');
    assert.equal(bearingOf(fault, sub, RESIDENTS_SLOT), 'elsewhere', 'not widened for an observer either');
    assert.equal(audienceFault(['worker-9'], RESIDENTS_SLOT, reg), true);
    assert.equal(audienceFault(['worker-1'], RESIDENTS_SLOT, reg), true, 'a live worker reads its own slot, not this one');
    assert.equal(audienceFault(['oren'], RESIDENTS_SLOT, reg), false);
    assert.equal(audienceFault(['Subconscious'], RESIDENTS_SLOT, reg), false, 'an observer reads the slot');
    assert.equal(audienceFault([], RESIDENTS_SLOT, reg), false, 'a held row names nobody');
    assert.equal(audienceFault(['worker-1'], reg.ownSlotOf('worker-1'), reg), false);
    assert.equal(audienceFault(['worker-9'], undefined, reg), false, 'no slot to weigh');
  });

  it('a row in no slot the reader observes is elsewhere', () => {
    const worker = readerFacts(reg, 'worker-1');
    assert.equal(bearingOf(row(withAudience(undefined, ['worker-1'])), worker, RESIDENTS_SLOT), 'elsewhere');
    assert.equal(bearingOf(row(withAudience(undefined, ['worker-1'])), worker, 'own'), 'arrival');
    assert.equal(bearingOf(row(withAudience(undefined, ['worker-1'])), worker, worker.ownSlot), 'arrival', 'its own slot named by its ref');
    assert.equal(bearingOf(row(withAudience(undefined, ['worker-1'])), worker, undefined), 'elsewhere', 'a slot its caller could not name');
  });
});

describe('the audience rule for a reader that observes more than one slot', () => {
  /** The residents, two workers (clerk and scribe, each in a slot of its own), and two readers over them. */
  function twoSlots(): AgentRegistry {
    const r = new AgentRegistry();
    r.register(residentSpec('mira', { primary: true }));
    r.register(residentSpec('oren', { primary: false }));
    r.register(workerSpec('clerk'));
    r.register(workerSpec('scribe'));
    // The residents' slot, held traffic shown, and clerk's slot, held traffic not shown.
    r.register({ ...subconsciousSpec('Both', 'mira'), observes: [{ includeHeld: true }, { agent: 'clerk' }], ownSlot: { namespace: 'both/mira' }, namespace: 'both/mira' });
    // Clerk's slot and scribe's, neither the residents'.
    r.register({ ...workerSpec('Auditor'), observes: [{ agent: 'clerk' }, { agent: 'scribe' }] });
    return r;
  }
  const reg = twoSlots();
  const both = readerFacts(reg, 'Both');
  const auditor = readerFacts(reg, 'Auditor');
  const clerkSlot = reg.ownSlotOf('clerk')!;
  const scribeSlot = reg.ownSlotOf('scribe')!;

  it('reads each edge with the slot it reads and that slot\'s owners', () => {
    assert.deepEqual(both.observed.map((o) => [o.slot, o.edge.includeHeld === true, o.owners]), [
      [{ namespace: null }, true, ['mira', 'oren']],
      [{ namespace: 'subagent/clerk' }, false, ['clerk']],
    ]);
    assert.deepEqual(auditor.observed.map((o) => [o.slot, o.owners]), [
      [{ namespace: 'subagent/clerk' }, ['clerk']],
      [{ namespace: 'subagent/scribe' }, ['scribe']],
    ]);
  });

  it("weighs a row of the residents' slot by the residents' edge, and a row of the second slot by that slot's edge", () => {
    const heldRow = row(held(withAudience(undefined, [])));
    assert.equal(bearingOf(heldRow, both, RESIDENTS_SLOT), 'arrival', "the residents' edge shows held traffic");
    assert.equal(bearingOf(heldRow, both, clerkSlot), 'elsewhere', "clerk's edge doesn't");
    const clerkRound = row(asOwnRow(undefined, 'clerk'), 20, 'clerk');
    assert.equal(bearingOf(clerkRound, both, clerkSlot), 'arrival', "clerk's round, in the slot clerk owns");
    assert.equal(bearingOf(clerkRound, both, RESIDENTS_SLOT), 'elsewhere', "clerk owns no row of the residents' slot");
    const miraRound = row(asOwnRow(undefined, 'mira'), 20, 'mira');
    assert.equal(bearingOf(miraRound, both, RESIDENTS_SLOT), 'arrival', "mira's round, in the slot mira owns");
    assert.equal(bearingOf(miraRound, both, clerkSlot), 'elsewhere', "the residents' owners don't own clerk's slot");
    const forBoth = row(withAudience(undefined, ['Both']));
    assert.equal(bearingOf(forBoth, both, clerkSlot), 'arrival', 'a row meant for it, through either edge');
    assert.equal(bearingOf(forBoth, both, RESIDENTS_SLOT), 'arrival');
    assert.equal(bearingOf(row(withAudience(undefined, ['clerk'])), both, scribeSlot), 'elsewhere', 'a slot it has no edge on');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'Both'), 20, 'Both'), both, 'own'), 'own', 'its own slot by its own rules');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'Both'), 20, 'Both'), both, { namespace: 'both/mira' }), 'own', 'named by its ref too');
  });

  it('takes arrivals from both of two slots, neither of them the residents\'', () => {
    assert.equal(bearingOf(row(asOwnRow(undefined, 'clerk'), 20, 'clerk'), auditor, clerkSlot), 'arrival');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'scribe'), 20, 'scribe'), auditor, scribeSlot), 'arrival');
    assert.equal(bearingOf(row(withAudience(undefined, ['scribe'])), auditor, scribeSlot), 'arrival', "a row meant for scribe's slot's owner");
    assert.equal(bearingOf(row({ kind: 'host-notice' } as MessageMetadata), auditor, clerkSlot), 'arrival', 'an unstamped row');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'scribe'), 20, 'scribe'), auditor, clerkSlot), 'elsewhere', "scribe owns no row of clerk's slot");
    assert.equal(bearingOf(row(asOwnRow(undefined, 'mira'), 20, 'mira'), auditor, RESIDENTS_SLOT), 'elsewhere', "it has no edge on the residents' slot");
    assert.equal(bearingOf(row(held(withAudience(undefined, []))), auditor, clerkSlot), 'elsewhere', 'no edge of its shows held traffic');
  });
});

/** A surface's module: an `external-message` event's text becomes a message, read by the agents its metadata names. */
class SurfaceModule implements Module {
  readonly name = 'surface';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const { content, metadata } = event as unknown as { content: ContentBlock[]; metadata: { ask: string[] } };
    return { addMessages: [{ participant: 'user', content }], requestInference: metadata.ask };
  }
}

describe('a message addressed to the subconscious alone, through the framework', () => {
  const dirs: string[] = [];
  const frameworks: AgentFramework[] = [];
  afterEach(async () => {
    while (frameworks.length) { try { await frameworks.pop()!.stop(); } catch { /* stopped */ } }
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("reaches the subconscious's window and the request of the wake it asked for; only a write no reader can read is traced", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-audience-subconscious-'));
    dirs.push(dir);
    const membrane = new RoutedMembrane();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: ['mira', 'oren'].map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.`, proseRouting: 'disabled' as const })),
      modules: [new SurfaceModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      subconscious: { enabled: true, systemPrompt: 'You notice.' },
    });
    frameworks.push(framework);
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    const SUB = 'Subconscious';
    membrane.script(SUB, say('noted'));
    framework.start();
    // An operator's message, or a module's process response, that names the
    // subconscious alone: delivered to the primary, so stored in the
    // residents' slot, which the subconscious reads through its edge.
    const note = 'AN OPERATOR NOTE FOR THE SUBCONSCIOUS';
    framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: note }], metadata: { ask: [SUB] } } as unknown as ProcessEvent);
    await until(() => membrane.callsFor(SUB).length > 0, "the subconscious's wake");
    await framework.runUntilIdle();

    const cm = (name: string) => framework.getAgent(name)!.getContextManager();
    const row = cm('mira').getAllMessages().find((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text === note));
    assert.ok(row, "stored in the residents' slot");
    assert.deepEqual(audienceOf(row.metadata)?.audience, [SUB], 'stamped for the subconscious alone, never widened');
    assert.equal(cm(SUB).windowStatusOf(row.id), 'in', "in the subconscious's window, through its observe edge");
    assert.equal(cm('mira').windowStatusOf(row.id), 'out', "in no resident's");
    assert.equal(cm('oren').windowStatusOf(row.id), 'out');
    assert.ok(JSON.stringify(membrane.callsFor(SUB).at(-1)!.messages).includes(note), "the subconscious's request carries it");
    assert.deepEqual(traces.filter((t) => t.type === 'presentation:unreadable-audience'), [], 'a row its addressee reads is no fault');

    // A write stamped only for an agent that reads no slot it lands in still is one.
    const internals = framework as unknown as {
      addMessage(participant: string, content: ContentBlock[], metadata?: MessageMetadata, opts?: { audience?: readonly string[] }): MessageId;
    };
    internals.addMessage('someone', [{ type: 'text', text: 'for a worker' }], undefined, { audience: ['worker-9'] });
    const faults = traces.filter((t): t is Extract<TraceEvent, { type: 'presentation:unreadable-audience' }> => t.type === 'presentation:unreadable-audience');
    assert.deepEqual(faults.map((t) => [t.audience, t.deliveredTo]), [[['worker-9'], 'mira']]);
  });
});
