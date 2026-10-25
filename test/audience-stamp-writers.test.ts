/**
 * Every write into an agent's context stamps its row (#291's audience stamp,
 * src/dendrite/audience.ts). A write through the framework's addMessage is
 * stamped there. One that stores into a context manager directly, past it,
 * stamps its own row: through storeOwnRow, or with asOwnRow or withAudience
 * on the metadata it passes, or, for an entry flushed from the deferred
 * queue, with the stamp the entry was queued (or restored) with.
 *
 * The scenario tests in audience-stamp.test.ts check the rows of the paths
 * they drive, not every writer. This scan reads src as a syntax tree and
 * finds every reference to a member named `addMessage`, whatever it is
 * called on (an alias of a context manager, `?.`, `['addMessage']`, a
 * `.bind`). Each must be the framework's own addMessage, by way of one of
 * the hooks that lead to it, or a direct write listed below with how it
 * stamps its row. A writer added past the framework, listed nowhere, fails
 * here before it can store a row with no stamp.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

/** A reference to a member named `addMessage`: the file it is in, its line, what it's on, and the named scopes around it. */
interface Site {
  file: string;
  line: number;
  receiver: string;
  /** The named scopes that enclose it, outermost first: a class, a method or function, a const holding a function or an object, a property holding a function. */
  scope: string[];
  /** The source of the innermost of them, or of the file when there is none. */
  scopeText: string;
}

/**
 * Each reference in `sources` to a member named `addMessage`, read as Babel's
 * TypeScript parser reads the source: `x.addMessage`, `x?.addMessage` and
 * `x['addMessage']`, called or not, and an `addMessage` taken out of an
 * object by destructuring (its receiver is what is destructured, or
 * `(destructured)` where that isn't a declaration's value). Comments aren't
 * read.
 */
function scanAddMessageSites(sources: Array<{ name: string; text: string }>): Site[] {
  type Node = { type: string; start?: number | null; end?: number | null; loc?: { start: { line: number } } | null; [field: string]: unknown };
  const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';
  const child = (n: Node | undefined, field: string): Node | undefined => (n && isNode(n[field]) ? n[field] as Node : undefined);
  const isFunction = (n: Node | undefined) => n?.type === 'ArrowFunctionExpression' || n?.type === 'FunctionExpression';
  // A key's name: an identifier not computed, a string, or a private name.
  const keyName = (key: Node | undefined, computed: unknown): string | undefined => {
    if (!key) return undefined;
    if (!computed && key.type === 'Identifier') return key.name as string;
    if (key.type === 'StringLiteral') return key.value as string;
    if (key.type === 'PrivateName') return `#${(child(key, 'id')?.name as string)}`;
    return undefined;
  };
  const sites: Site[] = [];
  for (const { name, text } of sources) {
    let program: Node;
    try {
      program = parse(text, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node;
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    const slice = (n: Node) => text.slice(n.start!, n.end!);
    const visit = (node: Node, scope: string[], scopeText: string, declared?: Node): void => {
      let named: string | undefined;
      switch (node.type) {
        case 'ClassDeclaration': case 'ClassExpression': case 'FunctionDeclaration': case 'FunctionExpression':
          named = child(node, 'id')?.name as string | undefined; break;
        case 'ClassMethod': case 'ClassPrivateMethod': case 'ObjectMethod': case 'TSDeclareMethod':
          named = keyName(child(node, 'key'), node.computed); break;
        case 'VariableDeclarator':
          if (isFunction(child(node, 'init')) || child(node, 'init')?.type === 'ObjectExpression') {
            named = child(node, 'id')?.name as string | undefined;
          }
          break;
        case 'ClassProperty': case 'ClassPrivateProperty': case 'ObjectProperty':
          if (isFunction(child(node, 'value'))) named = keyName(child(node, 'key'), node.computed); break;
      }
      const innerScope = named ? [...scope, named] : scope;
      const innerText = named ? slice(node) : scopeText;
      const site = (receiver: string) =>
        sites.push({ file: name, line: node.loc!.start.line, receiver, scope: innerScope, scopeText: innerText });
      if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression')
        && keyName(child(node, 'property'), node.computed) === 'addMessage') {
        site(slice(child(node, 'object')!));
      }
      if (node.type === 'ObjectPattern') {
        for (const property of node.properties as Node[]) {
          if (property.type === 'ObjectProperty' && keyName(child(property, 'key'), property.computed) === 'addMessage') {
            site(declared ? slice(declared) : '(destructured)');
          }
        }
      }
      for (const [field, value] of Object.entries(node)) {
        if (field === 'leadingComments' || field === 'trailingComments' || field === 'innerComments') continue;
        // A declaration's pattern is told what it destructures.
        const from = node.type === 'VariableDeclarator' && field === 'id' ? child(node, 'init') : undefined;
        if (Array.isArray(value)) { for (const v of value) if (isNode(v)) visit(v, innerScope, innerText); }
        else if (isNode(value)) visit(value, innerScope, innerText, from);
      }
    };
    visit(program, [], text);
  }
  return sites;
}

/**
 * Receivers whose `addMessage` is the framework's own, which stamps every
 * write (AgentFramework.addMessage), by the file they're in.
 */
const THROUGH_THE_FRAMEWORK: Array<{ file: RegExp; receiver: string; scope?: RegExp; why: string }> = [
  { file: /^framework\.ts$/, receiver: 'this', scope: /^AgentFramework\./, why: "AgentFramework's own" },
  { file: /^framework\.ts$/, receiver: 'framework', scope: /^AgentFramework\./, why: 'the hooks create() hands the gate and the tune-out coordinator' },
  { file: /^tune-out\/coordinator\.ts$/, receiver: 'this.hooks', why: 'the hook create() gives it, framework.addMessage' },
  { file: /^gate\/event-gate\.ts$/, receiver: 'opts', why: 'the hook create() gives it, framework.addMessage' },
  { file: /^module-registry\.ts$/, receiver: 'options', why: "the framework's addModuleMessage" },
  { file: /^modules\//, receiver: 'ctx', why: "a module's context: the framework's addModuleMessage" },
];

/**
 * How a direct write stamps its row, each checked by the helper the scope
 * that holds it calls:
 * - own: asOwnRow, the agent's own row (storeOwnRow is asOwnRow too);
 * - audience: withAudience, a row for the agents it names;
 * - queued: an entry from the deferred queue, stored with the metadata it
 *   was queued with, which addMessage stamped when it queued it, or restore
 *   stamped when an earlier version left it unstamped (withDeferredWriteId
 *   adds its id only).
 */
const STAMPED_BY = { own: 'asOwnRow(', audience: 'withAudience(', queued: 'withDeferredWriteId(' } as const;

/**
 * Every direct write into a context manager in src, by file and named scope:
 * how many there are there, and how each stamps its row. A new one goes
 * through storeOwnRow where it can; one that can't is listed here.
 */
const DIRECT_WRITES: Record<string, { count: number; stamp: keyof typeof STAMPED_BY; what: string }> = {
  'dendrite/audience.ts storeOwnRow': { count: 1, stamp: 'own', what: "the helper for an agent's own rows" },
  'tool-result-guard.ts ToolResultGuard.storeResults': { count: 2, stamp: 'own', what: 'tool results, guarded or not' },
  'framework.ts AgentFramework.addMessage': { count: 1, stamp: 'audience', what: "the framework's addMessage, its own body" },
  'framework.ts AgentFramework.handleProcessEvent': { count: 1, stamp: 'queued', what: "the tool boundary's flush" },
  'framework.ts AgentFramework.flushForStart': { count: 1, stamp: 'queued', what: "a turn start's flush" },
  'framework.ts AgentFramework.releaseWindow': { count: 1, stamp: 'queued', what: "a released window's flush" },
  'framework.ts AgentFramework.handleMcplChannelIncoming': { count: 1, stamp: 'audience', what: 'a channel message delivered to a fork' },
  'framework.ts AgentFramework.routeConversationIncoming': { count: 1, stamp: 'audience', what: "a channel message routed to the channel's fork" },
  'framework.ts AgentFramework.framePendingRound': { count: 2, stamp: 'own', what: "a derived agent's framing of its parent's pending round" },
  'framework.ts AgentFramework.createConversationAgent': { count: 1, stamp: 'own', what: "a conversation fork's seed" },
  'framework.ts AgentFramework.storeDueClock': { count: 1, stamp: 'own', what: 'a clock row' },
  'framework.ts AgentFramework.repinTurnLocus': { count: 1, stamp: 'own', what: 'a routing notice' },
  'framework.ts AgentFramework.addressedElsewhereNotice': { count: 1, stamp: 'own', what: 'a routing notice' },
  'framework.ts AgentFramework.placeWakeLines': { count: 1, stamp: 'own', what: "a batched wake's line" },
  // main's #782: an afterUser context injection stored where compile() placed it, this agent's own context.
  'framework.ts AgentFramework.storeInjections': { count: 1, stamp: 'own', what: "a stored context injection, the agent's own context" },
};

const keyOf = (site: Site) => `${site.file} ${site.scope.join('.')}`;
const where = (site: Site) => `${site.file}:${site.line} ${site.receiver}.addMessage in ${site.scope.join('.') || '(top level)'}`;

/** The sites that go through the framework, the direct writes, and those that are neither. */
function classify(sites: Site[]) {
  const throughTheFramework: Site[] = [];
  const direct: Site[] = [];
  for (const site of sites) {
    const scope = site.scope.join('.');
    const routed = THROUGH_THE_FRAMEWORK.some((r) =>
      r.file.test(site.file) && r.receiver === site.receiver && (!r.scope || r.scope.test(scope)));
    (routed ? throughTheFramework : direct).push(site);
  }
  return { throughTheFramework, direct };
}

it('every write into a context in src goes through the framework\'s addMessage, or is a direct write that stamps its row', () => {
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
  assert.ok(sources.some((s) => s.name.includes('/')), "the walk reaches src's subdirectories");

  const sites = scanAddMessageSites(sources);
  const { throughTheFramework, direct } = classify(sites);
  assert.ok(throughTheFramework.length > 30, `found ${throughTheFramework.length} writes through the framework; the scan has lost them`);

  const unlisted = direct.filter((site) => !(keyOf(site) in DIRECT_WRITES));
  assert.deepEqual(unlisted.map(where), [],
    'a write into a context past the framework\'s addMessage stores a row with no audience stamp unless it stamps it: ' +
    'store an agent\'s own row through storeOwnRow (dendrite/audience.ts), or stamp the row with withAudience and list the write here');

  const found: Record<string, number> = {};
  for (const site of direct) found[keyOf(site)] = (found[keyOf(site)] ?? 0) + 1;
  const listed = Object.fromEntries(Object.entries(DIRECT_WRITES).map(([key, { count }]) => [key, count]));
  assert.deepEqual(found, listed, 'the direct writes in each scope are those listed: one more is a new writer to check, one fewer a list to update');

  for (const site of direct) {
    const { stamp, what } = DIRECT_WRITES[keyOf(site)]!;
    assert.ok(site.scopeText.includes(STAMPED_BY[stamp]),
      `${where(site)} (${what}) is listed as stamped by ${STAMPED_BY[stamp]}), which its scope doesn't call`);
  }
});

it('the scan finds addMessage however it is reached, and names the scope it is in', () => {
  const text = [
    "import { asOwnRow } from './audience.js';",
    'export class Writer {',
    '  private cm!: { addMessage(...args: unknown[]): string };',
    '  store(agent: { getContextManager(): { addMessage(...args: unknown[]): string } }) {',
    '    const m = agent.getContextManager();',
    "    m.addMessage('user', [], asOwnRow(undefined, 'a'));",
    "    agent.getContextManager()?.addMessage('user', []);",
    "    agent.getContextManager()['addMessage']('user', []);",
    '    const add = this.cm.addMessage.bind(this.cm);',
    '    const { addMessage } = agent.getContextManager();',
    '    [1].forEach(() => this.addMessage());',
    '    // cm.addMessage in a comment is not a write',
    '    return { add, addMessage };',
    '  }',
    '  addMessage() { return 0; }',
    '}',
    'export const hooks = { write: (cm: { addMessage(): void }) => cm.addMessage() };',
    'export function free(cm: { addMessage(): void }) { cm?.addMessage(); }',
  ].join('\n');
  const sites = scanAddMessageSites([{ name: 'writer.ts', text }]);
  assert.deepEqual(sites.map((s) => [s.line, s.receiver, s.scope.join('.')]), [
    [6, 'm', 'Writer.store'],
    [7, 'agent.getContextManager()', 'Writer.store'],
    [8, 'agent.getContextManager()', 'Writer.store'],
    [9, 'this.cm', 'Writer.store'],
    [10, 'agent.getContextManager()', 'Writer.store'],
    [11, 'this', 'Writer.store'],
    [17, 'cm', 'hooks.write'],
    [18, 'cm', 'free'],
  ]);
  assert.ok(sites[0]!.scopeText.startsWith('store(') && sites[0]!.scopeText.includes('asOwnRow('), "a site's scope text is its method's");

  // Read with the lists above: none of these is the framework's, and none is listed.
  const { throughTheFramework, direct } = classify(sites);
  assert.deepEqual(throughTheFramework, []);
  assert.equal(direct.filter((site) => keyOf(site) in DIRECT_WRITES).length, 0);
  // A `this.addMessage` is the framework's in framework.ts's AgentFramework only.
  const inFramework = scanAddMessageSites([{ name: 'framework.ts', text: 'export class AgentFramework { a() { this.addMessage(); } }\nclass Other { a() { this.addMessage(); } }' }]);
  assert.deepEqual(classify(inFramework).direct.map((s) => s.scope.join('.')), ['Other.a']);
  assert.throws(() => scanAddMessageSites([{ name: 'broken.ts', text: 'const = ;' }]), /^Error: broken\.ts: /);
});
