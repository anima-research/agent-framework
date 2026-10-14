/**
 * Poison-history breaker (6.5): noteInferenceExhausted used to only log at
 * streak>=3 ("[inference-hard-down]") while injecting a marker into the same
 * history, so every new push event woke the agent onto a context the API kept
 * refusing, until a manual /unstick.
 *
 * Now, at the hard-down threshold, when the failure suggests the provider
 * refused the request's content or size (shedMayHelp: an invalid_request at
 * HTTP 400, 413 or 422 or with no status, or a context_length at 413), the
 * breaker auto-quarantines: sheds the newest complete exchange (the same
 * shedNewestTurn primitive the refusal auto-rewind and /unstick use — never
 * orphaning a tool_use/thinking block), drops ONE consolidated marker, and
 * queues a retry — bounded by the refusalHandling.maxRewinds cap so it can
 * never eat the whole history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework, shedMayHelp } from '../src/framework.js';

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
    // A range by its two ends, inclusive, as context-manager's removeMessages.
    removeMessages: (fromId: string, toId: string) => {
      const from = messages.findIndex((m) => m.id === fromId);
      const to = messages.findIndex((m) => m.id === toId);
      if (from < 0 || to < from) throw new Error(`no range ${fromId}..${toId}`);
      for (const m of messages.splice(from, to - from + 1)) removed.push(m.id);
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

test('at the threshold, an invalid_request with no status (shedMayHelp) triggers an automatic rewind + retry', () => {
  const { fw, removed, added, errs, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // 1
    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // 2
    assert.equal(removed.length, 0, 'no rewind before the threshold');

    fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request'); // 3 → breaker trips
  } finally { restore(); }

  // The poisoned tool exchange was shed as a COMPLETE pair (no orphans).
  assert.deepEqual([...removed].sort(), ['a1', 'r1']);

  // One consolidated rewind marker, saying the API kept refusing the requests
  // that carried the shed turns, not that the conversation was at fault.
  const marker = added.find((m) => m.meta.kind === 'refusal-rewind');
  assert.ok(marker, 'rewind marker added');
  assert.equal(marker!.meta.cause, 'inference-failure');
  assert.match(marker!.content[0].text, /set aside because the model API kept refusing the requests that carried them \(/);
  assert.match(marker!.content[0].text, /\), so that the conversation could go on\./);
  assert.doesNotMatch(marker!.content[0].text, /rejecting the conversation/);

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
  // The breaker keys on the membrane error type and the HTTP status
  // (shedMayHelp), not on `retryable`. membrane marks auth (expired key),
  // context_length, abort, safety and unsupported all non-retryable, but for
  // none of them, with no status, is shedding the newest exchange likely to
  // help. Shedding good exchanges,
  // with a rewind marker saying the API kept refusing them, on an expired API
  // key is exactly the category error this guards.
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

// Anarchid's review of membrane #56 (M3): from #56 (merged, not yet in a
// release) one status table serves every adapter, so `invalid_request` also
// reaches agent-framework for an Anthropic 404 (a model that doesn't exist),
// which no shed can fix. With 0.5.86 the raw-fetch Responses adapter already
// files every status it doesn't list as invalid_request. The breaker runs
// only for an invalid_request at 400, 413 or 422, the statuses that suggest
// the provider refused the request's content or size (a heuristic: other
// refusals come back the same way), and for a context_length at 413, the
// label #56 gives a 413; an error without a status keeps the type-only rule.
test('the breaker reads the status: a 404 invalid_request never sheds, a 400 does', () => {
  const missingModel = makeHarness();
  const alerts: any[] = [];
  missingModel.fw.onTrace((e: any) => { if (e.type === 'ops:alert') alerts.push(e); });
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
  assert.ok(alerts.some((a) => a.kind === 'hard-down' && a.agentName === 'cairn'), 'and raises the hard-down ops alert');

  const rejected = makeHarness();
  try {
    for (let i = 0; i < 3; i++) {
      rejected.fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request',
        { httpStatus: 400, providerErrorCode: 'invalid_request_error' });
    }
  } finally { rejected.restore(); }
  assert.deepEqual([...rejected.removed].sort(), ['a1', 'r1'], 'a 400 at the threshold sheds, as before');
});

test('the current failure decides the shed, whatever failed before it in the streak', () => {
  // 400, 400, then a 404 at the threshold: nothing is shed.
  const ending404 = makeHarness();
  try {
    for (const httpStatus of [400, 400, 404]) {
      ending404.fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request', { httpStatus });
    }
  } finally { ending404.restore(); }
  assert.deepEqual(ending404.removed, [], '400, 400, 404: nothing is shed at the third failure');
  assert.ok(ending404.errs.some((e) => e.includes('[inference-hard-down]')), 'though it is hard-down');

  // 404, 404, then a 400 at the threshold: the 400 sheds.
  const ending400 = makeHarness();
  try {
    for (const httpStatus of [404, 404, 400]) {
      ending400.fw.noteInferenceExhausted('cairn', REASON, false, 'invalid_request', { httpStatus });
    }
  } finally { ending400.restore(); }
  assert.deepEqual([...ending400.removed].sort(), ['a1', 'r1'], '404, 404, 400: the 400 sheds at the third failure');
});

test('a 413 sheds under either label it arrives with, and a context_length at 400 or 422 keeps the history', () => {
  // membrane 0.5.86's Responses adapter files a 413 as invalid_request, and
  // membrane #56 as context_length: the arm takes both.
  for (const errorType of ['invalid_request', 'context_length']) {
    const tooLarge = makeHarness();
    try {
      for (let i = 0; i < 3; i++) {
        tooLarge.fw.noteInferenceExhausted('cairn', '413 request too large', false, errorType, { httpStatus: 413 });
      }
    } finally { tooLarge.restore(); }
    assert.deepEqual([...tooLarge.removed].sort(), ['a1', 'r1'], `${errorType} at 413 sheds at the threshold`);
  }

  // A token overflow is for the context budget and compression to prevent.
  for (const httpStatus of [400, 422]) {
    const overflow = makeHarness();
    try {
      for (let i = 0; i < 5; i++) {
        overflow.fw.noteInferenceExhausted('cairn', 'prompt is too long', false, 'context_length', { httpStatus });
      }
    } finally { overflow.restore(); }
    assert.deepEqual(overflow.removed, [], `context_length at ${httpStatus} keeps the history`);
    assert.ok(overflow.errs.some((e) => e.includes('[inference-hard-down]')), `context_length at ${httpStatus} is still reported hard-down`);
  }
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

test('shedMayHelp: an invalid_request at 400, 413 or 422 or with no status, or a context_length at 413, and nothing else', () => {
  // Every membrane error type (0.5.86), the framework's own two, and none.
  const types = ['invalid_request', 'rate_limit', 'context_length', 'auth', 'server', 'network', 'timeout', 'abort',
    'safety', 'unsupported', 'unknown', 'over_budget', 'context_refusal', undefined];
  const statuses: Array<number | undefined> = [undefined];
  for (let status = 100; status <= 599; status++) statuses.push(status);
  for (const type of types) {
    for (const status of statuses) {
      const expected = (type === 'invalid_request' && (status === undefined || status === 400 || status === 413 || status === 422))
        || (type === 'context_length' && status === 413);
      assert.equal(shedMayHelp(type, status), expected, `${String(type)} at ${String(status)}`);
    }
  }
});
