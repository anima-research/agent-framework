import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { DetailedUsage, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { HealthModule } from '../src/modules/health/index.js';
import type { EventResponse, Module, ProcessEvent, ToolCall, TraceEvent } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

class TurnTools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return ['echo', 'finish'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: {} },
    }));
  }
  async handleToolCall(call: ToolCall) {
    return { success: true, endTurn: call.name.endsWith('finish'), data: {} };
  }
}

const firstUsage: DetailedUsage = {
  inputTokens: 100, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40,
  estimatedCost: { input: 0.01, output: 0.02, total: 0.03, currency: 'USD' },
};
const totalUsage: DetailedUsage = {
  inputTokens: 250, outputTokens: 55, cacheCreationTokens: 45, cacheReadTokens: 90,
  estimatedCost: { input: 0.03, output: 0.05, total: 0.08, currency: 'USD' },
};

function toolResponse(name: string, id: string, usage?: DetailedUsage): NormalizedResponse {
  const response = createMockResponse([{ type: 'tool_use', name: 'test--' + name, id, input: {} }], 'tool_use');
  // Membrane emits cumulative usage across all rounds of a yielding stream.
  response.usage = usage!;
  return response;
}

function expectedTokens(usage: DetailedUsage) {
  return {
    input: usage.inputTokens, output: usage.outputTokens,
    cacheCreation: usage.cacheCreationTokens, cacheRead: usage.cacheReadTokens,
  };
}

function expectedTotals(usage: DetailedUsage) {
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    estimatedCost: usage.estimatedCost
      ? { total: usage.estimatedCost.total, currency: usage.estimatedCost.currency }
      : undefined,
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
  const storePath = join(dir, 'store.chronicle');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath, membrane: membrane.asMembrane(), agents: [],
    modules: [new TurnTools()], syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  const completionStates: Array<string | undefined> = [];
  // What the session totals already hold when the turn's terminal traces fire.
  const countedAt: Array<{ type: string; inferenceCount: number }> = [];
  framework.onTrace((event) => {
    traces.push(event);
    if (event.type === 'inference:completed') {
      completionStates.push(framework.getAgent(event.agentName)?.state.status);
    }
    if (event.type === 'inference:turn_ended' || event.type === 'inference:stream_restarted') {
      countedAt.push({ type: event.type, inferenceCount: framework.getSessionUsage().inferenceCount });
    }
  });
  framework.start();
  return { dir, storePath, membrane, framework, traces, completionStates, countedAt };
}

async function run(framework: AgentFramework, name: string) {
  const { agent, contextManager } = await framework.createEphemeralAgent({
    name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    proseRouting: 'disabled',
  });
  contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  const result = await framework.runEphemeralToCompletion(agent, contextManager);
  // Also observe asynchronous cancellation teardown before checking counts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return result;
}

describe('tool-ended turn usage accounting', () => {
  for (const rounds of [1, 2]) {
    it('accounts once for ' + rounds + ' tool round(s), with cumulative cache usage and cost', async () => {
      const f = await fixture();
      try {
        if (rounds === 2) f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
        f.membrane.pushResponse(toolResponse('finish', 'finish-1', totalUsage));
        const result = await run(f.framework, 'worker');
        assert.equal(result.toolCallsCount, rounds);
        assert.equal(f.membrane.calls.length, 1, 'endTurn must not request another inference');
        assert.equal(f.membrane.lastStream!.receivedToolResults.length, rounds - 1);
        assert.deepEqual(f.completionStates, ['idle']);
        const completed = f.traces.filter((e) => e.type === 'inference:completed');
        assert.equal(completed.length, 1);
        assert.equal(completed[0].agentName, 'worker');
        assert.deepEqual(completed[0].tokenUsage, expectedTokens(totalUsage));
        assert.ok(completed[0].durationMs >= 0);
        const logs = f.framework.queryInferenceLogs({ agentName: 'worker' });
        assert.equal(logs.total, 1);
        assert.equal(logs.entries[0].entry.success, true);
        assert.equal(logs.entries[0].entry.stopReason, 'turn_ended');
        assert.deepEqual(logs.entries[0].entry.tokenUsage, expectedTokens(totalUsage));
        assert.deepEqual(logs.entries[0].entry.response, { note: 'stream ended by tool result' });
        assert.deepEqual(logs.entries[0].entry.request, { note: 'request body not kept for a stream ended at a tool boundary' },
          'no compiled-context blob per tool-ended turn');
        assert.deepEqual(f.countedAt, [{ type: 'inference:turn_ended', inferenceCount: 1 }],
          'counted before turn_ended fires, as a completion is before its caller resumes');
        assert.equal(logs.entries[0].entry.durationMs, completed[0].durationMs);
        assert.equal(f.traces.filter((e) => e.type === 'inference:turn_ended').length, 1);
        assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 1);
        assert.equal(f.traces.filter((e) => e.type === 'inference:exhausted').length, 0);
        const snapshot = f.framework.getSessionUsage();
        assert.equal(snapshot.inferenceCount, 1);
        assert.deepEqual(snapshot.totals, expectedTotals(totalUsage));
        assert.deepEqual(snapshot.byAgent, [{
          agentName: 'worker', usage: expectedTotals(totalUsage), inferenceCount: 1,
        }]);
      } finally {
        await f.framework.stop();
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }

  it('keeps natural completion authoritative and counts neither cumulative samples nor final usage twice', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
      const response = createMockResponse([{ type: 'text', text: 'Done.' }]);
      response.usage = { ...totalUsage, outputTokens: 50 }; // final details remain authoritative
      response.details!.usage = totalUsage;
      f.membrane.pushResponse(response);
      await run(f.framework, 'ordinary');
      assert.deepEqual(f.completionStates, ['idle']);
      const completed = f.traces.filter((e) => e.type === 'inference:completed');
      assert.equal(completed.length, 1);
      assert.deepEqual(completed[0].tokenUsage, expectedTokens(totalUsage));
      assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 1);
      assert.equal(f.traces.filter((e) => e.type === 'inference:turn_ended').length, 0);
      assert.equal(f.framework.getSessionUsage().inferenceCount, 1);
      assert.deepEqual(f.framework.getSessionUsage().totals, expectedTotals(totalUsage));
      const logs = f.framework.queryInferenceLogs({ agentName: 'ordinary' });
      assert.equal(logs.total, 1, 'natural completion logs exactly once');
      assert.equal(logs.entries[0].entry.stopReason, 'end_turn');
      assert.deepEqual(logs.entries[0].entry.tokenUsage, expectedTokens(totalUsage));
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('attributes successive streams separately and persists their totals through store reopen', async () => {
    const f = await fixture();
    let stopped = false;
    try {
      f.membrane.pushResponse(toolResponse('finish', 'finish-a', firstUsage));
      await run(f.framework, 'alice');
      f.membrane.pushResponse(toolResponse('finish', 'finish-b', totalUsage));
      await run(f.framework, 'bob');
      const snapshot = f.framework.getSessionUsage();
      assert.equal(snapshot.inferenceCount, 2);
      assert.deepEqual(snapshot.byAgent, [
        { agentName: 'alice', usage: expectedTotals(firstUsage), inferenceCount: 1 },
        { agentName: 'bob', usage: expectedTotals(totalUsage), inferenceCount: 1 },
      ]);
      assert.deepEqual(f.traces.filter((e) => e.type === 'usage:updated').map((e) => e.agentName), ['alice', 'bob']);
      const logs = f.framework.queryInferenceLogs();
      assert.equal(logs.total, 2);
      assert.equal(new Set(logs.entries.map((e) => e.entry.requestId)).size, 2);
      assert.deepEqual(logs.entries.map((e) => e.entry.agentName).sort(), ['alice', 'bob']);
      await f.framework.stop();
      stopped = true;
      const reopened = await AgentFramework.create({
        storePath: f.storePath, membrane: f.membrane.asMembrane(), agents: [], modules: [], syncIntervalMs: 0,
      });
      try {
        assert.deepEqual(reopened.getSessionUsage(), snapshot);
        assert.deepEqual(reopened.queryInferenceLogs(), logs);
      } finally {
        await reopened.stop();
      }
    } finally {
      if (!stopped) await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('includes tool-ended turns in the log-backed health snapshot', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
      f.membrane.pushResponse(toolResponse('finish', 'finish-1', totalUsage));
      await run(f.framework, 'worker');
      const health = new HealthModule({ timeZone: 'UTC' });
      health.bind(f.framework, f.framework.getStore());
      const result = await health.handleToolCall({
        id: 'health-snapshot', name: 'snapshot', input: { includeSubagents: false },
      });
      assert.equal(result.success, true);
      const data = result.data as {
        inferences: { successCount: number; errorCount: number };
        tokenTotalsByAgent: Record<string, { input: number; output: number; cacheRead: number; inferences: number }>;
      };
      assert.equal(data.inferences.successCount, 1);
      assert.equal(data.inferences.errorCount, 0);
      assert.deepEqual(data.tokenTotalsByAgent.worker, {
        input: totalUsage.inputTokens, output: totalUsage.outputTokens,
        cacheRead: totalUsage.cacheReadTokens, inferences: 1,
      });
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('reports completion without inventing usage when no sample is available', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('finish', 'finish-1'));
      await run(f.framework, 'unknown-usage');
      const completed = f.traces.filter((e) => e.type === 'inference:completed');
      assert.equal(completed.length, 1);
      assert.equal(completed[0].tokenUsage, undefined);
      assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 0);
      assert.equal(f.framework.getSessionUsage().inferenceCount, 0);
      const logs = f.framework.queryInferenceLogs({ agentName: 'unknown-usage' });
      assert.equal(logs.total, 1);
      assert.equal(logs.entries[0].entry.success, true);
      assert.equal(logs.entries[0].entry.tokenUsage, undefined);
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

/** One queued response per stream: a restart opens a fresh stream. */
class SequentialStreamMembrane extends MockMembrane {
  private next = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.next, ++this.next));
    this.lastStream = stream;
    return stream;
  }
}

/** A stream that finishes one tool round with `usage`, then ends as `ending` says. */
class RoundThenEnd implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  private resumed = false;
  private resume: (() => void) | null = null;
  constructor(private readonly usage: DetailedUsage, private readonly ending: StreamEvent | Error) {}
  provideToolResults(): void {
    this.isWaitingForTools = false;
    this.resumed = true;
    this.resume?.();
  }
  cancel(): void {
    this.isCancelled = true;
    this.resumed = true;
    this.resume?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'usage', usage: this.usage } as StreamEvent;
    const call = { type: 'tool_use' as const, id: 'echo-1', name: 'test--echo', input: {} };
    this.isWaitingForTools = true;
    this.pendingToolCallIds = [call.id];
    yield {
      type: 'tool-calls',
      calls: [{ id: call.id, name: call.name, input: {} }],
      context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [call] },
    } as StreamEvent;
    if (!this.resumed) await new Promise<void>((r) => { this.resume = r; });
    if (this.isCancelled) {
      yield { type: 'aborted', reason: 'user' } as StreamEvent;
      return;
    }
    if (this.ending instanceof Error) throw this.ending;
    yield this.ending;
  }
}

class StreamsMembrane extends MockMembrane {
  constructor(private readonly streams: Array<() => YieldingStream>) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const make = this.streams.shift();
    return make ? make() : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
  }
}

async function pollUntil(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

function finalResponse(text: string, usage: DetailedUsage): NormalizedResponse {
  const response = createMockResponse([{ type: 'text', text }]);
  response.usage = usage;
  response.details!.usage = usage;
  return response;
}

const secondUsage: DetailedUsage = {
  inputTokens: 300, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 200,
  estimatedCost: { input: 0.02, output: 0.01, total: 0.03, currency: 'USD' },
};

function summed(a: DetailedUsage, b: DetailedUsage) {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    estimatedCost: { total: a.estimatedCost!.total + b.estimatedCost!.total, currency: 'USD' },
  };
}

describe('a stream counts its usage once, however it ends', () => {
  const nearCap: DetailedUsage = {
    inputTokens: 5_000, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 195_000,
    estimatedCost: { input: 0.05, output: 0.01, total: 0.06, currency: 'USD' },
  };
  for (const [reason, limits, usage] of [
    ['context_budget', { maxStreamTokens: 50 }, firstUsage],
    ['physical_window', { physicalWindowTokens: 200_000, maxTokens: 4_000 }, nearCap],
  ] as const) {
    it(`a ${reason} restart counts and logs the stream it cancels, without completing the turn`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
      const membrane = new SequentialStreamMembrane();
      membrane.pushResponse(toolResponse('echo', 'echo-1', usage));
      membrane.pushResponse(finalResponse('Recovered.', secondUsage));
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [],
        modules: [new TurnTools()], syncIntervalMs: 0,
      });
      const traces: TraceEvent[] = [];
      const countedAtRestart: number[] = [];
      framework.onTrace((event) => {
        traces.push(event);
        if (event.type === 'inference:stream_restarted') countedAtRestart.push(framework.getSessionUsage().inferenceCount);
      });
      framework.start();
      try {
        const { agent, contextManager } = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
          proseRouting: 'disabled', ...limits,
        });
        contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        await framework.runEphemeralToCompletion(agent, contextManager);
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(membrane.calls.length, 2, 'the restart opened a second stream');
        assert.equal((traces.find((e) => e.type === 'inference:stream_restarted') as { reason?: string })?.reason, reason);
        assert.deepEqual(countedAtRestart, [1], 'the cancelled stream is counted where the restart is decided');
        assert.equal(traces.filter((e) => e.type === 'inference:completed').length, 1, 'only the turn\'s end completes');
        assert.equal(traces.filter((e) => e.type === 'usage:updated').length, 2);
        const snapshot = framework.getSessionUsage();
        assert.equal(snapshot.inferenceCount, 2);
        assert.deepEqual(snapshot.totals, summed(usage, secondUsage));
        const logs = framework.queryInferenceLogs({ agentName: 'worker' }).entries.map((e) => e.entry).reverse();
        assert.equal(logs.length, 2);
        assert.deepEqual(
          { success: logs[0].success, stopReason: logs[0].stopReason, tokenUsage: logs[0].tokenUsage, request: logs[0].request, response: logs[0].response },
          {
            success: true, stopReason: reason, tokenUsage: expectedTokens(usage),
            request: { note: 'request body not kept for a stream ended at a tool boundary' },
            response: { note: 'stream restarted to compress its context' },
          },
        );
        assert.equal(logs[1].stopReason, 'end_turn');
        assert.deepEqual(logs[1].tokenUsage, expectedTokens(secondUsage));
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const [name, ending] of [
    ['a stream error', { type: 'error', error: new MembraneError({ type: 'auth', retryable: false, message: 'key revoked', rawError: { status: 401 } }) } as StreamEvent],
    ['an abort', { type: 'aborted', reason: 'timeout' } as StreamEvent],
    ['a thrown stream', new Error('socket hang up')],
  ] as const) {
    it(`${name} after a finished round counts that round once and logs it with the failure`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
      const membrane = new StreamsMembrane([() => new RoundThenEnd(firstUsage, ending)]);
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [],
        modules: [new TurnTools()], syncIntervalMs: 0,
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => traces.push(event));
      framework.start();
      try {
        const { agent, contextManager } = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'disabled',
        });
        contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        await framework.runEphemeralToCompletion(agent, contextManager).catch(() => undefined);
        assert.ok(await pollUntil(() => traces.some((e) => e.type === 'usage:updated')), 'the finished round was counted');
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(membrane.calls.length, 1, 'no retry');
        assert.equal(traces.filter((e) => e.type === 'inference:completed').length, 0);
        assert.equal(traces.filter((e) => e.type === 'usage:updated').length, 1);
        assert.deepEqual(framework.getSessionUsage().totals, expectedTotals(firstUsage));
        const logs = framework.queryInferenceLogs({ agentName: 'worker' }).entries.map((e) => e.entry);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].success, false);
        assert.deepEqual(logs[0].tokenUsage, expectedTokens(firstUsage), 'the failure entry carries the finished round');
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

class InputModule implements Module {
  readonly name = 'input';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

function accelerationLimit(request: unknown): MembraneError {
  return new MembraneError({
    type: 'rate_limit', retryable: true, httpStatus: 429,
    message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
    rawError: { status: 429 }, rawRequest: request,
  });
}

class ThrowingStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.error;
  }
}

/** A resident whose streams come from `streams`, one per inference, with a 1 s provider cooldown. */
async function resident(streams: Array<(request: NormalizedRequest) => YieldingStream>) {
  const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
  const membrane = new MockMembrane();
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    membrane.calls.push(request);
    const make = streams.shift();
    return make ? make(request) : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all' }],
    modules: [new InputModule(), new TurnTools()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = framework as unknown as {
    providerAccelerationDefaultCooldownMs: number;
    providerAccelerationJitterMs: number;
    providerAccelerationLastRecovery: Map<string, { stopReason: string }>;
  };
  internal.providerAccelerationDefaultCooldownMs = 1_000;
  internal.providerAccelerationJitterMs = 0;
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  return { dir, membrane, framework, internal, traces };
}

describe('a tool-ended turn ends what a successful turn ends', () => {
  for (const [ending, response] of [
    ['a tool-ended turn', () => toolResponse('finish', 'finish-1', totalUsage)],
    ['a natural completion', () => createMockResponse([{ type: 'text', text: 'Done.' }])],
  ] as const) {
    it(`the failure streak and the refusal-rewind episode, a forced /unstick included: ${ending}`, async () => {
      const f = await fixture();
      try {
        const internal = f.framework as unknown as Record<
          'consecutiveInferenceFailures' | 'exhaustionRewinds' | 'refusalRewinds' | 'refusalStreak' | 'rewindEpisode' | 'forcedRewind',
          Map<string, unknown>
        >;
        for (const key of ['consecutiveInferenceFailures', 'exhaustionRewinds', 'refusalRewinds', 'refusalStreak'] as const) {
          internal[key].set('worker', 2);
        }
        internal.rewindEpisode.set('worker', { markerId: 'marker', count: 1, category: 'cyber' });
        internal.forcedRewind.set('worker', { remaining: 1, removed: [], serverId: 'none', channelId: '' });
        f.membrane.pushResponse(response());
        await run(f.framework, 'worker');
        assert.equal(internal.consecutiveInferenceFailures.get('worker'), 0, 'the hard-down streak');
        assert.equal(internal.exhaustionRewinds.get('worker'), 0, 'the poison-history rewind budget');
        assert.equal(internal.refusalRewinds.get('worker'), 0);
        assert.equal(internal.refusalStreak.has('worker'), false);
        assert.equal(internal.rewindEpisode.has('worker'), false);
        assert.equal(internal.forcedRewind.has('worker'), false, 'the /unstick session reports the model responded');
      } finally {
        await f.framework.stop();
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }

  it('a provider cooldown, which records its recovery', async () => {
    const r = await resident([
      (request) => new ThrowingStream(accelerationLimit(request)),
      () => new MockYieldingStream([toolResponse('finish', 'finish-1', totalUsage)]),
    ]);
    r.framework.start();
    try {
      r.framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} } as unknown as ProcessEvent);
      await r.framework.runUntilIdle();
      assert.equal(r.membrane.calls.length, 1, 'held for the cooldown');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await r.framework.runUntilIdle();
      assert.ok(await pollUntil(() => r.traces.some((e) => e.type === 'inference:turn_ended')), 'the retried turn ended by tool');
      assert.equal(r.membrane.calls.length, 2);
      assert.equal(r.internal.providerAccelerationLastRecovery.get('resident')?.stopReason, 'turn_ended');
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a cooldown that cuts a turn after a finished round logs and counts that round', async () => {
    const r = await resident([(request) => new RoundThenEnd(firstUsage, accelerationLimit(request))]);
    r.framework.start();
    try {
      r.framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} } as unknown as ProcessEvent);
      await r.framework.runUntilIdle();
      assert.ok(await pollUntil(() => r.traces.some((e) => e.type === 'usage:updated')), 'the finished round was counted');
      const logs = r.framework.queryInferenceLogs({ agentName: 'resident' }).entries.map((e) => e.entry);
      assert.equal(logs.length, 1);
      assert.match(String(logs[0].error), /^Provider acceleration cooldown: /);
      assert.deepEqual(logs[0].tokenUsage, expectedTokens(firstUsage));
      assert.deepEqual(r.framework.getSessionUsage().totals, expectedTotals(firstUsage));
      assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 1);
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});
