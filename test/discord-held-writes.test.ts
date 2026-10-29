/**
 * The Discord module over writes the framework holds (F198, with #516's
 * record of the creates on their way). The framework holds a module's writes
 * while the agent's turn is alive or the host is quiesced, and a module's
 * reads now see them, marked held, and its edits and removals reach them. So
 * a message deleted while its create is held is never stored, one edited
 * then is stored as edited, a sync's held add keeps a live create from
 * adding a second copy, and a create whose write hasn't landed ends its
 * record once its row shows, so a sync no longer passes over the message.
 * The module runs in a real framework, which holds its writes by quiescing
 * the host, the same branch of addMessage a live turn takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ModuleMessage, ToolDefinition, ToolResult } from '../src/index.js';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface, DiscordMessageData, HistoryMessage } from '../src/modules/discord/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** The Discord side: the module's handlers, and the history a sync fetches. */
class FakeDiscord {
  onMessageHandler: ((message: DiscordMessageData) => Promise<void>) | null = null;
  onEditHandler: ((id: string, content: string) => void) | null = null;
  onDeleteHandler: ((id: string) => void) | null = null;
  history: HistoryMessage[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  getBotUserId(): string { return 'bot'; }
  onMessage(handler: (message: DiscordMessageData) => Promise<void>): void { this.onMessageHandler = handler; }
  onMessageEdit(handler: (id: string, content: string) => void): void { this.onEditHandler = handler; }
  onMessageDelete(handler: (id: string) => void): void { this.onDeleteHandler = handler; }
  async fetchHistory(): Promise<HistoryMessage[]> { return [...this.history].reverse(); }
  async sendTyping(): Promise<void> {}
}

/** A second module, to read the store through a module's context. */
class Reader implements Module {
  readonly name = 'reader';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

interface DiscordInternals {
  syncChannelHistory(channelId: string): Promise<{ newMessages: number; editedMessages: number; deletedMessages: number }>;
  creating: Map<string, { phase: string }>;
}

function live(id: string, content: string): DiscordMessageData {
  return {
    id, channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User', isBot: false, content,
    isReply: false, mentionedUserIds: [], attachments: [], timestamp: new Date(1_000),
  };
}

function history(id: string, content: string): HistoryMessage {
  return { id, authorId: 'u1', authorName: 'User', isBot: false, content, timestamp: new Date(1_000), attachments: [] };
}

const textOf = (m: { content: ContentBlock[] }): string => (m.content[0] as { text: string }).text;

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withDiscord(
  run: (s: { framework: AgentFramework; discord: FakeDiscord; module: DiscordInternals; rows: (id: string) => ModuleMessage[] }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'discord-held-writes-'));
  const discord = new FakeDiscord();
  const module = new DiscordModule(discord as unknown as DiscordClientInterface, { token: 't', autoTyping: false });
  const reader = new Reader();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'Sol', model: 'test-model', systemPrompt: 'test' }],
    modules: [module, reader],
  });
  try {
    framework.start();
    await framework.quiesce({ reason: 'test' });
    const rows = (id: string) => reader.ctx!.queryMessages({ source: 'discord', externalIds: [id] }).messages;
    await run({ framework, discord, module: module as unknown as DiscordInternals, rows });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const storedTexts = (framework: AgentFramework, id: string): string[] =>
  framework.getAgent('Sol')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata?.external as { id?: string } | undefined)?.id === id)
    .map(textOf);

test('a message deleted while its create is held is never stored', async () => {
  await withDiscord(async ({ framework, discord, rows }) => {
    await discord.onMessageHandler!(live('m1', 'taken back'));
    await waitFor('the create to be held', () => rows('m1').length === 1);
    assert.equal(rows('m1')[0]!.held, true);
    discord.onDeleteHandler!('m1');
    await waitFor('the delete to reach the held write', () => rows('m1').length === 0);
    await framework.resume();
    assert.deepEqual(storedTexts(framework, 'm1'), []);
  });
});

test('a message edited while its create is held is stored as edited', async () => {
  await withDiscord(async ({ framework, discord, rows }) => {
    await discord.onMessageHandler!(live('m2', 'before'));
    await waitFor('the create to be held', () => rows('m2').length === 1);
    discord.onEditHandler!('m2', 'after');
    await waitFor('the edit to reach the held write', () => textOf(rows('m2')[0]!) === 'after');
    await framework.resume();
    assert.deepEqual(storedTexts(framework, 'm2'), ['after']);
  });
});

test("a live create that comes after a sync's held add of its message adds no second copy", async () => {
  await withDiscord(async ({ framework, discord, module, rows }) => {
    discord.history = [history('m3', 'seen by the sync first')];
    assert.equal((await module.syncChannelHistory('c1')).newMessages, 1);
    assert.equal(rows('m3')[0]?.held, true, "the sync's add is held");
    await discord.onMessageHandler!(live('m3', 'seen by the sync first'));
    await waitFor('the create to be answered', () => module.creating.get('m3')?.phase === 'writing');
    // The framework takes Discord events in order and applies each answer
    // before the next, so once the next message's row shows, the create's
    // answer has been applied.
    await discord.onMessageHandler!(live('m3b', 'the next message'));
    await waitFor('the next create to be held', () => rows('m3b').length === 1);
    assert.equal(rows('m3').length, 1);
    await framework.resume();
    assert.deepEqual(storedTexts(framework, 'm3'), ['seen by the sync first']);
  });
});

test("a create whose write hasn't landed ends its record once its held row shows, so a sync then reaches the message", async () => {
  await withDiscord(async ({ discord, module, rows }) => {
    await discord.onMessageHandler!(live('m4', 'as sent'));
    await waitFor('the create to be held', () => rows('m4').length === 1);
    // The next Discord event ends the entries whose row the store shows.
    await discord.onMessageHandler!(live('m5', 'another message'));
    await waitFor('the next create to be held', () => rows('m5').length === 1);
    assert.equal(module.creating.has('m4'), false, 'the held row ends the record');
    // An edit the live path missed: the sync brings it to the held write,
    // where it adds no copy.
    discord.history = [history('m4', 'edited while offline'), history('m5', 'another message')];
    const synced = await module.syncChannelHistory('c1');
    assert.deepEqual([synced.newMessages, synced.editedMessages], [0, 1]);
    assert.deepEqual(rows('m4').map((m) => [m.held, textOf(m)]), [[true, 'edited while offline']]);
  });
});

type Hold = 'a branch move holding the store' | "the primary's recovery wait";

async function withKeptCreate(
  hold: Hold,
  run: (s: { framework: AgentFramework; discord: FakeDiscord; processed: (type: string, id: string) => Promise<void>; kept: () => number; texts: (id: string) => string[] }) => Promise<void>,
  options: { triggerOn?: 'all'; modules?: Module[]; membrane?: MockMembrane } = {},
): Promise<{ framework: AgentFramework; texts: (id: string) => string[]; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kept-create-'));
  const discord = new FakeDiscord();
  const module = new DiscordModule(discord as unknown as DiscordClientInterface, { token: 't', autoTyping: false, ...(options.triggerOn ? { triggerOn: options.triggerOn } : {}) });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: (options.membrane ?? new MockMembrane()).asMembrane(),
    agents: [{ name: 'Sol', model: 'test-model', systemPrompt: 'test' }],
    modules: [module, ...(options.modules ?? [])],
  });
  const cleanup = async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  const waiters: Array<{ type: string; id: string; done: () => void }> = [];
  framework.onTrace((event) => {
    if (event.type !== 'process:completed') return;
    const done = event.processEvent as { type: string; discordMessageId?: string };
    for (const w of waiters.splice(0)) {
      if (w.type === done.type && w.id === done.discordMessageId) w.done(); else waiters.push(w);
    }
  });
  const processed = (type: string, id: string) => new Promise<void>((done) => { waiters.push({ type, id, done }); });
  const released = new Promise<void>((done) => framework.onTrace((event) => {
    if (event.type === 'message:added' && event.source === 'surgery-release') done();
  }));
  const texts = (id: string) => framework.getAgent('Sol')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata?.external as { id?: string } | undefined)?.id === id)
    .map(textOf);
  const kept = () => framework.getHostModeStatus().deferredWrites;
  framework.start();
  const branch = framework.getStore().currentBranch().name;
  const strategy = framework.getAgent('Sol')!.getContextManager().getStrategy() as unknown as { initialize?: (...args: unknown[]) => Promise<void> };
  const initialize = strategy.initialize;
  const restore = () => { if (initialize) strategy.initialize = initialize; else delete strategy.initialize; };
  const quiet = console.error;
  try {
    if (hold === 'a branch move holding the store') {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      let reached!: () => void;
      const inMove = new Promise<void>((resolve) => { reached = resolve; });
      strategy.initialize = async function (this: unknown, ...args: unknown[]) { reached(); await gate; return initialize?.apply(this, args); };
      const move = framework.switchBranch(branch);
      await inMove;
      await run({ framework, discord, processed, kept, texts });
      open();
      await move;
    } else {
      strategy.initialize = async () => { throw new Error('zz-injected initialization failure'); };
      console.error = () => {};
      await framework.switchBranch(branch);
      restore();
      await run({ framework, discord, processed, kept, texts });
      console.error = quiet;
      await framework.switchBranch(branch);
    }
  } finally {
    console.error = quiet;
    restore();
  }
  await released;
  return { framework, texts, cleanup };
}

async function drained(framework: AgentFramework): Promise<void> {
  const marker = `zz-drained-${Math.random().toString(36).slice(2)}`;
  const seen = new Promise<void>((done) => framework.onTrace((event) => {
    if (event.type === 'process:completed' && (event.processEvent as { marker?: string }).marker === marker) done();
  }));
  (framework as unknown as { pushEvent(event: unknown): void }).pushEvent({ type: 'zz-drained', marker });
  await seen;
}

for (const hold of ['a branch move holding the store', "the primary's recovery wait"] as const) {
  test(`a message deleted while its create is kept in memory by ${hold} isn't stored once the hold releases`, async () => {
    const s = await withKeptCreate(hold, async ({ discord, processed, kept, texts }) => {
      const created = processed('discord:message', 'k1');
      await discord.onMessageHandler!(live('k1', 'taken back'));
      await created;
      assert.deepEqual([kept(), texts('k1')], [1, []], 'the create is kept in memory, not stored');
      const deleted = processed('discord:delete', 'k1');
      discord.onDeleteHandler!('k1');
      await deleted;
    });
    try {
      await drained(s.framework);
      assert.deepEqual(s.texts('k1'), [], 'the deleted message is not in the store');
    } finally {
      await s.cleanup();
    }
  });

  test(`a message edited while its create is kept in memory by ${hold} is stored as edited once the hold releases`, async () => {
    const s = await withKeptCreate(hold, async ({ discord, processed, kept, texts }) => {
      const created = processed('discord:message', 'k2');
      await discord.onMessageHandler!(live('k2', 'before'));
      await created;
      assert.deepEqual([kept(), texts('k2')], [1, []], 'the create is kept in memory, not stored');
      const edited = processed('discord:edit', 'k2');
      discord.onEditHandler!('k2', 'after');
      await edited;
    });
    try {
      await drained(s.framework);
      assert.deepEqual(s.texts('k2'), ['after'], 'the store holds the edited text');
    } finally {
      await s.cleanup();
    }
  });
}

test("a message deleted and then edited while its create is kept in memory isn't stored once the hold releases", async () => {
  const s = await withKeptCreate('a branch move holding the store', async ({ discord, processed, kept, texts }) => {
    const created = processed('discord:message', 'k8');
    await discord.onMessageHandler!(live('k8', 'taken back'));
    await created;
    assert.deepEqual([kept(), texts('k8')], [1, []], 'the create is kept in memory, not stored');
    const deleted = processed('discord:delete', 'k8');
    discord.onDeleteHandler!('k8');
    await deleted;
    const edited = processed('discord:edit', 'k8');
    discord.onEditHandler!('k8', 'taken back, unfurled');
    await edited;
  });
  try {
    await drained(s.framework);
    assert.deepEqual(s.texts('k8'), [], 'the deleted message is not in the store');
  } finally {
    await s.cleanup();
  }
});

class Holder implements Module {
  readonly name = 'holder';
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.open = resolve; });
  private enter!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.enter = resolve; });
  async start(): Promise<void> {}
  async stop(): Promise<void> { this.open(); }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(event: { type: string }): Promise<Record<string, never>> {
    if (event.type === 'zz-hold') { this.enter(); await this.gate; }
    return {};
  }
  release(): void { this.open(); }
}

for (const [change, kept, gone] of [['deleted', [], 'taken back'], ['edited', ['as edited'], 'as first sent']] as const) {
  test(`a message ${change} while its create is kept in memory reaches no turn's request in its earlier form, when an event is still being handled at the release`, async () => {
    const holder = new Holder();
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
    let requested!: () => void;
    const firstRequest = new Promise<void>((resolve) => { requested = resolve; });
    const stream = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request, options) => { requested(); return stream(request, options); };
    const s = await withKeptCreate('a branch move holding the store', async ({ framework, discord, processed, kept: held, texts }) => {
      const created = processed('discord:message', 'k5');
      await discord.onMessageHandler!(live('k5', gone));
      await created;
      assert.deepEqual([held(), texts('k5')], [1, []], 'the create is kept in memory, not stored');
      const changed = processed(change === 'deleted' ? 'discord:delete' : 'discord:edit', 'k5');
      if (change === 'deleted') discord.onDeleteHandler!('k5'); else discord.onEditHandler!('k5', 'as edited');
      await changed;
      framework.pushEvent({ type: 'zz-hold' } as never);
      await holder.entered;
    }, { triggerOn: 'all', modules: [holder], membrane });
    try {
      holder.release();
      await firstRequest;
      const messages = JSON.stringify(membrane.calls[0]!.messages);
      assert.ok(!messages.includes(gone), `the turn's request doesn't carry "${gone}"`);
      await drained(s.framework);
      assert.deepEqual(s.texts('k5'), kept);
    } finally {
      await s.cleanup();
    }
  });
}

test("a message deleted while its create is kept in memory, whose delete is still queued at the release, reaches no turn's request", async () => {
  const holder = new Holder();
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
  let requested!: () => void;
  const firstRequest = new Promise<void>((resolve) => { requested = resolve; });
  const stream = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request, options) => { requested(); return stream(request, options); };
  const s = await withKeptCreate('a branch move holding the store', async ({ framework, discord, processed, kept: held, texts }) => {
    const created = processed('discord:message', 'k9');
    await discord.onMessageHandler!(live('k9', 'taken back'));
    await created;
    assert.deepEqual([held(), texts('k9')], [1, []], 'the create is kept in memory, not stored');
    framework.pushEvent({ type: 'zz-hold' } as never);
    await holder.entered;
    discord.onDeleteHandler!('k9');
  }, { triggerOn: 'all', modules: [holder], membrane });
  try {
    holder.release();
    await firstRequest;
    assert.ok(!JSON.stringify(membrane.calls[0]!.messages).includes('taken back'), "the turn's request doesn't carry the deleted text");
    await drained(s.framework);
    assert.deepEqual(s.texts('k9'), []);
  } finally {
    await s.cleanup();
  }
});

test("edits made while a create is kept in memory apply in turn at the release, so a later text-only edit keeps an earlier edit's removed attachment removed", async (t) => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response('NOTES BODY', { status: 200, headers: { 'content-type': 'text/plain' } }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const edit = (discord: FakeDiscord, text: string, attachments?: unknown[]) =>
    (discord.onEditHandler as unknown as (id: string, content: string, attachments?: unknown[]) => void)('k10', text, attachments);
  const s = await withKeptCreate('a branch move holding the store', async ({ discord, processed, kept, texts }) => {
    const created = processed('discord:message', 'k10');
    await discord.onMessageHandler!({
      ...live('k10', 'with notes'),
      attachments: [{ id: 'a1', filename: 'notes.txt', url: 'https://cdn.example.invalid/notes.txt', contentType: 'text/plain', size: 10 }],
    });
    await created;
    assert.deepEqual([fetched, kept(), texts('k10')], [1, 1, []], "the create's attachment was fetched, and the create is kept in memory, not stored");
    const first = processed('discord:edit', 'k10');
    edit(discord, 'with notes', []);
    await first;
    const second = processed('discord:edit', 'k10');
    edit(discord, 'edited text');
    await second;
  });
  try {
    await drained(s.framework);
    const row = JSON.stringify(s.framework.getAgent('Sol')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata?.external as { id?: string } | undefined)?.id === 'k10').map((m) => m.content));
    assert.ok(row.includes('edited text'), `the later edit's text is stored: ${row}`);
    assert.ok(!row.includes('NOTES BODY'), `the attachment the earlier edit removed stays removed: ${row}`);
  } finally {
    await s.cleanup();
  }
});
