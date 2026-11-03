import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { DetailedUsage, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { HealthModule } from '../src/modules/health/index.js';
import { EPHEMERAL_USAGE_NAME } from '../src/usage/usage-tracker.js';
import type { EventResponse, Module, ProcessEvent, ToolCall, TraceEvent } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';
import { bindAsConversationFork } from './helpers/dendrite.js';

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

/** Every stream the framework has driven so far, by the promise driveStream
 *  returns, so a test can wait until each one's teardown has run. */
const driven = new WeakMap<AgentFramework, Promise<void>[]>();
function streamsDriven(framework: AgentFramework): () => Promise<void> {
  let handles = driven.get(framework);
  if (!handles) {
    const all: Promise<void>[] = [];
    handles = all;
    driven.set(framework, all);
    const streams = (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams;
    const set = streams.set.bind(streams);
    streams.set = (name, handle) => { all.push(handle); return set(name, handle); };
  }
  const watched = handles;
  return async () => { await Promise.allSettled(watched); };
}

async function run(framework: AgentFramework, name: string) {
  const tornDown = streamsDriven(framework);
  const { agent, contextManager } = await framework.createEphemeralAgent({
    name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    proseRouting: 'disabled',
  });
  contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
  const result = await framework.runEphemeralToCompletion(agent, contextManager);
  // A cancelled stream's teardown runs after the run settles: wait for it
  // before checking counts.
  await tornDown();
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
        // An ephemeral run counts in the one shared entry; the traces name it.
        assert.deepEqual(snapshot.byAgent, [{
          agentName: EPHEMERAL_USAGE_NAME, usage: expectedTotals(totalUsage), inferenceCount: 1, ephemeral: true,
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

  it('counts the rounds\' samples when a final response carries no usage', async () => {
    const f = await fixture();
    try {
      f.membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
      const response = createMockResponse([{ type: 'text', text: 'Done.' }]);
      response.usage = totalUsage; // the last round's cumulative sample; no details.usage
      f.membrane.pushResponse(response);
      await run(f.framework, 'ordinary');
      const completed = f.traces.filter((e) => e.type === 'inference:completed');
      assert.equal(completed.length, 1);
      assert.deepEqual(completed[0].tokenUsage, expectedTokens(totalUsage));
      assert.equal(f.traces.filter((e) => e.type === 'usage:updated').length, 1);
      assert.deepEqual(f.framework.getSessionUsage().totals, expectedTotals(totalUsage));
      const logs = f.framework.queryInferenceLogs({ agentName: 'ordinary' });
      assert.deepEqual(logs.entries[0].entry.tokenUsage, expectedTokens(totalUsage), 'the trace, the totals and the log agree');
    } finally {
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('attributes successive streams separately in the traces and the log, and persists their totals through store reopen', async () => {
    const f = await fixture();
    let stopped = false;
    try {
      f.membrane.pushResponse(toolResponse('finish', 'finish-a', firstUsage));
      await run(f.framework, 'alice');
      f.membrane.pushResponse(toolResponse('finish', 'finish-b', totalUsage));
      await run(f.framework, 'bob');
      const snapshot = f.framework.getSessionUsage();
      assert.equal(snapshot.inferenceCount, 2);
      // Both ephemeral runs count in the one shared entry; the traces and the
      // inference log attribute each stream to its own agent.
      const shared = snapshot.byAgent.map(({ usage: { estimatedCost, ...tokens }, ...entry }) => ({ ...entry, tokens, currency: estimatedCost?.currency }));
      assert.deepEqual(shared, [{
        agentName: EPHEMERAL_USAGE_NAME,
        tokens: { inputTokens: 350, outputTokens: 75, cacheCreationTokens: 75, cacheReadTokens: 130 },
        currency: 'USD',
        inferenceCount: 2,
        ephemeral: true,
      }]);
      // The two streams' costs, 0.03 and 0.08.
      assert.ok(Math.abs(snapshot.byAgent[0].usage.estimatedCost!.total - 0.11) < 1e-10);
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

/** A stream that finishes one tool round with `usage`, then ends as `ending`
 *  says: with that event, by throwing it, or, for 'close', by just closing.
 *  A cancel ends it as `cancelledAs` says: with an `aborted` event, as
 *  membrane reports one, with an `error` event, or by just closing. */
class RoundThenEnd implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  private resumed = false;
  private resume: (() => void) | null = null;
  constructor(
    private readonly usage: DetailedUsage,
    private readonly ending: StreamEvent | Error | 'close',
    private readonly cancelledAs: 'aborted' | 'error' | 'close' = 'aborted',
  ) {}
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
      context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '', roundContent: [call], supportsInjectedMessages: true },
    } as StreamEvent;
    if (!this.resumed) await new Promise<void>((r) => { this.resume = r; });
    if (this.isCancelled) {
      if (this.cancelledAs === 'aborted') yield { type: 'aborted', reason: 'user' } as StreamEvent;
      if (this.cancelledAs === 'error') yield { type: 'error', error: new Error('stream cancelled') } as StreamEvent;
      return;
    }
    if (this.ending === 'close') return;
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
      const tornDown = streamsDriven(framework);
      try {
        const { agent, contextManager } = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
          proseRouting: 'disabled', ...limits,
        });
        contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        await framework.runEphemeralToCompletion(agent, contextManager);
        // The cancelled stream's teardown has run, so whatever it would log is in.
        await tornDown();

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
    ['an abort', { type: 'aborted', reason: 'error' } as StreamEvent],
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
        // The run settles once the failure path has decided: it rejects with
        // the stream's failure, or, had a retry been scheduled, it would wait
        // for it and resolve on the default response.
        let bound: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          framework.runEphemeralToCompletion(agent, contextManager).then(() => 'resolved', (error: unknown) => error),
          new Promise((resolve) => { bound = setTimeout(() => resolve('timed out'), 10_000); }),
        ]).finally(() => clearTimeout(bound));
        assert.ok(outcome instanceof Error, `the run failed with the stream: ${String(outcome)}`);
        assert.equal(membrane.calls.length, 1, 'no retry was scheduled by the time the run failed');
        assert.ok(await pollUntil(() => traces.some((e) => e.type === 'usage:updated')), 'the finished round was counted');

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

/** Its first stream holds a tool round over the budget and the turn's end; a later stream, a restart's, the end alone. */
class ToolRoundThenFinal extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.calls.length === 1
      ? [toolResponse('echo', 'echo-1', firstUsage), finalResponse('Recovered.', secondUsage)]
      : [finalResponse('Recovered.', secondUsage)]);
    this.lastStream = stream;
    return stream;
  }
}

describe('an agent whose model binds its thinking, with its window size set, takes no new stream mid-turn for budget alone', () => {
  // A budget restart compiles afresh mid-turn, and what that compile changes ahead of the turn's own earlier rounds
  // takes their reasoning out of the request. The window projection still guards.
  const huge = 1_000_000;
  for (const [label, limits, restarts] of [
    ['binds, with a window size: the stream goes on', { thinkingBinding: { binds: true }, physicalWindowTokens: huge }, []],
    ['binds, with no window size: the budget restart, as before', { thinkingBinding: { binds: true } }, ['context_budget']],
    ['a window size, without binds: the budget restart, as before', { physicalWindowTokens: huge }, ['context_budget']],
    // A window size that isn't a finite number reads as none: a config read from JSON can hold null.
    ['binds, with a null window size: the budget restart, as before', { thinkingBinding: { binds: true }, physicalWindowTokens: null as unknown as number }, ['context_budget']],
    ['binds, with an infinite window size: the budget restart, as before', { thinkingBinding: { binds: true }, physicalWindowTokens: Infinity }, ['context_budget']],
    // One a config holds as a string reads as its number, as the projection's comparison always read it.
    ['binds, with a window size given as a string: the stream goes on', { thinkingBinding: { binds: true }, physicalWindowTokens: String(huge) as unknown as number }, []],
    // The first call's projection passes the window: its prompt (170, cache included), its output (20) and the
    // reserve for the next response (100) make 290, past 250, where without the prompt they'd make 120.
    ['binds, with a window the stream outgrows: the window restart', { thinkingBinding: { binds: true }, maxTokens: 100, physicalWindowTokens: 250 }, ['physical_window']],
  ] as const) {
    it(label, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'af-binds-budget-'));
      const membrane = new ToolRoundThenFinal();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [],
        modules: [new TurnTools()], syncIntervalMs: 0,
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => traces.push(event));
      framework.start();
      const tornDown = streamsDriven(framework);
      try {
        const { agent, contextManager } = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
          proseRouting: 'disabled', maxStreamTokens: 50, ...limits,
        });
        contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
        await framework.runEphemeralToCompletion(agent, contextManager);
        await tornDown();
        const restarted = traces.filter((e) => e.type === 'inference:stream_restarted');
        assert.ok(firstUsage.inputTokens! > 50, 'the first call is over the budget');
        assert.deepEqual(restarted.map((e) => (e as { reason?: string }).reason), restarts);
        assert.equal(membrane.calls.length, restarts.length > 0 ? 2 : 1, restarts.length > 0 ? 'the restart opened a second stream' : 'one stream, its tool round included');
        assert.equal(traces.filter((e) => e.type === 'inference:completed').length, 1, 'the turn completed');
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
        internal.forcedRewind.set('worker', { remaining: 1, removed: [], serverId: 'ops', channelId: 'ops-channel' });
        const posted: Array<{ channelId: string; content: string }> = [];
        (f.framework as unknown as { postToChannel: (s: string, c: string, content: string) => Promise<void> })
          .postToChannel = async (_server, channelId, content) => { posted.push({ channelId, content }); };
        f.membrane.pushResponse(response());
        await run(f.framework, 'worker');
        assert.equal(posted.length, 1, 'the /unstick outcome was posted');
        assert.equal(posted[0].channelId, 'ops-channel');
        assert.match(posted[0].content, /the model responded/);
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
      assert.ok(await pollUntil(() => r.membrane.calls.length === 2, 10_000), 'the cooldown ended and the call was retried');
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
      assert.match(String(logs[0].error), /^This request would exceed your organization's maximum usage increase rate/);
      assert.deepEqual(logs[0].tokenUsage, expectedTokens(firstUsage));
      assert.deepEqual(r.framework.getSessionUsage().totals, expectedTotals(firstUsage));
      assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 1);
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("a conversation agent's stated provider wait that cuts a turn after a finished round logs and counts that round once", async () => {
    const statedWait = (request: unknown) => new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000,
      message: 'zz rate limit reached for requests', rawError: { status: 429 }, rawRequest: request,
    });
    const r = await resident([(request) => new RoundThenEnd(firstUsage, statedWait(request))]);
    // A conversation agent doesn't own provider admission, so a stated wait
    // holds its turn (the "Provider wait" end) instead of the organization's
    // cooldown. Its turns aren't an external message's default target, so
    // the turn is started directly.
    const internal = r.framework as unknown as {
      startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
    };
    r.framework.start();
    try {
      bindAsConversationFork(r.framework, 'resident', { serverId: 'stub', channelId: 'world:zz' });
      r.framework.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'first' }]);
      await internal.startAgentStream(r.framework.getAgent('resident'),
        { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      assert.ok(await pollUntil(() => r.traces.some((e) => e.type === 'usage:updated')
        && r.framework.queryInferenceLogs({ agentName: 'resident' }).total > 0), 'the finished round was counted and logged');
      const logs = r.framework.queryInferenceLogs({ agentName: 'resident' }).entries.map((e) => e.entry);
      assert.equal(logs.length, 1, 'the wait writes the stream\'s one entry');
      assert.equal(String(logs[0].error), 'zz rate limit reached for requests');
      assert.deepEqual(logs[0].tokenUsage, expectedTokens(firstUsage), 'and it carries the finished round');
      assert.deepEqual(r.framework.getSessionUsage().totals, expectedTotals(firstUsage));
      assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 1);
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("a refusal completion's note carries what its count counted", async () => {
    // The refused response carries no detailed usage, so the stream is
    // counted from its latest usage sample (10 input, 5 output).
    const r = await resident([() => new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-refused' }], 'refusal')])]);
    const notes: Array<{ tokens: unknown; totals: unknown }> = [];
    const internal = r.framework as unknown as { logFailure: (entry: Record<string, unknown>) => void };
    const logFailure = internal.logFailure.bind(r.framework);
    // What the session had counted when the refusal was noted: this stream
    // alone, before any retry a rewind might queue.
    internal.logFailure = (entry) => {
      if (entry.kind === 'refusal') notes.push({ tokens: entry.tokens, totals: structuredClone(r.framework.getSessionUsage().totals) });
      logFailure(entry);
    };
    r.framework.start();
    try {
      r.framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} } as unknown as ProcessEvent);
      await r.framework.runUntilIdle();
      assert.ok(await pollUntil(() => notes.length > 0), 'the refusal was noted');
      const counted: DetailedUsage = { inputTokens: 10, outputTokens: 5 };
      assert.deepEqual(notes[0].totals, expectedTotals(counted), 'counted from the latest sample');
      assert.deepEqual(notes[0].tokens, expectedTokens(counted), 'and the note carries the same');
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('turns that each fail after an answered call reach the hard-down threshold and run the breaker: an answered call is not a completed turn', async () => {
    // Each turn's first call answers (its round's usage arrives) and the
    // call after its tool result is refused as the provider can't take it,
    // which shedMayHelp matches.
    const refused = (): StreamEvent => ({
      type: 'error',
      error: new MembraneError({
        type: 'invalid_request', retryable: false, httpStatus: 400,
        message: 'zz the provider could not process the tool result', rawError: { status: 400 },
      }),
    }) as StreamEvent;
    const r = await resident([1, 2, 3].map(() => () => new RoundThenEnd(firstUsage, refused())));
    const internal = r.framework as unknown as { consecutiveInferenceFailures: Map<string, number> };
    const streaks: number[] = [];
    const answeredBefore: number[] = [];
    let answered = 0;
    // emitTrace counts the failure before listeners hear it.
    r.framework.onTrace((event) => {
      if (event.type === 'inference:usage') answered++;
      if (event.type === 'inference:exhausted') {
        streaks.push(internal.consecutiveInferenceFailures.get('resident') ?? 0);
        answeredBefore.push(answered);
      }
    });
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    r.framework.start();
    try {
      for (const [turn, text] of ['first', 'second', 'third'].entries()) {
        r.framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
        await r.framework.runUntilIdle();
        assert.ok(await pollUntil(() => streaks.length === turn + 1), `turn ${turn + 1} failed`);
      }
      assert.deepEqual(answeredBefore, [1, 2, 3], 'each failed turn had a call that answered');
      assert.deepEqual(streaks, [1, 2, 3], 'an answered call leaves the streak standing');
      const alerts = r.traces.filter((e) => e.type === 'ops:alert' && (e as { kind?: string }).kind === 'hard-down');
      assert.equal(alerts.length, 1, 'the third failed turn raises the hard-down alert');
      assert.ok(lines.some((line) => /^\[inference-rewind\] agent=resident auto-quarantined /.test(line)),
        'and the poison-history breaker sheds the newest exchange');
    } finally {
      console.error = original;
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});

/** A completion the stream would yield next; these tests end it before it's handled. */
const unseenCompletion = (): StreamEvent =>
  ({ type: 'complete', response: createMockResponse([{ type: 'text', text: 'unseen' }]) }) as StreamEvent;

/** A stream whose first round never returns: it waits until it's cancelled. */
class FirstRoundHeld implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  started = false;
  private wake: (() => void) | null = null;
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {
    this.isCancelled = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.started = true;
    if (!this.isCancelled) await new Promise<void>((resolve) => { this.wake = resolve; });
    yield { type: 'aborted', reason: 'user' } as StreamEvent;
  }
}

/** A tool that returns only once released, so the stream waits on it. */
class HeldTools implements Module {
  readonly name = 'test';
  release: () => void = () => {};
  private readonly held = new Promise<void>((resolve) => { this.release = resolve; });
  calledWith: string[] = [];
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(call: ToolCall) {
    this.calledWith.push(call.id);
    await this.held;
    return { success: true, data: {} };
  }
}

type WrittenEntry = { agentName?: string; success?: boolean; error?: string; tokenUsage?: unknown };

/** A resident whose first stream is `stream`, with `tools` and any `limits`
 *  of its own, started on one message. `written` holds every inference-log
 *  entry as it's written, which outlasts stop() closing the store the log
 *  query reads. */
async function residentWith(stream: YieldingStream, tools: Module, limits: { maxStreamTokens?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
  const membrane = new MockMembrane();
  let made = false;
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    membrane.calls.push(request);
    if (made) return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
    made = true;
    return stream;
  };
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', ...limits }],
    modules: [new InputModule(), tools], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  const written: WrittenEntry[] = [];
  const internal = framework as unknown as { logInference: (entry: WrittenEntry) => void };
  const write = internal.logInference.bind(framework);
  internal.logInference = (entry) => {
    written.push(entry);
    write(entry);
  };
  framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
  return { dir, membrane, framework, traces, written };
}

function loggedOnce(framework: AgentFramework, traces: TraceEvent[], error: RegExp) {
  assert.equal(traces.filter((e) => e.type === 'usage:updated').length, 1, 'counted once');
  assert.deepEqual(framework.getSessionUsage().totals, expectedTotals(firstUsage));
  const logs = framework.queryInferenceLogs({ agentName: 'resident' }).entries.map((e) => e.entry);
  assert.equal(logs.length, 1, 'one entry');
  assert.equal(logs[0].success, false);
  assert.match(String(logs[0].error), error);
  assert.deepEqual(logs[0].tokenUsage, expectedTokens(firstUsage), 'the entry carries what was counted');
}

/** Whether the stream's turn has ended: the host mode lists an agent among
 *  its active turns from the turn's dequeue to its settled teardown, which
 *  comes after the stream's accounting. */
function tornDown(framework: AgentFramework): boolean {
  return !framework.getHostModeStatus().activeTurnAgents.includes('resident');
}

describe("a stop's own entry carries the rounds its stream finished, once", () => {
  it("a caller's stop after a finished round", async () => {
    const tools = new HeldTools();
    const r = await residentWith(new RoundThenEnd(firstUsage, unseenCompletion()), tools);
    try {
      assert.ok(await pollUntil(() => tools.calledWith.length === 1), 'the round finished and its tool is running');
      assert.ok(r.framework.abortInference('resident'), 'the stream was cancelled');
      assert.ok(await pollUntil(() => tornDown(r.framework)), 'its teardown ran');
      loggedOnce(r.framework, r.traces, /^Stream cancelled \(user\)$/);
    } finally {
      tools.release();
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a shutdown after a finished round', async () => {
    const tools = new HeldTools();
    const r = await residentWith(new RoundThenEnd(firstUsage, unseenCompletion()), tools);
    try {
      assert.ok(await pollUntil(() => tools.calledWith.length === 1), 'the round finished and its tool is running');
      const stopping = r.framework.stop();
      tools.release();
      await stopping;
      assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 1, 'counted once');
      const entries = r.written.filter((entry) => entry.agentName === 'resident');
      assert.deepEqual(entries.map((entry) => entry.error), ['Stream aborted: shutdown'], "one entry, the shutdown's own");
      assert.deepEqual(entries[0].tokenUsage, expectedTokens(firstUsage), 'it carries the round the stream finished');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('an operator quiesce after a finished round', async () => {
    const tools = new HeldTools();
    const r = await residentWith(new RoundThenEnd(firstUsage, unseenCompletion()), tools);
    try {
      assert.ok(await pollUntil(() => tools.calledWith.length === 1), 'the round finished and its tool is running');
      await r.framework.quiesce({ timeoutMs: 50, abandon: true });
      assert.ok(await pollUntil(() => tornDown(r.framework)), 'its teardown ran');
      loggedOnce(r.framework, r.traces, /^Stream aborted: quiesce_abandoned$/);
    } finally {
      // Let the held tool finish while the framework's queue is still open.
      tools.release();
      await pollUntil(() => r.traces.some((e) =>
        (e.type === 'tool:completed' || e.type === 'tool:failed') && (e as { callId?: string }).callId === 'echo-1'));
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('an operator quiesce before the first round returns: its entry has nothing to carry', async () => {
    const stream = new FirstRoundHeld();
    const r = await residentWith(stream, new TurnTools());
    try {
      assert.ok(await pollUntil(() => stream.started), 'the stream is running');
      await r.framework.quiesce({ timeoutMs: 50, abandon: true });
      assert.ok(await pollUntil(() => stream.isCancelled), 'the abandon cancelled it');
      assert.ok(await pollUntil(() => tornDown(r.framework)), 'its teardown ran');
      const logs = r.framework.queryInferenceLogs({ agentName: 'resident' }).entries.map((e) => e.entry);
      assert.deepEqual(logs.map((entry) => entry.error), ['Stream aborted: quiesce_abandoned'], "one entry, the abandon's own");
      assert.equal(logs[0].tokenUsage, undefined, 'it carries no usage');
      assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 0, 'nothing counted');
      assert.equal(r.framework.getSessionUsage().inferenceCount, 0);
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  // The stop terminals are reached from the `aborted` case, the `error` case
  // and the block after the stream loop, each with the stream's logStream.
  const stops = [
    { stop: "a caller's stop", error: 'Stream cancelled (user)' },
    { stop: 'a shutdown', error: 'Stream aborted: shutdown' },
    { stop: 'an operator quiesce', error: 'Stream aborted: quiesce_abandoned' },
  ] as const;
  for (const cancelledAs of ['error', 'close'] as const) {
    for (const { stop, error } of stops) {
      it(`${stop} after a finished round, its stream reporting the cancel ${cancelledAs === 'error' ? 'as an error' : 'by just closing'}`, async () => {
        const tools = new HeldTools();
        const r = await residentWith(new RoundThenEnd(firstUsage, unseenCompletion(), cancelledAs), tools);
        try {
          assert.ok(await pollUntil(() => tools.calledWith.length === 1), 'the round finished and its tool is running');
          if (stop === 'a shutdown') {
            const stopping = r.framework.stop();
            tools.release();
            await stopping;
          } else {
            if (stop === "a caller's stop") assert.ok(r.framework.abortInference('resident'), 'the stream was cancelled');
            else await r.framework.quiesce({ timeoutMs: 50, abandon: true });
            assert.ok(await pollUntil(() => tornDown(r.framework)), 'its teardown ran');
          }
          const entries = r.written.filter((entry) => entry.agentName === 'resident');
          assert.deepEqual(entries.map((entry) => entry.error), [error], "one entry, the stop's own");
          assert.deepEqual(entries[0].tokenUsage, expectedTokens(firstUsage), 'it carries the round the stream finished');
          assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 1, 'counted once');
          assert.equal(r.traces.filter((e) => e.type === 'inference:exhausted').length, 0, 'and not as a failure');
        } finally {
          tools.release();
          if (stop !== 'a shutdown') {
            await pollUntil(() => r.traces.some((e) =>
              (e.type === 'tool:completed' || e.type === 'tool:failed') && (e as { callId?: string }).callId === 'echo-1'));
            await r.framework.stop();
          }
          rmSync(r.dir, { recursive: true, force: true });
        }
      });
    }
  }

  // settleDeliberateCancel() writes after its trace, settleFrameworkCancel()
  // before it.
  for (const { stop, error } of stops) {
    it(`${stop} after a finished round whose own entry's write throws stays a stop, and says so`, async () => {
      const tools = new HeldTools();
      const r = await residentWith(new RoundThenEnd(firstUsage, unseenCompletion()), tools);
      const internal = r.framework as unknown as { logInference: (entry: WrittenEntry) => void };
      const write = internal.logInference;
      internal.logInference = (entry) => {
        if (entry.error === error) throw new Error('zz store refused the write');
        write(entry);
      };
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try {
        assert.ok(await pollUntil(() => tools.calledWith.length === 1), 'the round finished and its tool is running');
        if (stop === 'a shutdown') {
          const stopping = r.framework.stop();
          tools.release();
          await stopping;
        } else {
          if (stop === "a caller's stop") assert.ok(r.framework.abortInference('resident'), 'the stream was cancelled');
          else await r.framework.quiesce({ timeoutMs: 50, abandon: true });
          assert.ok(await pollUntil(() => tornDown(r.framework)), 'its teardown ran');
        }
        assert.equal(r.traces.filter((e) => e.type === 'inference:aborted').length, 1, 'one aborted trace');
        assert.deepEqual(r.traces.filter((e) => e.type === 'inference:failed' || e.type === 'inference:exhausted').map((e) => e.type), [],
          'and no failure');
        assert.equal(lines.filter((line) =>
          line.startsWith("[usage] agent=resident could not record a stopped stream's inference-log entry: ")).length, 1,
          'the failed write is said, once');
        assert.equal(r.traces.filter((e) => e.type === 'usage:updated').length, 1, 'the round is counted');
        assert.deepEqual(r.written.filter((entry) => entry.agentName === 'resident').map((entry) => entry.error), [],
          'and no other entry carries it');
      } finally {
        console.error = original;
        tools.release();
        if (stop !== 'a shutdown') {
          await pollUntil(() => r.traces.some((e) =>
            (e.type === 'tool:completed' || e.type === 'tool:failed') && (e as { callId?: string }).callId === 'echo-1'));
          await r.framework.stop();
        }
        rmSync(r.dir, { recursive: true, force: true });
      }
    });
  }
});

describe("a budget restart's own cancel isn't a caller's stop, however its stream reports it", () => {
  // The restart marks its stream and then calls cancelStream() at the tool
  // boundary, which leaves a reasonless caller record there too. The record
  // decides only when the framework marked nothing.
  for (const cancelledAs of ['error', 'close'] as const) {
    it(`its stream reporting the cancel ${cancelledAs === 'error' ? 'as an error' : 'by just closing'}`, async () => {
      const r = await residentWith(new RoundThenEnd(firstUsage, unseenCompletion(), cancelledAs), new TurnTools(), { maxStreamTokens: 50 });
      try {
        assert.ok(await pollUntil(() => r.traces.some((e) => e.type === 'inference:stream_restarted')), 'the boundary restarted the turn');
        assert.ok(await pollUntil(() => r.membrane.calls.length >= 2), 'the restart opened its next stream');
        assert.ok(await pollUntil(() => tornDown(r.framework)), 'and the turn ended');
        assert.deepEqual(r.traces.filter((e) => e.type === 'inference:aborted'), [], 'no stop was traced');
        const texts = r.framework.getAgent('resident')!.getContextManager().queryMessages({}).messages
          .flatMap((m) => m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text));
        assert.ok(!texts.some((text) => text.startsWith('[turn-interrupted]')), 'and no stop marker was written');
      } finally {
        await r.framework.stop();
        rmSync(r.dir, { recursive: true, force: true });
      }
    });
  }
});

describe('a stream that ends without writing its own entry is logged once, in finally', () => {
  it('a failure after a completion is logged without carrying the usage again', async () => {
    const r = await resident([() => new MockYieldingStream([finalResponse('Done.', totalUsage)])]);
    // Something after the completion's entry throws: the stream's catch
    // writes a failure entry too. (A resident: an ephemeral is deregistered
    // once its completion settles it, so its catch treats the throw as a
    // superseded stream's.)
    const internal = r.framework as unknown as { endRefusalEpisode: (name: string) => void };
    const end = internal.endRefusalEpisode.bind(r.framework);
    internal.endRefusalEpisode = () => {
      internal.endRefusalEpisode = end;
      throw new Error('after the completion');
    };
    r.framework.start();
    try {
      r.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      assert.ok(await pollUntil(() => r.framework.queryInferenceLogs({ agentName: 'resident' }).total === 2), 'both entries');
      // Both entries carry the stream's start time, so find each by outcome.
      const logs = r.framework.queryInferenceLogs({ agentName: 'resident' }).entries.map((e) => e.entry);
      const completed = logs.find((e) => e.success);
      const failed = logs.find((e) => !e.success);
      assert.deepEqual(completed?.tokenUsage, expectedTokens(totalUsage), 'the completion carries the usage');
      assert.equal(failed?.error, 'Stream threw: after the completion');
      assert.equal(failed?.tokenUsage, undefined, 'the later failure does not carry it again');
      assert.deepEqual(r.framework.getSessionUsage().totals, expectedTotals(totalUsage));
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a stream whose agent was replaced under its name after a finished round', async () => {
    const stream = new RoundThenEnd(firstUsage, unseenCompletion());
    let framework: AgentFramework | undefined;
    let original: object | undefined;
    const agentsOf = () => (framework as unknown as { agents: Map<string, object> }).agents;
    const provide = stream.provideToolResults.bind(stream);
    // The agent object is replaced under its name while this stream waits on its tool.
    stream.provideToolResults = () => {
      original = agentsOf().get('resident');
      agentsOf().set('resident', Object.create(original!));
      provide();
    };
    const r = await residentWith(stream, new TurnTools());
    framework = r.framework;
    try {
      assert.ok(await pollUntil(() => r.framework.queryInferenceLogs({ agentName: 'resident' }).total > 0), 'logged');
      loggedOnce(r.framework, r.traces, /^Stream abandoned: its agent was disposed or replaced$/);
    } finally {
      if (original) agentsOf().set('resident', original);
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a stream that just closes after a finished round', async () => {
    const r = await residentWith(new RoundThenEnd(firstUsage, 'close'), new TurnTools());
    try {
      assert.ok(await pollUntil(() => r.framework.queryInferenceLogs({ agentName: 'resident' }).total > 0), 'logged');
      loggedOnce(r.framework, r.traces, /^Stream ended without a final response$/);
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("a write that fails while finally logs the stream doesn't skip the teardown after it", async () => {
    const r = await residentWith(new RoundThenEnd(firstUsage, 'close'), new TurnTools());
    const internal = r.framework as unknown as {
      logInference: (entry: { error?: string }) => void;
      activeTurnTokens: Map<string, unknown>;
      activeStreams: Map<string, unknown>;
    };
    const write = internal.logInference.bind(r.framework);
    internal.logInference = (entry) => {
      if (entry.error === 'Stream ended without a final response') throw new Error('zz store refused the write');
      write(entry);
    };
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      assert.ok(await pollUntil(() => lines.some((line) => line.startsWith('[usage] agent=resident could not record'))),
        'the failed write is said');
      assert.ok(await pollUntil(() => !internal.activeTurnTokens.has('resident') && !internal.activeStreams.has('resident')),
        'and the stream and its turn are still released');
    } finally {
      console.error = original;
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('a stream superseded by a newer one after a finished round', async () => {
    const stream = new RoundThenEnd(firstUsage, unseenCompletion());
    let framework: AgentFramework | undefined;
    const provide = stream.provideToolResults.bind(stream);
    // A newer stream of the agent takes over while this one waits on its tool.
    stream.provideToolResults = () => {
      (framework!.getAgent('resident') as unknown as { _streamId: number })._streamId++;
      provide();
    };
    const r = await residentWith(stream, new TurnTools());
    framework = r.framework;
    try {
      assert.ok(await pollUntil(() => r.framework.queryInferenceLogs({ agentName: 'resident' }).total > 0), 'logged');
      loggedOnce(r.framework, r.traces, /^Stream superseded/);
    } finally {
      await r.framework.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});

describe("a write that fails at a tool boundary doesn't skip what the boundary does after it", () => {
  /** Makes the framework's inference-log write throw for the entries
   *  `refuse` picks, as a store that refuses the write would, and collects
   *  stderr so a test can see the failure reported. */
  function refuseWrites(framework: AgentFramework, refuse: (entry: { stopReason?: string }) => boolean) {
    const internal = framework as unknown as { logInference: (entry: { stopReason?: string }) => void };
    const write = internal.logInference.bind(framework);
    internal.logInference = (entry) => {
      if (refuse(entry)) throw new Error('zz store refused the write');
      write(entry);
    };
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return {
      reported: (agent: string) => lines.some((line) =>
        line.startsWith(`[usage] agent=${agent} could not record a stream's usage at its end`)
        && line.includes('zz store refused the write')),
      restore: () => { console.error = original; },
    };
  }

  it('a restart still opens its next stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-end-turn-usage-'));
    const membrane = new SequentialStreamMembrane();
    membrane.pushResponse(toolResponse('echo', 'echo-1', firstUsage));
    membrane.pushResponse(finalResponse('Recovered.', secondUsage));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [],
      modules: [new TurnTools()], syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const stderr = refuseWrites(framework, (entry) => entry.stopReason === 'context_budget');
    framework.start();
    try {
      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
        proseRouting: 'disabled', maxStreamTokens: 50,
      });
      contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      const run = framework.runEphemeralToCompletion(agent, contextManager);
      // Awaited below once the restart is in. Without the restart it never
      // settles, and stop() mustn't turn it into an unhandled rejection.
      run.catch(() => {});
      assert.ok(await pollUntil(() => membrane.calls.length === 2), 'the restart opened its next stream');
      await run;
      assert.equal(traces.filter((e) => e.type === 'inference:stream_restarted').length, 1, 'the restart is announced');
      assert.equal(traces.filter((e) => e.type === 'inference:completed').length, 1, 'the turn ends on its next stream');
      assert.ok(stderr.reported('worker'), 'the failed write is said');
    } finally {
      stderr.restore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a tool-ended turn still ends its refusal episode, says it ended, and hands the tool's result to the modules", async () => {
    const f = await fixture();
    const stderr = refuseWrites(f.framework, (entry) => entry.stopReason === 'turn_ended');
    try {
      const refusalStreak = (f.framework as unknown as { refusalStreak: Map<string, number> }).refusalStreak;
      refusalStreak.set('worker', 2);
      f.membrane.pushResponse(toolResponse('finish', 'finish-1', totalUsage));
      await run(f.framework, 'worker');
      assert.equal(refusalStreak.has('worker'), false, 'the refusal episode ends');
      assert.equal(f.traces.filter((e) => e.type === 'inference:turn_ended').length, 1, 'inference:turn_ended');
      assert.ok(await pollUntil(() => f.traces.some((e) => e.type === 'process:completed'
        && (e as { processEvent?: { type?: string } }).processEvent?.type === 'tool-result')),
      "the tool result's event reaches the modules");
      assert.ok(stderr.reported('worker'), 'the failed write is said');
    } finally {
      stderr.restore();
      await f.framework.stop();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
