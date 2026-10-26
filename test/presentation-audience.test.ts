/**
 * The presentation index's audience rule (src/presentation.ts bearingOf,
 * readerFacts, audienceFault, and dendrite/audience.ts observedRowFor): what
 * one stored row is to one reader, from the row's stamp and the registry.
 * One case per kind of row, over a real AgentRegistry: two residents (mira,
 * the primary, and oren), the subconscious serving mira, an observer of the
 * residents' slot that doesn't see held traffic, a shared task fork of mira
 * on its own branch, and a worker. Then, through a real framework with the
 * subconscious, a message addressed to it alone.
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
    assert.equal(bearingOf(row(withAudience(undefined, ['mira'])), recordedReaderFacts(ending, 'oren'), true), 'elsewhere',
      "the primary's notice is not the stopped resident's");
    assert.equal(bearingOf(row(undefined, FORKED_AT), recordedReaderFacts(ending, 'kid'), true), 'elsewhere',
      "an unstamped row at its derivation point is its parent's inheritance");
    assert.equal(recordedReaderFacts(ending, 'nobody').ownSlot, undefined, "an agent the registry never knew has no slot");
  });

  it("an agent's own row is its own, and elsewhere for a co-resident (decision 1)", () => {
    const own = row(asOwnRow(undefined, 'mira'), 20, 'mira');
    assert.equal(bearingOf(own, mira, true), 'own');
    assert.equal(bearingOf(own, oren, true), 'elsewhere');
  });

  it('an untargeted row stamped for every resident is an arrival for each', () => {
    const untargeted = row(withAudience(undefined, ['mira', 'oren']));
    assert.equal(bearingOf(untargeted, mira, true), 'arrival');
    assert.equal(bearingOf(untargeted, oren, true), 'arrival');
  });

  it("mail for a co-resident is elsewhere, and the recipient's arrival", () => {
    const mail = row(withAudience({ dendrite: { mailId: 'm-1', to: 'oren' } } as MessageMetadata, ['oren']));
    assert.equal(bearingOf(mail, mira, true), 'elsewhere');
    assert.equal(bearingOf(mail, oren, true), 'arrival');
  });

  it("a held row is no resident's, and an arrival for the subconscious through its edge, which shows held traffic", () => {
    const heldRow = row(held(withAudience(undefined, [])));
    assert.equal(bearingOf(heldRow, mira, true), 'elsewhere');
    assert.equal(bearingOf(heldRow, oren, true), 'elsewhere');
    assert.equal(bearingOf(heldRow, sub, false), 'arrival');
    assert.equal(bearingOf(heldRow, watcher, false), 'elsewhere', "through an edge that doesn't show held traffic");
  });

  it("a resident's own round is an arrival for the subconscious (the observe edge's default)", () => {
    assert.equal(bearingOf(row(asOwnRow(undefined, 'mira'), 20, 'mira'), sub, false), 'arrival');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'oren'), 20, 'oren'), sub, false), 'arrival', "oren owns the slot it reads too");
  });

  it("another agent's stored context injection is never an arrival", () => {
    const stored = row(asOwnRow(injection('mira'), 'mira'), 20, 'system_context:notes');
    assert.equal(bearingOf(stored, mira, true), 'own', "mira's own");
    assert.equal(bearingOf(stored, oren, true), 'elsewhere');
    assert.equal(bearingOf(stored, sub, false), 'elsewhere', 'not through an observe edge either');
    assert.equal(bearingOf(row(injection('mira'), 20, 'system_context:notes'), oren, true), 'elsewhere', 'unstamped, too');
  });

  it("the subconscious's own delivery into the residents' slot is the residents' arrival, never its own", () => {
    const delivery = row(withAudience(undefined, ['mira']), 20, 'Subconscious');
    assert.equal(bearingOf(delivery, mira, true), 'arrival');
    assert.equal(bearingOf(delivery, sub, false), 'elsewhere', 'its round already holds what it delivered');
    assert.equal(observedRowFor({ includeHeld: true }, { participant: 'Subconscious', metadata: undefined }, { observer: 'Subconscious', owners: ['mira'] }), false);
  });

  it("an unstamped row is an arrival for the slot's owners and its observers", () => {
    const unstamped = row({ kind: 'host-notice' } as MessageMetadata);
    assert.equal(bearingOf(unstamped, mira, true), 'arrival');
    assert.equal(bearingOf(unstamped, oren, true), 'arrival');
    assert.equal(bearingOf(unstamped, sub, false), 'arrival');
    assert.equal(bearingOf(row(held({})), mira, true), 'elsewhere', 'but held, a resident leaves it out');
  });

  it("a shared fork's inheritance is not its arrival; a row for it is", () => {
    assert.equal(bearingOf(row(undefined, FORKED_AT), kid, true), 'elsewhere', 'an unstamped row at the checkpoint');
    assert.equal(bearingOf(row(undefined, FORKED_AT + 1), kid, true), 'arrival', 'one after it');
    assert.equal(bearingOf(row(withAudience(undefined, ['mira', 'oren']), 5), kid, true), 'elsewhere', "the parent's arrival");
    assert.equal(bearingOf(row(asOwnRow(undefined, 'mira'), 5, 'mira'), kid, true), 'elsewhere', "the parent's round");
    assert.equal(bearingOf(row(withAudience(undefined, ['kid']), 30), kid, true), 'arrival');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'kid'), 31, 'mira'), kid, true), 'own', "its own row, though named as its parent's voice");
  });

  it("a row addressed to the subconscious alone is its arrival through its edge, no resident's, and no fault", () => {
    const forSub = row(withAudience({ kind: 'module-note' } as MessageMetadata, ['Subconscious']));
    assert.equal(bearingOf(forSub, sub, false), 'arrival', 'its edge shows a row meant for it, as the merged view did');
    assert.equal(bearingOf(forSub, mira, true), 'elsewhere');
    assert.equal(bearingOf(forSub, oren, true), 'elsewhere');
    assert.equal(bearingOf(forSub, watcher, false), 'elsewhere', 'another observer of the slot is not named');
    assert.equal(observedRowFor({}, forSub, { observer: 'Subconscious', owners: ['mira', 'oren'] }), true, 'whatever the edge shows of held traffic');
    assert.equal(audienceFault(['Subconscious'], RESIDENTS_SLOT, reg), false, 'readable through the edge, so no fault');
    assert.equal(bearingOf(row(asOwnRow(undefined, 'Subconscious')), sub, false), 'elsewhere',
      'a row in the slot it watches stamped as its own is its own delivery, which its round holds');
    assert.equal(bearingOf(row(withAudience(undefined, ['Subconscious']), 20, 'Subconscious'), sub, false), 'elsewhere',
      'nor a row stored under its own name');
  });

  it("a row stamped only for an agent that can't read the slot reaches no window, and is a routing fault", () => {
    const fault = row(withAudience(undefined, ['worker-9']));
    assert.equal(bearingOf(fault, mira, true), 'elsewhere');
    assert.equal(bearingOf(fault, oren, true), 'elsewhere');
    assert.equal(bearingOf(fault, sub, false), 'elsewhere', 'not widened for an observer either');
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
    assert.equal(bearingOf(row(withAudience(undefined, ['worker-1'])), worker, false), 'elsewhere');
    assert.equal(bearingOf(row(withAudience(undefined, ['worker-1'])), worker, true), 'arrival');
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
