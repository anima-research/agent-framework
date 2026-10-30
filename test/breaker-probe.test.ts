import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { PassthroughStrategy } from '@animalabs/context-manager';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: '' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: !String(event.content).startsWith('zz-quiet'),
    };
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

class ThrowingStream extends ErrorStream {
  constructor(private readonly thrown: Error) { super(thrown); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.thrown;
  }
}

const WALK4 = 'OpenAI Codex backend does not support max_output_tokens; OrcaRouter will not silently ignore it';
const providerError = (type: string, httpStatus: number, message: string, retryable = false) => new MembraneError({
  type, httpStatus, retryable, providerErrorCode: `${type}_error`, message, rawError: undefined,
} as never);
const walk4 = (type = 'invalid_request') => providerError(type, 400, WALK4);

const texts = (request: NormalizedRequest) => request.messages.flatMap((m) => m.content)
  .map((b) => (b as { text?: string }).text ?? '').filter((t) => t.startsWith('zz-'));

type ProbeAnswer = 'answered' | 'aborted' | Error | Promise<'answered' | Error>;

class StandIn extends MockMembrane {
  readonly sends: string[][] = [];
  readonly sent: NormalizedRequest[] = [];
  readonly probes: NormalizedRequest[] = [];
  readonly probeOptions: Array<{ retry?: boolean; signal?: AbortSignal }> = [];
  readonly receipts: string[] = [];
  constructor(
    private readonly fails: (request: NormalizedRequest, send: number) => Error | undefined,
    private readonly probe: (n: number) => ProbeAnswer = () => 'answered',
    private readonly failsBy: 'event' | 'throw' = 'event',
  ) { super(); }
  private receipt(request: NormalizedRequest, of: string): void {
    const hook = (request as { onCacheWireReceipt?: (receipt: unknown) => void }).onCacheWireReceipt;
    if (hook) { this.receipts.push(of); hook({ requestHash: `zz-${of}`, markers: [] }); }
  }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.sends.push(texts(request));
    this.sent.push(request);
    this.receipt(request, `send-${this.sends.length}`);
    const error = this.fails(request, this.sends.length);
    if (error) return this.failsBy === 'throw' ? new ThrowingStream(error) : new ErrorStream(error);
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.sends.length}` }])]);
  }
  override async complete(request: NormalizedRequest, options: { retry?: boolean; signal?: AbortSignal } = {}): Promise<NormalizedResponse> {
    this.probes.push(request);
    this.probeOptions.push(options);
    this.receipt(request, `probe-${this.probes.length}`);
    const aborted = new Promise<Error>((resolve) => {
      options.signal?.addEventListener('abort', () => resolve(new Error('zz the probe was aborted')), { once: true });
    });
    const answer = await Promise.race([this.probe(this.probes.length), aborted]);
    if (answer instanceof Error) throw answer;
    if (answer === 'aborted') return { aborted: true, reason: 'timeout' } as unknown as NormalizedResponse;
    return createMockResponse([{ type: 'text', text: 'ok' }]);
  }
}

class KvPassthrough extends PassthroughStrategy {
  readonly begun: string[] = [];
  isKvUnifiedEnabled(): boolean { return true; }
  beginKvUnifiedSubmission(args: { requestHash: string }): void { this.begun.push(args.requestHash); }
  reportKvUnifiedAccepted(): void {}
  reportKvUnifiedFailed(): void {}
}

const stderr: string[] = [];
console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

type Trace = { type: string; kind?: string; message?: string; data?: Record<string, unknown>; [key: string]: unknown };

async function resident(t: TestContext, membrane: StandIn, strategy?: PassthroughStrategy) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const until = async (done: () => boolean, what: string) => {
    await settle();
    for (let ms = 0; !done(); ms += 5) {
      if (ms > 2 * 60_000) throw new Error(`zz-timeout: ${what} did not happen within 2 min of the mocked clock`);
      t.mock.timers.tick(5);
      await settle();
    }
  };
  const quiet = async (ms: number) => { for (let at = 0; at < ms; at += 50) { t.mock.timers.tick(50); await settle(); } };
  const dir = mkdtempSync(join(tmpdir(), 'breaker-probe-'));
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system', ...(strategy ? { strategy } : {}) }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  } as never);
  const traces: Trace[] = [];
  fw.onTrace((e) => { traces.push(e as unknown as Trace); });
  t.after(async () => {
    let stopped = false;
    void fw.stop().catch(() => {}).finally(() => { stopped = true; });
    await until(() => stopped, 'the framework to stop');
    t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });
  fw.start();
  const count = (type: string) => traces.filter((tr) => tr.type === type).length;
  const say = (text: string) => fw.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} });
  const wake = () => (fw as unknown as { pendingRequests: unknown[] }).pendingRequests
    .push({ agentName: 'resident', source: 'test', reason: 'zz-wake', timestamp: Date.now() });
  const history = () => fw.getAgent('resident')!.getContextManager().getAllMessages()
    .filter((m) => !(m.metadata as { system?: unknown } | undefined)?.system)
    .flatMap((m) => m.content.map((b) => (b as { text?: string }).text ?? '')).filter((x) => x.startsWith('zz-'));
  const rewindMarkers = () => fw.getAgent('resident')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata as { kind?: unknown } | undefined)?.kind === 'refusal-rewind').length;
  const alerts = (kind: string) => traces.filter((tr) => tr.type === 'ops:alert' && tr.kind === kind);
  say('zz-q1');
  await until(() => count('inference:completed') === 1, 'q1 to be answered');
  say('zz-q2');
  await until(() => count('inference:completed') === 2, 'q2 to be answered');
  return { fw, traces, count, say, wake, history, rewindMarkers, alerts, until, quiet };
}

const failsFromThird = (error: () => Error) => (_request: NormalizedRequest, send: number) => (send >= 3 ? error() : undefined);

for (const failsBy of ['event', 'throw'] as const) {
  test(`a configuration the provider rejects with or without history costs no history: three messages in a row each stay, and the alert says the request fails without its history (the stream's failure ${failsBy === 'throw' ? 'thrown' : 'reported'})`, async (t) => {
    const membrane = new StandIn(failsFromThird(walk4), () => walk4(), failsBy);
    const r = await resident(t, membrane);
    for (const [i, text] of ['zz-q3', 'zz-q4', 'zz-q5'].entries()) {
      r.say(text);
      await r.until(() => r.count('inference:exhausted') === i + 1, `${text}'s turn to fail`);
    }
    await r.until(() => r.alerts('history-kept').length === 1, 'the breaker to say it kept the history');
    await r.quiet(60_000);
    assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3', 'zz-q4', 'zz-q5'], 'every message stays');
    assert.equal(r.rewindMarkers(), 0, 'no marker blames the history');
    assert.equal(membrane.sends.length, 2 + 3, 'one send per turn, and no rewind retry');
    assert.equal(membrane.probes.length, 1, 'one probe, at the hard-down threshold');
    assert.deepEqual(membrane.probes[0]!.messages.map((m) => m.content.length), [1], 'the probe carries one message in place of the history');
    assert.deepEqual(texts(membrane.probes[0]!), [], 'none of the history goes in the probe');
    assert.equal(membrane.probes[0]!.config.model, 'zz-model');
    const alert = r.alerts('history-kept')[0]!;
    assert.match(String(alert.message), /fails without its history too/);
    assert.ok(String(alert.message).includes(WALK4), "the alert gives the probe's own reason");
    assert.ok(r.traces.filter((tr) => tr.type === 'inference:exhausted').every((tr) => !('request' in tr)), 'the failed request stays off the trace');
    assert.ok(stderr.some((line) => line.startsWith('[inference-rewind] agent=resident kept its history: the request fails without its history too')
      && line.includes(WALK4)), 'the stderr line says so, with the probe\'s answer');
    const failed = membrane.sent.at(-1)!;
    const probe = membrane.probes[0]!;
    for (const [field, value] of Object.entries(failed)) {
      if (field === 'messages' || field === 'onCacheWireReceipt') continue;
      assert.deepEqual((probe as unknown as Record<string, unknown>)[field], value, `the probe carries the failed request's ${field}`);
    }
    assert.deepEqual(Object.keys(probe).filter((field) => field !== 'messages' && !(field in failed)), [], 'and nothing the failed request lacks');
    assert.notEqual(probe.messages[0]!.participant, failed.assistantParticipant, "the probe's message is the other side's");
    assert.equal(membrane.probeOptions[0]!.retry, false, "membrane's own retries are off for the probe");
  });
}

test('one message and then two wakes: the good history before the message stays too', async (t) => {
  const membrane = new StandIn(failsFromThird(walk4), () => walk4());
  const r = await resident(t, membrane);
  r.say('zz-q3');
  await r.until(() => r.count('inference:exhausted') === 1, "q3's turn to fail");
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 2, 'the first wake to fail');
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 3, 'the second wake to fail');
  await r.until(() => r.alerts('history-kept').length === 1, 'the breaker to say it kept the history');
  await r.quiet(60_000);
  assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3']);
  assert.equal(r.rewindMarkers(), 0);
  assert.equal(membrane.sends.length, 2 + 3);
});

test('a failure the breaker leaves alone sends no probe and sheds nothing', async (t) => {
  const membrane = new StandIn(failsFromThird(() => walk4('unsupported')));
  const r = await resident(t, membrane);
  for (const [i, text] of ['zz-q3', 'zz-q4', 'zz-q5'].entries()) {
    r.say(text);
    await r.until(() => r.count('inference:exhausted') === i + 1, `${text}'s turn to fail`);
  }
  await r.quiet(60_000);
  assert.equal(membrane.probes.length, 0);
  assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3', 'zz-q4', 'zz-q5']);
  assert.equal(r.alerts('history-kept').length, 0);
});

test('a row the provider refuses is still shed: the probe is answered, the row goes, and the retry without it is answered', async (t) => {
  const poisoned = (request: NormalizedRequest) => (texts(request).includes('zz-poison')
    ? providerError('invalid_request', 400, 'tool_use ids must have a corresponding tool_result') : undefined);
  const membrane = new StandIn(poisoned);
  const r = await resident(t, membrane);
  r.say('zz-poison');
  await r.until(() => r.count('inference:exhausted') === 1, "the poisoned turn to fail");
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 2, 'the first wake to fail');
  r.wake();
  await r.until(() => r.count('inference:completed') === 3, 'the retry without the row to be answered');
  assert.equal(membrane.probes.length, 1);
  assert.deepEqual(r.history().filter((x) => !x.startsWith('zz-answer-')), ['zz-q1', 'zz-q2']);
  assert.equal(r.rewindMarkers(), 1);
  assert.ok(!membrane.sends.at(-1)!.includes('zz-poison'), 'the retry went without the row');
});

test("a probe that can't tell, answered 429, sheds nothing, and the alert says the probe couldn't tell", async (t) => {
  const membrane = new StandIn(failsFromThird(walk4), () => providerError('rate_limit', 429, 'zz rate limited', true));
  const r = await resident(t, membrane);
  for (const [i, text] of ['zz-q3', 'zz-q4', 'zz-q5'].entries()) {
    r.say(text);
    await r.until(() => r.count('inference:exhausted') === i + 1, `${text}'s turn to fail`);
  }
  await r.until(() => r.alerts('history-kept').length === 1, 'the breaker to say it kept the history');
  await r.quiet(60_000);
  assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3', 'zz-q4', 'zz-q5']);
  assert.equal(r.rewindMarkers(), 0);
  const alert = r.alerts('history-kept')[0]!;
  assert.match(String(alert.message), /couldn't tell/);
  assert.ok(String(alert.message).includes('zz rate limited'), "the alert gives the probe's own reason");
  assert.ok(stderr.some((line) => line.startsWith("[inference-rewind] agent=resident kept its history: a probe without its history couldn't tell")
    && line.includes('zz rate limited')), "the stderr line says so, with the probe's answer");
});

for (const [what, answer] of [
  ['the same type at another status', () => providerError('invalid_request', 422, 'zz unprocessable')],
  ['another type at the same status', () => providerError('unsupported', 400, 'zz unsupported here')],
  ['an aborted call', () => 'aborted' as const],
] as const) {
  test(`a probe answered with ${what} couldn't tell: nothing is shed`, async (t) => {
    const membrane = new StandIn(failsFromThird(walk4), answer);
    const r = await resident(t, membrane);
    for (const [i, text] of ['zz-q3', 'zz-q4', 'zz-q5'].entries()) {
      r.say(text);
      await r.until(() => r.count('inference:exhausted') === i + 1, `${text}'s turn to fail`);
    }
    await r.until(() => r.alerts('history-kept').length === 1, 'the breaker to say it kept the history');
    await r.quiet(60_000);
    assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3', 'zz-q4', 'zz-q5']);
    assert.equal(r.rewindMarkers(), 0);
    assert.match(String(r.alerts('history-kept')[0]!.message), /couldn't tell/);
  });
}

test('a message that arrives while the probe is out sets its answer aside: an answered probe then sheds nothing', async (t) => {
  let answer!: (value: 'answered') => void;
  const held = new Promise<'answered'>((resolve) => { answer = resolve; });
  const membrane = new StandIn((request, send) => (send >= 3 && !texts(request).includes('zz-q4') ? walk4() : undefined), () => held);
  const r = await resident(t, membrane);
  r.say('zz-q3');
  await r.until(() => r.count('inference:exhausted') === 1, "q3's turn to fail");
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 2, 'the first wake to fail');
  r.wake();
  await r.until(() => membrane.probes.length === 1, 'the probe to go out');
  r.say('zz-q4');
  await r.until(() => r.history().includes('zz-q4'), 'q4 to be stored while the probe is out');
  answer('answered');
  await r.until(() => r.count('inference:completed') === 3, "q4's turn to be answered once the probe is back");
  await r.quiet(60_000);
  assert.deepEqual(r.history().filter((x) => !x.startsWith('zz-answer-')), ['zz-q1', 'zz-q2', 'zz-q3', 'zz-q4']);
  assert.equal(r.rewindMarkers(), 0);
});

test('a message stored while the probe is out, with no turn of its own, sets the answer aside too', async (t) => {
  let answer!: (value: 'answered') => void;
  const held = new Promise<'answered'>((resolve) => { answer = resolve; });
  const membrane = new StandIn(failsFromThird(walk4), () => held);
  const r = await resident(t, membrane);
  r.say('zz-q3');
  await r.until(() => r.count('inference:exhausted') === 1, "q3's turn to fail");
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 2, 'the first wake to fail');
  r.wake();
  await r.until(() => membrane.probes.length === 1, 'the probe to go out');
  r.say('zz-quiet-q4');
  await r.until(() => r.history().includes('zz-quiet-q4'), 'the quiet message to be stored while the probe is out');
  answer('answered');
  await r.quiet(60_000);
  assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3', 'zz-quiet-q4']);
  assert.equal(r.rewindMarkers(), 0);
  assert.equal(membrane.sends.length, 2 + 3, 'no turn ran for the quiet message, and no rewind retry');
});

test('an edit to the history while the probe is out sets the answer aside too', async (t) => {
  let answer!: (value: 'answered') => void;
  const held = new Promise<'answered'>((resolve) => { answer = resolve; });
  const membrane = new StandIn(failsFromThird(walk4), () => held);
  const r = await resident(t, membrane);
  r.say('zz-q3');
  await r.until(() => r.count('inference:exhausted') === 1, "q3's turn to fail");
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 2, 'the first wake to fail');
  r.wake();
  await r.until(() => membrane.probes.length === 1, 'the probe to go out');
  const cm = r.fw.getAgent('resident')!.getContextManager();
  const q3 = cm.getAllMessages().find((m) => m.content.some((b) => (b as { text?: string }).text === 'zz-q3'))!;
  cm.editMessage(q3.id, [{ type: 'text', text: 'zz-q3-edited' }]);
  answer('answered');
  await r.quiet(60_000);
  assert.deepEqual(r.history(), ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3-edited']);
  assert.equal(r.rewindMarkers(), 0);
});

test('stop() while the probe is out aborts it, and nothing is shed', async (t) => {
  const membrane = new StandIn(failsFromThird(walk4), () => new Promise<'answered'>(() => {}));
  const r = await resident(t, membrane);
  r.say('zz-q3');
  await r.until(() => r.count('inference:exhausted') === 1, "q3's turn to fail");
  r.wake();
  await r.until(() => r.count('inference:exhausted') === 2, 'the first wake to fail');
  r.wake();
  await r.until(() => membrane.probes.length === 1, 'the probe to go out');
  const before = r.history();
  let stopped = false;
  void r.fw.stop().finally(() => { stopped = true; });
  await r.until(() => stopped, 'stop() to end, with the probe still unanswered by the provider');
  assert.equal(membrane.probeOptions[0]!.signal?.aborted, true, "stop() aborted the probe's call");
  assert.deepEqual(before, ['zz-q1', 'zz-answer-1', 'zz-q2', 'zz-answer-2', 'zz-q3']);
  assert.equal(r.alerts('history-kept').length, 0, 'an answer set aside raises nothing');
});

test('a probe opens no kv submission: only the turns that went on the wire do', async (t) => {
  const strategy = new KvPassthrough();
  const membrane = new StandIn(failsFromThird(walk4), () => walk4());
  const r = await resident(t, membrane, strategy);
  for (const [i, text] of ['zz-q3', 'zz-q4', 'zz-q5'].entries()) {
    r.say(text);
    await r.until(() => r.count('inference:exhausted') === i + 1, `${text}'s turn to fail`);
  }
  await r.quiet(60_000);
  assert.equal(membrane.probes.length, 1, 'the probe went out');
  assert.equal(membrane.sends.length, 5);
  assert.deepEqual(strategy.begun, ['zz-send-1', 'zz-send-2', 'zz-send-3', 'zz-send-4', 'zz-send-5']);
});
