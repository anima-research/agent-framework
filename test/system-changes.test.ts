import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolDefinition } from '@animalabs/membrane';

import { requestCharacters, type HeadDeclaration } from '../src/system-changes.js';

const tool = (name: string, description = `${name} does a thing`, properties: Record<string, unknown> = {}): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: properties as never },
});

describe('requestCharacters', () => {
  it("counts the head and the messages as JSON, leaving out what a provider doesn't price by its characters", () => {
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
    const expected = JSON.stringify({ system: head.system, tools: head.tools, messages: strip(messages(false)) }).length;
    assert.equal(requestCharacters(head, messages(true)), expected, 'every opaque payload left out, nested ones included');
    assert.equal(requestCharacters(head, []), JSON.stringify({ system: head.system, tools: head.tools, messages: [] }).length, 'the head alone');
    const said = [{ participant: 'user', content: [{ type: 'text', text: 'x'.repeat(100) }] }];
    assert.equal(requestCharacters(head, said) - requestCharacters(head, [{ participant: 'user', content: [{ type: 'text', text: '' }] }]), 100, 'text counts character for character');
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
    assert.equal(requestCharacters(head, carrying), requestCharacters(head, plain), 'none of them counts');
    assert.equal(requestCharacters(head, []), JSON.stringify({ system: head.system, tools: head.tools, messages: [] }).length, "a tool's parameters of those names still count");
  });
});
