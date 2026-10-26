/**
 * The deferral queue is gone (#291, AF-6): a write is stored at once, and
 * enters each agent's window at that agent's presentation points. Only a
 * surgery's hold keeps a write out of the store, in memory, until its
 * release. A release before it left its queue on disk, which the importer
 * reads once at boot (src/deferred-import.ts and the framework's
 * importPersistedDeferredWrites), for one release.
 *
 * This scan reads src as a syntax tree and fails on any name of the queue's
 * machinery (its state, its flushes, its persistence, the tune-out
 * coordinator's queued half, the shared-slot holds, the assembly bypass and
 * the removed flag) outside the importer's file and method, so the queue
 * can't come back in a write path piece by piece. Comments aren't read.
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
  // The module API's handles onto queued writes.
  'heldHandle', 'heldWritesFor', 'heldRows', 'settleUnknownLandings', 'deferredWriteDone', 'readsDeferredWrite',
  // The tune-out coordinator's queued half.
  'getDeferredMessages', 'readerHandedWrites', 'QueuedHeldMessage', 'queuedHeld', 'queuedReaderRows',
  // The holds of the residents' shared slot, and the assembly's bypass.
  'sharedSlotBusy', 'slotHeldFrom', 'noteForOtherResidents', 'bypassDeferral',
  // The flag that kept the queue: presentation is mandatory.
  'presentationIndex',
] as const;

/** Where the one-release importer may name what it reads: the reader's file, and the framework's method. */
const IMPORTER = { file: 'deferred-import.ts', scope: 'AgentFramework.importPersistedDeferredWrites' } as const;

type Node = { type: string; loc?: { start: { line: number } } | null; [field: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

/** A name the source uses, with where: its file, line and the named scopes around it (a class, then a method or function). */
interface Use { file: string; line: number; name: string; scope: string }

/**
 * Every identifier, private name, and string key or member in `sources`,
 * as Babel's TypeScript parser reads them, with the class and method or
 * function around each. Comments aren't read.
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
      const use = (name: string) => uses.push({ file, line: node.loc?.start.line ?? 0, name, scope: inner.join('.') });
      if (node.type === 'Identifier') use(node.name as string);
      if (node.type === 'PrivateName' && isNode(node.id)) use(node.id.name as string);
      if (node.type === 'StringLiteral') use(node.value as string);
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

const gone = (name: string): boolean =>
  (GONE as readonly string[]).includes(name) || name.startsWith('bypassDeferral');
const inImporter = (use: Use): boolean =>
  use.file === IMPORTER.file || use.scope === IMPORTER.scope || use.scope.startsWith(`${IMPORTER.scope}.`);

it('src names nothing of the deferral queue, its holds or its flag, outside the one-release importer', () => {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const sources: Array<{ name: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) sources.push({ name: full.slice(src.length), text: readFileSync(full, 'utf8') });
    }
  };
  walk(src);
  assert.ok(sources.some((s) => s.name === 'framework.ts'), 'the walk reaches the framework');
  assert.ok(sources.some((s) => s.name.includes('/')), "the walk reaches src's subdirectories");
  const uses = namesIn(sources);
  assert.ok(uses.some((u) => u.scope === IMPORTER.scope), 'the scan names the importer as the scope of what it holds');
  const found = uses.filter((u) => gone(u.name) && !inImporter(u)).map((u) => `${u.file}:${u.line} ${u.name} (in ${u.scope || 'the file'})`);
  assert.deepEqual(found, [], `the deferral queue's machinery is back:\n${found.join('\n')}`);
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
  const found = uses.filter((u) => gone(u.name));
  assert.deepEqual(found.filter((u) => !inImporter(u)).map((u) => `${u.line} ${u.name} ${u.scope}`), [
    '3 deferredMessages AgentFramework',
    '4 bypassDeferralFor AgentFramework.write',
    '4 flushForStart AgentFramework.write',
    '4 bypassDeferralFor AgentFramework.write',
    '7 presentationIndex ',
  ]);
  assert.deepEqual(found.filter(inImporter).map((u) => u.name), ['queuedFor', 'queuedFor'], "the importer's own use is let through");
});
