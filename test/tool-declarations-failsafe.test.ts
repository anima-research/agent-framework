import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

import { AgentFramework, type EventResponse, type Module, type ModuleContext, type ProcessEvent, type ToolCall, type TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { ContextManager } from '@animalabs/context-manager';

class ChangingTools implements Module {
  readonly name = 'changing';
  names = ['a'];
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return this.names.map((name) => ({ name, description: `${name} does a thing`, inputSchema: { type: 'object' as const, properties: {} } }));
  }
  async handleToolCall(_call: ToolCall) { return { success: true, data: {} }; }
}

// membrane's yielding stream reports every failure of its request, the
// provider's refusals included, as an error event.
class RefusedStream implements YieldingStream {
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

class HostChangeAtTool implements Module {
  readonly name = 'host';
  private ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext) { this.ctx = ctx; }
  async stop() { this.ctx = null; }
  async onProcess() { return {}; }
  getTools() { return [{ name: 'look', description: 'looks around', inputSchema: { type: 'object' as const, properties: {} } }]; }
  async handleToolCall(_call: ToolCall) {
    this.ctx!.addMessage('Host', [{ type: 'system_change', defineTools: [{ name: 'zz_tool', description: 'ZZCHANGE', inputSchema: { type: 'object', properties: {} } }] } as unknown as ContentBlock]);
    return { success: true, data: {} };
  }
}

class RefusedAfterChange extends MockYieldingStream {
  handedChange = false;
  constructor(responses: NormalizedResponse[], private readonly error: Error) {
    super(responses, true);
  }

  override provideToolResults(results: unknown[], options?: { injectedMessages?: Array<{ participant?: string; content: unknown[] }> }): void {
    this.handedChange = (options?.injectedMessages ?? []).some((m) => m.content.some((b) => (b as { type?: string }).type === 'system_change'));
    super.provideToolResults(results, options);
  }

  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) {
      if (this.handedChange && next.value.type === 'complete') {
        yield { type: 'error', error: this.error } as StreamEvent;
        return;
      }
      yield next.value;
    }
  }
}

const refusal = (recognised: boolean) => Object.assign(
  new MembraneError({ type: 'invalid_request', retryable: false, message: 'role system not accepted here', rawError: { status: 400 } }),
  { httpStatus: 400 },
  recognised ? { systemChangeRefused: true } : {},
);
const refusedBeforeSending = () => Object.assign(
  new MembraneError({ type: 'invalid_request', retryable: false, message: 'this adapter sends no system changes', rawError: null }),
  { systemChangeRefused: true },
);
const filed400 = (type: 'context_length' | 'auth', message: string) => Object.assign(
  new MembraneError({ type, retryable: false, message, rawError: { status: 400 } }),
  { httpStatus: 400 },
);
const serverError = () => Object.assign(
  new MembraneError({ type: 'server', retryable: false, message: 'the provider broke', rawError: { status: 500 } }),
  { httpStatus: 500 },
);

const carriesChange = (request: NormalizedRequest) =>
  request.messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'system_change'));

class Input implements Module {
  readonly name = 'input';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

async function pollUntil(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

const usageOf = (n: number) => ({ inputTokens: 10 + n, outputTokens: 5, cacheCreationTokens: 200 + n, cacheReadTokens: 3000 + n });

async function turns(opts: { binds: boolean; refuse: (request: NormalizedRequest) => Error | undefined; second?: string[]; third?: boolean; refuseLater?: boolean; providerHold?: () => { holdMs: number; reason: string }; asFork?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-'));
  const membrane = new MockMembrane();
  let turn = 0;
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    const n = membrane.calls.push(request) - 1;
    const error = turn === 2 || (opts.refuseLater && turn > 2) ? opts.refuse(request) : undefined;
    return error
      ? new RefusedStream(error)
      : new MockYieldingStream([{ ...createMockResponse([{ type: 'text', text: 'done' }]), usage: usageOf(n) } as NormalizedResponse]);
  };
  const tools = new ChangingTools();
  const policyCalls: number[] = [];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{
      name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled',
      toolDeclarations: 'entries', thinkingBinding: { binds: opts.binds },
    }],
    modules: [new Input(), tools], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    errorPolicy: { maxRetries: 0, onInferenceError: (_e: Error, _name: string, attempt: number) => { policyCalls.push(attempt); return { retry: false }; } },
    ...(opts.providerHold ? { providerHold: opts.providerHold } : {}),
  });
  const internals = framework as unknown as {
    registry: { homeChannel(name: string): unknown; ownsProviderScheduling(name: string): boolean };
    providerWaits: { active(agentName: string, model: string): unknown };
  };
  if (opts.asFork) {
    const { registry } = internals;
    const home = registry.homeChannel.bind(registry);
    const owns = registry.ownsProviderScheduling.bind(registry);
    registry.homeChannel = (name) => (name === 'resident' ? { serverId: 'stub', channelId: 'channel:home' } : home(name));
    registry.ownsProviderScheduling = (name) => (name === 'resident' ? false : owns(name));
  }
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  framework.start();
  const ended = () => traces.filter((t) => t.type === 'inference:completed' || t.type === 'inference:exhausted').length;
  const send = async (text: string, n: number) => {
    turn = n;
    framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
    assert.ok(await pollUntil(() => ended() === n), `turn ${n} ended`);
  };
  try {
    await send('first', 1);
    const agent = framework.getAgent('resident')!;
    tools.names = opts.second ?? ['a', 'b'];
    await send('second', 2);
    const afterSecond = {
      onHead: !agent.declaresEntries(),
      undoDepth: framework.getUndoRedoState('resident').undoDepth,
      waitRecorded: internals.providerWaits.active('resident', 'test-model') !== undefined,
    };
    if (opts.third) {
      if (opts.refuseLater) tools.names = ['a', 'b', 'c'];
      await send('third', 3);
    }
    return { calls: membrane.calls, traces, policyCalls, ...afterSecond };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const B = 'changing--b';
const toolNames = (request: NormalizedRequest) => (request.tools ?? []).map((t) => t.name);
const resends = (traces: TraceEvent[]) => traces.filter((t) => t.type === 'head:resend').length;

describe("toolDeclarations' fail-safe", () => {
  it('resends a refused system change at once on the head, as the same turn, and keeps to its head after', async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(true) : undefined), third: true });
    assert.equal(run.calls.length, 4, 'the adopting turn, the refused request, its resend, the third turn');
    assert.equal(run.traces.filter((t) => t.type === 'inference:completed').length, 3, 'and every turn ended well');
    assert.ok(!toolNames(run.calls[1]!).includes(B), 'the refused request kept the recorded head');
    assert.equal(carriesChange(run.calls[1]!), true);
    assert.ok(toolNames(run.calls[2]!).includes(B), 'the resend carries the change in its head');
    assert.equal(carriesChange(run.calls[2]!), false);
    assert.equal(run.onHead, true, 'and the agent keeps to its head');
    assert.ok(toolNames(run.calls[3]!).includes(B) && !carriesChange(run.calls[3]!), 'so the next turn goes out on the current head too');
    assert.equal(resends(run.traces), 1);
    assert.deepEqual(run.policyCalls, [], 'the refusal never reached the error policy');
    assert.equal(run.undoDepth, 2, 'one undo checkpoint for each turn: the resend continued the second');
  });

  it("resends a refused change at once, though the host's provider hold would hold a retry", async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(true) : undefined), providerHold: () => ({ holdMs: 600_000, reason: 'zz hold' }) });
    assert.equal(run.calls.length, 3, 'the adopting turn, the refused request, its resend');
    assert.equal(carriesChange(run.calls[2]!), false, 'the resend, on the head');
    assert.equal(run.traces.filter((t) => t.type === 'inference:completed').length, 2, 'and the turn ended well');
  });

  it("records no provider wait from a refusal it resends at once on the head, though the refusal states one, for a conversation fork", async () => {
    const refusedWithWait = () => Object.assign(refusal(true), { retryAfterMs: 600_000 });
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusedWithWait() : undefined), asFork: true });
    assert.equal(run.calls.length, 3, 'the adopting turn, the refused request, its resend');
    assert.equal(carriesChange(run.calls[2]!), false, 'the resend, on the head');
    assert.equal(run.waitRecorded, false, 'no wait recorded for its model');
  });

  it('counts a failure of the resend from 1, as a retry of the same turn, and never shows the policy the refusal', async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(true) : serverError()) });
    assert.equal(run.calls.length, 3, 'the adopting turn, the refused request, its resend');
    assert.equal(carriesChange(run.calls[2]!), false, 'the resend, which failed');
    assert.deepEqual(run.policyCalls, [1], 'the policy saw the resend\'s failure as attempt 1, and nothing of the refusal');
    assert.equal(run.traces.filter((t) => t.type === 'inference:exhausted').length, 1);
  });

  it('resends after membrane\'s own refusal before sending, which has no HTTP status', async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusedBeforeSending() : undefined) });
    assert.equal(run.calls.length, 3);
    assert.equal(run.onHead, true);
  });

  it('resends after a 400 membrane doesn\'t recognise, binding or not, and says so to the operator', async () => {
    for (const binds of [true, false]) {
      const run = await turns({ binds, refuse: (r) => (carriesChange(r) ? refusal(false) : undefined) });
      assert.equal(run.calls.length, 3, `binds ${binds}: a resend`);
      assert.ok(toolNames(run.calls[2]!).includes(B) && !carriesChange(run.calls[2]!));
      assert.equal(run.onHead, true);
      assert.deepEqual(run.policyCalls, []);
      const alerts = run.traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend');
      assert.equal(alerts.length, 1, `binds ${binds}: one operator line`);
      const alert = alerts[0] as { message: string; data?: { httpStatus?: number } };
      assert.match(alert.message, /role system not accepted here/, 'quoting the 400');
      assert.match(alert.message, /keeps to its head until it's built again/);
      assert.equal(/can set aside the thinking/.test(alert.message), binds, `binds ${binds}: the thinking's cost said only where it can be paid`);
      assert.equal(alert.data?.httpStatus, 400);
    }
  });

  it("tells the operator of a refusal membrane recognises, with the remedy, once in the agent's build", async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(true) : undefined), third: true, refuseLater: true });
    assert.equal(run.onHead, true, 'the premise: the refusal kept the agent to its head');
    assert.equal(carriesChange(run.calls.at(-1)!), false, 'the premise: the third turn, after its tools changed again, carried no change to refuse');
    const alerts = run.traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend') as Array<{ message: string; data?: { httpStatus?: number } }>;
    assert.equal(alerts.length, 1, 'one operator line for the build');
    assert.match(alerts[0]!.message, /membrane refused a system change, so it goes again on the agent's head/);
    assert.match(alerts[0]!.message, /keeps to its head until it's built again/);
    assert.match(alerts[0]!.message, /set toolDeclarations: 'head' on it; where membrane refused the change before sending it, send through a formatter and an adapter that send system changes/);
    assert.equal(alerts[0]!.data?.httpStatus, undefined, 'naming no 400 of its own');
  });

  it('leaves a failure that isn\'t a 400 to the error policy', async () => {
    const after500 = await turns({ binds: false, refuse: (r) => (carriesChange(r) ? serverError() : undefined) });
    assert.equal(after500.calls.length, 2, 'a 500 is the error policy\'s');
    assert.equal(after500.onHead, false);
    assert.deepEqual(after500.policyCalls, [0]);
  });

  for (const [type, message] of [['context_length', 'prompt is too long: 210000 tokens > 200000 maximum'], ['auth', 'your credit balance is too low']] as const) {
    it(`leaves a 400 membrane files as ${type} to the error policy, though the request carried a change, and stays on 'entries'`, async () => {
      const run = await turns({ binds: false, refuse: (r) => (carriesChange(r) ? filed400(type, message) : undefined) });
      assert.equal(run.calls.length, 2, 'no resend on the head');
      assert.equal(resends(run.traces), 0);
      assert.equal(run.onHead, false, "it still declares 'entries'");
      assert.deepEqual(run.policyCalls, [0], 'the error policy had it');
    });

    it(`resends on the head a refusal membrane recognises, though it files it as ${type}`, async () => {
      const run = await turns({ binds: false, refuse: (r) => (carriesChange(r) ? Object.assign(filed400(type, message), { systemChangeRefused: true }) : undefined) });
      assert.equal(run.calls.length, 3, 'a resend on the head');
      assert.equal(resends(run.traces), 1);
      assert.equal(run.onHead, true, 'and it keeps to its head');
      assert.deepEqual(run.policyCalls, [], 'the error policy never had it');
    });
  }

  it('leaves a refused request that carried no change to the error policy, whatever the refusal', async () => {
    const run = await turns({ binds: false, second: ['a'], refuse: () => refusal(true) });
    assert.equal(run.calls.length, 2, 'no resend');
    assert.equal(carriesChange(run.calls[1]!), false);
    assert.equal(run.onHead, false);
    assert.equal(resends(run.traces), 0);
    assert.deepEqual(run.policyCalls, [0], 'the error policy had it');
  });
});

const overloaded = () => Object.assign(
  new MembraneError({ type: 'server', retryable: true, message: 'the provider is overloaded', rawError: { status: 503 } }),
  { httpStatus: 503 },
);

async function rearmed(later: () => Error | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-rearm-'));
  const membrane = new MockMembrane();
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    const n = membrane.calls.push(request) - 1;
    const error = n === 0 ? undefined : n === 1 ? overloaded() : later();
    return error
      ? new RefusedStream(error)
      : new MockYieldingStream([{ ...createMockResponse([{ type: 'text', text: 'done' }]), usage: usageOf(n) } as NormalizedResponse]);
  };
  const tools = new ChangingTools();
  const policyCalls: number[] = [];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{
      name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled',
      toolDeclarations: 'entries', thinkingBinding: { binds: true },
    }],
    modules: [new Input(), tools], syncIntervalMs: 0, maintenanceIntervalMs: 0, exhaustedTurnRearmMs: [50, 50],
    errorPolicy: {
      maxRetries: 1,
      onInferenceError: (error: Error, _name: string, attempt: number) => {
        policyCalls.push(attempt);
        return { retry: policyCalls.length <= 4 && error instanceof MembraneError && error.type === 'invalid_request', delayMs: 0 };
      },
    },
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  framework.start();
  const count = (type: string) => traces.filter((t) => t.type === type).length;
  const held = () => ((framework.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { heldRequests: number } }> })
    .agents.find((a) => a.name === 'resident')!).providerAdmission.heldRequests;
  const say = (text: string) => framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
  try {
    say('first');
    assert.ok(await pollUntil(() => count('inference:completed') === 1), 'the first turn adopted its head');
    tools.names = ['a', 'b'];
    say('second');
    const done = await pollUntil(() => count('inference:completed') === 2 || count('inference:exhausted') === 2);
    return { done, calls: membrane.calls, traces, policyCalls, held: held(), completed: count('inference:completed'), exhausted: count('inference:exhausted') };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("toolDeclarations' fail-safe in a re-armed turn", () => {
  it('resends a re-armed send refused for its system change once, at once, on the head, and the resend answers the turn', async () => {
    let refused = 0;
    const run = await rearmed(() => (refused++ === 0 ? refusal(true) : undefined));
    assert.ok(run.done, 'the re-armed turn ended');
    assert.equal(run.completed, 2, 'it completed');
    assert.equal(run.calls.length, 4, 'the adopting turn, the overloaded send, the re-armed send, its resend');
    assert.equal(carriesChange(run.calls[2]!), true, 'the re-armed send carried the change');
    assert.ok(toolNames(run.calls[3]!).includes(B) && !carriesChange(run.calls[3]!), 'the resend went out on the head');
    assert.equal(resends(run.traces), 1);
    assert.deepEqual(run.policyCalls, [0], 'the policy saw the overloaded send alone');
  });

  it('ends a re-armed turn whose resend is refused again, with no third send and no retry, even under a policy that would retry it', async () => {
    const run = await rearmed(() => refusal(true));
    assert.ok(run.done, 'the re-armed turn ended');
    assert.equal(run.exhausted, 2, 'the overloaded turn and the re-armed one ended exhausted');
    assert.equal(run.calls.length, 4, 'the adopting turn, the overloaded send, the re-armed send, its resend, and nothing after');
    assert.equal(carriesChange(run.calls[3]!), false, 'the resend carried no change');
    assert.equal(resends(run.traces), 1);
    assert.deepEqual(run.policyCalls, [0], 'the policy never saw the re-armed turn\'s refusals');
    assert.equal(run.held, 0, 'a refusal is no transient failure, so nothing is re-armed');
  });

  it("resends at once on the head when the refused request is a later round, given a host's change at a tool boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-'));
    const membrane = new MockMembrane();
    let refusedRound: RefusedAfterChange | undefined;
    membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      const n = membrane.calls.push(request) - 1;
      if (n !== 1) return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
      refusedRound = new RefusedAfterChange([
        createMockResponse([{ type: 'tool_use', id: 'look-1', name: 'host--look', input: {} } as ContentBlock], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'done' }]),
      ], refusal(true));
      return refusedRound;
    };
    const policyCalls: number[] = [];
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{
        name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled',
        toolDeclarations: 'entries',
      }],
      modules: [new Input(), new HostChangeAtTool()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: { maxRetries: 0, onInferenceError: (_e: Error, _name: string, attempt: number) => { policyCalls.push(attempt); return { retry: false }; } },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();
    const ended = () => traces.filter((t) => t.type === 'inference:completed' || t.type === 'inference:exhausted').length;
    try {
      for (const [text, n] of [['first', 1], ['second', 2]] as const) {
        framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
        assert.ok(await pollUntil(() => ended() === n), `turn ${n} ended`);
      }
      assert.equal(carriesChange(membrane.calls[1]!), false, "the turn's first request carried no change");
      assert.equal(refusedRound?.handedChange, true, 'its next round was handed the change, and refused');
      assert.equal(membrane.calls.length, 3, 'the adopting turn, the refused stream, its resend');
      assert.equal(carriesChange(membrane.calls[2]!), false, 'the resend went out on the head');
      assert.equal(resends(traces), 1);
      assert.deepEqual(policyCalls, [], 'the refusal never reached the error policy');
      assert.equal(traces.filter((t) => t.type === 'inference:completed').length, 2, 'and the turn the resend continued ended well');
      assert.equal(framework.getAgent('resident')!.declaresEntries(), false, 'the agent keeps to its head');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("toolDeclarations' fail-safe with a model that binds thinking to its prefix", () => {
  class HostChange implements Module {
    readonly name = 'host';
    ctx: ModuleContext | null = null;
    async start(ctx: ModuleContext) { this.ctx = ctx; }
    async stop() { this.ctx = null; }
    async onProcess() { return {}; }
    getTools() { return [{ name: 'a', description: 'a does a thing', inputSchema: { type: 'object' as const, properties: {} } }]; }
    async handleToolCall(_call: ToolCall) { return { success: true, data: {} }; }
  }
  const canonical = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'cache_control' || k === 'cacheControl' ? undefined : x));
  const prefixHash = (r: NormalizedRequest, upTo: number) => createHash('sha256')
    .update(canonical({ system: r.system, tools: (r.tools ?? []).map((t) => t.name), messages: r.messages.slice(0, upTo) })).digest('hex');
  const misboundThinking = (r: NormalizedRequest) => r.messages.some((m, i) => m.content.some((b) =>
    (b as { type?: string }).type === 'thinking' && (b as { signature?: string }).signature !== prefixHash(r, i)));
  const thinkingIn = (r: NormalizedRequest) => r.messages.flatMap((m) => m.content.filter((b) => (b as { type?: string }).type === 'thinking')).length;

  class RefusedTwoBoundariesOn extends RefusedAfterChange {
    boundaries = 0;
    override provideToolResults(results: unknown[], options?: { injectedMessages?: Array<{ participant?: string; content: unknown[] }> }): void {
      this.boundaries++;
      super.provideToolResults(results, options);
      if (this.boundaries < 2) this.handedChange = false;
    }
  }

  async function refusedAtALaterRound(noteLands: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-rounds-'));
    const membrane = new MockMembrane();
    const outcomes: string[] = [];
    const carriesMisbound = (request: NormalizedRequest) => request.messages.some((m) => m.content.some((b) => (b as { signature?: string }).signature === 'signed-over-the-change'));
    membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      const n = membrane.calls.push(request) - 1;
      if (n === 1) {
        outcomes.push('refused at a later round');
        return new RefusedTwoBoundariesOn([
          createMockResponse([{ type: 'thinking', thinking: 'before the change', signature: 'signed-before' } as ContentBlock, { type: 'tool_use', id: 'look-1', name: 'host--look', input: {} } as ContentBlock], 'tool_use'),
          createMockResponse([{ type: 'thinking', thinking: 'after the change', signature: 'signed-over-the-change' } as ContentBlock, { type: 'tool_use', id: 'look-2', name: 'host--look', input: {} } as ContentBlock], 'tool_use'),
          createMockResponse([{ type: 'text', text: 'done' }]),
        ], refusal(true));
      }
      if (carriesMisbound(request)) {
        outcomes.push('refused: thinking signed over the change');
        return new RefusedStream(Object.assign(new MembraneError({ type: 'invalid_request', retryable: false, message: 'thinking signature not valid for this prefix', rawError: { status: 400 } }), { httpStatus: 400 }));
      }
      outcomes.push('answered');
      return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
    };
    const proto = ContextManager.prototype as { noteThinkingDropped(ids: readonly string[], compileId: string): boolean };
    const note = proto.noteThinkingDropped;
    if (!noteLands) proto.noteThinkingDropped = () => false;
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled', toolDeclarations: 'entries', thinkingBinding: { binds: true } }],
      modules: [new Input(), new HostChangeAtTool()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();
    const ended = () => traces.filter((t) => t.type === 'inference:completed' || t.type === 'inference:exhausted' || t.type === 'inference:failed').length;
    try {
      for (const [text, n] of [['first', 1], ['second', 2], ['third', 3]] as const) {
        const before = ended();
        framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
        assert.ok(await pollUntil(() => ended() > before), `turn ${n} ended`);
      }
      return { traces, outcomes };
    } finally {
      proto.noteThinkingDropped = note;
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("sets aside the thinking of a later round's reply after a change handed at a boundary, when a round after it is refused", async () => {
    const { traces, outcomes } = await refusedAtALaterRound(true);
    const resend = traces.filter((t) => t.type === 'head:resend');
    assert.equal(resend.length, 1);
    assert.deepEqual(outcomes, ['answered', 'refused at a later round', 'answered', 'answered'], 'the resend and the next turn go out without that thinking');
    assert.equal((resend[0] as { thinkingSetAside: number }).thinkingSetAside, 1, "the second round's reply, signed after the change the boundary handed");
    const alerts = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend') as Array<{ message: string }>;
    assert.equal(alerts.length, 1, 'an operator line for the recognised refusal');
    assert.doesNotMatch(alerts[0]!.message, /didn't land/, 'whose note landed');
  });

  it("says, when its note can't land, that where its head didn't move its requests can carry that thinking until those replies leave its window or it's built again, which an account that enforces the binding refuses without the drop control", async () => {
    const { traces, outcomes } = await refusedAtALaterRound(false);
    assert.deepEqual(outcomes.slice(2), ['refused: thinking signed over the change', 'refused: thinking signed over the change'], 'the resend and the next turn carry that thinking, and are refused');
    assert.equal((traces.find((t) => t.type === 'head:resend') as { thinkingSetAside: number }).thinkingSetAside, 0, 'nothing set aside');
    const alerts = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend') as Array<{ message: string; data?: { noted?: boolean } }>;
    assert.equal(alerts.length, 1, 'an operator line, though the refusal was recognised');
    assert.match(alerts[0]!.message, /didn't land, so, where its head didn't move with the refusal \(a move sets every earlier reply's thinking aside\), its requests can carry that thinking until those replies leave its window or it's built again, and without thinkingBinding\.dropBlock an account that enforces the binding refuses them/);
    assert.equal(alerts[0]!.data?.noted, false);
  });

  for (const recognised of [false, true]) {
    it(`recovers after a refusal (${recognised ? 'recognised' : 'an unrecognised 400'}) keeps it to its head: no request sends thinking signed under a prefix that held a host's change row`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-binds-'));
      const membrane = new MockMembrane();
      let turn = 0;
      let refused = false;
      const outcomes: string[] = [];
      membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
        membrane.calls.push(request);
        if (misboundThinking(request)) {
          outcomes.push('refused: thinking under another prefix');
          return new RefusedStream(Object.assign(new MembraneError({ type: 'invalid_request', retryable: false, message: 'thinking signature not valid for this prefix', rawError: { status: 400 } }), { httpStatus: 400 }));
        }
        if (turn === 2 && !refused && carriesChange(request)) {
          refused = true;
          outcomes.push('refused: the change');
          return new RefusedStream(refusal(recognised));
        }
        outcomes.push('answered');
        return new MockYieldingStream([createMockResponse([{ type: 'thinking', thinking: 'why', signature: prefixHash(request, request.messages.length) } as ContentBlock, { type: 'text', text: 'done' }])]);
      };
      const host = new HostChange();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled', toolDeclarations: 'entries', thinkingBinding: { binds: true } }],
        modules: [new Input(), host], syncIntervalMs: 0, maintenanceIntervalMs: 0,
        errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      framework.start();
      const ended = () => traces.filter((t) => t.type === 'inference:completed' || t.type === 'inference:exhausted' || t.type === 'inference:failed').length;
      try {
        assert.ok(await pollUntil(() => host.ctx !== null));
        host.ctx!.addMessage('Host', [{ type: 'system_change', defineTools: [{ name: 'zz_tool', description: 'ZZ', inputSchema: { type: 'object', properties: {} } }] } as unknown as ContentBlock]);
        for (const [text, n] of [['first', 1], ['second', 2], ['third', 3]] as const) {
          turn = n;
          const before = ended();
          framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
          assert.ok(await pollUntil(() => ended() > before), `turn ${n} ended`);
        }
        assert.equal(carriesChange(membrane.calls[0]!), true, "the premise: the first turn sent the host's change, and its reply's thinking was signed under it");
        assert.equal(outcomes[1], 'refused: the change', 'the premise: the second turn was refused for carrying it');
        assert.equal(framework.getAgent('resident')!.declaresEntries(), false, 'the agent keeps to its head');
        assert.deepEqual(outcomes.slice(2), ['answered', 'answered'], "the resend and the next turn go out on the head with no thinking signed under the host's row");
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  it("sends a host's change row through the direct API on an 'entries' agent, so thinking signed after it goes out under its prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-direct-binds-'));
    const membrane = new MockMembrane();
    membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      membrane.calls.push(request);
      return new MockYieldingStream([createMockResponse([{ type: 'thinking', thinking: 'why', signature: prefixHash(request, request.messages.length) } as ContentBlock, { type: 'text', text: 'done' }])]);
    };
    const direct: string[] = [];
    let directSent: NormalizedRequest | undefined;
    membrane.stream = async (request: NormalizedRequest): Promise<NormalizedResponse> => {
      directSent = request;
      if (misboundThinking(request)) {
        direct.push('refused');
        throw Object.assign(new MembraneError({ type: 'invalid_request', retryable: false, message: 'thinking signature not valid for this prefix', rawError: { status: 400 } }), { httpStatus: 400 });
      }
      direct.push(carriesChange(request) ? 'answered, carrying the change' : 'answered');
      return createMockResponse([{ type: 'text', text: 'direct' }]);
    };
    const host = new HostChange();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled', toolDeclarations: 'entries', thinkingBinding: { binds: true } }],
      modules: [new Input(), host], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();
    try {
      assert.ok(await pollUntil(() => host.ctx !== null));
      host.ctx!.addMessage('Host', [{ type: 'system_change', defineTools: [{ name: 'zz_tool', description: 'ZZ', inputSchema: { type: 'object', properties: {} } }] } as unknown as ContentBlock]);
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} } as unknown as ProcessEvent);
      assert.ok(await pollUntil(() => traces.some((t) => t.type === 'inference:completed')), 'the first turn ended');
      assert.equal(carriesChange(membrane.calls[0]!), true, "the premise: the turn sent the host's change, and its reply's thinking was signed under it");
      const agent = framework.getAgent('resident')!;
      await agent.runInference(membrane.calls[0]!.tools ?? []).catch(() => undefined);
      assert.deepEqual(direct, ['answered, carrying the change'], "the direct API carries the host's row, as the agent's requests do");
      assert.equal(thinkingIn(directSent!), 1, "and the reply's thinking, signed after it");
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("the direct API on an 'entries' agent, by what its caller passes against its head and own change rows", () => {
    async function directAfter(turns: string[][], passed: (calls: readonly NormalizedRequest[]) => unknown[], binds = true) {
      const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-direct-own-'));
      const membrane = new MockMembrane();
      const misbound: boolean[] = [];
      membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
        membrane.calls.push(request);
        misbound.push(misboundThinking(request));
        return new MockYieldingStream([createMockResponse([{ type: 'thinking', thinking: 'why', signature: prefixHash(request, request.messages.length) } as ContentBlock, { type: 'text', text: 'done' }])]);
      };
      let sent: NormalizedRequest | undefined;
      let outcome = 'not sent';
      membrane.stream = async (request: NormalizedRequest): Promise<NormalizedResponse> => {
        sent = request;
        if (misboundThinking(request)) {
          outcome = 'refused';
          throw Object.assign(new MembraneError({ type: 'invalid_request', retryable: false, message: 'thinking signature not valid for this prefix', rawError: { status: 400 } }), { httpStatus: 400 });
        }
        outcome = 'answered';
        return createMockResponse([{ type: 'text', text: 'direct' }]);
      };
      const tools = new ChangingTools();
      const framework = await AgentFramework.create({
        storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled', toolDeclarations: 'entries', ...(binds ? { thinkingBinding: { binds: true } } : {}) }],
        modules: [new Input(), tools], syncIntervalMs: 0, maintenanceIntervalMs: 0,
        errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      });
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      framework.start();
      const completed = () => traces.filter((t) => t.type === 'inference:completed').length;
      try {
        for (const [i, names] of turns.entries()) {
          tools.names = names;
          framework.pushEvent({ type: 'external-message', source: 'test', content: `turn ${i + 1}`, metadata: {} } as unknown as ProcessEvent);
          assert.ok(await pollUntil(() => completed() > i), `turn ${i + 1} ended`);
        }
        const calls = [...membrane.calls];
        assert.deepEqual(misbound, turns.map(() => false), "the premise: each turn's request carried every earlier reply's thinking under its prefix");
        await framework.getAgent('resident')!.runInference(passed(calls) as never).catch(() => undefined);
        return { calls, sent: sent!, outcome };
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const changeRows = (r: NormalizedRequest) => r.messages.filter((m) => m.content.some((b) => (b as { type?: string }).type === 'system_change'));
    const definedIn = (r: NormalizedRequest) => changeRows(r).flatMap((m) => m.content.flatMap((b) => (b as { defineTools?: unknown[] }).defineTools ?? []));
    const toolNames = (r: NormalizedRequest) => (r.tools ?? []).map((t) => t.name);

    it("goes on the recorded head with both of the agent's own change rows when they net to nothing, keeping the thinking signed after them", async () => {
      const run = await directAfter([['a'], ['a', 'b'], ['a']], (calls) => calls[2]!.tools ?? []);
      assert.equal(changeRows(run.calls[2]!).length, 2, "the premise: the third turn carried b's addition and its removal");
      assert.equal(run.outcome, 'answered');
      assert.equal(changeRows(run.sent).length, 2, 'the direct request carries both rows');
      assert.equal(thinkingIn(run.sent), 3, "and every reply's thinking");
      assert.deepEqual(toolNames(run.sent), toolNames(run.calls[2]!), "on the third turn's head");
    });

    it("goes on the recorded head with both of the agent's own change rows when they net to nothing, for a model whose binding isn't declared too", async () => {
      const run = await directAfter([['a'], ['a', 'b'], ['a']], (calls) => calls[2]!.tools ?? [], false);
      assert.equal(changeRows(run.calls[2]!).length, 2, "the premise: the third turn carried b's addition and its removal");
      assert.equal(run.outcome, 'answered');
      assert.equal(changeRows(run.sent).length, 2, 'the direct request carries both rows');
      assert.equal(thinkingIn(run.sent), 3, "and every reply's thinking, under the prefix it was signed under");
    });

    it("goes on the recorded head with the agent's own row when its caller passes the tools that head and row declare", async () => {
      const run = await directAfter([['a'], ['a', 'b']], (calls) => [...(calls[1]!.tools ?? []), ...definedIn(calls[1]!)]);
      assert.equal(definedIn(run.calls[1]!).length, 1, "the premise: the second turn carried b's addition");
      assert.equal(run.outcome, 'answered');
      assert.deepEqual(toolNames(run.sent), toolNames(run.calls[1]!), "on the recorded head, which doesn't hold b");
      assert.equal(definedIn(run.sent).length, 1, "with the row that adds b");
      assert.equal(thinkingIn(run.sent), 2, "and every reply's thinking");
    });

    it("leaves the agent's own row out and sets aside the thinking when its caller passes the recorded head's tools without what the row adds", async () => {
      const run = await directAfter([['a'], ['a', 'b']], (calls) => calls[1]!.tools ?? []);
      assert.equal(definedIn(run.calls[1]!).length, 1, "the premise: the second turn carried b's addition");
      assert.equal(run.outcome, 'answered');
      assert.equal(changeRows(run.sent).length, 0, 'the direct request carries no change row');
      assert.equal(thinkingIn(run.sent), 0, 'and no thinking');
      assert.deepEqual(toolNames(run.sent), toolNames(run.calls[1]!), 'and offers only what its caller passed');
    });

    it("sets aside the thinking when its caller passes a tool neither the head nor a row holds", async () => {
      const c = { name: 'zz_c', description: 'c does a thing', inputSchema: { type: 'object' as const, properties: {} } };
      const run = await directAfter([['a']], (calls) => [...(calls[0]!.tools ?? []), c]);
      assert.equal(run.outcome, 'answered');
      assert.ok(toolNames(run.sent).includes('zz_c'), 'the direct request offers what its caller passed');
      assert.equal(thinkingIn(run.sent), 0, 'and carries no thinking');
    });
  });
});
