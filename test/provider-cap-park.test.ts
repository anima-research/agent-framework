/**
 * Provider-cap park at the framework's exhaust funnel (noteInferenceExhausted
 * + the emitTrace intercepts): a classified cap PARKS ON THE FIRST FAILURE
 * and is structurally excluded from the poison-history breaker — no history
 * is ever shed over a billing cap (the 2026-08-11 Cairn damage). The genuine
 * poison lane must keep working unchanged with the governor present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import { AgentFramework } from '../src/framework.js';
import { ProviderCapGovernor } from '../src/provider-cap.js';

const CAP_MESSAGE =
  'You have reached your specified workspace API usage limits. ' +
  'You will regain access on 2026-09-01 at 00:00 UTC.';
const CAP_INFO = {
  resetAt: Date.UTC(2026, 8, 1),
  scope: 'workspace',
  provider: 'anthropic',
  errorClass: 'usage_cap',
};
const POISON_REASON = '400 invalid_request: tool_use ids must have a corresponding tool_result';

function capMembraneError(message = CAP_MESSAGE): MembraneError {
  return new MembraneError({
    type: 'invalid_request',
    message,
    retryable: false,
    httpStatus: 400,
    rawError: {
      name: 'APIError',
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error', message } },
    },
  });
}

function makeHarness() {
  const messages: any[] = [
    { id: 'u1', participant: 'human', content: [{ type: 'text', text: 'go' }], metadata: { messageId: '1' } },
    { id: 'a1', participant: 'agent', content: [{ type: 'tool_use', name: 'shell', id: 't1' }] },
    { id: 'r1', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'X' }] },
  ];
  const removed: string[] = [];
  const added: Array<{ content: any[]; meta: any }> = [];
  const cm = {
    getAllMessages: () => messages,
    removeMessage: (id: string) => {
      removed.push(id);
      const i = messages.findIndex((m) => m.id === id);
      if (i >= 0) messages.splice(i, 1);
    },
    addMessage: (_p: string, content: any[], meta: any) => {
      const id = `marker-${added.length}`;
      added.push({ content, meta });
      messages.push({ id, participant: 'user', content, metadata: meta });
      return id;
    },
    editMessage: (id: string, content: any[]) => {
      const m = messages.find((x) => x.id === id);
      if (m) m.content = content;
    },
  };

  const fw = Object.create(AgentFramework.prototype) as any;
  fw.consecutiveInferenceFailures = new Map();
  fw.exhaustionRewinds = new Map();
  fw.rewindEpisode = new Map();
  fw.lastInferenceAt = new Map();
  fw.overBudgetDrainInFlight = new Set();
  fw.opsAlertLastSent = new Map();
  fw.pendingRequests = [];
  fw.traceListeners = [];
  fw.inferenceFailureEscalationThreshold = 3;
  fw.logFailure = () => {};
  fw.providerCapGovernor = new ProviderCapGovernor({
    statePath: join(mkdtempSync(join(tmpdir(), 'cap-park-')), 'provider-cap.json'),
    jitterMaxMs: 0,
  });
  fw.agents = new Map([['cairn', {
    name: 'cairn',
    refusalHandling: { maxRewinds: 3 },
    getContextManager: () => cm,
  }]]);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  const restore = () => { console.error = orig; };

  return { fw, messages, removed, added, errs, restore };
}

test('a classified cap parks on the FIRST failure: no shed, no retry, one marker', () => {
  const { fw, removed, added, errs, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', CAP_INFO);
  } finally { restore(); }

  assert.equal(fw.providerCapGovernor.isParked('cairn'), true);
  assert.equal(removed.length, 0, 'no history shed');
  assert.equal(fw.pendingRequests.length, 0, 'no blind retry queued');
  const marker = added.find((m) => m.meta.kind === 'provider-cap-parked');
  assert.ok(marker, 'park marker recorded for the resident');
  assert.match(marker!.content[0].text, /NOTHING in your history is being removed/);
  assert.equal(marker!.meta.resetAt, CAP_INFO.resetAt);
  assert.ok(errs.some((e) => e.includes('[provider-cap]') && e.includes('PARKED')));
});

test('repeated cap failures NEVER reach the poison breaker, even past the hard-down streak', () => {
  const { fw, removed, added, restore } = makeHarness();
  try {
    for (let i = 0; i < 10; i++) {
      fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', CAP_INFO);
    }
  } finally { restore(); }

  assert.equal(removed.length, 0, 'ten capped failures cost zero history');
  assert.equal(added.filter((m) => m.meta.kind === 'refusal-rewind').length, 0, 'no false poison marker');
  assert.equal(added.filter((m) => m.meta.kind === 'provider-cap-parked').length, 1, 'entry marker exactly once');
  assert.equal(fw.pendingRequests.length, 0);
  assert.equal(fw.providerCapGovernor.status('cairn').attemptCount, 10, 'attempts counted, not acted on');
});

test('cap-shaped-but-unparsed (provider rewording): no park, and STILL no shed', () => {
  const { fw, removed, added, restore } = makeHarness();
  try {
    for (let i = 0; i < 6; i++) {
      fw.noteInferenceExhausted('cairn', 'cap-shaped, no parseable reset', false, 'provider_cap_unparsed');
    }
  } finally { restore(); }
  assert.equal(fw.providerCapGovernor.isParked('cairn'), false, 'no park without a parsed reset');
  assert.equal(removed.length, 0, 'a known cap sentence never costs history');
  assert.equal(added.filter((m) => m.meta.kind === 'refusal-rewind').length, 0);
});

test('the genuine poison lane is unchanged with the governor present', () => {
  const { fw, removed, restore } = makeHarness();
  try {
    for (let i = 0; i < 3; i++) {
      fw.noteInferenceExhausted('cairn', POISON_REASON, false, 'invalid_request');
    }
  } finally { restore(); }
  assert.deepEqual([...removed].sort(), ['a1', 'r1'], 'real poisoned history still sheds at the threshold');
  assert.equal(fw.pendingRequests.length, 1);
  assert.equal(fw.pendingRequests[0].reason, 'inference-failure-rewind-retry');
});

test('classifyInferenceError: cap → provider_cap + metadata; rewording → provider_cap_unparsed; poison unchanged', () => {
  const { fw, restore } = makeHarness();
  try {
    const cap = fw.classifyInferenceError(capMembraneError());
    assert.equal(cap.errorType, 'provider_cap');
    assert.equal(cap.retryable, false);
    assert.equal(cap.capResetAt, CAP_INFO.resetAt);
    assert.equal(cap.capScope, 'workspace');

    const reworded = fw.classifyInferenceError(capMembraneError(
      'You have reached your specified workspace API usage limits. Access resumes soon.',
    ));
    assert.equal(reworded.errorType, 'provider_cap_unparsed');

    const poison = fw.classifyInferenceError(new MembraneError({
      type: 'invalid_request', message: POISON_REASON, retryable: false, httpStatus: 400,
      rawError: { error: { type: 'error', error: { type: 'invalid_request_error', message: POISON_REASON } } },
    }));
    assert.equal(poison.errorType, 'invalid_request', 'poison classification untouched');
  } finally { restore(); }
});

test('the emitTrace funnel carries cap metadata end-to-end (emit-site shape)', () => {
  const { fw, removed, restore } = makeHarness();
  try {
    // Exactly what an emit site produces: classifyInferenceError spread into
    // the inference:exhausted trace event.
    fw.emitTrace({
      type: 'inference:exhausted',
      agentName: 'cairn',
      error: CAP_MESSAGE,
      ...fw.classifyInferenceError(capMembraneError()),
    });
  } finally { restore(); }
  assert.equal(fw.providerCapGovernor.isParked('cairn'), true, 'trace-borne cap parks');
  assert.equal(removed.length, 0);
});

test('a completed inference releases the park (canary success): marker, no extra wake', () => {
  const { fw, added, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', CAP_INFO);
    assert.equal(fw.providerCapGovernor.isParked('cairn'), true);
    fw.emitTrace({ type: 'inference:completed', agentName: 'cairn' });
  } finally { restore(); }

  assert.equal(fw.providerCapGovernor.isParked('cairn'), false, 'released');
  const marker = added.find((m) => m.meta.kind === 'provider-cap-released');
  assert.ok(marker, 'release marker recorded');
  assert.match(marker!.content[0].text, /Nothing was removed/);
  assert.equal(fw.pendingRequests.length, 0, 'canary release queues nothing — the canary turn ran');
  assert.equal(fw.consecutiveInferenceFailures.get('cairn'), 0, 'streak cleared');
});

test('operator release queues exactly ONE catch-up wake', () => {
  const { fw, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', CAP_INFO);
    fw.handleProviderCapRelease('cairn', 'operator:antra');
  } finally { restore(); }
  assert.equal(fw.providerCapGovernor.isParked('cairn'), false);
  assert.equal(fw.pendingRequests.length, 1);
  assert.equal(fw.pendingRequests[0].reason, 'provider-cap-cleared');
});

test('a parked canary dying on a NON-cap error frees the single permit', async () => {
  const { fw, restore } = makeHarness();
  try {
    const resetAt = Date.now() + 5;
    fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', { ...CAP_INFO, resetAt });
    await new Promise((r) => setTimeout(r, 15));
    const now = Date.now();
    assert.equal(fw.providerCapGovernor.tryAcquireCanary('cairn', now), true, 'window open');
    // The canary compile dies over budget — never reached the provider.
    fw.emitTrace({
      type: 'inference:exhausted', agentName: 'cairn',
      error: 'Compile plan would exceed hard budget', errorType: 'over_budget',
    });
    assert.equal(fw.providerCapGovernor.isParked('cairn'), true, 'still parked');
    assert.equal(fw.providerCapGovernor.tryAcquireCanary('cairn', Date.now()), true, 'permit was freed');
  } finally { restore(); }
});
