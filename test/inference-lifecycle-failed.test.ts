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

/** Each stream it opens ends as the next of `ends` says; past them, a completion. */
class ScriptedMembrane extends MockMembrane {
  constructor(private readonly ends: StreamEvent[]) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const last = this.ends.shift();
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
async function frameworkOver(ends: StreamEvent[], errorPolicy: ErrorPolicy) {
  const dir = mkdtempSync(join(tmpdir(), 'af-lifecycle-failed-'));
  const membrane = new ScriptedMembrane(ends);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system' }],
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
