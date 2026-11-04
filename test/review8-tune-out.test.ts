/**
 * AF #844 bot review, round 8: the tune-out coordinator and its
 * subconscious-window anchor.
 *
 * 65: a cancel deferred while writes were held in memory, whose run at the
 *     release throws, stays waiting with its note and is tried again (at
 *     the next release, or by one retry timer), never dropped. Follow-up
 *     (Isaac-3593): it ends only the hold it was asked for, never a later
 *     one on the same channel, and the note it carries is delivered when
 *     another cancel ends that hold first. A note that is lost (that
 *     delivery fails, the cancel's own run fails to deliver it, or its hold
 *     ends without it) is told lost to its author, and why, in its own
 *     context, and the trace names the author. Round 3: a notice of the
 *     loss that can't be written is kept, traced at its first failure, and
 *     tried again at the next release and the retry; the cancel_tuneout
 *     that waits with a note says so.
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
// 65, AF #844 review follow-up (Isaac-3593): a deferred cancel acts on the
// hold it was asked for, and its note reaches the resident when another
// cancel ends that hold.
//
// The coordinator over a registry that keeps what its own enter and
// enterAllExcept record, so each tune-out on disc:guild:a, and each
// all-except hold, is an epoch of its own; the framework's writesHeld and
// commitDeliveries driven by the test. Each epoch holds one stored row.
// ---------------------------------------------------------------------------

type Trace = Record<string, unknown> & { type: string };

/** `forks`: reader forks read, with no persistent subconscious; a fork's note goes out as its mail (`mail`). */
function epochSetup(options: { forks?: boolean } = {}) {
  const state = { held: false, durable: true, noteFails: false, noticeFails: false, wakeFails: false, subNameFailsAfterEnd: false };
  let channel: { params: { epochId: string }; wakeCount: number } | null = null;
  const states = new Map<string, unknown>();
  const rows: Array<{ participant: string; content: ContentBlock[]; metadata: Record<string, unknown>; sequence: number }> = [];
  const added: Added[] = [];
  const mail: Array<{ reader: string; text: string }> = [];
  const wakes: Array<[string, string]> = [];
  const traces: Trace[] = [];
  const registry = {
    getTuneOutState: (_s: string, channelId: string) => (channelId === 'disc:guild:a' ? channel : null),
    enterTuneOut: (_s: string, _c: string, params: { epochId: string }) => { channel = { params, wakeCount: 0 }; },
    cancelTuneOut: () => { const ended = channel; channel = null; return ended; },
    readCoordinatorState: (id: string) => states.get(id) ?? null,
    writeCoordinatorState: (id: string, value: unknown) => {
      if (value === null) states.delete(id); else states.set(id, structuredClone(value));
    },
    nameShown: (c: { channelId: string }) => c.channelId,
    quotedShown: (c: { channelId: string }) => JSON.stringify(c.channelId),
    listChannelsRaw: () => [{ serverId: 'disc', descriptor: { id: 'disc:guild:a' } }],
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      if (state.noteFails && metadata?.kind === 'subconscious-note') throw new Error('the store refused the row (test)');
      if (state.noticeFails && metadata?.kind === 'tune-out-note-undelivered') throw new Error('the store refused the notice too (test)');
      added.push({ participant, content, metadata, forAgent });
      return `m${added.length}`;
    },
    requestInference: (agentName: string, reason: string) => {
      if (state.wakeFails) throw new Error('the wake could not be queued (test)');
      wakes.push([agentName, reason]);
    },
    subconsciousName: () => {
      if (state.subNameFailsAfterEnd && channel === null) throw new Error('the subconscious could not be named (test)');
      return options.forks ? null : 'Subconscious';
    },
    ...(options.forks
      ? {
          invokeReader: () => {},
          deliverFromReader: (reader: string, content: ContentBlock[]) => {
            if (state.noteFails) throw new Error('the mail could not be held (test)');
            mail.push({ reader, text: textOf(content) });
          },
        }
      : {}),
    primaryName: () => 'scout',
    getStoredMessages: () => rows,
    getSurgeryHeldMessages: () => [],
    unseenBySubconscious: () => 0,
    emitTrace: (event: Trace) => { traces.push(event); },
    writesHeld: () => state.held,
    commitDeliveries: () => state.durable,
    isForkBound: () => false,
    currentSequence: () => rows.length,
    setSubconsciousAnchor: () => {},
  };
  const coordinator = new TuneOutCoordinator(registry as never, {} as never, hooks as never);
  const hold = (epochId: string, channelId: string): void => {
    rows.push({
      participant: 'user', content: [text(`held in ${epochId}`)], sequence: rows.length + 1,
      metadata: { author: { name: 'Ann' }, tuneOut: { epochId }, channelId, serverId: 'disc' },
    });
  };
  const enter = (): string => {
    const r = coordinator.enter('disc', 'disc:guild:a', {}, 'agent-tool');
    assert.ok(r.ok, 'premise: entered');
    hold(r.params.epochId, 'disc:guild:a');
    return r.params.epochId;
  };
  const enterScope = (): string => {
    const r = coordinator.enterAllExcept({ serverId: 'disc', channelId: 'disc:guild:x' }, { durationSeconds: 3600 }, 'agent-tool');
    assert.ok(r.ok, 'premise: entered');
    hold(r.params.epochId, 'disc:guild:b');
    return r.params.epochId;
  };
  /** The epoch holding disc:guild:a now, or null. */
  const inForce = (): string | null => channel?.params.epochId ?? null;
  const scopeInForce = (): string | null => coordinator.getAllExcept()?.params.epochId ?? null;
  /** The epochs of the releases written, in order: a release that isn't made durable is written all the same. */
  const releases = () => added.filter((m) => m.metadata?.kind === 'tune-out-cancel').map((m) => m.metadata?.epochId);
  const releasesOf = (epochId: string) => releases().filter((e) => e === epochId).length;
  const notes = () => added.filter((m) => m.metadata?.kind === 'subconscious-note')
    .map((m) => ({ from: m.participant, text: textOf(m.content), epochId: m.metadata?.epochId }));
  const dropped = () => traces.filter((t) => t.type === 'tune-out:deferred-cancel-dropped');
  /** The notices that a queued note was not delivered, with whom each is for. */
  const lossNotices = () => added.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered');
  /** The traces of a loss notice not written: its write failed, or its author was gone. */
  const untold = () => traces.filter((t) => t.type === 'tune-out:note-loss-untold');
  /** The registry ends A without this coordinator's cancel. */
  const endOtherwise = (): void => { channel = null; };
  return { coordinator, state, added, mail, wakes, traces, enter, enterScope, inForce, scopeInForce, releasesOf, notes, dropped, lossNotices, untold, endOtherwise };
}

/** The first release of a deferred cancel, after writes resume, fails: it stays queued for the retry. */
function failFirstRelease(h: ReturnType<typeof epochSetup>): void {
  h.state.held = false;
  h.state.durable = false;
  h.coordinator.runDeferredCancels();
  h.state.durable = true;
}

test('65 follow-up: a cancel accepted for one tune-out, still queued after its first release failed, never ends a later tune-out on the same channel', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'duration', 'duration elapsed'), { ok: true, deferred: true });
    failFirstRelease(h);
    assert.equal(h.inForce(), a, 'premise: its release failed, A stays in force');
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true }, 'a direct cancel ends A');
    const b = h.enter();
    assert.notEqual(b, a);
    mock.timers.tick(60_000);
    assert.equal(h.inForce(), b, "the retry of A's cancel leaves B in force");
    assert.equal(h.releasesOf(b), 0, 'and writes no release of B');
    assert.ok(!h.traces.some((t) => t.type === 'tune-out:cancelled' && t.epochId === b), 'nor records its end');
    mock.timers.tick(120_000);
    assert.equal(h.inForce(), b, 'nor at a later retry');

    // Control: B's own cancel ends B.
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    assert.equal(h.inForce(), null);
    assert.equal(h.releasesOf(b), 1);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up: an all-except hold's cancel, still queued after its first release failed, never ends a later all-except hold", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enterScope();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancelAllExcept('subconscious', 'by Subconscious'), { ok: true, deferred: true });
    failFirstRelease(h);
    assert.equal(h.scopeInForce(), a, 'premise: its release failed, A stays in force');
    assert.deepEqual(h.coordinator.cancelAllExcept('agent-tool', 'agent request'), { ok: true });
    const b = h.enterScope();
    mock.timers.tick(60_000);
    assert.equal(h.scopeInForce(), b, "the retry of A's cancel leaves B in force");
    assert.equal(h.releasesOf(b), 0);
    assert.deepEqual(h.coordinator.cancelAllExcept('agent-tool', 'agent request'), { ok: true }, "control: B's own cancel ends B");
    assert.equal(h.scopeInForce(), null);
    assert.equal(h.releasesOf(b), 1);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test('65 follow-up: a queued cancel whose tune-out ended in the registry without it is dropped, told with the epoch it was for, and leaves the later tune-out in force', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.');
    failFirstRelease(h);
    h.endOtherwise();
    const b = h.enter();
    mock.timers.tick(60_000);
    assert.equal(h.inForce(), b, 'B stays in force');
    assert.equal(h.releasesOf(b), 0, 'no release of B is written');
    assert.deepEqual(h.notes(), [], "and A's note does not go out with any");
    assert.deepEqual(h.dropped(), [{
      type: 'tune-out:deferred-cancel-dropped', serverId: 'disc', channelId: 'disc:guild:a', epochId: a,
      reason: 'hold-ended', currentEpochId: b, noteLost: true, noteAuthor: 'Subconscious',
    }], 'the drop is traced, naming the epoch it was for, why, and the note it carried, with its author');
    const line = errors.mock.calls.map((c) => String(c.arguments[0])).find((l) => l.includes('is dropped'));
    assert.ok(line?.includes(a) && line.includes(b) && /note/.test(line), `the log line names both epochs and the note: ${line}`);
    mock.timers.tick(120_000);
    assert.equal(h.dropped().length, 1, 'it is not tried again');
    assert.equal(h.inForce(), b);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test('65 follow-up: a deferred cancel whose run ends its tune-out and then fails is not kept, so no retry of it ends a later tune-out', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'duration', 'duration elapsed');
    h.state.held = false;
    h.state.wakeFails = true;
    h.coordinator.runDeferredCancels();
    assert.equal(h.inForce(), null, 'premise: its run ended A, and the wake after the end threw');
    h.state.wakeFails = false;
    const b = h.enter();
    mock.timers.tick(120_000);
    assert.equal(h.inForce(), b, 'B stays in force');
    assert.equal(h.releasesOf(b), 0);
    const line = errors.mock.calls.map((c) => String(c.arguments[0])).find((l) => l.includes('a step after the end failed'));
    assert.ok(line?.includes(a), `the failure after the end is logged, naming the epoch: ${line}`);
    assert.deepEqual(h.dropped(), [], 'it ran, so it is not told as dropped');
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up: a later tune-out's own cancel, asked for while a stale one waits, takes its place and runs at the release", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'For A.');
    failFirstRelease(h);
    h.endOtherwise();
    const b = h.enter();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'For B.'), { ok: true, deferred: true },
      "B's cancel waits with its own note, not dropped for A's");
    assert.deepEqual(h.dropped().map((t) => [t.epochId, t.reason, t.currentEpochId]), [[a, 'hold-ended', b]]);
    h.state.held = false;
    h.coordinator.runDeferredCancels();
    assert.equal(h.inForce(), null, "B's cancel ends B");
    assert.equal(h.releasesOf(b), 1);
    assert.deepEqual(h.notes(), [{ from: 'Subconscious', text: 'For B.', epochId: b }]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up: a subconscious's note, queued with a cancel whose first release failed, is delivered once when the resident's cancel ends that hold", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.'), { ok: true, deferred: true });
    failFirstRelease(h);
    assert.deepEqual(h.notes(), [], 'premise: not delivered yet');
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    assert.deepEqual(h.notes(), [{ from: 'Subconscious', text: 'Someone asked for you.', epochId: a }], "under the subconscious's name, for A");
    const kinds = h.added.map((m) => m.metadata?.kind);
    assert.ok(kinds.indexOf('tune-out-cancel') < kinds.indexOf('subconscious-note'), 'after the release, as the deferred release delivers it');
    mock.timers.tick(120_000);
    assert.equal(h.notes().length, 1, 'once: the retry has nothing left to run');
    assert.deepEqual(h.dropped(), []);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up: a subconscious's note queued with the all-except hold's cancel is delivered once when another cancel ends the hold", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enterScope();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancelAllExcept('subconscious', 'by Subconscious', 'Look at #b.'), { ok: true, deferred: true });
    failFirstRelease(h);
    assert.deepEqual(h.coordinator.cancelAllExcept('channel-close', 'the excepted channel was closed'), { ok: true });
    assert.deepEqual(h.notes(), [{ from: 'Subconscious', text: 'Look at #b.', epochId: a }]);
    mock.timers.tick(120_000);
    assert.equal(h.notes().length, 1);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up: a direct cancel with a note of its own, ending a hold whose queued cancel has one, delivers both, the queued one first", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'The first note.');
    failFirstRelease(h);
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'The second note.'), { ok: true });
    assert.deepEqual(h.notes().map((n) => [n.text, n.epochId]), [['The first note.', a], ['The second note.', a]]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up: a queued note that can't be delivered when another cancel ends its hold is told lost, with the reason, and the cancel still ends the hold", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.');
    failFirstRelease(h);
    h.state.noteFails = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    assert.equal(h.inForce(), null, 'the hold ends');
    assert.deepEqual(h.dropped(), [{
      type: 'tune-out:deferred-cancel-dropped', serverId: 'disc', channelId: 'disc:guild:a', epochId: a,
      reason: 'note-undelivered', noteLost: true, noteAuthor: 'Subconscious', error: 'the store refused the row (test)',
    }]);
    const line = errors.mock.calls.map((c) => String(c.arguments[0])).find((l) => l.includes('is lost'));
    assert.ok(line?.includes(a) && line.includes('Subconscious'), `the log line names the epoch and the author: ${line}`);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593): the subconscious whose queued note can't be delivered when another cancel ends its hold is told so in its own context, naming the hold and why", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.', 'Subconscious'),
      { ok: true, deferred: true }, 'premise: its cancel, with its note, was accepted as waiting');
    failFirstRelease(h);
    h.state.noteFails = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true }, 'the ending cancel still answers ok');
    assert.equal(h.inForce(), null, 'and ends the hold');
    assert.deepEqual(h.notes(), [], 'premise: the note was not delivered');
    const told = h.lossNotices();
    assert.equal(told.length, 1, 'its author is told once');
    assert.equal(told[0]!.forAgent, 'Subconscious', "in the subconscious's own context");
    assert.equal(told[0]!.participant, 'user', "framed by the framework, not in anyone's voice");
    assert.deepEqual(told[0]!.metadata, { system: true, kind: 'tune-out-note-undelivered', channelId: 'disc:guild:a', epochId: a });
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. Another cancel ended '
      + 'that tune-out while yours waited, and delivering the note then failed: the store refused the row (test).]',
      'the notice names the hold, the resident and the reason');
    const kinds = h.added.map((m) => m.metadata?.kind);
    assert.ok(kinds.indexOf('tune-out-note-undelivered') < kinds.indexOf('tune-out-cancel-report'),
      'before the cancel notice, whose turn reads it');
    assert.deepEqual(h.dropped().map((t) => [t.reason, t.noteAuthor, t.error]),
      [['note-undelivered', 'Subconscious', 'the store refused the row (test)']], 'the trace names the author too');
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593): a queued note of the all-except hold's cancel that can't be delivered is told lost to its author, naming the hold", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enterScope();
    h.state.held = true;
    h.coordinator.cancelAllExcept('subconscious', 'by Subconscious', 'Look at #b.', 'Subconscious');
    failFirstRelease(h);
    h.state.noteFails = true;
    assert.deepEqual(h.coordinator.cancelAllExcept('channel-close', 'the excepted channel was closed'), { ok: true });
    assert.equal(h.scopeInForce(), null);
    const told = h.lossNotices();
    assert.equal(told.length, 1);
    assert.equal(told[0]!.forAgent, 'Subconscious');
    assert.deepEqual(told[0]!.metadata, { system: true, kind: 'tune-out-note-undelivered', channelId: 'disc:guild:x', epochId: a, scope: 'all-except' });
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of the all-except hold (all channels except disc:guild:x) was not '
      + 'delivered to scout. Another cancel ended that hold while yours waited, and delivering the note then failed: '
      + 'the store refused the row (test).]');
    assert.deepEqual(h.dropped().map((t) => [t.scope, t.noteAuthor]), [['all-except', 'Subconscious']]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593): a reader fork whose queued note can't be delivered as its mail is told so in its own context, and the trace names the fork", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup({ forks: true });
  try {
    const a = h.enter();
    h.state.held = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by reader-1', 'Someone asked for you.', 'reader-1'),
      { ok: true, deferred: true });
    failFirstRelease(h);
    h.state.noteFails = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    assert.equal(h.inForce(), null);
    assert.deepEqual(h.mail, [], 'premise: the mail was not held');
    const told = h.lossNotices();
    assert.equal(told.length, 1);
    assert.equal(told[0]!.forAgent, 'reader-1', "in the fork's own context");
    assert.equal(told[0]!.participant, 'user');
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. Another cancel ended '
      + 'that tune-out while yours waited, and delivering the note then failed: the mail could not be held (test).]');
    assert.deepEqual(h.dropped().map((t) => [t.reason, t.noteAuthor, t.error]),
      [['note-undelivered', 'reader-1', 'the mail could not be held (test)']]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593, round 3): a loss notice that can't be written is traced at its first failure, kept, and written at the next release; the ending cancel still ends the hold and answers ok", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.', 'Subconscious');
    failFirstRelease(h);
    h.state.noteFails = true;
    h.state.noticeFails = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    assert.equal(h.inForce(), null);
    assert.deepEqual(h.lossNotices(), [], 'premise: the note and the notice of its loss were both refused');
    const line = errors.mock.calls.map((c) => String(c.arguments[0])).find((l) => l.includes('could not be told'));
    assert.ok(line?.includes('Subconscious') && line.includes('the store refused the notice too (test)') && line.includes('disc:guild:a'),
      `the log line names the author, the hold and why: ${line}`);
    assert.deepEqual(h.dropped().map((t) => [t.epochId, t.noteAuthor]), [[a, 'Subconscious']], 'the trace still names the author');
    assert.deepEqual(h.untold(), [{
      type: 'tune-out:note-loss-untold', serverId: 'disc', channelId: 'disc:guild:a', epochId: a,
      noteAuthor: 'Subconscious', reason: 'write-failed', error: 'the store refused the notice too (test)',
    }], "the notice's first failure is traced, with its author and the error");
    assert.equal(h.added.filter((m) => m.metadata?.kind === 'tune-out-cancel-report').length, 1, 'and the cancel goes on to its notice');
    assert.ok(!h.wakes.some(([, why]) => why.startsWith('tune-out note not delivered')), 'no turn is asked for a notice not written');

    // The framework runs the waiting work at each release of held writes.
    h.state.noticeFails = false;
    h.coordinator.runDeferredCancels();
    const told = h.lossNotices();
    assert.equal(told.length, 1, 'the kept notice is written at the next release');
    assert.equal(told[0]!.forAgent, 'Subconscious');
    assert.deepEqual(told[0]!.metadata, { system: true, kind: 'tune-out-note-undelivered', channelId: 'disc:guild:a', epochId: a });
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. Another cancel ended '
      + 'that tune-out while yours waited, and delivering the note then failed: the store refused the row (test).]');
    assert.deepEqual(h.wakes.filter(([, why]) => why.startsWith('tune-out note not delivered')),
      [['Subconscious', 'tune-out note not delivered: disc:guild:a']], 'with a turn to read it');
    h.coordinator.runDeferredCancels();
    assert.equal(h.lossNotices().length, 1, 'once');
    assert.equal(h.untold().length, 1, 'traced once');
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593, round 3): a loss notice still refused at the 60 s retry is tried again at the next one, traced at its first failure only; a stop clears it", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  const g = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.', 'Subconscious');
    failFirstRelease(h);
    h.state.noteFails = true;
    h.state.noticeFails = true;
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    const failures = () => errors.mock.calls.filter((c) => String(c.arguments[0]).includes('could not be told')).length;
    assert.equal(failures(), 1);
    mock.timers.tick(60_000);
    assert.deepEqual(h.lossNotices(), [], 'still refused at the retry');
    assert.equal(failures(), 2, 'which tried it again');
    assert.equal(h.untold().length, 1, 'the trace records the first failure only');
    h.state.noticeFails = false;
    mock.timers.tick(60_000);
    assert.deepEqual(h.lossNotices().map((m) => [m.forAgent, m.metadata?.epochId]), [['Subconscious', a]], 'the next retry writes it');
    mock.timers.tick(120_000);
    h.coordinator.runDeferredCancels();
    assert.equal(h.lossNotices().length, 1, 'once');

    // A stop clears a kept notice, as it clears a waiting cancel.
    g.enter();
    g.state.held = true;
    g.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.', 'Subconscious');
    failFirstRelease(g);
    g.state.noteFails = true;
    g.state.noticeFails = true;
    g.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request');
    assert.equal(g.untold().length, 1, 'premise: kept');
    g.coordinator.stop();
    g.state.noticeFails = false;
    mock.timers.tick(120_000);
    g.coordinator.runDeferredCancels();
    assert.deepEqual(g.lossNotices(), [], 'nothing is written after the stop');
    const lost = errors.mock.calls.map((c) => String(c.arguments[0])).find((l) => l.includes('never written'));
    assert.ok(lost?.includes('Subconscious'), `the stop logs the notice it drops: ${lost}`);
  } finally {
    h.coordinator.stop();
    g.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up (Isaac-3593, round 3): a kept notice of a cancel dropped for a later hold, written after that hold ended, says it was in force then and has ended since", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.', 'Subconscious');
    failFirstRelease(h);
    h.endOtherwise();
    h.enter();
    h.state.noticeFails = true;
    mock.timers.tick(60_000);
    assert.deepEqual(h.dropped().map((t) => [t.epochId, t.reason]), [[a, 'hold-ended']], 'premise: the retry drops it for B');
    assert.equal(h.untold().length, 1, 'premise: its notice was refused, and is kept');
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true }, "B's own cancel ends B");
    h.state.noticeFails = false;
    mock.timers.tick(60_000);
    assert.deepEqual(h.lossNotices().map((m) => textOf(m.content)), [
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. That tune-out ended '
      + 'without your cancel while it waited, so your cancel was dropped, and the note with it. A later tune-out of '
      + 'disc:guild:a, which your cancel was not for, was in force when your cancel was dropped, and has ended since.]',
    ], 'the later hold as it is when the notice is written');
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up (Isaac-3593, round 3): the subconscious's cancel_tuneout that waits with its note says when the note is delivered, that a loss is told, and what follows a notice that can't be written", async () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    h.enter();
    h.state.held = true;
    const waits = 'Not cancelled yet: an operator\'s change to the store is in progress, or a context the cancel writes to '
      + 'refuses writes until the host re-initializes it, so the cancel waits until that is over. Cancelling again '
      + 'doesn\'t end the wait sooner, and how long it lasts isn\'t known here. ';
    const stop = 'If the host stops before then, the cancel is lost and it is still in force after the restart, unless its '
      + 'end time has passed by then.';
    const kept = (hold: string) => ` Your note waits with the cancel and is delivered when ${hold} ends. If it can't be `
      + 'delivered then, you are told so in your context, and why. If writing that notice fails too, the failure is '
      + 'traced for the host, and the notice is tried again every 60 s, except while such a change or refusal lasts, and '
      + `as soon as one ends, until it is written or the host stops. If the host stops before ${hold} ends, your note is `
      + 'lost with the cancel, and you are not told.';
    assert.deepEqual(
      await h.coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'disc:guild:a', serverId: 'disc', text: 'Look here.' }, [], 'Subconscious'),
      { success: true, data: { waiting: true, note: `${waits}The tune-out stays in force until then, and what it held is delivered when it ends. ${stop}${kept('the tune-out')}` } });
    assert.deepEqual(
      await h.coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'disc:guild:a', serverId: 'disc' }, [], 'Subconscious'),
      { success: true, data: { waiting: true, note: `${waits}The tune-out stays in force until then, and what it held is delivered when it ends. ${stop}` } },
      'control: with no note of its own, nothing is said of one');
    h.state.held = false;
    h.coordinator.runDeferredCancels();
    h.enterScope();
    h.state.held = true;
    assert.deepEqual(
      await h.coordinator.handleSubconsciousTool('cancel_tuneout', { channelId: 'all-except', scope: 'all-except', text: 'Look at #b.' }, [], 'Subconscious'),
      { success: true, data: { waiting: true, scope: 'all-except', note: `${waits}The all-except hold stays in force until then, and what it held is delivered when it ends. ${stop}${kept('the all-except hold')}` } });
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593): a queued cancel whose hold ended without it tells the note's author that the note was dropped with it, and gives it a turn", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.', 'Subconscious');
    failFirstRelease(h);
    h.endOtherwise();
    const b = h.enter();
    mock.timers.tick(60_000);
    assert.equal(h.inForce(), b, 'premise: the retry drops it, leaving B in force');
    const told = h.lossNotices();
    assert.equal(told.length, 1);
    assert.equal(told[0]!.forAgent, 'Subconscious');
    assert.deepEqual(told[0]!.metadata, { system: true, kind: 'tune-out-note-undelivered', channelId: 'disc:guild:a', epochId: a });
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. That tune-out ended '
      + 'without your cancel while it waited, so your cancel was dropped, and the note with it. A later tune-out of '
      + 'disc:guild:a is in force now, which your cancel was not for.]');
    assert.deepEqual(h.wakes, [['Subconscious', 'tune-out note not delivered: disc:guild:a']], 'a turn to read it, as nothing else gives one');
    assert.deepEqual(h.dropped().map((t) => [t.reason, t.noteAuthor]), [['hold-ended', 'Subconscious']]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up (Isaac-3593): a queued cancel of an ended tune-out, found by the next tune-out's cancel, tells the note's author it was dropped", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Look here.', 'Subconscious');
    failFirstRelease(h);
    h.endOtherwise();
    h.enter();
    assert.deepEqual(h.coordinator.cancel('disc', 'disc:guild:a', 'agent-tool', 'agent request'), { ok: true });
    assert.equal(h.inForce(), null);
    assert.deepEqual(h.lossNotices().map((m) => textOf(m.content)), [
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. That tune-out ended '
      + 'without your cancel while it waited, so your cancel was dropped, and the note with it.]',
    ]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593): a queued cancel whose own run ends its tune-out and then can't write its note tells its author, and the cancel goes on", () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.', 'Subconscious');
    h.state.held = false;
    h.state.noteFails = true;
    h.coordinator.runDeferredCancels();
    assert.equal(h.inForce(), null, 'its run ends A');
    assert.deepEqual(h.notes(), [], 'premise: its note was not written');
    const told = h.lossNotices();
    assert.equal(told.length, 1);
    assert.equal(told[0]!.forAgent, 'Subconscious');
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. Your cancel ended '
      + 'that tune-out when it ran, and delivering the note then failed: the store refused the row (test).]');
    assert.deepEqual(h.dropped().map((t) => [t.epochId, t.reason, t.noteAuthor, t.error]),
      [[a, 'note-undelivered', 'Subconscious', 'the store refused the row (test)']]);
    assert.ok(h.traces.some((t) => t.type === 'tune-out:cancelled' && t.epochId === a), 'the cancel goes on to record its end');
    assert.ok(h.wakes.some(([agent]) => agent === 'Subconscious'));
    assert.ok(!errors.mock.calls.some((c) => String(c.arguments[0]).includes('a step after the end failed')), 'its run did not fail');
    mock.timers.tick(120_000);
    assert.equal(h.lossNotices().length, 1, 'told once');
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
    mock.timers.reset();
  }
});

test("65 follow-up (Isaac-3593): the all-except hold's queued cancel whose own run can't write its note tells its author", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    h.enterScope();
    h.state.held = true;
    h.coordinator.cancelAllExcept('subconscious', 'by Subconscious', 'Look at #b.', 'Subconscious');
    h.state.held = false;
    h.state.noteFails = true;
    h.coordinator.runDeferredCancels();
    assert.equal(h.scopeInForce(), null);
    assert.deepEqual(h.lossNotices().map((m) => textOf(m.content)), [
      '[Tune-out: the note you left with your cancel of the all-except hold (all channels except disc:guild:x) was not '
      + 'delivered to scout. Your cancel ended that hold when it ran, and delivering the note then failed: the store '
      + 'refused the row (test).]',
    ]);
    assert.deepEqual(h.dropped().map((t) => [t.scope, t.reason, t.noteAuthor]), [['all-except', 'note-undelivered', 'Subconscious']]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test("65 follow-up (Isaac-3593): a queued cancel's run that ends its tune-out and fails before its note is written tells the note's author, with the error", () => {
  const errors = mock.method(console, 'error', () => {});
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.', 'Subconscious');
    h.state.held = false;
    h.state.subNameFailsAfterEnd = true;
    h.coordinator.runDeferredCancels();
    assert.equal(h.inForce(), null, 'premise: its run ended A');
    assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes('a step after the end failed')), 'premise: and then failed');
    assert.deepEqual(h.notes(), []);
    const told = h.lossNotices();
    assert.equal(told.length, 1);
    assert.equal(told[0]!.forAgent, 'Subconscious');
    assert.equal(textOf(told[0]!.content),
      '[Tune-out: the note you left with your cancel of disc:guild:a was not delivered to scout. Your cancel ended '
      + 'that tune-out when it ran, and delivering the note then failed: the subconscious could not be named (test).]');
    assert.deepEqual(h.dropped().map((t) => [t.epochId, t.reason, t.noteAuthor, t.error]),
      [[a, 'note-undelivered', 'Subconscious', 'the subconscious could not be named (test)']]);
  } finally {
    h.coordinator.stop();
    errors.mock.restore();
  }
});

test('65 follow-up, control: a deferred cancel whose release succeeds delivers its note once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = epochSetup();
  try {
    const a = h.enter();
    h.state.held = true;
    h.coordinator.cancel('disc', 'disc:guild:a', 'subconscious', 'by Subconscious', 'Someone asked for you.');
    h.state.held = false;
    h.coordinator.runDeferredCancels();
    assert.equal(h.inForce(), null);
    assert.deepEqual(h.notes(), [{ from: 'Subconscious', text: 'Someone asked for you.', epochId: a }]);
    mock.timers.tick(120_000);
    h.coordinator.runDeferredCancels();
    assert.equal(h.notes().length, 1);
  } finally {
    h.coordinator.stop();
    mock.timers.reset();
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
