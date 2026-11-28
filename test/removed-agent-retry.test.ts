import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { ErrorAction, ErrorPolicy, EventResponse, Module, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const GONE = 'a retry waiting while the agent was replaced or removed is dropped before it sends anything';
const STOPPING = 'a retry waiting while the framework was stopping is dropped before it sends anything';
const REMOVED = "the agent was removed in its wait to retry; the retry wasn't sent";
/** The removal's [turn] lines on stderr from here on, for one name. */
function removalLines(t: TestContext): (name: string) => string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return (name) => lines.filter((line) => line.startsWith(`[turn] ${name}: ${REMOVED}`));
}

type Internals = {
  agents: Map<string, unknown>;
  retryWaitWakers: Set<() => void>;
  createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<unknown>;
  disposeConversationAgent(name: string): void;
  activeTurnTokens: Map<string, number>;
  consecutiveInferenceFailures: Map<string, number>;
  lastInferenceAt: Map<string, { lastError?: string }>;
  registry: { inspect(name: string): { incarnation: number } | undefined };
};

class Gate {
  open!: () => void;
  readonly promise = new Promise<void>((resolve) => { this.open = resolve; });
}

const held = { gate: null as Gate | null, entered: false };

class InputModule implements Module {
  readonly name = 'input';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    if ((event as { metadata?: { hold?: boolean } }).metadata?.hold) {
      held.entered = true;
      await held.gate?.promise;
      return {};
    }
    const to = (event as { metadata?: { to?: string } }).metadata?.to;
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: to ? [to] : true };
  }
}

class FailingStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  cancel(): void {}
  provideToolResults(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'zz internal error', rawError: undefined } as ConstructorParameters<typeof MembraneError>[0]) } as StreamEvent;
  }
}

class CountingMembrane extends MockMembrane {
  readonly sent: string[] = [];
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const name = request.assistantParticipant ?? '';
    this.sent.push(name);
    return this.sent.filter((n) => n === name).length === 1 ? new FailingStream() : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]);
  }
}

class RecordingPolicy implements ErrorPolicy {
  readonly maxRetries = 3;
  readonly seen: Array<{ agentName: string; message: string }> = [];
  constructor(private readonly delayMs: number) {}
  onInferenceError(error: Error, agentName: string): ErrorAction {
    this.seen.push({ agentName, message: error.message });
    return { retry: true, delayMs: this.delayMs };
  }
}

async function boot(t: TestContext, delayMs: number, agents = ['resident', 'helper'], conversations = false) {
  const dir = mkdtempSync(join(tmpdir(), 'af-removed-retry-'));
  let made: AgentFramework | undefined;
  t.after(async () => {
    try {
      await made?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const membrane = new ResumeMembrane();
  const policy = new RecordingPolicy(delayMs);
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: agents.map((name) => ({ name, model: 'zz-model', systemPrompt: 'system' })),
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0, errorPolicy: policy,
    ...(conversations ? { conversations: { templateAgent: 'resident', bind: { channel: 'mention' as const } } } : {}),
  });
  made = fw;
  const traces: TraceEvent[] = [];
  fw.onTrace((event) => { traces.push(event); });
  fw.start();
  const i = fw as unknown as Internals;
  return { fw, i, membrane, policy, traces };
}

async function until(what: string, ready: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function laterIncarnation(h: Awaited<ReturnType<typeof boot>>, name: string): void {
  h.i.registry.inspect(name)!.incarnation += 1;
}

async function oldWaitEnded(h: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await until("the old turn's wait to end", () => h.i.retryWaitWakers.size === 0);
  await new Promise((resolve) => setImmediate(resolve));
}
const of = (traces: TraceEvent[], name: string, from = 0) => traces.slice(from).filter((e) => (e as { agentName?: string }).agentName === name);
const types = (events: TraceEvent[]) => events.map((e) => e.type);
const reasons = (events: TraceEvent[]) => events.filter((e) => e.type === 'inference:aborted').map((e) => (e as { reason?: string }).reason);
const wake = (fw: AgentFramework, to: string) => fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: { to } } as unknown as ProcessEvent);

function nothingRanFor(h: Awaited<ReturnType<typeof boot>>, name: string, from: number): void {
  const after = of(h.traces, name, from);
  assert.deepEqual(types(after).filter((type) => ['inference:started', 'inference:failed', 'inference:exhausted'].includes(type)), [], `no start, failure or exhaustion under the name after it went: ${types(after).join(', ')}`);
  assert.deepEqual(h.policy.seen.filter((call) => call.agentName === name).map((call) => call.message), ['zz internal error'], 'the policy was asked once, about the first failure');
  assert.equal(h.membrane.sent.filter((sent) => sent === name).length, 1, 'one request');
  assert.equal(h.i.consecutiveInferenceFailures.get(name), undefined, 'no failure count stands under the name');
  assert.ok(!(h.i.lastInferenceAt.get(name)?.lastError ?? '').includes('Unknown agent'), 'no Unknown agent recorded');
}

class HeldAnswer implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => { this.release = resolve; });
  cancel(): void { this.release(); }
  provideToolResults(): void {}
  open(): void { this.release(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await this.released;
    yield* new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]);
  }
}

class ResumeMembrane extends CountingMembrane {
  readonly held: HeldAnswer[] = [];
  override streamYielding(request: NormalizedRequest): YieldingStream {
    const name = request.assistantParticipant ?? '';
    const n = this.sent.filter((x) => x === name).length + 1;
    if (n === 2 && name === 'worker') {
      this.calls.push(request);
      this.sent.push(name);
      const held = new HeldAnswer();
      this.held.push(held);
      return held;
    }
    return super.streamYielding(request);
  }
}

describe("driveStream's wait to retry, when the agent goes before it ends", () => {
  it('an ephemeral run that ends during the wait retries nothing, and the turn ends with one inference:aborted that says why, and one line on stderr', async (t) => {
    const removed = removalLines(t);
    const h = await boot(t, 800, ['resident']);
    const worker = await h.fw.createEphemeralAgent({ name: 'worker', model: 'zz-model', systemPrompt: 'Do it.' });
    worker.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    const run = h.fw.runEphemeralToCompletion(worker.agent, worker.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).catch((error: unknown) => error);
    await until('the wait to retry', () => of(h.traces, 'worker').some((e) => e.type === 'inference:waiting'));
    assert.match(String(await run), /stalled/, 'control: the idle watchdog ended the run');
    assert.ok(!h.fw.getAgent('worker'), 'control: during the wait');
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
    const from = h.traces.length;
    await until("the turn's end", () => reasons(of(h.traces, 'worker', from)).length > 0);
    nothingRanFor(h, 'worker', from);
    assert.deepEqual(reasons(of(h.traces, 'worker', from)), [GONE]);
    assert.equal(removed('worker').length, 1, 'one [turn] line says that the retry was not sent');
  });

  it('stopAgent during the wait: no retry, one inference:aborted that says why, and one line on stderr', async (t) => {
    const removed = removalLines(t);
    const h = await boot(t, 500);
    wake(h.fw, 'helper');
    await until('the wait to retry', () => of(h.traces, 'helper').some((e) => e.type === 'inference:waiting'));
    const from = h.traces.length;
    h.fw.stopAgent('helper', { reason: 'zz-released' });
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
    await until("the turn's end", () => reasons(of(h.traces, 'helper', from)).length > 0);
    nothingRanFor(h, 'helper', from);
    assert.deepEqual(reasons(of(h.traces, 'helper', from)), [GONE]);
    assert.deepEqual(removed('helper'), [`[turn] helper: ${REMOVED}`]);
  });

  it('a job resumed under its name during the wait, in its turn: no retry, and no inference:aborted or removal line under the name', async (t) => {
    const removed = removalLines(t);
    const h = await boot(t, 1500, ['resident']);
    const config = { model: 'zz-model', systemPrompt: 'Do it.' };
    const worker = await h.fw.createEphemeralAgent({ name: 'worker', ...config });
    worker.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    const run = h.fw.runEphemeralToCompletion(worker.agent, worker.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).catch((error: unknown) => error);
    await until('the wait to retry', () => of(h.traces, 'worker').some((e) => e.type === 'inference:waiting'));
    assert.match(String(await run), /stalled/, 'control: the idle watchdog ended the run');
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
    const resumed = await h.fw.resumeAgent('worker', config);
    resumed.contextManager.addMessage('user', [{ type: 'text', text: 'Go on.' }]);
    const again = h.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager, { idleTimeoutMs: 10_000 }).catch((error: unknown) => error);
    await until("the resumed job's request", () => h.membrane.held.length === 1);
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits while the resumed job is in its turn');
    assert.equal(h.fw.getAgent('worker'), resumed.agent, 'control: the resumed job holds the name');
    const token = h.i.activeTurnTokens.get('worker');
    const failures = h.i.consecutiveInferenceFailures.get('worker');
    const from = h.traces.length;
    await oldWaitEnded(h);
    assert.deepEqual(reasons(of(h.traces, 'worker', from)), [], 'no inference:aborted under the name the resumed job holds');
    assert.deepEqual(removed('worker'), [], 'no removal line under the name the resumed job holds');
    assert.equal(h.membrane.sent.filter((n) => n === 'worker').length, 2, "no request from the old turn's retry");
    assert.equal(h.i.activeTurnTokens.get('worker'), token, "the resumed turn's token is untouched");
    assert.equal(h.i.consecutiveInferenceFailures.get('worker'), failures, "the resumed job's failure count is untouched");
    assert.deepEqual(h.policy.seen.filter((call) => call.agentName === 'worker').map((call) => call.message), ['zz internal error'], 'the policy was asked once, about the first failure');
    h.membrane.held[0]!.open();
    const ended = await again;
    assert.ok(!(ended instanceof Error), `the resumed job's run ends without an error: ${String(ended)}`);
  });

  it('a job resumed under its name during the wait, not yet in its turn: no retry, and no inference:aborted under the name', async (t) => {
    const h = await boot(t, 1500, ['resident']);
    const config = { model: 'zz-model', systemPrompt: 'Do it.' };
    const worker = await h.fw.createEphemeralAgent({ name: 'worker', ...config });
    worker.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    const run = h.fw.runEphemeralToCompletion(worker.agent, worker.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).catch((error: unknown) => error);
    await until('the wait to retry', () => of(h.traces, 'worker').some((e) => e.type === 'inference:waiting'));
    assert.match(String(await run), /stalled/, 'control: the idle watchdog ended the run');
    const resumed = await h.fw.resumeAgent('worker', config);
    resumed.contextManager.addMessage('user', [{ type: 'text', text: 'Go on.' }]);
    const gate = new Gate();
    held.gate = gate;
    held.entered = false;
    let again: Promise<unknown> = Promise.resolve();
    let from = 0;
    let token: number | undefined;
    try {
      h.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hold', metadata: { hold: true } } as unknown as ProcessEvent);
      await until('the scheduler to hold in an event', () => held.entered);
      again = h.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager, { idleTimeoutMs: 10_000 }).catch((error: unknown) => error);
      await until('the resumed job to hold the name', () => h.fw.getAgent('worker') === resumed.agent);
      assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
      assert.equal(h.i.activeTurnTokens.get('worker'), undefined, 'control: the resumed job has no turn yet');
      from = h.traces.length;
      await oldWaitEnded(h);
      token = h.i.activeTurnTokens.get('worker');
    } finally {
      gate.open();
      held.gate = null;
    }
    assert.deepEqual(reasons(of(h.traces, 'worker', from)), [], 'no inference:aborted under the name the resumed job holds');
    assert.equal(h.membrane.sent.filter((n) => n === 'worker').length, 1, "no request from the old turn's retry");
    assert.equal(token, undefined, 'the old frame set no token under the name');
    assert.deepEqual(h.policy.seen.filter((call) => call.agentName === 'worker').map((call) => call.message), ['zz internal error'], 'the policy was asked once, about the first failure');
    await until("the resumed job's request", () => h.membrane.held.length === 1);
    h.membrane.held[0]!.open();
    const ended = await again;
    assert.ok(!(ended instanceof Error), `the resumed job's run ends without an error: ${String(ended)}`);
  });

  it('a job resumed under its name during the wait, which ends before the wait does: no inference:aborted under the name', async (t) => {
    const h = await boot(t, 1500, ['resident']);
    const config = { model: 'zz-model', systemPrompt: 'Do it.' };
    const worker = await h.fw.createEphemeralAgent({ name: 'worker', ...config });
    worker.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    const run = h.fw.runEphemeralToCompletion(worker.agent, worker.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).catch((error: unknown) => error);
    await until('the wait to retry', () => of(h.traces, 'worker').some((e) => e.type === 'inference:waiting'));
    assert.match(String(await run), /stalled/, 'control: the idle watchdog ended the run');
    const resumed = await h.fw.resumeAgent('worker', config);
    resumed.contextManager.addMessage('user', [{ type: 'text', text: 'Go on.' }]);
    const again = h.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager, { idleTimeoutMs: 10_000 }).catch((error: unknown) => error);
    await until("the resumed job's request", () => h.membrane.held.length === 1);
    h.membrane.held[0]!.open();
    const ended = await again;
    assert.ok(!(ended instanceof Error), `the resumed job's run ends without an error: ${String(ended)}`);
    assert.ok(!h.fw.getAgent('worker'), 'control: the name is vacant again');
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
    const from = h.traces.length;
    await oldWaitEnded(h);
    assert.deepEqual(reasons(of(h.traces, 'worker', from)), [], 'no inference:aborted under the name that the resumed job took');
    assert.equal(h.membrane.sent.filter((n) => n === 'worker').length, 2, "no request from the old turn's retry");
  });

  it('stop() during the wait, after the agent went, ends the turn as a stop: the reason is the stopping one, and no removal line', async (t) => {
    const removed = removalLines(t);
    const h = await boot(t, 60_000);
    wake(h.fw, 'helper');
    await until('the wait to retry', () => of(h.traces, 'helper').some((e) => e.type === 'inference:waiting'));
    const from = h.traces.length;
    h.fw.stopAgent('helper', { reason: 'zz-released' });
    await h.fw.stop();
    assert.deepEqual(reasons(of(h.traces, 'helper', from)), [STOPPING]);
    assert.deepEqual(removed('helper'), []);
    assert.equal(h.membrane.sent.filter((sent) => sent === 'helper').length, 1, 'no retry');
  });

  it('an agent replaced under its name during the wait, then stop(): no inference:aborted under the name', async (t) => {
    const h = await boot(t, 60_000);
    wake(h.fw, 'helper');
    await until('the wait to retry', () => of(h.traces, 'helper').some((e) => e.type === 'inference:waiting'));
    h.i.agents.set('helper', Object.create(h.fw.getAgent('helper')!));
    laterIncarnation(h, 'helper');
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
    const from = h.traces.length;
    await h.fw.stop();
    assert.deepEqual(reasons(of(h.traces, 'helper', from)), [], 'the name another agent holds gets no event, under stop() too');
    assert.deepEqual(types(of(h.traces, 'helper', from)).filter((type) => type === 'inference:started'), [], 'no start under the name');
    assert.equal(h.membrane.sent.filter((sent) => sent === 'helper').length, 1, 'no retry');
  });

  it("a conversation fork disposed during the wait: no retry, one inference:aborted that says why, and one line on stderr", async (t) => {
    const removed = removalLines(t);
    const h = await boot(t, 500, ['resident'], true);
    await h.i.createConversationAgent('fork-1', { serverId: 'zz', channelId: 'room' });
    wake(h.fw, 'fork-1');
    await until('the wait to retry', () => of(h.traces, 'fork-1').some((e) => e.type === 'inference:waiting'));
    const from = h.traces.length;
    h.i.disposeConversationAgent('fork-1');
    assert.ok(!h.fw.getAgent('fork-1'), 'control: disposed during the wait');
    assert.ok(h.i.retryWaitWakers.size > 0, 'control: the old turn still waits');
    await until("the turn's end", () => reasons(of(h.traces, 'fork-1', from)).length > 0);
    nothingRanFor(h, 'fork-1', from);
    assert.deepEqual(reasons(of(h.traces, 'fork-1', from)), [GONE]);
    assert.equal(removed('fork-1').length, 1);
  });

  it('control: an agent that stays retries as before', async (t) => {
    const h = await boot(t, 100);
    wake(h.fw, 'helper');
    await until('the retry to answer', () => of(h.traces, 'helper').some((e) => e.type === 'inference:completed'));
    assert.equal(h.membrane.sent.filter((sent) => sent === 'helper').length, 2);
    assert.deepEqual(reasons(of(h.traces, 'helper')), []);
  });
});
