/**
 * A tune-out's timers hold any length the resident asks for, and enter()
 * refuses an option it can't use before anything changes (F76).
 *
 * Node fires a setTimeout longer than 2^31 - 1 ms (about 24.8 days) almost
 * at once, so a single timer ended a longer tune-out as soon as it began,
 * and re-armed a longer cadence every millisecond. node:test's mock timers
 * fire an overflowing timeout early too (Node 24), and the harness records
 * each delay asked of setTimeout, so the timer tests also check that no step
 * is longer than one timer holds, whatever the runtime's mock does.
 *
 * The mock runs a tick's due timers with the clock already at the tick's
 * end, so tests that follow a timer step by step tick to each step's end.
 */
import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import { armAt } from '../src/deadline-timer.js';
import type { ChannelRegistry, TuneOutParams } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

/** The longest delay one setTimeout holds. */
const ONE_TIMER_MS = 2_147_483_647;
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 17);
const STORED: TuneOutParams = { epochId: 'e1', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 1 };

/**
 * A coordinator over an in-memory registry for one channel, `disc` `#a`, with
 * setTimeout mocked and each delay asked of it recorded, and the wall clock
 * mocked unless `wallClock` is false. `stored` is a tune-out the registry
 * already holds, as after a restart.
 */
function harness(t: TestContext, stored?: TuneOutParams, { wallClock = true } = {}) {
  if (wallClock) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  else t.mock.timers.enable({ apis: ['setTimeout'] });
  const mocked = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0);
    return mocked(fn, ms, ...rest);
  }) as unknown as typeof setTimeout;

  let state: { params: TuneOutParams; wakeCount: number } | null = stored ? { params: stored, wakeCount: 0 } : null;
  const entered: TuneOutParams[] = [];
  /** The source of each cancel that ended a tune-out: 'duration' for an end time. */
  const cancels: string[] = [];
  /** The reason of each inference requested, the subconscious's turns among them. */
  const inferences: string[] = [];
  const registry = {
    listChannelsRaw: () => (state ? [{ serverId: 'disc', descriptor: { id: '#a' } }] : []),
    getTuneOutState: () => state,
    enterTuneOut: (_s: string, _c: string, params: TuneOutParams) => {
      entered.push(params);
      state = { params, wakeCount: 0 };
    },
    cancelTuneOut: (_s: string, _c: string, _next: string, source: string) => {
      const ended = state;
      state = null;
      if (ended) cancels.push(source);
      return ended;
    },
    recordTuneOutWake: () => (state ? { params: state.params, wakeCount: ++state.wakeCount } : null),
  } as unknown as ChannelRegistry;
  const hooks = {
    addMessage: () => '',
    requestInference: (_agent: string, reason: string) => { inferences.push(reason); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    currentSequence: () => 1,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: () => {},
  } as unknown as TuneOutFrameworkHooks;
  const coordinator = new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
  t.after(() => {
    coordinator.stop();
    globalThis.setTimeout = mocked;
    t.mock.timers.reset();
  });
  const cadenceTurns = () => inferences.filter((r) => r.startsWith('tune-out cadence'));
  const wakeTurns = () => inferences.filter((r) => r.startsWith('tune-out wake'));
  const noTimerPastOne = () => assert.ok(
    delays.every((ms) => ms <= ONE_TIMER_MS),
    `no timer longer than one holds (${delays.filter((ms) => !(ms <= ONE_TIMER_MS)).join(', ')})`,
  );
  /** End the tune-out in the registry alone, as a send into the channel or a close does. */
  const endInRegistry = () => { state = null; };
  const active = () => state !== null;
  return { coordinator, entered, cancels, cadenceTurns, wakeTurns, delays, noTimerPastOne, endInRegistry, active };
}

it('a duration past one timer ends at its end time and not before', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.deepEqual(h.cancels, [], "still tuned out after one timer's worth");
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS - 1);
  assert.deepEqual(h.cancels, [], 'still tuned out 1 ms before its end');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancels, ['duration'], 'ended once, at its end time');
  h.noTimerPastOne();
});

it('a restart with more than one timer left ends the tune-out at its stored end time and not before', (t) => {
  const h = harness(t, { ...STORED, expiresAtMs: NOW + 30 * DAY_MS });
  h.coordinator.resumeActiveEpochs();
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.deepEqual(h.cancels, [], "still tuned out after one timer's worth");
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS - 1);
  assert.deepEqual(h.cancels, [], 'still tuned out 1 ms before its stored end');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancels, ['duration'], 'ended once, at its stored end time');
  h.noTimerPastOne();
});

it('after a restart, each step reads the stored end time again', (t) => {
  const h = harness(t, { ...STORED, expiresAtMs: NOW + 30 * DAY_MS });
  h.coordinator.resumeActiveEpochs();
  t.mock.timers.tick(DAY_MS);
  assert.deepEqual(h.cancels, [], 'still tuned out a day after the restart');
  // The wall clock reaches the stored end while a step waits, as after a
  // host's suspend or a clock correction: when that step runs, it reads the
  // stored end time again and ends the tune-out.
  t.mock.timers.setTime(NOW + 30 * DAY_MS);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.deepEqual(h.cancels, ['duration'], 'the next step found the stored end time passed and ended it');
  h.noTimerPastOne();
});

it("after a cancel, a new tune-out on the channel isn't ended at the old one's end time", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.equal(h.coordinator.cancel('disc', '#a', 'agent-tool', 'agent request').ok, true);
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true, 'a new tune-out, until cancelled');
  t.mock.timers.tick(30 * DAY_MS);
  assert.deepEqual(h.cancels, ['agent-tool'], 'only the cancel asked for: the new tune-out runs on');
  h.noTimerPastOne();
});

it("a tune-out that ends in the registry, as a send or a close ends it, leaves none of its timers to act on the channel's next one", (t) => {
  const h = harness(t);
  // A two-day end time (short enough for one timer, so main's single timer
  // shows the same case), the default 1800 s cadence, and a wake coalescing
  // for 2 s.
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 2 * 86_400 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  h.endInRegistry();
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 3600 }, 'agent-tool').ok, true, 'a new tune-out, until cancelled');
  h.coordinator.onIncoming('disc', '#a', 'm2', undefined);
  t.mock.timers.tick(2_000);
  assert.deepEqual(h.wakeTurns(), [], "the old wake didn't count against the new tune-out");
  t.mock.timers.tick(1_800_000 - 2_000);
  assert.deepEqual(h.cadenceTurns(), [], 'the old cadence gave the new tune-out no turn');
  t.mock.timers.tick(1_800_000);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'the new cadence gave its turn at 3600 s');
  t.mock.timers.tick(2 * DAY_MS);
  assert.deepEqual(h.cancels, [], "the old end time didn't end the new tune-out");
  assert.equal(h.active(), true);
  h.noTimerPastOne();
});

it("stop clears both timers' pending steps: neither fires after it", (t) => {
  const h = harness(t);
  const opts = { durationSeconds: 30 * 86_400, cadenceSeconds: 30 * 86_400 };
  assert.equal(h.coordinator.enter('disc', '#a', opts, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.equal(
    h.delays.filter((ms) => ms === 30 * DAY_MS - ONE_TIMER_MS).length,
    2,
    "both timers' second steps are armed when stop runs",
  );
  h.coordinator.stop();
  t.mock.timers.tick(60 * DAY_MS);
  assert.deepEqual(h.cancels, [], 'no end after stop');
  assert.deepEqual(h.cadenceTurns(), [], 'no cadence turn after stop');
  h.noTimerPastOne();
});

it('a cadence past one timer gives the subconscious a turn each period: none before the first, none after a cancel', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(ONE_TIMER_MS);
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS - 1);
  assert.deepEqual(h.cadenceTurns(), [], 'no turn before the cadence');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'one turn at the cadence');
  h.coordinator.onIncoming('disc', '#a', 'm2', undefined);
  t.mock.timers.tick(ONE_TIMER_MS);
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS);
  assert.equal(h.cadenceTurns().length, 2, 'a second turn a period later');
  h.coordinator.onIncoming('disc', '#a', 'm3', undefined);
  assert.equal(h.coordinator.cancel('disc', '#a', 'agent-tool', 'agent request').ok, true);
  t.mock.timers.tick(ONE_TIMER_MS);
  t.mock.timers.tick(30 * DAY_MS);
  assert.equal(h.cadenceTurns().length, 2, 'no turn after the cancel');
  h.noTimerPastOne();
});

it("the cadence counts its period on its timers, so the wall clock doesn't move its turn", (t) => {
  // Only setTimeout is mocked: the real wall clock moves a few milliseconds
  // while the mocked timers run 30 minutes, so a cadence that read the wall
  // clock wouldn't come due.
  const h = harness(t, undefined, { wallClock: false });
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(1_800_000);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'the turn came after the default 1800 s on the timers');
  h.noTimerPastOne();
});

it('a restart re-arms a stored cadence past one timer: the turn comes at the cadence', (t) => {
  const h = harness(t, { ...STORED, cadenceSeconds: 30 * 86_400 });
  h.coordinator.resumeActiveEpochs();
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.deepEqual(h.cadenceTurns(), [], "no turn after one timer's worth");
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'one turn at the cadence');
  h.noTimerPastOne();
});

it("enter refuses an option that gives no finite number, before anything changes", (t) => {
  const h = harness(t);
  const refusals: Array<[Record<string, unknown>, RegExp | string]> = [
    [{ durationSeconds: 'abc' },
      'Nothing was tuned out: durationSeconds must be a finite number of seconds, and it was the string "abc". '
        + 'Leave it out to stay tuned out until you cancel.'],
    [{ maxWakes: NaN },
      'Nothing was tuned out: maxWakes must be a finite number, and it was NaN. Leave it out for the default, 5.'],
    [{ durationSeconds: 1e306 },
      'Nothing was tuned out: durationSeconds 1e+306 is longer than an end time can be kept. '
        + 'Leave it out to stay tuned out until you cancel.'],
    [{ durationSeconds: Infinity }, /^Nothing was tuned out: durationSeconds must be a finite number of seconds, and it was Infinity\. /],
    [{ cadenceSeconds: 'every hour' }, /^Nothing was tuned out: cadenceSeconds must be a finite number of seconds, and it was the string "every hour"\. Leave it out for the default, 1800\.$/],
    [{ cadenceSeconds: Infinity }, /^Nothing was tuned out: cadenceSeconds must be a finite number of seconds, and it was Infinity\. /],
    [{ backlogCap: 'all' }, /^Nothing was tuned out: backlogCap must be a finite number, and it was the string "all"\. Leave it out for the default, 200\.$/],
    [{ maxWakes: [1, 2] }, /^Nothing was tuned out: maxWakes must be a finite number, and it was the value \[1,2\]\. /],
  ];
  for (const [opts, expected] of refusals) {
    const r = h.coordinator.enter('disc', '#a', opts as never, 'agent-tool');
    assert.equal(r.ok, false, `${JSON.stringify(opts)} refused`);
    if (!r.ok) {
      if (typeof expected === 'string') assert.equal(r.error, expected);
      else assert.match(r.error, expected);
    }
  }
  assert.deepEqual(h.entered, [], 'nothing entered');
  assert.deepEqual(h.delays, [], 'no timer armed');
});

it('a null option counts as left out: a null duration has no end time', (t) => {
  const h = harness(t);
  const nulls = { durationSeconds: null, cadenceSeconds: null, backlogCap: null, maxWakes: null };
  assert.equal(h.coordinator.enter('disc', '#a', nulls as never, 'agent-tool').ok, true);
  assert.equal(h.entered[0].expiresAtMs, undefined, 'until cancelled, not 60 s');
  assert.deepEqual(
    [h.entered[0].cadenceSeconds, h.entered[0].backlogCap, h.entered[0].maxWakes],
    [1800, 200, 5],
    'the defaults',
  );
});

it('a numeric string is read as its number, as it was before the refusals', (t) => {
  const h = harness(t);
  const strings = { durationSeconds: '3600', cadenceSeconds: '600', backlogCap: '50', maxWakes: '3' };
  assert.equal(h.coordinator.enter('disc', '#a', strings as never, 'agent-tool').ok, true);
  assert.deepEqual(
    [h.entered[0].expiresAtMs, h.entered[0].cadenceSeconds, h.entered[0].backlogCap, h.entered[0].maxWakes],
    [NOW + 3_600_000, 600, 50, 3],
  );
});

it('an option below its floor is raised to it, as before', (t) => {
  const h = harness(t);
  const below = { durationSeconds: 5, cadenceSeconds: 1, backlogCap: -3, maxWakes: 0 };
  assert.equal(h.coordinator.enter('disc', '#a', below, 'agent-tool').ok, true);
  assert.deepEqual(
    [h.entered[0].expiresAtMs, h.entered[0].cadenceSeconds, h.entered[0].backlogCap, h.entered[0].maxWakes],
    [NOW + 60_000, 30, 0, 1],
  );
});

it('armAt arms a deadline that has passed for the next turn of the loop, with no negative-delay warning', async () => {
  // Real timers: Node 23 and later warn about a negative delay.
  const warnings: string[] = [];
  const onWarning = (w: Error) => { warnings.push(w.name); };
  process.on('warning', onWarning);
  try {
    await new Promise<void>((resolve) => { armAt(Date.now() - 5, () => {}, resolve); });
    assert.deepEqual(warnings.filter((name) => name === 'TimeoutNegativeWarning'), []);
  } finally {
    process.off('warning', onWarning);
  }
});
