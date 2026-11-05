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
 * 5. One account of a lost note, not two; one row per hold across crashes.
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
  const state = {
    held: false, seq: 100, endFails: false,
    /** The subconscious's context refuses writes. */
    subRefuses: false,
    /** The stamp can't be read. */
    stampUnreadable: false,
    /** The holds' channels are registered, as a boot after #900 may find them, with this wake count. */
    registered: false, wakeCount: 0,
  };
  const key = (s: string, c: string) => `${s}\0${c}`;
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
      if (refuse.has(id)) throw new Error(`the store refused ${id} (test)`);
      if (value === null) states.delete(id); else states.set(id, structuredClone(value));
    },
    nameShown: (c: { serverId: string; channelId: string }) => shown.get(key(c.serverId, c.channelId)) ?? c.channelId,
    quotedShown: (c: { channelId: string }) => JSON.stringify(c.channelId),
    listChannelsRaw: () => (state.registered ? holds.map((x) => ({ serverId: x.serverId, descriptor: { id: x.channelId } })) : []),
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
      if (forAgent === SUB && state.subRefuses) throw new Error("the subconscious's context refused the write (test)");
      const row: Row = { participant, content, ...(metadata ? { metadata } : {}), sequence: ++state.seq, ...(forAgent ? { forAgent } : {}) };
      added.push(row);
      if (forAgent === SUB) window.push(row); else rows.push(row);
      return `m${state.seq}`;
    },
    requestInference: (agentName: string, reason: string) => { wakes.push([agentName, reason]); },
    subconsciousName: () => SUB,
    primaryName: () => 'scout',
    getStoredMessages: () => rows,
    getSurgeryHeldMessages: () => [],
    unseenBySubconscious: () => 0,
    subconsciousWindow: () => window,
    emitTrace: (event: Trace) => { traces.push(event); },
    writesHeld: () => state.held,
    commitDeliveries: () => true,
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    currentSequence: () => state.seq,
    setSubconsciousAnchor: () => {},
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
  const release = (epochId: string, source: string, reason: string): void => {
    rows.push({ participant: 'user', content: [text(`[Tune-out: cancelled — ${reason}]`)], metadata: { system: true, kind: 'tune-out-cancel', epochId, cancel: { source, reason } }, sequence: ++state.seq });
  };
  /** The subconscious's note of `epochId`, delivered to the resident. */
  const note = (epochId: string): void => {
    rows.push({ participant: SUB, content: [text('Look.')], metadata: { kind: 'subconscious-note', epochId }, sequence: ++state.seq });
  };
  /** The rows told of an unrecorded stop, in the subconscious's window. */
  const unrecorded = () => window.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered' && textOf(m.content).includes('without recording'));
  const told = () => window.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered');
  const stopAll = (): void => { for (const c of made) c.stop(); };
  return { states, refuse, holds, shown, rows, window, added, wakes, traces, state, make, hold, holdScope, boot, ask, release, note, unrecorded, told, stopAll };
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
    c.runDeferredCancels();
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

test("pin: a stop that can't keep a waiting note's loss (its drop throws) leaves the hold out of its stamp", () => quiet(() => {
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
    assert.ok(!(h.states.get(STAMP) as { epochs: string[] }).epochs.includes(e));
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
    const c = h.boot();
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
    c.runDeferredCancels();
    h.refuse.delete(STAMP);
    mock.timers.tick(60_000);
    assert.ok(h.states.has(STAMP));
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
