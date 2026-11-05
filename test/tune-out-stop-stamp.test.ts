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
  const state = { held: false, seq: 100, endFails: false };
  const key = (s: string, c: string) => `${s}\0${c}`;
  const registry = {
    tuneOutsOnRecord: () => holds.map((h) => ({ serverId: h.serverId, channelId: h.channelId, params: { epochId: h.epochId, startedAtSequence: h.startedAt }, source: 'agent-tool' })),
    getTuneOutState: (s: string, c: string) => {
      const h = holds.find((x) => x.serverId === s && x.channelId === c);
      return h ? { params: { epochId: h.epochId, startedAtSequence: h.startedAt, cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5 }, wakeCount: 0 } : null;
    },
    cancelTuneOut: (s: string, c: string) => {
      if (state.endFails) throw new Error('the end could not be recorded (test)');
      const at = holds.findIndex((x) => x.serverId === s && x.channelId === c);
      return at >= 0 ? holds.splice(at, 1)[0] : null;
    },
    readCoordinatorState: (id: string) => states.get(id) ?? null,
    writeCoordinatorState: (id: string, value: unknown) => {
      if (refuse.has(id)) throw new Error(`the store refused ${id} (test)`);
      if (value === null) states.delete(id); else states.set(id, structuredClone(value));
    },
    nameShown: (c: { serverId: string; channelId: string }) => shown.get(key(c.serverId, c.channelId)) ?? c.channelId,
    quotedShown: (c: { channelId: string }) => JSON.stringify(c.channelId),
    listChannelsRaw: () => [],
  };
  const hooks = {
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>, forAgent?: string) => {
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
  const holdScope = (epochId = `scope-${state.seq}`): string => {
    states.set(SCOPE, { params: {
      epochId, except: { serverId: 'editor', channelId: 'work' }, cadenceSeconds: 3600, backlogCap: 10, maxWakes: 5,
      startedAtSequence: ++state.seq, startedAtMs: Date.now(), expiresAtMs: Date.now() + 3_600_000, source: 'agent-tool',
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
  /** The rows told of an unrecorded stop, in the subconscious's window. */
  const unrecorded = () => window.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered' && textOf(m.content).includes('without recording'));
  const told = () => window.filter((m) => m.metadata?.kind === 'tune-out-note-undelivered');
  const stopAll = (): void => { for (const c of made) c.stop(); };
  return { states, refuse, holds, shown, rows, window, added, wakes, traces, state, make, hold, holdScope, boot, ask, unrecorded, told, stopAll };
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
      h.rows.push({ participant: 'user', content: [text('[Tune-out: noisy cancelled — by Subconscious, 0 wakes]')], metadata: { system: true, kind: 'tune-out-cancel', channelId: 'noisy', epochId: e }, sequence: ++h.state.seq });
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
    assert.match(answer.data?.note ?? '', /This run's start couldn't be recorded in the store yet, so if the host dies before the cancel runs, you may not be told so when it starts again\.$/);
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
