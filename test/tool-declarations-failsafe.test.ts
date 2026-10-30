import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

import { AgentFramework, type EventResponse, type Module, type ModuleContext, type ProcessEvent, type ToolCall, type TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

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
const inputOf = (n: number) => { const u = usageOf(n); return u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens; };

async function turns(opts: { binds: boolean; refuse: (request: NormalizedRequest) => Error | undefined; second?: string[]; third?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-'));
  const membrane = new MockMembrane();
  let turn = 0;
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    const n = membrane.calls.push(request) - 1;
    const error = turn === 2 ? opts.refuse(request) : undefined;
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
  });
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
    const input = () => (agent as unknown as { lastResponseInputTokens?: number }).lastResponseInputTokens;
    const inputs = [input()];
    tools.names = opts.second ?? ['a', 'b'];
    await send('second', 2);
    inputs.push(input());
    const afterSecond = { onHead: !agent.declaresEntries(), undoDepth: framework.getUndoRedoState('resident').undoDepth };
    if (opts.third) {
      await send('third', 3);
      inputs.push(input());
    }
    return { calls: membrane.calls, traces, policyCalls, inputs, ...afterSecond };
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
      assert.equal(/sets aside the thinking/.test(alert.message), binds, `binds ${binds}: the thinking's cost said only where it's paid`);
      assert.equal(alert.data?.httpStatus, 400);
    }
    const recognised = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(true) : undefined) });
    assert.equal(recognised.traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend').length, 0, 'a refusal membrane recognises needs none');
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

  it('hands each answer\'s whole input to the agent: fresh, cache written and cache read', async () => {
    const run = await turns({ binds: true, refuse: () => undefined, third: true });
    assert.equal(run.calls.length, 3);
    assert.deepEqual(run.inputs, [inputOf(0), inputOf(1), inputOf(2)], 'the latest answer\'s, after each turn');
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
        return { retry: error instanceof MembraneError && error.type === 'invalid_request', delayMs: 0 };
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
