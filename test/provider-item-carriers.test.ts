/**
 * A provider-native item membrane has no block type for, such as OpenAI's compaction item or Anthropic's
 * server-tool blocks, is stored on a carrier: an exactly empty text block whose `rawItem` is the item. A turn's
 * first request carries the carriers of the turns before it, and membrane's formatters decide per provider what
 * goes out: the Responses formatter sends the item, the native formatter sends a server-tool block in an assistant
 * turn when server blocks are on and leaves out the rest, and the XML and completions formatters leave it out. None
 * sends an empty text block.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnthropicXmlFormatter,
  CompletionsFormatter,
  Membrane,
  NativeFormatter,
  OpenAIResponsesAPIAdapter,
  OpenAIResponsesFormatter,
} from '@animalabs/membrane';
import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';
import type { ContextManager } from '@animalabs/context-manager';

import { Agent } from '../src/agent.js';
import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const AGENT = 'assistant';
const COMPACTION = { type: 'compaction', id: 'cmp_1', encrypted_content: 'compacted-history' };
const MOVE: ToolDefinition = { name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: {} } };

class Robot implements Module {
  readonly name = 'robot';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [MOVE]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: { ok: true } }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }], requestInference: true };
  }
}

const said = (content: string) => ({ type: 'external-message', source: 'test', content, metadata: {} }) as unknown as ProcessEvent;

/** A Responses reply as membrane hands it back: `output` through membrane's own Responses adapter, HTTP stubbed. */
async function responsesReply(output: Array<Record<string, unknown>>, tools: ToolDefinition[]): Promise<ContentBlock[]> {
  const completed = {
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`data: ${JSON.stringify(completed)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as typeof fetch;
  try {
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'test' }), { formatter: new OpenAIResponsesFormatter() });
    const response = await membrane.stream({
      messages: [{ participant: 'user', content: [{ type: 'text', text: 'go' }] }],
      config: { model: 'gpt-test', maxTokens: 100 },
      tools,
    } as never);
    return (response as { content: ContentBlock[] }).content;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const itemOf = (block: ContentBlock) => (block as { rawItem?: { type?: unknown; id?: unknown } }).rawItem;

/** Each input item the Responses formatter would send for these messages, by type and id. */
function responsesWire(messages: readonly NormalizedMessage[], assistant: string): string[] {
  const built = new OpenAIResponsesFormatter().buildMessages([...messages], {
    participantMode: 'multiuser', assistantParticipant: assistant, humanParticipant: 'user', systemPrompt: 'sys',
  } as never).messages as unknown as Array<{ type?: unknown; id?: unknown }>;
  return built.map((item) => `${String(item.type ?? 'message')}${item.id ? `:${String(item.id)}` : ''}`);
}

/** Turn 1's reply, then turn 2's first request as the framework hands it to membrane. */
async function secondTurnRequest(arm: 'final-round' | 'tool-round'): Promise<{ request: { messages: NormalizedMessage[]; assistantParticipant?: string }; reply: ContentBlock[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'af-carriers-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: AGENT, model: 'test-model', systemPrompt: 'You are a test agent.' }],
    modules: [new Robot()],
  });
  try {
    let reply: ContentBlock[];
    if (arm === 'final-round') {
      reply = await responsesReply([
        COMPACTION,
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'First answer.' }] },
      ], []);
      membrane.pushResponse(createMockResponse(reply));
    } else {
      reply = await responsesReply([
        COMPACTION,
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'robot--move', arguments: '{}', status: 'completed' },
      ], [{ ...MOVE, name: 'robot--move' }]);
      membrane.pushResponse(createMockResponse(reply, 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Moved.' }]));
    }
    framework.pushEvent(said('first'));
    await framework.runUntilIdle();
    const turn1Calls = membrane.calls.length;
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Second answer.' }]));
    framework.pushEvent(said('second'));
    await framework.runUntilIdle();
    const request = membrane.calls[turn1Calls];
    assert.ok(request, `turn 2 made a request after turn 1's ${turn1Calls}`);
    return { request: request as never, reply };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a turn\'s first request carries the provider items of the turns before it', () => {
  for (const [arm, next] of [['final-round', 'message:msg_1'], ['tool-round', 'function_call:fc_1']] as const) {
    it(`carries turn 1's compaction item in turn 2's first request, after a ${arm}`, async () => {
      const { request, reply } = await secondTurnRequest(arm);
      const carrier = reply.find((block) => itemOf(block)?.type === 'compaction');
      assert.ok(carrier, 'membrane carried the compaction item on a block of the reply');
      assert.deepEqual({ type: carrier.type, text: (carrier as { text?: unknown }).text }, { type: 'text', text: '' });

      const holding = request.messages.filter((m) => m.content.some((block) => itemOf(block)?.id === 'cmp_1'));
      assert.equal(holding.length, 1, 'one message carries the compaction item');
      assert.deepEqual(holding[0]!.content.find((block) => itemOf(block)?.id === 'cmp_1'), carrier, 'as membrane gave it');

      const wire = responsesWire(request.messages, request.assistantParticipant ?? AGENT);
      assert.ok(wire.includes('compaction:cmp_1'), wire.join(', '));
      assert.ok(wire.indexOf('compaction:cmp_1') < wire.indexOf(next), `before the reply's ${next}: ${wire.join(', ')}`);
    });
  }
});

/** buildActivationRequest only needs compile(); membrane is never touched. */
function agentCompiling(messages: unknown[]): Agent {
  const cm = { compile: async () => ({ messages, systemInjections: [] }) } as unknown as ContextManager;
  return new Agent({ name: 'tester', model: 'test-model', systemPrompt: 'sys' }, cm, {} as Membrane);
}

const carrierOf = (item: Record<string, unknown>) => ({ type: 'text', text: '', rawItem: item });
const SEARCH_CALL = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'tides' } };
const SEARCH_RESULT = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] };
const STRAY_RESULT = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_user', content: [] };

/** A window holding carriers in an assistant turn and in a user turn, as the agent's request carries it. */
async function requestWithCarriers() {
  const request = await agentCompiling([
    { participant: 'human', content: [carrierOf(STRAY_RESULT), { type: 'text', text: 'When is high tide?' }] },
    { participant: 'tester', content: [carrierOf(SEARCH_CALL), carrierOf(SEARCH_RESULT), carrierOf(COMPACTION), { type: 'text', text: 'At six.' }] },
    { participant: 'human', content: [{ type: 'text', text: 'Thanks.' }] },
  ]).buildActivationRequest([]);
  return { messages: request.messages as NormalizedMessage[], assistant: request.assistantParticipant ?? 'tester' };
}

/** Every content block of what a formatter built, where its messages hold blocks rather than a string. */
function builtBlocks(messages: unknown): Array<Record<string, unknown>> {
  return (messages as Array<{ content?: unknown }>).flatMap((m) => Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []);
}

describe('membrane decides per provider what a carried item becomes', () => {
  const options = (assistant: string, extra: Record<string, unknown> = {}) =>
    ({ participantMode: 'multiuser', assistantParticipant: assistant, humanParticipant: 'user', systemPrompt: 'sys', ...extra }) as never;

  it('sends no empty text block on any wire', async () => {
    const { messages, assistant } = await requestWithCarriers();
    for (const [name, built] of [
      ['native', new NativeFormatter().buildMessages([...messages], options(assistant)).messages],
      ['native with server blocks', new NativeFormatter().buildMessages([...messages], options(assistant, { anthropicServerBlocks: true })).messages],
      ['anthropic-xml', new AnthropicXmlFormatter().buildMessages([...messages], options(assistant)).messages],
      ['completions', new CompletionsFormatter().buildMessages([...messages], options(assistant)).messages],
    ] as const) {
      for (const m of built as Array<{ content?: unknown }>) {
        if (typeof m.content === 'string') assert.notEqual(m.content.trim(), '', `${name}: an empty message`);
      }
      assert.deepEqual(builtBlocks(built).filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim() === ''), [], name);
      assert.ok(!JSON.stringify(built).includes('cmp_1'), `${name} leaves out the compaction item`);
      assert.ok(!JSON.stringify(built).includes('srvtoolu_user'), `${name} leaves out a user turn's server block`);
    }
  });

  it('sends an assistant turn\'s server-tool blocks on the native wire when server blocks are on, and not otherwise', async () => {
    const { messages, assistant } = await requestWithCarriers();
    const on = builtBlocks(new NativeFormatter().buildMessages([...messages], options(assistant, { anthropicServerBlocks: true })).messages);
    assert.deepEqual(on.filter((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result'), [SEARCH_CALL, SEARCH_RESULT]);
    const off = builtBlocks(new NativeFormatter().buildMessages([...messages], options(assistant)).messages);
    assert.deepEqual(off.filter((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result'), []);
  });

  it('sends the compaction item on the Responses wire, and no server-tool block', async () => {
    const { messages, assistant } = await requestWithCarriers();
    const wire = responsesWire(messages, assistant);
    assert.ok(wire.includes('compaction:cmp_1'), wire.join(', '));
    assert.ok(!wire.some((item) => item.startsWith('server_tool_use') || item.startsWith('web_search_tool_result')), wire.join(', '));
  });
});
