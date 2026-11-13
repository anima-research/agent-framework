/**
 * The framework's wiring of the gate's wake journal (event-gate-wake-journal
 * .test.ts has the gate's own semantics):
 *   - create() restores the journal, so a sleep suppresses before input
 *     flows, and start() admits it: the overdue wakes are served once the
 *     loop runs, not before (a stop() between create() and start() keeps
 *     them);
 *   - a quiesced boot serves nothing; resume() serves each wake once, and a
 *     resume() that threw and is retried still admits;
 *   - a wake falling due while stop() is held open stays in the journal;
 *   - an overdue wake is served ahead of a request queued before start();
 *   - a resume() before start() admits nothing, and a throw out of
 *     admission leaves start() whole;
 *   - the receipts: a `sleep`, a `wake` and a `skip_reply` whose journal
 *     write failed say so.
 * Each of these is one line in framework.ts that a merge can lose with CI
 * green, so each has a test here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, type ProcessEvent } from '../src/index.js';
import type { EventGate } from '../src/gate/event-gate.js';
import type { ChannelToolOrigin } from '../src/mcpl/channel-registry.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type Journal = { sleep?: { agentName?: string; wakeAt: number }; selfWakes: Array<{ agentName: string; wakeAt: number }> };

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A wake's turn needs an answer: one per turn the test expects (the mock
 *  stream takes the queued answers as they come). The tests read the gate's
 *  state and the journal, which admission writes before any turn runs, so
 *  none waits for the turn to end. */
function answers(membrane: MockMembrane, n: number): void {
  for (let i = 0; i < n; i++) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'awake' }]));
}

type Internals = {
  eventGate: EventGate;
  pendingRequests: unknown[];
  persistHostMode: (record: unknown) => void;
  channelRegistry: unknown;
  startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
};
const internals = (framework: AgentFramework): Internals => framework as unknown as Internals;

/** A store and a gate config path that frameworks share across restarts. */
function fixture(agents: string[] = ['agent']) {
  const dir = mkdtempSync(join(tmpdir(), 'framework-wake-journal-'));
  const storePath = join(dir, 'store');
  const configPath = join(dir, 'gate.json');
  const journalPath = join(dir, 'gate.wake-intents.json');
  const journal = (): Journal => JSON.parse(readFileSync(journalPath, 'utf8'));
  const create = async (membrane: MockMembrane, extras: Record<string, unknown> = {}, agentNames: string[] = agents) => AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: agentNames.map((name) => ({ name, model: 'test-model', systemPrompt: 'test' })),
    modules: [],
    gate: { config: { policies: [], default: 'always' }, configPath },
    ...extras,
  });
  return { dir, storePath, configPath, journalPath, journal, create, close: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A sleep and a self-wake set in one framework, which is then stopped.
 *  A self-wake is at least 1 s (armSelfWake clamps), so an "overdue" test
 *  waits 1.2 s after the stop. */
async function setAndStop(fx: ReturnType<typeof fixture>, seconds: number, agent = 'agent'): Promise<void> {
  const membrane = new MockMembrane();
  const framework = await fx.create(membrane);
  framework.start();
  const slept = await framework.executeToolCall({ id: 's1', name: 'sleep', input: { seconds, announce: false }, callerAgentName: agent });
  assert.equal(slept.success, true, JSON.stringify(slept));
  const armed = internals(framework).eventGate.armSelfWake(agent, seconds, 'skip_reply');
  assert.equal(armed.armed, true);
  assert.equal(armed.durable, true);
  await framework.stop();
  const written = fx.journal();
  assert.equal(written.sleep?.agentName, agent);
  assert.deepEqual(written.selfWakes.map((w) => w.agentName), [agent]);
}

test('a sleep and a self-wake survive a restart: restored at create(), armed at start(), and served at their time', async () => {
  const fx = fixture();
  try {
    await setAndStop(fx, 60);
    const membrane = new MockMembrane();
    const framework = await fx.create(membrane);
    try {
      const gate = internals(framework).eventGate;
      assert.ok(gate.getSleepState(), 'the sleep suppresses from create() on');
      // upcomingWakes shows a self-wake only while its timer is armed, and
      // the sleep's end whenever a sleep is set.
      assert.deepEqual(gate.upcomingWakes(['agent']).map((w) => w.kind), ['sleep-end'], 'no timer armed before start()');
      framework.start();
      const wakes = gate.upcomingWakes(['agent']).map((w) => w.kind).sort();
      assert.deepEqual(wakes, ['self-wake', 'sleep-end'], 'start() arms both');
      await sleepMs(150);
      assert.equal(membrane.calls.length, 0, 'neither is due yet');
      assert.deepEqual(fx.journal().selfWakes.length, 1, 'still journaled');
    } finally {
      await framework.stop();
    }
    assert.ok(fx.journal().sleep, 'a stop keeps the intents for the next start');
  } finally {
    fx.close();
  }
});

test('a sleep and a self-wake that fell due while the host was down are served by start(), once, and leave the journal', async () => {
  const fx = fixture();
  try {
    await setAndStop(fx, 0.3);
    await sleepMs(1_200);
    const membrane = new MockMembrane();
    answers(membrane, 2);
    const framework = await fx.create(membrane);
    try {
      assert.equal(internals(framework).pendingRequests.length, 0, 'create() requests no wake: nothing could serve it yet');
      assert.ok(fx.journal().sleep, 'and the journal still holds the sleep');
      assert.equal(fx.journal().selfWakes.length, 1);
      framework.start();
      // start() admitted synchronously: the sleep is over, both wakes were
      // requested, and both left the journal.
      assert.equal(internals(framework).eventGate.getSleepState(), null);
      const after = fx.journal();
      assert.equal(after.sleep, undefined, 'served, so no longer journaled');
      assert.deepEqual(after.selfWakes, []);
      await waitFor('the recovered wakes to become a turn', () => membrane.calls.length > 0);
      assert.deepEqual(internals(framework).eventGate.upcomingWakes(['agent']), [], 'nothing re-armed: served once');
    } finally {
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test('a stop() between create() and start() keeps the overdue intents for the next boot', async () => {
  // An embedder that audits between create() and start() and stops when the
  // audit fails: its next boot must still have the wakes.
  const fx = fixture();
  try {
    await setAndStop(fx, 0.2);
    await sleepMs(1_200);
    const framework = await fx.create(new MockMembrane());
    await framework.stop();
    const kept = fx.journal();
    assert.ok(kept.sleep, 'the sleep is still journaled');
    assert.equal(kept.selfWakes.length, 1, 'the self-wake is still journaled');
  } finally {
    fx.close();
  }
});

test('a quiesced boot serves nothing; resume() serves each overdue wake once, and arms the future ones', async () => {
  const fx = fixture(['agent', 'agent2']);
  try {
    await setAndStop(fx, 0.2);
    await sleepMs(1_200);
    mkdirSync(join(fx.storePath, 'recovery'), { recursive: true });
    writeFileSync(join(fx.storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: true, reason: 'test' }));
    const membrane = new MockMembrane();
    answers(membrane, 2);
    const framework = await fx.create(membrane);
    try {
      assert.equal(framework.getHostModeStatus().quiesced, true);
      framework.start();
      await sleepMs(200);
      assert.equal(membrane.calls.length, 0, 'quiesced: no wake served');
      assert.equal(internals(framework).pendingRequests.length, 0, 'and none requested');
      assert.ok(fx.journal().sleep, 'the overdue sleep waits in the journal');
      assert.equal(fx.journal().selfWakes.length, 1);
      await framework.resume();
      assert.equal(fx.journal().sleep, undefined, 'the resume served the sleep');
      assert.deepEqual(fx.journal().selfWakes, [], 'and the self-wake');
      await waitFor('the wakes to become a turn', () => membrane.calls.length > 0);
      const gate = internals(framework).eventGate;
      await framework.resume();
      assert.equal(gate.getSleepState(), null, 'a second resume has nothing to serve');
      assert.deepEqual(gate.upcomingWakes(['agent', 'agent2']), []);
    } finally {
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test('a resume() that throws after un-quiescing, then a retry, still admits the restored wakes', async () => {
  const fx = fixture(['agent', 'agent2']);
  try {
    await setAndStop(fx, 0.2);
    await sleepMs(1_200);
    mkdirSync(join(fx.storePath, 'recovery'), { recursive: true });
    writeFileSync(join(fx.storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: true }));
    const membrane = new MockMembrane();
    answers(membrane, 3);
    const framework = await fx.create(membrane);
    try {
      framework.start();
      // A self-wake for the other agent, due soon, journaled while quiesced.
      const gate = internals(framework).eventGate;
      assert.equal(gate.armSelfWake('agent2', 0.4, 'skip_reply').durable, true);
      // The record clear fails once, as on ENOSPC: the host is un-quiesced
      // in memory, and the admission after the clear never ran.
      const original = internals(framework).persistHostMode;
      let threw = false;
      internals(framework).persistHostMode = function (this: unknown, record: unknown) {
        if (!threw && record === null) { threw = true; throw new Error('ENOSPC (test)'); }
        return original.call(this, record);
      };
      await assert.rejects(framework.resume(), /ENOSPC/);
      assert.equal(framework.getHostModeStatus().quiesced, false, 'serving in memory');
      assert.equal(fx.journal().sleep, undefined, 'the failed resume still served the overdue sleep');
      assert.deepEqual(gate.upcomingWakes(['agent2']).map((w) => w.kind), ['self-wake'], "and armed agent2's timer");
      await framework.resume();
      assert.equal(framework.getHostModeStatus().quiesced, false);
      await waitFor('the overdue wakes to become a turn', () => membrane.calls.length > 0);
      // agent2's timer, armed by the admission, fires at its time (1 s, the
      // self-wake's floor) and leaves the journal.
      await waitFor("agent2's self-wake to fire", () => fx.journal().selfWakes.length === 0, 3_000);
    } finally {
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test('a wake falling due while stop() waits for the loop stays in the journal', async () => {
  // The window stop()'s stopWakeTimers() step protects is the one between
  // its first synchronous steps and the gate's dispose(): the awaits for the
  // loop, the streams and the operator operations. A module's stop() runs
  // after dispose(), where dispose() has cleared the timers on its own, so a
  // stop held there sees nothing (R6-1). Held here in the loop, in a
  // module's onProcess, with a wake falling due meanwhile: without the step,
  // the wake fires into the stopping framework and leaves the journal.
  const fx = fixture();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    const membrane = new MockMembrane();
    const framework = await fx.create(membrane, {
      modules: [{
        name: 'holder',
        async start() {},
        async stop() {},
        getTools: () => [],
        async handleToolCall() { return { success: false }; },
        async onProcess(event: { type: string }) {
          if (event.type === 'external-message') { holding = true; await held; }
          return {};
        },
      }],
    });
    framework.start();
    framework.pushEvent({
      type: 'external-message', source: 'test', content: [{ type: 'text', text: 'hold the loop' }], metadata: {}, triggerInference: false,
    } as unknown as ProcessEvent);
    await waitFor('the loop to be held in onProcess', () => holding);
    const gate = internals(framework).eventGate;
    assert.equal(gate.armSelfWake('agent', 1, 'skip_reply').durable, true);
    assert.equal(gate.setSleep(1.1, undefined, 'agent').durable, true);
    const requestsBefore = internals(framework).pendingRequests.length;
    const stopping = framework.stop();
    try {
      await sleepMs(1_500);
      const kept = fx.journal();
      assert.equal(kept.selfWakes.length, 1, 'the self-wake, due during the stop, is still journaled');
      assert.ok(kept.sleep, 'the sleep, ended during the stop, is still journaled');
      assert.equal(internals(framework).pendingRequests.length, requestsBefore, 'no wake requested during the stop');
      assert.equal(membrane.calls.length, 0, 'no wake served');
    } finally {
      // Released whatever the assertions said, so a failure here doesn't hold
      // the stop and the loop for the rest of the file (R7-7).
      release();
      await stopping;
    }
    assert.equal(fx.journal().selfWakes.length, 1, 'and after it');
  } finally {
    fx.close();
  }
});

test('an overdue self-wake is served ahead of a request queued before start(), so its notice reaches the turn', async () => {
  // The loop's first pass runs synchronously inside start(): a request already
  // queued (catch-up traffic between create() and start()) would start its
  // turn there, and the turn's start cancels the agent's self-wake. Admission
  // runs before the loop, so the wake's request is first (R7-2).
  const fx = fixture();
  try {
    await setAndStop(fx, 0.3);
    await sleepMs(1_200);
    const membrane = new MockMembrane();
    answers(membrane, 3);
    const framework = await fx.create(membrane);
    try {
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'queued before start' }], metadata: {}, triggerInference: true,
      } as unknown as ProcessEvent);
      framework.start();
      await waitFor('a turn', () => membrane.calls.length > 0);
      const seen = JSON.stringify(membrane.calls);
      assert.ok(seen.includes('the host was down or quiesced then'), 'the recovered self-wake\'s notice is in the window the model saw');
      assert.deepEqual(fx.journal().selfWakes, [], 'served, not cancelled');
    } finally {
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test('a resume() before start() admits nothing; start() does', async () => {
  const fx = fixture();
  try {
    await setAndStop(fx, 0.2);
    await sleepMs(1_200);
    mkdirSync(join(fx.storePath, 'recovery'), { recursive: true });
    writeFileSync(join(fx.storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: true, reason: 'test' }));
    const membrane = new MockMembrane();
    answers(membrane, 2);
    const framework = await fx.create(membrane);
    try {
      assert.equal(framework.getHostModeStatus().quiesced, true);
      // Un-quiesced before start(): both of resume()'s admissions are guarded
      // on `running`, so the journal is untouched and nothing is requested
      // until start() (R5-3, R6-7, R7-7).
      await framework.resume();
      assert.equal(framework.getHostModeStatus().quiesced, false);
      assert.ok(fx.journal().sleep, 'the overdue sleep still waits in the journal');
      assert.equal(fx.journal().selfWakes.length, 1);
      assert.equal(internals(framework).pendingRequests.length, 0, 'nothing requested before start()');
      assert.equal(membrane.calls.length, 0);
      framework.start();
      assert.equal(fx.journal().sleep, undefined, 'start() served the sleep');
      assert.deepEqual(fx.journal().selfWakes, [], 'and the self-wake');
      await waitFor('the wakes to become a turn', () => membrane.calls.length > 0);
    } finally {
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test('a throw out of admission is logged and leaves start() whole: the loop is up and the intents stay in the journal', async () => {
  const fx = fixture();
  try {
    await setAndStop(fx, 0.2);
    await sleepMs(1_200);
    const membrane = new MockMembrane();
    let seen = false;
    const framework = await fx.create(membrane, {
      modules: [{
        name: 'witness',
        async start() {},
        async stop() {},
        getTools: () => [],
        async handleToolCall() { return { success: false }; },
        async onProcess(event: { type: string }) { if (event.type === 'external-message') seen = true; return {}; },
      }],
    });
    try {
      const gate = internals(framework).eventGate;
      const admit = gate.admitOverdueWakeIntents.bind(gate);
      let threw = false;
      gate.admitOverdueWakeIntents = () => { threw = true; throw new Error('admission refused for the test'); };
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        assert.doesNotThrow(() => framework.start());
      } finally {
        console.error = original;
        gate.admitOverdueWakeIntents = admit;
      }
      assert.equal(threw, true);
      assert.ok(logged.some((l) => l.includes('admitting the restored wakes at start failed')), logged.join('\n'));
      assert.ok(fx.journal().sleep, 'the intents stay in the journal');
      assert.equal(fx.journal().selfWakes.length, 1);
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'is the loop up?' }], metadata: {}, triggerInference: false,
      } as unknown as ProcessEvent);
      await waitFor('the loop to process an event after the failed admission', () => seen);
    } finally {
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test("a renamed agent's restored sleep is ended at create(), before any input is gated, and leaves the journal at start()", async () => {
  // R5-4, R6-2, R6-4: the gate's hasAgent is wired to framework.agents, and
  // the check runs at restore, in memory, so the stale sleep mutes nothing
  // between create() and start(); the journal loses it at admission.
  const fx = fixture(['old']);
  try {
    await setAndStop(fx, 3_600, 'old');
    assert.equal(fx.journal().sleep?.agentName, 'old');
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let framework: AgentFramework | undefined;
    try {
      framework = await fx.create(new MockMembrane(), {}, ['new']);
      const gate = internals(framework).eventGate;
      assert.equal(gate.getSleepState(), null, "the absent agent's sleep is gone from the gate before start()");
      assert.deepEqual(gate.upcomingWakes(['new']), [], 'and its self-wake');
      assert.ok(fx.journal().sleep, 'the journal still holds it: restore writes nothing');
      assert.ok(logged.some((l) => /ending the restored sleep of "old"/.test(l)), logged.join('\n'));
      framework.start();
      assert.equal(fx.journal().sleep, undefined, 'admission wrote the journal without it');
      assert.deepEqual(fx.journal().selfWakes, []);
    } finally {
      console.error = quiet;
      await framework?.stop();
    }
  } finally {
    fx.close();
  }
});

test("a sleep and a wake whose journal write fails say so in their results", async () => {
  const fx = fixture();
  try {
    const membrane = new MockMembrane();
    const framework = await fx.create(membrane);
    const quiet = console.error;
    console.error = () => {};
    try {
      // The journal's path is taken by a directory after create() read it:
      // every write from here fails at its rename.
      mkdirSync(fx.journalPath);
      const slept = await framework.executeToolCall({ id: 's1', name: 'sleep', input: { seconds: 60, announce: false }, callerAgentName: 'agent' });
      assert.equal(slept.success, true);
      assert.match(String((slept.data as { note?: string }).note), /could not be journaled/);
      const woke = await framework.executeToolCall({ id: 'w1', name: 'wake', input: {}, callerAgentName: 'agent' });
      assert.equal(woke.success, true);
      assert.deepEqual(Object.keys(woke.data as object).sort(), ['note', 'woke']);
      assert.equal((woke.data as { woke: boolean }).woke, true);
      assert.match(String((woke.data as { note?: string }).note), /could not be journaled/);
      // And when the write works, neither says anything.
      rmSync(fx.journalPath, { recursive: true });
      const slept2 = await framework.executeToolCall({ id: 's2', name: 'sleep', input: { seconds: 60, announce: false }, callerAgentName: 'agent' });
      assert.equal((slept2.data as { note?: string }).note, undefined);
      const woke2 = await framework.executeToolCall({ id: 'w2', name: 'wake', input: {}, callerAgentName: 'agent' });
      assert.deepEqual(woke2.data, { woke: true });
      assert.ok(existsSync(fx.journalPath));
    } finally {
      console.error = quiet;
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});

test("a skip_reply whose self-wake's journal write fails reaches the registry with wakeDurable: false", async () => {
  const fx = fixture();
  try {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'wake-1', name: 'skip_reply', input: { reason: 'later', wake_in_seconds: 60 } },
    ] as ContentBlock[], 'tool_use'));
    const framework = await fx.create(membrane);
    const quiet = console.error;
    console.error = () => {};
    try {
      mkdirSync(fx.journalPath);
      const origins: ChannelToolOrigin[] = [];
      internals(framework).channelRegistry = new Proxy({
        getChannelTools: () => [],
        resolveLocus: () => ({ serverId: 'stub', channelId: 'channel:test' }),
        routeSpeech: async () => ({ delivered: true, serverId: 'stub', channelId: 'channel:test' }),
        handleChannelToolCall: async (_name: string, _input: unknown, origin: ChannelToolOrigin) => {
          origins.push(origin);
          return { success: true, endTurn: true, data: { skipped: true } };
        },
      }, { get: (target, prop: string) => prop in target ? target[prop as keyof typeof target] : () => undefined });
      await internals(framework).startAgentStream(framework.getAgent('agent')!, {
        agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now(),
      });
      await framework.runUntilIdle();
      assert.equal(origins.length, 1);
      const origin = origins[0]!;
      assert.equal(origin.kind, 'agent');
      assert.equal(origin.kind === 'agent' ? origin.wakeDurable : undefined, false, 'the framework tells the registry the wake is not journaled');
      assert.deepEqual(internals(framework).eventGate.upcomingWakes(['agent']).map((w) => w.kind), ['self-wake'], 'the live timer is armed all the same');
    } finally {
      console.error = quiet;
      await framework.stop();
    }
  } finally {
    fx.close();
  }
});
