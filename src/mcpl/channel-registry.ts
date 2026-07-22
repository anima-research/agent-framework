/**
 * ChannelRegistry — manages MCPL channel lifecycle, incoming messages, and
 * synthesized channel tools.
 *
 * Adapted from battle-tested patterns in Anarchid/agent-framework@mcpl-module-proto.
 *
 * Responsibilities:
 * - Register/unregister channel descriptors from MCPL servers
 * - Reconcile actual channel state to Chronicle-backed desired state
 * - Route incoming messages to the processing queue
 * - Manage typing indicator timers (7s interval for Discord compatibility)
 * - Expose synthesized tools: channel_list, channel_open, channel_close, channel_publish
 * - Build channel context for beforeInference params
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { JsStore } from '@animalabs/chronicle';

import type {
  ChannelDescriptor,
  ChannelContext,
  ChannelsRegisterParams,
  ChannelsRegisterResult,
  ChannelsChangedParams,
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  ChannelIncomingMessageResult,
  ChannelsPublishParams,
  ChannelsOpenResult,
  ChannelHistoryRequest,
  McplContentBlock,
} from './types.js';

import type { McplServerRegistry } from './server-registry.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import type { ToolDefinition, ToolResult, ProcessEvent } from '../types/index.js';

// ============================================================================
// Typing indicator interval (Discord typing lasts ~10s, so 7s keeps it alive)
// ============================================================================

const TYPING_INTERVAL_MS = 7_000;
const CHANNEL_LIFECYCLE_LOG_ID = 'mcpl/channel-lifecycle';

type DesiredChannelState = 'open' | 'closed';

interface ChannelLifecycleEvent {
  kind: 'desired-state' | 'legacy-policy-migrated' | 'invitation-declined';
  serverId: string;
  timestamp: string;
  channelId?: string;
  desired?: DesiredChannelState;
  source?: string;
  messageId?: string;
  acknowledgment?: string;
}

function shallowEqualRecord(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// ============================================================================
// Internal Types
// ============================================================================

/** A registered channel entry, keyed by `{serverId}:{channelId}`. */
interface ChannelEntry {
  serverId: string;
  descriptor: ChannelDescriptor;
  open: boolean;
}

/** Minimal responder interface for sending JSON-RPC results back. */
interface Responder {
  respond(result: unknown): void;
  respondError?(code: number, message: string, data?: unknown): void;
}

/**
 * Event pushed to the processing queue when an incoming channel message arrives.
 * Uses the CustomEvent pattern (`${string}:${string}`) from ProcessEvent.
 */
interface McplChannelIncomingEvent {
  type: 'mcpl:channel-incoming';
  serverId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  author: { id: string; name: string };
  content: ContentBlock[];
  timestamp: string;
  metadata?: Record<string, unknown>;
  /** MCPL RFC-001 event tags (`chat:addressed`, `chat:ambient`, …) — carried
   *  through so the host can rank addressed messages over ambient chatter
   *  when picking a turn's frozen speech locus. */
  tags?: string[];
  triggerInference?: boolean;
  targetAgents?: string[];
}

// ============================================================================
// Content Conversion: McplContentBlock → membrane ContentBlock
// ============================================================================

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 */
function convertBlock(block: McplContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      if (block.data && block.mimeType) {
        return {
          type: 'image',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      if (block.uri) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Image: no data]' };

    case 'audio':
      if (block.data && block.mimeType) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      return { type: 'text', text: '[Audio: no data]' };

    case 'resource':
      return { type: 'text', text: `[Resource: ${block.uri}]` };
  }
}

// ============================================================================
// Channel Tool Definitions
// ============================================================================

const CHANNEL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'channel_list',
    description: 'List all available channels',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'channel_open',
    description:
      'Open a channel to start receiving its ordinary ongoing traffic. The MCPL ' +
      'integration performs its own subscribe/join/attach operation. Optionally request ' +
      'history preceding the message that invited you into the channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'ID of the channel to open' },
        serverId: { type: 'string', description: 'Owning MCPL server; required only when channelId is ambiguous.' },
        backscroll: {
          type: 'number',
          description: 'Number of earlier messages to return while opening (0-500; default 0).',
        },
        beforeMessageId: {
          type: 'string',
          description: 'Anchor message from the closed-channel notice; it is excluded from backscroll.',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'channel_decline',
    description:
      'Deliberately remain closed after being addressed in a closed channel. Optionally ' +
      'post a public acknowledgment through the MCPL integration. Acknowledgment is ' +
      'opt-in; omitting it declines silently.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'Channel from the invitation notice.' },
        serverId: { type: 'string', description: 'Owning MCPL server from the invitation notice.' },
        messageId: { type: 'string', description: 'Triggering message to acknowledge.' },
        acknowledge: {
          type: 'string',
          description: 'Optional surface value such as 👀. Omit for a silent decline.',
        },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'channel_close',
    description: 'Close a channel to stop receiving messages',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'ID of the channel to close' },
        serverId: { type: 'string', description: 'Owning MCPL server; required only when channelId is ambiguous.' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'channel_publish',
    description: 'Publish a message to a channel. If channelId is omitted, publishes to the most recent incoming channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: 'ID of the channel to publish to (defaults to the most recent incoming channel)' },
        content: { type: 'string', description: 'Text content to publish' },
        text: { type: 'string', description: 'Alias for content' },
      },
      required: [],
    },
  },
  {
    name: 'think',
    description:
      'Reason privately. The content stays in your own context and is NOT sent to any ' +
      'channel or surface. Same-round routing of ordinary text beside think() depends on ' +
      'your current same_round_think_text_policy; inspect or change it with agent_settings. ' +
      'Use think() purely to work things out before (or instead of) speaking. To deliberately ' +
      'NOT reply this turn, call skip_reply instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'Your private thought / reasoning (optional; not sent anywhere).',
        },
      },
      required: [],
    },
  },
  {
    name: 'skip_reply',
    description:
      'End your turn WITHOUT sending anything to any channel or surface. Use when you have ' +
      'read the messages but deliberately choose not to reply right now — ambient chatter, ' +
      'nothing to add, or you are waiting. Any plain text you wrote this turn stays private ' +
      'and is NOT posted. To reply instead, just write plain text (no tool call).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Optional private note on why you are not replying (not sent anywhere).',
        },
      },
      required: [],
    },
  },
];

// ============================================================================
// Constructor Options
// ============================================================================

interface ChannelRegistryOptions {
  /** Chronicle store used for durable desired channel lifecycle state. */
  store?: JsStore;
  /** Callback to determine whether an incoming message should trigger inference. */
  shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
  /**
   * Called when a text-only turn's speech could NOT be delivered to its
   * conversational locus — no locus, an unregistered channel, a missing
   * server, or the server reporting `delivered: false`. The host wires this
   * to drop a `[discord-send-failed]` marker into chronicle so the failure is
   * visible to the agent (and operator) rather than silently lost. Must not
   * itself trigger inference (avoid wake loops).
   */
  onRouteFailure?: (info: {
    conversationId: string;
    channelId: string | null;
    reason: string;
    textLen: number;
  }) => void;
  /**
   * Resolve a conversation fork's HOME channel from its agent name. Conversation
   * forks are spawned bound to a single channel (the framework tracks this in
   * `conversationAgentHomes` / `ConversationRouter.channelForAgent`); their
   * plain-text speech must route THERE. The process-global `defaultPublishChannel`
   * tracks only the most-recent inbound across ALL channels, so with one fork per
   * channel running concurrently it misroutes a fork's reply to whichever channel
   * last spoke (item 3). Returns undefined for the trunk/primary agent, which has
   * no home and correctly falls back to the global locus (heartbeats, etc.).
   */
  homeChannelResolver?: (agentName: string) => string | undefined;
  /**
   * Resolve the channel that triggered an agent's CURRENT inference turn, by
   * agent name. This is the fix for single-TRUNK agents (the only mode
   * connectome-host runs — it never exposes conversation forks). A trunk agent
   * has no fork home, so without this its plain-text speech falls back to the
   * process-global `defaultPublishChannel`, which tracks the most-recent inbound
   * across ALL channels and misroutes a reply to whichever channel last spoke
   * under concurrency (item-3 redux). The framework tracks the triggering
   * channel of the live turn per-agent and exposes it here; resolves to
   * undefined for a heartbeat / no-trigger turn, which correctly keeps the
   * global fallback. Consulted AFTER `homeChannelResolver` (a fork's home always
   * wins), BEFORE `defaultPublishChannel`.
   */
  activeChannelResolver?: (agentName: string) => string | undefined;
}

// ============================================================================
// ChannelRegistry
// ============================================================================

export class ChannelRegistry {
  private serverRegistry: McplServerRegistry;
  private featureSetManager: FeatureSetManager;
  private pushEventFn: (event: ProcessEvent) => void;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;
  private sendTypingFn?: (
    serverId: string,
    channelId: string,
    metadata?: Record<string, unknown>,
    op?: 'start' | 'stop',
  ) => void;
  private shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
  private onRouteFailure?: (info: {
    conversationId: string;
    channelId: string | null;
    reason: string;
    textLen: number;
  }) => void;
  private homeChannelResolver?: (agentName: string) => string | undefined;
  private activeChannelResolver?: (agentName: string) => string | undefined;
  private store?: JsStore;

  /** Registered channels, keyed by `{serverId}:{channelId}`. */
  private channels = new Map<string, ChannelEntry>();

  /** Most recent incoming channel ID — used for speech routing / default publish. */
  private defaultPublishChannel: string | null = null;

  /** Most recent incoming message metadata, used for buildChannelContext. */
  private defaultPublishMessageId: string | null = null;
  private defaultPublishThreadId: string | undefined = undefined;

  /** Per-channel typing indicator timers. */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  /** Per-channel typing metadata — carried on the 7s refresh so the target
   *  server keeps getting the same routing hints (e.g. Zulip topic). */
  private typingMetadata = new Map<string, Record<string, unknown>>();

  /** Chronicle-projected desired lifecycle state, keyed by server + channel.
   *  Provenance is kept so reconcile can tell a pure default (nobody ever
   *  decided) from a real decision (agent-tool, invitation-declined, …). */
  private desiredStates = new Map<string, { state: DesiredChannelState; source: string }>();

  /** One-time migration inputs from the retired recipe auto-open policy. */
  private legacyPolicies = new Map<string, 'auto' | 'manual' | string[]>();
  private migratedLegacyPolicies = new Set<string>();

  constructor(
    serverRegistry: McplServerRegistry,
    featureSetManager: FeatureSetManager,
    pushEventFn: (event: ProcessEvent) => void,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
    options?: ChannelRegistryOptions & {
      sendTypingFn?: (
        serverId: string,
        channelId: string,
        metadata?: Record<string, unknown>,
        op?: 'start' | 'stop',
      ) => void;
    },
  ) {
    this.serverRegistry = serverRegistry;
    this.featureSetManager = featureSetManager;
    this.pushEventFn = pushEventFn;
    this.emitTraceFn = emitTraceFn;
    this.sendTypingFn = options?.sendTypingFn;
    this.shouldTriggerInference = options?.shouldTriggerInference;
    this.onRouteFailure = options?.onRouteFailure;
    this.homeChannelResolver = options?.homeChannelResolver;
    this.activeChannelResolver = options?.activeChannelResolver;
    this.store = options?.store;
    this.initializeLifecycleStore();
  }

  /**
   * Supply a legacy recipe policy for one-time migration into Chronicle.
   */
  setSubscriptionPolicy(serverId: string, policy: 'auto' | 'manual' | string[]): void {
    // Backward-compatible recipe ingestion only. The policy is consumed once
    // to seed Chronicle, then never applied to newly discovered channels.
    this.legacyPolicies.set(serverId, policy);
  }

  // ==========================================================================
  // Handler Methods (called from framework.ts wireMcplEvents)
  // ==========================================================================

  /**
   * Handle `channels/register` from a server.
   *
   * Registers descriptors and reconciles them to durable desired state.
   */
  async handleRegister(
    serverId: string,
    params: ChannelsRegisterParams,
    responder?: Responder,
  ): Promise<void> {
    const registeredIds: string[] = [];

    for (const channel of params.channels) {
      const key = `${serverId}:${channel.id}`;
      this.channels.set(key, {
        serverId,
        descriptor: channel,
        open: false,
      });
      registeredIds.push(channel.id);
    }

    // Respond before reconciliation — the server blocks on this response and
    // can't process channels/open until it arrives.
    const result: ChannelsRegisterResult = { registered: registeredIds };
    responder?.respond(result);

    // One-time migration from the retired recipe policy, then reconcile the
    // server to Chronicle-backed desired state.
    this.migrateLegacyPolicy(serverId, params.channels);
    await this.reconcileChannels(serverId, params.channels);

    this.emitTraceFn({
      type: 'mcpl:channels-register',
      serverId,
      channelIds: registeredIds,
      count: registeredIds.length,
    });
  }

  /**
   * Handle `channels/changed` notification from a server.
   *
   * Processes added (register + reconcile), removed (delete + stop typing),
   * and updated (replace descriptor) channels.
   */
  async handleChanged(
    serverId: string,
    params: ChannelsChangedParams,
  ): Promise<void> {
    // Process removed channels
    if (params.removed) {
      for (const channelId of params.removed) {
        const key = `${serverId}:${channelId}`;
        this.channels.delete(key);
        this.stopTyping(channelId);
      }
    }

    // Process updated channels (replace descriptor, preserve open state)
    if (params.updated) {
      for (const channel of params.updated) {
        const key = `${serverId}:${channel.id}`;
        const existing = this.channels.get(key);
        if (existing) {
          existing.descriptor = channel;
        }
      }
    }

    // Process added channels (register + reconcile durable desired state)
    if (params.added) {
      for (const channel of params.added) {
        const key = `${serverId}:${channel.id}`;
        this.channels.set(key, {
          serverId,
          descriptor: channel,
          open: false,
        });
      }
      await this.reconcileChannels(serverId, params.added);
    }

    this.emitTraceFn({
      type: 'mcpl:channels-changed',
      serverId,
      added: params.added?.map((c) => c.id) ?? [],
      removed: params.removed ?? [],
      updated: params.updated?.map((c) => c.id) ?? [],
    });
  }

  /**
   * Handle `channels/incoming` from a server.
   *
   * Converts each message's content, pushes McplChannelIncomingEvent to the
   * queue, and responds with per-message results.
   */
  handleIncoming(
    serverId: string,
    params: ChannelsIncomingParams,
    responder?: Responder,
  ): void {
    const results: ChannelIncomingMessageResult[] = [];

    for (const message of params.messages) {
      // Convert MCPL content blocks to membrane ContentBlocks
      const convertedContent: ContentBlock[] = message.content.map(convertBlock);

      // Track default publish channel (most recent incoming)
      this.defaultPublishChannel = message.channelId;
      this.defaultPublishMessageId = message.messageId;
      this.defaultPublishThreadId = message.threadId;

      // Lazy-register the channel if we've never seen it. A channel can deliver
      // an incoming message before its channels/register (boot enumeration) or
      // channels/changed (post-boot create / View-permission grant) round-trip
      // lands — or the registration event can be missed entirely (e.g. the bot
      // gains visibility in a way that fires neither `channelCreate` nor a
      // View-permission transition). Without a registry entry, routeSpeech()
      // can't resolve this channel as an outbound locus and the agent's reply
      // is silently dropped, even though this very message proves the channel
      // is reachable. The inbound message carries enough to make it publishable,
      // so register it here; a later authoritative channels/register or
      // channels/changed will overwrite this descriptor with the richer one.
      const incomingKey = `${serverId}:${message.channelId}`;
      if (!this.channels.has(incomingKey)) {
        const channelLabel =
          typeof message.metadata?.channelName === 'string' && message.metadata.channelName
            ? (message.metadata.channelName as string)
            : message.channelId;
        this.channels.set(incomingKey, {
          serverId,
          descriptor: {
            id: message.channelId,
            type: serverId,
            label: channelLabel,
            direction: 'bidirectional',
            address: message.threadId ? { threadId: message.threadId } : undefined,
            metadata: { lazyRegistered: true },
          },
          open: true,
        });
        this.emitTraceFn({
          type: 'mcpl:channel-lazy-registered',
          serverId,
          channelId: message.channelId,
          label: channelLabel,
        });
      } else {
        // A server sending channels/incoming is authoritative evidence that
        // the transport is actually open. This repairs transient status only;
        // durable desired state still changes exclusively through lifecycle
        // operations.
        this.channels.get(incomingKey)!.open = true;
      }

      // Determine whether to trigger inference
      let triggerInference = true;
      if (this.shouldTriggerInference) {
        const textContent = message.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        triggerInference = this.shouldTriggerInference(
          textContent,
          {
            ...message.metadata,
            eventType: 'mcpl:channel-incoming',
            serverId,
            channelId: message.channelId,
            messageId: message.messageId,
            threadId: message.threadId,
            author: message.author,
            ...(message.tags ? { tags: message.tags } : {}),
          },
        );
      }

      // Build the incoming event
      const event: McplChannelIncomingEvent = {
        type: 'mcpl:channel-incoming',
        serverId,
        channelId: message.channelId,
        messageId: message.messageId,
        threadId: message.threadId,
        author: message.author,
        content: convertedContent,
        timestamp: message.timestamp,
        metadata: message.metadata,
        ...(message.tags ? { tags: message.tags } : {}),
        triggerInference,
      };

      // Push to the processing queue
      // Cast through unknown because McplChannelIncomingEvent matches the
      // CustomEvent `${string}:${string}` type pattern but lacks an index signature.
      this.pushEventFn(event as unknown as ProcessEvent);

      // Collect per-message result
      results.push({
        messageId: message.messageId,
        accepted: true,
      });
    }

    const result: ChannelsIncomingResult = { results };
    responder?.respond(result);

    this.emitTraceFn({
      type: 'mcpl:channels-incoming',
      serverId,
      messageCount: params.messages.length,
      channelIds: [...new Set(params.messages.map((m) => m.channelId))],
    });
  }

  /**
   * Ensure a channel is registered so it can serve as an outbound routing
   * locus. A push event from a closed channel must never mutate lifecycle
   * state: direct-address events are intentionally usable without subscribing.
   *
   * Mirrors the lazy-registration inside handleIncoming(), but for channels
   * that only ever arrive as push/events rather than channels/incoming — the
   * motivating case is Discord DMs, which discord-mcpl forwards via push/event
   * with the channel closed (`channelIsOpen:false`). Such a channel is never
   * registered, so routeSpeech() can't resolve it and the agent's reply is
   * silently dropped even though the inbound message proves the channel is
   * reachable (item-3 redux, DM sub-case). Idempotent: a later authoritative
   * channels/register or channels/changed overwrites this descriptor with the
   * richer one.
   */
  ensureChannelRegistered(serverId: string, channelId: string, label?: string): void {
    const existing = this.findChannelEntry(channelId);
    if (existing) {
      return;
    }

    const key = `${serverId}:${channelId}`;
    this.channels.set(key, {
      serverId,
      descriptor: {
        id: channelId,
        type: serverId,
        label: label ?? channelId,
        direction: 'bidirectional',
        metadata: { lazyRegistered: true },
      },
      open: false,
    });
    this.emitTraceFn({
      type: 'mcpl:channel-lazy-registered',
      serverId,
      channelId,
      label: label ?? channelId,
    });
  }

  // ==========================================================================
  // Typing Indicator Management
  // ==========================================================================

  /**
   * Start sending typing indicators for a channel.
   *
   * Sends a typing notification immediately and every 7 seconds thereafter.
   * Discord typing indicators last ~10s, so 7s keeps them alive.
   *
   * No-op if already typing on this channel.
   */
  startTyping(channelId: string, metadata?: Record<string, unknown>): void {
    const metadataChanged =
      metadata !== undefined &&
      !shallowEqualRecord(this.typingMetadata.get(channelId), metadata);
    if (metadata) {
      this.typingMetadata.set(channelId, metadata);
    }

    if (this.typingIntervals.has(channelId)) {
      // Already typing. If the caller supplied new routing metadata (e.g. the
      // relevant Zulip topic just moved because a newer message arrived),
      // dispatch an immediate refresh so the server sees the new routing
      // within this request instead of waiting up to TYPING_INTERVAL_MS for
      // the next tick.
      if (metadataChanged) {
        const entry = this.findChannelEntry(channelId);
        if (entry) {
          this.sendTypingNotification(entry.serverId, channelId);
        }
      }
      return;
    }

    // Find the channel entry and its server
    const entry = this.findChannelEntry(channelId);
    if (!entry) {
      return;
    }

    // Send typing immediately
    this.sendTypingNotification(entry.serverId, channelId);

    // Set up interval — pulls the latest metadata on each tick so mid-stream
    // updates (e.g. a newer incoming message switching the relevant topic)
    // take effect on the next refresh.
    const interval = setInterval(() => {
      this.sendTypingNotification(entry.serverId, channelId);
    }, TYPING_INTERVAL_MS);

    this.typingIntervals.set(channelId, interval);
  }

  /**
   * Stop sending typing indicators.
   *
   * If channelId is specified, stops typing on that channel only.
   * If no channelId, stops all typing indicators.
   */
  stopTyping(channelId?: string): void {
    if (channelId !== undefined) {
      const interval = this.typingIntervals.get(channelId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(channelId);
        // Dispatch an explicit 'stop' so servers that support it (e.g. Zulip)
        // clear the indicator immediately rather than waiting for auto-expire.
        // Metadata still carries the routing hint so the stop hits the same
        // topic/thread as the start. Guarded by `interval`: matches the
        // global-clear branch's semantics, and keeps defensive stopTyping(ch)
        // calls from spamming stops at a server that never saw a start.
        const entry = this.findChannelEntry(channelId);
        if (entry && this.sendTypingFn) {
          this.sendTypingFn(entry.serverId, channelId, this.typingMetadata.get(channelId), 'stop');
        }
      }
      this.typingMetadata.delete(channelId);
    } else {
      // Clear all typing intervals and dispatch stop for each known channel
      const channels = Array.from(this.typingIntervals.keys());
      for (const interval of this.typingIntervals.values()) {
        clearInterval(interval);
      }
      this.typingIntervals.clear();
      if (this.sendTypingFn) {
        for (const id of channels) {
          const entry = this.findChannelEntry(id);
          if (entry) this.sendTypingFn(entry.serverId, id, this.typingMetadata.get(id), 'stop');
        }
      }
      this.typingMetadata.clear();
    }
  }

  // ==========================================================================
  // Accessors
  // ==========================================================================

  /**
   * Get the default publish channel ID (most recent incoming channel).
   */
  getDefaultPublishChannel(): string | null {
    return this.defaultPublishChannel;
  }

  /**
   * Get the descriptor for a channel by its channelId (first match across
   * servers). Used by the conversation router for DM classification.
   */
  getDescriptor(channelId: string): ChannelDescriptor | undefined {
    return this.findChannelEntry(channelId)?.descriptor;
  }

  isChannelOpen(channelId: string): boolean {
    return this.findChannelEntry(channelId)?.open === true;
  }

  getDesiredState(serverId: string, channelId: string): DesiredChannelState | undefined {
    return this.desiredStates.get(this.lifecycleKey(serverId, channelId))?.state;
  }

  /**
   * Get all open channels.
   */
  getOpenChannels(): ChannelEntry[] {
    const result: ChannelEntry[] = [];
    for (const entry of this.channels.values()) {
      if (entry.open) {
        result.push(entry);
      }
    }
    return result;
  }

  // ==========================================================================
  // Synthesized Channel Tools
  // ==========================================================================

  /**
   * Get synthesized tool definitions for channel operations.
   */
  getChannelTools(): ToolDefinition[] {
    return CHANNEL_TOOL_DEFINITIONS;
  }

  /**
   * Handle a call to one of the synthesized channel tools.
   */
  async handleChannelToolCall(toolName: string, input: unknown): Promise<ToolResult> {
    switch (toolName) {
      case 'channel_list':
        return this.handleToolList();

      case 'channel_open':
        return this.handleToolOpen(input as {
          channelId: string;
          serverId?: string;
          backscroll?: number;
          beforeMessageId?: string;
        });

      case 'channel_close':
        return this.handleToolClose(input as { channelId: string; serverId?: string });

      case 'channel_decline':
        return this.handleToolDecline(input as {
          channelId: string;
          serverId?: string;
          messageId: string;
          acknowledge?: string;
        });

      case 'channel_publish':
        return this.handleToolPublish(input as { channelId: string; content: string });

      case 'think':
        return this.handleToolThink(input as { content?: string });

      case 'skip_reply':
        return this.handleToolSkipReply(input as { reason?: string });

      default:
        return { success: false, error: `Unknown channel tool: ${toolName}`, isError: true };
    }
  }

  // ==========================================================================
  // Channel Context for beforeInference
  // ==========================================================================

  /**
   * Build channel context for inclusion in beforeInference params.
   *
   * Returns undefined if no channels are active.
   */
  buildChannelContext(agentName?: string): ChannelContext | undefined {
    const openChannels = this.getOpenChannels();

    // Resolve the outbound locus the SAME way routeSpeech does, so the agent is
    // told the channel its speech will actually land in: a conversation fork's
    // home channel, else this turn's triggering channel (single trunk agent —
    // item-3 redux), else the global default (heartbeats). Without this, a fork
    // was advertised the global locus but published somewhere else; and a trunk
    // agent was told the wrong channel under concurrency.
    const home = agentName ? this.homeChannelResolver?.(agentName) : undefined;
    const active = agentName ? this.activeChannelResolver?.(agentName) : undefined;
    const outgoing = home ?? active ?? this.defaultPublishChannel;

    if (openChannels.length === 0 && !outgoing) {
      return undefined;
    }

    const context: ChannelContext = {};

    // Incoming: the most-recent inbound message (what the agent is replying to).
    // Left process-global — per-channel inbound tracking (the right messageId for
    // a fork's own channel) is a separate concern from the outbound routing fix.
    if (this.defaultPublishChannel && this.defaultPublishMessageId) {
      context.incoming = {
        channelId: this.defaultPublishChannel,
        messageId: this.defaultPublishMessageId,
        threadId: this.defaultPublishThreadId,
      };
    }

    // Default outgoing: the resolved outbound locus (home channel for forks).
    if (outgoing) {
      context.defaultOutgoing = {
        channelId: outgoing,
      };
    }

    // Candidates: all open channel IDs
    if (openChannels.length > 0) {
      context.candidates = openChannels.map((e) => e.descriptor.id);
    }

    return context;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Remove all channel state belonging to a single server. Called by the
   * framework when an MCPL server is disconnected at runtime, so a dead
   * server's channels don't linger and route speech into the void.
   */
  removeServer(serverId: string): void {
    for (const [key, entry] of this.channels) {
      if (entry.serverId !== serverId) continue;
      this.channels.delete(key);
      this.stopTyping(entry.descriptor.id);
      if (this.defaultPublishChannel === entry.descriptor.id) {
        this.defaultPublishChannel = null;
        this.defaultPublishMessageId = null;
        this.defaultPublishThreadId = undefined;
      }
    }
    // Desired state and migration markers deliberately survive disconnects.
  }

  /**
   * Stop all typing intervals and clear all channel registrations.
   */
  stopAll(): void {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear channels map
    this.channels.clear();

    // Reset default publish tracking
    this.defaultPublishChannel = null;
    this.defaultPublishMessageId = null;
    this.defaultPublishThreadId = undefined;
  }

  // ==========================================================================
  // Private: Durable desired state and reconciliation
  // ==========================================================================

  private lifecycleKey(serverId: string, channelId: string): string {
    return `${serverId}\u0000${channelId}`;
  }

  private initializeLifecycleStore(): void {
    if (!this.store) return;

    try {
      this.store.registerState({ id: CHANNEL_LIFECYCLE_LOG_ID, strategy: 'append_log' });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('State already exists')) {
        throw error;
      }
    }

    const raw = this.store.getStateJson(CHANNEL_LIFECYCLE_LOG_ID);
    if (!Array.isArray(raw)) return;

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const event = item as Partial<ChannelLifecycleEvent>;
      if (typeof event.serverId !== 'string') continue;
      if (
        event.kind === 'desired-state' &&
        typeof event.channelId === 'string' &&
        (event.desired === 'open' || event.desired === 'closed')
      ) {
        this.desiredStates.set(
          this.lifecycleKey(event.serverId, event.channelId),
          { state: event.desired, source: typeof event.source === "string" ? event.source : "unknown" },
        );
      } else if (event.kind === 'legacy-policy-migrated') {
        this.migratedLegacyPolicies.add(event.serverId);
      }
    }
  }

  private appendLifecycleEvent(event: ChannelLifecycleEvent): void {
    this.store?.appendToStateJson(CHANNEL_LIFECYCLE_LOG_ID, event);
  }

  private setDesiredState(
    serverId: string,
    channelId: string,
    desired: DesiredChannelState,
    source: string,
  ): void {
    const key = this.lifecycleKey(serverId, channelId);
    if (this.desiredStates.get(key)?.state === desired) return;
    this.desiredStates.set(key, { state: desired, source });
    this.appendLifecycleEvent({
      kind: 'desired-state',
      serverId,
      channelId,
      desired,
      source,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Consume the old recipe policy exactly once. It seeds Chronicle for
   * existing deployments, but is not an ongoing admission policy: channels
   * discovered later use their server bootstrap preference, otherwise closed.
   */
  private migrateLegacyPolicy(serverId: string, channels: ChannelDescriptor[]): void {
    if (this.migratedLegacyPolicies.has(serverId)) return;

    const policy = this.legacyPolicies.get(serverId) ?? 'manual';
    const allowList = Array.isArray(policy) ? new Set(policy) : undefined;
    for (const channel of channels) {
      if (this.getDesiredState(serverId, channel.id)) continue;
      const desired: DesiredChannelState = channel.initiallyOpen === true ||
        policy === 'auto' || allowList?.has(channel.id)
        ? 'open'
        : 'closed';
      this.setDesiredState(serverId, channel.id, desired, 'legacy-recipe-migration');
    }

    this.migratedLegacyPolicies.add(serverId);
    this.appendLifecycleEvent({
      kind: 'legacy-policy-migrated',
      serverId,
      source: Array.isArray(policy) ? 'allow-list' : policy,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * True when the server's recipe subscription policy wants this channel
   * open. This is an ONGOING admission policy (subscribed ⇒ open, no matter
   * when the channel is discovered) — not just a bootstrap seed. Allow-list
   * entries may be composite MCPL ids or raw server-internal ids.
   */
  private policyWantsOpen(serverId: string, channel: ChannelDescriptor): boolean {
    const policy = this.legacyPolicies.get(serverId) ?? 'manual';
    if (policy === 'auto') return true;
    if (Array.isArray(policy)) {
      if (policy.includes(channel.id)) return true;
      const raw = (channel.address as { channelId?: string } | undefined)?.channelId;
      return typeof raw === 'string' && raw.length > 0 && policy.includes(raw);
    }
    return false;
  }

  private ensureInitialDesiredState(serverId: string, channel: ChannelDescriptor): void {
    const wantsOpen = channel.initiallyOpen === true || this.policyWantsOpen(serverId, channel);
    const existing = this.desiredStates.get(this.lifecycleKey(serverId, channel.id));
    if (existing) {
      // A server upgrading its descriptor to initiallyOpen — or a channel
      // matching the subscription policy — may lift a pure default:
      // 'default-closed' means nobody ever decided. Real decisions
      // (agent-tool, invitation-declined, legacy migration, …) always stick.
      if (wantsOpen && existing.state === 'closed' && existing.source === 'default-closed') {
        this.setDesiredState(
          serverId,
          channel.id,
          'open',
          channel.initiallyOpen === true ? 'server-bootstrap' : 'subscription-policy',
        );
      }
      return;
    }
    this.setDesiredState(
      serverId,
      channel.id,
      wantsOpen ? 'open' : 'closed',
      channel.initiallyOpen === true
        ? 'server-bootstrap'
        : wantsOpen
          ? 'subscription-policy'
          : 'default-closed',
    );
  }

  private async reconcileChannels(
    serverId: string,
    channels: ChannelDescriptor[],
  ): Promise<void> {
    const server = this.serverRegistry.getServer(serverId);
    if (!server) return;

    for (const channel of channels) {
      this.ensureInitialDesiredState(serverId, channel);
      const key = `${serverId}:${channel.id}`;
      const desired = this.getDesiredState(serverId, channel.id);
      const entry = this.channels.get(key);
      if (desired !== 'open') {
        try {
          await server.sendChannelsClose({ channelId: channel.id });
          if (entry) entry.open = false;
        } catch (err) {
          this.emitTraceFn({
            type: 'mcpl:channel-reconcile-failed',
            serverId,
            channelId: channel.id,
            desired,
            error: (err as Error).message,
          });
        }
        continue;
      }

      try {
        await server.sendChannelsOpen({
          channelId: channel.id,
          type: channel.type,
          address: channel.address,
        });
        if (entry) entry.open = true;
      } catch (err) {
        if (entry) entry.open = false;
        this.emitTraceFn({
          type: 'mcpl:channel-reconcile-failed',
          serverId,
          channelId: channel.id,
          desired,
          error: (err as Error).message,
        });
      }
    }
  }

  // ==========================================================================
  // Private: Typing notification
  // ==========================================================================

  /**
   * Send a typing notification for a channel.
   *
   * Uses the sendTypingFn callback if provided. If not, this is a no-op
   * (typing timer lifecycle is still managed for when the callback is wired).
   */
  private sendTypingNotification(serverId: string, channelId: string): void {
    if (this.sendTypingFn) {
      this.sendTypingFn(serverId, channelId, this.typingMetadata.get(channelId));
    }
    // TODO: When server-connection exposes a public sendNotification or
    // sendTyping method, wire it here directly instead of using a callback.
  }

  // ==========================================================================
  // Private: Channel Lookup
  // ==========================================================================

  /** Server id owning a registered channel (by descriptor id), or null. */
  getChannelServerId(channelId: string): string | null {
    return this.findChannelEntry(channelId)?.serverId ?? null;
  }

  /**
   * Find a channel entry by channelId (searches across all servers).
   * Returns the first match.
   */
  private findChannelEntry(channelId: string): ChannelEntry | undefined {
    for (const [key, entry] of this.channels) {
      if (entry.descriptor.id === channelId) {
        return entry;
      }
    }
    return undefined;
  }

  private resolveToolChannelEntry(
    channelId: string,
    serverId?: string,
  ): { entry?: ChannelEntry; error?: string } {
    const matches = [...this.channels.values()].filter(
      (entry) => entry.descriptor.id === channelId && (!serverId || entry.serverId === serverId),
    );
    if (matches.length === 0) {
      return {
        error: serverId
          ? `Channel not found: ${channelId} on server ${serverId}`
          : `Channel not found: ${channelId}`,
      };
    }
    if (matches.length > 1) {
      return {
        error: `Channel id is ambiguous across MCPL servers: ${channelId}. Include serverId.`,
      };
    }
    return { entry: matches[0] };
  }

  /**
   * Find the composite key for a channel by its channelId.
   */
  private findChannelKey(channelId: string): string | undefined {
    for (const [key, entry] of this.channels) {
      if (entry.descriptor.id === channelId) {
        return key;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Private: Tool Handlers
  // ==========================================================================

  private handleToolList(): ToolResult {
    const allChannels: Array<{
      id: string;
      type: string;
      label: string;
      direction: string;
      open: boolean;
      desired: DesiredChannelState | 'unknown';
      serverId: string;
    }> = [];

    for (const entry of this.channels.values()) {
      allChannels.push({
        id: entry.descriptor.id,
        type: entry.descriptor.type,
        label: entry.descriptor.label,
        direction: entry.descriptor.direction,
        open: entry.open,
        desired: this.getDesiredState(entry.serverId, entry.descriptor.id) ?? 'unknown',
        serverId: entry.serverId,
      });
    }

    return {
      success: true,
      data: allChannels,
    };
  }

  /**
   * The single open executor: record durable desired-open intent, tell the
   * server to subscribe, mark the live entry open. Every path that opens a
   * channel — the agent's channel_open tool, delivery into a closed locus,
   * an explicit send into a closed channel — funnels here, so lifecycle
   * events, desired state, and live state can never diverge by path.
   * Desired state is recorded BEFORE the server round-trip: intent sticks
   * even if the subscribe fails, and reconciliation retries later.
   */
  private async openChannelNow(
    entry: ChannelEntry,
    source: string,
    history?: ChannelHistoryRequest,
  ): Promise<ChannelsOpenResult> {
    this.setDesiredState(entry.serverId, entry.descriptor.id, 'open', source);
    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      throw new Error(`Server not found: ${entry.serverId}`);
    }
    const result: ChannelsOpenResult = await server.sendChannelsOpen({
      channelId: entry.descriptor.id,
      type: entry.descriptor.type,
      address: entry.descriptor.address,
      ...(history ? { history } : {}),
    });
    entry.open = true;
    return result;
  }

  /**
   * Open a channel because something was DELIVERED into it (explicit send
   * tool or routed speech). Sending into a closed channel is not a thing:
   * engaging a channel opens it, so typing indicators, reaction machinery,
   * and inbound forwarding all come alive with the first outbound message.
   * Accepts composite MCPL ids or raw server-internal ids (explicit send
   * tools receive whatever the agent typed).
   */
  async openIfClosedForSend(
    rawChannelId: string,
    serverId?: string,
  ): Promise<'opened' | 'already-open' | 'unknown-channel' | 'ambiguous' | 'open-failed'> {
    let matches = [...this.channels.values()].filter(
      (e) => e.descriptor.id === rawChannelId && (!serverId || e.serverId === serverId),
    );
    if (matches.length === 0) {
      matches = [...this.channels.values()].filter(
        (e) =>
          (e.descriptor.address as { channelId?: string } | undefined)?.channelId === rawChannelId &&
          (!serverId || e.serverId === serverId),
      );
    }
    if (matches.length === 0) return 'unknown-channel';
    if (matches.length > 1) return 'ambiguous';
    const entry = matches[0]!;
    if (entry.open && this.getDesiredState(entry.serverId, entry.descriptor.id) === 'open') {
      return 'already-open';
    }
    try {
      await this.openChannelNow(entry, 'opened-by-reply');
      this.emitTraceFn({
        type: 'mcpl:channel-opened-by-send',
        serverId: entry.serverId,
        channelId: entry.descriptor.id,
      });
      return 'opened';
    } catch (err) {
      this.emitTraceFn({
        type: 'mcpl:channel-open-failed',
        serverId: entry.serverId,
        channelId: entry.descriptor.id,
        error: (err as Error).message,
      });
      return 'open-failed';
    }
  }

  private async handleToolOpen(input: {
    channelId: string;
    serverId?: string;
    backscroll?: number;
    beforeMessageId?: string;
  }): Promise<ToolResult> {
    const resolved = this.resolveToolChannelEntry(input.channelId, input.serverId);
    const entry = resolved.entry;
    if (!entry) {
      return {
        success: false,
        error: resolved.error,
        isError: true,
      };
    }

    const alreadyDesiredOpen = this.getDesiredState(entry.serverId, input.channelId) === 'open';
    if (entry.open && alreadyDesiredOpen && !input.backscroll) {
      return {
        success: true,
        data: { channelId: input.channelId, status: 'already open' },
      };
    }

    try {
      const history: ChannelHistoryRequest | undefined = input.backscroll
        ? {
            limit: Math.max(0, Math.min(500, Math.floor(input.backscroll))),
            ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
          }
        : undefined;
      const result = await this.openChannelNow(entry, 'agent-tool', history);
      return {
        success: true,
        data: {
          channelId: input.channelId,
          status: alreadyDesiredOpen ? 'reconciled' : 'opened',
          ...(result.history ? { history: result.history } : {}),
          ...(result.historyTruncated ? { historyTruncated: true } : {}),
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to open channel: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  private async handleToolClose(input: { channelId: string; serverId?: string }): Promise<ToolResult> {
    const resolved = this.resolveToolChannelEntry(input.channelId, input.serverId);
    const entry = resolved.entry;
    if (!entry) {
      return {
        success: false,
        error: resolved.error,
        isError: true,
      };
    }

    const alreadyDesiredClosed = this.getDesiredState(entry.serverId, input.channelId) === 'closed';
    if (!entry.open && alreadyDesiredClosed) {
      return {
        success: true,
        data: { channelId: input.channelId, status: 'already closed' },
      };
    }

    this.setDesiredState(entry.serverId, input.channelId, 'closed', 'agent-tool');
    this.stopTyping(input.channelId);

    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      return {
        success: false,
        error: `Server not found: ${entry.serverId}`,
        isError: true,
      };
    }

    try {
      await server.sendChannelsClose({ channelId: input.channelId });
      entry.open = false;
      return {
        success: true,
        data: { channelId: input.channelId, status: 'closed' },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to close channel: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  private async handleToolDecline(input: {
    channelId: string;
    serverId?: string;
    messageId: string;
    acknowledge?: string;
  }): Promise<ToolResult> {
    const resolved = this.resolveToolChannelEntry(input.channelId, input.serverId);
    const entry = resolved.entry;
    if (!entry) {
      return { success: false, error: resolved.error, isError: true };
    }
    if (entry.open || this.getDesiredState(entry.serverId, input.channelId) === 'open') {
      return {
        success: false,
        error: `Channel is already open: ${input.channelId}. Use channel_close to leave it.`,
        isError: true,
      };
    }

    // The lifecycle decision is authoritative even if the optional public
    // acknowledgment cannot be rendered by the surface.
    this.setDesiredState(entry.serverId, input.channelId, 'closed', 'invitation-declined');

    let acknowledged = false;
    let representation: string | undefined;
    let acknowledgmentError: string | undefined;
    if (input.acknowledge) {
      const server = this.serverRegistry.getServer(entry.serverId);
      if (!server) {
        acknowledgmentError = `Server not found: ${entry.serverId}`;
      } else {
        try {
          const result = await server.sendChannelsAcknowledge({
            channelId: input.channelId,
            messageId: input.messageId,
            intent: 'seen-not-opening',
            value: input.acknowledge,
          });
          acknowledged = result.acknowledged;
          representation = result.representation;
          if (!acknowledged) {
            acknowledgmentError = result.reason ??
              'The channel integration could not post the acknowledgment.';
          }
        } catch (error) {
          acknowledgmentError = (error as Error).message;
        }
      }
    }

    this.appendLifecycleEvent({
      kind: 'invitation-declined',
      serverId: entry.serverId,
      channelId: input.channelId,
      messageId: input.messageId,
      acknowledgment: representation ?? input.acknowledge,
      timestamp: new Date().toISOString(),
    });
    return {
      success: true,
      data: {
        channelId: input.channelId,
        status: 'remained closed',
        acknowledged,
        ...(representation ? { representation } : {}),
        ...(acknowledgmentError ? { acknowledgmentError } : {}),
      },
    };
  }

  /**
   * Handle the synthesized `think` tool — a private reasoning scratchpad. It
   * sends nothing, and (unlike before) does NOT silence the turn: trailing
   * plain text is still routed as the reply. The thought stays in the agent's
   * own context/chronicle. To deliberately not reply, the agent uses skip_reply.
   */
  private handleToolThink(input: { content?: string }): ToolResult {
    return {
      success: true,
      // Same echo-avoidance as skip_reply: the thought text is already in the
      // tool_use block; don't duplicate it in the result.
      data: {
        noted: true,
        note:
          'Thought recorded (private — not sent anywhere). Same-round text routing depends on ' +
          'your current same_round_think_text_policy; use agent_settings get to inspect it, or ' +
          'call skip_reply to end the turn without replying.',
      },
    };
  }

  /**
   * Handle the synthesized `skip_reply` tool — the deliberate "stay silent"
   * signal. A no-op as far as any surface is concerned (sends nothing); its
   * effect is that the framework's output routing treats this as a silencing
   * tool, so any trailing prose this turn is NOT posted. Replaces the old
   * overloaded use of `think` for staying silent.
   */
  private handleToolSkipReply(input: { reason?: string }): ToolResult {
    return {
      success: true,
      // The note says "ended the turn" — make it TRUE. Without endTurn the
      // framework resumes the stream after the tool result, and a model with
      // nothing to say (told its turn already ended) just calls skip_reply
      // again: observed as a 40+ round skip_reply loop on Fable 5, burning a
      // round-trip + ~70 tokens per iteration until something kills the turn.
      endTurn: true,
      // Deliberately terse: the agent's `reason` is already in the tool_use
      // block — echoing it back doubled every skip turn's footprint (observed
      // on Fable: ~60% of skip_reply result bytes were verbatim input echo).
      data: {
        skipped: true,
        note: 'Turn ended; nothing sent.',
      },
    };
  }

  /**
   * Host-owned output routing (see forking-knowledge-miner LOCUS-ROUTING-DESIGN).
   * Publish the agent's plain-text speech to the current conversational locus
   * (the most recent incoming channel, tracked cross-surface here in the host).
   * Called by the framework on a text-only turn — replaces the per-surface
   * sticky auto-post that used to live in discord-mcpl. Returns null when there
   * is no locus / the channel or its server can't be resolved (in which case
   * the speech simply stays in chronicle + module surfaces).
   */
  /** Resolve the outbound locus (fork HOME → this-turn's TRIGGERING channel →
   *  process-global default). Public so a multi-segment caller can snapshot it
   *  ONCE and pin every segment to it via routeSpeech's `overrideChannelId`. */
  resolveLocus(conversationId: string): string | null {
    const home = this.homeChannelResolver?.(conversationId);
    return home ?? this.activeChannelResolver?.(conversationId) ?? this.defaultPublishChannel ?? null;
  }

  async routeSpeech(
    conversationId: string,
    text: string,
    /** The turn's FROZEN locus, snapshotted once by the caller (resolveLocus
     *  at turn start) and passed to every segment of the turn. Mandatory:
     *  there is deliberately no live-resolution fallback here — a late
     *  dispatch resolving live can read the NEXT turn's trigger state or a
     *  stale global default and land the reply in the wrong channel (item-3,
     *  PR #32, and the 2026-07-22 Sol DM misroute). Explicit `null` means
     *  "this turn is pinned to no locus": fail loudly rather than guess. */
    locusChannelId: string | null,
  ): Promise<{ delivered: boolean; channelId: string } | null> {
    // Surface a routing failure: emit a trace AND notify the host (which drops
    // a `[discord-send-failed]` marker into chronicle) so the agent learns her
    // reply never reached the human, instead of it vanishing silently.
    const fail = (channelId: string | null, reason: string): null => {
      console.error(`[routeSpeech] ${conversationId}: ${reason} — speech NOT routed (${text.length} chars stay in chronicle)`);
      this.emitTraceFn({
        type: 'mcpl:speech-route-failed',
        channelId: channelId ?? '',
        reason,
        textLen: text.length,
      });
      this.onRouteFailure?.({ conversationId, channelId, reason, textLen: text.length });
      return null;
    };

    // Runtime backstop for JS callers the compiler can't see: an omitted
    // locus is a routing bug at the call site, never something to paper over
    // with a live re-resolution.
    if (locusChannelId === undefined) {
      return fail(null, 'caller passed no locus (routing bug: every speech path must snapshot the turn locus)');
    }
    const channelId = locusChannelId;
    if (!channelId) {
      // The turn froze with no locus (no home, no triggering channel, no
      // global inbound ever seen) — the agent was told its prose stays in
      // the archive; honor that.
      return fail(null, 'turn has no locus (no home/trigger channel; nothing to deliver into)');
    }

    const entry = this.findChannelEntry(channelId);
    if (!entry) {
      return fail(channelId, `no registered channel for locus "${channelId}"`);
    }

    // INVARIANT: it is not possible to send into a closed channel. Speech
    // routed into a closed-but-registered locus (the canonical case: a DM
    // that woke the agent — DMs register closed) OPENS the channel first,
    // so typing indicators, reaction machinery, and inbound forwarding come
    // alive with the reply. If the open fails, the speech does NOT go out:
    // a half-alive delivery is worse than a loud marker.
    if (!entry.open) {
      try {
        await this.openChannelNow(entry, 'opened-by-delivery');
        console.error(
          `[routeSpeech] ${conversationId}: locus ${channelId} was closed — opened by delivery (speech implies engagement)`,
        );
        this.emitTraceFn({
          type: 'mcpl:channel-opened-by-send',
          serverId: entry.serverId,
          channelId,
        });
      } catch (err) {
        return fail(channelId, `locus channel is closed and open failed: ${(err as Error).message}`);
      }
    }

    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      return fail(channelId, `server "${entry.serverId}" not found`);
    }

    const publishParams: ChannelsPublishParams = {
      conversationId,
      channelId,
      content: [{ type: 'text', text }],
    };
    const result = await server.sendChannelsPublish(publishParams);
    const delivered = (result as { delivered?: boolean } | undefined)?.delivered ?? true;

    // The server accepted the publish RPC but reported the message was not
    // actually delivered (e.g. missing Send Messages permission). Previously
    // this returned `{ delivered: true }`, masking the failure. Surface it.
    if (delivered === false) {
      return fail(channelId, `server "${entry.serverId}" reported delivered:false for "${channelId}"`);
    }

    console.error(`[routeSpeech] ${conversationId}: routed ${text.length} chars -> ${channelId} (server=${entry.serverId}, delivered=${delivered})`);
    this.emitTraceFn({
      type: 'mcpl:speech-routed',
      serverId: entry.serverId,
      channelId,
      delivered,
      textLen: text.length,
    });

    return { delivered, channelId };
  }

  private async handleToolPublish(input: { channelId?: string; content?: string; text?: string }): Promise<ToolResult> {
    // Resolve content: accept both `content` and `text` (backward compat)
    const messageText = input.content ?? input.text;
    if (!messageText) {
      return {
        success: false,
        error: 'Either content or text parameter is required',
        isError: true,
      };
    }

    // Resolve channelId: default to most recent incoming channel
    const channelId = input.channelId ?? this.defaultPublishChannel;
    if (!channelId) {
      return {
        success: false,
        error: 'No channelId specified and no default channel available',
        isError: true,
      };
    }

    const entry = this.findChannelEntry(channelId);
    if (!entry) {
      return {
        success: false,
        error: `Channel not found: ${channelId}`,
        isError: true,
      };
    }

    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server) {
      return {
        success: false,
        error: `Server not found: ${entry.serverId}`,
        isError: true,
      };
    }

    try {
      const publishParams: ChannelsPublishParams = {
        conversationId: '', // Framework will fill this when wired
        channelId,
        content: [{ type: 'text', text: messageText }],
      };

      const result = await server.sendChannelsPublish(publishParams);
      return {
        success: true,
        data: result ?? { delivered: true },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to publish to channel: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
