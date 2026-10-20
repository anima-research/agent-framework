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
import { convertBlock } from './convert-block.js';
import type { JsStore } from '@animalabs/chronicle';
import { isDeepStrictEqual } from 'node:util';
import { ensureStateRegistered } from '../module-registry.js';

import type {
  ChannelDescriptor,
  ChannelContext,
  ChannelsRegisterParams,
  ChannelsRegisterResult,
  ChannelsChangedParams,
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  ChannelIncomingMessageResult,
  ChannelIncomingMessage,
  ChannelsPublishParams,
  ChannelsOpenResult,
  ChannelHistoryRequest,
} from './types.js';

import type { McplServerRegistry } from './server-registry.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import type { ToolDefinition, ToolResult, ProcessEvent } from '../types/index.js';
import { expandCoreTags, isMarkerTagged } from './tags.js';
import { coalesceRejectionReason, EmptyContentError, validateCoalescedContent } from './push-coalescer.js';
import { isVisiblyEmptyConversion } from './visible-content.js';
import { logDetail, logValue } from './log-value.js';
import { RefusalLines } from './refusal-lines.js';
import { CapabilityGrant } from './capability-grant.js';
import type { InboundSource } from './inbound-source.js';
import { McplRequestError, type McplServerConnection } from './server-connection.js';
import { readSkipReplyWake } from './skip-reply-wake.js';

// ============================================================================
// Typing indicator interval (Discord typing lasts ~10s, so 7s keeps it alive)
// ============================================================================

const TYPING_INTERVAL_MS = 7_000;
const MAX_CHANNEL_LIFECYCLE_ATTEMPTS = 5;

/**
 * Where a channel's server stands for a request this host would make of it
 * (ChannelRegistry.serverReach). Only an `up` server's grant says what it
 * allows: a connection's grant is empty from a transport drop until its next
 * policy exchange settles, whatever the server will allow then.
 * - `gone`: not registered, with no connect of its id in flight (closed for
 *   good without reconnect, whose channels stay registered here, or removed),
 *   or registered, closed and not reconnecting (one kept for a child it
 *   couldn't reap), with no restart of it in flight. This host doesn't bring
 *   it back on its own.
 * - `connecting`: a connect or restart of its id in flight, or registered
 *   and connected, with the policy exchange of the transport it's on still
 *   in flight (the host's serverConnecting).
 * - `down`: registered, between transports, and reconnecting.
 * - `up`: connected, its exchange settled, granted or not, refused or
 *   unanswered: the grant it holds is that transport's answer.
 */
type ServerReach = 'gone' | 'connecting' | 'down' | 'up';

/** What a lifecycle failure tells the agent it can do next
 *  (ChannelRegistry.lifecycleFailureText, openFailedReason). */
type ChannelLifecycleFailure =
  | 'unreachable'
  | 'not-permitted'
  | 'cancelled'
  | 'unlisted'
  | 'superseded'
  | 'converge'
  | 'substituted'
  | 'removed'
  | 'not-open'
  | 'unrecorded'
  | 'overtaken'
  | 'put-back-unrecorded'
  | 'selected-again';

/**
 * A channel's lifecycle operation, or a delivery waiting on one, that didn't
 * complete. Its message is a clause in the agent's words, which its traces
 * carry too, so the two never drift apart; `kind` says what the agent can do
 * next, and `reach` where the server stood, for `unreachable`.
 * - `unreachable`: its server isn't up (ServerReach).
 * - `not-permitted`: its server is up, and its grant lacks channels.lifecycle.
 * - `cancelled`: queued for a server whose registrations were removed.
 * - `unlisted`: the server no longer lists the channel.
 * - `superseded`: a later decision about the channel came first.
 * - `converge`: a successful RPC kept failing to establish the latest target.
 * - `substituted`: a channels/open answered for a channel other than the one
 *   it named.
 * - `removed`, `not-open`: a delivery's wait (waitForOpenChannel) ended with
 *   the channel's registration gone, or with its close standing
 *   (closeStands) or its open not confirmed. These are whole reasons for
 *   words that didn't go out, said as they are.
 * - `unrecorded`: the decision couldn't be written to the lifecycle log
 *   (appendLifecycleEvent), so nothing changed and nothing was sent.
 * - `overtaken`, `put-back-unrecorded`, `selected-again`: an open by speech
 *   or a reply that failed (openChannelNow), carrying its own failure's
 *   clause. `overtaken`: a decision made during its round-trip, such as the
 *   agent's own close or channel_open, replaced the one the open wrote; that
 *   decision stands, and nothing is put back. `put-back-unrecorded`: the
 *   decision it replaced couldn't be put back on record, so the decision to
 *   open stays, the channel stays selected for opening, and reconciliation
 *   may open it later. `selected-again`: the pure default it put back is
 *   lifted by the channel's current descriptor or the subscription policy,
 *   so the channel is selected for opening again; `by` says which.
 */
class ChannelLifecycleError extends Error {
  readonly by?: Exclude<SelectedForOpening, 'unrecorded'>;
  constructor(
    message: string,
    readonly kind: ChannelLifecycleFailure,
    readonly reach?: Exclude<ServerReach, 'up'>,
    options?: { by?: Exclude<SelectedForOpening, 'unrecorded'>; cause?: unknown },
  ) {
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'ChannelLifecycleError';
    this.by = options?.by;
  }
}

/** Why a channel is selected for opening after a failed open by speech or a
 *  reply: its put-back couldn't be recorded, or the server's latest
 *  announcement or the subscription policy lifted the default it restored. */
export type SelectedForOpening = 'unrecorded' | 'server-bootstrap' | 'subscription-policy';

const CHANNEL_LIFECYCLE_LOG_ID = 'mcpl/channel-lifecycle';

/** The sources of a decision the agent itself made: channel_open and
 *  channel_close, and channel_decline. */
const AGENT_DECISION_SOURCES: ReadonlySet<string> = new Set(['agent-tool', 'invitation-declined']);

/**
 * What a channels/open answer says about which channel the server opened:
 * its `channel.id`, or else the `channelId` of a history item. Each is
 * evidence. A string other than the requested id names another channel (ids
 * compare exactly, as the server's traffic is matched). Null or absence names
 * no channel, and gives undefined, as does an answer that names none at all.
 * Any other value is malformed: it names nothing the host could register.
 */
function substitutedChannel(
  result: ChannelsOpenResult | undefined,
  requested: string,
): { kind: 'other'; id: string } | { kind: 'malformed'; value: unknown } | undefined {
  const named = (value: unknown) => {
    if (value === undefined || value === null || value === requested) return undefined;
    return typeof value === 'string' ? { kind: 'other' as const, id: value } : { kind: 'malformed' as const, value };
  };
  const answered = named(result?.channel?.id);
  if (answered) return answered;
  const history: unknown[] = Array.isArray(result?.history) ? result.history : [];
  for (const item of history) {
    const from = named((item as { channelId?: unknown } | null)?.channelId);
    if (from) return from;
  }
  return undefined;
}

/**
 * Durable "which label did this channelId have, each time we saw it" log.
 * `resolveProseTarget()` resolves a label to an id only for channels
 * currently in the live `channels` map — fine for normal addressing, but
 * useless for browsing history on a channel the bot has since disconnected
 * from (or that didn't survive a restart). This log lets that lookup survive
 * a disconnect/restart by replaying the most recent label sighting per
 * channelId. See `labelHistory`, `appendLabelSighting`, and
 * `resolveProseTargetDurable`.
 */
const CHANNEL_LABEL_HISTORY_LOG_ID = 'mcpl/channel-label-history';

type DesiredChannelState = 'open' | 'closed' | 'tuned-out';

/**
 * Parameters of an active tune-out (issue #77), carried on the
 * 'desired-state' record entering the tuned-out state and projected into
 * `desiredStates`. A tuned-out channel stays OPEN at the transport (traffic
 * must keep arriving for the subconscious); the divert-don't-wake behavior
 * is applied downstream at ingestion.
 */
export interface TuneOutParams {
  /** Identity of this tune-out epoch. Stamped into diverted messages
   *  (`metadata.tuneOut = { epochId }`) for permanent main-view exclusion
   *  and per-epoch audit; also keys durable wake counting. */
  epochId: string;
  /** Subconscious summary cadence, in seconds. */
  cadenceSeconds: number;
  /** Maximum messages dumped raw at cancel, the newest. Where the residents'
   *  strategies cap a message's size, the dump holds as many as fit whole in
   *  one message, or, when even the newest doesn't, as much of the newest as
   *  fits beside the cut's mark, if any does. For those left out the
   *  subconscious curates a digest, and `fetch_history` covers them. */
  backlogCap: number;
  /** Wake invocations before the tune-out auto-cancels. */
  maxWakes: number;
  /** Chronicle sequence when the tune-out began — window anchor + audit bound. */
  startedAtSequence: number;
  /** Absolute wall-clock deadline (epoch ms). When set, the tune-out
   *  auto-cancels at this time via the standard cancel flow ("duration
   *  elapsed") — the agent's self-binding attention budget (#77 "for a
   *  period chosen by the agent"). Unset = until cancelled. */
  expiresAtMs?: number;
}

interface ChannelLifecycleEvent {
  kind:
    | 'desired-state'
    | 'legacy-policy-migrated'
    | 'invitation-declined'
    | 'tune-out-wake';
  serverId: string;
  timestamp: string;
  channelId?: string;
  desired?: DesiredChannelState;
  /** Present when desired === 'tuned-out'. */
  tuneOut?: TuneOutParams;
  /** kind 'tune-out-wake': durable running wake count for an epoch.
   *  Lives in the lifecycle log (not gate stats) because gate runtime
   *  state dies with the process and max-wakes must not reset on restart. */
  epochId?: string;
  wakeCount?: number;
  source?: string;
  messageId?: string;
  acknowledgment?: string;
}

/** One append-log record in `CHANNEL_LABEL_HISTORY_LOG_ID`: "at `ts`, this
 *  channelId's label was observed to be `label`". See `labelHistory`. */
interface ChannelLabelSightingEvent {
  channelId: string;
  label: string;
  ts: number;
  /** DM recipient id (e.g. a Discord snowflake), when the descriptor's
   *  metadata carried one — persisted so a `<@id>` mention form can still
   *  resolve a DM's channelId after a restart, the same way
   *  `resolveProseTarget()`'s live `dmMeta().recipientId` matching does. */
  recipientId?: string;
  /** DM recipient's actual username, when the descriptor's metadata
   *  carried one — persisted because it can differ from the descriptor's
   *  display `label` (e.g. label "DM: Tess" but recipientName
   *  "antra_tessera"), and `resolveProseTarget()`'s live matching prefers
   *  it over the label for exactly that reason. Without this, an `@name`
   *  lookup after a restart could only ever match the label text, never
   *  the actual username an agent would naturally type. */
  recipientName?: string;
  /** True when the descriptor's metadata explicitly classified this
   *  channel as a DM (`channelType === 'dm'`) at sighting time — persisted
   *  because `resolveProseTarget()`'s live classification checks this
   *  metadata field FIRST, before any id-shape or label-prefix convention,
   *  so a DM whose id/label don't follow the usual `:dm:`/`DM: ` shape
   *  still needs a durable way to be recognized as a DM at all once
   *  disconnected. Only ever recorded `true` (an explicit positive
   *  classification) — a channel with no signal either way is left
   *  `undefined`, not asserted `false`, so classification always falls
   *  back to id/label-shape heuristics rather than durably asserting a
   *  negative for the (overwhelmingly common) case where this metadata
   *  was simply never sent. */
  isDm?: boolean;
}

/** Extract a DM's identity/classification fields from a descriptor's
 *  metadata, if present — mirrors `resolveProseTarget()`'s own local
 *  `dmMeta()` read (`recipientId`, `recipientName`, `channelType`). Used
 *  to durably persist them alongside a label sighting (see
 *  `ChannelLabelSightingEvent`'s corresponding fields), captured at the
 *  SAME point (sighting time) rather than re-derived later from id/label
 *  shape, which is exactly what the live resolver does NOT do either. */
function extractDmMeta(metadata: Record<string, unknown> | undefined): {
  recipientId?: string;
  recipientName?: string;
  isDm?: boolean;
} {
  const recipientId = typeof metadata?.recipientId === 'string' ? metadata.recipientId : undefined;
  const recipientName = typeof metadata?.recipientName === 'string' ? metadata.recipientName : undefined;
  const isDm = metadata?.channelType === 'dm' ? true : undefined;
  return { recipientId, recipientName, isDm };
}

/**
 * Case-insensitive channel-label comparison key: strips a leading '#' and
 * lowercases. Mirrors the normalization `resolveProseTarget()` applies to
 * its live-channel label matches (see the local `norm` there) — factored out
 * so `resolveLabelFromHistory()` recognizes the same spellings without
 * duplicating (and risking drift from) the live matching rules.
 */
function normalizeChannelLabel(s: string): string {
  return s.replace(/^#/, '').toLowerCase();
}

/**
 * Same as `normalizeChannelLabel`, but also strips a trailing parenthetical
 * guild/server suffix (e.g. "#fable (antra's server)" -> "fable") so a bare
 * channel name matches the disambiguated label agents often omit. Mirrors
 * `resolveProseTarget()`'s local `nameOf` helper.
 */
function normalizeChannelLabelName(label: string): string {
  return normalizeChannelLabel(label.replace(/\s*\([^)]*\)\s*$/, ''));
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
  /** Whether the current target is confirmed open; false can be unconfirmed. */
  open: boolean;
}

/**
 * A channel its server declared inbound-only (SPEC §14.2 `direction`): its
 * messages come in, and the host publishes nothing into it. No publish, from
 * plain speech, `channel_publish` or `publishForAgent`, and no outgoing
 * stream starts there, though one the channel took before the declaration
 * ends there (sendOutgoingChunk). Typing and acknowledgements, which carry
 * no content, still go (SPEC §14.5: "Delivery occurs only via
 * `channels/publish`"). A channel declared `outbound` or `bidirectional`, or
 * with no direction, isn't one.
 */
function isInboundOnly(entry: ChannelEntry): boolean {
  return entry.descriptor.direction === 'inbound';
}

/** Why the host sends nothing into an inbound-only channel, as the resident
 *  reads it in a send-failure marker or a tool error. */
function inboundOnlyReason(entry: ChannelEntry): string {
  return (
    `inbound-only: server "${entry.serverId}" declared this channel's direction "inbound", ` +
    'so the host publishes nothing into it; to speak there, use that server\'s own tools'
  );
}

function sameChannelTarget(a: ChannelDescriptor, b: ChannelDescriptor): boolean {
  return a.type === b.type && isDeepStrictEqual(a.address, b.address);
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
  /** Host acceptance time (epoch ms), stamped where the message is admitted. */
  acceptedAt?: number;
  /** Source envelope frozen at admission (mcpl/inbound-source.ts). */
  inboundSource?: InboundSource;
}

// ============================================================================
// Channel Tool Definitions
// ============================================================================

/**
 * `journal`'s description. It tells the model to call `skip_reply` to end the
 * turn only where the agent may call it: the framework builds each agent's
 * surface with that agent's permission, and a refused `skip_reply` leaves the
 * turn going on.
 */
export function journalToolDescription(canSkipReply: boolean): string {
  return 'Write an entry in your private journal. The entry stays in your own context and ' +
    'memory and is NOT sent to any channel, surface or person. Use it for anything longer ' +
    'than a line that you want to keep for yourself — reflections, what you decided and ' +
    'why, notes for later. It does not end your turn and does not affect where ordinary ' +
    'text is routed' + (canSkipReply ? '; to end the turn without replying, call skip_reply afterwards.' : '.');
}

const CHANNEL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'channel_list',
    description: 'List all available channels',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'channel_open',
    description:
      'Open a channel. What an open channel delivers to you depends on its MCPL server. ' +
      'Optionally request history preceding the message that invited you into the channel.',
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
    description:
      'Close a channel. Messages that address you still reach you; what else stops reaching you ' +
      'depends on its server.',
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
    description: "Publish a message to a channel. If channelId is omitted, publishes to your conversation's channel if you are bound to one; otherwise to the channel of the most recent incoming message this host received on any channel, whether or not you've been shown it. Reactions, reaction removals, deletions and edits don't set it, though an edit of a message you hadn't been shown can count as that message. A message pushed to you rather than posted on a channel never sets it. A subagent has neither default, so it must name a channel.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string', description: "ID of the channel to publish to (defaults to your conversation's channel if you are bound to one; otherwise the channel of the most recent incoming message this host received on any channel, whether or not you've been shown it, other than a reaction, reaction removal, deletion or edit, though an edit of a message you hadn't been shown can count; a message pushed to you rather than posted on a channel never sets it; required of a subagent)" },
        content: { type: 'string', description: 'Text content to publish' },
        text: { type: 'string', description: 'Alias for content' },
      },
      required: [],
    },
  },
  {
    name: 'think',
    // No agent's surface shows this description: getToolsForAgent gives every
    // agent its own think (buildThinkTool), which names skip_reply only where
    // that agent may call it.
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
    name: 'journal',
    description: journalToolDescription(true),
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The journal entry (private; not sent anywhere).' },
      },
      required: ['content'],
    },
  },
  {
    name: 'skip_reply',
    description:
      'End your turn WITHOUT sending anything to any channel or surface. Use when you have ' +
      'read the messages but deliberately choose not to reply right now — ambient chatter, ' +
      'nothing to add, or you are waiting. Any plain text you wrote this turn stays private ' +
      'and is NOT posted. To reply instead, just write plain text (no tool call). ' +
      'To end this turn but come back on your own shortly, set wake_in_seconds.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description:
            'Optional ONE short line on why you are not replying (private; not sent anywhere). ' +
            'Keep it under ~100 characters — put anything longer in journal() first.',
        },
        wake_in_seconds: {
          type: 'number',
          description:
            'Optional self-wake: if nothing else wakes you first, you wake again after this ' +
            'many seconds, from 1 to 3600; a larger number waits 3600 (1 = go again almost ' +
            'immediately). Any other wake before then cancels it. Omit to stay idle until the ' +
            'next external wake.',
        },
      },
      required: [],
    },
  },
];

// ============================================================================
// Constructor Options
// ============================================================================

/** Bound connector values for notices, logs and an outcome's reason. A
 *  PublishOutcome keeps the connector's structured data (`detail`) as the
 *  connection gives it, its strings redacted (redactedData). */
export function connectorText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable connector value]';
  }
  const limit = 2000;
  const suffix = '… [truncated]';
  return text.length > limit ? text.slice(0, limit - suffix.length) + suffix : text;
}

/** Where a publish was resolved to go — named by the registry, never by
 *  the caller's spelling. */
export interface PublishDestination {
  serverId: string;
  channelId: string;
  /** The channel's registered label when the attempt was made. */
  label?: string;
}

/** One key per destination, its server and channel: unlike joining the two
 *  with a separator, no two destinations share one, whatever their ids hold. */
export function destinationKey(to: PublishDestination): string {
  return JSON.stringify([to.serverId, to.channelId]);
}

/**
 * What one channels/publish attempt established (ChannelRegistry.publish).
 * - `delivered`: the connector returned `delivered: true`. A historical
 *   receipt (confirmed at `at`, to `destination`, message `messageId` when
 *   the connector named one), not a claim the message still exists.
 * - `failed`: nothing was posted: the request never left the host
 *   (unresolvable or shared channel id, missing grant, failed open, closed
 *   connection), or the connector answered `delivered: false` and named no
 *   message.
 * - `unknown`: the request was dispatched and no valid receipt came back (an
 *   error response, a timeout, a lost connection, or a missing, malformed or
 *   contradictory receipt, such as `delivered: false` beside a message id).
 *   It may or may not have been posted.
 */
export interface PublishOutcome {
  status: 'delivered' | 'failed' | 'unknown';
  /** Absent only when no destination could be resolved. */
  destination?: PublishDestination;
  messageId?: string;
  /** Why it failed, or why its outcome is unknown — for a connector error,
   *  its message, bounded (which may say what was already posted). */
  reason?: string;
  /** The connector error's structured `data`, with the strings in it
   *  redacted (redactedData), when it sent one. */
  detail?: unknown;
  /** When the outcome was established (epoch ms). */
  at: number;
}

/**
 * A failed request's words, bounded, for a reason that a caller composes.
 * This host's own words, for a request that wasn't sent or wasn't answered
 * or for an error of its own, such as its store's, are sentences, and every
 * composition of a reason adds its own ending, so one final period comes
 * off them. A server's error answer keeps its words as they came.
 */
function requestErrorText(err: unknown): string {
  const text = connectorText(err instanceof Error ? err.message : String(err));
  return err instanceof McplRequestError && err.outcome === 'error-response' ? text : text.replace(/(?<!\.)\.$/, '');
}

/** A server that isn't up (ServerReach), as a clause the agent reads. */
function unreachableClause(serverId: string, reach: Exclude<ServerReach, 'up'>): string {
  switch (reach) {
    case 'gone': return `the "${serverId}" server isn't connected, and this host won't reconnect to it on its own`;
    case 'connecting': return `this host is connecting to the "${serverId}" server`;
    case 'down': return `the "${serverId}" server isn't connected, and this host is reconnecting to it`;
  }
}

/** What helps when a server isn't up (ServerReach), as the end of the
 *  clause that says so. */
function unreachableRemedy(reach: Exclude<ServerReach, 'up'>): string {
  switch (reach) {
    case 'gone': return '; if you need it, ask whoever runs this host';
    case 'connecting': return ', so try again in a moment';
    case 'down': return ', so try again later';
  }
}

/** Whether an entry's descriptor carries the key a push's placeholder has
 *  (ensureChannelRegistered's lazyRegistered metadata), as main reads it for
 *  whether the server has declared the channel: a registration or a
 *  channels/changed update brings the server's own descriptor, which
 *  doesn't normally carry it. The traffic rule doesn't read it, since a
 *  server's descriptor can (untargetedPushEntries). */
function pushPlaceholder(entry: ChannelEntry): boolean {
  return (entry.descriptor.metadata as { lazyRegistered?: boolean } | undefined)?.lazyRegistered === true;
}

/** When reconciling applies a recorded decision: at the server's next
 *  registration of the channel, where this host directs its channels'
 *  lifecycle then (reconcileChannels, §14.1). A channel made from a push
 *  may never be registered at all, so for one the text says "if". */
function laterClause(entry: ChannelEntry): string {
  return pushPlaceholder(entry)
    ? `if the "${entry.serverId}" server registers this channel at a time this host may open and close its channels`
    : `when the "${entry.serverId}" server next registers this channel, if this host may open and close its channels then`;
}

/** A channel decision the lifecycle log refused to append, as on a full
 *  disk: nothing changed (appendLifecycleEvent). */
function unrecordedDecision(err: unknown): ChannelLifecycleError {
  return new ChannelLifecycleError(`this host couldn't record the decision: ${requestErrorText(err)}`, 'unrecorded');
}

/** A failure's clause, then more said of the same failure. A server's own
 *  words keep their final stop (requestErrorText), so after them the rest
 *  is a sentence of its own. */
function afterClause(clause: string, more: string): string {
  return /[.!?]$/.test(clause) ? `${clause} ${more.charAt(0).toUpperCase()}${more.slice(1)}` : `${clause}; ${more}`;
}

/** A lifecycle failure as a clause: its own words, or its request's. */
function lifecycleClause(err: unknown): string {
  return err instanceof ChannelLifecycleError ? err.message : requestErrorText(err);
}

/** Why words didn't go out when their channel's registration went away
 *  first, at a delivery's wait or at its last check. */
const CHANNEL_REMOVED_CLAUSE = 'the channel was removed before these words went out';

/**
 * Why words a send opened their channel for didn't go out. The delivery's
 * wait after the open says it whole (`removed`, `not-open`). The open's own
 * failure is said as one, with what helps where there's a step to take. It
 * names no state of the channel's transport: one decided closed can still
 * be open, after a close that failed.
 */
function openFailedReason(err: unknown): string {
  if (err instanceof ChannelLifecycleError && (err.kind === 'removed' || err.kind === 'not-open')) return err.message;
  return `opening the channel for these words didn't complete: ${lifecycleClause(err)}${refusalRemedy(err)}`;
}

/** What helps after a lifecycle failure, as the end of the clause that says
 *  it: the server state's remedy, whom to ask for a grant, or another try
 *  where the channel's target kept changing or the decision couldn't be
 *  recorded. Nothing for any other failure. */
function refusalRemedy(err: unknown): string {
  if (!(err instanceof ChannelLifecycleError)) return '';
  if (err.kind === 'unreachable' && err.reach) return unreachableRemedy(err.reach);
  if (err.kind === 'not-permitted') return '; if you need it, ask whoever runs this host';
  if (err.kind === 'converge') return ', so try again';
  if (err.kind === 'unrecorded') return ', so try again; if it fails the same way, ask whoever runs this host';
  return '';
}

/** Why an open or a close doesn't stand when a later decision about the
 *  channel came first (`now`, its desired state since). */
function supersededClause(action: 'open' | 'close', now: DesiredChannelState | undefined): string {
  if (now === 'tuned-out') return 'it was tuned out meanwhile';
  return action === 'close' ? 'a later decision to keep it open came first' : 'a later decision to close it came first';
}

/** A clause as the start of a sentence. */
function sentenceStart(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/** Words as a sentence's end: a stop, unless they end in one already, as a
 *  server's own words may. */
function withStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * What a channels/publish request that threw establishes. Only a request
 * that never left the host proves nothing was posted. An error response may
 * follow a partial post (a multi-part send whose later part failed), so it
 * is unknown, with the connector's own words, bounded, and its data kept for
 * the resident to judge. The publish executor and channel_publish both read
 * a failed request this way.
 */
function publishErrorOutcome(err: unknown, destination: PublishDestination, at: number): PublishOutcome {
  const message = requestErrorText(err);
  const notSent = err instanceof McplRequestError && err.outcome === 'not-sent';
  const detail = err instanceof McplRequestError ? err.data : undefined;
  return {
    status: notSent ? 'failed' : 'unknown',
    destination,
    reason: notSent ? message : `${message} (delivery uncertain)`,
    ...(detail !== undefined ? { detail } : {}),
    at,
  };
}

/**
 * What a channels/publish answer establishes. A final publish is a request,
 * so success requires an explicit receipt; a missing or malformed one leaves
 * delivery uncertain (anima-research/agent-framework#163's rule).
 * `delivered: false` proves nothing went out only when the receipt names no
 * message at all: a message id beside it, valid or malformed, contradicts it,
 * since something may have been posted. The publish executor and
 * channel_publish both read an answer this way.
 */
function publishReceiptOutcome(result: unknown, destination: PublishDestination, at: number): PublishOutcome {
  const receipt = (result ?? {}) as { delivered?: unknown; messageId?: unknown };
  const messageId = typeof receipt.messageId === 'string' && receipt.messageId ? receipt.messageId : undefined;
  if (receipt.delivered === true) {
    return { status: 'delivered', destination, ...(messageId ? { messageId } : {}), at };
  }
  if (receipt.delivered === false) {
    if (receipt.messageId === undefined || receipt.messageId === null) {
      return { status: 'failed', destination, reason: `the "${destination.serverId}" server said it didn't post the message`, at };
    }
    return {
      status: 'unknown',
      destination,
      ...(messageId ? { messageId } : {}),
      reason: messageId
        ? `the "${destination.serverId}" server said it didn't post the message, yet named message ` +
          `${connectorText(messageId)} as posted (delivery uncertain)`
        : `the "${destination.serverId}" server said it didn't post the message, along with a message id that ` +
          `isn't valid (${connectorText(receipt.messageId)}) (delivery uncertain)`,
      at,
    };
  }
  return {
    status: 'unknown',
    destination,
    ...(messageId ? { messageId } : {}),
    reason: `the "${destination.serverId}" server's answer didn't say whether it posted the message (delivery uncertain)`,
    at,
  };
}

interface ChannelRegistryOptions {
  /**
   * An ordinary (uncoalesced) `channels/incoming` message has just been
   * admitted, before it is queued or acknowledged: return its source
   * envelope, frozen now (mcpl/inbound-source.ts). The framework observes the
   * acceptance here; coalesced work is stamped and observed by its own path.
   */
  acceptInbound?: (event: McplChannelIncomingEvent) => InboundSource | undefined;
  /**
   * RFC-006: an admitted `channels/incoming` message carrying `coalesce`, with
   * the event the ordinary path would have queued. The handler decides
   * replace / append / withdraw and returns the per-message result. Throws a
   * `CoalesceError` for a malformed or unauthorized occurrence. `firstView`
   * says the coalescer delivered the message as the agent's first view of it,
   * with the delivery's own `firstView` mark; it is the host's own, and isn't
   * in the answer to the server.
   */
  handleCoalescedIncoming?: (
    serverId: string,
    message: ChannelIncomingMessage,
    event: McplChannelIncomingEvent,
  ) => Promise<ChannelIncomingMessageResult & { firstView?: true }>;
  /** Chronicle store used for durable desired channel lifecycle state. */
  store?: JsStore;
  /** Callback to determine whether an incoming message should trigger inference. */
  shouldTriggerInference?: (content: string, metadata: Record<string, unknown>) => boolean;
  /**
   * Called when a text-only turn's speech was not delivered to its
   * conversational locus (`failed`), or may not have been (`unknown`), for
   * whatever reason deliverSpeech gives, such as no locus, a channel that
   * isn't registered or refuses speech, a missing server or grant, a failed
   * open, the server reporting `delivered: false`, or a publish answered
   * with an error, a timeout or a lost connection, after which whether it
   * was posted is unknown. It isn't called for an ephemeral run's speech
   * whose turn has no locus (a null locus), which is its caller's result
   * (`takesGlobalFallback`), nor for a `failed` delivery whose caller holds
   * its words with a notice of its own (deliverSpeech's `heldOnFailure`).
   * The host wires this to drop a `[discord-send-failed]` marker into
   * chronicle so the failure is visible to the agent (and operator) rather
   * than silently lost. Must not itself trigger inference (avoid wake loops).
   */
  onRouteFailure?: (info: {
    conversationId: string;
    channelId: string | null;
    reason: string;
    textLen: number;
    /** `failed`: nothing was posted; `unknown`: the request was dispatched
     *  and no valid receipt came back, so it may or may not have been. */
    outcome?: 'failed' | 'unknown';
    /** Bounded display of the connector's structured error data, when present. */
    detail?: string;
  }) => void;
  /**
   * Announces either a durable subscription-policy admission (before its
   * transport RPC; not an open confirmation), or a delivery that turned a
   * closed channel open, once its transport is confirmed. Reconfirming the
   * transport of a channel already decided open or tuned out isn't one.
   * The host records a durable, non-waking notice. What an open channel
   * delivers is the server's to say (#406).
   * Policy admissions fire once per channel: the persisted desired-state
   * decision prevents re-announcement on retry or reboot. channel_close
   * supersedes policy; a fresh delivery into a closed locus engages it again.
   */
  onChannelAutoOpened?: (info: {
    /** Agent whose action caused the open (delivery); absent for policy opens. */
    conversationId?: string;
    serverId: string;
    source: 'subscription-policy' | 'opened-by-delivery';
    channels: Array<{ channelId: string; label?: string }>;
  }) => void;
  /**
   * Resolve a conversation fork's HOME channel from its agent name. Conversation
   * forks are spawned bound to a single channel (the framework tracks this in
   * `conversationAgentHomes` / `ConversationRouter.channelForAgent`); their
   * plain-text speech must route THERE. The process-global `defaultPublishChannel`
   * tracks only the most recent inbound message across ALL channels (reaction,
   * reaction-removal, edit and deletion markers aside, apart from an edit the
   * coalescer delivers on acceptance as the agent's first view), so with one
   * fork per channel running concurrently it misroutes a fork's reply to
   * whichever channel last spoke (item 3). Returns undefined for the trunk/primary agent, which has
   * no home and correctly falls back to the global locus (heartbeats, etc.).
   */
  homeChannelResolver?: (agentName: string) => string | undefined;
  /**
   * Resolve an agent's channel for its CURRENT inference turn, by agent name:
   * the turn's locus once it has one, else the channel that triggered the
   * turn. This is the fix for single-TRUNK agents (the only mode
   * connectome-host runs — it never exposes conversation forks). A trunk agent
   * has no fork home, so without this its plain-text speech falls back to the
   * process-global `defaultPublishChannel`, which tracks the most recent inbound
   * message across ALL channels (markers aside) and misroutes a reply to
   * whichever channel last spoke under concurrency (item-3 redux). The
   * framework keeps both on the live turn's routing state and exposes them
   * here. For a heartbeat / no-trigger turn it resolves to undefined until the
   * turn's locus is resolved, so that
   * resolution takes the global fallback, which the turn then keeps.
   * Consulted AFTER `homeChannelResolver` (a fork's home always wins), BEFORE
   * `defaultPublishChannel`.
   */
  activeChannelResolver?: (agentName: string) => string | undefined;
  /**
   * Whether a conversation takes the process-global fallback, the channel of
   * the most recent delivered inbound message: as where its plain speech lands
   * when it has no home and no channel of its own this turn, as its channel
   * context's `incoming` and default outgoing channel, and as
   * `channel_publish`'s target when it names none. False for an ephemeral run
   * (a subagent): its prose is its caller's result, so a channel that only the
   * latest inbound message picked is never its destination, and its plain
   * speech with no channel of its own is undelivered rather than a failed
   * delivery. Absent, every conversation takes it.
   */
  takesGlobalFallback?: (conversationId: string) => boolean;
  /** Whether this framework has EventGate and can honor skip_reply self-wakes. */
  eventGatePresent?: boolean;
  /**
   * Whether this host is connecting to the server of this id: a connect or a
   * restart of the id is in flight, or the policy exchange of the transport
   * its registered connection is on is. Its channel tools and speech then say
   * so, as its tool calls do, rather than read the empty grant meanwhile as a
   * refusal (serverReach). It words a refusal only: the grant decides.
   */
  serverConnecting?: (serverId: string) => boolean;
}

// ============================================================================
// ChannelRegistry
// ============================================================================

/**
 * Who is actually making a channel tool call, as established by the
 * framework's own dispatch — model-origin calls come through
 * dispatchToolCall (which knows the agent), module calls come through
 * ModuleContext.callTool. Tool INPUT can claim anything; this cannot.
 */
export type ChannelToolOrigin =
  | { kind: 'module'; moduleName?: string }
  | { kind: 'agent'; agentName: string };

/** The machine decision sources a module-origin channel_close may record.
 *  Closed on purpose: honest provenance means a small, auditable vocabulary,
 *  not arbitrary self-description. */
export const MACHINE_CLOSE_SOURCES = new Set(['subscription-gc', 'housekeeping']);

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
  private onRouteFailure?: ChannelRegistryOptions['onRouteFailure'];
  private onChannelAutoOpened?: (info: {
    conversationId?: string;
    serverId: string;
    source: 'subscription-policy' | 'opened-by-delivery';
    channels: Array<{ channelId: string; label?: string }>;
  }) => void;
  private homeChannelResolver?: (agentName: string) => string | undefined;
  private activeChannelResolver?: (agentName: string) => string | undefined;
  private takesGlobalFallback?: (conversationId: string) => boolean;
  private serverConnecting?: (serverId: string) => boolean;
  private store?: JsStore;

  /** Registered channels, keyed by `{serverId}:{channelId}`. */
  private channels = new Map<string, ChannelEntry>();

  /**
   * Each outgoing stream, by `inferenceId`, with the destinations it has
   * started at (destinationKey): the rest of the stream there goes on there,
   * and its `complete` goes only there (sendOutgoingChunk). An entry goes
   * with the stream's `complete` for its destination.
   */
  private takenStreams = new Map<string, Set<string>>();

  /** Holds back repeats of the line for a message refused because its
   *  channel isn't registered (RefusalLines). */
  private unknownChannelLines = new RefusalLines();

  /**
   * Most-recently-known label per channelId, replayed from
   * `CHANNEL_LABEL_HISTORY_LOG_ID` (last sighting wins) and kept current by
   * `appendLabelSighting()`. Unlike `channels`, this survives disconnect and
   * restart — it's what lets `resolveProseTargetDurable()` resolve a label
   * for a channel that's no longer live. Keyed by bare channelId, not
   * `{serverId}:{channelId}` — the label history exists to answer "what id
   * did this label refer to", independent of which server it came through.
   */
  private labelHistory = new Map<string, string>();

  /**
   * EVERY distinct label a channelId has ever been durably seen with (not
   * just the latest) — additive alongside `labelHistory`, populated by the
   * same replay-at-boot loop and the same `appendLabelSighting()` call.
   * `labelHistory` alone can only resolve a channel's CURRENT/latest name;
   * this is what lets `resolveLabelFromHistory()` find a channel by a label
   * it used to have before a rename — the exact case this whole durable log
   * exists for (finding an old/renamed channel while browsing history).
   */
  private allLabelsSeen = new Map<string, Set<string>>();

  /**
   * DM recipientId per channelId, durably replayed alongside `labelHistory`
   * — the piece a `<@id>` mention-form lookup needs that `allLabelsSeen`'s
   * label strings alone can't provide. See `resolveLabelFromHistory()`'s
   * DM-aware arm.
   */
  private dmRecipientIds = new Map<string, string>();

  /**
   * DM recipient's actual username per channelId — can differ from the
   * channel's display label (`resolveProseTarget()`'s live DM matching
   * prefers this over the label for exactly that reason). See
   * `resolveDmFromHistory()`.
   */
  private dmRecipientNames = new Map<string, string>();

  /**
   * channelId -> true, for every channel EXPLICITLY classified as a DM via
   * `metadata.channelType === 'dm'` at some sighting — an id/label-shape-
   * independent classification signal, the same one `resolveProseTarget()`
   * checks live. Only ever holds `true`; a channel with no explicit
   * classification is simply absent (not `false`), so `isDmChannelId()`
   * falls back to id/label-shape heuristics for it rather than durably
   * asserting a negative for the common case where this metadata was never
   * sent at all.
   */
  private dmClassified = new Map<string, true>();

  /** The channel of the most recent incoming message that isn't a reaction,
   *  reaction removal, edit or deletion marker, apart from an edit the
   *  coalescer delivers on acceptance as the agent's first view: used for
   *  speech routing and the default publish. */
  private defaultPublishChannel: string | null = null;

  /** The same message's id and thread, used for buildChannelContext. */
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
  private desiredStates = new Map<string, {
    state: DesiredChannelState;
    source: string;
    /** Present iff state === 'tuned-out'. */
    tuneOut?: TuneOutParams;
    /** Durable wake count for the active tune-out epoch (replayed from
     *  'tune-out-wake' lifecycle records; see recordTuneOutWake). */
    wakeCount?: number;
  }>();

  /** One-time migration inputs from the retired recipe auto-open policy. */
  private legacyPolicies = new Map<string, 'auto' | 'manual' | string[]>();
  private migratedLegacyPolicies = new Set<string>();

  // Keep one transport operation in flight per logical channel, including
  // across descriptor replacement. Settled tails release themselves; a
  // failed operation must not poison later decisions.
  private channelLifecycleTails = new Map<string, Promise<void>>();
  // Bumped when a server's registrations are removed: an operation queued
  // before that is cancelled when it would run, rather than acting on a
  // closing connection or on a later re-registration's entries.
  private serverRemovals = new Map<string, number>();
  // Operations queued or running per channel that will still read its
  // target before confirming anything. Unlike the tail, which settles a few
  // microtasks after its operation's last check, this drops at that check.
  private lifecycleOutstanding = new Map<string, number>();
  // The removal count each channel's newest outstanding operation was queued
  // under. Where it's older than its server's, every operation still
  // outstanding for the channel cancels when it would run.
  private lifecycleQueuedRemovals = new Map<string, number>();
  // Losing an open receipt does not confirm closure. Keep that distinction
  // private while preserving the public open:boolean availability projection.
  private unconfirmedChannelTargets = new WeakSet<ChannelEntry>();
  // Entries ensureChannelRegistered made from a push, until a channels/changed
  // update gives one a target (handleChanged's retarget). A registration makes
  // a new entry, which isn't here. Kept by the host, not read from the
  // descriptor, whose metadata a server's own registration supplies.
  private untargetedPushEntries = new WeakSet<ChannelEntry>();

  private invalidateTransportConfirmation(entry: ChannelEntry): void {
    entry.open = false;
    this.unconfirmedChannelTargets.add(entry);
  }

  /** Whether the host directs this server's channel lifecycle (§14.1: its
   *  `channels.lifecycle` grant). Where it doesn't, the server opens and
   *  closes its own channels, and sends no receipt the host could wait for. */
  directsLifecycle(serverId: string): boolean {
    return CapabilityGrant.of(this.serverRegistry.getServer(serverId)).has('channels.lifecycle');
  }

  /** Whether a decided close holds words back from a channel: only where
   *  the host directs the server's lifecycle. Without that grant the host
   *  can't close the channel, and words go into a transport that is open,
   *  as the open step's engagesDecidedClosed reads it too. */
  private closeStands(entry: ChannelEntry): boolean {
    return this.getDesiredState(entry.serverId, entry.descriptor.id) === 'closed' &&
      this.directsLifecycle(entry.serverId);
  }

  /** Where this server stands for a request this host would make of it
   *  (ServerReach). One without a connection's state reads as connected.
   *  A closed connection the host is restarting reads as connecting, as
   *  one being connected does. */
  private serverReach(serverId: string): ServerReach {
    const server = this.serverRegistry.getServer(serverId);
    const connecting = this.serverConnecting?.(serverId) ?? false;
    if (!server) return connecting ? 'connecting' : 'gone';
    if (server.isConnected === false) return connecting ? 'connecting' : server.willReconnect ? 'down' : 'gone';
    return connecting ? 'connecting' : 'up';
  }

  /**
   * Why this host won't open or close this server's channels, for a caller
   * that found its grant without channels.lifecycle (§14.1), which decides:
   * the server's state says why. It isn't up, or it's up without that grant.
   * Neither the grant's name, which is the operator's, nor an empty grant's
   * refusal, which needn't be the server's, reaches the agent.
   */
  private lifecycleRefusal(serverId: string): ChannelLifecycleError {
    const reach = this.serverReach(serverId);
    if (reach !== 'up') return new ChannelLifecycleError(unreachableClause(serverId, reach), 'unreachable', reach);
    return new ChannelLifecycleError(`this host isn't permitted to open or close the "${serverId}" server's channels`, 'not-permitted');
  }

  /**
   * Why a send to this server's channels is refused before anything goes
   * out, as one clause with what works from there, for a caller that found
   * no server or a grant without channels.publish (§14.1), which decides:
   * the server's state says why. Plain speech gives it as its reason, and
   * channel_publish and speak_in_channel as theirs, so one refusal has one
   * wording. `checked` is the connection whose grant refused, where that
   * was read before the words waited: one the registry has replaced since
   * says nothing about the server that stands now.
   */
  private sendRefusal(serverId: string, checked?: McplServerConnection): string {
    const now = this.serverRegistry.getServer(serverId);
    const reach = this.serverReach(serverId);
    // A replacement that would take the words is worth another try; one
    // that wouldn't is worded as it stands.
    if (checked && now && now !== checked && reach === 'up' && CapabilityGrant.of(now).has('channels.publish')) {
      return `the "${serverId}" server's connection was replaced while these words waited, so try again`;
    }
    if (reach !== 'up') return unreachableClause(serverId, reach) + unreachableRemedy(reach);
    return `this host isn't permitted to post to the "${serverId}" server's channels, and trying again won't change that; ` +
      'if you need it, ask whoever runs this host';
  }

  /**
   * What a failed channel_open or channel_close tells the agent. Its
   * decision was recorded before the server was asked, and reconciling
   * applies it when the server next registers the channel (for a push's
   * placeholder, if it ever does), if this host directs their lifecycle then
   * (laterClause). A decision the log refused changed nothing, so that comes
   * first. A channel no longer registered
   * can't be reached by any channel tool, so its text names none. A later
   * decision that came first is what stands, so that comes next. Then the
   * server's state: one that isn't up gets the change when it's back, though
   * not a backscroll's history. For the request's own failure, its state is
   * read now, since a request out when the server dropped may have taken
   * effect, and reconciling settles it either way. A decision already in
   * effect, with no other work for the channel under way, says so, as one
   * whose backscroll alone failed is. Then the failure's kind, since each
   * has its own next step (ChannelLifecycleError). A request's own failure
   * is in the connection's words.
   */
  private lifecycleFailureText(
    action: 'open' | 'close',
    entry: ChannelEntry,
    err: unknown,
    opts?: { history?: boolean },
  ): string {
    const channel = `"${entry.descriptor.id}"`;
    const tool = action === 'open' ? 'channel_open' : 'channel_close';
    const done = action === 'open' ? 'opened' : 'closed';
    const later = laterClause(entry);
    // A decision never recorded is no decision a later one overtook, and
    // nothing about the channel changed, whatever its transport's state.
    if (err instanceof ChannelLifecycleError && err.kind === 'unrecorded') {
      return `Nothing changed for channel ${channel}: ${err.message}, so nothing was sent to the server. ` +
        `Calling ${tool} again tries again; if it fails the same way, ask whoever runs this host.`;
    }
    const failure = err instanceof ChannelLifecycleError ? err : undefined;
    const now = this.getDesiredState(entry.serverId, entry.descriptor.id);
    const current = this.channels.get(`${entry.serverId}:${entry.descriptor.id}`);
    if (!current) {
      // Its registration may have gone at the server's word or at this
      // host's (removeServer). Only a failure that says which (cancelled,
      // unlisted) names it; otherwise the server's state where it isn't up,
      // and a request's own words where it failed with them. Another
      // failure's words are about a request whose channel is gone.
      const reach = this.serverReach(entry.serverId);
      const why = failure?.kind === 'cancelled' || failure?.kind === 'unlisted' ? `: ${failure.message}`
        : reach !== 'up' ? `: ${unreachableClause(entry.serverId, reach)}` : '';
      // A tune-out is in effect already: only its transport waits for the
      // server's next registration.
      const stays = now === 'tuned-out' ? 'It was tuned out meanwhile, and that stays recorded.'
        : `Its ${now === 'closed' ? 'close' : 'open'} stays recorded, and happens ${later}.`;
      return `Channel ${channel} isn't registered here any more${why}. ${stays}` +
        (reach === 'gone' ? ' If you need the server back, ask whoever runs this host.' : '') +
        (failure === undefined ? ` ${withStop(lifecycleClause(err))}` : '');
    }
    // A tune-out sends the channel's messages to the subconscious, and
    // channel_open refuses a tuned-out channel.
    if (action === 'open' ? now !== 'open' : now !== 'closed') {
      if (action === 'open' && now === 'tuned-out') {
        return `Channel ${channel} was tuned out meanwhile: its messages go to the subconscious, and channel_open doesn't ` +
          `change that. Call tune_out with channelId ${channel} and mode "cancel" for it to resume normal attention.`;
      }
      // The later decision's own work settles the transport, and its call
      // says what became of it, so this says only that this call's change
      // doesn't stand.
      return `Channel ${channel}: ${supersededClause(action, now)}, so this ${action} doesn't stand. Call ${tool} again to ` +
        `${action} it.`;
    }
    const reach = failure ? (failure.kind === 'unreachable' ? failure.reach : undefined) : this.serverReach(entry.serverId);
    if (reach !== undefined && reach !== 'up') {
      // Reconciling opens a channel, but asks for no history.
      const history = action === 'open' && opts?.history;
      return `${sentenceStart(unreachableClause(entry.serverId, reach))}, so channel ${channel} may not be ` +
        `${action === 'open' ? 'open' : 'closed'} there yet. The ${action} is recorded and happens ${later}` +
        (history
          ? ', but the history you asked for doesn\'t come with it: calling channel_open with backscroll once the server is ' +
            'connected asks for it.'
          : `, so there's no need to call ${tool} again.`) +
        (reach === 'gone' ? ' If you need the server back, ask whoever runs this host.' : '') +
        (action === 'open' ? ' channel_close withdraws it.' : '');
    }
    const said = lifecycleClause(err);
    // Other work for the channel still under way (lifecycleOutstanding,
    // released as each operation's last look ends) may change its state.
    const settled = !this.lifecycleOutstanding.has(this.lifecycleKey(entry.serverId, entry.descriptor.id));
    // The registry's own reading, as its checks make it (channel_open's
    // already-open return, the decline's refusal, delivery): a request that
    // failed leaves the open flag as it was, and the unconfirmed mark counts
    // only while the channel isn't open (runLifecycleOperation).
    const inEffect = current !== undefined && settled && (action === 'open'
      ? current.open
      : !current.open && !this.unconfirmedChannelTargets.has(current));
    if (inEffect) {
      // What was asked already holds. Without the grant, nothing more can be
      // asked of the server, so calling again won't change anything.
      const state = `Channel ${channel} is ${action === 'open' ? 'open' : 'closed'}`;
      if (action === 'open' && opts?.history) {
        return failure?.kind === 'not-permitted'
          ? `${state}, but the history you asked for didn't come: ${failure.message}, so calling channel_open again ` +
            "won't change that. If you need it, ask whoever runs this host."
          : withStop(`${state}, but the history you asked for didn't come: ${said}`) +
            ' Calling channel_open again with backscroll tries once more.';
      }
      return failure?.kind === 'not-permitted'
        ? `${state}. ${sentenceStart(failure.message)}, so it sent the server nothing.`
        : withStop(`${state}, though this call didn't complete: ${said}`);
    }
    switch (failure?.kind) {
      case 'not-permitted':
        // The decision was recorded before the refusal, and reconciling
        // applies it at a registration whose grant allows it.
        return `${sentenceStart(failure.message)}, so this ${action} of channel ${channel} didn't go through, and calling ${tool} ` +
          `again won't change that. The ${action} stays recorded, and happens ${later}. If you need it, ask whoever runs this host.`;
      case 'cancelled':
      case 'unlisted':
        return `Channel ${channel} wasn't ${done}: ${failure.message}. The ${action} stays recorded, and happens ${later}.`;
      case 'converge':
        return `Channel ${channel} wasn't ${done}: ${failure.message}. The ${action} stays recorded, and calling ${tool} again ` +
          'tries once more.';
      case 'substituted':
        // Only an open is answered for another channel.
        return `Channel ${channel} wasn't ${done}: ${failure.message}. The ${action} stays recorded, and this host tries it ` +
          `again ${later}; calling ${tool} again is likely to get the same answer. channel_close withdraws it.`;
    }
    return `${action === 'open' ? 'Opening' : 'Closing'} channel ${channel} didn't complete; the ${action} stays recorded, and this ` +
      `host tries it again ${later}, or now if you call ${tool} again. ${withStop(said)}`;
  }

  /** A registration's entry, or a push's (ensureChannelRegistered): nothing
   *  about its transport is known until a receipt for its target confirms it
   *  open or closed, or the channel's traffic shows it open, which it does
   *  where the host doesn't direct the lifecycle, and for a push's entry
   *  decided open or tuned out that no update has given a target
   *  (handleIncoming). */
  private registerEntry(key: string, serverId: string, descriptor: ChannelDescriptor): ChannelEntry {
    const entry: ChannelEntry = { serverId, descriptor, open: false };
    this.channels.set(key, entry);
    this.unconfirmedChannelTargets.add(entry);
    return entry;
  }

  private hasPendingLifecycle(entry: ChannelEntry): boolean {
    return this.channelLifecycleTails.has(this.lifecycleKey(entry.serverId, entry.descriptor.id));
  }
  private handleCoalescedIncoming?: ChannelRegistryOptions['handleCoalescedIncoming'];
  private acceptInbound?: ChannelRegistryOptions['acceptInbound'];
  private channelTools: ToolDefinition[];

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
    this.handleCoalescedIncoming = options?.handleCoalescedIncoming;
    this.acceptInbound = options?.acceptInbound;
    this.channelTools = CHANNEL_TOOL_DEFINITIONS.map((tool) => {
      if (tool.name !== 'skip_reply' || options?.eventGatePresent === true) return tool;
      const schema = tool.inputSchema as {
        type: 'object';
        properties: NonNullable<ToolDefinition['inputSchema']['properties']>;
        required?: string[];
      };
      const { wake_in_seconds: _wake, ...properties } = schema.properties;
      return {
        ...tool,
        description: tool.description.replace(
          ' To end this turn but come back on your own shortly, set wake_in_seconds.',
          '',
        ),
        inputSchema: { ...schema, properties },
      };
    });
    this.serverRegistry = serverRegistry;
    this.featureSetManager = featureSetManager;
    this.pushEventFn = pushEventFn;
    this.emitTraceFn = emitTraceFn;
    this.sendTypingFn = options?.sendTypingFn;
    this.shouldTriggerInference = options?.shouldTriggerInference;
    this.onRouteFailure = options?.onRouteFailure;
    this.onChannelAutoOpened = options?.onChannelAutoOpened;
    this.homeChannelResolver = options?.homeChannelResolver;
    this.activeChannelResolver = options?.activeChannelResolver;
    this.takesGlobalFallback = options?.takesGlobalFallback;
    this.serverConnecting = options?.serverConnecting;
    this.store = options?.store;
    this.initializeLifecycleStore();
    this.initializeLabelHistoryStore();
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
    // §14.5: per-descriptor authorization with ITEMIZED results — one entry
    // per submitted descriptor. Strict 0.5 servers treat a result without
    // `results` (or a descriptor missing from it) as rejected, so the shape
    // is interop-critical, not decorative. Rejection here is per-descriptor
    // validation; the method-level channels.register gate already ran at the
    // connection (§14.1).
    const results: ChannelsRegisterResult['results'] = [];

    for (const channel of params.channels) {
      if (!channel || typeof channel.id !== 'string' || channel.id.length === 0) {
        results.push({ id: String(channel?.id ?? ''), accepted: false, reason: 'invalid descriptor: missing id' });
        continue;
      }
      const key = `${serverId}:${channel.id}`;
      this.registerEntry(key, serverId, channel);
      this.appendLabelSighting(channel.id, channel.label, extractDmMeta(channel.metadata));
      registeredIds.push(channel.id);
      results.push({ id: channel.id, accepted: true });
    }

    // Respond before reconciliation — the server blocks on this response and
    // can't process channels/open until it arrives.
    const result: ChannelsRegisterResult = { registered: registeredIds, results };
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
    responder?: Responder,
  ): Promise<void> {
    // §14.5: dual-mode. Request form answers ITEMIZED per-descriptor
    // results for added channels; Notification form filters itemwise with a
    // diagnostic. Either way, added descriptors are validated exactly like
    // channels/register — a changed-set cannot smuggle in what register
    // would have rejected (PR #79 review blocker 5).
    const addedResults: Array<{ id: string; accepted: boolean; reason?: string }> = [];
    const retargeted: ChannelDescriptor[] = [];
    // Process removed channels — itemized truthfully: removal of a channel
    // we never had is reported, not silently accepted.
    if (params.removed) {
      for (const channelId of params.removed) {
        const key = `${serverId}:${channelId}`;
        const existed = this.channels.delete(key);
        this.stopTyping(channelId);
        addedResults.push({ id: channelId, accepted: existed, reason: existed ? undefined : 'not registered' });
      }
    }

    // Process updated channels — validated itemwise exactly like added
    // (§14.5: a changed-set cannot smuggle in what register would reject),
    // and every submitted descriptor gets a verdict: a strict server reads
    // absence from `results` as rejection.
    if (params.updated) {
      for (const channel of params.updated) {
        if (!channel || typeof channel.id !== 'string' || channel.id.length === 0) {
          addedResults.push({ id: String(channel?.id ?? ''), accepted: false, reason: 'invalid descriptor: missing id' });
          this.emitTraceFn({ type: 'mcpl:channel-descriptor-rejected', serverId, reason: 'missing id (update)' });
          continue;
        }
        const key = `${serverId}:${channel.id}`;
        const existing = this.channels.get(key);
        if (!existing) {
          addedResults.push({ id: channel.id, accepted: false, reason: 'not registered — update rejected (§14.5)' });
          this.emitTraceFn({ type: 'mcpl:channel-descriptor-rejected', serverId, channelId: channel.id, reason: 'update for unregistered channel' });
          continue;
        }
        // A live subscription to the old target does not confirm the new
        // type/address. Label-only updates preserve that confirmation. A
        // channel decided open (or tuned out) is opened at its new target.
        if (!sameChannelTarget(existing.descriptor, channel)) {
          this.invalidateTransportConfirmation(existing);
          this.untargetedPushEntries.delete(existing);
          // An operation queued or running for this channel reads its target
          // again before it confirms anything, and after a failed RPC, so it
          // opens the new one, unless it was queued before its server's
          // registrations were last removed: that one cancels when it would
          // run. So a channel decided open (or tuned out) is reconciled here
          // unless work queued since then is outstanding.
          const desired = this.getDesiredState(serverId, channel.id);
          if ((desired === 'open' || desired === 'tuned-out') &&
              !this.outstandingWorkCarriesOut(serverId, this.lifecycleKey(serverId, channel.id))) {
            retargeted.push(channel);
          }
        }
        existing.descriptor = channel;
        this.appendLabelSighting(channel.id, channel.label, extractDmMeta(channel.metadata));
        addedResults.push({ id: channel.id, accepted: true });
      }
    }

    // Process added channels (validate per-descriptor, register; reconcile
    // after responding, below)
    const accepted: typeof params.added = [];
    if (params.added) {
      for (const channel of params.added) {
        if (!channel || typeof channel.id !== 'string' || channel.id.length === 0) {
          addedResults.push({ id: String(channel?.id ?? ''), accepted: false, reason: 'invalid descriptor: missing id' });
          this.emitTraceFn({ type: 'mcpl:channel-descriptor-rejected', serverId, reason: 'missing id' });
          continue;
        }
        const key = `${serverId}:${channel.id}`;
        this.registerEntry(key, serverId, channel);
        this.appendLabelSighting(channel.id, channel.label, extractDmMeta(channel.metadata));
        addedResults.push({ id: channel.id, accepted: true });
        accepted.push(channel);
      }
    }

    // Respond before reconciliation, as handleRegister does. A server that
    // announces from inside a request it is serving (a tool that refreshes
    // or subscribes) cannot read the channels/open or channels/close that
    // reconciling sends until this response arrives; reconciling first
    // deadlocks both sides until one times out (#160). The verdicts are
    // settled above, so nothing in the response depends on reconciling.
    responder?.respond({ results: addedResults });

    const reconcile = [...accepted, ...retargeted];
    if (reconcile.length > 0) await this.reconcileChannels(serverId, reconcile);

    this.emitTraceFn({
      type: 'mcpl:channels-changed',
      serverId,
      added: params.added?.map((c) => c.id) ?? [],
      removed: params.removed ?? [],
      updated: params.updated?.map((c) => c.id) ?? [],
    });
  }

  /**
   * A coalesced message the host refused. Until now the host said nothing, so
   * a dropped message (agent-framework#266: every Discord message with a
   * screenshot) left no trace where operators look. The sender gets the
   * per-message result this lane gives: `coalesce_invalid` for a malformed
   * item, or the thrown error's message for anything else. `answered` is the
   * code that result stands for (-32602 for `coalesce_invalid`), and the
   * reason follows it (coalesceRejectionReason): `coalesce-failed` when the
   * host itself failed, `coalesce-invalid` when the sender's item was
   * refused, with the failing `field` and the error's message as `detail`.
   * The line prints the ids the sender sent, whatever their type; the trace
   * carries them when they are strings.
   */
  private traceCoalesceRejection(
    serverId: string,
    message: { channelId?: unknown; messageId?: unknown } | null | undefined,
    error: { field?: unknown; message: string },
    answered: number,
  ): void {
    const reason = coalesceRejectionReason(answered);
    const field = typeof error.field === 'string' && error.field ? error.field : undefined;
    const channelId = typeof message?.channelId === 'string' ? message.channelId : '';
    const messageId = typeof message?.messageId === 'string' && message.messageId ? message.messageId : undefined;
    console.error(
      `[channel-incoming-rejected] server=${serverId} channel=${logValue(message?.channelId ?? '')} ` +
      `messageId=${logValue(message?.messageId ?? '')} ` +
      `reason=${reason}${field ? ` field=${logValue(field)}` : ''}: ${logDetail(error.message)}`,
    );
    this.emitTraceFn({
      type: 'mcpl:channel-incoming-rejected',
      serverId,
      channelId,
      ...(messageId ? { messageId } : {}),
      reason,
      ...(field ? { field } : {}),
      detail: error.message,
    });
  }

  /**
   * Handle `channels/incoming` from a server.
   *
   * Converts each message's content, pushes McplChannelIncomingEvent to the
   * queue, and responds with per-message results.
   */
  async handleIncoming(
    serverId: string,
    params: ChannelsIncomingParams,
    responder?: Responder,
  ): Promise<void> {
    const results: ChannelIncomingMessageResult[] = [];

    for (const message of params.messages) {
      if (!message || typeof message.channelId !== 'string' || !message.channelId
        || typeof message.messageId !== 'string' || !message.messageId) {
        // The same gate as admission below: with no coalescer wired, a
        // message carrying `coalesce` is handled uncoalesced, and refused as
        // any uncoalesced message without an identity is.
        const coalescedItem = message?.coalesce !== undefined && !!this.handleCoalescedIncoming;
        if (coalescedItem) {
          this.traceCoalesceRejection(serverId, message, {
            field: typeof message.channelId !== 'string' || !message.channelId ? 'channelId' : 'messageId',
            message: 'a coalesced message needs a channelId and a messageId',
          }, -32602);
        }
        results.push({
          messageId: typeof message?.messageId === 'string' ? message.messageId : '',
          accepted: false,
          reason: coalescedItem ? 'coalesce_invalid' : 'invalid channel/message identity',
        });
        continue;
      }
      // §14.5 FIRST, before ANY semantic processing: admission against the
      // actually-registered channel precedes tag expansion and content
      // conversion — decoding an unregistered sender's payload (including
      // inline base64) is allocation and parsing work done for a message
      // that must be rejected (Sol, PR #79 re-review blocker 2).

      // §14.5: channels/incoming is validated against the ACTUALLY
      // REGISTERED channel. An unknown claimed channelId is rejected
      // per-message with an itemized result — never minted by its first
      // message (PR #79 review blocker 5: lazy-registration let a server
      // self-attest a channel identity without ever passing
      // channels/register authorization). A server whose channel genuinely
      // exists registers it first; discord's DM case goes through
      // ensureChannelRegistered on push/event, which creates a routable
      // entry that isn't open, rather than an open self-attested one.
      const incomingKey = `${serverId}:${message.channelId}`;
      if (!this.channels.has(incomingKey)) {
        // Loud, coalesced or not, like every other refusal of a message, but
        // at most once a minute per channel (RefusalLines): a server that
        // never registered a busy channel would otherwise print a line for
        // every message in it. Every refusal is traced.
        const held = this.unknownChannelLines.admit(serverId, message.channelId);
        if (held !== null) {
          console.error(
            `[channel-incoming-rejected] server=${serverId} channel=${logValue(message.channelId)} ` +
            `messageId=${logValue(message.messageId)} reason=unknown-channel ` +
            `(not registered, §14.5${held ? `; ${held} more since the last line` : ''})`,
          );
        }
        this.emitTraceFn({
          type: 'mcpl:channel-incoming-rejected',
          serverId,
          channelId: message.channelId,
          messageId: message.messageId,
          reason: 'unknown-channel',
        });
        results.push({
          messageId: message.messageId,
          accepted: false,
          reason: `unknown channel "${message.channelId}" — register it first (§14.5)`,
        });
        continue;
      }

      // ACCEPTED from here down: semantic processing only for admitted
      // messages. §16.3 core-tag closure, then content conversion.
      const coalesced = message.coalesce !== undefined && !!this.handleCoalescedIncoming;
      // Only a coalescing retraction may be empty (pure withdrawal, RFC-006
      // §6; the coalescer appends nothing for it). Any other message that
      // shows the model nothing would wake it with no visible cause.
      const emptyAllowed = coalesced && (message.coalesce as { retract?: unknown } | null)?.retract === true;
      const rejectEmpty = () => {
        console.error(`[channel-incoming-rejected] server=${serverId} channel=${logValue(message.channelId)} messageId=${logValue(message.messageId)} reason=empty-content`);
        this.emitTraceFn({
          type: 'mcpl:channel-incoming-rejected',
          serverId,
          channelId: message.channelId,
          messageId: message.messageId,
          reason: 'empty-content',
        });
        results.push({ messageId: message.messageId, accepted: false, reason: 'empty_content' });
      };
      if (coalesced) {
        // RFC-006 §13: malformed content on a coalesced item is that item's
        // failure, not the batch's — check the shape before converting.
        try {
          validateCoalescedContent(message.content, { allowEmpty: emptyAllowed });
        } catch (error) {
          if (error instanceof EmptyContentError) rejectEmpty();
          else {
            // Answered coalesce_invalid whatever the error's code: -32602.
            this.traceCoalesceRejection(serverId, message, error as Error & { field?: string }, -32602);
            results.push({ messageId: message.messageId, accepted: false, reason: 'coalesce_invalid' });
          }
          continue;
        }
      }
      if (message.tags) message.tags = expandCoreTags(message.tags);
      const convertedContent: ContentBlock[] = message.content.map((block) => convertBlock(block, 'attachment on channel message', serverId));
      if (!emptyAllowed && isVisiblyEmptyConversion(message.content, convertedContent)) {
        rejectEmpty();
        continue;
      }

      // Track default publish channel (most recent ACCEPTED incoming) —
      // deliberately after §14.5 validation: a rejected message from an
      // unregistered channel must not retarget outbound speech (the locus is
      // exactly the authority a self-attested channel would be stealing).
      // A coalesced item is "accepted" only once the coalescer admits it, so
      // for those this runs after the hook (below).
      const incomingEntry = this.channels.get(incomingKey)!;
      const markAccepted = (firstView = false) => {
        // Non-conversational markers (a reaction added or removed, an edit, a
        // deletion) are ABOUT a message, not one the agent replies to: they
        // must not retarget the default publish locus or become
        // `context.incoming`'s reply anchor. An edit the coalescer delivered
        // as the agent's first view counts as the message it replaced.
        if (!isMarkerTagged(message.tags, firstView)) {
          this.defaultPublishChannel = message.channelId;
          this.defaultPublishMessageId = message.messageId;
          this.defaultPublishThreadId = message.threadId;
        }
        // Where the host directs this server's lifecycle, traffic shows the
        // transport open only for a channel still decided open or tuned out,
        // and, but for one exception, only for a confirmed target: after a
        // retarget, traffic for this id may still come from the old
        // subscription, and a close receipt that landed first (or during the
        // coalescer's await) stands. The exception is an entry made from a
        // push that no update has given a target (untargetedPushEntries):
        // there's no earlier target its traffic could come from, so for the
        // receipt rule's own reason its traffic shows the transport open. It
        // stops being one when a registration replaces it (registerEntry) or
        // a channels/changed update gives it a target (handleChanged's
        // retarget), and the receipt rule holds from then. Where the host
        // doesn't direct the lifecycle, the server opens its own channels and
        // its traffic is the only evidence the host gets, so it marks the
        // channel open, as it always has. The entry is the one the message
        // was accepted for: one a re-registration put in its place meanwhile
        // waits for its own evidence. Durable desired state still changes
        // exclusively through lifecycle operations. A marker is evidence like
        // any other message.
        if (this.directsLifecycle(serverId)) {
          if (this.unconfirmedChannelTargets.has(incomingEntry) && !this.untargetedPushEntries.has(incomingEntry)) return;
          const desired = this.getDesiredState(serverId, message.channelId);
          if (desired !== 'open' && desired !== 'tuned-out') return;
        }
        this.unconfirmedChannelTargets.delete(incomingEntry);
        incomingEntry.open = true;
      };
      if (!coalesced) markAccepted();

      // Determine whether to trigger inference
      let triggerInference = true;
      if (this.shouldTriggerInference) {
        // The text the agent's context gets, as the push lane's filter reads
        // it: the converted text blocks, a placeholder or reference stub
        // among them, NON_STRING_TEXT_PLACEHOLDER included.
        const textContent = convertedContent
          .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
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
        acceptedAt: Date.now(),
      };

      if (coalesced) {
        // RFC-006 §14.3: a coalesced message is admitted like any other and
        // then handed, with the event the ordinary path would have queued, to
        // the coalescer, which replaces, appends or withdraws. Malformed
        // `coalesce` is a per-message failure; siblings are unaffected.
        try {
          const { firstView, ...result } = await this.handleCoalescedIncoming!(serverId, message, event);
          if (result.accepted) markAccepted(firstView === true);
          results.push(result);
        } catch (error) {
          const err = error as Error & { code?: number; field?: string };
          // -32602 is answered coalesce_invalid; anything else as its message,
          // a plain Error standing for an internal error (-32603).
          this.traceCoalesceRejection(serverId, message, err, typeof err.code === 'number' ? err.code : -32603);
          results.push({
            messageId: message.messageId,
            accepted: false,
            reason: err.code === -32602 ? 'coalesce_invalid' : err.message,
          });
        }
        continue;
      }

      // The source envelope is frozen here, at admission, before the message
      // is queued or acknowledged: a rename or rebind while it waits in the
      // queue cannot change where it says it came from.
      const inboundSource = this.acceptInbound?.(event);
      if (inboundSource) event.inboundSource = inboundSource;

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
   * For channels that only ever arrive as push/events rather than
   * channels/incoming — the motivating case is Discord DMs, which
   * discord-mcpl forwards via push/event with the channel closed
   * (`channelIsOpen:false`). Such a channel is never registered, so
   * routeSpeech() can't resolve it and the agent's reply is silently dropped
   * even though the inbound message proves the channel is reachable (item-3
   * redux, DM sub-case). Its entry starts with its transport unknown, as a
   * registration's does. Its traffic shows it open, for a channel decided
   * open or tuned out, until an update gives it a target (handleIncoming).
   * Idempotent: a later authoritative channels/register or channels/changed
   * overwrites this descriptor with the richer one.
   */
  ensureChannelRegistered(
    serverId: string,
    channelId: string,
    label?: string,
    extraMetadata?: Record<string, unknown>,
  ): void {
    const existing = this.findChannelEntry(channelId);
    if (existing) {
      // Backfill identity onto a bare lazy registration: a DM that first
      // arrived with no label/recipient info gets a usable name the next
      // time a message reveals it (labels must show people, not ids).
      if (
        pushPlaceholder(existing) &&
        label && existing.descriptor.label === channelId
      ) {
        const metadata = extraMetadata
          ? { ...existing.descriptor.metadata, ...extraMetadata }
          : existing.descriptor.metadata;
        // The channel now has a real label, not just the bare id — durable.
        // Recorded before the live descriptor takes it, since this branch's
        // guard reads the descriptor: an append that throws leaves the
        // placeholder, so the next push tries again.
        this.appendLabelSighting(existing.descriptor.id, label, extractDmMeta(metadata));
        existing.descriptor.label = label;
        existing.descriptor.metadata = metadata;
      }
      return;
    }

    // Only persist a REAL label durably. Falling back to the bare
    // channelId as a placeholder (no server-supplied label at all — e.g. a
    // Discord DM push missing both channelName and an author name,
    // framework.ts's derivePushEventChannel) must never overwrite a real
    // label already on file from a previous boot: after a restart the live
    // `channels` map starts empty, so THIS is the very branch a
    // label-less post-restart event takes — recording the placeholder here
    // would clobber the good label initializeLabelHistoryStore() just
    // replayed, defeating the entire point of the durable log. The live
    // descriptor below still carries the placeholder for in-process
    // routing; only the durable write is skipped when there's no real
    // label to record. A real label is recorded before the entry exists:
    // an append that throws registers nothing, so the next push tries again.
    if (label) this.appendLabelSighting(channelId, label, extractDmMeta(extraMetadata));
    // Its transport is as unknown as a registration's (registerEntry). After
    // a restart, a push for a channel no registration has comes here, and
    // the server may still hold a channel an earlier process opened. Counting
    // it confirmed closed would answer a close or a decline as already done
    // and send nothing, even where the server still delivers.
    const entry = this.registerEntry(`${serverId}:${channelId}`, serverId, {
      id: channelId,
      type: serverId,
      label: label ?? channelId,
      direction: 'bidirectional',
      metadata: { lazyRegistered: true, ...(extraMetadata ?? {}) },
    });
    this.untargetedPushEntries.add(entry);
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
   * Get the default publish channel ID: the channel of the most recent
   * incoming message that isn't a reaction, reaction removal, edit or
   * deletion marker, apart from an edit the coalescer delivers on acceptance
   * as the agent's first view.
   */
  getDefaultPublishChannel(): string | null {
    return this.defaultPublishChannel;
  }

  /**
   * Get the descriptor for a channel by its channelId (first match across
   * servers). Used by the conversation router for DM classification.
   */
  /**
   * RFC-006 §3.2: is `channelId` registered BY `serverId` through a server
   * declaration (channels/register, channels/changed) or an authorized open?
   * A placeholder minted from a push's `origin` (ensureChannelRegistered)
   * does not count: a channel id appearing in an untrusted field is not a
   * registration.
   */
  isDeclaredChannel(serverId: string, channelId: string): boolean {
    const entry = this.channels.get(`${serverId}:${channelId}`);
    return !!entry && !pushPlaceholder(entry);
  }

  getDescriptor(channelId: string): ChannelDescriptor | undefined {
    return this.findChannelEntry(channelId)?.descriptor;
  }

  /** The registered label of `channelId` on exactly `serverId` (no
   *  cross-server first match), or undefined when it has none. */
  getChannelLabel(serverId: string, channelId: string): string | undefined {
    const label = this.channels.get(`${serverId}:${channelId}`)?.descriptor.label;
    return typeof label === 'string' && label.length > 0 ? label : undefined;
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
    return this.channelTools;
  }

  /**
   * Handle a call to one of the synthesized channel tools.
   *
   * `origin` is TRUSTED DISPATCH CONTEXT, supplied by the framework's own
   * routing (dispatchChannelToolCall and the public executeToolCall for
   * model-origin calls, the framework's private ModuleRegistry closure for
   * module ctx.callTool) — never derived from tool input. Machine
   * provenance on channel_close is honored only for module origin; a
   * model-origin call carrying the same fields is recorded as the agent
   * decision it actually is. Absent origin is treated as agent-origin (the
   * untrusted-safe default).
   */
  async handleChannelToolCall(
    toolName: string,
    input: unknown,
    origin?: ChannelToolOrigin,
  ): Promise<ToolResult> {
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
        return this.handleToolClose(
          input as {
            channelId: string;
            serverId?: string;
            source?: string;
            overrideExplicitOpen?: boolean;
          },
          origin,
        );

      case 'channel_decline':
        return this.handleToolDecline(input as {
          channelId: string;
          serverId?: string;
          messageId: string;
          acknowledge?: string;
        });

      case 'channel_publish':
        return this.handleToolPublish(input as { channelId: string; content: string }, origin);

      case 'think':
        return this.handleToolThink(input as { content?: string });

      case 'journal':
        return this.handleToolJournal(input as { content?: string });

      case 'skip_reply':
        return this.handleToolSkipReply(input as { reason?: string; wake_in_seconds?: unknown });

      default:
        // Not every agent is given every channel tool, so the refusal points
        // to the ones this agent has rather than listing them all.
        return {
          success: false,
          error: `There's no channel tool "${toolName}", so nothing ran. Use one of the channel tools you were given.`,
          isError: true,
        };
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
    // told the channel its speech will actually land in (none, when its server
    // declared it inbound-only, since speech isn't posted there): a conversation
    // fork's home channel, else this turn's channel (single trunk agent — item-3
    // redux: its locus, else its triggering channel), else the global default
    // (heartbeats). Without this, a fork
    // was advertised the global locus but published somewhere else; and a trunk
    // agent was told the wrong channel under concurrency.
    // Each lookup is keyed on whether a name was given, not its truthiness:
    // '' is a name an ephemeral run can have, and resolveLocus reads it too.
    const home = agentName !== undefined ? this.homeChannelResolver?.(agentName) : undefined;
    const active = agentName !== undefined ? this.activeChannelResolver?.(agentName) : undefined;
    // An ephemeral run takes no global fallback (takesGlobalFallback): neither
    // the latest inbound message's channel as its outgoing one, nor that
    // message as the one it is replying to.
    const fallback = agentName !== undefined ? this.globalFallbackFor(agentName) : this.defaultPublishChannel;
    const outgoing = home ?? active ?? fallback;

    if (openChannels.length === 0 && !outgoing) {
      return undefined;
    }

    const context: ChannelContext = {};

    // Incoming: the most recent inbound message that isn't a reaction,
    // reaction removal, edit or deletion marker, apart from an edit the
    // coalescer delivers on acceptance as the agent's first view (what the
    // agent is replying to).
    // Left process-global — per-channel inbound tracking (the right messageId for
    // a fork's own channel) is a separate concern from the outbound routing fix.
    if (fallback && this.defaultPublishMessageId) {
      context.incoming = {
        channelId: fallback,
        messageId: this.defaultPublishMessageId,
        threadId: this.defaultPublishThreadId,
      };
    }

    // Default outgoing: the resolved outbound locus (home channel for forks),
    // unless its server declared it inbound-only: routeSpeech publishes nothing
    // there, so it isn't where the agent's speech goes.
    if (outgoing && !this.inboundOnlyServer(outgoing)) {
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
    // Every lifecycle operation queued for this server is cancelled when it
    // would run (a ChannelLifecycleError of kind `cancelled`), so none acts on a closing
    // connection or on a later re-registration's entries.
    this.serverRemovals.set(serverId, (this.serverRemovals.get(serverId) ?? 0) + 1);
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

    ensureStateRegistered(this.store, { id: CHANNEL_LIFECYCLE_LOG_ID, strategy: 'append_log' });

    const raw = this.store.getStateJson(CHANNEL_LIFECYCLE_LOG_ID);
    if (!Array.isArray(raw)) return;

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const event = item as Partial<ChannelLifecycleEvent>;
      if (typeof event.serverId !== 'string') continue;
      if (
        event.kind === 'desired-state' &&
        typeof event.channelId === 'string' &&
        (event.desired === 'open' || event.desired === 'closed' ||
          (event.desired === 'tuned-out' && event.tuneOut))
      ) {
        this.desiredStates.set(
          this.lifecycleKey(event.serverId, event.channelId),
          {
            state: event.desired,
            source: typeof event.source === "string" ? event.source : "unknown",
            tuneOut: event.desired === 'tuned-out' ? event.tuneOut : undefined,
            wakeCount: 0,
          },
        );
      } else if (
        event.kind === 'tune-out-wake' &&
        typeof event.channelId === 'string' &&
        typeof event.wakeCount === 'number'
      ) {
        // Fold durable wake counts into the projection — but only while the
        // epoch that recorded them is still the active desired state
        // (last-record-wins semantics, same as desired-state itself).
        const key = this.lifecycleKey(event.serverId, event.channelId);
        const current = this.desiredStates.get(key);
        if (current?.state === 'tuned-out' && current.tuneOut?.epochId === event.epochId) {
          current.wakeCount = event.wakeCount;
        }
      } else if (event.kind === 'legacy-policy-migrated') {
        this.migratedLegacyPolicies.add(event.serverId);
      }
    }
  }

  /**
   * Each writer appends its record here before it changes memory for it, so
   * an append that throws, as on a full disk, fails the operation with that
   * change unmade, and memory and the log still agree. A record that changes
   * no memory, as a decline's of the invitation it declined, is its
   * caller's to handle (handleToolDecline). A retry then records
   * the change rather than finding it in memory already, where
   * setDesiredState's same-state return would record nothing, and a restart
   * replays what memory held. appendLabelSighting keeps the same order for
   * the label history.
   */
  private appendLifecycleEvent(event: ChannelLifecycleEvent): void {
    this.store?.appendToStateJson(CHANNEL_LIFECYCLE_LOG_ID, event);
  }

  // ==========================================================================
  // Private: Durable channel-label history (disconnected-channel resolution)
  // ==========================================================================

  /**
   * Replay `CHANNEL_LABEL_HISTORY_LOG_ID` into `labelHistory`. Same
   * construction-time timing as `initializeLifecycleStore()`, and the same
   * register-if-missing / swallow-"already exists" pattern. The log is
   * chronological, so folding forward and letting each record overwrite the
   * map entry for its channelId naturally keeps only the latest sighting.
   */
  private initializeLabelHistoryStore(): void {
    if (!this.store) return;

    ensureStateRegistered(this.store, { id: CHANNEL_LABEL_HISTORY_LOG_ID, strategy: 'append_log' });

    const raw = this.store.getStateJson(CHANNEL_LABEL_HISTORY_LOG_ID);
    if (!Array.isArray(raw)) return;

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const event = item as Partial<ChannelLabelSightingEvent>;
      if (typeof event.channelId !== 'string' || typeof event.label !== 'string' || !event.label) continue;
      this.labelHistory.set(event.channelId, event.label);
      let seen = this.allLabelsSeen.get(event.channelId);
      if (!seen) {
        seen = new Set();
        this.allLabelsSeen.set(event.channelId, seen);
      }
      seen.add(event.label);
      if (typeof event.recipientId === 'string' && event.recipientId) {
        this.dmRecipientIds.set(event.channelId, event.recipientId);
      }
      if (typeof event.recipientName === 'string' && event.recipientName) {
        this.dmRecipientNames.set(event.channelId, event.recipientName);
      }
      if (event.isDm === true) {
        this.dmClassified.set(event.channelId, true);
      }
    }
  }

  /**
   * Record that `channelId` was most recently seen with `label` (and,
   * optionally, DM identity/classification fields). Called from every
   * place a `ChannelDescriptor` is set into the live `channels` map
   * (`handleRegister`, `handleChanged`'s update/add branches,
   * `ensureChannelRegistered`) so the label survives disconnect and restart
   * for `resolveLabelFromHistory()` / `resolveProseTargetDurable()`.
   *
   * Guarded like `setDesiredState()`: a reconnect or re-registration that
   * reports the same label AND the same dmMeta fields as last time is a
   * no-op, so the append log doesn't grow without bound on every
   * boot/resubscribe — but a later call that newly supplies (or changes)
   * any dmMeta field for an already-known label (label unchanged) still
   * records, since that's genuinely new durable information, not a no-op
   * resighting. `isDm` only ever compares against a possible narrowing:
   * once durably `true`, a later sighting without `channelType==='dm'`
   * metadata (i.e. `dmMeta.isDm === undefined`, NOT `false` — see
   * `extractDmMeta`) is simply silent on the question, not a "no longer a
   * DM" downgrade, so it never counts as a change on its own.
   *
   * `label` is `string | undefined` (not just `string`) even though
   * `ChannelDescriptor.label` is typed `string`: that typing is a
   * compile-time-only assertion over untrusted wire data from an MCPL
   * server, and only `channel.id` is runtime-validated on the way in
   * (`handleRegister`/`handleChanged`). A missing/undefined label is
   * dropped rather than recorded — durable garbage here would later throw
   * inside `resolveLabelFromHistory()`'s normalization, which every
   * `HistoryModule` tool call passes through unguarded via
   * `resolveProseTargetDurable()`.
   */
  private appendLabelSighting(
    channelId: string,
    label: string | undefined,
    dmMeta: { recipientId?: string; recipientName?: string; isDm?: boolean } = {},
  ): void {
    if (typeof label !== 'string' || !label) return;
    const { recipientId, recipientName, isDm } = dmMeta;
    // Never let a bare-id placeholder (ensureChannelRegistered's fallback
    // `label ?? channelId` when no real label was ever supplied — e.g. a
    // Discord DM push missing both channelName and an author name) durably
    // overwrite a real label already on file. This is exactly the restart
    // scenario the durable log exists to survive: the live `channels` map
    // is empty after a restart, so the next label-less event would
    // otherwise take the "first sighting" path and clobber a good label
    // the replay above just restored. (Belt-and-braces alongside
    // ensureChannelRegistered's own guard, which should stop this before
    // it ever gets here — see there for the primary fix.)
    if (label === channelId && this.labelHistory.has(channelId)) return;
    const labelUnchanged = this.labelHistory.get(channelId) === label;
    const recipientIdUnchanged = recipientId === undefined || recipientId === this.dmRecipientIds.get(channelId);
    const recipientNameUnchanged = recipientName === undefined || recipientName === this.dmRecipientNames.get(channelId);
    const isDmUnchanged = isDm === undefined || this.dmClassified.get(channelId) === true;
    if (labelUnchanged && recipientIdUnchanged && recipientNameUnchanged && isDmUnchanged) return;
    // The log first, as for lifecycle events: an append that throws leaves
    // the history in memory as it was, so the next sighting records it.
    this.store?.appendToStateJson(CHANNEL_LABEL_HISTORY_LOG_ID, {
      channelId,
      label,
      ts: Date.now(),
      ...(recipientId ? { recipientId } : {}),
      ...(recipientName ? { recipientName } : {}),
      ...(isDm ? { isDm } : {}),
    } satisfies ChannelLabelSightingEvent);
    this.labelHistory.set(channelId, label);
    let seen = this.allLabelsSeen.get(channelId);
    if (!seen) {
      seen = new Set();
      this.allLabelsSeen.set(channelId, seen);
    }
    seen.add(label);
    if (recipientId) this.dmRecipientIds.set(channelId, recipientId);
    if (recipientName) this.dmRecipientNames.set(channelId, recipientName);
    if (isDm) this.dmClassified.set(channelId, true);
  }

  /**
   * Look up a label spec against label *history* rather than the live
   * `channels` map — the fallback path for a channel the bot isn't
   * currently connected to. Applies the same normalization
   * `resolveProseTarget()` uses for its live label/name matches
   * (`normalizeChannelLabel` / `normalizeChannelLabelName`), plus a raw-id
   * fast path (mirroring `resolveProseTarget()`'s own raw-id acceptance).
   *
   * Matches against `allLabelsSeen` — EVERY label a channel has ever had —
   * not just its current/latest one in `labelHistory`, so a channel renamed
   * A -> B -> A is still resolvable by a name from BEFORE the most recent
   * rename (the point of a history-browsing tool is finding things by what
   * they used to be called). Ambiguity is genuine here: if the same
   * normalized spec matches historical labels belonging to two DIFFERENT
   * channelIds (an actual rename collision, not just the same channel seen
   * twice), that's a real ambiguity, not a false positive from re-scanning
   * one channel's own label list — `byLabel`/`byName` tracking below
   * already only flags ambiguous when the matched channelId itself differs.
   *
   * Returns undefined — rather than raising an ambiguity error — when a
   * normalized spec matches more than one distinct channelId in history;
   * callers fall back to `resolveProseTarget()`'s original error in that
   * case via `resolveProseTargetDurable()`.
   */
  private resolveLabelFromHistory(spec: string): string | undefined {
    const trimmed = spec.trim();
    if (!trimmed) return undefined;

    // Fast path: spec is already a channelId we have label history for.
    if (this.labelHistory.has(trimmed)) return trimmed;

    // DM-aware arm, mirroring resolveProseTarget()'s own `@name` / `<@id>`
    // handling (see there) — but over durable history instead of the live
    // `channels` map, so a disconnected/post-restart DM stays addressable
    // by the natural forms an agent would type, not just the exact stored
    // label string. Tried BEFORE the generic byLabel/byName loop below
    // because a bare `@antra` would otherwise also partially match via
    // normalizeChannelLabel's '#'-only stripping (which does nothing for a
    // leading '@') and fail confusingly instead of going through DM rules.
    const mention = /^<@!?(\d+)>$/.exec(trimmed);
    if (trimmed.startsWith('@') || mention) {
      return this.resolveDmFromHistory(trimmed, mention);
    }

    const normSpec = normalizeChannelLabel(trimmed);
    let byLabel: string | undefined;
    let byLabelAmbiguous = false;
    let byName: string | undefined;
    let byNameAmbiguous = false;

    for (const [channelId, labels] of this.allLabelsSeen) {
      for (const label of labels) {
        // `?? ''` is belt-and-braces: appendLabelSighting/replay already
        // refuse to store a falsy label, so this should never see one, but
        // normalizeChannelLabel has no internal guard of its own (unlike
        // resolveProseTarget's `e.descriptor.label ?? ''`), and this is
        // exactly the kind of one-bad-record-poisons-every-future-call path
        // that caused finding #2.
        const normLabel = normalizeChannelLabel(label ?? '');
        const normName = normalizeChannelLabelName(label ?? '');
        if (normLabel === normSpec) {
          if (byLabel !== undefined && byLabel !== channelId) byLabelAmbiguous = true;
          byLabel = channelId;
        }
        if (normName === normSpec) {
          if (byName !== undefined && byName !== channelId) byNameAmbiguous = true;
          byName = channelId;
        }
      }
    }

    if (byLabel !== undefined && !byLabelAmbiguous) return byLabel;
    if (byName !== undefined && !byNameAmbiguous) return byName;
    return undefined;
  }

  /**
   * A channel counts as a DM (for the purposes of durable-history lookup)
   * if: it was EXPLICITLY classified as one via `metadata.channelType ===
   * 'dm'` at some sighting (`dmClassified` — the same classification
   * signal `resolveProseTarget()`'s live `isDmEntry()` checks FIRST, before
   * any naming convention, so an id/label that don't follow the usual
   * `:dm:`/`DM: ` shape still get recognized correctly — this is what
   * `private-room-42` labeled just `Tess` needs); OR, as a fallback for
   * descriptors that never carried that metadata at all, its id shape says
   * so, or any label it has ever carried says so.
   */
  private isDmChannelId(channelId: string): boolean {
    if (this.dmClassified.get(channelId) === true) return true;
    if (channelId.includes(':dm:')) return true;
    const labels = this.allLabelsSeen.get(channelId);
    if (!labels) return false;
    for (const label of labels) {
      if (label.toLowerCase().startsWith('dm: ')) return true;
    }
    return false;
  }

  /**
   * Durable-history counterpart to `resolveProseTarget()`'s DM-matching arm
   * (see there for the live version this mirrors). Handles the two forms
   * `resolveProseTarget()` supports: a `<@id>` mention (matched against
   * `dmRecipientIds`, persisted alongside a label sighting specifically for
   * this) and a bare `@name` (matched against EITHER the persisted
   * `dmRecipientNames` — the DM's actual username, which the live resolver
   * prefers and which can differ from the display label, e.g. label
   * "DM: Tess" but username "antra_tessera" — OR the `DM: `-stripped form
   * of each DM channel's CURRENT label in `labelHistory`, as a fallback for
   * descriptors that never carried a recipientName; historical DM labels
   * aren't name-matched here the way non-DM labels are in
   * `resolveLabelFromHistory`'s main loop, since a DM's label is a person's
   * name, not a channel name subject to the same kind of rename).
   *
   * Returns undefined on no-match OR ambiguity, same contract as
   * `resolveLabelFromHistory` — the caller falls back to the live
   * resolver's original error.
   */
  private resolveDmFromHistory(trimmed: string, mention: RegExpExecArray | null): string | undefined {
    // dmClassified/dmRecipientIds/dmRecipientNames are always populated
    // alongside allLabelsSeen (same appendLabelSighting call, same
    // falsy-label early return) — so allLabelsSeen's keys are a superset
    // of every channel any DM signal could exist for.
    const dmChannelIds = [...this.allLabelsSeen.keys()].filter((id) => this.isDmChannelId(id));

    if (mention) {
      const id = mention[1]!;
      const matches = dmChannelIds.filter((cid) => this.dmRecipientIds.get(cid) === id);
      return matches.length === 1 ? matches[0] : undefined;
    }

    const name = trimmed.slice(1).toLowerCase();
    const labelName = (channelId: string): string => {
      const label = (this.labelHistory.get(channelId) ?? '').toLowerCase();
      return label.startsWith('dm: ') ? label.slice(4) : label;
    };

    // Three strict tiers, mirroring the LIVE resolver's precedence (which
    // prefers recipientName over the label outright, never a flat pool of
    // equal-priority candidates): (1) EXACT match against a channel's own
    // recorded recipientName, (2) EXACT match against a channel's label
    // (only tried when tier 1 found NOTHING — not merely "didn't match
    // this channel", genuinely zero matches across every dm channel), (3)
    // fuzzy/substring match across the combined name pool, as a last
    // resort. Each tier stops at real ambiguity (2+ matches) rather than
    // falling through — an ambiguous EXACT recipientName match is a
    // genuine collision between two real usernames, not something a
    // weaker label-based tier should silently resolve.
    //
    // Tier 1 taking outright precedence (not "additive" the way label
    // fuzzy-matching is within a single channel) is the actual fix: a flat
    // combined pool let a DIFFERENT channel's stale/unrelated display
    // label collide with THIS channel's real recorded username, making an
    // otherwise-unique lookup falsely ambiguous after a restart — even
    // though the persisted recipientName data was sufficient on its own to
    // resolve it. See the regression for the exact collision shape.
    const exactRecipientName = dmChannelIds.filter((cid) => this.dmRecipientNames.get(cid)?.toLowerCase() === name);
    if (exactRecipientName.length === 1) return exactRecipientName[0];
    if (exactRecipientName.length > 1) return undefined;

    const exactLabel = dmChannelIds.filter((cid) => labelName(cid) === name);
    if (exactLabel.length === 1) return exactLabel[0];
    if (exactLabel.length > 1) return undefined;

    const candidateNames = (channelId: string): string[] => {
      const names: string[] = [];
      const recipientName = this.dmRecipientNames.get(channelId);
      if (recipientName) names.push(recipientName.toLowerCase());
      const label = labelName(channelId);
      if (label) names.push(label);
      return names;
    };
    const fuzzy = dmChannelIds.filter((cid) =>
      candidateNames(cid).some((n) => n.length >= 3 && (n.startsWith(name) || name.startsWith(n) || n.includes(name))),
    );
    return fuzzy.length === 1 ? fuzzy[0] : undefined;
  }

  /**
   * Durable-history-aware counterpart to `resolveProseTarget()`. Resolves a
   * label or channelId to a canonical channel id even for a channel the bot
   * is not currently connected to (browsing message history is exactly the
   * case where you want to look at an old/quiet/disconnected channel, so the
   * live-only `resolveProseTarget()` isn't enough).
   *
   * Tries the live path first — unchanged, so ordinary addressing keeps its
   * exact current behavior — and only consults `labelHistory` on a live
   * miss. If history has no answer either, the original error/candidates
   * from `resolveProseTarget()` are returned unchanged, so callers keep the
   * same debuggability they'd get from the live-only path.
   *
   * CAVEAT (prose-misdelivery safety): if two channels once shared a label
   * but only ONE of them ever got a durable label-history record (e.g. the
   * other was lazily registered label-less, or predates this feature), this
   * can return a single confident answer where `resolveProseTarget()` on
   * fuller live data would have said "ambiguous" — the durable fallback
   * only sees what was actually persisted, not what's structurally true.
   * This is harmless for the current sole caller
   * (`HistoryModule.resolveChannel`, read-only), but a future caller wiring
   * this into a SEND path should be aware the ambiguity guarantee is weaker
   * here than on the live path.
   */
  resolveProseTargetDurable(
    spec: string,
  ): { channelId: string; label?: string } | { error: string; candidates?: string[] } {
    const live = this.resolveProseTarget(spec);
    if (!('error' in live)) return live;

    const channelId = this.resolveLabelFromHistory(spec);
    if (channelId !== undefined) {
      return { channelId, label: this.labelHistory.get(channelId) };
    }
    return live;
  }

  private setDesiredState(
    serverId: string,
    channelId: string,
    desired: DesiredChannelState,
    source: string,
  ): void {
    const key = this.lifecycleKey(serverId, channelId);
    const current = this.desiredStates.get(key);
    // A decision that records the state already on record changes nothing,
    // so it writes nothing, unless it's the agent's own (channel_open,
    // channel_close or channel_decline) and the record isn't. The record
    // then says the agent decided, which is all handleToolClose's
    // explicit-open guard and ensureInitialDesiredState's lift of a default
    // ask of it. openChannelNow depends on it too: a failed open by speech
    // or a reply tells a decision made during its round-trip by the record
    // no longer being the object it wrote, and the agent's channel_open,
    // the only decision of the same state that can be made then, gets a new
    // record here.
    if (current?.state === desired && !(AGENT_DECISION_SOURCES.has(source) && !AGENT_DECISION_SOURCES.has(current.source))) {
      return;
    }
    this.appendLifecycleEvent({
      kind: 'desired-state',
      serverId,
      channelId,
      desired,
      source,
      timestamp: new Date().toISOString(),
    });
    this.desiredStates.set(key, { state: desired, source });
  }

  // ==========================================================================
  // Tune-out state (issue #77) — durable in the lifecycle log
  // ==========================================================================

  /**
   * Enter (or re-enter with fresh params) the tuned-out state for a channel.
   * Re-entering under a new epochId replaces the active epoch; the previous
   * epoch's stamped messages stay excluded (stamps are permanent) and its
   * wake count is superseded. Transport stays open (see reconcile).
   */
  enterTuneOut(
    serverId: string,
    channelId: string,
    params: TuneOutParams,
    source: string,
  ): void {
    const key = this.lifecycleKey(serverId, channelId);
    this.appendLifecycleEvent({
      kind: 'desired-state',
      serverId,
      channelId,
      desired: 'tuned-out',
      tuneOut: params,
      source,
      timestamp: new Date().toISOString(),
    });
    this.desiredStates.set(key, {
      state: 'tuned-out',
      source,
      tuneOut: params,
      wakeCount: 0,
    });
  }

  /**
   * End the active tune-out, returning the channel to `nextState`.
   * The caller (tune-out coordinator) owns the dump/notice flow; this is
   * only the durable state flip. No-op returning null if the channel is
   * not tuned out.
   */
  cancelTuneOut(
    serverId: string,
    channelId: string,
    nextState: 'open' | 'closed',
    source: string,
  ): { params: TuneOutParams; wakeCount: number } | null {
    const key = this.lifecycleKey(serverId, channelId);
    const current = this.desiredStates.get(key);
    if (current?.state !== 'tuned-out' || !current.tuneOut) return null;
    const ended = { params: current.tuneOut, wakeCount: current.wakeCount ?? 0 };
    this.appendLifecycleEvent({
      kind: 'desired-state',
      serverId,
      channelId,
      desired: nextState,
      source,
      timestamp: new Date().toISOString(),
    });
    this.desiredStates.set(key, { state: nextState, source });
    return ended;
  }

  /**
   * Durably record one wake invocation against the active epoch and return
   * the updated count with the params (the coordinator compares against
   * maxWakes and decides auto-cancel). Durable here, not in gate stats:
   * gate runtime state dies with the process, and a restart must not grant
   * a hammered channel a fresh wake budget.
   */
  recordTuneOutWake(
    serverId: string,
    channelId: string,
  ): { params: TuneOutParams; wakeCount: number } | null {
    const key = this.lifecycleKey(serverId, channelId);
    const current = this.desiredStates.get(key);
    if (current?.state !== 'tuned-out' || !current.tuneOut) return null;
    const wakeCount = (current.wakeCount ?? 0) + 1;
    this.appendLifecycleEvent({
      kind: 'tune-out-wake',
      serverId,
      channelId,
      epochId: current.tuneOut.epochId,
      wakeCount,
      timestamp: new Date().toISOString(),
    });
    current.wakeCount = wakeCount;
    return { params: current.tuneOut, wakeCount };
  }

  /** Active tune-out params + wake count for a channel, or null. */
  getTuneOutState(
    serverId: string,
    channelId: string,
  ): { params: TuneOutParams; wakeCount: number } | null {
    const current = this.desiredStates.get(this.lifecycleKey(serverId, channelId));
    if (current?.state !== 'tuned-out' || !current.tuneOut) return null;
    return { params: current.tuneOut, wakeCount: current.wakeCount ?? 0 };
  }

  /** Registered channel entries (read-only iteration for the coordinator). */
  listChannelsRaw(): Array<{ serverId: string; descriptor: ChannelDescriptor }> {
    return [...this.channels.values()].map((e) => ({
      serverId: e.serverId,
      descriptor: e.descriptor,
    }));
  }

  /**
   * Small chronicle snapshot-state helpers for the tune-out coordinator
   * (dispositions slot). Registration is idempotent; absent store = null/no-op
   * (mirrors the lifecycle log's optional-store posture).
   */
  readCoordinatorState(stateId: string): unknown {
    if (!this.store) return null;
    ensureStateRegistered(this.store, { id: stateId, strategy: 'snapshot' });
    return this.store.getStateJson(stateId);
  }

  writeCoordinatorState(stateId: string, value: unknown): void {
    if (!this.store) return;
    ensureStateRegistered(this.store, { id: stateId, strategy: 'snapshot' });
    this.store.setStateJson(stateId, value);
  }

  /**
   * Publish into a channel on behalf of a named non-resident agent (the
   * subconscious's speak_in_channel). Same delivery path, and the same result,
   * as the channel_publish tool. Its traces carry the agent's name and follow
   * the publish's outcome as deliverSpeech's do: speech-routed after a
   * confirmed delivery, and speech-route-failed otherwise, `unknown` when the
   * words may have been posted and `failed` when nothing was, a refusal before
   * the publish included. The routed trace carries no message id, as before:
   * nothing here reads one, and a consumer that edits the newest traced
   * message in a channel would have this post to edit when an interruption of
   * the resident matches none.
   */
  async publishForAgent(
    channelId: string,
    text: string,
    agentName: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string; isError?: boolean }> {
    // The server the publish goes to, as handleToolPublish finds it before
    // it awaits: the channel may be removed while the reply is pending.
    const serverId = this.findChannelEntry(channelId)?.serverId ?? '';
    const seen: { outcome?: PublishOutcome } = {};
    const result = await this.handleToolPublish({ channelId, content: text }, undefined, seen, 'speak_in_channel');
    if (seen.outcome?.status === 'delivered') {
      this.emitTraceFn({
        type: 'mcpl:speech-routed',
        conversationId: agentName,
        serverId,
        channelId,
        delivered: true,
        textLen: text.length,
        text,
      });
    } else {
      this.emitTraceFn({
        type: 'mcpl:speech-route-failed',
        conversationId: agentName,
        channelId,
        // The publish's own reason and the connector's detail, as
        // deliverSpeech's trace gives them, or the refusal before any publish.
        reason: seen.outcome?.reason ?? result.error ?? 'the publish failed',
        textLen: text.length,
        outcome: seen.outcome?.status === 'unknown' ? 'unknown' : 'failed',
        ...(seen.outcome?.detail !== undefined ? { detail: connectorText(seen.outcome.detail) } : {}),
      });
    }
    return result;
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

    this.appendLifecycleEvent({
      kind: 'legacy-policy-migrated',
      serverId,
      source: Array.isArray(policy) ? 'allow-list' : policy,
      timestamp: new Date().toISOString(),
    });
    this.migratedLegacyPolicies.add(serverId);
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

  /**
   * Returns true when this call made a FRESH subscription-policy decision to
   * open the channel — the caller announces those to the agent (once per
   * channel ever: the decision persists in chronicle, so reboots see an
   * existing non-default source and never re-fire).
   */
  private ensureInitialDesiredState(serverId: string, channel: ChannelDescriptor): boolean {
    const byPolicy = this.policyWantsOpen(serverId, channel);
    const wantsOpen = channel.initiallyOpen === true || byPolicy;
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
        return channel.initiallyOpen !== true && byPolicy;
      }
      return false;
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
    return channel.initiallyOpen !== true && byPolicy;
  }

  /**
   * Apply current durable intent, serializing the transport rather than the
   * server's registration ACK. Re-read after every await: registration,
   * descriptor updates, or a newer decision may have replaced our snapshot.
   */
  private applyDesiredChannelState(
    serverId: string,
    channelId: string,
    options?: { history?: ChannelHistoryRequest },
  ): Promise<{ open: boolean; result?: ChannelsOpenResult }> {
    const lifecycleKey = this.lifecycleKey(serverId, channelId);
    const removals = this.serverRemovals.get(serverId) ?? 0;
    const previous = this.channelLifecycleTails.get(lifecycleKey) ?? Promise.resolve();
    this.lifecycleOutstanding.set(lifecycleKey, (this.lifecycleOutstanding.get(lifecycleKey) ?? 0) + 1);
    this.lifecycleQueuedRemovals.set(lifecycleKey, removals);
    const operation = previous.catch(() => {}).then(
      () => this.runLifecycleOperation(serverId, channelId, removals, options),
    );
    // Keep the rejection visible to existing joiners, while observing it
    // immediately and letting each queued successor start after either result.
    const tail = operation.then(() => {});
    this.channelLifecycleTails.set(lifecycleKey, tail);
    const cleanup = () => {
      if (this.channelLifecycleTails.get(lifecycleKey) === tail) {
        this.channelLifecycleTails.delete(lifecycleKey);
      }
    };
    void tail.then(cleanup, cleanup);
    return operation;
  }

  /** One queued lifecycle operation, run when its turn in the queue comes. */
  private async runLifecycleOperation(
    serverId: string,
    channelId: string,
    removals: number,
    options?: { history?: ChannelHistoryRequest },
  ): Promise<{ open: boolean; result?: ChannelsOpenResult }> {
    const channelKey = `${serverId}:${channelId}`;
    const lifecycleKey = this.lifecycleKey(serverId, channelId);
    try {
      let attempts = 0;
      for (;;) {
        if ((this.serverRemovals.get(serverId) ?? 0) !== removals) {
          throw new ChannelLifecycleError(
            `this host disconnected the "${serverId}" server while the change was being made`, 'cancelled',
          );
        }
        const entry = this.channels.get(channelKey);
        if (!entry) throw new ChannelLifecycleError(`the "${serverId}" server no longer lists the channel`, 'unlisted');
        const server = this.serverRegistry.getServer(serverId);
        if (!server || !CapabilityGrant.of(server).has('channels.lifecycle')) throw this.lifecycleRefusal(serverId);
        const descriptor = entry.descriptor;
        const desired = this.getDesiredState(serverId, channelId);
        const open = desired === 'open' || desired === 'tuned-out';
        // Per-RPC timeouts do not bound a stream of promptly successful but
        // continually superseded receipts. Bound this whole operation, then
        // release its queue slot and surface the failure to delivery joiners.
        // Its open flag needs no change here: every retry follows a replaced
        // registration, a retarget (already invalidated, whether the old
        // target's RPC was answered or failed), or a receipt for this very
        // target.
        if (attempts >= MAX_CHANNEL_LIFECYCLE_ATTEMPTS) {
          const error = new ChannelLifecycleError(
            `the channel's address at the "${serverId}" server, or the decision about it, kept changing, and ${attempts} tries ` +
            "didn't settle it",
            'converge',
          );
          this.emitTraceFn({
            type: 'mcpl:channel-reconcile-failed',
            serverId, channelId, desired, attempts, error: error.message,
          });
          throw error;
        }
        attempts++;
        const sameTarget = () => this.serverRegistry.getServer(serverId) === server &&
          sameChannelTarget(entry.descriptor, descriptor);
        let result: ChannelsOpenResult | undefined;
        try {
          if (open) {
            result = await server.sendChannelsOpen({
              channelId, type: descriptor.type, address: descriptor.address,
              ...(options?.history ? { history: options.history } : {}),
            });
          } else {
            await server.sendChannelsClose({ channelId });
          }
        } catch (error) {
          // An RPC can fail after the server acted, so a failure for the
          // current target leaves its outcome unknown: it is marked
          // unconfirmed with open unchanged, which keeps a confirmed-open
          // channel usable after a failed backscroll (the mark is read only
          // while not open). A failure from an older connection or target
          // also withdraws the open flag.
          if (this.channels.get(channelKey) === entry) {
            if (sameTarget()) this.unconfirmedChannelTargets.add(entry);
            else this.invalidateTransportConfirmation(entry);
          }
          // A retarget while this RPC was out queued nothing for the new
          // target, since handleChanged leaves that to this operation. So a
          // failure for the old target says nothing about the new one, and a
          // channel still decided open or tuned out tries its new target,
          // within the attempt limit.
          if (this.channels.get(channelKey) === entry && !sameChannelTarget(entry.descriptor, descriptor)) {
            const now = this.getDesiredState(serverId, channelId);
            if (now === 'open' || now === 'tuned-out') continue;
          }
          throw error;
        }
        // A server can answer for a channel other than the one named: one
        // that falls back to its first channel of the type for an id it no
        // longer knows opens that channel and returns its history. Whatever
        // becomes of this receipt, the server did that: say so, and undo the
        // open it made if the host wants that channel closed.
        const substitute = open ? substitutedChannel(result, channelId) : undefined;
        if (substitute !== undefined) {
          // Each id prints through logValue, as the rejection lines' ids do,
          // so an odd one can't add a line or a field.
          const answered = logValue(substitute.kind === 'other' ? substitute.id : substitute.value);
          console.error(
            `[channel-open-substituted] server=${serverId} requested=${logValue(channelId)} answered=${answered}`,
          );
          this.emitTraceFn({ type: 'mcpl:channel-open-substituted', serverId, channelId, answeredFor: answered });
          // A malformed id names nothing registered here, so there is
          // nothing to close.
          if (substitute.kind === 'other') this.closeSubstitutedChannel(serverId, substitute.id);
        }
        // Never apply an old receipt to the current target, even transiently:
        // a corrective open might fail before that stale bit is replaced.
        if (this.channels.get(channelKey) !== entry) continue;
        if (!sameTarget()) {
          this.invalidateTransportConfirmation(entry);
          continue;
        }
        // A current receipt for another channel confirms nothing about this
        // one, and its history is another channel's. So the open fails,
        // nothing in the answer is used, and this channel's open state is
        // unconfirmed: a server that doesn't resolve this id may not resolve
        // its sends either.
        if (substitute !== undefined) {
          this.invalidateTransportConfirmation(entry);
          throw new ChannelLifecycleError(
            `the "${serverId}" server answered for ` +
            (substitute.kind === 'other' ? 'a different channel' : 'a channel whose id isn\'t a string') +
            ', so nothing in its answer is used',
            'substituted',
          );
        }
        if (open) this.applyOpenDeclaration(entry, result);
        entry.open = open;
        this.unconfirmedChannelTargets.delete(entry);
        const now = this.getDesiredState(serverId, channelId);
        if (open !== (now === 'open' || now === 'tuned-out')) continue;
        return { open, result };
      }
    } finally {
      // Synchronous with the operation's last look at its target: from here
      // on, nothing it does will open a new target.
      const left = (this.lifecycleOutstanding.get(lifecycleKey) ?? 1) - 1;
      if (left > 0) this.lifecycleOutstanding.set(lifecycleKey, left);
      else {
        this.lifecycleOutstanding.delete(lifecycleKey);
        this.lifecycleQueuedRemovals.delete(lifecycleKey);
      }
    }
  }

  /** Whether lifecycle work already outstanding for the channel will carry out
   *  its current decision: some is, and the newest was queued since its
   *  server's registrations were last removed, so it won't cancel when it
   *  would run. Each operation reads the decision when it runs. It answers for
   *  now: a removal after it cancels that work too, and takes the channel's
   *  entry with it, so the channel's next registration by channels/register,
   *  or as added by channels/changed, carries the decision out, where this
   *  host directs the lifecycle then. A push's registration
   *  (ensureChannelRegistered) queues no lifecycle work. */
  private outstandingWorkCarriesOut(serverId: string, key: string): boolean {
    return this.lifecycleOutstanding.has(key) &&
      this.lifecycleQueuedRemovals.get(key) === (this.serverRemovals.get(serverId) ?? 0);
  }

  /**
   * A server that answered an open with another channel really opened that
   * one. When it's registered here and the host wants it closed, close it
   * through its own lifecycle queue: otherwise its traffic would reach the
   * resident, marked open by its first incoming message. A channel the host
   * wants open is left alone, and a close can't be answered for another
   * channel, so this never starts another substitution. An id the host
   * doesn't know needs nothing: §14.5 refuses its traffic.
   */
  private closeSubstitutedChannel(serverId: string, channelId: string): void {
    if (!this.channels.has(`${serverId}:${channelId}`)) return;
    if (this.getDesiredState(serverId, channelId) !== 'closed') return;
    this.applyThroughQueue(serverId, channelId);
  }

  /**
   * Carry out a channel's decision through its lifecycle queue, for a
   * transport the server may have opened without the host's knowing: one it
   * opened for another channel's request (closeSubstitutedChannel), or one a
   * failed open's request may have reached (openChannelNow). The decision is
   * a closed one, except after a failed open whose put-back the server's
   * latest announcement or the policy lifted. A failure is reported as a
   * trace; the decision stands.
   */
  private applyThroughQueue(serverId: string, channelId: string): void {
    this.applyDesiredChannelState(serverId, channelId).catch((err) => {
      // Removal while queued is cancellation, as in reconcileChannels, and
      // exhausted convergence emitted its own diagnostic.
      if (!this.channels.has(`${serverId}:${channelId}`) ||
          (err instanceof ChannelLifecycleError && (err.kind === 'cancelled' || err.kind === 'converge'))) return;
      this.emitTraceFn({
        type: 'mcpl:channel-reconcile-failed',
        serverId, channelId, desired: this.getDesiredState(serverId, channelId), error: (err as Error).message,
      });
    });
  }

  /**
   * Join outstanding lifecycle work without recording new intent. Retargeting
   * may have invalidated open confirmation while the decision remains pending.
   * A close that settles during the wait remains authoritative where the host
   * directs the server's lifecycle (closeStands); waiting for it is not an
   * instruction to open the channel again.
   */
  private async waitForOpenChannel(entry: ChannelEntry): Promise<ChannelEntry> {
    const lifecycleKey = this.lifecycleKey(entry.serverId, entry.descriptor.id);
    // The failure of the last work waited on, if it failed, which says why a
    // channel it left unopened isn't open.
    let failed: unknown;
    for (;;) {
      const pending = this.channelLifecycleTails.get(lifecycleKey);
      if (!pending) break;
      try {
        await pending;
        failed = undefined;
      } catch (error) {
        // A redundant backscroll failure can leave a known-open channel
        // usable. Exhausted convergence is different: it never established
        // the current target, so joined delivery must fail visibly.
        if (error instanceof ChannelLifecycleError && error.kind === 'converge') throw error;
        failed = error;
      }
      // A settled tail releases its own key. One still current after it
      // settled would be awaited again without ever yielding to the event
      // loop, so stop waiting rather than spin.
      if (this.channelLifecycleTails.get(lifecycleKey) === pending) break;
    }
    const current = this.channels.get(`${entry.serverId}:${entry.descriptor.id}`);
    if (!current) throw new ChannelLifecycleError(CHANNEL_REMOVED_CLAUSE, 'removed');
    // A close that stands is what the words met, whatever became of an open,
    // and whether or not the close itself took: one that failed may have
    // left the transport open.
    if (this.closeStands(current)) {
      throw new ChannelLifecycleError('a decision to close the channel came before these words went out', 'not-open');
    }
    if (!current.open) {
      throw new ChannelLifecycleError(
        "the channel isn't confirmed open" + (failed !== undefined ? `: ${lifecycleClause(failed)}${refusalRemedy(failed)}` : ''),
        'not-open',
      );
    }
    return current;
  }

  private async reconcileChannels(
    serverId: string,
    channels: ChannelDescriptor[],
  ): Promise<void> {
    const server = this.serverRegistry.getServer(serverId);
    if (!server) return;

    // §14.1: channels/open + channels/close require channels.lifecycle.
    // Skipping reconciliation for an ungranted server is the enforcement —
    // its channels simply stay in whatever state the server chose, and the
    // host never directs lifecycle it was not granted authority over.
    if (!CapabilityGrant.of(server).has('channels.lifecycle')) {
      this.emitTraceFn({
        type: 'mcpl:channel-reconcile-skipped',
        serverId,
        reason: 'channels.lifecycle not in effective grant (§14.1)',
      });
      return;
    }

    // Channels the subscription policy freshly admitted in THIS pass —
    // announced to the agent as one batched notice after the loop, so a
    // first boot on a new policy doesn't produce one notice per channel.
    const policyOpened: Array<{ channelId: string; label?: string }> = [];

    // Record all admissions before waiting on any channel. A slow first RPC
    // must not delay intent for the rest of this registration batch.
    for (const channel of channels) {
      const entry = this.channels.get(`${serverId}:${channel.id}`);
      if (entry && this.ensureInitialDesiredState(serverId, entry.descriptor)) {
        policyOpened.push({ channelId: channel.id, label: entry.descriptor.label });
      }
    }

    // Announce the durable admission decision before awaiting transport.
    // This is intent, not confirmation that an open RPC succeeded. It stays
    // truthful if the first attempt fails, and a retry needs no new admission.
    if (policyOpened.length > 0) {
      try {
        this.onChannelAutoOpened?.({
          serverId,
          source: 'subscription-policy',
          channels: policyOpened,
        });
      } catch (err) {
        console.error('onChannelAutoOpened (policy) failed:', err);
      }
    }

    // Each channel has its own lifecycle queue, so a held RPC for one (up to
    // its timeout, times its attempts) doesn't delay its siblings.
    await Promise.allSettled(channels.map(async (channel) => {
      if (!this.channels.has(`${serverId}:${channel.id}`)) return;
      try {
        await this.applyDesiredChannelState(serverId, channel.id);
      } catch (err) {
        // Removal while queued is cancellation, not a failed subscription.
        // Exhausted convergence and a substituted answer already emitted
        // their own diagnostics.
        if (!this.channels.has(`${serverId}:${channel.id}`) ||
            (err instanceof ChannelLifecycleError &&
              (err.kind === 'cancelled' || err.kind === 'converge' || err.kind === 'substituted'))) return;
        this.emitTraceFn({
          type: 'mcpl:channel-reconcile-failed',
          serverId,
          channelId: channel.id,
          desired: this.getDesiredState(serverId, channel.id),
          error: (err as Error).message,
        });
      }
    }));
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
    // §14.1: channels/typing requires channels.typing in the grant. Silent
    // skip — a typing indicator is cosmetic and per-7s, so a diagnostic per
    // tick would be noise.
    if (!CapabilityGrant.of(this.serverRegistry.getServer(serverId)).has('channels.typing')) return;
    if (this.sendTypingFn) {
      this.sendTypingFn(serverId, channelId, this.typingMetadata.get(channelId));
    }
    // TODO: When server-connection exposes a public sendNotification or
    // sendTyping method, wire it here directly instead of using a callback.
  }

  // ==========================================================================
  // Private: Channel Lookup
  // ==========================================================================

  /** Descriptors registered by one server — the §14.3 channels/list answer. */
  descriptorsForServer(serverId: string): ChannelDescriptor[] {
    return [...this.channels.values()]
      .filter((e) => e.serverId === serverId)
      .map((e) => e.descriptor);
  }

  /** Server id owning a registered channel (by descriptor id), or null. */
  getChannelServerId(channelId: string): string | null {
    return this.findChannelEntry(channelId)?.serverId ?? null;
  }

  /**
   * The server that declared this channel inbound-only (isInboundOnly), or
   * undefined when it isn't one. The notices name that server. A caller that
   * knows the channel's server passes it; otherwise the channel is found by
   * its id alone (findChannelEntry).
   */
  inboundOnlyServer(channelId: string, serverId?: string): string | undefined {
    const entry = serverId ? this.channels.get(`${serverId}:${channelId}`) : this.findChannelEntry(channelId);
    return entry && isInboundOnly(entry) ? entry.serverId : undefined;
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
    const withId = [...this.channels.values()].filter((entry) => entry.descriptor.id === channelId);
    const matches = withId.filter((entry) => !serverId || entry.serverId === serverId);
    if (matches.length === 0) {
      if (serverId && withId.length > 0) {
        // Leaving serverId out works only when one server has the id.
        const servers = withId.map((entry) => `"${entry.serverId}"`);
        return {
          error: `No channel "${channelId}" is on server "${serverId}", so nothing ran. ` + (servers.length === 1
            ? `It's on server ${servers[0]}: call again with serverId ${servers[0]}, or leave serverId out.`
            : `It's on servers ${servers.join(', ')}: call again with serverId set to one of them.`),
        };
      }
      return {
        error: serverId
          ? `No channel "${channelId}" is on server "${serverId}", so nothing ran. channel_list shows the channels and their servers.`
          : `No channel has the id "${channelId}", so nothing ran. channel_list shows the channel ids.`,
      };
    }
    if (matches.length > 1) {
      return {
        error: `Channel "${channelId}" is on more than one server (${matches.map((entry) => `"${entry.serverId}"`).join(', ')}), ` +
          'so nothing ran. Call again with serverId set to one of them.',
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
   * Record durable desired-open intent, then queue the channel's lifecycle
   * work (applyDesiredChannelState), which tells the server to subscribe and
   * marks the live entry open on a receipt for its current target, applying
   * an inbound-only declaration the answer carries (applyOpenDeclaration).
   * Every open the agent or its speech asks for — the channel_open tool, delivery
   * into a closed locus, an explicit send into a closed channel — comes
   * here. Reconciliation queues that work directly, as the closes do
   * (channel_close, a decline, and the close of a substituted channel).
   * Desired state is recorded BEFORE the server round-trip. The agent's own
   * open is a decision about the channel: it sticks even if the subscribe
   * fails, and reconciliation retries later. An open by speech or a reply is
   * incidental to its words: when its round-trip fails, the decision it
   * wrote goes back to the one it replaced, so the agent, told the channel
   * is closed and the open failed, isn't later put into it by that decision.
   * That holds only while the record is still the one it wrote: a decision
   * made meanwhile stands, and the failure then comes as `overtaken`
   * (ChannelLifecycleError). Where the decision put back is a pure default,
   * nobody had decided, so the channel then follows its server's latest
   * announcement and the policy: a re-announcement during the round-trip
   * found the open's own record and lifted nothing. If they select it for
   * opening, the failure says so (`selected-again`). And since
   * a failed request may have reached the server, the decision that stands
   * is carried out on the wire too. An open by speech or a reply that can't
   * send its request, on a server without channels.lifecycle, writes
   * nothing. Automatic delivery needs open transport, not a change of
   * attention: preserve tune-out epochs both before and during the
   * round-trip.
   *
   * `opened` says whether this call turned a closed channel open, which is
   * what the delivery and reply notices tell the resident. Reconfirming the
   * transport of a channel already decided open or tuned out isn't one.
   */
  private async openChannelNow(
    entry: ChannelEntry,
    source: 'agent-tool' | 'opened-by-reply' | 'opened-by-delivery',
    history?: ChannelHistoryRequest,
  ): Promise<{ result: ChannelsOpenResult; opened: boolean }> {
    const transportOnly = source !== 'agent-tool';
    const key = this.lifecycleKey(entry.serverId, entry.descriptor.id);
    if (transportOnly) {
      // Without channels.lifecycle the open fails before any request leaves
      // (§14.1), as it does without the server, so an incidental open would
      // only write a decision to put back. It writes none.
      const server = this.serverRegistry.getServer(entry.serverId);
      if (!server || !CapabilityGrant.of(server).has('channels.lifecycle')) throw this.lifecycleRefusal(entry.serverId);
    }
    // The decision this open replaces. A channel with none on record, as one
    // registered from a push, was closed by default: nobody had decided.
    const replaced = this.desiredStates.get(key) ?? { state: 'closed' as const, source: 'default-closed' };
    const before = this.getDesiredState(entry.serverId, entry.descriptor.id);
    const opened = before !== 'open' && before !== 'tuned-out';
    if (!transportOnly || before !== 'tuned-out') {
      // A decision the log refused changed nothing, and its words say so
      // rather than read as one a later decision overtook.
      try {
        this.setDesiredState(entry.serverId, entry.descriptor.id, 'open', source);
      } catch (err) {
        throw unrecordedDecision(err);
      }
    }
    // The record an incidental open wrote, to put back if its round-trip fails.
    const wrote = transportOnly && opened ? this.desiredStates.get(key) : undefined;
    try {
      const applied = await this.applyDesiredChannelState(entry.serverId, entry.descriptor.id, { history });
      const desired = this.getDesiredState(entry.serverId, entry.descriptor.id);
      if (!applied.open || (desired !== 'open' && !(transportOnly && desired === 'tuned-out'))) {
        throw new ChannelLifecycleError(supersededClause('open', desired), 'superseded');
      }
      return { result: applied.result!, opened };
    } catch (err) {
      if (wrote && this.desiredStates.get(key) !== wrote) {
        // That decision stands, and the failure says so where its own clause
        // doesn't, as a superseded open's does. What helps turns on that
        // decision, so no step is offered.
        const own = lifecycleClause(err);
        throw new ChannelLifecycleError(
          err instanceof ChannelLifecycleError && err.kind === 'superseded'
            ? own : afterClause(own, 'a decision about the channel made while the open was out stands'),
          'overtaken',
          undefined,
          { cause: err },
        );
      }
      if (wrote) {
        try {
          this.setDesiredState(entry.serverId, entry.descriptor.id, replaced.state, replaced.source);
        } catch (putBackErr) {
          // The caller reports both: the channel isn't open, but it stays
          // selected for opening, so reconciliation may open it later.
          throw new ChannelLifecycleError(
            afterClause(lifecycleClause(err), 'the channel stays selected for opening, as this host couldn\'t record ' +
              `undoing that: ${requestErrorText(putBackErr)}`),
            'put-back-unrecorded',
            undefined,
            { cause: err },
          );
        }
        // The decision put back is a closed one: an open that turned the
        // channel open replaced no open decision. Where it's a pure default,
        // nobody had decided, so the channel follows its server's latest
        // announcement and the policy, not the ones from before the open: a
        // re-announcement during the round-trip found the open's own record
        // and lifted nothing. The lift is ensureInitialDesiredState's own,
        // which leaves every real decision alone. One that can't be recorded
        // leaves the default, closed.
        const current = this.channels.get(`${entry.serverId}:${entry.descriptor.id}`);
        let selectedAgain: Exclude<SelectedForOpening, 'unrecorded'> | undefined;
        if (current) {
          try {
            this.ensureInitialDesiredState(entry.serverId, current.descriptor);
          } catch (liftErr) {
            console.error(
              `[channel] ${entry.serverId}:${logValue(entry.descriptor.id)}: the lift after a failed open couldn't be recorded:`,
              liftErr,
            );
          }
          const now = this.desiredStates.get(key);
          if (now?.state === 'open' && (now.source === 'server-bootstrap' || now.source === 'subscription-policy')) {
            selectedAgain = now.source;
          }
        }
        // The failed request may have reached the server, so the decision
        // that stands is carried out through the queue, as a decline's close
        // is, unless other lifecycle work for the channel is queued that will
        // carry it out anyway: work queued before its server's registrations
        // were removed cancels instead. (An incidental open gets here only
        // where the host directed the lifecycle when it opened: see the grant
        // check above. Where the grant has lost channels.lifecycle since, as a
        // transport drop clears it, the queued work fails for it, and the
        // channel's next registration by channels/register, or as added by
        // channels/changed, carries the decision out, where this host directs
        // the lifecycle then.)
        if (current && !this.outstandingWorkCarriesOut(entry.serverId, key)) {
          this.applyThroughQueue(entry.serverId, entry.descriptor.id);
        }
        if (selectedAgain) {
          throw new ChannelLifecycleError(
            afterClause(lifecycleClause(err), 'the channel is selected for opening again, as ' +
              (selectedAgain === 'server-bootstrap' ? 'its server announces it open' : 'the subscription policy admits it')),
            'selected-again',
            undefined,
            { by: selectedAgain, cause: err },
          );
        }
      }
      throw err;
    }
  }

  /**
   * An open's answer carries the server's descriptor for the channel
   * (§14.3), the first place a lazily registered channel's own declaration
   * can arrive. runLifecycleOperation hands it here, wherever the host opens
   * a channel, once the answer is known to be for the channel's current
   * entry and target. An answer that names another channel never arrives
   * here: it's a substitution, which fails the open. One whose channel names
   * no id is this channel's, as runLifecycleOperation takes it, so its
   * declaration applies too.
   *
   * Only an inbound-only declaration is applied. The answer isn't always the
   * server's latest word: a `channels/changed` that arrives in the same read
   * as the answer is handled before the open's operation resumes, so the
   * answer is applied over it. Applying only a refusal keeps that race
   * fail-closed: a stale answer can keep a channel refused until the
   * server's next update, but never lift a newer refusal. A server lifts its
   * declaration by changing or registering the channel again.
   */
  private applyOpenDeclaration(entry: ChannelEntry, answer: unknown): void {
    const declared = (answer as { channel?: { direction?: unknown } } | undefined)?.channel;
    if (declared?.direction === 'inbound') {
      entry.descriptor = { ...entry.descriptor, direction: 'inbound' };
    }
  }

  /**
   * Resolve a `>>` prose-routing target (explicit prose routing —
   * docs/explicit-prose-routing.md) to a registered channel.
   *
   * Accepted spellings, tried in order:
   *   1. exact descriptor id (`discord:guild:123`, always unambiguous)
   *   2. exact raw server-internal id (`address.channelId`)
   *   3. `#label` / bare label — case-insensitive match on descriptor label
   *      with any leading '#' stripped from both sides
   *   4. `@name` — DM descriptor labels (`DM: name`), case-insensitive
   *
   * Ambiguity is an error carrying candidates — never a guess: this is the
   * mechanism that makes prose misdelivery structurally impossible.
   *
   * `forSpeech` is for a target the agent's speech will be posted to: a
   * channel its server declared inbound-only (isInboundOnly) then resolves
   * to an error that says so, since nothing is published there, and that
   * names the channel as `refusedChannelId`, so a caller can tell a refused
   * channel from a name that resolved to nothing. Without it, as for reading
   * a channel's history, any registered channel resolves.
   */
  resolveProseTarget(
    spec: string,
    opts?: { forSpeech?: boolean },
  ): { channelId: string; label?: string } | { error: string; candidates?: string[]; refusedChannelId?: string } {
    const resolved = this.resolveTargetByName(spec);
    if (!opts?.forSpeech || 'error' in resolved) return resolved;
    const entry = this.findChannelEntry(resolved.channelId);
    return entry && isInboundOnly(entry)
      ? { error: `${resolved.channelId} is ${inboundOnlyReason(entry)}`, refusedChannelId: resolved.channelId }
      : resolved;
  }

  private resolveTargetByName(
    spec: string,
  ): { channelId: string; label?: string } | { error: string; candidates?: string[] } {
    const entries = [...this.channels.values()];
    const trimmed = spec.trim();
    if (!trimmed) return { error: 'empty target' };

    const exact = entries.filter((e) => e.descriptor.id === trimmed);
    if (exact.length === 1) {
      return { channelId: exact[0]!.descriptor.id, label: exact[0]!.descriptor.label };
    }
    if (exact.length > 1) {
      return {
        error: `channel id "${trimmed}" is ambiguous across servers`,
        candidates: exact.map((e) => `${e.serverId}:${e.descriptor.id}`),
      };
    }

    const raw = entries.filter(
      (e) => (e.descriptor.address as { channelId?: string } | undefined)?.channelId === trimmed,
    );
    if (raw.length === 1) {
      return { channelId: raw[0]!.descriptor.id, label: raw[0]!.descriptor.label };
    }
    if (raw.length > 1) {
      return {
        error: `raw id "${trimmed}" is ambiguous`,
        candidates: raw.map((e) => e.descriptor.id),
      };
    }

    const norm = normalizeChannelLabel;

    // DM addressing is PEOPLE-first: usernames and mention tokens, never
    // ids-only (2026-07-24, antra + Fable's live-canary bug report). A DM
    // entry is matched by, in order: recipientId (from a `<@id>` mention
    // token), exact recipient/label name, then prefix-lenient name (handles
    // "@antra_tessera" vs a display name "antra" and vice versa).
    const mention = /^<@!?(\d+)>$/.exec(trimmed);
    if (trimmed.startsWith('@') || mention) {
      const dmMeta = (e: ChannelEntry) =>
        e.descriptor.metadata as { channelType?: string; recipientId?: string; recipientName?: string } | undefined;
      const dmName = (e: ChannelEntry) => {
        const meta = dmMeta(e);
        if (meta?.recipientName) return meta.recipientName.toLowerCase();
        const label = (e.descriptor.label ?? '').toLowerCase();
        return label.startsWith('dm: ') ? label.slice(4) : label;
      };
      const isDmEntry = (e: ChannelEntry) =>
        dmMeta(e)?.channelType === 'dm' ||
        (e.descriptor.label ?? '').toLowerCase().startsWith('dm: ') ||
        e.descriptor.id.includes(':dm:');
      const dms = entries.filter(isDmEntry);

      if (mention) {
        const id = mention[1]!;
        const byId = dms.filter((e) => dmMeta(e)?.recipientId === id);
        if (byId.length === 1) {
          return { channelId: byId[0]!.descriptor.id, label: byId[0]!.descriptor.label };
        }
        return {
          error: `no registered DM matches the mention <@${id}>`,
          candidates: dms.map((e) => e.descriptor.label ?? e.descriptor.id).slice(0, 6),
        };
      }

      const name = trimmed.slice(1).toLowerCase();
      const exact = dms.filter((e) => dmName(e) === name);
      const pool = exact.length > 0
        ? exact
        : dms.filter((e) => {
            const n = dmName(e);
            return n.length >= 3 && (n.startsWith(name) || name.startsWith(n) || n.includes(name));
          });
      if (pool.length === 1) {
        return { channelId: pool[0]!.descriptor.id, label: pool[0]!.descriptor.label };
      }
      if (pool.length > 1) {
        return {
          error: `"${trimmed}" matches several DMs`,
          candidates: pool.map((e) => e.descriptor.label ?? e.descriptor.id),
        };
      }
      return {
        error: `no registered DM found for "${trimmed}" — for someone without a registered DM channel, use the send_dm tool`,
        ...(dms.length ? { candidates: dms.map((e) => e.descriptor.label ?? e.descriptor.id).slice(0, 6) } : {}),
      };
    }

    const byLabel = entries.filter(
      (e) => norm(e.descriptor.label ?? '') === norm(trimmed),
    );
    if (byLabel.length === 1) {
      return { channelId: byLabel[0]!.descriptor.id, label: byLabel[0]!.descriptor.label };
    }
    if (byLabel.length > 1) {
      return {
        error: `label "${trimmed}" matches several channels`,
        candidates: byLabel.map((e) => e.descriptor.id),
      };
    }

    // Name-segment match: server labels carry a disambiguating suffix
    // (`#fable (antra's server)`) that agents naturally omit — `>>#fable`
    // must resolve. Strip a trailing parenthetical from the stored label and
    // compare the bare channel name. Same name in several guilds is a real
    // ambiguity: error with full labels so the agent can use the exact id.
    const nameOf = normalizeChannelLabelName;
    const byName = entries.filter((e) => nameOf(e.descriptor.label ?? '') === norm(trimmed));
    if (byName.length === 1) {
      return { channelId: byName[0]!.descriptor.id, label: byName[0]!.descriptor.label };
    }
    if (byName.length > 1) {
      return {
        error: `"${trimmed}" matches several channels`,
        candidates: byName.map((e) => `${e.descriptor.label} = ${e.descriptor.id}`),
      };
    }

    // No match: offer near-candidates (labels containing the name) so the
    // bounce notice is self-healing rather than a dead end.
    const near = entries
      .filter((e) => norm(e.descriptor.label ?? '').includes(norm(trimmed)))
      .slice(0, 5)
      .map((e) => `${e.descriptor.label} = ${e.descriptor.id}`);
    return { error: `no channel matches "${trimmed}"`, ...(near.length ? { candidates: near } : {}) };
  }

  /**
   * The `>>` target to show an agent for a channel: one whitespace-free token
   * that `resolveProseTarget()` maps back to this same channel. The prefix
   * grammar takes the target as the first non-whitespace run, so a label with
   * a space can't be quoted verbatim: `>>#DM: alice` parses as target `#DM:`
   * plus body `alice …`, and `>>#fable (antra's server)` delivers
   * `(antra's server)` as text. Tried in order: `@name` for a DM, `#label`,
   * `#name` (label without its server suffix), the descriptor id.
   *
   * Undefined when there is no safe token: the channel isn't registered (on
   * `serverId`, when given), no candidate is whitespace-free and resolves back,
   * or the id is registered by more than one server. A resolved target names a
   * channel by id alone, and ids are unique only within a connection, so a
   * shared id could route the reply through the wrong server.
   */
  proseTargetFor(channelId: string, serverId?: string): string | undefined {
    const sameId = [...this.channels.values()].filter((e) => e.descriptor.id === channelId);
    const entry = serverId ? sameId.find((e) => e.serverId === serverId) : sameId[0];
    if (!entry || sameId.length > 1) return undefined;
    const d = entry.descriptor;
    const label = d.label ?? '';
    const meta = d.metadata as { channelType?: string; recipientName?: string } | undefined;
    const isDm = meta?.channelType === 'dm' || label.toLowerCase().startsWith('dm: ') || d.id.includes(':dm:');
    const dmName = meta?.recipientName ?? (label.toLowerCase().startsWith('dm: ') ? label.slice(4) : undefined);
    const bare = label.replace(/^#/, '');
    const candidates = [
      ...(isDm && dmName ? [`@${dmName}`] : []),
      ...(bare ? [`#${bare}`, `#${bare.replace(/\s*\([^)]*\)\s*$/, '')}`] : []),
      d.id,
    ];
    for (const c of candidates) {
      if (/\s/.test(c) || c === '#') continue;
      const r = this.resolveProseTarget(c, { forSpeech: true });
      if ('channelId' in r && r.channelId === d.id) return c;
    }
    return undefined;
  }

  /**
   * Open a channel because something was DELIVERED into it (explicit send
   * tool or routed speech). Sending into a closed channel is not a thing:
   * engaging a channel opens it, so typing indicators, reaction machinery,
   * and inbound forwarding all come alive with the first outbound message.
   * Accepts composite MCPL ids or raw server-internal ids (explicit send
   * tools receive whatever the agent typed). An `open-failed` answer says
   * whether the open that failed was one that would have opened a channel
   * not selected open (`opening`), as opposed to one reconfirming the
   * transport of a channel already selected open or tuned out. It isn't one
   * either where a decision made during its round-trip replaced it
   * (`overtaken`), or where queued lifecycle work left the
   * channel closed before any open was sent. `selectedForOpening` says the
   * channel is selected for opening after the failure, and why: the put-back
   * couldn't be recorded (`put-back-unrecorded`), or the server's latest
   * announcement or the policy lifted the default it restored
   * (`selected-again`).
   */
  async openIfClosedForSend(
    rawChannelId: string,
    serverId?: string,
  ): Promise<{
    status: 'opened' | 'already-open' | 'unknown-channel' | 'ambiguous' | 'open-failed';
    channelId?: string;
    label?: string;
    opening?: boolean;
    selectedForOpening?: SelectedForOpening;
  }> {
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
    if (matches.length === 0) return { status: 'unknown-channel' };
    if (matches.length > 1) return { status: 'ambiguous' };
    let entry = matches[0]!;
    let opening = false;
    try {
      if (this.hasPendingLifecycle(entry)) {
        entry = await this.waitForOpenChannel(entry);
      }
      const desired = this.getDesiredState(entry.serverId, entry.descriptor.id);
      if (entry.open && (desired === 'open' || desired === 'tuned-out')) {
        return { status: 'already-open', channelId: entry.descriptor.id, label: entry.descriptor.label };
      }
      opening = desired !== 'open' && desired !== 'tuned-out';
      const { opened } = await this.openChannelNow(entry, 'opened-by-reply');
      entry = await this.waitForOpenChannel(entry);
      if (opened) {
        this.emitTraceFn({
          type: 'mcpl:channel-opened-by-send',
          serverId: entry.serverId,
          channelId: entry.descriptor.id,
        });
      }
      return { status: opened ? 'opened' : 'already-open', channelId: entry.descriptor.id, label: entry.descriptor.label };
    } catch (err) {
      // Where a decision made during the open's round-trip replaced it, such
      // as the agent's own close or channel_open, the channel is as that
      // decision left it, and the agent isn't told the open failed.
      if (err instanceof ChannelLifecycleError && err.kind === 'overtaken') opening = false;
      this.emitTraceFn({
        type: 'mcpl:channel-open-failed',
        serverId: entry.serverId,
        channelId: entry.descriptor.id,
        error: (err as Error).message,
      });
      const current = this.channels.get(`${entry.serverId}:${entry.descriptor.id}`);
      return { status: 'open-failed', channelId: entry.descriptor.id, opening,
        // Where the channel is selected for opening after the failure, the
        // agent is told so and why, as speech's failure says.
        ...(err instanceof ChannelLifecycleError && err.kind === 'put-back-unrecorded' ? { selectedForOpening: 'unrecorded' as const } : {}),
        ...(err instanceof ChannelLifecycleError && err.kind === 'selected-again' ? { selectedForOpening: err.by } : {}),
        ...(current ? { label: current.descriptor.label } : {}) };
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

    // A tuned-out channel is transport-open but attention-diverted; a plain
    // open would silently discard the epoch (and its pending backlog dump).
    // Cancelling is the tune-out coordinator's flow, reached via its own
    // tool — refuse with the pointer rather than eat the state. As an error
    // result, the agent reads the pointer itself; `data` names the refusal
    // for an in-process caller.
    if (this.getDesiredState(entry.serverId, input.channelId) === 'tuned-out') {
      return {
        success: false,
        isError: true,
        error:
          `Channel "${input.channelId}" is tuned out: its messages go to the subconscious, and channel_open doesn't change ` +
          `that. Call tune_out with channelId "${input.channelId}" and mode "cancel" for it to resume normal attention; ` +
          'cancelling delivers the diverted backlog.',
        data: { refusal: 'tuned-out', channelId: input.channelId },
      };
    }

    const alreadyDesiredOpen = this.getDesiredState(entry.serverId, input.channelId) === 'open';
    if (entry.open && alreadyDesiredOpen && !input.backscroll && !this.hasPendingLifecycle(entry)) {
      // Open already, perhaps because speech, a reply, the server or a
      // policy opened it: the agent's open is still its decision, and is
      // recorded as one (setDesiredState), so the explicit-open guard of
      // handleToolClose reads it.
      try {
        this.setDesiredState(entry.serverId, input.channelId, 'open', 'agent-tool');
      } catch (err) {
        return {
          success: false,
          error: `Channel ${input.channelId} is already open, but recording your decision to open it failed: ${(err as Error).message}`,
          isError: true,
        };
      }
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
      const { result } = await this.openChannelNow(entry, 'agent-tool', history);
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
      // The decision was recorded before the round-trip and outlives its
      // failure. The text says so where it stands: otherwise a later
      // delivery that opens the channel would be the resident's first sign
      // that it was still wanted open.
      return {
        success: false,
        error: this.lifecycleFailureText('open', entry, err, { history: !!input.backscroll }),
        isError: true,
      };
    }
  }

  private async handleToolClose(
    input: {
      channelId: string;
      serverId?: string;
      /** Machine callers name their decision source ('subscription-gc',
       *  'housekeeping') so the durable record carries honest provenance.
       *  Honored ONLY for module-origin dispatch — tool input is untrusted,
       *  so a model-origin call carrying this field is still recorded as
       *  'agent-tool' (the resident may close their own channel; they may
       *  not attribute the act to housekeeping). */
      source?: string;
      /** A machine close aimed at an explicitly-opened channel is refused
       *  unless the caller certifies an explicit idle lease (a configured
       *  per-channel budget is consent to close at that budget). Module
       *  origin only, like `source`. */
      overrideExplicitOpen?: boolean;
    },
    origin?: ChannelToolOrigin,
  ): Promise<ToolResult> {
    const resolved = this.resolveToolChannelEntry(input.channelId, input.serverId);
    const entry = resolved.entry;
    if (!entry) {
      return {
        success: false,
        error: resolved.error,
        isError: true,
      };
    }

    // Provenance comes from trusted dispatch, not from self-description:
    // only module-origin calls may record a machine source, and only from
    // the closed vocabulary. Agent-origin (or origin-less — the safe
    // default for any legacy caller) records 'agent-tool' and has its
    // machine fields ignored entirely.
    const isModuleOrigin = origin?.kind === 'module';
    let closeSource = 'agent-tool';
    if (isModuleOrigin && input.source !== undefined) {
      if (!MACHINE_CLOSE_SOURCES.has(input.source)) {
        return {
          success: false,
          isError: true,
          error:
            `Unknown machine close source '${input.source}'. Machine closes must use one of: ` +
            `${[...MACHINE_CLOSE_SOURCES].join(', ')}.`,
        };
      }
      closeSource = input.source;
    }

    const alreadyDesiredClosed = this.getDesiredState(entry.serverId, input.channelId) === 'closed';
    if (!entry.open && alreadyDesiredClosed && !this.hasPendingLifecycle(entry) &&
        !this.unconfirmedChannelTargets.has(entry)) {
      // Closed already, perhaps only by default: the agent's close is still
      // its decision, and is recorded as one (setDesiredState), so a later
      // registration's lift of a default leaves the channel closed.
      try {
        this.setDesiredState(entry.serverId, input.channelId, 'closed', closeSource);
      } catch (err) {
        return {
          success: false,
          error: `Channel ${input.channelId} is already closed, but recording the decision to close it failed: ${(err as Error).message}`,
          isError: true,
        };
      }
      return {
        success: true,
        data: { channelId: input.channelId, status: 'already closed' },
      };
    }

    // Housekeeping must not override stated intent (issue #5: GC closes wore
    // the agent's badge and reset explicitly-opened doors). A machine-sourced
    // close of a channel whose current desired state is an agent/operator
    // 'open' is refused — structurally, so the caller can stand down rather
    // than retry — unless it certifies an explicit idle lease.
    if (isModuleOrigin && closeSource !== 'agent-tool' && !input.overrideExplicitOpen) {
      const current = this.desiredStates.get(this.lifecycleKey(entry.serverId, input.channelId));
      // Tuned-out is stated intent too: a GC/housekeeping close would
      // silently end the epoch and orphan its backlog.
      if ((current?.state === 'open' || current?.state === 'tuned-out') && current.source === 'agent-tool') {
        return {
          success: false,
          isError: false,
          error:
            `Channel ${input.channelId} was explicitly opened (source: agent-tool); ` +
            `a '${closeSource}' close does not override stated intent. Machine closes ` +
            `of explicit opens require an explicit idle lease (overrideExplicitOpen).`,
          data: { refusal: 'explicit-open', channelId: input.channelId },
        };
      }
    }

    // A decision the log refused changed nothing, and the answer says so.
    try {
      this.setDesiredState(entry.serverId, input.channelId, 'closed', closeSource);
    } catch (err) {
      return { success: false, error: this.lifecycleFailureText('close', entry, unrecordedDecision(err)), isError: true };
    }
    this.stopTyping(input.channelId);

    // Refused now, the close stays recorded for the server's next
    // registration, and the text says so.
    if (!this.directsLifecycle(entry.serverId)) {
      return { success: false, error: this.lifecycleFailureText('close', entry, this.lifecycleRefusal(entry.serverId)), isError: true };
    }

    try {
      const applied = await this.applyDesiredChannelState(entry.serverId, input.channelId);
      const now = this.getDesiredState(entry.serverId, input.channelId);
      if (applied.open || now !== 'closed') throw new ChannelLifecycleError(supersededClause('close', now), 'superseded');
      return {
        success: true,
        data: { channelId: input.channelId, status: 'closed' },
      };
    } catch (err) {
      return { success: false, error: this.lifecycleFailureText('close', entry, err), isError: true };
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
      // channel_close is the call that closes it: its own answer says when,
      // as for a server that isn't up. A server that's up without that grant
      // keeps its channels as it chooses, so the text says so, and whom to
      // ask.
      const refusal = this.serverReach(entry.serverId) === 'up' && !this.directsLifecycle(entry.serverId)
        ? this.lifecycleRefusal(entry.serverId) : undefined;
      return {
        success: false,
        error: `Channel "${input.channelId}" is open, or set to open, so there's nothing to decline` +
          (refusal ? `, and ${refusal.message}; if you need it closed, ask whoever runs this host.`
            : '. If you need it closed, call channel_close.'),
        isError: true,
      };
    }

    // The lifecycle decision is authoritative even if the optional public
    // acknowledgment cannot be rendered by the surface. One the log refused
    // changed nothing, and nothing after it runs.
    try {
      this.setDesiredState(entry.serverId, input.channelId, 'closed', 'invitation-declined');
    } catch (err) {
      return {
        success: false,
        error: `Nothing changed for channel "${input.channelId}": ${unrecordedDecision(err).message}, so no acknowledgment ` +
          'was posted and nothing was sent to the server. Calling channel_decline again tries again; if it fails the same ' +
          'way, ask whoever runs this host.',
        isError: true,
      };
    }

    let acknowledged = false;
    let representation: string | undefined;
    // What became of an acknowledgment that wasn't posted, worded once the
    // decline's own outcome is known: each says the decline is recorded,
    // since it is whatever becomes of the acknowledgment, and a repeated
    // decline records it again and posts, but only where another decline
    // would be taken (`retry`).
    let ackFailure: ((retry: string | undefined) => string) | undefined;
    if (input.acknowledge) {
      const server = this.serverRegistry.getServer(entry.serverId);
      if (server && CapabilityGrant.of(server).has('channels.acknowledge')) {
        try {
          const result: unknown = await server.sendChannelsAcknowledge({
            channelId: input.channelId,
            messageId: input.messageId,
            intent: 'seen-not-opening',
            value: input.acknowledge,
          });
          // An answer counts by #163's rule, as a publish's does: only
          // acknowledged: true confirms a post, and only false denies one.
          const receipt = (result ?? {}) as { acknowledged?: unknown; representation?: unknown; reason?: unknown };
          if (receipt.acknowledged === true) {
            acknowledged = true;
            if (typeof receipt.representation === 'string') representation = receipt.representation;
          } else if (receipt.acknowledged === false) {
            // A reason that isn't a non-empty string is none.
            const reason = typeof receipt.reason === 'string' && receipt.reason !== '' ? connectorText(receipt.reason) : undefined;
            ackFailure = (retry) => reason !== undefined
              ? withStop(`The decline is recorded, but the "${entry.serverId}" server didn't post the acknowledgment: ${reason}`)
              : `The decline is recorded, but the "${entry.serverId}" server didn't post the acknowledgment, and gave no reason.` +
                (retry ? ` To try once more, ${retry}.` : '');
          } else {
            ackFailure = (retry) => `The decline is recorded, but the "${entry.serverId}" server's answer didn't say whether it ` +
              'posted the acknowledgment.' + (retry ? ' Calling channel_decline again with acknowledge could post it twice.' : '');
          }
        } catch (error) {
          // Only a request that never left the host proves nothing was
          // posted, as for a publish (publishErrorOutcome).
          const words = requestErrorText(error);
          ackFailure = error instanceof McplRequestError && error.outcome === 'not-sent'
            ? (retry) => withStop(`The decline is recorded, but the acknowledgment wasn't posted: ${words}`) +
              (retry ? ` To try again, ${retry}.` : '')
            : (retry) => withStop(`The decline is recorded, but whether the acknowledgment was posted isn't known: ${words}`) +
              (retry ? ' Calling channel_decline again with acknowledge could post it twice.' : '');
        }
      } else {
        const reach = this.serverReach(entry.serverId);
        // Read when the acknowledgment was attempted. Where the server is up,
        // the decline's close can await past a change to its grant, so that
        // text says what kept the acknowledgment back then.
        ackFailure = (retry) => reach === 'up'
          ? `The decline is recorded, but this host wasn't permitted to post acknowledgments to the "${entry.serverId}" server, ` +
            'so none was posted. If you need it, ask whoever runs this host.'
          : `The decline is recorded, but the acknowledgment wasn't posted: ${unreachableClause(entry.serverId, reach)}.` +
            (reach === 'gone' ? ' If you need it, ask whoever runs this host.'
              : retry ? ` To post it, ${retry} ${reach === 'connecting' ? 'in a moment' : "once it's back"}.` : '');
      }
    }

    // Where the host directs the lifecycle, a decline goes through the
    // lifecycle queue like any closed decision, unless a receipt confirmed
    // the transport closed with nothing pending: an unconfirmed transport may
    // be open, and pending work must settle on this decision. A failed close
    // is reported; the decision stands.
    let closeError: string | undefined;
    const current = this.channels.get(`${entry.serverId}:${input.channelId}`);
    if (current && this.directsLifecycle(entry.serverId) &&
        (this.unconfirmedChannelTargets.has(current) || this.hasPendingLifecycle(current))) {
      try {
        await this.applyDesiredChannelState(entry.serverId, input.channelId);
      } catch (error) {
        // Reconciling closes it when the server next registers the channel
        // (for a push's placeholder, if it ever does), if this host directs
        // their lifecycle then (§14.1). A registration that went while the
        // close was out says so, since the server may have closed it first,
        // and one that came back since says that.
        const went = error instanceof ChannelLifecycleError && (error.kind === 'cancelled' || error.kind === 'unlisted');
        closeError = withStop(
          `The decline is recorded, and this host closes the channel ${laterClause(entry)}; ` +
          (!went ? `closing it now didn't complete: ${lifecycleClause(error)}`
            : this.channels.has(`${entry.serverId}:${input.channelId}`)
              ? 'its registration went and came back while the close was out'
              : `it isn't registered here any more: ${(error as ChannelLifecycleError).message}`),
        );
      }
    }
    // A decision made while the decline ran, to open the channel or tune it
    // out, replaced it, and that is what stands.
    const decided = this.getDesiredState(entry.serverId, input.channelId);
    const stands = decided === 'closed';
    if (!stands) {
      closeError = decided === 'tuned-out'
        ? 'The decline is recorded, but the channel was tuned out meanwhile, and that decision stands: its messages go to ' +
          'the subconscious.'
        : 'The decline is recorded, but a later decision to open the channel replaced it, and that decision stands.';
    }
    // Another decline is taken only where this one was: the channel
    // registered, not open, and not decided open.
    const after = this.channels.get(`${entry.serverId}:${input.channelId}`);
    const again = stands && after !== undefined && !after.open;
    const acknowledgmentError = ackFailure?.(again ? 'call channel_decline again with the same arguments' : undefined);

    // An audit record nothing reads back: the decline took effect above, so
    // a log that refuses it is the operator's to hear about, not a failure
    // of the decline.
    try {
      this.appendLifecycleEvent({
        kind: 'invitation-declined',
        serverId: entry.serverId,
        channelId: input.channelId,
        messageId: input.messageId,
        acknowledgment: representation ?? input.acknowledge,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `[channel-decline] server=${entry.serverId} channel=${logValue(input.channelId)}: the declined invitation wasn't ` +
        `recorded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      success: true,
      data: {
        channelId: input.channelId,
        status: 'remained closed',
        acknowledged,
        ...(representation ? { representation } : {}),
        ...(acknowledgmentError ? { acknowledgmentError } : {}),
        ...(closeError ? { closeError } : {}),
      },
    };
  }

  /**
   * Handle the synthesized `think` tool — a private reasoning scratchpad. It
   * sends nothing, and (unlike before) does NOT silence the turn: trailing
   * plain text is still routed as the reply. The thought stays in the agent's
   * own context/chronicle. To deliberately not reply, an agent that may call
   * skip_reply uses it.
   */
  private handleToolThink(input: { content?: string }): ToolResult {
    return {
      success: true,
      // Same echo-avoidance as skip_reply: the thought text is already in the
      // tool_use block; don't duplicate it in the result.
      data: {
        noted: true,
        // No tool to end the turn with: this handler can't see whether the
        // caller may call skip_reply, and think's own description says so
        // where it may.
        note:
          'Thought recorded (private — not sent anywhere). Same-round text routing depends on ' +
          'your current same_round_think_text_policy; use agent_settings get to inspect it.',
      },
    };
  }

  /**
   * Handle the synthesized `journal` tool — a private place for long-form
   * notes. Sends nothing, does not end the turn, does not touch prose routing.
   *
   * Why it exists (sill, 2026-09-19): residents were keeping 2–3KB diaries in
   * `skip_reply.reason`. Long prose in a private-REASONING tool argument
   * (`skip_reply.reason`, `think.content`) makes replayed history read as a
   * reasoning trace, and every memory-compression request over it is refused
   * `reasoning_extraction` regardless of content; the same prose in a
   * note-taking tool passes (canary record: context-manager
   * `tool-prose-hoist.ts`, whose fallback rung rewrites old history into calls
   * to THIS tool — so the result wording below is mirrored there as
   * DEFAULT_TOOL_PROSE_RESULT; keep the two in step).
   */
  private handleToolJournal(_input: { content?: string }): ToolResult {
    return {
      success: true,
      // No echo: the entry is already in the tool_use block.
      data: { recorded: true, note: 'Journal entry recorded (private — not sent anywhere).' },
    };
  }

  /**
   * Handle the synthesized `skip_reply` tool — the deliberate "stay silent"
   * signal. A no-op as far as any surface is concerned (sends nothing); its
   * effect is that the framework's output routing treats this as a silencing
   * tool, so any trailing prose this turn is NOT posted. Replaces the old
   * overloaded use of `think` for staying silent.
   */
  private handleToolSkipReply(input: { reason?: string; wake_in_seconds?: unknown }): ToolResult {
    // The self-wake itself is armed by the framework (which owns the
    // EventGate) BEFORE its dispatch reaches this handler, from the same
    // reading, and the framework refuses a wake the host can't set before
    // dispatching. A caller of this registry's handleChannelToolCall
    // (AgentFramework.channels) goes past both, so its note names a wake
    // nothing armed.
    const wake = readSkipReplyWake(input);
    const selfWake = wake.kind === 'wake' ? wake.seconds : undefined;
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
        note: selfWake !== undefined
          ? `Turn ended; nothing sent. Self-wake in ~${selfWake}s unless something wakes you first.`
          : 'Turn ended; nothing sent.',
      },
    };
  }

  /**
   * MCPL Spec 14.3 outgoing streaming: forward a text delta to the server
   * owning the channel. The framework sends each piece of prose once its
   * publish succeeds, so a stream carries only what was published.
   * Emitted only when that server's grant has `channels.streaming` —
   * servers that never opted in receive nothing. Fire-and-forget and never
   * throws: streaming is an observer surface; the authoritative delivery is
   * channels/publish.
   *
   * `to` is the destination the publish went to, its server and channel.
   * The chunk goes there while that server registers that channel (Spec
   * 14.3: the recipient is "the server that registered the target
   * channel"). A stream doesn't start in a channel its server has declared
   * inbound-only (#350's rule), not even for a publish delivered there just
   * before the declaration. One that started there before it goes on, since
   * the declaration doesn't unregister the channel: a later chunk is for a
   * publish delivered before it. A bare channel id is resolved as before, to
   * the one server that registers it, at each call (streamingServerFor), and
   * keeps no record: a stream sent by destination ends by destination, since
   * only a destination's `complete` removes its record.
   */
  sendOutgoingChunk(
    to: string | PublishDestination,
    conversationId: string,
    inferenceId: string,
    index: number,
    delta: string,
  ): void {
    let server: McplServerConnection | null;
    if (typeof to === 'string') {
      server = this.streamingServerFor(to);
    } else {
      const key = destinationKey(to);
      let started = this.takenStreams.get(inferenceId);
      const continuing = started?.has(key) ?? false;
      server = this.streamingServerAt(to, !continuing);
      if (server && !continuing) {
        if (!started) this.takenStreams.set(inferenceId, started = new Set());
        started.add(key);
      }
    }
    if (!server) return;
    const channelId = typeof to === 'string' ? to : to.channelId;
    try {
      server.sendChannelsOutgoingChunk({ inferenceId, conversationId, channelId, index, delta });
    } catch { /* observer surface — never disturb the turn */ }
  }

  /**
   * Spec 14.3 companion: final moderated content per channel at stream end.
   * Given a destination, it goes only where the stream started
   * (sendOutgoingChunk), while that server still registers that channel,
   * inbound-only or not, and its grant has `channels.streaming`: once per
   * destination, whose consumer, such as a TTS utterance, finalizes on it
   * and reconciles any chunk it missed. A bare channel id is resolved as
   * before (streamingServerFor).
   */
  sendOutgoingComplete(
    to: string | PublishDestination,
    conversationId: string,
    inferenceId: string,
    text: string,
  ): void {
    let server: McplServerConnection | null;
    if (typeof to === 'string') {
      server = this.streamingServerFor(to);
    } else {
      const started = this.takenStreams.get(inferenceId);
      if (!started?.delete(destinationKey(to))) return;
      if (started.size === 0) this.takenStreams.delete(inferenceId);
      server = this.streamingServerAt(to, false);
    }
    if (!server) return;
    try {
      server.sendChannelsOutgoingComplete({
        inferenceId,
        conversationId,
        channelId: typeof to === 'string' ? to : to.channelId,
        content: [{ type: 'text', text }],
      });
    } catch { /* observer surface — never disturb the turn */ }
  }

  private streamingServerFor(channelId: string) {
    // The map is keyed `${serverId}:${channelId}`; stream targets arrive as
    // bare descriptor ids (what resolveProseTarget returns). Scan like the
    // resolver does, and fail closed on cross-server ambiguity — the same
    // never-guess rule that governs delivery.
    const matches = [...this.channels.values()].filter((e) => e.descriptor.id === channelId);
    if (matches.length !== 1) return null;
    // Nothing is published into an inbound-only channel, so nothing is
    // streamed there either.
    if (isInboundOnly(matches[0]!)) return null;
    const server = this.serverRegistry.getServer(matches[0]!.serverId);
    // §5.4: the GRANT gates streaming, not the raw advertisement. The old
    // `capabilities?.channels?.streaming` check was doubly wrong: undefined
    // for the boolean `channels: true` shape (masking discord-mcpl's latent
    // double-post, AUDIT-001), and pre-policy it would have sent before the
    // server was told anything was granted.
    if (!CapabilityGrant.of(server).has('channels.streaming')) return null;
    return server;
  }

  /**
   * A destination's server, for a stream message: while that server
   * registers that channel, and its grant has `channels.streaming` (as in
   * streamingServerFor). A stream doesn't start in an inbound-only channel.
   */
  private streamingServerAt(to: PublishDestination, starting: boolean): McplServerConnection | null {
    // The map's key joins the two ids with a colon, so another server's
    // entry can sit under a destination's key: it has to be this server's.
    const entry = this.channels.get(`${to.serverId}:${to.channelId}`);
    if (!entry || entry.serverId !== to.serverId) return null;
    if (starting && isInboundOnly(entry)) return null;
    const server = this.serverRegistry.getServer(to.serverId);
    return CapabilityGrant.of(server).has('channels.streaming') ? server : null;
  }

  /** Resolve the outbound locus (fork HOME → this-turn's TRIGGERING channel →
   *  process-global default). Public so a multi-segment caller can snapshot it
   *  ONCE and pin every segment to it via routeSpeech's `overrideChannelId`. */
  resolveLocus(conversationId: string): string | null {
    const home = this.homeChannelResolver?.(conversationId);
    return home ?? this.activeChannelResolver?.(conversationId) ?? this.globalFallbackFor(conversationId);
  }

  /** The process-global fallback channel for this conversation, or null when it takes none (takesGlobalFallback). */
  private globalFallbackFor(conversationId: string): string | null {
    return this.takesGlobalFallback?.(conversationId) === false ? null : this.defaultPublishChannel;
  }

  /**
   * Resolve a publish target to exactly one registered channel: `serverId`
   * plus `channelId` when the caller has the server, otherwise a channel id
   * registered by exactly one server. A shared id is refused, never resolved
   * to whichever server registered it first.
   */
  resolveDestination(
    target: { serverId?: string; channelId: string },
  ): { destination: PublishDestination } | { error: string } {
    const entry = this.findExactEntry(target);
    if ('error' in entry) return entry;
    return {
      destination: {
        serverId: entry.entry.serverId,
        channelId: entry.entry.descriptor.id,
        ...(entry.entry.descriptor.label ? { label: entry.entry.descriptor.label } : {}),
      },
    };
  }

  private findExactEntry(
    target: { serverId?: string; channelId: string },
  ): { entry: ChannelEntry } | { error: string } {
    // A supplied selector is checked, never read as omission: an empty or
    // non-string serverId would otherwise widen to "any server".
    if (typeof target.channelId !== 'string' || !target.channelId) {
      return { error: 'the destination names no channel id' };
    }
    if (target.serverId !== undefined && (typeof target.serverId !== 'string' || !target.serverId)) {
      return { error: 'serverId must name a server (omit it to resolve the channel id alone)' };
    }
    const matches = [...this.channels.values()].filter(
      (e) => e.descriptor.id === target.channelId && (!target.serverId || e.serverId === target.serverId),
    );
    if (matches.length === 0) {
      return {
        error: target.serverId
          ? `the "${target.serverId}" server has no channel "${target.channelId}" registered here`
          : `no channel "${target.channelId}" is registered here`,
      };
    }
    if (matches.length > 1) {
      return {
        // Speech names no server, and neither its >> prefix nor
        // channel_publish can: whoever runs this host can. A caller that
        // can name one reads that none was.
        error: `channel id "${target.channelId}" is on more than one server, and no server was named for these words; ` +
          'if you need them there, ask whoever runs this host',
      };
    }
    return { entry: matches[0]! };
  }

  /**
   * Publish `text` to one registered channel and report what the attempt
   * established (PublishOutcome). The delivery executor behind plain speech
   * (deliverSpeech / routeSpeech) and resident resends of held drafts.
   * channel_publish (and publishForAgent, which shares its handler) resolves
   * and sends on its own path, and reads its answer through the same
   * publishReceiptOutcome and publishErrorOutcome.
   *
   * Resolution is exact (resolveDestination): `serverId` plus `channelId`
   * when the caller has the server, otherwise the channel id must be
   * registered by exactly one server (a shared id is refused, never routed
   * through whichever server came first). An omitted `serverId` means "not
   * in use"; a supplied one must be a non-empty server id, and an empty or
   * non-string selector is refused rather than read as omission. It is not
   * possible to send into a closed channel: a closed but registered
   * destination is opened first (`openSource` names why), once its server
   * and that server's channels.publish grant are known to take the send, so
   * a send refused before the open opens nothing; and a failed open sends
   * nothing.
   *
   * A channel its server declared inbound-only (isInboundOnly) takes nothing
   * the host would post, whichever path the words took, a drafts resend
   * included: it's refused before anything opens. The channel's queued
   * lifecycle work and the open await the server, and a channels/changed
   * update, a re-register or the open's own answer (applyOpenDeclaration)
   * may declare the channel inbound-only meanwhile, or a removal take it
   * away. So the check just before the publish, after every await, reads
   * the channel's registration as it is then, and refuses one that is gone
   * or inbound-only, or whose server's grant no longer has channels.publish.
   * A removal during a wait already fails it there (waitForOpenChannel); the
   * check also catches one made after the last wait, as the opening's notice
   * can. A registration nothing has confirmed open, such as one that
   * replaced the one waited for or a retarget of it, or one whose close now
   * stands (where the host directs the server's lifecycle), is treated as at
   * the first wait: the words wait for its queued lifecycle work, and the
   * check runs again on the registration that work leaves. Words refused
   * after an open for a declaration leave the channel open, and the agent
   * gets the failure for the words. An open by delivery (`openSource`
   * 'opened-by-delivery', the default) that turned a closed channel open
   * also gives the notice that it's open, which says how to close it.
   * One that only reconfirmed the transport of a channel already decided
   * open or tuned out changes no decision, and gives none. When the
   * registration is gone, the failure says the channel was removed.
   *
   * Only the connector's `delivered: true` confirms a post. `failed` means
   * nothing was posted: the attempt stopped before the request was written,
   * or the connector answered `delivered: false` and named no message (no
   * `messageId`, or null). Everything else is `unknown`: once the request
   * has been handed to the transport, an error response, a timeout, a lost
   * connection, or a missing, malformed or contradictory receipt (such as
   * `delivered: false` beside a message id, valid or not) means the post may
   * or may not exist, and the caller must not treat it as safe to retry
   * blindly.
   */
  async publish(
    conversationId: string,
    text: string,
    target: {
      serverId?: string;
      channelId: string;
      /** Set by speech routing (deliverSpeech): opening a closed channel
       *  for this publish is logged under `[routeSpeech]`, with speech
       *  routing's other lines. */
      routed?: boolean;
    },
    openSource: 'opened-by-delivery' | 'opened-by-reply' = 'opened-by-delivery',
  ): Promise<PublishOutcome> {
    const at = (): number => Date.now();
    const found = this.findExactEntry(target);
    if ('error' in found) return { status: 'failed', reason: found.error, at: at() };
    let entry = found.entry;
    const destination: PublishDestination = {
      serverId: entry.serverId,
      channelId: entry.descriptor.id,
      ...(entry.descriptor.label ? { label: entry.descriptor.label } : {}),
    };

    // A send that would be refused is refused before anything opens: a
    // closed channel opens only for words that can go out.
    if (isInboundOnly(entry)) {
      return { status: 'failed', destination, reason: inboundOnlyReason(entry), at: at() };
    }
    const server = this.serverRegistry.getServer(entry.serverId);
    // §14.1: channels/publish requires channels.publish in the grant. The
    // host not sending is the enforcement, here and at the last check, and
    // the server's state words the refusal (sendRefusal).
    const ungranted = (): PublishOutcome => ({ status: 'failed', destination, reason: this.sendRefusal(entry.serverId), at: at() });
    if (!server || !CapabilityGrant.of(server).has('channels.publish')) return ungranted();

    const prevented = (err: unknown): PublishOutcome => ({
      status: 'failed', destination, reason: lifecycleClause(err) + refusalRemedy(err), at: at(),
    });

    // Lifecycle work already queued for the channel settles first: words go
    // out only into the channel it leaves, and fail visibly if it leaves
    // none open.
    if (this.hasPendingLifecycle(entry)) {
      try {
        entry = await this.waitForOpenChannel(entry);
      } catch (err) {
        return prevented(err);
      }
    }

    // INVARIANT: it is not possible to send into a closed channel. A send
    // into a closed-but-registered channel (the canonical case: a DM that
    // woke the agent, since DMs register closed) OPENS it first, so typing
    // indicators, reaction machinery and inbound forwarding come alive with
    // the words. If the open fails, nothing goes out: a half-alive delivery
    // is worse than a loud marker. A channel decided closed is engaged even
    // while its transport is still open (a close that failed), as a reply
    // would engage it, wherever an open can succeed. Without the lifecycle
    // grant it can't, and a send opens before it publishes, so there a
    // channel whose transport is open keeps publishing.
    const engagesDecidedClosed = this.getDesiredState(entry.serverId, entry.descriptor.id) === 'closed' &&
      CapabilityGrant.of(server).has('channels.lifecycle');
    if (!entry.open || engagesDecidedClosed) {
      try {
        const { opened } = await this.openChannelNow(entry, openSource);
        entry = await this.waitForOpenChannel(entry);
        if (opened) {
          if (target.routed) {
            console.error(
              `[routeSpeech] ${conversationId}: locus ${logValue(entry.descriptor.id)} was closed — opened by delivery (speech implies engagement)`,
            );
          }
          this.emitTraceFn({
            type: 'mcpl:channel-opened-by-send',
            serverId: entry.serverId,
            channelId: entry.descriptor.id,
          });
          if (openSource === 'opened-by-delivery') {
            try {
              this.onChannelAutoOpened?.({
                conversationId,
                serverId: entry.serverId,
                source: 'opened-by-delivery',
                channels: [{ channelId: entry.descriptor.id, label: entry.descriptor.label }],
              });
            } catch (err) {
              console.error('onChannelAutoOpened (delivery) failed:', err);
            }
          }
        }
      } catch (err) {
        return { status: 'failed', destination, reason: openFailedReason(err), at: at() };
      }
    }

    // Checked again here, after every await above, the lifecycle work's, the
    // open's or any other: a registration that is gone, or inbound-only, at
    // this moment takes nothing. The entry is read from the map rather than
    // taken from the last wait: the opening's notice runs in between, and
    // publish() resumes a microtask after the wait. A registration nothing
    // has confirmed open, such as one that replaced the one waited for
    // (registered with open: false) or a retarget of it (marked unconfirmed),
    // or one whose close now stands (closeStands), is treated as at the
    // first wait: the words wait for its queued lifecycle work, and
    // waitForOpenChannel refuses what that work leaves unconfirmed or with
    // its close standing. The loop opens nothing itself. The check then runs
    // again on the registration that stands. waitForOpenChannel returns
    // only a registration it found open and whose close doesn't stand, or
    // throws, so the loop ends unless the channel keeps changing.
    const key = `${entry.serverId}:${entry.descriptor.id}`;
    let current = this.channels.get(key);
    while (current && !isInboundOnly(current) && (!current.open || this.closeStands(current))) {
      try {
        entry = await this.waitForOpenChannel(current);
      } catch (err) {
        return prevented(err);
      }
      current = this.channels.get(key);
    }
    if (!current) return { status: 'failed', destination, reason: CHANNEL_REMOVED_CLAUSE, at: at() };
    if (isInboundOnly(current)) {
      return { status: 'failed', destination, reason: inboundOnlyReason(current), at: at() };
    }
    // A grant reduced during any of the waits holds at once (§6.7): the
    // words already on their way take it too. Its refusal is worded for the
    // connection that refused (sendRefusal's `checked`).
    if (!CapabilityGrant.of(server).has('channels.publish')) {
      return { status: 'failed', destination, reason: this.sendRefusal(entry.serverId, server), at: at() };
    }

    let result: unknown;
    try {
      result = await server.sendChannelsPublish({
        conversationId,
        channelId: entry.descriptor.id,
        content: [{ type: 'text', text }],
      });
    } catch (err) {
      return publishErrorOutcome(err, destination, at());
    }
    return publishReceiptOutcome(result, destination, at());
  }

  /**
   * Plain speech for one turn segment: publish `text` to the turn's frozen
   * locus and report the PublishOutcome. A failure (or an uncertain outcome)
   * is surfaced as a trace and through onRouteFailure, so the agent learns
   * its words did not (or may not have) reached anyone. A `failed` one whose
   * caller holds its words with a notice of its own (`heldOnFailure`) gets
   * the trace but not onRouteFailure. An ephemeral run's speech with no locus
   * (null) is its caller's result: it returns as not delivered and surfaces
   * nothing. This is host-owned output routing (see forking-knowledge-miner
   * LOCUS-ROUTING-DESIGN), which replaced the per-surface sticky auto-post
   * that used to live in discord-mcpl.
   */
  async deliverSpeech(
    conversationId: string,
    text: string,
    /** The turn's FROZEN locus, snapshotted once by the caller (resolveLocus
     *  at turn start) and passed to every segment of the turn. Mandatory:
     *  there is deliberately no live-resolution fallback here — a late
     *  dispatch resolving live can read the NEXT turn's trigger state or a
     *  stale global default and land the reply in the wrong channel (item-3,
     *  PR #32, and the 2026-07-22 Sol DM misroute). Explicit `null` means
     *  "this turn is pinned to no locus": fail loudly rather than guess,
     *  except for an ephemeral run, whose speech is then its caller's
     *  result. */
    locusChannelId: string | null,
    /** `heldOnFailure`: the caller holds a `failed` delivery's words as a
     *  draft with its own notice, so no failure marker is written for it.
     *  An `unknown` outcome still gets its marker. */
    opts?: { heldOnFailure?: boolean },
  ): Promise<PublishOutcome> {
    // `logged` is what the log line and the trace say, where it isn't the
    // agent's reason (the two no-locus reasons below).
    const fail = (channelId: string | null, reason: string, outcome: PublishOutcome, logged = reason): PublishOutcome => {
      const status = outcome.status === 'unknown' ? 'unknown' : 'failed';
      const detail = outcome.detail !== undefined ? connectorText(outcome.detail) : undefined;
      const detailText = detail !== undefined ? `; connector detail: ${detail}` : '';
      console.error(`[routeSpeech] ${conversationId}: ${logged}${detailText} — speech ${status === 'unknown' ? 'delivery NOT confirmed' : 'NOT routed'} (${text.length} chars stay in chronicle)`);
      this.emitTraceFn({
        type: 'mcpl:speech-route-failed',
        conversationId,
        channelId: channelId ?? '',
        reason: logged,
        textLen: text.length,
        outcome: status,
        ...(detail !== undefined ? { detail } : {}),
      });
      if (status === 'unknown' || !opts?.heldOnFailure) {
        this.onRouteFailure?.({ conversationId, channelId, reason, textLen: text.length, outcome: status, ...(detail !== undefined ? { detail } : {}) });
      }
      return outcome;
    };

    // These two reasons are the only ones whose log line and trace keep the
    // operator's words rather than the agent's: connectome-host's
    // connectome-doctor reads the last [routeSpeech] line for "no locus". Keep
    // "no locus" in both logged texts. Each names no tool: whether one the
    // agent may call could post the words isn't known here, and the notice
    // calls it a routing or configuration situation.
    // Runtime backstop for JS callers the compiler can't see: an omitted
    // locus is a routing bug at the call site, never something to paper over
    // with a live re-resolution.
    if (locusChannelId === undefined) {
      const reason = 'the host lost track of which channel this reply was for; if this keeps happening, ask whoever runs this host';
      return fail(null, reason, { status: 'failed', reason, at: Date.now() },
        'caller passed no locus (routing bug: every speech path must snapshot the turn locus)');
    }
    if (!locusChannelId) {
      // An ephemeral run with no channel of its own: its plain speech is its
      // caller's result (takesGlobalFallback). It returns as not delivered,
      // with its own reason, and writes no line, trace or notice.
      if (this.takesGlobalFallback?.(conversationId) === false) {
        return { status: 'failed', reason: "an ephemeral run's plain speech with no channel of its own is its caller's result", at: Date.now() };
      }
      // The turn froze with no locus (no home, no triggering channel, no
      // global inbound ever seen) — the agent was told its prose stays in
      // the archive; honor that.
      // The locus froze at the turn's start, so this says what the turn had.
      const reason = 'this turn came from no channel, and it had no home or recent channel to reply in; if it should have ' +
        'had one, ask whoever runs this host';
      return fail(null, reason, { status: 'failed', reason, at: Date.now() },
        'turn has no locus (no home/trigger channel; nothing to deliver into)');
    }

    const outcome = await this.publish(conversationId, text, { channelId: locusChannelId, routed: true });
    const channelId = outcome.destination?.channelId ?? locusChannelId;
    if (outcome.status !== 'delivered') {
      return fail(channelId, outcome.reason ?? 'delivery not confirmed', outcome);
    }

    console.error(`[routeSpeech] ${conversationId}: routed ${text.length} chars -> ${logValue(channelId)} (server=${outcome.destination!.serverId}, delivered=true)`);
    this.emitTraceFn({
      type: 'mcpl:speech-routed',
      conversationId,
      serverId: outcome.destination!.serverId,
      channelId,
      delivered: true,
      textLen: text.length,
      text,
      // Surface the posted message's id (ChannelsPublishResult.messageId) so
      // trace consumers can act on the just-posted message — e.g. a TTS-relay
      // tap editing it down to the words actually voiced on interruption.
      ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}),
    });
    return outcome;
  }

  /** deliverSpeech, reduced to the confirmed delivery (null when there was none). */
  async routeSpeech(
    conversationId: string,
    text: string,
    locusChannelId: string | null,
  ): Promise<{ delivered: boolean; serverId: string; channelId: string; messageId?: string } | null> {
    const outcome = await this.deliverSpeech(conversationId, text, locusChannelId);
    if (outcome.status !== 'delivered') return null;
    return {
      delivered: true,
      serverId: outcome.destination!.serverId,
      channelId: outcome.destination!.channelId,
      ...(outcome.messageId !== undefined ? { messageId: outcome.messageId } : {}),
    };
  }

  /**
   * channel_publish, and the subconscious's speak_in_channel
   * (publishForAgent), which shares its delivery. Where an agent finds a
   * channel id differs: the subconscious isn't offered channel_list, and is
   * given speak_in_channel for the tuned-out channels whose messages it reads.
   */
  private async handleToolPublish(
    input: { channelId?: string; content?: string; text?: string },
    origin?: ChannelToolOrigin,
    /** Filled with the publish's outcome once a request is attempted, for
     *  publishForAgent's trace. */
    seen?: { outcome?: PublishOutcome },
    tool: 'channel_publish' | 'speak_in_channel' = 'channel_publish',
  ): Promise<ToolResult> {
    const findIds = tool === 'channel_publish'
      ? 'channel_list shows the channel ids.'
      : 'Use the id of a tuned-out channel whose messages you are reading.';
    // Resolve content: accept both `content` and `text` (backward compat).
    // speak_in_channel checks its own text first, so only channel_publish
    // reads this refusal.
    const messageText = input.content ?? input.text;
    if (!messageText) {
      return { success: false, error: 'Nothing was posted: channel_publish needs the message in `content`.', isError: true };
    }

    // An empty channelId names nothing, and isn't read as one left out.
    // speak_in_channel's caller passes one left out as empty, so there it
    // gets the refusal for one left out, as speak_in_channel has no default.
    if (input.channelId === '' && tool === 'channel_publish') {
      return { success: false, error: `Nothing was posted: channelId is empty. ${findIds}`, isError: true };
    }
    // Resolve channelId: default to the channel of the most recent incoming
    // message that isn't a reaction, reaction removal, edit or deletion
    // marker, apart from an edit the coalescer delivers on acceptance as the
    // agent's first view. An ephemeral run never takes that default
    // (takesGlobalFallback), so it names one.
    const caller = origin?.kind === 'agent' ? origin.agentName : undefined;
    const channelId = input.channelId ?? (caller !== undefined ? this.globalFallbackFor(caller) : this.defaultPublishChannel);
    if (!channelId) {
      return {
        success: false,
        error: tool === 'speak_in_channel'
          ? `Nothing was posted: speak_in_channel needs a \`channelId\`. ${findIds}`
          : caller !== undefined && this.takesGlobalFallback?.(caller) === false
            ? 'Nothing was posted: name the channel with channelId. A subagent has no default channel, since its plain '
              + 'speech is returned to whoever called it, so channel_publish sends only to a channel it names.'
            : `Nothing was posted: channel_publish needs a \`channelId\`, and there's no channel to default to yet. ${findIds}`,
        isError: true,
      };
    }

    const entry = this.findChannelEntry(channelId);
    if (!entry) {
      return { success: false, error: `No channel has the id "${channelId}", so nothing was posted. ${findIds}`, isError: true };
    }
    if (isInboundOnly(entry)) {
      return {
        success: false,
        error: `Channel ${channelId} is ${inboundOnlyReason(entry)}`,
        isError: true,
      };
    }

    // The same refusal, in the same words, as plain speech's (sendRefusal).
    const server = this.serverRegistry.getServer(entry.serverId);
    if (!server || !CapabilityGrant.of(server).has('channels.publish')) {
      return { success: false, error: `Nothing was posted to channel "${channelId}": ${this.sendRefusal(entry.serverId)}.`, isError: true };
    }
    const publishParams: ChannelsPublishParams = {
      conversationId: '', // Framework will fill this when wired
      channelId,
      content: [{ type: 'text', text: messageText }],
    };
    const destination: PublishDestination = {
      serverId: entry.serverId,
      channelId: entry.descriptor.id,
      ...(entry.descriptor.label ? { label: entry.descriptor.label } : {}),
    };

    // The answer counts by the same rule as plain speech's: only the
    // connector's delivered:true confirms a post.
    let result: unknown;
    let outcome: PublishOutcome;
    try {
      result = await server.sendChannelsPublish(publishParams);
      outcome = publishReceiptOutcome(result, destination, Date.now());
    } catch (err) {
      outcome = publishErrorOutcome(err, destination, Date.now());
    }
    if (seen) seen.outcome = outcome;
    if (outcome.status === 'delivered') return { success: true, data: result };
    // The connector's data may say what a multi-part send already posted.
    const detail = outcome.status === 'unknown' && outcome.detail !== undefined ? ` Connector detail: ${connectorText(outcome.detail)}` : '';
    return {
      success: false,
      error: (outcome.status === 'failed'
        ? `Nothing was posted to channel "${channelId}": ${outcome.reason}.`
        : `Posting to channel "${channelId}" wasn't confirmed: ${outcome.reason}. ` +
          'It may or may not have been posted, so sending it again could post it twice.') + detail,
      isError: true,
    };
  }
}
