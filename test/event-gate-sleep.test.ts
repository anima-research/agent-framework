/**
 * A sleep's wake: EventGate's sleep timer, dispose() and resumeSleep().
 *
 * Contract:
 *   - dispose() keeps the sleep (until, note, agent) and clears its timer, so
 *     nothing fires into a stopped framework and nothing holds the process.
 *     Until the next resumeSleep(), nothing arms a sleep's or a self-wake's
 *     timer, though a turn a failed stop() left running can still ask.
 *   - resumeSleep(), which the framework's start() calls before its loop's
 *     first pass, arms the wake again for a sleep still ahead, and wakes at
 *     once for one that ended while stopped: that wake is the one the agent
 *     asked for.
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
import { goneNames } from './helpers/gone-names.js';
import { fixture, eventually, TS, ok } from './helpers/coalescing-fixture.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-sleep');

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
    assert.ok(gate.inferenceDiagnostics().sleepUntil > 0, 'the sleep is kept for the next start');
  });

  // This test, the next, and the gate's-clock test run on node:test's mock
  // timers and Date, so their verdicts follow the clock they set, not the
  // host's scheduling. The tests that count a timer read it without waiting.
  it('resumeSleep() wakes once at the end of a sleep still ahead', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { gate, inferenceRequests } = makeGate();
    gate.setSleep(0.4, 'resting', 'agent');
    gate.dispose();
    t.mock.timers.tick(150);
    gate.resumeSleep();
    t.mock.timers.tick(249);
    assert.strictEqual(inferenceRequests.length, 0, 'not before the sleep ends');
    t.mock.timers.tick(1);
    assert.deepStrictEqual(inferenceRequests, [{ agentName: 'agent', reason: 'sleep-expired: resting', source: 'sleep' }]);
    gate.resumeSleep();
    t.mock.timers.tick(1_000);
    assert.strictEqual(inferenceRequests.length, 1, 'with the sleep over, resumeSleep() does nothing');
    gate.dispose();
  });

  it('resumeSleep() wakes at once for a sleep that ended while disposed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { gate, inferenceRequests } = makeGate();
    gate.setSleep(0.1, 'resting', 'agent');
    gate.dispose();
    t.mock.timers.tick(250);
    assert.strictEqual(inferenceRequests.length, 0, 'nothing while disposed');
    gate.resumeSleep();
    assert.deepStrictEqual(inferenceRequests, [{ agentName: 'agent', reason: 'sleep-expired: resting', source: 'sleep' }]);
    assert.strictEqual(gate.inferenceDiagnostics().sleepUntil, 0);
    gate.dispose();
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

  it('resumeSleep() for a sleep already over cancels the timer still armed for it', () => {
    let offset = 0;
    const { gate, inferenceRequests } = makeGate(() => Date.now() + offset);
    const before = timeouts();
    try {
      gate.setSleep(60, 'resting', 'agent');
      // The gate's clock passes the sleep's end before its timer fires.
      offset += 120_000;
      gate.resumeSleep();
      assert.deepStrictEqual(inferenceRequests, [{ agentName: 'agent', reason: 'sleep-expired: resting', source: 'sleep' }], 'it wakes the agent once');
      assert.strictEqual(timeouts(), before, 'and leaves no timer armed');
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

  it('after dispose(), a sleep set again arms no timer until resumeSleep()', () => {
    const { gate } = makeGate();
    const before = timeouts();
    try {
      gate.dispose();
      gate.setSleep(60, 'resting', 'agent');
      assert.strictEqual(timeouts(), before, 'no timer while disposed');
      assert.ok(gate.inferenceDiagnostics().sleepUntil > 0, 'the sleep is kept for the next start');
      gate.resumeSleep();
      assert.strictEqual(timeouts(), before + 1, 'resumeSleep() arms it');
    } finally {
      gate.clearSleep();
    }
  });

  it('after dispose(), a self-wake arms no timer, and one asked for after resumeSleep() does', () => {
    const { gate } = makeGate();
    const before = timeouts();
    try {
      gate.dispose();
      assert.strictEqual(gate.armSelfWake('agent', 60).armed, false, 'it says it armed nothing');
      assert.strictEqual(timeouts(), before, 'no timer while disposed');
      gate.resumeSleep();
      assert.strictEqual(gate.armSelfWake('agent', 60).armed, true);
      assert.strictEqual(timeouts(), before + 1, 'armed once resumed');
    } finally {
      gate.dispose();
    }
  });

  it("an ephemeral run's sleep is refused, and its end tells the gate", async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    const framework = await AgentFramework.create({
      storePath: join(TMP_DIR, 'store-ephemeral'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, 'gate-ephemeral.json') },
      modules: [],
    });
    const gate = (framework as unknown as { eventGate: EventGate }).eventGate;
    const gone = goneNames(gate);
    const slept: string[] = [];
    const refusals: string[] = [];
    framework.onTrace((e) => {
      const traced = e as { type?: string; eventType?: unknown; module?: string; tool?: string; error?: string };
      if (traced.eventType === 'sleep:set') slept.push('sleep:set');
      if (traced.type === 'tool:failed' && traced.module === 'gate') refusals.push(`${traced.tool}: ${traced.error}`);
    });
    try {
      framework.start();
      const created = await framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Work.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      await framework.runEphemeralToCompletion(created.agent, created.contextManager);
      assert.deepStrictEqual(refusals, ['sleep: worker: Nothing was set: a sleep quiets the whole agent, not one run.']);
      assert.deepStrictEqual(slept, [], 'nothing slept');
      assert.strictEqual(gate.getSleepState(), null);
      assert.deepStrictEqual(gone, ['worker'], "the run's end told the gate, which cancels its self-wake");
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
    const f = await fixture({ framework: {
      gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, 'gate-fork.json') },
      conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } },
    } as never });
    const gate = (f.framework as unknown as { eventGate: EventGate }).eventGate;
    const router = () => (f.framework as unknown as { getConversationRouter(): { getBinding(id: string): { agentName: string } | undefined } }).getConversationRouter();
    const incoming = (messageId: string) => f.send('channels/incoming', {
      messages: [{ channelId: CH, messageId, timestamp: TS, author: { id: 'U1', name: 'antra' }, tags: ['chat:from-human'], content: [{ type: 'text', text: 'hello' }] }],
    });
    try {
      await f.send('channels/register', { channels: [{ id: CH, type: 'discord', label: 'dm', initiallyOpen: true, metadata: { channelType: 'guild_text' } }] });
      await eventually(() => (f.framework as unknown as { channelRegistry: { getDesiredState(s: string, c: string): string | undefined } }).channelRegistry.getDesiredState('editor', CH) === 'open', 'the channel is open');
      gate.setSleep(3600, 'resting', 'agent');
      const before = f.membrane.calls.length;
      await incoming('m1');
      await f.framework.runUntilIdle();
      assert.ok(router().getBinding(CH) !== undefined, 'the message reached a conversation fork');
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
    const f = await fixture({
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test', allowedTools }],
      framework: {
        gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, 'gate-fork-remedy.json') },
        conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } },
      } as never,
    });
    const refusals: string[] = [];
    f.framework.onTrace((e) => {
      const failed = e as { type?: string; module?: string; tool?: string; error?: string };
      if (failed.type === 'tool:failed' && failed.module === 'gate') refusals.push(`${failed.tool}: ${failed.error}`);
    });
    const incoming = (messageId: string) => f.send('channels/incoming', {
      messages: [{ channelId: CH, messageId, timestamp: TS, author: { id: 'U1', name: 'antra' }, tags: ['chat:from-human'], content: [{ type: 'text', text: 'hello' }] }],
    });
    try {
      await f.send('channels/register', { channels: [{ id: CH, type: 'discord', label: 'dm2', initiallyOpen: true, metadata: { channelType: 'guild_text' } }] });
      await eventually(() => (f.framework as unknown as { channelRegistry: { getDesiredState(s: string, c: string): string | undefined } }).channelRegistry.getDesiredState('editor', CH) === 'open', 'the channel is open');
      await incoming('m1'); // the fork's first turn answers with the fixture's 'ok'
      await f.framework.runUntilIdle();
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 's1', name: 'sleep', input: { seconds: 3600, announce: false } }], 'tool_use'));
      f.membrane.pushResponse(ok());
      await incoming('m2');
      await f.framework.runUntilIdle();
      assert.strictEqual(refusals.length, 1, `one refusal: ${JSON.stringify(refusals)}`);
      assert.ok(refusals[0]!.endsWith(`: Nothing was set: a sleep quiets the whole agent, not one conversation.${remedy}`), refusals[0]);
    } finally {
      (f.framework as unknown as { eventGate: EventGate }).eventGate.clearSleep();
      await f.close();
    }
  });

  it("a framework stopped while its agent sleeps wakes nothing until it's started again, then wakes the agent", async () => {
    // A store the caller owns: an owned store closes at stop(), and a start()
    // after that is refused.
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
      framework.start();
      const deadline = Date.now() + 3_000;
      while (membrane.calls.length === 0 && Date.now() < deadline) await wait(25);
      assert.strictEqual(membrane.calls.length, 1, 'the start wakes the agent once');
      assert.deepStrictEqual(expiries, ['sleep:expired']);
    } finally {
      await framework.stop();
      store.close();
    }
  });

  it('a sleep that ended while stopped wakes the agent in one turn with a request already pending at start', async () => {
    const store = JsStore.openOrCreate({ path: join(TMP_DIR, 'store') });
    const membrane = new MockMembrane();
    for (let i = 0; i < 2; i++) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'awake' }]));
    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      gate: { config: { policies: [], default: 'always' }, configPath: join(TMP_DIR, 'gate-one-turn.json') },
      modules: [],
    });
    const internals = framework as unknown as { eventGate: EventGate; pendingRequests: unknown[] };
    const gate = internals.eventGate;
    const expiries: string[] = [];
    framework.onTrace((e) => {
      if ((e as { eventType?: unknown }).eventType === 'sleep:expired') expiries.push('sleep:expired');
    });
    try {
      framework.start();
      // As above: the sleep ends after stop() has disposed the gate, so its
      // wake is owed at start rather than queued during the teardown.
      gate.setSleep(1, 'resting', 'agent');
      await stopDisposingBefore(framework, gate);
      await wait(1_500);
      assert.strictEqual(framework.nudgeAgent('agent', 'test').ok, true);
      framework.start();
      // The loop's first pass takes every pending request at once: the owed
      // wake joined the nudge if nothing is left for a second turn.
      assert.deepStrictEqual(expiries, ['sleep:expired'], 'the start owed the sleep its wake');
      assert.deepStrictEqual(internals.pendingRequests, [], 'and the first pass took it with the nudge');
      const deadline = Date.now() + 3_000;
      while (membrane.calls.length === 0 && Date.now() < deadline) await wait(25);
      await wait(600);
      assert.strictEqual(membrane.calls.length, 1, 'one turn, and no second one after it');
    } finally {
      await framework.stop();
      store.close();
    }
  });
});
