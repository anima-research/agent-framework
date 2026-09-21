/**
 * OverBudget deadlock breaker (PR #58, 15befaa): when compile throws
 * context-manager's OverBudgetError, the compression drain never runs — it is
 * driven by successful activity, which the over-budget state prevents. A
 * closed loop with no internal exit (field data 2026-07-10: 36 minutes
 * hard-down, zero self-rescue). noteInferenceExhausted breaks it by kicking
 * the strategy drain (cm.tick()) directly.
 *
 * The trigger is the classified errorType 'over_budget'. Since
 * context-manager#41/#71 the classes are exported from CM's root, so the
 * primary match is a real cross-package `instanceof`; `err.name` stays as a
 * fallback for dual-CM-copy deployments, and the message-prose match remains
 * a last resort for serialized reasons. These tests pin all of it so a CM
 * message rewording — or a second CM copy — cannot silently kill the
 * breaker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import { OverBudgetError, UncoveredDropError } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';

function makeHarness(tick: () => Promise<void>) {
  const cm = {
    addMessage: () => 'marker-id',
    tick,
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
  fw.agents = new Map([['cairn', {
    name: 'cairn',
    refusalHandling: { maxRewinds: 3 },
    getContextManager: () => cm,
  }]]);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  const restore = () => { console.error = orig; };

  return { fw, errs, restore };
}

/** Let the fire-and-forget drain IIFE's microtask chain run to quiescence. */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const OVER_BUDGET_REASON =
  'Compile plan would exceed hard budget: head=41200 tail=8100 middle=62000 budget=100000';

test('classification: a REAL context-manager OverBudgetError classifies via instanceof', () => {
  const { fw, restore } = makeHarness(async () => {});
  restore();
  const real = new OverBudgetError({
    budget: 4000,
    actual: 8000,
    diagnostics: { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 1, deepestLevel: 1 },
  });
  assert.deepEqual(fw.classifyInferenceError(real), { errorType: 'over_budget' });
});

test('classification: a REAL UncoveredDropError classifies as context_refusal via instanceof', () => {
  const { fw, restore } = makeHarness(async () => {});
  restore();
  const real = new UncoveredDropError({
    droppedIds: ['m1'],
    site: 'selectHierarchical',
    diagnostics: { budget: 4000, totalTokens: 8000 },
  });
  assert.deepEqual(fw.classifyInferenceError(real), { errorType: 'context_refusal' });
});

test('classification: err.name OverBudgetError → over_budget, regardless of message wording', () => {
  const fw = Object.create(AgentFramework.prototype) as any;

  // The load-bearing pin: classification must NOT depend on CM's message
  // prose, which CM can reword without knowing AF gates a breaker on it.
  const reworded = new Error('context plan no longer fits (reworded in some future CM)');
  reworded.name = 'OverBudgetError';
  assert.deepEqual(fw.classifyInferenceError(reworded), { errorType: 'over_budget' });

  // Membrane errors keep their own typed classification.
  const membraneErr = new MembraneError({
    type: 'invalid_request',
    message: '400 bad request',
    retryable: false,
    rawError: null,
  });
  assert.deepEqual(
    fw.classifyInferenceError(membraneErr),
    { retryable: false, errorType: 'invalid_request' },
  );

  // Anything else stays unclassified.
  assert.deepEqual(fw.classifyInferenceError(new Error('boom')), {});
});

test('errorType over_budget kicks the drain: 8 ticks, honest success log', async () => {
  let ticks = 0;
  const { fw, errs, restore } = makeHarness(async () => { ticks++; });
  try {
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    await settle(20);
  } finally { restore(); }

  assert.equal(ticks, 8);
  assert.ok(
    errs.some((e) => e.includes('drain kicked for cairn') && e.includes('8 ticks')),
    `success log with real tick count, got: ${errs.join(' | ')}`,
  );
});

test('message fallback: "exceed hard budget" prose kicks even without errorType', async () => {
  let ticks = 0;
  const { fw, restore } = makeHarness(async () => { ticks++; });
  try {
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, undefined);
    await settle(20);
  } finally { restore(); }
  assert.equal(ticks, 8);
});

test('unrelated failures never kick the drain', async () => {
  let ticks = 0;
  const { fw, restore } = makeHarness(async () => { ticks++; });
  try {
    fw.noteInferenceExhausted('cairn', '529 overloaded', true, 'server');
    fw.noteInferenceExhausted('cairn', '400 invalid request', false, 'invalid_request');
    fw.noteInferenceExhausted('cairn', 'weird transport error', undefined, undefined);
    await settle(20);
  } finally { restore(); }
  assert.equal(ticks, 0);
});

test('overlapping kicks are suppressed: one drain per agent at a time', async () => {
  let started = 0;
  const gates: Array<() => void> = [];
  const { fw, errs, restore } = makeHarness(
    () => { started++; return new Promise<void>((r) => { gates.push(r); }); },
  );
  try {
    // The scenario the breaker exists for: every activation fails, repeatedly.
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    await settle();

    // Only ONE kick started; its first tick is still in flight.
    assert.equal(started, 1);

    // Release ticks one at a time — exactly 8 run, then the drain finishes.
    for (let i = 0; i < 8; i++) {
      gates[i]!();
      await settle();
    }
    assert.equal(started, 8, 'exactly one drain worth of ticks, not three');
    assert.equal(errs.filter((e) => e.includes('drain kicked for cairn')).length, 1);

    // The in-flight flag was cleared: a NEW failure kicks again.
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    await settle();
    assert.equal(started, 9);
  } finally { restore(); }
});

test('a failing tick is logged with the real count and clears the in-flight flag', async () => {
  let calls = 0;
  const { fw, errs, restore } = makeHarness(async () => {
    calls++;
    if (calls === 3) throw new Error('strategy exploded');
  });
  try {
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    await settle(20);
    assert.ok(errs.some((e) => e.includes('drain kick failed for cairn after 2 ticks')));
    assert.equal(fw.overBudgetDrainInFlight.size, 0, 'flag cleared on failure');

    // Recovery: the next failure can kick again.
    fw.noteInferenceExhausted('cairn', OVER_BUDGET_REASON, undefined, 'over_budget');
    await settle(20);
    assert.ok(calls > 3, 'subsequent kick ran');
  } finally { restore(); }
});
