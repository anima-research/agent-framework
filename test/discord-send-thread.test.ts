/**
 * A send whose message went out but whose thread wasn't started: the result
 * stays the error it was, in words that say the message was sent, and the
 * message counts as the agent's post in its turn, so that turn's thoughts are
 * edited into it. A channel that can't hold a thread gets none, and the send
 * succeeds, as it did, with a note that says so.
 *
 * Run: node --import tsx --test test/discord-send-thread.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
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

/** What Discord answers when it refuses a request. */
function refusedBy(code: number, message: string, status: number): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, status, 'GET', 'https://discord.com/api/v10/test', { body: undefined, files: undefined });
}

test('a thread that isn\'t started after its message was sent resolves the send, with why, in words that say the message was sent', async (t) => {
  const refused = client(t, textChannel({ id: 'M9', startThread: async () => { throw refusedBy(RESTJSONErrorCodes.MissingPermissions, 'Missing Permissions', 403); } }));
  assert.deepEqual(await refused.sendMessage('C1', 'hi', { createThread: { name: 'topic' } }), {
    messageId: 'M9',
    threadFailure: 'The message was sent (id M9), so don\'t send it again, but no thread was started: this bot isn\'t allowed to start threads in channel C1 (Discord answered "Missing Permissions"), and calling again won\'t change that. Ask whoever runs this host to grant the permission. Once that\'s settled, discord--create_thread with channelId C1, messageId M9 and a name starts one.',
  });

  // Nor does Missing Access, which, after a send, is about the channel's
  // threads, and points nowhere else, where the message would go out twice.
  const unseen = client(t, textChannel({ id: 'M2', startThread: async () => { throw refusedBy(RESTJSONErrorCodes.MissingAccess, 'Missing Access', 403); } }));
  assert.deepEqual(await unseen.sendMessage('C2', 'hi', { createThread: { name: 'topic' } }), {
    messageId: 'M2',
    threadFailure: 'The message was sent (id M2), so don\'t send it again, but no thread was started: this bot can\'t start threads in channel C2 (Discord answered "Missing Access"), and calling again won\'t change that. Ask whoever runs this host to give it access. Once that\'s settled, discord--create_thread with channelId C2, messageId M2 and a name starts one.',
  });

  // Discord answers a retried start that it had already carried out as a
  // thread that exists.
  const retried = client(t, textChannel({ id: 'M5', startThread: async () => { throw refusedBy(RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage, 'A thread has already been created for this message', 400); } }));
  assert.deepEqual(await retried.sendMessage('C5', 'hi', { createThread: { name: 'topic' } }), {
    messageId: 'M5',
    threadFailure: 'The message was sent (id M5), so don\'t send it again, and its thread exists already, with the message\'s own id, M5.',
  });

  const lost = client(t, textChannel({ id: 'M7', startThread: async () => { throw new Error('socket hang up'); } }));
  assert.deepEqual(await lost.sendMessage('C3', 'hi', { createThread: { name: 'topic' } }), {
    messageId: 'M7',
    threadFailure: 'The message was sent (id M7), so don\'t send it again, but starting its thread stopped on an unexpected error: socket hang up. Whether the thread exists is unknown: discord--fetch_history with channelId M7 reads the thread if it exists and is refused if it doesn\'t, and then discord--create_thread with channelId C3, messageId M7 and a name starts one.',
  });

  const started = client(t, textChannel({ id: 'M6', startThread: async () => ({ id: 'M6' }) }));
  assert.deepEqual(await started.sendMessage('C4', 'hi', { createThread: { name: 'topic' } }), { messageId: 'M6' });

  // A channel without threads, such as a DM, is sent to without one, as
  // before, and the send says so.
  const dm = client(t, { type: 1, send: async () => ({ id: 'M8', startThread: async () => { throw new Error('not reached'); } }) });
  assert.deepEqual(await dm.sendMessage('D2', 'hi', { createThread: { name: 'topic' } }), {
    messageId: 'M8',
    note: 'No thread was started: channel D2 can\'t hold threads. A message can start one only in a server\'s text or announcement channel.',
  });
});

test('a send whose thread wasn\'t started stays an error, and the agent\'s thoughts are edited into its message, not the one before', async () => {
  const edited: Array<[string, string, string]> = [];
  let sent: { messageId: string; threadFailure?: string } = { messageId: 'M1' };
  const m = new DiscordModule({
    sendMessage: async () => sent,
    fetchMessage: async () => 'hello',
    editMessage: async (channelId: string, messageId: string, content: string) => { edited.push([channelId, messageId, content]); },
  } as unknown as DiscordClientInterface, { token: 'test-token' });
  const send = (input: Record<string, unknown>): Promise<ToolResult> =>
    m.handleToolCall({ id: 'call-1', name: 'send', input, callerAgentName: 'agent', callerTurnId: 1 });

  assert.equal((await send({ channelId: 'C1', content: 'first' })).success, true);
  sent = { messageId: 'M3', threadFailure: 'Missing Permissions' };
  assert.deepEqual(await send({ channelId: 'C1', content: 'hello', createThread: { name: 'topic' } }),
    { success: false, error: 'Missing Permissions', isError: true });
  await m.onAgentSpeech('agent', [], { thoughts: [{ type: 'text', text: 'why' }], turnId: 1 } as never);
  assert.deepEqual(edited, [['C1', 'M3', '||why||\nhello']]);
});

test('a send whose client throws is the send\'s error, and records no message for the agent\'s thoughts', async () => {
  const edited: unknown[] = [];
  const m = new DiscordModule({
    sendMessage: async () => { throw new Error('Missing Permissions'); },
    fetchMessage: async () => 'hello',
    editMessage: async (...args: unknown[]) => { edited.push(args); },
  } as unknown as DiscordClientInterface, { token: 'test-token' });
  assert.deepEqual(await m.handleToolCall({ id: 'call-1', name: 'send', input: { channelId: 'C1', content: 'hi' }, callerAgentName: 'agent', callerTurnId: 1 }),
    { success: false, error: 'discord--send stopped on an unexpected error: Missing Permissions. Whether the message was sent is unknown: discord--fetch_history with channelId C1 shows it, so check before you send it again.', isError: true });
  await m.onAgentSpeech('agent', [], { thoughts: [{ type: 'text', text: 'why' }], turnId: 1 } as never);
  assert.deepEqual(edited, []);
});

test('a send into a channel that can\'t hold its thread succeeds, with the client\'s note in its data', async () => {
  const note = 'No thread was started: as the client worded it.';
  const m = new DiscordModule({ sendMessage: async () => ({ messageId: 'M8', note }) } as unknown as DiscordClientInterface, { token: 'test-token' });
  assert.deepEqual(await m.handleToolCall({ id: 'call-1', name: 'send', input: { channelId: 'D2', content: 'hi', createThread: { name: 'topic' } } }),
    { success: true, data: { messageId: 'M8', note } });
});
