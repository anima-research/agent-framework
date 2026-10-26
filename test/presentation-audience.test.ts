/**
 * The presentation index's audience rule (src/presentation.ts bearingOf,
 * readerFacts, audienceFault, and dendrite/audience.ts observedRowFor): what
 * one stored row is to one reader, from the row's stamp and the registry.
 * One case per kind of row, over a real AgentRegistry: two residents (mira,
 * the primary, and oren), the subconscious serving mira, an observer of the
 * residents' slot that doesn't see held traffic, a shared task fork of mira
 * on its own branch, and a worker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageMetadata } from '@animalabs/context-manager';
import {
  AgentRegistry, RESIDENTS_SLOT, asOwnRow, observedRowFor, residentSpec, subconsciousSpec, taskForkSpec, withAudience, workerSpec,
} from '../src/index.js';
import { audienceFault, bearingOf, readerFacts } from '../src/presentation.js';

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
