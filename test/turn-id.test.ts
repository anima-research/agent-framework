import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import type { AgentConfig, SpeechContext } from '../src/types/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { fireNextYieldAsSet } from './helpers/capture-timers.js';

// A module can tell one turn's work from another's: the tool calls made in an
// agent's turn carry the turn's id (`ToolCall.callerTurnId`), its speech
// carries the same id (`SpeechContext.turnId`), the agent's next turn has a
// new one, and a call of a script left running, which no call watches,
// carries none.

class TurnRecorder implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];
  /** The calls on the tool-call process events that every module's onProcess sees. */
  readonly eventCalls: ToolCall[] = [];
  readonly speeches: SpeechContext[] = [];
  /** Run inside each call's handler, before its result goes back. */
  onCall?: (call: ToolCall) => Promise<void>;
  private ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    ctx.registerSpeechHandler('*');
  }

  async stop(): Promise<void> {
    this.ctx?.unregisterSpeechHandler();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }];
  }

  getUtilities(): ToolDefinition[] {
    return [{ name: 'note', description: 'Note something', inputSchema: { type: 'object' } }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    await this.onCall?.(call);
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'tool-call') {
      this.eventCalls.push(event.call);
      return {};
    }
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: true,
    };
  }

  async onAgentSpeech(_agentName: string, _content: ContentBlock[], context: SpeechContext): Promise<void> {
    this.speeches.push(context);
  }
}

/** Each stream takes exactly one queued response, so a restart opens a stream of its own. */
class SequentialStreamMembrane extends MockMembrane {
  private streamIdx = 0;
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.streamIdx, ++this.streamIdx));
    this.lastStream = stream;
    return stream;
  }
}

interface Harness {
  framework: AgentFramework;
  membrane: MockMembrane;
  recorder: TurnRecorder;
}

async function withFramework(
  options: { membrane?: MockMembrane; agent?: Partial<AgentConfig>; codeExecution?: boolean },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'af-turn-id-'));
  const recorder = new TurnRecorder();
  const membrane = options.membrane ?? new MockMembrane();
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'system', ...options.agent }],
      modules: [recorder],
      syncIntervalMs: 0,
      ...(options.codeExecution ? { codeExecution: { enabled: true } } : {}),
    });
    await body({ framework, membrane, recorder });
  } finally {
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runTurn(framework: AgentFramework, content: string): Promise<void> {
  framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} });
  await framework.runUntilIdle();
}

/** One turn: a tool call, then a reply that ends the turn. */
function queueToolTurn(membrane: MockMembrane, call: { id: string; name: string; input: unknown }): void {
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'checking' },
    { type: 'tool_use', ...call } as ContentBlock,
  ], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
}

const echo = (id: string) => ({ id, name: 'test--echo', input: { message: id } });

const messageOf = (call: ToolCall): string | undefined => (call.input as { message?: string }).message;

/** A promise and its resolver. */
function signal(): { done: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  return { done, resolve };
}

/** Wait for a promise, failing after 10 s with what was awaited. */
async function within(done: Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within 10 s`)), 10_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a turn\'s tool calls and its speech carry one turn id, and the next turn carries another', async () => {
  await withFramework({}, async ({ framework, membrane, recorder }) => {
    for (const [i, id] of ['call-1', 'call-2'].entries()) {
      queueToolTurn(membrane, echo(id));
      await runTurn(framework, `turn ${i + 1}`);
    }

    assert.equal(recorder.calls.length, 2, 'each turn made its tool call');
    assert.equal(recorder.speeches.length, 2, 'each turn ended with speech');
    const [first, second] = recorder.calls.map((c) => c.callerTurnId);
    assert.equal(typeof first, 'number', 'a dispatched call carries its turn');
    assert.equal(typeof second, 'number');
    assert.equal(recorder.speeches[0]!.turnId, first, 'the first turn\'s speech carries its calls\' turn');
    assert.equal(recorder.speeches[1]!.turnId, second, 'the second turn\'s speech carries its calls\' turn');
    assert.notEqual(second, first, 'the next turn has another id');
    assert.deepEqual(
      recorder.eventCalls.map((c) => c.callerTurnId),
      [first, second],
      'the tool-call event every module\'s onProcess sees carries the turn too',
    );
  });
});

test('a turn restarted for its context budget keeps its id', async () => {
  const membrane = new SequentialStreamMembrane();
  // The round's prompt reports a 200k prefix (5k fresh, 195k cached), so the
  // tool result and the reply's reserve take the next call past the window,
  // and the framework restarts the turn in a stream of its own.
  const nearCap = createMockResponse([
    { type: 'text', text: 'checking' },
    { type: 'tool_use', ...echo('call-1') } as ContentBlock,
  ], 'tool_use');
  (nearCap as { usage: unknown }).usage = { inputTokens: 5_000, outputTokens: 5, cacheReadTokens: 195_000 };
  membrane.pushResponse(nearCap);
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done after the restart' }]));

  await withFramework({ membrane, agent: { physicalWindowTokens: 200_000, maxTokens: 4_000 } }, async ({ framework, recorder }) => {
    await runTurn(framework, 'go');
    assert.equal(membrane.calls.length, 2, 'the turn was restarted in a second stream');
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.speeches.length, 1, 'the restarted stream ended the turn with speech');
    const turn = recorder.calls[0]!.callerTurnId;
    assert.equal(typeof turn, 'number');
    assert.equal(recorder.speeches[0]!.turnId, turn, 'the speech after the restart carries the turn of the call before it');
  });
});

test('a script\'s inner calls carry the turn of the code_execution call that runs it, even when the agent\'s routing changes', async () => {
  await withFramework({ codeExecution: true }, async ({ framework, membrane, recorder }) => {
    const fw = framework as unknown as { turnRouting: Map<string, { turnId: number }> };
    // While the script waits for its first call, the agent's live routing is
    // replaced, as a later start's would be, and its second call is
    // dispatched then; that call's handler puts the routing back.
    let replaced: number | undefined;
    let restore: (() => void) | undefined;
    recorder.onCall = async (call) => {
      if (messageOf(call) === 'first') {
        const live = fw.turnRouting.get('assistant')!;
        replaced = live.turnId + 100;
        fw.turnRouting.set('assistant', { ...live, turnId: replaced });
        restore = () => fw.turnRouting.set('assistant', live);
      } else if (messageOf(call) === 'second') restore?.();
    };
    queueToolTurn(membrane, {
      id: 'call-ce',
      name: 'code_execution',
      input: { code: 'await tools["test--echo"]({ message: "first" });\nawait tools["test--echo"]({ message: "second" });' },
    });
    await runTurn(framework, 'go');
    const inner = recorder.calls.filter((c) => String(c.id).startsWith('pytc-'));
    assert.equal(inner.length, 2, 'the script made both calls');
    assert.equal(typeof replaced, 'number', 'the routing was replaced while the script ran');
    assert.equal(recorder.speeches.length, 1);
    const turn = recorder.speeches[0]!.turnId;
    assert.equal(typeof turn, 'number');
    assert.deepEqual(inner.map((c) => c.callerTurnId), [turn, turn], 'both calls carry the code_execution call\'s turn');
  });
});

test("a script's inner calls carry what its agent had read when the run call started the script, after the agent has read more", async () => {
  await withFramework({ codeExecution: true }, async ({ framework, membrane, recorder }) => {
    type Start = { turnId?: number; readThrough: { branch: string; sequence: number } | null };
    const fw = framework as unknown as { dispatchScriptToolCall: (...args: unknown[]) => Promise<unknown> };
    const agent = framework.getAgent('assistant') as unknown as {
      getConsumedWatermark(): { branch: string; sequence: number } | null;
      getContextManager(): { addMessage(participant: string, content: unknown[]): unknown };
      markContextConsumed(): void;
    };
    // What the bridge hands the dispatch with each of the script's calls.
    const seen: Array<{ start: Start; read: unknown }> = [];
    const dispatch = fw.dispatchScriptToolCall.bind(framework);
    fw.dispatchScriptToolCall = (...args: unknown[]) => {
      seen.push({ start: args[5] as Start, read: agent.getConsumedWatermark() });
      return dispatch(...args);
    };
    // The agent reads more between the script's two calls, as a later
    // round's boundary would have it.
    recorder.onCall = async (call) => {
      if (messageOf(call) !== 'first') return;
      agent.getContextManager().addMessage('Antra', [{ type: 'text', text: 'read since the script started' }]);
      agent.markContextConsumed();
    };
    queueToolTurn(membrane, {
      id: 'call-ce',
      name: 'code_execution',
      input: { code: 'await tools["test--echo"]({ message: "first" });\nawait tools["test--echo"]({ message: "second" });' },
    });
    await runTurn(framework, 'go');
    assert.equal(seen.length, 2, 'the script made both calls');
    assert.ok(seen[0]!.start.readThrough, "the call carries its script's start reading");
    assert.deepEqual(seen[0]!.start.readThrough, seen[0]!.read, 'what the agent had read as the run call started it');
    assert.notDeepEqual(seen[1]!.read, seen[0]!.read, 'the agent read more before the second call');
    assert.deepEqual(seen[1]!.start.readThrough, seen[0]!.read, 'and the second call carries the start reading still');
  });
});

test('a utility run through toolsets--act carries the turn of the act call', async () => {
  await withFramework({}, async ({ framework, membrane, recorder }) => {
    await framework.executeToolCall({ id: 'open-settings', name: 'toolsets--open', input: { toolset: 'settings' }, callerAgentName: 'assistant' });
    queueToolTurn(membrane, { id: 'call-act', name: 'toolsets--act', input: { tool: 'test--note', args: {} } });
    await runTurn(framework, 'go');
    const note = recorder.calls.filter((c) => c.name === 'note');
    assert.equal(note.length, 1, 'the utility ran');
    assert.equal(recorder.speeches.length, 1);
    assert.equal(typeof note[0]!.callerTurnId, 'number');
    assert.equal(note[0]!.callerTurnId, recorder.speeches[0]!.turnId);
  });
});

test('a dispatched call carries the turn it is dispatched with, or none, whatever turn it arrives with', async () => {
  await withFramework({}, async ({ framework, membrane, recorder }) => {
    const fw = framework as unknown as {
      pushEvent: (event: { type: string; call?: ToolCall; result?: unknown }) => void;
      dispatchToolCallEvent: (event: unknown) => void;
      dispatchToolCall: (agentName: string, call: ToolCall, turnId?: number) => void;
    };
    // The route a call takes from dispatch to the module's handler, without
    // the event queue; returns the tool-call event's call and the module's.
    // Every call arrives claiming turn -5.
    const dispatch = async (id: string, turnId?: number): Promise<{ event: ToolCall; call: ToolCall }> => {
      const oldPush = fw.pushEvent;
      let event: ToolCall | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            fw.pushEvent = (e) => {
              if (e.type === 'tool-call') {
                event = e.call;
                fw.dispatchToolCallEvent(e);
              } else if (e.type === 'tool-result') resolve();
            };
            fw.dispatchToolCall('assistant', { id: id as never, name: 'test--echo', input: { message: id }, callerTurnId: -5 }, turnId);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${id}: the call got no result within 10 s`)), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        fw.pushEvent = oldPush;
      }
      const call = recorder.calls.find((c) => c.id === id);
      assert.ok(event, `${id} was dispatched as a tool-call event`);
      assert.ok(call, `${id} reached the module`);
      return { event, call };
    };

    const given = await dispatch('with-a-turn', 42);
    assert.equal(given.call.callerTurnId, 42, 'the dispatch\'s turn replaces the one the call arrives with');
    assert.equal(given.event.callerTurnId, 42);
    const before = await dispatch('before-any-turn');
    assert.equal(before.call.callerTurnId, undefined);
    assert.ok(!('callerTurnId' in before.event), 'the event\'s call has no turn key');
    queueToolTurn(membrane, echo('call-1'));
    await runTurn(framework, 'turn 1');
    assert.equal(typeof recorder.calls.find((c) => c.id === 'call-1')!.callerTurnId, 'number');
    const after = await dispatch('after-the-turn');
    assert.equal(after.call.callerTurnId, undefined, 'the agent\'s last turn isn\'t taken from its routing');
    assert.ok(!('callerTurnId' in after.event));
  });
});

test('a left script\'s call carries no turn, even while a script a turn waits on runs', async () => {
  await withFramework({ codeExecution: true }, async ({ framework, membrane, recorder }) => {
    // One round starts a script that yields at once, left running, and one
    // the turn waits on. The left script's first call waits in the module
    // until the other script's call is there; its second call is dispatched
    // while the other script waits for that call's result, which waits for it.
    const yields = fireNextYieldAsSet((framework as unknown as { codeExecution: { scripts: object } }).codeExecution.scripts, 60_000);
    const foregroundCalled = signal();
    const backgroundCalledDuring = signal();
    const timedOut: string[] = [];
    const held = (done: Promise<void>, what: string) => within(done, what).catch((err: Error) => {
      timedOut.push(err.message);
      throw err;
    });
    recorder.onCall = async (call) => {
      const message = messageOf(call);
      if (message === 'background, first') await held(foregroundCalled.done, 'the foreground script didn\'t call');
      else if (message === 'background, during') backgroundCalledDuring.resolve();
      else if (message === 'foreground') {
        foregroundCalled.resolve();
        await held(backgroundCalledDuring.done, 'the background script didn\'t call again');
      }
    };
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'starting both' },
      { type: 'tool_use', id: 'call-bg', name: 'code_execution', input: {
        yield_time_ms: 60_000,
        code: 'await tools["test--echo"]({ message: "background, first" });\nawait tools["test--echo"]({ message: "background, during" });',
      } } as ContentBlock,
      { type: 'tool_use', id: 'call-fg', name: 'code_execution', input: { code: 'await tools["test--echo"]({ message: "foreground" });' } } as ContentBlock,
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
    await runTurn(framework, 'go');
    assert.deepEqual(yields, { fired: true }, 'the left script\'s run call yielded as its timer was set');
    assert.deepEqual(timedOut, [], 'each call waited for its counterpart, not for the bound');
    const byMessage = (message: string) => recorder.calls.find((c) => messageOf(c) === message);
    const foreground = byMessage('foreground');
    const during = byMessage('background, during');
    assert.ok(foreground, 'the foreground script made its call');
    assert.ok(during, 'the background script made its call while the foreground script waited');
    assert.equal(recorder.speeches.length, 1);
    assert.equal(typeof foreground.callerTurnId, 'number', 'the foreground script\'s call carries a turn');
    assert.equal(foreground.callerTurnId, recorder.speeches[0]!.turnId, 'the foreground script\'s call carries the turn');
    const first = byMessage('background, first');
    assert.ok(first, 'the left script made its first call');
    assert.equal(first.callerTurnId, undefined);
    assert.equal(during.callerTurnId, undefined);
  });
});

test('a call made with executeToolCall during a turn carries the turn its caller put on it, and none when it put none', async () => {
  await withFramework({}, async ({ framework, membrane, recorder }) => {
    let plain: ToolResult | undefined;
    let given: ToolResult | undefined;
    recorder.onCall = async (call) => {
      if (call.id !== 'call-1') return;
      plain = await framework.executeToolCall({ id: 'direct' as never, name: 'test--echo', input: { message: 'x' }, callerAgentName: 'assistant' });
      given = await framework.executeToolCall({
        id: 'direct-with-a-turn' as never, name: 'test--echo', input: { message: 'y' }, callerAgentName: 'assistant', callerTurnId: 7,
      });
    };
    queueToolTurn(membrane, echo('call-1'));
    await runTurn(framework, 'go');
    assert.equal(plain?.success, true, 'the direct call succeeded');
    assert.equal(given?.success, true, 'the direct call with a turn succeeded');
    const model = recorder.calls.find((c) => c.id === 'call-1');
    const direct = recorder.calls.find((c) => c.id === 'direct');
    const directWithTurn = recorder.calls.find((c) => c.id === 'direct-with-a-turn');
    assert.equal(typeof model?.callerTurnId, 'number', 'the model\'s call carries the turn it was made in');
    assert.ok(direct, 'the direct call reached the module while the turn waited');
    assert.equal(direct.callerTurnId, undefined, 'it doesn\'t take the turn in progress');
    assert.equal(directWithTurn?.callerTurnId, 7, 'a direct call keeps the turn its caller put on it');
  });
});
