/**
 * The wake journal — EventGate.restoreWakeIntents / admitOverdueWakeIntents.
 *
 * A sleep (`sleep`) and a self-wake (skip_reply's wake_in_seconds) are the
 * agent's own word on when it comes back. The gate keeps both in
 * `<gate stem>.wake-intents.json` beside gate.json:
 *   - set, cleared, cancelled or fired, the journal follows;
 *   - a new gate on the same path takes them back (restoreWakeIntents),
 *     arms those still ahead and delivers those overdue
 *     (admitOverdueWakeIntents), each once;
 *   - a quiesced gate keeps one that falls due, for its resume;
 *   - stopWakeTimers() (the host's stop) silences the timers and keeps the
 *     intents;
 *   - a journal that can't be written leaves the live timer in force and
 *     reports `durable: false`; one whose content can't be read is set
 *     aside; one the process can't read at all is left alone and not
 *     written over;
 *   - a restored sleep or self-wake naming an agent this host doesn't have
 *     is ended at restore, and leaves the journal at admission.
 * The framework's wiring of these is pinned in framework-wake-journal.test.ts.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import { MAX_TIMER_MS } from '../src/deadline-timer.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-wake-journal');

function makeGate(opts: { configPath?: string; now?: () => number; agents?: string[]; hasAgent?: (name: string) => boolean } = {}) {
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string }> = [];
  const messages: Array<{ participant: string; text: string; metadata?: Record<string, unknown>; forAgent?: string }> = [];
  const gate = new EventGate({
    configPath: opts.configPath ?? join(TMP_DIR, 'gate.json'),
    emitTrace: () => {},
    addMessage: (p, c, m, forAgent) => {
      messages.push({ participant: p, text: c.map((b) => b.text).join('\n'), metadata: m, forAgent });
      return '';
    },
    requestInference: (a, r, s) => inferenceRequests.push({ agentName: a, reason: r, source: s }),
    getAgentNames: () => opts.agents ?? ['agent'],
    ...(opts.hasAgent ? { hasAgent: opts.hasAgent } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { gate, inferenceRequests, messages };
}

function journal(gate: EventGate): { sleep?: Record<string, unknown>; selfWakes: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(gate.wakeJournalPath, 'utf8'));
}

describe('EventGate wake journal', () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  it('is kept beside gate.json, named after it', () => {
    const { gate } = makeGate({ configPath: join(TMP_DIR, 'my-gate.json') });
    assert.strictEqual(gate.wakeJournalPath, join(TMP_DIR, 'my-gate.wake-intents.json'));
    gate.dispose();
  });

  it('a self-wake enters the journal when armed and leaves it when it fires', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { gate, inferenceRequests } = makeGate();
    const { armed, durable } = gate.armSelfWake('agent', 5, 'skip_reply');
    assert.ok(armed && durable);
    const written = journal(gate);
    assert.strictEqual(written.selfWakes.length, 1);
    assert.strictEqual(written.selfWakes[0]!.agentName, 'agent');
    assert.strictEqual(written.selfWakes[0]!.source, 'skip_reply');
    assert.strictEqual((written.selfWakes[0]!.wakeAt as number) - (written.selfWakes[0]!.armedAt as number), 5_000);
    assert.strictEqual(written.sleep, undefined);
    t.mock.timers.tick(5_100);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.deepStrictEqual(journal(gate).selfWakes, [], 'fired, so no longer journaled');
    gate.dispose();
  });

  it('a turn start cancels the self-wake in the journal too', () => {
    const { gate } = makeGate();
    gate.armSelfWake('agent', 60, 'skip_reply');
    assert.strictEqual(journal(gate).selfWakes.length, 1);
    gate.onInferenceStarted('agent');
    assert.deepStrictEqual(journal(gate).selfWakes, []);
    gate.dispose();
  });

  it("agentGone() takes the gone agent's self-wake out of the journal", () => {
    const { gate } = makeGate({ agents: ['agent', 'other'] });
    gate.armSelfWake('agent', 60, 'skip_reply');
    gate.armSelfWake('other', 60, 'cadence');
    gate.agentGone('other');
    assert.deepStrictEqual(journal(gate).selfWakes.map((w) => w.agentName), ['agent']);
    gate.dispose();
  });

  it('a sleep enters the journal with its note and agent, and leaves it on wake', () => {
    const { gate } = makeGate();
    const { until, durable } = gate.setSleep(3600, 'resting', 'agent');
    assert.ok(durable);
    const written = journal(gate);
    assert.strictEqual(written.sleep?.wakeAt, until);
    assert.strictEqual(written.sleep?.note, 'resting');
    assert.strictEqual(written.sleep?.agentName, 'agent');
    assert.strictEqual(written.sleep?.source, 'sleep');
    gate.clearSleep();
    assert.strictEqual(journal(gate).sleep, undefined);
    gate.dispose();
  });

  it('a new gate on the same path takes the sleep and self-wake back, and fires them at their time', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const first = makeGate({ now });
    first.gate.setSleep(120, 'resting', 'agent');
    first.gate.armSelfWake('agent', 60, 'skip_reply');
    first.gate.dispose();
    assert.strictEqual(journal(first.gate).selfWakes.length, 1, 'dispose keeps the intent');
    assert.ok(journal(first.gate).sleep, 'dispose keeps the sleep');

    // The host comes back 30 s later.
    clock += 30_000;
    const second = makeGate({ now });
    second.gate.restoreWakeIntents();
    const sleep = second.gate.getSleepState();
    assert.ok(sleep, 'asleep from the start, before anything is admitted');
    assert.strictEqual(sleep.note, 'resting');
    assert.strictEqual(sleep.remainingMs, 90_000);
    assert.strictEqual(second.inferenceRequests.length, 0, 'restoring wakes nothing');

    second.gate.admitOverdueWakeIntents();
    assert.strictEqual(second.inferenceRequests.length, 0, 'nothing is due yet');
    const wakes = second.gate.upcomingWakes(['agent']);
    assert.deepStrictEqual(wakes.map((w) => [w.kind, w.at]).sort(), [['self-wake', clock + 30_000], ['sleep-end', clock + 90_000]].sort());

    clock += 30_000;
    t.mock.timers.tick(30_000);
    assert.deepStrictEqual(second.inferenceRequests.map((r) => r.source), ['self-wake']);
    assert.match(second.messages[0]!.text, /^\[self-wake\] your skip_reply timer \(60s\) elapsed — now /);
    assert.deepStrictEqual(journal(second.gate).selfWakes, []);

    clock += 60_000;
    t.mock.timers.tick(60_000);
    assert.deepStrictEqual(second.inferenceRequests.map((r) => r.source), ['self-wake', 'sleep']);
    assert.strictEqual(second.inferenceRequests[1]!.reason, 'sleep-expired: resting');
    assert.strictEqual(journal(second.gate).sleep, undefined);
    second.gate.dispose();
  });

  it('a sleep and a self-wake that fell due while the host was down are served at admission, once', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const first = makeGate({ now });
    first.gate.setSleep(60, 'resting', 'agent');
    first.gate.armSelfWake('agent', 30, 'skip_reply');
    first.gate.dispose();

    clock += 600_000; // ten minutes down
    const second = makeGate({ now });
    second.gate.restoreWakeIntents();
    assert.ok(second.gate.getSleepState() === null, 'a sleep whose end passed suppresses nothing');
    second.gate.admitOverdueWakeIntents();
    const sources = second.inferenceRequests.map((r) => r.source).sort();
    assert.deepStrictEqual(sources, ['self-wake', 'sleep']);
    const sleepWake = second.inferenceRequests.find((r) => r.source === 'sleep')!;
    assert.strictEqual(sleepWake.agentName, 'agent');
    assert.match(sleepWake.reason, /down or quiesced: resting$/);
    const selfWake = second.inferenceRequests.find((r) => r.source === 'self-wake')!;
    assert.match(selfWake.reason, /skip_reply, 30s, recovered/);
    assert.strictEqual(second.messages.length, 1);
    assert.match(second.messages[0]!.text, /^\[self-wake\] your skip_reply timer \(30s\) elapsed \(due \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z; the host was down or quiesced then\) — now /);
    assert.strictEqual(second.messages[0]!.metadata?.recovered, true);
    assert.strictEqual(second.messages[0]!.forAgent, 'agent');
    const after = journal(second.gate);
    assert.deepStrictEqual(after.selfWakes, []);
    assert.strictEqual(after.sleep, undefined);

    second.gate.admitOverdueWakeIntents();
    assert.strictEqual(second.inferenceRequests.length, 2, 'a second admission serves nothing again');
    second.gate.dispose();
  });

  it('a sleep that named no agent wakes every recipient when it is served late', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const first = makeGate({ now, agents: ['a', 'b'] });
    first.gate.setSleep(60);
    first.gate.dispose();
    clock += 120_000;
    const second = makeGate({ now, agents: ['a', 'b'] });
    second.gate.restoreWakeIntents();
    second.gate.admitOverdueWakeIntents();
    assert.deepStrictEqual(second.inferenceRequests.map((r) => r.agentName).sort(), ['a', 'b']);
    second.gate.dispose();
  });

  it('a self-wake due while the host is quiesced waits for the resume, and is not lost to a restart meanwhile', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const { gate, inferenceRequests } = makeGate({ now });
    gate.armSelfWake('agent', 10, 'skip_reply');
    gate.setQuiesced(true);
    clock += 10_000;
    t.mock.timers.tick(10_100);
    assert.strictEqual(inferenceRequests.length, 0, 'nothing is requested while quiesced');
    assert.strictEqual(journal(gate).selfWakes.length, 1, 'the intent is kept');

    // Resume in this process: the framework calls admission after it.
    gate.setQuiesced(false);
    gate.admitOverdueWakeIntents();
    assert.deepStrictEqual(inferenceRequests.map((r) => r.source), ['self-wake']);
    assert.deepStrictEqual(journal(gate).selfWakes, []);
    gate.dispose();
  });

  it('a sleep ending while the host is quiesced goes on until the resume', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const { gate, inferenceRequests } = makeGate({ now });
    gate.setSleep(10, 'resting', 'agent');
    gate.setQuiesced(true);
    clock += 10_000;
    t.mock.timers.tick(10_100);
    assert.strictEqual(inferenceRequests.length, 0);
    assert.ok(journal(gate).sleep, 'the sleep is kept');
    gate.setQuiesced(false);
    gate.admitOverdueWakeIntents();
    assert.deepStrictEqual(inferenceRequests.map((r) => r.source), ['sleep']);
    assert.strictEqual(journal(gate).sleep, undefined);
    gate.dispose();
  });

  it('a quiesced gate admits nothing', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const first = makeGate({ now });
    first.gate.armSelfWake('agent', 10, 'skip_reply');
    first.gate.dispose();
    clock += 60_000;
    const second = makeGate({ now });
    second.gate.setQuiesced(true);
    second.gate.restoreWakeIntents();
    second.gate.admitOverdueWakeIntents();
    assert.strictEqual(second.inferenceRequests.length, 0);
    assert.strictEqual(journal(second.gate).selfWakes.length, 1);
    second.gate.setQuiesced(false);
    second.gate.admitOverdueWakeIntents();
    assert.strictEqual(second.inferenceRequests.length, 1);
    second.gate.dispose();
  });

  it('stopWakeTimers() lets nothing fire and keeps the intents', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { gate, inferenceRequests } = makeGate();
    gate.armSelfWake('agent', 1, 'skip_reply');
    gate.setSleep(1, 'resting', 'agent');
    gate.stopWakeTimers();
    t.mock.timers.tick(5_000);
    assert.strictEqual(inferenceRequests.length, 0);
    const kept = journal(gate);
    assert.strictEqual(kept.selfWakes.length, 1);
    assert.ok(kept.sleep);
    // Nothing armed after it either, as after dispose().
    assert.strictEqual(gate.armSelfWake('agent', 1, 'skip_reply').armed, true, 'the intent is still taken');
    t.mock.timers.tick(5_000);
    assert.strictEqual(inferenceRequests.length, 0);
    gate.dispose();
  });

  it('a journal that cannot be written leaves the timer in force and says so', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // The gate's directory is a file, so nothing beside gate.json can be written.
    const blocker = join(TMP_DIR, 'blocked');
    writeFileSync(blocker, 'not a directory');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { gate, inferenceRequests } = makeGate({ configPath: join(blocker, 'gate.json') });
      const selfWake = gate.armSelfWake('agent', 1, 'skip_reply');
      assert.strictEqual(selfWake.armed, true);
      assert.strictEqual(selfWake.durable, false);
      const sleep = gate.setSleep(2, 'resting', 'agent');
      assert.strictEqual(sleep.durable, false);
      t.mock.timers.tick(1_100);
      assert.deepStrictEqual(inferenceRequests.map((r) => r.source), ['self-wake'], 'the live timer still fires');
      assert.ok(logged.some((l) => /wake journal: write failed while setting a self-wake/.test(l)));
      assert.ok(logged.some((l) => /wake journal: write failed while setting a sleep/.test(l)));
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it('a journal that cannot be read is set aside, and the gate starts with no wake set', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), '{not json');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { gate, inferenceRequests } = makeGate({ configPath });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      assert.strictEqual(inferenceRequests.length, 0);
      assert.strictEqual(gate.getSleepState(), null);
      assert.ok(!existsSync(gate.wakeJournalPath));
      assert.ok(existsSync(join(TMP_DIR, 'gate.wake-intents.json.corrupt')));
      assert.ok(logged.some((l) => /wake journal unreadable, set aside as/.test(l)));
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it('an entry the journal cannot vouch for is skipped, and the rest restored', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    const now = 1_700_000_000_000;
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), JSON.stringify({
      version: 1,
      sleep: { armedAt: 'yesterday', wakeAt: now + 1000, source: 'sleep' },
      selfWakes: [
        { agentName: 'agent', armedAt: now, wakeAt: now + 60_000, source: 'skip_reply' },
        { armedAt: now, wakeAt: now + 60_000, source: 'skip_reply' },
        { agentName: 'agent2', armedAt: now, wakeAt: now - 1, source: 'skip_reply' },
      ],
    }));
    const original = console.error;
    console.error = () => {};
    try {
      const { gate } = makeGate({ configPath, now: () => now, agents: ['agent', 'agent2'] });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      assert.strictEqual(gate.getSleepState(), null, 'the invalid sleep is not taken');
      assert.deepStrictEqual(gate.upcomingWakes(['agent', 'agent2']).map((w) => w.kind), ['self-wake']);
      gate.dispose();
    } finally {
      console.error = original;
    }
  });
  it('admission on a gate whose wake timers are stopped, or that is disposed, emits nothing and keeps the journal', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    const now = 1_700_000_000_000;
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), JSON.stringify({
      version: 1,
      sleep: { agentName: 'agent', armedAt: now - 10_000, wakeAt: now - 1, source: 'sleep' },
      selfWakes: [{ agentName: 'agent', armedAt: now - 10_000, wakeAt: now - 1, source: 'skip_reply' }],
    }));
    const original = console.error;
    console.error = () => {};
    try {
      for (const how of ['stopped', 'disposed'] as const) {
        const { gate, inferenceRequests, messages } = makeGate({ configPath, now: () => now });
        gate.restoreWakeIntents();
        if (how === 'stopped') gate.stopWakeTimers(); else gate.dispose();
        gate.admitOverdueWakeIntents();
        assert.strictEqual(inferenceRequests.length, 0, `${how}: no wake requested`);
        assert.strictEqual(messages.length, 0, `${how}: no notice`);
        const kept = journal(gate);
        assert.ok(kept.sleep, `${how}: the sleep stays journaled`);
        assert.strictEqual(kept.selfWakes.length, 1, `${how}: the self-wake stays journaled`);
        if (how === 'stopped') gate.dispose();
      }
    } finally {
      console.error = original;
    }
  });

  it('a journal write after dispose() keeps the self-wakes', () => {
    const { gate } = makeGate();
    gate.armSelfWake('agent', 60, 'skip_reply');
    gate.dispose();
    // A late turn's sleep, between the host's stop and its exit.
    gate.setSleep(120, undefined, 'agent');
    const written = journal(gate);
    assert.strictEqual(written.selfWakes.length, 1, 'the self-wake armed before the dispose is still there');
    assert.ok(written.sleep);
  });

  it('an entry whose wakeAt precedes its armedAt is skipped', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    const now = 1_700_000_000_000;
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), JSON.stringify({
      version: 1,
      sleep: { agentName: 'agent', armedAt: now + 5_000, wakeAt: now + 1_000, source: 'sleep' },
      selfWakes: [
        { agentName: 'agent', armedAt: now + 5_000, wakeAt: now + 1_000, source: 'skip_reply' },
        { agentName: 'agent2', armedAt: now, wakeAt: now + 60_000, source: 'skip_reply' },
      ],
    }));
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { gate } = makeGate({ configPath, now: () => now, agents: ['agent', 'agent2'] });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      assert.strictEqual(gate.getSleepState(), null);
      assert.deepStrictEqual(gate.upcomingWakes(['agent', 'agent2']).map((w) => w.what), ["agent2's own skip_reply timer"]);
      assert.strictEqual(logged.filter((l) => /skipping/.test(l)).length, 2);
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it("a restored sleep or self-wake naming an agent this host doesn't have is ended at restore, and leaves the journal at admission", () => {
    const configPath = join(TMP_DIR, 'gate.json');
    const now = 1_700_000_000_000;
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), JSON.stringify({
      version: 1,
      sleep: { agentName: 'old-name', armedAt: now - 1_000, wakeAt: now + 6 * 3_600_000, source: 'sleep' },
      selfWakes: [
        { agentName: 'old-name', armedAt: now - 1_000, wakeAt: now + 60_000, source: 'skip_reply' },
        { agentName: 'new-name', armedAt: now - 1_000, wakeAt: now + 60_000, source: 'skip_reply' },
      ],
    }));
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      // The agent renamed in the recipe between restarts; a non-recipient
      // agent counts as present too (hasAgent, not getAgentNames).
      const { gate, inferenceRequests } = makeGate({ configPath, now: () => now, agents: [], hasAgent: (name) => name === 'new-name' });
      gate.restoreWakeIntents();
      // Dropped at restore, in memory, so the stale sleep mutes nothing before
      // admission (R6-4); the journal still holds it, as restore writes nothing.
      assert.strictEqual(gate.getSleepState(), null, 'the absent agent\'s sleep is ended at restore');
      assert.ok(JSON.parse(readFileSync(join(TMP_DIR, 'gate.wake-intents.json'), 'utf8')).sleep, 'the journal still holds it until admission');
      gate.admitOverdueWakeIntents();
      assert.strictEqual(gate.getSleepState(), null, 'the absent agent\'s sleep stays ended');
      assert.strictEqual(inferenceRequests.length, 0, 'ended, not woken: there is no one to wake');
      assert.deepStrictEqual(gate.upcomingWakes(['new-name']).map((w) => w.kind), ['self-wake'], 'the present agent\'s self-wake is armed');
      const written = journal(gate);
      assert.strictEqual(written.sleep, undefined);
      assert.deepStrictEqual(written.selfWakes.map((w) => w.agentName), ['new-name']);
      assert.ok(logged.some((l) => /ending the restored sleep of "old-name"/.test(l)));
      assert.ok(logged.some((l) => /dropping the restored self-wake of "old-name"/.test(l)));
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it('a journal the process cannot read is left in place and not written over, and every write answers durable: false', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    // A directory where the journal should be: the read fails with EISDIR,
    // which says nothing about the content (as EACCES or EIO wouldn't).
    const journalPath = join(TMP_DIR, 'gate.wake-intents.json');
    mkdirSync(journalPath);
    writeFileSync(join(journalPath, 'keep'), 'a file the quarantine would have moved');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { gate } = makeGate({ configPath });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      assert.ok(existsSync(join(journalPath, 'keep')), 'left in place');
      assert.ok(!existsSync(`${journalPath}.corrupt`), 'not set aside');
      assert.ok(logged.some((l) => /wake journal: read failed/.test(l)));
      assert.strictEqual(gate.setSleep(60, undefined, 'agent').durable, false);
      assert.strictEqual(gate.armSelfWake('agent', 60, 'skip_reply').durable, false);
      assert.strictEqual(gate.endSleep().durable, false);
      assert.ok(existsSync(join(journalPath, 'keep')), 'still in place after the writes');
      assert.deepStrictEqual(readdirSync(TMP_DIR).filter((f) => f.includes('.tmp-')), [], 'no temp file left behind');
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it('a failed journal write takes its temp file with it', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    // The journal's path is a directory, so the temp file is written and
    // fsynced, and the rename over the directory fails.
    mkdirSync(join(TMP_DIR, 'gate.wake-intents.json'));
    const original = console.error;
    console.error = () => {};
    try {
      const { gate } = makeGate({ configPath });
      assert.strictEqual(gate.setSleep(60, undefined, 'agent').durable, false);
      assert.strictEqual(gate.armSelfWake('agent', 60, 'skip_reply').durable, false);
      assert.deepStrictEqual(readdirSync(TMP_DIR).filter((f) => f.includes('.tmp-')), []);
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it('a sleep past the largest Date is clamped to it, journaled, and refuses no later write', () => {
    // R6-6: a deadline past the reader's bound (8.64e15 ms) used to fail the
    // write for the whole state, and every later journal write with it.
    const configPath = join(TMP_DIR, 'gate.json');
    const now = 1_700_000_000_000;
    const { gate } = makeGate({ configPath, now: () => now, agents: ['agent', 'agent2'] });
    const set = gate.setSleep(9e12, undefined, 'agent');
    assert.strictEqual(set.until, 8.64e15, 'clamped');
    assert.strictEqual(set.durable, true);
    assert.strictEqual(journal(gate).sleep?.wakeAt, 8.64e15);
    assert.strictEqual(gate.armSelfWake('agent2', 60, 'skip_reply').durable, true, "another agent's self-wake is journaled all the same");
    assert.strictEqual(journal(gate).selfWakes.length, 1);
    gate.dispose();
  });

  it('after stopWakeTimers(), a sleep set by a late turn arms no timer: it ends at the next start, not in the stopping process', async () => {
    // R6-2: the wakeTimersStopped check in armSleepWake.
    const configPath = join(TMP_DIR, 'gate.json');
    const original = console.error;
    console.error = () => {};
    try {
      const { gate, inferenceRequests } = makeGate({ configPath });
      gate.stopWakeTimers();
      assert.strictEqual(gate.setSleep(0.2, undefined, 'agent').durable, true, 'journaled for the next start');
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.strictEqual(inferenceRequests.length, 0, 'no wake fired in the stopping process');
      assert.ok(journal(gate).sleep, 'the sleep is still journaled');
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it("a journal the process can't read (EACCES) is left as it is: no write reaches it, and every receipt says durable: false", { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root reads any file' : false }, () => {
    // R6-2: the directory case (below) fails every write at the rename
    // whether or not the read-failed flag is set; a mode-000 file in a
    // writable directory is overwritten by the rename unless the flag holds.
    const configPath = join(TMP_DIR, 'gate.json');
    const journalPath = join(TMP_DIR, 'gate.wake-intents.json');
    const bytes = JSON.stringify({ version: 1, sleep: { agentName: 'agent', armedAt: 1, wakeAt: 8.64e15, source: 'sleep' }, selfWakes: [] });
    writeFileSync(journalPath, bytes, { mode: 0o000 });
    const original = console.error;
    console.error = () => {};
    try {
      const { gate } = makeGate({ configPath });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      assert.strictEqual(gate.getSleepState(), null, 'nothing restored from a journal that could not be read');
      assert.strictEqual(gate.setSleep(60, undefined, 'agent').durable, false);
      assert.strictEqual(gate.endSleep().durable, false);
      chmodSync(journalPath, 0o600);
      assert.strictEqual(readFileSync(journalPath, 'utf8'), bytes, 'the unreadable journal is byte for byte what it was');
      gate.dispose();
    } finally {
      console.error = original;
      try { chmodSync(journalPath, 0o600); } catch { /* gone */ }
    }
  });

  it('endSleep() says whether the end reached the journal', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    const original = console.error;
    console.error = () => {};
    try {
      const { gate } = makeGate({ configPath });
      gate.setSleep(60, undefined, 'agent');
      assert.deepStrictEqual(gate.endSleep(), { woke: true, durable: true });
      assert.deepStrictEqual(gate.endSleep(), { woke: false, durable: true });
      assert.strictEqual(journal(gate).sleep, undefined);
      // The journal's path blocked after the sleep was journaled: the end
      // holds in this process, and the journal still says asleep.
      gate.setSleep(60, undefined, 'agent');
      rmSync(gate.wakeJournalPath);
      mkdirSync(gate.wakeJournalPath);
      assert.deepStrictEqual(gate.endSleep(), { woke: true, durable: false });
      assert.strictEqual(gate.getSleepState(), null);
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it("a sleep whose note isn't a string is journaled without one, and refuses no other agent's write", () => {
    // The tool's schema says string; a model can send null or 42. Before,
    // the writer refused the whole state over it, for as long as the sleep
    // lasted (R7-1).
    const { gate } = makeGate({ configPath: join(TMP_DIR, 'gate.json'), agents: ['agent', 'agent2'] });
    assert.strictEqual(gate.armSelfWake('agent2', 600, 'skip_reply').durable, true);
    assert.strictEqual(gate.setSleep(3600, null as unknown as string, 'agent').durable, true);
    assert.strictEqual(journal(gate).sleep?.note, undefined);
    assert.strictEqual(gate.getSleepState()?.note, undefined);
    assert.strictEqual(gate.setSleep(3600, 42 as unknown as string, 'agent').durable, true);
    assert.strictEqual(gate.armSelfWake('agent2', 900, 'skip_reply').durable, true);
    assert.strictEqual(journal(gate).selfWakes.length, 1);
    gate.dispose();
  });

  it("an entry the reader wouldn't take is left out of the write and logged; the rest is written, and only its own caller hears durable: false", () => {
    // None can arise from setSleep or armSelfWake now; the writer's last
    // guard is pinned by forcing one (R6-6, R7-1).
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const { gate } = makeGate({ configPath: join(TMP_DIR, 'gate.json'), agents: ['agent', 'agent2'] });
      assert.strictEqual(gate.setSleep(3600, 'back soon', 'agent').durable, true);
      (gate as unknown as { sleepNote: unknown }).sleepNote = 42;
      assert.strictEqual(gate.armSelfWake('agent2', 600, 'skip_reply').durable, true, "another agent's write is durable");
      const written = journal(gate);
      assert.strictEqual(written.sleep, undefined, 'the sleep the reader would skip is left out');
      assert.deepStrictEqual(written.selfWakes.map((w) => w.agentName), ['agent2'], 'the self-wake is written');
      assert.ok(logged.some((l) => l.includes("is one the journal's reader would skip, so it is not written")), logged.join('\n'));
      // Its own caller is told: the same write, asked for the sleep's sake.
      const persist = gate as unknown as { tryPersistWakeState(action: string, subject?: string): boolean };
      assert.strictEqual(persist.tryPersistWakeState('a test', 'sleep'), false);
      assert.strictEqual(persist.tryPersistWakeState('a test', 'self-wake:agent2'), true);
      assert.strictEqual(persist.tryPersistWakeState('a test'), true);
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it('a restored self-wake whose notice throws stays in the journal, and the others are still served (R7-3)', () => {
    const configPath = join(TMP_DIR, 'gate.json');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      let now = 1_000_000;
      const first = makeGate({ configPath, agents: ['agent', 'agent2'], now: () => now });
      first.gate.armSelfWake('agent', 60, 'skip_reply');
      first.gate.armSelfWake('agent2', 60, 'skip_reply');
      first.gate.dispose();
      now += 120_000;
      const inferenceRequests: Array<{ agentName: string }> = [];
      const gate = new EventGate({
        configPath,
        emitTrace: () => {},
        addMessage: (_p, _c, _m, forAgent) => {
          if (forAgent === 'agent') throw new Error('store write refused');
          return '';
        },
        requestInference: (a) => inferenceRequests.push({ agentName: a }),
        getAgentNames: () => ['agent', 'agent2'],
        now: () => now,
      });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      assert.deepStrictEqual(inferenceRequests.map((r) => r.agentName), ['agent2'], 'the other self-wake is served');
      assert.deepStrictEqual(journal(gate).selfWakes.map((w) => w.agentName), ['agent'], 'the one that threw stays for the next start');
      assert.ok(logged.some((l) => l.includes('serving the restored self-wake of "agent" failed')), logged.join('\n'));
      gate.dispose();
    } finally {
      console.error = original;
    }
  });

  it("a restored self-wake past one timer step re-reads the clock when the step ends, and re-arms while the deadline is ahead (R7-5)", (t) => {
    // A journal written by hand: a self-wake 30 days ahead, more than one
    // step (MAX_TIMER_MS, about 24.8 days). The steps run on mocked timers;
    // the gate's clock is the test's. The first step ends with the deadline
    // still ahead by that clock, so it re-arms rather than fires.
    const configPath = join(TMP_DIR, 'gate.json');
    const { gate: pathOf } = makeGate({ configPath });
    const journalPath = pathOf.wakeJournalPath;
    pathOf.dispose();
    let now = 1_000_000;
    const thirtyDays = 30 * 24 * 3_600_000;
    writeFileSync(journalPath, JSON.stringify({
      version: 1, selfWakes: [{ agentName: 'agent', armedAt: now, wakeAt: now + thirtyDays, source: 'skip_reply' }],
    }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { gate, inferenceRequests } = makeGate({ configPath, now: () => now });
      gate.restoreWakeIntents();
      gate.admitOverdueWakeIntents();
      // The first step ends; the clock still says the deadline is ahead.
      t.mock.timers.tick(MAX_TIMER_MS);
      assert.strictEqual(inferenceRequests.length, 0, 'not fired: the deadline is ahead by the clock');
      assert.strictEqual(journal(gate).selfWakes.length, 1, 'still journaled, re-armed');
      // The clock reaches the deadline; the next step's end fires it.
      now += thirtyDays;
      t.mock.timers.tick(MAX_TIMER_MS);
      assert.deepStrictEqual(inferenceRequests.map((r) => r.agentName), ['agent']);
      assert.deepStrictEqual(journal(gate).selfWakes, []);
      gate.dispose();
    } finally {
      t.mock.timers.reset();
    }
  });
});
