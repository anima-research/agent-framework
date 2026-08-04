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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';

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
