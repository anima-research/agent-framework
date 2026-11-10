/**
 * MCPL inference/lifecycle (SPEC §10.5): a stream that fails ends its
 * inference with the `failed` phase.
 *
 * driveStream emits `started` for each stream and one terminal in its
 * `finally`, whose phase the exit paths decide. An `error` event that no
 * cancel explains is a failure: the framework settles the turn as exhausted,
 * retries it, or holds it for a provider's wait. So is an `aborted` event
 * whose reason isn't a stop's, which settles the turn as exhausted. The
 * holds already ended `failed`; the other endings left the default
 * `completed` standing, so an MCPL server was told that a failed inference
 * completed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type {
  ErrorPolicy,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

/** A stream that sends some text, then ends with `last`. */
class EndingStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  constructor(private readonly last: StreamEvent) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'tokens', content: 'Partial', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
    yield this.last;
  }
}

/** A stream that ends at once with no event at all, and that nobody cancels (#907). */
class SilentStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> { /* no events */ }
}

/** In `ends`, a stream that ends as a SilentStream does. */
const silentEnd = {} as StreamEvent;

/** Each stream it opens ends as the next of `ends` says; past them, a completion. */
class ScriptedMembrane extends MockMembrane {
  constructor(private readonly ends: StreamEvent[]) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const last = this.ends.shift();
    if (last === silentEnd) return new SilentStream();
    return last ? new EndingStream(last) : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'Done' }])]);
  }
}

const failure = (): StreamEvent => ({ type: 'error', error: new Error('upstream connection reset') }) as StreamEvent;
const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: () => ({ retry: false }) };
const retryOnce: ErrorPolicy = {
  maxRetries: 1,
  onInferenceError: (_error, _agent, attempt) => (attempt < 1 ? { retry: true, delayMs: 0 } : { retry: false }),
};

interface Lifecycle { inferenceId: string; phase: string }

/** A framework whose streams end as `ends` says, with what it emits to MCPL servers' lifecycle grant and its traces. */
async function frameworkOver(ends: StreamEvent[], errorPolicy: ErrorPolicy, agents = [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'af-lifecycle-failed-'));
  const membrane = new ScriptedMembrane(ends);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents,
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0, errorPolicy,
  });
  const emitted: Lifecycle[] = [];
  // What an MCPL server granted `inferenceLifecycle` is sent.
  (framework as unknown as { hookOrchestrator: unknown }).hookOrchestrator = {
    beforeInference: async () => [],
    emitLifecycle: (params: Lifecycle) => { emitted.push(params); },
  };
  const traces: Array<{ type: string; reason?: string }> = [];
  framework.onTrace((event) => { traces.push(event as { type: string; reason?: string }); });
  /** Each inference's phases, in the order its `started` came. */
  const phases = (): string[][] => {
    const byInference = new Map<string, string[]>();
    for (const { inferenceId, phase } of emitted) {
      byInference.set(inferenceId, [...(byInference.get(inferenceId) ?? []), phase]);
    }
    return [...byInference.values()];
  };
  const teardown = async (): Promise<void> => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { framework, membrane, traces, phases, teardown };
}

/** Run one turn whose streams end as `ends` says, and return each inference's phases. */
async function phasesOf(ends: StreamEvent[], errorPolicy: ErrorPolicy): Promise<string[][]> {
  const { framework, phases, teardown } = await frameworkOver(ends, errorPolicy);
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await framework.runUntilIdle();
  } finally {
    await teardown();
  }
  return phases();
}

test('a stream that completes ends completed (control)', async () => {
  assert.deepEqual(await phasesOf([], noRetry), [['started', 'completed']]);
});

test('a stream that fails, with no retry, ends failed', async () => {
  assert.deepEqual(await phasesOf([failure()], noRetry), [['started', 'failed']]);
});

test('a stream that fails and is retried ends failed, and its retry has its own terminal', async () => {
  assert.deepEqual(await phasesOf([failure()], retryOnce), [['started', 'failed'], ['started', 'completed']]);
});

test('a stream that fails, whose retry stop() cancels, ends failed', { timeout: 60_000 }, async () => {
  let waiting!: () => void;
  const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
  const retryLater: ErrorPolicy = {
    maxRetries: 1,
    onInferenceError: (_error, _agent, attempt) => {
      waiting();
      return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
    },
  };
  const { framework, membrane, traces, phases, teardown } = await frameworkOver([failure()], retryLater);
  try {
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await inDelay;
    await framework.stop();
    assert.equal(membrane.calls.length, 1, 'the retry was cancelled, not sent');
    assert.ok(
      traces.some((t) => t.type === 'inference:aborted' && t.reason === 'a retry waiting while the framework was stopping is dropped before it sends anything'),
      `the stop cancelled the retry: ${JSON.stringify(traces.filter((t) => t.type.startsWith('inference:')))}`,
    );
    assert.deepEqual(phases(), [['started', 'failed']]);
  } finally {
    await teardown();
  }
});

test('a stream that fails, whose retry a caller\'s stop cancels during its wait, ends failed', { timeout: 60_000 }, async () => {
  let waiting!: () => void;
  const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
  const retryLater: ErrorPolicy = {
    maxRetries: 1,
    onInferenceError: (_error, _agent, attempt) => {
      waiting();
      return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
    },
  };
  const { framework, membrane, traces, phases, teardown } = await frameworkOver([failure()], retryLater);
  try {
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await inDelay;
    assert.equal(framework.abortInference('resident', 'user'), true, 'abortInference reports the stop');
    for (let i = 0; i < 500 && !(traces.some((t) => t.type === 'inference:aborted') && framework.getHostModeStatus().activeTurns === 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(membrane.calls.length, 1, 'the retry was cancelled, not sent');
    assert.ok(
      traces.some((t) => t.type === 'inference:aborted' && t.reason === 'user'),
      `the caller's stop ended the turn: ${JSON.stringify(traces.filter((t) => t.type.startsWith('inference:')))}`,
    );
    assert.deepEqual(phases(), [['started', 'failed']]);
  } finally {
    await teardown();
  }
});

test('a stream that fails, whose retry an operator\'s abandon cancels during its wait, ends failed', { timeout: 60_000 }, async () => {
  let waiting!: () => void;
  const inDelay = new Promise<void>((resolve) => { waiting = resolve; });
  const retryLater: ErrorPolicy = {
    maxRetries: 1,
    onInferenceError: (_error, _agent, attempt) => {
      waiting();
      return attempt < 1 ? { retry: true, delayMs: 60_000 } : { retry: false };
    },
  };
  const { framework, membrane, traces, phases, teardown } = await frameworkOver([failure()], retryLater);
  try {
    framework.start();
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await inDelay;
    await framework.quiesce({ timeoutMs: 50, abandon: true });
    for (let i = 0; i < 500 && !(traces.some((t) => t.type === 'inference:aborted') && framework.getHostModeStatus().activeTurns === 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(membrane.calls.length, 1, 'the retry was cancelled, not sent');
    assert.ok(
      traces.some((t) => t.type === 'inference:aborted' && t.reason === 'quiesce_abandoned'),
      `the abandon ended the turn: ${JSON.stringify(traces.filter((t) => t.type.startsWith('inference:')))}`,
    );
    assert.deepEqual(phases(), [['started', 'failed']]);
    await framework.resume();
  } finally {
    await teardown();
  }
});

test('a stream whose 429 holds the turn for the provider\'s wait ends failed', async () => {
  const rateLimited = new MembraneError({
    type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000,
    message: 'rate limit reached for requests', rawError: { status: 429 },
  });
  const { framework, membrane, traces, phases, teardown } = await frameworkOver([{ type: 'error', error: rateLimited } as StreamEvent], noRetry);
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'hello', metadata: {} });
    await framework.runUntilIdle();
    const health = framework.healthSnapshot() as {
      agents: Array<{ name: string; providerAdmission: { providerWaits: Array<{ model: string }> } }>;
    };
    const waits = health.agents.find((a) => a.name === 'resident')?.providerAdmission.providerWaits ?? [];
    assert.deepEqual(waits.map((w) => w.model), ['test-model'], 'the turn is held for the provider\'s stated wait');
    assert.equal(membrane.calls.length, 1, 'held, not retried');
    assert.ok(!traces.some((t) => t.type === 'inference:exhausted'), 'held, not exhausted');
  } finally {
    await teardown();
  }
  assert.deepEqual(phases(), [['started', 'failed']]);
});

test('a stream that times out ends failed', async () => {
  assert.deepEqual(await phasesOf([{ type: 'aborted', reason: 'timeout' } as StreamEvent], noRetry), [['started', 'failed']]);
});

test('a stream that reports its abort as a stop (reason user) ends aborted (control)', async () => {
  assert.deepEqual(await phasesOf([{ type: 'aborted', reason: 'user' } as StreamEvent], noRetry), [['started', 'aborted']]);
});

/** Polls `done` every 10 ms for up to `ms`: whether it came true. */
async function settles(done: () => boolean, ms = 10_000): Promise<boolean> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** The types of `traces` that report a failure: an inference's failure is reported once, as one of these. */
const failureTypes = (traces: Array<{ type: string }>): string[] =>
  traces.map((t) => t.type).filter((type) => type === 'inference:failed' || type === 'inference:exhausted');

// Issue #907: a stream whose iterator just ends, with no `complete`, `error` or `aborted` event, and
// that nobody cancelled, left its agent `streaming` and its lifecycle `completed`, so a later nudge started
// nothing. retryOnce retries at once, so a retry the silent end took would show before its terminal.
test('a stream that ends with no event, and nobody cancelled, ends failed, and a later nudge starts a new inference', { timeout: 60_000 }, async () => {
  const { framework, membrane, traces, phases, teardown } = await frameworkOver([silentEnd], retryOnce);
  const types = (): string[] => traces.map((t) => t.type);
  const logged = (): string[] => framework.queryInferenceLogs({ agentName: 'resident' }).entries
    .map((e) => (e.entry.success === false ? 'failed' : 'ok'))
    .reverse();
  const status = (): string | undefined => framework.getAgent('resident')?.state.status;
  const ended = (inferences: number): boolean => phases().length === inferences
    && phases().every((p) => p.length === 2) && status() === 'idle' && framework.getHostModeStatus().activeTurns === 0;
  try {
    framework.start();
    framework.nudgeAgent('resident', 'operator');
    assert.ok(await settles(() => ended(1)), `the silent stream's turn ends: ${JSON.stringify({ phases: phases(), status: status() })}`);
    // Room for a retry, which nothing should start.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(membrane.calls.length, 1, 'nothing retries the silent stream or starts its turn again');
    assert.equal(status(), 'idle', 'the agent no longer streams');
    assert.deepEqual(phases(), [['started', 'failed']], 'its lifecycle ends failed, not completed');
    assert.ok(!types().includes('inference:completed'), `no completion is reported: ${JSON.stringify(types())}`);
    assert.ok(types().includes('inference:exhausted'), `the failure is reported: ${JSON.stringify(types())}`);
    assert.deepEqual(failureTypes(traces), ['inference:exhausted'], 'it is reported once, as exhausted and not as failed too');
    assert.deepEqual(logged(), ['failed'], 'the inference log holds the failure');

    framework.nudgeAgent('resident', 'operator');
    assert.ok(await settles(() => ended(2)), `the next nudge's turn ends: ${JSON.stringify({ phases: phases(), status: status() })}`);
    assert.equal(membrane.calls.length, 2, 'the nudge starts one new inference');
    assert.deepEqual(phases(), [['started', 'failed'], ['started', 'completed']]);
    assert.deepEqual(types().filter((t) => t === 'inference:completed'), ['inference:completed']);
    assert.deepEqual(failureTypes(traces), ['inference:exhausted'], 'the next inference reports no failure');
    assert.deepEqual(logged(), ['failed', 'ok']);
    assert.equal(status(), 'idle');
  } finally {
    await teardown();
  }
});

test('a silent stream log write failure still releases its turn without retrying', { timeout: 60_000 }, async () => {
  const { framework, membrane, traces, phases, teardown } = await frameworkOver([silentEnd], retryOnce);
  const internal = framework as unknown as {
    logInference: (entry: { error?: string }) => void;
    activeTurnTokens: Map<string, unknown>;
    activeStreams: Map<string, unknown>;
  };
  const write = internal.logInference;
  internal.logInference = (entry) => {
    if (entry.error === 'Stream ended without a final response') throw new Error('synthetic log write failure');
    write.call(framework, entry);
  };
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    framework.start();
    framework.nudgeAgent('resident', 'operator');
    assert.ok(await settles(() => warnings.some((line) => line.startsWith('[usage] agent=resident could not record'))
      && phases().length === 1 && phases()[0].length === 2
      && !internal.activeTurnTokens.has('resident') && !internal.activeStreams.has('resident')),
    'the warning is emitted and teardown completes');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(phases(), [['started', 'failed']]);
    assert.equal(membrane.calls.length, 1, 'the logging error starts no retry');
    assert.deepEqual(failureTypes(traces), ['inference:exhausted'], 'its failure is reported once');
    assert.equal(framework.getAgent('resident')?.state.status, 'idle');
    assert.equal(framework.getHostModeStatus().activeTurns, 0);
  } finally {
    console.error = originalError;
    internal.logInference = write;
    await teardown();
  }
});

// A listener of the silent end's inference:exhausted that disposes the agent at once leaves the failure the end
// established standing: its settlement, its one failure trace and its inference-log row all name it, not the
// disposal after it. stopAgent ends only an agent that doesn't own default delivery, so the stream is `second`'s.
test('a silent stream whose failure trace disposes its agent keeps the failure it established', { timeout: 60_000 }, async () => {
  const { framework, membrane, phases, teardown } = await frameworkOver([silentEnd], retryOnce, [
    { name: 'resident', model: 'test-model', systemPrompt: 'system' },
    { name: 'second', model: 'test-model', systemPrompt: 'system' },
  ]);
  const internal = framework as unknown as {
    agents: Map<string, unknown>;
    activeTurnTokens: Map<string, unknown>;
    settleAgent: (name: string, outcome: { stopReason?: string; error?: string }, ...rest: unknown[]) => unknown;
  };
  const settleAgent = internal.settleAgent;
  const settled: Array<{ stopReason?: string; error?: string }> = [];
  internal.settleAgent = (name, outcome, ...rest) => {
    if (name === 'second') settled.push({ stopReason: outcome.stopReason, error: outcome.error });
    return settleAgent.call(framework, name, outcome, ...rest);
  };
  const failures: Array<{ type: string; error?: string }> = [];
  let removed: boolean | undefined;
  let stopError: unknown;
  framework.onTrace((event) => {
    const trace = event as unknown as { type: string; agentName?: string; error?: string };
    if (trace.agentName !== 'second' || (trace.type !== 'inference:failed' && trace.type !== 'inference:exhausted')) return;
    failures.push({ type: trace.type, error: trace.error });
    if (trace.type !== 'inference:exhausted' || removed !== undefined) return;
    try {
      framework.stopAgent('second', { by: 'test' });
    } catch (error) {
      stopError = error;
    }
    removed = !internal.agents.has('second');
  });
  const logged = () => framework.queryInferenceLogs({ agentName: 'second' }).entries
    .map((e) => ({ success: e.entry.success, error: e.entry.error, errorWords: e.entry.errorWords }));
  const cause = 'Stream ended without a final response';
  try {
    framework.start();
    framework.nudgeAgent('second', 'operator');
    assert.ok(await settles(() => phases().length === 1 && phases()[0].length === 2 && !internal.activeTurnTokens.has('second')),
      `the silent stream's turn ends: ${JSON.stringify({ phases: phases(), failures })}`);
    // Room for a retry, which nothing should start.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(stopError, undefined, 'the listener stopped the agent');
    assert.equal(removed, true, 'the stop removed the agent before the stream logged its end');
    assert.deepEqual(settled.filter((s) => s.stopReason === 'exhausted'), [{ stopReason: 'exhausted', error: cause }], 'its settlement names the failure');
    assert.deepEqual(failures, [{ type: 'inference:exhausted', error: cause }], 'its one failure trace names it');
    assert.deepEqual(logged(), [{ success: false, error: cause, errorWords: cause }], 'both raw and operator-facing log reasons retain the established failure');
    assert.deepEqual(phases(), [['started', 'failed']], 'its lifecycle ends failed, not completed');
    assert.equal(membrane.calls.length, 1, 'nothing retries it or starts its turn again');
  } finally {
    internal.settleAgent = settleAgent;
    await teardown();
  }
});
