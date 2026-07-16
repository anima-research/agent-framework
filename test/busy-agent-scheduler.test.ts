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
  staleWarnAt: Map<string, number>;
  sweepExpiredConversations(): void;
  createFrameworkState(): Record<string, never>;
  emitTrace(): void;
  handleProcessEvent(event: unknown): Promise<void>;
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
  framework.staleWarnAt = new Map();
  framework.sweepExpiredConversations = () => {};
  framework.createFrameworkState = () => ({});
  framework.emitTrace = () => {};
  framework.handleProcessEvent = async () => {};
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
