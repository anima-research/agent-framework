/**
 * toolDeclarations: under 'entries' a
 * request carries the agent's recorded head, and each later change to its
 * tools or addition to its system text is a system change stored where it
 * took effect; under 'head', the default, a request is as before, with any
 * change rows left out. The fake context manager keeps rows in order, as the
 * store would, and compiles them back whole, naming each row as its message's
 * source, as a compile's provenance does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { jsonTokenEstimator, type ContextManager } from '@animalabs/context-manager';
import { NativeFormatter } from '@animalabs/membrane';
import type { ContentBlock, Membrane, NormalizedMessage, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { Agent } from '../src/agent.js';
import { memoryHeadDeclarations, type HeadDeclarationStore, type HeadEvent } from '../src/system-changes.js';
import type { AgentConfig } from '../src/types/index.js';

interface Row { id: string; participant: string; content: ContentBlock[]; metadata?: Record<string, unknown>; bodyGroupId?: string; shardIndex?: number }

/** A context whose compile returns every stored row, with the system
 *  injections it's given, and which records each compile's options. A
 *  committing compile's `firstChanged` is read when it's read, as
 *  context-manager's is, counted in `firstChangedReads`: `opts.firstChanged()`,
 *  or with 'compare', the first message that differs from the last committing
 *  compile's, as context-manager compares them. A dry compile has none. */
function fakeContext(rows: Row[] = [], opts: { kvUnified?: boolean; firstChanged?: (() => number | null) | 'compare'; overBudget?: (rows: Row[]) => boolean; fail?: () => Error | undefined } = {}) {
  let next = rows.length;
  const compiles: Array<{ kvUnifiedImmutablePrefixHash?: string; dryRun?: boolean } | undefined> = [];
  const reads = { firstChanged: 0 };
  const windows: Array<{ offset: number; limit: number; resolveBlobs?: boolean }> = [];
  let lastCommitted: string[] | null = null;
  const cm = {
    compile: async (_budget: unknown, injections: Array<{ position: string; content: ContentBlock[] }> | undefined, o?: { kvUnifiedImmutablePrefixHash?: string; dryRun?: boolean }) => {
      compiles.push(o);
      if (opts.overBudget?.(rows)) throw Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
      const failure = opts.fail?.();
      if (failure) throw failure;
      const result = {
        messages: rows.map((r) => ({ participant: r.participant, content: r.content })),
        systemInjections: (injections ?? []).filter((i) => i.position === 'system').flatMap((i) => i.content),
        // Each message a raw copy of its row, which the compile read with its metadata.
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
    removeMessage: (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
    getStrategy: () => ({ isKvUnifiedEnabled: () => opts.kvUnified === true }),
    getAllMessages: () => rows.map((r) => ({ id: r.id, participant: r.participant, content: r.content, metadata: r.metadata ?? {} })),
    getMessageCount: () => rows.length,
    getMessageWindow: (offset: number, limit: number, o?: { resolveBlobs?: boolean }) => {
      windows.push({ offset, limit, resolveBlobs: o?.resolveBlobs });
      return { messages: rows.slice(offset, offset + limit), startIndex: offset };
    },
  };
  return { cm: cm as unknown as ContextManager, rows, compiles, reads, windows };
}

const tool = (name: string, description = `${name} does a thing`): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

const said = (participant: string, text: string): Row => ({ id: `${participant}:${text}`, participant, content: [{ type: 'text', text }] });

const systemInjection = (text: string) => ({ namespace: 'module', position: 'system' as const, content: [{ type: 'text' as const, text }] });

function agentOn(
  context: ReturnType<typeof fakeContext>,
  config: Partial<AgentConfig> = {},
  heads: HeadDeclarationStore = memoryHeadDeclarations(),
  events: HeadEvent[] = [],
): Agent {
  const agent = new Agent({ name: 'agent', model: 'test-model', systemPrompt: 'You are an agent.', ...config }, context.cm, {} as Membrane);
  agent.attachHeadDeclarations(heads, (event) => events.push(event));
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
/** A change's price, as context-manager prices one: from its JSON at the dense rate. */
const priceOf = (block: unknown) => jsonTokenEstimator(JSON.stringify(block));
/** A digest as a request's JSON carries the value, each object's keys sorted, as the agent takes one. */
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

describe('toolDeclarations', () => {
  it("leaves out of 'head' requests every change row, and sends the current tools and system text as before", async () => {
    const context = fakeContext([
      said('user', 'hello'),
      { id: 'c1', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('old')] } as never], metadata: { system: true, kind: 'system-change', agent: 'agent' } },
    ]);
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [tool('old')], system: ['You are an agent.'] });
    const events: HeadEvent[] = [];
    const request = await agentOn(context, {}, heads, events).buildActivationRequest([tool('a')], [systemInjection('injected')]);
    assert.deepEqual(request.tools, [tool('a')]);
    assert.equal(request.system, 'You are an agent.\ninjected');
    assert.equal(request.messages.length, 1);
    assert.equal(heads.read('agent'), null, "a record left from an earlier 'entries' period goes");
    assert.deepEqual(changeRows(context.rows), [], 'and so do its change rows');
    assert.deepEqual(events, [{ type: 'head:moved', why: 'on-head', changesRemoved: 1 }]);
  });

  it("adopts the current head at an 'entries' agent's first request, appending nothing", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations();
    const events: HeadEvent[] = [];
    const request = await agentOn(context, { toolDeclarations: 'entries' }, heads, events).buildActivationRequest([tool('a')], [systemInjection('injected')]);
    assert.deepEqual(request.tools, [tool('a')]);
    assert.equal(request.system, 'You are an agent.\ninjected');
    assert.deepEqual(heads.read('agent'), { tools: [tool('a')], system: ['You are an agent.', 'injected'] });
    assert.deepEqual(changeRows(context.rows), []);
    assert.deepEqual(events, [{ type: 'head:moved', why: 'adopted', changesRemoved: 0 }]);
  });

  it('declares a later tool change at the end, keeping the recorded head, and a restart sends the same', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations();
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
    await agent.buildActivationRequest([tool('a')]);
    context.rows.push(said('agent', 'hi'), said('user', 'go on'));

    const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(request.tools, [tool('a')], 'the head stays as recorded');
    assert.deepEqual(lastMessage(request.messages), {
      participant: 'system',
      content: [{ type: 'system_change', defineTools: [tool('b')] }],
    });
    assert.equal(changeRows(context.rows).length, 1, 'stored where it took effect');
    assert.deepEqual(changeRows(context.rows)[0]!.metadata, { system: true, kind: 'system-change', agent: 'agent' });
    assert.deepEqual(events.at(-1), { type: 'head:declared', removed: [], defined: ['b'], addedSystem: 0 });

    // Built again on the same store and record, as after a restart: the
    // stored change reads back as declared, and nothing new is appended.
    const restarted = await agentOn(context, { toolDeclarations: 'entries' }, heads).buildActivationRequest([tool('b'), tool('a')]);
    assert.deepEqual(restarted.tools, [tool('a')]);
    assert.deepEqual(restarted.messages, request.messages);
    assert.equal(changeRows(context.rows).length, 1);
  });

  it('declares added system text as an addition, and moves the head for a replacement', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations();
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
    await agent.buildActivationRequest([tool('a')], [systemInjection('instructions v1')]);

    const added = await agent.buildActivationRequest([tool('a')], [systemInjection('instructions v1'), systemInjection('a server joined')]);
    assert.equal(added.system, 'You are an agent.\ninstructions v1');
    assert.deepEqual(lastMessage(added.messages).content, [{ type: 'system_change', addSystem: ['a server joined'] }]);

    const compilesBefore = context.compiles.length;
    const replaced = await agent.buildActivationRequest([tool('a')], [systemInjection('instructions v2'), systemInjection('a server joined')]);
    assert.equal(replaced.system, 'You are an agent.\ninstructions v2\na server joined', 'the head is what\'s current');
    assert.deepEqual(changeRows(context.rows), [], 'the change it now holds is removed');
    assert.equal(context.compiles.length - compilesBefore, 2, 'and the compile runs again without it');
    assert.equal(replaced.messages.some((m) => m.participant === 'system'), false);
    assert.deepEqual(heads.read('agent')!.system, ['You are an agent.', 'instructions v2', 'a server joined']);
    assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'replaced', changesRemoved: 1 });
  });

  it('compiles once for a replacement that removed nothing, where the compile hashed no head', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    const compiles = context.compiles.length;
    const request = await agent.buildActivationRequest([tool('a')], [systemInjection('v2')]);
    assert.equal(request.system, 'You are an agent.\nv2');
    assert.equal(context.compiles.length - compiles, 1);
  });

  it('declares nothing for the same tools in another order', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    const request = await agent.buildActivationRequest([tool('b'), tool('a')]);
    assert.deepEqual(request.tools, [tool('a'), tool('b')]);
    assert.deepEqual(changeRows(context.rows), []);
  });

  it('shows a dry run the change the next request would declare, storing nothing', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations();
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
    await agent.buildActivationRequest([tool('a')]);
    const preview = await agent.buildActivationRequest([tool('a'), tool('b')], undefined, undefined, undefined, { dryRun: true });
    assert.deepEqual(lastMessage(preview.messages).content, [{ type: 'system_change', defineTools: [tool('b')] }]);
    assert.deepEqual(changeRows(context.rows), []);
    assert.equal(events.length, 1, 'only the adoption');
  });

  it("keeps a request ending on the agent's own turn ending there, with its [Continue], past a change", async () => {
    const context = fakeContext([said('user', 'hello'), said('agent', 'thinking aloud')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
    const roles = request.messages.map((m) => (m.content.some((b) => (b as { type: string }).type === 'system_change') ? 'change' : m.participant));
    assert.deepEqual(roles.slice(-3), ['agent', 'change', 'user'], 'the change, then the [Continue] the agent\'s turn needs');
  });

  it("goes out as membrane renders it: a system message after the user turn, the [Continue] one included", async () => {
    // What membrane's native formatter puts on the wire for each request.
    const wire = (request: NormalizedRequest) => new NativeFormatter().buildMessages(request.messages, {
      participantMode: 'simple', assistantParticipant: 'agent', humanParticipant: 'user', tools: request.tools,
    }).messages.map((m) => `${m.role}:${(m.content as Array<{ type: string }>).map((b) => b.type).join('+')}`);
    const asked = fakeContext([said('user', 'hello')]);
    const agent = agentOn(asked, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    assert.deepEqual(wire(await agent.buildActivationRequest([tool('a'), tool('b')])), ['user:text', 'system:tool_addition']);

    const answered = fakeContext([said('user', 'hello'), said('agent', 'thinking aloud')]);
    const own = agentOn(answered, { toolDeclarations: 'entries' });
    await own.buildActivationRequest([tool('a')]);
    assert.deepEqual(wire(await own.buildActivationRequest([tool('a'), tool('b')])),
      ['user:text', 'assistant:text', 'user:text', 'system:tool_addition'], "after the [Continue] the agent's own turn needs");
  });

  it("waits where context-manager would refuse the change: after a call another's result left partly answered, or one sharded over a body; not after a cycle its own blocks answer", async () => {
    const call = (...ids: string[]) => ids.map((id) => ({ type: 'tool_use', id, name: 'x', input: {} }) as ContentBlock);
    const result = (...ids: string[]) => ids.map((id) => ({ type: 'tool_result', toolUseId: id, content: 'ok' }) as ContentBlock);
    const cases: Array<[string, Row[], boolean]> = [
      ['parallel calls, one answered', [{ id: 'c', participant: 'beta', content: call('p1', 'p2') }, { id: 'r', participant: 'user', content: result('p1') }], false],
      ['parallel calls, both answered in messages of their own', [{ id: 'c', participant: 'beta', content: call('p1', 'p2') }, { id: 'r1', participant: 'user', content: result('p1') }, { id: 'r2', participant: 'user', content: result('p2') }], true],
      ['a call on the first shard of a body', [
        { id: 's0', participant: 'beta', content: call('s1'), bodyGroupId: 'g', shardIndex: 0 },
        { id: 's1', participant: 'beta', content: [{ type: 'text', text: 'and more' }], bodyGroupId: 'g', shardIndex: 1 },
      ], false],
      ['a cycle its own blocks answer', [{ id: 'cycle', participant: 'beta', content: [...call('b1'), ...result('b1')] }], true],
    ];
    for (const [what, tail, declares] of cases) {
      const context = fakeContext([said('user', 'hello'), ...tail]);
      const agent = agentOn(context, { toolDeclarations: 'entries' });
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.equal(changeRows(context.rows).length, declares ? 1 : 0, what);
    }
  });

  it("reads only the store's tail, blob-free, to see whether a change may go at the end", async () => {
    const context = fakeContext(Array.from({ length: 1000 }, (_, i) => said(i % 2 ? 'agent' : 'user', `turn ${i}`)));
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    context.windows.length = 0;
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.equal(changeRows(context.rows).length, 1, 'declared');
    assert.deepEqual(context.windows, [{ offset: 984, limit: 16, resolveBlobs: false }], 'one window of the newest rows');
  });

  it("keeps its recorded head as recorded when what a request carries is changed in place", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    const first = await agent.buildActivationRequest([tool('a'), tool('b')]);
    first.tools![0]!.description = 'changed in place, as a hook might';
    (first.tools![0]!.inputSchema as { properties: Record<string, unknown> }).properties.added = { type: 'string' };
    const next = await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(next.tools, [tool('a')], 'the head as recorded');
    assert.equal(changeRows(context.rows).length, 1, 'with nothing declared back');
  });

  it('waits for the results before declaring after calls that have none yet', async () => {
    const call = { type: 'tool_use', id: 't1', name: 'a', input: {} } as ContentBlock;
    const context = fakeContext([said('user', 'hello'), { id: 'call', participant: 'agent', content: [call] }]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changeRows(context.rows), [], 'nothing between the call and its result');
    context.rows.push({ id: 'result', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock] });
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.equal(changeRows(context.rows).length, 1, 'declared once the results are in');
    assert.equal(context.rows.at(-1)!.participant, 'system');
  });

  it("hashes a head for kv-unified as the wire carries it, so a tool field left undefined hashes the same after adoption", async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    const withUndefined = { ...tool('a'), extra: undefined } as unknown as ToolDefinition;
    await agent.buildActivationRequest([withUndefined]);
    await agent.buildActivationRequest([withUndefined]);
    const [adopted, next] = context.compiles.map((o) => o?.kvUnifiedImmutablePrefixHash);
    assert.ok(adopted);
    assert.equal(next, adopted, "the recorded head's hash is the adopted one's");
  });

  it('hashes the head that goes out for kv-unified: the recorded one, and the new one after a move', async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    const [adopted] = context.compiles.map((o) => o?.kvUnifiedImmutablePrefixHash);
    assert.ok(adopted);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
    assert.equal(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, adopted, 'a declared change leaves the head, and its hash, as they were');
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.equal(context.compiles.at(-2)?.kvUnifiedImmutablePrefixHash, adopted, 'the replacement is found by a compile at the recorded head');
    assert.notEqual(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, adopted, 'and the compile after the move hashes the new head');
  });

  it('deletes a record on the head whenever one is there, as after a branch switch brings it back', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [tool('old')], system: ['You are an agent.'] });
    const agent = agentOn(context, {}, heads);
    await agent.buildActivationRequest([tool('a')]);
    assert.equal(heads.read('agent'), null, 'deleted');
    heads.write('agent', { tools: [tool('old')], system: ['You are an agent.'] });
    await agent.buildActivationRequest([tool('a')]);
    assert.equal(heads.read('agent'), null, 'and again');
  });

  it('records a copy of the head, so a tool changed in place is declared rather than changing the head', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
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
    const agent = agentOn(context, { toolDeclarations: 'entries' }, memoryHeadDeclarations(), events);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('one')]);
    await agent.buildActivationRequest([tool('a')], [systemInjection('one'), systemInjection('two'), systemInjection('three')]);
    assert.deepEqual(events.at(-1), { type: 'head:declared', removed: ['b'], defined: [], addedSystem: 2 });
  });

  it("waits for its own calls' results when another participant's message follows the calls", async () => {
    const call = { type: 'tool_use', id: 't1', name: 'a', input: {} } as ContentBlock;
    const context = fakeContext([said('user', 'hello'), { id: 'call', participant: 'agent', content: [call] }, said('beta', 'meanwhile')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changeRows(context.rows), [], 'nothing between the calls and their results');
    context.rows.push({ id: 'other-result', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: "beta's" } as ContentBlock] });
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changeRows(context.rows), [], "another call's result doesn't answer the agent's");
    context.rows.push({ id: 'result', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' } as ContentBlock] });
    await agent.buildActivationRequest([tool('a'), tool('b')]);
    assert.equal(changeRows(context.rows).length, 1, 'declared once the results are in');
  });

  it('sends a change an assembly stored once with the next request, when its own request never went out, and declares nothing new', async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')]);
    await agent.buildActivationRequest([tool('a'), tool('b')]); // stored; say its request was never sent
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
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    const assemble = (tools: ToolDefinition[]) => (agent as unknown as { assembleActivationRequest(t: ToolDefinition[]): Promise<{ request: NormalizedRequest; continuePrompt?: unknown }> }).assembleActivationRequest(tools);
    await assemble([tool('a')]);
    const { request, continuePrompt } = await assemble([tool('a'), tool('b')]);
    assert.equal(lastMessage(request.messages).participant, 'system', 'the change is last');
    assert.deepEqual(continuePrompt, prompt, 'and the reply still continues the loop the results answer');
  });

  it('moves the head, after a record write that failed, without the old changes beside a head that holds them', async () => {
    // The changes go before the record: a stop between them leaves the old head and no rows.
    const context = fakeContext([said('user', 'hello')]);
    const real = memoryHeadDeclarations();
    let failWrites = false;
    const heads: HeadDeclarationStore = {
      read: (name) => real.read(name),
      write: (name, head) => { if (failWrites) throw new Error('the store refused the write'); real.write(name, head); },
      delete: (name) => real.delete(name),
    };
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads);
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
    failWrites = true;
    await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]), /refused the write/);
    assert.deepEqual(changeRows(context.rows), [], 'the change went before the record');
    failWrites = false;
    const next = await agentOn(context, { toolDeclarations: 'entries' }, heads).buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.deepEqual(next.tools, [tool('a'), tool('b')], 'the replacement moves the head');
    assert.deepEqual(changeRows(context.rows), [], 'with no old change left beside it');
    assert.deepEqual(real.read('agent'), { tools: [tool('a'), tool('b')], system: ['You are an agent.', 'v2'] });
  });

  it("removes an earlier period's change rows on the head with nothing tracing it", async () => {
    const context = fakeContext([said('user', 'hello'), changeRow([tool('old')])]);
    const agent = new Agent({ name: 'agent', model: 'test-model', systemPrompt: 'You are an agent.' }, context.cm, {} as Membrane);
    await agent.buildActivationRequest([tool('a')]);
    assert.deepEqual(changeRows(context.rows), []);
  });

  it("counts only its own change rows: one a host stored without the agent's metadata is neither folded, priced nor taken", async () => {
    const host: Row = { id: 'host', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('x'), tool('y'), tool('z')] } as never] };
    const context = fakeContext([said('user', 'hello'), host, changeRow([tool('b')])]);
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [tool('a')], system: ['You are an agent.', 'v1'] });
    const events: HeadEvent[] = [];
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
    const first = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
    assert.deepEqual(first.tools, [tool('a')], 'the recorded head');
    assert.deepEqual(changesIn(first.messages), [host.content, changeRow([tool('b')]).content], "the host's row goes out as stored, beside the agent's own");
    assert.deepEqual(changeRows(context.rows).map((r) => r.id), ['host', 'c-b'], "nothing declared: the agent's own row says its difference, and the host's isn't counted");
    // Past a tenth of this input the agent's own row isn't, and the host's alone is past a fifth.
    const [own, hosts] = [priceOf(changeRow([tool('b')]).content[0]), priceOf(host.content[0])];
    assert.ok(hosts * 5 >= own * 10 + 1);
    agent.noteResponseInput(own * 10 + 1);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
    assert.deepEqual(events, [], "no consolidation priced from the host's row");
    // A replacement moves the head, taking the agent's own row and leaving the host's, as a dry run shows first.
    const preview = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')], undefined, undefined, { dryRun: true });
    assert.deepEqual(changesIn(preview.messages), [host.content]);
    await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.deepEqual(changeRows(context.rows).map((r) => r.id), ['host']);
    assert.deepEqual(events, [{ type: 'head:moved', why: 'replaced', changesRemoved: 1 }]);
  });

  it("declares again a change a host's row already says, since it counts only its own", async () => {
    const host: Row = { id: 'host', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('b')] } as never] };
    const context = fakeContext([said('user', 'hello'), host]);
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [tool('a')], system: ['You are an agent.'] });
    const request = await agentOn(context, { toolDeclarations: 'entries' }, heads).buildActivationRequest([tool('a'), tool('b')]);
    assert.deepEqual(changesIn(request.messages), [host.content, [{ type: 'system_change', defineTools: [tool('b')] }]]);
    assert.deepEqual(changeRows(context.rows).map((r) => r.metadata), [undefined, { system: true, kind: 'system-change', agent: 'agent' }]);
  });

  it("traces nothing on the head for a change row a host stored without the agent's metadata, and leaves it out of the request", async () => {
    const host: Row = { id: 'host', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('x')] } as never] };
    const context = fakeContext([said('user', 'hello'), host]);
    const events: HeadEvent[] = [];
    const request = await agentOn(context, {}, memoryHeadDeclarations(), events).buildActivationRequest([tool('a')]);
    assert.deepEqual(changesIn(request.messages), []);
    assert.deepEqual(changeRows(context.rows).map((r) => r.id), ['host'], 'the host\'s row stays');
    assert.deepEqual(events, []);
  });

  it('changes nothing in a dry run: at adoption, at a replacement, or on the head with rows left', async () => {
    const dry = { dryRun: true };
    {
      const context = fakeContext([said('user', 'hello')]);
      const heads = memoryHeadDeclarations();
      const events: HeadEvent[] = [];
      await agentOn(context, { toolDeclarations: 'entries' }, heads, events).buildActivationRequest([tool('a')], undefined, undefined, undefined, dry);
      assert.deepEqual([heads.read('agent'), events], [null, []], 'adoption');
    }
    {
      const context = fakeContext([said('user', 'hello')]);
      const heads = memoryHeadDeclarations();
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
      await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
      await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v1')]);
      const preview = await agent.buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')], undefined, undefined, dry);
      assert.equal(preview.system, 'You are an agent.\nv2', 'the head the request would go out on');
      assert.equal(preview.messages.some((m) => m.participant === 'system'), false, 'with no change its head already holds');
      assert.equal(changeRows(context.rows).length, 1, 'a replacement: the change stays');
      assert.deepEqual(heads.read('agent')!.system, ['You are an agent.', 'v1']);
      assert.equal(events.length, 2);
    }
    {
      const context = fakeContext([said('user', 'hello'), changeRow([tool('old')])]);
      const heads = memoryHeadDeclarations();
      heads.write('agent', { tools: [tool('old')], system: ['You are an agent.'] });
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
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [tool('a')], system: ['You are an agent.', 'v1'] });
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads);
    const { compiled } = await (agent as unknown as {
      assembleActivationRequest(t: ToolDefinition[], i: unknown[], b: undefined, c: undefined, o: { dryRun: boolean }): Promise<{ compiled: { messages: unknown[]; provenance?: { messages: Array<{ bodies?: Array<{ messageId: string }> }> } } }>;
    }).assembleActivationRequest([tool('a'), tool('b')], [systemInjection('v2')], undefined, undefined, { dryRun: true });
    assert.equal(compiled.messages.length, 2, 'the change row left out');
    assert.deepEqual(compiled.provenance?.messages.map((source) => source.bodies?.[0]?.messageId), ['user:hello', 'user:go on'], 'and its source with it');
  });

  it("compiles a dry move again for a head that differs from the record only in a field set to null against one left out, and tells the digests of the head it shows, with `binds: true`", async () => {
    const withExtra = (extra: unknown) => ({ ...tool('x'), extra }) as unknown as ToolDefinition;
    const stored: Row = { id: 'c-x', participant: 'system', content: [{ type: 'system_change', defineTools: [JSON.parse(JSON.stringify(withExtra(undefined)))] } as never], metadata: { system: true, kind: 'system-change', agent: 'agent' } };
    const context = fakeContext([said('user', 'hello'), stored]);
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [withExtra(null)], system: ['You are an agent.'] });
    const agent = agentOn(context, { toolDeclarations: 'entries', thinkingBinding: { binds: true } }, heads);
    agent.noteResponseInput(1); // the change past a fifth: a forced move, which a dry run shows
    const before = context.compiles.length;
    const preview = await agent.buildActivationRequest([withExtra(undefined)], undefined, undefined, undefined, { dryRun: true });
    assert.equal(context.compiles.length - before, 2, 'compiled again for the new head');
    assert.equal((context.compiles.at(-1) as { identity?: Record<string, string> }).identity!.tools, digest(preview.tools ?? []), "told the digests of the head it shows");
  });

  it('takes only rows holding a change when it moves the head, not a message stored with change metadata that holds none', async () => {
    const marked: Row = { id: 'marked', participant: 'agent', content: [{ type: 'text', text: 'not a change' }], metadata: { system: true, kind: 'system-change', agent: 'agent' } };
    const context = fakeContext([said('user', 'hello'), marked, changeRow([tool('b')])]);
    const heads = memoryHeadDeclarations();
    heads.write('agent', { tools: [tool('a')], system: ['You are an agent.', 'v1'] });
    const events: HeadEvent[] = [];
    await agentOn(context, { toolDeclarations: 'entries' }, heads, events).buildActivationRequest([tool('a'), tool('b')], [systemInjection('v2')]);
    assert.deepEqual(context.rows.map((r) => r.id), ['user:hello', 'marked'], 'the change row went, the other stayed');
    assert.deepEqual(events, [{ type: 'head:moved', why: 'replaced', changesRemoved: 1 }]);
  });

  it("shows a dry run at a replacement the head the request would go out on, compiled again for kv-unified's hash", async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const heads = memoryHeadDeclarations();
    const agent = agentOn(context, { toolDeclarations: 'entries' }, heads);
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    const adopted = context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash;
    const compiles = context.compiles.length;
    const preview = await agent.buildActivationRequest([tool('a')], [systemInjection('v2')], undefined, undefined, { dryRun: true });
    assert.equal(preview.system, 'You are an agent.\nv2');
    assert.equal(context.compiles.length - compiles, 2, 'compiled again');
    assert.equal(context.compiles.at(-1)?.dryRun, true);
    assert.notEqual(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, adopted, "with the new head's hash");
    assert.deepEqual(heads.read('agent')!.system, ['You are an agent.', 'v1'], 'storing nothing');
  });

  it('compiles again after a replacement that removed nothing when kv-unified hashed the old head, whose hash covers its system text', async () => {
    const context = fakeContext([said('user', 'hello')], { kvUnified: true });
    const agent = agentOn(context, { toolDeclarations: 'entries' });
    await agent.buildActivationRequest([tool('a')], [systemInjection('v1')]);
    const compiles = context.compiles.length;
    await agent.buildActivationRequest([tool('a')], [systemInjection('v2')]);
    assert.equal(context.compiles.length - compiles, 2, 'once at the recorded head, once at the new one');
    assert.notEqual(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, context.compiles.at(-2)?.kvUnifiedImmutablePrefixHash, 'the system text alone changed the hash');
  });

  it('leaves the context\'s changes out of the direct API\'s request', async () => {
    let sent: NormalizedRequest | undefined;
    const membrane = { stream: async (request: NormalizedRequest) => { sent = request; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const context = fakeContext([said('user', 'hello'), changeRow([tool('b')])]);
    const agent = new Agent({ name: 'agent', model: 'test-model', systemPrompt: 'You are an agent.', toolDeclarations: 'entries' }, context.cm, membrane as unknown as Membrane);
    await agent.runInference([tool('a')]).catch(() => undefined);
    assert.ok(sent, 'a request went');
    assert.equal(sent!.messages.some((m) => m.content.some((b) => (b as { type: string }).type === 'system_change')), false);
  });

  describe('consolidation', () => {
    /** An agent with one change declared, and a response of `input` tokens
     *  reported since; the next compile's `firstChanged` is `at()`. */
    async function withOneChange(input: number, at: () => number | null, config: Partial<AgentConfig> = {}, rows: Row[] = [said('user', 'hello')]) {
      const context = fakeContext(rows, { firstChanged: at });
      const heads = memoryHeadDeclarations();
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries', ...config }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      agent.noteResponseInput(input);
      return { agent, context, heads, events };
    }
    const changeIndex = (rows: Row[]) => rows.findIndex((r) => r.participant === 'system');
    // The change `withOneChange` declares, priced: at a tenth of `tenth`, and
    // at a tenth but short of a fifth of `short`.
    const price = priceOf({ type: 'system_change', defineTools: [tool('b')] });
    const [tenth, short] = [price * 10, price * 5 + 1];

    it('moves the changes into the head once they reach a tenth of the input, at a compile that re-renders from before them', async () => {
      let at: number | null = null;
      const { agent, context, heads, events } = await withOneChange(tenth, () => at);
      at = changeIndex(context.rows);
      const compiles = context.compiles.length;
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the head is what\'s current');
      assert.deepEqual(changeRows(context.rows), []);
      assert.equal(context.compiles.length - compiles, 2, 'and the compile ran again without them');
      assert.deepEqual(heads.read('agent')!.tools, [tool('a'), tool('b')]);
      const moved = events.at(-1) as Extract<HeadEvent, { type: 'head:moved' }>;
      assert.equal(moved.why, 'consolidated');
      assert.equal(moved.changesRemoved, 1);
      assert.equal(moved.inputTokens, tenth);
      assert.equal(moved.changeTokens, price);
      assert.equal(moved.forced, undefined, 'a free move');
    });

    it("starts the changes at its own first one, past a host's change row before it", async () => {
      // The host's row at 1, the agent's own at 2; the compile re-renders from 2. At a tenth of the input, not a fifth.
      const host: Row = { id: 'host', participant: 'system', content: [{ type: 'system_change', defineTools: [tool('x')] } as never] };
      const context = fakeContext([said('user', 'hello'), host, changeRow([tool('b')])], { firstChanged: () => 2 });
      const heads = memoryHeadDeclarations();
      heads.write('agent', { tools: [tool('a')], system: ['You are an agent.'] });
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
      agent.noteResponseInput(short);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(events.map((e) => e.type === 'head:moved' && [e.why, e.changesRemoved, e.forced]), [['consolidated', 1, undefined]], 'a free move at a tenth');
      assert.deepEqual(changeRows(context.rows).map((r) => r.id), ['host']);
    });

    it('moves them anyway once they reach a fifth of the input with no free compile, and not below a fifth', async () => {
      const thought: Row = { id: 'thought', participant: 'agent', content: [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' }] };
      const cases = [
        ['after the change', () => (rows: Row[]) => changeIndex(rows) + 1, {}, false],
        ['nothing to compare', () => () => null, {}, false],
        ['a binding model with thinking before it', () => () => 2, { thinkingBinding: { binds: true } }, true],
      ] as const;
      for (const [what, makeAt, config, withThinking] of cases) {
        for (const [input, moves] of [[price * 5, true], [price * 5 + 1, false]] as const) {
          const rows: Row[] = withThinking ? [said('user', 'hello'), thought, said('user', 'and then')] : [said('user', 'hello')];
          const at = makeAt();
          const { agent, events } = await withOneChange(input, () => at(rows), config, rows);
          const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
          assert.deepEqual(request.tools, moves ? [tool('a'), tool('b')] : [tool('a')], `${what}, input ${input}`);
          assert.equal(changeRows(rows).length, moves ? 0 : 1, `${what}, input ${input}`);
          if (moves) assert.equal((events.at(-1) as Extract<HeadEvent, { type: 'head:moved' }>).forced, 'share', `${what}: forced`);
        }
      }
    });

    it('keeps them where they happened when the compile re-renders only after them, or nothing changed, or they cost under a tenth', async () => {
      for (const [input, at] of [[short, 'after'], [short, null], [tenth + 1, 'first']] as const) {
        const rows = [said('user', 'hello')];
        const { agent } = await withOneChange(input, () => (at === null ? null : at === 'first' ? 0 : changeIndex(rows) + 1), {}, rows);
        const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], `${input} ${at}: the recorded head`);
        assert.equal(changeRows(rows).length, 1, `${input} ${at}: the change stays`);
      }
    });

    it('moves the head when a compile is refused over budget with changes kept, and compiles once more', async () => {
      // Refused while a change row is kept; fits once the head has taken it.
      const rows = [said('user', 'hello')];
      let refuse = false;
      const context = fakeContext(rows, { overBudget: (r) => refuse && r.some((row) => row.participant === 'system') });
      const heads = memoryHeadDeclarations();
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      refuse = true;
      const compiles = context.compiles.length;
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the head took the change');
      assert.deepEqual(changeRows(rows), []);
      assert.equal(context.compiles.length - compiles, 2, 'the refused compile, and one more');
      assert.deepEqual(heads.read('agent')!.tools, [tool('a'), tool('b')]);
      assert.deepEqual(events.at(-1), { type: 'head:moved', why: 'consolidated', changesRemoved: 1, forced: 'budget' });
    });

    it("takes its own change rows out of a compile refused over budget with no head recorded, or on the head, and compiles once more", async () => {
      for (const [config, why] of [[{ toolDeclarations: 'entries' as const }, 'adopted'], [{}, 'on-head']] as const) {
        const rows = [said('user', 'hello'), changeRow([tool('b')])];
        const context = fakeContext(rows, { overBudget: (r) => r.some((row) => row.participant === 'system') });
        const heads = memoryHeadDeclarations();
        const events: HeadEvent[] = [];
        const request = await agentOn(context, config, heads, events).buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a'), tool('b')], `${why}: what's current goes out`);
        assert.deepEqual(changeRows(rows), [], `${why}: the rows went`);
        assert.equal(context.compiles.length, 2, `${why}: the refused compile, and one more`);
        assert.deepEqual(events, [{ type: 'head:moved', why, changesRemoved: 1 }], why);
        assert.deepEqual(heads.read('agent')?.tools ?? null, why === 'adopted' ? [tool('a'), tool('b')] : null, `${why}: the record`);
      }
    });

    it('takes the changes into the head when the compile after a declared change is refused over budget, and compiles once more', async () => {
      // The first compile fits; once the change is stored, it doesn't.
      const rows = [said('user', 'hello')];
      const context = fakeContext(rows, { kvUnified: true, overBudget: (r) => r.some((row) => row.participant === 'system') });
      const heads = memoryHeadDeclarations();
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
      await agent.buildActivationRequest([tool('a')]);
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the head took the change just declared');
      assert.deepEqual(changeRows(rows), []);
      assert.deepEqual(heads.read('agent')!.tools, [tool('a'), tool('b')]);
      assert.deepEqual(events.slice(1).map((e) => (e.type === 'head:moved' ? [e.type, e.why, e.changesRemoved, e.forced] : [e.type])),
        [['head:declared'], ['head:moved', 'consolidated', 1, 'budget']]);
      // The compile the request is built from was made for the new head, as an adoption of it hashes it.
      const fresh = fakeContext([said('user', 'hello')], { kvUnified: true });
      await agentOn(fresh, { toolDeclarations: 'entries' }).buildActivationRequest([tool('a'), tool('b')]);
      assert.equal(context.compiles.at(-1)?.kvUnifiedImmutablePrefixHash, fresh.compiles[0]?.kvUnifiedImmutablePrefixHash);
    });

    it("compiles once more after a move forced by the budget for the head that goes out, as kv-unified hashes it", async () => {
      const rows = [said('user', 'hello')];
      let refuse = false;
      const context = fakeContext(rows, { kvUnified: true, overBudget: (r) => refuse && r.some((row) => row.participant === 'system') });
      const agent = agentOn(context, { toolDeclarations: 'entries' });
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      refuse = true;
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      const hashes = context.compiles.slice(-2).map((o) => o?.kvUnifiedImmutablePrefixHash);
      // A fresh agent adopting the same head hashes it as the head that goes out.
      const fresh = fakeContext([said('user', 'hello')], { kvUnified: true });
      await agentOn(fresh, { toolDeclarations: 'entries' }).buildActivationRequest([tool('a'), tool('b')]);
      assert.notEqual(hashes[0], hashes[1], 'the refused compile hashed the recorded head');
      assert.equal(hashes[1], fresh.compiles[0]?.kvUnifiedImmutablePrefixHash, 'and the one after the move hashes the new one');
    });

    it('lets a refusal over budget go on when no change is kept, when the compile after the move is refused too, or in a dry run', async () => {
      const refusal = /over budget/;
      {
        const context = fakeContext([said('user', 'hello')], { overBudget: () => true });
        await assert.rejects(agentOn(context, { toolDeclarations: 'entries' }).buildActivationRequest([tool('a')]), refusal, 'nothing recorded, nothing kept');
      }
      {
        let refuse = false;
        const context = fakeContext([said('user', 'hello')], { overBudget: () => refuse });
        const heads = memoryHeadDeclarations();
        const agent = agentOn(context, { toolDeclarations: 'entries' }, heads);
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
        const agent = agentOn(context, { toolDeclarations: 'entries' });
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
        const heads = memoryHeadDeclarations();
        const agent = agentOn(context, { toolDeclarations: 'entries' }, heads);
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
        const agent = agentOn(context, { toolDeclarations: 'entries' });
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
        const agent = agentOn(context, {});
        await agent.buildActivationRequest([tool('a')]);
        refuse = true;
        await assert.rejects(agent.buildActivationRequest([tool('a'), tool('b')]), refusal, 'on the head');
      }
    });

    it('consolidates a change at the very start of the context, as anywhere', async () => {
      const context = fakeContext([changeRow([tool('b')]), said('user', 'hello')], { firstChanged: () => 0 });
      const heads = memoryHeadDeclarations();
      heads.write('agent', { tools: [tool('a')], system: ['You are an agent.'] });
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries' }, heads, events);
      agent.noteResponseInput(tenth);
      const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a'), tool('b')]);
      assert.deepEqual(events.map((e) => e.type === 'head:moved' && [e.why, e.forced]), [['consolidated', undefined]], 'a free move');
    });

    it("reads a compile's firstChanged only once the changes reach a tenth of the input, since context-manager compares when it's read", async () => {
      for (const [input, reads] of [[tenth + 1, 0], [tenth, 1]] as const) {
        const rows = [said('user', 'hello')];
        const { agent, context } = await withOneChange(input, () => changeIndex(rows) + 1, {}, rows);
        const before = context.reads.firstChanged;
        await agent.buildActivationRequest([tool('a'), tool('b')]);
        assert.equal(context.reads.firstChanged - before, reads, `input ${input}`);
      }
    });

    it('reads a change it declared as sent, not as rewritten, at the next compile', async () => {
      // context-manager's own comparison: the declared change is in the last committing compile,
      // so a compile with nothing new re-renders nothing and nothing is free.
      const context = fakeContext([said('user', 'hello')], { firstChanged: 'compare' });
      const events: HeadEvent[] = [];
      const agent = agentOn(context, { toolDeclarations: 'entries' }, memoryHeadDeclarations(), events);
      await agent.buildActivationRequest([tool('a')]);
      const declared = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(lastMessage(declared.messages).content, [{ type: 'system_change', defineTools: [tool('b')] }], 'the change goes out');
      agent.noteResponseInput(short);
      const next = await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(next.tools, [tool('a')], 'the recorded head: no free consolidation');
      assert.equal(changeRows(context.rows).length, 1);
      assert.deepEqual(events.map((e) => e.type), ['head:moved', 'head:declared']);
    });

    it('waits for a first response before measuring', async () => {
      const context = fakeContext([said('user', 'hello')], { firstChanged: () => 0 });
      const agent = agentOn(context, { toolDeclarations: 'entries' });
      await agent.buildActivationRequest([tool('a')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      await agent.buildActivationRequest([tool('a'), tool('b')]);
      assert.equal(changeRows(context.rows).length, 1);
    });

    it("prices the changes from their JSON as context-manager prices a change, and moves at a tenth of the input, not below", async () => {
      for (const [input, moves] of [[tenth, true], [tenth + 1, false]] as const) {
        const rows = [said('user', 'hello')];
        const { agent } = await withOneChange(input, () => changeIndex(rows), {}, rows);
        const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, moves ? [tool('a'), tool('b')] : [tool('a')], `input ${input}`);
      }
    });

    it('on a binding model, minds only thinking before firstChanged, redacted thinking included', async () => {
      const thought = (block: ContentBlock): Row => ({ id: `t-${block.type}`, participant: 'agent', content: [block, { type: 'text', text: 'so' }] });
      const thinking = { type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock;
      const redacted = { type: 'redacted_thinking', data: 'x' } as ContentBlock;
      // Thinking from firstChanged on is set aside by the compile's own change: it holds nothing back.
      {
        const rows = [said('user', 'hello'), thought(thinking), said('user', 'and then')];
        const { agent } = await withOneChange(short, () => 1, { thinkingBinding: { binds: true } }, rows);
        assert.deepEqual((await agent.buildActivationRequest([tool('a'), tool('b')])).tools, [tool('a'), tool('b')], 'thinking at firstChanged');
      }
      {
        const rows = [said('user', 'hello'), thought(redacted), said('user', 'and then')];
        const { agent } = await withOneChange(short, () => changeIndex(rows), { thinkingBinding: { binds: true } }, rows);
        assert.deepEqual((await agent.buildActivationRequest([tool('a'), tool('b')])).tools, [tool('a')], 'redacted thinking before it');
      }
    });

    it('on a binding model, leaves thinking the compile kept before its first change be', async () => {
      const thought: Row = { id: 'thought', participant: 'agent', content: [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' }] };
      const rows = () => [said('user', 'hello'), thought, said('user', 'and then')];
      for (const binds of [true, false]) {
        const stored = rows();
        const { agent } = await withOneChange(short, () => changeIndex(stored), { thinkingBinding: { binds } }, stored);
        const request = await agent.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, binds ? [tool('a')] : [tool('a'), tool('b')], `binds ${binds}`);
      }
    });
  });

  it('refuses a toolDeclarations or thinkingBinding.binds it can\'t read', () => {
    const context = fakeContext();
    assert.throws(() => agentOn(context, { toolDeclarations: 'sk-pasted-secret' as never }), (e: Error) => /Agent "agent" toolDeclarations must be 'head' or 'entries', not another string:/.test(e.message) && !e.message.includes('sk-pasted-secret'));
    assert.throws(() => agentOn(context, { thinkingBinding: true as never }), /Agent "agent" thinkingBinding/);
    assert.throws(() => agentOn(context, { thinkingBinding: { binds: 'false' as never } }), /Agent "agent" thinkingBinding.binds must be true or false, unquoted, not a string/);
  });

  it('reads `thinkingBinding.binds` in three states: left out, a model that may bind with nothing declared', () => {
    const context = fakeContext();
    const read = (thinkingBinding: unknown) => {
      const agent = agentOn(context, { thinkingBinding: thinkingBinding as never });
      return [agent.mayBindThinking, agent.thinkingBindingOption() !== undefined];
    };
    assert.deepEqual(read({ binds: true }), [true, true], 'true: may bind, and declared');
    assert.deepEqual(read({ binds: false }), [false, false], 'false: neither');
    for (const left of [undefined, null, {}, { dropBlock: true }]) {
      assert.deepEqual(read(left), [true, false], `${JSON.stringify(left)}: may bind, nothing declared`);
    }
  });

  it("tells a compile with `binds: true` the head the request carries under 'entries': a declared change keeps its digests, a move changes them", async () => {
    const context = fakeContext([said('user', 'hello')]);
    const agent = agentOn(context, { toolDeclarations: 'entries', thinkingBinding: { binds: true } });
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
    // A replacement that takes no change row still compiles again for the new head.
    const replaced = await assemble([tool('a'), tool('b')], 'v3');
    carried(replaced.request, lastIdentity(), 'replaced, with no change row to take');
    for (const { binding } of [adopted, declared, moved, replaced]) assert.ok(binding.identity, 'the stream notes with the binding');
    assert.deepEqual(moved.binding.identity, (context.compiles.at(-3) as { identity?: Identity }).identity, "and the stream's binding is the compile's the request was built from");
    assert.deepEqual(replaced.binding.identity, lastIdentity());
  });
});
