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
import { mkdtempSync, writeFileSync } from 'node:fs';
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
    model: 'claude-opus-4-8',
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
  fw.primaryAgentName = 'cairn';
  fw.pendingAssistantBlocks = new Map();
  fw.deferredMessages = [];
  fw.activeStreams = new Map();
  fw.refusalStats = new Map();
  fw.eventGate = null;
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

test('REVIEW 1: clean maintenance passes NEVER clear the park — retirement proceeds, release needs real provider success', async () => {
  let stillCapped = true;
  const h1 = makeHarness({ capOnTick: () => stillCapped });
  try {
    await h1.fw.runQueuedMaintenance(); // entry: 1 call
    assert.equal(h1.counters.providerCalls, 1);
    const rec = (h1.fw.providerCapGovernor as any).parks.get('cairn');
    rec.eligibleAt = Date.now() - 1; // window open
    assert.equal(h1.fw.providerCapGovernor.status('cairn').phase, 'canary-eligible');
    stillCapped = false; // the cap genuinely lifts

    // Real retirement work, several clean passes — the park must survive all
    // of them: absence of a provider failure is not provider-success evidence.
    await h1.fw.runQueuedMaintenance();
    await h1.fw.runQueuedMaintenance();
    assert.ok(h1.counters.providerCalls > 1, 'debt retirement proceeds at full cadence');
    assert.equal(h1.fw.providerCapGovernor.isParked('cairn'), true, 'clean passes do not clear');
    assert.equal(
      h1.added.filter((m) => m.meta.kind === 'provider-cap-released').length, 0,
      'no release marker without provider proof',
    );

    // A real successful provider response — the only self-release ground.
    h1.fw.emitTrace({ type: 'inference:completed', agentName: 'cairn' });
    assert.equal(h1.fw.providerCapGovernor.isParked('cairn'), false, 'released on real success');
    assert.ok(h1.added.some((m) => m.meta.kind === 'provider-cap-released'));
  } finally { h1.restore(); }

  // No-op passes (nothing to dispatch): zero calls, park intact — including
  // across a restart over the same durable state.
  const h2 = makeHarness();
  try {
    await h2.fw.runQueuedMaintenance(); // entry
    const rec2 = (h2.fw.providerCapGovernor as any).parks.get('cairn');
    rec2.eligibleAt = Date.now() - 1;
    h2.cm.isReady = () => true; // no pending work at all
    for (let i = 0; i < 20; i++) await h2.fw.runQueuedMaintenance();
    assert.equal(h2.counters.providerCalls, 1, 'no-op passes make zero calls');
    assert.equal(h2.fw.providerCapGovernor.isParked('cairn'), true, 'and never clear');

    const h3 = makeHarness({ statePath: h2.statePath }); // "restart"
    h3.cm.isReady = () => true;
    for (let i = 0; i < 20; i++) await h3.fw.runQueuedMaintenance();
    assert.equal(h3.counters.providerCalls, 0, 'restart + no-op passes: zero calls');
    assert.equal(h3.fw.providerCapGovernor.isParked('cairn'), true, 'still parked');
    h3.restore();
  } finally { h2.restore(); }
});

test('maintenance canary still capped → one more call only, then backoff', async () => {
  // The canary finds the cap still on — one call, re-parked, backoff.
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

test('REVIEW 2: model change makes ONE real canary eligible — it never clears by configuration difference or no-op', async () => {
  const { fw, cm, counters, added, restore } = makeHarness();
  try {
    await fw.runQueuedMaintenance(); // entry, records model claude-opus-4-8
    assert.equal(fw.providerCapGovernor.status('cairn').model, 'claude-opus-4-8');
    assert.equal(fw.providerCapGovernor.status('cairn').phase, 'parked');

    fw.agents.get('cairn').model = 'us.anthropic.bedrock-opus';
    // No-op passes after the change: eligibility, but no calls and no clear.
    cm.isReady = () => true;
    for (let i = 0; i < 10; i++) await fw.runQueuedMaintenance();
    assert.equal(counters.providerCalls, 1, 'model change + no-op passes: zero new calls');
    assert.equal(fw.providerCapGovernor.isParked('cairn'), true, 'configuration difference never clears');
    assert.equal(fw.providerCapGovernor.status('cairn').phase, 'canary-eligible');
    assert.equal(
      added.filter((m) => m.meta.kind === 'provider-cap-released').length, 0,
      'no release marker from a config change',
    );

    // The one real canary: a pending wake consumes the permit and dispatches.
    fw.pendingRequests.push({
      agentName: 'cairn', reason: 'discord-message', source: 'discord', timestamp: Date.now(),
    });
    await fw.processInferenceRequests();
    assert.equal(counters.dispatches, 1, 'one real dispatch permitted');
    assert.equal(fw.providerCapGovernor.isParked('cairn'), true, 'still parked until that dispatch SUCCEEDS');
    fw.emitTrace({ type: 'inference:completed', agentName: 'cairn' });
    assert.equal(fw.providerCapGovernor.isParked('cairn'), false, 'released only on real success');
  } finally { restore(); }
});

test('REVIEW 3: incoming events are Chronicle-durable while parked; one release wake, no duplicate effects', async () => {
  const { fw, counters, added, restore } = makeHarness();
  try {
    await fw.runQueuedMaintenance(); // park
    // An incoming message recorded while parked goes through the SAME durable
    // append as ever — the park gates dispatch, never recording.
    fw.addMessage('human', [{ type: 'text', text: 'hello while parked' }]);
    const recorded = added.find((m) => m.content?.[0]?.text === 'hello while parked');
    assert.ok(recorded, 'event durably recorded while parked');

    // Its wakes (and four more) are held, not replayed.
    for (let i = 0; i < 5; i++) {
      fw.pendingRequests.push({
        agentName: 'cairn', reason: 'discord-message', source: 'discord', timestamp: Date.now(),
      });
      await fw.processInferenceRequests();
    }
    assert.equal(counters.dispatches, 0);
    assert.equal(fw.providerCapGovernor.status('cairn').heldWakes, 5);

    // Operator release: exactly ONE catch-up wake → exactly one dispatch,
    // and nothing further — held wakes never replay individually.
    await fw.handleHostCommand('srv', { command: 'cap_clear', agentName: 'cairn', requesterName: 'antra' });
    assert.equal(fw.pendingRequests.length, 1);
    await fw.processInferenceRequests();
    assert.equal(counters.dispatches, 1, 'one wake covers all held events');
    await fw.processInferenceRequests();
    assert.equal(counters.dispatches, 1, 'no duplicate inference effects');
  } finally { restore(); }
});

test('REVIEW 4: park/release markers are inert — no provider work, no shedding, no recursive accounting, cause-minimal text', () => {
  const { fw, counters, added, removed, restore } = makeHarness();
  try {
    fw.noteInferenceExhausted('cairn', CAP_MESSAGE, false, 'provider_cap', {
      resetAt: Date.UTC(2026, 8, 1), scope: 'workspace', provider: 'anthropic', errorClass: 'usage_cap',
    });
    fw.handleProviderCapRelease('cairn', 'operator:antra');
  } finally { restore(); }

  const markers = added.filter((m) =>
    m.meta.kind === 'provider-cap-parked' || m.meta.kind === 'provider-cap-released');
  assert.equal(markers.length, 2, 'entry + release markers');
  for (const m of markers) {
    const text = m.content[0].text as string;
    assert.ok(!text.includes('invalid_request_error'), 'no raw error type in marker');
    assert.ok(!text.includes('req_'), 'no request ids in marker');
    assert.ok(!text.includes('{'), 'no JSON bodies in marker');
    assert.equal(m.meta.system, true, 'system marker — never requests inference');
    assert.ok(!('rawError' in m.meta) && !('error' in m.meta), 'no error body in metadata');
  }
  assert.equal(counters.providerCalls, 0, 'markers triggered no provider work');
  assert.equal(counters.dispatches, 0);
  assert.equal(removed.length, 0, 'markers shed nothing');
  // The operator release queued its one wake; the markers themselves never
  // touched the held-work accounting (no recursion).
  const lastRelease = fw.providerCapGovernor.statusAll().lastRelease;
  assert.equal(lastRelease.heldWakes, 0, 'marker appends were not counted as held wakes');
  assert.equal(lastRelease.heldMaintenance, 0);
});

test('REVIEW 6: corrupt state fails open → exactly one structured cap call → re-parks → never enters poison rewind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-corrupt-'));
  const statePath = join(dir, 'provider-cap.json');
  writeFileSync(statePath, 'NOT VALID JSON {{{', 'utf8');
  const { fw, counters, removed, added, restore } = makeHarness({ statePath });
  try {
    assert.ok(fw.providerCapGovernor.loadError, 'corruption is a visible load error');
    assert.equal(fw.providerCapGovernor.isParked('cairn'), false, 'fails toward unparked');
    for (let pass = 0; pass < 50; pass++) await fw.runQueuedMaintenance();
  } finally { restore(); }
  assert.equal(counters.providerCalls, 1, 'exactly one structured cap call after fail-open');
  assert.equal(fw.providerCapGovernor.isParked('cairn'), true, 're-parked immediately');
  assert.equal(removed.length, 0, 'poison rewind never engaged');
  assert.equal(added.filter((m) => m.meta.kind === 'refusal-rewind').length, 0);
  assert.equal(fw.exhaustionRewinds.get('cairn') ?? 0, 0);
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
