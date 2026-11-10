import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MessageStore } from '@animalabs/context-manager';
import type { ContentBlock, SystemChangeContent, ToolDefinition } from '@animalabs/membrane';

import {
  copyHead,
  declarationDifference,
  effectiveDeclaration,
  changeWriteCheck,
  isSystemChangeMessage,
  ownSystemChanges,
  requestCharacters,
  systemChangeMetadata,
  systemTextOf,
  type HeadDeclaration,
} from '../src/system-changes.js';

const tool = (name: string, description = `${name} does a thing`, properties: Record<string, unknown> = {}): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: properties as never },
});

const head = (tools: ToolDefinition[], system: string[] = ['You are an agent.']): HeadDeclaration => ({ tools, system });

const differenceFrom = (before: HeadDeclaration, changes: SystemChangeContent[], now: HeadDeclaration) =>
  declarationDifference(effectiveDeclaration(before, changes), now);

describe('system changes', () => {
  it('recognises a change message by its block, with or without metadata', () => {
    assert.equal(isSystemChangeMessage({ content: [{ type: 'system_change', removeTools: ['a'] }] }), true);
    assert.equal(isSystemChangeMessage({ content: [{ type: 'text', text: 'system_change' }] }), false);
    assert.equal(isSystemChangeMessage({ content: [] }), false);
    assert.equal(isSystemChangeMessage({ content: undefined } as never), false, 'a damaged row with no content array');
  });

  it('compares a tool as the wire carries it, so a Date in its schema matches the text its recorded head holds', () => {
    const dated = { ...tool('a'), inputSchema: { type: 'object', properties: { when: { type: 'string', default: new Date('2026-01-01T00:00:00Z') } } } } as unknown as ToolDefinition;
    assert.deepEqual(differenceFrom(copyHead(head([dated])), [], head([dated])), { kind: 'none' });
  });

  it("finds an agent's own changes in a compile by the metadata of the rows it names as their sources", () => {
    const change = (n: string) => [{ type: 'system_change', defineTools: [tool(n)] }] as never;
    const row = (id: string, metadata?: Record<string, unknown>) => ({ id, ...(metadata ? { metadata } : {}) });
    const raw = (...ids: string[]) => ({ kind: 'raw' as const, bodies: ids.map((messageId, sequence) => ({ messageId, sequence, complete: true })) });
    const compiled = {
      messages: [
        { participant: 'user', content: [{ type: 'text', text: 'hello' }] },
        { participant: 'system', content: change('a') },
        { participant: 'system', content: change('b') },
        { participant: 'system', content: change('c') },
        { participant: 'system', content: change('d') },
        { participant: 'system', content: change('e') },
        { participant: 'system', content: change('f') },
        { participant: 'system', content: change('g') },
        { participant: 'system', content: change('h') },
      ],
      provenance: {
        messages: [raw('said'), raw('own'), raw('other'), raw('host'), { kind: 'summary', summaries: [{ id: 's', level: 1 }] }, raw('own', 'host'), raw('own', 'own2'), raw('unread'), raw('named')],
      },
      rawBodies: new Map([
        ['said', [row('said', systemChangeMetadata('agent'))]],
        ['own', [row('own', systemChangeMetadata('agent'))]],
        ['own2', [row('own2', { kind: 'system-change', agent: 'agent' })]],
        ['named', [row('named', { system: true, agent: 'agent' })]],
        ['other', [row('other', systemChangeMetadata('other'))]],
        ['host', [row('host')]],
      ]),
    } as unknown as Parameters<typeof ownSystemChanges>[0];
    assert.deepEqual([...ownSystemChanges(compiled, (name) => name === 'agent')], [1, 6],
      "a change from the agent's own rows alone: not a message that isn't a change, another agent's, a host's without metadata, a summary, one with a host's row among its sources, one whose row the compile didn't read, or one whose row names the agent but isn't marked a change");
    assert.deepEqual([...ownSystemChanges(compiled, (name) => name === 'other')], [2]);
    assert.deepEqual([...ownSystemChanges({ messages: compiled.messages }, (name) => name === 'agent')], [], 'a compile that names no sources has none');
  });

  it('joins the head\'s system blocks as buildSystemPrompt does', () => {
    assert.equal(systemTextOf(['prompt']), 'prompt');
    assert.equal(systemTextOf(['prompt', 'one', 'two']), 'prompt\none\ntwo');
  });

  it('folds each change\'s removals, then definitions, then text, change by change', () => {
    const before = head([tool('a'), tool('b')], ['prompt']);
    const folded = effectiveDeclaration(before, [
      { type: 'system_change', removeTools: ['a'], defineTools: [tool('c')], addSystem: ['first'] },
      { type: 'system_change', removeTools: ['c'], defineTools: [tool('a', 'a, redefined')], addSystem: ['second'] },
    ]);
    assert.deepEqual([...folded.tools.keys()].sort(), ['a', 'b']);
    assert.equal(folded.tools.get('a')!.description, 'a, redefined');
    assert.deepEqual(folded.system, ['prompt', 'first', 'second']);
  });

  it('folds a block that removes and defines the same tool to the definition', () => {
    const folded = effectiveDeclaration(head([tool('a')]), [{ type: 'system_change', removeTools: ['a'], defineTools: [tool('a', 'a, again')] }]);
    assert.equal(folded.tools.get('a')!.description, 'a, again', 'removals first, then definitions');
  });

  it('declares a tool whose schema alone changed', () => {
    const before = head([tool('a', 'a', { x: { type: 'string' } })]);
    const now = head([tool('a', 'a', { x: { type: 'number' } })]);
    assert.deepEqual(differenceFrom(before, [], now), { kind: 'change', block: { type: 'system_change', defineTools: [tool('a', 'a', { x: { type: 'number' } })] } });
  });

  it('finds nothing to declare when the tools and text are the same, in any order', () => {
    const before = head([tool('a'), tool('b', 'b', { x: { type: 'string' }, y: { type: 'number' } })], ['prompt', 'one', 'two']);
    const now = head([tool('b', 'b', { y: { type: 'number' }, x: { type: 'string' } }), tool('a')], ['prompt', 'two', 'one']);
    assert.deepEqual(differenceFrom(before, [], now), { kind: 'none' });
  });

  it('declares an added, a removed and a redefined tool as one change', () => {
    const before = head([tool('keep'), tool('gone'), tool('changed', 'old words')]);
    const now = head([tool('keep'), tool('changed', 'new words'), tool('new')]);
    assert.deepEqual(differenceFrom(before, [], now), {
      kind: 'change',
      block: { type: 'system_change', removeTools: ['gone'], defineTools: [tool('changed', 'new words'), tool('new')] },
    });
  });

  it('declares only what the changes so far haven\'t', () => {
    const before = head([tool('a')]);
    const changes: SystemChangeContent[] = [{ type: 'system_change', defineTools: [tool('b')] }];
    assert.deepEqual(differenceFrom(before, changes, head([tool('a'), tool('b')])), { kind: 'none' });
    assert.deepEqual(differenceFrom(before, changes, head([tool('a'), tool('b'), tool('c')])), {
      kind: 'change',
      block: { type: 'system_change', defineTools: [tool('c')] },
    });
  });

  it('declares new system blocks as an addition, in current order, beside a tool change', () => {
    const before = head([tool('a')], ['prompt', 'kept']);
    const now = head([tool('a'), tool('b')], ['prompt', 'new one', 'kept', 'new two']);
    assert.deepEqual(differenceFrom(before, [], now), {
      kind: 'change',
      block: { type: 'system_change', defineTools: [tool('b')], addSystem: ['new one', 'new two'] },
    });
  });

  it('reads a changed, a removed or a cut block of system text as a replacement', () => {
    const before = head([], ['prompt', 'instructions as they were']);
    assert.deepEqual(differenceFrom(before, [], head([], ['prompt', 'instructions as edited'])), { kind: 'replace' });
    assert.deepEqual(differenceFrom(before, [], head([], ['prompt'])), { kind: 'replace' });
    assert.deepEqual(differenceFrom(before, [], head([], ['prompt edited', 'instructions as they were'])), { kind: 'replace' });
  });

  it('counts a repeated block each time it appears', () => {
    assert.deepEqual(differenceFrom(head([], ['p', 'x']), [], head([], ['p', 'x', 'x'])), {
      kind: 'change',
      block: { type: 'system_change', addSystem: ['x'] },
    });
    assert.deepEqual(differenceFrom(head([], ['p', 'x', 'x']), [], head([], ['p', 'x'])), { kind: 'replace' });
  });

  it('reads an addition the head already holds as a replacement, as after a rewind past a consolidation', () => {
    const absorbed = head([tool('a')], ['prompt', 'added']);
    const broughtBack: SystemChangeContent[] = [{ type: 'system_change', defineTools: [tool('a')], addSystem: ['added'] }];
    assert.deepEqual(differenceFrom(absorbed, broughtBack, head([tool('a')], ['prompt', 'added'])), { kind: 'replace' });
  });

  it('compares a definition by value, so a field left undefined is the same as one left out', () => {
    const plain = tool('a');
    const withUndefined = { ...tool('a'), extra: undefined } as unknown as ToolDefinition;
    assert.deepEqual(differenceFrom(head([plain]), [], head([withUndefined])), { kind: 'none' });
  });

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
