/**
 * The default error policy decides the framework's turn retries on membrane's
 * own schedules (@animalabs/membrane/retry), and the framework's turns pass
 * `retry: false` to membrane, so the framework is the one retry layer.
 */
import { describe, it, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import { MEMBRANE_RETRY_SETTINGS, type RetrySettings } from '@animalabs/membrane/retry';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, DefaultErrorPolicy } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const err = (info: { type: string; retryable: boolean; httpStatus?: number; retryAfterMs?: number; message?: string }) =>
  new MembraneError({ message: info.message ?? `zz ${info.type}`, rawError: undefined, ...info } as ConstructorParameters<typeof MembraneError>[0]);

/** The retries a policy grants a failure, attempt by attempt, until it stops. */
function delays(policy: DefaultErrorPolicy, error: Error): number[] {
  const out: number[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const action = policy.onInferenceError(error, 'resident', attempt);
    if (!action.retry) return out;
    out.push(action.delayMs);
  }
  throw new Error('the policy never stopped retrying');
}

describe('DefaultErrorPolicy on membrane\'s schedules', () => {
  const policy = new DefaultErrorPolicy();

  it('ends a failure the provider says may not be retried at once', () => {
    assert.deepEqual(delays(policy, err({ type: 'invalid_request', retryable: false, httpStatus: 400 })), []);
    assert.deepEqual(delays(policy, err({ type: 'auth', retryable: false, httpStatus: 401 })), []);
  });

  it('retries any other retryable failure on the base schedule: three tries, 1 s then 2 s', () => {
    assert.deepEqual(delays(policy, err({ type: 'server', retryable: true, httpStatus: 502 })), [1000, 2000]);
  });

  it('retries a timeout membrane doesn\'t mark as a deadline, such as an HTTP 408, on the base schedule', () => {
    assert.deepEqual(delays(policy, err({ type: 'timeout', retryable: true, httpStatus: 408, message: 'Request Timeout' })), [1000, 2000]);
  });

  it('retries a rate limit with no stated wait at least five tries', () => {
    assert.deepEqual(delays(policy, err({ type: 'rate_limit', retryable: true, httpStatus: 429 })), [1000, 2000, 4000, 8000]);
  });

  it("waits a stated wait longer than the backoff up to the framework's ten-minute cap, and ends past it", () => {
    const wait = (ms: number) => err({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: ms });
    assert.deepEqual(policy.onInferenceError(wait(20_000), 'resident', 0), { retry: true, delayMs: 20_000 });
    // Past membrane's one-minute ceiling but inside the framework's cap, which
    // nonOwningProviderWait leaves to this policy to sleep, as before.
    assert.deepEqual(policy.onInferenceError(wait(90_000), 'resident', 0), { retry: true, delayMs: 90_000 });
    assert.deepEqual(policy.onInferenceError(wait(600_000), 'resident', 0), { retry: true, delayMs: 600_000 });
    assert.deepEqual(policy.onInferenceError(wait(660_000), 'resident', 0), { retry: false });
  });

  it("gives a 529 the overloaded schedule with thirteen tries, about 0.26.0's half hour: jittered waits from 10 s doubling to 5 min", () => {
    const overloaded = err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error' });
    const waits = delays(policy, overloaded);
    assert.equal(waits.length, 12, 'twelve retries after the first send');
    const steps = [10_000, 20_000, 40_000, 80_000, 160_000, ...Array(7).fill(300_000)];
    waits.forEach((w, i) => assert.ok(w >= Math.floor(steps[i] / 2) && w < steps[i], `retry ${i + 1} waits ${w} ms, in [${steps[i] / 2}, ${steps[i]})`));
    // An overloaded error mid-stream carries no status, only its message.
    assert.equal(delays(policy, err({ type: 'server', retryable: true, message: 'overloaded_error: Overloaded' })).length, 12);
  });

  it('takes the settings it is given, as a host would pass a recipe\'s', () => {
    const { overloaded: _off, ...noOverloaded } = MEMBRANE_RETRY_SETTINGS as RetrySettings;
    const custom = new DefaultErrorPolicy(noOverloaded);
    // With no overloaded schedule a 529 is retried as any retryable failure.
    assert.deepEqual(delays(custom, err({ type: 'server', retryable: true, httpStatus: 529 })), [1000, 2000]);
    assert.equal(custom.maxRetries, 4, 'its largest class allows four retries (rate_limited)');
    assert.equal(policy.maxRetries, 12, 'the defaults allow twelve (overloaded)');
    assert.equal(delays(new DefaultErrorPolicy(MEMBRANE_RETRY_SETTINGS as RetrySettings), err({ type: 'server', retryable: true, httpStatus: 529 })).length, 6);
  });

  it("keeps a host's own stated-wait ceiling, where the defaults wait up to the framework's ten minutes (#734)", () => {
    const s = MEMBRANE_RETRY_SETTINGS as RetrySettings;
    const host = new DefaultErrorPolicy({ ...s, rate_limited: { ...s.rate_limited!, statedWaitCeilingMs: 30_000 } } as RetrySettings);
    const wait = (ms: number) => err({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: ms });
    assert.deepEqual(host.onInferenceError(wait(20_000), 'resident', 0), { retry: true, delayMs: 20_000 });
    assert.deepEqual(host.onInferenceError(wait(90_000), 'resident', 0), { retry: false }, 'past its own ceiling: the turn ends');
    assert.deepEqual(policy.onInferenceError(wait(90_000), 'resident', 0), { retry: true, delayMs: 90_000 }, 'the defaults still wait it');
  });

  it('retries an error that is not a MembraneError as a retryable failure, on the base schedule', () => {
    assert.deepEqual(delays(policy, new Error('zz local failure')), [1000, 2000]);
  });
});

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

/** Records the options each streamYielding call is given. */
class OptionsMembrane extends MockMembrane {
  readonly streamOptions: unknown[] = [];
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    this.streamOptions.push(options);
    return super.streamYielding(request, options);
  }
}

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

/** The first `failures` turn streams fail with a 502; then they answer. */
class FlakyMembrane extends OptionsMembrane {
  constructor(private failures: number) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    if (this.failures > 0) {
      this.failures--;
      this.streamOptions.push(options);
      return new ErrorStream(err({ type: 'server', retryable: true, httpStatus: 502, message: 'zz bad gateway' }));
    }
    return super.streamYielding(request, options);
  }
}

async function makeFramework(t: TestContext, membrane: MockMembrane, errorPolicy?: unknown, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...(errorPolicy !== undefined ? { errorPolicy: errorPolicy as never } : {}), ...extra,
  });
  t.after(() => fw.stop().catch(() => {}));
  return fw;
}

async function idle(fw: AgentFramework, ms = 15_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([fw.runUntilIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the framework never went idle')), ms); })])
    .finally(() => clearTimeout(timer));
}

test('a failed turn is retried by the framework on the base schedule, each attempt a fresh stream with no membrane retries', async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
  const fw = await makeFramework(t, membrane);
  const started = Date.now();
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  assert.equal(membrane.streamOptions.length, 2, 'one failed stream, then the retry');
  for (const options of membrane.streamOptions) assert.equal((options as { retry?: unknown }).retry, false);
  assert.ok(Date.now() - started >= 900, 'the retry waited the base schedule\'s first second');
});

test("a direct caller of Agent.startStream keeps membrane's retries", async (t: TestContext) => {
  const membrane = new OptionsMembrane();
  const fw = await makeFramework(t, membrane);
  const agent = fw.getAllAgents()[0];
  const { stream } = await agent.startStream([]);
  stream.cancel();
  assert.equal(membrane.streamOptions.length, 1);
  assert.equal((membrane.streamOptions[0] as { retry?: unknown }).retry, undefined, 'no retry: false on a stream the framework does not drive');
});

class ThrowingStream extends ErrorStream {
  constructor(private readonly thrown: Error) { super(thrown); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.thrown;
  }
}

class ThrowOnceMembrane extends OptionsMembrane {
  constructor(private error: Error | null) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    if (this.error) {
      const error = this.error;
      this.error = null;
      this.streamOptions.push(options);
      return new ThrowingStream(error);
    }
    return super.streamYielding(request, options);
  }
}

const scaled = (firstDelayMs: number): RetrySettings => {
  const s = MEMBRANE_RETRY_SETTINGS as RetrySettings;
  return { ...s, overloaded: { ...s.overloaded!, firstDelayMs, maxDelayMs: firstDelayMs * 30 } } as RetrySettings;
};

const traceOf = (fw: AgentFramework, agentName = 'resident') => {
  const events: Array<{ at: number; type: string; until?: number }> = [];
  fw.onTrace((e) => {
    if ((e as { agentName?: string }).agentName !== agentName) return;
    events.push({ at: Date.now(), type: e.type, ...((e as { until?: number }).until !== undefined ? { until: (e as { until?: number }).until } : {}) });
  });
  return events;
};

test("a turn waiting out the policy's delay says so as the wait begins, with its end, and at each cadence point; nothing once it ends", async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
  const fw = await makeFramework(t, membrane, {
    maxRetries: 1,
    onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 1 ? { retry: true, delayMs: 1_000 } : { retry: false }),
  });
  (fw as unknown as { waitingTraceEveryMs: number }).waitingTraceEveryMs = 100;
  const events = traceOf(fw);
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  assert.equal((fw as unknown as { retryWaitWakers: Set<unknown> }).retryWaitWakers.size, 0, 'the wait left no waker behind');
  const failed = events.findIndex((e) => e.type === 'inference:failed');
  const restarted = events.findIndex((e, i) => i > failed && e.type === 'inference:started');
  assert.ok(failed >= 0 && restarted > failed, 'the turn failed once and started again');
  const waiting = events.filter((e) => e.type === 'inference:waiting');
  assert.equal(events[failed + 1]!.type, 'inference:waiting', 'said as the wait begins, right after the failure');
  const first = events[failed + 1]!;
  assert.ok(first.until !== undefined && first.until >= first.at + 900 && first.until <= first.at + 1_100, `its end is the delay away: ${first.until! - first.at} ms`);
  assert.ok(waiting.length >= 8 && waiting.length <= 12, `said at each cadence point while the wait lasted, and no more often (${waiting.length} in all)`);
  assert.ok(waiting.every((e) => events.indexOf(e) < restarted), 'nothing once the wait has ended');
  assert.ok(waiting.every((e) => e.until === first.until), 'each names the same end');
});

test("a wall clock stepping back during the wait doesn't stretch its cadence: it is counted by the wait's own timers", async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
  const fw = await makeFramework(t, membrane, {
    maxRetries: 1,
    onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 1 ? { retry: true, delayMs: 1_000 } : { retry: false }),
  });
  (fw as unknown as { waitingTraceEveryMs: number }).waitingTraceEveryMs = 100;
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  let stepped = false;
  fw.onTrace((e) => {
    if (e.type !== 'inference:waiting' || stepped) return;
    stepped = true;
    Date.now = () => realNow() - 120_000;
  });
  const waiting: number[] = [];
  fw.onTrace((e) => { if (e.type === 'inference:waiting') waiting.push(realNow()); });
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  Date.now = realNow;
  assert.ok(stepped, 'the clock stepped back');
  assert.ok(waiting.length >= 8 && waiting.length <= 12, `said at the cadence after the clock stepped back (${waiting.length} in all)`);
});

test('a listener of inference:waiting that stops the framework ends the wait, and nothing more is said', async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  const fw = await makeFramework(t, membrane, {
    maxRetries: 1,
    onInferenceError: () => ({ retry: true, delayMs: 60_000 }),
  });
  assert.equal((fw as unknown as { waitingTraceEveryMs: number }).waitingTraceEveryMs, 60_000);
  const events = traceOf(fw);
  let stopped: Promise<void> | undefined;
  fw.onTrace((e) => { if (e.type === 'inference:waiting' && !stopped) stopped = fw.stop(); });
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  void fw.runUntilIdle().catch(() => {});
  const began = Date.now();
  for (let i = 0; i < 200 && !stopped; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(stopped, 'the wait began');
  await stopped;
  assert.ok(Date.now() - began < 20_000, 'the stop ended the 60 s wait');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(events.filter((e) => e.type === 'inference:waiting').length, 1, 'said once, as it began');
  assert.equal(membrane.streamOptions.length, 1, 'no retry was sent');
});

test('a wait too long for a date says it is waiting, with no until', async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  const fw = await makeFramework(t, membrane, { maxRetries: 1, onInferenceError: () => ({ retry: true, delayMs: Number.POSITIVE_INFINITY }) });
  const events = traceOf(fw);
  let said!: () => void;
  const saidOnce = new Promise<void>((r) => { said = r; });
  fw.onTrace((e) => { if (e.type === 'inference:waiting') said(); });
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  void fw.runUntilIdle().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([saidOnce, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the wait never said so')), 15_000); })])
    .finally(() => clearTimeout(timer));
  const waiting = events.find((e) => e.type === 'inference:waiting')!;
  assert.equal('until' in waiting, false, 'no until');
  await fw.stop();
});

class EventOnceMembrane extends OptionsMembrane {
  constructor(private error: Error | null) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    if (this.error) {
      const error = this.error;
      this.error = null;
      this.streamOptions.push(options);
      return new ErrorStream(error);
    }
    return super.streamYielding(request, options);
  }
}

function recordingPolicy() {
  const policy = new DefaultErrorPolicy(scaled(20));
  const asked: Array<{ type: string; httpStatus?: number; attempt: number; retry: boolean }> = [];
  return {
    asked,
    maxRetries: policy.maxRetries,
    onInferenceError: (e: Error, agentName: string, attempt: number) => {
      const decision = policy.onInferenceError(e, agentName, attempt);
      const m = e as MembraneError;
      asked.push({ type: m.type, httpStatus: m.httpStatus, attempt, retry: decision.retry });
      return decision;
    },
  };
}

test('a retryable 529 a stream of another make throws from its iterator is retried as the same 529 sent as an error event is (#734)', async (t: TestContext) => {
  const overloaded = () => err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error' });
  const run = async (membrane: OptionsMembrane) => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
    const policy = recordingPolicy();
    const fw = await makeFramework(t, membrane, policy);
    const events = traceOf(fw);
    const { lines } = await laterEventLines(t, async () => {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
      await idle(fw);
    }, 'taken as its error event');
    return { result: { types: events.map((e) => e.type), asked: policy.asked, sends: membrane.streamOptions.length }, lines };
  };
  const { result: thrown, lines: thrownLines } = await run(new ThrowOnceMembrane(overloaded()));
  const { result: sent, lines: sentLines } = await run(new EventOnceMembrane(overloaded()));
  assert.equal(thrownLines.length, 1, 'one line names the thrown failure, which the error path itself does not log');
  assert.match(thrownLines[0]!, /^\[stream\] resident: the stream threw a retryable failure from its iterator, taken as its error event: .*overloaded_error/);
  assert.equal(sentLines.length, 0);
  assert.equal(thrown.sends, 2, 'the throw, then the retry');
  assert.ok(thrown.types.includes('inference:completed'), 'the retry answered');
  assert.deepEqual(thrown.asked, [{ type: 'server', httpStatus: 529, attempt: 0, retry: true }], 'the policy was asked about the 529 and retried it');
  assert.deepEqual(thrown, sent, 'the same sends, the same policy questions and answers, the same trace as the error event');
});

class ThrowThenRecordMembrane extends OptionsMembrane {
  thrown: ThrowingStream | undefined;
  cancelledAtRetry: boolean | undefined;
  constructor(private readonly cancelThrows: boolean) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    if (!this.thrown) {
      this.streamOptions.push(options);
      const stream = new ThrowingStream(err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error' }));
      if (this.cancelThrows) stream.cancel = () => { stream.isCancelled = true; throw new Error('zz cancel fault'); };
      this.thrown = stream;
      return stream;
    }
    this.cancelledAtRetry ??= this.thrown.isCancelled;
    return super.streamYielding(request, options);
  }
}

for (const cancelThrows of [false, true]) {
  test(`a stream whose iterator threw a retryable failure is cancelled before the retry's stream is asked for${cancelThrows ? ', and a cancel() that throws still leaves the retry to run' : ''}`, async (t: TestContext) => {
    const membrane = new ThrowThenRecordMembrane(cancelThrows);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
    const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
    const events = traceOf(fw);
    const { lines } = await laterEventLines(t, async () => {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
      await idle(fw);
    }, 'cancelling the stream that threw failed');
    assert.equal(membrane.cancelledAtRetry, true, 'cancelled before the retry');
    assert.ok(events.some((e) => e.type === 'inference:completed'), 'the retry answered');
    assert.equal(lines.length, cancelThrows ? 1 : 0, 'a cancel that throws is said');
  });
}

for (const [what, thrown] of [
  ['a failure the provider says may not be retried', err({ type: 'invalid_request', retryable: false, httpStatus: 400 })],
  ['an error that is not a MembraneError', new Error('zz iterator fault')],
] as const) {
  test(`${what}, thrown from a stream's iterator, ends the turn as a throw did, without asking the error policy`, async (t: TestContext) => {
    const membrane = new ThrowOnceMembrane(thrown);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-never' }]));
    let asked = 0;
    const fw = await makeFramework(t, membrane, {
      maxRetries: 1,
      onInferenceError: (_e: Error, _a: string, attempt: number) => { asked++; return attempt < 1 ? { retry: true, delayMs: 10 } : { retry: false }; },
    });
    const events = traceOf(fw);
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
    await idle(fw);
    assert.equal(membrane.streamOptions.length, 1, 'no retry');
    assert.equal(asked, 0, 'the policy was not asked');
    assert.deepEqual(events.filter((e) => e.type.startsWith('inference:') && e.type !== 'inference:started').map((e) => e.type), ['inference:failed', 'inference:exhausted']);
  });
}

test("a retryable failure on the start path, before any stream, is retried by the default policy (#734)", async (t: TestContext) => {
  const membrane = new OptionsMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-start-retry' }]));
  const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
  const agent = fw.getAllAgents()[0]!;
  const compile = agent.startStreamWithInjections.bind(agent);
  let compiles = 0;
  agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
    compiles++;
    if (compiles === 1) throw err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error' });
    return compile(...args);
  }) as typeof agent.startStreamWithInjections;
  const events = traceOf(fw);
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  assert.equal(compiles, 2, 'the failed start, then the retry');
  assert.ok(events.some((e) => e.type === 'inference:waiting'), 'its wait said so');
  assert.ok(events.some((e) => e.type === 'inference:completed'), 'the retry answered');
});

class CompleteOptionsMembrane extends MockMembrane {
  readonly completeOptions: unknown[] = [];
  override async complete(request: NormalizedRequest, options?: unknown) {
    this.completeOptions.push(options);
    return createMockResponse([{ type: 'text', text: 'zz-summary' }]);
  }
}

test("a resident's, a conversation agent's and an ephemeral run's context managers keep membrane's own retries: each complete() call's retry option reaches membrane as its caller gave it", async (t: TestContext) => {
  const membrane = new CompleteOptionsMembrane();
  const fw = await makeFramework(t, membrane, new DefaultErrorPolicy());
  const request = { messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-compress' }] }], config: { model: 'zz-model', maxTokens: 10 } } as unknown as NormalizedRequest;
  const membraneOf = (cm: unknown) => (cm as { membrane: { complete(r: NormalizedRequest, o?: unknown): Promise<unknown> } }).membrane;
  const internal = fw as unknown as { conversationAuxiliaryMembraneFor(name: string): { complete(r: NormalizedRequest, o?: unknown): Promise<unknown> } };
  const lastRetry = () => (membrane.completeOptions.at(-1) as { retry?: unknown } | undefined)?.retry;
  const signal = new AbortController().signal;

  await membraneOf(fw.getAgent('resident')!.getContextManager()).complete(request, { signal });
  assert.equal(lastRetry(), undefined, "a resident's");
  await membraneOf(fw.getAgent('resident')!.getContextManager()).complete(request, { retry: true });
  assert.equal(lastRetry(), true, "a caller's own retry");
  await internal.conversationAuxiliaryMembraneFor('resident').complete(request);
  assert.equal(lastRetry(), undefined, "a conversation agent's");
  const { contextManager, cleanup } = await fw.createEphemeralAgent({ name: 'eph-retries', model: 'zz-model', systemPrompt: 'zz' });
  await membraneOf(contextManager).complete(request);
  assert.equal(lastRetry(), undefined, "an ephemeral run's");
  cleanup();
});

test("an ephemeral run, as a host's subagent is, says it is waiting out its retry, with its end", async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
  const fw = await makeFramework(t, membrane, {
    maxRetries: 1,
    onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 1 ? { retry: true, delayMs: 500 } : { retry: false }),
  });
  const events = traceOf(fw, 'eph-waits');
  const { agent, contextManager } = await fw.createEphemeralAgent({ name: 'eph-waits', model: 'zz-model', systemPrompt: 'zz' });
  contextManager.addMessage('user', [{ type: 'text', text: 'zz-run' }]);
  const run = fw.runEphemeralToCompletion(agent, contextManager, { startupTimeoutMs: 10_000 });
  fw.start();
  const result = await run;
  assert.match(result.speech, /zz-after-retry/);
  const failed = events.findIndex((e) => e.type === 'inference:failed');
  assert.ok(failed >= 0, 'the run failed once');
  const waiting = events[failed + 1]!;
  assert.equal(waiting.type, 'inference:waiting', 'said as the wait begins, right after the failure');
  assert.ok(waiting.until !== undefined && waiting.until - waiting.at >= 400 && waiting.until - waiting.at <= 600, `its end is the delay away: ${waiting.until! - waiting.at} ms`);
});

test('a listener of inference:waiting that calls abortInference ends the wait and the turn, with no retry', async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  const fw = await makeFramework(t, membrane, { maxRetries: 1, onInferenceError: () => ({ retry: true, delayMs: 60_000 }) });
  const events = traceOf(fw);
  let aborted: boolean | undefined;
  fw.onTrace((e) => { if (e.type === 'inference:waiting' && aborted === undefined) aborted = fw.abortInference('resident', 'zz-stop'); });
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  const began = Date.now();
  await idle(fw, 20_000);
  assert.equal(aborted, true, 'the stop was taken');
  assert.ok(Date.now() - began < 20_000, 'the 60 s wait ended');
  assert.equal(events.filter((e) => e.type === 'inference:waiting').length, 1, 'said once, as it began');
  assert.ok(events.some((e) => e.type === 'inference:aborted'), 'the turn ended as a stop');
  assert.equal(membrane.streamOptions.length, 1, 'no retry was sent');
});

test('the wait says nothing while its agent is not the one registered under its name', async (t: TestContext) => {
  const membrane = new FlakyMembrane(1);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
  const fw = await makeFramework(t, membrane, { maxRetries: 1, onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 1 ? { retry: true, delayMs: 1_000 } : { retry: false }) });
  (fw as unknown as { waitingTraceEveryMs: number }).waitingTraceEveryMs = 100;
  const agents = (fw as unknown as { agents: Map<string, unknown> }).agents;
  const events = traceOf(fw);
  let replacedAt = 0;
  let restoredAt = 0;
  fw.onTrace((e) => {
    if (e.type !== 'inference:waiting' || replacedAt) return;
    const real = agents.get('resident');
    agents.set('resident', Object.create(real as object));
    replacedAt = Date.now();
    setTimeout(() => { agents.set('resident', real); restoredAt = Date.now(); }, 500);
  });
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  const waiting = events.filter((e) => e.type === 'inference:waiting');
  assert.ok(replacedAt && restoredAt, 'the name was taken over and given back during the wait');
  assert.equal(waiting.filter((e) => e.at > replacedAt && e.at < restoredAt).length, 0, 'nothing while another agent had the name');
  assert.ok(waiting.some((e) => e.at >= restoredAt), 'said again once it had it back');
});

class SendThenThrowStream extends ErrorStream {
  constructor(private readonly events: StreamEvent[], private readonly thrown: Error | null) { super(thrown ?? new Error('unused')); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (const event of this.events) yield event;
    if (this.thrown) throw this.thrown;
  }
}

class SendThenThrowMembrane extends OptionsMembrane {
  constructor(private readonly scripts: Array<{ events: StreamEvent[]; thrown: Error | null }>) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    const script = this.scripts.shift();
    if (!script) return super.streamYielding(request, options);
    this.streamOptions.push(options);
    return new SendThenThrowStream(script.events, script.thrown);
  }
}

const answer = (text: string) => ({ type: 'complete', response: createMockResponse([{ type: 'text', text }]) }) as unknown as StreamEvent;
const accelerationLimit = () => err({ type: 'rate_limit', retryable: true, httpStatus: 429, message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute" });

function afterTurn(fw: AgentFramework, events: Array<{ type: string }>) {
  const rows = fw.queryInferenceLogs({ agentName: 'resident' }).entries.map((e) => e.entry as { success?: boolean });
  const messages = fw.getAgent('resident')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string; text?: string }> }>;
  return {
    types: events.map((e) => e.type),
    failedRows: rows.filter((r) => r.success === false).length,
    markers: messages.filter((m) => m.content.some((c) => c.type === 'text' && (c.text ?? '').startsWith('[inference-failed]'))).length,
    held: (fw.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { cooldownReason: string | null } }> })
      .agents.find((agent) => agent.name === 'resident')!.providerAdmission.cooldownReason !== null,
  };
}

async function laterEventLines<T>(t: TestContext, run: () => Promise<T>, naming = 'which decided its turn'): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[stream] ') && line.includes(naming)) lines.push(line);
    else original(...args);
  };
  t.after(() => { console.error = original; });
  try { return { result: await run(), lines }; } finally { console.error = original; }
}

for (const [what, thrown] of [
  ['a retryable 529', () => err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error after the answer' })],
  ['a plain Error', () => new Error('zz iterator fault after the answer')],
] as const) {
  test(`${what} a stream throws after its answer decides nothing: no failure, no [inference-failed] line, no failed log row, no retry; one line names it`, async (t: TestContext) => {
    const membrane = new SendThenThrowMembrane([{ events: [answer('zz-answered')], thrown: thrown() }]);
    const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
    const events = traceOf(fw);
    const { lines } = await laterEventLines(t, async () => {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
      await idle(fw);
    });
    const left = afterTurn(fw, events);
    assert.equal(membrane.streamOptions.length, 1, 'no retry');
    assert.ok(left.types.includes('inference:completed'), 'the answer stood');
    assert.deepEqual(left.types.filter((x) => ['inference:failed', 'inference:exhausted', 'inference:waiting'].includes(x)), [], 'nothing after the answer decided the turn');
    assert.equal(left.failedRows, 0, 'no failed log row');
    assert.equal(left.markers, 0, 'no [inference-failed] line after the answer');
    assert.equal(lines.length, 1, 'one line names the throw');
    assert.match(lines[0]!, /^\[stream\] resident: the stream threw after its complete event/);
  });
}

class RejectAfterAnswerStream extends ErrorStream {
  constructor(private readonly thrown: Error) { super(thrown); }
  override [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    let pulls = 0;
    return {
      next: async () => {
        pulls++;
        if (pulls === 1) return { value: answer('zz-answered'), done: false };
        throw this.thrown;
      },
    };
  }
}

class RejectAfterAnswerMembrane extends OptionsMembrane {
  streams: RejectAfterAnswerStream[] = [];
  constructor(private readonly cancelThrows: boolean) { super(); }
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    if (this.streams.length > 0) return super.streamYielding(request, options);
    this.streamOptions.push(options);
    const stream = new RejectAfterAnswerStream(new Error('zz iterator fault after the answer'));
    if (this.cancelThrows) stream.cancel = () => { stream.isCancelled = true; throw new Error('zz cancel fault'); };
    this.streams.push(stream);
    return stream;
  }
}

for (const cancelThrows of [false, true]) {
  test(`a stream whose next() rejects after its answer is cancelled${cancelThrows ? ', and a cancel() that throws is said' : ''}`, async (t: TestContext) => {
    const membrane = new RejectAfterAnswerMembrane(cancelThrows);
    const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
    const events = traceOf(fw);
    const { lines } = await laterEventLines(t, async () => {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
      await idle(fw);
    }, 'resident: ');
    assert.equal(membrane.streams[0]?.isCancelled, true, 'the stream that threw was cancelled');
    assert.ok(events.some((e) => e.type === 'inference:completed'), 'the answer stood');
    assert.equal(membrane.streamOptions.length, 1, 'no retry');
    assert.match(lines[0] ?? '', /the stream threw after its complete event/);
    assert.equal(lines.filter((l) => l.includes('cancelling the stream that threw failed')).length, cancelThrows ? 1 : 0, 'a cancel that throws is said');
  });
}

for (const [what, type, later] of [
  ['a retryable error event', 'error', () => ({ type: 'error', error: err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error after the answer' }) })],
  ['an aborted event', 'aborted', () => ({ type: 'aborted', reason: 'error' })],
  ['a second complete event', 'complete', () => answer('zz-a-second-answer')],
  ['a tokens event', 'tokens', () => ({ type: 'tokens', content: 'zz-late-text', meta: { type: 'text', visible: true, blockIndex: 0 } })],
] as const) {
  test(`${what} a stream sends after its answer decides nothing: the turn ends as the answer alone ends it, and one line names it`, async (t: TestContext) => {
    const run = async (events: StreamEvent[]) => {
      const membrane = new SendThenThrowMembrane([{ events, thrown: null }]);
      const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
      const trace = traceOf(fw);
      const { lines } = await laterEventLines(t, async () => {
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
        await idle(fw);
      });
      return { left: { ...afterTurn(fw, trace), sends: membrane.streamOptions.length }, lines };
    };
    const withLater = await run([answer('zz-answered'), later() as unknown as StreamEvent, later() as unknown as StreamEvent]);
    const answerAlone = await run([answer('zz-answered')]);
    assert.deepEqual(withLater.left, answerAlone.left, 'the same trace, sends, log rows and [inference-failed] lines as the answer alone');
    assert.equal(answerAlone.lines.length, 0);
    assert.equal(withLater.lines.length, 1, 'one line, naming the first later event');
    assert.ok(withLater.lines[0]!.startsWith(`[stream] resident: the stream sent an event (${type}) after its complete event`), withLater.lines[0]);
  });
}

class AnswerThenToolCallsStream extends ErrorStream {
  private gotResults!: () => void;
  private readonly results = new Promise<void>((r) => { this.gotResults = r; });
  constructor() { super(new Error('unused')); }
  override provideToolResults(): void { this.gotResults(); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield answer('zz-answered');
    yield { type: 'tool-calls', calls: [{ id: 'zz-late-call', name: 'zz_tool', input: {} }], context: { rawText: '', preamble: '' } } as unknown as StreamEvent;
    await this.results;
  }
}

test("tool calls a stream sends after its answer, holding its iterator for their results, don't keep the turn from finishing", async (t: TestContext) => {
  class AnswerThenToolCalls extends OptionsMembrane {
    override streamYielding(_request: NormalizedRequest, options?: unknown): YieldingStream {
      this.streamOptions.push(options);
      return new AnswerThenToolCallsStream();
    }
  }
  const membrane = new AnswerThenToolCalls();
  const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
  const events = traceOf(fw);
  const { lines } = await laterEventLines(t, async () => {
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
    await idle(fw, 10_000);
  });
  assert.ok(events.some((e) => e.type === 'inference:completed'), 'the answer stood');
  assert.equal(events.some((e) => e.type === 'inference:tool_calls_yielded'), false, 'the later tool calls ran nothing');
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith('[stream] resident: the stream sent an event (tool-calls) after its complete event'), lines[0]);
});

test('an acceleration 429 a stream throws after its answer installs no hold', async (t: TestContext) => {
  const membrane = new SendThenThrowMembrane([{ events: [answer('zz-answered')], thrown: accelerationLimit() }]);
  const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
  const events = traceOf(fw);
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  const left = afterTurn(fw, events);
  assert.equal(left.held, false, 'no hold');
  assert.equal(membrane.streamOptions.length, 1, 'no second send');
  assert.equal(left.types.includes('inference:failed'), false);
  assert.equal(left.failedRows, 0, 'no failed log row');
});

test("a throw after a retryable error event gives that error's one retry, not a second", async (t: TestContext) => {
  const membrane = new SendThenThrowMembrane([{
    events: [{ type: 'error', error: err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error' }) } as StreamEvent],
    thrown: err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error thrown after the event' }),
  }]);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-after-retry' }]));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'zz-a-second-retry' }]));
  const policy = recordingPolicy();
  const fw = await makeFramework(t, membrane, policy);
  const events = traceOf(fw);
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
  await idle(fw);
  assert.equal(policy.asked.length, 1, "the policy was asked about the error event's failure only");
  assert.equal(events.filter((e) => e.type === 'inference:failed').length, 1);
  assert.equal(events.filter((e) => e.type === 'inference:completed').length, 1, 'one retry, which answered');
});

for (const [what, type, terminal] of [
  ['a non-retryable error event', 'error', () => ({ type: 'error', error: err({ type: 'invalid_request', retryable: false, httpStatus: 400, message: 'zz bad request' }) })],
  ['an aborted event no stop asked for', 'aborted', () => ({ type: 'aborted', reason: 'error' })],
] as const) {
  test(`after ${what}, a throw or a later event decides nothing more: the turn ends as that event alone ends it`, async (t: TestContext) => {
    const run = async (script: { events: StreamEvent[]; thrown: Error | null }) => {
      const membrane = new SendThenThrowMembrane([script]);
      const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
      const events = traceOf(fw);
      const { lines } = await laterEventLines(t, async () => {
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
        await idle(fw);
      });
      return { left: { ...afterTurn(fw, events), sends: membrane.streamOptions.length }, lines };
    };
    const first = () => terminal() as unknown as StreamEvent;
    const thrownAfter = await run({ events: [first()], thrown: err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error thrown after the event' }) });
    const laterAfter = await run({ events: [first(), answer('zz-a-late-answer')], thrown: null });
    const eventAlone = await run({ events: [first()], thrown: null });
    assert.equal(eventAlone.left.types.filter((x) => x === 'inference:exhausted').length, 1, 'the control: the event alone ends the turn');
    assert.deepEqual(thrownAfter.left, eventAlone.left, 'a throw after it: the same trace, log rows and [inference-failed] lines as the event alone');
    assert.deepEqual(laterAfter.left, eventAlone.left, 'a later complete after it: the same as the event alone');
    assert.ok(thrownAfter.lines.length === 1 && thrownAfter.lines[0]!.startsWith(`[stream] resident: the stream threw after its ${type} event`), String(thrownAfter.lines));
    assert.ok(laterAfter.lines.length === 1 && laterAfter.lines[0]!.startsWith(`[stream] resident: the stream sent an event (complete) after its ${type} event`), String(laterAfter.lines));
  });
}

class ThrowAfterCancelStream extends ErrorStream {
  private cancelled!: () => void;
  private readonly whenCancelled = new Promise<void>((r) => { this.cancelled = r; });
  constructor() { super(new Error('unused')); }
  override cancel(): void { super.cancel(); this.cancelled(); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await this.whenCancelled;
    throw err({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error after the cancel' });
  }
}

test('a retryable 529 thrown after a stop cancelled the stream ends the turn as the stop, with no retry', async (t: TestContext) => {
  class CancelThenThrow extends OptionsMembrane {
    override streamYielding(_request: NormalizedRequest, options?: unknown): YieldingStream {
      this.streamOptions.push(options);
      return new ThrowAfterCancelStream();
    }
  }
  const membrane = new CancelThenThrow();
  const fw = await makeFramework(t, membrane, new DefaultErrorPolicy(scaled(20)));
  const events = traceOf(fw);
  fw.onTrace((e) => { if (e.type === 'inference:started') setTimeout(() => fw.abortInference('resident', 'zz-stop'), 50); });
  const { lines } = await laterEventLines(t, async () => {
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} });
    await idle(fw);
  }, 'taken as its error event');
  assert.equal(membrane.streamOptions.length, 1, 'no retry');
  assert.ok(events.some((e) => e.type === 'inference:aborted'), 'it ended as the stop');
  assert.equal(lines.length, 1, 'one line names the thrown failure');
  assert.match(lines[0]!, /overloaded_error after the cancel/);
  assert.deepEqual(events.filter((e) => ['inference:waiting', 'inference:exhausted', 'inference:failed'].includes(e.type)).map((e) => e.type), []);
});
