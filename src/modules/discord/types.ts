/**
 * Types for the Discord module
 */

import type { ContentBlock } from '@animalabs/membrane';

// ============================================================================
// Module Configuration
// ============================================================================

export interface DiscordModuleConfig {
  /** IANA zone for timestamps returned to the agent by fetch_history. */
  timeZone?: string;

  /** Discord bot token */
  token: string;

  /** Guild IDs to listen to (optional, defaults to all guilds the bot is in) */
  guildIds?: string[];

  /** Channel IDs to listen to (optional, defaults to all channels) */
  channelIds?: string[];

  /** Whether to handle DMs (default: true) */
  handleDMs?: boolean;

  /** Prefix for commands (optional, e.g., '!' or '/') */
  commandPrefix?: string;

  /** Whether to ignore bot messages (default: true) */
  ignoreBots?: boolean;

  /** Rate limit: max messages per minute per channel (default: 30) */
  rateLimitPerMinute?: number;

  /**
   * When to trigger agent inference (default: 'mention')
   * - 'all': Every message triggers inference (use with caution!)
   * - 'mention': Only when bot is @mentioned
   * - 'mention_or_reply': When mentioned OR when replying to bot's message
   * - 'dm_or_mention': DMs always trigger, channels require mention
   */
  triggerOn?: 'all' | 'mention' | 'mention_or_reply' | 'dm_or_mention';

  /** 
   * Auto-send typing indicator when agent is activated (default: true)
   */
  autoTyping?: boolean;

  /**
   * Number of messages to fetch on history sync (default: 50)
   */
  historyScrollback?: number;
}

// ============================================================================
// Module State
// ============================================================================

export interface DiscordModuleState {
  /** Currently connected guild IDs */
  connectedGuilds: string[];

  /** Active conversation contexts */
  conversations: Record<string, ConversationContext>;

  /** Rate limit tracking */
  rateLimits: Record<string, RateLimitInfo>;

  /** Bot user ID (set after connect) */
  botUserId?: string;

  /** Last read message ID per channel (for history sync) */
  lastReadMessageId: Record<string, string>;
}

export interface ConversationContext {
  /** Channel ID for replies */
  channelId: string;

  /** Thread ID if in a thread */
  threadId?: string;

  /** Message ID to reply to */
  replyToMessageId?: string;

  /** User who started the conversation */
  userId: string;

  /** Guild ID (null for DMs) */
  guildId: string | null;

  /** Last activity timestamp */
  lastActivity: number;
}

export interface RateLimitInfo {
  /** Messages sent in current window */
  count: number;

  /** Window start timestamp */
  windowStart: number;
}

// ============================================================================
// Tool Inputs
// ============================================================================

export interface SendInput {
  /** Channel ID to send to */
  channelId: string;

  /** Content to send */
  content: string;

  /** Whether to create a thread (optional) */
  createThread?: {
    name: string;
  };

  /** Message ID to reply to (optional) */
  replyTo?: string;
}

export interface SendDMInput {
  /** User ID to DM */
  userId: string;

  /** Content to send */
  content: string;
}

export interface ReplyInput {
  /** Content to send */
  content: string;

  /** Whether to mention the user (default: false) */
  mention?: boolean;
}

export interface ReactInput {
  /** Channel ID containing the message */
  channelId: string;

  /** Message ID to react to */
  messageId: string;

  /** Emoji to react with (unicode or custom emoji ID) */
  emoji: string;
}

export interface EditMessageInput {
  /** Channel ID containing the message */
  channelId: string;

  /** Message ID to edit */
  messageId: string;

  /** New content */
  content: string;
}

export interface DeleteMessageInput {
  /** Channel ID containing the message */
  channelId: string;

  /** Message ID to delete */
  messageId: string;
}

export interface CreateThreadInput {
  /** Channel ID to create thread in */
  channelId: string;

  /** Message ID to start thread from */
  messageId: string;

  /** Thread name */
  name: string;

  /** Auto-archive duration in minutes (60, 1440, 4320, 10080) */
  autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
}

export interface SetReplyContextInput {
  /** Channel ID for future replies */
  channelId: string;

  /** Thread ID (optional) */
  threadId?: string;

  /** Message ID to reply to (optional) */
  replyToMessageId?: string;
}

export interface ListGuildsInput {
  // No parameters needed
}

export interface ListChannelsInput {
  /** Guild ID to list channels for */
  guildId: string;
}

export interface FetchHistoryInput {
  /** Channel ID to fetch history from */
  channelId: string;

  /** Number of messages to fetch (default: 50) */
  limit?: number;

  /** Fetch messages before this message ID */
  before?: string;
}

// ============================================================================
// Discord Data Types (returned by tools)
// ============================================================================

export interface DiscordGuild {
  /** Guild ID */
  id: string;

  /** Guild name */
  name: string;

  /** Guild icon URL (optional) */
  iconUrl?: string;

  /** Number of members */
  memberCount?: number;
}

export interface DiscordChannel {
  /** Channel ID */
  id: string;

  /** Channel name */
  name: string;

  /** Channel type */
  type: 'text' | 'voice' | 'category' | 'thread' | 'forum' | 'unknown';

  /** Parent category ID (if applicable) */
  parentId?: string;

  /** Position in channel list */
  position?: number;
}

export interface HistoryMessage {
  /** Message ID */
  id: string;

  /** Author user ID */
  authorId: string;

  /** Author username */
  authorName: string;

  /** Whether author is a bot */
  isBot: boolean;

  /** Message content */
  content: string;

  /** Attachments, as the live path's DiscordMessageData carries them. A
   *  client that doesn't map them leaves this out: the history sync then
   *  stores a message it missed without them, and rebuilds no row, since it
   *  can't tell what the row should hold, though it still changes a row's
   *  text as a live edit does. */
  attachments?: DiscordAttachment[];

  /** Timestamp */
  timestamp: Date;

  /** Reply info (if this is a reply) */
  replyTo?: {
    messageId: string;
    authorId: string;
  };
}

// ============================================================================
// Discord Events (internal)
// ============================================================================

export interface DiscordMessageData {
  /** Discord message ID */
  id: string;

  /** Channel ID */
  channelId: string;

  /** Guild ID (null for DMs) */
  guildId: string | null;

  /** Author user ID */
  authorId: string;

  /** Author username */
  authorName: string;

  /** Whether the author is a bot */
  isBot: boolean;

  /** Message content */
  content: string;

  /** Whether this is a reply */
  isReply: boolean;

  /** ID of message being replied to */
  replyToId?: string;

  /** Author ID of the message being replied to */
  replyToAuthorId?: string;

  /** User IDs mentioned in this message */
  mentionedUserIds: string[];

  /** Attachments */
  attachments: DiscordAttachment[];

  /** Timestamp */
  timestamp: Date;
}

export interface DiscordAttachment {
  /** Attachment ID */
  id: string;

  /** Filename */
  filename: string;

  /** URL */
  url: string;

  /** Content type */
  contentType?: string;

  /** Size in bytes */
  size: number;
}

// ============================================================================
// Discord Custom Events (for event queue)
// ============================================================================

/**
 * Custom event for new Discord messages.
 * Pushed to queue by callbacks, processed in onProcess().
 */
export interface DiscordMessageEvent {
  type: 'discord:message';
  discordMessageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  /** Pre-converted content blocks (includes attachments) */
  contentBlocks?: ContentBlock[];
  timestamp: number;
  attachments: DiscordAttachment[];
  /** Whether this message should trigger agent inference */
  shouldTriggerInference?: boolean;
  [key: string]: unknown; // Required for CustomEvent compatibility
}

/**
 * Custom event for Discord message edits.
 */
export interface DiscordEditEvent {
  type: 'discord:edit';
  discordMessageId: string;
  newContent: string;
  /** The message's attachments as the edit left them, when the client knows
   *  them: a stored row whose text comes first drops the blocks of those it
   *  no longer has. */
  attachments?: DiscordAttachment[];
  [key: string]: unknown;
}

/**
 * Custom event for Discord message deletions.
 */
export interface DiscordDeleteEvent {
  type: 'discord:delete';
  discordMessageId: string;
  [key: string]: unknown;
}

/**
 * Union of all Discord custom events.
 */
export type DiscordEvent = DiscordMessageEvent | DiscordEditEvent | DiscordDeleteEvent;

// ============================================================================
// Discord Client Interface (for abstraction)
// ============================================================================

/**
 * Abstract interface for Discord client operations.
 * Allows for real discord.js client or mock for testing.
 */
export interface DiscordClientInterface {
  /** Connect to Discord */
  connect(): Promise<void>;

  /** Disconnect from Discord */
  disconnect(): Promise<void>;

  /** Get the bot's user ID (available after connect) */
  getBotUserId(): string | null;

  /**
   * Send a message to a channel, and start the thread `createThread` asks
   * for when the channel can hold threads. When this resolves, the message
   * was sent. `threadFailure`, when there is one, is why the thread it tried
   * to start wasn't, which the send reports as its error; `note`, when there
   * is one, is something the agent should know of a send that succeeded,
   * such as a thread its channel can't hold. DiscordJsClient words both for
   * the agent.
   */
  sendMessage(
    channelId: string,
    content: string,
    options?: {
      replyTo?: string;
      createThread?: { name: string };
    }
  ): Promise<{ messageId: string; threadFailure?: string; note?: string }>;

  /** Send a DM to a user. `channelId`, when the client gives it, is the direct message channel's id, which history reads. */
  sendDM(userId: string, content: string): Promise<{ messageId: string; channelId?: string }>;

  /** Fetch a message's text content */
  fetchMessage(channelId: string, messageId: string): Promise<string>;

  /** Edit a message */
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;

  /** Delete a message */
  deleteMessage(channelId: string, messageId: string): Promise<void>;

  /** Add a reaction */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /** Create a thread */
  createThread(
    channelId: string,
    messageId: string,
    name: string,
    autoArchiveDuration?: number
  ): Promise<{ threadId: string }>;

  /** Send typing indicator to a channel */
  sendTyping(channelId: string): Promise<void>;

  /** List guilds the bot is in */
  listGuilds(): Promise<DiscordGuild[]>;

  /** List channels in a guild */
  listChannels(guildId: string): Promise<DiscordChannel[]>;

  /** Fetch message history from a channel */
  fetchHistory(
    channelId: string,
    options?: { limit?: number; before?: string }
  ): Promise<HistoryMessage[]>;

  /** Register message handler */
  onMessage(handler: (message: DiscordMessageData) => void): void;

  /** Register message edit handler. A client that knows the edited
   *  message's attachments passes them third; one that passes two arguments
   *  leaves a stored row's attachment blocks as they are. */
  onMessageEdit(handler: (messageId: string, newContent: string, attachments?: DiscordAttachment[]) => void): void;

  /** Register message delete handler */
  onMessageDelete(handler: (messageId: string) => void): void;

  /** Register ready handler (called when connected and ready) */
  onReady?(handler: () => void): void;

  /** Check if connected */
  isConnected(): boolean;
}
