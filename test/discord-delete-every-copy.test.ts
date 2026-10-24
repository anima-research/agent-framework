/**
 * A deleted Discord message loses every row the store holds for it, a
 * message stored twice in shards included. context-manager's chunker names a
 * body by hashing its text, so two copies of one message are two bodies
 * under one group id; which rows make up a body is its continuesBody, read
 * in store order. The module runs in a real framework, with a strategy that
 * shards a long message as it's stored, and both of its deletes are run: the
 * live path's and a history sync's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AutobiographicalStrategy, continuesBody } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { Module, ModuleContext, ModuleMessage, ToolDefinition, ToolResult } from '../src/index.js';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface, DiscordMessageData, HistoryMessage } from '../src/modules/discord/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** The Discord side: the delete handler, and the history a sync fetches. */
class FakeDiscord {
  onDeleteHandler: ((id: string) => void) | null = null;
  history: HistoryMessage[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  getBotUserId(): string { return 'bot'; }
  onMessage(_handler: (message: DiscordMessageData) => Promise<void>): void {}
  onMessageEdit(): void {}
  onMessageDelete(handler: (id: string) => void): void { this.onDeleteHandler = handler; }
  async fetchHistory(): Promise<HistoryMessage[]> { return [...this.history]; }
  async sendTyping(): Promise<void> {}
}

/** A second module, to write and read the store through a module's context. */
class Reader implements Module {
  readonly name = 'reader';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The bodies among a message's rows, as context-manager reads them. */
const bodies = (rows: readonly ModuleMessage[]): ModuleMessage[][] => rows.reduce<ModuleMessage[][]>((all, row, i) => {
  if (continuesBody(rows[i - 1] as never, row as never)) all.at(-1)!.push(row);
  else all.push([row]);
  return all;
}, []);

const LONG = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long Discord message.`).join(' ');

async function withMessageStoredTwice(
  run: (s: { framework: AgentFramework; discord: FakeDiscord; module: DiscordModule; rows: () => ModuleMessage[]; storedRows: number }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'discord-delete-every-copy-'));
  const discord = new FakeDiscord();
  const module = new DiscordModule(discord as unknown as DiscordClientInterface, { token: 't', autoTyping: false });
  const reader = new Reader();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{
      name: 'Sol', model: 'test-model', systemPrompt: 'test',
      // Shards a long message as it's stored, naming its body by its text.
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
        targetChunkTokens: 50,
      }),
    } as never],
    modules: [module, reader],
  });
  try {
    framework.start();
    const rows = () => reader.ctx!.queryMessages({ source: 'discord', externalIds: ['m1'] }).messages;
    const metadata = { external: { source: 'discord', id: 'm1' }, channelId: 'c1', timestamp: 1_000 };
    reader.ctx!.addMessage('User', [{ type: 'text', text: LONG }], metadata);
    await waitFor('the first copy', () => rows().length > 1);
    const shards = rows().length;
    reader.ctx!.addMessage('User', [{ type: 'text', text: LONG }], metadata);
    await waitFor('the second copy', () => rows().length === 2 * shards);
    const stored = bodies(rows());
    assert.equal(stored.length, 2, 'the message is stored as two bodies');
    assert.equal(new Set(rows().map((r) => r.bodyGroupId)).size, 1, 'under one group id');
    await run({ framework, discord, module, rows, storedRows: rows().length });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a live delete removes every copy of a message stored twice in shards', async () => {
  await withMessageStoredTwice(async ({ framework, discord, rows, storedRows }) => {
    discord.onDeleteHandler!('m1');
    await framework.runUntilIdle();
    await waitFor('the delete to be applied', () => rows().length < storedRows);
    assert.deepEqual(rows().map((r) => r.id), []);
  });
});

test("a history sync's delete removes every copy of a message stored twice in shards", async () => {
  await withMessageStoredTwice(async ({ module, rows }) => {
    // Discord's history no longer has the message, and the fetch is complete.
    const sync = (module as unknown as { syncChannelHistory(channelId: string): Promise<{ deletedMessages: number }> }).syncChannelHistory('c1');
    assert.equal((await sync).deletedMessages, 1);
    assert.deepEqual(rows().map((r) => r.id), []);
  });
});
