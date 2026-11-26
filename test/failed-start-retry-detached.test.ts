import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { ErrorAction, ErrorPolicy, EventResponse, Module, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const GONE = 'a retry waiting while the agent was replaced or removed is dropped before it sends anything';
const STOPPING = 'a retry waiting while the framework was stopping is dropped before it sends anything';

type Internals = {
  agents: Map<string, unknown>;
  retryWaitWakers: Set<() => void>;
  activeStartRetries: Map<Promise<void>, string>;
  openLogical: Map<string, object>;
  turnRouting: Map<string, object>;
  activeTurnTokens: Map<string, number>;
  providerGates: Map<string, { primaryDepth: number }>;
  pendingRequests: Array<{ agentName: string }>;
  providerWaits: { set(agentName: string, model: string, ms: number, why: string): void };
  eventGate: { onInferenceStarted(agentName: string): void; getStatus?(): unknown } | null;
  registry: { inspect(name: string): { incarnation: number } | undefined };
};

class Gate {
  open!: () => void;
  readonly promise = new Promise<void>((resolve) => { this.open = resolve; });
}

/** An event with `hold` keeps the scheduler in its onProcess until `held.gate` opens. */
const held = { gate: null as Gate | null, entered: false };

class InputModule implements Module {
  readonly name = 'input';
  constructor(private readonly log: string[]) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const metadata = (event as { metadata?: { to?: string; ping?: boolean; hold?: boolean } }).metadata;
    if (metadata?.hold) {
      held.entered = true;
      await held.gate?.promise;
      return {};
    }
    if (metadata?.ping) {
      this.log.push('ping handled');
      return {};
    }
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: metadata?.to ? [metadata.to] : true };
  }
}

class AnsweringMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'answered' }])]);
  }
}

class RetryPolicy implements ErrorPolicy {
  readonly maxRetries = 2;
  constructor(private readonly delayMs: number, private readonly retries = 1, private readonly throwOnRetryFailure = false) {}
  onInferenceError(_error: Error, agentName: string, attempt: number): ErrorAction {
    if ((agentName === 'a' || agentName === 'kid') && attempt < this.retries) return { retry: true, delayMs: this.delayMs };
    if (this.throwOnRetryFailure) throw new Error('zz the policy threw');
    return { retry: false };
  }
}

async function boot(t: TestContext, opts: { delayMs: number; start: boolean; failedCompiles?: number; retries?: number; throwOnRetryFailure?: boolean; gate?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'af-failed-start-retry-'));
  let made: AgentFramework | undefined;
  t.after(async () => {
    try {
      await made?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const log: string[] = [];
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new AnsweringMembrane().asMembrane(),
    agents: ['b', 'a'].map((name) => ({ name, model: 'zz-model', systemPrompt: 'system' })),
    modules: [new InputModule(log)], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy: new RetryPolicy(opts.delayMs, opts.retries, opts.throwOnRetryFailure),
    ...(opts.gate ? { gate: { config: { policies: [], default: 'always' as const } } } : {}),
  });
  made = fw;
  const traces: TraceEvent[] = [];
  fw.onTrace((event) => {
    traces.push(event);
    const name = (event as { agentName?: string }).agentName;
    if (event.type === 'inference:started' || event.type === 'inference:completed' || event.type === 'inference:waiting') log.push(`${event.type.slice('inference:'.length)}:${name}`);
  });
  const a = fw.getAgent('a')!;
  const compile = a.startStreamWithInjections.bind(a);
  const state = { compiles: 0, secondCompile: null as Gate | null, secondEntered: new Gate() };
  a.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
    state.compiles++;
    log.push(`a compile ${state.compiles}`);
    if (state.compiles === 2) {
      state.secondEntered.open();
      if (state.secondCompile) await state.secondCompile.promise;
    }
    if (state.compiles <= (opts.failedCompiles ?? 1)) throw new Error('zz compile failed');
    return compile(...args);
  }) as typeof a.startStreamWithInjections;
  if (opts.start) fw.start();
  const i = fw as unknown as Internals;
  return { fw, i, log, traces, state, agent: a };
}

const wake = (fw: AgentFramework, to: string) => fw.pushEvent({ type: 'external-message', source: 'test', content: `zz-hello ${to}`, metadata: { to } } as unknown as ProcessEvent);
const ping = (fw: AgentFramework) => fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-ping', metadata: { ping: true } } as unknown as ProcessEvent);
const aborts = (traces: TraceEvent[], name: string) => traces.filter((e) => e.type === 'inference:aborted' && (e as { agentName?: string }).agentName === name).map((e) => (e as { reason?: string }).reason);
const before = (log: string[], first: string, second: string) => log.indexOf(first) !== -1 && log.indexOf(second) !== -1 && log.indexOf(first) < log.indexOf(second);

async function until(what: string, ready: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within<T>(what: string, work: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })])
    .finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Staged at the condition: another agent under the name is a later incarnation of it. */
function laterIncarnation(h: Awaited<ReturnType<typeof boot>>, name: string): void {
  h.i.registry.inspect(name)!.incarnation += 1;
}

const inferring = (h: Awaited<ReturnType<typeof boot>>, name: string) =>
  ((h.i.eventGate as unknown as { inferring: Set<string> }).inferring).has(name);

async function retriesEnded(h: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await until('the retry tasks to end', () => h.i.activeStartRetries.size === 0);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("a failed start's wait to retry", () => {
  it("lets another agent's turn start, and an event be handled, before the retry, under the framework's loop", async (t) => {
    const h = await boot(t, { delayMs: 3_000, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    wake(h.fw, 'b');
    ping(h.fw);
    await until("a's retry to answer", () => h.log.includes('completed:a'));
    assert.ok(before(h.log, 'started:b', 'a compile 2'), `b started before a's retry: ${h.log.join(', ')}`);
    assert.ok(before(h.log, 'ping handled', 'a compile 2'), `the event was handled before a's retry: ${h.log.join(', ')}`);
  });

  it('lets another agent and an event go first under runUntilIdle(), which returns once the retry has ended', async (t) => {
    const h = await boot(t, { delayMs: 2_000, start: false });
    wake(h.fw, 'a');
    wake(h.fw, 'b');
    ping(h.fw);
    await h.fw.runUntilIdle();
    assert.ok(h.log.includes('completed:a'), `runUntilIdle() returned after a's retry answered: ${h.log.join(', ')}`);
    assert.ok(before(h.log, 'started:b', 'a compile 2'), `b started before a's retry: ${h.log.join(', ')}`);
    assert.ok(before(h.log, 'ping handled', 'a compile 2'), `the event was handled before a's retry: ${h.log.join(', ')}`);
  });

  it("abortInference during the wait, after another agent has started, ends a's turn with the caller's reason and frees its admission", async (t) => {
    const h = await boot(t, { delayMs: 3_000, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    assert.ok((h.i.providerGates.get('a')?.primaryDepth ?? 0) > 0, "control: a's turn holds its admission while it waits");
    wake(h.fw, 'b');
    await until('b to start', () => h.log.includes('started:b'));
    assert.equal(h.fw.abortInference('a', 'zz-stop'), true);
    await until("a's turn to end", () => aborts(h.traces, 'a').length > 0);
    await retriesEnded(h);
    assert.deepEqual(aborts(h.traces, 'a'), ['zz-stop']);
    assert.equal(h.state.compiles, 1, 'no second compile');
    assert.equal(h.i.activeTurnTokens.has('a'), false, "a's turn token is cleared");
    assert.equal(h.i.providerGates.get('a')?.primaryDepth ?? 0, 0, "a's admission is given back");
    wake(h.fw, 'a');
    await until("a's next turn to answer", () => h.log.includes('completed:a'));
  });

  it("an operator's quiesce with abandon during the wait abandons a's turn, and a wake after resume() runs", async (t) => {
    const h = await boot(t, { delayMs: 2_000, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    // The drain runs out first, so the abandon reaches the turn in its wait.
    const status = await h.fw.quiesce({ abandon: true, timeoutMs: 50 });
    assert.equal((status.unabandonable ?? []).includes('a'), false, `a's turn was abandonable: ${JSON.stringify(status.unabandonable)}`);
    await until("a's turn to end", () => aborts(h.traces, 'a').length > 0);
    await retriesEnded(h);
    assert.equal(h.state.compiles, 1, 'no second compile');
    await h.fw.resume();
    wake(h.fw, 'a');
    await until("a's next turn to answer", () => h.log.includes('completed:a'));
  });

  it('stopAgent during the wait: no retry, one inference:aborted that says why, and its admission is given back', async (t) => {
    const h = await boot(t, { delayMs: 300, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    assert.ok((h.i.providerGates.get('a')?.primaryDepth ?? 0) > 0, "control: a's turn holds its admission while it waits");
    h.fw.stopAgent('a', { reason: 'zz-released' });
    await until("a's turn to end", () => aborts(h.traces, 'a').length > 0);
    await retriesEnded(h);
    assert.equal(h.state.compiles, 1, 'no second compile');
    assert.deepEqual(aborts(h.traces, 'a'), [GONE]);
    assert.equal(h.i.providerGates.get('a')?.primaryDepth ?? 0, 0, "a's admission is given back");
  });

  for (const successor of ['idle', 'in a turn'] as const) {
    it(`an agent that replaced a under its name during the wait, ${successor}: no retry, no inference:aborted, and its token untouched`, async (t) => {
      const h = await boot(t, { delayMs: 300, start: true });
      wake(h.fw, 'a');
      await until("a's wait to retry", () => h.log.includes('waiting:a'));
      h.i.agents.set('a', Object.create(h.agent));
      laterIncarnation(h, 'a');
      if (successor === 'in a turn') h.i.activeTurnTokens.set('a', 987_654);
      await retriesEnded(h);
      assert.equal(h.state.compiles, 1, 'no second compile');
      assert.deepEqual(aborts(h.traces, 'a'), [], 'no inference:aborted under the name');
      if (successor === 'in a turn') assert.equal(h.i.activeTurnTokens.get('a'), 987_654, "the successor's token is untouched");
      h.i.agents.set('a', h.agent);
      h.i.activeTurnTokens.delete('a');
    });
  }

  it("a caller's stop during the wait, then an agent that takes the name: no inference:aborted under the name", async (t) => {
    const h = await boot(t, { delayMs: 300, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    h.fw.abortInference('a', 'zz-stop');
    h.i.agents.set('a', Object.create(h.agent));
    laterIncarnation(h, 'a');
    await until("a's wait to end", () => h.i.retryWaitWakers.size === 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.compiles, 1, 'no second compile');
    assert.deepEqual(aborts(h.traces, 'a'), [], 'the name another agent holds gets no event');
    h.i.agents.set('a', h.agent);
  });

  it("an agent that replaced a under its name during the wait, then stop(): no inference:aborted under the name", async (t) => {
    const h = await boot(t, { delayMs: 60_000, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    h.i.agents.set('a', Object.create(h.agent));
    laterIncarnation(h, 'a');
    await h.fw.stop();
    assert.deepEqual(aborts(h.traces, 'a'), [], 'the name another agent holds gets no event, under stop() too');
    assert.equal(h.state.compiles, 1, 'no second compile');
  });

  it('a retry that waits twice lets another agent start during its second wait, and its turn answers on the third compile', async (t) => {
    const h = await boot(t, { delayMs: 1_000, start: true, failedCompiles: 2, retries: 2 });
    wake(h.fw, 'a');
    await until("a's second wait", () => h.log.filter((line) => line === 'waiting:a').length >= 2 && h.log.includes('a compile 2'));
    wake(h.fw, 'b');
    await until("a's turn to answer", () => h.log.includes('completed:a'));
    assert.ok(before(h.log, 'started:b', 'a compile 3'), `b started during a's second wait: ${h.log.join(', ')}`);
    assert.equal(h.state.compiles, 3);
    await retriesEnded(h);
    assert.equal(h.i.activeTurnTokens.has('a'), false, "a's turn token is cleared");
    assert.equal(h.i.providerGates.get('a')?.primaryDepth ?? 0, 0, "a's admission is given back");
  });

  it("a throw in the retry before its start ends the turn as a thrown start does: an ephemeral run's caller gets it at once", async (t) => {
    const h = await boot(t, { delayMs: 100, start: true });
    const kid = await h.fw.createEphemeralAgent({ name: 'kid', model: 'zz-model', systemPrompt: 'system' });
    kid.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    kid.agent.startStreamWithInjections = (async () => { throw new Error('zz compile failed'); }) as typeof kid.agent.startStreamWithInjections;
    let waited = false;
    h.fw.onTrace((event) => { if (event.type === 'inference:waiting' && (event as { agentName?: string }).agentName === 'kid') waited = true; });
    const take = kid.agent.takeStopWithoutStream.bind(kid.agent);
    kid.agent.takeStopWithoutStream = (() => {
      if (waited) throw new Error('zz the check after the wait threw');
      return take();
    }) as typeof kid.agent.takeStopWithoutStream;
    const run = h.fw.runEphemeralToCompletion(kid.agent, kid.contextManager).then(() => null, (error: unknown) => error);
    const ended = await within("the run's end", run, 8_000);
    assert.match(String(ended), /the turn failed/, 'the run fails at once, as at a thrown start, and not at its watchdog');
  });

  it('a job resumed under its name during the wait, in its turn: no retry, and no inference:aborted under the name', async (t) => {
    const h = await boot(t, { delayMs: 1_500, start: true });
    const config = { model: 'zz-model', systemPrompt: 'system' };
    const kid = await h.fw.createEphemeralAgent({ name: 'kid', ...config });
    kid.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    let compiles = 0;
    const compile = kid.agent.startStreamWithInjections.bind(kid.agent);
    kid.agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
      compiles++;
      if (compiles === 1) throw new Error('zz compile failed');
      return compile(...args);
    }) as typeof kid.agent.startStreamWithInjections;
    const run = h.fw.runEphemeralToCompletion(kid.agent, kid.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).then(() => null, (error: unknown) => error);
    await until('the wait to retry', () => h.log.includes('waiting:kid'));
    assert.match(String(await within("the first run's end", run, 8_000)), /stalled/, 'control: the idle watchdog ended the run');
    assert.ok([...h.i.activeStartRetries.values()].includes('kid'), "control: the old turn's retry still waits");
    const resumed = await h.fw.resumeAgent('kid', config);
    resumed.contextManager.addMessage('user', [{ type: 'text', text: 'Go on.' }]);
    const held = new Gate();
    let resumedCompiled = false;
    const go = resumed.agent.startStreamWithInjections.bind(resumed.agent);
    resumed.agent.startStreamWithInjections = (async (...args: Parameters<typeof go>) => {
      resumedCompiled = true;
      await held.promise;
      return go(...args);
    }) as typeof resumed.agent.startStreamWithInjections;
    const again = h.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager, { idleTimeoutMs: 10_000 }).then(() => null, (error: unknown) => error);
    await until("the resumed job's compile", () => resumedCompiled);
    assert.ok([...h.i.activeStartRetries.values()].includes('kid'), "control: the old turn's retry still waits while the resumed job is in its turn");
    assert.equal(h.fw.getAgent('kid'), resumed.agent, 'control: the resumed job holds the name');
    const token = h.i.activeTurnTokens.get('kid');
    const from = h.traces.length;
    await retriesEnded(h);
    assert.deepEqual(aborts(h.traces.slice(from), 'kid'), [], 'no inference:aborted under the name the resumed job holds');
    assert.equal(compiles, 1, "no compile from the old turn's retry");
    assert.equal(h.i.activeTurnTokens.get('kid'), token, "the resumed turn's token is untouched");
    held.open();
    assert.equal(await within("the resumed run's end", again), null, "the resumed job's run ends without an error");
  });

  it('a job resumed under its name during the wait, not yet in its turn: no retry, and no inference:aborted under the name', async (t) => {
    const h = await boot(t, { delayMs: 1_500, start: true });
    const config = { model: 'zz-model', systemPrompt: 'system' };
    const kid = await h.fw.createEphemeralAgent({ name: 'kid', ...config });
    kid.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    let compiles = 0;
    const compile = kid.agent.startStreamWithInjections.bind(kid.agent);
    kid.agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
      compiles++;
      if (compiles === 1) throw new Error('zz compile failed');
      return compile(...args);
    }) as typeof kid.agent.startStreamWithInjections;
    const run = h.fw.runEphemeralToCompletion(kid.agent, kid.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).then(() => null, (error: unknown) => error);
    await until('the wait to retry', () => h.log.includes('waiting:kid'));
    assert.match(String(await within("the first run's end", run, 8_000)), /stalled/, 'control: the idle watchdog ended the run');
    const resumed = await h.fw.resumeAgent('kid', config);
    resumed.contextManager.addMessage('user', [{ type: 'text', text: 'Go on.' }]);
    const gate = new Gate();
    held.gate = gate;
    held.entered = false;
    let again: Promise<unknown> = Promise.resolve(null);
    let from = 0;
    // The scheduler stays in the held event until the gate opens, and stop() waits for it, so the gate opens on every way out.
    try {
      h.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hold', metadata: { hold: true } } as unknown as ProcessEvent);
      await until('the scheduler to hold in an event', () => held.entered);
      again = h.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager, { idleTimeoutMs: 10_000 }).then(() => null, (error: unknown) => error);
      await until('the resumed job to hold the name', () => h.fw.getAgent('kid') === resumed.agent);
      assert.ok([...h.i.activeStartRetries.values()].includes('kid'), "control: the old turn's retry still waits");
      from = h.traces.length;
      await retriesEnded(h);
    } finally {
      gate.open();
      held.gate = null;
    }
    assert.deepEqual(aborts(h.traces.slice(from), 'kid'), [], 'no inference:aborted under the name the resumed job holds');
    assert.equal(compiles, 1, "no compile from the old turn's retry");
    assert.equal(await within("the resumed run's end", again), null, "the resumed job's run ends without an error");
  });

  it('a job resumed under its name during the wait, which ends before the wait does: no inference:aborted under the name', async (t) => {
    const h = await boot(t, { delayMs: 1_500, start: true });
    const config = { model: 'zz-model', systemPrompt: 'system' };
    const kid = await h.fw.createEphemeralAgent({ name: 'kid', ...config });
    kid.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
    let compiles = 0;
    const compile = kid.agent.startStreamWithInjections.bind(kid.agent);
    kid.agent.startStreamWithInjections = (async (...args: Parameters<typeof compile>) => {
      compiles++;
      if (compiles === 1) throw new Error('zz compile failed');
      return compile(...args);
    }) as typeof kid.agent.startStreamWithInjections;
    const run = h.fw.runEphemeralToCompletion(kid.agent, kid.contextManager, { idleTimeoutMs: 150, idlePollMs: 20 }).then(() => null, (error: unknown) => error);
    await until('the wait to retry', () => h.log.includes('waiting:kid'));
    assert.match(String(await within("the first run's end", run, 8_000)), /stalled/, 'control: the idle watchdog ended the run');
    const resumed = await h.fw.resumeAgent('kid', config);
    resumed.contextManager.addMessage('user', [{ type: 'text', text: 'Go on.' }]);
    assert.equal(await within("the resumed run's end", h.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager, { idleTimeoutMs: 10_000 }).then(() => null, (error: unknown) => error)), null, "the resumed job's run ends without an error");
    assert.ok(!h.fw.getAgent('kid'), 'control: the name is vacant again');
    assert.ok([...h.i.activeStartRetries.values()].includes('kid'), "control: the old turn's retry still waits");
    const from = h.traces.length;
    await retriesEnded(h);
    assert.deepEqual(aborts(h.traces.slice(from), 'kid'), [], 'no inference:aborted under the name that the resumed job took');
    assert.equal(compiles, 1, "no compile from the old turn's retry");
  });

  it("the retry's own compile, dropped after the name changed hands, leaves the event-gate window of the turn that holds the name", async (t) => {
    const h = await boot(t, { delayMs: 50, start: true, gate: true });
    assert.ok(h.i.eventGate, 'control: the framework has an event gate');
    h.state.secondCompile = new Gate();
    wake(h.fw, 'a');
    await within("the retry's compile", h.state.secondEntered.promise);
    h.i.agents.set('a', Object.create(h.agent));
    laterIncarnation(h, 'a');
    h.i.activeTurnTokens.set('a', 987_654);
    h.i.eventGate!.onInferenceStarted('a');
    h.state.secondCompile.open();
    await retriesEnded(h);
    assert.equal(inferring(h, 'a'), true, "the successor's window stays open");
    assert.equal(h.i.activeTurnTokens.get('a'), 987_654, "the successor's token is untouched");
    h.i.agents.set('a', h.agent);
    h.i.activeTurnTokens.delete('a');
  });

  it("a backlog of events handled with no I/O doesn't hold a's retry until the backlog ends", async (t) => {
    const h = await boot(t, { delayMs: 50, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    for (let n = 0; n < 3_000; n++) ping(h.fw);
    await until('the backlog and the retry', () => h.log.includes('a compile 2') && h.log.filter((line) => line === 'ping handled').length === 3_000, 60_000);
    assert.ok(h.log.indexOf('a compile 2') < h.log.lastIndexOf('ping handled'), "a's retry compiled before the backlog's last event");
  });

  it("a throw from the retry task's own cleanup reaches runUntilIdle(), and nothing is left unhandled", async (t) => {
    const h = await boot(t, { delayMs: 50, start: false });
    const retries = h.i.activeStartRetries;
    const drop = retries.delete.bind(retries);
    let thrown = false;
    retries.delete = (key: Promise<void>) => {
      const had = drop(key);
      if (!thrown) {
        thrown = true;
        throw new Error('zz the cleanup threw');
      }
      return had;
    };
    wake(h.fw, 'a');
    const ended = await within('runUntilIdle()', h.fw.runUntilIdle().then(() => null, (error: unknown) => error));
    assert.match(String(ended), /zz the cleanup threw/);
    h.i.activeTurnTokens.delete('a');
  });

  it("a second stop() whose budget runs out lists a retry still under way once", async (t) => {
    const h = await boot(t, { delayMs: 50, start: true });
    h.state.secondCompile = new Gate();
    wake(h.fw, 'a');
    await within("the retry's compile", h.state.secondEntered.promise);
    let first: unknown;
    let second: unknown;
    try {
      first = await h.fw.stop(50).then(() => null, (error: unknown) => error);
      second = await h.fw.stop(50).then(() => null, (error: unknown) => error);
    } finally {
      h.state.secondCompile.open();
    }
    await retriesEnded(h);
    assert.match(String((first as Error | null)?.message), /start-retry:a/, 'control: the first stop ran out with the retry under way');
    assert.equal(String((second as Error | null)?.message).match(/start-retry:a/g)?.length, 1, String((second as Error | null)?.message));
  });

  it("a second wake for a during the wait stays queued, and runs once the retry's turn has ended", async (t) => {
    const h = await boot(t, { delayMs: 300, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    wake(h.fw, 'a');
    await until("the second wake's request", () => h.i.pendingRequests.some((request) => request.agentName === 'a'));
    assert.equal(h.state.compiles, 1, 'control: nothing ran for the second wake during the wait');
    await until('both turns to answer', () => h.log.filter((line) => line === 'completed:a').length === 2);
    assert.ok(before(h.log, 'completed:a', 'a compile 3'), `the second wake ran after the retry's turn: ${h.log.join(', ')}`);
  });

  it('a provider wait recorded during the delay holds the retry: its token is cleared and its admission given back', async (t) => {
    const h = await boot(t, { delayMs: 300, start: true });
    wake(h.fw, 'a');
    await until("a's wait to retry", () => h.log.includes('waiting:a'));
    h.i.providerWaits.set('a', 'zz-model', 120_000, 'stated during the wait');
    await retriesEnded(h);
    assert.equal(h.state.compiles, 1, 'the held retry compiled nothing');
    assert.equal(h.i.activeTurnTokens.has('a'), false, "a's turn token is cleared");
    assert.equal(h.i.providerGates.get('a')?.primaryDepth ?? 0, 0, "a's admission is given back");
  });

  it('stop() reports a throw that a retry kept while it stopped, and leaves none for later', async (t) => {
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    const h = await boot(t, { delayMs: 50, start: true, failedCompiles: 2, throwOnRetryFailure: true });
    h.state.secondCompile = new Gate();
    wake(h.fw, 'a');
    await within("the retry's compile", h.state.secondEntered.promise);
    const stopping = h.fw.stop();
    await sleep(100);
    h.state.secondCompile.open();
    await stopping;
    assert.ok(errors.some((args) => args[0] === 'Error in event loop:' && /zz the policy threw/.test(String(args[1]))), 'stop() wrote the kept throw as the loop writes one');
    assert.equal((h.fw as unknown as { startRetryErrors: unknown[] }).startRetryErrors.length, 0, 'none is kept for a later runUntilIdle()');
  });

  it("a throw out of a replaced agent's retry start settles nothing of the agent that holds the name now", async (t) => {
    const h = await boot(t, { delayMs: 50, start: true, failedCompiles: 2, throwOnRetryFailure: true });
    h.state.secondCompile = new Gate();
    wake(h.fw, 'a');
    await within("the retry's compile", h.state.secondEntered.promise);
    const successorTurn = { ...h.i.turnRouting.get('a') };
    h.i.agents.set('a', Object.create(h.agent));
    h.i.openLogical.set('a', successorTurn);
    h.state.secondCompile.open();
    await retriesEnded(h);
    assert.equal(h.i.openLogical.get('a'), successorTurn, "the successor's open turn is left open");
    h.i.agents.set('a', h.agent);
    h.i.openLogical.delete('a');
  });

  it('a throw out of the retry under runUntilIdle() rejects runUntilIdle() with it', async (t) => {
    const h = await boot(t, { delayMs: 50, start: false, failedCompiles: 2, throwOnRetryFailure: true });
    wake(h.fw, 'a');
    await assert.rejects(h.fw.runUntilIdle(), /zz the policy threw/);
    assert.equal(h.state.compiles, 2, 'the retry ran, and its failure reached the policy');
  });

  it("stop() during the wait cancels the retry, and stop() waits for a retry's start that is under way", async (t) => {
    const stopped = await boot(t, { delayMs: 60_000, start: true });
    wake(stopped.fw, 'a');
    await until("a's wait to retry", () => stopped.log.includes('waiting:a'));
    await stopped.fw.stop();
    assert.deepEqual(aborts(stopped.traces, 'a'), [STOPPING]);
    assert.equal(stopped.state.compiles, 1, 'no second compile');

    const h = await boot(t, { delayMs: 50, start: true });
    h.state.secondCompile = new Gate();
    wake(h.fw, 'a');
    await within("the retry's compile", h.state.secondEntered.promise);
    let settled = false;
    const stopping = h.fw.stop().finally(() => { settled = true; });
    await sleep(300);
    assert.equal(settled, false, "stop() waits while the retry's compile runs");
    h.state.secondCompile.open();
    await stopping;
  });
});
