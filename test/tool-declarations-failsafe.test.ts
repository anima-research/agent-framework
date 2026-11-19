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
import { foldOf } from './helpers/declared.js';
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

// A stream stopped before its first event: membrane's first event for it says so.
class AbortedStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'aborted', reason: 'user' } as StreamEvent;
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

async function turns(opts: { binds: boolean; refuse: (request: NormalizedRequest) => Error | undefined; second?: string[]; effort?: 'high'; third?: boolean; refuseLater?: boolean; providerHold?: () => { holdMs: number; reason: string }; asFork?: boolean; abortRetry?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-'));
  const membrane = new MockMembrane();
  membrane.takesChanges = true;
  let turn = 0;
  membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
    const n = membrane.calls.push(request) - 1;
    if (opts.abortRetry && n === 2) return new AbortedStream();
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
      thinkingBinding: { binds: opts.binds },
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
  const ended = () => traces.filter((t) => t.type === 'inference:completed' || t.type === 'inference:exhausted' || t.type === 'inference:aborted').length;
  const send = async (text: string, n: number) => {
    turn = n;
    framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
    assert.ok(await pollUntil(() => ended() === n), `turn ${n} ended`);
  };
  try {
    await send('first', 1);
    const agent = framework.getAgent('resident')!;
    tools.names = opts.second ?? ['a', 'b'];
    if (opts.effort) (framework as unknown as { addMessage(participant: string, content: ContentBlock[]): string }).addMessage('system', [{ type: 'system_change', effort: opts.effort } as unknown as ContentBlock]);
    await send('second', 2);
    const afterSecond = {
      onHead: !agent.takesChanges(),
      moved: traces.filter((t) => t.type === 'head:moved').map((t) => (t as { why: string }).why),
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

describe('the fail-safe for a refused change', () => {
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

  it("goes once more in the fallback form after a 400 membrane doesn't recognise, and keeps to its head once that request is accepted, saying so to the operator", async () => {
    for (const binds of [true, false]) {
      const run = await turns({ binds, refuse: (r) => (carriesChange(r) ? refusal(false) : undefined), third: true });
      assert.equal(run.calls.length, 4, `binds ${binds}: the adopting turn, the refused request, its retry, the third turn`);
      assert.ok(toolNames(run.calls[2]!).includes(B) && !carriesChange(run.calls[2]!), 'the retry went on the current tools with no change row');
      assert.deepEqual(run.moved, ['adopted'], 'and moved no head');
      assert.equal(run.onHead, true, 'its acceptance keeps the agent to its head');
      assert.ok(toolNames(run.calls[3]!).includes(B) && !carriesChange(run.calls[3]!), 'so the next turn goes out on the current head');
      assert.deepEqual(run.policyCalls, []);
      const alerts = run.traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend');
      assert.equal(alerts.length, 1, `binds ${binds}: one operator line`);
      const alert = alerts[0] as { message: string; data?: { httpStatus?: number } };
      assert.match(alert.message, /role system not accepted here/, 'quoting the 400');
      assert.match(alert.message, /went again in the fallback form, on the agent's current tools and system text with its change rows left out, and was accepted/);
      assert.match(alert.message, /That is an inference from one retry: the 400 may not be about the change/);
      assert.match(alert.message, /keeps to its head until it's built again/);
      assert.equal(/can set aside the thinking/.test(alert.message), binds, `binds ${binds}: the thinking's cost said only where it can be paid`);
      assert.equal(alert.data?.httpStatus, 400);
      assert.deepEqual(run.traces.filter((t) => t.type === 'head:resend').map((t) => (t as { diagnosis: string }).diagnosis), ['retry']);
    }
  });

  it("leaves the agent declaring its changes when its retry in the fallback form stops before its first event", async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(false) : undefined), abortRetry: true });
    assert.equal(run.calls.length, 3, 'the adopting turn, the refused request, its retry');
    assert.equal(carriesChange(run.calls[2]!), false, 'the retry, in the fallback form');
    assert.equal(run.onHead, false, 'the agent still declares its changes: a retry stopped before its first event was not accepted');
    assert.equal(resends(run.traces), 0);
  });

  it("leaves the agent as it was when its retry in the fallback form is refused too, and the error policy has that refusal", async () => {
    const run = await turns({ binds: true, refuse: () => refusal(false), third: true });
    assert.equal(run.calls.length, 4, 'the adopting turn, the refused request, its retry, the third turn');
    assert.equal(carriesChange(run.calls[2]!), false, 'the retry carried no change row');
    assert.equal(run.onHead, false, 'the agent still declares its changes');
    assert.deepEqual(run.moved, ['adopted'], 'and its record stays');
    assert.deepEqual(run.policyCalls, [1], "the policy saw the retry's refusal as attempt 1, and nothing of the first");
    assert.equal(resends(run.traces), 0);
    assert.equal(run.traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend').length, 0, 'and no operator line');
    assert.equal(carriesChange(run.calls[3]!), true, 'the third turn declares the change again');
  });

  it("tells the operator of a refusal membrane recognises, with the remedy, once in the agent's build", async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(true) : undefined), third: true, refuseLater: true });
    assert.equal(run.onHead, true, 'the premise: the refusal kept the agent to its head');
    assert.equal(carriesChange(run.calls.at(-1)!), false, 'the premise: the third turn, after its tools changed again, carried no change to refuse');
    const alerts = run.traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-resend') as Array<{ message: string; data?: { httpStatus?: number } }>;
    assert.equal(alerts.length, 1, 'one operator line for the build');
    assert.match(alerts[0]!.message, /membrane refused a system change, and the request goes again on the agent's head/);
    assert.match(alerts[0]!.message, /keeps to its head until it's built again/);
    assert.match(alerts[0]!.message, /belongs on membrane's list of models that refuse them \(Membrane\.takesToolOrSystemChanges\); where membrane refused the change before sending it, send through a formatter and an adapter that send system changes/);
    assert.equal(alerts[0]!.data?.httpStatus, undefined, 'naming no 400 of its own');
  });

  it('leaves a failure that isn\'t a 400 to the error policy', async () => {
    const after500 = await turns({ binds: false, refuse: (r) => (carriesChange(r) ? serverError() : undefined) });
    assert.equal(after500.calls.length, 2, 'a 500 is the error policy\'s');
    assert.equal(after500.onHead, false);
    assert.deepEqual(after500.policyCalls, [0]);
  });

  for (const [type, message] of [['context_length', 'prompt is too long: 210000 tokens > 200000 maximum'], ['auth', 'your credit balance is too low']] as const) {
    it(`leaves a 400 membrane files as ${type} to the error policy, though the request carried a change, and keeps declaring changes`, async () => {
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

  it('leaves a refused request that carried no declaration row to the error policy, whatever the refusal: no change, or one of its effort alone', async () => {
    for (const effort of [undefined, 'high'] as const) {
      for (const marked of [true, false]) {
        const what = `${effort ? 'an effort change alone' : 'no change'}, ${marked ? 'a refusal membrane marks' : "a 400 it doesn't"}`;
        const run = await turns({ binds: false, second: ['a'], ...(effort ? { effort } : {}), refuse: () => refusal(marked) });
        assert.equal(carriesChange(run.calls[1]!), effort !== undefined, `${what}: the premise`);
        assert.equal(run.calls.length, 2, `${what}: no resend`);
        assert.equal(run.onHead, false);
        assert.equal(resends(run.traces), 0);
        assert.deepEqual(run.policyCalls, [0], `${what}: the error policy had it`);
      }
    }
  });
});

const overloaded = () => Object.assign(
  new MembraneError({ type: 'server', retryable: true, message: 'the provider is overloaded', rawError: { status: 503 } }),
  { httpStatus: 503 },
);

async function rearmed(later: () => Error | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-rearm-'));
  const membrane = new MockMembrane();
  membrane.takesChanges = true;
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
      thinkingBinding: { binds: true },
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

describe('the fail-safe for a refused change in a re-armed turn', () => {
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

  it("keeps a host's change stored during a turn out of the turn's later rounds, and the next start's request folds it with the head", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-'));
    const membrane = new MockMembrane();
    membrane.takesChanges = true;
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
      }],
      modules: [new Input(), new HostChangeAtTool()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: { maxRetries: 0, onInferenceError: (_e: Error, _name: string, attempt: number) => { policyCalls.push(attempt); return { retry: false }; } },
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();
    const ended = () => traces.filter((t) => t.type === 'inference:completed' || t.type === 'inference:exhausted').length;
    try {
      for (const [text, n] of [['first', 1], ['second', 2], ['third', 3]] as const) {
        framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
        assert.ok(await pollUntil(() => ended() === n), `turn ${n} ended`);
      }
      assert.equal(carriesChange(membrane.calls[1]!), false, "the second turn's first request carried no change");
      assert.equal(refusedRound?.handedChange, false, "its next round wasn't handed the change, which a round would carry beside a head it doesn't fold to");
      assert.deepEqual(policyCalls, [], 'so nothing was refused');
      const third = membrane.calls[2]!;
      assert.equal(carriesChange(third), true, "the third turn's request carries the host's row");
      assert.deepEqual(foldOf(third).tools.map((t) => t.name), toolNames(membrane.calls[0]!).sort((a, b) => a.localeCompare(b)), "and folds to the agent's own tools");
      assert.equal(membrane.calls.length, 3, 'the adopting turn, the second turn, the third turn');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fail-safe for a refused change, with a model that binds thinking to its prefix', () => {
  // A cache marker is no part of what a provider signs.
  const canonical = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'cache_control' || k === 'cacheControl' || k === 'cacheBreakpoint' ? undefined : x));
  const prefixHash = (r: NormalizedRequest, upTo: number) => createHash('sha256')
    .update(canonical({ system: r.system, tools: (r.tools ?? []).map((t) => t.name), messages: r.messages.slice(0, upTo) })).digest('hex');
  const misboundThinking = (r: NormalizedRequest) => r.messages.some((m, i) => m.content.some((b) =>
    (b as { type?: string }).type === 'thinking' && (b as { signature?: string }).signature !== prefixHash(r, i)));
  const thinkingIn = (r: NormalizedRequest) => r.messages.flatMap((m) => m.content.filter((b) => (b as { type?: string }).type === 'thinking')).length;

  const thinkingAfterChange = (r: NormalizedRequest) => {
    const change = r.messages.findIndex((m) => m.content.some((b) => (b as { type?: string }).type === 'system_change'));
    return change >= 0 && r.messages.slice(change + 1).some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking'));
  };

  // Each answer's thinking is signed over its request's whole prefix, so a
  // later request carries it validly only on the same system text, tools and
  // messages before it. The host's row goes in the residents' slot, which a
  // resident's context takes rows out of and the subconscious's only reads.
  async function signedOverChanges(who: 'resident' | 'Subconscious', refused: Error) {
    const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-failsafe-signed-'));
    const membrane = new MockMembrane();
    membrane.takesChanges = true;
    let refuseNext = false;
    let refusedAt = -1;
    const sent: NormalizedRequest[] = [];
    membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      membrane.calls.push(request);
      if ((typeof request.system === 'string' && request.system.includes('ATTENDS')) !== (who === 'Subconscious')) {
        return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'done' }])]);
      }
      sent.push(request);
      if (refuseNext && carriesChange(request)) {
        refuseNext = false;
        refusedAt = sent.length - 1;
        return new RefusedStream(refused);
      }
      return new MockYieldingStream([createMockResponse([{ type: 'thinking', thinking: 'why', signature: prefixHash(request, request.messages.length) } as ContentBlock, { type: 'text', text: 'done' }])]);
    };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled', thinkingBinding: { binds: true } }],
      modules: [new Input(), new ChangingTools()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
      ...(who === 'Subconscious' ? { subconscious: { enabled: true, systemPrompt: 'ATTENDS', thinkingBinding: { binds: true } } } : {}),
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    framework.start();
    const turn = async (text: string) => {
      if (who === 'resident') framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as unknown as ProcessEvent);
      else assert.equal(framework.nudgeAgent('Subconscious').ok, true);
      await framework.runUntilIdle();
    };
    try {
      await turn('first');
      (framework as unknown as { addMessage(participant: string, content: ContentBlock[]): string }).addMessage('system', [
        { type: 'system_change', defineTools: [{ name: 'h', description: 'h does a thing', inputSchema: { type: 'object', properties: {} } }] } as unknown as ContentBlock,
      ]);
      await turn('second');
      refuseNext = true;
      await turn('third');
      await turn('fourth');
      return { sent, refusedAt, resends: traces.filter((t) => t.type === 'head:resend').length, onHead: !framework.getAgent(who)!.takesChanges() };
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("once the fail-safe acts, sends no thinking signed under a prefix that held a change row: a host's row its context takes out, and one it can't", async () => {
    for (const who of ['resident', 'Subconscious'] as const) {
      for (const marked of [true, false]) {
        const what = `${who}, ${marked ? 'a refusal membrane marks' : "a 400 membrane doesn't mark"}`;
        const run = await signedOverChanges(who, refusal(marked));
        const refused = run.sent[run.refusedAt];
        assert.ok(refused && thinkingAfterChange(refused) && !misboundThinking(refused), `${what}: the premise: the refused request carried thinking signed over a change row`);
        const after = run.sent.slice(run.refusedAt + 1);
        assert.equal(after.length, 2, `${what}: the request that went again, and the next turn's`);
        assert.deepEqual(after.map(misboundThinking), [false, false], `${what}: neither carries thinking under a prefix it wasn't signed under`);
        assert.deepEqual(after.map(carriesChange), [false, false], `${what}: nor a change row`);
        assert.equal(run.resends, 1, what);
        assert.equal(run.onHead, true, `${what}: the agent keeps to its head`);
      }
    }
  });

  describe("the direct API on a model that takes a change, by what its caller passes against its head and own change rows", () => {
    async function directAfter(turns: string[][], passed: (calls: readonly NormalizedRequest[]) => unknown[], binds = true) {
      const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-direct-own-'));
      const membrane = new MockMembrane();
      membrane.takesChanges = true;
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
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled', ...(binds ? { thinkingBinding: { binds: true } } : {}) }],
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

describe('the count that the rule for cost reads', () => {
  it("counts each answered round of an agent's own stream, a tool loop's rounds each, and keeps the count across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-declarations-count-'));
    const storePath = join(dir, 'store.chronicle');
    const membrane = new MockMembrane();
    membrane.takesChanges = true;
    membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      membrane.calls.push(request);
      return new MockYieldingStream([
        { ...createMockResponse([{ type: 'tool_use', id: `call-${membrane.calls.length}`, name: 'changing--a', input: {} } as ContentBlock], 'tool_use'), usage: usageOf(0) } as NormalizedResponse,
        { ...createMockResponse([{ type: 'text', text: 'done' }]), usage: usageOf(1) } as NormalizedResponse,
      ]);
    };
    const open = () => AgentFramework.create({
      storePath, membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'system', allowedTools: 'all', proseRouting: 'disabled' }],
      modules: [new Input(), new ChangingTools()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    type Counting = { usageTracker: { requestCountOf(name: string): number } };
    try {
      const framework = await open();
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      framework.start();
      try {
        framework.pushEvent({ type: 'external-message', source: 'test', content: 'first', metadata: {} } as unknown as ProcessEvent);
        assert.ok(await pollUntil(() => traces.some((t) => t.type === 'inference:completed')), 'the turn ended');
        assert.equal((framework as unknown as Counting).usageTracker.requestCountOf('resident'), 2, 'its call and the round after its tool, each answered');
      } finally {
        await framework.stop();
      }
      const again = await open();
      try {
        assert.equal((again as unknown as Counting).usageTracker.requestCountOf('resident'), 2, 'restored with the usage state');
      } finally {
        await again.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
