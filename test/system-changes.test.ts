import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, ToolDefinition } from '@animalabs/membrane';

import { jsonTokenEstimator } from '@animalabs/context-manager';
import { requestTokens, type HeadDeclaration } from '../src/system-changes.js';
import { isSystemChangeMessage } from '../src/index.js';

const tool = (name: string, description = `${name} does a thing`, properties: Record<string, unknown> = {}): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: properties as never },
});

describe('requestTokens', () => {
  it("counts the head and the messages as context-manager estimates JSON, leaving out what a provider doesn't price by its characters, and adds each media block at its price", () => {
    const head: HeadDeclaration = { tools: [tool('a')], system: ['You are an agent.'] };
    const source = (data: string) => ({ type: 'base64', mediaType: 'image/png', data });
    const messages = (opaque: boolean) => [
      { participant: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: source(opaque ? 'A'.repeat(1000) : '') }, { type: 'document', source: source(opaque ? 'D'.repeat(1000) : '') }] },
      { participant: 'agent', content: [
        { type: 'thinking', thinking: 'why', signature: opaque ? 'S'.repeat(1000) : '' },
        { type: 'redacted_thinking', data: opaque ? 'R'.repeat(1000) : '' },
        { type: 'generated_image', mimeType: 'image/png', data: opaque ? 'G'.repeat(1000) : '' },
        { type: 'text', text: 'so', rawItem: opaque ? { type: 'server_tool_use', input: 'I'.repeat(1000) } : '' },
      ] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: [{ type: 'image', source: source(opaque ? 'T'.repeat(1000) : '') }] }] },
    ];
    const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (key, v) => (key === 'data' || key === 'signature' || key === 'rawItem' ? undefined : v));
    const media = 3 * 1600 + 1000;
    const expected = jsonTokenEstimator(JSON.stringify({ system: head.system, tools: head.tools, messages: strip(messages(false)) })) + media;
    assert.equal(requestTokens(head, messages(true)), expected, 'every opaque payload left out, nested ones included, and each media block at its price');
    assert.equal(requestTokens(head, []), jsonTokenEstimator(JSON.stringify({ system: head.system, tools: head.tools, messages: [] })), 'the head alone');
    const said = [{ participant: 'user', content: [{ type: 'text', text: 'x'.repeat(100) }] }];
    assert.equal(requestTokens(head, said), jsonTokenEstimator(JSON.stringify({ system: head.system, tools: head.tools, messages: said })), 'text as the JSON that carries it');
  });

  it("leaves out the fields a request on the native formatter doesn't send: a parsed block's raw text, a call's unparsed arguments and a block's estimate", () => {
    const head: HeadDeclaration = { tools: [tool('a', 'a does a thing', { rawXml: { type: 'string' }, tokenEstimate: { type: 'number' } })], system: ['You are an agent.'] };
    const call = { type: 'tool_use', id: 'c', name: 'a', input: {} };
    const result = { type: 'tool_result', toolUseId: 'c', content: [{ type: 'text', text: 'done' }] };
    const plain = [{ participant: 'agent', content: [call, { type: 'thinking', thinking: 'why' }] }, { participant: 'user', content: [result] }];
    const carrying = [
      { participant: 'agent', content: [{ ...call, rawXml: '<function_calls>'.repeat(100), unparseableInput: '{"a": '.repeat(100) }, { type: 'thinking', thinking: 'why', tokenEstimate: 123456 }] },
      { participant: 'user', content: [{ ...result, rawXml: '<function_results>'.repeat(100), rawXmlImagesAt: 12345, content: [{ type: 'text', text: 'done', tokenEstimate: 7 }] }] },
    ];
    assert.equal(requestTokens(head, carrying), requestTokens(head, plain), 'none of them counts');
    assert.equal(requestTokens(head, []), jsonTokenEstimator(JSON.stringify({ system: head.system, tools: head.tools, messages: [] })), "a tool's parameters of those names still count");
  });
});

describe('isSystemChangeMessage', () => {
  it('tells a system change row by its blocks, whatever metadata it carries, so a host can leave it out of conversation', () => {
    const row = (content: ContentBlock[], metadata?: Record<string, unknown>): { content: ContentBlock[]; metadata?: Record<string, unknown> } =>
      (metadata ? { content, metadata } : { content });
    const change: ContentBlock = { type: 'system_change', defineTools: [{ name: 'a', description: 'A.', inputSchema: { type: 'object' } }] };
    for (const metadata of [undefined, { system: true, kind: 'system-change', agent: 'alpha' }, { system: true }]) {
      assert.equal(isSystemChangeMessage(row([change], metadata)), true, JSON.stringify(metadata));
    }
    // The lowest membrane in this package's range doesn't type `effort`.
    assert.equal(isSystemChangeMessage(row([{ type: 'system_change', effort: 'low' } as unknown as ContentBlock])), true, 'a row that changes only the effort');
    assert.equal(isSystemChangeMessage(row([{ type: 'text', text: 'hello' }], { system: true, kind: 'system-change' })), false, 'conversation, whatever its mark says');
    assert.equal(isSystemChangeMessage(row([{ type: 'tool_result', toolUseId: 't1', content: 'ok' }])), false);
  });
});
