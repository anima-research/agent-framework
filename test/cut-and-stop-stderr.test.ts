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
  constructor(private readonly reports: 'aborted' | 'error' | 'throws' | 'closes') {}
  cancel(): void { this.cancelled = true; this.release?.(); }
  provideToolResults(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.cancelled) await new Promise<void>((resolve) => { this.release = resolve; });
    if (this.reports === 'throws') throw new Error('zz the stream threw at its cancel');
    if (this.reports === 'closes') return;
    yield (this.reports === 'aborted' ? { type: 'aborted', reason: 'user' } : { type: 'error', error: new Error('stream cancelled') }) as StreamEvent;
  }
}

const cut = (message: string) => () => new EventsStream([{ type: 'aborted', reason: 'timeout', message } as StreamEvent]);
const tokenThenCut = (message: string) => () => new EventsStream([
  { type: 'tokens', content: 'zz-partial ', meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent,
  { type: 'aborted', reason: 'timeout', message } as StreamEvent,
]);
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
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const timeoutLine = (reason: string, scheduled = 'in 1000ms (2 of 2)', agent = 'resident') =>
  new RegExp(`^\\[inference-timeout\\] agent=${literal(agent)} stream cut after \\d+ms; retry scheduled ${literal(scheduled)}: ${literal(reason)}$`);
const stopLine = (reason: string, agent = 'resident') => new RegExp(`^\\[turn\\] ${literal(agent)}: ${STOP_WORDS} after \\d+ms; the turn ends there: ${literal(reason)}$`);
function oneTimeoutLine(stderr: string[], line: RegExp, message?: string): void {
  const calls = timeoutCalls(stderr);
  assert.equal(calls.length, 1, `${message ?? 'one [inference-timeout] line'}: ${JSON.stringify(calls)}`);
  assert.match(calls[0]!, line);
}
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
    const { fw, membrane, traces } = await boot(t, [tokenThenCut('No provider event within 150s')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2, 'one fresh call');
    assert.ok(traces.some((e) => e.type === 'inference:failed'), 'control: the cut came after a token, as a failed call');
    assert.ok(traces.some((e) => e.type === 'inference:completed'), 'the fresh call answered');
    oneTimeoutLine(stderr, timeoutLine(`No provider event within 150s ${HOST_SETTING}`));
  });

  it("a deadline that membrane reports with its mark writes the line too, with the words of the resident's own note and not membrane's or the SDK's", async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [markedDeadline('Request timed out.')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2, 'one fresh call');
    oneTimeoutLine(stderr, timeoutLine('the model call timed out'));
    assert.ok(!stderr.some((text) => text.includes('Request timed out.')), "the SDK's words are on no line");
  });

  it('a second cut ends the turn: the first cut wrote the one [inference-timeout] line, and the end has its [inference-failed] line', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [cut('No provider event within 150s'), cut('No content within 60s')]);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 2);
    oneTimeoutLine(stderr, timeoutLine(`No provider event within 150s ${HOST_SETTING}`), 'the first cut, whose call was made again');
    const failed = stderr.filter((text) => text.startsWith('[inference-failed] agent=resident'));
    assert.equal(failed.length, 1);
    assert.ok(failed[0]!.includes(' type=timeout') && failed[0]!.includes('No content within 60s'), `the end names the second cut as a timeout: ${failed[0]}`);
    assert.ok(stderr.indexOf(timeoutCalls(stderr)[0]!) < stderr.indexOf(failed[0]!), 'the [inference-timeout] line comes first');
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
    assert.match(calls[0]!, timeoutLine(`No provider event within 150s upstream said: idle done twice ${HOST_SETTING}`));
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
      oneTimeoutLine(stderr, timeoutLine(`No provider event within 150s ${HOST_SETTING}`, scheduled));
    });
  }

  it("a stop during the wait: the line is there before the stop, and the stop writes the turn's own line, with no second call", async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane, traces } = await boot(t, [cut('No provider event within 150s')], retryOnce({ retry: true, delayMs: 60_000, maxTries: 2 }));
    hello(fw);
    await until('the wait to retry', () => traces.some((e) => e.type === 'inference:waiting'));
    const line = timeoutLine(`No provider event within 150s ${HOST_SETTING}`, 'in 60000ms (2 of 2)');
    oneTimeoutLine(stderr, line, 'written before the wait');
    assert.equal(fw.abortInference('resident', 'zz stop in the wait'), true);
    await within('the turn', fw.runUntilIdle());
    assert.equal(membrane.calls.length, 1, 'no second call');
    assert.ok(traces.some((e) => e.type === 'inference:aborted'), 'the turn ended as a stop');
    oneTimeoutLine(stderr, line);
    assert.deepEqual(stopCalls(stderr), [], 'no stream was live');
    assert.deepEqual(stderr.filter((text) => text.startsWith('[turn] ')), ["[turn] resident: a stop ended the turn in its wait to retry; the retry wasn't sent: \"zz stop in the wait\""]);
  });
});

describe("a caller's stop that cancels a live stream writes a [turn] line on stderr", () => {
  const shapes = { aborted: 'reports the cancel as aborted', error: 'reports the cancel as an error', throws: 'throws at the cancel', closes: 'just closes at the cancel' } as const;
  for (const reports of ['aborted', 'error', 'throws', 'closes'] as const) {
    it(`abortInference() on a live stream that ${shapes[reports]}: one [turn] line with the stop's reason`, async (t) => {
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

  it("a stream that throws at the cancel: its [stream] line comes first, then the [turn] line", async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [() => new LiveStream('throws')]);
    hello(fw);
    await until('the stream', () => membrane.calls.length === 1 && fw.getAgent('resident')!.state.status === 'streaming');
    assert.equal(fw.abortInference('resident', 'operator-probe'), true);
    await within('the turn', fw.runUntilIdle());
    const thrown = stderr.findIndex((text) => text.startsWith("[stream] resident: the stream threw after a caller's stop (operator-probe)"));
    const stopped = stderr.findIndex((text) => text.includes(STOP_WORDS));
    assert.ok(thrown >= 0 && stopped > thrown, `the [stream] line, then the [turn] line: ${JSON.stringify(stderr)}`);
  });

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

  it("a stop's reason with spaces ends the line as plain text", async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [() => new LiveStream('aborted')]);
    hello(fw);
    await until('the stream', () => membrane.calls.length === 1 && fw.getAgent('resident')!.state.status === 'streaming');
    fw.abortInference('resident', 'interrupted from the Web UI');
    await within('the turn', fw.runUntilIdle());
    const calls = stopCalls(stderr);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.endsWith('; the turn ends there: "interrupted from the Web UI"'), calls[0]);
  });

  it("a stop's reason with a line break stays on the line, and reads back as the reason", async (t) => {
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
    const tail = /; the turn ends there: (.*)$/.exec(calls[0]!)?.[1];
    assert.ok(tail !== undefined, calls[0]);
    assert.equal(JSON.parse(tail), reason, 'the line\'s end reads back as the reason');
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

describe('an agent name prints as it is on each new line, as the lines beside them print it', () => {
  const name = 'research bot';

  it('on the [inference-timeout] line', async (t) => {
    const stderr = stderrOf(t);
    const { fw } = await boot(t, [cut('No provider event within 150s')], undefined, name);
    hello(fw);
    await within('the turn', fw.runUntilIdle());
    oneTimeoutLine(stderr, timeoutLine(`No provider event within 150s ${HOST_SETTING}`, 'in 1000ms (2 of 2)', name));
  });

  it('on the [turn] stop line', async (t) => {
    const stderr = stderrOf(t);
    const { fw, membrane } = await boot(t, [() => new LiveStream('aborted')], undefined, name);
    hello(fw);
    await until('the stream', () => membrane.calls.length === 1 && fw.getAgent(name)!.state.status === 'streaming');
    fw.abortInference(name, 'operator-probe');
    await within('the turn', fw.runUntilIdle());
    const calls = stopCalls(stderr);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, stopLine('operator-probe', name));
  });
});
