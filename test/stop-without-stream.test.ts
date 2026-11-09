/**
 * A stop that lands while a turn is alive but has no live stream to cancel:
 * before its stream exists (here a module's gatherContext, or the compile,
 * holds it), while it waits to retry a failed inference or compile, or
 * while the tool-result guard waits on the agent's speech to retry after a
 * refusal. Agent.cancelStream(), abortInference() and a quiesce's abandon
 * end the turn at its next check,
 * or where its hooks or compile fail, before it sends anything more,
 * through the terminal the same stop gets on a live stream. A stop made
 * where no check of a turn is ahead ends nothing, unless the turn's
 * continuation or retry is on its way, which abortInference() ends
 * (held-turn-retry.test.ts, turn-continuation.test.ts).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Membrane as RealMembrane,
  MembraneError,
  NativeFormatter,
  type ContentBlock,
  type Membrane,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type StreamEvent,
  type YieldingStream,
  type YieldingStreamOptions,
} from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';
import type { Agent, EventResponse, Module, ModuleContext, ProcessEvent, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { setAbandonGraceForTests } from '../src/framework.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const SHORT_ABANDON_GRACE_MS = 50;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** `promise`, or a failure naming what was awaited once `ms` have passed. */
async function within<T>(label: string, promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolves once a quiesce's abandon has gone through the framework's turns,
 *  cancelling, marking or listing each, before its grace begins. The
 *  abandon does that before its first await, so it's done when the call
 *  returns. */
function abandonReached(framework: AgentFramework): Promise<void> {
  const internal = framework as unknown as { abandonActiveTurns: () => Promise<string[]> };
  const abandon = internal.abandonActiveTurns.bind(framework);
  const reached = deferred();
  internal.abandonActiveTurns = () => {
    const grace = abandon();
    reached.resolve();
    return grace;
  };
  return reached.promise;
}

/** Answers a message with a wake. Its gatherContext waits on the gate that
 *  `hold()` arms for the next call, which keeps that turn alive with no
 *  stream. */
class GatedContextModule implements Module {
  readonly name = 'gated';
  private gate: Promise<void> | null = null;
  private entered = deferred();
  async start(ctx: ModuleContext): Promise<void> { ctx.registerSpeechHandler('*'); }
  async stop(): Promise<void> {}
  async onAgentSpeech(): Promise<void> {}
  getTools() {
    return [{ name: 'read', description: 'Read a result', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> { return { success: true, data: 'payload' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: String((event as { content: unknown }).content) }] }],
        requestInference: true,
      };
    }
    return {};
  }
  /** Hold the next gatherContext until `release()`; `entered` settles once it waits. */
  hold(): { entered: Promise<void>; release: () => void } {
    const released = deferred();
    this.gate = released.promise;
    this.entered = deferred();
    return { entered: this.entered.promise, release: () => released.resolve() };
  }
  async gatherContext(): Promise<ContextInjection[]> {
    const gate = this.gate;
    this.gate = null;
    if (gate) {
      this.entered.resolve();
      await gate;
    }
    return [];
  }
}

/** Membrane itself over a provider that answers every request. `requests`
 *  are the requests sent, which membrane makes only once a stream is read. */
function answeringMembrane(): { membrane: RealMembrane; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    name: 'test',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    complete: async () => { throw new Error('unexpected complete'); },
    stream: async (request: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(request);
      return {
        content: [{ type: 'text', text: 'Answered.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'test-model',
      } as ProviderResponse;
    },
  };
  return { membrane: new RealMembrane(adapter, { formatter: new NativeFormatter() }), requests };
}

/** A stream whose only event is `error`. */
class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

/** Queue a budget restart's trigger for `prime`, as the scheduler sees one. */
function queueRestart(framework: AgentFramework): void {
  (framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.push({
    agentName: 'prime', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(),
  });
}

/** Fails its first request on a spent quota, a 429 a host's providerHold
 *  parks, and answers the rest. `calls` are the streams made. */
class QuotaOnceMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    if (this.calls.length === 1) {
      return new ErrorStream(new MembraneError({
        type: 'rate_limit', retryable: true, httpStatus: 429, message: 'quota spent',
        rawError: { status: 429 }, rawRequest: request,
      }));
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'Answered.' }])]);
  }
}

const abortReasons = (traces: TraceEvent[]): Array<string | undefined> =>
  traces.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason);
const otherTerminals = (traces: TraceEvent[]): string[] =>
  traces.map((t) => t.type).filter((t) => t === 'inference:completed' || t === 'inference:failed' || t === 'inference:exhausted');

/** The `[turn-interrupted]` notes in an agent's window. */
function notes(agent: Agent): string[] {
  return (agent.getContextManager().queryMessages({}).messages as unknown as Array<{ content: Array<{ type: string; text?: string }> }>)
    .flatMap((m) => m.content.flatMap((b) => b.type === 'text' && (b.text ?? '').startsWith('[turn-interrupted]') ? [b.text!] : []));
}

/** A turn of `prime` held with no stream: in its hooks, or with
 *  `holdCompile`, at its compile once its hooks have run. */
async function aliveWithoutStream(opts: { holdCompile?: boolean } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
  const { membrane, requests } = answeringMembrane();
  const module = new GatedContextModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane,
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
    modules: [module],
    syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  const agent = framework.getAgent('prime')!;
  let compiles = 0;
  const compileEntered = deferred();
  const compileReleased = deferred();
  const compile = agent.startStreamWithInjections.bind(agent);
  agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
    compiles++;
    return compile(...args);
  }) as typeof agent.startStreamWithInjections;
  // `holdCompile` holds the compile at its own await on the tool-result
  // guard's annotations: the compile is under way, and the agent holds no
  // stream until it returns.
  const guard = agent.toolResultGuard;
  const annotations = guard.afterAnnotations.bind(guard);
  guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
    if (opts.holdCompile && compiles === 1) {
      compileEntered.resolve();
      await compileReleased.promise;
    }
    return annotations(read);
  }) as typeof guard.afterAnnotations;
  const hooks = opts.holdCompile ? null : module.hold();
  framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
  await within(opts.holdCompile ? "the turn's compile" : "the turn's hooks", hooks ? hooks.entered : compileEntered.promise);
  assert.equal(framework.getHostModeStatus().activeTurns, 1, 'the turn is alive');
  assert.ok(!('stream' in agent.state) || !agent.state.stream, 'and has no stream');
  return {
    framework, agent, traces, requests, module,
    compiles: () => compiles,
    release: () => { hooks?.release(); compileReleased.resolve(); },
    turnEnded: () => framework.getHostModeStatus().activeTurns === 0 && agent.state.status === 'idle',
    cleanup: async () => {
      hooks?.release();
      compileReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** The inference-log rows a stop wrote: the terminal's row, which reads as a
 *  stop on a live stream's does. */
function stopRows(framework: AgentFramework, agentName: string, reason: string) {
  const text = reason === 'quiesce_abandoned' || reason === 'shutdown' ? `Stream aborted: ${reason}` : `Stream cancelled (${reason})`;
  return framework.queryInferenceLogs({ agentName }).entries.map((e) => e.entry).filter((entry) => entry.error === text);
}

function endedAsStop(h: { framework: AgentFramework; traces: TraceEvent[]; requests: ProviderRequest[]; agent: Agent }, reason: string, note: RegExp | null): void {
  assert.equal(h.requests.length, 0, 'nothing was sent');
  assert.deepEqual(abortReasons(h.traces), [reason], "one inference:aborted, with the stop's reason");
  assert.deepEqual(otherTerminals(h.traces), [], 'and no other terminal');
  const rows = h.framework.queryInferenceLogs({ agentName: h.agent.name }).entries.map((e) => e.entry);
  assert.equal(rows.length, 1, 'the inference log has one row for the turn');
  assert.equal(stopRows(h.framework, h.agent.name, reason).length, 1, "and it's the stop's");
  assert.equal(rows[0].success, false);
  assert.equal(rows[0].tokenUsage, undefined, 'with no usage, since nothing was sent');
  if (note) assert.ok(notes(h.agent).some((n) => note.test(n)), `the agent's note says ${note}`);
  else assert.deepEqual(notes(h.agent), [], 'no note');
}

describe('a stop before the turn has a stream', () => {
  it("a host's cancelStream() while the turn's hooks run ends the turn before its compile", async () => {
    const h = await aliveWithoutStream();
    try {
      h.agent.cancelStream();
      h.release();
      await waitFor('the turn to end', h.turnEnded);
      endedAsStop(h, 'user', /stopped before it sent anything/);
      assert.equal(h.compiles(), 0, 'the turn ended at its check after the hooks');
      assert.deepEqual(h.framework.queryInferenceLogs({ agentName: 'prime' }).entries[0].entry.request,
        { note: 'no request: the turn was stopped before a compile made one' }, 'its row says no request was compiled');
      await within('stop() to finish', h.framework.stop());
    } finally {
      await h.cleanup();
    }
  });

  it('abortInference() while the hooks run reports the stop, which ends the turn', async () => {
    const h = await aliveWithoutStream();
    try {
      assert.equal(h.framework.abortInference('prime', 'operator stop'), true, 'abortInference reports the stop');
      h.release();
      await waitFor('the turn to end', h.turnEnded);
      endedAsStop(h, 'operator stop', /stopped before it sent anything/);
    } finally {
      await h.cleanup();
    }
  });

  it('a stop during the compile ends the turn before its stream is read', async () => {
    const h = await aliveWithoutStream({ holdCompile: true });
    try {
      h.agent.cancelStream('subagent_cancel');
      h.release();
      await waitFor('the turn to end', h.turnEnded);
      assert.equal(h.compiles(), 1, 'the compile ran');
      endedAsStop(h, 'subagent_cancel', /stopped before it sent anything/);
      const request = h.framework.queryInferenceLogs({ agentName: 'prime' }).entries[0].entry.request as { messages?: unknown[] };
      assert.ok(Array.isArray(request.messages), 'its row records the request the compile made, never sent');
    } finally {
      await h.cleanup();
    }
  });

  it("a quiesce's abandon while the hooks run ends the turn, which sends nothing while quiesced", async () => {
    const h = await aliveWithoutStream();
    try {
      const reached = abandonReached(h.framework);
      const quiescing = h.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      h.release();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.quiesced, true);
      assert.equal(status.unabandonable, undefined, 'the turn was not left unabandonable');
      endedAsStop(h, 'quiesce_abandoned', null);
      const quiesce = h.traces.find((t) => t.type === 'host:quiesce') as { unabandonable?: string[] } | undefined;
      assert.equal(quiesce?.unabandonable, undefined, 'its trace lists no unabandonable turn');
      await h.framework.resume();
    } finally {
      await h.cleanup();
    }
  });

  it("a quiesce's abandon during the compile ends the turn before its stream is read", async () => {
    const h = await aliveWithoutStream({ holdCompile: true });
    try {
      const reached = abandonReached(h.framework);
      const quiescing = h.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      h.release();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.unabandonable, undefined, 'the turn was not left unabandonable');
      assert.equal(h.compiles(), 1, 'the compile ran');
      endedAsStop(h, 'quiesce_abandoned', null);
      await h.framework.resume();
    } finally {
      await h.cleanup();
    }
  });

  it("the status lists a turn in its compile as holding a turn, until an abandon ends it at its check", async () => {
    const h = await aliveWithoutStream({ holdCompile: true });
    try {
      const during = h.framework.getHostModeStatus();
      assert.deepEqual(during.activeTurnAgents, ['prime'], 'the turn in its compile holds a turn');
      assert.equal(during.activeTurnAgents.length, during.activeTurns, 'the list is the set activeTurns counts');
      const reached = abandonReached(h.framework);
      const quiescing = h.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      h.release();
      const status = await within('the quiesce to return', quiescing);
      assert.deepEqual(status.activeTurnAgents, [], 'the abandon ended it, and it holds no turn now');
      assert.equal(status.activeTurns, 0);
      await h.framework.resume();
    } finally {
      await h.cleanup();
    }
  });

  it("a caller's stop and a quiesce's abandon at the same start end it as the framework's stop", async () => {
    const h = await aliveWithoutStream();
    try {
      h.agent.cancelStream();
      const reached = abandonReached(h.framework);
      const quiescing = h.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      h.release();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.unabandonable, undefined, 'the turn was not left unabandonable');
      endedAsStop(h, 'quiesce_abandoned', null);
      await h.framework.resume();
    } finally {
      await h.cleanup();
    }
  });

  it("a resume during the abandon's grace leaves the serving host listing nothing, and the turn still ends at its check", async () => {
    const h = await aliveWithoutStream();
    try {
      const reached = abandonReached(h.framework);
      const quiescing = h.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      await within('the resume', h.framework.resume());
      await within('the quiesce to return', quiescing);
      const status = h.framework.getHostModeStatus();
      assert.equal(status.quiesced, false, 'the host is serving');
      assert.equal(status.unabandonable, undefined, 'and lists no turn as unabandonable');
      h.release();
      await waitFor('the turn to end', h.turnEnded);
      // The resume doesn't take the abandon back: the hooks' check collects
      // the mark, as a stream the abandon cancelled still ends.
      endedAsStop(h, 'quiesce_abandoned', null);
    } finally {
      await h.cleanup();
    }
  });

  it("a quiesce's abandon of a turn whose hooks outlast the abandon's grace lists it, and still ends it when they return", async () => {
    const h = await aliveWithoutStream();
    try {
      setAbandonGraceForTests(h.framework, SHORT_ABANDON_GRACE_MS);
      const reached = abandonReached(h.framework);
      const quiescing = h.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      const status = await within('the quiesce to return', quiescing, 15_000);
      assert.deepEqual(status.unabandonable, ['prime'], 'the turn still in its hooks is listed');
      assert.deepEqual(status.activeTurnAgents, ['prime'], 'it still holds its turn');
      const quiesce = h.traces.find((t) => t.type === 'host:quiesce') as { unabandonable?: string[] } | undefined;
      assert.deepEqual(quiesce?.unabandonable, ['prime'], 'and so is its trace');
      h.release();
      await waitFor('the turn to end', h.turnEnded);
      endedAsStop(h, 'quiesce_abandoned', null);
      await h.framework.resume();
    } finally {
      await h.cleanup();
    }
  });

  /** `prime`'s turn waiting to retry an inference that failed, with no
   *  stream, until `delayMs` has passed. The provider answers the retry. */
  async function retryWaiting(delayMs: number) {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const requests: ProviderRequest[] = [];
    // The provider fails until the framework's error policy decides to retry.
    let failing = true;
    const adapter: ProviderAdapter = {
      name: 'test',
      usageCacheConvention: 'cache-excluded',
      supportsModel: () => true,
      complete: async () => { throw new Error('unexpected complete'); },
      stream: async (request: ProviderRequest): Promise<ProviderResponse> => {
        requests.push(request);
        if (failing) throw new Error('provider overloaded');
        return { content: [{ type: 'text', text: 'Answered.' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, model: 'test-model' } as ProviderResponse;
      },
    };
    const retrying = deferred();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: new RealMembrane(adapter, { formatter: new NativeFormatter() }),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()],
      syncIntervalMs: 0,
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error, _agentName, attempt) => {
          if (attempt > 0) return { retry: false };
          failing = false;
          retrying.resolve();
          return { retry: true, delayMs };
        },
      },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    const agent = framework.getAgent('prime')!;
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
    await within('the failed inference to be retried', retrying.promise);
    assert.ok(!('stream' in agent.state) || !agent.state.stream, 'the turn waits with no stream');
    return {
      framework, agent, traces, requests,
      sentBeforeTheStop: requests.length,
      turnEnded: () => framework.getHostModeStatus().activeTurns === 0 && agent.state.status === 'idle',
      cleanup: async () => {
        await within('stop() in cleanup', framework.stop()).catch(() => {});
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }

  it("a stop while the turn waits to retry a failed inference ends it before the retry is sent, writes its row after the stream's, and leaves no check ahead", async () => {
    const r = await retryWaiting(300);
    try {
      r.agent.cancelStream();
      await waitFor('the turn to end', r.turnEnded);
      assert.equal(r.requests.length, r.sentBeforeTheStop, 'the retry was not sent');
      assert.ok(!r.traces.some((t) => t.type === 'inference:completed'), 'and nothing was answered');
      assert.deepEqual(abortReasons(r.traces), ['user'], "one inference:aborted, with the stop's reason");
      assert.ok(notes(r.agent).some((n) => /stopped before it finished/.test(n)), "the agent's note says the turn was stopped before it finished");
      // The stop's row comes after the failed stream's own, written through
      // the same stream's writer, so both carry the stream's request id.
      const rows = r.framework.queryInferenceLogs({ agentName: 'prime' }).entries
        .slice().sort((a, b) => a.sequence - b.sequence).map((e) => e.entry);
      const stops = stopRows(r.framework, 'prime', 'user');
      assert.equal(rows.length, 2, "the inference log has the failed stream's row and the stop's");
      assert.equal(stops.length, 1, "one is the stop's");
      assert.deepEqual(rows[1], stops[0], "the stop's row comes second");
      assert.equal(rows[0].success, false, "after the failed stream's row");
      assert.equal(rows[1].requestId, rows[0].requestId, "through the stream's writer, under the stream's request id");
      assert.equal(rows[1].tokenUsage, undefined, 'and carries no usage');
      assert.equal(r.framework.abortInference('prime', 'again'), false, 'and no check of the ended turn is ahead');
      await within('stop() to finish', r.framework.stop());
    } finally {
      await r.cleanup();
    }
  });

  it('abortInference() while the turn waits to retry a failed inference ends it at once, long before the wait would run out', async () => {
    // A minute's wait: the turn ends within the test's bound only if the
    // stop ends the wait.
    const r = await retryWaiting(60_000);
    try {
      assert.equal(r.framework.abortInference('prime', 'user'), true, 'abortInference reports the stop');
      await waitFor('the turn to end', r.turnEnded);
      assert.equal(r.requests.length, r.sentBeforeTheStop, 'the retry was not sent');
      assert.deepEqual(abortReasons(r.traces), ['user'], "one inference:aborted, with the stop's reason");
      await within('stop() to finish', r.framework.stop());
    } finally {
      await r.cleanup();
    }
  });

  it("abortInference() wakes only its own turn's wait to retry: another agent's wait, with no stop, stays asleep", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    // Every request fails, and each agent's failed inference waits a minute
    // to retry.
    const sentBy = { prime: 0, second: 0 };
    const adapter: ProviderAdapter = {
      name: 'test',
      usageCacheConvention: 'cache-excluded',
      supportsModel: () => true,
      complete: async () => { throw new Error('unexpected complete'); },
      stream: async (request: ProviderRequest): Promise<ProviderResponse> => {
        sentBy[JSON.stringify(request).includes('You are second.') ? 'second' : 'prime']++;
        throw new Error('provider overloaded');
      },
    };
    const waiting = { prime: deferred(), second: deferred() };
    const module = new GatedContextModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: new RealMembrane(adapter, { formatter: new NativeFormatter() }),
      agents: [
        { name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' },
        { name: 'second', model: 'test-model', systemPrompt: 'You are second.', allowedTools: 'all' },
      ],
      modules: [module],
      syncIntervalMs: 0,
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error, agentName, attempt) => {
          if (attempt > 0) return { retry: false };
          waiting[agentName as 'prime' | 'second'].resolve();
          return { retry: true, delayMs: 60_000 };
        },
      },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    try {
      framework.start();
      for (const name of ['prime', 'second']) {
        framework.getAgent(name)!.getContextManager().addMessage('user', [{ type: 'text', text: 'hello' }]);
        framework.nudgeAgent(name, 'test');
      }
      await within("both agents' failed inferences to be retried", Promise.all([waiting.prime.promise, waiting.second.promise]));
      // A retry that started would reach its hooks, which hold.
      const nextHooks = module.hold();
      let retryStarted = false;
      void nextHooks.entered.then(() => { retryStarted = true; });
      const sentBefore = { ...sentBy };
      const startsOfSecond = () => traces.filter((t) => t.type === 'inference:started' && (t as { agentName?: string }).agentName === 'second').length;
      const secondStartsBefore = startsOfSecond();
      const checkAhead = (framework as unknown as { checkAhead: Map<Agent, unknown> }).checkAhead;
      const second = framework.getAgent('second')!;
      const secondWindow = checkAhead.get(second);
      assert.ok(secondWindow, 'second waits to retry, in its window');
      assert.equal(framework.abortInference('prime', 'user'), true, "abortInference reports prime's stop");
      // A wake is a call, and the wait it ends leaves its window in the
      // microtasks after it; one delivered on a timer with no delay does so
      // before a timer set now fires.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(checkAhead.get(second), secondWindow, "second's wait wasn't woken: it still holds its window");
      await waitFor("prime's turn to end", () => abortReasons(traces).length === 1);
      assert.deepEqual(abortReasons(traces), ['user'], "prime's turn ended as the stop");
      assert.equal(framework.getHostModeStatus().activeTurns, 1, "second's turn is still running");
      assert.equal(startsOfSecond(), secondStartsBefore, "and its retry hasn't started");
      assert.equal(retryStarted, false, "nor reached its hooks");
      assert.deepEqual(sentBy, sentBefore, 'neither retry was sent');
      nextHooks.release();
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a quiesce's abandon while the turn waits to retry a failed inference ends it, and the retry isn't sent while quiesced", async () => {
    // The wait has no end: the turn ends within the abandon's 10 s grace
    // only if the abandon ends the wait, and the quiesce's answer says so.
    const r = await retryWaiting(Number.POSITIVE_INFINITY);
    try {
      const quiescing = r.framework.quiesce({ timeoutMs: 50, abandon: true });
      const status = await within('the quiesce to return', quiescing, 15_000);
      assert.equal(status.quiesced, true);
      assert.equal(status.unabandonable, undefined, 'the turn was not left unabandonable');
      assert.ok(r.turnEnded(), 'the turn has ended');
      assert.equal(r.requests.length, r.sentBeforeTheStop, 'the retry was not sent');
      assert.ok(!r.traces.some((t) => t.type === 'inference:completed'), 'and nothing was answered');
      assert.deepEqual(abortReasons(r.traces), ['quiesce_abandoned'], "one inference:aborted, with the abandon's reason");
      assert.deepEqual(notes(r.agent), [], 'no note');
      await r.framework.resume();
    } finally {
      await r.cleanup();
    }
  });

  /** A turn whose first inference fails, with a policy that retries at
   *  once, and a listener of that inference:failed. */
  async function failedInferenceWithListener(onFailed: (framework: AgentFramework, agent: Agent) => unknown) {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const requests: ProviderRequest[] = [];
    let failing = true;
    const adapter: ProviderAdapter = {
      name: 'test',
      usageCacheConvention: 'cache-excluded',
      supportsModel: () => true,
      complete: async () => { throw new Error('unexpected complete'); },
      stream: async (request: ProviderRequest): Promise<ProviderResponse> => {
        requests.push(request);
        if (failing) throw new Error('provider overloaded');
        return { content: [{ type: 'text', text: 'Answered.' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, model: 'test-model' } as ProviderResponse;
      },
    };
    const policy = { asked: 0 };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: new RealMembrane(adapter, { formatter: new NativeFormatter() }),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()],
      syncIntervalMs: 0,
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error, _agentName, attempt) => {
          policy.asked++;
          if (attempt > 0) return { retry: false };
          failing = false;
          return { retry: true, delayMs: 0 };
        },
      },
    });
    const traces: TraceEvent[] = [];
    const agent = framework.getAgent('prime')!;
    // A host's listener, called in the trace's own delivery.
    let answer: unknown;
    let called = false;
    framework.onTrace((event) => {
      traces.push(event);
      if (event.type === 'inference:failed' && !called) { called = true; answer = onFailed(framework, agent); }
    });
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
    await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:completed')
      && framework.getHostModeStatus().activeTurns === 0 && agent.state.status === 'idle');
    return {
      framework, agent, traces, requests, policy, answer: () => answer,
      cleanup: async () => {
        await within('stop() in cleanup', framework.stop()).catch(() => {});
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }

  it("abortInference() from a listener of a failed inference's inference:failed reports false: the agent holds no stream and no check is ahead yet", async () => {
    const r = await failedInferenceWithListener((framework) => framework.abortInference('prime', 'user'));
    try {
      assert.equal(r.answer(), false, 'abortInference took no stop');
      assert.equal(r.requests.length, 2, 'the retry was sent');
      assert.ok(r.traces.some((t) => t.type === 'inference:completed'), 'and answered');
      assert.deepEqual(abortReasons(r.traces), [], 'nothing was aborted');
    } finally {
      await r.cleanup();
    }
  });

  it("cancelStream() from a listener of a failed inference's inference:failed ends the turn at the check after the wait to retry, before the retry is sent", async () => {
    const r = await failedInferenceWithListener((_framework, agent) => agent.cancelStream());
    try {
      assert.equal(r.requests.length, 1, 'the retry was not sent');
      assert.equal(r.policy.asked, 1, 'the error policy decided to retry');
      assert.ok(!r.traces.some((t) => t.type === 'inference:completed'), 'nothing was answered');
      assert.deepEqual(abortReasons(r.traces), ['user'], "one inference:aborted, with the stop's reason");
      assert.ok(notes(r.agent).some((n) => /stopped before it finished/.test(n)), "the agent's note says the turn was stopped before it finished");
      // The stop's row comes after the failed stream's own, through the same
      // stream's writer.
      const rows = r.framework.queryInferenceLogs({ agentName: 'prime' }).entries
        .slice().sort((a, b) => a.sequence - b.sequence).map((e) => e.entry);
      assert.equal(rows.length, 2, "the inference log has the failed stream's row and the stop's");
      assert.equal(rows[1].error, stopRows(r.framework, 'prime', 'user')[0]?.error, "the stop's row comes second");
      assert.equal(rows[1].requestId, rows[0].requestId, "through the stream's writer, under the stream's request id");
    } finally {
      await r.cleanup();
    }
  });

  it("abortInference() from a listener of the inference:failed of a stream that threw reports false, and the turn ends as exhausted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    // The stream throws as it is read, rather than reporting an error event.
    class ThrowingMembrane extends MockMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        this.calls.push(request);
        const stream = new MockYieldingStream([]);
        Object.defineProperty(stream, Symbol.asyncIterator, { value: () => ({ next: async () => { throw new Error('the stream threw'); } }) });
        return stream;
      }
    }
    const membrane = new ThrowingMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    let taken: boolean | undefined;
    framework.onTrace((event) => {
      traces.push(event);
      if (event.type === 'inference:failed' && taken === undefined) taken = framework.abortInference('prime', 'user');
    });
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:exhausted' || t.type === 'inference:aborted')
        && framework.getHostModeStatus().activeTurns === 0);
      assert.equal(taken, false, 'abortInference took no stop');
      assert.ok(traces.some((t) => t.type === 'inference:exhausted'), 'the turn ended as exhausted');
      assert.deepEqual(abortReasons(traces), [], 'not as a stop');
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a stop while the compile runs ends the turn when the compile fails, before the error policy waits to retry it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
      // A minute's wait to retry: the turn ends within the test's bound only
      // if the stop ends it at the failure, before the wait.
      errorPolicy: { maxRetries: 1, onInferenceError: (_error, _agentName, attempt) => (attempt > 0 ? { retry: false } : { retry: true, delayMs: 60_000 }) },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const agent = framework.getAgent('prime')!;
    // The first compile waits at its await on the guard's annotations, and
    // then fails.
    let compiles = 0;
    const compileEntered = deferred();
    const compileReleased = deferred();
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) {
        compileEntered.resolve();
        await compileReleased.promise;
        throw new Error('the compile failed');
      }
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await within("the turn's compile", compileEntered.promise);
      agent.cancelStream();
      compileReleased.resolve();
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:completed')
        && framework.getHostModeStatus().activeTurns === 0);
      assert.ok(traces.some((t) => t.type === 'inference:failed'), "the compile's failure was reported");
      assert.equal(compiles, 1, 'no retry compiled');
      assert.equal(requests.length, 0, 'nothing was sent');
      assert.deepEqual(abortReasons(traces), ['user'], "one inference:aborted, with the stop's reason");
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'), 'the turn ended as a stop, not as exhausted');
      assert.ok(notes(agent).some((n) => /stopped before it sent anything/.test(n)), "the agent's note says the turn was stopped before it sent anything");
      await within('stop() to finish', framework.stop());
    } finally {
      compileReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("abortInference() from a listener of a failed compile's inference:failed reports the stop, which ends the turn there, before the retry", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
      errorPolicy: { maxRetries: 1, onInferenceError: (_error, _agentName, attempt) => (attempt > 0 ? { retry: false } : { retry: true, delayMs: 60_000 }) },
    });
    const traces: TraceEvent[] = [];
    // A host's listener, called in the report's own delivery. The start's
    // check is still ahead of it.
    let taken: boolean | undefined;
    framework.onTrace((event) => {
      traces.push(event);
      if (event.type === 'inference:failed' && taken === undefined) taken = framework.abortInference('prime', 'user');
    });
    const agent = framework.getAgent('prime')!;
    let compiles = 0;
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) throw new Error('the compile failed');
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:completed')
        && framework.getHostModeStatus().activeTurns === 0);
      assert.equal(taken, true, 'abortInference reports the stop');
      assert.equal(compiles, 1, 'no retry compiled');
      assert.equal(requests.length, 0, 'nothing was sent');
      assert.deepEqual(abortReasons(traces), ['user'], "one inference:aborted, with the stop's reason");
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'), 'the turn ended as a stop, not as exhausted');
      assert.ok(notes(agent).some((n) => /stopped before it sent anything/.test(n)), "the agent's note says the turn was stopped before it sent anything");
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const how of ['stopping', 'replaced'] as const) it(`a stop during a compile that then fails ${how === 'stopping' ? 'while stop() runs' : 'after its agent was replaced'} drops the turn as ${how === 'stopping' ? "stop()'s" : "the replacement's"}, before it sends anything, with no note`, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
      gate: { config: { policies: [], default: 'always' } },
      errorPolicy: { maxRetries: 1, onInferenceError: (_error, _agentName, attempt) => (attempt > 0 ? { retry: false } : { retry: true, delayMs: 60_000 }) },
    });
    const gate = (framework as unknown as { eventGate: { inferenceDiagnostics(): { inferring: string[] } } }).eventGate;
    const traces: TraceEvent[] = [];
    // stop() disposes the gate, which clears it: the gate is read as the
    // drop is reported, after the drop's own release.
    let inferringAtDrop: string[] | undefined;
    framework.onTrace((event) => {
      traces.push(event);
      if (event.type === 'inference:aborted' && inferringAtDrop === undefined) inferringAtDrop = [...gate.inferenceDiagnostics().inferring];
    });
    const agent = framework.getAgent('prime')!;
    const noteWrites: string[] = [];
    // The first compile waits at its await on the guard's annotations, and
    // then fails.
    let compiles = 0;
    const compileEntered = deferred();
    const compileReleased = deferred();
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) {
        compileEntered.resolve();
        await compileReleased.promise;
        throw new Error('the compile failed');
      }
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    // The store closes with stop(), so a note is caught as it is written.
    const cm = agent.getContextManager();
    const addMessage = cm.addMessage.bind(cm);
    cm.addMessage = ((participant: string, content: Array<{ type: string; text?: string }>, ...rest: unknown[]) => {
      for (const block of content) if (block.type === 'text' && (block.text ?? '').startsWith('[turn-interrupted]')) noteWrites.push(block.text!);
      return (addMessage as (...args: unknown[]) => unknown)(participant, content, ...rest);
    }) as typeof cm.addMessage;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await within("the turn's compile", compileEntered.promise);
      agent.cancelStream();
      let stopping: Promise<void> | undefined;
      if (how === 'stopping') {
        stopping = framework.stop();
        await waitFor('stop() to close provider admission', () => (framework as unknown as { providerAdmissionClosed: boolean }).providerAdmissionClosed);
      } else {
        // As a replacement under the agent's name does.
        (framework as unknown as { agents: Map<string, unknown> }).agents.set('prime', Object.create(agent));
      }
      compileReleased.resolve();
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:exhausted'));
      if (stopping) await within('stop() to finish', stopping);
      const why = how === 'stopping' ? 'the framework was stopping' : 'the agent was replaced or removed';
      assert.ok(traces.some((t) => t.type === 'inference:failed'), "the compile's failure was reported");
      assert.equal(compiles, 1, 'no retry compiled');
      assert.equal(requests.length, 0, 'nothing was sent');
      assert.deepEqual(abortReasons(traces), [`a turn whose request couldn't be built while ${why} is dropped before it sends anything`], 'the turn was dropped');
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'), 'not exhausted');
      assert.deepEqual(noteWrites, [], 'and no [turn-interrupted] note was written');
      assert.deepEqual(inferringAtDrop, [], 'and the drop closed the turn at the event gate');
    } finally {
      compileReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("abortInference() reports a stop while the retry of a failed compile waits to retry its own failed stream, and the turn ends there", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    // The first stream fails as soon as it's read.
    class FailingFirstStream extends MockMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        this.calls.push(request);
        if (this.calls.length === 1) return new ErrorStream(new Error('provider overloaded'));
        return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'Answered.' }])]);
      }
    }
    const membrane = new FailingFirstStream();
    const retrying = deferred();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
      // The failed compile is retried at once; the retry's failed stream
      // waits to retry.
      errorPolicy: {
        maxRetries: 2,
        onInferenceError: (_error, _agentName, attempt) => {
          if (attempt === 0) return { retry: true, delayMs: 0 };
          if (attempt === 1) { retrying.resolve(); return { retry: true, delayMs: 300 }; }
          return { retry: false };
        },
      },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const agent = framework.getAgent('prime')!;
    let compiles = 0;
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) throw new Error('the compile failed');
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      // The wait's window opened as the policy decided. By the time the test
      // resumes here, with no timer run since, the starts that retried the
      // compile have ended: a start that closed the agent's window, rather
      // than only its own, has closed the wait's by now, and the stop isn't
      // taken.
      await within("the retry's failed stream to be retried", retrying.promise);
      assert.equal(framework.abortInference('prime', 'user'), true, 'abortInference reports the stop');
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:completed')
        && framework.getHostModeStatus().activeTurns === 0);
      assert.equal(membrane.calls.length, 1, "the stream's retry was not sent");
      assert.deepEqual(abortReasons(traces), ['user'], "one inference:aborted, with the stop's reason");
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a stop while the compile runs ends the turn when the compile fails, before a provider hold can park it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    // The host would hold the turn on the compile's failure: without the stop,
    // the hold parks it, and its start runs when the hold ends.
    let holdsAsked = 0;
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      providerHold: () => (holdsAsked++ === 0 ? { holdMs: 300, reason: 'quota spent' } : undefined),
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const agent = framework.getAgent('prime')!;
    // The first compile waits at its await on the guard's annotations, and
    // then fails.
    let compiles = 0;
    const compileEntered = deferred();
    const compileReleased = deferred();
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) {
        compileEntered.resolve();
        await compileReleased.promise;
        throw new Error('quota spent');
      }
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await within("the turn's compile", compileEntered.promise);
      agent.cancelStream();
      compileReleased.resolve();
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:completed')
        && framework.getHostModeStatus().activeTurns === 0);
      assert.deepEqual(abortReasons(traces), ['user'], "one inference:aborted, with the stop's reason");
      assert.equal(holdsAsked, 0, 'no provider hold was asked for');
      assert.equal(compiles, 1, 'the turn was not compiled again');
      assert.equal(requests.length, 0, 'nothing was sent');
      await within('stop() to finish', framework.stop());
    } finally {
      compileReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a quiesce's abandon during a compile that then fails ends the turn at the failure, and the agent's next turn runs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const agent = framework.getAgent('prime')!;
    // The first compile waits at its await on the guard's annotations, and
    // then fails, short of its check after the compile.
    let compiles = 0;
    const compileEntered = deferred();
    const compileReleased = deferred();
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) {
        compileEntered.resolve();
        await compileReleased.promise;
        throw new Error('the compile failed');
      }
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await within("the turn's compile", compileEntered.promise);
      const reached = abandonReached(framework);
      const quiescing = framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      compileReleased.resolve();
      const status = await within('the quiesce to return', quiescing);
      assert.deepEqual(abortReasons(traces), ['quiesce_abandoned'], "the turn ended at its failure, as the abandon's stop");
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'), 'not as exhausted');
      assert.equal(status.unabandonable, undefined, 'and the abandon left nothing behind');
      await framework.resume();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'again', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the next turn to be answered', () => traces.some((t) => t.type === 'inference:completed'));
      assert.equal(requests.length, 1, 'the next turn sent its request');
      assert.deepEqual(abortReasons(traces), ['quiesce_abandoned'], 'and nothing ended it as a stop');
      await within('stop() to finish', framework.stop());
    } finally {
      compileReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a stop while a failed compile waits to retry ends the turn before the retry compiles', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const retrying = deferred();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
      errorPolicy: {
        maxRetries: 1,
        onInferenceError: (_error, _agentName, attempt) => {
          if (attempt > 0) return { retry: false };
          retrying.resolve();
          return { retry: true, delayMs: 300 };
        },
      },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const agent = framework.getAgent('prime')!;
    // The first compile fails, and the error policy waits to retry it.
    let compiles = 0;
    const guard = agent.toolResultGuard;
    const annotations = guard.afterAnnotations.bind(guard);
    guard.afterAnnotations = (async (read: () => Promise<unknown>) => {
      if (++compiles === 1) throw new Error('the compile failed');
      return annotations(read);
    }) as typeof guard.afterAnnotations;
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await within('the failed compile to be retried', retrying.promise);
      agent.cancelStream();
      await waitFor('the turn to end', () => traces.some((t) => t.type === 'inference:aborted' || t.type === 'inference:completed')
        && framework.getHostModeStatus().activeTurns === 0);
      assert.equal(compiles, 1, "the retry's compile never ran");
      assert.equal(requests.length, 0, 'nothing was sent');
      assert.deepEqual(abortReasons(traces), ['user'], "one inference:aborted, with the stop's reason");
      assert.ok(notes(agent).some((n) => /stopped before it sent anything/.test(n)), "the agent's note says the turn was stopped before it sent anything");
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('an ephemeral run stopped before its stream rejects with the stop, long before its watchdog', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const module = new GatedContextModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane, agents: [], modules: [module], syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    try {
      const { agent, contextManager } = await framework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
      });
      contextManager.addMessage('user', [{ type: 'text', text: 'go' }]);
      const hooks = module.hold();
      // A watchdog far past this test's own bound: a run that settles within
      // the bound was settled by the stop, not by the watchdog.
      const run = framework.runEphemeralToCompletion(agent, contextManager, { idleTimeoutMs: 600_000, idlePollMs: 50 });
      const outcome = run.then(() => 'resolved', (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`);
      framework.start();
      await within("the run's hooks", hooks.entered);
      agent.cancelStream('subagent_cancel');
      hooks.release();
      assert.equal(await within('the run to settle', outcome, 10_000), 'rejected: Stream cancelled', 'the run rejects with the stop');
      assert.equal(requests.length, 0, 'nothing was sent');
      assert.deepEqual(abortReasons(traces), ['subagent_cancel'], "one inference:aborted, with the stop's reason");
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('a stop while no turn is running', () => {
  it("ends nothing: the agent's next turn runs, as after a host's interrupt of every agent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()],
      syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    try {
      framework.start();
      const agent = framework.getAgent('prime')!;
      agent.cancelStream();
      assert.equal(framework.abortInference('prime', 'operator stop'), false, 'with no turn running, nothing is aborted');
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the turn to be answered', () => traces.some((t) => t.type === 'inference:completed'));
      assert.equal(requests.length, 1, 'the turn sent its request');
      assert.deepEqual(abortReasons(traces), [], 'nothing was aborted');
      assert.deepEqual(notes(agent), [], 'no note');
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a message sent after a stop during a provider-capacity hold is answered when the hold ends', async () => {
    // A host hold parks the turn after its first request fails on a spent
    // quota: no stream runs while it waits, though the turn is alive until
    // its retry starts, and when the hold ends, one start takes every wake
    // held for the agent. A stop made during the hold ends the held turn,
    // and must not cost the message sent after it its answer.
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const membrane = new QuotaOnceMembrane();
    let holds = 0;
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      providerHold: () => (holds++ === 0 ? { holdMs: 500, reason: 'quota spent' } : undefined),
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    const cooldowns = (framework as unknown as { providerAccelerationCooldowns: Map<string, unknown> }).providerAccelerationCooldowns;
    try {
      framework.start();
      const agent = framework.getAgent('prime')!;
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the hold to park the turn', () => cooldowns.has('prime'));
      assert.deepEqual(framework.getHostModeStatus().activeTurnAgents, ['prime'], 'the held turn is alive');
      assert.equal(membrane.calls.length, 1, 'the first request failed on the quota');
      // The held turn is alive with no stream: abortInference() ends it, its
      // retry dropped from the hold, as a stop ends a turn's start.
      assert.equal(framework.abortInference('prime', 'user'), true, 'abortInference() ends the turn the hold keeps for its retry');
      assert.deepEqual(framework.getHostModeStatus().activeTurnAgents, [], 'and the turn is over');
      agent.cancelStream();
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'a message sent after the stop', metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the message sent after the stop to be answered',
        () => traces.some((t) => t.type === 'inference:completed'), 10_000);
      assert.ok(membrane.calls.some((request) => JSON.stringify(request.messages).includes('a message sent after the stop')),
        'a request carrying the message sent after the stop reached the provider');
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a stop made while no check is ahead doesn't end a restart queued later, as a hold replays the trigger it held", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-'));
    const { membrane, requests } = answeringMembrane();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }],
      modules: [new GatedContextModule()], syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    try {
      framework.start();
      framework.getAgent('prime')!.cancelStream();
      // A budget restart's trigger queued with no check of a turn ahead, as
      // a provider hold's release queues the trigger it held, whatever its
      // reason.
      queueRestart(framework);
      await waitFor('the restart to be answered', () => traces.some((t) => t.type === 'inference:completed'));
      assert.equal(requests.length, 1, 'the restart sent its request');
      assert.deepEqual(abortReasons(traces), [], 'nothing was aborted');
      await within('stop() to finish', framework.stop());
    } finally {
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// The guard's refusal retry: a round whose result the provider refuses is
// withheld, and the turn is retried once the agent's earlier speech has gone
// out. A channel that holds the round's post keeps the retry waiting.

const answer = (text: string) => createMockResponse([{ type: 'text', text }]);
const refused = () => ({
  ...createMockResponse([{ type: 'text', text: 'discard-this-partial-output' }], 'refusal'),
  raw: { request: {}, response: { stop_details: { category: 'test-category' } } },
}) as NormalizedResponse;
const postThenRead = () => createMockResponse([
  { type: 'text', text: '>>#cafe Reading.' },
  { type: 'tool_use', id: 'one', name: 'gated--read', input: {} },
] as ContentBlock[], 'tool_use');

const unscripted: string[] = [];
afterEach(() => {
  assert.deepEqual(unscripted.splice(0), [], 'every stream the framework opened was one the test scripted');
});

/** Scripted streams; `requests` counts the streams made, one per request. */
class ScriptMembrane {
  readonly requests: NormalizedRequest[] = [];
  constructor(private readonly scripts: NormalizedResponse[][]) {}
  streamYielding(request: NormalizedRequest, _options: YieldingStreamOptions = {}) {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) {
      const last = request.messages.at(-1)?.content.map((b) => (b as { text?: string }).text ?? `[${b.type}]`).join(' ') ?? '';
      unscripted.push(`stream ${this.requests.length}, after: ${last.slice(0, 120)}`);
      throw new Error('unexpected extra inference');
    }
    return new MockYieldingStream(script);
  }
  asMembrane(): Membrane { return this as unknown as Membrane; }
}

/** A channel registry with one channel, `#cafe`, whose first post waits for
 *  `released`. `posted` collects each post's text. */
function firstPostHeld(posted: string[], released: Promise<void>): unknown {
  // Speech reaches the registry through deliverSpeech, or through
  // routeSpeech, which reduces its outcome to the confirmed delivery.
  type Channel = { serverId: string; channelId: string };
  const deliverSpeech = async (_agent: string, text: string, to: Channel | null) => {
    posted.push(text.trim());
    if (posted.length === 1) await released;
    return { status: 'delivered' as const, destination: { serverId: to?.serverId ?? 'stub', channelId: to?.channelId ?? '' }, at: Date.now() };
  };
  return new Proxy({
    resolveProseTarget: (spec: string) => spec === '#cafe' ? { serverId: 'stub', channelId: 'chan-cafe' } : { error: `no channel ${spec}` },
    deliverSpeech,
    routeSpeech: async (agent: string, text: string, to: Channel | null) => {
      const outcome = await deliverSpeech(agent, text, to);
      return { delivered: true, serverId: outcome.destination.serverId, channelId: outcome.destination.channelId };
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  }, { get: (target, key: string) => key in target ? (target as Record<string, unknown>)[key] : () => undefined });
}

/** `assistant`'s guard retry, waiting on its round's held post. */
async function guardRetryWaiting() {
  const dir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-guard-'));
  const membrane = new ScriptMembrane([[postThenRead(), refused()], [answer('>>#cafe continued')]]);
  const module = new GatedContextModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', toolResultGuard: true, proseRouting: 'explicit' }],
    modules: [module],
    syncIntervalMs: 0,
  });
  const posted: string[] = [];
  const postReleased = deferred();
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = firstPostHeld(posted, postReleased.promise);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  const agent = framework.getAgent('assistant')!;
  framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'read', metadata: {} } as unknown as ProcessEvent);
  await waitFor("the guard's retry to wait on the round's post", () =>
    traces.some((t) => t.type === 'inference:stream_restarted' && (t as { reason?: string }).reason === 'tool_result_guard'));
  assert.equal(membrane.requests.length, 1, 'the retry has not started');
  assert.deepEqual(posted, ['Reading.'], "the round's post is held");
  return {
    framework, agent, traces, membrane, module, posted,
    releasePost: () => postReleased.resolve(),
    turnEnded: () => framework.getHostModeStatus().activeTurns === 0 && agent.state.status === 'idle',
    cleanup: async () => {
      postReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `writer`: where the stop's row was written. At the guard's check after
 *  its wait, through the refused round's stream's writer; at a check of the
 *  retry's own start, directly, under a request id of the start's own. */
function endedWithoutRetry(g: Awaited<ReturnType<typeof guardRetryWaiting>>, reason: string, note: RegExp | null, writer: 'round' | 'start' = 'round'): void {
  assert.equal(g.membrane.requests.length, 1, 'the retry was not sent');
  assert.deepEqual(abortReasons(g.traces), [reason], "one inference:aborted, with the stop's reason");
  assert.deepEqual(otherTerminals(g.traces), [], 'and no other terminal');
  assert.ok(!g.posted.includes('continued'), 'nothing more was posted');
  assert.equal(g.agent.toolResultGuard.recovering, false, 'the guard is not left recovering');
  const stops = stopRows(g.framework, g.agent.name, reason);
  assert.equal(stops.length, 1, "the inference log has the stop's row");
  assert.equal(stops[0].tokenUsage, undefined, 'which carries no usage');
  // The stop's row comes after the refused round's own.
  const rows = g.framework.queryInferenceLogs({ agentName: g.agent.name }).entries
    .slice().sort((a, b) => a.sequence - b.sequence).map((e) => e.entry);
  const refused = rows.findIndex((row) => row.error === 'Tool output withheld by the guard');
  const stopAt = rows.findIndex((row) => row.error === stops[0].error);
  assert.ok(refused >= 0, "the inference log has the refused round's own row");
  assert.ok(stopAt > refused, "and the stop's row comes after it");
  if (writer === 'round') {
    assert.equal(rows[stopAt].requestId, rows[refused].requestId, "through the round's stream's writer, under its request id");
  } else {
    assert.notEqual(rows[stopAt].requestId, rows[refused].requestId, "written directly by the retry's start, under its own request id");
  }
  assert.equal(g.framework.abortInference(g.agent.name, 'user'), false, 'and no check of the turn is left ahead');
  if (note) assert.ok(notes(g.agent).some((n) => note.test(n)), `the agent's note says ${note}`);
  else assert.deepEqual(notes(g.agent), [], 'no note');
}

describe("a stop while the guard's refusal retry waits", () => {
  it("a host's cancelStream() ends the turn instead of the retry", async () => {
    const g = await guardRetryWaiting();
    try {
      g.agent.cancelStream();
      g.releasePost();
      await waitFor('the turn to end', g.turnEnded);
      endedWithoutRetry(g, 'user', /stopped before it finished/);
    } finally {
      await g.cleanup();
    }
  });

  it('abortInference() reports the stop once, and the retry is not sent', async () => {
    const g = await guardRetryWaiting();
    try {
      assert.equal(g.framework.abortInference('assistant', 'operator stop'), true, 'abortInference reports the stop');
      g.releasePost();
      await waitFor('the turn to end', g.turnEnded);
      endedWithoutRetry(g, 'operator stop', /stopped before it finished/);
    } finally {
      await g.cleanup();
    }
  });

  it("a quiesce's abandon ends the turn, and the retry doesn't run while quiesced", async () => {
    const g = await guardRetryWaiting();
    try {
      const reached = abandonReached(g.framework);
      const quiescing = g.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      g.releasePost();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.quiesced, true);
      endedWithoutRetry(g, 'quiesce_abandoned', null);
      await g.framework.resume();
    } finally {
      await g.cleanup();
    }
  });

  it("a quiesce's abandon whose cancel of the finished stream throws still ends the turn at the guard's check, listing nothing", async () => {
    const g = await guardRetryWaiting();
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const held = g.agent.state as { stream?: { cancel(): void } };
      assert.ok(held.stream, "the agent holds the round's finished stream while the guard waits");
      let cancels = 0;
      held.stream.cancel = () => { cancels++; throw new Error('zz the stream refused its cancel'); };
      const reached = abandonReached(g.framework);
      const quiescing = g.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      assert.equal(cancels, 1, 'the abandon tried to cancel the finished stream');
      g.releasePost();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.quiesced, true);
      assert.equal(status.unabandonable, undefined, 'nothing listed: the check ended the turn');
      endedWithoutRetry(g, 'quiesce_abandoned', null);
      assert.ok(lines.some((l) => /^\[host-mode\] abandoning in-flight turn for assistant: its stream's cancel threw, so the turn ends at its next check instead: /.test(l)),
        lines.join('\n'));
      assert.ok(!lines.some((l) => l.startsWith('[host-mode] cannot abandon turn for assistant')), 'and not that it cannot');
      await g.framework.resume();
    } finally {
      console.error = original;
      await g.cleanup();
    }
  });

  it('stop() ends the turn as a shutdown', async () => {
    const g = await guardRetryWaiting();
    // The store closes with stop(), so the rows are read as they are written.
    const rows: Array<{ error?: string; tokenUsage?: unknown; requestId?: string }> = [];
    const internal = g.framework as unknown as { logInference: (entry: { error?: string; tokenUsage?: unknown; requestId?: string }) => void };
    const write = internal.logInference.bind(g.framework);
    internal.logInference = (entry) => { rows.push(entry); write(entry); };
    // The refused round's own row, written before the wait.
    const refusedRow = g.framework.queryInferenceLogs({ agentName: g.agent.name }).entries
      .map((e) => e.entry).find((row) => row.error === 'Tool output withheld by the guard');
    try {
      const stopping = g.framework.stop();
      await waitFor('stop() to cancel the finished stream', () => g.agent.state.status === 'idle');
      g.releasePost();
      await within('stop() to finish', stopping);
      assert.ok(refusedRow, "the refused round's own row was written before the stop");
      assert.equal(g.membrane.requests.length, 1, 'the retry was not sent');
      assert.deepEqual(abortReasons(g.traces), ['shutdown'], 'one inference:aborted, as a shutdown');
      assert.deepEqual(otherTerminals(g.traces), [], 'and no other terminal');
      assert.ok(!g.posted.includes('continued'), 'nothing more was posted');
      const shutdownRows = rows.filter((row) => row.error === 'Stream aborted: shutdown');
      assert.equal(shutdownRows.length, 1, "the stop's row was written");
      assert.equal(shutdownRows[0].tokenUsage, undefined, "with no usage: the refused round's own row carried it");
      assert.equal(shutdownRows[0].requestId, refusedRow!.requestId, "through the round's stream's writer, under its request id");
    } finally {
      await g.cleanup();
    }
  });

  it("a caller's cancelStream() and then a quiesce's abandon end the turn as the abandon", async () => {
    const g = await guardRetryWaiting();
    try {
      // The caller's stop takes the finished stream, so the abandon finds
      // none: it reaches the turn through the wait's window.
      g.agent.cancelStream();
      const reached = abandonReached(g.framework);
      const quiescing = g.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      g.releasePost();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.unabandonable, undefined, 'the turn ended within the grace');
      endedWithoutRetry(g, 'quiesce_abandoned', null);
      await g.framework.resume();
    } finally {
      await g.cleanup();
    }
  });

  it("a caller's cancelStream() and then stop() end the turn as a shutdown", async () => {
    const g = await guardRetryWaiting();
    try {
      // The caller's stop takes the finished stream, so stop() marks none.
      g.agent.cancelStream();
      const stopping = g.framework.stop();
      await waitFor('stop() to close provider admission', () => (g.framework as unknown as { providerAdmissionClosed: boolean }).providerAdmissionClosed);
      g.releasePost();
      await within('stop() to finish', stopping);
      assert.equal(g.membrane.requests.length, 1, 'the retry was not sent');
      assert.deepEqual(abortReasons(g.traces), ['shutdown'], 'one inference:aborted, as a shutdown');
      assert.deepEqual(otherTerminals(g.traces), [], 'and no other terminal');
    } finally {
      await g.cleanup();
    }
  });

  it("a caller's cancelStream(), an abandon and then stop() end the turn as a shutdown", async () => {
    const g = await guardRetryWaiting();
    try {
      g.agent.cancelStream();
      const reached = abandonReached(g.framework);
      const quiescing = g.framework.quiesce({ timeoutMs: 50, abandon: true });
      void quiescing.catch(() => {});
      await within('the abandon to reach the turn', reached);
      // With no stream left to record on, stop() reaches the turn by closing
      // admission, which the check reads before the abandon's mark.
      const stopping = g.framework.stop();
      await waitFor('stop() to close provider admission', () => (g.framework as unknown as { providerAdmissionClosed: boolean }).providerAdmissionClosed);
      g.releasePost();
      await within('stop() to finish', stopping);
      assert.equal(g.membrane.requests.length, 1, 'the retry was not sent');
      assert.deepEqual(abortReasons(g.traces), ['shutdown'], 'one inference:aborted, as a shutdown');
    } finally {
      await g.cleanup();
    }
  });

  it("an abandon, a caller's cancelStream() and then stop() end the turn as a shutdown", async () => {
    const g = await guardRetryWaiting();
    try {
      // The abandon records itself on the finished stream, which the agent
      // still holds; the caller's stop then takes the stream, so stop()
      // finds none to record on.
      const reached = abandonReached(g.framework);
      const quiescing = g.framework.quiesce({ timeoutMs: 50, abandon: true });
      void quiescing.catch(() => {});
      await within('the abandon to reach the turn', reached);
      g.agent.cancelStream();
      const stopping = g.framework.stop();
      await waitFor('stop() to close provider admission', () => (g.framework as unknown as { providerAdmissionClosed: boolean }).providerAdmissionClosed);
      g.releasePost();
      await within('stop() to finish', stopping);
      assert.equal(g.membrane.requests.length, 1, 'the retry was not sent');
      assert.deepEqual(abortReasons(g.traces), ['shutdown'], 'one inference:aborted, as a shutdown');
    } finally {
      await g.cleanup();
    }
  });

  it("an abandon of the wait while it still holds the finished stream lists the turn if it outlasts the grace, and still ends it as the abandon", async () => {
    const g = await guardRetryWaiting();
    try {
      setAbandonGraceForTests(g.framework, SHORT_ABANDON_GRACE_MS);
      const reached = abandonReached(g.framework);
      const quiescing = g.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      const status = await within('the quiesce to return', quiescing, 15_000);
      assert.deepEqual(status.unabandonable, ['assistant'], 'the turn still waiting is listed');
      g.releasePost();
      await waitFor('the turn to end', g.turnEnded);
      endedWithoutRetry(g, 'quiesce_abandoned', null);
      await g.framework.resume();
    } finally {
      await g.cleanup();
    }
  });

  it("a stop while the retry's own hooks run ends the turn before the retry is sent, and ends the guard's recovery", async () => {
    const g = await guardRetryWaiting();
    try {
      const hooks = g.module.hold();
      g.releasePost();
      await within("the retry's hooks", hooks.entered);
      g.agent.cancelStream();
      hooks.release();
      await waitFor('the turn to end', g.turnEnded);
      endedWithoutRetry(g, 'user', /stopped before it finished/, 'start');
    } finally {
      await g.cleanup();
    }
  });

  it('with no stop, the retry is sent once the post has gone out', async () => {
    const g = await guardRetryWaiting();
    try {
      g.releasePost();
      await waitFor('the retry to be answered', () => g.traces.some((t) => t.type === 'inference:completed'));
      assert.equal(g.membrane.requests.length, 2, 'the retry was sent');
      assert.deepEqual(abortReasons(g.traces), [], 'nothing was aborted');
      await waitFor('the retry to post', () => g.posted.includes('continued'));
    } finally {
      await g.cleanup();
    }
  });
});

/** `assistant`'s turn with its answer in and its stream let go, holding its
 *  token while its one post goes out, held until `release()`. */
async function finishingTurn() {
  const dir = mkdtempSync(join(tmpdir(), 'af-stop-without-stream-finishing-'));
  const membrane = new ScriptMembrane([[answer('>>#cafe Done.')], [answer('>>#cafe Again.')]]);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'system', proseRouting: 'explicit' }],
    modules: [new GatedContextModule()],
    syncIntervalMs: 0,
  });
  const posted: string[] = [];
  const postReleased = deferred();
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = firstPostHeld(posted, postReleased.promise);
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  const agent = framework.getAgent('assistant')!;
  framework.start();
  framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} } as unknown as ProcessEvent);
  await waitFor('the turn to wait on its post', () => posted.length === 1 && agent.state.status === 'idle'
    && framework.getHostModeStatus().activeTurns === 1);
  const completed = () => traces.filter((t) => t.type === 'inference:completed').length;
  return {
    framework, agent, traces, membrane, completed,
    release: () => postReleased.resolve(),
    /** Push the agent's next message and wait for its turn's answer. */
    nextTurnAnswered: async () => {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'second', metadata: {} } as unknown as ProcessEvent);
      await waitFor('the next turn to be answered', () => completed() === 2);
      assert.equal(membrane.requests.length, 2, 'the next turn sent its request');
      assert.deepEqual(abortReasons(traces), [], 'nothing was aborted');
    },
    cleanup: async () => {
      postReleased.resolve();
      await within('stop() in cleanup', framework.stop()).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('a turn finishing its last delivery, with no check ahead', () => {
  it('the status lists the turn as holding a turn until its delivery is done', async () => {
    const f = await finishingTurn();
    try {
      const during = f.framework.getHostModeStatus();
      assert.deepEqual(during.activeTurnAgents, ['assistant'], 'the turn finishing its delivery still holds its turn');
      assert.equal(during.activeTurnAgents.length, during.activeTurns, 'the list is the set activeTurns counts');
      f.release();
      await waitFor('the turn to complete', () => f.completed() === 1 && f.framework.getHostModeStatus().activeTurns === 0);
      assert.deepEqual(f.framework.getHostModeStatus().activeTurnAgents, [], 'and no turn is held once it settles');
    } finally {
      await f.cleanup();
    }
  });

  it("a quiesce's abandon leaves nothing to end a later turn: the turn completes, and the agent's next turn runs", async () => {
    const f = await finishingTurn();
    try {
      const reached = abandonReached(f.framework);
      const quiescing = f.framework.quiesce({ timeoutMs: 50, abandon: true });
      await within('the abandon to reach the turn', reached);
      f.release();
      const status = await within('the quiesce to return', quiescing);
      assert.equal(status.unabandonable, undefined, 'the turn ended within the grace');
      assert.equal(f.completed(), 1, 'the turn completed');
      await f.framework.resume();
      await f.nextTurnAnswered();
    } finally {
      await f.cleanup();
    }
  });

  it("a stop ends nothing: abortInference() reports none, and the agent's next turn runs", async () => {
    const f = await finishingTurn();
    try {
      assert.equal(f.framework.abortInference('assistant', 'operator stop'), false, 'no check of the turn is ahead');
      f.agent.cancelStream();
      f.release();
      await waitFor('the turn to complete', () => f.completed() === 1 && f.framework.getHostModeStatus().activeTurns === 0);
      await f.nextTurnAnswered();
    } finally {
      await f.cleanup();
    }
  });
});
