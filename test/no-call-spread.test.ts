/**
 * A call given a list as its arguments throws a RangeError once the list is
 * longer than a call can take, about 125,000 arguments on Node 24.22.2, and a
 * list whose length comes from data can get that long. A list becomes a
 * call's arguments through a spread (`f(...list)`, `new C(...list)`) or
 * through apply (`f.apply(self, list)`, `Reflect.apply(f, self, list)`,
 * `Reflect.construct(C, list)`). So src passes such a list whole, with
 * appendAll, a loop or a reduce, and gives none to a call as its arguments.
 *
 * This scan reads src as syntax trees and fails on any call, optional call
 * or `new` with a spread argument, any `Reflect.apply` or `Reflect.construct`,
 * and any call of a member named `apply` with two arguments, outside the
 * calls LEFT names, each with why its list stays short. A call LEFT names
 * that src no longer has fails too, so the list stays true. To keep a new
 * one, add its call here with its reason. Spreads in array or object
 * literals aren't arguments, an `apply` given one argument passes no list,
 * and comments aren't read.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

/** The calls in src that keep a list as their arguments, by file and source text (whitespace runs read as one space), once per call. */
const LEFT: ReadonlyArray<{ file: string; calls: readonly string[]; why: string }> = [
  {
    file: 'framework.ts',
    calls: [
      'Reflect.apply(value, membrane, [request, { ...options, signal }, ...rest])',
      'Reflect.apply(value, this.membrane, sent)',
    ],
    why: "passes on the arguments a proxied method's own call was given, its options argument replaced or not",
  },
  {
    file: 'mcpl/push-coalescer.ts',
    calls: ['this.host.deliver(...args)'],
    why: 'passes on its own rest parameter: no more arguments than its own call was given',
  },
  {
    file: 'mcpl/server-connection.ts',
    calls: [
      'this.dispatchInboundEvent(event, ...args)',
      'super.emit(event, ...args)',
      'super.emit(event, ...args)',
      'this.emit(event, ...args)',
    ],
    why: "passes on an event's arguments: emit's or dispatchInboundEvent's rest parameter, or a held event's, which hold() kept from emit's or as a message's one or two",
  },
  {
    file: 'modules/history/index.ts',
    calls: ['count(...win(e))', 'fetch(...win(inside), inCount)', 'fetch(...win(mid), c)', 'fetch(...win(out), cnt(out))'],
    why: "win() returns a window's two bounds",
  },
  {
    file: 'modules/workspace/index.ts',
    calls: [
      'join(rootReal, ...segments)',
      'join(outerPath, ...segments.slice(0, i))',
      'join(rootReal, ...segments.slice(0, i))',
      'join(root, ...segments.slice(0, i))',
    ],
    why: "a path's segments: a configured mount path's, or the levels of a path the agent names, walked only until one isn't on disk",
  },
  {
    file: 'modules/workspace/observe.ts',
    calls: ['join(rootReal, ...segments.slice(0, i))'],
    why: "the levels of a path the agent names, walked only until one isn't on disk",
  },
];

type Node = { type: string; start?: number | null; end?: number | null; loc?: { start: { line: number } } | null; [field: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

interface ListCall {
  file: string;
  line: number;
  /** The call's source text, whitespace runs read as one space. */
  call: string;
}

/** The property a member expression reads when it's written as a name (`a.b`, `a?.b`), and the object it reads it of when that's a name too. */
function member(node: unknown): { object?: string; property: string } | undefined {
  if (!isNode(node) || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') || node.computed) return undefined;
  const property = isNode(node.property) && node.property.type === 'Identifier' ? node.property.name as string : undefined;
  if (property === undefined) return undefined;
  return { object: isNode(node.object) && node.object.type === 'Identifier' ? node.object.name as string : undefined, property };
}

/** Whether a call gives a list to its callee as its arguments: a spread argument, `Reflect.apply` or `Reflect.construct`, or a member named `apply` given two arguments. */
function givesList(node: Node): boolean {
  const args = node.arguments as unknown[];
  if (args.some((arg) => isNode(arg) && arg.type === 'SpreadElement')) return true;
  if (node.type === 'NewExpression') return false;
  const callee = member(node.callee);
  if (callee?.object === 'Reflect' && (callee.property === 'apply' || callee.property === 'construct')) return true;
  return callee?.property === 'apply' && args.length === 2;
}

/** Every call, optional call and `new` in `sources` that gives a list as its arguments, as Babel's TypeScript parser reads them. */
function listCallsIn(sources: Array<{ name: string; text: string }>): ListCall[] {
  const found: ListCall[] = [];
  for (const { name: file, text } of sources) {
    const program = parse(text, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node;
    const walk = (node: Node): void => {
      if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression') && givesList(node)) {
        found.push({ file, line: node.loc?.start.line ?? 0, call: text.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ') });
      }
      for (const [field, value] of Object.entries(node)) {
        if (field === 'leadingComments' || field === 'trailingComments' || field === 'innerComments') continue;
        if (Array.isArray(value)) { for (const v of value) if (isNode(v)) walk(v); }
        else if (isNode(value)) walk(value);
      }
    };
    walk(program);
  }
  return found;
}

/** Every `.ts` file under `root`, named by its path from there with `/` between its parts, as LEFT names it. */
function sourcesUnder(root: string): Array<{ name: string; text: string }> {
  const sources: Array<{ name: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) sources.push({ name: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return sources;
}

it('src gives no list to a call as its arguments, by spread or apply, outside the calls LEFT names, and has each of those', () => {
  const sources = sourcesUnder(fileURLToPath(new URL('../../src/', import.meta.url)));
  assert.ok(sources.some((s) => s.name === 'framework.ts'), 'the walk reaches the framework');
  assert.ok(sources.some((s) => s.name.includes('/')), "the walk reaches src's subdirectories");
  const left = new Map<string, number>();
  for (const { file, calls } of LEFT) for (const call of calls) left.set(`${file} ${call}`, (left.get(`${file} ${call}`) ?? 0) + 1);
  const unlisted: string[] = [];
  for (const found of listCallsIn(sources)) {
    const key = `${found.file} ${found.call}`;
    const count = left.get(key) ?? 0;
    if (count > 0) left.set(key, count - 1);
    else unlisted.push(`${found.file}:${found.line} ${found.call}`);
  }
  assert.deepEqual(unlisted, [], [
    'These calls in src are given a list as their arguments, by a spread or by apply:',
    ...unlisted.map((line) => `  ${line}`),
    'A call throws a RangeError once its list passes about 125,000 items, and a list whose length comes from data can get that long.',
    'Pass the list whole instead: for a push, appendAll(into, items) from src/append-all.ts; otherwise a loop or a reduce.',
    "If the call's list stays short, add the call to LEFT in test/no-call-spread.test.ts, with why.",
  ].join('\n'));
  const gone = [...left].filter(([, count]) => count > 0).map(([key, count]) => `${key}${count > 1 ? ` (${count} times)` : ''}`);
  assert.deepEqual(gone, [], [
    'LEFT in test/no-call-spread.test.ts names calls src no longer has:',
    ...gone.map((line) => `  ${line}`),
    'Remove them from LEFT.',
  ].join('\n'));
});

it('the scan finds a list given as arguments by a spread or by apply, and not a literal spread, a parameter, a one-argument apply or a comment', () => {
  const found = listCallsIn([{
    name: 'planted.ts',
    text: [
      '// queue.push(...items), in a comment, is no call',
      'function f(...args: number[]) { return [...args, { ...args }]; }',
      'queue.push(...items);',
      'maybe?.push(1, ...items);',
      'const s = new Set(...[items]);',
      'Math.max(',
      '  ...items,',
      ');',
      'Math.max.apply(null, items);',
      'Array.prototype.push.apply(queue, items);',
      'Reflect.apply(f, null, items);',
      'Reflect.construct(Set, [items]);',
      'this.output.apply(text);',
      'patch.apply(text);',
    ].join('\n'),
  }]);
  assert.deepEqual(found.map((s) => `${s.line} ${s.call}`), [
    '3 queue.push(...items)',
    '4 maybe?.push(1, ...items)',
    '5 new Set(...[items])',
    '6 Math.max( ...items, )',
    '9 Math.max.apply(null, items)',
    '10 Array.prototype.push.apply(queue, items)',
    '11 Reflect.apply(f, null, items)',
    '12 Reflect.construct(Set, [items])',
  ]);
});
