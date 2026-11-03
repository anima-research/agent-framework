/**
 * What an agent reads when a Discord tool, the health snapshot or the api
 * module refuses or fails: what didn't happen, why, and what to do instead.
 *
 * The client's refusals come from what Discord answers. In discord.js 14.27,
 * channels.fetch, guilds.fetch and users.fetch throw a DiscordAPIError for an
 * id Discord doesn't know or a target the bot can't reach; they don't return
 * null for those.
 *
 * Run: node --import tsx --test test/discord-tool-errors.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAPIError, DiscordjsError, DiscordjsErrorCodes, DiscordjsTypeError, RESTJSONErrorCodes } from 'discord.js';
import { DiscordJsClient, DiscordModule, DiscordRefusal } from '../src/modules/discord/index.js';
import type { DiscordClientInterface } from '../src/modules/discord/types.js';
import { HealthModule } from '../src/modules/health/index.js';
import { ApiModule } from '../src/modules/api/index.js';
import type { ToolResult } from '../src/types/index.js';

/** discord.js's own refusal, as its checks throw it before any request.
 *  The typings keep these constructors private. */
type DjsErrorClass = new (code: string, ...args: unknown[]) => Error;
const djsError = (code: string) => new (DiscordjsError as unknown as DjsErrorClass)(code);
const djsTypeError = (code: string, ...args: unknown[]) => new (DiscordjsTypeError as unknown as DjsErrorClass)(code, ...args);

/** What Discord answers when it refuses a request. */
function refusedBy(code: number, message: string, status = 404): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, status, 'GET', 'https://discord.com/api/v10/test', { body: undefined, files: undefined });
}

type Stubs = {
  channel?: () => Promise<unknown>;
  guild?: () => Promise<unknown>;
  user?: () => Promise<unknown>;
};

/** A DiscordJsClient whose discord.js lookups answer as `stubs` do. Nothing connects. */
function client(t: { after: (fn: () => Promise<void> | void) => void }, stubs: Stubs): DiscordJsClient {
  const djs = new DiscordJsClient({ token: 'test-token' });
  const inner = (djs as unknown as {
    client: { channels: { fetch: unknown }; guilds: { fetch: unknown }; users: { fetch: unknown } };
  }).client;
  if (stubs.channel) inner.channels.fetch = stubs.channel;
  if (stubs.guild) inner.guilds.fetch = stubs.guild;
  if (stubs.user) inner.users.fetch = stubs.user;
  t.after(() => djs.disconnect());
  return djs;
}

/** A text channel whose one message behaves as `message` does. */
function textChannel(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 0, send: async () => message, messages: { fetch: async () => message }, threads: {}, ...extra };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof DiscordRefusal, `a DiscordRefusal, not ${String(error)}`);
    return error.message;
  }
  assert.fail('the call was refused');
}

test('a channel id Discord doesn\'t know is refused, with the calls that show the ids', async (t) => {
  const answer = refusedBy(RESTJSONErrorCodes.UnknownChannel, 'Unknown Channel');
  const djs = client(t, { channel: async () => { throw answer; } });
  const error = await djs.editMessage('C1', 'M1', 'new').then(() => undefined, (e: unknown) => e);
  assert(error instanceof DiscordRefusal);
  assert.equal(error.message,
    'Nothing was edited: no channel C1 is visible to this bot. The id may be mistyped or remembered rather than copied; discord--list_guilds, then discord--list_channels with a guildId, shows the ids. '
    + 'Threads aren\'t listed there: a thread started from a message has that message\'s id, which discord--fetch_history of its channel shows. '
    + 'Nor are direct message channels: one\'s id is the channelId an earlier discord--dm to that user returned.');
  assert.equal(error.cause, answer, 'Discord\'s error is kept as the cause');
});

test('a channel that holds no messages is refused as what it is', async (t) => {
  const djs = client(t, { channel: async () => ({ type: 4 }) });
  assert.equal(await refusal(djs.sendMessage('C1', 'hi')),
    'Nothing was sent: channel C1 is a category, which holds channels, not messages. discord--list_channels with a guildId shows the server\'s channels and their ids.');
});

test('each code Discord refuses with is worded for the tool that met it', async (t) => {
  const throwing = (code: number, message: string, status = 403) => async () => { throw refusedBy(code, message, status); };
  // A user whose direct message channel sends as `send` does.
  const dmUser = (send: unknown) => async () => ({ createDM: async () => ({ send }) });
  const cases: Array<[string, Promise<unknown>, RegExp]> = [
    ['react, an unknown emoji',
      client(t, { channel: async () => textChannel({ react: throwing(RESTJSONErrorCodes.UnknownEmoji, 'Unknown Emoji', 400) }) }).addReaction('C1', 'M1', ':smile:'),
      /^No reaction was added: Discord doesn't know the emoji ":smile:"\. Use a Unicode emoji/],
    ['list_channels, an unknown server',
      client(t, { guild: throwing(RESTJSONErrorCodes.UnknownGuild, 'Unknown Guild', 404) }).listChannels('G1'),
      /^Nothing was listed: no server G1 is visible to this bot\. discord--list_guilds shows the servers it is in, with their ids\.$/],
    ['fetch_history, a channel the bot can\'t see, whose history no other channel\'s stands in for',
      client(t, { channel: throwing(RESTJSONErrorCodes.MissingAccess, 'Missing Access') }).fetchHistory('C1'),
      /^No history was read: this bot can't see channel C1 \(Discord answered "Missing Access"\), and calling again won't change that\. Ask whoever runs this host to give it access\.$/],
    ['delete, without permission',
      client(t, { channel: async () => textChannel({ delete: throwing(RESTJSONErrorCodes.MissingPermissions, 'Missing Permissions') }) }).deleteMessage('C1', 'M1'),
      /^Nothing was deleted: this bot isn't allowed to do that in channel C1 \(Discord answered "Missing Permissions"\)/],
    ['edit, someone else\'s message',
      client(t, { channel: async () => textChannel({ edit: throwing(RESTJSONErrorCodes.CannotEditMessageAuthoredByAnotherUser, 'Cannot edit a message authored by another user') }) }).editMessage('C1', 'M1', 'x'),
      /^Nothing was edited: message M1 was written by someone else, and this bot can edit only its own messages\.$/],
    ['edit, a message id Discord doesn\'t know',
      client(t, { channel: async () => ({ type: 0, messages: { fetch: throwing(RESTJSONErrorCodes.UnknownMessage, 'Unknown Message', 404) } }) }).editMessage('C1', 'M1', 'x'),
      /^Nothing was edited: channel C1 has no message M1 that this bot can see\. discord--fetch_history with that channelId/],
    ['dm, a user who doesn\'t take them',
      client(t, { user: dmUser(throwing(RESTJSONErrorCodes.CannotSendMessagesToThisUser, 'Cannot send messages to this user')) }).sendDM('U1', 'hi'),
      /^Nothing was sent: Discord won't deliver a direct message from this bot to user U1/],
    ['dm, a user Discord doesn\'t know',
      client(t, { user: throwing(RESTJSONErrorCodes.UnknownUser, 'Unknown User', 404) }).sendDM('U1', 'hi'),
      /^Nothing was sent: Discord knows no user U1\. The id may be mistyped or remembered rather than copied; discord--fetch_history of a channel they wrote in shows its messages' authors' ids\.$/],
    ['dm, a user the bot can\'t reach, named as a user',
      client(t, { user: dmUser(throwing(RESTJSONErrorCodes.MissingAccess, 'Missing Access')) }).sendDM('U1', 'hi'),
      /^Nothing was sent: this bot can't see user U1 \(Discord answered "Missing Access"\), and calling again won't change that\. Ask whoever runs this host to give it access\.$/],
    ['dm, without permission, naming no channel',
      client(t, { user: dmUser(throwing(RESTJSONErrorCodes.MissingPermissions, 'Missing Permissions')) }).sendDM('U1', 'hi'),
      /^Nothing was sent: this bot isn't allowed to do that \(Discord answered "Missing Permissions"\), and calling again won't change that\. Ask whoever runs this host to grant the permission\.$/],
    ['send, without permission',
      client(t, { channel: async () => textChannel({}, { send: throwing(RESTJSONErrorCodes.MissingPermissions, 'Missing Permissions') }) }).sendMessage('C1', 'hi'),
      /^Nothing was sent: this bot isn't allowed to do that in channel C1 \(Discord answered "Missing Permissions"\), and calling again won't change that\. Ask whoever runs this host to grant the permission\.$/],
    ['send, a channel the bot can\'t see',
      client(t, { channel: throwing(RESTJSONErrorCodes.MissingAccess, 'Missing Access') }).sendMessage('C1', 'hi'),
      /^Nothing was sent: this bot can't see channel C1 \(Discord answered "Missing Access"\), and calling again won't change that\. Ask whoever runs this host to give it access\.$/],
    ['create_thread, a channel the bot can\'t see',
      client(t, { channel: async () => textChannel({ startThread: throwing(RESTJSONErrorCodes.MissingAccess, 'Missing Access') }) }).createThread('C1', 'M1', 'topic'),
      /^No thread was started: this bot can't see channel C1 \(Discord answered "Missing Access"\), and calling again won't change that\. Ask whoever runs this host to give it access\.$/],
    ['send into a direct-message channel whose user doesn\'t take them',
      client(t, { channel: async () => textChannel({}, { type: 1, send: throwing(RESTJSONErrorCodes.CannotSendMessagesToThisUser, 'Cannot send messages to this user') }) }).sendMessage('D1', 'hi'),
      /^Nothing was sent: Discord won't deliver a direct message from this bot in channel D1, usually because/],
    ['list_channels, a server the bot can\'t see',
      client(t, { guild: throwing(RESTJSONErrorCodes.MissingAccess, 'Missing Access') }).listChannels('G1'),
      /^Nothing was listed: this bot can't see server G1 \(Discord answered "Missing Access"\), and calling again won't change that\. Ask whoever runs this host to give it access\.$/],
    ['list_channels, without permission, in the server',
      client(t, { guild: async () => ({ channels: { fetch: throwing(RESTJSONErrorCodes.MissingPermissions, 'Missing Permissions') } }) }).listChannels('G1'),
      /^Nothing was listed: this bot isn't allowed to do that in server G1 \(Discord answered "Missing Permissions"\), and calling again won't change that\. Ask whoever runs this host to grant the permission\.$/],
    ['delete, a message that isn\'t there now',
      client(t, { channel: async () => ({ type: 0, messages: { fetch: throwing(RESTJSONErrorCodes.UnknownMessage, 'Unknown Message', 404) } }) }).deleteMessage('C1', 'M1'),
      /^Channel C1 has no message M1 now: it's deleted, or the id is wrong\. discord--fetch_history with that channelId shows its recent messages and their ids\.$/],
    ['delete, a message a retried request of this one may have deleted',
      client(t, { channel: async () => textChannel({ delete: throwing(RESTJSONErrorCodes.UnknownMessage, 'Unknown Message', 404) }) }).deleteMessage('C1', 'M1'),
      /^Channel C1 has no message M1 now: it's deleted, or the id is wrong\. /],
    ['react, something discord.js doesn\'t read as an emoji',
      client(t, { channel: async () => textChannel({ react: async () => { throw djsTypeError(DiscordjsErrorCodes.EmojiType, 'emoji', 'EmojiIdentifierResolvable'); } }) }).addReaction('C1', 'M1', ''),
      /^No reaction was added: this bot can't read "" as an emoji, so Discord wasn't asked\. Use a Unicode emoji/],
    ['create_thread, on a message whose channel can\'t hold threads',
      client(t, { channel: async () => textChannel({ startThread: async () => { throw djsError(DiscordjsErrorCodes.MessageThreadParent); } }) }).createThread('C1', 'M1', 'topic'),
      /^No thread was started: channel C1 can't hold threads\. A message can start one only in a server's text or announcement channel\.$/],
    ['create_thread, on a message that already has one',
      client(t, { channel: async () => textChannel({ startThread: async () => { throw djsError(DiscordjsErrorCodes.MessageExistingThread); } }) }).createThread('C1', 'M1', 'topic'),
      /^No thread was started: message M1 already has a thread, whose id is the message's own: discord--send with channelId M1 posts in it\.$/],
    ['create_thread, on a message Discord says has one: a repeat, or a retried request of this one',
      client(t, { channel: async () => textChannel({ startThread: throwing(RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage, 'A thread has already been created for this message', 400) }) }).createThread('C1', 'M1', 'topic'),
      /^Message M1 has a thread already, whose id is the message's own: discord--send with channelId M1 posts in it\.$/],
    ['send, a code without words of its own',
      client(t, { channel: async () => textChannel({}, { send: throwing(50035, 'Invalid Form Body', 400) }) }).sendMessage('C1', 'x'.repeat(2001)),
      /^Nothing was sent: Discord refused the request: Invalid Form Body$/],
  ];
  for (const [what, promise, expected] of cases) assert.match(await refusal(promise), expected, what);
});

test('an error that isn\'t Discord\'s answer passes through as unexpected, unless it stopped a lookup before the tool changed anything', async (t) => {
  const failure = new TypeError('fetch failed');
  const djs = client(t, { channel: async () => textChannel({}, { send: async () => { throw failure; } }) });
  await assert.rejects(djs.sendMessage('C1', 'hi'), (error) => error === failure);
  // A lookup before the change changes nothing, so nothing was done.
  const lost = client(t, { channel: async () => { throw failure; }, user: async () => { throw failure; } });
  assert.equal(await refusal(lost.sendMessage('C1', 'hi')),
    'Nothing was sent: looking up channel C1 stopped on an unexpected error: fetch failed. Calling it again is safe.');
  assert.equal(await refusal(lost.sendDM('U1', 'hi')),
    'Nothing was sent: looking up user U1 stopped on an unexpected error: fetch failed. Calling it again is safe.');
  const noDM = client(t, { user: async () => ({ createDM: async () => { throw failure; } }) });
  assert.equal(await refusal(noDM.sendDM('U1', 'hi')),
    'Nothing was sent: looking up the direct message channel with user U1 stopped on an unexpected error: fetch failed. Calling it again is safe.');
  const noMessage = client(t, { channel: async () => ({ type: 0, messages: { fetch: async () => { throw failure; } } }) });
  for (const [lead, call] of [
    ['Nothing was edited', noMessage.editMessage('C1', 'M1', 'x')],
    ['Nothing was deleted', noMessage.deleteMessage('C1', 'M1')],
    ['No reaction was added', noMessage.addReaction('C1', 'M1', '👍')],
    ['No thread was started', noMessage.createThread('C1', 'M1', 'topic')],
  ] as const) {
    assert.equal(await refusal(call), `${lead}: looking up message M1 in channel C1 stopped on an unexpected error: fetch failed. Calling it again is safe.`);
  }
  assert.equal(await refusal(lost.editMessage('C1', 'M1', 'x')),
    'Nothing was edited: looking up message M1 in channel C1 stopped on an unexpected error: fetch failed. Calling it again is safe.', 'its channel too');
});

test('a call that names an empty message id is refused before any request', async (t) => {
  // discord.js fetches a channel's recent messages for an empty id, not a message.
  let asked = 0;
  const djs = client(t, { channel: async () => { asked++; return textChannel({}); } });
  const tellsHow = 'discord--fetch_history with channelId C1 shows its recent messages and their ids.';
  const cases: [string, Promise<unknown>, string][] = [
    ['edit', djs.editMessage('C1', '', 'x'), 'Nothing was edited'],
    ['delete', djs.deleteMessage('C1', ''), 'Nothing was deleted'],
    ['react', djs.addReaction('C1', '', '👍'), 'No reaction was added'],
    ['create_thread', djs.createThread('C1', '', 'topic'), 'No thread was started'],
  ];
  for (const [what, promise, lead] of cases) assert.equal(await refusal(promise), `${lead}: the call gave no message id. ${tellsHow}`, what);
  assert.equal(asked, 0, 'no channel was looked up');
});

test('a channel that holds no messages, or that discord.js can\'t give, is named as what it is', async (t) => {
  const forum = client(t, { channel: async () => ({ type: 15 }) });
  assert.equal(await refusal(forum.sendMessage('C1', 'hi')),
    'Nothing was sent: channel C1 is a forum, whose messages are in its posts, each a thread with its own id, which this module has no tool to list. discord--list_channels with a guildId shows the server\'s channels and their ids.');
  const media = client(t, { channel: async () => ({ type: 16 }) });
  assert.equal(await refusal(media.fetchHistory('C1')),
    'No history was read: channel C1 is a media channel, whose messages are in its posts, each a thread with its own id, which this module has no tool to list. discord--list_channels with a guildId shows the server\'s channels and their ids.');
  const unknown = client(t, { channel: async () => ({ type: 999 }) });
  assert.equal(await refusal(unknown.editMessage('C1', 'M1', 'x')),
    'Nothing was edited: channel C1 is a kind of channel that holds no messages. discord--list_channels with a guildId shows the server\'s channels and their ids.');
  const missing = client(t, { channel: async () => null });
  assert.equal(await refusal(missing.fetchHistory('C1')),
    'No history was read: this bot can\'t use channel C1: Discord answered for it, but it\'s a kind of channel this bot doesn\'t handle, or its server isn\'t loaded here, and calling again won\'t change that. Ask whoever runs this host if you need it.');
});

/** A DiscordModule whose client answers as `stub` does. */
function discordModule(stub: Partial<DiscordClientInterface>, config: Record<string, unknown> = {}): DiscordModule {
  return new DiscordModule(stub as DiscordClientInterface, { token: 'test-token', ...config });
}

const call = (m: DiscordModule, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> =>
  m.handleToolCall({ id: 'call-1', name, input });

test('the module passes a refusal on as worded, and words an unexpected error by what the tool changes', async () => {
  const refused = discordModule({ sendMessage: async () => { throw new DiscordRefusal('Nothing was sent: as the client worded it.'); } });
  assert.deepEqual(await call(refused, 'send', { channelId: 'C1', content: 'hi' }),
    { success: false, error: 'Nothing was sent: as the client worded it.', isError: true });

  const lost = new Error('socket hang up');
  const throwLost = async () => { throw lost; };
  const failing = discordModule({
    sendMessage: throwLost, sendDM: throwLost, editMessage: throwLost, addReaction: throwLost,
    deleteMessage: throwLost, createThread: throwLost, listChannels: throwLost, fetchHistory: throwLost,
    listGuilds: throwLost,
  });
  const stopped = (name: string) => `discord--${name} stopped on an unexpected error: socket hang up.`;
  const safe = 'Whether it took effect is unknown. Calling it again is safe: if it did, the second call changes nothing more.';
  const readOnly = 'It changes nothing on Discord, so you can call it again.';
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['send', { channelId: 'C1', content: 'hi' }, 'Whether the message was sent is unknown: discord--fetch_history with channelId C1 shows it, so check before you send it again.'],
    ['dm', { userId: 'U1', content: 'hi' }, 'Whether the message was sent is unknown. If an earlier discord--dm to this user gave you its channelId, discord--fetch_history with it shows whether this one went; without it, sending it again may send it twice.'],
    ['edit', { channelId: 'C1', messageId: 'M1', content: 'x' }, safe],
    ['react', { channelId: 'C1', messageId: 'M1', emoji: '👍' }, safe],
    ['delete', { channelId: 'C1', messageId: 'M1' }, safe],
    ['create_thread', { channelId: 'C1', messageId: 'M1', name: 'topic' }, safe],
    ['list_guilds', {}, readOnly],
    ['list_channels', { guildId: 'G1' }, readOnly],
    ['fetch_history', { channelId: 'C1' }, readOnly],
  ];
  for (const [name, input, words] of cases) {
    assert.equal((await call(failing, name, input)).error, `${stopped(name)} ${words}`, name);
  }
  // activate and deactivate change only how this host routes speech.
  const throwNow = () => { throw lost; };
  (failing as unknown as { ctx: unknown }).ctx = { registerSpeechHandler: throwNow, unregisterSpeechHandler: throwNow };
  for (const name of ['activate', 'deactivate']) {
    assert.equal((await call(failing, name)).error, `${stopped(name)} Calling it again is safe.`, name);
  }
  (failing as unknown as { ctx: unknown }).ctx = null;
  // set_reply_context reads its input before anything else, so a call
  // without one stops on an unexpected error, which doesn't say it changed
  // nothing.
  assert.match((await failing.handleToolCall({ id: 'call-1', name: 'set_reply_context', input: undefined as never })).error ?? '',
    /^discord--set_reply_context stopped on an unexpected error: .+\. Calling it again is safe\.$/);
  // reply names the channel its conversation posts in, a thread's if it has
  // one, as it stood when the reply was sent, though a message that arrives
  // meanwhile moves the conversation.
  let moved: DiscordModule | undefined;
  const targets: string[] = [];
  const moving = discordModule({
    sendMessage: async (channelId: string) => {
      targets.push(channelId);
      await call(moved!, 'set_reply_context', { channelId: 'C9' });
      throw lost;
    },
  });
  moved = moving;
  assert.equal((await call(moving, 'set_reply_context', { channelId: 'C5', threadId: 'T5' })).success, true);
  assert.equal((await call(moving, 'reply', { content: 'hi' })).error,
    `${stopped('reply')} Whether the reply was sent is unknown: discord--fetch_history with channelId T5, its reply context's thread, shows it, so check before you reply again.`);
  // A context whose thread id is empty sends there, as it always has, and
  // the words say what to change.
  assert.equal((await call(moving, 'set_reply_context', { channelId: 'C6', threadId: '' })).success, true);
  assert.equal((await call(moving, 'reply', { content: 'hi' })).error,
    `${stopped('reply')} Whether the reply was sent is unknown, and its reply context names an empty thread id: discord--set_reply_context with a threadId, or without one to reply in channel C6, puts that right.`);
  assert.deepEqual(targets, ['T5', '']);
});

test('a dm that is sent gives its direct message channel\'s id, which history reads', async (t) => {
  const djs = client(t, { user: async () => ({ createDM: async () => ({ send: async () => ({ id: 'M1', channelId: 'D1' }) }) }) });
  assert.deepEqual(await djs.sendDM('U1', 'hi'), { messageId: 'M1', channelId: 'D1' });
  assert.deepEqual(await call(discordModule({ sendDM: async () => ({ messageId: 'M1', channelId: 'D1' }) }), 'dm', { userId: 'U1', content: 'hi' }),
    { success: true, data: { messageId: 'M1', channelId: 'D1' } });
  assert.deepEqual(await call(discordModule({ sendDM: async () => ({ messageId: 'M1' }) }), 'dm', { userId: 'U1', content: 'hi' }),
    { success: true, data: { messageId: 'M1' } }, 'a client that gives no channel id');
});

test('a refused reply says the ids it names are its reply context\'s, and how to change them', async () => {
  const m = discordModule({ sendMessage: async () => { throw new DiscordRefusal('Nothing was sent: channel C5 has no message M5 that this bot can see.'); } });
  assert.equal((await call(m, 'set_reply_context', { channelId: 'C5', replyToMessageId: 'M5' })).success, true);
  assert.equal((await call(m, 'reply', { content: 'hi' })).error,
    'Nothing was sent: channel C5 has no message M5 that this bot can see. A reply goes where its reply context points: channel C5, answering message M5. '
    + 'discord--set_reply_context changes that.');
  assert.equal((await call(m, 'set_reply_context', { channelId: 'C5', threadId: 'T5' })).success, true);
  assert.equal((await call(m, 'reply', { content: 'hi' })).error,
    'Nothing was sent: channel C5 has no message M5 that this bot can see. A reply goes where its reply context points: thread T5. '
    + 'discord--set_reply_context changes that.');
  assert.equal((await call(m, 'set_reply_context', { channelId: 'C6', threadId: '' })).success, true);
  assert.match((await call(m, 'reply', { content: 'hi' })).error ?? '', / A reply goes where its reply context points: an empty thread id\. discord--set_reply_context changes that\.$/);
});

test('an unknown tool name lists the module\'s own tools', async () => {
  const discord = discordModule({});
  const names = discord.getTools().map((tool) => `discord--${tool.name}`);
  assert(names.length > 2);
  assert.deepEqual(await call(discord, 'post'), {
    success: false,
    error: `There's no tool "discord--post", so nothing ran. The discord module's tools are ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`,
    isError: true,
  });

  const health = await new HealthModule().handleToolCall({ id: 'call-2', name: 'status', input: {} });
  assert.deepEqual(health, { success: false, isError: true, error: 'There\'s no tool "health--status", so nothing ran. The health module\'s one tool is health--snapshot.' });

  const api = await new ApiModule().handleToolCall({ id: 'call-3', name: 'send', input: {} });
  assert.deepEqual(api, { success: false, error: 'There\'s no tool "api--send", so nothing ran. The api module has no tools of its own: every tool you can call is in your tool list.', isError: true });
});

test('a rate-limited send says how many seconds are left in its window', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const m = discordModule({ sendMessage: async () => ({ messageId: 'M1' }) }, { rateLimitPerMinute: 1 });
  assert.equal((await call(m, 'send', { channelId: 'C1', content: 'one' })).success, true);
  now += 20_500;
  assert.equal((await call(m, 'send', { channelId: 'C1', content: 'two' })).error,
    'Nothing was sent: channel C1 has reached this host\'s limit of 1 send a minute from the bot. Send it again in 40 seconds; other channels have their own limit.');
  assert.equal((await call(m, 'send', { channelId: 'C2', content: 'elsewhere' })).success, true, 'another channel has its own limit');
  // A send the limiter let through counts, though Discord refused it.
  const refusing = discordModule({ sendMessage: async () => { throw new DiscordRefusal('Nothing was sent: as the client worded it.'); } }, { rateLimitPerMinute: 1 });
  assert.equal((await call(refusing, 'send', { channelId: 'C3', content: 'one' })).error, 'Nothing was sent: as the client worded it.');
  assert.match((await call(refusing, 'send', { channelId: 'C3', content: 'two' })).error ?? '', /^Nothing was sent: channel C3 has reached this host's limit/);
  // The window's last instant still holds the limit, and says one second.
  now += 39_500;
  assert.equal((await call(m, 'send', { channelId: 'C1', content: 'two' })).error,
    'Nothing was sent: channel C1 has reached this host\'s limit of 1 send a minute from the bot. Send it again in 1 second; other channels have their own limit.');
  now += 1;
  assert.equal((await call(m, 'send', { channelId: 'C1', content: 'three' })).success, true, 'the window has ended');
  // After the clock is set back, the wait the refusal gives is still when
  // the channel takes a send again.
  now -= 120_000;
  const setBack = (await call(m, 'send', { channelId: 'C1', content: 'four' })).error ?? '';
  const seconds = Number(/Send it again in (\d+) seconds?;/.exec(setBack)?.[1]);
  assert.ok(seconds >= 1, setBack);
  now += seconds * 1_000 - 1;
  assert.match((await call(m, 'send', { channelId: 'C1', content: 'four' })).error ?? '', /^Nothing was sent: channel C1 has reached this host's limit/, 'still refused just before the wait it gave');
  now += 2;
  assert.equal((await call(m, 'send', { channelId: 'C1', content: 'four' })).success, true, 'taken just after the wait it gave');
});

test('a rate-limited reply says how many seconds are left in its conversation\'s window', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const m = discordModule({ sendMessage: async () => ({ messageId: 'M1' }) }, { rateLimitPerMinute: 1 });
  assert.equal((await call(m, 'set_reply_context', { channelId: 'C5' })).success, true);
  assert.equal((await call(m, 'reply', { content: 'one' })).success, true);
  now += 30_000;
  assert.equal((await call(m, 'reply', { content: 'two' })).error,
    'Nothing was sent: this conversation\'s channel (C5) has reached this host\'s limit of 1 send a minute from the bot. Reply again in 30 seconds.');
  // A reply into the conversation's thread counts against its channel too, and says so.
  assert.equal((await call(m, 'set_reply_context', { channelId: 'C5', threadId: 'T5' })).success, true);
  assert.equal((await call(m, 'reply', { content: 'three' })).error,
    'Nothing was sent: this conversation\'s channel (C5) has reached this host\'s limit of 1 send a minute from the bot, which counts its replies in thread T5 too. Reply again in 30 seconds.');
  // An empty thread id names no thread to count.
  assert.equal((await call(m, 'set_reply_context', { channelId: 'C5', threadId: '' })).success, true);
  assert.equal((await call(m, 'reply', { content: 'four' })).error,
    'Nothing was sent: this conversation\'s channel (C5) has reached this host\'s limit of 1 send a minute from the bot. Reply again in 30 seconds.');
});

test('reply without a conversation, and activate before the module starts, say what to do', async () => {
  const m = discordModule({});
  assert.equal((await call(m, 'reply', { content: 'hi' })).error,
    'Nothing was sent: there\'s no conversation to reply in. Use discord--send with a channelId to post somewhere, or discord--set_reply_context with a channelId to choose where replies go, then reply again.');
  for (const name of ['activate', 'deactivate']) {
    assert.equal((await call(m, name)).error,
      'Speech handling wasn\'t changed: the Discord module hasn\'t started on this host, or has stopped. Calling it again won\'t change that until it runs; ask whoever runs this host if you need Discord.', name);
  }
});

test('a health snapshot asked for before the host binds the module says so, and names the host\'s step on a console line', async (t) => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const result = await new HealthModule().handleToolCall({ id: 'call-4', name: 'snapshot', input: {} });
  assert.deepEqual(result, {
    success: false,
    isError: true,
    error: 'The health snapshot isn\'t available: this host hasn\'t finished setting up the health module, so nothing was read. Calling it again won\'t change that; ask whoever runs this host.',
  });
  assert(lines.some((line) => line.includes('bind(framework, store)')), lines.join('\n'));
});
