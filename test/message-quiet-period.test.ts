/**
 * FrameworkConfig.messageQuietPeriod: an idle agent's turn waits while
 * message wakes for it keep arriving, one burst at a time, and starts once
 * per burst with that burst's wakes.
 *
 * The hold lives where the scheduler starts a turn (runInferencePass), not in
 * the gate: each message keeps the decision the gate gave it, so who wakes a
 * sleeping agent, where a reply goes, and what tune-out and conversation
 * routing see are as on `main` (#856's reviews). Bursts are keyed by channel
 * (R1-1): chatter in one channel neither delays another channel's turn nor
 * takes its reply, and a wake that is no message starts with at most one
 * channel's burst (R2-1). What the hold decides is `quietSplit`, pinned here
 * on fixed clocks; the scheduler's use of it runs against a real framework
 * with wide margins, watching the hold's own traces for which burst each
 * turn started for. Where each reply lands is checked through real ingress
 * in message-quiet-period-e2e.test.ts: these requests name channels no
 * registry knows, so the turn resolves no locus here.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { quietSplit, quietBurstKey, carryQuietSinceForTests } from '../src/framework.js';
import type { InferenceRequest } from '../src/types/agent.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane, OneResponsePerTurnMembrane, createMockResponse } from './helpers/mock-membrane.js';

const TMP = join(import.meta.dirname, '../.test-tmp-quiet-period');
const T0 = 1_000_000;
const QUIET = { quietMs: 2_000, maxWaitMs: 10_000 };

const message = (at: number, extra: Partial<InferenceRequest> = {}): InferenceRequest => ({
  agentName: 'agent', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: at, ...extra,
});
const inChannel = (at: number, channelId: string, extra: Partial<InferenceRequest> = {}): InferenceRequest =>
  message(at, { channelId, channelServerId: 'discord', ...extra });
const key = (channelId: string) => quietBurstKey(inChannel(0, channelId));

/** ms until the one burst in `requests` starts, 0 when it starts now. */
const remaining = (requests: InferenceRequest[], now: number, quiet = QUIET): number => {
  const split = quietSplit(requests, now, quiet);
  if (split.start.length > 0) {
    assert.equal(split.hold.length, 0, 'one burst: all or nothing');
    return 0;
  }
  assert.equal(split.waiting.size, 1, 'one burst waiting');
  return [...split.waiting.values()][0];
};

describe('quietSplit', () => {
  it('starts everything with the option off, or with nothing queued', () => {
    const off = quietSplit([message(T0)], T0 + 100, undefined);
    assert.equal(off.start.length, 1); assert.equal(off.hold.length, 0); assert.equal(off.started.size, 0);
    assert.deepEqual(quietSplit([], T0, QUIET), { start: [], hold: [], started: new Map(), waiting: new Map() });
    assert.equal(remaining([message(T0)], T0 + 100, { quietMs: 0, maxWaitMs: 10_000 }), 0);
  });

  it('holds a burst for quietMs after its newest message wake', () => {
    const burst = [message(T0), message(T0 + 500), message(T0 + 900)];
    assert.equal(remaining(burst, T0 + 1_000), 1_900, 'quietMs counted from the newest');
    assert.equal(remaining(burst, T0 + 2_899), 1);
    assert.equal(remaining(burst, T0 + 2_900), 0, 'quiet: the turn starts');
    const split = quietSplit(burst, T0 + 2_900, QUIET);
    assert.deepEqual(split.start, burst);
    assert.deepEqual([...split.started], [[quietBurstKey(burst[0]), 'quiet']]);
  });

  it('ends the hold maxWaitMs after the oldest message wake, however the burst goes on', () => {
    const stream = [message(T0), message(T0 + 9_000), message(T0 + 9_900)];
    assert.equal(remaining(stream, T0 + 9_950), 50, 'the cap, not quietMs, is what is left');
    assert.equal(remaining(stream, T0 + 10_000), 0);
    assert.deepEqual([...quietSplit(stream, T0 + 10_000, QUIET).started.values()], ['cap']);
  });

  it('a maxWaitMs below quietMs is the cap', () => {
    assert.equal(remaining([message(T0)], T0 + 100, { quietMs: 2_000, maxWaitMs: 300 }), 200);
  });

  it('a burst counts its cap from the age a replaced wake carried (a coalesced batch that keeps updating)', () => {
    // The batch's first wake was at T0; every notice since replaced it with
    // a newer wake. The cap still counts from T0.
    const latest = message(T0 + 9_800, { reason: 'mcpl:push-event', source: 'tsm', coalescingSubject: 's' });
    carryQuietSinceForTests(latest, T0);
    assert.equal(remaining([latest], T0 + 9_900), 100, 'the cap from the first wake, not the latest');
    assert.deepEqual([...quietSplit([latest], T0 + 10_000, QUIET).started.values()], ['cap']);
    const fresh = message(T0 + 9_800, { reason: 'mcpl:push-event', source: 'tsm', coalescingSubject: 's' });
    assert.equal(remaining([fresh], T0 + 9_900), 1_900, 'without the carry it would wait on');
  });

  it('a server event is a message wake; the heartbeat is not', () => {
    const push = message(T0, { reason: 'mcpl:push-event', source: 'tsm' });
    assert.equal(remaining([push], T0 + 100), 1_900);
    const tick = message(T0, { reason: 'mcpl:push-event', source: 'heartbeat' });
    assert.equal(remaining([tick], T0 + 100), 0);
    assert.equal(remaining([message(T0), tick], T0 + 100), 0, 'a tick in the batch starts it');
    // isHeartbeatWake, not the source's name: a channel message from a server
    // called heartbeat is a message, and a heartbeat's turn is a tick.
    const named = inChannel(T0, 'g:room', { source: 'heartbeat', channelServerId: 'heartbeat' });
    assert.equal(remaining([named], T0 + 100), 1_900);
    assert.equal(remaining([message(T0, { reason: 'mcpl:push-event', source: 'gate', heartbeatTurn: true })], T0 + 100), 0);
  });

  it('a continuation or a retry of the turn is not held', () => {
    const restart = message(T0, { reason: 'context_budget_restart', source: 'framework' });
    assert.equal(remaining([restart], T0 + 100), 0);
    const guard = message(T0, { reason: 'tool_result_guard_retry', source: 'framework' });
    assert.equal(remaining([guard], T0 + 100), 0);
    const auto = message(T0, { autoContinueRun: { stop: 'call skip_reply' } });
    assert.equal(remaining([auto], T0 + 100), 0);
  });

  it('bursts are per channel: one channel\'s chatter does not move another\'s deadline (R1-1)', () => {
    const dm = inChannel(T0, 'dm:42', { addressed: true });
    const salon = [inChannel(T0 + 300, 'g:salon'), inChannel(T0 + 600, 'g:salon'), inChannel(T0 + 900, 'g:salon')];
    const early = quietSplit([dm, ...salon], T0 + 1_000, QUIET);
    assert.equal(early.start.length, 0, 'nothing is quiet yet');
    assert.deepEqual([...early.waiting.entries()], [[key('dm:42'), 1_000], [key('g:salon'), 1_900]]);
    const dmReady = quietSplit([dm, ...salon], T0 + 2_000, QUIET);
    assert.deepEqual(dmReady.start, [dm], 'the DM starts on its own clock');
    assert.deepEqual(dmReady.hold, salon, 'the salon keeps waiting');
    assert.deepEqual([...dmReady.started], [[key('dm:42'), 'quiet']]);
    assert.deepEqual([...dmReady.waiting.keys()], [key('g:salon')]);
  });

  it('two ready bursts start one at a time, the one that waited longest first; the other stays listed as waiting', () => {
    const room = inChannel(T0, 'g:room');
    const general = inChannel(T0 + 300, 'g:general');
    const split = quietSplit([room, general], T0 + 2_400, QUIET);
    assert.deepEqual(split.start, [room]);
    assert.deepEqual(split.hold, [general], 'general gets a turn of its own, from the next pass');
    assert.deepEqual([...split.waiting.entries()], [[key('g:general'), 0]], 'ready, held only for its own turn');
  });

  it('a channel is one burst under its server: the same id on another server is another', () => {
    const a = inChannel(T0, 'general', { channelServerId: 'discord' });
    const b = inChannel(T0, 'general', { channelServerId: 'slack' });
    assert.notEqual(quietBurstKey(a), quietBurstKey(b));
    assert.equal(quietBurstKey(inChannel(T0, 'general')), quietBurstKey(a), 'the server named, or the wake\'s source');
  });

  it('wakes that name no channel are a burst of their source, on their own clock (R2-4)', () => {
    const tsm = message(T0 + 1_900, { reason: 'mcpl:push-event', source: 'tsm' });
    const other = message(T0 + 1_900, { reason: 'mcpl:push-event', source: 'calendar' });
    assert.notEqual(quietBurstKey(tsm), quietBurstKey(other));
    const room = inChannel(T0, 'g:room');
    const split = quietSplit([room, tsm, other], T0 + 2_000, QUIET);
    assert.deepEqual(split.start, [room], 'the room starts with its wakes alone');
    assert.deepEqual([...split.waiting.entries()], [[quietBurstKey(tsm), 1_900], [quietBurstKey(other), 1_900]]);
    const later = quietSplit([tsm, other], T0 + 3_900, QUIET);
    assert.deepEqual(later.start, [tsm], 'then each source in turn');
    assert.deepEqual(later.hold, [other]);
  });

  it('any other wake starts now, with the wakes that name no channel and at most one channel\'s burst (R2-1)', () => {
    const room = inChannel(T0, 'g:room', { addressed: true });
    const dm = inChannel(T0 + 300, 'dm:42', { addressed: true });
    const tsm = message(T0 + 500, { reason: 'mcpl:push-event', source: 'tsm' });
    for (const other of [
      message(T0 + 600, { reason: 'self-wake', source: 'gate' }),
      message(T0 + 600, { reason: 'external-message', source: 'api' }),
      message(T0 + 600, { reason: 'operator', source: 'api', addressed: true }),
      message(T0 + 600, { reason: 'gate:debounce', source: 'gate' }),
    ]) {
      // Nothing is ready: the other wake starts with the channel-less tsm
      // wake, and both channels keep waiting on their own clocks.
      const split = quietSplit([room, dm, tsm, other], T0 + 700, QUIET);
      assert.deepEqual(split.start, [tsm, other], other.reason);
      assert.deepEqual(split.hold, [room, dm], `${other.reason}: the channels wait`);
      assert.deepEqual([...split.started], [[quietBurstKey(tsm), 'other-wake']]);
      assert.deepEqual([...split.waiting.keys()], [key('g:room'), key('dm:42')]);
    }
    // The room is ready, the DM isn't: the other wake takes the room's burst.
    const roomReady = quietSplit([room, dm, message(T0 + 2_100, { reason: 'self-wake', source: 'gate' })], T0 + 2_150, QUIET);
    assert.deepEqual(roomReady.start.map((r) => r.channelId ?? r.reason), ['g:room', 'self-wake']);
    assert.deepEqual(roomReady.hold, [dm]);
    assert.deepEqual([...roomReady.started], [[key('g:room'), 'other-wake']]);
  });

  it('an other wake that names a channel takes that channel\'s burst, ready or not (R2-1)', () => {
    const room = inChannel(T0, 'g:room', { addressed: true });
    const dm = inChannel(T0 + 300, 'dm:42', { addressed: true });
    const timer = inChannel(T0 + 400, 'dm:42', { reason: 'self-wake', source: 'gate' });
    const split = quietSplit([room, dm, timer], T0 + 2_100, QUIET);
    assert.deepEqual(split.start, [dm, timer], 'the DM, which the timer names, not the ready room');
    assert.deepEqual(split.hold, [room]);
    assert.deepEqual([...split.started], [[key('dm:42'), 'other-wake']]);
  });
});

describe('messageQuietPeriod in the scheduler', () => {
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  async function start(quiet?: { quietMs: number; maxWaitMs?: number }, agents = ['agent']) {
    mkdirSync(TMP, { recursive: true });
    const membrane = new OneResponsePerTurnMembrane();
    const framework = await AgentFramework.create({
      storePath: join(TMP, `store-${Math.random().toString(36).slice(2)}`),
      membrane: membrane.asMembrane(),
      agents: agents.map((name) => ({ name, model: 'test-model', systemPrompt: 'test' })),
      modules: [],
      ...(quiet ? { messageQuietPeriod: quiet } : {}),
    });
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => { traces.push(e); });
    framework.start();
    return { framework, membrane, internals, traces };
  }
  type Released = Extract<TraceEvent, { type: 'quiet-period:released' }>;
  /** The bursts the quiet period released, in order, with why. */
  const released = (traces: TraceEvent[]): [string, Released['cause']][] =>
    traces.flatMap((e) => (e.type === 'quiet-period:released' ? [[e.burst, e.cause] as [string, Released['cause']]] : []));
  const heldKeys = (traces: TraceEvent[]): string[] =>
    traces.flatMap((e) => (e.type === 'quiet-period:held' ? [e.burst] : []));
  const wake = (internals: { pendingRequests: InferenceRequest[] }, extra: Partial<InferenceRequest> = {}) =>
    internals.pendingRequests.push(message(Date.now(), extra));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => boolean, what: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };
  const reply = (membrane: MockMembrane, text: string) => membrane.pushResponse(createMockResponse([{ type: 'text', text }]));

  it('a burst of message wakes starts one turn, once the burst is quiet', async () => {
    const { framework, membrane, internals } = await start({ quietMs: 600 });
    reply(membrane, 'one turn');
    try {
      const t0 = Date.now();
      wake(internals); await sleep(100);
      wake(internals); await sleep(100);
      wake(internals);
      await sleep(300);
      assert.equal(membrane.calls.length, 0, 'no turn while the burst goes on');
      await waitFor(() => membrane.calls.length >= 1, 'the turn', 3_000);
      assert.ok(Date.now() - t0 >= 700, 'the turn started after the quiet period');
      await sleep(400);
      assert.equal(membrane.calls.length, 1, 'one turn for the burst');
    } finally {
      await framework.stop();
    }
  });

  it('with the option off, the same wakes start a turn at once', async () => {
    const { framework, membrane, internals } = await start();
    reply(membrane, 'now');
    try {
      const t0 = Date.now();
      wake(internals);
      await waitFor(() => membrane.calls.length >= 1, 'the turn', 3_000);
      assert.ok(Date.now() - t0 < 500, 'started without a hold');
    } finally {
      await framework.stop();
    }
  });

  it('a stream that never goes quiet starts a turn at maxWaitMs, and not before', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 600, maxWaitMs: 900 });
    reply(membrane, 'capped');
    try {
      const t0 = Date.now();
      let startedAt: number | undefined;
      while (Date.now() - t0 < 1_500 && startedAt === undefined) {
        wake(internals);
        await sleep(100);
        if (membrane.calls.length > 0) startedAt = Date.now() - t0;
      }
      assert.ok(startedAt !== undefined, 'the cap started the turn');
      assert.ok(startedAt >= 850, `no turn before the cap: started at +${startedAt} ms`);
      assert.ok(startedAt < 1_500, 'and before the stream ended');
      assert.deepEqual(released(traces).map(([, cause]) => cause), ['cap'], 'and the trace says the cap did');
    } finally {
      await framework.stop();
    }
  });

  it('holds are per channel: chatter in one channel does not delay another\'s turn (R1-1)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 600 });
    reply(membrane, 'dm reply');
    reply(membrane, 'salon reply');
    try {
      const t0 = Date.now();
      wake(internals, { channelId: 'discord:dm:42', channelServerId: 'discord', addressed: true });
      // The salon chatters every 150 ms until the DM's turn: its burst is never quiet.
      const chatter = setInterval(() => wake(internals, { channelId: 'discord:g:salon', channelServerId: 'discord', ambient: true }), 150);
      try {
        await waitFor(() => membrane.calls.length >= 1, 'the DM\'s turn', 3_000);
        const dmAt = Date.now() - t0;
        assert.ok(dmAt >= 550 && dmAt < 1_500, `the DM started on its own clock, at +${dmAt} ms`);
        assert.deepEqual(released(traces), [[key('discord:dm:42'), 'quiet']], 'and it was the DM\'s burst');
      } finally {
        clearInterval(chatter);
      }
      await waitFor(() => membrane.calls.length >= 2, 'the salon\'s turn', 3_000);
      assert.deepEqual(released(traces), [[key('discord:dm:42'), 'quiet'], [key('discord:g:salon'), 'quiet']], 'the salon got a turn of its own');
      await sleep(400);
      assert.equal(membrane.calls.length, 2, 'one turn per burst');
    } finally {
      await framework.stop();
    }
  });

  it('two addressed channels each get a turn of their own, oldest burst first (R1-1)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 400 });
    reply(membrane, 'to room');
    reply(membrane, 'to general');
    try {
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord', addressed: true });
      await sleep(200);
      wake(internals, { channelId: 'discord:g:general', channelServerId: 'discord', addressed: true });
      await waitFor(() => membrane.calls.length >= 2, 'two turns', 4_000);
      assert.deepEqual(released(traces), [[key('discord:g:room'), 'quiet'], [key('discord:g:general'), 'quiet']], 'one turn per burst, oldest first');
      await sleep(300);
      assert.equal(membrane.calls.length, 2);
    } finally {
      await framework.stop();
    }
  });

  it('a timer while two channels are held starts with at most one of them; the other keeps its turn (R2-1)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 600 });
    reply(membrane, 'timer turn');
    reply(membrane, 'room turn');
    reply(membrane, 'general turn');
    try {
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord', addressed: true });
      await sleep(100);
      wake(internals, { channelId: 'discord:g:general', channelServerId: 'discord', addressed: true });
      await waitFor(() => heldKeys(traces).length >= 2, 'both bursts held', 2_000);
      wake(internals, { reason: 'self-wake', source: 'gate' });
      await waitFor(() => membrane.calls.length >= 1, 'the timer\'s turn', 2_000);
      assert.equal(released(traces).length, 0, 'neither burst was ready, so the timer took neither');
      await waitFor(() => membrane.calls.length >= 3, 'both channels\' turns', 4_000);
      assert.deepEqual(released(traces), [[key('discord:g:room'), 'quiet'], [key('discord:g:general'), 'quiet']]);
    } finally {
      await framework.stop();
    }
  });

  it('a backlog that waited out a busy turn starts one turn per channel, oldest first (R2-5)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 200, maxWaitMs: 400 });
    let release!: () => void;
    membrane.holdNext = new Promise<void>((r) => { release = r; });
    reply(membrane, 'busy turn');
    reply(membrane, 'to room');
    reply(membrane, 'to general');
    try {
      wake(internals, { reason: 'operator', source: 'api', addressed: true });
      await waitFor(() => membrane.calls.length >= 1, 'the busy turn', 2_000);
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord', addressed: true });
      await sleep(50);
      wake(internals, { channelId: 'discord:g:general', channelServerId: 'discord', addressed: true });
      await sleep(600);
      assert.equal(membrane.calls.length, 1, 'both wait behind the busy turn');
      assert.deepEqual(heldKeys(traces), [], 'a wake behind a busy turn is not held by the quiet period');
      release();
      await waitFor(() => membrane.calls.length >= 3, 'one turn per channel', 4_000);
      // The room, past its cap when first seen, was never held and emits no
      // trace; general, ready too, waited only for the room's turn, which is
      // a hold of its own (readyInMs 0), paired with its release.
      assert.deepEqual(heldKeys(traces), [key('discord:g:general')]);
      assert.deepEqual(released(traces), [[key('discord:g:general'), 'quiet']]);
      await sleep(300);
      assert.equal(membrane.calls.length, 3, 'the backlog made one turn per channel, not one merged turn');
    } finally {
      release();
      await framework.stop();
    }
  });

  it('a held burst is traced when its hold begins and when it starts, paired (R1-4, R2-2)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 300 });
    reply(membrane, 'ok');
    reply(membrane, 'ok');
    try {
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await sleep(100);
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await waitFor(() => membrane.calls.length >= 1, 'the turn', 3_000);
      assert.deepEqual(heldKeys(traces), [key('discord:g:room')], 'one hold trace per burst, however many passes hold it');
      const rel = traces.filter((e): e is Released => e.type === 'quiet-period:released');
      assert.equal(rel.length, 1);
      assert.equal(rel[0].burst, key('discord:g:room'));
      assert.equal(rel[0].cause, 'quiet');
      assert.equal(rel[0].wakes, 2);
      assert.ok(rel[0].heldMs >= 300 && rel[0].heldMs < 2_000, `heldMs is the hold's length: ${rel[0].heldMs}`);
      // A second burst after the first is traced anew: the key does not stick.
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await waitFor(() => membrane.calls.length >= 2, 'the second turn', 3_000);
      assert.equal(heldKeys(traces).length, 2);
      assert.equal(released(traces).length, 2);
    } finally {
      await framework.stop();
    }
  });

  it('a held burst whose wakes leave the queue without a start is released as gone (R2-2)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 5_000 }, ['agent', 'other']);
    reply(membrane, 'other\'s turn');
    try {
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await waitFor(() => heldKeys(traces).length >= 1, 'the hold', 2_000);
      // The wake is withdrawn (as cancelCoalescedWakes or a read-drop would);
      // the next pass, for another agent, finds nothing queued for this one.
      internals.pendingRequests.length = 0;
      wake(internals, { agentName: 'other', reason: 'operator', source: 'api', addressed: true });
      await waitFor(() => released(traces).length >= 1, 'the hold\'s end', 2_000);
      assert.deepEqual(released(traces), [[key('discord:g:room'), 'gone']]);
      // And a new burst in the same channel is held anew.
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await waitFor(() => heldKeys(traces).length >= 2, 'held again', 2_000);
    } finally {
      await framework.stop();
    }
  });

  it('a wake that is no message starts the held turn now', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 2_000 });
    reply(membrane, 'now');
    try {
      const t0 = Date.now();
      wake(internals);
      await waitFor(() => heldKeys(traces).length >= 1, 'the hold', 1_000);
      wake(internals, { reason: 'operator', source: 'api', addressed: true });
      await waitFor(() => membrane.calls.length >= 1, 'the turn', 3_000);
      assert.ok(Date.now() - t0 < 1_000, 'the operator wake ended the hold');
      assert.deepEqual(released(traces), [[quietBurstKey(message(0)), 'other-wake']], 'a channel-less burst rides with it');
    } finally {
      await framework.stop();
    }
  });

  it('refuses a quiet period that is not finite numbers of ms, before the store opens (R1-5)', async () => {
    mkdirSync(TMP, { recursive: true });
    for (const bad of [{ quietMs: Number.NaN }, { quietMs: -1 }, { quietMs: 10, maxWaitMs: 'soon' }, 'later', { maxWaitMs: 5 }]) {
      const storePath = join(TMP, `store-bad-${Math.random().toString(36).slice(2)}`);
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
          modules: [],
          messageQuietPeriod: bad as unknown as { quietMs: number },
        }),
        /messageQuietPeriod must be/,
        JSON.stringify(bad),
      );
      assert.ok(!existsSync(storePath) || readdirSync(storePath).length === 0, `a refused config leaves no store behind: ${JSON.stringify(bad)}`);
    }
  });
});
