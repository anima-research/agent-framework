import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemChangeContent, ToolDefinition } from '@animalabs/membrane';

import {
  declarationDifference,
  effectiveDeclaration,
  changeWriteCheck,
  isSystemChangeMessage,
  ownSystemChanges,
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

  it("says where a change written at the end would split a call from its result, as context-manager 0.22.0's refusal reads the store", () => {
    type Row = { content: unknown[]; bodyGroupId?: string; shardIndex?: number };
    const call = (...ids: string[]) => ids.map((id) => ({ type: 'tool_use', id, name: 'a', input: {} }));
    const result = (...ids: string[]) => ids.map((id) => ({ type: 'tool_result', toolUseId: id, content: 'ok' }));
    const change = { content: [{ type: 'system_change', defineTools: [tool('b')] }] };
    const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
    const splits = (rows: Row[]) => {
      const check = changeWriteCheck();
      for (let i = rows.length - 1; i >= 0; i--) if (check.visit(rows[i] as never)) break;
      return check.splits();
    };
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
    for (const [what, rows, expected] of cases) assert.equal(splits(rows), expected, what);
  });
});
