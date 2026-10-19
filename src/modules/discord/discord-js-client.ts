/**
 * Discord.js client adapter implementing DiscordClientInterface
 */

import {
  ChannelType,
  Client,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  DiscordjsTypeError,
  GatewayIntentBits,
  Partials,
  RESTJSONErrorCodes,
  TextChannel,
  DMChannel,
  type Channel,
  type Message,
  type Attachment,
  type User,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import type {
  DiscordClientInterface,
  DiscordMessageData,
  DiscordAttachment,
  DiscordGuild,
  DiscordChannel,
  HistoryMessage,
} from './types.js';
import { DiscordRefusal } from './refusal.js';

/** The ids a tool's call named, for the words of Discord's refusal. */
interface Named {
  channelId?: string;
  messageId?: string;
  guildId?: string;
  userId?: string;
  emoji?: string;
}

/** What a refused call was about, from the ids it named. */
function target(named: Named): string {
  return named.channelId !== undefined ? `channel ${named.channelId}`
    : named.guildId !== undefined ? `server ${named.guildId}`
    : `user ${named.userId}`;
}

/**
 * Discord's refusal of a request, worded for the agent: what was refused, and
 * the call that shows the right id, or who can change what Discord refused.
 * The codes are discord-api-types' RESTJSONErrorCodes, as discord.js 14.27
 * exports them. A code without a case of its own keeps Discord's own words.
 * `overrides` words a code as one tool means it.
 */
function refusalReason(error: DiscordAPIError, named: Named, overrides: Partial<Record<number, string>> = {}): string {
  const override = typeof error.code === 'number' ? overrides[error.code] : undefined;
  if (override !== undefined) return override;
  switch (error.code) {
    case RESTJSONErrorCodes.UnknownChannel:
      return `no ${target(named)} is visible to this bot. The id may be mistyped or remembered rather than copied; discord--list_guilds, then discord--list_channels with a guildId, shows the ids. Threads aren't listed there: a thread started from a message has that message's id, which discord--fetch_history of its channel shows. Nor are direct message channels: one's id is the channelId an earlier discord--dm to that user returned.`;
    case RESTJSONErrorCodes.UnknownGuild:
      return `no server ${named.guildId} is visible to this bot. discord--list_guilds shows the servers it is in, with their ids.`;
    case RESTJSONErrorCodes.UnknownMessage:
      return `channel ${named.channelId} has no message ${named.messageId} that this bot can see. discord--fetch_history with that channelId shows its recent messages and their ids.`;
    case RESTJSONErrorCodes.UnknownUser:
      return `Discord knows no user ${named.userId}. The id may be mistyped or remembered rather than copied; discord--fetch_history of a channel they wrote in shows its messages' authors' ids.`;
    case RESTJSONErrorCodes.UnknownEmoji:
      return unknownEmoji(named);
    case RESTJSONErrorCodes.MissingAccess:
      return `this bot can't see ${target(named)} (Discord answered "Missing Access"), and calling again won't change that. `
        + 'Ask whoever runs this host to give it access.';
    case RESTJSONErrorCodes.MissingPermissions:
      return `this bot isn't allowed to do that${named.channelId !== undefined || named.guildId !== undefined ? ` in ${target(named)}` : ''} (Discord answered "Missing Permissions"), and calling again won't change that. `
        + 'Ask whoever runs this host to grant the permission.';
    case RESTJSONErrorCodes.CannotEditMessageAuthoredByAnotherUser:
      return `message ${named.messageId} was written by someone else, and this bot can edit only its own messages.`;
    case RESTJSONErrorCodes.CannotSendMessagesToThisUser:
      return `Discord won't deliver a direct message from this bot ${named.userId !== undefined ? `to user ${named.userId}` : `in channel ${named.channelId}`}, usually because they share no server or don't accept direct messages, and calling again won't change that.`;
    default:
      return `Discord refused the request: ${error.message}`;
  }
}

/** Discord starts a thread from a message only in a server's text or announcement channel; a forum's or media channel's threads are its posts. */
function cantHoldThreads(named: Named): string {
  return `${target(named)} can't hold threads. A message can start one only in a server's text or announcement channel.`;
}

/** A message that has a thread: discord.js finds a message's thread by the message's own id (Message#thread). */
function existingThread(named: Named): string {
  return `message ${named.messageId} already has a thread, whose id is the message's own: discord--send with channelId ${named.messageId} posts in it.`;
}

function unknownEmoji(named: Named): string {
  return `Discord doesn't know the emoji ${JSON.stringify(named.emoji)}. Use a Unicode emoji, such as "👍", or a custom one as name:id from a server this bot is in.`;
}

/**
 * discord.js's own refusal of a call, before it sends any request: a message
 * whose channel can't hold threads, one that already has a thread, or an
 * emoji it can't read. Any other error has no words here.
 */
function localRefusalReason(error: unknown, named: Named): string | undefined {
  if (!(error instanceof DiscordjsError) && !(error instanceof DiscordjsTypeError)) return undefined;
  switch ((error as { code?: unknown }).code) {
    case DiscordjsErrorCodes.MessageThreadParent:
      return cantHoldThreads(named);
    case DiscordjsErrorCodes.MessageExistingThread:
      return existingThread(named);
    case DiscordjsErrorCodes.EmojiType:
      return `this bot can't read ${JSON.stringify(named.emoji)} as an emoji, so Discord wasn't asked. Use a Unicode emoji, such as "👍", or a custom one as name:id from a server this bot is in.`;
    default:
      return undefined;
  }
}

export interface DiscordJsClientConfig {
  token: string;
  guildIds?: string[];
  channelIds?: string[];
}

/** An attachment as both a live message and history carry it. */
function toAttachment(a: Attachment): DiscordAttachment {
  return {
    id: a.id,
    filename: a.name ?? 'unknown',
    url: a.url,
    contentType: a.contentType ?? undefined,
    size: a.size,
  };
}

export class DiscordJsClient implements DiscordClientInterface {
  private client: Client;
  private token: string;
  private guildIds?: string[];
  private channelIds?: string[];

  private messageHandler?: (message: DiscordMessageData) => void;
  private editHandler?: (messageId: string, newContent: string, attachments?: DiscordAttachment[]) => void;
  private deleteHandler?: (messageId: string) => void;
  private readyHandler?: () => void;

  constructor(config: DiscordJsClientConfig) {
    this.token = config.token;
    this.guildIds = config.guildIds;
    this.channelIds = config.channelIds;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('messageCreate', (message: Message) => {
      if (!this.shouldHandleMessage(message)) return;
      if (this.messageHandler) {
        this.messageHandler(this.convertMessage(message));
      }
    });

    this.client.on('messageUpdate', (oldMessage, newMessage) => {
      // content is null for a partial message, one discord.js hadn't cached
      // and whose update carried no text, so there's no text to compare; a
      // cached message keeps the text it had. An edit that leaves no text,
      // beside an attachment, is '' and is still an edit.
      if (typeof newMessage.content !== 'string' || !this.editHandler) return;
      // Its attachments as the edit left them, for a message discord.js had
      // cached: it takes the update's list when the update carries one and
      // keeps the cached list when it doesn't. A message it hadn't cached
      // starts with an empty list, so one whose update carried none would read
      // as having none; it passes none, and the row's blocks stay.
      this.editHandler(newMessage.id, newMessage.content, oldMessage.partial ? undefined : newMessage.attachments?.map(toAttachment));
    });

    this.client.on('messageDelete', (message) => {
      if (this.deleteHandler) {
        this.deleteHandler(message.id);
      }
    });

    this.client.on('ready', () => {
      console.log(`[Discord] Logged in as ${this.client.user?.tag}`);
      if (this.readyHandler) {
        this.readyHandler();
      }
    });

    this.client.on('error', (error: Error) => {
      console.error('[Discord] Client error:', error);
    });
  }

  private shouldHandleMessage(message: Message): boolean {
    // Never process our own messages (prevents feedback loop)
    if (message.author.id === this.client.user?.id) {
      return false;
    }

    // Filter by guild
    if (this.guildIds && this.guildIds.length > 0) {
      if (!message.guildId || !this.guildIds.includes(message.guildId)) {
        return false;
      }
    }

    // Filter by channel
    if (this.channelIds && this.channelIds.length > 0) {
      if (!this.channelIds.includes(message.channelId)) {
        return false;
      }
    }

    return true;
  }

  private convertMessage(message: Message): DiscordMessageData {
    const attachments = message.attachments.map(toAttachment);

    // Extract mentioned user IDs
    const mentionedUserIds = message.mentions.users.map((u: User) => u.id);

    return {
      id: message.id,
      content: message.content,
      authorId: message.author.id,
      authorName: message.author.username,
      isBot: message.author.bot,
      channelId: message.channelId,
      guildId: message.guildId ?? null,
      isReply: message.reference !== null,
      replyToId: message.reference?.messageId ?? undefined,
      // Note: replyToAuthorId requires fetching the referenced message
      // We'll leave it undefined for now - can be enhanced later if needed
      replyToAuthorId: undefined,
      mentionedUserIds,
      attachments,
      timestamp: message.createdAt,
    };
  }

  async connect(): Promise<void> {
    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string; createThread?: { name: string } }
  ): Promise<{ messageId: string; threadFailure?: string; note?: string }> {
    const lead = 'Nothing was sent';
    const { textChannel, message } = await this.asked(lead, { channelId }, async () => {
      const textChannel = await this.lookup(lead, `channel ${channelId}`, () => this.messageChannel(channelId, lead, 'send')) as TextChannel | DMChannel;
      const message = await textChannel.send({
        content,
        reply: options?.replyTo ? { messageReference: options.replyTo } : undefined,
      });
      return { textChannel, message };
    });

    if (!options?.createThread) return { messageId: message.id };
    // A channel without threads, such as a DM, gets none, and the send
    // succeeds, as it did; its note says so.
    if (!('threads' in textChannel)) {
      return { messageId: message.id, note: `No thread was started: ${cantHoldThreads({ channelId })}` };
    }
    const threadFailure = await this.threadAfterSend(message, channelId, options.createThread.name);
    return threadFailure === undefined ? { messageId: message.id } : { messageId: message.id, threadFailure };
  }

  /**
   * Starts the thread a send asked for. The message is out by then, so when
   * the thread isn't started, why is returned rather than thrown, in words
   * that say the message was sent, lest the agent send it again.
   */
  private async threadAfterSend(message: Message, channelId: string, name: string): Promise<string | undefined> {
    const sent = `The message was sent (id ${message.id}), so don't send it again`;
    const named = { channelId, messageId: message.id };
    const startOne = `discord--create_thread with channelId ${channelId}, messageId ${message.id} and a name`;
    try {
      await message.startThread({ name });
      return undefined;
    } catch (error) {
      if (error instanceof DiscordAPIError) {
        // Discord answers a retried start that it had already carried out as
        // a thread that exists: say it's there.
        if (error.code === RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) return `${sent}, and its thread exists already, with the message's own id, ${message.id}.`;
        // The message is out, and `named` holds it, so no sentence points
        // elsewhere, where posting it again would post it twice.
        // The bot has just posted in the channel, so Missing Access is about
        // its threads, not about seeing it.
        const permission = `this bot isn't allowed to start threads in channel ${channelId} (Discord answered "Missing Permissions"), and calling again won't change that. Ask whoever runs this host to grant the permission.`;
        const access = `this bot can't start threads in channel ${channelId} (Discord answered "Missing Access"), and calling again won't change that. Ask whoever runs this host to give it access.`;
        return `${sent}, but no thread was started: ${refusalReason(error, named, { [RESTJSONErrorCodes.MissingPermissions]: permission, [RESTJSONErrorCodes.MissingAccess]: access })} Once that's settled, ${startOne} starts one.`;
      }
      // The thread refusals localRefusalReason words, a message outside a
      // text or announcement channel and one that has a thread, can't come
      // for a message just sent in a channel that holds threads.
      return `${sent}, but starting its thread stopped on an unexpected error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Whether the thread exists is unknown: discord--fetch_history with channelId ${message.id} reads the thread if it exists and is refused if it doesn't, and then ${startOne} starts one.`;
    }
  }

  async sendDM(userId: string, content: string): Promise<{ messageId: string; channelId: string }> {
    const lead = 'Nothing was sent';
    return this.asked(lead, { userId }, async () => {
      const user = await this.lookup(lead, `user ${userId}`, () => this.client.users.fetch(userId));
      // User#send opens the direct message channel first, which sends nothing.
      const channel = await this.lookup(lead, `the direct message channel with user ${userId}`, () => user.createDM());
      const message = await channel.send(content);
      return { messageId: message.id, channelId: message.channelId };
    });
  }

  async fetchMessage(channelId: string, messageId: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const message = await (channel as TextChannel).messages.fetch(messageId);
    return message.content;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const lead = 'Nothing was edited';
    await this.asked(lead, { channelId, messageId }, async () => {
      const message = await this.findMessage(channelId, messageId, lead);
      await message.edit(content);
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const lead = 'Nothing was deleted';
    try {
      await this.asked(lead, { channelId, messageId }, async () => {
        const message = await this.findMessage(channelId, messageId, lead);
        await message.delete();
      });
    } catch (error) {
      // A message that isn't there may be one an earlier call deleted, or a
      // retried request of this one, so its sentence has no lead.
      if (error instanceof DiscordRefusal && error.cause instanceof DiscordAPIError && error.cause.code === RESTJSONErrorCodes.UnknownMessage) {
        throw new DiscordRefusal(`Channel ${channelId} has no message ${messageId} now: it's deleted, or the id is wrong. discord--fetch_history with that channelId shows its recent messages and their ids.`, { cause: error.cause });
      }
      throw error;
    }
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const lead = 'No reaction was added';
    await this.asked(lead, { channelId, messageId, emoji }, async () => {
      const message = await this.findMessage(channelId, messageId, lead);
      await message.react(emoji);
    });
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
    autoArchiveDuration?: number
  ): Promise<{ threadId: string }> {
    const lead = 'No thread was started';
    try {
      return await this.asked(lead, { channelId, messageId }, async () => {
        const message = await this.findMessage(channelId, messageId, lead);
        const thread = await message.startThread({
          name,
          autoArchiveDuration: (autoArchiveDuration as 60 | 1440 | 4320 | 10080) ?? 1440,
        });
        return { threadId: thread.id };
      });
    } catch (error) {
      // Discord's answer for a message that has a thread, whether an earlier
      // call started it or a retried request of this one did.
      if (error instanceof DiscordRefusal && error.cause instanceof DiscordAPIError && error.cause.code === RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) {
        throw new DiscordRefusal(`Message ${messageId} has a thread already, whose id is the message's own: discord--send with channelId ${messageId} posts in it.`, { cause: error.cause });
      }
      throw error;
    }
  }

  /**
   * The message a tool acts on, looked up in its channel. An empty id is
   * refused before any request: discord.js fetches a channel's recent
   * messages for one, not a message.
   */
  private findMessage(channelId: string, messageId: string, lead: string): Promise<Message> {
    if (!messageId) {
      return Promise.reject(new DiscordRefusal(`${lead}: the call gave no message id. discord--fetch_history with channelId ${channelId} shows its recent messages and their ids.`));
    }
    return this.lookup(lead, `message ${messageId} in channel ${channelId}`,
      async () => (await this.messageChannel(channelId, lead, 'messages')).messages.fetch(messageId));
  }

  /**
   * Runs a lookup a tool makes before its change. A lookup sends, edits and
   * removes nothing, so one that stops on an unexpected error, such as a
   * network failure, means the tool did nothing, which a refusal led by
   * `lead` says, and calling it again is safe: opening a direct message
   * channel, the one lookup that can make something on Discord, opens the
   * same channel again. Discord refusing it, or a refusal of this module's
   * own, passes on as it is; anything else, discord.js's own errors
   * included, is the unexpected stop.
   */
  private async lookup<T>(lead: string, what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof DiscordAPIError || error instanceof DiscordRefusal) throw error;
      throw new DiscordRefusal(`${lead}: looking up ${what} stopped on an unexpected error: ${error instanceof Error ? error.message : String(error)}. Calling it again is safe.`, { cause: error });
    }
  }

  /**
   * Runs one tool's requests. Discord refusing any of them, which discord.js
   * reports as a DiscordAPIError, becomes a DiscordRefusal led by `lead`, with
   * Discord's error as its cause: a tool's change is its last request, so it
   * wasn't made. So does discord.js refusing a call before it sends one
   * (localRefusalReason). Anything else passes through as an unexpected error.
   */
  private async asked<T>(lead: string, named: Named, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof DiscordAPIError) throw new DiscordRefusal(`${lead}: ${refusalReason(error, named)}`, { cause: error });
      const local = localRefusalReason(error, named);
      if (local !== undefined) throw new DiscordRefusal(`${lead}: ${local}`, { cause: error });
      throw error;
    }
  }

  /**
   * The channel `channelId` names, when it holds messages (and, with 'send',
   * takes them). A channel Discord knows but that holds none, such as a
   * category, is refused with what it is.
   */
  private async messageChannel(channelId: string, lead: string, need: 'messages' | 'send'): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(need in channel)) {
      throw new DiscordRefusal(`${lead}: ${this.holdsNoMessages(channelId, channel)}`);
    }
    return channel as TextChannel;
  }

  private holdsNoMessages(channelId: string, channel: Channel | null): string {
    if (!channel) {
      return `this bot can't use channel ${channelId}: Discord answered for it, but it's a kind of channel this bot doesn't handle, or its server isn't loaded here, and calling again won't change that. Ask whoever runs this host if you need it.`;
    }
    const type = this.mapChannelType(channel.type);
    const inPosts = (kind: string) => `${kind}, whose messages are in its posts, each a thread with its own id, which this module has no tool to list`;
    const is = type === 'category' ? 'a category, which holds channels, not messages'
      : type === 'forum' ? inPosts('a forum')
      : channel.type === ChannelType.GuildMedia ? inPosts('a media channel')
      : type === 'unknown' ? 'a kind of channel that holds no messages'
      : `a ${type} channel, which holds no messages`;
    return `channel ${channelId} is ${is}. discord--list_channels with a guildId shows the server's channels and their ids.`;
  }

  onMessage(handler: (message: DiscordMessageData) => void): void {
    this.messageHandler = handler;
  }

  onMessageEdit(handler: (messageId: string, newContent: string, attachments?: DiscordAttachment[]) => void): void {
    this.editHandler = handler;
  }

  onMessageDelete(handler: (messageId: string) => void): void {
    this.deleteHandler = handler;
  }

  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }

  getBotUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('sendTyping' in channel)) {
      throw new Error(`Channel ${channelId} not found or not a text channel`);
    }
    await (channel as TextChannel).sendTyping();
  }

  async listGuilds(): Promise<DiscordGuild[]> {
    const guilds = this.client.guilds.cache;
    return guilds.map((g: Guild) => ({
      id: g.id,
      name: g.name,
      iconUrl: g.iconURL() ?? undefined,
      memberCount: g.memberCount,
    }));
  }

  async listChannels(guildId: string): Promise<DiscordChannel[]> {
    // An unknown or unreachable server is Discord's refusal (fetch throws);
    // a fetched Guild always carries its channel manager.
    const channels = await this.asked('Nothing was listed', { guildId }, async () => {
      const guild = await this.client.guilds.fetch(guildId);
      return guild.channels.fetch();
    });
    const result: DiscordChannel[] = [];
    
    channels.forEach((c: GuildBasedChannel | null) => {
      if (c) {
        result.push({
          id: c.id,
          name: c.name,
          type: this.mapChannelType(c.type),
          parentId: c.parentId ?? undefined,
          position: 'position' in c ? (c as { position?: number }).position : undefined,
        });
      }
    });
    
    return result;
  }

  private mapChannelType(type: number | undefined): DiscordChannel['type'] {
    if (type === undefined) return 'unknown';
    // Discord.js channel types: 0=text, 2=voice, 4=category, 11=thread, 15=forum
    switch (type) {
      case 0: return 'text';
      case 2: return 'voice';
      case 4: return 'category';
      case 11:
      case 12: return 'thread';
      case 15: return 'forum';
      default: return 'unknown';
    }
  }

  async fetchHistory(
    channelId: string,
    options?: { limit?: number; before?: string }
  ): Promise<HistoryMessage[]> {
    const lead = 'No history was read';
    const messages = await this.asked(lead, { channelId, messageId: options?.before }, async () => {
      const textChannel = await this.messageChannel(channelId, lead, 'messages');
      return textChannel.messages.fetch({
        limit: options?.limit ?? 50,
        before: options?.before,
      });
    });

    return messages.map((m: Message) => ({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.username,
      isBot: m.author.bot,
      content: m.content,
      attachments: m.attachments.map(toAttachment),
      timestamp: m.createdAt,
      replyTo: m.reference
        ? {
            messageId: m.reference.messageId ?? '',
            authorId: '', // Would need additional fetch to get this
          }
        : undefined,
    }));
  }
}
