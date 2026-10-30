/**
 * A held turn's retry: a turn whose call failed into a provider hold (a
 * provider's stated wait, a host's hold, an acceleration cooldown) has begun
 * and not ended. Until the hold releases its retry, the agent is mid-turn:
 * not drained, listed among the turn's agents, refused surgery, let through a
 * quiesce, and ended by an abandon or a stop. A wake a hold keeps at
 * admission, with no turn of its own begun, is none of these.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { bindAsConversationFork } from './helpers/dendrite.js';

function withStoreDir<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'held-turn-retry-'));
  return Promise.resolve(fn(join(dir, 'store'))).finally(() => rmSync(dir, { recursive: true, force: true }));
}

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

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  /** `gate`: the error comes once it resolves, so the call is in flight
   *  until then. */
  constructor(private readonly error: Error, private readonly gate?: Promise<void>, private readonly throws = false) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.gate) await this.gate;
    if (this.throws) throw this.error;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const rateLimited = (retryAfterMs: number | undefined, request?: NormalizedRequest) => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs,
  message: 'zz rate limit reached for requests', rawError: { status: 429 }, rawRequest: request,
});

/** Turn calls answer, except those `fails` names (1-based), which fail with
 *  `failure`. */
class ScriptedMembrane extends MockMembrane {
  primary = 0;
  /** `setup`: a failing call throws as its stream is made, which the turn's
   *  start reports; `event`: its stream reports the error, and `throw`: its
   *  stream throws it, each of which driveStream reports. */
  constructor(
    private readonly fails: Set<number>,
    private readonly failure: (request: NormalizedRequest) => Error,
    private readonly failsAt: 'event' | 'setup' | 'throw' = 'event',
  ) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.primary++;
    if (this.fails.has(this.primary) && this.failsAt === 'setup') throw this.failure(request);
    if (this.fails.has(this.primary)) return new ErrorStream(this.failure(request), undefined, this.failsAt === 'throw');
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.primary}` }])]);
  }
}

type Request = { agentName: string; reason: string; source: string; timestamp: number; coalescingSubject?: string; suppressProse?: boolean };
type Internal = {
  withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>, model?: string): Promise<T>;
  parkedContinuations: Set<unknown>;
  activeTurnTokens: Map<string, number>;
  cancelCoalescedWakes(subject: string): void;
  closingConversationAgents: Set<string>;
  conversationRouter: unknown;
  lastConversationSweep: number;
  sweepExpiredConversations(): void;
  disposeConversationAgent(agentName: string): void;
  providerAccelerationCooldowns: Map<string, { until: number; heldRequests: Request[] }>;
  pendingRequests: Request[];
  providerWaits: { set(agent: string, model: string, retryAfterMs: unknown, reason: string): unknown };
  startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
  releaseProviderAccelerationCooldown(agentName: string): void;
  holdProviderAcceleration(agent: unknown, error: Error, trigger?: unknown, auxiliary?: boolean): boolean;
  providerGate(agentName: string): { auxiliaryInFlight: number; idleWaiters: Array<() => void> };
};

async function framework(path: string, membrane: ScriptedMembrane, extra: Record<string, unknown> = {}) {
  const fw = await AgentFramework.create({
    storePath: path, membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...extra,
  });
  return { fw, internal: fw as unknown as Internal };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** As provider-waits.test.ts's: `Date` held still, the hold's timers real.
 *  `outlast(wait)` lets real time pass the wait with the clock inside it;
 *  `pass(wait)` moves the clock past it. */
function holdClock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  return {
    outlast: (waitMs: number) => sleep(waitMs + 100),
    pass: (waitMs: number) => t.mock.timers.tick(waitMs + 1),
    advance: (ms: number) => t.mock.timers.tick(ms),
  };
}

function silence() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

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
async function waitFor(fw: AgentFramework, done: () => boolean, what: string, boundMs = 5_000): Promise<void> {
  const deadline = performance.now() + boundMs;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`zz-timeout: ${what} did not happen within ${boundMs} ms`);
    void drive(fw);
    await sleep(20);
  }
}

const texts = (request: NormalizedRequest) => request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join(' | ');

/** A resident's first turn answers; its second message's turn meets a 429
 *  stating `wait` ms, and a provider wait holds it for its retry. */
async function heldTurn(fw: AgentFramework, internal: Internal, membrane: ScriptedMembrane) {
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
  await waitFor(fw, () => membrane.primary >= 1, 'the first turn');
  await fw.runUntilIdle();
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-second', metadata: {} });
  await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'the second turn held');
  assert.equal(membrane.primary, 2);
}

test("a resident whose turn a stated wait holds for its retry is mid-turn: not drained, listed, refused surgery naming the hold; the hold's end runs the retry", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      const status = fw.getHostModeStatus();
      assert.equal(status.drained, false, 'the held turn is alive');
      assert.equal(status.activeTurns, 1);
      assert.deepEqual(status.activeTurnAgents, ['resident']);

      const ctx = fw.getAgent('resident')!.getContextManager();
      const before = ctx.queryMessages({}).messages.map((m) => m.id);
      const first = ctx.queryMessages({}).messages.find((m) => JSON.stringify(m.content).includes('zz-first'))!;
      const { cooldownUntil } = (fw.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { cooldownUntil: number | null } }> })
        .agents.find((a) => a.name === 'resident')!.providerAdmission;
      const until = new Date(cooldownUntil!).toISOString();
      await assert.rejects(fw.rollbackToMessage('resident', { messageId: first.id }), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'agent-busy');
        for (const part of ['provider hold', until, 'zz rate limit reached for requests', 'abandon: true', 'release-provider-wait']) {
          assert.ok(error.message.includes(part), `${JSON.stringify(part)} in: ${error.message}`);
        }
        return true;
      });
      assert.deepEqual(ctx.queryMessages({}).messages.map((m) => m.id), before, 'the store is as it was');
      await assert.rejects(fw.puppetToolCall('resident', 'zz-tool', {}), (error: Error) => {
        assert.ok(error.message.startsWith('puppet refused: agent resident is idle+turn-alive (a provider hold keeps its turn to start again, until '), error.message);
        assert.ok(error.message.includes(': zz rate limit reached for requests; requires idle); a quiesce lets a held turn start when its hold ends and finish'), error.message);
        assert.ok(error.message.includes('or lift a stated wait with release-provider-wait'), error.message);
        assert.ok(!error.message.includes('active stream'), `a held turn has no stream: ${error.message}`);
        return true;
      }, 'a puppet call is refused too, naming the hold');

      // Real time passes the wait while the clock stays inside it: the hold
      // stands, and the turn with it. Then the wait passes, and its retry runs.
      await clock.outlast(wait);
      assert.equal(fw.getHostModeStatus().drained, false, 'still alive while the hold stands');
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 3, 'the retry after the wait');
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 3, 'one retry');
      assert.match(texts(membrane.calls[2]), /zz-second/, 'the retry answers the message its turn was for');
      assert.equal(fw.getHostModeStatus().drained, true, 'and the turn is over');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a quiesce waits for a held turn, and lets its retry start when the hold ends and finish; a wake that arrives meanwhile parks', async () => {
  await withStoreDir(async (path) => {
    // Real time: a quiesce's drain deadline reads the clock. The hold stands
    // until the test lifts its wait, so the quiesce is seen waiting first.
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      let settled = false;
      const quiesce = fw.quiesce({ timeoutMs: 10_000 }).finally(() => { settled = true; });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      assert.equal(fw.getHostModeStatus().drained, false, 'a quiesce does not take a held turn for drained');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident']);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-third', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(settled, false, 'the quiesce waits while the hold stands');
      fw.releaseProviderWait('resident');
      // The test drives the framework, as a host's event loop would.
      await waitFor(fw, () => settled, 'the quiesce to settle', 9_000);
      const status = await quiesce;
      assert.equal(status.drained, true, 'and resolves drained once the retry has finished the turn');
      assert.equal(membrane.primary, 3, 'the retry ran, and nothing else');
      assert.match(texts(membrane.calls[2]), /zz-second/);
      assert.equal(fw.getHostModeStatus().quiesced, true);
      assert.equal(fw.getHostModeStatus().gatedRequests, 1, 'the later wake parks until resume');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a quiesce with abandon ends a held turn once its drain wait runs out: its retry is dropped with one inference:aborted, and the hold's end starts nothing", async () => {
  await withStoreDir(async (path) => {
    // Real time: a quiesce's drain deadline reads the clock. The hold far
    // outlasts the drain wait, so the abandon comes while it stands.
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      await heldTurn(fw, internal, membrane);
      // The drain wait runs out first (1 s, the least a quiesce takes), and
      // the abandon ends the turn then.
      const started = performance.now();
      const status = await fw.quiesce({ timeoutMs: 50, abandon: true });
      assert.ok(performance.now() - started >= 950, 'the abandon came after the drain wait');
      assert.equal(status.drained, true, 'the abandon ended it');
      assert.deepEqual(aborted, ['quiesce_abandoned'], 'one inference:aborted');
      assert.ok(internal.providerAccelerationCooldowns.has('resident'), 'with the hold still standing');
      // The operator lifts the wait: the hold, emptied by the drop, starts nothing.
      fw.releaseProviderWait('resident');
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('resident'), "the hold's end");
      await fw.resume();
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'no retry after the hold, nor after the resume');
      assert.deepEqual(aborted, ['quiesce_abandoned']);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('stop() ends a held turn with one inference:aborted', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      await heldTurn(fw, internal, membrane);
    } finally {
      await fw.stop();
      log.restore();
    }
    assert.deepEqual(aborted, ['shutdown']);
  });
});

test("a host's hold (providerHold) keeps the failed turn alive, and surgery's refusal names it", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(undefined, request));
    // The host holds the failure once; asked again as the hold ends, it lets
    // the turn go on.
    let holds = 0;
    const { fw, internal } = await framework(path, membrane, {
      providerHold: () => (holds++ === 0 ? { holdMs: 400, reason: 'zz-host-hold' } : undefined),
    });
    try {
      await heldTurn(fw, internal, membrane);
      assert.equal(fw.getHostModeStatus().drained, false);
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'agent-busy');
        assert.ok(error.message.includes('(a provider hold keeps its turn to start again, until '), error.message);
        assert.ok(error.message.includes(': zz-host-hold)'), error.message);
        assert.ok(!error.message.includes('release-provider-wait'), `a host's hold isn't a stated wait to lift: ${error.message}`);
        return true;
      });
      // The framework holds for at least its own floor, whatever the host asked.
      clock.pass(internal.providerAccelerationCooldowns.get('resident')!.until - Date.now());
      await waitFor(fw, () => membrane.primary >= 3, 'the retry after the host hold');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a conversation agent's turn a stated wait holds for its retry is alive too", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([1]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
      fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      await internal.startAgentStream(fw.getAgent('resident'), { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'held');
      assert.equal(fw.getHostModeStatus().drained, false);
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident']);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a wake a recorded wait holds at admission, with no turn of its own begun, keeps no turn alive, and a stop has nothing to end', async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    // The first call is refused outright, with a stated wait: its failure is
    // terminal, and the wait binds the wake after it.
    const membrane = new ScriptedMembrane(new Set([1]), (request) => new MembraneError({
      type: 'invalid_request', retryable: false, httpStatus: 400, retryAfterMs: wait,
      message: 'zz request refused', rawError: { status: 400 }, rawRequest: request,
    }));
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the wait', metadata: {} });
      await fw.runUntilIdle();
      // Its duplicate (the clock is held, so the two are equal) merges with it.
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the wait', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the wake, its duplicate merged');
      const status = fw.getHostModeStatus();
      assert.equal(status.drained, true, 'a held wake is no turn');
      assert.deepEqual(status.activeTurnAgents, []);
      assert.equal(fw.abortInference('resident', 'zz-stop'), false, 'abortInference has no turn to stop');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'and the wake stays held');
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 2, 'the held wake after the wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a quiesced host's scheduler lets a released retry through, counts only the wakes it parks, and runs until the retry has run", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      // Under the held clock the quiesce's drain wait can't time out: it ends
      // once the turn has, or at the stop.
      const quiesce = fw.quiesce({ timeoutMs: 1_000 });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      // A real clock stamps the arrival after the failed turn; under the held
      // one the hold would keep the two as one request (sameInferenceRequest).
      clock.advance(1);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-third', metadata: {} });
      await fw.runUntilIdle();
      // The hold's end, with nothing run since: the retry and the wake it
      // kept are queued, the retry first.
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2, 'the hold keeps the retry and the wake');
      clock.pass(wait);
      internal.releaseProviderAccelerationCooldown('resident');
      assert.equal(internal.pendingRequests.length, 2);
      assert.equal(fw.getHostModeStatus().gatedRequests, 1, 'the quiesce gates the wake, not the retry');
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 3, 'the retry ran before the run was idle');
      assert.match(texts(membrane.calls[2]), /zz-second/);
      assert.equal(fw.getHostModeStatus().gatedRequests, 1, 'the wake stays parked');
      assert.equal((await quiesce).drained, true, 'and the quiesce drained');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a held turn's retry merged behind another wake keeps its turn alive while it parks behind an auxiliary call, through a quiesce, which sends it back as its batch, and when a wait recorded meanwhile holds them again", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      // A wake queued before the hold's end, so the release puts the retry
      // behind it and the merged start leads with the wake.
      clock.advance(1);
      internal.pendingRequests.push({ agentName: 'resident', reason: 'zz-earlier', source: 'zz-server', timestamp: Date.now() });
      clock.pass(wait);
      internal.releaseProviderAccelerationCooldown('resident');
      assert.equal(internal.pendingRequests[0].reason, 'zz-earlier');
      // An auxiliary call in flight parks the start.
      const gate = internal.providerGate('resident');
      gate.auxiliaryInFlight = 1;
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'parked, not sent');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident'], 'alive while it parks');
      // The host quiesces, and a wait is recorded on the model, while it
      // parks. (Under the held clock the quiesce's drain wait ends at the stop.)
      void fw.quiesce({ timeoutMs: 1_000 });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz later wait');
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'held again');
      // The quiesce sent the merged start back to the scheduler as its batch,
      // and the wait recorded meanwhile holds the two apart.
      assert.ok(log.lines.some((line) => line.includes('the merged start goes back as its 2 requests')), 'the merged start went back as its batch');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2, 'the retry and the wake held apart');
      assert.equal(membrane.primary, 2);
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident'], 'alive while held again');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("the inference policy dropping a held turn's retry ends the turn with one inference:aborted", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    let refuse = false;
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane, {
      inferencePolicy: { shouldInfer: () => !refuse },
    });
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      await heldTurn(fw, internal, membrane);
      refuse = true;
      clock.pass(wait);
      internal.releaseProviderAccelerationCooldown('resident');
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'no retry');
      assert.deepEqual(aborted, ["a turn's continuation was dropped before it started"], 'one inference:aborted, as a dropped continuation');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, []);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a conversation agent's turn a wait recorded during its compile holds is alive while held", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set(), () => new Error('unused'));
    const { fw, internal } = await framework(path, membrane);
    try {
      bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
      const agent = fw.getAgent('resident')!;
      agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      // Its own compression records a wait while the turn compiles.
      const compile = agent.startStreamWithInjections.bind(agent);
      agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
        const made = await compile(...args);
        internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz wait during the compile');
        return made;
      }) as typeof compile;
      await internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      assert.ok(log.lines.some((line) => line.includes('binds after the compile')), 'held after the compile, its stream cancelled unread');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident']);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('on a host already quiesced, a quiesce with abandon ends a held turn at once', async (t) => {
  await withStoreDir(async (path) => {
    // Under the held clock a drain wait never runs out: a quiesce that waited
    // for one would never return.
    holdClock(t);
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      await heldTurn(fw, internal, membrane);
      const first = fw.quiesce({ timeoutMs: 50 });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      assert.deepEqual(aborted, []);
      const second = await fw.quiesce({ abandon: true });
      assert.equal(second.drained, true, 'ended without a drain wait of its own');
      assert.deepEqual(aborted, ['quiesce_abandoned']);
      assert.equal((await first).drained, true, 'and the first quiesce drained with it');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stated wait with no end holds the turn until released, and surgery's refusal says so", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(Number.POSITIVE_INFINITY, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'agent-busy');
        assert.ok(error.message.includes('(a provider hold keeps its turn to start again, until released: zz rate limit reached for requests)'), error.message);
        return true;
      });
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A conversation agent's turn, held for its retry by a stated wait. */
async function heldConversationTurn(fw: AgentFramework, internal: Internal) {
  bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
  fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
  await internal.startAgentStream(fw.getAgent('resident'), { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
  await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'held');
}

test("a conversation agent disposed while a hold keeps its turn's retry: the retry is dropped, with one inference:aborted", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([1]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      await heldConversationTurn(fw, internal);
      const hold = internal.providerAccelerationCooldowns.get('resident')!;
      assert.equal(hold.heldRequests.length, 1);
      internal.disposeConversationAgent('resident');
      assert.equal(aborted.length, 1, `one inference:aborted (${aborted.join(', ')})`);
      assert.equal(hold.heldRequests.length, 0, 'the retry is gone from the hold');
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const site of ['after-compile', 'throw'] as const) test(`an agent that a listener of its turn's inference:failed stops (stopAgent) is held by nothing, at ${site === 'after-compile' ? "a conversation agent's hold after its compile" : "a resident's stream that throws where a host's hold would take it, which the registry's live check refuses first"}: no hold keeps a retry for an agent that has ended`, async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = site === 'throw'
      ? new ScriptedMembrane(new Set([1]), (request) => rateLimited(undefined, request), 'throw')
      : new ScriptedMembrane(new Set(), () => new Error('unused'));
    // 'lead' owns default delivery, so 'resident' can be stopped.
    const { fw, internal } = await framework(path, membrane, {
      agents: [{ name: 'lead', model: 'zz-model', systemPrompt: 'system' }, { name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
      ...(site === 'throw' ? { providerHold: () => ({ holdMs: 60_000, reason: 'zz-host-hold' }) } : {}),
    });
    let stopped = false;
    fw.onTrace((event) => {
      if (event.type === 'inference:failed' && event.agentName === 'resident' && !stopped) {
        stopped = true;
        fw.stopAgent('resident', { by: 'zz-host', reason: 'zz-listener stop' });
      }
    });
    try {
      const agent = fw.getAgent('resident')!;
      agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      if (site === 'after-compile') {
        bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
        // Its own compression records a wait while the turn compiles.
        const compile = agent.startStreamWithInjections.bind(agent);
        agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
          const made = await compile(...args);
          internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz wait during the compile');
          return made;
        }) as typeof compile;
      }
      await internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => stopped && fw.getAgent('resident') === null, 'the failure reported and the agent stopped');
      await sleep(50);
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'no hold keeps a retry for it');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, [], 'no turn is left alive');
      if (site === 'after-compile') {
        assert.ok(log.lines.some((line) => line.includes('binds after the compile') && line.includes('the agent ended as the failure was reported, so nothing is held')),
          `the log says why nothing is held: ${log.lines.filter((line) => line.includes('binds after the compile')).join(' | ')}`);
      }
    } finally { await fw.stop(); log.restore(); }
  });
});

test("the closing-conversation reaper doesn't dispose a closing conversation agent while a hold keeps its turn's retry", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([1]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldConversationTurn(fw, internal);
      // Closing, with no expired binding left for the sweep to close.
      internal.closingConversationAgents.add('resident');
      const router = internal.conversationRouter;
      internal.conversationRouter = { expired: () => [] };
      internal.lastConversationSweep = 0;
      try { internal.sweepExpiredConversations(); } finally { internal.conversationRouter = router; }
      assert.ok(fw.getAgent('resident'), 'still registered: its turn is alive');
      assert.ok(internal.closingConversationAgents.has('resident'));
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const failsAt of ['event', 'setup'] as const) test(`an error policy's retry (of a failure at the stream's ${failsAt}), held at the last admission boundary by a wait a conversation agent's own compression recorded during the policy's delay, keeps its turn alive and surgery refused`, async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    // The turn's call fails with a 500: the default policy retries it in its
    // frame after 1 s. A failure of the stream's setup is the turn's start's
    // to report and retry; an error event, driveStream's.
    const membrane = new ScriptedMembrane(new Set([1]), (request) => new MembraneError({
      type: 'server', retryable: true, httpStatus: 500, message: 'zz internal error', rawError: { status: 500 }, rawRequest: request,
    }), failsAt);
    const { fw, internal } = await framework(path, membrane);
    try {
      bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
      const agent = fw.getAgent('resident')!;
      agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      void internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => membrane.primary >= 1, 'the failed call');
      // Its own compression records a wait during the policy's delay (a
      // conversation agent's auxiliary calls take no provider gate): the
      // retry's start meets it at the last boundary, and is held.
      internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz wait its compression recorded');
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'held at the last boundary');
      assert.equal(membrane.primary, 1, 'nothing sent');
      await waitFor(fw, () => !internal.activeTurnTokens.has('resident'), "the failed frame's end");
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident'], 'alive while held');
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'agent-busy');
        assert.ok(error.message.includes('(a provider hold keeps its turn to start again, until '), error.message);
        return true;
      });
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an organization-acceleration cooldown a stated wait set keeps the turn alive, and the refusal offers release-provider-wait", async (t) => {
  await withStoreDir(async (path) => {
    holdClock(t);
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 400,
      message: "zz this organization's acceleration limit was reached", rawError: { status: 429 }, rawRequest: request,
    }));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      assert.ok(log.lines.some((line) => line.includes('organization acceleration 429')), 'an acceleration cooldown');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident']);
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'agent-busy');
        assert.ok(error.message.includes('lift a stated wait with release-provider-wait'), error.message);
        return true;
      });
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const [label, site, host] of [
  ["a resident's stated wait, at its stream's error event", 'event', false],
  ["a host's hold, at a resident's stream's error event", 'event', true],
  ["a resident's thrown stream", 'throw', false],
  ["a resident's stream setup", 'setup', false],
  ["a conversation agent's stream error event", 'conversation-event', false],
  ["a conversation agent's thrown stream", 'conversation-throw', false],
  ["a conversation agent's stream setup", 'conversation-setup', false],
  ["a conversation agent's compile during which a wait was recorded", 'after-compile', false],
] as const) test(`a turn whose failure would be held (${label}), but stop() has closed admission from its inference:failed listener, holds nothing and ends then: inference:failed, then inference:aborted, as a retry the stop cancelled ends`, async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const conversation = site.startsWith('conversation') || site === 'after-compile';
    const failsAt = site === 'event' || site === 'conversation-event' ? 'event' : site === 'setup' || site === 'conversation-setup' ? 'setup' : 'throw';
    const fails = site === 'after-compile' ? new Set<number>() : new Set([conversation ? 1 : 2]);
    const membrane = new ScriptedMembrane(fails, (request) => rateLimited(host ? undefined : 60_000, request), failsAt);
    const { fw, internal } = await framework(path, membrane,
      host ? { providerHold: () => ({ holdMs: 60_000, reason: 'zz-host-hold' }) } : {});
    // A host whose inference:failed listener stops the framework: the
    // failure is reported before a hold would take the retry, so the stop
    // has closed admission when the site asks the hold to take it.
    let stopped: Promise<void> | undefined;
    const events: Array<[string, string | undefined]> = [];
    let watching = false;
    fw.onTrace((event) => {
      if (!watching || (event.type !== 'inference:failed' && event.type !== 'inference:aborted')) return;
      if (event.agentName !== 'resident') return;
      events.push([event.type, event.type === 'inference:aborted' ? event.reason : undefined]);
      if (event.type === 'inference:failed' && !stopped) stopped = fw.stop();
    });
    try {
      if (conversation) {
        bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
        const agent = fw.getAgent('resident')!;
        agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
        if (site === 'after-compile') {
          const compile = agent.startStreamWithInjections.bind(agent);
          agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
            const made = await compile(...args);
            internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz wait during the compile');
            return made;
          }) as typeof compile;
        }
        watching = true;
        void internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      } else {
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
        await waitFor(fw, () => membrane.primary >= 1, 'the first turn');
        await fw.runUntilIdle();
        watching = true;
        fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-second', metadata: {} });
      }
      await waitFor(fw, () => stopped !== undefined, 'the failure, and the stop');
      await stopped;
      await waitFor(fw, () => events.length >= 2, "the turn's end");
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'no hold installed after the stop');
      const status = fw.getHostModeStatus();
      assert.deepEqual(status.activeTurnAgents, [], 'no turn left alive');
      assert.equal(status.drained, true);
      assert.deepEqual(events, [
        ['inference:failed', undefined],
        ['inference:aborted', 'a retry waiting while the framework was stopping is dropped before it sends anything'],
      ], 'its failure, then the end a cancelled retry gets');
    } finally {
      await stopped;
      await fw.stop();
      log.restore();
    }
  });
});

test("a closing conversation agent whose closure turn fails into a hold isn't disposed by that frame; its retry finishes the turn, and then it is", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([1]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      internal.closingConversationAgents.add('resident');
      await heldConversationTurn(fw, internal);
      // The failed frame's end, whose last step is the closing agent's check.
      await waitFor(fw, () => !internal.activeTurnTokens.has('resident'), "the failed frame's end");
      assert.ok(fw.getAgent('resident'), "the failed frame left the closing agent to its retry");
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 2, 'the retry');
      await waitFor(fw, () => !fw.getAgent('resident'), 'disposed once its turn ended');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a held retry of a coalesced wake carries no subject, so a later occurrence's withdrawal of the subject's wakes leaves it held and its turn alive", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(60_000, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await waitFor(fw, () => membrane.primary >= 1, 'the first turn');
      await fw.runUntilIdle();
      // The second turn is a coalesced wake's, in the subject zz-subject.
      fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-second' }]);
      internal.pendingRequests.push({ agentName: 'resident', reason: 'zz-coalesced', source: 'test', timestamp: Date.now(), coalescingSubject: 'zz-subject' } as Request);
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'held');
      const hold = internal.providerAccelerationCooldowns.get('resident')!;
      assert.equal(hold.heldRequests.length, 1);
      // A new occurrence in the subject withdraws the subject's waiting wakes.
      internal.cancelCoalescedWakes('zz-subject');
      assert.equal(hold.heldRequests.length, 1, 'the retry stays held');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident'], 'its turn alive');
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => error.code === 'agent-busy');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("abortInference() ends a held turn: its retry is dropped, with one inference:aborted carrying the stop's reason, and the hold's end starts nothing", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      await heldTurn(fw, internal, membrane);
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true, 'abortInference reports the stop');
      assert.deepEqual(aborted, ['zz-operator stop'], "one inference:aborted, with the stop's reason");
      const status = fw.getHostModeStatus();
      assert.deepEqual(status.activeTurnAgents, [], 'the turn is over');
      assert.equal(status.drained, true);
      assert.ok(JSON.stringify(fw.getAgent('resident')!.getContextManager().queryMessages({}).messages).includes('[turn-interrupted]'),
        'the store has the stop\'s note');
      clock.pass(wait);
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('resident'), "the hold's end");
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'no retry after the hold');
      assert.equal(fw.abortInference('resident', 'zz-again'), false, 'and nothing left to stop');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a wake that arrived during the hold still runs after abortInference() ended the held turn', async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      clock.advance(1);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-third', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2, 'the hold keeps the retry and the wake');
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the wake stays held');
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 3, 'the wake after the hold');
      assert.match(texts(membrane.calls[2]), /zz-third/);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a start parked behind an auxiliary call whose failure arms a host's hold makes no call while the hold stands, as a new wake doesn't, and its turn answers once the hold releases", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let spent = true;
    const membrane = new ScriptedMembrane(new Set(), (request) => rateLimited(undefined, request));
    const { fw, internal } = await framework(path, membrane, { providerHold: () => (spent ? { holdMs: 1_000, reason: 'zz-host-hold' } : undefined) });
    try {
      let failAuxiliary!: (error: Error) => void;
      const auxiliary = internal.withAuxiliaryAdmission('resident', () => new Promise<never>((_, reject) => { failAuxiliary = reject; }))
        .catch(() => {});
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-parked', metadata: {} });
      await waitFor(fw, () => fw.getHostModeStatus().parkedAdmissions === 1, 'the start parked behind the auxiliary call');
      failAuxiliary(rateLimited(undefined));
      await auxiliary;
      const kept = () => internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length ?? 0;
      await waitFor(fw, () => kept() === 1 || membrane.primary > 0, 'the hold to keep the parked start, or its call');
      assert.equal(membrane.primary, 0, 'no turn call while the hold stands');
      assert.equal(fw.getHostModeStatus().parkedAdmissions, 0, 'held as a wake, not parked');
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during', metadata: {} });
      await waitFor(fw, () => kept() === 2 || membrane.primary > 0, 'the hold to keep a wake that came meanwhile, or a call');
      assert.equal(membrane.primary, 0, 'still no call');
      spent = false;
      await waitFor(fw, () => membrane.primary === 1, "the turn's call once the hold releases");
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'the hold has ended');
      assert.match(texts(membrane.calls[0]!), /zz-parked/);
      assert.match(texts(membrane.calls[0]!), /zz-during/);
      assert.equal(membrane.primary, 1, 'one call for both, which answers');
      assert.equal(fw.getHostModeStatus().gatedRequests, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("holdRequest's merge rule, pinned in a state no public path reaches (a host's hold an auxiliary call armed, with nothing held, beside a turn whose call is in flight): a duplicate of the turn's wake that the hold keeps is marked when the turn fails into the hold, so the turn stays alive", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const membrane = new ScriptedMembrane(new Set(), (request) => rateLimited(undefined, request));
    // The turn's call stays in flight until the test opens it, then fails.
    const stream = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request: NormalizedRequest) => {
      stream(request);
      return new ErrorStream(rateLimited(undefined, request), opened);
    };
    // The host holds every rate-limited failure, the auxiliary call's and the turn's.
    const { fw, internal } = await framework(path, membrane, { providerHold: () => ({ holdMs: 60_000, reason: 'zz-host-hold' }) });
    try {
      fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-message' }]);
      const wake = { agentName: 'resident', reason: 'zz-wake', source: 'test', timestamp: Date.now() };
      internal.pendingRequests.push(wake);
      await waitFor(fw, () => membrane.primary >= 1, "the turn's call");
      assert.equal(internal.holdProviderAcceleration(fw.getAgent('resident'), rateLimited(undefined), undefined, true), true);
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 0, "the auxiliary call's hold stands, with nothing held");
      // A duplicate of the running turn's wake joins that hold.
      internal.pendingRequests.push({ ...wake });
      // (runUntilIdle would wait for the turn, whose call is in flight.)
      await waitFor(fw, () => (internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length ?? 0) === 1, 'the hold to keep the duplicate');
      // The turn fails into the hold that keeps its duplicate.
      open();
      await waitFor(fw, () => !internal.activeTurnTokens.has('resident'), "the failed frame's end");
      assert.equal(internal.providerAccelerationCooldowns.get('resident')!.heldRequests.length, 1, 'one request, the retry and its duplicate merged');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident'], 'the turn is alive: the kept request is marked');
      await assert.rejects(fw.switchBranch('main'), (error: Error & { code?: string }) => error.code === 'agent-busy');
    } finally { open(); await fw.stop(); log.restore(); }
  });
});

/** A turn that fails into a hold at `site`: a resident's or a conversation
 *  agent's stream reporting the error or throwing it, or a conversation
 *  agent's compile during which a wait was recorded. */
type FailureSite = 'event' | 'throw' | 'setup' | 'conversation-event' | 'conversation-throw' | 'conversation-setup' | 'after-compile';

async function failIntoHold(site: FailureSite, fw: AgentFramework, internal: Internal, membrane: ScriptedMembrane) {
  if (site === 'event' || site === 'throw' || site === 'setup') return heldTurn(fw, internal, membrane);
  if (site !== 'after-compile') return heldConversationTurn(fw, internal);
  bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
  const agent = fw.getAgent('resident')!;
  agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
  const compile = agent.startStreamWithInjections.bind(agent);
  agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
    const made = await compile(...args);
    internal.providerWaits.set('resident', 'zz-model', 400, 'zz wait during the compile');
    return made;
  }) as typeof compile;
  await internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
  await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'held');
}

/** The failure sites where a stream fails: a listener of the failure's
 *  report finds nothing held. (At a turn's start that fails, its own check
 *  takes a listener's stop: the test of that site is below.) */
const failureSites: Array<[string, FailureSite]> = [
  ["a resident's stream error event", 'event'],
  ["a resident's thrown stream", 'throw'],
  ["a conversation agent's stream error event", 'conversation-event'],
  ["a conversation agent's thrown stream", 'conversation-throw'],
  ["a conversation agent's compile during which a wait was recorded", 'after-compile'],
];
/** And the starts that fail: every site a stop made after the report reaches. */
const allFailureSites: Array<[string, FailureSite]> = [
  ...failureSites,
  ["a resident's stream setup", 'setup'],
  ["a conversation agent's stream setup", 'conversation-setup'],
];

function siteMembrane(site: FailureSite) {
  const failsAt = site === 'event' || site === 'conversation-event' ? 'event' : site === 'setup' || site === 'conversation-setup' ? 'setup' : 'throw';
  const fails = site === 'after-compile' ? new Set<number>() : site.startsWith('conversation') ? new Set([1]) : new Set([2]);
  return new ScriptedMembrane(fails, (request) => rateLimited(400, request), failsAt);
}

for (const [label, site] of failureSites) test(`a turn that fails into a hold (${label}) reports one inference:failed, before the hold takes its retry: a listener's abortInference() finds nothing held and reports false, and a stop after the frame has let go ends the held turn`, async (t) => {
  await withStoreDir(async (path) => {
    holdClock(t);
    const log = silence();
    const membrane = siteMembrane(site);
    const { fw, internal } = await framework(path, membrane);
    const fromListener: boolean[] = [];
    let failed = 0;
    fw.onTrace((event) => {
      if (event.type !== 'inference:failed' || event.agentName !== 'resident') return;
      failed++;
      fromListener.push(fw.abortInference('resident', 'zz-listener stop'));
    });
    try {
      await failIntoHold(site, fw, internal, membrane);
      await waitFor(fw, () => !internal.activeTurnTokens.has('resident'), "the failed frame's end");
      assert.equal(failed, 1, 'one inference:failed for the failure');
      assert.deepEqual(fromListener, [false], 'the listener sees no turn to stop');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold keeps the retry');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, ['resident'], 'the turn is alive');
      assert.equal(fw.abortInference('resident', 'zz-later stop'), true, 'a later stop ends the held turn');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, []);
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const [label, site] of allFailureSites) test(`a stop made on a microtask after the inference:failed of a turn that fails into a hold (${label}) ends the held turn, as a host's kept interrupt makes it: one inference:aborted, and nothing runs after the hold`, async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const log = silence();
    const membrane = siteMembrane(site);
    const { fw, internal } = await framework(path, membrane);
    const deferred: boolean[] = [];
    const aborted: Array<string | undefined> = [];
    let failed = 0;
    let exhausted = 0;
    fw.onTrace((event) => {
      if (!('agentName' in event) || event.agentName !== 'resident') return;
      if (event.type === 'inference:aborted') aborted.push(event.reason);
      if (event.type === 'inference:exhausted') exhausted++;
      if (event.type !== 'inference:failed') return;
      failed++;
      queueMicrotask(() => { deferred.push(fw.abortInference('resident', 'zz-deferred stop')); });
    });
    try {
      await failIntoHold(site, fw, internal, membrane);
      await waitFor(fw, () => deferred.length > 0 && !internal.activeTurnTokens.has('resident'), "the deferred stop and the frame's end");
      assert.deepEqual(deferred, [true], 'the deferred stop lands');
      assert.deepEqual(aborted, ['zz-deferred stop'], "one inference:aborted, with the stop's reason");
      assert.equal(failed, 1, 'one inference:failed');
      assert.equal(exhausted, 0, 'and no exhaustion');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length ?? 0, 0, 'the retry is gone from the hold');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, []);
      const calls = membrane.primary;
      clock.pass(400);
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('resident'), "the hold's end");
      await fw.runUntilIdle();
      assert.equal(membrane.primary, calls, 'nothing runs after the hold');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("abortInference() from an inference:failed listener as a turn's start fails (its stream's setup) is taken by the start's own check, as on main: the turn ends there, with nothing held", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(400, request), 'setup');
    const { fw, internal } = await framework(path, membrane);
    const fromListener: boolean[] = [];
    const aborted: Array<string | undefined> = [];
    let second = false;
    fw.onTrace((event) => {
      if (!second || (event.type !== 'inference:failed' && event.type !== 'inference:aborted') || event.agentName !== 'resident') return;
      if (event.type === 'inference:aborted') aborted.push(event.reason);
      else fromListener.push(fw.abortInference('resident', 'zz-listener stop'));
    });
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await waitFor(fw, () => membrane.primary >= 1, 'the first turn');
      await fw.runUntilIdle();
      second = true;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-second', metadata: {} });
      await waitFor(fw, () => aborted.length > 0, "the stop's end of the turn");
      assert.deepEqual(fromListener, [true], "the start's window is open at its failure, so the stop is taken");
      assert.deepEqual(aborted, ['zz-listener stop']);
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'nothing held');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, []);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a wait released by a listener of the inference:failed a conversation agent's compile reports holds nothing: the retry starts at once", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set(), () => new Error('unused'));
    const { fw, internal } = await framework(path, membrane);
    fw.onTrace((event) => {
      if (event.type === 'inference:failed' && event.agentName === 'resident') fw.releaseProviderWait('resident');
    });
    try {
      bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
      const agent = fw.getAgent('resident')!;
      agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      let recorded = false;
      const compile = agent.startStreamWithInjections.bind(agent);
      agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
        const made = await compile(...args);
        if (!recorded) { recorded = true; internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz wait during the compile'); }
        return made;
      }) as typeof compile;
      void internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => membrane.primary >= 2, 'the retry, sent at once');
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'nothing held');
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A held turn with a wake beside its retry, released so the two merge into
 *  one start, which parks behind an auxiliary call or is held again at the
 *  last admission boundary by a wait recorded meanwhile. */
async function mergedStartWaiting(fw: AgentFramework, internal: Internal, membrane: ScriptedMembrane, clock: { advance(ms: number): void; pass(ms: number): void }, wait: number, how: 'parked' | 'held again') {
  await heldTurn(fw, internal, membrane);
  clock.advance(1);
  fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the hold', metadata: {} });
  await fw.runUntilIdle();
  assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2, 'the hold keeps the retry and the wake');
  const gate = internal.providerGate('resident');
  gate.auxiliaryInFlight = 1;
  clock.pass(wait);
  internal.releaseProviderAccelerationCooldown('resident');
  await fw.runUntilIdle();
  assert.equal(membrane.primary, 2, 'nothing sent');
  assert.equal(internal.parkedContinuations.size, 1, 'the merged start parks');
  if (how === 'held again') {
    // A wait recorded while it parks holds it at the last admission
    // boundary once the park ends. (One recorded before the release would
    // hold the retry and the wake apart, at admission, unmerged.)
    internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz later wait');
    gate.auxiliaryInFlight = 0;
    for (const resolve of gate.idleWaiters.splice(0)) resolve();
    await waitFor(fw, () => internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length === 1, 'the merged start held again');
    assert.equal(membrane.primary, 2);
  }
  return () => {
    if (how === 'parked') {
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
    } else fw.releaseProviderWait('resident');
  };
}

for (const how of ['parked', 'held again'] as const) test(`a wake merged into a held turn's released retry still runs after abortInference() ends the turn while the merged start is ${how}`, async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      const go = await mergedStartWaiting(fw, internal, membrane, clock, wait, how);
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      assert.deepEqual(aborted, ['zz-operator stop'], 'the turn ends once');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, [], 'the wake put back keeps no turn alive');
      go();
      await waitFor(fw, () => membrane.primary >= 3, 'the wake, as a turn of its own');
      assert.match(texts(membrane.calls[2]), /zz-during the hold/);
      assert.deepEqual(aborted, ['zz-operator stop']);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a merged start its released wait puts back in the queue counts as the wakes merged into it there, until the next pass takes it", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      const go = await mergedStartWaiting(fw, internal, membrane, clock, wait, 'held again');
      go();
      assert.equal(internal.pendingRequests.length, 1, 'the released wait queued the merged start');
      const status = fw.getHostModeStatus();
      assert.equal(status.gatedRequests, 1, 'the wake merged into the queued start waits');
      assert.deepEqual(status.activeTurnAgents, ['resident'], 'the start carries the turn on');
      await fw.runUntilIdle();
      assert.equal(fw.getHostModeStatus().gatedRequests, 0, 'nothing waits once the pass has taken it');
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const how of ['parked', 'held again'] as const) test(`a wake merged into a held turn's released retry counts once while the merged start is ${how}: in ${how === 'parked' ? 'parkedAdmissions' : 'gatedRequests'}, and the turn stays alive`, async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await mergedStartWaiting(fw, internal, membrane, clock, wait, how);
      const status = fw.getHostModeStatus();
      assert.equal(status.gatedRequests, how === 'parked' ? 0 : 1, 'the wake merged into the start');
      assert.equal(status.parkedAdmissions, how === 'parked' ? 1 : 0, 'the start parked on admission');
      assert.deepEqual(status.activeTurnAgents, ['resident'], 'the start carries the turn on');
      assert.equal(status.drained, false);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a quiesce with abandon puts back the wakes merged into a held turn's parked retry: they park under the quiesce and run at resume", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    const aborted: Array<string | undefined> = [];
    fw.onTrace((event) => { if (event.type === 'inference:aborted' && event.agentName === 'resident') aborted.push(event.reason); });
    try {
      const go = await mergedStartWaiting(fw, internal, membrane, clock, wait, 'parked');
      // Under the held clock a drain wait never runs out: the abandon comes
      // from a second quiesce, on a host already quiesced.
      const first = fw.quiesce({ timeoutMs: 50 });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      const second = await fw.quiesce({ abandon: true });
      assert.equal(second.drained, true);
      assert.deepEqual(aborted, ['quiesce_abandoned'], 'the turn ends once');
      assert.equal((await first).drained, true);
      go();
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'the wake parks under the quiesce');
      assert.equal(fw.getHostModeStatus().gatedRequests, 1, 'counted as parked');
      await fw.resume();
      await waitFor(fw, () => membrane.primary >= 3, 'the wake at resume');
      assert.match(texts(membrane.calls[2]), /zz-during the hold/);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a merged start merged again keeps every wake merged into it: abortInference() puts both back", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await mergedStartWaiting(fw, internal, membrane, clock, wait, 'held again');
      // A second wake joins the held merged start; lifting the wait releases
      // both, and the pass merges them again into a start that parks.
      clock.advance(1);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-later', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2);
      const gate = internal.providerGate('resident');
      gate.auxiliaryInFlight = 1;
      fw.releaseProviderWait('resident');
      await waitFor(fw, () => internal.parkedContinuations.size === 1, 'merged again, parked');
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      assert.equal(internal.pendingRequests.filter((r) => r.agentName === 'resident').length, 2, 'both wakes put back');
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor(fw, () => membrane.primary >= 3, 'the wakes, as a turn of their own');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("the inference policy judges the wakes a merged start that came back before its token carries: they are in the batch it decides on", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    let refuse = false;
    const seen: number[] = [];
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane, {
      inferencePolicy: { shouldInfer: (_agent: string, requests: unknown[]) => { if (refuse) seen.push(requests.length); return !refuse; } },
    });
    try {
      const go = await mergedStartWaiting(fw, internal, membrane, clock, wait, 'held again');
      refuse = true;
      go();
      await waitFor(fw, () => seen.length > 0, 'the policy, deciding on the start that came back');
      assert.deepEqual(seen, [2], 'the retry and the wake merged into its start');
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, [], 'the policy dropped them with the turn');
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const how of ['parked', 'held again'] as const) test(`under a quiesce, a held turn's merged start ${how === 'parked' ? 'that parked' : 'held again'} goes on alone: the wakes merged into it park, and run at resume`, async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      const go = await mergedStartWaiting(fw, internal, membrane, clock, wait, how);
      const quiesce = fw.quiesce({ timeoutMs: 1_000 });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      go();
      await waitFor(fw, () => membrane.primary >= 3, 'the retry, through the quiesce');
      assert.equal((await quiesce).drained, true, 'the retry finished its turn');
      await fw.runUntilIdle();
      assert.equal(fw.getHostModeStatus().gatedRequests, 1, 'the wake merged into it parks');
      assert.equal(membrane.primary, 3);
      await fw.resume();
      await waitFor(fw, () => membrane.primary >= 4, 'the wake at resume');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("stop() ends a turn whose merged start is parked, and puts none of the wakes merged into it back", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    let stopped = false;
    try {
      await mergedStartWaiting(fw, internal, membrane, clock, wait, 'parked');
      await fw.stop();
      stopped = true;
      assert.deepEqual(internal.pendingRequests.filter((r) => r.agentName === 'resident'), [], 'nothing queued for a later start()');
    } finally { if (!stopped) await fw.stop(); log.restore(); }
  });
});

for (const how of ['parked', 'held again'] as const) test(`a coalesced wake merged into a held turn's start ${how} is withdrawn from the start's record with its subject: a stop then puts nothing back`, async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      clock.advance(1);
      internal.pendingRequests.push({ agentName: 'resident', reason: 'zz-coalesced', source: 'zz-server', timestamp: Date.now(), coalescingSubject: 'zz-subject' });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2, 'the hold keeps the retry and the coalesced wake');
      const gate = internal.providerGate('resident');
      gate.auxiliaryInFlight = 1;
      clock.pass(wait);
      internal.releaseProviderAccelerationCooldown('resident');
      await fw.runUntilIdle();
      assert.equal(internal.parkedContinuations.size, 1, 'the merged start parks');
      if (how === 'held again') {
        internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz later wait');
        gate.auxiliaryInFlight = 0;
        for (const resolve of gate.idleWaiters.splice(0)) resolve();
        await waitFor(fw, () => internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length === 1, 'the merged start held again');
      }
      internal.cancelCoalescedWakes('zz-subject');
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      assert.deepEqual(internal.pendingRequests.filter((r) => r.agentName === 'resident'), [], 'the withdrawn wake stays withdrawn');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a merged start held where an equal request is already held keeps its wakes recorded on the request kept: a stop puts them back", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await mergedStartWaiting(fw, internal, membrane, clock, wait, 'parked');
      // A wait is recorded, and an unmarked request equal to the parked start
      // (a JSON copy drops its symbols) is held at admission by it.
      internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz later wait');
      const parked = [...internal.parkedContinuations][0];
      internal.pendingRequests.push(JSON.parse(JSON.stringify(parked)));
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the equal request is held');
      // The park ends: the merged start is held where its equal is.
      const gate = internal.providerGate('resident');
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor(fw, () => internal.parkedContinuations.size === 0, "the park's end");
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'one request kept, the two equal');
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      const back = internal.pendingRequests.filter((r) => r.agentName === 'resident');
      assert.equal(back.length, 1, 'the wake merged into the start is put back');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a budget restart batched with a fresh wake parks alone, the wake left queued: abortInference() keeps the wake, and it runs", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set(), () => new Error('unused'));
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-message' }]);
      const gate = internal.providerGate('resident');
      gate.auxiliaryInFlight = 1;
      internal.pendingRequests.push(
        { agentName: 'resident', reason: 'zz-wake', source: 'test', timestamp: Date.now() },
        { agentName: 'resident', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() },
      );
      // A continuation that resumes its logical turn starts alone: the wake
      // goes back to the queue rather than into the start, so it waits for
      // the turn (runUntilIdle would wait with it) while the restart parks.
      await waitFor(fw, () => internal.parkedContinuations.size === 1, 'the restart parks');
      const [parked] = [...internal.parkedContinuations] as Request[];
      assert.equal(parked.reason, 'context_budget_restart');
      assert.equal(Object.getOwnPropertySymbols(parked).some((s) => s.description === 'merged-batch'), false, 'no batch is merged into the restart');
      assert.equal(internal.pendingRequests.filter((r) => r.agentName === 'resident' && r.reason === 'zz-wake').length, 1, 'the wake waits in the queue');
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      assert.equal(internal.pendingRequests.filter((r) => r.agentName === 'resident' && r.reason === 'zz-wake').length, 1, 'the stop keeps the wake, once');
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor(fw, () => membrane.primary >= 1, 'the wake, as a turn of its own');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a stop made as an error policy's retry of a failed start is held at the last admission boundary ends the held turn", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([1]), (request) => new MembraneError({
      type: 'server', retryable: true, httpStatus: 500, message: 'zz internal error', rawError: { status: 500 }, rawRequest: request,
    }), 'setup');
    const { fw, internal } = await framework(path, membrane);
    try {
      bindAsConversationFork(fw, 'resident', { serverId: 'stub', channelId: 'world:zz' });
      const agent = fw.getAgent('resident')!;
      agent.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      // A stop on the microtask after the retry's hold is installed, while
      // the failed start's frame is still on its way out.
      const holds = internal.providerAccelerationCooldowns;
      const set = holds.set.bind(holds);
      let stopped: boolean | undefined;
      holds.set = (key: string, value: { until: number; heldRequests: Request[] }) => {
        const made = set(key, value);
        if (key === 'resident' && stopped === undefined) queueMicrotask(() => { stopped = fw.abortInference('resident', 'zz-stop'); });
        return made;
      };
      void internal.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await waitFor(fw, () => membrane.primary >= 1, 'the failed call');
      internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz wait its compression recorded');
      await waitFor(fw, () => stopped !== undefined, 'the stop');
      await waitFor(fw, () => !internal.activeTurnTokens.has('resident'), "the failed frame's end");
      assert.equal(stopped, true);
      assert.deepEqual(fw.getHostModeStatus().activeTurnAgents, [], 'the held turn ended');
      fw.releaseProviderWait('resident');
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'nothing sent after the stop');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("under a quiesce, a silent turn's retry merged with a speaking wake goes back as its batch from the park: the retry starts alone, still silent", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    const starts: Array<{ suppressProse?: boolean } | undefined> = [];
    const spied = internal as unknown as { startAgentStream: (...args: unknown[]) => Promise<void> };
    const start = spied.startAgentStream.bind(internal);
    spied.startAgentStream = (...args: unknown[]) => {
      starts.push(args[1] as { suppressProse?: boolean } | undefined);
      return start(...args);
    };
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await waitFor(fw, () => membrane.primary >= 1, 'the first turn');
      await fw.runUntilIdle();
      // A silent tick's turn fails into the hold.
      internal.pendingRequests.push({ agentName: 'resident', reason: 'zz-tick', source: 'zz-heartbeat', timestamp: Date.now(), suppressProse: true });
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'the silent turn held');
      clock.advance(1);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the hold', metadata: {} });
      await fw.runUntilIdle();
      const gate = internal.providerGate('resident');
      gate.auxiliaryInFlight = 1;
      clock.pass(wait);
      internal.releaseProviderAccelerationCooldown('resident');
      await fw.runUntilIdle();
      assert.equal(internal.parkedContinuations.size, 1, 'the merged start parks');
      assert.equal(starts.at(-1)?.suppressProse, undefined, 'the merged start speaks, for its speaking wake');
      const quiesce = fw.quiesce({ timeoutMs: 1_000 });
      await waitFor(fw, () => fw.getHostModeStatus().quiesced, 'the quiesce');
      gate.auxiliaryInFlight = 0;
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
      await waitFor(fw, () => membrane.primary >= 3, 'the retry, through the quiesce');
      assert.equal(starts.at(-1)?.suppressProse, true, 'the retry starts alone, silent as its turn was');
      assert.equal((await quiesce).drained, true);
      await fw.runUntilIdle();
      assert.equal(fw.getHostModeStatus().gatedRequests, 1, 'the speaking wake parks');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a merged start that took its token read its wakes: when it fails into a hold again, abortInference() puts none of them back", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new ScriptedMembrane(new Set([2, 3]), (request) => rateLimited(wait, request));
    const { fw, internal } = await framework(path, membrane);
    try {
      await heldTurn(fw, internal, membrane);
      clock.advance(1);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the hold', metadata: {} });
      await fw.runUntilIdle();
      clock.pass(wait);
      internal.releaseProviderAccelerationCooldown('resident');
      await waitFor(fw, () => membrane.primary >= 3 && internal.providerAccelerationCooldowns.has('resident'), 'the merged start sent, and held again');
      assert.match(texts(membrane.calls[2]), /zz-during the hold/, 'the turn read the wake');
      assert.equal(fw.abortInference('resident', 'zz-operator stop'), true);
      clock.pass(wait);
      await waitFor(fw, () => !internal.providerAccelerationCooldowns.has('resident'), "the hold's end");
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 3, 'nothing put back');
    } finally { await fw.stop(); log.restore(); }
  });
});
