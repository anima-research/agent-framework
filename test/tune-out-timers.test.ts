/**
 * A tune-out's timers hold any length the resident asks for, enter()
 * refuses an option it can't use before anything changes, and a timer whose
 * work throws reports it rather than throwing it into the event loop.
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
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';

/** The longest delay one setTimeout holds. */
const ONE_TIMER_MS = 2_147_483_647;
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 17);
const STORED: TuneOutParams = { epochId: 'e1', cadenceSeconds: 1800, backlogCap: 200, maxWakes: 5, startedAtSequence: 1 };

/**
 * A coordinator over an in-memory registry for one channel, `disc` `#a`, with
 * setTimeout mocked and each delay asked of it recorded, and the wall clock
 * mocked unless `wallClock` is false. `stored` is a tune-out the registry
 * already holds, as after a restart. `servers` is the MCPL server registry,
 * by default one with no servers.
 */
function harness(
  t: TestContext,
  stored?: TuneOutParams,
  { wallClock = true, servers = { getServer: () => undefined } as unknown as McplServerRegistry } = {},
) {
  if (wallClock) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  else t.mock.timers.enable({ apis: ['setTimeout'] });
  const mocked = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0);
    return mocked(fn, ms, ...rest);
  }) as unknown as typeof setTimeout;

  let state: { params: TuneOutParams; wakeCount: number } | null = stored ? { params: stored, wakeCount: 0 } : null;
  /** What each step throws on its next call, as a failed store write would. */
  const throwsNext = new Map<'addMessage' | 'recordTuneOutWake' | 'cancelTuneOut' | 'requestInference', unknown>();
  const throwIfSet = (step: 'addMessage' | 'recordTuneOutWake' | 'cancelTuneOut' | 'requestInference') => {
    if (!throwsNext.has(step)) return;
    const thrown = throwsNext.get(step);
    throwsNext.delete(step);
    throw thrown;
  };
  const traces: Array<Record<string, unknown>> = [];
  /** The text of each message added: the subconscious's notices among them. */
  const notices: string[] = [];
  /** What the coordinator writes to stderr. */
  const stderr = t.mock.method(console, 'error', () => {});
  const entered: TuneOutParams[] = [];
  /** The source of each cancel that ended a tune-out: 'duration' for an end time. */
  const cancels: string[] = [];
  /** Every call to the registry's cancel, whatever came of it. */
  let cancelCalls = 0;
  /** The reason of each inference requested, the subconscious's turns among them. */
  const inferences: string[] = [];
  /** The coordinator's own durable state: the all-except hold lives here. */
  const coordinatorState = new Map<string, unknown>();
  const registry = {
    // Each channel's id is unique here, so it's shown by its id.
    nameShown: (channel: { channelId: string }) => channel.channelId,
    quotedShown: (channel: { channelId: string }) => JSON.stringify(channel.channelId),
    listChannelsRaw: () => (state ? [{ serverId: 'disc', descriptor: { id: '#a' } }] : []),
    tuneOutsOnRecord: () => (state ? [{ serverId: 'disc', channelId: '#a', params: state.params, source: 'agent-tool' }] : []),
    readCoordinatorState: (id: string) => coordinatorState.get(id) ?? null,
    writeCoordinatorState: (id: string, value: unknown) => { if (value === null) coordinatorState.delete(id); else coordinatorState.set(id, value); },
    getTuneOutState: () => state,
    enterTuneOut: (_s: string, _c: string, params: TuneOutParams) => {
      entered.push(params);
      state = { params, wakeCount: 0 };
    },
    cancelTuneOut: (_s: string, _c: string, _next: string, source: string) => {
      cancelCalls++;
      throwIfSet('cancelTuneOut');
      const ended = state;
      state = null;
      if (ended) cancels.push(source);
      return ended;
    },
    recordTuneOutWake: () => {
      throwIfSet('recordTuneOutWake');
      return state ? { params: state.params, wakeCount: ++state.wakeCount } : null;
    },
  } as unknown as ChannelRegistry;
  const hooks = {
    addMessage: (_participant: string, content: Array<{ text: string }>) => {
      throwIfSet('addMessage');
      notices.push(content[0]?.text ?? '');
      return '';
    },
    requestInference: (_agent: string, reason: string) => { throwIfSet('requestInference'); inferences.push(reason); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    currentSequence: () => 1,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: (event: Record<string, unknown>) => { traces.push(event); },
  } as unknown as TuneOutFrameworkHooks;
  const coordinator = new TuneOutCoordinator(registry, servers, hooks);
  t.after(() => {
    coordinator.stop();
    globalThis.setTimeout = mocked;
    t.mock.timers.reset();
  });
  const cadenceTurns = () => inferences.filter((r) => r.startsWith('tune-out cadence'));
  /** The resident's turns for a hold that ended, with the reason. */
  const releases = () => inferences.filter((r) => r.startsWith('tune-out cancelled ('));
  const wakeTurns = () => inferences.filter((r) => r.startsWith('tune-out wake'));
  const noTimerPastOne = () => assert.ok(
    delays.every((ms) => ms <= ONE_TIMER_MS),
    `no timer longer than one holds (${delays.filter((ms) => !(ms <= ONE_TIMER_MS)).join(', ')})`,
  );
  /** End the tune-out in the registry alone, without the coordinator's cancel. */
  const endInRegistry = () => { state = null; };
  const active = () => state !== null;
  /** Make the step's next call throw `thrown`. */
  const failNext = (
    step: 'addMessage' | 'recordTuneOutWake' | 'cancelTuneOut' | 'requestInference' = 'addMessage',
    thrown: unknown = new Error('store write failed'),
  ) => { throwsNext.set(step, thrown); };
  const timerFailures = () => traces.filter((e) => e.type === 'tune-out:timer-failed');
  const ackFailures = () => traces.filter((e) => e.type === 'tune-out:ack-failed');
  /** The arguments of each line written to stderr. */
  const stderrLines = () => stderr.mock.calls.map((c) => c.arguments as unknown[]);
  return {
    coordinator, entered, cancels, cadenceTurns, releases, wakeTurns, delays, noTimerPastOne, endInRegistry, active,
    failNext, timerFailures, ackFailures, notices, stderrLines, cancelCalls: () => cancelCalls,
  };
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

it("a tune-out that ends in the registry without its cancel leaves none of its timers to act on the channel's next one", (t) => {
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

// The all-except hold (Dendrite) arms its own end time and cadence, and reads
// its options by the same rule as a channel's tune-out.

it('an all-except hold past one timer ends at its end time and not before', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enterAllExcept({ serverId: 'disc', channelId: '#a' }, { durationSeconds: 30 * 86_400 }, 'agent-tool').ok, true);
  t.mock.timers.tick(ONE_TIMER_MS);
  assert.ok(h.coordinator.getAllExcept(), "still held after one timer's worth");
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS - 1);
  assert.ok(h.coordinator.getAllExcept(), 'still held 1 ms before its end');
  assert.deepEqual(h.releases(), [], 'the resident has not been woken');
  t.mock.timers.tick(1);
  assert.equal(h.coordinator.getAllExcept(), null, 'released at its end time');
  assert.deepEqual(h.releases(), ['tune-out cancelled (duration elapsed)'], 'one wake, at the end time');
  h.noTimerPastOne();
});

it('an all-except cadence past one timer gives the subconscious a turn each period for a held channel with traffic', (t) => {
  const h = harness(t);
  assert.equal(
    h.coordinator.enterAllExcept({ serverId: 'disc', channelId: '#a' }, { durationSeconds: 90 * 86_400, cadenceSeconds: 30 * 86_400 }, 'agent-tool').ok,
    true,
  );
  assert.ok(h.coordinator.onIncoming('disc', '#b', 'm1', undefined), 'a message in another channel is held');
  t.mock.timers.tick(ONE_TIMER_MS);
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS - 1);
  assert.deepEqual(h.cadenceTurns(), [], 'no turn before the cadence');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #b'], 'one turn at the cadence');
  h.coordinator.onIncoming('disc', '#b', 'm2', undefined);
  t.mock.timers.tick(ONE_TIMER_MS);
  t.mock.timers.tick(30 * DAY_MS - ONE_TIMER_MS);
  assert.equal(h.cadenceTurns().length, 2, 'a second turn a period later');
  h.noTimerPastOne();
});

it('enterAllExcept refuses an option that gives no finite number, and a duration left out, before anything changes', (t) => {
  const h = harness(t);
  const except = { serverId: 'disc', channelId: '#a' };
  const error = (r: { ok: boolean; error?: string }) => (assert.equal(r.ok, false), r.error);
  assert.equal(
    error(h.coordinator.enterAllExcept(except, { durationSeconds: 'abc' as unknown as number }, 'agent-tool')),
    'Nothing was tuned out: durationSeconds must be a finite number of seconds, and it was the string "abc".',
  );
  assert.equal(
    error(h.coordinator.enterAllExcept(except, { durationSeconds: 3600, cadenceSeconds: Number.NaN }, 'agent-tool')),
    'Nothing was tuned out: cadenceSeconds must be a finite number of seconds, and it was NaN. Leave it out for the default, 1800.',
  );
  assert.equal(
    error(h.coordinator.enterAllExcept(except, { durationSeconds: Number.MAX_VALUE }, 'agent-tool')),
    `Nothing was tuned out: durationSeconds ${Number.MAX_VALUE} is longer than an end time can be kept.`,
  );
  assert.match(error(h.coordinator.enterAllExcept(except, {}, 'agent-tool'))!, /needs `durationSeconds`/);
  assert.match(error(h.coordinator.enterAllExcept(except, { durationSeconds: null as unknown as number }, 'agent-tool'))!, /needs `durationSeconds`/);
  assert.equal(h.coordinator.getAllExcept(), null, 'nothing was held');
  assert.deepEqual(h.delays, [], 'no timer was armed');
  const read = h.coordinator.enterAllExcept(except, { durationSeconds: '3600' as unknown as number }, 'agent-tool');
  assert.equal(read.ok, true, 'a numeric string is read as its number');
  assert.equal((read as { params: { expiresAtMs: number } }).params.expiresAtMs, NOW + 3_600_000);
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

// A timer callback's work can throw, as a failed store write would. Thrown into
// the event loop, it's an uncaught exception, which ends the host process.
// Under node:test's mock timers a throw also comes out of tick(), and the mock
// then runs that callback once more at its next tick, so these tests assert
// that nothing leaves tick(), not only what comes after.

const failure = (timer: string, error = 'store write failed') =>
  ({ type: 'tune-out:timer-failed', timer, serverId: 'disc', channelId: '#a', error });

it("a cadence turn that throws stays in its timer, is reported, and the next period's turn counts its messages", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  h.failNext();
  assert.doesNotThrow(() => t.mock.timers.tick(60_000), "the turn's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('cadence')]);
  assert.deepEqual(h.cadenceTurns(), [], 'the failed turn requested nothing');
  // No new traffic: the next period's turn is for m1.
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], "the next period's turn comes");
  assert.match(h.notices.at(-1) ?? '', /— 1 diverted message since your last look\]$/);
});

it('an all-except release that throws at its end time stays in its timer, is reported, and is tried again', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enterAllExcept({ serverId: 'disc', channelId: '#a' }, { durationSeconds: 120 }, 'agent-tool').ok, true);
  h.failNext('addMessage');
  assert.doesNotThrow(() => t.mock.timers.tick(120_000), "the release's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('expiry')]);
  assert.ok(h.coordinator.getAllExcept(), 'the hold is still in force, its release owed');
  t.mock.timers.tick(60_000);
  assert.equal(h.coordinator.getAllExcept(), null, 'released on the retry');
  assert.deepEqual(h.releases(), ['tune-out cancelled (duration elapsed)']);
});

it('an all-except cadence turn that throws stays in its timer and the next period comes', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enterAllExcept({ serverId: 'disc', channelId: '#a' }, { durationSeconds: 3600, cadenceSeconds: 60 }, 'agent-tool').ok, true);
  assert.ok(h.coordinator.onIncoming('disc', '#b', 'm1', undefined), 'a message in another channel is held');
  h.failNext('addMessage');
  assert.doesNotThrow(() => t.mock.timers.tick(60_000), "the turn's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('cadence')]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #b'], "the next period's turn comes");
});

it("a channel's tune-out outlives its reader: once the reader stops, its end time still releases it", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 120, cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  h.coordinator.stopReader();
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cadenceTurns(), [], 'no reader turns after the reader stopped');
  t.mock.timers.tick(60_000);
  assert.equal(h.active(), false, 'ended at its end time');
});

it('an all-except hold outlives its reader: once the reader stops, its end time still releases it', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enterAllExcept({ serverId: 'disc', channelId: '#a' }, { durationSeconds: 120 }, 'agent-tool').ok, true);
  h.coordinator.stopReader();
  t.mock.timers.tick(120_000);
  assert.equal(h.coordinator.getAllExcept(), null, 'released at its end time');
  assert.deepEqual(h.releases(), ['tune-out cancelled (duration elapsed)']);
});

it('a timer failure is written to stderr with the error', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  const thrown = new Error('store write failed');
  h.failNext('addMessage', thrown);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.stderrLines(), [['[tune-out] the cadence timer for #a on disc failed:', thrown]]);
});

it('after a turn, the count starts again: a quiet period gives no turn, and the next notice counts only new messages', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  h.coordinator.onIncoming('disc', '#a', 'm2', undefined);
  t.mock.timers.tick(60_000);
  assert.match(h.notices.at(-1) ?? '', /— 2 diverted messages since your last look\]$/);
  t.mock.timers.tick(60_000);
  assert.equal(h.cadenceTurns().length, 1, 'no turn for a quiet period after a turn');
  h.coordinator.onIncoming('disc', '#a', 'm3', undefined);
  t.mock.timers.tick(60_000);
  assert.equal(h.cadenceTurns().length, 2);
  assert.match(h.notices.at(-1) ?? '', /— 1 diverted message since your last look\]$/);
});

it("a wake turn that throws leaves its message for the next cadence turn", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  h.failNext();
  t.mock.timers.tick(2_000);
  assert.deepEqual(h.wakeTurns(), [], 'the wake turn failed');
  t.mock.timers.tick(58_000);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], 'the cadence turn comes');
  assert.match(h.notices.at(-1) ?? '', /— 1 diverted message since your last look\]$/);
});

it("a cadence tick that finds the tune-out ended in the registry arms nothing and gives no turn", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  h.endInRegistry();
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cadenceTurns(), [], 'no turn for an ended tune-out');
  assert.equal(h.delays.filter((ms) => ms === 60_000).length, 1, 'only the first period was armed');
});

it("a quiet cadence period arms the next, whose turn comes when a message is diverted", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cadenceTurns(), [], 'a quiet period gives no turn');
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cadenceTurns(), ['tune-out cadence: #a'], "the next period's turn comes");
});

it('a coalesced wake whose turn throws stays in its timer and is reported', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  h.failNext();
  assert.doesNotThrow(() => t.mock.timers.tick(2_000), "the turn's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('wake')]);
  h.coordinator.onIncoming('disc', '#a', 'm2', ['chat:addressed']);
  t.mock.timers.tick(2_000);
  assert.deepEqual(h.wakeTurns(), ['tune-out wake: #a'], "the next wake's turn comes");
});

it("a coalesced wake whose count can't be recorded stays in its timer and is reported", (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  h.failNext('recordTuneOutWake');
  assert.doesNotThrow(() => t.mock.timers.tick(2_000), "the error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('wake')]);
  assert.deepEqual(h.wakeTurns(), [], 'no turn for the wake it could not count');
});

it('a coalesced wake for a tune-out the registry ended in its window gives no turn and reports nothing', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  h.endInRegistry();
  t.mock.timers.tick(2_000);
  assert.deepEqual(h.wakeTurns(), []);
  assert.deepEqual(h.timerFailures(), []);
});

it('a failed acknowledgement is written to stderr and traced, whatever it rejects with', async (t) => {
  const servers = {
    getServer: () => ({
      grant: new CapabilityGrant(new Set(['channels.acknowledge']), []),
      sendChannelsAcknowledge: async () => { throw undefined; },
    }),
  } as unknown as McplServerRegistry;
  const h = harness(t, undefined, { servers });
  assert.equal(h.coordinator.enter('disc', '#a', {}, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.ackFailures(), [
    { type: 'tune-out:ack-failed', serverId: 'disc', channelId: '#a', error: 'undefined' },
  ]);
  assert.deepEqual(h.stderrLines(), [['[tune-out] acknowledging m1 in #a on disc failed:', undefined]]);
});

it('an end time whose cancel throws after the registry ended the tune-out stays in its timer, is reported, and tries no more', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 120 }, 'agent-tool').ok, true);
  h.failNext('requestInference');
  assert.doesNotThrow(() => t.mock.timers.tick(120_000), "the cancel's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('expiry')]);
  assert.equal(h.active(), false, 'the registry ended it before the wake threw');
  t.mock.timers.tick(10 * 60_000);
  assert.equal(h.cancelCalls(), 1, 'the registry ended it, so nothing tries again');
});

it('an end time whose registry cancel throws is reported, and the cancel is tried again a minute later', (t) => {
  // The stand-in's cancel throws before it changes anything, as a registry
  // that writes its record before it changes memory does when the write fails.
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 120 }, 'agent-tool').ok, true);
  h.failNext('cancelTuneOut');
  assert.doesNotThrow(() => t.mock.timers.tick(120_000), "the cancel's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('expiry')]);
  assert.equal(h.active(), true, 'still tuned out after the failed cancel');
  t.mock.timers.tick(60_000 - 1);
  assert.deepEqual(h.cancels, [], 'not before the minute');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancels, ['duration'], 'ended a minute later');
  t.mock.timers.tick(10 * 60_000);
  assert.equal(h.cancelCalls(), 2, 'and nothing tries again after it ended');
});

it('a wake past the budget whose cancel throws, on a quiet tune-out with no end time, is reported, and the cancel is tried again a minute later', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { maxWakes: 1 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', ['chat:addressed']);
  t.mock.timers.tick(2_000);
  h.failNext('addMessage');
  h.coordinator.onIncoming('disc', '#a', 'm2', ['chat:addressed']);
  assert.doesNotThrow(() => t.mock.timers.tick(2_000), "the cancel's error stays in the timer");
  assert.deepEqual(h.timerFailures(), [failure('wake')]);
  assert.equal(h.active(), true, 'still tuned out after the failed cancel');
  t.mock.timers.tick(60_000 - 1);
  assert.deepEqual(h.cancels, [], 'not before the minute');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancels, ['tune-out-max-wakes'], 'ended a minute later, with no new message');
  t.mock.timers.tick(10 * 60_000);
  assert.equal(h.cancelCalls(), 1, 'and nothing tries again after it ended');
});

it('an end time that finds the tune-out already ended in the registry tries no more', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { durationSeconds: 120 }, 'agent-tool').ok, true);
  h.endInRegistry();
  const cancel = h.coordinator.cancel.bind(h.coordinator);
  let attempts = 0;
  h.coordinator.cancel = (...args: Parameters<typeof cancel>) => { attempts++; return cancel(...args); };
  t.mock.timers.tick(120_000);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(attempts, 1);
  assert.deepEqual(h.timerFailures(), []);
});

it('a thrown value that is not an Error is reported as a string, even one with no string form', (t) => {
  const h = harness(t);
  assert.equal(h.coordinator.enter('disc', '#a', { cadenceSeconds: 60 }, 'agent-tool').ok, true);
  h.coordinator.onIncoming('disc', '#a', 'm1', undefined);
  h.failNext('addMessage', 'disk full');
  assert.doesNotThrow(() => t.mock.timers.tick(60_000));
  // String() throws for an object with no prototype.
  h.failNext('addMessage', Object.create(null));
  assert.doesNotThrow(() => t.mock.timers.tick(60_000));
  assert.deepEqual(h.timerFailures().map((e) => e.error), ['disk full', '(a value that could not be read)']);
});
