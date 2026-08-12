/**
 * Provider-cap classification (provider-cap.ts): structural invariants plus an
 * ANCHORED message parse. These tests pin both directions — the canonical cap
 * error classifies, and every near-miss (wrong type/status, missing raw body,
 * free-text lookalikes, unparseable/invalid dates) does NOT. The near-misses
 * are the load-bearing half: a loosened classifier would park agents over
 * ordinary 400s, and a tightened one would re-open the 2026-08-11 Cairn
 * damage (history shed + 3.4 s retries over a billing cap).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MembraneError } from '@animalabs/membrane';
import {
  classifyProviderCapError,
  capShapedButUnparsed,
} from '../src/provider-cap.js';

const CAP_MESSAGE =
  'You have reached your specified workspace API usage limits. ' +
  'You will regain access on 2026-09-01 at 00:00 UTC.';

function capError(overrides?: {
  message?: string;
  bodyMessage?: string | null;
  type?: string;
  httpStatus?: number;
  bodyType?: string | null;
}): MembraneError {
  const message = overrides?.message ?? CAP_MESSAGE;
  const bodyMessage = overrides?.bodyMessage === null
    ? undefined
    : overrides?.bodyMessage ?? message;
  const bodyType = overrides?.bodyType === null
    ? undefined
    : overrides?.bodyType ?? 'invalid_request_error';
  return new MembraneError({
    type: (overrides?.type ?? 'invalid_request') as 'invalid_request',
    message,
    retryable: false,
    httpStatus: overrides?.httpStatus ?? 400,
    rawError: {
      name: 'APIError',
      message,
      status: overrides?.httpStatus ?? 400,
      error: {
        type: 'error',
        error: {
          ...(bodyType ? { type: bodyType } : {}),
          ...(bodyMessage ? { message: bodyMessage } : {}),
        },
      },
    },
  });
}

test('canonical workspace cap classifies with the exact UTC reset instant', () => {
  const cls = classifyProviderCapError(capError());
  assert.ok(cls, 'must classify');
  assert.equal(cls!.provider, 'anthropic');
  assert.equal(cls!.scope, 'workspace');
  assert.equal(cls!.errorClass, 'usage_cap');
  assert.equal(cls!.resetAt, Date.UTC(2026, 8, 1, 0, 0, 0));
});

test('organization scope, seconds, parentheses and prefix variants classify', () => {
  for (const msg of [
    'You have reached your specified organization API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.',
    'You have reached your specified workspace API usage limits. You will regain access on 2026-09-01 at 12:30:45 UTC',
    'You have reached your specified workspace API usage limits. You will regain access on 2026-09-01 at 00:00 (UTC).',
  ]) {
    const cls = classifyProviderCapError(capError({ message: msg, bodyMessage: msg }));
    assert.ok(cls, `must classify: ${msg}`);
  }
  // SDK-style "400 " status prefix on the Error message, structured body absent
  // a message of its own: still classifies via the Error message fallback.
  const prefixed = capError({ message: `400 ${CAP_MESSAGE}`, bodyMessage: null });
  assert.ok(classifyProviderCapError(prefixed), 'status-prefixed message classifies');
});

test('the reset instant comes from the provider body message when both exist', () => {
  const bodyMsg =
    'You have reached your specified workspace API usage limits. ' +
    'You will regain access on 2026-10-15 at 06:00 UTC.';
  const cls = classifyProviderCapError(capError({ message: CAP_MESSAGE, bodyMessage: bodyMsg }));
  assert.ok(cls);
  assert.equal(cls!.resetAt, Date.UTC(2026, 9, 15, 6, 0, 0), 'body message wins');
});

test('structural near-misses never classify', () => {
  // Wrong membrane type / status.
  assert.equal(classifyProviderCapError(capError({ type: 'rate_limit' })), null);
  assert.equal(classifyProviderCapError(capError({ httpStatus: 429 })), null);
  // Body error type missing or different — an error that lost its raw body
  // (serialization boundary, log rehydration) fails closed.
  assert.equal(classifyProviderCapError(capError({ bodyType: null })), null);
  assert.equal(classifyProviderCapError(capError({ bodyType: 'permission_error' })), null);
  // A plain Error carrying the cap sentence is NOT structured evidence.
  assert.equal(classifyProviderCapError(new Error(CAP_MESSAGE)), null);
  assert.equal(capShapedButUnparsed(new Error(CAP_MESSAGE)), false);
  // An ordinary poisoned-history 400 must stay in the poison lane.
  const poison = capError({
    message: '400 tool_use ids must have a corresponding tool_result',
    bodyMessage: 'tool_use ids must have a corresponding tool_result',
  });
  assert.equal(classifyProviderCapError(poison), null);
  assert.equal(capShapedButUnparsed(poison), false);
});

test('free-text lookalikes with extra prose never classify (anchoring)', () => {
  for (const msg of [
    `NOTE: ${CAP_MESSAGE}`,
    `${CAP_MESSAGE} Please contact support.`,
    'Your workspace API usage limits were reached. You will regain access on 2026-09-01 at 00:00 UTC.',
  ]) {
    const cls = classifyProviderCapError(capError({ message: msg, bodyMessage: msg }));
    assert.equal(cls, null, `must not classify: ${msg}`);
  }
});

test('cap-shaped but unparseable reset: no classification, but the shape is flagged', () => {
  for (const msg of [
    // Reworded reset clause.
    'You have reached your specified workspace API usage limits. Access resumes next month.',
    // Date missing entirely.
    'You have reached your specified workspace API usage limits.',
    // Invalid calendar date — a regex alone would accept this.
    'You have reached your specified workspace API usage limits. You will regain access on 2026-13-45 at 00:00 UTC.',
    // Invalid time.
    'You have reached your specified workspace API usage limits. You will regain access on 2026-09-01 at 25:61 UTC.',
  ]) {
    const err = capError({ message: msg, bodyMessage: msg });
    assert.equal(classifyProviderCapError(err), null, `must not classify: ${msg}`);
    assert.equal(capShapedButUnparsed(err), true, `must flag shape: ${msg}`);
  }
});

test('LIVE SHAPE (Cairn record f492eaec…, 2026-08-12): JSON-bodied SDK message with rawError stripped classifies', () => {
  // The Anthropic SDK sets APIError.message to `400 {<full JSON body>}`, and a
  // MembraneError that crossed a serialization boundary (logged, rehydrated)
  // arrives with rawError gone — verified against a live Cairn 400. The body
  // is recovered STRUCTURALLY (strict `NNN {json}` shape + JSON.parse + the
  // same error-type invariant), never by prose-matching the message.
  const body = {
    type: 'error',
    error: { type: 'invalid_request_error', message: CAP_MESSAGE },
    request_id: 'req_test01',
  };
  const err = new MembraneError({
    type: 'invalid_request',
    message: `400 ${JSON.stringify(body)}`,
    retryable: false,
    httpStatus: 400,
    rawError: undefined,
  });
  const cls = classifyProviderCapError(err);
  assert.ok(cls, 'live message shape must classify without rawError');
  assert.equal(cls!.resetAt, Date.UTC(2026, 8, 1));
  assert.equal(cls!.scope, 'workspace');

  // The same JSON-bodied shape with a different provider error type stays out.
  const otherBody = { type: 'error', error: { type: 'permission_error', message: CAP_MESSAGE } };
  const other = new MembraneError({
    type: 'invalid_request', message: `400 ${JSON.stringify(otherBody)}`,
    retryable: false, httpStatus: 400, rawError: undefined,
  });
  assert.equal(classifyProviderCapError(other), null);
  assert.equal(capShapedButUnparsed(other), false);

  // And a non-JSON message with no rawError still fails closed.
  const bare = new MembraneError({
    type: 'invalid_request', message: CAP_MESSAGE, retryable: false, httpStatus: 400, rawError: undefined,
  });
  assert.equal(classifyProviderCapError(bare), null, 'no structured body anywhere → no classification');
});

test('a past reset instant still classifies (the governor owns skew handling)', () => {
  const msg =
    'You have reached your specified workspace API usage limits. ' +
    'You will regain access on 2020-01-01 at 00:00 UTC.';
  const cls = classifyProviderCapError(capError({ message: msg, bodyMessage: msg }));
  assert.ok(cls, 'past instants are the governor’s problem, not the classifier’s');
  assert.equal(cls!.resetAt, Date.UTC(2020, 0, 1));
});
