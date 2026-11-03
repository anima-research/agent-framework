/**
 * AF #844 bot review, round 8: the tune-out coordinator and its
 * subconscious-window anchor.
 *
 * 65: a cancel deferred while writes were held in memory, whose run at the
 *     release throws, stays waiting with its note and is tried again (at
 *     the next release, or by one retry timer), never dropped.
 * 66: a kept start is recorded in force once it is set, not before, and
 *     one whose set fails is tried again at the next presentation.
 * 67: a kept start clamped to a shorter window is kept clamped.
 * 68: a restart with no start in force kept keeps the strategy's persisted
 *     anchor where it is earlier than the oldest active start.
 * 69: a window-starts record that can't be read is never written over.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import { SubconsciousWindowAnchor, type AnchoredStrategy } from '../src/tune-out/window-anchor.js';

interface Added { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; forAgent?: string }
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const textOf = (content: ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');

/** One tune-out (eA on disc:guild:a), with the framework's writesHeld and commitDeliveries hooks driven by the test. */
function deferredSetup() {
  const state = { held: true, durable: false, inForce: true };
  const added: Added[] = [];
  const params = { epochId: 'eA', cadenceSeconds: 300, backlogCap: 10, maxWakes: 3, startedAtSequence: 0 };
  const registry = {
    getTuneOutState: (_s: string, channelId: string) => (state.inForce && channelId === 'disc:guild:a' ? { params, wakeCount: 0 } : null),
    readCoordinatorState: () => null,
    nameShown: (channel: { channelId: string }) => channel.channelId,
    quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
    cancelTuneOut: () => { if (!state.inForce) return null; state.inForce = false; return { params, wakeCount: 0 }; },
    listChannelsRaw: () => [],
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      added.push({ participant, content, metadata, forAgent });
    },
    requestInference: () => {},
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [{ participant: 'user', content: [text('A1')], metadata: { author: { name: 'Ann' }, tuneOut: { epochId: 'eA' } } }],
    getSurgeryHeldMessages: () => [],
    unseenBySubconscious: () => 0,
    emitTrace: () => {},
    writesHeld: () => state.held,
    commitDeliveries: () => state.durable,
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  const notes = () => added.filter((m) => m.metadata?.kind === 'subconscious-note').map((m) => textOf(m.content));
  return { coordinator, state, added, notes };
}

test('65: a deferred cancel whose release is not made durable at the release stays waiting with its note, and runs at the next release', () => {
  const { coordinator, state, notes } = deferredSetup();
  const errors = mock.method(console, 'error', () => {});
  try {
    assert.deepEqual(coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.'), { ok: true, deferred: true });
    state.held = false;
    coordinator.runDeferredCancels();
    assert.ok(state.inForce, 'the release could not be made durable: the tune-out stays in force');
    assert.deepEqual(notes(), [], 'and its note is not delivered yet');
    assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes('stays waiting')), 'the failure is logged as waiting on');
    state.durable = true;
    coordinator.runDeferredCancels();
    assert.ok(!state.inForce, 'the next release ends it');
    assert.deepEqual(notes(), ['Someone asked for you.'], 'with the note asked for during the hold');
    coordinator.runDeferredCancels();
    assert.deepEqual(notes(), ['Someone asked for you.'], 'once');
  } finally {
    errors.mock.restore();
    coordinator.stop();
  }
});

test('65: with no later release, one retry timer runs the waiting cancel again; stop clears it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  try {
    const { coordinator, state, notes } = deferredSetup();
    coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.');
    state.held = false;
    coordinator.runDeferredCancels();
    assert.ok(state.inForce);
    mock.timers.tick(60_000);
    assert.ok(state.inForce, 'still not durable at the retry: it waits on');
    state.durable = true;
    mock.timers.tick(60_000);
    assert.ok(!state.inForce, 'the retry armed again ends it');
    assert.deepEqual(notes(), ['Look here.']);

    // stop() clears an armed retry: the tune-out stays in force on disk.
    const second = deferredSetup();
    second.coordinator.cancel('disc', 'disc:guild:a', 'duration', 'duration elapsed');
    second.state.held = false;
    second.coordinator.runDeferredCancels();
    second.coordinator.stop();
    second.state.durable = true;
    mock.timers.tick(120_000);
    assert.ok(second.state.inForce, 'no cancel runs after stop');
  } finally {
    errors.mock.restore();
    mock.timers.reset();
  }
});

test('65: a deferred cancel whose hold ended meanwhile ends nothing and is not tried again', () => {
  const { coordinator, state, added } = deferredSetup();
  try {
    coordinator.cancel('disc', 'disc:guild:a', 'duration', 'duration elapsed');
    state.inForce = false; // ended otherwise during the hold
    state.held = false;
    coordinator.runDeferredCancels();
    state.inForce = true;
    state.durable = true;
    coordinator.runDeferredCancels();
    assert.ok(state.inForce, 'the cancel that found no tune-out is not kept');
    assert.equal(added.length, 0);
  } finally {
    coordinator.stop();
  }
});

// ---------------------------------------------------------------------------
// 66 / 67 / 68 / 69: the subconscious's window start, kept by ordinal.
//
// The coordinator and the anchor wired as the framework wires them, over a
// window of `length` rows and a store of coordinator states: the coordinator's
// setSubconsciousAnchor is the anchor's set, and the anchor's fixed is the
// coordinator's subconsciousWindowFixed.
// ---------------------------------------------------------------------------


const STARTS = 'subconscious/scout/window-starts';
type Starts = { v: 1; starts: Record<string, number>; inForce?: number };

function anchored(options: { active: Array<{ epochId: string; sequence: number }>; state?: Omit<Starts, 'v'>; length: number; persisted?: number }) {
  const states = new Map<string, unknown>();
  if (options.state) states.set(STARTS, { v: 1, ...options.state });
  const writes: unknown[] = [];
  const control = { readFails: 0, setFails: 0, length: options.length, persisted: options.persisted, active: options.active };
  const channels = () => control.active.map((a) => ({ serverId: 'disc', descriptor: { id: `disc:guild:${a.epochId}` } }));
  const registry = {
    listChannelsRaw: channels,
    getTuneOutState: (_s: string, channelId: string) => {
      const a = control.active.find((e) => `disc:guild:${e.epochId}` === channelId);
      return a ? { params: { epochId: a.epochId, startedAtSequence: a.sequence, cadenceSeconds: 300, backlogCap: 10, maxWakes: 3 }, wakeCount: 0 } : null;
    },
    readCoordinatorState: (id: string) => {
      if (id === STARTS && control.readFails > 0) { control.readFails--; throw new Error('the store could not read it (test)'); }
      return states.get(id) ?? null;
    },
    writeCoordinatorState: (id: string, value: unknown) => { writes.push(value); states.set(id, structuredClone(value)); },
  };
  const calls: string[] = [];
  const traces: Array<{ how: string; ordinal: number; kept?: number; epochIds: string[] }> = [];
  const strategy: AnchoredStrategy = {
    setAnchor: (sequence) => { calls.push(`setAnchor(${sequence})`); },
    setAnchorOrdinal: (ordinal) => {
      calls.push(`setAnchorOrdinal(${ordinal})`);
      if (control.setFails > 0) { control.setFails--; throw new Error('the slot refused it (test)'); }
    },
    getAnchorOrdinal: () => control.persisted,
  };
  let coordinator!: TuneOutCoordinator;
  const anchor = new SubconsciousWindowAnchor({
    agentName: 'Subconscious',
    cm: () => ({ indexLength: () => control.length, getPresentedMessages: () => [], ordinalOf: () => undefined }) as never,
    strategy: () => strategy,
    presents: () => true,
    owed: () => [],
    fixed: (epochIds, ordinal, inForce) => coordinator.subconsciousWindowFixed(epochIds, ordinal, inForce),
    emitTrace: (event) => { traces.push(event as never); },
  });
  const hooks = {
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    subconsciousWindowOrdinals: () => true,
    setSubconsciousAnchor: (start: never, others: never) => anchor.set(start, others),
    emitTrace: () => {},
  };
  coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  const internals = coordinator as unknown as {
    anchorSubconscious(occasion?: 'enter' | 'resume'): void;
    forgetWindowStart(epochId: string): void;
    pruneWindowStarts(): void;
  };
  const kept = () => states.get(STARTS) as Starts | undefined;
  return { coordinator, internals, anchor, control, calls, traces, writes, kept };
}

test('66: a kept start is recorded in force only once it is set, and one whose set fails is set and recorded at the next presentation', () => {
  // X (start 3) was cancelled with Y (start 7) active: the start in force stays X's.
  const h = anchored({ active: [{ epochId: 'Y', sequence: 70 }, { epochId: 'Z', sequence: 90 }], state: { starts: { Y: 7 }, inForce: 3 }, length: 12 });
  h.control.setFails = 1;
  const errors = mock.method(console, 'error', () => {});
  try {
    h.internals.anchorSubconscious('enter');
  } finally { errors.mock.restore(); }
  assert.deepEqual(h.calls, ['setAnchorOrdinal(7)'], "an enter sets the oldest active tune-out's kept start");
  assert.equal(h.kept()?.inForce, 3, 'its set failed, so the record keeps the start the strategy still has');
  h.anchor.presented();
  assert.deepEqual(h.calls, ['setAnchorOrdinal(7)', 'setAnchorOrdinal(7)'], 'tried again at the next presentation');
  assert.equal(h.kept()?.inForce, 7, 'and recorded in force once set');
  assert.equal(h.kept()?.starts.Y, 7);
  assert.deepEqual(h.traces.filter((t) => t.epochIds.includes('Y')), [], 'a kept start set again is not traced as fixed');
  h.anchor.presented();
  assert.equal(h.calls.length, 2, 'and then no more');
});

test('67: a kept start clamped to a shorter window is kept at the clamped ordinal, so a restart on a longer window sets that', () => {
  const h = anchored({ active: [{ epochId: 'X', sequence: 30 }], state: { starts: { X: 10 }, inForce: 10 }, length: 5 });
  h.internals.anchorSubconscious('enter');
  assert.deepEqual(h.calls, ['setAnchorOrdinal(5)']);
  assert.deepEqual(h.kept(), { v: 1, starts: { X: 5 }, inForce: 5 }, 'the clamped ordinal is kept as the start and in force');
  assert.deepEqual(h.traces.map((t) => [t.how, t.ordinal, t.kept]), [['clamped', 5, 10]]);
  h.control.length = 12; // more rows presented after the clamp
  h.internals.anchorSubconscious('resume');
  assert.deepEqual(h.calls, ['setAnchorOrdinal(5)', 'setAnchorOrdinal(5)'], 'a restart sets 5, not 10, leaving rows 5-9 in the window');
});

test("68: a restart that finds no start in force kept keeps the strategy's persisted anchor where it is earlier than the oldest active start", () => {
  // X's start was set by sequence (converted, persisted at 2) and X was
  // cancelled before its start was kept; Y's start was kept (7) beside it.
  const h = anchored({ active: [{ epochId: 'Y', sequence: 70 }], state: { starts: { Y: 7 } }, length: 12, persisted: 2 });
  h.internals.anchorSubconscious('resume');
  assert.deepEqual(h.calls, ['setAnchorOrdinal(2)'], "the window keeps the start it had, not Y's");
  assert.deepEqual(h.kept(), { v: 1, starts: { Y: 7 }, inForce: 2 }, "kept as the start in force, Y's own start untouched");
  h.internals.anchorSubconscious('resume');
  assert.deepEqual(h.calls, ['setAnchorOrdinal(2)', 'setAnchorOrdinal(2)'], 'and the same at the next restart');

  // Later than the oldest active start (a re-anchor moved it on): the kept start, as before.
  const later = anchored({ active: [{ epochId: 'Y', sequence: 70 }], state: { starts: { Y: 7 } }, length: 12, persisted: 9 });
  later.internals.anchorSubconscious('resume');
  assert.deepEqual(later.calls, ['setAnchorOrdinal(7)']);
  // An enter sets the oldest active tune-out's start, as it always has.
  const enter = anchored({ active: [{ epochId: 'Y', sequence: 70 }], state: { starts: { Y: 7 } }, length: 12, persisted: 2 });
  enter.internals.anchorSubconscious('enter');
  assert.deepEqual(enter.calls, ['setAnchorOrdinal(7)']);
});

test("68: a restart that finds a cancelled tune-out's start in force sets it, without keeping it as the active one's", () => {
  const h = anchored({ active: [{ epochId: 'Y', sequence: 70 }], state: { starts: { Y: 7 }, inForce: 3 }, length: 12 });
  h.internals.anchorSubconscious('resume');
  assert.deepEqual(h.calls, ['setAnchorOrdinal(3)']);
  assert.deepEqual(h.kept(), { v: 1, starts: { Y: 7 }, inForce: 3 }, "Y's own start stays 7, for the next enter");
});

test('69: a window-starts record that cannot be read is never written over, and its fix is kept once it can be read', () => {
  const h = anchored({ active: [{ epochId: 'X', sequence: 30 }, { epochId: 'Y', sequence: 70 }], state: { starts: { X: 3 }, inForce: 3 }, length: 12 });
  const errors = mock.method(console, 'error', () => {});
  try {
    h.control.readFails = 1;
    assert.equal(h.coordinator.subconsciousWindowFixed(['Y'], 8, false), false, 'not kept');
    assert.deepEqual(h.writes, [], 'and nothing written over the record');
    assert.equal(h.coordinator.subconsciousWindowFixed(['Y'], 8, false), true);
    assert.deepEqual(h.kept(), { v: 1, starts: { X: 3, Y: 8 }, inForce: 3 }, "X's start is kept beside Y's");

    // An anchor whose read fails leaves the window where it was, nothing written.
    const writes = h.writes.length;
    h.control.readFails = 1;
    h.internals.anchorSubconscious('enter');
    assert.deepEqual(h.calls, [], 'the window start is not moved');
    h.control.readFails = 2;
    h.internals.forgetWindowStart('X');
    h.internals.pruneWindowStarts();
    assert.equal(h.writes.length, writes, 'nor is anything written by a forget or a prune');
    assert.deepEqual(h.kept(), { v: 1, starts: { X: 3, Y: 8 }, inForce: 3 });
  } finally { errors.mock.restore(); }
});
