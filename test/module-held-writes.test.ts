/**
 * A module reads, edits and removes the writes the framework holds for it
 * (F198). addMessage holds a write while its agent's turn is alive or the
 * host is quiesced, and stores it at a later boundary. Before, the module's
 * context answered such a write's id as '', its queries didn't see it, and
 * its edits and removals threw "Message not found", so a Discord delete
 * during the hold left the message in the agent's history, an edit was
 * lost, and a history sync stored a second copy. These run through the real
 * ModuleContextImpl, holding writes by quiescing the host, which takes the
 * same branch of addMessage as a live turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import type { MessageQuery } from '@animalabs/context-manager';
import type { AgentConfig, EventResponse, Module, ModuleContext, ModuleMessage, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

class ProbeModule implements Module {
  readonly name = 'probe';
  ctx: ModuleContext | null = null;
  /** What onProcess answers to the next probe event. */
  answer: EventResponse = {};
  /** Runs inside start(), with the context. */
  onStart?: (ctx: ModuleContext) => void;
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.onStart?.(ctx);
  }
  async stop(): Promise<void> {
    this.ctx = null;
  }
  getTools(): ToolDefinition[] {
    return [];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: false, error: 'no tools', isError: true };
  }
  async onProcess(event: { type: string; source?: string }): Promise<EventResponse> {
    if (event.type !== 'module-event' || event.source !== 'probe') return {};
    const answer = this.answer;
    this.answer = {};
    return answer;
  }
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const textOf = (m: { content: ContentBlock[] }): string => (m.content[0] as { text: string }).text;
const external = (id: string) => ({ external: { source: 'probe', id } }) as never;

interface Probe {
  framework: AgentFramework;
  ctx: ModuleContext;
  module: ProbeModule;
}

async function open(
  storePath: string,
  extra: { agents?: AgentConfig[]; subconscious?: unknown } = {},
  onStart?: (ctx: ModuleContext) => void,
): Promise<Probe> {
  const module = new ProbeModule();
  module.onStart = onStart;
  const framework = await AgentFramework.create({
    storePath,
    membrane: new MockMembrane().asMembrane(),
    agents: extra.agents ?? [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [module],
    ...(extra.subconscious ? { subconscious: extra.subconscious } : {}),
  } as never);
  return { framework, ctx: module.ctx!, module };
}

async function withProbe(run: (probe: Probe & { storePath: string }) => Promise<void>, extra?: Parameters<typeof open>[1]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  const probe = await open(storePath, extra);
  try {
    await run({ ...probe, storePath });
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const notFound = (id: string) => (error: unknown) => error instanceof Error && error.message === `Message not found: ${id}`;

test('a module reads a held write: addMessage answers a handle, and getMessage and queryMessages answer its row, marked held, after the stored rows, until the write lands', async () => {
  await withProbe(async ({ framework, ctx }) => {
    const storedId = ctx.addMessage('user', text('stored first'), external('s1'));
    assert.ok(!storedId.startsWith('held:'), `a write that isn't held is stored: ${storedId}`);
    assert.equal(
      (ctx.getState<{ externalIdMap: Record<string, string> }>()!).externalIdMap['probe:s1'],
      storedId,
      "a stored write's entry is its id",
    );
    await framework.quiesce({ reason: 'test' });
    const before = Date.now();
    const handle = ctx.addMessage('user', text('held'), { external: { source: 'probe', id: 'h1' }, channelId: 'c1' } as never);
    const after = Date.now();
    assert.match(handle, /^held:./);

    const all = ctx.queryMessages({ source: 'probe' });
    assert.equal(all.totalCount, 2);
    const [stored, held] = all.messages as [ModuleMessage, ModuleMessage];
    assert.equal(stored.id, storedId);
    assert.equal(stored.held, undefined, 'a stored row is not marked');
    assert.equal(held.id, handle);
    assert.equal(held.held, true);
    assert.equal(held.participant, 'user');
    assert.deepEqual(held.content, text('held'));
    assert.equal((held.metadata?.external as { id: string }).id, 'h1');
    assert.ok(held.sequence > stored.sequence, 'after the stored rows');
    const heldAt = held.timestamp.getTime();
    assert.ok(heldAt >= before && heldAt <= after, 'the time the write was held');
    const again = ctx.queryMessages({ source: 'probe' }).messages[1]!;
    assert.deepEqual([again.sequence, again.timestamp.getTime()], [held.sequence, heldAt], 'the same on every read');
    assert.deepEqual(ctx.getMessage(handle), held);

    // A filter applies to held rows as to stored ones.
    assert.deepEqual(ctx.queryMessages({ source: 'probe', externalIds: ['s1'] }).messages.map((m) => m.id), [storedId]);
    assert.deepEqual(ctx.queryMessages({ metadata: { 'external.id': 'h1' } }).messages.map((m) => m.id), [handle]);
    assert.deepEqual(ctx.queryMessages({ participant: 'someone else' }).messages, []);
    assert.equal(ctx.findMessageByExternalId('probe', 'h1'), handle);
    assert.equal(
      (ctx.getState<{ externalIdMap: Record<string, string> }>()!).externalIdMap['probe:h1'],
      '',
      'the persisted entry keeps the \'\' an earlier release can read back, not the handle',
    );

    await framework.resume();
    const landed = ctx.getMessage(handle);
    assert.ok(landed && !landed.id.startsWith('held:'), 'once the write lands, the handle names its stored row');
    assert.equal(landed.held, undefined);
    assert.deepEqual(landed.content, text('held'));
    assert.deepEqual(
      ctx.queryMessages({ source: 'probe' }).messages.map((m) => [m.id, m.held]),
      [[storedId, undefined], [landed.id, undefined]],
    );
    assert.equal(ctx.findMessageByExternalId('probe', 'h1'), landed.id);
    assert.equal(
      (ctx.getState<{ externalIdMap: Record<string, string> }>()!).externalIdMap['probe:h1'],
      landed.id,
      'the entry now holds the stored id',
    );
  });
});

test('a write held for a live turn is answered by a handle as well', async () => {
  await withProbe(async ({ framework, ctx }) => {
    const turns = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    turns.set('assistant', 1);
    try {
      const handle = ctx.addMessage('user', text('during a turn'));
      assert.match(handle, /^held:./);
      assert.equal(ctx.getMessage(handle)?.held, true);
    } finally {
      turns.delete('assistant');
    }
  });
});

test('removing a held write drops it, so it is never stored, and editing one stores it as edited', async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const gone = ctx.addMessage('user', text('taken back'));
    const kept = ctx.addMessage('user', text('as first sent'));
    ctx.removeMessage(gone);
    ctx.editMessage(kept, text('as edited'));
    assert.equal(ctx.getMessage(gone), null);
    assert.deepEqual(
      ctx.queryMessages({}).messages.filter((m) => m.held).map((m) => [m.id, textOf(m)]),
      [[kept, 'as edited']],
    );

    await framework.resume();
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages().map(textOf);
    assert.deepEqual(texts.filter((t) => ['taken back', 'as first sent', 'as edited'].includes(t)), ['as edited']);
  });
});

test("a process answer's removals and edits reach held writes too", async () => {
  await withProbe(async ({ framework, ctx, module }) => {
    framework.start();
    await framework.quiesce({ reason: 'test' });
    const gone = ctx.addMessage('user', text('the answer takes back'));
    const kept = ctx.addMessage('user', text('the answer edits'));
    module.answer = { removeMessages: [gone], editMessages: [{ messageId: kept, content: text('the answer edited') }] };
    ctx.pushEvent({ type: 'module-event', source: 'probe', eventType: 'answer', payload: null });
    await waitFor('the answer to be applied', () => ctx.getMessage(gone) === null);
    assert.equal(textOf(ctx.getMessage(kept)!), 'the answer edited');

    await framework.resume();
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages().map(textOf);
    assert.deepEqual(
      texts.filter((t) => t.startsWith('the answer')),
      ['the answer edited'],
    );
  });
});

test('once a held write has landed, an edit or removal by its handle reaches its stored row', async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const handle = ctx.addMessage('user', text('lands'));
    await framework.resume();
    const cm = framework.getAgent('assistant')!.getContextManager();
    const landedId = ctx.getMessage(handle)!.id;
    ctx.editMessage(handle, text('edited once it landed'));
    assert.equal(textOf(cm.getMessage(landedId)!), 'edited once it landed');
    ctx.removeMessage(handle);
    assert.equal(cm.getMessage(landedId), null);
    assert.equal(ctx.getMessage(handle), null);
  });
});

test("a write whose metadata a module copied from a stored row doesn't carry the framework's deferredWriteId, so a handle never names the copy", async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const handle = ctx.addMessage('user', text('the original'), external('c1'));
    await framework.resume();
    const original = ctx.getMessage(handle)!;
    assert.equal(typeof original.metadata?.deferredWriteId, 'string');
    const copy = ctx.addMessage('user', text('a copy'), { ...original.metadata } as never);
    assert.equal(ctx.getMessage(copy)!.metadata?.deferredWriteId, undefined, 'the copy is stored without it');
    ctx.removeMessage(original.id);
    assert.equal(ctx.getMessage(handle), null, 'the handle names nothing once its row is gone');
  });
});

test('a handle whose write is gone names nothing, as an unknown id does', async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const handle = ctx.addMessage('user', text('gone'));
    ctx.removeMessage(handle);
    assert.equal(ctx.getMessage(handle), null);
    assert.throws(() => ctx.editMessage(handle, text('too late')), notFound(handle));
    assert.throws(() => ctx.removeMessage(handle), notFound(handle));
    assert.equal(ctx.getMessage(42 as never), null, 'an id that is not a string answers as before');
  });
});

test("an external id's entry of '' that a release before handles left is looked up in the store and repaired, and one with nothing stored answers null", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  let probe = await open(storePath);
  try {
    const stored = probe.ctx.addMessage('user', text('landed'), external('e1'));
    await probe.framework.quiesce({ reason: 'test' });
    const handle = probe.ctx.addMessage('user', text('still held'), external('e2'));
    await probe.framework.stop();

    // What a release before handles left in the module's state: '' for
    // each write it held, whether it has landed since (e1), is still held
    // (e2), or was taken back (gone).
    const store = JsStore.openOrCreate({ path: storePath });
    const stateId = 'modules/probe/state';
    const state = (store.getStateJson(stateId) ?? {}) as Record<string, unknown>;
    store.setStateJson(stateId, { ...state, externalIdMap: { 'probe:e1': '', 'probe:e2': '', 'probe:gone': '' } });
    store.close();

    probe = await open(storePath);
    const { ctx } = probe;
    assert.deepEqual(
      ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap,
      { 'probe:e1': '', 'probe:e2': '', 'probe:gone': '' },
      'the entries as that release left them',
    );
    assert.equal(ctx.findMessageByExternalId('probe', 'e1'), stored);
    assert.equal(ctx.findMessageByExternalId('probe', 'e2'), handle, 'a held write answers its handle, which a restart keeps');
    assert.equal(ctx.findMessageByExternalId('probe', 'gone'), null);
    assert.deepEqual(
      ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap,
      { 'probe:e1': stored, 'probe:e2': '', 'probe:gone': '' },
      'set to the stored id, and kept as \'\' while held or with nothing found',
    );

    await probe.framework.resume();
    const landed = ctx.findMessageByExternalId('probe', 'e2');
    assert.ok(landed && !landed.startsWith('held:'));
    assert.equal(textOf(ctx.getMessage(landed)!), 'still held');
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in a module's start(), a write the last process held doesn't show yet, so a lookup there answers null and keeps its entry, and finds the write once create() is done", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  let probe = await open(storePath);
  try {
    await probe.framework.quiesce({ reason: 'test' });
    const handle = probe.ctx.addMessage('user', text('held at the stop'), external('b1'));
    await probe.framework.stop();

    const inStart: { found?: string | null; entry?: string } = {};
    probe = await open(storePath, {}, (ctx) => {
      inStart.found = ctx.findMessageByExternalId('probe', 'b1');
      inStart.entry = ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap['probe:b1'];
    });
    assert.deepEqual(inStart, { found: null, entry: '' }, 'create() restores the queue after start(), and the entry stays');
    assert.equal(probe.ctx.findMessageByExternalId('probe', 'b1'), handle, 'the held write, once create() is done');
    await probe.framework.resume();
    const landed = probe.ctx.findMessageByExternalId('probe', 'b1');
    assert.ok(landed && !landed.startsWith('held:'), 'its stored id once it lands');
    assert.equal(textOf(probe.ctx.getMessage(landed)!), 'held at the stop');
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lookup by external id doesn't answer the id of a row that's gone, whatever removed it", async () => {
  await withProbe(async ({ framework, ctx, module }) => {
    framework.start();
    await framework.quiesce({ reason: 'test' });
    const handle = ctx.addMessage('user', text('held, then stored'), external('r1'));
    await framework.resume();
    const landed = ctx.findMessageByExternalId('probe', 'r1');
    assert.ok(landed && !landed.startsWith('held:'), 'the entry is set to the stored id');
    // Removed through the handle the module kept, which names that row.
    ctx.removeMessage(handle);
    assert.equal(ctx.findMessageByExternalId('probe', 'r1'), null);

    // Removed by a process answer, which doesn't go through the context.
    const stored = ctx.addMessage('user', text('stored'), external('r2'));
    module.answer = { removeMessages: [stored] };
    ctx.pushEvent({ type: 'module-event', source: 'probe', eventType: 'answer', payload: null });
    await waitFor('the answer to be applied', () => ctx.getMessage(stored) === null);
    assert.equal(ctx.findMessageByExternalId('probe', 'r2'), null);
  });
});

test('with two rows under one external id, a lookup for a held write answers the first, and an entry whose row is gone answers null', async () => {
  await withProbe(async ({ framework, ctx, module }) => {
    framework.start();
    const first = ctx.addMessage('user', text('stored first'), external('d1'));
    await framework.quiesce({ reason: 'test' });
    const second = ctx.addMessage('user', text('held second'), external('d1'));
    assert.equal(ctx.findMessageByExternalId('probe', 'd1'), first, 'while the second is held');
    await framework.resume();
    assert.ok(!ctx.getMessage(second)!.id.startsWith('held:'), 'the second has landed');
    assert.equal(ctx.findMessageByExternalId('probe', 'd1'), first, 'once the second has landed');
    // The entry names the first row now, and once that row is gone the entry
    // goes, though the second is still stored under the external id.
    module.answer = { removeMessages: [first] };
    ctx.pushEvent({ type: 'module-event', source: 'probe', eventType: 'answer', payload: null });
    await waitFor('the answer to be applied', () => ctx.getMessage(first) === null);
    assert.equal(ctx.findMessageByExternalId('probe', 'd1'), null);
    assert.equal(ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap['probe:d1'], undefined);
  });
});

test("a module sees the writes held for every ordinary resident, which share its store, and not those held for an isolated one's", async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const add = (framework as unknown as {
      addMessage(p: string, c: ContentBlock[], m?: unknown, o?: { forAgent?: string }): string;
    }).addMessage.bind(framework);
    add('user', text('for shade'), undefined, { forAgent: 'shade' });
    add('user', text('for the subconscious'), undefined, { forAgent: 'Subconscious' });
    assert.equal(framework.getHostModeStatus().deferredWrites, 2, 'both writes are held');
    assert.deepEqual(ctx.queryMessages({}).messages.filter((m) => m.held).map(textOf), ['for shade']);
  }, {
    agents: [
      { name: 'scout', model: 'test-model', systemPrompt: 'test' },
      { name: 'shade', model: 'test-model', systemPrompt: 'test' },
    ],
    subconscious: { enabled: true, systemPrompt: 'test' },
  });
});

test('edits and removals of held writes reach the persisted queue, so a restart finds them as the module left them, with the time each was held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  let probe = await open(storePath);
  try {
    await probe.framework.quiesce({ reason: 'test' });
    const gone = probe.ctx.addMessage('user', text('taken back'));
    const kept = probe.ctx.addMessage('user', text('as first sent'));
    const heldAt = probe.ctx.getMessage(kept)!.timestamp.getTime();
    // What a crash leaves after each: the queue file as it stands.
    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const queued = () => (JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ content: ContentBlock[] }> }).pending.map(textOf);
    probe.ctx.removeMessage(gone);
    assert.deepEqual(queued(), ['as first sent'], 'the removal reaches the file');
    probe.ctx.editMessage(kept, text('as edited'));
    assert.deepEqual(queued(), ['as edited'], 'and so does the edit');
    await probe.framework.stop();

    probe = await open(storePath);
    const { ctx } = probe;
    assert.deepEqual(ctx.queryMessages({}).messages.filter((m) => m.held).map((m) => [m.id, textOf(m)]), [[kept, 'as edited']]);
    assert.equal(ctx.getMessage(kept)!.timestamp.getTime(), heldAt, 'the time it was first held, kept with the queue');

    await probe.framework.resume();
    const texts = probe.framework.getAgent('assistant')!.getContextManager().getAllMessages().map(textOf);
    assert.deepEqual(texts.filter((t) => ['taken back', 'as first sent', 'as edited'].includes(t)), ['as edited']);
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while a live turn holds a write in a queue that is persisted, an edit or removal of it reaches the file', async () => {
  await withProbe(async ({ framework, ctx, storePath }) => {
    await framework.quiesce({ reason: 'test' });
    const kept = ctx.addMessage('user', text('held for the turn'));
    const gone = ctx.addMessage('user', text('taken back'));
    // resume() flushes what no live turn holds, and keeps these for the turn.
    const turns = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    turns.set('assistant', 1);
    try {
      await framework.resume();
      assert.equal(framework.getHostModeStatus().quiesced, false);
      assert.equal(framework.getHostModeStatus().deferredWrites, 2);
      const file = join(storePath, 'recovery', 'deferred-writes.json');
      const queued = () => (JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ content: ContentBlock[] }> }).pending.map(textOf);
      ctx.removeMessage(gone);
      assert.deepEqual(queued(), ['held for the turn']);
      ctx.editMessage(kept, text('edited in the turn'));
      assert.deepEqual(queued(), ['edited in the turn']);
    } finally {
      turns.delete('assistant');
    }
  });
});

test('a held write that a queue written before held times has no time for, or a time that is no time, reads as held when the queue was read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  let probe = await open(storePath);
  try {
    await probe.framework.quiesce({ reason: 'test' });
    for (const t of ['no time', 'not a time', 'past a Date', 'before a Date', 'its own time']) probe.ctx.addMessage('user', text(t));
    await probe.framework.stop();

    const file = join(storePath, 'recovery', 'deferred-writes.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<Record<string, unknown>> };
    const own = doc.pending[4]!.heldAt;
    assert.equal(typeof own, 'number');
    delete doc.pending[0]!.heldAt;
    doc.pending[1]!.heldAt = 'yesterday';
    // A Date holds times within 8.64e15 ms of the epoch, either side.
    doc.pending[2]!.heldAt = 9e15;
    doc.pending[3]!.heldAt = -9e15;
    writeFileSync(file, JSON.stringify(doc));

    const before = Date.now();
    probe = await open(storePath);
    const after = Date.now();
    const times = probe.ctx.queryMessages({}).messages.filter((m) => m.held).map((m) => [textOf(m), m.timestamp.getTime()] as const);
    assert.equal(times.length, 5);
    for (const [t, time] of times.slice(0, 4)) assert.ok(time >= before && time <= after, `${t}: read back at boot, not ${time}`);
    assert.deepEqual(times[4], ['its own time', own]);
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held write that goes back into the queue keeps the time it was first held', async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const handle = ctx.addMessage('user', text('held twice'));
    const heldAt = ctx.getMessage(handle)!.timestamp.getTime();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A drain whose write is held again, as a turn-end flush is when a
    // successor turn has begun: here the host is still quiesced.
    const internals = framework as unknown as {
      drainDeferredFor(agentName: string): unknown[];
      readdDrained(entries: unknown[], where: string): unknown[];
    };
    internals.readdDrained(internals.drainDeferredFor('assistant'), 'test');
    const row = ctx.getMessage(handle)!;
    assert.equal(row.held, true);
    assert.equal(row.timestamp.getTime(), heldAt);
  });
});

test('a query over stored and held rows reverses and cuts to its limit as the store does', async () => {
  await withProbe(async ({ framework, ctx }) => {
    const s1 = ctx.addMessage('user', text('s1'), external('s1'));
    const s2 = ctx.addMessage('user', text('s2'), external('s2'));
    await framework.quiesce({ reason: 'test' });
    const h1 = ctx.addMessage('user', text('h1'), external('h1'));
    const h2 = ctx.addMessage('user', text('h2'), external('h2'));
    // The context takes the store's query, which has `limit` and `reverse`.
    const query = (filter: MessageQuery) => ctx.queryMessages(filter as never);
    const newest = query({ source: 'probe', reverse: true, limit: 3 });
    assert.deepEqual(newest.messages.map((m) => m.id), [h2, h1, s2]);
    assert.equal(newest.totalCount, 4);
    assert.deepEqual(query({ source: 'probe', limit: 1 }).messages.map((m) => m.id), [s1]);
  });
});

test("held rows match a filter as context-manager's own query matches stored rows", async () => {
  await withProbe(async ({ framework, ctx }) => {
    const cm = framework.getAgent('assistant')!.getContextManager();
    const rows: Array<[string, Record<string, unknown> | undefined]> = [
      ['alice', { external: { source: 'discord', id: 'm1' }, channelId: 'c1', nested: { a: { b: 1 } } }],
      ['bob', { external: { source: 'discord', id: 'm2' }, channelId: 'c2' }],
      ['alice', { external: { source: 'slack', id: '' } }],
      ['carol', { flag: null, zero: 0, external: 'not an object' }],
      ['dave', undefined],
    ];
    const filters: MessageQuery[] = [
      {},
      { source: 'discord' },
      { source: 'slack' },
      { externalIds: [] },
      { externalIds: ['m1', 'm2'] },
      { externalIds: [''] },
      { participant: 'alice' },
      { source: 'discord', participant: 'bob' },
      { metadata: { channelId: 'c1' } },
      { metadata: { 'nested.a.b': 1 } },
      { metadata: { 'nested.a': { b: 1 } } },
      { metadata: { flag: null } },
      { metadata: { zero: 0 } },
      { metadata: { missing: undefined } },
      { metadata: { 'external.source': 'discord', channelId: 'c2' } },
      { metadata: { 'external.length': 12 } },
    ];
    // Held: the module's query matches the held rows.
    await framework.quiesce({ reason: 'test' });
    const handles = rows.map(([participant, metadata], i) => ctx.addMessage(participant, text(`row ${i}`), metadata as never));
    assert.ok(handles.every((handle) => ctx.getMessage(handle)!.held === true), 'premise: every row is held');
    const held = filters.map((filter) => ctx.queryMessages(filter as never).messages.map(textOf));
    // Stored: the same rows, written once the host resumes, through context-manager's own query.
    await framework.resume();
    assert.equal(cm.getAllMessages().filter((m) => textOf(m).startsWith('row ')).length, rows.length, 'premise: every row is stored');
    filters.forEach((filter, i) => {
      assert.deepEqual(held[i], cm.queryMessages(filter).messages.map(textOf), JSON.stringify(filter));
    });
  });
});
