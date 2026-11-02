/**
 * The deferral queue is gone (#291, AF-6): a write is stored at once, and
 * enters each agent's window at that agent's presentation points. Only a
 * surgery's hold keeps a write out of the store, in memory, until its
 * release. A release before it left its queue on disk, which the importer
 * reads once at boot (src/deferred-import.ts and the framework's
 * importPersistedDeferredWrites), for one release.
 *
 * This scan reads src and test as syntax trees and fails on any name of the
 * queue's machinery (its state, its flushes, its persistence, the tune-out
 * coordinator's queued half, the shared-slot holds, the assembly bypass and
 * the removed flag) outside the importer's file and method, so the queue
 * can't come back in a write path piece by piece, nor a test lean on it
 * (AF-8). In test it also fails on the released window's held part (a
 * released window read with a second argument, the set of writes the queue
 * held) and on a `held:` handle, the id a release before #291 answered for
 * a write it queued, outside the one-release test of that handle. Comments
 * aren't read.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

/** Names the queue's machinery had. A name matches as an identifier, a
 *  member or a key, and `bypassDeferral` also as the prefix of one. */
const GONE = [
  // The queue's state, its flushes and its persistence.
  'deferredMessages', 'unackedDeferredWrites', 'deferredSeq', 'deferredScanFrom', 'deferredWritesPersisted',
  'drainDeferredFor', 'requeueDrained', 'writeDrainedInOrder', 'readdDrained', 'flushForStart', 'queuedFor',
  'flushDeferredWrites', 'ackDeferredWrites', 'handOffDeferredWrites', 'persistDeferredWrites',
  'writeDeferredWritesForQuiesce', 'restorePersistedDeferredWrites', 'fromQueue', 'deferredId',
  'DeferredWrite', 'DrainedWrite', 'storedCopiesOf', 'logDeferredWriteError', 'passOnFromReleasedWindow',
  // The module API's handles onto queued writes, and the wakes that read them.
  'heldHandle', 'heldWritesFor', 'heldRows', 'settleUnknownLandings', 'deferredWriteDone', 'readsDeferredWrite',
  'readsDeferredFor', 'resolvePlacement', 'refuseUnsettled',
  // The tune-out coordinator's queued half.
  'getDeferredMessages', 'readerHandedWrites', 'QueuedHeldMessage', 'queuedHeld', 'queuedReaderRows',
  // The holds of the residents' shared slot, and the assembly's bypass.
  'sharedSlotBusy', 'slotHeldFrom', 'noteForOtherResidents', 'bypassDeferral',
  // The flag that kept the queue: presentation is mandatory.
  'presentationIndex',
] as const;

/** Where the one-release importer may name what it reads: the reader's file, and the framework's method. */
const IMPORTER = { file: 'deferred-import.ts', scope: 'AgentFramework.importPersistedDeferredWrites' } as const;

/**
 * Test files that may name what the scan otherwise refuses, each for what
 * it checks. This file names every one of them, in its lists and in the
 * sources it plants.
 */
const TEST_ALLOWED: Record<string, { names?: readonly string[]; handles?: true; why: string }> = {
  'no-deferral-residue.test.ts': { names: GONE, handles: true, why: 'the scan itself' },
  'presentation-mandatory.test.ts': { names: ['presentationIndex'], why: "a host's configuration that still names the removed flag passes" },
  'module-held-writes.test.ts': { handles: true, why: 'for one release, a `held:` handle an earlier release answered reaches its row' },
};

/** The released window, read for one agent: the queue's held writes, its second argument once, are gone. */
const RELEASED = new Set(['releasedWindow', 'releaseWindow']);

type Node = { type: string; loc?: { start: { line: number } } | null; [field: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

/** What the source does, with where: its file, line and the named scopes around it (a class, then a method or function). */
interface Use {
  file: string;
  line: number;
  /** A name used, or a string's text. */
  name: string;
  scope: string;
  /** For the released window: how many arguments it is given, or parameters it is typed with, more than the agent. */
  extra?: number;
  /** A string's text, which a handle is. */
  string?: true;
}

/** The name of a key or a member's property, when it is written as a name or a string. */
function keyName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Identifier') return node.name as string;
  if (node.type === 'StringLiteral') return node.value as string;
  if (node.type === 'PrivateName' && isNode(node.id)) return node.id.name as string;
  return undefined;
}

/** The property a member expression reads (`a.b`, `a?.b`, `a['b']`), or undefined. */
function memberName(node: unknown): string | undefined {
  if (!isNode(node) || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) return undefined;
  return keyName(node.property);
}

/** How many parameters a function, or a function's type, takes; undefined for anything else. */
function arity(node: unknown): number | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'TSParenthesizedType' || node.type === 'TSTypeAnnotation') return arity(node.typeAnnotation);
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return (node.params as unknown[]).length;
  if (node.type === 'TSFunctionType') return ((node.parameters ?? node.params) as unknown[]).length;
  return undefined;
}

/**
 * Every identifier, private name, and string key or member in `sources`,
 * as Babel's TypeScript parser reads them, with the class and method or
 * function around each, and every read or typing of the released window
 * with more than the agent. Comments aren't read.
 */
function namesIn(sources: Array<{ name: string; text: string }>): Use[] {
  const uses: Use[] = [];
  for (const { name: file, text } of sources) {
    const program = parse(text, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node;
    const walk = (node: Node, scope: string[]): void => {
      let named: string | undefined;
      const id = (n: unknown): string | undefined => (isNode(n) && n.type === 'Identifier' ? n.name as string : undefined);
      switch (node.type) {
        case 'ClassDeclaration': case 'ClassExpression': case 'FunctionDeclaration': named = id(node.id); break;
        case 'ClassMethod': case 'ClassPrivateMethod': case 'TSDeclareMethod': named = id(node.key); break;
      }
      const inner = named ? [...scope, named] : scope;
      const use = (name: string, more: Partial<Use> = {}) =>
        uses.push({ file, line: node.loc?.start.line ?? 0, name, scope: inner.join('.'), ...more });
      if (node.type === 'Identifier') use(node.name as string);
      if (node.type === 'PrivateName' && isNode(node.id)) use(node.id.name as string);
      if (node.type === 'StringLiteral') use(node.value as string, { string: true });
      if (node.type === 'TemplateElement') use(((node.value as { cooked?: string | null }).cooked ?? ''), { string: true });
      const released = (name: string | undefined, count: number | undefined) => {
        if (name !== undefined && RELEASED.has(name) && count !== undefined && count > 1) use(name, { extra: count - 1 });
      };
      switch (node.type) {
        // A read with more than the agent: X.releasedWindow(agent, held).
        case 'CallExpression': case 'OptionalCallExpression':
          released(memberName(node.callee), (node.arguments as unknown[]).length); break;
        // A method of the shape: releasedWindow(agent, held) { … } or `releasedWindow(agent, held): …` in a type.
        case 'ClassMethod': case 'ClassPrivateMethod': case 'TSDeclareMethod': case 'ObjectMethod': case 'TSMethodSignature':
          released(keyName(node.key), ((node.params ?? node.parameters) as unknown[]).length); break;
        // A key typed or given a function of the shape: `releasedWindow: (agent, held) => …`.
        case 'TSPropertySignature': case 'ObjectProperty': case 'ClassProperty':
          released(keyName(node.key), arity(node.typeAnnotation ?? node.value)); break;
        // A stand-in put in its place: X.releasedWindow = (agent, held) => ….
        case 'AssignmentExpression':
          released(memberName(node.left), arity(node.right)); break;
        // A read cast to the shape: (X.releasedWindow as (agent, held) => …).
        case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSTypeAssertion':
          released(memberName(node.expression), arity(node.typeAnnotation)); break;
      }
      for (const [field, value] of Object.entries(node)) {
        if (field === 'leadingComments' || field === 'trailingComments' || field === 'innerComments') continue;
        if (Array.isArray(value)) { for (const v of value) if (isNode(v)) walk(v, inner); }
        else if (isNode(value)) walk(value, inner);
      }
    };
    walk(program, []);
  }
  return uses;
}

const gone = (use: Use): boolean =>
  use.extra === undefined && ((GONE as readonly string[]).includes(use.name) || use.name.startsWith('bypassDeferral'));
/** A `held:` handle: the prefix alone, as a check for one reads it, or the prefix and an id. Prose with a space after it isn't one. */
const handle = (use: Use): boolean => !!use.string && (use.name === 'held:' || /^held:\S/.test(use.name));
const inImporter = (use: Use): boolean =>
  use.file === IMPORTER.file || use.scope === IMPORTER.scope || use.scope.startsWith(`${IMPORTER.scope}.`);
const where = (use: Use): string => `${use.file}:${use.line} ${use.name}${use.extra ? ` (+${use.extra})` : ''} (in ${use.scope || 'the file'})`;

/** Every source file under `root` whose name ends in one of `endings`, named by its path from there. */
function sourcesUnder(root: string, endings: readonly string[]): Array<{ name: string; text: string }> {
  const sources: Array<{ name: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (endings.some((ending) => name.endsWith(ending))) sources.push({ name: full.slice(root.length), text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return sources;
}

it('src names nothing of the deferral queue, its holds or its flag, outside the one-release importer', () => {
  const sources = sourcesUnder(fileURLToPath(new URL('../../src/', import.meta.url)), ['.ts']);
  assert.ok(sources.some((s) => s.name === 'framework.ts'), 'the walk reaches the framework');
  assert.ok(sources.some((s) => s.name.includes('/')), "the walk reaches src's subdirectories");
  const uses = namesIn(sources);
  assert.ok(uses.some((u) => u.scope === IMPORTER.scope), 'the scan names the importer as the scope of what it holds');
  const found = uses.filter((u) => (gone(u) || u.extra !== undefined) && !inImporter(u)).map(where);
  assert.deepEqual(found, [], `the deferral queue's machinery is back:\n${found.join('\n')}`);
  // The one-release reader of an earlier release's handles is the only src that spells one.
  const handles = uses.filter(handle).map(where);
  assert.deepEqual(handles.map((h) => h.split(':')[0]), ['held-writes.ts'], `a held: handle outside the one-release reader:\n${handles.join('\n')}`);
});

it("test names nothing of the deferral queue, the released window's held part or a held: handle, outside the tests of what is kept one release", () => {
  const sources = sourcesUnder(fileURLToPath(new URL('../../test/', import.meta.url)), ['.ts', '.mjs']);
  assert.ok(sources.some((s) => s.name === 'no-deferral-residue.test.ts'), 'the walk reaches this file');
  assert.ok(sources.some((s) => s.name.startsWith('helpers/')) && sources.some((s) => s.name.startsWith('fixtures/')),
    "the walk reaches test's helpers and fixtures");
  const uses = namesIn(sources);
  const allowed = (use: Use): boolean => {
    const allow = TEST_ALLOWED[use.file];
    if (!allow) return false;
    return handle(use) ? !!allow.handles : !!allow.names?.includes(use.name) || (allow.names === GONE && use.name.startsWith('bypassDeferral'));
  };
  const found = uses.filter((u) => (gone(u) || u.extra !== undefined || handle(u)) && !allowed(u)).map(where);
  assert.deepEqual(found, [], `a test leans on the deferral queue:\n${found.join('\n')}`);
  for (const [file, allow] of Object.entries(TEST_ALLOWED)) {
    assert.ok(sources.some((s) => s.name === file), `${file}, allowed for ${allow.why}, is there`);
  }
});

it('the scan finds a name of the queue as an identifier, a member, a key or a string, and not in a comment, and lets the importer name it', () => {
  const uses = namesIn([{
    name: 'planted.ts',
    text: [
      '// deferredMessages, in a comment, is no use',
      'class AgentFramework {',
      '  private deferredMessages: unknown[] = [];',
      '  write(opts: { bypassDeferralFor?: string }) { return this["flushForStart"] ?? opts.bypassDeferralFor; }',
      '  importPersistedDeferredWrites() { const queuedFor = 1; return queuedFor; }',
      '}',
      'export type T = { presentationIndex?: boolean };',
    ].join('\n'),
  }]);
  const found = uses.filter(gone);
  assert.deepEqual(found.filter((u) => !inImporter(u)).map((u) => `${u.line} ${u.name} ${u.scope}`), [
    '3 deferredMessages AgentFramework',
    '4 bypassDeferralFor AgentFramework.write',
    '4 flushForStart AgentFramework.write',
    '4 bypassDeferralFor AgentFramework.write',
    '7 presentationIndex ',
  ]);
  assert.deepEqual(found.filter(inImporter).map((u) => u.name), ['queuedFor', 'queuedFor'], "the importer's own use is let through");
});

it("the scan finds the released window read, typed or stood in for with the queue's held set, and a held: handle, not prose that starts like one", () => {
  const uses = namesIn([{
    name: 'planted.test.ts',
    text: [
      'type I = { releasedWindow(agent: unknown, held: Set<string>): unknown; releaseWindow: (agent: unknown, held: unknown) => void };',
      'const state = internals as unknown as I;',
      'state.releasedWindow(agent, new Set());',
      'state.releasedWindow(agent);',
      'const usual = (owner.releasedWindow as (agent: unknown, held: Set<string>) => unknown).bind(framework);',
      'owner.releasedWindow = (agent: unknown, held: unknown) => usual(agent, held);',
      'owner.releaseWindow = (agent: unknown) => usual(agent);',
      "assert.ok(id && !id.startsWith('held:'));",
      "ctx.getMessage('held:w1'); ctx.getMessage(`held:${id}`);",
      "assert.equal(x, true, 'held: out of the live turn\\'s window');",
    ].join('\n'),
  }]);
  assert.deepEqual(uses.filter((u) => u.extra !== undefined).map((u) => `${u.line} ${u.name} +${u.extra}`), [
    '1 releasedWindow +1',
    '1 releaseWindow +1',
    '3 releasedWindow +1',
    '5 releasedWindow +1',
    '6 releasedWindow +1',
  ], 'every read, typing and stand-in with more than the agent, and none with the agent alone');
  assert.deepEqual(uses.filter(handle).map((u) => `${u.line} ${u.name}`), ['8 held:', '9 held:w1', '9 held:'],
    "a handle and a check for one; the prose label isn't");
  assert.equal(uses.filter(gone).length, 0, 'the released window itself is kept');
});
