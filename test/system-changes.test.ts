/**
 * System changes' pure part: a change is recognised by its block,
 * changes fold onto the head in order, and the difference from what the agent
 * advertises now is one more change, nothing, or a replacement of the head.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemChangeContent, ToolDefinition } from '@animalabs/membrane';

import {
  declarationDifference,
  effectiveDeclaration,
  endsOnToolCall,
  isSystemChangeMessage,
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
    // The record absorbed the addition, and a rewind brought its change back:
    // applied twice, the text would be there twice, so only a new head says it.
    const absorbed = head([tool('a')], ['prompt', 'added']);
    const broughtBack: SystemChangeContent[] = [{ type: 'system_change', defineTools: [tool('a')], addSystem: ['added'] }];
    assert.deepEqual(differenceFrom(absorbed, broughtBack, head([tool('a')], ['prompt', 'added'])), { kind: 'replace' });
  });

  it('compares a definition by value, so a field left undefined is the same as one left out', () => {
    const plain = tool('a');
    const withUndefined = { ...tool('a'), extra: undefined } as unknown as ToolDefinition;
    assert.deepEqual(differenceFrom(head([plain]), [], head([withUndefined])), { kind: 'none' });
  });

  it('finds a tool call at the end past change rows, whoever made it, and none once a message follows it', () => {
    const call = { content: [{ type: 'tool_use', id: 'c1', name: 'a', input: {} }] } as never;
    const change = { content: [{ type: 'system_change', defineTools: [tool('b')] }] } as never;
    const result = { content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] } as never;
    assert.equal(endsOnToolCall([call]), true);
    assert.equal(endsOnToolCall([call, change, change]), true, 'counting back over changes');
    assert.equal(endsOnToolCall([call, result]), false);
    assert.equal(endsOnToolCall([call, result, change]), false);
    assert.equal(endsOnToolCall([]), false);
  });
});
