import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/**
 * A cancel that the stream reports as `error` is still a deliberate stop.
 *
 * Membrane's yielding stream answers cancel() with an `aborted` event, but
 * that is one implementation's choice: host-quiesce.test.ts already pins
 * that a stream may report cancel() through `error` instead, and driveStream
 * honours quiesce/shutdown provenance on that twin. The caller-cancel twin
 * was missed (Sol's review of #172, 2026-09-23): abortInference(reason) /
 * cancelStream() on an error-surfacing stream fell through the failure
 * pipeline — inference:failed, errorPolicy, and a retry that relaunched the
 * very inference someone had just stopped:
 *
 *   inference:started → inference:failed → inference:started
 *
 * Both twins must reach the same terminal: one inference:aborted carrying
 * the caller's reason, the [turn-interrupted] marker, no inference:failed,
 * no inference:exhausted, no retry.
 */

/** Parks until cancel(), then reports the cancel as an error event. */
class ErroringOnCancelStream implements YieldingStream {
  private release: (() => void) | null = null;
  private cancelled = false;
  cancel(): void { this.cancelled = true; this.release?.(); }
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.cancelled) await new Promise<void>((resolve) => { this.release = resolve; });
    yield { type: 'error', error: new Error('stream cancelled') } as StreamEvent;
  }
}

/** Parks until cancel(), then just ENDS — no `aborted`, no `error`. The
 *  third shape: an implementation whose cancel() closes the iterator. */
class SilentlyEndingOnCancelStream extends ErroringOnCancelStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await new Promise<void>((resolve) => { (this as unknown as { release: () => void }).release = resolve; });
  }
}

/** Parks until cancel(), then its iterator throws — the fourth shape: an
 *  implementation whose cancel() surfaces as the iterator's own rejection. */
class ThrowingOnCancelStream extends ErroringOnCancelStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const self = this as unknown as { cancelled: boolean; release: () => void };
    if (!self.cancelled) await new Promise<void>((resolve) => { self.release = resolve; });
    throw new Error('The operation was aborted');
  }
}

/** Parks until cancel(), reports the cancel as an error event, and then its
 *  iterator throws: the stream's end comes once, with the error event. */
class ErroringThenThrowingOnCancelStream extends ErroringOnCancelStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const self = this as unknown as { cancelled: boolean; release: () => void };
    if (!self.cancelled) await new Promise<void>((resolve) => { self.release = resolve; });
    yield { type: 'error', error: new Error('stream cancelled') } as StreamEvent;
    throw new Error('The operation was aborted');
  }
}

/** Fails spontaneously — the genuine provider error the failure pipeline is for. */
class SpontaneouslyErroringStream extends ErroringOnCancelStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await new Promise((r) => setTimeout(r, 20));
    yield { type: 'error', error: new Error('provider exploded') } as StreamEvent;
  }
}

class ErroringMembrane extends MockMembrane {
  constructor(private readonly make: () => YieldingStream) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return this.make();
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function boot(prefix: string, make: () => YieldingStream) {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const membrane = new ErroringMembrane(make);
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
    modules: [],
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((t) => { traces.push(t); });
  // Each stream's §10.5 lifecycle notifications, as an MCPL server with the
  // grant would get them: 'started', then its terminal phase as it ends.
  const lifecycle: string[] = [];
  (framework as unknown as { hookOrchestrator: unknown }).hookOrchestrator = {
    beforeInference: async () => [],
    emitLifecycle: (params: { phase: string }) => { lifecycle.push(params.phase); },
  };
  const terminals = (): string[] => lifecycle.filter((phase) => phase !== 'started');
  const teardown = async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  framework.start();
  framework.nudgeAgent('assistant', 'operator');
  const streaming = async () => {
    await waitFor(() => membrane.calls.length === 1);
    const agent = framework.getAgent('assistant')!;
    await waitFor(() => agent.state.status === 'streaming');
    return agent;
  };
  // The caller's try/finally starts only once boot() returns, so a setup that
  // times out tears itself down rather than leave the framework running and
  // its directory behind.
  const agent = await streaming().catch(async (error: unknown) => {
    // A teardown that fails as well is logged, so the setup's failure stays
    // the one the test reports.
    await teardown().catch((teardownError: unknown) => {
      console.error('boot(): teardown after a failed setup failed too:', teardownError);
    });
    throw error;
  });
  return { framework, membrane, agent, traces, teardown, terminals };
}

function contextTexts(framework: AgentFramework): string[] {
  const { messages } = framework.getAgent('assistant')!.getContextManager().queryMessages({});
  return messages.flatMap((m) =>
    m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text));
}

function types(traces: TraceEvent[], ...wanted: string[]): string[] {
  return traces.map((t) => String(t.type)).filter((t) => wanted.includes(t));
}

/**
 * How long a stopped inference is watched for a relaunch. When the cancel
 * fell through the failure pipeline, the default errorPolicy's retry
 * relaunched it about 1.2 s after the stop. Nothing marks that no retry is
 * coming, so this is a window placed against that delay, not a wait.
 */
const RELAUNCH_WINDOW_MS = 1500;

describe('a cancel that the stream reports as `error` is still a deliberate stop', () => {
  it('abortInference(reason) → ONE inference:aborted with the reason; no inference:failed, no retry', async () => {
    const { framework, membrane, agent, traces, teardown } =
      await boot('cancel-error-abort-', () => new ErroringOnCancelStream());
    try {
      assert.equal(framework.abortInference('assistant', 'operator_reclaim'), true);
      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      await new Promise((r) => setTimeout(r, RELAUNCH_WINDOW_MS));

      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.deepEqual(aborted.map((t) => t.reason), ['operator_reclaim'],
        `expected exactly one inference:aborted with the caller's reason, got ${JSON.stringify(aborted)}`);
      assert.deepEqual(types(traces, 'inference:failed', 'inference:exhausted'), [],
        `a deliberate stop is neither a failure nor an exhaustion: ${JSON.stringify(types(traces, 'inference:started', 'inference:failed', 'inference:exhausted', 'inference:aborted'))}`);
      assert.equal(membrane.calls.length, 1, 'the stopped inference must not be relaunched by errorPolicy');
      assert.equal(types(traces, 'inference:started').length, 1);
      assert.equal(agent.state.status, 'idle');

      // Same marker as the `aborted` twin: neutral text, reason in metadata.
      await waitFor(() => contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));
      const { messages } = agent.getContextManager().queryMessages({});
      const markerMsg = messages.find((m) =>
        m.content.some((b) => b.type === 'text' && b.text.includes('[turn-interrupted]')))!;
      assert.equal((markerMsg.metadata as { reason?: string } | undefined)?.reason, 'operator_reclaim');
      assert.ok(!contextTexts(framework).some((t) => t.includes('[inference-failed]')));
    } finally {
      await teardown();
    }
  });

  it('cancelStream() with no reason → inference:aborted reason user, marker, no failure accounting', async () => {
    const { framework, membrane, agent, traces, teardown } =
      await boot('cancel-error-plain-', () => new ErroringOnCancelStream());
    try {
      agent.cancelStream();
      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      await new Promise((r) => setTimeout(r, RELAUNCH_WINDOW_MS));

      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.deepEqual(aborted.map((t) => t.reason), ['user']);
      assert.deepEqual(types(traces, 'inference:failed', 'inference:exhausted'), []);
      assert.equal(membrane.calls.length, 1);
      await waitFor(() => contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));
    } finally {
      await teardown();
    }
  });

  it('a stream that errors on its own (nobody cancelled) still takes the failure pipeline', async () => {
    const { membrane, traces, teardown } =
      await boot('cancel-error-genuine-', () => new SpontaneouslyErroringStream());
    try {
      await waitFor(() => traces.some((t) => t.type === 'inference:failed'));
      // errorPolicy decides retry vs exhausted; either way it is a failure,
      // never a deliberate stop.
      await waitFor(() => traces.some((t) => t.type === 'inference:exhausted') || membrane.calls.length > 1, 3000);
      assert.deepEqual(types(traces, 'inference:aborted'), [], 'a provider error is not a cancellation');
    } finally {
      await teardown();
    }
  });

  it('a cancel whose stream ends with NO terminal event still ends as a deliberate stop', async () => {
    // Greptile on #172 (2026-09-28): an iterator that closes on cancel()
    // without `aborted` or `error` told the driver nothing, so nothing
    // settled the turn — no inference:aborted, the lifecycle terminal read
    // `completed`, and an ephemeral run would ride out its watchdog. The
    // caller's cancel IS the terminal for that shape too.
    const { framework, membrane, agent, traces, teardown } = await boot('cancel-silent-', () => new SilentlyEndingOnCancelStream());
    try {
      framework.abortInference('assistant', 'silent_stop');
      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'), ['inference:aborted'],
        `terminals: ${JSON.stringify(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'))}`);
      const aborted = traces.find((t) => t.type === 'inference:aborted') as { reason?: string };
      assert.equal(aborted.reason, 'silent_stop', 'the caller\'s reason rides the terminal');
      assert.equal(agent.state.status, 'idle');
      assert.equal(membrane.calls.length, 1, 'no retry of the inference that was stopped');
      assert.ok(contextTexts(framework).some((t) => t.startsWith('[turn-interrupted]')), 'the neutral marker is written');
    } finally {
      await teardown();
    }
  });

  it('a cancel whose stream throws still ends as a deliberate stop', async (t) => {
    // A stream whose iterator rejects once it's cancelled: the caller's
    // cancel decides there too, before the failure path, and the throw is
    // said on the console.
    const errors: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const { framework, membrane, agent, traces, teardown, terminals } = await boot('cancel-throw-', () => new ThrowingOnCancelStream());
    try {
      framework.abortInference('assistant', 'thrown_stop');
      // The stream's frame has ended once its terminal lifecycle phase is out.
      await waitFor(() => terminals().length > 0);
      assert.deepEqual(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'), ['inference:aborted'],
        `terminals: ${JSON.stringify(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'))}`);
      const aborted = traces.find((t) => t.type === 'inference:aborted') as { reason?: string };
      assert.equal(aborted.reason, 'thrown_stop', 'the caller\'s reason rides the terminal');
      assert.equal(agent.state.status, 'idle');
      assert.equal(membrane.calls.length, 1, 'no retry of the inference that was stopped');
      assert.ok(contextTexts(framework).some((t) => t.startsWith('[turn-interrupted]')), 'the neutral marker is written');
      assert.ok(!contextTexts(framework).some((t) => t.startsWith('[inference-failed]')), 'and no failure note');
      assert.deepEqual(terminals(), ['aborted'], "the stream's §10.5 terminal is `aborted`");
      assert.ok(errors.some((line) => line.includes("the stream threw after a caller's stop (thrown_stop)") && line.includes('The operation was aborted')),
        `the throw is said: ${JSON.stringify(errors)}`);
    } finally {
      await teardown();
    }
  });

  it('a cancel whose stream reports an error and then throws ends once, as a deliberate stop', async () => {
    // The error event is the stream's end; a throw after it isn't a second one.
    const { framework, membrane, traces, teardown, terminals } = await boot('cancel-error-throw-', () => new ErroringThenThrowingOnCancelStream());
    try {
      framework.abortInference('assistant', 'error_then_throw');
      // Once the stream's frame has ended, a throw it reached has already
      // ended the turn a second time, as a failure.
      await waitFor(() => terminals().length > 0);
      assert.deepEqual(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'), ['inference:aborted'],
        `terminals: ${JSON.stringify(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'))}`);
      assert.equal(membrane.calls.length, 1, 'no retry of the inference that was stopped');
      assert.ok(contextTexts(framework).some((t) => t.startsWith('[turn-interrupted]')), 'the neutral marker is written');
      assert.ok(!contextTexts(framework).some((t) => t.startsWith('[inference-failed]')), 'and no failure note');
      assert.deepEqual(terminals(), ['aborted'], "the stream's §10.5 terminal is `aborted`");
    } finally {
      await teardown();
    }
  });

  it('the reason of a cancel is consumed by the stream it ended, never by the next one', async () => {
    // A cancel whose stream reports NO terminal event at all (iterator just
    // ends) is collected at that stream's loop end — one inference:aborted,
    // the first stream's. The next stream must start clean: an error there
    // is a genuine failure, not a stale stop, and adds no second abort.
    let n = 0;
    const { framework, membrane, agent, traces, teardown } = await boot('cancel-error-stale-', () =>
      n++ === 0 ? new SilentlyEndingOnCancelStream() : new SpontaneouslyErroringStream());
    try {
      agent.cancelStream('stale_reason');
      await waitFor(() => agent.state.status === 'idle');
      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      const firstStreamAborts = traces.filter((t) => t.type === 'inference:aborted').length;
      assert.equal(firstStreamAborts, 1, 'the silent end is settled by the cancel that ended it');
      await new Promise((r) => setTimeout(r, 100));
      framework.nudgeAgent('assistant', 'operator');
      await waitFor(() => membrane.calls.length === 2);
      await waitFor(() => traces.some((t) => t.type === 'inference:failed'), 3000);
      await new Promise((r) => setTimeout(r, 100));
      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.equal(aborted.length, firstStreamAborts,
        `the first stream's reason leaked into the second: ${JSON.stringify(aborted)}`);
    } finally {
      await teardown();
    }
  });
});

/** Parks until cancel(), then reports it as `aborted` with reason `error`:
 *  the stream's own word that the call failed, after a caller's cancel. */
class AbortedWithErrorOnCancelStream extends ErroringOnCancelStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await new Promise<void>((resolve) => { (this as unknown as { release: () => void }).release = resolve; });
    yield { type: 'aborted', reason: 'error' } as StreamEvent;
  }
}

describe("the stream's own word decides before a caller's record", () => {
  it('after a caller\'s cancel, an `aborted` whose reason is `error` stays a failure', async () => {
    const { framework, agent, traces, teardown } = await boot('cancel-aborted-error-', () => new AbortedWithErrorOnCancelStream());
    try {
      agent.cancelStream('operator');
      // The turn's terminal trace: inference:exhausted on the failure path,
      // inference:aborted had it been taken as a stop.
      await waitFor(() => types(traces, 'inference:aborted', 'inference:exhausted').length > 0);
      assert.ok(!types(traces, 'inference:aborted').length, `not a deliberate stop: ${JSON.stringify(types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted'))}`);
      assert.ok(types(traces, 'inference:exhausted').length > 0, 'the failure pipeline ends it');
      assert.ok(!contextTexts(framework).some((t) => t.startsWith('[turn-interrupted]')), 'no deliberate-stop marker');
    } finally {
      await teardown();
    }
  });
});

// endTurn and a budget restart cancel the stream themselves, at a tool
// boundary, and mark it first. However the stream reports that cancel, as
// `aborted`, as an `error`, by just closing, or by throwing, it ends as the
// endTurn or the restart: not through the failure pipeline and never retried, an endTurn
// with its delivery receipt, and a restart with its gate window kept for the
// stream that follows.

type CancelReport = 'aborted' | 'error' | 'close' | 'throw' | 'error-then-throw';

/** One scripted response per stream; the first stream reports its cancel()
 *  as `aborted` (as membrane's yielding stream does), as an `error` event, by
 *  ending with no event at all, by its iterator throwing once it ends, or as
 *  an `error` event after which its iterator throws. */
class FirstStreamCancelledAs extends MockMembrane {
  private next = 0;
  /** Awaited before the second stream yields anything. */
  beforeSecondStream: (() => Promise<void>) | undefined;
  constructor(private readonly reports: CancelReport) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.next, ++this.next));
    if (this.calls.length === 2 && this.beforeSecondStream !== undefined) {
      const before = this.beforeSecondStream;
      const events = MockYieldingStream.prototype[Symbol.asyncIterator].bind(stream);
      (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<StreamEvent> })[Symbol.asyncIterator] = async function* () {
        await before();
        for await (const event of { [Symbol.asyncIterator]: events } as AsyncIterable<StreamEvent>) yield event;
      };
    }
    if (this.calls.length === 1 && this.reports !== 'aborted') {
      const reports = this.reports;
      let cancelled = false;
      const s = stream as unknown as {
        cancel: () => void; _done: boolean; events: StreamEvent[]; pendingResolve: null | (() => void);
        [Symbol.asyncIterator]: () => AsyncIterator<StreamEvent>;
      };
      if (reports === 'throw' || reports === 'error-then-throw') {
        const events = MockYieldingStream.prototype[Symbol.asyncIterator].bind(stream);
        s[Symbol.asyncIterator] = async function* () {
          for await (const event of { [Symbol.asyncIterator]: events } as AsyncIterable<StreamEvent>) yield event;
          if (cancelled) throw new Error('The operation was aborted');
        };
      }
      s.cancel = function (this: typeof s) {
        cancelled = true;
        this._done = true;
        if (reports === 'error' || reports === 'error-then-throw') this.events.push({ type: 'error', error: new Error('stream cancelled') } as StreamEvent);
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve?.();
      };
    }
    this.lastStream = stream;
    return stream;
  }
}

/** `end` ends the turn; `fetch` returns a result large enough that the next
 *  round would pass the physical window, so the framework restarts. */
class TurnTools implements Module {
  readonly name = 'turn';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'end', description: 'Finish the turn', inputSchema: { type: 'object', properties: {} } },
      { name: 'fetch', description: 'A large result', inputSchema: { type: 'object', properties: {} } },
    ];
  }
  async handleToolCall(call: { name: string }): Promise<ToolResult> {
    if (call.name === 'end' || call.name.endsWith('--end')) return { success: true, data: { finished: true }, endTurn: true };
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

async function toolTurn(tool: 'end' | 'fetch', reports: CancelReport) {
  const tempDir = mkdtempSync(join(tmpdir(), `cancel-error-${tool}-`));
  const membrane = new FirstStreamCancelledAs(reports);
  const call = createMockResponse([
    { type: 'text', text: 'Working…' },
    { type: 'tool_use', id: 'call_1', name: `turn--${tool}`, input: {} },
  ], 'tool_use');
  // A near-cap real prompt (5k fresh + 195k cache-read), as
  // physical-window-restart.test.ts uses, so `fetch`'s round restarts.
  if (tool === 'fetch') (call as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
  membrane.pushResponse(call);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered final answer' }]));
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'assistant',
      model: 'test-model',
      systemPrompt: 'Assist.',
      allowedTools: 'all',
      maxTokens: 4_000,
      ...(tool === 'fetch' ? { physicalWindowTokens: 200_000 } : {}),
    }],
    modules: [new TurnTools()],
    syncIntervalMs: 0,
    // An event gate, so the test can see when the agent's inference window
    // ends.
    gate: { config: { policies: [], default: 'always' } },
  }).catch((error: unknown) => {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  });
  const teardown = async () => {
    try {
      await framework.stop();
    } finally {
      console.error = consoleError;
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
  const traces: TraceEvent[] = [];
  framework.onTrace((t) => { traces.push(t); });
  const internals = framework as unknown as {
    eventGate: { onInferenceEnded(name: string): void; inferenceDiagnostics(): { inferring: string[] } };
    hookOrchestrator: { beforeInference(params: unknown): Promise<unknown[]>; emitLifecycle(params: { phase: string }): void } | null;
  };
  // Each stream's §10.5 lifecycle notifications, as an MCPL server with
  // the grant would get them: 'started' when it starts, and its terminal
  // phase when its frame ends.
  const lifecycle: string[] = [];
  internals.hookOrchestrator = {
    beforeInference: async () => [],
    emitLifecycle: (params) => { lifecycle.push(params.phase); },
  };
  // How often the agent's inference window closes: an end while the window
  // is open. A budget restart's new stream continues the window its turn
  // opened, taking it again if it closed in between (onInferenceResumed),
  // so a kept window closes once, at the new stream's end, and a close
  // before the new stream takes the window adds one.
  let windowCloses = 0;
  const gate = internals.eventGate;
  const endWindow = gate.onInferenceEnded.bind(gate);
  gate.onInferenceEnded = (name: string) => {
    if (name === 'assistant' && gate.inferenceDiagnostics().inferring.includes('assistant')) windowCloses++;
    endWindow(name);
  };
  // A close after the new stream has taken the window leaves the count at
  // one, so the new stream also waits until the first stream's frame has
  // ended (its finally ends the window, when it does, right after it emits
  // its terminal phase) and then sees whether the window is still open.
  let windowOpenAfterFirstStream: boolean | undefined;
  if (tool === 'fetch') {
    membrane.beforeSecondStream = async () => {
      await waitFor(() => lifecycle.some((phase) => phase !== 'started'), 10_000);
      await new Promise((resolve) => setImmediate(resolve));
      windowOpenAfterFirstStream = gate.inferenceDiagnostics().inferring.includes('assistant');
    };
  }
  // The inference log as a caller reads it, oldest first: 'ok' for a
  // success, 'failed' for a failure.
  const logged = (): string[] => framework.queryInferenceLogs({ agentName: 'assistant' }).entries
    .map((e) => (e.entry.success === false ? 'failed' : 'ok'))
    .reverse();
  // What the framework says on the console, such as a throw it ends as a
  // cancel: recorded, and still printed, so a failing test shows it.
  // Restored at teardown.
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); consoleError(...args); };
  // A channel to speak in, so a round's prose is delivered live and the
  // turn's end writes its delivery receipt. Everything else the framework
  // asks of the registry is a no-op.
  const channels: Record<string, unknown> = {
    resolveLocus: () => ({ serverId: 'stub', channelId: 'chan-live' }),
    routeSpeech: async (_agent: string, _text: string, locus?: { serverId: string; channelId: string } | null) => (locus ? { delivered: true, serverId: locus.serverId, channelId: locus.channelId } : null),
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(channels, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  try {
    framework.start();
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: [{ type: 'text', text: 'go' }],
      metadata: {},
      triggerInference: true,
    } as unknown as ProcessEvent);
  } catch (error) {
    await teardown();
    throw error;
  }
  // The terminal phases of the streams whose frames have ended, in order.
  const terminals = (): string[] => lifecycle.filter((phase) => phase !== 'started');
  return {
    framework, membrane, traces, teardown, terminals, errors,
    logged,
    windowCloses: () => windowCloses,
    windowOpenAfterFirstStream: () => windowOpenAfterFirstStream,
  };
}

const REPORTED = { aborted: 'as aborted', error: 'as an error', close: 'by just closing', throw: 'by throwing', 'error-then-throw': 'as an error and then by throwing' } as const;
for (const reports of ['aborted', 'error', 'close', 'throw', 'error-then-throw'] as const) describe(`endTurn and a budget restart over a stream that reports their cancel ${REPORTED[reports]}`, () => {
  it('an endTurn ends the turn: no failure, nothing starts it again, its delivery receipt is written, and its lifecycle ends `aborted`', async () => {
    const { framework, membrane, traces, teardown, terminals, errors, logged } = await toolTurn('end', reports);
    try {
      // The stream's frame has ended once its terminal lifecycle phase is out,
      // and anything it queued has run once the framework is idle.
      await waitFor(() => terminals().length > 0, 10_000);
      await framework.runUntilIdle();
      const ends = types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted');
      assert.deepEqual(ends, [], `the ended turn is neither a stop nor a failure: ${JSON.stringify(ends)}; inference log: ${JSON.stringify(logged())}`);
      assert.deepEqual(logged(), ['ok'], 'the inference log holds the boundary\'s own entry, and no failure');
      assert.ok(!contextTexts(framework).some((t) => t.startsWith('[inference-failed]')), "no failure note in the agent's context");
      assert.equal(membrane.calls.length, 1, 'nothing starts the ended turn again');
      assert.deepEqual(contextTexts(framework).filter((t) => t.startsWith('[delivered]')), ['[delivered] plain speech → chan-live'],
        "the turn's end writes the receipt for the prose its round delivered");
      assert.deepEqual(terminals(), ['aborted'], "the stream's §10.5 terminal is `aborted`");
      if (reports === 'throw') {
        assert.ok(errors.some((line) => line.includes("the stream threw after the framework's cancel (turn_ended)")), `the throw is said: ${JSON.stringify(errors)}`);
      }
    } finally {
      await teardown();
    }
  });

  it('a budget restart ends as the restart: no stop, no failure, its gate window kept, its first stream ends `aborted`, and the turn finishes on the new stream', async () => {
    const { framework, membrane, traces, teardown, terminals, errors, logged, windowCloses, windowOpenAfterFirstStream } = await toolTurn('fetch', reports);
    try {
      const answered = () => contextTexts(framework).some((t) => t.includes('Recovered final answer'));
      // Both streams' frames have ended once both terminal phases are out.
      await waitFor(() => terminals().length >= 2 || types(traces, 'inference:failed', 'inference:aborted').length > 0, 10_000);
      const ends = types(traces, 'inference:aborted', 'inference:failed', 'inference:exhausted');
      assert.equal(types(traces, 'inference:stream_restarted').length, 1, 'the framework restarted the stream');
      assert.deepEqual(ends, [], `the restarted stream is neither a stop nor a failure: ${JSON.stringify(ends)}; inference log: ${JSON.stringify(logged())}`);
      assert.deepEqual(logged(), ['ok', 'ok'], "the inference log holds the restart's entry and the new stream's, and no failure");
      assert.ok(answered(), 'the turn finishes on the new stream');
      assert.equal(membrane.calls.length, 2, 'the restart opens one stream, and nothing starts the first again');
      assert.ok(!contextTexts(framework).some((t) => t.startsWith('[turn-interrupted]') || t.startsWith('[inference-failed]')),
        "no note in the agent's context");
      assert.equal(windowCloses(), 1, "the window closes once: the first stream's end doesn't close it before the new stream takes it");
      assert.equal(windowOpenAfterFirstStream(), true, "the window is still open once the first stream's frame has ended, as the new stream runs");
      assert.deepEqual(terminals(), ['aborted', 'completed'], "the first stream's §10.5 terminal is `aborted`, the new one's `completed`");
      if (reports === 'throw') {
        assert.ok(errors.some((line) => line.includes("the stream threw after the framework's cancel (budget_restart)")), `the throw is said: ${JSON.stringify(errors)}`);
      }
    } finally {
      await teardown();
    }
  });

  it("a budget restart whose new start fails before its stream exists ends the event gate's window", async () => {
    // The first stream leaves the window open for the new stream. A new start
    // that throws before it has a stream, here at its turn checkpoint's store
    // write, has to end it: left open, every gate event buffers, for every
    // agent.
    const { framework, traces, teardown, terminals } = await toolTurn('fetch', reports);
    const internals = framework as unknown as {
      recordTurnCheckpoint: (name: string) => void;
      eventGate: { inferenceDiagnostics(): { inferring: string[] } };
    };
    const record = internals.recordTurnCheckpoint.bind(framework);
    let threw = 0;
    internals.recordTurnCheckpoint = (name: string) => {
      if (types(traces, 'inference:stream_restarted').length > 0) {
        threw++;
        throw new Error('ENOSPC: no space left on device');
      }
      record(name);
    };
    try {
      await waitFor(() => threw > 0 && terminals().length > 0, 10_000);
      // The failed start's catch runs a few microtasks after the throw.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(threw, 1, "the restart's new start threw at its checkpoint");
      assert.deepEqual(internals.eventGate.inferenceDiagnostics().inferring, [], 'no agent is left inferring at the event gate');
    } finally {
      await teardown();
    }
  });
});
