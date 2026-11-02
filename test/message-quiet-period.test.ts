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
 * takes its reply. What the hold decides is `quietSplit`, pinned here on
 * fixed clocks; the scheduler's use of it runs against a real framework with
 * wide margins, watching `inference:started` for where each turn speaks.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { quietSplit, quietBurstKey } from '../src/framework.js';
import type { InferenceRequest } from '../src/types/agent.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const TMP = join(import.meta.dirname, '../.test-tmp-quiet-period');
const T0 = 1_000_000;
const QUIET = { quietMs: 2_000, maxWaitMs: 10_000 };

const message = (at: number, extra: Partial<InferenceRequest> = {}): InferenceRequest => ({
  agentName: 'agent', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: at, ...extra,
});
const inChannel = (at: number, channelId: string, extra: Partial<InferenceRequest> = {}): InferenceRequest =>
  message(at, { channelId, channelServerId: 'discord', ...extra });

/** ms until the one burst in `requests` starts, 0 when it starts now. */
const remaining = (requests: InferenceRequest[], now: number, quiet: typeof QUIET | undefined = QUIET): number => {
  // `undefined` passed outright would take the default: callers testing the
  // option off call quietSplit themselves.
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
    assert.deepEqual(quietSplit([message(T0)], T0 + 100, undefined).hold, [], 'off: nothing is held');
    assert.deepEqual(quietSplit([], T0, QUIET), { start: [], hold: [], waiting: new Map() });
    assert.equal(remaining([message(T0)], T0 + 100, { quietMs: 0, maxWaitMs: 10_000 }), 0);
  });

  it('holds a burst for quietMs after its newest message wake', () => {
    const burst = [message(T0), message(T0 + 500), message(T0 + 900)];
    assert.equal(remaining(burst, T0 + 1_000), 1_900, 'quietMs counted from the newest');
    assert.equal(remaining(burst, T0 + 2_899), 1);
    assert.equal(remaining(burst, T0 + 2_900), 0, 'quiet: the turn starts');
    const split = quietSplit(burst, T0 + 2_900, QUIET);
    assert.deepEqual(split.start, burst);
    assert.deepEqual(split.burst, { key: quietBurstKey(burst[0]), heldMs: 2_900 });
  });

  it('ends the hold maxWaitMs after the oldest message wake, however the burst goes on', () => {
    const stream = [message(T0), message(T0 + 9_000), message(T0 + 9_900)];
    assert.equal(remaining(stream, T0 + 9_950), 50, 'the cap, not quietMs, is what is left');
    assert.equal(remaining(stream, T0 + 10_000), 0);
  });

  it('a maxWaitMs below quietMs is the cap', () => {
    assert.equal(remaining([message(T0)], T0 + 100, { quietMs: 2_000, maxWaitMs: 300 }), 200);
  });

  it('a server event is a message wake; the heartbeat is not', () => {
    const push = message(T0, { reason: 'mcpl:push-event', source: 'tsm' });
    assert.equal(remaining([push], T0 + 100), 1_900);
    const tick = message(T0, { reason: 'mcpl:push-event', source: 'heartbeat' });
    assert.equal(remaining([tick], T0 + 100), 0);
    assert.equal(remaining([message(T0), tick], T0 + 100), 0, 'a tick in the batch starts it');
  });

  it('any other wake in the batch starts the whole batch now', () => {
    for (const other of [
      message(T0, { reason: 'self-wake', source: 'gate' }),
      message(T0, { reason: 'external-message', source: 'api' }),
      message(T0, { reason: 'operator', source: 'api', addressed: true }),
      message(T0, { reason: 'gate:debounce', source: 'gate' }),
    ]) {
      const split = quietSplit([inChannel(T0, 'a'), inChannel(T0, 'b'), other], T0 + 100, QUIET);
      assert.equal(split.start.length, 3, other.reason);
      assert.equal(split.burst, undefined, 'not the quiet period\'s choice');
    }
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
    assert.deepEqual([...early.waiting.entries()], [[quietBurstKey(dm), 1_000], [quietBurstKey(salon[0]), 1_900]]);
    const dmReady = quietSplit([dm, ...salon], T0 + 2_000, QUIET);
    assert.deepEqual(dmReady.start, [dm], 'the DM starts on its own clock');
    assert.deepEqual(dmReady.hold, salon, 'the salon keeps waiting');
    assert.deepEqual(dmReady.burst, { key: quietBurstKey(dm), heldMs: 2_000 });
    assert.deepEqual([...dmReady.waiting.keys()], [quietBurstKey(salon[0])]);
  });

  it('two ready bursts start one at a time, the one that waited longest first', () => {
    const room = inChannel(T0, 'g:room');
    const general = inChannel(T0 + 300, 'g:general');
    const split = quietSplit([room, general], T0 + 2_400, QUIET);
    assert.deepEqual(split.start, [room]);
    assert.deepEqual(split.hold, [general], 'general gets a turn of its own, from the next pass');
    assert.equal(split.waiting.size, 0, 'ready, held only for its own turn');
  });

  it('a channel is one burst under its server: the same id on another server is another', () => {
    const a = inChannel(T0, 'general', { channelServerId: 'discord' });
    const b = inChannel(T0, 'general', { channelServerId: 'slack' });
    assert.notEqual(quietBurstKey(a), quietBurstKey(b));
    assert.equal(quietBurstKey(inChannel(T0, 'general')), quietBurstKey(a), 'the server named, or the wake\'s source');
  });

  it('wakes that name no channel are a burst of their source, and ride along with a ready channel', () => {
    const tsm = message(T0 + 1_900, { reason: 'mcpl:push-event', source: 'tsm' });
    const other = message(T0 + 1_900, { reason: 'mcpl:push-event', source: 'calendar' });
    assert.notEqual(quietBurstKey(tsm), quietBurstKey(other));
    const room = inChannel(T0, 'g:room');
    const split = quietSplit([room, tsm, other], T0 + 2_000, QUIET);
    assert.deepEqual(split.start, [room, tsm, other], 'no channel to take, so nothing to wait for');
    assert.equal(split.waiting.size, 0);
    const alone = quietSplit([tsm], T0 + 2_000, QUIET);
    assert.equal(alone.start.length, 0, 'on its own, a source\'s burst waits like a channel\'s');
  });
});

describe('messageQuietPeriod in the scheduler', () => {
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  async function start(quiet?: { quietMs: number; maxWaitMs?: number }) {
    mkdirSync(TMP, { recursive: true });
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(TMP, `store-${Math.random().toString(36).slice(2)}`),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [],
      ...(quiet ? { messageQuietPeriod: quiet } : {}),
    });
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => { traces.push(e); });
    framework.start();
    return { framework, membrane, internals, traces };
  }
  /** The bursts the quiet period released, in order: which channel each
   *  turn started for. (Where the reply lands is checked through real
   *  ingress in message-quiet-period-e2e.test.ts: these requests name
   *  channels no registry knows, so the turn resolves no locus here.) */
  const released = (traces: TraceEvent[]): string[] =>
    traces.flatMap((e) => (e.type === 'quiet-period:released' ? [e.burst] : []));
  const key = (channelId: string) => quietBurstKey(message(0, { channelId, channelServerId: 'discord' }));
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

  it('a burst of message wakes starts one turn, once the burst is quiet', async () => {
    const { framework, membrane, internals } = await start({ quietMs: 600 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'one turn' }]));
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
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'now' }]));
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
    const { framework, membrane, internals } = await start({ quietMs: 600, maxWaitMs: 900 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'capped' }]));
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
    } finally {
      await framework.stop();
    }
  });

  it('holds are per channel: chatter in one channel does not delay another\'s turn (R1-1)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 600 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'dm reply' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'salon reply' }]));
    try {
      const t0 = Date.now();
      wake(internals, { channelId: 'discord:dm:42', channelServerId: 'discord', addressed: true });
      // The salon chatters every 150 ms for 2.4 s: its burst is never quiet.
      const chatter = setInterval(() => wake(internals, { channelId: 'discord:g:salon', channelServerId: 'discord', ambient: true }), 150);
      try {
        await waitFor(() => membrane.calls.length >= 1, 'the DM\'s turn', 3_000);
        const dmAt = Date.now() - t0;
        assert.ok(dmAt >= 550 && dmAt < 1_500, `the DM started on its own clock, at +${dmAt} ms`);
        assert.deepEqual(released(traces), [key('discord:dm:42')], 'and it was the DM\'s burst');
      } finally {
        clearInterval(chatter);
      }
      await waitFor(() => membrane.calls.length >= 2, 'the salon\'s turn', 3_000);
      assert.deepEqual(released(traces), [key('discord:dm:42'), key('discord:g:salon')], 'the salon got a turn of its own');
      await sleep(400);
      assert.equal(membrane.calls.length, 2, 'one turn per burst');
    } finally {
      await framework.stop();
    }
  });

  it('two channels that both wake the agent each get a turn of their own, oldest burst first (R1-1)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 400 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'to room' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'to general' }]));
    try {
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord', ambient: true });
      await sleep(200);
      wake(internals, { channelId: 'discord:g:general', channelServerId: 'discord', ambient: true });
      await waitFor(() => membrane.calls.length >= 2, 'two turns', 4_000);
      assert.deepEqual(released(traces), [key('discord:g:room'), key('discord:g:general')], 'one turn per burst, oldest first');
      await sleep(300);
      assert.equal(membrane.calls.length, 2);
    } finally {
      await framework.stop();
    }
  });

  it('a held burst is traced when its hold begins and when it starts (R1-4)', async () => {
    const { framework, membrane, internals, traces } = await start({ quietMs: 300 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    try {
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await sleep(100);
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await waitFor(() => membrane.calls.length >= 1, 'the turn', 3_000);
      const held = traces.filter((e) => e.type === 'quiet-period:held');
      const released = traces.filter((e) => e.type === 'quiet-period:released');
      assert.equal(held.length, 1, 'one hold trace per burst, however many passes hold it');
      assert.equal(released.length, 1);
      assert.equal(held[0].type === 'quiet-period:held' && held[0].burst, released[0].type === 'quiet-period:released' && released[0].burst);
      assert.ok(released[0].type === 'quiet-period:released' && released[0].wakes === 2 && released[0].heldMs >= 300);
      // A second burst after the first is traced anew: the flag does not stick.
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
      wake(internals, { channelId: 'discord:g:room', channelServerId: 'discord' });
      await waitFor(() => membrane.calls.length >= 2, 'the second turn', 3_000);
      assert.equal(traces.filter((e) => e.type === 'quiet-period:held').length, 2);
    } finally {
      await framework.stop();
    }
  });

  it('a wake that is no message starts the held turn now', async () => {
    const { framework, membrane, internals } = await start({ quietMs: 2_000 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'now' }]));
    try {
      const t0 = Date.now();
      wake(internals);
      await sleep(100);
      wake(internals, { reason: 'operator', source: 'api', addressed: true });
      await waitFor(() => membrane.calls.length >= 1, 'the turn', 3_000);
      assert.ok(Date.now() - t0 < 1_000, 'the operator wake ended the hold');
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
