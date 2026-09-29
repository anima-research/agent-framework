/**
 * Self-wake (skip_reply's wake_in_seconds) — EventGate.armSelfWake.
 *
 * Contract (2026-08-02, antra's QoL request):
 *   - armSelfWake(agent, N) fires a normal inference request after ~N
 *     seconds. NO suppression window is involved (unlike sleep) — external
 *     wakes flow normally in the meantime.
 *   - Any turn start for the agent (onInferenceStarted) cancels the pending
 *     self-wake: the semantics are "if nothing else wakes me by then".
 *   - Re-arming replaces the pending timer (single timer per agent).
 *   - Seconds clamp to [1, 3600].
 *   - dispose() clears pending timers.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const TMP_DIR = join(import.meta.dirname, '../.test-tmp-gate-selfwake');

function makeGate() {
  const inferenceRequests: Array<{ agentName: string; reason: string; source: string }> = [];
  const messages: Array<{ participant: string; text: string; metadata?: Record<string, unknown> }> = [];
  const gate = new EventGate({
    configPath: join(TMP_DIR, 'gate.json'),
    emitTrace: () => {},
    addMessage: (p, c, m) => {
      messages.push({ participant: p, text: c.map((b) => b.text).join('\n'), metadata: m });
      return '';
    },
    requestInference: (a, r, s) => inferenceRequests.push({ agentName: a, reason: r, source: s }),
    getAgentNames: () => ['agent'],
  });
  return { gate, inferenceRequests, messages };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EventGate self-wake', () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  it('fires an inference request after the delay', async () => {
    const { gate, inferenceRequests } = makeGate();
    const { inMs } = gate.armSelfWake('agent', 1, 'skip_reply');
    assert.strictEqual(inMs, 1000);
    assert.strictEqual(inferenceRequests.length, 0, 'must not fire synchronously');
    await sleep(1150);
    assert.strictEqual(inferenceRequests.length, 1);
    assert.strictEqual(inferenceRequests[0]!.agentName, 'agent');
    assert.strictEqual(inferenceRequests[0]!.source, 'self-wake');
    assert.match(inferenceRequests[0]!.reason, /skip_reply/);
    gate.dispose();
  });

  it('drops a compact timestamped notice into the window when it fires', async () => {
    const { gate, messages } = makeGate();
    gate.armSelfWake('agent', 1, 'skip_reply');
    assert.strictEqual(messages.length, 0, 'arming must not add a message');
    await sleep(1150);
    assert.strictEqual(messages.length, 1);
    const msg = messages[0]!;
    assert.strictEqual(msg.participant, 'user');
    assert.strictEqual(msg.metadata?.source, 'gate:self-wake');
    // One line: what woke it (its own skip_reply timer, with the armed
    // duration) and when (ISO to the second).
    assert.match(msg.text, /^\[self-wake\] your skip_reply timer \(1s\) elapsed — now \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    gate.dispose();
  });

  it('a superseded self-wake adds no notice', async () => {
    const { gate, messages } = makeGate();
    gate.armSelfWake('agent', 1);
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await sleep(1150);
    assert.strictEqual(messages.length, 0);
    gate.dispose();
  });

  it('is cancelled by a turn start (external wake supersedes)', async () => {
    const { gate, inferenceRequests } = makeGate();
    gate.armSelfWake('agent', 1);
    // Something else woke the agent first.
    gate.onInferenceStarted('agent');
    gate.onInferenceEnded('agent');
    await sleep(1150);
    assert.strictEqual(inferenceRequests.length, 0, 'superseded self-wake must not fire');
    gate.dispose();
  });

  it('survives the arming turn itself (arm mid-turn, fire after end)', async () => {
    const { gate, inferenceRequests } = makeGate();
    // Turn starts, THEN skip_reply arms the wake mid-turn, then the turn ends
    // — exactly the production sequence. The arm must not be eaten by its
    // own turn's lifecycle.
    gate.onInferenceStarted('agent');
    gate.armSelfWake('agent', 1);
    gate.onInferenceEnded('agent');
    await sleep(1150);
    assert.strictEqual(inferenceRequests.length, 1);
    gate.dispose();
  });

  it('re-arming replaces the pending timer; only one wake fires', async () => {
    const { gate, inferenceRequests } = makeGate();
    gate.armSelfWake('agent', 1);
    gate.armSelfWake('agent', 1);
    await sleep(1200);
    assert.strictEqual(inferenceRequests.length, 1);
    gate.dispose();
  });

  it('clamps seconds to [1, 3600]', () => {
    const { gate } = makeGate();
    assert.strictEqual(gate.armSelfWake('agent', 0.05).inMs, 1000);
    assert.strictEqual(gate.armSelfWake('agent', 999999).inMs, 3_600_000);
    gate.dispose();
  });

  it('dispose clears pending timers', async () => {
    const { gate, inferenceRequests } = makeGate();
    gate.armSelfWake('agent', 1);
    gate.dispose();
    await sleep(1150);
    assert.strictEqual(inferenceRequests.length, 0);
  });
});

describe('durable wake intent recovery', () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  function harness(now: () => number) {
    const inferenceRequests: Array<{ agentName: string; reason: string; source: string }> = [];
    const messages: string[] = [];
    const gate = new EventGate({
      configPath: join(TMP_DIR, 'gate.json'), now,
      emitTrace: () => {},
      addMessage: (_p, c) => { messages.push(c.map((b) => b.text).join('\n')); return ''; },
      requestInference: (agentName, reason, source) => inferenceRequests.push({ agentName, reason, source }),
      getAgentNames: () => ['agent'],
    });
    gate.recoverWakeIntents();
    return { gate, inferenceRequests, messages };
  }

  it('persists sleep before setSleep reports success and re-arms it after restart', () => {
    let now = 1_000;
    const a = harness(() => now);
    const { until } = a.gate.setSleep(60, 'resume work', 'agent');
    const state = JSON.parse(readFileSync(join(TMP_DIR, 'gate.wake-intents.json'), 'utf8'));
    assert.strictEqual(state.sleep.wakeAt, until);
    assert.strictEqual(state.sleep.note, 'resume work');
    // Simulate abrupt process loss: stop only the old JS timer, without dispose.
    const ai = a.gate as unknown as { sleepTimer: ReturnType<typeof setTimeout> | null };
    if (ai.sleepTimer) clearTimeout(ai.sleepTimer);

    now += 10_000;
    const b = harness(() => now);
    assert.strictEqual(b.gate.getSleepState()!.until, until);
    b.gate.dispose();
  });

  it('an overdue sleep emits one recovery marker and one inference', async () => {
    let now = 1_000;
    const a = harness(() => now);
    a.gate.setSleep(5, 'check result', 'agent');
    const ai = a.gate as unknown as { sleepTimer: ReturnType<typeof setTimeout> | null };
    if (ai.sleepTimer) clearTimeout(ai.sleepTimer);

    now = 10_000;
    const b = harness(() => now);
    await Promise.resolve();
    assert.strictEqual(b.inferenceRequests.length, 1);
    assert.strictEqual(b.inferenceRequests[0]!.source, 'wake-recovery');
    assert.strictEqual(b.messages.length, 1);
    assert.match(b.messages[0]!, /wake-recovery.*overdue while the host was offline/);
    b.gate.dispose();

    const c = harness(() => now);
    await Promise.resolve();
    assert.strictEqual(c.inferenceRequests.length, 0, 'recovery is admitted at most once');
    c.gate.dispose();
  });

  it('graceful shutdown preserves a future sleep and restart re-arms it', async () => {
    let now = 1_000;
    const a = harness(() => now);
    const { until } = a.gate.setSleep(60, 'resume after deploy', 'agent');
    a.gate.dispose();

    const persisted = JSON.parse(readFileSync(join(TMP_DIR, 'gate.wake-intents.json'), 'utf8'));
    assert.strictEqual(persisted.sleep.wakeAt, until, 'dispose must leave the durable promise intact');
    const b = harness(() => now);
    await Promise.resolve();
    assert.strictEqual(b.inferenceRequests.length, 0, 'a planned restart must not wake early');
    assert.strictEqual(b.messages.length, 0, 'a planned restart must not invent a cancellation marker');
    assert.strictEqual(b.gate.getSleepState()!.until, until, 'startup re-arms the original deadline');
    b.gate.dispose();
  });

  it('persists and re-arms skip_reply self-wake across abrupt restart', async () => {
    const a = harness(Date.now);
    a.gate.armSelfWake('agent', 1, 'skip_reply');
    const ai = a.gate as unknown as { selfWakeTimers: Map<string, ReturnType<typeof setTimeout>> };
    for (const timer of ai.selfWakeTimers.values()) clearTimeout(timer);

    const b = harness(Date.now);
    await sleep(1150);
    assert.strictEqual(b.inferenceRequests.length, 1);
    assert.strictEqual(b.inferenceRequests[0]!.source, 'self-wake');
    assert.match(b.messages[0]!, /your skip_reply timer/);
    b.gate.dispose();
  });


  it('framework invokes recovery after resident agents are registered', async () => {
    const now = Date.now();
    const configPath = join(TMP_DIR, 'gate.json');
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), JSON.stringify({
      version: 1,
      sleep: { agentName: 'agent', armedAt: now - 10_000, wakeAt: now - 1_000, source: 'sleep' },
      selfWakes: [],
    }));
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(TMP_DIR, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [],
      gate: { configPath },
    });
    await Promise.resolve();

    const messages = framework.getAgent('agent')!.getContextManager().getAllMessages();
    const text = messages.flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text).join('\n');
    assert.match(text, /wake-recovery.*overdue while the host was offline/,
      'recovery marker must reach the already-registered target agent');
    const pending = (framework as unknown as { pendingRequests: Array<{ agentName: string; source: string }> })
      .pendingRequests;
    assert.ok(pending.some((r) => r.agentName === 'agent' && r.source === 'wake-recovery'));
    await framework.stop();
  });

  it('failed Framework.create leaves a due intent in the journal', async () => {
    const now = Date.now();
    const configPath = join(TMP_DIR, 'gate.json');
    const journalPath = join(TMP_DIR, 'gate.wake-intents.json');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      sleep: { agentName: 'agent', armedAt: now - 10_000, wakeAt: now - 1_000, source: 'sleep' },
      selfWakes: [],
    }));
    const membrane = new MockMembrane();
    await assert.rejects(AgentFramework.create({
      storePath: join(TMP_DIR, 'failed-store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [], gate: { configPath },
      toolResultInlineMaxChars: 10, // validated after gate construction
    }), /toolResultInlineMaxChars/);
    const state = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.ok(state.sleep, 'failed create must not consume the due wake');
  });

  it('quarantines a corrupt journal instead of overwriting it', () => {
    const journalPath = join(TMP_DIR, 'gate.wake-intents.json');
    writeFileSync(journalPath, '{bad json');
    const h = harness(() => 12345);
    assert.ok(existsSync(`${journalPath}.corrupt-12345`));
    assert.strictEqual(existsSync(journalPath), false, 'corrupt original was moved aside');
    h.gate.dispose();
  });

  it('chunks timers longer than the Node timeout maximum', () => {
    let now = 1_000;
    const h = harness(() => now);
    h.gate.setSleep((0x7fffffff + 60_000) / 1000, undefined, 'agent');
    const timer = (h.gate as unknown as { sleepTimer: { _idleTimeout?: number } }).sleepTimer;
    assert.strictEqual(timer._idleTimeout, 0x7fffffff);
    h.gate.dispose();
  });

  it('skips invalid journal entries while recovering valid ones', () => {
    const journalPath = join(TMP_DIR, 'gate.wake-intents.json');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      sleep: { agentName: 7, armedAt: 'bad', wakeAt: null, source: 4 },
      selfWakes: [
        { agentName: false, armedAt: 1, wakeAt: 2, source: 'skip_reply' },
        { agentName: 'agent', armedAt: 1_000, wakeAt: 61_000, source: 'skip_reply' },
      ],
    }));
    const h = harness(() => 2_000);
    assert.strictEqual(h.gate.getSleepState(), null);
    const intents = (h.gate as unknown as { selfWakeIntents: Map<string, unknown> }).selfWakeIntents;
    assert.deepStrictEqual([...intents.keys()], ['agent']);
    h.gate.dispose();
  });

  it('constructor with no journal performs no wake-journal write', () => {
    const path = join(TMP_DIR, 'gate.wake-intents.json');
    const h = harness(() => 1_000);
    assert.strictEqual(existsSync(path), false);
    h.gate.dispose();
    assert.strictEqual(existsSync(path), false);
  });

  it('recovers an anonymous overdue sleep to every registered agent and includes its note', () => {
    const messages: string[] = [];
    const requests: string[] = [];
    writeFileSync(join(TMP_DIR, 'gate.wake-intents.json'), JSON.stringify({
      version: 1,
      sleep: { armedAt: 1, wakeAt: 2, source: 'sleep', note: 'check all residents' },
      selfWakes: [],
    }));
    const gate = new EventGate({
      configPath: join(TMP_DIR, 'gate.json'), now: () => 10,
      emitTrace: () => {},
      addMessage: (_p, c, _m, agent) => { messages.push(`${agent}:${c[0]!.text}`); return ''; },
      requestInference: (agent, reason) => requests.push(`${agent}:${reason}`),
      getAgentNames: () => ['a', 'b'],
    });
    gate.recoverWakeIntents();
    assert.strictEqual(messages.length, 2);
    assert.ok(messages.every((m) => m.includes('Note: check all residents')));
    assert.deepStrictEqual(requests.map((r) => r.split(':')[0]), ['a', 'b']);
    assert.ok(requests.every((r) => r.includes('check all residents')));
    gate.dispose();
  });

  it('re-arms a sleep timer that fires before its wall-clock deadline', () => {
    let now = 10_000;
    const h = harness(() => now);
    h.gate.setSleep(10, undefined, 'agent');
    const internals = h.gate as unknown as {
      sleepTimer: ReturnType<typeof setTimeout> | null;
      wakeFromSleep(reason: string): void;
    };
    if (internals.sleepTimer) clearTimeout(internals.sleepTimer);
    now = 5_000; // backward wall-clock step
    internals.wakeFromSleep('sleep-expired');
    assert.ok(internals.sleepTimer, 'early callback must arm a replacement timer');
    assert.strictEqual(h.inferenceRequests.length, 0);
    if (internals.sleepTimer) clearTimeout(internals.sleepTimer);
    h.gate.dispose();
  });
});
