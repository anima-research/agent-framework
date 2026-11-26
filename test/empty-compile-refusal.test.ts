import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, AnthropicXmlFormatter, Membrane, MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ErrorAction, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, DefaultErrorPolicy, EmptyCompileError, isEmptyCompileError } from '../src/index.js';
import { storeOwnRow, withAudience } from '../src/dendrite/audience.js';
import { AutobiographicalStrategy, ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { JsStore } from '@animalabs/chronicle';
import { Agent } from '../src/agent.js';
import { WriteOutcomeUnknownError } from '../src/context-manager-errors.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const LONG = `zz-long ${'lorem ipsum dolor sit amet '.repeat(2200)}`;

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'zz' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String(event.content);
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text }] }],
      requestInference: !(event.metadata as { quiet?: boolean } | undefined)?.quiet,
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

const emptyRequestRefusal = () => new MembraneError({
  type: 'invalid_request', retryable: false, httpStatus: 400, providerErrorCode: 'invalid_request_error',
  message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
  rawError: undefined,
} as never);

class ProviderLikeMembrane extends MockMembrane {
  readonly sent: NormalizedRequest[] = [];
  readonly scripted: NormalizedResponse[] = [];
  failNext = 0;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.sent.push(request);
    if (this.failNext > 0) {
      this.failNext--;
      return new ErrorStream(new MembraneError({ type: 'server', retryable: true, httpStatus: 502, message: 'zz server failure', rawError: undefined } as never));
    }
    if (request.messages.length === 0) return new ErrorStream(emptyRequestRefusal());
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: `zz-answer-${this.sent.length}` }])]);
  }
  override async stream(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.sent.push(request);
    if (request.messages.length === 0) throw emptyRequestRefusal();
    return this.scripted.shift() ?? createMockResponse([{ type: 'text', text: `zz-answer-${this.sent.length}` }]);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, boundMs = 10_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(5);
  }
}

type Trace = { type: string; kind?: string; message?: string; errorType?: string; agentName?: string; retryable?: boolean; operatorNote?: string; shownReason?: string; emptyCompileUsable?: number };

async function harness(contextBudgetTokens: number, opts: { names?: readonly string[]; modules?: readonly Module[]; strategy?: unknown; framework?: Record<string, unknown>; membrane?: Membrane } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-empty-compile-'));
  const membrane = new ProviderLikeMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: opts.membrane ?? membrane.asMembrane(),
    agents: (opts.names ?? ['resident']).map((name) => ({ name, model: 'zz-model', systemPrompt: 'system', contextBudgetTokens, ...(opts.strategy ? { strategy: opts.strategy } : {}) })),
    modules: [new InputModule(), ...(opts.modules ?? [])], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...opts.framework,
  } as never);
  const traces: Trace[] = [];
  framework.onTrace((e) => { traces.push(e as unknown as Trace); });
  const queued: Array<Record<string, unknown>> = [];
  const capture = (list: Array<Record<string, unknown>>) => {
    const push = list.push.bind(list);
    list.push = (...items) => { queued.push(...items); return push(...items); };
    return list;
  };
  const host = framework as unknown as { pendingRequests: Array<Record<string, unknown>> };
  let current = capture(host.pendingRequests);
  Object.defineProperty(host, 'pendingRequests', { configurable: true, get: () => current, set: (list: Array<Record<string, unknown>>) => { current = capture(list); } });
  const stderr: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
  framework.start();
  const count = (type: string) => traces.filter((t) => t.type === type).length;
  const settled = () => count('inference:completed') + count('inference:exhausted');
  const rows = () => framework.getAgent('resident')!.getContextManager().getAllMessages()
    .map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));
  const notices = () => rows().filter((r) => r.startsWith('[inference-failed]'));
  const say = (text: string, quiet = false) =>
    framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: quiet ? { quiet: true } : {} } as never);
  const wake = (extra: Record<string, unknown> = {}) => (framework as unknown as { pendingRequests: unknown[] }).pendingRequests
    .push({ agentName: 'resident', source: 'test', reason: 'zz-wake', timestamp: Date.now(), ...extra });
  const alerts = () => traces.filter((t) => t.type === 'ops:alert' && t.kind === 'context-refusal');
  const pending = () => (framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests;
  const busy = new Set(['inferring', 'streaming', 'waiting_for_tools']);
  const quiet = () => pending().length === 0 && framework.getHostModeStatus().drained
    && (opts.names ?? ['resident']).every((n) => !busy.has(framework.getAgent(n)?.state.status ?? 'idle'));
  let quietSince: number | undefined;
  const idle = () => {
    if (!quiet()) { quietSince = undefined; return false; }
    quietSince ??= Date.now();
    if (Date.now() - quietSince < 25) return false;
    quietSince = undefined;
    return true;
  };
  const exhausted = () => traces.filter((t) => t.type === 'inference:exhausted');
  const close = async () => {
    await framework.stop().catch(() => {});
    console.error = error;
    rmSync(dir, { recursive: true, force: true });
  };
  const noticeWakes = () => queued.filter((r) => r.reason === 'empty-compile-notice');
  return { framework, membrane, traces, stderr, count, settled, rows, notices, say, wake, alerts, exhausted, pending, idle, noticeWakes, close };
}

const texts = (request: NormalizedRequest) => request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');

test('a newest message the budget can\'t hold ends its turn with no request, tells the agent once, and wakes it onto the notice', async () => {
  const h = await harness(12_000);
  try {
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first answer');
    const sentBefore = h.membrane.sent.length;
    h.say(LONG);
    await until(() => h.settled() === 3, 'the long message\'s turn and the wake onto its notice');
    await until(h.idle, 'the framework idle');
    assert.equal(h.count('inference:failed'), 1, 'the refused turn is not retried');
    assert.equal(h.membrane.sent.length, sentBefore + 1, 'only the wake onto the notice is sent');
    const wakeTexts = texts(h.membrane.sent.at(-1)!);
    assert.ok(wakeTexts.some((t) => t.startsWith('[inference-failed]')), 'the wake\'s request holds the notice');
    assert.ok(!wakeTexts.some((t) => t.startsWith('zz-long')), 'the long message is still left out');
    assert.equal(h.count('inference:completed'), 2);

    const refused = h.exhausted().at(-1)!;
    assert.equal(refused.errorType, 'empty_compile');
    assert.equal(refused.retryable, false);
    assert.equal(refused.emptyCompileUsable, 7904);
    assert.ok(refused.operatorNote?.startsWith("the passthrough strategy selected none of the agent's conversation; 7904 of a 12000-token budget is usable after 4096 held back for the reply and any pending tool results."), refused.operatorNote);
    assert.deepEqual(h.notices(), ["[inference-failed] Your previous turn wasn't sent: none of your conversation reached your context. " +
      'If the newest message in your conversation is too large for your context, it and everything before it stay out of what you see until it is removed or your budget is raised.']);
    const alert = h.alerts().at(-1)!;
    assert.ok(alert.message!.startsWith('compile refused (empty_compile), its request not sent: the passthrough strategy selected none'), alert.message);
    assert.ok(!/overBudgetGraceRatio|drain/.test(alert.message!), 'no advice for a strategy that compresses');
    assert.ok(!h.stderr.some((l) => l.startsWith('[inference-rewind]')), 'the breaker sheds nothing');

    h.say(`${LONG} zz-again`);
    await until(() => h.settled() === 5, 'a second long message after a completed turn');
    assert.equal(h.notices().length, 2, 'a completed turn ends the run, so the next refusal is told again');
  } finally { await h.close(); }
});

test('a budget that leaves no room for any message fails every wake, a new message each time, with one notice, no request, no shed and no wake onto it', async () => {
  const h = await harness(4_000);
  try {
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first turn');
    for (let i = 2; i <= 5; i++) {
      h.say(`zz-q${i}`);
      await until(() => h.settled() === i, `message ${i}`);
    }
    await until(h.idle, 'the framework idle');
    assert.equal(h.membrane.sent.length, 0, 'no request is sent');
    assert.equal(h.count('inference:completed'), 0);
    assert.equal(h.exhausted().length, 5, 'no wake follows the notice');
    assert.ok(h.exhausted().every((t) => t.errorType === 'empty_compile'));
    assert.deepEqual(h.notices(), ["[inference-failed] Your previous turn wasn't sent: the context budget leaves no room for any of your conversation once the room held back for the reply and any pending tool results is set aside, so the budget must be raised."]);
    for (let i = 1; i <= 5; i++) assert.ok(h.rows().includes(`zz-q${i}`), `zz-q${i} is kept`);
    assert.ok(!h.stderr.some((l) => l.startsWith('[inference-rewind]')), 'the breaker sheds nothing');
    assert.ok(!h.rows().some((r) => r.startsWith('[refusal-rewind]')), 'no rewind notice is written');
    assert.ok(h.stderr.some((l) => l.startsWith('[inference-hard-down]')), 'from the third failure the agent is reported hard-down');
    assert.ok(h.alerts()[0]!.message!.includes("compile refused (empty_compile), its request not sent: the passthrough strategy selected none of the agent's conversation; contextBudgetTokens (4000) leaves no room once 4096 tokens are held back for the reply and any pending tool results: raise contextBudgetTokens."), h.alerts()[0]!.message);
  } finally { await h.close(); }
});

test('where the budget can\'t hold even the notice, the one wake onto it is refused too, and nothing more follows', async () => {
  const h = await harness(4_106);
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    cm.presentRows([cm.addMessage('user', [{ type: 'text', text: 'zz-hi '.repeat(50) }])]);
    h.wake();
    await until(() => h.settled() === 2, 'the refusal and the wake onto its notice');
    await until(h.idle, 'the framework idle');
    assert.equal(h.settled(), 2, 'the second refusal queues no wake');
    assert.equal(h.membrane.sent.length, 0);
    assert.equal(h.notices().length, 1, 'the second refusal writes no notice');
  } finally { await h.close(); }
});

test('in XML tool mode, a compile that selects nothing sends no turn for the formatter to fill', async () => {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (String(req.url).includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      bodies.push(raw);
      const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        event('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'zz-answer' } }) +
        event('content_block_stop', { index: 0 }) +
        event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }) +
        event('message_stop', {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adapter = new AnthropicAdapter({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cacheKeepalive: { enabled: false } } as never);
  const h = await harness(12_000, { membrane: new Membrane(adapter, { formatter: new AnthropicXmlFormatter({ toolMode: 'xml' }) }) });
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    h.wake();
    await until(() => h.settled() >= 1, 'the refused turn');
    await until(() => h.settled() === 2, 'the wake onto its notice', 20_000);
    assert.equal(h.exhausted()[0]!.errorType, 'empty_compile');
    assert.ok(bodies.length > 0, 'the wake onto the notice is sent');
    assert.ok(bodies.every((b) => b.includes('[inference-failed]')), 'every request sent holds the notice: none went out on nothing');
  } finally {
    await h.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an agent whose window holds only a slot it observes is refused as one whose own slot holds the rows', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored in the residents\' slot');
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-observer', isolate: true, auxiliaryMessageViews: [{}], strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows(cm.getUnpresentedMessages().map((m) => m.id));
      assert.equal(cm.getMessageCount(), 0, 'premise: the observer\'s own slot holds nothing');
      const agent = new Agent({ name: 'zz-observer', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      await assert.rejects(agent.buildActivationRequest([]), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a wake with nothing stored isn\'t refused: its request goes to membrane as before', async () => {
  const h = await harness(12_000);
  try {
    h.wake();
    await until(() => h.settled() === 1, 'the wake');
    assert.equal(h.membrane.sent.length, 1);
    assert.equal(h.membrane.sent[0]!.messages.length, 0);
  } finally { await h.close(); }
});

test('a resident whose shared slot holds only another resident\'s rows is sent as an agent with an empty store is', async () => {
  const h = await harness(12_000, { names: ['resident', 'other'] });
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    cm.presentRows([cm.addMessage('user', [{ type: 'text', text: 'zz-for-resident' }], withAudience(undefined, ['resident']))]);
    h.wake({ agentName: 'other' });
    await until(() => h.settled() === 1, 'the other resident\'s wake');
    assert.equal(h.membrane.sent.length, 1, 'it is sent');
    assert.equal(h.membrane.sent[0]!.messages.length, 0, 'holding none of the resident\'s rows');
    assert.ok(h.rows().includes('zz-for-resident'), 'the resident\'s row is kept');
  } finally { await h.close(); }
});

class Lessons implements Module {
  readonly name = 'lessons';
  lesson = 'zz-lesson';
  constructor(private readonly placed: boolean) {}
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: 'zz' }; }
  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; }
  async gatherContext() {
    return [{ namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: this.lesson }], ...(this.placed ? { placedEachCompile: true } : {}) }] as never;
  }
}

for (const placed of [true, false]) {
  test(`a compile that selects only an injection ${placed ? 'the compile places' : 'stored as a row'}, beside a newest message it can't hold, is refused and isn't noted as sent`, async () => {
    const lessons = new Lessons(placed);
    const h = await harness(12_000, { modules: [lessons] });
    try {
      const observed: string[][] = [];
      h.framework.getAgent('resident')!.onCompiledToSend = (messages) => {
        observed.push(messages.flatMap((m) => (m as { content: Array<{ text?: string }> }).content.map((b) => b.text ?? '')));
      };
      h.say('zz-q1');
      await until(() => h.settled() === 1, 'the first answer');
      lessons.lesson = 'zz-lesson-2';
      const sentBefore = h.membrane.sent.length;
      h.say(LONG);
      await until(() => h.settled() === 3, 'the long message\'s turn and the wake onto its notice');
      assert.equal(h.exhausted().at(-1)!.errorType, 'empty_compile');
      assert.equal(h.membrane.sent.length, sentBefore + 1, 'only the wake onto the notice is sent');
      assert.ok(observed.every((compile) => compile.some((t) => !t.startsWith('zz-lesson') && t !== '')), 'no compile holding only the injection was noted as sent');
      const wakeCompile = observed.at(-1)!;
      assert.ok(wakeCompile.some((t) => t.startsWith('[inference-failed]')) && wakeCompile.some((t) => t.includes('zz-lesson-2')), 'the wake onto the notice is noted as sent, with the lesson in it');
    } finally { await h.close(); }
  });
}

const tick = (n: number) => ({ reason: 'heartbeat', source: 'heartbeat', suppressProse: true, silentHeartbeat: { eventId: `zz-tick-${n}`, serverId: 'heartbeat' } });

test('silent heartbeat ticks whose compile selects nothing end with no request, though a separator would have filled one, and leave one notice until a turn completes', async () => {
  const h = await harness(4_000);
  try {
    h.say('zz-q1', true);
    await until(() => h.rows().includes('zz-q1'), 'the row stored');
    for (let i = 1; i <= 4; i++) {
      h.wake(tick(i));
      await until(() => h.settled() === i, `tick ${i}`);
    }
    h.say('zz-q2', true);
    await until(() => h.rows().includes('zz-q2'), 'a new row stored');
    h.wake(tick(5));
    await until(() => h.settled() === 5, 'tick 5');
    await until(h.idle, 'the framework idle');
    assert.equal(h.membrane.sent.length, 0, 'no tick sends anything');
    assert.ok(h.exhausted().every((t) => t.errorType === 'empty_compile'));
    assert.equal(h.notices().length, 1, 'a new row stored meanwhile doesn\'t start a new run');
  } finally { await h.close(); }
});

for (const [form, metadata, content, named] of [
  ['its author and channel', { author: { name: 'Alice' }, serverId: 'discord', channelId: 'general' }, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'The newest message in your conversation is from Alice in discord:general. If that message'],
  ['its author alone', { authorName: 'Alice' }, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'The newest message in your conversation is from Alice. If that message'],
  ['its channel alone', { channelId: 'general' }, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'The newest message in your conversation is in general. If that message'],
  ['a tool result that isn\'t its own', { author: { name: 'Alice' } }, [{ type: 'tool_result', toolUseId: 'zz-t', content: [{ type: 'text', text: 'zz-out '.repeat(50) }] }], 'none of your conversation reached your context. The newest message in your conversation is a tool result. If that message is too large for your context, it and everything before it stay out of what you see until it is removed or your budget is raised.'],
  ['nothing its metadata names', {}, [{ type: 'text', text: 'zz-hi '.repeat(50) }], 'none of your conversation reached your context. If the newest message in your conversation'],
] as const) {
  test(`the notice names the newest row by ${form}, from its metadata alone, and the operator's alert names no sender or channel`, async () => {
    const h = await harness(4_100);
    try {
      const cm = h.framework.getAgent('resident')!.getContextManager();
      cm.presentRows([cm.addMessage('user', content as never, metadata as never)]);
      h.wake();
      await until(() => h.settled() >= 1, 'the wake');
      await until(h.idle, 'the framework idle');
      assert.equal(h.membrane.sent.length, 0);
      const notice = h.notices()[0]!;
      assert.ok(notice.includes(named), notice);
      assert.ok(!notice.includes('zz-hi') && !notice.includes('zz-out'), 'none of the row\'s content');
      const alert = h.alerts()[0]!.message!;
      assert.ok(!alert.includes('Alice') && !alert.includes('general'), alert);
      assert.ok(alert.includes("the passthrough strategy selected none of the agent's conversation; 4 of a 4100-token budget is usable after 4096 held back for the reply and any pending tool results."), alert);
    } finally { await h.close(); }
  });
}

for (const [form, strategy, budget, participant, content, reason] of [
  ['its own tool call with no result, under the autobiographical strategy',
    () => new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 200 }), 50_000, 'resident',
    [{ type: 'tool_use', id: 'zz-call', name: 'zz_look', input: {} }],
    'none of your conversation reached your context. The newest message in your conversation is your own tool call.'],
  ['a round it wrote too large for its context, under passthrough', undefined, 4_100, 'resident',
    [{ type: 'text', text: 'zz-mine '.repeat(50) }],
    'none of your conversation reached your context. The newest message in your conversation is one you wrote. If that message is too large for your context, it and everything before it stay out of what you see until it is removed or your budget is raised.'],
  ['a tool result stamped as its own row, under passthrough', undefined, 4_100, 'user',
    [{ type: 'tool_result', toolUseId: 'zz-t', toolName: 'zz_look', content: [{ type: 'text', text: 'zz-out '.repeat(50) }] }],
    'none of your conversation reached your context. The newest message in your conversation is a tool result from zz_look. If that message is too large for your context, it and everything before it stay out of what you see until it is removed or your budget is raised, and a call that returns less may fit.'],
] as const) {
  test(`the notice names the newest row as ${form}`, async () => {
    const h = await harness(budget, strategy ? { strategy: strategy() } : {});
    try {
      const agent = h.framework.getAgent('resident')!;
      storeOwnRow(agent, participant, content as never);
      h.wake();
      await until(() => h.settled() >= 1, 'the wake');
      await until(h.idle, 'the framework idle');
      assert.ok(h.membrane.sent.every((r) => texts(r).some((t) => t.startsWith('[inference-failed]'))), 'only a wake onto the notice is sent');
      assert.equal(h.membrane.sent.length, budget > 4_100 ? 1 : 0, budget > 4_100 ? 'the wake onto the notice is sent' : 'the wake onto the notice is refused too, since the notice doesn\'t fit');
      assert.equal(h.notices()[0], `[inference-failed] Your previous turn wasn't sent: ${reason}`);
      if (strategy) {
        const note = h.exhausted()[0]!.operatorNote!;
        assert.ok(note.endsWith(' Raise contextBudgetTokens, or check the strategy\'s selection.') && !note.includes('stay out'), note);
      }
    } finally { await h.close(); }
  });
}

test('the direct API rejects a compile that selects nothing before it sends, though tool results would be appended to it', async () => {
  const h = await harness(12_000);
  try {
    const agent = h.framework.getAgent('resident')!;
    const cm = agent.getContextManager();
    cm.presentRows([cm.addMessage('user', [{ type: 'text', text: `zz-read ${'the whole file, please. '.repeat(10)}` }])]);
    h.membrane.scripted.push(createMockResponse([{ type: 'tool_use', id: 'zz-t1', name: 'zz_tool', input: {} }], 'tool_use'));
    const first = await agent.runInference(h.framework.getAllTools());
    assert.equal(first.toolCalls.length, 1);
    agent.provideToolResult('zz-t1', { success: true, data: 'zz-result' });
    h.framework.updateAgentRuntimeSettings('resident', { contextBudgetTokens: 4_100, immediate: true }, { allowInfeasible: true });
    const sentBefore = h.membrane.sent.length;
    await assert.rejects(agent.runInference(h.framework.getAllTools()), (err: unknown) => {
      assert.ok(err instanceof EmptyCompileError, String(err));
      assert.equal(err.retryable, false);
      assert.equal(err.message, 'the compile selected none of the conversation in the agent\'s window, so its request was not sent');
      assert.match(err.residentNote, /^none of your conversation reached your context/);
      assert.match(err.operatorNote, /^the passthrough strategy selected none of the agent's conversation; 4 of a 4100-token budget is usable after 4096 held back for the reply and any pending tool results\./);
      return true;
    });
    assert.equal(h.membrane.sent.length, sentBefore, 'nothing is sent');
  } finally { await h.close(); }
});

test('the direct API sends as before when the store holds nothing, and the provider\'s answer decides', async () => {
  const h = await harness(12_000);
  try {
    const agent = h.framework.getAgent('resident')!;
    await assert.rejects(agent.runInference(h.framework.getAllTools()), (err: unknown) => {
      assert.ok(err instanceof MembraneError, String(err));
      return true;
    });
    assert.equal(h.membrane.sent.length, 1, 'the request is sent');
  } finally { await h.close(); }
});

test('a preview of a compile that selects nothing doesn\'t throw', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    const preview = await h.framework.previewActivation('resident');
    assert.equal(preview.messages.length, 0);
  } finally { await h.close(); }
});

test('the default error policy doesn\'t retry an empty compile, from this copy of the package or another', () => {
  const policy = new DefaultErrorPolicy();
  assert.deepEqual(policy.onInferenceError(new EmptyCompileError(12_000, 4_096), 'resident', 0), { retry: false });
  const fromAnotherCopy = Object.assign(new Error('zz'), { name: 'EmptyCompileError' });
  assert.equal(isEmptyCompileError(fromAnotherCopy), true);
  assert.deepEqual(policy.onInferenceError(fromAnotherCopy, 'resident', 0), { retry: false });
});

test('a host\'s error policy that would retry an empty compile isn\'t asked', async () => {
  let asked = 0;
  const errorPolicy = { maxRetries: 3, onInferenceError: (): ErrorAction => (++asked <= 3 ? { retry: true, delayMs: 0 } : { retry: false }) };
  const h = await harness(12_000, { framework: { errorPolicy } });
  try {
    h.membrane.failNext = 1;
    h.say('zz-q1');
    await until(() => h.count('inference:completed') === 1, 'the first turn, retried by the host\'s policy');
    assert.equal(asked, 1, 'premise: the host\'s policy is asked about a provider\'s failure');
    const failedBefore = h.count('inference:failed');
    h.say(LONG);
    await until(() => h.exhausted().length === 1, 'the refused turn');
    await until(h.idle, 'the framework idle');
    assert.equal(asked, 1, 'it isn\'t asked about the refusal');
    assert.equal(h.count('inference:failed'), failedBefore + 1, 'the refused turn is not retried');
    assert.equal(h.exhausted()[0]!.errorType, 'empty_compile');
  } finally { await h.close(); }
});

test('no operator\'s sink names the newest row\'s sender or channel, from the first refusal through hard-down', async () => {
  const started = Date.now();
  const h = await harness(4_100);
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    cm.presentRows([cm.addMessage('user', [{ type: 'text', text: 'zz-hi '.repeat(50) }], { author: { name: 'Alice' }, serverId: 'discord', channelId: 'general' } as never)]);
    h.wake();
    await until(() => h.settled() === 2, 'the refusal and the wake onto its notice');
    h.wake();
    await until(() => h.settled() === 3, 'a third refusal');
    await until(h.idle, 'the framework idle');
    assert.ok(h.stderr.some((l) => l.startsWith('[inference-hard-down]')), 'premise: the agent is reported hard-down');
    assert.ok(h.notices()[0]!.includes('The newest message in your conversation is from Alice in discord:general.'), 'the agent\'s own notice names them');
    const named = (text: string | undefined) => text !== undefined && (text.includes('Alice') || text.includes('general'));
    for (const t of h.exhausted()) assert.ok(!named(t.message) && !named((t as { error?: string }).error) && !named(t.shownReason) && !named(t.operatorNote), JSON.stringify(t));
    for (const t of h.traces.filter((e) => e.type === 'ops:alert')) assert.ok(!named(t.message), t.message);
    for (const line of h.stderr.filter((l) => l.startsWith('[inference-'))) assert.ok(!named(line), line);
    const parsed = (l: string): { at: string; errorType?: string } | undefined => {
      try { return JSON.parse(l) as { at: string; errorType?: string }; } catch { return undefined; }
    };
    const logged = readFileSync('logs/failures.log', 'utf8').split('\n').map(parsed)
      .filter((r): r is { at: string; errorType?: string } => r !== undefined)
      .filter((r) => r.errorType === 'empty_compile' && Date.parse(r.at) >= started);
    assert.ok(logged.length >= 3, 'premise: failures.log holds a record of each refusal');
    for (const r of logged) assert.ok(!named(JSON.stringify(r)), JSON.stringify(r));
  } finally { await h.close(); }
});

test('a host\'s provider hold doesn\'t park a refused compile', async () => {
  let asked = 0;
  const h = await harness(4_000, { framework: { providerHold: () => { asked++; return { holdMs: 60_000, reason: 'zz-hold' }; } } });
  try {
    h.say('zz-q1');
    await until(() => h.exhausted().length === 1, 'the refused turn ends');
    assert.equal(h.exhausted()[0]!.errorType, 'empty_compile');
    assert.equal(asked, 0, 'the host\'s hook isn\'t asked');
  } finally { await h.close(); }
});

test('an ephemeral run that is refused writes its notice and gets no wake onto it', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    const worker = await h.framework.deriveAgent({ name: 'worker-1', from: 'resident', mode: 'copy', config: { contextBudgetTokens: 12_000 } });
    await h.framework.runEphemeralToCompletion(worker.agent, worker.contextManager).catch(() => undefined);
    await until(h.idle, 'the framework idle');
    assert.deepEqual(h.exhausted().filter((t) => t.agentName === 'worker-1').map((t) => t.errorType), ['empty_compile'], 'the run was refused once');
    assert.deepEqual(h.noticeWakes().filter((r) => r.agentName === 'worker-1'), [], 'no wake was queued for it');
    const rows = worker.contextManager.getAllMessages().map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));
    assert.ok(rows.some((r) => r.startsWith('[inference-failed]')), 'it wrote its notice');
  } finally { await h.close(); }
});

test('a compile that selects only another agent\'s stored injection is refused, as one that selects only the agent\'s own is', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      const mark = { agent: 'other', namespace: 'lessons', contentHash: 'zz-h', part: 0, parts: 1 };
      cm.presentRows([
        cm.addMessage('User', [{ type: 'text', text: LONG }]),
        cm.addMessage('system_context:lessons', [{ type: 'text', text: 'zz-lesson-of-other' }], { system: true, kind: 'context-injection', contextInjection: mark } as never),
      ]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      const preview = await host.buildActivationRequest([], undefined, undefined, undefined, { dryRun: true } as never);
      assert.deepEqual(texts(preview), ['zz-lesson-of-other'], 'premise: the compile selects the other agent\'s injection alone');
      await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a compile that selects only a stored injection from a slot the agent observes is refused', async () => {
  const h = await harness(12_000);
  try {
    const residents = h.framework.getAgent('resident')!.getContextManager();
    const mark = { agent: 'other', namespace: 'lessons', contentHash: 'zz-h', part: 0, parts: 1 };
    residents.presentRows([
      residents.addMessage('User', [{ type: 'text', text: LONG }]),
      residents.addMessage('system_context:lessons', [{ type: 'text', text: 'zz-lesson-of-other' }], { system: true, kind: 'context-injection', contextInjection: mark } as never),
    ]);
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-observer', isolate: true, auxiliaryMessageViews: [{}], strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows(cm.getUnpresentedMessages().map((m) => m.id));
      assert.equal(cm.getMessageCount(), 0, 'premise: the observer\'s own slot holds nothing');
      const agent = new Agent({ name: 'zz-observer', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      const preview = await agent.buildActivationRequest([], undefined, undefined, undefined, { dryRun: true } as never);
      assert.deepEqual(texts(preview), ['zz-lesson-of-other'], 'premise: the compile selects the observed slot\'s injection alone');
      await assert.rejects(agent.buildActivationRequest([]), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a refusal gives the budget its compile ran at, though the budget was raised while it ran', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows([cm.addMessage('User', [{ type: 'text', text: LONG }])]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      const compile = cm.compile.bind(cm);
      cm.compile = (async (...args: Parameters<typeof compile>) => {
        const result = await compile(...args);
        host.updateRuntimeSettings({ contextBudgetTokens: 40_000 });
        return result;
      }) as typeof cm.compile;
      await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        assert.equal(err.budgetTokens, 12_000);
        assert.ok(err.operatorNote.includes('7904 of a 12000-token budget'), err.operatorNote);
        return true;
      });
      const sent = await host.buildActivationRequest([]);
      assert.ok(texts(sent).some((t) => t.startsWith('zz-long')), 'premise: at the raised budget the message fits');
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a notice that the store holds, though its write threw with its outcome unknown, counts as written, and the wake follows it', async () => {
  const h = await harness(12_000);
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    cm.addMessage = ((...args: Parameters<typeof add>) => {
      const id = add(...args);
      const text = (args[1][0] as { text?: string } | undefined)?.text ?? '';
      if (text.startsWith('[inference-failed]')) throw new WriteOutcomeUnknownError({ landed: [], unknown: [id], unnamed: 0 }, new Error('zz-read-failed'));
      return id;
    }) as typeof cm.addMessage;
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first answer');
    const sentBefore = h.membrane.sent.length;
    h.say(LONG);
    await until(() => h.settled() === 3, 'the long message\'s turn and the wake onto its notice');
    await until(h.idle, 'the framework idle');
    assert.equal(h.membrane.sent.length, sentBefore + 1, 'the wake onto the notice is sent');
    assert.ok(texts(h.membrane.sent.at(-1)!).some((t) => t.startsWith('[inference-failed]')), 'the wake\'s request holds the notice');
    assert.equal(h.notices().length, 1);
  } finally { await h.close(); }
});

test('the wake onto the notice of a refused silent tick is silent too', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    h.wake(tick(1));
    await until(() => h.settled() === 2, 'the refused tick and the wake onto its notice');
    await until(h.idle, 'the framework idle');
    assert.equal(h.notices().length, 1);
    assert.ok(texts(h.membrane.sent.at(-1)!).some((t) => t.startsWith('[inference-failed]')), 'premise: the wake onto the notice was sent');
    const started = h.traces.filter((t) => t.type === 'inference:started');
    assert.equal(started.length, 2);
    assert.ok(started.every((t) => (t as { silent?: boolean }).silent === true), JSON.stringify(started));
  } finally { await h.close(); }
});

test('a compile that selects none of the conversation neither proves the live budget nor counts against it: a budget the boot applied at once stays', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows([cm.addMessage('User', [{ type: 'text', text: LONG }])]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 40_000 } as never, cm, h.membrane.asMembrane());
      host.restoreRuntimeSettings({ contextBudgetTokens: 12_000, immediate: true }, { provenBudget: 12_000 });
      const errors: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      try {
        await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
          assert.ok(err instanceof EmptyCompileError, String(err));
          assert.equal(err.budgetTokens, 12_000);
          return true;
        });
      } finally { console.error = error; }
      assert.equal(host.getProvenContextBudgetTokens(), 12_000, 'the boot\'s proof stands');
      assert.ok(!errors.some((l) => l.includes('which the boot applied at once')), errors.join('\n'));
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a committing compileContext refuses as compileWithInjections does', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows([cm.addMessage('User', [{ type: 'text', text: LONG }])]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      await assert.rejects(host.compileContext(), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('once a host presents rows, a row it stores and doesn\'t present is in no request, and a window that holds only an oversized row is refused', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    for (const [namespace, presented, refused] of [['zz-host-a', 'zz-seen', false], ['zz-host-b', LONG, true]] as const) {
      const cm = await ContextManager.open({ store, namespace, isolate: true, strategy: new PassthroughStrategy() } as never);
      try {
        cm.presentRows([cm.addMessage('User', [{ type: 'text', text: presented }])]);
        cm.addMessage('User', [{ type: 'text', text: 'zz-stored-only' }]);
        const host = new Agent({ name: namespace, model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
        if (refused) {
          await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
            assert.ok(err instanceof EmptyCompileError, String(err));
            return true;
          });
        } else {
          const sent = texts(await host.buildActivationRequest([]));
          assert.ok(sent.includes('zz-seen') && !sent.some((t) => t.includes('zz-stored-only')), JSON.stringify(sent));
        }
      } finally { await cm.close(); }
    }
  } finally { await h.close(); }
});

test('the wake onto a notice answers the refused turn\'s own channel and message, and a refused heartbeat\'s wake is a heartbeat\'s', async () => {
  const h = await harness(12_000);
  try {
    h.say(LONG, true);
    await until(() => h.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    h.wake({ channelId: 'zz-chan', channelServerId: 'zz-srv', answersMessageId: 'zz-m1' });
    await until(() => h.noticeWakes().length === 1, 'the notice wake queued');
    await until(h.idle, 'the framework idle');
    assert.equal(h.noticeWakes()[0]!.channelId, 'zz-chan');
    assert.equal(h.noticeWakes()[0]!.channelServerId, 'zz-srv');
    assert.equal(h.noticeWakes()[0]!.answersMessageId, 'zz-m1');
  } finally { await h.close(); }
  const b = await harness(12_000);
  try {
    b.say(LONG, true);
    await until(() => b.rows().some((r) => r.startsWith('zz-long')), 'the long message stored');
    b.wake({ reason: 'heartbeat', source: 'heartbeat' });
    await until(() => b.noticeWakes().length === 1, 'the heartbeat\'s notice wake queued');
    await until(b.idle, 'the framework idle');
    assert.equal(b.noticeWakes()[0]!.heartbeatTurn, true);
    assert.equal(b.noticeWakes()[0]!.channelId, undefined);
  } finally { await b.close(); }
});

test('a compile made while a tool-result batch holds back its reserve isn\'t refused: its request is sent as before', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows([cm.addMessage('User', [{ type: 'text', text: 'zz-short' }])]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      const guard = (host as unknown as { toolResultGuard: object }).toolResultGuard;
      Object.defineProperty(guard, 'pendingWireReserveTokens', { configurable: true, get: () => 20_000 });
      const sent = await host.buildActivationRequest([]);
      assert.ok(!texts(sent).includes('zz-short'), 'premise: the reserve left no room for the message');
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a host that never presents rows has every stored row in its window, as before, and an oversized one is refused', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    for (const [namespace, text, refused] of [['zz-host-a', 'zz-stored', false], ['zz-host-b', LONG, true]] as const) {
      const cm = await ContextManager.open({ store, namespace, isolate: true, strategy: new PassthroughStrategy() } as never);
      try {
        cm.addMessage('User', [{ type: 'text', text }]);
        const host = new Agent({ name: namespace, model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
        if (refused) {
          await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
            assert.ok(err instanceof EmptyCompileError, String(err));
            return true;
          });
        } else {
          assert.ok(texts(await host.buildActivationRequest([])).includes('zz-stored'));
        }
      } finally { await cm.close(); }
    }
  } finally { await h.close(); }
});

test('a framework notice after an oversized message isn\'t conversation: a compile that holds only notices is refused', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      cm.presentRows([
        cm.addMessage('User', [{ type: 'text', text: LONG }]),
        cm.addMessage('user', [{ type: 'text', text: '[routing] zz-routing' }], { system: true, kind: 'routing-notice' } as never),
        cm.addMessage('user', [{ type: 'text', text: '[clock] zz-clock' }], { system: true, kind: 'zz-clock' } as never),
      ]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      const preview = texts(await host.buildActivationRequest([], undefined, undefined, undefined, { dryRun: true } as never));
      assert.ok(preview.includes('[routing] zz-routing') && preview.includes('[clock] zz-clock') && !preview.some((t) => t.startsWith('zz-long')), JSON.stringify(preview));
      await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        assert.ok(!err.residentNote.includes('framework notice') && !err.operatorNote.includes('framework notice'), `${err.residentNote}\n${err.operatorNote}`);
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('when a stored injection newer than a small message is what didn\'t fit, the notice names the injection, not the message\'s sender', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      const mark = { agent: 'zz-host', namespace: 'lessons', contentHash: 'zz-h', part: 0, parts: 1 };
      const short = cm.addMessage('user', [{ type: 'text', text: 'zz-short hello' }], { author: { name: 'Alice' }, serverId: 'discord', channelId: 'general' } as never);
      const big = cm.addMessage('system_context:lessons', [{ type: 'text', text: LONG }], { system: true, kind: 'context-injection', contextInjection: mark } as never);
      cm.presentRows([short, big]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      await assert.rejects(host.buildActivationRequest([]), (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        assert.ok(err.residentNote.includes('The newest row left out of your context is a context injection from lessons.'), err.residentNote);
        assert.ok(!err.residentNote.includes('Alice') && !err.residentNote.includes('smaller parts'), err.residentNote);
        assert.ok(err.operatorNote.includes(`The newest row it left out is a context injection from lessons (row ${big}).`), err.operatorNote);
        assert.ok(!err.operatorNote.includes('Alice') && !err.operatorNote.includes('general'), err.operatorNote);
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});
