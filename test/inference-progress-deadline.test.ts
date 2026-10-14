/**
 * The progress deadline on resident inference (agent-framework #268).
 *
 * Membrane's `progressTimeoutMs` ends a provider call that goes that long
 * without a parsed provider event; keepalives don't count. Without one, a
 * provider that holds a stream open with keepalives while generating nothing
 * hangs a resident with no error, no retry and no trace. These tests pin where
 * the framework sets it (each agent turn, the direct Agent API, MCPL servers'
 * inference requests) and what an expiry does: a retryable timeout through the
 * error policy, and an exhaustion with its reason if the stall persists. How
 * the deadline renews and expires is membrane's, and its tests pin that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
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

  async stream(request: NormalizedRequest, options?: unknown): Promise<NormalizedResponse> {
    this.calls.push(request);
    this.options.push(options as Options);
    return createMockResponse([{ type: 'text', text: 'direct' }]);
  }

  override async complete(request: NormalizedRequest, options?: unknown): Promise<NormalizedResponse> {
    this.calls.push(request);
    this.options.push(options as Options);
    return createMockResponse([{ type: 'text', text: 'completed' }]);
  }
}

/** A provider call that ended on its progress deadline: membrane's yielding
 *  stream reports it as `aborted` with reason 'timeout'. */
class ExpiredStream implements YieldingStream {
  cancel(): void {}
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'aborted', reason: 'timeout' } as StreamEvent;
  }
}

/** A policy that records what it's asked and answers `retry`. */
function recordingPolicy(retry: boolean): ErrorPolicy & { seen: Array<{ error: Error; attempt: number }> } {
  const seen: Array<{ error: Error; attempt: number }> = [];
  return {
    maxRetries: 3,
    seen,
    onInferenceError(error: Error, _agentName: string, attempt: number): ErrorAction {
      seen.push({ error, attempt });
      return retry ? { retry: true, delayMs: 0 } : { retry: false };
    },
  };
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
  // Membrane reads these as no deadline, which would leave the hang in place.
  for (const value of [0, -1, Number.NaN]) {
    assert.equal(
      (await turnOptions({ inferenceProgressTimeoutMs: value }))?.progressTimeoutMs,
      DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS,
      `inferenceProgressTimeoutMs ${value} gets the default`,
    );
  }
});

test('a turn whose stream ended on its progress deadline goes to the error policy as a retryable timeout, and the retry gets its own deadline', async () => {
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new ExpiredStream());
  const policy = recordingPolicy(true);
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

test('a stall that persists exhausts the turn with its reason and classification', async () => {
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new ExpiredStream());
  const policy = recordingPolicy(false);
  await withFramework(membrane, { errorPolicy: policy, inferenceProgressTimeoutMs: 1234 }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the turn to exhaust', () => traces.some((t) => t.type === 'inference:exhausted'));

    const exhausted = traces.find((t) => t.type === 'inference:exhausted') as Extract<TraceEvent, { type: 'inference:exhausted' }>;
    assert.equal(exhausted.error, 'No stream progress within 1234ms (inferenceProgressTimeoutMs)');
    assert.equal(exhausted.errorType, 'timeout');
    assert.equal(exhausted.retryable, true);
    assert.equal(membrane.calls.length, 1);
    await waitFor('the agent to go idle', () => framework.getAgent('agent')?.state.status === 'idle');
  });
});

test("a deadline that expires as the framework ends the turn itself stays the framework's cancel", async () => {
  // The turn's tool ends it, so the framework cancels the stream (turn_ended).
  // The stream's abort then says 'timeout', as when the deadline fired first.
  // That is the framework's own cancel: no failure, and no error policy.
  class EndTurnRace implements YieldingStream {
    private wake: (() => void) | null = null;
    private cancelled = false;
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
      yield { type: 'aborted', reason: 'timeout' } as StreamEvent;
    }
  }
  const membrane = new RecordingMembrane();
  membrane.streams.push(() => new EndTurnRace());
  const policy = recordingPolicy(false);
  await withFramework(membrane, { errorPolicy: policy, modules: [new FinishModule()] }, async (framework, traces) => {
    framework.start();
    framework.nudgeAgent('agent', 'operator');
    await waitFor('the tool to end the turn', () => traces.some((t) => t.type === 'inference:turn_ended'));
    // The stream's last event, its 'timeout' abort, follows the endTurn. Wait
    // for the turn's driveStream to finish with it, unless it already has.
    await (framework as unknown as { activeStreams: Map<string, Promise<void>> }).activeStreams.get('agent');

    assert.deepEqual(policy.seen, []);
    assert.equal(traces.some((t) => t.type === 'inference:failed' || t.type === 'inference:exhausted'), false);
    assert.equal(membrane.calls.length, 1);
  });
});

test('the direct Agent API carries the deadline on each call: the default, or the call\'s own', async () => {
  const membrane = new RecordingMembrane();
  await withFramework(membrane, {}, async (framework) => {
    const agent = framework.getAgent('agent')!;
    agent.getContextManager().addMessage('user', [{ type: 'text', text: 'hello' }]);
    await agent.runInference(framework.getAllTools());
    await agent.runInference(framework.getAllTools(), undefined, { progressTimeoutMs: 1234 });
    const started = await agent.startStream(framework.getAllTools());
    started.stream.cancel();
    assert.deepEqual(
      membrane.options.map((o) => o?.progressTimeoutMs),
      [DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS, 1234, DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS],
    );
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
    (_serverId, params) => chunks.push(params),
    routerOptions,
  );
  const answers: Array<{ result?: unknown; error?: { code: number; message: string } }> = [];
  const responder = {
    requestId: 7,
    respond: (result: unknown) => answers.push({ result }),
    respondError: (code: number, message: string) => answers.push({ error: { code, message } }),
  };
  return { membrane, router, traces, chunks, answers, responder };
}

test('the router puts its deadline on both its calls: 30 minutes, or the one it was given', async () => {
  for (const [given, expected] of [[undefined, DEFAULT_INFERENCE_PROGRESS_TIMEOUT_MS], [1234, 1234]] as const) {
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
  assert.deepEqual(h.answers, [{ error: { code: -32603, message: 'No stream progress within 1234ms' } }]);
  assert.ok(h.traces.some((t) => t.type === 'mcpl:inference_fail' && t.error === 'No stream progress within 1234ms'));
  assert.equal(h.traces.some((t) => t.type === 'mcpl:inference_complete'), false);
});

test("a streamed request whose stream fails answers the server with the stream's error", async () => {
  class FailingStream extends ExpiredStream {
    override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      yield { type: 'tokens', content: 'partial ', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
      yield { type: 'error', error: new Error('upstream reset') } as StreamEvent;
    }
  }
  const h = routerHarness(() => new FailingStream());
  await h.router.handleInferenceRequest('srv', { featureSet: 'f', stream: true, messages: [{ role: 'user', content: 'hi' }] }, h.responder);
  assert.equal(h.chunks.length, 1, 'what arrived was streamed as it came');
  assert.deepEqual(h.answers, [{ error: { code: -32603, message: 'upstream reset' } }]);
});
