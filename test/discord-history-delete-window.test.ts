import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordModule } from '../src/modules/discord/index.js';
import type {
  DiscordClientInterface,
  DiscordModuleState,
  HistoryMessage,
} from '../src/modules/discord/types.js';
import type { ModuleContext } from '../src/types/index.js';

interface DiscordHistoryHarness {
  ctx: ModuleContext | null;
  state: DiscordModuleState;
  syncChannelHistory(channelId: string): Promise<{
    newMessages: number;
    editedMessages: number;
    deletedMessages: number;
  }>;
}

function historyMessage(id: string, timestamp: number): HistoryMessage {
  return {
    id,
    authorId: `author-${id}`,
    authorName: `Author ${id}`,
    isBot: false,
    content: `message ${id}`,
    timestamp: new Date(timestamp),
  };
}

function storedMessage(internalId: string, externalId: string, timestamp: number) {
  return {
    id: internalId,
    sequence: 1,
    participant: `Author ${externalId}`,
    content: [{ type: 'text' as const, text: `message ${externalId}` }],
    metadata: {
      external: { source: 'discord', id: externalId },
      channelId: 'channel-1',
      timestamp,
    },
    timestamp: new Date(timestamp),
  };
}

function historyHarness(
  discordMessages: HistoryMessage[],
  storedMessages: ReturnType<typeof storedMessage>[],
  historyScrollback: number,
): { harness: DiscordHistoryHarness; removed: string[] } {
  const client = {
    fetchHistory: async () => discordMessages,
  } as unknown as DiscordClientInterface;
  const module = new DiscordModule(client, {
    token: 'test-token',
    historyScrollback,
  });
  const harness = module as unknown as DiscordHistoryHarness;
  const removed: string[] = [];

  harness.ctx = {
    queryMessages: () => ({
      messages: storedMessages,
      totalCount: storedMessages.length,
    }),
    getAgents: () => [{ name: 'Sol' }],
    addMessage: () => 'unexpected-add',
    editMessage: () => {},
    removeMessage: (id: string) => removed.push(id),
  } as unknown as ModuleContext;

  return { harness, removed };
}

test('history sync preserves stored messages older than a full scrollback window', async () => {
  const { harness, removed } = historyHarness(
    [historyMessage('3', 3_000), historyMessage('2', 2_000)],
    [
      storedMessage('stored-old', '1', 1_000),
      storedMessage('stored-recent-deleted', 'deleted', 2_500),
      storedMessage('stored-2', '2', 2_000),
      storedMessage('stored-3', '3', 3_000),
    ],
    2,
  );

  const result = await harness.syncChannelHistory('channel-1');

  assert.deepStrictEqual(removed, ['stored-recent-deleted']);
  assert.equal(result.deletedMessages, 1);
});

test('history sync preserves an unfetched message tied with the oldest fetched timestamp', async () => {
  const { harness, removed } = historyHarness(
    [historyMessage('3', 3_000), historyMessage('2', 2_000)],
    [
      storedMessage('stored-boundary-unseen', '1', 2_000),
      storedMessage('stored-recent-deleted', 'deleted', 2_500),
      storedMessage('stored-2', '2', 2_000),
      storedMessage('stored-3', '3', 3_000),
    ],
    2,
  );

  const result = await harness.syncChannelHistory('channel-1');

  assert.deepStrictEqual(removed, ['stored-recent-deleted']);
  assert.equal(result.deletedMessages, 1);
});

test('history sync still detects older deletions when the fetch covers the whole channel', async () => {
  const { harness, removed } = historyHarness(
    [historyMessage('2', 2_000)],
    [
      storedMessage('stored-deleted', '1', 1_000),
      storedMessage('stored-2', '2', 2_000),
    ],
    3,
  );

  const result = await harness.syncChannelHistory('channel-1');

  assert.deepStrictEqual(removed, ['stored-deleted']);
  assert.equal(result.deletedMessages, 1);
});
