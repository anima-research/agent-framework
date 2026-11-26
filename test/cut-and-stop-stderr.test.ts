import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';
import type { ErrorAction, ErrorPolicy, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult, TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const STOP_WORDS = "a stop cancelled the turn's stream";
const HOST_SETTING = "(the host's setting for this bound: `inferenceBounds.progressBounds.betweenEventsMs`)";

class Gate {
  promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((resolve) => { this.open = resolve; }); }
}

class InputModule implements Module {
  readonly name = 'input';
  hooks: Gate | null = null;
  readonly hooksEntered = new Gate();
  readonly toolGate = new Gate();
  readonly toolEntered = new Gate();
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait_here', description: 'Waits until the test lets it answer.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.toolEntered.open();
    await this.toolGate.promise;
    return { success: true, data: 'done' };
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
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ScriptedMembrane extends MockMembrane {
  constructor(private readonly script: Array<() => YieldingStream>) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const next = this.script.shift();
    return next ? next() : new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-answered' }])]);
  }
}

class EventsStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  constructor(private readonly events: StreamEvent[]) {}
  cancel(): void {}
  provideToolResults(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (const event of this.events) yield event;
  }
}

class LiveStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  private release: (() => void) | null = null;
  private cancelled = false;
  constructor(private readonly reports: 'aborted' | 'error') {}
  cancel(): void { this.cancelled = true; this.release?.(); }
  provideToolResults(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.cancelled) await new Promise<void>((resolve) => { this.release = resolve; });
    yield (this.reports === 'aborted' ? { type: 'aborted', reason: 'user' } : { type: 'error', error: new Error('stream cancelled') }) as StreamEvent;
  }
}

const cut = (message: string) => () => new EventsStream([{ type: 'aborted', reason: 'timeout', message } as StreamEvent]);
const serverError = () => () => new EventsStream([{
  type: 'error',
  error: new MembraneError({ type: 'server', retryable: true, httpStatus: 500, message: 'zz internal error', rawError: undefined } as ConstructorParameters<typeof MembraneError>[0]),
} as StreamEvent]);

function stderrOf(t: TestContext): string[] {
  const calls: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { calls.push(format(...args)); };
  t.after(() => { console.error = original; });
  return calls;
}
const physicalLines = (calls: string[]) => calls.flatMap((text) => text.split(/\r\n|[\n\r\v\f\u2028\u2029\u0085]/));
const timeoutCalls = (calls: string[]) => calls.filter((text) => physicalLines([text]).some((line) => line.startsWith('[inference-timeout]')));
const stopCalls = (calls: string[]) => calls.filter((text) => text.includes(STOP_WORDS));
const timeoutLine = (reason: string, scheduled = 'in 1000ms (2 of 2)', agent = 'resident') => `[inference-timeout] agent=${agent} retry scheduled ${scheduled}: ${reason}`;
const stopLine = (reason: string, agent = 'resident') => new RegExp(`^\\[turn\\] ${agent}: ${STOP_WORDS} after \\d+ (s|min); the turn ends there \\(reason=${reason}\\)$`);
const markedDeadline = (message: string) => () => {
  const error = new MembraneError({ type: 'timeout', retryable: true, message, rawError: undefined } as ConstructorParameters<typeof MembraneError>[0]);
  Object.defineProperty(error, Symbol.for('membrane.deadlineExpiry'), { value: true });
  return new EventsStream([{ type: 'error', error } as StreamEvent]);
};
const retryOnce = (action: ErrorAction): ErrorPolicy => ({
  maxRetries: 1,
  onInferenceError: (_error: Error, _agentName: string, attempt: number): ErrorAction => (attempt === 0 ? action : { retry: false }),
});

async function boot(t: TestContext, script: Array<() => YieldingStream>, errorPolicy?: ErrorPolicy, name = 'resident') {
  const dir = mkdtempSync(join(tmpdir(), 'af-cut-stop-'));
  let made: AgentFramework | undefined;
  t.after(async () => {
    try {
      await made?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const membrane = new ScriptedMembrane(script);
  const module = new InputModule();
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name, model: 'zz-model', systemPrompt: 'system' }],
    modules: [module], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...(errorPolicy ? { errorPolicy } : {}),
  });
  made = fw;
  const traces: TraceEvent[] = [];
  fw.onTrace((event) => { traces.push(event); });
  fw.start();
  return { fw, membrane, module, traces };
}

async function within<T>(what: string, work: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function until(what: string, ready: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const hello = (fw: AgentFramework) => fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-hello', metadata: {} } as unknown as ProcessEvent);

describe('a deadline expiry whose call the error policy retries writes one stderr line', () => {
  it('a cut call that gets a fresh call writes one [inference-timeout] line with the delay, the tries and the reason, and the fresh call answers', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane, traces } = await boot(t, [cut('No provider event within 150s')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2, 'one fresh call');
    assert.ok(traces.some((e) => e.type === 'inference:completed'), 'the fresh call answered');
    assert.deepEqual(timeoutCalls(stderr), [timeoutLine(`No provider event within 150s ${HOST_SETTING}`)]);
  });

  it("a deadline that membrane reports with its mark writes the line too, with membrane's reason", async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [markedDeadline('Request timed out.')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2, 'one fresh call');
    assert.deepEqual(timeoutCalls(stderr), [timeoutLine('Request timed out.')]);
  });

  it('a second cut ends the turn: the first cut wrote the one [inference-timeout] line, and the end has its [inference-failed] line', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [cut('No provider event within 150s'), cut('No content within 60s')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2);
    assert.deepEqual(timeoutCalls(stderr), [timeoutLine(`No provider event within 150s ${HOST_SETTING}`)], 'the first cut, whose call was made again');
    const failed = stderr.filter((text) => text.startsWith('[inference-failed] agent=resident'));
    assert.equal(failed.length, 1);
    assert.ok(failed[0]!.includes('No content within 60s'), `the end names the second cut: ${failed[0]}`);
  });

  it('a retried failure of another class writes no [inference-timeout] line', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [serverError()]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2, 'the failure was retried');
    assert.deepEqual(timeoutCalls(stderr), []);
  });

  it('a reason of several lines is written on one line, with the host setting kept', async (t) => {
    const stderr = stderrOf(t);
    const { fw } = await boot(t, [cut('No provider event within 150s\nupstream said:\r\n  idle\u2028done\u0085twice')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    const calls = timeoutCalls(stderr);
    assert.equal(calls.length, 1);
    assert.equal(physicalLines(calls).length, 1, 'one physical line');
    assert.equal(calls[0], timeoutLine(`No provider event within 150s upstream said: idle done twice ${HOST_SETTING}`));
  });

  for (const [action, scheduled] of [
    [{ retry: true, delayMs: 0 }, '(2)'],
    [{ retry: true, delayMs: Number.NaN, maxTries: 0 }, '(2)'],
    [{ retry: true, delayMs: -5, maxTries: 1.5 }, '(2)'],
    [{ retry: true, delayMs: 0, maxTries: Number.POSITIVE_INFINITY }, '(2)'],
    [{ retry: true, delayMs: 5, maxTries: 3 }, 'in 5ms (2 of 3)'],
  ] as const) {
    it(`a policy's delay ${action.delayMs} and maxTries ${'maxTries' in action ? action.maxTries : 'left out'}: the line says ${JSON.stringify(scheduled)}`, async (t) => {
      const stderr = stderrOf(t);
      const { fw } = await boot(t, [cut('No provider event within 150s')], retryOnce(action));
      hello(fw);
      await within('the turn', fw.runUntilIdle());
      assert.deepEqual(timeoutCalls(stderr), [timeoutLine(`No provider event within 150s ${HOST_SETTING}`, scheduled)]);
    });
  }

  it('a stop during the wait: the line is there before the stop, says the retry was scheduled, and no second call is sent', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane, traces } = await boot(t, [cut('No provider event within 150s')], retryOnce({ retry: true, delayMs: 60_000, maxTries: 2 }));
    hello(fw);
    await until('the wait to retry', () => traces.some((e) => e.type === 'inference:waiting'));
    const line = timeoutLine(`No provider event within 150s ${HOST_SETTING}`, 'in 60000ms (2 of 2)');
    assert.deepEqual(timeoutCalls(stderr), [line], 'written before the wait');
    assert.equal(fw.abortInference('resident', 'zz-stop-in-wait'), true);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 1, 'no second call');
    assert.ok(traces.some((e) => e.type === 'inference:aborted'), 'the turn ended as a stop');
    assert.deepEqual(timeoutCalls(stderr), [line]);
    assert.deepEqual(stopCalls(stderr), [], 'no stream was live');
  });
});

describe("a caller's stop that cancels a live stream writes one stderr line", () => {
  for (const reports of ['aborted', 'error'] as const) {
    it(`abortInference() on a live stream that reports the cancel as ${reports === 'aborted' ? 'aborted' : 'an error'}: one [turn] line with the stop's reason`, async (t) => {
      const stderr = stderrOf(t);
      const { fw, membrane, traces } = await boot(t, [() => new LiveStream(reports)]);
      hello(fw);
      await until('the stream', () => membrane.calls.length === 1 && fw.getAgent('resident')!.state.status === 'streaming');
      assert.equal(fw.abortInference('resident', 'operator-probe'), true);
      await within('the turn', fw.runUntilIdle());
      assert.ok(traces.some((e) => e.type === 'inference:aborted'));
      const calls = stopCalls(stderr);
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, stopLine('operator-probe'));
    });
  }

  it("Agent.cancelStream() on a live stream writes the same line", async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane, traces } = await boot(t, [() => new LiveStream('aborted')]);
    hello(fw);
    await until('the stream', () => membrane.calls.length === 1 && fw.getAgent('resident')!.state.status === 'streaming');
    fw.getAgent('resident')!.cancelStream('operator-probe');
    await within('the turn', fw.runUntilIdle());
    assert.ok(traces.some((e) => e.type === 'inference:aborted'));
    const calls = stopCalls(stderr);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, stopLine('operator-probe'));
  });

  it("a stop's reason with a line break and spaces is one field on the line", async (t) => {
    const stderr = stderrOf(t);
    const reason = 'two lines\nof reason';
    const { fw, membrane } = await boot(t, [() => new LiveStream('aborted')]);
    hello(fw);
    await until('the stream', () => membrane.calls.length === 1 && fw.getAgent('resident')!.state.status === 'streaming');
    fw.abortInference('resident', reason);
    await within('the turn', fw.runUntilIdle());
    const calls = stopCalls(stderr);
    assert.equal(calls.length, 1);
    assert.equal(physicalLines(calls).length, 1, 'one physical line');
    const field = /\(reason=(.*)\)$/.exec(calls[0]!)?.[1];
    assert.ok(field !== undefined && !/\s/.test(field), `one field: ${field}`);
    assert.equal(JSON.parse(field), reason, 'the field reads back as the reason');
  });

  it("a stop while the round's tools run: the stream is live, so it writes the line", async (t) => {
    const stderr = stderrOf(t);
    const { fw, module, traces } = await boot(t, [() => new MockYieldingStream([
      createMockResponse([{ type: 'tool_use', id: 'call_wait', name: 'input--wait_here', input: {} }], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'zz-after-tools' }]),
    ])]);
    hello(fw);
    await within('the tool to run', module.toolEntered.promise);
    assert.equal(fw.abortInference('resident', 'zz-stop-at-tools'), true);
    module.toolGate.open();
    await within('the turn', fw.runUntilIdle());
    assert.ok(traces.some((e) => e.type === 'inference:aborted'));
    const calls = stopCalls(stderr);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, stopLine('zz-stop-at-tools'));
  });

  it("a stop before the stream exists writes the start's own line, and not the stream's", async (t) => {
    const stderr = stderrOf(t);
    const { fw, module, traces } = await boot(t, []);
    const hooks = new Gate();
    module.hooks = hooks;
    hello(fw);
    await within('the hooks to run', module.hooksEntered.promise);
    assert.equal(fw.abortInference('resident', 'zz-stop-in-hooks'), true);
    hooks.open();
    await until('the turn to end', () => fw.getHostModeStatus().activeTurns === 0 && fw.getAgent('resident')!.state.status === 'idle');
    assert.ok(traces.some((e) => e.type === 'inference:aborted'));
    assert.deepEqual(stopCalls(stderr), []);
    assert.ok(stderr.includes("[turn] resident: a stop reached the turn's start before it sent anything; it ends there"));
  });
});

describe('an agent name with a line break stays one field on each new line', () => {
  const name = 'night\nowl';
  const field = '"night\\nowl"';

  it('on the [inference-timeout] line', async (t) => {
    const stderr = stderrOf(t);
    const { fw } = await boot(t, [cut('No provider event within 150s')], undefined, name);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    const calls = timeoutCalls(stderr);
    assert.equal(physicalLines(calls).length, 1, 'one physical line');
    assert.deepEqual(calls, [timeoutLine(`No provider event within 150s ${HOST_SETTING}`, 'in 1000ms (2 of 2)', field)]);
  });

  it('on the [turn] stop line', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [() => new LiveStream('aborted')], undefined, name);
    hello(fw);
    await until('the stream', () => membrane.calls.length === 1 && fw.getAgent(name)!.state.status === 'streaming');
    fw.abortInference(name, 'operator-probe');
    await within('the turn', fw.runUntilIdle());
    const calls = stopCalls(stderr);
    assert.equal(physicalLines(calls).length, 1, 'one physical line');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, stopLine('operator-probe', field.replace(/\\/g, '\\\\')));
  });
});
