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

function historyMessage(id: string, content: string, timestamp: number): HistoryMessage {
  return {
    id,
    authorId: `author-${id}`,
    authorName: `Author ${id}`,
    isBot: false,
    content,
    timestamp: new Date(timestamp),
  };
}

test('Discord history sync appends missed messages in chronological order', async () => {
  const newestFirst = [
    historyMessage('3', 'third', 3_000),
    historyMessage('2', 'second', 2_000),
    historyMessage('1', 'first', 1_000),
  ];
  const client = {
    fetchHistory: async () => newestFirst,
  } as unknown as DiscordClientInterface;
  const module = new DiscordModule(client, { token: 'test-token' });
  const harness = module as unknown as DiscordHistoryHarness;
  const added: Array<{ content: string; timestamp: number }> = [];

  harness.ctx = {
    queryMessages: () => ({ messages: [], totalCount: 0 }),
    getAgents: () => [{ name: 'Sol' }],
    addMessage: (
      _participant: string,
      content: Array<{ type: string; text?: string }>,
      metadata?: { timestamp?: number },
    ) => {
      const text = content[0];
      assert.ok(text && text.type === 'text' && typeof text.text === 'string');
      const timestamp = metadata?.timestamp;
      assert.ok(typeof timestamp === 'number');
      added.push({
        content: text.text,
        timestamp,
      });
      return `stored-${added.length}`;
    },
    editMessage: () => {},
    removeMessage: () => {},
  } as unknown as ModuleContext;

  const result = await harness.syncChannelHistory('channel-1');

  assert.deepStrictEqual(added, [
    { content: 'first', timestamp: 1_000 },
    { content: 'second', timestamp: 2_000 },
    { content: 'third', timestamp: 3_000 },
  ]);
  assert.deepStrictEqual(result, {
    newMessages: 3,
    editedMessages: 0,
    deletedMessages: 0,
  });
  assert.equal(harness.state.lastReadMessageId['channel-1'], '3');
});
