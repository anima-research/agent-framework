/**
 * Discord Module - Discord integration for agent framework
 *
 * Provides:
 * - Listening to Discord messages and routing to agents
 * - Sending agent speech to Discord channels
 * - Tools for explicit Discord operations (send, DM, react, etc.)
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  SpeechContext,
  TraceEvent,
} from '../../types/index.js';
import type {
  DiscordModuleConfig,
  DiscordModuleState,
  ConversationContext,
  DiscordAttachment,
  DiscordClientInterface,
  DiscordMessageData,
  DiscordMessageEvent,
  DiscordEditEvent,
  DiscordDeleteEvent,
  HistoryMessage,
  SendInput,
  SendDMInput,
  ReplyInput,
  ReactInput,
  EditMessageInput,
  DeleteMessageInput,
  CreateThreadInput,
  SetReplyContextInput,
  ListGuildsInput,
  ListChannelsInput,
  FetchHistoryInput,
} from './types.js';
import { formatZonedDateTime, resolveTimeZone } from '../../timezone.js';
import { logValue } from '../../mcpl/log-value.js';

// Re-export event types for consumers who want to handle them
export type { DiscordMessageEvent, DiscordEditEvent, DiscordDeleteEvent } from './types.js';

export * from './types.js';
export { DiscordJsClient, type DiscordJsClientConfig } from './discord-js-client.js';

const DEFAULT_CONFIG: Partial<DiscordModuleConfig> = {
  handleDMs: true,
  ignoreBots: true,
  rateLimitPerMinute: 30,
  triggerOn: 'mention_or_reply',
  autoTyping: true,
  historyScrollback: 50,
};

// Re-trigger the Discord typing indicator on this interval. Discord's
// indicator auto-expires after ~10s, so we refresh comfortably inside that.
const TYPING_REFRESH_MS = 8_000;

// Absolute safety cap on a single typing keepalive. If a terminal trace event
// is somehow missed (crash, dropped stream), this guarantees typing can't get
// stuck on forever.
const TYPING_MAX_MS = 5 * 60_000;

// Trace event types that end an agent's turn (onTrace's contract) — any of
// these stops the typing keepalive. A turn's tool-call cycles stay inside its
// stream, so they come after them. inference:completed is the normal end.
const TURN_TERMINAL_TRACES = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:failed',
  'inference:exhausted',
]);

// Image MIME types that Claude can process
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

// Text file extensions for inline reading
const TEXT_FILE_EXTENSIONS = [
  '.txt', '.md', '.json', '.yaml', '.yml', '.toml',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs',
  '.html', '.css', '.xml', '.csv', '.log', '.sh', '.bash',
];

const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** What the agent reads for a text attachment whose contents couldn't be
 *  fetched: by an error, or by an answer that wasn't OK. */
function attachmentNotFetched(filename: string): { type: 'text'; text: string } {
  return { type: 'text', text: `[Attachment: ${filename} (failed to fetch)]` };
}

/** What a stored message reads when it has no text of its own and nothing the
 *  host added, so the agent still sees that a message was there. */
const EMPTY_MESSAGE = '[Empty message]';

/**
 * Metadata on a stored Discord message whose first block is its own text,
 * '' when it has none, and every block after it the host's: images, inlined
 * file text, attachment notes and EMPTY_MESSAGE. An edit replaces content and
 * can't touch metadata, so the mark holds for the row's life, and it tells an
 * edit or a sync which block is Discord's to replace. For the same reason a
 * row stored before the mark never gets it, even once a history sync
 * rebuilds it in this layout. The request builder drops an empty text block,
 * as it does wherever one occurs.
 */
const TEXT_FIRST = 'discordTextFirst';

/** A message's own text as a stored row holds it: '' when it's blank. */
function ownText(content: string): string {
  return content.trim() ? content : '';
}

const isEmptyMarker = (block: ContentBlock): boolean => block.type === 'text' && block.text === EMPTY_MESSAGE;
const isBlankText = (block: ContentBlock): boolean => block.type === 'text' && !block.text.trim();

/**
 * A text-first row's content: the message's own text, '' when it has none,
 * then `after`, what the host added; EMPTY_MESSAGE when there's neither.
 */
function textFirst(text: string, after: ContentBlock[] = []): ContentBlock[] {
  return [{ type: 'text', text }, ...(text || after.length > 0 ? after : [{ type: 'text' as const, text: EMPTY_MESSAGE }])];
}

/** A text-first row's content with `text` as the message's own text, in
 *  place of its first block, keeping what the host added after it. */
function withOwnText(content: ContentBlock[], text: string): ContentBlock[] {
  return textFirst(ownText(text), content.slice(1).filter((block) => !isEmptyMarker(block)));
}

/**
 * The content a stored Discord message should hold once Discord's text for it
 * is `discordText`, or null when it holds that already.
 *
 * A text-first row keeps every block the host added and replaces only its own
 * text; EMPTY_MESSAGE goes once there is text, and comes back when nothing is
 * left. A row stored before that layout held its own text first when it had
 * any, but a message without text began with what the host added, which may
 * be text, a file's contents or a note, so its first block can't be told
 * apart. Such a row is left alone unless Discord's text is there and differs
 * from its first block, and then that text takes the first block's place
 * when it's text, and goes before it when it isn't, and EMPTY_MESSAGE goes.
 * So a message without text, stored beginning with a file's contents or a
 * note, loses that block. The history sync, which has the message's
 * attachments, rebuilds such a row instead (needsRebuild).
 */
function contentForText(stored: StoredMessage, discordText: string): ContentBlock[] | null {
  const text = ownText(discordText);
  const [first, ...rest] = stored.content;
  if (stored.metadata?.[TEXT_FIRST] === true) {
    if (first?.type === 'text' && first.text === text) return null;
    return withOwnText(stored.content, text);
  }
  if (!text || (first?.type === 'text' && first.text === discordText)) return null;
  return [{ type: 'text', text: discordText }, ...(first?.type === 'text' ? rest : stored.content).filter((block) => !isEmptyMarker(block))];
}

/**
 * Whether a stored row lacks or holds more than the live conversion gives
 * Discord's `message` now, its own text aside, so the history sync stores it
 * through that conversion again. The conversion gives each attachment one
 * block: an image, a file's text, or a note when it isn't fetched or isn't
 * read. So a text-first row holds one block per attachment after its text,
 * EMPTY_MESSAGE aside, which the text's rule keeps. A row stored before that
 * layout held its text, when it had any, then those blocks, or EMPTY_MESSAGE
 * alone; one that doesn't was blanked or stripped by an earlier edit or sync,
 * or its message gained or lost text, or lost an attachment. Its first block,
 * when it is the message's own text, counts as that text, even when the text
 * reads as EMPTY_MESSAGE. For a message without text of its own, a first
 * block that's text may be what the host added or a caption the message has
 * since lost, which no count tells apart, so that row is stored again; it
 * then begins with its own '' text. One whose text alone changed is left to
 * the text's rule, which keeps the blocks after it. History without
 * attachments can't be compared, so it rebuilds nothing.
 */
function needsRebuild(stored: StoredMessage, message: HistoryMessage): boolean {
  if (message.attachments === undefined) return false;
  const attachments = message.attachments.length;
  const held = (blocks: ContentBlock[]) => blocks.filter((block) => !isBlankText(block) && !isEmptyMarker(block)).length;
  if (stored.metadata?.[TEXT_FIRST] === true) return held(stored.content.slice(1)) !== attachments;
  const own = ownText(message.content);
  const [first, ...rest] = stored.content;
  if (!own && first?.type === 'text' && !isBlankText(first) && !isEmptyMarker(first)) return true;
  const expected = (own ? 1 : 0) + attachments;
  const counted = own && first?.type === 'text' && first.text === own ? 1 + held(rest) : held(stored.content);
  return counted !== expected || (expected === 0 && !stored.content.some(isEmptyMarker));
}

/**
 * Whether a row holds non-blank text besides its message's own text now,
 * which may be what a file gave. A marked row whose message's text changed
 * counts its old text here too, which can delay its rebuild until a fetch
 * succeeds but never loses text.
 */
function holdsOtherText(stored: StoredMessage, message: HistoryMessage): boolean {
  const own = ownText(message.content);
  const [first, ...rest] = stored.content;
  const others = own && first?.type === 'text' && first.text === own ? rest : stored.content;
  return others.some((block) => block.type === 'text' && !isBlankText(block) && !isEmptyMarker(block));
}

/** Whether a message's conversion holds, after the message's own text, the
 *  note for an attachment of its whose text wasn't fetched. */
function holdsNotFetched(content: ContentBlock[], message: HistoryMessage): boolean {
  const notes = new Set((message.attachments ?? []).map((attachment) => attachmentNotFetched(attachment.filename).text));
  return content.slice(1).some((block) => block.type === 'text' && notes.has(block.text));
}

/**
 * Discord module for the agent framework.
 */
export class DiscordModule implements Module {
  readonly name = 'discord';

  private config: DiscordModuleConfig;
  private readonly timeZone: string;
  private ctx: ModuleContext | null = null;
  private client: DiscordClientInterface;
  private state: DiscordModuleState = {
    connectedGuilds: [],
    conversations: {},
    rateLimits: {},
    lastReadMessageId: {},
  };

  // Track current reply context per agent
  private replyContexts: Map<string, ConversationContext> = new Map();

  // Last message sent by a tool (for thought-editing)
  private lastSentMessage: { channelId: string; messageId: string } | null = null;

  // One set per running history sync: the Discord messages the live path
  // stored, edited or was told were deleted since that sync began. What the
  // live path saw is newer than what the sync fetched, so the sync leaves
  // those messages alone.
  private readonly liveDuringSync = new Set<Set<string>>();

  // Typing keepalive: agentName -> { interval, deadline }. Started on
  // inference:started, stopped on the turn's terminal trace event. Discord's
  // typing indicator auto-expires after ~10s, so we re-trigger on an interval
  // to keep it alive for the whole turn (including tool-call cycles).
  private typingLoops: Map<string, { interval: ReturnType<typeof setInterval>; deadline: number }> = new Map();

  // Unsubscribe handle for the trace subscription (cleared in stop()).
  private unsubscribeTrace: (() => void) | null = null;

  constructor(client: DiscordClientInterface, config: DiscordModuleConfig) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.timeZone = resolveTimeZone(config.timeZone);
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Load persisted state
    const savedState = ctx.getState<DiscordModuleState>();
    if (savedState) {
      this.state = savedState;
      // Clean up old conversations
      this.cleanupOldConversations();
    }

    // Register as speech handler
    ctx.registerSpeechHandler('*');

    // Typing keepalive: bracket the indicator between an agent starting
    // inference and its turn ending, so it stays alive for the whole turn
    // (including tool-call cycles) and stops cleanly whether the agent
    // responds, errors, or decides to stay silent.
    if (this.config.autoTyping) {
      this.unsubscribeTrace = ctx.onTrace((event: TraceEvent) => {
        const agentName = (event as { agentName?: string }).agentName;
        if (!agentName) return;
        if (event.type === 'inference:started' && !event.silent) {
          this.startTypingLoop(agentName);
        } else if (TURN_TERMINAL_TRACES.has(event.type)) {
          this.stopTypingLoop(agentName);
        }
      });
    }

    // Set up Discord event handlers
    this.client.onMessage((message) => this.handleDiscordMessage(message));
    this.client.onMessageEdit((id, content) => this.handleDiscordMessageEdit(id, content));
    this.client.onMessageDelete((id) => this.handleDiscordMessageDelete(id));

    // Set up ready handler for history sync on (re)connect
    if (this.client.onReady) {
      this.client.onReady(() => this.handleReady());
    }

    // Connect to Discord
    if (!ctx.isRestart || !this.client.isConnected()) {
      await this.client.connect();
    } else {
      // Already connected (restart) - sync history now
      await this.syncAllChannelHistory();
    }

    // Get bot user ID after connect
    const botUserId = this.client.getBotUserId();
    if (botUserId) {
      this.state.botUserId = botUserId;
      ctx.setState(this.state);
    }
  }

  async stop(): Promise<void> {
    // Save state
    if (this.ctx) {
      this.ctx.setState(this.state);
    }

    // Tear down typing keepalive: drop the trace subscription and clear any
    // in-flight intervals so nothing leaks across teardown/recreate.
    this.unsubscribeTrace?.();
    this.unsubscribeTrace = null;
    for (const { interval } of this.typingLoops.values()) {
      clearInterval(interval);
    }
    this.typingLoops.clear();

    await this.client.disconnect();
    this.ctx = null;
  }

  /**
   * Start (or refresh) the typing keepalive for an agent's reply channel.
   * Idempotent: a fresh `inference:started` resets the safety deadline and
   * restarts the interval. No-op if we can't resolve a channel for the agent.
   */
  private startTypingLoop(agentName: string): void {
    const replyCtx = this.replyContexts.get(agentName) ?? this.replyContexts.get('default');
    if (!replyCtx) return;
    const channel = replyCtx.threadId ?? replyCtx.channelId;

    // Restart cleanly if one is already running for this agent.
    this.stopTypingLoop(agentName);

    const deadline = Date.now() + TYPING_MAX_MS;
    const fire = () => {
      if (Date.now() >= deadline) {
        this.stopTypingLoop(agentName);
        return;
      }
      this.client.sendTyping(channel).catch((err) => {
        console.warn('Discord: Failed to send typing indicator:', err);
      });
    };

    fire(); // immediate feedback, don't wait a full interval
    const interval = setInterval(fire, TYPING_REFRESH_MS);
    // Don't keep the process alive solely for a typing indicator.
    (interval as { unref?: () => void }).unref?.();
    this.typingLoops.set(agentName, { interval, deadline });
  }

  /** Stop the typing keepalive for an agent, if one is running. */
  private stopTypingLoop(agentName: string): void {
    const loop = this.typingLoops.get(agentName);
    if (loop) {
      clearInterval(loop.interval);
      this.typingLoops.delete(agentName);
    }
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'send',
        description: 'Send a message to a specific Discord channel',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID to send to' },
            content: { type: 'string', description: 'Message content' },
            replyTo: { type: 'string', description: 'Message ID to reply to (optional)' },
            createThread: {
              type: 'object',
              description: 'Create a thread with this message',
              properties: {
                name: { type: 'string', description: 'Thread name' },
              },
            },
          },
          required: ['channelId', 'content'],
        },
      },
      {
        name: 'dm',
        description: 'Send a direct message to a user',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'User ID to DM' },
            content: { type: 'string', description: 'Message content' },
          },
          required: ['userId', 'content'],
        },
      },
      {
        name: 'reply',
        description:
          'Reply in the current conversation context. Use this for normal responses.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Message content' },
            mention: { type: 'boolean', description: 'Whether to mention the user' },
          },
          required: ['content'],
        },
      },
      {
        name: 'react',
        description: 'Add a reaction to a message',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to react to' },
            emoji: { type: 'string', description: 'Emoji (unicode or custom emoji ID)' },
          },
          required: ['channelId', 'messageId', 'emoji'],
        },
      },
      {
        name: 'edit',
        description: 'Edit a message sent by this bot',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to edit' },
            content: { type: 'string', description: 'New content' },
          },
          required: ['channelId', 'messageId', 'content'],
        },
      },
      {
        name: 'delete',
        description: 'Delete a message sent by this bot',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to delete' },
          },
          required: ['channelId', 'messageId'],
        },
      },
      {
        name: 'create_thread',
        description: 'Create a thread from a message',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            messageId: { type: 'string', description: 'Message ID to create thread from' },
            name: { type: 'string', description: 'Thread name' },
            autoArchiveDuration: {
              type: 'number',
              description: 'Auto-archive duration in minutes (60, 1440, 4320, 10080)',
            },
          },
          required: ['channelId', 'messageId', 'name'],
        },
      },
      {
        name: 'set_reply_context',
        description: 'Change where default speech goes for this conversation',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID for replies' },
            threadId: { type: 'string', description: 'Thread ID (optional)' },
            replyToMessageId: { type: 'string', description: 'Message ID to reply to (optional)' },
          },
          required: ['channelId'],
        },
      },
      {
        name: 'activate',
        description: 'Register Discord as the speech handler (take over from other modules)',
        inputSchema: {
          type: 'object',
          properties: {
            additive: {
              type: 'boolean',
              description: 'If true, add to existing handlers instead of replacing',
            },
          },
        },
      },
      {
        name: 'deactivate',
        description: 'Unregister Discord as a speech handler',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      // ========== Discovery & Utility Tools ==========
      {
        name: 'list_guilds',
        description: 'List all Discord servers (guilds) the bot is in',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_channels',
        description: 'List all channels in a Discord server',
        inputSchema: {
          type: 'object',
          properties: {
            guildId: { type: 'string', description: 'Guild/Server ID' },
          },
          required: ['guildId'],
        },
      },
      {
        name: 'fetch_history',
        description: 'Fetch recent message history from a channel. A message with attachments lists each one\'s filename, type and size; their contents aren\'t included.',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID' },
            limit: { type: 'number', description: 'Number of messages to fetch (default: 50, max: 100)' },
            before: { type: 'string', description: 'Fetch messages before this message ID' },
          },
          required: ['channelId'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'send':
          return await this.handleSend(call.input as SendInput);
        case 'dm':
          return await this.handleDM(call.input as SendDMInput);
        case 'reply':
          return await this.handleReply(call.input as ReplyInput);
        case 'react':
          return await this.handleReact(call.input as ReactInput);
        case 'edit':
          return await this.handleEdit(call.input as EditMessageInput);
        case 'delete':
          return await this.handleDelete(call.input as DeleteMessageInput);
        case 'create_thread':
          return await this.handleCreateThread(call.input as CreateThreadInput);
        case 'set_reply_context':
          return await this.handleSetReplyContext(call.input as SetReplyContextInput);
        case 'activate':
          return await this.handleActivate(call.input as { additive?: boolean });
        case 'deactivate':
          return await this.handleDeactivate();
        case 'list_guilds':
          return await this.handleListGuilds();
        case 'list_channels':
          return await this.handleListChannels(call.input as ListChannelsInput);
        case 'fetch_history':
          return await this.handleFetchHistory(call.input as FetchHistoryInput);
        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  async onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse> {
    // Handle new Discord message
    if (event.type === 'discord:message') {
      const msg = event as DiscordMessageEvent;
      const currentState = state.getState<DiscordModuleState>() ?? {
        connectedGuilds: [],
        conversations: {},
        rateLimits: {},
        lastReadMessageId: {},
      };

      // Build conversation state update
      const convKey = msg.guildId ? `${msg.guildId}:${msg.channelId}` : `dm:${msg.authorId}`;
      const conversation: ConversationContext = {
        channelId: msg.channelId,
        userId: msg.authorId,
        guildId: msg.guildId ?? null,
        replyToMessageId: msg.discordMessageId,
        lastActivity: Date.now(),
      };

      // Update in-memory reply context (ephemeral, not persisted)
      this.replyContexts.set('default', conversation);

      // Build new state with updated conversation
      const newState: DiscordModuleState = {
        ...currentState,
        conversations: {
          ...currentState.conversations,
          [convKey]: conversation,
        },
        lastReadMessageId: {
          ...currentState.lastReadMessageId,
          [msg.channelId]: msg.discordMessageId,
        },
      };

      // Update local state reference for tool handlers
      this.state = newState;

      // Auto-send typing indicator if configured
      if (this.config.autoTyping) {
        // Fire and forget - don't await
        this.client.sendTyping(msg.channelId).catch((err) => {
          console.warn('Discord: Failed to send typing indicator:', err);
        });
      }

      // Built from the message and its attachments, or from its text alone
      // when an event carries no blocks; text first, as TEXT_FIRST marks.
      const contentBlocks = msg.contentBlocks ?? textFirst(ownText(msg.content));
      this.noteLive(msg.discordMessageId);

      // Return declarative response - framework applies all writes atomically
      return {
        addMessages: [
          {
            participant: msg.authorName,
            content: contentBlocks,
            metadata: {
              external: { source: 'discord', id: msg.discordMessageId },
              channelId: msg.channelId,
              timestamp: msg.timestamp,
              [TEXT_FIRST]: true,
            },
          },
        ],
        stateUpdate: newState,
        requestInference: msg.shouldTriggerInference ?? true,
      };
    }

    // Handle Discord message edit
    if (event.type === 'discord:edit') {
      const edit = event as DiscordEditEvent;
      // The stored row, not only its id: an edit changes the message's own
      // text and keeps what the host added beside it.
      // An edit to a message nobody has stored yet is dropped: whatever
      // stores the message, its live add or a history sync running now,
      // stores the text it got, and the next sync's text rule changes it.
      // A row stored in shards can't be edited one shard at a time, so it
      // keeps its text, and the host's log says so. Only an edit that writes
      // marks the message live, so an update that changes nothing leaves a
      // running sync free to rewrite the row.
      const stored = this.storedRow(edit.discordMessageId);
      if (!stored) return {};
      if (stored.bodyGroupId) {
        console.warn(`Discord: An update to message ${edit.discordMessageId} wasn't applied: it's stored in shards, which can't be edited, so if its text changed, the agent still has the earlier text`);
        return {};
      }
      const content = contentForText(stored, edit.newContent);
      if (!content) return {};
      this.noteLive(edit.discordMessageId);
      return { editMessages: [{ messageId: stored.id, content }] };
    }

    // Handle Discord message delete
    if (event.type === 'discord:delete') {
      const del = event as DiscordDeleteEvent;
      // A row stored in shards is removed whole: the framework takes out the
      // body a shard belongs to. The message is the live path's even when no
      // row is found, so a running sync doesn't store what its fetch may
      // still hold.
      this.noteLive(del.discordMessageId);
      const stored = this.storedRow(del.discordMessageId);
      if (!stored) {
        return {};
      }
      return {
        removeMessages: [stored.id],
      };
    }

    return {};
  }

  /**
   * Handle agent speech - send to Discord.
   */
  async onAgentSpeech(
    agentName: string,
    content: ContentBlock[],
    context: SpeechContext
  ): Promise<void> {
    // If thoughts are present and we have a recently sent message, edit it
    // to prepend the thoughts as spoiler text.
    if (context.thoughts && context.thoughts.length > 0 && this.lastSentMessage) {
      const thoughtText = this.extractText(context.thoughts);
      if (thoughtText) {
        try {
          const { channelId, messageId } = this.lastSentMessage;
          // Fetch the current message content via the client isn't available,
          // but we know the tool just sent it — reconstruct by editing with
          // spoiler-wrapped thoughts prepended.
          // Discord API edit replaces content, so we need the original text.
          // We don't have it here, so use a get-then-edit pattern via the API.
          // For now, the simplest approach: the discord.js client can fetch & edit.
          await this.editWithThoughts(channelId, messageId, thoughtText);
        } catch (err) {
          console.warn('Discord: Failed to edit thoughts into message:', err);
        }
      }
      this.lastSentMessage = null;
    }

    // Get reply context for this agent
    const replyCtx = this.replyContexts.get(agentName) ?? this.replyContexts.get('default');
    if (!replyCtx) {
      // No conversation context - nowhere to send
      console.warn(`Discord: No reply context for agent ${agentName}`);
      return;
    }

    // Extract text content
    const text = this.extractText(content);
    if (!text) {
      return;
    }

    // Check rate limit
    if (!this.checkRateLimit(replyCtx.channelId)) {
      console.warn(`Discord: Rate limited for channel ${replyCtx.channelId}`);
      return;
    }

    // Send to Discord
    const targetChannel = replyCtx.threadId ?? replyCtx.channelId;
    const result = await this.client.sendMessage(targetChannel, text, {
      replyTo: replyCtx.replyToMessageId,
    });

    // Track for thought-editing (in case of chained speech)
    this.lastSentMessage = { channelId: targetChannel, messageId: result.messageId };

    // Clear reply-to after sending (don't keep replying to same message)
    replyCtx.replyToMessageId = undefined;
    replyCtx.lastActivity = Date.now();
  }

  /**
   * Edit a sent message to prepend thought text as spoilers.
   */
  private async editWithThoughts(
    channelId: string,
    messageId: string,
    thoughtText: string
  ): Promise<void> {
    // Fetch current message content
    const currentContent = await this.client.fetchMessage(channelId, messageId);
    // Prepend spoiler-wrapped thoughts
    const spoiler = `||${thoughtText}||\n`;
    await this.client.editMessage(channelId, messageId, spoiler + currentContent);
  }

  // ==========================================================================
  // Discord Event Handlers
  // ==========================================================================

  /**
   * Handle Discord ready event - sync history for all tracked channels.
   */
  private async handleReady(): Promise<void> {
    console.log('[Discord] Ready - syncing history for tracked channels');
    
    // Get bot user ID
    const botUserId = this.client.getBotUserId();
    if (botUserId) {
      this.state.botUserId = botUserId;
    }

    await this.syncAllChannelHistory();
  }

  /**
   * Sync history for all channels we have conversations in.
   */
  private async syncAllChannelHistory(): Promise<void> {
    if (!this.ctx) return;

    // Get unique channel IDs from conversations
    const channelIds = new Set<string>();
    for (const conv of Object.values(this.state.conversations)) {
      channelIds.add(conv.channelId);
    }

    if (channelIds.size === 0) {
      console.log('[Discord] No channels to sync');
      return;
    }

    console.log(`[Discord] Syncing history for ${channelIds.size} channel(s)`);

    const syncResults: Array<{
      channelId: string;
      newMessages: number;
      editedMessages: number;
      deletedMessages: number;
    }> = [];

    for (const channelId of channelIds) {
      try {
        const result = await this.syncChannelHistory(channelId);
        if (result.newMessages > 0 || result.editedMessages > 0 || result.deletedMessages > 0) {
          syncResults.push({ channelId, ...result });
        }
      } catch (error) {
        console.error(`[Discord] Failed to sync channel ${channelId}:`, error);
      }
    }

    // Emit sync complete event if there were any changes
    if (syncResults.length > 0 && this.ctx) {
      const totalNew = syncResults.reduce((sum, r) => sum + r.newMessages, 0);
      const totalEdited = syncResults.reduce((sum, r) => sum + r.editedMessages, 0);
      const totalDeleted = syncResults.reduce((sum, r) => sum + r.deletedMessages, 0);

      console.log(`[Discord] History sync complete: ${totalNew} new, ${totalEdited} edited, ${totalDeleted} deleted`);

      // Push a notification event (doesn't trigger inference, just informs)
      this.ctx.pushEvent({
        type: 'module-event',
        source: 'discord',
        eventType: 'history-sync-complete',
        payload: {
          channels: syncResults.length,
          newMessages: totalNew,
          editedMessages: totalEdited,
          deletedMessages: totalDeleted,
        },
      });
    }

    this.ctx?.setState(this.state);
  }

  /**
   * Sync history for a specific channel - compare with Context Manager and update.
   * Uses queryMessages() to enumerate stored messages for proper edit/delete detection.
   *
   * The live path can store, edit or remove a row whenever the sync awaits.
   * So the sync fetches history and runs the live conversion it needs first,
   * then reads the store again and writes with no await between that read
   * and its writes. It leaves alone any message the live path stored,
   * changed or was told was deleted while it ran (liveDuringSync), an update
   * that changed nothing aside. A live edit to a message nobody had stored
   * yet is dropped, so a message the sync stores holds the text it fetched
   * until the next sync's text rule changes it. The framework writes an
   * event's response only once every module has processed the event, so an
   * event processed before the sync began can still be written after the
   * sync's own writes, which this doesn't cover.
   */
  private async syncChannelHistory(channelId: string): Promise<{
    newMessages: number;
    editedMessages: number;
    deletedMessages: number;
  }> {
    const unchanged = { newMessages: 0, editedMessages: 0, deletedMessages: 0 };
    const ctx = this.ctx;
    if (!ctx) {
      return unchanged;
    }
    const live = new Set<string>();
    this.liveDuringSync.add(live);
    try {
      const scrollback = this.config.historyScrollback ?? 50;
      // The rows stored as the sync begins. One that is gone by the time it
      // writes was removed meanwhile, and isn't the sync's to bring back.
      const before = this.storedByDiscordId(ctx, channelId);

      // Fetch recent history from Discord. If the module stopped or restarted
      // meanwhile, this sync's context is gone and it writes nothing.
      const discordMessages = await this.client.fetchHistory(channelId, { limit: scrollback });
      if (this.ctx !== ctx) return unchanged;

      // Discord's ids, for delete detection inside the fetched window.
      const discordIds = new Set(discordMessages.map((msg) => msg.id));

      // Discord history is newest-first, while addMessage appends to the stored
      // conversation. Process oldest-first so missed messages retain chronology.
      const chronologicalMessages = [...discordMessages].reverse();

      // The live conversion, which fetches attachments, for a message the
      // store lacks and for a row that doesn't hold what the conversion gives
      // the message now (needsRebuild). A row stored in shards can't be
      // edited one shard at a time, so it's left as it is.
      const converted = new Map<string, ContentBlock[]>();
      for (const discordMsg of chronologicalMessages) {
        const stored = before.get(discordMsg.id);
        if (stored && (stored.bodyGroupId || !needsRebuild(stored, discordMsg))) continue;
        const content = await this.convertMessageToContent(discordMsg);
        if (this.ctx !== ctx) return unchanged;
        // A failed fetch never costs a row the text it holds: when a file
        // wasn't fetched, a row holding other text, which may be that file's,
        // keeps what it holds, and the next sync tries again.
        if (stored && holdsNotFetched(content, discordMsg) && holdsOtherText(stored, discordMsg)) continue;
        converted.set(discordMsg.id, content);
      }

      // From here on nothing awaits, so the rows read now are the rows written.
      const storedMessageMap = this.storedByDiscordId(ctx, channelId);
      let newMessages = 0;
      let editedMessages = 0;
      let deletedMessages = 0;
      for (const discordMsg of chronologicalMessages) {
        if (live.has(discordMsg.id)) continue;
        const stored = storedMessageMap.get(discordMsg.id);

        if (!stored) {
          // A message we haven't stored. One that was stored when the sync
          // began, and isn't now, was removed meanwhile: not the sync's to
          // bring back.
          const content = converted.get(discordMsg.id);
          if (!content || before.has(discordMsg.id)) continue;
          // For bot's own messages (from previous sessions), use the agent name
          // This ensures continuity of conversation history
          const isBotMessage = discordMsg.authorId === this.state.botUserId;
          const agentName = ctx.getAgents()[0]?.name;
          const participantName = isBotMessage
            ? (agentName ?? discordMsg.authorName)
            : discordMsg.authorName;
          ctx.addMessage(
            participantName,
            content,
            {
              external: { source: 'discord', id: discordMsg.id },
              channelId,
              timestamp: discordMsg.timestamp.getTime(),
              isOwnMessage: isBotMessage, // Mark as our own for reference
              [TEXT_FIRST]: true,
            }
          );
          newMessages++;
        } else if (!stored.bodyGroupId) {
          // We have this message - check whether it changed (offline edit detection)
          const content = needsRebuild(stored, discordMsg)
            ? converted.get(discordMsg.id)
            : contentForText(stored, discordMsg.content);
          if (content) {
            ctx.editMessage(stored.id, content);
            editedMessages++;
          }
        }
      }

      // Check for deletes only inside the history we actually fetched. A short
      // response covers complete available history; a full page has an older
      // boundary whose tied millisecond must be preserved.
      const fetchedCompleteHistory = discordMessages.length < scrollback;
      const oldestFetchedTimestamp = discordMessages.length > 0
        ? Math.min(...discordMessages.map((msg) => msg.timestamp.getTime()))
        : undefined;
      for (const [externalId, stored] of storedMessageMap) {
        const sourceTimestamp = typeof stored.metadata?.timestamp === 'number'
          ? stored.metadata.timestamp
          : undefined;
        const isInsideFetchedWindow = fetchedCompleteHistory || (
          sourceTimestamp !== undefined &&
          oldestFetchedTimestamp !== undefined &&
          // Discord timestamps are millisecond-precise, so an older message just
          // beyond the page can tie the oldest fetched timestamp. Preserve ties
          // rather than guessing that an unseen boundary message was deleted.
          sourceTimestamp > oldestFetchedTimestamp
        );
        if (isInsideFetchedWindow && !discordIds.has(externalId) && !live.has(externalId)) {
          // Message exists in our store but not in Discord - it was deleted
          // Note: This only catches deletes within the scrollback window.
          // A message the live path wrote while the sync ran is newer than
          // the fetch, so it stays. One shard's id takes out a body whole.
          ctx.removeMessage(stored.id);
          deletedMessages++;
        }
      }

      // Update last read
      if (discordMessages.length > 0) {
        // Messages are typically newest first
        const newestId = discordMessages[0].id;
        this.state.lastReadMessageId[channelId] = newestId;
      }

      return { newMessages, editedMessages, deletedMessages };
    } finally {
      this.liveDuringSync.delete(live);
    }
  }

  /** A channel's stored Discord rows by their Discord message id, whole: an
   *  edit replaces a row's own text and keeps what the host added beside it. */
  private storedByDiscordId(ctx: ModuleContext, channelId: string): Map<string, StoredMessage> {
    const rows = new Map<string, StoredMessage>();
    for (const msg of ctx.queryMessages({ source: 'discord', metadata: { channelId } }).messages) {
      const external = msg.metadata?.external as { id?: string } | undefined;
      if (external?.id) rows.set(external.id, msg);
    }
    return rows;
  }

  /** The stored row of a Discord message, by its id in the row's metadata.
   *  The module context's findMessageByExternalId holds only rows the module
   *  stored through its context, not those a process response added, so it
   *  misses what the live path stored. */
  private storedRow(discordMessageId: string): StoredMessage | undefined {
    return this.ctx?.queryMessages({ source: 'discord', externalIds: [discordMessageId] }).messages[0];
  }

  /** Marks a Discord message as the live path's for every history sync running now. */
  private noteLive(discordMessageId: string): void {
    for (const live of this.liveDuringSync) live.add(discordMessageId);
  }

  private async handleDiscordMessage(message: DiscordMessageData): Promise<void> {
    if (!this.ctx) return;

    // ALWAYS ignore our own messages to prevent feedback loops
    if (this.state.botUserId && message.authorId === this.state.botUserId) {
      return;
    }

    // Optionally ignore other bots
    if (this.config.ignoreBots && message.isBot) {
      return;
    }

    // Check if we should handle this channel
    if (this.config.channelIds && !this.config.channelIds.includes(message.channelId)) {
      return;
    }

    // Check if we should handle this guild
    if (
      message.guildId &&
      this.config.guildIds &&
      !this.config.guildIds.includes(message.guildId)
    ) {
      return;
    }

    // Check if we should handle DMs
    const isDM = !message.guildId;
    if (isDM && !this.config.handleDMs) {
      return;
    }

    // Determine if this message should trigger inference
    const shouldTrigger = this.shouldTriggerInference(message, isDM);

    // Convert message content including attachments
    const contentBlocks = await this.convertMessageToContent(message);

    // Only queue the event - all state writes happen in onProcess()
    this.ctx.pushEvent({
      type: 'discord:message',
      discordMessageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.authorId,
      authorName: message.authorName,
      content: message.content,
      contentBlocks,
      timestamp: message.timestamp.getTime(),
      attachments: message.attachments,
      shouldTriggerInference: shouldTrigger,
    } as DiscordMessageEvent);
  }

  /**
   * Convert a Discord message, live or from history, to ContentBlock array:
   * its own text first, '' when it has none, then any supported attachments
   * (images, text files) and notes for the rest, as TEXT_FIRST marks.
   */
  private async convertMessageToContent(
    message: { id: string; content: string; attachments?: readonly DiscordAttachment[] },
  ): Promise<ContentBlock[]> {
    // What the host adds after the message's own text: one block per attachment.
    const blocks: ContentBlock[] = [];

    // Process attachments
    for (const attachment of message.attachments ?? []) {
      const contentType = attachment.contentType?.toLowerCase() ?? '';
      const filename = attachment.filename.toLowerCase();

      // Check for supported image types
      if (SUPPORTED_IMAGE_TYPES.some(type => contentType.startsWith(type))) {
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: attachment.url,
          },
        } as ContentBlock);
        continue;
      }

      // Check for text files - fetch and include content
      const isTextFile = TEXT_FILE_EXTENSIONS.some(ext => filename.endsWith(ext));
      if (isTextFile && attachment.size && attachment.size < 100_000) { // < 100KB
        try {
          const response = await fetch(attachment.url);
          if (response.ok) {
            const textContent = await response.text();
            blocks.push({
              type: 'text',
              text: `\n--- File: ${attachment.filename} ---\n${textContent}\n--- End of ${attachment.filename} ---\n`,
            });
          } else {
            // An answer whose body is never read holds its connection.
            await response.body?.cancel().catch(() => {});
            console.warn(`Discord: Attachment ${logValue(attachment.filename)} in message ${message.id} wasn't fetched: HTTP ${response.status}`);
            blocks.push(attachmentNotFetched(attachment.filename));
          }
        } catch (error) {
          console.warn(`Discord: Attachment ${logValue(attachment.filename)} in message ${message.id} wasn't fetched:`, error);
          blocks.push(attachmentNotFetched(attachment.filename));
        }
        continue;
      }

      // For unsupported attachments, add a note
      blocks.push({
        type: 'text',
        text: `[Attachment: ${attachment.filename} (${contentType || 'unknown type'})]`,
      });
    }

    return textFirst(ownText(message.content), blocks);
  }

  /**
   * Determine if a message should trigger agent inference based on config.
   */
  private shouldTriggerInference(message: DiscordMessageData, isDM: boolean): boolean {
    const triggerMode = this.config.triggerOn ?? 'mention_or_reply';
    const botUserId = this.state.botUserId;

    // Check if bot is mentioned
    const isMentioned = botUserId
      ? message.mentionedUserIds.includes(botUserId)
      : false;

    // Check if this is a reply to bot's message
    const isReplyToBot = botUserId
      ? message.replyToAuthorId === botUserId
      : false;

    switch (triggerMode) {
      case 'all':
        // Always trigger (use with caution!)
        return true;

      case 'mention':
        // Only trigger on direct @mention
        return isMentioned;

      case 'mention_or_reply':
        // Trigger on @mention OR when replying to bot
        return isMentioned || isReplyToBot;

      case 'dm_or_mention':
        // DMs always trigger, channels require mention
        return isDM || isMentioned;

      default:
        // Fallback: mention_or_reply behavior
        return isMentioned || isReplyToBot;
    }
  }

  private handleDiscordMessageEdit(messageId: string, newContent: string): void {
    if (!this.ctx) return;

    // Only queue the event - state writes happen in onProcess()
    this.ctx.pushEvent({
      type: 'discord:edit',
      discordMessageId: messageId,
      newContent,
    });
  }

  private handleDiscordMessageDelete(messageId: string): void {
    if (!this.ctx) return;

    // Only queue the event - state writes happen in onProcess()
    this.ctx.pushEvent({
      type: 'discord:delete',
      discordMessageId: messageId,
    });
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  private async handleSend(input: SendInput): Promise<ToolResult> {
    if (!this.checkRateLimit(input.channelId)) {
      return { success: false, error: 'Rate limited', isError: true };
    }

    const result = await this.client.sendMessage(input.channelId, input.content, {
      replyTo: input.replyTo,
      createThread: input.createThread,
    });

    // Track for thought-editing: the message is out, whether or not its
    // thread was started.
    this.lastSentMessage = { channelId: input.channelId, messageId: result.messageId };

    if (result.threadFailure !== undefined) {
      return { success: false, error: result.threadFailure, isError: true };
    }
    return { success: true, data: { messageId: result.messageId } };
  }

  private async handleDM(input: SendDMInput): Promise<ToolResult> {
    const result = await this.client.sendDM(input.userId, input.content);
    return { success: true, data: { messageId: result.messageId } };
  }

  private async handleReply(input: ReplyInput): Promise<ToolResult> {
    const replyCtx = this.replyContexts.get('default');
    if (!replyCtx) {
      return { success: false, error: 'No conversation context', isError: true };
    }

    if (!this.checkRateLimit(replyCtx.channelId)) {
      return { success: false, error: 'Rate limited', isError: true };
    }

    let content = input.content;
    if (input.mention && replyCtx.userId) {
      content = `<@${replyCtx.userId}> ${content}`;
    }

    const targetChannel = replyCtx.threadId ?? replyCtx.channelId;
    const result = await this.client.sendMessage(targetChannel, content, {
      replyTo: replyCtx.replyToMessageId,
    });

    // Track for thought-editing
    this.lastSentMessage = { channelId: targetChannel, messageId: result.messageId };

    // Clear reply-to after sending
    replyCtx.replyToMessageId = undefined;
    replyCtx.lastActivity = Date.now();

    return { success: true, data: { messageId: result.messageId } };
  }

  private async handleReact(input: ReactInput): Promise<ToolResult> {
    await this.client.addReaction(input.channelId, input.messageId, input.emoji);
    return { success: true };
  }

  private async handleEdit(input: EditMessageInput): Promise<ToolResult> {
    await this.client.editMessage(input.channelId, input.messageId, input.content);
    return { success: true };
  }

  private async handleDelete(input: DeleteMessageInput): Promise<ToolResult> {
    await this.client.deleteMessage(input.channelId, input.messageId);
    return { success: true };
  }

  private async handleCreateThread(input: CreateThreadInput): Promise<ToolResult> {
    const result = await this.client.createThread(
      input.channelId,
      input.messageId,
      input.name,
      input.autoArchiveDuration
    );

    // Update reply context to use the new thread
    const replyCtx = this.replyContexts.get('default');
    if (replyCtx) {
      replyCtx.threadId = result.threadId;
    }

    return { success: true, data: { threadId: result.threadId } };
  }

  private async handleSetReplyContext(input: SetReplyContextInput): Promise<ToolResult> {
    const replyCtx = this.replyContexts.get('default');
    if (replyCtx) {
      replyCtx.channelId = input.channelId;
      replyCtx.threadId = input.threadId;
      replyCtx.replyToMessageId = input.replyToMessageId;
    } else {
      this.replyContexts.set('default', {
        channelId: input.channelId,
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        userId: '',
        guildId: null,
        lastActivity: Date.now(),
      });
    }

    return { success: true };
  }

  private async handleActivate(input: { additive?: boolean }): Promise<ToolResult> {
    if (!this.ctx) {
      return { success: false, error: 'Module not started', isError: true };
    }

    this.ctx.registerSpeechHandler('*', { additive: input.additive });
    return { success: true, data: { message: 'Discord is now handling speech' } };
  }

  private async handleDeactivate(): Promise<ToolResult> {
    if (!this.ctx) {
      return { success: false, error: 'Module not started', isError: true };
    }

    this.ctx.unregisterSpeechHandler();
    return { success: true, data: { message: 'Discord is no longer handling speech' } };
  }

  private async handleListGuilds(): Promise<ToolResult> {
    const guilds = await this.client.listGuilds();
    return {
      success: true,
      data: {
        guilds: guilds.map((g) => ({
          id: g.id,
          name: g.name,
          memberCount: g.memberCount,
        })),
      },
    };
  }

  private async handleListChannels(input: ListChannelsInput): Promise<ToolResult> {
    const channels = await this.client.listChannels(input.guildId);
    return {
      success: true,
      data: {
        guildId: input.guildId,
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentId: c.parentId,
        })),
      },
    };
  }

  private async handleFetchHistory(input: FetchHistoryInput): Promise<ToolResult> {
    const limit = Math.min(input.limit ?? 50, 100); // Cap at 100
    const messages = await this.client.fetchHistory(input.channelId, {
      limit,
      before: input.before,
    });

    // Update last read if we got messages
    if (messages.length > 0) {
      const latestId = messages[0].id; // Assuming sorted newest first
      this.state.lastReadMessageId[input.channelId] = latestId;
      this.ctx?.setState(this.state);
    }

    return {
      success: true,
      data: {
        channelId: input.channelId,
        messageCount: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          author: m.authorName,
          authorId: m.authorId,
          isBot: m.isBot,
          content: m.content,
          // Not their URLs: a link Discord signs works for anyone holding it
          // until it expires, and an agent could repeat it where others read.
          ...(m.attachments?.length
            ? { attachments: m.attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })) }
            : {}),
          timestamp: formatZonedDateTime(m.timestamp, this.timeZone),
          replyTo: m.replyTo,
        })),
      },
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private extractText(content: ContentBlock[]): string {
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  private checkRateLimit(channelId: string): boolean {
    const limit = this.config.rateLimitPerMinute ?? 30;
    const now = Date.now();
    const windowMs = 60 * 1000;

    let info = this.state.rateLimits[channelId];
    if (!info || now - info.windowStart > windowMs) {
      // New window
      info = { count: 0, windowStart: now };
      this.state.rateLimits[channelId] = info;
    }

    if (info.count >= limit) {
      return false;
    }

    info.count++;
    return true;
  }

  private cleanupOldConversations(): void {
    const now = Date.now();
    for (const [key, conv] of Object.entries(this.state.conversations)) {
      if (now - conv.lastActivity > CONVERSATION_TIMEOUT_MS) {
        delete this.state.conversations[key];
      }
    }
  }
}
