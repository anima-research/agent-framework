/**
 * toolDeclarations' fail-safe: a request whose system change the
 * provider refused goes again at once on the agent's head, which it keeps to
 * until it's built again. A binding model waits for the refusal membrane
 * recognises; another resends after any 400 from a request that carried one.
 * The refusal never reaches the error policy, and the resend continues the
 * same turn.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';

import { AgentFramework, type EventResponse, type Module, type ProcessEvent, type ToolCall, type TraceEvent } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

/** Tools the test can change between turns. */
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

/** A stream that ends in an error event, as membrane's yielding stream
 *  reports every failure of its request, the provider's refusals included. */
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

/** A provider's 400, in a wording membrane recognises or not. */
const refusal = (recognised: boolean) => Object.assign(
  new MembraneError({ type: 'invalid_request', retryable: false, message: 'role system not accepted here', rawError: { status: 400 } }),
  { httpStatus: 400 },
  recognised ? { systemChangeRefused: true } : {},
);
/** Membrane's own refusal before sending: recognised, with no HTTP status. */
const refusedBeforeSending = () => Object.assign(
  new MembraneError({ type: 'invalid_request', retryable: false, message: 'this adapter sends no system changes', rawError: null }),
  { systemChangeRefused: true },
);
/** A failure that isn't a 400. */
const serverError = () => Object.assign(
  new MembraneError({ type: 'server', retryable: false, message: 'the provider broke', rawError: { status: 500 } }),
  { httpStatus: 500 },
);

const carriesChange = (request: NormalizedRequest) =>
  request.messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'system_change'));

/** Hands each message the test sends to the resident, and asks it to answer. */
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

/** What the nth answer reports as its usage: fresh input, a cache write and a cache read, each distinct. */
const usageOf = (n: number) => ({ inputTokens: 10 + n, outputTokens: 5, cacheCreationTokens: 200 + n, cacheReadTokens: 3000 + n });
const inputOf = (n: number) => { const u = usageOf(n); return u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens; };

/**
 * A resident's first turn adopts its head; its tools then change (to
 * `second`), and the provider answers the second turn's requests with what
 * `refuse` returns, an error to fail it with or nothing. A third turn
 * follows when `third` is set. The error policy is a spy that records the
 * attempt of each call and never retries.
 */
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

/** The module's tool `b`, as the framework names it, by its module. */
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

  it('on a binding model, leaves a 400 membrane doesn\'t recognise to the error policy', async () => {
    const run = await turns({ binds: true, refuse: (r) => (carriesChange(r) ? refusal(false) : undefined) });
    assert.equal(run.calls.length, 2, 'no resend');
    assert.equal(run.traces.filter((t) => t.type === 'inference:exhausted').length, 1, 'the refusal ended the turn');
    assert.equal(run.onHead, false);
    assert.equal(resends(run.traces), 0);
    assert.deepEqual(run.policyCalls, [0]);
  });

  it('on a model that doesn\'t bind, resends after any 400 from a request that carried a change, but not after another failure', async () => {
    const after400 = await turns({ binds: false, refuse: (r) => (carriesChange(r) ? refusal(false) : undefined) });
    assert.equal(after400.calls.length, 3);
    assert.ok(toolNames(after400.calls[2]!).includes(B));
    assert.equal(after400.onHead, true);
    const after500 = await turns({ binds: false, refuse: (r) => (carriesChange(r) ? serverError() : undefined) });
    assert.equal(after500.calls.length, 2, 'a 500 is the error policy\'s');
    assert.equal(after500.onHead, false);
    assert.deepEqual(after500.policyCalls, [0]);
  });

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
