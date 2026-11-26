import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import type { EventGate } from '../src/gate/event-gate.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const LAST_DATE_MS = 8.64e15;
const DAY_MS = 86_400_000;
const REFUSED = "sleep: that sleep would end beyond the host's date range. Your sleep settings haven't changed. Use a smaller number of seconds.";

class EchoModule implements Module {
  readonly name = 'test';
  echoed: string[] = [];
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'echo', description: 'Echo a text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  }
  async handleToolCall(call: { input: unknown }): Promise<ToolResult> {
    const text = String((call.input as { text?: unknown }).text);
    this.echoed.push(text);
    return { success: true, data: `ECHO ${text}` };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true };
    }
    return {};
  }
}

const consoleError = console.error;

type Trace = { type: string; [k: string]: unknown };
type Answer = { toolUseId: string; content: unknown; isError?: boolean };

describe('a model-path call whose dispatch throws, and a sleep beyond the host\'s dates (#259)', () => {
  let dir: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let echo: EchoModule;
  let traces: Trace[] = [];
  const internals = () => framework as unknown as {
    eventGate: EventGate;
    dispatchToolCall(agentName: string, call: { id: string; name: string; input: unknown }, turnId?: number): void;
    pushEvent(event: unknown): void;
  };

  beforeEach(async () => {
    traces = [];
    dir = mkdtempSync(join(tmpdir(), 'model-dispatch-throw-'));
    membrane = new MockMembrane();
    echo = new EchoModule();
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      modules: [echo],
      gate: { config: { policies: [], default: 'always' }, configPath: join(dir, 'gate.json') },
    });
    framework.onTrace((e) => traces.push(e as Trace));
    await framework.start();
  });

  afterEach(async () => {
    console.error = consoleError;
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function turn(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
    const from = traces.length;
    const streamsBefore = membrane.calls.length;
    membrane.pushResponse(createMockResponse(calls.map((c) => ({ type: 'tool_use', ...c })) as never, 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const ended = new Promise<string>((resolve) => {
      const off = framework.onTrace((e) => {
        const t = (e as Trace).type;
        if (t === 'inference:completed' || t === 'inference:exhausted') { off(); resolve(t); }
      });
    });
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: [{ type: 'text', text: 'go' }], metadata: {}, triggerInference: true } as unknown as ProcessEvent);
      const end = await ended;
      const stream = membrane.calls.length > streamsBefore ? membrane.lastStream : undefined;
      const answers = (stream?.receivedToolResults ?? []).flat() as Answer[];
      return { end, answers, traces: traces.slice(from), lines };
    } finally {
      console.error = error;
    }
  }

  const answerTo = (answers: Answer[], id: string) => answers.filter((a) => a.toolUseId === id);

  it("the bug's own case: sleep with seconds 1e13 beside another call is refused, sets nothing, and the turn goes on", async () => {
    const got = await turn([
      { id: 'toolu_sleep_huge', name: 'sleep', input: { seconds: 1e13, announce: false } },
      { id: 'toolu_echo_after', name: 'test--echo', input: { text: 'after' } },
    ]);
    assert.equal(got.end, 'inference:completed');
    assert.ok(!got.traces.some((t) => t.type === 'inference:failed'), 'no failed inference');
    const [sleep] = answerTo(got.answers, 'toolu_sleep_huge');
    assert.equal(sleep?.isError, true);
    assert.equal(sleep?.content, REFUSED);
    assert.match(JSON.stringify(answerTo(got.answers, 'toolu_echo_after')), /ECHO after/);
    assert.deepEqual(echo.echoed, ['after']);
    assert.equal(internals().eventGate.getSleepState(), null, 'the gate is not asleep');
  });

  for (const order of ['first', 'second'] as const) {
    it(`a call whose dispatch throws, ${order} in its response, is answered as failed in the host, and the other call runs once`, async () => {
      const original = internals().dispatchToolCall;
      let work = 0;
      internals().dispatchToolCall = function (this: unknown, agentName, call, turnId) {
        if ((call.input as { boom?: boolean }).boom) { work++; throw new RangeError('Invalid time value'); }
        return original.call(this, agentName, call, turnId);
      };
      const thrower = { id: `toolu_throws_${order}`, name: 'test--echo', input: { text: 'boom', boom: true } };
      const other = { id: `toolu_other_${order}`, name: 'test--echo', input: { text: 'other' } };
      const got = await turn(order === 'first' ? [thrower, other] : [other, thrower]);

      assert.equal(got.end, 'inference:completed');
      assert.ok(!got.traces.some((t) => t.type === 'inference:failed'), 'no failed inference');
      assert.equal(work, 1);
      const failed = answerTo(got.answers, thrower.id);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.isError, true);
      assert.equal(failed[0]!.content, 'test--echo failed in the host: Invalid time value; it may have taken effect');
      assert.match(JSON.stringify(answerTo(got.answers, other.id)), /ECHO other/);
      assert.deepEqual(echo.echoed, ['other'], 'the other call ran once');
      const traced = got.traces.filter((t) => t.type === 'tool:failed' && t.callId === thrower.id);
      assert.equal(traced.length, 1);
      assert.equal(traced[0]!.module, 'framework');
      assert.equal(traced[0]!.error, 'Invalid time value');
      assert.ok(
        got.lines.some((l) => l.includes('agent') && l.includes('test--echo') && l.includes(thrower.id) && l.includes('Invalid time value')),
        `a stderr line names the agent, the tool, the call and the throw:\n${got.lines.join('\n')}`,
      );
    });
  }

  it('a thrown value that cannot be read is still answered as failed in the host, and the turn goes on', { timeout: 30_000 }, async () => {
    const original = internals().dispatchToolCall;
    internals().dispatchToolCall = function (this: unknown, agentName, call, turnId) {
      if ((call.input as { unreadable?: boolean }).unreadable) {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        throw proxy;
      }
      return original.call(this, agentName, call, turnId);
    };
    const got = await turn([
      { id: 'toolu_unreadable', name: 'test--echo', input: { text: 'x', unreadable: true } },
      { id: 'toolu_readable', name: 'test--echo', input: { text: 'readable' } },
    ]);
    assert.equal(got.end, 'inference:completed');
    const [failed] = answerTo(got.answers, 'toolu_unreadable');
    assert.equal(failed?.isError, true);
    assert.equal(failed?.content, 'test--echo failed in the host: (a value that could not be read); it may have taken effect');
    assert.deepEqual(echo.echoed, ['readable']);
  });

  it('an Error whose stack is not text gives a tool:failed trace whose stack is left out', async () => {
    const original = internals().dispatchToolCall;
    internals().dispatchToolCall = function (this: unknown, agentName, call, turnId) {
      if ((call.input as { oddStack?: boolean }).oddStack) {
        const error = new Error('odd stack');
        Object.defineProperty(error, 'stack', { value: 42 });
        throw error;
      }
      return original.call(this, agentName, call, turnId);
    };
    const got = await turn([{ id: 'toolu_odd_stack', name: 'test--echo', input: { text: 'x', oddStack: true } }]);
    assert.equal(got.end, 'inference:completed');
    const traced = got.traces.filter((t) => t.type === 'tool:failed' && t.callId === 'toolu_odd_stack');
    assert.equal(traced.length, 1);
    assert.equal(traced[0]!.error, 'odd stack');
    assert.equal(traced[0]!.stack, undefined);
  });

  it('a handler that answers and then throws gives its call one answer, its own, and the other call runs once', async () => {
    const original = internals().dispatchToolCall;
    internals().dispatchToolCall = function (this: unknown, agentName, call, turnId) {
      if ((call.input as { answerThenThrow?: boolean }).answerThenThrow) {
        internals().pushEvent({ type: 'tool-result', callId: call.id, toolName: call.name, agentName, moduleName: 'test', result: { success: true, data: 'OWN ANSWER' } });
        throw new Error('after answering');
      }
      return original.call(this, agentName, call, turnId);
    };
    const got = await turn([
      { id: 'toolu_answered', name: 'test--echo', input: { text: 'x', answerThenThrow: true } },
      { id: 'toolu_sibling', name: 'test--echo', input: { text: 'sibling' } },
    ]);
    assert.equal(got.end, 'inference:completed');
    const answered = answerTo(got.answers, 'toolu_answered');
    assert.equal(answered.length, 1, 'one answer for the call');
    assert.match(JSON.stringify(answered[0]), /OWN ANSWER/);
    assert.equal(answerTo(got.answers, 'toolu_sibling').length, 1);
    assert.equal(got.answers.length, 2);
    assert.deepEqual(echo.echoed, ['sibling']);
  });

  const sleep = (input: Record<string, unknown>) =>
    framework.executeToolCall({ id: `host-sleep-${Math.random()}`, name: 'sleep', input, callerAgentName: 'agent' });

  it('a sleep whose end is a date the host can keep still sleeps, and says until when', async () => {
    const result = await sleep({ seconds: 8.6e12, announce: false });
    assert.equal(result.success, true, String(result.error));
    const untilLocal = String((result.data as { untilLocal?: unknown }).untilLocal);
    assert.match(untilLocal, /^\+?\d+-\d\d-\d\dT/);
    assert.ok(!untilLocal.includes('NaN'), untilLocal);
    assert.ok(internals().eventGate.getSleepState() !== null, 'the gate sleeps');
  });

  it("a sleep whose end falls inside the host's last day is refused, and sets nothing", async () => {
    const seconds = (LAST_DATE_MS - DAY_MS / 2 - Date.now()) / 1000;
    const result = await sleep({ seconds, announce: false });
    assert.equal(result.isError, true);
    assert.equal(result.error, REFUSED);
    assert.equal(internals().eventGate.getSleepState(), null);
  });

  it('a refused sleep leaves an earlier sleep in force as it was', async () => {
    const { until } = internals().eventGate.setSleep(3600, 'resting', 'agent');
    const result = await sleep({ seconds: 1e13, announce: false });
    assert.equal(result.error, REFUSED);
    assert.equal(internals().eventGate.getSleepState()?.until, until);
    assert.equal(internals().eventGate.getSleepState()?.note, 'resting');
  });

  it('a seconds that is not a positive number is still refused as before', async () => {
    for (const seconds of [0, -1, 'soon']) {
      const result = await sleep({ seconds, announce: false });
      assert.equal(result.error, 'sleep: `seconds` must be a positive number', String(seconds));
    }
  });
});
