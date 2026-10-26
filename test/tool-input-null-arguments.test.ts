/**
 * A tool call whose arguments text is JSON `null`, as an OpenAI-family
 * provider can send it. From membrane 0.6.0 every adapter hands a call's
 * input over as a plain object, so `"null"` arrives as `{}`, with the text
 * kept in `unparseableInput`. On membrane 0.5.87 the OpenAI-family adapters'
 * `safeParseJson` gave `null`, and a tool that read a field of its input
 * answered the model with a TypeError ("Cannot read properties of null").
 * `skip_reply` reads a null input as no wake since agent-framework#501, so
 * the framework half below, `skip_reply` running as a call with no
 * arguments, is a control: it passes with either input. The input
 * assertions are what need membrane 0.6.0.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, NativeFormatter, OpenAICompatibleAdapter } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** The content blocks membrane's OpenAI-compatible adapter makes of a reply
 *  that calls `skip_reply` with `args` as its arguments text, with the HTTP
 *  call stubbed. */
async function openAICompatibleReply(args: string): Promise<ContentBlock[]> {
  const body = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'skip_reply', arguments: args } }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    const membrane = new Membrane(
      new OpenAICompatibleAdapter({ baseURL: 'http://127.0.0.1:9', apiKey: 'test' }),
      { formatter: new NativeFormatter() },
    );
    const response = await membrane.complete({
      messages: [{ participant: 'user', content: [{ type: 'text', text: 'nothing to say' }] }],
      config: { model: 'test-model', maxTokens: 100 },
      tools: [{ name: 'skip_reply', description: 'End the turn without replying.', inputSchema: { type: 'object', properties: {} } }],
    } as never);
    return (response as { content: ContentBlock[] }).content;
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('a tool call whose arguments are JSON null', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tool-input-null-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('arrives from the OpenAI-compatible adapter as {}, and skip_reply runs as a call with no arguments', async () => {
    const content = await openAICompatibleReply('null');
    const call = content.find((block) => block.type === 'tool_use') as
      | { type: 'tool_use'; name: string; input: unknown; unparseableInput?: string }
      | undefined;
    assert.ok(call, `the reply carries the call: ${JSON.stringify(content)}`);
    assert.deepEqual(call.input, {}, 'the input is an empty object, not null');
    assert.equal(call.unparseableInput, 'null', 'the arguments text is kept beside it');

    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(content, 'tool_use'));
    // Requested only if the turn went on past the call.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'after the call' }] as ContentBlock[]));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [],
    });
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new ChannelRegistry(
      {} as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {}, { eventGatePresent: false },
    );
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => { traces.push(event); });
    try {
      await (framework as unknown as {
        startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
      }).startAgentStream(framework.getAgent('agent')!, {
        agentName: 'agent', reason: 'test', source: 'test', timestamp: Date.now(),
      });
      await framework.runUntilIdle();

      const outcome = traces.filter((t) => (t.type === 'tool:completed' || t.type === 'tool:failed')
        && (t as { callId?: string }).callId === 'call_1');
      assert.deepEqual(outcome.map((t) => t.type), ['tool:completed'], `skip_reply ran without an error: ${JSON.stringify(outcome)}`);
      assert.deepEqual(membrane.lastStream?.receivedToolResults, [], 'the turn ended at the call, so no result went back to the model');
      assert.equal(membrane.calls.length, 1, 'and nothing more was requested');
    } finally {
      await framework.stop();
    }
  });
});
