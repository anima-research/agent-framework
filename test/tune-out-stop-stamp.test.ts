/**
 * AF #844 review, round 8 (Weft's reading of cf481ec8): the stop stamp and
 * what a boot tells the persistent subconscious of a hold the last stop
 * didn't stamp.
 *
 * 1. No stamp record at all is a first start on a version that stamps its
 *    stops, not a crash: no row.
 * 2. A release of the hold's epoch stored since the cancel was asked: the
 *    cancel ran (`ran`), its end not recorded.
 * 3. A bare channel id two servers' holds answer to names neither; the
 *    waiting answer's server, or the call's, names one.
 * 4. A boot whose stamp the store refused tries it again, and a waiting
 *    cancel's answer says so meanwhile.
 * 5. One account of a lost note, not two; one row per hold across crashes,
 *    but where a later boot finds more than it told, or the loss is asked
 *    again after it was told.
 *
 * And the pins: each test below goes red when the line it names breaks.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { TuneOutCoordinator, cancelAsksIn, unansweredIn, type WindowRow } from '../src/tune-out/coordinator.js';

type Trace = Record<string, unknown> & { type: string };
interface Row { participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; sequence: number; shardIndex?: number; forAgent?: string }

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const textOf = (content: readonly ContentBlock[]): string =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
const SUB = 'Subconscious';
const STAMP = 'tune-out/scout/stop-stamp';
const LOSS_RECORD = 'tune-out/scout/loss-notices';
const SCOPE = 'tune-out/scout/all-except';

/**
 * A coordinator over a registry whose holds are on record by server and
 * channel (tuneOutsOnRecord), none registered, as at boot; the residents'
 * rows (`rows`) and the subconscious's window (`window`) set by the test, a
 * write for the subconscious landing in its window too. `refuse`: state ids
 * whose writes the store refuses.
 */
function stampSetup() {
  const states = new Map<string, unknown>();
  const refuse = new Set<string>();
  const holds: Array<{ serverId: string; channelId: string; epochId: string; startedAt: number }> = [];
  const shown = new Map<string, string>();
  const rows: Row[] = [];
  const window: Row[] = [];
  const added: Row[] = [];
  const wakes: Array<[string, string]> = [];
  const traces: Trace[] = [];
  /** Each write of the stamp tried, refused or not. */
  const stampTries = { count: 0 };
  const state = {
    held: false, seq: 100, endFails: false,
    /** The subconscious's context refuses writes. */
    subRefuses: false,
    /** The store refuses a note's row (`subconscious-note`). */
    noteRefuses: false,
    /** The stamp can't be read. */
    stampUnreadable: false,
    /** A release isn't made durable (commitDeliveries answers false). */
    commitFails: false,
    /** The holds' channels are registered, as a boot after #900 may find them, with this wake count. */
    registered: false, wakeCount: 0,
    /** The store's branch now (switchTo). */
    branch: 'main',
    /** A channel can't be named (nameShown throws). */
    shownFails: false,
    /** The subconscious's presentation is frozen (a quiesced boot): a write for it is stored, and not in its window. */
    frozen: false,
    /** The residents' rows can't be read from this read on (getStoredMessages throws); the reads so far are `rowReads`. */
    rowsFailFrom: Infinity, rowReads: 0,
  };
  /** Every write for the subconscious, stored, whether or not its window holds it (`frozen`). */
  const subRows: Row[] = [];
  /** Each state write and each sync, in order: `write:<id>`, `sync`. */
  const log: string[] = [];
  const key = (s: string, c: string) => `${s}\0${c}`;
  /** A listener inside each write, as a host's synchronous trace listener of the store write runs. */
  let onWrite: ((row: Row) => void) | undefined;
  const registry = {
    tuneOutsOnRecord: () => holds.map((h) => ({ serverId: h.serverId, channelId: h.channelId, params: { epochId: h.epochId, startedAtSequence: h.startedAt }, source: 'agent-tool' })),
    getTuneOutState: (s: string, c: string) => {
      const h = holds.find((x) => x.serverId === s && x.channelId === c);
      return h ? { params: { epochId: h.epochId, startedAtSequence: h.startedAt, cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, wakeCount: state.wakeCount } : null;
    },
    cancelTuneOut: (s: string, c: string) => {
      if (state.endFails) throw new Error('the end could not be recorded (test)');
      const at = holds.findIndex((x) => x.serverId === s && x.channelId === c);
      return at >= 0 ? holds.splice(at, 1)[0] : null;
    },
    readCoordinatorState: (id: string) => {
      if (state.stampUnreadable && id === STAMP) throw new Error('the stamp could not be read (test)');
      return states.get(id) ?? null;
    },
    writeCoordinatorState: (id: string, value: unknown) => {
      if (id === STAMP) stampTries.count++;
      if (refuse.has(id)) throw new Error(`the store refused ${id} (test)`);
      log.push(`write:${id}`);
      if (value === null) states.delete(id); else states.set(id, structuredClone(value));
    },
    nameShown: (c: { serverId: string; channelId: string }) => {
      if (state.shownFails) throw new Error('the channel could not be named (test)');
      return shown.get(key(c.serverId, c.channelId)) ?? c.channelId;
    },
    quotedShown: (c: { channelId: string }) => JSON.stringify(c.channelId),
    listChannelsRaw: () => (state.registered ? holds.map((x) => ({ serverId: x.serverId, descriptor: { id: x.channelId } })) : []),
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      if (forAgent === SUB && state.subRefuses) throw new Error("the subconscious's context refused the write (test)");
      if (metadata?.kind === 'subconscious-note' && state.noteRefuses) throw new Error('the store refused the note (test)');
      const row: Row = { participant, content, ...(metadata ? { metadata } : {}), sequence: ++state.seq, ...(forAgent ? { forAgent } : {}) };
      onWrite?.(row);
      added.push(row);
      if (forAgent === SUB) {
        subRows.push(row);
        if (!state.frozen) window.push(row);
      } else rows.push(row);
      return `m${state.seq}`;
    },
    requestInference: (agentName: string, reason: string) => { wakes.push([agentName, reason]); },
    subconsciousName: () => SUB,
    primaryName: () => 'scout',
    getStoredMessages: () => {
      if (++state.rowReads >= state.rowsFailFrom) throw new Error("the residents' rows could not be read (test)");
      return rows;
    },
    getSurgeryHeldMessages: () => [],
    unseenBySubconscious: () => 0,
    subconsciousWindow: () => window,
    subconsciousStoredMessages: () => subRows,
    emitTrace: (event: Trace) => { traces.push(event); },
    writesHeld: () => state.held,
    commitDeliveries: () => { log.push('sync'); return !state.commitFails; },
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    currentSequence: () => state.seq,
    currentBranch: () => state.branch,
    setSubconsciousAnchor: () => {},
  };
  /**
   * The store's branches: each its own states, rows, window and head; the
   * holds on record are the registry's, which a move doesn't reload (#172).
   */
  const branches = new Map<string, { states: Array<[string, unknown]>; rows: Row[]; window: Row[]; subRows: Row[]; seq: number }>();
  const snapshot = () => ({ states: [...states].map(([k, v]) => [k, structuredClone(v)] as [string, unknown]), rows: [...rows], window: [...window], subRows: [...subRows], seq: state.seq });
  /** A branch made from the one the store is on, at its head: its rows and states, as a child branch has them. */
  const fork = (name: string): void => { branches.set(name, snapshot()); };
  /** The store moves to branch `name`, made by fork. */
  const switchTo = (name: string): void => {
    const to = branches.get(name);
    assert.ok(to, `premise: branch ${name} was made`);
    branches.set(state.branch, snapshot());
    states.clear();
    for (const [k, v] of to.states) states.set(k, v);
    rows.splice(0, rows.length, ...to.rows);
    window.splice(0, window.length, ...to.window);
    subRows.splice(0, subRows.length, ...to.subRows);
    state.seq = to.seq;
    state.branch = name;
  };
  const made: TuneOutCoordinator[] = [];
  const make = (): TuneOutCoordinator => { const c = new TuneOutCoordinator(registry as never, {} as never, hooks as never); made.push(c); return c; };
  /** A hold on record, begun now. */
  const hold = (channelId = 'noisy', serverId = 'editor', epochId = `e-${serverId}-${channelId}-${state.seq}`): string => {
    holds.push({ serverId, channelId, epochId, startedAt: ++state.seq });
    return epochId;
  };
  /** The all-except hold on record, excepting `except`. */
  const holdScope = (epochId = `scope-${state.seq}`, expiresAtMs = Date.now() + 3_600_000): string => {
    states.set(SCOPE, { params: {
      epochId, except: { serverId: 'editor', channelId: 'work' }, cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5,
      startedAtSequence: ++state.seq, startedAtMs: Date.now(), expiresAtMs, source: 'agent-tool',
    }, wakeCount: 0 });
    return epochId;
  };
  /** A start of the coordinator, as a boot makes it. */
  const boot = (): TuneOutCoordinator => { const c = make(); c.resumeActiveEpochs(); return c; };
  /** The subconscious's own call of cancel_tuneout, and its result, in its window. */
  const ask = (input: Record<string, unknown>, answer: unknown = { waiting: true }, id = `ask-${state.seq}`): number => {
    const sequence = ++state.seq;
    window.push({ participant: SUB, content: [{ type: 'tool_use', id, name: 'cancel_tuneout', input } as ContentBlock], sequence });
    window.push({ participant: 'user', content: [{ type: 'tool_result', toolUseId: id, toolName: 'cancel_tuneout', content: JSON.stringify(answer) } as unknown as ContentBlock], sequence: ++state.seq });
    return sequence;
  };
  /** A release of `epochId` stored by a cancel from `source`, giving `reason`. */
  const release = (epochId: string, source: string, reason: string, by?: string): void => {
    rows.push({ participant: 'user', content: [text(`[Tune-out: cancelled — ${reason}]`)], metadata: { system: true, kind: 'tune-out-cancel', epochId, cancel: { source, reason, ...(by !== undefined ? { by } : {}) } }, sequence: ++state.seq });
  };
  /** The subconscious's note of `epochId`, delivered to the resident. */
  const note = (epochId: string): void => {
    rows.push({ participant: SUB, content: [text('Look.')], metadata: { kind: 'subconscious-note', epochId }, sequence: ++state.seq });
  };
  /** The rows told of an unrecorded stop, in the subconscious's window. */
  const unrecorded = () => window.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered' && textOf(m.content).includes('without recording'));
  const told = () => window.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered');
  const stopAll = (): void => { for (const c of made) c.stop(); };
  const listenWrites = (fn: (row: Row) => void): void => { onWrite = fn; };
  return { subRows, log, listenWrites, states, refuse, holds, shown, rows, window, added, wakes, traces, state, make, hold, holdScope, boot, ask, release, note, unrecorded, told, stopAll, fork, switchTo, stampTries };
}

const conditional = (hold: string, epochId: string, it = 'tune-out') => `[Tune-out: the host stopped without recording the state of ${hold} `
  + `(epoch ${epochId}). If you asked for a cancel of it before the stop, it had not run when the host stopped: it was lost, and any note `
  + `you left with it. That ${it} is still in force.]`;

function quiet<T>(fn: () => T): T {
  const errors = mock.method(console, 'error', () => {});
  try { return fn(); } finally { errors.mock.restore(); }
}

// ---------------------------------------------------------------------------
// 1. A first start on a version that stamps its stops.
// ---------------------------------------------------------------------------

test('1 (Weft): a hold on record with no stamp record at all, as an upgraded store has, gets no row and no turn; the boot writes its stamp', () => quiet(() => {
  const h = stampSetup();
  try {
    h.hold();
    h.boot();
    assert.deepEqual(h.told(), [], 'no row');
    assert.deepEqual(h.wakes, [], 'no turn');
    assert.deepEqual(h.traces.filter((t) => t.type === 'tune-out:stop-unrecorded'), []);
    assert.deepEqual((h.states.get(STAMP) as { epochs: unknown }).epochs, [], 'its own stamp, covering none, is written');
  } finally { h.stopAll(); }
}));

test("1 (Weft), control: a stamp from an earlier run that doesn't list the hold gets the row and a turn", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)]);
    assert.deepEqual(h.wakes, [[SUB, 'tune-out stop not recorded: noisy']]);
  } finally { h.stopAll(); }
}));

// ---------------------------------------------------------------------------
// 2. The cancel ran: a release of the epoch stored since it was asked.
// ---------------------------------------------------------------------------

test("2 (Weft): a release of the epoch stored after the subconscious's waiting ask says the cancel ran, its end not recorded, with or without its note", () => quiet(() => {
  for (const withNote of [true, false]) {
    const h = stampSetup();
    try {
      h.boot();
      const e = h.hold();
      h.ask({ channelId: 'noisy', ...(withNote ? { text: 'Look at the build.\nThe log is long.' } : {}) });
      h.release(e, 'subconscious', 'by Subconscious');
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [
        `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${e}). The cancel of it you asked for ran: `
        + `its release reached scout${withNote ? ', but the note you left with it, "Look at the build.", did not' : ''}. Its end was not `
        + 'recorded, so that tune-out is still in force.]',
      ]);
      assert.deepEqual(h.traces.filter((t) => t.type === 'tune-out:stop-unrecorded').map((t) => t.found), ['ran']);
    } finally { h.stopAll(); }
  }
}));

test('2 (Weft), control: a release stored before the ask leaves it as asked, not run', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.rows.push({ participant: 'user', content: [text('release')], metadata: { system: true, kind: 'tune-out-cancel', channelId: 'noisy', epochId: e }, sequence: ++h.state.seq });
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.boot();
    assert.match(textOf(h.unrecorded()[0]!.content), /The cancel of it you asked for with your note "Look\." had not run/);
  } finally { h.stopAll(); }
}));

// ---------------------------------------------------------------------------
// 3. Two servers' channels of one id.
// ---------------------------------------------------------------------------

test("3 (Weft): a bare cancel_tuneout of a channel id two servers' holds answer to, its result naming no server, names neither", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const a = h.hold('noisy', 'editor');
    const b = h.hold('noisy', 'other');
    h.shown.set('other\0noisy', 'other:noisy');
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)).sort(), [
      conditional('the tune-out of noisy', a), conditional('the tune-out of other:noisy', b),
    ].sort(), 'conditional for both');
  } finally { h.stopAll(); }
}));

for (const how of ['its result', 'its own serverId', 'its qualified name'] as const) {
  test(`3 (Weft), control: the call naming the server by ${how} names that hold alone`, () => quiet(() => {
    const h = stampSetup();
    try {
      h.boot();
      const a = h.hold('noisy', 'editor');
      const b = h.hold('noisy', 'other');
      h.shown.set('other\0noisy', 'other:noisy');
      if (how === 'its result') h.ask({ channelId: 'noisy', text: 'Look.' }, { waiting: true, serverId: 'other' });
      else if (how === 'its own serverId') h.ask({ channelId: 'noisy', serverId: 'other', text: 'Look.' });
      else h.ask({ channelId: 'other:noisy', text: 'Look.' });
      h.boot();
      const byEpoch = new Map(h.unrecorded().map((m) => [m.metadata?.epochId, textOf(m.content)]));
      assert.equal(byEpoch.get(a), conditional('the tune-out of noisy', a));
      assert.match(byEpoch.get(b) ?? '', /The cancel of it you asked for with your note "Look\." had not run/);
    } finally { h.stopAll(); }
  }));
}

test('small (Weft): the all-except hold asked for through a channel it held, or by a qualified name, its result naming the scope, is named', () => quiet(() => {
  for (const channelId of ['chatty', 'editor:chatty']) {
    const h = stampSetup();
    try {
      h.boot();
      const s = h.holdScope();
      h.ask({ channelId, text: 'Back to work.' }, { waiting: true, scope: 'all-except' });
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [
        `[Tune-out: the host stopped without recording the state of the all-except hold (all channels except work; epoch ${s}). The `
        + 'cancel of it you asked for with your note "Back to work." had not run when the host stopped: it was lost, and the note you '
        + 'left with it. That hold is still in force.]',
      ], channelId);
    } finally { h.stopAll(); }
  }
}));

// ---------------------------------------------------------------------------
// 4. A boot's stamp the store refuses.
// ---------------------------------------------------------------------------

test("4 (Weft): a boot whose stamp the store refuses tries it again at the release and the 60 s retry until it lands", () => quiet(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = stampSetup();
  try {
    h.states.set(STAMP, { v: 1, epochs: ['old'], runStartedAt: 1 });
    h.refuse.add(STAMP);
    const c = h.boot();
    assert.deepEqual(h.states.get(STAMP), { v: 1, epochs: ['old'], runStartedAt: 1 }, 'premise: refused, the last stop\'s stamp stays');
    const tries = h.stampTries.count;
    c.runDeferredCancels();
    assert.equal(h.stampTries.count, tries + 1, 'the release tries it (review 2, #105)');
    assert.deepEqual((h.states.get(STAMP) as { epochs: unknown }).epochs, ['old'], 'still refused at the release');
    h.refuse.delete(STAMP);
    mock.timers.tick(60_000);
    assert.deepEqual((h.states.get(STAMP) as { epochs: unknown[] }).epochs, [], 'the retry writes it');
  } finally { h.stopAll(); mock.timers.reset(); }
}));

test("4 (Weft): while the boot's stamp isn't written, a waiting cancel's answer to the subconscious says so", async () => {
  const errors = mock.method(console, 'error', () => {});
  const h = stampSetup();
  try {
    h.hold();
    h.refuse.add(STAMP);
    const c = h.boot();
    h.state.held = true;
    const answer = await c.handleSubconsciousTool('cancel_tuneout', { channelId: 'noisy', serverId: 'editor', text: 'Look.' }, [], SUB) as { data?: { note?: string } };
    assert.match(answer.data?.note ?? '', /This run's start couldn't be recorded in the store yet: if the host stops or dies before the cancel runs while the store still refuses it, you may not be told so when it starts again\.$/);
    h.refuse.delete(STAMP);
    h.state.held = false;
    c.runDeferredCancels();
    h.hold('quiet');
    h.state.held = true;
    const later = await c.handleSubconsciousTool('cancel_tuneout', { channelId: 'quiet', serverId: 'editor', text: 'Look.' }, [], SUB) as { data?: { note?: string } };
    assert.doesNotMatch(later.data?.note ?? '', /couldn't be recorded/, 'once written, not said');
  } finally { h.stopAll(); errors.mock.restore(); }
});

// ---------------------------------------------------------------------------
// 5. One account of a loss.
// ---------------------------------------------------------------------------

test("5a (Weft): a stop whose stamp alone the store refuses, its waiting note's loss kept, gives that notice only, not a stamp's row too", () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.held = true;
    assert.deepEqual(first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB), { ok: true, deferred: true });
    h.refuse.add(STAMP);
    first.stop();
    h.refuse.delete(STAMP);
    assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, 'premise: the loss is kept');
    h.state.held = false;
    h.boot();
    assert.deepEqual(h.told().map((m) => textOf(m.content)), [
      '[Tune-out: the note you left with your cancel of noisy was not delivered to scout. The host stopped while your cancel waited, '
      + 'so your cancel was lost, and the note with it. That tune-out is still in force.]',
    ], 'the kept notice only');
  } finally { h.stopAll(); }
}));

test('5b (Weft): three crashes with nothing asked tell the hold once, and the later boots ask its unread turn again once each', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.boot();
    h.boot();
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)], 'one row');
    assert.deepEqual(h.wakes, [[SUB, 'tune-out stop not recorded: noisy'], [SUB, 'tune-out stop not recorded: noisy'], [SUB, 'tune-out stop not recorded: noisy']],
      'one turn per boot, under the reason the row asked it for');
  } finally { h.stopAll(); }
}));

test('5b (Weft): a later boot that finds more than it told (unknown, then a delivered note) tells it again', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.boot();
    h.rows.push({ participant: SUB, content: [text('Look.')], metadata: { kind: 'subconscious-note', channelId: 'noisy', serverId: 'editor', epochId: e }, sequence: ++h.state.seq });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => (m.metadata?.stopUnrecorded as { found: string }).found), ['unknown', 'delivered']);
  } finally { h.stopAll(); }
}));

// ---------------------------------------------------------------------------
// Pins.
// ---------------------------------------------------------------------------

test('pin: a stop whose loss record alone the store refuses leaves the hold out of its stamp, so the next boot tells it, with a turn', () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    const e = h.hold();
    h.state.held = true;
    first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
    h.refuse.add(LOSS_RECORD);
    first.stop();
    h.refuse.delete(LOSS_RECORD);
    assert.ok(!(h.states.get(STAMP) as { epochs: string[] }).epochs.includes(e), 'the stamp leaves it out');
    h.state.held = false;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)]);
    assert.deepEqual(h.wakes, [[SUB, 'tune-out stop not recorded: noisy']]);
  } finally { h.stopAll(); }
}));

test("pin: a stop whose drop of a waiting cancel throws at its trace has kept the note's loss first (review 3 #43): the store holds it, and the stamp covers the hold", () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    const e = h.hold();
    h.state.held = true;
    first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
    const traces = h.traces as Trace[] & { push: (...t: Trace[]) => number };
    const push = traces.push.bind(traces);
    traces.push = (...t: Trace[]) => { if (t[0]?.type === 'tune-out:deferred-cancel-dropped') throw new Error('the trace failed (test)'); return push(...t); };
    first.stop();
    assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, "the note's loss was kept before the trace threw");
    assert.ok((h.states.get(STAMP) as { epochs: string[] }).epochs.includes(e), 'so the stamp covers the hold: the next boot tells the kept notice, and no second row');
  } finally { h.stopAll(); }
}));

test("pin: a second stop doesn't stamp over the first's", () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    const e = h.hold();
    h.state.held = true;
    first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
    h.refuse.add(LOSS_RECORD);
    first.stop();
    h.refuse.delete(LOSS_RECORD);
    first.stop();
    assert.ok(!(h.states.get(STAMP) as { epochs: string[] }).epochs.includes(e), "the first stop's stamp stands");
  } finally { h.stopAll(); }
}));

test("pin: a note of the epoch delivered in an earlier run isn't read as this run's", () => quiet(() => {
  const h = stampSetup();
  try {
    const e = h.hold();
    h.rows.push({ participant: SUB, content: [text('Look.')], metadata: { kind: 'subconscious-note', epochId: e }, sequence: ++h.state.seq });
    h.rows.push({ participant: 'user', content: [text('release')], metadata: { kind: 'tune-out-cancel', epochId: e }, sequence: ++h.state.seq });
    h.boot();
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)]);
  } finally { h.stopAll(); }
}));

for (const [what, answer] of [['an error', { error: 'refused' }], ['a waiting that names the scope, not true', { waiting: 'all-except' }]] as const) {
  test(`pin: an ask its result answered with ${what} isn't counted as waiting`, () => quiet(() => {
    const h = stampSetup();
    try {
      h.boot();
      const e = h.hold();
      h.ask({ channelId: 'noisy', text: 'Look.' }, answer);
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)]);
    } finally { h.stopAll(); }
  }));
}

test('pin: an ask before the hold began, or before the last run began, is not counted', () => quiet(() => {
  for (const before of ['hold', 'run'] as const) {
    const h = stampSetup();
    try {
      if (before === 'hold') {
        h.boot();
        h.ask({ channelId: 'noisy', text: 'Look.' });
        h.hold();
      } else {
        h.hold();
        h.ask({ channelId: 'noisy', text: 'Look.' });
        h.boot();
      }
      h.boot();
      assert.match(textOf(h.unrecorded()[0]!.content), /If you asked for a cancel of it before the stop/, before);
    } finally { h.stopAll(); }
  }
}));

test("pin: an ask naming another channel, or another server, isn't this hold's; one by its shown name is", () => quiet(() => {
  for (const [input, named] of [
    [{ channelId: 'quiet', text: 'Look.' }, false],
    [{ channelId: 'noisy', serverId: 'other', text: 'Look.' }, false],
    [{ channelId: '#noisy', text: 'Look.' }, true],
  ] as const) {
    const h = stampSetup();
    try {
      h.boot();
      h.hold();
      h.shown.set('editor\0noisy', '#noisy');
      h.ask(input);
      h.boot();
      assert.equal(/you asked for with your note/.test(textOf(h.unrecorded()[0]!.content)), named, JSON.stringify(input));
    } finally { h.stopAll(); }
  }
}));

test("pin: the note's quote is its first line, cut to 120 characters", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold();
    h.ask({ channelId: 'noisy', text: `${'x'.repeat(200)}\nsecond line` });
    h.boot();
    const quoted = /with your note "([^"]*)"/.exec(textOf(h.unrecorded()[0]!.content))?.[1] ?? '';
    assert.equal(quoted, `${'x'.repeat(119)}…`);
  } finally { h.stopAll(); }
}));

test('pin: unansweredIn — a note of the subconscious a cancel delivered is no turn of its; a row in shards is one row', () => {
  const loss: WindowRow = { participant: 'user', content: [text('lost')], metadata: { kind: 'tune-out-note-undelivered' }, sequence: 1 };
  const note: WindowRow = { participant: SUB, content: [text('my note')], metadata: { kind: 'subconscious-note' }, sequence: 2 };
  const keep = (m: WindowRow) => (m.metadata as { kind?: unknown } | undefined)?.kind === 'tune-out-note-undelivered';
  assert.deepEqual(unansweredIn([loss, note], SUB, keep), [loss], 'its delivered note is not its turn');
  const turn: WindowRow = { participant: SUB, content: [text('read it')], sequence: 3 };
  assert.deepEqual(unansweredIn([loss, note, turn], SUB, keep), [], 'a turn of its own after it is');
  const head = { ...loss, shardIndex: 0 };
  const tail = { ...loss, shardIndex: 1, sequence: 4 };
  assert.deepEqual(unansweredIn([head, tail], SUB, keep), [head], 'its first shard only');
});

test("pin: cancelAsksIn reads a result's waiting, server and scope, as a string or as text blocks", () => {
  const use = (id: string): WindowRow => ({ participant: SUB, content: [{ type: 'tool_use', id, name: 'cancel_tuneout', input: { channelId: 'noisy' } } as ContentBlock], sequence: 1 });
  const result = (id: string, content: unknown): WindowRow => ({ participant: 'user', content: [{ type: 'tool_result', toolUseId: id, content } as unknown as ContentBlock], sequence: 2 });
  const asks = cancelAsksIn([
    use('a'), result('a', '{"waiting":true,"serverId":"other"}'),
    use('b'), result('b', [{ type: 'text', text: '{"waiting":true,' }, { type: 'text', text: '"scope":"all-except"}' }]),
    use('c'), result('c', '{"waiting":"all-except"}'),
    use('d'), result('d', 'not json'),
    use('e'),
  ], SUB);
  assert.deepEqual(asks.map((a) => [a.waiting, a.serverId, a.scope]), [
    [true, 'other', undefined], [true, undefined, 'all-except'], [false, undefined, undefined], [false, undefined, undefined], [false, undefined, undefined],
  ]);
});

// ---------------------------------------------------------------------------
// Weft's reading of c55239d5.
// ---------------------------------------------------------------------------

const asked = (hold: string, epochId: string, note: string, it = 'tune-out', end = `That ${it} is still in force.`) =>
  `[Tune-out: the host stopped without recording the state of ${hold} (epoch ${epochId}). The cancel of it you asked for with your note `
  + `"${note}" had not run when the host stopped: it was lost, and the note you left with it. ${end}]`;

test("1 (Weft, c55239d5): a loss told as asked, asked again after with the same note, answered waiting, then a crash, is told again, with a turn", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.boot();
    assert.equal(h.unrecorded().length, 1, 'premise: told once');
    h.wakes.length = 0;
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [asked('the tune-out of noisy', e, 'Look.'), asked('the tune-out of noisy', e, 'Look.')]);
    assert.ok(h.wakes.some(([, why]) => why === 'tune-out stop not recorded: noisy'), 'with a turn');
  } finally { h.stopAll(); }
}));

test("1 (Weft, c55239d5): told that its cancel ran, a later ask with a new note that a crash lost is told, though less definite", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.release(e, 'subconscious', 'by Subconscious');
    h.boot();
    assert.match(textOf(h.unrecorded()[0]!.content), /Your cancel of it ran/);
    h.ask({ channelId: 'noisy', text: 'Again.' });
    h.boot();
    assert.equal(textOf(h.unrecorded().at(-1)!.content), asked('the tune-out of noisy', e, 'Again.'));
  } finally { h.stopAll(); }
}));

test("1 (Weft, c55239d5), control: told asked with one note, then asked with another, gives a second row", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'First.' });
    h.boot();
    h.ask({ channelId: 'noisy', text: 'Second.' });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [asked('the tune-out of noisy', e, 'First.'), asked('the tune-out of noisy', e, 'Second.')]);
  } finally { h.stopAll(); }
}));

test("2 (Weft, c55239d5): an all-except hold whose end time passed while the host was down, released by the boot itself, isn't told as a cancel that ran", () => quiet(() => {
  for (const withAsk of [false, true]) {
    const h = stampSetup();
    try {
      h.boot();
      const s = h.holdScope(undefined, Date.now() + 3_600_000);
      if (withAsk) h.ask({ channelId: 'all-except', scope: 'all-except', text: 'Back.' }, { waiting: true, scope: 'all-except' });
      const scope = h.states.get(SCOPE) as { params: { expiresAtMs: number } };
      scope.params.expiresAtMs = Date.now() - 1;
      h.boot();
      assert.equal(h.states.get(SCOPE), undefined, 'premise: the boot released it');
      const rows = h.unrecorded().map((m) => textOf(m.content));
      const opening = `[Tune-out: the host stopped without recording the state of the all-except hold (all channels except work; epoch ${s}). `;
      assert.deepEqual(rows, [withAsk
        ? `${opening}The cancel of it you asked for with your note "Back." had not run when the host stopped: it was lost, and the note you `
          + 'left with it. That hold has ended since.]'
        : `${opening}If you asked for a cancel of it before the stop, it had not run when the host stopped: it was lost, and any note you `
          + 'left with it. That hold has ended since.]']);
    } finally { h.stopAll(); }
  }
}));

test("2 (Weft, c55239d5): a channel's hold past its wake budget, released by the boot itself, isn't told as a cancel that ran", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.state.registered = true;
    h.state.wakeCount = 6;
    h.boot();
    assert.equal(h.holds.length, 0, "premise: the boot's cancel past the budget ended it");
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e).replace('That tune-out is still in force.', 'That tune-out has ended since.')]);
  } finally { h.stopAll(); }
}));

test("3 (Weft, c55239d5): a note delivered and told in one run, a resident's release in the next, its end unrecorded, a crash: nothing is said of notes", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.note(e);
    h.boot();
    assert.match(textOf(h.unrecorded()[0]!.content), /was delivered to scout before the stop/);
    h.release(e, 'agent-tool', 'agent request');
    h.boot();
    assert.equal(textOf(h.unrecorded().at(-1)!.content),
      `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${e}). A cancel of it that wasn't yours `
      + '(agent request) ran: its release reached scout. Its end was not recorded, so that tune-out is still in force.]');
  } finally { h.stopAll(); }
}));

test("4 (Weft, c55239d5): a resident's cancel that stored the release is credited, and the subconscious's own, asked for, had not run", () => quiet(() => {
  for (const delivered of [false, true]) {
    const h = stampSetup();
    try {
      h.boot();
      const e = h.hold();
      h.ask({ channelId: 'noisy', text: 'Look.' });
      if (delivered) h.note(e);
      h.release(e, 'agent-tool', 'agent request');
      h.boot();
      assert.equal(textOf(h.unrecorded()[0]!.content),
        `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${e}). A cancel of it that wasn't yours `
        + `(agent request) ran: its release reached scout${delivered ? ', with the note you left with your cancel of it' : ''}. Its end was `
        + 'not recorded, so that tune-out is still in force. The cancel of it you asked for had not run when the host stopped: it was lost'
        + `${delivered ? '' : ', and the note you left with it, "Look."'}.]`);
    } finally { h.stopAll(); }
  }
}));

test("5 (Weft, c55239d5): the floor — the first boot's stamp refused, then a stop refusing its stamp and the loss record: nothing is told; control, the boot's stamp landed: told", () => quiet(() => {
  for (const landed of [false, true]) {
    const h = stampSetup();
    try {
      if (!landed) h.refuse.add(STAMP);
      const first = h.boot();
      const e = h.hold();
      h.state.held = true;
      first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
      h.refuse.add(STAMP);
      h.refuse.add(LOSS_RECORD);
      first.stop();
      h.refuse.clear();
      h.state.held = false;
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), landed ? [conditional('the tune-out of noisy', e)] : [], landed ? 'told' : 'nothing durable: the floor');
    } finally { h.stopAll(); }
  }
}));

// --- pins ------------------------------------------------------------------

test('pin: told that its cancel ran, a boot that finds less (nothing in its run) says nothing more', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.release(e, 'subconscious', 'by Subconscious');
    h.boot();
    h.boot();
    assert.equal(h.unrecorded().length, 1);
  } finally { h.stopAll(); }
}));

test('pin: a row told later than the ask with another note does not silence this note', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Second.' });
    h.window.push({ participant: 'user', content: [text('told before')], metadata: { kind: 'tune-out-note-undelivered', epochId: e, stopUnrecorded: { found: 'asked', note: 'First.' } }, sequence: ++h.state.seq });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [asked('the tune-out of noisy', e, 'Second.')]);
  } finally { h.stopAll(); }
}));

test("pin: one hold's told row doesn't silence another hold's", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold('noisy');
    h.boot();
    const b = h.hold('quiet');
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => m.metadata?.epochId).filter((x) => x === b), [b]);
  } finally { h.stopAll(); }
}));

test('pin: a notice of the stop kept to be written, its write refused, counts as told: one row once written', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold();
    h.state.subRefuses = true;
    h.boot();
    const kept = () => (h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length;
    assert.equal(kept(), 1, 'the second boot kept its notice (review 2, #104)');
    const c = h.boot();
    assert.equal(kept(), 1, 'and the third added none: the kept one counts as told');
    h.state.subRefuses = false;
    c.runDeferredCancels();
    assert.equal(h.unrecorded().length, 1);
  } finally { h.stopAll(); }
}));

test("pin: the boot arms the retry of its refused stamp itself", () => quiet(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = stampSetup();
  try {
    h.refuse.add(STAMP);
    h.boot();
    h.refuse.delete(STAMP);
    mock.timers.tick(60_000);
    assert.ok(h.states.has(STAMP));
  } finally { h.stopAll(); mock.timers.reset(); }
}));

test("pin: a release that can't write the boot's stamp arms the retry again", () => quiet(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = stampSetup();
  try {
    h.refuse.add(STAMP);
    const c = h.boot();
    mock.timers.tick(30_000);
    const tries = h.stampTries.count;
    c.runDeferredCancels();
    assert.equal(h.stampTries.count, tries + 1, 'premise: the release tried the stamp (review 2, #105)');
    h.refuse.delete(STAMP);
    mock.timers.tick(30_000);
    assert.ok(!h.states.has(STAMP), "not at the boot's own retry, which the release replaced");
    mock.timers.tick(30_000);
    assert.ok(h.states.has(STAMP), '60 s after the release');
  } finally { h.stopAll(); mock.timers.reset(); }
}));

test("pin: a retry that finds writes held arms itself again for the boot's stamp", () => quiet(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = stampSetup();
  try {
    h.refuse.add(STAMP);
    h.boot();
    h.state.held = true;
    mock.timers.tick(60_000);
    h.state.held = false;
    h.refuse.delete(STAMP);
    mock.timers.tick(60_000);
    assert.ok(h.states.has(STAMP));
  } finally { h.stopAll(); mock.timers.reset(); }
}));

test("pin: a stop's stamp isn't written over by the boot's, still pending, afterwards", () => quiet(() => {
  const h = stampSetup();
  try {
    h.refuse.add(STAMP);
    const c = h.boot();
    const e = h.hold();
    h.refuse.delete(STAMP);
    c.stop();
    c.runDeferredCancels();
    assert.deepEqual((h.states.get(STAMP) as { epochs: string[] }).epochs, [e]);
  } finally { h.stopAll(); }
}));

test("pin: a cancel taken off the queue doesn't clear the retry the boot's refused stamp still needs", () => quiet(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = stampSetup();
  try {
    h.refuse.add(STAMP);
    const c = h.boot();
    h.hold();
    h.state.held = true;
    c.cancel('editor', 'noisy', 'duration', 'duration elapsed');
    h.state.held = false;
    c.cancel('editor', 'noisy', 'agent-tool', 'agent request');
    h.refuse.delete(STAMP);
    mock.timers.tick(60_000);
    assert.ok(h.states.has(STAMP));
  } finally { h.stopAll(); mock.timers.reset(); }
}));

for (const [what, mark] of [
  ['ran, asked, with its note not delivered', (h: ReturnType<typeof stampSetup>, e: string) => { h.ask({ channelId: 'noisy', text: 'Look.' }); h.release(e, 'subconscious', 'by Subconscious'); }],
  ['ran, its note delivered', (h: ReturnType<typeof stampSetup>, e: string) => { h.note(e); h.release(e, 'subconscious', 'by Subconscious'); }],
  ["ran by another's cancel", (h: ReturnType<typeof stampSetup>, e: string) => { h.release(e, 'agent-tool', 'agent request'); }],
] as const) {
  test(`pin: a notice of the stop (${what}) kept in the store, its write refused, is written by the next boot as it was`, () => quiet(() => {
    const h = stampSetup();
    const g = stampSetup();
    try {
      // The text it would have been written with, where nothing refused.
      g.boot();
      const ge = g.hold();
      mark(g, ge);
      g.boot();
      const want = textOf(g.unrecorded()[0]!.content).replace(ge, '<epoch>');
      h.boot();
      const e = h.hold();
      mark(h, e);
      h.state.subRefuses = true;
      h.boot();
      h.state.subRefuses = false;
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => textOf(m.content).replace(e, '<epoch>')), [want]);
    } finally { h.stopAll(); g.stopAll(); }
  }));
}

test('pin: a notice of the stop written after its hold ended says it has ended since, for ran as for unknown', () => quiet(() => {
  for (const ran of [false, true]) {
    const h = stampSetup();
    try {
      h.boot();
      const e = h.hold();
      if (ran) h.release(e, 'subconscious', 'by Subconscious');
      h.state.subRefuses = true;
      const c = h.boot();
      h.holds.length = 0;
      h.state.subRefuses = false;
      c.runDeferredCancels();
      assert.match(textOf(h.unrecorded()[0]!.content), ran ? /Its end was not recorded, and that tune-out has ended since\.\]$/ : /That tune-out has ended since\.\]$/);
    } finally { h.stopAll(); }
  }
}));

test("pin: a stamp that can't be read isn't a first start: the holds are told", () => quiet(() => {
  const h = stampSetup();
  try {
    const e = h.hold();
    h.state.stampUnreadable = true;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)]);
  } finally { h.stopAll(); }
}));

test("pin: the all-except hold's waiting answer says so too while the boot's stamp isn't written", async () => {
  const errors = mock.method(console, 'error', () => {});
  const h = stampSetup();
  try {
    h.holdScope();
    h.refuse.add(STAMP);
    const c = h.boot();
    h.state.held = true;
    const answer = await c.handleSubconsciousTool('cancel_tuneout', { channelId: 'all-except', scope: 'all-except', text: 'Back.' }, [], SUB) as { data?: { note?: string } };
    assert.match(answer.data?.note ?? '', /This run's start couldn't be recorded in the store yet/);
  } finally { h.stopAll(); errors.mock.restore(); }
});

test("pin: a loss notice the stop kept for another reason than its stop doesn't account for the hold", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.states.set(LOSS_RECORD, { v: 1, pendingLossNotices: [{
      id: 'n1', author: SUB, what: 'noisy (by Subconscious)', for: { epochId: e, serverId: 'editor', channelId: 'noisy' },
      drop: { reason: 'note-undelivered', by: 'itself', error: 'refused' }, keptAtMs: 1,
    }] });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)]);
  } finally { h.stopAll(); }
}));

test("pin: a call naming the all-except scope in its input, its result naming none, is that hold's", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.holdScope();
    h.ask({ channelId: 'work', scope: 'all-except', text: 'Back.' }, { waiting: true });
    h.boot();
    assert.match(textOf(h.unrecorded()[0]!.content), /The cancel of it you asked for with your note "Back\."/);
  } finally { h.stopAll(); }
}));

test("pin: the all-except hold excepting a channel doesn't make a bare name of that channel's own hold ambiguous", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const w = h.hold('work');
    h.holdScope();
    h.ask({ channelId: 'work', text: 'Look.' });
    h.boot();
    const byEpoch = new Map(h.unrecorded().map((m) => [m.metadata?.epochId, textOf(m.content)]));
    assert.match(byEpoch.get(w) ?? '', /The cancel of it you asked for with your note "Look\."/);
  } finally { h.stopAll(); }
}));

test("pin: cancelAsksIn reads a guard's placeholder result from the archived original, and a settled row's own answer first", () => {
  const use = (id: string): WindowRow => ({ participant: SUB, content: [{ type: 'tool_use', id, name: 'cancel_tuneout', input: { channelId: 'noisy' } } as ContentBlock], sequence: 1 });
  const result = (id: string, content: unknown): WindowRow => ({ participant: 'user', content: [{ type: 'tool_result', toolUseId: id, content } as unknown as ContentBlock], sequence: 2 });
  const archived = new Map<string, unknown>([
    ['held', '{"waiting":true,"serverId":"other"}'],
    ['settled', '{"waiting":true,"serverId":"archived"}'],
  ]);
  const asks = cancelAsksIn([
    use('held'), result('held', 'Tool result withheld by the guard. The tool has already executed.'),
    use('settled'), result('settled', '{"cancelled":true}'),
  ], SUB, archived);
  assert.deepEqual(asks.map((a) => [a.waiting, a.serverId]), [[true, 'other'], [false, undefined]]);
});

// ---------------------------------------------------------------------------
// Weft's reading of e825ed1c.
// ---------------------------------------------------------------------------

const opening = (e: string) => `[Tune-out: the host stopped without recording the state of the tune-out of noisy (epoch ${e}). `;
const STILL = 'Its end was not recorded, so that tune-out is still in force.';

test("1 (Weft, e825ed1c): a reader fork's cancel that ran, its end unrecorded, is credited to the fork, not to the subconscious, with and without its own waiting ask", () => quiet(() => {
  for (const withAsk of [false, true]) {
    const h = stampSetup();
    try {
      const c = h.boot();
      const e = h.hold();
      if (withAsk) h.ask({ channelId: 'noisy', text: 'Look.' });
      h.state.endFails = true;
      assert.throws(() => c.cancel('editor', 'noisy', 'subconscious', 'by "reader-1"', undefined, 'reader-1'), /could not be recorded/);
      h.state.endFails = false;
      h.boot();
      assert.equal(textOf(h.unrecorded()[0]!.content), `${opening(e)}A cancel of it that wasn't yours (by "reader-1") ran: its release reached scout. ${STILL}`
        + (withAsk ? ' The cancel of it you asked for had not run when the host stopped: it was lost, and the note you left with it, "Look.".]' : ']'));
    } finally { h.stopAll(); }
  }
}));

test("1 (Weft, e825ed1c), control: the subconscious's own cancel, under its name or none, is its own", () => quiet(() => {
  for (const caller of [SUB, undefined]) {
    const h = stampSetup();
    try {
      const c = h.boot();
      const e = h.hold();
      h.state.endFails = true;
      assert.throws(() => c.cancel('editor', 'noisy', 'subconscious', caller ? `by ${caller}` : 'by the reader', undefined, caller));
      h.state.endFails = false;
      h.boot();
      assert.equal(textOf(h.unrecorded()[0]!.content), `${opening(e)}Your cancel of it ran: its release reached scout. ${STILL}]`, String(caller));
    } finally { h.stopAll(); }
  }
}));

test("2 (Weft, e825ed1c): a told row written late, its writes held, counts as told when its boot decided it: an ask between is told again", () => quiet(() => {
  for (const late of [true, false]) {
    const h = stampSetup();
    try {
      h.boot();
      const e = h.hold();
      h.ask({ channelId: 'noisy', text: 'Look.' });
      h.state.held = late;
      const c = h.boot();
      assert.equal(h.unrecorded().length, late ? 0 : 1, late ? 'premise: kept while writes are held, not written yet (review 2, #103)' : 'control: written at once');
      h.ask({ channelId: 'noisy', text: 'Look.' });
      h.state.held = false;
      c.runDeferredCancels();
      assert.equal(h.unrecorded().length, 1, 'premise: told once, written now');
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => m.metadata?.epochId), [e, e], late ? 'the ask after its boot is told again' : 'control');
    } finally { h.stopAll(); }
  }
}));

test("3 (Weft, e825ed1c): a notice a boot keeps while writes are held is kept in the store, so a crash before they land leaves it for the next boot", () => quiet(() => {
  for (const held of [true, false]) {
    const h = stampSetup();
    try {
      h.boot();
      const e = h.hold();
      h.state.held = held;
      h.boot();
      assert.equal(h.unrecorded().length, held ? 0 : 1, held ? 'premise: kept, not written, while writes are held (review 2, #103)' : 'control: written at once');
      if (held) assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, 'and kept in the store');
      h.ask({ channelId: 'noisy', text: 'B.' });
      h.state.held = false;
      h.boot();
      assert.deepEqual(h.unrecorded().map((m) => (m.metadata?.stopUnrecorded as { found: string }).found), ['unknown', 'asked'],
        held ? 'both: the kept one from the store' : 'control: both');
      assert.ok(h.unrecorded().every((m) => m.metadata?.epochId === e));
    } finally { h.stopAll(); }
  }
}));

// --- pins ------------------------------------------------------------------

test('pin: told that its cancel ran, a later release in the next run is told again', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.release(e, 'subconscious', 'by Subconscious');
    h.boot();
    h.release(e, 'agent-tool', 'agent request');
    h.boot();
    assert.equal(h.unrecorded().length, 2);
  } finally { h.stopAll(); }
}));

test('pin: told its note was delivered, a later note in the next run is told again', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.note(e);
    h.boot();
    h.note(e);
    h.boot();
    assert.equal(h.unrecorded().length, 2);
  } finally { h.stopAll(); }
}));

test('pin: a kept notice of the stop with no sequence of its own counts as told now', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.states.set(LOSS_RECORD, { v: 1, pendingLossNotices: [{
      id: 'n1', author: SUB, what: `the tune-out of noisy (epoch ${e})`, for: { epochId: e, serverId: 'editor', channelId: 'noisy' },
      drop: { reason: 'unstamped-stop', found: 'unknown' }, keptAtMs: 1,
    }] });
    h.state.subRefuses = true;
    const c = h.boot();
    h.state.subRefuses = false;
    c.runDeferredCancels();
    assert.equal(h.unrecorded().length, 1);
  } finally { h.stopAll(); }
}));

test('pin: a told row between two asks of one run is older than the newest', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.window.push({ participant: 'user', content: [text('told')], metadata: { kind: 'tune-out-note-undelivered', epochId: e, stopUnrecorded: { found: 'asked', note: 'Look.' } }, sequence: ++h.state.seq });
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.boot();
    assert.equal(h.unrecorded().length, 1, 'told again');
  } finally { h.stopAll(); }
}));

test("pin: the boot's own release of a hold past its wake budget, its end unrecorded, is that run's: the next boot tells it as run", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.state.registered = true;
    h.state.wakeCount = 6;
    h.state.endFails = true;
    h.boot();
    h.state.endFails = false;
    h.state.registered = false;
    assert.equal(h.holds.length, 1, 'premise: its end was not recorded');
    h.boot();
    assert.equal(textOf(h.unrecorded().at(-1)!.content),
      `${opening(e)}A cancel of it that wasn't yours (wake budget exhausted (5)) ran: its release reached scout. ${STILL}]`);
  } finally { h.stopAll(); }
}));

test("pin: a notice of the stop kept through the store and written by a later boot counts as told when it was decided", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.subRefuses = true;
    h.boot();
    h.state.subRefuses = false;
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.boot();
    assert.equal(h.unrecorded().length, 2);
  } finally { h.stopAll(); }
}));

test('pin: a cancel that ran is credited to the latest that ran', () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.release(e, 'agent-tool', 'agent request');
    h.release(e, 'duration', 'duration elapsed');
    h.boot();
    assert.match(textOf(h.unrecorded()[0]!.content), /that wasn't yours \(duration elapsed\) ran/);
  } finally { h.stopAll(); }
}));

test("pin: a release carrying a queued note's loss alone, a channel's or the all-except hold's, records whose cancel made it", () => quiet(() => {
  for (const scope of [false, true]) {
    const h = stampSetup();
    try {
      // On record before the boot, which reads the all-except hold once.
      if (scope) h.holdScope(); else h.hold();
      const c = h.boot();
      h.state.held = true;
      if (scope) c.cancelAllExcept('subconscious', 'by Subconscious', 'Back.', SUB);
      else c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
      h.state.held = false;
      // Its own run stores its release, which isn't made durable: its note
      // waits, as it goes out only once the release is.
      h.state.commitFails = true;
      c.runDeferredCancels();
      h.state.commitFails = false;
      h.state.noteRefuses = true;
      if (scope) c.cancelAllExcept('channel-close', 'the excepted channel was closed');
      else c.cancel('editor', 'noisy', 'agent-tool', 'agent request');
      const loss = h.rows.filter((m) => m.metadata?.kind === 'tune-out-cancel' && m.metadata?.lostNote === true);
      assert.equal(loss.length, 1, 'premise: one release tells the loss');
      assert.equal(loss[0]!.metadata?.released, undefined, 'premise: it covers no row');
      assert.deepEqual(loss[0]!.metadata?.cancel, scope ? { source: 'channel-close', reason: 'the excepted channel was closed' } : { source: 'agent-tool', reason: 'agent request' });
    } finally { h.stopAll(); }
  }
}));

test("pin: a waiting cancel's release records every caller it answered as waiting, a later call that joined it with its note among them (Weft, 0401939e)", () => quiet(() => {
  for (const scope of [false, true]) {
    const h = stampSetup();
    try {
      if (scope) h.holdScope(); else h.hold();
      const c = h.boot();
      h.state.held = true;
      if (scope) {
        c.cancelAllExcept('channel-close', 'the excepted channel was closed');
        c.cancelAllExcept('subconscious', 'by Subconscious', 'Back.', SUB);
      } else {
        c.cancel('editor', 'noisy', 'agent-tool', 'agent request');
        c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
      }
      h.state.held = false;
      c.runDeferredCancels();
      const release = h.rows.find((m) => m.metadata?.kind === 'tune-out-cancel')!;
      assert.deepEqual(release.metadata?.cancel, {
        ...(scope ? { source: 'channel-close', reason: 'the excepted channel was closed' } : { source: 'agent-tool', reason: 'agent request' }),
        by: SUB, askers: [SUB],
      });
    } finally { h.stopAll(); }
  }
}));

// ---------------------------------------------------------------------------
// Weft's reading of 0401939e.
// ---------------------------------------------------------------------------

test("1 (Weft, 0401939e): the subconscious's own ask that joined a reader fork's waiting cancel, which ran, is credited to it, in either order, its note out before the end (review 2 #25)", () => quiet(() => {
  for (const forkFirst of [true, false]) {
    const h = stampSetup();
    try {
      h.hold();
      const c = h.boot();
      const e = h.holds[0]!.epochId;
      h.state.held = true;
      const fork = () => c.cancel('editor', 'noisy', 'subconscious', 'by reader-fork-7', undefined, 'reader-fork-7');
      const own = () => { h.ask({ channelId: 'noisy', text: 'SUB NOTE' }); return c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'SUB NOTE', SUB); };
      if (forkFirst) { fork(); own(); } else { own(); fork(); }
      h.state.held = false;
      h.state.endFails = true;
      c.runDeferredCancels();
      h.state.endFails = false;
      assert.equal(h.holds.length, 1, 'premise: its end was not recorded');
      h.boot();
      assert.equal(textOf(h.unrecorded()[0]!.content), `${opening(e)}The cancel of it you asked for ran (with reader-fork-7's): its release `
        + `reached scout, with the note you left with it. ${STILL}]`, forkFirst ? 'fork first' : 'subconscious first');
    } finally { h.stopAll(); }
  }
}));

test("1 (Weft, 0401939e), control: its ask alone, its cancel run, its note out before the end, its end unrecorded", () => quiet(() => {
  const h = stampSetup();
  try {
    h.hold();
    const c = h.boot();
    const e = h.holds[0]!.epochId;
    h.state.held = true;
    h.ask({ channelId: 'noisy', text: 'SUB NOTE' });
    c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'SUB NOTE', SUB);
    h.state.held = false;
    h.state.endFails = true;
    c.runDeferredCancels();
    h.state.endFails = false;
    h.boot();
    assert.equal(textOf(h.unrecorded()[0]!.content), `${opening(e)}The cancel of it you asked for ran: its release reached scout, with the note `
      + `you left with it. ${STILL}]`);
  } finally { h.stopAll(); }
}));

test("pin: a kept notice silences by when its boot decided it: one kept before a later ask doesn't silence that ask", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.subRefuses = true;
    h.boot();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    const c = h.boot();
    h.state.subRefuses = false;
    c.runDeferredCancels();
    assert.equal(h.unrecorded().length, 2);
  } finally { h.stopAll(); }
}));

// ---------------------------------------------------------------------------
// AF #844 bot review 2 (at caf5a48f): the stamp, the loss record and a
// branch move.
// ---------------------------------------------------------------------------

const askedRow = (epochId: string, note: string) => `[Tune-out: the host stopped without recording the state of the tune-out of noisy `
  + `(epoch ${epochId}). The cancel of it you asked for with your note ${JSON.stringify(note)} had not run when the host stopped: it was `
  + 'lost, and the note you left with it. That tune-out is still in force.]';

test("review 2 #26: a boot that can neither write the notice it reads from the last stop's stamp nor keep it in the store leaves a marker that still reads that run, so a crash then gives the next boot the same row", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    // The host dies with the cancel waiting. The next boot can't write to
    // the subconscious, and the store refuses the loss record.
    h.state.subRefuses = true;
    h.refuse.add(LOSS_RECORD);
    h.boot();
    assert.deepEqual(h.told(), [], 'premise: the notice could not be written');
    assert.equal(h.states.get(LOSS_RECORD), undefined, 'premise: nor kept in the store');
    // It dies too, before either lands.
    h.state.subRefuses = false;
    h.refuse.delete(LOSS_RECORD);
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [askedRow(e, 'Look.')],
      "the third boot still reads the first run's ask: the specific row, not the conditional one");
  } finally { h.stopAll(); }
}));

test("review 2 #26, control: once the boot's notice is written, the marker names this run's start", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    const head = h.state.seq;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [askedRow(e, 'Look.')]);
    assert.equal((h.states.get(STAMP) as { runStartedAt?: number }).runStartedAt, head, "the marker bounds the next boot's reading at this run's start");
  } finally { h.stopAll(); }
}));

test("review 2 #42: a branch move writes this run's marker on the branch moved to, so a crash after a cancel waits there is told, though that branch's stamp covered the hold", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.fork('other');
    h.switchTo('other');
    // An earlier stop on `other` stamped the hold.
    h.states.set(STAMP, { v: 1, epochs: [e], runStartedAt: 1, branch: 'other' });
    h.state.seq += 50;
    h.switchTo('main');
    const c = h.boot();
    h.switchTo('other');
    c.branchMoved();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.held = true;
    assert.deepEqual(c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB), { ok: true, deferred: true });
    // The host dies with the cancel waiting, on `other`.
    h.state.held = false;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [askedRow(e, 'Look.')], "the move's marker covers no hold, so the boot tells it");
  } finally { h.stopAll(); }
}));

test("review 2 #43: after a branch move, the loss record written there keeps the notices that branch kept", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold();
    h.fork('other');
    h.switchTo('other');
    const theirs = {
      id: 'kept-on-other', author: SUB, what: 'the tune-out of quiet (epoch e-q)',
      for: { epochId: 'e-q', serverId: 'editor', channelId: 'quiet' }, drop: { reason: 'stopped' }, keptAtMs: 1,
    };
    h.states.set(LOSS_RECORD, { v: 1, pendingLossNotices: [theirs] });
    h.switchTo('main');
    const c = h.boot();
    h.state.held = true;
    assert.deepEqual(c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB), { ok: true, deferred: true });
    h.switchTo('other');
    c.branchMoved();
    c.stop();
    const kept = (h.states.get(LOSS_RECORD) as { pendingLossNotices: Array<{ id: string }> }).pendingLossNotices;
    assert.equal(kept.length, 2, `the stop's notice and the one the branch kept: ${JSON.stringify(kept)}`);
    assert.ok(kept.some((n) => n.id === 'kept-on-other'), "the branch's own notice is not written over");
  } finally { h.stopAll(); }
}));

test("review 2 #171: after a move to a branch whose head is past this run's start, an earlier run's release there isn't read as this run's", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.fork('other');
    h.switchTo('other');
    // An earlier run on `other` stored a release of the hold there, past
    // where this run starts on `main`.
    h.state.seq += 300;
    h.release(e, 'subconscious', 'by Subconscious');
    h.state.seq += 50;
    h.switchTo('main');
    const c = h.boot();
    h.switchTo('other');
    c.branchMoved();
    h.state.held = true;
    assert.deepEqual(c.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB), { ok: true, deferred: true });
    // A stop whose loss record the store refuses: the stamp leaves the hold out.
    h.refuse.add(LOSS_RECORD);
    c.stop();
    h.refuse.delete(LOSS_RECORD);
    h.state.held = false;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [conditional('the tune-out of noisy', e)],
      "the conditional row: nothing of this run's on `other` says more, and the earlier run's release isn't taken for a cancel that ran");
  } finally { h.stopAll(); }
}));

test("review 2 #171: a stamp that names its run's start on another branch bounds nothing here: each hold it doesn't cover gets the conditional row", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    const start = h.state.seq;
    h.fork('other');
    h.switchTo('other');
    h.state.seq += 300;
    h.release(e, 'subconscious', 'by Subconscious');
    h.ask({ channelId: 'noisy', text: 'Look.' });
    // The stamp `main`'s run left, which `other` inherited: its start is a place on `main`.
    h.states.set(STAMP, { v: 1, epochs: [], runStartedAt: start, branch: 'main' });
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [unreadRow(e)],
      "neither the release nor the ask is read as that run's, and whether a cancel ran isn't told as known (review 3, #9)");
  } finally { h.stopAll(); }
}));

test("review 2 #42, control: a move back to the branch this run began on keeps that start, so a crash after reads what this run asked there", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    const c = h.boot();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.fork('other');
    h.switchTo('other');
    c.branchMoved();
    h.switchTo('main');
    c.branchMoved();
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => (m.metadata?.stopUnrecorded as { found: string }).found), ['unknown', 'asked'],
      "the ask made on `main` before the moves is this run's: the specific row");
    assert.equal(h.unrecorded().at(-1)!.metadata?.epochId, e);
  } finally { h.stopAll(); }
}));

// ---------------------------------------------------------------------------
// AF #844 bot review 3 (at 22dc7d48).
// ---------------------------------------------------------------------------

test("review 3 R2: a stop from a listener of a loss notice's write keeps its stamp: the run's marker isn't written over it", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    // The host dies with the cancel waiting. The next boot can neither
    // write the notice nor keep it in the store: it carries the last stop's
    // bound (review 2, #26).
    h.state.subRefuses = true;
    h.refuse.add(LOSS_RECORD);
    const c = h.boot();
    h.state.subRefuses = false;
    h.refuse.delete(LOSS_RECORD);
    let stopped = false;
    h.listenWrites((row) => {
      if (row.metadata?.kind !== 'tune-out-note-undelivered' || stopped) return;
      stopped = true;
      c.stop();
    });
    c.runDeferredCancels();
    assert.ok(stopped, "premise: the notice's write stopped the host");
    assert.deepEqual((h.states.get(STAMP) as { epochs: string[] }).epochs, [e], "the stop's stamp stands, covering the hold it accounted for");
  } finally { h.stopAll(); }
}));

test("review 3 #13: a branch move back to the stamp's own branch, while the boot's notice is neither written nor kept, leaves the marker reading the last run", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.subRefuses = true;
    h.refuse.add(LOSS_RECORD);
    const c = h.boot();
    assert.deepEqual(h.told(), [], 'premise: the notice could not be written, nor kept in the store');
    // A failed surgery's restore: the store moves back to the branch it was on.
    c.branchMoved();
    // The host dies before either lands.
    h.state.subRefuses = false;
    h.refuse.delete(LOSS_RECORD);
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [askedRow(e, 'Look.')], "the next boot still reads the first run's ask");
  } finally { h.stopAll(); }
}));

test("review 3 #66: a boot whose telling of the last stop's stamp throws partway leaves the marker reading the last run, so the next boot tells the holds it didn't reach", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.shownFails = true;
    h.boot();
    assert.deepEqual(h.told(), [], "premise: the telling threw before it told the hold");
    h.state.shownFails = false;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [askedRow(e, 'Look.')], "the next boot reads the first run's ask, not this run's rows alone");
  } finally { h.stopAll(); }
}));

// --- review 3: the boot's reading and the store's durability -------------

const unreadRow = (epochId: string, note?: string) => `[Tune-out: the host stopped without recording the state of the tune-out of noisy `
  + `(epoch ${epochId}). `
  + (note !== undefined
    ? `The cancel of it you asked for with your note ${JSON.stringify(note)} was answered as waiting; whether it ran before the host stopped isn't known here, `
      + "as what that run stored can't be read here: its end was not recorded, and the note you left with it may be lost."
    : "If you asked for a cancel of it before the stop, whether it ran isn't known here, as what that run stored can't be read here: "
      + 'its end was not recorded, and any note you left with it may be lost.')
  + ' That tune-out is still in force.]';

test("review 3 #9: where the boot can't read that run's rows, an ask is told as not known to have run, not as lost; a later boot that reads them says more", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.release(e, 'subconscious', 'by Subconscious', SUB);
    // The boot's first read of the rows (the held tally) works; its telling's read throws. Its marker is refused.
    h.state.rowsFailFrom = h.state.rowReads + 2;
    h.refuse.add(STAMP);
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [unreadRow(e, 'Look.')], 'not told as lost: a release may be stored');
    h.state.rowsFailFrom = Infinity;
    h.refuse.delete(STAMP);
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => (m.metadata?.stopUnrecorded as { found: string }).found), ['asked', 'ran'],
      'a boot that can read them tells what they show');
  } finally { h.stopAll(); }
}));

test("review 3 #107: a boot that kept its notice in the store and died before its marker, the release the last row it read, gives one row, not two", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.release(e, 'subconscious', 'by Subconscious', SUB);
    // The boot can't write its notice to the subconscious, keeps it in the store, and its marker is refused: it dies.
    h.state.subRefuses = true;
    h.refuse.add(STAMP);
    h.boot();
    assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, 'premise: kept in the store');
    h.state.subRefuses = false;
    h.refuse.delete(STAMP);
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => (m.metadata?.stopUnrecorded as { found: string }).found), ['ran'],
      'the kept one, written now, tells what the release says; the same release, at the head that boot read, tells nothing more');
  } finally { h.stopAll(); }
}));

test("review 3 #8: the kept notice a quiesced boot writes, not in the subconscious's window, still counts as told: one row", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    h.hold();
    h.state.subRefuses = true;
    h.refuse.add(STAMP);
    h.boot();
    assert.equal(h.subRows.length, 0, 'premise: the notice was kept in the store, not written');
    h.state.subRefuses = false;
    h.state.frozen = true;
    h.boot();
    assert.equal(h.subRows.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered').length, 1, 'one notice row, the kept one, though its window holds none');
  } finally { h.stopAll(); }
}));

test("review 3 #64: a notice written whose record the store then refuses isn't written again by the next boot", () => quiet(() => {
  for (const frozen of [false, true]) {
    const h = stampSetup();
    try {
      const first = h.boot();
      h.hold();
      h.state.held = true;
      first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
      first.stop();
      assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, 'premise: the stop kept the loss');
      h.state.held = false;
      // The next boot writes the notice, and the store refuses the record that would drop it: it dies so.
      h.refuse.add(LOSS_RECORD);
      h.state.frozen = frozen;
      h.boot();
      h.refuse.delete(LOSS_RECORD);
      assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, 'premise: the record still keeps it');
      h.boot();
      assert.equal(h.subRows.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered').length, 1,
        `${frozen ? 'its window frozen' : 'shown'}: the notice is written once, its row found`);
      assert.deepEqual((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices, [], 'and it leaves the record');
    } finally { h.stopAll(); }
  }
}));

test("review 3 #65: a boot that wrote a stop's kept notice and died before its marker leaves the next boot nothing more to tell of that hold", () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.state.held = true;
    first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
    // The stop keeps the loss in the store, and its stamp is refused (5a).
    h.refuse.add(STAMP);
    first.stop();
    h.state.held = false;
    // The next boot writes the kept notice, clears the record, and dies before its marker.
    h.boot();
    assert.equal(h.told().length, 1, 'premise: the kept notice is written');
    h.refuse.delete(STAMP);
    h.boot();
    assert.deepEqual(h.unrecorded(), [], "the stop's notice, in the window, accounts for the hold: no stamp's row as well");
  } finally { h.stopAll(); }
}));

test("review 3 #80: the loss record and the stop's stamp are each made durable as they are written, the record before the stamp", () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    assert.deepEqual(h.log.slice(-2), [`write:${STAMP}`, 'sync'], "the boot's marker is synced");
    h.hold();
    h.state.held = true;
    first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
    h.log.length = 0;
    first.stop();
    assert.deepEqual(h.log, [`write:${LOSS_RECORD}`, 'sync', `write:${STAMP}`, 'sync'], 'the record is durable before the stamp that counts on it, and the stamp after');
  } finally { h.stopAll(); }
}));

test("review 3 #80: a stop whose record can't be made durable leaves its hold out of the stamp, as a refused record does", () => quiet(() => {
  const h = stampSetup();
  try {
    const first = h.boot();
    const e = h.hold();
    h.state.held = true;
    first.cancel('editor', 'noisy', 'subconscious', 'by Subconscious', 'Look.', SUB);
    h.state.commitFails = true;
    first.stop();
    assert.ok(!(h.states.get(STAMP) as { epochs: string[] }).epochs.includes(e), 'the stamp leaves it out, so a crash before the record lands is told');
  } finally { h.stopAll(); }
}));

// ---------------------------------------------------------------------------
// AF #844 bot review 4 (at 0f7e2711).
// ---------------------------------------------------------------------------

test("review 4 #13: a branch move to a branch whose loss record lacks the boot's kept notice writes the record there before the marker, so a crash after gives the next boot that notice", () => quiet(() => {
  const h = stampSetup();
  try {
    h.boot();
    const e = h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    // A branch made before the next boot keeps its notice: no loss record there.
    h.fork('other');
    // The host dies with the cancel waiting. The next boot can't write its notice to the subconscious, and keeps it in the store.
    h.state.subRefuses = true;
    const c = h.boot();
    assert.deepEqual(h.told(), [], 'premise: the notice could not be written');
    assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, "premise: kept in this branch's record");
    h.switchTo('other');
    h.log.length = 0;
    c.branchMoved();
    const record = h.log.indexOf(`write:${LOSS_RECORD}`);
    assert.ok(record >= 0 && record < h.log.indexOf(`write:${STAMP}`), `the record is written there before the marker: ${h.log.join(', ')}`);
    // The host dies before anything else is written there.
    h.state.subRefuses = false;
    h.boot();
    assert.deepEqual(h.unrecorded().map((m) => textOf(m.content)), [askedRow(e, 'Look.')], 'the next boot writes the kept notice, once');
  } finally { h.stopAll(); }
}));

test("review 4 #13: a bound still carried where the record left holds the notice is judged by the destination's record: refused there, the marker keeps it", () => quiet(() => {
  const h = stampSetup();
  try {
    const start = h.state.seq;
    h.boot();
    h.hold();
    h.ask({ channelId: 'noisy', text: 'Look.' });
    h.fork('other');
    h.state.subRefuses = true;
    h.refuse.add(LOSS_RECORD);
    const c = h.boot();
    assert.deepEqual(h.told(), [], 'premise: the notice could not be written, nor kept in the store');
    h.refuse.delete(LOSS_RECORD);
    // The record is written on this branch by a write that leaves the bound for the next check (a loss told meanwhile, say).
    assert.equal((c as unknown as { writeLossRecord(): boolean }).writeLossRecord(), true);
    assert.equal((h.states.get(LOSS_RECORD) as { pendingLossNotices: unknown[] }).pendingLossNotices.length, 1, "premise: kept in this branch's record now");
    const carried = () => (c as unknown as { carriedBound?: unknown }).carriedBound;
    assert.ok(carried(), 'premise: the bound is still carried');
    // The move: the destination refuses the record.
    h.switchTo('other');
    h.refuse.add(LOSS_RECORD);
    c.branchMoved();
    assert.ok(carried(), 'the notice is in no record there, so the bound stays');
    assert.equal((h.states.get(STAMP) as { runStartedAt?: number }).runStartedAt, start, 'and the marker there reads the last run, from where it began');
  } finally { h.stopAll(); }
}));
