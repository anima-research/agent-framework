/**
 * AF #844 bot review, round 8: modules.
 *
 * 71: a Discord create kept in memory by a surgery's hold whose store
 *     throws at the release, landing no row, ends its record of the create
 *     (the framework traces the lost write, `message:lost`), so a later
 *     delete, a history sync and a live create of the message are no longer
 *     passed over for the lifetime of the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { TraceEvent } from '../src/index.js';
import { DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface, DiscordMessageData, HistoryMessage } from '../src/modules/discord/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

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

const live = (id: string, content: string): DiscordMessageData => ({
  id, channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'User', isBot: false, content,
  isReply: false, mentionedUserIds: [], attachments: [], timestamp: new Date(1_000),
});
const history = (id: string, content: string): HistoryMessage =>
  ({ id, authorId: 'u1', authorName: 'User', isBot: false, content, timestamp: new Date(1_000), attachments: [] });
const textOf = (m: { content: ContentBlock[] }): string => (m.content[0] as { text: string }).text;

async function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface DiscordInternals {
  syncChannelHistory(channelId: string): Promise<{ newMessages: number }>;
  creating: Map<string, { phase: string; unapplied?: unknown }>;
}

test('71: a Discord create lost at a surgery release ends its record, so the message is no longer passed over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review8-discord-lost-'));
  const discord = new FakeDiscord();
  const module = new DiscordModule(discord as unknown as DiscordClientInterface, { token: 't', autoTyping: false });
  const internals = module as unknown as DiscordInternals;
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'Sol', model: 'test-model', systemPrompt: 'test' }],
    modules: [module],
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((event) => { traces.push(event); });
  const waiters: Array<{ type: string; id: string; done: () => void }> = [];
  framework.onTrace((event) => {
    if (event.type !== 'process:completed') return;
    const done = event.processEvent as { type: string; discordMessageId?: string };
    for (const w of waiters.splice(0)) {
      if (w.type === done.type && w.id === done.discordMessageId) w.done(); else waiters.push(w);
    }
  });
  const processed = (type: string, id: string) => within(new Promise<void>((done) => { waiters.push({ type, id, done }); }), `${type} for ${id}`);
  const texts = (id: string) => framework.getAgent('Sol')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata?.external as { id?: string } | undefined)?.id === id)
    .map(textOf);
  const quiet = console.error;
  const errors: string[] = [];
  try {
    framework.start();
    const branch = framework.getStore().currentBranch().name;
    const strategy = framework.getAgent('Sol')!.getContextManager().getStrategy() as unknown as { initialize?: (...args: unknown[]) => Promise<void> };
    const initialize = strategy.initialize;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let reached!: () => void;
    const inMove = new Promise<void>((resolve) => { reached = resolve; });
    strategy.initialize = async function (this: unknown, ...args: unknown[]) { reached(); await gate; return initialize?.apply(this, args); };
    const move = framework.switchBranch(branch);
    await within(inMove, 'the move to reach its initialization');

    const created = processed('discord:message', 'lost-1');
    await discord.onMessageHandler!(live('lost-1', 'never stored'));
    await created;
    assert.equal(internals.creating.get('lost-1')?.phase, 'writing', 'premise: the create was answered, and is kept in memory');
    assert.equal(framework.getHostModeStatus().deferredWrites, 1);

    // The release's store of that write throws, landing nothing.
    const fw = framework as unknown as { addMessage(participant: string, content: ContentBlock[], ...rest: unknown[]): unknown };
    const addMessage = fw.addMessage.bind(framework);
    fw.addMessage = (participant, content, ...rest) => {
      if (JSON.stringify(content).includes('never stored')) throw new Error('zz-store-refused (test)');
      return addMessage(participant, content, ...rest);
    };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    open();
    await within(move, 'the move');
    console.error = quiet;
    fw.addMessage = addMessage;
    if (initialize) strategy.initialize = initialize; else delete strategy.initialize;

    assert.ok(errors.some((e) => e.includes('so it is lost')), 'premise: the release lost the write');
    assert.deepEqual(texts('lost-1'), [], 'premise: no row landed');
    const lost = traces.filter((t) => t.type === ('message:lost' as never)) as unknown as Array<{ source: string; agentName: string; external?: { source: string; id: string }; mayBeStored?: true }>;
    assert.deepEqual(lost.map((t) => [t.source, t.agentName, t.external, t.mayBeStored]),
      [['surgery-release', 'Sol', { source: 'discord', id: 'lost-1' }, undefined]], 'the release traces the lost write, by its address');
    assert.equal(internals.creating.has('lost-1'), false, 'the module ends its record of the create');

    // A history sync now stores the message, which it passed over before.
    discord.history = [history('lost-1', 'never stored')];
    const synced = await internals.syncChannelHistory('c1');
    assert.equal(synced.newMessages, 1);
    assert.deepEqual(texts('lost-1'), ['never stored']);
    // And its delete reaches that row.
    const deleted = processed('discord:delete', 'lost-1');
    discord.onDeleteHandler!('lost-1');
    await deleted;
    assert.deepEqual(texts('lost-1'), [], 'the delete is applied');
  } finally {
    console.error = quiet;
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
