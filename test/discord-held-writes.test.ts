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
import { MockMembrane } from './helpers/mock-membrane.js';

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
    await module.syncChannelHistory('c1');
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
    // An edit the live path missed: the sync brings it to the held write,
    // where it adds no copy.
    discord.history = [history('m4', 'edited while offline'), history('m5', 'another message')];
    await module.syncChannelHistory('c1');
    assert.deepEqual(rows('m4').map((m) => [m.held, textOf(m)]), [[true, 'edited while offline']]);
    assert.equal(rows('m5').length, 1, 'no second copy of a message the sync found stored');
  });
});
