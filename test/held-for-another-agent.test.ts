/**
 * Issue #795, in the form the presentation index (#291) answers it: with two
 * residents, an addressed channel message that arrives while the first one's
 * turn is running wakes the second, whose turn ran before the message was
 * stored, so its request didn't carry it, and nothing woke it again.
 *
 * Under the presentation index the message is stored at once, while the
 * first agent's turn is alive, for both residents (its audience), and kept
 * out of the first one's window until its tool boundary, where it hears it;
 * the idle second agent is presented it before any wake for it runs, so its
 * one request carries it.
 *
 * A todo test until the presentation points are wired with the flag on: it
 * runs, and fails at helperCarried on this build, where the message is still
 * held for the first agent's turn (the issue's outcome) and both contexts are
 * still in legacy mode.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, audienceOf } from '../src/index.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

const QUESTION = 'a question for anyone';
const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const message = {
  type: 'mcpl:channel-incoming',
  serverId: 'chat',
  channelId: 'chat:room',
  messageId: 'm-1',
  author: { id: 'u-1', name: 'someone' },
  content: [text(QUESTION)],
  timestamp: new Date().toISOString(),
  tags: ['chat:addressed'],
  triggerInference: true,
} as unknown as ProcessEvent;

/** A tool that, on its first call, has the message arrive while it runs. */
class ArrivingDuringTool implements Module {
  readonly name = 'hold';
  arrive: (() => void) | null = null;
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'wait', description: 'Wait for something', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    const arrive = this.arrive;
    this.arrive = null;
    if (arrive) {
      arrive();
      // Long enough for the other agent's woken turn to run meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { success: true, data: { ok: true } };
  }
  // A turn of the first agent alone, to call the tool.
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'Antra', content: [text('please check')] }], requestInference: ['assistant'] };
  }
}

/** What the helper's context held when its request was made. */
type Probe = { stored: boolean; presented: boolean; assistantAlive: boolean };
type Result = {
  helperRequests: number;
  helperCarried: boolean;
  probes: Probe[];
  assistantHeard: boolean;
  audience: string[] | undefined;
  modes: string[];
};

const carries = (texts: string[]) => texts.some((t) => t.includes(QUESTION));
const textsOf = (messages: Array<{ content: unknown[] }>) =>
  messages.flatMap((m) => m.content.filter((b) => (b as { type?: string }).type === 'text').map((b) => (b as { text: string }).text));

async function run(duringFirstTurn: boolean): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'held-for-another-agent-'));
  const membrane = new MockMembrane();
  const requests: Array<{ agent: string; texts: string[]; probe?: Probe }> = [];
  const streams: MockYieldingStream[] = [];
  let first = true;
  let probe: () => Probe = () => ({ stored: false, presented: false, assistantAlive: false });
  (membrane as unknown as { streamYielding: (req: NormalizedRequest) => MockYieldingStream }).streamYielding = (req) => {
    membrane.calls.push(req);
    const agent = JSON.stringify(req.system ?? '').includes('You help') ? 'helper' : 'assistant';
    requests.push({ agent, texts: textsOf(req.messages), ...(agent === 'helper' ? { probe: probe() } : {}) });
    // The first agent's first turn calls the tool; every other turn just answers.
    const responses = first && duringFirstTurn
      ? [createMockResponse([text('checking'), { type: 'tool_use', id: 'c1', name: 'hold--wait', input: {} } as ContentBlock], 'tool_use'), createMockResponse([text('done')])]
      : [createMockResponse([text('ok')])];
    first = false;
    const stream = new MockYieldingStream(responses, true);
    membrane.lastStream = stream;
    streams.push(stream);
    return stream;
  };
  const module = new ArrivingDuringTool();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [
      { name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting: 'disabled' },
      { name: 'helper', model: 'test-model', systemPrompt: 'You help.', proseRouting: 'disabled' },
    ],
    modules: [module],
    presentationIndex: true,
  });
  const helperCm = framework.getAgent('helper')!.getContextManager();
  const question = () => helperCm.getAllMessages().find((m) => carries(textsOf([m])));
  probe = () => {
    const row = question();
    return {
      stored: !!row,
      presented: !!row && helperCm.ordinalOf(row.id) !== undefined,
      assistantAlive: framework.getAgent('assistant')!.state.status !== 'idle',
    };
  };
  try {
    if (duringFirstTurn) {
      module.arrive = () => framework.pushEvent(message);
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go' } as unknown as ProcessEvent);
    } else {
      framework.pushEvent(message);
    }
    await framework.runUntilIdle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await framework.runUntilIdle();
    const helper = requests.filter((r) => r.agent === 'helper');
    const injected = streams.flatMap((s) => s.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []));
    return {
      helperRequests: helper.length,
      helperCarried: helper.some((r) => carries(r.texts)),
      probes: helper.map((r) => r.probe!),
      assistantHeard: requests.some((r) => r.agent === 'assistant' && carries(r.texts))
        || carries(textsOf(injected as Array<{ content: unknown[] }>)),
      audience: audienceOf(question()?.metadata)?.audience,
      modes: ['assistant', 'helper'].map((name) => framework.getAgent(name)!.getContextManager().windowMode()),
    };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

it("an agent woken for a message that arrives during another agent's turn gets a request that carries it", {
  todo: '#291: green once the presentation points are wired under presentationIndex',
}, async () => {
  const control = await run(false);
  console.log(`control, the message arriving while no turn is alive: ${JSON.stringify(control)}`);
  assert.equal(control.helperCarried, true, "control: the helper's request carries the message");
  assert.equal(control.helperRequests, 1, 'control: one request');

  const held = await run(true);
  console.log(`the message arriving during the assistant's tool call: ${JSON.stringify(held)}`);
  assert.equal(held.helperRequests, 1, 'the helper was woken once');
  assert.equal(held.helperCarried, true, "the helper's request carries the message");
  assert.deepEqual(held.probes.map((p) => [p.stored, p.assistantAlive]), [[true, true]],
    "it was stored by the helper's request, while the assistant's turn was alive");
  assert.deepEqual(held.probes.map((p) => p.presented), [true], "and in the helper's window then");
  assert.deepEqual([...(held.audience ?? [])].sort(), ['assistant', 'helper'], 'stored for both residents');
  assert.equal(held.assistantHeard, true, 'the assistant heard it, at its boundary or a later request');
  assert.deepEqual(held.modes, ['presented', 'presented'], 'both contexts follow their windows');
});
