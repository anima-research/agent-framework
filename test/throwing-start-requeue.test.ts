import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';

interface Request {
  agentName: string;
  reason: string;
  source: string;
  timestamp: number;
}

interface FrameworkHarness {
  queue: { tryPop(): unknown | null };
  pendingRequests: Request[];
  passRequests: Set<Map<string, Request[]>>;
  agents: Map<string, { name: string; state: { status: string } }>;
  activeStreams: Map<string, Promise<void>>;
  activeTurnTokens: Map<string, number>;
  staleWarnAt: Map<string, number>;
  providerAccelerationCooldowns: Map<string, unknown>;
  parkedContinuations: Set<Request>;
  inferencePolicy: { shouldInfer(): boolean };
  sweepExpiredConversations(): void;
  createFrameworkState(): Record<string, never>;
  emitTrace(): void;
  handleProcessEvent(event: unknown): Promise<void>;
  endPendingPrimary(agentName: string): void;
  endContinuedTurn(agentName: string, drop: unknown): void;
  startAgentStream(agent: { name: string }, trigger?: Request): Promise<void>;
  dropContinuations(agentName: string, drop: { kind: 'caller'; reason?: string; why: string }): void;
  processNextEvent(): Promise<void>;
}

const request = (agentName: string, reason: string): Request =>
  ({ agentName, reason, source: 'test', timestamp: Date.now() });

function harness(whileAStarts: (framework: FrameworkHarness) => void = () => {}) {
  const framework = Object.create(AgentFramework.prototype) as FrameworkHarness;
  framework.queue = { tryPop: () => null };
  framework.pendingRequests = [];
  framework.passRequests = new Set();
  framework.agents = new Map(['a', 'b', 'c'].map((name) => [name, { name, state: { status: 'idle' } }]));
  framework.activeStreams = new Map();
  framework.activeTurnTokens = new Map();
  framework.staleWarnAt = new Map();
  framework.providerAccelerationCooldowns = new Map();
  framework.parkedContinuations = new Set();
  framework.inferencePolicy = { shouldInfer: () => true };
  framework.sweepExpiredConversations = () => {};
  framework.createFrameworkState = () => ({});
  framework.emitTrace = () => {};
  framework.handleProcessEvent = async () => {};
  framework.endPendingPrimary = () => {};
  framework.endContinuedTurn = () => {};
  const starts: string[] = [];
  const failure = new Error('checkpoint write failed (ENOSPC)');
  let aFailed = false;
  framework.startAgentStream = async (agent, trigger) => {
    starts.push(`${agent.name}:${trigger?.reason}`);
    if (agent.name !== 'a' || aFailed) return;
    aFailed = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    whileAStarts(framework);
    throw failure;
  };
  return { framework, starts, failure };
}

test("a start that throws leaves the other agents' wakes queued, and its own error reaches the caller", async () => {
  const { framework, starts, failure } = harness();
  const a = request('a', 'discord-message');
  const b = request('b', 'discord-message');
  framework.pendingRequests = [a, b];

  await assert.rejects(framework.processNextEvent(), (error) => error === failure);
  assert.deepEqual(framework.pendingRequests, [b], "b's own request is queued again, and a's is not");
  assert.equal(framework.pendingRequests[0], b);
  assert.equal(framework.passRequests.size, 0);

  await framework.processNextEvent();
  assert.deepEqual(starts, ['a:discord-message', 'b:discord-message'], 'the next pass starts b, and a only once');
});

test("a tool_results_ready request of another agent's survives a start that throws", async () => {
  const { framework, starts, failure } = harness();
  const b = request('b', 'tool_results_ready');
  framework.pendingRequests = [request('a', 'discord-message'), b];

  await assert.rejects(framework.processNextEvent(), (error) => error === failure);
  assert.deepEqual(framework.pendingRequests, [b]);

  await framework.processNextEvent();
  assert.deepEqual(starts, ['a:discord-message', 'b:tool_results_ready']);
});

test('the requests a throwing pass leaves go back ahead of those that arrived while it awaited', async () => {
  const c = request('c', 'discord-message');
  const { framework, starts, failure } = harness((f) => { f.pendingRequests.push(c); });
  const b = request('b', 'discord-message');
  framework.pendingRequests = [request('a', 'discord-message'), b];

  await assert.rejects(framework.processNextEvent(), (error) => error === failure);
  assert.deepEqual(framework.pendingRequests, [b, c]);

  await framework.processNextEvent();
  assert.deepEqual(starts, ['a:discord-message', 'b:discord-message', 'c:discord-message']);
});

test('a continuation dropped while the pass awaited stays dropped, and a wake of the same agent survives', async () => {
  let restartInPass = false;
  const { framework, starts, failure } = harness((f) => {
    restartInPass = [...f.passRequests].some((pass) => pass.get('b')?.includes(restart) ?? false);
    f.dropContinuations('b', { kind: 'caller', reason: 'stop', why: 'a stop ended the turn' });
  });
  const restart = request('b', 'context_budget_restart');
  const wake = request('b', 'discord-message');
  framework.pendingRequests = [request('a', 'discord-message'), restart, wake];

  await assert.rejects(framework.processNextEvent(), (error) => error === failure);
  assert.ok(restartInPass, "b's restart was in the pass when the stop came");
  assert.deepEqual(framework.pendingRequests, [wake], "only b's wake comes back");

  await framework.processNextEvent();
  assert.deepEqual(starts, ['a:discord-message', 'b:discord-message']);
});

test('a pass that completes leaves a busy agent\'s wake queued once, and nothing more', async () => {
  const { framework, starts } = harness();
  const b = request('b', 'discord-message');
  framework.activeTurnTokens.set('b', 1);
  framework.pendingRequests = [b, request('c', 'discord-message')];

  await framework.processNextEvent();
  assert.deepEqual(starts, ['c:discord-message']);
  assert.deepEqual(framework.pendingRequests, [b]);
  assert.equal(framework.passRequests.size, 0);
});
