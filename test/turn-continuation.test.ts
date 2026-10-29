/**
 * A turn's continuation (a budget restart's, or a tool-result guard's retry)
 * holds no turn token until its start takes one, so between its turn's
 * stream ending and its start the turn has no token. It is alive all the
 * same: drain waits for it, `activeTurnAgents` names it, a fresh wake and an
 * operator call that needs the agent idle wait for it, and an abandon or a
 * stop ends it with the continuation dropped. A provider wait stated while
 * the round's tool runs holds the continuation, which is what makes that
 * stretch long. An abandon, stop(), the inference policy, the agent's
 * removal and a conversation agent's disposal each drop the continuation and
 * end the turn.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, InferenceRequest, Module, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework, OperatorActionError } from '../src/index.js';
import { setAbandonGraceForTests } from '../src/framework.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';
import type { StreamEvent } from '@animalabs/membrane';

/** Long enough that no test sees it pass: a test that wants the continuation
 *  to start ends the wait itself (releaseProviderWait). */
const WAIT_MS = 120_000;
const QUIESCE_MS = 500;
const MID = 'Arrived while the turn waited for its continuation.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(10);
  }
}

interface Internals {
  providerWaits: { set(agent: string, model: string, ms: number, reason: string): unknown };
  providerAccelerationCooldowns: Map<string, { heldRequests: InferenceRequest[]; emptiedBy?: 'drop' | 'withdrawal' }>;
  deferredMessages: unknown[];
  processInferenceRequests(): Promise<void>;
  activeTurnTokens: Map<string, number>;
  providerAccelerationRecoveries: Map<string, unknown>;
  openLogical: Map<string, unknown>;
  frameworkCancelledStreams: Map<string, unknown>;
  eventGate: unknown;
  pendingRequests: InferenceRequest[];
  activeStreams: Map<string, Promise<void>>;
  providerAdmissionClosed: boolean;
  startAgentStream(agent: unknown, trigger?: InferenceRequest): Promise<void>;
  disposeConversationAgent(name: string): void;
  agents: Map<string, unknown>;
  providerGate(name: string): { auxiliaryInFlight: number; idleWaiters: Array<() => void>; primaryDepth: number; primaryPending: boolean };
  providerHoldHook: ((error: Error, agentName: string) => { holdMs: number; reason: string } | undefined) | undefined;
  holdProviderAcceleration(agent: unknown, error: Error, trigger?: InferenceRequest, auxiliary?: boolean): boolean;
  pushCoalescer: unknown;
}
const internals = (framework: AgentFramework) => framework as unknown as Internals;

// A tool boundary's cancel that throws raises an operator alert; no test here posts it to a webhook.
delete process.env.CONNECTOME_OPS_WEBHOOK;

/** A stream whose `aborted` event, once cancelled, waits for `released`:
 *  the frame that drives it keeps the turn's token until then. */
class TeardownHeldStream extends MockYieldingStream {
  constructor(private readonly released: Promise<void>, responses: NormalizedResponse[]) {
    super(responses);
  }

  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) {
      if (next.value.type === 'aborted') await this.released;
      yield next.value;
    }
  }
}

/** A stream whose first cancel() throws, as a host's stream can. */
class CancelThrowsOnceStream extends MockYieldingStream {
  threw = false;
  cancels = 0;
  override cancel(): void {
    this.cancels++;
    if (!this.threw) {
      this.threw = true;
      throw new Error('the stream refused its cancel');
    }
    super.cancel();
  }

  /** The provider ends the stream with an error of its own. */
  fail(message: string): void {
    const own = this as unknown as { events: StreamEvent[]; _done: boolean; pendingResolve: (() => void) | null };
    own._done = true;
    own.events.push({ type: 'error', error: new Error(message) } as StreamEvent);
    const resolve = own.pendingResolve;
    own.pendingResolve = null;
    resolve?.();
  }
}

/** A stream whose first cancel() works and whose later ones throw. Its
 *  `aborted` event waits for `released`; it then yields that event, or with
 *  `throwAtEnd` throws instead, by when a newer stream has taken its agent. */
class SupersededStream extends MockYieldingStream {
  cancels = 0;
  constructor(private readonly released: Promise<void>, private readonly throwAtEnd: boolean, responses: NormalizedResponse[]) {
    super(responses);
  }

  override cancel(): void {
    if (++this.cancels > 1) throw new Error('the stream refused a second cancel');
    super.cancel();
  }

  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) {
      if (next.value.type === 'aborted') {
        await this.released;
        if (this.throwAtEnd) throw new Error('the stream failed after a newer one took its agent');
      }
      yield next.value;
    }
  }
}

/** Responses in order, one per stream unless `perStream` gives a stream
 *  more (a stream with a tool round answers each round with the next).
 *  `make` can build a stream of its own for a stream's index. */
class SequentialStreamMembrane extends MockMembrane {
  private responseIdx = 0;
  readonly streams: MockYieldingStream[] = [];
  constructor(
    private readonly perStream: number[] = [],
    private readonly make?: (index: number, responses: NormalizedResponse[]) => MockYieldingStream | undefined,
  ) { super(); }
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const count = this.perStream[this.streams.length] ?? 1;
    const responses = this.responses.slice(this.responseIdx, this.responseIdx += count);
    const stream = this.make?.(this.streams.length, responses) ?? new MockYieldingStream(responses, this.supportsInjectedMessages);
    this.streams.push(stream);
    this.lastStream = stream;
    return stream;
  }
}

/** Its tool returns a blob that carries the round past the physical window,
 *  so the boundary restarts the stream. With `wait`, the provider states a
 *  wait for the agent while the tool runs, as a rate limit on another call
 *  would, and that wait holds the restart's continuation. */
class RestartToolModule implements Module {
  readonly name = 'canned';
  framework: AgentFramework | null = null;
  /** An auxiliary call in flight when the restart's continuation starts,
   *  which parks that start on provider admission. */
  auxiliaryDuringRestart = false;
  /** The framework is stopping by the time the round's boundary runs. */
  closeAdmissionDuringRestart = false;
  /** The first round's result ends the turn (endTurn), with no restart. */
  endTurnFirst = false;
  /** The first tool call waits for this before it answers. */
  blockFirstTool: Promise<void> | null = null;
  firstToolStarted = false;
  /** The agent the provider states its wait for. */
  waitFor = 'prime';
  private calls = 0;
  constructor(private readonly wait: boolean) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'blob', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    // Only the first round restarts; a later one (the continuation's own
    // tool round) is small.
    if (++this.calls > 1) return { success: true, data: { ok: true } };
    this.firstToolStarted = true;
    if (this.blockFirstTool) await this.blockFirstTool;
    if (this.endTurnFirst) return { success: true, data: { finished: true }, endTurn: true };
    if (this.wait) internals(this.framework!).providerWaits.set(this.waitFor, 'test-model', WAIT_MS, 'stated while the tool ran');
    if (this.auxiliaryDuringRestart) internals(this.framework!).providerGate('prime').auxiliaryInFlight++;
    if (this.closeAdmissionDuringRestart) internals(this.framework!).providerAdmissionClosed = true;
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
      requestInference: ['prime'],
    };
  }
}

/** A tool round whose usage reports a prefix near the 200k window. */
function nearCapToolResponse(): NormalizedResponse {
  const r = createMockResponse([
    { type: 'text', text: 'Working.' },
    { type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} },
  ], 'tool_use');
  (r as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
  return r;
}

async function restartTurn(opts: {
  wait: boolean;
  auxiliaryDuringRestart?: boolean;
  inferencePolicy?: { shouldInfer(agentName: string, requests: InferenceRequest[]): boolean };
  /** The restarted stream's teardown waits for this. */
  holdTeardown?: Promise<void>;
  /** The restarted stream's first cancel() throws. */
  cancelThrows?: boolean;
  /** The stream at this index (0 the first) throws at its first cancel(). */
  cancelThrowsAt?: number;
  endTurnFirst?: boolean;
  blockFirstTool?: Promise<void>;
  /** Called as the membrane makes each stream, with its index. */
  onStreamMade?: (index: number) => void;
  /** A stream of the test's own for an index, ahead of the options above. */
  makeStream?: (index: number, responses: NormalizedResponse[]) => MockYieldingStream | undefined;
  beforeStart?: (framework: AgentFramework) => void;
  closeAdmissionDuringRestart?: boolean;
  /** Called with each trace, as a host's listener is. */
  onTrace?: (framework: AgentFramework, event: TraceEvent) => void;
  toolResultGuard?: boolean;
  /** An EventGate, whose inference window the restart keeps for its
   *  continuation. */
  gate?: boolean;
  /** What to wait for before handing the framework to the test: the
   *  restart's trace unless given. */
  until?: (traces: TraceEvent[]) => boolean;
  /** More agents and modules beside prime and its tool. */
  extraAgents?: Array<{ name: string; model: string; systemPrompt: string }>;
  extraModules?: Module[];
  /** The turn starts on a silent wake (suppressProse), with the message
   *  already stored, rather than on the message's own wake. */
  silentFirst?: boolean;
}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'turn-continuation-'));
  const membrane = new SequentialStreamMembrane([], (index, responses) => {
    opts.onStreamMade?.(index);
    const made = opts.makeStream?.(index, responses);
    if (made) return made;
    if (opts.cancelThrowsAt !== undefined) return index === opts.cancelThrowsAt ? new CancelThrowsOnceStream(responses) : undefined;
    if (index !== 0) return undefined;
    if (opts.holdTeardown) return new TeardownHeldStream(opts.holdTeardown, responses);
    return opts.cancelThrows ? new CancelThrowsOnceStream(responses) : undefined;
  });
  membrane.pushResponse(nearCapToolResponse());
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered.' }]));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Read it.' }]));
  const module = new RestartToolModule(opts.wait);
  module.auxiliaryDuringRestart = opts.auxiliaryDuringRestart ?? false;
  module.closeAdmissionDuringRestart = opts.closeAdmissionDuringRestart ?? false;
  module.endTurnFirst = opts.endTurnFirst ?? false;
  module.blockFirstTool = opts.blockFirstTool ?? null;
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all',
      maxTokens: 4_000, physicalWindowTokens: 200_000, ...(opts.toolResultGuard ? { toolResultGuard: true } : {}),
    }, ...(opts.extraAgents ?? [])],
    modules: [module, ...(opts.extraModules ?? [])],
    syncIntervalMs: 0,
    ...(opts.inferencePolicy ? { inferencePolicy: opts.inferencePolicy as never } : {}),
    ...(opts.gate ? { gate: { config: { policies: [], default: 'always' } } } : {}),
  });
  module.framework = framework;
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => { traces.push(e); opts.onTrace?.(framework, e); });
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
    origError(...args);
  };
  opts.beforeStart?.(framework);
  if (opts.silentFirst) {
    framework.getAgent('prime')!.getContextManager().addMessage('user', [{ type: 'text', text: 'fetch it' }]);
    framework.start();
    internals(framework).pendingRequests.push({ agentName: 'prime', reason: 'heartbeat', source: 'test', timestamp: Date.now(), suppressProse: true });
  } else {
    framework.start();
    framework.pushEvent({
      type: 'external-message', source: 'test', content: [{ type: 'text', text: 'fetch it' }], metadata: {}, triggerInference: true,
    } as unknown as ProcessEvent);
  }
  try {
    await waitFor('the budget restart', () => (opts.until ?? ((t) => t.some((e) => e.type === 'inference:stream_restarted')))(traces));
  } catch (error) {
    // A running framework would hold the file open past every test.
    console.error = origError;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    framework, membrane, traces, logged, module,
    endLines: () => logged.filter((l) => l.includes('[turn-continuation]')),
    cleanup: async () => {
      console.error = origError;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** The restart's stream has ended, and its continuation waits in the
 *  provider wait's hold. */
function heldForWait(framework: AgentFramework): boolean {
  const hold = internals(framework).providerAccelerationCooldowns.get('prime');
  return framework.getAgent('prime')!.state.status === 'idle'
    && (hold?.heldRequests.some((r) => r.reason === 'context_budget_restart') ?? false);
}

/** The inference log's rows for prime that a framework stop of the kind
 *  writes. */
const stopRows = (framework: AgentFramework, kind: string): number =>
  framework.queryInferenceLogs({ agentName: 'prime' }).entries.filter((e) => e.entry.error === `Stream aborted: ${kind}`).length;

const abortReasons = (traces: TraceEvent[]) =>
  traces.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason);

function requestTexts(request: NormalizedRequest | undefined): string {
  return JSON.stringify(request?.messages ?? []);
}

/** Whether the EventGate holds the agent's inference window open. */
const gateInferring = (framework: AgentFramework): boolean =>
  (internals(framework).eventGate as { inferenceDiagnostics(): { inferring: string[] } }).inferenceDiagnostics().inferring.includes('prime');

const CONTINUATION_DROPPED = "a turn's continuation was dropped before it started";

const storedTexts = (framework: AgentFramework): string =>
  JSON.stringify(framework.getAgent('prime')!.getContextManager().queryMessages({}).messages);

function pushMessage(framework: AgentFramework, text: string): void {
  framework.pushEvent({
    type: 'external-message', source: 'test', content: [{ type: 'text', text }], metadata: {},
  } as unknown as ProcessEvent);
}


/** Each turn-ending trace of prime's, with its reason if it has one. */
const terminalsOf = (h: { traces: TraceEvent[] }): string[] => h.traces
  .filter((t) => ['inference:aborted', 'inference:completed', 'inference:failed', 'inference:exhausted', 'inference:turn_ended'].includes(t.type))
  .map((t) => ((t as { reason?: string }).reason ? `${t.type}:${(t as { reason?: string }).reason}` : t.type));
/** The first stream's first cancel() has thrown (CancelThrowsOnceStream). */
const cancelThrew = (h: { membrane: SequentialStreamMembrane }): boolean =>
  (h.membrane.streams[0] as CancelThrowsOnceStream | undefined)?.threw === true;
const marksOf = (framework: AgentFramework): string[] => [...internals(framework).frameworkCancelledStreams.keys()];
/** The turn's end once a stop has reached it: no token, its logical turn closed, the gate's window released. */
function assertTurnEnded(h: { framework: AgentFramework }): void {
  assert.ok(!internals(h.framework).activeTurnTokens.has('prime'), 'the token is released');
  assert.ok(!internals(h.framework).openLogical.has('prime'), 'the logical turn is closed');
  assert.equal(gateInferring(h.framework), false, "the gate's window is released");
}

/** prime's turn token has gone with its restarted frame: the turn waits for
 *  its continuation with no token held. */
const frameLetGo = (framework: AgentFramework): boolean => !internals(framework).activeTurnTokens.has('prime');

/** A scheduler pass has run since `mark` was pushed (agent_not_found for a
 *  probe request). */
async function aPass(h: { framework: AgentFramework; logged: string[] }, label: string): Promise<void> {
  const before = h.logged.filter((l) => l.includes('agent=nobody reason=agent_not_found')).length;
  internals(h.framework).pendingRequests.push({ agentName: 'nobody', reason: 'operator', source: 'test', timestamp: Date.now() });
  await waitFor(label, () => h.logged.filter((l) => l.includes('agent=nobody reason=agent_not_found')).length > before);
}

/**
 * prime's continuation in a scheduler pass's hands: the pass took it from
 * the queue behind alpha's wake, and awaits alpha's start, which waits in
 * its context hook until `unblock`.
 */
async function passHoldingContinuation() {
  let unblock!: () => void;
  const blocked = new Promise<void>((r) => { unblock = r; });
  let alphaWaiting = false;
  const hook = {
    name: 'hook',
    async start() {},
    async stop() {},
    getTools: () => [],
    async onProcess() { return {}; },
    async gatherContext(agentName: string) {
      if (agentName === 'alpha') { alphaWaiting = true; await blocked; }
      return [];
    },
  } as unknown as Module;
  const h = await restartTurn({
    wait: true,
    extraAgents: [{ name: 'alpha', model: 'test-model', systemPrompt: 'You are alpha.' }],
    extraModules: [hook],
  });
  try {
    await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
    internals(h.framework).pendingRequests.push({ agentName: 'alpha', reason: 'timer', source: 'test', timestamp: Date.now() });
    h.framework.releaseProviderWait('prime');
    await waitFor("alpha's start to wait in its hook", () => alphaWaiting);
  } catch (error) {
    unblock();
    await h.cleanup();
    throw error;
  }
  return { h, unblock };
}

describe('a turn whose continuation is on its way', () => {
  it('is alive while a provider wait holds the continuation: listed, not drained, and a quiesce waits for it', async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      const status = h.framework.getHostModeStatus();
      assert.deepEqual(status.activeTurnAgents, ['prime'], 'the turn waiting for its continuation is listed');
      assert.equal(status.activeTurns, 1);
      assert.equal(status.drained, false, 'so the host is not drained');
      const began = Date.now();
      const quiesced = await h.framework.quiesce({ timeoutMs: QUIESCE_MS });
      // Its timeout, at the one-second floor (QUIESCE_TIMEOUT_MIN_MS).
      assert.ok(Date.now() - began >= 950, `the drain waited for the continuation's turn until its timeout, not ${Date.now() - began} ms`);
      assert.equal(quiesced.drained, false, 'the drain waits for the continuation');
      assert.deepEqual(quiesced.activeTurnAgents, ['prime']);
      h.framework.releaseProviderWait('prime');
      await waitFor('the continuation to run once the wait ends', () => h.membrane.calls.length === 2);
      await waitFor('the turn to end', () => h.framework.getHostModeStatus().drained);
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, []);
      assert.deepEqual(h.endLines(), [], 'the continuation ran: nothing was dropped');
    } finally {
      await h.cleanup();
    }
  });

  it('an abandon then drops the continuation and settles the turn as abandoned', async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      const status = await h.framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      assert.equal(status.drained, true, 'the abandon ended the turn');
      assert.deepEqual(status.activeTurnAgents, []);
      assert.equal(status.unabandonable, undefined, 'it was not left unabandonable');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'quiesce_abandoned').length, 1, "one inference:aborted, the abandon's");
      assert.equal(stopRows(h.framework, 'quiesce_abandoned'), 1, "the inference log has the abandon's row, as for a turn's start an abandon reaches");
      // The wait's hold, emptied by the abandon, releases with nothing to
      // run: no retry wake takes the dropped continuation's place.
      h.framework.releaseProviderWait('prime');
      assert.ok(!internals(h.framework).providerAccelerationCooldowns.has('prime'), 'the hold released');
      await h.framework.resume();
      await aPass(h, 'a pass after the resume');
      assert.equal(h.membrane.calls.length, 1, 'nothing started, during the quiesce or after the resume');
      assert.ok(!h.logged.some((l) => l.includes('fresh compile queued')), 'no retry was queued');
    } finally {
      await h.cleanup();
    }
  });

  it("a message arriving then is in the continuation's request, as on main, and its wake starts a turn of its own after the continuation", async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      pushMessage(h.framework, MID);
      await waitFor('the message to be stored', () => storedTexts(h.framework).includes(MID));
      h.framework.releaseProviderWait('prime');
      await waitFor('the continuation to run once the wait ends', () => h.membrane.calls.length >= 2);
      assert.ok(requestTexts(h.membrane.calls[1]).includes(MID), "the continuation's request carries the message");
      // The hold released the wake with the continuation, which starts alone:
      // the wake waits for the turn, then starts one of its own.
      await waitFor("the wake's own turn", () => h.membrane.calls.length >= 3);
      assert.ok(requestTexts(h.membrane.calls[2]).includes(MID), "the wake's turn reads the message too");
      await waitFor('the turns to end', () => h.framework.getHostModeStatus().drained);
      await aPass(h, 'a pass after the turns');
      assert.equal(h.membrane.calls.length, 3, 'no turn after the wake\'s');
    } finally {
      await h.cleanup();
    }
  });

  it("is alive while a scheduler pass holds the continuation, awaiting another agent's start", async () => {
    const { h, unblock } = await passHoldingContinuation();
    try {
      assert.ok(frameLetGo(h.framework), 'prime holds no token');
      assert.ok(!internals(h.framework).pendingRequests.some((r) => r.agentName === 'prime'), "prime's continuation is out of the queue, in the pass's hands");
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, ['alpha', 'prime'], "prime's turn is alive while the pass holds its continuation");
      assert.equal(h.framework.getHostModeStatus().drained, false);
      unblock();
      await waitFor('both turns to end', () => h.framework.getHostModeStatus().drained);
      assert.equal(h.membrane.calls.length, 3, "alpha's turn and prime's continuation each sent one request");
    } finally {
      unblock();
      await h.cleanup();
    }
  });

  it("a fresh wake waits while the continuation is in another scheduler pass's hands", async () => {
    const { h, unblock } = await passHoldingContinuation();
    const internal = internals(h.framework);
    try {
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke.' }]));
      internal.pendingRequests.push({ agentName: 'prime', reason: 'timer', source: 'test', timestamp: Date.now() });
      // A second pass beside the first, as runUntilIdle() beside a started
      // loop runs one.
      await internal.processInferenceRequests();
      assert.equal(h.membrane.calls.length, 1, 'the wake started no turn ahead of the continuation');
      assert.ok(internal.pendingRequests.some((r) => r.agentName === 'prime' && r.reason === 'timer'), 'it waits in the queue');
      unblock();
      await waitFor('every turn to end', () => h.framework.getHostModeStatus().drained && !internal.pendingRequests.length);
      assert.equal(h.membrane.calls.length, 4, "the wake's own turn followed the continuation's");
    } finally {
      unblock();
      await h.cleanup();
    }
  });

  it("an abandon takes the continuation from a scheduler pass's hands, and it never starts", async () => {
    const { h, unblock } = await passHoldingContinuation();
    const internal = internals(h.framework);
    try {
      // As an acceleration hold that released the continuation leaves it: a
      // primary pending, its recovery recorded.
      internal.providerGate('prime').primaryPending = true;
      internal.providerAccelerationRecoveries.set('prime', { startedAt: Date.now(), failures: 1, heldRequests: 1, reason: 'a test' });
      const quiesced = h.framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      await waitFor("the abandon to mark alpha's start", () => h.logged.some((l) => l.includes('abandoning in-flight turn for alpha')));
      unblock();
      const status = await quiesced;
      assert.equal(status.drained, true);
      await waitFor('every turn to end', () => h.framework.getHostModeStatus().activeTurns === 0);
      await aPass(h, 'a pass after the abandon');
      assert.equal(h.membrane.calls.length, 1, "prime's continuation never started, and alpha's abandoned start sent nothing");
      assert.equal(abortReasons(h.traces).filter((r) => r === 'quiesce_abandoned').length, 2, "one inference:aborted for each abandoned turn");
      assert.equal(internal.providerGate('prime').primaryPending, false, 'no primary is left pending for the dropped continuation');
    } finally {
      unblock();
      await h.cleanup();
    }
  });

  it("an abandon while the continuation's own start waits in a hook ends it at its check, and it sends nothing", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    let armed = false;
    let primeWaiting = false;
    const hook = {
      name: 'hook',
      async start() {},
      async stop() {},
      getTools: () => [],
      async onProcess() { return {}; },
      async gatherContext(agentName: string) {
        if (agentName === 'prime' && armed) { primeWaiting = true; await blocked; }
        return [];
      },
    } as unknown as Module;
    const h = await restartTurn({ wait: true, extraModules: [hook] });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      armed = true;
      h.framework.releaseProviderWait('prime');
      await waitFor("the continuation's start to wait in its hook", () => primeWaiting);
      assert.ok(!frameLetGo(h.framework), "the continuation's start holds the turn's token");
      const quiesced = h.framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      await waitFor('the abandon to reach the turn', () => h.logged.some((l) => l.includes('[host-mode] abandoning') && l.includes('prime')));
      unblock();
      await quiesced;
      await waitFor('the turn to end', () => h.framework.getHostModeStatus().activeTurns === 0);
      await aPass(h, 'a pass after the abandon');
      assert.equal(h.membrane.calls.length, 1, "the continuation's start sent nothing once abandoned");
      assert.equal(abortReasons(h.traces).filter((r) => r === 'quiesce_abandoned').length, 1, "one inference:aborted, the abandon's");
    } finally {
      unblock();
      await h.cleanup();
    }
  });

  it("a tool-result guard's retry that a provider wait holds keeps its turn alive, and an abandon ends it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'turn-continuation-'));
    // One stream: a tool round, then a refusal once its result is submitted.
    const membrane = new SequentialStreamMembrane([2]);
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call_1', name: 'guarded--read', input: {} }], 'tool_use'));
    membrane.pushResponse({
      ...createMockResponse([{ type: 'text', text: 'partial' }], 'refusal'),
      raw: { request: {}, response: { stop_details: { category: 'test-category' } } },
    } as NormalizedResponse);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered.' }]));
    let framework!: AgentFramework;
    const module = {
      name: 'guarded',
      async start() {},
      async stop() {},
      getTools: () => [{ name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
      async handleToolCall() {
        internals(framework).providerWaits.set('prime', 'test-model', WAIT_MS, 'stated while the tool ran');
        return { success: true, data: 'payload' };
      },
      async onProcess(event: ProcessEvent) {
        return event.type === 'external-message'
          ? { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'read it' }] }], requestInference: ['prime'] }
          : {};
      },
    } as unknown as Module;
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all',
        toolResultGuard: true, refusalHandling: { retries: 3 },
      } as never],
      modules: [module],
      syncIntervalMs: 0,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => { traces.push(e); });
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); origError(...args); };
    try {
      framework.start();
      framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'read it' }], metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      await waitFor('the guard retry to be held, its frame gone', () =>
        (internals(framework).providerAccelerationCooldowns.get('prime')?.heldRequests.some((r) => r.reason === 'tool_result_guard_retry') ?? false)
        && frameLetGo(framework));
      assert.deepEqual(framework.getHostModeStatus().activeTurnAgents, ['prime'], "the retry's turn is listed");
      assert.equal(framework.getHostModeStatus().drained, false);
      const status = await framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      assert.equal(status.drained, true, 'the abandon ended the turn');
      assert.equal(abortReasons(traces).filter((r) => r === 'quiesce_abandoned').length, 1, "one inference:aborted, the abandon's");
      framework.releaseProviderWait('prime');
      await framework.resume();
      await aPass({ framework, logged }, 'a pass after the resume');
      assert.equal(membrane.calls.length, 1, 'the dropped retry never started');
    } finally {
      console.error = origError;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('an operator call that needs the agent idle is refused then, as during any live turn', async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      await assert.rejects(
        h.framework.puppetToolCall('prime', 'canned--fetch', {}),
        (e: unknown) => e instanceof Error && /prime is idle\+turn-alive/.test(e.message),
      );
      await assert.rejects(
        h.framework.switchBranch('elsewhere'),
        (e: unknown) => e instanceof OperatorActionError && e.code === 'agent-busy' && /prime is idle\+turn-alive/.test(e.message),
      );
    } finally {
      await h.cleanup();
    }
  });

  it('with no wait, the continuation starts at once and the turn runs as before', async () => {
    const h = await restartTurn({ wait: false });
    try {
      await waitFor('the continuation to run', () => h.membrane.calls.length === 2);
      await waitFor('the turn to end', () => h.framework.getHostModeStatus().drained);
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, []);
      assert.deepEqual(h.endLines(), [], 'nothing was dropped');
    } finally {
      await h.cleanup();
    }
  });

  it('a framework continuation of any kind counts, and a direct-API one does not', async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held', () => heldForWait(h.framework));
      const hold = internals(h.framework).providerAccelerationCooldowns.get('prime')!;
      const retry: InferenceRequest = { agentName: 'echo', reason: 'tool_result_guard_retry', source: 'framework', timestamp: Date.now() };
      const direct: InferenceRequest = { agentName: 'delta', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() };
      hold.heldRequests.push(retry, direct);
      const listed = h.framework.getHostModeStatus().activeTurnAgents;
      hold.heldRequests = hold.heldRequests.filter((r) => r !== retry && r !== direct);
      assert.ok(listed.includes('echo'), "a guard retry's turn is listed");
      assert.ok(!listed.includes('delta'), "a direct-API tool round's isn't");
    } finally {
      await h.cleanup();
    }
  });
});

describe('a turn whose continuation is dropped ends there', () => {
  it("stop() ends it as a stop ends a start, and the continuation goes with it", async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held', () => heldForWait(h.framework));
      await h.framework.stop();
      const status = h.framework.getHostModeStatus();
      assert.equal(status.activeTurns, 0, 'no turn is left alive');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'shutdown').length, 1, "one inference:aborted, the stop's");
      assert.ok(h.endLines().some((l) => l.includes('the framework is stopping')), h.endLines().join('\n'));
    } finally {
      await h.cleanup();
    }
  });

  it('a stop from a listener of the restart ends it as shutdown, the continuation taken out of the queue', async () => {
    let stopping: Promise<void> | undefined;
    const h = await restartTurn({
      wait: false,
      onTrace: (framework, e) => { if (e.type === 'inference:stream_restarted') stopping = framework.stop(); },
    });
    try {
      await stopping;
      assert.ok(!internals(h.framework).pendingRequests.some((r) => r.reason === 'context_budget_restart'), 'the stop took the continuation out of the queue');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'shutdown').length, 1, "one inference:aborted, the stop's");
      assert.equal(h.framework.getHostModeStatus().activeTurns, 0);
      assert.equal(h.membrane.calls.length, 1, 'no continuation started');
    } finally {
      await h.cleanup();
    }
  });

  it("a stop from a listener of the restart boundary's usage report ends the turn as shutdown, its stream cancelled", async () => {
    let stopping: Promise<void> | undefined;
    const h = await restartTurn({
      wait: false,
      onTrace: (framework, e) => {
        if (e.type !== 'usage:updated' || stopping) return;
        // The boundary's report, once the continuation is queued.
        if (internals(framework).pendingRequests.some((r) => r.reason === 'context_budget_restart')) stopping = framework.stop();
      },
      until: () => stopping !== undefined,
    });
    try {
      const stopped = await Promise.race([stopping!.then(() => true), sleep(10_000).then(() => false)]);
      assert.equal(stopped, true, 'the stop finished: no stream was left running');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'shutdown').length, 1, "one inference:aborted, the stop's");
      assert.equal(h.framework.getHostModeStatus().activeTurns, 0);
      assert.equal(h.membrane.calls.length, 1, 'no continuation started');
    } finally {
      await h.cleanup();
    }
  });

  it("a restart whose stream's cancel throws leaves no continuation queued beside the live stream", async () => {
    const h = await restartTurn({ wait: false, cancelThrows: true, until: () => true });
    try {
      await waitFor('the cancel to throw', () => cancelThrew(h));
      assert.ok(!internals(h.framework).pendingRequests.some((r) => r.reason === 'context_budget_restart'), 'no continuation is queued');
      await aPass(h, 'a pass after the failed cancel');
      assert.equal(h.membrane.calls.length, 1, 'no second stream started beside the one the cancel left live');
    } finally {
      await h.cleanup();
    }
  });

  it('a restart boundary while the framework is stopping queues no continuation, and the turn ends as shutdown', async () => {
    const h = await restartTurn({
      wait: false,
      closeAdmissionDuringRestart: true,
      until: (traces) => traces.some((t) => t.type === 'inference:aborted'),
    });
    try {
      await waitFor('the restarted frame to end', () => h.framework.getHostModeStatus().activeTurns === 0);
      assert.ok(!internals(h.framework).pendingRequests.some((r) => r.reason === 'context_budget_restart'), 'nothing was queued');
      assert.ok(!h.traces.some((t) => t.type === 'inference:stream_restarted'), 'and no restart was announced');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'shutdown').length, 1, "one inference:aborted, the stop's");
      assert.equal(h.membrane.calls.length, 1, 'the stopping framework started no continuation');
    } finally {
      internals(h.framework).providerAdmissionClosed = false;
      await h.cleanup();
    }
  });

  it('the inference policy dropping it ends the turn: a terminal, the gate window closed, the logical turn closed', async () => {
    const h = await restartTurn({
      wait: true,
      gate: true,
      inferencePolicy: { shouldInfer: (_agent, requests) => !requests.some((r) => r.reason === 'context_budget_restart') },
    });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      assert.equal(gateInferring(h.framework), true, "the restart kept the gate's window for its continuation");
      h.framework.releaseProviderWait('prime');
      await waitFor('the turn to end', () => h.framework.getHostModeStatus().activeTurns === 0 && h.endLines().length > 0);
      assert.equal(h.membrane.calls.length, 1, 'the continuation never started');
      assert.ok(h.endLines().some((l) => l.includes('the inference policy dropped its continuation')), h.endLines().join('\n'));
      assert.equal(abortReasons(h.traces).filter((r) => r === CONTINUATION_DROPPED).length, 1, 'one terminal inference:aborted');
      assert.equal(gateInferring(h.framework), false, "the gate's window is closed");
      assert.equal(internals(h.framework).openLogical.has('prime'), false, 'its logical turn is closed');
    } finally {
      await h.cleanup();
    }
  });

  it("with the tool-result guard on, a drop lets go of the batch the restart kept for the continuation", async () => {
    const h = await restartTurn({
      wait: true,
      toolResultGuard: true,
      inferencePolicy: { shouldInfer: (_agent, requests) => !requests.some((r) => r.reason === 'context_budget_restart') },
    });
    const guard = h.framework.getAgent('prime')!.toolResultGuard;
    try {
      await waitFor('the continuation to be held', () => heldForWait(h.framework));
      assert.equal(guard.hasPending, true, "the restart kept the round's batch for its continuation");
      h.framework.releaseProviderWait('prime');
      await waitFor('the turn to end', () => h.endLines().length > 0);
      assert.equal(guard.hasPending, false, 'the batch went with the turn');
      assert.equal(guard.recovering, false);
    } finally {
      await h.cleanup();
    }
  });

  it('a pass that finds its agent gone ends the turn', async () => {
    const h = await restartTurn({ wait: true });
    const internal = internals(h.framework);
    const agent = internal.agents.get('prime');
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      const hold = internal.providerAccelerationCooldowns.get('prime')!;
      const continuation = hold.heldRequests.find((r) => r.reason === 'context_budget_restart')!;
      hold.heldRequests = hold.heldRequests.filter((r) => r !== continuation);
      internal.agents.delete('prime');
      internal.pendingRequests.push(continuation);
      await waitFor('the pass to drop it', () => h.endLines().some((l) => l.includes('its agent is gone')));
      assert.equal(abortReasons(h.traces).filter((r) => r === CONTINUATION_DROPPED).length, 1, 'one terminal inference:aborted');
      assert.equal(internal.openLogical.has('prime'), false, 'its logical turn is closed, its agent gone');
    } finally {
      internal.agents.set('prime', agent);
      await h.cleanup();
    }
  });

  it("its agent's disposal ends the turn, a queued continuation taken out of the queue", async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      const internal = internals(h.framework);
      const hold = internal.providerAccelerationCooldowns.get('prime')!;
      const continuation = hold.heldRequests.find((r) => r.reason === 'context_budget_restart')!;
      hold.heldRequests = hold.heldRequests.filter((r) => r !== continuation);
      internal.pendingRequests.push(continuation);
      internal.disposeConversationAgent('prime');
      assert.ok(!internal.pendingRequests.includes(continuation), 'the continuation left the queue');
      assert.equal(h.framework.getHostModeStatus().activeTurns, 0, 'no turn is left alive');
      assert.ok(h.endLines().some((l) => l.includes('its agent was disposed')), h.endLines().join('\n'));
    } finally {
      await h.cleanup();
    }
  });

  it('a start parked behind an auxiliary call keeps the turn alive, and runs once the call ends', async () => {
    const h = await restartTurn({ wait: false, auxiliaryDuringRestart: true });
    const gate = internals(h.framework).providerGate('prime');
    try {
      await waitFor('the continuation to park, its frame gone', () => gate.idleWaiters.length > 0 && frameLetGo(h.framework));
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, ['prime'], 'the parked continuation keeps the turn alive');
      assert.equal(h.framework.getHostModeStatus().parkedAdmissions, 1, 'and it counts as a parked admission too');
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor('the continuation to run', () => h.membrane.calls.length === 2);
      await waitFor('the turn to end', () => h.framework.getHostModeStatus().drained);
      assert.deepEqual(h.endLines(), [], 'nothing was dropped');
    } finally {
      await h.cleanup();
    }
  });

  it("a start parked behind an auxiliary call whose failure arms a host's hold is held with its turn alive and the gate's window closed, and runs once the hold releases, taking the window again", async () => {
    let framework: AgentFramework | undefined;
    let windowAtContinuation: boolean | undefined;
    const h = await restartTurn({
      wait: false, auxiliaryDuringRestart: true, gate: true,
      onStreamMade: (index) => { if (index === 1 && framework) windowAtContinuation = gateInferring(framework); },
    });
    framework = h.framework;
    const internal = internals(h.framework);
    const gate = internal.providerGate('prime');
    try {
      await waitFor('the continuation to park, its frame gone', () => gate.idleWaiters.length > 0 && frameLetGo(h.framework));
      let spent = true;
      internal.providerHoldHook = () => (spent ? { holdMs: 1_000, reason: 'the host says wait' } : undefined);
      internal.holdProviderAcceleration(h.framework.getAgent('prime'), new Error('compression failed'), undefined, true);
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor('the hold to keep the continuation', () =>
        internal.providerAccelerationCooldowns.get('prime')?.heldRequests.some((r) => r.reason === 'context_budget_restart') ?? false);
      assert.equal(h.membrane.calls.length, 1, 'no call while the hold stands');
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, ['prime'], 'the held continuation keeps the turn alive');
      assert.equal(gateInferring(h.framework), false, "the gate's window is closed while the hold keeps the turn from starting");
      spent = false;
      await waitFor('the continuation to run once the hold releases', () => h.membrane.calls.length === 2);
      assert.equal(windowAtContinuation, true, "the continuation's start took the gate's window again");
      await waitFor('the turn to end', () => h.framework.getHostModeStatus().drained);
      assert.deepEqual(h.endLines(), [], 'nothing was dropped');
    } finally {
      await h.cleanup();
    }
  });

  it("abortInference() while a provider wait holds the continuation ends the turn: the continuation is dropped, with one inference:aborted carrying the stop's reason", async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      assert.equal(h.framework.abortInference('prime', 'zz-operator stop'), true, 'abortInference reports the stop');
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, [], 'the turn ended');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'zz-operator stop').length, 1, "one inference:aborted, with the stop's reason");
      // The wait's hold, emptied by the stop, releases with nothing to run.
      h.framework.releaseProviderWait('prime');
      await aPass(h, 'a pass after the release');
      assert.equal(h.membrane.calls.length, 1, 'the continuation never started');
    } finally {
      await h.cleanup();
    }
  });

  it("abortInference() while the continuation's start is parked behind an auxiliary call ends the turn and gives its admission back", async () => {
    const h = await restartTurn({ wait: false, auxiliaryDuringRestart: true });
    const gate = internals(h.framework).providerGate('prime');
    try {
      await waitFor('the continuation to park, its frame gone', () => gate.idleWaiters.length > 0 && frameLetGo(h.framework));
      assert.equal(h.framework.abortInference('prime', 'zz-operator stop'), true, 'abortInference reports the stop');
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, [], 'the turn ended');
      assert.equal(gate.primaryDepth, 0, "the park's admission given back");
      assert.equal(abortReasons(h.traces).filter((r) => r === 'zz-operator stop').length, 1, "one inference:aborted, with the stop's reason");
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await aPass(h, 'a pass after the auxiliary call');
      assert.equal(h.membrane.calls.length, 1, 'the continuation never started');
      assert.equal(gate.primaryDepth, 0, 'the woken park gave nothing back twice');
    } finally {
      await h.cleanup();
    }
  });

  it('an abandon while the start is parked ends the turn and gives its admission back once', async () => {
    const h = await restartTurn({ wait: false, auxiliaryDuringRestart: true });
    const gate = internals(h.framework).providerGate('prime');
    try {
      await waitFor('the continuation to park, its frame gone', () => gate.idleWaiters.length > 0 && frameLetGo(h.framework));
      const status = await h.framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      assert.equal(status.drained, true, 'the abandon ended the turn, and gave the park its admission back');
      assert.equal(gate.primaryDepth, 0);
      assert.equal(abortReasons(h.traces).filter((r) => r === 'quiesce_abandoned').length, 1, "one inference:aborted, the abandon's");
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await h.framework.resume();
      await aPass(h, 'a pass after the resume');
      assert.equal(h.membrane.calls.length, 1, 'the continuation never started');
      assert.equal(gate.primaryDepth, 0, 'the woken park gave nothing back twice');
    } finally {
      await h.cleanup();
    }
  });

  it('an abandon while the restarted frame still holds its token ends the turn now, and what that frame deferred lands as it ends', async () => {
    let release!: () => void;
    const h = await restartTurn({ wait: true, holdTeardown: new Promise<void>((r) => { release = r; }) });
    try {
      await waitFor('the continuation to be held', () => {
        const hold = internals(h.framework).providerAccelerationCooldowns.get('prime');
        return hold?.heldRequests.some((r) => r.reason === 'context_budget_restart') ?? false;
      });
      assert.equal(frameLetGo(h.framework), false, 'its frame still holds the token');
      pushMessage(h.framework, MID);
      await waitFor('the message to defer behind the token', () => internals(h.framework).deferredMessages.length > 0);
      const quiesced = h.framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      await waitFor('the abandon to drop the continuation', () => abortReasons(h.traces).includes('quiesce_abandoned'));
      release();
      const status = await quiesced;
      assert.equal(status.drained, true, 'the frame let go of its token');
      assert.equal(abortReasons(h.traces).filter((r) => r === 'quiesce_abandoned').length, 1, "one inference:aborted, the abandon's");
      await h.framework.resume();
      await waitFor('the deferred message to land', () => storedTexts(h.framework).includes(MID));
    } finally {
      release();
      await h.cleanup();
    }
  });

  it('a drop while the restarted frame still holds its token lands what was deferred as that frame ends', async () => {
    let release!: () => void;
    const h = await restartTurn({
      wait: true,
      holdTeardown: new Promise<void>((r) => { release = r; }),
      inferencePolicy: { shouldInfer: (_agent, requests) => !requests.some((r) => r.reason === 'context_budget_restart') },
    });
    try {
      await waitFor('the continuation to be held', () => {
        const hold = internals(h.framework).providerAccelerationCooldowns.get('prime');
        return hold?.heldRequests.some((r) => r.reason === 'context_budget_restart') ?? false;
      });
      assert.equal(frameLetGo(h.framework), false, 'its frame still holds the token');
      pushMessage(h.framework, MID);
      await waitFor('the message to defer behind the token', () => internals(h.framework).deferredMessages.length > 0);
      h.framework.releaseProviderWait('prime');
      await waitFor('the policy to drop the continuation', () => h.endLines().some((l) => l.includes('the inference policy dropped its continuation')));
      assert.ok(!storedTexts(h.framework).includes(MID), 'the message waits while the frame holds the token');
      release();
      await waitFor('the deferred message to land as the frame ends', () => storedTexts(h.framework).includes(MID));
    } finally {
      release();
      await h.cleanup();
    }
  });

  it('a hold an abandon emptied, rebuilt by a host hold, releases with nothing to run and its pending primary ended', async () => {
    const h = await restartTurn({ wait: true });
    const internal = internals(h.framework);
    try {
      await waitFor('the continuation to be held', () => heldForWait(h.framework));
      await h.framework.quiesce({ timeoutMs: QUIESCE_MS, abandon: true });
      await h.framework.resume();
      // An auxiliary failure the host answers with a hold rebuilds the hold
      // the abandon emptied: a primary is pending behind it now.
      let asked = 0;
      internal.providerHoldHook = () => (asked++ === 0 ? { holdMs: 1_000, reason: 'the host says wait' } : undefined);
      internal.holdProviderAcceleration(h.framework.getAgent('prime'), new Error('compression failed'), undefined, true);
      // Prime's provider admission, as healthSnapshot() reports it.
      const admission = () => (h.framework.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { primaryPending: boolean; cooldownReason: string | null } }> })
        .agents.find((agent) => agent.name === 'prime')!.providerAdmission;
      assert.equal(admission().primaryPending, true, 'the rebuilt hold left a primary pending');
      await waitFor('the rebuilt hold to release', () => admission().cooldownReason === null, 5_000);
      await aPass(h, 'a pass after the release');
      assert.equal(h.membrane.calls.length, 1, "no retry turn took the dropped continuation's place");
      assert.equal(admission().primaryPending, false, 'its pending primary ended');
    } finally {
      await h.cleanup();
    }
  });
});


/** prime's tool-result guard retry, held by a provider wait stated while
 *  its tool ran, its frame gone. `duringTool` runs as the tool starts, and
 *  `original` adds fields to the wake that started the turn. The start of
 *  each stream records a copy of the trigger it ran on (starts). */
async function guardRetryHeld(duringTool?: (framework: AgentFramework) => void, original: Partial<InferenceRequest> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'turn-continuation-'));
  const membrane = new SequentialStreamMembrane([2]);
  membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call_1', name: 'guarded--read', input: {} }], 'tool_use'));
  membrane.pushResponse({
    ...createMockResponse([{ type: 'text', text: 'partial' }], 'refusal'),
    raw: { request: {}, response: { stop_details: { category: 'test-category' } } },
  } as NormalizedResponse);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered.' }]));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Again.' }]));
  let framework!: AgentFramework;
  const module = {
    name: 'guarded',
    async start() {},
    async stop() {},
    getTools: () => [{ name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
    async handleToolCall() {
      duringTool?.(framework);
      await sleep(50);
      internals(framework).providerWaits.set('prime', 'test-model', WAIT_MS, 'stated while the tool ran');
      // What duringTool queued goes into the hold before the round ends, and
      // so before the guard's retry.
      if (duringTool) {
        await waitFor('the hold to take what was queued while the tool ran', () =>
          (internals(framework).providerAccelerationCooldowns.get('prime')?.heldRequests.length ?? 0) > 0);
      }
      return { success: true, data: 'payload' };
    },
    async onProcess() { return {}; },
  } as unknown as Module;
  framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all',
      toolResultGuard: true, refusalHandling: { retries: 3 },
    } as never],
    modules: [module],
    syncIntervalMs: 0,
    gate: { config: { policies: [], default: 'always' } },
  } as never);
  const traces: TraceEvent[] = [];
  const starts: Array<InferenceRequest | undefined> = [];
  framework.onTrace((e) => {
    traces.push(e);
    if (e.type === 'inference:started') {
      const t = (framework as unknown as { activeTurnTriggers: Map<string, InferenceRequest> }).activeTurnTriggers.get('prime');
      starts.push(t && { ...t });
    }
  });
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); origError(...args); };
  const cleanup = async () => {
    console.error = origError;
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    framework.getAgent('prime')!.getContextManager().addMessage('user', [{ type: 'text', text: 'read it' }]);
    framework.start();
    internals(framework).pendingRequests.push({ agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(), ...original });
    await waitFor('the guard retry to be held, its frame gone', () =>
      (internals(framework).providerAccelerationCooldowns.get('prime')?.heldRequests.some((r) => r.reason === 'tool_result_guard_retry') ?? false)
      && frameLetGo(framework), 15_000);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { framework, membrane, traces, logged, cleanup, starts };
}

/** The reasons of the requests prime's provider hold holds, in order. */
const heldReasons = (framework: AgentFramework): string[] =>
  internals(framework).providerAccelerationCooldowns.get('prime')?.heldRequests.map((r) => r.reason) ?? [];

/** Who and where a turn's trigger names as having woken it (telemetry). */
const provenanceOf = (r: InferenceRequest | undefined) => ({ counterparty: r?.counterparty, wakeChannelId: r?.wakeChannelId, wakeAt: r?.wakeAt });

/** A gate wake for prime from alice, as the EventGate queues one. */
function aliceWake(): InferenceRequest {
  return { agentName: 'prime', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now(),
    counterparty: 'srv:user:alice', wakeChannelId: 'srv:chan-alice', wakeAt: Date.now() };
}

/** A coalesced batch's wake for prime, subject s1 (RFC-006). */
function batchWake(): InferenceRequest {
  return { agentName: 'prime', reason: 'mcpl:push-event', source: 'test', timestamp: Date.now(),
    coalescingBatch: true, coalescingSubject: 's1', coalescingBatchSubjects: ['s1'] };
}

/**
 * A stand-in for the push coalescer, of which a turn's start reads
 * pendingBatches() and assemble(): one batch, subject s1, pending from arm()
 * until an assembly takes it. `assembled` lists each assembly's agent and
 * causes.
 */
function standInCoalescer(framework: AgentFramework) {
  let pending = false;
  const assembled: string[] = [];
  internals(framework).pushCoalescer = {
    pendingBatches: () => (pending ? 1 : 0),
    assemble: async (agent: string, subjects?: readonly string[]) => {
      assembled.push(`${agent}:${(subjects ?? []).join(',')}`);
      const had = pending;
      pending = false;
      return { materialized: new Set(had ? ['s1'] : []), settled: new Set(subjects ?? []) };
    },
    suspend: () => {},
  };
  return { arm: () => { pending = true; }, pending: () => pending, assembled };
}

describe('a framework cancel that throws', () => {
  it('a restart whose cancel throws leaves the turn going, with no mark and no continuation, for a caller to stop', async () => {
    // What a listener of the operator alert finds queued as the alert goes out.
    const queuedAtAlert: boolean[] = [];
    const h = await restartTurn({
      wait: false, cancelThrows: true, gate: true, until: () => true,
      beforeStart: (framework) => {
        framework.onTrace((event) => {
          if (event.type === 'ops:alert') {
            queuedAtAlert.push(internals(framework).pendingRequests.some((r) => r.reason === 'context_budget_restart'));
          }
        });
      },
    });
    try {
      await waitFor('the cancel to throw', () => cancelThrew(h));
      assert.deepEqual(marksOf(h.framework), [], 'no mark: no cancel happened');
      assert.ok(!internals(h.framework).pendingRequests.some((r) => r.reason === 'context_budget_restart'), 'no continuation');
      assert.ok(internals(h.framework).activeTurnTokens.has('prime'), 'the turn holds its token');
      assert.ok(!h.traces.some((t) => t.type === 'inference:stream_restarted'), 'no restart is reported');
      // The boundary is no restart, so it reports no usage and logs no restart:
      // the stream's own end counts the rounds it finished.
      assert.ok(!h.traces.some((t) => t.type === 'usage:updated'), 'no usage report at the boundary');
      const rows = () => h.framework.queryInferenceLogs({ agentName: 'prime' }).entries.map((e) => e.entry);
      assert.deepEqual(rows().filter((row) => row.stopReason === 'context_budget' || row.stopReason === 'physical_window'), [],
        'no row records a restart');
      assert.ok(!h.logged.some((l) => l.includes('Error in event loop')), 'the boundary ends without a throw');
      assert.ok(h.logged.some((l) => /^\[turn\] prime: the stream's cancel threw at a context-budget restart, so its stream goes on, waiting for this round's results, and the turn holds its token until the stream ends; an abort tries the cancel again: /.test(l)));
      // Only an operator ends it, so an operator alert says so.
      const alerts = h.traces.filter((t) => t.type === 'ops:alert' && (t as { kind?: string }).kind === 'stream-cancel-failed')
        .map((t) => t as { agentName?: string; message?: string });
      assert.equal(alerts.length, 1, 'one operator alert');
      assert.deepEqual(queuedAtAlert, [false], "the restart's continuation left the queue before the alert went out");
      assert.equal(alerts[0].agentName, 'prime');
      assert.match(alerts[0].message ?? '', /^prime's turn is stuck: its stream's cancel threw at a context-budget restart, and the stream waits for results the framework won't send\. An abort of the agent \(abortInference, or the API's inference\.abort\) tries the cancel again; if that throws as well, restarting the host process ends the turn: /);
      assert.equal(h.framework.abortInference('prime', 'user'), true);
      await waitFor('the stop to end the turn', () => terminalsOf(h).length > 0);
      assert.deepEqual(terminalsOf(h), ['inference:aborted:user'], "the caller's stop ends the turn as its own");
      assertTurnEnded(h);
      const stops = rows().filter((row) => row.error === 'Stream cancelled (user)');
      assert.equal(stops.length, 1, "the stop's row");
      assert.ok(stops[0].tokenUsage, "which carries the stream's usage");
      assert.equal(h.traces.filter((t) => t.type === 'usage:updated').length, 1, 'counted once, at the stream\'s end');
    } finally {
      await h.cleanup();
    }
  });

  it('a restart whose cancel throws leaves no stop recorded, so the stream failing later is a failure', async () => {
    const h = await restartTurn({ wait: false, cancelThrows: true, gate: true, until: () => true });
    try {
      await waitFor('the cancel to throw', () => cancelThrew(h));
      (h.membrane.streams[0] as CancelThrowsOnceStream).fail('the provider dropped the stream');
      await waitFor('the failure', () => terminalsOf(h).length > 0);
      assert.deepEqual(terminalsOf(h).slice(0, 1), ['inference:failed'], 'a failure, not a stop nobody made');
      assert.ok(!terminalsOf(h).some((t) => t.startsWith('inference:aborted')));
      // The stream's own end carries its usage, in its failure's row, and no row records a restart.
      const rows = () => h.framework.queryInferenceLogs({ agentName: 'prime' }).entries.map((e) => e.entry);
      await waitFor("the failure's row", () => rows().some((row) => /the provider dropped the stream/.test(String(row.error ?? ''))));
      const failed = rows().filter((row) => /the provider dropped the stream/.test(String(row.error ?? '')));
      assert.equal(failed.length, 1, "the failure's row");
      assert.ok(failed[0].tokenUsage, "which carries the stream's usage");
      assert.deepEqual(rows().filter((row) => row.stopReason === 'context_budget' || row.stopReason === 'physical_window'), [],
        'no row records a restart');
    } finally {
      await h.cleanup();
    }
  });

  it('an end of turn whose cancel throws leaves the turn going, with no mark, for a caller to stop', async () => {
    const h = await restartTurn({ wait: false, cancelThrows: true, gate: true, endTurnFirst: true, toolResultGuard: true, until: () => true });
    try {
      await waitFor('the cancel to throw', () => cancelThrew(h));
      assert.deepEqual(marksOf(h.framework), [], 'no mark: no cancel happened');
      assert.ok(internals(h.framework).activeTurnTokens.has('prime'), 'the turn holds its token');
      assert.deepEqual(terminalsOf(h), [], 'the turn has not ended');
      const guard = h.framework.getAgent('prime')!.toolResultGuard;
      assert.equal(guard.hasPending, false, "the round's batch is admitted: the boundary never sends it, whatever its cancel does");
      assert.ok(!h.logged.some((l) => l.includes('Error in event loop')), 'the boundary ends without a throw');
      assert.ok(h.logged.some((l) => l.includes("the stream's cancel threw at a tool result that ends the turn")));
      assert.equal(h.framework.abortInference('prime', 'user'), true);
      await waitFor('the stop to end the turn', () => terminalsOf(h).length > 0);
      assert.deepEqual(terminalsOf(h), ['inference:aborted:user'], "the caller's stop ends the turn as its own");
      assertTurnEnded(h);
      assert.equal(guard.hasPending, false, 'and the stop has no batch to withhold');
    } finally {
      await h.cleanup();
    }
  });

  it('a restart while stopping whose cancel throws leaves the turn going, with no mark, for a caller to stop', async () => {
    const h = await restartTurn({ wait: false, cancelThrows: true, gate: true, closeAdmissionDuringRestart: true, until: () => true });
    try {
      await waitFor('the cancel to throw', () => cancelThrew(h));
      assert.deepEqual(marksOf(h.framework), [], 'no mark: no cancel happened');
      assert.ok(h.logged.some((l) => l.includes("the stream's cancel threw at a context-budget restart while the framework stops")));
      assert.ok(internals(h.framework).activeTurnTokens.has('prime'), 'the turn holds its token');
      internals(h.framework).providerAdmissionClosed = false;
      assert.equal(h.framework.abortInference('prime', 'user'), true);
      await waitFor('the stop to end the turn', () => terminalsOf(h).length > 0);
      assert.deepEqual(terminalsOf(h), ['inference:aborted:user'], "the caller's stop, not a shutdown that didn't happen");
      assertTurnEnded(h);
    } finally {
      internals(h.framework).providerAdmissionClosed = false;
      await h.cleanup();
    }
  });

  it("a quiesce abandon whose cancel throws lists the turn as unabandonable, takes its mark back, and resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const h = await restartTurn({ wait: false, cancelThrows: true, gate: true, blockFirstTool: blocked, until: () => true });
    try {
      await waitFor('the tool to start', () => h.module.firstToolStarted);
      setAbandonGraceForTests(h.framework, 50);
      const status = await h.framework.quiesce({ timeoutMs: 200, abandon: true });
      assert.deepEqual(status.unabandonable, ['prime']);
      assert.equal(status.drained, false);
      assert.deepEqual(marksOf(h.framework), [], 'no mark: no cancel happened');
      assert.ok(h.logged.some((l) => /^\[host-mode\] cannot abandon turn for prime: its stream's cancel threw, so its stream goes on, and the turn holds its token until the stream ends or an abort or a stop ends it: /.test(l)));
      release();
      await waitFor('the turn to finish on its own', () => terminalsOf(h).length > 0);
      assert.deepEqual(terminalsOf(h), ['inference:completed'], 'the turn its abandon missed ends as its own');
    } finally {
      release();
      await h.cleanup();
    }
  });

  it("stop() whose cancel throws rejects with it, and takes the cancel's mark back", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const h = await restartTurn({ wait: false, cancelThrows: true, gate: true, blockFirstTool: blocked, until: () => true });
    try {
      await waitFor('the tool to start', () => h.module.firstToolStarted);
      const stopping = h.framework.stop(1_000);
      await waitFor('the cancel to throw', () => cancelThrew(h));
      release();
      await assert.rejects(stopping, /the stream refused its cancel/);
      assert.deepEqual(marksOf(h.framework), [], 'no mark: no cancel happened');
      assert.ok(h.logged.some((l) => /^\[turn\] prime: the stream's cancel threw at stop\(\), and stop\(\) rejects with that error, in an AggregateError if other steps failed too: /.test(l)),
        'the line names the agent whose stream goes on');
    } finally {
      release();
      await h.cleanup().catch(() => {});
    }
  });

  for (const how of ['stopping', 'replaced'] as const) {
    const why = how === 'stopping' ? 'the framework was stopping' : 'the agent was replaced or removed';
    it(`a start compiled while ${why}, whose cancel throws, is dropped as one whose cancel worked`, async () => {
      let fw: AgentFramework | null = null;
      const h = await restartTurn({
        wait: false, cancelThrowsAt: 1, gate: true, until: () => true,
        // As the continuation's compile makes its stream: the framework
        // starts stopping, or the agent is replaced under its name.
        onStreamMade: (index) => {
          if (index !== 1 || !fw) return;
          if (how === 'stopping') internals(fw).providerAdmissionClosed = true;
          else internals(fw).agents.set('prime', Object.create(fw.getAgent('prime')!));
        },
        beforeStart: (framework) => { fw = framework; },
      });
      try {
        await waitFor('the start to end', () => terminalsOf(h).length > 0);
        assert.deepEqual(terminalsOf(h), [`inference:aborted:a turn compiled while ${why} is dropped before it sends anything`]);
        assert.ok(h.logged.some((l) => l.startsWith(`[turn] prime: the cancel of a turn's stream compiled while ${why} threw; it was never iterated, so it sent nothing, and the start ends as if the cancel had worked: `)));
        assert.equal((h.membrane.streams[1] as CancelThrowsOnceStream).cancels, 1, 'the agent lets go of the stream without cancelling it again');
        assertTurnEnded(h);
      } finally {
        internals(h.framework).providerAdmissionClosed = false;
        await h.cleanup();
      }
    });
  }

  it("a start a caller stops during its compile, whose stream's cancel throws, ends as the caller's stop", async () => {
    let fw: AgentFramework | null = null;
    const h = await restartTurn({
      wait: false, cancelThrowsAt: 1, gate: true, until: () => true,
      // A caller stops the continuation as its compile makes its stream.
      onStreamMade: (index) => { if (index === 1 && fw) fw.abortInference('prime', 'user'); },
      beforeStart: (framework) => { fw = framework; },
    });
    try {
      await waitFor('the start to end', () => terminalsOf(h).length > 0);
      assert.deepEqual(terminalsOf(h), ['inference:aborted:user']);
      assert.ok(h.logged.some((l) => /^\[turn\] prime: the cancel of a turn's stream stopped after its compile threw; /.test(l)));
      assertTurnEnded(h);
    } finally {
      await h.cleanup();
    }
  });

  it("stop() whose cancel throws after a quiesce abandon cancelled the same stream leaves the abandon's mark, and the turn ends as abandoned", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    const h = await restartTurn({
      wait: false, gate: true, blockFirstTool: blocked, until: () => true,
      makeStream: (index, responses) => (index === 0 ? new SupersededStream(released, false, responses) : undefined),
    });
    try {
      await waitFor('the tool to start', () => h.module.firstToolStarted);
      const quiescing = h.framework.quiesce({ timeoutMs: 100, abandon: true }).catch(() => undefined);
      await waitFor("the abandon's cancel", () => marksOf(h.framework).length === 1);
      const stopping = h.framework.stop(5_000);
      await waitFor('the stop to try its cancel', () => (h.membrane.streams[0] as SupersededStream).cancels >= 2);
      assert.deepEqual([...internals(h.framework).frameworkCancelledStreams.values()], ['quiesce_abandoned'], "the abandon's mark, for the cancel that happened");
      release();
      unblock();
      await assert.rejects(stopping, /the stream refused a second cancel/);
      await quiescing;
      assert.deepEqual(terminalsOf(h), ['inference:aborted:quiesce_abandoned']);
    } finally {
      release();
      unblock();
      await h.cleanup().catch(() => {});
    }
  });

  for (const throwAtEnd of [false, true]) {
    it(`a stream a newer one superseded, whose cancel throws ${throwAtEnd ? 'after the stream throws' : 'at its next event'}, leaves its frame without a rejection`, async () => {
      const rejections: string[] = [];
      const onRejection = (reason: unknown) => { rejections.push(String(reason)); };
      process.on('unhandledRejection', onRejection);
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let fw: AgentFramework | null = null;
      let retiring: Promise<void> | undefined;
      const h = await restartTurn({
        wait: false, gate: true,
        makeStream: (index, responses) => (index === 0 ? new SupersededStream(released, throwAtEnd, responses) : undefined),
        // The continuation's start takes the agent's stream id before its
        // stream is made, so the restarted stream's end, released here, finds
        // its frame superseded. That frame's driveStream is still the agent's
        // entry in activeStreams: the new start sets its own after its compile.
        onStreamMade: (index) => {
          if (index !== 1 || !fw) return;
          retiring = internals(fw).activeStreams.get('prime');
          release();
        },
        beforeStart: (framework) => { fw = framework; },
      });
      try {
        await waitFor('the continuation to answer', () => h.traces.some((t) => t.type === 'inference:completed'));
        assert.ok(retiring, "the restarted stream's frame was running as the continuation's stream was made");
        await assert.doesNotReject(retiring, "driveStream's promise doesn't reject");
        assert.ok(h.logged.some((l) => /^\[turn\] prime: the cancel of a stream that no longer owns its agent \(a newer stream took it, or the agent was replaced or removed\) threw; its frame leaves all the same: /.test(l)));
        assert.deepEqual(rejections, [], 'and nothing else rejects unhandled');
      } finally {
        process.off('unhandledRejection', onRejection);
        await h.cleanup();
      }
    });
  }
});

describe('a batch that carries a continuation of the turn', () => {
  const completions = (h: { traces: TraceEvent[] }): number => h.traces.filter((t) => t.type === 'inference:completed').length;
  const BOB = { counterparty: 'srv:user:bob', wakeChannelId: 'srv:chan-bob', wakeAt: 1_000 };

  it("starts a tool-result guard's retry alone, with its turn's provenance, when a provider hold releases it with a wake it held before it, and the wake then starts a turn of its own", async () => {
    let alice!: InferenceRequest;
    const h = await guardRetryHeld((fw) => {
      // A wake for prime from alice arrives while its tool runs, and the hold takes it before the retry.
      alice = aliceWake();
      internals(fw).pendingRequests.push(alice);
    }, BOB);
    try {
      assert.deepEqual(heldReasons(h.framework), ['mcpl:channel-incoming', 'tool_result_guard_retry'], 'the wake is held ahead of the retry');
      const gate = internals(h.framework).eventGate as { onInferenceStarted(name: string): void; onInferenceResumed(name: string): void };
      const windows: string[] = [];
      const started = gate.onInferenceStarted.bind(gate);
      const resumed = gate.onInferenceResumed.bind(gate);
      gate.onInferenceStarted = (name) => { if (name === 'prime') windows.push('started'); started(name); };
      gate.onInferenceResumed = (name) => { if (name === 'prime') windows.push('resumed'); resumed(name); };
      h.framework.releaseProviderWait('prime');
      await waitFor("the retry's turn to answer", () => completions(h) > 0);
      // The start runs on the retry alone: it resumes its turn's gate window,
      // and names its turn's author, not the wake's.
      assert.equal(h.starts[1]?.reason, 'tool_result_guard_retry');
      assert.deepEqual(windows, ['resumed'], "the retry resumes its turn's gate window");
      assert.deepEqual(provenanceOf(h.starts[1]), BOB, "the retry's start names its turn's provenance");
      await waitFor('the wake to start a turn of its own', () => h.starts.length > 2);
      assert.equal(h.starts[2]?.reason, 'mcpl:channel-incoming');
      assert.deepEqual(windows, ['resumed', 'started'], 'the wake opens a gate window of its own');
      assert.deepEqual(provenanceOf(h.starts[2]), provenanceOf(alice), "the wake's turn names its own provenance");
    } finally {
      await h.cleanup();
    }
  });

  it("leaves a coalesced batch whose wake a provider hold took ahead of a guard retry to the wake's own turn, which assembles it", async () => {
    let coalescer!: ReturnType<typeof standInCoalescer>;
    const h = await guardRetryHeld((fw) => {
      // A batch for prime opens while its tool runs, and the hold takes its wake before the retry.
      coalescer = standInCoalescer(fw);
      coalescer.arm();
      internals(fw).pendingRequests.push(batchWake());
    });
    try {
      assert.deepEqual(heldReasons(h.framework), ['mcpl:push-event', 'tool_result_guard_retry'], "the batch's wake is held ahead of the retry");
      h.framework.releaseProviderWait('prime');
      await waitFor("the retry's turn to answer", () => completions(h) > 0);
      assert.equal(h.starts[1]?.reason, 'tool_result_guard_retry', 'the start runs on the retry alone');
      assert.deepEqual(coalescer.assembled, [], 'the retry assembles nothing');
      await waitFor("the batch's wake to start a turn of its own", () => h.starts.length > 2);
      await waitFor("that turn to answer", () => completions(h) > 1);
      assert.deepEqual(coalescer.assembled, ['prime:s1'], 'its turn assembles the batch');
      assert.equal(coalescer.pending(), false, 'and the batch is read');
    } finally {
      await h.cleanup();
    }
  });

  /** prime's budget restart with a wake queued beside it: `during` runs
   *  while the tool runs, and queues the request it returns, if any. With
   *  `hold`, a provider wait stated as the tool returns holds both, the wake
   *  ahead of the restart; without it, the wake waits for the turn and the
   *  restart is queued behind it. With `injects` false, each stream declares
   *  it can't carry injected messages. Each start records a copy of its
   *  trigger (starts). */
  async function restartBehind(during: (framework: AgentFramework) => InferenceRequest | undefined,
    { hold = true, silentFirst = false, injects = true } = {}) {
    const starts: Array<InferenceRequest | undefined> = [];
    let unblock!: () => void;
    const h = await restartTurn({
      wait: hold, silentFirst, until: () => true,
      ...(injects ? {} : { makeStream: (_index: number, responses: NormalizedResponse[]) => new MockYieldingStream(responses, false) }),
      blockFirstTool: new Promise<void>((r) => { unblock = r; }),
      onTrace: (framework, event) => {
        if (event.type === 'inference:started') {
          const t = framework.getActiveTurnTrigger('prime');
          starts.push(t && { ...t });
        }
      },
    });
    let request: InferenceRequest | undefined;
    try {
      await waitFor('the tool to start', () => h.module.firstToolStarted);
      request = during(h.framework);
      if (request) internals(h.framework).pendingRequests.push(request);
      unblock();
      if (hold) await waitFor('the restart to be held', () => heldForWait(h.framework));
    } catch (error) {
      unblock();
      await h.cleanup();
      throw error;
    }
    return { ...h, starts, request };
  }

  it('starts a budget restart alone when a provider hold releases it with a wake it held before it, and the wake then starts a turn of its own, with its own provenance', async () => {
    const h = await restartBehind(() => aliceWake());
    try {
      assert.deepEqual(heldReasons(h.framework), ['mcpl:channel-incoming', 'context_budget_restart'], 'the wake is held ahead of the restart');
      h.framework.releaseProviderWait('prime');
      await waitFor("the restart's turn to answer", () => completions(h) > 0);
      assert.equal(h.starts[1]?.reason, 'context_budget_restart', 'the start runs on the restart');
      assert.deepEqual(provenanceOf(h.starts[1]), provenanceOf(undefined), 'which names no author, as before');
      await waitFor('the wake to start a turn of its own', () => h.starts.length > 2);
      assert.equal(h.starts[2]?.reason, 'mcpl:channel-incoming');
      assert.deepEqual(provenanceOf(h.starts[2]), provenanceOf(h.request), "the wake's turn names its own provenance");
    } finally {
      await h.cleanup();
    }
  });

  it("leaves a coalesced batch whose wake a provider hold took ahead of a budget restart to the wake's own turn, which assembles it", async () => {
    let coalescer!: ReturnType<typeof standInCoalescer>;
    const h = await restartBehind((fw) => {
      coalescer = standInCoalescer(fw);
      coalescer.arm();
      return batchWake();
    });
    try {
      assert.deepEqual(heldReasons(h.framework), ['mcpl:push-event', 'context_budget_restart'], "the batch's wake is held ahead of the restart");
      h.framework.releaseProviderWait('prime');
      await waitFor("the restart's turn to answer", () => completions(h) > 0);
      assert.equal(h.starts[1]?.reason, 'context_budget_restart', 'the start runs on the restart');
      assert.deepEqual(coalescer.assembled, [], 'the restart assembles nothing');
      await waitFor("the batch's wake to start a turn of its own", () => h.starts.length > 2);
      await waitFor('that turn to answer', () => completions(h) > 1);
      assert.deepEqual(coalescer.assembled, ['prime:s1'], 'its turn assembles the batch');
      assert.equal(coalescer.pending(), false, 'and the batch is read');
    } finally {
      await h.cleanup();
    }
  });

  it("starts a silent turn's budget restart alone and silent when an ordinary wake waited for the turn, and the wake then starts a turn of its own", async () => {
    // No provider hold: the wake waits for the turn, and the restart is queued behind it.
    const h = await restartBehind(() => aliceWake(), { hold: false, silentFirst: true });
    try {
      assert.equal(h.starts[0]?.suppressProse, true, 'the turn is silent');
      await waitFor("the restart's turn to answer", () => completions(h) > 0);
      assert.equal(h.starts[1]?.reason, 'context_budget_restart', 'the start runs on the restart');
      assert.equal(h.starts[1]?.suppressProse, true, 'and resumes the turn silent');
      await waitFor('the wake to start a turn of its own', () => h.starts.length > 2);
      assert.equal(h.starts[2]?.reason, 'mcpl:channel-incoming');
      assert.equal(h.starts[2]?.suppressProse, undefined, "the wake's turn is its own, not silent");
    } finally {
      await h.cleanup();
    }
  });

  it("leaves a message the restart's turn couldn't hear to its wake's own turn, which reads it", async () => {
    // The streams carry no injected messages, so the message waits through the
    // tool boundary, deferred, and the restart's start flushes nothing.
    const HEARD_LATE = 'A message that arrived while the tool ran, which no stream could inject.';
    const h = await restartBehind((fw) => { pushMessage(fw, HEARD_LATE); return undefined; }, { hold: false, injects: false });
    const carries = (): boolean[] => h.membrane.calls.map((c) => JSON.stringify(c).includes(HEARD_LATE));
    try {
      await waitFor("the restart's turn to answer", () => completions(h) > 0);
      assert.equal(h.starts[1]?.reason, 'context_budget_restart', 'the start runs on the restart');
      assert.deepEqual(carries().slice(0, 2), [false, false], "neither the turn's request nor the restart's carries the message");
      await waitFor("the message's wake to start a turn of its own", () => h.starts.length > 2);
      await waitFor('that turn to answer', () => completions(h) > 1);
      assert.deepEqual(carries(), [false, false, true], "the wake's turn reads it");
    } finally {
      await h.cleanup();
    }
  });

  it("leaves an autoContinue wake queued beside a budget restart to a turn of its own, which writes its [continue] row", async () => {
    const ROW = '[continue] prime, another turn starts now.';
    const h = await restartBehind(() => ({
      agentName: 'prime', reason: 'auto-continue', source: 'framework', timestamp: Date.now(), autoContinueRun: { stop: 'call skip_reply' },
    }), { hold: false });
    try {
      await waitFor("the restart's turn to answer", () => completions(h) > 0);
      assert.equal(h.starts[1]?.reason, 'context_budget_restart', 'the start runs on the restart');
      assert.ok(!requestTexts(h.membrane.calls[1]).includes(ROW), "the restart's request carries no row");
      await waitFor("the continuation's wake to start a turn of its own", () => h.starts.length > 2);
      assert.equal(h.starts[2]?.reason, 'auto-continue');
      await waitFor('that turn to answer', () => completions(h) > 1);
      assert.ok(requestTexts(h.membrane.calls[2]).includes(ROW), "its turn's request carries its row");
    } finally {
      await h.cleanup();
    }
  });
});

describe("an ephemeral run whose turn's continuation is dropped", () => {
  for (const drop of [true, false]) {
    it(drop ? "settles at once, rejecting with the drop's reason" : 'completes when its continuation runs (control)', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'turn-continuation-'));
      const membrane = new SequentialStreamMembrane();
      membrane.pushResponse(nearCapToolResponse());
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered.' }]));
      const module = new RestartToolModule(false);
      const origError = console.error;
      console.error = () => {};
      const framework = await AgentFramework.create({
        storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(), agents: [], modules: [module], syncIntervalMs: 0,
        // The policy drops the budget restart's continuation.
        inferencePolicy: { shouldInfer: (_agent: string, requests: InferenceRequest[]) => !drop || !requests.some((r) => r.reason === 'context_budget_restart') } as never,
      });
      module.framework = framework;
      const traces: TraceEvent[] = [];
      framework.onTrace((e) => { traces.push(e); });
      try {
        const created = await framework.createEphemeralAgent({
          name: 'worker', model: 'test-model', systemPrompt: 'You work.', allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000,
        } as never);
        created.contextManager.addMessage('user', [{ type: 'text', text: 'fetch it' }]);
        // The idle watchdog would end a run left unsettled, with its own message, after 5 s.
        const ended = framework.runEphemeralToCompletion(created.agent, created.contextManager, { idleTimeoutMs: 5_000, idlePollMs: 50 })
          .then((result) => ({ result }), (error: unknown) => ({ error }));
        framework.start();
        const outcome = await ended;
        if (drop) {
          assert.ok('error' in outcome, 'the run rejects');
          const error = outcome.error as Error;
          assert.equal(error.constructor, Error, 'a plain Error');
          assert.equal(error.message, "worker's turn ended without its continuation: the inference policy dropped its continuation");
          assert.deepEqual(traces.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason), [CONTINUATION_DROPPED]);
        } else {
          assert.ok('result' in outcome, `the run completes: ${'error' in outcome ? String(outcome.error) : ''}`);
          assert.match(outcome.result.speech, /Recovered\./);
        }
      } finally {
        console.error = origError;
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }
});

describe("stop() and the turns whose continuations are on their way", () => {
  it("ends each agent's turn even when ending another's throws", async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      // A second agent's continuation waits in a scheduler pass's hands, as
      // while the pass awaits another agent's start: after prime's, in the
      // order stop() ends them.
      const pass = new Map([['alpha', [{ agentName: 'alpha', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() }]]]);
      (h.framework as unknown as { passRequests: Set<Map<string, InferenceRequest[]>> }).passRequests.add(pass);
      // Ending prime's turn throws.
      const fw = h.framework as unknown as { dropContinuations(name: string, drop: unknown): void };
      const drop = fw.dropContinuations.bind(fw);
      fw.dropContinuations = (name, how) => {
        if (name === 'prime') throw new Error('zz ending prime threw');
        drop(name, how);
      };
      await assert.rejects(h.framework.stop(), /zz ending prime threw/);
      assert.deepEqual(pass.get('alpha'), [], "alpha's continuation is taken out of the pass");
      assert.ok(h.endLines().some((l) => l.startsWith('[turn-continuation] alpha: its turn ends without its continuation: the framework is stopping')),
        `alpha's turn ends: ${JSON.stringify(h.endLines())}`);
    } finally {
      await h.cleanup().catch(() => {});
    }
  });
});

describe("a nudge while the agent's turn waits for its continuation", () => {
  it('reports the agent as idle+turn-alive, as the scheduler reads it', async () => {
    const h = await restartTurn({ wait: true });
    try {
      await waitFor('the continuation to be held, its frame gone', () => heldForWait(h.framework) && frameLetGo(h.framework));
      const result = h.framework.nudgeAgent('prime', 'zz-operator');
      assert.deepEqual(result, { ok: true, agentName: 'prime', agentStatus: 'idle+turn-alive' });
      assert.ok(h.logged.includes('[nudge] agent=prime queued by=zz-operator status=idle+turn-alive'));
      const recorded = h.traces.find((t) => t.type === 'operator:action' && (t as { kind?: string }).kind === 'nudge') as { result?: { agentStatus?: string } } | undefined;
      assert.equal(recorded?.result?.agentStatus, 'idle+turn-alive', 'the operator-action record says so too');
      assert.deepEqual(h.framework.getHostModeStatus().activeTurnAgents, ['prime']);
    } finally {
      await h.cleanup();
    }
  });
});

describe("a conversation agent's disposal while its turn's continuation is held", () => {
  it('ends the turn and empties the hold', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'turn-continuation-'));
    const membrane = new SequentialStreamMembrane();
    membrane.pushResponse(nearCapToolResponse());
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered.' }]));
    const module = new RestartToolModule(true);
    const fork = forkAgentName('conversation', 'zz-server', 'zz-chat', 1);
    module.waitFor = fork;
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store'), membrane: membrane.asMembrane(), modules: [module], syncIntervalMs: 0,
      agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all', maxTokens: 4_000, physicalWindowTokens: 200_000 }],
      conversations: { templateAgent: 'prime', bind: { channel: 'always' }, trigger: { channel: 'mention' } },
    } as never);
    module.framework = framework;
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => { traces.push(e); });
    const internal = framework as unknown as Internals & {
      spawnConversationAgent(channel: { serverId: string; channelId: string }, decision: { agentName: string; generation: number }): Promise<unknown>;
    };
    try {
      framework.start();
      // The channel's fork, spawned as a routing spawns it, takes a turn whose tool round restarts it.
      await internal.spawnConversationAgent({ serverId: 'zz-server', channelId: 'zz-chat' }, { agentName: fork, generation: 1 });
      // On this branch a fork's home is the registry's (homeChannel), not a framework map.
      assert.ok(framework.getAgentRecord(fork)?.kind === 'conversation-fork', 'a conversation agent');
      framework.getAgent(fork)!.getContextManager().addMessage('User', [{ type: 'text', text: 'fetch it' }]);
      internal.pendingRequests.push({ agentName: fork, reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor("the fork's continuation to be held, its frame gone", () =>
        (internal.providerAccelerationCooldowns.get(fork)?.heldRequests.some((r) => r.reason === 'context_budget_restart') ?? false)
        && !internal.activeTurnTokens.has(fork));
      assert.deepEqual(framework.getHostModeStatus().activeTurnAgents, [fork]);
      internal.disposeConversationAgent(fork);
      assert.deepEqual(framework.getHostModeStatus().activeTurnAgents, [], 'no turn is left alive');
      assert.deepEqual(internal.providerAccelerationCooldowns.get(fork)?.heldRequests ?? [], [], 'the hold keeps nothing of it');
      assert.ok(logged.some((l) => l === `[turn-continuation] ${fork}: its turn ends without its continuation: its agent was disposed`));
      assert.deepEqual(traces.filter((t) => t.type === 'inference:aborted').map((t) => (t as { reason?: string }).reason), [CONTINUATION_DROPPED]);
      assert.equal(membrane.calls.length, 1, 'the continuation never ran');
    } finally {
      console.error = origError;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
