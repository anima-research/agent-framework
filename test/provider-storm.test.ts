/**
 * Capacity storms: an overloaded error (HTTP 529) on a turn call holds every
 * agent on that model, each released at its own point on a schedule stepped
 * once a round, until a call on the model answers.
 *
 * Unit cases drive ProviderStorms; framework cases drive a real
 * AgentFramework whose membrane answers turn calls on an overloaded model
 * with classified 529s.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, FrameworkConfig, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { ProviderStorms, STORM_LAPSE_MS, type ProviderStorm } from '../src/provider-storm.js';

/** Storm settings for a test: the overloaded class's steps from `firstMs`,
 *  doubling, at most `maxMs`. */
const stepsOf = (firstMs: number, maxMs: number) => ({
  overloaded: { maxAttempts: null, firstDelayMs: firstMs, multiplier: 2, maxDelayMs: maxMs, statedWaitCeilingMs: null },
});
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

describe('ProviderStorms', () => {
  const storms = (random = 0.5) => {
    const s = new ProviderStorms();
    s.random = () => random;
    return s;
  };

  it('a first 529 arms a storm at the first step, and each agent is released in the step\'s second half', () => {
    const s = storms(0);
    const { storm, change } = s.failed('zz-model', undefined, 'zz overloaded', 1_000)!;
    assert.equal(change, 'armed');
    assert.equal(storm.stepMs, 10_000);
    assert.equal(storm.since, 1_000, 'since the arming failure');
    assert.equal(storm.stepStartedAt, 1_000);
    assert.equal(s.holdUntil('a', 'zz-model', 1_000), 6_000, 'random 0: the middle of the step');
    s.random = () => 1;
    assert.equal(s.holdUntil('b', 'zz-model', 1_000), 11_000, 'random 1: its end');
    assert.equal(s.holdUntil('a', 'zz-model', 1_000), 6_000, "an agent's point is kept for the round");
    assert.equal(s.holdUntil('a', 'zz-model', 6_000), undefined, 'at its point it may call');
    assert.equal(s.holdUntil('a', 'zz-other', 1_000), undefined, 'another model has no storm');
  });

  it("one round's 529s from several agents step it once; a call sent before the step joins", () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    s.failed('zz-model', undefined, 'zz', 1);
    assert.equal(s.holdUntil('a', 'zz-model', 0), 7_500, "a's point in the first step");
    const round = s.sent('zz-model', 0);
    assert.equal(s.get('zz-model', 0)!.stepMs, 10_000, 'a call sent before the storm joins it');
    assert.equal(s.failed('zz-model', round, 'zz', 7_000)!.change, 'advanced');
    assert.equal(s.failed('zz-model', round, 'zz', 7_001)!.change, 'joined', 'the same round, sent before the step');
    assert.equal(s.failed('zz-model', round, 'zz later words', 7_002)!.change, 'joined');
    assert.equal(s.get('zz-model', 0)!.stepMs, 20_000);
    assert.equal(s.get('zz-model', 0)!.stepStartedAt, 7_000);
    assert.equal(s.holdUntil('a', 'zz-model', 7_000), 22_000, 'the step takes every point again, in its own second half');
    assert.equal(s.get('zz-model', 0)!.since, 0, 'a step keeps when the storm began');
    assert.equal(s.get('zz-model', 0)!.reason, 'zz later words', "the latest failure's words");
  });

  it('the step doubles up to the maximum', () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    const steps: number[] = [];
    for (let i = 0; i < 8; i++) steps.push(s.failed('zz-model', s.sent('zz-model', 0), 'zz', i)!.storm.stepMs);
    assert.deepEqual(steps, [20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000]);
  });

  it("steps are the retry decision's overloaded steps on the storm's settings, with no attempt bound", () => {
    const s = storms();
    // Membrane's own overloaded schedule bounds a call's tries; a storm holds
    // rather than gives up, so its steps go on past that bound.
    s.settings = { overloaded: { ...stepsOf(1_000, 8_000).overloaded, maxAttempts: 2 } };
    const first = s.failed('zz-model', undefined, 'zz', 0)!.storm;
    assert.equal(first.step, 1);
    assert.equal(first.stepMs, 1_000);
    const steps: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      const { storm } = s.failed('zz-model', s.sent('zz-model', 0), 'zz', i)!;
      steps.push([storm.step, storm.stepMs]);
    }
    assert.deepEqual(steps, [[2, 2_000], [3, 4_000], [4, 8_000], [5, 8_000], [6, 8_000]]);
  });

  it("an agent's point is the decision's equal jitter: a whole millisecond in the step's second half", () => {
    const s = storms(1 / 3);
    s.settings = stepsOf(1_000, 8_000);
    s.failed('zz-model', undefined, 'zz', 100);
    // floor(500 + 500/3): 666, not 666.67.
    assert.equal(s.holdUntil('a', 'zz-model', 100), 766);
  });

  it('a step takes every point again in the new step', () => {
    const s = storms(0);
    s.failed('zz-model', undefined, 'zz', 0);
    assert.equal(s.holdUntil('a', 'zz-model', 0), 5_000);
    s.failed('zz-model', s.sent('zz-model', 0), 'zz', 5_000);
    assert.equal(s.holdUntil('a', 'zz-model', 5_000), 15_000, 'held again, in the second half of the new step');
  });

  it("a success ends the storm; a call sent in it arms nothing after, and never steps the next storm", () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    const old = s.sent('zz-model', 0);
    assert.ok(s.succeeded('zz-model', 0));
    assert.equal(s.get('zz-model', 0), undefined);
    const afterEnd = s.sent('zz-model', 0);
    assert.notEqual(afterEnd, undefined, "the storm's end takes a round of its own");
    assert.notEqual(afterEnd, old);
    assert.equal(s.holdUntil('a', 'zz-model', 0), undefined);
    assert.equal(s.failed('zz-model', old, 'zz', 10), undefined, 'sent in the storm that ended: arms nothing');
    assert.equal(s.failed('zz-model', undefined, 'zz', 10), undefined, 'sent before that storm armed: arms nothing');
    assert.equal(s.get('zz-model', 0), undefined);
    assert.equal(s.failed('zz-model', afterEnd, 'zz', 11)!.change, 'armed', 'a call sent since the end arms one');
    assert.equal(s.failed('zz-model', old, 'zz', 12)!.change, 'joined', "an earlier storm's round is not this one's");
    assert.equal(s.failed('zz-model', undefined, 'zz', 13)!.change, 'joined', 'nor is one sent before any storm');
  });

  it('clear() forgets storms and the rounds their ends took, as a restart does', () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    s.succeeded('zz-model', 0);
    assert.notEqual(s.sent('zz-model', 0), undefined);
    s.failed('zz-other', undefined, 'zz', 0);
    s.clear();
    assert.deepEqual(s.list(0), []);
    assert.equal(s.sent('zz-model', 0), undefined);
    assert.equal(s.failed('zz-model', undefined, 'zz', 1)!.change, 'armed', 'a model as it was before any storm');
  });

  it("an operator's release lets the agent call now and reports the point it had", () => {
    const s = storms(0);
    s.failed('zz-model', undefined, 'zz', 0);
    assert.equal(s.holdUntil('a', 'zz-model', 0), 5_000);
    assert.deepEqual(s.release('a', 'zz-model', 100), { until: 5_000 });
    assert.equal(s.holdUntil('a', 'zz-model', 100), undefined);
    assert.equal(s.release('a', 'zz-model', 200), null, 'no longer held: nothing to release');
    assert.equal(s.release('b', 'zz-model', 100), null, 'never held: nothing released');
    assert.deepEqual(s.release('c', 'zz-model', 100, true), { until: undefined },
      'one the framework says is held (a run asleep in the storm) is released, point or none');
    assert.equal(s.holdUntil('c', 'zz-model', 100), undefined, 'and may call now');
    assert.equal(s.holdUntil('b', 'zz-model', 100), 5_000, 'and its point is untouched');
    assert.equal(s.release('a', 'zz-other', 100), null, 'no storm on that model');
  });

  it('a storm nothing steps lapses once its step and the lapse after it have passed: the next 529 arms one from the first step', () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    s.failed('zz-model', s.sent('zz-model', 0), 'zz', 7_000);
    const stepEnd = 7_000 + 20_000;
    assert.equal(s.get('zz-model', stepEnd + STORM_LAPSE_MS - 1)!.step, 2, 'standing until the lapse');
    assert.equal(s.get('zz-model', stepEnd + STORM_LAPSE_MS), undefined, 'lapsed');
    assert.deepEqual(s.list(stepEnd + STORM_LAPSE_MS), []);
    const at = stepEnd + STORM_LAPSE_MS + 1_000;
    const { storm, change } = s.failed('zz-model', s.sent('zz-model', at), 'zz again', at)!;
    assert.equal(change, 'armed', 'a call sent after the lapse arms a storm of its own');
    assert.equal(storm.step, 1);
    assert.equal(storm.since, at, 'since its own first 529');
  });

  it('a call sent into a storm keeps it until the lapse after that call: its late 529 still steps it', () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    // Past the step's end, a wake sends at once (its point has passed), in
    // the storm's round.
    const sentAt = 10_000 + 60_000;
    const round = s.sent('zz-model', sentAt);
    assert.notEqual(s.get('zz-model', 10_000 + STORM_LAPSE_MS + 1), undefined, "standing past the lapse after the step's end: a call is out");
    const late = s.failed('zz-model', round, 'zz', sentAt + STORM_LAPSE_MS - 1)!;
    assert.equal(late.change, 'advanced', 'its 529, however late within the lapse, steps the storm');
    assert.equal(late.storm.step, 2);
  });

  it("a lapse ends a storm as an answer does: a call sent into it arms nothing after", () => {
    const s = storms();
    s.failed('zz-model', undefined, 'zz', 0);
    const round = s.sent('zz-model', 0);
    const after = 10_000 + STORM_LAPSE_MS;
    assert.equal(s.get('zz-model', after), undefined);
    assert.equal(s.failed('zz-model', round, 'zz', after + 1), undefined, "its failure is the error policy's");
    assert.notEqual(s.sent('zz-model', after + 2), round, 'the lapse took a round');
  });

  it('a lapsed storm read first by failed, sent, release or succeeded is gone, its round taken', () => {
    const lapsed = () => {
      const s = storms();
      s.failed('zz-model', undefined, 'zz', 0);
      s.holdUntil('a', 'zz-model', 0);
      return { s, round: s.roundOf('zz-model', 0) };
    };
    const after = 10_000 + STORM_LAPSE_MS;
    let { s, round } = lapsed();
    assert.equal(s.failed('zz-model', round, 'zz', after), undefined, "a 529 sent into it arms nothing: it's the error policy's");
    ({ s, round } = lapsed());
    assert.notEqual(s.sent('zz-model', after), round, 'a call sent after it goes in the round its lapse took');
    ({ s } = lapsed());
    assert.equal(s.release('a', 'zz-model', after, true), null, 'nothing to release');
    ({ s } = lapsed());
    assert.equal(s.succeeded('zz-model', after), undefined, 'no storm for an answer to end');
  });

  it('a lapse takes a round, as an end does: a call sent before the storm armed arms nothing after it', () => {
    const s = storms();
    const before = s.roundOf('zz-model', 0);
    s.failed('zz-model', before, 'zz', 0);
    const stormRound = s.roundOf('zz-model', 0)!;
    const after = 10_000 + STORM_LAPSE_MS;
    assert.equal(s.get('zz-model', after), undefined);
    assert.equal(s.failed('zz-model', before, 'zz', after + 1), undefined, 'its 529 arms nothing: it is the error policy\'s');
    const lapseRound = s.roundOf('zz-model', after + 2);
    assert.ok(lapseRound !== undefined && lapseRound > stormRound, 'the lapse took a round of its own');
  });
});

// ---------------------------------------------------------------------------
// The framework.
// ---------------------------------------------------------------------------

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const agents = (event.metadata as { agents?: string[] } | undefined)?.agents;
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: agents ?? true };
  }
}

/** A stream that reports `error`, once `released` resolves. */
class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error, private readonly released: Promise<void> = Promise.resolve()) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await this.released;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

/** A stream that throws `error` as it is iterated, as a stream itself
 *  throwing does. */
class ThrowingStream extends ErrorStream {
  constructor(private readonly thrown: Error) { super(thrown); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.thrown;
  }
}

const overloaded = (status = 529, retryAfterMs?: number) => new MembraneError({
  type: 'server', retryable: true, httpStatus: status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  message: status === 529 ? 'zz overloaded_error: Overloaded' : 'zz internal server error', rawError: { status },
});

/** Answers a turn call on an overloaded model with a 529, and any other
 *  with text. A turn call names its agent by its system prompt. */
/** A stream whose call is made as it is first read, as membrane's is: until
 *  then it is nothing, and a cancel before it reaches the call made then. */
class SentStream implements YieldingStream {
  private inner: YieldingStream | undefined;
  private cancelled = false;
  constructor(private readonly make: () => YieldingStream) {}
  get isWaitingForTools(): boolean { return this.inner?.isWaitingForTools ?? false; }
  get pendingToolCallIds(): string[] { return this.inner?.pendingToolCallIds ?? []; }
  get toolDepth(): number { return this.inner?.toolDepth ?? 0; }
  get isCancelled(): boolean { return this.cancelled; }
  provideToolResults(...args: Parameters<YieldingStream['provideToolResults']>): void { this.inner?.provideToolResults(...args); }
  cancel(): void { this.cancelled = true; this.inner?.cancel(); }
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.inner = this.make();
    if (this.cancelled) this.inner.cancel();
    return this.inner[Symbol.asyncIterator]();
  }
}

class StormMembrane extends MockMembrane {
  overloaded = new Set<string>();
  /** While set, an overloaded call's error waits for it. */
  gate: Promise<void> | undefined;
  /** A stated wait for the 529s, if any. */
  stated: number | undefined;
  /** Errors for the next turn calls instead, one each, in order. */
  nextErrors: Error[] = [];
  /** Instead of a made stream, for the next turn call, once. */
  nextStream: YieldingStream | undefined;
  /** Where a 529 surfaces: the stream's error event, a throw as the stream
   *  is made, or a throw as it is iterated. */
  site: 'stream' | 'setup' | 'throw' = 'stream';
  turnCalls: Array<{ agent: string; model: string; at: number; ok: boolean }> = [];
  /** The options each call was made with, by method. */
  options: Array<{ method: 'streamYielding' | 'complete' | 'stream'; options: Record<string, unknown> | undefined }> = [];
  auxiliary: NormalizedRequest[] = [];
  auxiliaryFailure: Error | undefined;
  override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    this.calls.push(request);
    this.options.push({ method: 'streamYielding', options: options as Record<string, unknown> | undefined });
    const agent = /zz-agent-([\w-]+)/.exec(JSON.stringify(request.system ?? ''))?.[1] ?? '?';
    const model = request.config.model;
    // A call is sent when its stream is first iterated, as membrane's is: a
    // stream made and then cancelled unread (a turn held after its compile)
    // sends nothing, and isn't counted.
    const sent = (stream: YieldingStream, ok: boolean): YieldingStream => {
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      Object.defineProperty(stream, Symbol.asyncIterator, { configurable: true, value: () => {
        this.turnCalls.push({ agent, model, at: Date.now(), ok });
        return iterate();
      } });
      return stream;
    };
    if (this.nextStream) {
      const stream = this.nextStream;
      this.nextStream = undefined;
      return sent(stream, false);
    }
    const decide = (): Error | undefined => this.nextErrors.shift() ?? (this.overloaded.has(model) ? overloaded(529, this.stated) : undefined);
    const answer = () => new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${agent}` }])]);
    if (this.site === 'setup') {
      const failure = decide();
      if (failure) {
        this.turnCalls.push({ agent, model, at: Date.now(), ok: false });
        throw failure;
      }
      return sent(answer(), true);
    }
    // Otherwise the call is decided as it is sent, at its first read: a
    // stream made and never read (a turn held or deferred after its compile)
    // takes none of the scripted failures.
    return new SentStream(() => {
      const failure = decide();
      this.turnCalls.push({ agent, model, at: Date.now(), ok: !failure });
      if (failure && this.site === 'throw') return new ThrowingStream(failure);
      if (failure) return new ErrorStream(failure, this.gate);
      return answer();
    });
  }
  override async complete(request: NormalizedRequest, options?: unknown): Promise<NormalizedResponse> {
    this.options.push({ method: 'complete', options: options as Record<string, unknown> | undefined });
    this.auxiliary.push(request);
    if (this.auxiliaryFailure) throw this.auxiliaryFailure;
    return createMockResponse([{ type: 'text', text: 'zz-summary' }]);
  }
  /** The non-yielding path, behind Agent.runInference. */
  async stream(request: NormalizedRequest, options?: unknown): Promise<NormalizedResponse> {
    this.calls.push(request);
    this.options.push({ method: 'stream', options: options as Record<string, unknown> | undefined });
    return createMockResponse([{ type: 'text', text: 'zz-direct' }]);
  }
  callsOf(agent: string): Array<{ agent: string; model: string; at: number; ok: boolean }> {
    return this.turnCalls.filter((call) => call.agent === agent);
  }
}

type Internal = {
  providerStorms: ProviderStorms;
  stormSentRounds: WeakMap<object, number | undefined>;
  stormSleepers: Map<string, { model: string; until: number }>;
  activeStreams: Map<string, Promise<void>>;
  retryWaitWakers: Set<() => void>;
  providerAdmissionClosed: boolean;
  waitForRetry(ms: number, checkWindow: { abandoned: boolean; wake?: () => void },
    waiting?: { agent: unknown; reason: 'capacity-storm' | 'retry'; until: number; said: { at: number } }): Promise<void>;
  activeTurnTokens: Map<string, number>;
  providerGates: Map<string, { primaryDepth: number }>;
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number; coalescingSubject?: string }>;
  eventGate: { onInferenceStarted(agentName: string): void; onInferenceResumed(agentName: string): void; onInferenceEnded(agentName: string): void; inferenceDiagnostics(): { inferring: string[] } } | undefined;
  providerStormSucceeded(agent: unknown): void;
  closeHeldContinuationWindow(agentName: string, requests: unknown[], lifecycle: number): void;
  lifecycleGeneration: number;
  providerAccelerationCooldowns: Map<string, { until: number; waitModel?: string; heldRequests: unknown[]; hostHoldError?: Error; emptiedByDrop?: boolean }>;
  failedTurnRetries: WeakSet<object>;
  cancelCoalescedWakes(subject: string): void;
  holdForProviderWait(agent: unknown, wait: unknown, requests: unknown[], failed?: boolean, turnHeld?: boolean): boolean;
  holdForStorm(agent: unknown, trigger?: unknown): boolean;
  holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown, auxiliary?: boolean): boolean;
  dropContinuations(agentName: string, drop: { kind: string; why: string; reason?: string } | null): void;
  releaseProviderAccelerationCooldown(agentName: string): void;
  providerHoldFor(agentName: string, model: string): unknown;
  consecutiveInferenceFailures: Map<string, number>;
  conversationAgentHomes: Map<string, string>;
  ephemeralRuns: Map<string, { stormSleptMs: number; statedUntil?: number }>;
  auxiliaryMembraneFor(agentName: string): { complete(request: unknown, options?: unknown): Promise<unknown> };
  startAgentStream(agent: unknown, trigger?: unknown, ...rest: unknown[]): Promise<void>;
  joinProviderStorm(agent: unknown, error: Error): ProviderStorm | undefined;
  nonOwningProviderWait(agent: unknown, error: Error): unknown;
  waitingTraceEveryMs: number;
  agents: Map<string, { name: string }>;
  deferredMessages: Array<{ content: unknown }>;
  checkAhead: Map<object, unknown>;
  pushCoalescer: unknown;
  disposeConversationAgent(agentName: string): void;
  logicalTurnToolCalls: WeakMap<object, { count: number }>;
  turnCounters: Map<string, number>;
};

/**
 * A copy, by reading, of connectome-host 0.13.0's subagent reaper
 * (src/modules/subagent-module.ts:1364-1371 and :1931-1934): any trace naming
 * the run counts as its activity, `inference:failed` clears its in-flight
 * mark, and a run silent past the threshold with nothing in flight is
 * reclaimed. It leaves out the host's other two conditions (no stream text,
 * no pending tool calls), so at the host's threshold it reclaims whatever the
 * host would and more. The tests give it two of the framework's waiting
 * steps, as 120 s is two of 60 s, plus 400 ms for a loaded test host's
 * timers, so a run it never finds reclaimable said it was waiting at least
 * every two steps and 400 ms. It shows what this copy finds, not what a
 * later host does.
 */
function reaperCopy(fw: AgentFramework, name: string, thresholdMs: number): { reclaimable: () => boolean; stop: () => void } {
  let lastActivityAt = Date.now();
  let inFlight = false;
  let reclaimable = false;
  const unsubscribe = fw.onTrace((event) => {
    if ((event as { agentName?: string }).agentName !== name) return;
    lastActivityAt = Date.now();
    if (event.type === 'inference:started' || event.type === 'inference:stream_resumed') inFlight = true;
    if (event.type === 'inference:tokens' || event.type === 'inference:completed' || event.type === 'inference:failed'
      || event.type === 'inference:tool_calls_yielded') inFlight = false;
  });
  const timer = setInterval(() => {
    if (!inFlight && Date.now() - lastActivityAt > thresholdMs) reclaimable = true;
  }, 20);
  return {
    reclaimable: () => reclaimable,
    stop: () => { clearInterval(timer); unsubscribe(); },
  };
}

function withStoreDir<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'provider-storm-'));
  return Promise.resolve(fn(join(dir, 'store'))).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const STEP_MS = 400;

async function framework(path: string, membrane: StormMembrane, extra: Partial<FrameworkConfig> = {}) {
  const fw = await AgentFramework.create({
    ...extra,
    storePath: path, membrane: membrane.asMembrane(),
    agents: [
      { name: 'a', model: 'zz-model', systemPrompt: 'zz-agent-a' },
      { name: 'b', model: 'zz-model', systemPrompt: 'zz-agent-b' },
      { name: 'c', model: 'zz-other', systemPrompt: 'zz-agent-c' },
    ],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  const internal = fw as unknown as Internal;
  internal.providerStorms.settings = stepsOf(STEP_MS, 4 * STEP_MS);
  internal.providerStorms.random = () => 0.5;
  return { fw, internal };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether a provider hold keeps `name`'s failed turn for its retry. */
function keepsRetry(internal: Internal, name: string): boolean {
  return (internal.providerAccelerationCooldowns.get(name)?.heldRequests ?? []).some((r) => internal.failedTurnRetries.has(r as object));
}

/** The framework's one in-flight runUntilIdle, shared. */
const driving = new WeakMap<AgentFramework, Promise<void>>();
function drive(fw: AgentFramework): Promise<void> {
  let run = driving.get(fw);
  if (!run) {
    run = fw.runUntilIdle().catch(() => {}).finally(() => { driving.delete(fw); });
    driving.set(fw, run);
  }
  return run;
}

/** Poll for `done`, driving the framework, with time only as an outer bound. */
async function waitFor(fw: AgentFramework, done: () => boolean, what: string, boundMs = 10_000): Promise<void> {
  const deadline = performance.now() + boundMs;
  while (!done()) {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`zz-timeout: ${what} did not happen within ${boundMs} ms`);
    void drive(fw);
    await sleep(Math.min(10, left));
  }
}

function silence() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const auxRequest = (model: string) => ({
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-compress' }] }],
  config: { model, maxTokens: 16 },
});

type Health = { providerStorms: Array<{ model: string; stepMs: number; heldAgents: number; since: string; nextRelease: string | null }> };

test("two residents' 529s arm one storm on their model and hold both; a round's 529s step it once; the first answer releases them all", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    // A first step long enough that each comparison with a point has a second
    // or more to spare on a loaded host.
    storms.settings = stepsOf(2_000, 16_000);
    const held = internal.providerAccelerationCooldowns;
    const ended: string[] = [];
    fw.onTrace((event) => { if (event.type === 'inference:exhausted') ended.push(event.agentName); });
    try {
      // Both residents send while nothing is known of a storm; their errors
      // come back together.
      membrane.overloaded.add('zz-model');
      let round = gate();
      membrane.gate = round.promise;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a', 'b', 'c'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1 && membrane.callsOf('b').length === 1
        && membrane.callsOf('c').length === 1, 'all three sent');
      round.open();
      await waitFor(fw, () => held.has('a') && held.has('b'), 'both held');
      const storm = storms.get('zz-model')!;
      assert.ok(storm, 'a storm on zz-model');
      assert.equal(storm.stepMs, 2_000, 'armed by the first 529; the second, sent before the storm, joins it');
      assert.equal(held.get('a')!.waitModel, 'zz-model');
      assert.equal(held.get('b')!.waitModel, 'zz-model');
      assert.equal(storms.get('zz-other'), undefined, "the other model's resident is untouched");
      assert.equal(membrane.callsOf('c')[0]!.ok, true);
      const health = fw.healthSnapshot() as Health;
      assert.deepEqual(health.providerStorms.map((s) => [s.model, s.stepMs, s.heldAgents]), [['zz-model', 2_000, 2]]);
      assert.equal(new Date(health.providerStorms[0]!.since).getTime(), storm.since);
      assert.equal(health.providerStorms[0]!.nextRelease, new Date(storm.releaseAt.get('a')!).toISOString(),
        'the next held agent\'s point (both drew the same)');

      // Each is released at its own point: with the same draw, both probe at
      // once, sent in the same round. Their 529s step the storm once.
      const points = new Map(storm.releaseAt);
      round = gate();
      membrane.gate = round.promise;
      await waitFor(fw, () => membrane.callsOf('a').length === 2 && membrane.callsOf('b').length === 2, 'both probes sent');
      for (const agent of ['a', 'b']) {
        assert.ok(membrane.callsOf(agent)[1]!.at >= points.get(agent)!, `${agent} sent nothing before its point`);
      }
      // The next round's points differ, so the first answer can be seen
      // releasing the other before its own point.
      const draws = [0, 1];
      storms.random = () => draws.shift() ?? 0.5;
      round.open();
      membrane.gate = undefined;
      await waitFor(fw, () => storm.releaseAt.size === 2 && held.has('a') && held.has('b'), 'both held again');
      assert.equal(storm.stepMs, 4_000, "one round's two 529s step it once");
      assert.equal(membrane.turnCalls.filter((call) => call.model === 'zz-model').length, 4, 'nothing else was sent');

      const [first, second] = [...storm.releaseAt].sort((x, y) => x[1] - y[1]);
      membrane.overloaded.delete('zz-model');
      await waitFor(fw, () => membrane.callsOf(second![0]).some((call) => call.ok), 'the later agent answered');
      const answered = membrane.callsOf(second![0]).find((call) => call.ok)!;
      assert.ok(membrane.callsOf(first![0]).some((call) => call.ok), 'the earlier agent answered first');
      assert.ok(answered.at < second![1], `released by the first answer, before its own point (${answered.at} < ${second![1]})`);
      assert.equal(storms.get('zz-model'), undefined, 'the storm is over');
      assert.deepEqual((fw.healthSnapshot() as Health).providerStorms, []);
      assert.deepEqual(ended, [], 'no turn ended');
      assert.equal(internal.consecutiveInferenceFailures.get('a') ?? 0, 0, 'a storm is not a failure streak');
      assert.ok(log.lines.some((line) => /\[provider-storm\] model=zz-model storm armed/.test(line)));
      assert.ok(log.lines.some((line) => /\[provider-storm\] model=zz-model storm stepped/.test(line)));
      assert.ok(log.lines.some((line) => /\[provider-storm\] model=zz-model storm over/.test(line)));
    } finally { await fw.stop(); log.restore(); }
  });
});

async function ephemeralRun(fw: AgentFramework, name: string, model = 'zz-model',
  watchdogs?: { idleTimeoutMs?: number; idlePollMs?: number }) {
  const created = await fw.createEphemeralAgent({ name, model, systemPrompt: `zz-agent-${name}` });
  created.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  const run = fw.runEphemeralToCompletion(created.agent, created.contextManager, watchdogs);
  const outcome = run.then((result) => ({ result }), (error: unknown) => ({ error: error as Error }));
  void drive(fw);
  return { name: created.agent.name, outcome: Promise.race([outcome, sleep(10_000).then(() => ({ error: new Error('zz-unsettled') }))]) };
}

test('an ephemeral run started in a storm sends nothing before its own point, steps nothing, and its answer ends the storm', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(1_000, 4 * STEP_MS);
    try {
      membrane.overloaded.add('zz-model');
      const draws = [1, 0];
      storms.random = () => draws.shift() ?? 0.5;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      const storm = storms.get('zz-model')!;
      const round = storm.round;
      const aPoint = storm.releaseAt.get('a')!;

      membrane.overloaded.delete('zz-model');
      const run = await ephemeralRun(fw, 'eph');
      await waitFor(fw, () => storm.releaseAt.has(run.name), 'the run read the storm');
      const point = storm.releaseAt.get(run.name)!;
      assert.equal(storm.round, round, 'its deferral steps nothing: no call was made');
      assert.equal(storm.stepMs, 1_000);
      assert.equal(storm.reason, 'zz overloaded_error: Overloaded', "the storm keeps the provider's words, not the deferral's");
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const calls = membrane.callsOf('eph');
      assert.equal(calls.length, 1, 'one call, at its point');
      assert.ok(calls[0]!.at >= point, `nothing sent before its point (${calls[0]!.at} >= ${point})`);
      assert.equal(storms.get('zz-model'), undefined, 'its answer ended the storm');
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'a answered');
      assert.ok(membrane.callsOf('a').find((call) => call.ok)!.at < aPoint, 'a was released by the run\'s answer, before its own point');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an ephemeral run sleeps a storm in its turn, not as an error-policy attempt, and ends past its storm allowance, saying why', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      membrane.overloaded.add('zz-model');
      // Four 529s, more than the error policy's three retries, then an answer.
      const sleeps = await ephemeralRun(fw, 'eph-sleeps');
      await waitFor(fw, () => membrane.callsOf('eph-sleeps').length === 4, 'four 529s');
      membrane.overloaded.delete('zz-model');
      const slept = await sleeps.outcome;
      assert.ok('result' in slept, `the run completes${'error' in slept ? `: ${slept.error.message}` : ''}`);
      assert.equal(membrane.callsOf('eph-sleeps').length, 5);

      // Storm sleeps leave the error policy's attempts as they were: a 500
      // after three of them is still retried.
      membrane.nextErrors = [overloaded(), overloaded(), overloaded(), overloaded(500)];
      const mixed = await ephemeralRun(fw, 'eph-mixed');
      const after = await mixed.outcome;
      assert.ok('result' in after, `the run completes${'error' in after ? `: ${after.error.message}` : ''}`);
      assert.equal(membrane.callsOf('eph-mixed').length, 5, 'three storm sleeps, the 500 retried, then the answer');

      // A run whose storm sleeps already come close to the allowance sleeps
      // its first storm point (300 ms) and ends at its second 529, whose
      // point (600 ms more) would take it past.
      membrane.overloaded.add('zz-model');
      const open = gate();
      membrane.gate = open.promise;
      const ends = await ephemeralRun(fw, 'eph-ends');
      await waitFor(fw, () => membrane.callsOf('eph-ends').length === 1 && internal.ephemeralRuns.has(ends.name), 'its call sent');
      internal.ephemeralRuns.get(ends.name)!.stormSleptMs = 600_000 - 700;
      open.open();
      const ended = await ends.outcome;
      assert.ok('error' in ended, 'the run ends');
      assert.match(ended.error.message, /^zz-model has answered turn calls with overloaded errors \(529\) since \S+\. This ephemeral run has slept \d+ s in capacity storms, and a run sleeps at most 600 s in them, so it ends now; it can be run again once the model answers\. The provider said: zz overloaded_error: Overloaded$/);
      assert.equal(membrane.callsOf('eph-ends').length, 2, 'after one storm sleep, and is not retried');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a conversation agent is held by a storm as a resident is', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const ended: string[] = [];
    fw.onTrace((event) => { if (event.type === 'inference:exhausted') ended.push(event.agentName); });
    try {
      membrane.overloaded.add('zz-model');
      internal.conversationAgentHomes.set('a', 'world:zz');
      fw.getAgent('a')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-first' }]);
      await internal.startAgentStream(fw.getAgent('a'), { agentName: 'a', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'the hold');
      assert.equal(internal.providerAccelerationCooldowns.get('a')!.waitModel, 'zz-model');
      assert.ok(internal.providerStorms.get('zz-model'), 'its 529 armed the storm');
      assert.equal(membrane.callsOf('a').length, 1, 'no retry in the turn');
      membrane.overloaded.delete('zz-model');
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'its answer after its point');
      assert.deepEqual(ended, []);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a compression call's 529 arms no storm, and a storm doesn't hold compression", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      const aux = internal.auxiliaryMembraneFor('a');
      membrane.auxiliaryFailure = overloaded();
      await assert.rejects(aux.complete(auxRequest('zz-model')), /overloaded_error/);
      assert.equal(internal.providerStorms.get('zz-model'), undefined, 'no storm from compression');

      membrane.auxiliaryFailure = undefined;
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      const before = membrane.auxiliary.length;
      await aux.complete(auxRequest('zz-model'));
      assert.equal(membrane.auxiliary.length, before + 1, 'compression on the stormy model is called');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an operator's release takes an agent out of the storm: it tries at once, and its 529 holds it again and steps the storm", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(10_000, 40_000);
    try {
      membrane.overloaded.add('zz-model');
      storms.random = () => 1;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      const storm = storms.get('zz-model')!;
      const point = storm.releaseAt.get('a')!;
      const receipt = fw.releaseProviderWait('a', undefined, 'zz-operator');
      assert.deepEqual(receipt, [{ model: 'zz-model', until: new Date(point).toISOString(), release: 'storm' }]);
      await waitFor(fw, () => membrane.callsOf('a').length === 2, 'it tries');
      assert.ok(membrane.callsOf('a')[1]!.at < point, 'at once, before its point');
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'held again');
      assert.equal(storm.stepMs, 20_000, 'its call was sent in the round, so its 529 steps it');
      // A release naming another model lifts nothing from this storm, and one
      // of an agent the storm doesn't hold lists nothing.
      assert.deepEqual(fw.releaseProviderWait('a', 'zz-other', 'zz-operator'), []);
      assert.ok(internal.providerAccelerationCooldowns.has('a'), 'a stays held');
      assert.deepEqual(fw.releaseProviderWait('c', undefined, 'zz-operator'), [], 'c, on zz-other, was never held');
      assert.ok(log.lines.some((line) => /\[provider-storm\] agent=a model=zz-model released from the storm by zz-operator/.test(line)));
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a 529 stating a wait longer than the point holds until the wait ends, and records it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      membrane.overloaded.add('zz-model');
      membrane.stated = 5_000;
      const before = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.deepEqual(fw.providerWaitSnapshot('a').map((wait) => wait.model), ['zz-model'], 'the stated wait is recorded');
      assert.ok(internal.providerAccelerationCooldowns.get('a')!.until >= before + 5_000, 'held for the stated wait, the later');
      assert.ok(internal.providerStorms.get('zz-model'), 'and the storm is armed');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a 500 is still the error policy's: retried in the turn, with no storm", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      membrane.nextErrors = [overloaded(500)];
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'the retry answered');
      assert.equal(membrane.callsOf('a').length, 2);
      assert.equal(internal.providerStorms.get('zz-model'), undefined);
      assert.equal(internal.providerAccelerationCooldowns.has('a'), false, 'never held');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a storm past an hour raises one ops alert', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const alerts: Array<{ kind: string; agentName: string; message: string; data?: Record<string, unknown> }> = [];
    fw.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event); });
    (fw as unknown as { logFailure(record: Record<string, unknown>): void }).logFailure = () => {};
    try {
      const agent = fw.getAgent('a');
      internal.joinProviderStorm(agent, overloaded());
      assert.equal(alerts.length, 0, 'a new storm raises none');
      const storm = internal.providerStorms.get('zz-model')!;
      (storm as { since: number }).since = Date.now() - 61 * 60_000;
      internal.joinProviderStorm(agent, overloaded());
      internal.joinProviderStorm(agent, overloaded());
      assert.deepEqual(alerts.map((alert) => [alert.kind, alert.agentName, alert.data?.model]), [['provider-storm', 'a', 'zz-model']]);
      assert.match(alerts[0]!.message, /release-provider-wait/);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a storm nothing steps lapses: health drops it, and a 529 after arms one from the first step, with its own since and no alert', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const alerts: string[] = [];
    fw.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event.kind); });
    (fw as unknown as { logFailure(record: Record<string, unknown>): void }).logFailure = () => {};
    try {
      const agent = fw.getAgent('a');
      const callFails = () => {
        internal.stormSentRounds.set(agent!, internal.providerStorms.sent('zz-model'));
        return internal.joinProviderStorm(agent, overloaded());
      };
      callFails();
      const storm = callFails()!;
      assert.equal(storm.step, 2, 'armed and stepped');
      // Every agent on the model goes quiet: nothing is sent past the step's
      // end and the lapse after it. The storm began over an hour ago.
      const back = storm.stepMs + STORM_LAPSE_MS;
      storm.stepStartedAt -= back;
      storm.lastSentAt -= back;
      (storm as { since: number }).since = Date.now() - 61 * 60_000;
      assert.deepEqual((fw.healthSnapshot() as Health).providerStorms, [], 'health lists no lapsed storm');
      assert.ok(log.lines.some((line) => line.includes('[provider-storm] model=zz-model storm lapsed')), 'the lapse is said');
      const before = Date.now();
      const next = callFails()!;
      const after = Date.now();
      assert.notEqual(next, storm);
      assert.equal(next.step, 1, 'from the first step');
      assert.ok(next.since >= before && next.since <= after, 'since its own first 529');
      assert.deepEqual(alerts, [], "no alert from the lapsed storm's start");
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const site of ['stream', 'setup', 'throw'] as const) {
  test(`a resident's 529 is held by the storm wherever it surfaces (${site})`, async () => {
    await withStoreDir(async (path) => {
      const log = silence();
      const membrane = new StormMembrane();
      membrane.site = site;
      const { fw, internal } = await framework(path, membrane);
      const ended: string[] = [];
      fw.onTrace((event) => { if (event.type === 'inference:exhausted') ended.push(event.agentName); });
      try {
        membrane.overloaded.add('zz-model');
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
        await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
        assert.ok(internal.providerStorms.get('zz-model'), 'armed');
        assert.equal(membrane.callsOf('a').length, 1, 'no retry in the turn');
        membrane.overloaded.delete('zz-model');
        await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'its answer after its point');
        assert.deepEqual(ended, []);
      } finally { await fw.stop(); log.restore(); }
    });
  });
}

test('a turn arriving in a storm is held at admission without a call, and released by the first answer', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(4_000, 16_000);
    try {
      membrane.overloaded.add('zz-model');
      const draws = [0, 1];
      storms.random = () => draws.shift() ?? 0.5;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-for-b', metadata: { agents: ['b'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('b'), 'b held');
      assert.equal(membrane.callsOf('b').length, 0, 'b sent nothing into the storm');
      assert.ok(!log.lines.some((line) => /agent=b .*binds at admission/.test(line)),
        "held by the scheduler, before its turn started, not at the turn's last check");
      assert.equal(internal.providerAccelerationCooldowns.get('b')!.waitModel, 'zz-model');
      // An answer on another model leaves this one's storm.
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-for-c', metadata: { agents: ['c'] } });
      await waitFor(fw, () => membrane.callsOf('c').some((call) => call.ok), 'c answered on zz-other');
      assert.ok(storms.get('zz-model'), "c's answer on zz-other doesn't end zz-model's storm");
      assert.ok(internal.providerAccelerationCooldowns.has('b'), 'and b stays held');
      const bPoint = storms.get('zz-model')!.releaseAt.get('b')!;
      membrane.overloaded.delete('zz-model');
      await waitFor(fw, () => membrane.callsOf('b').some((call) => call.ok), 'b answered');
      assert.ok(membrane.callsOf('b')[0]!.at < bPoint, "released by a's answer, before its own point");
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an agent not yet released when a probe steps the storm is held again under the next step', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(2_000, 16_000);
    try {
      membrane.overloaded.add('zz-model');
      const round = gate();
      membrane.gate = round.promise;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a', 'b'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1 && membrane.callsOf('b').length === 1, 'both sent');
      // a's point is the middle of the step, b's its end.
      const draws = [0, 1];
      storms.random = () => draws.shift() ?? 0.5;
      round.open();
      membrane.gate = undefined;
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a') && internal.providerAccelerationCooldowns.has('b'), 'both held');
      const storm = storms.get('zz-model')!;
      const [first, second] = [...storm.releaseAt].sort((x, y) => x[1] - y[1]);
      storms.random = () => 1;
      // The first probes at its point, and its 529 steps the storm.
      await waitFor(fw, () => storm.stepMs === 4_000, 'the first probe stepped it');
      const steppedAt = storm.stepStartedAt;
      assert.ok(internal.providerAccelerationCooldowns.get(second![0])!.until >= steppedAt + 2_000,
        'the step moved its hold to its point in the new step at once');
      assert.ok(steppedAt < second![1], 'before the second agent\'s point');
      // The second agent's old point passes, and it stays held: a timer left
      // at that point would have released its hold by a second past it.
      await sleep(Math.max(0, second![1] - Date.now()) + 1_000);
      assert.ok(internal.providerAccelerationCooldowns.has(second![0]), 'its hold stands past its old point');
      assert.equal(membrane.callsOf(second![0]).length, 1, 'held again: nothing sent at its old point');
      assert.ok(internal.providerAccelerationCooldowns.get(second![0])!.until >= steppedAt + 2_000, 'until its point in the next step');
      assert.equal(membrane.callsOf(first![0]).length, 2);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a 529 whose call was sent before the step, with its point in this round passed, goes back to the scheduler and tries again at once", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    // An error policy that never retries: only the storm can try again.
    const { fw, internal } = await framework(path, membrane, { errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } });
    const storms = internal.providerStorms;
    try {
      // A storm armed in round r: b sends in it, and its error waits.
      internal.joinProviderStorm(fw.getAgent('a'), overloaded());
      const storm = storms.get('zz-model')!;
      storm.stepStartedAt -= 10_000;
      membrane.overloaded.add('zz-model');
      const round = gate();
      membrane.gate = round.promise;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['b'] } });
      await waitFor(fw, () => membrane.callsOf('b').length === 1, 'b sent, its point having passed');
      // a probe of the round steps the storm, and the new step, too, is long past.
      internal.stormSentRounds.set(fw.getAgent('a')!, storm.round);
      internal.joinProviderStorm(fw.getAgent('a'), overloaded());
      storm.stepStartedAt -= 10_000;
      membrane.overloaded.delete('zz-model');
      round.open();
      membrane.gate = undefined;
      // b's 529 joins, its point in this round has passed, and it tries again at once.
      await waitFor(fw, () => membrane.callsOf('b').some((call) => call.ok), 'b answered');
      assert.equal(membrane.callsOf('b').length, 2);
      assert.equal(storm.stepMs, 2 * STEP_MS, "b's 529 joined: it stepped nothing");
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A stream whose first round calls a tool, and whose second, sent with the
 *  tool's result, answers with `error`. `beforeToolCalls` runs before the
 *  first round reports its call. */
class ToolThenErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  private resumed: (() => void) | undefined;
  constructor(private readonly error: Error, private readonly beforeToolCalls: () => void) {}
  provideToolResults(): void {
    this.isWaitingForTools = false;
    this.pendingToolCallIds = [];
    this.toolDepth++;
    this.resumed?.();
  }
  cancel(): void { this.isCancelled = true; this.resumed?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.beforeToolCalls();
    const resumed = new Promise<void>((resolve) => { this.resumed = resolve; });
    this.isWaitingForTools = true;
    this.pendingToolCallIds = ['zz-call'];
    yield {
      type: 'tool-calls',
      calls: [{ id: 'zz-call', name: 'zz-tool', input: {} }],
      context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
        roundContent: [{ type: 'tool_use', id: 'zz-call', name: 'zz-tool', input: {} }] },
    } as StreamEvent;
    await resumed;
    if (this.isCancelled) return;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

test("an ephemeral run's retry after a storm's sleep goes on with its turn: the turn's tool count and its one checkpoint", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const seen: Array<{ tools: number | undefined; checkpoints: number | undefined }> = [];
    let internal!: Internal;
    class Watching extends StormMembrane {
      override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
        const stream = super.streamYielding(request, options);
        if (!/zz-agent-eph/.test(JSON.stringify(request.system ?? ''))) return stream;
        // Read as each call is sent: a retry's compile a deferral stands in
        // for sends nothing.
        const agent = [...internal.agents.values()].find((a) => a.name.includes('eph'))!;
        const state = { tools: internal.logicalTurnToolCalls.get(agent)?.count, checkpoints: internal.turnCounters.get(agent.name) };
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        Object.defineProperty(stream, Symbol.asyncIterator, { configurable: true, value: () => { seen.push(state); return iterate(); } });
        return stream;
      }
    }
    const membrane = new Watching();
    const made = await framework(path, membrane);
    const fw = made.fw;
    internal = made.internal;
    try {
      // Its first call runs a tool round, and the resend's 529 arms a storm:
      // the run sleeps to its point and retries.
      membrane.nextStream = new ToolThenErrorStream(overloaded(), () => {});
      const run = await ephemeralRun(fw, 'eph');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.equal(seen.length, 2, 'its call and the retry after the sleep');
      assert.deepEqual(seen[0], { tools: 0, checkpoints: 1 }, 'the turn began at its first call');
      assert.deepEqual(seen[1], { tools: 1, checkpoints: 1 }, "the retry keeps the turn's tool round and takes no checkpoint of its own");
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an ephemeral run's retry after a storm's sleep at its start, its call refused as it was made, goes on with its turn: no checkpoint of its own", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const checkpoints: Array<number | undefined> = [];
    let internal!: Internal;
    class Watching extends StormMembrane {
      override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
        if (!/zz-agent-eph/.test(JSON.stringify(request.system ?? ''))) return super.streamYielding(request, options);
        // Read as each call is sent: as it is made, when it fails there, or
        // else at its first read.
        const agent = [...internal.agents.values()].find((a) => a.name.includes('eph'))!;
        const at = internal.turnCounters.get(agent.name);
        let stream: YieldingStream;
        try { stream = super.streamYielding(request, options); } catch (error) { checkpoints.push(at); throw error; }
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        Object.defineProperty(stream, Symbol.asyncIterator, { configurable: true, value: () => { checkpoints.push(at); return iterate(); } });
        return stream;
      }
    }
    const membrane = new Watching();
    const made = await framework(path, membrane);
    const fw = made.fw;
    internal = made.internal;
    try {
      membrane.site = 'setup';
      membrane.nextErrors = [overloaded()];
      const run = await ephemeralRun(fw, 'eph');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.deepEqual(checkpoints, [1, 1], 'its call, then the retry after the sleep, with the one checkpoint its turn took');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a resident's turn a storm held starts again as a held turn does: its own checkpoint, and a message deferred while its call was out in its compile", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const answered: string[] = [];
    const checkpoints: Array<number | undefined> = [];
    let internal!: Internal;
    class Watching extends StormMembrane {
      override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
        if (/zz-agent-a/.test(JSON.stringify(request.system ?? ''))) {
          checkpoints.push(internal.turnCounters.get('a'));
          if (!this.overloaded.has(request.config.model)) answered.push(JSON.stringify(request.messages));
        }
        return super.streamYielding(request, options);
      }
    }
    const membrane = new Watching();
    const made = await framework(path, membrane);
    const fw = made.fw;
    internal = made.internal;
    try {
      const out = gate();
      membrane.gate = out.promise;
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, "a's call out");
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-while-out', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.deferredMessages.some((m) => JSON.stringify(m.content).includes('zz-while-out')), 'the message deferred while the call was out');
      out.open();
      await waitFor(fw, () => keepsRetry(internal, 'a'), "the storm holds a's turn for its retry");
      membrane.gate = undefined;
      membrane.overloaded.delete('zz-model');
      await waitFor(fw, () => answered.length > 0, 'the retry was made');
      assert.ok(answered[0]!.includes('zz-while-out'), "the retry's compile reads the message deferred while the call was out");
      assert.deepEqual(checkpoints, [1, 2], 'the retry took a checkpoint of its own, as a start the scheduler makes does');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a resident's held retry assembles the batch of a wake merged into it, pending in the coalescer, and compiles what it renders", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const answered: string[] = [];
    class Watching extends StormMembrane {
      override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
        if (/zz-agent-a/.test(JSON.stringify(request.system ?? '')) && !this.overloaded.has(request.config.model)) answered.push(JSON.stringify(request.messages));
        return super.streamYielding(request, options);
      }
    }
    const membrane = new Watching();
    const { fw, internal } = await framework(path, membrane);
    // A long step, so the hold stands until the test ends the storm.
    internal.providerStorms.settings = stepsOf(60_000, 60_000);
    // A coalescer holding the batch 'zz-batch' for a once its wake is sent,
    // which renders it into a's context when an assembly for a takes it. A
    // turn whose causes aren't all batches carries no batch subjects (the
    // scheduler's merge), so its start assembles what is pending.
    let pending = false;
    let rendered = 0;
    internal.pushCoalescer = {
      pendingBatches: () => (pending ? 1 : 0),
      isRendering: () => false,
      suspend: () => undefined,
      assemble: async (agentName: string, subjects?: readonly string[]) => {
        if (agentName === 'a' && pending) {
          pending = false;
          rendered++;
          fw.getAgent('a')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-rendered' }]);
          return { settled: new Set(['zz-batch']), materialized: new Set(['zz-batch']) };
        }
        return { settled: new Set(subjects ?? []), materialized: new Set<string>() };
      },
    };
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => keepsRetry(internal, 'a'), "the storm holds a's turn for its retry");
      // The batch's wake arrives during the hold, which holds it beside the retry.
      pending = true;
      internal.pendingRequests.push({ agentName: 'a', reason: 'mcpl-push', source: 'zz-server', timestamp: Date.now(),
        coalescingSubject: 'zz-batch', coalescingBatch: true, coalescingBatchSubjects: ['zz-batch'] } as Internal['pendingRequests'][number]);
      await drive(fw);
      assert.equal(internal.providerAccelerationCooldowns.get('a')?.heldRequests.length, 2, 'held beside the retry');
      membrane.overloaded.delete('zz-model');
      // Another agent's call answers: the storm is over, and a's hold released.
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => answered.length > 0, 'the retry was made');
      assert.equal(rendered, 1, "the retry's start assembled the merged wake's batch");
      assert.ok(answered[0]!.includes('zz-rendered'), 'and its compile reads what the batch rendered');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stop made in the gap after a failed start's hold took its retry, before the start's window closes, ends the held turn", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'a') aborted.push(event.reason); });
    try {
      membrane.site = 'setup';
      membrane.overloaded.add('zz-model');
      // The stop lands a microtask after the hold took the retry: the failed
      // start's window is still set until startAgentStream's finally.
      const hold = internal.holdProviderAcceleration.bind(internal);
      let stopped: boolean | undefined;
      let windowSet: boolean | undefined;
      internal.holdProviderAcceleration = (agent, error, trigger, auxiliary) => {
        const held = hold(agent, error, trigger, auxiliary);
        if (held && stopped === undefined && !auxiliary) {
          queueMicrotask(() => {
            windowSet = internal.checkAhead.has(agent as object);
            stopped = fw.abortInference('a', 'zz-stop');
          });
        }
        return held;
      };
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => stopped !== undefined, 'the stop made');
      assert.equal(windowSet, true, "the failed start's window was still set when the stop came");
      assert.equal(stopped, true);
      assert.equal(keepsRetry(internal, 'a'), false, 'the hold no longer keeps the retry');
      assert.deepEqual(aborted, ['zz-stop'], "the turn ended with the stop's reason");
      membrane.overloaded.delete('zz-model');
      internal.releaseProviderAccelerationCooldown('a');
      await drive(fw);
      assert.equal(membrane.callsOf('a').length, 1, 'nothing ran after the stop');
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A storm on zz-model armed by b, its step ended a while ago, with no call
 *  sent into it since: what a later call does to its lapse shows in
 *  `lastSentAt`. */
function quietStorm(fw: AgentFramework, internal: Internal): ProviderStorm {
  internal.stormSentRounds.set(fw.getAgent('b')!, internal.providerStorms.sent('zz-model'));
  const storm = internal.joinProviderStorm(fw.getAgent('b'), overloaded())!;
  storm.stepStartedAt = Date.now() - storm.stepMs - 60_000;
  storm.lastSentAt = storm.stepStartedAt;
  return storm;
}

test("a compile that sends nothing, failing or stopped after it, doesn't move a storm's lapse", async () => {
  for (const how of ['fails', 'stopped'] as const) {
    await withStoreDir(async (path) => {
      const log = silence();
      const membrane = new StormMembrane();
      const { fw, internal } = await framework(path, membrane, { errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } });
      try {
        const storm = quietStorm(fw, internal);
        const before = storm.lastSentAt;
        const a = fw.getAgent('a') as unknown as { startStreamWithInjections: (...args: unknown[]) => Promise<unknown> };
        const compile = a.startStreamWithInjections.bind(a);
        let compiled = 0;
        a.startStreamWithInjections = async (...args: unknown[]) => {
          compiled++;
          if (how === 'fails') throw new Error('zz-compile');
          // A caller's stop while the compile runs: the check after it takes it.
          fw.abortInference('a', 'zz-stop');
          return compile(...args);
        };
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
        await waitFor(fw, () => compiled > 0 && !internal.activeTurnTokens.has('a'), `a's compile, ${how}, and its turn over`);
        assert.equal(membrane.callsOf('a').length, 0, 'nothing went out');
        assert.equal(storm.lastSentAt, before, `a compile that ${how === 'fails' ? 'fails' : 'is stopped after it'} doesn't move the lapse`);
      } finally { await fw.stop(); log.restore(); }
    });
  }
});

test("an ephemeral run's deferral sends nothing, so it doesn't move a storm's lapse", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      const storm = quietStorm(fw, internal);
      const before = storm.lastSentAt;
      const created = await fw.createEphemeralAgent({ name: 'eph', model: 'zz-model', systemPrompt: 'zz-agent-eph' });
      created.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
      const run = fw.runEphemeralToCompletion(created.agent, created.contextManager);
      run.catch(() => {});
      // A wait the provider stated on the storm still binds the run: its
      // compile is deferred, and nothing is sent.
      internal.ephemeralRuns.get(created.agent.name)!.statedUntil = Date.now() + 60_000;
      void drive(fw);
      await waitFor(fw, () => internal.stormSleepers.has(created.agent.name), 'the run deferred and asleep');
      assert.equal(membrane.callsOf('eph').length, 0, 'nothing went out');
      assert.equal(storm.lastSentAt, before, "the deferral doesn't move the lapse");
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a refusal's re-issue that membrane announces into a storm is a send its lapse counts from", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    let storm: ProviderStorm | undefined;
    let before: number | undefined;
    let after: number | undefined;
    try {
      membrane.nextStream = new ScriptedStream([
        text('zz-first'),
        () => { storm = quietStorm(fw, internal); before = storm.lastSentAt; },
        refusalRetry(),
        () => { after = storm!.lastSentAt; },
        'hold',
      ]);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => after !== undefined, 'the re-issue');
      assert.ok(after! > before!, 'the re-issue moved the lapse');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a call's end, where membrane may or may not resume, doesn't move a storm's lapse", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    let storm: ProviderStorm | undefined;
    let before: number | undefined;
    let after: number | undefined;
    try {
      membrane.nextStream = new ScriptedStream([
        text('zz-first'),
        () => { storm = quietStorm(fw, internal); before = storm.lastSentAt; },
        usage(),
        () => { after = storm!.lastSentAt; },
        'hold',
      ]);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => after !== undefined, "the call's end");
      assert.equal(after, before, "the call's end is a round read");
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a call that goes out into a storm moves its lapse to a full lapse after the send, and its 529 steps it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    try {
      const storm = quietStorm(fw, internal);
      const out = gate();
      membrane.gate = out.promise;
      membrane.overloaded.add('zz-model');
      // a's point has passed: its wake goes out at once, into the storm.
      const oldLapse = storms.lapsesAt(storm);
      const sentAfter = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, "a's call out");
      assert.ok(storm.lastSentAt >= sentAfter, 'the send is recorded');
      assert.ok(storms.lapsesAt(storm) >= sentAfter + storms.lapseMs, 'a full lapse after it');
      assert.equal(storms.get('zz-model', Math.max(oldLapse, sentAfter) + 1), storm, 'standing past the lapse it had before the send');
      out.open();
      await waitFor(fw, () => keepsRetry(internal, 'a'), "a's 529 held its turn");
      assert.equal(storm.step, 2, 'and stepped the storm');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run's stated wait slept past its storm's lapse is charged to its allowance only while the storm stood", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let charged: number | undefined;
    let internal!: Internal;
    class Watching extends StormMembrane {
      override streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
        if (/zz-agent-eph/.test(JSON.stringify(request.system ?? '')) && this.nextErrors.length === 0) {
          charged = [...internal.ephemeralRuns.entries()].find(([name]) => name.includes('eph'))?.[1].stormSleptMs;
        }
        return super.streamYielding(request, options);
      }
    }
    const membrane = new Watching();
    const made = await framework(path, membrane);
    const fw = made.fw;
    internal = made.internal;
    internal.providerStorms.lapseMs = 800;
    try {
      // Its 529 arms a storm (a 400 ms step, so a lapse 1.2 s on) and states
      // 2 s: it sleeps to the stated time, past the lapse, and nothing wakes it
      // there.
      membrane.nextErrors = [overloaded(529, 2_000)];
      const run = await ephemeralRun(fw, 'eph');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      // The storm lapses 1.2 s after it armed (its 400 ms step, then the
      // 800 ms lapse), and the sleep began after the arming.
      assert.ok(charged !== undefined && charged > 0 && charged <= 1_200, `charged while the storm stood, not the whole 2 s (${charged} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run whose step comes after its point has passed is still held to its allowance: past it, the run ends before its stated wait", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    // Steps of 1 ms: each point has passed by the time anything reads it.
    storms.settings = stepsOf(1, 1);
    try {
      membrane.overloaded.add('zz-model');
      membrane.stated = 3_000;
      const run = await ephemeralRun(fw, 'eph');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'the run asleep to its stated wait');
      const entry = internal.ephemeralRuns.get(run.name)!;
      const statedUntil = entry.statedUntil!;
      entry.stormSleptMs = 10 * 60_000 - 100;
      // Another agent's 529 steps the storm: the run's sleep is re-timed, and
      // its point in the new step has passed.
      internal.stormSentRounds.set(fw.getAgent('b')!, storms.sent('zz-model'));
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const outcome = await run.outcome;
      assert.ok('error' in outcome && /a run sleeps at most 600 s/.test(outcome.error.message), `the run ends on its allowance (${'error' in outcome ? outcome.error.message : 'completed'})`);
      assert.ok(Date.now() < statedUntil, 'before its stated wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a conversation agent disposed by a listener of its 529's failure while the framework stops leaves the stop nothing to end", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    let failed = false;
    fw.onTrace((event) => {
      if (event.type === 'inference:aborted' && event.agentName === 'a') aborted.push(event.reason);
      if (event.type === 'inference:failed' && event.agentName === 'a') { failed = true; internal.disposeConversationAgent('a'); }
    });
    try {
      internal.conversationAgentHomes.set('a', 'world:zz');
      membrane.site = 'throw';
      membrane.overloaded.add('zz-model');
      const send = membrane.streamYielding.bind(membrane);
      membrane.streamYielding = (request, options) => {
        const stream = send(request, options);
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        Object.defineProperty(stream, Symbol.asyncIterator, { configurable: true, value: () => {
          internal.providerAdmissionClosed = true;
          return iterate();
        } });
        return stream;
      };
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => failed && !internal.activeTurnTokens.has('a'), 'the failure, and its frame gone');
      internal.providerAdmissionClosed = false;
      await fw.stop();
      assert.ok(!aborted.includes('shutdown'), `the stop ended nothing of the disposed agent (${aborted.join(', ')})`);
    } finally { internal.providerAdmissionClosed = false; await fw.stop(); log.restore(); }
  });
});

test("a tool round's resend is a call of its own: sent after the storm began, its 529 steps it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    try {
      // a's first round answers with a tool call (which ends no storm: there
      // is none yet); another agent's 529 arms one while a's tool runs, and
      // a's resend with the tool's result is answered with a 529.
      let armed = false;
      fw.onTrace((event) => {
        if (event.type === 'inference:tool_calls_yielded' && !armed) {
          armed = true;
          internal.joinProviderStorm(fw.getAgent('b'), overloaded());
        }
      });
      membrane.nextStream = new ToolThenErrorStream(overloaded(), () => {});
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.ok(armed);
      assert.equal(storms.get('zz-model')!.stepMs, 2 * STEP_MS, 'its resend was sent in the round, so its 529 steps it');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a conversation agent's turn is held, sending nothing, when a storm arms while it compiles", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let sent = 0;
    class ArmDuringCompile extends StormMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        internal.joinProviderStorm(fw.getAgent('b'), overloaded());
        const stream = super.streamYielding(request);
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        Object.defineProperty(stream, Symbol.asyncIterator, { value: () => { sent++; return iterate(); } });
        return stream;
      }
    }
    const membrane = new ArmDuringCompile();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.conversationAgentHomes.set('a', 'world:zz');
      fw.getAgent('a')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-first' }]);
      await internal.startAgentStream(fw.getAgent('a'), { agentName: 'a', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'the hold');
      assert.equal(sent, 0, 'its compiled request was never sent');
      assert.equal(internal.providerAccelerationCooldowns.get('a')!.waitModel, 'zz-model');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a retry that reaches the turn's last check without the scheduler is held there by a storm armed meanwhile", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    try {
      // a's first call fails with a 500, which the error policy retries in
      // the turn after 1 s; meanwhile b's 529 arms a storm whose points are
      // further off than that.
      storms.settings = stepsOf(10_000, 10_000);
      storms.random = () => 1;
      membrane.nextErrors = [overloaded(500)];
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, 'a sent');
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), "a's retry held");
      await sleep(200);
      assert.equal(membrane.callsOf('a').length, 1, 'the retry sent nothing into the storm');
      assert.ok(log.lines.some((line) => /agent=a .*binds at admission \(a capacity storm on the model\)/.test(line)));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a resident's turn is held, sending nothing, when a storm arms while it compiles, and leaves nothing open", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let sent = 0;
    let arm = true;
    class ArmDuringCompile extends StormMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        if (arm) { arm = false; internal.joinProviderStorm(fw.getAgent('b'), overloaded()); }
        const stream = super.streamYielding(request);
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        Object.defineProperty(stream, Symbol.asyncIterator, { value: () => { sent++; return iterate(); } });
        return stream;
      }
    }
    const membrane = new ArmDuringCompile();
    const { fw, internal } = await framework(path, membrane, { gate: { config: { policies: [], default: 'skip' } } });
    try {
      fw.getAgent('a')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-hello' }]);
      internal.pendingRequests.push({ agentName: 'a', reason: 'test', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'the hold');
      assert.equal(sent, 0, 'its compiled request was never sent');
      assert.equal(internal.providerStorms.get('zz-model')!.stepMs, STEP_MS, 'and nothing stepped the storm');
      await waitFor(fw, () => !internal.activeTurnTokens.has('a'), 'the start let go of its turn');
      assert.equal(internal.providerGates.get('a')?.primaryDepth ?? 0, 0, 'the primary provider gate is released');
      assert.deepEqual(internal.eventGate!.inferenceDiagnostics().inferring, [], 'no inference left open at the event gate');
      assert.ok(keepsRetry(internal, 'a'), 'the hold keeps the begun turn for its start');
      assert.ok(fw.getHostModeStatus().activeTurnAgents.includes('a'), 'which reads alive');
      await waitFor(fw, () => sent === 1, 'its turn after its point');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a resident whose stream fails as it is made, round after round, steps the storm each time rather than retrying at once', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    membrane.site = 'setup';
    const { fw, internal } = await framework(path, membrane);
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length >= 3, 'three tries');
      // 400 ms, then 800 and 1600: each try was sent in its round, so each
      // 529 stepped the storm, and the third holds a until well after it.
      assert.equal(internal.providerStorms.get('zz-model')!.stepMs, 4 * STEP_MS);
      assert.equal(membrane.callsOf('a').length, 3, 'no retry outside the schedule');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an ephemeral run whose stream throws its 529 while it is read ends with the failure at once', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    membrane.site = 'throw';
    const { fw, internal } = await framework(path, membrane);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-throw');
      const outcome = await run.outcome;
      assert.ok('error' in outcome, 'the run ends');
      assert.equal(outcome.error.message, 'zz overloaded_error: Overloaded', 'with its failure, as before storms');
      assert.equal(membrane.callsOf('eph-throw').length, 1);
      assert.ok(internal.providerStorms.get('zz-model'), 'the 529 still arms the storm');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an ephemeral run whose compile a storm arms during sends nothing until its point", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let arm = true;
    class ArmDuringCompile extends StormMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        if (arm) { arm = false; internal.joinProviderStorm(fw.getAgent('b'), overloaded()); }
        return super.streamYielding(request);
      }
    }
    const membrane = new ArmDuringCompile();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(1_000, 4 * STEP_MS);
    try {
      const run = await ephemeralRun(fw, 'eph-compile');
      await waitFor(fw, () => storms.get('zz-model')?.releaseAt.has(run.name) === true, 'the run read the storm');
      const point = storms.get('zz-model')!.releaseAt.get(run.name)!;
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const calls = membrane.callsOf('eph-compile');
      assert.equal(calls.length, 1, 'the stream its first compile made was never sent');
      assert.ok(calls[0]!.at >= point, `its call came at its point (${calls[0]!.at} >= ${point})`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an ephemeral run asleep in a storm wakes at an operator\'s release, and at the storm\'s end', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(10_000, 10_000);
    try {
      membrane.overloaded.add('zz-model');
      const released = await ephemeralRun(fw, 'eph-released');
      await waitFor(fw, () => internal.stormSleepers.has(released.name), 'asleep in the storm');
      const point = storms.get('zz-model')!.releaseAt.get(released.name)!;
      membrane.overloaded.delete('zz-model');
      assert.deepEqual(fw.releaseProviderWait(released.name, undefined, 'zz-operator').map((r) => r.release), ['storm']);
      const first = await released.outcome;
      assert.ok('result' in first, `the released run completes${'error' in first ? `: ${first.error.message}` : ''}`);
      assert.ok(membrane.callsOf('eph-released')[1]!.at < point, 'at once, not at its point');

      // A new storm; this run sleeps in it, and a resident's answer ends it.
      membrane.overloaded.add('zz-model');
      const woken = await ephemeralRun(fw, 'eph-woken');
      await waitFor(fw, () => internal.stormSleepers.has(woken.name), 'asleep in the new storm');
      const wokenPoint = storms.get('zz-model')!.releaseAt.get(woken.name)!;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.equal(((fw.healthSnapshot() as Health).providerStorms[0]!).heldAgents, 2, 'a held, and the run asleep');
      membrane.overloaded.delete('zz-model');
      fw.releaseProviderWait('a', undefined, 'zz-operator');
      const second = await woken.outcome;
      assert.ok('result' in second, `the woken run completes${'error' in second ? `: ${second.error.message}` : ''}`);
      assert.ok(membrane.callsOf('eph-woken')[1]!.at < wokenPoint, "woken by a's answer, not at its point");
      assert.equal(internal.stormSleepers.size, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A stream whose round answers with a tool call alone, and whose next
 *  round, sent with its result, never answers. */
class ToolThenHeldStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  private resumed: (() => void) | undefined;
  provideToolResults(): void { this.isWaitingForTools = false; this.toolDepth++; }
  cancel(): void { this.isCancelled = true; this.resumed?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    // Membrane ends each provider call with its usage, before the round's
    // tool calls.
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as StreamEvent;
    this.isWaitingForTools = true;
    this.pendingToolCallIds = ['zz-call'];
    yield {
      type: 'tool-calls',
      calls: [{ id: 'zz-call', name: 'zz-tool', input: {} }],
      context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
        roundContent: [{ type: 'tool_use', id: 'zz-call', name: 'zz-tool', input: {} }] },
    } as StreamEvent;
    await new Promise<void>((resolve) => { this.resumed = resolve; });
  }
}

test('an answer with only a tool call ends the storm at its call\'s end', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      membrane.nextStream = new ToolThenHeldStream();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, 'a tried at its point');
      await waitFor(fw, () => internal.providerStorms.get('zz-model') === undefined, 'the tool call ended the storm');
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A stream that answers its first words, waits for `more`, then finishes. */
class GatedAnswerStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly more: Promise<void>) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'block', event: { event: 'block_start', index: 0, block: { type: 'text' } } } as StreamEvent;
    yield { type: 'tokens', content: 'zz-first ', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
    await this.more;
    if (this.isCancelled) return;
    yield { type: 'tokens', content: 'zz-more', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
    yield { type: 'block', event: { event: 'block_complete', index: 0, block: { type: 'text', content: 'zz-first zz-more' } } } as StreamEvent;
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as StreamEvent;
    yield { type: 'complete', response: createMockResponse([{ type: 'text', text: 'zz-first zz-more' }]) } as StreamEvent;
  }
}

test("an answer already under way ends no storm armed after its first words", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const answered: string[] = [];
    fw.onTrace((event) => { if (event.type === 'inference:completed') answered.push(event.agentName); });
    try {
      const more = gate();
      membrane.nextStream = new GatedAnswerStream(more.promise);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      let firstWords = false;
      fw.onTrace((event) => { if (event.type === 'inference:tokens' && event.agentName === 'a') firstWords = true; });
      await waitFor(fw, () => firstWords, "a's first words");
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      more.open();
      await waitFor(fw, () => internal.activeTurnTokens.has('a') === false && answered.includes('a'), "a's turn done");
      assert.ok(internal.providerStorms.get('zz-model'), "the rest of a's answer leaves the storm b's 529 armed");
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a stated wait shorter than the storm point holds to the point; an ephemeral run sleeps a stated wait longer than its point', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    // A stated wait of 1 s, long enough to read back on a loaded host, and a
    // point 2 to 4 s off.
    internal.providerStorms.settings = stepsOf(4_000, 4_000);
    try {
      membrane.overloaded.add('zz-model');
      membrane.stated = 1_000;
      const before = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.deepEqual(fw.providerWaitSnapshot('a').map((wait) => wait.model), ['zz-model'], 'the stated wait is recorded');
      assert.ok(internal.providerAccelerationCooldowns.get('a')!.until >= before + 2_000, 'held to its point, the later');
      membrane.overloaded.delete('zz-model');
      membrane.stated = undefined;
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'a answered');

      internal.providerStorms.settings = stepsOf(STEP_MS, 4 * STEP_MS);
      membrane.nextErrors = [overloaded(529, 1_500)];
      const run = await ephemeralRun(fw, 'eph-stated');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const [first, second] = membrane.callsOf('eph-stated');
      assert.ok(second!.at - first!.at >= 1_500, `it slept the stated 1.5 s, not its 0.3 s point (${second!.at - first!.at} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a host's providerHold answering a resident's 529 holds by the host's rule, and arms no storm", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, { providerHold: () => ({ holdMs: 60_000, reason: 'zz host quota' }) });
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.ok(internal.providerAccelerationCooldowns.get('a')!.hostHoldError, "the host's hold");
      assert.equal(internal.providerAccelerationCooldowns.get('a')!.waitModel, undefined);
      assert.equal(internal.providerStorms.get('zz-model'), undefined, 'no storm');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a storm keeps the provider's words on one line, bounded", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      const forged = new MembraneError({
        type: 'server', retryable: true, httpStatus: 529, rawError: { status: 529 },
        message: `zz overloaded_error\n[provider-storm] model=zz-model storm over ${'x'.repeat(1_000)}`,
      });
      internal.joinProviderStorm(fw.getAgent('a'), forged);
      const reason = internal.providerStorms.get('zz-model')!.reason;
      assert.ok(!/[\r\n]/.test(reason), 'no line break of the provider\'s starts a line');
      assert.ok(reason.length <= 300, `bounded (${reason.length})`);
      assert.match(reason, /^zz overloaded_error/);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a budget restart held by a storm at the scheduler leaves no inference open at the event gate', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, { gate: { config: { policies: [], default: 'skip' } } });
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      // The turn the restart continues kept its window open for it.
      internal.eventGate!.onInferenceStarted('a');
      internal.pendingRequests.push({ agentName: 'a', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'the restart held');
      assert.equal(membrane.callsOf('a').length, 0);
      assert.deepEqual(internal.eventGate!.inferenceDiagnostics().inferring, [], 'the held restart leaves no inference open');
      // Released, the restart's start takes the window again, resuming the turn.
      const resumed: string[] = [];
      const gate = internal.eventGate!;
      const resume = gate.onInferenceResumed.bind(gate);
      gate.onInferenceResumed = (agentName: string) => { resumed.push(agentName); resume(agentName); };
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'the restart ran');
      assert.deepEqual(resumed, ['a']);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stop of a resident the storm holds after its turn's 529 ends that turn; a wake that arrived during the hold runs after", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(10_000, 10_000);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'a') aborted.push(event.reason); });
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => keepsRetry(internal, 'a'), "a's turn held by the storm for its retry");
      assert.equal(fw.getHostModeStatus().drained, false, 'its turn is alive while the hold keeps its retry');
      // Surgery is refused while the hold keeps it, and the refusal says how
      // to end the turn now: a quiesce would let it finish at the hold's end.
      const kept = internal.providerAccelerationCooldowns.get('a')!;
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'agent-busy');
        assert.ok(error.message.includes(`a is idle+turn-alive (a provider hold keeps its turn to start again, until ${new Date(kept.until).toISOString()}: overloaded (529) since `),
          `names the hold, its end and its reason: ${error.message}`);
        assert.ok(error.message.includes("to go on sooner, end the turn with a host's own abortInference(), or with quiesce with abandon: true once its wait for the drain runs out, or lift a stated wait or a capacity storm's hold with release-provider-wait, so the turn tries again once no host's or acceleration hold binds it"), 'and how to go on sooner');
        return true;
      });
      // A wake for a arrives during the hold.
      internal.pendingRequests.push({ agentName: 'a', reason: 'zz-later-wake', source: 'zz-server', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.heldRequests.length === 2, 'the wake held beside it');
      assert.equal(fw.abortInference('a', 'zz-user-stop'), true, 'the stop ends the turn');
      assert.deepEqual(aborted, ['zz-user-stop'], 'one inference:aborted, with the stop\'s reason');
      const notes = fw.queryInferenceLogs({ agentName: 'a' }).entries
        .map((e) => JSON.stringify((e.entry as { request?: unknown }).request ?? null));
      assert.ok(notes.some((n) => /stopped while its retry or continuation waited to start/.test(n)), `the stop's log row says what it stopped (${notes.join(' | ')})`);
      const hold = internal.providerAccelerationCooldowns.get('a')!;
      assert.equal(keepsRetry(internal, 'a'), false, 'its retry is taken');
      assert.equal(fw.getHostModeStatus().drained, true, 'and its turn is over');
      // A turn alive for any other reason is refused as before, with no word
      // of a hold.
      internal.activeTurnTokens.set('a', -7);
      await assert.rejects(fw.switchBranch('main'), (error: Error) => {
        assert.match(error.message, /a is idle\+turn-alive — every agent sharing the store must be idle \(quiesce the host first\)$/);
        return true;
      });
      internal.activeTurnTokens.delete('a');
      assert.deepEqual((hold.heldRequests as Array<{ reason: string }>).map((r) => r.reason), ['zz-later-wake'], 'the later wake stays');
      // The storm ends: the later wake runs.
      membrane.overloaded.delete('zz-model');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'the later wake runs after');
      assert.equal(membrane.callsOf('a').length, 2, 'one call for the stopped turn, one for the wake');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stop of a resident whose held turn is all the storm holds sends nothing more; a hold of fresh wakes alone has nothing to stop", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(10_000, 10_000);
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => keepsRetry(internal, 'a'), "a's turn held for its retry");
      // The hold is replaced, as a stated wait recorded on it replaces it:
      // the replacement keeps what the hold kept for the turn.
      const wait = internal.providerHoldFor('a', 'zz-model');
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), wait, []), 'replaced');
      assert.ok(keepsRetry(internal, 'a'), 'the replacement still keeps the turn');
      assert.equal(fw.abortInference('a', 'zz-user-stop'), true, 'the stop ends the turn');
      assert.equal(internal.providerAccelerationCooldowns.get('a')?.emptiedByDrop, true, 'its hold keeps nothing now');
      // A wake held for b, which no turn of b's has failed for: nothing to stop.
      internal.pendingRequests.push({ agentName: 'b', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('b')?.heldRequests.length === 1, "b's wake held");
      assert.equal(fw.abortInference('b', 'zz-user-stop'), false, 'a hold of fresh wakes alone keeps no turn');
      assert.equal(internal.providerAccelerationCooldowns.get('b')?.heldRequests.length, 1, "and b's wake stays");
      membrane.overloaded.delete('zz-model');
      internal.providerStormSucceeded(fw.getAgent('c'));
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => membrane.callsOf('b').some((call) => call.ok), "b's wake runs");
      await drive(fw);
      assert.equal(membrane.callsOf('a').length, 1, 'the stopped turn sent nothing more');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stop of a failed turn's retry its hold's release has queued ends it before it starts", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(10_000, 10_000);
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => keepsRetry(internal, 'a'), "a's turn held for its retry");
      // The stop lands just after the hold's release queues the retry.
      let stopped: boolean | undefined;
      const release = internal.releaseProviderAccelerationCooldown.bind(internal);
      internal.releaseProviderAccelerationCooldown = (name: string) => {
        release(name);
        if (name === 'a' && stopped === undefined) stopped = fw.abortInference('a', 'zz-user-stop');
      };
      membrane.overloaded.delete('zz-model');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => stopped !== undefined, 'the stop after the release');
      assert.equal(stopped, true, 'the stop finds the queued retry');
      await drive(fw);
      await sleep(200);
      assert.equal(membrane.callsOf('a').length, 1, 'and no retry runs');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a failed turn a hold keeps with no trigger is retried at release, and a stop ends it; a host's hold is stopped the same way", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    let holds = 0;
    const { fw, internal } = await framework(path, membrane, {
      providerHold: (error) => ((error as MembraneError).httpStatus === 429 && holds++ === 0 ? { holdMs: 1_500, reason: 'zz host quota' } : undefined),
    });
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      // A's call failed with no trigger to keep: its hold keeps a retry made for it.
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [], true), 'held');
      assert.ok(keepsRetry(internal, 'a'), 'a retry kept for it');
      assert.equal(fw.getHostModeStatus().drained, false, 'its turn is alive');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'its retry runs at the release');

      // C's turn meets a host's hold: a stop ends it, and nothing runs after.
      membrane.nextErrors = [new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, message: 'zz quota', rawError: { status: 429 } })];
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['c'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('c')?.hostHoldError !== undefined && keepsRetry(internal, 'c'), "the host holds c's failed turn");
      const aborted: Array<string | undefined> = [];
      fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'c') aborted.push(event.reason); });
      assert.equal(fw.abortInference('c'), true, "the stop ends c's turn");
      assert.deepEqual(aborted, ['user'], "a stop that gives no reason ends it as the user's");
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('c'), "c's hold ends");
      await drive(fw);
      assert.equal(membrane.callsOf('c').length, 1, 'nothing runs after the stop');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stop of a continuation a hold keeps with no failure ends its turn", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const restart = { agentName: 'a', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() };
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [restart]), 'held at admission');
      assert.equal(keepsRetry(internal, 'a'), false, 'no failed turn');
      assert.equal(fw.abortInference('a', 'zz-user-stop'), true, 'the stop ends the continued turn');
      assert.equal(internal.providerAccelerationCooldowns.get('a')?.heldRequests.length, 0, 'its continuation is taken');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await drive(fw);
      assert.equal(membrane.callsOf('a').length, 0, 'nothing runs after');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a failed turn's retry merged with a wake at its release is the turn's retry at its start: a storm armed before its last boundary holds it alive, and a stop takes it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(10_000, 10_000);
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => keepsRetry(internal, 'a'), "a's turn held by the storm for its retry");
      internal.pendingRequests.push({ agentName: 'a', reason: 'zz-later-wake', source: 'zz-server', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.heldRequests.length === 2, 'the wake held beside it');
      // The pass merges the two into the start's trigger; a storm arms before
      // the start's last boundary.
      let started: object | undefined;
      let armed: unknown;
      const start = internal.startAgentStream.bind(internal);
      internal.startAgentStream = (agent, trigger, ...rest) => {
        if ((agent as { name: string }).name === 'a' && started === undefined) {
          started = trigger as object;
          // b's 529 from a call sent after the last storm ended arms a new one.
          const ended = (internal.providerStorms as unknown as { ended: Map<string, number> }).ended.get('zz-model');
          internal.stormSentRounds.set(fw.getAgent('b') as object, ended);
          armed = internal.joinProviderStorm(fw.getAgent('b'), overloaded());
        }
        return start(agent, trigger, ...rest);
      };
      membrane.overloaded.delete('zz-model');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => started !== undefined, "a's start");
      assert.ok(armed, 'a new storm armed before the start');
      assert.ok(internal.failedTurnRetries.has(started!), "the merged trigger is the failed turn's retry");
      await waitFor(fw, () => keepsRetry(internal, 'a'), 'held again at the last boundary, as the retry');
      assert.ok(fw.getHostModeStatus().activeTurnAgents.includes('a'), 'its turn is alive');
      assert.equal(fw.abortInference('a', 'zz-user-stop'), true, 'the stop takes it');
      // The storm ends: nothing more runs for a; the wake merged into the
      // stopped turn went with it.
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('a'), "a's hold ends");
      await drive(fw);
      assert.equal(membrane.callsOf('a').length, 1, 'only the failed call');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("under a quiesce a failed turn's retry in the queue is no gated wake: the drain counts it alive, and the scheduler runs it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      const quiesced = await fw.quiesce({ reason: 'zz-surgery', timeoutMs: 2_000 });
      assert.equal(quiesced.drained, true, 'nothing in flight to begin with');
      const retry = { agentName: 'a', reason: 'provider-acceleration-retry', source: 'framework', timestamp: Date.now() };
      internal.failedTurnRetries.add(retry);
      internal.pendingRequests.push(retry);
      const status = fw.getHostModeStatus();
      assert.equal(status.gatedRequests, 0, 'not a gated wake');
      assert.equal(status.drained, false, 'its turn is in flight');
      await drive(fw);
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'the retry runs under the quiesce');
      await waitFor(fw, () => fw.getHostModeStatus().drained, 'drained once it finished');
      await fw.resume();
    } finally { await fw.stop(); log.restore(); }
  });
});

test("the error policy's retry of a failed turn, held at its start's last boundary, is that turn's retry: alive, and a stop takes it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, { errorPolicy: { maxRetries: 3, onInferenceError: () => ({ retry: true, delayMs: 20 }) } });
    internal.providerStorms.settings = stepsOf(10_000, 10_000);
    try {
      // a's call fails with a 500 the policy retries; a storm arms before the
      // retry's start reaches its last boundary.
      membrane.nextErrors = [new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'zz internal error', rawError: undefined })];
      let armed: unknown;
      const start = internal.startAgentStream.bind(internal);
      internal.startAgentStream = (agent, trigger, ...rest) => {
        if ((agent as { name: string }).name === 'a' && rest[0] === 1 && armed === undefined) {
          armed = internal.joinProviderStorm(fw.getAgent('b'), overloaded());
        }
        return start(agent, trigger, ...rest);
      };
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => keepsRetry(internal, 'a'), "the policy's retry held as the turn's retry");
      assert.ok(armed, 'the storm armed before the retry started');
      assert.ok(fw.getHostModeStatus().activeTurnAgents.includes('a'), 'its turn is alive');
      assert.equal(fw.abortInference('a', 'zz-user-stop'), true, 'the stop takes it');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('a'), "a's hold ends");
      await drive(fw);
      assert.equal(membrane.callsOf('a').length, 1, 'only the failed call');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stopping framework installs no provider hold: a failure a hold would take is the stop's, and its site ends the turn as stop() ends a held turn, with no exhaustion", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, {
      providerHold: (error) => ((error as MembraneError).httpStatus === 429 ? { holdMs: 60_000, reason: 'zz host quota' } : undefined),
    });
    const traces: string[] = [];
    fw.onTrace((event) => {
      if (event.type === 'inference:failed') traces.push(`${event.agentName} failed`);
      if (event.type === 'inference:aborted') traces.push(`${event.agentName} aborted ${event.reason}`);
      if (event.type === 'inference:exhausted') traces.push(`${event.agentName} exhausted`);
    });
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const trigger = { agentName: 'a', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now() };
      internal.providerAdmissionClosed = true;
      // Each installer takes a failure a hold would take, installing nothing,
      // and leaves its turn to its failure site.
      assert.equal(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [trigger]), false, 'no hold at admission');
      assert.equal(internal.holdProviderAcceleration(fw.getAgent('a'), overloaded(), trigger), true, "a storm's 529, by its class");
      assert.equal(internal.holdForProviderWait(fw.getAgent('b'), internal.providerHoldFor('b', 'zz-model'), [], true), true, "a stated wait's");
      assert.equal(internal.holdForStorm(fw.getAgent('c')), true, "holdForStorm's");
      const expired = { agent: 'a', model: 'zz-model', until: Date.now() - 1, reason: 'zz passed', setAt: Date.now() - 10 };
      assert.equal(internal.holdForProviderWait(fw.getAgent('a'), expired, [trigger], true), false, 'a wait already over takes nothing, stopping or not');
      // A host's hold, on a 429 that states a wait: the wait is still
      // recorded, for the calls after a restart.
      assert.equal(internal.holdProviderAcceleration(fw.getAgent('c'), overloaded(429, 5_000), undefined), true, "a host hold's 429");
      assert.deepEqual(fw.providerWaitSnapshot('c').map((wait) => wait.model), ['zz-other'], 'its stated wait recorded');
      assert.equal(internal.holdProviderAcceleration(fw.getAgent('a'), overloaded(429), undefined, true), false, "an auxiliary call's host hold: no turn to take");
      internal.conversationAgentHomes.set('b', 'world:zz');
      assert.deepEqual(internal.nonOwningProviderWait(fw.getAgent('b'), overloaded()), { held: true }, "a conversation agent's 529, with no storm to join");
      internal.conversationAgentHomes.delete('b');
      assert.deepEqual(traces, [], 'the installers end nothing themselves');
      assert.equal(internal.providerAccelerationCooldowns.size, 0, 'no hold installed');
      assert.equal(internal.pendingRequests.length, 0, 'nothing queued');
      // Nor does a stopping framework arm or step a storm: one armed after
      // stop() cleared them would outlive the stop.
      const step = internal.providerStorms.get('zz-model')!.step;
      internal.stormSentRounds.set(fw.getAgent('a') as object, internal.providerStorms.get('zz-model')!.round);
      assert.equal(internal.joinProviderStorm(fw.getAgent('a'), overloaded()), undefined, 'no storm joined');
      assert.equal(internal.providerStorms.get('zz-model')!.step, step, 'nor stepped');
      internal.providerAdmissionClosed = false;
      internal.providerStormSucceeded(fw.getAgent('b'));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a turn whose call meets a 529 while the framework stops ends as stop() ends a held turn: its failure, then the stop's end, one log row, no exhaustion", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, { errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } });
    const traces: string[] = [];
    fw.onTrace((event) => {
      if (event.type === 'inference:failed' && event.agentName === 'a') traces.push('failed');
      if (event.type === 'inference:aborted' && event.agentName === 'a') traces.push(`aborted ${event.reason}`);
      if (event.type === 'inference:exhausted' && event.agentName === 'a') traces.push('exhausted');
    });
    try {
      let open!: () => void;
      membrane.gate = new Promise<void>((resolve) => { open = resolve; });
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, "a's call sent");
      // The 529 arrives as the framework stops (its admission closed, as
      // stop() closes it before it waits for its frames).
      internal.providerAdmissionClosed = true;
      open();
      await waitFor(fw, () => traces.includes('aborted shutdown') && fw.getHostModeStatus().drained, 'the turn ended as the stop, nothing of it left');
      assert.deepEqual(traces, ['failed', 'aborted shutdown'], 'its failure, then the stop: no exhaustion');
      assert.equal(internal.consecutiveInferenceFailures.get('a') ?? 0, 0, 'no failure streak');
      assert.equal(internal.providerAccelerationCooldowns.has('a'), false, 'no hold');
      assert.equal(internal.providerStorms.get('zz-model'), undefined, 'no storm');
      const rows = fw.queryInferenceLogs({ agentName: 'a' }).entries.map((e) => e.entry as { success?: boolean; request?: { note?: string } });
      assert.equal(rows.length, 1, 'one log row');
      assert.equal(rows[0]!.success, false, "the call's failure");
      assert.equal(rows[0]!.request?.note, undefined, 'with the request it sent');
      internal.providerAdmissionClosed = false;
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const site of ['stream', 'setup', 'throw'] as const) for (const kind of ['resident', 'conversation agent'] as const) {
  test(`a ${kind}'s 529 as its stream ${site === 'stream' ? 'reports an error' : site === 'setup' ? 'is made' : 'is read'} while the framework stops ends its turn once, as the stop's, with no exhaustion`, async () => {
    await withStoreDir(async (path) => {
      const log = silence();
      const membrane = new StormMembrane();
      const { fw, internal } = await framework(path, membrane, { errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } });
      const traces: string[] = [];
      fw.onTrace((event) => {
        if (event.type === 'inference:failed' && event.agentName === 'a') traces.push('failed');
        if (event.type === 'inference:aborted' && event.agentName === 'a') traces.push(`aborted ${event.reason}`);
        if (event.type === 'inference:exhausted' && event.agentName === 'a') traces.push('exhausted');
      });
      try {
        if (kind === 'conversation agent') internal.conversationAgentHomes.set('a', 'world:zz');
        membrane.site = site;
        membrane.overloaded.add('zz-model');
        // The stop closes admission as the call goes out (as the stream is
        // made, or as it is read), so its 529 meets a stopping framework at
        // this site.
        const send = membrane.streamYielding.bind(membrane);
        membrane.streamYielding = (request, options) => {
          if (site === 'setup') internal.providerAdmissionClosed = true;
          const stream = send(request, options);
          const iterate = stream[Symbol.asyncIterator].bind(stream);
          Object.defineProperty(stream, Symbol.asyncIterator, { configurable: true, value: () => {
            internal.providerAdmissionClosed = true;
            return iterate();
          } });
          return stream;
        };
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
        await waitFor(fw, () => traces.includes('aborted shutdown') && !internal.activeTurnTokens.has('a'), 'the turn ended as the stop');
        assert.deepEqual(traces, ['failed', 'aborted shutdown'], 'its failure, then the stop: once, no exhaustion');
        assert.equal(internal.consecutiveInferenceFailures.get('a') ?? 0, 0, 'no failure streak');
        assert.equal(internal.providerAccelerationCooldowns.has('a'), false, 'no hold');
        assert.equal(internal.providerStorms.get('zz-model'), undefined, 'no storm');
        const rows = fw.queryInferenceLogs({ agentName: 'a' }).entries.map((e) => e.entry as { error?: string; request?: { note?: string } });
        if (site === 'throw') {
          const errors = rows.map((row) => String(row.error));
          assert.ok(errors.some((row) => row.startsWith('Framework stopping: ')), `the call's row says the framework stopped (${errors.join(' | ')})`);
        }
        if (site === 'setup') {
          // A failed start writes no row of its own: the stop's says no
          // request was made, as at the start's other stops.
          assert.deepEqual(rows.map((row) => row.request?.note), ['no request: the turn was stopped before a compile made one']);
          assert.ok(log.lines.some((line) => line.includes("a: the framework's stop reached the turn's start before it")), 'its console line says where');
        }
      } finally { internal.providerAdmissionClosed = false; await fw.stop(); log.restore(); }
    });
  });
}

for (const kind of ['resident', 'conversation agent'] as const) test(`a stop() a listener of a ${kind}'s thrown 529's failure makes ends the turn the hold has taken once`, async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    if (kind === 'conversation agent') internal.conversationAgentHomes.set('a', 'world:zz');
    const aborted: Array<string | undefined> = [];
    let stopping: Promise<void> | undefined;
    fw.onTrace((event) => {
      if (event.type === 'inference:aborted' && event.agentName === 'a') aborted.push(event.reason);
      if (event.type === 'inference:failed' && event.agentName === 'a' && !stopping) stopping = fw.stop();
    });
    try {
      membrane.site = 'throw';
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => stopping !== undefined, 'the failure reported');
      await stopping;
      assert.deepEqual(aborted, ['shutdown'], "one end, the stop's");
      assert.equal(internal.providerAccelerationCooldowns.size, 0, 'no hold past the stop');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a hold that already holds a request takes a copy of it marked as a failed turn's retry as that retry: the held one is marked", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const wake = { agentName: 'a', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now() };
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [wake]), 'held as a wake');
      assert.equal(keepsRetry(internal, 'a'), false, 'not a retry yet');
      const copy = { ...wake };
      internal.failedTurnRetries.add(copy);
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [copy]), 'held again');
      const held = internal.providerAccelerationCooldowns.get('a')!.heldRequests;
      assert.equal(held.length, 1, 'once');
      assert.equal(held[0], wake, 'the request already held stays');
      assert.ok(internal.failedTurnRetries.has(wake), 'and is now the retry');
      // The same when the hold is told it takes a begun turn.
      const other = { agentName: 'a', reason: 'zz-other', source: 'zz-server', timestamp: Date.now() + 1 };
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [other]), 'another wake');
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [{ ...other }], false, true), 'its copy, as a begun turn');
      assert.ok(internal.failedTurnRetries.has(other), 'the held one is marked');
      internal.providerStormSucceeded(fw.getAgent('b'));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("the scheduler's merge into a hold that already holds a request takes a copy of it marked as a failed turn's retry as that retry", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const wake = { agentName: 'a', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now() };
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [wake]), 'held as a wake');
      const copy = { ...wake };
      internal.failedTurnRetries.add(copy);
      internal.pendingRequests.push(copy);
      await drive(fw);
      const held = internal.providerAccelerationCooldowns.get('a')!.heldRequests;
      assert.equal(held.length, 1, 'merged into the hold once');
      assert.equal(held[0], wake, 'the request already held stays');
      assert.ok(internal.failedTurnRetries.has(wake), 'the held request is now the retry');
      assert.ok(fw.getHostModeStatus().activeTurnAgents.includes('a'), 'and its turn reads alive');
      internal.providerStormSucceeded(fw.getAgent('b'));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a failed turn's retry the storm leaves to the queue, its point passed, is that turn's retry", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      const storm = internal.joinProviderStorm(fw.getAgent('b'), overloaded())!;
      storm.releaseAt.set('a', Date.now() - 1);
      const trigger = { agentName: 'a', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now() };
      assert.ok(internal.holdForStorm(fw.getAgent('a'), trigger), 'taken');
      assert.equal(internal.providerAccelerationCooldowns.has('a'), false, 'no hold: its point has passed');
      assert.equal(internal.pendingRequests[0], trigger, 'queued');
      assert.ok(internal.failedTurnRetries.has(trigger), "as the failed turn's retry");
      assert.ok(fw.getHostModeStatus().activeTurnAgents.includes('a'), 'its turn is alive');
      internal.pendingRequests.length = 0;
      internal.providerStormSucceeded(fw.getAgent('b'));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a failed turn's retry the inference policy refuses ends its turn", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, {
      inferencePolicy: { shouldInfer: (_name: string, requests: Array<{ reason: string }>) => !requests.some((r) => r.reason === 'zz-refused') },
    } as Partial<FrameworkConfig>);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'a') aborted.push(event.reason); });
    try {
      const retry = { agentName: 'a', reason: 'zz-refused', source: 'framework', timestamp: Date.now() };
      internal.failedTurnRetries.add(retry);
      internal.pendingRequests.push(retry);
      assert.equal(fw.getHostModeStatus().drained, false, 'its turn is alive');
      await drive(fw);
      assert.equal(aborted.length, 1, 'its turn ends');
      assert.equal(fw.getHostModeStatus().drained, true, 'and nothing of it is left');
      assert.equal(membrane.callsOf('a').length, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a quiesce abandon of a continuation a storm keeps for its retry ends that turn: its hold starts nothing", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      // A's continuation failed at its call, and the storm holds it for its retry.
      const restart = { agentName: 'a', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() };
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), [restart], true), 'held');
      assert.ok(keepsRetry(internal, 'a'), 'kept for its retry');
      internal.dropContinuations('a', { kind: 'quiesce_abandoned', why: 'zz its turn was abandoned' });
      const notes = fw.queryInferenceLogs({ agentName: 'a' }).entries
        .map((e) => JSON.stringify((e.entry as { request?: unknown }).request ?? null));
      assert.ok(notes.some((n) => /stopped while its retry or continuation waited to start/.test(n)), `the abandon's log row says the turn waited (${notes.join(' | ')})`);
      const hold = internal.providerAccelerationCooldowns.get('a')!;
      assert.equal(keepsRetry(internal, 'a'), false, 'the abandon ended the turn it kept');
      assert.equal(hold.emptiedByDrop, true, 'and the hold keeps nothing');
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('a'), "a's hold released");
      await drive(fw);
      assert.equal(membrane.callsOf('a').length, 0, 'no turn in place of the abandoned one');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a wake a storm holds that coalescing then withdraws starts no turn when the storm ends", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      // A server's wake for a, which a later occurrence of its subject can
      // withdraw, arrives in the storm: the storm holds it at admission.
      internal.pendingRequests.push({ agentName: 'a', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now(), coalescingSubject: 'zz-subject' });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.heldRequests.length === 1, 'the storm holds the wake');
      internal.cancelCoalescedWakes('zz-subject');
      assert.equal(internal.providerAccelerationCooldowns.get('a')?.emptiedByDrop, true, 'its hold is emptied by the withdrawal');
      // A wait recorded on it while it holds nothing keeps it emptied.
      assert.ok(internal.holdForProviderWait(fw.getAgent('a'), internal.providerHoldFor('a', 'zz-model'), []), 're-armed');
      assert.equal(internal.providerAccelerationCooldowns.get('a')?.emptiedByDrop, true, 'still emptied');
      // The storm ends: a's hold releases, and nothing asks for a turn.
      internal.providerStormSucceeded(fw.getAgent('b'));
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('a'), "a's hold released");
      await fw.runUntilIdle();
      await sleep(200);
      assert.equal(membrane.callsOf('a').length, 0, 'no turn nobody asked for');
      // A wake that arrives later is a turn as ever.
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'a later wake answers');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a hold a failed turn began keeps that turn's retry when coalescing withdraws the wakes held beside it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    let holds = 0;
    const { fw, internal } = await framework(path, membrane, {
      providerHold: (error) => ((error as MembraneError).httpStatus === 429 && holds++ === 0 ? { holdMs: 1_500, reason: 'zz host quota' } : undefined),
    });
    try {
      membrane.nextErrors = [new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, message: 'zz quota', rawError: { status: 429 } })];
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.hostHoldError !== undefined, "the host holds a's failed turn");
      internal.pendingRequests.push({ agentName: 'a', reason: 'zz-wake', source: 'zz-server', timestamp: Date.now(), coalescingSubject: 'zz-subject' });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.heldRequests.length === 2, 'the wake held beside it');
      internal.cancelCoalescedWakes('zz-subject');
      assert.notEqual(internal.providerAccelerationCooldowns.get('a')?.emptiedByDrop, true, 'the failed turn is still owed its retry');
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), "the failed turn's retry runs");
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a 529 from a call sent in a storm that has ended since arms nothing: the error policy takes it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      storms.get('zz-model')!.stepStartedAt -= 10_000;
      membrane.overloaded.add('zz-model');
      const sent = gate();
      membrane.gate = sent.promise;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, 'a sent in the storm, its point passed');
      // Another call on the model answers: the storm is over.
      internal.providerStormSucceeded(fw.getAgent('b'));
      membrane.overloaded.delete('zz-model');
      sent.open();
      membrane.gate = undefined;
      await waitFor(fw, () => internal.retryWaitWakers.size > 0 || internal.providerAccelerationCooldowns.has('a'), "a's 529 taken");
      assert.equal(storms.get('zz-model'), undefined, 'no new storm');
      assert.equal(internal.providerAccelerationCooldowns.has('a'), false, 'not held');
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), "the error policy's retry answered");
    } finally { await fw.stop(); log.restore(); }
  });
});

test('stop() forgets the storms, as a restart does', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('a'), overloaded());
      assert.ok(internal.providerStorms.get('zz-model'));
    } finally { await fw.stop(); log.restore(); }
    assert.deepEqual(internal.providerStorms.list(), []);
  });
});

/** A stream that yields its script's events in order, running each function
 *  in it as it comes. `'tools'` waits for the round's tool results to be
 *  handed over; `'hold'` waits until the stream is cancelled. */
class ScriptedStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  private resumed: (() => void) | undefined;
  constructor(private readonly script: Array<StreamEvent | (() => void) | 'tools' | 'hold'>) {}
  provideToolResults(): void { this.isWaitingForTools = false; this.toolDepth++; this.resumed?.(); }
  cancel(): void { this.isCancelled = true; this.resumed?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (const step of this.script) {
      if (this.isCancelled) return;
      if (step === 'tools' || step === 'hold') {
        await new Promise<void>((resolve) => { this.resumed = resolve; });
        continue;
      }
      if (typeof step === 'function') { step(); continue; }
      if (step.type === 'tool-calls') {
        this.isWaitingForTools = true;
        this.pendingToolCallIds = step.calls.map((call) => call.id);
      }
      yield step;
    }
  }
}

const text = (content: string): StreamEvent => ({ type: 'tokens', content, meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent);
const toolResultText = (content: string): StreamEvent => ({ type: 'tokens', content, meta: { type: 'tool_result', visible: false, blockIndex: 0 } } as StreamEvent);
const usage = (): StreamEvent => ({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as StreamEvent);
const complete = (content: string): StreamEvent => ({ type: 'complete', response: createMockResponse(content ? [{ type: 'text', text: content }] : []) } as StreamEvent);
const refusalRetry = (): StreamEvent => ({ type: 'retrying', attempt: 1, maxAttempts: 2, reason: 'refusal' } as unknown as StreamEvent);
const toolCalls = (): StreamEvent => ({
  type: 'tool-calls',
  calls: [{ id: 'zz-call', name: 'zz-tool', input: {} }],
  context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
    roundContent: [{ type: 'tool_use', id: 'zz-call', name: 'zz-tool', input: {} }] },
} as StreamEvent);

/** Run a's turn on a scripted stream, with b's 529 arming a storm on
 *  zz-model wherever the script calls `arm`, and `seen(label)` recording
 *  whether a storm stands there. Returns once the script reaches `seen('done')`. */
async function scriptedTurn(
  script: (arm: () => void, seen: (label: string) => void) => Array<StreamEvent | (() => void) | 'tools' | 'hold'>,
): Promise<Map<string, boolean>> {
  return withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const standing = new Map<string, boolean>();
    try {
      const arm = () => { internal.joinProviderStorm(fw.getAgent('b'), overloaded()); };
      const seen = (label: string) => { standing.set(label, internal.providerStorms.get('zz-model') !== undefined); };
      membrane.nextStream = new ScriptedStream(script(arm, seen));
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => standing.has('done'), 'the script ran');
      return standing;
    } finally { await fw.stop(); log.restore(); }
  });
}

test('an answer streamed as text alone, as membrane streams it with blocks off, ends the storm', async () => {
  const seen = await scriptedTurn((arm, at) => [arm, () => at('armed'), text('zz-answer'), () => at('done'), 'hold']);
  assert.deepEqual([...seen], [['armed', true], ['done', false]]);
});

test("an answer with nothing in it ends the storm at its call's end", async () => {
  const seen = await scriptedTurn((arm, at) => [arm, () => at('armed'), usage(), () => at('done'), complete('')]);
  assert.deepEqual([...seen], [['armed', true], ['done', false]]);
});

test("each provider call's answer counts once: an automatic resumption's, at its end, ends a storm armed after the first call answered, and tool results it reports end nothing", async () => {
  const seen = await scriptedTurn((arm, at) => [
    text('zz-first'), usage(), arm, () => at('armed after the first call'),
    // XML tool mode reports a round's tool results as tokens: not an answer.
    toolResultText('zz-result'), () => at('after the tool results'),
    // Nothing tells the resumption's first words from text membrane flushes
    // after the call before: it answers at its end.
    text('zz-resumed'), () => at("after the resumption's words"), usage(), () => at('done'), complete('zz-first zz-resumed'),
  ]);
  assert.deepEqual([...seen], [
    ['armed after the first call', true], ['after the tool results', true], ["after the resumption's words", true], ['done', false],
  ]);
});

// Membrane 0.7's XML path flushes the text its parser held back (a possible
// tag's start) after the round's usage.
test("text membrane flushes after a call's end ends nothing: a storm armed while the call streamed stands", async () => {
  const seen = await scriptedTurn((arm, at) => [
    text('The rule is a '), arm, () => at('armed while the call streamed'), usage(), () => at('after its end'),
    text('<'), () => at('after the held-back text'), () => at('done'), complete('The rule is a <'),
  ]);
  assert.deepEqual([...seen], [
    ['armed while the call streamed', true], ['after its end', true], ['after the held-back text', true], ['done', true],
  ]);
});

test('control: the same call with nothing held back leaves the storm standing', async () => {
  const seen = await scriptedTurn((arm, at) => [
    text('The rule is a '), arm, () => at('armed while the call streamed'), usage(), () => at('after its end'), () => at('done'), complete('The rule is a '),
  ]);
  assert.deepEqual([...seen], [['armed while the call streamed', true], ['after its end', true], ['done', true]]);
});

test("a tool round's next call answering ends a storm armed while its tools ran; the round's own tool calls don't", async () => {
  const seen = await scriptedTurn((arm, at) => [
    text('zz-calling'), usage(), arm, () => at('armed'), toolCalls(), 'tools', () => at('tools handed over'),
    text('zz-after'), () => at('done'), usage(), complete('zz-after'),
  ]);
  assert.deepEqual([...seen], [['armed', true], ['tools handed over', true], ['done', false]]);
});

test('a refusal membrane re-issues is the model answering: it ends the storm', async () => {
  const seen = await scriptedTurn((arm, at) => [arm, () => at('armed'), refusalRetry(), () => at('done'), 'hold']);
  assert.deepEqual([...seen], [['armed', true], ['done', false]]);
});

test("a re-issue after a call's end is a call the framework saw sent: its first words end a storm armed meanwhile", async () => {
  const seen = await scriptedTurn((arm, at) => [
    text('zz-first'), usage(), refusalRetry(), arm, () => at('armed during the re-issue'), text('zz-reissued'), () => at('done'), 'hold',
  ]);
  assert.deepEqual([...seen], [['armed during the re-issue', true], ['done', false]]);
});

test("a refusal's re-issue is a send of its own: re-issued after the storm began, its 529 steps it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      // The refused call answered before the storm armed; its re-issue goes
      // in the storm's round.
      membrane.nextStream = new ScriptedStream([
        text('zz-refused'), () => internal.joinProviderStorm(fw.getAgent('b'), overloaded()), refusalRetry(),
        { type: 'error', error: overloaded() } as StreamEvent,
      ]);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.equal(internal.providerStorms.get('zz-model')!.stepMs, 2 * STEP_MS, 'its re-issue was sent in the round, so its 529 steps it');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run asleep in a storm on a stated wait sleeps it out past the storm's end, and an operator's release lifts it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(400, 4 * STEP_MS);
    try {
      // Its 529 states 3 s, past its point (at most 0.4 s).
      membrane.nextErrors = [overloaded(529, 3_000)];
      const stated = await ephemeralRun(fw, 'eph-stated-end');
      await waitFor(fw, () => internal.stormSleepers.has(stated.name), 'asleep in the storm');
      // A resident's answer ends the storm while the run sleeps.
      internal.providerStormSucceeded(fw.getAgent('a'));
      assert.equal(internal.providerStorms.get('zz-model'), undefined, 'the storm is over');
      const outcome = await stated.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const [first, second] = membrane.callsOf('eph-stated-end');
      assert.ok(second!.at - first!.at >= 2_990, `it slept the stated 3 s (${second!.at - first!.at} ms)`);

      // Another storm, another stated wait past the run's point: once the
      // point has passed, a release still finds it asleep and wakes it, and
      // the wait it lifted binds none of the run's later sleeps.
      membrane.nextErrors = [overloaded(529, 30_000), overloaded()];
      const released = await ephemeralRun(fw, 'eph-stated-released');
      await waitFor(fw, () => internal.stormSleepers.has(released.name), 'asleep in the new storm');
      await sleep(600);
      assert.ok(internal.providerStorms.get('zz-model'), 'the storm stands');
      const receipt = fw.releaseProviderWait(released.name, undefined, 'zz-operator');
      assert.deepEqual(receipt.map((r) => r.release), ['storm'], 'listed, its point passed');
      const after = await released.outcome;
      assert.ok('result' in after, `the released run completes${'error' in after ? `: ${after.error.message}` : ''}`);
      const [sent, retried, answered] = membrane.callsOf('eph-stated-released');
      assert.ok(retried!.at - sent!.at < 15_000, `at once, not after its stated 30 s (${retried!.at - sent!.at} ms)`);
      assert.ok(answered!.at - retried!.at < 5_000, `its next 529 slept to its point only (${answered!.at - retried!.at} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a step wakes a run asleep in the storm to sleep to its point in the new step, where a release still finds it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(10_000, 40_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-step');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      const sleeper = internal.stormSleepers.get(run.name)!;
      const oldUntil = sleeper.until;
      // b's call, sent in this round, fails: the storm steps.
      const b = fw.getAgent('b')!;
      internal.stormSentRounds.set(b, storms.sent('zz-model'));
      internal.joinProviderStorm(b, overloaded());
      assert.equal(storms.get('zz-model')!.stepMs, 20_000);
      await waitFor(fw, () => internal.stormSleepers.get(run.name)?.until !== oldUntil, 'its sleep retimed');
      const newPoint = storms.get('zz-model')!.releaseAt.get(run.name)!;
      assert.equal(internal.stormSleepers.get(run.name)!.until, newPoint, 'to its point in the new step');
      assert.ok(newPoint >= storms.get('zz-model')!.stepStartedAt + 10_000);
      assert.equal(membrane.callsOf('eph-step').length, 1, 'without a call');
      membrane.overloaded.delete('zz-model');
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator'),
        [{ model: 'zz-model', until: new Date(newPoint).toISOString(), release: 'storm' }]);
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a run deferred before its first call wakes at a release, and its allowance is charged only the time it slept', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(10_000, 40_000);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      membrane.overloaded.add('zz-model');
      const startedAt = Date.now();
      const run = await ephemeralRun(fw, 'eph-deferred');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'deferred and asleep');
      assert.equal(membrane.callsOf('eph-deferred').length, 0, 'nothing sent');
      const point = internal.stormSleepers.get(run.name)!.until;
      await sleep(200);
      fw.releaseProviderWait(run.name, undefined, 'zz-operator');
      // Released, it tries at once; its 529 steps the storm and it sleeps again.
      await waitFor(fw, () => membrane.callsOf('eph-deferred').length === 1 && internal.stormSleepers.has(run.name), 'tried, and asleep again');
      assert.ok(membrane.callsOf('eph-deferred')[0]!.at < point, 'at once, not at its point');
      const slept = internal.ephemeralRuns.get(run.name)!.stormSleptMs;
      assert.ok(slept >= 150 && slept <= Date.now() - startedAt, `charged the ${slept} ms it slept, no more`);
      assert.ok(slept < point - startedAt - 1_000, `not the ${point - startedAt} ms its sleep was planned for`);
      membrane.overloaded.delete('zz-model');
      fw.releaseProviderWait(run.name, undefined, 'zz-operator');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      // The inference log records calls: the deferral sent none.
      assert.equal(fw.queryInferenceLogs({ agentName: run.name }).total, membrane.callsOf('eph-deferred').length,
        'one log entry a call, none for the deferral');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a run its watchdog ends while it sleeps in a storm is no longer held by it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-idle', 'zz-model', { idleTimeoutMs: 1_000, idlePollMs: 100 });
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      const outcome = await run.outcome;
      assert.ok('error' in outcome && outcome.error.message !== 'zz-unsettled', 'the watchdog ended it');
      assert.equal(internal.stormSleepers.has(run.name), false, 'no longer listed as asleep in the storm');
      assert.equal((fw.healthSnapshot() as Health).providerStorms[0]!.heldAgents, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('stop() ends a run asleep in a storm', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    let stopped = false;
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-stopped');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      await fw.stop();
      stopped = true;
      const outcome = await run.outcome;
      assert.ok('error' in outcome && outcome.error.message !== 'zz-unsettled', 'it ends, not at its point');
      assert.equal(internal.stormSleepers.size, 0);
    } finally { if (!stopped) await fw.stop(); log.restore(); }
  });
});

test('health lists no next release while nobody waits in a storm, and counts each model\'s runs asleep on it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 80_000);
    try {
      internal.joinProviderStorm(fw.getAgent('a'), overloaded());
      assert.deepEqual((fw.healthSnapshot() as Health).providerStorms.map((s) => [s.model, s.nextRelease, s.heldAgents]),
        [['zz-model', null, 0]], 'armed, with nobody held in it');
      membrane.overloaded.add('zz-model');
      membrane.overloaded.add('zz-other');
      // The first run is deferred by zz-model's storm and sleeps; the second
      // starts while it does, so its sleep holds no other agent's start.
      const onModel = await ephemeralRun(fw, 'eph-on-model');
      await waitFor(fw, () => internal.stormSleepers.has(onModel.name), 'the first run asleep');
      const onOther = await ephemeralRun(fw, 'eph-on-other', 'zz-other');
      await waitFor(fw, () => internal.stormSleepers.has(onModel.name) && internal.stormSleepers.has(onOther.name), 'both asleep')
        .catch((error: Error) => { throw new Error(`${error.message}; asleep: ${[...internal.stormSleepers.keys()].join(', ')}; ` +
          `calls: ${JSON.stringify(membrane.turnCalls)}; log: ${log.lines.slice(-12).join(' | ')}`); });
      const health = (fw.healthSnapshot() as Health).providerStorms;
      for (const [model, name] of [['zz-model', onModel.name], ['zz-other', onOther.name]] as const) {
        const storm = health.find((s) => s.model === model)!;
        assert.equal(storm.heldAgents, 1, `${model}: its own run`);
        assert.equal(storm.nextRelease, new Date(internal.stormSleepers.get(name)!.until).toISOString());
      }
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an operator's release of an agent whose point has passed lists no storm release", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      internal.providerStorms.get('zz-model')!.releaseAt.set('a', Date.now() - 1);
      assert.deepEqual(fw.releaseProviderWait('a', undefined, 'zz-operator'), []);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a call sent after a storm ended while its turn compiled is the next storm's: its 529 arms one", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let end = true;
    class EndDuringCompile extends StormMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        if (end) { end = false; internal.providerStormSucceeded(fw.getAgent('b')); }
        return super.streamYielding(request);
      }
    }
    const membrane = new EndDuringCompile();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const first = storms.get('zz-model')!;
      // a's point has passed: its turn goes, and compiles in the storm.
      first.releaseAt.set('a', Date.now() - 1);
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      const next = storms.get('zz-model');
      assert.ok(next && next !== first, 'a new storm, armed by its 529');
      assert.equal(next!.stepMs, STEP_MS, 'at the first step');
      assert.equal(membrane.callsOf('a').length, 1);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a continuation that joins a hold already standing closes its window too, and a scheduler pass a stop and start overtook closes none', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, { gate: { config: { policies: [], default: 'skip' } } });
    try {
      membrane.overloaded.add('zz-model');
      fw.getAgent('a')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-hello' }]);
      internal.pendingRequests.push({ agentName: 'a', reason: 'test', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      // A restart for a arrives with a window open, and joins a's hold.
      internal.eventGate!.onInferenceStarted('a');
      internal.pendingRequests.push({ agentName: 'a', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
      await waitFor(fw, () => internal.pendingRequests.length === 0, 'the scheduler took it');
      assert.deepEqual(internal.eventGate!.inferenceDiagnostics().inferring, [], 'its window closed');
      // An ordinary wake held leaves a window it finds open: no turn of its
      // agent's is under way to close.
      internal.eventGate!.onInferenceStarted('c');
      internal.closeHeldContinuationWindow('c', [{ agentName: 'c', reason: 'zz-wake', source: 'test', timestamp: 0 }],
        internal.lifecycleGeneration);
      assert.deepEqual(internal.eventGate!.inferenceDiagnostics().inferring, ['c'], 'an ordinary wake leaves it');
      internal.eventGate!.onInferenceEnded('c');
      // A pass from before a stop and start leaves the window it finds.
      internal.eventGate!.onInferenceStarted('b');
      internal.closeHeldContinuationWindow('b', [{ agentName: 'b', reason: 'context_budget_restart', source: 'framework', timestamp: 0 }],
        internal.lifecycleGeneration - 1);
      assert.deepEqual(internal.eventGate!.inferenceDiagnostics().inferring, ['b']);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an operator's release takes the storm off an agent a host hold also binds, and the host's hold stays", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, {
      providerHold: (error) => ((error as MembraneError).httpStatus === 429 ? { holdMs: 60_000, reason: 'zz host quota' } : undefined),
    });
    internal.providerStorms.settings = stepsOf(10_000, 10_000);
    try {
      membrane.overloaded.add('zz-model');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.waitModel === 'zz-model', 'a held by the storm');
      // Its compression meets the host's quota: the host holds it too.
      membrane.auxiliaryFailure = new MembraneError({ type: 'server', retryable: true, httpStatus: 429, message: 'zz quota', rawError: { status: 429 } });
      await assert.rejects(internal.auxiliaryMembraneFor('a').complete(auxRequest('zz-model')), /zz quota/);
      membrane.auxiliaryFailure = undefined;
      assert.ok(internal.providerAccelerationCooldowns.get('a')?.hostHoldError, "the host's hold");
      assert.deepEqual(fw.releaseProviderWait('a', undefined, 'zz-operator').map((r) => r.release), ['storm']);
      // A wake for a reaches admission, and the host's hold keeps it.
      internal.pendingRequests.push({ agentName: 'a', reason: 'zz-wake', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => internal.pendingRequests.length === 0, 'the scheduler took the wake');
      const held = internal.providerAccelerationCooldowns.get('a');
      assert.ok(held?.hostHoldError, "the host's hold stays");
      assert.ok((held!.heldRequests as Array<{ reason: string }>).some((r) => r.reason === 'zz-wake'), 'and holds the wake');
      assert.equal(membrane.callsOf('a').length, 1, 'a sends nothing');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run asleep on a stated wait after its storm's end is released all the same, and a storm armed meanwhile counts against its allowance", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(400, 4 * STEP_MS);
    try {
      // Its 529 states 30 s; a resident's answer ends the storm.
      membrane.nextErrors = [overloaded(529, 30_000)];
      const released = await ephemeralRun(fw, 'eph-tail-released');
      await waitFor(fw, () => internal.stormSleepers.has(released.name), 'asleep in the storm');
      internal.providerStormSucceeded(fw.getAgent('a'));
      assert.equal(storms.get('zz-model'), undefined);
      const releasedRun = internal.ephemeralRuns.get(released.name)!;
      // The end's wake has been taken: the sleep re-timed to the stated wait.
      await waitFor(fw, () => {
        const sleeper = internal.stormSleepers.get(released.name) as { until: number; retime?: boolean } | undefined;
        return sleeper?.retime === false && sleeper.until === releasedRun.statedUntil;
      }, 'asleep to its stated wait');
      assert.deepEqual(fw.releaseProviderWait(released.name, undefined, 'zz-operator').map((r) => r.release), ['storm']);
      const outcome = await released.outcome;
      assert.ok('result' in outcome, `released, it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);

      // Another run sleeps a 6 s stated wait past its storm's end; a new
      // storm arms while it does.
      membrane.nextErrors = [overloaded(529, 6_000)];
      const charged = await ephemeralRun(fw, 'eph-tail-charged');
      await waitFor(fw, () => internal.stormSleepers.has(charged.name), 'asleep in the storm');
      internal.providerStormSucceeded(fw.getAgent('a'));
      const chargedRun = internal.ephemeralRuns.get(charged.name)!;
      await waitFor(fw, () => {
        const sleeper = internal.stormSleepers.get(charged.name) as { until: number; retime?: boolean } | undefined;
        return sleeper?.retime === false && sleeper.until === chargedRun.statedUntil;
      }, 'asleep to its stated wait');
      const b = fw.getAgent('b')!;
      internal.stormSentRounds.set(b, storms.sent('zz-model'));
      internal.joinProviderStorm(b, overloaded());
      assert.ok(storms.get('zz-model'), 'a new storm');
      const armedAt = Date.now();
      // Its retry meets the new storm and sleeps again: read what it was charged.
      membrane.overloaded.add('zz-model');
      await waitFor(fw, () => membrane.callsOf('eph-tail-charged').length === 2 && internal.stormSleepers.has(charged.name), 'retried and asleep again');
      const slept = internal.ephemeralRuns.get(charged.name)!.stormSleptMs;
      assert.ok(slept >= 3_000 && slept <= Date.now() - armedAt + 200, `the ${slept} ms since the new storm armed is charged`);
      membrane.overloaded.delete('zz-model');
      fw.releaseProviderWait(charged.name, undefined, 'zz-operator');
      const after = await charged.outcome;
      assert.ok('result' in after, `it completes${'error' in after ? `: ${after.error.message}` : ''}`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a stop of the turn that lands with a step ends a run asleep in the storm at once', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(40_000, 160_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-stop-step');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      const b = fw.getAgent('b')!;
      internal.stormSentRounds.set(b, storms.sent('zz-model'));
      const stoppedAt = Date.now();
      // The step's wake and the stop's land together.
      internal.joinProviderStorm(b, overloaded());
      assert.ok(fw.abortInference(run.name, 'zz-stop'));
      const outcome = await run.outcome;
      assert.ok('error' in outcome && outcome.error.message !== 'zz-unsettled', 'it ends');
      assert.ok(Date.now() - stoppedAt < 15_000, `at once, not at its point in the new step, 40 s or more away (${Date.now() - stoppedAt} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run its watchdog ends while it sleeps in a storm is never started again, and its sleep leaves the event gate's window closed", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane, { gate: { config: { policies: [], default: 'skip' } } });
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-watchdog', 'zz-model', { idleTimeoutMs: 500, idlePollMs: 50 });
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      assert.deepEqual(internal.eventGate!.inferenceDiagnostics().inferring, [], 'asleep, it holds no window at the event gate');
      const point = internal.stormSleepers.get(run.name)!.until;
      const handle = internal.activeStreams.get(run.name)!;
      const outcome = await run.outcome;
      assert.ok('error' in outcome && outcome.error.message !== 'zz-unsettled', 'the watchdog ended it');
      // Its sleep ends with it, far short of its point, and nothing starts it again.
      const ended = await Promise.race([handle.then(() => true, () => true), sleep(3_000).then(() => false)]);
      assert.ok(ended, 'its sleeping stream ended with the run');
      assert.ok(point - Date.now() > 5_000, `its sleep ended ${point - Date.now()} ms short of its point`);
      await sleep(200);
      assert.equal(membrane.callsOf('eph-watchdog').length, 1, 'no call after its end');
      assert.equal(internal.providerGates.has(run.name), false, 'and no provider gate taken in its name');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a re-timed sleep stops where the run's storm allowance runs out, and the run then ends, saying so", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(40_000, 160_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-allowance');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      // 300 ms of its allowance left, then a step re-times its sleep.
      internal.ephemeralRuns.get(run.name)!.stormSleptMs = 600_000 - 300;
      const b = fw.getAgent('b')!;
      internal.stormSentRounds.set(b, storms.sent('zz-model'));
      const steppedAt = Date.now();
      internal.joinProviderStorm(b, overloaded());
      const outcome = await run.outcome;
      assert.ok('error' in outcome && /sleeps at most 600 s in them, so it ends now/.test(outcome.error.message),
        `it ends past its allowance${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.ok(Date.now() - steppedAt < 15_000, `when the allowance ran out, not at its point, 40 s or more away (${Date.now() - steppedAt} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a call whose answer ended a storm and then fails with a 529 arms the next storm', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const first = internal.providerStorms.get('zz-model')!;
      first.releaseAt.set('a', Date.now() - 1);
      membrane.nextStream = new ScriptedStream([text('zz-first'), { type: 'error', error: overloaded() } as StreamEvent]);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      const next = internal.providerStorms.get('zz-model');
      assert.ok(next && next !== first, "its first words ended b's storm, and its 529 armed a new one");
      assert.equal(membrane.callsOf('a').length, 1, 'with no retry of the error policy');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a call membrane makes after a call's end is stamped there: an automatic resumption's 529 steps a storm armed before that end", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      membrane.nextStream = new ScriptedStream([
        text('zz-first'), () => internal.joinProviderStorm(fw.getAgent('b'), overloaded()), usage(),
        { type: 'error', error: overloaded() } as StreamEvent,
      ]);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('a'), 'a held');
      assert.equal(internal.providerStorms.get('zz-model')!.stepMs, 2 * STEP_MS, 'its resumption was sent in the round, so its 529 steps it');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('health takes the earliest of the holds on a model for its next release, and leaves out a hold with no time', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.joinProviderStorm(fw.getAgent('a'), overloaded());
      const now = Date.now();
      const holds = internal.providerAccelerationCooldowns;
      holds.set('zz-late', { until: now + 50_000, waitModel: 'zz-model', heldRequests: [] });
      holds.set('zz-early', { until: now + 20_000, waitModel: 'zz-model', heldRequests: [] });
      holds.set('zz-released-only', { until: Number.POSITIVE_INFINITY, waitModel: 'zz-model', heldRequests: [] });
      const storm = (fw.healthSnapshot() as Health).providerStorms[0]!;
      assert.equal(storm.nextRelease, new Date(now + 20_000).toISOString());
      assert.equal(storm.heldAgents, 3);
      holds.delete('zz-late'); holds.delete('zz-early');
      const alone = (fw.healthSnapshot() as Health).providerStorms[0]!;
      assert.equal(alone.nextRelease, null, 'a hold with no time alone gives no next release');
      assert.equal(alone.heldAgents, 1);
      holds.delete('zz-released-only');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a run whose stream fails as it is made, asleep in a storm when its watchdog ends it, is never started again', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    membrane.site = 'setup';
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-setup-watchdog', 'zz-model', { idleTimeoutMs: 500, idlePollMs: 50 });
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep at its start');
      const point = internal.stormSleepers.get(run.name)!.until;
      const outcome = await run.outcome;
      assert.ok('error' in outcome && outcome.error.message !== 'zz-unsettled', 'the watchdog ended it');
      // Its sleep, inside the start the scheduler awaits, ends with it: a
      // resident's turn starts now, far short of the run's point.
      membrane.overloaded.delete('zz-model');
      internal.providerStormSucceeded(fw.getAgent('b'));
      membrane.site = 'stream';
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').length === 1, "a's turn", 3_000);
      assert.ok(point - Date.now() > 5_000, `the run's sleep ended ${point - Date.now()} ms short of its point`);
      await sleep(200);
      assert.equal(membrane.callsOf('eph-setup-watchdog').length, 1, 'no call after its end');
      assert.equal(internal.providerGates.has(run.name), false, 'and no provider gate taken in its name');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("membrane's overloaded rule decides what arms a storm: a status-less overloaded error does, a 529 that isn't retryable or a 500 with the words doesn't", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      const a = fw.getAgent('a')!;
      const notRetryable = new MembraneError({ type: 'server', retryable: false, httpStatus: 529, message: 'zz overloaded_error', rawError: {} });
      assert.equal(internal.joinProviderStorm(a, notRetryable), undefined, 'not retryable');
      const wordsOn500 = new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'zz overloaded_error (529)', rawError: {} });
      assert.equal(internal.joinProviderStorm(a, wordsOn500), undefined, 'the status decides');
      const statusless = new MembraneError({ type: 'server', retryable: true, message: 'zz overloaded_error: Overloaded', rawError: {} });
      assert.ok(internal.joinProviderStorm(a, statusless), 'with no status, the words do');
      assert.equal(internal.joinProviderStorm(a, new Error('zz overloaded_error (529)')), undefined, 'an error that is no membrane error, whatever its words');
      const wordless = new MembraneError({ type: 'server', retryable: true, httpStatus: 529, message: 'zz busy', rawError: {} });
      assert.ok(internal.joinProviderStorm(fw.getAgent('c')!, wordless), 'a 529 needs no words');
      // A provider wait's refusal sent nothing, whatever its words quote: it
      // arms no storm, and for a run it is no storm's deferral.
      const refusal = () => Object.assign(new MembraneError({ type: 'rate_limit', retryable: true, retryAfterMs: 5_000,
        message: 'Provider wait: zz-model is held (recorded: zz overloaded_error (529)); no call was made', rawError: undefined }),
        { providerAdmission: 'deferred' as const });
      internal.providerStorms.clear();
      assert.equal(internal.joinProviderStorm(fw.getAgent('c')!, refusal()), undefined, 'a refusal arms nothing');
      assert.equal(internal.providerStorms.get('zz-model'), undefined, 'no storm');
      membrane.nextStream = new ScriptedStream([text('zz-under-way'), 'hold']);
      const run = await ephemeralRun(fw, 'eph-refusal');
      await waitFor(fw, () => membrane.callsOf('eph-refusal').length === 1, 'its call under way');
      assert.equal(internal.nonOwningProviderWait(fw.getAgent(run.name)!, refusal()), undefined,
        "for a run, the error policy's: no storm's deferral");
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a storm that arms over a resident's stated-wait hold holds it to the later of the two at once", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    try {
      membrane.nextErrors = [new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 2_000, message: 'zz rate limited', rawError: { status: 429 } })];
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.get('a')?.waitModel === 'zz-model', "a held by its stated wait");
      const statedEnd = internal.providerAccelerationCooldowns.get('a')!.until;
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const point = internal.providerStorms.get('zz-model')!.releaseAt.get('a')!;
      assert.ok(point > statedEnd, 'its point lies past its stated wait');
      assert.equal(internal.providerAccelerationCooldowns.get('a')!.until, point, 'its hold moved to its point as the storm armed');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an operator's release landing with a step reaches a run asleep in the storm before it takes its new point", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(40_000, 160_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-release-step');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      const b = fw.getAgent('b')!;
      internal.stormSentRounds.set(b, storms.sent('zz-model'));
      membrane.overloaded.delete('zz-model');
      const releasedAt = Date.now();
      // The step clears every point; the release lands before the run's
      // sleep takes its new one.
      internal.joinProviderStorm(b, overloaded());
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator').map((r) => r.release), ['storm']);
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `released, it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.ok(membrane.callsOf('eph-release-step')[1]!.at - releasedAt < 15_000, 'at once, not at its point 20 s or more away');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a deferral whose storm ends before it is handled tries again at once, as no attempt of the error policy's", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      // The storm ends as the run's deferral is reported, before it is handled.
      let failedAt: number | undefined;
      fw.onTrace((event) => {
        if (event.type === 'inference:failed' && event.agentName === 'eph-race' && failedAt === undefined) {
          failedAt = Date.now();
          internal.providerStormSucceeded(fw.getAgent('a'));
        }
      });
      const run = await ephemeralRun(fw, 'eph-race');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.ok(failedAt !== undefined, 'it was deferred');
      const sent = membrane.callsOf('eph-race');
      assert.equal(sent.length, 1, 'one call, its answer');
      assert.ok(sent[0]!.at - failedAt! < 700, `at once, not after the error policy's 1 s (${sent[0]!.at - failedAt!} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a 529 whose point lies past what is left of a run's allowance sleeps what is left, and a storm ending meanwhile lets the run finish", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    const storms = internal.providerStorms;
    storms.settings = stepsOf(40_000, 160_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-left');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      // 3 s of its allowance left; released, its next 529 meets a point 20 s or more away.
      internal.ephemeralRuns.get(run.name)!.stormSleptMs = 600_000 - 3_000;
      fw.releaseProviderWait(run.name, undefined, 'zz-operator');
      await waitFor(fw, () => membrane.callsOf('eph-left').length === 2 && internal.stormSleepers.has(run.name), 'its second 529, asleep again');
      const until = internal.stormSleepers.get(run.name)!.until;
      const left = until - Date.now();
      assert.ok(left <= 3_000 && left >= 1_500, `it sleeps what is left of its allowance (${left} ms), not to its point`);
      // The storm ends while it sleeps: it tries again and finishes.
      membrane.overloaded.delete('zz-model');
      internal.providerStormSucceeded(fw.getAgent('a'));
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run whose allowance runs out before its stated wait sends nothing more: the wait holds it past its point, and the run ends", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(1_000, 1_000);
    try {
      // Its 529 states 4 s; its point is under 1 s off; 1.5 s of its allowance
      // is left as the failure is handled.
      membrane.overloaded.add('zz-model');
      membrane.stated = 4_000;
      let failedAt: number | undefined;
      fw.onTrace((event) => {
        const run = internal.ephemeralRuns.get('eph-stated-left');
        if (event.type === 'inference:failed' && event.agentName === 'eph-stated-left' && run && run.stormSleptMs === 0) {
          failedAt = Date.now();
          run.stormSleptMs = 600_000 - 1_500;
        }
      });
      const run = await ephemeralRun(fw, 'eph-stated-left');
      const outcome = await run.outcome;
      assert.ok(Date.now() - failedAt! >= 1_490, `it slept what was left of its allowance first (${Date.now() - failedAt!} ms)`);
      assert.ok('error' in outcome && /sleeps at most 600 s/.test(outcome.error.message),
        `it ends past its allowance${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.equal(membrane.callsOf('eph-stated-left').length, 1, 'nothing sent before the stated wait passed');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run slept past its allowance with nothing left to wait for tries at once rather than ending", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      // Its 529 joins a storm armed in the same round, its point in it has
      // passed, and a timer's lateness has slept it 0.5 s past its allowance:
      // nothing holds it, and the model answers its retry.
      membrane.overloaded.add('zz-model');
      fw.onTrace((event) => {
        const run = internal.ephemeralRuns.get('eph-overslept');
        if (event.type === 'inference:failed' && event.agentName === 'eph-overslept' && run && run.stormSleptMs === 0) {
          run.stormSleptMs = 600_000 + 500;
          internal.providerStorms.failed('zz-model', undefined, 'zz overloaded_error', Date.now());
          internal.providerStorms.get('zz-model')!.releaseAt.set('eph-overslept', Date.now() - 1);
          membrane.overloaded.delete('zz-model');
        }
      });
      const run = await ephemeralRun(fw, 'eph-overslept');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it tries again and completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.equal(membrane.callsOf('eph-overslept').length, 2, 'its retry went at once');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a deferral whose storm ends before it is handled waits out a wait the provider stated on that storm, then tries again", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(20_000, 20_000);
    try {
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      let failedAt: number | undefined;
      let failures = 0;
      fw.onTrace((event) => {
        if (event.type === 'inference:failed' && event.agentName === 'eph-race-stated') failures++;
        if (event.type === 'inference:failed' && event.agentName === 'eph-race-stated' && failedAt === undefined) {
          failedAt = Date.now();
          internal.ephemeralRuns.get('eph-race-stated')!.statedUntil = failedAt + 1_500;
          internal.providerStormSucceeded(fw.getAgent('a'));
        }
      });
      const run = await ephemeralRun(fw, 'eph-race-stated');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const sent = membrane.callsOf('eph-race-stated');
      assert.equal(sent.length, 1, 'one call, its answer');
      assert.ok(sent[0]!.at - failedAt! >= 1_490, `not before the stated wait (${sent[0]!.at - failedAt!} ms)`);
      // It slept the wait once: a retry at once would compile, meet the
      // stated wait after its compile and be deferred again, round after round.
      assert.equal(failures, 1, 'deferred once');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run whose storm ends while its retry compiles still waits out the wait the provider stated on that storm", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(1_000, 1_000);
    try {
      // Its 529 states 3 s; half a second of its allowance is left, so its
      // sleep stops there; the storm ends as its retry starts.
      membrane.overloaded.add('zz-model');
      membrane.stated = 3_000;
      let failedAt: number | undefined;
      let starts = 0;
      fw.onTrace((event) => {
        if ((event as { agentName?: string }).agentName !== 'eph-stated-ended') return;
        if (event.type === 'inference:failed' && failedAt === undefined) {
          failedAt = Date.now();
          internal.ephemeralRuns.get('eph-stated-ended')!.stormSleptMs = 600_000 - 500;
        }
        if (event.type === 'inference:started' && ++starts === 2) {
          membrane.overloaded.delete('zz-model');
          internal.providerStormSucceeded(fw.getAgent('a'));
        }
      });
      const run = await ephemeralRun(fw, 'eph-stated-ended');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const sent = membrane.callsOf('eph-stated-ended');
      assert.equal(sent.length, 2, 'its 529, then its answer');
      assert.ok(starts >= 2, 'its retry started');
      assert.ok(sent[1]!.at - failedAt! >= 2_990, `not before the stated wait (${sent[1]!.at - failedAt!} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run's stated wait past ten minutes ends it, from a membrane error of another copy that carries no retryable too", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw } = await framework(path, membrane);
    try {
      membrane.nextErrors = [Object.assign(new Error('zz rate limited'), {
        name: 'MembraneError', type: 'rate_limit', httpStatus: 429, retryAfterMs: 1_200_000,
      })];
      const run = await ephemeralRun(fw, 'eph-foreign-long');
      const outcome = await run.outcome;
      assert.ok('error' in outcome && /asked to wait 1200 s/.test(outcome.error.message),
        `it ends, saying why${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.equal(membrane.callsOf('eph-foreign-long').length, 1, 'nothing more sent');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an operator's release lifts a run's stated wait while its retry is under way, not only while it sleeps", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      // The run streams, its call under way; a storm stands on its model, and
      // a wait an earlier 529 stated still binds it.
      membrane.nextStream = new ScriptedStream([text('zz-under-way'), 'hold']);
      const run = await ephemeralRun(fw, 'eph-release-under-way');
      await waitFor(fw, () => membrane.callsOf('eph-release-under-way').length === 1, 'its call under way');
      internal.joinProviderStorm(fw.getAgent('b'), overloaded());
      const state = internal.ephemeralRuns.get(run.name)!;
      state.statedUntil = Date.now() + 60_000;
      assert.equal(internal.stormSleepers.has(run.name), false, 'not asleep');
      // Another model's release, or a stated wait that has passed, lifts
      // nothing.
      assert.deepEqual(fw.releaseProviderWait(run.name, 'zz-other-model', 'zz-operator'), [], "another model's");
      const until = state.statedUntil;
      state.statedUntil = Date.now() - 1;
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator'), [], 'a wait that has passed');
      state.statedUntil = until;
      // No point drawn for it in this round (a step clears them): the stated
      // wait is what holds it.
      const storm = internal.providerStorms.get('zz-model')!;
      assert.equal(storm.releaseAt.has(run.name), false, 'no point drawn');
      const receipt = fw.releaseProviderWait(run.name, undefined, 'zz-operator');
      assert.deepEqual(receipt.map((r) => r.release), ['storm']);
      assert.equal(receipt[0]!.until, new Date(until!).toISOString(), 'listed until its stated wait would have ended');
      assert.equal(state.statedUntil, undefined, 'its stated wait is lifted');
      // Released from the storm's round too, so its check after a compile
      // doesn't draw it a point and hold it again.
      assert.equal(internal.providerStorms.holdUntil(run.name, 'zz-model'), undefined, 'the storm holds it no more this round');
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator'), [], 'released, a second release lifts nothing');
      // The receipt lists the later of its point and its stated wait: a point
      // passed with the stated wait ahead, then a point ahead of it.
      const stated = Date.now() + 60_000;
      state.statedUntil = stated;
      storm.releaseAt.set(run.name, Date.now() - 1_000);
      assert.equal(fw.releaseProviderWait(run.name, undefined, 'zz-operator')[0]?.until, new Date(stated).toISOString(),
        'its point passed: until its stated wait');
      const point = Date.now() + 60_000;
      state.statedUntil = Date.now() + 5_000;
      storm.releaseAt.set(run.name, point);
      assert.equal(fw.releaseProviderWait(run.name, undefined, 'zz-operator')[0]?.until, new Date(point).toISOString(),
        'its point ahead of its stated wait: until its point');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run asleep in a storm says it is waiting each step, so the host's reaper doesn't reclaim it, and says nothing after its release", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(8_000, 8_000);
    internal.waitingTraceEveryMs = 150;
    const waiting: Array<{ at: number; until?: number; sleeperUntil?: number; reason: string }> = [];
    let failedAt: number | undefined;
    fw.onTrace((event) => {
      if (event.type === 'inference:failed' && event.agentName === 'eph-waiting' && failedAt === undefined) failedAt = Date.now();
      if (event.type === 'inference:waiting' && event.agentName === 'eph-waiting') {
        waiting.push({ at: Date.now(), until: event.until, sleeperUntil: internal.stormSleepers.get('eph-waiting')?.until, reason: event.reason });
      }
    });
    // Two steps' silence, and 400 ms for a loaded host's timers.
    const reaper = reaperCopy(fw, 'eph-waiting', 2 * 150 + 400);
    try {
      // Its 529 arms a storm; its point is 4 to 8 s off.
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-waiting');
      await waitFor(fw, () => waiting.length >= 4, 'it says it is waiting, step after step');
      assert.ok(waiting[0]!.at - failedAt! >= 140, `not as it starts: a step after its failure (${waiting[0]!.at - failedAt!} ms)`);
      // Other agents' 529s step the storm every 100 ms, each step waking the
      // run to sleep to its point in the new step: it still says so on time.
      const b = fw.getAgent('b')!;
      const before = waiting.length;
      const stepping = Date.now();
      while (Date.now() - stepping < 1_200) {
        await sleep(100);
        internal.stormSentRounds.set(b, internal.providerStorms.sent('zz-model'));
        internal.joinProviderStorm(b, overloaded());
      }
      assert.ok(waiting.length - before >= 5, `woken at every step, it still said so (${waiting.length - before} times)`);
      assert.ok(waiting.every((w) => w.reason === 'capacity-storm' && w.until === w.sleeperUntil), 'each until its point as it stood');
      assert.equal(reaper.reclaimable(), false, "the reaper's copy never finds it silent");
      // Released, it tries at once; the model answers, and no wait is left.
      membrane.overloaded.delete('zz-model');
      const said = waiting.length;
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator').map((r) => r.release), ['storm']);
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator'), [], 'released, a second release lists nothing');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      await sleep(600);
      assert.equal(waiting.length, said, 'nothing after the release');
    } finally { reaper.stop(); await fw.stop(); log.restore(); }
  });
});

test("a retry the error policy holds says it is waiting each step, to its stated wait or its backoff; an abort ends it with nothing after, and a short retry says nothing", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.waitingTraceEveryMs = 150;
    const waiting: Array<{ at: number; agent: string; until?: number; reason: string }> = [];
    const failed = new Map<string, number>();
    fw.onTrace((event) => {
      if (event.type === 'inference:failed' && !failed.has(event.agentName)) failed.set(event.agentName, Date.now());
      if (event.type === 'inference:waiting') waiting.push({ at: Date.now(), agent: event.agentName, until: event.until, reason: event.reason });
    });
    const reaper = reaperCopy(fw, 'eph-retry-waiting', 2 * 150 + 400);
    const rateLimited = (retryAfterMs: number) => new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs, message: 'zz rate limited', rawError: {},
    });
    try {
      // A 429 stating 1.2 s: the policy waits it out, and the retry answers.
      membrane.nextErrors = [rateLimited(1_200)];
      const failedAt = Date.now();
      const run = await ephemeralRun(fw, 'eph-retry-waiting');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      const mine = waiting.filter((w) => w.agent === run.name);
      assert.ok(mine.length >= 4, `it said it was waiting each step (${mine.length})`);
      assert.ok(mine.every((w) => w.reason === 'retry' && w.until === mine[0]!.until), 'each until the one wait\'s end');
      assert.ok(mine[0]!.until! >= failedAt + 1_200 && mine[0]!.until! <= failedAt + 1_200 + 500,
        `its end is the stated time (${mine[0]!.until! - failedAt} ms after the start)`);
      assert.equal(reaper.reclaimable(), false, "the reaper's copy never finds it silent");

      // The same 429 thrown as the stream is made: the start's retry says so too.
      membrane.site = 'setup';
      membrane.nextErrors = [rateLimited(900)];
      const atSetup = await ephemeralRun(fw, 'eph-retry-setup');
      const setupOutcome = await atSetup.outcome;
      membrane.site = 'stream';
      assert.ok('result' in setupOutcome, `it completes${'error' in setupOutcome ? `: ${setupOutcome.error.message}` : ''}`);
      const atStart = waiting.filter((w) => w.agent === atSetup.name);
      assert.ok(atStart.length >= 3 && atStart.every((w) => w.reason === 'retry'), "the start's retry said it was waiting");
      const setupFailedAt = failed.get(atSetup.name)!;
      assert.ok(atStart[0]!.at - setupFailedAt >= 140, `not as it starts (${atStart[0]!.at - setupFailedAt} ms after the failure)`);
      // Its 900 ms stated wait is shorter than the policy's first backoff, 1 s.
      assert.ok(atStart.every((w) => w.until === atStart[0]!.until && w.until! >= setupFailedAt + 1_000 - 20 && w.until! <= setupFailedAt + 1_000 + 500),
        `each until the backoff's end (${atStart[0]!.until! - setupFailedAt} ms after the failure)`);

      // A 429 stating 30 s, aborted mid-wait: nothing after the abort.
      membrane.nextErrors = [rateLimited(30_000)];
      const aborted = await ephemeralRun(fw, 'eph-retry-aborted');
      await waitFor(fw, () => waiting.some((w) => w.agent === aborted.name), 'waiting');
      assert.ok(fw.abortInference(aborted.name, 'zz-stop'));
      const said = waiting.filter((w) => w.agent === aborted.name).length;
      await aborted.outcome;
      await sleep(600);
      assert.equal(waiting.filter((w) => w.agent === aborted.name).length, said, 'nothing after the abort');

      // A 500 waits the policy's 1 s, under a step: nothing said.
      internal.waitingTraceEveryMs = 60_000;
      membrane.nextErrors = [overloaded(500)];
      const short = await ephemeralRun(fw, 'eph-retry-short');
      const shortOutcome = await short.outcome;
      assert.ok('result' in shortOutcome && membrane.callsOf(short.name).length === 2, 'it waited its retry and the retry answered');
      assert.equal(waiting.filter((w) => w.agent === short.name).length, 0, 'a short retry says nothing');

      // A 429 stating 30 s when the framework stops: nothing after the stop.
      internal.waitingTraceEveryMs = 150;
      membrane.nextErrors = [rateLimited(30_000)];
      const stopped = await ephemeralRun(fw, 'eph-retry-stopped');
      await waitFor(fw, () => waiting.some((w) => w.agent === stopped.name), 'waiting');
      await fw.stop();
      const saidAtStop = waiting.filter((w) => w.agent === stopped.name).length;
      await sleep(600);
      assert.equal(waiting.filter((w) => w.agent === stopped.name).length, saidAtStop, 'nothing after the stop');
    } finally { reaper.stop(); await fw.stop(); log.restore(); }
  });
});

test("a run its storm's end has woken with nothing left to wait for is about to try: a release lists nothing", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(8_000, 8_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-woken-at-end');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      membrane.overloaded.delete('zz-model');
      // The storm ends and wakes it; before it has tried, a release finds
      // nothing holding it.
      internal.providerStormSucceeded(fw.getAgent('a'));
      assert.deepEqual(fw.releaseProviderWait(run.name, undefined, 'zz-operator'), [], 'nothing to release');
      const outcome = await run.outcome;
      assert.ok('result' in outcome, `it tries and completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a wait says it is waiting only for the agent still registered under its name, and a stop ends it even if admission reopens at once", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.waitingTraceEveryMs = 50;
    const waiting: string[] = [];
    fw.onTrace((event) => { if (event.type === 'inference:waiting') waiting.push(event.agentName); });
    try {
      const said = () => ({ at: Date.now() - 1_000 });
      // A registered agent's wait says so; one for an Agent no longer under
      // its name (a replaced agent, a disposed fork) says nothing.
      await internal.waitForRetry(200, { abandoned: false }, { agent: fw.getAgent('a'), reason: 'retry', until: Date.now() + 200, said: said() });
      assert.ok(waiting.filter((n) => n === 'a').length >= 2, 'the registered agent says so');
      const gone = Object.create(fw.getAgent('b')!) as unknown;
      await internal.waitForRetry(200, { abandoned: false }, { agent: gone, reason: 'retry', until: Date.now() + 200, said: said() });
      assert.equal(waiting.filter((n) => n === 'b').length, 0, 'an agent not under its name says nothing');

      // stop()'s waker ends the wait itself: admission reopening before the
      // wait's continuation (a start()) doesn't revive it.
      // (A wait in steps, as a wait on the provider's behalf is.)
      const started = Date.now();
      const wait = internal.waitForRetry(5_000, { abandoned: false }, { agent: gone, reason: 'retry', until: Date.now() + 5_000, said: { at: Date.now() } });
      for (const wake of [...internal.retryWaitWakers]) wake();
      internal.providerAdmissionClosed = false;
      await wait;
      assert.ok(Date.now() - started < 1_000, `the wait ended at the stop (${Date.now() - started} ms)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a wait whose agent is gone keeps its steps, a listener's stop ends it at once, a late timer doesn't lengthen it, and the interval has its fallback", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.waitingTraceEveryMs = 50;
    const a = fw.getAgent('a')!;
    try {
      // An agent no longer under its name: its wait still steps at the
      // cadence, not once a millisecond.
      const gone = Object.create(fw.getAgent('b')!) as unknown;
      const realSetTimeout = globalThis.setTimeout;
      let timers = 0;
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { timers++; return realSetTimeout(...args); }) as typeof setTimeout;
      try {
        await internal.waitForRetry(400, { abandoned: false }, { agent: gone, reason: 'retry', until: Date.now() + 400, said: { at: Date.now() - 1_000 } });
      } finally { globalThis.setTimeout = realSetTimeout; }
      assert.ok(timers < 40, `it stepped at its cadence (${timers} timers in 400 ms)`);

      // A listener of inference:waiting that ends the wait (an abort's or a
      // release's waker) ends it at once, the first time it says so too.
      // (A cadence of 2 s, so a wait that went on would take its next step.)
      internal.waitingTraceEveryMs = 2_000;
      const window: { abandoned: boolean; wake?: () => void } = { abandoned: false };
      const unsubscribe = fw.onTrace((event) => { if (event.type === 'inference:waiting' && event.agentName === 'a') window.wake?.(); });
      let started = Date.now();
      await internal.waitForRetry(5_000, window, { agent: a, reason: 'retry', until: Date.now() + 5_000, said: { at: Date.now() - 3_000 } });
      unsubscribe();
      assert.ok(Date.now() - started < 1_000, `the listener's wake ended it (${Date.now() - started} ms)`);
      assert.equal(internal.retryWaitWakers.size, 0, 'and left no waker for stop() to call');
      // So does a listener that stops the framework's waits, as stop() does.
      const stopping = fw.onTrace((event) => {
        if (event.type === 'inference:waiting' && event.agentName === 'a') for (const wake of [...internal.retryWaitWakers]) wake();
      });
      started = Date.now();
      await internal.waitForRetry(5_000, { abandoned: false }, { agent: a, reason: 'retry', until: Date.now() + 5_000, said: { at: Date.now() - 3_000 } });
      stopping();
      assert.ok(Date.now() - started < 1_000, `a stop from a listener ended it (${Date.now() - started} ms)`);
      // A wait woken mid-step leaves no timer running: its step's timer is
      // cleared.
      const window2: { abandoned: boolean; wake?: () => void } = { abandoned: false };
      const realSet = globalThis.setTimeout;
      const realClear = globalThis.clearTimeout;
      const made: unknown[] = [];
      const cleared = new Set<unknown>();
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { const t = realSet(...args); made.push(t); return t; }) as typeof setTimeout;
      globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => { cleared.add(t); realClear(t); }) as typeof clearTimeout;
      let woken: Promise<void>;
      try {
        woken = internal.waitForRetry(5_000, window2, { agent: a, reason: 'retry', until: Date.now() + 5_000, said: { at: Date.now() } });
      } finally { globalThis.setTimeout = realSet; }
      const step = made[made.length - 1];
      await sleep(20);
      window2.wake!();
      await woken;
      globalThis.clearTimeout = realClear;
      assert.ok(step !== undefined && cleared.has(step), 'its step timer is cleared');
      internal.waitingTraceEveryMs = 50;

      // A listener that holds the event loop 400 ms: the wait still ends
      // about its length after it began, and says nothing once its end has
      // passed.
      const said: Array<{ at: number; until?: number }> = [];
      let blocked = false;
      const blocking = fw.onTrace((event) => {
        if (event.type !== 'inference:waiting' || event.agentName !== 'a') return;
        said.push({ at: Date.now(), until: event.until });
        if (!blocked) { blocked = true; const until = Date.now() + 400; while (Date.now() < until) { /* hold the loop */ } }
      });
      started = Date.now();
      await internal.waitForRetry(600, { abandoned: false }, { agent: a, reason: 'retry', until: started + 600, said: { at: started } });
      blocking();
      assert.ok(Date.now() - started < 850, `it ended near its length (${Date.now() - started} ms)`);
      assert.ok(said.length >= 2 && said.every((w) => w.at < w.until!), 'never said with its end passed');

      // The cadence's clock moves on as it says so, before its listeners
      // run: a listener holding the loop 400 ms doesn't push the next event
      // out by its 400 ms.
      internal.waitingTraceEveryMs = 300;
      const paced: number[] = [];
      let held = false;
      const pacing = fw.onTrace((event) => {
        if (event.type !== 'inference:waiting' || event.agentName !== 'a') return;
        paced.push(Date.now());
        if (!held) { held = true; const until = Date.now() + 400; while (Date.now() < until) { /* hold the loop */ } }
      });
      await internal.waitForRetry(1_200, { abandoned: false }, { agent: a, reason: 'retry', until: Date.now() + 1_200, said: { at: Date.now() - 300 } });
      pacing();
      assert.ok(paced.length >= 2 && paced[1]! - paced[0]! < 600, `the next came when due, ${paced[1]! - paced[0]!} ms after the first`);
      internal.waitingTraceEveryMs = 50;

      // A caller's until sooner than the wait's length is its end.
      started = Date.now();
      await internal.waitForRetry(2_000, { abandoned: false }, { agent: a, reason: 'retry', until: Date.now() + 200, said: { at: Date.now() } });
      assert.ok(Date.now() - started < 1_000, `it ended at the until (${Date.now() - started} ms)`);

      // An end too far off to be a date, or none, is left out.
      const ends: Array<{ wait: string; has: boolean }> = [];
      let current = '';
      const ending = fw.onTrace((event) => { if (event.type === 'inference:waiting' && event.agentName === 'a') ends.push({ wait: current, has: 'until' in event }); });
      for (const [wait, end] of [['no end', () => Infinity], ['past a date', () => 9e15], ['a date', () => Date.now() + 80]] as const) {
        current = wait;
        await internal.waitForRetry(80, { abandoned: false }, { agent: a, reason: 'capacity-storm', until: end(), said: { at: Date.now() - 1_000 } });
      }
      ending();
      for (const wait of ['no end', 'past a date', 'a date']) {
        const said = ends.filter((e) => e.wait === wait);
        assert.ok(said.length >= 1 && said.every((e) => e.has === (wait === 'a date')), `until only where it is a date (${wait})`);
      }

      // A framework built without the field (from its prototype) keeps the
      // cadence's constant: the wait lasts its length.
      delete (internal as { waitingTraceEveryMs?: number }).waitingTraceEveryMs;
      const fallback: number[] = [];
      const counting = fw.onTrace((event) => { if (event.type === 'inference:waiting' && event.agentName === 'a') fallback.push(Date.now()); });
      started = Date.now();
      // Last said 59.8 s ago: the constant's 60 s come due once, 200 ms in.
      await internal.waitForRetry(400, { abandoned: false }, { agent: a, reason: 'retry', until: Date.now() + 400, said: { at: Date.now() - 59_800 } });
      counting();
      assert.ok(Date.now() - started >= 380, `it waited its length (${Date.now() - started} ms)`);
      assert.equal(fallback.length, 1, 'it said so once, at the constant cadence');
      assert.ok(fallback[0]! - started >= 150, `when 60 s had passed (${fallback[0]! - started} ms in)`);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a run that ends as a step re-times its storm sleep sleeps no more", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.providerStorms.settings = stepsOf(8_000, 8_000);
    try {
      membrane.overloaded.add('zz-model');
      const run = await ephemeralRun(fw, 'eph-ended-at-step');
      await waitFor(fw, () => internal.stormSleepers.has(run.name), 'asleep in the storm');
      // The run's end takes it off the runs (as its watchdog's end does
      // first), and a step's retime lands before its sleep reads the wake.
      membrane.overloaded.delete('zz-model');
      const state = internal.ephemeralRuns.get(run.name)!;
      internal.ephemeralRuns.delete(run.name);
      (internal.stormSleepers.get(run.name) as unknown as { wake(): void }).wake();
      await waitFor(fw, () => !internal.stormSleepers.has(run.name), 'its sleep ended', 1_000);
      internal.ephemeralRuns.set(run.name, state);
      await run.outcome;
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a retry the error policy holds ends with its run, and says nothing after", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    internal.waitingTraceEveryMs = 150;
    const waiting: Array<{ at: number; agent: string }> = [];
    fw.onTrace((event) => { if (event.type === 'inference:waiting') waiting.push({ at: Date.now(), agent: event.agentName }); });
    try {
      // A 429 stating 5 s; the run's idle watchdog ends it at 700 ms.
      membrane.nextErrors = [new MembraneError({
        type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 5_000, message: 'zz rate limited', rawError: {},
      })];
      const run = await ephemeralRun(fw, 'eph-retry-ended', 'zz-model', { idleTimeoutMs: 700, idlePollMs: 50 });
      await waitFor(fw, () => internal.retryWaitWakers.size === 1, 'its retry waits');
      const outcome = await run.outcome;
      const endedAt = Date.now();
      assert.ok('error' in outcome, 'its watchdog ends it');
      // The wait itself ended with the run, long before its 5 s.
      await waitFor(fw, () => internal.retryWaitWakers.size === 0, 'its retry wait ended', 1_000);
      assert.ok(waiting.some((w) => w.agent === run.name), 'it said it was waiting while it was');
      await sleep(600);
      assert.equal(waiting.filter((w) => w.agent === run.name && w.at > endedAt).length, 0, 'nothing after its end');
      assert.equal(membrane.callsOf(run.name).length, 1, 'and its retry starts nothing');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("turn calls and compression calls ask membrane for no retries; Agent.runInference keeps membrane's", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new StormMembrane();
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { agents: ['a'] } });
      await waitFor(fw, () => membrane.callsOf('a').some((call) => call.ok), 'a answered');
      const turn = membrane.options.find((call) => call.method === 'streamYielding')!;
      assert.equal(turn.options?.retry, false, 'a turn call');
      // An Agent driven without the framework keeps membrane's retries.
      membrane.options.length = 0;
      const own = await fw.getAgent('a')!.startStream([]);
      own.stream.cancel();
      const standalone = membrane.options.find((call) => call.method === 'streamYielding')!;
      assert.equal('retry' in (standalone.options ?? {}), false, "an Agent's own stream");
      fw.getAgent('a')!.reset();

      const signal = new AbortController().signal;
      await internal.auxiliaryMembraneFor('a').complete(auxRequest('zz-model'), { signal });
      const compression = membrane.options.find((call) => call.method === 'complete')!;
      assert.equal(compression.options?.retry, false, 'a compression call');
      assert.equal(compression.options?.signal, signal, "the caller's own options are kept");
      membrane.options.length = 0;
      await internal.auxiliaryMembraneFor('a').complete(auxRequest('zz-model'), { retry: true });
      assert.equal(membrane.options[0]?.options?.retry, false, "a caller's own retry is overridden");
      membrane.options.length = 0;
      await internal.auxiliaryMembraneFor('a').complete(auxRequest('zz-model'));
      assert.deepEqual(membrane.options[0]?.options, { retry: false }, 'with no options, only retry: false');

      // An ephemeral run's context manager takes no admission, but its calls ask for no retries too.
      const { contextManager, cleanup } = await fw.createEphemeralAgent({ name: 'eph-options', model: 'zz-model', systemPrompt: 'zz-agent-eph' });
      const other = await fw.createEphemeralAgent({ name: 'eph-options-2', model: 'zz-model', systemPrompt: 'zz-agent-eph' });
      const runMembrane = (cm: unknown) => (cm as { membrane: { complete(request: unknown): Promise<unknown> } }).membrane;
      membrane.options.length = 0;
      await runMembrane(contextManager).complete(auxRequest('zz-model'));
      assert.deepEqual(membrane.options[0]?.options, { retry: false }, "a run's compression call");
      // Every run's context manager is handed one membrane, as every run shared the framework's.
      assert.equal(runMembrane(other.contextManager), runMembrane(contextManager), 'one membrane for every run');
      cleanup();
      other.cleanup();

      await fw.getAgent('a')!.runInference([]);
      const direct = membrane.options.find((call) => call.method === 'stream')!;
      assert.ok(direct, 'runInference called stream()');
      assert.equal('retry' in (direct.options ?? {}), false, "runInference's call keeps membrane's retries");
    } finally { await fw.stop(); log.restore(); }
  });
});

describe('the default error policy', () => {
  type Policy = { onInferenceError(error: Error, agentName: string, attempt: number): { retry: boolean; delayMs?: number } };
  const withPolicy = (fn: (policy: Policy) => void): Promise<void> => withStoreDir(async (path) => {
    const { fw } = await framework(path, new StormMembrane());
    try {
      fn((fw as unknown as { errorPolicy: Policy }).errorPolicy);
    } finally {
      await fw.stop();
    }
  });
  const failure = (fields: { type?: string; retryable?: boolean; httpStatus?: number; retryAfterMs?: number } = {}) =>
    new MembraneError({
      type: 'server', retryable: true, httpStatus: 500, message: 'zz internal server error', rawError: undefined, ...fields,
    } as ConstructorParameters<typeof MembraneError>[0]);
  const waits = (policy: Policy, error: Error) =>
    [0, 1, 2, 3].map((attempt) => policy.onInferenceError(error, 'a', attempt)).map((a) => (a.retry ? a.delayMs : 'ends'));

  it('a retryable failure is tried four times in all, retried at 1, 2 and 4 s', async () => {
    await withPolicy((policy) => {
      assert.deepEqual(waits(policy, failure()), [1_000, 2_000, 4_000, 'ends']);
      assert.deepEqual(waits(policy, failure({ type: 'rate_limit', httpStatus: 429 })), [1_000, 2_000, 4_000, 'ends'], 'a rate limit too');
      assert.deepEqual(waits(policy, new Error('zz socket hang up')), [1_000, 2_000, 4_000, 'ends'], 'a failure that is not a membrane error too');
    });
  });

  it('a failure that may not be retried ends on its first try', async () => {
    await withPolicy((policy) => {
      assert.deepEqual(policy.onInferenceError(failure({ type: 'invalid_request', retryable: false, httpStatus: 400 }), 'a', 0), { retry: false });
    });
  });

  it("a provider's stated wait only lengthens a retry's wait", async () => {
    await withPolicy((policy) => {
      const limited = (retryAfterMs: number) => failure({ type: 'rate_limit', httpStatus: 429, retryAfterMs });
      assert.deepEqual(policy.onInferenceError(limited(200), 'a', 0), { retry: true, delayMs: 1_000 }, 'shorter than the backoff: the backoff');
      assert.deepEqual(policy.onInferenceError(limited(5_000), 'a', 0), { retry: true, delayMs: 5_000 }, 'longer: the stated wait');
      assert.deepEqual(policy.onInferenceError(limited(7_200_000), 'a', 0), { retry: true, delayMs: 7_200_000 }, 'however long: no ceiling');
      assert.deepEqual(policy.onInferenceError(limited(3_000), 'a', 2), { retry: true, delayMs: 4_000 }, 'at the third retry, 4 s');
      assert.deepEqual(policy.onInferenceError(limited(Infinity), 'a', 0), { retry: false }, 'a wait nobody can wait out ends the turn');
      assert.deepEqual(policy.onInferenceError(limited(Number.NaN), 'a', 0), { retry: true, delayMs: 1_000 }, 'NaN states none');
      assert.deepEqual(policy.onInferenceError(limited(-5_000), 'a', 0), { retry: true, delayMs: 1_000 }, 'a negative wait loses to the backoff');
      const spelled = Object.assign(limited(0), { retryAfterMs: '2000' as unknown as number });
      assert.deepEqual(policy.onInferenceError(spelled, 'a', 0), { retry: true, delayMs: 1_000 }, 'a wait is stated only as a number');
    });
  });

  it("a 529 met outside a storm takes the retryable schedule, unjittered", async () => {
    await withPolicy((policy) => {
      for (let i = 0; i < 3; i++) assert.deepEqual(waits(policy, overloaded()), [1_000, 2_000, 4_000, 'ends']);
    });
  });
});
