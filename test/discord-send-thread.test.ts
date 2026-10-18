/**
 * A send whose message went out but whose thread wasn't started: the result
 * stays the error it was, and the message counts as the one the bot last
 * sent, so the agent's thoughts are edited into it.
 *
 * Run: node --import tsx --test test/discord-send-thread.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordJsClient, DiscordModule } from '../src/modules/discord/index.js';
import type { DiscordClientInterface } from '../src/modules/discord/types.js';
import type { ToolResult } from '../src/types/index.js';

/** A DiscordJsClient whose channel lookup gives `channel`. Nothing connects. */
function client(t: { after: (fn: () => Promise<void> | void) => void }, channel: unknown): DiscordJsClient {
  const djs = new DiscordJsClient({ token: 'test-token' });
  (djs as unknown as { client: { channels: { fetch: unknown } } }).client.channels.fetch = async () => channel;
  t.after(() => djs.disconnect());
  return djs;
}

/** A server text channel, which holds threads, whose sent message behaves as `message` does. */
const textChannel = (message: Record<string, unknown>) => ({ type: 0, send: async () => message, threads: {} });

test('a thread that isn\'t started after its message was sent resolves the send, with why', async (t) => {
  const refused = client(t, textChannel({ id: 'M9', startThread: async () => { throw new Error('Missing Permissions'); } }));
  assert.deepEqual(await refused.sendMessage('C1', 'hi', { createThread: { name: 'topic' } }),
    { messageId: 'M9', threadFailure: 'Missing Permissions' });

  const started = client(t, textChannel({ id: 'M6', startThread: async () => ({ id: 'M6' }) }));
  assert.deepEqual(await started.sendMessage('C4', 'hi', { createThread: { name: 'topic' } }), { messageId: 'M6' });

  // A channel without threads, such as a DM, is sent to without one, as before.
  const dm = client(t, { type: 1, send: async () => ({ id: 'M8', startThread: async () => { throw new Error('not reached'); } }) });
  assert.deepEqual(await dm.sendMessage('D2', 'hi', { createThread: { name: 'topic' } }), { messageId: 'M8' });
});

test('a send whose thread wasn\'t started stays an error, and the agent\'s thoughts are edited into its message, not the one before', async () => {
  const edited: Array<[string, string, string]> = [];
  let sent: { messageId: string; threadFailure?: string } = { messageId: 'M1' };
  const m = new DiscordModule({
    sendMessage: async () => sent,
    fetchMessage: async () => 'hello',
    editMessage: async (channelId: string, messageId: string, content: string) => { edited.push([channelId, messageId, content]); },
  } as unknown as DiscordClientInterface, { token: 'test-token' });
  const send = (input: Record<string, unknown>): Promise<ToolResult> => m.handleToolCall({ id: 'call-1', name: 'send', input });

  assert.equal((await send({ channelId: 'C1', content: 'first' })).success, true);
  sent = { messageId: 'M3', threadFailure: 'Missing Permissions' };
  assert.deepEqual(await send({ channelId: 'C1', content: 'hello', createThread: { name: 'topic' } }),
    { success: false, error: 'Missing Permissions', isError: true });
  await m.onAgentSpeech('agent', [], { thoughts: [{ type: 'text', text: 'why' }] } as never);
  assert.deepEqual(edited, [['C1', 'M3', '||why||\nhello']]);
});

test('a send whose client throws is the send\'s error, and records no message for the agent\'s thoughts', async () => {
  const edited: unknown[] = [];
  const m = new DiscordModule({
    sendMessage: async () => { throw new Error('Missing Permissions'); },
    fetchMessage: async () => 'hello',
    editMessage: async (...args: unknown[]) => { edited.push(args); },
  } as unknown as DiscordClientInterface, { token: 'test-token' });
  assert.deepEqual(await m.handleToolCall({ id: 'call-1', name: 'send', input: { channelId: 'C1', content: 'hi' } }),
    { success: false, error: 'Missing Permissions', isError: true });
  await m.onAgentSpeech('agent', [], { thoughts: [{ type: 'text', text: 'why' }] } as never);
  assert.deepEqual(edited, []);
});
