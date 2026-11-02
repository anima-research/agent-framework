/**
 * A module reads, edits and removes its writes by their stored ids, whether
 * or not the agent has been shown them yet (F198, #291). A write is stored at
 * once, whatever the agent's turn, and enters the agent's window at its next
 * presentation point; until then a module's reads mark it `held`, so a
 * Discord delete or edit before anyone is shown the message changes what the
 * agent is shown, and a history sync finds the row it already stored. These
 * run through the real ModuleContextImpl, keeping writes out of the window by
 * quiescing the host, which a live turn does too.
 *
 * Before #291 such a write waited in a deferred queue and the module was
 * answered a `held:` handle for it. For one release a handle a module kept
 * across the upgrade still reaches the row its write was stored as, which
 * the boot import of an earlier release's queue stores under the write's id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** The queue a release before #291 left beside the store, as its recovery file held it. */
function writeEarlierQueue(storePath: string, pending: unknown[]): void {
  mkdirSync(join(storePath, 'recovery'), { recursive: true });
  writeFileSync(join(storePath, 'recovery', 'deferred-writes.json'), JSON.stringify({ version: 2, pending }));
}

const present = (framework: AgentFramework): void =>
  (framework as unknown as { presentAtEndOf(agent: unknown): void }).presentAtEndOf(framework.getAgent('assistant'));

test('a module\'s write while quiesced is stored at once: addMessage answers its stored id, and getMessage and queryMessages answer its row, marked held until the agent is shown it', async () => {
  await withProbe(async ({ framework, ctx }) => {
    const storedId = ctx.addMessage('user', text('stored first'), external('s1'));
    assert.equal(
      (ctx.getState<{ externalIdMap: Record<string, string> }>()!).externalIdMap['probe:s1'],
      storedId,
      "a stored write's entry is its id",
    );
    await framework.quiesce({ reason: 'test' });
    const id = ctx.addMessage('user', text('held'), { external: { source: 'probe', id: 'h1' }, channelId: 'c1' } as never);
    assert.ok(id && !id.startsWith('held:'), `a stored id, not a handle: ${id}`);
    const cm = framework.getAgent('assistant')!.getContextManager();
    assert.ok(cm.getMessage(id as never), 'stored at once');

    const all = ctx.queryMessages({ source: 'probe' });
    assert.equal(all.totalCount, 2, "the store's count");
    const [stored, held] = all.messages as [ModuleMessage, ModuleMessage];
    assert.deepEqual([stored.id, held.id], [storedId, id], 'in store order, by their stored ids');
    assert.equal(stored.held, undefined, 'a row the window holds is not marked');
    assert.equal(held.held, true, "a row out of the agent's window is");
    assert.deepEqual(held.content, text('held'));
    assert.ok(held.sequence > stored.sequence);
    assert.deepEqual(ctx.getMessage(id), held);
    assert.deepEqual(ctx.queryMessages({ metadata: { 'external.id': 'h1' } }).messages.map((m) => m.id), [id]);
    assert.equal(ctx.findMessageByExternalId('probe', 'h1'), id);
    assert.equal(
      (ctx.getState<{ externalIdMap: Record<string, string> }>()!).externalIdMap['probe:h1'],
      id,
      'the persisted entry is the stored id',
    );

    await framework.resume();
    const shown = ctx.getMessage(id)!;
    assert.equal(shown.held, undefined, 'once the agent is shown it, it is not marked');
    assert.deepEqual(
      ctx.queryMessages({ source: 'probe' }).messages.map((m) => [m.id, m.held]),
      [[storedId, undefined], [id, undefined]],
    );
  });
});

test('a write during a live turn is answered by its stored id as well, marked held until the turn\'s end presents it', async () => {
  await withProbe(async ({ framework, ctx }) => {
    const turns = (framework as unknown as { activeTurnTokens: Map<string, number> }).activeTurnTokens;
    turns.set('assistant', 1);
    let id: string;
    try {
      id = ctx.addMessage('user', text('during a turn'));
      assert.ok(id && !id.startsWith('held:'), id);
      assert.equal(ctx.getMessage(id)?.held, true);
    } finally {
      turns.delete('assistant');
    }
    present(framework);
    assert.equal(ctx.getMessage(id)?.held, undefined);
  });
});

test('removing a write before the agent is shown it takes it out of the store, and editing one changes what the agent is shown', async () => {
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
    const cm = framework.getAgent('assistant')!.getContextManager();
    const shown = (rows: Array<{ content: ContentBlock[] }>) =>
      rows.map(textOf).filter((t) => ['taken back', 'as first sent', 'as edited'].includes(t));
    assert.deepEqual(shown(cm.getAllMessages()), ['as edited'], 'the store');
    assert.deepEqual(shown(cm.getPresentedMessages()), ['as edited'], 'and the window');
  });
});

test("a process answer's removals and edits reach a write the agent isn't shown yet too", async () => {
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
    const texts = framework.getAgent('assistant')!.getContextManager().getPresentedMessages().map(textOf);
    assert.deepEqual(
      texts.filter((t) => t.startsWith('the answer')),
      ['the answer edited'],
    );
  });
});

test('for one release, the held: handle an earlier release answered reaches the row the boot import stored its write as', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  await (await open(storePath)).framework.stop();
  writeEarlierQueue(storePath, [{ id: 'w1', seq: 1, participant: 'user', content: text('queued before the upgrade') }]);
  const probe = await open(storePath);
  try {
    const { framework, ctx } = probe;
    const handle = 'held:w1';
    const cm = framework.getAgent('assistant')!.getContextManager();
    const row = ctx.getMessage(handle);
    assert.ok(row && !row.id.startsWith('held:'), 'the handle names the stored row');
    assert.equal(textOf(row), 'queued before the upgrade');
    ctx.editMessage(handle, text('edited by its handle'));
    assert.equal(textOf(cm.getMessage(row.id)!), 'edited by its handle');
    ctx.removeMessage(handle);
    assert.equal(cm.getMessage(row.id), null);
    assert.equal(ctx.getMessage(handle), null, 'and nothing once its row is gone');
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withImportedW1(run: (probe: Probe, cm: {
  queryMessages(...args: unknown[]): unknown;
  getMessageWindow(offset: number, limit: number, opts?: { resolveBlobs?: boolean }): { messages: unknown[] };
}) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  await (await open(storePath)).framework.stop();
  writeEarlierQueue(storePath, [{ id: 'w1', seq: 1, participant: 'user', content: text('queued before the upgrade') }]);
  const probe = await open(storePath);
  const cm = probe.framework.getAgent('assistant')!.getContextManager() as unknown as Parameters<typeof run>[1];
  const query = cm.queryMessages;
  const read = cm.getMessageWindow;
  cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
  try {
    run(probe, cm);
  } finally {
    cm.queryMessages = query;
    cm.getMessageWindow = read;
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a held: handle reaches the row its write landed as by a blob-free scan when context-manager's query throws, as a blob missing from another message makes it throw", async () => {
  await withImportedW1(({ ctx }) => {
    const row = ctx.getMessage('held:w1');
    assert.ok(row && !row.id.startsWith('held:'), 'the stored row');
    assert.equal(textOf(row), 'queued before the upgrade');
  });
});

test("a held: handle whose blob-free scan comes back short throws that the store can't be searched, rather than naming nothing", async () => {
  await withImportedW1(({ ctx }, cm) => {
    const read = cm.getMessageWindow;
    cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
      const window = read.call(this, offset, limit, opts);
      return opts?.resolveBlobs === false ? { ...window, messages: window.messages.slice(1) } : window;
    };
    assert.throws(() => ctx.getMessage('held:w1'),
      /couldn't be searched for deferred write w1: its query threw \(Blob not found: 0123\), and then the store gave/);
  });
});

test("a write whose metadata a module copied from an imported row doesn't carry the framework's deferredWriteId, so a handle never names the copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  await (await open(storePath)).framework.stop();
  writeEarlierQueue(storePath, [{ id: 'c1', seq: 1, participant: 'user', content: text('the original'), metadata: { external: { source: 'probe', id: 'c1' } } }]);
  const probe = await open(storePath);
  try {
    const { ctx } = probe;
    const handle = 'held:c1';
    const original = ctx.getMessage(handle)!;
    assert.equal(original.metadata?.deferredWriteId, 'c1');
    const copy = ctx.addMessage('user', text('a copy'), { ...original.metadata } as never);
    assert.equal(ctx.getMessage(copy)!.metadata?.deferredWriteId, undefined, 'the copy is stored without it');
    ctx.removeMessage(original.id);
    assert.equal(ctx.getMessage(handle), null, 'the handle names nothing once its row is gone');
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a handle whose write was never stored names nothing, as an unknown id does', async () => {
  await withProbe(async ({ ctx }) => {
    const handle = 'held:never-stored';
    assert.equal(ctx.getMessage(handle), null);
    assert.throws(() => ctx.editMessage(handle, text('too late')), notFound(handle));
    assert.throws(() => ctx.removeMessage(handle), notFound(handle));
    assert.equal(ctx.getMessage(42 as never), null, 'an id that is not a string answers as before');
  });
});

test("an external id's entry of '' that an earlier release left is looked up in the store and repaired, and one with nothing stored answers null", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  let probe = await open(storePath);
  try {
    const stored = probe.ctx.addMessage('user', text('landed'), external('e1'));
    await probe.framework.stop();

    // What an earlier release left: '' in the module's state for each write
    // it held, whether it had landed since (e1), was still queued (e2, in its
    // queue's record), or was taken back (gone).
    const store = JsStore.openOrCreate({ path: storePath });
    const stateId = 'modules/probe/state';
    const state = (store.getStateJson(stateId) ?? {}) as Record<string, unknown>;
    store.setStateJson(stateId, { ...state, externalIdMap: { 'probe:e1': '', 'probe:e2': '', 'probe:gone': '' } });
    store.close();
    writeEarlierQueue(storePath, [{ id: 'q2', seq: 1, participant: 'user', content: text('still queued'), metadata: { external: { source: 'probe', id: 'e2' } } }]);

    probe = await open(storePath);
    const { ctx } = probe;
    assert.deepEqual(
      ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap,
      { 'probe:e1': '', 'probe:e2': '', 'probe:gone': '' },
      'the entries as that release left them',
    );
    assert.equal(ctx.findMessageByExternalId('probe', 'e1'), stored);
    const imported = ctx.findMessageByExternalId('probe', 'e2');
    assert.ok(imported && !imported.startsWith('held:'), 'the queued write, stored at boot, by its stored id');
    assert.equal(textOf(ctx.getMessage(imported)!), 'still queued');
    assert.equal(ctx.findMessageByExternalId('probe', 'gone'), null);
    assert.deepEqual(
      ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap,
      { 'probe:e1': stored, 'probe:e2': imported, 'probe:gone': '' },
      "set to the stored id, and kept as '' with nothing found",
    );
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in a module's start(), a write an earlier release left queued isn't stored yet, so a lookup there answers null and keeps its entry, and finds the write once create() is done", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-held-writes-'));
  const storePath = join(dir, 'store');
  let probe = await open(storePath);
  try {
    await probe.framework.stop();
    const store = JsStore.openOrCreate({ path: storePath });
    const stateId = 'modules/probe/state';
    const state = (store.getStateJson(stateId) ?? {}) as Record<string, unknown>;
    store.setStateJson(stateId, { ...state, externalIdMap: { 'probe:b1': '' } });
    store.close();
    writeEarlierQueue(storePath, [{ id: 'q1', seq: 1, participant: 'user', content: text('held at the stop'), metadata: { external: { source: 'probe', id: 'b1' } } }]);

    const inStart: { found?: string | null; entry?: string } = {};
    probe = await open(storePath, {}, (ctx) => {
      inStart.found = ctx.findMessageByExternalId('probe', 'b1');
      inStart.entry = ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap['probe:b1'];
    });
    assert.deepEqual(inStart, { found: null, entry: '' }, 'create() imports the queue after start(), and the entry stays');
    const found = probe.ctx.findMessageByExternalId('probe', 'b1');
    assert.ok(found && !found.startsWith('held:'), 'its stored id once create() is done');
    assert.equal(textOf(probe.ctx.getMessage(found)!), 'held at the stop');
  } finally {
    await probe.framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lookup by external id doesn't answer the id of a row that's gone, whatever removed it", async () => {
  await withProbe(async ({ framework, ctx, module }) => {
    framework.start();
    await framework.quiesce({ reason: 'test' });
    const id = ctx.addMessage('user', text('stored while quiesced'), external('r1'));
    await framework.resume();
    assert.equal(ctx.findMessageByExternalId('probe', 'r1'), id, 'the entry is the stored id');
    // Removed through the context, by the id it answered.
    ctx.removeMessage(id);
    assert.equal(ctx.findMessageByExternalId('probe', 'r1'), null);

    // Removed by a process answer, which doesn't go through the context.
    const stored = ctx.addMessage('user', text('stored'), external('r2'));
    module.answer = { removeMessages: [stored] };
    ctx.pushEvent({ type: 'module-event', source: 'probe', eventType: 'answer', payload: null });
    await waitFor('the answer to be applied', () => ctx.getMessage(stored) === null);
    assert.equal(ctx.findMessageByExternalId('probe', 'r2'), null);
  });
});

test('with two rows under one external id, a lookup answers the one its entry names, and an entry whose row is gone answers null', async () => {
  await withProbe(async ({ framework, ctx, module }) => {
    framework.start();
    const first = ctx.addMessage('user', text('stored first'), external('d1'));
    await framework.quiesce({ reason: 'test' });
    const second = ctx.addMessage('user', text('stored second, not shown yet'), external('d1'));
    assert.equal(ctx.findMessageByExternalId('probe', 'd1'), second, 'the entry names the newest write under the id');
    await framework.resume();
    // Once that row is gone the entry goes, though the first is still stored
    // under the external id.
    module.answer = { removeMessages: [second] };
    ctx.pushEvent({ type: 'module-event', source: 'probe', eventType: 'answer', payload: null });
    await waitFor('the answer to be applied', () => ctx.getMessage(second) === null);
    assert.equal(ctx.findMessageByExternalId('probe', 'd1'), null);
    assert.equal(ctx.getState<{ externalIdMap: Record<string, string> }>()!.externalIdMap['probe:d1'], undefined);
    assert.ok(ctx.getMessage(first), 'the first row stays');
  });
});

test("a module reading the primary's store sees a write stored for another ordinary resident, which shares it, marked held, and not one for an isolated agent's store", async () => {
  await withProbe(async ({ framework, ctx }) => {
    await framework.quiesce({ reason: 'test' });
    const add = (framework as unknown as {
      addMessage(p: string, c: ContentBlock[], m?: unknown, o?: { forAgent?: string }): string;
    }).addMessage.bind(framework);
    add('user', text('for shade'), undefined, { forAgent: 'shade' });
    add('user', text('for the subconscious'), undefined, { forAgent: 'Subconscious' });
    assert.deepEqual(ctx.queryMessages({}).messages.filter((m) => m.held).map(textOf), ['for shade'],
      "stored in the residents' slot, and not in scout's window");
  }, {
    agents: [
      { name: 'scout', model: 'test-model', systemPrompt: 'test' },
      { name: 'shade', model: 'test-model', systemPrompt: 'test' },
    ],
    subconscious: { enabled: true, systemPrompt: 'test' },
  });
});

test('a query reverses and cuts to its limit as the store does, over rows shown and not', async () => {
  await withProbe(async ({ framework, ctx }) => {
    const s1 = ctx.addMessage('user', text('s1'), external('s1'));
    const s2 = ctx.addMessage('user', text('s2'), external('s2'));
    await framework.quiesce({ reason: 'test' });
    const h1 = ctx.addMessage('user', text('h1'), external('h1'));
    const h2 = ctx.addMessage('user', text('h2'), external('h2'));
    // The context takes the store's query, which has `limit` and `reverse`.
    const query = (filter: MessageQuery) => ctx.queryMessages(filter as never);
    const newest = query({ source: 'probe', reverse: true, limit: 3 });
    assert.deepEqual(newest.messages.map((m) => [m.id, m.held]), [[h2, true], [h1, true], [s2, undefined]]);
    assert.equal(newest.totalCount, 4);
    assert.deepEqual(query({ source: 'probe', limit: 1 }).messages.map((m) => m.id), [s1]);
  });
});
