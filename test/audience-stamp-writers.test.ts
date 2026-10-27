/**
 * Every write into an agent's context stamps its row (#291's audience stamp,
 * src/dendrite/audience.ts). A write through the framework's addMessage is
 * stamped there. One that stores into a context manager directly, past it,
 * stamps its own row: through storeOwnRow, or with asOwnRow or withAudience
 * on the metadata it passes. (Since #291 there is no deferral queue, whose
 * three flushes were direct writes listed here; the importer that stores an
 * earlier release's queue at boot goes through addMessage.)
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

/**
 * Walk each source as Babel's TypeScript parser reads it, telling `visit`
 * of every node with the named scopes that enclose it (outermost first: a
 * class, a method or function, a const holding a function or an object, a
 * property holding a function), the source of the innermost of them (or of
 * the file), the source of a node, and, for a destructuring pattern, what it
 * destructures. Comments aren't read.
 */
function walkSources(
  sources: Array<{ name: string; text: string }>,
  visit: (file: string, node: Node, scope: string[], scopeText: string, slice: (n: Node) => string, declared?: Node) => void,
): void {
  for (const { name, text } of sources) {
    let program: Node;
    try {
      program = parse(text, { sourceType: 'module', plugins: ['typescript'] }).program as unknown as Node;
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    const slice = (n: Node) => text.slice(n.start!, n.end!);
    const walk = (node: Node, scope: string[], scopeText: string, declared?: Node): void => {
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
      visit(name, node, innerScope, innerText, slice, declared);
      for (const [field, value] of Object.entries(node)) {
        if (field === 'leadingComments' || field === 'trailingComments' || field === 'innerComments') continue;
        // A declaration's pattern is told what it destructures.
        const from = node.type === 'VariableDeclarator' && field === 'id' ? child(node, 'init') : undefined;
        if (Array.isArray(value)) { for (const v of value) if (isNode(v)) walk(v, innerScope, innerText); }
        else if (isNode(value)) walk(value, innerScope, innerText, from);
      }
    };
    walk(program, [], text);
  }
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
  const sites: Site[] = [];
  walkSources(sources, (file, node, scope, scopeText, slice, declared) => {
    const site = (receiver: string) => sites.push({ file, line: node.loc!.start.line, receiver, scope, scopeText });
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
  });
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
 * - audience: withAudience, a row for the agents it names.
 */
const STAMPED_BY = { own: 'asOwnRow(', audience: 'withAudience(' } as const;

/**
 * Every direct write into a context manager in src, by file and named scope:
 * how many there are there, and how each stamps its row. A new one goes
 * through storeOwnRow where it can; one that can't is listed here.
 */
const DIRECT_WRITES: Record<string, { count: number; stamp: keyof typeof STAMPED_BY; what: string }> = {
  'dendrite/audience.ts storeOwnRow': { count: 1, stamp: 'own', what: "the helper for an agent's own rows" },
  'tool-result-guard.ts ToolResultGuard.storeResults': { count: 2, stamp: 'own', what: 'tool results, guarded or not' },
  'framework.ts AgentFramework.addMessage': { count: 1, stamp: 'audience', what: "the framework's addMessage, its own body" },
  // The two channel writes into a fork's store (a correction delivered to
  // it, a message routed to the channel's fork) go through one helper.
  'framework.ts AgentFramework.storeInFork': { count: 1, stamp: 'audience', what: "a channel message stored in a fork's store" },
  // A derived agent's pending-round framing, a conversation fork's seed, the
  // clock row, the routing notices, a batched wake's line and #782's stored
  // injections were direct writes here, stamped with asOwnRow; since AF-4
  // they go through storeOwnRow, which presents each as it is written
  // (#291), so they are no longer listed.
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

/**
 * Each call in `sources` of a function or method named `name`: where, in
 * which scope, and how many arguments it is given.
 */
function scanCalls(sources: Array<{ name: string; text: string }>, name: string): Array<Site & { args: number }> {
  const sites: Array<Site & { args: number }> = [];
  walkSources(sources, (file, node, scope, scopeText) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const callee = child(node, 'callee');
    const called = callee?.type === 'Identifier'
      ? callee.name as string
      : callee && (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
        ? keyName(child(callee, 'property'), callee.computed)
        : undefined;
    if (called !== name) return;
    sites.push({ file, line: node.loc!.start.line, receiver: name, scope, scopeText, args: (node.arguments as unknown[]).length });
  });
  return sites;
}

/**
 * When each writer of an agent's own rows writes them, and so whether
 * storeOwnRow may present the row in the agent's window as it is written
 * (#291): an own row presented while a turn of the agent's is alive that
 * the row isn't part of enters a window its requests don't carry.
 * - turn: by the agent's live turn or act, for what its requests carry:
 *   a stream's rounds, results and the notices its tool boundary injects,
 *   a start's inputs before its compile, a puppet's pair under its own
 *   reservation;
 * - end: after its stream's last request, as the turn ends (its markers
 *   and receipts);
 * - unregistered: before the agent is registered, which presents its own
 *   rows when it takes the agent on (a derived agent's inheritance and
 *   framing, a conversation fork's seed);
 * - held-back: where a turn the row isn't part of may hold the agent, so
 *   the call passes `present` (its sixth argument), false then, and the
 *   agent's next presentation point presents it.
 */
const OWN_ROW_WRITERS: Record<string, { count: number; when: 'turn' | 'end' | 'unregistered' | 'held-back'; what: string }> = {
  'agent.ts Agent.addAssistantResponse': { count: 1, when: 'turn', what: "a stream's round or final reply" },
  'agent.ts Agent.doInference': { count: 1, when: 'turn', what: "the direct API path's reply" },
  'framework.ts AgentFramework.storeDueClock': { count: 1, when: 'turn', what: 'a clock row: an event with no turn alive, a start, a tool boundary' },
  'framework.ts AgentFramework.storeInjections': { count: 1, when: 'turn', what: "a start's stored injection, before its compile" },
  'framework.ts AgentFramework.repinTurnLocus': { count: 1, when: 'turn', what: 'a routing notice, at a start or injected at a boundary' },
  'framework.ts AgentFramework.addressedElsewhereNotice': { count: 1, when: 'turn', what: 'a routing notice injected at a boundary' },
  'framework.ts AgentFramework.announceLocusIfChanged': { count: 1, when: 'turn', what: "a start's routing notice" },
  'framework.ts AgentFramework.maybePrimeProseMode': { count: 1, when: 'turn', what: "a start's prose-mode primer" },
  'framework.ts AgentFramework.noticeUnnoticedDrafts': { count: 1, when: 'turn', what: "a start's drafts notice" },
  'framework.ts AgentFramework.noticeHeadMoves': { count: 1, when: 'turn', what: "a start's workspace head-move notice" },
  'framework.ts AgentFramework.writeAutoContinueNotice': { count: 1, when: 'turn', what: "a continuation's [continue] row, at its start" },
  'framework.ts AgentFramework.placeWakeLines': { count: 1, when: 'turn', what: "a batched wake's line, at its start" },
  'framework.ts AgentFramework.runPuppetToolCall': { count: 2, when: 'held-back', what: "the puppet's pair: under its own reservation, or held back once a turn replaced it" },
  'framework.ts AgentFramework.appendProseDeliveryReceipt': { count: 1, when: 'end', what: "a stream's delivery receipt, after its last request" },
  'framework.ts AgentFramework.driveStream': { count: 2, when: 'end', what: "the contained tool-wrapper prose marker, and main's cut-off tool-block notice" },
  'framework.ts AgentFramework.updateRewindMarker': { count: 1, when: 'end', what: "a refusal rewind's marker" },
  'framework.ts AgentFramework.noteInferenceExhausted': { count: 1, when: 'end', what: "an exhausted turn's [inference-failed] marker" },
  'framework.ts AgentFramework.settleDeliberateCancel': { count: 1, when: 'held-back', what: "a stop's [turn-interrupted] marker, held back once the stream no longer owns the agent" },
  'framework.ts AgentFramework.sweepExpiredConversations': { count: 1, when: 'held-back', what: "a fork's closure prompt, held back while a turn of the fork's is alive" },
  'framework.ts AgentFramework.deriveAgent': { count: 2, when: 'unregistered', what: "a derived agent's inheritance and framing" },
  'framework.ts AgentFramework.framePendingRound': { count: 2, when: 'unregistered', what: "a derived agent's framing of its parent's pending round" },
  'framework.ts AgentFramework.createConversationAgent': { count: 1, when: 'unregistered', what: "a conversation fork's seed" },
};

it("every writer of an agent's own rows is classified by when it writes, and one that may write into another turn holds its row back", () => {
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
  // storeOwnRow's own definition is in dendrite/audience.ts and calls nothing named so.
  const calls = scanCalls(sources, 'storeOwnRow');
  assert.ok(calls.length > 20, `found ${calls.length} own-row writes; the scan has lost them`);
  const found: Record<string, number> = {};
  for (const call of calls) found[keyOf(call)] = (found[keyOf(call)] ?? 0) + 1;
  const listed = Object.fromEntries(Object.entries(OWN_ROW_WRITERS).map(([key, { count }]) => [key, count]));
  assert.deepEqual(found, listed,
    "each scope that stores an agent's own row is listed with when it writes: a new one is a writer to classify, one fewer a list to update");
  for (const call of calls) {
    const { when, what } = OWN_ROW_WRITERS[keyOf(call)]!;
    if (when === 'held-back') continue;
    assert.ok(call.args <= 5, `${where(call)} (${what}) is listed as presenting at its write, and passes \`present\``);
  }
  const heldBack = calls.filter((call) => OWN_ROW_WRITERS[keyOf(call)]!.when === 'held-back');
  for (const key of Object.keys(OWN_ROW_WRITERS).filter((key) => OWN_ROW_WRITERS[key]!.when === 'held-back')) {
    assert.ok(heldBack.some((call) => keyOf(call) === key && call.args === 6), `${key} holds a row back with storeOwnRow's \`present\``);
  }
  // A row whose write threw after it landed is told to the own-row sink by
  // hand (ownRowsStored), only by a writer that presents at its write.
  for (const call of scanCalls(sources, 'ownRowsStored')) {
    if (call.file === 'dendrite/audience.ts' && call.scope.join('.') === 'storeOwnRow') continue;
    const listing = OWN_ROW_WRITERS[keyOf(call)];
    assert.ok(listing && listing.when !== 'held-back', `${where(call)} tells the sink of a row: its scope presents at its write`);
  }
});
