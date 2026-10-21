/**
 * The progress deadline on resident inference (agent-framework #268).
 *
 * Membrane's `progressTimeoutMs` ends a provider call that goes that long
 * without a parsed provider event; keepalives don't count. Without one, a
 * provider that holds a stream open with keepalives while generating nothing
 * hangs a resident with no error, no retry and no trace. These tests pin where
 * the framework sets it (each agent turn, the direct Agent API, MCPL servers'
 * inference requests, context-manager's compression calls through the membrane
 * the framework hands it) and what an expiry does: a retryable timeout through the
 * error policy, and an exhaustion with its reason if the stall persists. How
 * the deadline renews and expires is membrane's, and its tests pin that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AbortedResponse, Membrane, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MembraneError, TimeoutAbortError } from '@animalabs/membrane';
import type {
  ErrorAction,
  ErrorPolicy,
  EventResponse,
  FrameworkConfig,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS } from '../src/index.js';
import type { TraceEvent } from '../src/types/trace.js';
import { InferenceRouter } from '../src/mcpl/inference-router.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Options = { progressTimeoutMs?: number } | undefined;

/** Serves one scripted stream per call, then plain answers, and records each
 *  call's options. `stream` is the direct Agent API's call. */
class RecordingMembrane extends MockMembrane {
  options: Options[] = [];
  streams: Array<() => YieldingStream> = [];

  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    this.calls.push(request);
    this.options.push(options as Options);
    const next = this.streams.shift();
    return next ? next() : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
  }

  /** What the direct API's next stream() call answers instead of a reply. */
  directAnswers: Array<NormalizedResponse | AbortedResponse> = [];

  async stream(request: NormalizedRequest, options?: unknown): Promise<NormalizedResponse | AbortedResponse> {
    this.calls.push(request);
    this.options.push(options as Options);
    return this.directAnswers.shift() ?? createMockResponse([{ type: 'text', text: 'direct' }]);
  }

  /** What the next complete() call rejects with instead of answering. */
  completeFailures: Error[] = [];

  override async complete(request: NormalizedRequest, options?: unknown): Promise<NormalizedResponse> {
    this.calls.push(request);
    this.options.push(options as Options);
    const failure = this.completeFailures.shift();
    if (failure) throw failure;
    return createMockResponse([{ type: 'text', text: 'completed' }]);
  }
}

/** A stream that ends with an abort of its own: by default a provider call
 *  that ended on its progress deadline, which membrane's yielding stream
 *  reports as `aborted` with reason 'timeout'. */
class ExpiredStream implements YieldingStream {
  constructor(private readonly reason: 'timeout' | 'user' | 'error' = 'timeout') {}
  cancel(): void {}
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'aborted', reason: this.reason } as StreamEvent;
  }
}

/** A policy that records what it's asked, and retries at once `retries` times. */
function recordingPolicy(retries: number): ErrorPolicy & { seen: Array<{ error: Error; attempt: number }> } {
  const seen: Array<{ error: Error; attempt: number }> = [];
  return {
    maxRetries: retries,
    seen,
    onInferenceError(error: Error, _agentName: string, attempt: number): ErrorAction {
      seen.push({ error, attempt });
      return attempt < retries ? { retry: true, delayMs: 0 } : { retry: false };
    },
  };
}

/** Settles with the promise, or fails the test after `ms`, so a stream that
 *  never ends fails here instead of hanging the file. */
async function within<T>(ms: number, description: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A tool module with one tool that ends the turn. */
class FinishModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'finish', description: 'Finish the turn', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { finished: true }, endTurn: true };
  }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
}

async function withFramework(
  membrane: RecordingMembrane,
  config: Partial<FrameworkConfig>,
  fn: (framework: AgentFramework, traces: TraceEvent[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'progress-deadline-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
    syncIntervalMs: 0,
    ...config,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => traces.push(event));
  try {
    await fn(framework, traces);
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The options of one agent turn's stream, under a framework built with `config`. */
async function turnOptions(config: Partial<FrameworkConfig>): Promise<Options> {
  const membrane = new RecordingMembrane();
  let options: Options;
  await withFramework(membrane, config, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the turn to complete', () => traces.some((t) => t.type === 'inference:completed'));
    options = membrane.options[0];
  });
  return options;
}

test('each agent turn carries the progress deadline: 30 minutes unless inferenceProgressTimeoutMs says otherwise', async () => {
  assert.equal(DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS, 30 * 60_000);
  assert.equal((await turnOptions({}))?.progressTimeoutMs, DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS);
  assert.equal((await turnOptions({ inferenceProgressTimeoutMs: 1234 }))?.progressTimeoutMs, 1234);
  // Infinity is the way to run with no bound: it passes, and membrane never fires it.
  assert.equal((await turnOptions({ inferenceProgressTimeoutMs: Infinity }))?.progressTimeoutMs, Infinity);
});

test('create refuses a progress deadline membrane would read as none, and names Infinity as the way to have none', async () => {
  // Membrane reads these as no deadline, which would leave the hang in place,
  // so a host that writes one, meaning "off" or by slip, hears it at create.
  for (const value of [0, -1, Number.NaN]) {
    const dir = mkdtempSync(join(tmpdir(), 'progress-deadline-refused-'));
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath: join(dir, 'store'),
          membrane: new RecordingMembrane().asMembrane(),
          agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
          modules: [],
          syncIntervalMs: 0,
          inferenceProgressTimeoutMs: value,
        }),
        (error: unknown) => error instanceof RangeError
          && error.message === `inferenceProgressTimeoutMs must be a positive number of ms, or Infinity to run with no bound; got ${value}`,
        `inferenceProgressTimeoutMs ${value} is refused`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a turn whose stream ended on its progress deadline goes to the error policy as a retryable timeout, and the retry gets its own deadline', async () => {
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new ExpiredStream());
  const policy = recordingPolicy(1);
  await withFramework(membrane, { errorPolicy: policy, inferenceProgressTimeoutMs: 1234 }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the retried turn to complete', () => traces.some((t) => t.type === 'inference:completed'));

    assert.equal(policy.seen.length, 1);
    const { error, attempt } = policy.seen[0]!;
    assert.equal(attempt, 0);
    assert.ok(error instanceof MembraneError);
    assert.equal(error.type, 'timeout');
    assert.equal(error.retryable, true, 'the default policy retries only what is retryable');
    assert.equal(error.message, 'No stream progress within 1234ms (inferenceProgressTimeoutMs)');
    assert.ok(traces.some((t) => t.type === 'inference:failed' && t.error === error.message));
    assert.equal(traces.some((t) => t.type === 'inference:exhausted'), false);
    assert.deepEqual(membrane.options.map((o) => o?.progressTimeoutMs), [1234, 1234]);
  });
});

test('an expiry names the deadline the turn ran with, the default when none is configured', async () => {
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new ExpiredStream());
  const policy = recordingPolicy(0);
  await withFramework(membrane, { errorPolicy: policy }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the turn to exhaust', () => traces.some((t) => t.type === 'inference:exhausted'));
    assert.equal(
      policy.seen[0]?.error.message,
      `No stream progress within ${DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS}ms (inferenceProgressTimeoutMs)`,
    );
  });
});

test('a stall that persists through the retries exhausts the turn with its reason and classification', async () => {
  // Every attempt's stream ends on its deadline; the policy retries twice.
  const membrane = new RecordingMembrane();
  for (let i = 0; i < 3; i++) membrane.streams.push(() => new ExpiredStream());
  const policy = recordingPolicy(2);
  await withFramework(membrane, { errorPolicy: policy, inferenceProgressTimeoutMs: 1234 }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the turn to exhaust', () => traces.some((t) => t.type === 'inference:exhausted'));

    assert.deepEqual(policy.seen.map((s) => s.attempt), [0, 1, 2]);
    assert.deepEqual(membrane.options.map((o) => o?.progressTimeoutMs), [1234, 1234, 1234]);
    const exhausted = traces.filter((t) => t.type === 'inference:exhausted') as Array<Extract<TraceEvent, { type: 'inference:exhausted' }>>;
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0]!.error, 'No stream progress within 1234ms (inferenceProgressTimeoutMs)');
    assert.equal(exhausted[0]!.errorType, 'timeout');
    assert.equal(exhausted[0]!.retryable, true);
    assert.equal(traces.filter((t) => t.type === 'inference:failed').length, 3);
    await waitFor('the agent to go idle', () => framework.getAgent('agent')?.state.status === 'idle');

    // The resident is told the reason, without the advice to change what it sends.
    const markers = () => framework.getAgent('agent')!.getContextManager().queryMessages({}).messages
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && b.text.startsWith('[inference-failed]'));
    await waitFor('the marker', () => markers().length === 1);
    assert.match(markers()[0]!.text, /\(timeout\).* Reason: No stream progress within 1234ms \(inferenceProgressTimeoutMs\)\.$/);
  });
});

test("an ephemeral run whose stream ends on its deadline is retried, then rejects with the deadline's message", async () => {
  const membrane = new RecordingMembrane();
  for (let i = 0; i < 2; i++) membrane.streams.push(() => new ExpiredStream());
  const policy = recordingPolicy(1);
  await withFramework(membrane, { errorPolicy: policy, inferenceProgressTimeoutMs: 1234 }, async (framework) => {
    const created = await framework.createEphemeralAgent({ name: 'ephemeral', model: 'test-model', systemPrompt: 'test' });
    created.contextManager.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
    framework.start();
    await assert.rejects(
      within(5_000, 'the run to settle', run),
      (error: unknown) => error instanceof Error && error.message === 'No stream progress within 1234ms (inferenceProgressTimeoutMs)',
    );
    assert.deepEqual(policy.seen.map((s) => s.attempt), [0, 1]);
    assert.deepEqual(membrane.options.map((o) => o?.progressTimeoutMs), [1234, 1234]);
  });
});

test("an abort that isn't the deadline's, with no recorded cancel, still settles the turn as it did", async () => {
  // Such as a typed abort membrane reports as 'error', with nothing recorded.
  // ('user' is a deliberate cancel, which settles without exhausting.)
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new ExpiredStream('error'));
  const policy = recordingPolicy(1);
  await withFramework(membrane, { errorPolicy: policy }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the turn to settle', () => traces.some((t) => t.type === 'inference:exhausted'));

    assert.deepEqual(policy.seen, []);
    const exhausted = traces.find((t) => t.type === 'inference:exhausted') as Extract<TraceEvent, { type: 'inference:exhausted' }>;
    assert.equal(exhausted.error, 'Stream aborted: error');
    assert.equal(membrane.calls.length, 1);
  });
});

test("a deadline that expires as the framework ends the turn itself stays the framework's cancel", async () => {
  // The turn's tool ends it, so the framework cancels the stream (turn_ended).
  // The stream's abort then says 'timeout', as when the deadline fired first.
  // That is the framework's own cancel: no failure, and no error policy.
  class EndTurnRace implements YieldingStream {
    private wake: (() => void) | null = null;
    private cancelled = false;
    /** Set once the consumer is done with the stream after its last event. */
    finished = false;
    cancel(): void { this.cancelled = true; this.wake?.(); }
    provideToolResults(): void {}
    get isWaitingForTools() { return !this.cancelled; }
    get pendingToolCallIds(): string[] { return this.cancelled ? [] : ['call_finish']; }
    get toolDepth() { return 0; }
    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      const call = { id: 'call_finish', name: 'test--finish', input: {} };
      yield {
        type: 'tool-calls',
        calls: [call],
        context: {
          rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
          roundContent: [{ type: 'tool_use', ...call }],
        },
      } as StreamEvent;
      if (!this.cancelled) await new Promise<void>((resolve) => { this.wake = resolve; });
      try {
        yield { type: 'aborted', reason: 'timeout' } as StreamEvent;
      } finally {
        this.finished = true;
      }
    }
  }
  const race = new EndTurnRace();
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => race);
  const policy = recordingPolicy(0);
  await withFramework(membrane, { errorPolicy: policy, modules: [new FinishModule()] }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the tool to end the turn', () => traces.some((t) => t.type === 'inference:turn_ended'));
    // The stream's last event, its 'timeout' abort, follows the endTurn. Wait
    // for the turn's driveStream to finish with it, unless it already has.
    const drive = (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams.get('agent');
    await within(3_000, "the turn's stream to end", Promise.resolve(drive));

    assert.equal(race.finished, true, 'driveStream took the abort and was done with the stream');
    assert.deepEqual(policy.seen, []);
    assert.equal(traces.some((t) => t.type === 'inference:failed' || t.type === 'inference:exhausted'), false);
    assert.equal(membrane.calls.length, 1);
  });
});

test("a deadline that expires as an operator stops the turn ends as that stop, not as a failure", async () => {
  // abortInference records the caller's cancel and cancels the stream, whose
  // abort then says 'timeout', as when the deadline fired first. The error
  // path reads the recorded cancel before any failure accounting, so the stop
  // stands: no retry, no failure, one inference:aborted with its reason.
  class StopRace implements YieldingStream {
    private wake: (() => void) | null = null;
    private cancelled = false;
    cancel(): void { this.cancelled = true; this.wake?.(); }
    provideToolResults(): void {}
    get isWaitingForTools() { return false; }
    get pendingToolCallIds(): string[] { return []; }
    get toolDepth() { return 0; }
    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      if (!this.cancelled) await new Promise<void>((resolve) => { this.wake = resolve; });
      yield { type: 'aborted', reason: 'timeout' } as StreamEvent;
    }
  }
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new StopRace());
  const policy = recordingPolicy(1);
  await withFramework(membrane, { errorPolicy: policy }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the stream to start', () => membrane.calls.length === 1);
    await waitFor('the agent to hold the stream', () => 'stream' in framework.getAgent('agent')!.state);
    assert.equal(framework.abortInference('agent', 'operator_stop'), true);
    await waitFor('the stop to settle', () => traces.some((t) => t.type === 'inference:aborted'));

    assert.deepEqual(policy.seen, []);
    assert.deepEqual(
      traces.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason),
      ['operator_stop'],
    );
    assert.equal(traces.some((t) => t.type === 'inference:failed' || t.type === 'inference:exhausted'), false);
    assert.equal(membrane.calls.length, 1);
  });
});

test("context-manager's compression calls carry the framework's deadline unless they set their own", async () => {
  // Context-manager calls membrane.complete(request, { formatter, signal })
  // on the membrane the framework hands it. A hung call there would hold the
  // resident's next turn behind its auxiliary work.
  const membrane = new RecordingMembrane();
  await withFramework(membrane, { inferenceProgressTimeoutMs: 1234, subconscious: { enabled: true, systemPrompt: 'test' } }, async (framework) => {
    const membraneOf = (contextManager: unknown) => (contextManager as { membrane: Membrane }).membrane;
    const request = { messages: [], config: { model: 'test-model' } } as unknown as NormalizedRequest;
    const resident = membraneOf(framework.getAgent('agent')!.getContextManager());
    const first = await framework.createEphemeralAgent({ name: 'ephemeral-1', model: 'test-model', systemPrompt: 'test' });
    const second = await framework.createEphemeralAgent({ name: 'ephemeral-2', model: 'test-model', systemPrompt: 'test' });
    const signal = new AbortController().signal;

    await resident.complete(request, { formatter: 'native', signal } as never);
    await membraneOf(first.contextManager).complete(request);
    await resident.complete(request, { progressTimeoutMs: 99 } as never);
    assert.deepEqual(membrane.options, [
      { formatter: 'native', signal, progressTimeoutMs: 1234 },
      { progressTimeoutMs: 1234 },
      { progressTimeoutMs: 99 },
    ]);
    // Ephemeral runs and the subconscious share one membrane instance, as
    // they shared the plain one: context-manager keys a compression's
    // comparison domain by it.
    assert.equal(membraneOf(first.contextManager), membraneOf(second.contextManager));
    assert.equal(membraneOf(framework.getAgent('Subconscious')!.getContextManager()), membraneOf(first.contextManager));
  });
});

test('the direct Agent API carries the deadline on each call, the default or the call\'s own, and refuses one membrane would read as none', async () => {
  const membrane = new RecordingMembrane();
  await withFramework(membrane, {}, async (framework) => {
    const agent = framework.getAgent('agent')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'hello' }]);
    await agent.runInference(framework.getAllTools());
    await agent.runInference(framework.getAllTools(), undefined, { progressTimeoutMs: 1234 });
    // A value membrane would read as no deadline is refused before the call starts.
    for (const value of [0, Number.NaN]) {
      await assert.rejects(
        agent.runInference(framework.getAllTools(), undefined, { progressTimeoutMs: value }),
        (error: unknown) => error instanceof RangeError && error.message.startsWith('InferenceOptions.progressTimeoutMs must be'),
      );
      assert.equal(agent.state.status, 'idle', 'a refused call leaves the agent as it was');
    }
    await assert.rejects(
      agent.startStreamWithInjections(framework.getAllTools(), undefined, undefined, framework.getAllTools(), { progressTimeoutMs: -1 }),
      (error: unknown) => error instanceof RangeError && error.message.startsWith('progressTimeoutMs must be'),
    );
    assert.equal(agent.state.status, 'idle', 'a refused stream leaves the agent as it was');
    const started = await agent.startStream(framework.getAllTools());
    started.stream.cancel();
    assert.deepEqual(
      membrane.options.map((o) => o?.progressTimeoutMs),
      [DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS, 1234, DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS],
    );
  });
});

test("the direct Agent API returns an expiry as an aborted result, with abortReason 'timeout'", async () => {
  const membrane = new RecordingMembrane();
  membrane.directAnswers.push({ aborted: true, reason: 'timeout' } as AbortedResponse);
  await withFramework(membrane, {}, async (framework) => {
    const agent = framework.getAgent('agent')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'hello' }]);
    const result = await agent.runInference(framework.getAllTools());
    assert.equal(result.aborted, true);
    assert.equal(result.abortReason, 'timeout');
    assert.equal(agent.state.status, 'idle');
  });
});

test("an MCPL server's inference request carries the framework's deadline", async () => {
  const membrane = new RecordingMembrane();
  await withFramework(membrane, { inferenceProgressTimeoutMs: 4321 }, async (framework) => {
    const internals = framework as unknown as {
      initializeMcpl(servers: unknown[]): Promise<void>;
      featureSetManager: { validateInbound(serverId: string, featureSet: string): void };
      inferenceRouter: InferenceRouter;
    };
    await internals.initializeMcpl([]);
    internals.featureSetManager.validateInbound = () => {};
    const responses: unknown[] = [];
    await internals.inferenceRouter.handleInferenceRequest(
      'srv',
      { featureSet: 'f', messages: [{ role: 'user', content: 'hi' }] },
      { respond: (r) => responses.push(r), respondError: (_c, m) => responses.push(m) },
    );
    assert.equal(responses.length, 1);
    assert.deepEqual(membrane.options.map((o) => o?.progressTimeoutMs), [4321]);
  });
});

// ---------------------------------------------------------------------------
// InferenceRouter on its own
// ---------------------------------------------------------------------------

function routerHarness(stream: () => YieldingStream, routerOptions?: { progressTimeoutMs?: number }) {
  const membrane = new RecordingMembrane();
  membrane.streams.push(stream);
  const traces: Array<{ type: string; [key: string]: unknown }> = [];
  const chunks: unknown[] = [];
  const router = new InferenceRouter(
    membrane.asMembrane(),
    { isInHook: false } as never,
    { validateInbound: () => {} } as never,
    null,
    (event) => traces.push(event),
    routerOptions,
  );
  const answers: Array<{ result?: unknown; error?: { code: number; message: string } }> = [];
  const responder = {
    requestId: 7,
    sendChunk: (params: unknown) => chunks.push(params),
    respond: (result: unknown) => answers.push({ result }),
    respondError: (code: number, message: string) => answers.push({ error: { code, message } }),
  };
  return { membrane, router, traces, chunks, answers, responder };
}

test('the router puts its deadline on both its calls: 30 minutes, or the one it was given', async () => {
  for (const [given, expected] of [
    [undefined, DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS],
    [1234, 1234],
  ] as const) {
    const h = routerHarness(
      () => new MockYieldingStream([createMockResponse([{ type: 'text', text: 'streamed' }])]),
      given === undefined ? undefined : { progressTimeoutMs: given },
    );
    await h.router.handleInferenceRequest('srv', { featureSet: 'f', messages: [{ role: 'user', content: 'hi' }] }, h.responder);
    await h.router.handleInferenceRequest('srv', { featureSet: 'f', stream: true, messages: [{ role: 'user', content: 'hi' }] }, h.responder);
    assert.deepEqual(h.membrane.options.map((o) => o?.progressTimeoutMs), [expected, expected]);
    assert.equal(h.answers.filter((a) => a.result !== undefined).length, 2);
  }
});

test('a streamed request that ends on its deadline answers the server with an error, not with what arrived', async () => {
  const h = routerHarness(() => new ExpiredStream(), { progressTimeoutMs: 1234 });
  await h.router.handleInferenceRequest('srv', { featureSet: 'f', stream: true, messages: [{ role: 'user', content: 'hi' }] }, h.responder);
  const message = 'No stream progress within 1234ms (inferenceProgressTimeoutMs)';
  assert.deepEqual(h.answers, [{ error: { code: -32603, message } }]);
  assert.ok(h.traces.some((t) => t.type === 'mcpl:inference_fail' && t.error === message));
  assert.equal(h.traces.some((t) => t.type === 'mcpl:inference_complete'), false);
});

test('a streamed request that ends on another abort answers the server with that abort, not the deadline', async () => {
  const h = routerHarness(() => new ExpiredStream('error'), { progressTimeoutMs: 1234 });
  await h.router.handleInferenceRequest('srv', { featureSet: 'f', stream: true, messages: [{ role: 'user', content: 'hi' }] }, h.responder);
  assert.deepEqual(h.answers, [{ error: { code: -32603, message: 'The inference stopped before it finished (error)' } }]);
});

test("a non-streamed request that ends on its deadline answers the server with membrane's own expiry", async () => {
  // complete() rejects with membrane's TimeoutAbortError, whose message says
  // when the call began and how many provider events it had. That is the
  // answer, unlike a streamed request's, which names the setting to raise.
  const h = routerHarness(() => new MockYieldingStream([]), { progressTimeoutMs: 1234 });
  const expiry = 'No provider progress within 1234ms: the call began at 2026-10-21T22:00:00.000Z, provider events: 0';
  h.membrane.completeFailures.push(new TimeoutAbortError(expiry));
  await h.router.handleInferenceRequest('srv', { featureSet: 'f', messages: [{ role: 'user', content: 'hi' }] }, h.responder);
  assert.deepEqual(h.answers, [{ error: { code: -32603, message: expiry } }]);
  assert.deepEqual(h.membrane.options.map((o) => o?.progressTimeoutMs), [1234]);
});
