import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

/**
 * noteInferenceExhausted is the central observability hook for a fully-failed
 * inference. It's private and the full framework is heavy to construct, so we
 * exercise it on a prototype instance with just the fields it touches stubbed.
 */
function makeHarness() {
  const fw = Object.create(AgentFramework.prototype) as any;
  fw.consecutiveInferenceFailures = new Map<string, number>();
  fw.inferenceFailureEscalationThreshold = 3;
  fw.exhaustionRewinds = new Map<string, number>();
  fw.rewindEpisode = new Map();
  fw.lastInferenceAt = new Map<string, object>(); // upstream last-inference tracking; noteInferenceExhausted writes it
  fw.pendingRequests = [];
  // opsAlert plumbing (hard-down now routes through it): trace fan-out +
  // webhook cooldown state. No CONNECTOME_OPS_WEBHOOK in env → no fetch.
  fw.traceListeners = [];
  fw.opsAlertLastSent = new Map<string, number>();
  fw.opsAlertCooldownMs = 15 * 60_000;

  const markers: Array<{ text: string; meta: any }> = [];
  fw.agents = new Map([['cairn', {
    getContextManager: () => ({
      addMessage: (_p: string, content: any[], meta: any) => {
        markers.push({ text: content[0].text, meta });
      },
    }),
  }]]);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  const restore = () => { console.error = orig; };

  return { fw, markers, errs, restore };
}

test('exhausted inference: stderr line + [inference-failed] chronicle marker', () => {
  const { fw, markers, errs, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', '400 image exceeds 5 MB');
  } finally { restore(); }

  // (1) stderr, with the underlying reason
  assert.ok(errs.some(e => e.includes('[inference-failed]') && e.includes('image exceeds 5 MB')),
    'should log the failure + reason to stderr');
  // (2) agent-facing chronicle marker carrying the reason, tagged for filtering
  assert.equal(markers.length, 1);
  assert.match(markers[0].text, /\[inference-failed\]/);
  assert.match(markers[0].text, /image exceeds 5 MB/);
  assert.equal(markers[0].meta.kind, 'inference-failed');
  assert.equal(markers[0].meta.consecutive, 1);
});

test('consecutive failures escalate to hard-down; success resets the streak', () => {
  const { fw, errs, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', 'boom');   // 1
    fw.noteInferenceExhausted('cairn', 'boom');   // 2
    assert.ok(!errs.some(e => e.includes('inference-hard-down')), 'no escalation before threshold');
    fw.noteInferenceExhausted('cairn', 'boom');   // 3 → hard-down
    assert.ok(errs.some(e => e.includes('[inference-hard-down]') && e.includes('3 consecutive')),
      'should escalate at the threshold');
    assert.equal(fw.consecutiveInferenceFailures.get('cairn'), 3);

    // A successful inference:completed clears the streak (via emitTrace).
    fw.traceListeners = [];
    fw.emitTrace({ type: 'inference:completed', agentName: 'cairn' });
    assert.equal(fw.consecutiveInferenceFailures.get('cairn'), 0);
  } finally { restore(); }
});

test('per-agent isolation: one agent failing does not flag another', () => {
  const { fw, restore } = makeHarness();
  fw.agents.set('lena', { getContextManager: () => ({ addMessage: () => {} }) });
  try {
    fw.noteInferenceExhausted('cairn', 'x');
    fw.noteInferenceExhausted('cairn', 'x');
  } finally { restore(); }
  assert.equal(fw.consecutiveInferenceFailures.get('cairn'), 2);
  assert.equal(fw.consecutiveInferenceFailures.get('lena') ?? 0, 0);
});
