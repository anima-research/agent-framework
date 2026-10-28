/**
 * FrameworkConfig.messageQuietPeriod: an idle agent's turn waits while
 * message wakes for it keep arriving, and starts once with everything queued.
 *
 * The hold lives where the scheduler starts a turn (runInferencePass), not in
 * the gate: each message keeps the decision the gate gave it, so who wakes a
 * sleeping agent, where a reply goes, and what tune-out and conversation
 * routing see are as on `main` (#856's review). What the hold decides is
 * `quietHoldRemaining`, pinned here on fixed clocks; the scheduler's use of it
 * runs against a real framework with wide margins.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, quietHoldRemaining } from '../src/index.js';
import type { InferenceRequest } from '../src/types/agent.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const TMP = join(import.meta.dirname, '../.test-tmp-quiet-period');
const T0 = 1_000_000;
const QUIET = { quietMs: 2_000, maxWaitMs: 10_000 };

const message = (at: number, extra: Partial<InferenceRequest> = {}): InferenceRequest => ({
  agentName: 'agent', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: at, ...extra,
});

describe('quietHoldRemaining', () => {
  it('is 0 with the option off, or with nothing queued', () => {
    assert.equal(quietHoldRemaining([message(T0)], T0 + 100, undefined), 0);
    assert.equal(quietHoldRemaining([], T0, QUIET), 0);
    assert.equal(quietHoldRemaining([message(T0)], T0 + 100, { quietMs: 0, maxWaitMs: 10_000 }), 0);
  });

  it('holds a burst for quietMs after its newest message wake', () => {
    const burst = [message(T0), message(T0 + 500), message(T0 + 900)];
    assert.equal(quietHoldRemaining(burst, T0 + 1_000, QUIET), 1_900, 'quietMs counted from the newest');
    assert.equal(quietHoldRemaining(burst, T0 + 2_899, QUIET), 1);
    assert.equal(quietHoldRemaining(burst, T0 + 2_900, QUIET), 0, 'quiet: the turn starts');
  });

  it('ends the hold maxWaitMs after the oldest message wake, however the burst goes on', () => {
    const stream = [message(T0), message(T0 + 9_000), message(T0 + 9_900)];
    assert.equal(quietHoldRemaining(stream, T0 + 9_950, QUIET), 50, 'the cap, not quietMs, is what is left');
    assert.equal(quietHoldRemaining(stream, T0 + 10_000, QUIET), 0);
  });

  it('a maxWaitMs below quietMs is the cap', () => {
    assert.equal(quietHoldRemaining([message(T0)], T0 + 100, { quietMs: 2_000, maxWaitMs: 300 }), 200);
  });

  it('a server event is a message wake; the heartbeat is not', () => {
    const push = message(T0, { reason: 'mcpl:push-event', source: 'tsm' });
    assert.equal(quietHoldRemaining([push], T0 + 100, QUIET), 1_900);
    const tick = message(T0, { reason: 'mcpl:push-event', source: 'heartbeat' });
    assert.equal(quietHoldRemaining([tick], T0 + 100, QUIET), 0);
    assert.equal(quietHoldRemaining([message(T0), tick], T0 + 100, QUIET), 0, 'a tick in the batch starts it');
  });

  it('any other wake in the batch starts the turn now', () => {
    for (const other of [
      message(T0, { reason: 'self-wake', source: 'gate' }),
      message(T0, { reason: 'external-message', source: 'api' }),
      message(T0, { reason: 'operator', source: 'api', addressed: true }),
      message(T0, { reason: 'gate:debounce', source: 'gate' }),
    ]) {
      assert.equal(quietHoldRemaining([message(T0), other], T0 + 100, QUIET), 0, other.reason);
    }
  });

  it('a continuation or a retry of the turn is not held', () => {
    const restart = message(T0, { reason: 'context_budget_restart', source: 'framework' });
    assert.equal(quietHoldRemaining([restart], T0 + 100, QUIET), 0);
    const guard = message(T0, { reason: 'tool_result_guard_retry', source: 'framework' });
    assert.equal(quietHoldRemaining([guard], T0 + 100, QUIET), 0);
    const auto = message(T0, { autoContinueRun: { stop: 'call skip_reply' } });
    assert.equal(quietHoldRemaining([auto], T0 + 100, QUIET), 0);
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
    framework.start();
    return { framework, membrane, internals };
  }
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

  it('a stream that never goes quiet starts a turn at maxWaitMs', async () => {
    const { framework, membrane, internals } = await start({ quietMs: 600, maxWaitMs: 900 });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'capped' }]));
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 1_500 && membrane.calls.length === 0) {
        wake(internals);
        await sleep(150);
      }
      assert.ok(membrane.calls.length >= 1, 'the cap started the turn');
      assert.ok(Date.now() - t0 < 1_500, 'before the stream ended');
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

  it('refuses a quiet period that is not finite numbers of ms', async () => {
    mkdirSync(TMP, { recursive: true });
    for (const bad of [{ quietMs: Number.NaN }, { quietMs: -1 }, { quietMs: 10, maxWaitMs: 'soon' }, 'later', { maxWaitMs: 5 }]) {
      await assert.rejects(
        AgentFramework.create({
          storePath: join(TMP, `store-bad-${Math.random().toString(36).slice(2)}`),
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
          modules: [],
          messageQuietPeriod: bad as unknown as { quietMs: number },
        }),
        /messageQuietPeriod must be/,
        JSON.stringify(bad),
      );
    }
  });
});
