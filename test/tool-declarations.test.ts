import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WriteLandedError, type ContextManager } from '@animalabs/context-manager';
import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, Membrane, ModelPricing, NormalizedMessage, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { Agent } from '../src/agent.js';
import { memoryHeadDeclarations, pricedCharacters, requestCharacters, type HeadDeclaration, type HeadDeclarationStore, type HeadEvent } from '../src/system-changes.js';
import type { AgentConfig } from '../src/types/index.js';
import { foldOf, now } from './helpers/declared.js';

interface Row { id: string; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; bodyGroupId?: string; shardIndex?: number }

function fakeContext(rows: Row[] = [], opts: { kvUnified?: boolean; firstChanged?: (() => number | null) | 'compare'; overBudget?: (rows: Row[]) => boolean; fail?: () => Error | undefined; readOnly?: ReadonlySet<string> } = {}) {
  let next = rows.length;
  const compiles: Array<{ kvUnifiedImmutablePrefixHash?: string; dryRun?: boolean } | undefined> = [];
  const reads = { firstChanged: 0 };
  let lastCommitted: string[] | null = null;
  const branch = { id: 'main' };
  const cm = {
    currentBranch: () => ({ id: branch.id, name: branch.id, head: rows.length }),
    compile: async (_budget: unknown, injections: Array<{ position: string; content: ContentBlock[] }> | undefined, o?: { kvUnifiedImmutablePrefixHash?: string; dryRun?: boolean }) => {
      compiles.push(o);
      if (opts.overBudget?.(rows)) throw Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      const failure = opts.fail?.();
      if (failure) throw failure;
      const result = {
        messages: rows.map((r) => ({ participant: r.participant, content: r.content })),
        systemInjections: (injections ?? []).filter((i) => i.position === 'system').flatMap((i) => i.content),
        provenance: { messages: rows.map((r, sequence) => ({ kind: 'raw', bodies: [{ messageId: r.id, sequence, complete: true }] })), branch: { id: 'main', created: 0 } },
        rawBodies: new Map(rows.map((r) => [r.id, [{ ...r }]])),
      };
      if (!opts.firstChanged || o?.dryRun) return result;
      const keys = result.messages.map((m) => JSON.stringify(m));
      const before = lastCommitted;
      lastCommitted = keys;
      const firstChanged = opts.firstChanged;
      const value = firstChanged === 'compare'
        ? () => {
          if (!before) return null;
          const at = keys.findIndex((key, i) => key !== before[i]);
          return at < 0 ? keys.length : at;
        }
        : firstChanged;
      return Object.defineProperty(result, 'firstChanged', { enumerable: true, get: () => { reads.firstChanged++; return value(); } });
    },
    addMessage: (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) => {
      const id = `m${++next}`;
      rows.push({ id, participant, content, ...(metadata ? { metadata } : {}) });
      return id;
    },
    queryMessages: (filter: { metadata?: Record<string, unknown> }) => ({
      messages: rows.filter((r) => Object.entries(filter.metadata ?? {}).every(([k, v]) => r.metadata?.[k] === v)),
      totalCount: 0,
    }),
    getMessage: (id: string) => (opts.readOnly?.has(id) ? null : rows.find((r) => r.id === id) ?? null),
    removeMessage: (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
    getStrategy: () => ({ isKvUnifiedEnabled: () => opts.kvUnified === true }),
    getPresentedMessages: () => rows.map((r) => ({ id: r.id, participant: r.participant, content: r.content, metadata: r.metadata ?? {} })),
    getAllMessages: () => rows.map((r) => ({ id: r.id, participant: r.participant, content: r.content, metadata: r.metadata ?? {} })),
    getMessageCount: () => rows.length,
    getMessageWindow: (offset: number, limit: number) => ({ messages: rows.slice(offset, offset + limit), startIndex: offset }),
  };
  return { cm: cm as unknown as ContextManager, rows, compiles, reads, branch, committed: () => lastCommitted };
}

const tool = (name: string, description = `${name} does a thing`): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

const onMain = () => 'main';
const said = (participant: string, text: string): Row => ({ id: `${participant}:${text}`, participant, content: [{ type: 'text', text }] });
const SHORT = 'You are an agent.';
const SYSTEM = `${SHORT}\n${'Follow the task, and say what you did. '.repeat(2000)}`;

const systemInjection = (text: string) => ({ namespace: 'module', position: 'system' as const, content: [{ type: 'text' as const, text }] });

/** A membrane whose answer to whether a model takes a change in its context is `takes`. */
const taking = (takes: boolean): Membrane => ({ takesToolOrSystemChanges: () => takes }) as unknown as Membrane;

/** membrane's prices for a model, a 1-hour write rate among them from 0.10.4 on. */
type Prices = ModelPricing & { cacheWrite1hPerMillion?: number };

/** An agent on the fake context; `takes` is the membrane's answer for its
 *  model, no when left out. `pricing` is membrane's `pricingFor`, which a
 *  membrane before 0.10.4 lacks, and `counted` the agent's count of finished
 *  inferences, which an ephemeral run lacks. */
function agentOn(
  context: ReturnType<typeof fakeContext>,
  config: Partial<AgentConfig> & { takes?: boolean; pricing?: () => Prices | undefined; counted?: () => number | undefined } = {},
  heads: HeadDeclarationStore = memoryHeadDeclarations(onMain),
  events: HeadEvent[] = [],
): Agent {
  const { takes = false, pricing, counted, ...settings } = config;
  const model = settings.model ?? 'test-model';
  // membrane prices the model it's asked for: here the agent's own alone.
  const pricingFor = pricing && ((asked: string) => (asked === model ? pricing() : undefined));
  const membrane = { takesToolOrSystemChanges: () => takes, ...(pricingFor ? { pricingFor } : {}) } as unknown as Membrane;
  const agent = new Agent({ name: 'agent', model, systemPrompt: SYSTEM, ...settings }, context.cm, membrane);
  agent.attachHeadDeclarations(heads, (event) => events.push(event), undefined, counted);
  return agent;
}

const changeRows = (rows: Row[]) => rows.filter((r) => r.content.some((b) => (b as { type: string }).type === 'system_change'));
const changeRow = (tools: ToolDefinition[]): Row => ({
  id: `c-${tools.map((t) => t.name).join('-')}`,
  participant: 'system',
  content: [{ type: 'system_change', defineTools: tools } as never],
  metadata: { system: true, kind: 'system-change', agent: 'agent' },
});
const lastMessage = (messages: NormalizedMessage[]) => messages.at(-1)!;
function digest(wire: unknown): string {
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(item) ?? 'null';
  };
  return createHash('sha256').update(encode(JSON.parse(JSON.stringify(wire) ?? 'null'))).digest('hex');
}
const changesIn = (messages: readonly NormalizedMessage[]) =>
  messages.filter((m) => m.content.some((b) => (b as { type: string }).type === 'system_change')).map((m) => m.content);

describe('a change of tools or system text, declared in the context', () => {
  it("sends no change row on a model that takes none, on the current tools and system text, and a record left from before goes with its rows", async () => {
    const context = fakeContext([
      said('user', 'hello'),
      { id: 'c1', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('old')] } as never], metadata: { system: true, kind: 'system-change', agent: 'agent' } },
    ]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('old')], system: [SYSTEM] });
    const events: HeadEvent[] = [];
    const request = await agentOn(context, {}, heads, events).buildActivationRequest([tool('a')], [systemInjection('injected')]);
    assert.deepEqual(request.tools, [tool('a')]);
    assert.equal(request.system, `${SYSTEM}\ninjected`);
    assert.equal(request.messages.length, 1);
    assert.equal(heads.read('agent'), null, "a record left from an earlier 'entries' period goes");
    assert.deepEqual(changeRows(context.rows), [], 'and so do its change rows');
    assert.deepEqual(events, [{ type: 'head:moved', why: 'on-head', changesRemoved: 1 }]);
  });

  it("adopts the current head at its first request on a model that takes a change, appending nothing", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    const events: HeadEvent[] = [];
    const request = await agentOn(context, { takes: true }, heads, events).buildActivationRequest([tool('a')], [systemInjection('injected')]);
    assert.deepEqual(request.tools, [tool('a')]);
    assert.equal(request.system, `${SYSTEM}\ninjected`);
    assert.deepEqual(heads.read('agent'), { tools: [tool('a')], system: [SYSTEM, 'injected'] });
    assert.deepEqual(changeRows(context.rows), []);
    assert.deepEqual(events, [{ type: 'head:moved', why: 'adopted', changesRemoved: 0 }]);
  });

  it('declares a later tool change at the end, keeping the recorded head, and a restart sends the same', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { takes: true }, heads, events);
    await agent.buildActivationRequest([tool('a')]);
    context.rows.push(said('agent', 'hi'), said('user', 'go on'));

    const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(request.tools, [tool('a')], 'the head stays as recorded');
    assert.deepEqual(lastMessage(request.messages), {
      participant: 'system',
      content: [{ type: 'system_change', defineTools: [tool('b')] }],
    });
    assert.equal(changeRows(context.rows).length, 1, 'stored where it took effect');
    assert.deepEqual(changeRows(context.rows)[0]!.metadata, { system: true, kind: 'system-change', agent: 'agent', audience: ['agent'], ownRowOf: 'agent' });
    assert.deepEqual(events.at(-1), { type: 'head:declared', removed: [], defined: ['b'], addedSystem: 0 });

    const restarted = await agentOn(context, { takes: true }, heads).buildActivationRequest([tool('b'), tool('a')]);
    assert.deepEqual(restarted.tools, [tool('a')]);
    assert.deepEqual(restarted.messages, request.messages);
    assert.equal(changeRows(context.rows).length, 1);
  });

  it('declares added system text as an addition, and moves the head for a replacement', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { takes: true }, heads, events);
    await agent.buildActivationRequest([tool('a')], [systemInjection('instructions v1')]);

    const added = await agent.buildActivationRequest([tool('a')], [systemInjection('instructions v1'), systemInjection('a server joined')]);
    assert.equal(added.system, `${SYSTEM}\ninstructions v1`);
    assert.deepEqual(lastMessage(added.messages).content, [{ type: 'system_change', addSystem: ['a server joined'] }]);

    const compilesBefore = context.compiles.length;
    const replaced = await agent.buildActivationRequest([tool('a')], [systemInjection('instructions v2'), systemInjection('a server joined')]);
    assert.equal(replaced.system, `${SYSTEM}\ninstructions v2\na server joined`, 'the head is what\'s current');
    assert.deepEqual(changeRows(context.rows), [], 'the change it now holds is removed');
    assert.equal(context.compiles.length - compilesBefore, 2, 'and the compile runs again without it');
    assert.equal(replaced.messages.some((m) => m.participant === 'system'), false);
    assert.deepEqual(heads.read('agent')!.system, [SYSTEM, 'instructions v2', 'a server joined']);
    assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'replaced', changesRemoved: 1 });
  });

  it('declares nothing for the same tools in another order', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { takes: true });
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    const request = await agent.buildActivationRequest([tool('b'), tool('a')]);
    assert.deepEqual(request.tools, [tool('a'), tool('b')]);
    assert.deepEqual(changeRows(context.rows), []);
  });

  it('shows a dry run the change the next request would declare, storing nothing', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { takes: true }, heads, events);
    await agent.buildActivationRequest([tool('a')]);
    const preview = await agent.buildActivationRequest([tool('a'), tool('b')], undefined, undefined, undefined, { dryRun: true });
    assert.deepEqual(lastMessage(preview.messages).content, [{ type: 'system_change', defineTools: [tool('b')] }]);
    assert.deepEqual(changeRows(context.rows), []);
    assert.equal(events.length, 1, 'only the adoption');
  });

  it("keeps a request ending on the agent's own turn ending there, with its [Continue], past a change", async () => {
    const context = fakeContext([said('user', 'hello'), said('agent', 'thinking aloud')]);
    const agent = agentOn(context, { takes: true });
    await agent.buildActivationRequest([tool('a')]);
    const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
    const roles = request.messages.map((m) => (m.content.some((b) => (b as { type: string }).type === 'system_change') ? 'change' : m.participant));
    assert.deepEqual(roles.slice(-3), ['agent', 'change', 'user'], 'the change, then the [Continue] the agent\'s turn needs');
  });

  it("goes out as membrane renders it: a system message after the user turn, the [Continue] one included", async () => {
    const wire = (request: NormalizedRequest) => new NativeFormatter().buildMessages(request.messages, {
      participantMode: 'simple', assistantParticipant: 'agent', humanParticipant: 'user', tools: request.tools,
    }).messages.map((m) => `${m.role}:${(m.content as Array<{ type: string }>).map((b) => b.type).join('+')}`);
    const asked = fakeContext([said('user', 'hello')]);
    const agent = agentOn(asked, { takes: true });
    await agent.buildActivationRequest([tool('a')]);
    assert.deepEqual(wire(await agent.buildActivationRequest([tool('a'), tool('b')])), ['user:text', 'system:tool_addition']);

    const answered = fakeContext([said('user', 'hello'), said('agent', 'thinking aloud')]);
    const own = agentOn(answered, { takes: true });
    await own.buildActivationRequest([tool('a')]);
    assert.deepEqual(wire(await own.buildActivationRequest([tool('a'), tool('b')])),
      ['user:text', 'assistant:text', 'user:text', 'system:tool_addition'], "after the [Continue] the agent's own turn needs");
  });

  it("keeps its recorded head as recorded when what a request carries is changed in place", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { takes: true });
    await agent.buildActivationRequest([tool('a')]);
    const first = await agent.buildActivationRequest([tool('a'), tool('b')]);
    first.tools![0]!.description = 'changed in place, as a hook might';
    (first.tools![0]!.inputSchema as { properties: Record<string, unknown> }).properties.added = { type: 'string' };
    const next = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(next.tools, [tool('a')], 'the head as recorded');
    assert.equal(changeRows(context.rows).length, 1, 'with nothing declared back');
  });

  it('declares a second copy of a system block its head already holds', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { takes: true });
    await agent.buildActivationRequest([tool('a')], [systemInjection('x')]);
    const request = await agent.buildActivationRequest([tool('a')], [systemInjection('x'), systemInjection('x')]);
    const added = request.messages.flatMap((m) => m.content).filter((b) => (b as { type: string }).type === 'system_change').map((b) => (b as { addSystem?: string[] }).addSystem);
    assert.deepEqual(added, [['x']]);
  });

  it('hashes the head that goes out for kv-unified: the recorded one, and the new one after a move', async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const agent = agentOn(context, { takes: true });
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    const [adopted] = context.compiles.map((o) => o?.kvUnifiedImmutablePrefixHash);
    assert.ok(adopted);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
    assert.equal(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, adopted, 'a declared change leaves the head, and its hash, as they were');
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.equal(context.compiles.at(-2)?.kvUnifiedImmutablePrefixHash, adopted, 'the replacement is found by a compile at the recorded head');
    assert.notEqual(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, adopted, 'and the compile after the move hashes the new head');
  });

  it('deletes a record whenever one is there on a model that takes no change, as after a branch switch brings it back', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('old')], system: [SYSTEM] });
    const agent = agentOn(context, {}, heads);
    await agent.buildActivationRequest([tool('a')]);
    assert.equal(heads.read('agent'), null, 'deleted');
    heads.write('agent', { tools: [tool('old')], system: [SYSTEM] });
    await agent.buildActivationRequest([tool('a')]);
    assert.equal(heads.read('agent'), null, 'and again');
  });

  it('records a copy of the head, so a tool changed in place is declared rather than changing the head', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { takes: true });
    const tools = [tool('a')];
    await agent.buildActivationRequest(tools);
    (tools[0]!.inputSchema as { properties: Record<string, unknown> }).properties.city = { type: 'string' };
    const request = await agent.buildActivationRequest(tools);
    assert.deepEqual(request.tools, [tool('a')], 'the head as recorded, nested schema included');
    const changed = { ...tool('a'), inputSchema: { type: 'object', properties: { city: { type: 'string' } } } };
    assert.deepEqual(lastMessage(request.messages).content, [{ type: 'system_change', defineTools: [changed] }]);
  });

  it("says in head:declared what a change removed and how many blocks of system text it added", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { takes: true }, memoryHeadDeclarations(onMain), events);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('one')]);
    await agent.buildActivationRequest([tool('a')], [systemInjection('one'), systemInjection('two'), systemInjection('three')]);
    assert.deepEqual(events.at(-1), { type: 'head:declared', removed: ['b'], defined: [], addedSystem: 2 });
  });

  it('sends a change an assembly stored once with the next request, when its own request never went out, and declares nothing new', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { takes: true });
    await agent.buildActivationRequest([tool('a')]);
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    const next = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.equal(changeRows(context.rows).length, 1, 'nothing new stored');
    assert.deepEqual(next.messages.filter((m) => m.participant === 'system').map((m) => m.content), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'sent once');
  });

  it("keeps a reply's tool-loop prompt when a change follows the tool results", async () => {
    const call = { type: 'tool_use', id: 't1', name: 'a', input: {} } as ContentBlock;
    const prompt = { turn: 'p-1', text: 'the prompt the loop began with' };
    const context = fakeContext([
      said('user', 'hello'),
      { id: 'call', participant: 'agent', content: [call], metadata: { promptedBy: prompt } },
      { id: 'result', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock] },
    ]);
    const agent = agentOn(context, { takes: true });
    const assemble = (tools: ToolDefinition[]) => (agent as unknown as { assembleActivationRequest(t: ToolDefinition[]): Promise<{ request: NormalizedRequest; continuePrompt?: unknown }> }).assembleActivationRequest(tools);
    await assemble([tool('a')]);
    const { request, continuePrompt } = await assemble([tool('a'), tool('b')]);
    assert.equal(lastMessage(request.messages).participant, 'system', 'the change is last');
    assert.deepEqual(continuePrompt, prompt, 'and the reply still continues the loop the results answer');
  });

  it("goes in the fallback form while its head isn't stored, its record and its change kept, and moves once it stores", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const real = memoryHeadDeclarations(onMain);
    let failWrites = false;
    const heads: HeadDeclarationStore = {
      read: (name) => real.read(name),
      write: (name, head) => !failWrites && real.write(name, head),
      delete: (name) => real.delete(name),
    };
    const agent = agentOn(context, { takes: true }, heads);
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
    failWrites = true;
    const held = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.deepEqual(foldOf(held), now([tool('a'), tool('b')], `${SYSTEM}\nv2`), 'what goes out is what the agent has now');
    assert.deepEqual(changesIn(held.messages), [], 'on its current tools and system text, with no change row');
    assert.deepEqual(real.read('agent'), { tools: [tool('a')], system: [SYSTEM, 'v1'] }, 'the record is as it was');
    assert.equal(changeRows(context.rows).length, 1, 'and so is its change');
    failWrites = false;
    const next = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.deepEqual(next.tools, [tool('a'), tool('b')], 'once it stores, the replacement moves the head');
    assert.deepEqual(changeRows(context.rows), [], 'and takes the change it now holds');
    assert.deepEqual(real.read('agent'), { tools: [tool('a'), tool('b')], system: [SYSTEM, 'v2'] });
  });

  it("takes no change row out while it can't store a head with none recorded, or none that it can read: it goes in the fallback form", async () => {
    const context = fakeContext([said('user', 'hello'), changeRow([tool('b', 'b as it was')])]);
    const real = memoryHeadDeclarations(onMain);
    let tried = 0;
    const heads: HeadDeclarationStore = { read: (name) => real.read(name), write: () => { tried++; return false; }, delete: (name) => real.delete(name) };
    const agent = agentOn(context, { takes: true }, heads);
    const request = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('a server joined')]);
    assert.equal(tried, 1, 'the premise: it tried to record its head');
    assert.deepEqual(foldOf(request), now([tool('a'), tool('b')], `${SYSTEM}\na server joined`), 'what goes out is what the agent has now');
    assert.deepEqual(changesIn(request.messages), [], 'with its change rows left out');
    assert.equal(changeRows(context.rows).length, 1, 'and kept in the store');
  });

  it("compiles the fallback form for the head it carries, though the compile holds no change row, as when a replacement can't be stored", async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const real = memoryHeadDeclarations(onMain);
    let failWrites = false;
    const heads: HeadDeclarationStore = { read: (name) => real.read(name), write: (name, head) => !failWrites && real.write(name, head), delete: (name) => real.delete(name) };
    const agent = agentOn(context, { takes: true }, heads);
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    failWrites = true;
    const request = await agent.buildActivationRequest([tool('a')], [systemInjection('v2')]);
    assert.equal(request.system, `${SYSTEM}\nv2`, 'the fallback form: what is current');
    const fresh = fakeContext([said('user', 'hello')], { kvUnified: true });
    await agentOn(fresh, { takes: true }).buildActivationRequest([tool('a')], [systemInjection('v2')]);
    assert.equal(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, fresh.compiles.at(-1)?.kvUnifiedImmutablePrefixHash,
      'and the compile that it commits hashes that head, not the recorded one');
  });

  it("keeps a head on the branch it was recorded on, so a branch without one adopts and a switch back reads that branch's head", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = new Agent({ name: 'agent', model: 'test-model', systemPrompt: SYSTEM }, context.cm, taking(true));
    assert.deepEqual((await agent.buildActivationRequest([tool('a')])).tools, [tool('a')], 'the premise: it adopts on main');
    context.branch.id = 'elsewhere';
    const there = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(there.tools, [tool('a'), tool('b')], 'a branch it has no head for adopts what is current');
    assert.deepEqual(changeRows(context.rows), [], 'declaring nothing');
    context.branch.id = 'main';
    const back = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(back.tools, [tool('a')], "back on main it reads main's head");
    assert.deepEqual(changeRows(back.messages as unknown as Row[]).map((r) => r.content), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'and declares b against it');
  });

  it("previews a host's appended change as carried, so a dry run declares no tool that change already defines", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    const agent = agentOn(context, { takes: true }, heads);
    const hostChange: NormalizedMessage = { participant: 'system', content: [{ type: 'system_change', defineTools: [tool('b')] } as never] };
    const preview = await agent.buildActivationRequest([tool('a'), tool('b')], undefined, undefined, undefined, { dryRun: true, appendedMessages: [hostChange] });
    assert.deepEqual(changeRows(preview.messages as unknown as Row[]).map((r) => r.content), [hostChange.content], "the host's change, and no declaration of the same tool");
  });

  it("leaves a preview's appended change row out where the preview goes in the fallback form, though its compile holds none", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    const appended: NormalizedMessage = { participant: 'system', content: [{ type: 'system_change', addSystem: ["no text of the agent's"] } as never] };
    const preview = await agentOn(context, { takes: true }, heads).buildActivationRequest([tool('a')], undefined, undefined, undefined, { dryRun: true, appendedMessages: [appended] });
    assert.deepEqual(changesIn(preview.messages), [], 'the appended row left out');
    assert.deepEqual(foldOf(preview), now([tool('a')], SYSTEM), 'so the preview folds to what the agent has now');
  });

  it("declares its change row when the store holds it though the write threw, compiling again with it", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const landing = context.cm as unknown as { addMessage: (...args: unknown[]) => string };
    const write = landing.addMessage;
    landing.addMessage = (...args: unknown[]) => {
      const id = write(...args);
      if ((args[1] as Array<{ type: string }>).some((block) => block.type === 'system_change')) throw new WriteLandedError([id as never], new Error('the sync after the write failed'));
      return id;
    };
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { takes: true }, heads, events);
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let request: Awaited<ReturnType<Agent['buildActivationRequest']>>;
    try { request = await agent.buildActivationRequest([tool('a'), tool('b')]); } finally { console.error = error; }
    assert.equal(changeRows(context.rows).length, 1, 'the premise: the store holds the change row');
    assert.deepEqual(request.tools, [tool('a')], 'it goes on its recorded head');
    assert.deepEqual(changeRows(request.messages as unknown as Row[]).map((r) => r.content), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'carrying the change the store holds');
    assert.deepEqual(events.map((e) => e.type), ['head:declared'], 'traced as declared');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^\[head-declarations\] agent: storing a system change threw, but the store holds it, so the request declares it/);
  });

  it("lets a refusal over budget go on, keeping its own change rows, on the head while its record can't be cleared", async () => {
    const context = fakeContext([said('user', 'hello'), changeRow([tool('b')])], { overBudget: (r) => r.some((row) => row.participant === 'system') });
    const real = memoryHeadDeclarations(onMain);
    real.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    const heads: HeadDeclarationStore = { read: (name) => real.read(name), write: (name, head) => real.write(name, head), delete: () => false };
    const agent = agentOn(context, {}, heads);
    await assert.rejects(agent.buildActivationRequest([tool('a')]), { name: 'OverBudgetError' });
    assert.equal(changeRows(context.rows).length, 1, 'its row stays with the record');
  });

  it("lets a refusal over budget go on as it was on the head, its record kept, with no change row of its own to take", async () => {
    const context = fakeContext([said('user', 'hello')], { overBudget: () => true });
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    const agent = agentOn(context, {}, heads);
    await assert.rejects(agent.buildActivationRequest([tool('a')]), { name: 'OverBudgetError' });
    assert.ok(heads.read('agent'), 'its record stays');
  });

  it("removes the change rows its context holds on a model that takes no change, with no record or trace attached", async () => {
    const context = fakeContext([said('user', 'hello'), changeRow([tool('old')])]);
    const agent = new Agent({ name: 'agent', model: 'test-model', systemPrompt: SYSTEM }, context.cm, taking(false));
    await agent.buildActivationRequest([tool('a')]);
    assert.deepEqual(changeRows(context.rows), []);
  });

  it("doesn't declare again a change a host's row already carries, though the row isn't its own", async () => {
    const host: Row = { id: 'host', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('b')] } as never] };
    const context = fakeContext([said('user', 'hello'), host]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    const request = await agentOn(context, { takes: true }, heads).buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changesIn(request.messages), [host.content]);
    assert.deepEqual(changeRows(context.rows).map((r) => r.metadata), [undefined]);
  });

  it("keeps its own change rows on the head while its record can't be cleared, and takes both out once it can", async () => {
    const context = fakeContext([said('user', 'hello'), changeRow([tool('b')])]);
    const real = memoryHeadDeclarations(onMain);
    real.write('agent', { tools: [tool('a')], system: [SYSTEM] });
    let clears = false;
    const heads: HeadDeclarationStore = { read: (name) => real.read(name), write: (name, head) => real.write(name, head), delete: (name) => clears && real.delete(name) };
    const agent = agentOn(context, {}, heads);
    const held = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changesIn(held.messages), [], 'its request carries no change row');
    assert.equal(changeRows(context.rows).length, 1, 'its row stays with the record');
    assert.ok(real.read('agent'), 'and the record stays');
    clears = true;
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changeRows(context.rows), [], 'once the record clears, its row goes');
    assert.equal(real.read('agent'), null);
  });

  it('changes nothing in a dry run: at adoption, at a replacement, or on the head with rows left', async () => {
    const dry = { dryRun: true };
    {
      const context = fakeContext([said('user', 'hello')]);
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      await agentOn(context, { takes: true }, heads, events).buildActivationRequest([tool('a')], undefined, undefined, undefined, dry);
      assert.deepEqual([heads.read('agent'), events], [null, []], 'adoption');
    }
    {
      const context = fakeContext([said('user', 'hello')]);
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { takes: true }, heads, events);
      await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
      await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
      const preview = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')], undefined, undefined, dry);
      assert.equal(preview.system, `${SYSTEM}\nv2`, 'the head the request would go out on');
      assert.equal(preview.messages.some((m) => m.participant === 'system'), false, 'with no change its head already holds');
      assert.equal(changeRows(context.rows).length, 1, 'a replacement: the change stays');
      assert.deepEqual(heads.read('agent')!.system, [SYSTEM, 'v1']);
      assert.equal(events.length, 2);
    }
    {
      const context = fakeContext([said('user', 'hello'), changeRow([tool('old')])]);
      const heads = memoryHeadDeclarations(onMain);
      heads.write('agent', { tools: [tool('old')], system: [SYSTEM] });
      const events: HeadEvent[] = [];
      const preview = await agentOn(context, {}, heads, events).buildActivationRequest([tool('a')], undefined, undefined, undefined, dry);
      assert.equal(preview.messages.some((m) => m.participant === 'system'), false);
      assert.equal(changeRows(context.rows).length, 1, 'on the head: the rows stay');
      assert.notEqual(heads.read('agent'), null, 'and the record');
      assert.deepEqual(events, []);
    }
  });

  it("keeps a dry run's compiled sources index for index with its messages, its own change rows left out of both", async () => {
    const context = fakeContext([said('user', 'hello'), changeRow([tool('b')]), said('user', 'go on')]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM, 'v1'] });
    const agent = agentOn(context, { takes: true }, heads);
    const { compiled } = await (agent as unknown as {
      assembleActivationRequest(t: ToolDefinition[], i: unknown[], b: undefined, c: undefined, o: { dryRun: boolean }): Promise<{ compiled: { messages: unknown[]; provenance?: { messages: Array<{ bodies?: Array<{ messageId: string }> }> } } }>;
    }).assembleActivationRequest([tool('a'), tool('b')], [systemInjection('v2')], undefined, undefined, { dryRun: true });
    assert.equal(compiled.messages.length, 2, 'the change row left out');
    assert.deepEqual(compiled.provenance?.messages.map((source) => source.bodies?.[0]?.messageId), ['user:hello', 'user:go on'], 'and its source with it');
  });

  it('takes only rows holding a change when it moves the head, not a message stored with change metadata that holds none', async () => {
    const marked: Row = { id: 'marked', participant: 'agent', content: [{ type: 'text', text: 'not a change' }], metadata: { system: true, kind: 'system-change', agent: 'agent' } };
    const context = fakeContext([said('user', 'hello'), marked, changeRow([tool('b')])]);
    const heads = memoryHeadDeclarations(onMain);
    heads.write('agent', { tools: [tool('a')], system: [SYSTEM, 'v1'] });
    const events: HeadEvent[] = [];
    await agentOn(context, { takes: true }, heads, events).buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.deepEqual(context.rows.map((r) => r.id), ['user:hello', 'marked'], 'the change row went, the other stayed');
    assert.deepEqual(events, [{ type: 'head:moved', why: 'replaced', changesRemoved: 1 }]);
  });

  it("shows a dry run at a replacement the head the request would go out on, compiled again for kv-unified's hash", async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const heads = memoryHeadDeclarations(onMain);
    const agent = agentOn(context, { takes: true }, heads);
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    const adopted = context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash;
    const compiles = context.compiles.length;
    const preview = await agent.buildActivationRequest([tool('a')], [systemInjection('v2')], undefined, undefined, { dryRun: true });
    assert.equal(preview.system, `${SYSTEM}\nv2`);
    assert.equal(context.compiles.length - compiles, 2, 'compiled again');
    assert.equal(context.compiles.at(-1)?.dryRun, true);
    assert.notEqual(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, adopted, "with the new head's hash");
    assert.deepEqual(heads.read('agent')!.system, [SYSTEM, 'v1'], 'storing nothing');
  });

  it("leaves the agent's own changes out of the direct API's request where it has no recorded head", async () => {
    let sent: NormalizedRequest | undefined;
    const membrane = { takesToolOrSystemChanges: () => true, stream: async (request: NormalizedRequest) => { sent = request; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const context = fakeContext([said('user', 'hello'), changeRow([tool('b')])]);
    const agent = new Agent({ name: 'agent', model: 'test-model', systemPrompt: SYSTEM }, context.cm, membrane as unknown as Membrane);
    await agent.runInference([tool('a')]).catch(() => undefined);
    assert.ok(sent, 'a request went');
    assert.equal(sent!.messages.some((m) => m.content.some((b) => (b as { type: string }).type === 'system_change')), false);
  });

  describe('a compile refused over budget', () => {
    it('moves the head when a compile is refused over budget with changes kept, and compiles once more', async () => {
      const rows = [said('user', 'hello')];
      let refuse = false;
      const context = fakeContext(rows, { overBudget: (r) => refuse && r.some((row) => row.participant === 'system') });
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { systemPrompt: SHORT, takes: true }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      refuse = true;
      const compiles = context.compiles.length;
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the head took the change');
      assert.deepEqual(changeRows(rows), []);
      assert.equal(context.compiles.length - compiles, 2, 'the refused compile, and one more');
      assert.deepEqual(heads.read('agent')!.tools, [tool('a'), tool('b')]);
      assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'budget', changesRemoved: 1 });
    });

    it('moves the head the same way when the compile is refused for dropping messages no summary covers', async () => {
      const rows = [said('user', 'hello')];
      let refuse = false;
      const uncovered = () => (refuse && rows.some((row) => row.participant === 'system')
        ? Object.assign(new Error('uncovered drop'), { name: 'UncoveredDropError' })
        : undefined);
      const context = fakeContext(rows, { fail: uncovered });
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { systemPrompt: SHORT, takes: true }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.equal(changeRows(rows).length, 1, 'the premise: the change is stored');
      refuse = true;
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the head took the change');
      assert.deepEqual(changeRows(rows), []);
      assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'budget', changesRemoved: 1 });
    });

    it("keeps its changes, and the refusal goes on, when a compile is refused over budget while its head can't be stored", async () => {
      const rows = [said('user', 'hello')];
      let refuse = false;
      const context = fakeContext(rows, { overBudget: (r) => refuse && r.some((row) => row.participant === 'system') });
      const real = memoryHeadDeclarations(onMain);
      const heads: HeadDeclarationStore = {
        read: (name) => real.read(name),
        write: (name, head) => !refuse && real.write(name, head),
        delete: (name) => real.delete(name),
      };
      const agent = agentOn(context, { systemPrompt: SHORT, takes: true }, heads);
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      refuse = true;
      await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')]), { name: 'OverBudgetError' });
      assert.equal(changeRows(rows).length, 1, 'its change stays');
      assert.deepEqual(real.read('agent')!.tools, [tool('a')], 'with the recorded head');
    });

    it("takes its own change rows out of a compile refused over budget with no head recorded, or on the head, and compiles once more", async () => {
      for (const [config, why] of [[{ takes: true as const }, 'adopted'], [{}, 'on-head']] as const) {
        const rows = [said('user', 'hello'), changeRow([tool('b')])];
        const context = fakeContext(rows, { overBudget: (r) => r.some((row) => row.participant === 'system') });
        const heads = memoryHeadDeclarations(onMain);
        const events: HeadEvent[] = [];
        const request = await agentOn(context, { systemPrompt: SHORT, ...config }, heads, events).buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a'), tool('b')], `${why}: what's current goes out`);
        assert.deepEqual(changeRows(rows), [], `${why}: the rows went`);
        assert.equal(context.compiles.length, 2, `${why}: the refused compile, and one more`);
        assert.deepEqual(events, [{ type: 'head:moved', why, changesRemoved: 1 }], why);
        assert.deepEqual(heads.read('agent')?.tools ?? null, why === 'adopted' ? [tool('a'), tool('b')] : null, `${why}: the record`);
      }
    });

    it('takes the changes into the head when the compile after a declared change is refused over budget, and compiles once more', async () => {
      const rows = [said('user', 'hello')];
      const context = fakeContext(rows, { kvUnified: true, overBudget: (r) => r.some((row) => row.participant === 'system') });
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { systemPrompt: SHORT, takes: true }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the head took the change just declared');
      assert.deepEqual(changeRows(rows), []);
      assert.deepEqual(heads.read('agent')!.tools, [tool('a'), tool('b')]);
      assert.deepEqual(events.slice(1).map((e) => (e.type === 'head:moved' ? [e.type, e.why, e.changesRemoved] : [e.type])),
        [['head:declared'], ['head:moved', 'budget', 1]]);
      const fresh = fakeContext([said('user', 'hello')], { kvUnified: true });
      await agentOn(fresh, { systemPrompt: SHORT, takes: true }).buildActivationRequest([tool('a'), tool('b')]);
      assert.equal(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, fresh.compiles[0]?.kvUnifiedImmutablePrefixHash);
    });

    it('lets a refusal over budget go on when no change is kept, when the compile after the move is refused too, or in a dry run', async () => {
      const refusal = /over budget/;
      {
        const context = fakeContext([said('user', 'hello')], { overBudget: () => true });
        await assert.rejects(agentOn(context, { systemPrompt: SHORT, takes: true }).buildActivationRequest([tool('a')]), refusal, 'nothing recorded, nothing kept');
      }
      {
        let refuse = false;
        const context = fakeContext([said('user', 'hello')], { overBudget: () => refuse });
        const heads = memoryHeadDeclarations(onMain);
        const agent = agentOn(context, { systemPrompt: SHORT, takes: true }, heads);
        await agent.buildActivationRequest([tool('a')]);
        refuse = true;
        const compiles = context.compiles.length;
        await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')]), refusal, 'a head recorded, no change kept');
        assert.equal(context.compiles.length - compiles, 1, 'no compile again');
        assert.deepEqual(heads.read('agent')!.tools, [tool('a')], 'and the record as it was');
      }
      {
        const rows = [said('user', 'hello')];
        let failure: Error | undefined;
        const context = fakeContext(rows, { fail: () => failure });
        const agent = agentOn(context, { systemPrompt: SHORT, takes: true });
        await agent.buildActivationRequest([tool('a')]);
        await agent.buildActivationRequest([tool('a'), tool('b')]);
        failure = new Error('the store is closed');
        await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')]), /the store is closed/, 'another failure');
        assert.equal(changeRows(rows).length, 1, 'moves nothing');
      }
      {
        const rows = [said('user', 'hello')];
        let refuse = false;
        const context = fakeContext(rows, { overBudget: () => refuse });
        const heads = memoryHeadDeclarations(onMain);
        const agent = agentOn(context, { systemPrompt: SHORT, takes: true }, heads);
        await agent.buildActivationRequest([tool('a')]);
        await agent.buildActivationRequest([tool('a'), tool('b')]);
        refuse = true;
        const compiles = context.compiles.length;
        await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')]), refusal, 'the changes weren\'t the cause');
        assert.equal(context.compiles.length - compiles, 2, 'one more compile, not a loop');
        assert.deepEqual(changeRows(rows), [], 'the move stands: the rows are gone');
        assert.deepEqual(heads.read('agent')!.tools, [tool('a'), tool('b')], 'and the head is current');
      }
      {
        const rows = [said('user', 'hello')];
        let refuse = false;
        const context = fakeContext(rows, { overBudget: () => refuse });
        const agent = agentOn(context, { systemPrompt: SHORT, takes: true });
        await agent.buildActivationRequest([tool('a')]);
        await agent.buildActivationRequest([tool('a'), tool('b')]);
        refuse = true;
        await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')], undefined, undefined, undefined, { dryRun: true }), refusal);
        assert.equal(changeRows(rows).length, 1, 'a dry run moves nothing');
      }
      {
        const rows = [said('user', 'hello')];
        let refuse = false;
        const context = fakeContext(rows, { overBudget: () => refuse });
        const agent = agentOn(context, { systemPrompt: SHORT });
        await agent.buildActivationRequest([tool('a')]);
        refuse = true;
        await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')]), refusal, 'on the head');
      }
    });

  });

  describe('the rule for cost', () => {
    // A read costs a tenth of the input price, a 5-minute write 1.25 times it
    // and a 1-hour write twice it: k is 11.5 for 5 minutes and 19 for 1 hour.
    const PRICES: Prices = { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.5, cacheWrite1hPerMillion: 20, cacheReadPerMillion: 1, currency: 'USD' };
    const OLD = tool('a', 'a does a thing, as it was first written');
    const NEW = tool('a', 'a does a thing');
    const NOW: HeadDeclaration = { tools: [NEW], system: [SHORT] };
    // A move at a compile that rewrites from the first message writes the head alone.
    const EXTRA = requestCharacters(NOW, []);
    const DEAD = pricedCharacters(OLD);
    // The count at which carrying OLD reaches k times EXTRA, from a count of 0.
    const BAR = Math.ceil((19 * EXTRA) / DEAD);

    /** An agent that recorded OLD as its head at a count of `counted`, then
     *  declared NEW in its place at a count of `declaredAt`, so OLD is dead.
     *  Both are 0 unless a case sets them. Each compile rewrites from
     *  `firstChanged.at`, the first message unless a case sets it. */
    async function replaced(config: Parameters<typeof agentOn>[1] = {}, rows: Row[] = [said('user', 'hello')], counted = 0, declaredAt = counted) {
      const count = { n: counted };
      const firstChanged: { at: number | null } = { at: 0 };
      const context = fakeContext(rows, { firstChanged: () => firstChanged.at });
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => count.n, ...config }, heads, events);
      await agent.buildActivationRequest([OLD]);
      count.n = declaredAt;
      await agent.buildActivationRequest([NEW]);
      assert.equal(changeRows(context.rows).length, 1, 'the premise: the change is stored');
      return { agent, context, heads, events, count, firstChanged };
    }

    it('moves the head once carrying a replaced definition has cost k times what the move writes, and traces the three figures', async () => {
      const { agent, context, heads, events, count } = await replaced({}, [said('user', 'hello')], 0, 50);
      count.n = 50 + BAR - 1;
      const kept = await agent.buildActivationRequest([NEW]);
      assert.deepEqual(kept.tools, [OLD], 'below the bar: the recorded head');
      assert.deepEqual(foldOf(kept), now([NEW], SHORT), 'with the change, folding to what the agent has now');
      count.n = 50 + BAR;
      const moved = await agent.buildActivationRequest([NEW]);
      assert.deepEqual(moved.tools, [NEW], 'at the bar, counted from the change: the head moves');
      assert.deepEqual(changesIn(moved.messages), []);
      assert.deepEqual(changeRows(context.rows), [], 'and takes the row');
      assert.deepEqual(heads.read('agent'), NOW, 'the record is the head alone');
      assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'cost', changesRemoved: 1, estimated: { carried: DEAD * BAR, k: 19, extraNow: EXTRA } });
    });

    it('counts as dead what a move would take out: a removed tool, and a tool that dropped and came back, as its head copy', async () => {
      const BIG = tool('b', 'b does a thing. '.repeat(400));
      for (const [what, steps, dead] of [
        ['a removed tool', [[NEW, BIG], [NEW]], pricedCharacters(BIG)],
        ['a tool that dropped and came back', [[NEW, BIG], [NEW], [NEW, BIG]], pricedCharacters(BIG)],
      ] as const) {
        const count = { n: 0 };
        const context = fakeContext([said('user', 'hello')], { firstChanged: () => 0 });
        const events: HeadEvent[] = [];
        const agent = agentOn(context, { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => count.n }, memoryHeadDeclarations(onMain), events);
        for (const tools of steps) await agent.buildActivationRequest([...tools]);
        count.n = 1_000;
        const tools = steps.at(-1)!;
        const request = await agent.buildActivationRequest([...tools]);
        assert.deepEqual(request.tools, [...tools], `${what}: the head moves`);
        assert.equal((events.at(-1) as Extract<HeadEvent, { why: 'cost' }>).estimated.carried, dead * 1_000, `${what}: carried`);
      }
    });

    it("takes k from membrane's prices for the agent's cache lifetime: a 1-hour write at the 1-hour rate where membrane has one", async () => {
      const without: Prices = { ...PRICES };
      delete without.cacheWrite1hPerMillion;
      for (const [cacheTtl, prices, k] of [['1h', PRICES, 19], ['5m', PRICES, 11.5], ['1h', without, 11.5]] as const) {
        const { agent, events, count } = await replaced({ cacheTtl, pricing: () => prices });
        count.n = 10 * BAR;
        await agent.buildActivationRequest([NEW]);
        const moved = events.at(-1) as Extract<HeadEvent, { why: 'cost' }>;
        assert.equal(moved.estimated.k, k, `${cacheTtl}, ${prices === PRICES ? 'with' : 'without'} a 1-hour rate`);
      }
    });

    it('never moves for cost with nothing dead: an added tool carries nothing, whatever carrying cost before', async () => {
      const count = { n: 0 };
      const context = fakeContext([said('user', 'hello')], { firstChanged: () => 0 });
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => count.n }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      count.n = 1_000_000;
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a')], 'the recorded head');
      assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]]);
      assert.deepEqual(events.map((e) => e.type), ['head:moved', 'head:declared'], 'no move after the first');
    });

    it('counts from the rows the compile holds: once an undo takes out the row that replaced a definition, that definition adds nothing', async () => {
      const { agent, context, events, count } = await replaced();
      count.n = 10 * BAR;
      context.rows.splice(context.rows.findIndex((row) => changeRows([row]).length > 0), 1);
      const request = await agent.buildActivationRequest([NEW]);
      assert.deepEqual(request.tools, [OLD], 'no move for cost: the recorded head');
      assert.deepEqual(events.at(-1)?.type, 'head:declared', 'the change is declared again');
      assert.equal(changeRows(context.rows)[0]!.metadata?.inferenceCount, 10 * BAR, 'by a row that counts from now');
    });

    it("never moves for cost on a model membrane can't price, with a membrane that gives no prices, or for an agent with no count", async () => {
      for (const [what, config] of [
        ["membrane can't price the model", { pricing: () => undefined }],
        ['a membrane before 0.10.4, which gives no prices', { pricing: undefined }],
        ['no count, as for an ephemeral run', { counted: undefined }],
      ] as const) {
        const { agent, context, count } = await replaced(config);
        count.n = 10 * BAR;
        const request = await agent.buildActivationRequest([NEW]);
        assert.deepEqual(request.tools, [OLD], `${what}: the recorded head`);
        assert.equal(changeRows(context.rows).length, 1, `${what}: the change stays`);
      }
    });

    it('moves for cost only at a committing compile with a firstChanged: not at the first compile after it is built, nor in a preview', async () => {
      const { agent, context, heads, events, count, firstChanged } = await replaced();
      count.n = 10 * BAR;
      firstChanged.at = null;
      assert.deepEqual((await agent.buildActivationRequest([NEW])).tools, [OLD], 'no firstChanged: the recorded head');
      firstChanged.at = 0;
      const preview = await agent.buildActivationRequest([NEW], undefined, undefined, undefined, { dryRun: true });
      assert.deepEqual(preview.tools, [OLD], 'a preview: the recorded head');
      assert.equal(changeRows(context.rows).length, 1, 'and the change stays');
      assert.deepEqual(heads.read('agent'), { tools: [OLD], system: [SHORT] }, 'and the record');
      assert.deepEqual((await agent.buildActivationRequest([NEW])).tools, [NEW], 'the next committing compile with one: the head moves');
      const last = events.at(-1);
      assert.equal(last?.type === 'head:moved' ? last.why : last?.type, 'cost');
    });

    it('on a model that may bind its thinking, moves for cost only at a compile with no kept thinking before its firstChanged', async () => {
      const thought = (block: ContentBlock): Row => ({ id: `t-${block.type}`, participant: 'agent', content: [block, { type: 'text', text: 'so' }] });
      const thinking = { type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock;
      const redacted = { type: 'redacted_thinking', data: 'x' } as ContentBlock;
      for (const [what, binding, block, at, moves] of [
        ['binds, thinking before it', { binds: true }, thinking, 2, false],
        ['binds, redacted thinking before it', { binds: true }, redacted, 2, false],
        ['binds left out, thinking before it', undefined, thinking, 2, false],
        ['binds, thinking at it', { binds: true }, thinking, 1, true],
        ["doesn't bind, thinking before it", { binds: false }, thinking, 2, true],
      ] as const) {
        const { agent, count, firstChanged } = await replaced(binding ? { thinkingBinding: binding } : {}, [said('user', 'hello'), thought(block), said('user', 'and then')]);
        count.n = 10 * BAR;
        firstChanged.at = at;
        const request = await agent.buildActivationRequest([NEW]);
        assert.deepEqual(request.tools, moves ? [NEW] : [OLD], what);
      }
    });

    it("counts each inference since the row was stored, by the count in the row's mark, across a restart; a row whose count is above the agent's adds nothing", async () => {
      const { context, heads, count } = await replaced({}, [said('user', 'hello')], 10);
      assert.equal(changeRows(context.rows)[0]!.metadata?.inferenceCount, 10, "the premise: the row's mark holds the count it was stored at");
      const events: HeadEvent[] = [];
      const config = { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => count.n };
      count.n = 3;
      assert.deepEqual((await agentOn(context, config, heads, events).buildActivationRequest([NEW])).tools, [OLD], 'a count below the row\'s, as after a usage state that was reset: no move');
      assert.equal(events.length, 0, 'and nothing written');
      count.n = 10 + BAR;
      const moved = await agentOn(context, config, heads, events).buildActivationRequest([NEW]);
      assert.deepEqual(moved.tools, [NEW], 'built again, it moves at the bar');
      assert.deepEqual((events.at(-1) as Extract<HeadEvent, { why: 'cost' }>).estimated.carried, DEAD * BAR, "counted from the row's count");
    });

    it("counts nothing for a row with no count: a host's row, and a row that a copy took with no metadata", async () => {
      for (const [what, metadata] of [["a host's row", { system: true, kind: 'system-change' }], ['a copied row', undefined]] as const) {
        const row: Row = { id: 'h', participant: 'system', content: [{ type: 'system_change', defineTools: [NEW] } as never], ...(metadata ? { metadata: { ...metadata } } : {}) };
        const context = fakeContext([said('user', 'hello'), row], { firstChanged: () => 0 });
        const heads = memoryHeadDeclarations(onMain);
        heads.write('agent', { tools: [OLD], system: [SHORT] });
        const events: HeadEvent[] = [];
        const request = await agentOn(context, { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => 10 * BAR }, heads, events).buildActivationRequest([NEW]);
        assert.deepEqual(request.tools, [OLD], `${what}: no move for cost`);
        assert.deepEqual(foldOf(request), now([NEW], SHORT), `${what}: the row declares the change`);
        assert.equal(events.length, 0, `${what}: nothing moved or declared`);
      }
    });

    it("counts nothing for a row that its context can't read back: not what it kills, and not what it defines", async () => {
      // Each carries a count, so only the read back decides.
      const shared = (id: string, definition: ToolDefinition): Row => ({ id, participant: 'system', content: [{ type: 'system_change', defineTools: [definition] } as never], metadata: { system: true, kind: 'system-change', inferenceCount: 0 } });
      const between = tool('a', 'a does a thing, as it was written next');
      const rows = [said('user', 'hello'), shared('s1', between), shared('s2', NEW)];
      const context = fakeContext(rows, { firstChanged: () => 0, readOnly: new Set(['s1', 's2']) });
      const heads = memoryHeadDeclarations(onMain);
      heads.write('agent', { tools: [OLD], system: [SHORT] });
      const events: HeadEvent[] = [];
      const request = await agentOn(context, { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => 10 * BAR }, heads, events).buildActivationRequest([NEW]);
      assert.deepEqual(request.tools, [OLD], 'no move for cost: the recorded head');
      assert.deepEqual(foldOf(request), now([NEW], SHORT), 'with the rows that it reads, folding to what the agent has now');
      assert.deepEqual(events, [], 'nothing moved or declared');
      assert.equal(rows.length, 3, 'nothing taken out of the store');
    });

    it('makes no move that changes neither its head nor a row: it declares the change, and where the store refuses that, goes in the fallback form, writing and tracing nothing', async () => {
      for (const refuses of [false, true]) {
        const rows = [said('user', 'hello'), { id: 'gone', participant: 'system', content: [{ type: 'system_change', removeTools: ['a'] } as never], metadata: { system: true, kind: 'system-change' } }];
        const context = fakeContext(rows, { firstChanged: () => 0, readOnly: new Set(['gone']) });
        let tried = 0;
        if (refuses) context.cm.addMessage = () => { tried++; throw new Error("a system change can't go between a tool call and its result"); };
        const heads = memoryHeadDeclarations(onMain);
        const record = { tools: [tool('a')], system: [SHORT] };
        heads.write('agent', record);
        const writes: HeadDeclaration[] = [];
        const watched: HeadDeclarationStore = { read: (name) => heads.read(name), write: (name, head) => { writes.push(head); return heads.write(name, head); }, delete: (name) => heads.delete(name) };
        const events: HeadEvent[] = [];
        const request = await agentOn(context, { systemPrompt: SHORT, takes: true, pricing: () => PRICES, counted: () => 10 * BAR }, watched, events).buildActivationRequest([tool('a')]);
        assert.deepEqual(foldOf(request), now([tool('a')], SHORT), `refuses ${refuses}: what goes out folds to what the agent has now`);
        assert.deepEqual(writes, [], 'no record written');
        if (refuses) {
          assert.equal(tried, 1, 'the premise: it tried to store the change');
          assert.deepEqual(changesIn(request.messages), [], 'with no change row');
          assert.deepEqual(events, [], 'nothing traced');
          assert.deepEqual(heads.read('agent'), record, 'and the record as it was');
        } else {
          assert.deepEqual(changesIn(request.messages).at(-1), [{ type: 'system_change', defineTools: [tool('a')] }], 'the change declared');
          assert.deepEqual(events.map((e) => e.type), ['head:declared'], 'and no move');
        }
      }
    });
  });

  describe('what a change declares', () => {
    it("declares nothing where the system text is split into other blocks with the same text, which the request carries joined", async () => {
      const context = fakeContext([said('user', 'hello')]);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { takes: true }, memoryHeadDeclarations(onMain), events);
      await agent.buildActivationRequest([tool('a')], [systemInjection('one\ntwo')]);
      await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('one\ntwo')]);
      const split = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('one'), systemInjection('two')]);
      assert.deepEqual(split.tools, [tool('a')], 'on the recorded head');
      assert.deepEqual(changesIn(split.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'with its change row, so not in the fallback form');
      assert.deepEqual(foldOf(split), now([tool('a'), tool('b')], `${SYSTEM}\none\ntwo`));
      const added = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('one'), systemInjection('two'), systemInjection('three')]);
      assert.deepEqual(changesIn(added.messages).at(-1), [{ type: 'system_change', addSystem: ['three'] }], 'and a block after them is an addition');
      assert.deepEqual(events.flatMap((event) => (event.type === 'head:moved' ? [event.why] : [])), ['adopted'], 'nothing moved the head after its adoption');
    });

    it('declares an added, a removed and a redefined tool as one change, a tool whose schema alone changed among them', async () => {
      const typed = (type: string): ToolDefinition => ({ ...tool('typed'), inputSchema: { type: 'object', properties: { x: { type } } } });
      const before = [tool('keep'), tool('gone'), tool('changed', 'old words'), typed('string')];
      const after = [tool('keep'), tool('changed', 'new words'), typed('number'), tool('new')];
      const context = fakeContext([said('user', 'hello')]);
      const agent = agentOn(context, { takes: true });
      await agent.buildActivationRequest(before);
      const request = await agent.buildActivationRequest(after);
      assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', removeTools: ['gone'], defineTools: [tool('changed', 'new words'), typed('number'), tool('new')] }]]);
      assert.deepEqual(foldOf(request), now(after, SYSTEM), 'what goes out folds to what the agent has now');
      assert.equal(changeRows(context.rows).length, 1);
    });

    it('declares system text that continues the head\'s as an addition beside a tool change, and moves the head for a block inserted among the ones before', async () => {
      const context = fakeContext([said('user', 'hello')]);
      const heads = memoryHeadDeclarations(onMain);
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { takes: true }, heads, events);
      await agent.buildActivationRequest([tool('a')], [systemInjection('kept')]);
      const continued = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('kept'), systemInjection('new one'), systemInjection('new two')]);
      assert.equal(continued.system, `${SYSTEM}\nkept`, 'the recorded head');
      assert.deepEqual(changesIn(continued.messages), [[{ type: 'system_change', defineTools: [tool('b')], addSystem: ['new one', 'new two'] }]], 'one block for both');
      assert.deepEqual(foldOf(continued), now([tool('a'), tool('b')], `${SYSTEM}\nkept\nnew one\nnew two`));
      const inserted = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('kept'), systemInjection('between'), systemInjection('new one'), systemInjection('new two')]);
      assert.equal(inserted.system, `${SYSTEM}\nkept\nbetween\nnew one\nnew two`, 'a block in the middle is no addition: the head moves');
      assert.deepEqual(changesIn(inserted.messages), []);
      assert.deepEqual(foldOf(inserted), now([tool('a'), tool('b')], `${SYSTEM}\nkept\nbetween\nnew one\nnew two`));
      assert.deepEqual(changeRows(context.rows), [], 'and takes the change it now holds');
      assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'replaced', changesRemoved: 1 });
    });

    it('compares a tool as the wire carries it: a Date in its schema, or a field left undefined, declares nothing', async () => {
      const dated = { ...tool('a'), inputSchema: { type: 'object', properties: { when: { type: 'string', default: new Date('2026-01-01T00:00:00Z') } } } } as unknown as ToolDefinition;
      const withUndefined = { ...tool('b'), extra: undefined } as unknown as ToolDefinition;
      const context = fakeContext([said('user', 'hello')]);
      const heads = memoryHeadDeclarations(onMain);
      heads.write('agent', JSON.parse(JSON.stringify({ tools: [dated, tool('b')], system: [SYSTEM] })));
      const request = await agentOn(context, { takes: true }, heads).buildActivationRequest([dated, withUndefined]);
      assert.deepEqual(changesIn(request.messages), [], 'as recorded, the Date is the text the wire carries');
      assert.deepEqual(changeRows(context.rows), []);
    });

    it('moves the head for an addition the head already holds, as after a rewind past a move brings a change row back', async () => {
      const brought: Row = { id: 'c-back', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('a')], addSystem: ['added'] } as never], metadata: { system: true, kind: 'system-change', agent: 'agent' } };
      const context = fakeContext([said('user', 'hello'), brought]);
      const heads = memoryHeadDeclarations(onMain);
      heads.write('agent', { tools: [tool('a')], system: [SYSTEM, 'added'] });
      const events: HeadEvent[] = [];
      const request = await agentOn(context, { takes: true }, heads, events).buildActivationRequest([tool('a')], [systemInjection('added')]);
      assert.deepEqual(foldOf(request), now([tool('a')], `${SYSTEM}\nadded`), 'the text goes out once');
      assert.deepEqual(changesIn(request.messages), []);
      assert.deepEqual(changeRows(context.rows), [], 'the row brought back is taken');
      assert.deepEqual(events, [{ type: 'head:moved', why: 'replaced', changesRemoved: 1 }]);
    });
  });

  it('refuses a thinkingBinding.binds it can\'t read', () => {
    const context = fakeContext();
    assert.throws(() => agentOn(context, { thinkingBinding: true as never }), /Agent "agent" thinkingBinding/);
    assert.throws(() => agentOn(context, { thinkingBinding: { binds: 'false' as never } }), /Agent "agent" thinkingBinding.binds must be true or false, unquoted, not a string/);
  });

  it("tells a compile with `binds: true` the head the request carries: a declared change keeps its digests, a move changes them", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { takes: true, thinkingBinding: { binds: true } });
    type Identity = Record<'system' | 'tools' | 'model' | 'request', string>;
    const assemble = (tools: ToolDefinition[], system: string) => (agent as unknown as {
      assembleActivationRequest(t: ToolDefinition[], i: unknown[]): Promise<{ request: NormalizedRequest; binding: { identity?: Identity } }>;
    }).assembleActivationRequest(tools, [systemInjection(system)]);
    const lastIdentity = () => (context.compiles.at(-1) as { identity?: Identity }).identity!;
    const carried = (request: NormalizedRequest, identity: Identity, what: string) => {
      assert.equal(identity.system, digest(request.system), `${what}: the system text the request carries`);
      assert.equal(identity.tools, digest(request.tools ?? []), `${what}: the tools it carries`);
    };
    const adopted = await assemble([tool('a')], 'v1');
    carried(adopted.request, lastIdentity(), 'adopted');
    const declared = await assemble([tool('a'), tool('b')], 'v1');
    assert.deepEqual(lastIdentity(), adopted.binding.identity, 'a declared change: the head, and its digests, as they were');
    carried(declared.request, lastIdentity(), 'declared');
    const moved = await assemble([tool('a'), tool('b')], 'v2');
    carried(moved.request, lastIdentity(), 'moved');
    assert.notEqual(lastIdentity().tools, adopted.binding.identity!.tools, 'a move: the new head\'s digests');
    const replaced = await assemble([tool('a'), tool('b')], 'v3');
    carried(replaced.request, lastIdentity(), 'replaced, with no change row to take');
    for (const { binding } of [adopted, declared, moved, replaced]) assert.ok(binding.identity, 'the stream notes with the binding');
    assert.deepEqual(moved.binding.identity, (context.compiles.at(-3) as { identity?: Identity }).identity, "and the stream's binding is the compile's the request was built from");
    assert.deepEqual(replaced.binding.identity, lastIdentity());
  });
});
