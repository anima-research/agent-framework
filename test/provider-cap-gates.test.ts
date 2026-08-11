/**
 * Provider-cap dispatch gates + the Cairn regression (spec item 7).
 *
 * Cairn, 2026-08-10/11: 12,774 identical workspace-cap 400s — the maintenance
 * loop hot-retried a non-retryable error every ~3.4 s for a day and a half.
 * The regression here drives the SAME loop shape (many maintenance passes
 * against a capped provider) and requires it to collapse to EXACTLY ONE
 * provider call, zero history mutation, and a durable parked receipt; a
 * simulated restart (fresh framework state over the same state file) must
 * make ZERO further provider calls. Then the release lanes: the maintenance
 * canary, the wake canary, and the operator cap_clear/nudge/unstick plane.
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

/** Full-enough framework harness: maintenance loop + dispatch loop + host
 *  commands, with a counting fake provider behind cm.tick / startAgentStream. */
function makeHarness(opts?: { statePath?: string; capOnTick?: () => boolean }) {
  const statePath = opts?.statePath
    ?? join(mkdtempSync(join(tmpdir(), 'cap-gates-')), 'provider-cap.json');

  const counters = { providerCalls: 0, dispatches: 0 };
  const added: Array<{ content: any[]; meta: any }> = [];
  const removed: string[] = [];
  const capOnTick = opts?.capOnTick ?? (() => true);

  const cm = {
    isReady: () => false,
    setToolDefinitions: () => {},
    getPendingWork: () => undefined,
    getStrategy: () => ({}),
    getAllMessages: () => [] as any[],
    removeMessage: (id: string) => { removed.push(id); },
    addMessage: (_p: string, content: any[], meta: any) => {
      added.push({ content, meta });
      return `marker-${added.length}`;
    },
    tick: async () => {
      counters.providerCalls++;
      if (capOnTick()) throw capMembraneError();
    },
  };

  const agent = {
    name: 'cairn',
    refusalHandling: { maxRewinds: 3 },
    state: { status: 'idle' },
    canUseTool: () => true,
    getContextManager: () => cm,
  };

  const fw = Object.create(AgentFramework.prototype) as any;
  fw.running = true;
  fw.agents = new Map([['cairn', agent]]);
  fw.consecutiveInferenceFailures = new Map();
  fw.exhaustionRewinds = new Map();
  fw.rewindEpisode = new Map();
  fw.lastInferenceAt = new Map();
  fw.overBudgetDrainInFlight = new Set();
  fw.opsAlertLastSent = new Map();
  fw.pendingRequests = [];
  fw.traceListeners = [];
  fw.inferenceFailureEscalationThreshold = 3;
  fw.maintenanceRunId = 0;
  fw.currentMaintenanceRun = null;
  fw.maintenanceHistory = [];
  fw.activeTurnTokens = new Map();
  fw.staleWarnAt = new Map();
  fw.capHeldWarnAt = new Map();
  fw.queue = { depth: 0 };
  fw.inferencePolicy = { shouldInfer: () => true };
  fw.forcedRewind = new Map();
  fw.refusalRewinds = new Map();
  fw.logFailure = () => {};
  fw.getToolsForAgent = () => [];
  fw.sweepExpiredConversations = () => {};
  fw.startAgentStream = async () => { counters.dispatches++; return true; };
  fw.providerCapGovernor = new ProviderCapGovernor({ statePath, jitterMaxMs: 0 });
  fw.providerCapGovernor.load(Date.now());

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  const restore = () => { console.error = orig; };

  return { fw, cm, counters, added, removed, errs, restore, statePath };
}

test('CAIRN REGRESSION: 12,774-failure maintenance loop collapses to ONE provider call, $0-shaped, zero history mutation', async () => {
  const { fw, counters, added, removed, restore, statePath } = makeHarness();
  try {
    // The production shape: the maintenance timer fires pass after pass.
    for (let pass = 0; pass < 200; pass++) {
      await fw.runQueuedMaintenance();
    }
  } finally { restore(); }

  assert.equal(counters.providerCalls, 1, 'exactly one provider call — not 12,774');
  assert.equal(removed.length, 0, 'zero messages removed');
  assert.equal(fw.providerCapGovernor.isParked('cairn'), true, 'parked receipt exists');
  assert.equal(fw.providerCapGovernor.status('cairn').heldMaintenance, 199, 'held passes accounted');
  assert.equal(
    added.filter((m) => m.meta.kind === 'provider-cap-parked').length, 1,
    'one park marker, not one per pass',
  );

  // "Restart": a FRESH framework + governor over the same durable state file.
  const second = makeHarness({ statePath });
  try {
    assert.equal(second.fw.providerCapGovernor.isParked('cairn'), true, 'park survived restart');
    for (let pass = 0; pass < 50; pass++) {
      await second.fw.runQueuedMaintenance();
    }
    second.fw.pendingRequests.push({
      agentName: 'cairn', reason: 'discord-message', source: 'discord', timestamp: Date.now(),
    });
    await second.fw.processInferenceRequests();
  } finally { second.restore(); }
  assert.equal(second.counters.providerCalls, 0, 'restart makes ZERO provider calls — no probe');
  assert.equal(second.counters.dispatches, 0, 'no primary dispatch either');
  assert.equal(second.removed.length, 0, 'and no new sheds');
});

test('parked wakes are dropped-and-counted, not requeued; events were already durable', async () => {
  const { fw, counters, restore } = makeHarness();
  try {
    await fw.runQueuedMaintenance(); // enter the park
    for (let i = 0; i < 5; i++) {
      fw.pendingRequests.push({
        agentName: 'cairn', reason: 'discord-message', source: 'discord', timestamp: Date.now(),
      });
      await fw.processInferenceRequests();
    }
  } finally { restore(); }
  assert.equal(counters.dispatches, 0, 'no dispatch while parked');
  assert.equal(fw.pendingRequests.length, 0, 'held wakes do not spin the scheduler');
  assert.equal(fw.providerCapGovernor.status('cairn').heldWakes, 5, 'held count visible');
});

test('maintenance canary after the window opens: cap lifted → released; still capped → one more call only', async () => {
  // Case 1: the cap lifts — the canary pass succeeds and releases.
  let stillCapped = true;
  const h1 = makeHarness({ capOnTick: () => stillCapped });
  try {
    await h1.fw.runQueuedMaintenance();
    assert.equal(h1.counters.providerCalls, 1);
    // Force the window open (operator-less time travel: rewrite eligibility).
    h1.fw.providerCapGovernor.status('cairn'); // parked
    const rec = (h1.fw.providerCapGovernor as any).parks.get('cairn');
    rec.eligibleAt = Date.now() - 1;
    stillCapped = false;
    // cm.isReady flips after one successful tick so the canary pass is bounded.
    let ticked = false;
    h1.cm.isReady = () => ticked;
    const origTick = h1.cm.tick;
    h1.cm.tick = async () => { await origTick(); ticked = true; };
    await h1.fw.runQueuedMaintenance();
  } finally { h1.restore(); }
  assert.equal(h1.counters.providerCalls, 2, 'exactly one canary call');
  assert.equal(h1.fw.providerCapGovernor.isParked('cairn'), false, 'released by the canary');
  assert.ok(h1.added.some((m) => m.meta.kind === 'provider-cap-released'));

  // Case 2: the canary finds the cap still on — one call, re-parked, backoff.
  const h2 = makeHarness();
  try {
    await h2.fw.runQueuedMaintenance();
    const rec = (h2.fw.providerCapGovernor as any).parks.get('cairn');
    rec.eligibleAt = Date.now() - 1;
    rec.resetAt = Date.now() - 1000; // provider's stated reset has passed but the cap is still on
    await h2.fw.runQueuedMaintenance(); // the canary
    await h2.fw.runQueuedMaintenance(); // suppressed again (backoff)
    await h2.fw.runQueuedMaintenance();
  } finally { h2.restore(); }
  assert.equal(h2.counters.providerCalls, 2, 'entry + one canary, then backoff holds');
  assert.equal(h2.fw.providerCapGovernor.isParked('cairn'), true);
  assert.equal(h2.fw.providerCapGovernor.status('cairn').attemptCount, 2);
});

test('wake canary: one dispatch proceeds when the window opens; a second wake stays held', async () => {
  const { fw, counters, restore } = makeHarness();
  try {
    await fw.runQueuedMaintenance(); // park
    const rec = (fw.providerCapGovernor as any).parks.get('cairn');
    rec.eligibleAt = Date.now() - 1;
    fw.pendingRequests.push({
      agentName: 'cairn', reason: 'discord-message', source: 'discord', timestamp: Date.now(),
    });
    await fw.processInferenceRequests();
    assert.equal(counters.dispatches, 1, 'the canary wake dispatched');
    // Permit is now in flight — further wakes are held, not dispatched.
    fw.pendingRequests.push({
      agentName: 'cairn', reason: 'discord-message', source: 'discord', timestamp: Date.now(),
    });
    await fw.processInferenceRequests();
    assert.equal(counters.dispatches, 1, 'single canary permit enforced');
  } finally { restore(); }
});

test('operator plane: cap_status reads, cap_clear releases + one wake, nudge/unstick refuse while parked', async () => {
  const { fw, restore } = makeHarness();
  try {
    await fw.runQueuedMaintenance(); // park

    const status = await fw.handleHostCommand('srv', { command: 'cap_status', agentName: 'cairn' });
    assert.equal(status.ok, true);
    assert.equal(status.providerCap.errorClass, 'usage_cap');

    const nudge = await fw.handleHostCommand('srv', { command: 'nudge', agentName: 'cairn' });
    assert.equal(nudge.ok, false);
    assert.match(nudge.error, /cap_clear/, 'nudge refuses and points at the deliberate lever');

    const unstick = await fw.handleHostCommand('srv', { command: 'unstick', agentName: 'cairn' });
    assert.equal(unstick.ok, false);
    assert.match(unstick.error, /history is fine/, 'unstick refuses — the account is capped, not the history');

    const clear = await fw.handleHostCommand('srv', {
      command: 'cap_clear', agentName: 'cairn', requesterName: 'antra',
    });
    assert.equal(clear.ok, true);
    assert.equal(fw.providerCapGovernor.isParked('cairn'), false);
    assert.equal(fw.pendingRequests.length, 1, 'exactly one catch-up wake');
    assert.equal(fw.pendingRequests[0].reason, 'provider-cap-cleared');

    const again = await fw.handleHostCommand('srv', { command: 'cap_clear', agentName: 'cairn' });
    assert.equal(again.ok, false, 'clearing an unparked agent is an error, not a no-op');
  } finally { restore(); }
});

test('healthSnapshot exposes the park to /healthz and doctor tooling', async () => {
  const { fw, restore } = makeHarness();
  try {
    fw.eventGate = null;
    fw.activeStreams = new Map();
    fw.refusalStats = new Map();
    await fw.runQueuedMaintenance(); // park
    const snap = fw.healthSnapshot();
    assert.equal(snap.agents[0].providerCap.errorClass, 'usage_cap');
    assert.equal(snap.providerCap.parks.length, 1);
  } finally { restore(); }
});

test('the OverBudget drain kick stays down while parked (no unbounded compression dispatch)', () => {
  const { fw, counters, restore } = makeHarness();
  try {
    // Park first (via the funnel, not maintenance, to keep the count clean).
    fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', {
      resetAt: Date.UTC(2026, 8, 1), scope: 'workspace', provider: 'anthropic', errorClass: 'usage_cap',
    });
    const before = counters.providerCalls;
    // An over-budget exhaust would normally kick an 8-tick drain.
    for (let i = 0; i < 3; i++) {
      fw.noteInferenceExhausted('cairn', 'Compile plan would exceed hard budget', undefined, 'over_budget');
    }
    assert.equal(counters.providerCalls, before, 'no drain ticks while parked');
    assert.equal(fw.overBudgetDrainInFlight.size, 0);
  } finally { restore(); }
});
