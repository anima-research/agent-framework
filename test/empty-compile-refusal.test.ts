import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ErrorAction, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, DefaultErrorPolicy, EmptyCompileError, isEmptyCompileError } from '../src/index.js';
import { withAudience } from '../src/dendrite/audience.js';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type { JsStore } from '@animalabs/chronicle';
import { Agent } from '../src/agent.js';
import { WriteLandedError } from '../src/context-manager-errors.js';
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

type Trace = { type: string; kind?: string; message?: string; errorType?: string; agentName?: string; retryable?: boolean; operatorNote?: string };

async function harness(contextBudgetTokens: number, opts: { names?: readonly string[]; modules?: readonly Module[]; strategy?: unknown; framework?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-empty-compile-'));
  const membrane = new ProviderLikeMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: (opts.names ?? ['resident']).map((name) => ({ name, model: 'zz-model', systemPrompt: 'system', contextBudgetTokens, ...(opts.strategy ? { strategy: opts.strategy } : {}) })),
    modules: [new InputModule(), ...(opts.modules ?? [])], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...opts.framework,
  } as never);
  const traces: Trace[] = [];
  framework.onTrace((e) => { traces.push(e as unknown as Trace); });
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
  return { framework, membrane, traces, stderr, count, settled, rows, notices, say, wake, alerts, exhausted, pending, idle, close };
}

const texts = (request: NormalizedRequest) => request.messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '');

test('a newest message the budget can\'t hold ends its turn with no request and tells the agent once', async () => {
  const h = await harness(12_000);
  try {
    h.say('zz-q1');
    await until(() => h.settled() === 1, 'the first answer');
    const sentBefore = h.membrane.sent.length;
    h.say(LONG);
    await until(() => h.settled() === 2, 'the long message\'s turn');
    await until(h.idle, 'the framework idle');
    assert.equal(h.count('inference:failed'), 1, 'the refused turn is not retried');
    assert.equal(h.membrane.sent.length, sentBefore, 'nothing is sent');

    const refused = h.exhausted().at(-1)!;
    assert.equal(refused.errorType, 'empty_compile');
    assert.equal(refused.retryable, false);
    const long = h.framework.getAgent('resident')!.getContextManager().getAllMessages().find((m) => m.content.some((c) => (c as { text?: string }).text === LONG))!;
    assert.equal(refused.operatorNote, `the passthrough strategy selected none of the agent's conversation; 7904 of a 12000-token budget is usable after 4096 held back for the reply. A row too large for that room keeps the conversation out; the newest row that the compile left out is ${String(long.id)}: raise contextBudgetTokens, or remove that row.`);
    assert.deepEqual(h.notices(), ["[inference-failed] Your previous turn wasn't sent: none of your conversation was included in the request."]);
    const alert = h.alerts().at(-1)!;
    assert.ok(alert.message!.startsWith('compile refused (empty_compile), its request not sent: the passthrough strategy selected none'), alert.message);
    assert.ok(!/overBudgetGraceRatio|drain/.test(alert.message!), 'no advice for a strategy that compresses');
    assert.ok(!h.stderr.some((l) => l.startsWith('[inference-rewind]')), 'the breaker sheds nothing');

    h.say('zz-q2');
    await until(() => h.settled() === 3, 'the next message\'s turn');
    const next = texts(h.membrane.sent.at(-1)!);
    assert.ok(next.some((t) => t.startsWith('[inference-failed]')) && next.includes('zz-q2'), 'the next request holds the notice and the new message');
    assert.ok(!next.some((t) => t.startsWith('zz-long')), 'the long message is still left out');

    h.say(`${LONG} zz-again`);
    await until(() => h.settled() === 4, 'a second long message after a completed turn');
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
    assert.deepEqual(h.notices(), ["[inference-failed] Your previous turn wasn't sent: none of your conversation was included in the request."]);
    for (let i = 1; i <= 5; i++) assert.ok(h.rows().includes(`zz-q${i}`), `zz-q${i} is kept`);
    assert.ok(!h.stderr.some((l) => l.startsWith('[inference-rewind]')), 'the breaker sheds nothing');
    assert.ok(!h.rows().some((r) => r.startsWith('[refusal-rewind]')), 'no rewind notice is written');
    assert.ok(h.stderr.some((l) => l.startsWith('[inference-hard-down]')), 'from the third failure the agent is reported hard-down');
    assert.ok(h.alerts()[0]!.message!.includes("compile refused (empty_compile), its request not sent: the passthrough strategy selected none of the agent's conversation; contextBudgetTokens (4000) leaves no room once 4096 tokens are held back for the reply: raise contextBudgetTokens."), h.alerts()[0]!.message);
  } finally { await h.close(); }
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
      const observedBefore = observed.length;
      h.say(LONG);
      await until(() => h.settled() === 2, 'the long message\'s turn');
      await until(h.idle, 'the framework idle');
      assert.equal(h.exhausted().at(-1)!.errorType, 'empty_compile');
      assert.equal(h.membrane.sent.length, sentBefore, 'nothing is sent');
      assert.equal(observed.length, observedBefore, 'no compile holding only the injection was noted as sent');
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
      assert.match(err.operatorNote, /^the passthrough strategy selected none of the agent's conversation; 4 of a 4100-token budget is usable after 4096 held back for the reply\./);
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

test('a compile made while a tool-result batch holds back its reserve isn\'t refused: its request is built as before', async () => {
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
      assert.equal(sent.messages.length, 0);
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
        return true;
      });
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('the refusal reads the window that the compile read: a row presented while the compile runs neither causes a refusal nor ends one', async () => {
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new PassthroughStrategy() } as never);
    try {
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      const budget = { maxTokens: 12_000, reserveForResponse: 4_096 };
      const empty = host.compileContext(budget);
      cm.presentRows([cm.addMessage('user', [{ type: 'text', text: 'zz-late-one' }])]);
      assert.equal((await empty).messages.length, 0, 'the compile of an empty window returns as before');
      cm.presentRows([cm.addMessage('user', [{ type: 'text', text: LONG }])]);
      const blocked = host.compileContext(budget);
      cm.presentRows([cm.addMessage('user', [{ type: 'text', text: 'zz-late-two' }])]);
      await assert.rejects(blocked, (err: unknown) => {
        assert.ok(err instanceof EmptyCompileError, String(err));
        return true;
      });
      assert.ok((await host.compileContext(budget)).messages.flatMap((m) => m.content).some((b) => (b as { text?: string }).text === 'zz-late-two'));
    } finally { await cm.close(); }
  } finally { await h.close(); }
});

test('a notice whose write landed, though the write threw, counts as written: three refusals leave one notice', async () => {
  const h = await harness(4_000);
  try {
    const cm = h.framework.getAgent('resident')!.getContextManager();
    const add = cm.addMessage.bind(cm);
    cm.addMessage = ((...args: Parameters<typeof add>) => {
      const id = add(...args);
      const text = (args[1][0] as { text?: string } | undefined)?.text ?? '';
      if (text.startsWith('[inference-failed]')) throw new WriteLandedError([id], new Error('zz-listener-failed'));
      return id;
    }) as typeof cm.addMessage;
    for (let i = 1; i <= 3; i++) {
      h.say(`zz-q${i}`);
      await until(() => h.settled() === i, `message ${i}`);
    }
    await until(h.idle, 'the framework idle');
    assert.ok(h.exhausted().every((t) => t.errorType === 'empty_compile'));
    assert.equal(h.notices().length, 1);
  } finally { await h.close(); }
});

test('a compile under a subclass of passthrough that leaves rows out by design isn\'t refused: its request is sent as before', async () => {
  class Anchored extends PassthroughStrategy {
    override select(...args: Parameters<PassthroughStrategy['select']>) {
      return super.select(...args).filter(() => false);
    }
  }
  const h = await harness(12_000);
  try {
    const store = (h.framework as unknown as { store: JsStore }).store;
    const cm = await ContextManager.open({ store, namespace: 'zz-host', isolate: true, strategy: new Anchored() } as never);
    try {
      cm.presentRows([cm.addMessage('User', [{ type: 'text', text: 'zz-short' }])]);
      const host = new Agent({ name: 'zz-host', model: 'zz-model', systemPrompt: 'system', contextBudgetTokens: 12_000 } as never, cm, h.membrane.asMembrane());
      await host.runInference([]).catch(() => undefined);
      assert.equal(h.membrane.sent.length, 1, 'the request is sent');
      assert.equal(h.membrane.sent[0]!.messages.length, 0, 'holding none of the window, by the strategy\'s design');
    } finally { await cm.close(); }
  } finally { await h.close(); }
});
