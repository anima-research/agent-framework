/**
 * A sleep's wake: EventGate's sleep timer and dispose().
 *
 * Contract:
 *   - dispose() keeps the sleep (until, note, agent) and clears its timer, so
 *     nothing fires into a stopped framework and nothing holds the process.
 *     From then on nothing arms a sleep's or a self-wake's timer, though a
 *     turn a failed stop() left running can still ask.
 *   - The wake comes at the sleep's end by the gate's own clock: a sleep
 *     longer than one timer holds waits in steps, and a timer that fires
 *     before the end waits out the rest.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { EventGate } from '../src/gate/event-gate.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { gateToolCalls } from './helpers/gate-tool-calls.js';
import { forceExpiry } from './helpers/force-expiry.js';
import type { ChannelRef } from '../src/mcpl/channel-registry.js';
import { fixture, eventually, TS, ok } from './helpers/coalescing-fixture.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-sleep');

/** A framework whose agent forks a conversation for each message on the open
 *  channel `channelId`, with a gate; `incoming` sends that channel a message. */
async function forkFixture(channelId: string, options: { agents?: unknown[]; idleTtlMs?: number } = {}) {
  const f = await fixture({
    ...(options.agents ? { agents: options.agents } : {}),
    framework: {
      gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, `gate-${channelId.replace(/\W/g, '-')}.json`) },
      conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' }, ...(options.idleTtlMs ? { idleTtlMs: options.idleTtlMs } : {}) },
    } as never,
  });
  const gate = (f.framework as unknown as { eventGate: EventGate }).eventGate;
  const incoming = (messageId: string) => f.send('channels/incoming', {
    messages: [{ channelId, messageId, timestamp: TS, author: { id: 'U1', name: 'antra' }, tags: ['chat:from-human'], content: [{ type: 'text', text: 'hello' }] }],
  });
  try {
    await f.send('channels/register', { channels: [{ id: channelId, type: 'discord', label: channelId.split(':').pop(), initiallyOpen: true, metadata: { channelType: 'guild_text' } }] });
    await eventually(() => (f.framework as unknown as { channelRegistry: { getDesiredState(s: string, c: string): string | undefined } }).channelRegistry.getDesiredState('editor', channelId) === 'open', 'the channel is open');
  } catch (err) {
    await f.close();
    throw err;
  }
  return { f, gate, incoming };
}

function makeGate(now?: () => number) {
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string }> = [];
  const traces: string[] = [];
  const gate = new EventGate({
    now,
    configPath: join(TMP_DIR, 'gate.json'),
    initialConfig: { policies: [], default: 'always' },
    emitTrace: (e) => { if (typeof e.eventType === 'string') traces.push(e.eventType); },
    addMessage: () => '',
    requestInference: (a, r, s) => inferenceRequests.push({ agentName: a, reason: r, source: s }),
    getAgentNames: () => ['agent'],
  });
  return { gate, inferenceRequests, traces };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/** stop(), failing with why if the sleep's wake had already fired when
 *  stop() disposed the gate: a sleep that ends during stop()'s own teardown,
 *  before the gate is disposed, fires by design, so the test couldn't check
 *  a sleep kept through a stop. It reads the gate's own state at dispose(),
 *  which a wake that fired has cleared. */
async function stopDisposingBefore(framework: AgentFramework, gate: EventGate): Promise<void> {
  const dispose = gate.dispose.bind(gate);
  let keptAtDispose: boolean | undefined;
  gate.dispose = () => { keptAtDispose ??= gate.inferenceDiagnostics().sleepUntil > 0; dispose(); };
  await framework.stop();
  assert.ok(keptAtDispose === true,
    `${keptAtDispose === undefined ? 'stop() never disposed the gate' : "the sleep's wake fired before stop() disposed the gate"}, so the sleep ended during its teardown, which fires by design: this run can't check a sleep kept through a stop`);
}

describe("EventGate sleep: its wake, a stop and a fork's end", () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  it('dispose() keeps the sleep and lets nothing fire', async () => {
    const { gate, inferenceRequests, traces } = makeGate();
    const before = timeouts();
    // The first sleep is short too: if setting a sleep again stopped
    // replacing its timer, the first sleep's timer would hold this file's
    // process until it fired.
    gate.setSleep(2, 'resting', 'agent');
    gate.setSleep(0.2, 'resting', 'agent');
    assert.strictEqual(timeouts(), before + 1, 'a sleep set again replaces its timer');
    gate.dispose();
    assert.strictEqual(timeouts(), before, 'dispose() leaves no timer to hold the process');
    await wait(400);
    assert.deepStrictEqual(inferenceRequests, [], 'no wake after dispose()');
    assert.ok(!traces.includes('sleep:expired'), 'no expiry after dispose()');
    assert.ok(gate.inferenceDiagnostics().sleepUntil > 0, 'the sleep is kept');
  });

  it('a sleep longer than one timer holds keeps its wake armed', async () => {
    // setTimeout holds at most 2^31-1 ms, about 24.8 days, and fires a longer
    // delay after 1 ms.
    const { gate, inferenceRequests } = makeGate();
    const timer = () => (gate as unknown as { sleepTimer: unknown }).sleepTimer;
    try {
      gate.setSleep(30 * 24 * 3600, 'resting', 'agent');
      const first = timer();
      await wait(50);
      assert.ok(first !== null && timer() === first,
        "one timer still waits for the sleep's end: a step one timer holds, not one that fires at once and is armed again");
      assert.deepStrictEqual(inferenceRequests, []);
    } finally {
      gate.clearSleep();
    }
  });

  // This test runs on node:test's mock timers and Date, so its verdict
  // follows the clock it sets, not the host's scheduling. The tests that
  // count a timer read it without waiting.
  it("a sleep's wake follows the gate's own clock, and waits out a clock set back", (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    // The gate's clock runs ten days ahead of the wall clock, and is set back
    // a second once the sleep is set, so the 100 ms timer fires 900 ms before
    // the sleep's end by the gate's clock, and the rest falls due at 1,100 ms.
    let offset = 10 * 24 * 3600 * 1000;
    const { gate, inferenceRequests } = makeGate(() => Date.now() + offset);
    try {
      gate.setSleep(0.1, 'resting', 'agent');
      offset -= 1_000;
      t.mock.timers.tick(100);
      t.mock.timers.tick(999);
      assert.deepStrictEqual(inferenceRequests, [], "not before the sleep's end by the gate's clock");
      t.mock.timers.tick(1);
      assert.deepStrictEqual(inferenceRequests, [{ agentName: 'agent', reason: 'sleep-expired: resting', source: 'sleep' }]);
    } finally {
      gate.clearSleep();
    }
  });

  it("agentGone() cancels that agent's self-wake, and leaves another agent's", () => {
    const { gate } = makeGate();
    const selfWakes = (gate as unknown as { selfWakeTimers: Map<string, unknown> }).selfWakeTimers;
    const before = timeouts();
    try {
      gate.armSelfWake('fork', 60);
      gate.armSelfWake('agent', 60);
      gate.agentGone('fork');
      assert.ok(!selfWakes.has('fork'), "the gone agent's self-wake goes, entry and all");
      assert.ok(selfWakes.has('agent'), "another agent's self-wake stays");
      assert.strictEqual(timeouts(), before + 1, "and only that one's timer is left");
    } finally {
      gate.dispose();
    }
  });

  it('after dispose(), a sleep set again arms no timer', () => {
    const { gate } = makeGate();
    const before = timeouts();
    try {
      gate.dispose();
      gate.setSleep(60, 'resting', 'agent');
      assert.strictEqual(timeouts(), before, 'no timer while disposed');
      assert.ok(gate.inferenceDiagnostics().sleepUntil > 0, 'the sleep is kept');
    } finally {
      gate.clearSleep();
    }
  });

  it('after dispose(), a self-wake arms no timer', () => {
    const { gate } = makeGate();
    const before = timeouts();
    try {
      gate.dispose();
      assert.strictEqual(gate.armSelfWake('agent', 60).armed, false, 'it says it armed nothing');
      assert.strictEqual(timeouts(), before, 'no timer while disposed');
    } finally {
      gate.dispose();
    }
  });

  it("an ephemeral run's sleep and wake are refused, and its end tells the gate", async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'w1', name: 'wake', input: {} }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    const framework = await AgentFramework.create({
      storePath: join(TMP_DIR, 'store-ephemeral'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, 'gate-ephemeral.json') },
      modules: [],
    });
    const gate = (framework as unknown as { eventGate: EventGate }).eventGate;
    const selfWakes = (gate as unknown as { selfWakeTimers: Map<string, unknown> }).selfWakeTimers;
    const calls = gateToolCalls(framework);
    try {
      framework.start();
      // The primary sleeps, so a run's sleep would replace its note and a
      // run's wake would end it.
      gate.setSleep(3600, 'resting', 'agent');
      const created = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Work.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      let armed: boolean | undefined;
      framework.onTrace((event) => {
        const traced = event as { type?: string; processEvent?: { type?: string; toolName?: string } };
        if (armed === undefined && traced.type === 'process:received' && traced.processEvent?.type === 'tool-result'
          && traced.processEvent.toolName === 'sleep') armed = gate.armSelfWake('worker', 60).armed;
      });
      await framework.runEphemeralToCompletion(created.agent, created.contextManager);
      assert.strictEqual(armed, true, 'the run left a self-wake pending');
      assert.deepStrictEqual(calls.refused, [
        'sleep: Nothing was set: a sleep quiets the whole agent, not one run.',
        "wake: Nothing was changed: a sleep is the agent's, so this run can't end one.",
      ]);
      assert.deepStrictEqual(calls.started, [], 'refused before the tools run');
      assert.strictEqual(gate.getSleepState()?.note, 'resting', "the primary's sleep stands, neither replaced nor ended");
      assert.ok(!selfWakes.has('worker'), "the run's end cancelled the self-wake it left pending");
    } finally {
      // So that a run where the sleep takes doesn't hold the file's process
      // for its hour.
      gate.clearSleep();
      await framework.stop();
    }
  });

  it("the primary's sleep still silences a message to its conversation fork", async () => {
    // The gate decides a channel message's wake before it's routed to a fork,
    // so the primary's sleep quiets every conversation of the agent.
    const CH = 'discord:g1:dm';
    const { f, gate, incoming } = await forkFixture(CH);
    const router = () => (f.framework as unknown as { getConversationRouter(): { getBinding(channel: ChannelRef): { agentName: string } | undefined } }).getConversationRouter();
    try {
      gate.setSleep(3600, 'resting', 'agent');
      const before = f.membrane.calls.length;
      await incoming('m1');
      await f.framework.runUntilIdle();
      assert.ok(router().getBinding({ serverId: 'editor', channelId: CH }) !== undefined, 'the message reached a conversation fork');
      assert.strictEqual(f.membrane.calls.length, before, 'no turn while the primary sleeps');
      assert.ok((gate.getSleepState()?.suppressed ?? 0) >= 1, 'the gate held its wake');

      // Control: awake, the next message wakes the fork.
      gate.clearSleep();
      f.membrane.pushResponse(ok());
      await incoming('m2');
      await f.framework.runUntilIdle();
      assert.strictEqual(f.membrane.calls.length, before + 1, 'the fork took a turn');
    } finally {
      gate.clearSleep();
      await f.close();
    }
  });

  for (const [what, allowedTools, remedy] of [
    ['can call skip_reply is told its wake_in_seconds is the way back', 'all', ' To come back to this conversation later, call skip_reply with wake_in_seconds.'],
    ["can't call skip_reply isn't pointed at it", ['sleep', 'wake'], ''],
  ] as const) it(`a fork that ${what}, when its sleep is refused`, async () => {
    const CH = 'discord:g1:dm2';
    const { f, gate, incoming } = await forkFixture(CH, { agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', allowedTools }] });
    const calls = gateToolCalls(f.framework);
    try {
      await incoming('m1'); // the fork's first turn answers with the fixture's 'ok'
      await f.framework.runUntilIdle();
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
      f.membrane.pushResponse(ok());
      await incoming('m2');
      await f.framework.runUntilIdle();
      assert.deepStrictEqual(calls.refused, [`sleep: Nothing was set: a sleep quiets the whole agent, not one conversation.${remedy}`]);
    } finally {
      gate.clearSleep();
      await f.close();
    }
  });

  it("a closing fork isn't pointed at skip_reply when its sleep is refused, since its self-wake would end with it", async () => {
    const CH = 'discord:g1:dm3';
    const IDLE_TTL_MS = 60_000;
    const { f, gate, incoming } = await forkFixture(CH, { idleTtlMs: IDLE_TTL_MS });
    const calls = gateToolCalls(f.framework);
    try {
      await incoming('m1');
      await f.framework.runUntilIdle(); // the fork's first turn answers with the fixture's 'ok'
      forceExpiry(f.framework, { serverId: 'editor', channelId: CH }, IDLE_TTL_MS); // idle past the TTL, and the sweep due
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
      f.membrane.pushResponse(ok());
      f.framework.pushEvent({ type: 'external-message', source: 'test', content: 'tick', metadata: {} } as never);
      await f.framework.runUntilIdle();
      assert.deepStrictEqual(calls.refused, ['sleep: Nothing was set: a sleep quiets the whole agent, not one conversation.'], 'its closure turn is told no way back');
    } finally {
      gate.clearSleep();
      await f.close();
    }
  });

  it('a framework stopped while its agent sleeps wakes nothing once stopped', async () => {
    const store = JsStore.openOrCreate({ path: join(TMP_DIR, 'store') });
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'awake' }]));
    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, 'gate-stopped.json') },
      modules: [],
    });
    const internals = framework as unknown as {
      eventGate: EventGate;
      pendingRequests: Array<{ source: string }>;
    };
    const expiries: string[] = [];
    framework.onTrace((e) => {
      if ((e as { eventType?: unknown }).eventType === 'sleep:expired') expiries.push('sleep:expired');
    });
    try {
      framework.start();
      // Long enough for stop() to dispose the gate first even on a loaded
      // host: a sleep that ends during stop()'s own teardown still fires.
      internals.eventGate.setSleep(1, 'resting', 'agent');
      await stopDisposingBefore(framework, internals.eventGate);
      await wait(1_500);
      assert.deepStrictEqual(expiries, [], 'nothing expires while stopped');
      assert.ok(!internals.pendingRequests.some((r) => r.source === 'sleep'), 'no wake is queued while stopped');
      assert.strictEqual(membrane.calls.length, 0, 'the agent was not woken');
    } finally {
      await framework.stop();
      store.close();
    }
  });
});
