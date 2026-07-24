/**
 * Voice relay wire protocol types.
 *
 * Ported from melodeus-tts-relay/src/types.ts — wire shapes must stay
 * byte-compatible with the standalone relay so existing voice clients
 * (melodeus, the iOS app) and legacy ChapterX bots (the Discord bot stack
 * the relay was originally built to serve) work unchanged. Mirrors
 * melodeus-tts-relay commit ec8f0f1 (2026-07-21); nothing on the wire
 * carries a version, so on any divergence that repo's types.ts is
 * canonical. "v2" is the relay repo's name for its current protocol —
 * there is no negotiation and no v1 on the wire.
 *
 * Kept as the complete v2 protocol even though RelayClientModule uses only
 * the bot-side subset (the streamed relay messages + interruption +
 * heartbeat): one shared definition for any future relay-facing code, and a
 * typed reference for the protocol as deployed.
 */

export type BlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';
export type InterruptionReason = 'user_speech' | 'manual' | 'timeout';
export type ActivationEndReason = 'complete' | 'abort' | 'error';

/** Attachment on a Discord message */
export interface MessageAttachment {
  id: string;
  filename: string;
  url: string;
  contentType?: string;
  size: number;
  width?: number;
  height?: number;
}

// ============================================================================
// Authentication Messages
// ============================================================================

export interface BotAuthMessage {
  type: 'auth';
  botId: string;
  token: string;
  userId?: string;    // Discord user ID (for @mentions)
  username?: string;  // Display name
}

export interface VoiceClientAuthMessage {
  type: 'auth';
  clientId: string;
  token: string;
  username?: string;  // User account username (new auth)
}

export interface AuthOkMessage {
  type: 'auth_ok';
  user?: {
    username: string;
    discordUserId?: string;
    discordUsername?: string;
    discordAvatarUrl?: string;
    /** True iff the user is a member of the configured admin guild. */
    isAdmin?: boolean;
  };
}

export interface AuthErrorMessage {
  type: 'auth_error';
  error: string;
}

// ============================================================================
// Subscription Messages
// ============================================================================

export interface SubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

export interface SubscribedMessage {
  type: 'subscribed';
  channels: string[];
}

// ============================================================================
// Bot → Relay Messages (streamed turn content, forwarded verbatim to clients)
// ============================================================================

export interface ChunkMessage {
  type: 'chunk';
  botId: string;
  channelId: string;
  userId: string;
  username: string;
  text: string;
  blockIndex: number;
  blockType: BlockType;
  visible: boolean;
  timestamp: number;
}

export interface BlockStartMessage {
  type: 'block_start';
  botId: string;
  channelId: string;
  userId: string;
  username: string;
  blockIndex: number;
  blockType: BlockType;
  timestamp: number;
}

export interface BlockCompleteMessage {
  type: 'block_complete';
  botId: string;
  channelId: string;
  userId: string;
  username: string;
  blockIndex: number;
  blockType: BlockType;
  content: string;
  timestamp: number;
}

export interface ActivationStartMessage {
  type: 'activation_start';
  botId: string;
  channelId: string;
  userId: string;
  username: string;
  timestamp: number;
}

export interface ActivationEndMessage {
  type: 'activation_end';
  botId: string;
  channelId: string;
  userId: string;
  username: string;
  reason: ActivationEndReason;
  timestamp: number;
}

// ============================================================================
// Voice Client → Relay Messages
// ============================================================================

export interface InterruptionMessage {
  type: 'interruption';
  botId: string;
  channelId: string;
  spokenText: string;        // The text that was actually voiced
  reason: InterruptionReason;
  timestamp: number;
}

export interface TranscriptMessage {
  type: 'transcript';
  channelId: string;
  text: string;
  speakerName?: string;      // For webhook display name/avatar
  targetBot?: string;        // Explicit bot to @mention
  attachmentUrls?: string[]; // URLs of images/files to attach
  timestamp: number;
}

export interface EditMessageMessage {
  type: 'edit_message';
  channelId: string;
  messageId: string;
  text: string;
  timestamp: number;
}

export interface ReplaceMessageMessage {
  type: 'replace_message';
  channelId: string;
  messageId: string;
  text: string;
  speakerName?: string;      // New speaker identity (if changing impersonation)
  targetBot?: string;        // Re-resolve @mention
  timestamp: number;
}

export interface DeleteMessageMessage {
  type: 'delete_message';
  channelId: string;
  messageId: string;
  timestamp: number;
}

// ============================================================================
// Relay → Voice Client Messages (Discord feedback)
// ============================================================================

export interface MessagePostedMessage {
  type: 'message_posted';
  channelId: string;
  messageId: string;
  text: string;
  timestamp: number;
}

export interface MessageEditedMessage {
  type: 'message_edited';
  channelId: string;
  messageId: string;
  text: string;
  timestamp: number;
}

export interface MessageDeletedMessage {
  type: 'message_deleted';
  channelId: string;
  messageId: string;
  timestamp: number;
}

export interface WebhookErrorMessage {
  type: 'webhook_error';
  channelId: string;
  error: string;
  originalText?: string;
  timestamp: number;
}

/** Discord channel message events (via gateway) */
export interface ChannelMessageEventMessage {
  type: 'channel_message';
  event: 'created' | 'updated' | 'deleted';
  channelId: string;
  guildId: string;
  messageId: string;
  author?: {
    id: string;
    username: string;
    displayName?: string;
    bot: boolean;
  };
  content?: string;
  attachments?: MessageAttachment[];
  timestamp: number;
}

/** Discord message ID for a streamed bot message (sent instead of suppressed channel_message) */
export interface BotMessagePostedMessage {
  type: 'bot_message_posted';
  botId?: string;
  channelId: string;
  messageId: string;
  author: {
    id: string;
    username: string;
    displayName?: string;
    bot: boolean;
  };
  content?: string;
  attachments?: MessageAttachment[];
  timestamp: number;
}

/** Reaction added or removed on a message */
export interface MessageReactionEventMessage {
  type: 'message_reaction';
  event: 'added' | 'removed';
  channelId: string;
  messageId: string;
  userId: string;
  username?: string;
  emoji: {
    name: string;
    id?: string;       // Custom emoji snowflake
    animated?: boolean;
  };
  timestamp: number;
}

/** Bot joined/left a guild */
export interface BotRosterEventMessage {
  type: 'bot_roster';
  event: 'joined' | 'left';
  guildId: string;
  bot: {
    userId: string;
    username: string;
    displayName?: string;
  };
  timestamp: number;
}

/** Periodic keepalive sent to all connections (clients may ignore). */
export interface HeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
}

// ============================================================================
// Relay → Bot Messages
// ============================================================================

export interface BotInterruptionMessage {
  type: 'interruption';
  channelId: string;
  spokenText: string;        // Bot matches this to find the message to edit
  reason: InterruptionReason;
  timestamp: number;
}

// ============================================================================
// Channel Config Messages
// ============================================================================

/** Client requests available channels */
export interface GetChannelsMessage {
  type: 'get_channels';
}

/** Relay sends available channels organized by guild/category */
export interface ChannelsMessage {
  type: 'channels';
  guilds: GuildChannelList[];
}

export interface GuildChannelList {
  guildId: string;
  guildName: string;
  categories: CategoryInfo[];
  /** Channels not in any category */
  uncategorized: ChannelInfo[];
}

export interface CategoryInfo {
  id: string;
  name: string;
  position: number;
  channels: ChannelInfo[];
}

export interface ChannelInfo {
  id: string;
  name: string;
  position: number;
  /** Whether this channel is configured for voice in the relay */
  voice: boolean;
  /** True if this entry is a thread (Discord ChannelType 10/11/12). */
  isThread?: boolean;
  /** For threads: the parent text channel id. Absent for regular channels. */
  parentId?: string;
}

/** Client requests the aggregated list of bots known across all guilds. */
export interface GetBotsMessage {
  type: 'get_bots';
}

/** Server response: flattened, deduplicated bot list. */
export interface BotsMessage {
  type: 'bots';
  bots: Array<{
    userId: string;
    username: string;
    displayName?: string;
    avatarUrl?: string;
    guildName?: string;  // first guild we found this bot in
  }>;
}

export interface GetMembersMessage {
  type: 'get_members';
  channelId: string;  // Relay resolves to guildId
}

export interface GuildMemberInfo {
  userId: string;
  username: string;
  displayName?: string;
  bot: boolean;
  avatarUrl?: string;
}

/** Relay sends the full member roster */
export interface MembersMessage {
  type: 'members';
  guildId: string;
  members: GuildMemberInfo[];
}

/** A member joined or left */
export interface MemberRosterEventMessage {
  type: 'member_roster';
  event: 'joined' | 'left';
  guildId: string;
  member: GuildMemberInfo;
  timestamp: number;
}

/** Client requests channel history (backscroll) */
export interface GetHistoryMessage {
  type: 'get_history';
  channelId: string;
  before?: string;   // Message ID — fetch messages before this (pagination)
  limit?: number;    // Max messages to return (default 50, max 100)
}

/** Relay returns channel history */
export interface HistoryMessage {
  type: 'history';
  channelId: string;
  messages: HistoryEntry[];
  hasMore: boolean;   // True if there are older messages to fetch
}

export interface MessageReaction {
  emoji: { name: string; id?: string; animated?: boolean };
  count: number;
}

export interface HistoryEntry {
  messageId: string;
  author: {
    id: string;
    username: string;
    displayName?: string;
    bot: boolean;
  };
  content: string;
  attachments?: MessageAttachment[];
  reactions?: MessageReaction[];
  timestamp: number;
  editedTimestamp?: number;
}

/** Client links their account to a Discord user */
export interface LinkDiscordMessage {
  type: 'link_discord';
  discordUserId: string;
}

/** Client sets their speaking persona */
export interface SetPersonaMessage {
  type: 'set_persona';
  username?: string;    // Display name for webhook (null = use Discord identity)
  avatarUrl?: string;   // Avatar URL (null = use Discord avatar)
}

/** Client clears persona, reverting to their Discord identity */
export interface ClearPersonaMessage {
  type: 'clear_persona';
}

/** Client adds a reaction to a message */
export interface AddReactionMessage {
  type: 'add_reaction';
  channelId: string;
  messageId: string;
  emoji: string;  // Unicode emoji or custom emoji format "name:id"
}

/** Client removes a reaction from a message */
export interface RemoveReactionMessage {
  type: 'remove_reaction';
  channelId: string;
  messageId: string;
  emoji: string;
}

/** Client toggles voice on/off for a channel */
export interface SetVoiceChannelMessage {
  type: 'set_voice_channel';
  channelId: string;
  enabled: boolean;
}

/** Client sets overrides for a specific channel */
export interface SetChannelOverridesMessage {
  type: 'set_channel_overrides';
  channelId: string;
  overrides: ChannelOverrides;
}

/** Client requests the current config */
export interface GetConfigMessage {
  type: 'get_config';
}

/** Relay sends full config to client (on subscribe or on request) */
export interface ConfigMessage {
  type: 'config';
  config: ChannelConfig;
}

/** Client requests a config update (partial) */
export interface UpdateConfigMessage {
  type: 'update_config';
  update: Partial<ChannelConfig>;
}

/** Relay confirms config was updated and broadcasts new config */
export interface ConfigUpdatedMessage {
  type: 'config_updated';
  config: ChannelConfig;
  updatedBy: string;  // clientId that made the change
}

// ============================================================================
// Channel Config (served to clients)
// ============================================================================

export interface VoiceSettings {
  speed: number;
  stability: number;
  similarityBoost: number;
}

export interface VoiceConfig {
  voiceId: string;
  voiceSettings: VoiceSettings;
  discordName: string;
  enabled: boolean;
  /** Narrator/emotive voice for text in asterisks. Falls back to system default if not set. */
  narratorVoiceId?: string;
  narratorVoiceSettings?: VoiceSettings;
}

/** Config that the relay serves to voice clients */
export interface ChannelConfig {
  /** ElevenLabs API key (passthrough to clients for now) */
  elevenLabsKey: string;

  /** TTS model to use */
  ttsModel: string;

  /** Bot name → voice config */
  voices: Record<string, VoiceConfig>;

  /** Default voice for bots without a specific voice config */
  defaultBotVoice: VoiceConfig;

  /** Default voice for human messages */
  defaultHumanVoice: VoiceConfig;

  /** System-wide default narrator voice (for emotive text in asterisks) */
  defaultNarratorVoiceId: string;
  defaultNarratorVoiceSettings: VoiceSettings;

  /** Speaker name → display config for webhook */
  speakers: Record<string, SpeakerConfig>;

  /** Mention routing */
  mentionMode: MentionMode;
  defaultBot?: string;

  /** Director config */
  director: DirectorConfig;

  /** Per-channel overrides (channelId → overrides) */
  channelOverrides: Record<string, ChannelOverrides>;

  /** Channels explicitly configured for voice (shown as voice-enabled to clients) */
  voiceChannels?: string[];

  /** User accounts (username → account). Redacted for non-admin clients. */
  users: Record<string, UserAccount>;
}

export interface DirectorConfig {
  mode: 'off' | 'same_model' | 'director';
  defaultCharacter?: string;
}

/** Per-channel overrides — any field set here takes precedence over the global config */
export interface ChannelOverrides {
  voices?: Record<string, Partial<VoiceConfig>>;
  defaultBotVoice?: Partial<VoiceConfig>;
  defaultHumanVoice?: Partial<VoiceConfig>;
  defaultNarratorVoiceId?: string;
  defaultNarratorVoiceSettings?: Partial<VoiceSettings>;
  mentionMode?: MentionMode;
  defaultBot?: string;
  director?: Partial<DirectorConfig>;
}

export type MentionMode = 'default' | 'explicit' | 'last_speaker' | 'round_robin';

export interface SpeakerConfig {
  discordUsername: string;
  discordUserId?: string;
  avatarUrl?: string;
  aliases?: string[];
}

export interface UserAccount {
  token: string;
  tokenHashed?: boolean;
  discordUserId?: string;
}

// ============================================================================
// Union Types
// ============================================================================

export type BotToRelayMessage =
  | BotAuthMessage
  | ChunkMessage
  | BlockStartMessage
  | BlockCompleteMessage
  | ActivationStartMessage
  | ActivationEndMessage;

/** What a connected bot streams after authenticating — everything a bot may
 *  put on the wire except the auth handshake itself. The outbound type of
 *  RelayClientModule/InferenceTraceBridge, so the compiler rejects any
 *  message a /bot client must never send. */
export type BotStreamMessage = Exclude<BotToRelayMessage, BotAuthMessage>;

export type VoiceClientToRelayMessage =
  | VoiceClientAuthMessage
  | SubscribeMessage
  | InterruptionMessage
  | TranscriptMessage
  | EditMessageMessage
  | ReplaceMessageMessage
  | DeleteMessageMessage
  | GetConfigMessage
  | UpdateConfigMessage
  | GetHistoryMessage
  | GetChannelsMessage
  | GetMembersMessage
  | GetBotsMessage
  | AddReactionMessage
  | RemoveReactionMessage
  | SetVoiceChannelMessage
  | SetChannelOverridesMessage
  | SetPersonaMessage
  | ClearPersonaMessage
  | LinkDiscordMessage;

export type RelayToBotMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | BotInterruptionMessage
  | HeartbeatMessage;

export type RelayToVoiceClientMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | SubscribedMessage
  | ChunkMessage
  | BlockStartMessage
  | BlockCompleteMessage
  | ActivationStartMessage
  | ActivationEndMessage
  | MessagePostedMessage
  | MessageEditedMessage
  | MessageDeletedMessage
  | WebhookErrorMessage
  | ConfigMessage
  | ConfigUpdatedMessage
  | ChannelMessageEventMessage
  | BotMessagePostedMessage
  | MessageReactionEventMessage
  | BotRosterEventMessage
  | HistoryMessage
  | ChannelsMessage
  | MembersMessage
  | BotsMessage
  | MemberRosterEventMessage
  | HeartbeatMessage;

// ============================================================================
// Logging
// ============================================================================

/** Minimal logger surface so hosts can capture or silence output.
 *  Console-backed by default for info and above; debug is dropped unless a
 *  logger is injected. */
export interface RelayLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}
