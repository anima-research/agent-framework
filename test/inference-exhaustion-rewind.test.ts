/**
 * Poison-history breaker (6.5): noteInferenceExhausted used to only log at
 * streak>=3 ("[inference-hard-down]") while injecting a marker into the SAME
 * poisoned history — every new push event woke the agent onto a context the
 * API rejects, forever, until a manual /unstick.
 *
 * Now, at the hard-down threshold with a known NON-retryable failure, the
 * breaker auto-quarantines: sheds the newest complete exchange (the same
 * shedNewestTurn primitive the refusal auto-rewind and /unstick use — never
 * orphaning a tool_use/thinking block), drops ONE consolidated marker, and
 * queues a retry — bounded by the refusalHandling.maxRewinds cap so it can
 * never eat the whole history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework, rejectsHistory } from '../src/framework.js';

function makeHarness(opts?: { maxRewinds?: number; messages?: any[] }) {
  const messages: any[] = opts?.messages ?? [
    { id: 'u1', participant: 'human', content: [{ type: 'text', text: 'go' }], metadata: { messageId: '1' } },
    { id: 'a1', participant: 'agent', content: [{ type: 'tool_use', name: 'shell', id: 't1' }] },
    { id: 'r1', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'X'.repeat(9_000_000) }] },
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
  fw.lastInferenceAt = new Map(); // upstream last-inference tracking; noteInferenceExhausted writes it
  fw.pendingRequests = [];
  fw.traceListeners = [];
  fw.inferenceFailureEscalationThreshold = 3;
  fw.agents = new Map([['cairn', {
    name: 'cairn',
    refusalHandling: { maxRewinds: opts?.maxRewinds ?? 3 },
    getContextManager: () => cm,
  }]]);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  const restore = () => { console.error = orig; };

  return { fw, messages, removed, added, errs, restore };
}

const REASON = '400 invalid_request: tool_use ids must have a corresponding tool_result';

test('at the threshold, invalid_request failures trigger an automatic rewind + retry', () => {
  const { fw, removed, added, errs, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // 1
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // 2
    assert.equal(removed.length, 0, 'no rewind before the threshold');

    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // 3 → breaker trips
  } finally { restore(); }

  // The poisoned tool exchange was shed as a COMPLETE pair (no orphans).
  assert.deepEqual([...removed].sort(), ['a1', 'r1']);

  // One consolidated rewind marker, attributed to the API rejection.
  const marker = added.find((m) => m.meta.kind === 'refusal-rewind');
  assert.ok(marker, 'rewind marker added');
  assert.equal(marker!.meta.cause, 'inference-failure');
  assert.match(marker!.content[0].text, /set aside/);
  assert.match(marker!.content[0].text, /rejecting/);

  // A retry was queued so the rewound history is verified immediately.
  assert.equal(fw.pendingRequests.length, 1);
  assert.equal(fw.pendingRequests[0].reason, 'inference-failure-rewind-retry');

  assert.ok(errs.some((e) => e.includes('[inference-rewind]') && e.includes('auto-quarantined')));
});

test('retryable / unknown-retryability failures NEVER shed history (outages cost nothing)', () => {
  const { fw, removed, restore } = makeHarness();
  try {
    for (let i = 0; i < 6; i++) fw.noteInferenceExhausted('cairn', '529 overloaded', true, 'server');
    for (let i = 0; i < 6; i++) fw.noteInferenceExhausted('cairn', 'weird transport error', undefined, undefined);
  } finally { restore(); }
  assert.equal(removed.length, 0, 'transient failures must not consume history');
  assert.equal(fw.pendingRequests.length, 0);
});

test('non-retryable but NON-poison failures (auth/context_length/abort) NEVER shed history', () => {
  // The breaker keys on the membrane error TYPE, not on `retryable`. membrane
  // marks auth (expired key), context_length, abort, safety and unsupported all
  // non-retryable — but none of them mean the history is poisoned. Shedding
  // good exchanges + stamping a false "the API kept rejecting your history"
  // marker on an expired API key is exactly the category error this guards.
  for (const errorType of ['auth', 'context_length', 'abort', 'safety', 'unsupported']) {
    const { fw, removed, added, restore } = makeHarness();
    try {
      // Well past the hard-down threshold, all with retryable === false.
      for (let i = 0; i < 6; i++) fw.noteInferenceExhausted('cairn', `non-retryable ${errorType}`, false, errorType);
    } finally { restore(); }
    assert.equal(removed.length, 0, `${errorType}: history must not be shed`);
    assert.equal(fw.pendingRequests.length, 0, `${errorType}: no rewind-retry queued`);
    assert.equal(
      added.filter((m) => m.meta.kind === 'refusal-rewind').length,
      0,
      `${errorType}: no false rejection marker`,
    );
  }
});

test('the breaker is capped: repeated failures stop shedding at maxRewinds', () => {
  const { fw, removed, errs, restore } = makeHarness({
    maxRewinds: 2,
    messages: [
      { id: 'm1', participant: 'human', content: [{ type: 'text', text: 'a' }], metadata: { messageId: '1' } },
      { id: 'm2', participant: 'human', content: [{ type: 'text', text: 'b' }], metadata: { messageId: '2' } },
      { id: 'm3', participant: 'human', content: [{ type: 'text', text: 'c' }], metadata: { messageId: '3' } },
      { id: 'm4', participant: 'human', content: [{ type: 'text', text: 'd' }], metadata: { messageId: '4' } },
    ],
  });
  try {
    // 10 consecutive non-retryable failures: the breaker fires from streak 3 on,
    // but only sheds up to the cap (2), then holds.
    for (let i = 0; i < 10; i++) fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request');
  } finally { restore(); }

  assert.equal(removed.length, 2, `cap of 2 respected, shed: ${removed.join(', ')}`);
  assert.equal(fw.pendingRequests.length, 2, 'retries stop when the cap is hit');
  assert.ok(errs.some((e) => e.includes('rewind cap 2 reached')));
  // History still has the untouched older messages — the breaker cannot eat it all.
  assert.equal(fw.exhaustionRewinds.get('cairn'), 2);
});

test('a successful inference resets both the streak and the rewind budget', () => {
  const { fw, removed, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request');
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request');
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // shed #1
    assert.equal(removed.length, 2); // one complete tool exchange

    fw.emitTrace({ type: 'inference:completed', agentName: 'cairn' });
    assert.equal(fw.consecutiveInferenceFailures.get('cairn'), 0);
    assert.equal(fw.exhaustionRewinds.get('cairn'), 0);
  } finally { restore(); }
});

test('nothing left to shed: the breaker degrades to logging, no crash, no loop', () => {
  const { fw, removed, errs, restore } = makeHarness({
    messages: [
      { id: 'mk', participant: 'user', content: [{ type: 'text', text: 'sys' }], metadata: { system: true } },
    ],
  });
  try {
    for (let i = 0; i < 5; i++) fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request');
  } finally { restore(); }
  assert.equal(removed.length, 0);
  assert.equal(fw.pendingRequests.length, 0, 'no retry queued when nothing was repaired');
  assert.ok(errs.some((e) => e.includes('nothing left to shed')));
});

// Anarchid's review of membrane #56 (M3): from #56 on, membrane's boundary
// classifies every status, so `invalid_request` also reaches agent-framework
// for a 404 (a model that doesn't exist), which no shed can fix. The breaker
// runs only for a 400 or 422, the statuses membrane reads as rejected
// content; an error without a status keeps the type-only rule.
test('the breaker reads the status: a 404 invalid_request never sheds, a 400 does', () => {
  const missingModel = makeHarness();
  try {
    for (let i = 0; i < 5; i++) {
      missingModel.fw.noteInferenceExhausted('cairn', '404 model: claude-typo not found', false, 'invalid_request',
        { httpStatus: 404, providerErrorCode: 'not_found_error' });
    }
  } finally { missingModel.restore(); }
  assert.deepEqual(missingModel.removed, [], 'past the threshold, and nothing was shed');
  assert.ok(!missingModel.added.some((m) => m.meta.kind === 'refusal-rewind'));
  assert.equal(missingModel.fw.pendingRequests.length, 0);
  assert.ok(missingModel.errs.some((e) => e.includes('[inference-hard-down]')), 'it is still reported hard-down');

  const rejected = makeHarness();
  try {
    for (let i = 0; i < 3; i++) {
      rejected.fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request',
        { httpStatus: 400, providerErrorCode: 'invalid_request_error' });
    }
  } finally { rejected.restore(); }
  assert.deepEqual([...rejected.removed].sort(), ['a1', 'r1'], 'a 400 at the threshold sheds, as before');
});

test('the status reaches the breaker from the inference:exhausted trace', () => {
  const h = makeHarness();
  try {
    for (let i = 0; i < 4; i++) {
      h.fw.emitTrace({ type: 'inference:exhausted', agentName: 'cairn', error: '404 model: claude-typo not found',
        retryable: false, errorType: 'invalid_request', httpStatus: 404, providerErrorCode: 'not_found_error' });
    }
  } finally { h.restore(); }
  assert.deepEqual(h.removed, [], 'the trace carried the 404 to the gate');
  assert.ok(h.errs.some((e) => e.includes('[inference-hard-down]')));
});

test('rejectsHistory: an invalid_request at 400 or 422, or with no status, and nothing else', () => {
  assert.equal(rejectsHistory('invalid_request', 400), true);
  assert.equal(rejectsHistory('invalid_request', 422), true, 'a validation server rejects content with 422');
  assert.equal(rejectsHistory('invalid_request', undefined), true, 'an older membrane reports no status');
  for (const status of [401, 403, 404, 405, 409, 410, 413, 429, 500]) {
    assert.equal(rejectsHistory('invalid_request', status), false, `status ${status}`);
  }
  for (const type of ['auth', 'context_length', 'rate_limit', 'server', 'abort', undefined]) {
    assert.equal(rejectsHistory(type, 400), false, `type ${String(type)}`);
  }
});
