import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { ChannelRef, ErrorAction, ErrorPolicy, EventResponse, InferenceRequest, Module, ProcessEvent, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import type { ContextInjection } from '@animalabs/context-manager';
import type { NormalizedResponse } from '@animalabs/membrane';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { ChannelRegistry, destinationKey } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

type Internals = {
  initializeMcpl(servers: []): Promise<void>;
  channelRegistry: ChannelRegistry;
  mcplServerRegistry: McplServerRegistry;
  pendingRequests: InferenceRequest[];
  processInferenceRequests(): Promise<void>;
  hookOrchestrator: { emitLifecycle(params: { conversationId: string; phase: string }): void } | null;
  providerWaits: { set(agentName: string, model: string, ms: number, why: string): void };
  agents: Map<string, unknown>;
  turnRouting: Map<string, { typing?: ChannelRef }>;
  openLogical: Map<string, unknown>;
  recordTurnCheckpoint(agentName: string): unknown;
  noticeHeadMoves(agent: unknown): void;
};

const aGeneral: ChannelRef = { serverId: 'a', channelId: 'general' };
const bGeneral: ChannelRef = { serverId: 'b', channelId: 'general' };
const bLounge: ChannelRef = { serverId: 'b', channelId: 'lounge' };
const where = (ref: ChannelRef) => `${ref.serverId} ${ref.channelId}`;

class Gate {
  promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((resolve) => { this.open = resolve; }); }
}

class PerAgentMembrane extends MockMembrane {
  readonly script = new Map<string, Array<() => YieldingStream>>();
  readonly made: string[] = [];
  next(agentName: string, make: () => YieldingStream): void {
    const queue = this.script.get(agentName) ?? [];
    queue.push(make);
    this.script.set(agentName, queue);
  }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const name = request.assistantParticipant ?? '';
    this.made.push(name);
    const make = this.script.get(name)?.shift();
    return make ? make() : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'noted' }])]);
  }
}

const answer = () => [createMockResponse([{ type: 'text', text: 'noted' }])];
class HeldUntil extends MockYieldingStream {
  constructor(private readonly gate: Gate) { super(answer()); }
  override cancel(): void { this.gate.open(); super.cancel(); }
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    await this.gate.promise;
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) yield next.value;
  }
}
const held = (gate: Gate) => () => new HeldUntil(gate);
class DeafUntil extends MockYieldingStream {
  constructor(private readonly gate: Gate) { super(answer()); }
  override cancel(): void {}
  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    await this.gate.promise;
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) yield next.value;
  }
}
const deaf = (gate: Gate) => () => new DeafUntil(gate);
const retryable = () => () => new FailingStream();

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

class ToolModule implements Module {
  readonly name = 'canned';
  framework: AgentFramework | null = null;
  holdFirstTool = false;
  holdFor = 'scout';
  hooks: Gate | null = null;
  readonly hooksEntered = new Gate();
  private calls = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'blob', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    if (++this.calls > 1) return { success: true, data: { ok: true } };
    if (this.holdFirstTool) (this.framework as unknown as Internals).providerWaits.set(this.holdFor, 'test-model', 120_000, 'stated while the tool ran');
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
  }
  async gatherContext(): Promise<ContextInjection[]> {
    const hooks = this.hooks;
    this.hooks = null;
    if (hooks) {
      this.hooksEntered.open();
      await hooks.promise;
    }
    return [];
  }
  async onProcess(_event: ProcessEvent): Promise<EventResponse> { return {}; }
}

function nearCapToolResponse(): NormalizedResponse {
  const r = createMockResponse([{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} }], 'tool_use');
  (r as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
  return r;
}
const restarts = () => () => new MockYieldingStream([nearCapToolResponse(), ...answer()]);

const noRetry: ErrorPolicy = { maxRetries: 0, onInferenceError: (): ErrorAction => ({ retry: false }) };
const retryLater: ErrorPolicy = { maxRetries: 1, onInferenceError: (): ErrorAction => ({ retry: true, delayMs: 60_000 }) };

const retryOnce: ErrorPolicy = {
  maxRetries: 1,
  onInferenceError: (_error: Error, _agentName: string, attempt: number): ErrorAction => (attempt === 0 ? { retry: true, delayMs: 1 } : { retry: false }),
};

async function world(t: TestContext, opts: { agents?: string[]; errorPolicy?: ErrorPolicy; inferencePolicy?: { shouldInfer(agentName: string, requests: InferenceRequest[]): boolean } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-own-typing-'));
  const membrane = new PerAgentMembrane();
  const names = opts.agents ?? ['scout'];
  const module = new ToolModule();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: names.map((name) => ({
      name, model: 'test-model', systemPrompt: `You are ${name}.`, proseRouting: 'disabled' as const,
      allowedTools: 'all' as const, maxTokens: 4_000, physicalWindowTokens: 200_000,
    })),
    modules: [module],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    ...(opts.errorPolicy ? { errorPolicy: opts.errorPolicy } : {}),
    ...(opts.inferencePolicy ? { inferencePolicy: opts.inferencePolicy as never } : {}),
  });
  module.framework = framework;
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const i = framework as unknown as Internals;
  await i.initializeMcpl([]);
  const typing: string[] = [];
  const servers = new Map(['a', 'b'].map((id) => [id, {
    id,
    isConnected: true,
    stopReconnecting() {},
    policyEstablished: true,
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsPublish: async () => ({ delivered: true, messageId: `${id}-m` }),
    sendChannelsTyping: (channelId: string, _metadata: unknown, op?: string) => {
      typing.push(`${id} ${op === 'stop' ? 'stop' : 'start'} ${channelId}`);
    },
    sendChannelsOpen: async () => ({}),
    sendBeforeInference: async () => ({ contextInjections: [] }),
  }]));
  t.mock.method(i.mcplServerRegistry, 'getServer', (id: string) => servers.get(id) as never);
  const map = (i.channelRegistry as unknown as { channels: Map<string, unknown> }).channels;
  for (const ref of [aGeneral, bGeneral, bLounge]) {
    map.set(destinationKey(ref), { serverId: ref.serverId, descriptor: { id: ref.channelId, type: 'chat', label: `#${ref.channelId}` }, open: true });
  }
  const ended: string[] = [];
  const hooks = i.hookOrchestrator;
  assert.ok(hooks, 'the hook orchestrator, whose lifecycle calls say when a frame ends');
  const emit = hooks.emitLifecycle.bind(hooks);
  hooks.emitLifecycle = (params) => { if (params.phase !== 'started') ended.push(params.conversationId); emit(params); };
  framework.start();
  let running: Promise<void> | null = null;
  const pump = setInterval(() => {
    running ??= framework.runUntilIdle().catch(() => {}).finally(() => { running = null; });
  }, 10);
  t.after(() => clearInterval(pump));
  const wake = (agentName: string, ref: ChannelRef) => {
    i.pendingRequests.push({
      agentName, reason: 'mcpl:channel-incoming', source: ref.serverId, timestamp: Date.now(),
      channelId: ref.channelId, channelServerId: ref.serverId, addressed: true,
    });
  };
  const typesAt = (ref: ChannelRef) => (i.channelRegistry as unknown as { typingIntervals: Map<string, unknown> }).typingIntervals.has(destinationKey(ref));
  const stopsAt = (ref: ChannelRef) => typing.filter((line) => line === `${ref.serverId} stop ${ref.channelId}`).length;
  const turnEnded = (name: string) => framework.getHostModeStatus().activeTurns === 0 && framework.getAgent(name)?.state.status === 'idle';
  return { framework, i, membrane, module, traces, typing, ended, wake, typesAt, stopsAt, turnEnded };
}

async function within<T>(what: string, work: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function until(what: string, ready: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const afterTeardown = () => new Promise((resolve) => setImmediate(resolve));

test("a turn's end stops typing at its own server and channel, and the host's indicator at another server's channel of the same id keeps typing", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(aGeneral);
  w.wake('scout', bGeneral);
  await until("the turn's teardown", () => w.ended.includes('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(bGeneral), 1, `one stop at its own address: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(bGeneral), false, 'and no interval left there');
  assert.equal(w.stopsAt(aGeneral), 0, `none at the other server's channel: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), true, "and the host's interval there runs on");
});

test("a child run's end, seen after its teardown, leaves a resident's indicator running until the resident's own turn ends", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bLounge);
  const resident = new Gate();
  w.membrane.next('scout', held(resident));
  w.wake('scout', aGeneral);
  await until('the resident to type', () => w.typesAt(aGeneral));
  const kid = await w.framework.createEphemeralAgent({ name: 'kid', model: 'test-model', systemPrompt: 'You are kid.' });
  kid.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
  await w.framework.runEphemeralToCompletion(kid.agent, kid.contextManager);
  await until("the child's teardown", () => w.ended.includes('kid'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 0, `the child's end stopped nothing of the resident's: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), true);
  resident.open();
  await until("the resident's own stop", () => w.stopsAt(aGeneral) === 1);
  await until("the resident's turn to end", () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, `one stop: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), false);
  assert.equal(w.stopsAt(bLounge), 0, `control: the resident's end stopped only its own: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(bLounge), true);
});

test("another agent's end leaves a resident's indicator in another channel running", async (t) => {
  const w = await world(t, { agents: ['scout', 'other'] });
  const resident = new Gate();
  w.membrane.next('scout', held(resident));
  w.wake('scout', aGeneral);
  await until('the resident to type', () => w.typesAt(aGeneral));
  w.wake('other', bLounge);
  await until("the other agent's teardown", () => w.ended.includes('other'));
  await afterTeardown();
  assert.equal(w.stopsAt(bLounge), 1, `the other agent stopped its own channel: ${w.typing.join(', ')}`);
  assert.equal(w.stopsAt(aGeneral), 0, `and not the resident's: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), true);
  resident.open();
  await until("the resident's own stop", () => w.stopsAt(aGeneral) === 1);
  await until("the resident's turn to end", () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, `one stop: ${w.typing.join(', ')}`);
  assert.equal(w.stopsAt(bLounge), 1, `the other agent's channel was stopped once: ${w.typing.join(', ')}`);
});

test("a failed stream whose retry is live leaves the retry's indicator running, and the retry's end stops it", async (t) => {
  const w = await world(t, { errorPolicy: retryOnce });
  w.framework.channels!.startTyping(bLounge);
  const retry = new Gate();
  w.membrane.next('scout', retryable());
  w.membrane.next('scout', held(retry));
  w.wake('scout', aGeneral);
  await until("the failed frame's teardown", () => w.ended.filter((name) => name === 'scout').length === 1);
  await afterTeardown();
  assert.equal(w.membrane.made.filter((name) => name === 'scout').length, 2, 'control: the retry is live');
  assert.equal(w.stopsAt(aGeneral), 0, `the failed frame stopped nothing: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), true);
  retry.open();
  await until("the retry's stop", () => w.stopsAt(aGeneral) === 1);
  await until("the turn to end", () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, `one stop: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), false);
  assert.equal(w.stopsAt(bLounge), 0, `control: neither end stopped another address: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(bLounge), true);
});

test('a turn with no typing record stops nothing, while the host types', async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(aGeneral);
  w.i.pendingRequests.push({ agentName: 'scout', reason: 'mcpl:push-event', source: 'heartbeat', timestamp: Date.now(), channelId: 'general', channelServerId: 'a', suppressProse: true });
  await until("the turn's teardown", () => w.ended.includes('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(aGeneral), true);
});

test('a failed turn with no retry stops its own channel, and not the host\'s', async (t) => {
  const w = await world(t, { errorPolicy: noRetry });
  w.framework.channels!.startTyping(bGeneral);
  w.membrane.next('scout', retryable());
  w.wake('scout', aGeneral);
  await until("the turn's teardown", () => w.ended.includes('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(bGeneral), true);
});

test("a stop while the turn waits to retry stops its own channel, and not the host's", async (t) => {
  const w = await world(t, { errorPolicy: retryLater });
  w.framework.channels!.startTyping(bGeneral);
  w.membrane.next('scout', retryable());
  w.wake('scout', aGeneral);
  await until('the wait to retry', () => w.traces.some((e) => e.type === 'inference:waiting'));
  assert.equal(w.framework.abortInference('scout', 'zz-stop-in-wait'), true);
  await until('the turn to end', () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(bGeneral), true);
});

test("an agent stopped mid-turn stops its own channel, and another agent's indicator runs on", async (t) => {
  const w = await world(t, { agents: ['scout', 'other'] });
  const scout = new Gate();
  const other = new Gate();
  w.membrane.next('scout', held(scout));
  w.membrane.next('other', held(other));
  w.wake('scout', aGeneral);
  w.wake('other', bLounge);
  await until('both to type', () => w.typesAt(aGeneral) && w.typesAt(bLounge));
  w.framework.stopAgent('other', { reason: 'zz-released' });
  await until("the stopped agent's teardown", () => w.ended.includes('other'));
  await afterTeardown();
  assert.equal(w.stopsAt(bLounge), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(aGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(aGeneral), true);
  scout.open();
});

test("a turn handed to a budget restart's continuation, still queued, keeps its indicator, and the turn's end stops it", async (t) => {
  const w = await world(t);
  w.module.holdFirstTool = true;
  w.framework.channels!.startTyping(bGeneral);
  w.membrane.next('scout', restarts());
  w.wake('scout', aGeneral);
  await until('the restart', () => w.traces.some((e) => e.type === 'inference:stream_restarted'));
  await until("the restarted frame's teardown", () => w.ended.includes('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 0, `the handed-on turn keeps its indicator: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), true);
  assert.equal(w.framework.abortInference('scout', 'zz-drop-continuation'), true);
  await until('the turn to end', () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
});

test("a continuation the inference policy drops ends its turn, which stops its own channel and not the host's", async (t) => {
  const w = await world(t, { inferencePolicy: { shouldInfer: (_name, requests) => !requests.some((r) => r.reason === 'context_budget_restart') } });
  w.framework.channels!.startTyping(bGeneral);
  w.membrane.next('scout', restarts());
  w.wake('scout', aGeneral);
  await until('the restart', () => w.traces.some((e) => e.type === 'inference:stream_restarted'));
  await until('the turn to end', () => w.turnEnded('scout') && w.stopsAt(aGeneral) > 0);
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(bGeneral), true);
});

test("a handed-on turn whose continuation's start throws before its request is built stops its own channel, and the turn ends", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  const record = w.i.recordTurnCheckpoint.bind(w.i);
  let checkpoints = 0;
  w.i.recordTurnCheckpoint = (name: string) => {
    if (++checkpoints === 2) throw new Error('zz checkpoint write failed');
    return record(name);
  };
  w.membrane.next('scout', restarts());
  w.wake('scout', aGeneral);
  await until('the restart', () => w.traces.some((e) => e.type === 'inference:stream_restarted'));
  await until('the turn to end', () => checkpoints >= 2 && w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
  assert.equal(w.i.openLogical.has('scout'), false, 'the thrown failure settled the turn: its logical turn is closed');
});

test("a run whose first start throws before it has a routing still settles with that failure", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  const record = w.i.recordTurnCheckpoint.bind(w.i);
  w.i.recordTurnCheckpoint = (name: string) => {
    if (name === 'kid') throw new Error('zz checkpoint write failed');
    return record(name);
  };
  const kid = await w.framework.createEphemeralAgent({ name: 'kid', model: 'test-model', systemPrompt: 'You are kid.' });
  kid.contextManager.addMessage('user', [{ type: 'text', text: 'Do the task.' }]);
  await assert.rejects(
    w.framework.runEphemeralToCompletion(kid.agent, kid.contextManager, { idleTimeoutMs: 20_000 }),
    (error: unknown) => /zz checkpoint write failed/.test(String((error as Error).cause)),
  );
  await afterTeardown();
  assert.equal(w.stopsAt(bGeneral), 0, `control: the failure stopped nothing elsewhere: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(bGeneral), true);
});

test("a stop while the turn's hooks run stops its own channel, and not the host's", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  const hooks = new Gate();
  w.module.hooks = hooks;
  w.wake('scout', aGeneral);
  await until('the hooks', () => w.typesAt(aGeneral));
  await within('the hooks', w.module.hooksEntered.promise);
  assert.equal(w.framework.abortInference('scout', 'zz-stop-in-hooks'), true);
  hooks.open();
  await until('the turn to end', () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
});

test("a turn assembled while its agent was replaced stops its own channel, and not the host's", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  const hooks = new Gate();
  w.module.hooks = hooks;
  w.wake('scout', aGeneral);
  await within('the hooks', w.module.hooksEntered.promise);
  const agent = w.framework.getAgent('scout')!;
  w.i.agents.set('scout', Object.create(agent));
  hooks.open();
  await until('the drop', () => w.stopsAt(aGeneral) > 0);
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
  w.i.agents.set('scout', agent);
});

test("a turn compiled while its agent was replaced stops its own channel, and not the host's", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  const agent = w.framework.getAgent('scout')!;
  const compiled = new Gate();
  const entered = new Gate();
  const annotations = agent.toolResultGuard.afterAnnotations.bind(agent.toolResultGuard);
  agent.toolResultGuard.afterAnnotations = (async (read: () => Promise<unknown>) => {
    entered.open();
    await compiled.promise;
    return annotations(read as never);
  }) as typeof agent.toolResultGuard.afterAnnotations;
  w.wake('scout', aGeneral);
  await within('the compile', entered.promise);
  w.i.agents.set('scout', Object.create(agent));
  compiled.open();
  await until('the drop', () => w.stopsAt(aGeneral) > 0);
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
  w.i.agents.set('scout', agent);
});

test("a start that throws after its agent was replaced leaves the replacement's indicator at the same address", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bLounge);
  const agent = w.framework.getAgent('scout')!;
  const notice = w.i.noticeHeadMoves.bind(w.i);
  let threw = false;
  w.i.noticeHeadMoves = (of: unknown) => {
    if (of === agent && !threw) {
      threw = true;
      const replacement = { ...w.i.turnRouting.get('scout'), typing: aGeneral };
      w.i.agents.set('scout', Object.create(agent));
      w.i.openLogical.set('scout', replacement);
      w.i.turnRouting.set('scout', replacement);
      w.framework.channels!.startTyping(aGeneral);
      throw new Error('zz a step before the compile failed');
    }
    notice(of);
  };
  w.wake('scout', aGeneral);
  await until('the throw', () => threw);
  await afterTeardown();
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 0, `the replacement's indicator is left: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(aGeneral), true);
  assert.equal(w.stopsAt(bLounge), 0, `control: ${w.typing.join(', ')}`);
  w.i.agents.set('scout', agent);
  w.i.openLogical.delete('scout');
  w.i.turnRouting.delete('scout');
});

test("a turn assembled or compiled while its agent was replaced leaves the replacement's indicator at the same address", async (t) => {
  for (const at of ['assembled', 'compiled'] as const) {
    const w = await world(t);
    w.framework.channels!.startTyping(bLounge);
    const agent = w.framework.getAgent('scout')!;
    const hold = new Gate();
    const entered = new Gate();
    if (at === 'assembled') {
      w.module.hooks = hold;
    } else {
      const annotations = agent.toolResultGuard.afterAnnotations.bind(agent.toolResultGuard);
      agent.toolResultGuard.afterAnnotations = (async (read: () => Promise<unknown>) => {
        entered.open();
        await hold.promise;
        return annotations(read as never);
      }) as typeof agent.toolResultGuard.afterAnnotations;
    }
    w.wake('scout', aGeneral);
    await within(`the ${at === 'assembled' ? 'hooks' : 'compile'}`, at === 'assembled' ? w.module.hooksEntered.promise : entered.promise);
    const current = w.i.turnRouting.get('scout')!;
    w.i.agents.set('scout', Object.create(agent));
    w.i.turnRouting.set('scout', { ...current, typing: aGeneral });
    hold.open();
    await until('the drop', () => w.traces.some((e) => e.type === 'inference:aborted'));
    await afterTeardown();
    assert.equal(w.stopsAt(aGeneral), 0, `${at}: the replacement keeps the same address: ${w.typing.join(', ')}`);
    assert.equal(w.typesAt(aGeneral), true);
    assert.equal(w.stopsAt(bLounge), 0, `${at}: control: ${w.typing.join(', ')}`);
    w.i.agents.set('scout', agent);
  }
});

test("a provider wait stated while the turn compiled holds the turn, and stops its own channel, not the host's", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  const agent = w.framework.getAgent('scout')!;
  const annotations = agent.toolResultGuard.afterAnnotations.bind(agent.toolResultGuard);
  let first = true;
  agent.toolResultGuard.afterAnnotations = (async (read: () => Promise<unknown>) => {
    if (first) { first = false; w.i.providerWaits.set('scout', 'test-model', 120_000, 'stated while the turn compiled'); }
    return annotations(read as never);
  }) as typeof agent.toolResultGuard.afterAnnotations;
  w.wake('scout', aGeneral);
  await until('the hold', () => w.stopsAt(aGeneral) > 0);
  await afterTeardown();
  assert.ok(w.traces.some((e) => e.type === 'inference:failed'), 'control: the turn was held at the failure that the wait reports');
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
});

test("a turn whose compile throws stops its own channel, and not the host's", async (t) => {
  const w = await world(t, { errorPolicy: noRetry });
  w.framework.channels!.startTyping(bGeneral);
  const agent = w.framework.getAgent('scout')!;
  agent.startStreamWithInjections = (async () => { throw new Error('zz compile failed'); }) as typeof agent.startStreamWithInjections;
  w.wake('scout', aGeneral);
  await until('the failure', () => w.traces.some((e) => e.type === 'inference:exhausted' || e.type === 'inference:failed'));
  await until('the turn to end', () => w.turnEnded('scout'));
  await afterTeardown();
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
});

test("staged at the teardown's own condition: a newer stream of the agent typing at another server's channel of the same id leaves the old frame to stop its own; one typing at the same address keeps it", async (t) => {
  for (const newerAt of [bGeneral, aGeneral]) {
    const w = await world(t);
    w.framework.channels!.startTyping(bLounge);
    const gate = new Gate();
    w.membrane.next('scout', held(gate));
    w.wake('scout', aGeneral);
    await until('the held stream', () => w.membrane.made.includes('scout') && w.typesAt(aGeneral));
    if (newerAt === bGeneral) w.framework.channels!.startTyping(bGeneral);
    const agent = w.framework.getAgent('scout')!;
    const current = w.i.turnRouting.get('scout')!;
    w.i.turnRouting.set('scout', { ...current, typing: newerAt });
    const id = agent.streamId;
    Object.defineProperty(agent, 'streamId', { configurable: true, get: () => id + 1_000 });
    gate.open();
    await until("the old frame's teardown", () => w.ended.includes('scout'));
    await afterTeardown();
    if (newerAt === bGeneral) {
      assert.equal(w.stopsAt(aGeneral), 1, `the old frame stops its own channel: ${w.typing.join(', ')}`);
      assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
      assert.equal(w.typesAt(bGeneral), true);
    } else {
      assert.equal(w.stopsAt(aGeneral), 0, `the newer stream keeps the same address: ${w.typing.join(', ')}`);
      assert.equal(w.typesAt(aGeneral), true);
    }
    assert.equal(w.stopsAt(bLounge), 0, `control: ${w.typing.join(', ')}`);
  }
});

test("stopAgent on an agent whose stream doesn't answer its cancel stops its channel at once, and not the host's", async (t) => {
  const w = await world(t, { agents: ['scout', 'other'] });
  const gate = new Gate();
  t.after(() => gate.open());
  w.framework.channels!.startTyping(aGeneral);
  w.membrane.next('other', deaf(gate));
  w.wake('other', bLounge);
  await until('the held stream', () => w.membrane.made.includes('other') && w.typesAt(bLounge));
  w.framework.stopAgent('other', { reason: 'zz-released' });
  await until('the stop', () => w.stopsAt(bLounge) === 1);
  assert.equal(w.ended.includes('other'), false, "control: the old frame hasn't ended");
  assert.equal(w.stopsAt(aGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(aGeneral), true);
  w.framework.channels!.startTyping(bLounge);
  gate.open();
  await until("the old frame's late end", () => w.ended.includes('other'));
  await afterTeardown();
  assert.equal(w.stopsAt(bLounge), 1, `the late end stops nothing a second time: ${w.typing.join(', ')}`);
  assert.equal(w.typesAt(bLounge), true, "the host's new indicator there runs on");
});

test("stopAgent while the turn's hooks run stops its channel at once, and not the host's", async (t) => {
  const w = await world(t, { agents: ['scout', 'other'] });
  const hooks = new Gate();
  t.after(() => hooks.open());
  w.framework.channels!.startTyping(aGeneral);
  w.module.hooks = hooks;
  w.wake('other', bLounge);
  await until('the turn to type', () => w.typesAt(bLounge));
  await within('the hooks', w.module.hooksEntered.promise);
  w.framework.stopAgent('other', { reason: 'zz-released' });
  await until('the stop', () => w.stopsAt(bLounge) === 1);
  assert.equal(w.stopsAt(aGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(aGeneral), true);
  hooks.open();
  await until("the start's drop after its hooks", () => w.traces.some((e) => e.type === 'inference:aborted' && (e as { agentName?: string }).agentName === 'other'));
  await afterTeardown();
  assert.equal(w.stopsAt(bLounge), 1, `the drop stops nothing a second time: ${w.typing.join(', ')}`);
  assert.equal(w.stopsAt(aGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(aGeneral), true);
});

test("an agent stopped while its turn's continuation waits stops the turn's channel, and not the host's", async (t) => {
  const w = await world(t, { agents: ['scout', 'other'] });
  w.module.holdFirstTool = true;
  w.module.holdFor = 'other';
  w.framework.channels!.startTyping(aGeneral);
  w.membrane.next('other', restarts());
  w.wake('other', bLounge);
  await until('the restart', () => w.traces.some((e) => e.type === 'inference:stream_restarted'));
  await until("the restarted frame's teardown", () => w.ended.includes('other'));
  await afterTeardown();
  assert.equal(w.stopsAt(bLounge), 0, 'control: the handed-on turn kept its indicator');
  w.framework.stopAgent('other', { reason: 'zz-released' });
  await until('the stop', () => w.stopsAt(bLounge) === 1);
  assert.equal(w.stopsAt(aGeneral), 0, w.typing.join(', '));
  assert.equal(w.typesAt(aGeneral), true);
});

test("the framework's stop sends a stop to a host's indicator when no turn is live", async (t) => {
  const w = await world(t);
  w.framework.channels!.startTyping(bGeneral);
  await within('the stop', w.framework.stop());
  assert.equal(w.stopsAt(bGeneral), 1, w.typing.join(', '));
});

test("the framework's stop sends a stop to every indicator still running, the host's too", async (t) => {
  const w = await world(t);
  const gate = new Gate();
  w.framework.channels!.startTyping(bGeneral);
  w.membrane.next('scout', held(gate));
  w.wake('scout', aGeneral);
  await until('the held stream', () => w.membrane.made.includes('scout') && w.typesAt(aGeneral));
  await within('the stop', w.framework.stop());
  assert.equal(w.stopsAt(aGeneral), 1, w.typing.join(', '));
  assert.equal(w.stopsAt(bGeneral), 1, w.typing.join(', '));
});

test("staged at the teardown's own condition: an agent replaced under its name, whose replacement types at the same address, keeps the indicator; one typing elsewhere leaves the old frame to stop its own", async (t) => {
  for (const replacementAt of [aGeneral, bGeneral]) {
    const w = await world(t);
    w.framework.channels!.startTyping(bLounge);
    const gate = new Gate();
    w.membrane.next('scout', held(gate));
    w.wake('scout', aGeneral);
    await until('the held stream', () => w.membrane.made.includes('scout') && w.typesAt(aGeneral));
    if (replacementAt === bGeneral) w.framework.channels!.startTyping(bGeneral);
    const agent = w.framework.getAgent('scout')!;
    const current = w.i.turnRouting.get('scout')!;
    w.i.agents.set('scout', Object.create(agent));
    w.i.turnRouting.set('scout', { ...current, typing: replacementAt });
    gate.open();
    await until("the old frame's teardown", () => w.ended.includes('scout'));
    await afterTeardown();
    if (replacementAt === aGeneral) {
      assert.equal(w.stopsAt(aGeneral), 0, `the replacement keeps the same address: ${w.typing.join(', ')}`);
      assert.equal(w.typesAt(aGeneral), true);
    } else {
      assert.equal(w.stopsAt(aGeneral), 1, `the old frame stops its own channel: ${w.typing.join(', ')}`);
      assert.equal(w.stopsAt(bGeneral), 0, w.typing.join(', '));
    }
    assert.equal(w.stopsAt(bLounge), 0, `control: ${w.typing.join(', ')}`);
    w.i.agents.set('scout', agent);
  }
});

