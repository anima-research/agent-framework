/**
 * A module's queryMessages can name the agent whose window it reads
 * (ModuleContext.queryMessages's `forAgent`): a conversation fork's or a
 * running sub-agent's own store, or the residents' shared slot for an
 * ordinary resident. Left out, it reads the delivery agent's (the primary's,
 * or the first agent's when none is primary), as before; a name that
 * isn't a registered agent throws.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework, type Module, type ModuleContext, type ModuleContextInjection } from '../src/index.js';
import { HeldStream, MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) await frameworks.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const texts = (r: { messages: Array<{ content: unknown }> }) =>
  r.messages.map((m) => (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text).join(''));

/** A module that, at each agent's gather, reads that agent's own window. */
class Reader implements Module {
  readonly name = 'reader';
  ctx: ModuleContext | null = null;
  seen = new Map<string, string[]>();
  async start(ctx: ModuleContext) { this.ctx = ctx; }
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess() { return {}; }
  async gatherContext(agentName: string): Promise<ModuleContextInjection[]> {
    this.seen.set(agentName, texts(this.ctx!.queryMessages({ participant: 'user' }, { forAgent: agentName })));
    return [];
  }
}

/** A module whose tool, when an agent calls it, writes a result for the
 *  agent named in its input, as a host delivers an async subagent's result. */
class Courier implements Module {
  readonly name = 'courier';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext) { this.ctx = ctx; }
  async stop() {}
  getTools() {
    return [{ name: 'deliver', description: 'Deliver a result', inputSchema: { type: 'object' as const, properties: { for: { type: 'string' } } } }];
  }
  /** `text` replaces the result's text; `end` ends the caller's turn. */
  async handleToolCall(call: { input: unknown }) {
    const input = call.input as { for: string; text?: string; end?: boolean };
    this.ctx!.addMessage('courier', [text(input.text ?? `RESULT FOR ${input.for}`)], undefined, { forAgent: input.for });
    return { success: true, data: { delivered: true }, ...(input.end ? { endTurn: true } : {}) };
  }
  async onProcess() { return {}; }
}

/** Wait for `cond`, failing after `ms` rather than hanging. */
async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function make(agents = ['prime'], extra: Partial<Parameters<typeof AgentFramework.create>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-query-for-agent-')); dirs.push(dir);
  const membrane = new MockMembrane();
  const reader = new Reader();
  const courier = new Courier();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: agents.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
    modules: [reader, courier],
    syncIntervalMs: 0,
    ...extra,
  });
  frameworks.push(framework);
  await framework.start();
  return { framework, membrane, reader, courier };
}

/** Run an ephemeral agent named `name` with `task`, driving the loop, while
 *  `during` runs once its run has started. */
async function runWorker(x: Awaited<ReturnType<typeof make>>, name: string, during: () => Promise<void> = async () => {}) {
  const created = await x.framework.createEphemeralAgent({ name, model: 'test-model', systemPrompt: 'Test' });
  created.contextManager.addMessage('user', [text('WORKER TASK')]);
  const run = x.framework.runEphemeralToCompletion(created.agent, created.contextManager);
  const processing = setInterval(() => { void x.framework.runUntilIdle(); }, 10);
  try {
    await during();
    await run;
  } finally {
    clearInterval(processing);
  }
  const own = created.contextManager.getAllMessages().map((msg) => texts({ messages: [msg] })[0]);
  created.cleanup();
  return own;
}

test("a running sub-agent's gather reads its own store by name, not the primary's", async () => {
  const x = await make();
  x.framework.getAgent('prime')!.getContextManager().addMessage('user', [text('PRIMARY')]);
  const created = await x.framework.createEphemeralAgent({ name: 'worker', model: 'test-model', systemPrompt: 'Test' });
  created.contextManager.addMessage('user', [text('WORKER TASK')]);
  x.membrane.pushResponse(createMockResponse([text('done')]));
  const run = x.framework.runEphemeralToCompletion(created.agent, created.contextManager);
  const processing = setInterval(() => { void x.framework.runUntilIdle(); }, 10);
  try { await run; } finally { clearInterval(processing); }
  assert.deepEqual(x.reader.seen.get('worker'), ['WORKER TASK']);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' })), ['PRIMARY'], 'left out, the primary\'s, as before');
  created.cleanup();
});

test("a conversation fork's window is read by its name", async () => {
  const x = await make(['prime'], { conversations: { templateAgent: 'prime', bind: { channel: 'mention' } } });
  const fork = await (x.framework as unknown as {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ name: string }>;
  }).createConversationAgent('conversation-probe-g1', { serverId: 'stub', channelId: 'world:probe' });
  x.framework.getAgent(fork.name)!.getContextManager().addMessage('user', [text('FORK ONLY')]);
  x.framework.getAgent('prime')!.getContextManager().addMessage('user', [text('PRIMARY')]);
  const read = texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: fork.name }));
  assert.ok(read.includes('FORK ONLY'));
  assert.ok(!read.includes('PRIMARY'), "a fork's store is its own");
  assert.ok(!texts(x.reader.ctx!.queryMessages({ participant: 'user' })).includes('FORK ONLY'), "and the primary's doesn't hold the fork's");
});

test("two ordinary residents read the same shared slot", async () => {
  const x = await make(['prime', 'helper']);
  x.framework.getAgent('prime')!.getContextManager().addMessage('user', [text('SHARED')]);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: 'helper' })), ['SHARED']);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: 'prime' })), ['SHARED']);
});

test("a name that isn't a registered agent throws, the empty one included", async () => {
  const x = await make();
  for (const forAgent of ['primee', '']) {
    assert.throws(() => x.reader.ctx!.queryMessages({}, { forAgent }), (err: Error) => {
      assert.equal(err.message, `Unknown agent: ${JSON.stringify(forAgent)}. A query names a registered agent: "prime" `
        + "(ModuleContext.getAgents() lists them), or leaves forAgent out to read the delivery agent's window: "
        + "the primary's, or the first agent's when none is primary.");
      return true;
    });
  }
});

test("the subconscious's name reads its own store, not the residents' slot its compile merges", async () => {
  const x = await make(['prime'], { subconscious: { enabled: true, systemPrompt: 'notice' } } as never);
  x.framework.getAgent('prime')!.getContextManager().addMessage('user', [text('RESIDENTS')]);
  x.framework.getAgent('Subconscious')!.getContextManager().addMessage('user', [text('ITS OWN')]);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: 'Subconscious' })), ['ITS OWN']);
});

test("a write the framework holds for one resident is among another resident's named read, as their slot is one", async () => {
  const x = await make(['prime', 'helper']);
  const internals = x.framework as unknown as { quiesced: boolean };
  internals.quiesced = true;
  try {
    x.reader.ctx!.addMessage('user', [text('HELD FOR PRIME')]);
    const read = x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: 'helper' });
    assert.deepEqual(texts(read), ['HELD FOR PRIME']);
    assert.equal(read.messages[0]!.held, true);
  } finally {
    internals.quiesced = false;
  }
});

test("the refusal lists the registered agents, cuts a long list at 400 characters, and says how many there are", async () => {
  const names = Array.from({ length: 40 }, (_, i) => `resident-${String(i).padStart(2, '0')}`);
  const two = await make(['prime', 'helper']);
  assert.throws(() => two.reader.ctx!.queryMessages({}, { forAgent: 'nobody' }), /registered agent: "prime", "helper" \(/);
  const many = await make(names);
  assert.throws(() => many.reader.ctx!.queryMessages({}, { forAgent: 'nobody' }), (err: Error) => {
    assert.match(err.message, /… \(40 in all\) \(ModuleContext\.getAgents\(\) lists them\)/);
    const list = err.message.slice(err.message.indexOf('registered agent: ') + 'registered agent: '.length, err.message.indexOf('… (40 in all)'));
    assert.equal(list.length, 400, 'the list is cut at 400 characters');
    assert.ok(list.startsWith('"resident-00", "resident-01"'));
    return true;
  });
  // The name itself is cut at 120 characters.
  const long = 'n'.repeat(500);
  assert.throws(() => two.reader.ctx!.queryMessages({}, { forAgent: long }), (err: Error) => {
    assert.ok(err.message.startsWith(`Unknown agent: "${'n'.repeat(119)}. A query`), err.message.slice(0, 160));
    return true;
  });
});

test("with no agent registered, the refusal says so, rather than offering a window there isn't", async () => {
  const x = await make([]);
  assert.throws(() => x.reader.ctx!.addMessage('user', [text('X')], undefined, { forAgent: 'prime' }),
    (err: Error) => err.message === `Unknown agent: "prime". No agent is registered yet, so there's no window to write to.`);
  assert.throws(() => x.reader.ctx!.queryMessages({}, { forAgent: 'prime' }),
    (err: Error) => err.message === `Unknown agent: "prime". No agent is registered yet, so there's no window to read.`);
});

test("the empty name is refused, since a write can't be routed to it", async () => {
  // On this branch the Dendrite registry refuses a nameless agent at create
  // ("a name is required"), so no agent can be registered under '': the
  // refusal is tested with prime alone registered. main's version registers
  // an agent under '' and checks the write is refused even so.
  const x = await make(['prime']);
  // The refused empty name isn't offered among the registered agents.
  assert.throws(() => x.reader.ctx!.addMessage('user', [text('FOR EMPTY')], undefined, { forAgent: '' }),
    (err: Error) => err.message === 'Unknown agent: "". A write names a registered agent: "prime" (ModuleContext.getAgents() lists them), '
      + "or leaves forAgent out to write to the delivery agent's window: the primary's, or the first agent's when none is primary.");
  assert.throws(() => x.reader.ctx!.queryMessages({}, { forAgent: '' }), /^Error: Unknown agent: ""\. A query names a registered agent: "prime" \(/);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' })), [], "nothing reached the primary's window");
});

test("a module's write for another ordinary resident lands in the shared slot, which the primary's getMessage, editMessage and removeMessage read as their own", async () => {
  const x = await make(['prime', 'helper']);
  const id = x.reader.ctx!.addMessage('user', [text('FOR HELPER')], undefined, { forAgent: 'helper' });
  assert.ok(id && !id.startsWith('held:'));
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' })), ['FOR HELPER'], "the primary's window is the residents' slot");
  assert.equal(texts({ messages: [x.reader.ctx!.getMessage(id)!] })[0], 'FOR HELPER');
  x.reader.ctx!.editMessage(id, [text('EDITED')]);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: 'helper' })), ['EDITED']);
  // Held for the helper's turn, its handle is the primary's too: the slot is one.
  const internals = x.framework as unknown as { activeTurnTokens: Map<string, unknown> };
  internals.activeTurnTokens.set('helper', Symbol('turn'));
  try {
    const handle = x.reader.ctx!.addMessage('user', [text('HELD FOR HELPER')], undefined, { forAgent: 'helper' });
    assert.match(handle, /^held:/);
    assert.equal(texts({ messages: [x.reader.ctx!.getMessage(handle)!] })[0], 'HELD FOR HELPER');
    x.reader.ctx!.removeMessage(handle);
    assert.ok(!texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: 'helper' })).includes('HELD FOR HELPER'));
  } finally {
    internals.activeTurnTokens.delete('helper');
  }
});

test("a module's write names its agent: a fork's lands in its own store, and left out, in the primary's (a running sub-agent's: below)", async () => {
  const x = await make(['prime'], { conversations: { templateAgent: 'prime', bind: { channel: 'mention' } } });
  const fork = await (x.framework as unknown as {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ name: string }>;
  }).createConversationAgent('conversation-probe-g1', { serverId: 'stub', channelId: 'world:probe' });
  x.reader.ctx!.addMessage('user', [text('FOR THE FORK')], undefined, { forAgent: fork.name });
  x.reader.ctx!.addMessage('user', [text('FOR THE PRIMARY')]);
  const userTexts = (name: string) => texts(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: name }));
  assert.ok(userTexts(fork.name).includes('FOR THE FORK'));
  assert.ok(!userTexts(fork.name).includes('FOR THE PRIMARY'));
  assert.ok(userTexts('prime').includes('FOR THE PRIMARY'));
  assert.ok(!userTexts('prime').includes('FOR THE FORK'));
});

test("a module's write for an unknown agent, the empty name included, throws naming the registered ones, and so does one carrying metadata.external", async () => {
  const x = await make();
  for (const forAgent of ['primee', '']) {
    assert.throws(() => x.reader.ctx!.addMessage('user', [text('LOST')], undefined, { forAgent }), (err: Error) => {
      assert.equal(err.message, `Unknown agent: ${JSON.stringify(forAgent)}. A write names a registered agent: "prime" `
        + "(ModuleContext.getAgents() lists them), or leaves forAgent out to write to the delivery agent's window: "
        + "the primary's, or the first agent's when none is primary.");
      return true;
    });
  }
  assert.throws(() => x.reader.ctx!.addMessage('user', [text('X')], { external: { source: 'chat', id: 'm1' } } as never, { forAgent: 'prime' }),
    /can't carry metadata\.external: its external id would be looked up in the primary's window/);
  assert.deepEqual(texts(x.reader.ctx!.queryMessages({ participant: 'user' })), [], 'nothing was written');
});

test("a write held for a busy fork lands at its next start, in that start's request; its handle and its row's id aren't the primary's to take, and are refused, never acted on there", async () => {
  const x = await make(['prime'], { conversations: { templateAgent: 'prime', bind: { channel: 'mention' } } });
  const fork = await (x.framework as unknown as {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ name: string }>;
  }).createConversationAgent('conversation-probe-g1', { serverId: 'stub', channelId: 'world:probe' });
  const internals = x.framework as unknown as { activeTurnTokens: Map<string, unknown> };
  internals.activeTurnTokens.set(fork.name, Symbol('turn'));
  let handle: string;
  try {
    handle = x.reader.ctx!.addMessage('user', [text('HELD FOR THE FORK')], undefined, { forAgent: fork.name });
    assert.match(handle, /^held:/, 'held while its turn is alive');
    assert.equal(x.reader.ctx!.getMessage(handle), null, "the primary's getMessage doesn't find it");
    assert.throws(() => x.reader.ctx!.editMessage(handle, [text('EDITED')]), /^Error: Message not found: held:/);
    assert.throws(() => x.reader.ctx!.removeMessage(handle), /^Error: Message not found: held:/);
  } finally {
    internals.activeTurnTokens.delete(fork.name);
  }
  // Its boundary: the fork's next start flushes what's held for it, so that
  // start's own request carries it.
  x.membrane.pushResponse(createMockResponse([text('fork reply')]));
  (x.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: fork.name, reason: 'timer', source: 'framework', timestamp: Date.now() });
  await x.framework.runUntilIdle();
  const sentTexts = x.membrane.calls.at(-1)!.messages.map((msg) => texts({ messages: [msg] })[0]);
  assert.ok(sentTexts.includes('HELD FOR THE FORK'), JSON.stringify(sentTexts));
  const row = x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: fork.name }).messages.find((m) => texts({ messages: [m] })[0] === 'HELD FOR THE FORK');
  assert.ok(row && !row.held, 'it landed in the fork\'s store');
  assert.equal(x.reader.ctx!.getMessage(row!.id), null, "the primary's getMessage doesn't find the fork's row");
  assert.throws(() => x.reader.ctx!.editMessage(row!.id, [text('EDITED')]), /^Error: Message not found: /);
  assert.throws(() => x.reader.ctx!.removeMessage(row!.id), /^Error: Message not found: /);
  assert.ok(x.reader.ctx!.queryMessages({ participant: 'user' }, { forAgent: fork.name }).messages.some((m) => texts({ messages: [m] })[0] === 'HELD FOR THE FORK'), 'and the row is as written');
});

test("before its flush, a write held for a busy fork is in the fork's named read and not the primary's, and the primary's held write is in the primary's and not the fork's", async () => {
  const x = await make(['prime'], { conversations: { templateAgent: 'prime', bind: { channel: 'mention' } } });
  const fork = await (x.framework as unknown as {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ name: string }>;
  }).createConversationAgent('conversation-probe-g2', { serverId: 'stub', channelId: 'world:probe' });
  const internals = x.framework as unknown as { activeTurnTokens: Map<string, unknown> };
  internals.activeTurnTokens.set(fork.name, Symbol('turn'));
  internals.activeTurnTokens.set('prime', Symbol('turn'));
  try {
    const forFork = x.reader.ctx!.addMessage('user', [text('HELD FOR THE FORK')], undefined, { forAgent: fork.name });
    const forPrime = x.reader.ctx!.addMessage('user', [text('HELD FOR THE PRIME')]);
    assert.match(forFork, /^held:/, 'the premise: held while the fork\'s turn is alive');
    assert.match(forPrime, /^held:/, 'the premise: held while the primary\'s turn is alive');
    const read = (forAgent?: string) => x.reader.ctx!.queryMessages({ participant: 'user' }, forAgent === undefined ? undefined : { forAgent })
      .messages.filter((m) => m.held).map((m) => texts({ messages: [m] })[0]);
    assert.deepEqual(read(fork.name), ['HELD FOR THE FORK']);
    assert.deepEqual(read(), ['HELD FOR THE PRIME']);
  } finally {
    internals.activeTurnTokens.delete(fork.name);
    internals.activeTurnTokens.delete('prime');
  }
});

const deliver = (input: Record<string, unknown>) =>
  createMockResponse([{ type: 'tool_use', id: 'c1', name: 'courier--deliver', input } as ContentBlock], 'tool_use');
const primaryTexts = (x: Awaited<ReturnType<typeof make>>) =>
  x.framework.getAgent('prime')!.getContextManager().getAllMessages().map((msg) => texts({ messages: [msg] })[0]);

test("a module's write held for an ephemeral run that ends without reading it goes to the primary as written, through the primary's ordinary delivery", async () => {
  const x = await make();
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  x.membrane.streamYielding = ((request: never) => {
    x.membrane.calls.push(request);
    return new HeldStream(released, [createMockResponse([text('done')])]);
  }) as never;
  const internals = x.framework as unknown as { activeTurnTokens: Map<string, unknown> };
  await runWorker(x, 'worker', async () => {
    await until(() => x.membrane.calls.length === 1, "the run's stream");
    const handle = x.reader.ctx!.addMessage('courier', [text('LATE RESULT')], { note: 'kept' }, { forAgent: 'worker' });
    assert.match(handle, /^held:/, "the premise: held for the run's turn");
    // The primary's turn is alive as the run ends: the write waits for it.
    internals.activeTurnTokens.set('prime', Symbol('turn'));
    release();
  });
  try {
    const late = x.reader.ctx!.queryMessages({}).messages.find((msg) => texts({ messages: [msg] })[0] === 'LATE RESULT');
    assert.ok(late?.held, "held for the primary's turn");
    assert.equal(late!.participant, 'courier', 'as the module wrote it, not as a notice');
    assert.equal((late!.metadata as Record<string, unknown>).note, 'kept');
    assert.equal((late!.metadata as Record<string, unknown>).primaryIfUnread, undefined, 'the mark taken off');
  } finally {
    internals.activeTurnTokens.delete('prime');
  }
  // At the primary's boundary it lands in the primary's store.
  (x.framework as unknown as { readdDrained(d: unknown[], w: string): unknown }).readdDrained(
    (x.framework as unknown as { drainDeferredFor(n: string): unknown[] }).drainDeferredFor('prime'), 'test boundary');
  assert.ok(primaryTexts(x).includes('LATE RESULT'), JSON.stringify(primaryTexts(x)));
});

test("a module's write injected into an ephemeral run's stream at a tool round that declares it carries injections stays in the run's store only", async () => {
  const x = await make();
  x.membrane.supportsInjectedMessages = true;
  x.membrane.pushResponse(deliver({ for: 'worker' }));
  x.membrane.pushResponse(createMockResponse([text('done')]));
  const own = await runWorker(x, 'worker');
  const injected = x.membrane.lastStream!.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
  assert.ok(injected.some((msg) => JSON.stringify(msg.content).includes('RESULT FOR worker')), "the premise: the run's stream carried it");
  assert.ok(own.includes('RESULT FOR worker'), JSON.stringify(own));
  assert.ok(!primaryTexts(x).includes('RESULT FOR worker'), "not in the primary's");
});

test("a module's write a run's compile sent counts as read, so it stays the run's, though the run ends with no tool round", async () => {
  const x = await make();
  x.membrane.pushResponse(createMockResponse([text('done')]));
  const own = await runWorker(x, 'worker', async () => {
    // Registered, with no turn of its yet: stored at once, before its compile.
    const id = x.reader.ctx!.addMessage('courier', [text('BEFORE ITS COMPILE')], undefined, { forAgent: 'worker' });
    assert.ok(id && !id.startsWith('held:'), 'the premise: stored, not held');
    assert.equal((x.reader.ctx!.queryMessages({}, { forAgent: 'worker' }).messages.find((m) => m.id === id)!.metadata as Record<string, unknown>).primaryIfUnread, true,
      'the premise: stored with its mark');
  });
  const sent = x.membrane.calls[0]!.messages.map((msg) => texts({ messages: [msg] })[0]);
  assert.ok(sent.includes('BEFORE ITS COMPILE'), `the premise: its request carried it: ${JSON.stringify(sent)}`);
  assert.ok(own.includes('BEFORE ITS COMPILE'));
  assert.ok(!primaryTexts(x).includes('BEFORE ITS COMPILE'), "no copy for the primary");
});

test("on a stream that can't take injected messages (XML prefill), a module's write for the run waits for its end, and so goes to the primary", async () => {
  const x = await make();
  x.membrane.supportsInjectedMessages = false;
  x.membrane.pushResponse(deliver({ for: 'worker' }));
  x.membrane.pushResponse(createMockResponse([text('done')]));
  await runWorker(x, 'worker');
  const injected = x.membrane.lastStream!.receivedToolResultOptions.flatMap((o) => o?.injectedMessages ?? []);
  assert.deepEqual(injected, [], 'the premise: nothing joined the stream at its tool round');
  assert.ok(primaryTexts(x).includes('RESULT FOR worker'), JSON.stringify(primaryTexts(x)));
});

test("a module's write stored at a tool round whose tool ended the turn was never read, so it goes to the primary, a sharded body joined", async () => {
  const x = await make();
  x.membrane.supportsInjectedMessages = true;
  const long = 'LONGRESULT ' + Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ') + ' ENDOFRESULT';
  x.membrane.pushResponse(deliver({ for: 'worker', text: long, end: true }));
  const created = await x.framework.createEphemeralAgent({
    name: 'worker', model: 'test-model', systemPrompt: 'Test', strategy: new AutobiographicalStrategy({ adaptiveResolution: true, targetChunkTokens: 50 }),
  });
  created.contextManager.addMessage('user', [text('WORKER TASK')]);
  const run = x.framework.runEphemeralToCompletion(created.agent, created.contextManager);
  const processing = setInterval(() => { void x.framework.runUntilIdle(); }, 10);
  try { await run; } finally { clearInterval(processing); }
  const shards = created.contextManager.getAllMessages().filter((msg) => (msg.metadata as Record<string, unknown> | undefined)?.primaryIfUnread === true);
  assert.ok(shards.length > 1, `the premise: stored in the run's store as shards (${shards.length})`);
  created.cleanup();
  const passed = x.framework.getAgent('prime')!.getContextManager().getAllMessages()
    .filter((msg) => texts({ messages: [msg] })[0]!.includes('LONGRESULT') || texts({ messages: [msg] })[0]!.includes('ENDOFRESULT'));
  assert.equal(passed.length, 1, 'one message for the primary');
  assert.equal(passed[0]!.participant, 'courier', 'as the module wrote it');
  const blocks = passed[0]!.content.filter((b) => b.type === 'text');
  assert.equal(blocks.length, 1, 'the shards joined into one text, as later compiles render them');
  assert.equal((blocks[0] as { text: string }).text, long, 'byte for byte');
});

test("a run's held write queued again while its turn is alive keeps its mark, so it still reaches the primary", async () => {
  const x = await make();
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  x.membrane.streamYielding = ((request: never) => {
    x.membrane.calls.push(request);
    return new HeldStream(released, [createMockResponse([text('done')])]);
  }) as never;
  const internals = x.framework as unknown as {
    deferredMessages: Array<{ forAgent?: string; metadata?: Record<string, unknown> }>;
    readdDrained(d: unknown[], w: string): unknown;
    drainDeferredFor(n: string): unknown[];
  };
  await runWorker(x, 'worker', async () => {
    await until(() => x.membrane.calls.length === 1, "the run's stream");
    x.reader.ctx!.addMessage('courier', [text('REQUEUED')], undefined, { forAgent: 'worker' });
    // A flush while the run's turn is alive queues it again, from the queue.
    internals.readdDrained(internals.drainDeferredFor('worker'), 'test flush');
    assert.equal(internals.deferredMessages.find((m) => m.forAgent === 'worker')?.metadata?.primaryIfUnread, true, 'queued again with its mark');
    release();
  });
  assert.ok(primaryTexts(x).includes('REQUEUED'));
});

test("a conversation fork's write it never read reaches the primary when the fork is disposed; one its compile sent stays the fork's", async () => {
  const x = await make(['prime'], { conversations: { templateAgent: 'prime', bind: { channel: 'mention' } } });
  const internals = x.framework as unknown as {
    createConversationAgent(name: string, home: { serverId: string; channelId: string }): Promise<{ name: string }>;
    disposeConversationAgent(name: string): void;
    activeTurnTokens: Map<string, unknown>;
    pendingRequests: unknown[];
  };
  const fork = await internals.createConversationAgent('conversation-probe-g1', { serverId: 'stub', channelId: 'world:probe' });
  // Read: stored while the fork is idle, then sent by its next start's compile.
  x.reader.ctx!.addMessage('courier', [text('READ BY THE FORK')], undefined, { forAgent: fork.name });
  x.membrane.pushResponse(createMockResponse([text('fork reply')]));
  internals.pendingRequests.push({ agentName: fork.name, reason: 'timer', source: 'framework', timestamp: Date.now() });
  await x.framework.runUntilIdle();
  const sent = x.membrane.calls.at(-1)!.messages.map((msg) => texts({ messages: [msg] })[0]);
  assert.ok(sent.includes('READ BY THE FORK'), 'the premise: its compile sent it');
  // Unread, stored while the fork is idle and never sent.
  const stored = x.reader.ctx!.addMessage('courier', [text('STORED, NEVER SENT')], undefined, { forAgent: fork.name });
  const forkRows = () => x.reader.ctx!.queryMessages({}, { forAgent: fork.name }).messages;
  assert.equal((forkRows().find((m) => m.id === stored)!.metadata as Record<string, unknown>).primaryIfUnread, true, 'stored with its mark');
  // Unread, held for a turn that never takes it.
  internals.activeTurnTokens.set(fork.name, Symbol('turn'));
  const handle = x.reader.ctx!.addMessage('courier', [text('NEVER READ')], undefined, { forAgent: fork.name });
  assert.match(handle, /^held:/);
  internals.activeTurnTokens.delete(fork.name);
  const forkWindow = x.framework.getAgent(fork.name)!.getContextManager();
  internals.disposeConversationAgent(fork.name);
  const count = (t: string) => primaryTexts(x).filter((msg) => msg === t).length;
  assert.equal(count('NEVER READ'), 1, JSON.stringify(primaryTexts(x)));
  assert.equal(count('STORED, NEVER SENT'), 1);
  assert.equal(count('READ BY THE FORK'), 0);
  const kept = forkWindow.getAllMessages().map((msg) => texts({ messages: [msg] })[0]);
  assert.ok(kept.includes('READ BY THE FORK'), "the one it read stays in the fork's window");
});

test("a write for an ordinary resident isn't marked, and a mark a module gives a write, stored or held, is taken off", async () => {
  const x = await make(['prime', 'helper']);
  x.reader.ctx!.addMessage('user', [text('FOR HELPER')], undefined, { forAgent: 'helper' });
  x.reader.ctx!.addMessage('user', [text('FOR THE PRIMARY')], { primaryIfUnread: true, note: 'kept' } as never);
  const rows = x.reader.ctx!.queryMessages({ participant: 'user' }).messages;
  const row = (t: string) => rows.find((msg) => texts({ messages: [msg] })[0] === t)!.metadata as Record<string, unknown> | undefined;
  assert.equal(row('FOR HELPER')?.primaryIfUnread, undefined);
  assert.equal(row('FOR THE PRIMARY')!.primaryIfUnread, undefined);
  assert.equal(row('FOR THE PRIMARY')!.note, 'kept');
  // Held for a busy resident, the queued entry has it taken off too.
  const internals = x.framework as unknown as { activeTurnTokens: Map<string, unknown>; deferredMessages: Array<{ forAgent?: string; metadata?: Record<string, unknown> }> };
  internals.activeTurnTokens.set('helper', Symbol('turn'));
  try {
    const handle = x.reader.ctx!.addMessage('user', [text('HELD')], { primaryIfUnread: true } as never, { forAgent: 'helper' });
    assert.match(handle, /^held:/);
    assert.equal(internals.deferredMessages.find((m) => m.forAgent === 'helper')!.metadata?.primaryIfUnread, undefined);
  } finally {
    internals.activeTurnTokens.delete('helper');
  }
});

test("a write through the framework's own addMessage, as a module's process response is, can't carry the mark", async () => {
  const x = await make();
  (x.framework as unknown as { addMessage(p: string, c: ContentBlock[], m?: unknown): string }).addMessage('user', [text('FROM A PROCESS')], { primaryIfUnread: true });
  const row = x.reader.ctx!.queryMessages({ participant: 'user' }).messages.find((msg) => texts({ messages: [msg] })[0] === 'FROM A PROCESS')!;
  assert.equal((row.metadata as Record<string, unknown> | undefined)?.primaryIfUnread, undefined);
});
