import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '@animalabs/context-manager';
import type { ContentBlock, ToolDefinition } from '@animalabs/membrane';

import { changeWriteCheck, requestCharacters, type HeadDeclaration } from '../src/system-changes.js';

const tool = (name: string, description = `${name} does a thing`, properties: Record<string, unknown> = {}): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: properties as never },
});

describe('where a system change may be written', () => {
  type Row = { content: unknown[]; bodyGroupId?: string; shardIndex?: number };
  const call = (...ids: string[]) => ids.map((id) => ({ type: 'tool_use', id, name: 'a', input: {} }));
  const result = (...ids: string[]) => ids.map((id) => ({ type: 'tool_result', toolUseId: id, content: 'ok' }));
  const change = { content: [{ type: 'system_change', defineTools: [tool('b')] }] };
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
  const cases: Array<[string, Row[], boolean]> = [
    ['a call last', [text('hi'), { content: call('c1') }], true],
    ['a call, then changes', [{ content: call('c1') }, change, change], true],
    ['a call, its result, a change', [{ content: call('c1') }, { content: result('c1') }, change], false],
    ['parallel calls, one answered', [{ content: call('c1', 'c2') }, { content: result('c1') }], true],
    ['parallel calls, each answered in a message of its own', [{ content: call('c1', 'c2') }, { content: result('c2') }, { content: result('c1') }], false],
    ['a cycle its own blocks answer', [{ content: [...call('c1'), ...result('c1')] }], false],
    ['a cycle that leaves one call open', [{ content: [...call('c1', 'c2'), ...result('c1')] }], true],
    ['a call on the first shard, text on the last', [text('hi'), { content: call('c1'), bodyGroupId: 'g', shardIndex: 0 }, { content: [{ type: 'text', text: 'more' }], bodyGroupId: 'g', shardIndex: 1 }], true],
    ['a shard that starts another body', [{ content: call('c1'), bodyGroupId: 'g', shardIndex: 1 }, { content: [{ type: 'text', text: 'again' }], bodyGroupId: 'g', shardIndex: 0 }], false],
    ['a message of another kind after the call', [{ content: call('c1') }, text('meanwhile')], false],
    ['an older call, past the nearest one answered', [{ content: call('c0') }, { content: call('c1') }, { content: result('c1') }], false],
    ['nothing but changes', [change], false],
    ['nothing', [], false],
  ];
  const splits = (rows: Row[]) => {
    const check = changeWriteCheck();
    for (let i = rows.length - 1; i >= 0; i--) if (check.visit(rows[i] as never)) break;
    return check.splits();
  };

  it("says where a change written at the end would split a call from its result, as context-manager 0.22.0's refusal reads the store", () => {
    for (const [what, rows, expected] of cases) assert.equal(splits(rows), expected, what);
  });

  it("refuses a change at the end of a real store exactly where it says one would split a call", () => {
    const dir = mkdtempSync(join(tmpdir(), 'change-write-parity-'));
    try {
      cases.forEach(([what, rows], n) => {
        const store = JsStore.openOrCreate({ path: join(dir, `${n}.chronicle`) });
        MessageStore.register(store);
        const messages = new MessageStore(store);
        const open = new Set<string>();
        const scaffolds: string[] = [];
        for (const row of rows) {
          const blocks = row.content as Array<{ type: string; id?: string; toolUseId?: string }>;
          if (blocks.some((block) => block.type === 'system_change') && open.size > 0) {
            scaffolds.push(messages.append('user', [...open].map((id) => ({ type: 'tool_result', toolUseId: id, content: 'ok' })) as ContentBlock[]).id);
            open.clear();
          }
          for (const block of blocks) {
            if (block.type === 'tool_use') open.add(block.id!);
            if (block.type === 'tool_result') open.delete(block.toolUseId!);
          }
          messages.append('user', row.content as ContentBlock[], undefined, undefined, row.bodyGroupId === undefined ? undefined : { bodyGroupId: row.bodyGroupId, shardIndex: row.shardIndex });
        }
        for (const id of scaffolds) messages.remove(id);
        let refused = false;
        try {
          messages.append('system', change.content as ContentBlock[]);
        } catch (error) {
          if (!/a system change can't go between a tool call and its result/.test((error as Error).message)) throw error;
          refused = true;
        }
        assert.equal(refused, splits(rows), what);
        store.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
