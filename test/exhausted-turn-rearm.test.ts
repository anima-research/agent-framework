import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter, Membrane, MembraneError } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'zz_look', description: 'zz look', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'zz-looked' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ThrowingStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.error;
  }
}

const openingOf = new WeakMap<Error, StreamEvent[]>();

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (const event of openingOf.get(this.error) ?? []) yield event;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

class DeadlineStream implements YieldingStream {
  constructor(private readonly reason = 'timeout') {}
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'aborted', reason: this.reason } as StreamEvent;
  }
}

class HeldOpenStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  private stop: () => void = () => {};
  private readonly stopped = new Promise<void>((resolve) => { this.stop = resolve; });
  constructor(private readonly open: Promise<void>, private readonly answer: YieldingStream) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; this.stop(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await Promise.race([this.open, this.stopped]);
    if (this.isCancelled) return;
    yield* this.answer;
  }
}

class ToolRoundThenErrorStream implements YieldingStream {
  isCancelled = false;
  toolDepth = 0;
  private waiting = true;
  private resume?: () => void;
  constructor(private readonly error: Error, private readonly cutOff = false) {}
  get isWaitingForTools() { return this.waiting; }
  get pendingToolCallIds() { return this.waiting ? ['zz-call'] : []; }
  provideToolResults(): void { this.waiting = false; this.toolDepth = 1; this.resume?.(); }
  cancel(): void { this.isCancelled = true; this.waiting = false; this.resume?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const call = { id: 'zz-call', name: 'input--zz_look', input: {} };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } } as StreamEvent;
    yield { type: 'tool-calls', calls: [call], context: { rawText: '', preamble: '', depth: 0, previousResults: [], accumulated: '',
      roundContent: [{ type: 'tool_use', ...call }], supportsInjectedMessages: true } } as StreamEvent;
    if (this.waiting && !this.cutOff) await new Promise<void>((resolve) => { this.resume = resolve; });
    if (this.isCancelled) return;
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const failure = (type: string, extra: Record<string, unknown> = {}) => () => new MembraneError({
  type, retryable: true, message: `zz ${type} failure`, rawError: undefined, ...extra,
} as never);
const serverError = failure('server', { httpStatus: 502 });
const overloaded = failure('server', { httpStatus: 529, message: 'overloaded_error: Overloaded' });
const invalidRequest = failure('invalid_request', { httpStatus: 400, retryable: false });
const statedWait = (ms: number) => failure('rate_limit', { httpStatus: 429, retryAfterMs: ms });

// membrane's AnthropicAdapter times its idle watchdog on the real clock, so this runs before the test's clock is mocked.
let stalledOnce: Promise<Error> | undefined;
function stalledByMembrane(t: TestContext): Promise<Error> {
  return stalledOnce ??= stalledFresh(t);
}

async function stalledFresh(t: TestContext): Promise<Error> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'zz', type: 'message', role: 'assistant', model: 'zz',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cacheKeepalive: { enabled: false } } as never);
  const stream = new Membrane(adapter).streamYielding({ messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz' }] }],
    config: { model: 'claude-opus-5-5', maxTokens: 100 } } as never, { retry: false, idleTimeoutMs: 200 } as never);
  const opening: StreamEvent[] = [];
  for await (const event of stream) {
    if (event.type === 'error') {
      openingOf.set(event.error as Error, opening);
      return event.error as Error;
    }
    opening.push(event);
  }
  throw new Error('zz membrane ended the stalled stream with no error');
}

type FailsAt = 'event' | 'setup' | 'throw';

class ScriptedMembrane extends MockMembrane {
  readonly sends: Array<{ at: number; texts: string }> = [];
  readonly judged: NormalizedRequest[] = [];
  readonly judgedAt: number[] = [];
  letGo: () => void = () => {};
  private readonly heldOpen = new Promise<void>((resolve) => { this.letGo = resolve; });
  constructor(private readonly script: (send: number) => (() => Error) | { toolRoundThen: Error } | 'tool round, then a server error' | 'tool calls cut off by a server error'
    | 'tool round, then a stated wait' | 'a deadline' | 'aborted' | 'held open' | undefined, private readonly failsAt: FailsAt = 'event') { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    const texts = request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '')
      .filter((t) => t.startsWith('zz-')).join(' | ');
    this.sends.push({ at: Date.now(), texts });
    const fail = this.script(this.sends.length);
    if (typeof fail === 'object') return new ToolRoundThenErrorStream(fail.toolRoundThen);
    if (fail === 'tool round, then a server error') return new ToolRoundThenErrorStream(serverError());
    if (fail === 'tool calls cut off by a server error') return new ToolRoundThenErrorStream(serverError(), true);
    if (fail === 'a deadline') return new DeadlineStream();
    if (fail === 'aborted') return new DeadlineStream('error');
    if (fail === 'tool round, then a stated wait') return new ToolRoundThenErrorStream(statedWait(250)());
    if (fail === 'held open') return new HeldOpenStream(this.heldOpen, new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-answer-late' }])]));
    if (fail && this.failsAt === 'setup') throw fail();
    if (fail && this.failsAt === 'throw') return new ThrowingStream(fail());
    if (fail) return new ErrorStream(fail());
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.sends.length}` }])]);
  }
  override async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.judged.push(request);
    this.judgedAt.push(Date.now());
    return createMockResponse([{ type: 'text', text: 'REPLY: zz reply now' }]);
  }
}

const fastPolicy: ErrorPolicy = {
  maxRetries: 2,
  onInferenceError: (error, _agent, attempt) =>
    (error as { retryable?: boolean }).retryable !== false && attempt < 2 ? { retry: true, delayMs: 5 } : { retry: false },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let stepClock: ((ms: number) => void) | undefined;
const clocked = new WeakSet<TestContext>();
function useClock(t: TestContext): void {
  if (clocked.has(t)) return;
  clocked.add(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  stepClock = (ms) => t.mock.timers.tick(ms);
}
const STEP_MS = 5;
// setImmediate isn't among the mocked apis, so its turns let the framework's async work run between steps.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const stderr: string[] = [];
console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
const rearmLines = (...parts: string[]) =>
  stderr.filter((line) => line.startsWith('[inference-rearm]') && parts.every((part) => line.includes(part)));

async function waitFor(done: () => boolean, what: string, boundMs = 10_000): Promise<void> {
  if (!stepClock) {
    const deadline = performance.now() + boundMs;
    while (!done()) {
      if (performance.now() > deadline) throw new Error(`zz-timeout: ${what} did not happen within ${boundMs} ms`);
      await sleep(10);
    }
    return;
  }
  await settle();
  for (let stepped = 0; !done(); stepped += STEP_MS) {
    if (stepped >= boundMs) throw new Error(`zz-timeout: ${what} did not happen within ${boundMs} ms of the mocked clock`);
    stepClock(STEP_MS);
    await settle();
  }
}

async function stepping<T>(work: Promise<T>, what: string): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  void work.then((value) => { outcome = { ok: true, value }; }, (error: unknown) => { outcome = { ok: false, error }; });
  await waitFor(() => outcome !== undefined, what, 60_000);
  if (!outcome!.ok) throw outcome!.error;
  return outcome!.value;
}

type Trace = { type: string; kind?: string; message?: string; data?: Record<string, unknown>; at: number };

const liveFrameworks = new WeakMap<TestContext, number>();

async function resident(t: TestContext, membrane: ScriptedMembrane, extra: Record<string, unknown> = {}) {
  useClock(t);
  liveFrameworks.set(t, (liveFrameworks.get(t) ?? 0) + 1);
  const dir = mkdtempSync(join(tmpdir(), 'turn-rearm-'));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy: fastPolicy, exhaustedTurnRearmMs: [150, 300, 450],
    ...extra,
  } as never);
  const traces: Trace[] = [];
  fw.onTrace((e) => {
    const ev = e as unknown as Trace;
    traces.push({ type: ev.type, kind: ev.kind, message: ev.message, data: ev.data, at: Date.now() });
  });
  t.after(async () => {
    await stepping(fw.stop(), 'the framework to stop').catch(() => {});
    const left = liveFrameworks.get(t)! - 1;
    liveFrameworks.set(t, left);
    if (left === 0) {
      stepClock = undefined;
      t.mock.timers.reset();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  fw.start();
  const count = (type: string) => traces.filter((tr) => tr.type === type).length;
  const markers = () => fw.getAgent('resident')!.getContextManager().getAllMessages()
    .filter((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('[inference-failed]'))).length;
  const admission = () => ((fw.healthSnapshot() as { agents: Array<{ name: string; consecutiveInferenceFailures: number;
    providerAdmission: { cooldownUntil: number | null; cooldownReason: string | null; heldRequests: number } }> })
    .agents.find((a) => a.name === 'resident')!);
  const say = (text: string) => fw.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} });
  return { fw, traces, count, markers, admission, say };
}

const gaps = (sends: Array<{ at: number }>) => sends.slice(1).map((s, i) => s.at - sends[i]!.at);

for (const failsAt of ['event', 'setup', 'throw'] as const) {
  test(`a turn whose retries ran out on a server error is sent again after each delay, once each time, until the delays run out (failure ${failsAt === 'setup' ? 'at its start' : failsAt === 'throw' ? 'thrown by its stream' : 'reported by its stream'})`, async (t) => {
    const membrane = new ScriptedMembrane(() => serverError, failsAt);
    const r = await resident(t, membrane);
    stderr.length = 0;
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 4, 'the window and three re-arms to end exhausted');
    assert.equal(r.admission().providerAdmission.heldRequests, 0, 'nothing is kept after the last re-arm');
    assert.equal(membrane.sends.length, 3 + 3, 'each re-arm makes one send');
    assert.equal(r.markers(), 1, 'the agent meets the outage once');
    assert.ok(membrane.sends.every((s) => s.texts.includes('zz-question')), 'every send is the same turn\'s');
    const rearmGaps = gaps(membrane.sends).slice(2);
    assert.ok(rearmGaps[0]! >= 140 && rearmGaps[1]! >= 290 && rearmGaps[2]! >= 440, `re-arms waited each delay: ${rearmGaps.join(', ')}`);
    for (const [delay, n] of [[150, 1], [300, 2], [450, 3]] as const) {
      assert.equal(rearmLines('resident', `${delay}ms`, `(${n} of 3)`).length, 1, `the operator is told re-arm ${n} is coming`);
      assert.equal(rearmLines('resident', `(${n} of 3)`).filter((line) => !line.includes(`${delay}ms`)).length, 1, `the operator is told re-arm ${n} went`);
    }
    assert.equal(rearmLines('resident', 'not re-armed', 'spent').length, 1, 'the operator is told no re-send is coming');
    const unsaid = [
      ["the heartbeat's own tick", { source: 'heartbeat', serverId: 'heartbeat' }],
      ['a self-wake timer the agent set', { source: 'gate:self-wake' }],
      ["a script's wake", { source: 'code-execution-script', tags: ['script:wake'] }],
      ['a message a tune-out holds from the agent', { tuneOut: { epochId: 'zz-epoch' } }],
    ] as const;
    for (const [i, [what, metadata]] of unsaid.entries()) {
      (r.fw as unknown as { addMessage(role: string, content: unknown[], metadata: unknown): unknown })
        .addMessage('user', [{ type: 'text', text: `zz-unsaid-${i}` }], metadata);
      queue(r, { reason: 'zz-wake' });
      await waitFor(() => r.count('inference:exhausted') === 5 + i, `a wake's turn after ${what} to end exhausted`);
      assert.equal(r.admission().providerAdmission.heldRequests, 0, `${what} doesn't start the count again`);
    }
    assert.deepEqual(rearmLines('count', 'message'), [], 'nor says it did');
    stderr.length = 0;
    r.say('zz-second');
    await waitFor(() => r.count('inference:exhausted') === 5 + unsaid.length, "a new message's turn to end exhausted");
    assert.equal(r.admission().providerAdmission.heldRequests, 1, 'a message said to the agent starts the count again');
    assert.equal(rearmLines('resident', 'count', 'message').length, 1, 'the operator is told why the count went back');
    assert.equal(rearmLines('resident', '150ms', '(1 of 3)').length, 1, 'from the first delay');
  });
}

test('each transient failure is re-armed: a server error, a network failure, a timeout, an overload, and a rate limit with no wait still to come', async (t) => {
  for (const [name, fail] of [['server', serverError], ['network', failure('network')], ['timeout', failure('timeout')],
    ['overloaded', overloaded], ['rate limit', failure('rate_limit', { httpStatus: 429 })],
    ['rate limit stating a wait already over', failure('rate_limit', { httpStatus: 429, retryAfterMs: 0 })]] as const) {
    const membrane = new ScriptedMembrane((n) => (n <= 3 ? fail : undefined));
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [50] });
    r.say('zz-question');
    await waitFor(() => r.count('inference:completed') === 1, `${name}: the re-armed turn to answer`);
    assert.equal(membrane.sends.length, 4, `${name}: the window, then one re-armed send`);
  }
});

test('a failure that is not transient is not re-armed: one the provider refuses or says not to retry, one membrane could not classify, one with no provider error, or, in a turn that is not itself a re-arm, a deadline', async (t) => {
  const stalled = await stalledByMembrane(t);
  assert.ok(stalled instanceof MembraneError && stalled.type === 'timeout' && stalled.retryable, 'membrane throws a stalled stream as a retryable timeout');
  stderr.length = 0;
  for (const [name, fail] of [['invalid request', invalidRequest], ['context length', failure('context_length', { retryable: false })],
    ['server error marked not retryable', failure('server', { httpStatus: 502, retryable: false })],
    ['auth', failure('auth', { retryable: false, httpStatus: 401 })], ['unknown', failure('unknown')],
    ['plain error', () => new Error('zz not a provider error')], ['deadline the host set', 'a deadline'],
    ['invalid request membrane marks retryable', failure('invalid_request', { httpStatus: 400 })],
    ["deadline membrane's adapter ran out of, thrown as a retryable timeout", () => stalled]] as const) {
    const membrane = new ScriptedMembrane(() => fail);
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [50] });
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 1, `${name}: the turn to end exhausted`);
    assert.equal(r.admission().providerAdmission.heldRequests, 0, `${name}: nothing is kept to be sent again`);
  }
  assert.ok(!stderr.some((line) => line.includes('turn not re-armed')), 'a turn never re-armed promises the operator nothing to take back');
});

test("a turn that isn't a re-arm is never re-armed on a deadline membrane marks, even when the provider answered its earlier tries with server errors", async (t) => {
  const stalled = await stalledByMembrane(t);
  const membrane = new ScriptedMembrane((n) => (n <= 2 ? serverError : () => stalled));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [50] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 1, 'the turn to end exhausted on the cut');
  assert.equal(membrane.sends.length, 5, "two server errors, then the cut and the calls the error policy's deadline schedule makes again, each cut too");
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'nothing is kept to be sent again');
});

test("a re-armed turn's send is not retried, whatever its failure: an overload after a server error gets its one send, then the next delay", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : overloaded));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 200] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 3, 'two re-arms to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'nothing is kept after the last re-arm');
  assert.equal(membrane.sends.length, 5);
});

for (const [name, fail, failsAt] of [['refused by the provider, at its start', invalidRequest, 'setup'], ['refused by the provider, by its stream', invalidRequest, 'event'],
  ['with no provider error, at its start', () => new Error('zz not a provider error'), 'setup'], ['with no provider error, by its stream', () => new Error('zz not a provider error'), 'event'],
  ['with no provider error, thrown by its stream', () => new Error('zz not a provider error'), 'throw'], ['aborted by its stream', 'aborted', 'event']] as const) {
  test(`a re-armed turn that fails in a way that is not transient (${name}) makes its one send, writes a marker, and ends the re-arming`, async (t) => {
    const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : fail), failsAt);
    const r = await resident(t, membrane);
    stderr.length = 0;
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 2, 'the re-armed turn to end exhausted');
    assert.ok(stderr.some((line) => line.startsWith("[inference-rearm] agent=resident turn not re-armed: its failure isn't transient (")),
      'the operator is told why no re-send is coming');
    assert.equal(r.admission().providerAdmission.heldRequests, 0, 'no re-arm follows');
    assert.equal(membrane.sends.length, 4, 'no retry came');
    assert.equal(r.markers(), 2, 'the agent is told the re-armed turn failed another way');
  });
}

for (const failsAt of ['event', 'setup', 'throw'] as const) {
  test(`a re-armed send that a deadline membrane marks cuts is sent again at the next delay, once in its chain; cut again, the chain ends (cut ${failsAt === 'setup' ? 'at its start' : failsAt === 'throw' ? 'thrown by its stream' : 'reported by its stream'})`, async (t) => {
    const stalled = await stalledByMembrane(t);
    const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : () => stalled), failsAt);
    assert.deepEqual(openingOf.get(stalled)?.map((e) => (e as { type: string }).type), [],
      "membrane 0.8.0's stalled stream emits nothing before its cut, and the stall replays that");
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 300, 900] });
    stderr.length = 0;
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 2, 'the first re-armed send to end exhausted');
    assert.equal(r.admission().providerAdmission.heldRequests, 1, "its chain's first deadline cut is re-armed, as a transient failure is");
    assert.match(r.admission().providerAdmission.cooldownReason ?? '', /\(2 of 3\)/);
    assert.equal(r.markers(), 1, 'the first cut writes no marker of its own');
    await waitFor(() => r.count('inference:exhausted') === 3, 'the second re-armed send to end exhausted');
    assert.equal(r.admission().providerAdmission.heldRequests, 0, 'a second cut in the chain ends it');
    assert.ok(stderr.some((line) => line.startsWith("[inference-rearm] agent=resident turn not re-armed: its failure isn't transient (timeout)")),
      'the operator is told why no re-send is coming');
    assert.equal(membrane.sends.length, 5, 'the window, then one send for each re-arm');
    assert.equal(r.markers(), 2, 'the cut that ends the chain writes its marker');
    const afterCut = gaps(membrane.sends)[3]!;
    assert.ok(afterCut >= 290 && afterCut < 890, `the send after the first cut waited the next delay: ${afterCut}ms`);
  });
}

test("a re-armed send cut by the host's bound on the call is taken as membrane's marked cut is: sent again once in its chain, and cut again, the chain ends", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : 'a deadline'));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 300, 900] });
  stderr.length = 0;
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 2, 'the first re-armed send to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 1, "its chain's first cut is re-armed");
  assert.match(r.admission().providerAdmission.cooldownReason ?? '', /\(2 of 3\)/);
  await waitFor(() => r.count('inference:exhausted') === 3, 'the second re-armed send to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'a second cut in the chain ends it');
  assert.ok(stderr.some((line) => line.startsWith("[inference-rearm] agent=resident turn not re-armed: its failure isn't transient (timeout)")),
    'the operator is told why no re-send is coming');
  assert.equal(membrane.sends.length, 5, 'the window, then one send for each re-arm');
});

for (const failsAt of ['event', 'setup'] as const) {
  test(`a re-armed turn that got partway gets the error policy's retry for its first deadline cut and none for its second, which ends the re-arming (second cut ${failsAt === 'setup' ? 'at its start' : 'reported by its stream'})`, async (t) => {
    const stalled = await stalledByMembrane(t);
    const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : n === 4 ? { toolRoundThen: stalled } : () => stalled), failsAt);
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100] });
    stderr.length = 0;
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 2, 'the re-armed turn to end exhausted');
    assert.equal(membrane.sends.length, 5, "the window, then the re-armed turn's send and the error policy's one retry: its second cut gets none");
    assert.equal(r.admission().providerAdmission.heldRequests, 0, 'its second cut ends the re-arming');
    assert.ok(stderr.some((line) => line.startsWith("[inference-rearm] agent=resident turn not re-armed: its failure isn't transient (timeout)")),
      'the operator is told why no re-send is coming');
    assert.equal(r.markers(), 2, "the window's marker, and the one the partway turn's second cut writes");
    const markerTexts = r.fw.getAgent('resident')!.getContextManager().getAllMessages().flatMap((m) => m.content)
      .flatMap((b) => (b.type === 'text' && (b as { text: string }).text.startsWith('[inference-failed]') ? [(b as { text: string }).text] : []));
    assert.match(markerTexts.at(-1) ?? '', /The call was made again, and it timed out again\./, "and that marker says the policy's retry was cut again");
  });
}

test("a server error between two cuts is an answer from the provider, so the cut after it is a first again and is re-armed", async (t) => {
  const stalled = await stalledByMembrane(t);
  const membrane = new ScriptedMembrane((n) => (n <= 3 || n === 5 || n === 6 ? serverError : n === 4 ? { toolRoundThen: stalled } : () => stalled));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 2, 'the re-armed turn, cut once and then failing with server errors, to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 1, 'its last failure was transient, so it is re-armed');
  await waitFor(() => r.count('inference:exhausted') === 3, 'the next re-armed send to end exhausted, cut');
  assert.equal(membrane.sends.length, 7);
  assert.equal(r.admission().providerAdmission.heldRequests, 1, 'the server errors came between the cuts, so this cut is taken as a first and re-armed');
  assert.match(r.admission().providerAdmission.cooldownReason ?? '', /\(3 of 3\)/);
});

for (const answersRound of [true, false]) {
  test(`an answer in a turn that isn't a re-arm comes between two cuts too: a merged wake's ${answersRound ? 'round and server errors' : 'server errors alone'} make the next re-armed cut a first`, async (t) => {
    const stalled = await stalledByMembrane(t);
    const membrane = new ScriptedMembrane((n) => (n <= 3 || n === 6 || n === 7 ? serverError
      : n === 5 ? (answersRound ? { toolRoundThen: serverError() } : serverError) : () => stalled));
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100, 100] });
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 2, 'the first re-armed send to end exhausted, cut');
    assert.equal(r.admission().providerAdmission.heldRequests, 1);
    queue(r, { reason: 'zz-wake' });
    await waitFor(() => r.count('inference:exhausted') === 4,
      `the wake's turn, merged with the held re-arm, to ${answersRound ? 'answer a round and ' : ''}end on server errors, and the next re-armed send to end exhausted, cut`);
    assert.equal(membrane.sends.length, 8);
    assert.equal(r.admission().providerAdmission.heldRequests, 1, "the merged turn's answers came between the cuts, so this cut is a first and is re-armed");
    assert.match(r.admission().providerAdmission.cooldownReason ?? '', /\(4 of 4\)/);
  });
}

test("a round answered between two cuts is an answer from the provider, so the cut after it is a first again and gets the error policy's retry", async (t) => {
  const stalled = await stalledByMembrane(t);
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : n === 4 ? () => stalled : n === 5 ? { toolRoundThen: stalled } : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:completed') === 1 || r.count('inference:exhausted') === 3,
    "the second re-armed turn, which answers a round and is then cut, to end");
  assert.equal(r.count('inference:completed'), 1, "its cut is a first again, so the error policy retries it and the retry answers");
  assert.equal(membrane.sends.length, 6, "the window, the first re-armed send, cut, then the second's round, cut, and its retry");
});

test("under a host's policy that makes no fresh call for a deadline, a re-armed turn that got partway and ends on its chain's first deadline cut is re-armed, and writes the marker a partway turn does", async (t) => {
  const stalled = await stalledByMembrane(t);
  const membrane = new ScriptedMembrane((n) => (n <= 3 || n === 5 ? serverError : n === 4 ? 'tool round, then a server error' : () => stalled));
  const noFreshCall: ErrorPolicy = {
    maxRetries: 2,
    onInferenceError: (error, agent, attempt) => ((error as unknown as Record<symbol, unknown>)[Symbol.for('membrane.deadlineExpiry')] === true
      ? { retry: false } : fastPolicy.onInferenceError(error, agent, attempt)),
  };
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100], errorPolicy: noFreshCall });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 2, 'the re-armed turn to end exhausted on its first cut');
  assert.equal(membrane.sends.length, 6, "the window, then the re-armed turn's send and the error policy's two retries");
  assert.equal(r.admission().providerAdmission.heldRequests, 1, "its first cut is taken as a transient failure, so it is re-armed");
  assert.equal(r.markers(), 2, "the window's marker, and the one a re-armed turn that got partway writes");
});

test("a deadline cut a host's provider hold takes in a re-armed turn counts, so the held send's next cut ends the re-arming", async (t) => {
  const stalled = await stalledByMembrane(t);
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : () => stalled));
  let held = false;
  const providerHold = (error: Error) => (error === stalled && !held ? (held = true, { holdMs: 100, reason: 'zz host hold' }) : undefined);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100], providerHold });
  stderr.length = 0;
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 2, 'the held send, cut again, to end exhausted');
  assert.equal(membrane.sends.length, 5, 'the window, the re-armed send the host held, and that send again');
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'the held cut was the chain\'s first, so this one ends the re-arming');
  assert.ok(stderr.some((line) => line.startsWith("[inference-rearm] agent=resident turn not re-armed: its failure isn't transient (timeout)")));
});

for (const failsAt of ['setup', 'event'] as const) {
  test(`a message said while a re-armed send's cut is reported starts the chain afresh after that cut, so the next cut is re-armed too (cut ${failsAt === 'setup' ? 'at its start' : 'reported by its stream'})`, async (t) => {
    const stalled = await stalledByMembrane(t);
    const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : () => stalled), failsAt);
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100] });
    let said = false;
    r.fw.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:exhausted' || said || r.count('inference:exhausted') < 2) return;
      said = true;
      (r.fw as unknown as { addMessage(role: string, content: unknown[], metadata: unknown): unknown })
        .addMessage('user', [{ type: 'text', text: 'zz-said-during-the-cut' }], {});
    });
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 3, 'the next re-armed send to end exhausted, cut');
    assert.ok(said, "the message was said while the first cut's exhaustion was reported");
    assert.equal(r.admission().providerAdmission.heldRequests, 1, 'the cut before the message belongs to the chain it ended, so this cut is the new chain\'s first');
  });
}

test("deadline cuts in a turn that isn't a re-arm don't count toward the chain: the first re-armed send's cut is still re-armed", async (t) => {
  const stalled = await stalledByMembrane(t);
  const membrane = new ScriptedMembrane((n) => (n <= 2 || n >= 4 ? () => stalled : serverError));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 2, 'the window, cut twice then failing with a server error, and its first re-arm, cut, to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 1, "the window's cuts were the error policy's, so the re-armed send's cut is the chain's first");
  assert.match(r.admission().providerAdmission.cooldownReason ?? '', /\(2 of 3\)/);
});

for (const [clears, script] of [
  ['a message said to the agent', (stalled: Error) => (n: number) => (n <= 3 ? serverError : () => stalled)],
  ['a completed turn', (stalled: Error) => (n: number) => (n <= 3 || (n >= 6 && n <= 8) ? serverError : n === 5 ? undefined : () => stalled)],
] as const) {
  test(`${clears} starts the chain afresh, so its next re-armed send's deadline cut is re-armed again`, async (t) => {
    const stalled = await stalledByMembrane(t);
    const membrane = new ScriptedMembrane(script(stalled));
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100, 100] });
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 2, "the chain's first re-armed send to end exhausted, cut once");
    assert.equal(r.admission().providerAdmission.heldRequests, 1);
    if (clears === 'a message said to the agent') {
      (r.fw as unknown as { addMessage(role: string, content: unknown[], metadata: unknown): unknown })
        .addMessage('user', [{ type: 'text', text: 'zz-said' }], {});
    } else {
      await waitFor(() => r.count('inference:completed') === 1, 'the next re-arm to answer');
      queue(r, { reason: 'zz-wake' });
      await waitFor(() => r.count('inference:exhausted') === 3, "a later turn's window to end exhausted");
    }
    await waitFor(() => r.count('inference:exhausted') === 3 + (clears === 'a message said to the agent' ? 0 : 1),
      'the next re-armed send to end exhausted, cut');
    assert.equal(r.admission().providerAdmission.heldRequests, 1, "its cut is the chain's first again, so it is re-armed");
  });
}

test("a stated wait on a re-armed turn's send holds it as it holds any turn, and what follows is still that re-arm's one send", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : n === 4 ? statedWait(250) : n === 5 ? serverError : undefined));
  const r = await resident(t, membrane);
  r.say('zz-question');
  await waitFor(() => r.count('inference:completed') === 1, 'the second re-arm to answer');
  assert.equal(membrane.sends.length, 6, 'the send after the stated wait is still the re-arm\'s one send');
  assert.equal(r.count('inference:exhausted'), 2, 'the stated wait held the re-armed turn rather than ending it');
  assert.ok(gaps(membrane.sends)[3]! >= 240, 'the send after the stated wait waited it');
  assert.ok(gaps(membrane.sends)[4]! >= 290, 'the second delay followed its failure');
});

test("one [inference-failed] marker for the window and every re-arm after it; each failure counts toward the hard-down streak, whose alert comes at the third", async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [50, 50, 50] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 4, 'the window and three re-arms to end exhausted');
  assert.equal(r.markers(), 1, 'the agent meets the failure once');
  assert.equal(r.admission().consecutiveInferenceFailures, 4);
  const firstAlert = r.traces.find((tr) => tr.type === 'ops:alert' && tr.kind === 'hard-down');
  assert.ok(firstAlert, 'the hard-down alert came');
  const sentBefore = membrane.sends.filter((s) => s.at <= firstAlert.at).length;
  assert.equal(sentBefore, 5, "at the third exhaustion, the second re-arm's: the window's three sends and two re-arms'");
});

for (const [how, expected, failsAt] of [['tool round, then a server error', /Its earlier rounds ran/, 'event'], ['tool round, then a server error', /Its earlier rounds ran/, 'setup'],
  ['tool calls cut off by a server error', /tool calls were started, but its stream ended/, 'event']] as const) {
test(`a re-armed turn that got partway (${how}; later failures ${failsAt === 'setup' ? 'at their start' : 'by their stream'}) gets the error policy's retries, and a marker saying how far it got`, async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 || n === 5 || n === 6 ? serverError : n === 4 ? how : undefined), failsAt);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:completed') === 1, 'the second re-arm to answer');
  assert.equal(membrane.sends.length, 7, "the window, the re-armed turn's three sends, then the second re-arm's one");
  const markers = r.fw.getAgent('resident')!.getContextManager().getAllMessages()
    .flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').filter((text) => text.startsWith('[inference-failed]'));
  assert.equal(markers.length, 2);
  assert.match(markers[1]!, expected);
});
}

test('a re-armed turn that answers completes, and the next outage is re-armed from the first delay again', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 || (n >= 5 && n <= 7) ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [1_000, 5_000, 5_000] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:completed') === 1, 'the re-armed turn to answer');
  queue(r, { reason: 'zz-wake' });
  await waitFor(() => r.count('inference:exhausted') === 2, "a wake's window, with no message said, to end exhausted");
  const { cooldownReason, cooldownUntil } = r.admission().providerAdmission;
  assert.match(cooldownReason ?? '', /\(1 of 3\)/);
  assert.ok(cooldownUntil !== null && cooldownUntil - Date.now() <= 1_000, 'the first delay, not the second');
});

test('a wake while the agent waits starts its turn at once, with the re-armed trigger merged in; the hold shows its time and reason', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [60_000] });
  const before = Date.now();
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 1, 'the window to end exhausted');
  const { cooldownUntil, cooldownReason, heldRequests } = r.admission().providerAdmission;
  assert.equal(heldRequests, 1);
  assert.ok(cooldownUntil !== null && cooldownUntil >= before + 60_000 && cooldownUntil <= Date.now() + 60_000, 'held until its delay ends');
  assert.match(cooldownReason ?? '', /retries ran out .*zz server failure.*sent again \(1 of 1\)/);
  stderr.length = 0;
  r.say('zz-second');
  await waitFor(() => r.count('inference:completed') === 1, 'the new wake to start the turn');
  assert.equal(membrane.sends.length, 4);
  assert.match(membrane.sends[3]!.texts, /zz-question.*zz-second/);
  assert.ok(stderr.includes('[inference-rearm] agent=resident turn queued again with a wake (1 of 1)'), 'the operator is told the re-arm went with the wake');
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'nothing is left held');
});

for (const said of [false, true]) {
  test(`the turn a wake starts while the agent waits is the wake's own, with the error policy's retries; the next re-arm ${said ? 'starts the count again, since a message was said' : 'follows it'}`, async (t) => {
    const membrane = new ScriptedMembrane((n) => (n <= 6 ? serverError : undefined));
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [2_000, 100] });
    r.say('zz-question');
    await waitFor(() => r.count('inference:exhausted') === 1, 'the window to end exhausted');
    if (said) r.say('zz-second');
    else queue(r, { reason: 'zz-wake' });
    await waitFor(() => r.count('inference:exhausted') === 2, "the wake's turn to end exhausted");
    assert.equal(membrane.sends.length, 6, "the wake's turn made three sends");
    const { cooldownReason } = r.admission().providerAdmission;
    assert.match(cooldownReason ?? '', said ? /\(1 of 2\)/ : /\(2 of 2\)/);
    await waitFor(() => r.count('inference:completed') === 1, 'the next re-arm to answer');
    assert.equal(membrane.sends.length, 7, 'then the re-arm one');
    assert.match(membrane.sends[6]!.texts, said ? /zz-question.*zz-second/ : /zz-question/);
    const gap = gaps(membrane.sends)[5]!;
    assert.ok(said ? gap >= 1_900 : gap >= 90 && gap < 1_900, `the ${said ? 'first' : 'second'} delay came between them: ${gap}`);
  });
}

test("a judge rule's wake while the agent waits is judged as usual, and the judge is told when the re-arm comes", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : undefined));
  const dir = mkdtempSync(join(tmpdir(), 'turn-rearm-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [60_000], gate: { configPath: join(dir, 'gate.json'),
    config: { policies: [{ name: 'judged', match: {}, behavior: { judge: { debounceMs: 100 } } }] } } });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 1, 'the window to end exhausted');
  const heldUntil = r.admission().providerAdmission.cooldownUntil!;
  assert.equal(membrane.judged.length, 1);
  const saidAt = Date.now();
  r.say('zz-second');
  await waitFor(() => r.count('inference:completed') === 1, 'the judged wake to start the turn');
  assert.equal(membrane.judged.length, 2, 'the judge made its call');
  const request = membrane.judged[1]!;
  const told = [JSON.stringify(request.system ?? ''), ...request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '')].join('\n');
  const when = /- in (\d+) s: a turn whose retries ran out, sent again \(1 of 1\)/.exec(told);
  assert.ok(when, 'the judge is told of the re-arm');
  const leastLeft = Math.floor((heldUntil - membrane.judgedAt[1]!) / 1000);
  const mostLeft = Math.ceil((heldUntil - saidAt) / 1000);
  assert.ok(Number(when[1]) >= leastLeft && Number(when[1]) <= mostLeft, `and when it comes: in ${when[1]} s, between ${leastLeft} and ${mostLeft}`);
});

test("a message stored in the residents' shared slot starts the count again for each resident that reads it", async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100], agents: [
    { name: 'resident', model: 'zz-model', systemPrompt: 'system' }, { name: 'second', model: 'zz-model', systemPrompt: 'system' }] });
  const held = () => ((r.fw.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { heldRequests: number } }> })
    .agents.find((a) => a.name === 'second')!).providerAdmission.heldRequests;
  queue(r, { agentName: 'second', reason: 'zz-wake' });
  await waitFor(() => r.count('inference:exhausted') === 2, "the second resident's window and its one re-arm to end exhausted");
  assert.equal(held(), 0, 'its re-arms are spent');
  (r.fw as unknown as { addMessage(role: string, content: unknown[], metadata: unknown): unknown })
    .addMessage('user', [{ type: 'text', text: 'zz-said' }], {});
  queue(r, { agentName: 'second', reason: 'zz-wake' });
  await waitFor(() => r.count('inference:exhausted') === 3, "the second resident's next turn to end exhausted");
  assert.equal(held(), 1, 'a message stored under the first resident, in the slot both read, starts the second\'s count again');
});

test('a message said while a turn runs its tools starts the count again when the tool boundary stores it', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 5 ? 'tool round, then a server error' : serverError));
  const module = new class extends InputModule {
    onTool: (() => void) | undefined;
    override async handleToolCall(call: ToolCall): Promise<ToolResult> { this.onTool?.(); return super.handleToolCall(call); }
  }();
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100], modules: [module] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 2, 'the window and its one re-arm to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'the re-arms are spent');
  module.onTool = () => {
    (r.fw as unknown as { addMessage(role: string, content: unknown[], metadata: unknown): unknown })
      .addMessage('user', [{ type: 'text', text: 'zz-said-mid-turn' }], {});
  };
  stderr.length = 0;
  queue(r, { reason: 'zz-wake' });
  await waitFor(() => r.count('inference:exhausted') === 3, 'the turn that ran its tools to end exhausted');
  assert.equal(rearmLines('resident', 'count', 'message').length, 1, stderr.join('\n'));
  assert.equal(r.admission().providerAdmission.heldRequests, 1, 'its re-arm waits: the message the boundary stored started the count again');
});

test("a new framework on a stopped one's store re-arms from its first delay", async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const storeDir = mkdtempSync(join(tmpdir(), 'turn-rearm-store-'));
  const store = JsStore.openOrCreate({ path: join(storeDir, 'store') });
  const first = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100], store });
  first.say('zz-question');
  await waitFor(() => first.count('inference:exhausted') === 3, 'the window and its two re-arms to end exhausted');
  assert.equal(first.admission().providerAdmission.heldRequests, 0, 'the re-arms are spent');
  await stepping(first.fw.stop(), 'the framework to stop');
  const next = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100], store });
  t.after(() => { store.close(); rmSync(storeDir, { recursive: true, force: true }); });
  queue(next, { reason: 'zz-wake' });
  await waitFor(() => next.count('inference:exhausted') === 1, "the new framework's turn to end exhausted");
  assert.equal(next.admission().providerAdmission.heldRequests, 1, 'its re-arm waits: the count started again');
  assert.match(next.admission().providerAdmission.cooldownReason ?? '', /\(1 of 2\)/, 'at the first delay');
  await stepping(next.fw.stop(), 'the framework to stop before its store closes');
});

test('with exhaustedTurnRearmMs false, a turn whose retries ran out is not sent again', async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  stderr.length = 0;
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 1, 'the turn to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 0, 'nothing is kept to be sent again');
  assert.equal(membrane.sends.length, 3);
  assert.equal(r.markers(), 1);
  assert.ok(!stderr.some((line) => line.includes('[inference-rearm]')), 'with re-arming off, nothing is said of it');
});

test('an exhaustedTurnRearmMs that is neither false nor a list of delays above 0 is refused at create', async () => {
  // eslint-disable-next-line no-sparse-arrays
  for (const value of [true, [], [0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], ['100'], 100, [, 150]]) {
    const dir = mkdtempSync(join(tmpdir(), 'turn-rearm-config-'));
    try {
      await assert.rejects(AgentFramework.create({
        storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }], modules: [],
        syncIntervalMs: 0, maintenanceIntervalMs: 0, exhaustedTurnRearmMs: value,
      } as never), /exhaustedTurnRearmMs must be false, or a list of one or more delays in ms/, JSON.stringify(value));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a conversation fork whose retries ran out is not re-armed', async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [50], conversations: { templateAgent: 'resident' } });
  r.fw.pushEvent({
    type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'slack:D1', messageId: 'm-1',
    author: { id: 'U1', name: 'alice' }, content: [{ type: 'text', text: 'zz-direct' }],
    timestamp: new Date().toISOString(), metadata: { mentioned: false, channel_type: 'im' }, triggerInference: true,
  } as never);
  await waitFor(() => r.count('inference:exhausted') === 1, "the fork's turn to end exhausted");
  assert.equal(r.fw.getHostModeStatus().gatedRequests, 0, 'nothing is held for the fork');
});

const accelerationWait = failure('rate_limit', { httpStatus: 429, retryAfterMs: 250, message: "zz your organization's acceleration limit was reached" });
for (const [kind, waits] of [['a provider wait', statedWait(250)], ['an acceleration cooldown', accelerationWait]] as const) {
test(`stated waits in a row that hold one turn past an hour raise one provider-wait alert, which doesn't count toward the hard-down streak (each held as ${kind})`, async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 5 ? waits : undefined));
  const r = await resident(t, membrane);
  (r.fw as unknown as { providerAccelerationJitterMs: number }).providerAccelerationJitterMs = 0;
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  for (let held = 1; held <= 5; held++) {
    await waitFor(() => membrane.sends.length === held && r.admission().providerAdmission.heldRequests === 1, `hold ${held}`);
    assert.equal(alerts().length, held < 4 ? 0 : 1, `after hold ${held}: ${held < 4 ? 'under an hour' : 'past an hour, alerted once'}`);
    t.mock.timers.tick(25 * 60_000);
  }
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer');
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0]!.data?.holds, 4);
  assert.ok(Math.abs(Date.parse(String(alerts()[0]!.data?.since)) - membrane.sends[0]!.at) < 1_000, 'the run counts from its first hold');
  assert.match(alerts()[0]!.message ?? '', /a turn's 4 stated waits in a row on \S+ span 75 min since /);
  assert.match(alerts()[0]!.message ?? '', /points to the account's rate limit or quota, or this host's load$/);
  assert.equal(r.admission().consecutiveInferenceFailures, 0);
  assert.equal(r.count('inference:exhausted'), 0);
});
}

test("stated waits that a host's hold takes count in the run", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? statedWait(40 * 60_000) : undefined));
  const consulted = new Set<Error>();
  const providerHold = (error: Error) => (consulted.has(error) ? undefined : (consulted.add(error), { holdMs: 1_000, reason: 'zz host hold' }));
  const r = await resident(t, membrane, { providerHold });
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  for (const held of [1, 2, 3]) {
    await waitFor(() => membrane.sends.length === held && r.admission().providerAdmission.heldRequests === 1, `hold ${held}`);
    assert.equal(alerts().length, held < 3 ? 0 : 1, `after hold ${held}`);
    t.mock.timers.tick(40 * 60_000);
  }
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer');
  assert.equal(alerts()[0]!.data?.holds, 3);
  assert.ok(Math.abs(Date.parse(String(alerts()[0]!.data?.since)) - membrane.sends[0]!.at) < 1_000, 'the run counts from its first hold');
});

test('an acceleration cooldown whose stated wait is already over counts in no run', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 4 ? failure('rate_limit', { httpStatus: 429, retryAfterMs: 0,
    message: "zz your organization's acceleration limit was reached" }) : undefined));
  const r = await resident(t, membrane);
  (r.fw as unknown as { providerAccelerationJitterMs: number }).providerAccelerationJitterMs = 0;
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  for (let held = 1; held <= 4; held++) {
    await waitFor(() => membrane.sends.length === held && r.admission().providerAdmission.heldRequests === 1, `hold ${held}`);
    t.mock.timers.tick(25 * 60_000);
  }
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer');
  assert.equal(alerts().length, 0);
});

test('a stated wait past an hour on its own raises its one alert, not a second for the run it ends', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(250) : n === 2 ? statedWait(2 * 60 * 60_000) : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1');
  t.mock.timers.tick(30 * 60_000);
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2');
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0]!.data?.holds, undefined, "the long wait's own alert, not the run's");
  t.mock.timers.tick(2 * 60 * 60_000 + 1_000);
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer, ending the run');
  assert.equal(alerts().length, 1, 'the run, ended past the hour, raises no second alert');
});

for (const ending of ['answered', 'refused', 'stopped'] as const) {
  test(`each turn's run of stated waits counts from its own first hold (the first turn ${ending})`, async (t) => {
      const second = ending === 'stopped' ? 3 : 4;
    const membrane = new ScriptedMembrane((n) => (n <= 2 || n === second || n === second + 1 ? statedWait(250)
      : n === 3 && ending === 'refused' ? invalidRequest : undefined));
    const r = await resident(t, membrane);
    const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
    r.say('zz-question');
    await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1');
    t.mock.timers.tick(40 * 60_000);
    await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2');
    if (ending === 'stopped') {
      assert.equal(r.fw.abortInference('resident'), true);
      await waitFor(() => r.count('inference:aborted') === 1, 'the stop to end the turn');
      t.mock.timers.tick(1_000);
    } else {
      t.mock.timers.tick(40 * 60_000);
      await waitFor(() => r.count(ending === 'answered' ? 'inference:completed' : 'inference:exhausted') === 1, 'the first turn to end');
    }
    r.say('zz-second');
    for (const held of [second, second + 1]) {
      await waitFor(() => membrane.sends.length === held && r.admission().providerAdmission.heldRequests === 1, `hold at send ${held}`);
      t.mock.timers.tick(40 * 60_000);
    }
    await waitFor(() => r.count('inference:completed') === (ending === 'answered' ? 2 : 1), 'the second turn to answer');
    assert.equal(alerts().length, 0);
  });
}

test("a run that a single wait past the hour has already alerted for gets no second alert from the holds after it", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(2 * 60 * 60_000) : n === 2 ? statedWait(250) : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1');
  assert.equal(alerts().length, 1, "the long wait's own alert");
  t.mock.timers.tick(70 * 60_000);
  r.fw.releaseProviderWait('resident');
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2');
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0]!.data?.holds, undefined, "the long wait's own alert, not the run's");
});

test('by default a turn whose retries ran out is sent again after 2, then 8, then 32 minutes', async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: undefined });
  for (const [n, delay, wake] of [[1, 120_000, 'zz-question'], [2, 480_000, 'zz-second'], [3, 1_920_000, 'zz-third']] as const) {
    const before = Date.now();
    if (n === 1) r.say(wake);
    else queue(r, { reason: wake });
    await waitFor(() => r.count('inference:exhausted') === n, `exhaustion ${n}`);
    const { cooldownUntil, cooldownReason } = r.admission().providerAdmission;
    assert.ok(cooldownUntil !== null && cooldownUntil >= before + delay && cooldownUntil <= Date.now() + delay, `re-arm ${n} waits ${delay} ms`);
    assert.match(cooldownReason ?? '', new RegExp(`\\(${n} of 3\\)`));
  }
});

test('a re-armed turn whose exhausted start was a continuation is a fresh wake: abortInference() leaves it, no turn is alive while it waits, and it makes one send', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 4 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [300, 300] });
  (r.fw as unknown as { pendingRequests: unknown[] }).pendingRequests.push(
    { agentName: 'resident', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
  await waitFor(() => r.count('inference:exhausted') === 1, 'the continuation to end exhausted');
  assert.equal(r.admission().providerAdmission.heldRequests, 1);
  assert.equal(r.fw.getHostModeStatus().drained, true, 'no turn is alive while it waits');
  assert.equal(r.fw.abortInference('resident'), false, 'abortInference() has no turn to end');
  await waitFor(() => r.count('inference:completed') === 1, 'the second re-arm to answer');
  assert.equal(membrane.sends.length, 5, "the window, then each re-arm's one send");
});

test("a re-armed continuation is sent again on its turn's channel", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n >= 2 && n <= 4 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100] });
  const internal = r.fw as unknown as { pendingRequests: unknown[]; turnRouting: Map<string, { triggerChannel?: unknown }> };
  internal.pendingRequests.push({ agentName: 'resident', reason: 'zz-channel-message', source: 'test', timestamp: Date.now(),
    channelId: 'zz-chan', channelServerId: 'zz-srv' });
  await waitFor(() => r.count('inference:completed') === 1, 'the channel turn to answer');
  internal.pendingRequests.push({ agentName: 'resident', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
  await waitFor(() => r.count('inference:completed') === 2, 'the re-armed restart to answer');
  assert.equal(membrane.sends.length, 5, 'the channel turn, the restart\'s window, then the re-armed send');
  assert.deepEqual(internal.turnRouting.get('resident')?.triggerChannel, { serverId: 'zz-srv', channelId: 'zz-chan' });
});

test('a continuation whose turn never found a channel is not re-armed, rather than sent where its turn would not speak', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n >= 2 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100] });
  stderr.length = 0;
  const internal = r.fw as unknown as { pendingRequests: unknown[] };
  internal.pendingRequests.push({ agentName: 'resident', reason: 'zz-channel-message', source: 'test', timestamp: Date.now(),
    channelId: 'zz-no-such-channel' });
  await waitFor(() => r.count('inference:completed') === 1, 'the turn with no channel to answer');
  internal.pendingRequests.push({ agentName: 'resident', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now() });
  await waitFor(() => r.count('inference:exhausted') === 1, 'the restart to end exhausted');
  assert.equal(r.fw.getHostModeStatus().gatedRequests, 0, 'nothing is kept to be sent again');
  assert.equal(r.markers(), 1, 'the agent meets the exhaustion\'s marker');
  assert.equal(membrane.sends.length, 4);
  assert.equal(rearmLines('resident', 'not re-armed', 'guess a channel').length, 1, 'the operator is told why');
});

type Routing = { triggerChannel?: unknown; locus?: unknown };
const routingOf = (r: { fw: unknown }) => (r.fw as { turnRouting: Map<string, Routing> }).turnRouting.get('resident');
const queue = (r: { fw: unknown }, request: Record<string, unknown>) =>
  (r.fw as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: 'resident', source: 'test', timestamp: Date.now(), ...request });

test("a re-armed turn opens where its turn's plain speech was going after a re-pin moved it there, though a newer ambient wake from elsewhere merges with it", async (t) => {
  for (const kind of ['a continuation', 'a wake']) {
    const membrane = new ScriptedMembrane((n) => (n >= 2 && n <= 4 ? serverError : undefined));
    const r = await resident(t, membrane, { exhaustedTurnRearmMs: [60_000] });
    queue(r, { reason: 'zz-channel-message', channelId: 'zz-chan', channelServerId: 'zz-srv' });
    await waitFor(() => r.count('inference:completed') === 1, `${kind}: the channel turn to answer`);
    routingOf(r)!.locus = { serverId: 'zz-srv', channelId: 'zz-dm' };
    if (kind === 'a continuation') queue(r, { reason: 'context_budget_restart', source: 'framework' });
    else (r.fw as unknown as { openLogical: Map<string, unknown> }).openLogical.set('resident', routingOf(r));
    if (kind === 'a wake') queue(r, { reason: 'zz-channel-message', channelId: 'zz-chan', channelServerId: 'zz-srv' });
    await waitFor(() => r.count('inference:exhausted') === 1, `${kind}: the window to end exhausted`);
    queue(r, { reason: 'zz-channel-message', channelId: 'zz-other', channelServerId: 'zz-srv' });
    await waitFor(() => r.count('inference:completed') === 2, `${kind}: the merged turn to answer`);
    assert.deepEqual(routingOf(r)?.triggerChannel, { serverId: 'zz-srv', channelId: 'zz-dm' }, kind);
  }
});

test('a continuation of a turn that found a channel after it had none is re-armed there', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n >= 2 && n <= 4 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100] });
  queue(r, { reason: 'zz-channel-message', channelId: 'zz-no-such-channel' });
  await waitFor(() => r.count('inference:completed') === 1, 'the turn with no channel to answer');
  routingOf(r)!.triggerChannel = { serverId: 'zz-srv', channelId: 'zz-opened' };
  queue(r, { reason: 'context_budget_restart', source: 'framework' });
  await waitFor(() => r.count('inference:completed') === 2, 'the re-armed restart to answer');
  assert.deepEqual(routingOf(r)?.triggerChannel, { serverId: 'zz-srv', channelId: 'zz-opened' });
});

test('a re-armed wake of a turn that never found a channel keeps its own channel id, so it guesses none', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 3 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100] });
  queue(r, { reason: 'zz-channel-message', channelId: 'zz-no-such-channel' });
  await waitFor(() => r.count('inference:completed') === 1, 'the re-armed wake to answer');
  assert.equal(membrane.sends.length, 4);
  assert.equal(routingOf(r)?.triggerChannel, undefined, 'its turn has no channel, as the first had none');
});

test("a re-armed continuation keeps its channel when an ambient wake from another channel takes it in, and names no author", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n >= 2 && n <= 4 ? serverError : undefined));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [60_000] });
  queue(r, { reason: 'zz-channel-message', channelId: 'zz-chan', channelServerId: 'zz-srv', addressed: true, counterparty: 'zz-srv:user:1' });
  await waitFor(() => r.count('inference:completed') === 1, 'the channel turn to answer');
  queue(r, { reason: 'tool_result_guard_retry', source: 'framework', counterparty: 'zz-srv:user:1' });
  await waitFor(() => r.count('inference:exhausted') === 1, 'the retry to end exhausted');
  const held = (r.fw as unknown as { providerAccelerationCooldowns: Map<string, { heldRequests: Array<{ counterparty?: string }> }> })
    .providerAccelerationCooldowns.get('resident')!.heldRequests;
  assert.equal(held[0]!.counterparty, undefined, 'no author');
  queue(r, { reason: 'zz-channel-message', channelId: 'zz-other', channelServerId: 'zz-srv' });
  await waitFor(() => r.count('inference:completed') === 2, 'the merged turn to answer');
  assert.deepEqual(routingOf(r)?.triggerChannel, { serverId: 'zz-srv', channelId: 'zz-chan' });
});

test('an agent ended through the registry takes its re-armed deadline cut with it', async (t) => {
  const r = await resident(t, new ScriptedMembrane(() => undefined), {
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }, { name: 'second', model: 'zz-model', systemPrompt: 'system' }],
  });
  const cuts = (r.fw as unknown as { rearmDeadlineCuts: Set<string> }).rearmDeadlineCuts;
  cuts.add('second');
  r.fw.stopAgent('second', { by: 'test' });
  assert.equal(cuts.has('second'), false);
});

test('stop() drops a turn waiting to be sent again', async (t) => {
  const membrane = new ScriptedMembrane(() => serverError);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [60_000] });
  r.say('zz-question');
  await waitFor(() => r.count('inference:exhausted') === 1, 'the window to end exhausted');
  assert.equal(r.fw.getHostModeStatus().gatedRequests, 1);
  await stepping(r.fw.stop(), 'the framework to stop');
  assert.equal(r.fw.getHostModeStatus().gatedRequests, 0);
});

test("a hold of a turn's wake before its first call counts in no run", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 2 ? statedWait(250) : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  (r.fw as unknown as { providerWaits: { set(a: string, m: string, ms: number, why: string): unknown } }).providerWaits.set('resident', 'zz-model', 250, 'zz recorded wait');
  r.say('zz-question');
  await waitFor(() => r.admission().providerAdmission.heldRequests === 1, 'the wake held at admission');
  t.mock.timers.tick(40 * 60_000);
  for (const held of [1, 2]) {
    await waitFor(() => membrane.sends.length === held && r.admission().providerAdmission.heldRequests === 1, `hold ${held}`);
    t.mock.timers.tick(30 * 60_000);
  }
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer');
  assert.equal(alerts().length, 0, "the turn's own failed calls held it 30 min");
});

test("a turn ended by a throw outside its stream's failure handling ends its run", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 || n === 2 ? statedWait(250) : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  const internal = r.fw as unknown as { recordTurnCheckpoint: (name: string) => void };
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1');
  const record = internal.recordTurnCheckpoint;
  internal.recordTurnCheckpoint = () => { internal.recordTurnCheckpoint = record; throw new Error('zz checkpoint fault'); };
  t.mock.timers.tick(70 * 60_000);
  await waitFor(() => r.admission().providerAdmission.heldRequests === 0 && internal.recordTurnCheckpoint === record, 'the retry to start and throw');
  r.say('zz-second');
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'the next turn held');
  assert.equal(alerts().length, 0, "the next turn's run starts with it");
});

test('a run whose latest hold ran past the hour, with no later hold to alert at, alerts when its turn ends', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(250) : n === 2 ? statedWait(50 * 60_000) : undefined));
  const r = await resident(t, membrane);
  const internal = r.fw as unknown as { providerHoldTimerMs: (ms: number) => number };
  internal.providerHoldTimerMs = (ms) => Math.min(ms, 200);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1');
  t.mock.timers.tick(20 * 60_000);
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2, of 50 min');
  t.mock.timers.tick(51 * 60_000);
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer');
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0]!.data?.holds, 2);
  assert.match(String(alerts()[0]!.message), /2 stated waits in a row on \S+ span 70 min since /, 'measured to the end of its latest hold');
});

test('a run ended under the hour, though its latest wait would have run past it, raises nothing', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(40 * 60_000) : n === 2 ? statedWait(50 * 60_000) : undefined));
  const r = await resident(t, membrane);
  const internal = r.fw as unknown as { providerHoldTimerMs: (ms: number) => number };
  internal.providerHoldTimerMs = (ms) => Math.min(ms, 200);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1, of 40 min');
  t.mock.timers.tick(40 * 60_000 + 1_000);
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2, of 50 min');
  t.mock.timers.tick(5 * 60_000);
  assert.equal(r.fw.abortInference('resident'), true, 'the held turn is stopped at minute 45');
  await waitFor(() => r.count('inference:aborted') === 1, 'the stopped turn to end');
  assert.equal(alerts().length, 0);
});

test('a stated wait released early counts in its run only to its release', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(40 * 60_000) : n === 2 ? statedWait(50 * 60_000) : n === 3 ? 'held open' : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1, of 40 min');
  t.mock.timers.tick(40 * 60_000 + 1_000);
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2, of 50 min');
  t.mock.timers.tick(60_000);
  assert.equal(r.fw.releaseProviderWait('resident', undefined, 'zz-operator').length, 1, 'the operator releases the wait at minute 41');
  await waitFor(() => membrane.sends.length === 3, 'the released turn to send, its stream held open');
  t.mock.timers.tick(30 * 60_000);
  membrane.letGo();
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer at minute 71');
  assert.equal(alerts().length, 0, 'held 41 min by stated waits, though the released one would have run to minute 91');
});

test("a release of another model's wait leaves the run's own wait counting", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(40 * 60_000) : n === 2 ? statedWait(50 * 60_000) : undefined));
  const r = await resident(t, membrane);
  const internal = r.fw as unknown as { providerWaits: { set(agent: string, model: string, ms: number, why: string): unknown } };
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1, of 40 min');
  t.mock.timers.tick(40 * 60_000 + 1_000);
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'hold 2, of 50 min');
  t.mock.timers.tick(4 * 60_000);
  internal.providerWaits.set('resident', 'zz-other-model', 10 * 60_000, 'zz an auxiliary model\'s wait');
  assert.equal(r.fw.releaseProviderWait('resident', 'zz-other-model', 'zz-operator').length, 1, "the operator releases the other model's wait at minute 45");
  t.mock.timers.tick(47 * 60_000);
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer after its own wait');
  assert.equal(alerts().length, 1, "held 91 min by its own model's waits");
});

test('a round that runs ends the run of stated waits before it', async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? statedWait(250) : n === 2 ? 'tool round, then a stated wait' : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  r.say('zz-question');
  await waitFor(() => membrane.sends.length === 1 && r.admission().providerAdmission.heldRequests === 1, 'hold 1');
  t.mock.timers.tick(61 * 60_000);
  await waitFor(() => membrane.sends.length === 2 && r.admission().providerAdmission.heldRequests === 1, 'the hold after a round ran');
  t.mock.timers.tick(1_000);
  await waitFor(() => r.count('inference:completed') === 1, 'the turn to answer');
  assert.equal(alerts().length, 0, 'the hold after the round starts a run of its own');
});

test("a silent turn's held retries keep one run", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n <= 4 ? statedWait(250) : undefined));
  const r = await resident(t, membrane);
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  queue(r, { reason: 'zz-silent-tick', suppressProse: true });
  for (let held = 1; held <= 4; held++) {
    await waitFor(() => membrane.sends.length === held && r.admission().providerAdmission.heldRequests === 1, `hold ${held}`);
    t.mock.timers.tick(25 * 60_000);
  }
  await waitFor(() => r.count('inference:completed') === 1, 'the silent turn to end');
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0]!.data?.holds, 4);
});

// The branch's (feat/dendrite): releaseAgentRuntime, the one release of an
// ended agent that isn't a run (stopAgent, a cascaded end, a fork's dispose),
// drops this per-name turn state, so a new agent under the name starts clean.
test("a resident stopped mid-turn takes its turn state with it: its run of stated waits ends at the stop, and a new agent under its name re-arms from the first delay with a plain marker", async (t) => {
  const { workerSpec } = await import('../src/index.js');
  // `second`'s window ends exhausted on server errors (sends 1 to 3); its
  // re-arm's send and the next are held by stated waits (4 and 5), and the
  // one after that is in flight when it is stopped (6), so no held turn is
  // left for the stop to drop. The new agent's window ends exhausted on
  // server errors (7 on).
  const membrane = new ScriptedMembrane((n) => (n === 4 || n === 5 ? statedWait(40 * 60_000) : n === 6 ? 'held open' : serverError));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: [100, 100], agents: [
    { name: 'resident', model: 'zz-model', systemPrompt: 'system' }, { name: 'second', model: 'zz-model', systemPrompt: 'system' }] });
  const state = r.fw as unknown as {
    turnRearms: Map<string, number>; exhaustingRearms: Set<string>; exhaustedTurns: Map<string, unknown>; statedWaitRuns: Map<string, unknown>;
  };
  const kept = () => ({
    rearms: state.turnRearms.has('second'), exhaustingRearm: state.exhaustingRearms.has('second'),
    exhaustedTurn: state.exhaustedTurns.has('second'), statedWaits: state.statedWaitRuns.has('second'),
  });
  const alerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'provider-wait');
  const held = () => ((r.fw.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { heldRequests: number } }> })
    .agents.find((a) => a.name === 'second')!).providerAdmission.heldRequests;
  queue(r, { agentName: 'second', reason: 'zz-wake' });
  await waitFor(() => r.count('inference:exhausted') === 1 && held() === 1, "second's window to end exhausted, its re-arm held");
  await waitFor(() => membrane.sends.length === 4 && held() === 1, "the re-arm's send to be held by a stated wait");
  t.mock.timers.tick(40 * 60_000);
  await waitFor(() => membrane.sends.length === 5 && held() === 1, 'the next send to be held, 40 minutes on');
  t.mock.timers.tick(40 * 60_000);
  await waitFor(() => membrane.sends.length === 6 && held() === 0, 'the send after it to be in flight, 80 minutes from the first hold');
  // Neither of these outlives a turn by itself: a failure sets each and the
  // exhaustion it raises reads it at once. Set here as such a failure sets
  // them, so the release's clear of each is pinned too.
  state.exhaustingRearms.add('second');
  state.exhaustedTurns.set('second', { roundsRan: true, callsCutOff: false, liveSpeech: false, speechRouting: false });
  assert.deepEqual(kept(), { rearms: true, exhaustingRearm: true, exhaustedTurn: true, statedWaits: true }, 'the premise: each is held for second');
  assert.equal(alerts().length, 0, 'the premise: no hold came past the hour');

  r.fw.stopAgent('second', { by: 'zz-operator' });
  assert.deepEqual(kept(), { rearms: false, exhaustingRearm: false, exhaustedTurn: false, statedWaits: false }, 'the release drops each');
  assert.equal(alerts().length, 1, 'the run of stated waits ends at the stop, alerted as it spanned past the hour');
  assert.equal(alerts()[0]!.data?.holds, 2);

  t.mock.timers.tick(60_000);
  stderr.length = 0;
  const spec = workerSpec('second');
  const { name: _name, ...body } = { ...spec, roles: { ...spec.roles, ownsProviderScheduling: true } };
  const fresh = await r.fw.createEphemeralAgent({ name: 'second', model: 'zz-model', systemPrompt: 'system' }, body);
  fresh.contextManager.addMessage('User', [{ type: 'text', text: 'zz-fresh' }]);
  const ended = await stepping(r.fw.runEphemeralToCompletion(fresh.agent, fresh.contextManager).then(() => null, (error: unknown) => error),
    "the new agent's run to end");
  assert.ok(ended instanceof Error, 'its window ended exhausted');
  assert.equal(membrane.sends.length, 9, "the new agent's window made its three sends");
  assert.ok(stderr.includes('[inference-rearm] agent=second turn sent again in 100ms (1 of 2)'),
    `its re-arm is the first: ${stderr.filter((line) => line.includes('[inference-rearm]')).join(' | ')}`);
  const markers = fresh.contextManager.getAllMessages().flatMap((m) => m.content)
    .map((b) => (b as { text?: string }).text ?? '').filter((text) => text.startsWith('[inference-failed]'));
  assert.equal(markers.length, 1, 'it meets its outage with a marker');
  assert.match(markers[0]!, /the model call failed \(server, HTTP 502\) and produced no response, so nothing was sent/, 'one that says its own turn got nowhere');
  assert.equal(alerts().length, 1, 'and no run of stated waits is ended with it but its own');
});

test('a resident stopped with a failure streak takes its failure accounting with it: a new agent under its name meets its first refused request as its first', async (t) => {
  const { workerSpec } = await import('../src/index.js');
  const membrane = new ScriptedMembrane(() => invalidRequest);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false, agents: [
    { name: 'resident', model: 'zz-model', systemPrompt: 'system' }, { name: 'second', model: 'zz-model', systemPrompt: 'system' }] });
  const streak = () => ((r.fw.healthSnapshot() as { agents: Array<{ name: string; consecutiveInferenceFailures: number }> })
    .agents.find((a) => a.name === 'second')!).consecutiveInferenceFailures;
  for (const n of [1, 2]) {
    queue(r, { agentName: 'second', reason: 'zz-wake' });
    await waitFor(() => r.count('inference:exhausted') === n, `second's turn ${n} to end exhausted`);
  }
  assert.equal(streak(), 2, 'the premise: second has failed two turns running');
  const state = r.fw as unknown as {
    exhaustionRewinds: Map<string, number>; refusalStreak: Map<string, number>; refusalRewinds: Map<string, number>; rewindEpisode: Map<string, unknown>;
    freshCallsCut: Set<string>; forcedRewind: Map<string, unknown>;
  };
  state.exhaustionRewinds.set('second', 3);
  state.freshCallsCut.add('second');
  state.forcedRewind.set('second', { remaining: 2, removed: [] });
  state.refusalStreak.set('second', 1);
  state.refusalRewinds.set('second', 1);
  state.rewindEpisode.set('second', { markerId: 'zz-marker', count: 1, category: 'zz-category' });
  r.fw.stopAgent('second', { by: 'zz-operator' });
  assert.deepEqual({
    rewinds: state.exhaustionRewinds.has('second'), refusalStreak: state.refusalStreak.has('second'),
    refusalRewinds: state.refusalRewinds.has('second'), episode: state.rewindEpisode.has('second'), freshCall: state.freshCallsCut.has('second'),
    unstick: state.forcedRewind.has('second'),
  }, { rewinds: false, refusalStreak: false, refusalRewinds: false, episode: false, freshCall: false, unstick: false }, 'the release drops each');
  assert.ok(stderr.some((line) => line.startsWith('[unstick] agent=second') && line.includes('ended with its agent')), 'and says the /unstick session ended with it');

  stderr.length = 0;
  const spec = workerSpec('second');
  const { name: _name, ...body } = { ...spec, roles: { ...spec.roles, ownsProviderScheduling: true } };
  const fresh = await r.fw.createEphemeralAgent({ name: 'second', model: 'zz-model', systemPrompt: 'system' }, body);
  fresh.contextManager.addMessage('User', [{ type: 'text', text: 'zz-fresh' }]);
  const ended = await stepping(r.fw.runEphemeralToCompletion(fresh.agent, fresh.contextManager).then(() => null, (error: unknown) => error),
    "the new agent's run to end");
  assert.ok(ended instanceof Error, 'its request is refused');
  assert.ok(stderr.includes('[inference-failed] agent=second consecutive=1 type=invalid_request status=400: zz invalid_request failure'),
    `its first failure is its first: ${stderr.filter((line) => line.includes('agent=second')).join(' | ')}`);
  assert.ok(!stderr.some((line) => line.startsWith('[inference-hard-down] agent=second')), 'it is not hard-down');
  assert.equal(r.traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === 'hard-down').length, 0, 'and no hard-down alert is raised');
  const kept = fresh.contextManager.getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
  assert.ok(kept.includes('zz-fresh'), 'and its own message is kept');
  assert.ok(kept.some((text) => text.startsWith('[inference-failed]')) && !kept.some((text) => text.includes('The call was made again')),
    'and its failure note says nothing of a call made again');
});

test("a job its own run ended keeps its failure streak when it is resumed under its name, with the same history", async (t) => {
  const membrane = new ScriptedMembrane(() => invalidRequest);
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  stderr.length = 0;
  const config = { model: 'zz-model', systemPrompt: 'system' };
  const first = await r.fw.createEphemeralAgent({ name: 'job', ...config });
  first.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  await stepping(r.fw.runEphemeralToCompletion(first.agent, first.contextManager).then(() => null, (error: unknown) => error), "the job's run to end");
  const resumed = await r.fw.resumeAgent('job', config);
  resumed.contextManager.addMessage('User', [{ type: 'text', text: 'zz-again' }]);
  await stepping(r.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager).then(() => null, (error: unknown) => error), "the resume's run to end");
  const failed = stderr.filter((line) => line.startsWith('[inference-failed] agent=job consecutive='));
  assert.deepEqual(failed.map((line) => line.match(/consecutive=(\d+)/)![1]), ['1', '2'], 'its resume counts on from its run');
  const history = resumed.contextManager.getAllMessages().flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');
  assert.ok(history.includes('zz-task'), "over the run's own history");
});

for (const end of ['stopped', 'cancelled'] as const) test(`a job ${end} while its run is in flight takes its failure accounting and its /unstick session with it: a resume meets its first refused request as its first`, async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? 'held open' : invalidRequest));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  const config = { model: 'zz-model', systemPrompt: 'system' };
  const first = await r.fw.createEphemeralAgent({ name: 'job', ...config });
  first.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  const run = r.fw.runEphemeralToCompletion(first.agent, first.contextManager).then(() => null, (error: unknown) => error);
  await waitFor(() => membrane.sends.length === 1, "the job's call to be in flight");
  const state = r.fw as unknown as {
    consecutiveInferenceFailures: Map<string, number>; exhaustionRewinds: Map<string, number>; refusalStreak: Map<string, number>;
    refusalRewinds: Map<string, number>; rewindEpisode: Map<string, unknown>; forcedRewind: Map<string, unknown>;
  };
  state.consecutiveInferenceFailures.set('job', 2);
  state.exhaustionRewinds.set('job', 3);
  state.refusalStreak.set('job', 1);
  state.refusalRewinds.set('job', 1);
  state.rewindEpisode.set('job', { markerId: 'zz-marker', count: 1, category: 'zz-category' });
  state.forcedRewind.set('job', { remaining: 2, removed: [] });
  if (end === 'stopped') r.fw.stopAgent('job', { by: 'zz-operator' });
  else r.fw.cancelActivation('job', { by: 'zz-operator' });
  await stepping(run, `the ${end} job's run to end`);
  assert.deepEqual({
    streak: state.consecutiveInferenceFailures.has('job'), rewinds: state.exhaustionRewinds.has('job'), refusalStreak: state.refusalStreak.has('job'),
    refusalRewinds: state.refusalRewinds.has('job'), episode: state.rewindEpisode.has('job'), unstick: state.forcedRewind.has('job'),
  }, { streak: false, rewinds: false, refusalStreak: false, refusalRewinds: false, episode: false, unstick: false }, "the run's end drops each, as the release does");
  assert.ok(stderr.some((line) => line.startsWith('[unstick] agent=job') && line.includes('ended with its agent')), 'and says the /unstick session ended with it');
  stderr.length = 0;
  const resumed = await r.fw.resumeAgent('job', config);
  resumed.contextManager.addMessage('User', [{ type: 'text', text: 'zz-again' }]);
  await stepping(r.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager).then(() => null, (error: unknown) => error), "the resume's run to end");
  assert.ok(stderr.includes('[inference-failed] agent=job consecutive=1 type=invalid_request status=400: zz invalid_request failure'),
    `its first failure is its first: ${stderr.filter((line) => line.includes('agent=job')).join(' | ')}`);
});

function refusal(): NormalizedResponse {
  return {
    ...createMockResponse([], 'refusal'),
    content: [], stopReason: 'refusal', toolCalls: [], rawAssistantText: '',
    usage: { inputTokens: 40, outputTokens: 0 },
    details: {
      stop: { reason: 'refusal', wasTruncated: false },
      usage: { inputTokens: 40, outputTokens: 0 },
      timing: { totalDurationMs: 100, attempts: 1 },
      model: { requested: 'zz-model', actual: 'zz-model', provider: 'mock' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
    },
    raw: { request: {}, response: { stop_details: { category: 'reasoning_extraction' } } },
  } as unknown as NormalizedResponse;
}

class RefusingMembrane extends ScriptedMembrane {
  constructor() { super(() => undefined); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    super.streamYielding(request);
    return new MockYieldingStream([refusal()]);
  }
}

test("a resident stopped after a refusal takes its refusal streak with it: a new agent's first refusal raises no refusal-streak alert", async (t) => {
  const { workerSpec } = await import('../src/index.js');
  const membrane = new RefusingMembrane();
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false, agents: [
    { name: 'resident', model: 'zz-model', systemPrompt: 'system' }, { name: 'second', model: 'zz-model', systemPrompt: 'system' }] });
  const streakAlerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && String(tr.message ?? '').startsWith('refusal streak'));
  queue(r, { agentName: 'second', reason: 'zz-wake' });
  await waitFor(() => stderr.some((line) => line.startsWith('[inference-refusal] agent=second')), "second's refusal");
  assert.equal(streakAlerts().length, 0, 'the premise: one refusal raises no streak alert');
  assert.equal((r.fw as unknown as { refusalStreak: Map<string, number> }).refusalStreak.get('second'), 1, 'and leaves a streak of 1');
  r.fw.stopAgent('second', { by: 'zz-operator' });
  stderr.length = 0;
  const spec = workerSpec('second');
  const { name: _name, ...body } = { ...spec, roles: { ...spec.roles, ownsProviderScheduling: true } };
  const fresh = await r.fw.createEphemeralAgent({ name: 'second', model: 'zz-model', systemPrompt: 'system' }, body);
  fresh.contextManager.addMessage('User', [{ type: 'text', text: 'zz-fresh' }]);
  await stepping(r.fw.runEphemeralToCompletion(fresh.agent, fresh.contextManager).then(() => null, (error: unknown) => error), "the new agent's run to end");
  assert.ok(stderr.some((line) => line.startsWith('[inference-refusal] agent=second')), 'the new agent is refused');
  assert.equal(streakAlerts().length, 0, 'and its first refusal raises no streak alert');
});

test("a job's own run's end takes its fresh-call mark with it, so a resume's first failure note says nothing of a call made again", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 1 ? undefined : invalidRequest));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  const config = { model: 'zz-model', systemPrompt: 'system' };
  const first = await r.fw.createEphemeralAgent({ name: 'job', ...config });
  first.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  (r.fw as unknown as { freshCallsCut: Set<string> }).freshCallsCut.add('job');
  await stepping(r.fw.runEphemeralToCompletion(first.agent, first.contextManager), "the job's run to answer and end");
  const resumed = await r.fw.resumeAgent('job', config);
  resumed.contextManager.addMessage('User', [{ type: 'text', text: 'zz-again' }]);
  await stepping(r.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager).then(() => null, (error: unknown) => error), "the resume's run to end");
  const notes = resumed.contextManager.getAllMessages().flatMap((m) => m.content)
    .map((b) => (b as { text?: string }).text ?? '').filter((text) => text.startsWith('[inference-failed]'));
  assert.equal(notes.length, 1, "the resume's refused request gets its note");
  assert.ok(!notes[0]!.includes('The call was made again'), `which says nothing of a call made again: ${notes[0]}`);
});

test('a job whose own run ended on a refusal keeps its refusal streak when it is resumed: its next refusal is its second', async (t) => {
  const { workerSpec } = await import('../src/index.js');
  const membrane = new RefusingMembrane();
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  const streakAlerts = () => r.traces.filter((tr) => tr.type === 'ops:alert' && String(tr.message ?? '').startsWith('refusal streak 2'));
  const config = { model: 'zz-model', systemPrompt: 'system' };
  const { name: _name, ...body } = workerSpec('job');
  const first = await r.fw.createEphemeralAgent({ name: 'job', ...config }, body);
  first.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  await stepping(r.fw.runEphemeralToCompletion(first.agent, first.contextManager).then(() => null, (error: unknown) => error), "the job's run to end");
  assert.ok(stderr.some((line) => line.startsWith('[inference-refusal] agent=job')), 'the premise: its run ended on a refusal');
  assert.equal(streakAlerts().length, 0, 'which raised no streak alert');
  const resumed = await r.fw.resumeAgent('job', config);
  resumed.contextManager.addMessage('User', [{ type: 'text', text: 'zz-again' }]);
  await stepping(r.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager).then(() => null, (error: unknown) => error), "the resume's run to end");
  assert.equal(streakAlerts().length, 1, "the resume's refusal is its second");
});

test('a job whose own run its deadline ended keeps its failure streak when it is resumed', async (t) => {
  const { workerSpec } = await import('../src/index.js');
  const membrane = new ScriptedMembrane((n) => (n === 1 ? 'held open' : invalidRequest));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  const config = { model: 'zz-model', systemPrompt: 'system' };
  const { name: _name, ...body } = workerSpec('job', { deadlineMs: 1_000 });
  const first = await r.fw.createEphemeralAgent({ name: 'job', ...config }, body);
  first.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  const run = r.fw.runEphemeralToCompletion(first.agent, first.contextManager).then(() => null, (error: unknown) => error);
  await waitFor(() => membrane.sends.length === 1, "the job's call to be in flight");
  (r.fw as unknown as { consecutiveInferenceFailures: Map<string, number> }).consecutiveInferenceFailures.set('job', 2);
  const ended = await stepping(run, "the job's deadline to end its run");
  assert.match(String((ended as Error | null)?.message ?? ''), /deadline/, 'the premise: its deadline ended it');
  stderr.length = 0;
  const resumed = await r.fw.resumeAgent('job', config);
  resumed.contextManager.addMessage('User', [{ type: 'text', text: 'zz-again' }]);
  await stepping(r.fw.runEphemeralToCompletion(resumed.agent, resumed.contextManager).then(() => null, (error: unknown) => error), "the resume's run to end");
  assert.ok(stderr.some((line) => line.startsWith('[inference-failed] agent=job consecutive=3 ')),
    `its resume counts on from its run: ${stderr.filter((line) => line.includes('agent=job')).join(' | ')}`);
});

test("a job's turn aborted from outside ends its run without clearing its failure accounting or adding to its streak: its resume counts on from its own failures", async (t) => {
  const membrane = new ScriptedMembrane((n) => (n === 2 ? 'held open' : invalidRequest));
  const r = await resident(t, membrane, { exhaustedTurnRearmMs: false });
  stderr.length = 0;
  const config = { model: 'zz-model', systemPrompt: 'system' };
  const ran = async (agent: { agent: Parameters<typeof r.fw.runEphemeralToCompletion>[0]; contextManager: Parameters<typeof r.fw.runEphemeralToCompletion>[1] }, what: string) =>
    stepping(r.fw.runEphemeralToCompletion(agent.agent, agent.contextManager).then(() => null, (error: unknown) => error), what);
  const first = await r.fw.createEphemeralAgent({ name: 'job', ...config });
  first.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  await ran(first, "the job's first run to fail");
  const second = await r.fw.resumeAgent('job', config);
  second.contextManager.addMessage('User', [{ type: 'text', text: 'zz-again' }]);
  const aborted = ran(second, "the aborted run to end");
  await waitFor(() => membrane.sends.length === 2, "the resumed job's call to be in flight");
  assert.equal(r.fw.abortInference('job', 'zz-operator abort'), true, 'the abort finds the call');
  await aborted;
  const third = await r.fw.resumeAgent('job', config);
  third.contextManager.addMessage('User', [{ type: 'text', text: 'zz-once-more' }]);
  await ran(third, "the third run to fail");
  const failed = stderr.filter((line) => line.startsWith('[inference-failed] agent=job consecutive='));
  assert.deepEqual(failed.map((line) => line.match(/consecutive=(\d+)/)![1]), ['1', '2'], 'the abort is neither an end from outside nor a failure');
});
