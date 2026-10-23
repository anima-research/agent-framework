import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

interface FrameworkHarness {
  queue: { tryPop(): unknown | null };
  pendingRequests: Array<{
    agentName: string;
    reason: string;
    source: string;
    timestamp: number;
  }>;
  agents: Map<string, { state: { status: string } }>;
  activeStreams: Map<string, Promise<void>>;
  activeTurnTokens: Map<string, number>;
  staleWarnAt: Map<string, number>;
  inferencePolicy: { shouldInfer(): boolean };
  sweepExpiredConversations(): void;
  createFrameworkState(): Record<string, never>;
  emitTrace(): void;
  handleProcessEvent(event: unknown): Promise<void>;
  startAgentStream(agent: unknown, trigger?: { reason: string; channelId?: string }): Promise<void>;
  processNextEvent(): Promise<void>;
  processInferenceRequests(): Promise<void>;
}

function busyAgentHarness(): FrameworkHarness {
  const framework = Object.create(AgentFramework.prototype) as FrameworkHarness;
  framework.queue = { tryPop: () => null };
  framework.pendingRequests = [{
    agentName: 'Sol',
    reason: 'discord-message',
    source: 'discord',
    timestamp: Date.now(),
  }];
  framework.agents = new Map([['Sol', { state: { status: 'waiting_for_tools' } }]]);
  framework.activeStreams = new Map();
  framework.activeTurnTokens = new Map();
  framework.staleWarnAt = new Map();
  framework.sweepExpiredConversations = () => {};
  framework.createFrameworkState = () => ({});
  framework.emitTrace = () => {};
  framework.handleProcessEvent = async () => {};
  framework.inferencePolicy = { shouldInfer: () => true };
  framework.startAgentStream = async () => {};
  return framework;
}

test('busy-agent inference requests yield to timers when no active stream is registered', async () => {
  const framework = busyAgentHarness();
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);

  await framework.processNextEvent();

  assert.equal(timerRan, true, 'scheduler must yield a macrotask before polling the busy agent again');
  assert.equal(framework.pendingRequests.length, 1, 'the deferred wake remains queued');
});

test('continuous queue traffic still yields when a busy-agent wake remains deferred', async () => {
  const framework = busyAgentHarness();
  framework.queue = { tryPop: () => ({ type: 'diagnostic-event' }) };
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);

  await framework.processNextEvent();

  assert.equal(timerRan, true, 'queue traffic must not starve tool-result or HTTP I/O');
  assert.equal(framework.pendingRequests.length, 1, 'the busy-agent wake remains deferred');
});

test('stale busy-agent diagnostics are throttled with the warning', async () => {
  const framework = busyAgentHarness();
  framework.pendingRequests[0].timestamp = Date.now() - 31_000;
  let traceCount = 0;
  framework.emitTrace = () => {
    traceCount++;
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    await framework.processInferenceRequests();
    await framework.processInferenceRequests();
  } finally {
    console.error = originalError;
  }

  assert.equal(traceCount, 1, 'the stale trace shares the once-per-minute warning throttle');
  assert.equal(framework.pendingRequests.length, 1, 'diagnostics do not consume the deferred wake');
});

test('a budget restart batched behind an ordinary wake starts alone, defining the turn semantics, and the wake goes back to the queue', async () => {
  const framework = busyAgentHarness();
  const now = Date.now();
  framework.pendingRequests = [
    {
      agentName: 'Sol',
      reason: 'mcpl:channel-incoming',
      source: 'discord',
      timestamp: now - 1,
    },
    {
      agentName: 'Sol',
      reason: 'context_budget_restart',
      source: 'framework',
      timestamp: now,
    },
  ];
  framework.agents = new Map([['Sol', { state: { status: 'idle' } }]]);
  framework.activeTurnTokens.set('Sol', 1);

  let selectedTrigger: { reason: string; channelId?: string } | undefined;
  framework.startAgentStream = async (_agent, trigger) => {
    selectedTrigger = trigger;
  };

  await framework.processInferenceRequests();

  assert.equal(
    selectedTrigger?.reason,
    'context_budget_restart',
    'the request that bypasses the turn-alive lock must preserve continuation semantics',
  );
  assert.deepEqual(framework.pendingRequests.map((r) => r.reason), ['mcpl:channel-incoming'],
    'the ordinary wake goes back to the queue, for a turn of its own');
});

test("a tool_results_ready wake stays with the budget restart its batch carries, and only the batch's other wakes go back to the queue", async () => {
  const framework = busyAgentHarness();
  const now = Date.now();
  framework.pendingRequests = [
    { agentName: 'Sol', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: now - 2 },
    { agentName: 'Sol', reason: 'tool_results_ready', source: 'framework', timestamp: now - 1 },
    { agentName: 'Sol', reason: 'context_budget_restart', source: 'framework', timestamp: now },
  ];
  framework.agents = new Map([['Sol', { state: { status: 'idle' } }]]);
  framework.activeTurnTokens.set('Sol', 1);
  let selectedTrigger: { reason: string } | undefined;
  framework.startAgentStream = async (_agent, trigger) => {
    selectedTrigger = trigger;
  };

  await framework.processInferenceRequests();

  assert.equal(selectedTrigger?.reason, 'context_budget_restart', 'the batch starts as the restart');
  assert.deepEqual(framework.pendingRequests.map((r) => r.reason), ['mcpl:channel-incoming'],
    'the tool_results_ready wake goes with the restart, as through a quiesce; the ordinary wake goes back');
});

test("a batch with a tool_results_ready wake ahead of a guard retry starts as the retry", async () => {
  const framework = busyAgentHarness();
  const now = Date.now();
  framework.pendingRequests = [
    { agentName: 'Sol', reason: 'tool_results_ready', source: 'framework', timestamp: now - 1 },
    { agentName: 'Sol', reason: 'tool_result_guard_retry', source: 'framework', timestamp: now },
  ];
  framework.agents = new Map([['Sol', { state: { status: 'idle' } }]]);
  let selectedTrigger: { reason: string } | undefined;
  framework.startAgentStream = async (_agent, trigger) => {
    selectedTrigger = trigger;
  };

  await framework.processInferenceRequests();

  assert.equal(selectedTrigger?.reason, 'tool_result_guard_retry', 'the request that resumes the turn defines its start');
  assert.deepEqual(framework.pendingRequests, [], 'both went into the one start');
});

test("a policy that drops a batch's restart leaves a provider hold's pending primary for the wake the batch sent back", async () => {
  const framework = busyAgentHarness() as FrameworkHarness & {
    providerGates: Map<string, { primaryPending: boolean }>;
    providerAccelerationRecoveries: Map<string, unknown>;
    endContinuedTurn(): void;
    flushAuxiliaryAdmission(): void;
  };
  const now = Date.now();
  framework.pendingRequests = [
    { agentName: 'Sol', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: now - 1 },
    { agentName: 'Sol', reason: 'context_budget_restart', source: 'framework', timestamp: now },
  ];
  framework.agents = new Map([['Sol', { state: { status: 'idle' } }]]);
  framework.activeTurnTokens.set('Sol', 1);
  const gate = { primaryPending: true };
  framework.providerGates = new Map([['Sol', gate]]);
  framework.providerAccelerationRecoveries = new Map([['Sol', {}]]);
  framework.endContinuedTurn = () => {};
  framework.flushAuxiliaryAdmission = () => {};
  framework.inferencePolicy = {
    shouldInfer: ((_agent: string, requests: Array<{ reason: string }>) =>
      !requests.some((r) => r.reason === 'context_budget_restart')) as () => boolean,
  };
  let started = false;
  framework.startAgentStream = async () => {
    started = true;
  };

  await framework.processInferenceRequests();

  assert.equal(started, false, 'the policy dropped the restart');
  assert.deepEqual(framework.pendingRequests.map((r) => r.reason), ['mcpl:channel-incoming'], 'the wake waits to run');
  assert.equal(gate.primaryPending, true, 'so the primary the hold left pending stays pending');
  assert.ok(framework.providerAccelerationRecoveries.has('Sol'));
});
